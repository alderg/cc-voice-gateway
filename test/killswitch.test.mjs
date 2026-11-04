// The kill switch: every trigger (voice, Telegram, the rules on worker runs,
// the controller's alarm), its effects, that it survives a restart, and that
// only the local script unlocks it.
//
// Stand-ins: a fake claude for worker runs, a fake gh for GitHub, and a local
// HTTP server for the Telegram Bot API; nothing reaches the network. The
// Docker side (container stopped, read-only mounts) is in docker.test.mjs.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'
import { KillSwitch, VoiceUnlock, alarmText, emergencyPhrase } from '../src/killswitch.mjs'
import { RunGuard } from '../src/guard.mjs'
import { HostRunner } from '../src/runners.mjs'
import { Workers } from '../src/workers.mjs'
import { Telegram, TelegramCommands, isStopCommand } from '../src/telegram.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const UNLOCK = fileURLToPath(new URL('../scripts/unlock.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-kill-'))
const BIN = join(TMP, 'bin')
const ROOT = join(TMP, 'Developer')
const SECRETS = join(TMP, 'secrets')
const LOCK = join(SECRETS, 'killswitch.json')
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT = '4242'
const GH_STATE = join(TMP, 'github.json')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function waitUntil(predicate, ms = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = async () => {
      const value = await predicate()
      if (value) return resolve(value)
      if (Date.now() - started > ms) return reject(new Error('timed out waiting'))
      setTimeout(check, 25)
    }
    check()
  })
}

// --- stand-ins ----------------------------------------------------------------------

const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
// a GitHub that answers slowly
if (state.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.delayMs)
const out = value => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(0) }
if (args[0] === 'repo' && args[1] === 'view') { process.stdout.write('PRIVATE\\n'); process.exit(0) }
if (args[0] === 'api') {
  // pull requests, by number and by their head (prs: "owner/name#number" -> the REST object)
  const pull = /^repos\\/([^/]+\\/[^/]+)\\/pulls\\/(\\d+)$/.exec(args[1])
  if (pull && state.prs?.[pull[1] + '#' + pull[2]]) out(state.prs[pull[1] + '#' + pull[2]])
  const list = /^repos\\/([^/]+\\/[^/]+)\\/pulls\\?(.*)$/.exec(args[1])
  if (list) {
    const query = new URLSearchParams(list[2])
    out(Object.entries(state.prs ?? {})
      .filter(([key, pr]) => key.startsWith(list[1] + '#') && pr.state === query.get('state') && pr.head.label === query.get('head'))
      .map(([, pr]) => pr))
  }
  const branch = /^repos\\/([^/]+\\/[^/]+)\\/branches\\/(.+)$/.exec(args[1])
  if (branch && state.heads?.[branch[1]]) out({ name: branch[2], commit: { sha: state.heads[branch[1]] } })
  // the pull requests a commit on the default branch merged
  const merged = /^repos\\/[^/]+\\/[^/]+\\/commits\\/([^/]+)\\/pulls$/.exec(args[1])
  if (merged) out(state.pulls?.[merged[1]] ?? [])
  const repo = /^repos\\/([^/]+\\/[^/]+)$/.exec(args[1])
  if (repo) out({ default_branch: 'main' })
}
process.stderr.write('not found\\n')
process.exit(1)
`

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, input: input.split('\\n')[0] }) + '\\n')
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
const bash = command => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
out({ type: 'system', subtype: 'init' })
if (/PUSHMAIN/.test(input)) bash('git add -A && git commit -qm fix && git push origin main')
setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }), /SLOW/.test(input) ? 15000 : 300)
`

const telegram = { server: null, url: '', sent: [], updates: [], nextId: 1 }

function telegramUpdate(chatId, text, { type = 'private', age = 0 } = {}) {
  telegram.updates.push({
    update_id: telegram.nextId++,
    message: { message_id: 1, date: Math.floor(Date.now() / 1000) - age, chat: { id: Number(chatId), type }, from: { id: Number(chatId) }, text },
  })
}

before(async () => {
  mkdirSync(BIN, { recursive: true })
  for (const [name, script] of [['gh', FAKE_GH], ['claude', FAKE_CLAUDE]]) {
    writeFileSync(join(BIN, name), script)
    chmodSync(join(BIN, name), 0o755)
  }
  writeFileSync(GH_STATE, JSON.stringify({ heads: {} }))
  process.env.FAKE_GH_STATE = GH_STATE
  telegram.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {}
      const reply = data => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: data }))
      }
      if (req.url === `/bot${TOKEN}/sendMessage`) {
        telegram.sent.push(json)
        return reply({ message_id: telegram.sent.length })
      }
      if (req.url === `/bot${TOKEN}/getUpdates`) {
        for (let i = 0; i < 10 && !telegram.updates.some(u => u.update_id >= (json.offset ?? 0)); i++) await sleep(50)
        return reply(telegram.updates.filter(u => u.update_id >= (json.offset ?? 0)))
      }
      res.writeHead(404).end(JSON.stringify({ ok: false, description: 'Not Found' }))
    })
  })
  await new Promise(resolve => telegram.server.listen(0, '127.0.0.1', resolve))
  telegram.url = `http://127.0.0.1:${telegram.server.address().port}`
})

