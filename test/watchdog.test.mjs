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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/start-controller.sh', import.meta.url))
const NOTIFY = fileURLToPath(new URL('../scripts/telegram-notify.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-watchdog-'))
const BIN = join(TMP, 'bin')
const TOKEN = '123456789:TEST-token-never-in-a-log'

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const planFile = process.env.FAKE_CLAUDE_PLAN
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const step = plan.shift() ?? { exit: 0 }
writeFileSync(planFile, JSON.stringify(plan))
const lock = process.env.VOICE_GW_WATCHDOG_LOCK
const restarted = lock && existsSync(lock + '/restarted') ? readFileSync(lock + '/restarted', 'utf8').trim() : null
const settings = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name.startsWith('VOICE_GW_TEST_') || name === 'VOICE_GW_CONTROLLER_LEVEL'))
const fromFile = process.env.VOICE_GW_SETTINGS_FROM_FILE ?? null
const note = event => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  pid: process.pid, event, step, lock: lock ?? null, mode: process.env.VOICE_GW_CHANNEL_MODE ?? null, restarted, settings, fromFile,
}) + '\\n')
note('start')
// what the setup assistant does meanwhile: new settings, for the next start
if ('settings' in step) writeFileSync(process.env.VOICE_GW_SECRETS_DIR + '/gateway.env', step.settings)
process.on('SIGTERM', () => { note('SIGTERM'); process.exit(143) })
if (step.restart) {
  // what the gateway does for restart_controller: a note for the watchdog, then SIGTERM
  writeFileSync(lock + '/restart', JSON.stringify({ by: 'voice', at: new Date().toISOString() }))
  process.exit(143)
} else if (step.serve) {
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
      // Not the settings of a gateway that runs this test, from its own environment.
      // Nor the autostart's marks (systemd's INVOCATION_ID, launchd's job name).
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VOICE_GW_') && !['INVOCATION_ID', 'XPC_SERVICE_NAME'].includes(name))),
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
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      VOICE_GW_MANAGED_SETTINGS: join(dir, 'no-managed-settings.json'),
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
  const user = process.env.USER ?? process.env.LOGNAME
  assert.match(c.log(), new RegExp(`watchdog: starting the controller session \\(watchdog ${first.pid}, started by ${user} from .*\\)`))
  assert.match(c.log(), new RegExp(`watchdog: stop requested by ${user} from \\S*node`), 'who stopped it')
  assert.match(c.log(), new RegExp(`the controller session was stopped by ${user} from \\S*node.* \\(exit code 143\\): not restarting`))
  assert.ok(!existsSync(join(c.dir, 'state', 'controller.lock')), 'the lock is gone')
  assert.match((await run(c, ['--status'])).stdout, /not running/)
})

test('a restart the controller asked for starts again at once, does not count, and leaves a note', async () => {
  const before = telegram.messages.length
  const c = setup([{ restart: true }, { restart: true }, { exit: 0 }], {
    env: { VOICE_GW_WATCHDOG_MAX_RESTARTS: '1', VOICE_GW_WATCHDOG_BACKOFF: '30' },
  })
  const started = Date.now()
  const out = await run(c)
  assert.equal(out.status, 0, out.stderr)
  assert.ok(Date.now() - started < 15000, 'no pause before a requested restart')
  const starts = c.starts()
  assert.equal(starts.length, 3, 'two requested restarts, although at most one restart may count')
  assert.equal(starts[0].restarted, null)
  assert.equal(starts[1].restarted, 'a restart requested by voice', 'the next gateway learns why it was restarted')
  assert.ok(starts.every(s => s.lock === join(c.dir, 'state', 'controller.lock')), 'the session knows the lock folder')
  assert.ok(starts.every(s => s.mode === 'development'))
  const log = c.log()
  assert.match(log, /the controller session ended for a restart requested by voice \(exit code 143\): starting it again at once, not counted as a crash/)
  assert.match(log, /starting the controller session again \(requested restart\)/)
  assert.doesNotMatch(log, /ended unexpectedly|giving up/)
  assert.equal(telegram.messages.length, before, 'no crash message')
})

