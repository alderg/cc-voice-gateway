// Night mode: the gateway works on without the driver. It is on during the
// quiet hours (VOICE_GW_QUIET_HOURS=23:00-07:30, in the computer's time), and
// when the driver says so ("good night" by voice through the controller's
// set_away, /night or "good night" on Telegram), until the end of the quiet
// hours, or for AWAY_HOURS without them. "I'm back" (/back) ends it, also
// within the quiet hours, for the rest of them.
//
// While it is on (workers.mjs, gateway.mjs): worker runs decide what the
// concept, the task or sensible defaults allow, conservatively, note each
// such choice as an assumption, and skip what really needs the driver as a
// deferred question instead of ending with a question; questions and
// decisions that still come wait for the morning, holding only what they
// hold by day; Telegram carries alarms only (the kill switch, a standby, a
// wait for the usage limit, once each), no questions, approvals or news;
// no reminders. The night's results are noted here (record). When it ends:
// one summary, on Telegram and as an event to the controller, which tells
// the driver: what was done, the assumptions, the deferred questions, the
// decisions waiting. Kept in .state/night.json, so that a restart in the
// night keeps it, and a night that ended while the gateway was down still
// gets its summary.

import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { clock } from './limits.mjs'
import { log as defaultLog, preview } from './log.mjs'

export const AWAY_HOURS = 12 // "good night" without quiet hours lasts this long, unless "I'm back" comes first
const DAY = 24 * 60
const KEEP = 200 // results noted in one night, at most

// "23:00-07:30" as { start, end } in minutes after midnight, or null.
export function parseQuietHours(text) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text ?? '')
  if (!match) return null
  const [, h1, m1 = '0', h2, m2 = '0'] = match
  const start = Number(h1) * 60 + Number(m1)
  const end = Number(h2) * 60 + Number(m2)
  if (Number(h1) > 23 || Number(h2) > 24 || Number(m1) > 59 || Number(m2) > 59 || end > DAY || start === end % DAY) return null
  return { start, end: end % DAY }
}

const minutesOf = date => date.getHours() * 60 + date.getMinutes()

// The quiet window that `now` is in: { from, to } in ms, or null.
export function windowAt(hours, now) {
  if (!hours) return null
  const date = new Date(now)
  const minute = minutesOf(date)
  const at = (base, minutes, days = 0) => {
    const d = new Date(base)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + days)
    d.setMinutes(minutes)
    return d.getTime()
  }
  if (hours.start < hours.end) {
    return minute >= hours.start && minute < hours.end ? { from: at(now, hours.start), to: at(now, hours.end) } : null
  }
  // Over midnight: from the evening, or into the morning.
  if (minute >= hours.start) return { from: at(now, hours.start), to: at(now, hours.end, 1) }
  if (minute < hours.end) return { from: at(now, hours.start, -1), to: at(now, hours.end) }
  return null
}

// The end of the quiet window `now` is in, else of the next one.
export function nextEnd(hours, now) {
  const inside = windowAt(hours, now)
  if (inside) return inside.to
  const date = new Date(now)
  date.setSeconds(0, 0)
  for (let i = 0; i <= DAY; i += 1) {
    const window = windowAt(hours, date.getTime())
    if (window) return window.to
    date.setMinutes(date.getMinutes() + 1)
  }
  return null
}

// What a worker's report says under "Assumptions:" and "Deferred questions:",
// as the night's rule asks for: { assumptions, deferred }, the lines without
// their dashes, "none" left out.
export function sections(text) {
  const out = { assumptions: [], deferred: [] }
  let into = null
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    const heading = /^(?:#+\s*)?\**\s*(assumptions|deferred questions)\s*\**\s*:?\s*\**\s*(.*)$/i.exec(line)
    if (heading) {
      into = heading[1].toLowerCase() === 'assumptions' ? 'assumptions' : 'deferred'
      const rest = heading[2].replace(/^[-*]\s*/, '').trim()
      if (rest && !/^none\.?$/i.test(rest)) out[into].push(preview(rest, 300))
      continue
    }
    if (!into) continue
    const item = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      if (!/^none\.?$/i.test(item[1].trim())) out[into].push(preview(item[1].trim(), 300))
    } else if (line === '' || /^#|^\*\*/.test(line)) {
      into = null
    }
  }
  return out
}

