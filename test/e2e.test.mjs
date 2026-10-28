// End-to-end test without Claude Code and without a car.
//
// The test plays both ends:
//   - "Claude Code": spawns src/gateway.mjs over stdio, receives channel events,
//     calls the reply tool and sends permission requests, like Claude Code does.
//   - "voice client": talks to the HTTP endpoint like Claude voice mode, with a
//     token from the admin socket (the sign-in itself is in oauth.test.mjs).
//
// Run: npm test

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const SECRETS = mkdtempSync(join(tmpdir(), 'voice-gw-e2e-'))

let port
let token // access token for the voice client
let claudeCode // MCP client on the stdio side, standing in for Claude Code
let voice // MCP client on the HTTP side, standing in for the voice assistant
const channelEvents = []
const verdicts = []
let gatewayLog = '' // the gateway's stderr
const waiters = new Set()

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

function notify() {
  for (const check of waiters) check()
}

function waitUntil(predicate, ms = 3000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate()
      if (value) {
        waiters.delete(check)
        clearTimeout(timer)
        resolve(value)
      }
    }
    const timer = setTimeout(() => {
      waiters.delete(check)
      reject(new Error('timed out waiting'))
    }, ms)
    waiters.add(check)
    check()
  })
}

const resultText = result => result.content.map(c => c.text).join('\n')

async function voiceCall(name, args = {}) {
  return resultText(await voice.callTool({ name, arguments: args }))
}

async function controllerReply(request_id, state, text) {
  const result = await claudeCode.callTool({ name: 'reply', arguments: { request_id, state, text } })
  assert.equal(result.isError, false, resultText(result))
}

const idOf = textOut => /id=([a-z0-9]+)/.exec(textOut)?.[1]

before(async () => {
  port = await freePort()
  claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => {
      channelEvents.push(params)
      notify()
    },
  )
  claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission'),
      params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
    }),
    ({ params }) => {
      verdicts.push(params)
      notify()
    },
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: SECRETS,
      VOICE_GW_STATE_DIR: join(SECRETS, 'state'),
      VOICE_GW_WORKER_ROOT: join(SECRETS, 'no-repositories'),
      VOICE_GW_PORT: String(port),
      VOICE_GW_MAX_WAIT: '3',
      VOICE_GW_DEFAULT_WAIT: '2',
      VOICE_GW_HINT_AFTER: '1',
      VOICE_GW_LOG_FILE: '',
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => {
    gatewayLog += chunk
    notify()
  })
  await claudeCode.connect(stdio)

  // The HTTP side starts right after the stdio handshake.
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await new Promise(r => setTimeout(r, 50))
    }
  }

  ;({ access_token: token } = await adminRequest(join(SECRETS, 'admin.sock'), 'POST', '/token', { name: 'e2e' }))
  voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await voice.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
})

after(async () => {
  await voice?.close()
  await claudeCode?.close()
  rmSync(SECRETS, { recursive: true, force: true })
})

test('declares the channel and permission capabilities and the reply tool', async () => {
  const caps = claudeCode.getServerCapabilities()
  assert.deepEqual(caps.experimental['claude/channel'], {})
  assert.deepEqual(caps.experimental['claude/channel/permission'], {})
  const { tools } = await claudeCode.listTools()
  assert.deepEqual(tools.map(t => t.name), ['reply', 'list_workers', 'dispatch', 'worker_status', 'stop_worker', 'restart_controller'])
  assert.match(claudeCode.getInstructions(), /request_id/)
})

test('voice endpoint exposes the voice tools', async () => {
  const { tools } = await voice.listTools()
  assert.deepEqual(tools.map(t => t.name).sort(), ['approve', 'ask', 'get_reply', 'send', 'status'])
})

test('logs every voice call with client, method and tool, never the token', async () => {
  // In the car the question is whether the assistant called the connector at
  // all; these lines answer it even when no request reaches the controller.
  await voiceCall('status')
  const logged = await waitUntil(() => gatewayLog.includes('voice tools/call status') && gatewayLog)
  assert.match(logged, /voice initialize client=fake-voice\/0\.0\.0 protocol=\S+ ua="[^"]*" from=\S+ grant=[0-9a-f]{6}/)
  assert.match(logged, /voice tools\/list/)
  assert.ok(!logged.includes(token), 'the token never reaches the log')
})

