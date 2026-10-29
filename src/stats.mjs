// Statistics over the gateway's running time: what the driver, the controller
// and the workers did since this start, and all time across starts.
//
// The gateway counts what it sees anyway, in the events of the parts it wires
// together (watch): voice requests, the controller's questions and the
// driver's answers (store.mjs), decisions (ledger.mjs), worker runs and the
// queue (workers.mjs), the kill switch's look at each run's size, which gives
// the commits, pushes, files and lines (guard.mjs), pull requests and their
// checks and reviews (pulls.mjs), and the kill switch itself. A run's tokens,
// cost, turns, tool calls and subagents come from its own output, which the
// gateway follows anyway (addResult, from Workers.handleLine); a run counts
// once, when it ends, with the figures of its whole output, also when a
// gateway before this one followed its start. Nothing is looked up for the
// statistics alone.
//
// Not counted: the controller session's own tokens. They are only in its
// transcript, whose cost line Claude Code writes when the session ends, and
// the sum of its messages does not match that line: neither is cheap and
// reliable while the session runs.
//
// What is kept: counts, sums, maxima, and the last SAMPLES durations for the
// typical values (medians); no texts, prompts or secrets, of names only the
// repositories'. In .state/stats.json, atomically, mode 0600: this running
// time (current) and the totals of all time including it (total), saved a few
// seconds after a change and every few minutes, so that a crash loses little,
// and a last time when the gateway ends (close), with endedAt. A start takes
// the totals from the file and begins its own running time at zero.
//
// The file also names the session the gateway belongs to: its parent, the
// controller session's claude, whose process id the watchdog keeps. So the
// watchdog's message is only ever about the gateway of the session that
// ended.
//
// Read three ways: the controller's tool stats (channel.mjs), /stats on
// Telegram (gateway.mjs), and the message when the gateway shuts down. That
// one comes from the watchdog, which alone knows whether the session was
// stopped, restarted or crashed (scripts/stats.mjs, scripts/start-controller.sh),
// or from the gateway itself when it runs without the watchdog.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log as defaultLog } from './log.mjs'

export const STATS_FILE = 'stats.json'
const VERSION = 1
const SAMPLES = 100 // durations kept for a median, the newest
const MAX_REPOS = 100 // repositories kept by name, those with the most runs
const SAVE_DELAY_MS = 10 * 1000 // a save this long after a change
const SAVE_EVERY_MS = 5 * 60 * 1000 // and at least this often, for the running time
const CONVERSATION_GAP_MS = 10 * 60 * 1000 // a voice request after this long starts a new conversation
const WORK_FOLDERS = 'work folders' // every work folder counts under this one name
// The tool that starts a subagent: Agent, Task in older versions of Claude Code.
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const map = () => Object.create(null) // counts by name, without inherited keys
const repoEntry = () => ({ runs: 0, ms: 0, costUsd: 0, maxAtOnce: 0, twoPlusMs: 0 })

// One period: this running time, or all time. Names that start with "max"
// are maxima, "longest" is the longest run with its repository, "since" the
// start; every other number is a count or a sum, and every list holds the
// last durations for a median.
export function emptyPeriod(since = 0) {
  return {
    since,
    upMs: 0,
    starts: 0,
    restarts: { crash: 0, requested: 0, service: 0, everything: 0 }, // what each start came after
    voice: { requests: 0, conversations: 0, questions: 0, answers: 0, answerMs: [], maxAnswerMs: 0, approvals: 0, allowed: 0, denied: 0 },
    decisions: { raised: 0, byGateway: 0, kinds: map(), closed: 0, closeMs: [], closedBy: map() },
    runs: {
      ended: 0,
      done: 0,
      failed: 0,
      stopped: 0,
      followups: 0, // continued the session of an earlier run
      worktrees: 0,
      scratch: 0, // in work folders
      requeued: 0, // interrupted in a worktree, back in the queue
      ms: 0,
      runMs: [],
      longest: { ms: 0, repo: '' },
    },
    repos: map(), // name -> repoEntry()
    parallel: { maxAtOnce: 0, twoPlusMs: 0 },
    queue: { started: 0, waitMs: [], maxWaitMs: 0, parked: 0, dropped: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0, costUnknown: 0, turns: 0, tools: 0, subagents: 0 },
    git: { commits: 0, committedRuns: 0, pushedRuns: 0, files: 0, lines: 0, pullsOpened: 0, pullsUpdated: 0, scratchFiles: 0 },
    pulls: { checks: 0, checksFailed: 0, reviews: 0, approved: 0, changesRequested: 0, comments: 0 },
    killswitch: { locks: 0, triggers: map() },
  }
}

