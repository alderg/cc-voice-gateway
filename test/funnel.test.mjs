// The Tailscale Funnel on demand (src/funnel.mjs): /funnel on, off and status
// from Telegram, with an answer to each, an answer to a command that came too
// late, and the Funnel off by itself after the idle time. A small script plays
// scripts/funnel.sh, a local server the Telegram Bot API; scripts/funnel.sh
// itself runs with a stand-in for tailscale.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { FunnelSwitch, staleText } from '../src/funnel.mjs'
import { Telegram, TelegramCommands, funnelCommand } from '../src/telegram.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'vgw-funnel-')))
const SCRIPT = join(TMP, 'funnel.sh')
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT = '5151'
const URL_LINE = 'https://host.example.ts.net/mcp'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const quiet = () => {}

function waitUntil(predicate, ms = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      const value = predicate()
      if (value) return resolve(value)
      if (Date.now() - started > ms) return reject(new Error('timed out waiting'))
      setTimeout(check, 25)
    }
    check()
  })
}

const telegram = { server: null, url: '', sent: [], updates: [], nextId: 1 }

function telegramUpdate(text, { chat = CHAT, age = 0 } = {}) {
  telegram.updates.push({
    update_id: telegram.nextId++,
    message: { message_id: 1, date: Math.floor(Date.now() / 1000) - age, chat: { id: Number(chat), type: 'private' }, text },
  })
}

// The Funnel's state in a file; start fails while a .fail file is there.
const STATE = join(TMP, 'funnel-state')
const funnelState = () => (existsSync(STATE) ? readFileSync(STATE, 'utf8').trim() : 'off')
const setFunnel = state => writeFileSync(STATE, `${state}\n`)

