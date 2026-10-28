// Workers: the controller hands repository work to headless Claude Code runs.
//
// A fake `claude` stands in for the real one: it logs its arguments, input and
// environment, and writes stream-json like `claude -p --output-format
// stream-json` does. A fake `gh` answers whether a repository is public.
// Temporary git repositories play ~/Developer.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
// Resolved: on macOS the temporary folder is behind a symlink (/var is
// /private/var), and the stand-in for claude reports the resolved cwd.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-workers-')))
const ROOT = join(TMP, 'Developer')
const BIN = join(TMP, 'bin')
const CALLS = join(TMP, 'claude-calls.jsonl')

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  cwd: process.cwd(), args, input, pid: process.pid,
  claudecode: process.env.CLAUDECODE ?? null,
  socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
}) + '\\n')
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
out({ type: 'system', subtype: 'init' })
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } })
setTimeout(() => {
  if (/FAIL/.test(input)) { process.stderr.write('boom: something broke\\n'); process.exit(1) }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the tests.' }] } })
  const result = /QUESTION/.test(input) ? 'Should I also update the docs?' : 'All 12 tests pass. Nothing changed.'
  out({ type: 'result', subtype: 'success', is_error: false, result })
}, /SLOW/.test(input) ? 4000 : 50)
`

const FAKE_GH = `#!/bin/sh
case "$*" in *public*) echo PUBLIC ;; *) echo PRIVATE ;; esac
`

let gw // the running gateway with its two clients
const waiters = new Set()
const notify = () => waiters.forEach(check => check())

function waitUntil(predicate, ms = 8000) {
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

function repo(name, { origin, dirty = false } = {}) {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  run('add', '.')
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')
  if (origin) run('remote', 'add', 'origin', origin)
  if (dirty) writeFileSync(join(dir, 'notes.txt'), 'not committed\n')
}

async function startGateway() {
  const port = await freePort()
  const events = []
  const claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => {
      events.push(params)
      notify()
    },
  )
  await claudeCode.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [GATEWAY],
      env: {
        ...process.env,
        VOICE_GW_PORT: String(port),
        VOICE_GW_SECRETS_DIR: join(TMP, 'secrets'),
        VOICE_GW_STATE_DIR: join(TMP, 'state'),
        VOICE_GW_WORKER_ROOT: ROOT,
        VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
        VOICE_GW_GH_BIN: join(BIN, 'gh'),
        VOICE_GW_MAX_WORKERS: '2',
        VOICE_GW_MAX_WAIT: '3',
        VOICE_GW_DEFAULT_WAIT: '2',
        VOICE_GW_LOG_FILE: '',
        FAKE_CLAUDE_LOG: CALLS,
        // As inside a Claude Code session; a worker must not inherit these.
        CLAUDECODE: '1',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/controller.sock',
      },
      stderr: 'ignore',
    }),
  )
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await new Promise(r => setTimeout(r, 50))
    }
  }
  const { access_token } = await adminRequest(join(TMP, 'secrets', 'admin.sock'), 'POST', '/token', { name: 'test' })
  const voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await voice.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    }),
  )
  return { claudeCode, voice, events }
}

async function stopGateway() {
  await gw.voice.close()
  await gw.claudeCode.close()
}

before(async () => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  writeFileSync(join(BIN, 'gh'), FAKE_GH)
  chmodSync(join(BIN, 'claude'), 0o755)
  chmodSync(join(BIN, 'gh'), 0o755)
  repo('alpha', { origin: 'git@github.com:acme/alpha.git' })
  repo('beta-public', { origin: 'https://github.com/acme/beta-public.git' })
  repo('gamma')
  repo('dirty', { origin: 'git@github.com:acme/dirty.git', dirty: true })
  mkdirSync(join(ROOT, 'not-a-repo'))
  gw = await startGateway()
})

after(async () => {
  await stopGateway()
  rmSync(TMP, { recursive: true, force: true })
})

// --- helpers ------------------------------------------------------------------

const text = result => result.content.map(c => c.text).join('\n')

async function controller(name, args = {}) {
  const result = await gw.claudeCode.callTool({ name, arguments: args })
  return { text: text(result), isError: result.isError }
}

const voiceCall = async (name, args = {}) => text(await gw.voice.callTool({ name, arguments: args }))

const calls = () =>
  readFileSync(CALLS, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
const lastCall = () => calls().at(-1)
const arg = (call, name) => call.args[call.args.indexOf(name) + 1]

async function dispatch(worker, task, extra = {}) {
  const out = await controller('dispatch', { worker, task, words: task, ...extra })
  return { ...out, id: /task=(t[a-z0-9]{3})/.exec(out.text)?.[1] }
}

const workerEvent = (worker, task) =>
  waitUntil(() => gw.events.find(e => e.meta?.worker === worker && e.meta?.task === task))

// --- tests --------------------------------------------------------------------

test('list_workers: git repositories only, with origin, visibility, branch and changes', async () => {
  const { text: list } = await controller('list_workers')
  assert.match(list, /^\[workers=4 running=0 max=2\]/)
  assert.match(list, /^alpha: acme\/alpha, private, branch main, clean, idle$/m)
  assert.match(list, /^beta-public: acme\/beta-public, public, branch main, clean, idle$/m)
  assert.match(list, /^gamma: no remote, branch main, clean, idle$/m)
  assert.match(list, /^dirty: acme\/dirty, private, branch main, 1 uncommitted file, idle$/m)
  assert.doesNotMatch(list, /not-a-repo/)
})

test('dispatch runs claude -p in the checkout; the result reaches the controller, then the driver as news', async () => {
  const started = await controller('dispatch', {
    worker: 'alpha',
    task: 'Run the test suite and report the result.',
    words: 'Lass die Tests in alpha laufen',
  })
  assert.match(started.text, /^\[dispatch=started worker=alpha task=t[a-z0-9]{3} session=new\] Started on branch main/)
  const id = /task=(t[a-z0-9]{3})/.exec(started.text)[1]

  const event = await workerEvent('alpha', id)
  assert.equal(event.meta.outcome, 'done')
  assert.match(event.content, /^Worker alpha finished task t[a-z0-9]{3}: done after/)
  assert.match(event.content, /Result: All 12 tests pass\. Nothing changed\./)

  const call = lastCall()
  assert.equal(call.cwd, join(ROOT, 'alpha'))
  for (const flag of ['-p', '--verbose', '--strict-mcp-config', '--session-id', '--append-system-prompt']) {
    assert.ok(call.args.includes(flag), flag)
  }
  assert.equal(arg(call, '--output-format'), 'stream-json')
  assert.equal(arg(call, '--permission-mode'), 'bypassPermissions')
  assert.equal(arg(call, '--permission-prompts'), 'none')
  const deny = JSON.parse(arg(call, '--settings')).permissions.deny
  for (const rule of ['mcp__claude_ai_*', 'SendMessage', 'AskUserQuestion']) assert.ok(deny.includes(rule), rule)
  assert.match(arg(call, '--append-system-prompt'), /voice\/<short-name>/)
  assert.match(call.input, /^Run the test suite and report the result\./)
  assert.match(call.input, /The driver's own words: "Lass die Tests in alpha laufen"/)
  assert.match(call.input, /Repository: acme\/alpha \(private\)/)
  assert.match(call.input, /Starting branch: main/)
  assert.match(call.input, /Uncommitted files before you start: none/)
  assert.equal(call.claudecode, null, 'no CLAUDECODE from the controller session')
  assert.equal(call.socket, null, "no access to the controller's messaging socket")

  const status = await controller('worker_status', { worker: 'alpha' })
  assert.match(status.text, new RegExp(`^\\[worker=alpha state=done task=${id} took=`))
  assert.match(status.text, /Last steps: Bash npm test/)
  assert.match(status.text, /Result: All 12 tests pass/)

  await controller('reply', { request_id: event.meta.request_id, state: 'done', text: 'The tests in alpha pass.' })
  const news = await voiceCall('status')
  assert.match(news, /News from Claude Code \(id=[a-z0-9]{4}\): The tests in alpha pass\./)
  assert.doesNotMatch(await voiceCall('status'), /News from/, 'news is delivered once')
})

test('a follow-up continues the session; fresh starts a new one', async () => {
  const first = await dispatch('gamma', 'Look at the README.')
  await workerEvent('gamma', first.id)
  const session = arg(lastCall(), '--session-id')

  const followUp = await dispatch('gamma', 'Now add a line to it.')
  assert.match(followUp.text, /session=continued/)
  await workerEvent('gamma', followUp.id)
  assert.equal(arg(lastCall(), '--resume'), session)
  assert.ok(!lastCall().args.includes('--session-id'))

  const fresh = await dispatch('gamma', 'Start over.', { fresh: true })
  assert.match(fresh.text, /session=new/)
  await workerEvent('gamma', fresh.id)
  assert.notEqual(arg(lastCall(), '--session-id'), session)
})

test('the prompt says whether the repository is public', async () => {
  const run = await dispatch('beta-public', 'Fix the typo.')
  await workerEvent('beta-public', run.id)
  assert.match(lastCall().input, /Repository: acme\/beta-public \(public\)/)

  const local = await dispatch('gamma', 'Fix the typo.')
  await workerEvent('gamma', local.id)
  assert.match(lastCall().input, /Repository: no remote/)
})

test('uncommitted changes need the driver to say yes first', async () => {
  const before = calls().length
  const refused = await dispatch('dirty', 'Update the README.')
  assert.match(refused.text, /^\[dispatch=dirty worker=dirty files=1\] .*notes\.txt.*allow_dirty=true/)
  assert.equal(calls().length, before, 'no run without the yes')

  const allowed = await dispatch('dirty', 'Update the README.', { allow_dirty: true })
  assert.match(allowed.text, /dispatch=started/)
  await workerEvent('dirty', allowed.id)
  assert.match(lastCall().input, /Uncommitted files before you start: notes\.txt \(not yours, leave them alone\)/)
})

test('on this computer there are no access levels, and a direct push is refused', async () => {
  const before = calls().length
  const refused = await dispatch('alpha', 'Push it straight to main.', { direct: true })
  assert.match(refused.text, /^\[dispatch=refused worker=alpha\] Direct pushes need workers in Docker with access level full\./)
  assert.equal(calls().length, before, 'nothing started')
  const run = await dispatch('gamma', 'Fix the typo.')
  assert.doesNotMatch(run.text, /access=/)
  await workerEvent('gamma', run.id)
  assert.doesNotMatch(lastCall().input, /Access level|Direct push/)
})

test('one run per repository, two at a time; stop ends a run without an event', async () => {
  const slow = await dispatch('alpha', 'SLOW: run everything.')
  assert.match(slow.text, /dispatch=started/)
  assert.match((await dispatch('alpha', 'Something else.')).text, /^\[dispatch=busy worker=alpha task=t/)
  assert.match((await dispatch('gamma', 'SLOW: another run.')).text, /dispatch=started/)
  assert.match((await dispatch('beta-public', 'A third run.')).text, /^\[dispatch=full running=2\]/)
  assert.match((await controller('list_workers')).text, /^alpha: .*running t[a-z0-9]{3} for/m)
  assert.match((await controller('worker_status', { worker: 'alpha' })).text, /state=running/)

  assert.match((await controller('stop_worker', { worker: 'alpha' })).text, /^\[worker=alpha stopped task=t/)
  assert.match((await controller('stop_worker', { worker: 'gamma' })).text, /stopped/)
  assert.match((await controller('stop_worker', { worker: 'gamma' })).text, /Nothing is running there/)
  assert.match((await controller('worker_status', { worker: 'alpha' })).text, /state=stopped/)
  await new Promise(r => setTimeout(r, 1500))
  assert.ok(!gw.events.some(e => e.meta?.task === slow.id), 'the controller stopped it and needs no event')
  for (const call of calls().filter(c => c.input.startsWith('SLOW'))) {
    assert.throws(() => process.kill(call.pid, 0), { code: 'ESRCH' }, 'the run is really gone')
  }
})

test('a failed run reports what went wrong', async () => {
  const run = await dispatch('gamma', 'FAIL: break something.')
  const event = await workerEvent('gamma', run.id)
  assert.equal(event.meta.outcome, 'failed')
  assert.match(event.content, /Problem: boom: something broke/)
})

test('unknown repositories and missing arguments are errors', async () => {
  const unknown = await controller('dispatch', { worker: 'nope', task: 'x', words: 'x' })
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /Known: alpha, beta-public, dirty, gamma/)
  assert.equal((await controller('dispatch', { worker: 'alpha', task: ' ', words: 'x' })).isError, true)
  assert.equal((await controller('worker_status', {})).isError, true)
})

test('news: a waiting get_reply returns with it; questions and late answers count too', async () => {
  // A worker's question while the driver waits for something else.
  const waiting = /id=([a-z0-9]{4})/.exec(await voiceCall('send', { message: 'Something long.' }))[1]
  const run = await dispatch('gamma', 'QUESTION: tidy up.')
  const event = await workerEvent('gamma', run.id)
  const started = Date.now()
  setTimeout(
    () => controller('reply', { request_id: event.meta.request_id, state: 'question', text: 'Update the docs too?' }),
    200,
  )
  const out = await voiceCall('get_reply', { id: waiting, wait_seconds: 3 })
  assert.ok(Date.now() - started < 2500, 'news ends the wait early')
  assert.match(out, /News from Claude Code \(id=[a-z0-9]{4}, a question\): Update the docs too\?/)
  assert.match(out, new RegExp(`send \\(in_reply_to=${event.meta.request_id}\\)`))

  // A correction after the driver already heard "done".
  const id = /id=([a-z0-9]{4})/.exec(await voiceCall('send', { message: 'How many files?' }))[1]
  await controller('reply', { request_id: id, state: 'done', text: 'Three files.' })
  assert.match(await voiceCall('get_reply', { id }), /state=done/)
  await controller('reply', { request_id: id, state: 'done', text: 'Sorry, four files.' })
  assert.match(await voiceCall('status'), /News from Claude Code \(id=[a-z0-9]{4}\): Sorry, four files\./)
})

test('a run survives a gateway restart and reports to the new gateway', async () => {
  const run = await dispatch('alpha', 'SLOW: a long task.')
  await stopGateway()
  gw = await startGateway()
  const event = await workerEvent('alpha', run.id)
  assert.equal(event.meta.outcome, 'done')
  assert.match(event.content, /All 12 tests pass/)
})