const MAPS = { kinds: () => 0, closedBy: () => 0, triggers: () => 0, repos: repoEntry }

// A saved period as the gateway can use it: the known shape, numbers only,
// whatever the file holds.
function normal(template, value, key = '') {
  if (typeof template === 'number') return Number.isFinite(value) && value >= 0 ? value : 0
  if (typeof template === 'string') return typeof value === 'string' ? value.slice(0, 200) : template
  if (Array.isArray(template)) return Array.isArray(value) ? value.filter(n => Number.isFinite(n) && n >= 0).slice(-SAMPLES) : []
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  if (key in MAPS) {
    const out = map()
    for (const [name, entry] of Object.entries(source)) {
      if (!UNSAFE_KEYS.has(name)) out[name.slice(0, 200)] = normal(MAPS[key](), entry)
    }
    return out
  }
  const out = {}
  for (const [name, inner] of Object.entries(template)) out[name] = normal(inner, source[name], name)
  return out
}

// Two periods as one: the totals before this start and this running time.
export function merge(a, b) {
  const out = Array.isArray(a) ? [] : Object.getPrototypeOf(a) === null ? map() : {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key]
    const y = b[key]
    if (x === undefined) out[key] = structuredClone(y)
    else if (y === undefined) out[key] = structuredClone(x)
    else if (key === 'since') out[key] = x && y ? Math.min(x, y) : x || y
    else if (key === 'longest') out[key] = { ...(y.ms > x.ms ? y : x) }
    else if (key.startsWith('max')) out[key] = Math.max(x, y)
    else if (Array.isArray(x)) out[key] = [...x, ...y].slice(-SAMPLES)
    else if (typeof x === 'number') out[key] = x + y
    else if (x !== null && typeof x === 'object') out[key] = merge(x, y)
    else out[key] = y
  }
  return out
}

const finite = n => (Number.isFinite(n) && n > 0 ? n : 0)

// What one result in a run's output says it used: tokens with the cache, the
// cost at API list prices, turns. Claude Code reports per result the usage
// since the result before (model_usage_since_last_result, per model, with the
// cost); its total_cost_usd and modelUsage add up the whole session, earlier
// runs included when a run resumes one. Without the first, the tokens come
// from usage, and the cost is known only where the session is the run's own:
// the growth of total_cost_usd. Returns the figures with costUsd null when
// the cost is unknown.
export function resultUsage(message, { resumed = false, lastTotal = 0 } = {}) {
  const since = message.model_usage_since_last_result
  const figures = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: null, turns: finite(message.num_turns) }
  if (since !== null && typeof since === 'object') {
    figures.costUsd = 0
    for (const model of Object.values(since)) {
      figures.input += finite(model?.inputTokens)
      figures.output += finite(model?.outputTokens)
      figures.cacheRead += finite(model?.cacheReadInputTokens)
      figures.cacheWrite += finite(model?.cacheCreationInputTokens)
      figures.thinking += finite(model?.thinkingTokens)
      figures.costUsd += finite(model?.costUSD)
    }
    return figures
  }
  const usage = message.usage ?? {}
  figures.input = finite(usage.input_tokens)
  figures.output = finite(usage.output_tokens)
  figures.cacheRead = finite(usage.cache_read_input_tokens)
  figures.cacheWrite = finite(usage.cache_creation_input_tokens)
  figures.thinking = finite(usage.output_tokens_details?.thinking_tokens)
  if (!resumed && Number.isFinite(message.total_cost_usd)) figures.costUsd = Math.max(0, message.total_cost_usd - lastTotal)
  return figures
}

// A result line of a run's output, added to what the run used so far (kept
// with the run as task.usage). Every result counts, also that of a turn
// Claude Code answered on its own: it used tokens all the same.
export function addResult(usage, message, { resumed = false } = {}) {
  const u = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0, costKnown: true, turns: 0, lastTotal: 0 }
  const r = resultUsage(message, { resumed, lastTotal: u.lastTotal })
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking', 'turns']) u[key] += r[key]
  if (r.costUsd === null) u.costKnown = false
  else u.costUsd += r.costUsd
  if (Number.isFinite(message.total_cost_usd)) u.lastTotal = message.total_cost_usd
  return u
}

// Why the start before this one ended, from the watchdog's note (restart.mjs).
function restartKind(reason) {
  if (!reason) return null
  if (/^a crash\b/.test(reason)) return 'crash'
  if (/^a restart of the service\b/.test(reason)) return 'service'
  if (/^a restart of everything\b/.test(reason)) return 'everything' // scripts/restart-everything.sh
  if (/^a restart requested\b/.test(reason)) return 'requested'
  return null
}

