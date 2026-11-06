// Telegram as a fallback return channel, outbound only.
//
// Voice assistants only poll: while one keeps calling the voice tools, it
// hears everything itself. When no voice tool call has come for a while
// (VOICE_GW_TELEGRAM_AFTER, 600 s by default), the voice mode counts as ended.
// Gaps of a few minutes between calls are normal while the driver talks, so
// the wait is long. From then on, questions the voice client has not received
// also go to their Telegram chat, each once. Claude Code's approval requests
// go there at once, each once, voice mode, night or not: Claude Code waits on
// them, and the next voice call may be long in coming. Results, news and
// interim "working" updates never go there; they wait for the next voice
// call. The voice path stays as it is.
//
// The other messages to the chat come from elsewhere and go at once, voice
// mode or not: the kill switch alarm, alerts about suspicious requests and
// sign-ins (ipguard.mjs), the Funnel (funnel.mjs) and the watchdog.
//
// Inbound, the gateway takes messages only from the driver: their own user id,
// in their private chat with the bot, which is the configured chat (in a
// private chat the chat's id is the user's). Groups, supergroups, channels,
// other senders and bots are ignored without a word back; forwarded, edited
// and non-text messages of the driver's are refused, with the reason in the
// chat. Every message, accepted or not, goes into the input log
// (TelegramInputLog). From the driver: a few commands, the kill switch first
// (/stop or an emergency phrase), the Tailscale Funnel on and off (/funnel
// on, /funnel off, /funnel, "keep alive"; see funnel.mjs), the statistics
// (/stats, /stats all; see stats.mjs) and night mode. And, only when the
// driver turned Telegram input on (off by default), their answers to its
// questions (TelegramAnswers, VOICE_GW_TELEGRAM_ANSWERS): a Reply to a
// question's message, a message with the question's code, or a press of a
// button under it, goes to the controller as their answer, like one by
// voice. Any other message is a request of theirs, as one by voice is
// (VOICE_GW_TELEGRAM_REQUESTS). The controller's replies to either come back
// to the chat. Push, merge, restart and delete count here as by voice, and
// Claude Code's approval requests are answered here with a yes or a no,
// unless VOICE_GW_TELEGRAM_CONFIRM=0 keeps them with the voice. Nothing here
// unlocks the kill switch: the PIN for the unlock in voice mode comes to the
// chat (killswitch.mjs), and typed back here it counts for nothing, masked.
//
// On only when .secrets/telegram_token and .secrets/telegram_chat_id both
// exist and are not empty. The token is part of every API address, so it must
// never reach a log line or an error message; the gateway keeps its file
// 0600 in the 0700 secrets folder (secureSecrets) and out of the environment
// of everything it starts (scrubEnv).

import { EventEmitter } from 'node:events'
import { chmodSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { emergencyPhrase } from './killswitch.mjs'
import { clock } from './limits.mjs'
import { log as defaultLog, fileLog, preview } from './log.mjs'
import { pending } from './store.mjs'

const MAX_TEXT = 4000 // Telegram takes up to 4096 characters
const SEND_TIMEOUT_MS = 10000
const SENT_KEPT = 2000 // the ids of the messages this gateway sent, for quotes

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

// The driver's Telegram user id: in a private chat with the bot, the chat's
// id is the user's, so the configured chat id is the driver's id too, and
// needs no setting of its own. null when the configured chat is no person's:
// the id of a group, a supergroup or a channel is negative.
export const driverId = chatId => {
  const text = String(chatId ?? '').trim()
  return /^\d{1,20}$/.test(text) ? text : null
}

export class Telegram {
  constructor({ token, chatId, apiBase = 'https://api.telegram.org' }) {
    this.token = token
    this.chatId = chatId
    this.apiBase = apiBase
    this.sentIds = new Set() // the messages this gateway sent since its start
  }

  call(method, body, options = {}) {
    return callBotApi({ apiBase: this.apiBase, token: this.token, method, body, ...options })
  }

  // Resolves with the message ({ message_id, … }) when Telegram accepted it.
  // replyTo: the id of a message in the chat that this one answers; sent
  // all the same if that message is gone. quote: false for a message that is
  // never quoted to the controller, the unlock PIN (killswitch.mjs): its id
  // is not kept, so a Reply to it comes without its text. markup: buttons
  // under it, { inline_keyboard } (approvalButtons, questionButtons).
  async send(text, { replyTo = null, quote = true, markup = null } = {}) {
    const body = { chat_id: this.chatId, text: String(text).slice(0, MAX_TEXT) }
    if (replyTo !== null) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true }
    if (markup) body.reply_markup = markup
    const message = await this.call('sendMessage', body)
    if (quote && Number.isInteger(message?.message_id)) {
      this.sentIds.add(message.message_id)
      if (this.sentIds.size > SENT_KEPT) this.sentIds.delete(this.sentIds.values().next().value)
    }
    return message
  }

  // Whether this gateway sent the message with this id, since its start: a
  // message of the bot's that it did not send may come from whoever else
  // has the token, and is never quoted to the controller.
  sent(id) {
    return this.sentIds.has(id)
  }

  // The buttons under one of its messages, in place of those before:
  // { inline_keyboard: [] } takes them away.
  editButtons(messageId, markup) {
    return this.call('editMessageReplyMarkup', { chat_id: this.chatId, message_id: messageId, reply_markup: markup })
  }

  // The answer to a press of a button: a short notice over the chat, or
  // nothing, so that the button stops spinning.
  answerPress(id, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: String(id), ...(text ? { text: preview(String(text), 190) } : {}) })
  }

  // Updates for the bot, waiting up to `timeout` seconds for new ones:
  // messages, edits of them, which are refused, and presses of the buttons
  // under its messages (TelegramCommands).
  async getUpdates({ offset, timeout = 25, signal } = {}) {
    const result = await this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message', 'edited_message', 'callback_query'] },
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
// (and the same in German, French, Italian, Spanish), the slash commands also
// with an end ("/night 09:00", "/night until 2026-11-03T09:00", awayUntil);
// 'back' for /back, /morning, "I'm back" or "good morning". null otherwise:
// digits count as words, so that "good night 9:00" is no bare "good night"
// that drops the end, but a request for the controller, with until.
const AWAY_WORDS = ['good night', 'goodnight', 'gute nacht', 'bonne nuit', 'buona notte', 'buonanotte', 'buenas noches']
const BACK_WORDS = ["i'm back", 'im back', 'i am back', 'good morning', 'guten morgen', 'bin zurück', 'ich bin zurück', 'bonjour', 'buongiorno', 'buenos días']
const AWAY_SLASH = /^\/(night|goodnight|away|back|morning)(?:@\w+)?(?:\s+(?:until\s+|bis\s+)?(\S.*))?$/i

export function awayCommand(text) {
  const slash = AWAY_SLASH.exec(String(text).trim())
  if (slash) {
    const back = ['back', 'morning'].includes(slash[1].toLowerCase())
    if (back && slash[2]) return null
    return back ? 'back' : 'away'
  }
  const words = String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}\s']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (AWAY_WORDS.includes(words)) return 'away'
  if (BACK_WORDS.includes(words)) return 'back'
  return null
}

// The end named after /night, /goodnight or /away, as written ("09:00"), for
// night.mjs's parseUntil; null without one.
export function awayUntil(text) {
  const slash = AWAY_SLASH.exec(String(text).trim())
  return slash?.[2] && awayCommand(text) === 'away' ? slash[2].trim() : null
}

// The statistics: /stats for this running time, /stats all for all time.
export function statsCommand(text) {
  const match = /^\/stats(?:@\w+)?(?:\s+(all))?$/i.exec(String(text).trim())
  return match ? { all: Boolean(match[1]) } : null
}

// The approval grants taken back (approval-grants.mjs): /revoke, "revoke" or
// "Freigaben zurücknehmen" for all of them, "/revoke g4k2" or "revoke g4k2"
// for one: { id }, id null for all. null otherwise. It only narrows, so it
// needs no Telegram input, as /stop does not.
const REVOKE_WORDS = new Set([
  'revoke', 'revoke all', 'revoke grants', 'revoke all grants', 'revoke the grants', 'end grants', 'end the grants',
  'freigaben zurücknehmen', 'freigabe zurücknehmen', 'alle freigaben zurücknehmen', 'die freigaben zurücknehmen',
  'freigaben zurückziehen', 'freigaben beenden', 'freigaben aufheben',
])
export function revokeCommand(text) {
  const slash = /^\/revoke(?:@\w+)?(?:\s+(all|g[a-z0-9]{3}))?$/i.exec(String(text).trim())
  if (slash) return { id: slash[1] && slash[1].toLowerCase() !== 'all' ? slash[1].toLowerCase() : null }
  const words = String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (REVOKE_WORDS.has(words)) return { id: null }
  const one = /^(?:revoke|freigabe) (g[a-z0-9]{3})(?: zurücknehmen)?$/.exec(words)
  return one ? { id: one[1] } : null
}

// Waits `ms`, or less if the signal aborts. The timer's abort listener goes
// away with it, so a long run of backoffs leaves none behind.
export const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {})

