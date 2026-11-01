// Telegram as a fallback return channel: once the voice mode has ended,
// questions and approvals also go to Telegram. Results never do; they wait
// for the next voice call. The driver's answers come back: a Reply to a
// question, or a message with its code, reaches the controller as their
// answer, and the controller's replies to it go back to the chat.
//
// A local HTTP server stands in for the Telegram Bot API; no test sends a real
// message. The fallback itself is tested with a Store and a fake send, the
// gateway as a whole with the stand-in API, a fake Claude Code and a fake
// voice client, as in e2e.test.mjs.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { getEventListeners } from 'node:events'
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
import { spokenByDriver } from '../src/channel.mjs'
import { telegramAnswersMode } from '../src/config.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Store } from '../src/store.mjs'
import { Telegram, TelegramAnswers, TelegramCommands, TelegramFallback, callBotApi, loadTelegram, pause } from '../src/telegram.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-telegram-'))
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT_ID = '4242'
const AFTER = 0.2 // seconds without a voice call, for the fallback tests

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- the stand-in Telegram Bot API -----------------------------------------

// updates: null, getUpdates fails as any other call does; a list, it hands
// out what the test put there, as the driver's messages.
const api = { messages: [], requests: 0, mode: 'ok', server: null, url: '', updates: null, nextUpdate: 1 }

// A message from the driver's chat, a Reply to `replyTo` if given.
function driverSays(text, { replyTo = null, messageId = 1000 + api.nextUpdate } = {}) {
  const message = { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(CHAT_ID), type: 'private' }, text }
  if (replyTo !== null) message.reply_to_message = { message_id: replyTo, from: { is_bot: true } }
  api.updates.push({ update_id: api.nextUpdate++, message })
  return messageId
}

before(async () => {
  api.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      api.requests++
      if (api.mode === 'drop') return req.socket.destroy()
      if (api.mode === 'ok' && api.updates && req.url === `/bot${TOKEN}/getUpdates`) {
        const { offset = 0 } = JSON.parse(body || '{}')
        for (let i = 0; i < 10 && !api.updates?.some(u => u.update_id >= offset); i++) await sleep(50)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, result: (api.updates ?? []).filter(u => u.update_id >= offset) }))
      }
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
  store.addUpdate(request.id, 'question', 'In the playground or everywhere?')
  await sleep(AFTER * 500)
  voiceCall(() => store.takeUnread(request))
  await sleep(AFTER * 1000 + 100)
  assert.deepEqual(sent, [], 'the voice client got the question in time')
  telegram.close()
})

test('voice calls within the window keep everything off Telegram, however long the conversation', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('Run the tests.'))
  store.addUpdate(request.id, 'question', 'All of them, or only the unit tests?')
  store.addPermission({ request_id: 'qwert', tool_name: 'Bash', description: 'Run ls', input_preview: '' })

  // Calls that read nothing of it (status, another request), each within the
  // window, for several windows in a row.
  for (let i = 0; i < 6; i++) {
    await sleep(AFTER * 500)
    voiceCall(() => {})
  }
  assert.deepEqual(sent, [], 'nothing while the gaps stay below the window')
  assert.ok(!logged.some(line => /voice mode ended/.test(line)), 'the voice mode never ended')

  // The calls stop: after the window, what needs the driver goes out.
  await waitFor(() => sent.length === 2)
  assert.match(sent[0], new RegExp(`^Question for request ${request.id} \\("Run the tests\\."\\)\n\nAll of them, or only the unit tests\\?\n\nAnswer in voice mode and mention ${request.id}\\.$`))
  assert.match(sent[1], /^Approval request qwert /)
  telegram.close()
})

test('after the silence, a result alone sends nothing', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('How many files are in the playground?'))
  store.addUpdate(request.id, 'working', 'Looking.')

  // Answered while the voice mode was still on, but never polled.
  store.addUpdate(request.id, 'done', 'There are three files.')
  await waitFor(() => logged.some(line => /voice mode ended .*telegram fallback on for questions and approvals/.test(line)))
  // Results after the switch, from the controller and from a worker, stay off Telegram too.
  const worker = store.createRequest('Worker alpha finished task t3cz: done after 2 minutes.', {
    origin: 'worker',
    worker: { repo: 'alpha', task: 't3cz' },
  })
  store.addUpdate(worker.id, 'done', 'Pull request 12 in alpha is out.')
  store.changed()
  await sleep(AFTER * 1000 + 100)
  store.changed()
  assert.deepEqual(sent, [], 'results wait for the voice client')

  // The next voice call still gets them.
  assert.equal(voiceCall(() => store.takeUnread(request)).at(-1).text, 'There are three files.')
  assert.equal(voiceCall(() => store.takeUnread(worker))[0].text, 'Pull request 12 in alpha is out.')
  telegram.close()
})

