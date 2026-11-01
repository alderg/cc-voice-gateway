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
// the kill switch (/stop or an emergency phrase), the Tailscale Funnel on
// and off (/funnel on, /funnel off, /funnel, "keep alive"; see funnel.mjs),
// and the statistics (/stats, /stats all; see stats.mjs). And the driver's
// answers to its questions (TelegramAnswers, VOICE_GW_TELEGRAM_ANSWERS): a
// Reply to a question's message, or a message with the question's code, goes
// to the controller as their answer, like one by voice; the controller's
// replies to it come back to the chat.
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

  // Resolves with the message ({ message_id, … }) when Telegram accepted it.
  // replyTo: the id of a message in the chat that this one answers; sent
  // all the same if that message is gone.
  async send(text, { replyTo = null } = {}) {
    const body = { chat_id: this.chatId, text: String(text).slice(0, MAX_TEXT) }
    if (replyTo !== null) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true }
    return this.call('sendMessage', body)
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

// Night mode (night.mjs): 'away' for /night, /goodnight, /away or "good night"
// (and the same in German, French, Italian, Spanish); 'back' for /back,
// /morning, "I'm back" or "good morning". null otherwise.
const AWAY_WORDS = ['good night', 'goodnight', 'gute nacht', 'bonne nuit', 'buona notte', 'buonanotte', 'buenas noches']
const BACK_WORDS = ["i'm back", 'im back', 'i am back', 'good morning', 'guten morgen', 'bin zurück', 'ich bin zurück', 'bonjour', 'buongiorno', 'buenos días']

export function awayCommand(text) {
  const slash = /^\/(night|goodnight|away|back|morning)(?:@\w+)?$/i.exec(String(text).trim())
  if (slash) return ['back', 'morning'].includes(slash[1].toLowerCase()) ? 'back' : 'away'
  const words = String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\s']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (AWAY_WORDS.includes(words)) return 'away'
  if (BACK_WORDS.includes(words)) return 'back'
  return null
}

// The statistics: /stats for this running time, /stats all for all time.
export function statsCommand(text) {
  const match = /^\/stats(?:@\w+)?(?:\s+(all))?$/i.exec(String(text).trim())
  return match ? { all: Boolean(match[1]) } : null
}

// Waits `ms`, or less if the signal aborts. The timer's abort listener goes
// away with it, so a long run of backoffs leaves none behind.
export const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {})

// Inbound: polls the bot for messages from the configured private chat and
// emits 'stop' for a stop command, 'funnel' for a Funnel command, 'away' for
// night mode on or off and 'stats' for the statistics. With answers, also
// 'answer' ({ text, replyTo, messageId }) for a Reply, whatever it says
// unless it is a stop or a slash command, and for any other text that is no
// command: TelegramAnswers decides whether it answers a question. Every
// other chat, and every other message, is ignored. A message older than
// maxAgeSeconds, sent while the gateway was not listening, does not count:
// Telegram keeps messages for a day, and yesterday's /funnel on must not open
// the endpoint today, nor yesterday's "yes" answer a question. It emits
// 'stale' instead, so that the sender hears why.
export class TelegramCommands extends EventEmitter {
  constructor(telegram, { pollSeconds = 25, maxAgeSeconds = 120, answers = false, log = defaultLog } = {}) {
    super()
    this.telegram = telegram
    this.pollSeconds = pollSeconds
    this.maxAgeSeconds = maxAgeSeconds
    this.answers = answers
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
    // The kill switch first, always. A Reply is an answer, unless it is a
    // slash command: "good night" in reply to a question answers it.
    const stop = isStopCommand(message.text)
    const slash = message.text.trim().startsWith('/')
    const replyTo = Number.isInteger(message.reply_to_message?.message_id) ? message.reply_to_message.message_id : null
    const reply = this.answers && !stop && !slash && replyTo !== null
    const funnel = stop || reply ? null : funnelCommand(message.text)
    const stats = stop || reply || funnel ? null : statsCommand(message.text)
    const away = stop || reply || funnel || stats ? null : awayCommand(message.text)
    const answer = this.answers && !stop && !slash && !funnel && !stats && !away
    if (!stop && !funnel && !stats && !away && !answer) return
    const age = Math.round(Date.now() / 1000 - Number(message.date))
    if (age > this.maxAgeSeconds) {
      this.log(`telegram commands: ignored "${preview(message.text, 40)}", sent ${age} s ago`)
      this.emit('stale', { text: message.text, ageSeconds: age })
      return
    }
    if (stop) this.emit('stop', { text: message.text })
    else if (funnel) this.emit('funnel', { action: funnel, text: message.text })
    else if (away) this.emit('away', { on: away === 'away', text: message.text })
    else if (stats) this.emit('stats', { all: stats.all, text: message.text })
    else this.emit('answer', { text: message.text, replyTo, messageId: Number.isInteger(message.message_id) ? message.message_id : null })
  }
}