const sample = (list, ms) => {
  list.push(Math.max(0, Math.round(ms)))
  if (list.length > SAMPLES) list.splice(0, list.length - SAMPLES)
}

// The statistics file: { current, total } as saved, or null.
export function readStats(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const current = normal(emptyPeriod(0), data?.current)
    if (Number.isFinite(data?.current?.endedAt)) current.endedAt = data.current.endedAt
    return {
      current,
      total: normal(emptyPeriod(0), data?.total),
      savedAt: Number.isFinite(data?.savedAt) ? data.savedAt : 0,
      session: Number.isInteger(data?.session) ? data.session : null,
    }
  } catch {
    return null
  }
}

export class Stats {
  constructor({
    file = null,
    session = null, // the process id of the session it belongs to, for the watchdog
    now = Date.now,
    saveDelayMs = SAVE_DELAY_MS,
    saveEveryMs = SAVE_EVERY_MS,
    conversationGapMs = CONVERSATION_GAP_MS,
    log = defaultLog,
  } = {}) {
    this.file = file
    this.session = session
    this.now = now
    this.saveDelayMs = saveDelayMs
    this.gapMs = conversationGapMs
    this.log = log
    const saved = file ? this.load() : null
    this.base = saved?.total ?? emptyPeriod(0) // all time before this start
    this.lastVoiceAt = saved?.lastVoiceAt ?? 0 // for the conversations, across a restart
    this.current = emptyPeriod(now())
    this.current.starts = 1
    this.live = new Map() // task id -> workspace, the runs going
    this.liveAt = this.current.since
    this.counted = new Set() // task ids whose pull requests are counted
    this.endedAt = null
    this.timer = null
    this.ticker = file ? setInterval(() => this.save(), saveEveryMs) : null
    this.ticker?.unref()
  }

