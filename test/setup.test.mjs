// The setup assistant (scripts/setup.mjs, src/setup/): its guard (the
// one-time token, the session, the rate limit, the origin check and the
// timeouts), and its steps with stand-ins: one local HTTP server answers as
// the Telegram Bot API and as the GitHub API, and fake docker, tmux,
// systemctl, loginctl, launchctl, plutil, gh and claude commands record what
// they are asked to do. At the end: the files in .secrets and their modes, and
// that no secret reaches a log line, the terminal or a response. The autostart
// on Linux and on macOS, whichever this runs on.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-setup-'))
// Whatever the modules here log goes to a file of this test, never the real log.
process.env.VOICE_GW_LOG_FILE = join(TMP, 'gateway.log')
const { createSetup } = await import('../src/setup/actions.mjs')
const { COOKIE, newToken, sameSecret, startSetupServer } = await import('../src/setup/server.mjs')
const { formatSettings, readSettings } = await import('../src/settings.mjs')

const BIN = join(TMP, 'bin')
const SECRETS = join(TMP, 'secrets')
const FOLDER = join(TMP, 'docker-developer') // the container's clones, /repos in it
const DEV = join(TMP, 'dev') // the checkouts on this computer
const HOME = join(TMP, 'home')
const CALLS = join(TMP, 'calls.jsonl') // what the fake commands were asked to do
const ECHO = join(TMP, 'echo') // a line the fake docker build prints, to test redaction
const LINGER = join(TMP, 'linger') // the fake loginctl's lingering: yes, no (without the file), or denied
const LOADED = join(TMP, 'launch-agent-loaded') // the fake launchctl: the LaunchAgent is loaded
const SESSION = join(TMP, 'tmux-session') // the fake tmux: the session "voice" runs

const TELEGRAM_TOKEN = '987654321:TEST-telegram-token-never-shown-xyz12'
const GITHUB_TOKEN = 'github_pat_TEST_setup_token_never_shown_0123456789'
const CLAUDE_TOKEN = 'sk-ant-oat01-TEST-claude-token-never-shown-abcdef'
const CHAT_ID = '4242'
const SECRET_VALUES = [TELEGRAM_TOKEN, GITHUB_TOKEN, CLAUDE_TOKEN]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- one stand-in for the Telegram Bot API and the GitHub API ---------------------

const api = { server: null, url: '', sent: [], updates: [], requests: [] }
const REPOS = {
  'acme/guarded': { contents: true, pulls: true, protected: false, rules: [{ type: 'pull_request' }] },
  'acme/open': { contents: true, pulls: true, protected: false, rules: [] },
  'acme/readonly': { contents: false, pulls: false },
}

function answer(req, res, body) {
  const send = (status, data, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(data))
  }
  api.requests.push(`${req.method} ${req.url.replace(TELEGRAM_TOKEN, '<token>')}`)
  const telegram = /^\/bot([^/]+)\/(\w+)$/.exec(req.url)
  if (telegram) {
    if (telegram[1] !== TELEGRAM_TOKEN) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    if (telegram[2] === 'getMe') return send(200, { ok: true, result: { id: 1, is_bot: true, username: 'voice_test_bot', first_name: 'Voice' } })
    if (telegram[2] === 'getUpdates') return send(200, { ok: true, result: api.updates })
    if (telegram[2] === 'sendMessage') {
      api.sent.push(JSON.parse(body))
      return send(200, { ok: true, result: {} })
    }
    return send(404, { ok: false, description: 'Not Found' })
  }
  if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) return send(401, { message: 'Bad credentials' })
  if (req.url === '/user') {
    return send(200, { login: 'driver' }, { 'github-authentication-token-expiration': '2027-01-31 00:00:00 UTC' })
  }
  const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(req.url)
  const repo = match && REPOS[match[1]]
  if (!repo) return send(404, { message: 'Not Found' })
  const route = `${req.method} ${match[2] ?? ''}`
  if (route === 'GET ') return send(200, { visibility: 'private', private: true, default_branch: 'main', permissions: { push: true } })
  if (route === 'POST /git/refs') return send(repo.contents ? 422 : 403, {})
  if (route === 'POST /pulls') return send(repo.pulls ? 422 : 403, {})
  if (route === 'GET /branches/main') return send(200, { name: 'main', protected: repo.protected })
  if (route === 'GET /rules/branches/main') return send(200, repo.rules)
  send(404, { message: 'Not Found' })
}

// --- fake commands -----------------------------------------------------------------

const FAKE = name => `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ command: ${JSON.stringify(name)}, argv }) + '\\n')
const out = text => process.stdout.write(text + '\\n')
const BUILT = ${JSON.stringify(join(TMP, 'image-built'))}
switch (${JSON.stringify(name)}) {
  case 'claude':
    if (argv[0] === '--version') out('2.1.310 (Claude Code)')
    break
  case 'gh':
    break
  case 'tmux':
    if (argv[0] === '-V') out('tmux 3.4')
    if (argv[0] === 'has-session') process.exit(existsSync(${JSON.stringify(SESSION)}) ? 0 : 1)
    break
  case 'systemctl':
    break
  case 'launchctl':
    // print answers 113 for a service that is not loaded; bootstrap loads it,
    // and like kickstart has launchd run it, whose tmux starts the session.
    if (argv[0] === 'print') process.exit(existsSync(${JSON.stringify(LOADED)}) ? 0 : 113)
    if (argv[0] === 'bootstrap') writeFileSync(${JSON.stringify(LOADED)}, '')
    if (argv[0] === 'bootstrap' || argv[0] === 'kickstart') writeFileSync(${JSON.stringify(SESSION)}, '')
    break
  case 'plutil':
    out(argv[1] + ': OK')
    break
  case 'loginctl': {
    const linger = existsSync(${JSON.stringify(LINGER)}) ? readFileSync(${JSON.stringify(LINGER)}, 'utf8') : 'no'
    if (argv[0] === 'show-user') out('Linger=' + (linger === 'yes' ? 'yes' : 'no'))
    if (argv[0] === 'enable-linger' && linger === 'denied') {
      process.stderr.write('Could not enable linger: Access denied\\n')
      process.exit(1)
    }
    break
  }
  case 'docker':
    if (argv[0] === 'version') out('29.0.0')
    if (argv[0] === 'image') process.exit(existsSync(BUILT) ? 0 : 1)
    if (argv[0] === 'build') {
      out('#1 [internal] load build definition from Dockerfile')
      if (existsSync(${JSON.stringify(ECHO)})) out('#2 ' + readFileSync(${JSON.stringify(ECHO)}, 'utf8'))
      out('#9 naming to docker.io/library/' + argv[argv.indexOf('-t') + 1])
      writeFileSync(BUILT, '')
    }
    if (argv[0] === 'exec' && argv[2] === 'git' && argv[3] === 'clone') {
      mkdirSync(argv[5], { recursive: true })
      out("Cloning into '" + argv[5] + "'...")
    }
    break
}
`

const calls = () =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []

function makeRepo(name, origin) {
  const dir = join(DEV, name)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
}