test('after the silence, questions and approvals go out once each; results and working do not', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('How many files are in the playground?'))
  store.addUpdate(request.id, 'working', 'Looking.')
  assert.deepEqual(sent, [])

  // Asked while the voice mode was still on, but never polled.
  store.addUpdate(request.id, 'question', 'Count the hidden files too?')
  await waitFor(() => sent.length === 1)
  assert.match(sent[0], /^Question for request [a-z0-9]{4} \("How many files are in the playground\?"\)\n\nCount the hidden files too\?\n\nAnswer in voice mode and mention [a-z0-9]{4}\.$/)
  assert.ok(logged.some(line => /voice mode ended .*telegram fallback on/.test(line)))

  // After the switch, new questions and approvals go out right away; results do not.
  const worker = store.createRequest('Worker cc-voice-gateway finished task t3cz: done after 2 minutes.', {
    origin: 'worker',
    worker: { repo: 'cc-voice-gateway', task: 't3cz' },
  })
  store.addUpdate(worker.id, 'working', 'Reading the result.')
  store.addUpdate(worker.id, 'question', 'The tests pass. Should I open a pull request?')
  const other = store.createRequest('Worker alpha finished task t4ab: done after 1 minute.', {
    origin: 'worker',
    worker: { repo: 'alpha', task: 't4ab' },
  })
  store.addUpdate(other.id, 'done', 'The README typo is fixed.')
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
  const all = sent.join('\n')
  assert.ok(!all.includes('Looking') && !all.includes('Reading the result') && !all.includes('README typo'))
  assert.ok(!/^Result/m.test(all))

  // No duplicates, however often the store changes or the timer runs.
  store.changed()
  await sleep(AFTER * 1000 + 100)
  store.changed()
  assert.equal(sent.length, 3)
  telegram.close()
})

test('a question the controller has settled since is not sent', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('Clean up the playground.'))
  store.addUpdate(request.id, 'question', 'Delete the notes too?')
  store.addUpdate(request.id, 'done', 'Never mind, the notes were empty; all clean.')
  const answered = voiceCall(() => store.createRequest('Rename the notes.'))
  store.addUpdate(answered.id, 'question', 'To what name?')
  store.markAnswered(answered, 'zzzz') // the driver answered with a new request
  await waitFor(() => logged.some(line => /voice mode ended/.test(line)))
  await sleep(100)
  store.changed()
  assert.deepEqual(sent, [])
  telegram.close()
})

