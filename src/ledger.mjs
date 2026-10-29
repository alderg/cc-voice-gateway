// Open decisions: what the driver still has to decide, so that no question
// gets forgotten, also when the controller session restarts. The gateway
// keeps them in .state/jobs.json. Together with the queue (workers.mjs) and
// the requests (store.mjs) they are the open items, which the controller
// gets with open_items and in one event at every start of its session.
//
// Where a decision comes from:
//   push    the check after a run found commits on no remote or new
//           uncommitted files (workers.mjs), whatever the worker wrote; or
//           the gateway's own checkout has them (gateway.mjs)
//   other   a queued task that could not start; a question of the
//           controller that names no other kind
//   merge, restart, delete   questions of the controller that name the kind
//
// Its states: pending (raised, nobody asked the driver yet), asked (the
// controller replied with state "question" on one of its requests), answered
// (the driver answered that request: "(Answer to <id>) ..."; the answer's
// request belongs to it from then on, so that a question back on it is the
// same decision), closed. It closes with resolve_decision on the driver's
// words, when the follow-up dispatch for the answer starts (workers.mjs), or
// when the controller replies "done" to the answer, unless that follow-up
// still waits in the queue. While a decision of a repository is open, the
// queued tasks there wait. The controller cannot reply "done" to a request
// whose decision it never asked about (channel.mjs). A decision not asked
// yet, or asked and not answered, gets a reminder after
// VOICE_GW_REMIND_MINUTES, at most three times (gateway.mjs): also one that
// belongs to no request, such as the one a stop_worker raised.
//
// The texts are the gateway's, the controller's and the driver's answer.
// The controller's may quote what a worker or GitHub said, a pull request's
// title for example, so the events that carry them are marked trusted="no".

import { randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log as defaultLog, preview } from './log.mjs'

