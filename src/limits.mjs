// Claude usage limits: when the account's plan limit (the 5-hour or weekly
// limit, a per-model one, a spend cap) is reached, a run cannot go on until
// it resets; the gateway waits it out and goes on by itself.
//
// How Claude Code shows it, in a worker run's stream-json (claude -p) and in
// the controller session's transcript alike: an assistant message that wraps
// the API error, with error "rate_limit", api_error "usage_limit_reached" and
// api_error_params.rate_limit_info { status, resetsAt (Unix seconds),
// rateLimitType }, and the text "You've hit your 5-hour limit · resets 3pm
// (Europe/Zurich)"; a rate_limit_event with rate_limit_info.status
// "rejected"; and the run's result, is_error, with the same text. Older
// versions wrote "Claude AI usage limit reached|<Unix seconds>". A server
// that throttles or is overloaded ends a run with error "rate_limit" (without
// usage_limit_reached) or "overloaded", after Claude Code's own retries: that
// is a wait too, shorter, with the same backoff.
//
// Usage credits (once "extra usage", "overage" to the API) are no limit: with
// them, Claude Code goes on by itself once the plan's included usage is used
// up, in a headless run too, and bills the credits. Its rate_limit_event then
// still says status "rejected" for the plan's limit, but with overageStatus
// "allowed" (or "allowed_warning") and isUsingOverage true, as Claude Code
// reads the API's headers itself; the requests go through, and nothing waits
// (refused, onCredits). A real stop has the credits refused too: overageStatus
// "rejected" (their monthly spend limit, an empty balance) or none at all (no
// credits), or errorCode "credits_required"; then the turn ends with the API
// error above, "You've hit your monthly spend limit · … · your 5-hour limit
// resets 3pm" or "You're out of usage credits · resets 3pm", and the account
// waits as for the plan's limit, until the earlier of the plan's reset and
// the credits' (overageResetsAt), when Claude Code gives them.
//
// A wait belongs to an account: the workers on this computer ("host"), those
// in a container ("container:<name>", which has its own login), and the
// controller session ("controller"). Until it ends, no run starts on that
// account (workers.mjs), and while the controller waits, the gateway holds
// the events for it, which would only end as failed turns, and sends them
// once it answers again (gateway.mjs). The end: the reset time when Claude
// Code gives one, otherwise a backoff of 15, 30, then 60 minutes, counted
// from the last wait on that account that ended without a run getting
// through. Kept in .state/limits.json, so that a restart keeps waiting.
// Runs on usage credits are only noted, once in the log and in list_workers
// (Limits.credits), in memory.

import { EventEmitter } from 'node:events'
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { log as defaultLog, preview } from './log.mjs'

export const BACKOFF_MINUTES = [15, 30, 60]
const MIN_WAIT_MS = 60 * 1000 // a reset that is due already still waits this long
const MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000 // a weekly limit at most, and a little
const CREDITS_MS = 5 * 60 * 60 * 1000 // runs on usage credits are noted this long without a reset time
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// The texts Claude Code ends a turn with at the account's limit, the plan's
// or that of its usage credits; the result's text starts with one of them.
const USAGE_TEXT =
  /you'?(?:ve| have) (?:hit|reached) your [\w\s-]*limit|you'?re out of (?:usage credits|extra usage)|your org is out of usage|claude ai usage limit reached|usage limit reached/i
const USAGE_RESULT = /^(?:you'?(?:ve| have) (?:hit|reached) your|you'?re out of (?:usage credits|extra usage)|your org is out of usage|claude ai usage limit reached)/i

// The overage statuses with which usage credits pay.
const PAID = new Set(['allowed', 'allowed_warning'])

// Whether a rate_limit_info says the account's requests are refused: the
// plan's limit is reached (status "rejected"), and no usage credits pay for
// them, as none can (credits_required), they are refused too, or there are
// none. With credits paying (isUsingOverage, or overageStatus allowed), not.
export function refused(info) {
  if (info?.status !== 'rejected') return false
  if (info.errorCode === 'credits_required') return true
  return !(info.isUsingOverage === true || PAID.has(info.overageStatus))
}

// Whether a rate_limit_info says that usage credits pay for the account's
// requests: past the plan's limit with the credits allowed, or overage in use.
export function onCredits(info) {
  if (!info || typeof info !== 'object' || refused(info) || info.errorCode === 'credits_required') return false
  return info.isUsingOverage === true || info.overageInUse === true || (info.status === 'rejected' && PAID.has(info.overageStatus))
}

