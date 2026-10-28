// Configuration.
//
// Everything is read from environment variables so the gateway can be started
// by Claude Code (from .mcp.json) without any command line arguments, and from
// the settings file the setup assistant writes, .secrets/gateway.env
// (settings.mjs). The environment wins.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_FILE_NAME, readSettings } from './settings.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const VERSION = '0.1.0'

// Effort levels of claude --effort.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// What the controller session may do (VOICE_GW_CONTROLLER_LEVEL), from the
// least: confined (the default) answers, dispatches workers and reads pull
// request status; clone-delete also clones repositories into the worker root
// and deletes files and folders there (folders.mjs); unrestricted lifts the
// confinement (controller/.claude/hooks/confine.mjs).
export const CONTROLLER_LEVELS = ['confined', 'clone-delete', 'unrestricted']

const secretsDir = process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets')
const settingsFile = join(secretsDir, SETTINGS_FILE_NAME)
const env = { ...readSettings(settingsFile), ...process.env }

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const config = {
  // The HTTP side only ever binds to loopback. The tunnel (Tailscale Funnel)
  // forwards public HTTPS traffic to it.
  host: env.VOICE_GW_HOST || '127.0.0.1',
  port: num(env.VOICE_GW_PORT, 8787),

  // Forward Claude Code permission prompts (Bash, Write, Edit) to the voice
  // client so they can be approved by voice. Set VOICE_GW_PERMISSION_RELAY=0
  // to keep approvals in the terminal / Claude app only.
  permissionRelay: env.VOICE_GW_PERMISSION_RELAY !== '0',

  // Long-poll limits for get_reply/ask. MCP clients commonly abort a request
  // after 60 s, so a single call must return well before that.
  defaultWaitSeconds: num(env.VOICE_GW_DEFAULT_WAIT, 25),
  maxWaitSeconds: num(env.VOICE_GW_MAX_WAIT, 40),

  // After this many seconds without any reaction from the controller, the
  // voice client gets a diagnostic hint (usually: channel flag missing).
  hintAfterSeconds: num(env.VOICE_GW_HINT_AFTER, 20),

  // Unanswered permission prompts are dropped from the voice view after this.
  permissionTtlSeconds: num(env.VOICE_GW_PERMISSION_TTL, 900),

  // Log file; set VOICE_GW_LOG_FILE= (empty) to log to stderr only.
  logFile: env.VOICE_GW_LOG_FILE ?? join(ROOT, '.logs', 'gateway.log'),
  // Past this size in MB the log moves to <file>.1, replacing the one before.
  logMaxMb: num(env.VOICE_GW_LOG_MAX_MB, 10),

  // Sign-in state and the admin socket (mode 0700).
  secretsDir,
  settingsFile,

  // Hosts allowed as sign-in return addresses and for client ID metadata
  // documents: Claude's.
  oauthHosts: (env.VOICE_GW_OAUTH_HOSTS || 'claude.ai,claude.com')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean),

  // Workers: every git repository in this folder, by default the one this
  // repository sits in (~/Developer).
  workerRoot: env.VOICE_GW_WORKER_ROOT || dirname(ROOT),
  // This repository's own checkout is no worker on this computer: a run there
  // could change the gateway, the confine hook and controller/CLAUDE.md.
  // VOICE_GW_WORKER_SELF=1 lists it all the same.
  workerSelf: env.VOICE_GW_WORKER_SELF === '1',
  // An unknown value counts as confined; the gateway says so in its log.
  controllerLevel: CONTROLLER_LEVELS.includes(env.VOICE_GW_CONTROLLER_LEVEL) ? env.VOICE_GW_CONTROLLER_LEVEL : 'confined',
  controllerLevelSetting: env.VOICE_GW_CONTROLLER_LEVEL ?? '',
  // A dispatch starts a run only with the driver's own words from a voice
  // request of the last this many minutes (channel.mjs).
  dispatchWindowMinutes: num(env.VOICE_GW_DISPATCH_WINDOW, 30),
  maxWorkers: num(env.VOICE_GW_MAX_WORKERS, 2),
  workerTimeoutMinutes: num(env.VOICE_GW_WORKER_TIMEOUT, 60),
  claudeBin: env.VOICE_GW_CLAUDE_BIN || 'claude',
  // Model and effort of the workers' runs (claude --model, --effort), on this
  // computer and in the container. Empty: Claude Code's defaults.
  workerModel: env.VOICE_GW_WORKER_MODEL || '',
  workerEffort: env.VOICE_GW_WORKER_EFFORT || '',
  ghBin: env.VOICE_GW_GH_BIN || 'gh',
  // Worker state and the output of every run.
  stateDir: env.VOICE_GW_STATE_DIR || join(ROOT, '.state'),

  // Pull requests that workers open (pulls.mjs): how often the gateway looks
  // at their checks and reviews, in seconds, and for how many hours at most.
  prPollSeconds: num(env.VOICE_GW_PR_POLL, 60),
  prWatchHours: num(env.VOICE_GW_PR_WATCH_HOURS, 24),

  // Telegram fallback, on when both of its files in the secrets folder are set:
  // after this many seconds without a voice tool call, the voice mode counts
  // as ended, and results, questions and approvals also go to Telegram.
  telegramAfterSeconds: num(env.VOICE_GW_TELEGRAM_AFTER, 60),
  telegramApi: env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org',

  // Workers in a Docker container with its own clones (docker/): the
  // container's name. Empty: workers run in the checkouts on this computer.
  docker: env.VOICE_GW_DOCKER || '',
  dockerBin: env.VOICE_GW_DOCKER_BIN || 'docker',
  // Where the clones are inside the container.
  dockerRepos: env.VOICE_GW_DOCKER_REPOS || '/repos',
  // Access level of workers in the container (access.mjs): read-only, pr or
  // full for every repository. Empty: detected per repository from the token.
  access: env.VOICE_GW_ACCESS || '',
  githubApi: env.VOICE_GW_GITHUB_API || 'https://api.github.com',

  // The kill switch's rules on a worker run (guard.mjs): at most this many file
  // edits, and at the end at most this many files and lines changed.
  killMaxEdits: num(env.VOICE_GW_KILL_MAX_EDITS, 500),
  killMaxFiles: num(env.VOICE_GW_KILL_MAX_FILES, 300),
  killMaxLines: num(env.VOICE_GW_KILL_MAX_LINES, 30000),
  // Folders, besides the repository and the temporary ones, that workers may
  // write to; comma-separated.
  killAllowPaths: (env.VOICE_GW_KILL_ALLOW_PATHS || '')
    .split(',')
    .map(path => path.trim())
    .filter(Boolean),
  // How often the default branch on GitHub, and while locked the container,
  // are checked, in seconds.
  killCheckSeconds: num(env.VOICE_GW_KILL_CHECK, 30),
  // How long one poll of the Telegram bot for commands waits, in seconds.
  telegramPollSeconds: num(env.VOICE_GW_TELEGRAM_POLL, 25),
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
