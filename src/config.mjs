// Configuration.
//
// Everything is read from environment variables so the gateway can be started
// by Claude Code (from .mcp.json) without any command line arguments, and from
// the settings file the setup assistant writes, .secrets/gateway.env
// (settings.mjs). A value set in the environment from outside wins; one the
// watchdog's start script exported from the file is the file's.

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_FILE_NAME, environmentWins, mcpEnvNames, readSettings } from './settings.mjs'

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

// What locks the kill switch (VOICE_GW_KILLSWITCH, killswitch.mjs): off,
// nothing; manual, only the driver's emergency stop, Telegram's /stop and the
// controller's raise_alarm, while the rules only log; auto, the default, also
// the rules.
export const KILLSWITCH_MODES = ['off', 'manual', 'auto']

// Where Claude voice mode calls from: Anthropic's published outbound range.
export const ANTHROPIC_RANGES = ['160.79.104.0/21']

const secretsDir = process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets')
const settingsFile = join(secretsDir, SETTINGS_FILE_NAME)
const fileSettings = readSettings(settingsFile)
// Only values set from outside win over the file: not those the watchdog's
// start script exported from it (settings.mjs); those named in
// controller/.mcp.json always do. Also for the settings that change while
// the gateway runs (live.mjs).
export const environmentWinsOver = environmentWins(
  process.env,
  fileSettings,
  mcpEnvNames(process.env.VOICE_GW_MCP_JSON || join(ROOT, 'controller', '.mcp.json')),
)
const env = {
  ...fileSettings,
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => environmentWinsOver(name) || !Object.hasOwn(fileSettings, name))),
}

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// The worker limits, which also apply while the gateway runs (live.mjs): how
// many runs at a time in all, and in one repository. Their defaults, and
// what a value may be: a whole number from 1 to MAX_LIMIT.
export const WORKER_LIMITS = { VOICE_GW_MAX_WORKERS: 2, VOICE_GW_MAX_WORKERS_PER_REPO: 1 }
export const MAX_LIMIT = 100