after(() => {
  telegram.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

// --- the emergency phrase ---------------------------------------------------------

test('the emergency phrase: "emergency stop" and "kill switch"; a mere mention, "do not stop" or another language is none', () => {
  for (const phrase of [
    'Emergency stop',
    'Emergency stop!',
    'EMERGENCY STOP now',
    'Emergency stop, halt everything please',
    'emergency-stop now',
    'Emergencystop',
    'Kill switch!',
    'Killswitch',
    'Please emergency stop',
  ]) {
    assert.equal(emergencyPhrase(phrase), true, phrase)
  }
  for (const phrase of [
    'do not stop the build',
    "Please don't stop the worker",
    'What does the emergency stop in this project do exactly?',
    'Notstopp',
    'stop the worker',
    'the build is not halting',
    '',
  ]) {
    assert.equal(emergencyPhrase(phrase), false, phrase)
  }
  assert.equal(isStopCommand('/stop'), true)
  assert.equal(isStopCommand('/emergencystop@my_bot'), true)
  assert.equal(isStopCommand('/notstopp'), false)
  assert.equal(isStopCommand('stop the music'), false)
})

// --- the state ------------------------------------------------------------------------

test('the state: locked, saved for this user only, survives a new instance, fails closed, unlocks', () => {
  const file = join(TMP, 'unit', 'killswitch.json')
  const logged = []
  const first = new KillSwitch({ file, log: line => logged.push(line) })
  assert.equal(first.locked, false)
  const events = []
  first.on('tripped', (state, event, isFirst) => events.push([event.trigger, isFirst]))
  first.trip({ trigger: 'voice', reason: 'emergency stop' })
  first.trip({ trigger: 'rule', reason: 'push to the default branch' })
  assert.deepEqual(events, [['voice', true], ['rule', false]])
  assert.equal(statSync(file).mode & 0o777, 0o600)

  const again = new KillSwitch({ file, log: () => {} })
  assert.equal(again.locked, true)
  assert.equal(again.state.trigger, 'voice', 'the first trigger stays the reason')
  assert.deepEqual(again.state.events.map(e => e.trigger), ['voice', 'rule'])

  assert.equal(again.unlock({ by: 'test' }).trigger, 'voice')
  assert.equal(existsSync(file), false)
  assert.equal(new KillSwitch({ file, log: () => {} }).locked, false)

  writeFileSync(file, '{ not json')
  const damaged = new KillSwitch({ file, log: () => {} })
  assert.equal(damaged.locked, true, 'an unreadable file means locked')
  assert.match(damaged.state.reason, /unreadable/)
})

test('the setting VOICE_GW_KILLSWITCH: auto locks on everything, manual not on the rules, off on nothing', () => {
  const file = join(TMP, 'modes', 'killswitch.json')
  const logged = []
  const log = line => logged.push(line)
  const make = mode => new KillSwitch({ file, mode, log })

  const manual = make('manual')
  const ignored = []
  manual.on('ignored', event => ignored.push(event.trigger))
  assert.equal(manual.trip({ trigger: 'rule', reason: 'write outside the allowed folders: x' }), null)
  assert.equal(manual.locked, false)
  assert.equal(existsSync(file), false, 'nothing saved')
  assert.deepEqual(ignored, ['rule'])
  assert.match(logged.at(-1), /^kill switch not locked, VOICE_GW_KILLSWITCH=manual; rule would have locked it: write outside the allowed folders: x$/)
  for (const trigger of ['voice', 'telegram', 'controller']) {
    const locking = make('manual')
    assert.equal(locking.trip({ trigger, reason: 'stop' }).trigger, trigger, `${trigger} locks at manual`)
    locking.unlock({ by: 'test' })
  }

  const off = make('off')
  for (const trigger of ['voice', 'telegram', 'controller', 'rule']) {
    assert.equal(off.trip({ trigger, reason: 'stop' }), null, `${trigger} does not lock when off`)
  }
  assert.equal(off.locked, false)
  assert.equal(logged.filter(line => line.startsWith('kill switch not locked, VOICE_GW_KILLSWITCH=off;')).length, 4)

  // A lock from before stays, whatever the setting; the setting only keeps it from locking again.
  make('auto').trip({ trigger: 'voice', reason: 'emergency stop' })
  const stays = make('off')
  assert.equal(stays.locked, true)
  assert.equal(stays.trip({ trigger: 'rule', reason: 'again' }), null)
  assert.deepEqual(stays.state.events.map(e => e.trigger), ['voice'])
  stays.unlock({ by: 'test' })

  // Anything else is as safe as it gets.
  assert.equal(make('sometimes').mode, 'auto')
  assert.equal(make(undefined).mode, 'auto')
  const auto = make('auto')
  assert.equal(auto.trip({ trigger: 'rule', reason: 'x' }).trigger, 'rule')
  auto.unlock({ by: 'test' })
})

// --- the unlock in voice mode, with a PIN from Telegram -------------------------------------

// The PIN in a message to the chat, "Unlock PIN 4 7 1 9, valid 5 minutes".
const pinIn = text => /PIN (\d) (\d) (\d) (\d),/.exec(text).slice(1).join('')
const wrongOf = pin => String((Number(pin) + 1) % 10000).padStart(4, '0')
// Whether a text holds the PIN: as it went out, digit by digit, or as four
// digits of their own, not part of a longer number, a word, a hash, a date, a
// time or a JSON number.
const holdsPin = (text, pin) =>
  text.includes([...pin].join(' ')) || new RegExp(`(?<![\\w:.,\\[-])${pin}(?![\\w:.,\\]-])`).test(text)

// As in e2e.test.mjs: no filler named in what the voice assistant hears.
const FILLERS =
  /schau|nachseh|sehe mal|\bmoment|augenblick|let me (check|see|look)|have a look|look or check|look(ing)? (it up )?yourself|check (it )?yourself|weitergegeben|passed on/i

// A kill switch with the unlock in voice mode, a clock the test sets, the
// messages to the driver's chat and the log.
function pinned(name, { send = true, paused = () => false } = {}) {
  const file = join(TMP, 'pin', name, 'killswitch.json')
  const logged = []
  const log = (...parts) => logged.push(parts.join(' '))
  const killswitch = new KillSwitch({ file, log })
  const sent = []
  const clock = { now: Date.parse('2026-11-03T08:00:00Z') }
  const unlock = new VoiceUnlock({
    killswitch,
    send: send ? async text => void sent.push(text) : null,
    paused,
    host: 'testbox',
    stopped: ['The worker container voice-workers stays stopped: start it again with scripts/start-workers-container.sh.'],
    log,
    now: () => clock.now,
  })
  return { file, killswitch, unlock, sent, logged, clock }
}

test('the unlock in voice mode: a PIN of four digits only to the chat, in no result and no log line; a new one replaces the one before; the right one unlocks once', async () => {
  const { file, killswitch, unlock, sent, logged } = pinned('unlocks')
  assert.equal((await unlock.request()).status, 'not-locked')
  assert.equal(unlock.attempt('1234').status, 'not-locked')
  assert.deepEqual(sent, [], 'nothing to unlock, no PIN')
  assert.equal(killswitch.byVoice, false)

  killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
  assert.equal(killswitch.byVoice, true)
  assert.match(alarmText(killswitch.state, { voice: killswitch.byVoice }), /It is unlocked at the server, with scripts\/unlock\.mjs, or in voice mode with a PIN sent to Telegram\.$/)
  const german = await unlock.request({ german: true })
  assert.equal(german.status, 'sent')
  assert.equal(german.minutes, 5)
  assert.equal(german.state, killswitch.state)
  assert.match(sent[0], /^Entsperr-PIN \d \d \d \d, gültig 5 Minuten$/)
  const first = pinIn(sent[0])
  // A new one replaces it.
  let second = first
  while (second === first) {
    await unlock.request()
    second = pinIn(sent.at(-1))
  }
  assert.match(sent.at(-1), /^Unlock PIN \d \d \d \d, valid 5 minutes$/)
  assert.deepEqual(unlock.attempt(first), { status: 'wrong', left: 2 })
  assert.equal(killswitch.state.wrongPins, 1)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).wrongPins, 1, 'counted with the lock, in its file')
  // Not four digits: nothing tried, nothing counted.
  for (const said of ['12', '12345', 'vier sieben eins neun', '']) assert.equal(unlock.attempt(said).status, 'invalid', said)
  assert.equal(killswitch.state.wrongPins, 1)

  // As read out, digit by digit.
  const was = killswitch.state
  const done = unlock.attempt([...second].join(' '))
  assert.equal(done.status, 'unlocked')
  assert.equal(done.was, was)
  assert.equal(killswitch.locked, false)
  assert.equal(existsSync(file), false)
  assert.equal(sent.at(-1), `cc-voice-gateway on testbox: kill switch unlocked in voice mode, with the PIN sent here. It was locked since ${alarmText(was, { short: true }).match(/since (.*?), by/)[1]}, by voice: emergency stop. The gateway takes tasks again. The worker container voice-workers stays stopped: start it again with scripts/start-workers-container.sh.`)
  assert.ok(logged.some(line => /^kill switch unlocked by the driver in voice mode, with a PIN from Telegram; it was locked since .* by voice$/.test(line)))
  assert.equal(unlock.attempt(second).status, 'not-locked', 'once')
  assert.equal(logged.filter(line => /an unlock PIN for voice mode went to the driver's Telegram chat, valid 5 minutes; 3 tries left for this lock/.test(line)).length, sent.length - 1)
  assert.ok(logged.some(line => line === 'kill switch: a wrong PIN in voice mode; 2 tries left for this lock'))
  for (const pin of [first, second]) {
    assert.ok(!logged.some(line => holdsPin(line, pin)), 'no PIN in the log')
    assert.ok(!holdsPin(JSON.stringify([german, done]), pin), 'nor in a result')
  }
})

test('the unlock in voice mode: a PIN expires after five minutes and counts nothing then; a new trigger or an unlock at the server voids it', async () => {
  const { killswitch, unlock, sent, clock } = pinned('expires')
  killswitch.trip({ trigger: 'rule', reason: 'push to the default branch' })
  await unlock.request()
  clock.now += 5 * 60000
  const late = pinIn(sent.at(-1))
  clock.now += 1
  assert.deepEqual(unlock.attempt(late), { status: 'expired' })
  assert.deepEqual(unlock.attempt(late), { status: 'no-pin' })
  assert.equal(killswitch.state.wrongPins, undefined, 'no try counted')

  // Just within the five minutes it still unlocks.
  await unlock.request()
  clock.now += 5 * 60000
  assert.equal(unlock.attempt(pinIn(sent.at(-1))).status, 'unlocked')

  // A new trigger has a reason of its own: the PIN before it is void.
  killswitch.trip({ trigger: 'rule', reason: 'writes outside the repository' })
  await unlock.request()
  const before = pinIn(sent.at(-1))
  killswitch.trip({ trigger: 'controller', reason: 'the worker does what nobody asked for' })
  assert.deepEqual(unlock.attempt(before), { status: 'no-pin' })
  // So does an unlock at the server: the next lock needs a PIN of its own.
  await unlock.request()
  const old = pinIn(sent.at(-1))
  killswitch.unlock({ by: 'scripts/unlock.mjs' })
  killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
  assert.deepEqual(unlock.attempt(old), { status: 'no-pin' })
})

test('the unlock in voice mode: three wrong PINs, across PINs, block it for the lock, also after a restart; the server still unlocks, and the next lock starts afresh', async () => {
  const { file, killswitch, unlock, sent, logged } = pinned('blocks')
  killswitch.trip({ trigger: 'controller', reason: 'a planted instruction' })
  await unlock.request()
  assert.deepEqual(unlock.attempt(wrongOf(pinIn(sent.at(-1)))), { status: 'wrong', left: 2 })
  await unlock.request()
  const pin = pinIn(sent.at(-1))
  assert.deepEqual(unlock.attempt(wrongOf(pin)), { status: 'wrong', left: 1 })
  assert.deepEqual(unlock.attempt(wrongOf(pin)), { status: 'blocked', now: true })
  assert.equal(
    sent.at(-1),
    'cc-voice-gateway on testbox: 3 wrong PINs in voice mode, so unlocking by voice is blocked for this lock. Unlock at the server: node scripts/unlock.mjs',
  )
  assert.ok(logged.includes('kill switch: 3 wrong PINs in voice mode; for this lock only scripts/unlock.mjs unlocks it now'))
  // The right one, and a new one, count for nothing now.
  const count = sent.length
  assert.deepEqual(unlock.attempt(pin), { status: 'blocked' })
  assert.deepEqual(await unlock.request(), { status: 'blocked' })
  assert.equal(sent.length, count, 'no new PIN')
  assert.equal(killswitch.locked, true)
  assert.equal(killswitch.byVoice, false)
  assert.match(alarmText(killswitch.state, { voice: killswitch.byVoice }), /Only someone at the server can unlock it, with scripts\/unlock\.mjs\.$/)

  // A restart keeps the count with the lock.
  const restarted = new KillSwitch({ file, log: () => {} })
  assert.equal(restarted.state.wrongPins, 3)
  const again = new VoiceUnlock({ killswitch: restarted, send: async () => assert.fail('no PIN after a block'), log: () => {} })
  assert.deepEqual(await again.request(), { status: 'blocked' })
  // The server unlocks it as ever, and the next lock may be unlocked by voice again.
  assert.equal(restarted.unlock({ by: 'scripts/unlock.mjs' }).wrongPins, 3)
  assert.equal(existsSync(file), false)
  killswitch.unlock({ by: 'scripts/unlock.mjs' })
  killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
  assert.equal(killswitch.state.wrongPins, undefined)
  assert.equal((await unlock.request()).status, 'sent')
  assert.equal(unlock.attempt(pinIn(sent.at(-1))).status, 'unlocked')
})

test('the unlock in voice mode: not without Telegram, not in a standby, not for a kill switch file that cannot be read; a PIN that did not go out is none', async () => {
  const off = pinned('no-telegram', { send: false })
  off.killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
  assert.deepEqual(await off.unlock.request(), { status: 'no-telegram' })
  assert.deepEqual(off.unlock.attempt('1234'), { status: 'no-telegram' })
  assert.equal(off.killswitch.byVoice, false)

  let standby = true
  const paused = pinned('standby', { paused: () => standby })
  paused.killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
  assert.deepEqual(await paused.unlock.request(), { status: 'standby' })
  assert.deepEqual(paused.sent, [])
  standby = false
  await paused.unlock.request()
  standby = true
  assert.deepEqual(paused.unlock.attempt(pinIn(paused.sent.at(-1))), { status: 'standby' })
  assert.equal(paused.killswitch.locked, true)

  const file = join(TMP, 'pin', 'unreadable', 'killswitch.json')
  mkdirSync(join(TMP, 'pin', 'unreadable'), { recursive: true })
  writeFileSync(file, '{ not json')
  const damaged = new KillSwitch({ file, log: () => {} })
  const sent = []
  const unlock = new VoiceUnlock({ killswitch: damaged, send: async text => void sent.push(text), log: () => {} })
  assert.deepEqual(await unlock.request(), { status: 'unreadable' })
  assert.deepEqual(sent, [])
  assert.equal(damaged.byVoice, false)

  const logged = []
  const failing = new KillSwitch({ file: join(TMP, 'pin', 'unsent', 'killswitch.json'), log: () => {} })
  const broken = new VoiceUnlock({ killswitch: failing, send: async () => { throw new Error('502 Bad Gateway') }, log: (...parts) => logged.push(parts.join(' ')) })
  failing.trip({ trigger: 'voice', reason: 'emergency stop' })
  assert.deepEqual(await broken.request(), { status: 'unsent', why: '502 Bad Gateway' })
  assert.equal(broken.pin, null)
  assert.deepEqual(broken.attempt('1234'), { status: 'no-pin' })
  assert.deepEqual(logged.slice(0, 1), ['kill switch: the unlock PIN was not sent by Telegram, so none is valid: 502 Bad Gateway'])
})

test('the unlock PIN typed on Telegram: masked in the input log, the log and every event, and not passed on; other digits stay', async () => {
  const { killswitch, unlock, sent } = pinned('telegram')
  assert.equal(unlock.masked('PIN 1234'), 'PIN 1234', 'no PIN, nothing masked')
  killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
  await unlock.request()
  const pin = pinIn(sent.at(-1))
  const spaced = [...pin].join(' ')
  assert.equal(unlock.masked(`Der PIN ist ${pin}`), 'Der PIN ist ****')
  assert.equal(unlock.masked(`PIN: ${spaced}.`), 'PIN: ****.')
  assert.equal(unlock.masked(`${[...pin].join('-')} please`), '**** please')
  assert.equal(unlock.masked(`7${pin}0`), '****', 'within more digits')
  const other = wrongOf(pin)
  assert.equal(unlock.masked(`pull request ${other}`), `pull request ${other}`)

  const recorded = []
  const logged = []
  const heard = []
  const commands = new TelegramCommands(
    { chatId: '4242' },
    { answers: true, record: entry => recorded.push(entry), masked: text => unlock.masked(text), log: line => logged.push(line) },
  )
  for (const name of ['stop', 'answer', 'refused', 'away']) commands.on(name, event => heard.push([name, event]))
  let id = 900
  const update = text =>
    commands.handle({ update_id: id, message: { message_id: id++, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false }, text } })
  update(pin)
  update(`/unlock ${spaced}`)
  update(`Kill switch ${pin}`) // a stop, with the PIN masked in its reason
  update(`Fix pull request ${other}`)
  assert.deepEqual(
    heard.map(([name, event]) => [name, event.why ?? event.text]),
    [
      ['refused', 'it holds the unlock PIN, which counts only when you say it in voice mode. Say it there.'],
      ['refused', 'it holds the unlock PIN, which counts only when you say it in voice mode. Say it there.'],
      ['stop', 'Kill switch ****'],
      ['answer', `Fix pull request ${other}`],
    ],
  )
  assert.deepEqual(recorded.slice(0, 3).map(entry => entry.text), ['****', '/unlock ****', 'Kill switch ****'])
  for (const text of [JSON.stringify(recorded), JSON.stringify(heard), logged.join('\n')]) assert.ok(!holdsPin(text, pin), text)
  assert.equal(killswitch.locked, true, 'Telegram never unlocks')
})

// --- the rules ---------------------------------------------------------------------------

function guarded({
  git = {},
  limits,
  direct = false,
  pushDirect = false,
  runFolder = null,
  docker = false,
  repo = 'alpha',
  slug = 'acme/alpha',
  defaultBranch = 'main',
  mergeLookupMs = 3000,
  task: given = null,
} = {}) {
  const workers = new EventEmitter()
  const tripped = []
  const logged = []
  const gitCalls = [] // [dir, ...args]: git as the runner runs it, in the container for docker
  let saves = 0
  workers.save = () => saves++
  const runner = {
    ...(docker ? { container: 'voice-workers' } : {}),
    dir: name => `/work/${name}`,
    git: async (dir, ...args) => {
      gitCalls.push([dir, ...args])
      const key = args.join(' ')
      const found = Object.keys(git).find(prefix => key.startsWith(prefix))
      return found ? git[found] : null
    },
  }
  const guard = new RunGuard({
    workers,
    runner,
    killswitch: { trip: event => tripped.push(event) },
    ghBin: join(BIN, 'gh'),
    limits,
    mainCheckSeconds: 3600,
    mergeLookupMs,
    mergeRecheckMs: 3600 * 1000,
    log: (...parts) => logged.push(parts.join(' ')),
  })
  const task = given ?? {
    id: 'tabc',
    repo,
    dir: `/work/${repo}`,
    slug,
    defaultBranch,
    direct,
    pushDirect,
    access: direct ? 'full' : null,
    startedAt: Date.now() - 1000,
    ...(runFolder ? { runFolder } : {}),
  }
  workers.emit('started', task)
  let calls = 0
  const tool = (name, input, id = `toolu_${++calls}`) => workers.emit('tool', task, { type: 'tool_use', id, name, input })
  // The lookups of gh pr merge going, done.
  const settled = () => guard.settled(guard.runs.get(task.id))
  return { guard, tripped, logged, gitCalls, saves: () => saves, task, tool, settled, bash: (command, id) => tool('Bash', { command }, id) }
}

test('rule: writes outside the repository and the temporary folders', () => {
  const inside = guarded()
  inside.tool('Write', { file_path: '/work/alpha/src/a.js', content: 'x' })
  inside.tool('Edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' })
  inside.tool('Write', { file_path: '/tmp/scratch.txt', content: 'x' })
  inside.bash('npm test 2> /dev/null && mkdir -p build/out && cp a.txt build/out/ && cat /etc/hosts')
  inside.bash('rm "$UNKNOWN"/x') // a variable hides the target: not seen
  // A > in quotes is no redirection: a sed pattern, a message.
  inside.bash(`sed -n '/<section id="selection"/,/<\\/section>/p' index.html`)
  inside.bash('echo "a > b" && grep -c "<div>" index.html > /tmp/count.txt')
  // The end of a command substitution is no part of the target.
  inside.bash('for p in $(pgrep node); do echo "$p $(readlink /proc/$p/cwd 2>/dev/null)"; done')
  inside.bash('v=$(git rev-parse HEAD 2>/dev/null) && w=`cat a 2>/dev/null`')
  assert.deepEqual(inside.tripped, [], 'nothing outside')
  inside.guard.close()

  // Each case in a run of its own: a rule trips once per run.
  for (const [kind, value, path] of [
    ['Write', '/etc/cron.d/x', '/etc/cron.d/x'],
    ['Bash', 'echo evil >> ~/.bashrc', `${homedir()}/.bashrc`],
    ['Bash', 'cd / && rm -rf etc', '/etc'],
    ['Bash', 'cp tool /usr/local/bin/tool', '/usr/local/bin/tool'],
    ['Bash', 'sed -i s/a/b/ ../other/config', '/work/other/config'],
    ['Bash', 'echo x | tee $HOME/.ssh/authorized_keys', `${homedir()}/.ssh/authorized_keys`],
    ['Bash', 'echo x > "/etc/quoted target"', '/etc/quoted'],
    ['Bash', "echo \\' > /etc/escaped \\'", '/etc/escaped'],
    ['Bash', `echo '<b>' >> '/etc/after quotes'`, '/etc/after'],
    ['Bash', 'echo "$(cat a > /etc/substituted)"', '/etc/substituted'],
  ]) {
    const run = guarded()
    if (kind === 'Write') run.tool('Write', { file_path: value, content: 'x' })
    else run.bash(value)
    assert.equal(run.tripped.length, 1, value)
    assert.equal(run.tripped[0].trigger, 'rule')
    assert.match(run.tripped[0].reason, /^write outside the allowed folders: /, value)
    assert.ok(run.tripped[0].reason.includes(path), `${value}: ${run.tripped[0].reason}`)
    assert.match(run.tripped[0].reason, /\(worker alpha, task tabc\)$/)
    run.guard.close()
  }
})