// The environment the setup gets: every command a fake, every API the stand-in.
const setupEnv = () => ({
  ...process.env,
  VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
  VOICE_GW_DOCKER_BIN: join(BIN, 'docker'),
  VOICE_GW_GH_BIN: join(BIN, 'gh'),
  VOICE_SETUP_TMUX_BIN: join(BIN, 'tmux'),
  VOICE_SETUP_SYSTEMCTL_BIN: join(BIN, 'systemctl'),
  VOICE_SETUP_LOGINCTL_BIN: join(BIN, 'loginctl'),
  VOICE_SETUP_LAUNCHCTL_BIN: join(BIN, 'launchctl'),
  VOICE_SETUP_PLUTIL_BIN: join(BIN, 'plutil'),
  VOICE_SETUP_TAILSCALE_BIN: join(BIN, 'no-tailscale'),
  VOICE_GW_TELEGRAM_API: api.url,
  VOICE_GW_GITHUB_API: api.url,
  VOICE_GW_DOCKER_REPOS: FOLDER,
  VOICE_GW_STATE_DIR: join(TMP, 'state'),
  VOICE_GW_LOG_FILE: join(TMP, 'gateway.log'),
  CLAUDE_CONFIG_DIR: join(TMP, 'claude-config'),
  VOICE_GW_MANAGED_SETTINGS: join(TMP, 'no-managed-settings.json'),
  GIT_CONFIG_GLOBAL: join(TMP, 'gitconfig'),
})

// A browser: opens the link once, then sends the cookie and its origin.
async function browser(server, { token = server.token } = {}) {
  const base = `http://127.0.0.1:${server.port}`
  const first = await fetch(`${base}/?t=${token}`, { redirect: 'manual' })
  const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? ''
  const responses = []
  async function call(path, body, headers = {}) {
    const init =
      body === undefined
        ? { headers: { cookie, ...headers } }
        : {
            method: 'POST',
            headers: { cookie, origin: base, 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
          }
    const response = await fetch(base + path, init)
    const text = await response.text()
    responses.push(text)
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { status: response.status, data }
  }
  return { base, first, cookie, call, responses }
}

const terminal = [] // what the setup and its server print
const say = line => terminal.push(line)

before(async () => {
  mkdirSync(BIN, { recursive: true })
  for (const name of ['claude', 'gh', 'tmux', 'systemctl', 'loginctl', 'launchctl', 'plutil', 'docker']) {
    writeFileSync(join(BIN, name), FAKE(name))
    chmodSync(join(BIN, name), 0o755)
  }
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(TMP, 'gitconfig'), '[user]\n\tname = Test Driver\n\temail = driver@example.com\n')
  makeRepo('alpha', 'git@github.com:acme/guarded.git')
  makeRepo('beta', 'https://github.com/acme/open.git')
  api.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => answer(req, res, body))
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  api.url = `http://127.0.0.1:${api.server.address().port}`
})

after(() => {
  api.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

// --- the guard -------------------------------------------------------------------------

const ping = { 'GET /api/ping': () => ({ pong: true }), 'POST /api/echo': ({ body }) => ({ echo: body.text }) }
const guarded = options => startSetupServer({ host: '127.0.0.1', port: 0, api: ping, say, ...options })

test('the token: long and random, compared in constant time, whatever the length', () => {
  const token = newToken()
  assert.ok(token.length >= 43, 'at least 256 bits')
  assert.match(token, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(token, newToken())
  assert.ok(sameSecret(token, token))
  assert.ok(!sameSecret(token.slice(0, -1), token), 'a shorter guess is just wrong, not an error')
  assert.ok(!sameSecret('', token))
})

test('the session: the first use binds the setup to that browser, and the link alone stops working', async () => {
  const server = await guarded({})
  try {
    const page = await browser(server)
    assert.equal(page.first.status, 303)
    assert.equal(page.first.headers.get('location'), '/', 'the token leaves the address bar')
    const cookie = page.first.headers.get('set-cookie')
    assert.match(cookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`))
    assert.ok(!cookie.includes(server.token), 'the session is not the token')

    const html = await fetch(`${page.base}/`, { headers: { cookie: page.cookie } })
    assert.equal(html.status, 200)
    const text = await html.text()
    assert.match(text, /<title>cc-voice-gateway setup<\/title>/)
    // Plain HTTP: a notice at the very top, above everything else, never hidden.
    const notice = /<body>\s*<div id="local-notice"([^>]*)>([\s\S]*?)<\/div>/.exec(text)
    assert.ok(notice, 'the notice is the first element of the page')
    assert.doesNotMatch(notice[1], /hidden/)
    const said = notice[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    assert.match(said, /Local setup: use it only on your own network\./)
    assert.match(said, /no HTTPS, so the one-time token and the keys you enter here travel unencrypted/)
    assert.doesNotMatch(await (await fetch(`${page.base}/app.js`, { headers: { cookie: page.cookie } })).text(), /local-notice/, 'no script hides it')
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/)
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(html.headers.get('cache-control'), 'no-store')
    assert.deepEqual((await page.call('/api/ping')).data, { pong: true })

    // The same link in another browser, or again without the cookie.
    const again = await fetch(`${page.base}/?t=${server.token}`, { redirect: 'manual' })
    assert.equal(again.status, 403)
    assert.equal(again.headers.get('set-cookie'), null)
    assert.equal((await fetch(`${page.base}/api/ping`)).status, 401)
    assert.equal((await fetch(`${page.base}/`)).status, 401)
    const forged = await fetch(`${page.base}/api/ping`, { headers: { cookie: `${COOKIE}=${'A'.repeat(43)}` } })
    assert.equal(forged.status, 401)
  } finally {
    await server.stop('test over')
  }
})

test('wrong tokens are rate-limited per address: then even the right one waits', async () => {
  const server = await guarded({})
  try {
    const base = `http://127.0.0.1:${server.port}`
    for (let i = 0; i < 5; i++) {
      const wrong = await fetch(`${base}/?t=${newToken()}`, { redirect: 'manual' })
      assert.equal(wrong.status, 403, `wrong token ${i + 1}`)
    }
    const right = await fetch(`${base}/?t=${server.token}`, { redirect: 'manual' })
    assert.equal(right.status, 429)
    assert.equal(right.headers.get('set-cookie'), null)
    assert.ok(terminal.some(line => /a wrong or used link from 127\.0\.0\.1/.test(line)))
  } finally {
    await server.stop('test over')
  }
})

test('write requests need the page\'s own origin and JSON', async () => {
  const server = await guarded({})
  try {
    const page = await browser(server)
    const post = headers => page.call('/api/echo', { text: 'hi' }, headers)
    assert.equal((await post({ origin: 'http://evil.example' })).status, 403)
    assert.equal((await post({ origin: '' })).status, 403, 'no origin at all')
    assert.equal((await post({ 'content-type': 'text/plain' })).status, 415)
    assert.deepEqual((await post({})).data, { echo: 'hi' })
    assert.equal((await page.call('/api/nothing', {})).status, 404)
  } finally {
    await server.stop('test over')
  }
})

test('timeouts: the server ends by itself when idle, and at its overall limit despite activity', async () => {
  const idle = await guarded({ idleMs: 300 })
  assert.match(await idle.done, /no activity/)
  assert.equal(await fetch(`http://127.0.0.1:${idle.port}/`).catch(() => 'closed'), 'closed')

  const busy = await guarded({ idleMs: 400, timeoutMs: 900 })
  const page = await browser(busy)
  const started = Date.now()
  let ended = null
  busy.done.then(reason => (ended = reason))
  while (!ended && Date.now() - started < 3000) {
    await page.call('/api/ping').catch(() => {})
    await sleep(100)
  }
  assert.match(ended, /time limit/)
  assert.ok(Date.now() - started < 1500, 'activity does not extend the overall limit')

  // Wrong tokens do not count as activity.
  const ignored = await guarded({ idleMs: 400 })
  const knock = setInterval(() => fetch(`http://127.0.0.1:${ignored.port}/?t=x`).catch(() => {}), 100)
  assert.match(await ignored.done, /no activity/)
  clearInterval(knock)
})

test('the command shows its link only on a terminal, never in a pipe', () => {
  const cli = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--host', '127.0.0.1', '--port', '0'], {
    encoding: 'utf8',
    env: { ...process.env, VOICE_GW_SECRETS_DIR: SECRETS },
    timeout: 10000,
    detached: true, // no controlling terminal
  })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /needs a terminal to show its one-time link/)
  assert.doesNotMatch(cli.stdout + cli.stderr, /\?t=/)
})

// A terminal for a command: script(1) of util-linux on Linux, of BSD on macOS.
const onTerminal = command =>
  process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qec', command.join(' '), '/dev/null']
const noScript = process.platform === 'darwin' ? false : process.platform !== 'linux' || spawnSync('script', ['--version']).status !== 0

test('the command on a terminal: one link per address, and it ends by itself', { skip: noScript }, async () => {
  const command = [process.execPath, join(ROOT, 'scripts', 'setup.mjs'), '--host', '127.0.0.1', '--port', '0', '--idle', '0.02']
  const child = spawn('script', onTerminal(command), { env: { ...process.env, VOICE_GW_SECRETS_DIR: SECRETS } })
  let out = ''
  child.stdout.on('data', chunk => (out += chunk))
  child.stderr.on('data', chunk => (out += chunk))
  const code = await new Promise(resolve => child.on('close', resolve))
  assert.equal(code, 0)
  const links = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}/g) ?? []
  assert.equal(links.length, 1, 'one address when bound to one')
  assert.match(out, /use it only in your own network/)
  assert.match(out, /setup assistant ended: no activity/)
})