// Whether a message was forwarded from elsewhere: someone else's words, not
// the driver's own.
const forwarded = message =>
  Boolean(
    message.forward_origin ??
      message.forward_from ??
      message.forward_from_chat ??
      message.forward_sender_name ??
      message.forward_date ??
      message.is_automatic_forward,
  )

// What a message without text holds, for the input log.
function contentOf(message) {
  const kinds = ['voice', 'audio', 'photo', 'video', 'video_note', 'document', 'sticker', 'animation', 'location', 'contact', 'poll']
  return kinds.find(kind => message[kind] !== undefined)?.replace('_', ' ') ?? 'no text'
}

// Why a message of the driver's own does not count here, or null: their own
// words, written as a new text message.
function notOwn(message, edited) {
  if (typeof message.text !== 'string') return 'it holds no text. Only text messages are read here.'
  if (edited) return 'it is an edit of an earlier message, which is never read again. Write a new message instead.'
  if (forwarded(message)) return 'it is forwarded, so its words are not your own. Write what you want in a message of your own.'
  if (message.via_bot) return 'it was written through an inline bot, so its words are not your own. Write what you want yourself.'
  return null
}

// The answer when Telegram input is off (VOICE_GW_TELEGRAM_ANSWERS and
// VOICE_GW_TELEGRAM_REQUESTS, off by default).
export const INPUT_OFF =
  'Telegram input is off: here only commands count, such as /stop, /funnel, /stats, /night, /back and /revoke. ' +
  'Answer and ask in voice mode, or turn Telegram input on in the setup.'

// Inbound: polls the bot, and takes only the driver's own messages: from
// their user id, in their private chat with the bot, which is the configured
// chat. Everything else, a group, a supergroup, a channel, another sender, a
// bot or a message on behalf of a chat, is ignored without a word back,
// logged once, and kept in the input log (record). Of the driver's, a stop
// command or an emergency phrase comes first, always, and locks the kill
// switch ('stop'), also forwarded or edited. A message without text, an
// edit, a forwarded message or one written through an inline bot holds no
// words of theirs and is refused ('refused', { why, messageId }, which the
// chat hears). Then 'funnel' for a Funnel command, 'away' for night mode on
// or off, 'stats' for the statistics and 'revoke' ({ id }) to take the
// approval grants back, all or one. With answers (Telegram input on),
// also 'answer' ({ text, replyTo, messageId, quoted, forwarded, seen }) for a
// Reply to a message that asks something, whatever it says unless it is a
// slash command, and for any other text that is no command: TelegramAnswers
// decides whether it answers a question or is a new request. Without, such a
// message is refused (INPUT_OFF). asks(id): whether the gateway's message
// with that id asks the driver something, a question or an approval request;
// by default every Reply counts as one. quoted: the text of the bot's message
// a Reply answers, as Telegram has it, and only when known(id) says that this
// gateway sent it: whoever else has the token could send as the bot. A
// message older than maxAgeSeconds, sent while the gateway was not listening,
// does not count: Telegram keeps messages for a day, and yesterday's /funnel
// on must not open the endpoint today, nor yesterday's "yes" answer a
// question. It emits 'stale' instead, so that the sender hears why.
// masked(text): the text with the unlock PIN masked while one is valid
// (VoiceUnlock in killswitch.mjs). A message that holds it is refused, as the
// PIN counts only spoken in voice mode, and the input log, the log and every
// event get it masked: it reaches neither a log nor the controller.
export class TelegramCommands extends EventEmitter {
  constructor(
    telegram,
    {
      pollSeconds = 25,
      maxAgeSeconds = 120,
      answers = false,
      asks = () => true,
      known = () => true,
      record = () => {},
      masked = text => text,
      log = defaultLog,
    } = {},
  ) {
    super()
    this.telegram = telegram
    this.driver = driverId(telegram.chatId)
    this.pollSeconds = pollSeconds
    this.maxAgeSeconds = maxAgeSeconds
    this.answers = answers
    this.asks = asks
    this.known = known
    this.record = record
    this.masked = masked
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

  // Why a message is not the driver's own in their private chat with the
  // bot, or null. In a private chat the chat's id is the user's, and only
  // the user writes there; the sender is checked all the same.
  stranger(message) {
    const chat = message.chat ?? {}
    if (chat.type !== 'private') return `from a ${chat.type ?? 'chat of no known type'}`
    if (String(chat.id) !== String(this.telegram.chatId)) return 'from another chat'
    if (message.sender_chat) return 'sent on behalf of a chat'
    if (!message.from) return 'without a sender'
    if (message.from.is_bot === true) return 'from a bot'
    if (this.driver === null || String(message.from.id) !== this.driver) return 'from another sender'
    return null
  }

  // A press of a button under one of the bot's messages (approvalButtons,
  // questionButtons): only the driver's own, on a message in their private
  // chat with the bot, as for a message; a stranger's is ignored without a
  // word back. 'press' ({ id, data, messageId, seen }) for TelegramAnswers,
  // which decides what it does and answers it.
  press(query) {
    const message = query.message ?? {}
    const seen = {
      from: query.from?.id ?? null,
      chat: message.chat?.id ?? null,
      type: message.chat?.type ?? null,
      text: `(button ${preview(String(query.data ?? ''), 40)})`,
    }
    const stranger = this.stranger({ chat: message.chat ?? {}, from: query.from })
    if (stranger) {
      this.warnOnce(`ignored press ${stranger}`, `telegram commands: ignored a press of a button ${stranger}`)
      this.record({ ...seen, decision: 'ignored', why: `a press ${stranger}` })
      return
    }
    this.emit('press', {
      id: query.id,
      data: typeof query.data === 'string' ? query.data : '',
      messageId: Number.isInteger(message.message_id) ? message.message_id : null,
      seen,
    })
  }

  handle(update) {
    if (update.callback_query) return this.press(update.callback_query)
    const edited = !update.message && Boolean(update.edited_message)
    const message = update.message ?? update.edited_message
    if (!message) return // nothing else is asked for (getUpdates)
    // The unlock PIN, typed here: masked in everything that follows.
    const typed = typeof message.text === 'string' ? message.text : null
    const text = typed === null ? null : this.masked(typed)
    // For the input log: who, where, and a few words of what.
    const seen = {
      from: message.from?.id ?? null,
      chat: message.chat?.id ?? null,
      type: message.chat?.type ?? null,
      text: text ?? `(${contentOf(message)})`,
      ...(edited ? { edited: true } : {}),
    }
    const stranger = this.stranger(message)
    if (stranger) {
      // Not a word back: a stranger learns nothing from the bot.
      this.warnOnce(`ignored ${stranger}`, `telegram commands: ignored a message ${stranger}`)
      this.record({ ...seen, decision: 'ignored', why: `a message ${stranger}` })
      return
    }
    const messageId = Number.isInteger(message.message_id) ? message.message_id : null
    const age = Math.round(Date.now() / 1000 - Number(edited ? (message.edit_date ?? message.date) : message.date))
    const stale = () => {
      this.log(`telegram commands: ignored "${preview(seen.text, 40)}", sent ${age} s ago`)
      this.record({ ...seen, decision: 'ignored', why: `sent ${age} s ago, while the gateway was not listening` })
      this.emit('stale', { text: seen.text, ageSeconds: age })
    }
    const refuse = why => {
      if (age > this.maxAgeSeconds) return stale()
      this.log('telegram message not passed on:', why)
      this.record({ ...seen, decision: 'refused', why })
      this.emit('refused', { why, messageId, text: seen.text })
    }
    const accept = (as, event, payload) => {
      if (age > this.maxAgeSeconds) return stale()
      this.record({ ...seen, decision: 'accepted', as })
      this.emit(event, payload)
    }
    // The kill switch first, always, whatever the message is besides: a stop
    // can only lock.
    if (text !== null && isStopCommand(text)) return accept('stop', 'stop', { text })
    if (text !== typed) return refuse('it holds the unlock PIN, which counts only when you say it in voice mode. Say it there.')
    const own = notOwn(message, edited)
    if (own) return refuse(own)
    // A Reply to a question is an answer, unless it is a slash command: "good
    // night" in reply to a question answers it. A Reply to another message is
    // read like any message.
    const slash = text.trim().startsWith('/')
    const original = message.reply_to_message
    const replyTo = Number.isInteger(original?.message_id) ? original.message_id : null
    const reply = this.answers && !slash && replyTo !== null && this.asks(replyTo)
    const funnel = reply ? null : funnelCommand(text)
    if (funnel) return accept(`funnel ${funnel}`, 'funnel', { action: funnel, text })
    const stats = reply ? null : statsCommand(text)
    if (stats) return accept(stats.all ? 'stats all' : 'stats', 'stats', { all: stats.all, text })
    const away = reply ? null : awayCommand(text)
    if (away) return accept(away === 'away' ? 'night on' : 'night off', 'away', { on: away === 'away', until: awayUntil(text), text })
    const revoke = reply ? null : revokeCommand(text)
    if (revoke) return accept(revoke.id ? `revoke ${revoke.id}` : 'revoke', 'revoke', { id: revoke.id, text })
    if (slash) return refuse(`"${preview(text, 30)}" is no command here. The commands: /stop, /funnel, /stats, /night, /back and /revoke.`)
    if (!this.answers) return refuse(INPUT_OFF)
    if (age > this.maxAgeSeconds) return stale()
    // TelegramAnswers records what it makes of it.
    const bot = original?.from?.is_bot === true && typeof original.text === 'string'
    this.emit('answer', {
      text,
      replyTo,
      messageId,
      quoted: bot && this.known(replyTo) ? original.text : null,
      forwarded: false,
      seen: bot && !this.known(replyTo) ? { ...seen, note: 'it replies to a message of the bot that this gateway did not send since its start; not quoted' } : seen,
    })
  }
}

// --- the input log ------------------------------------------------------------

// Anything shaped like a bot token: digits, a colon, then about 35 characters.
const BOT_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{30,}/g
const EXCERPT = 80

// Every message the bot receives, the driver's and anyone else's, accepted,
// refused or ignored, in an append-only file in the gateway's state folder
// (config.telegramInputLog), one JSON line each: when, the sender's id, the
// chat's id and type, a short excerpt, the decision (accepted, refused,
// ignored), as what or why, and the request it became. So it shows who tried
// what, also where nothing was said back. Bounded: past maxBytes it moves to
// <file>.1, replacing the one before (log.mjs). Mode 0600, folder 0700. Never
// the token: the secrets, and anything shaped like a bot token, are cut out
// of the excerpt and the reason first. Never throws.
export class TelegramInputLog {
  constructor({ file, maxBytes = 1024 * 1024, secrets = [] }) {
    this.file = file
    this.secrets = secrets.filter(secret => typeof secret === 'string' && secret.length >= 6)
    this.write = fileLog(file, { maxBytes })
  }

