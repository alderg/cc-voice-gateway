#!/usr/bin/env node
// Voice gateway entry point.
//
// Claude Code starts this file as an MCP server (see controller/.mcp.json).
// One process, two faces:
//   stdio  -> Claude Code controller session (a channel: push events, reply tool, permission relay)
//   HTTP   -> voice assistant in the car (MCP tools: status, send, ask, get_reply, approve),
//             behind an OAuth sign-in
// plus a Unix socket for scripts/pair.mjs (pairing codes, connections), the
// workers: headless Claude Code runs in the repositories next to this one, and
// a watch on the pull requests they open, for checks and reviews.

import { config } from './config.mjs'
import { log } from './log.mjs'
import { Store } from './store.mjs'
import { Auth } from './oauth.mjs'
import { startAdmin } from './admin.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'
import { Workers } from './workers.mjs'
import { PullWatcher } from './pulls.mjs'

const store = new Store({ permissionTtlSeconds: config.permissionTtlSeconds })
const auth = new Auth({ stateFile: config.oauthStateFile, allowedHosts: config.oauthHosts })
const workers = new Workers({
  root: config.workerRoot,
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
    const request = store.createRequest(workers.resultText(task, opened), { origin: 'worker' })
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