// --- the steps, with the stand-ins ----------------------------------------------------

const flow = {}

async function follow(page, id) {
  for (let i = 0; i < 200; i++) {
    const { data } = await page.call(`/api/jobs/${id}`)
    if (data.state !== 'running') return data
    await sleep(50)
  }
  throw new Error('job did not end')
}

test('the start: checks, current settings, repositories and the plugin, without secrets', async () => {
  const setup = createSetup({ root: ROOT, secretsDir: SECRETS, env: setupEnv(), home: HOME, platform: 'linux', say })
  flow.server = await startSetupServer({ host: '127.0.0.1', port: 0, api: setup.api, redact: setup.redact, say })
  flow.page = await browser(flow.server)
  const { status, data } = await flow.page.call('/api/state')
  assert.equal(status, 200)
  const check = name => data.checks.find(c => c.name === name)
  assert.equal(check('Claude Code').detail, '2.1.310')
  assert.ok(check('Claude Code').ok)
  assert.equal(check('GitHub CLI').detail, 'logged in')
  assert.equal(check('Docker').detail, 'server 29.0.0')
  assert.equal(check('Tailscale').ok, false)
  assert.equal(data.settings.VOICE_GW_PORT, '8787')
  assert.equal(data.settings.VOICE_GW_KILLSWITCH, 'auto', 'the kill switch locks by itself, by default')
  assert.equal(data.settings.VOICE_GW_PR_DRAFT, '0', 'pull requests ready for review, by default')
  assert.equal(data.settings.VOICE_GW_SCRATCH, '0', 'work folders off, by default')
  assert.equal(data.settings.VOICE_GW_SCRATCH_DOCKER, '', 'and on this computer when turned on')
  assert.equal(data.settings.VOICE_GW_SCRATCH_DAYS, '60')
  assert.equal(data.settings.VOICE_GW_REMOTE_CONTROL, '0', 'Remote Control off, by default')
  assert.deepEqual(data.secrets, { telegramToken: null, telegramChatId: null, githubToken: null, claudeToken: null })
  assert.deepEqual(data.git, { name: 'Test Driver', email: 'driver@example.com' })
  assert.equal(data.plugin.mode, 'development')
  assert.deepEqual(data.plugin.allowlist, { marketplace: 'cc-voice-gateway', plugin: 'voice' })
  assert.match(data.watchdog.unit, /systemd\/user\/cc-voice-gateway\.service$/)
  assert.equal(data.watchdog.linger, false)
  assert.ok(data.models.includes('opus'))
  assert.ok(data.efforts.includes('xhigh'))
})

test('Telegram: the token checked with getMe, the chat found with getUpdates, a test message sent', async () => {
  const { call } = flow.page
  assert.match((await call('/api/telegram/token', { token: 'nonsense' })).data.error, /does not look like a bot token/)
  assert.match((await call('/api/telegram/token', { token: '123456789:WRONG-token-wrong-token-wrong-token-x' })).data.error, /does not know this token/)
  const checked = await call('/api/telegram/token', { token: TELEGRAM_TOKEN })
  assert.deepEqual(checked.data, { bot: '@voice_test_bot' })

  assert.deepEqual((await call('/api/telegram/chats', {})).data, { chats: [] }, 'nobody wrote yet')
  api.updates = [
    { update_id: 1, message: { chat: { id: -100, type: 'group', title: 'Family' }, text: 'hi' } },
    { update_id: 2, message: { chat: { id: Number(CHAT_ID), type: 'private', first_name: 'Gaudenz', username: 'driver' }, text: 'Hallo' } },
    { update_id: 3, message: { chat: { id: Number(CHAT_ID), type: 'private', first_name: 'Gaudenz', username: 'driver' }, text: 'again' } },
  ]
  assert.deepEqual((await call('/api/telegram/chats', {})).data, { chats: [{ id: CHAT_ID, name: 'Gaudenz (@driver)' }] })

  assert.deepEqual((await call('/api/telegram/test', { chatId: CHAT_ID })).data, { sent: true })
  assert.equal(api.sent.at(-1).chat_id, CHAT_ID)
  assert.match(api.sent.at(-1).text, /test message from the setup assistant/)
  const state = (await call('/api/state')).data
  assert.equal(state.secrets.telegramToken, 'new')
  assert.equal(state.secrets.telegramChatId, 'new')
})

test('GitHub: the token checked, and the access level per repository from the gateway\'s detection', async () => {
  const { call } = flow.page
  assert.match((await call('/api/github/token', { token: 'github_pat_WRONG_wrong_wrong_wrong_0000' })).data.error, /rejected the token/)
  const user = (await call('/api/github/token', { token: GITHUB_TOKEN })).data
  assert.deepEqual(user, { login: 'driver', kind: 'fine-grained', scopes: null, expires: '2027-01-31 00:00:00 UTC' })

  const levels = (await call('/api/github/levels', { repos: ['acme/guarded', 'acme/open', 'acme/readonly', 'acme/missing'] })).data.levels
  assert.deepEqual(
    levels.map(({ slug, level }) => `${slug} ${level}`),
    ['acme/guarded pr', 'acme/open full', 'acme/readonly read-only', 'acme/missing read-only'],
  )
  assert.match(levels[0].reason, /main is protected by a ruleset/)
  assert.match(levels[3].reason, /cannot see the repository \(404\)/)
  const forced = (await call('/api/github/levels', { repos: ['acme/open'], forced: 'pr' })).data.levels
  assert.equal(forced[0].level, 'pr')
  assert.equal((await call('/api/github/levels', { repos: ['not a slug'] })).status, 400)
})

