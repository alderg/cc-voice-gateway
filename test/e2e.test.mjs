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
      VOICE_GW_ASK_WAIT: '1', // shorter than VOICE_GW_MAX_WAIT: ask waits only that long
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

// What the voice assistant says, as in the texts of 31 October, with which it
// said varied, fitting things: before send and ask a short line of its own
// that fits the request, and at least a short okay after everything the user
// says. "Say nothing before the call" and "your reply begins with the call"
// (1 November) left the moment before the call to one stock filler. And no
// text names a filler, in any language, not even as a ban: naming one made the
// voice AI say it more often.
const FILLERS =
  /schau|nachseh|sehe mal|\bmoment|augenblick|let me (check|see|look)|have a look|look or check|look(ing)? (it up )?yourself|check (it )?yourself|weitergegeben|passed on/i

// The last line of every result that ends a request (the answer, a question
// back, status): the voice assistant follows a result at once, while it
// fetches the instructions and descriptions only when the connector connects.
// None while a request runs or with an approval.
const NEXT_REQUEST =
  "For the user's next request (not to read out): before send or ask, say its subject in a few of their own words and that it goes to Claude Code, e.g. „Die Tests in alpha, geht an Claude Code“."
const endsWith = (out, last) => assert.ok(out.endsWith(`\n${last}`), out)
const withoutNext = out => assert.ok(!out.includes(NEXT_REQUEST), out)

