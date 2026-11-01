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

// Every answer of the connector starts with the line that names this gateway
// and says whether it is active (presence.mjs); the rest follows.
const LINE = 'Gateway Testbox (e2e): active'
const afterLine = (text, name = '') => {
  const [first, ...rest] = text.split('\n')
  assert.equal(first, LINE, `every answer starts with the gateway's line${name ? ` (${name})` : ''}`)
  return rest.join('\n')
}

async function voiceCall(name, args = {}) {
  return afterLine(resultText(await voice.callTool({ name, arguments: args })), name)
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
      VOICE_GW_SELF_CHECKOUT: '', // not this checkout, whatever state it is in
      VOICE_GW_NAME: 'Testbox (e2e)', // with its own brackets: no kind of computer added
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
  assert.deepEqual(tools.map(t => t.name), [
    'reply',
    'list_workers',
    'dispatch',
    'worker_status',
    'stop_worker',
    'order_queue',
    'open_items',
    'resolve_decision',
    'stats',
    'restart_controller',
    'raise_alarm',
    'set_away',
    'standing_order',
    'end_order',
  ])
  assert.match(claudeCode.getInstructions(), /request_id/)
  // The controller stays free for new requests: longer work goes out at once.
  assert.match(claudeCode.getInstructions(), /^Stay free for the driver: do yourself only what takes a few quick tool calls/m)
  assert.match(claudeCode.getInstructions(), /Never block on a long job yourself\./)
})

test('voice endpoint exposes the voice tools', async () => {
  const { tools } = await voice.listTools()
  assert.deepEqual(tools.map(t => t.name).sort(), ['approve', 'ask', 'emergency_stop', 'get_reply', 'send', 'status'])
})

