// The watchdog in scripts/start-controller.sh: restarts after a crash, not
// after an intentional stop, with backoff and a limit, one instance at a time,
// and a Telegram message through scripts/telegram-notify.mjs.
//
// A fake claude follows a plan, one step per start: exit with a code, run
// until stopped, or serve the gateway's /healthz for a while and then stop
// answering, or start a gateway of this checkout as its child that serves
// /healthz (for --status); with stats, it saves the statistics as the gateway does, at its
// start and its end (src/stats.mjs), for the message when the gateway shuts
// down. A local HTTP server stands in for the Telegram Bot API; no test
// reaches the real one, and the real .state, log and .secrets stay untouched.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VOICE_GW_LOG_FILE = ''
const { Stats } = await import('../src/stats.mjs')

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SCRIPT = fileURLToPath(new URL('../scripts/start-controller.sh', import.meta.url))
const NOTIFY = fileURLToPath(new URL('../scripts/telegram-notify.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-watchdog-'))
const BIN = join(TMP, 'bin')
const TOKEN = '123456789:TEST-token-never-in-a-log'

const FAKE_CLAUDE = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
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
// the gateway's statistics: saved as it starts, and with the end as it ends
const startedAt = Date.now()
const saveStats = ended => {
  if (!step.stats) return
  const data = JSON.parse(readFileSync(process.env.FAKE_STATS, 'utf8'))
  data.current.since = startedAt
  data.session = process.pid // the gateway notes its parent, this session
  if (ended) data.current.endedAt = Date.now()
  writeFileSync(process.env.VOICE_GW_STATE_DIR + '/stats.json', JSON.stringify(data))
}
saveStats(false)
// what the setup assistant does meanwhile: new settings, for the next start
if ('settings' in step) writeFileSync(process.env.VOICE_GW_SECRETS_DIR + '/gateway.env', step.settings)
let gateway = null
process.on('SIGTERM', () => { note('SIGTERM'); saveStats(true); gateway?.kill(); process.exit(143) })
if (step.restart) {
  // what the gateway does for restart_controller: a note for the watchdog, then SIGTERM
  writeFileSync(lock + '/restart', JSON.stringify({ by: 'voice', at: new Date().toISOString() }))
  saveStats(true)
  process.exit(143)
} else if (step.serve) {
  // the gateway answers for a while, then no longer, while the session goes on
  const server = createServer((req, res) => res.end('ok')).listen(Number(process.env.VOICE_GW_PORT), '127.0.0.1')
  setTimeout(() => server.close(), step.serve)
  setInterval(() => {}, 1000)
} else if (step.gateway) {
  // the plugin's server of this checkout, by its path, as Claude Code starts it
  const serve = "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.VOICE_GW_PORT), '127.0.0.1')"
  gateway = spawn(process.execPath, ['-e', serve, process.env.FAKE_ROOT + '/src/plugin.mjs'], { stdio: 'ignore' })
  setInterval(() => {}, 1000)
} else if (step.run) {
  setInterval(() => {}, 1000)
} else {
  saveStats(true)
  process.exit(step.exit)
}
`

// --- the stand-in Telegram API -------------------------------------------------

const telegram = { server: null, url: '', messages: [], fail: false }
const STATS = join(TMP, 'stats-template.json') // what a gateway saved: two hours, two runs, a question

before(async () => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  chmodSync(join(BIN, 'claude'), 0o755)
  const clock = { now: Date.now() }
  const stats = new Stats({ file: STATS, now: () => clock.now, log: () => {} })
  for (const [id, state] of [['t1', 'done'], ['t2', 'failed']]) {
    stats.runEnded({ id, repo: 'alpha', kind: 'repo', state, startedAt: clock.now, finishedAt: clock.now + 20 * 60000 })
  }
  stats.current.voice.requests = 3
  clock.now += 2 * 60 * 60000
  stats.close()
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
      FAKE_STATS: STATS,
      FAKE_ROOT: ROOT,
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
  const status = (await run(c, ['--status'])).stdout.split('\n')
  assert.match(status[0], new RegExp(`^start-controller: running \\(watchdog ${first.pid}, session \\d+\\)$`), 'the first line as before')
  // Other test files start gateways of this checkout meanwhile: only the shape here.
  assert.match(status[1], /^start-controller: (no gateway process of this checkout|gateway process .*); port 1 does not answer$/)

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
  assert.match((await run(c, ['--status'])).stdout, /^start-controller: not running\n/)
})

async function freePort() {
  return new Promise(resolve => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// A checkout of its own: real folders, the scripts linked in. Its gateway
// processes are its own, not those that other test files start meanwhile
// from this one, and the emergency script ends only those.
let checkouts = 0
function ownCheckout() {
  const root = join(TMP, `checkout-${++checkouts}`)
  for (const dir of ['scripts', 'src', 'controller']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of readdirSync(join(ROOT, 'scripts'))) symlinkSync(join(ROOT, 'scripts', file), join(root, 'scripts', file))
  symlinkSync(join(ROOT, 'controller', '.mcp.json'), join(root, 'controller', '.mcp.json'))
  return realpathSync(root)
}

// Ends what a failed test left running, by the lock and the processes it names.
async function stopAll(c, script) {
  await runCommand(script, ['--stop'], c.env)
}

test("--status shows the gateway: the session's child, how long it runs, whether its port answers; one left over; not another checkout's", async () => {
  const root = ownCheckout()
  const script = join(root, 'scripts', 'start-controller.sh')
  const port = await freePort()
  const c = setup([{ gateway: true }], { env: { VOICE_GW_PORT: String(port), FAKE_ROOT: root } })
  const first = spawn(script, [], { env: c.env, stdio: 'ignore' })
  const done = exited(first)
  const forever = 'setInterval(() => {}, 1000)'
  // A gateway whose session is gone, started by the development flag's
  // relative path from controller/; and one of another checkout, this one.
  const leftover = spawn(process.execPath, ['-e', forever, '../src/gateway.mjs'], { cwd: join(root, 'controller'), stdio: 'ignore' })
  const other = spawn(process.execPath, ['-e', forever, join(ROOT, 'src', 'plugin.mjs')], { stdio: 'ignore' })
  try {
    await waitUntil(() => existsSync(join(c.dir, 'state', 'controller.lock', 'claude.pid')))
    const session = Number(readFileSync(join(c.dir, 'state', 'controller.lock', 'claude.pid'), 'utf8'))
    let status = ''
    for (let i = 0; i < 50 && !/ answers$/m.test(status); i++) {
      status = (await runCommand(script, ['--status'], c.env)).stdout
      if (!/ answers$/m.test(status)) await new Promise(resolve => setTimeout(resolve, 100))
    }
    const [head, gateway] = status.trim().split('\n')
    assert.equal(head, `start-controller: running (watchdog ${first.pid}, session ${session})`)
    assert.match(gateway, /^start-controller: gateway process /)
    assert.match(gateway, /process \d+ \(src\/plugin\.mjs\), running for less than a minute;/, "the session's own")
    assert.match(gateway, new RegExp(`process ${leftover.pid} \\(src/gateway\\.mjs, of no session of the watchdog\\), running for less than a minute;`))
    assert.match(gateway, new RegExp(`; port ${port} answers$`))
    assert.doesNotMatch(gateway, new RegExp(`process ${other.pid}\\b`), "another checkout's is not this one's")

    assert.equal((await runCommand(script, ['--stop'], c.env)).status, 0)
    assert.equal(await done, 0)
    const after = (await runCommand(script, ['--status'], c.env)).stdout.trim().split('\n')
    assert.deepEqual(after, [
      'start-controller: not running',
      `start-controller: gateway process ${leftover.pid} (src/gateway.mjs, of no session of the watchdog), running for less than a minute; port ${port} does not answer`,
    ])
  } finally {
    await stopAll(c, script)
    leftover.kill()
    other.kill()
  }
})

// --- scripts/restart-everything.sh ------------------------------------------------

// Stand-ins for tmux, systemctl, systemd-run, launchctl and uname, first on
// the PATH: no test reaches the real service, LaunchAgent or tmux session,
// also not on a Mac, where uname says Darwin and the real LaunchAgent's file
// may exist: uname says Linux unless the case plays macOS. They note how they
// were called; tmux, systemctl start and launchctl kickstart start the start
// script in the background, as the real ones do.
function restartBin(c, { service = false, mac = false } = {}) {
  const dir = join(c.dir, 'restart-bin')
  mkdirSync(dir, { recursive: true })
  const calls = join(c.dir, 'calls.log')
  const script = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  const background = '( "$START" </dev/null >/dev/null 2>&1 & )'
  script('tmux', `case "$1" in
  has-session) exit 1 ;;
  new-session) ${background} ;;