test('no duplicates when the voice client polls the same question later', async () => {
  const { store, sent, telegram, voiceCall } = fallback()
  const request = voiceCall(() => store.createRequest('Run the tests.'))
  await sleep(AFTER * 1000 + 100)
  store.addUpdate(request.id, 'question', 'Two tests fail. Fix them?')
  await waitFor(() => sent.length === 1)

  // The voice mode comes back and reads it too, then ends again.
  const read = voiceCall(() => store.takeUnread(request))
  assert.equal(read[0].text, 'Two tests fail. Fix them?')
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
  store.addUpdate(first.id, 'question', 'First question?')
  await waitFor(() => sent.length === 1)

  // A long poll is running: the voice mode is on again, however long it waits.
  store.voiceCallStarted()
  assert.ok(logged.some(line => /voice mode on: telegram fallback paused/.test(line)))
  const second = store.createRequest('Second.')
  store.addUpdate(second.id, 'question', 'Second question?')
  await sleep(AFTER * 1000 + 100)
  assert.equal(sent.length, 1, 'nothing while a voice call is running')
  store.voiceCallEnded()
  await sleep(AFTER * 500)
  assert.equal(sent.length, 1, 'nothing within the timeout after the call')

  // The voice client did not take the second question; once the voice mode
  // has ended again, it goes out.
  await waitFor(() => sent.length === 2)
  assert.match(sent[1], /Second question\?/)
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

test('an approval sent here and answered at the computer since: said once, also while the voice mode is on; one never sent here, not at all', async () => {
  const { store, sent, telegram } = fallback()
  store.addPermission({ request_id: 'bdozq', tool_name: 'Monitor', description: 'Watch the build log', input_preview: '' })
  await waitFor(() => sent.length === 1)
  assert.match(sent[0], /^Approval request bdozq \(controller session\)/)

  store.voiceCallStarted()
  assert.deepEqual(store.closePermissionsElsewhere().map(p => p.code), ['bdozq'])
  await waitFor(() => sent.length === 2)
  assert.equal(sent[1], 'Approval request bdozq was answered at the computer; nothing to do.')
  assert.deepEqual(store.closePermissionsElsewhere(), [], 'closed already')
  assert.equal(store.getPermission('BDOZQ').status, 'elsewhere')
  assert.equal(store.resolvePermission('bdozq', 'allow'), null, 'no verdict for it any more')

  // Heard by voice only: closed without a word here.
  store.addPermission({ request_id: 'fghjk', tool_name: 'Bash', description: 'Run ls', input_preview: '' })
  for (const permission of store.openPermissions()) permission.announced = true // what get_reply does
  store.voiceCallEnded()
  store.closePermissionsElsewhere()
  await sleep(AFTER * 1000 + 100)
  store.changed()
  assert.equal(sent.length, 2)
  assert.deepEqual(store.takeAnsweredElsewhere().map(p => p.code), ['fghjk'], 'the voice client hears it, once')
  assert.deepEqual(store.takeAnsweredElsewhere(), [])
  telegram.close()
})

test('a failing Telegram call is logged and changes nothing for the voice path', async () => {
  const { store, sent, logged, telegram, voiceCall } = fallback({ fail: true })
  const request = voiceCall(() => store.createRequest('Anything new?'))
  await sleep(AFTER * 1000 + 100)
  assert.equal(store.addUpdate(request.id, 'question', 'Since when?').state, 'question')
  await waitFor(() => logged.some(line => line.includes('telegram send failed')))
  assert.match(logged.find(line => line.includes('telegram send failed')), /Question for request .* - 503 Service Unavailable/)
  assert.deepEqual(sent, [])
  // The voice client still gets the question, and the failed item is not retried.
  assert.equal(voiceCall(() => store.takeUnread(request))[0].text, 'Since when?')
  store.changed()
  await sleep(50)
  assert.equal(logged.filter(line => line.includes('telegram send failed')).length, 1)
  telegram.close()
})

test('after a restart: what the voice client heard is not sent, even when it read it late', async () => {
  const file = join(TMP, 'heard', 'requests.json')
  const options = send => ({ afterSeconds: AFTER, log: () => {}, send: async text => send.push(text) })
  const first = new Store({ file, log: () => {} })
  const sentBefore = []
  const before = new TelegramFallback(first, options(sentBefore))
  first.voiceCallStarted()
  // A worker's question: unlike a voice request, a restart leaves it open.
  const request = first.createRequest('Worker alpha finished task t5cd: done after 3 minutes.', {
    origin: 'worker',
    worker: { repo: 'alpha', task: 't5cd' },
  })
  first.addUpdate(request.id, 'question', 'The build is green. Open a pull request?')
  await sleep(150) // the change is saved; reading it later is no change
  first.takeUnread(request)
  first.voiceCallEnded()
  await sleep(150)
  before.close()

  const second = new Store({ file, log: () => {} })
  const sentAfter = []
  const after = new TelegramFallback(second, options(sentAfter))
  await sleep(AFTER * 1000 + 150)
  second.changed()
  assert.deepEqual([...sentBefore, ...sentAfter], [], 'the voice client had it; Telegram never sends it')
  assert.equal(second.getRequest(request.id).state, 'question')
  after.close()
})

test("after a restart: a voice request's question stays open and still reaches Telegram, once", async () => {
  const file = join(TMP, 'voice-question', 'requests.json')
  const first = new Store({ file, log: () => {} })
  first.voiceCallStarted()
  const request = first.createRequest('Tidy up the playground.')
  first.addUpdate(request.id, 'question', 'Delete the old notes?')
  first.voiceCallEnded()
  first.save()

  const second = new Store({ file, log: () => {} })
  const sent = []
  const after = new TelegramFallback(second, { afterSeconds: AFTER, log: () => {}, send: async text => sent.push(text) })
  await waitFor(() => sent.length === 1)
  second.changed()
  await sleep(150)
  assert.equal(second.getRequest(request.id).state, 'question', 'the question survives the restart (ledger.mjs)')
  assert.equal(sent.length, 1)
  assert.match(sent[0], /Delete the old notes\?/)
  after.close()
})

test("the command loop's pause leaves no abort listener behind, and ends at once on abort", async () => {
  const controller = new AbortController()
  for (let i = 0; i < 30; i++) await pause(1, controller.signal)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const started = Date.now()
  const waiting = pause(60000, controller.signal)
  controller.abort()
  await waiting
  assert.ok(Date.now() - started < 1000)
})

// --- answers by Telegram ---------------------------------------------------------

// TelegramAnswers with a Store, a Ledger kept as the gateway keeps it, and
// fakes for the channel, the chat, the kill switch and the gateway's state.
function answering({ mode = 'on', held = () => '', push = null } = {}) {
  const store = new Store()
  const ledger = new Ledger({ log: () => {} })
  // As gateway.mjs: the decisions of the question keep the answer.
  store.on('answer', request =>
    ledger.answer(request.answers, { text: request.text.replace(/^\(Answer to [^)]*\)\s*/, ''), answerId: request.id }),
  )
  const t = { store, ledger, pushed: [], said: [], logged: [], killswitch: { locked: false }, active: true }
  t.answers = new TelegramAnswers({
    store,
    ledger,
    mode,
    held,
    killswitch: t.killswitch,
    presence: { state: () => (t.active ? { active: true } : { active: false, why: 'connector disconnected, in standby' }) },
    push: push ?? (async request => t.pushed.push(request)),
    say: async (text, replyTo) => t.said.push({ text, replyTo }),
    log: (...parts) => t.logged.push(parts.join(' ')),
  })
  // A question of the controller's, as a decision of `kind`; with message,
  // the id of the Telegram message that carried it.
  t.question = (text, { kind = 'other', message = null } = {}) => {
    const request = store.createRequest('Worker alpha finished task t3cz: done after 2 minutes.', {
      origin: 'worker',
      worker: { repo: 'alpha', task: 't3cz' },
    })
    store.addUpdate(request.id, 'question', text)
    ledger.ask(request.id, { kind, repo: 'alpha', text })
    if (message !== null) request.updates.at(-1).telegramMessage = message
    return request
  }
  t.lastSaid = () => t.said.at(-1)?.text
  return t
}

test('Telegram answers: a Reply to a question reaches the controller as the driver\'s answer, via="telegram", and its words count', async () => {
  const t = answering()
  const question = t.question('The tests pass. Open the pull request?', { kind: 'push', message: 11 })
  const [decision] = t.ledger.forRequest(question.id)

  const request = await t.answers.route({ text: '  Ja, öffne ihn bitte ', replyTo: 11, messageId: 12 })
  assert.equal(t.pushed.length, 1)
  assert.equal(t.pushed[0], request)
  assert.equal(request.text, `(Answer to ${question.id}) Ja, öffne ihn bitte`)
  assert.equal(request.origin, 'voice', "the driver's own request")
  assert.equal(request.via, 'telegram')
  assert.deepEqual(request.meta, { via: 'telegram' })
  assert.equal(request.answers, question.id)
  assert.equal(request.telegramMessage, 12, "the controller's replies answer the driver's message")
  assert.deepEqual(t.said, [{ text: `Passed on to the controller as your answer to ${question.id}.`, replyTo: 12 }])

  // Answered, as by voice: the question is settled, its decision keeps the answer.
  assert.equal(question.state, 'done')
  assert.equal(question.answeredBy, request.id)
  assert.equal(decision.state, 'answered')
  assert.equal(decision.answer, 'Ja, öffne ihn bitte')
  assert.equal(decision.answeredBy, request.id)

  // dispatch and resolve_decision take its words, as they do a spoken answer's.
  assert.equal(spokenByDriver(t.store, `(Answer to ${question.id}) Ja, öffne ihn bitte`, 30), request)
  assert.equal(spokenByDriver(t.store, 'öffne ihn', 30), request)
  assert.equal(spokenByDriver(t.store, `Answer to ${question.id}`, 30), false, "the gateway's words alone are not the driver's")

  // A second Reply to the same message: the question is not open any more.
  assert.equal(await t.answers.route({ text: 'Doch nicht.', replyTo: 11, messageId: 13 }), null)
  assert.equal(t.pushed.length, 1)
  assert.equal(t.lastSaid(), `Not passed on: question ${question.id} is not open any more: it was answered or settled. No question is open now.`)
  assert.equal(t.said.at(-1).replyTo, 13)
})

test('Telegram answers: without a Reply, the code of exactly one open question; no code, several, or one not open is not passed on, and the chat hears why', async () => {
  const t = answering()
  const first = t.question('Open the pull request?', { kind: 'push', message: 21 })
  const second = t.question('Delete the old branch too?') // heard by voice only: no message here
  const open = `Open: ${first.id} and ${second.id}. Reply to its message, or start yours with its code.`

  assert.equal(await t.answers.route({ text: 'ja', messageId: 30 }), null)
  assert.deepEqual(t.said.at(-1), { text: `Not passed on: it is no Reply to a question, and it names no open question by its code. ${open}`, replyTo: 30 })
  await t.answers.route({ text: `${first.id} ja, ${second.id} nein`, messageId: 31 })
  assert.equal(t.lastSaid(), `Not passed on: it names 2 open questions, ${first.id} and ${second.id}. Answer each in a message of its own.`)
  // A Reply to a message of the gateway's that holds no question, without a code.
  await t.answers.route({ text: 'ok', replyTo: 999, messageId: 32 })
  assert.equal(t.lastSaid(), `Not passed on: the message it replies to holds no question, and it names no open question by its code. ${open}`)
  // A Reply to an approval request: never an approval.
  t.store.addPermission({ request_id: 'qwert', tool_name: 'Bash', description: 'Run ls', input_preview: '' })
  t.store.getPermission('qwert').telegramMessage = 40
  await t.answers.route({ text: 'yes', replyTo: 40, messageId: 33 })
  assert.equal(t.lastSaid(), 'Not passed on: approval request qwert is answered in voice mode or at the computer; Telegram cannot approve.')
  assert.equal(t.store.getPermission('qwert').status, 'open')
  assert.deepEqual(t.pushed, [], 'nothing passed on so far')
  assert.equal(first.state, 'question')
  assert.equal(second.state, 'question')

  // The code, in capitals and anywhere in the message.
  const answer = await t.answers.route({ text: `Antwort ${second.id.toUpperCase()}: nein, lass ihn`, messageId: 34 })
  assert.equal(answer.text, `(Answer to ${second.id}) Antwort ${second.id.toUpperCase()}: nein, lass ihn`)
  assert.equal(second.state, 'done')
  assert.equal(t.lastSaid(), `Passed on to the controller as your answer to ${second.id}.`)
  // Answered now: its code alone is no open question any more.
  await t.answers.route({ text: `${second.id} doch`, messageId: 35 })
  assert.equal(
    t.lastSaid(),
    `Not passed on: ${second.id} has no open question. Open: ${first.id}. Reply to its message, or start yours with its code.`,
  )
  // A decision's code finds the question it was asked on; so does a Reply to another
  // message of the gateway's that names a code.
  const [decision] = t.ledger.forRequest(first.id)
  const byDecision = await t.answers.route({ text: `${decision.id} yes, open it`, replyTo: 999, messageId: 36 })
  assert.equal(byDecision.answers, first.id)
  assert.equal(decision.state, 'answered')
  assert.equal(t.pushed.length, 2)
  assert.ok(t.logged.some(line => line.startsWith('telegram answer not passed on: it names 2 open questions')))
})

test('Telegram answers: nothing past a locked kill switch or an inactive gateway; the usage limit is said', async () => {
  let wait = ''
  const t = answering({ held: () => wait })
  const question = t.question('Merge pull request 12?', { kind: 'merge', message: 50 })

  t.killswitch.locked = true
  await t.answers.route({ text: 'yes, merge it', replyTo: 50, messageId: 51 })
  assert.equal(t.lastSaid(), 'Not passed on: the kill switch is locked. It is unlocked only at the computer.')
  // An emergency phrase never gets here: TelegramCommands takes it as /stop first.
  t.killswitch.locked = false
  t.active = false
  await t.answers.route({ text: 'yes, merge it', replyTo: 50, messageId: 52 })
  assert.equal(t.lastSaid(), 'Not passed on: this gateway is inactive, connector disconnected, in standby.')
  assert.deepEqual(t.pushed, [])
  assert.equal(question.state, 'question', 'still open, for the voice')

  t.active = true
  wait = 'The controller waits for the usage limit until 15:00 and reads it then.'
  await t.answers.route({ text: 'yes, merge it', replyTo: 50, messageId: 53 })
  assert.equal(t.pushed.length, 1)
  assert.equal(
    t.lastSaid(),
    `Passed on to the controller as your answer to ${question.id}. The controller waits for the usage limit until 15:00 and reads it then.`,
  )

  // The channel gone: said, never thrown.
  const broken = answering({ push: async () => { throw new Error('Not connected') } })
  const other = broken.question('Restart the controller?', { kind: 'restart', message: 60 })
  assert.equal(await broken.answers.route({ text: 'yes, restart', replyTo: 60, messageId: 61 }), null)
  assert.equal(broken.lastSaid(), 'Not passed on: Not connected.')
  assert.ok(broken.logged.some(line => line === 'telegram answer failed: Not connected'))
  assert.equal(other.updates.length, 1)
})

test('VOICE_GW_TELEGRAM_ANSWERS: on by default; other leaves push, merge, restart and delete decisions to the voice; 0 off', async () => {
  for (const value of [undefined, '', '1', 'yes', 'on']) assert.equal(telegramAnswersMode(value), 'on', String(value))
  assert.equal(telegramAnswersMode(' Other '), 'other')
  assert.equal(telegramAnswersMode('0'), 'off')

  const on = answering()
  assert.equal(on.answers.accepts(on.question('Push alpha?', { kind: 'push' })), true)

  const t = answering({ mode: 'other' })
  for (const kind of ['push', 'merge', 'restart', 'delete']) {
    const question = t.question(`A ${kind} question?`, { kind, message: 70 })
    assert.equal(t.answers.accepts(question), false, kind)
    await t.answers.route({ text: `${question.id} yes`, messageId: 71 })
    assert.equal(
      t.lastSaid(),
      `Not passed on: ${question.id} is a ${kind} decision, which takes your voice (VOICE_GW_TELEGRAM_ANSWERS=other). ` +
        `Answer it in voice mode and mention ${question.id}.`,
    )
    assert.equal(question.state, 'question')
  }
  assert.deepEqual(t.pushed, [])
  const plain = t.question('Use tabs or spaces?')
  assert.equal(t.answers.accepts(plain), true)
  assert.equal((await t.answers.route({ text: `${plain.id} spaces`, messageId: 72 })).answers, plain.id)

  // The question's message says how it can be answered.
  const sent = []
  const fallback = new TelegramFallback(t.store, {
    afterSeconds: AFTER,
    log: () => {},
    answerable: request => t.answers.accepts(request),
    send: async text => sent.push(text),
  })
  const push = t.question('Push beta?', { kind: 'push' })
  const other = t.question('Rename it?')
  await waitFor(() => sent.some(text => text.includes(push.id)) && sent.some(text => text.includes(other.id)))
  assert.match(sent.find(text => text.includes(push.id)), new RegExp(`\n\nAnswer in voice mode and mention ${push.id}\\.$`))
  assert.match(
    sent.find(text => text.includes(other.id)),
    new RegExp(`\n\nTo answer, reply to this message, or write a message that starts with ${other.id}\\. Or answer in voice mode and mention ${other.id}\\.$`),
  )
  fallback.close()
})

test('the command loop: a Reply is an answer whatever it says, unless a stop or a slash command; other text only with answers on', () => {
  const heard = []
  const listen = commands => {
    for (const name of ['stop', 'funnel', 'away', 'stats', 'answer', 'stale']) commands.on(name, event => heard.push([name, event]))
    return commands
  }
  const message = (text, { replyTo = null, age = 0, chat = 4242 } = {}) => ({
    message: {
      message_id: 500 + heard.length,
      text,
      date: Math.floor(Date.now() / 1000) - age,
      chat: { id: chat, type: 'private' },
      ...(replyTo === null ? {} : { reply_to_message: { message_id: replyTo } }),
    },
  })
  const commands = listen(new TelegramCommands({ chatId: '4242' }, { answers: true, log: () => {} }))
  commands.handle(message('Ja, öffne ihn', { replyTo: 7 }))
  commands.handle(message('good night', { replyTo: 7 }))
  commands.handle(message('8cep nein'))
  commands.handle(message('good night'))
  commands.handle(message('/stats', { replyTo: 7 }))
  commands.handle(message('Emergency stop', { replyTo: 7 }))
  commands.handle(message('/start'))
  commands.handle(message('Ja', { replyTo: 7, chat: 99 }))
  commands.handle(message('Ja', { replyTo: 7, age: 600 }))
  assert.deepEqual(
    heard.map(([name, event]) => [name, event.text, event.replyTo ?? null]),
    [
      ['answer', 'Ja, öffne ihn', 7],
      ['answer', 'good night', 7],
      ['answer', '8cep nein', null],
      ['away', 'good night', null],
      ['stats', '/stats', null],
      ['stop', 'Emergency stop', null],
      ['stale', 'Ja', null],
    ],
  )
  assert.equal(heard[0][1].messageId, 500)

  // Without answers, as before: only commands.
  heard.length = 0
  const before = listen(new TelegramCommands({ chatId: '4242' }, { log: () => {} }))
  before.handle(message('Ja, öffne ihn', { replyTo: 7 }))
  before.handle(message('8cep nein'))
  before.handle(message('good night', { replyTo: 7 }))
  assert.deepEqual(heard.map(([name]) => name), ['away'])
})

test("the fallback: a question keeps its message's id; the controller's replies to a Telegram answer go back there, voice mode, night or not, and are no news", async () => {
  const store = new Store()
  const sent = []
  let paused = false
  let held = false
  const fallback = new TelegramFallback(store, {
    afterSeconds: AFTER,
    log: () => {},
    paused: () => paused,
    held: () => held,
    send: async (text, options) => {
      sent.push({ text, replyTo: options?.replyTo ?? null })
      return { message_id: 100 + sent.length }
    },
  })
  const question = store.createRequest('Push the fix.')
  store.addUpdate(question.id, 'question', 'To main or as a pull request?')
  await waitFor(() => sent.length === 1)
  await waitFor(() => question.updates[0].telegramMessage === 101)

  // The driver answered there; the voice mode is on again, and it is night.
  store.voiceCallStarted()
  paused = true
  const answer = store.createRequest(`(Answer to ${question.id}) As a pull request.`, { answers: question.id, via: 'telegram' })
  answer.telegramMessage = 77
  store.markAnswered(question, answer.id)
  store.addUpdate(answer.id, 'working', 'On it.')
  store.addUpdate(answer.id, 'done', 'The pull request is on its way.')
  await waitFor(() => sent.length === 3)
  assert.deepEqual(sent.slice(1), [
    { text: `On your answer to ${question.id}, still working:\n\nOn it.`, replyTo: 77 },
    { text: `On your answer to ${question.id}:\n\nThe pull request is on its way.`, replyTo: 77 },
  ])
  assert.deepEqual(store.takeNews(), [], 'no news for the voice client')

  // A question back on it: with its code, and its own message id.
  store.addUpdate(answer.id, 'question', 'Open it as a draft?')
  await waitFor(() => sent.length === 4)
  assert.match(sent[3].text, new RegExp(`^Question for request ${answer.id} \\(on your answer to ${question.id}\\)\n\nOpen it as a draft\\?\n`))
  assert.equal(sent[3].replyTo, 77)
  await waitFor(() => answer.updates.at(-1).telegramMessage === 104)

  // In a standby they wait, and go after it.
  held = true
  store.addUpdate(answer.id, 'done', 'Opened as a draft.')
  await sleep(100)
  assert.equal(sent.length, 4)
  held = false
  store.changed()
  await waitFor(() => sent.length === 5)
  assert.equal(sent[4].text, `On your answer to ${question.id}:\n\nOpened as a draft.`)
  store.voiceCallEnded()
  fallback.close()
})

test('after a restart: a Reply still finds its question', async () => {
  const file = join(TMP, 'answers', 'requests.json')
  const first = new Store({ file, log: () => {} })
  const question = first.createRequest('Worker alpha finished task t7gh: done after 5 minutes.', {
    origin: 'worker',
    worker: { repo: 'alpha', task: 't7gh' },
  })
  first.addUpdate(question.id, 'question', 'Open the pull request?')
  question.updates[0].telegramMessage = 88
  first.save()

  const store = new Store({ file, log: () => {} })
  const pushed = []
  const answers = new TelegramAnswers({ store, push: async request => pushed.push(request), say: async () => {}, log: () => {} })
  const answer = await answers.route({ text: 'yes please', replyTo: 88, messageId: 89 })
  assert.equal(answer.text, `(Answer to ${question.id}) yes please`)
  assert.equal(store.getRequest(question.id).state, 'done')
  store.save()
  assert.equal(new Store({ file, log: () => {} }).getRequest(answer.id).telegramMessage, 89, 'kept for the replies')
})

// --- the Telegram client against the stand-in API ----------------------------

test('after a restart: nothing is sent twice, and what is left waits for the voice client first', async () => {
  const file = join(TMP, 'restart', 'requests.json')
  const options = send => ({ afterSeconds: AFTER, log: () => {}, send: async text => send.push(text) })
  const first = new Store({ file })
  const sentBefore = []
  const before = new TelegramFallback(first, options(sentBefore))
  first.voiceCallStarted()
  const request = first.createRequest('Worker alpha finished task t6ef: done after 4 minutes.', {
    origin: 'worker',
    worker: { repo: 'alpha', task: 't6ef' },
  })
  first.voiceCallEnded()
  first.addUpdate(request.id, 'question', 'All pass. Open a pull request?')
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
  assert.equal(sentAfter.length, 1, 'only the new question, not the one sent before the restart')
  assert.match(sentAfter[0], /^Question for request .*\n\nPush it as well\?\n/)
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

test('getUpdates and getMe go through the same call: errors with the status, never the token', async () => {
  api.mode = 'ok'
  const telegram = new Telegram({ token: TOKEN, chatId: CHAT_ID, apiBase: `${api.url}/` })
  for (const call of [() => telegram.getUpdates({ timeout: 0 }), () => telegram.getMe()]) {
    await assert.rejects(call(), error => {
      assert.equal(error.status, 400)
      assert.equal(error.message, '400 Bad Request: chat not found')
      return true
    })
  }
  api.mode = 'drop'
  await assert.rejects(telegram.getMe(), error => error.status === undefined && !error.message.includes(TOKEN))
  api.mode = 'ok'
  const result = await callBotApi({ apiBase: api.url, token: TOKEN, method: 'sendMessage', body: { chat_id: CHAT_ID, text: 'Direct' } })
  assert.deepEqual(result, { message_id: api.messages.length })
  assert.equal(api.messages.at(-1).text, 'Direct')
})

// --- the gateway as a whole ------------------------------------------------

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startGateway(name, { telegram, env = {} }) {
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
      ...env,
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

test('gateway with Telegram: questions after the voice mode ended, results never; survives a failing API, never logs the token', async () => {
  api.mode = 'ok'
  api.messages.length = 0
  const gw = await startGateway('with', { telegram: true })
  try {
    assert.match(gw.log, /telegram fallback ready: questions and approvals after 1 s without a voice call/)

    // While the voice client polls, the answer goes by voice only.
    const first = idOf(await gw.call('send', { message: 'Is the build green?' }))
    await gw.reply(first, 'done', 'Yes, green.')
    assert.match(await gw.call('get_reply', { id: first }), /Yes, green\./)

    // The voice mode ends; a result stays for the voice client.
    const second = idOf(await gw.call('send', { message: 'Run the tests.' }))
    await gw.reply(second, 'working', 'Running.')
    await sleep(1300)
    await gw.reply(second, 'done', 'All tests pass.')
    await sleep(300)
    assert.equal(api.messages.length, 0, 'no result on Telegram')
    assert.match(await gw.call('get_reply', { id: second }), /All tests pass\./)

    // A question goes to Telegram, and to the voice client too.
    const third = idOf(await gw.call('send', { message: 'Push the fix.' }))
    await sleep(1300)
    await gw.reply(third, 'question', 'To main or as a pull request?')
    await waitFor(() => api.messages.length === 1)
    assert.equal(api.messages[0].chat_id, CHAT_ID)
    assert.match(
      api.messages[0].text,
      new RegExp(
        `^Question for request ${third} \\("Push the fix\\."\\)\n\nTo main or as a pull request\\?\n\nTo answer, reply to this ` +
          `message, or write a message that starts with ${third}\\. Or answer in voice mode and mention ${third}\\.$`,
      ),
    )
    assert.match(await gw.call('get_reply', { id: third }), /To main or as a pull request\?/)

    // The API fails: logged without the token, the voice path goes on.
    api.mode = 'reject'
    const fourth = idOf(await gw.call('send', { message: 'Anything else?' }))
    await sleep(1300)
    assert.equal((await gw.reply(fourth, 'question', 'About which repository?')).isError, false)
    await waitFor(() => gw.log.includes('telegram send failed'))
    assert.match(gw.log, /telegram send failed: Question for request \w+ .* - 400 Bad Request: chat not found/)
    assert.match(await gw.call('get_reply', { id: fourth }), /About which repository\?/)
    assert.equal(api.messages.length, 1, 'no message twice')
    assert.ok(!gw.log.includes(TOKEN), 'the token never reaches the log')
  } finally {
    api.mode = 'ok'
    await gw.close()
  }
})

test('gateway: a Reply on Telegram, or a message with the code, answers a question as a spoken answer does; replies go back there; nothing past the kill switch', async () => {
  api.mode = 'ok'
  api.messages.length = 0
  api.updates = []
  const gw = await startGateway('answers', { telegram: true, env: { VOICE_GW_TELEGRAM_POLL: '1' } })
  // The stand-in's message ids count from 1.
  const messageWith = text => api.messages.findIndex(m => m.text.includes(text)) + 1
  try {
    assert.match(gw.log, /telegram answers on: a Reply to a question, or a message with its code, reaches the controller as the driver's answer/)

    // A question after the voice mode ended: on Telegram, with its code and how to answer there.
    const first = idOf(await gw.call('send', { message: 'Push the fix.' }))
    await sleep(1300)
    const asked = await gw.claudeCode.callTool({
      name: 'reply',
      arguments: { request_id: first, state: 'question', text: 'Open the pull request?', kind: 'push' },
    })
    const decision = /decision (d[a-z0-9]{3})/.exec(asked.content[0].text)[1]
    await waitFor(() => messageWith('Open the pull request?'))
    assert.match(api.messages[0].text, new RegExp(`^Question for request ${first} .*reply to this message, or write a message that starts with ${first}\\.`, 's'))

    // The driver replies to it there: the controller gets it as their answer.
    const reply = driverSays('Ja, öffne ihn', { replyTo: messageWith('Open the pull request?') })
    const event = await waitFor(() => gw.events.find(e => e.meta?.via === 'telegram'))
    assert.equal(event.content, `(Answer to ${first}) Ja, öffne ihn`)
    assert.equal(event.meta.trusted, undefined, "the driver's own words")
    const answer = event.meta.request_id
    await waitFor(() => messageWith('Passed on to the controller'))
    const confirmed = api.messages[messageWith('Passed on to the controller') - 1]
    assert.equal(confirmed.text, `Passed on to the controller as your answer to ${first}.`)
    assert.deepEqual(confirmed.reply_parameters, { message_id: reply, allow_sending_without_reply: true })
    assert.match(gw.log, new RegExp(`telegram answer passed on id=${answer} answers=${first}`))

    // Its words count, as a spoken answer's do.
    const closed = await gw.claudeCode.callTool({
      name: 'resolve_decision',
      arguments: { id: decision, outcome: 'open the pull request', words: 'Ja, öffne ihn' },
    })
    assert.match(closed.content[0].text, new RegExp(`^\\[decision=closed id=${decision}\\]`))
    // The controller's reply goes back there, as a reply to the driver's message.
    await gw.reply(answer, 'done', 'Der Pull Request ist unterwegs.')
    await waitFor(() => messageWith('Der Pull Request ist unterwegs.'))
    const back = api.messages[messageWith('Der Pull Request ist unterwegs.') - 1]
    assert.equal(back.text, `On your answer to ${first}:\n\nDer Pull Request ist unterwegs.`)
    assert.equal(back.reply_parameters.message_id, reply)

    // Plain text with no code: not passed on, and the chat hears why.
    const hello = driverSays('hallo')
    await waitFor(() => messageWith('Not passed on'))
    const refused = api.messages[messageWith('Not passed on') - 1]
    assert.equal(refused.text, 'Not passed on: it is no Reply to a question, and it names no open question by its code. No question is open now.')
    assert.equal(refused.reply_parameters.message_id, hello)

    // Another question, answered with its code instead of a Reply.
    const second = idOf(await gw.call('send', { message: 'Clean up the playground.' }))
    await gw.reply(second, 'question', 'Delete the old notes too?')
    await waitFor(() => messageWith('Delete the old notes too?'))
    driverSays(`${second} nein, behalten`)
    const coded = await waitFor(() => gw.events.find(e => e.content === `(Answer to ${second}) ${second} nein, behalten`))
    assert.equal(coded.meta.via, 'telegram')

    // Locked: nothing passes, and unlocking stays at the computer.
    const third = idOf(await gw.call('send', { message: 'Rename the notes.' }))
    await gw.reply(third, 'question', 'To what name?')
    await waitFor(() => messageWith('To what name?'))
    driverSays('/stop')
    await waitFor(() => messageWith('KILL SWITCH'))
    driverSays('notes-2026', { replyTo: messageWith('To what name?') })
    await waitFor(() => messageWith('Not passed on: the kill switch is locked'))
    assert.equal(api.messages[messageWith('Not passed on: the kill switch is locked') - 1].text, 'Not passed on: the kill switch is locked. It is unlocked only at the computer.')
    assert.ok(!gw.events.some(e => e.content.startsWith(`(Answer to ${third})`)))
    assert.ok(!gw.log.includes(TOKEN))
  } finally {
    api.updates = null
    await gw.close()
  }
})

test('a gateway whose port is taken ends with an error, and says so on Telegram', async () => {
  api.mode = 'ok'
  const blocker = createServer((req, res) => res.end('ok'))
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const port = blocker.address().port
  const secrets = join(TMP, 'busy')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`, { mode: 0o600 })
  writeFileSync(join(secrets, 'telegram_chat_id'), CHAT_ID, { mode: 0o600 })
  const before = api.messages.length
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: join(secrets, 'state'),
      VOICE_GW_WORKER_ROOT: join(secrets, 'no-repositories'),
      VOICE_GW_PORT: String(port),
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_TELEGRAM_API: api.url,
    },
    stdio: ['pipe', 'ignore', 'pipe'], // stdin stays open, as under Claude Code
  })
  let log = ''
  child.stderr.on('data', chunk => (log += chunk))
  try {
    const code = await Promise.race([
      new Promise(resolve => child.on('exit', resolve)),
      sleep(10000).then(() => 'still running'),
    ])
    assert.equal(code, 1)
    assert.match(log, new RegExp(`voice port 127\\.0\\.0\\.1:${port} is in use by another process`))
    assert.match(log, new RegExp(`shutting down: voice port ${port} in use`))
    const alert = api.messages.slice(before).find(m => /voice port/.test(m.text))
    assert.ok(alert, 'a Telegram message')
    assert.equal(alert.chat_id, CHAT_ID)
    assert.match(alert.text, new RegExp(`the voice port ${port} is in use by another process, so the gateway of the controller session ends`))
    assert.ok(!api.messages.slice(before).some(m => /shutting down now/.test(m.text)), 'an error, not a shutdown with statistics')
    assert.ok(!log.includes(TOKEN))
  } finally {
    child.kill('SIGKILL')
    blocker.close()
  }
})