export class Night extends EventEmitter {
  // hours: VOICE_GW_QUIET_HOURS as written, or empty; file: where its state
  // is kept, null in memory (tests).
  constructor({ hours = '', file = null, now = () => Date.now(), pollMs = 30000, log = defaultLog } = {}) {
    super()
    this.hours = parseQuietHours(hours)
    this.setting = String(hours ?? '').trim()
    this.file = file
    this.now = now
    this.pollMs = pollMs
    this.log = log
    // away: { since, by, until } after "good night"; back: when "I'm back" was
    // said, which ends the quiet window it was said in; night: the night going,
    // { since, by }, with its log of results and notes.
    this.state = { away: null, back: null, night: null, log: [] }
    this.timer = null
    this.load()
  }

  load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'))
      const at = value => (Number.isFinite(value) ? value : null)
      this.state = {
        away: saved.away && at(saved.away.since) ? { since: saved.away.since, by: String(saved.away.by ?? ''), until: at(saved.away.until) } : null,
        back: at(saved.back),
        night: saved.night && at(saved.night.since) ? { since: saved.night.since, by: String(saved.night.by ?? '') } : null,
        log: Array.isArray(saved.log) ? saved.log.filter(item => item && typeof item === 'object').slice(-KEEP) : [],
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('night mode file unreadable, starting without it:', error.message)
    }
  }

  save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('night mode not saved:', error.message)
    }
  }

  // Looks every pollMs whether the night began or ended; the first look at
  // once, so that a night that ended while the gateway was down gets its
  // summary now.
  start() {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
    this.timer.unref?.()
    return this
  }

  close() {
    clearInterval(this.timer)
  }

  // Whether night mode is on now.
  active(now = this.now()) {
    const away = this.state.away
    if (away && (away.until === null || now < away.until)) return true
    const window = windowAt(this.hours, now)
    return Boolean(window && !(this.state.back && this.state.back >= window.from))
  }

  // Until when it is on, in ms, or null when only "I'm back" ends it.
  until(now = this.now()) {
    const away = this.state.away && (this.state.away.until === null || now < this.state.away.until) ? this.state.away : null
    const window = windowAt(this.hours, now)
    const quiet = window && !(this.state.back && this.state.back >= window.from) ? window.to : null
    if (away) return away.until === null ? null : Math.max(away.until, quiet ?? 0)
    return quiet
  }

  // Night mode in a sentence, for status, open_items and the answers; '' when off.
  text(now = this.now()) {
    if (!this.active(now)) return ''
    const until = this.until(now)
    const why = this.state.away && (this.state.away.until === null || now < this.state.away.until) ? `since ${clock(this.state.away.since, now)}, as the driver said` : 'in the quiet hours'
    return (
      `night mode is on ${why}, ${until ? `until ${clock(until, now)}` : 'until the driver says they are back'}: workers decide what they ` +
      'can, conservatively, note assumptions and defer what needs the driver; questions and decisions wait for the morning, ' +
      'and Telegram carries alarms only'
    )
  }

  // "Good night": on now, until the end of the quiet hours, or AWAY_HOURS.
  // by: voice, telegram. Returns whether it changed.
  away(by = 'voice') {
    const now = this.now()
    const was = this.active(now)
    const until = this.hours ? nextEnd(this.hours, now) : now + AWAY_HOURS * 60 * 60 * 1000
    this.state.away = { since: now, by, until }
    this.state.back = null
    this.save()
    this.log(`night mode on, by ${by}, until ${new Date(until).toISOString()}`)
    this.tick()
    return !was
  }

  // "I'm back": off now, also for the rest of the quiet hours; the morning
  // summary follows (tick). Returns whether it changed.
  back(by = 'voice') {
    const now = this.now()
    const was = this.active(now)
    this.state.away = null
    this.state.back = now
    this.save()
    if (was) this.log(`night mode off, by ${by}`)
    this.tick({ by })
    return was
  }

  // The night began or ended: 'night' ({ since, until, by }) and 'morning'
  // ({ since, until, by, log }), once each.
  tick({ by = null } = {}) {
    const now = this.now()
    const on = this.active(now)
    if (on && !this.state.night) {
      this.state.night = { since: now, by: this.state.away?.by ?? 'quiet hours' }
      this.state.log = []
      this.save()
      this.emit('night', { since: now, until: this.until(now), by: this.state.night.by })
    } else if (!on && this.state.night) {
      const night = { since: this.state.night.since, until: now, by: by ?? (this.state.away ? 'its time' : 'the end of the quiet hours'), log: this.state.log }
      this.state.night = null
      this.state.log = []
      if (this.state.away && this.state.away.until !== null && now >= this.state.away.until) this.state.away = null
      this.save()
      this.emit('morning', night)
    }
  }

  // A run's result in the night, for the summary: { repo, task, outcome,
  // pulls, result }; its assumptions and deferred questions come from the
  // worker's report (sections).
  record({ repo, task, outcome, pulls = [], result = '', at = this.now() }) {
    if (!this.state.night) return
    const { assumptions, deferred } = sections(result)
    this.state.log = [...this.state.log, { at, kind: 'run', repo, task, outcome, pulls, assumptions, deferred }].slice(-KEEP)
    this.save()
  }

  // Something else worth the summary, in a sentence: a wait for the usage limit, say.
  note(text, at = this.now()) {
    if (!this.state.night) return
    this.state.log = [...this.state.log, { at, kind: 'note', text: preview(text, 300) }].slice(-KEEP)
    this.save()
  }
}