// A question, with its code in the first line and in the last. answerable:
// whether the driver may answer it here (TelegramAnswers.accepts).
function describeQuestion(request, update, answerable = false) {
  const about = request.worker
    ? `worker ${request.worker.repo}, task ${request.worker.task}`
    : request.via === 'telegram'
      ? `on your answer to ${request.answers}`
      : `"${preview(request.text, 60)}"`
  return [
    `Question for request ${request.id} (${about})`,
    '',
    update.text,
    '',
    answerable
      ? `To answer, reply to this message, or write a message that starts with ${request.id}. Or answer in voice mode and mention ${request.id}.`
      : `Answer in voice mode and mention ${request.id}.`,
  ].join('\n')
}

// The controller's answer or interim status on an answer that came by
// Telegram, as a reply to the driver's message there.
function describeReply(request, update) {
  return `On your answer to ${request.answers}${update.state === 'working' ? ', still working' : ''}:\n\n${update.text}`
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
  // send(text, { replyTo }): resolves with the message Telegram took.
  // paused: whether nothing goes out now, in a standby after the connector
  // was disconnected (standby.mjs) or in night mode; what waits goes out
  // after it. held: whether the controller's replies to the driver's own
  // answers by Telegram wait too, by default when paused; the gateway holds
  // them only in a standby. answerable(request): whether the driver may
  // answer that request's question here (TelegramAnswers.accepts).
  constructor(store, { send, afterSeconds = 600, paused = () => false, held = paused, answerable = () => false, log = defaultLog }) {
    this.store = store
    this.send = send
    this.afterSeconds = afterSeconds
    this.afterMs = afterSeconds * 1000
    this.paused = paused
    this.held = held
    this.answerable = answerable
    this.log = log
    this.voice = false // whether the voice mode was on at the last check
    this.timer = null
    this.queue = Promise.resolve() // keeps messages in order
    this.check = this.check.bind(this)
    this.answered = this.answered.bind(this)
    store.on('change', this.check)
    store.on('voice', this.check)
    store.on('permission', this.answered)
    this.check()
  }

  close() {
    clearTimeout(this.timer)
    this.store.off('change', this.check)
    this.store.off('voice', this.check)
    this.store.off('permission', this.answered)
  }

  // An approval request sent here that was answered at the computer since
  // (store.closePermissionsElsewhere): said once, whether the voice mode is
  // on or not, so that nobody answers it again by voice.
  answered(permission) {
    try {
      if (permission.status !== 'elsewhere' || !permission.telegram || permission.telegramClosed || this.paused()) return
      permission.telegramClosed = true
      this.deliver(`Approval request ${permission.code} was answered at the computer; nothing to do.`)
    } catch (error) {
      this.log('telegram fallback failed:', error.message)
    }
  }

  // Runs on every change in the store and when the voice mode may have ended.
  // It must never throw: it runs inside the reply tool and the voice calls.
  check() {
    try {
      clearTimeout(this.timer)
      if (!this.held()) this.relay()
      if (this.paused()) return
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
        // Its message id, so that a Reply to it finds the question.
        this.deliver(() => describeQuestion(request, update, this.answerable(request)), { sent: id => (update.telegramMessage = id) })
      }
    }
    for (const permission of this.store.openPermissions()) {
      if (permission.announced || permission.telegram) continue
      permission.telegram = true
      this.deliver(describePermission(permission), { sent: id => (permission.telegramMessage = id) })
    }
    // The marks go into the saved requests, so a restart sends nothing twice.
    if (marked) this.store.save?.()
  }

  // The controller's replies to an answer the driver gave here
  // (TelegramAnswers) go back here, as replies to the driver's message:
  // whether the voice mode is on or not, and in the night too, as the driver
  // is in the chat. Read, so that the voice client does not get them again.
  relay() {
    for (const request of this.store.requests.values()) {
      if (request.via !== 'telegram' || !this.store.hasUnread(request)) continue
      for (const update of this.store.takeUnread(request)) {
        update.telegram = true
        const replyTo = request.telegramMessage ?? null
        if (update.state === 'question') {
          this.deliver(() => describeQuestion(request, update, this.answerable(request)), { replyTo, sent: id => (update.telegramMessage = id) })
        } else {
          this.deliver(describeReply(request, update), { replyTo })
        }
      }
    }
  }

  // The questions and approvals open now count as told: the morning summary
  // names what the night left (night.mjs), instead of one message each.
  settle() {
    for (const request of this.store.requests.values()) {
      for (const update of request.updates.slice(request.cursor)) if (update.state === 'question') update.telegram = true
    }
    for (const permission of this.store.openPermissions()) permission.telegram = true
    this.store.save?.()
  }

  // message: the text, or a function that makes it when it is its turn: the
  // reply tool links a question to its decision only after the store's
  // change, and the footer of a question depends on that decision's kind.
  // replyTo: the driver's message this one answers. sent(id): what to do
  // with the id of the message Telegram took; it goes into the saved requests.
  deliver(message, { replyTo = null, sent = null } = {}) {
    let title = ''
    this.queue = this.queue
      .then(() => {
        const text = typeof message === 'function' ? message() : message
        title = text.split('\n')[0]
        return replyTo === null ? this.send(text) : this.send(text, { replyTo })
      })
      .then(taken => {
        if (sent && Number.isInteger(taken?.message_id)) {
          sent(taken.message_id)
          this.store.saveSoon?.()
        }
        this.log('telegram sent:', preview(title, 100))
      })
      .catch(error => this.log('telegram send failed:', preview(title, 60), '-', error.message))
  }
}