  load() {
    let data
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') this.log(`statistics file ${this.file} unreadable, all-time totals start again: ${error.message}`)
      return null
    }
    return { total: normal(emptyPeriod(0), data?.total), lastVoiceAt: finite(data?.lastVoiceAt) }
  }

  // The start: what it came after, from the watchdog's note. Saved at once,
  // so that the file says from now on that this running time began: the
  // watchdog's message is only for a gateway of the session that ended.
  started({ after = null } = {}) {
    const kind = restartKind(after)
    if (kind) this.current.restarts[kind]++
    this.save()
  }

  // The events of the gateway's parts. Each handler counts and never throws:
  // the statistics must not get in the way of the work.
  watch({ store = null, ledger = null, workers = null, guard = null, pulls = null, killswitch = null } = {}) {
    const on = (emitter, event, handler) =>
      emitter?.on(event, (...args) => {
        try {
          handler(...args)
        } catch (error) {
          this.log('statistics: not counted:', error.message)
        }
      })
    on(store, 'request', request => this.request(request, store))
    on(store, 'reply', (request, state) => this.reply(request, state))
    on(store, 'permission', permission => this.permission(permission))
    on(ledger, 'added', decision => this.decisionAdded(decision))
    on(ledger, 'closed', decision => this.decisionClosed(decision))
    on(workers, 'started', task => this.runStarted(task))
    on(workers, 'ended', task => this.runEnded(task))
    on(workers, 'parked', () => this.add('queue', 'parked'))
    on(workers, 'dropped', entries => this.add('queue', 'dropped', entries.length))
    on(guard, 'measured', (task, measured) => this.measured(task, measured))
    on(pulls, 'news', news => this.news(news))
    on(killswitch, 'tripped', (state, event, first) => this.tripped(event, first))
    // Runs going from before this start: from now on for the runs at once.
    for (const task of workers?.running() ?? []) this.runStarted(task, { before: true })
    return this
  }

  add(group, key, n = 1) {
    this.current[group][key] += n
    this.changed()
  }

  // --- the driver -------------------------------------------------------------

  request(request, store) {
    if (request.origin !== 'voice') return
    const voice = this.current.voice
    voice.requests++
    const at = request.createdAt ?? this.now()
    if (!this.lastVoiceAt || at - this.lastVoiceAt > this.gapMs) voice.conversations++
    this.lastVoiceAt = at
    // An answer to a question: how long the driver took, from the question.
    const question = request.answers ? store?.getRequest(request.answers) : null
    const asked = question?.updates?.findLast(update => update.state === 'question')
    if (asked && Number.isFinite(asked.at)) {
      voice.answers++
      sample(voice.answerMs, at - asked.at)
      voice.maxAnswerMs = Math.max(voice.maxAnswerMs, at - asked.at)
    }
    this.changed()
  }

  // A question to the driver: on a voice request, or as news on a worker's
  // result or a reminder. Not on the gateway's own events.
  reply(request, state) {
    if (state !== 'question' || !['voice', 'worker'].includes(request.origin)) return
    this.add('voice', 'questions')
  }

  permission(permission) {
    const key = { open: 'approvals', allow: 'allowed', deny: 'denied' }[permission.status]
    if (key) this.add('voice', key)
  }

  // Raised pending by the gateway itself (a push after a run, a task that
  // could not start, its own checkout); asked at once when it is the
  // controller's question.
  decisionAdded(decision) {
    const d = this.current.decisions
    d.raised++
    if (decision.state === 'pending') d.byGateway++
    d.kinds[decision.kind] = (d.kinds[decision.kind] ?? 0) + 1
    this.changed()
  }

  decisionClosed(decision) {
    const d = this.current.decisions
    d.closed++
    if (decision.closedBy) d.closedBy[decision.closedBy] = (d.closedBy[decision.closedBy] ?? 0) + 1
    if (Number.isFinite(decision.closedAt) && Number.isFinite(decision.createdAt)) sample(d.closeMs, decision.closedAt - decision.createdAt)
    this.changed()
  }

  // --- the workers ------------------------------------------------------------

  repo(name) {
    const repos = this.current.repos
    if (UNSAFE_KEYS.has(name)) name = `${name} `
    repos[name] ??= repoEntry()
    return repos[name]
  }

  static nameOf(task) {
    return task.kind === 'scratch' ? WORK_FOLDERS : String(task.repo ?? 'unknown')
  }

  // How many runs go, in all and per workspace, until now: the time with two
  // or more at once.
  settle(at = this.now()) {
    const ms = Math.max(0, at - this.liveAt)
    this.liveAt = Math.max(this.liveAt, at)
    if (!ms || this.live.size < 2) return
    this.current.parallel.twoPlusMs += ms
    for (const [name, n] of this.perWorkspace()) if (n >= 2) this.repo(name).twoPlusMs += ms
  }

  perWorkspace() {
    const counts = new Map()
    for (const { workspace } of this.live.values()) counts.set(workspace, (counts.get(workspace) ?? 0) + 1)
    return counts
  }

  // before: a run going when this gateway started, which waited in no queue
  // of this running time.
  runStarted(task, { before = false } = {}) {
    if (this.live.has(task.id)) return
    this.settle()
    this.live.set(task.id, { workspace: task.repo, name: Stats.nameOf(task) })
    const parallel = this.current.parallel
    parallel.maxAtOnce = Math.max(parallel.maxAtOnce, this.live.size)
    const here = this.perWorkspace().get(task.repo) ?? 0
    const repo = this.repo(Stats.nameOf(task))
    repo.maxAtOnce = Math.max(repo.maxAtOnce, here)
    if (!before && Number.isFinite(task.queuedAt) && Number.isFinite(task.startedAt)) {
      const queue = this.current.queue
      const waited = Math.max(0, task.startedAt - task.queuedAt)
      queue.started++
      sample(queue.waitMs, waited)
      queue.maxWaitMs = Math.max(queue.maxWaitMs, waited)
    }
    this.changed()
  }

  // A run has ended: with everything its output said (task.usage, tools,
  // subagents), counted by Workers.handleLine.
  runEnded(task) {
    this.settle()
    this.live.delete(task.id)
    const runs = this.current.runs
    const name = Stats.nameOf(task)
    const ms = Math.max(0, (task.finishedAt ?? this.now()) - (task.startedAt ?? this.now()))
    runs.ended++
    if (['done', 'failed', 'stopped'].includes(task.state)) runs[task.state]++
    if (task.resumed) runs.followups++
    if (task.worktree) runs.worktrees++
    if (task.kind === 'scratch') runs.scratch++
    if (task.requeuedAs) runs.requeued++
    runs.ms += ms
    sample(runs.runMs, ms)
    if (ms > runs.longest.ms) runs.longest = { ms, repo: name }
    const usage = task.usage
    const tokens = this.current.tokens
    if (usage) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking', 'turns']) tokens[key] += finite(usage[key])
      tokens.costUsd += finite(usage.costUsd)
      if (!usage.costKnown) tokens.costUnknown++
    }
    tokens.tools += finite(task.tools)
    tokens.subagents += finite(task.subagents)
    const repo = this.repo(name)
    repo.runs++
    repo.ms += ms
    repo.costUsd += finite(usage?.costUsd)
    this.changed()
  }

  // What the kill switch's look at the end of a run found (guard.mjs): the
  // commits made during it, files and lines changed with what is not
  // committed, and whether it pushed.
  measured(task, { commits = 0, files = 0, lines = 0, pushed = false } = {}) {
    const git = this.current.git
    git.commits += finite(commits)
    if (commits > 0) git.committedRuns++
    if (pushed) git.pushedRuns++
    git.files += finite(files)
    git.lines += finite(lines)
    this.changed()
  }

  // The result of a run as the controller gets it (gateway.mjs): the pull
  // requests it opened or worked on, and in a work folder what it made.
  // Once per run, also when the result is sent again.
  reported(task, pulls = []) {
    if (this.counted.has(task.id)) return
    this.counted.add(task.id)
    const git = this.current.git
    for (const pull of pulls) {
      if (pull.opened) git.pullsOpened++
      else git.pullsUpdated++
    }
    const counts = task.kind === 'scratch' && task.audit?.ok ? task.audit.counts : null
    if (counts) git.scratchFiles += finite(counts.made) + finite(counts.changed)
    this.changed()
  }

  // Checks and reviews on a watched pull request (pulls.mjs).
  news(news) {
    const pulls = this.current.pulls
    if (news.checks) {
      pulls.checks++
      if (news.checks.failed) pulls.checksFailed++
    }
    for (const state of news.reviews ?? []) {
      pulls.reviews++
      if (state === 'APPROVED') pulls.approved++
      if (state === 'CHANGES_REQUESTED') pulls.changesRequested++
    }
    pulls.comments += finite(news.comments)
    this.changed()
  }

  tripped(event, first) {
    const k = this.current.killswitch
    if (first) k.locks++
    const trigger = String(event?.trigger ?? 'unknown')
    if (!UNSAFE_KEYS.has(trigger)) k.triggers[trigger] = (k.triggers[trigger] ?? 0) + 1
    this.changed()
  }

  // --- reading and keeping ----------------------------------------------------

  // This running time and all time, up to now (or to the end).
  snapshot() {
    const at = this.endedAt ?? this.now()
    this.settle(at)
    const current = structuredClone(this.current)
    current.upMs = Math.max(0, at - current.since)
    if (this.endedAt) current.endedAt = this.endedAt
    const total = merge(this.base, { ...current, endedAt: undefined })
    delete total.endedAt
    return { current, total }
  }

  changed() {
    if (!this.file || this.timer || this.endedAt) return
    this.timer = setTimeout(() => this.save(), this.saveDelayMs)
    this.timer.unref()
  }

  // Atomically, folder 0700 and file 0600, as the other state files. A failed
  // save keeps the figures in this gateway; the next one tries again.
  save() {
    clearTimeout(this.timer)
    this.timer = null
    if (!this.file) return
    const { current, total } = this.snapshot()
    for (const period of [current, total]) {
      const names = Object.keys(period.repos)
      if (names.length <= MAX_REPOS) continue
      const kept = names.sort((a, b) => period.repos[b].runs - period.repos[a].runs).slice(0, MAX_REPOS)
      const repos = map()
      for (const name of kept) repos[name] = period.repos[name]
      period.repos = repos
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      const data = { version: VERSION, savedAt: this.now(), session: this.session, lastVoiceAt: this.lastVoiceAt, current, total }
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('statistics not saved, kept in this gateway:', error.message)
    }
  }

  // The gateway ends: the last save, with the end of this running time, which
  // the watchdog's message waits for. Returns the snapshot.
  close() {
    if (!this.endedAt) {
      this.endedAt = this.now()
      clearInterval(this.ticker)
      this.save()
    }
    return this.snapshot()
  }
}