// A limit's value, or null when it is none (empty means the default).
export function limitValue(name, value) {
  if (value === undefined || String(value).trim() === '') return WORKER_LIMITS[name]
  const text = String(value).trim()
  return /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= MAX_LIMIT ? Number(text) : null
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

  // Addresses that may call /mcp through the Funnel or another proxy
  // (ipguard.mjs): comma-separated ranges (CIDR) or addresses, by default
  // Anthropic's. "any" lifts the limit, for a tunnel that does not pass the
  // caller's address in X-Forwarded-For. Programs on this computer that call
  // without X-Forwarded-For always pass.
  mcpAllow: (env.VOICE_GW_MCP_ALLOW || ANTHROPIC_RANGES.join(','))
    .split(',')
    .map(range => range.trim())
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
  // Remote Control (VOICE_GW_REMOTE_CONTROL=1): scripts/start-controller.sh
  // starts the controller session with --remote-control, so that it can be
  // followed and steered from claude.ai/code and the Claude app. Not the
  // workers: Claude Code connects only interactive sessions, not claude -p
  // runs, and a token from claude setup-token, as in the containers, cannot
  // connect one at all. Any other value counts as 0.
  remoteControl: env.VOICE_GW_REMOTE_CONTROL === '1',
  // A dispatch starts a run only with the driver's own words from a voice
  // request of the last this many minutes (channel.mjs).
  dispatchWindowMinutes: num(env.VOICE_GW_DISPATCH_WINDOW, 30),
  // Runs at a time, in all; every run of a repository counts. The limit that
  // protects the subscription.
  maxWorkers: num(env.VOICE_GW_MAX_WORKERS, 2),
  // Runs at a time in one repository: the first in its checkout, every
  // further one in a git worktree of its own (worktrees.mjs). 1, the default,
  // is one after the other. Both limits also change while the gateway runs,
  // with the settings file (live.mjs).
  maxWorkersPerRepo: limitValue('VOICE_GW_MAX_WORKERS_PER_REPO', env.VOICE_GW_MAX_WORKERS_PER_REPO) ?? 1,
  maxWorkersPerRepoSetting: env.VOICE_GW_MAX_WORKERS_PER_REPO ?? '',
  // 0: no time limit.
  workerTimeoutMinutes: env.VOICE_GW_WORKER_TIMEOUT?.trim() === '0' ? 0 : num(env.VOICE_GW_WORKER_TIMEOUT, 360),
  claudeBin: env.VOICE_GW_CLAUDE_BIN || 'claude',
  // Model and effort of the workers' runs (claude --model, --effort), on this
  // computer and in the container. Empty: Claude Code's defaults.
  workerModel: env.VOICE_GW_WORKER_MODEL || '',
  workerEffort: env.VOICE_GW_WORKER_EFFORT || '',
  ghBin: env.VOICE_GW_GH_BIN || 'gh',
  // Worker state and the output of every run.
  stateDir: env.VOICE_GW_STATE_DIR || join(ROOT, '.state'),
  // The checkout the gateway looks at with git when the controller answers a
  // request: its own. Empty: no look. Tests use a stand-in.
  selfCheckout: env.VOICE_GW_SELF_CHECKOUT ?? ROOT,
  // Minutes after which a decision the driver was asked about and has not
  // answered gets a reminder, at most three times (ledger.mjs).
  remindMinutes: num(env.VOICE_GW_REMIND_MINUTES, 30),

  // Work folders (workspaces.mjs): a new empty folder per task under this
  // root, for tasks that need no repository. Off unless VOICE_GW_SCRATCH=1.
  // The root must lie outside every git repository and this checkout; the
  // gateway checks it at its start. A work folder is removed this many days
  // after its last run; 0: never.
  scratch: env.VOICE_GW_SCRATCH === '1',
  scratchRoot: env.VOICE_GW_SCRATCH_ROOT || join(homedir(), 'voice-scratch'),
  scratchDays: env.VOICE_GW_SCRATCH_DAYS?.trim() === '0' ? 0 : num(env.VOICE_GW_SCRATCH_DAYS, 60),
  // Their runs in a container of their own (docker/, started with
  // scripts/start-workers-container.sh --scratch), which sees only the root,
  // mounted at VOICE_GW_DOCKER_SCRATCH, and no GitHub token: its name.
  // Empty: on this computer.
  scratchDocker: env.VOICE_GW_SCRATCH_DOCKER || '',
  dockerScratch: env.VOICE_GW_DOCKER_SCRATCH || '/scratch',

  // Pull requests that workers open: ready for review by default, so that
  // automatic reviews start at once; as drafts with VOICE_GW_PR_DRAFT=1
  // (workers.mjs).
  prDraft: env.VOICE_GW_PR_DRAFT === '1',
  // How often the gateway looks at their checks and reviews (pulls.mjs), in
  // seconds, and for how many hours at most.
  prPollSeconds: num(env.VOICE_GW_PR_POLL, 60),
  prWatchHours: num(env.VOICE_GW_PR_WATCH_HOURS, 24),

  // Telegram fallback, on when both of its files in the secrets folder are set:
  // after this many seconds without a voice tool call, the voice mode counts
  // as ended, and questions and approvals also go to Telegram. Results wait
  // for the next voice call. Long, because gaps of a few minutes between voice
  // calls are normal while the driver talks.
  telegramAfterSeconds: num(env.VOICE_GW_TELEGRAM_AFTER, 600),
  telegramApi: env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org',

  // The Tailscale Funnel (funnel.mjs): off by itself this many minutes after
  // the last voice call; 0 or empty, the default, leaves it on. On again with
  // /funnel on on Telegram.
  funnelIdleMinutes: /^\d+(\.\d+)?$/.test(env.VOICE_GW_FUNNEL_IDLE ?? '') ? Number(env.VOICE_GW_FUNNEL_IDLE) : 0,
  funnelScript: env.VOICE_GW_FUNNEL_SCRIPT || join(ROOT, 'scripts', 'funnel.sh'),

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

  // What locks the kill switch: off, manual or auto (KILLSWITCH_MODES). An
  // unknown value counts as auto; the gateway says so in its log.
  killSwitchMode: KILLSWITCH_MODES.includes(env.VOICE_GW_KILLSWITCH) ? env.VOICE_GW_KILLSWITCH : 'auto',
  killSwitchSetting: env.VOICE_GW_KILLSWITCH ?? '',
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
// Open decisions (ledger.mjs), for the same reason.
config.jobsFile = join(config.stateDir, 'jobs.json')
config.adminSocket = join(config.secretsDir, 'admin.sock')
config.pullsStateFile = join(config.stateDir, 'pulls.json')
// The statistics of this running time and of all time (stats.mjs).
config.statsFile = join(config.stateDir, 'stats.json')
config.telegramTokenFile = join(config.secretsDir, 'telegram_token')
config.telegramChatIdFile = join(config.secretsDir, 'telegram_chat_id')
// The kill switch's state: outside controller/, and not in .secrets/worker.
config.killSwitchFile = join(config.secretsDir, 'killswitch.json')
// The worker container's secrets, mounted read-only into it.
config.workerSecretsDir = join(config.secretsDir, 'worker')
config.githubTokenFile = join(config.workerSecretsDir, 'github_token')