test('what the voice assistant says around a call: before send and ask a short line of its own that fits the request; no filler named anywhere', async () => {
  const instructions = voice.getInstructions()
  const lines = instructions.split('\n')
  const has = line => assert.ok(lines.includes(line), line)
  has(
    "This connector reaches Claude Code sessions running on the user's own computer. The user is usually driving, so keep everything you say short.",
  )
  // Never silent: in a car, silence sounds as if the request was not heard.
  has(
    'Never leave the user in silence: they cannot look at the screen, and silence sounds as if they were not heard. Whenever they have said something, say something back at once, at least a short okay in their language, and before every tool call. If you did not understand, ask back instead of staying quiet.',
  )
  // ask's own wait (VOICE_GW_ASK_WAIT, 1 s here) and get_reply's (VOICE_GW_DEFAULT_WAIT, 2 s here).
  has(
    'Workflow: send (or ask) -> get_reply, repeated while state is "sent" or "working" (ask waits up to 1 second for a quick answer, each get_reply up to 2 seconds) -> read the answer. Before send or ask, acknowledge in one short line in the user\'s language that fits the request and names what it is about: a task is on its way, a question goes to Claude Code and its answer follows. Word it freshly each time. Claude Code does the work, you pass it on. Between polls tell the user in a few words that it is still running. Relay Claude Code\'s answers faithfully; you may shorten them but never invent results.',
  )
  has('Approvals: read them out and call approve only after the user explicitly said yes or no to that action.')
  has('News: results of work Claude Code finished in the background arrive with any call. Read them out too.')
  has(
    'Emergency: when the user says "emergency stop" or "kill switch", in any language, call emergency_stop at once, without asking back. An [ALARM] line in any result is read out first.',
  )
  assert.doesNotMatch(instructions, FILLERS)
  // Nothing left of the rules that kept it quiet before the call.
  assert.doesNotMatch(instructions, /begins with|say nothing|right after send|once it returns/i)

  const { tools } = await voice.listTools()
  const description = name => tools.find(t => t.name === name).description
  const includes = (name, sentence) => assert.ok(description(name).includes(sentence), `${name}: ${sentence}`)
  const ack = examples =>
    `Before the call, always, say one short line to the user in their language that fits this request and names what it is about: for a task, that it is on its way (in the sense of "will do"); for a plain question, that it goes to Claude Code and the answer follows. Word it freshly each time, in your own words, such as ${examples}, not as a fixed phrase. You only pass the request on; Claude Code does the work.`
  includes(
    'send',
    "Send the user's request to Claude Code on their computer. Use it for anything about the user's projects, code, computer or running Claude Code sessions: you cannot see their machine, Claude Code can. Pass the request on instead of answering from your own knowledge or searching the web. Returns immediately with an id; then call get_reply with that id until state is done or question. ",
  )
  // Examples that fit the tool, in German and English, of different shapes.
  includes('send', ack('"Ich gebe den Abgleich der Branches an Claude Code weiter" or "The README fix is on its way"'))
  includes(
    'ask',
    'Send a short question to Claude Code and wait up to 1 second for the answer in one call. Use it for anything about',
  )
  includes(
    'ask',
    ' If the result says state=sent or working, continue with get_reply and the returned id; never call ask again for the same request, that would send it twice. ',
  )
  includes('ask', ack('"Ich frage Claude Code nach den Tests" or "Asking Claude Code whether the build is green"'))
  includes(
    'get_reply',
    'state=sent or working: tell the user briefly, in a few varied words of their language, that Claude Code is still on it, and call get_reply again with the same id.',
  )
  includes(
    'approve',
    'Only call this after you read the request to the user and they explicitly said yes (allow) or no (deny) to this specific action. Never approve on your own. Before the call, confirm their decision in a few words of their language.',
  )
  assert.match(
    description('emergency_stop'),
    /^Emergency stop \(kill switch\)\. Call it at once, without asking back, when the user says "emergency stop" or "kill switch", in any language\./,
  )
  // The examples stand once each, in send's and in ask's description.
  for (const example of ['Abgleich der Branches', 'README fix', 'nach den Tests', 'build is green']) {
    assert.equal(tools.filter(tool => tool.description.includes(example)).length, 1, example)
    assert.ok(!instructions.includes(example), example)
  }
  for (const tool of tools) {
    assert.doesNotMatch(tool.description, FILLERS, tool.name)
    assert.doesNotMatch(tool.description, /begins with this call|say nothing/i, tool.name)
    for (const [key, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.doesNotMatch(schema.description ?? '', FILLERS, `${tool.name}.${key}`)
    }
  }
})

test('the filler check catches a named filler in German and English, and lets the acknowledgement rules through', () => {
  for (const named of [
    'Einen Moment, ich schaue mal nach',
    'Moment, ich schau mal nach',
    'lass mich nachsehen',
    'ich sehe mal nach',
    'Let me check',
    "I'll have a look",
    'One moment',
    'Never say you will look or check yourself',
    'never that you are looking yourself',
    'Ist weitergegeben',
    'Passed on',
  ]) {
    assert.match(named, FILLERS, named)
  }
  for (const fine of [
    'Ich gebe den Abgleich der Branches an Claude Code weiter',
    'You only pass the request on; Claude Code does the work.',
    'Never leave the user in silence',
    'ask back instead of staying quiet',
    'Check the terminal of the controller session',
    NEXT_REQUEST,
  ]) {
    assert.doesNotMatch(fine, FILLERS, fine)
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
  endsWith(out, NEXT_REQUEST)

  // Seen with a real session: the event arrived, but the turn failed with
  // "Login expired", so the hint must not only blame the channel flag.
  const id = idOf(await voiceCall('send', { message: 'Can anyone hear me?' }))
  const hint = await voiceCall('get_reply', { id, wait_seconds: 2 })
  assert.match(hint, /^\[state=sent /)
  assert.match(hint, /has not answered once/)
  assert.match(hint, /--dangerously-load-development-channels server:voice/)
  assert.match(hint, /login expired/)
  assert.match(hint, new RegExp(`\\nStill working\\. Tell the user briefly and call get_reply again with id=${id}\\.$`))
  assert.doesNotMatch(hint, FILLERS)
  withoutNext(hint)
})

test('send -> channel event -> reply(working, done) -> get_reply', async () => {
  const sent = await voiceCall('send', { message: 'How many files are in the playground?' })
  const id = idOf(sent)
  assert.match(sent, /^\[state=sent id=[a-z0-9]{4}\]/)
  // The acknowledgement came before the call: once is enough. Without it, a
  // short okay now, so that the user is never left in silence.
  assert.match(
    sent,
    new RegExp(`\\] Handed over\\. If you have acknowledged the request already, call get_reply with id=${id} now; otherwise say a short okay in their language first\\.$`),
  )
  assert.doesNotMatch(sent, FILLERS)
  withoutNext(sent)

  const event = await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  assert.equal(event.content, 'How many files are in the playground?')

  await controllerReply(id, 'working', 'Looking.')
  const first = await voiceCall('get_reply', { id })
  assert.match(first, new RegExp(`^\\[state=working id=${id} `))
  assert.match(first, /Claude Code: Looking\./)
  assert.match(first, /\nStill working\. Tell the user briefly and call get_reply again/)
  withoutNext(first)

  // The long poll returns as soon as the answer arrives, not after the full wait.
  const started = Date.now()
  setTimeout(() => controllerReply(id, 'done', 'There are three files.'), 300)
  const second = await voiceCall('get_reply', { id, wait_seconds: 3 })
  assert.ok(Date.now() - started < 2500, 'get_reply should return early')
  assert.match(second, /^\[state=done /)
  assert.match(second, /There are three files\./)
  assert.doesNotMatch(second, /Looking/, 'already delivered updates are not repeated')
  // The answer ends the request: the line about the next one follows it.
  endsWith(second, `Done. Read the answer to the user.\n${NEXT_REQUEST}`)
  assert.doesNotMatch(second, FILLERS)

  const third = await voiceCall('get_reply', { id })
  endsWith(third, `Done, no new messages.\n${NEXT_REQUEST}`)
})

test('ask waits in one call', async () => {
  const pending = voiceCall('ask', { message: 'Is the build green?' })
  const event = await waitUntil(() => channelEvents.find(e => e.content === 'Is the build green?'))
  await controllerReply(event.meta.request_id, 'done', 'Yes, green.')
  const out = await pending
  assert.match(out, /^\[state=done /)
  assert.match(out, /Yes, green\./)
  endsWith(out, `Done. Read the answer to the user.\n${NEXT_REQUEST}`)
})

// ask waits only briefly, here 1 s (VOICE_GW_ASK_WAIT) rather than get_reply's
// 3 s at most: after the acknowledgement before the call the driver hears
// nothing until it returns. While it still runs, on with get_reply.
test('ask still running: back after its own short wait, then on with get_reply', async () => {
  const out = await voiceCall('ask', { message: 'Sync the branches with main.' })
  const id = idOf(out)
  assert.match(out, /^\[state=sent id=\w+ elapsed=[12]s\]/)
  assert.match(out, new RegExp(`\\nStill working\\. Tell the user briefly and call get_reply again with id=${id}\\.$`))
  assert.doesNotMatch(out, FILLERS)
  withoutNext(out)
  const poll = await voiceCall('get_reply', { id, wait_seconds: 1 })
  assert.match(poll, /\nStill working\. Tell the user briefly and call get_reply again/)
  withoutNext(poll)
  await controllerReply(id, 'done', 'Synced.')
})

test('a question round-trip carries in_reply_to', async () => {
  const id = idOf(await voiceCall('send', { message: 'Clean up the repo.' }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  await controllerReply(id, 'question', 'Should I delete the branches too, yes or no?')
  const out = await voiceCall('get_reply', { id })
  assert.match(out, /^\[state=question /)
  endsWith(
    out,
    `Claude Code is waiting for a decision. Read the question to the user and send their answer with send (in_reply_to=${id}).\n${NEXT_REQUEST}`,
  )

  const answered = await voiceCall('send', { message: 'No, only the files.', in_reply_to: id.toUpperCase() })
  assert.match(answered, new RegExp(`^\\[state=sent id=[a-z0-9]{4}\\] Handed over as the answer to ${id}\\.`))
  withoutNext(answered)
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
  assert.match(out, /\nRead the approval to the user and ask: allow or deny\? Call approve with the code only after their explicit yes or no\.\n/)
  assert.doesNotMatch(out, FILLERS)
  withoutNext(out)

  const pending = await voiceCall('status')
  assert.match(pending, /Pending approvals: abcde \(Write\)/)
  withoutNext(pending)

  const approved = await voiceCall('approve', { code: 'ABCDE', decision: 'allow' })
  assert.match(approved, /^\[approval=allow code=abcde\]/)
  withoutNext(approved)
  const verdict = await waitUntil(() => verdicts.find(v => v.request_id === 'abcde'))
  assert.equal(verdict.behavior, 'allow')

  const again = await voiceCall('approve', { code: 'abcde', decision: 'deny' })
  assert.match(again, /unknown or already answered/)
  assert.equal(verdicts.filter(v => v.request_id === 'abcde').length, 1)

  // An approval with the answer: what the user says next answers the
  // approval, so no line about their next request.
  await controllerReply(id, 'done', 'Created.')
  await claudeCode.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'fghjk', tool_name: 'Write', description: 'Create playground/bye.txt', input_preview: '{}' },
  })
  await waitUntil(() => gatewayLog.includes('permission_request code=fghjk'))
  const done = await voiceCall('get_reply', { id, wait_seconds: 1 })
  assert.match(done, /^\[state=done id=\w+ elapsed=\d+s approval=fghjk\]/)
  withoutNext(done)
  withoutNext(await voiceCall('approve', { code: 'fghjk', decision: 'deny' }))
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
  const news = await voiceCall('status')
  assert.match(news, /News from Claude Code \(id=\w+\): You were away; nothing happened\./)
  endsWith(news, `Read the news to the user.\n${NEXT_REQUEST}`)
})

test('night mode until a time the driver names: set_away with until; past, unreadable or too far changes nothing; again while on, the new end', async () => {
  const controller = async (name, args) => claudeCode.callTool({ name, arguments: args })
  const two = n => String(n).padStart(2, '0')
  const hhmm = ms => `${two(new Date(ms).getHours())}:${two(new Date(ms).getMinutes())}`
  const local = ms => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${hhmm(ms)}`
  }
  const hour = 3600 * 1000
  const kinds = kind => channelEvents.filter(e => e.meta?.kind === kind)
  const [nights, mornings] = [kinds('night').length, kinds('morning').length]
  const id = idOf(await voiceCall('send', { message: 'Do not disturb until tomorrow morning at nine.' }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === id))
  const words = 'Do not disturb until tomorrow morning'
  for (const [until, why] of [
    ['tomorrow at nine', /"tomorrow at nine" is no time: name a clock time such as 09:00, or a date and time such as 2026-11-03T09:00\./],
    ['25:00', /"25:00" is no time/],
    [local(Date.now() - hour), /has passed already: the end must lie in the future\./],
    [local(Date.now() + 72 * hour), /is more than 48 hours ahead: night mode goes at most until /],
  ]) {
    const result = await controller('set_away', { away: true, until, words })
    assert.equal(result.isError, true, until)
    assert.match(resultText(result), /^\[night=invalid\] Nothing changed: /, until)
    assert.match(resultText(result), why, until)
    assert.match(resultText(result), /call set_away without until for the usual end \(the end of the quiet hours, or 12 hours\)\.$/)
  }
  assert.doesNotMatch(resultText(await controller('open_items', {})), /Night mode/, 'still off')
  assert.match(gatewayLog, /set_away refused, until/)
  // The driver's words still come first.
  assert.match(resultText(await controller('set_away', { away: true, until: '25:00', words: 'nobody said this' })), /^\[night=needs_driver\]/)

  const first = hhmm(Date.now() + 3 * hour)
  const on = resultText(await controller('set_away', { away: true, until: first, words }))
  assert.match(on, new RegExp(`^\\[night=on until=${first}.*\\] Night mode is on since \\d\\d:\\d\\d, as the driver said, until ${first}.*Tell the driver good night`))
  const night = await waitUntil(() => kinds('night')[nights])
  await controllerReply(night.meta.request_id, 'done', 'ok')
  assert.match(gatewayLog, /night mode on, by voice, until \S+, as the driver named it/)

  // Longer, while it is on: the new end, the same night.
  const longer = Date.now() + 30 * hour
  const again = resultText(await controller('set_away', { away: true, until: local(longer), words }))
  assert.match(again, new RegExp(`^\\[night=on until=${hhmm(longer)} on \\d+ \\w+\\] .*It was on already and now holds until then: tell the driver in a sentence\\.`))
  assert.match(resultText(await controller('open_items', {})), new RegExp(`\\n- Night mode is on since \\d\\d:\\d\\d, as the driver said, until ${hhmm(longer)} on `))
  assert.equal(kinds('night').length, nights + 1, 'the same night')
  await controllerReply(id, 'done', 'Do not disturb until tomorrow at nine.')

  // "I'm back" ends it at once, as before.
  const back = idOf(await voiceCall('send', { message: "I'm back, good morning." }))
  await waitUntil(() => channelEvents.find(e => e.meta?.request_id === back))
  assert.match(resultText(await controller('set_away', { away: false, until: first, words: "I'm back" })), /^\[night=off\] Night mode is off\./)
  const morning = await waitUntil(() => kinds('morning')[mornings])
  await controllerReply(morning.meta.request_id, 'done', 'Nothing happened.')
  await controllerReply(back, 'done', 'Welcome back.')
  assert.doesNotMatch(resultText(await controller('open_items', {})), /Night mode/)
  assert.match(await voiceCall('status'), /News from Claude Code \(id=\w+\): Nothing happened\./)
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
