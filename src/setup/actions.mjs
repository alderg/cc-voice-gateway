// What the setup assistant does (scripts/setup.mjs; the page is in ui/, the
// guarded server in server.mjs): it checks the tools, the Telegram bot and the
// GitHub token, builds the worker image, and at the end writes everything
// into .secrets: the secrets as files of their own, the settings as
// gateway.env (src/settings.mjs), the folders mode 0700, the files 0600.
//
// Secrets entered on the page stay in memory until then. Nothing here sends a
// secret back to the browser, prints it, or logs it: the page only learns
// whether one is saved or new, and every line of output and every error
// message passes redact() first.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, platform as osPlatform } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { ACCESS_LEVELS, GitHubAccess } from '../access.mjs'
import { connect } from 'node:net'
import { CONTROLLER_LEVELS, EFFORTS, KILLSWITCH_MODES, WORKER_LIMITS } from '../config.mjs'
import { LAUNCH_AGENT, MAC_TAILSCALE, SERVICE, findCommand, servicePath } from '../platform.mjs'
import { HostRunner } from '../runners.mjs'
import { SETTINGS_FILE_NAME, formatSettings, readSettings } from '../settings.mjs'
import { Telegram } from '../telegram.mjs'
import { githubSlug } from '../workers.mjs'
import { scratchProblem } from '../workspaces.mjs'
import { MARKETPLACE, PLUGIN, channelMode } from '../../scripts/channel-mode.mjs'
import { chromeNoticeSeen } from '../../scripts/chrome-onboarding.mjs'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const MIN_CLAUDE = [2, 1, 80]
const MAX_LINES = 400

// The settings the page sets, with their defaults (as in config.mjs and the
// start scripts) and what a valid value looks like. A value equal to its
// default is left out of the file.
const PATH = value => isAbsolute(value) && !/[\r\n\0]/.test(value)
const INT = (min, max) => value => /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max
const ONE_OF = (...values) => value => values.includes(value)
const MODEL = value => /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/.test(value)
const NAME = value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value)
const IMAGE = value => /^[a-z0-9][a-z0-9._/:-]{0,127}$/.test(value)

