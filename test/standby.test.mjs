// Which gateway answers the connector, active or not (presence.mjs), and the
// standby when the connector is disconnected (standby.mjs): what counts as a
// disconnect, what the gateway stops and keeps, and the wake-up on a new
// sign-in. The parts on their own, then the gateway as a whole with a stand-in
// for claude, Telegram and Claude's connector.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-standby-')))
// Before the modules are loaded: no log file, no settings of this checkout.
process.env.VOICE_GW_LOG_FILE = ''
process.env.VOICE_GW_SECRETS_DIR = join(TMP, 'no-secrets')
const { Auth } = await import('../src/oauth.mjs')
const { Standby } = await import('../src/standby.mjs')
const { Presence, computerKind, shortHost } = await import('../src/presence.mjs')
const { Alerts } = await import('../src/ipguard.mjs')
const { adminRequest } = await import('../src/admin.mjs')

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const BIN = join(TMP, 'bin')
const CALLS = join(TMP, 'claude-calls.jsonl')
const TOKEN = '123456789:TEST-token-standby-never-in-a-log'
const CHAT = '4242'
const HOUR = 60 * 60 * 1000
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const FORWARDED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'standby-test.example.ts.net' }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, ms = 10000) {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(25)) {
    const value = await predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

// --- the gateway's line -----------------------------------------------------------

test("the gateway's line: its name and kind of computer; active only with a controller connected, the kill switch open and no standby", () => {
  assert.equal(shortHost('sky.local'), 'sky')
  assert.equal(computerKind('darwin'), 'Mac')
  const model = join(TMP, 'model')
  writeFileSync(model, 'Raspberry Pi 4 Model B Rev 1.4\0')
  assert.equal(computerKind('linux', model), 'Raspberry Pi')
  assert.equal(computerKind('linux', join(TMP, 'no-model')), 'Linux')
  assert.equal(new Presence({ name: 'Skylab', kind: 'Linux' }).label, 'Skylab (Linux)')
  assert.equal(new Presence({ name: 'Pi (garage)', kind: 'Raspberry Pi' }).label, 'Pi (garage)', 'a name with its own brackets')

  const killswitch = { locked: false }
  const standby = { active: false }
  const presence = new Presence({ host: 'sky.local', kind: 'Mac', killswitch, standby })
  assert.equal(presence.label, 'sky (Mac)')
  assert.equal(presence.line(), 'Gateway sky (Mac): inactive, no controller connected; use another connector')
  presence.connected = true
  assert.equal(presence.line(), 'Gateway sky (Mac): active')
  killswitch.locked = true
  assert.equal(presence.line(), 'Gateway sky (Mac): inactive, kill switch locked; use another connector')
  standby.active = true
  assert.equal(presence.line(), 'Gateway sky (Mac): inactive, connector disconnected, in standby; use another connector')
  const test = new Presence({ host: 'sky', kind: 'Mac', standbySetting: true })
  test.connected = true
  assert.equal(test.line(), 'Gateway sky (Mac): inactive, on standby by its settings; use another connector')
})

// --- what counts as a disconnect --------------------------------------------------

// Claude's connector as a grant of its own, signed in two hours ago; its
// access token ran out an hour ago, as between two drives.
const connector = (extra = {}) => ({
  id: 'aaa111',
  clientId: 'client-1',
  clientName: 'Claude',
  createdAt: Date.now() - 2 * HOUR,
  refreshHash: randomBytes(8).toString('hex'),
  refreshExpiresAt: Date.now() + 30 * 24 * HOUR,
  accessHash: randomBytes(8).toString('hex'),
  accessExpiresAt: Date.now() - HOUR,
  ...extra,
})
const local = { id: 'loc001', clientId: 'local', clientName: 'test', createdAt: Date.now(), accessHash: 'z', accessExpiresAt: Date.now() + HOUR }

function authWith(grants) {
  const file = join(TMP, `oauth-${randomBytes(3).toString('hex')}.json`)
  writeFileSync(file, JSON.stringify({ clients: {}, grants }))
  return new Auth({ stateFile: file, allowedHosts: ['claude.ai'] })
}

function standbyOf(auth, options = {}) {
  const standby = new Standby({ file: join(TMP, `standby-${randomBytes(3).toString('hex')}.json`), auth, graceMs: 150, log: () => {}, ...options })
  const events = []
  standby.on('enter', ({ reason }) => events.push(['enter', reason]))
  standby.on('leave', ({ why }) => events.push(['leave', why]))
  return { standby, events }
}

const anthropic = { address: '160.79.104.10', via: 'funnel' }

test('a revocation that leaves no connector grant is a disconnect; one of a local tool, or with another connector left, is none; a new sign-in ends it', () => {
  const auth = authWith([connector(), connector({ id: 'bbb222' }), local])
  const { standby, events } = standbyOf(auth)
  auth.revoke('loc001')
  assert.deepEqual(events, [])
  auth.revoke('aaa111')
  assert.deepEqual(events, [], 'another connector grant is left')
  auth.revoke('bbb222')
  assert.deepEqual(events, [['enter', 'its sign-in was revoked at the computer']])
  assert.equal(standby.active, true)
  assert.equal(new Standby({ file: standby.file, auth: authWith([]), log: () => {} }).active, true, 'it holds across a restart')

  auth.emit('connected', { grant: { id: 'ccc333', client: 'Claude' } })
  assert.deepEqual(events.at(-1), ['leave', 'a new sign-in (Claude)'])
  assert.equal(standby.active, false)

  const off = standbyOf(authWith([connector()]), { enabled: false })
  off.standby.auth.revoke('aaa111')
  assert.deepEqual(off.events, [], 'VOICE_GW_DISCONNECT_STANDBY=0')
})

test('voice requests without a token from Anthropic while the sign-in went unused: a disconnect after the grace; never during a refresh, a use or a new sign-in', async () => {
  // Unused for an hour: from Anthropic, without a token.
  let { standby, events } = standbyOf(authWith([connector({ lastUsedAt: Date.now() - HOUR })]))
  standby.refused({ address: '127.0.0.1', via: 'local' }, 'missing')
  standby.refused({ address: '203.0.113.5', via: 'funnel' }, 'missing')
  standby.refused(anthropic, 'expired') // the hourly refresh comes with the expired token, which the gateway knows
  assert.equal(standby.suspect, null, 'a local caller, another address, a refresh: none')
  standby.refused(anthropic, 'missing')
  assert.ok(standby.suspect, 'a call without a token: the grace starts')
  await until(() => events.length)
  assert.deepEqual(events, [['enter', 'voice requests without a token came while its sign-in went unused for more than 10 minutes']])

  // With a token the gateway does not know, the same.
  ;({ standby, events } = standbyOf(authWith([connector({ lastUsedAt: Date.now() - HOUR })])))
  standby.refused(anthropic, 'unknown')
  await until(() => events.length)

  // Used a minute ago, as during a drive: none.
  ;({ standby, events } = standbyOf(authWith([connector({ lastUsedAt: Date.now() - 60000 })])))
  standby.refused(anthropic, 'missing')
  assert.equal(standby.suspect, null)

  // A refresh during the grace, or a new sign-in: none.
  let auth = authWith([connector({ lastUsedAt: Date.now() - HOUR })])
  ;({ standby, events } = standbyOf(auth))
  standby.refused(anthropic, 'missing')
  auth.state.grants[0].refreshedAt = Date.now()
  await sleep(300)
  assert.deepEqual(events, [], 'the connector refreshed meanwhile')
  auth = authWith([connector({ lastUsedAt: Date.now() - HOUR })])
  ;({ standby, events } = standbyOf(auth))
  standby.refused(anthropic, 'missing')
  auth.emit('connected', { grant: { id: 'ddd444', client: 'Claude' } })
  await sleep(300)
  assert.deepEqual(events, [], 'connected again meanwhile, as when a connector is added once more')

  // No connector grant at all, a gateway never connected: none.
  ;({ standby, events } = standbyOf(authWith([local])))
  standby.refused(anthropic, 'missing')
  assert.equal(standby.suspect, null)
})

test('alerts in a standby: only counted, at most one summary a day; a successful sign-in still goes out', async () => {
  const sent = []
  const alerts = new Alerts({ send: async text => sent.push(text), log: () => {}, pausedMs: 200, host: 'sky' })
  try {
    alerts.pause()
    alerts.notify('token', '160.79.104.10', 'a voice request without a token came from 160.79.104.10, and was refused.')
    alerts.notify('token', '160.79.104.11', 'another one')
    alerts.notify('blocked', '203.0.113.5', 'blocked')
    await sleep(50)
    assert.deepEqual(sent, [])
    alerts.notify('accepted', '198.51.100.1', 'signed in with the pairing code', { urgent: true })
    await sleep(50)
    assert.deepEqual(sent, ['cc-voice-gateway on sky: signed in with the pairing code'])
    await until(() => sent.length === 2)
    assert.equal(
      sent[1],
      'cc-voice-gateway on sky: in standby, as the connector was disconnected; not reported one by one: 2 voice requests ' +
        'without a valid token, 1 voice request from outside the allowed addresses, from 3 addresses. The gateway log has each of them.',
    )
    await sleep(300)
    assert.equal(sent.length, 2, 'nothing more without news')
    alerts.resume()
    alerts.notify('token', '160.79.104.12', 'after the standby')
    await sleep(50)
    assert.equal(sent.at(-1), 'cc-voice-gateway on sky: after the standby')
  } finally {
    alerts.close()
  }
})

// --- the gateway --------------------------------------------------------------------

// SLOW: it runs until it is stopped. Otherwise a result.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ input }) + '\\n')
const args = process.argv.slice(2)
const session = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1]
if (/SLOW/.test(input)) setInterval(() => {}, 1000)
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session }))
`
const claudeCalls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])

const telegram = { server: null, url: '', sent: [] }

before(async () => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  chmodSync(join(BIN, 'claude'), 0o755)
  telegram.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {}
      const reply = data => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: data }))
      }
      if (req.url === `/bot${TOKEN}/sendMessage`) {
        telegram.sent.push(json.text)
        return reply({ message_id: telegram.sent.length })
      }
      if (req.url === `/bot${TOKEN}/getUpdates`) {
        await sleep(200)
        return reply([])
      }
      res.writeHead(404).end(JSON.stringify({ ok: false, description: 'Not Found' }))
    })
  })
  await new Promise(resolve => telegram.server.listen(0, '127.0.0.1', resolve))
  telegram.url = `http://127.0.0.1:${telegram.server.address().port}`
})

