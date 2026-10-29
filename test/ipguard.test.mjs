// The door of the voice endpoint (src/ipguard.mjs): the access log, /mcp
// through the tunnel only from Anthropic's addresses, and the alerts on
// Telegram about suspicious requests and sign-ins, throttled.
//
// The address matching, the guard and the throttle are tested on their own;
// the gateway as a whole with requests that carry the headers Tailscale Funnel
// sets, and a local HTTP server standing in for the Telegram Bot API. No test
// sends a real message.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminRequest } from '../src/admin.mjs'
import { Alerts, IpGuard, accessLine, addressBytes, inRanges, parseRange, via } from '../src/ipguard.mjs'
import { Auth } from '../src/oauth.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-ipguard-'))
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT_ID = '4242'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const PREFIX = `cc-voice-gateway on ${hostname()}: `
const FUNNEL = { 'tailscale-funnel-request': '?1' }

// Not into the gateway's real log.
const quiet = () => {}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = value => createHash('sha256').update(value).digest('hex')

function waitFor(predicate, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      const value = predicate()
      if (value) return resolve(value)
      if (Date.now() - started > ms) return reject(new Error('timed out waiting'))
      setTimeout(check, 20)
    }
    check()
  })
}

// --- the stand-in Telegram Bot API -------------------------------------------

const api = { messages: [], server: null, url: '' }

before(async () => {
  api.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const sent = req.url === `/bot${TOKEN}/sendMessage`
      if (sent) api.messages.push(JSON.parse(body || '{}'))
      res.writeHead(sent ? 200 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(sent ? { ok: true, result: {} } : { ok: false, description: 'Bad Request: not here' }))
    })
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  api.url = `http://127.0.0.1:${api.server.address().port}`
})

