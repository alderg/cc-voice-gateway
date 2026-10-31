// Connecting the Claude app from the setup page (section 10): pairing codes
// from the running gateway, valid ten minutes and one sign-in, the connector
// URL while the Funnel is on, and the assistant staying open after writing.
// Against a real gateway (src/gateway.mjs) on a free port with a secrets
// folder of its own, and fake tmux and tailscale commands: nothing here
// reaches the live gateway, its tmux session or the network.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-pairing-'))
// Whatever the modules here log goes to a file of this test, never the real log.
process.env.VOICE_GW_LOG_FILE = join(TMP, 'setup.log')
const { createSetup, PAIRING_MINUTES, STAY_MS } = await import('../src/setup/actions.mjs')
const { startSetupServer } = await import('../src/setup/server.mjs')
const { Auth } = await import('../src/oauth.mjs')
const { adminRequest } = await import('../src/admin.mjs')
const { HOSTS_MARK, hostsCommand, hostsLine, markedLines, signInCheck } = await import('../src/setup/hosts.mjs')

const SECRETS = join(TMP, 'secrets') // the gateway's, and the setup's
const BIN = join(TMP, 'bin')
const SESSION = join(TMP, 'tmux-session') // the fake tmux: the session "voice" runs
const PANE = join(TMP, 'tmux-pane') // the fake tmux: what its pane shows
const FUNNEL_ON = join(TMP, 'funnel-on') // the fake tailscale: the Funnel publishes the endpoint, on the port in it (443 if empty)
const LISTENERS = join(TMP, 'listeners') // the fake ss: what listens on this computer
const HOSTS = join(TMP, 'hosts') // in place of /etc/hosts
const OSASCRIPT_LOG = join(TMP, 'osascript.log') // what the fake osascript was asked to run
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const FORWARDED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'voice-test.example.ts.net' }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// The setup's check of a sign-in from this computer, in place of a request to the tailnet name: it gets the gateway.
const reached = async () => ({ ok: true })

const FAKE_TMUX = `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2).join(' ')
if (argv === 'has-session -t voice') process.exit(existsSync(${JSON.stringify(SESSION)}) ? 0 : 1)
if (argv === 'capture-pane -p -t voice') {
  if (!existsSync(${JSON.stringify(SESSION)})) process.exit(1)
  process.stdout.write(existsSync(${JSON.stringify(PANE)}) ? readFileSync(${JSON.stringify(PANE)}, 'utf8') : '')
}
`
// Claude Code's two questions at the start as the pane shows them, with a
// line that must never reach the page.
const SECRET_LINE = 'pane-text-never-on-the-page-7f3a'
const TRUST_PANE = [
  SECRET_LINE,
  ' Accessing workspace:',
  ' /Users/driver/cc-voice-gateway/controller',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
  ' source project, or work from your team).',
  ' ❯ 1. No, exit',
  '   2. Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n')
const CHANNEL_PANE = [
  SECRET_LINE,
  ' WARNING: Loading development channels',
  ' --dangerously-load-development-channels is for local channel development only.',
  ' Channels: server:voice',
  ' ❯ 1. I am using this for local development',
  '   2. Exit',
].join('\n')
// tailscale as funnel.sh asks it: its own name, the Funnel's state, and a
// start that is refused as on Linux without the operator setting, so that no
// check of the public relays runs.
const FAKE_TAILSCALE = `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2).join(' ')
const key = 'voice-test.example.ts.net:' + ((existsSync(${JSON.stringify(FUNNEL_ON)}) && readFileSync(${JSON.stringify(FUNNEL_ON)}, 'utf8').trim()) || '443')
if (argv === 'status --json') console.log(JSON.stringify({ Self: { DNSName: 'voice-test.example.ts.net.' } }))
else if (argv === 'funnel status --json') {
  const proxy = 'http://127.0.0.1:' + process.env.VOICE_GW_PORT
  console.log(JSON.stringify(existsSync(${JSON.stringify(FUNNEL_ON)}) ? { AllowFunnel: { [key]: true }, Web: { [key]: { Handlers: { '/': { Proxy: proxy } } } } } : {}))
} else if (argv.startsWith('funnel --bg')) {
  console.error('Access denied: serve config denied')
  process.exit(1)
} else process.exit(2)
`
// Administrator rights: pkexec runs what it is given, as this user; osascript
// runs the shell script of "do shell script … with administrator privileges".
const FAKE_PKEXEC = '#!/bin/sh\nexec "$@"\n'
const FAKE_OSASCRIPT = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const script = process.argv[3]
appendFileSync(${JSON.stringify(OSASCRIPT_LOG)}, process.argv[2] + ' ' + script + '\\n')
const shell = /^do shell script "((?:[^"\\\\]|\\\\.)*)" with administrator privileges$/s.exec(script)
if (!shell) process.exit(1)
process.exit(spawnSync('sh', ['-c', shell[1].replace(/\\\\(.)/g, '$1')], { stdio: 'ignore' }).status ?? 1)
`
const FAKE_SS = `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
if (existsSync(${JSON.stringify(LISTENERS)})) process.stdout.write(readFileSync(${JSON.stringify(LISTENERS)}, 'utf8'))
`

let port
let gateway
let gatewayLog = ''

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function startGateway() {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'gateway.mjs')], {
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: SECRETS,
      VOICE_GW_STATE_DIR: join(TMP, 'state'),
      VOICE_GW_WORKER_ROOT: join(TMP, 'no-repositories'),
      VOICE_GW_PORT: String(port),
      VOICE_GW_LOG_FILE: join(TMP, 'gateway.log'),
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  child.stderr.on('data', chunk => (gatewayLog += chunk))
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child
    } catch {
      await sleep(50)
    }
  }
  throw new Error('gateway did not start')
}

async function stopGateway(child) {
  const exited = new Promise(resolve => child.on('exit', resolve))
  child.stdin.end()
  await exited
}

const terminal = [] // what the setup and its server print
const say = line => terminal.push(line)

const setupEnv = () => ({
  ...process.env,
  VOICE_SETUP_TMUX_BIN: join(BIN, 'tmux'),
  VOICE_SETUP_TAILSCALE_BIN: join(BIN, 'tailscale'),
  VOICE_SETUP_SS_BIN: join(BIN, 'ss'),
  VOICE_SETUP_NETSTAT_BIN: join(BIN, 'ss'), // the same list, for a setup as on macOS
  VOICE_SETUP_HOSTS_FILE: HOSTS,
  VOICE_SETUP_PKEXEC_BIN: join(BIN, 'pkexec'),
  VOICE_SETUP_SUDO_BIN: join(BIN, 'no-sudo'),
  VOICE_SETUP_OSASCRIPT_BIN: join(BIN, 'osascript'),
  VOICE_GW_PORT: String(port), // funnel.sh compares the Funnel's target with it
  VOICE_GW_STATE_DIR: join(TMP, 'state'),
  CLAUDE_CONFIG_DIR: join(TMP, 'claude-config'),
  VOICE_GW_MANAGED_SETTINGS: join(TMP, 'no-managed-settings.json'),
})

// A browser: opens the link once, then sends the cookie and its origin.
// Every URL it asks for and every answer it gets are kept.
async function browser(server) {
  const base = `http://127.0.0.1:${server.port}`
  const urls = [`${base}/?t=${server.token}`]
  const first = await fetch(urls[0], { redirect: 'manual' })
  const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? ''
  const responses = []
  async function call(path, body, headers = {}) {
    const init =
      body === undefined
        ? { headers: { cookie, ...headers } }
        : { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
    urls.push(base + path)
    const response = await fetch(base + path, init)
    const text = await response.text()
    responses.push({ path, method: init.method ?? 'GET', text })
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { status: response.status, data }
  }
  return { base, cookie, call, urls, responses }
}