// --- the texts ----------------------------------------------------------------
//
// Read aloud by the controller, and on Telegram: round numbers, few words,
// what matters most first.

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`
const trimZero = text => text.replace(/\.0$/, '')
const capital = text => text.charAt(0).toUpperCase() + text.slice(1)
const listed = parts => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? ''))

// Round, for speech, two digits from 1,000: 520 million, 1.8 million,
// 970,000, 1,200, 37.
export function amount(n) {
  const two = x => Number(x.toPrecision(2))
  if (n >= 1e9) return `${two(n / 1e9).toLocaleString('en')} billion`
  if (n >= 1e6) return `${two(n / 1e6)} million`
  if (n >= 1000) return two(n).toLocaleString('en')
  return String(Math.round(n))
}

// 45 min, 5 h 20 min, 31 h, 3 days.
export function span(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours >= 72) return `${Math.round(minutes / 1440)} days`
  if (hours >= 10) return `${Math.round(minutes / 60)} h`
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
}

const about = ms => (ms < 60000 ? 'less than a minute' : `about ${span(ms)}`)
const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)
const day = ms => new Date(ms).toISOString().slice(0, 10)
const when = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

export function median(list) {
  if (!list?.length) return null
  const sorted = [...list].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function dollars(usd) {
  if (usd < 0.995) return 'less than a dollar'
  const shown = usd < 9.95 ? trimZero(usd.toFixed(1)) : amount(usd)
  return `about ${shown} dollar${shown === '1' ? '' : 's'}`
}

const tokenSum = t => t.input + t.output + t.cacheRead + t.cacheWrite

// The cost at API list prices, as Claude Code reports it ("at least" when a
// run's cost was unknown). On a subscription it is not what is billed.
function costText(t) {
  if (!t.costUsd) return ''
  return `${t.costUnknown ? 'at least ' : ''}${dollars(t.costUsd)} at API list prices`
}

const by = (counts, words = {}) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n} ${words[name] ?? name}`)
    .join(', ')

