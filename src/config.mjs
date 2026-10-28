// Configuration.
//
// Everything is read from environment variables so the gateway can be started
// by Claude Code (from .mcp.json) without any command line arguments.

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

  // Sign-in state and the admin socket (mode 0700).
  secretsDir: process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets'),

  // Hosts allowed as sign-in return addresses and for client ID metadata
  // documents: Claude's.
  oauthHosts: (process.env.VOICE_GW_OAUTH_HOSTS || 'claude.ai,claude.com')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean),

  // Workers: every git repository in this folder, by default the one this
  // repository sits in (~/Developer).
  workerRoot: process.env.VOICE_GW_WORKER_ROOT || dirname(ROOT),
  maxWorkers: num(process.env.VOICE_GW_MAX_WORKERS, 2),
  workerTimeoutMinutes: num(process.env.VOICE_GW_WORKER_TIMEOUT, 60),
  claudeBin: process.env.VOICE_GW_CLAUDE_BIN || 'claude',
  ghBin: process.env.VOICE_GW_GH_BIN || 'gh',
  // Worker state and the output of every run.
  stateDir: process.env.VOICE_GW_STATE_DIR || join(ROOT, '.state'),

  // Telegram fallback, on when both of its files in the secrets folder are set:
  // after this many seconds without a voice tool call, the voice mode counts
  // as ended, and results, questions and approvals also go to Telegram.
  telegramAfterSeconds: num(process.env.VOICE_GW_TELEGRAM_AFTER, 60),
  telegramApi: process.env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org',
}

config.oauthStateFile = join(config.secretsDir, 'oauth.json')
config.adminSocket = join(config.secretsDir, 'admin.sock')
config.telegramTokenFile = join(config.secretsDir, 'telegram_token')
config.telegramChatIdFile = join(config.secretsDir, 'telegram_chat_id')