async function follow(page, id) {
  for (let i = 0; i < 200; i++) {
    const { data } = await page.call(`/api/jobs/${id}`)
    if (data.state !== 'running') return data
    await sleep(50)
  }
  throw new Error('job did not end')
}

// The sign-in as Claude's connector goes through it: registration, the
// sign-in page with the pairing code, and the token exchange.
async function signIn(pairingCode) {
  const gw = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init, headers: { ...FORWARDED, ...init.headers } })
  const registered = await gw('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', client_name: 'Claude' }),
  })
  const { client_id } = await registered.json()
  const verifier = randomBytes(32).toString('base64url')
  const form = {
    response_type: 'code',
    client_id,
    redirect_uri: CALLBACK,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'st4te',
    pairing_code: pairingCode,
    action: 'connect',
  }
  const authorized = await gw('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (authorized.status !== 302) return { ok: false, page: await authorized.text() }
  const code = new URL(authorized.headers.get('location')).searchParams.get('code')
  const token = await gw('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: CALLBACK }).toString(),
  })
  return { ok: token.status === 200 }
}

const flow = {} // the setup, its server and the browser, from test to test
const codes = [] // every code the page got, to look for them where they must not be

before(async () => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(HOSTS, '127.0.0.1 localhost\n::1 localhost\n')
  for (const [name, text] of [['tmux', FAKE_TMUX], ['tailscale', FAKE_TAILSCALE], ['ss', FAKE_SS], ['pkexec', FAKE_PKEXEC], ['osascript', FAKE_OSASCRIPT]]) {
    writeFileSync(join(BIN, name), text)
    chmodSync(join(BIN, name), 0o755)
  }
  port = await freePort()
  flow.setup = createSetup({ root: ROOT, secretsDir: SECRETS, env: setupEnv(), platform: 'linux', say, probe: reached })
  flow.server = await startSetupServer({ host: '127.0.0.1', port: 0, api: flow.setup.api, redact: flow.setup.redact, say })
  flow.page = await browser(flow.server)
})

after(async () => {
  if (gateway) await stopGateway(gateway)
  await flow.server?.stop('test over')
  rmSync(TMP, { recursive: true, force: true })
})

