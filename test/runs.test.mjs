// When a worker run has ended: when every process of it has, not when its
// output shows a result. Claude Code can answer a turn of its own first (the
// notification of a background task left over in the session it resumes),
// write a result for it, and go on with the task in the same process; a run
// can leave servers and tests running, in process groups of their own, or
// with init as their parent. Until all of that is gone the run counts as
// running: nothing else starts in its checkout, the rules see what it does,
// and stop and the kill switch end all of it.
//
// Workers run here without the gateway, on a temporary git repository, with a
// stand-in for claude that writes stream-json and starts processes as told.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-runs-')))
const BIN = join(TMP, 'bin')
const PIDS = join(TMP, 'pids.jsonl') // every process the stand-in starts, to check and to clear up

process.env.VOICE_GW_LOG_FILE = ''
process.env.VOICE_GW_SECRETS_DIR = join(TMP, 'no-secrets')
const { Workers } = await import('../src/workers.mjs')
const { RunGuard } = await import('../src/guard.mjs')
const runners = await import('../src/runners.mjs')

const LINUX = existsSync('/proc/self/stat')

// The stand-in for claude. Words in the task:
//   EARLY     first a turn of its own, as on a resume with a left-over
//             background task: a result for it, then the task, then its result
//   OUTSIDE   in the task's turn, a command that writes outside the checkout
//   TREE      starts a child in its group, one in a session of its own, one
//             without its environment, and an orphan whose parent ends
//   LEAVE     leaves a server running in a session of its own when it ends
//   LINGER    gives its result and stays, without a word
//   SLOW      takes long before its result
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const { spawn } = require('child_process')
const input = fs.readFileSync(0, 'utf8')
const args = process.argv.slice(2)
const session_id = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1]
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
const note = (name, pid) => fs.appendFileSync(process.env.FAKE_PIDS, JSON.stringify({ name, pid, task: process.env.VOICE_GW_TASK }) + '\\n')
const forever = 'setInterval(() => {}, 1000)'
const keep = (name, options) => {
  const child = spawn(process.execPath, ['-e', forever], { stdio: 'ignore', ...options })
  note(name, child.pid)
  child.unref()
  return child
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
note('claude', process.pid)
;(async () => {
  if (/EARLY/.test(input)) {
    out({ type: 'system', subtype: 'task_notification', status: 'stopped', summary: "Background shell command didn't finish before the previous session ended" })
    out({ type: 'system', subtype: 'init' })
    out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, origin: { kind: 'task-notification' } })
    await wait(3000)
  }
  out({ type: 'system', subtype: 'init' })
  if (/OUTSIDE/.test(input)) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo x > /etc/voice-gw-outside' } }] } })
  }
  if (/TREE/.test(input)) {
    keep('child')
    keep('session', { detached: true })
    keep('bare', { env: {} })
    // An orphan: its parent starts it in a session of its own and ends.
    const parent = spawn(process.execPath, ['-e', \`
      const c = require('child_process').spawn(process.execPath, ['-e', \${JSON.stringify(forever)}], { detached: true, stdio: 'ignore' })
      require('fs').appendFileSync(process.env.FAKE_PIDS, JSON.stringify({ name: 'orphan', pid: c.pid, task: process.env.VOICE_GW_TASK }) + '\\\\n')
      c.unref()
    \`], { stdio: 'ignore', detached: true })
    await new Promise(resolve => parent.on('exit', resolve))
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } })
  await wait(/SLOW|TREE/.test(input) ? 60000 : 100)
  if (/LEAVE/.test(input)) keep('server', { detached: true })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'The real result.' })
  if (/LINGER/.test(input)) setInterval(() => {}, 1000)
})()
`

before(() => {
  mkdirSync(BIN)
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  writeFileSync(join(BIN, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(BIN, 'claude'), 0o755)
  chmodSync(join(BIN, 'gh'), 0o755)
  process.env.FAKE_PIDS = PIDS
})

// Whatever a failed test left running.
after(() => {
  for (const { pid } of started()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  rmSync(TMP, { recursive: true, force: true })
})

const started = () =>
  existsSync(PIDS)
    ? readFileSync(PIDS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []
const pidsOf = task => started().filter(entry => entry.task === task.id)
const pidOf = (task, name) => started().find(entry => entry.task === task.id && entry.name === name)?.pid

function isAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // A zombie has ended; its parent has not looked yet.
  try {
    return !/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return !LINUX
  }
}

// The run's output has the result of the turn of its own; then a poll or two.
async function afterEarlyResult(task) {
  await until(() => existsSync(task.file) && readFileSync(task.file, 'utf8').includes('"kind":"task-notification"'))
  await new Promise(resolve => setTimeout(resolve, 1100))
}

async function until(predicate, ms = 10000) {
  for (const begun = Date.now(); Date.now() - begun < ms; await new Promise(resolve => setTimeout(resolve, 25))) {
    const value = predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

let count = 0

// A folder of repositories with "alpha" in it, and Workers on it. Each
// finished run is reported at once, as the gateway does it.
function setup(options = {}) {
  const base = join(TMP, `case${++count}`)
  const root = join(base, 'Developer')
  const dir = join(root, 'alpha')
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const stateDir = join(base, 'state')
  const make = () => {
    const workers = new Workers({ root, stateDir, claudeBin: join(BIN, 'claude'), ghBin: join(BIN, 'gh'), killAfterMs: 1000, ...options })
    workers.on('finished', task => workers.markReported(task))
    return workers
  }
  const workers = make()
  const dispatch = (task, extra = {}) => workers.dispatch({ worker: 'alpha', task, words: 'the words', ...extra })
  return { root, dir, stateDir, workers, make, dispatch }
}

test('the workspace layer: repositories are its one kind, named by their folder; a record without a kind is one', async () => {
  const { workers, dispatch } = setup()
  try {
    assert.deepEqual(Object.keys(workers.kinds), ['repo'])
    assert.equal(workers.workspace('alpha').kind, 'repo')
    assert.equal(workers.workspace('scratch/new'), null, 'a name with a slash is no folder name')
    assert.deepEqual(await workers.known('scratch/new'), ['alpha'], 'checked against the repositories, as before')
    assert.equal((await workers.dispatch({ worker: 'scratch/new', task: 'x', words: 'the words' })).status, 'unknown')
    assert.deepEqual(workers.runners(), [workers.runner])
    const { task } = await dispatch('Count the files.')
    assert.equal(task.kind, 'repo')
    assert.equal(task.container, null, 'on this computer')
    assert.equal(workers.runnerOf(task), workers.runner)
    assert.equal(workers.runnerOf({ repo: 'alpha' }), workers.runner, 'a record of an older version')
    await until(() => task.state !== 'running')
  } finally {
    workers.close()
  }
})

test('a result before the task does not end the run: it ends when its process has, with the result of its task', async () => {
  const { workers, dispatch } = setup()
  try {
    const ended = []
    workers.on('ended', task => ended.push({ state: task.state, alive: isAlive(task.pid) }))
    const first = await dispatch('EARLY: give the vehicles their own speeds.')
    assert.equal(first.status, 'started')
    const task = first.task
    // The result of its own turn is there, and the process goes on.
    await afterEarlyResult(task)
    assert.equal(task.state, 'running', 'an early result does not end the run')
    assert.ok(isAlive(task.pid))
    assert.equal(workers.waiting('alpha'), 'busy')
    // A second task waits for it, in the same checkout.
    const second = await dispatch('Then count the files.')
    assert.equal(second.status, 'queued')
    assert.equal(second.reason, 'busy')
    assert.equal(second.task, task)

    await until(() => task.state !== 'running')
    assert.equal(task.state, 'done')
    assert.equal(task.result, 'The real result.')
    assert.deepEqual(ended[0], { state: 'done', alive: false }, 'ended only once its process had')
    // Only then the queued task starts.
    const next = await until(() => workers.state.tasks.find(t => t.queued === second.entry.id))
    assert.ok(next.startedAt >= task.finishedAt)
    await until(() => next.state !== 'running')
  } finally {
    workers.close()
  }
})

test('the rules see what a run does after an early result', async () => {
  const { workers, dispatch } = setup()
  const tripped = []
  const guard = new RunGuard({
    workers,
    runner: workers.runner,
    killswitch: { trip: event => tripped.push(event) },
    ghBin: join(BIN, 'gh'),
    mainCheckSeconds: 3600,
    log: () => {},
  })
  try {
    const { task } = await dispatch('EARLY OUTSIDE: tidy up.')
    await until(() => task.state !== 'running')
    assert.equal(tripped.length, 1)
    assert.match(tripped[0].reason, /^write outside the allowed folders: .*\/etc\/voice-gw-outside/)
  } finally {
    guard.close()
    workers.close()
  }
})

test('a gateway that takes over a run after an early result does not end it either', async () => {
  const { workers, make, dispatch } = setup()
  const { task } = await dispatch('EARLY SLOW: a long task.')
  await until(() => existsSync(task.file) && readFileSync(task.file, 'utf8').includes('"kind":"task-notification"'))
  workers.close() // the gateway restarts; the run goes on
  const next = make() // reads the run's output from its start
  try {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const adopted = next.running().find(t => t.id === task.id)
    assert.ok(adopted, 'still running for the new gateway')
    assert.ok(isAlive(task.pid))
    assert.equal(next.waiting('alpha'), 'busy')
    const stopped = next.stop('alpha')
    assert.ok(await next.ended(stopped))
    assert.equal(stopped.state, 'stopped')
    assert.ok(!isAlive(task.pid))
  } finally {
    next.close()
  }
})

test('stop ends the whole process tree of a run, and the run ends only once all of it is gone', async () => {
  const { workers, dispatch } = setup()
  try {
    const { task } = await dispatch('TREE: start the servers.')
    // The orphan, whose parent is init or a subreaper now, only by its mark (Linux).
    const names = LINUX ? ['claude', 'child', 'session', 'bare', 'orphan'] : ['claude', 'child', 'session', 'bare']
    await until(() => names.every(name => pidOf(task, name)))
    const pids = pidsOf(task).filter(entry => names.includes(entry.name))
    for (const { name, pid } of pids) assert.ok(isAlive(pid), `${name} runs`)
    workers.stop('alpha')
    assert.equal(task.state, 'running', 'stopping: its processes are not gone yet')
    assert.ok(task.stopping)
    assert.equal(workers.waiting('alpha'), 'busy')
    assert.ok(await workers.ended(task))
    assert.equal(task.state, 'stopped')
    for (const { name, pid } of pids) assert.ok(!isAlive(pid), `${name} is gone`)
  } finally {
    workers.close()
  }
})

test('the kill switch ends every process of every run, also one that gave an early result', async () => {
  const { workers, dispatch } = setup()
  try {
    const { task } = await dispatch('EARLY TREE: start the servers.')
    const names = LINUX ? ['claude', 'child', 'session', 'bare', 'orphan'] : ['claude', 'child', 'session', 'bare']
    await until(() => names.every(name => pidOf(task, name)))
    assert.equal(task.state, 'running')
    const stopped = workers.stopAll('kill switch (rule)')
    assert.deepEqual(stopped.map(t => t.id), [task.id])
    await until(() => task.state !== 'running')
    assert.equal(task.state, 'stopped')
    assert.equal(task.error, 'kill switch (rule)')
    for (const name of names) assert.ok(!isAlive(pidOf(task, name)), `${name} is gone`)
  } finally {
    workers.close()
  }
})

test('what a run leaves running is part of it: the gateway ends it, then the run has ended', async () => {
  const { workers, dispatch } = setup()
  try {
    const ended = []
    workers.on('ended', task => ended.push(isAlive(pidOf(task, 'server'))))
    const { task } = await dispatch('LEAVE: start the dev server.')
    await until(() => task.state !== 'running')
    assert.equal(task.state, 'done', 'its result counts')
    assert.equal(task.result, 'The real result.')
    assert.ok(pidOf(task, 'server'))
    assert.deepEqual(ended, [false], 'the server was gone when the run ended')
  } finally {
    workers.close()
  }
})

test('a run that gave its result and does not end is ended by the gateway after a while', async () => {
  const { workers, dispatch } = setup({ resultGraceMs: 1500 })
  try {
    const { task } = await dispatch('LINGER: look around.')
    await until(() => task.resultSeen)
    assert.equal(task.state, 'running')
    await until(() => task.state !== 'running')
    assert.equal(task.state, 'done')
    assert.equal(task.result, 'The real result.')
    assert.ok(!isAlive(task.pid))
  } finally {
    workers.close()
  }
})

test('a process with a recorded run id that is another process now is neither followed nor signalled', { skip: !LINUX }, async () => {
  const { workers, stateDir } = setup()
  workers.close()
  // A process that got the id of a run's process after it ended.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
  try {
    const record = {
      id: 'tgon', repo: 'alpha', task: 'x', words: 'x', state: 'running', pid: other.pid, pidStart: `${runners.startOf(other.pid).split(':')[0]}:1`,
      mark: 'not-this-one', sessionId: 's', startedAt: Date.now(), finishedAt: null, file: join(stateDir, 'tasks', 'tgon.jsonl'),
      errFile: join(stateDir, 'tasks', 'tgon.err'), steps: [], pulls: [], reported: false,
    }
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'workers.json'), JSON.stringify({ repos: {}, tasks: [record] }))
    const next = new Workers({ root: join(stateDir, '..', 'Developer'), stateDir, claudeBin: join(BIN, 'claude'), killAfterMs: 1000 })
    try {
      const task = next.state.tasks[0]
      next.stop('alpha')
      assert.ok(await next.ended(task))
      assert.equal(task.state, 'stopped')
      assert.ok(isAlive(other.pid), 'not signalled: it is not the run')
    } finally {
      next.close()
    }
  } finally {
    other.kill('SIGKILL')
  }
})

test('worker processes in a checkout that no run accounts for are ended, and nothing starts there until they are gone', { skip: !LINUX }, async () => {
  const { dir, root, workers, dispatch } = setup()
  // Left by a run whose record was lost, with its marks.
  const env = { ...process.env, VOICE_GW_RUN: 'lost-run', VOICE_GW_TASK: 'tlst', VOICE_GW_REPO: dir }
  const stray = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { env, stdio: 'ignore', detached: true })
  // One in another folder of repositories is not this gateway's.
  const elsewhere = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...env, VOICE_GW_RUN: 'other', VOICE_GW_REPO: join(TMP, 'elsewhere', 'alpha') },
    stdio: 'ignore',
    detached: true,
  })
  try {
    await until(() => readFileSync(`/proc/${stray.pid}/environ`, 'utf8').includes('lost-run'))
    workers.swept = true // as after the start of the gateway: it is found when a run is to start
    const held = await dispatch('Count the files.')
    assert.equal(held.status, 'queued', 'not started next to it')
    assert.equal(held.reason, 'busy')
    assert.equal(held.strays, true)
    assert.equal(workers.waiting('alpha'), 'busy')
    // It ignores SIGTERM: SIGKILL follows, then the task starts.
    const next = await until(() => workers.state.tasks.find(t => t.queued === held.entry.id))
    assert.ok(!isAlive(stray.pid))
    await until(() => next.state !== 'running')
    assert.ok(isAlive(elsewhere.pid), 'another folder of repositories is not touched')

    // A gateway that starts finds them too.
    const again = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...env, VOICE_GW_RUN: 'lost-again' }, stdio: 'ignore', detached: true })
    await until(() => readFileSync(`/proc/${again.pid}/environ`, 'utf8').includes('lost-again'))
    const fresh = new Workers({ root, stateDir: join(root, '..', 'state'), claudeBin: join(BIN, 'claude'), killAfterMs: 1000 })
    try {
      await until(() => !isAlive(again.pid))
    } finally {
      fresh.close()
    }
  } finally {
    workers.close()
    stray.kill('SIGKILL')
    elsewhere.kill('SIGKILL')
  }
})

test('HostRunner.stop leaves alone what is not the run', { skip: !LINUX }, () => {
  const runner = new runners.HostRunner(TMP)
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
  try {
    // A run whose process is gone, with the id of the test's own process group.
    const gone = { pid: process.pid, pidStart: 'another-boot:1', mark: 'nothing-has-this' }
    assert.equal(runner.alive(gone), false)
    assert.deepEqual(runner.processes(gone), [], 'not the gateway, nor what it runs under')
    assert.ok(isAlive(other.pid))
  } finally {
    other.kill('SIGKILL')
  }
})