  clean(text) {
    let clean = String(text ?? '')
    for (const secret of this.secrets) clean = clean.split(secret).join('<token>')
    return clean.replace(BOT_TOKEN, '<token>')
  }

  record({ from = null, chat = null, type = null, text = '', edited = false, decision, as = null, why = null, note = null, request = null, answers = null }) {
    try {
      const entry = { at: new Date().toISOString(), from, chat, type, text: preview(this.clean(text), EXCERPT), decision }
      if (edited) entry.edited = true
      if (as) entry.as = as
      if (why) entry.why = preview(this.clean(why), 200)
      if (note) entry.note = note
      if (request) entry.request = request
      if (answers) entry.answers = answers
      this.write(`${JSON.stringify(entry)}\n`)
    } catch {
      // the input log must never stop a message
    }
  }
}

// --- the token -------------------------------------------------------------------

// The secrets folder 0700, the bot token's and the chat id's files 0600: the
// token lets whoever has it read what the driver writes to the bot, and
// write to them as the bot. What is open to others (a file from an older
// version, or one written by hand without umask 077) is tightened at the
// gateway's start. Returns a line for the log for each, never the token.
export function secureSecrets({ dir, tokenFile, files = [] }) {
  const notes = []
  const tighten = (path, mode, what, token) => {
    let stat
    try {
      stat = statSync(path)
    } catch {
      return
    }
    if ((stat.mode & 0o077) === 0) return
    const was = (stat.mode & 0o777).toString(8)
    const advice = token
      ? '. Whoever could read it may have the bot token: if that may have happened, get a new token from @BotFather ' +
        '(/revoke) and enter it in the setup'
      : ''
    try {
      chmodSync(path, mode)
      notes.push(`telegram: ${what} was open to others (mode ${was}); now ${mode.toString(8)}${advice}`)
    } catch (error) {
      notes.push(`telegram: ${what} is open to others (mode ${was}) and could not be tightened (${error.code ?? error.message}): chmod ${mode.toString(8)} it${advice}`)
    }
  }
  tighten(dir, 0o700, 'the secrets folder', true)
  tighten(tokenFile, 0o600, basename(tokenFile), true)
  for (const file of files) tighten(file, 0o600, basename(file), false)
  return notes
}

// Removes from env every variable whose value holds one of the secrets, so
// that nothing the gateway starts, a worker run above all, inherits the bot
// token from it. Returns the names removed.
export function scrubEnv(env, secrets) {
  const kept = secrets.filter(secret => typeof secret === 'string' && secret.length >= 6)
  const removed = []
  for (const [name, value] of Object.entries(env)) {
    if (kept.some(secret => String(value).includes(secret))) {
      delete env[name]
      removed.push(name)
    }
  }
  return removed
}

// A question, with its code in the first line and in the last. answerable:
// whether the driver may answer it here (TelegramAnswers.accepts); buttons:
// whether it comes with buttons (questionButtons).
function describeQuestion(request, update, answerable = false, buttons = false) {
  const about = request.worker
    ? `worker ${request.worker.repo}, task ${request.worker.task}`
    : request.via === 'telegram' && request.answers
      ? `on your answer to ${request.answers}`
      : `"${preview(request.driverText ?? request.text, 60)}"`
  return [
    `Question for request ${request.id} (${about})`,
    '',
    update.text,
    '',
    answerable
      ? `To answer, ${buttons ? 'press a button, ' : ''}reply to this message, or write a message that starts with ${request.id}. ` +
          `Or answer in voice mode and mention ${request.id}.`
      : `Answer in voice mode and mention ${request.id}.`,
  ].join('\n')
}

// --- buttons under a question --------------------------------------------------
//
// The driver asked: "können wir bei solchen nachfragen auch knöpfe einbauen
// damit sich das direkt per klick beantworten lässt?" A question in the chat,
// the first ask and each reminder, comes with buttons where the driver may
// answer it there (TelegramAnswers.accepts): the answers the controller named
// with it (reply's options, two to four short labels), or else ✅ Ja and ❌ Nein,
// in the question's language. A button's data is "ques:<request>:<n>": the
// label comes from the question the gateway keeps, never from the data, and a
// press goes as the label typed as a Reply would (TelegramAnswers.press). Once
// the question is answered anywhere, by voice, typed or pressed, or settled,
// the buttons of every message of it give way to one line with the outcome
// that answers nothing (TelegramFallback.keyboards), and never come back.

export const QUESTION_PRESS = /^ques:([a-hjkmnp-z2-9]{4}):([0-3])$/
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4
export const MAX_OPTION_LENGTH = 40

// The reply tool's options, as the controller gives them: a list of two to
// four short labels, or a string of them separated by commas. { options },
// null for none (an empty list too), or { why } they are none.
export function optionLabels(value) {
  if (value === undefined || value === null || value === '') return { options: null }
  const list = typeof value === 'string' ? value.split(/[,\n|]/) : value
  if (!Array.isArray(list) || list.some(label => typeof label !== 'string')) return { why: 'options must be a list of short labels.' }
  const options = list.map(label => label.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (!options.length) return { options: null }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return { why: `options takes ${MIN_OPTIONS} to ${MAX_OPTIONS} short labels, not ${options.length}.` }
  }
  const long = options.find(label => [...label].length > MAX_OPTION_LENGTH)
  if (long) return { why: `the option "${preview(long, 50)}" is longer than ${MAX_OPTION_LENGTH} characters; name it in a few words.` }
  if (new Set(options.map(label => label.toLowerCase())).size < options.length) return { why: 'options holds the same label twice.' }
  return { options }
}

// Whether a question reads as German, for the default answers: looksGerman's
// words, and those a question in German has that no English one does.
const QUESTION_GERMAN = new Set(
  'ich du sie wir ihr soll sollen sollte willst wollen möchtest kann kannst können darf dürfen wird werden oder dass für auf zu zum zur von vom wie wann wo welche welcher welches schon lieber machen gleich erst heute einen eine ein diesen dieses diese'.split(' '),
)
const questionGerman = text =>
  looksGerman(text) || (String(text).toLowerCase().match(/\p{L}+/gu) ?? []).some(word => QUESTION_GERMAN.has(word))

// The labels of a question's buttons: its options, or yes and no.
export function questionLabels(update) {
  if (Array.isArray(update.options) && update.options.length >= MIN_OPTIONS) return update.options.slice(0, MAX_OPTIONS)
  return questionGerman(update.text) ? ['Ja', 'Nein'] : ['Yes', 'No']
}

// Two short ones side by side, else one a row, so that a phone shows each whole.
export function questionButtons(request, update) {
  const named = Array.isArray(update.options) && update.options.length >= MIN_OPTIONS
  const labels = questionLabels(update)
  const buttons = labels.map((label, n) => ({
    text: named ? label : `${n === 0 ? '✅' : '❌'} ${label}`,
    callback_data: `ques:${request.id}:${n}`,
  }))
  const side = buttons.length === 2 && labels.every(label => [...label].length <= 16)
  return { inline_keyboard: side ? [buttons] : buttons.map(button => [button]) }
}

// Whether a question is still open to an answer: its request still waits on
// it (an answer settles it, store.markAnswered), with update its latest
// question, as one asked again on the same request takes the place of the
// one before, and of the decisions asked on it, one is not answered or
// closed yet. A reminder's question is open no longer once the first ask was
// answered, and the other way round, as they ask the same decision (ledger.mjs).
export function questionOpen(request, ledger = null, update = null) {
  if (!request || request.state !== 'question') return false
  if (update && update !== request.updates.at(-1)) return false
  const decisions = ledger?.forRequest(request.id, { closed: true }) ?? []
  return !decisions.length || decisions.some(d => d.state === 'pending' || d.state === 'asked')
}

// The driver's answer to a question that is not open any more, to it or to
// a decision asked on it, as a reminder's, given after the question was
// asked (since): { by, words }, by ' by voice' or '' for here; null when it
// was settled without one.
function questionAnswer(request, { store = null, ledger = null } = {}, since = 0) {
  const decided = (ledger?.forRequest(request.id, { closed: true }) ?? [])
    .filter(d => d.answeredBy && d.answeredAt >= since).sort((a, b) => a.answeredAt - b.answeredAt).at(-1)
  const own = request.answeredBy && !(store?.getRequest(request.answeredBy)?.createdAt < since) ? request.answeredBy : null
  const answerId = own ?? decided?.answeredBy ?? null
  if (!answerId) return null
  const answer = store?.getRequest(answerId)
  const words = answer ? answer.text.replace(/^\(Answer to [^)]*\)\s*/, '') : (decided?.answer ?? '')
  return { by: answer && answer.via !== 'telegram' ? ' by voice' : '', words: preview(words, 40) }
}