test("rule: the run's own run folder is allowed, by path and as $TMPDIR or $VOICE_GW_RUN_FOLDER; the folders around it, another run's and ~/voice-scratch are not", () => {
  const folder = '/work/.voice-runs/alpha/2026-11-01-abcd'
  const inside = guarded({ runFolder: folder })
  inside.bash(`mkdir -p /tmp/cfgtool/shots ${folder}/drawusaurus-redesign`)
  inside.tool('Write', { file_path: `${folder}/shots/home.png`, content: 'x' })
  inside.bash('mkdir -p "$VOICE_GW_RUN_FOLDER/profile" && node shot.js > "$TMPDIR/shot.log" 2>&1')
  inside.bash('cp out/menu.png ${TMPDIR}/menu.png && cd "$VOICE_GW_RUN_FOLDER" && touch done.txt')
  inside.bash(`rm -rf ${folder}/profile`)
  assert.deepEqual(inside.tripped, [], 'all of it in the run folder or /tmp')
  inside.guard.close()

  // The incident of 2026-11-01, without a run folder of its own to go to;
  // and with one, everything around it.
  for (const [runFolder, command, path] of [
    [null, `mkdir -p /tmp/cfgtool/shots ${homedir()}/voice-scratch/drawusaurus-redesign`, `${homedir()}/voice-scratch/drawusaurus-redesign`],
    [folder, `mkdir -p ${homedir()}/voice-scratch/drawusaurus-redesign`, `${homedir()}/voice-scratch/drawusaurus-redesign`],
    [folder, 'echo x > /work/.voice-runs/alpha/2026-11-01-wxyz/a.txt', '/work/.voice-runs/alpha/2026-11-01-wxyz/a.txt'],
    [folder, 'touch /work/.voice-runs/alpha/x', '/work/.voice-runs/alpha/x'],
    [folder, 'rm -rf /work/.voice-runs', '/work/.voice-runs'],
    [folder, 'cp a.png "$TMPDIR/../2026-11-01-wxyz/a.png"', '/work/.voice-runs/alpha/2026-11-01-wxyz/a.png'],
    [folder, 'echo x > "$VOICE_GW_RUN_FOLDER/../../beta/y"', '/work/.voice-runs/beta/y'],
  ]) {
    const run = guarded({ runFolder })
    run.bash(command)
    assert.equal(run.tripped.length, 1, command)
    assert.match(run.tripped[0].reason, /^write outside the allowed folders: /, command)
    assert.ok(run.tripped[0].reason.includes(path), `${command}: ${run.tripped[0].reason}`)
    run.guard.close()
  }
  // A Write the same way.
  const write = guarded({ runFolder: folder })
  write.tool('Write', { file_path: `${homedir()}/voice-scratch/2026-11-01-k3pz/notes.md`, content: 'x' })
  assert.match(write.tripped[0]?.reason ?? '', /^write outside the allowed folders: Write .*voice-scratch\/2026-11-01-k3pz\/notes\.md/)
  write.guard.close()
  // Without a run folder, $TMPDIR is a variable it cannot see through, as before.
  const none = guarded()
  none.bash('echo x > "$TMPDIR/a.txt"')
  assert.deepEqual(none.tripped, [])
  none.guard.close()
})

test('rule: a push to the default branch, unless it was an explicit direct dispatch (gh pr merge: below)', () => {
  for (const command of [
    'git push origin main',
    'git push origin HEAD:refs/heads/main',
    'git push --force origin +voice/x:main',
    'git -C . push --all origin',
  ]) {
    const { tripped, bash, guard } = guarded()
    bash(command)
    assert.equal(tripped.length, 1, command)
    assert.match(tripped[0].reason, /^push to the default branch: /, command)
    guard.close()
  }
  for (const command of ['git push -u origin voice/fix', 'git push origin HEAD:voice/fix', 'git pull origin main']) {
    const { tripped, bash, guard } = guarded()
    bash(command)
    assert.deepEqual(tripped, [], command)
    guard.close()
  }
  const direct = guarded({ direct: true })
  direct.bash('git push origin main')
  assert.deepEqual(direct.tripped, [], 'a direct dispatch at level full may push to main')
  direct.guard.close()
  const off = guarded({ pushDirect: true })
  off.bash('git push origin main')
  assert.deepEqual(off.tripped, [], 'with pull requests turned off, main is where workers push')
  off.guard.close()
})