test('the connector names its gateway, for a driver with several: in the instructions, in every tool description, first in every answer', async () => {
  assert.match(
    voice.getInstructions(),
    /\nThis connector is the gateway Testbox \(e2e\)\. Every answer starts with a line that names it and says whether it is active; an inactive gateway hands nothing over\. With several such connectors, one per computer, call status on each first and use the active one\. Switch to another connector only when an answer says "use another connector" \(a gateway on standby\)\. A locked kill switch is unlocked only at the computer: tell the user so\.$/,
  )
  assert.doesNotMatch(voice.getInstructions(), /on standby by its settings/)
  const { tools } = await voice.listTools()
  for (const tool of tools) assert.match(tool.description, /This is the gateway Testbox \(e2e\)\.$/, tool.name)
  assert.match(
    tools.find(t => t.name === 'status').description,
    /Use it when the user asks whether the connection works or what is going on, and, with several such connectors, on each first to find the active one\./,
  )
  // When to switch stands once, in the instructions.
  for (const tool of tools) assert.doesNotMatch(tool.description, /another connector/, tool.name)
  // status gives it first, before the machine-readable line (voiceCall checks the line on every answer).
  const raw = resultText(await voice.callTool({ name: 'status', arguments: {} }))
  assert.match(raw, /^Gateway Testbox \(e2e\): active\n\[gateway=ok controller=/)
})

// Asked for in the car: no answer at all before a request is passed on, then a
// short one that fits it, worded differently each time. And no rules about
// what not to say: naming the sentences to avoid made the voice AI say them
// more often. So positive rules and examples only, everywhere.
const PROHIBITIONS =
  /\b[Nn]ever\b|\b[Dd]on't\b|\b[Dd]o not\b|instead of|lead-in|schau|nachsehen|sehe mal|let me check|have a look|look or check|weitergegeben|Passed on/

test('what the voice assistant says around a call: nothing before it, a confirmation after a request went on that fits it; positive rules only', async () => {
  const instructions = voice.getInstructions()
  const flat = instructions.replace(/\n/g, ' ')
  const has = sentence => assert.ok(flat.includes(sentence), sentence)
  has(
    'The user is usually driving: keep everything short and in their language, and answer at once whenever they have said something, since silence sounds as if they were not heard. If you did not understand, ask back.',
  )
  has('When the user asks for something, call the tool straight away and speak once it returns.')
  has(
    'Right after send, and after ask while it still runs, confirm in a few words what you passed on, fitting the request and worded differently each time, such as "The branch sync is on its way" or "Restart requested" (in German "Der Abgleich der Branches ist unterwegs", "Neustart ist angefragt").',
  )
  has('Then call get_reply while the state is "sent" or "working"; between calls, say in a short phrase that it is still running.')
  has('Claude Code does the work: relay its answers and questions faithfully, shortened if you like.')
  has(
    'Approvals: read them out, and call approve only after the user explicitly said yes or no to that action; then confirm it in a short phrase, such as "Allowed" (in German "Erlaubt").',
  )
  has('News: results of work Claude Code finished in the background come with any call; read them out too.')
  has(
    'Emergency: when the user says "emergency stop" or "kill switch", in any language, call emergency_stop at once, without asking back. An [ALARM] line in any result is read out first.',
  )
  assert.doesNotMatch(instructions, PROHIBITIONS)
  assert.doesNotMatch(instructions, /short okay|before every tool call|[Bb]efore (the call|ask|send|status|approve)/)

  const { tools } = await voice.listTools()
  const description = name => tools.find(t => t.name === name).description
  const includes = (name, sentence) => assert.ok(description(name).includes(sentence), `${name}: ${sentence}`)
  includes(
    'send',
    'Call it straight away, and right after it confirm in a few words of their language what you passed on, fitting the request and worded differently each time, such as "The branch sync is on its way", "Your question about the tests is with Claude Code" or "Restart requested" (in German "Der Abgleich der Branches ist unterwegs", "Die Frage zu den Tests ist bei Claude Code", "Neustart ist angefragt").',
  )
  includes('send', "Use it, rather than your own knowledge or the web, for anything about the user's projects, code, computer or Claude Code sessions")
  includes(
    'ask',
    'Call it straight away, then read the answer. While it still runs (state=sent or working), the question is sent already: first confirm in a few words what you passed on, as after send, then follow the returned id with get_reply.',
  )
  includes(
    'get_reply',
    'state=sent or working: read out briefly what Claude Code said, or else say in a short phrase that it is still running, varied and fitting the request, such as "Still running" or "The sync is still going" (in German "Läuft noch", "Der Abgleich läuft noch"); then call get_reply again with the same id.',
  )
  includes(
    'approve',
    'Call it only after you read the request to the user and they explicitly said yes (allow) or no (deny) to this action, then straight away; right after it, confirm their decision in a short phrase of their language, such as "Allowed" or "Denied" (in German "Erlaubt", "Abgelehnt").',
  )
  assert.match(
    description('emergency_stop'),
    /^Emergency stop \(kill switch\)\. Call it at once, without asking back, when the user says "emergency stop" or "kill switch", in any language\./,
  )
  for (const tool of tools) {
    assert.doesNotMatch(tool.description, PROHIBITIONS, tool.name)
    assert.doesNotMatch(tool.description, /[Bb]efore the call/, tool.name)
    for (const [key, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.doesNotMatch(schema.description ?? '', PROHIBITIONS, `${tool.name}.${key}`)
    }
  }
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
  // A poll without news: a short phrase that it is still running.
  assert.match(
    hint,
    new RegExp(`\\nStill working\\. Tell the user in a short phrase that it is still running, fitting the request, and call get_reply again with id=${id}\\.$`),
  )
  assert.doesNotMatch(hint, PROHIBITIONS)
})

test('send -> channel event -> reply(working, done) -> get_reply', async () => {
  const sent = await voiceCall('send', { message: 'How many files are in the playground?' })
  const id = idOf(sent)
  assert.match(sent, /^\[state=sent id=[a-z0-9]{4}\]/)
  // Nothing was said before it: its result asks for the confirmation, in a
  // few words that fit the request.
  assert.match(
    sent,
    new RegExp(`\\] Handed over\\. Now confirm to the user in a few words of their language what you passed on, fitting this request and worded differently each time\\. Then call get_reply with id=${id}\\.$`),
  )
  assert.doesNotMatch(sent, PROHIBITIONS)

  const event = await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  assert.equal(event.content, 'How many files are in the playground?')

  await controllerReply(id, 'working', 'Looking.')
  const first = await voiceCall('get_reply', { id })
  assert.match(first, new RegExp(`^\\[state=working id=${id} `))
  assert.match(first, /Claude Code: Looking\./)
  // With news from Claude Code, its words, briefly; not just a short phrase.
  assert.match(first, /\nStill working\. Tell the user briefly and call get_reply again/)

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

// ask said nothing before the call: while it still runs, its result asks for
// the confirmation that fits the request, not for "still running".
test('ask still running: its result asks for a confirmation of what went on', async () => {
  const out = await voiceCall('ask', { message: 'Sync the branches with main.' })
  const id = idOf(out)
  assert.match(out, /^\[state=sent /)
  assert.match(
    out,
    new RegExp(`\\nStill working\\. Now confirm to the user in a few words of their language what you passed on, fitting this request and worded differently each time\\. Then call get_reply with id=${id}\\.$`),
  )
  assert.doesNotMatch(out, PROHIBITIONS)
  // The next poll is a poll: a short phrase that it is still running.
  const poll = await voiceCall('get_reply', { id, wait_seconds: 1 })
  assert.match(poll, /\nStill working\. Tell the user in a short phrase that it is still running, fitting the request, and call get_reply again/)
  await controllerReply(id, 'done', 'Synced.')
})

test('a question round-trip carries in_reply_to', async () => {
  const id = idOf(await voiceCall('send', { message: 'Clean up the repo.' }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  await controllerReply(id, 'question', 'Should I delete the branches too, yes or no?')
  const out = await voiceCall('get_reply', { id })
  assert.match(out, /^\[state=question /)
  assert.match(out, new RegExp(`in_reply_to=${id}`))

  const answered = await voiceCall('send', { message: 'No, only the files.', in_reply_to: id.toUpperCase() })
  assert.match(answered, new RegExp(`^\\[state=sent id=[a-z0-9]{4}\\] Handed over as the answer to ${id}\\.`))
  const answerId = idOf(answered)
  const event = await waitUntil(() => channelEvents.find(e => e.meta?.request_id === answerId))
  assert.equal(event.content, `(Answer to ${id}) No, only the files.`)

  // The question is settled: done, and no longer among the open requests.
  assert.match(await voiceCall('get_reply', { id, wait_seconds: 1 }), /^\[state=done [^]*Done, no new messages/)
  const status = await voiceCall('status')
  assert.ok(!status.includes(`${id} (`), status)
  assert.ok(status.includes(`${answerId} (sent`), status)
})

test('in_reply_to with an unknown id hands nothing over', async () => {
  const before = channelEvents.length
  const result = await voice.callTool({ name: 'send', arguments: { message: 'Yes, do it.', in_reply_to: 'zzzz' } })
  assert.equal(result.isError, true)
  assert.match(afterLine(resultText(result)), /^\[state=unknown in_reply_to=zzzz\] No request has this id, so nothing was handed over/)
  await new Promise(r => setTimeout(r, 200))
  assert.equal(channelEvents.length, before)
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

test('an approval answered at the computer: the next tool call of the session closes it, a late approve sends no verdict', async () => {
  const id = idOf(await voiceCall('send', { message: 'Watch the build.' }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  const ask = request_id =>
    claudeCode.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id, tool_name: 'Monitor', description: 'Watch the build log', input_preview: '{}' },
    })
  await ask('bdozq')
  assert.match(await voiceCall('get_reply', { id, wait_seconds: 3 }), /approval=bdozq/)

  // Answered in the terminal, which Claude Code does not tell the channel; the
  // session goes on and calls a tool of the gateway.
  const workers = await claudeCode.callTool({ name: 'list_workers', arguments: {} })
  assert.equal(workers.isError, false)
  await waitUntil(() => gatewayLog.includes('permission answered at the computer code=bdozq tool=Monitor (then list_workers called)'))
  const out = await voiceCall('get_reply', { id, wait_seconds: 1 })
  assert.doesNotMatch(out, /approval=bdozq|Approval needed/)
  assert.match(out, /^Approval bdozq was answered at the computer and is settled; it needs nothing from the user\.$/m)
  assert.doesNotMatch(await voiceCall('get_reply', { id, wait_seconds: 1 }), /bdozq/, 'said once')
  assert.doesNotMatch(await voiceCall('status'), /Pending approvals/)

  const late = await voiceCall('approve', { code: 'bdozq', decision: 'allow' })
  assert.match(late, /^\[approval=elsewhere code=bdozq\] Already answered at the computer; nothing to do\./)
  await new Promise(r => setTimeout(r, 200))
  assert.ok(!verdicts.some(v => v.request_id === 'bdozq'), 'no verdict that would apply to nothing')

  // A prompt after the tool call waits as before, until a reply from the session.
  await ask('cdpqr')
  assert.match(await voiceCall('status'), /Pending approvals: cdpqr \(Monitor\)/)
  await controllerReply(id, 'done', 'The build is green.')
  assert.doesNotMatch(await voiceCall('status'), /Pending approvals/)
  assert.match(await voiceCall('approve', { code: 'cdpqr', decision: 'deny' }), /^\[approval=elsewhere code=cdpqr\]/)
})

test('night mode by voice: set_away on the driver\'s words, on and off; the controller hears the night begin and the summary', async () => {
  const controller = async (name, args) => resultText(await claudeCode.callTool({ name, arguments: args }))
  assert.match(await controller('set_away', { away: true, words: 'see you tomorrow' }), /^\[night=needs_driver\]/, 'no such voice request')
  const id = idOf(await voiceCall('send', { message: 'Good night, see you tomorrow.' }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  const on = await controller('set_away', { away: true, words: 'Good night, see you tomorrow' })
  assert.match(on, /^\[night=on until=\d\d:\d\d.*\] Night mode is on since \d\d:\d\d, as the driver said, until \d\d:\d\d.*Tell the driver good night/)
  const night = await waitUntil(() => channelEvents.find(e => e.meta?.kind === 'night'))
  assert.equal(night.meta.state, 'on')
  await controllerReply(night.meta.request_id, 'done', 'ok')
  await controllerReply(id, 'done', 'Good night.')
  assert.match(await controller('open_items', {}), /\nThe gateway now:\n- Night mode is on since /)

  const back = idOf(await voiceCall('send', { message: "I'm back, good morning." }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === back))
  assert.match(await controller('set_away', { away: false, words: "I'm back" }), /^\[night=off\] Night mode is off\. The summary of the night follows/)
  const morning = await waitUntil(() => channelEvents.find(e => e.meta?.kind === 'morning'))
  assert.match(morning.content, /^Night mode from \d\d:\d\d to \d\d:\d\d\.\nNo worker run ended in the night\./)
  assert.equal(morning.meta.trusted, 'no')
  await controllerReply(morning.meta.request_id, 'done', 'You were away; nothing happened.')
  await controllerReply(back, 'done', 'Welcome back.')
  assert.match(await controller('set_away', { away: false, words: "I'm back" }), /^\[night=off\] Night mode was not on/)
  assert.doesNotMatch(await controller('open_items', {}), /Night mode/)
  // The controller's answer to the summary is news for the voice assistant.
  assert.match(await voiceCall('status'), /News from Claude Code \(id=\w+\): You were away; nothing happened\./)
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
