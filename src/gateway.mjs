#!/usr/bin/env node
// Voice gateway entry point.
//
// Claude Code starts this file as an MCP server (see controller/.mcp.json).
// One process, two faces:
//   stdio  -> Claude Code controller session (a channel: push events, reply tool, permission relay)
//   HTTP   -> voice assistant in the car (MCP tools: status, send, ask, get_reply, approve)

import { config, loadToken } from './config.mjs'
import { log } from './log.mjs'
import { Store } from './store.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'

const token = loadToken()
const store = new Store({ permissionTtlSeconds: config.permissionTtlSeconds })

let http
let shuttingDown = false
function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down:', reason)
  http?.close()
  // Give pending log writes and HTTP responses a moment, then leave.
  setTimeout(() => process.exit(0), 200).unref()
}

const channel = await startChannel(store, {
  permissionRelay: config.permissionRelay,
  onClose: () => shutdown('stdio closed'),
})

http = startVoiceHttp(store, channel, { ...config, token })

// The SDK's stdio transport does not notice when Claude Code goes away (it only
// listens for data and errors). Without this, a crashed or killed session
// would leave an orphaned gateway behind that keeps the HTTP port busy.
process.stdin.on('end', () => shutdown('stdin ended'))
process.stdin.on('close', () => shutdown('stdin closed'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
