// The Tailscale Funnel on demand. From the configured Telegram chat, /funnel on
// (or "keep alive") and /funnel off switch it, and /funnel says whether it is
// on; every command gets an answer, a start a second one once Claude's servers
// can reach the gateway. With VOICE_GW_FUNNEL_IDLE minutes set, the gateway
// also turns the Funnel off by itself that long after the last voice call,
// and says on Telegram how to turn it on again. 0, the default, leaves it on.
//
// It runs scripts/funnel.sh (start, stop, state), which needs
// `sudo tailscale set --operator=$USER` once. The idle time counts from the
// last voice call, from the last time the Funnel was turned on from here, and
// from the start of the gateway, whichever is latest.

import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { log as defaultLog, preview } from './log.mjs'

const START_TIMEOUT_MS = 5 * 60 * 1000 // tailscale, then up to two minutes for the relays

const AGAIN = 'To turn it on again: /funnel on, or reply "keep alive".'

export class FunnelSwitch {
  constructor({ script, store, idleMinutes = 0, say = async () => {}, log = defaultLog }) {
    this.script = script
    this.store = store // voiceActive(): whether a voice call came within a time
    this.idleMs = idleMinutes > 0 ? idleMinutes * 60 * 1000 : 0
    this.idleMinutes = idleMinutes
    this.say = say // a message to the driver's Telegram chat
    this.log = log
    this.activeAt = Date.now()
    this.busy = null // 'on' or 'off' while funnel.sh runs
    this.timer = null
    if (this.idleMs) {
      // Often enough to be on time, at most once a minute.
      this.timer = setInterval(() => this.checkIdle(), Math.min(60000, Math.max(100, this.idleMs / 10)))
      this.timer.unref()
    }
  }

  close() {
    clearInterval(this.timer)
  }

  run(command, timeout = 60000) {
    return new Promise(resolve => {
      execFile('bash', [this.script, command], { timeout }, (error, stdout, stderr) => {
        resolve({ ok: !error, out: `${stdout}\n${stderr}`.split('\n').map(line => line.trim()).filter(Boolean) })
      })
    })
  }

  // 'on', 'off', or null when funnel.sh cannot tell.
  async state() {
    const { ok, out } = await this.run('state')
    return ok && ['on', 'off'].includes(out[0]) ? out[0] : null
  }

  idleText() {
    return this.idleMs
      ? `It goes off by itself ${this.idleMinutes} minutes after the last voice call.`
      : 'It stays on until /funnel off.'
  }

  // A Telegram command: on, off or status. Never throws.
  async command(action) {
    try {
      if (action === 'on') return await this.on()
      if (action === 'off') return await this.off()
      const state = await this.state()
      await this.say(
        state === 'on'
          ? `The Funnel is on. ${this.idleText()}`
          : state === 'off'
            ? `The Funnel is off. ${AGAIN}`
            : 'The Funnel state is unknown: scripts/funnel.sh state failed. Look at it at the computer.',
      )
    } catch (error) {
      this.log('funnel command failed:', error.message)
    }
  }

  async on() {
    this.activeAt = Date.now() // a "keep alive" counts, also while it is on
    if (this.busy) return this.say(`The Funnel is being turned ${this.busy} already; wait for that message.`)
    if ((await this.state()) === 'on') return this.say(`The Funnel is on already. ${this.idleText()}`)
    this.busy = 'on'
    try {
      await this.say("Turning the Funnel on. I'll tell you when Claude's servers can reach it, within about two minutes.")
      const { ok, out } = await this.run('start', START_TIMEOUT_MS)
      this.activeAt = Date.now()
      const url = out.findLast(line => /^https:\/\/\S+\/mcp$/.test(line))
      const check = out.find(line => line.startsWith('Public check:'))?.replace(/^Public check:\s*/, '')
      this.log('funnel on from Telegram:', ok ? `${url ?? '?'}; ${check ?? 'no relay check'}` : preview(out.join(' '), 200))
      if (!ok) {
        return this.say(`The Funnel did not come on: ${preview(out.at(-1) ?? 'scripts/funnel.sh start failed', 200)}`)
      }
      const relays = /^all \d+ Funnel relays answer/.test(check ?? '')
        ? `Claude's servers can reach it: ${check}`
        : `Not every relay answers yet (${check ?? 'no relay check'}); voice calls may fail for a few minutes.`
      return this.say(`The Funnel is on${url ? `: ${url}` : ''}. ${relays} ${this.idleText()}`)
    } finally {
      this.busy = null
    }
  }

  async off({ auto = false } = {}) {
    if (this.busy) return this.say(`The Funnel is being turned ${this.busy} already; wait for that message.`)
    const before = await this.state()
    if (before === 'off' && !auto) return this.say(`The Funnel is off already. ${AGAIN}`)
    this.busy = 'off'
    try {
      const { ok, out } = await this.run('stop')
      this.log(`funnel off${auto ? ` after ${this.idleMinutes} minutes without a voice call` : ' from Telegram'}:`, ok ? 'done' : preview(out.join(' '), 200))
      if (!ok) return this.say(`The Funnel could not be turned off: ${preview(out.at(-1) ?? 'scripts/funnel.sh stop failed', 200)}`)
      return this.say(
        auto
          ? `cc-voice-gateway on ${hostname()}: the Funnel is off, ${this.idleMinutes} minutes after the last voice call. ${AGAIN}`
          : `The Funnel is off. ${AGAIN}`,
      )
    } finally {
      this.busy = null
    }
  }

  // Off when nothing happened for the idle time, if it is on.
  async checkIdle() {
    if (this.busy || this.checking) return
    if (this.store.voiceActive(this.idleMs) || Date.now() - this.activeAt < this.idleMs) return
    this.checking = true
    try {
      const state = await this.state()
      // Checked again: a voice call or "keep alive" may have come meanwhile.
      if (state !== 'on' || this.store.voiceActive(this.idleMs) || Date.now() - this.activeAt < this.idleMs) {
        if (state === 'off') this.activeAt = Date.now() // nothing to do until it is on again
        return
      }
      await this.off({ auto: true })
      this.activeAt = Date.now()
    } catch (error) {
      this.log('funnel idle check failed:', error.message)
    } finally {
      this.checking = false
    }
  }
}

// The answer to a command that was too old to act on.
export function staleText({ text, ageSeconds }) {
  const minutes = Math.round(ageSeconds / 60)
  const age = minutes >= 2 ? `${minutes} minutes` : `${ageSeconds} seconds`
  return (
    `Ignored "${preview(text, 40)}": it was sent ${age} ago, while the gateway was not listening, ` +
    'for example during a restart. Send it again if you still want it.'
  )
}
