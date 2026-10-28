// OAuth sign-in of the voice endpoint, the way Claude's connector goes through
// it: discovery after a 401, dynamic registration, the sign-in page with a
// pairing code, code exchange with PKCE, refresh, and revocation.
//
// Requests carry the headers Tailscale Funnel adds, so the gateway sees the
// same public origin as in real use.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminRequest } from '../src/admin.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const PAIR = fileURLToPath(new URL('../scripts/pair.mjs', import.meta.url))
const SECRETS = mkdtempSync(join(tmpdir(), 'voice-gw-oauth-'))
const ORIGIN = 'https://voice.example.ts.net'
const FORWARDED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'voice.example.ts.net' }
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

let port
let gateway
let gatewayLog = ''
let documents // serves client ID metadata documents on 127.0.0.1
let documentsPort

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

async function startGateway() {
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: SECRETS,
      VOICE_GW_PORT: String(port),
      VOICE_GW_LOG_FILE: '',
      // 127.0.0.1 only so the test can serve a client ID metadata document.
      VOICE_GW_OAUTH_HOSTS: 'claude.ai,claude.com,127.0.0.1',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  child.stderr.on('data', chunk => (gatewayLog += chunk))
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child
    } catch {
      await new Promise(r => setTimeout(r, 50))
    }
  }
  throw new Error('gateway did not start')
}

async function stopGateway(child) {
  const exited = new Promise(resolve => child.on('exit', resolve))
  child.stdin.end()
  await exited
}

before(async () => {
  port = await freePort()
  gateway = await startGateway()
  documents = createServer((req, res) => {
    const clientId = `http://127.0.0.1:${documentsPort}${req.url}`
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ client_id: clientId, client_name: 'Document client', redirect_uris: [CALLBACK] }))
  })
  await new Promise(resolve => documents.listen(0, '127.0.0.1', resolve))
  documentsPort = documents.address().port
})

after(async () => {
  if (gateway) await stopGateway(gateway)
  documents?.close()
  rmSync(SECRETS, { recursive: true, force: true })
})

// --- helpers ------------------------------------------------------------------

function request(path, { method = 'GET', headers = {}, form, json } = {}) {
  const init = { method, headers: { ...FORWARDED, ...headers }, redirect: 'manual' }
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
  return fetch(`http://127.0.0.1:${port}${path}`, init)
}

const admin = (method, path, body) => adminRequest(join(SECRETS, 'admin.sock'), method, path, body)

async function register(meta = {}) {
  const res = await request('/oauth/register', {
    json: { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', client_name: 'Claude', ...meta },
  })
  return { status: res.status, body: await res.json() }
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

function authorizeParams(clientId, challenge, extra = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st4te',
    resource: `${ORIGIN}/mcp`,
    ...extra,
  }
}

const authorizeUrl = params => `/oauth/authorize?${new URLSearchParams(params)}`

// Signs in with a fresh pairing code and returns the authorization code.
async function signIn(clientId, challenge) {
  const { code } = await admin('POST', '/pairing')
  const res = await request('/oauth/authorize', {
    form: { ...authorizeParams(clientId, challenge), pairing_code: code, action: 'connect' },
  })
  assert.equal(res.status, 302)
  const location = new URL(res.headers.get('location'))
  assert.equal(location.origin + location.pathname, CALLBACK)
  assert.equal(location.searchParams.get('state'), 'st4te')
  assert.equal(location.searchParams.get('iss'), ORIGIN)
  return location.searchParams.get('code')
}

async function token(form, headers = {}) {
  const res = await request('/oauth/token', { form: { resource: `${ORIGIN}/mcp`, ...form }, headers })
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }
}

async function connect(meta) {
  const { body: client } = await register(meta)
  const { verifier, challenge } = pkce()
  const code = await signIn(client.client_id, challenge)
  const { body } = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: CALLBACK,
  })
  return { client, tokens: body }
}

const mcpStatus = async accessToken =>
  (
    await request('/mcp', {
      json: { jsonrpc: '2.0', id: 1, method: 'ping' },
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream' },
    })
  ).status

// --- tests --------------------------------------------------------------------

