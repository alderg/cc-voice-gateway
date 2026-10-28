// The watchdog in scripts/start-controller.sh: restarts after a crash, not
// after an intentional stop, with backoff and a limit, one instance at a time,
// and a Telegram message through scripts/telegram-notify.mjs.
//
// A fake claude follows a plan, one step per start: exit with a code, run
// until stopped, or serve the gateway's /healthz for a while and then stop
// answering. A local HTTP server stands in for the Telegram Bot API; no test
// reaches the real one, and the real .state, log and .secrets stay untouched.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/start-controller.sh', import.meta.url))
const NOTIFY = fileURLToPath(new URL('../scripts/telegram-notify.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-watchdog-'))
const BIN = join(TMP, 'bin')
const TOKEN = '123456789:TEST-token-never-in-a-log'

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const planFile = process.env.FAKE_CLAUDE_PLAN
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const step = plan.shift() ?? { exit: 0 }
writeFileSync(planFile, JSON.stringify(plan))
const note = event => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, event, step }) + '\\n')
note('start')
process.on('SIGTERM', () => { note('SIGTERM'); process.exit(143) })
if (step.serve) {
  // the gateway answers for a while, then no longer, while the session goes on
  const server = createServer((req, res) => res.end('ok')).listen(Number(process.env.VOICE_GW_PORT), '127.0.0.1')
  setTimeout(() => server.close(), step.serve)
  setInterval(() => {}, 1000)
} else if (step.run) {
  setInterval(() => {}, 1000)
} else {
  process.exit(step.exit)
}
`

// --- the stand-in Telegram API -------------------------------------------------

const telegram = { server: null, url: '', messages: [], fail: false }

before(async () => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  chmodSync(join(BIN, 'claude'), 0o755)
  telegram.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const ok = !telegram.fail && req.url === `/bot${TOKEN}/sendMessage`
      if (ok) telegram.messages.push(JSON.parse(body))
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { ok: true } : { ok: false, description: 'Unauthorized' }))
    })
  })
  await new Promise(resolve => telegram.server.listen(0, '127.0.0.1', resolve))
  telegram.url = `http://127.0.0.1:${telegram.server.address().port}`
})

