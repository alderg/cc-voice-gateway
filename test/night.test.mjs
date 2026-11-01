// Night mode (night.mjs): the quiet hours and the driver's "good night" and
// "I'm back", the night's beginning and end, what workers report under
// "Assumptions:" and "Deferred questions:", the morning summary; Telegram's
// words for it, and its silence in the night; the gateway as a whole, driven
// from Telegram, as in telegram.test.mjs.

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
import { AWAY_HOURS, NIGHT_RULE, Night, morningText, nextEnd, parseQuietHours, sections, windowAt } from '../src/night.mjs'
import { Store } from '../src/store.mjs'
import { TelegramFallback, awayCommand } from '../src/telegram.mjs'
import { runLines } from '../src/workers.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-night-'))
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT_ID = '4242'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime() // October 2026, local time

after(() => rmSync(TMP, { recursive: true, force: true }))

async function until(predicate, ms = 8000) {
  for (const begun = Date.now(); Date.now() - begun < ms; await sleep(25)) {
    const value = predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

// --- the quiet hours ---------------------------------------------------------------

test('parseQuietHours: a range in the computer\'s time; over midnight or not; nonsense is none', () => {
  assert.deepEqual(parseQuietHours('23:00-07:30'), { start: 1380, end: 450 })
  assert.deepEqual(parseQuietHours(' 22 - 6 '), { start: 1320, end: 360 })
  assert.deepEqual(parseQuietHours('13:00-14:15'), { start: 780, end: 855 })
  assert.deepEqual(parseQuietHours('22:00-24:00'), { start: 1320, end: 0 })
  for (const bad of ['', 'night', '25:00-07:00', '23:00-07:61', '07:00-07:00', '23:00', null]) assert.equal(parseQuietHours(bad), null, String(bad))
})

test('windowAt and nextEnd: the window a moment is in, and the end of it or of the next', () => {
  const hours = parseQuietHours('23:00-07:30')
  assert.equal(windowAt(hours, at(31, 12)), null)
  assert.deepEqual(windowAt(hours, at(31, 23, 10)), { from: at(31, 23), to: at(32, 7, 30) })
  assert.deepEqual(windowAt(hours, at(31, 3)), { from: at(30, 23), to: at(31, 7, 30) })
  assert.equal(windowAt(hours, at(31, 7, 30)), null, 'the end is not in it')
  assert.equal(nextEnd(hours, at(31, 3)), at(31, 7, 30))
  assert.equal(nextEnd(hours, at(31, 21)), at(32, 7, 30))
  const day = parseQuietHours('13:00-14:00')
  assert.deepEqual(windowAt(day, at(31, 13, 30)), { from: at(31, 13), to: at(31, 14) })
  assert.equal(nextEnd(day, at(31, 15)), at(32, 14))
})

// --- on and off ------------------------------------------------------------------------

function nightAt(start, options = {}) {
  const clock = { now: start }
  const night = new Night({ now: () => clock.now, log: () => {}, ...options })
  const events = []
  night.on('night', event => events.push(['night', event]))
  night.on('morning', event => events.push(['morning', event]))
  return { clock, night, events }
}

test('the quiet hours: on by the clock, the night begins and ends once each, with what it noted', () => {
  const { clock, night, events } = nightAt(at(31, 22), { hours: '23:00-07:30' })
  night.tick()
  assert.equal(night.active(), false)
  assert.equal(night.text(), '')
  clock.now = at(31, 23, 5)
  night.tick()
  night.tick()
  assert.equal(night.active(), true)
  assert.match(night.text(), /^night mode is on in the quiet hours, until 07:30 on 1 Nov: workers decide what they can/)
  assert.deepEqual(events.map(([kind]) => kind), ['night'])
  assert.equal(events[0][1].by, 'quiet hours')
  night.record({ repo: 'alpha', task: 't1ab', outcome: 'done', pulls: [12], result: 'Done.\n\nAssumptions:\n- the default timeout of 30 s\n\nDeferred questions:\n- which colour for the button?' })
  night.note('the workers on this computer began to wait for the usage limit')
  clock.now = at(32, 7, 31)
  night.tick()
  assert.equal(night.active(), false)
  assert.deepEqual(events.map(([kind]) => kind), ['night', 'morning'])
  const morning = events[1][1]
  assert.equal(morning.since, at(31, 23, 5))
  assert.equal(morning.by, 'the end of the quiet hours')
  assert.deepEqual(morning.log.map(item => item.kind), ['run', 'note'])
  assert.deepEqual(morning.log[0].assumptions, ['the default timeout of 30 s'])
  assert.deepEqual(morning.log[0].deferred, ['which colour for the button?'])
  night.record({ repo: 'beta', task: 't2cd', outcome: 'done' })
  assert.equal(night.state.log.length, 0, 'by day, nothing is noted')
})

test('"good night" and "I\'m back": on until the end of the quiet hours; back ends the rest of them; the next night comes again', () => {
  const { clock, night, events } = nightAt(at(31, 21), { hours: '23:00-07:30' })
  assert.equal(night.away('voice'), true)
  assert.equal(night.active(), true)
  assert.equal(night.until(), at(32, 7, 30))
  assert.match(night.text(), /^night mode is on since 21:00, as the driver said, until 07:30 on 1 Nov/)
  assert.equal(events[0][1].by, 'voice')
  clock.now = at(32, 2)
  assert.equal(night.back('voice'), true)
  assert.equal(night.active(), false, 'also within the quiet hours')
  assert.equal(events.at(-1)[0], 'morning')
  assert.equal(events.at(-1)[1].by, 'voice')
  assert.equal(night.back('voice'), false, 'once')
  clock.now = at(32, 23, 30)
  night.tick()
  assert.equal(night.active(), true, 'the next quiet hours count again')
  assert.deepEqual(events.map(([kind]) => kind), ['night', 'morning', 'night'])
})

test(`"good night" without quiet hours: on for ${AWAY_HOURS} hours, unless "I'm back" comes first`, () => {
  const { clock, night, events } = nightAt(at(31, 22))
  night.away('telegram')
  assert.equal(night.until(), at(31, 22) + AWAY_HOURS * 3600 * 1000)
  clock.now = at(32, 9, 59)
  night.tick()
  assert.equal(night.active(), true)
  clock.now = at(32, 10, 1)
  night.tick()
  assert.equal(night.active(), false)
  assert.deepEqual(events.map(([kind]) => kind), ['night', 'morning'])
  assert.equal(events[1][1].by, 'its time')
  assert.equal(night.state.away, null)
})

test('kept across a restart: a night going goes on with its log; one that ended meanwhile gets its summary at the start', () => {
  const file = join(TMP, 'night.json')
  const first = nightAt(at(31, 23, 10), { hours: '23:00-07:30', file })
  first.night.tick()
  first.night.record({ repo: 'alpha', task: 't1ab', outcome: 'failed', result: 'Assumptions: none' })
  first.night.close()
  const again = nightAt(at(32, 1), { hours: '23:00-07:30', file })
  again.night.start()
  again.night.close()
  assert.deepEqual(again.events, [], 'the same night, no second beginning')
  assert.equal(again.night.state.log.length, 1)
  const later = nightAt(at(32, 9), { hours: '23:00-07:30', file })
  later.night.start()
  later.night.close()
  assert.deepEqual(later.events.map(([kind]) => kind), ['morning'])
  assert.equal(later.events[0][1].log[0].task, 't1ab')
})

// --- what the workers report, and the summary ----------------------------------------------------

test('sections: the assumptions and deferred questions of a report, in the forms workers write them', () => {
  const report = [
    'I added the export.',
    '',
    '**Assumptions:**',
    '- CSV with a semicolon, as in the other exports',
    '* UTF-8 without a BOM',
    '',
    '## Deferred questions',
    '1. Should the export include archived items?',
    '',
    'Pull request 12 is out.',
  ].join('\n')
  assert.deepEqual(sections(report), {
    assumptions: ['CSV with a semicolon, as in the other exports', 'UTF-8 without a BOM'],
    deferred: ['Should the export include archived items?'],
  })
  assert.deepEqual(sections('Assumptions: none\nDeferred questions:\n- none'), { assumptions: [], deferred: [] })
  assert.deepEqual(sections('Assumptions: the port stays 8080'), { assumptions: ['the port stays 8080'], deferred: [] })
  assert.deepEqual(sections(''), { assumptions: [], deferred: [] })
})

test('the morning summary: the night, what was done, assumptions, deferred questions, decisions, notes', () => {
  const now = at(32, 7, 31)
  const night = {
    since: at(31, 23),
    until: now,
    log: [
      { at: at(32, 1), kind: 'run', repo: 'alpha', task: 't1ab', outcome: 'done', pulls: [12], assumptions: ['30 s timeout'], deferred: ['which colour?'] },
      { at: at(32, 2), kind: 'run', repo: 'beta', task: 't2cd', outcome: 'failed', pulls: [], assumptions: [], deferred: [] },
      { at: at(32, 3), kind: 'note', text: 'the workers on this computer began to wait for the usage limit' },
    ],
  }
  assert.equal(
    morningText(night, ['d2ab push, alpha, not asked yet: alpha: task t1ab left 1 commit on no remote.'], now),
    [
      'Night mode from 23:00 on 31 Oct to 07:31.',
      'Done: 2 runs: alpha t1ab done (pull request 12); beta t2cd failed.',
      'Assumptions made:\n- alpha t1ab: 30 s timeout',
      'Deferred questions:\n- alpha t1ab: which colour?',
      'Decisions waiting:\n- d2ab push, alpha, not asked yet: alpha: task t1ab left 1 commit on no remote.',
      'Also: 03:00 the workers on this computer began to wait for the usage limit.',
    ].join('\n'),
  )
  assert.match(morningText({ since: at(31, 23), until: now, log: [] }, [], now), /No worker run ended in the night\.\nAssumptions made: none noted\.\nDeferred questions: none\.\nDecisions waiting: none\.$/)
})

test('a run started in night mode reads its rule; one by day does not', () => {
  assert.equal(runLines({ night: true }), `${NIGHT_RULE}\n`)
  assert.equal(runLines({}), '')
  assert.match(NIGHT_RULE, /choosing the conservative option/)
  assert.match(NIGHT_RULE, /do not end the run with a question/)
  assert.match(NIGHT_RULE, /"Assumptions:" and a section "Deferred questions:"/)
  assert.match(NIGHT_RULE, /pull request description/)
})

// --- Telegram -------------------------------------------------------------------------------------

test('Telegram: /night, "good night" and the like switch it on; /back, "I\'m back" and the like off; nothing else', () => {
  for (const text of ['/night', '/goodnight', '/away', '/night@voicebot', 'Good night!', 'good night', 'Gute Nacht', 'bonne nuit']) {
    assert.equal(awayCommand(text), 'away', text)
  }
  for (const text of ['/back', '/morning', "I'm back", 'I’m back', 'im back', 'Good morning', 'Guten Morgen', 'bin zurück']) {
    assert.equal(awayCommand(text), 'back', text)
  }
  for (const text of ['good night, and push the fix', '/stop', 'back', 'night', '']) assert.equal(awayCommand(text), null, text)
})

test('the morning settles the night: its news read, its questions and approvals told by the summary', async () => {
  const store = new Store()
  const night = store.createRequest('Worker alpha finished task t1ab.', { origin: 'worker' })
  store.addUpdate(night.id, 'done', 'The export is done.')
  const question = store.createRequest('Worker beta finished task t2cd.', { origin: 'worker' })
  store.addUpdate(question.id, 'question', 'Which colour?')
  store.addPermission({ request_id: 'abcde', tool_name: 'Bash', description: 'Run ls', input_preview: '' })
  assert.equal(store.settleNews(night.createdAt), 1)
  assert.equal(store.hasUnread(night), false)
  assert.equal(store.hasUnread(question), true, 'questions stay')
  const sent = []
  let paused = true
  const fallback = new TelegramFallback(store, { afterSeconds: 0.05, paused: () => paused, log: () => {}, send: async text => sent.push(text) })
  await sleep(100)
  store.changed()
  assert.deepEqual(sent, [], 'nothing in the night')
  fallback.settle()
  paused = false
  store.changed()
  await sleep(100)
  assert.deepEqual(sent, [], 'told by the summary')
  const later = store.createRequest('Worker gamma finished.', { origin: 'worker' })
  store.addUpdate(later.id, 'question', 'Push it?')
  await until(() => sent.length === 1)
  assert.match(sent[0], /^Question for request \w+ \("Worker gamma finished\."\)\n\nPush it\?/, 'by day as before')
  fallback.close()
})

// --- the gateway as a whole -------------------------------------------------------------------

// The Bot API: sent messages are kept; getUpdates hands out what the test
// queued, else waits a little and has nothing.
const api = { messages: [], updates: [], server: null, url: '', id: 1 }
before(async () => {
  api.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const answer = result => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (req.url === `/bot${TOKEN}/sendMessage`) {
        api.messages.push(JSON.parse(body || '{}').text)
        return answer({ message_id: api.messages.length })
      }
      if (api.updates.length) return answer(api.updates.splice(0))
      setTimeout(() => answer(api.updates.splice(0)), 200)
    })
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  api.url = `http://127.0.0.1:${api.server.address().port}`
})
after(() => api.server?.close())