// When a refusal ends, in ms, or null if Claude Code gives no time: the
// plan's reset, or the credits' when their spend limit refused them and it
// comes first; not for an empty balance, which no date refills.
function resetOf(info) {
  const times = [info?.resetsAt]
  if (info?.overageStatus === 'rejected' && info.overageDisabledReason !== 'out_of_credits') times.push(info.overageResetsAt)
  const known = times.filter(Number.isFinite).map(seconds)
  return known.length ? Math.min(...known) : null
}

// A reset time in a limit's text: "resets 3pm", "resets 3:30pm (Europe/Zurich)",
// "resets Nov 1, 9am", "resets at 15:00", in the computer's time, which is
// Claude Code's too; the next such moment after now. null if none.
export function parseReset(text, now = Date.now()) {
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(text ?? '')
  if (legacy) return seconds(Number(legacy[1]))
  const match =
    /\bresets?\s+(?:at\s+|on\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(
      text ?? '',
    )
  if (!match) return null
  const [, monthName, day, hourText, minuteText, half] = match
  let hour = Number(hourText)
  const minute = Number(minuteText ?? 0)
  if (half) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (half.toLowerCase() === 'pm' ? 12 : 0)
  } else if (minuteText === undefined) {
    return null // "resets 3" without am/pm or minutes: no time
  }
  if (hour > 23 || minute > 59) return null
  const at = new Date(now)
  at.setSeconds(0, 0)
  at.setHours(hour, minute)
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase())
    if (month < 0) return null
    at.setMonth(month, Number(day))
    if (at.getTime() < now - 24 * 60 * 60 * 1000) at.setFullYear(at.getFullYear() + 1)
    return at.getTime()
  }
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

// Unix seconds, or milliseconds already, as milliseconds.
const seconds = value => (value < 1e12 ? value * 1000 : value)

// The text of a message's content: a string, or text blocks.
function textOf(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n') : ''
}

// The generic text of a limit that says nothing more.
const GENERIC = 'usage limit reached'

// Whether a run's output line, or the controller's transcript line, says a
// usage limit or a throttle ended the turn: { kind: 'usage' | 'throttle',
// resetsAt (ms) or null, exact (the reset time from rate_limit_info, not
// from the text), limit (the kind of limit, if said), text } or null. Only
// API errors count, never what a worker wrote about rate limits, and a
// rate_limit_event only when it says the requests are refused: not when
// usage credits pay for them (refused).
export function limitOf(message) {
  if (!message || typeof message !== 'object') return null
  const info = (message.type === 'rate_limit_event' ? message.rate_limit_info : null) ??
    message.api_error_params?.rate_limit_info ??
    message.apiErrorParams?.rate_limit_info ??
    message.message?.api_error_params?.rate_limit_info ??
    null
  const reset = resetOf(info)
  const exact = reset !== null
  const usage = text => ({ kind: 'usage', resetsAt: exact ? reset : parseReset(text), exact, limit: info?.rateLimitType ?? null })
  const throttle = text => ({ kind: 'throttle', resetsAt: null, exact: false, limit: null, text: preview(text, 160) })
  if (message.type === 'rate_limit_event') return refused(info) ? { ...usage(''), text: GENERIC } : null
  const apiError = message.api_error ?? message.apiError ?? message.message?.api_error ?? null
  const error = message.error ?? message.message?.error ?? null
  const flagged = Boolean(message.is_api_error_message ?? message.isApiErrorMessage ?? message.message?.is_api_error_message)
  if (message.type === 'assistant' && (flagged || apiError || typeof error === 'string')) {
    const text = textOf(message.message?.content).trim()
    if (apiError === 'usage_limit_reached' || (USAGE_TEXT.test(text) && (error === 'rate_limit' || flagged))) {
      return { ...usage(text), text: preview(text || GENERIC, 160) }
    }
    if (error === 'rate_limit' || error === 'overloaded') return throttle(text || `the API answered ${error}`)
    return null
  }
  if (message.type === 'result' && (message.is_error || message.subtype !== 'success')) {
    const text = String(message.result ?? '').trim()
    if (USAGE_RESULT.test(text)) return { ...usage(text), text: preview(text, 160) }
    if (/^api error:?\s*(?:429|529)\b|^api error.*\boverloaded/i.test(text) || [429, 529].includes(message.api_error_status)) {
      return throttle(text || 'the API was overloaded')
    }
  }
  return null
}