test('rule: the default branch moved on GitHub during the run, and the worker has the new head', async () => {
  writeFileSync(GH_STATE, JSON.stringify({ heads: { 'acme/alpha': 'aaaaaaa1111' } }))
  const own = guarded({ git: { 'cat-file -e bbbbbbb2222': '' } })
  const other = guarded({ git: {} })
  await own.guard.runs.get('tabc').ready
  await other.guard.runs.get('tabc').ready
  writeFileSync(GH_STATE, JSON.stringify({ heads: { 'acme/alpha': 'bbbbbbb2222' } }))
  await own.guard.ended(own.task)
  await other.guard.ended(other.task)
  assert.equal(own.tripped.length, 1)
  assert.match(own.tripped[0].reason, /^push to the default branch: main on GitHub moved from aaaaaaa to bbbbbbb during the run, and the worker's repository holds the new head/)
  assert.deepEqual(other.tripped, [], 'someone else pushed: the worker does not have that commit')
  own.guard.close()
  other.guard.close()
})

test('rule: gh api calls that merge are merges, unless it was an explicit direct dispatch', () => {
  // As strict as ever, whatever the base: only gh pr merge has its base looked up (below).
  for (const command of [
    'gh api -X PUT repos/acme/alpha/pulls/12/merge',
    'gh api -XPUT /repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash',
    'gh api --method PUT https://api.github.com/repos/acme/alpha/pulls/12/merge',
    'gh api repos/acme/alpha/pulls/12/merge --method=put',
    'gh api repos/acme/alpha/merges -f base=main -f head=voice/fix',
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_kw"}) { clientMutationId } }'`,
    "gh api graphql -F id=PR_kw -f query='\nmutation($id: ID!) {\n  enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId }\n}'",
  ]) {
    const { tripped, bash, guard } = guarded()
    bash(command)
    assert.equal(tripped.length, 1, command)
    assert.match(tripped[0].reason, /^push to the default branch: the command "gh api .*" merges /, command)
    guard.close()
  }
  for (const command of [
    'gh api repos/acme/alpha/pulls/12/merge', // GET: whether it is merged
    'gh api repos/acme/alpha/pulls/12/reviews -f event=COMMENT -f body=Fine',
    `gh api graphql -f query='{ repository(owner: "acme", name: "alpha") { pullRequest(number: 12) { reviewThreads(first: 50) { nodes { isResolved } } } } }'`,
    'gh pr comment 12 --body "no mergePullRequest here"',
  ]) {
    const { tripped, bash, guard } = guarded()
    bash(command)
    assert.deepEqual(tripped, [], command)
    guard.close()
  }
  const direct = guarded({ direct: true })
  direct.bash('gh api -X PUT repos/acme/alpha/pulls/12/merge')
  assert.deepEqual(direct.tripped, [], 'a direct dispatch at level full may merge, as with gh pr merge')
  direct.guard.close()
})

// --- gh pr merge: its base, looked up on GitHub --------------------------------------

// A pull request as GitHub's REST API has it, with its base and the repository's default branch.
function pullRequest(number, base, { slug = 'acme/alpha', head = `voice/pr${number}`, state = 'open', merged = false, defaultBranch = 'main' } = {}) {
  return {
    number,
    state,
    merged,
    merged_at: merged ? new Date().toISOString() : null,
    base: { ref: base, repo: { full_name: slug, default_branch: defaultBranch } },
    head: { ref: head, label: `${slug.split('/')[0]}:${head}` },
  }
}

function github(prs, extra = {}) {
  const byKey = Object.fromEntries(prs.map(pr => [`${pr.base.repo.full_name}#${pr.number}`, pr]))
  writeFileSync(GH_STATE, JSON.stringify({ heads: {}, prs: byKey, ...extra }))
}

// The checkout's git as gh reads it: one remote, the worker's repository on
// GitHub, and the current branch tracking its namesake there.
function checkout({ slug = 'acme/alpha', branch = 'voice/pr12', remotes = null, config = '' } = {}) {
  const url = `https://github.com/${slug}.git`
  return {
    'remote -v': remotes ?? `origin\t${url} (fetch)\norigin\t${url} (push)\n`,
    'config --get-regexp':
      `remote.origin.url ${url}\nremote.origin.fetch +refs/heads/*:refs/remotes/origin/*\n` +
      (branch ? `branch.${branch}.remote origin\nbranch.${branch}.merge refs/heads/${branch}\n` : '') +
      config,
    'symbolic-ref': branch ? `${branch}\n` : null,
  }
}

const LET_GO = /^kill switch rule on the default branch: let gh pr merge of pull request (\d+) in (\S+) go, into (\S+), not the default branch (\S+) \(worker (\S+), task tabc\)$/

test('rule: gh pr merge into another branch than the default one goes, logged; into the default branch it locks, once GitHub has answered', async () => {
  github([
    pullRequest(12, 'simple-modern'),
    pullRequest(13, 'main'),
    pullRequest(14, 'dev', { defaultBranch: 'dev' }), // the default branch is dev now, on GitHub
    pullRequest(1080, 'simple-modern', { slug: 'jgraph/drawio-dev', defaultBranch: 'dev' }),
  ])
  // The false alarm of 2026-11-02: a stacked pull request into simple-modern,
  // in a repository whose default branch is dev.
  const incident = guarded({ repo: 'drawio-dev', slug: 'jgraph/drawio-dev', defaultBranch: 'dev' })
  incident.bash('gh pr merge 1080 --repo jgraph/drawio-dev --merge --delete-branch --match-head-commit dc534e0a9b8c')
  assert.deepEqual(incident.tripped, [], 'nothing at once: the lookup goes')
  await incident.settled()
  assert.deepEqual(incident.tripped, [])
  assert.ok(
    incident.logged.includes(
      'kill switch rule on the default branch: let gh pr merge of pull request 1080 in jgraph/drawio-dev go, into simple-modern, not the default branch dev (worker drawio-dev, task tabc)',
    ),
    incident.logged.join('\n'),
  )
  assert.deepEqual(incident.gitCalls, [], 'with --repo, the folder does not matter')
  assert.deepEqual(incident.task.mergesLetGo, { toolu_1: { slug: 'jgraph/drawio-dev', numbers: [1080] } }, 'kept with the task')
  assert.equal(incident.saves(), 1, "in the workers' state")
  incident.guard.close()

  // Every form gh reads: a number, a URL, a branch, none (the current
  // branch's); the repository from --repo, a URL or the folder's remote.
  for (const [command, folder] of [
    ['gh pr merge 12 --squash', true],
    ["gh pr merge '#12' --repo=acme/alpha --squash 2>&1", false],
    ['gh pr merge https://github.com/acme/alpha/pull/12 -sd', false],
    ['gh pr merge https://github.com/acme/alpha/pull/12/files --repo github.com/acme/alpha', false],
    ['gh pr merge voice/pr12 -R acme/alpha --rebase', false],
    ['gh pr merge voice/pr12 --merge', true],
    ['gh pr merge acme:voice/pr12 --merge -R acme/alpha', false],
    ['gh pr merge --squash --delete-branch', true],
    ['gh pr merge -sdR Acme/Alpha', true], // the current branch's: the folder still says which branch
    ['gh pr merge 12 -R https://github.com/acme/alpha.git -t "Merge the menu" -b "Stacked on simple-modern."', false],
    ['gh pr merge --repo acme/alpha -- 12', false],
  ]) {
    const run = guarded({ git: checkout() })
    run.bash(command)
    await run.settled()
    assert.deepEqual(run.tripped, [], command)
    const line = run.logged.find(entry => LET_GO.test(entry))
    assert.ok(line, `${command}: ${run.logged.join('\n')}`)
    assert.deepEqual(LET_GO.exec(line).slice(1), ['12', 'acme/alpha', 'simple-modern', 'main', 'alpha'], command)
    assert.equal(run.gitCalls.length > 0, folder, `${command}: ${JSON.stringify(run.gitCalls)}`)
    run.guard.close()
  }
  // The folder gh reads is the one the shell is in, after a cd.
  const sub = guarded({ git: checkout() })
  sub.bash('cd src')
  sub.bash('gh pr merge 12')
  await sub.settled()
  assert.deepEqual(sub.tripped, [])
  assert.deepEqual(sub.gitCalls.map(call => call.slice(0, 2)), [['/work/alpha/src', 'remote'], ['/work/alpha/src', 'config']])
  sub.guard.close()

  // Into the default branch: as the run knew it, or as GitHub has it now.
  for (const [command, git, into] of [
    ['gh pr merge 13 --squash', checkout(), '13 in acme/alpha into main'],
    ['gh pr merge 13 -R acme/alpha', {}, '13 in acme/alpha into main'],
    ['gh pr merge https://github.com/acme/alpha/pull/13', {}, '13 in acme/alpha into main'],
    ['gh pr merge voice/pr13 --repo acme/alpha --squash', {}, '13 in acme/alpha into main'],
    ['gh pr merge --squash', checkout({ branch: 'voice/pr13' }), '13 in acme/alpha into main'],
    ['gh pr merge 14 --repo acme/alpha', {}, '14 in acme/alpha into dev'],
  ]) {
    const run = guarded({ git })
    run.bash(command)
    await run.settled()
    assert.equal(run.tripped.length, 1, command)
    assert.equal(
      run.tripped[0].reason,
      `push to the default branch: the command "${command}" merges pull request ${into}, the default branch (worker alpha, task tabc)`,
    )
    assert.ok(!run.logged.some(entry => LET_GO.test(entry)), command)
    assert.equal(run.task.mergesLetGo, undefined)
    run.guard.close()
  }
  // A direct dispatch at level full may merge into it, as before: nothing to look up.
  const direct = guarded({ direct: true })
  direct.bash('gh pr merge 13 --repo acme/alpha && echo merged')
  await direct.settled()
  assert.deepEqual(direct.tripped, [])
  direct.guard.close()
})

test('rule: gh pr merge locks as before whenever the rule cannot be sure where it merges', async () => {
  github([pullRequest(12, 'simple-modern')])
  const lock = async (command, reason, options = {}, before = []) => {
    const run = guarded({ git: checkout(), ...options })
    for (const earlier of before) run.bash(earlier)
    run.bash(command)
    await run.settled()
    assert.equal(run.tripped.length, 1, command)
    assert.match(run.tripped[0].reason, /^push to the default branch: the command ".*" merges a pull request, .* \(worker alpha, task tabc\)$/, command)
    assert.match(run.tripped[0].reason, reason, `${command}: ${run.tripped[0].reason}`)
    assert.ok(!run.logged.some(entry => LET_GO.test(entry)), command)
    run.guard.close()
  }
  // Not alone on its line: another command could change the base meanwhile.
  for (const command of [
    'gh pr edit 12 --base main & gh pr merge 12 --repo acme/alpha',
    'gh pr merge 12 --repo acme/alpha && echo merged',
    'gh pr merge 12 --repo acme/alpha; gh pr edit 12 --base main',
    'gh pr merge 12 --repo acme/alpha &',
    'gh pr merge 12 --repo acme/alpha | tee /tmp/merge.log',
    '(gh pr merge 12 --repo acme/alpha)',
    'gh pr merge $(gh pr list --head voice/pr12 --json number -q ".[0].number") --repo acme/alpha',
    'sh -c "gh pr merge 12 --repo acme/alpha"',
    'GH_REPO=acme/beta gh pr merge 12',
    'env gh pr merge 12 --repo acme/alpha',
    'gh pr merge 12 --repo acme/alpha # the stack',
    'gh pr merge 12 --repo acme/alpha <<EOF\nbody\nEOF',
  ]) {
    await lock(command, /, not alone on its line, so its base is not looked up/)
  }
  // Words the shell still expands.
  for (const command of ['gh pr merge $PR --repo acme/alpha', 'gh pr merge 12 --repo acme/{alpha,beta}', 'gh pr merge 12 --repo acme/alpha -b *']) {
    await lock(command, /, with a variable, a pattern or braces in it/)
  }
  // Flags: --auto merges later, --admin past the protection, and what the rule does not read.
  await lock('gh pr merge 12 --repo acme/alpha --auto --squash', /, with --auto, which merges later/)
  await lock('gh pr merge 12 --repo acme/alpha --auto=false', /, with --auto/)
  await lock('gh pr merge 12 --repo acme/alpha --admin --squash', /, with --admin \(worker/)
  await lock('gh pr merge 12 --repo acme/alpha --disable-auto', /, with --disable-auto, which the rule does not read/)
  await lock('gh pr merge 12 --repo acme/alpha -sx', /, with -sx, which the rule does not read/)
  await lock('gh pr merge 12 13 --repo acme/alpha', /, with 12 13, which the rule does not read/)
  await lock('gh pr merge 12 --repo', /, with --repo, which the rule does not read/)
  // Which pull request, in which repository.
  await lock('gh pr merge https://github.com/acme/alpha/pulls/12', /, and the rule cannot tell which pull request https:\/\/github\.com\/acme\/alpha\/pulls\/12 is/)
  for (const command of [
    'gh pr merge 12 --repo acme/beta',
    'gh pr merge https://github.com/acme/beta/pull/12',
    'gh pr merge https://github.com/acme/beta/pull/12 --repo acme/alpha',
    'gh pr merge 12 --repo ghe.example.com/acme/alpha',
    "gh pr merge 12 --repo ''",
  ]) {
    await lock(command, /, in another repository than acme\/alpha/)
  }
  await lock('gh pr merge 12 --repo acme/alpha', /, and the worker's repository is not on GitHub/, { slug: null })
  // GitHub's answer.
  await lock('gh pr merge 99 --repo acme/alpha', /, and gh could not look up its base on GitHub/)
  await lock('gh pr merge voice/none --repo acme/alpha', /, and GitHub has no open pull request from acme:voice\/none/)
  // The folder gh takes the repository and the branch from.
  const twoRemotes =
    'origin\thttps://github.com/acme/alpha.git (fetch)\norigin\thttps://github.com/acme/alpha.git (push)\n' +
    'upstream\thttps://github.com/jgraph/alpha.git (fetch)\nupstream\thttps://github.com/jgraph/alpha.git (push)\n'
  await lock('gh pr merge 12', /, and the folder it runs in has 2 git remotes/, { git: checkout({ remotes: twoRemotes }) })
  await lock('gh pr merge 12', /, and the folder it runs in has 0 git remotes/, { git: { ...checkout(), 'remote -v': '' } })
  await lock('gh pr merge 12', /, and the remote origin of the folder it runs in is not acme\/alpha on GitHub/, { git: checkout({ slug: 'acme/beta' }) })
  await lock('gh pr merge 12', /, and git could not tell the remotes of the folder it runs in/, { git: {} })
  await lock('gh pr merge 12', /, and the folder it runs in has another repository set as gh's default/, {
    git: checkout({ config: 'remote.origin.gh-resolved jgraph/alpha\n' }),
  })
  await lock('gh pr merge --squash', /, and the folder it runs in is on no branch/, { git: checkout({ branch: null }) })
  for (const config of ['branch.voice/pr12.merge refs/heads/voice/other\n', 'branch.voice/pr12.pushremote fork\n', 'remote.pushdefault fork\n']) {
    await lock('gh pr merge --squash', /, and the branch voice\/pr12 tracks or pushes to another branch or remote/, { git: checkout({ config }) })
  }
  // After a cd the rule could not follow, or a script run in the shell, it
  // no longer knows the folder; --repo and a number need none.
  await lock('gh pr merge 12', /, and the folder gh takes the repository from is not certain/, {}, ['cd "$WORKDIR"'])
  await lock('gh pr merge --squash --repo acme/alpha', /, and the folder gh takes the repository from is not certain/, {}, ['cd "$WORKDIR"'])
  await lock('gh pr merge 12', /, and the folder gh takes the repository from is not certain/, {}, ['source .venv/bin/activate && npm test'])
  const named = guarded({ git: checkout() })
  named.bash('cd "$WORKDIR"')
  named.bash('gh pr merge 12 --repo acme/alpha')
  await named.settled()
  assert.deepEqual(named.tripped, [])
  named.guard.close()
  // GH_REPO in the environment the run inherits chooses the repository.
  process.env.GH_REPO = 'acme/beta'
  try {
    await lock('gh pr merge 12', /, and GH_REPO chooses the repository/)
  } finally {
    delete process.env.GH_REPO
  }
  // A lookup that takes too long.
  github([pullRequest(12, 'simple-modern')], { delayMs: 1500 })
  await lock('gh pr merge 12 --repo acme/alpha', /, and the lookup of its base took longer than 0\.3 seconds/, { mergeLookupMs: 300 })
  github([pullRequest(12, 'simple-modern')])
})

test("rule: gh pr merge of a worker in the container: git in the container, the lookup with the gateway's gh on this computer", async () => {
  github([pullRequest(12, 'simple-modern'), pullRequest(13, 'main')])
  const calls = join(TMP, 'gh-calls.jsonl')
  rmSync(calls, { force: true })
  process.env.FAKE_GH_LOG = calls
  process.env.GH_REPO = 'acme/beta' // the gateway's environment is not the container's
  try {
    const run = guarded({ docker: true, git: checkout() })
    run.bash('cd src')
    run.bash('gh pr merge 12 --squash')
    await run.settled()
    assert.deepEqual(run.tripped, [])
    assert.ok(run.logged.some(entry => LET_GO.test(entry)))
    // git through the runner, which runs it in the container, in the run's folder there
    assert.deepEqual(run.gitCalls.map(call => call.slice(0, 2)), [['/work/alpha/src', 'remote'], ['/work/alpha/src', 'config']])
    const gh = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(gh.some(args => args.join(' ') === 'api repos/acme/alpha/pulls/12'), 'gh here looked it up')
    run.guard.close()

    const main = guarded({ docker: true, git: checkout({ branch: 'voice/pr13' }) })
    main.bash('gh pr merge --squash')
    await main.settled()
    assert.match(main.tripped[0]?.reason ?? '', /merges pull request 13 in acme\/alpha into main, the default branch/)
    main.guard.close()
  } finally {
    delete process.env.FAKE_GH_LOG
    delete process.env.GH_REPO
  }
})

test('rule: a gh pr merge the rule let go is looked at again; merged into the default branch after all, its base changed after the lookup, it locks', async () => {
  github([pullRequest(15, 'simple-modern')])
  const run = guarded()
  run.bash('gh pr merge 15 --repo acme/alpha --squash')
  await run.settled()
  assert.deepEqual(run.tripped, [])
  github([pullRequest(15, 'main', { state: 'closed', merged: true })]) // retargeted to main just before it merged
  await run.guard.ended(run.task)
  assert.equal(run.tripped.length, 1)
  assert.equal(
    run.tripped[0].reason,
    'push to the default branch: pull request 15 in acme/alpha, whose gh pr merge the rule let go into simple-modern, was merged into main, ' +
      'the default branch: its base changed after the lookup (worker alpha, task tabc)',
  )
  run.guard.close()

  // Merged where it was looked up, or not merged at all: nothing.
  for (const after of [pullRequest(16, 'simple-modern', { state: 'closed', merged: true }), pullRequest(16, 'main')]) {
    github([pullRequest(16, 'simple-modern')])
    const fine = guarded()
    fine.bash('gh pr merge 16 --repo acme/alpha --squash')
    await fine.settled()
    github([after])
    await fine.guard.ended(fine.task)
    assert.deepEqual(fine.tripped, [], `${after.state} into ${after.base.ref}`)
    fine.guard.close()
  }
})

test('rule: a gateway that takes a run over reads its gh pr merge again, and goes by the pull requests let go before, not by the branch as it is now', async () => {
  github([pullRequest(12, 'simple-modern')])
  const first = guarded({ git: checkout() })
  first.bash('gh pr merge --squash --delete-branch', 'toolu_merge')
  await first.settled()
  assert.deepEqual(first.tripped, [])
  assert.deepEqual(first.task.mergesLetGo, { toolu_merge: { slug: 'acme/alpha', numbers: [12] } })
  first.guard.close()
  // Merged; gh switched the checkout to simple-modern, whose own pull request into main is open.
  github([pullRequest(12, 'simple-modern', { state: 'closed', merged: true }), pullRequest(20, 'main', { head: 'simple-modern' })])
  const taken = guarded({ git: checkout({ branch: 'simple-modern' }), task: first.task })
  taken.bash('gh pr merge --squash --delete-branch', 'toolu_merge')
  await taken.settled()
  assert.deepEqual(taken.tripped, [], 'pull request 12, into simple-modern, as before')
  assert.ok(taken.logged.some(entry => LET_GO.test(entry)))
  taken.guard.close()
  // Without what the earlier gateway kept: the branch as it is now.
  const blind = guarded({ git: checkout({ branch: 'simple-modern' }) })
  blind.bash('gh pr merge --squash --delete-branch', 'toolu_merge')
  await blind.settled()
  assert.match(blind.tripped[0]?.reason ?? '', /merges pull request 20 in acme\/alpha into main, the default branch/)
  blind.guard.close()
})

test("rule: a merge on GitHub of the run's pull request; not someone else's, such as the driver's at the desk", async () => {
  const now = new Date().toISOString()
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const pull = (number, ref, created, extra = {}) => ({
    number,
    merged_at: now,
    created_at: created,
    base: { ref: 'main' },
    head: { ref, repo: { full_name: 'acme/alpha' } },
    ...extra,
  })
  const seconds = Math.floor(Date.now() / 1000)
  const cases = [
    ['opened during the run from a voice/ branch', pull(12, 'voice/fix', now), {}, null,
      /: it merged pull request 12 from voice\/fix, opened during the run/],
    ['an older pull request whose branch the run pushed by name', pull(13, 'feature/x', yesterday), {}, 'git push -u origin feature/x',
      /: it merged pull request 13 from feature\/x, which the run pushed/],
    ["an older pull request whose branch the worker's repository pushed during the run", pull(14, 'voice/older', yesterday),
      { git: { 'reflog show': `origin/voice/older@{${seconds}} update by push\norigin/voice/older@{1700000000} update by push\n` } }, null,
      /: it merged pull request 14 from voice\/older, which the run pushed/],
    ["an earlier worker's pull request, merged at the desk", pull(15, 'voice/earlier', yesterday),
      { git: { 'reflog show': 'origin/voice/earlier@{1700000000} update by push\n' } }, null, null],
    ['a pull request into another branch', pull(16, 'voice/fix', now, { base: { ref: 'dev' } }), {}, null, null],
    ['a pull request from a fork', pull(17, 'voice/fix', now, { head: { ref: 'voice/fix', repo: { full_name: 'someone/alpha' } } }), {}, null, null],
    ['a direct dispatch', pull(18, 'voice/fix', now), { direct: true }, null, null],
  ]
  for (const [i, [what, merged, options, command, expected]] of cases.entries()) {
    writeFileSync(GH_STATE, JSON.stringify({ heads: { 'acme/alpha': 'aaaaaaa1111' } }))
    const run = guarded(options)
    await run.guard.runs.get('tabc').ready
    if (command) run.bash(command)
    const sha = `c${i}c${i}c${i}c${i}9999`
    writeFileSync(GH_STATE, JSON.stringify({ heads: { 'acme/alpha': sha }, pulls: { [sha]: [merged] } }))
    await run.guard.ended(run.task)
    if (expected) {
      assert.equal(run.tripped.length, 1, what)
      assert.match(run.tripped[0].reason, /^push to the default branch: main on GitHub moved from aaaaaaa to c\dc\dc\dc during the run: /, what)
      assert.match(run.tripped[0].reason, expected, what)
    } else {
      assert.deepEqual(run.tripped, [], what)
    }
    run.guard.close()
  }
})

test('rule: unusually many changes, in edits during the run and in git at its end', async () => {
  const edits = guarded({ limits: { maxEdits: 3 } })
  for (let i = 0; i < 4; i++) edits.tool('Edit', { file_path: `f${i}.js`, old_string: 'a', new_string: 'b' })
  assert.equal(edits.tripped.length, 1)
  assert.match(edits.tripped[0].reason, /^many changes: more than 3 file edits in one run/)
  edits.guard.close()

  const numstat = Array.from({ length: 12 }, (_, i) => `100\t50\tsrc/f${i}.js`).join('\n')
  const big = guarded({ limits: { maxFiles: 10, maxLines: 100000 }, git: { 'log --all': numstat, 'diff --numstat': '3\t1\tREADME.md', 'ls-files': 'new.txt' } })
  await big.guard.ended(big.task)
  assert.equal(big.tripped.length, 1)
  assert.match(big.tripped[0].reason, /^many changes: 14 files and 1804 lines changed in one run \(limits 10 files, 100000 lines\)/)
  big.guard.close()

  const small = guarded({ limits: { maxFiles: 10, maxLines: 100000 }, git: { 'log --all': '1\t1\tREADME.md' } })
  await small.guard.ended(small.task)
  assert.deepEqual(small.tripped, [])
  small.guard.close()
})

test('rule: many changes, the helper folder apart: what is untracked there has a limit of its own, real code stays as strict', async () => {
  const helpers = n => Array.from({ length: n }, (_, i) => `.voice-scratch/shots/s${i}.png`).join('\n')
  const code = (n, folder = 'src') => Array.from({ length: n }, (_, i) => `100\t50\t${folder}/f${i}.js`).join('\n')
  const limits = { maxFiles: 10, maxLines: 100000 }
  const end = async options => {
    const run = guarded(options)
    const measured = []
    run.guard.on('measured', (task, size) => measured.push(size))
    await run.guard.ended(run.task)
    run.guard.close()
    return { tripped: run.tripped, measured }
  }

  // As the run of 2026-11-01: far more helper files than files may change,
  // reports, screenshots and clones for helpers, next to a few files of code.
  const scratch = await end({
    limits,
    git: { 'log --all': '10\t2\tsrc/a.js\n5\t5\tsrc/b.js', 'diff --numstat': '1\t1\tREADME.md', 'ls-files': `${helpers(40)}\n.voice-scratch/clone-1/\nnew.txt` },
  })
  assert.deepEqual(scratch.tripped, [], 'helper files over the limit for files do not lock')
  assert.deepEqual(scratch.measured, [{ commits: 0, files: 4, lines: 24, pushed: false }], 'nor count as changed files')

  // Real code over the limit still locks, the helper files aside.
  const big = await end({ limits, git: { 'log --all': code(11), 'ls-files': helpers(40) } })
  assert.equal(big.tripped.length, 1)
  assert.equal(big.tripped[0].reason, 'many changes: 11 files and 1650 lines changed in one run (limits 10 files, 100000 lines) (worker alpha, task tabc)')

  // What is committed from the helper folder counts as any change, and so do
  // untracked files elsewhere, such as in a folder of another name.
  const committed = await end({ limits, git: { 'log --all': code(11, '.voice-scratch') } })
  assert.match(committed.tripped[0]?.reason ?? '', /^many changes: 11 files and 1650 lines changed in one run/)
  const elsewhere = await end({ limits, git: { 'ls-files': Array.from({ length: 11 }, (_, i) => `.voice-sc/r${i}.txt`).join('\n') } })
  assert.match(elsewhere.tripped[0]?.reason ?? '', /^many changes: 11 files and 0 lines changed in one run/)

  // Over the helper folder's own limit, it locks with a reason of its own.
  const many = await end({ limits: { ...limits, maxHelperFiles: 30 }, git: { 'ls-files': helpers(40) } })
  assert.equal(many.tripped.length, 1)
  assert.equal(many.tripped[0].reason, 'many changes: 40 untracked files in the helper folder .voice-scratch after one run (limit 30) (worker alpha, task tabc)')
  const both = await end({ limits: { ...limits, maxHelperFiles: 30 }, git: { 'log --all': code(11), 'ls-files': helpers(40) } })
  assert.match(both.tripped[0].reason, /^many changes: 11 files and 1650 lines changed in one run \(limits 10 files, 100000 lines\); 40 untracked files in the helper folder \.voice-scratch after one run \(limit 30\)/)

  const defaults = guarded()
  assert.equal(defaults.guard.maxHelperFiles, 10000)
  defaults.guard.close()
})

test('rule: many changes, file edits in the helper folder count apart, against its own limit', () => {
  const run = guarded({ limits: { maxEdits: 3, maxHelperFiles: 5 } })
  for (let i = 0; i < 3; i++) run.tool('Edit', { file_path: `src/f${i}.js`, old_string: 'a', new_string: 'b' })
  for (let i = 0; i < 3; i++) run.tool('Write', { file_path: `/work/alpha/.voice-scratch/report-${i}.md`, content: 'x' })
  run.tool('Write', { file_path: '.voice-scratch/a11y/summary.json', content: '{}' })
  assert.equal(run.guard.runs.get('tabc').helperEdits, 4)
  assert.deepEqual(run.tripped, [], 'three edits of code, four reports')
  run.tool('Write', { file_path: '.voice-scratch/log-1.txt', content: 'x' })
  run.tool('Write', { file_path: '.voice-scratch/log-2.txt', content: 'x' })
  assert.equal(run.tripped.length, 1)
  assert.equal(
    run.tripped[0].reason,
    'many changes: more than 5 file edits in the helper folder .voice-scratch, the run folder and the temporary folders in one run (worker alpha, task tabc)',
  )
  run.guard.close()

  // The run folder and the temporary folders count with the helper folder:
  // nothing there is a change of the repository's.
  const folder = guarded({ limits: { maxEdits: 2, maxHelperFiles: 100 }, runFolder: '/work/.voice-runs/alpha/2026-11-01-abcd' })
  for (let i = 0; i < 5; i++) folder.tool('Write', { file_path: `/work/.voice-runs/alpha/2026-11-01-abcd/shots/s${i}.png`, content: 'x' })
  for (let i = 0; i < 5; i++) folder.tool('Write', { file_path: `/tmp/cfgtool/shots/s${i}.png`, content: 'x' })
  assert.equal(folder.guard.runs.get('tabc').helperEdits, 10)
  assert.equal(folder.guard.runs.get('tabc').edits, 0)
  assert.deepEqual(folder.tripped, [])
  folder.guard.close()

  // A folder of another name is code; so is a file named like the folder.
  const code = guarded({ limits: { maxEdits: 3, maxHelperFiles: 5 } })
  code.tool('Write', { file_path: '.voice-scratchy/a.txt', content: 'x' })
  code.tool('Write', { file_path: '/work/alpha/.voice-scratch', content: 'x' })
  code.tool('Write', { file_path: '/work/alpha/src/.voice-scratch/b.txt', content: 'x' })
  code.tool('Edit', { file_path: 'src/a.js', old_string: 'a', new_string: 'b' })
  assert.equal(code.tripped.length, 1)
  assert.match(code.tripped[0].reason, /^many changes: more than 3 file edits in one run/)
  code.guard.close()
})

// --- many changes, in a real repository ------------------------------------------------------

// A repository with a remote, as the drawio-dev worker found it on
// 2026-11-02, an hour before the run: the default branch main (src/core.js,
// 1,500 lines), and a long-lived branch feature that left main at the merge
// base with code of its own, in two areas: area1 (two new files of 400
// lines, and 300 lines of src/core.js changed) and area2 (one new file of
// 400 lines). Both pushed; main went on after (docs/notes.md).
let sizeRepos = 0
function sizeRepo() {
  const root = join(TMP, `size${++sizeRepos}`)
  const dir = join(root, 'alpha')
  const remote = join(root, 'remote.git')
  mkdirSync(dir, { recursive: true })
  const who = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
  const hourAgo = `@${Math.floor(Date.now() / 1000) - 3600} +0000`
  const gitIn = (cwd, env) => (...args) =>
    execFileSync('git', args, { cwd, env: { ...process.env, ...who, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const before = gitIn(dir, { GIT_AUTHOR_DATE: hourAgo, GIT_COMMITTER_DATE: hourAgo })
  const write = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const lines = (n, word) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n') + '\n'
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  before('init', '-q', '-b', 'main')
  before('remote', 'add', 'origin', remote)
  write('src/core.js', lines(1500, 'core'))
  write('README.md', '# alpha\n')
  before('add', '.')
  before('commit', '-q', '-m', 'main')
  const base = before('rev-parse', 'HEAD')
  before('switch', '-q', '-c', 'feature')
  write('area1/a1.js', lines(400, 'a1'))
  write('area1/a2.js', lines(400, 'a2'))
  write('src/core.js', lines(300, 'feature core') + lines(1500, 'core').split('\n').slice(300).join('\n'))
  before('add', '.')
  before('commit', '-q', '-m', 'feature: area 1')
  write('area2/b1.js', lines(400, 'b1'))
  before('add', '.')
  before('commit', '-q', '-m', 'feature: area 2')
  before('switch', '-q', 'main')
  write('docs/notes.md', lines(10, 'note'))
  before('add', '.')
  before('commit', '-q', '-m', 'main goes on')
  before('push', '-q', '-u', 'origin', 'main', 'feature')
  return { root, dir, remote, base, git: gitIn(dir, {}), gitIn, write, lines, before }
}

// The run of 2026-11-02 in that repository: review branches made of the
// existing code of feature, one pair per area: a base, feature with the
// area set back to the merge base, and a head on it whose tree is feature's,
// so that the head's diff is exactly the area's code. Then a small fix on a
// branch of its own, 10 new lines. All pushed, to new remote branches.
function reviewBranches(repo, git = repo.git) {
  for (const [n, area, files] of [
    [1, 'area1', ['src/core.js']],
    [2, 'area2', []],
  ]) {
    git('switch', '-q', '-c', `review-base-${n}`, 'origin/feature')
    for (const file of files) git('checkout', repo.base, '--', file)
    git('rm', '-q', '-r', area)
    git('commit', '-q', '-m', `Review-only base: ${area} as before feature (never merged)`)
    const head = git('commit-tree', 'origin/feature^{tree}', '-p', 'HEAD', '-m', `Review-only head: ${area}`)
    git('branch', `review-head-${n}`, head)
  }
  git('switch', '-q', '-c', 'review-fixes', 'origin/feature')
  repo.write('src/fix.js', repo.lines(10, 'fix'))
  git('add', 'src/fix.js')
  git('commit', '-q', '-m', 'Fixes of the review')
  git('push', '-q', 'origin', 'review-base-1', 'review-head-1', 'review-base-2', 'review-head-2', 'review-fixes')
}

// The size check at the end of a run in that repository: what act does is
// the run's; pushes are the git push commands the rules see.
async function sizeCheck(repo, act, { limits = { maxFiles: 100, maxLines: 1000 }, task: more = {}, runner = new HostRunner(repo.root), pushes = [] } = {}) {
  const workers = new EventEmitter()
  const tripped = []
  const logged = []
  const measured = []
  const guard = new RunGuard({
    workers,
    runner,
    killswitch: { trip: event => tripped.push(event.reason) },
    limits,
    mainCheckSeconds: 3600,
    log: (...parts) => logged.push(parts.join(' ')),
  })
  guard.on('measured', (task, size) => measured.push(size))
  const task = { id: 'tsz4', repo: 'alpha', dir: repo.dir, slug: null, defaultBranch: 'main', startedAt: Date.now() - 1000, ...more }
  workers.emit('started', task)
  act()
  for (const command of pushes) workers.emit('tool', task, { type: 'tool_use', id: `toolu_${command.length}`, name: 'Bash', input: { command } })
  await guard.ended(task)
  guard.close()
  return { tripped, logged, measured: measured[0] }
}

const REVIEW_PUSH = 'git push -q origin review-base-1 review-head-1 review-base-2 review-head-2 review-fixes'

test('rule: many changes, the run of 2026-11-02: review branches made of existing code count nothing, a fix on them does', async () => {
  const repo = sizeRepo()
  const run = await sizeCheck(repo, () => reviewBranches(repo), { pushes: [REVIEW_PUSH] })
  assert.deepEqual(run.tripped, [], 'the review branches took over what feature had: no lock')
  // Counted as before, they were 2 * (600 + 800) + 2 * 400 = 3,600 lines in
  // four files, and the fix; now only the fix.
  assert.deepEqual(run.measured, { commits: 5, files: 1, lines: 10, pushed: true })
  assert.ok(
    run.logged.includes(
      'kill switch rule on many changes: 1 files and 10 lines changed in one run, not counting 3600 lines in 4 files that branches the run made took over from before it (worker alpha, task tsz4)',
    ),
    run.logged.join('\n'),
  )

  // The same through a runner without gitRun, such as one in the container:
  // every look goes through its git, in the run's folder.
  const second = sizeRepo()
  const calls = []
  const host = new HostRunner(second.root)
  const container = {
    container: 'voice-workers',
    dir: name => join(second.root, name),
    git: (dir, ...args) => {
      calls.push([dir, ...args])
      return host.git(dir, ...args)
    },
  }
  const inside = await sizeCheck(second, () => reviewBranches(second), { runner: container, pushes: [REVIEW_PUSH] })
  assert.deepEqual(inside.tripped, [])
  assert.deepEqual(inside.measured, { commits: 5, files: 1, lines: 10, pushed: true })
  assert.ok(calls.every(([dir]) => dir === second.dir))
  for (const look of ['for-each-ref', 'log --walk-reflogs', 'rev-parse', '--literal-pathspecs log', 'ls-tree']) {
    assert.ok(calls.some(([, ...args]) => args.join(' ').startsWith(look)), look)
  }
})

test('rule: many changes, what still counts: a branch from before the run set back or rewritten, new code, a wipe, a push it cannot follow', async () => {
  const over = /^many changes: \d+ files and \d+ lines changed in one run \(limits 100 files, 1000 lines\)/

  // The same base, but on feature itself, a branch from before the run:
  // 1,800 lines of its code gone. Also when git expired the branch's reflog.
  for (const expired of [false, true]) {
    const repo = sizeRepo()
    if (expired) repo.before('reflog', 'expire', '--expire=all', 'refs/heads/feature', 'refs/remotes/origin/feature')
    const setBack = await sizeCheck(
      repo,
      () => {
        repo.git('switch', '-q', 'feature')
        repo.git('checkout', repo.base, '--', 'src/core.js')
        repo.git('rm', '-q', '-r', 'area1', 'area2')
        repo.git('commit', '-q', '-m', 'Set feature back')
        repo.git('push', '-q', 'origin', 'feature')
      },
      { pushes: ['git push -q origin feature'] },
    )
    assert.equal(setBack.tripped.length, 1, `expired: ${expired}`)
    assert.match(setBack.tripped[0], over)
    assert.match(setBack.tripped[0], /: 4 files and 1800 lines changed/)
    assert.deepEqual(setBack.logged, [], 'nothing left out')
  }

  // Its history rewritten: feature rebased onto main and force-pushed. The
  // same rebase onto a branch the run made takes over what was there.
  const rewritten = sizeRepo()
  const rebase = await sizeCheck(
    rewritten,
    () => {
      rewritten.git('switch', '-q', 'feature')
      rewritten.git('rebase', '-q', 'origin/main')
      rewritten.git('push', '-q', '-f', 'origin', 'feature')
    },
    { pushes: ['git push -q -f origin feature'] },
  )
  assert.equal(rebase.tripped.length, 1)
  assert.match(rebase.tripped[0], /: 4 files and 1800 lines changed/)
  const copied = sizeRepo()
  const copy = await sizeCheck(
    copied,
    () => {
      copied.git('switch', '-q', '-c', 'feature-on-main', 'origin/feature')
      copied.git('rebase', '-q', 'origin/main')
      copied.git('push', '-q', 'origin', 'feature-on-main')
    },
    { pushes: ['git push -q origin feature-on-main'] },
  )
  assert.deepEqual(copy.tripped, [])
  assert.deepEqual(copy.measured, { commits: 2, files: 0, lines: 0, pushed: true })

  // New code on a new branch: 1,200 lines nobody had.
  const dumped = sizeRepo()
  const dump = await sizeCheck(dumped, () => {
    dumped.git('switch', '-q', '-c', 'voice/dump', 'origin/main')
    dumped.write('data/dump.json', dumped.lines(1200, 'row'))
    dumped.git('add', '.')
    dumped.git('commit', '-q', '-m', 'Dump')
  })
  assert.equal(dump.tripped.length, 1)
  assert.match(dump.tripped[0], /: 1 files and 1200 lines changed/)

  // A wipe on a new branch: the files of the default branch count, removed.
  const wiped = sizeRepo()
  const wipe = await sizeCheck(wiped, () => {
    wiped.git('switch', '-q', '-c', 'voice/wipe', 'origin/main')
    wiped.git('rm', '-q', '-r', '.')
    wiped.git('commit', '-q', '-m', 'Wipe')
  })
  assert.equal(wipe.tripped.length, 1)
  assert.match(wipe.tripped[0], /: 3 files and 1511 lines changed/)

  // A version from before the run, but as a new file elsewhere: new to its path.
  const moved = sizeRepo()
  const elsewhere = await sizeCheck(moved, () => {
    moved.git('switch', '-q', '-c', 'voice/copy', 'origin/feature')
    moved.write('copy/core.js', moved.git('show', 'origin/main:src/core.js') + '\n')
    moved.git('add', '.')
    moved.git('commit', '-q', '-m', 'Copy')
  })
  assert.equal(elsewhere.tripped.length, 1)
  assert.match(elsewhere.tripped[0], /: 1 files and 1500 lines changed/)

  // The review branches, but pushed to a URL: where they went, no remote
  // branch here shows, so everything counts, as before.
  const url = sizeRepo()
  const byUrl = await sizeCheck(url, () => reviewBranches(url), { pushes: [`git push -q ${url.remote} review-base-1 review-head-1`] })
  assert.equal(byUrl.tripped.length, 1)
  assert.equal(byUrl.tripped[0], 'many changes: 5 files and 3610 lines changed in one run (limits 100 files, 1000 lines) (worker alpha, task tsz4)')
})

test('rule: many changes, a run in a worktree: review branches from its detached HEAD count nothing', async () => {
  const repo = sizeRepo()
  const wt = join(repo.root, '.voice-worktrees', 'alpha', 'tsz4')
  repo.before('worktree', 'add', '-q', '--detach', wt, 'origin/feature')
  const git = repo.gitIn(wt, {})
  const run = await sizeCheck(
    repo,
    () => {
      git('checkout', repo.base, '--', 'src/core.js')
      git('rm', '-q', '-r', 'area1')
      git('commit', '-q', '-m', 'Review-only base: area1 as before feature')
      const head = git('commit-tree', 'origin/feature^{tree}', '-p', 'HEAD', '-m', 'Review-only head: area1')
      git('push', '-q', 'origin', 'HEAD:refs/heads/review-base-1', `${head}:refs/heads/review-head-1`)
    },
    { task: { dir: wt, worktree: 'w1', checkout: repo.dir }, pushes: ['git push -q origin HEAD:refs/heads/review-base-1 abc1234:refs/heads/review-head-1'] },
  )
  assert.deepEqual(run.tripped, [])
  assert.deepEqual(run.measured, { commits: 2, files: 0, lines: 0, pushed: true })
})

// --- a dispatch in flight ------------------------------------------------------------------

test('a dispatch still checking the repository when the switch trips starts nothing', async () => {
  const killswitch = new KillSwitch({ file: join(TMP, 'race', 'killswitch.json'), log: () => {} })
  // A slow stand-in for git: the checks wait until the test lets them go.
  let release
  const waiting = new Promise(resolve => (release = resolve))
  let asked = 0
  const spawned = []
  const runner = {
    root: '/work',
    dir: name => `/work/${name}`,
    names: async () => ['alpha'],
    git: async (dir, ...args) => {
      asked++
      await waiting
      return args[0] === 'branch' ? 'main\n' : ''
    },
    spawn: (...args) => {
      spawned.push(args)
      throw new Error('no run may start')
    },
    stop: () => {},
  }
  const workers = new Workers({ runner, killswitch, stateDir: join(TMP, 'race', 'state'), claudeBin: join(BIN, 'claude') })
  try {
    const pending = workers.dispatch({ worker: 'alpha', task: 'Fix it.', words: 'Fix it.' })
    await waitUntil(() => asked === 3) // branch, status and origin: inspect waits
    killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
    release()
    const result = await pending
    assert.equal(result.status, 'locked')
    assert.equal(result.state.trigger, 'voice')
    assert.deepEqual(spawned, [])
    assert.deepEqual(workers.running(), [])
    assert.equal(workers.starting.size, 0)

    // start() itself refuses too, whoever calls it.
    const facts = { name: 'alpha', dir: '/work/alpha', branch: 'main', dirty: [], origin: null, visibility: 'none', access: null }
    assert.equal(workers.start(facts, { task: 'Fix it.', words: 'Fix it.' }).status, 'locked')
    assert.deepEqual(spawned, [])
  } finally {
    workers.close()
  }
})

// --- Telegram commands -------------------------------------------------------------------

test('Telegram: /stop only from the configured private chat, and only if recent', async () => {
  // A chat of its own: the gateway below polls the same stand-in, for chat CHAT.
  const mine = '7777'
  const logged = []
  const commands = new TelegramCommands(new Telegram({ token: TOKEN, chatId: mine, apiBase: telegram.url }), {
    pollSeconds: 1,
    log: line => logged.push(line),
  }).start()
  const stops = []
  commands.on('stop', stop => stops.push(stop.text))
  try {
    telegramUpdate('999', '/stop')
    telegramUpdate(mine, '/stop', { type: 'group' })
    telegramUpdate(mine, '/stop', { age: 600 })
    telegramUpdate(mine, 'hello')
    await sleep(600)
    assert.deepEqual(stops, [])
    telegramUpdate(mine, 'Emergency stop')
    await waitUntil(() => stops.length === 1)
    assert.deepEqual(stops, ['Emergency stop'])
    assert.ok(logged.some(line => /ignored a message from another chat/.test(line)))
    assert.ok(!logged.join('\n').includes(TOKEN))
  } finally {
    commands.close()
  }
})

// --- the gateway ---------------------------------------------------------------------------

async function freePort() {
  const server = createNetServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function repo(name, root = ROOT) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  git('add', '.')
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', `git@github.com:acme/${name}.git`)
}

let gw

// secrets, state, root: for a gateway of its own, with its own lock and repositories.
async function startGateway({ secrets = SECRETS, state = join(TMP, 'state'), root = ROOT, env = {} } = {}) {
  const port = await freePort()
  const g = { events: [], verdicts: [], log: '' }
  g.claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  g.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => g.events.push(params),
  )
  g.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission'),
      params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
    }),
    ({ params }) => g.verdicts.push(params),
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: state,
      VOICE_GW_WORKER_ROOT: root,
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'gh'),
      VOICE_GW_TELEGRAM_API: telegram.url,
      VOICE_GW_TELEGRAM_POLL: '1',
      VOICE_GW_MAX_WAIT: '2',
      VOICE_GW_DEFAULT_WAIT: '1',
      VOICE_GW_LOG_FILE: '',
      FAKE_CLAUDE_LOG: join(TMP, 'claude-calls.jsonl'),
      FAKE_GH_STATE: GH_STATE,
      ...env,
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (g.log += chunk))
  await g.claudeCode.connect(stdio)
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await sleep(50)
    }
  }
  g.voice = {}
  g.lines = [] // the first line of each answer: which gateway, and whether it is active (presence.mjs)
  for (const name of ['car', 'phone']) {
    const { access_token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name })
    const client = new Client({ name, version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${access_token}` } },
      }),
    )
    g.voice[name] = async (tool, args = {}) => {
      const [line, ...rest] = (await client.callTool({ name: tool, arguments: args })).content[0].text.split('\n')
      assert.match(line, /^Gateway \S.*: (active|inactive, .*)$/, "every answer starts with the gateway's line")
      g.lines.push(line)
      return rest.join('\n')
    }
    g.voice[`${name}Client`] = client
  }
  g.controller = async (name, args = {}) => {
    const result = await g.claudeCode.callTool({ name, arguments: args })
    return { text: result.content.map(c => c.text).join('\n'), isError: result.isError }
  }
  // The driver says it first: dispatch starts a run only on words from a
  // recent voice request.
  g.dispatch = async (worker, task) => {
    await g.voice.car('send', { message: task })
    return g.controller('dispatch', { worker, task, words: task })
  }
  g.close = async () => {
    await g.voice.carClient.close()
    await g.voice.phoneClient.close()
    await g.claudeCode.close()
  }
  return g
}

const killswitchState = async () => adminRequest(join(SECRETS, 'admin.sock'), 'GET', '/killswitch')
const unlockByAdmin = () => adminRequest(join(SECRETS, 'admin.sock'), 'POST', '/unlock', { by: 'test' })

// scripts/unlock.mjs, as at the server's terminal.
const unlockScript = args =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [UNLOCK, ...args], { env: { ...process.env, VOICE_GW_SECRETS_DIR: SECRETS }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (out += chunk))
    child.on('close', status => resolve({ status, out }))
  })

// Every file in a folder and below, for a text that must not be there.
const filesIn = dir =>
  readdirSync(dir, { recursive: true })
    .map(name => join(dir, name))
    .filter(path => statSync(path).isFile())

before(async () => {
  repo('alpha')
  repo('beta')
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 })
  writeFileSync(join(SECRETS, 'telegram_token'), `${TOKEN}\n`)
  writeFileSync(join(SECRETS, 'telegram_chat_id'), `${CHAT}\n`)
  gw = await startGateway()
})

after(async () => {
  await gw?.close()
})

test('voice: "emergency stop" locks before anything reaches the controller; every voice chat hears the alarm once', async () => {
  // A standing order that holds when the switch trips ends (orders.mjs).
  await gw.voice.car('send', { message: 'Keep going on alpha tonight, finish the milestones.' })
  const order = await gw.controller('standing_order', { worker: 'alpha', scope: 'finish the milestones', words: 'Keep going on alpha tonight' })
  assert.match(order.text, /^\[order=o[a-z0-9]{3} worker=alpha /)
  assert.match((await gw.controller('open_items')).text, /Standing order o[a-z0-9]{3} for alpha/)
  // An approval that is open when the switch trips gets denied.
  await gw.claudeCode.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'abcde', tool_name: 'Write', description: 'Create a file', input_preview: '{}' },
  })
  await sleep(100)
  const sentBefore = telegram.sent.length

  const out = await gw.voice.car('send', { message: 'Emergency stop!' })
  assert.match(out, /^\[state=locked\] Emergency stop\. Kill switch locked since .* UTC, by voice: "Emergency stop!" by voice\. The gateway takes no new tasks/)
  // No line about the user's next request after an emergency stop.
  assert.doesNotMatch(out, /next request/)
  assert.ok(!gw.events.some(e => e.content.includes('Emergency stop!') && e.meta?.kind !== 'killswitch'), 'the phrase never reached the controller as a request')
  const alarm = await waitUntil(() => gw.events.find(e => e.meta?.kind === 'killswitch'))
  assert.equal(alarm.meta.trigger, 'voice')
  await waitUntil(() => gw.verdicts.find(v => v.request_id === 'abcde'))
  assert.equal(gw.verdicts.find(v => v.request_id === 'abcde').behavior, 'deny')

  await waitUntil(() => telegram.sent.length > sentBefore)
  const message = telegram.sent.at(-1)
  assert.equal(message.chat_id, CHAT)
  assert.match(message.text, /KILL SWITCH at .* UTC, by voice: "Emergency stop!" by voice\. No new tasks, workers stopped/)
  assert.equal(statSync(LOCK).mode & 0o777, 0o600)

  // Inactive from the emergency stop on, and never "use another connector": that would carry the work past the stop.
  assert.match(gw.lines.at(-1), /: inactive, kill switch locked; it is unlocked at the computer, or with unlock and a PIN from Telegram$/)
  assert.match(await gw.voice.car('status'), /^\[gateway=ok .* locked=yes\]\n(?!\[ALARM\])/, 'the car heard it already')
  assert.match(gw.lines.at(-1), /^Gateway \S.*: inactive, kill switch locked; it is unlocked at the computer, or with unlock and a PIN from Telegram$/)
  const phone = await gw.voice.phone('status')
  assert.match(phone, /^\[gateway=ok .* locked=yes\]\n\[ALARM\] Kill switch locked since .*, by voice: .* Read this to the user first\./)
  assert.doesNotMatch(await gw.voice.phone('status'), /\[ALARM\]/, 'once per voice chat')

  const dispatch = await gw.controller('dispatch', { worker: 'alpha', task: 'Fix it.', words: 'Fix it.' })
  assert.equal(dispatch.isError, true)
  assert.match(dispatch.text, /^\[dispatch=locked worker=alpha\] Kill switch locked since .*, by voice/)
  // The order ended with the lock, and no new one is made while locked.
  assert.doesNotMatch((await gw.controller('open_items')).text, /Standing order/)
  assert.match(gw.log, /standing orders ended \(the kill switch locked \(voice\)\): o[a-z0-9]{3}/)
  assert.match((await gw.controller('standing_order', { worker: 'alpha', scope: 'the rest', words: 'keep going on alpha' })).text, /^\[order=locked\] Kill switch locked since/)
  const refused = await gw.voice.car('send', { message: 'Fix the typo.' })
  assert.match(refused, /^\[state=locked\] .* Nothing was handed over\./)
  assert.doesNotMatch(refused, /another connector/)
  assert.match(gw.lines.at(-1), /: inactive, kill switch locked; it is unlocked at the computer, or with unlock and a PIN from Telegram$/)
  assert.ok(!gw.events.some(e => e.content === 'Fix the typo.'))
  assert.match(await gw.voice.car('approve', { code: 'fghjk', decision: 'allow' }), /^\[approval=locked code=fghjk\]/)

  // A new approval while locked is denied at once.
  await gw.claudeCode.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'mnpqr', tool_name: 'Bash', description: 'Run something', input_preview: '{}' },
  })
  await waitUntil(() => gw.verdicts.find(v => v.request_id === 'mnpqr'))
  assert.equal(gw.verdicts.find(v => v.request_id === 'mnpqr').behavior, 'deny')
  assert.ok(!gw.log.includes(TOKEN), 'the Telegram token never reaches the log')
})

test('the lock survives a restart, and the local script unlocks it', async () => {
  await gw.close()
  gw = await startGateway()
  const dispatch = await gw.controller('dispatch', { worker: 'alpha', task: 'Fix it.', words: 'Fix it.' })
  assert.match(dispatch.text, /^\[dispatch=locked/)
  assert.match(await gw.voice.car('status'), /\[ALARM\] Kill switch locked since/, 'heard again after the restart')
  assert.match(gw.log, /kill switch is locked since .* by voice/)

  const run = unlockScript
  const status = await run(['--status'])
  assert.equal(status.status, 0)
  assert.match(status.out, /^The kill switch is locked since .*, by voice: "Emergency stop!" by voice\n/)
  const noTerminal = await run([])
  assert.equal(noTerminal.status, 2, 'without a terminal it needs --yes')
  assert.equal((await killswitchState()).locked, true)

  const unlocked = await run(['--yes'])
  assert.equal(unlocked.status, 0, unlocked.out)
  assert.match(unlocked.out, /Unlocked: the gateway takes tasks again\./)
  assert.equal(existsSync(LOCK), false)
  assert.equal((await killswitchState()).locked, false)
  const again = await gw.dispatch('alpha', 'Look at the README.')
  assert.match(again.text, /^\[dispatch=started worker=alpha/)
  assert.match((await run([])).out, /The kill switch is not locked\./)
})

test("voice: unlock with a PIN sent to Telegram; the PIN only in the driver's chat, never in a result, a log, a file or an event for the controller; typed on Telegram it counts for nothing, and the controller has no way", async () => {
  assert.equal(await gw.voice.car('unlock'), '[unlock=none] The kill switch is not locked; there is nothing to unlock. Tell the user.')
  const sentBefore = telegram.sent.length
  const eventsBefore = gw.events.length
  const after = pattern => telegram.sent.slice(sentBefore).find(message => pattern.test(message.text))
  // The controller has no tool for it, and its instructions say it never unlocks.
  const { tools } = await gw.claudeCode.listTools()
  assert.deepEqual(tools.filter(tool => /unlock/i.test(tool.name)), [])
  assert.match(gw.claudeCode.getInstructions(), /Only the driver can unlock it: at the computer, or in voice mode\nwith a PIN the gateway sends them; never you\./)
  // The connector's rule for it, with Telegram set up for the PIN.
  const instructions = gw.voice.carClient.getInstructions()
  assert.ok(
    instructions
      .split('\n')
      .includes(
        'Unlock: when the user asks to unlock the kill switch, call unlock without a pin, read out the reason it gives, and ask for the PIN that went to their Telegram chat; then call unlock with it. Never guess a PIN.',
      ),
  )
  assert.match(instructions, /A locked kill switch is unlocked at the computer, or with unlock and a PIN from Telegram: tell the user so\.$/)
  const emergency = (await gw.voice.carClient.listTools()).tools.find(tool => tool.name === 'emergency_stop')
  assert.match(emergency.description, /until it is unlocked at the computer, or with unlock\./)
  assert.match(gw.log, /kill switch: the driver can unlock it in voice mode, with a PIN of 4 digits sent to their Telegram chat, valid 5 minutes; 3 wrong ones block that for the lock\. scripts\/unlock\.mjs always unlocks/)

  await gw.voice.car('send', { message: 'Emergency stop!' })
  const alarm = await waitUntil(() => after(/KILL SWITCH/))
  assert.match(alarm.text, /Unlock at the server: node scripts\/unlock\.mjs, or in voice mode with a PIN sent here\.$/)
  const controllerAlarm = await waitUntil(() => gw.events.slice(eventsBefore).find(e => e.meta?.kind === 'killswitch'))
  assert.match(controllerAlarm.content, /It is unlocked at the server, with scripts\/unlock\.mjs, or in voice mode with a PIN sent to Telegram\. Do not try to get around it\./)

  // A PIN to the driver's chat; the result gives the reason to read out, not the PIN.
  const asked = await gw.voice.car('unlock', { language: 'de' })
  assert.match(
    asked,
    /^\[unlock=pin-sent minutes=5\] Kill switch locked since .* UTC, by voice: "Emergency stop!" by voice\. A new PIN of four digits went to the user's Telegram chat, valid 5 minutes\. Read the reason to the user, then ask them for the PIN and call unlock with it\.$/,
  )
  const message = after(/PIN \d/)
  assert.equal(message.chat_id, CHAT)
  assert.match(message.text, /^Entsperr-PIN \d \d \d \d, gültig 5 Minuten$/)
  assert.equal(message.reply_parameters, undefined)
  const pin = pinIn(message.text)

  // Typed on Telegram: not passed on, and masked in the input log.
  telegramUpdate(CHAT, pin)
  telegramUpdate(CHAT, `/unlock ${pin}`)
  await waitUntil(() => telegram.sent.slice(sentBefore).filter(m => m.text.startsWith('Not passed on: it holds the unlock PIN')).length === 2)
  assert.equal(after(/^Not passed on: it holds/).text, 'Not passed on: it holds the unlock PIN, which counts only when you say it in voice mode. Say it there.')
  const inputLog = readFileSync(join(TMP, 'state', 'telegram-input.log'), 'utf8').trim().split('\n').slice(-2).map(line => JSON.parse(line))
  assert.deepEqual(inputLog.map(entry => [entry.text, entry.decision]), [['****', 'refused'], ['/unlock ****', 'refused']])
  assert.equal((await killswitchState()).locked, true)
  // The controller cannot either: its tools answer locked, with how the driver can unlock it.
  const dispatch = await gw.controller('dispatch', { worker: 'alpha', task: 'Fix it.', words: 'Fix it.' })
  assert.match(dispatch.text, /^\[dispatch=locked worker=alpha\] .* or in voice mode with a PIN sent to Telegram\. Nothing started\./)

  // A wrong one counts; the right one, as read out, from another voice chat, unlocks.
  const wrong = await gw.voice.car('unlock', { pin: wrongOf(pin) })
  assert.equal(wrong, '[unlock=wrong left=2] Wrong PIN, still locked; 2 tries left. Ask the user to read the PIN again, digit by digit.')
  const done = await gw.voice.phone('unlock', { pin: [...pin].join(' ') })
  assert.equal(done, '[unlock=done] Unlocked: the gateway takes tasks again. Tell the user.')
  assert.match(gw.lines.at(-1), /: active$/)
  assert.equal(existsSync(LOCK), false)
  assert.equal((await killswitchState()).locked, false)
  const notice = await waitUntil(() => after(/kill switch unlocked in voice mode/))
  assert.match(
    notice.text,
    /^cc-voice-gateway on \S+: kill switch unlocked in voice mode, with the PIN sent here\. It was locked since .* UTC, by voice: "Emergency stop!" by voice\. The gateway takes tasks again\.$/,
  )
  assert.match(gw.log, /kill switch: a wrong PIN in voice mode; 2 tries left for this lock/)
  assert.match(gw.log, /kill switch unlocked by the driver in voice mode, with a PIN from Telegram; it was locked since .* by voice/)
  assert.match(await gw.voice.car('unlock', { pin }), /^\[unlock=none\]/, 'once')
  const again = await gw.dispatch('alpha', 'Look at the README once more.')
  assert.match(again.text, /^\[dispatch=started worker=alpha/)

  // The PIN in nothing but its message.
  for (const out of [asked, wrong, done]) assert.doesNotMatch(out, FILLERS)
  const places = {
    results: [asked, wrong, done].join('\n'),
    log: gw.log,
    'events for the controller': JSON.stringify(gw.events.slice(eventsBefore)),
    'other Telegram messages': JSON.stringify(telegram.sent.slice(sentBefore).filter(m => m !== message)),
    ...Object.fromEntries(filesIn(join(TMP, 'state')).map(file => [file, readFileSync(file, 'utf8')])),
    ...Object.fromEntries(filesIn(SECRETS).filter(file => !/telegram_/.test(file)).map(file => [file, readFileSync(file, 'utf8')])),
  }
  for (const [where, text] of Object.entries(places)) assert.ok(!holdsPin(text, pin), `the PIN in ${where}`)
})

test('voice: three wrong PINs block the unlock by voice for the lock, also across a restart; the driver hears it on Telegram, and scripts/unlock.mjs still unlocks', async () => {
  const sentBefore = telegram.sent.length
  await gw.controller('raise_alarm', { reason: 'The worker in alpha writes to files nobody asked for.' })
  assert.equal((await killswitchState()).locked, true)
  const pinNow = async () => {
    await gw.voice.car('unlock')
    return pinIn(telegram.sent.slice(sentBefore).findLast(m => /^Unlock PIN/.test(m.text)).text)
  }
  const first = await pinNow()
  assert.match(await gw.voice.car('unlock', { pin: wrongOf(first) }), /^\[unlock=wrong left=2\]/)
  const second = await pinNow()
  assert.match(await gw.voice.car('unlock', { pin: wrongOf(second) }), /^\[unlock=wrong left=1\] Wrong PIN, still locked; one try left\./)
  const blocked = await gw.voice.car('unlock', { pin: wrongOf(second) })
  assert.equal(
    blocked,
    '[unlock=blocked] Wrong PIN, and that was the last try: unlocking by voice is blocked for this lock; it is unlocked only at the computer now. Tell the user.',
  )
  const notice = await waitUntil(() => telegram.sent.slice(sentBefore).find(m => /3 wrong PINs/.test(m.text)))
  assert.match(notice.text, /^cc-voice-gateway on \S+: 3 wrong PINs in voice mode, so unlocking by voice is blocked for this lock\. Unlock at the server: node scripts\/unlock\.mjs$/)
  // The right one, and a new one, count for nothing now.
  const after = '[unlock=blocked] After 3 wrong PINs, unlocking by voice is blocked for this lock; it is unlocked only at the computer now. Tell the user.'
  assert.equal(await gw.voice.car('unlock', { pin: second }), after)
  const count = telegram.sent.length
  assert.equal(await gw.voice.car('unlock'), after)
  assert.equal(telegram.sent.length, count, 'no PIN after the block')
  assert.match(gw.lines.at(-1), /: inactive, kill switch locked; it can only be unlocked at the computer$/)
  assert.equal(JSON.parse(readFileSync(LOCK, 'utf8')).wrongPins, 3)
  for (const out of [blocked, after]) assert.doesNotMatch(out, FILLERS)
  const log = gw.log

  // A restart keeps the block with the lock.
  await gw.close()
  gw = await startGateway()
  assert.match(await gw.voice.car('unlock'), /^\[unlock=blocked\] After 3 wrong PINs/)
  assert.match(await gw.voice.car('status'), /^\[gateway=ok .* locked=yes\]/)
  assert.ok(!telegram.sent.slice(count).some(m => /^(Unlock|Entsperr)-? ?PIN/.test(m.text)), 'no PIN after the restart either')

  // The server unlocks it, as ever, and says why voice did not.
  const status = await unlockScript(['--status'])
  assert.match(status.out, /\nUnlocking in voice mode is blocked for this lock, after 3 wrong PINs; here it still unlocks\.\n$/)
  const unlocked = await unlockScript(['--yes'])
  assert.equal(unlocked.status, 0, unlocked.out)
  assert.match(unlocked.out, /Unlocked: the gateway takes tasks again\./)
  assert.equal((await killswitchState()).locked, false)
  for (const pin of [first, second]) assert.ok(!holdsPin(log + gw.log, pin), 'no PIN in the log')
})

test('voice: no unlock in a standby, and no PIN', async () => {
  const dir = join(TMP, 'standby-unlock')
  const secrets = join(dir, 'secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`)
  writeFileSync(join(secrets, 'telegram_chat_id'), `${CHAT}\n`)
  writeFileSync(join(secrets, 'killswitch.json'), JSON.stringify({ id: 'x1', trigger: 'voice', reason: 'test', at: new Date().toISOString(), events: [] }))
  const count = telegram.sent.length
  const g = await startGateway({ secrets, state: join(dir, 'state'), env: { VOICE_GW_STANDBY: '1' } })
  try {
    assert.match(await g.voice.car('unlock'), /^\[unlock=standby\] This gateway is in a standby: it unlocks nothing by voice until it is active again\. Tell the user\./)
    assert.match(await g.voice.car('unlock', { pin: '1234' }), /^\[unlock=standby\]/)
    assert.match(g.lines.at(-1), /: inactive, on standby by its settings; use another connector$/)
    assert.ok(!telegram.sent.slice(count).some(m => /^(Unlock|Entsperr)-? ?PIN/.test(m.text)), 'no PIN')
    assert.equal(JSON.parse(readFileSync(join(secrets, 'killswitch.json'), 'utf8')).wrongPins, undefined, 'no try')
  } finally {
    await g.close()
  }
})