// In place of the buttons of a question that is not open any more: what came of it.
export function questionOutcome(request, known = {}, since = 0) {
  const answer = questionAnswer(request, known, since)
  if (!answer) return '⏹ Not open any more'
  return answer.words ? `✅ Answered${answer.by}: ${answer.words}` : `✅ Answered${answer.by}`
}

// The same in a sentence, for a press of an old button.
function questionGone(request, known = {}, since = 0) {
  const answer = questionAnswer(request, known, since)
  const how = answer ? `it was answered${answer.by}${answer.words ? ` ("${answer.words}")` : ''}` : 'it was answered or settled'
  return `question ${request.id} is not open any more: ${how}.`
}

// The controller's answer or interim status on an answer or a request that
// came by Telegram, as a reply to the driver's message there.
function describeReply(request, update) {
  const about = request.answers ? `On your answer to ${request.answers}` : `On your request ${request.id}`
  return `${about}${update.state === 'working' ? ', still working' : ''}:\n\n${update.text}`
}

// Claude Code's descriptions often end with a full stop already.
const descriptionOf = permission => String(permission.description ?? '').replace(/[\s.]+$/, '')

// An approval request in a few words, for the chat: "qwert (Bash: gh pr
// merge 3 …)", so that the driver sees which one an answer went to.
export const permissionBrief = permission => `${permission.code} (${permission.toolName}: ${preview(descriptionOf(permission), 60)})`

// An approval request. approvable: whether the driver may answer it here
// (TelegramAnswers.approves).
// A subagent's, relayed by the controller's hook (approvals.mjs), is not
// shown at the terminal while the gateway holds it: voice mode and here only.
function describePermission(permission, approvable = false) {
  const details = preview(permission.inputPreview || '', 300)
  const whose = permission.agent ? `subagent ${permission.agent} of the controller session` : 'controller session'
  const lines = [`Approval request ${permission.code} (${whose})`, '', `${permission.toolName}: ${descriptionOf(permission)}`]
  if (details) lines.push(`Details: ${details}`)
  const elsewhere = permission.source === 'hook' ? 'in voice mode' : 'in voice mode or at the terminal'
  lines.push(
    '',
    approvable
      ? `To allow it, reply to this message with yes, or with no to deny it; or write a message with ${permission.code} ` +
          'and yes or no, or just yes or no while it is the only one open ("yes to all" allows every one open). Or answer ' +
          `${elsewhere}.`
      : `Answer ${elsewhere}; Telegram cannot approve.`,
  )
  // The grant it could get (approval-grants.mjs), with the same answers.
  const { offer } = permission
  if (offer) {
    lines.push(
      approvable
        ? `Or "yes ${offer.minutes}" to allow it and all ${offer.text} for ${offer.minutes} minutes.`
        : `In voice mode it can be allowed with all ${offer.text} for ${offer.minutes} minutes.`,
    )
  }
  return lines.join('\n')
}

// --- buttons under an approval request -----------------------------------------
//
// The driver asked: "Könnte man das beim CC-Gateway für die Approval Requests
// auch so umsetzen, dass man per Knopfdruck Yes, No und, wenn mehrere pendent
// sind, Yes to all sagen kann?" An approval request in the chat comes with
// buttons where the driver may answer it there (TelegramAnswers.approves):
// ✅ Yes and ❌ No, ⏱ Yes, 20 min where it offers an approval grant
// (approval-grants.mjs), and ✅ Yes to all while more than one is open. A
// button's data is "appr:<code>:<what>"; only the code says which approval it
// answers, and that approval must still be open (TelegramAnswers.press). Once
// it is answered, here or elsewhere, or withdrawn, the buttons give way to
// one that says what came of it and answers nothing, as hauswache's
// "✅ Gesehen" does (TelegramFallback.keyboards).

export const PRESS = /^appr:([a-km-z]{5}):(yes|no|grant|all)$/

export function approvalButtons(permission, { open = 1 } = {}) {
  const { code, offer } = permission
  const first = [{ text: '✅ Yes', callback_data: `appr:${code}:yes` }]
  if (offer) first.push({ text: `⏱ Yes, ${offer.minutes} min`, callback_data: `appr:${code}:grant` })
  first.push({ text: '❌ No', callback_data: `appr:${code}:no` })
  const rows = [first]
  if (open > 1) rows.push([{ text: '✅ Yes to all', callback_data: `appr:${code}:all` }])
  return { inline_keyboard: rows }
}

// In place of the buttons of one that is answered or withdrawn: what came of it.
export function outcomeButtons(permission) {
  const where = { telegram: '', voice: ' by voice', grant: ` by grant ${permission.grant ?? ''}`.trimEnd() }[permission.by] ?? ''
  const label =
    permission.status === 'allow'
      ? `✅ Allowed${where}`
      : permission.status === 'deny'
        ? permission.by === 'killswitch'
          ? '⛔ Denied: the kill switch locked'
          : `❌ Denied${where}`
        : '⏹ Not open any more'
  return { inline_keyboard: [[{ text: label, callback_data: '-' }]] }
}

// The minutes of an answer that allows an approval request and all such for
// a while (approval-grants.mjs): "yes 20", "ja 20", "yes for 20 minutes",
// "ja, 20 Minuten", in any case, with full stops or exclamation marks after
// it. null for anything else, a plain yes included.
const GRANT_YES = 'yes|y|yeah|yep|ok|okay|allow|approve|ja|jo|jep|jawohl|oui|si|sì|sí'
const GRANT_UNITS = "m|min|mins|minute|minutes|minuten|minuti|minutos"
const GRANT_ANSWER = new RegExp(`^(?:${GRANT_YES})(?: (?:for|für|pour|per|por))? (\\d{1,3}) ?(?:${GRANT_UNITS})?$`, 'u')
export function grantMinutesOf(text) {
  const words = String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[,;:]/g, ' ')
    .replace(/[\s.!…]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  const match = GRANT_ANSWER.exec(words)
  return match ? Number(match[1]) : null
}

export class TelegramFallback {
  // send(text, { replyTo }): resolves with the message Telegram took.
  // paused: whether no question goes out now, in a standby after the
  // connector was disconnected (standby.mjs) or in night mode; what waits
  // goes out after it. held: whether approval requests and the controller's
  // replies to the driver's own answers and requests by Telegram wait too, by
  // default when paused; the gateway holds them only in a standby.
  // answerable(request): whether the driver may answer that request's
  // question here (TelegramAnswers.accepts). approvable(): whether they may
  // answer approval requests here (TelegramAnswers.approves). edit(id,
  // markup): changes the buttons under a message sent here; with it, an
  // approval request or a question the driver may answer here comes with
  // buttons. ledger: the open decisions, which tell when a question's
  // buttons give way (questionOpen); a closed one changes them too.
  constructor(
    store,
    {
      send,
      afterSeconds = 600,
      paused = () => false,
      held = paused,
      answerable = () => false,
      approvable = () => false,
      edit = null,
      ledger = null,
      log = defaultLog,
    },
  ) {
    this.store = store
    this.send = send
    this.edit = edit
    this.ledger = ledger
    this.afterSeconds = afterSeconds
    this.afterMs = afterSeconds * 1000
    this.paused = paused
    this.held = held
    this.answerable = answerable
    this.approvable = approvable
    this.log = log
    this.voice = false // whether the voice mode was on at the last check
    this.timer = null
    this.queue = Promise.resolve() // keeps messages in order
    this.check = this.check.bind(this)
    store.on('change', this.check)
    store.on('voice', this.check)
    ledger?.on('closed', this.check)
    this.check()
  }

  close() {
    clearTimeout(this.timer)
    this.store.off('change', this.check)
    this.store.off('voice', this.check)
    this.ledger?.off('closed', this.check)
  }