test('discovery: the 401 points to the resource metadata, which points to this server', async () => {
  const res = await request('/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'ping' } })
  assert.equal(res.status, 401)
  assert.match(
    res.headers.get('www-authenticate'),
    new RegExp(`resource_metadata="${ORIGIN}/\\.well-known/oauth-protected-resource/mcp"`),
  )

  const resource = await (await request('/.well-known/oauth-protected-resource/mcp')).json()
  assert.equal(resource.resource, `${ORIGIN}/mcp`)
  assert.deepEqual(resource.authorization_servers, [ORIGIN])

  const server = await (await request('/.well-known/oauth-authorization-server')).json()
  assert.equal(server.issuer, ORIGIN)
  assert.equal(server.authorization_endpoint, `${ORIGIN}/oauth/authorize`)
  assert.equal(server.token_endpoint, `${ORIGIN}/oauth/token`)
  assert.equal(server.registration_endpoint, `${ORIGIN}/oauth/register`)
  assert.deepEqual(server.code_challenge_methods_supported, ['S256'])
})

test('behind a reverse proxy the public host comes from Host', async () => {
  // fetch() does not let the Host header through, so plain http.request.
  const metadata = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/.well-known/oauth-protected-resource',
        headers: { host: 'voice.example.com', 'x-forwarded-proto': 'https' },
      },
      res => {
        let data = ''
        res.on('data', chunk => (data += chunk))
        res.on('end', () => resolve(JSON.parse(data)))
      },
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(metadata.resource, 'https://voice.example.com/mcp')
  assert.deepEqual(metadata.authorization_servers, ['https://voice.example.com'])
})

test('registration accepts Claude and loopback return addresses, nothing else', async () => {
  assert.equal((await register({ redirect_uris: ['https://evil.example/callback'] })).status, 400)
  assert.equal((await register({ redirect_uris: ['http://claude.ai/api/mcp/auth_callback'] })).status, 400)
  assert.equal((await register({ redirect_uris: [] })).status, 400)

  const claude = await register()
  assert.equal(claude.status, 201)
  assert.ok(claude.body.client_id)
  assert.equal(claude.body.client_secret, undefined)

  const local = await register({ redirect_uris: ['http://127.0.0.1:33418/callback'] })
  assert.equal(local.status, 201)

  const confidential = await register({ token_endpoint_auth_method: 'client_secret_post' })
  assert.ok(confidential.body.client_secret)
})

test('sign-in page: shows who connects, needs a pairing code that works once', async () => {
  const { body: client } = await register({ client_name: '<Claude>' })
  const { verifier, challenge } = pkce()
  const params = authorizeParams(client.client_id, challenge)

  const pageRes = await request(authorizeUrl(params))
  assert.equal(pageRes.status, 200)
  assert.match(pageRes.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const html = await pageRes.text()
  assert.match(html, /<strong>&lt;Claude&gt;<\/strong>/)
  assert.match(html, /claude\.ai/)
  assert.match(html, /node scripts\/pair\.mjs/)

  const post = pairing_code => request('/oauth/authorize', { form: { ...params, pairing_code, action: 'connect' } })

  // No code issued yet: nothing to guess.
  assert.match(await (await post('12345678')).text(), /Wrong or expired code/)

  const { code: pairing } = await admin('POST', '/pairing')
  assert.match(pairing, /^\d{4} \d{4}$/)
  assert.match(await (await post('00000000')).text(), /Wrong or expired code/)
  const accepted = await post(pairing)
  assert.equal(accepted.status, 302)
  const code = new URL(accepted.headers.get('location')).searchParams.get('code')
  assert.equal((await post(pairing)).status, 200, 'a pairing code works for one sign-in only')

  const exchange = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: CALLBACK,
  })
  assert.equal(exchange.status, 200)
  assert.equal(exchange.body.token_type, 'Bearer')
  assert.equal(exchange.body.expires_in, 3600)
  assert.ok(exchange.body.refresh_token)
  assert.equal(exchange.cache, 'no-store')
  assert.equal(await mcpStatus(exchange.body.access_token), 200)
  assert.ok(!gatewayLog.includes(pairing.replace(' ', '')), 'pairing codes stay out of the log')
  assert.ok(!gatewayLog.includes(exchange.body.access_token), 'tokens stay out of the log')
})

test('five wrong pairing codes burn the code', async () => {
  const { body: client } = await register()
  const params = authorizeParams(client.client_id, pkce().challenge)
  const { code } = await admin('POST', '/pairing')
  for (let i = 0; i < 5; i++) {
    await request('/oauth/authorize', { form: { ...params, pairing_code: '99999999', action: 'connect' } })
  }
  const late = await request('/oauth/authorize', { form: { ...params, pairing_code: code, action: 'connect' } })
  assert.equal(late.status, 200)
  assert.match(await late.text(), /Wrong or expired code/)
})