test('section 10 needs the setup\'s session: no answer without its cookie, and a code only for the page\'s own origin', async () => {
  const { base, cookie } = flow.page
  assert.equal((await fetch(`${base}/api/connect`)).status, 401)
  const post = headers => fetch(`${base}/api/pairing`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
  assert.equal((await post({ origin: base })).status, 401, 'no cookie')
  assert.equal((await post({ cookie, origin: 'http://evil.example' })).status, 403, 'another page')
  assert.equal((await post({ cookie })).status, 403, 'no origin')
  assert.equal((await post({ cookie, origin: base, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await fetch(`${base}/api/pairing`, { headers: { cookie } })).status, 404, 'no code by GET')
})

test('while the gateway is down: no code, and the page says what to do', async () => {
  const { call } = flow.page
  let { status, data } = await call('/api/connect')
  assert.equal(status, 200)
  assert.equal(data.gateway, false)
  assert.equal(data.tmux, false, 'nothing runs: start the controller')
  assert.equal(data.waiting, null)
  assert.equal(data.pairing, null)
  assert.ok(data.remaining.overallMs > 0 && data.remaining.idleMs > 0)
  writeFileSync(SESSION, '')
  ;({ data } = await call('/api/connect'))
  assert.equal(data.tmux, true, 'the controller may wait for a confirmation in tmux')
  assert.equal(data.waiting, null, 'an empty pane: which one is not known')
  const refused = await call('/api/pairing', {})
  assert.equal(refused.status, 409)
  assert.match(refused.data.error, /The gateway is not running yet\..*tmux attach -t voice/)
})

test('while the gateway is down: which question the tmux pane shows, as one word, never the pane\'s text', async () => {
  const { call, responses } = flow.page
  const waiting = async pane => {
    writeFileSync(PANE, pane)
    return (await call('/api/connect')).data.waiting
  }
  assert.equal(await waiting(TRUST_PANE), 'trust')
  assert.equal(await waiting(CHANNEL_PANE), 'channel')
  // An answered question can stay on the screen above the next: the last one counts.
  assert.equal(await waiting(`${TRUST_PANE}\n${CHANNEL_PANE}`), 'channel')
  assert.equal(await waiting(`${CHANNEL_PANE}\n${TRUST_PANE}`), 'trust')
  assert.equal(await waiting(`${SECRET_LINE}\n╭─ Claude Code ─╮\n> `), null, 'a session that runs, without either question')
  assert.ok(!responses.some(r => r.text.includes(SECRET_LINE) || r.text.includes('Quick safety check')), 'only the word')
  rmSync(PANE)
})

test('polling the gateway is no activity: a page left alone still ends by itself', async () => {
  const setup = createSetup({ root: ROOT, secretsDir: SECRETS, env: setupEnv(), platform: 'linux', say, probe: reached })
  const server = await startSetupServer({ host: '127.0.0.1', port: 0, api: setup.api, say, idleMs: 600 })
  const page = await browser(server)
  const started = Date.now()
  let ended = null
  server.done.then(reason => (ended = reason))
  while (!ended && Date.now() - started < 5000) {
    await page.call('/api/connect').catch(() => {})
    await sleep(100)
  }
  assert.match(ended, /no activity/)
  assert.ok(Date.now() - started < 3000)
})

test('a code from the running gateway: valid ten minutes, and only in the answer that made it', async () => {
  gateway = await startGateway()
  const { call } = flow.page
  let { data } = await call('/api/connect')
  assert.equal(data.gateway, true)
  assert.deepEqual(data.funnel, { state: 'off', url: null, port: '443', signIn: null, web443: null })
  assert.equal(data.pairing, null)

  const made = await call('/api/pairing', {})
  assert.equal(made.status, 200)
  assert.match(made.data.code, /^\d{4} \d{4}$/)
  assert.equal(made.data.expiresIn, PAIRING_MINUTES * 60)
  assert.equal(PAIRING_MINUTES, 10)
  codes.push(made.data.code)
  const pending = await adminRequest(join(SECRETS, 'admin.sock'), 'GET', '/pairing')
  assert.ok(Math.abs(pending.expiresAt - Date.now() - 10 * 60 * 1000) < 5000, 'the gateway holds it for ten minutes')

  ;({ data } = await call('/api/connect'))
  assert.equal(data.pairing.state, 'valid')
  assert.ok(data.pairing.expiresInMs > 595000 && data.pairing.expiresInMs <= 600000)
  assert.equal(data.code, undefined)
  assert.ok(terminal.includes('setup: a pairing code for the page, valid 10 minutes'))
})

test('a new code replaces the one before: the old one signs in no more, the new one once', async () => {
  const { call } = flow.page
  const first = codes.at(-1)
  const second = (await call('/api/pairing', {})).data.code
  codes.push(second)
  assert.notEqual(second, first)
  const old = await signIn(first)
  assert.equal(old.ok, false)
  assert.match(old.page, /Wrong or expired code\. Get a new one: &quot;New code&quot; on the setup page, or node scripts\/pair\.mjs\./)
  assert.equal((await call('/api/connect')).data.pairing.state, 'valid', 'the wrong attempt does not touch the new code')

  // pair.mjs makes one too, which replaces the page's.
  await adminRequest(join(SECRETS, 'admin.sock'), 'POST', '/pairing')
  assert.equal((await call('/api/connect')).data.pairing.state, 'gone')
  assert.equal((await signIn(second)).ok, false)

  const third = (await call('/api/pairing', {})).data.code
  codes.push(third)
  assert.equal((await signIn(third)).ok, true)
  const { data } = await call('/api/connect')
  assert.equal(data.pairing.state, 'used')
  assert.equal(data.pairing.client, 'Claude')
  assert.equal((await signIn(third)).ok, false, 'one sign-in per code')
})

test('pair.mjs keeps five minutes, and takes up to ten with --minutes', () => {
  const env = { ...process.env, VOICE_GW_SECRETS_DIR: SECRETS }
  const pair = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'pair.mjs'), ...args], { env, encoding: 'utf8' })
  assert.match(pair().stdout, /^Pairing code: \d{4} \d{4}\nEnter it on the sign-in page within 5 minutes\./)
  assert.match(pair('--minutes', '10').stdout, /within 10 minutes\./)
  for (const minutes of ['0', '11', 'ten']) {
    const refused = pair('--minutes', minutes)
    assert.equal(refused.status, 2, minutes)
    assert.match(refused.stdout, /^usage: /)
  }
})

