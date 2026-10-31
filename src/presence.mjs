// Which gateway answers the connector, and whether it is active. The driver
// may have several gateways, each a connector in claude.ai, which all look
// alike to the voice assistant; every answer of the connector therefore
// starts with a line that names this one and says whether to use it:
//
//   Gateway sky (Mac): active
//   Gateway sky (Mac): inactive, connector disconnected, in standby; use another connector
//   Gateway sky (Mac): inactive, kill switch locked; it can only be unlocked at the computer
//
// The name is VOICE_GW_NAME, by default the computer's, as in the gateway's
// Telegram messages ("cc-voice-gateway on sky"), with the kind of computer.
// Active: a controller session is connected to this gateway and the kill
// switch is not locked. Inactive: on standby by its settings
// (VOICE_GW_STANDBY=1, a test install for example), in standby after the
// connector was disconnected (standby.mjs), the kill switch locked, or no
// controller connected (not yet, or no longer).

import { readFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'

// The kind of computer, for the name: a Raspberry Pi says so in its device tree.
export function computerKind(os = platform(), model = '/proc/device-tree/model') {
  if (os === 'darwin') return 'Mac'
  if (os === 'win32') return 'Windows'
  try {
    if (/raspberry pi/i.test(readFileSync(model, 'utf8'))) return 'Raspberry Pi'
  } catch {
    // no device tree: another computer
  }
  return 'Linux'
}

// The computer's name without its domain: sky, not sky.local.
export const shortHost = (host = hostname()) => String(host).split('.')[0] || String(host)

export class Presence {
  // name: VOICE_GW_NAME, or empty; a name with its own brackets gets no kind.
  constructor({ name = '', host = hostname(), kind = computerKind(), standbySetting = false, killswitch = null, standby = null } = {}) {
    const base = String(name).trim() || shortHost(host)
    this.label = /\(.*\)/.test(base) ? base : `${base} (${kind})`
    this.standbySetting = standbySetting
    this.killswitch = killswitch
    this.standby = standby // the standby after a disconnect, or null
    this.connected = false // a controller session on the channel (gateway.mjs)
  }

  // { active, why, next }: why, in a few words, when it is inactive, and
  // what then. Only a standby sends the voice assistant to another
  // connector; a locked kill switch never does, as that would carry the
  // work past an emergency stop, and a controller that is starting comes
  // back by itself.
  state() {
    const standby = 'use another connector'
    if (this.standbySetting) return { active: false, why: 'on standby by its settings', next: standby, standby: true }
    if (this.standby?.active) return { active: false, why: 'connector disconnected, in standby', next: standby, standby: true }
    if (this.killswitch?.locked) return { active: false, why: 'kill switch locked', next: 'it can only be unlocked at the computer' }
    if (!this.connected) {
      return { active: false, why: 'no controller connected', next: 'it is starting or not running; try again in a minute' }
    }
    return { active: true, why: null, next: null }
  }

  line() {
    const { active, why, next } = this.state()
    return active ? `Gateway ${this.label}: active` : `Gateway ${this.label}: inactive, ${why}; ${next}`
  }
}
