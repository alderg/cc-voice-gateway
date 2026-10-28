// Telegram as a fallback return channel: once the voice mode has ended,
// results, questions and approvals also go to Telegram.
//
// A local HTTP server stands in for the Telegram Bot API; no test sends a real
// message. The fallback itself is tested with a Store and a fake send, the
// gateway as a whole with the stand-in API, a fake Claude Code and a fake
// voice client, as in e2e.test.mjs.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'
import { Store } from '../src/store.mjs'
import { Telegram, TelegramFallback, loadTelegram } from '../src/telegram.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-telegram-'))
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT_ID = '4242'
const AFTER = 0.2 // seconds without a voice call, for the fallback tests

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- the stand-in Telegram Bot API -----------------------------------------

const api = { messages: [], requests: 0, mode: 'ok', server: null, url: '' }

before(async () => {
  api.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      api.requests++
      if (api.mode === 'drop') return req.socket.destroy()
      const message = { path: req.url, ...JSON.parse(body || '{}') }
      const sent = api.mode === 'ok' && req.url === `/bot${TOKEN}/sendMessage`
      if (sent) api.messages.push(message)
      res.writeHead(sent ? 200 : 400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          sent
            ? { ok: true, result: { message_id: api.messages.length } }
            : { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
        ),
      )
    })
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  api.url = `http://127.0.0.1:${api.server.address().port}`
})

after(() => {
  api.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

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

// --- the fallback, with a Store and a fake send ------------------------------

function fallback({ fail = false } = {}) {
  const store = new Store()
  const sent = []
  const logged = []
  const telegram = new TelegramFallback(store, {
    afterSeconds: AFTER,
    log: (...parts) => logged.push(parts.join(' ')),
    send: async text => {
      if (fail) throw new Error('503 Service Unavailable')
      sent.push(text)
    },
  })
  // A voice tool call, like get_reply: started, then ended.
  const voiceCall = (work = () => {}) => {
    store.voiceCallStarted()
    try {
      return work()
    } finally {
      store.voiceCallEnded()
    }
  }
  return { store, sent, logged, telegram, voiceCall }
}

test('activation: only when both secret files are set and not empty', () => {
  const dir = join(TMP, 'activation')
  mkdirSync(dir)
  const files = { tokenFile: join(dir, 'telegram_token'), chatIdFile: join(dir, 'telegram_chat_id') }
  assert.equal(loadTelegram(files), null, 'no files')
  writeFileSync(files.tokenFile, `${TOKEN}\n`)
  assert.equal(loadTelegram(files), null, 'token only')
  writeFileSync(files.chatIdFile, '  \n')
  assert.equal(loadTelegram(files), null, 'empty chat id')
  writeFileSync(files.chatIdFile, `${CHAT_ID}\n`)
  const telegram = loadTelegram(files)
  assert.ok(telegram instanceof Telegram)
  assert.equal(telegram.chatId, CHAT_ID)
  rmSync(files.tokenFile)
  assert.equal(loadTelegram(files), null, 'chat id only')
})

test('while the voice client polls, nothing goes to Telegram', async () => {
  const { store, sent, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('How many files are there?'))
  store.addUpdate(request.id, 'done', 'Three files.')
  await sleep(AFTER * 500)
  voiceCall(() => store.takeUnread(request))
  await sleep(AFTER * 1000 + 100)
  assert.deepEqual(sent, [], 'the voice client got the result in time')
  telegram.close()
})

test('after the timeout, results, questions and approvals go out once each; working does not', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('How many files are in the playground?'))
  store.addUpdate(request.id, 'working', 'Looking.')
  assert.deepEqual(sent, [])

  // Answered while the voice mode was still on, but never polled.
  store.addUpdate(request.id, 'done', 'There are three files.')
  await waitFor(() => sent.length === 1)
  assert.match(sent[0], /^Result for request [a-z0-9]{4} \("How many files are in the playground\?"\)\n\nThere are three files\.$/)
  assert.ok(logged.some(line => /voice mode ended .*telegram fallback on/.test(line)))

  // After the switch, new items go out right away.
  const worker = store.createRequest('Worker cc-voice-gateway finished task t3cz: done after 2 minutes.', {
    origin: 'worker',
    worker: { repo: 'cc-voice-gateway', task: 't3cz' },
  })
  store.addUpdate(worker.id, 'working', 'Reading the result.')
  store.addUpdate(worker.id, 'question', 'The tests pass. Should I open a pull request?')
  store.addPermission({
    request_id: 'abcde',
    tool_name: 'Write',
    description: 'Create playground/hello.txt.',
    input_preview: '{"file_path": "playground/hello.txt"}',
  })
  await waitFor(() => sent.length === 3)
  assert.match(sent[1], new RegExp(`^Question for request ${worker.id} \\(worker cc-voice-gateway, task t3cz\\)\n`))
  assert.match(sent[1], new RegExp(`Answer in voice mode and mention ${worker.id}\\.$`))
  assert.match(sent[2], /^Approval request abcde \(controller session\)\n\nWrite: Create playground\/hello\.txt\nDetails: /)
  assert.ok(!sent.join('\n').includes('Looking') && !sent.join('\n').includes('Reading the result'))

  // No duplicates, however often the store changes or the timer runs.
  store.changed()
  await sleep(AFTER * 1000 + 100)
  store.changed()
  assert.equal(sent.length, 3)
  telegram.close()
})