// Two or three sentences: the work, what came of it and what it cost, the
// driver. you: for the driver themselves (Telegram), not for the controller.
export function overviewText(p, { you = false, allTime = false } = {}) {
  const lead = allTime ? `Since ${day(p.since)}, in ${span(p.upMs)} of running` : `In ${span(p.upMs)}`
  const sentences = []
  const r = p.runs
  if (r.ended) {
    const outcomes = ['done', 'failed', 'stopped'].filter(key => r[key]).map(key => `${r[key]} ${key}`)
    let first = `${lead}: ${plural(r.ended, 'worker run')} (${outcomes.join(', ')}), ${span(r.ms)} of work`
    if (p.parallel.maxAtOnce >= 2) first += `, at most ${p.parallel.maxAtOnce} at once`
    sentences.push(`${first}.`)
    const made = []
    if (p.git.commits) made.push(plural(p.git.commits, 'commit'))
    if (p.git.pullsOpened) made.push(`${plural(p.git.pullsOpened, 'pull request')} opened`)
    const tokens = tokenSum(p.tokens)
    const cost = costText(p.tokens)
    const used = tokens ? `${amount(tokens)} tokens${cost ? `, ${cost}` : ''}` : ''
    if (made.length && used) sentences.push(`${capital(listed(made))}, with ${used}.`)
    else if (made.length) sentences.push(`${capital(listed(made))}.`)
    else if (used) sentences.push(`They used ${used}.`)
  } else {
    sentences.push(`${lead}: no worker runs.`)
  }
  const v = p.voice
  const driver = []
  if (v.requests) {
    let said = plural(v.requests, 'voice request')
    if (v.questions) {
      said += `, ${plural(v.questions, 'question')} to ${you ? 'you' : 'the driver'}`
      const typical = median(v.answerMs)
      if (typical !== null) said += `, answered after ${about(typical)}`
    }
    driver.push(said)
  } else {
    driver.push('no voice requests')
  }
  if (p.killswitch.locks) driver.push(`the kill switch locked ${times(p.killswitch.locks)}`)
  sentences.push(`${capital(driver.join('; '))}.`)
  return sentences.join(' ')
}

// All time in one line, for the end of a message.
export function totalLine(t) {
  const head = `All time, since ${day(t.since)} (${plural(t.starts, 'start')})`
  if (!t.runs.ended) return `${head}: no worker runs.`
  const parts = [plural(t.runs.ended, 'worker run'), `${span(t.runs.ms)} of work`]
  const tokens = tokenSum(t.tokens)
  if (tokens) parts.push(`${amount(tokens)} tokens`)
  const cost = costText(t.tokens)
  if (cost) parts.push(cost)
  if (t.git.pullsOpened) parts.push(`${plural(t.git.pullsOpened, 'pull request')} opened`)
  return `${head}: ${parts.join(', ')}.`
}

const DECISION_KINDS = { other: 'other' }
const CLOSED_BY = { driver: 'by the driver', dispatch: 'by a follow-up', reply: 'with an answer', gateway: 'by the gateway' }
const TRIGGERS = { voice: 'by voice', telegram: 'on Telegram', rule: 'by a rule', controller: 'by the controller' }