esac`)
  script('systemd-run', 'echo "systemd-run is not for tests" >&2; exit 1')
  script('systemctl', service
    ? `state="${c.dir}/service"
case "$*" in
  *LoadState*) echo loaded ;;
  *KillMode*) echo control-group ;;
  *is-active*) cat "$state" 2>/dev/null || echo inactive ;;
  *InvocationID*) echo test-invocation ;;
  *MainPID*) echo "\${FAKE_MAIN_PID:-0}" ;;
  *list-jobs*) [ -f "$state.job" ] && echo "4711 cc-voice-gateway.service $(cat "$state.job") running" ;;
  *" stop "*) echo stop > "$state.job"; FAKE_MAIN_PID=$$ INVOCATION_ID=test-invocation "$START" --stop >/dev/null 2>&1; rm -f "$state.job"; echo inactive > "$state" ;;
  *" start "*) echo active > "$state"; ${background} ;;
esac
exit 0`
    : 'case "$*" in *LoadState*) echo not-found ;; esac\nexit 0')
  script('uname', `echo ${mac ? 'Darwin' : 'Linux'}`)
  script('launchctl', `case "$1" in
  print) exit 0 ;;
  kickstart) ${background} ;;
esac`)
  return { path: `${dir}:${c.env.PATH}`, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '') }
}

const RESTART_REASON = 'a restart of everything (scripts/restart-everything.sh)'

// A case for the emergency script: a checkout of its own, a watchdog running
// there, and the stand-ins.
async function emergency(plan, { service = false, mac = false, wait = '20', gateway = true } = {}) {
  const root = ownCheckout()
  const start = join(root, 'scripts', 'start-controller.sh')
  const port = await freePort()
  const c = setup(plan, { env: { VOICE_GW_PORT: String(port), FAKE_ROOT: root, START: start, VOICE_GW_RESTART_WAIT: wait, VOICE_GW_RESTART_MOVED: '1' } })
  const bin = restartBin(c, { service, mac })
  c.env.PATH = bin.path
  // A home of its own, with the LaunchAgent's file only where it plays macOS.
  c.env.HOME = join(c.dir, 'home')
  mkdirSync(join(c.env.HOME, 'Library', 'LaunchAgents'), { recursive: true })
  if (mac) writeFileSync(join(c.env.HOME, 'Library', 'LaunchAgents', 'com.drawio.cc-voice-gateway.plist'), '<plist/>')
  if (service) writeFileSync(join(c.dir, 'service'), 'active\n')
  return { c, root, start, port, bin, script: join(root, 'scripts', 'restart-everything.sh'), gateway }
}

async function running(e) {
  const first = spawn(e.start, [], { env: e.c.env, stdio: 'ignore' })
  await waitUntil(() => existsSync(join(e.c.dir, 'state', 'controller.lock', 'claude.pid')))
  return first
}

test('restart-everything under tmux: says what it stops, ends what is left of this checkout only, starts again, and waits until the gateway answers', async () => {
  const e = await emergency([{ run: true, stats: true }, { gateway: true }])
  const { c } = e
  const forever = 'setInterval(() => {}, 1000)'
  const before = telegram.messages.length
  await running(e)
  // Worker runs on this computer keep running under tmux.
  writeFileSync(join(c.dir, 'state', 'workers.json'), JSON.stringify({
    tasks: [{ id: 't1aa', repo: 'alpha', kind: 'repo', state: 'running', startedAt: Date.now() - 5 * 60000, container: null }],
    queue: [{ id: 'q1bb', worker: 'alpha' }],
  }))
  const leftover = spawn(process.execPath, ['-e', forever, join(e.root, 'src', 'plugin.mjs')], { stdio: 'ignore' })
  const other = spawn(process.execPath, ['-e', forever, join(ROOT, 'src', 'plugin.mjs')], { stdio: 'ignore' })
  try {
    const out = await runCommand(e.script, [], c.env)
    assert.equal(out.status, 0, out.stdout + out.stderr)
    const lines = out.stdout.trim().split('\n')
    assert.match(lines[0], new RegExp(`^restarting everything of the gateway in ${e.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, started by `))
    assert.ok(lines.includes('no autostart: the controller runs in the tmux session "voice"'), out.stdout)
    assert.match(out.stdout, /^before: running \(watchdog \d+, session \d+\)$/m)
    assert.match(out.stdout, /^worker run t1aa in alpha, running for 5 min: it keeps running; the gateway after the start follows it$/m)
    assert.match(out.stdout, /^1 queued task: it stays queued and starts by itself after the start$/m)
    assert.ok(lines.includes('stopped the watchdog and the controller session'), out.stdout)
    assert.ok(lines.includes(`ending a gateway of this checkout left over (src/plugin.mjs) (process ${leftover.pid})`), out.stdout)
    assert.ok(lines.includes('starting the controller in the tmux session "voice"'), out.stdout)
    assert.match(out.stdout, /^now: running \(watchdog \d+, session \d+\)$/m)
    assert.match(out.stdout, new RegExp(`^now: gateway process \\d+ \\(src/plugin\\.mjs\\), running for less than a minute; port ${e.port} answers$`, 'm'))
    assert.equal(lines.at(-1), 'everything runs again')
    assert.equal(other.exitCode, null, "another checkout's process is not touched")
    await waitUntil(() => leftover.exitCode !== null || leftover.signalCode !== null)
    assert.match(e.bin.calls(), /^tmux new-session -d -s voice .*start-controller\.sh$/m)
    assert.doesNotMatch(e.bin.calls(), /^systemd-run/m)
    // The restart's messages, no others: requested, then the statistics; the
    // next gateway says that it is ready, with the reason the next watchdog found.
    const sent = texts(before, c)
    assert.equal(sent.length, 2, sent.join('\n---\n'))
    assert.match(sent[0], new RegExp(`^${RESTART_REASON.replace(/[()]/g, '\\$&')} was requested; the controller restarts now\\.`))
    assert.match(sent[1], /^the gateway is shutting down now for the restart\. Its statistics:/)
    assert.equal(c.starts().at(-1).restarted, RESTART_REASON)
    assert.match(c.log(), /restart-everything: restarting everything of the gateway/)
    assert.match(c.log(), /restart-everything: everything runs again/)
  } finally {
    await stopAll(c, e.start)
    leftover.kill()
    other.kill()
  }
})

test('restart-everything with the systemd service: worker runs end with its stop, and what happens to each; stop, then start', async () => {
  const e = await emergency([{ run: true, stats: true }, { gateway: true }], { service: true })
  const { c } = e
  const before = telegram.messages.length
  await running(e)
  writeFileSync(join(c.dir, 'state', 'workers.json'), JSON.stringify({
    tasks: [
      { id: 't1aa', repo: 'alpha', kind: 'repo', state: 'running', startedAt: Date.now(), container: null },
      { id: 't2bb', repo: 'alpha', kind: 'repo', state: 'running', startedAt: Date.now(), container: null, worktree: 't2bb' },
      { id: 't3cc', repo: 'beta', kind: 'repo', state: 'done', startedAt: Date.now(), container: null },
    ],
    queue: [],
  }))
  try {
    const out = await runCommand(e.script, [], c.env)
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /^the autostart: the systemd user service cc-voice-gateway\.service$/m)
    assert.match(out.stdout, /^worker run t1aa in alpha, running for less than a minute: the stop of the service ends it; after the start the gateway reports it as failed, and it is not queued again$/m)
    assert.match(out.stdout, /^worker run t2bb in a worktree of alpha, running for less than a minute: the stop of the service ends it; after the start it goes back to the queue and resumes in its worktree$/m)
    assert.doesNotMatch(out.stdout, /t3cc/)
    assert.match(out.stdout, /^stopping the service cc-voice-gateway\.service$/m)
    assert.match(out.stdout, /^starting the service cc-voice-gateway\.service$/m)
    assert.match(out.stdout, /^everything runs again$/m)
    const calls = e.bin.calls()
    assert.ok(calls.indexOf('systemctl --user stop cc-voice-gateway.service') < calls.indexOf('systemctl --user start cc-voice-gateway.service'))
    const sent = texts(before, c)
    assert.equal(sent.length, 2, sent.join('\n---\n'))
    assert.match(sent[0], / was requested; the controller restarts now\./)
    assert.match(sent[1], /^the gateway is shutting down now for the restart\./, 'the service was stopped, for the restart')
    assert.match(c.log(), /watchdog: stop requested by the service cc-voice-gateway\.service/)
    assert.equal(c.starts().at(-1).restarted, RESTART_REASON)
  } finally {
    await stopAll(c, e.start)
  }
})

test('restart-everything on macOS: the LaunchAgent has no stop of its own; --stop, then kickstart', async () => {
  const e = await emergency([{ run: true }, { gateway: true }], { mac: true })
  const { c } = e
  await running(e)
  try {
    const out = await runCommand(e.script, [], c.env)
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /^the autostart: the LaunchAgent com\.drawio\.cc-voice-gateway$/m)
    assert.match(out.stdout, /^stopped the watchdog and the controller session$/m)
    assert.match(out.stdout, /^starting the LaunchAgent com\.drawio\.cc-voice-gateway$/m)
    assert.match(e.bin.calls(), new RegExp(`^launchctl kickstart gui/${process.getuid()}/com\\.drawio\\.cc-voice-gateway$`, 'm'))
    assert.match(out.stdout, /^everything runs again$/m)
  } finally {
    await stopAll(c, e.start)
  }
})

test("restart-everything: a stale lock goes; another program on the gateway's port is named, not touched, and the end says what fails", async () => {
  const e = await emergency([{ run: true }], { wait: '2' })
  const { c } = e
  mkdirSync(join(c.dir, 'state', 'controller.lock'), { recursive: true })
  writeFileSync(join(c.dir, 'state', 'controller.lock', 'pid'), '999999')
  // Not HTTP: it holds the port and answers no /healthz.
  const squatter = createTcpServer(socket => socket.destroy())
  await new Promise(resolve => squatter.listen(e.port, '127.0.0.1', resolve))
  try {
    const out = await runCommand(e.script, [], c.env)
    assert.equal(out.status, 1, out.stdout + out.stderr)
    assert.match(out.stdout, /^before: not running$/m)
    assert.match(out.stdout, /^removed the lock a watchdog left behind$/m)
    assert.match(out.stdout, new RegExp(`^the gateway's port ${e.port} is taken by process ${process.pid} \\(.*\\), which is not this gateway: not touched; the gateway cannot start until it is free$`, 'm'))
    assert.match(out.stdout, /^now: running \(watchdog \d+, session \d+\)$/m)
    assert.equal(
      out.stdout.trim().split('\n').at(-1),
      `the gateway cannot start while process ${process.pid} holds its port ${e.port}: end it (lsof -nP -iTCP:${e.port} -sTCP:LISTEN), then run this script again`,
    )
  } finally {
    squatter.close()
    await stopAll(c, e.start)
  }
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
  // One message as each begins, none of a crash; the gateway sends the next
  // when the controller is ready again.
  const sent = telegram.messages.slice(before).map(m => m.text)
  assert.equal(sent.length, 2, sent.join('\n'))
  for (const text of sent) {
    assert.match(text, /: a restart was requested by voice; the controller restarts now\. Confirm the development channel at the terminal \(tmux attach -t voice\), otherwise voice requests do not arrive\. A message follows when it is ready\.$/)
  }
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