test('every start reads the settings file again; the environment still wins, and the level stays', async () => {
  const c = setup([
    { restart: true, settings: 'VOICE_GW_TEST_A=2\nVOICE_GW_TEST_C=file\nVOICE_GW_CONTROLLER_LEVEL=unrestricted\n' },
    { exit: 1, settings: 'VOICE_GW_TEST_C=file\n' },
    { exit: 0 },
  ], {
    // TEST_B came from the file of a start script above this one, as its
    // list says: it is read from the file again, and does not win.
    env: { VOICE_GW_TEST_C: 'outside', VOICE_GW_TEST_B: 'stale', VOICE_GW_SETTINGS_FROM_FILE: 'VOICE_GW_TEST_B' },
  })
  writeFileSync(join(c.dir, 'secrets', 'gateway.env'), 'VOICE_GW_TEST_A=1\nVOICE_GW_TEST_B=1\nVOICE_GW_CONTROLLER_LEVEL=clone-delete\n')
  const out = await run(c)
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(c.starts().map(s => s.settings), [
    { VOICE_GW_TEST_A: '1', VOICE_GW_TEST_B: '1', VOICE_GW_TEST_C: 'outside', VOICE_GW_CONTROLLER_LEVEL: 'clone-delete' },
    { VOICE_GW_TEST_A: '2', VOICE_GW_TEST_C: 'outside', VOICE_GW_CONTROLLER_LEVEL: 'clone-delete' },
    { VOICE_GW_TEST_C: 'outside', VOICE_GW_CONTROLLER_LEVEL: 'clone-delete' },
  ], 'changed and removed lines count from the next start, a requested restart or a crash')
  // The gateway learns which values it can take from the file, so that only
  // those set outside win over it, also while it runs (src/live.mjs); not the
  // level, which stays as this script took it.
  assert.deepEqual(c.starts().map(s => s.fromFile), ['VOICE_GW_TEST_A VOICE_GW_TEST_B', 'VOICE_GW_TEST_A', ''])
  const lines = c.log().split('\n').filter(line => / watchdog: settings from /.test(line))
  assert.equal(lines.length, 3, 'one line per start')
  assert.match(lines[0], /settings from \S*gateway\.env: VOICE_GW_CONTROLLER_LEVEL=clone-delete VOICE_GW_TEST_A=1 VOICE_GW_TEST_B=1; from the environment, which wins: .*VOICE_GW_TEST_C=outside.*; gateway port 1$/)
  assert.doesNotMatch(lines[0], /TEST_B=stale|which wins: .*VOICE_GW_SETTINGS_FROM_FILE/)
  assert.match(lines[2], /settings from \S*gateway\.env: VOICE_GW_CONTROLLER_LEVEL=clone-delete; from the environment/)
})

test('after a crash the next session finds a note with the reason', async () => {
  const c = setup([{ exit: 1 }, { exit: 0 }])
  assert.equal((await run(c)).status, 0)
  assert.equal(c.starts()[1].restarted, 'a crash (exit code 1)')
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

// The channel as the plugin, registered from this repository: no confirmation
// for it at the start.
function asPlugin(c) {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  mkdirSync(join(c.dir, 'claude-config', 'plugins'), { recursive: true })
  writeFileSync(
    join(c.dir, 'claude-config', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'cc-voice-gateway': { source: { source: 'directory', path: root }, installLocation: root } }),
  )
}

test('Claude in Chrome: marked as seen, a restart needs no confirmation; if it cannot be, Telegram says to confirm at the terminal', async () => {
  const env = { VOICE_GW_CONTROLLER_CHROME: '1', VOICE_GW_CHANNEL: 'plugin' }
  let before = telegram.messages.length
  const marked = setup([{ exit: 1 }, { exit: 0 }], { env })
  asPlugin(marked)
  writeFileSync(join(marked.dir, 'claude-config', '.claude.json'), '{}')
  assert.equal((await run(marked)).status, 0)
  assert.ok(marked.starts().every(s => s.mode === 'plugin'))
  let sent = telegram.messages.slice(before).map(m => m.text)
  assert.equal(sent.length, 1, 'only the crash')
  assert.match(sent[0], /crashed \(exit code 1\) and starts again in 0\.05 s, without a confirmation\. A message follows when it is ready\./)
  assert.equal(marked.log().match(/ chrome: marked /g)?.length, 1, 'marked at the first start, quiet at the second')

  // Claude Code's config does not exist yet: at each start the log and
  // Telegram say that the notice may wait, and the crash message promises no
  // start without a confirmation.
  before = telegram.messages.length
  const unmarked = setup([{ exit: 1 }, { exit: 0 }], { env })
  asPlugin(unmarked)
  assert.equal((await run(unmarked)).status, 0)
  sent = telegram.messages.slice(before).map(m => m.text)
  assert.equal(sent.length, 3, 'at both starts, and for the crash')
  for (const text of [sent[0], sent[2]]) {
    assert.match(text, /the controller session starts with Claude in Chrome, whose notice for the first start could not be marked as seen \(\S*\.claude\.json does not exist yet: .*\)\. If it shows, the session waits for Enter at the terminal \(tmux attach -t voice\), and voice requests do not arrive until then\./)
  }
  assert.match(sent[1], /crashed \(exit code 1\) and starts again in 0\.05 s\. A message follows when it is ready\./)
  assert.doesNotMatch(sent[1], /without a confirmation/)
  assert.equal(unmarked.log().match(/watchdog: chrome: Claude in Chrome's notice for the first start could not be marked as seen, since .*; if Claude Code shows it, the session waits for Enter at the terminal \(tmux attach -t voice\)/g)?.length, 2)
})

test('VOICE_GW_WATCHDOG=0 starts claude directly, as before', async () => {
  const c = setup([{ exit: 3 }], { env: { VOICE_GW_WATCHDOG: '0' } })
  const out = await run(c)
  assert.equal(out.status, 3, 'no restart, the exit code passes through')
  assert.equal(c.starts().length, 1)
  assert.ok(!existsSync(join(c.dir, 'state')), 'no lock')
})

// --- macOS ------------------------------------------------------------------------

// Commands that play macOS here: uname says what to, caffeinate notes how it
// was called.
function macBin(name, system) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'uname'), `#!/bin/sh\necho ${system}\n`)
  writeFileSync(join(dir, 'caffeinate'), `#!/bin/sh\necho "$*" >> "${join(dir, 'caffeinate.log')}"\n`)
  chmodSync(join(dir, 'uname'), 0o755)
  chmodSync(join(dir, 'caffeinate'), 0o755)
  const calls = () => (existsSync(join(dir, 'caffeinate.log')) ? readFileSync(join(dir, 'caffeinate.log'), 'utf8').trim().split('\n') : [])
  return { path: `${dir}:${BIN}:${process.env.PATH}`, calls }
}

