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

import { readFileSync } from 'node:fs'
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
    this.apiBase = apiBase.replace(/\/+$/, '')
  }

  redact(text) {
    return String(text).split(this.token).join('<token>')
  }

  // Resolves when Telegram accepted the message; otherwise throws an error
  // whose message is safe to log.
  async send(text) {
    let response
    try {
      response = await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, MAX_TEXT) }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
    } catch (error) {
      const cause = error.cause?.message ?? error.cause?.code
      throw new Error(this.redact(cause ? `${error.message} (${cause})` : error.message))
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok !== true) {
      throw new Error(this.redact(`${response.status} ${body.description ?? response.statusText}`))
    }
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
    for (const request of this.store.requests.values()) {
      for (const update of request.updates.slice(request.cursor)) {
        if (update.state === 'working' || update.telegram) continue
        update.telegram = true
        this.deliver(describeUpdate(request, update))
      }
    }
    for (const permission of this.store.openPermissions()) {
      if (permission.announced || permission.telegram) continue
      permission.telegram = true
      this.deliver(describePermission(permission))
    }
  }

  deliver(text) {
    const title = text.split('\n')[0]
    this.queue = this.queue
      .then(() => this.send(text))
      .then(() => this.log('telegram sent:', preview(title, 100)))
      .catch(error => this.log('telegram send failed:', preview(title, 60), '-', error.message))
  }
}
