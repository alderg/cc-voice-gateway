// The setup assistant's HTTP server (scripts/setup.mjs): a temporary page in
// the browser that sets up the gateway on this computer. It may listen on
// every interface, for headless servers, so access is guarded:
//
// - A one-time token in the URL, long and random, shown only in the terminal
//   and compared in constant time. Its first use binds the setup to that
//   browser with an HttpOnly, SameSite=Strict session cookie and spends the
//   token: the URL alone no longer opens it.
// - Wrong tokens are rate-limited, per address and in total.
// - Every write request must come from the page's own origin.
// - It ends by itself after an overall and an idle timeout, after finishing,
//   and on cancel.
//
// Neither the token nor any secret entered on the page reaches a log line,
// the terminal or a response. Request URLs are never printed.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UI = join(dirname(fileURLToPath(import.meta.url)), 'ui')
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
}

export const COOKIE = 'voice_setup'
const MAX_BODY = 64 * 1024
const FAIL_WINDOW_MS = 10 * 60 * 1000
const FAILS_PER_ADDRESS = 5
const FAILS_IN_TOTAL = 30

const sha256 = text => createHash('sha256').update(String(text)).digest()

// Constant time, whatever the lengths: both sides are hashed first.
export function sameSecret(given, expected) {
  return timingSafeEqual(sha256(given), sha256(expected))
}

export const newToken = () => randomBytes(32).toString('base64url')

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

const PAGES = {
  401: 'Open the setup link shown in the terminal where the setup assistant runs.',
  403: 'This link is not valid, or it was already used in another browser. Start the setup assistant again for a new link.',
  429: 'Too many wrong links. Wait a few minutes, or start the setup assistant again.',
}

function page(res, status) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' })
  res.end(`${PAGES[status]}\n`)
}

function json(res, status, data) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request too large'), { status: 413 }))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(Object.assign(new Error('not JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function cookies(req) {
  const found = {}
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) found[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return found
}

// options:
//   token          the one-time token (default: a new one)
//   host, port     where to listen (port 0: any free one)
//   timeoutMs      overall time before the server ends
//   idleMs         time without a request from the page before it ends
//   api            { 'GET /api/state': async ({ body, server }) => data, ... };
//                  a handler may throw an error with .status and a message
//                  that is safe to show
//   redact         text -> text without any secret, for error messages
//   say            a line for the terminal, never with a secret
//   now            for tests
export async function startSetupServer({
  token = newToken(),
  host = '0.0.0.0',
  port = 8790,
  timeoutMs = 30 * 60 * 1000,
  idleMs = 10 * 60 * 1000,
  api = {},
  redact = text => text,
  say = () => {},
}) {
  const state = {
    used: false, // the token was spent
    session: null, // sha256 of the session cookie's value
    origin: null, // the page's origin, from the request that spent the token
    fails: new Map(), // address -> times of wrong tokens
    allFails: [],
    lastSeen: Date.now(),
  }
  const startedAt = Date.now()
  let resolveDone
  const done = new Promise(resolve => (resolveDone = resolve))
  let timers = []
  let ending = null

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) json(res, error.status ?? 500, { error: redact(error.message ?? 'failed') })
      else res.end()
    })
  })

  function stop(reason) {
    if (ending) return ending
    ending = new Promise(resolve => {
      for (const timer of timers) clearTimeout(timer)
      server.close(() => resolve())
      server.closeAllConnections?.()
    }).then(() => {
      say(`setup assistant ended: ${reason}`)
      resolveDone(reason)
    })
    return ending
  }

  function armIdle() {
    clearTimeout(timers[1])
    timers[1] = setTimeout(() => stop(`no activity for ${Math.round(idleMs / 60000)} minutes`), idleMs)
  }

  const recent = list => list.filter(at => Date.now() - at < FAIL_WINDOW_MS)
  function limited(address) {
    state.allFails = recent(state.allFails)
    return recent(state.fails.get(address) ?? []).length >= FAILS_PER_ADDRESS || state.allFails.length >= FAILS_IN_TOTAL
  }
  function failed(address) {
    state.fails.set(address, [...recent(state.fails.get(address) ?? []), Date.now()])
    state.allFails.push(Date.now())
    say(`setup assistant: a wrong or used link from ${address}`)
  }

  function signedIn(req) {
    const value = cookies(req)[COOKIE]
    return Boolean(state.session && value && timingSafeEqual(sha256(value), state.session))
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://setup.invalid')
    const address = req.socket.remoteAddress ?? '?'

    if (!signedIn(req)) {
      const given = url.searchParams.get('t')
      if (req.method !== 'GET' || url.pathname !== '/' || given === null) return page(res, 401)
      if (limited(address)) return page(res, 429)
      if (state.used || !sameSecret(given, token)) {
        failed(address)
        return page(res, 403)
      }
      // The token is spent; from now on only this browser's cookie counts.
      state.used = true
      const session = randomBytes(32).toString('base64url')
      state.session = sha256(session)
      state.origin = `http://${req.headers.host}`
      say(`setup assistant: opened in a browser at ${address}; the link no longer works elsewhere`)
      res.writeHead(303, {
        ...HEADERS,
        location: '/',
        'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      })
      return res.end()
    }

    state.lastSeen = Date.now()
    armIdle()

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Write requests only from the page itself.
      if (req.headers.origin !== state.origin) return json(res, 403, { error: 'wrong origin' })
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return json(res, 415, { error: 'JSON only' })
      }
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      res.writeHead(200, { ...HEADERS, 'content-type': type })
      return res.end(readFileSync(join(UI, file)))
    }

    const job = /^\/api\/jobs\/([a-f0-9]{12})$/.exec(url.pathname)
    const handler = api[job ? `${req.method} /api/jobs/:id` : `${req.method} ${url.pathname}`]
    if (!handler) return json(res, 404, { error: 'not found' })
    const body = req.method === 'GET' ? {} : await readBody(req)
    const answer = await handler({ body, id: job?.[1], server: control })
    json(res, 200, answer ?? {})
  }

  const control = {
    stop,
    done,
    get remaining() {
      return {
        overallMs: Math.max(0, startedAt + timeoutMs - Date.now()),
        idleMs: Math.max(0, state.lastSeen + idleMs - Date.now()),
      }
    },
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  timers = [setTimeout(() => stop(`the time limit of ${Math.round(timeoutMs / 60000)} minutes`), timeoutMs)]
  armIdle()
  const bound = server.address()
  return { ...control, token, port: bound.port, host, server }
}
