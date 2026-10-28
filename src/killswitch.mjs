// The kill switch: deterministic code in the gateway, not instructions to the
// controller. Once tripped, the gateway takes no new tasks, every worker
// stops, the worker container stops and gets the repositories only read-only
// from then on, and an alarm goes to Telegram at once and to every voice chat
// at its next call (see gateway.mjs for the effects).
//
// Triggers: an emergency phrase by voice ("Notstopp") or the emergency_stop
// voice tool, /stop from the configured Telegram chat, the fixed rules on the
// workers' runs (guard.mjs), and the controller's raise_alarm tool.
//
// The state lives in .secrets/killswitch.json: the controller's confine hook
// keeps it from .secrets, and the container only gets .secrets/worker, read
// only. It survives restarts; a file that cannot be read counts as locked.
// Unlocking only with scripts/unlock.mjs on the server, through the admin
// socket; there is no way to unlock by voice, Telegram or the controller.

import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

// "Stopp" with a double p is German, so "do not stop" never matches.
const PHRASES = [
  /\bnot ?stopp\b/,
  /\bnotstop\b/,
  /\bnot ?fall ?stopp?\b/,
  /\bnothalt\b/,
  /\bnot ?aus\b/,
  /\bemergency ?stop\b/,
  /\bkill ?switch\b/,
]

// An emergency stop when the message opens with one of the phrases, or is
// short (at most six words) and contains one. A longer sentence that merely
// mentions it ("what does the Notstopp do?") does not count.
export function emergencyPhrase(text) {
  const words = normalize(text)
  if (!words) return false
  return PHRASES.some(phrase => {
    const match = phrase.exec(words)
    return match && (match.index === 0 || words.split(' ').length <= 6)
  })
}

export class KillSwitch extends EventEmitter {
  constructor({ file, log = defaultLog }) {
    super()
    this.file = file
    this.log = log
    this.state = this.load()
  }

  get locked() {
    return this.state !== null
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

  // Locks, or adds another trigger to the lock. Returns the state.
  trip({ trigger, reason }) {
    const event = { trigger, reason: preview(String(reason || 'no reason given'), 300), at: new Date().toISOString() }
    const first = !this.state
    if (first) this.state = { id: randomBytes(4).toString('hex'), ...event, events: [] }
    this.state.events = [...this.state.events, event].slice(-50)
    this.save()
    this.log(`KILL SWITCH ${first ? 'tripped' : 'tripped again'} by ${trigger}: ${event.reason}`)
    this.emit('tripped', this.state, event, first)
    return this.state
  }

  // Only through the admin socket (scripts/unlock.mjs).
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

// One sentence or two for whoever hears or reads it.
export function alarmText(state, { short = false } = {}) {
  const head = `Kill switch locked since ${clock(state.at)}, by ${state.trigger}: ${state.reason}.`
  if (short) return head
  return (
    `${head} The gateway takes no new tasks, and the workers were stopped. ` +
    'Only someone at the server can unlock it, with scripts/unlock.mjs.'
  )
}
