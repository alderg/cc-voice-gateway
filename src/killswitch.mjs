// The kill switch: deterministic code in the gateway, not instructions to the
// controller. Once tripped, the gateway takes no new tasks, every worker
// stops, the worker container stops and gets the repositories only read-only
// from then on, and an alarm goes to Telegram at once and to every voice chat
// at its next call (see gateway.mjs for the effects).
//
// Triggers: an emergency phrase by voice ("emergency stop") or the emergency_stop
// voice tool, /stop from the configured Telegram chat, the fixed rules on the
// workers' runs (guard.mjs), and the controller's raise_alarm tool.
//
// The state lives in .secrets/killswitch.json: the controller's confine hook
// keeps it from .secrets, and the container only gets .secrets/worker, read
// only. It survives restarts; a file that cannot be read counts as locked.
// Unlocking with scripts/unlock.mjs on the server, through the admin socket,
// always; or by the driver in voice mode, with a PIN that goes to their
// Telegram chat (VoiceUnlock, below), until three wrong ones block that for
// the lock. There is no way to unlock by Telegram or the controller.
//
// What locks it is a setting (VOICE_GW_KILLSWITCH, MODES): auto, the
// default, every trigger; manual, only those of people (voice, Telegram, the
// controller), while the rules only log what they would have done; off,
// none, and each trigger is logged. A lock from before stays until it is
// unlocked, whatever the setting.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { KILLSWITCH_MODES as MODES } from './config.mjs'
import { log as defaultLog, preview } from './log.mjs'

export const TRIGGERS = ['voice', 'telegram', 'rule', 'controller']

// Lower case, without accents, punctuation as spaces.
const normalize = text =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// English only. In another language Claude's voice mode calls the
// emergency_stop tool instead, as its instructions say.
const PHRASES = [/\bemergency ?stop\b/, /\bkill ?switch\b/]

// An emergency stop when the message opens with one of the phrases, or is
// short (at most six words) and contains one. A longer sentence that merely
// mentions it ("what does the emergency stop in this project do?") does not
// count.
export function emergencyPhrase(text) {
  const words = normalize(text)
  if (!words) return false
  return PHRASES.some(phrase => {
    const match = phrase.exec(words)
    return match && (match.index === 0 || words.split(' ').length <= 6)
  })
}

export class KillSwitch extends EventEmitter {
  constructor({ file, mode = 'auto', log = defaultLog }) {
    super()
    this.file = file
    this.mode = MODES.includes(mode) ? mode : 'auto' // anything else: as safe as it gets
    this.log = log
    this.state = this.load()
    this.voice = null // the unlock in voice mode, when the gateway offers it (VoiceUnlock)
  }

  get locked() {
    return this.state !== null
  }

  // Whether the driver can unlock this lock in voice mode, with a PIN from
  // Telegram: for the alarm's texts.
  get byVoice() {
    return Boolean(this.state && this.voice?.open(this.state))
  }

  // Whether a trigger locks it at this setting.
  locks(trigger) {
    return this.mode === 'auto' || (this.mode === 'manual' && trigger !== 'rule')
  }

  load() {
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      return this.unreadable(error.message)
    }
    try {
      const state = JSON.parse(text)
      if (!state || typeof state.trigger !== 'string') throw new Error('no trigger')
      return { ...state, events: Array.isArray(state.events) ? state.events : [] }
    } catch (error) {
      return this.unreadable(error.message)
    }
  }

  // Fails closed: a damaged file still means locked.
  unreadable(why) {
    const at = new Date().toISOString()
    this.log('kill switch file unreadable, staying locked:', why)
    return { id: 'unreadable', trigger: 'rule', reason: `the kill switch file is unreadable (${why})`, at, events: [] }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('kill switch state not saved (still locked in this gateway):', error.message)
    }
  }

  // Locks, or adds another trigger to the lock. Returns the state; null when
  // the setting keeps this trigger from locking, which is only logged.
  trip({ trigger, reason }) {
    const event = { trigger, reason: preview(String(reason || 'no reason given'), 300), at: new Date().toISOString() }
    if (!this.locks(trigger)) {
      this.log(`kill switch not locked, VOICE_GW_KILLSWITCH=${this.mode}; ${trigger} would have locked it: ${event.reason}`)
      this.emit('ignored', event)
      return null
    }
    const first = !this.state
    if (first) this.state = { id: randomBytes(4).toString('hex'), ...event, events: [] }
    this.state.events = [...this.state.events, event].slice(-50)
    this.save()
    this.log(`KILL SWITCH ${first ? 'tripped' : 'tripped again'} by ${trigger}: ${event.reason}`)
    this.emit('tripped', this.state, event, first)
    return this.state
  }

  // A wrong PIN in voice mode (VoiceUnlock), counted with the lock and saved
  // with it, so that a restart does not reset the count. Returns the count.
  wrongPin() {
    if (!this.state) return 0
    this.state.wrongPins = (this.state.wrongPins ?? 0) + 1
    this.save()
    return this.state.wrongPins
  }

  // Through the admin socket (scripts/unlock.mjs), or by the driver in voice
  // mode with the PIN (VoiceUnlock).
  unlock({ by }) {
    const was = this.state
    if (!was) return null
    this.state = null
    try {
      rmSync(this.file, { force: true })
    } catch (error) {
      this.log('kill switch file not removed:', error.message)
    }
    this.log(`kill switch unlocked by ${by}; it was locked since ${was.at} by ${was.trigger}`)
    this.emit('unlocked', was, by)
    return was
  }
}