// --- answers by Telegram -----------------------------------------------------

// What VOICE_GW_TELEGRAM_ANSWERS=other leaves to the driver's voice: the
// decisions of these kinds (ledger.mjs).
export const VOICE_ONLY_KINDS = ['push', 'merge', 'restart', 'delete']

// The words of a message that could be codes: four letters and digits, as
// the gateway makes request ids (store.mjs) and decision ids (ledger.mjs).
const codesIn = text => [...new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(word => word.length === 4)

const listed = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join(''))

// The driver's answer to a question, typed in their Telegram chat: a Reply to
// the gateway's message with the question, or else a message that names the
// code of exactly one open question ("8cep yes", "Answer dk3p: no"), as a
// request's or a decision's. It reaches the controller as an answer by voice
// does: "(Answer to <id>) <text>", a request of the driver's (origin voice:
// dispatch and resolve_decision take its words, channel.mjs), with
// via="telegram"; the question counts as answered, and its open decisions
// keep the answer (ledger.mjs, gateway.mjs). The controller's replies to it
// come back to the chat (TelegramFallback.relay). Nothing else is passed on:
// no new requests, no approvals. Nor anything while the kill switch is locked
// or the gateway inactive (presence.mjs: in a standby, say, or without a
// controller); the chat hears why, and unlocking stays at the computer.
//
// push(request): hands the request to the controller (channel.mjs). say(text,
// replyTo): a message to the chat, as a reply to the driver's. held(): a
// sentence when the controller waits for the usage limit, else ''. mode: on,
// or other, which leaves push, merge, restart and delete decisions to the
// driver's voice.
export class TelegramAnswers {
  constructor({ store, ledger = null, push, say, mode = 'on', killswitch = null, presence = null, held = () => '', log = defaultLog }) {
    this.store = store
    this.ledger = ledger
    this.push = push
    this.say = say
    this.mode = mode
    this.killswitch = killswitch
    this.presence = presence
    this.held = held
    this.log = log
  }

  // Whether the driver may answer this request's question here.
  accepts(request) {
    return !this.voiceOnly(request)
  }

  // With mode other: the first open decision of the request that takes the
  // driver's voice; else null.
  voiceOnly(request) {
    if (this.mode !== 'other') return null
    return this.ledger?.forRequest(request.id).find(d => VOICE_ONLY_KINDS.includes(d.kind)) ?? null
  }

