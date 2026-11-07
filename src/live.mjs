// Settings that apply while the gateway runs: the worker limits,
// VOICE_GW_MAX_WORKERS and VOICE_GW_MAX_WORKERS_PER_REPO (config.mjs), the
// path grants, VOICE_GW_PATH_GRANTS (grants.mjs), and the accounts' fixed
// rules, VOICE_GW_ACCOUNTS (accounts.mjs). The gateway watches its settings
// file, .secrets/gateway.env (settings.mjs), which the setup assistant
// writes; once a change has settled, it reads the file again and applies
// them (gateway.mjs, Workers.setLimits, PathGrants.set, Accounts.set). Every other
// setting counts from the next start of the controller, and the log says so.
// As at the start, a value set in the environment from outside (for example
// in controller/.mcp.json) wins over the file; one the watchdog's start
// script exported from the file does not (settings.mjs).
//
// Robust on purpose: a file that cannot be read, is gone, or looks half
// written (a last line without its end) keeps the limits and the grants as
// they are; a value that is no whole number from 1 to MAX_LIMIT is ignored,
// with a log line; a line taken out means the default again, as at a start,
// for the grants and the rules none. Their own entries are checked where they
// apply (PathGrants.set, Accounts.set).

import { EventEmitter } from 'node:events'
import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { MAX_LIMIT, WORKER_LIMITS, limitValue } from './config.mjs'
import { ACCOUNTS_SETTING } from './accounts.mjs'
import { GRANTS_SETTING } from './grants.mjs'
import { log as defaultLog } from './log.mjs'
import { environmentWins, parseSettings } from './settings.mjs'

export class SettingsWatcher extends EventEmitter {
  // limits: the limits in force, by setting name; env: the environment;
  // wins: whether its value of a name wins over the file's (config.mjs), by
  // default as environmentWins decides it against the file at the start.
  constructor({ file, limits, env = process.env, wins = null, intervalMs = 1000, settleMs = 1500, log = defaultLog }) {
    super()
    this.file = file
    this.env = env
    this.limits = { ...limits }
    this.intervalMs = intervalMs
    this.settleMs = settleMs
    this.log = log
    this.timer = null
    this.unfinished = null // the text of a file that looked half written, once
    // The file as it was at the start, for what changed.
    const first = this.read()
    this.last = first.settings ?? (first.text !== undefined ? parseSettings(first.text) : {})
    this.wins = wins ?? environmentWins(env, this.last)
    this.listener = (now, before) => {
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size || now.ino !== before.ino) this.changed()
    }
  }

  start() {
    watchFile(this.file, { interval: this.intervalMs, persistent: false }, this.listener)
    return this
  }

  close() {
    unwatchFile(this.file, this.listener)
    clearTimeout(this.timer)
  }

  // A change: read once it has settled, so that a file being written is
  // read whole.
  changed() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.reload(), this.settleMs)
    this.timer.unref?.()
  }

  // { settings } or { problem, text }.
  read() {
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      return { problem: error.code === 'ENOENT' ? 'it is gone' : `it cannot be read (${error.code ?? error.message})` }
    }
    if (text && !text.endsWith('\n') && text !== this.unfinished) {
      return { problem: 'its last line has no end yet, as if it were still being written', text }
    }
    return { settings: parseSettings(text) }
  }

  // Reads the file and applies what changed. Emits 'change' with { limits,
  // changed, others, grants, accounts }: the limits now, those that changed,
  // the names of other settings that changed, which count from the next
  // start, and the new text of the path grants and of the accounts' rules
  // where it changed (missing otherwise). Returns the same, or null when
  // nothing was applied.
  reload() {
    const read = this.read()
    if (read.problem) {
      if (read.text !== undefined) {
        // Once more after a while: a file left so on purpose is taken then.
        this.unfinished = read.text
        this.changed()
      }
      this.log(`settings file ${this.file} changed, but ${read.problem}: the worker limits, the path grants and the accounts' rules stay as they are`)
      return null
    }
    this.unfinished = null
    const settings = read.settings
    const changed = {}
    for (const name of Object.keys(WORKER_LIMITS)) {
      const before = this.last[name]
      if (this.wins(name)) {
        if (settings[name] !== before) {
          this.log(`${name} changed in the settings file, but the environment sets it to ${this.env[name]}, which wins: it stays ${this.limits[name]}`)
        }
        continue
      }
      const value = limitValue(name, settings[name])
      if (value === null) {
        this.log(`${name}=${settings[name]} in the settings file is no whole number from 1 to ${MAX_LIMIT}: ignored, it stays ${this.limits[name]}`)
        continue
      }
      if (value !== this.limits[name]) changed[name] = value
    }
    // The path grants and the accounts' rules: their text, as the file has it
    // now; taken out, none.
    const text = (name, what) => {
      if (settings[name] === this.last[name]) return undefined
      if (!this.wins(name)) return settings[name] ?? ''
      this.log(`${name} changed in the settings file, but the environment sets it, which wins: ${what} stay as they are`)
      return undefined
    }
    const grants = text(GRANTS_SETTING, 'the path grants')
    const accounts = text(ACCOUNTS_SETTING, "the accounts' rules")
    const names = new Set([...Object.keys(this.last), ...Object.keys(settings)])
    const others = [...names]
      .filter(name => !(name in WORKER_LIMITS) && ![GRANTS_SETTING, ACCOUNTS_SETTING].includes(name) && this.last[name] !== settings[name])
      .sort()
    this.last = settings
    if (others.length) {
      this.log(`settings file changed: ${others.join(', ')} take effect at the next start of the controller`)
    }
    if (!Object.keys(changed).length && !others.length && grants === undefined && accounts === undefined) return null
    Object.assign(this.limits, changed)
    const result = {
      limits: { ...this.limits },
      changed,
      others,
      ...(grants === undefined ? {} : { grants }),
      ...(accounts === undefined ? {} : { accounts }),
    }
    this.emit('change', result)
    return result
  }
}

// A line for the controller about the other settings that changed.
export const othersText = others =>
  others.length ? ` The settings file also changed ${others.join(', ')}, which take effect at the next start of the controller.` : ''