  // Runs on every change in the store and when the voice mode may have ended.
  // It must never throw: it runs inside the reply tool and the voice calls.
  check() {
    try {
      clearTimeout(this.timer)
      if (!this.held()) {
        this.relay()
        this.approvals()
        this.keyboards()
      }
      if (this.paused()) return
      const active = this.store.voiceActive(this.afterMs)
      if (active !== this.voice) {
        this.voice = active
        this.log(
          active
            ? 'voice mode on: telegram fallback paused for questions'
            : `voice mode ended (no voice call for ${this.afterSeconds} s): telegram fallback on for questions`,
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

  // What needs the driver and has not reached them by voice: open questions.
  // Results, news and interim updates wait for the next voice call.
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
        this.question(request, update)
      }
    }
    // The marks go into the saved requests, so a restart sends nothing twice.
    if (marked) this.store.save?.()
  }

  // A question to the chat, with buttons where the driver may answer it here
  // (questionButtons), both made when it is its turn. Its message id, so that
  // a Reply or a press finds it. replyTo: the driver's message it answers.
  question(request, update, replyTo = null) {
    const buttons = () => Boolean(this.edit) && this.answerable(request) && questionOpen(request, this.ledger, update)
    let shown = false
    this.deliver(
      () => {
        shown = buttons()
        return describeQuestion(request, update, this.answerable(request), shown)
      },
      {
        replyTo,
        markup: () => {
          if (!shown) return null
          const markup = questionButtons(request, update)
          update.buttons = JSON.stringify(markup) // what the chat shows, for keyboards
          return markup
        },
        sent: id => (update.telegramMessage = id),
      },
    )
  }

  // Every approval request goes here as soon as Claude Code raises it, once:
  // whether the voice mode is on or not, the voice client heard it or not,
  // and in the night too, as the driver asked. Claude Code waits on it, and
  // the next voice call may be long in coming. Only a standby holds it
  // (held); while the kill switch is locked none is open, as the channel
  // denies them (channel.mjs). Its message id, so that a Reply to it finds it.
  // With buttons where the driver may answer it here (approvalButtons).
  approvals() {
    for (const permission of this.store.openPermissions()) {
      if (permission.telegram) continue
      permission.telegram = true
      const markup = () => {
        if (!this.edit || !this.approvable()) return null
        const buttons = approvalButtons(permission, { open: this.store.openPermissions().length })
        permission.buttons = JSON.stringify(buttons) // what the chat shows, for keyboards
        return buttons
      }
      this.deliver(() => describePermission(permission, this.approvable()), { markup, sent: id => (permission.telegramMessage = id) })
    }
  }

  // The buttons under the approval requests and questions sent here, as they
  // should be now: Yes to all comes and goes with the number open, and those
  // of one answered, here or elsewhere, or withdrawn or settled, give way to
  // its outcome, so that nothing stale stays to press. Only under those sent
  // with buttons.
  keyboards() {
    if (!this.edit) return
    const open = this.store.openPermissions().length
    for (const permission of this.store.permissions.values()) {
      if (!permission.buttons || !Number.isInteger(permission.telegramMessage)) continue
      const markup = pending(permission)
        ? this.approvable() ? approvalButtons(permission, { open }) : { inline_keyboard: [] }
        : outcomeButtons(permission)
      const key = JSON.stringify(markup)
      if (key === permission.buttons) continue
      permission.buttons = key
      this.editButtons(permission.telegramMessage, markup, `approval ${permission.code}`)
    }
    // And under the questions: their outcome once they are not open any
    // more, kept, so that the buttons never come back; none while the driver
    // may not answer them here.
    let changed = false
    for (const request of this.store.requests.values()) {
      for (const update of request.updates) {
        if (!update.buttons || !Number.isInteger(update.telegramMessage)) continue
        if (!update.outcome && !questionOpen(request, this.ledger, update)) {
          update.outcome = questionOutcome(request, { store: this.store, ledger: this.ledger }, update.at)
        }
        const markup = update.outcome
          ? { inline_keyboard: [[{ text: update.outcome, callback_data: '-' }]] }
          : this.answerable(request) ? questionButtons(request, update) : { inline_keyboard: [] }
        const key = JSON.stringify(markup)
        if (key === update.buttons) continue
        update.buttons = key
        changed = true
        this.editButtons(update.telegramMessage, markup, `question ${request.id}`)
      }
    }
    if (changed) this.store.saveSoon?.()
  }

  // The buttons under one message, in their turn after what goes out before.
  editButtons(messageId, markup, what) {
    this.queue = this.queue
      .then(() => this.edit(messageId, markup))
      .then(() => this.log('telegram buttons changed:', what, preview(markup.inline_keyboard.flat().map(button => button.text).join(', '), 80)))
      .catch(error => this.log('telegram buttons not changed:', what, '-', error.message))
  }

  // The controller's replies to an answer or a request the driver gave here
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
          this.question(request, update, replyTo)
        } else {
          this.deliver(describeReply(request, update), { replyTo })
        }
      }
    }
  }

  // The questions open now count as told: the morning summary names what the
  // night left (night.mjs), instead of one message each. Approval requests
  // went here at once.
  settle() {
    for (const request of this.store.requests.values()) {
      for (const update of request.updates.slice(request.cursor)) if (update.state === 'question') update.telegram = true
    }
    this.store.save?.()
  }

  // message: the text, or a function that makes it when it is its turn: the
  // reply tool links a question to its decision only after the store's
  // change, and the footer of a question depends on that decision's kind.
  // replyTo: the driver's message this one answers. sent(id): what to do
  // with the id of the message Telegram took; it goes into the saved requests.
  // markup(): the buttons under it, made when it is its turn, or null.
  deliver(message, { replyTo = null, sent = null, markup = null } = {}) {
    let title = ''
    this.queue = this.queue
      .then(() => {
        const text = typeof message === 'function' ? message() : message
        title = text.split('\n')[0]
        const buttons = markup?.() ?? null
        if (buttons) return this.send(text, replyTo === null ? { markup: buttons } : { replyTo, markup: buttons })
        return replyTo === null ? this.send(text) : this.send(text, { replyTo })
      })
      .then(taken => {
        if (sent && Number.isInteger(taken?.message_id)) {
          sent(taken.message_id)
          this.store.saveSoon?.()
          // Its buttons may have to change already: another one came meanwhile.
          this.keyboards()
        }
        this.log('telegram sent:', preview(title, 100))
      })
      .catch(error => this.log('telegram send failed:', preview(title, 60), '-', error.message))
  }
}

// --- answers and requests by Telegram ----------------------------------------

// What takes the driver's voice with VOICE_GW_TELEGRAM_CONFIRM=0, whatever
// comes by Telegram: the decisions of these kinds (ledger.mjs), and in
// channel.mjs the tools that carry them out (takesVoice). Approvals too,
// which Telegram then never gives. By default they count by Telegram as by
// voice.
export const VOICE_ONLY_KINDS = ['push', 'merge', 'restart', 'delete']

// The answer to a Telegram answer about such a decision, with the setting
// at 0: nothing done, the decision stays open, and it must be confirmed by
// voice; in German when the driver wrote in German, else in English.
const KIND_DE = { push: 'Push', merge: 'Merge', restart: 'Neustart', delete: 'Lösch' }
const GERMAN_WORDS = new Set(
  'ja nein bitte und nicht mach mache ist das der den dem doch gerne gern klar genau jawohl passt los weiter alles auch aber noch sofort jetzt'.split(' '),
)
export const looksGerman = text =>
  /[äöüß]/i.test(String(text)) || (String(text).toLowerCase().match(/\p{L}+/gu) ?? []).some(word => GERMAN_WORDS.has(word))

export function voiceOnlyText(id, kind, text) {
  return looksGerman(text)
    ? `Nicht ausgeführt: ${id} ist eine ${KIND_DE[kind] ?? kind}-Entscheidung, und die muss per Voice bestätigt werden. ` +
        `Sie bleibt offen. Sag es im Voice-Modus und nenne ${id}.`
    : `Not done: ${id} is a ${kind} decision, which must be confirmed by voice. It stays open. Say it in voice mode and mention ${id}.`
}

// The words of a message that could be codes: four letters and digits, as
// the gateway makes request ids (store.mjs) and decision ids (ledger.mjs).
const codesIn = text => [...new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(word => word.length === 4)

// The words of a message that could be approval codes: five letters, as
// Claude Code makes them.
const approvalCodesIn = text => [...new Set(String(text).toLowerCase().match(/[a-z]+/g) ?? [])].filter(word => word.length === 5)

// The driver's answer to an approval request: 'allow' for a plain yes,
// 'deny' for a plain no, null for anything else, also a message with both
// ("not ok", "nein, doch ja"): an approval takes an explicit answer, as by
// voice.
const ALLOW_WORDS = new Set(
  'yes y yeah yep ok okay sure allow allowed approve approved go ja jo jep jawohl klar genau gerne erlauben erlaube erlaubt freigeben oui si sí sì'.split(' '),
)
const DENY_WORDS = new Set(
  "no n nope not don't dont never deny denied reject refuse cancel stop nein ne nö nee nicht kein keine ablehnen verweigern abbrechen non".split(' '),
)
export function verdictOf(text) {
  const words = String(text).normalize('NFC').toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}']+/gu) ?? []
  const allow = words.some(word => ALLOW_WORDS.has(word))
  const deny = words.some(word => DENY_WORDS.has(word))
  return allow === deny ? null : allow ? 'allow' : 'deny'
}

