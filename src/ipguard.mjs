// The door of the voice endpoint: who knocks, and who gets in.
//
// The Funnel publishes the gateway to the whole internet, and scanners find
// every public address. Claude voice mode calls /mcp only from Anthropic's
// servers, whose outbound addresses Anthropic publishes. So:
//   - every HTTP request gets one access-log line: address, how it came in,
//     method, path and status;
//   - /mcp, when the request came through the Funnel or another proxy, only
//     from the allowed ranges (VOICE_GW_MCP_ALLOW); anything else gets a 403
//     before its token is looked at;
//   - such requests, voice requests without a valid token, and every step of a
//     sign-in go to Telegram, throttled, so that an attack cannot send
//     hundreds of messages.
// The sign-in itself stays open to every address: the driver signs in from
// their own browser. Programs on this computer that call without
// X-Forwarded-For (fake-voice, the tests) always pass.

import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { ANTHROPIC_RANGES } from './config.mjs'
import { log as defaultLog, preview } from './log.mjs'
import { clientAddress } from './oauth.mjs'

// --- addresses and ranges ------------------------------------------------------

// An address as bytes, 4 for IPv4 and 16 for IPv6, or null. An IPv4-mapped
// IPv6 address (::ffff:a.b.c.d), as dual-stack sockets and some proxies write
// IPv4 clients, counts as the IPv4 address. A port ([v6]:port, v4:port) and a
// zone (%eth0) are left out.
export function addressBytes(text) {
  let address = String(text ?? '').trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address)
  if (bracketed) address = bracketed[1]
  else if (/^[\d.]+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(':'))
  address = address.replace(/%.*$/, '')
  const family = isIP(address)
  if (family === 4) return address.split('.').map(Number)
  if (family !== 6) return null
  const bytes = ipv6Bytes(address)
  const mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  return mapped ? bytes.slice(12) : bytes
}

// Only for what isIP accepted as IPv6.
function ipv6Bytes(address) {
  let text = address
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number)
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, rest] = text.split('::')
  const groups = part => (part ? part.split(':') : [])
  const left = groups(head)
  const right = rest === undefined ? [] : groups(rest)
  const zeros = rest === undefined ? 0 : 8 - left.length - right.length
  return [...left, ...Array(zeros).fill('0'), ...right].flatMap(group => {
    const value = parseInt(group, 16)
    return [value >> 8, value & 0xff]
  })
}

// "160.79.104.0/21" as { text, bytes, bits }; a plain address is a range of
// one. null if it is neither.
export function parseRange(text) {
  const [address, bits, extra] = String(text ?? '').trim().split('/')
  const bytes = isIP(address) && !address.includes('%') ? addressBytes(address) : null
  if (!bytes || extra !== undefined) return null
  const max = bytes.length * 8
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : -1
  if (prefix < 0 || prefix > max) return null
  return { text: `${address}/${prefix}`, bytes, bits: prefix }
}

function inRange(bytes, range) {
  if (bytes.length !== range.bytes.length) return false
  for (let bit = 0; bit < range.bits; bit += 8) {
    const mask = (0xff << (8 - Math.min(8, range.bits - bit))) & 0xff
    if ((bytes[bit / 8] & mask) !== (range.bytes[bit / 8] & mask)) return false
  }
  return true
}

export function inRanges(address, ranges) {
  const bytes = addressBytes(address)
  return Boolean(bytes) && ranges.some(range => inRange(bytes, range))
}

const LOOPBACK = ['127.0.0.0/8', '::1/128'].map(parseRange)
const ANTHROPIC = ANTHROPIC_RANGES.map(parseRange)

// How a request reached the gateway:
//   funnel  Tailscale Funnel, which marks its requests with
//           Tailscale-Funnel-Request and drops the header if a client sent it;
//   proxy   another tunnel or reverse proxy on this computer, or Tailscale
//           Serve inside the tailnet: from loopback, with X-Forwarded-For;
//   local   a program on this computer, such as fake-voice or the watchdog;
//   direct  a connection from elsewhere, if VOICE_GW_HOST is not loopback.
export function via(req) {
  if (!inRanges(req.socket?.remoteAddress, LOOPBACK)) return 'direct'
  if (req.headers['tailscale-funnel-request']) return 'funnel'
  if (req.headers['x-forwarded-for']) return 'proxy'
  return 'local'
}

// One access-log line. The query string stays out: the sign-in's carries
// OAuth parameters. Old connector URLs had a secret in the path; that stays
// out too. url is null for a request target that is no URL.
export function accessLine(req, res, url, caller) {
  const path = !url ? '(no URL)' : url.pathname.startsWith('/mcp/') ? '/mcp/…' : preview(url.pathname, 80)
  const status = res.headersSent ? res.statusCode : '-'
  return `http ${caller.address} ${caller.via} ${preview(req.method ?? '?', 12)} ${path} ${status}${res.writableFinished ? '' : ' (aborted)'}`
}

