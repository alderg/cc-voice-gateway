// Standby when the connector is disconnected (VOICE_GW_DISCONNECT_STANDBY, on
// by default). A connector removed in claude.ai goes on calling the gateway's
// address without a token when a voice session starts, and an open question
// of the controller would go on to Telegram as reminders: the gateway should
// fall silent instead, until it is connected again.
//
// What counts as a disconnect, from what the gateway can see:
//   - the connector revokes its token (RFC 7009, /oauth/revoke), or its grant
//     is revoked at the computer (scripts/pair.mjs revoke), and no connector
//     grant is left;
//   - voice requests from Anthropic's addresses without a token, or with one
//     the gateway does not know, while the last connector grant has not been
//     used (no call, no refresh) for unusedMs, 10 minutes, and then for
//     graceMs, 15 more minutes, neither a use of a grant nor a new sign-in
//     follows. The hourly refresh comes with the expired token, which the
//     gateway knows (reason expired), and is itself a use, so it never
//     counts; a connector being connected again signs in within a pairing
//     code's ten minutes, which the grace waits for. Local callers and other
//     addresses never count, nor a gateway that has no connector grant at all
//     (one that was never connected).
//
// The state, on and why, survives a restart (.state/standby.json). A new
// sign-in leaves it. What standby means for the rest of the gateway, the
// gateway wires to 'enter' and 'leave' (gateway.mjs).

import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ANTHROPIC_RANGES } from './config.mjs'
import { inRanges, parseRange } from './ipguard.mjs'
import { log as defaultLog } from './log.mjs'
import { lastUse } from './oauth.mjs'

const ANTHROPIC = ANTHROPIC_RANGES.map(parseRange)
const minutes = ms => `${Math.round(ms / 60000)} minutes`

export class Standby extends EventEmitter {
  constructor({ file, auth, enabled = true, unusedMs = 10 * 60 * 1000, graceMs = 15 * 60 * 1000, log = defaultLog }) {
    super()
    this.file = file
    this.auth = auth
    this.enabled = enabled
    this.unusedMs = unusedMs
    this.graceMs = graceMs
    this.log = log
    this.suspect = null // { since, timer }: calls without a token while the grant went unused
    this.state = this.load()
    auth.on('revoked', event => this.revoked(event))
    auth.on('connected', event => this.connected(event))
  }

  get active() {
    return this.state.on
  }

  close() {
    clearTimeout(this.suspect?.timer)
    this.suspect = null
  }

  load() {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (data?.on === true) return { on: true, reason: String(data.reason ?? 'the connector was disconnected'), at: Number(data.at) || Date.now() }
    } catch {
      // none yet, or unreadable: not in standby
    }
    return { on: false, reason: null, at: null }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  // A revocation that leaves no connector grant.
  revoked({ grants, by, left }) {
    if (!this.enabled || this.active || left > 0 || grants.every(g => g.local)) return
    this.enter(by === 'client' ? 'the connector revoked its sign-in' : 'its sign-in was revoked at the computer')
  }

  connected({ grant }) {
    this.calm()
    if (this.active) this.leave(`a new sign-in (${grant.client ?? 'a client'})`)
  }

  // A voice request without a valid token (voice.mjs), from whoever called.
  refused(caller, reason) {
    if (!this.enabled || this.active || this.suspect) return
    if (caller.via === 'local' || !['missing', 'unknown'].includes(reason) || !inRanges(caller.address, ANTHROPIC)) return
    const grants = this.auth.connectorGrants()
    if (!grants.length) return
    const used = Math.max(...grants.map(lastUse))
    if (Date.now() - used < this.unusedMs) return
    const since = Date.now()
    this.log(
      `standby: a voice request without a valid token from ${caller.address} while the connector's sign-in has not ` +
        `been used for ${minutes(Date.now() - used)}; standby in ${minutes(this.graceMs)} unless it is used or signs in again`,
    )
    const timer = setTimeout(() => this.check(since), this.graceMs)
    timer.unref?.()
    this.suspect = { since, timer }
  }

  // After the grace: no grant used and no new sign-in since the first call.
  check(since) {
    this.suspect = null
    if (this.active) return
    const grants = this.auth.connectorGrants()
    if (!grants.length) return
    if (grants.some(g => lastUse(g) >= since)) {
      this.log('standby: the connector was used meanwhile; no standby')
      return
    }
    this.enter(`voice requests without a token came while its sign-in went unused for more than ${minutes(this.unusedMs + this.graceMs)}`)
  }

  calm() {
    clearTimeout(this.suspect?.timer)
    this.suspect = null
  }

  enter(reason) {
    this.calm()
    this.state = { on: true, reason, at: Date.now() }
    this.save()
    this.log(`standby: the connector was disconnected (${reason}); switching off until a new sign-in`)
    this.emit('enter', { reason })
  }

  leave(why) {
    const was = this.state
    this.state = { on: false, reason: null, at: null }
    this.save()
    this.log(`standby ends: ${why}`)
    this.emit('leave', { why, since: was.at })
  }
}