test('Claude in Chrome: marked as seen, a restart needs no confirmation; if it cannot be, the log and the restart\'s message say so', async () => {
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

  // Claude Code's config does not exist yet: each start logs that the notice
  // may wait. No message of its own: the crash's message says it instead of
  // promising a start without a confirmation.
  before = telegram.messages.length
  const unmarked = setup([{ exit: 1 }, { exit: 0 }], { env })
  asPlugin(unmarked)
  assert.equal((await run(unmarked)).status, 0)
  sent = telegram.messages.slice(before).map(m => m.text)
  assert.equal(sent.length, 1, 'only the crash')
  assert.match(sent[0], /crashed \(exit code 1\) and starts again in 0\.05 s\. Claude in Chrome's notice for the first start may wait for Enter at the terminal \(tmux attach -t voice\)\. A message follows when it is ready\./)
  assert.doesNotMatch(sent[0], /without a confirmation/)
  assert.equal(unmarked.log().match(/watchdog: chrome: Claude in Chrome's notice for the first start could not be marked as seen, since \S*\.claude\.json does not exist yet: .*; if Claude Code shows it, the session waits for Enter at the terminal \(tmux attach -t voice\)/g)?.length, 2)

  // A restart on purpose says it too.
  before = telegram.messages.length
  const restarted = setup([{ restart: true }, { exit: 0 }], { env })
  asPlugin(restarted)
  assert.equal((await run(restarted)).status, 0)
  assert.deepEqual(telegram.messages.slice(before).map(m => m.text.replace(/^.*?: /, '')), [
    "a restart was requested by voice; the controller restarts now. Claude in Chrome's notice for the first start may wait for Enter at the terminal (tmux attach -t voice). A message follows when it is ready.",
  ])
})

test('Claude in Chrome: each start logs whether a desktop session of the user and a Chrome run, the log only; on Linux and on macOS', async () => {
  const user = process.env.USER ?? process.env.LOGNAME
  // Stand-ins: uname for the platform; on Linux loginctl with or without the
  // user's graphical session, on macOS stat with the console's owner; pgrep
  // with or without a Chrome.
  const fakes = (name, { system = 'Linux', display = '', owner = 'root', chrome }) => {
    const dir = join(TMP, name)
    mkdirSync(dir, { recursive: true })
    const script = (command, body) => {
      writeFileSync(join(dir, command), `#!/bin/sh\n${body}\n`)
      chmodSync(join(dir, command), 0o755)
    }
    script('uname', `echo ${system}`)
    script('loginctl', `case "$*" in\n  *show-user*) echo "${display}" ;;\n  *show-session*) echo x11 ;;\nesac`)
    script('stat', `echo ${owner}`)
    script('pgrep', `exit ${chrome ? 0 : 1}`)
    return `${dir}:${BIN}:${process.env.PATH}`
  }
  const logged = async (name, platform) => {
    const c = setup([{ exit: 0 }], { env: { VOICE_GW_CONTROLLER_CHROME: '1', PATH: fakes(name, platform) } })
    assert.equal((await run(c)).status, 0)
    return c.log()
  }
  const before = telegram.messages.length
  assert.match(await logged('chrome-none', { chrome: false }), new RegExp(`watchdog: chrome desktop: no desktop session of ${user}, and no Chrome of the user runs: until someone is signed in at the desktop, or in a remote desktop session that stays, with Chrome open and the Claude extension signed in, Claude in Chrome's tools answer that the extension is not connected`))
  assert.match(await logged('chrome-both', { display: 'c2', chrome: true }), new RegExp(`watchdog: chrome desktop: a desktop session of ${user} \\(session c2, x11\\), and a Chrome of the user runs; Claude in Chrome works if its extension is signed in to the same claude\\.ai account`))
  // macOS: the desktop is the console's, at the login window root's.
  assert.match(await logged('chrome-mac', { system: 'Darwin', owner: user, chrome: true }), new RegExp(`watchdog: chrome desktop: a desktop session of ${user} \\(the console\\), and a Chrome of the user runs; Claude in Chrome works`))
  assert.match(await logged('chrome-mac-login', { system: 'Darwin', chrome: true }), new RegExp(`watchdog: chrome desktop: no desktop session of ${user}, and a Chrome of the user runs: until someone is signed in`))
  assert.equal(telegram.messages.length, before, 'no message')
})

// --- restarts on purpose: one message as each begins -----------------------------

// systemctl as the autostart's systemd sees it: the service's invocation and
// main process, and the job it runs (restart or stop), for invoker() and --stop.
function systemd(c, job) {
  const dir = join(c.dir, 'systemd-bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'systemctl'), `#!/bin/sh
case "$*" in
  *InvocationID*) echo test-invocation ;;
  *MainPID*) echo ${process.pid} ;;
  *list-jobs*) echo "4711 cc-voice-gateway.service ${job} running" ;;
esac
`)
  chmodSync(join(dir, 'systemctl'), 0o755)
  // The test runs the script itself, as systemd runs ExecStop: its parent is
  // the service's main process.
  return { ...c.env, PATH: `${dir}:${c.env.PATH}`, INVOCATION_ID: 'test-invocation' }
}

test('a restart of the autostart\'s service: one message as it begins, and the next watchdog leaves the reason for the ready message', async () => {
  const c = setup([{ run: true }, { exit: 0 }])
  let before = telegram.messages.length
  const first = spawn(SCRIPT, [], { env: c.env, stdio: 'ignore' })
  const done = exited(first)
  await waitUntil(() => existsSync(join(c.dir, 'state', 'controller.lock', 'claude.pid')))
  const stop = await runCommand(SCRIPT, ['--stop'], systemd(c, 'restart'))
  assert.equal(stop.status, 0, stop.stderr)
  assert.equal(await done, 0)
  assert.match(c.log(), /watchdog: stop requested by the service cc-voice-gateway\.service/)
  assert.match(c.log(), /watchdog: a restart of the service cc-voice-gateway\.service: the controller session starts again right after this stop/)
  assert.deepEqual(telegram.messages.slice(before).map(m => m.text.replace(/^.*?: /, '')), [
    'a restart of the service cc-voice-gateway.service was requested; the controller restarts now. Confirm the development channel at the terminal (tmux attach -t voice), otherwise voice requests do not arrive. A message follows when it is ready.',
  ])

  // systemd starts the next watchdog: it tells its gateway why, for the
  // message when the controller is ready again, and sends none of its own.
  before = telegram.messages.length
  assert.equal((await run(c)).status, 0)
  assert.equal(c.starts().at(-1).restarted, 'a restart of the service cc-voice-gateway.service')
  assert.match(c.log(), /watchdog: starting the controller session \(watchdog \d+, started by .*\), after a restart of the service cc-voice-gateway\.service$/m)
  assert.ok(!existsSync(join(c.dir, 'state', 'controller.restarting')), 'the note is used up')
  assert.equal(telegram.messages.length, before)
})

test('a plain stop of the service sends nothing, and an old note of a restart that never started is dropped', async () => {
  const c = setup([{ run: true }, { exit: 0 }])
  const before = telegram.messages.length
  const first = spawn(SCRIPT, [], { env: c.env, stdio: 'ignore' })
  const done = exited(first)
  await waitUntil(() => existsSync(join(c.dir, 'state', 'controller.lock', 'claude.pid')))
  assert.equal((await runCommand(SCRIPT, ['--stop'], systemd(c, 'stop'))).status, 0)
  assert.equal(await done, 0)
  assert.equal(telegram.messages.length, before, 'no message for a stop')
  assert.ok(!existsSync(join(c.dir, 'state', 'controller.restarting')))
  assert.doesNotMatch(c.log(), /restart of the service/)

  writeFileSync(join(c.dir, 'state', 'controller.restarting'), `${Math.floor(Date.now() / 1000) - 3600} a restart of the service cc-voice-gateway.service\n`)
  assert.equal((await run(c)).status, 0)
  assert.equal(c.starts().at(-1).restarted, null, 'no ready message for a start an hour later')
  assert.ok(!existsSync(join(c.dir, 'state', 'controller.restarting')))
})

test('a crash sends its own message only; a restart on purpose one that it begins', async () => {
  const before = telegram.messages.length
  const c = setup([{ exit: 1 }, { restart: true }, { exit: 0 }])
  assert.equal((await run(c)).status, 0)
  const sent = telegram.messages.slice(before).map(m => m.text.replace(/^.*?: /, ''))
  assert.equal(sent.length, 2, sent.join('\n'))
  assert.match(sent[0], /^the controller session crashed \(exit code 1\) and starts again in 0\.05 s\. /)
  assert.match(sent[1], /^a restart was requested by voice; the controller restarts now\. /)
})

// --- the shutdown message with the statistics ------------------------------------

const texts = (before, c) => telegram.messages.slice(before).map(m => m.text.replace(/^cc-voice-gateway on [^:]*: /, ''))
const SHUTDOWN_STATS = /\n\nIn 2 h: 2 worker runs \(1 done, 1 failed\), 40 min of work\. 3 voice requests\.\n\nAll time, since \d{4}-\d\d-\d\d \(1 start\): 2 worker runs, 40 min of work\./

test('a restart by voice: "a restart was requested", then the shutdown message with the statistics; quitting sends the shutdown message too', async () => {
  const before = telegram.messages.length
  const c = setup([{ restart: true, stats: true }, { exit: 0, stats: true }])
  assert.equal((await run(c)).status, 0)
  const sent = texts(before, c)
  assert.equal(sent.length, 3, sent.join('\n---\n'))
  assert.match(sent[0], /^a restart was requested by voice; the controller restarts now\. Confirm the development channel at the terminal/)
  assert.match(sent[1], /^the gateway is shutting down now for the restart\. Its statistics:/)
  assert.match(sent[1], SHUTDOWN_STATS)
  assert.match(sent[1], /\n\nA message follows when it is ready again\.$/)
  assert.match(sent[2], /^the gateway is shutting down now \(the controller session was ended at the terminal\)\. Its statistics:/)
  // The next gateway sends the third of the restart: that the controller is ready again.
  assert.equal(c.starts()[1].restarted, 'a restart requested by voice')
  assert.match(c.log(), /watchdog: telegram: sent the shutdown message with the statistics/)
})

test('a restart of the service: --stop says it was requested, the stopping watchdog sends the statistics; a plain stop only the statistics', async () => {
  const c = setup([{ run: true, stats: true }, { exit: 0 }])
  let before = telegram.messages.length
  const first = spawn(SCRIPT, [], { env: c.env, stdio: 'ignore' })
  const done = exited(first)
  await waitUntil(() => existsSync(join(c.dir, 'state', 'controller.lock', 'claude.pid')))
  assert.equal((await runCommand(SCRIPT, ['--stop'], systemd(c, 'restart'))).status, 0)
  assert.equal(await done, 0)
  let sent = texts(before, c)
  assert.equal(sent.length, 2, sent.join('\n---\n'))
  assert.match(sent[0], /^a restart of the service cc-voice-gateway\.service was requested; the controller restarts now\./)
  assert.match(sent[1], /^the gateway is shutting down now for the restart\. Its statistics:/)
  assert.ok(existsSync(join(c.dir, 'state', 'controller.restarting')), 'the note stays for the next watchdog')

  // The next watchdog's session quits before its gateway saved anything: no message.
  before = telegram.messages.length
  assert.equal((await run(c)).status, 0)
  assert.equal(telegram.messages.length, before)
  assert.match(c.log(), /watchdog: statistics: none saved by a gateway of this session/)

  const stop = setup([{ run: true, stats: true }])
  before = telegram.messages.length
  const again = spawn(SCRIPT, [], { env: stop.env, stdio: 'ignore' })
  const ended = exited(again)
  await waitUntil(() => existsSync(join(stop.dir, 'state', 'controller.lock', 'claude.pid')))
  assert.equal((await runCommand(SCRIPT, ['--stop'], systemd(stop, 'stop'))).status, 0)
  assert.equal(await ended, 0)
  sent = texts(before, stop)
  assert.equal(sent.length, 1, sent.join('\n---\n'))
  assert.match(sent[0], /^the gateway is shutting down now \(the service cc-voice-gateway\.service was stopped\)\. Its statistics:/)
  assert.match(sent[0], SHUTDOWN_STATS)
})

test('a stop at the computer: the statistics, without who stopped it; a crash keeps its one message; an older file says nothing', async () => {
  const c = setup([{ run: true, stats: true }])
  let before = telegram.messages.length
  const first = spawn(SCRIPT, [], { env: c.env, stdio: 'ignore' })
  const done = exited(first)
  await waitUntil(() => existsSync(join(c.dir, 'state', 'controller.lock', 'claude.pid')))
  assert.equal((await run(c, ['--stop'])).status, 0)
  assert.equal(await done, 0)
  let sent = texts(before, c)
  assert.deepEqual(sent.map(text => text.split('\n')[0]), ['the gateway is shutting down now (stopped at the computer). Its statistics:'])

  before = telegram.messages.length
  const crash = setup([{ exit: 1, stats: true }, { exit: 0 }])
  assert.equal((await run(crash)).status, 0)
  sent = texts(before, crash)
  assert.equal(sent.length, 1, sent.join('\n---\n'))
  assert.match(sent[0], /^the controller session crashed \(exit code 1\)/)

  // The statistics of a gateway of another session: not this one's.
  before = telegram.messages.length
  const stale = setup([{ exit: 0 }])
  mkdirSync(join(stale.dir, 'state'), { recursive: true })
  writeFileSync(join(stale.dir, 'state', 'stats.json'), JSON.stringify({ ...JSON.parse(readFileSync(STATS, 'utf8')), session: 1 }))
  assert.equal((await run(stale)).status, 0)
  assert.equal(telegram.messages.length, before)
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
  // launchd's tmux runs the script: here a bash called tmux, which stays its
  // parent. Like tmux, which sets the environment of what it starts itself, it
  // hands the script launchd's name with env: on macOS what a shell forks
  // finds XPC_SERVICE_NAME set to 0.
  const tmux = join(TMP, 'tmux-bin', 'tmux')
  mkdirSync(dirname(tmux), { recursive: true })
  symlinkSync(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find(existsSync), tmux)
  const viaTmux = (c, args = '') =>
    spawn(tmux, ['-c', `env XPC_SERVICE_NAME="$XPC_SERVICE_NAME" "$0"${args}; exit $?`, SCRIPT], { env: c.env, stdio: 'ignore' })

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