// --- the guard -------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Anyone can register a client with any name, and Telegram turns anything
// that looks like an address into a link: only letters, digits, spaces, - and _
// of it reach the message.
const quoted = name => {
  const safe = preview(String(name ?? '').replace(/[^\p{L}\p{N} _-]+/gu, ' '), 40)
  return safe ? ` (client "${safe}")` : ''
}

const REVOKE = 'If that was not you: node scripts/pair.mjs list, then revoke.'

export class IpGuard {
  // allow: ranges as text; "any" lifts the limit. alerts: an Alerts, or null.
  constructor({ allow = ANTHROPIC_RANGES, alerts = null, log = defaultLog } = {}) {
    this.log = log
    this.alerts = alerts
    this.any = allow.some(entry => /^(any|off)$/i.test(String(entry).trim()))
    this.ranges = []
    for (const entry of this.any ? [] : allow) {
      const range = parseRange(entry)
      if (range) this.ranges.push(range)
      else log(`VOICE_GW_MCP_ALLOW: "${preview(entry, 40)}" is not an address range; left out`)
    }
    this.anthropic = this.ranges.length > 0 && this.ranges.every(range => ANTHROPIC.some(a => a.text === range.text))
  }

  // For the start-up log.
  describe() {
    if (this.any) return 'voice endpoint: /mcp from any address (VOICE_GW_MCP_ALLOW=any)'
    const ranges = this.ranges.map(range => range.text).join(', ') || 'nowhere: no valid range'
    return `voice endpoint: /mcp through the Funnel or a proxy only from ${ranges} (VOICE_GW_MCP_ALLOW)`
  }

  // Who called: the client's address, and how the request came in.
  caller(req) {
    return { address: clientAddress(req), via: via(req) }
  }

  allows(caller) {
    return caller.via === 'local' || this.any || inRanges(caller.address, this.ranges)
  }

  // A request to /mcp from outside the ranges, answered with a 403.
  blocked(req, caller) {
    const method = preview(req.method ?? '?', 12)
    this.log(`voice 403: ${method} /mcp from ${caller.address} (${caller.via}), not an allowed address`)
    const outside = this.anthropic ? "which is not one of Anthropic's addresses" : 'outside VOICE_GW_MCP_ALLOW'
    this.alerts?.notify(
      'blocked',
      caller.address,
      `suspicious activity. A voice request (${method} /mcp) came from ${caller.address}, ${outside}, and was ` +
        'blocked before its token was looked at. Claude voice mode calls only from Anthropic.',
    )
  }

  // A request to /mcp without a valid token, answered with the sign-in
  // challenge. An expired token of a known grant is the hourly refresh: only
  // logged. So is a local caller.
  refused(caller, reason) {
    const why = {
      missing: 'no token, the client has to sign in',
      unknown: 'unknown token',
      expired: 'expired token of a known connection, the client refreshes it',
    }
    this.log(`voice 401 from ${caller.address} (${caller.via}): ${why[reason] ?? reason}`)
    if (caller.via === 'local' || reason === 'expired') return
    const anthropic = inRanges(caller.address, ANTHROPIC) ? ", one of Anthropic's addresses" : ''
    const you =
      reason === 'missing'
        ? 'you are connecting the connector (again)'
        : 'your connector still uses a connection that was revoked or ran out'
    this.alerts?.notify(
      'token',
      caller.address,
      `a voice request ${reason === 'missing' ? 'without a token' : 'with an unknown token'} came from ` +
        `${caller.address}${anthropic}, and was refused. Either ${you}, or someone else's Claude account found ` +
        'the address. Without a pairing code from your computer nobody can sign in.',
    )
  }

  // A step of the sign-in (Auth's 'pairing' event).
  pairing({ outcome, address, client, left, total }) {
    const from = `from ${address}${quoted(client)}`
    const texts = {
      wrong: `wrong pairing code on the sign-in page ${from}; ${plural(left, 'attempt')} left there.`,
      refused: `pairing code refused ${from}: too many wrong attempts from this client or address.`,
      burnt:
        `wrong pairing code ${from}; ${total} wrong attempts in all, so the code is burnt. ` +
        'For a new one: node scripts/pair.mjs.',
      none: `a sign-in attempt ${from} while no pairing code is valid (none issued, or it expired); refused.`,
      accepted: `signed in with the pairing code ${from}. The connector gets its token next. ${REVOKE}`,
    }
    if (!texts[outcome]) return
    this.alerts?.notify(outcome, address, texts[outcome], { urgent: outcome === 'accepted' })
  }
}

// --- alerts on Telegram, throttled ---------------------------------------------