export function fields(root) {
  return {
    VOICE_GW_PORT: { default: '8787', valid: INT(1024, 65535) },
    VOICE_GW_WORKER_ROOT: { default: dirname(root), valid: PATH },
    VOICE_GW_MAX_WORKERS: { default: '2', valid: INT(1, 10) },
    VOICE_GW_MAX_WORKERS_PER_REPO: { default: '1', valid: INT(1, 10) },
    VOICE_GW_WORKER_TIMEOUT: { default: '360', valid: value => value === '0' || INT(5, 1440)(value) },
    VOICE_GW_PR_DRAFT: { default: '0', valid: ONE_OF('0', '1') },
    VOICE_GW_SCRATCH: { default: '0', valid: ONE_OF('0', '1') },
    VOICE_GW_SCRATCH_ROOT: { default: join(homedir(), 'voice-scratch'), valid: PATH },
    VOICE_GW_SCRATCH_DAYS: { default: '60', valid: value => value === '0' || INT(1, 365)(value) },
    VOICE_GW_SCRATCH_DOCKER: { default: '', valid: NAME },
    VOICE_GW_PERMISSION_RELAY: { default: '1', valid: ONE_OF('1', '0') },
    VOICE_GW_REMOTE_CONTROL: { default: '0', valid: ONE_OF('0', '1') },
    VOICE_GW_CONTROLLER_LEVEL: { default: 'confined', valid: ONE_OF(...CONTROLLER_LEVELS) },
    VOICE_GW_KILLSWITCH: { default: 'auto', valid: ONE_OF(...KILLSWITCH_MODES) },
    VOICE_GW_TELEGRAM_AFTER: { default: '600', valid: INT(10, 3600) },
    VOICE_GW_FUNNEL_IDLE: { default: '0', valid: INT(0, 1440) },
    VOICE_GW_DOCKER: { default: '', valid: NAME },
    VOICE_GW_DOCKER_FOLDER: { default: join(homedir(), 'docker-developer'), valid: PATH },
    VOICE_GW_DOCKER_IMAGE: { default: 'cc-voice-worker', valid: IMAGE },
    VOICE_GW_ACCESS: { default: '', valid: ONE_OF(...ACCESS_LEVELS) },
    VOICE_GW_CONTROLLER_MODEL: { default: '', valid: MODEL },
    VOICE_GW_CONTROLLER_EFFORT: { default: '', valid: ONE_OF(...EFFORTS) },
    VOICE_GW_CONTROLLER_CHROME: { default: '0', valid: ONE_OF('1', '0') },
    VOICE_GW_WORKER_MODEL: { default: '', valid: MODEL },
    VOICE_GW_WORKER_EFFORT: { default: '', valid: ONE_OF(...EFFORTS) },
  }
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

function readSecret(file) {
  try {
    return readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}

// A folder only its owner can enter, also if it existed before.
export function secureFolder(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

// Written to a fresh file with mode 0600, then moved into place, so that the
// content is never readable for others, not even for a moment.
export function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.tmp`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

const newer = (version, minimum) => {
  for (let i = 0; i < minimum.length; i++) {
    if ((version[i] ?? 0) !== minimum[i]) return (version[i] ?? 0) > minimum[i]
  }
  return true
}

// A command's output, line by line; resolves with its exit code (null when it
// could not start). Its environment never reaches the output.
export function runCommand(command, args, { env = process.env, cwd, onLine = () => {}, timeoutMs = 600000 } = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      onLine(`could not start ${command}: ${error.message}`)
      return resolve(null)
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    for (const stream of [child.stdout, child.stderr]) {
      let partial = ''
      stream.on('data', chunk => {
        const lines = (partial + chunk.toString('utf8')).split(/\r?\n|\r/)
        partial = lines.pop()
        for (const line of lines) if (line.trim()) onLine(line)
      })
      stream.on('end', () => partial.trim() && onLine(partial))
    }
    child.on('error', error => {
      clearTimeout(timer)
      onLine(`could not start ${command}: ${error.code ?? error.message}`)
      resolve(null)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function capture(command, args, options = {}) {
  const lines = []
  const code = await runCommand(command, args, { ...options, timeoutMs: options.timeoutMs ?? 15000, onLine: line => lines.push(line) })
  return { code, text: lines.join('\n') }
}

// options: root, secretsDir, env (for the bins and APIs), home, platform,
// uid, gid, say (a line for the terminal), setupToken (kept out of all output)
export function createSetup({
  root,
  secretsDir = join(root, '.secrets'),
  env = process.env,
  home = homedir(),
  platform = osPlatform(),
  uid = process.getuid(),
  gid = process.getgid(),
  say = () => {},
  setupToken = '',
}) {
  // On macOS the checks, the commands and the LaunchAgent also look where
  // Homebrew, Claude Code's installer and Docker Desktop put their commands.
  if (platform === 'darwin') env = { ...env, PATH: servicePath({ platform, path: env.PATH, home }) }
  const bin = {
    claude: env.VOICE_GW_CLAUDE_BIN || 'claude',
    docker: env.VOICE_GW_DOCKER_BIN || 'docker',
    gh: env.VOICE_GW_GH_BIN || 'gh',
    git: env.VOICE_SETUP_GIT_BIN || 'git',
    tmux: env.VOICE_SETUP_TMUX_BIN || 'tmux',
    systemctl: env.VOICE_SETUP_SYSTEMCTL_BIN || 'systemctl',
    loginctl: env.VOICE_SETUP_LOGINCTL_BIN || 'loginctl',
    launchctl: env.VOICE_SETUP_LAUNCHCTL_BIN || 'launchctl',
    plutil: env.VOICE_SETUP_PLUTIL_BIN || 'plutil',
    tailscale:
      env.VOICE_SETUP_TAILSCALE_BIN ||
      (platform === 'darwin' && !findCommand('tailscale', env.PATH) && existsSync(MAC_TAILSCALE) ? MAC_TAILSCALE : 'tailscale'),
  }
  const telegramApi = env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org'
  const githubApi = env.VOICE_GW_GITHUB_API || 'https://api.github.com'
  const reposPath = env.VOICE_GW_DOCKER_REPOS || '/repos'
  const settingsFile = join(secretsDir, SETTINGS_FILE_NAME)
  const workerSecrets = join(secretsDir, 'worker')
  const files = {
    telegramToken: join(secretsDir, 'telegram_token'),
    telegramChatId: join(secretsDir, 'telegram_chat_id'),
    githubToken: join(workerSecrets, 'github_token'),
    claudeToken: join(workerSecrets, 'claude_token'),
  }
  const FIELDS = fields(root)
  const output = (command, args, options = {}) => capture(command, args, { env, ...options })

  // Saved secrets, for reuse and for redaction; new ones from the page.
  const saved = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readSecret(file)]))
  const draft = { telegramToken: null, telegramChatId: null, githubToken: null, claudeToken: null }
  const known = { telegramBot: null, githubUser: null }
  const jobs = new Map()
  let finishing = null

  function redact(text) {
    let clean = String(text)
    for (const secret of [setupToken, ...Object.values(saved), ...Object.values(draft)]) {
      if (secret && secret.length >= 6) clean = clean.split(secret).join('‹secret›')
    }
    return clean
  }
  const secret = name => draft[name] ?? saved[name]
  const status = name => (draft[name] ? 'new' : saved[name] ? 'saved' : null)

  // --- jobs: long steps with their output for the page --------------------

  function startJob(title, work) {
    const job = { id: randomBytes(6).toString('hex'), title, state: 'running', lines: [], seen: false }
    jobs.set(job.id, job)
    const line = text => {
      job.lines.push(redact(text).slice(0, 400))
      if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES)
    }
    say(`setup: ${title} started`)
    work(line)
      .then(ok => {
        job.state = ok === false ? 'failed' : 'done'
      })
      .catch(error => {
        line(`failed: ${error.message}`)
        job.state = 'failed'
      })
      .finally(() => say(`setup: ${title} ${job.state}`))
    return { job: job.id }
  }

  const snapshot = job => ({ id: job.id, title: job.title, state: job.state, lines: job.lines })

  // --- what the page shows at the start -----------------------------------

  async function checks() {
    const [claude, git, gh, docker, tmux, tailscale] = await Promise.all([
      output(bin.claude, ['--version']),
      output(bin.git, ['--version']),
      output(bin.gh, ['auth', 'status']),
      output(bin.docker, ['version', '--format', '{{.Server.Version}}']),
      output(bin.tmux, ['-V']),
      output(bin.tailscale, ['version']),
    ])
    const claudeVersion = /(\d+)\.(\d+)\.(\d+)/.exec(claude.text)?.slice(1).map(Number)
    const node = Number(process.versions.node.split('.')[0])
    return [
      { name: 'Node.js', ok: node >= 20, detail: process.version, need: 'Node.js 20 or newer' },
      {
        name: 'npm install',
        ok: existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk')),
        detail: 'dependencies',
        need: `run npm install in ${root}`,
      },
      {
        name: 'Claude Code',
        ok: claude.code === 0 && Boolean(claudeVersion) && newer(claudeVersion, MIN_CLAUDE),
        detail: claudeVersion ? claudeVersion.join('.') : 'not found',
        need: `version ${MIN_CLAUDE.join('.')} or later, logged in with claude.ai`,
      },
      { name: 'git', ok: git.code === 0, detail: git.code === 0 ? git.text.split('\n')[0] : 'not found', need: 'for the workers' },
      { name: 'GitHub CLI', ok: gh.code === 0, detail: gh.code === 0 ? 'logged in' : gh.code === null ? 'not found' : 'not logged in', need: 'gh auth login, for pushing and pull requests on this computer' },
      { name: 'Docker', ok: docker.code === 0, optional: true, detail: docker.code === 0 ? `server ${redact(docker.text.trim())}` : 'not available', need: 'only for workers in Docker' },
      { name: 'tmux', ok: tmux.code === 0, optional: true, detail: tmux.code === 0 ? tmux.text.trim() : 'not found', need: 'to keep the controller running' },
      { name: 'Tailscale', ok: tailscale.code === 0, optional: true, detail: tailscale.code === 0 ? tailscale.text.split('\n')[0] : 'not found', need: 'one way to publish the endpoint (scripts/funnel.sh)' },
    ]
  }

  async function repositories(workerRoot, folder) {
    const runner = new HostRunner(workerRoot)
    const names = await runner.names()
    const host = await Promise.all(
      names.map(async name => {
        const origin = await runner.git(runner.dir(name), 'remote', 'get-url', 'origin')
        return { name, slug: githubSlug(origin?.trim() || null) }
      }),
    )
    let docker = []
    try {
      // Names only: no git runs in the container's folder on this computer.
      docker = readdirSync(folder, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort()
    } catch {
      docker = []
    }
    return { host: host.filter(repo => repo.slug), docker }
  }

  function mcpOverrides() {
    try {
      const mcp = JSON.parse(readFileSync(join(root, 'controller', '.mcp.json'), 'utf8'))
      return Object.keys(mcp.mcpServers?.voice?.env ?? {}).filter(name => FIELDS[name])
    } catch {
      return []
    }
  }

  function unitFile() {
    return platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT}.plist`)
      : join(home, '.config', 'systemd', 'user', `${SERVICE}.service`)
  }

  // macOS: launchd's domain for this user's LaunchAgents, and whether ours is
  // loaded there (launchctl print answers 113 when it is not).
  const launchDomain = () => `gui/${uid}`
  const launchService = () => `${launchDomain()}/${LAUNCH_AGENT}`
  const launchLoaded = async () => (await output(bin.launchctl, ['print', launchService()])).code === 0
  const tmuxSession = async () => (await output(bin.tmux, ['has-session', '-t', 'voice'])).code === 0

  // Lingering: systemd starts the user's services at boot and keeps them
  // running without a login. Without it they start at a login and stop soon
  // after the last one ends, an SSH session too.
  async function lingering() {
    return /^Linger=yes$/m.test((await output(bin.loginctl, ['show-user', String(uid), '-p', 'Linger'])).text)
  }

  async function state({ server }) {
    const current = readSettings(settingsFile)
    const settings = Object.fromEntries(Object.entries(FIELDS).map(([name, field]) => [name, current[name] ?? field.default]))
    const [list, git, watchdog, linger, loaded] = await Promise.all([
      checks(),
      Promise.all([output(bin.git, ['config', '--global', 'user.name']), output(bin.git, ['config', '--global', 'user.email'])]),
      output(join(root, 'scripts', 'start-controller.sh'), ['--status'], { env: { ...env, VOICE_GW_SECRETS_DIR: secretsDir } }),
      platform === 'darwin' ? null : lingering(),
      platform === 'darwin' ? launchLoaded() : null,
    ])
    const plugin = channelMode({ env, root })
    return {
      host: hostname(),
      root,
      remaining: server?.remaining ?? null,
      checks: list,
      settings,
      defaults: Object.fromEntries(Object.entries(FIELDS).map(([name, field]) => [name, field.default])),
      overridden: mcpOverrides(),
      secrets: Object.fromEntries(Object.keys(files).map(name => [name, status(name)])),
      telegram: { bot: known.telegramBot },
      github: known.githubUser,
      repos: await repositories(settings.VOICE_GW_WORKER_ROOT, settings.VOICE_GW_DOCKER_FOLDER),
      git: { name: git[0].code === 0 ? git[0].text.trim() : '', email: git[1].code === 0 ? git[1].text.trim() : '' },
      models: MODELS,
      efforts: EFFORTS,
      levels: ACCESS_LEVELS,
      watchdog: {
        status: redact(watchdog.text.trim().split('\n')[0] ?? ''),
        platform,
        unit: unitFile(),
        unitExists: existsSync(unitFile()),
        linger,
        loaded, // macOS: the LaunchAgent is loaded in launchd
      },
      plugin: {
        mode: plugin.mode,
        reason: plugin.reason,
        allowlist: { marketplace: MARKETPLACE, plugin: PLUGIN },
      },
      // Claude in Chrome's notice for the first start, confirmed already in
      // Claude Code's config: true, false, or null when it cannot tell. Read
      // only; the page warns unless it is true.
      chrome: { noticeSeen: chromeNoticeSeen({ env, home }) },
    }
  }

  // --- Telegram -------------------------------------------------------------

  const telegram = (token, chatId = '') => new Telegram({ token, chatId, apiBase: telegramApi })

  async function telegramToken({ body }) {
    const token = String(body.token ?? '').trim()
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw fail('That does not look like a bot token from BotFather (digits, a colon, then about 35 characters).')
    let bot
    try {
      bot = await telegram(token).getMe()
    } catch (error) {
      throw fail(error.status === 401 || error.status === 404 ? 'Telegram does not know this token.' : `Telegram did not answer: ${redact(error.message)}`)
    }
    draft.telegramToken = token
    known.telegramBot = bot.username ? `@${bot.username}` : bot.first_name ?? 'your bot'
    say(`setup: Telegram bot ${known.telegramBot} checked`)
    return { bot: known.telegramBot }
  }

  async function telegramChats() {
    const token = secret('telegramToken')
    if (!token) throw fail('Enter and check the bot token first.')
    let updates
    try {
      updates = await telegram(token).getUpdates({ timeout: 0 })
    } catch (error) {
      if (error.status === 409) {
        throw fail('Telegram says another program reads this bot (a webhook, or a running gateway that polls it). Stop it, write to the bot again, then try again.')
      }
      throw fail(`Telegram did not answer: ${redact(error.message)}`)
    }
    const chats = new Map()
    for (const update of updates) {
      const chat = update.message?.chat
      if (chat?.type !== 'private' || chats.has(chat.id)) continue
      const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'unnamed'
      chats.set(chat.id, { id: String(chat.id), name: chat.username ? `${name} (@${chat.username})` : name })
    }
    return { chats: [...chats.values()] }
  }

  async function telegramTest({ body }) {
    const token = secret('telegramToken')
    const chatId = String(body.chatId ?? '').trim()
    if (!token) throw fail('Enter and check the bot token first.')
    if (!/^-?\d{1,20}$/.test(chatId)) throw fail('Choose your chat first.')
    try {
      await telegram(token, chatId).send(`cc-voice-gateway on ${hostname()}: test message from the setup assistant. Telegram works.`)
    } catch (error) {
      throw fail(`Not sent: ${redact(error.message)}`)
    }
    draft.telegramChatId = chatId
    say('setup: Telegram test message sent')
    return { sent: true }
  }

  // --- GitHub -----------------------------------------------------------------

  async function githubToken({ body }) {
    const token = String(body.token ?? '').trim()
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw fail('That does not look like a GitHub token.')
    let response
    try {
      response = await fetch(`${githubApi.replace(/\/+$/, '')}/user`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'cc-voice-gateway-setup',
        },
        signal: AbortSignal.timeout(10000),
      })
    } catch (error) {
      throw fail(`GitHub did not answer: ${redact(error.message)}`)
    }
    if (response.status === 401) throw fail('GitHub rejected the token.')
    if (!response.ok) throw fail(`GitHub answered ${response.status}.`)
    const user = await response.json().catch(() => ({}))
    draft.githubToken = token
    known.githubUser = {
      login: user.login ?? '?',
      kind: token.startsWith('github_pat_') ? 'fine-grained' : token.startsWith('ghp_') ? 'classic' : 'other',
      scopes: response.headers.get('x-oauth-scopes') ?? null,
      expires: response.headers.get('github-authentication-token-expiration') ?? null,
    }
    say(`setup: GitHub token of ${known.githubUser.login} checked`)
    return known.githubUser
  }

  const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

  // The access level per repository, with the gateway's own detection.
  async function githubLevels({ body }) {
    const repos = Array.isArray(body.repos) ? body.repos.map(String) : []
    if (repos.length > 50 || repos.some(slug => !SLUG.test(slug))) throw fail('Repositories as owner/name, at most 50.')
    const forced = ACCESS_LEVELS.includes(body.forced) ? body.forced : ''
    const access = new GitHubAccess({ token: secret('githubToken') ?? '', apiBase: githubApi, forced })
    const levels = await Promise.all(
      repos.map(async slug => {
        const { level, reason, visibility } = await access.check(slug)
        return { slug, level, reason: redact(reason), visibility }
      }),
    )
    return { levels }
  }

  // --- Claude Code's login for the container ---------------------------------

  async function claudeToken({ body }) {
    const token = String(body.token ?? '').trim()
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(token)) throw fail('A token from claude setup-token starts with sk-ant-.')
    draft.claudeToken = token
    say('setup: Claude Code token for the container taken')
    return { claudeToken: 'new' }
  }

  // --- Docker -------------------------------------------------------------------

  async function build(image, line) {
    const code = await runCommand(
      bin.docker,
      ['build', '-t', image, '--build-arg', `UID=${uid}`, '--build-arg', `GID=${gid}`, join(root, 'docker')],
      { env: { ...env, BUILDKIT_PROGRESS: 'plain' }, onLine: line, timeoutMs: 30 * 60 * 1000 },
    )
    line(code === 0 ? `image ${image} built` : `docker build failed (exit ${code})`)
    return code === 0
  }

  async function dockerBuild({ body }) {
    const image = String(body.image ?? FIELDS.VOICE_GW_DOCKER_IMAGE.default)
    if (!IMAGE(image)) throw fail('Not a valid image name.')
    return startJob(`building the image ${image}`, line => build(image, line))
  }

  // --- finishing: validate everything, then write and set up -------------------

  function validate(body) {
    const values = { ...(body.settings ?? {}) }
    const problems = []
    for (const [name, value] of Object.entries(values)) {
      const field = FIELDS[name]
      if (!field) problems.push(`unknown setting ${name}`)
      else if (String(value ?? '') !== '' && !field.valid(String(value))) problems.push(`${name}: not a valid value`)
    }
    const docker = body.docker?.enabled ? body.docker : null
    if (docker) {
      if (!values.VOICE_GW_DOCKER) problems.push('Docker: name the container')
      if (!secret('claudeToken')) problems.push('Docker: the container needs a token from claude setup-token')
      for (const slug of docker.repos ?? []) if (!SLUG.test(String(slug))) problems.push(`Docker: ${slug} is not owner/name`)
      for (const key of ['gitName', 'gitEmail']) {
        if (/[\r\n\0]/.test(String(docker[key] ?? '')) || String(docker[key] ?? '').length > 200) problems.push(`Docker: ${key} is not valid`)
      }
    }
    // Work folders: a root the gateway takes, and a container of their own.
    const scratch = values.VOICE_GW_SCRATCH === '1'
    if (scratch) {
      const folder = String(values.VOICE_GW_SCRATCH_ROOT || FIELDS.VOICE_GW_SCRATCH_ROOT.default)
      const workerRoot = docker ? null : String(values.VOICE_GW_WORKER_ROOT || FIELDS.VOICE_GW_WORKER_ROOT.default)
      const problem = PATH(folder) && scratchProblem(folder, { gateway: root, workerRoot, home })
      if (problem) problems.push(`Work folders: ${folder} ${problem}`)
    }
    const scratchDocker = scratch && values.VOICE_GW_SCRATCH_DOCKER ? String(values.VOICE_GW_SCRATCH_DOCKER) : null
    if (scratchDocker) {
      if (!secret('claudeToken')) problems.push('Work folders: their container needs a token from claude setup-token (section 5)')
      if (docker && scratchDocker === values.VOICE_GW_DOCKER) problems.push('Work folders: their container needs a name of its own, not the worker container\'s')
    }
    if (body.telegram?.enabled && !(secret('telegramToken') && secret('telegramChatId'))) {
      problems.push('Telegram: check the token and send the test message first')
    }
    if (problems.length) throw fail(problems.join('; '))
    return { values, docker, scratchDocker }
  }

  function settingsText(values, docker) {
    const merged = { ...readSettings(settingsFile) }
    for (const [name, field] of Object.entries(FIELDS)) {
      if (!(name in values)) continue
      const value = String(values[name] ?? '')
      if (value === '' || value === field.default) delete merged[name]
      else merged[name] = value
    }
    if (!docker) delete merged.VOICE_GW_DOCKER
    return formatSettings(merged, [
      'Settings of cc-voice-gateway, written by the setup assistant (scripts/setup.mjs).',
      'One VOICE_GW_NAME=value per line; the environment and controller/.mcp.json win.',
    ])
  }

  // Returns the settings before and after, for liveNote.
  function writeFiles({ values, docker, scratchDocker, telegramOn }, line) {
    secureFolder(secretsDir)
    const before = readSettings(settingsFile)
    const written = []
    const put = (file, value) => {
      writePrivate(file, value)
      written.push(file.slice(secretsDir.length + 1))
    }
    if (telegramOn) {
      if (draft.telegramToken) put(files.telegramToken, draft.telegramToken)
      if (draft.telegramChatId) put(files.telegramChatId, draft.telegramChatId)
    } else {
      // Turned off on the page: the gateway and the watchdog only check
      // whether both files are there.
      const removed = [files.telegramToken, files.telegramChatId].filter(file => existsSync(file))
      for (const file of removed) rmSync(file)
      if (removed.length) line(`Telegram turned off: removed ${removed.map(file => file.slice(secretsDir.length + 1)).join(', ')}`)
    }
    // Claude Code's token for either container; the GitHub token only for
    // the workers'.
    if (docker || scratchDocker) {
      secureFolder(workerSecrets)
      if (draft.claudeToken) put(files.claudeToken, draft.claudeToken)
      if (docker && draft.githubToken) put(files.githubToken, draft.githubToken)
    }
    put(settingsFile, settingsText(values, docker))
    // Saved files from before get the same modes.
    for (const file of Object.values(files)) if (existsSync(file)) chmodSync(file, 0o600)
    if (existsSync(workerSecrets)) chmodSync(workerSecrets, 0o700)
    line(`written to ${secretsDir} (folders 0700, files 0600): ${written.join(', ')}`)
    say(`setup: written ${written.join(', ')}`)
    return { before, after: readSettings(settingsFile) }
  }

  // Whether a gateway runs on these secrets: its admin socket answers.
  function gatewayRuns() {
    return new Promise(resolve => {
      const socket = connect(join(secretsDir, 'admin.sock'))
      const done = running => {
        socket.destroy()
        resolve(running)
      }
      socket.on('connect', () => done(true))
      socket.on('error', () => done(false))
      socket.setTimeout(2000, () => done(false))
    })
  }

  // A gateway that runs takes the worker limits from the settings file at
  // once (src/live.mjs); every other setting at its next start.
  async function liveNote({ before, after }, line) {
    const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name])
    if (!names.length || !(await gatewayRuns())) return
    const limits = names.filter(name => name in WORKER_LIMITS)
    const others = names.filter(name => !(name in WORKER_LIMITS))
    if (limits.length) {
      line(`the running gateway applies ${limits.join(' and ')} at once, without a restart; runs going run to the end`)
    }
    if (others.length) {
      line(`the running gateway takes the other changed settings (${others.join(', ')}) at its next start: restart the controller`)
    }
  }

  async function setUpDocker(values, docker, line) {
    const container = values.VOICE_GW_DOCKER
    const image = values.VOICE_GW_DOCKER_IMAGE || FIELDS.VOICE_GW_DOCKER_IMAGE.default
    const folder = values.VOICE_GW_DOCKER_FOLDER || FIELDS.VOICE_GW_DOCKER_FOLDER.default
    const run = (args, timeoutMs) => runCommand(bin.docker, args, { env, onLine: line, timeoutMs })
    if ((await output(bin.docker, ['image', 'inspect', image])).code !== 0) {
      line(`the image ${image} is not there yet; building it`)
      if (!(await build(image, line))) return false
    }
    mkdirSync(folder, { recursive: true })
    line(`starting the container ${container} with ${folder} as /repos`)
    const started = await runCommand(join(root, 'scripts', 'start-workers-container.sh'), [], {
      env: {
        ...env,
        VOICE_GW_DOCKER: container,
        VOICE_GW_DOCKER_FOLDER: folder,
        VOICE_GW_DOCKER_IMAGE: image,
        VOICE_GW_DOCKER_BIN: bin.docker,
        VOICE_GW_SECRETS_DIR: secretsDir,
      },
      onLine: line,
      timeoutMs: 120000,
    })
    if (started !== 0) {
      line('the container did not start')
      return false
    }
    if (docker.gitName) await run(['exec', container, 'git', 'config', '--global', 'user.name', docker.gitName], 30000)
    if (docker.gitEmail) await run(['exec', container, 'git', 'config', '--global', 'user.email', docker.gitEmail], 30000)
    let ok = true
    for (const slug of docker.repos ?? []) {
      const name = slug.split('/')[1]
      if (existsSync(join(folder, name))) {
        line(`${name}: already in the folder`)
        continue
      }
      line(`${name}: cloning ${slug} inside the container`)
      const code = await run(['exec', container, 'git', 'clone', `https://github.com/${slug}.git`, `${reposPath}/${name}`], 15 * 60 * 1000)
      if (code !== 0) {
        line(`${name}: clone failed (exit ${code}); a private repository needs a token that can read it`)
        ok = false
      }
    }
    return ok
  }

  // The container of the work folders, from the worker image: the start
  // script with --scratch, which mounts only the folder and Claude Code's
  // token.
  async function setUpScratchDocker(values, line) {
    const container = values.VOICE_GW_SCRATCH_DOCKER
    const image = values.VOICE_GW_DOCKER_IMAGE || FIELDS.VOICE_GW_DOCKER_IMAGE.default
    const folder = values.VOICE_GW_SCRATCH_ROOT || FIELDS.VOICE_GW_SCRATCH_ROOT.default
    if ((await output(bin.docker, ['image', 'inspect', image])).code !== 0) {
      line(`the image ${image} is not there yet; building it`)
      if (!(await build(image, line))) return false
    }
    line(`starting the container ${container} with ${folder} as /scratch, for the work folders`)
    const started = await runCommand(join(root, 'scripts', 'start-workers-container.sh'), ['--scratch'], {
      env: {
        ...env,
        VOICE_GW_SCRATCH_DOCKER: container,
        VOICE_GW_SCRATCH_ROOT: folder,
        VOICE_GW_DOCKER: values.VOICE_GW_DOCKER || '',
        VOICE_GW_DOCKER_IMAGE: image,
        VOICE_GW_DOCKER_BIN: bin.docker,
        VOICE_GW_SECRETS_DIR: secretsDir,
      },
      onLine: line,
      timeoutMs: 120000,
    })
    if (started !== 0) line('the container for the work folders did not start')
    return started === 0
  }

  // The tmux the autostart runs, by its full path: launchd does not search
  // the PATH it sets for the job, and Homebrew's tmux is not in its own.
  const tmuxPath = () => findCommand(bin.tmux, env.PATH) ?? bin.tmux

  // Where the LaunchAgent's own output goes: tmux's, a line at most. The
  // controller logs to .logs/gateway.log as on Linux.
  const launchLog = () => join(home, 'Library', 'Logs', `${SERVICE}.log`)

  function unitText() {
    const start = join(root, 'scripts', 'start-controller.sh')
    if (platform === 'darwin') {
      // At every login (RunAtLoad), and once now when loaded. Like the
      // systemd unit's Type=forking: tmux starts its server and returns, so
      // no KeepAlive, or launchd would start it again and again; the watchdog
      // in the tmux session restarts the controller. AbandonProcessGroup:
      // the tmux server stays when its starter ends.
      const xml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const string = text => `<string>${xml(text)}</string>`
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `  <key>Label</key>${string(LAUNCH_AGENT)}`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...[tmuxPath(), 'new-session', '-d', '-s', 'voice', start].map(arg => `    ${string(arg)}`),
        '  </array>',
        `  <key>WorkingDirectory</key>${string(root)}`,
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        `    <key>PATH</key>${string(env.PATH ?? '')}`,
        '  </dict>',
        '  <key>RunAtLoad</key><true/>',
        '  <key>KeepAlive</key><false/>',
        '  <key>AbandonProcessGroup</key><true/>',
        `  <key>StandardOutPath</key>${string(launchLog())}`,
        `  <key>StandardErrorPath</key>${string(launchLog())}`,
        '</dict>',
        '</plist>',
        '',
      ].join('\n')
    }
    // systemd reads % as a specifier everywhere and $ as a variable in Exec
    // lines, so both are doubled there. WorkingDirectory= takes no quotes: with
    // them, systemd refuses the whole unit ("path is not absolute").
    const literal = text => text.replace(/%/g, '%%')
    const quote = text => `"${literal(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    const exec = text => quote(text).replace(/\$/g, '$$$$')
    return [
      '# Written by the cc-voice-gateway setup assistant (scripts/setup.mjs).',
      '[Unit]',
      'Description=cc-voice-gateway: the controller under its watchdog, in the tmux session "voice"',
      'After=network-online.target',
      '',
      '[Service]',
      'Type=forking',
      'RemainAfterExit=yes',
      `WorkingDirectory=${literal(root)}`,
      `Environment=${quote(`PATH=${env.PATH ?? ''}`)}`,
      `ExecStart=${exec(tmuxPath())} new-session -d -s voice ${exec(start)}`,
      `ExecStop=${exec(start)} --stop`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n')
  }

  // macOS: the LaunchAgent, checked with plutil. launchd loads it at every
  // login and then starts the controller. Loading it now (bootstrap) starts
  // it at once, so only when it is to start now; loaded already, a kickstart
  // runs it again. Returns whether the controller is to run, or null when
  // there is nothing to start now.
  async function launchAgent(file, startNow, line) {
    const lint = await output(bin.plutil, ['-lint', file])
    if (lint.code !== 0 && lint.code !== null) {
      line(`plutil finds the LaunchAgent invalid: ${lint.text}`)
      return false
    }
    const domain = launchDomain()
    const service = launchService()
    const loaded = await launchLoaded()
    const reload = `launchctl bootout ${service}; launchctl bootstrap ${domain} ${file}`
    if (!startNow) {
      line(
        loaded
          ? `the LaunchAgent ${LAUNCH_AGENT} is loaded; a changed file counts from your next login, or now with: ${reload}`
          : `the LaunchAgent ${LAUNCH_AGENT} starts the controller in tmux at your next login; to load it now, which also starts it: launchctl bootstrap ${domain} ${file}`,
      )
      return null
    }
    if (await tmuxSession()) {
      line(`the tmux session "voice" already runs; not started again${loaded ? '' : `. The LaunchAgent starts it at your next login, or: launchctl bootstrap ${domain} ${file}`}`)
      return null
    }
    const args = loaded ? ['kickstart', service] : ['bootstrap', domain, file]
    const code = await runCommand(bin.launchctl, args, { env, onLine: line, timeoutMs: 30000 })
    if (code !== 0) {
      line(`launchctl ${args[0]} failed; the LaunchAgent is there: ${file}`)
      return false
    }
    line(
      loaded
        ? `the LaunchAgent ${LAUNCH_AGENT} was loaded already, with the file as it was then (a changed one counts after: ${reload}); started it with launchctl kickstart`
        : `LaunchAgent ${LAUNCH_AGENT} loaded: launchd starts the controller in tmux at every login, and started it now`,
    )
    // launchd starts the job on its own time: wait for its tmux session.
    for (let i = 0; i < 20; i++) {
      if (await tmuxSession()) {
        line('the controller runs in the tmux session "voice": tmux attach -t voice, and answer its questions at the first start')
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    line(`no tmux session "voice" after 10 seconds; see ${launchLog()} and .logs/gateway.log`)
    return false
  }

  async function setUpWatchdog(watchdog, line) {
    let ok = true
    let started = false
    if (watchdog.autostart) {
      const file = unitFile()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, unitText(), { mode: 0o644 })
      line(`autostart written: ${file}`)
      if (platform === 'darwin') {
        const launched = await launchAgent(file, Boolean(watchdog.startNow), line)
        ok = launched !== false
        started = launched !== false // if launchd did not start it, tmux below does
      } else {
        const reload = await runCommand(bin.systemctl, ['--user', 'daemon-reload'], { env, onLine: line, timeoutMs: 30000 })
        const enable = await runCommand(bin.systemctl, ['--user', 'enable', `${SERVICE}.service`], { env, onLine: line, timeoutMs: 30000 })
        ok = reload === 0 && enable === 0
        if (!ok) {
          line('systemctl failed; the unit file is there')
        } else {
          line(`systemd user service ${SERVICE} enabled`)
          // Lingering makes it a start at boot. Refused, the step stays done:
          // the service still starts at a login, and the line says what to run.
          const boot = 'the controller starts at boot and keeps running without a login'
          if (await lingering()) {
            line(`lingering already on: ${boot}`)
          } else {
            const linger = await runCommand(bin.loginctl, ['enable-linger', String(uid)], { env, onLine: line, timeoutMs: 30000 })
            line(
              linger === 0
                ? `lingering turned on: ${boot}`
                : `loginctl enable-linger failed; it needs sudo loginctl enable-linger ${uid}, and until then the controller starts only at a login`,
            )
          }
        }
      }
    }
    if (watchdog.startNow && !started) {
      if (await tmuxSession()) {
        line('the tmux session "voice" already runs; not started again')
      } else {
        const code = await runCommand(bin.tmux, ['new-session', '-d', '-s', 'voice', join(root, 'scripts', 'start-controller.sh')], {
          env,
          cwd: root,
          onLine: line,
          timeoutMs: 30000,
        })
        ok = ok && code === 0
        line(code === 0 ? 'the controller runs in the tmux session "voice": tmux attach -t voice, and answer its questions at the first start' : 'tmux failed')
      }
    }
    return ok
  }

  // With Claude in Chrome on: its notice for the first start waits for Enter
  // at the terminal. The start script marks it as seen before each start, but
  // cannot always; confirmed once by hand, no restart waits for it.
  const chromeNote = () =>
    chromeNoticeSeen({ env, home }) === true
      ? 'Claude in Chrome: its notice for the first start is confirmed already for this user; restarts do not wait for it'
      : 'Claude in Chrome: before relying on unattended restarts, start Claude Code once at the terminal as this user with ' +
        'claude --chrome, confirm the Claude in Chrome notice with Enter and leave with /exit; otherwise a restart can hang ' +
        'on that notice'

  async function finish({ body, server }) {
    if (finishing) throw fail('The setup is already being written.', 409)
    const { values, docker, scratchDocker } = validate(body)
    const telegramOn = Boolean(body.telegram?.enabled)
    finishing = startJob('writing the setup', async line => {
      const settings = writeFiles({ values, docker, scratchDocker, telegramOn }, line)
      await liveNote(settings, line)
      let ok = true
      if (docker) ok = (await setUpDocker(values, docker, line)) && ok
      if (scratchDocker) ok = (await setUpScratchDocker(values, line)) && ok
      if (body.watchdog?.autostart || body.watchdog?.startNow) ok = (await setUpWatchdog(body.watchdog, line)) && ok
      if (settings.after.VOICE_GW_CONTROLLER_CHROME === '1') line(chromeNote())
      if (body.plugin?.register && channelMode({ env, root }).mode === 'plugin-register') {
        const code = await runCommand(bin.claude, ['plugin', 'marketplace', 'add', root], { env, onLine: line, timeoutMs: 60000 })
        line(code === 0 ? `registered this repository as the marketplace ${MARKETPLACE}` : 'registering the marketplace failed; the start script tries again')
      }
      line(ok ? 'done' : 'done, with problems above')
      return ok
    }).job
    // The server ends by itself once the page has seen the result, or soon after.
    const watch = setInterval(() => {
      const job = jobs.get(finishing)
      if (job.state === 'running') return
      clearInterval(watch)
      setTimeout(() => server?.stop('the setup is written'), job.seen ? 1500 : 20000).unref?.()
    }, 200)
    return { job: finishing }
  }

  function jobState({ id, server }) {
    const job = jobs.get(id)
    if (!job) throw fail('no such job', 404)
    if (job.state !== 'running') {
      job.seen = true
      if (id === finishing) setTimeout(() => server?.stop('the setup is written'), 1500).unref?.()
    }
    return snapshot(job)
  }

  async function cancel({ server }) {
    setTimeout(() => server?.stop('cancelled in the browser, nothing written'), 200)
    return { cancelled: true }
  }

  return {
    redact,
    api: {
      'GET /api/state': state,
      'POST /api/telegram/token': telegramToken,
      'POST /api/telegram/chats': telegramChats,
      'POST /api/telegram/test': telegramTest,
      'POST /api/github/token': githubToken,
      'POST /api/github/levels': githubLevels,
      'POST /api/claude/token': claudeToken,
      'POST /api/docker/build': dockerBuild,
      'POST /api/finish': finish,
      'POST /api/cancel': cancel,
      'GET /api/jobs/:id': jobState,
    },
  }
}
