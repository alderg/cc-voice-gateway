#!/usr/bin/env node
// Voice gateway entry point.
//
// Claude Code starts this file as an MCP server (see controller/.mcp.json).
// One process, two faces:
//   stdio  -> Claude Code controller session (a channel: push events, reply tool, permission relay)
//   HTTP   -> voice assistant in the car (MCP tools: status, send, ask, get_reply, approve),
//             behind an OAuth sign-in
// plus a Unix socket for scripts/pair.mjs (pairing codes, connections), the
// workers: headless Claude Code runs in the repositories next to this one, or
// in a Docker container with its own clones, a watch on the pull requests they
// open, for checks and reviews, and optionally Telegram, for news after the
// voice mode ended. Over all of it, the kill switch (killswitch.mjs).

import { config } from './config.mjs'
import { log } from './log.mjs'
import { Store } from './store.mjs'
import { Auth } from './oauth.mjs'
import { startAdmin } from './admin.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'
import { Workers } from './workers.mjs'
import { TelegramCommands, TelegramFallback, loadTelegram } from './telegram.mjs'
import { KillSwitch, alarmText } from './killswitch.mjs'
import { RunGuard } from './guard.mjs'
import { hostname } from 'node:os'
import { DockerRunner, HostRunner } from './runners.mjs'
import { ACCESS_LEVELS, GitHubAccess } from './access.mjs'
import { PullWatcher } from './pulls.mjs'
import { Restarter } from './restart.mjs'

const store = new Store({ permissionTtlSeconds: config.permissionTtlSeconds, file: config.requestsFile })
const killswitch = new KillSwitch({ file: config.killSwitchFile })
if (killswitch.locked) {
  log(`kill switch is locked since ${killswitch.state.at} by ${killswitch.state.trigger}: ${killswitch.state.reason}`)
}
const auth = new Auth({ stateFile: config.oauthStateFile, allowedHosts: config.oauthHosts })
if (config.access && !ACCESS_LEVELS.includes(config.access)) {
  log(`VOICE_GW_ACCESS=${config.access} is not one of ${ACCESS_LEVELS.join(', ')}; detecting the level instead`)
}
if (config.docker) {
  log(
    `workers run in the Docker container ${config.docker},`,
    ACCESS_LEVELS.includes(config.access)
      ? `access level ${config.access} (VOICE_GW_ACCESS)`
      : 'access level per repository from the GitHub token',
  )
}
const runner = config.docker
  ? new DockerRunner({ container: config.docker, root: config.dockerRepos, dockerBin: config.dockerBin })
  : new HostRunner(config.workerRoot)
if (config.docker) {
  runner.check().then(({ folder, user, warnings }) => {
    log(`worker container ${config.docker}: repositories from host folder ${folder ?? '?'}, running as ${user ?? '?'}`)
    for (const warning of warnings) log(`worker container ${config.docker}: ${warning}`)
  })
}
const workers = new Workers({
  runner,
  access: config.docker
    ? new GitHubAccess({ tokenFile: config.githubTokenFile, apiBase: config.githubApi, forced: config.access })
    : null,
  killswitch,
  stateDir: config.stateDir,
  claudeBin: config.claudeBin,
  ghBin: config.ghBin,
  maxRuns: config.maxWorkers,
  timeoutMinutes: config.workerTimeoutMinutes,
})
const guard = new RunGuard({
  workers,
  runner,
  killswitch,
  ghBin: config.ghBin,
  limits: { maxEdits: config.killMaxEdits, maxFiles: config.killMaxFiles, maxLines: config.killMaxLines },
  allowed: config.killAllowPaths,
  mainCheckSeconds: config.killCheckSeconds,
})
for (const task of workers.running()) guard.started(task) // runs from before this gateway

const pulls = new PullWatcher({
  ghBin: config.ghBin,
  stateFile: config.pullsStateFile,
  pollSeconds: config.prPollSeconds,
  watchHours: config.prWatchHours,
})

let http
let admin
let shuttingDown = false
function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down:', reason)
  http?.close()
  admin?.close()
  workers.close() // runs go on; the next gateway picks them up
  guard.close()
  telegramCommands?.close()
  pulls.close() // so do the watches on pull requests
  // Give pending log writes and HTTP responses a moment, then leave.
  setTimeout(() => process.exit(0), 200).unref()
}

// Restarting the controller by voice, through the watchdog (restart.mjs).
const restarter = new Restarter({ store, workers, secretsDir: config.secretsDir })

const channel = await startChannel(store, {
  permissionRelay: config.permissionRelay,
  workers,
  killswitch,
  restarter,
  onClose: () => shutdown('stdio closed'),
})

// When a run ends, its result goes to the controller as a channel event, with
// the pull requests it opened or worked on. The controller's reply to it
// reaches the driver as news.
const reporting = new Set()
workers.on('finished', async task => {
  if (reporting.has(task.id)) return
  reporting.add(task.id)
  try {
    await channel.ready
    const opened = await pulls.fromRun(task).catch(error => {
      log('pull requests of', task.id, 'not checked:', error.message)
      return []
    })
    const request = store.createRequest(workers.resultText(task, opened), {
      origin: 'worker',
      worker: { repo: task.repo, task: task.id },
    })
    request.meta = { worker: task.repo, task: task.id, outcome: task.state } // for sending it again
    if (opened.length) request.meta.pull_request = opened.map(pull => pull.number).join(',')
    await channel.push(request, request.meta)
    workers.markReported(task)
  } catch (error) {
    log('worker result not delivered:', error.message)
  } finally {
    reporting.delete(task.id)
  }
})

