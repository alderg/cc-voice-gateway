// Configuration and the shared secret.
//
// Everything is read from environment variables so the gateway can be started
// by Claude Code (from .mcp.json) without any command line arguments.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const VERSION = '0.1.0'

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const config = {
  // The HTTP side only ever binds to loopback. The tunnel (Tailscale Funnel)
  // forwards public HTTPS traffic to it.
  host: process.env.VOICE_GW_HOST || '127.0.0.1',
  port: num(process.env.VOICE_GW_PORT, 8787),

  // Forward Claude Code permission prompts (Bash, Write, Edit) to the voice
  // client so they can be approved by voice. Set VOICE_GW_PERMISSION_RELAY=0
  // to keep approvals in the terminal / Claude app only.
  permissionRelay: process.env.VOICE_GW_PERMISSION_RELAY !== '0',

  // Long-poll limits for get_reply/ask. MCP clients commonly abort a request
  // after 60 s, so a single call must return well before that.
  defaultWaitSeconds: num(process.env.VOICE_GW_DEFAULT_WAIT, 25),
  maxWaitSeconds: num(process.env.VOICE_GW_MAX_WAIT, 40),

  // After this many seconds without any reaction from the controller, the
  // voice client gets a diagnostic hint (usually: channel flag missing).
  hintAfterSeconds: num(process.env.VOICE_GW_HINT_AFTER, 20),

  // Unanswered permission prompts are dropped from the voice view after this.
  permissionTtlSeconds: num(process.env.VOICE_GW_PERMISSION_TTL, 900),

  // Log file; set VOICE_GW_LOG_FILE= (empty) to log to stderr only.
  logFile: process.env.VOICE_GW_LOG_FILE ?? join(ROOT, '.logs', 'gateway.log'),

  tokenFile: process.env.VOICE_GW_TOKEN_FILE || join(ROOT, '.secrets', 'token'),
}

const MIN_TOKEN_LENGTH = 24

// Returns the shared secret, creating .secrets/token (mode 0600) on first use.
export function loadToken({ create = true } = {}) {
  let token = process.env.VOICE_GW_TOKEN?.trim()
  if (!token && existsSync(config.tokenFile)) {
    token = readFileSync(config.tokenFile, 'utf8').trim()
  }
  if (!token) {
    if (!create) return null
    token = randomBytes(24).toString('hex')
    mkdirSync(dirname(config.tokenFile), { recursive: true, mode: 0o700 })
    writeFileSync(config.tokenFile, token + '\n', { mode: 0o600 })
  }
  if (token.length < MIN_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(`Token must be at least ${MIN_TOKEN_LENGTH} characters of [A-Za-z0-9_-]`)
  }
  return token
}

// Constant-time comparison so the secret cannot be guessed byte by byte.
export function tokenMatches(expected, given) {
  if (typeof given !== 'string' || given.length === 0) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}