after(() => {
  api.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

// --- addresses and ranges ------------------------------------------------------

const ANTHROPIC = [parseRange('160.79.104.0/21')]

test("ranges: Anthropic's /21 from its first to its last address, and nothing next to it", () => {
  for (const address of ['160.79.104.0', '160.79.106.3', '160.79.111.255']) assert.ok(inRanges(address, ANTHROPIC), address)
  for (const address of ['160.79.103.255', '160.79.112.0', '161.79.106.3', '34.162.10.1']) {
    assert.ok(!inRanges(address, ANTHROPIC), address)
  }
  assert.deepEqual(parseRange('160.79.104.0/21'), { text: '160.79.104.0/21', bytes: [160, 79, 104, 0], bits: 21 })
  assert.deepEqual(parseRange('192.0.2.7').bits, 32, 'a plain address is a range of one')
  assert.ok(inRanges('192.0.2.7', [parseRange('192.0.2.7')]))
  assert.ok(!inRanges('192.0.2.8', [parseRange('192.0.2.7')]))
  assert.ok(inRanges('8.8.8.8', [parseRange('0.0.0.0/0')]))
})

test('ranges: IPv4-mapped IPv6 counts as IPv4; ports and brackets are left out; junk matches nothing', () => {
  for (const address of ['::ffff:160.79.106.3', '::FFFF:160.79.106.3', '::ffff:a04f:6a03', '[::ffff:160.79.106.3]:443', '160.79.106.3:443']) {
    assert.ok(inRanges(address, ANTHROPIC), address)
  }
  assert.deepEqual(addressBytes('::ffff:127.0.0.1'), [127, 0, 0, 1])
  assert.ok(!inRanges('::ffff:160.79.112.1', ANTHROPIC))
  for (const junk of ['', '?', 'localhost', '160.79.106', '160.79.106.3.4', '0160.79.106.3', '2001:db8::1', undefined, null]) {
    assert.ok(!inRanges(junk, ANTHROPIC), String(junk))
  }
})

test('ranges: IPv6 ranges work too, and invalid ones are refused', () => {
  const v6 = [parseRange('2001:db8::/32'), parseRange('::1')]
  assert.ok(inRanges('2001:db8:1::5', v6))
  assert.ok(inRanges('[2001:db8::1]:8080', v6))
  assert.ok(inRanges('::1', v6))
  assert.ok(!inRanges('2001:db9::1', v6))
  assert.ok(!inRanges('160.79.106.3', v6), 'IPv4 is not in an IPv6 range')
  assert.ok(!inRanges('2001:db8::1', [parseRange('0.0.0.0/0')]), 'nor the other way round')
  for (const bad of ['160.79.104.0/33', '160.79.104/21', '160.79.104.0/21/1', '160.79.104.0/x', 'any', '', 'fe80::1%eth0/64', '::/129']) {
    assert.equal(parseRange(bad), null, bad)
  }
})

test('how a request came in: Funnel, proxy, local or direct', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
  assert.equal(via(req('127.0.0.1')), 'local')
  assert.equal(via(req('::ffff:127.0.0.1')), 'local')
  assert.equal(via(req('::1')), 'local')
  assert.equal(via(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), 'proxy')
  assert.equal(via(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5', ...FUNNEL })), 'funnel')
  assert.equal(via(req('192.168.1.20')), 'direct')
  assert.equal(via(req('192.168.1.20', FUNNEL)), 'direct', 'only from loopback do the headers count')
  assert.equal(via(req(undefined)), 'direct')
})

test('the guard: local callers always pass, the rest by range; "any" lifts the limit', () => {
  const logged = []
  const guard = new IpGuard({ allow: ['160.79.104.0/21', 'bogus'], log: line => logged.push(line) })
  assert.deepEqual(logged, ['VOICE_GW_MCP_ALLOW: "bogus" is not an address range; left out'])
  assert.match(guard.describe(), /only from 160\.79\.104\.0\/21 \(VOICE_GW_MCP_ALLOW\)/)
  assert.ok(guard.allows({ address: '127.0.0.1', via: 'local' }))
  assert.ok(guard.allows({ address: '160.79.106.3', via: 'funnel' }))
  assert.ok(!guard.allows({ address: '203.0.113.5', via: 'funnel' }))
  assert.ok(!guard.allows({ address: '127.0.0.1', via: 'funnel' }), 'a Funnel request without its address stays out')
  assert.ok(!guard.allows({ address: '192.168.1.20', via: 'direct' }))

  const open = new IpGuard({ allow: ['any'], log: quiet })
  assert.ok(open.allows({ address: '203.0.113.5', via: 'funnel' }))
  assert.match(open.describe(), /from any address/)
  const none = new IpGuard({ allow: ['nonsense'], log: quiet })
  assert.ok(!none.allows({ address: '160.79.106.3', via: 'funnel' }), 'no valid range: nobody through the tunnel')
  assert.match(none.describe(), /nowhere/)
})

test("sign-in alerts: a client's name reaches Telegram without anything that could become a link", () => {
  const texts = []
  const guard = new IpGuard({ log: quiet, alerts: { notify: (kind, address, text, options) => texts.push({ kind, text, options }) } })
  guard.pairing({ outcome: 'wrong', address: '203.0.113.9', client: 'Claude: sign in at https://evil.example/now', left: 4 })
  guard.pairing({ outcome: 'burnt', address: '203.0.113.9', client: 'x', total: 20 })
  guard.pairing({ outcome: 'accepted', address: '198.51.100.8', client: 'Claude' })
  guard.pairing({ outcome: 'something else', address: '203.0.113.9' })
  assert.deepEqual(texts.map(entry => entry.kind), ['wrong', 'burnt', 'accepted'])
  assert.equal(texts[0].text, 'wrong pairing code on the sign-in page from 203.0.113.9 (client "Claude sign in at https evil example now"); 4 attempts left there.')
  assert.match(texts[1].text, /20 wrong attempts in all, so the code is burnt\. For a new one: node scripts\/pair\.mjs\.$/)
  assert.deepEqual([texts[0].options, texts[2].options], [{ urgent: false }, { urgent: true }])
})

test('the access line: address, way in, method, path without the query, status; old secret paths masked', () => {
  const req = { method: 'GET' }
  const res = { headersSent: true, statusCode: 404, writableFinished: true }
  const caller = { address: '192.0.2.66', via: 'funnel' }
  const line = url => accessLine(req, res, new URL(url, 'http://localhost'), caller)
  assert.equal(line('/_ignition/execute-solution?x=1'), 'http 192.0.2.66 funnel GET /_ignition/execute-solution 404')
  assert.equal(line('/oauth/authorize?state=SECRET'), 'http 192.0.2.66 funnel GET /oauth/authorize 404')
  assert.equal(line('/mcp/0123456789abcdef'), 'http 192.0.2.66 funnel GET /mcp/… 404')
  assert.equal(accessLine(req, { headersSent: false, writableFinished: false }, null, caller), 'http 192.0.2.66 funnel GET (no URL) - (aborted)')
})

// --- the throttle ----------------------------------------------------------------

test('the throttle: one message per kind and address, a cap per window; held ones are counted, and summarised later', async () => {
  const sent = []
  const alerts = new Alerts({
    send: async text => sent.push(text),
    log: quiet,
    perKeyMs: 400,
    windowMs: 1200,
    perWindow: 3,
    host: 'testhost',
  })
  const p = 'cc-voice-gateway on testhost: '
  const held = what => `\n\nNot reported one by one since the last message: ${what}. The gateway log has each of them.`
  try {
    alerts.notify('blocked', '203.0.113.1', 'one.')
    for (let i = 0; i < 5; i++) alerts.notify('blocked', '203.0.113.1', 'again.') // the same kind and address
    alerts.notify('token', '203.0.113.1', 'two.') // another kind
    alerts.notify('blocked', '203.0.113.2', 'three.') // another address; the window is full now
    alerts.notify('blocked', '203.0.113.3', 'four.')
    alerts.notify('accepted', '198.51.100.1', 'signed in.', { urgent: true }) // goes out all the same
    alerts.notify('wrong', '203.0.113.4', 'five.')
    alerts.notify('wrong', '203.0.113.5', 'six.')
    await alerts.queue
    assert.deepEqual(sent, [
      `${p}one.`,
      `${p}two.${held('5 voice requests from outside the allowed addresses, from 1 address')}`,
      `${p}three.`,
      `${p}signed in.${held('1 voice request from outside the allowed addresses, from 1 address')}`,
    ])

    // Once the window has room again, what was held comes in one summary.
    await waitFor(() => sent.length === 5, 4000)
    assert.equal(
      sent[4],
      `${p}more suspicious requests, not reported one by one: 2 wrong pairing codes, from 2 addresses. The gateway log has each of them.`,
    )
    await sleep(100)
    alerts.notify('blocked', '203.0.113.1', 'later.') // its quarter of an hour (here 400 ms) is over
    await alerts.queue
    assert.equal(sent.at(-1), `${p}later.`)
  } finally {
    alerts.close()
  }
})

test('the throttle without Telegram sends nothing, and a failing send is only logged', async () => {
  const silent = new Alerts({ log: quiet })
  silent.notify('blocked', '203.0.113.1', 'nobody hears this.')
  assert.equal(silent.timer, null)

  const logged = []
  const failing = new Alerts({
    send: async () => Promise.reject(new Error('503 Service Unavailable')),
    log: (...parts) => logged.push(parts.join(' ')),
    host: 'testhost',
  })
  failing.notify('blocked', '203.0.113.1', 'lost.')
  await failing.queue
  assert.deepEqual(logged, ['alert not sent by Telegram: cc-voice-gateway on testhost: lost. - 503 Service Unavailable'])
  failing.close()
})

// --- tokens ----------------------------------------------------------------------

test('Auth.verify tells missing, unknown and expired tokens apart; the client hears the same as before', () => {
  const auth = new Auth({ stateFile: join(TMP, 'verify', 'oauth.json'), allowedHosts: ['claude.ai'] })
  const req = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} })
  assert.deepEqual(auth.verify(req()), { error: 'missing', reason: 'missing' })
  assert.deepEqual(auth.verify(req('made-up')), { error: 'invalid_token', reason: 'unknown' })

  const { access_token: first } = auth.issueLocal('verify')
  const grant = auth.state.grants.at(-1)
  assert.equal(auth.verify(req(first)).grant, grant)
  // A refresh replaces the token; a late request with the old one is no stranger.
  const { access_token: second } = auth.issue(grant)
  assert.deepEqual(auth.verify(req(first)), { error: 'invalid_token', reason: 'expired' })
  assert.equal(auth.verify(req(second)).grant, grant)
  grant.accessExpiresAt = Date.now() - 1000
  assert.deepEqual(auth.verify(req(second)), { error: 'invalid_token', reason: 'expired' })
  // One refresh back only, and nothing once the connection is gone.
  auth.issue(grant)
  assert.deepEqual(auth.verify(req(first)), { error: 'invalid_token', reason: 'unknown' })
  auth.state.grants = []
  assert.deepEqual(auth.verify(req(second)), { error: 'invalid_token', reason: 'unknown' })
})