test('Docker: the image is built with progress on the page, and nothing secret in it', async () => {
  const { call } = flow.page
  assert.match((await call('/api/claude/token', { token: 'nope' })).data.error, /starts with sk-ant-/)
  assert.deepEqual((await call('/api/claude/token', { token: CLAUDE_TOKEN })).data, { claudeToken: 'new' })

  writeFileSync(ECHO, `GH_TOKEN=${GITHUB_TOKEN} CLAUDE=${CLAUDE_TOKEN}`) // as if a build printed them
  const { job } = (await call('/api/docker/build', { image: 'cc-voice-worker' })).data
  const done = await follow(flow.page, job)
  rmSync(ECHO)
  assert.equal(done.state, 'done')
  assert.match(done.lines.join('\n'), /naming to docker\.io\/library\/cc-voice-worker/)
  assert.match(done.lines.join('\n'), /GH_TOKEN=‹secret› CLAUDE=‹secret›/)
  const build = calls().find(c => c.command === 'docker' && c.argv[0] === 'build')
  assert.deepEqual(build.argv.slice(0, 2), ['build', '-t'])
  assert.ok(build.argv.includes(`UID=${process.getuid()}`))
  assert.equal(build.argv.at(-1), join(ROOT, 'docker'))
})

test('finishing: invalid input is refused before anything is written', async () => {
  const { call } = flow.page
  const refused = await call('/api/finish', {
    settings: {
      VOICE_GW_PORT: '80',
      VOICE_GW_WORKER_MODEL: 'x; rm -rf /',
      VOICE_GW_KILLSWITCH: 'sometimes',
      VOICE_GW_PR_DRAFT: 'yes',
      VOICE_GW_SCRATCH: 'yes',
      VOICE_GW_SCRATCH_DAYS: '366',
      VOICE_GW_SCRATCH_DOCKER: 'a b',
      VOICE_GW_REMOTE_CONTROL: 'yes',
      NOPE: '1',
    },
  })
  assert.equal(refused.status, 400)
  assert.match(refused.data.error, /VOICE_GW_REMOTE_CONTROL: not a valid value/)
  assert.match(refused.data.error, /VOICE_GW_PORT: not a valid value/)
  assert.match(refused.data.error, /VOICE_GW_WORKER_MODEL: not a valid value/)
  assert.match(refused.data.error, /VOICE_GW_KILLSWITCH: not a valid value/)
  assert.match(refused.data.error, /VOICE_GW_PR_DRAFT: not a valid value/)
  for (const name of ['VOICE_GW_SCRATCH', 'VOICE_GW_SCRATCH_DAYS', 'VOICE_GW_SCRATCH_DOCKER']) {
    assert.match(refused.data.error, new RegExp(`${name}: not a valid value`))
  }
  assert.match(refused.data.error, /unknown setting NOPE/)
  assert.ok(!existsSync(SECRETS), 'nothing written')
})