export const DECISION_KINDS = ['push', 'merge', 'restart', 'delete', 'other']
const STATES = ['pending', 'asked', 'answered', 'closed']

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const KEEP_CLOSED = 100 // closed decisions kept for reference, the newest
const CLOSED_MS = 7 * 24 * 60 * 60 * 1000 // and no older than this

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`

export function ago(at, now = Date.now()) {
  const minutes = Math.round((now - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 90) return `${plural(minutes, 'minute')} ago`
  return `${plural(Math.round(minutes / 60), 'hour')} ago`
}

// A saved decision the gateway can work with; anything else in the file is
// left out instead of stopping the start.
const usable = d =>
  d !== null &&
  typeof d === 'object' &&
  typeof d.id === 'string' &&
  DECISION_KINDS.includes(d.kind) &&
  STATES.includes(d.state) &&
  typeof d.text === 'string' &&
  Array.isArray(d.requests) &&
  Number.isFinite(d.createdAt)

// The fields a usable decision may lack, from an older version or edited by
// hand, with what they mean when missing.
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback)
const normal = d => ({
  repo: null,
  scope: null,
  question: null,
  answer: null,
  answeredBy: null,
  outcome: null,
  closedBy: null,
  ...d,
  requests: d.requests.filter(id => typeof id === 'string'),
  updatedAt: finite(d.updatedAt, d.createdAt),
  askedAt: finite(d.askedAt, d.state === 'asked' ? d.createdAt : null),
  answeredAt: finite(d.answeredAt, d.state === 'answered' ? d.createdAt : null),
  reminders: finite(d.reminders, 0),
  remindedAt: finite(d.remindedAt, null),
  closedAt: finite(d.closedAt, d.state === 'closed' ? d.createdAt : null),
  details: d.details !== null && typeof d.details === 'object' ? d.details : {},
})

export class Ledger {
  constructor({ file = null, remindMinutes = 30, maxReminders = 3, log = defaultLog } = {}) {
    this.file = file
    this.remindMs = remindMinutes * 60 * 1000
    this.maxReminders = maxReminders
    this.log = log
    this.decisions = this.load()
  }

  // --- state --------------------------------------------------------------

  load() {
    if (!this.file) return []
    let saved
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') this.log(`decisions file ${this.file} unreadable, starting without: ${error.message}`)
      return []
    }
    const all = Array.isArray(saved?.decisions) ? saved.decisions : []
    const kept = all.filter(usable).map(normal)
    if (kept.length < all.length) this.log(`decisions file ${this.file}: skipped ${all.length - kept.length} unusable`)
    return kept
  }

  // Atomic, folder 0700 and file 0600: the texts hold what the driver said.
  // A failed save keeps the decisions in this gateway.
  save() {
    this.prune()
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ decisions: this.decisions }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('decisions not saved, kept in this gateway:', error.message)
    }
  }

  prune() {
    const cutoff = Date.now() - CLOSED_MS
    const closed = this.decisions.filter(d => d.state === 'closed')
    const keep = new Set(closed.slice(-KEEP_CLOSED).filter(d => (d.closedAt ?? 0) >= cutoff))
    this.decisions = this.decisions.filter(d => d.state !== 'closed' || keep.has(d))
  }

  newId() {
    for (;;) {
      let id = 'd'
      for (let i = 0; i < 3; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      if (!this.decisions.some(d => d.id === id)) return id
    }
  }

  // --- looking up -----------------------------------------------------------

  get(id) {
    const wanted = String(id ?? '').trim().toLowerCase()
    return this.decisions.find(d => d.id === wanted) ?? null
  }

  open() {
    return this.decisions.filter(d => d.state !== 'closed')
  }

  // The decisions raised or asked on a request; open ones unless `closed`.
  forRequest(requestId, { closed = false } = {}) {
    return this.decisions.filter(d => (closed || d.state !== 'closed') && d.requests.includes(requestId))
  }

  // The open decisions of a repository: while there are any, its queue waits.
  forRepo(repo) {
    return this.open().filter(d => d.repo === repo)
  }

  // Whether the store must keep a request: an open decision belongs to it.
  needs(requestId) {
    return this.open().some(d => d.requests.includes(requestId))
  }

  // --- changes --------------------------------------------------------------

  // repo: the worker repository whose queue it holds, or null; scope: what
  // else it is about ('gateway': the gateway's own checkout).
  add({ kind = 'other', repo = null, scope = null, text, requestId = null, details = {}, state = 'pending' }) {
    const now = Date.now()
    const decision = {
      id: this.newId(),
      kind: DECISION_KINDS.includes(kind) ? kind : 'other',
      repo,
      scope,
      text: preview(text, 300),
      requests: requestId ? [requestId] : [], // the first is where it was raised; then where it was asked
      state,
      createdAt: now,
      updatedAt: now,
      askedAt: state === 'asked' ? now : null,
      question: null,
      answer: null,
      answeredAt: null,
      answeredBy: null, // the request with the driver's answer
      reminders: 0,
      remindedAt: null,
      outcome: null,
      closedAt: null,
      closedBy: null, // driver (resolve_decision), dispatch, reply, gateway
      details, // for the gateway: commits and files of a push, the queued task, a fingerprint
    }
    this.decisions.push(decision)
    this.save()
    this.log('decision', decision.id, decision.kind, repo ?? scope ?? '-', state, preview(text, 80))
    return decision
  }

  link(decision, requestId) {
    if (!decision || !requestId || decision.requests.includes(requestId)) return
    decision.requests.push(requestId)
    decision.updatedAt = Date.now()
    this.save()
  }

  // The controller asked the driver on a request (reply, state "question"):
  // about the decisions it names, or else those of that request, or else a
  // new one, from the question. Returns { asked, created, unknown }.
  ask(requestId, { ids = [], kind = 'other', repo = null, text = '' } = {}) {
    const isOpen = d => Boolean(d) && d.state !== 'closed'
    const unknown = ids.filter(id => !isOpen(this.get(id)))
    let asked = ids.length ? ids.map(id => this.get(id)).filter(isOpen) : this.forRequest(requestId)
    let created = null
    if (!asked.length) {
      created = this.add({ kind, repo, text, requestId, state: 'asked' })
      asked = [created]
    }
    const now = Date.now()
    for (const d of asked) {
      if (!d.requests.includes(requestId)) d.requests.push(requestId)
      Object.assign(d, { state: 'asked', askedAt: now, question: preview(text, 300), updatedAt: now })
    }
    this.save()
    return { asked, created, unknown }
  }

  // The driver answered a request ("(Answer to <id>) ..."): its open
  // decisions keep the answer, and wait for the controller to act on it.
  // The answer's request belongs to them too: a question back on it asks the
  // same decision, and the follow-up for an answer to that is theirs.
  answer(requestId, { text, answerId }) {
    const answered = this.forRequest(requestId)
    const now = Date.now()
    for (const d of answered) {
      Object.assign(d, { state: 'answered', answer: preview(text, 300), answeredAt: now, answeredBy: answerId, updatedAt: now })
      if (answerId && !d.requests.includes(answerId)) d.requests.push(answerId)
    }
    if (answered.length) {
      this.save()
      this.log('answered', answered.map(d => d.id).join(', '), 'by', answerId)
    }
    return answered
  }

  close(decision, { outcome, by, words = null }) {
    if (!decision || decision.state === 'closed') return null
    const now = Date.now()
    Object.assign(decision, { state: 'closed', outcome: preview(outcome, 300), closedAt: now, closedBy: by, updatedAt: now })
    if (words) decision.words = preview(words, 200)
    this.save()
    this.log('decision closed', decision.id, `by ${by}:`, preview(outcome, 80))
    return decision
  }

  // The controller replied "done" to the request with the driver's answer:
  // what that answer decided is settled, unless waiting(d) says that its
  // follow-up still waits in the queue; that one closes it when it starts.
  // Returns the decisions it closed.
  settle(answerId, outcome, { waiting = () => false } = {}) {
    return this.open()
      .filter(d => d.state === 'answered' && d.answeredBy === answerId && !waiting(d))
      .map(d => this.close(d, { outcome, by: 'reply' }))
  }

  // Not asked yet, or asked and not answered, and quiet for the reminder
  // time since it was raised or asked, or since the last reminder; at most
  // maxReminders times.
  due(now = Date.now()) {
    return this.open().filter(d => {
      if (!['pending', 'asked'].includes(d.state) || d.reminders >= this.maxReminders) return false
      const since = d.state === 'asked' ? (d.askedAt ?? d.createdAt) : d.createdAt
      return now - Math.max(since, d.remindedAt ?? 0) >= this.remindMs
    })
  }

  reminded(decision, requestId) {
    decision.reminders++
    decision.remindedAt = Date.now()
    if (!decision.requests.includes(requestId)) decision.requests.push(requestId)
    this.save()
  }
}

// --- texts for the controller ---------------------------------------------------

// What a decision is about: its repository, the gateway's own checkout, or
// the repository a queued task was for, without holding it (the kill switch).
const place = d => d.repo ?? (d.scope === 'gateway' ? "the gateway's checkout" : (d.details?.queued?.worker ?? null))

// The event at every start of the controller session: what is open, so that
// a restarted controller knows it without memory files.
export function startupText(items) {
  return (
    'The controller session has started. What is open, as the gateway kept it; work from this, not from memory ' +
    `files:\n${items}\n` +
    'Reply "done" to this event; the driver does not hear it. Put decisions not asked yet to the driver in your next ' +
    'answer, or now with state "question" on their request_id and decisions="<id>"; the driver hears that as news. ' +
    'Events not answered yet follow as events of their own.'
  )
}

// The reminder for a decision the driver was never asked about, or has not
// answered.
export function reminderText(d, max, now = Date.now()) {
  const where = place(d) ? `, ${place(d)}` : ''
  const head = `Reminder ${d.reminders + 1} of ${max}: decision ${d.id} (${d.kind}${where})`
  const how =
    `reply to this request_id with state "question" and decisions="${d.id}". The answer then arrives as ` +
    '"(Answer to <this request_id>) ...".'
  if (d.state === 'pending') {
    return (
      `${head}, raised ${ago(d.createdAt, now)}, was never put to the driver: "${d.text}". Ask them now, in one ` +
      `sentence: ${how} "done" on this request is refused until you asked.`
    )
  }
  return (
    `${head}: the driver has not answered it, asked ${ago(d.askedAt, now)}: "${d.question ?? d.text}". Ask again in ` +
    `one sentence: ${how} If they decided in another request already, close it with resolve_decision and their words.`
  )
}

// One decision in a line: id, kind, where, state, then its text.
export function decisionLine(d, now = Date.now()) {
  const where = place(d)
  const last = d.requests.at(-1)
  const reminded = d.reminders ? `, reminded ${plural(d.reminders, 'time')}` : ''
  const state = {
    pending: `${last ? `not asked yet (request ${last})` : 'not asked yet, on no request'}${reminded}`,
    asked: `asked ${ago(d.askedAt, now)}${last ? ` on request ${last}` : ''}, no answer yet${reminded}`,
    answered: `answered ${ago(d.answeredAt, now)} ("${preview(d.answer ?? '', 120)}"), not closed yet`,
    closed: `closed: ${d.outcome}`,
  }[d.state]
  return `${d.id} ${d.kind}${where ? `, ${where}` : ''}, ${state}: ${d.text}`
}

// Everything open, for open_items and the start-up summary: decisions, queued
// tasks, runs going, voice requests not finished, events not answered yet.
// interrupted: voice requests a restart ended (store.mjs). Texts of the
// gateway, the controller and the driver, where the controller's may quote a
// worker or GitHub; of a worker's result only its ids.
export function openItems({ ledger, workers = null, store, interrupted = [], now = Date.now() }) {
  const decisions = ledger.open()
  const queued = workers?.queued() ?? []
  const running = workers?.running() ?? []
  const requests = [...store.requests.values()]
  const voice = requests.filter(r => r.origin === 'voice' && r.state !== 'done')
  const unanswered = requests.filter(r => r.origin === 'worker' && !r.updates.length)
  const ended = interrupted.map(id => store.getRequest(id)).filter(Boolean)
  const head =
    `[open decisions=${decisions.length} queued=${queued.length} running=${running.length} ` +
    `requests=${voice.length} unanswered=${unanswered.length}]`
  const lines = [head]
  if (decisions.length) {
    lines.push('Decisions:', ...decisions.map(d => `- ${decisionLine(d, now)}`))
  }
  if (queued.length) {
    const held = entry => ledger.forRepo(entry.worker).filter(d => !entry.answers || !d.requests.includes(entry.answers))
    lines.push(
      'Queued tasks:',
      ...queued.map(entry => {
        const holds = held(entry).map(d => d.id)
        return (
          `- ${entry.id} for ${entry.worker}, queued ${ago(entry.queuedAt, now)}` +
          `${holds.length ? `, held by ${holds.join(', ')}` : ''}: "${preview(entry.task, 100)}"`
        )
      }),
    )
  }
  if (running.length) {
    lines.push(
      'Runs going:',
      ...running.map(t => `- ${t.repo} ${t.id}, started ${ago(t.startedAt, now)}: "${preview(t.task, 100)}"`),
    )
  }
  if (voice.length) {
    lines.push('Voice requests not finished:', ...voice.map(r => `- ${r.id} (${r.state}, ${ago(r.createdAt, now)}): "${preview(r.text, 100)}"`))
  }
  if (ended.length) {
    lines.push(
      'Ended by the restart (the driver heard to say them again):',
      ...ended.map(r => `- ${r.id}: "${preview(r.text, 100)}"`),
    )
  }
  if (unanswered.length) {
    const what = r => [r.meta?.kind, r.meta?.worker, r.meta?.task].filter(Boolean).join(' ')
    lines.push(`Events you have not answered yet: ${unanswered.map(r => `${r.id} (${what(r) || 'worker'})`).join(', ')}.`)
  }
  if (lines.length === 1) lines.push('Nothing is open: no decisions, no queued tasks, no runs, no unfinished requests.')
  return lines.join('\n')
}