// --- the gateway as a whole --------------------------------------------------------

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

const EXPIRED = 'expired-access-token-of-a-known-connection'

async function startGateway(name, { telegram = false, env = {} } = {}) {
  const secrets = join(TMP, name)
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  if (telegram) {
    writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`, { mode: 0o600 })
    writeFileSync(join(secrets, 'telegram_chat_id'), CHAT_ID, { mode: 0o600 })
  }
  // A connection from an hour ago, whose access token has expired; its
  // refresh token still holds.
  const t = Date.now()
  const grant = {
    id: 'old001',
    clientId: 'someone',
    clientName: 'Claude',
    createdAt: t - 2 * 3600e3,
    accessHash: sha256(EXPIRED),
    accessExpiresAt: t - 60e3,
    refreshHash: sha256('a refresh token'),
    refreshExpiresAt: t + 24 * 3600e3,
  }
  writeFileSync(join(secrets, 'oauth.json'), JSON.stringify({ clients: {}, grants: [grant] }), { mode: 0o600 })

  const port = await freePort()
  const gw = { port, secrets, log: '', base: `http://127.0.0.1:${port}` }
  gw.child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: join(secrets, 'state'),
      VOICE_GW_WORKER_ROOT: join(secrets, 'no-repositories'),
      VOICE_GW_PORT: String(port),
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_TELEGRAM_API: api.url,
      VOICE_GW_CONTROLLER_LEVEL: 'confined',
      // Never the real Funnel.
      VOICE_GW_FUNNEL_IDLE: '0',
      VOICE_GW_FUNNEL_SCRIPT: join(secrets, 'no-funnel.sh'),
      VOICE_GW_MCP_ALLOW: '',
      ...env,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  gw.child.stderr.on('data', chunk => (gw.log += chunk))
  for (let i = 0; i < 100 && !gw.ready; i++) {
    gw.ready = await fetch(`${gw.base}/healthz`).then(res => res.ok, () => false)
    if (!gw.ready) await sleep(50)
  }
  if (!gw.ready) throw new Error(`gateway did not start:\n${gw.log}`)
  ;({ access_token: gw.token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name }))
  gw.mcp = (headers = {}) =>
    fetch(`${gw.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
  gw.request = (path, { headers = {}, form, json } = {}) => {
    const init = { method: 'GET', headers: { ...headers }, redirect: 'manual' }
    if (form) {
      init.method = 'POST'
      init.headers['content-type'] = 'application/x-www-form-urlencoded'
      init.body = new URLSearchParams(form).toString()
    }
    if (json) {
      init.method = 'POST'
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(json)
    }
    return fetch(`${gw.base}${path}`, init)
  }
  gw.stop = async () => {
    const exited = new Promise(resolve => gw.child.on('exit', resolve))
    gw.child.stdin.end()
    await exited
  }
  return gw
}

const ours = () => api.messages.filter(message => message.text.startsWith(PREFIX)).map(message => message.text)

// The access line comes when the response is closed, which can be just after
// the client has it.
async function logged(gateway, pattern) {
  await waitFor(() => pattern.test(gateway.log), 3000).catch(() => {})
  assert.match(gateway.log, pattern)
}

// The alerts go out in the order of the steps below: blocked, a missing
// token, a sign-in without a code, a wrong code, too many, and a successful
// sign-in. Five held back by the throttle, one urgent: within the cap of six
// an hour.
let gw

after(async () => {
  if (gw && gw.child.exitCode === null && gw.child.signalCode === null) await gw.stop()
})

test('the gateway: its start says which addresses may call /mcp', async () => {
  gw = await startGateway('main', { telegram: true })
  await logged(
    gw,
    /voice endpoint: \/mcp through the Funnel or a proxy only from 160\.79\.104\.0\/21 \(VOICE_GW_MCP_ALLOW\); suspicious requests reported on Telegram/,
  )
})

test('an address outside the range on /mcp: 403 before the token check, logged with the address, one alert', async () => {
  const blocked = await gw.mcp({ authorization: `Bearer ${gw.token}`, 'x-forwarded-for': '203.0.113.50', ...FUNNEL })
  assert.equal(blocked.status, 403, 'a valid token does not help')
  await waitFor(() => ours().length === 1)
  assert.equal(
    ours()[0],
    `${PREFIX}suspicious activity. A voice request (POST /mcp) came from 203.0.113.50, which is not one of ` +
      "Anthropic's addresses, and was blocked before its token was looked at. Claude voice mode calls only from Anthropic.",
  )
  await logged(gw, /voice 403: POST \/mcp from 203\.0\.113\.50 \(funnel\), not an allowed address/)
  await logged(gw, /http 203\.0\.113\.50 funnel POST \/mcp 403/)

  // Again from there, also with an Anthropic address forged in front: the
  // tunnel's entry, the last one, counts. Held back, not sent again.
  assert.equal((await gw.mcp({ 'x-forwarded-for': '203.0.113.50' })).status, 403)
  assert.equal((await gw.mcp({ 'x-forwarded-for': '160.79.106.9, 203.0.113.50', ...FUNNEL })).status, 403)
  await sleep(300)
  assert.equal(ours().length, 1)
})

test('local calls without X-Forwarded-For pass, and so do Anthropic addresses, IPv4-mapped too', async () => {
  const bearer = { authorization: `Bearer ${gw.token}` }
  assert.equal((await gw.mcp(bearer)).status, 200)
  assert.equal((await gw.mcp({ ...bearer, 'x-forwarded-for': '160.79.106.21', ...FUNNEL })).status, 200)
  assert.equal((await gw.mcp({ ...bearer, 'x-forwarded-for': '::ffff:160.79.106.20' })).status, 200)
  await logged(gw, /http 127\.0\.0\.1 local POST \/mcp 200/)
  await logged(gw, /http 160\.79\.106\.21 funnel POST \/mcp 200/)
  await logged(gw, /http ::ffff:160\.79\.106\.20 proxy POST \/mcp 200/)
  await sleep(200)
  assert.equal(ours().length, 1)
})

test('an Anthropic address without a token: the usual 401 challenge, logged, an alert that names both possibilities', async () => {
  const res = await gw.mcp({ 'x-forwarded-for': '160.79.106.30', ...FUNNEL })
  assert.equal(res.status, 401)
  const challenge = res.headers.get('www-authenticate')
  assert.match(challenge, /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/)
  assert.doesNotMatch(challenge, /invalid_token/)
  await waitFor(() => ours().length === 2)
  assert.equal(
    ours()[1],
    `${PREFIX}a voice request without a token came from 160.79.106.30, one of Anthropic's addresses, and was ` +
      "refused. Either you are connecting the connector (again), or someone else's Claude account found the " +
      'address. Without a pairing code from your computer nobody can sign in.\n\nNot reported one by one since the ' +
      'last message: 2 voice requests from outside the allowed addresses, from 1 address. The gateway log has each of them.',
  )
  await logged(gw, /voice 401 from 160\.79\.106\.30 \(funnel\): no token, the client has to sign in/)

  // An unknown token from the same address: invalid_token, as before; held back.
  const unknown = await gw.mcp({ authorization: 'Bearer made-up', 'x-forwarded-for': '160.79.106.30', ...FUNNEL })
  assert.equal(unknown.status, 401)
  assert.match(unknown.headers.get('www-authenticate'), /error="invalid_token"/)
  await logged(gw, /voice 401 from 160\.79\.106\.30 \(funnel\): unknown token/)
  // Local calls without a token are only logged.
  assert.equal((await gw.mcp()).status, 401)
  await sleep(300)
  assert.equal(ours().length, 2)
})