before(async () => {
  writeFileSync(
    SCRIPT,
    `#!/bin/bash
f=${JSON.stringify(STATE)}
case "$1" in
  state) cat "$f" 2>/dev/null || echo off ;;
  start)
    if [ -e "$f.fail" ]; then echo "Access denied: serve config denied" >&2; exit 1; fi
    echo on > "$f"
    echo "Available on the internet:"
    if [ -e "$f.slow" ]; then echo "Public check: 1 of 3 Funnel relays answer so far; the rest usually follow within minutes." >&2
    else echo "Public check: all 3 Funnel relays answer."; fi
    echo
    echo "Connector URL:"
    echo "${URL_LINE}"
    ;;
  stop) echo off > "$f" ;;
  *) exit 2 ;;
esac
`,
  )
  chmodSync(SCRIPT, 0o755)
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
        telegram.sent.push(json.text)
        return reply({ message_id: telegram.sent.length })
      }
      if (req.url === `/bot${TOKEN}/getUpdates`) {
        const waiting = () => telegram.updates.filter(u => u.update_id >= (json.offset ?? 0))
        for (let i = 0; i < 10 && !waiting().length; i++) await sleep(50)
        return reply(waiting())
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

// --- the commands -------------------------------------------------------------------

test('Funnel commands: /funnel on|off|status, the same in words, and "keep alive"', () => {
  for (const [text, action] of [
    ['/funnel on', 'on'],
    ['/funnel@voice_bot off', 'off'],
    ['/funnel', 'status'],
    ['/FUNNEL STATUS', 'status'],
    ['funnel on', 'on'],
    ['Funnel off.', 'off'],
    ['keep alive', 'on'],
    ['Keep-alive!', 'on'],
    ['keepalive', 'on'],
  ]) {
    assert.equal(funnelCommand(text), action, text)
  }
  for (const text of ['/funnel maybe', 'please keep the funnel alive', 'funnel', 'on', '/stop', '']) {
    assert.equal(funnelCommand(text), null, text)
  }
})

test('Telegram: a Funnel command from the private chat is passed on; a late one gets its own event', async () => {
  const commands = new TelegramCommands(new Telegram({ token: TOKEN, chatId: CHAT, apiBase: telegram.url }), {
    pollSeconds: 1,
    log: quiet,
  }).start()
  const funnels = []
  const stale = []
  const stops = []
  commands.on('funnel', event => funnels.push(event.action))
  commands.on('stale', event => stale.push(event))
  commands.on('stop', event => stops.push(event.text))
  try {
    telegramUpdate('/funnel on', { chat: '999' })
    telegramUpdate('hello')
    telegramUpdate('/funnel on', { age: 600 })
    telegramUpdate('/stop', { age: 300 })
    telegramUpdate('keep alive')
    telegramUpdate('/funnel off')
    await waitUntil(() => funnels.length === 2)
    assert.deepEqual(funnels, ['on', 'off'])
    assert.deepEqual(stops, [], 'a late /stop does not lock either')
    assert.deepEqual(
      stale.map(event => [event.text, event.ageSeconds >= 299]),
      [['/funnel on', true], ['/stop', true]],
    )
  } finally {
    commands.close()
  }
  assert.equal(
    staleText({ text: '/funnel on', ageSeconds: 600 }),
    'Ignored "/funnel on": it was sent 10 minutes ago, while the gateway was not listening, for example during a ' +
      'restart. Send it again if you still want it.',
  )
  assert.match(staleText({ text: '/stop', ageSeconds: 75 }), /sent 75 seconds ago/)
})

// --- the switch ---------------------------------------------------------------------

function funnelSwitch({ idleMinutes = 90, active = false } = {}) {
  const said = []
  const store = { active, voiceActive() { return this.active } }
  const funnel = new FunnelSwitch({ script: SCRIPT, store, idleMinutes, say: async text => said.push(text), log: quiet })
  return { funnel, said, store }
}

test('on, off and status, each with an answer; a start with a second one once the relays answer', async () => {
  setFunnel('off')
  const { funnel, said } = funnelSwitch()
  try {
    await funnel.command('status')
    assert.deepEqual(said, ['The Funnel is off. To turn it on again: /funnel on, or reply "keep alive".'])

    await funnel.command('on')
    assert.equal(funnelState(), 'on')
    assert.deepEqual(said.slice(1), [
      "Turning the Funnel on. I'll tell you when Claude's servers can reach it, within about two minutes.",
      `The Funnel is on: ${URL_LINE}. Claude's servers can reach it: all 3 Funnel relays answer. It goes off by ` +
        'itself 90 minutes after the last voice call.',
    ])
    await funnel.command('on')
    assert.equal(said.at(-1), 'The Funnel is on already. It goes off by itself 90 minutes after the last voice call.')
    await funnel.command('status')
    assert.equal(said.at(-1), 'The Funnel is on. It goes off by itself 90 minutes after the last voice call.')

    await funnel.command('off')
    assert.equal(funnelState(), 'off')
    assert.equal(said.at(-1), 'The Funnel is off. To turn it on again: /funnel on, or reply "keep alive".')
    await funnel.command('off')
    assert.match(said.at(-1), /^The Funnel is off already\./)

    // Not every relay yet, and a start that fails.
    writeFileSync(`${STATE}.slow`, '')
    await funnel.command('on')
    assert.match(said.at(-1), /^The Funnel is on: .*\. Not every relay answers yet \(1 of 3 Funnel relays answer so far/)
    rmSync(`${STATE}.slow`)
    setFunnel('off')
    writeFileSync(`${STATE}.fail`, '')
    await funnel.command('on')
    assert.equal(said.at(-1), 'The Funnel did not come on: Access denied: serve config denied')
    assert.equal(funnelState(), 'off')
  } finally {
    rmSync(`${STATE}.fail`, { force: true })
    funnel.close()
  }
  // Without an idle time it stays on.
  const { funnel: always, said: told } = funnelSwitch({ idleMinutes: 0 })
  await always.command('on')
  assert.match(told.at(-1), /It stays on until \/funnel off\.$/)
  always.close()
})

test('auto-off: after the idle time without a voice call, with a message how to turn it on again', async () => {
  setFunnel('on')
  const idleMinutes = 0.01 // 0.6 seconds
  const { funnel, said, store } = funnelSwitch({ idleMinutes, active: true })
  try {
    // While voice calls come, it stays on.
    await sleep(1200)
    assert.equal(funnelState(), 'on')
    assert.deepEqual(said, [])
    store.active = false
    await waitUntil(() => said.length === 1, 5000)
    assert.equal(funnelState(), 'off')
    assert.match(said[0], /^cc-voice-gateway on .*: the Funnel is off, 0\.01 minutes after the last voice call\. To turn it on again: \/funnel on, or reply "keep alive"\.$/)
    // Off already: nothing more.
    await sleep(1200)
    assert.equal(said.length, 1)
    // On again, and "keep alive" pushes the time out.
    await funnel.command('on')
    const told = said.length
    await sleep(400)
    await funnel.command('on')
    await sleep(400)
    assert.equal(funnelState(), 'on', 'kept alive')
    await waitUntil(() => funnelState() === 'off', 5000)
    assert.ok(said.length > told)
  } finally {
    funnel.close()
  }
})

// --- scripts/funnel.sh ----------------------------------------------------------------

test('scripts/funnel.sh: state and url from tailscale\'s JSON, with the tailscale of VOICE_GW_TAILSCALE_BIN', () => {
  const dir = join(TMP, 'tailscale')
  mkdirSync(dir, { recursive: true })
  const fake = join(dir, 'Tailscale') // as the macOS app's command line is called
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$1" in status) cat "${dir}/status.json" ;; funnel) cat "${dir}/funnel.json" ;; esac\n`)
  chmodSync(fake, 0o755)
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ Self: { DNSName: 'sky.tail1234.ts.net.' } }))
  const serve = proxy => ({
    AllowFunnel: { 'sky.tail1234.ts.net:443': true },
    Web: { 'sky.tail1234.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
  })
  const funnel = command =>
    spawnSync('bash', [fileURLToPath(new URL('../scripts/funnel.sh', import.meta.url)), command], {
      encoding: 'utf8',
      env: { ...process.env, VOICE_GW_TAILSCALE_BIN: fake, VOICE_GW_SECRETS_DIR: join(dir, 'no-secrets'), VOICE_GW_PORT: '8787' },
    })
  writeFileSync(join(dir, 'funnel.json'), JSON.stringify(serve('http://127.0.0.1:8787')))
  assert.equal(funnel('state').stdout, 'on\n')
  writeFileSync(join(dir, 'funnel.json'), JSON.stringify(serve('http://127.0.0.1:9999')))
  assert.equal(funnel('state').stdout, 'off\n', 'another port is not the gateway')
  writeFileSync(join(dir, 'funnel.json'), '{}')
  assert.equal(funnel('state').stdout, 'off\n')
  const url = funnel('url')
  assert.equal(url.status, 0, url.stderr)
  assert.equal(url.stdout, 'https://sky.tail1234.ts.net/mcp\n')
  assert.deepEqual(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'), [
    'funnel status --json',
    'funnel status --json',
    'funnel status --json',
    'status --json',
  ])
  assert.equal(funnel('nonsense').status, 2)
})

