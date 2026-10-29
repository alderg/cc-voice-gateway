// OAuth sign-in for the voice endpoint.
//
// The gateway is its own authorization server, so the connector in the Claude
// app is added with "Sign in" and no secret ever appears in its URL. Signing in
// needs a pairing code that `node scripts/pair.mjs` shows on this computer; it
// is valid for five minutes and one sign-in. Claude's servers then hold an
// access token for an hour and a refresh token that rotates on every use. Each
// sign-in is one grant that can be listed and revoked.
//
// What MCP clients use (MCP authorization spec):
//   /.well-known/oauth-protected-resource[/mcp]   resource metadata, RFC 9728
//   /.well-known/oauth-authorization-server        server metadata, RFC 8414
//   /oauth/register                                dynamic client registration, RFC 7591
//   /oauth/authorize                               sign-in page, authorization code with PKCE (S256)
//   /oauth/token                                   code exchange and refresh
// A client may also identify itself with a client ID metadata document (an
// HTTPS URL as client_id), but only on the allowed hosts.
//
// Tokens and client secrets are stored as SHA-256 hashes in .secrets/oauth.json,
// which only this process writes. Comparing hashes of random tokens is safe
// against timing attacks, so plain === is enough.
//
// Every step of a sign-in with a pairing code is also an event, 'pairing', for
// the alerts on Telegram (ipguard.mjs).

import { createHash, randomBytes, randomInt } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readBody, sendJson } from './http.mjs'
import { log, preview } from './log.mjs'

const ACCESS_TTL_S = 60 * 60
const REFRESH_TTL_S = 30 * 24 * 60 * 60
const LOCAL_TTL_S = 12 * 60 * 60
const CODE_TTL_MS = 5 * 60 * 1000
const PAIRING_TTL_MS = 5 * 60 * 1000
const PAIRING_ATTEMPTS = 5 // wrong ones per client and per address
const PAIRING_ATTEMPTS_TOTAL = 20 // wrong ones in all; then the code is burnt
const MAX_CLIENTS = 100
const MAX_FORM_BYTES = 64 * 1024
const SCOPE = 'mcp'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' }

const random = (bytes = 32) => randomBytes(bytes).toString('base64url')
const grantId = () => randomBytes(3).toString('hex') // short enough to type for revoke
const sha256 = value => createHash('sha256').update(value).digest('hex')
const now = () => Date.now()

// The public origin as the client sees it, from the headers that the tunnel or
// reverse proxy in front sets. Tailscale Funnel sets X-Forwarded-Proto and
// X-Forwarded-Host and overwrites what a client sends.
export function publicOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || ''
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  try {
    if (/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return new URL(`${proto}://${host}`).origin
  } catch {
    // fall through
  }
  return 'http://localhost'
}

const loopback = address => /^(127\.|::1$|::ffff:127\.)/.test(address)

// The address a request came from, for counting wrong pairing codes. The
// gateway listens on loopback, and the tunnel or reverse proxy on this
// computer connects from there: then the client's address is the last entry
// of X-Forwarded-For, the one that proxy added. Anything else counts by the
// address of the connection itself, which a client cannot choose.
export function clientAddress(req) {
  const peer = req.socket?.remoteAddress ?? '?'
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .at(-1)
  return preview(forwarded && loopback(peer) ? forwarded : peer, 64)
}

function sameResource(resource, origin) {
  try {
    const url = new URL(resource)
    const path = url.pathname.replace(/\/+$/, '')
    return url.origin === origin && (path === '' || path === '/mcp') && !url.search
  } catch {
    return false
  }
}

function withParams(uri, params) {
  const url = new URL(uri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value)
  }
  return url.href
}

function redirect(res, location) {
  res.writeHead(302, { location, ...NO_STORE }).end()
}

async function readParams(req) {
  const body = await readBody(req, MAX_FORM_BYTES)
  if (/^application\/json/i.test(req.headers['content-type'] ?? '')) {
    const json = JSON.parse(body || '{}')
    return new URLSearchParams(Object.entries(json).map(([key, value]) => [key, String(value)]))
  }
  return new URLSearchParams(body)
}

