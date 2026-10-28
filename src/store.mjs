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

// Short ids without look-alike characters (no l/1, o/0, i).
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export const REQUEST_STATES = ['sent', 'working', 'question', 'done']
export const CONTROLLER_STATES = ['working', 'question', 'done']

const REQUEST_RETENTION_MS = 6 * 60 * 60 * 1000

export class Store extends EventEmitter {
  constructor({ permissionTtlSeconds = 900 } = {}) {
    super()
    this.setMaxListeners(0) // one listener per waiting long-poll
    this.permissionTtlMs = permissionTtlSeconds * 1000
    this.requests = new Map()
    this.permissions = new Map()
    this.controllerLastReplyAt = null
    this.startedAt = Date.now()
  }

  newId(length = 4) {
    for (;;) {
      let id = ''
      for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      if (!this.requests.has(id)) return id
    }
  }

  // --- requests from the voice client or from workers ---------------------

  createRequest(text, { origin = 'voice' } = {}) {
    const request = {
      id: this.newId(),
      text,
      origin, // voice | worker
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