test('macOS: no idle sleep while the watchdog runs (caffeinate), unless VOICE_GW_CAFFEINATE=0; not on Linux', async () => {
  const mac = macBin('darwin-bin', 'Darwin')
  const c = setup([{ exit: 0 }], { env: { PATH: mac.path } })
  assert.equal((await run(c)).status, 0)
  const watchdog = /watchdog: starting the controller session \(watchdog (\d+),/.exec(c.log())?.[1]
  assert.deepEqual(mac.calls(), [`-i -s -w ${watchdog}`], 'until the watchdog ends')
  assert.match(c.log(), /watchdog: caffeinate: this Mac does not go to sleep by itself while the watchdog runs \(VOICE_GW_CAFFEINATE=0 turns it off\)/)

  const off = setup([{ exit: 0 }], { env: { PATH: mac.path, VOICE_GW_CAFFEINATE: '0' } })
  assert.equal((await run(off)).status, 0)
  assert.equal(mac.calls().length, 1, 'turned off')
  assert.doesNotMatch(off.log(), /caffeinate/)

  const linux = macBin('linux-bin', 'Linux')
  const l = setup([{ exit: 0 }], { env: { PATH: linux.path } })
  assert.equal((await run(l)).status, 0)
  assert.deepEqual(linux.calls(), [])
  assert.doesNotMatch(l.log(), /caffeinate/)
})

test('macOS: started by the LaunchAgent\'s tmux, the log says so; a stop never comes from it', async () => {
  const user = process.env.USER ?? process.env.LOGNAME
  const agent = { XPC_SERVICE_NAME: 'com.drawio.cc-voice-gateway' } // launchd names its job so
  // launchd's tmux runs the script: here a bash called tmux, which stays its parent.
  const tmux = join(TMP, 'tmux-bin', 'tmux')
  mkdirSync(dirname(tmux), { recursive: true })
  symlinkSync(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find(existsSync), tmux)
  const viaTmux = (c, args = '') => spawn(tmux, ['-c', `"$0"${args}; exit $?`, SCRIPT], { env: c.env, stdio: 'ignore' })

  const c = setup([{ run: true }, { exit: 0 }], { env: agent })
  const done = exited(viaTmux(c))
  await waitUntil(() => existsSync(join(c.dir, 'state', 'controller.lock', 'claude.pid')))
  assert.equal(await exited(viaTmux(c, ' --stop')), 0)
  assert.equal(await done, 0)
  assert.match(c.log(), /watchdog: starting the controller session \(watchdog \d+, started by the LaunchAgent com\.drawio\.cc-voice-gateway\)/)
  assert.match(c.log(), new RegExp(`watchdog: stop requested by ${user} from \\S*tmux`), 'launchd has no stop command')

  // Its name alone, as in any shell below that tmux, is not the LaunchAgent.
  const d = setup([{ exit: 0 }], { env: agent })
  assert.equal((await run(d)).status, 0)
  assert.match(d.log(), new RegExp(`started by ${user} from \\S*node`))
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
