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

  // Pull requests that workers open (pulls.mjs): how often the gateway looks
  // at their checks and reviews, in seconds, and for how many hours at most.
  prPollSeconds: num(process.env.VOICE_GW_PR_POLL, 60),
  prWatchHours: num(process.env.VOICE_GW_PR_WATCH_HOURS, 24),

  // Telegram fallback, on when both of its files in the secrets folder are set:
  // after this many seconds without a voice tool call, the voice mode counts
  // as ended, and results, questions and approvals also go to Telegram.
  telegramAfterSeconds: num(process.env.VOICE_GW_TELEGRAM_AFTER, 60),
  telegramApi: process.env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org',

  // Workers in a Docker container with its own clones (docker/): the
  // container's name. Empty: workers run in the checkouts on this computer.
  docker: process.env.VOICE_GW_DOCKER || '',
  dockerBin: process.env.VOICE_GW_DOCKER_BIN || 'docker',
  // Where the clones are inside the container.
  dockerRepos: process.env.VOICE_GW_DOCKER_REPOS || '/repos',
  // Access level of workers in the container (access.mjs): read-only, pr or
  // full for every repository. Empty: detected per repository from the token.
  access: process.env.VOICE_GW_ACCESS || '',
  githubApi: process.env.VOICE_GW_GITHUB_API || 'https://api.github.com',

  // The kill switch's rules on a worker run (guard.mjs): at most this many file
  // edits, and at the end at most this many files and lines changed.
  killMaxEdits: num(process.env.VOICE_GW_KILL_MAX_EDITS, 500),
  killMaxFiles: num(process.env.VOICE_GW_KILL_MAX_FILES, 300),
  killMaxLines: num(process.env.VOICE_GW_KILL_MAX_LINES, 30000),
  // Folders, besides the repository and the temporary ones, that workers may
  // write to; comma-separated.
  killAllowPaths: (process.env.VOICE_GW_KILL_ALLOW_PATHS || '')
    .split(',')
    .map(path => path.trim())
    .filter(Boolean),
  // How often the default branch on GitHub, and while locked the container,
  // are checked, in seconds.
  killCheckSeconds: num(process.env.VOICE_GW_KILL_CHECK, 30),
  // How long one poll of the Telegram bot for commands waits, in seconds.
  telegramPollSeconds: num(process.env.VOICE_GW_TELEGRAM_POLL, 25),
}

config.oauthStateFile = join(config.secretsDir, 'oauth.json')
// Voice requests, so that they survive a restart of the controller session.
config.requestsFile = join(config.stateDir, 'requests.json')
config.adminSocket = join(config.secretsDir, 'admin.sock')
config.pullsStateFile = join(config.stateDir, 'pulls.json')
config.telegramTokenFile = join(config.secretsDir, 'telegram_token')
config.telegramChatIdFile = join(config.secretsDir, 'telegram_chat_id')
// The kill switch's state: outside controller/, and not in .secrets/worker.
config.killSwitchFile = join(config.secretsDir, 'killswitch.json')
// The worker container's secrets, mounted read-only into it.
config.workerSecretsDir = join(config.secretsDir, 'worker')
config.githubTokenFile = join(config.workerSecretsDir, 'github_token')