test('an expired token of a known connection, the hourly refresh: 401 as before, logged, no alert', async () => {
  const res = await gw.mcp({ authorization: `Bearer ${EXPIRED}`, 'x-forwarded-for': '160.79.106.31', ...FUNNEL })
  assert.equal(res.status, 401)
  assert.match(res.headers.get('www-authenticate'), /error="invalid_token"/)
  await logged(gw, /voice 401 from 160\.79\.106\.31 \(funnel\): expired token of a known connection, the client refreshes it/)
  await sleep(300)
  assert.equal(ours().length, 2)
})

async function register(name) {
  const res = await gw.request('/oauth/register', {
    json: { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', client_name: name },
  })
  return (await res.json()).client_id
}

const signIn = (clientId, pairingCode, address) =>
  gw.request('/oauth/authorize', {
    headers: { 'x-forwarded-for': address, ...FUNNEL },
    form: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 'st4te',
      pairing_code: pairingCode,
      action: 'connect',
    },
  })

test('the sign-in stays open to every address; each step goes to Telegram with the address', async () => {
  const stranger = await register('Stranger')
  // No pairing code issued yet.
  const early = await signIn(stranger, '12345678', '198.51.100.7')
  assert.equal(early.status, 200)
  assert.match(await early.text(), /Wrong or expired code/)
  await waitFor(() => ours().length === 3)
  assert.equal(
    ours()[2],
    `${PREFIX}a sign-in attempt from 198.51.100.7 (client "Stranger") while no pairing code is valid (none issued, ` +
      'or it expired); refused.\n\nNot reported one by one since the last message: 1 voice request without a valid ' +
      'token, from 1 address. The gateway log has each of them.',
  )

  const { code } = await adminRequest(join(gw.secrets, 'admin.sock'), 'POST', '/pairing')
  assert.equal((await signIn(stranger, '00000000', '198.51.100.7')).status, 200)
  await waitFor(() => ours().length === 4)
  assert.equal(ours()[3], `${PREFIX}wrong pairing code on the sign-in page from 198.51.100.7 (client "Stranger"); 4 attempts left there.`)

  // Four more wrong ones are held back; the sixth attempt is refused outright.
  for (let i = 0; i < 4; i++) await signIn(stranger, '00000000', '198.51.100.7')
  assert.equal((await signIn(stranger, code, '198.51.100.7')).status, 200)
  await waitFor(() => ours().length === 5)
  assert.equal(
    ours()[4],
    `${PREFIX}pairing code refused from 198.51.100.7 (client "Stranger"): too many wrong attempts from this client ` +
      'or address.\n\nNot reported one by one since the last message: 4 wrong pairing codes, from 1 address. The ' +
      'gateway log has each of them.',
  )

  // The driver signs in from their browser.
  const accepted = await signIn(await register('Claude'), code, '198.51.100.8')
  assert.equal(accepted.status, 302)
  await waitFor(() => ours().length === 6)
  assert.equal(
    ours()[5],
    `${PREFIX}signed in with the pairing code from 198.51.100.8 (client "Claude"). The connector gets its token next. ` +
      'If that was not you: node scripts/pair.mjs list, then revoke.',
  )
  await logged(gw, /oauth sign-in accepted for "Claude" from 198\.51\.100\.8/)
  assert.ok(!gw.log.includes(code.replace(' ', '')), 'the pairing code stays out of the log')
})