test('authorization errors: a strange client stays on the page, the rest goes back to it', async () => {
  const { body: client } = await register()
  const { challenge } = pkce()

  const unknown = await request(authorizeUrl(authorizeParams('nobody', challenge)))
  assert.equal(unknown.status, 400)
  assert.match(await unknown.text(), /not registered/)
  const foreign = await request(
    authorizeUrl(authorizeParams(client.client_id, challenge, { redirect_uri: 'https://claude.ai/elsewhere' })),
  )
  assert.equal(foreign.status, 400)

  const backWith = async (extra, error) => {
    const res = await request(authorizeUrl(authorizeParams(client.client_id, challenge, extra)))
    assert.equal(res.status, 302)
    const location = new URL(res.headers.get('location'))
    assert.equal(location.searchParams.get('error'), error)
    assert.equal(location.searchParams.get('state'), 'st4te')
  }
  await backWith({ code_challenge: '' }, 'invalid_request')
  await backWith({ code_challenge_method: 'plain' }, 'invalid_request')
  await backWith({ response_type: 'token' }, 'unsupported_response_type')
  await backWith({ resource: 'https://other.example/mcp' }, 'invalid_target')

  const cancelled = await request('/oauth/authorize', {
    form: { ...authorizeParams(client.client_id, challenge), action: 'cancel' },
  })
  assert.equal(new URL(cancelled.headers.get('location')).searchParams.get('error'), 'access_denied')
})

test('code exchange: PKCE must match, and a code is good for one attempt', async () => {
  const { body: client } = await register()
  const { verifier, challenge } = pkce()
  const code = await signIn(client.client_id, challenge)
  const exchange = code_verifier =>
    token({ grant_type: 'authorization_code', code, code_verifier, client_id: client.client_id })

  const wrong = await exchange(pkce().verifier)
  assert.equal(wrong.status, 400)
  assert.equal(wrong.body.error, 'invalid_grant')
  assert.equal((await exchange(verifier)).body.error, 'invalid_grant', 'the failed attempt used up the code')
})

test('confidential clients have to authenticate at the token endpoint', async () => {
  const { body: client } = await register({ token_endpoint_auth_method: 'client_secret_basic' })
  const { verifier, challenge } = pkce()
  const code = await signIn(client.client_id, challenge)
  const form = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id }

  const anonymous = await token(form)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.body.error, 'invalid_client')

  const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')
  const authenticated = await token(form, { authorization: `Basic ${basic}` })
  assert.equal(authenticated.status, 200, 'a failed client authentication does not use up the code')
})

test('refresh rotates both tokens; revoking ends the connection', async () => {
  const { client, tokens } = await connect({ client_name: 'Rotating' })
  const refreshed = await token({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  })
  assert.equal(refreshed.status, 200)
  assert.notEqual(refreshed.body.refresh_token, tokens.refresh_token)
  assert.equal(await mcpStatus(tokens.access_token), 401, 'the old access token is replaced')
  assert.equal(await mcpStatus(refreshed.body.access_token), 200)

  const replay = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })
  assert.equal(replay.body.error, 'invalid_grant')

  const grant = (await admin('GET', '/grants')).find(g => g.client === 'Rotating')
  assert.ok(grant.lastUsedAt)
  assert.deepEqual(await admin('POST', '/revoke', { id: grant.id }), { revoked: 1 })
  assert.equal(await mcpStatus(refreshed.body.access_token), 401)
})

test('connections survive a gateway restart; the state file holds hashes only', async () => {
  const { tokens } = await connect({ client_name: 'Survivor' })
  await stopGateway(gateway)
  gateway = await startGateway()
  assert.equal(await mcpStatus(tokens.access_token), 200)

  const file = join(SECRETS, 'oauth.json')
  const stored = readFileSync(file, 'utf8')
  assert.ok(!stored.includes(tokens.access_token))
  assert.ok(!stored.includes(tokens.refresh_token))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(SECRETS, 'admin.sock')).mode & 0o777, 0o600)
})

test('client ID metadata documents: used from allowed hosts only', async () => {
  const clientId = `http://127.0.0.1:${documentsPort}/client.json`
  const { verifier, challenge } = pkce()
  const page = await request(authorizeUrl(authorizeParams(clientId, challenge)))
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Document client/)

  const code = await signIn(clientId, challenge)
  const exchange = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })
  assert.equal(exchange.status, 200)

  const elsewhere = await request(authorizeUrl(authorizeParams('https://evil.example/client.json', challenge)))
  assert.equal(elsewhere.status, 400)
  assert.match(gatewayLog, /client id document not allowed: https:\/\/evil\.example\/client\.json/)
})

test('pair.mjs prints a code, lists and revokes connections', async () => {
  const env = { ...process.env, VOICE_GW_SECRETS_DIR: SECRETS }
  const run = (...args) => execFileSync(process.execPath, [PAIR, ...args], { env, encoding: 'utf8' })
  assert.match(run(), /^Pairing code: \d{4} \d{4}\n/)
  assert.match(run('list'), /Survivor/)
  assert.match(run('revoke', 'all'), /^Revoked \d+\./)
  assert.match(run('list'), /^No connections\./)
})