// What a summary calls the alerts it did not send one by one.
const KINDS = {
  blocked: ['voice request from outside the allowed addresses', 'voice requests from outside the allowed addresses'],
  token: ['voice request without a valid token', 'voice requests without a valid token'],
  wrong: ['wrong pairing code', 'wrong pairing codes'],
  refused: ['sign-in refused after too many wrong codes', 'sign-ins refused after too many wrong codes'],
  burnt: ['wrong pairing code after the code was burnt', 'wrong pairing codes after the code was burnt'],
  none: ['sign-in attempt without a valid pairing code', 'sign-in attempts without a valid pairing code'],
}

const MAX_ADDRESSES = 1000 // counted one by one per summary; beyond that, "more than"

// At most one message per kind and address within perKeyMs, and perWindow
// messages within windowMs in all. What is held back is counted and named in
// the next message; if none comes, in a summary once messages may go out
// again. An urgent alert, a successful sign-in, always goes out: a flood of
// failed ones must not hide it. Without send (no Telegram), nothing goes out;
// the gateway log has every event anyway.
export class Alerts {
  constructor({
    send = null,
    log = defaultLog,
    perKeyMs = 15 * 60 * 1000,
    windowMs = 60 * 60 * 1000,
    perWindow = 6,
    host = hostname(),
  } = {}) {
    this.send = send
    this.log = log
    this.perKeyMs = perKeyMs
    this.windowMs = windowMs
    this.perWindow = perWindow
    this.prefix = `cc-voice-gateway on ${host}: `
    this.last = new Map() // kind and address -> when the last message about it went out
    this.sent = [] // when the messages within the window went out
    this.held = new Map() // kind -> { count, addresses } held back since the last message
    this.queue = Promise.resolve() // keeps messages in order
    this.timer = null
    this.prunedAt = 0
  }

  close() {
    clearTimeout(this.timer)
    this.timer = null
  }

  notify(kind, address, text, { urgent = false } = {}) {
    if (!this.send) return
    const now = Date.now()
    this.prune(now)
    const key = `${kind} ${address}`
    if (!urgent) {
      const keyFree = !this.last.has(key) || now - this.last.get(key) >= this.perKeyMs
      if (!keyFree || this.sent.length >= this.perWindow) return this.hold(kind, address, key, now)
    }
    this.last.set(key, now)
    this.sent.push(now)
    const held = this.takeHeld(now)
    this.deliver(`${this.prefix}${text}${held ? `\n\nNot reported one by one since the last message: ${held}` : ''}`)
  }

  prune(now) {
    while (this.sent.length && now - this.sent[0] >= this.windowMs) this.sent.shift()
    if (now - this.prunedAt < 60000 && this.last.size < 10000) return
    this.prunedAt = now
    for (const [key, at] of this.last) if (now - at >= this.perKeyMs) this.last.delete(key)
  }

  hold(kind, address, key, now) {
    const entry = this.held.get(kind) ?? { count: 0, addresses: new Set() }
    entry.count += 1
    if (entry.addresses.size < MAX_ADDRESSES) entry.addresses.add(address)
    this.held.set(kind, entry)
    if (this.timer) return
    // The earliest a summary may go out: once this key, or the window, is free.
    const keyFree = this.last.has(key) ? this.last.get(key) + this.perKeyMs : now
    const windowFree = this.sent.length >= this.perWindow ? this.sent[0] + this.windowMs : now
    this.timer = setTimeout(() => this.summary(), Math.max(keyFree, windowFree) - now + 50)
    this.timer.unref?.()
  }

  // "4 wrong pairing codes, 2 voice requests …, from 3 addresses", and the
  // keys count as reported, so that a steady stream from one address gets one
  // message per perKeyMs, not two.
  takeHeld(now) {
    if (!this.held.size) return ''
    const addresses = new Set()
    const parts = []
    for (const [kind, { count, addresses: from }] of this.held) {
      const [one, many] = KINDS[kind] ?? [kind, kind]
      parts.push(`${count} ${count === 1 ? one : many}`)
      for (const address of from) {
        addresses.add(address)
        this.last.set(`${kind} ${address}`, now)
      }
    }
    this.held.clear()
    const count = addresses.size >= MAX_ADDRESSES ? `more than ${MAX_ADDRESSES} addresses` : plural(addresses.size, 'address', 'addresses')
    return `${parts.join(', ')}, from ${count}. The gateway log has each of them.`
  }

  summary() {
    this.timer = null
    if (!this.held.size) return
    const now = Date.now()
    this.prune(now)
    if (this.sent.length >= this.perWindow) {
      this.timer = setTimeout(() => this.summary(), this.sent[0] + this.windowMs - now + 50)
      this.timer.unref?.()
      return
    }
    this.sent.push(now)
    this.deliver(`${this.prefix}more suspicious requests, not reported one by one: ${this.takeHeld(now)}`)
  }

  deliver(text) {
    const title = text.split('\n')[0]
    this.queue = this.queue
      .then(() => this.send(text))
      .then(() => this.log('alert sent by Telegram:', preview(title, 120)))
      .catch(error => this.log('alert not sent by Telegram:', preview(title, 60), '-', error.message))
  }
}