const fromDriver = text =>
  api.updates.push({ update_id: api.id++, message: { text, date: Math.floor(Date.now() / 1000), chat: { id: Number(CHAT_ID), type: 'private' }, from: { id: Number(CHAT_ID), is_bot: false } } })

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('the gateway: "good night" on Telegram; no questions there in the night; "/back": one summary, also to the controller', async () => {
  const secrets = join(TMP, 'gateway')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`, { mode: 0o600 })
  writeFileSync(join(secrets, 'telegram_chat_id'), CHAT_ID, { mode: 0o600 })
  const port = await freePort()
  const events = []
  let log = ''
  const claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  claudeCode.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }),
    ({ params }) => events.push(params),
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
      VOICE_GW_MAX_WAIT: '2',
      VOICE_GW_DEFAULT_WAIT: '1',
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_SELF_CHECKOUT: '',
      VOICE_GW_TELEGRAM_API: api.url,
      VOICE_GW_TELEGRAM_AFTER: '1',
      VOICE_GW_TELEGRAM_POLL: '1',
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (log += chunk))
  await claudeCode.connect(stdio)
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await sleep(50)
    }
  }
  const { access_token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name: 'night' })
  const voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await voice.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access_token}` } } }))
  const call = async (name, args = {}) => (await voice.callTool({ name, arguments: args })).content.map(c => c.text).join('\n')
  const controller = async (name, args = {}) => (await claudeCode.callTool({ name, arguments: args })).content.map(c => c.text).join('\n')
  const idOf = out => /id=([a-z0-9]+)/.exec(out)?.[1]
  try {
    assert.match(log, /night mode when the driver says good night \(no quiet hours set\)/)
    const summary = await until(() => events.find(e => e.meta?.kind === 'summary'))
    await controller('reply', { request_id: summary.meta.request_id, state: 'done', text: 'ok' })

    // Typed words, or none from the driver: nothing changes.
    assert.match(await controller('set_away', { away: true, words: 'good night' }), /^\[night=needs_driver\] Nothing changed/)

    // On Telegram.
    fromDriver('Good night')
    await until(() => api.messages.some(text => /good night\. Night mode is on since/.test(text)))
    assert.match(api.messages.at(-1), /^cc-voice-gateway on \S+: good night\. Night mode is on since \d\d:\d\d, as the driver said, until \d\d:\d\d.*: workers decide what they can, .*Send \/back or "I'm back" to end it\.$/)
    const nightEvent = await until(() => events.find(e => e.meta?.kind === 'night'))
    assert.match(nightEvent.content, /^Night mode is on, as the driver said \(telegram\) until \d\d:\d\d.*Go on with what is queued, and with what standing orders allow: none holds now\./)
    assert.match(await controller('open_items'), /\nThe gateway now:\n- Night mode is on since \d\d:\d\d, as the driver said/)
    assert.match(await call('status'), /\nNight mode: night mode is on since /)

    // A question in the night: an open decision, nothing on Telegram.
    const sent = api.messages.length
    const id = idOf(await call('send', { message: 'Fix the login page.' }))
    await until(() => events.some(e => e.meta?.request_id === id))
    await controller('reply', { request_id: id, state: 'question', text: 'Which login page, the old or the new one?' })
    await sleep(1800)
    assert.equal(api.messages.length, sent, 'no question on Telegram in the night')

    // Back: one summary, with the decision waiting; the question does not follow on its own.
    fromDriver('/back')
    await until(() => api.messages.some(text => /good morning\./.test(text)))
    const morning = api.messages.find(text => /good morning\./.test(text))
    assert.match(morning, /^cc-voice-gateway on \S+: good morning\. Night mode from \d\d:\d\d to \d\d:\d\d\.\nNo worker run ended in the night\.\nAssumptions made: none noted\.\nDeferred questions: none\.\nDecisions waiting:\n- d\w+ other, asked .*: Which login page, the old or the new one\?$/)
    const event = await until(() => events.find(e => e.meta?.kind === 'morning'))
    assert.equal(event.meta.trusted, 'no')
    assert.match(event.content, /The night is over \(telegram\)\. Tell the driver as news/)
    await sleep(1800)
    assert.equal(api.messages.filter(text => /Which login page/.test(text)).length, 1, 'only in the summary')
    assert.doesNotMatch(await call('status'), /Night mode/)
    fromDriver('/back')
    await until(() => api.messages.some(text => /night mode was not on/.test(text)))
    assert.ok(!log.includes(TOKEN))
  } finally {
    await voice.close()
    await claudeCode.close()
  }
})
