// Telegram as a fallback return channel, outbound only.
//
// Voice assistants only poll: while one keeps calling the voice tools, it
// hears everything itself. When no voice tool call has come for a while
// (VOICE_GW_TELEGRAM_AFTER, 60 s by default), the voice mode counts as ended.
// From then on, results, questions and approval requests that the voice client
// has not received also go to the driver's Telegram chat, each once. The voice
// path stays as it is; Telegram comes on top. Interim "working" updates stay
// off Telegram.
//
// On only when .secrets/telegram_token and .secrets/telegram_chat_id both
// exist and are not empty. The token is part of every API address, so it must
// never reach a log line or an error message.

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { emergencyPhrase } from './killswitch.mjs'
import { log as defaultLog, preview } from './log.mjs'

const MAX_TEXT = 4000 // Telegram takes up to 4096 characters
const SEND_TIMEOUT_MS = 10000

function readSecret(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

// One call of the Bot API, for the gateway, the setup assistant and
// scripts/telegram-notify.mjs. Resolves with the call's result. Otherwise it
// throws an error with the HTTP status, if there was an answer; its message
// never contains the token, which is part of every API address.
export async function callBotApi({
  apiBase = 'https://api.telegram.org',
  token,
  method,
  body = {},
  timeoutMs = SEND_TIMEOUT_MS,
  signal,
}) {
  const redact = text => (token ? String(text).split(token).join('<token>') : String(text))
  const limit = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetch(`${apiBase.replace(/\/+$/, '')}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    })
  } catch (error) {
    const cause = error.cause?.message ?? error.cause?.code
    throw new Error(redact(cause ? `${error.message} (${cause})` : error.message))
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok !== true) {
    throw Object.assign(new Error(redact(`${response.status} ${data.description ?? response.statusText}`)), {
      status: response.status,
    })
  }
  return data.result
}

// A Telegram client, or null when the two secret files are not both set.
export function loadTelegram({ tokenFile, chatIdFile, apiBase }) {
  const token = readSecret(tokenFile)
  const chatId = readSecret(chatIdFile)
  if (!token || !chatId) return null
  return new Telegram({ token, chatId, apiBase })
}

export class Telegram {
  constructor({ token, chatId, apiBase = 'https://api.telegram.org' }) {
    this.token = token
    this.chatId = chatId
    this.apiBase = apiBase
  }

  call(method, body, options = {}) {
    return callBotApi({ apiBase: this.apiBase, token: this.token, method, body, ...options })
  }

  // Resolves when Telegram accepted the message.
  async send(text) {
    await this.call('sendMessage', { chat_id: this.chatId, text: String(text).slice(0, MAX_TEXT) })
  }

  // Updates for the bot, waiting up to `timeout` seconds for new ones.
  async getUpdates({ offset, timeout = 25, signal } = {}) {
    const result = await this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message'] },
      { timeoutMs: (timeout + 15) * 1000, signal },
    )
    return Array.isArray(result) ? result : []
  }

  // The bot itself ({ id, username, first_name }), which checks the token; for
  // the setup assistant.
  async getMe() {
    return (await this.call('getMe')) ?? {}
  }
}

// The one command the gateway takes from Telegram: the kill switch.
export const isStopCommand = text =>
  /^\/(stop|killswitch|emergencystop)(@\w+)?$/i.test(String(text).trim()) || emergencyPhrase(text)

// Waits `ms`, or less if the signal aborts. The timer's abort listener goes
// away with it, so a long run of backoffs leaves none behind.
export const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {})

// Inbound: polls the bot for messages and emits 'stop' for a stop command
// from the configured private chat. Every other chat, and every other message,
// is ignored. Messages older than maxAgeSeconds, for example from before a
// restart, do not count.
export class TelegramCommands extends EventEmitter {
  constructor(telegram, { pollSeconds = 25, maxAgeSeconds = 120, log = defaultLog } = {}) {
    super()
    this.telegram = telegram
    this.pollSeconds = pollSeconds
    this.maxAgeSeconds = maxAgeSeconds
    this.log = log
    this.offset = undefined
    this.closed = false
    this.abort = new AbortController()
    this.warned = new Set()
  }

  start() {
    this.loop()
    return this
  }

  close() {
    this.closed = true
    this.abort.abort()
  }

  warnOnce(key, text) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.log(text)
  }

  async loop() {
    let backoff = 0
    while (!this.closed) {
      try {
        const updates = await this.telegram.getUpdates({
          offset: this.offset,
          timeout: this.pollSeconds,
          signal: this.abort.signal,
        })
        backoff = 0
        for (const update of updates) {
          this.offset = update.update_id + 1
          this.handle(update)
        }
      } catch (error) {
        if (this.closed) return
        if (error.status === 409) {
          this.warnOnce('409', 'telegram commands: a webhook or another program takes this bot\'s updates; /stop does not reach the gateway')
        } else {
          this.warnOnce(error.message, `telegram commands: ${error.message}`)
        }
        backoff = Math.min(60, backoff ? backoff * 2 : 5)
        await pause(backoff * 1000, this.abort.signal)
      }
    }
  }

  handle(update) {
    const message = update.message
    if (!message || typeof message.text !== 'string') return
    const chat = String(message.chat?.id)
    if (chat !== String(this.telegram.chatId) || message.chat?.type !== 'private') {
      this.warnOnce(`chat ${chat}`, 'telegram commands: ignored a message from another chat')
      return
    }
    if (Date.now() / 1000 - Number(message.date) > this.maxAgeSeconds) return
    if (isStopCommand(message.text)) this.emit('stop', { text: message.text })
  }
}

function describeUpdate(request, update) {
  const question = update.state === 'question'
  const about = request.worker
    ? `worker ${request.worker.repo}, task ${request.worker.task}`
    : `"${preview(request.text, 60)}"`
  const lines = [`${question ? 'Question' : 'Result'} for request ${request.id} (${about})`, '', update.text]
  if (question) lines.push('', `Answer in voice mode and mention ${request.id}.`)
  return lines.join('\n')
}

function describePermission(permission) {
  // Claude Code's descriptions often end with a full stop already.
  const description = String(permission.description).replace(/[\s.]+$/, '')
  const details = preview(permission.inputPreview || '', 300)
  const lines = [`Approval request ${permission.code} (controller session)`, '', `${permission.toolName}: ${description}`]
  if (details) lines.push(`Details: ${details}`)
  lines.push('', 'Answer in voice mode or at the terminal; Telegram cannot approve.')
  return lines.join('\n')
}

export class TelegramFallback {
  constructor(store, { send, afterSeconds = 60, log = defaultLog }) {
    this.store = store
    this.send = send
    this.afterSeconds = afterSeconds
    this.afterMs = afterSeconds * 1000
    this.log = log
    this.voice = false // whether the voice mode was on at the last check
    this.timer = null
    this.queue = Promise.resolve() // keeps messages in order
    this.check = this.check.bind(this)
    store.on('change', this.check)
    store.on('voice', this.check)
    this.check()
  }

  close() {
    clearTimeout(this.timer)
    this.store.off('change', this.check)
    this.store.off('voice', this.check)
  }

  // Runs on every change in the store and when the voice mode may have ended.
  // It must never throw: it runs inside the reply tool and the voice calls.
  check() {
    try {
      clearTimeout(this.timer)
      const active = this.store.voiceActive(this.afterMs)
      if (active !== this.voice) {
        this.voice = active
        this.log(
          active
            ? 'voice mode on: telegram fallback paused'
            : `voice mode ended (no voice call for ${this.afterSeconds} s): telegram fallback on`,
        )
      }
      if (active) {
        if (!this.store.voiceCalls) {
          this.timer = setTimeout(this.check, this.store.voiceSeenAt + this.afterMs - Date.now() + 5)
          this.timer.unref()
        }
        return
      }
      this.flush()
    } catch (error) {
      this.log('telegram fallback failed:', error.message)
    }
  }

  // Everything the voice client has not received yet, except interim updates.
  flush() {
    let marked = false
    for (const request of this.store.requests.values()) {
      if (request.origin === 'alarm') continue // the kill switch sends its own alarm
      for (const update of request.updates.slice(request.cursor)) {
        if (update.state === 'working' || update.telegram) continue
        update.telegram = true
        marked = true
        this.deliver(describeUpdate(request, update))
      }
    }
    for (const permission of this.store.openPermissions()) {
      if (permission.announced || permission.telegram) continue
      permission.telegram = true
      this.deliver(describePermission(permission))
    }
    // The marks go into the saved requests, so a restart sends nothing twice.
    if (marked) this.store.save?.()
  }

  deliver(text) {
    const title = text.split('\n')[0]
    this.queue = this.queue
      .then(() => this.send(text))
      .then(() => this.log('telegram sent:', preview(title, 100)))
      .catch(error => this.log('telegram send failed:', preview(title, 60), '-', error.message))
  }
}
