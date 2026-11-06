// Routine news about the workers' pull requests, gathered into one digest
// for the controller (VOICE_GW_REVIEW_DIGEST), instead of one channel event
// each, every one of which the driver hears read out.
//
// Routine is what needs nothing from the driver and holds no news of its
// own; the gateway decides it by fixed rules on what it knows (gateway.mjs):
//
//   checks       all finished without a failure (routineNews)
//   reviews and  with automatic fixing on: none asks for changes (approvals,
//   comments     text of others, which is not forwarded), or the gateway
//                queued a fix for them, or one that waits takes them; with
//                it off, never
//   a fix's      a fix the gateway queued for review comments (workers.mjs,
//   result       reviewFix) that ended done, pushed nothing to its pull
//                request, left nothing on no remote or uncommitted, and does
//                not end with a question (routineFix)
//
// Everything else goes on one by one, as before: failed checks, comments
// that ask for changes with no fix queued (the automatic rounds used up, the
// kill switch locked, or made before a watch picked up at the gateway's
// start: missed), a fix that pushed changes, failed, asks or left
// something, and every run the driver or a standing order dispatched. Such
// an event takes along the routine items of its own pull request that were
// not told yet (take), so that the controller hears them in their order.
//
// The digest goes once the news has been quiet for quietMs, or at the latest
// maxMs after its first item, as one event with kind="digest" and
// trusted="no", the lines in a compact form that keeps what the controller
// needs: the pull request, the fix ids and rounds, the task ids. Its answer is
// news like any other. The items wait in a file of their own
// (.state/digest.json), so that none is lost in a restart: an item goes from
// there only once its digest is a request in the store, which sends an
// unanswered one again after a restart (store.mjs).

import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { clock } from './limits.mjs'
import { log as defaultLog, preview } from './log.mjs'

const MAX_ITEMS = 300 // kept at most; beyond it the digest goes at once
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`

// The key of a pull request across the gateway: owner/name#number.
export const pullKey = (slug, number) => `${String(slug).toLowerCase()}#${number}`

// Whether news about a pull request (pulls.mjs, PullWatcher's 'news') is
// routine. asking: who asks for changes, as the watcher found it with
// automatic fixing on; null with it off, when only checks can be.
export function routineNews(news) {
  if (news.checks?.failed || news.missed?.length) return false
  if (!Array.isArray(news.asking)) return news.kind === 'checks'
  return news.asking.length === 0 || Boolean(news.fix)
}