// A message that is nothing but a yes or a no, as the driver writes it to an
// approval request without Telegram's Reply and without its code:
// { behavior, all }, all for "yes to all" and its like, or null for anything
// else. Stricter than verdictOf, which reads a message already known to answer
// an approval request: here the whole message must be one of these, in any
// case, with full stops, exclamation marks or commas after it; "yes?" or
// "yes, merge it" is none.
const BARE_ALLOW = new Set('yes y yeah yep ok okay approve allow ja jo jep jawohl oui si sì sí 👍'.split(' '))
const BARE_DENY = new Set('no n nope deny nein ne nee non 👎'.split(' '))
const ALL_ALLOW = new Set([
  'yes to all', 'yes for all', 'yes all', 'all yes', 'allow all', 'approve all',
  'ja zu allen', 'ja zu allem', 'ja für alle', 'ja alle', 'alle ja', 'alles ja', 'alle erlauben',
  'oui à tous', 'oui pour tous', 'sì a tutti', 'si a tutti',
])
const ALL_DENY = new Set([
  'no to all', 'no for all', 'no all', 'all no', 'deny all',
  'nein zu allen', 'nein zu allem', 'nein für alle', 'nein alle', 'alle nein', 'alles nein', 'alle ablehnen',
  'non à tous', 'non pour tous', 'no a tutti',
])
export function bareVerdict(text) {
  const words = String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '') // skin tones, emoji presentation
    .replace(/[,;:]/g, ' ')
    .replace(/[\s.!…]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  // "yes 20": the same, and the grant it offers (grantMinutesOf).
  const minutes = grantMinutesOf(words)
  if (minutes !== null) return { behavior: 'allow', all: false, minutes }
  if (BARE_ALLOW.has(words)) return { behavior: 'allow', all: false }
  if (BARE_DENY.has(words)) return { behavior: 'deny', all: false }
  if (ALL_ALLOW.has(words)) return { behavior: 'allow', all: true }
  if (ALL_DENY.has(words)) return { behavior: 'deny', all: true }
  return null
}

const listed = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join(''))

// The gateway's message a request replies to, quoted after the driver's own
// words as context. Data: it may carry what others wrote, in an alert or in
// the controller's summary of a worker's result, and it never counts as the
// driver's words (driverText, spokenByDriver in channel.mjs).
const QUOTE_MAX = 1000
export const quoteText = quoted => `(In reply to the gateway's message, quoted as data: "${preview(quoted, QUOTE_MAX)}")`

// The driver's messages in their Telegram chat that are no command.
//
// An answer to a question: a Reply to the gateway's message with the
// question, or else a message that names the code of exactly one open
// question ("8cep yes", "Answer dk3p: no"), as a request's or a decision's.
// It reaches the controller as an answer by voice does: "(Answer to <id>)
// <text>", a request of the driver's (origin voice: dispatch and
// resolve_decision take its words, channel.mjs), with via="telegram"; the
// question counts as answered, and its open decisions keep the answer
// (ledger.mjs, gateway.mjs).
//
// With requests, any other message is a new request of the driver's, as one
// by voice is: origin voice, via="telegram", and its words count the same. A
// Reply to another message of the gateway's, news or an alarm, quotes it as
// context (quoteText). A Reply to an approval request, or to a question that
// is settled, stays refused.
//
// The controller's replies to either come back to the chat
// (TelegramFallback.relay). Nothing while the kill switch is locked or the
// gateway inactive (presence.mjs: in a standby, say, or without a
// controller); the chat hears why, and that unlocking is at the computer, or
// in voice mode with a PIN sent there (killswitch.mjs). Nor a forwarded
// message, which holds someone else's words.
//
// Push, merge, restart and delete decisions are answered here as any other
// question, and an approval request of Claude Code's that the gateway sent
// here is answered with a yes or a no, by Reply or with its code: the
// verdict goes to Claude Code as one by voice does (approves). A message that
// is nothing but a yes or a no (bareVerdict), without a Reply and without a
// code, answers the approval request open now, when it is the only one: the
// controller waits on it and could not read the message as a request before
// it is answered anyway. With several open, or with a question shown here
// after it, it answers none, and the chat asks which one is meant (bare). "Yes
// to all" allows every approval request open, "no to all" denies them, and
// the chat lists them; questions never. With confirm off
// (VOICE_GW_TELEGRAM_CONFIRM=0) none of this: an answer to such a decision is
// not passed on, nothing is done, the decision stays open, and the chat hears
// that it must be confirmed by voice (voiceOnlyText); an approval request is
// answered in voice mode or at the computer, and a plain yes or no while one
// is open hears so too.
//
// An approval request that offers an approval grant (approval-grants.mjs) is
// also answered with "yes 20" (grantMinutesOf), as a Reply, with its code, or
// alone while it is the only one open: allowed, and then the grant made for
// those minutes, which the chat hears with its end. Every gate above holds
// for it as for a plain yes.
//
// push(request): hands the request to the controller (channel.mjs). say(text,
// replyTo): a message to the chat, as a reply to the driver's. held(): a
// sentence when the controller waits for the usage limit, else ''. mode: on,
// answers to questions; or off, where questions are answered by voice only.
// requests: whether any other message is a new request. confirm: whether
// push, merge, restart, delete and approvals count here. verdict(code,
// behavior): sends the driver's verdict on an approval request to Claude
// Code (channel.mjs); without it, approvals are not answered here.
// record(entry): what it made of the message, for the input log
// (TelegramInputLog). grants: the approval grants, for "yes 20".
// pressed(id, text): answers a press of a button (press).
export class TelegramAnswers {
  constructor({
    store,
    ledger = null,
    push,
    say,
    mode = 'on',
    requests = false,
    confirm = true,
    verdict = null,
    killswitch = null,
    presence = null,
    held = () => '',
    record = () => {},
    grants = null,
    pressed = () => {},
    log = defaultLog,
  }) {
    this.store = store
    this.ledger = ledger
    this.grants = grants
    this.pressed = pressed
    this.push = push
    this.say = say
    this.mode = mode
    this.requests = requests
    this.confirm = confirm
    this.verdict = verdict
    this.killswitch = killswitch
    this.presence = presence
    this.held = held
    this.record = record
    this.log = log
  }

  // Whether the driver may answer this request's question here.
  accepts(request) {
    return this.mode !== 'off' && !this.voiceOnly(request)
  }

  // Whether the driver may answer approval requests here: with answers on,
  // push, merge, restart, delete and approvals counting here, and a way to
  // Claude Code.
  approves() {
    return this.mode !== 'off' && this.confirm && typeof this.verdict === 'function'
  }