after(() => {
  telegram.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// A folder of repositories with alpha, pushed to a bare remote.
function repositories(name) {
  const root = join(TMP, name, 'Developer')
  const dir = join(root, 'alpha')
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
  execFileSync('git', ['init', '-q', '--bare', join(TMP, name, 'remote.git')])
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', join(TMP, name, 'remote.git'))
  git('push', '-q', 'origin', 'main')
  return root
}

async function startGateway(name, { env = {}, grants = [] } = {}) {
  const port = await freePort()
  const secrets = join(TMP, name, 'secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), TOKEN, { mode: 0o600 })
  writeFileSync(join(secrets, 'telegram_chat_id'), CHAT, { mode: 0o600 })
  writeFileSync(join(secrets, 'oauth.json'), JSON.stringify({ clients: {}, grants }), { mode: 0o600 })
  const g = { port, secrets, events: [], log: '' }
  g.claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  g.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => g.events.push(params),
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: join(TMP, name, 'state'),
      VOICE_GW_WORKER_ROOT: repositories(name),
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'no-gh'),
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_SELF_CHECKOUT: '',
      VOICE_GW_TELEGRAM_API: telegram.url,
      VOICE_GW_TELEGRAM_POLL: '1',
      VOICE_GW_TELEGRAM_AFTER: '3600', // the fallback for questions stays out of this
      VOICE_GW_REMIND_MINUTES: '0.05', // three seconds
      VOICE_GW_MAX_WAIT: '3',
      VOICE_GW_DEFAULT_WAIT: '1',
      VOICE_GW_NAME: 'Standbybox (test)',
      ...env,
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (g.log += chunk))
  await g.claudeCode.connect(stdio)
  await until(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok)
  const { access_token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name: 'car' })
  g.voiceClient = new Client({ name: 'car', version: '0.0.0' })
  await g.voiceClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    }),
  )
  g.voice = async (tool, args = {}) => (await g.voiceClient.callTool({ name: tool, arguments: args })).content[0].text
  g.controller = async (tool, args = {}) => (await g.claudeCode.callTool({ name: tool, arguments: args })).content[0].text
  g.admin = (method, path, body) => adminRequest(join(secrets, 'admin.sock'), method, path, body)
  g.close = async () => {
    await g.voiceClient.close()
    await g.claudeCode.close()
  }
  return g
}