// What a run's output says about the limit so far, after one more line: a
// limit or a throttle found (limitOf), the worse of two; the model answering
// after it means the run got past it (Workers.handleLine).
export function track(found, message) {
  const limit = limitOf(message)
  if (limit) return worse(found, limit)
  if (message?.type === 'assistant' && !message.error && !message.is_api_error_message) return null
  return found
}

// Whether a run's output line says usage credits pay for its requests
// (onCredits): { limit (the plan's limit that is reached, if said), resetsAt
// (ms) or null } or null.
export function creditsOf(message) {
  if (message?.type !== 'rate_limit_event' || !onCredits(message.rate_limit_info)) return null
  const info = message.rate_limit_info
  return { limit: info.rateLimitType ?? null, resetsAt: Number.isFinite(info.resetsAt) ? seconds(info.resetsAt) : null }
}

// Two findings of one run as one: a usage limit over a throttle; the exact
// reset time over one read from a text, a later one over an earlier; the
// words over the generic text.
export function worse(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.kind !== b.kind) return a.kind === 'usage' ? a : b
  const reset = a.exact && !b.exact ? a : b.resetsAt ? b : a
  return {
    ...a,
    ...b,
    resetsAt: reset.resetsAt,
    exact: Boolean(reset.exact),
    limit: b.limit ?? a.limit,
    text: b.text && b.text !== GENERIC ? b.text : a.text,
  }
}