test('scanners on other paths: 404, a log line with the address, no alert; no query strings in the log', async () => {
  const before = api.messages.length
  const headers = { 'x-forwarded-for': '192.0.2.66', ...FUNNEL }
  assert.equal((await gw.request('/_ignition/execute-solution', { headers })).status, 404)
  assert.equal((await gw.request('/', { headers })).status, 404)
  assert.equal((await gw.request('/mcp/0123456789abcdef0123', { headers })).status, 404)
  assert.equal((await gw.request('/oauth/authorize?client_id=nobody&state=QUERY-SECRET', { headers })).status, 400)
  assert.equal((await gw.request('/healthz', { headers })).status, 200)
  await logged(gw, /http 192\.0\.2\.66 funnel GET \/_ignition\/execute-solution 404/)
  await logged(gw, /http 192\.0\.2\.66 funnel GET \/ 404/)
  await logged(gw, /http 192\.0\.2\.66 funnel GET \/mcp\/… 404/)
  await logged(gw, /http 192\.0\.2\.66 funnel GET \/oauth\/authorize 400/)
  await logged(gw, /http 192\.0\.2\.66 funnel GET \/healthz 200/)
  assert.ok(!gw.log.includes('QUERY-SECRET') && !gw.log.includes('0123456789abcdef0123'))
  assert.doesNotMatch(gw.log, /local GET \/healthz/, "the watchdog's checks stay out")
  await sleep(300)
  assert.equal(api.messages.length, before)
})

