// In-memory state shared by the two sides of the gateway:
// the voice side (HTTP MCP) and the channel side (stdio to Claude Code).
//
// Claude Code does not acknowledge channel events, so the gateway itself has to
// track each request until the controller has answered it.
//
// Most requests come from the voice client. Worker results become requests
// too (origin "worker"): the controller answers them with reply like any
// other, and the voice client gets those answers as news with its next call.
// So do late answers to a voice request whose "done" was already delivered.

import { EventEmitter } from 'node:events'
import { randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log as defaultLog } from './log.mjs'

// Short ids without look-alike characters (no l/1, o/0, i).
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export const REQUEST_STATES = ['sent', 'working', 'question', 'done']
export const CONTROLLER_STATES = ['working', 'question', 'done']

const REQUEST_RETENTION_MS = 6 * 60 * 60 * 1000
const SAVE_DELAY_MS = 100

// What a request that was not finished says after a restart of the session.
export const RESTART_NOTE =
  'The controller restarted before it finished this request. Say it again if it is still needed.'

export class Store extends EventEmitter {
  // With a file, the requests survive a restart of the gateway, which comes
  // with every restart of the controller session. Approvals do not: they
  // belong to the session that asked. keep(id): whether a request must stay
  // past the retention time, because an open decision belongs to it
  // (ledger.mjs).
  constructor({ permissionTtlSeconds = 900, file = null, keep = () => false, log = defaultLog } = {}) {
    super()
    this.setMaxListeners(0) // one listener per waiting long-poll
    this.log = log
    this.keep = keep
    this.permissionTtlMs = permissionTtlSeconds * 1000
    this.requests = new Map()
    this.permissions = new Map()
    this.controllerLastReplyAt = null
    this.startedAt = Date.now()
    this.voiceCalls = 0 // voice tool calls in progress
    this.voiceSeenAt = null // start or end of the last voice tool call
    this.interrupted = [] // ids of voice requests that the restore ended with the note
    this.file = file
    this.saveTimer = null
    if (file) {
      this.restore()
      this.on('change', () => this.saveSoon())
    }
  }