  // The first decision of the request that takes the driver's voice, push,
  // merge, restart or delete, with confirm off; else null.
  voiceOnly(request) {
    if (this.confirm) return null
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

  // Whether the gateway's message with this id asks the driver something, a
  // question or an approval request: a Reply to it is an answer, whatever it
  // says (TelegramCommands).
  asks(id) {
    return this.sentMessage(id) !== null
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

  // An open question as the target of an answer; with mode off, why it
  // takes the voice.
  answering(question) {
    if (this.mode !== 'off') return { question }
    return {
      why:
        `${question.id} is a question, and questions are answered by voice only (VOICE_GW_TELEGRAM_ANSWERS=0). ` +
        `Answer it in voice mode and mention ${question.id}.`,
    }
  }

  // An approval request as the target of an answer, while Claude Code may
  // wait on it and the driver may answer it here; else why not. One the
  // gateway guessed answered at the computer is answered all the same: the
  // guess may be wrong, and Claude Code drops a verdict that comes too late.
  approving(permission) {
    const { code } = permission
    // A subagent's from the controller's hook is not shown at the computer.
    const where = permission.source === 'hook' ? 'in voice mode' : 'in voice mode or at the computer'
    if (!this.approves()) return { why: `approval request ${code} is answered ${where}; Telegram cannot approve.` }
    if (pending(permission)) return { permission }
    if (permission.withdrawn) return { why: `approval request ${code} is not open any more: the subagent that asked stopped waiting for it.` }
    const how = permission.status === 'allow' ? 'allowed' : 'denied'
    return { why: `approval request ${code} was ${how} already${permission.by === 'telegram' ? ' here' : ' in voice mode'}; nothing to do.` }
  }

  // A plain yes or no ({ behavior, all }, bareVerdict) without a Reply or a
  // code, with the approval requests open now: { permission, behavior } for
  // the only one; { permissions, behavior } for all of them with "yes to all"
  // or "no to all"; { why, text } that asks back which one is meant, with
  // several open, or with an open question shown here after the only one,
  // which the driver may be answering instead; { why } where Telegram cannot
  // approve. null with none open, where the message is what it was before (a
  // request, say), except that "yes to all" hears that none is open.
  bare({ behavior, all, minutes = null }) {
    const open = this.store.openPermissions().sort((a, b) => a.createdAt - b.createdAt)
    if (!open.length) return all ? { why: `no approval request is open now, so there is nothing to ${behavior}.` } : null
    if (!this.approves()) {
      return open.length === 1
        ? this.approving(open[0])
        : { why: `approval requests ${listed(open.map(p => p.code))} are answered in voice mode or at the computer; Telegram cannot approve.` }
    }
    if (all) return { permissions: open, behavior }
    if (open.length > 1) {
      const codes = listed(open.map(p => p.code))
      return {
        why: `${open.length} approval requests are open, ${codes}; asked which one is meant`,
        text:
          `${open.length} approval requests are open: ${listed(open.map(permissionBrief))}. Which one do you mean? ` +
          'Reply to its message with yes or no, or write its code with yes or no. "Yes to all" allows them all, ' +
          '"no to all" denies them all.',
      }
    }
    const [permission] = open
    const question = this.laterQuestion(permission)
    if (question) {
      return {
        why: `approval request ${permission.code} and question ${question.id}, shown here after it, are both open; asked which one is meant`,
        text:
          `Approval request ${permissionBrief(permission)} and question ${question.id} are both open. Which one do you mean? ` +
          `Reply to its message, or write its code with your answer.`,
      }
    }
    return minutes === null ? { permission, behavior } : { permission, behavior, minutes }
  }

  // The open question shown in this chat after the approval request, or
  // before it was shown here at all; the latest, or null. Telegram numbers the
  // messages of a chat in the order sent.
  laterQuestion(permission) {
    const after = Number.isInteger(permission.telegramMessage) ? permission.telegramMessage : -Infinity
    let latest = null
    let shown = after
    for (const request of this.store.requests.values()) {
      if (request.state !== 'question') continue
      const message = request.updates.findLast(update => update.state === 'question' && Number.isInteger(update.telegramMessage))?.telegramMessage
      if (message > shown) [latest, shown] = [request, message]
    }
    return latest
  }

  // What a message is: the { question } it answers, the { permission } it
  // approves or denies (with its behavior when it is a plain yes or no), the
  // { permissions } "yes to all" or "no to all" answers, { request: true } for
  // a new request, or { why } it is none of these.
  target(text, replyTo) {
    const sent = replyTo === null ? null : this.sentMessage(replyTo)
    if (sent?.permission) return this.approving(sent.permission)
    if (sent?.request) {
      const { request } = sent
      return request.state === 'question'
        ? this.answering(request)
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
    // And the code of an approval request, where the driver may answer it
    // here: one answered already is said, never a request.
    const named = this.approves() ? approvalCodesIn(text).map(code => this.store.getPermission(code)).filter(Boolean) : []
    const approvals = named.filter(pending)
    if (open.size + approvals.length > 1) {
      const codes = listed([...open.keys(), ...approvals.map(permission => permission.code)])
      return approvals.length
        ? { why: `it names ${open.size + approvals.length} open questions and approval requests, ${codes}. Answer each in a message of its own.` }
        : { why: `it names ${open.size} open questions, ${codes}. Answer each in a message of its own.` }
    }
    if (approvals.length === 1) return this.approving(approvals[0])
    if (open.size === 1) return this.answering([...open.values()][0])
    if (named.length) return this.approving(named[0])
    // A plain yes or no, without a Reply: the approval request open now.
    const bare = replyTo === null ? bareVerdict(text) : null
    const plain = bare ? this.bare(bare) : null
    if (plain) return plain
    // Anything else is a request of the driver's, where they allow it.
    if (this.requests) return text ? { request: true } : { why: 'it holds no text.' }
    if (closed.length) return { why: `${listed(closed)} ${closed.length === 1 ? 'has' : 'have'} no open question. ${this.openQuestions()}` }
    return {
      why:
        `${replyTo === null ? 'it is no Reply to a question' : 'the message it replies to holds no question'}, and it names no ` +
        `open question by its code. ${this.openQuestions()}`,
    }
  }

  // Whether and where a message goes: { question }, { permission, behavior },
  // { permissions, behavior }, { request: true }, or { why } not, with the
  // whole answer for the chat in text when it is not the usual "Not passed
  // on: <why>".
  // Why nothing from the chat counts now, or null: the kill switch is
  // locked, or the gateway inactive (a standby, no controller).
  closed() {
    if (this.killswitch?.locked) {
      return this.killswitch.byVoice
        ? 'the kill switch is locked. It is unlocked at the computer, or in voice mode with a PIN sent here.'
        : 'the kill switch is locked. It is unlocked only at the computer.'
    }
    const presence = this.presence?.state() ?? { active: true }
    return presence.active ? null : `this gateway is inactive, ${presence.why}.`
  }

  check(text, replyTo, { forwarded = false } = {}) {
    const closed = this.closed()
    if (closed) return { why: closed }
    if (forwarded) return { why: 'it is forwarded, so its words are not your own. Write what you want in a message of your own.' }
    const target = this.target(text, replyTo)
    if (target.permissions) return target
    if (target.permission) {
      // "yes 20", with its code or as a Reply: allowed, and the grant it offers.
      const { code } = target.permission
      const minutes = target.minutes ?? grantMinutesOf(text.replace(new RegExp(`(^|[^a-z])${code}(?![a-z])`, 'gi'), '$1 '))
      if (minutes !== null) return { permission: target.permission, behavior: 'allow', minutes }
      // A plain yes or no, as by voice; anything else leaves it open.
      const behavior = target.behavior ?? verdictOf(text)
      if (behavior) return { permission: target.permission, behavior }
      return { why: `approval request ${code} takes a plain yes or no. Reply to it with yes to allow it, or with no to deny it.` }
    }
    if (!target.question) return target
    const decision = this.voiceOnly(target.question)
    if (decision) {
      const id = target.question.id
      return { why: `${id} is a ${decision.kind} decision, which must be confirmed by voice`, text: voiceOnlyText(id, decision.kind, text) }
    }
    return target
  }

  // A message from the driver's chat ({ text, replyTo, messageId, quoted,
  // forwarded, seen }, from TelegramCommands): passed on as their answer, as
  // a new request or as their verdict on one approval request or on all that
  // are open, or not, and the chat hears which; the input log keeps it with
  // seen, who sent it where. Resolves with the request passed on, the
  // approval request answered (a list of them for "yes to all"), or null.
  // Never throws.
  async route({ text, replyTo = null, messageId = null, quoted = null, forwarded = false, seen = null }) {
    const said = String(text ?? '').trim()
    const record = entry => this.record({ ...(seen ?? { text: said }), ...entry })
    try {
      const result = this.check(said, replyTo, { forwarded })
      if (result.why) {
        this.log('telegram message not passed on:', result.why)
        record({ decision: 'refused', why: result.why })
        await this.say(result.text ?? `Not passed on: ${result.why}`, messageId)
        return null
      }
      if (result.permission) return await this.approve(result.permission, result.behavior, { messageId, record, minutes: result.minutes ?? null })
      if (result.permissions) return await this.approveAll(result.permissions, result.behavior, { messageId, record })
      if (result.request) {
        const request = await this.start(said, { messageId, quoted: replyTo === null ? null : quoted })
        record({ decision: 'accepted', as: 'request', request: request.id })
        return request
      }
      return await this.answer(result.question, said, { messageId, record })
    } catch (error) {
      this.log('telegram message failed:', error.message)
      record({ decision: 'refused', why: error.message })
      await Promise.resolve(this.say(`Not passed on: ${error.message}.`, messageId)).catch(() => {})
      return null
    }
  }

  // The driver's answer to a question, typed or pressed: to the controller as
  // "(Answer to <id>) <text>", a request of theirs with via="telegram", as
  // one by voice; the question counts as answered, its open decisions keep
  // the answer (gateway.mjs), and the chat hears it is passed on. messageId:
  // the message the controller's replies answer, the driver's own, or for a
  // press the question's. label: what they pressed, for the chat.
  async answer(question, said, { messageId = null, record = () => {}, label = null } = {}) {
    const request = this.store.createRequest(`(Answer to ${question.id}) ${said}`, { answers: question.id, via: 'telegram' })
    // The meta stays with it, for an event sent again after the usage limit.
    request.meta = { via: 'telegram' }
    if (messageId !== null) request.telegramMessage = messageId // the controller's replies answer it
    this.store.markAnswered(question, request.id)
    await this.push(request)
    this.log('telegram answer passed on', `id=${request.id}`, `answers=${question.id}`, ...(label === null ? [] : ['(button)']))
    record({ decision: 'accepted', as: 'answer', request: request.id, answers: question.id })
    const pressed = label === null ? '' : `: "${label}"`
    await this.say(`Passed on to the controller as your answer to ${question.id}${pressed}.${this.heldText()}`, messageId)
    return request
  }

  // A press of a button under a question (questionButtons; "ques:<id>:<n>"
  // in data, matched): the question's own label n goes as that label typed
  // as a Reply to it would, through the same gates: nothing while the kill
  // switch is locked or the gateway inactive, nothing with answers off or for
  // a push, merge, restart or delete decision with VOICE_GW_TELEGRAM_CONFIRM=0,
  // nothing for a question not open any more, or for a message that is not
  // one of its own. Resolves with the answer's request, or null.
  async pressQuestion([, id, n], { messageId, record, notice, refuse }) {
    const closed = this.closed()
    if (closed) return refuse(closed)
    const question = this.store.getRequest(id)
    const update = messageId === null ? null : question?.updates.find(u => u.state === 'question' && u.telegramMessage === messageId)
    if (!update) return refuse(`question ${id} is not open any more.`)
    if (update.outcome || !questionOpen(question, this.ledger, update)) {
      return refuse(questionGone(question, { store: this.store, ledger: this.ledger }, update.at))
    }
    const target = this.answering(question)
    if (target.why) return refuse(target.why)
    const decision = this.voiceOnly(question)
    if (decision) return refuse(`${id} is a ${decision.kind} decision, which must be confirmed by voice. Say it in voice mode and mention ${id}.`)
    const label = questionLabels(update)[Number(n)]
    if (!label) return refuse(`that button is none of question ${id}'s.`)
    const request = await this.answer(question, label, { messageId, record: entry => record({ text: `(button ${preview(label, 40)})`, ...entry }), label })
    await notice(`Passed on as your answer: ${preview(label, 60)}`)
    return request
  }

  // A press of a button under an approval request ({ id, data, messageId,
  // seen }, from TelegramCommands, which let only the driver's own through):
  // the code in its data names the approval, and nothing else in it counts.
  // One under a question goes to pressQuestion.
  // It goes as a typed answer goes: nothing while the kill switch is locked or
  // the gateway inactive, nothing where approvals take the voice
  // (VOICE_GW_TELEGRAM_CONFIRM=0, answers off), nothing for one that is not
  // open any more; the verdict to Claude Code as approve sends it, the same
  // message in the chat, and "yes to all" lists what it allowed. The press
  // itself hears a short notice (pressed), and the buttons give way to the
  // outcome (TelegramFallback.keyboards). Resolves as route does. Never
  // throws.
  async press({ id, data, messageId = null, seen = null }) {
    const record = entry => this.record({ ...(seen ?? { text: `(button ${preview(String(data ?? ''), 40)})` }), ...entry })
    const notice = text => Promise.resolve(this.pressed(id, text)).catch(error => this.log('telegram press not answered:', error.message))
    const refuse = async why => {
      this.log('telegram button not passed on:', why)
      record({ decision: 'refused', why })
      await notice(`Not done: ${why}`)
      return null
    }
    const asked = QUESTION_PRESS.exec(String(data ?? ''))
    if (asked) {
      try {
        return await this.pressQuestion(asked, { messageId, record, notice, refuse })
      } catch (error) {
        return refuse(`${error.message}.`)
      }
    }
    const match = PRESS.exec(String(data ?? ''))
    if (!match) {
      // An outcome's line, or a button this gateway did not make.
      record({ decision: 'ignored', why: 'a button that answers nothing' })
      await notice('')
      return null
    }
    const [, code, what] = match
    try {
      const closed = this.closed()
      if (closed) return await refuse(closed)
      const permission = this.store.getPermission(code)
      if (!permission) return await refuse(`approval request ${code} is not open any more.`)
      const target = this.approving(permission)
      if (target.why) {
        // Answered elsewhere: not open any more, and how it went.
        const why = this.approves() && !permission.withdrawn ? `approval request ${code} is not open any more: ${target.why.replace(/^approval request \w+ /, 'it ')}` : target.why
        return await refuse(why)
      }
      if (what === 'all') {
        const open = this.store.openPermissions().sort((a, b) => a.createdAt - b.createdAt)
        const answered = await this.approveAll(open.length ? open : [permission], 'allow', { messageId, record })
        await notice(`Allowed ${answered.length} approval request${answered.length === 1 ? '' : 's'}.`)
        return answered
      }
      if (what === 'grant' && !permission.offer) return await refuse(`approval request ${code} offers no grant; press Yes or No.`)
      const behavior = what === 'no' ? 'deny' : 'allow'
      const minutes = what === 'grant' ? permission.offer.minutes : null
      const answered = await this.approve(permission, behavior, { messageId, record, minutes })
      await notice(behavior === 'deny' ? 'Denied.' : minutes ? `Allowed, and all such for ${minutes} minutes.` : 'Allowed.')
      return answered
    } catch (error) {
      return refuse(`${error.message}.`)
    }
  }

  // A new request of the driver's, as one by voice: to the controller with
  // via="telegram". quoted: the gateway's message it replies to, as context
  // after the driver's own words, which alone count (driverText). One the
  // channel did not take is gone again, so that its words count for nothing.
  async start(said, { messageId = null, quoted = null } = {}) {
    const request = this.store.createRequest(quoted ? `${said}\n\n${quoteText(quoted)}` : said, { via: 'telegram' })
    if (quoted) request.driverText = said
    request.meta = { via: 'telegram' }
    if (messageId !== null) request.telegramMessage = messageId // the controller's replies answer it
    try {
      await this.push(request)
    } catch (error) {
      this.store.requests.delete(request.id)
      this.store.changed()
      throw error
    }
    this.log('telegram request passed on', `id=${request.id}`, preview(said))
    await this.say(`Passed on to the controller as request ${request.id}.${this.heldText()}`, messageId)
    return request
  }

  // The driver's verdict on an approval request, as by voice (voice.mjs,
  // approve): claimed in the store first, so that an answer elsewhere finds
  // it answered, then sent to Claude Code. One that does not reach Claude
  // Code is open again, to be answered elsewhere. For one the gateway guessed
  // answered at the computer, the chat hears that such an answer stands.
  // minutes: with "yes 20", the approval grant it offers, made after the
  // verdict reached Claude Code (approval-grants.mjs).
  async approve(permission, behavior, { messageId = null, record = () => {}, minutes = null } = {}) {
    const { code, toolName, status, resolvedAt } = permission
    this.store.resolvePermission(code, behavior, 'telegram')
    try {
      await this.verdict(code, behavior)
    } catch (error) {
      Object.assign(permission, { status, resolvedAt, by: undefined })
      this.store.changed()
      throw error
    }
    this.log('telegram approval', `code=${code}`, `behavior=${behavior}`, `tool=${toolName}`)
    const made = minutes !== null && behavior === 'allow' ? (this.grants?.fromApproval(permission, minutes, 'telegram') ?? { why: 'approval grants are off' }) : null
    record({
      decision: 'accepted',
      as: behavior === 'allow' ? (made?.grant ? `approval allowed, grant ${made.grant.id}` : 'approval allowed') : 'approval denied',
      answers: code,
    })
    const guessed = status === 'elsewhere' ? ' It looked answered at the computer already; if it was, that answer stands.' : ''
    const grant = made?.grant
      ? `\nAnd granted ${made.grant.id}: all ${made.grant.label}, until ${clock(made.grant.until)}; they no longer ask until then. ` +
        'Send "revoke" or "Freigaben zurücknehmen" to end it.'
      : made ? `\nNo grant: ${made.why}.` : ''
    await this.say(
      behavior === 'allow'
        ? `Allowed: approval request ${permissionBrief(permission)}. Claude Code goes on.${guessed}${grant}`
        : `Denied: approval request ${permissionBrief(permission)}. Claude Code does not run it.${guessed}`,
      messageId,
    )
    return permission
  }

  // "Yes to all" or "no to all": the driver's verdict on every approval
  // request open now, each claimed and sent as approve does, then one message
  // that lists what it allowed or denied. One that does not reach Claude Code
  // is open again, and listed as still open; when none does, that is said as
  // for a single one.
  async approveAll(permissions, behavior, { messageId = null, record = () => {} } = {}) {
    // All claimed at once, so that an answer elsewhere meanwhile finds them answered.
    const claimed = permissions.filter(permission => this.store.resolvePermission(permission.code, behavior, 'telegram'))
    const answered = []
    const failed = []
    let failure = null
    for (const permission of claimed) {
      try {
        await this.verdict(permission.code, behavior)
        answered.push(permission)
        this.log('telegram approval', `code=${permission.code}`, `behavior=${behavior}`, `tool=${permission.toolName}`, '(to all)')
      } catch (error) {
        Object.assign(permission, { status: 'open', resolvedAt: undefined, by: undefined })
        failed.push(permission)
        failure ??= error
      }
    }
    if (failed.length) this.store.changed()
    if (!answered.length) throw failure ?? new Error('the approval requests were answered elsewhere meanwhile')
    const codes = answered.map(permission => permission.code).join(',')
    record({ decision: 'accepted', as: behavior === 'allow' ? 'approvals allowed' : 'approvals denied', answers: codes })
    const count = n => `${n} approval request${n === 1 ? '' : 's'}`
    const list = items => items.map(permission => `- ${permissionBrief(permission)}`)
    const lines = [
      `${behavior === 'allow' ? 'Allowed' : 'Denied'} ${count(answered.length)}:`,
      ...list(answered),
      behavior === 'allow' ? 'Claude Code goes on.' : `Claude Code does not run ${answered.length === 1 ? 'it' : 'them'}.`,
    ]
    if (failed.length) lines.push('', `Still open, as Claude Code was not reached (${failure.message}):`, ...list(failed))
    await this.say(lines.join('\n'), messageId)
    return answered
  }

  // The usage limit's sentence, when the controller waits for it.
  heldText() {
    const held = this.held()
    return held ? ` ${held}` : ''
  }
}
