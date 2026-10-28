// Restarting the controller session by voice, through the watchdog in
// scripts/start-controller.sh.
//
// The controller asks the driver first (with what plan() says), and only after
// a yes calls restart_controller with confirm=true. Then the gateway leaves a
// note for the watchdog in its lock folder and ends the session (SIGTERM to
// Claude Code, its parent). The watchdog sees the note and starts the session
// again at once: a requested restart, without a pause, not counted as a crash.
//
// What survives: worker runs, which are detached and report to the next
// gateway; voice requests, which the store keeps in .state/requests.json (an
// unfinished one ends with a note, see store.mjs). Open approvals belong to
// the old session and are gone.
//
// After any restart by the watchdog, the next gateway finds its note
// ("restarted") and, once the session is connected, tells the driver on
// Telegram that the controller is ready again.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log as defaultLog, preview } from './log.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const minutes = ms => {
  const m = Math.round(ms / 60000)
  return m < 1 ? 'less than a minute' : `${m} minute${m === 1 ? '' : 's'}`
}

export class Restarter {
  constructor({
    store,
    workers = null,
    lockDir = process.env.VOICE_GW_WATCHDOG_LOCK || '',
    channelMode = process.env.VOICE_GW_CHANNEL_MODE || '',
    secretsDir,
    delayMs = 2000,
    log = defaultLog,
  }) {
    this.store = store
    this.workers = workers
    this.lockDir = lockDir
    this.channelMode = channelMode
    this.secretsDir = secretsDir
    this.delayMs = delayMs
    this.log = log
  }

  // The watchdog that started this session, if any: its lock folder names
  // the session's process, which must be this gateway's parent.
  watchdog() {
    if (!this.lockDir) return { ok: false, why: 'it was not started with scripts/start-controller.sh and its watchdog' }
    let pid
    try {
      pid = Number(readFileSync(join(this.lockDir, 'claude.pid'), 'utf8').trim())
    } catch {
      return { ok: false, why: 'the watchdog does not know this session' }
    }
    if (pid !== process.ppid) return { ok: false, why: 'the watchdog runs another session' }
    return { ok: true, pid }
  }

  plan() {
    const watchdog = this.watchdog()
    if (!watchdog.ok) {
      return `[restart=unavailable] This session cannot restart itself: ${watchdog.why}. Tell the driver; they can restart it at the computer.`
    }
    const runs = this.workers?.running() ?? []
    const open = this.store.openRequests()
    const lines = [
      `[restart=plan watchdog=yes channel=${this.channelMode || 'unknown'} workers=${runs.length} requests=${open.length}]`,
      'Restarting ends this session; the watchdog starts it again at once, as a requested restart.',
    ]
    if (runs.length) {
      const list = runs.map(t => `${t.repo} (task ${t.id}, running for ${minutes(Date.now() - t.startedAt)}: "${preview(t.task, 50)}")`)
      lines.push(
        `Worker runs going: ${list.join('; ')}. They keep running outside this session and report their results to ` +
          'the restarted controller; nothing about them is lost.',
      )
    } else {
      lines.push('No worker runs are going.')
    }
    lines.push(
      open.length
        ? `Open voice requests: ${open.length}. Answers already given stay deliverable; a request not finished yet ends ` +
            'with a note that the controller restarted, so the driver has to say it again. Open approvals are dropped.'
        : 'No voice request is open.',
    )
    lines.push(
      this.channelMode === 'plugin'
        ? 'The channel loads as the allowlisted plugin, so the session is back within about half a minute, without a confirmation.'
        : 'The channel loads with the development flag: after the restart, someone has to confirm the warning at the ' +
            'terminal (tmux attach -t voice) before voice requests arrive again.',
    )
    lines.push(
      'Ask the driver, saying this in plain words, whether to restart. Only after a yes: reply "done" to the driver ' +
        'first, then call restart_controller with confirm=true.',
    )
    return lines.join('\n')
  }

  request({ by = 'voice' } = {}) {
    const watchdog = this.watchdog()
    if (!watchdog.ok) return this.plan()
    writeFileSync(join(this.lockDir, 'restart'), JSON.stringify({ by, at: new Date().toISOString() }) + '\n')
    this.store.save()
    this.log(`restart of the controller session requested by ${by}; ending session ${watchdog.pid}`)
    setTimeout(() => {
      try {
        process.kill(watchdog.pid, 'SIGTERM')
      } catch (error) {
        this.log('restart: the session could not be ended:', error.message)
      }
    }, this.delayMs)
    return `[restart=requested] The session ends in about ${Math.round(this.delayMs / 1000)} seconds, and the watchdog starts it again.`
  }

  // After a restart by the watchdog, once the session is connected.
  announceReady() {
    if (!this.lockDir) return
    const note = join(this.lockDir, 'restarted')
    if (!existsSync(note)) return
    let reason = 'a restart'
    try {
      reason = readFileSync(note, 'utf8').trim() || reason
    } catch {
      // keep the default
    }
    rmSync(note, { force: true })
    const text = `cc-voice-gateway on ${hostname()}: the controller is ready again, after ${reason}.`
    execFile(
      process.execPath,
      [join(ROOT, 'scripts', 'telegram-notify.mjs'), text],
      { env: { ...process.env, ...(this.secretsDir ? { VOICE_GW_SECRETS_DIR: this.secretsDir } : {}) }, timeout: 20000 },
      (error, stdout) => {
        const result = String(stdout || error?.message || '').trim()
        if (result !== 'telegram: not set up') this.log(`ready after ${reason}; ${result}`)
      },
    )
  }
}