  // Answers given before the restart stay deliverable. A voice request the old
  // session had not finished ends with a note, since the new session knows
  // nothing of it; a question to the driver stays open, since its decision
  // is kept (ledger.mjs) and the new session hears of it. A worker result
  // the controller never answered is marked for sending again (gateway.mjs).
  restore() {
    let saved
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log(`requests file ${this.file} unreadable, starting without the saved requests: ${error.message}`)
      }
      return
    }
    if (!Array.isArray(saved?.requests)) {
      this.log(`requests file ${this.file} holds no list of requests, starting without the saved requests`)
      return
    }
    let skipped = 0
    for (const request of saved.requests) {
      if (!usable(request)) {
        skipped++
        continue
      }
      request.closed = request.closed === true
      if (request.origin === 'voice' && request.state !== 'done' && request.state !== 'question') {
        request.updates.push({ at: Date.now(), state: 'done', text: RESTART_NOTE })
        request.state = 'done'
        this.interrupted.push(request.id)
      }
      if (request.origin === 'worker' && !request.updates.length) request.resend = true
      this.requests.set(request.id, request)
    }
    if (skipped) {
      this.log(`requests file ${this.file}: skipped ${skipped} unusable entr${skipped === 1 ? 'y' : 'ies'}`)
    }
    this.prune()
    this.interrupted = this.interrupted.filter(id => this.requests.has(id))
    // The restart counts as a voice call, so the voice client gets the usual
    // time to pick up what is left before the Telegram fallback sends it.
    if (this.requests.size) this.voiceSeenAt = Date.now()
  }

  // Requests hold what the driver said and what the controller answered:
  // folder 0700 and file 0600 when the gateway creates them.
  save() {
    if (!this.file) return
    clearTimeout(this.saveTimer)
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ requests: [...this.requests.values()] }) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      // the requests stay in memory; the next change tries again
    }
  }

  // Saves after a short delay, so that a burst of changes is written once.
  // Without the 'change' event: what the voice client has read must reach the
  // file too, but it must not wake the long-polls or the Telegram fallback.
  saveSoon() {
    if (!this.file) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS)
  }

  newId(length = 4) {
    for (;;) {
      let id = ''
      for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      if (!this.requests.has(id)) return id
    }
  }

  // --- requests from the voice client or from workers ---------------------

  // answers: for the driver's answer to a question, the id of the question's
  // request; the 'answer' event tells the open decisions (gateway.mjs).
  createRequest(text, { origin = 'voice', worker = null, answers = null } = {}) {
    const request = {
      id: this.newId(),
      text,
      origin, // voice | worker (its answers are news) | alarm, gateway (for the controller only)
      worker, // { repo, task } for a worker result
      state: 'sent',
      createdAt: Date.now(),
      updates: [], // { at, state, text } from the controller
      cursor: 0, // index of the first update the voice client has not seen
      closed: false, // the voice client has received state done
    }
    if (answers) request.answers = answers
    this.requests.set(request.id, request)
    this.prune()
    if (answers) this.emit('answer', request)
    this.emit('request', request) // for the statistics (stats.mjs)
    this.changed()
    return request
  }

  getRequest(id) {
    return this.requests.get(String(id).trim().toLowerCase())
  }

  openRequests() {
    return [...this.requests.values()].filter(r => r.origin === 'voice' && r.state !== 'done')
  }

  // --- answers from the controller ----------------------------------------

  addUpdate(id, state, text) {
    const request = this.getRequest(id)
    if (!request) return null
    request.updates.push({ at: Date.now(), state, text })
    request.state = state
    this.controllerLastReplyAt = Date.now()
    this.emit('reply', request, state) // for the statistics
    this.changed()
    return request
  }

  hasUnread(request) {
    return request.cursor < request.updates.length
  }

  takeUnread(request) {
    const fresh = request.updates.slice(request.cursor)
    if (fresh.length) {
      request.cursor = request.updates.length
      this.saveSoon() // otherwise a restart would deliver it again, by Telegram
    }
    return fresh
  }

  // The voice client has received state done: later answers are news.
  markClosed(request) {
    if (request.closed) return
    request.closed = true
    this.saveSoon()
  }

  // The driver answered a question with a new request (send with in_reply_to).
  // The question is settled: not open any more, and nothing of it is left to
  // deliver, by voice or by Telegram.
  markAnswered(request, answerId) {
    request.state = 'done'
    request.answeredBy = answerId
    request.cursor = request.updates.length
    request.closed = true
    this.changed()
  }

  // News: answers the voice client gets with whatever it calls next, because
  // nobody polls for them by id.
  newsSources(except) {
    return [...this.requests.values()].filter(
      r => r !== except && (r.origin === 'worker' || r.closed) && this.hasUnread(r),
    )
  }

  hasNews(except) {
    return this.newsSources(except).length > 0
  }

  takeNews(except) {
    return this.newsSources(except).flatMap(request =>
      this.takeUnread(request).map(update => ({ id: request.id, ...update })),
    )
  }

  // --- permission prompts relayed by Claude Code --------------------------

  addPermission({ request_id, tool_name, description, input_preview }) {
    this.prunePermissions()
    const code = String(request_id).toLowerCase()
    this.permissions.set(code, {
      code,
      toolName: tool_name,
      description,
      inputPreview: input_preview,
      createdAt: Date.now(),
      status: 'open', // open | allow | deny
      announced: false, // reported to the voice client at least once
    })
    this.emit('permission', this.permissions.get(code)) // for the statistics
    this.changed()
    return code
  }

  openPermissions() {
    this.prunePermissions()
    return [...this.permissions.values()].filter(permission => permission.status === 'open')
  }

  // Open approvals leave after the TTL; answered ones too, counted from the
  // answer, so that a second answer still hears "already answered" for a while.
  prunePermissions() {
    const now = Date.now()
    for (const [code, permission] of this.permissions) {
      const since = permission.status === 'open' ? permission.createdAt : (permission.resolvedAt ?? permission.createdAt)
      if (now - since > this.permissionTtlMs) this.permissions.delete(code)
    }
  }

  hasUnannouncedPermission() {
    return this.openPermissions().some(p => !p.announced)
  }

  resolvePermission(code, behavior) {
    const permission = this.permissions.get(String(code).toLowerCase())
    if (!permission || permission.status !== 'open') return null
    permission.status = behavior
    permission.resolvedAt = Date.now()
    this.emit('permission', permission)
    this.changed()
    return permission
  }

  // --- whether the voice client is still there ----------------------------

  // The voice mode is on while a voice tool call runs and for `idleMs` after
  // the last one; see telegram.mjs. A separate event, so that it does not wake
  // the waiting long-polls.
  voiceCallStarted() {
    this.voiceCalls++
    this.voiceSeen()
  }

  voiceCallEnded() {
    this.voiceCalls = Math.max(0, this.voiceCalls - 1)
    this.voiceSeen()
  }

  voiceSeen() {
    this.voiceSeenAt = Date.now()
    this.emit('voice')
  }

  voiceActive(idleMs) {
    return this.voiceCalls > 0 || (this.voiceSeenAt !== null && Date.now() - this.voiceSeenAt < idleMs)
  }

  // --- waiting ------------------------------------------------------------

  changed() {
    this.emit('change')
  }

  // Resolves true as soon as predicate() holds, false after `ms` or on abort.
  waitFor(predicate, ms, signal) {
    if (predicate()) return Promise.resolve(true)
    return new Promise(resolve => {
      let timer
      const finish = value => {
        clearTimeout(timer)
        this.off('change', onChange)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onChange = () => {
        if (predicate()) finish(true)
      }
      const onAbort = () => finish(false)
      timer = setTimeout(() => finish(false), ms)
      this.on('change', onChange)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  prune() {
    const cutoff = Date.now() - REQUEST_RETENTION_MS
    for (const [id, request] of this.requests) {
      if (request.createdAt < cutoff && !this.keep(id)) this.requests.delete(id)
    }
  }
}

// A saved request the gateway can work with. Anything else in the file, from
// an older version or edited by hand, is skipped instead of stopping the start.
function usable(request) {
  return (
    request !== null &&
    typeof request === 'object' &&
    typeof request.id === 'string' &&
    request.id !== '' &&
    typeof request.text === 'string' &&
    typeof request.origin === 'string' &&
    REQUEST_STATES.includes(request.state) &&
    Number.isFinite(request.createdAt) &&
    Array.isArray(request.updates) &&
    request.updates.every(update => update !== null && typeof update === 'object' && typeof update.text === 'string') &&
    Number.isInteger(request.cursor) &&
    request.cursor >= 0 &&
    request.cursor <= request.updates.length
  )
}