test('Telegram: /stop from the configured chat locks it; from any other chat nothing happens', async () => {
  telegramUpdate('999', '/stop')
  await sleep(1500)
  assert.equal((await killswitchState()).locked, false)
  telegramUpdate(CHAT, '/stop')
  const state = await waitUntil(async () => (await killswitchState()).state)
  assert.equal(state.trigger, 'telegram')
  assert.match(state.reason, /"\/stop" on Telegram/)
  await unlockByAdmin()
})

test("the controller's alarm locks it", async () => {
  const out = await gw.controller('raise_alarm', { reason: 'The worker in alpha writes to files nobody asked for.' })
  assert.match(out.text, /^\[killswitch=locked\] Kill switch locked since .*, by controller: The worker in alpha writes/)
  assert.equal((await killswitchState()).state.trigger, 'controller')
  await unlockByAdmin()
})

test('a rule: a push to main in a run locks it, and every running worker stops', async () => {
  const slow = await gw.dispatch('beta', 'SLOW: a long task.')
  const slowId = /task=(t[a-z0-9]{3})/.exec(slow.text)[1]
  await waitUntil(() => existsSync(join(TMP, 'claude-calls.jsonl')) && readFileSync(join(TMP, 'claude-calls.jsonl'), 'utf8').includes('SLOW'))
  const slowPid = JSON.parse(readFileSync(join(TMP, 'claude-calls.jsonl'), 'utf8').trim().split('\n').findLast(l => l.includes('SLOW'))).pid
  const queued = /queued=(q[a-z0-9]{3})/.exec((await gw.dispatch('beta', 'Then tidy up the docs.')).text)[1]
  await gw.dispatch('alpha', 'PUSHMAIN: push it.')

  const state = await waitUntil(async () => (await killswitchState()).state)
  assert.equal(state.trigger, 'rule')
  assert.match(state.reason, /^push to the default branch: the command "git push origin main" \(worker alpha, task t[a-z0-9]{3}\)$/)
  // Ending until every process of it is gone, then stopped.
  const status = await waitUntil(async () => {
    const out = await gw.controller('worker_status', { worker: 'beta' })
    return /^\[worker=beta state=stopped /.test(out.text) && out
  })
  assert.match(status.text, new RegExp(`^\\[worker=beta state=stopped task=${slowId}`))
  assert.match(status.text, /Problem: kill switch \(rule\)/)
  await waitUntil(() => {
    try {
      process.kill(slowPid, 0)
      return false
    } catch {
      return true
    }
  })
  // The queue is emptied, and the controller hears which tasks left it.
  const alarm = await waitUntil(() => gw.events.findLast(e => e.meta?.kind === 'killswitch' && e.meta.trigger === 'rule'))
  assert.match(alarm.content, new RegExp(`These queued tasks left the queue and will not start by themselves: ${queued} for beta \\("Then tidy up the docs\\."\\)\\.`))
  await unlockByAdmin()
  await sleep(1500)
  assert.ok(!readFileSync(join(TMP, 'claude-calls.jsonl'), 'utf8').includes('Then tidy up the docs.'), 'not after the unlock either')
})

test('locked at startup with a worker state that cannot be saved: logged, and the gateway stays up and locked', async () => {
  const secrets = join(TMP, 'stuck', 'secrets')
  const state = join(TMP, 'stuck', 'state')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  mkdirSync(state, { recursive: true })
  writeFileSync(join(secrets, 'killswitch.json'), JSON.stringify({ id: 'x', trigger: 'voice', reason: 'test', at: new Date().toISOString(), events: [] }))
  // A run from before the restart, whose process is gone; stopping it saves the state.
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  const task = { id: 'tgon', repo: 'alpha', task: 'x', words: 'x', state: 'running', pid, sessionId: 's', startedAt: Date.now(), finishedAt: null }
  Object.assign(task, { file: join(state, 'tasks', 'tgon.jsonl'), errFile: join(state, 'tasks', 'tgon.err'), steps: [], pulls: [], reported: false })
  writeFileSync(join(state, 'workers.json'), JSON.stringify({ repos: {}, tasks: [task] }))
  chmodSync(state, 0o500) // .state not writable
  let log = ''
  const client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(await freePort()),
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: state,
      VOICE_GW_WORKER_ROOT: ROOT,
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'gh'),
      VOICE_GW_LOG_FILE: '',
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (log += chunk))
  try {
    await client.connect(stdio)
    await waitUntil(() => /kill switch: worker runs stopped, but their state was not saved: /.test(log))
    await sleep(300) // an unhandled rejection would end the gateway about now
    const dispatch = await client.callTool({ name: 'dispatch', arguments: { worker: 'alpha', task: 'Fix it.', words: 'x' } })
    assert.match(dispatch.content[0].text, /^\[dispatch=locked worker=alpha\]/)
    const status = await client.callTool({ name: 'worker_status', arguments: { worker: 'alpha' } })
    assert.match(status.content[0].text, /^\[worker=alpha state=stopped task=tgon/)
  } finally {
    await client.close()
    chmodSync(state, 0o700)
  }
})

