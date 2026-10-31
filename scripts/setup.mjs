#!/usr/bin/env node
// The setup assistant: a temporary page in the browser that sets up the
// gateway on this computer (src/setup/). It listens on every interface, so
// that a headless server can be set up from another computer, and shows its
// one-time link only here, in the terminal. It ends by itself when the setup
// is written (or, if the page stays open to connect the Claude app, when it
// says so), when cancelled, and after its time limits.
//
//   node scripts/setup.mjs [--host 0.0.0.0] [--port 8790] [--timeout 30] [--idle 10]
//
// --timeout and --idle are minutes: overall, and without a request from the
// page. Also from the environment: VOICE_SETUP_HOST, VOICE_SETUP_PORT,
// VOICE_SETUP_TIMEOUT, VOICE_SETUP_IDLE.

import { closeSync, openSync, writeSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createSetup } from '../src/setup/actions.mjs'
import { newToken, startSetupServer } from '../src/setup/server.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: process.env.VOICE_SETUP_HOST || '0.0.0.0' },
    port: { type: 'string', default: process.env.VOICE_SETUP_PORT || '8790' },
    timeout: { type: 'string', default: process.env.VOICE_SETUP_TIMEOUT || '30' },
    idle: { type: 'string', default: process.env.VOICE_SETUP_IDLE || '10' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (args.help) {
  console.log('usage: node scripts/setup.mjs [--host 0.0.0.0] [--port 8790] [--timeout 30] [--idle 10]')
  process.exit(0)
}
const minutes = (value, name) => {
  const n = Number(value)
  if (!(n > 0 && n <= 24 * 60)) {
    console.error(`setup: --${name} must be minutes, more than 0`)
    process.exit(2)
  }
  return n * 60 * 1000
}
const port = Number(args.port)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('setup: --port must be a port number')
  process.exit(2)
}
const timeoutMs = minutes(args.timeout, 'timeout')
const idleMs = minutes(args.idle, 'idle')

// The link goes to the terminal only: stdout if it is one, otherwise the
// controlling terminal. Never into a pipe or a file, where it would be logged.
function openTerminal() {
  if (process.stdout.isTTY) return { write: text => process.stdout.write(text), close: () => {} }
  try {
    const fd = openSync('/dev/tty', 'w')
    return { write: text => writeSync(fd, text), close: () => closeSync(fd) }
  } catch {
    return null
  }
}
const terminal = openTerminal()
if (!terminal) {
  console.error('setup: needs a terminal to show its one-time link; run it directly, not with its output redirected')
  process.exit(1)
}
const say = line => console.error(line) // status lines, never with a secret

function addresses(host) {
  if (host !== '0.0.0.0' && host !== '::') return [host.includes(':') ? `[${host}]` : host]
  const found = [hostname()]
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue
      if (entry.family === 'IPv4') found.push(entry.address)
      else if (host === '::' && !entry.address.startsWith('fe80')) found.push(`[${entry.address}]`)
    }
  }
  return [...new Set(found), 'localhost']
}

const token = newToken()
const setup = createSetup({ root: ROOT, secretsDir: process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets'), say, setupToken: token })
let server
try {
  server = await startSetupServer({ token, host: args.host, port, timeoutMs, idleMs, api: setup.api, redact: setup.redact, say })
} catch (error) {
  console.error(`setup: cannot listen on ${args.host}:${port}: ${error.code ?? error.message}`)
  process.exit(1)
}

const links = addresses(args.host).map(address => `  http://${address}:${server.port}/?t=${token}`)
terminal.write(
  [
    '',
    'cc-voice-gateway setup assistant',
    '',
    `Open one of these links in a browser, within ${args.timeout} minutes:`,
    ...links,
    '',
    'The link works once, in one browser; after that, only that browser gets in.',
    'There is no HTTPS: use it only in your own network, or through an SSH tunnel:',
    `  ssh -L ${server.port}:localhost:${server.port} ${hostname()}   then the localhost link`,
    `It ends by itself after ${args.idle} minutes without activity. Ctrl+C ends it now.`,
    '',
    '',
  ].join('\n'),
)
terminal.close()

process.on('SIGINT', () => server.stop('ended with Ctrl+C'))
process.on('SIGTERM', () => server.stop('ended'))
await server.done
process.exit(0)