  // The gateway's message with this id: { request } for a question,
  // { permission } for an approval request, or null.
  sentMessage(id) {
    for (const request of this.store.requests.values()) {
      if (request.updates.some(update => update.telegramMessage === id)) return { request }
    }
    const permission = [...this.store.permissions.values()].find(p => p.telegramMessage === id)
    return permission ? { permission } : null
  }

  // The request with the open question a decision was asked on, or null.
  questionOf(decision) {
    if (!decision || decision.state === 'closed') return null
    for (const id of [...decision.requests].reverse()) {
      const request = this.store.getRequest(id)
      if (request?.state === 'question') return request
    }
    return null
  }

  openQuestions() {
    const open = [...this.store.requests.values()].filter(request => request.state === 'question').map(request => request.id)
    return open.length
      ? `Open: ${listed(open)}. Reply to its message, or start yours with its code.`
      : 'No question is open now.'
  }

  // The question a message answers: { question }, or { why } not.
  target(text, replyTo) {
    const sent = replyTo === null ? null : this.sentMessage(replyTo)
    if (sent?.permission) {
      return { why: `approval request ${sent.permission.code} is answered in voice mode or at the computer; Telegram cannot approve.` }
    }
    if (sent?.request) {
      const { request } = sent
      return request.state === 'question'
        ? { question: request }
        : { why: `question ${request.id} is not open any more: it was answered or settled. ${this.openQuestions()}` }
    }
    // No Reply to a question: the code in the message.
    const open = new Map()
    const closed = []
    for (const code of codesIn(text)) {
      const request = this.store.getRequest(code)
      const decision = request ? null : this.ledger?.get(code)
      if (!request && !decision) continue
      const question = request ? (request.state === 'question' ? request : null) : this.questionOf(decision)
      if (question) open.set(question.id, question)
      else closed.push(code)
    }
    if (open.size === 1) return { question: [...open.values()][0] }
    if (open.size > 1) return { why: `it names ${open.size} open questions, ${listed([...open.keys()])}. Answer each in a message of its own.` }
    if (closed.length) return { why: `${listed(closed)} ${closed.length === 1 ? 'has' : 'have'} no open question. ${this.openQuestions()}` }
    return {
      why:
        `${replyTo === null ? 'it is no Reply to a question' : 'the message it replies to holds no question'}, and it names no ` +
        `open question by its code. ${this.openQuestions()}`,
    }
  }

  // Whether and where a message goes: { question }, or { why } not.
  check(text, replyTo) {
    if (this.killswitch?.locked) return { why: 'the kill switch is locked. It is unlocked only at the computer.' }
    const presence = this.presence?.state() ?? { active: true }
    if (!presence.active) return { why: `this gateway is inactive, ${presence.why}.` }
    const target = this.target(text, replyTo)
    if (target.why) return target
    const decision = this.voiceOnly(target.question)
    if (decision) {
      const id = target.question.id
      return {
        why: `${id} is a ${decision.kind} decision, which takes your voice (VOICE_GW_TELEGRAM_ANSWERS=other). Answer it in voice mode and mention ${id}.`,
      }
    }
    return target
  }

  // A message from the driver's chat ({ text, replyTo, messageId }, from
  // TelegramCommands): passed on as their answer, or not, and the chat hears
  // which. Resolves with the answer's request, or null. Never throws.
  async route({ text, replyTo = null, messageId = null }) {
    const answer = String(text ?? '').trim()
    try {
      const result = this.check(answer, replyTo)
      if (result.why) {
        this.log('telegram answer not passed on:', result.why)
        await this.say(`Not passed on: ${result.why}`, messageId)
        return null
      }
      const { question } = result
      const request = this.store.createRequest(`(Answer to ${question.id}) ${answer}`, { answers: question.id, via: 'telegram' })
      // The meta stays with it, for an event sent again after the usage limit.
      request.meta = { via: 'telegram' }
      if (messageId !== null) request.telegramMessage = messageId // the controller's replies answer it
      this.store.markAnswered(question, request.id)
      await this.push(request)
      this.log('telegram answer passed on', `id=${request.id}`, `answers=${question.id}`)
      const held = this.held()
      await this.say(`Passed on to the controller as your answer to ${question.id}.${held ? ` ${held}` : ''}`, messageId)
      return request
    } catch (error) {
      this.log('telegram answer failed:', error.message)
      await Promise.resolve(this.say(`Not passed on: ${error.message}.`, messageId)).catch(() => {})
      return null
    }
  }
}