const clock = iso => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

// For a trigger of a person that did not lock it: the switch is off.
export const offText = () =>
  'The kill switch is turned off in the settings (VOICE_GW_KILLSWITCH=off), so nothing was locked and the workers ' +
  'go on; it can be turned on again only at the computer.'

// One sentence or two for whoever hears or reads it. voice: whether the
// driver can unlock it in voice mode (KillSwitch.byVoice).
export function alarmText(state, { short = false, voice = false } = {}) {
  const head = `Kill switch locked since ${clock(state.at)}, by ${state.trigger}: ${state.reason}.`
  if (short) return head
  return (
    `${head} The gateway takes no new tasks, and the workers were stopped. ` +
    (voice
      ? 'It is unlocked at the server, with scripts/unlock.mjs, or in voice mode with a PIN sent to Telegram.'
      : 'Only someone at the server can unlock it, with scripts/unlock.mjs.')
  )
}

// --- the unlock in voice mode ---------------------------------------------------------

// The PIN: four digits, valid five minutes; three wrong ones per lock, across
// PINs, block the unlock in voice mode for that lock.
export const PIN_DIGITS = 4
export const PIN_MINUTES = 5
export const PIN_TRIES = 3

const digest = (salt, pin) => createHash('sha256').update(salt).update(pin).digest()

// Digits in a row, also with spaces, dots or dashes between them ("4 7 1 9").
const DIGIT_RUNS = /\d(?:[\s.-]?\d)*/g

const tries = n => `${n} ${n === 1 ? 'try' : 'tries'}`

// The driver's unlock in voice mode, the one way besides scripts/unlock.mjs,
// so that nobody has to reach the server from the car: the voice connector's
// tool unlock (voice.mjs) asks for a PIN (request), which goes to the
// driver's own Telegram chat and nowhere else, and takes it back as they read
// it out (attempt). Only that tool: the controller has no tool for it,
// Telegram no command, and a PIN typed there is masked and not passed on
// (masked, TelegramCommands). Not in a standby (paused), and not for a kill
// switch file that cannot be read.
//
// The PIN is random (crypto), one at a time: a new one replaces the one
// before, and the lock tripped again or unlocked voids it. It lives in this
// gateway's memory only, as a salted hash compared in constant time: never in
// a file, a log line, a tool's result or an event for the controller, and the
// message that carries it is never quoted to the controller (Telegram.send,
// quote). A restart forgets it; the driver asks for a new one. The wrong ones
// are counted with the lock in its file (KillSwitch.wrongPin), so that a
// restart does not reset them; after PIN_TRIES only scripts/unlock.mjs
// unlocks it, and the chat hears so.
//
// send(text): a message to the driver's own private chat with the bot, never
// quoted; null without Telegram, or with a chat that is no person's. host: the
// gateway's computer, in its notices. stopped: what stays stopped after an
// unlock, for the notice (the containers, as scripts/unlock.mjs says it).
export class VoiceUnlock {
  constructor({ killswitch, send = null, paused = () => false, host = '', stopped = [], log = defaultLog, now = Date.now }) {
    this.killswitch = killswitch
    this.send = send
    this.paused = paused
    this.host = host
    this.stopped = stopped
    this.log = log
    this.now = now
    this.pin = null // { lock, salt, hash, until }
    killswitch.voice = this
    // A new trigger has a reason of its own, which the driver hears with a new PIN.
    killswitch.on('tripped', () => (this.pin = null))
    killswitch.on('unlocked', () => (this.pin = null))
  }

  // Whether the driver could unlock this lock in voice mode: Telegram for the
  // PIN, a file that could be read, and fewer than PIN_TRIES wrong ones.
  open(state) {
    return Boolean(this.send) && state.id !== 'unreadable' && (state.wrongPins ?? 0) < PIN_TRIES
  }

  // Why not now, as { status }, or null: not-locked, standby, no-telegram,
  // unreadable, blocked.
  refused() {
    const state = this.killswitch.state
    if (!state) return { status: 'not-locked' }
    if (this.paused()) return { status: 'standby' }
    if (!this.send) return { status: 'no-telegram' }
    if (state.id === 'unreadable') return { status: 'unreadable' }
    if ((state.wrongPins ?? 0) >= PIN_TRIES) return { status: 'blocked' }
    return null
  }