// Checks and reviews on those pull requests reach the controller as events
// too, and the driver as news.
pulls.on('news', async news => {
  try {
    await channel.ready
    const request = store.createRequest(news.text, { origin: 'worker' })
    request.meta = { worker: news.worker, repo: news.slug, pull_request: String(news.number), kind: news.kind }
    await channel.push(request, request.meta)
  } catch (error) {
    log('pull request news not delivered:', error.message)
  }
})

// Telegram, if set up, reaches the driver once the voice mode has ended.
const telegram = loadTelegram({
  tokenFile: config.telegramTokenFile,
  chatIdFile: config.telegramChatIdFile,
  apiBase: config.telegramApi,
})
let telegramCommands = null
if (telegram) {
  new TelegramFallback(store, { send: text => telegram.send(text), afterSeconds: config.telegramAfterSeconds })
  log(`telegram fallback ready: after ${config.telegramAfterSeconds} s without a voice call`)
  // Inbound, only the kill switch, only from the configured chat.
  telegramCommands = new TelegramCommands(telegram, { pollSeconds: config.telegramPollSeconds }).start()
  telegramCommands.on('stop', ({ text }) => killswitch.trip({ trigger: 'telegram', reason: `"${text}" on Telegram` }))
} else {
  log('telegram fallback off: telegram_token and telegram_chat_id not both set')
}

// --- the kill switch's effects, in code ---------------------------------------

// No new tasks (Workers.dispatch and the voice tools check the switch), every
// run and the worker container stop, open approvals are denied.
async function lockdown(why) {
  const stopped = workers.stopAll(`kill switch (${why})`)
  if (stopped.length) log('kill switch stopped', stopped.map(task => `${task.repo} ${task.id}`).join(', '))
  for (const permission of store.openPermissions()) {
    store.resolvePermission(permission.code, 'deny')
    channel.sendVerdict(permission.code, 'deny').catch(() => {})
  }
  if (config.docker) {
    const ok = await runner.lockdown()
    log(`kill switch: worker container ${config.docker} ${ok ? 'stopped' : 'not stopped (was it running?)'}`)
  }
}

killswitch.on('tripped', async (state, event, first) => {
  await lockdown(event.trigger)
  // Telegram at once; every voice chat hears it with its next call (voice.mjs).
  const when = new Date(event.at).toISOString().replace('T', ' ').slice(0, 16)
  telegram
    ?.send(
      `cc-voice-gateway on ${hostname()}: ${first ? 'KILL SWITCH' : 'kill switch, again'} at ${when} UTC, ` +
        `by ${event.trigger}: ${event.reason}. No new tasks, workers stopped, repositories read-only for the ` +
        'worker container. Unlock only at the server: node scripts/unlock.mjs',
    )
    .catch(error => log('kill switch alarm not sent by Telegram:', error.message))
  // The controller hears it too; its acknowledgement is not news.
  try {
    await channel.ready
    const request = store.createRequest(
      `${first ? 'Kill switch locked' : 'Kill switch triggered again'}: ${alarmText(state)} Do not try to get ` +
        'around it. Reply "done".',
      { origin: 'alarm' },
    )
    await channel.push(request, { kind: 'killswitch', trigger: event.trigger })
  } catch (error) {
    log('kill switch event not delivered to the controller:', error.message)
  }
})

if (killswitch.locked) lockdown('locked at startup')

// While locked, a worker container with a writable /repos is stopped, however
// it was started.
if (config.docker) {
  setInterval(async () => {
    if (!killswitch.locked) return
    const mounts = await runner.mounts()
    if (mounts?.running && mounts.writable) {
      log(`kill switch: worker container ${config.docker} runs with a writable /repos; stopping it`)
      await runner.lockdown()
    }
  }, config.killCheckSeconds * 1000).unref()
}

admin = await startAdmin(auth, config.adminSocket, { killswitch })
http = startVoiceHttp(store, channel, auth, config, { killswitch })

// Once the session is connected: worker results the previous session never
// answered go to this one, and after a restart by the watchdog the driver
// hears on Telegram that the controller is ready again.
channel.ready.then(async () => {
  for (const request of [...store.requests.values()].filter(r => r.resend)) {
    try {
      await channel.push(request, { ...request.meta, resent: 'yes' })
      delete request.resend
      store.changed()
    } catch (error) {
      log('worker result not sent again:', error.message)
    }
  }
  restarter.announceReady()
})

// The SDK's stdio transport does not notice when Claude Code goes away (it only
// listens for data and errors). Without this, a crashed or killed session
// would leave an orphaned gateway behind that keeps the HTTP port busy.
process.stdin.on('end', () => shutdown('stdin ended'))
process.stdin.on('close', () => shutdown('stdin closed'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