test('no duplicates when the voice client polls the same result later', async () => {
  const { store, sent, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('Run the tests.'))
  await sleep(AFTER * 1000 + 100)
  store.addUpdate(request.id, 'done', 'All 44 tests pass.')
  await waitFor(() => sent.length === 1)

  // The voice mode comes back and reads it too, then ends again.
  const read = voiceCall(() => store.takeUnread(request))
  assert.equal(read[0].text, 'All 44 tests pass.')
  voiceCall(() => store.takeUnread(request))
  await sleep(AFTER * 1000 + 100)
  store.changed()
  assert.equal(sent.length, 1)
  telegram.close()
})

test('when polling resumes, Telegram stops until the voice mode ends again', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback()
  const first = voiceCall(() => store.createRequest('First.'))
  await sleep(AFTER * 1000 + 100)
  store.addUpdate(first.id, 'done', 'First answer.')
  await waitFor(() => sent.length === 1)

  // A long poll is running: the voice mode is on again, however long it waits.
  store.voiceCallStarted()
  assert.ok(logged.some(line => /voice mode on: telegram fallback paused/.test(line)))
  const second = store.createRequest('Second.')
  store.addUpdate(second.id, 'done', 'Second answer.')
  await sleep(AFTER * 1000 + 100)
  assert.equal(sent.length, 1, 'nothing while a voice call is running')
  store.voiceCallEnded()
  await sleep(AFTER * 500)
  assert.equal(sent.length, 1, 'nothing within the timeout after the call')

  // The voice client did not take the second answer; once the voice mode has
  // ended again, it goes out.
  await waitFor(() => sent.length === 2)
  assert.match(sent[1], /Second answer\./)
  telegram.close()
})

test('approvals the voice client has heard are not sent', async () => {
  const { store, sent, telegram } = fallback()
  store.voiceCallStarted()
  store.addPermission({ request_id: 'fghjk', tool_name: 'Bash', description: 'Run ls', input_preview: '' })
  for (const permission of store.openPermissions()) permission.announced = true // what get_reply does
  store.voiceCallEnded()
  await sleep(AFTER * 1000 + 100)
  store.changed()
  assert.deepEqual(sent, [])
  telegram.close()
})

test('a failing Telegram call is logged and changes nothing for the voice path', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback({ fail: true })
  const request = voiceCall(() => store.createRequest('Anything new?'))
  await sleep(AFTER * 1000 + 100)
  assert.equal(store.addUpdate(request.id, 'done', 'Nothing new.').state, 'done')
  await waitFor(() => logged.some(line => line.includes('telegram send failed')))
  assert.match(logged.find(line => line.includes('telegram send failed')), /Result for request .* - 503 Service Unavailable/)
  assert.deepEqual(sent, [])
  // The voice client still gets the answer, and the failed item is not retried.
  assert.equal(voiceCall(() => store.takeUnread(request))[0].text, 'Nothing new.')
  store.changed()
  await sleep(50)
  assert.equal(logged.filter(line => line.includes('telegram send failed')).length, 1)
  telegram.close()
})

// --- the Telegram client against the stand-in API ----------------------------

test('after a restart: nothing is sent twice, and what is left waits for the voice client first', async () => {
  const file = join(TMP, 'restart', 'requests.json')
  const options = send => ({ afterSeconds: AFTER, log: () => {}, send: async text => send.push(text) })
  const first = new Store({ file })
  const sentBefore = []
  const before = new TelegramFallback(first, options(sentBefore))
  first.voiceCallStarted()
  const request = first.createRequest('Run the tests.')
  first.voiceCallEnded()
  first.addUpdate(request.id, 'done', 'All pass.')
  await waitFor(() => sentBefore.length === 1) // sent when the voice mode ended, not on a change
  before.close()

  const second = new Store({ file })
  second.addUpdate(request.id, 'question', 'Push it as well?')
  const sentAfter = []
  const after = new TelegramFallback(second, options(sentAfter))
  await sleep(AFTER * 500)
  assert.deepEqual(sentAfter, [], 'the voice client gets its time after the restart')
  await waitFor(() => sentAfter.length === 1)
  await sleep(100)
  assert.equal(sentAfter.length, 1, 'only the new question, not the result sent before the restart')
  assert.match(sentAfter[0], /^Question for request/)
  after.close()
})