after(() => {
  telegram.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

// --- helpers --------------------------------------------------------------------

let counter = 0

// A fresh place for one watchdog: state, log, secrets, and the fake's plan.
function setup(plan, { secrets = true, env = {} } = {}) {
  const dir = join(TMP, `case-${++counter}`)
  mkdirSync(join(dir, 'secrets'), { recursive: true })
  if (secrets) {
    writeFileSync(join(dir, 'secrets', 'telegram_token'), `${TOKEN}\n`)
    writeFileSync(join(dir, 'secrets', 'telegram_chat_id'), '4242\n')
  }
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan))
  const log = join(dir, 'gateway.log')
  const c = {
    dir,
    log: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    events: () =>
      existsSync(join(dir, 'claude.jsonl'))
        ? readFileSync(join(dir, 'claude.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        : [],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      VOICE_GW_STATE_DIR: join(dir, 'state'),
      VOICE_GW_LOG_FILE: log,
      VOICE_GW_SECRETS_DIR: join(dir, 'secrets'),
      VOICE_GW_TELEGRAM_API: telegram.url,
      VOICE_GW_PORT: '1', // nothing answers there unless a step serves
      VOICE_GW_WATCHDOG_BACKOFF: '0.05',
      VOICE_GW_WATCHDOG_BACKOFF_MAX: '0.2',
      VOICE_GW_WATCHDOG_INTERVAL: '0.2',
      FAKE_CLAUDE_PLAN: join(dir, 'plan.json'),
      FAKE_CLAUDE_LOG: join(dir, 'claude.jsonl'),
      ...env,
    },
  }
  c.starts = () => c.events().filter(e => e.event === 'start')
  return c
}

// Without blocking: the stand-in Telegram API runs in this process.
const run = (c, args = []) => runCommand(SCRIPT, args, c.env)

function runCommand(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function waitUntil(predicate, ms = 10000) {
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

const exited = child => new Promise(resolve => child.on('exit', code => resolve(code)))

// --- crashes and intentional stops ---------------------------------------------

test('a crash is restarted with a growing pause; quitting normally ends the watchdog', async () => {
  const before = telegram.messages.length
  const c = setup([{ exit: 1 }, { exit: 139 }, { exit: 0 }])
  const out = await run(c)
  assert.equal(out.status, 0, out.stderr)
  assert.equal(c.starts().length, 3)
  const log = c.log()
  assert.match(log, /watchdog: the controller session ended unexpectedly \(exit code 1\) after \d+ s: restart 1 of at most 5 within 1800 s, in 0\.05 s/)
  assert.match(log, /watchdog: the controller session ended unexpectedly \(killed by signal SEGV \(exit code 139\)\) after \d+ s: restart 2 of at most 5 within 1800 s, in 0\.1 s/)
  assert.match(log, /watchdog: the controller session ended normally \(exit code 0\): not restarting/)
  assert.match(log, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ watchdog: starting the controller session again \(restart 2\)$/m)

  const sent = telegram.messages.slice(before)
  assert.equal(sent.length, 2, 'one message per restart')
  assert.equal(sent[0].chat_id, '4242')
  assert.match(sent[0].text, /the controller session crashed \(exit code 1\) and starts again in 0\.05 s\. Confirm the development channel at the terminal/)
  assert.ok(!log.includes(TOKEN) && !out.stderr.includes(TOKEN) && !out.stdout.includes(TOKEN), 'the token never shows')
})

test('Ctrl+C (exit code 130) is intentional, too', async () => {
  const c = setup([{ exit: 130 }, { exit: 0 }])
  assert.equal((await run(c)).status, 0)
  assert.equal(c.starts().length, 1)
  assert.match(c.log(), /ended with Ctrl\+C \(exit code 130\): not restarting/)
})

test('after too many restarts within the window it gives up, says so, and exits non-zero', async () => {
  const before = telegram.messages.length
  const c = setup(Array.from({ length: 10 }, () => ({ exit: 1 })), { env: { VOICE_GW_WATCHDOG_MAX_RESTARTS: '3' } })
  const out = await run(c)
  assert.equal(out.status, 1)
  assert.equal(c.starts().length, 4, 'the first start and three restarts')
  assert.match(c.log(), /watchdog: giving up: the controller session ended unexpectedly \(exit code 1\) after 3 restarts within 1800 seconds\. Start it again with scripts\/start-controller\.sh/)
  assert.match(out.stderr, /giving up/, 'and on the terminal')
  const sent = telegram.messages.slice(before)
  assert.equal(sent.length, 4)
  assert.match(sent.at(-1).text, /The watchdog gave up after 3 restarts within 30 minutes/)
})

test('one watchdog at a time; --status and --stop, after which nothing restarts', async () => {
  const c = setup([{ run: true }, { exit: 0 }])
  const first = spawn(SCRIPT, [], { env: c.env, stdio: 'ignore' })
  const done = exited(first)
  await waitUntil(() => c.starts().length === 1)
  await waitUntil(() => existsSync(join(c.dir, 'state', 'controller.lock', 'claude.pid')))

  const second = await run(c)
  assert.equal(second.status, 1)
  assert.match(second.stderr, new RegExp(`the controller is already running \\(watchdog ${first.pid}\\)`))
  assert.match((await run(c, ['--status'])).stdout, new RegExp(`running \\(watchdog ${first.pid}, session \\d+\\)`))

  const stop = await run(c, ['--stop'])
  assert.equal(stop.status, 0, stop.stderr)
  assert.match(stop.stdout, /stopped/)
  assert.equal(await done, 0)
  assert.equal(c.starts().length, 1, 'not restarted')
  assert.match(c.log(), /the controller session was stopped \(exit code 143\): not restarting/)
  assert.ok(!existsSync(join(c.dir, 'state', 'controller.lock')), 'the lock is gone')
  assert.match((await run(c, ['--status'])).stdout, /not running/)
})

test('a lock left behind by a killed watchdog does not block the next start', async () => {
  const c = setup([{ exit: 0 }])
  mkdirSync(join(c.dir, 'state', 'controller.lock'), { recursive: true })
  writeFileSync(join(c.dir, 'state', 'controller.lock', 'pid'), '999999')
  assert.equal((await run(c)).status, 0)
  assert.equal(c.starts().length, 1)
})

test('a session whose gateway stops answering is ended and started again', async () => {
  const port = await new Promise(resolve => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  const c = setup([{ serve: 700 }, { exit: 0 }], { env: { VOICE_GW_PORT: String(port), VOICE_GW_WATCHDOG_HEALTH_FAILS: '2' } })
  const out = await run(c)
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(c.events().map(e => e.event), ['start', 'SIGTERM', 'start'])
  assert.match(c.log(), new RegExp(`the gateway has not answered on port ${port} for 2 checks: ending the session so that it starts again`))
  assert.match(c.log(), /ended unexpectedly \(its gateway stopped answering\)/)
})

test('a session whose gateway never answered is left alone, for example while the channel warning waits', async () => {
  const c = setup([{ run: true }])
  const child = spawn(SCRIPT, [], { env: c.env, stdio: 'ignore' })
  const done = exited(child)
  await waitUntil(() => c.starts().length === 1)
  await new Promise(resolve => setTimeout(resolve, 1200)) // six checks at 0.2 s
  assert.equal(c.starts().length, 1)
  assert.doesNotMatch(c.log(), /has not answered/)
  assert.equal((await run(c, ['--stop'])).status, 0)
  assert.equal(await done, 0)
})

test('VOICE_GW_WATCHDOG=0 starts claude directly, as before', async () => {
  const c = setup([{ exit: 3 }], { env: { VOICE_GW_WATCHDOG: '0' } })
  const out = await run(c)
  assert.equal(out.status, 3, 'no restart, the exit code passes through')
  assert.equal(c.starts().length, 1)
  assert.ok(!existsSync(join(c.dir, 'state')), 'no lock')
})

// --- the Telegram message ---------------------------------------------------------

test('telegram-notify: nothing without the secrets, a reason without the token when it fails', async () => {
  const notify = (env, text) => runCommand(process.execPath, [NOTIFY, text], env)
  const without = setup([], { secrets: false })
  const before = telegram.messages.length
  const nothing = await notify(without.env, 'hello')
  assert.deepEqual([nothing.status, nothing.stdout.trim()], [0, 'telegram: not set up'])
  assert.equal(telegram.messages.length, before)

  const c = setup([])
  assert.equal((await notify(c.env, 'Test from the watchdog')).stdout.trim(), 'telegram: sent')
  assert.deepEqual(telegram.messages.at(-1), { chat_id: '4242', text: 'Test from the watchdog' })

  telegram.fail = true
  try {
    const failed = await notify(c.env, 'again')
    assert.equal(failed.status, 1)
    assert.equal(failed.stdout.trim(), 'telegram: not sent: 401 Unauthorized')
  } finally {
    telegram.fail = false
  }
  const nowhere = await notify({ ...c.env, VOICE_GW_TELEGRAM_API: 'http://127.0.0.1:1' }, 'x')
  assert.equal(nowhere.status, 1)
  assert.match(nowhere.stdout, /^telegram: not sent: /)
  assert.ok(!nowhere.stdout.includes(TOKEN) && !nowhere.stderr.includes(TOKEN))
})