export class Auth extends EventEmitter {
  constructor({ stateFile, allowedHosts }) {
    super()
    this.stateFile = stateFile
    // Hosts allowed in redirect URIs and client ID metadata documents.
    this.allowedHosts = allowedHosts
    this.codes = new Map() // hash -> authorization code waiting for the token request
    this.pairing = null
    this.documents = new Map() // client ID metadata documents, cached briefly
    this.state = this.load()
  }

  // --- state --------------------------------------------------------------

  load() {
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      return { clients: data.clients ?? {}, grants: data.grants ?? [] }
    } catch (error) {
      if (error.code !== 'ENOENT') log('oauth state unreadable, starting empty:', error.message)
      return { clients: {}, grants: [] }
    }
  }

  save() {
    const t = now()
    this.state.grants = this.state.grants.filter(g => (g.refreshExpiresAt ?? g.accessExpiresAt) > t)
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    const tmp = `${this.stateFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.stateFile)
  }

  // --- pairing codes (admin socket) ---------------------------------------

  newPairingCode() {
    const code = String(randomInt(0, 1e8)).padStart(8, '0')
    this.pairing = {
      hash: sha256(code),
      expiresAt: now() + PAIRING_TTL_MS,
      wrong: { total: 0, clients: new Map(), addresses: new Map() },
    }
    log('oauth pairing code issued')
    return { code: `${code.slice(0, 4)} ${code.slice(4)}`, expiresIn: PAIRING_TTL_MS / 1000 }
  }

  // One code, one sign-in, a few attempts: guessing 8 digits is hopeless.
  // Wrong attempts count per client and per address, so that a stranger, who
  // can register a client of their own, locks out only themselves; after
  // PAIRING_ATTEMPTS_TOTAL wrong ones from anywhere the code is burnt. A client
  // ID metadata document is public, anyone can name it, so such a client
  // counts by address only: nobody can lock out Claude's published identity.
  checkPairingCode(input, { clientId = null, clientName = null, address = '?' } = {}) {
    const pairing = this.pairing
    const event = { address, client: clientName }
    if (!pairing || pairing.expiresAt < now()) {
      this.pairing = null
      log(`oauth sign-in without a valid pairing code from ${address}`)
      this.report({ outcome: 'none', ...event })
      return false
    }
    const { wrong } = pairing
    const client = clientId && !/^https?:\/\//.test(clientId) ? clientId : null
    const count = (map, key) => (key === null ? 0 : (map.get(key) ?? 0))
    if (count(wrong.clients, client) >= PAIRING_ATTEMPTS || count(wrong.addresses, address) >= PAIRING_ATTEMPTS) {
      log(`oauth pairing code refused for ${address}: too many wrong attempts from this client or address`)
      this.report({ outcome: 'refused', ...event })
      return false
    }
    if (sha256(String(input ?? '').replace(/[\s-]/g, '')) === pairing.hash) {
      this.pairing = null
      return true
    }
    if (client !== null) wrong.clients.set(client, count(wrong.clients, client) + 1)
    wrong.addresses.set(address, count(wrong.addresses, address) + 1)
    wrong.total += 1
    if (wrong.total >= PAIRING_ATTEMPTS_TOTAL) {
      this.pairing = null
      log(`oauth wrong pairing code from ${address}; ${wrong.total} wrong attempts in all, the code is burnt`)
      this.report({ outcome: 'burnt', total: wrong.total, ...event })
      return false
    }
    const left = PAIRING_ATTEMPTS - Math.max(count(wrong.clients, client), count(wrong.addresses, address))
    log(`oauth wrong pairing code from ${address}, ${left} attempts left there`)
    this.report({ outcome: 'wrong', left, ...event })
    return false
  }

  // A listener's error must not fail the sign-in.
  report(event) {
    try {
      this.emit('pairing', event)
    } catch (error) {
      log('oauth sign-in event not handled:', error.message)
    }
  }

  // --- grants (admin socket) ----------------------------------------------

  listGrants() {
    return this.state.grants.map(g => ({
      id: g.id,
      client: g.clientName,
      createdAt: g.createdAt,
      lastUsedAt: g.lastUsedAt ?? null,
      expiresAt: g.refreshExpiresAt ?? g.accessExpiresAt,
    }))
  }

  revoke(id) {
    const before = this.state.grants.length
    this.state.grants = this.state.grants.filter(g => id !== 'all' && g.id !== id)
    const revoked = before - this.state.grants.length
    if (revoked) {
      this.save()
      log('oauth revoked', id === 'all' ? 'all grants' : `grant=${id}`)
    }
    return revoked
  }

  // A token for local tools such as fake-voice, without the sign-in page.
  // Whoever can reach the admin socket could get a pairing code anyway.
  issueLocal(name) {
    const grant = { id: grantId(), clientId: 'local', clientName: preview(String(name || 'local'), 40), createdAt: now() }
    const tokens = this.issue(grant, { refresh: false, ttl: LOCAL_TTL_S })
    this.state.grants.push(grant)
    this.save()
    return tokens
  }

  issue(grant, { refresh = true, ttl = ACCESS_TTL_S } = {}) {
    const access = random()
    // The token it replaces, so that a late request with it counts as the
    // refresh it is, not as a stranger's token (verify).
    if (grant.accessHash) grant.previousAccessHash = grant.accessHash
    grant.accessHash = sha256(access)
    grant.accessExpiresAt = now() + ttl * 1000
    const tokens = { access_token: access, token_type: 'Bearer', expires_in: ttl, scope: SCOPE }
    if (refresh) {
      const refreshToken = random()
      grant.refreshHash = sha256(refreshToken)
      grant.refreshExpiresAt = now() + REFRESH_TTL_S * 1000
      tokens.refresh_token = refreshToken
    }
    return tokens
  }

  // --- the protected resource ---------------------------------------------

  // { grant }, or { error, reason }. error is what the client hears (missing or
  // invalid_token); reason tells the log and the alerts more: missing, unknown,
  // or expired, an expired or replaced token of a connection known here, as
  // with every hourly refresh.
  verify(req) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
    if (!match) return { error: 'missing', reason: 'missing' }
    const hash = sha256(match[1])
    const grant = this.state.grants.find(g => g.accessHash === hash)
    if (!grant || grant.accessExpiresAt < now()) {
      const known = grant ?? this.state.grants.find(g => g.previousAccessHash === hash)
      return { error: 'invalid_token', reason: known ? 'expired' : 'unknown' }
    }
    grant.lastUsedAt = now()
    return { grant }
  }

  // 401 that tells the client where to sign in.
  challenge(res, req, error) {
    const origin = publicOrigin(req)
    const params = [`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`, `scope="${SCOPE}"`]
    if (error === 'invalid_token') params.unshift('error="invalid_token"')
    sendJson(
      res,
      401,
      { error: error === 'invalid_token' ? 'invalid_token' : 'unauthorized', error_description: 'Sign in again.' },
      { 'www-authenticate': `Bearer ${params.join(', ')}` },
    )
  }

  // --- clients ------------------------------------------------------------

  hostAllowed(url) {
    return this.allowedHosts.includes(url.host) || this.allowedHosts.includes(url.hostname)
  }

  // HTTPS on an allowed host, or any loopback address for apps on the same
  // device (RFC 8252): a code sent there stays on the signing-in device.
  redirectAllowed(uri) {
    let url
    try {
      url = new URL(uri)
    } catch {
      return false
    }
    if (url.hash) return false
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return true
    return url.protocol === 'https:' && this.hostAllowed(url)
  }

  async client(clientId) {
    if (typeof clientId !== 'string' || !clientId) return null
    if (/^https?:\/\//.test(clientId)) return this.documentClient(clientId)
    return this.state.clients[clientId] ?? null
  }

  // Client ID metadata document: the client_id is a URL that returns the
  // client's metadata. Fetched only from allowed hosts, so the gateway cannot
  // be made to request arbitrary addresses.
  async documentClient(clientId) {
    let url
    try {
      url = new URL(clientId)
    } catch {
      return null
    }
    const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    if (!this.hostAllowed(url) || (url.protocol !== 'https:' && !loopbackHttp)) {
      log('oauth client id document not allowed:', preview(clientId, 120))
      return null
    }
    const cached = this.documents.get(clientId)
    if (cached && cached.expiresAt > now()) return cached.client
    try {
      const res = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      const body = await res.text()
      if (!res.ok || body.length > MAX_FORM_BYTES) throw new Error(`HTTP ${res.status}, ${body.length} bytes`)
      const doc = JSON.parse(body)
      if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) {
        throw new Error('client_id or redirect_uris do not match')
      }
      const client = {
        clientId,
        name: preview(String(doc.client_name || url.host), 80),
        redirectUris: doc.redirect_uris.filter(uri => typeof uri === 'string' && this.redirectAllowed(uri)),
        authMethod: 'none',
      }
      this.documents.set(clientId, { client, expiresAt: now() + 10 * 60 * 1000 })
      return client
    } catch (error) {
      log('oauth client id document unusable:', preview(clientId, 120), error.message)
      return null
    }
  }

  register(body) {
    const uris = body?.redirect_uris
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > 5 ||
      !uris.every(uri => typeof uri === 'string' && this.redirectAllowed(uri))
    ) {
      log('oauth registration refused, redirect URIs:', preview(JSON.stringify(uris ?? null), 120))
      return {
        status: 400,
        body: {
          error: 'invalid_redirect_uri',
          error_description: `Redirect URIs must use HTTPS on ${this.allowedHosts.join(', ')}, or a loopback address.`,
        },
      }
    }
    // RFC 7591: without a method the client expects a secret (client_secret_basic).
    const authMethod = body.token_endpoint_auth_method ?? 'client_secret_basic'
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(authMethod)) {
      return { status: 400, body: { error: 'invalid_client_metadata', error_description: `Unsupported ${authMethod}.` } }
    }
    const secret = authMethod === 'none' ? null : random()
    const client = {
      clientId: random(16),
      name: preview(String(body.client_name || 'Unnamed client'), 80),
      redirectUris: uris,
      authMethod,
      secretHash: secret ? sha256(secret) : null,
      createdAt: now(),
    }
    this.state.clients[client.clientId] = client
    this.pruneClients()
    this.save()
    log('oauth registered', JSON.stringify(client.name), `redirect=${uris.map(uri => new URL(uri).host).join(',')}`)
    return {
      status: 201,
      body: {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: authMethod,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      },
    }
  }

  // Registration is open to anyone on the internet, so the list must not grow
  // without bound. Clients that hold a grant are kept.
  pruneClients() {
    const ids = Object.keys(this.state.clients)
    if (ids.length <= MAX_CLIENTS) return
    const inUse = new Set(this.state.grants.map(g => g.clientId))
    const unused = ids
      .filter(id => !inUse.has(id))
      .sort((a, b) => this.state.clients[a].createdAt - this.state.clients[b].createdAt)
    for (const id of unused.slice(0, ids.length - MAX_CLIENTS)) delete this.state.clients[id]
  }

  // --- authorization ------------------------------------------------------

  // Checks an authorization request. Problems with the client or its redirect
  // URI are shown on the page; everything else goes back to the client.
  async checkAuthorization(params, origin) {
    const client = await this.client(params.get('client_id'))
    if (!client) return { problem: 'This app is not registered here. Remove the connector and add it again.' }
    const redirectUri = params.get('redirect_uri')
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { problem: 'The return address does not belong to this app.' }
    }
    const state = params.get('state')
    const fail = (error, description) => ({
      failed: withParams(redirectUri, { error, error_description: description, state, iss: origin }),
    })
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only code is supported.')
    if (!params.get('code_challenge') || params.get('code_challenge_method') !== 'S256') {
      return fail('invalid_request', 'PKCE with S256 is required.')
    }
    const resource = params.get('resource')
    if (resource && !sameResource(resource, origin)) return fail('invalid_target', 'Unknown resource.')
    return { client, redirectUri, state, codeChallenge: params.get('code_challenge') }
  }

  async authorize(req, res, url) {
    const origin = publicOrigin(req)
    const params = req.method === 'POST' ? await readParams(req) : url.searchParams
    const checked = await this.checkAuthorization(params, origin)
    if (checked.problem) {
      log('oauth sign-in refused:', checked.problem)
      sendPage(res, 400, messagePage(checked.problem))
      return
    }
    if (checked.failed) {
      redirect(res, checked.failed)
      return
    }
    const { client, redirectUri, state } = checked
    if (req.method === 'GET') {
      log('oauth sign-in page for', JSON.stringify(client.name))
      sendPage(res, 200, signInPage(params, client, origin))
      return
    }
    if (params.get('action') === 'cancel') {
      log('oauth sign-in cancelled for', JSON.stringify(client.name))
      redirect(res, withParams(redirectUri, { error: 'access_denied', state, iss: origin }))
      return
    }
    const address = clientAddress(req)
    if (!this.checkPairingCode(params.get('pairing_code'), { clientId: client.clientId, clientName: client.name, address })) {
      sendPage(res, 200, signInPage(params, client, origin, 'Wrong or expired code. Run node scripts/pair.mjs again.'))
      return
    }
    const code = random()
    this.dropExpiredCodes()
    this.codes.set(sha256(code), {
      clientId: client.clientId,
      clientName: client.name,
      redirectUri,
      codeChallenge: checked.codeChallenge,
      expiresAt: now() + CODE_TTL_MS,
    })
    log('oauth sign-in accepted for', JSON.stringify(client.name), `from ${address}`)
    this.report({ outcome: 'accepted', address, client: client.name })
    redirect(res, withParams(redirectUri, { code, state, iss: origin }))
  }

  dropExpiredCodes() {
    for (const [hash, entry] of this.codes) if (entry.expiresAt < now()) this.codes.delete(hash)
  }

  // --- token endpoint -----------------------------------------------------

  async token(req, res) {
    const origin = publicOrigin(req)
    const params = await readParams(req)
    const fail = (status, error, description) => {
      log('oauth token refused:', error, description)
      sendJson(res, status, { error, error_description: description }, NO_STORE)
    }

    let clientId = params.get('client_id')
    let secret = params.get('client_secret')
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '')
    if (basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      try {
        clientId = decodeURIComponent(decoded.slice(0, colon))
        secret = decodeURIComponent(decoded.slice(colon + 1))
      } catch {
        return fail(401, 'invalid_client', 'Malformed client credentials.')
      }
    }
    const client = await this.client(clientId)
    if (!client) return fail(401, 'invalid_client', 'Unknown client.')
    if (client.authMethod !== 'none' && !(secret && sha256(secret) === client.secretHash)) {
      return fail(401, 'invalid_client', 'Client authentication failed.')
    }
    const resource = params.get('resource')
    if (resource && !sameResource(resource, origin)) return fail(400, 'invalid_target', 'Unknown resource.')

    const grantType = params.get('grant_type')
    if (grantType === 'authorization_code') {
      const hash = sha256(params.get('code') ?? '')
      const entry = this.codes.get(hash)
      this.codes.delete(hash) // one attempt per code
      if (!entry || entry.expiresAt < now() || entry.clientId !== client.clientId) {
        return fail(400, 'invalid_grant', 'Unknown or expired code.')
      }
      const redirectUri = params.get('redirect_uri')
      if (redirectUri && redirectUri !== entry.redirectUri) return fail(400, 'invalid_grant', 'redirect_uri differs.')
      const verifier = params.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || challenge !== entry.codeChallenge) {
        return fail(400, 'invalid_grant', 'PKCE verification failed.')
      }
      const grant = { id: grantId(), clientId: client.clientId, clientName: entry.clientName, createdAt: now() }
      const tokens = this.issue(grant)
      this.state.grants.push(grant)
      this.save()
      log('oauth connected', JSON.stringify(grant.clientName), `grant=${grant.id}`)
      sendJson(res, 200, tokens, NO_STORE)
      return
    }
    if (grantType === 'refresh_token') {
      const hash = sha256(params.get('refresh_token') ?? '')
      const grant = this.state.grants.find(g => g.refreshHash === hash)
      if (!grant || grant.refreshExpiresAt < now() || grant.clientId !== client.clientId) {
        return fail(400, 'invalid_grant', 'Unknown or expired refresh token.')
      }
      const tokens = this.issue(grant)
      this.save()
      log('oauth token refreshed', `grant=${grant.id}`)
      sendJson(res, 200, tokens, NO_STORE)
      return
    }
    fail(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.')
  }

  // --- routing ------------------------------------------------------------

  // Returns true if the request was an OAuth request and has been answered.
  async handle(req, res, url) {
    const origin = publicOrigin(req)
    const only = method => {
      if (req.method === method) return true
      res.writeHead(405, { allow: method }).end()
      return false
    }
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        log('oauth discovery', url.pathname)
        sendJson(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: [SCOPE],
          bearer_methods_supported: ['header'],
          resource_name: 'Claude Code voice gateway',
        })
        return true
      case '/.well-known/oauth-authorization-server':
        log('oauth discovery', url.pathname)
        sendJson(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          scopes_supported: [SCOPE],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        })
        return true
      case '/oauth/register': {
        if (!only('POST')) return true
        let body
        try {
          body = JSON.parse(await readBody(req, MAX_FORM_BYTES))
        } catch {
          sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'JSON body expected.' })
          return true
        }
        const result = this.register(body)
        sendJson(res, result.status, result.body, NO_STORE)
        return true
      }
      case '/oauth/authorize':
        if (req.method !== 'GET' && req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' }).end()
          return true
        }
        await this.authorize(req, res, url)
        return true
      case '/oauth/token':
        if (!only('POST')) return true
        await this.token(req, res)
        return true
      default:
        return false
    }
  }
}

// --- pages ------------------------------------------------------------------

const escapeHtml = value =>
  String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const AUTHORIZE_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
]

function signInPage(params, client, origin, error) {
  const hidden = AUTHORIZE_FIELDS.filter(name => params.get(name) !== null)
    .map(name => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name))}">`)
    .join('\n      ')
  const returnHost = new URL(params.get('redirect_uri')).host
  return page(`
    <h1>Connect to Claude Code</h1>
    <p><strong>${escapeHtml(client.name)}</strong> wants to use Claude Code on
      <strong>${escapeHtml(new URL(origin).hostname)}</strong>. Afterwards you return to ${escapeHtml(returnHost)}.</p>
    <p>On that computer, run <code>node scripts/pair.mjs</code> in the cc-voice-gateway folder and enter the code
      it shows. The code is valid for five minutes.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="code">Pairing code</label>
      <input id="code" name="pairing_code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
      <div class="buttons">
        <button name="action" value="connect">Connect</button>
        <button name="action" value="cancel" formnovalidate class="secondary">Cancel</button>
      </div>
    </form>`)
}

