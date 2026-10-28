#!/usr/bin/env node
// Voice gateway entry point.
//
// Claude Code starts this file as an MCP server (see controller/.mcp.json).
// One process, two faces:
//   stdio  -> Claude Code controller session (a channel: push events, reply tool, permission relay)
//   HTTP   -> voice assistant in the car (MCP tools: status, send, ask, get_reply, approve),
//             behind an OAuth sign-in
// plus a Unix socket for scripts/pair.mjs (pairing codes, connections), and the
// workers: headless Claude Code runs in the repositories next to this one, or
// in a Docker container with its own clones.

import { config } from './config.mjs'
import { log } from './log.mjs'
import { Store } from './store.mjs'
import { Auth } from './oauth.mjs'
import { startAdmin } from './admin.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'
import { Workers } from './workers.mjs'
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
const workers = new Workers({
  runner: config.docker
    ? new DockerRunner({ container: config.docker, root: config.dockerRepos, dockerBin: config.dockerBin })
    : new HostRunner(config.workerRoot),
  access: config.docker
    ? new GitHubAccess({ tokenFile: config.githubTokenFile, apiBase: config.githubApi, forced: config.access })
    : null,
  stateDir: config.stateDir,
  claudeBin: config.claudeBin,
  ghBin: config.ghBin,
  maxRuns: config.maxWorkers,
  timeoutMinutes: config.workerTimeoutMinutes,
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
  // Give pending log writes and HTTP responses a moment, then leave.
  setTimeout(() => process.exit(0), 200).unref()
}

const channel = await startChannel(store, {
  permissionRelay: config.permissionRelay,
  workers,
  onClose: () => shutdown('stdio closed'),
})

// When a run ends, its result goes to the controller as a channel event. The
// controller's reply to it reaches the driver as news.
const reporting = new Set()
workers.on('finished', async task => {
  if (reporting.has(task.id)) return
  reporting.add(task.id)
  try {
    await channel.ready
    const request = store.createRequest(workers.resultText(task), { origin: 'worker' })
    await channel.push(request, { worker: task.repo, task: task.id, outcome: task.state })
    workers.markReported(task)
  } catch (error) {
    log('worker result not delivered:', error.message)
  } finally {
    reporting.delete(task.id)
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