test('Telegram.send posts to the chat; errors carry no token', async () => {
  api.mode = 'ok'
  const telegram = new Telegram({ token: TOKEN, chatId: CHAT_ID, apiBase: api.url })
  await telegram.send('Hello')
  assert.deepEqual(api.messages.at(-1), { path: `/bot${TOKEN}/sendMessage`, chat_id: CHAT_ID, text: 'Hello' })

  api.mode = 'reject'
  await assert.rejects(telegram.send('Hello'), error => {
    assert.equal(error.message, '400 Bad Request: chat not found')
    return true
  })
  api.mode = 'drop'
  await assert.rejects(telegram.send('Hello'), error => !error.message.includes(TOKEN))
  // Nothing listens there; the address is not in the message either way.
  const nowhere = new Telegram({ token: TOKEN, chatId: CHAT_ID, apiBase: 'http://127.0.0.1:1' })
  await assert.rejects(nowhere.send('Hello'), error => !error.message.includes(TOKEN))
  api.mode = 'ok'
})

// --- the gateway as a whole ------------------------------------------------

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startGateway(name, { telegram }) {
  const secrets = join(TMP, name)
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  if (telegram) {
    writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`, { mode: 0o600 })
    writeFileSync(join(secrets, 'telegram_chat_id'), CHAT_ID, { mode: 0o600 })
  }
  const port = await freePort()
  const gw = { events: [], log: '' }
  gw.claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  gw.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => gw.events.push(params),
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: join(secrets, 'state'),
      VOICE_GW_WORKER_ROOT: join(secrets, 'no-repositories'),
      VOICE_GW_PORT: String(port),
      VOICE_GW_MAX_WAIT: '3',
      VOICE_GW_DEFAULT_WAIT: '1',
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_TELEGRAM_AFTER: '1',
      VOICE_GW_TELEGRAM_API: api.url,
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (gw.log += chunk))
  await gw.claudeCode.connect(stdio)
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await sleep(50)
    }
  }
  const { access_token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name })
  gw.voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await gw.voice.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    }),
  )
  gw.call = async (tool, args = {}) =>
    (await gw.voice.callTool({ name: tool, arguments: args })).content.map(c => c.text).join('\n')
  gw.reply = (request_id, state, text) =>
    gw.claudeCode.callTool({ name: 'reply', arguments: { request_id, state, text } })
  gw.close = async () => {
    await gw.voice.close()
    await gw.claudeCode.close()
  }
  return gw
}

const idOf = out => /id=([a-z0-9]+)/.exec(out)?.[1]

test('gateway without the secret files: one info line, no Telegram', async () => {
  const before = api.requests
  const gw = await startGateway('without', { telegram: false })
  try {
    const id = idOf(await gw.call('send', { message: 'Hello?' }))
    await sleep(1300)
    await gw.reply(id, 'done', 'Hello.')
    await sleep(200)
    assert.equal(api.requests, before, 'no call to the Telegram API')
    assert.deepEqual(gw.log.match(/telegram.*/g), ['telegram fallback off: telegram_token and telegram_chat_id not both set'])
    assert.match(await gw.call('get_reply', { id }), /Hello\./)
  } finally {
    await gw.close()
  }
})

test('gateway with Telegram: sends after the voice mode ended, survives a failing API, never logs the token', async () => {
  api.mode = 'ok'
  api.messages.length = 0
  const gw = await startGateway('with', { telegram: true })
  try {
    assert.match(gw.log, /telegram fallback ready: after 1 s without a voice call/)

    // While the voice client polls, the answer goes by voice only.
    const first = idOf(await gw.call('send', { message: 'Is the build green?' }))
    await gw.reply(first, 'done', 'Yes, green.')
    assert.match(await gw.call('get_reply', { id: first }), /Yes, green\./)

    // The voice mode ends; the result goes to Telegram, and to the voice client too.
    const second = idOf(await gw.call('send', { message: 'Run the tests.' }))
    await gw.reply(second, 'working', 'Running.')
    await sleep(1300)
    await gw.reply(second, 'done', 'All tests pass.')
    await waitFor(() => api.messages.length === 1)
    assert.equal(api.messages[0].chat_id, CHAT_ID)
    assert.match(api.messages[0].text, new RegExp(`^Result for request ${second} \\("Run the tests\\."\\)\n\nAll tests pass\\.$`))
    const polled = await gw.call('get_reply', { id: second })
    assert.match(polled, /All tests pass\./)

    // The API fails: logged without the token, the voice path goes on.
    api.mode = 'reject'
    const third = idOf(await gw.call('send', { message: 'Anything else?' }))
    await sleep(1300)
    assert.equal((await gw.reply(third, 'done', 'Nothing else.')).isError, false)
    await waitFor(() => gw.log.includes('telegram send failed'))
    assert.match(gw.log, /telegram send failed: Result for request \w+ .* - 400 Bad Request: chat not found/)
    assert.match(await gw.call('get_reply', { id: third }), /Nothing else\./)
    assert.equal(api.messages.length, 1, 'no message twice')
    assert.ok(!gw.log.includes(TOKEN), 'the token never reaches the log')
  } finally {
    api.mode = 'ok'
    await gw.close()
  }
})