test('finishing: the files in .secrets with mode 0600 in folders of 0700, the container, the watchdog, then the server ends', async () => {
  const { call } = flow.page
  // A gateway runs on these secrets: its admin socket answers.
  mkdirSync(SECRETS, { recursive: true })
  const gateway = createSocketServer(socket => socket.end())
  await new Promise(resolve => gateway.listen(join(SECRETS, 'admin.sock'), resolve))
  const { status, data } = await call('/api/finish', {
    settings: {
      VOICE_GW_PORT: '8791',
      VOICE_GW_WORKER_ROOT: DEV,
      VOICE_GW_MAX_WORKERS: '2', // the default: left out
      VOICE_GW_MAX_WORKERS_PER_REPO: '3',
      VOICE_GW_DOCKER: 'voice-workers',
      VOICE_GW_DOCKER_FOLDER: FOLDER,
      VOICE_GW_DOCKER_IMAGE: 'cc-voice-worker',
      VOICE_GW_ACCESS: '',
      VOICE_GW_CONTROLLER_MODEL: 'sonnet',
      VOICE_GW_CONTROLLER_EFFORT: 'low',
      VOICE_GW_WORKER_MODEL: 'opus',
      VOICE_GW_WORKER_EFFORT: 'high',
      VOICE_GW_KILLSWITCH: 'manual',
      VOICE_GW_PR_DRAFT: '1',
      VOICE_GW_REMOTE_CONTROL: '1',
    },
    telegram: { enabled: true },
    docker: { enabled: true, repos: ['acme/guarded', 'acme/open'], gitName: 'Test Driver', gitEmail: 'driver@example.com' },
    watchdog: { autostart: true, startNow: true },
    plugin: { register: true },
  })
  assert.equal(status, 200)
  const done = await follow(flow.page, data.job)
  gateway.close()
  assert.equal(done.state, 'done', done.lines.join('\n'))
  // The running gateway takes the worker limits at once, the rest at its next start.
  assert.ok(done.lines.some(line => /the running gateway applies VOICE_GW_MAX_WORKERS_PER_REPO at once, without a restart/.test(line)), done.lines.join('\n'))
  assert.ok(done.lines.some(line => /the running gateway takes the other changed settings \(.*VOICE_GW_PORT.*\) at its next start: restart the controller/.test(line)))

  const mode = path => statSync(path).mode & 0o777
  assert.equal(mode(SECRETS), 0o700)
  assert.equal(mode(join(SECRETS, 'worker')), 0o700)
  const files = {
    telegram_token: TELEGRAM_TOKEN,
    telegram_chat_id: CHAT_ID,
    'worker/claude_token': CLAUDE_TOKEN,
    'worker/github_token': GITHUB_TOKEN,
  }
  for (const [name, value] of Object.entries(files)) {
    assert.equal(readFileSync(join(SECRETS, name), 'utf8'), value, name)
    assert.equal(mode(join(SECRETS, name)), 0o600, `${name} is 0600`)
  }
  assert.equal(mode(join(SECRETS, 'gateway.env')), 0o600)
  assert.deepEqual(readSettings(join(SECRETS, 'gateway.env')), {
    VOICE_GW_PORT: '8791',
    VOICE_GW_WORKER_ROOT: DEV,
    VOICE_GW_MAX_WORKERS_PER_REPO: '3',
    VOICE_GW_DOCKER: 'voice-workers',
    VOICE_GW_DOCKER_FOLDER: FOLDER,
    VOICE_GW_CONTROLLER_MODEL: 'sonnet',
    VOICE_GW_CONTROLLER_EFFORT: 'low',
    VOICE_GW_WORKER_MODEL: 'opus',
    VOICE_GW_WORKER_EFFORT: 'high',
    VOICE_GW_KILLSWITCH: 'manual',
    VOICE_GW_PR_DRAFT: '1',
    VOICE_GW_REMOTE_CONTROL: '1',
  })
  for (const value of SECRET_VALUES) assert.ok(!readFileSync(join(SECRETS, 'gateway.env'), 'utf8').includes(value))

  // The container: started by the start script, then git's identity and the clones, inside it.
  const docker = calls().filter(c => c.command === 'docker').map(c => c.argv)
  const run = docker.find(argv => argv[0] === 'run')
  assert.ok(run.includes(`${FOLDER}:/repos:rw`))
  assert.ok(run.includes(`${join(SECRETS, 'worker')}:/run/secrets/voice:ro`))
  assert.ok(docker.some(argv => argv.join(' ') === 'exec voice-workers git config --global user.name Test Driver'))
  assert.ok(docker.some(argv => argv.join(' ') === `exec voice-workers git clone https://github.com/acme/guarded.git ${FOLDER}/guarded`))
  assert.ok(existsSync(join(FOLDER, 'open')))

  // The watchdog: a systemd user service, enabled, lingering turned on, and started now in tmux.
  const unit = readFileSync(join(HOME, '.config', 'systemd', 'user', 'cc-voice-gateway.service'), 'utf8')
  assert.match(unit, /^ExecStart=".*\/tmux" new-session -d -s voice ".*\/scripts\/start-controller\.sh"$/m)
  assert.match(unit, /^ExecStop=".*\/scripts\/start-controller\.sh" --stop$/m)
  // Without quotes: with them, systemd refused the unit at the next login.
  assert.match(unit, /^WorkingDirectory=\/[^"]*$/m)
  const analyze = spawnSync('systemd-analyze', ['--user', 'verify', join(HOME, '.config', 'systemd', 'user', 'cc-voice-gateway.service')], {
    encoding: 'utf8',
  })
  if (!analyze.error) assert.equal(analyze.status, 0, analyze.stderr)
  const systemctl = calls().filter(c => c.command === 'systemctl').map(c => c.argv.join(' '))
  assert.deepEqual(systemctl, ['--user daemon-reload', '--user enable cc-voice-gateway.service'])
  assert.ok(calls().some(c => c.command === 'loginctl' && c.argv.join(' ') === `enable-linger ${process.getuid()}`))
  assert.match(done.lines.join('\n'), /lingering turned on: the controller starts at boot and keeps running without a login/)
  assert.ok(calls().some(c => c.command === 'tmux' && c.argv.slice(0, 4).join(' ') === 'new-session -d -s voice'))
  assert.ok(!calls().some(c => c.command === 'claude' && c.argv[0] === 'plugin'), 'not on the allowlist: nothing to register')

  // The page has seen the result: the server ends by itself.
  assert.equal(await flow.server.done, 'the setup is written')
  assert.equal(await fetch(`${flow.page.base}/api/state`).catch(() => 'closed'), 'closed')
})

test('no secret reaches a log line, the terminal, a response or a command line', () => {
  const places = {
    terminal: terminal.join('\n'),
    responses: flow.page.responses.join('\n'),
    commands: existsSync(CALLS) ? readFileSync(CALLS, 'utf8') : '',
    'gateway log': existsSync(join(TMP, 'gateway.log')) ? readFileSync(join(TMP, 'gateway.log'), 'utf8') : '',
    'API requests': api.requests.join('\n'),
  }
  for (const [place, text] of Object.entries(places)) {
    for (const value of [...SECRET_VALUES, flow.server.token]) {
      assert.ok(!text.includes(value), `a secret in ${place}`)
    }
  }
  assert.ok(places.responses.includes('‹secret›'), 'redacted where a command printed one')
  assert.ok(terminal.some(line => /setup: written .*telegram_token.*gateway\.env/.test(line)), 'file names only')
})

test('finishing with Telegram turned off removes its saved files, and keeps everything else', async () => {
  const secrets = join(TMP, 'secrets-off')
  mkdirSync(join(secrets, 'worker'), { recursive: true })
  writeFileSync(join(secrets, 'telegram_token'), TELEGRAM_TOKEN)
  writeFileSync(join(secrets, 'telegram_chat_id'), CHAT_ID)
  writeFileSync(join(secrets, 'worker', 'github_token'), GITHUB_TOKEN, { mode: 0o644 })
  writeFileSync(join(secrets, 'gateway.env'), 'VOICE_GW_KILL_MAX_EDITS=900\nVOICE_GW_DOCKER=old-workers\n')
  const setup = createSetup({ root: ROOT, secretsDir: secrets, env: setupEnv(), home: HOME, platform: 'linux', say })
  const { job } = await setup.api['POST /api/finish']({
    body: { settings: { VOICE_GW_PORT: '8787', VOICE_GW_DOCKER: '' }, telegram: { enabled: false }, docker: { enabled: false } },
  })
  let state
  for (let i = 0; i < 100 && (state = setup.api['GET /api/jobs/:id']({ id: job })).state === 'running'; i++) await sleep(20)
  assert.equal(state.state, 'done', state.lines.join('\n'))
  assert.match(state.lines.join('\n'), /Telegram turned off: removed telegram_token, telegram_chat_id/)
  assert.ok(!existsSync(join(secrets, 'telegram_token')))
  assert.ok(!existsSync(join(secrets, 'telegram_chat_id')))
  assert.equal(statSync(join(secrets, 'worker', 'github_token')).mode & 0o777, 0o600, 'a saved secret gets mode 0600')
  assert.deepEqual(readSettings(join(secrets, 'gateway.env')), { VOICE_GW_KILL_MAX_EDITS: '900' }, 'other settings stay; Docker is off')
})

test("finishing with work folders: their folder checked; in a container of their own with only Claude Code's token", async () => {
  const secrets = join(TMP, 'secrets-scratch')
  const folder = join(TMP, 'voice-scratch')
  // A setup writes once; each finish here is a run of the assistant of its own.
  let setup
  const fresh = () => (setup = createSetup({ root: ROOT, secretsDir: secrets, env: setupEnv(), home: HOME, platform: 'linux', say }))
  const finish = async settings => {
    const { job } = await fresh().api['POST /api/finish']({ body: { settings, telegram: { enabled: false }, docker: { enabled: false } } })
    let state
    for (let i = 0; i < 250 && (state = setup.api['GET /api/jobs/:id']({ id: job })).state === 'running'; i++) await sleep(20)
    return state
  }
  const runs = () => calls().filter(c => c.command === 'docker' && c.argv[0] === 'run')

  // Refused before anything is written: a folder inside the gateway's checkout or a repository, a
  // container without Claude Code's token.
  await assert.rejects(finish({ VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: join(ROOT, 'scratch') }), /Work folders: .*\/scratch is inside the gateway's own checkout/)
  await assert.rejects(finish({ VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: join(DEV, 'alpha', 'notes') }), /is inside the git repository .*\/alpha/)
  await assert.rejects(
    finish({ VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: folder, VOICE_GW_SCRATCH_DOCKER: 'voice-scratch' }),
    /Work folders: their container needs a token from claude setup-token/,
  )
  assert.ok(!existsSync(secrets), 'nothing written')

  // On this computer: only the settings.
  const before = runs().length
  const host = await finish({ VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: folder, VOICE_GW_SCRATCH_DOCKER: '' })
  assert.equal(host.state, 'done', host.lines.join('\n'))
  assert.deepEqual(readSettings(join(secrets, 'gateway.env')), { VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: folder })
  assert.equal(runs().length, before, 'no container')
  assert.ok(!existsSync(join(secrets, 'worker')))

  // In a container of their own, with the token from the page.
  await fresh().api['POST /api/claude/token']({ body: { token: CLAUDE_TOKEN } })
  const { job } = await setup.api['POST /api/finish']({
    body: {
      settings: { VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: folder, VOICE_GW_SCRATCH_DAYS: '0', VOICE_GW_SCRATCH_DOCKER: 'voice-scratch', VOICE_GW_DOCKER: '' },
      telegram: { enabled: false },
      docker: { enabled: false },
    },
  })
  let boxed
  for (let i = 0; i < 250 && (boxed = setup.api['GET /api/jobs/:id']({ id: job })).state === 'running'; i++) await sleep(20)
  assert.equal(boxed.state, 'done', boxed.lines.join('\n'))
  assert.match(boxed.lines.join('\n'), new RegExp(`starting the container voice-scratch with ${folder} as /scratch, for the work folders`))
  assert.deepEqual(readSettings(join(secrets, 'gateway.env')), {
    VOICE_GW_SCRATCH: '1',
    VOICE_GW_SCRATCH_ROOT: folder,
    VOICE_GW_SCRATCH_DAYS: '0',
    VOICE_GW_SCRATCH_DOCKER: 'voice-scratch',
  })
  assert.equal(readFileSync(join(secrets, 'worker', 'claude_token'), 'utf8'), CLAUDE_TOKEN)
  assert.equal(statSync(join(secrets, 'worker', 'claude_token')).mode & 0o777, 0o600)
  assert.ok(!existsSync(join(secrets, 'worker', 'github_token')), 'no GitHub token for it')
  const run = runs().at(-1).argv
  assert.equal(run[run.indexOf('--name') + 1], 'voice-scratch')
  assert.ok(run.includes(`${folder}:/scratch:rw`))
  assert.ok(run.includes(`${join(secrets, 'worker', 'claude_token')}:/run/secrets/voice/claude_token:ro`))
  assert.ok(!run.some(arg => arg.includes('/repos')))

  // Not the workers' container.
  await fresh().api['POST /api/claude/token']({ body: { token: CLAUDE_TOKEN } })
  await assert.rejects(
    setup.api['POST /api/finish']({
      body: {
        settings: { VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: folder, VOICE_GW_SCRATCH_DOCKER: 'voice-workers', VOICE_GW_DOCKER: 'voice-workers' },
        docker: { enabled: true, repos: [] },
      },
    }),
    /their container needs a name of its own/,
  )
})

test('the autostart: lingering already on is left alone, and a refused one leaves the step done, with the sudo command', async () => {
  const uid = process.getuid()
  async function autostart(linger) {
    writeFileSync(LINGER, linger)
    const start = calls().length
    const setup = createSetup({ root: ROOT, secretsDir: join(TMP, `secrets-linger-${linger}`), env: setupEnv(), home: HOME, platform: 'linux', say })
    const { job } = await setup.api['POST /api/finish']({
      body: { settings: { VOICE_GW_PORT: '8787', VOICE_GW_DOCKER: '' }, telegram: { enabled: false }, docker: { enabled: false }, watchdog: { autostart: true } },
    })
    let state
    for (let i = 0; i < 250 && (state = setup.api['GET /api/jobs/:id']({ id: job })).state === 'running'; i++) await sleep(20)
    const loginctl = calls().slice(start).filter(c => c.command === 'loginctl').map(c => c.argv.join(' '))
    return { state: state.state, text: state.lines.join('\n'), loginctl }
  }

  const on = await autostart('yes')
  assert.equal(on.state, 'done', on.text)
  assert.deepEqual(on.loginctl, [`show-user ${uid} -p Linger`])
  assert.match(on.text, /lingering already on: the controller starts at boot and keeps running without a login/)

  const denied = await autostart('denied')
  assert.equal(denied.state, 'done', denied.text)
  assert.deepEqual(denied.loginctl, [`show-user ${uid} -p Linger`, `enable-linger ${uid}`])
  assert.match(denied.text, /Could not enable linger: Access denied/)
  assert.match(denied.text, new RegExp(`it needs sudo loginctl enable-linger ${uid}, and until then the controller starts only at a login`))
  assert.match(denied.text, /\ndone$/)
  rmSync(LINGER, { force: true })
})

// --- macOS --------------------------------------------------------------------------

// A plist as launchd reads it: the XML parsed strictly (each tag closed in
// order, no bare <, > or & in a text), into dicts, arrays, strings, booleans.
function parsePlist(xml) {
  const header =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  assert.ok(xml.startsWith(header), 'the XML declaration and the plist DTD')
  const tokens = xml.slice(header.length).match(/<[^<>]*>|[^<]+/g).filter(token => token.trim())
  let at = 0
  const take = expected => assert.equal(tokens[at++], expected)
  const text = () => {
    if (tokens[at].startsWith('<')) return ''
    const raw = tokens[at++]
    assert.doesNotMatch(raw, />|&(?!(?:amp|lt|gt);)/, 'escaped')
    return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  }
  const value = () => {
    const tag = tokens[at++]
    if (tag === '<true/>') return true
    if (tag === '<false/>') return false
    if (tag === '<string>') {
      const s = text()
      take('</string>')
      return s
    }
    if (tag === '<array>') {
      const list = []
      while (tokens[at] !== '</array>') list.push(value())
      at++
      return list
    }
    if (tag === '<dict>') {
      const dict = {}
      while (tokens[at] !== '</dict>') {
        take('<key>')
        const key = text()
        take('</key>')
        dict[key] = value()
      }
      at++
      return dict
    }
    throw new Error(`unexpected ${tag}`)
  }
  take('<plist version="1.0">')
  const result = value()
  take('</plist>')
  assert.equal(at, tokens.length, 'nothing after </plist>')
  return result
}

// The setup on macOS, whatever this runs on: its PATH as in a Terminal without
// Homebrew's shellenv, tmux found on it by name, and the fake launchctl.
async function macSetup(name, watchdog, { loaded = false, session = false } = {}) {
  const home = join(TMP, `mac-${name}`)
  mkdirSync(home, { recursive: true })
  for (const [file, on] of [[LOADED, loaded], [SESSION, session]]) {
    if (on) writeFileSync(file, '')
    else rmSync(file, { force: true })
  }
  const env = { ...setupEnv(), PATH: `${BIN}:/usr/bin:/bin:/odd&<dir>` }
  delete env.VOICE_SETUP_TMUX_BIN
  const setup = createSetup({ root: ROOT, secretsDir: join(TMP, `secrets-mac-${name}`), env, home, platform: 'darwin', say })
  const state = await setup.api['GET /api/state']({})
  const start = calls().length
  const { job } = await setup.api['POST /api/finish']({
    body: { settings: { VOICE_GW_PORT: '8787', VOICE_GW_DOCKER: '' }, telegram: { enabled: false }, docker: { enabled: false }, watchdog },
  })
  let done
  for (let i = 0; i < 250 && (done = setup.api['GET /api/jobs/:id']({ id: job })).state === 'running'; i++) await sleep(20)
  const file = join(home, 'Library', 'LaunchAgents', 'com.drawio.cc-voice-gateway.plist')
  const mine = calls().slice(start).map(c => `${c.command} ${c.argv.join(' ')}`)
  return { home, state, file, done, text: done.lines.join('\n'), calls: mine }
}

test('macOS: the autostart is a LaunchAgent that launchd loads and starts in tmux; nothing of systemd', async () => {
  const uid = process.getuid()
  const mac = await macSetup('start', { autostart: true, startNow: true })
  assert.equal(mac.state.watchdog.platform, 'darwin')
  assert.equal(mac.state.watchdog.unit, mac.file)
  assert.equal(mac.state.watchdog.linger, null, 'no lingering on macOS')
  assert.equal(mac.state.watchdog.loaded, false)
  assert.equal(mac.done.state, 'done', mac.text)

  const agent = parsePlist(readFileSync(mac.file, 'utf8'))
  assert.equal(statSync(mac.file).mode & 0o777, 0o644)
  assert.equal(agent.Label, 'com.drawio.cc-voice-gateway')
  // tmux by its full path: launchd does not search the PATH it sets.
  assert.deepEqual(agent.ProgramArguments, [join(BIN, 'tmux'), 'new-session', '-d', '-s', 'voice', join(ROOT, 'scripts', 'start-controller.sh')])
  assert.equal(agent.WorkingDirectory, ROOT)
  const path = agent.EnvironmentVariables.PATH.split(':')
  assert.deepEqual(path.slice(0, 4), [BIN, '/usr/bin', '/bin', '/odd&<dir>'], 'yours first, escaped in the XML')
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', join(mac.home, '.local', 'bin'), dirname(process.execPath)]) {
    assert.ok(path.includes(dir), `${dir} on the LaunchAgent's PATH`)
  }
  // Like Type=forking: tmux returns at once, the watchdog inside restarts.
  assert.equal(agent.RunAtLoad, true)
  assert.equal(agent.KeepAlive, false)
  assert.equal(agent.AbandonProcessGroup, true)
  assert.equal(agent.StandardOutPath, join(mac.home, 'Library', 'Logs', 'cc-voice-gateway.log'))
  assert.equal(agent.StandardErrorPath, agent.StandardOutPath)

  const service = `gui/${uid}/com.drawio.cc-voice-gateway`
  assert.ok(mac.calls.includes(`plutil -lint ${mac.file}`), 'checked with plutil')
  assert.ok(mac.calls.includes(`launchctl print ${service}`))
  assert.ok(mac.calls.includes(`launchctl bootstrap gui/${uid} ${mac.file}`))
  assert.ok(!mac.calls.some(c => /^(systemctl|loginctl) /.test(c)), 'nothing of systemd')
  assert.ok(!mac.calls.some(c => c.startsWith('tmux new-session')), 'launchd started it, not the setup')
  assert.match(mac.text, /LaunchAgent com\.drawio\.cc-voice-gateway loaded: launchd starts the controller in tmux at every login, and started it now/)
  assert.match(mac.text, /the controller runs in the tmux session "voice": tmux attach -t voice/)
  assert.match(mac.text, /\ndone$/)
})

test('macOS: autostart alone loads at the next login; loaded already, a kickstart; a running session is left alone', async () => {
  const uid = process.getuid()
  const later = await macSetup('later', { autostart: true, startNow: false })
  assert.equal(later.done.state, 'done', later.text)
  assert.ok(existsSync(later.file))
  assert.ok(!later.calls.some(c => /^launchctl (bootstrap|kickstart)/.test(c) || c.startsWith('tmux new-session')), 'nothing started')
  assert.match(later.text, new RegExp(`starts the controller in tmux at your next login; to load it now, which also starts it: launchctl bootstrap gui/${uid} `))

  const again = await macSetup('again', { autostart: true, startNow: true }, { loaded: true })
  assert.equal(again.state.watchdog.loaded, true)
  assert.equal(again.done.state, 'done', again.text)
  assert.ok(again.calls.includes(`launchctl kickstart gui/${uid}/com.drawio.cc-voice-gateway`))
  assert.ok(!again.calls.some(c => c.startsWith('launchctl bootstrap')))
  assert.match(again.text, /was loaded already, with the file as it was then \(a changed one counts after: launchctl bootout gui\/\d+\/com\.drawio\.cc-voice-gateway; launchctl bootstrap /)

  const running = await macSetup('running', { autostart: true, startNow: true }, { session: true })
  assert.equal(running.done.state, 'done', running.text)
  assert.ok(!running.calls.some(c => /^launchctl (bootstrap|kickstart)/.test(c) || c.startsWith('tmux new-session')))
  assert.match(running.text, /the tmux session "voice" already runs; not started again\. The LaunchAgent starts it at your next login/)

  // Without the autostart: tmux directly, as on Linux.
  const now = await macSetup('now', { autostart: false, startNow: true })
  assert.equal(now.done.state, 'done', now.text)
  assert.ok(now.calls.some(c => c.startsWith('tmux new-session -d -s voice')))
  assert.ok(!now.calls.some(c => c.startsWith('launchctl ') && !c.startsWith('launchctl print')))
  rmSync(SESSION, { force: true })
  rmSync(LOADED, { force: true })
})

// --- Claude in Chrome's notice for the first start ---------------------------------

// The setup with Claude Code's config in a folder of the test.
const chromeSetup = (name, config) =>
  createSetup({ root: ROOT, secretsDir: join(TMP, `secrets-chrome-${name}`), env: { ...setupEnv(), CLAUDE_CONFIG_DIR: config }, home: HOME, platform: 'linux', say })

test('Claude in Chrome: the page learns whether its notice for the first start is confirmed, from Claude Code\'s config, read only', async () => {
  const config = join(TMP, 'chrome-config')
  mkdirSync(config, { recursive: true })
  const file = join(config, '.claude.json')
  const seen = async () => (await chromeSetup('state', config).api['GET /api/state']({})).chrome.noticeSeen
  assert.equal(await seen(), null, 'no config: it cannot tell')
  writeFileSync(file, '{"numStartups": 3,')
  assert.equal(await seen(), null, 'not valid JSON: it cannot tell')
  writeFileSync(file, JSON.stringify({ numStartups: 3 }, null, 2))
  assert.equal(await seen(), false)
  writeFileSync(file, JSON.stringify({ numStartups: 3, hasCompletedClaudeInChromeOnboarding: true }, null, 2))
  const text = readFileSync(file, 'utf8')
  assert.equal(await seen(), true)
  assert.equal(readFileSync(file, 'utf8'), text, 'never written')
})

// The page's script against a stand-in for the browser: every element a plain
// object, /api/state answered with these settings and what the server saw.
async function page(settings, chrome) {
  const elements = new Map()
  const element = () => ({
    value: '', hidden: false, textContent: '', className: '', checked: false, disabled: false, dataset: {}, attributes: {}, listeners: {},
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) },
    setAttribute(name, value) { this.attributes[name] = value },
    removeAttribute(name) { delete this.attributes[name] },
    replaceChildren() {},
    append() {},
    insertRow: () => ({ insertCell: () => element() }),
  })
  const $ = selector => elements.get(selector) ?? elements.set(selector, element()).get(selector)
  const select = $('#controller-chrome')
  select.dataset.setting = 'VOICE_GW_CONTROLLER_CHROME'
  const state = {
    host: 'test', root: ROOT, remaining: { overallMs: 600000, idleMs: 600000 }, checks: [], overridden: [], settings,
    models: [], efforts: [], secrets: {}, git: { name: '', email: '' }, repos: { host: [], docker: [] },
    watchdog: { platform: 'linux', unit: 'cc-voice-gateway.service' }, plugin: { mode: 'plugin', reason: '', allowlist: {} }, chrome,
  }
  const context = vm.createContext({
    document: { querySelector: $, querySelectorAll: selector => (selector === '[data-setting]' ? [select] : []) },
    fetch: async () => ({ ok: true, status: 200, json: async () => state }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    Option: function () {},
  })
  vm.runInContext(readFileSync(join(ROOT, 'src', 'setup', 'ui', 'app.js'), 'utf8'), context)
  await sleep(50) // its start reads /api/state
  return { notice: $('#chrome-notice'), guide: $('#chrome-guide'), security: $('#chrome-security'), select }
}

test('Claude in Chrome on the page: a warning with what to do at the terminal, unless its notice is confirmed already', async () => {
  const html = readFileSync(join(ROOT, 'src', 'setup', 'ui', 'index.html'), 'utf8')
  assert.match(html, /<select id="controller-chrome" data-setting="VOICE_GW_CONTROLLER_CHROME">/)
  assert.match(html, /<p id="chrome-notice" class="notice wide" hidden><\/p>/)
  // What it needs while the gateway runs, and its risk, in the page itself.
  const guide = /<p id="chrome-guide" class="guide wide" hidden>([^<]*)<\/p>/.exec(html)?.[1].replace(/\s+/g, ' ')
  assert.match(guide, /^Claude in Chrome works only while someone is signed in at this computer's desktop, or in a remote desktop session that stays when you disconnect, with Chrome open and the Claude extension signed in to the same claude\.ai account; otherwise the controller's browser tools answer that the extension is not connected\./)
  assert.match(guide, /Keep a Chrome window of your own open, not only the one Claude opens for its tab group: if Claude Code closes the last window or tab, Chrome quits, and the browser tools stop until someone starts it again at the desktop\./)
  const security = /<p id="chrome-security" class="notice wide" hidden>([^<]*)<\/p>/.exec(html)?.[1].replace(/\s+/g, ' ')
  assert.match(security, /^Security risk: the controller can use every login of that Chrome profile, and a password manager in it\. Use a profile only for Claude: README, "Claude in Chrome"\.$/)

  for (const noticeSeen of [false, null]) {
    const { notice, select } = await page({ VOICE_GW_CONTROLLER_CHROME: '1' }, { noticeSeen })
    assert.equal(notice.hidden, false, String(noticeSeen))
    assert.equal(notice.className, 'notice wide')
    assert.equal(notice.attributes.role, 'alert')
    assert.match(notice.textContent, /^Warning: at its first start with Claude in Chrome, Claude Code shows a notice about it and waits for Enter at the terminal, so a restart by the watchdog or the autostart can hang on it\./)
    assert.match(notice.textContent, /Before relying on unattended restarts, start Claude Code once at the terminal, as this user: claude --chrome, confirm the Claude in Chrome notice with Enter, and leave with \/exit\.$/)
    // Turned off on the page: gone.
    select.value = '0'
    for (const listener of select.listeners.change) listener()
    assert.equal(notice.hidden, true)
  }
  const shown = await page({ VOICE_GW_CONTROLLER_CHROME: '1' }, { noticeSeen: true })
  assert.deepEqual([shown.guide.hidden, shown.security.hidden], [false, false], 'with it on, what it needs and the risk')
  const hidden = await page({ VOICE_GW_CONTROLLER_CHROME: '0' }, { noticeSeen: true })
  assert.deepEqual([hidden.guide.hidden, hidden.security.hidden], [true, true])

  const confirmed = await page({ VOICE_GW_CONTROLLER_CHROME: '1' }, { noticeSeen: true })
  assert.equal(confirmed.notice.hidden, false)
  assert.equal(confirmed.notice.className, 'guide wide')
  assert.equal(confirmed.notice.attributes.role, undefined)
  assert.equal(confirmed.notice.textContent, "Claude in Chrome's notice for the first start is confirmed already for this user: restarts do not wait for it.")

  // Off: nothing, until it is turned on.
  const off = await page({ VOICE_GW_CONTROLLER_CHROME: '0' }, { noticeSeen: null })
  assert.equal(off.notice.hidden, true)
  off.select.value = '1'
  for (const listener of off.select.listeners.change) listener()
  assert.equal(off.notice.hidden, false)
  assert.match(off.notice.textContent, /^Warning: /)
})

test('finishing with Claude in Chrome on: a line with what to do at the terminal, or that its notice is confirmed already', async () => {
  const config = join(TMP, 'chrome-finish-config')
  mkdirSync(config, { recursive: true })
  const finish = async (name, chrome) => {
    const setup = chromeSetup(`finish-${name}`, config)
    const { job } = await setup.api['POST /api/finish']({
      body: { settings: { VOICE_GW_PORT: '8787', VOICE_GW_DOCKER: '', VOICE_GW_CONTROLLER_CHROME: chrome }, telegram: { enabled: false }, docker: { enabled: false }, watchdog: {} },
    })
    let done
    for (let i = 0; i < 250 && (done = setup.api['GET /api/jobs/:id']({ id: job })).state === 'running'; i++) await sleep(20)
    assert.equal(done.state, 'done', done.lines.join('\n'))
    return done.lines.join('\n')
  }
  assert.match(
    await finish('unknown', '1'),
    /Claude in Chrome: before relying on unattended restarts, start Claude Code once at the terminal as this user with claude --chrome, confirm the Claude in Chrome notice with Enter and leave with \/exit; otherwise a restart can hang on that notice/,
  )
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ hasCompletedClaudeInChromeOnboarding: true }))
  const seen = await finish('seen', '1')
  assert.match(seen, /Claude in Chrome: its notice for the first start is confirmed already for this user; restarts do not wait for it/)
  assert.match(seen, /Claude in Chrome: it works only while someone is signed in at the desktop, or in a remote desktop session that stays when disconnected, with Chrome open in a window of its own and the Claude extension signed in to the same claude\.ai account; the controller can use every login of that Chrome profile, so give Claude a profile of its own \(README, "Claude in Chrome"\)/)
  assert.doesNotMatch(await finish('off', '0'), /Claude in Chrome/)
})

test('the settings file: one line per setting, read without running anything', () => {
  assert.throws(() => formatSettings({ VOICE_GW_PORT: '1\nVOICE_GW_DOCKER=x' }), /one line only/)
  assert.throws(() => formatSettings({ PATH: '/bin' }), /not a setting/)
  const file = join(TMP, 'settings-test.env')
  writeFileSync(file, formatSettings({ VOICE_GW_PORT: '8788', VOICE_GW_DOCKER: '' }, ['a comment']) + 'PATH=/nope\nVOICE_GW_X=$(touch y)\n')
  assert.deepEqual(readSettings(file), { VOICE_GW_PORT: '8788', VOICE_GW_X: '$(touch y)' })
  assert.deepEqual(readSettings(join(TMP, 'missing.env')), {})
})