// The details, one line per subject, for the period p; total: all time, for
// the starts and restarts.
export function detailsLines(p, { allTime = false, total = null } = {}) {
  const lines = []
  const t = total ?? p
  const after = [
    t.restarts.crash && `${t.restarts.crash} after a crash`,
    t.restarts.requested && `${t.restarts.requested} after a restart by voice`,
    t.restarts.service && `${t.restarts.service} after a restart of the service`,
    t.restarts.everything && `${t.restarts.everything} after a restart of everything`,
  ].filter(Boolean)
  const starts = `${plural(t.starts, 'start')} since ${day(t.since)}${after.length ? `, of them ${listed(after)}` : ''}`
  lines.push(allTime ? `Running: ${span(p.upMs)} in all; ${starts}.` : `Running: ${span(p.upMs)}, since ${when(p.since)}; ${starts}.`)

  const v = p.voice
  const voice = [`${plural(v.requests, 'request')}${v.conversations ? ` in ${plural(v.conversations, 'conversation')}` : ''}`]
  if (v.questions) {
    let asked = `${plural(v.questions, 'question')} to the driver, ${v.answers} answered`
    const typical = median(v.answerMs)
    if (typical !== null) asked += `, typically after ${about(typical)}, the longest after ${span(v.maxAnswerMs)}`
    voice.push(asked)
  }
  if (v.approvals) voice.push(`${plural(v.approvals, 'approval')} asked by voice, ${v.allowed} allowed, ${v.denied} denied`)
  lines.push(`Voice: ${voice.join('; ')}.`)

  const d = p.decisions
  if (d.raised || d.closed) {
    const kinds = by(d.kinds, DECISION_KINDS)
    let line = `Decisions: ${d.raised} raised${d.byGateway ? `, ${d.byGateway} of them by the gateway` : ''}${kinds ? ` (${kinds})` : ''}`
    if (d.closed) {
      const typical = median(d.closeMs)
      line += `; ${d.closed} closed${typical !== null ? `, typically after ${about(typical)}` : ''}`
      const closers = by(d.closedBy, CLOSED_BY)
      if (closers) line += ` (${closers})`
    }
    lines.push(`${line}.`)
  } else {
    lines.push('Decisions: none raised.')
  }

  const r = p.runs
  if (!r.ended) {
    lines.push('Worker runs: none ended.')
  } else {
    const outcomes = ['done', 'failed', 'stopped'].filter(key => r[key]).map(key => `${r[key]} ${key}`)
    const kinds = []
    if (r.followups) kinds.push(`${plural(r.followups, 'follow-up')} in the same session`)
    if (r.worktrees) kinds.push(`${r.worktrees} in worktrees`)
    if (r.scratch) kinds.push(`${r.scratch} in work folders`)
    if (r.requeued) kinds.push(`${r.requeued} interrupted and queued again`)
    const repos = Object.entries(p.repos)
      .filter(([, entry]) => entry.runs)
      .sort((a, b) => b[1].runs - a[1].runs || b[1].ms - a[1].ms)
    const top = repos.slice(0, 3).map(([name, entry]) => {
      const cost = entry.costUsd >= 0.995 ? `, ${dollars(entry.costUsd)}` : ''
      return `${name} ${entry.runs} (${span(entry.ms)}${cost})`
    })
    if (repos.length > 3) top.push(`${repos.length - 3} more`)
    lines.push(
      `Worker runs: ${r.ended} ended, ${outcomes.join(', ')}${kinds.length ? `; ${kinds.join(', ')}` : ''}. ` +
        `By repository: ${top.join(', ')}.`,
    )
    const typical = median(r.runMs)
    lines.push(
      `Worker time: ${span(r.ms)} in all${typical !== null ? `, typically ${span(typical)} a run` : ''}, ` +
        `the longest ${span(r.longest.ms)} (${r.longest.repo}).`,
    )
  }

  const par = p.parallel
  if (par.maxAtOnce >= 2) {
    let line = `At once: at most ${par.maxAtOnce} runs, 2 or more for ${span(par.twoPlusMs)}`
    const busiest = Object.entries(p.repos)
      .filter(([, entry]) => entry.maxAtOnce >= 2)
      .sort((a, b) => b[1].maxAtOnce - a[1].maxAtOnce || b[1].twoPlusMs - a[1].twoPlusMs)
    if (busiest.length) {
      const [name, entry] = busiest[0]
      line += `; in one repository at most ${entry.maxAtOnce} (${name}), 2 or more there for ${span(entry.twoPlusMs)}`
    }
    lines.push(`${line}.`)
  } else if (r.ended) {
    lines.push('At once: one run at a time.')
  }

  const q = p.queue
  const queue = []
  if (q.started) {
    const typical = median(q.waitMs)
    queue.push(`${plural(q.started, 'task')} waited${typical !== null ? `, typically ${span(typical)}` : ''}, the longest ${span(q.maxWaitMs)}`)
  } else {
    queue.push('no task waited')
  }
  if (q.parked) queue.push(`${q.parked} could not start when it was ${q.parked === 1 ? 'its' : 'their'} turn`)
  if (q.dropped) queue.push(`${q.dropped} dropped`)
  lines.push(`Queue: ${queue.join('; ')}.`)

  const tk = p.tokens
  if (tokenSum(tk) || tk.tools) {
    const input = tk.input + tk.cacheRead + tk.cacheWrite
    const parts = [
      `${amount(input)} in, of them ${amount(tk.cacheRead)} read from the cache and ${amount(tk.cacheWrite)} written to it`,
      `${amount(tk.output)} out${tk.thinking ? `, of them ${amount(tk.thinking)} thinking` : ''}`,
    ]
    let line = `Tokens: ${parts.join('; ')}.`
    const cost = costText(tk)
    if (cost) line += ` ${capital(cost)}${tk.costUnknown ? ` (${plural(tk.costUnknown, 'run')} without a cost)` : ''}.`
    const count = (n, unit) => (n ? `${amount(n)} ${unit}${n === 1 ? '' : 's'}` : `no ${unit}s`)
    line += ` ${capital(count(tk.turns, 'turn'))}, ${count(tk.tools, 'tool call')}, ${count(tk.subagents, 'subagent')}.`
    lines.push(line)
  }

  const g = p.git
  if (r.ended || g.pullsOpened || g.pullsUpdated) {
    const git = []
    git.push(g.commits ? `${plural(g.commits, 'commit')} in ${plural(g.committedRuns, 'run')}` : 'no commits')
    if (g.pushedRuns) git.push(`pushed in ${plural(g.pushedRuns, 'run')}`)
    if (g.files || g.lines) git.push(`${plural(g.files, 'file')} and ${amount(g.lines)} lines changed`)
    let line = `Git: ${git.join(', ')}`
    if (g.pullsOpened || g.pullsUpdated) line += `; ${plural(g.pullsOpened, 'pull request')} opened, ${g.pullsUpdated} updated`
    if (g.scratchFiles) line += `; ${plural(g.scratchFiles, 'file')} made or changed in work folders`
    lines.push(`${line}.`)
  }

  const pr = p.pulls
  if (pr.checks || pr.reviews || pr.comments) {
    const news = []
    if (pr.checks) news.push(`checks finished ${times(pr.checks)}${pr.checksFailed ? `, ${pr.checksFailed} of them with failures` : ''}`)
    if (pr.reviews) {
      const states = [pr.approved && `${pr.approved} approved`, pr.changesRequested && `${pr.changesRequested} with changes requested`].filter(Boolean)
      news.push(`${plural(pr.reviews, 'review')}${states.length ? `, ${states.join(', ')}` : ''}`)
    }
    if (pr.comments) news.push(plural(pr.comments, 'comment'))
    lines.push(`Pull requests: ${news.join('; ')}.`)
  }

  const k = p.killswitch
  const triggers = by(k.triggers, TRIGGERS).replace(/\b1 (by|on) /g, 'once $1 ')
  lines.push(k.locks ? `Kill switch: locked ${times(k.locks)}${triggers ? `; triggered ${triggers}` : ''}.` : 'Kill switch: not locked.')
  return lines
}