// --- through the gateway ------------------------------------------------------------

async function freePort() {
  const server = createNetServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('the gateway: /funnel on from Telegram, an answer to a late one, and off by itself', async () => {
  setFunnel('off')
  telegram.sent.length = 0
  telegram.updates.length = 0 // the earlier tests' messages, some still recent
  const secrets = join(TMP, 'secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), TOKEN, { mode: 0o600 })
  writeFileSync(join(secrets, 'telegram_chat_id'), CHAT, { mode: 0o600 })
  const port = await freePort()
  const claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  let log = ''
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: join(TMP, 'state'),
      VOICE_GW_WORKER_ROOT: join(TMP, 'repos'),
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_TELEGRAM_API: telegram.url,
      VOICE_GW_TELEGRAM_POLL: '1',
      VOICE_GW_FUNNEL_SCRIPT: SCRIPT,
      VOICE_GW_FUNNEL_IDLE: '0.02', // 1.2 seconds
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (log += chunk))
  await claudeCode.connect(stdio)
  try {
    telegramUpdate('/funnel on', { age: 900 })
    await waitUntil(() => telegram.sent.some(text => text.startsWith('Ignored "/funnel on": it was sent 15 minutes ago')))
    assert.equal(funnelState(), 'off')

    telegramUpdate('/funnel on')
    await waitUntil(() => telegram.sent.some(text => text.startsWith('The Funnel is on: ')))
    assert.ok(telegram.sent.includes("Turning the Funnel on. I'll tell you when Claude's servers can reach it, within about two minutes."))
    assert.equal(funnelState(), 'on')

    await waitUntil(() => telegram.sent.some(text => /the Funnel is off, 0\.02 minutes after the last voice call/.test(text)), 6000)
    assert.equal(funnelState(), 'off')
    assert.match(log, /funnel auto-off: 0\.02 minutes after the last voice call/)
    assert.ok(!log.includes(TOKEN))
  } finally {
    await claudeCode.close()
  }
})
