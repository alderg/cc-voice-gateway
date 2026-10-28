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
// voice mode ended.

import { config } from './config.mjs'
import { log } from './log.mjs'
import { Store } from './store.mjs'
import { Auth } from './oauth.mjs'
import { startAdmin } from './admin.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'
import { Workers } from './workers.mjs'
import { PullWatcher } from './pulls.mjs'
import { TelegramFallback, loadTelegram } from './telegram.mjs'
import { DockerRunner, HostRunner } from './runners.mjs'
import { ACCESS_LEVELS, GitHubAccess } from './access.mjs'

const store = new Store({ permissionTtlSeconds: config.permissionTtlSeconds })
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
  stateDir: config.stateDir,
  claudeBin: config.claudeBin,
  ghBin: config.ghBin,
  maxRuns: config.maxWorkers,
  timeoutMinutes: config.workerTimeoutMinutes,
})

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
  pulls.close() // so do the watches on pull requests
  // Give pending log writes and HTTP responses a moment, then leave.
  setTimeout(() => process.exit(0), 200).unref()
}

const channel = await startChannel(store, {
  permissionRelay: config.permissionRelay,
  workers,
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
    const meta = { worker: task.repo, task: task.id, outcome: task.state }
    if (opened.length) meta.pull_request = opened.map(pull => pull.number).join(',')
    await channel.push(request, meta)
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
    await channel.push(request, {
      worker: news.worker,
      repo: news.slug,
      pull_request: String(news.number),
      kind: news.kind,
    })
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
if (telegram) {
  new TelegramFallback(store, { send: text => telegram.send(text), afterSeconds: config.telegramAfterSeconds })
  log(`telegram fallback ready: after ${config.telegramAfterSeconds} s without a voice call`)
} else {
  log('telegram fallback off: telegram_token and telegram_chat_id not both set')
}

admin = await startAdmin(auth, config.adminSocket)
http = startVoiceHttp(store, channel, auth, config)

// The SDK's stdio transport does not notice when Claude Code goes away (it only
// listens for data and errors). Without this, a crashed or killed session
// would leave an orphaned gateway behind that keeps the HTTP port busy.
process.stdin.on('end', () => shutdown('stdin ended'))
process.stdin.on('close', () => shutdown('stdin closed'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
