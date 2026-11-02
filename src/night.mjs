// Night mode: the gateway works on without the driver. It is on during the
// quiet hours (VOICE_GW_QUIET_HOURS=23:00-07:30, in the computer's time), and
// when the driver says so ("good night" by voice through the controller's
// set_away, /night or "good night" on Telegram), until the end of the quiet
// hours, or for AWAY_HOURS without them, or until the end the driver named
// ("until tomorrow morning at 9": set_away's until, /night 09:00; parseUntil),
// at most MAX_AWAY_HOURS ahead. A named end is the end: later than the quiet
// hours it holds past them, and within them it ends them then, as "I'm back"
// would. "I'm back" (/back) ends it, also within the quiet hours, for the rest
// of them.
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
export const MAX_AWAY_HOURS = 48 // an end the driver names lies at most this far ahead
const DAY = 24 * 60
const HOUR_MS = 60 * 60 * 1000
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

// An end the driver named for night mode: a clock time in the computer's
// time zone, as the quiet hours are ("09:00", "9", "9.30"), the next time it
// comes; or a date and time ("2026-11-03T09:00", also with a space, seconds,
// and Z or an offset such as +01:00; without, in the computer's time). Gives
// { at } in ms, in the future and at most MAX_AWAY_HOURS ahead, else { error }
// in a sentence.
export function parseUntil(text, now = Date.now()) {
  const value = String(text ?? '').trim()
  const named = `"${preview(value, 40)}"`
  let at = null
  const time = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(value)
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(value)
  if (time) {
    const [hours, minutes] = [Number(time[1]), Number(time[2] ?? 0)]
    if (hours <= 23 && minutes <= 59) {
      const date = new Date(now)
      date.setHours(hours, minutes, 0, 0)
      if (date.getTime() <= now) {
        date.setDate(date.getDate() + 1)
        date.setHours(hours, minutes, 0, 0)
      }
      at = date.getTime()
    }
  } else if (iso) {
    const [year, month, day, hours, minutes, seconds] = iso.slice(1, 7).map(part => Number(part ?? 0))
    const date = new Date(Date.UTC(year, month - 1, day))
    const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(iso[7] ?? '')
    const zone = !iso[7] || /^z$/i.test(iso[7]) || (offset && Number(offset[2]) <= 14 && Number(offset[3]) <= 59)
    if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hours <= 23 && minutes <= 59 && seconds <= 59 && zone) {
      if (!iso[7]) at = new Date(year, month - 1, day, hours, minutes, seconds).getTime()
      else {
        const shift = offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60000 : 0
        at = Date.UTC(year, month - 1, day, hours, minutes, seconds) - shift
      }
    }
  }
  if (at === null) return { error: `${named} is no time: name a clock time such as 09:00, or a date and time such as 2026-11-03T09:00.` }
  if (at <= now) return { error: `${named} has passed already: the end must lie in the future.` }
  if (at - now > MAX_AWAY_HOURS * HOUR_MS) {
    return { error: `${named} is more than ${MAX_AWAY_HOURS} hours ahead: night mode goes at most until ${clock(now + MAX_AWAY_HOURS * HOUR_MS, now)}.` }
  }
  return { at }
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
    // away: { since, by, until, named } after "good night", named when until
    // is the end the driver named; back: when "I'm back" was said, which ends
    // the quiet window it was said in; night: the night going, { since, by },
    // with its log of results and notes.
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
        away:
          saved.away && at(saved.away.since)
            ? { since: saved.away.since, by: String(saved.away.by ?? ''), until: at(saved.away.until), named: saved.away.named === true && at(saved.away.until) !== null }
            : null,
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

  // The driver's "good night" while it holds, else null.
  holding(now = this.now()) {
    const away = this.state.away
    return away && (away.until === null || now < away.until) ? away : null
  }

  // Whether the driver ended this quiet window before its time: "I'm back"
  // said in it, or an end they named that came within it (not at its start,
  // where the quiet hours carry on).
  ended(window, now = this.now()) {
    const { away, back } = this.state
    if (back && back >= window.from) return true
    return Boolean(away?.named && away.until > window.from && away.until <= now)
  }

  // Whether night mode is on now.
  active(now = this.now()) {
    if (this.holding(now)) return true
    const window = windowAt(this.hours, now)
    return Boolean(window && !this.ended(window, now))
  }

  // Until when it is on, in ms, or null when only "I'm back" ends it. Of a
  // "good night", the later of its end and the quiet window's; of an end the
  // driver named, that end, unless the quiet hours begin just then.
  until(now = this.now()) {
    const away = this.holding(now)
    if (away?.named) {
      const next = windowAt(this.hours, away.until)
      return next && next.from === away.until ? next.to : away.until
    }
    const window = windowAt(this.hours, now)
    const quiet = window && !this.ended(window, now) ? window.to : null
    if (away) return away.until === null ? null : Math.max(away.until, quiet ?? 0)
    return quiet
  }

  // Night mode in a sentence, for status, open_items and the answers; '' when off.
  text(now = this.now()) {
    if (!this.active(now)) return ''
    const until = this.until(now)
    const why = this.holding(now) ? `since ${clock(this.state.away.since, now)}, as the driver said` : 'in the quiet hours'
    return (
      `night mode is on ${why}, ${until ? `until ${clock(until, now)}` : 'until the driver says they are back'}: workers decide what they ` +
      'can, conservatively, note assumptions and defer what needs the driver; questions and decisions wait for the morning, ' +
      'and Telegram carries alarms only'
    )
  }

  // "Good night": on now, until the end of the quiet hours, or AWAY_HOURS;
  // with end, the end the driver named (in ms, from parseUntil), also to
  // extend or shorten a "good night" that holds, which keeps its beginning.
  // by: voice, telegram. Returns whether it changed.
  away(by = 'voice', end = null) {
    const now = this.now()
    const was = this.active(now)
    const named = Number.isFinite(end) && end > now
    const until = named ? end : this.hours ? nextEnd(this.hours, now) : now + AWAY_HOURS * HOUR_MS
    this.state.away = { since: this.holding(now)?.since ?? now, by, until, named }
    this.state.back = null
    this.save()
    this.log(`night mode on, by ${by}, until ${new Date(until).toISOString()}${named ? ', as the driver named it' : ''}`)
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
      const away = this.state.away
      if (away && away.until !== null && now >= away.until) {
        // A named end within the quiet hours ended them, as "I'm back" then
        // would have; so it stays.
        if (away.named && windowAt(this.hours, away.until)?.from < away.until) this.state.back = Math.max(this.state.back ?? 0, away.until)
        this.state.away = null
      }
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