// Claude's connector signing in: registration, the sign-in page with the
// pairing code, and the token exchange. Its tokens and client.
async function signIn(port, pairingCode) {
  const gw = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init, headers: { ...FORWARDED, ...init.headers } })
  const registered = await gw('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', client_name: 'Claude' }),
  })
  const { client_id } = await registered.json()
  const verifier = randomBytes(32).toString('base64url')
  const authorized = await gw('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'st4te',
      pairing_code: pairingCode,
      action: 'connect',
    }).toString(),
  })
  assert.equal(authorized.status, 302, await authorized.text())
  const code = new URL(authorized.headers.get('location')).searchParams.get('code')
  const token = await gw('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: CALLBACK }).toString(),
  })
  assert.equal(token.status, 200)
  return { client_id, ...(await token.json()), gw }
}

const idOf = text => /id=([a-z0-9]+)/.exec(text)?.[1]
const LINE = 'Gateway Standbybox (test)'

test('gateway: the connector revoked at the computer: one message, then standby; runs stopped, the queue kept, no alerts, no reminders; a new sign-in wakes it up', async () => {
  const g = await startGateway('standby', { grants: [connector({ id: 'abc123', lastUsedAt: Date.now() - HOUR })] })
  try {
    assert.match(await g.voice('status'), new RegExp(`^${LINE.replace(/[()]/g, '\\$&')}: active\\n\\[gateway=ok `))

    // A run going, a task queued behind it, and a question to the driver.
    const first = idOf(await g.voice('send', { message: 'Run the long tests in alpha.' }))
    assert.match(await g.controller('dispatch', { worker: 'alpha', task: 'SLOW: run the long tests.', words: 'Run the long tests in alpha.' }), /^\[dispatch=started/)
    await g.voice('send', { message: 'Then update the changelog in alpha.' })
    const queued = /queued=(q[a-z0-9]{3})/.exec(await g.controller('dispatch', { worker: 'alpha', task: 'Update the changelog.', words: 'Then update the changelog in alpha.' }))?.[1]
    assert.ok(queued, 'queued behind the run')
    await g.controller('reply', { request_id: first, state: 'question', text: 'Restart the controller first?', kind: 'restart' })
    await until(() => claudeCalls().length === 1)

    // Revoked at the computer, as with node scripts/pair.mjs revoke.
    const before = telegram.sent.length
    assert.deepEqual(await g.admin('POST', '/revoke', { id: 'abc123' }), { revoked: 1 })
    const message = await until(() => telegram.sent.slice(before).find(text => /switching off/.test(text)))
    assert.match(message, /: the connector was disconnected \(its sign-in was revoked at the computer\), I am switching off now\. Worker runs stop and nothing new starts; no reminders and no alerts, at most one summary a day\. The queue and the open decisions are kept\. A new sign-in with a pairing code \(the setup page, or node scripts\/pair\.mjs\) switches me on again\.$/)
    const event = await until(() => g.events.find(e => e.meta?.kind === 'standby' && e.meta.state === 'on'))
    assert.match(event.content, /^Standby: the connector in claude\.ai was disconnected \(its sign-in was revoked at the computer\), so the gateway switched off\. It stopped 1 worker run, whose results follow after the standby/)

    // Inactive: the line says so, send hands nothing over, and nothing starts.
    const status = await g.voice('status')
    assert.match(status, /^Gateway Standbybox \(test\): inactive, connector disconnected, in standby; use another connector\n/)
    assert.match(await g.voice('send', { message: 'Fix the typo in alpha.' }), /\n\[state=inactive\] Nothing was handed over: this gateway is inactive, connector disconnected, in standby\. Tell the user/)
    assert.ok(!g.events.some(e => e.content === 'Fix the typo in alpha.'))
    assert.match(await g.controller('dispatch', { worker: 'alpha', task: 'Update the changelog.', words: 'Then update the changelog in alpha.' }), /^\[dispatch=standby worker=alpha\] Nothing started/)
    await until(async () => /state=stopped/.test(await g.controller('worker_status', { worker: 'alpha' })))
    assert.match(await g.controller('list_workers'), new RegExp(`queued: ${queued} `), 'the queue is kept')

    // Calls without a token from Anthropic, as from a removed connector: refused, without alerts.
    for (let i = 0; i < 3; i++) {
      const refused = await fetch(`http://127.0.0.1:${g.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `160.79.104.${10 + i}`, ...FORWARDED },
        body: '{}',
      })
      assert.equal(refused.status, 401)
    }
    const quiet = telegram.sent.length
    await sleep(4500) // past the question's reminder time
    assert.equal(telegram.sent.length, quiet, 'no alerts, no messages in the standby')
    assert.ok(!g.events.some(e => e.meta?.kind === 'reminder'), 'no reminders')
    assert.equal(claudeCalls().length, 1, 'the queued task did not start')
    assert.ok(!g.events.some(e => e.meta?.task && e.meta.outcome === 'stopped'), "the stopped run's result waits")

    // A new sign-in with a pairing code wakes it up.
    const { code } = await g.admin('POST', '/pairing', { minutes: 5 })
    const tokens = await signIn(g.port, code.replace(' ', ''))
    const back = await until(() => telegram.sent.slice(quiet).find(text => /I am back/.test(text)))
    assert.match(back, /: I am back: the connector is connected again \(a new sign-in \(Claude\)\)\. Queued tasks go on, and what waited reaches the controller\.$/)
    await until(() => g.events.find(e => e.meta?.kind === 'standby' && e.meta.state === 'off'))
    assert.match(await g.voice('status'), /^Gateway Standbybox \(test\): active\n/)
    await until(() => g.events.find(e => e.meta?.task && e.meta.outcome === 'stopped'))
    await until(() => claudeCalls().some(call => /Update the changelog\./.test(call.input)))
    await until(() => g.events.find(e => e.meta?.kind === 'reminder'), 15000)

    // The connector revokes its own token (RFC 7009): standby again. The metadata names the endpoint.
    const metadata = await (await tokens.gw('/.well-known/oauth-authorization-server')).json()
    assert.equal(metadata.revocation_endpoint, 'https://standby-test.example.ts.net/oauth/revoke')
    const revoked = await tokens.gw('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: 'refresh_token', client_id: tokens.client_id }).toString(),
    })
    assert.equal(revoked.status, 200)
    await until(() => telegram.sent.find(text => /the connector was disconnected \(the connector revoked its sign-in\), I am switching off now/.test(text)))
    assert.deepEqual(await g.admin('GET', '/grants').then(list => list.filter(grant => grant.client === 'Claude')), [], 'its grant is gone')
    const unknown = await tokens.gw('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'not-a-token', client_id: tokens.client_id }).toString(),
    })
    assert.equal(unknown.status, 200, 'an unknown token is answered alike')
  } finally {
    await g.close()
  }
})

test('gateway: VOICE_GW_STANDBY=1, a standby install: inactive in every answer, in the instructions and the tool descriptions; nothing handed over', async () => {
  const g = await startGateway('setting', { env: { VOICE_GW_STANDBY: '1' } })
  try {
    assert.match(await g.voice('status'), /^Gateway Standbybox \(test\): inactive, on standby by its settings; use another connector\n\[gateway=ok /)
    assert.match(await g.voice('ask', { message: 'Is the build green?' }), /\n\[state=inactive\] Nothing was handed over: this gateway is inactive, on standby by its settings\./)
    assert.ok(!g.events.some(e => e.content === 'Is the build green?'))
    assert.match(g.voiceClient.getInstructions(), /\nThis gateway is on standby by its settings: it hands nothing over\. Use another connector\.$/)
    const { tools } = await g.voiceClient.listTools()
    for (const tool of tools) assert.match(tool.description, /This is the gateway Standbybox \(test\), on standby by its settings\.$/, tool.name)
  } finally {
    await g.close()
  }
})