test('answers unreadable and oversized bodies with a JSON-RPC parse error', async () => {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  }
  const bad = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: '{nope' })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error.code, -32700)
  const big = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1100 * 1024) } }),
  }).catch(error => ({ status: 'reset', error }))
  assert.ok(big.status === 413 || big.status === 'reset', `got ${big.status}`)
})

test('without a valid token: 401 pointing to the sign-in, other paths 404', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const post = (path, extra = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body })

  const missing = await post('/mcp')
  assert.equal(missing.status, 401)
  assert.match(
    missing.headers.get('www-authenticate'),
    /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/,
  )
  const wrong = await post('/mcp', { authorization: 'Bearer not-a-token' })
  assert.equal(wrong.status, 401)
  assert.match(wrong.headers.get('www-authenticate'), /error="invalid_token"/)

  // The old connector URLs carried the secret in the path; it stays out of the log.
  const old = await post(`/mcp/${'x'.repeat(40)}`, { authorization: `Bearer ${token}` })
  assert.equal(old.status, 404)
  assert.ok(!gatewayLog.includes('x'.repeat(40)))
  assert.equal((await post('/')).status, 404)

  assert.equal((await post('/mcp', { authorization: `Bearer ${token}` })).status, 200)
  const get = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(get.status, 405)
})