test('a request target that is no URL gets a 400, and the gateway goes on', async () => {
  const status = await new Promise((resolve, reject) => {
    const socket = connect(gw.port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'))
    socket.on('data', data => {
      resolve(String(data).split('\r\n')[0])
      socket.destroy()
    })
    socket.on('error', reject)
  })
  assert.equal(status, 'HTTP/1.1 400 Bad Request')
  assert.equal((await fetch(`${gw.base}/healthz`)).status, 200)
  await logged(gw, /http 127\.0\.0\.1 local GET \(no URL\) 400/)
  assert.ok(!gw.log.includes(TOKEN) && !gw.log.includes(gw.token), 'no token in the log')
  await gw.stop()
})

test('own ranges from VOICE_GW_MCP_ALLOW, a bad entry named in the log; without Telegram, only the log', async () => {
  const before = api.messages.length
  const own = await startGateway('own', { env: { VOICE_GW_MCP_ALLOW: '10.0.0.0/8, bogus' } })
  try {
    await logged(own, /VOICE_GW_MCP_ALLOW: "bogus" is not an address range; left out/)
    await logged(own, /only from 10\.0\.0\.0\/8 \(VOICE_GW_MCP_ALLOW\); suspicious requests only in the log/)
    const bearer = { authorization: `Bearer ${own.token}` }
    assert.equal((await own.mcp({ ...bearer, 'x-forwarded-for': '10.1.2.3' })).status, 200)
    assert.equal((await own.mcp({ ...bearer, 'x-forwarded-for': '160.79.106.3' })).status, 403)
    await logged(own, /voice 403: POST \/mcp from 160\.79\.106\.3 \(proxy\)/)
    await sleep(200)
    assert.equal(api.messages.length, before)
  } finally {
    await own.stop()
  }
})

test('VOICE_GW_MCP_ALLOW=any: /mcp from every address, the token still decides', async () => {
  const any = await startGateway('any', { env: { VOICE_GW_MCP_ALLOW: 'any' } })
  try {
    await logged(any, /voice endpoint: \/mcp from any address \(VOICE_GW_MCP_ALLOW=any\)/)
    assert.equal((await any.mcp({ authorization: `Bearer ${any.token}`, 'x-forwarded-for': '203.0.113.50' })).status, 200)
    assert.equal((await any.mcp({ 'x-forwarded-for': '203.0.113.50' })).status, 401)
  } finally {
    await any.stop()
  }
})