  // A new PIN to the driver's chat, in German or English. Resolves with
  // { status: 'sent', state, minutes }, or why not; never with the PIN.
  async request({ german = false } = {}) {
    const refused = this.refused()
    if (refused) return refused
    const state = this.killswitch.state
    const pin = String(randomInt(10 ** PIN_DIGITS)).padStart(PIN_DIGITS, '0')
    const salt = randomBytes(16)
    const issued = { lock: state.id, salt, hash: digest(salt, pin), until: this.now() + PIN_MINUTES * 60000 }
    this.pin = issued
    // Digit by digit, so that CarPlay reads it out as digits.
    const spoken = [...pin].join(' ')
    try {
      await this.send(
        german ? `Entsperr-PIN ${spoken}, gültig ${PIN_MINUTES} Minuten` : `Unlock PIN ${spoken}, valid ${PIN_MINUTES} minutes`,
      )
    } catch (error) {
      if (this.pin === issued) this.pin = null
      this.log('kill switch: the unlock PIN was not sent by Telegram, so none is valid:', error.message)
      return { status: 'unsent', why: error.message }
    }
    this.log(
      `kill switch: an unlock PIN for voice mode went to the driver's Telegram chat, valid ${PIN_MINUTES} minutes; ` +
        `${tries(PIN_TRIES - (state.wrongPins ?? 0))} left for this lock`,
    )
    return { status: 'sent', state, minutes: PIN_MINUTES }
  }

  // The PIN the driver read out: its digits, whatever came along ("4 7 1 9").
  // { status: 'unlocked', was }, or why not: invalid (not four digits),
  // no-pin (none for this lock), expired, wrong (with left), blocked (with
  // now when this one blocked it). Only a wrong PIN counts as a try.
  attempt(said) {
    const refused = this.refused()
    if (refused) return refused
    const digits = String(said ?? '').replace(/\D/g, '')
    if (digits.length !== PIN_DIGITS) return { status: 'invalid' }
    const state = this.killswitch.state
    const pin = this.pin?.lock === state.id ? this.pin : null
    if (!pin) {
      this.log('kill switch: a PIN in voice mode, but none is valid for this lock')
      return { status: 'no-pin' }
    }
    if (this.now() > pin.until) {
      this.pin = null
      this.log(`kill switch: a PIN in voice mode after the ${PIN_MINUTES} minutes of the last one`)
      return { status: 'expired' }
    }
    if (!timingSafeEqual(digest(pin.salt, digits), pin.hash)) {
      const left = PIN_TRIES - this.killswitch.wrongPin()
      if (left > 0) {
        this.log(`kill switch: a wrong PIN in voice mode; ${tries(left)} left for this lock`)
        return { status: 'wrong', left }
      }
      this.pin = null
      this.log(`kill switch: ${PIN_TRIES} wrong PINs in voice mode; for this lock only scripts/unlock.mjs unlocks it now`)
      this.tell(
        `${PIN_TRIES} wrong PINs in voice mode, so unlocking by voice is blocked for this lock. Unlock at the server: ` +
          'node scripts/unlock.mjs',
      )
      return { status: 'blocked', now: true }
    }
    this.pin = null
    const was = this.killswitch.unlock({ by: 'the driver in voice mode, with a PIN from Telegram' })
    this.tell(
      `kill switch unlocked in voice mode, with the PIN sent here. It was locked since ${clock(was.at)}, by ` +
        `${was.trigger}: ${was.reason}. The gateway takes tasks again.${this.stopped.map(line => ` ${line}`).join('')}`,
    )
    return { status: 'unlocked', was }
  }

  // The text with the valid PIN masked wherever it holds it, as digits in a
  // row or with spaces, dots or dashes between them; the same text without
  // it. For what the driver writes on Telegram, where the PIN counts for
  // nothing and must reach neither a log nor the controller (TelegramCommands).
  masked(text) {
    const pin = this.pin
    if (!pin || typeof text !== 'string') return text
    return text.replace(DIGIT_RUNS, run => {
      const digits = run.replace(/\D/g, '')
      for (let i = 0; i + PIN_DIGITS <= digits.length; i++) {
        if (timingSafeEqual(digest(pin.salt, digits.slice(i, i + PIN_DIGITS)), pin.hash)) return '*'.repeat(PIN_DIGITS)
      }
      return run
    })
  }

  // A notice to the driver's chat, on its way at once; one that fails is
  // only logged.
  tell(text) {
    const failed = error => this.log('kill switch notice not sent by Telegram:', error.message)
    try {
      Promise.resolve(this.send(`cc-voice-gateway on ${this.host}: ${text}`)).catch(failed)
    } catch (error) {
      failed(error)
    }
  }
}