test('the Funnel: off with a start from the page, which shows its output; on with the connector URL', async () => {
  const { call } = flow.page
  const started = await call('/api/funnel/start', {})
  assert.equal(started.status, 200)
  const job = await follow(flow.page, started.data.job)
  assert.equal(job.state, 'failed')
  assert.equal(job.title, 'starting the Funnel on port 443')
  assert.match(job.lines.join('\n'), /Run 'sudo tailscale set --operator=\$USER' once/)

  writeFileSync(FUNNEL_ON, '')
  const { data } = await call('/api/connect') // the start emptied the cache
  assert.deepEqual(data.funnel, { state: 'on', url: 'https://voice-test.example.ts.net/mcp', port: '443', signIn: { ok: true }, web443: null })
})

// The sign-in on this computer: the setup's check under the tailnet name, and
// the marked line in /etc/hosts (here a file of the test) with administrator
// rights (here a fake pkexec, or osascript for macOS).
const SIGNIN = join(TMP, 'secrets-signin')
const BEFORE = '127.0.0.1 localhost\n::1 localhost\n# mine\n10.0.0.5 nas.local\n'

async function signInSetup({ platform = 'linux', env = {} } = {}) {
  mkdirSync(SIGNIN, { recursive: true })
  const looked = []
  // The Funnel's public addresses, in place of public resolvers; the check gets the gateway once the line is there.
  const lookup = async host => (looked.push(host), ['2a05:d014::1', '185.40.234.55', '185.40.234.56'])
  const probe = async () => (readFileSync(HOSTS, 'utf8').includes('185.40.234.55 voice-test.example.ts.net #') ? { ok: true } : { ok: false, why: 'refused' })
  const setup = createSetup({ root: ROOT, secretsDir: SIGNIN, env: { ...setupEnv(), ...env }, platform, say, lookup, probe })
  return { setup, looked, connect: async () => setup.api['GET /api/connect']({ server: null }) }
}

// A connect answer needs a gateway on these secrets: its admin socket.
async function withGateway(work) {
  mkdirSync(SIGNIN, { recursive: true })
  rmSync(join(SIGNIN, 'admin.sock'), { force: true })
  const socket = createServer(connection => connection.end())
  await new Promise(resolve => socket.listen(join(SIGNIN, 'admin.sock'), resolve))
  try {
    await work()
  } finally {
    await new Promise(resolve => socket.close(resolve))
  }
}

test('the sign-in on this computer: checked under the tailnet name once the Funnel is on, the other server on 443 named; the port stays 443', async () => {
  mkdirSync(SIGNIN, { recursive: true })
  await withGateway(async () => {
    writeFileSync(HOSTS, BEFORE)
    rmSync(FUNNEL_ON, { force: true })
    assert.deepEqual((await (await signInSetup()).connect()).funnel, { state: 'off', url: null, port: '443', signIn: null, web443: null }, 'nothing to check while it is off')
    writeFileSync(FUNNEL_ON, '443')
    const { connect, looked } = await signInSetup() // a setup of its own: the Funnel's state is kept for ten seconds
    let { funnel, prepared } = await connect()
    assert.deepEqual(funnel, { state: 'on', url: 'https://voice-test.example.ts.net/mcp', port: '443', signIn: { ok: false, why: 'refused' }, web443: null })
    assert.deepEqual(prepared, [])
    assert.deepEqual(looked, [], 'no address looked up before the button')
    writeFileSync(LISTENERS, 'LISTEN 0 511 *:443 *:* users:(("apache2",pid=812,fd=4))\n')
    ;({ funnel } = await (await signInSetup()).connect())
    assert.deepEqual(funnel.web443, { name: 'apache2' })
    assert.equal(funnel.port, '443', 'never moved off 443 by itself')
    // Set to 8443 in the file: its Funnel, not the one on 443.
    writeFileSync(join(SIGNIN, 'gateway.env'), 'VOICE_GW_FUNNEL_PORT=8443\n')
    ;({ funnel } = await (await signInSetup()).connect())
    assert.deepEqual([funnel.state, funnel.port, funnel.signIn], ['off', '8443', null])
    rmSync(join(SIGNIN, 'gateway.env'))
    rmSync(LISTENERS)
  })
})

test('"Prepare the sign-in on this computer": one marked line with the public address, a backup, the rest untouched; out again when the assistant ends', async () => {
  await withGateway(async () => {
    writeFileSync(HOSTS, BEFORE)
    writeFileSync(FUNNEL_ON, '443')
    const { setup, connect, looked } = await signInSetup()
    const done = await setup.api['POST /api/signin/prepare']({ body: {} })
    assert.deepEqual(done, { prepared: true, address: '185.40.234.55', host: 'voice-test.example.ts.net', works: true, why: null })
    assert.deepEqual(looked, ['voice-test.example.ts.net'])
    const line = `185.40.234.55 voice-test.example.ts.net ${HOSTS_MARK}`
    assert.equal(readFileSync(HOSTS, 'utf8'), `${BEFORE}${line}\n`)
    assert.equal(readFileSync(`${HOSTS}.cc-voice-gateway.bak`, 'utf8'), BEFORE, 'a backup next to it')
    const answer = await connect()
    assert.deepEqual(answer.funnel.signIn, { ok: true }, 'the check gets the gateway now')
    assert.deepEqual(answer.prepared, [{ address: '185.40.234.55', host: 'voice-test.example.ts.net' }])

    // Again: still one line.
    await setup.api['POST /api/signin/prepare']({ body: {} })
    assert.equal(readFileSync(HOSTS, 'utf8'), `${BEFORE}${line}\n`)

    // "Remove it now", then prepared again and taken out when the assistant ends.
    assert.deepEqual(await setup.api['POST /api/signin/remove']({ body: {} }), { removed: 1 })
    assert.equal(readFileSync(HOSTS, 'utf8'), BEFORE)
    assert.deepEqual(await setup.api['POST /api/signin/remove']({ body: {} }), { removed: 0 })
    await setup.api['POST /api/signin/prepare']({ body: {} })
    await setup.close()
    assert.equal(readFileSync(HOSTS, 'utf8'), BEFORE)
    assert.ok(terminal.some(text => text === 'setup: the line for the sign-in is out of /etc/hosts again (the assistant ended)'))
  })
})

