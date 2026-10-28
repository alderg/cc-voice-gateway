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

// Short ids without look-alike characters (no l/1, o/0, i).
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export const REQUEST_STATES = ['sent', 'working', 'question', 'done']
export const CONTROLLER_STATES = ['working', 'question', 'done']

const REQUEST_RETENTION_MS = 6 * 60 * 60 * 1000

// What a request that was not finished says after a restart of the session.
export const RESTART_NOTE =
  'The controller restarted before it finished this request. Say it again if it is still needed.'

export class Store extends EventEmitter {
  // With a file, the requests survive a restart of the gateway, which comes
  // with every restart of the controller session. Approvals do not: they
  // belong to the session that asked.
  constructor({ permissionTtlSeconds = 900, file = null } = {}) {
    super()
    this.setMaxListeners(0) // one listener per waiting long-poll
    this.permissionTtlMs = permissionTtlSeconds * 1000
    this.requests = new Map()
    this.permissions = new Map()
    this.controllerLastReplyAt = null
    this.startedAt = Date.now()
    this.voiceCalls = 0 // voice tool calls in progress
    this.voiceSeenAt = null // start or end of the last voice tool call
    this.file = file
    this.saveTimer = null
    if (file) {
      this.restore()
      this.on('change', () => {
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => this.save(), 100)
      })
    }
  }

  // Answers given before the restart stay deliverable. A voice request the old
  // session had not finished ends with a note, since the new session knows
  // nothing of it. A worker result the controller never answered is marked
  // for sending again (gateway.mjs).
  restore() {
    let saved
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    for (const request of saved.requests ?? []) {
      if (!request?.id) continue
      if (request.origin === 'voice' && request.state !== 'done') {
        request.updates.push({ at: Date.now(), state: 'done', text: RESTART_NOTE })
        request.state = 'done'
      }
      if (request.origin === 'worker' && !request.updates.length) request.resend = true
      this.requests.set(request.id, request)
    }
    this.prune()
    // The restart counts as a voice call, so the voice client gets the usual
    // time to pick up what is left before the Telegram fallback sends it.
    if (this.requests.size) this.voiceSeenAt = Date.now()
  }

  save() {
    if (!this.file) return
    clearTimeout(this.saveTimer)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ requests: [...this.requests.values()] }) + '\n')
      renameSync(tmp, this.file)
    } catch {
      // the requests stay in memory; the next change tries again
    }
  }

  newId(length = 4) {
    for (;;) {
      let id = ''
      for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      if (!this.requests.has(id)) return id
    }
  }

  // --- requests from the voice client or from workers ---------------------

  createRequest(text, { origin = 'voice', worker = null } = {}) {
    const request = {
      id: this.newId(),
      text,
      origin, // voice | worker
      worker, // { repo, task } for a worker result
      state: 'sent',
      createdAt: Date.now(),
      updates: [], // { at, state, text } from the controller
      cursor: 0, // index of the first update the voice client has not seen
      closed: false, // the voice client has received state done
    }
    this.requests.set(request.id, request)
    this.prune()
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
    this.changed()
    return request
  }

  hasUnread(request) {
    return request.cursor < request.updates.length
  }

  takeUnread(request) {
    const fresh = request.updates.slice(request.cursor)
    request.cursor = request.updates.length
    return fresh
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
    this.changed()
    return code
  }

  openPermissions() {
    const now = Date.now()
    const open = []
    for (const [code, permission] of this.permissions) {
      if (permission.status !== 'open') continue
      if (now - permission.createdAt > this.permissionTtlMs) {
        this.permissions.delete(code)
        continue
      }
      open.push(permission)
    }
    return open
  }

  hasUnannouncedPermission() {
    return this.openPermissions().some(p => !p.announced)
  }

  resolvePermission(code, behavior) {
    const permission = this.permissions.get(String(code).toLowerCase())
    if (!permission || permission.status !== 'open') return null
    permission.status = behavior
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
      if (request.createdAt < cutoff) this.requests.delete(id)
    }
  }
}