// The answer of the controller's tool stats.
export function toolText({ current, total }, { allTime = false } = {}) {
  const p = allTime ? total : current
  const head = `[stats period=${allTime ? 'all-time' : 'this-start'} since=${new Date(p.since).toISOString().slice(0, 16)}Z minutes=${Math.round(p.upMs / 60000)} runs=${p.runs.ended} voice=${p.voice.requests}]`
  return [
    head,
    overviewText(p, { allTime }),
    'Details:',
    ...detailsLines(p, { allTime, total }).map(line => `- ${line}`),
    ...(allTime ? [] : [totalLine(total)]),
    'Answer the driver from the first part in two or three short sentences, in their language, with round numbers; ' +
      'the details only when they ask.' +
      (allTime ? '' : ' For all time, call stats with all_time=true.'),
  ].join('\n')
}

// /stats on Telegram, for the driver.
export function telegramText({ current, total }, { host, allTime = false } = {}) {
  const p = allTime ? total : current
  const head = allTime
    ? `cc-voice-gateway on ${host}: statistics of all time, since ${day(p.since)}.`
    : `cc-voice-gateway on ${host}: statistics since ${when(p.since)}.`
  return [head, overviewText(p, { you: true, allTime }), detailsLines(p, { allTime, total }).join('\n'), ...(allTime ? [] : [totalLine(total)])].join('\n\n')
}

// The message when the gateway shuts down: why, the overview of its running
// time and all time in a line. restart: the watchdog starts it again, and the
// next gateway says when the controller is ready (restart.mjs).
export function shutdownText({ current, total }, { host, restart = false, why = '' } = {}) {
  const head = restart
    ? `cc-voice-gateway on ${host}: the gateway is shutting down now for the restart. Its statistics:`
    : `cc-voice-gateway on ${host}: the gateway is shutting down now${why ? ` (${why})` : ''}. Its statistics:`
  const parts = [head, overviewText(current, { you: true }), totalLine(total)]
  if (restart) parts.push('A message follows when it is ready again.')
  return parts.join('\n\n')
}