// A time of day, as the driver hears it: "15:00", or "15:00 on 1 Nov" when
// it is not today.
export function clock(at, now = Date.now()) {
  const date = new Date(at)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${time} on ${date.getDate()} ${MONTHS[date.getMonth()][0].toUpperCase()}${MONTHS[date.getMonth()].slice(1)}`
}

// Who waits, in a few words.
export function accountName(account) {
  if (account === 'controller') return 'the controller session'
  if (account === 'host') return 'the workers on this computer'
  if (String(account).startsWith('container:')) return `the workers in the container ${account.slice('container:'.length)}`
  return String(account)
}

export class Limits extends EventEmitter {
  // file: where the waits are kept; null keeps them in memory (tests).
  // minWaitMs: how long a wait lasts at least, also for a reset due already.
  constructor({ file = null, backoffMinutes = BACKOFF_MINUTES, minWaitMs = MIN_WAIT_MS, now = () => Date.now(), log = defaultLog } = {}) {
    super()
    this.file = file
    this.minWaitMs = minWaitMs
    this.backoff = backoffMinutes.map(minutes => minutes * 60 * 1000)
    this.now = now
    this.log = log
    this.waits = {} // account -> { kind, limit, text, since, until, reset, source, tasks }
    this.strikes = {} // account -> waits without a reset time in a row, for the backoff
    this.credited = {} // account -> { since, until, limit, reset }: usage credits pay for its runs (credits)
    this.timer = null
    this.load()
  }

  // The timer for the waits kept from before, once the listeners are there:
  // one that ended meanwhile ends now, with its 'resume' event.
  start() {
    this.sweep()
    return this
  }

  load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const [account, wait] of Object.entries(saved.waits ?? {})) {
        if (Number.isFinite(wait?.until) && Number.isFinite(wait?.since)) this.waits[account] = wait
      }
      for (const [account, count] of Object.entries(saved.strikes ?? {})) {
        if (Number.isInteger(count) && count > 0) this.strikes[account] = count
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('usage limits file unreadable, starting without waits:', error.message)
    }
  }

  save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ waits: this.waits, strikes: this.strikes }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('usage limits not saved:', error.message)
    }
  }

  close() {
    clearTimeout(this.timer)
  }

  // A limit reached on an account: it waits until the reset, or for the
  // backoff. A wait already going is extended, never shortened, and is said
  // once (the 'wait' event's first). source: 'run' (a worker's), 'transcript'
  // (the controller's own), 'account' (the controller, as its account's
  // workers hit it); task: the run that hit it, for the message.
  hit(account, { kind = 'usage', resetsAt = null, limit = null, text = '', source = 'run', task = null } = {}) {
    const now = this.now()
    const going = this.active(account)
    // A reset due already: the least wait (below), then it goes on.
    let until = resetsAt ? Math.min(resetsAt, now + MAX_WAIT_MS) : null
    if (!until) {
      const strikes = this.strikes[account] ?? 0
      until = now + this.backoff[Math.min(strikes, this.backoff.length - 1)]
      if (!going) this.strikes[account] = strikes + 1
    }
    until = Math.max(until, now + this.minWaitMs)
    const tasks = [...new Set([...(going?.tasks ?? []), ...(task ? [task] : [])])]
    if (kind === 'usage') delete this.credited[account] // the credits, if any, pay no more
    if (going) {
      going.until = Math.max(going.until, until)
      going.tasks = tasks
      if (kind === 'usage') Object.assign(going, { kind, limit: limit ?? going.limit, text: text || going.text })
      if (resetsAt) going.reset = true
      this.save()
      this.schedule()
      this.emit('wait', account, going, false)
      return going
    }
    const wait = { kind, limit, text, since: now, until, reset: Boolean(resetsAt), source, tasks }
    this.waits[account] = wait
    this.save()
    this.schedule()
    this.log(`usage limit: ${accountName(account)} wait until ${new Date(until).toISOString()} (${kind}${limit ? `, ${limit}` : ''}): ${preview(text, 100)}`)
    this.emit('wait', account, wait, true)
    return wait
  }

  // The wait of an account that is going, or null; one that is over ends now.
  active(account) {
    const wait = this.waits[account]
    if (!wait) return null
    if (this.now() < wait.until) return wait
    this.end(account, 'its time is up')
    return null
  }

  // Whether any wait goes; the controller's included unless only workers count.
  any({ workers = false } = {}) {
    return Object.keys(this.waits).some(account => (!workers || account !== 'controller') && this.active(account))
  }

  // A run of the account got through: the backoff starts again from the first step.
  ok(account) {
    if (!this.strikes[account]) return
    delete this.strikes[account]
    this.save()
  }

  // Ends a wait before its time: the controller answered again, say. why: for the log.
  end(account, why = 'ended') {
    const wait = this.waits[account]
    if (!wait) return false
    delete this.waits[account]
    this.save()
    this.schedule()
    this.log(`usage limit: ${accountName(account)} go on, ${why}`)
    this.emit('resume', account, wait, why)
    return true
  }

  // A timer for the next wait to end, so that the queue and the held events go
  // on at once, not with the next look.
  schedule() {
    clearTimeout(this.timer)
    const next = Math.min(...Object.values(this.waits).map(wait => wait.until))
    if (!Number.isFinite(next)) return
    this.timer = setTimeout(() => this.sweep(), Math.max(0, next - this.now()) + 50)
    this.timer.unref?.()
  }

  sweep() {
    for (const account of Object.keys(this.waits)) this.active(account)
    this.schedule()
  }

  // The waits going, as lines for status, open_items and the gateway line:
  // [{ account, wait, text }].
  list() {
    return Object.keys(this.waits)
      .map(account => ({ account, wait: this.active(account) }))
      .filter(item => item.wait)
      .map(({ account, wait }) => ({ account, wait, text: waitText(account, wait, this.now()) }))
  }

  // Usage credits pay for an account's runs (creditsOf): its plan's limit is
  // reached, and Claude Code goes on by itself. Nothing waits, nothing is
  // held, and the driver is not told: said once in the log, and in
  // list_workers while it lasts, until the plan's reset, else for CREDITS_MS;
  // a later reset extends it. One past already, as in a run's output read
  // again after a restart, is the plan's own usage again. In memory only.
  credits(account, { limit = null, resetsAt = null } = {}) {
    const now = this.now()
    const reset = Number.isFinite(resetsAt)
    if (reset && resetsAt <= now) return null
    const until = Math.min(reset ? resetsAt : now + CREDITS_MS, now + MAX_WAIT_MS)
    const going = this.credited[account]
    if (going && now < going.until) {
      if (until > going.until) Object.assign(going, { until, reset, limit: limit ?? going.limit })
      return going
    }
    const entry = { since: now, until, limit, reset }
    this.credited[account] = entry
    this.log(`usage credits: ${creditsText(account, entry, now)}`)
    return entry
  }

  // The usage credits that pay for an account's runs, or null; not while it waits.
  paying(account) {
    const entry = this.credited[account]
    if (!entry) return null
    if (this.now() >= entry.until) {
      delete this.credited[account]
      return null
    }
    return this.active(account) ? null : entry
  }

  // The accounts on usage credits, as lines for list_workers: [{ account, entry, text }].
  creditsList() {
    return Object.keys(this.credited)
      .map(account => ({ account, entry: this.paying(account) }))
      .filter(item => item.entry)
      .map(({ account, entry }) => ({ account, entry, text: creditsText(account, entry, this.now()) }))
  }
}

// An account on usage credits in a sentence.
export function creditsText(account, entry, now = Date.now()) {
  const plan = PLAN_LIMITS.has(entry.limit) ? `the ${limitName(entry.limit)}` : "the plan's limit"
  const until = entry.reset ? ` until it resets at ${clock(entry.until, now)}` : ''
  return `${accountName(account)} run on usage credits since ${clock(entry.since, now)}, as ${plan} is reached${until}; nothing waits`
}

// One wait in a sentence.
export function waitText(account, wait, now = Date.now()) {
  const what = wait.kind === 'usage' ? `the Claude usage limit${wait.limit ? ` (${limitName(wait.limit)})` : ''}` : 'the Claude API, which was overloaded,'
  const until = wait.reset ? `until ${clock(wait.until, now)}, when it resets` : `until ${clock(wait.until, now)}, then they try again`
  return `${accountName(account)} wait for ${what} ${until}`
}

const LIMIT_NAMES = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  seven_day_overage_included: 'Fable limit',
  overage: 'usage credits',
}
const limitName = limit => LIMIT_NAMES[limit] ?? String(limit).replace(/_/g, ' ')
// The plan's own limits, which usage credits go past.
const PLAN_LIMITS = new Set(Object.keys(LIMIT_NAMES).filter(limit => limit !== 'overage'))

// --- the controller session's own transcript ------------------------------------

// The transcript of the session this gateway runs in: Claude Code gives its
// child processes the session's id (CLAUDE_CODE_SESSION_ID), and keeps the
// transcript in <config>/projects/<folder>/<id>.jsonl. null if not found.
export function transcriptFile({ sessionId = process.env.CLAUDE_CODE_SESSION_ID, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') } = {}) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null
  const projects = join(configDir, 'projects')
  let folders = []
  try {
    folders = readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return null
  }
  for (const folder of folders) {
    const file = join(projects, folder.name, `${sessionId}.jsonl`)
    try {
      if (statSync(file).isFile()) return file
    } catch {
      // not this folder
    }
  }
  return null
}

// Follows the controller's transcript from its end on, and calls onLimit
// for every turn that a usage limit or a throttle ended (limitOf), with the
// time it was written. A file not there yet is looked for again.
export class TranscriptWatch {
  constructor({ find = () => transcriptFile(), onLimit, pollMs = 5000, log = defaultLog }) {
    this.find = find
    this.onLimit = onLimit
    this.pollMs = pollMs
    this.log = log
    this.file = null
    this.offset = 0
    this.partial = ''
    this.timer = null
  }

  start() {
    this.look(true)
    this.timer = setInterval(() => this.look(), this.pollMs)
    this.timer.unref?.()
    return this
  }

  close() {
    clearInterval(this.timer)
  }

  // One look: what was written since the last one. The first finds the end.
  look(first = false) {
    try {
      if (!this.file) {
        this.file = this.find()
        if (!this.file) return
        this.offset = first ? this.size() : 0
        this.log(`usage limit: following the controller's transcript ${this.file}`)
      }
      const size = this.size()
      if (size < this.offset) this.offset = 0 // a new file at the same place
      if (size === this.offset) return
      const fd = openSync(this.file, 'r')
      let text
      try {
        const buffer = Buffer.alloc(size - this.offset)
        readSync(fd, buffer, 0, buffer.length, this.offset)
        text = buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
      this.offset = size
      const lines = (this.partial + text).split('\n')
      this.partial = lines.pop()
      for (const line of lines) this.line(line)
    } catch (error) {
      this.log('usage limit: the controller transcript not read:', error.message)
    }
  }

  size() {
    const fd = openSync(this.file, 'r')
    try {
      return fstatSync(fd).size
    } finally {
      closeSync(fd)
    }
  }

  line(line) {
    if (!line.includes('rror') && !line.includes('rate_limit')) return // cheap: most lines are no API error
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const hit = limitOf(message)
    if (hit) this.onLimit(hit, Date.parse(message.timestamp) || Date.now())
  }
}