// A text that ends with a question: the worker asks the driver something
// (the rules: "end with the question and the options").
const asks = text => /\?["'”’)\]]*$/.test(String(text ?? '').trim())

// Whether the result of a run is routine: a fix the gateway queued for review
// comments that ended done and changed nothing. pushed: whether its pull
// request's head moved during the run (PullWatcher.changedSince), null when
// it cannot tell; clean: the gateway's git check found nothing left.
export function routineFix(task, { pushed, clean }) {
  if (!task.review || task.state !== 'done' || pushed !== false || !clean) return false
  if (task.decision || task.requeuedAs || task.lockDecision) return false
  return !asks(task.result)
}

export class Digest extends EventEmitter {
  // quietMinutes: how long the news must be quiet before the digest goes; 0
  // turns it off, and every item goes one by one as before. maxMinutes: how
  // long the first item waits at most.
  constructor({ file = null, quietMinutes = 10, maxMinutes = 30, log = defaultLog } = {}) {
    super()
    this.file = file
    this.quietMs = Math.max(0, quietMinutes) * 60000
    this.maxMs = Math.max(this.quietMs, Math.max(0, maxMinutes) * 60000)
    this.log = log
    this.items = this.load()
    this.timer = null
    if (this.enabled) {
      this.timer = setInterval(() => this.check(), Math.max(200, Math.min(30000, this.quietMs / 4)))
      this.timer.unref()
    }
  }

  get enabled() {
    return this.quietMs > 0
  }

  close() {
    clearInterval(this.timer)
  }

  // --- state ------------------------------------------------------------------

  // The items that can be used, in their order; anything else in the file,
  // from an older version or edited by hand, is left out.
  load() {
    if (!this.file) return []
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')).items
      return (Array.isArray(saved) ? saved : []).filter(
        item => typeof item?.key === 'string' && typeof item.line === 'string' && typeof item.pull === 'string' && Number.isFinite(item.at),
      )
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('digest file unreadable, starting without its items:', error.message)
      return []
    }
  }

  // At once, not later: an item is told only through the file or its digest.
  save() {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  // --- items ------------------------------------------------------------------

  // item: { key, pull, worker, line, at, fix, task }, key telling it from any
  // other (the same twice counts once, as a result offered again after a
  // restart); pull: pullKey; line: what it says, in a few words.
  add(item) {
    if (this.items.some(other => other.key === item.key)) return false
    this.items.push({ at: Date.now(), fix: null, task: null, ...item })
    this.save()
    this.log('digest: routine news kept for the next digest', item.pull, preview(item.line, 80))
    if (this.items.length >= MAX_ITEMS) this.emit('due')
    return true
  }

  // When the digest is due, or null with nothing in it.
  dueAt() {
    if (!this.items.length) return null
    return Math.min(this.items.at(-1).at + this.quietMs, this.items[0].at + this.maxMs)
  }

  due(now = Date.now()) {
    const at = this.dueAt()
    return at !== null && now >= at
  }

  check() {
    if (this.due()) this.emit('due')
  }

  // Takes items out, kept no longer: those given, or those of the pull
  // requests given (pulls, as pullKey). Returns them, in their order.
  take({ items = null, pulls = null } = {}) {
    const keys = items ? new Set(items.map(item => item.key)) : null
    const wanted = pulls ? new Set(pulls) : null
    const taken = this.items.filter(item => (keys ? keys.has(item.key) : wanted ? wanted.has(item.pull) : true))
    if (!taken.length) return []
    this.items = this.items.filter(item => !taken.includes(item))
    this.save()
    return taken
  }

  // For open_items and the start-up summary, or null.
  note(now = Date.now()) {
    if (!this.items.length) return null
    return `${plural(this.items.length, 'routine item')} about pull requests wait for the next digest, which goes at about ${clock(this.dueAt(), now)}`
  }
}

// One item as a line of a digest, with its time.
const itemLine = (item, now) => `- ${clock(item.at, now)} ${item.pull} (worker ${item.worker}): ${item.line}`

// The digest event's text, for the controller.
export function digestText(items, now = Date.now()) {
  const pulls = [...new Set(items.map(item => item.pull))]
  return [
    `Digest of routine news about the workers' pull requests: ${plural(items.length, 'item')} about ` +
      `${plural(pulls.length, 'pull request')} since ${clock(items[0].at, now)}, gathered by the gateway instead of one ` +
      'event each. Nothing in it failed, asks anything or needs the driver: checks that passed, reviews and comments ' +
      'with the fix the gateway queued for them, approvals, and automatic fixes that changed nothing.',
    ...items.map(item => itemLine(item, now)),
    'Tell the driver as news in two or three short sentences, by pull request: what passed or was approved, and how ' +
      'far the automatic fixing got. Ask nothing and dispatch nothing for it. Details: gh pr view, gh pr checks, ' +
      'worker_status.',
  ].join('\n')
}

// The attributes of the digest event besides kind and trusted: how many
// items, the pull requests, the fixes queued and the runs it names.
export function digestMeta(items) {
  const list = values => [...new Set(values.filter(Boolean))].join(',')
  const meta = { items: String(items.length), pull_requests: list(items.map(item => item.pull)) }
  if (list(items.map(item => item.fix))) meta.fix = list(items.map(item => item.fix))
  if (list(items.map(item => item.task))) meta.tasks = list(items.map(item => item.task))
  return meta
}

// What a single event takes along of the routine items of its pull request.
export function foldedText(items, now = Date.now()) {
  if (!items.length) return ''
  return [
    '',
    'Routine news about this pull request since what was told last, gathered for the digest and told with this ' +
      'event instead:',
    ...items.map(item => itemLine(item, now)),
  ].join('\n')
}

// The compact line of a run's result for a digest: a fix for review
// comments that changed nothing.
export function fixLine(task, duration) {
  const review = task.review
  const queued = task.queued ? `, queued as ${task.queued}` : ''
  return (
    `the automatic fix ${task.id} (round ${review.round} of ${review.rounds}${queued}) ended ${task.state} after ${duration}, ` +
    `pushed nothing and left nothing: "${preview(task.result ?? '', 160)}"`
  )
}