function messagePage(message) {
  return page(`
    <h1>Cannot connect</h1>
    <p class="error">${escapeHtml(message)}</p>`)
}

function page(body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Connect to Claude Code</title>
<style>
  :root { --bg: #fafaf7; --fg: #1f1e1d; --muted: #6b6a68; --line: #d9d7d0; --accent: #c96442; --error: #b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1f1e1d; --fg: #f0eee6; --muted: #a6a39b; --line: #3d3c39; --accent: #d97757; --error: #f2b8b5; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  code { font-size: 0.95em; }
  .error { color: var(--error); }
  label { display: block; font-weight: 600; margin-bottom: 0.4rem; }
  input { box-sizing: border-box; width: 100%; font: inherit; font-size: 1.4rem; letter-spacing: 0.15em;
    padding: 0.6rem 0.8rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  .buttons { display: flex; gap: 0.75rem; margin-top: 1rem; }
  button { flex: 1; font: inherit; font-weight: 600; padding: 0.7rem; border-radius: 8px; border: 1px solid var(--accent);
    background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
</style>
</head>
<body><main>${body}
</main></body>
</html>
`
}

// The form posts back to this server, which then redirects to the client; a
// form-action directive would block that redirect in some browsers.
function sendPage(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...NO_STORE,
  })
  res.end(html)
}