// --- the setting VOICE_GW_KILLSWITCH ------------------------------------------------------

// A gateway at a setting, with its own lock, state and repository alpha.
async function gatewayAt(mode) {
  const root = join(TMP, 'modes-dev')
  if (!existsSync(join(root, 'alpha'))) repo('alpha', root)
  const secrets = join(TMP, `mode-${mode}`, 'secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  const g = await startGateway({ secrets, state: join(TMP, `mode-${mode}`, 'state'), root, env: { VOICE_GW_KILLSWITCH: mode } })
  g.lock = async () => adminRequest(join(secrets, 'admin.sock'), 'GET', '/killswitch')
  // A run that pushes to main: the rule's verdict is in the log, and the run ends as usual.
  g.pushToMain = async () => {
    const id = /task=(t[a-z0-9]{3})/.exec((await g.dispatch('alpha', 'PUSHMAIN: push it.')).text)[1]
    await waitUntil(() => g.events.find(e => e.meta?.task === id))
  }
  return g
}

test('VOICE_GW_KILLSWITCH=manual: a rule only logs; "emergency stop" by voice still locks', async () => {
  const g = await gatewayAt('manual')
  try {
    assert.match(g.log, /kill switch manual: only the manual triggers lock it \(voice, Telegram, raise_alarm\); the rules only log/)
    await g.pushToMain()
    assert.match(g.log, /kill switch not locked, VOICE_GW_KILLSWITCH=manual; rule would have locked it: push to the default branch: the command "git push origin main"/)
    assert.equal((await g.lock()).locked, false)
    assert.match(await g.voice.car('status'), /^\[gateway=ok .* killswitch=manual locked=no\]/)
    assert.match(await g.voice.car('send', { message: 'Emergency stop!' }), /^\[state=locked\] Emergency stop\./)
    assert.equal((await g.lock()).state.trigger, 'voice')
  } finally {
    await g.close()
  }
})

test('VOICE_GW_KILLSWITCH=off: nothing locks; voice, emergency_stop and raise_alarm say so, and the rules log', async () => {
  const g = await gatewayAt('off')
  try {
    assert.match(g.log, /kill switch off: nothing locks it; every trigger is only logged/)
    const said = await g.voice.car('send', { message: 'Emergency stop!' })
    assert.match(said, /^\[state=off\] Emergency stop: The kill switch is turned off in the settings \(VOICE_GW_KILLSWITCH=off\), so nothing was locked and the workers go on/)
    assert.ok(!g.events.some(e => e.content.includes('Emergency stop!')), 'the phrase did not reach the controller')
    const tool = await g.voice.carClient.callTool({ name: 'emergency_stop', arguments: { words: 'Notstopp!' } })
    assert.match(tool.content[0].text, /^Gateway \S.*: active\n\[state=off\] Emergency stop: The kill switch is turned off/, 'still active: nothing locked')
    const alarm = await g.controller('raise_alarm', { reason: 'The worker writes to files nobody asked for.' })
    assert.match(alarm.text, /^\[killswitch=off\] The kill switch is turned off .* Tell the driver in one sentence what looks wrong/)
    await g.pushToMain()
    for (const trigger of ['voice', 'controller', 'rule']) {
      assert.match(g.log, new RegExp(`kill switch not locked, VOICE_GW_KILLSWITCH=off; ${trigger} would have locked it`), trigger)
    }
    assert.equal((await g.lock()).locked, false)
    assert.match(await g.voice.car('status'), /^\[gateway=ok .* killswitch=off locked=no\]/)
  } finally {
    await g.close()
  }
})