test('status and the hint work before the controller ever answered', async () => {
  const out = await voiceCall('status')
  assert.match(out, /^\[gateway=ok controller=unconfirmed/)

  // Seen with a real session: the event arrived, but the turn failed with
  // "Login expired", so the hint must not only blame the channel flag.
  const id = idOf(await voiceCall('send', { message: 'Can anyone hear me?' }))
  const hint = await voiceCall('get_reply', { id, wait_seconds: 2 })
  assert.match(hint, /^\[state=sent /)
  assert.match(hint, /has not answered once/)
  assert.match(hint, /--dangerously-load-development-channels server:voice/)
  assert.match(hint, /login expired/)
})

test('send -> channel event -> reply(working, done) -> get_reply', async () => {
  const sent = await voiceCall('send', { message: 'How many files are in the playground?' })
  const id = idOf(sent)
  assert.match(sent, /^\[state=sent id=[a-z0-9]{4}\]/)

  const event = await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  assert.equal(event.content, 'How many files are in the playground?')

  await controllerReply(id, 'working', 'Looking.')
  const first = await voiceCall('get_reply', { id })
  assert.match(first, new RegExp(`^\\[state=working id=${id} `))
  assert.match(first, /Claude Code: Looking\./)
  assert.match(first, /call get_reply again/)

  // The long poll returns as soon as the answer arrives, not after the full wait.
  const started = Date.now()
  setTimeout(() => controllerReply(id, 'done', 'There are three files.'), 300)
  const second = await voiceCall('get_reply', { id, wait_seconds: 3 })
  assert.ok(Date.now() - started < 2500, 'get_reply should return early')
  assert.match(second, /^\[state=done /)
  assert.match(second, /There are three files\./)
  assert.doesNotMatch(second, /Looking/, 'already delivered updates are not repeated')

  const third = await voiceCall('get_reply', { id })
  assert.match(third, /Done, no new messages/)
})

test('ask waits in one call', async () => {
  const pending = voiceCall('ask', { message: 'Is the build green?' })
  const event = await waitUntil(() => channelEvents.find(e => e.content === 'Is the build green?'))
  await controllerReply(event.meta.request_id, 'done', 'Yes, green.')
  const out = await pending
  assert.match(out, /^\[state=done /)
  assert.match(out, /Yes, green\./)
})

test('a question round-trip carries in_reply_to', async () => {
  const id = idOf(await voiceCall('send', { message: 'Clean up the repo.' }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  await controllerReply(id, 'question', 'Should I delete the branches too, yes or no?')
  const out = await voiceCall('get_reply', { id })
  assert.match(out, /^\[state=question /)
  assert.match(out, new RegExp(`in_reply_to=${id}`))

  const answerId = idOf(await voiceCall('send', { message: 'No, only the files.', in_reply_to: id }))
  const event = await waitUntil(() => channelEvents.find(e => e.meta?.request_id === answerId))
  assert.equal(event.content, `(Answer to ${id}) No, only the files.`)
})

test('permission relay: prompt -> get_reply -> approve -> verdict to Claude Code', async () => {
  const id = idOf(await voiceCall('send', { message: 'Create the file hello.txt.' }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))

  await claudeCode.notification({
    method: 'notifications/claude/channel/permission_request',
    params: {
      request_id: 'abcde',
      tool_name: 'Write',
      // Claude Code's descriptions often end with a full stop.
      description: 'Create playground/hello.txt.',
      input_preview: '{"file_path": "playground/hello.txt", "content": "Grüezi"}',
    },
  })

  const out = await voiceCall('get_reply', { id, wait_seconds: 3 })
  assert.match(out, /approval=abcde/)
  // Seen with a real session: Claude Code waits for the driver here, so the
  // "nothing happens" hint (hint after 1 s in this test) must stay out.
  await new Promise(r => setTimeout(r, 1100))
  const waiting = await voiceCall('get_reply', { id, wait_seconds: 1 })
  assert.match(waiting, /approval=abcde/)
  assert.doesNotMatch(waiting, /Hint:/)
  assert.match(out, /Approval needed \(code=abcde\): Write – Create playground\/hello\.txt\. Details: /)
  assert.match(out, /"content": "Grüezi"/)
  assert.match(out, /without an explicit yes/)

  assert.match(await voiceCall('status'), /Pending approvals: abcde \(Write\)/)

  const approved = await voiceCall('approve', { code: 'ABCDE', decision: 'allow' })
  assert.match(approved, /^\[approval=allow code=abcde\]/)
  const verdict = await waitUntil(() => verdicts.find(v => v.request_id === 'abcde'))
  assert.equal(verdict.behavior, 'allow')

  const again = await voiceCall('approve', { code: 'abcde', decision: 'deny' })
  assert.match(again, /unknown or already answered/)
  assert.equal(verdicts.filter(v => v.request_id === 'abcde').length, 1)
})

test('approve rejects malformed codes', async () => {
  const result = await voice.callTool({ name: 'approve', arguments: { code: 'll111', decision: 'allow' } })
  assert.equal(result.isError, true)
})

test('reply rejects unknown request ids and bad states', async () => {
  const unknown = await claudeCode.callTool({
    name: 'reply',
    arguments: { request_id: 'zzzz', state: 'done', text: 'x' },
  })
  assert.equal(unknown.isError, true)
  const id = idOf(await voiceCall('send', { message: 'Test' }))
  const badState = await claudeCode.callTool({ name: 'reply', arguments: { request_id: id, state: 'finished', text: 'x' } })
  assert.equal(badState.isError, true)
})

test('a gateway whose Claude Code session dies exits instead of holding the port', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: join(SECRETS, 'dying'),
      VOICE_GW_STATE_DIR: join(SECRETS, 'dying', 'state'),
      VOICE_GW_WORKER_ROOT: join(SECRETS, 'no-repositories'),
      VOICE_GW_PORT: String(await freePort()),
      VOICE_GW_LOG_FILE: '',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  await new Promise(r => setTimeout(r, 500))
  const exited = new Promise(resolve => child.on('exit', () => resolve(true)))
  child.stdin.end() // what the OS does when the parent process disappears
  const result = await Promise.race([exited, new Promise(r => setTimeout(() => r(false), 3000))])
  if (!result) child.kill('SIGKILL')
  assert.equal(result, true, 'gateway should exit after stdin EOF')
})

test('get_reply on an unknown id and the hint when nothing happens', async () => {
  assert.match(await voiceCall('get_reply', { id: 'qqqq' }), /^\[state=unknown id=qqqq\]/)
  const id = idOf(await voiceCall('send', { message: 'Nobody answers this.' }))
  const out = await voiceCall('get_reply', { id, wait_seconds: 2 })
  assert.match(out, /^\[state=sent /)
  assert.match(out, /Hint: Claude Code has not picked up the request yet/)
  assert.match(out, /login expired/)
  assert.match(await voiceCall('status'), /controller=confirmed/)
})