test('the marked line only: other lines kept, also similar ones and a last line without its newline; nothing changes without administrator rights', async () => {
  const similar = [
    `185.40.234.55 voice-test.example.ts.net`,
    `# 185.40.234.55 voice-test.example.ts.net ${HOSTS_MARK}`,
    `185.40.234.55 voice-test.example.ts.net ${HOSTS_MARK} extra`,
  ].join('\n')
  writeFileSync(HOSTS, `127.0.0.1 localhost\n${similar}`) // no newline at the end
  const line = `185.40.234.55 voice-test.example.ts.net ${HOSTS_MARK}`
  const run = command => spawnSync('sh', ['-c', command], { encoding: 'utf8' })
  assert.equal(run(hostsCommand(HOSTS, { add: line })).status, 0)
  assert.equal(readFileSync(HOSTS, 'utf8'), `127.0.0.1 localhost\n${similar}\n${line}\n`, 'on a line of its own')
  assert.deepEqual(markedLines(HOSTS).map(m => m.line), [line], 'only its exact form counts as the setup\'s')
  assert.equal(run(hostsCommand(HOSTS, { remove: [line] })).status, 0)
  assert.equal(readFileSync(HOSTS, 'utf8'), `127.0.0.1 localhost\n${similar}\n`)
  assert.throws(() => hostsLine('185.40.234.55', "x'; rm -rf /; '"), /not an address and a host name/)
  assert.throws(() => hostsCommand('/etc/ho sts', { add: line }), /not a plain path/)

  // Neither pkexec nor sudo here: the command for a terminal, and the file as it was.
  await withGateway(async () => {
    writeFileSync(HOSTS, BEFORE)
    writeFileSync(FUNNEL_ON, '443')
    const { setup } = await signInSetup({ env: { VOICE_SETUP_PKEXEC_BIN: join(BIN, 'no-pkexec') } })
    const refused = await setup.api['POST /api/signin/prepare']({ body: {} })
    assert.equal(refused.prepared, false)
    assert.match(refused.command, /^sudo sh -c '\(cp -p .*hosts.* grep -qxF -e .*185\.40\.234\.55 voice-test\.example\.ts\.net # cc-voice-gateway setup: /)
    assert.equal(readFileSync(HOSTS, 'utf8'), BEFORE)
  })
})

test('the check from this computer: what answers must be the gateway; a refused connection is not', async () => {
  const closed = await freePort()
  assert.deepEqual(await signInCheck(`https://127.0.0.1:${closed}/mcp`), { ok: false, why: 'refused' })
})

test('macOS: through the system\'s password dialog (osascript, with administrator privileges), and the resolver\'s cache flushed', async () => {
  await withGateway(async () => {
    writeFileSync(HOSTS, BEFORE)
    writeFileSync(FUNNEL_ON, '443')
    rmSync(OSASCRIPT_LOG, { force: true })
    const { setup } = await signInSetup({ platform: 'darwin' })
    const done = await setup.api['POST /api/signin/prepare']({ body: {} })
    assert.equal(done.prepared, true)
    const asked = readFileSync(OSASCRIPT_LOG, 'utf8')
    assert.match(asked, /^-e do shell script ".*" with administrator privileges$/m)
    assert.match(asked, /\/usr\/bin\/dscacheutil -flushcache; \/usr\/bin\/killall -HUP mDNSResponder/)
    assert.match(readFileSync(HOSTS, 'utf8'), /^185\.40\.234\.55 voice-test\.example\.ts\.net # cc-voice-gateway setup: /m)
    await setup.close()
    assert.equal(readFileSync(HOSTS, 'utf8'), BEFORE)
  })
})

test('signed in with the page\'s code: the line goes out of /etc/hosts by itself', async () => {
  // The real gateway of these tests; a sign-in with a code from this setup.
  writeFileSync(HOSTS, BEFORE)
  writeFileSync(FUNNEL_ON, '443')
  const { call } = flow.page
  // As "Prepare the sign-in on this computer" leaves it (above).
  writeFileSync(HOSTS, `${BEFORE}185.40.234.55 voice-test.example.ts.net ${HOSTS_MARK}\n`)
  assert.deepEqual((await call('/api/connect')).data.prepared, [{ address: '185.40.234.55', host: 'voice-test.example.ts.net' }])
  const made = (await call('/api/pairing', {})).data.code
  codes.push(made)
  assert.equal((await signIn(made)).ok, true)
  assert.equal((await call('/api/connect')).data.pairing.state, 'used')
  for (let i = 0; i < 100 && readFileSync(HOSTS, 'utf8') !== BEFORE; i++) await sleep(50)
  assert.equal(readFileSync(HOSTS, 'utf8'), BEFORE)
  assert.ok(terminal.includes('setup: the line for the sign-in is out of /etc/hosts again (the pairing code was used)'))
})

test('expiry: a code from the page signs in until its ten minutes are up, not after; one from pair.mjs lasts five', () => {
  const auth = new Auth({ stateFile: join(TMP, 'unit-oauth.json'), allowedHosts: ['claude.ai'] })
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const early = auth.newPairingCode({ minutes: 10 })
    assert.equal(early.expiresIn, 600)
    clock += 10 * 60 * 1000 - 1000
    assert.equal(auth.checkPairingCode(early.code), true, 'a second before the end')
    const late = auth.newPairingCode({ minutes: 10 })
    clock += 10 * 60 * 1000 + 1000
    assert.equal(auth.checkPairingCode(late.code), false, 'a second after the end')
    const plain = auth.newPairingCode()
    assert.equal(plain.expiresIn, 300)
    clock += 5 * 60 * 1000 + 1000
    assert.equal(auth.checkPairingCode(plain.code), false)
    assert.deepEqual(auth.pendingPairing(), { id: null, expiresAt: null })
    for (const minutes of [0, 11, 2.5, '10', null]) {
      assert.throws(() => auth.newPairingCode({ minutes }), /a whole number from 1 to 10/, String(minutes))
    }
  } finally {
    Date.now = realNow
  }
})

test('no code reaches the terminal, a log line, a URL, or any answer but the one that made it', () => {
  const made = flow.page.responses.filter(r => r.method === 'POST' && r.path === '/api/pairing').map(r => r.text)
  const others = flow.page.responses.filter(r => !(r.method === 'POST' && r.path === '/api/pairing')).map(r => r.text)
  const places = {
    terminal: terminal.join('\n'),
    'gateway log': gatewayLog + (existsSync(join(TMP, 'gateway.log')) ? readFileSync(join(TMP, 'gateway.log'), 'utf8') : ''),
    'setup log': existsSync(join(TMP, 'setup.log')) ? readFileSync(join(TMP, 'setup.log'), 'utf8') : '',
    URLs: flow.page.urls.join('\n'),
    'other answers': others.join('\n'),
  }
  assert.ok(codes.length >= 3)
  for (const code of codes) {
    assert.ok(made.some(text => text.includes(code)), 'in the answer that made it')
    for (const [place, text] of Object.entries(places)) {
      assert.ok(!text.includes(code) && !text.includes(code.replace(' ', '')), `a code in the ${place}`)
    }
  }
  assert.match(places['gateway log'], /oauth pairing code issued, valid 10 minutes/)
})

test('the overall limit moves only forward, and never by more than the limit itself', async () => {
  // The time left as the page learns it: from the server the handlers get.
  const left = Object.assign(({ server }) => server.remaining, { passive: true })
  const server = await startSetupServer({ host: '127.0.0.1', port: 0, say, timeoutMs: 1500, idleMs: 60000, api: { 'GET /api/left': left } })
  const page = await browser(server)
  await sleep(700)
  const before = (await page.call('/api/left')).data.overallMs
  assert.ok(before < 900, `time passes: ${before}`)
  server.extend(STAY_MS)
  const after = (await page.call('/api/left')).data.overallMs
  assert.ok(after > 1200 && after <= 1500, `capped at --timeout: ${after}`)
  server.extend(10)
  assert.ok((await page.call('/api/left')).data.overallMs > 1100, 'never back')
  const started = Date.now()
  assert.equal(await server.done, 'the time limit, extended for the pairing')
  assert.ok(Date.now() - started > 1000)
})

test('writing with "stay": the assistant stays open for the pairing, until "End the assistant"', async () => {
  const secrets = join(TMP, 'secrets-stay')
  const setup = createSetup({ root: ROOT, secretsDir: secrets, env: setupEnv(), platform: 'linux', say, probe: reached })
  const server = await startSetupServer({ host: '127.0.0.1', port: 0, api: setup.api, redact: setup.redact, say })
  const page = await browser(server)
  let ended = null
  server.done.then(reason => (ended = reason))
  const { data } = await page.call('/api/finish', {
    settings: { VOICE_GW_PORT: '8787', VOICE_GW_DOCKER: '' },
    telegram: { enabled: false },
    docker: { enabled: false },
    watchdog: {},
    stay: true,
  })
  const done = await follow(page, data.job)
  assert.equal(done.state, 'done', done.lines.join('\n'))
  assert.match(done.lines.join('\n'), /this page stays open for connecting the Claude app \(section 10\); "End the assistant" there when you are done/)
  assert.ok(existsSync(join(secrets, 'gateway.env')))
  await sleep(2500) // without "stay" it ends 1.5 seconds after the page saw the result
  assert.equal(ended, null)
  const status = await page.call('/api/connect')
  assert.equal(status.data.written, true)
  assert.equal(status.data.stay, true)
  assert.ok(status.data.remaining.overallMs > STAY_MS - 60000)
  assert.ok(terminal.includes('setup: the setup is written; the assistant stays open for connecting the Claude app'))
  await page.call('/api/cancel', {})
  assert.equal(await server.done, 'ended in the browser')
})

// --- the page's script, against a stand-in for the browser ---------------------------

// Every element a plain object; the server's answers from a table per path.
async function page(answers) {
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
  const asked = []
  const intervals = []
  const context = vm.createContext({
    document: { querySelector: $, querySelectorAll: () => [] },
    fetch: async (path, init) => {
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      const body = typeof answers[path] === 'function' ? answers[path]() : answers[path]
      return { ok: true, status: 200, json: async () => body }
    },
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    clearInterval: () => {},
    setTimeout,
    Option: function () {},
  })
  vm.runInContext(readFileSync(join(ROOT, 'src', 'setup', 'ui', 'app.js'), 'utf8'), context)
  await sleep(50) // its start reads /api/state, then polls section 10
  const click = async selector => {
    for (const listener of $(selector).listeners.click ?? []) listener()
    await sleep(30)
  }
  const poll = async () => {
    for (const { fn, ms } of intervals) if (ms === 4000) fn()
    await sleep(30)
  }
  return { $, asked, click, poll }
}

test('the page: what to do while the gateway is down, then a code with its time, a new one, and why one went away', async () => {
  const state = {
    host: 'test', root: ROOT, remaining: { overallMs: 600000, idleMs: 600000 }, checks: [], overridden: [], settings: {},
    models: [], efforts: [], secrets: {}, git: { name: '', email: '' }, repos: { host: [], docker: [] },
    watchdog: { platform: 'linux', unit: 'cc-voice-gateway.service' }, plugin: { mode: 'plugin', reason: '', allowlist: {} }, chrome: { noticeSeen: true },
  }
  const remaining = { overallMs: 500000, idleMs: 400000 }
  let connect = { gateway: false, tmux: true, pairing: null, remaining }
  let next = 0
  const made = ['1234 5678', '8765 4321', '1357 2468']
  const answers = { prepare: null, remove: null } // the sign-in on this computer
  const ui = await page({
    '/api/state': state,
    '/api/connect': () => connect,
    '/api/pairing': () => ({ code: made[next++], expiresIn: 600 }),
    '/api/signin/prepare': () => answers.prepare,
    '/api/signin/remove': () => answers.remove,
  })
  const { $ } = ui
  assert.equal($('#connect-gateway').textContent, 'not running yet')
  assert.equal($('#connect-wait').hidden, false)
  // Which question waits is not known: both, with the keys for each.
  const unknown = $('#connect-wait').textContent
  assert.match(unknown, /^Action needed: the controller runs in the tmux session "voice", but its gateway does not answer yet\. Most likely Claude Code waits for a confirmation at the terminal, such as the development channel's, which comes at every start while the plugin is not on the allowlist \(section 8\)\./)
  assert.match(unknown, /run tmux attach -t voice and answer it with Enter\. Should it ask whether you trust this folder, which the setup marks as trusted beforehand, press the down arrow once to "Yes, I trust this folder" \(Enter alone picks "No, exit"\), then Enter; then leave tmux with Ctrl-b, then d\. This page notices by itself when the gateway runs\.$/)
  assert.doesNotMatch(unknown, /which it does once/, 'no trust question promised that no longer comes')
  assert.equal($('#connect-ready').hidden, true)
  const html = readFileSync(join(ROOT, 'src', 'setup', 'ui', 'index.html'), 'utf8')
  assert.match(html, /<p id="connect-wait" class="notice" role="alert" hidden><\/p>/, 'a notice like the plugin warning')

  connect = { gateway: false, tmux: true, waiting: 'trust', pairing: null, remaining }
  await ui.poll()
  assert.match(
    $('#connect-wait').textContent,
    /^Action needed: Claude Code waits at the terminal for its one-time question whether you trust this folder, so the gateway does not start\. In a terminal on this computer, or over SSH: run tmux attach -t voice, press the down arrow once to "Yes, I trust this folder" \(Enter alone picks "No, exit"\), then Enter\. Answer any further question with Enter, then leave tmux with Ctrl-b, then d\./,
  )
  connect = { gateway: false, tmux: true, waiting: 'channel', pairing: null, remaining }
  await ui.poll()
  assert.match(
    $('#connect-wait').textContent,
    /^Action needed: Claude Code waits at the terminal for the development channel's confirmation, which it asks at every start while the plugin is not on the allowlist \(section 8\), so the gateway does not start\. .*run tmux attach -t voice, press Enter for "I am using this for local development", then leave tmux with Ctrl-b, then d\./,
  )
  assert.doesNotMatch($('#connect-wait').textContent, /trust/, 'no step that is not needed')
  connect = { gateway: false, tmux: true, waiting: 'something new', pairing: null, remaining }
  await ui.poll()
  assert.equal($('#connect-wait').textContent, unknown)

  connect = { gateway: false, tmux: false, pairing: null, remaining }
  await ui.poll()
  assert.match($('#connect-wait').textContent, /^The controller is not running\. Start it: tick "Start it now" in section 7/)

  connect = { gateway: true, funnel: { state: 'on', url: 'https://voice-test.example.ts.net/mcp' }, pairing: null, remaining }
  await ui.poll()
  assert.equal($('#connect-gateway').textContent, 'running')
  assert.equal($('#connect-wait').hidden, true)
  assert.equal($('#connect-ready').hidden, false)
  assert.equal($('#connect-url').textContent, 'https://voice-test.example.ts.net/mcp')
  assert.equal($('#connect-url-row').hidden, false)
  assert.equal($('#funnel-row').hidden, true, 'no start while it is on')
  assert.equal($('#connect-port-note').hidden, true, 'on 443, with nothing else there')

  // The check under the tailnet name did not get the gateway: what goes on, and two ways.
  const funnel = { state: 'on', url: 'https://voice-test.example.ts.net/mcp', port: '443' }
  connect = { gateway: true, funnel: { ...funnel, signIn: { ok: false, why: 'certificate' }, web443: { name: 'httpd' } }, prepared: [], pairing: null, remaining }
  await ui.poll()
  assert.equal($('#signin-box').hidden, false)
  assert.equal(
    $('#signin-note').textContent,
    'The Claude app reaches the gateway over the Funnel, but a browser on this computer cannot sign in: under the tailnet name it reaches this ' +
      'computer itself, where another web server (httpd) holds port 443. Sign in from another device, for example claude.ai in a browser on ' +
      'your phone with a pairing code from this page, or prepare the sign-in on this computer: with your administrator password, a marked ' +
      "line in /etc/hosts sends the name to the Funnel's public address until you have signed in.",
  )
  assert.equal($('#connect-port-note').hidden, true)
  connect = { gateway: true, funnel: { ...funnel, signIn: { ok: false, why: 'refused' }, web443: null }, prepared: [], pairing: null, remaining }
  await ui.poll()
  assert.match($('#signin-note').textContent, /it reaches this computer itself, where the Tailscale app cannot take port 443\./)

  // The button: prepared, and the line shown with "Remove it now".
  answers.prepare = { prepared: true, address: '185.40.234.55', host: 'voice-test.example.ts.net', works: true, why: null }
  connect = { gateway: true, funnel: { ...funnel, signIn: { ok: true }, web443: null }, prepared: [{ address: '185.40.234.55', host: 'voice-test.example.ts.net' }], pairing: null, remaining }
  await ui.click('#signin-prepare')
  assert.ok(ui.asked.includes('POST /api/signin/prepare'))
  assert.equal($('#signin-state').textContent, 'Prepared: voice-test.example.ts.net now reaches the gateway from this computer too. Sign in.')
  await ui.poll()
  assert.equal($('#signin-box').hidden, true, 'the check gets the gateway now')
  assert.equal($('#signin-prepared').hidden, false)
  assert.equal(
    $('#signin-prepared-text').textContent,
    "The sign-in on this computer is prepared: /etc/hosts sends voice-test.example.ts.net to 185.40.234.55, the Funnel's public address. Sign in now; the line goes again by itself once the code is used or this page ends.",
  )
  answers.remove = { removed: 1 }
  await ui.click('#signin-remove')
  assert.equal($('#signin-remove-state').textContent, 'Removed from /etc/hosts.')
  // Without administrator rights: the command for a terminal.
  answers.prepare = { prepared: false, command: "sudo sh -c '(cp -p …)'" }
  await ui.click('#signin-prepare')
  assert.equal($('#signin-state').textContent, 'The setup has no administrator rights here: run the command below, then sign in.')
  assert.equal($('#signin-command').hidden, false)
  assert.equal($('#signin-command').textContent, "In a terminal on this computer:\nsudo sh -c '(cp -p …)'")

  // Another port, set by hand: the connector did not connect there.
  connect = { gateway: true, funnel: { state: 'on', url: 'https://voice-test.example.ts.net:8443/mcp', port: '8443', signIn: { ok: true }, web443: null }, prepared: [], pairing: null, remaining }
  await ui.poll()
  assert.equal($('#connect-url').textContent, 'https://voice-test.example.ts.net:8443/mcp')
  assert.equal(
    $('#connect-port-note').textContent,
    "The Funnel is set to port 8443: Funnel serves it publicly, but claude.ai's connector did not connect to it in our test. Keep 443 for the connector.",
  )
  assert.equal($('#signin-prepared').hidden, true)
  assert.match(html, /<p>Tailscale Funnel: <span id="connect-funnel" class="state"><\/span><\/p>\s*<p id="connect-port-note" class="notice" hidden><\/p>/)
  assert.match(html, /<button id="signin-prepare">Prepare the sign-in on this computer<\/button>/)
  assert.match(html, /<button id="signin-remove">Remove it now<\/button>/)

  await ui.click('#pairing-new')
  assert.ok(ui.asked.includes('POST /api/pairing'))
  assert.equal($('#pairing-code').textContent, '1234 5678')
  assert.equal($('#pairing-box').hidden, false)
  assert.match($('#pairing-timer').textContent, /^valid for (10:00|9:5\d), for one sign-in$/)
  assert.equal($('#pairing-new').textContent, 'New code')

  await ui.click('#pairing-new')
  assert.equal($('#pairing-code').textContent, '8765 4321', 'the new code in place of the old one')

  connect = { gateway: true, funnel: { state: 'off', url: null }, pairing: { state: 'gone' }, remaining }
  await ui.poll()
  assert.equal($('#funnel-row').hidden, false, 'a start while it is off')
  assert.equal($('#connect-url-row').hidden, true)
  assert.equal($('#pairing-code').textContent, '', 'a code that no longer works leaves the page')
  assert.equal($('#pairing-box').hidden, true)
  assert.match($('#pairing-state').textContent, /^This code no longer works: used, replaced by a newer one \(scripts\/pair\.mjs\)/)

  await ui.click('#pairing-new')
  connect = { gateway: true, funnel: { state: 'on', url: null }, pairing: { state: 'used', client: 'Claude', at: Date.now() }, remaining }
  await ui.poll()
  assert.equal($('#pairing-code').textContent, '')
  assert.match($('#pairing-state').textContent, /^Used: Claude signed in at .*\. The connector is connected\.$/)
  assert.ok(!ui.asked.some(line => /\d{4}/.test(line)), 'never a code in a URL')
})