// The morning summary, for Telegram and the controller: what was done, the
// assumptions, the deferred questions, the decisions waiting. decisions:
// lines of the open decisions (ledger.mjs).
export function morningText(night, decisions = [], now = Date.now()) {
  const runs = night.log.filter(item => item.kind === 'run')
  const notes = night.log.filter(item => item.kind === 'note')
  const lines = [`Night mode from ${clock(night.since, now)} to ${clock(night.until, now)}.`]
  if (runs.length) {
    const outcome = run =>
      `${run.repo} ${run.task} ${run.outcome}${run.pulls?.length ? ` (pull request ${run.pulls.join(', ')})` : ''}`
    lines.push(`Done: ${runs.length === 1 ? '1 run' : `${runs.length} runs`}: ${runs.map(outcome).join('; ')}.`)
  } else {
    lines.push('No worker run ended in the night.')
  }
  const assumptions = runs.flatMap(run => run.assumptions.map(text => `${run.repo} ${run.task}: ${text}`))
  const deferred = runs.flatMap(run => run.deferred.map(text => `${run.repo} ${run.task}: ${text}`))
  lines.push(assumptions.length ? `Assumptions made:\n${assumptions.map(text => `- ${text}`).join('\n')}` : 'Assumptions made: none noted.')
  lines.push(deferred.length ? `Deferred questions:\n${deferred.map(text => `- ${text}`).join('\n')}` : 'Deferred questions: none.')
  lines.push(decisions.length ? `Decisions waiting:\n${decisions.map(text => `- ${text}`).join('\n')}` : 'Decisions waiting: none.')
  if (notes.length) lines.push(`Also: ${notes.map(item => `${clock(item.at, now)} ${item.text}`).join('; ')}.`)
  return lines.join('\n')
}

// What a worker run reads in the night (workers.mjs, runLines).
export const NIGHT_RULE =
  '- Night mode: the driver is away until the morning and cannot answer. Decide what the concept, the task or sensible ' +
  'defaults allow, choosing the conservative option, and note each such choice as an assumption. When something ' +
  'really needs the driver, skip that part, note it as a deferred question, and carry on with the rest; do not end ' +
  'the run with a question. End your report with a section "Assumptions:" and a section "Deferred questions:", one ' +
  'line each starting with "- " ("- none" if there are none), and put the assumptions into the pull request ' +
  'description as well.'
