// Telegram as a fallback return channel, outbound only.
//
// Voice assistants only poll: while one keeps calling the voice tools, it
// hears everything itself. When no voice tool call has come for a while
// (VOICE_GW_TELEGRAM_AFTER, 600 s by default), the voice mode counts as ended.
// Gaps of a few minutes between calls are normal while the driver talks, so
// the wait is long. From then on, only what needs the driver also goes to their
// Telegram chat, each once: questions the voice client has not received, and
// approval requests it has not announced. Results, news and interim "working"
// updates never go there; they wait for the next voice call. The voice path
// stays as it is.
//
// The other messages to the chat come from elsewhere and go at once, voice
// mode or not: the kill switch alarm, alerts about suspicious requests and
// sign-ins (ipguard.mjs), the Funnel (funnel.mjs) and the watchdog.
//
// Inbound, the gateway takes a few commands from the configured private chat:
// the kill switch (/stop or an emergency phrase), and the Tailscale Funnel on
// and off (/funnel on, /funnel off, /funnel, "keep alive"; see funnel.mjs).
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

// The kill switch.
export const isStopCommand = text =>
  /^\/(stop|killswitch|emergencystop)(@\w+)?$/i.test(String(text).trim()) || emergencyPhrase(text)

// The Funnel: /funnel on|off|status (plain /funnel asks for the status), the
// same without the slash, and "keep alive", which turns it on, or keeps it on
// for another while.
const FUNNEL_WORDS = { 'funnel on': 'on', 'funnel off': 'off', 'funnel status': 'status', 'keep alive': 'on', keepalive: 'on' }

export function funnelCommand(text) {
  const slash = /^\/funnel(?:@\w+)?(?:\s+(on|off|status))?$/i.exec(String(text).trim())
  if (slash) return (slash[1] ?? 'status').toLowerCase()
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z\s-]+/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim()
  return FUNNEL_WORDS[words] ?? null
}

// Waits `ms`, or less if the signal aborts. The timer's abort listener goes
// away with it, so a long run of backoffs leaves none behind.
export const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {})

// Inbound: polls the bot for messages from the configured private chat and
// emits 'stop' for a stop command and 'funnel' for a Funnel command. Every
// other chat, and every other message, is ignored. A command older than
// maxAgeSeconds, sent while the gateway was not listening, does not count:
// Telegram keeps messages for a day, and yesterday's /funnel on must not open
// the endpoint today. It emits 'stale' instead, so that the sender hears why.
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
          this.warnOnce('409', 'telegram commands: a webhook or another program takes this bot\'s updates; /stop and /funnel do not reach the gateway')
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
    const stop = isStopCommand(message.text)
    const funnel = stop ? null : funnelCommand(message.text)
    if (!stop && !funnel) return
    const age = Math.round(Date.now() / 1000 - Number(message.date))
    if (age > this.maxAgeSeconds) {
      this.log(`telegram commands: ignored "${preview(message.text, 40)}", sent ${age} s ago`)
      this.emit('stale', { text: message.text, ageSeconds: age })
      return
    }
    if (stop) this.emit('stop', { text: message.text })
    else this.emit('funnel', { action: funnel, text: message.text })
  }
}

function describeQuestion(request, update) {
  const about = request.worker
    ? `worker ${request.worker.repo}, task ${request.worker.task}`
    : `"${preview(request.text, 60)}"`
  return [
    `Question for request ${request.id} (${about})`,
    '',
    update.text,
    '',
    `Answer in voice mode and mention ${request.id}.`,
  ].join('\n')
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
  constructor(store, { send, afterSeconds = 600, log = defaultLog }) {
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
            : `voice mode ended (no voice call for ${this.afterSeconds} s): telegram fallback on for questions and approvals`,
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

  // What needs the driver and has not reached them by voice: open questions
  // and approval requests. Results, news and interim updates wait for the
  // next voice call.
  flush() {
    let marked = false
    for (const request of this.store.requests.values()) {
      // The kill switch sends its own alarm; the start-up summary is for the controller.
      if (request.origin === 'alarm' || request.origin === 'gateway') continue
      // Done: answered, finished without the driver or ended by a restart. A
      // question in it needs nobody any more.
      if (request.state === 'done') continue
      for (const update of request.updates.slice(request.cursor)) {
        if (update.state !== 'question' || update.telegram) continue
        update.telegram = true
        marked = true
        this.deliver(describeQuestion(request, update))
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
