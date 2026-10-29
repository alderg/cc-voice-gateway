// Several runs per repository: the global limit (VOICE_GW_MAX_WORKERS), the
// limit per repository (VOICE_GW_MAX_WORKERS_PER_REPO), the order of the
// queue (parallel, after, behind), further runs in git worktrees of their
// own (with submodules), answers that go back to their run, stop by task,
// the kill switch, runs that go back to the queue with their worktree, and
// a changed limit, at a start and while the gateway runs.
//
// Workers run here without the gateway, on temporary git repositories with
// a bare repository as origin, and a stand-in for claude that logs where it
// ran and waits for the test where its task says HOLD:<name>.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-parallel-')))
const BIN = join(TMP, 'bin')
const CALLS = join(TMP, 'calls.jsonl')
const HOLDS = join(TMP, 'holds')

process.env.VOICE_GW_LOG_FILE = ''
process.env.VOICE_GW_SECRETS_DIR = join(TMP, 'no-secrets')
// The submodules here come from file:// URLs, which git refuses for
// submodules unless told; real ones come from GitHub.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' })
const { Workers, planText, prompt } = await import('../src/workers.mjs')
const { Ledger } = await import('../src/ledger.mjs')
const { Store } = await import('../src/store.mjs')
const { answeredTask } = await import('../src/channel.mjs')
const { RunGuard } = await import('../src/guard.mjs')
const { SettingsWatcher } = await import('../src/live.mjs')

// The stand-in for claude. Words in the task:
//   HOLD:<name>  waits until the file holds/<name> is there
//   COMMIT       commits on voice/<BRANCH or pid>; PUSH: and pushes it
//   LEAVE        leaves a new file uncommitted
//   QUESTION     ends with a question
//   CRASH        ends without a result, unless it resumes ("Resumed:")
//   SLOWONCE     waits for good, unless it resumes
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const input = fs.readFileSync(0, 'utf8')
const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({
  cwd: process.cwd(), input, task: process.env.VOICE_GW_TASK, session: session_id, resumed: args.includes('--resume'),
  rules: arg('--append-system-prompt'),
}) + '\\n')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
const git = (...a) => execFileSync('git', ['-c', 'user.name=W', '-c', 'user.email=w@example.com', ...a], { stdio: 'ignore' })
const resumed = /Resumed: /.test(input)
out({ type: 'system', subtype: 'init' })
;(async () => {
  const hold = /HOLD:(\\w+)/.exec(input)?.[1]
  if (hold) while (!fs.existsSync(path.join(process.env.FAKE_HOLDS, hold))) await new Promise(r => setTimeout(r, 50))
  if (/SLOWONCE/.test(input) && !resumed) await new Promise(() => setInterval(() => {}, 1000))
  if (/CRASH/.test(input) && !resumed) process.exit(3)
  const name = /BRANCH:([\\w-]+)/.exec(input)?.[1] ?? 'b' + process.pid
  if (/COMMIT|PUSH/.test(input)) {
    try { git('checkout', '-q', '-b', 'voice/' + name) } catch { git('checkout', '-q', 'voice/' + name) }
    fs.writeFileSync('change-' + name + '-' + process.pid + '.txt', 'x')
    git('add', '.')
    git('commit', '-q', '-m', 'change')
    if (/PUSH/.test(input)) git('push', '-q', 'origin', 'voice/' + name)
  }
  if (/LEAVE/.test(input)) fs.writeFileSync('left-over.txt', 'x')
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: /QUESTION/.test(input) ? 'Which one, A or B?' : 'Done.' })
})()
`

before(() => {
  mkdirSync(BIN)
  mkdirSync(HOLDS)
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  writeFileSync(join(BIN, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(BIN, 'claude'), 0o755)
  chmodSync(join(BIN, 'gh'), 0o755)
  process.env.FAKE_CALLS = CALLS
  process.env.FAKE_HOLDS = HOLDS
})

after(() => {
  // Whatever still waits ends.
  for (let i = 0; i < 100; i++) writeFileSync(join(HOLDS, `h${i}`), '')
  rmSync(TMP, { recursive: true, force: true })
})

const calls = () =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []
const callOf = id => calls().findLast(call => call.task === id)
const release = name => writeFileSync(join(HOLDS, name), '')

async function until(predicate, ms = 15000) {
  for (const begun = Date.now(); Date.now() - begun < ms; await new Promise(resolve => setTimeout(resolve, 25))) {
    const value = predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim()

let count = 0
let holdCount = 0
const hold = () => `h${holdCount++}`

// A folder of repositories with alpha (and beta) cloned from bare origins;
// sub: alpha has a submodule "lib", shallow, initialised in the checkout or
// not. Workers on it, reported as the gateway does it: the audit, then the
// result is marked reported.
function setup({ sub = null, repos = ['alpha'], ...options } = {}) {
  const base = join(TMP, `case${++count}`)
  const root = join(base, 'Developer')
  const remotes = join(base, 'remotes')
  mkdirSync(root, { recursive: true })
  mkdirSync(remotes, { recursive: true })
  let subRemote = null
  if (sub) {
    subRemote = join(remotes, 'lib.git')
    const work = join(base, 'lib-work')
    mkdirSync(work)
    git(work, 'init', '-q', '-b', 'main')
    writeFileSync(join(work, 'lib.txt'), 'lib\n')
    git(work, 'add', '.')
    git(work, 'commit', '-q', '-m', 'lib')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', subRemote])
    git(work, 'push', '-q', subRemote, 'main')
  }
  for (const name of repos) {
    const origin = join(remotes, `${name}.git`)
    const work = join(base, `${name}-work`)
    mkdirSync(work)
    git(work, 'init', '-q', '-b', 'main')
    writeFileSync(join(work, 'a.txt'), 'a\n')
    git(work, 'add', '.')
    git(work, 'commit', '-q', '-m', 'init')
    if (sub && name === 'alpha') {
      git(work, 'submodule', 'add', '-q', `file://${subRemote}`, 'lib')
      git(work, 'config', '-f', '.gitmodules', 'submodule.lib.shallow', 'true')
      git(work, 'add', '.')
      git(work, 'commit', '-q', '-m', 'lib')
    }
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    git(work, 'push', '-q', origin, 'main')
    execFileSync('git', ['clone', '-q', origin, join(root, name)])
    if (sub === 'initialised' && name === 'alpha') git(join(root, name), 'submodule', 'update', '-q', '--init', '--depth', '1')
  }
  const stateDir = join(base, 'state')
  const ledger = new Ledger({ log: () => {} })
  const killswitch = { locked: false, state: null }
  const make = (more = {}) => {
    const workers = new Workers({
      root,
      stateDir,
      ledger,
      killswitch,
      claudeBin: join(BIN, 'claude'),
      ghBin: join(BIN, 'gh'),
      killAfterMs: 1000,
      ...options,
      ...more,
    })
    const reporting = new Set()
    workers.on('finished', async task => {
      if (reporting.has(task.id)) return
      reporting.add(task.id)
      await workers.audit(task)
      workers.markReported(task)
    })
    return workers
  }
  const workers = make()
  const dispatch = (task, extra = {}) => workers.dispatch({ worker: 'alpha', task, words: 'the words', ...extra })
  return { base, root, remotes, subRemote, stateDir, ledger, killswitch, workers, make, dispatch, dir: join(root, 'alpha') }
}

const ended = task => until(() => task.state !== 'running' && task.reported)
const worktreesOf = (root, repo = 'alpha') => join(root, '.voice-worktrees', repo)

// --- the limits -------------------------------------------------------------------------

test('one run per repository by default, as before: parallel and after change nothing, and no worktree is made', async () => {
  const { root, dir, workers, dispatch } = setup()
  try {
    assert.equal(workers.maxPerRepo, 1)
    const a = hold()
    const first = await dispatch(`HOLD:${a} first`)
    assert.equal(first.status, 'started')
    assert.equal(first.task.worktree, undefined)
    const second = await dispatch('second', { parallel: true })
    assert.equal(second.status, 'queued')
    assert.equal(second.reason, 'busy')
    const third = await dispatch('third')
    assert.equal(third.reason, 'busy')
    assert.equal(third.position, 2)
    release(a)
    await ended(first.task)
    const next = await until(() => workers.state.tasks.find(t => t.queued === second.entry.id))
    await ended(next)
    const last = await until(() => workers.state.tasks.find(t => t.queued === third.entry.id))
    await ended(last)
    for (const task of [first.task, next, last]) assert.equal(callOf(task.id).cwd, dir, 'in the checkout')
    assert.ok(!existsSync(join(root, '.voice-worktrees')), 'no worktree')
  } finally {
    workers.close()
  }
})

test('the limits: every run of a repository counts toward the global one; the one per repository holds the rest', async () => {
  const { root, dir, workers, dispatch } = setup({ repos: ['alpha', 'beta'], maxRuns: 3, maxPerRepo: 2 })
  try {
    const [a, b, c] = [hold(), hold(), hold()]
    const one = await dispatch(`HOLD:${a} one`)
    assert.equal((await until(() => callOf(one.task.id))).cwd, dir)
    const two = await dispatch(`HOLD:${b} two`, { parallel: true })
    assert.equal(two.status, 'started')
    assert.equal(two.task.worktree, two.task.id, 'a worktree of its own, named after the task')
    assert.deepEqual(two.others.map(t => t.id), [one.task.id])
    const call = await until(() => callOf(two.task.id))
    assert.equal(call.cwd, join(worktreesOf(root), two.task.id))
    assert.notEqual(call.session, callOf(one.task.id).session, 'a session of its own')
    const three = await dispatch('three', { parallel: true })
    assert.equal(three.status, 'queued')
    assert.equal(three.reason, 'limit', 'two runs in alpha, as many as one repository may have')
    const beta = await workers.dispatch({ worker: 'beta', task: `HOLD:${c} beta`, words: 'the words' })
    assert.equal(beta.status, 'started', 'the third run slot')
    const full = await workers.dispatch({ worker: 'beta', task: 'beta two', words: 'the words', parallel: true })
    assert.equal(full.reason, 'full', 'three runs in all')
    assert.match(await workers.listText(), /^\[workers=2 running=3 queued=2 max=3 per_repo=2\]/)
    assert.match(await workers.listText(), new RegExp(`^alpha: .*running ${one.task.id} for .*, running ${two.task.id} in a worktree for`, 'm'))
    release(b)
    await ended(two.task)
    const next = await until(() => workers.state.tasks.find(t => t.queued === three.entry.id))
    assert.ok(next.worktree, 'the checkout is still taken: a worktree')
    await ended(next)
    for (const name of [a, c]) release(name)
    await until(() => workers.state.tasks.find(t => t.queued === full.entry.id && t.state !== 'running' && t.reported))
    await ended(one.task)
    await until(() => !workers.running().length)
  } finally {
    workers.close()
  }
})

test('the order of the queue: behind every run and queued task by default, parallel next to them, after only what it names', async () => {
  const { workers, dispatch } = setup({ maxRuns: 5, maxPerRepo: 3 })
  try {
    const [a, b, c, d] = [hold(), hold(), hold(), hold()]
    const one = await dispatch(`HOLD:${a} one`)
    const behind = await dispatch(`HOLD:${b} behind`)
    assert.equal(behind.status, 'queued')
    assert.equal(behind.reason, 'busy')
    assert.deepEqual(behind.entry.behind, [one.task.id])
    assert.deepEqual(behind.runs.map(t => t.id), [one.task.id], 'the runs there, for the controller')
    const parallel = await dispatch(`HOLD:${c} parallel`, { parallel: true })
    assert.equal(parallel.status, 'started', 'it starts next to them at once')
    const later = await dispatch(`HOLD:${d} later`, { after: behind.entry.id })
    assert.equal(later.status, 'queued')
    assert.equal(later.reason, 'after')
    assert.deepEqual(later.entry.after, [behind.entry.id])
    const unknown = await dispatch('nothing', { after: 'qzzz' })
    assert.equal(unknown.status, 'order')
    assert.match(unknown.problems[0], /qzzz is no queued task of alpha/)

    release(c)
    await ended(parallel.task)
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.ok(!workers.state.tasks.some(t => t.queued === behind.entry.id), 'behind waits for the first run')
    assert.ok(!workers.state.tasks.some(t => t.queued === later.entry.id), 'after waits for what it names')
    release(a)
    const second = await until(() => workers.state.tasks.find(t => t.queued === behind.entry.id))
    assert.ok(second.startedAt >= one.task.finishedAt)
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.ok(!workers.state.tasks.some(t => t.queued === later.entry.id), 'its task is still running')
    release(b)
    await ended(second)
    const last = await until(() => workers.state.tasks.find(t => t.queued === later.entry.id))
    assert.ok(last.startedAt >= second.finishedAt)
    release(d)
    await ended(last)
  } finally {
    workers.close()
  }
})

test('order_queue: parallel, after, back behind; no task waits for itself, and one at a time keeps the order', async () => {
  const { workers, dispatch } = setup({ maxRuns: 5, maxPerRepo: 1 })
  try {
    const a = hold()
    const one = await dispatch(`HOLD:${a} one`)
    const x = (await dispatch('x')).entry
    const y = (await dispatch('y')).entry
    assert.deepEqual(y.behind, [one.task.id, x.id])
    // y waits for x already: x cannot wait for y.
    const loop = workers.order('alpha', x.id, { after: y.id })
    assert.equal(loop.status, 'order')
    assert.match(loop.problems[0], new RegExp(`${y.id} waits for ${x.id} already`))
    assert.equal(workers.order('alpha', 'qzzz', { parallel: true }).status, 'unknown')
    // Marked parallel, y no longer waits for x; then x after y moves behind it.
    const marked = workers.order('alpha', y.id, { parallel: true })
    assert.equal(marked.status, 'ordered')
    assert.equal(marked.effect, false, 'one run per repository: the order only')
    assert.equal(workers.order('alpha', x.id, { after: y.id }).status, 'ordered')
    assert.deepEqual(workers.queued('alpha').map(e => e.id), [y.id, x.id], 'behind what it waits for')
    // Back behind the others.
    workers.order('alpha', y.id, {})
    assert.equal(y.parallel, false)
    assert.equal(y.after, null)
    release(a)
    const first = await until(() => workers.state.tasks.find(t => t.queued === y.id))
    await ended(first)
    const second = await until(() => workers.state.tasks.find(t => t.queued === x.id))
    await ended(second)
  } finally {
    workers.close()
  }
})

// --- worktrees ----------------------------------------------------------------------------

test('a worktree: from the default branch as fetched now, the submodule from the checkout without its URL, gone after a clean run', async () => {
  const { root, dir, base, subRemote, remotes, workers, dispatch } = setup({ sub: 'initialised', maxPerRepo: 2 })
  try {
    // origin moved on since the checkout was cloned: the worktree has it.
    const other = join(base, 'other')
    execFileSync('git', ['clone', '-q', join(remotes, 'alpha.git'), other])
    writeFileSync(join(other, 'b.txt'), 'b\n')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'moved on')
    git(other, 'push', '-q', 'origin', 'main')
    const head = git(other, 'rev-parse', 'HEAD')
    // The submodule's URL is out of reach: only the checkout's module can help.
    renameSync(subRemote, `${subRemote}.away`)

    const a = hold()
    const one = await dispatch(`HOLD:${a} one`)
    const b = hold()
    const two = await dispatch(`HOLD:${b} two`, { parallel: true })
    const wt = join(worktreesOf(root), two.task.id)
    const call = await until(() => callOf(two.task.id))
    assert.equal(call.cwd, wt)
    assert.equal(git(wt, 'rev-parse', 'HEAD'), head, 'from origin/main, fetched just now')
    assert.equal(git(wt, 'branch', '--show-current'), '', 'on a detached HEAD')
    assert.equal(readFileSync(join(wt, 'lib', 'lib.txt'), 'utf8'), 'lib\n', 'the submodule is there')
    assert.equal(git(join(wt, 'lib'), 'remote', 'get-url', 'origin'), `file://${subRemote}`, 'its own URL again')
    assert.equal(git(dir, 'config', '--get', 'submodule.lib.url'), `file://${subRemote}`, "the checkout's config as it was")
    assert.equal(two.task.submodules[0].how, 'from the checkout')
    // What the worker reads: the worktree, and how to rebase, test and push.
    assert.match(call.input, /^- Starting branch: main \(in a worktree of its own, below\)$/m)
    assert.match(call.input, new RegExp(`^- Worktree: you work in a git worktree of your own, ${wt}, made for this task from origin/main, as fetched just now`, 'm'))
    assert.match(call.input, /^- Before you push: git fetch origin, rebase your commits onto origin\/main, and run the repository's tests\. Resolve conflicts yourself/m)
    assert.doesNotMatch(call.rules, /At the end, switch back to the starting branch/)
    assert.match(callOf(one.task.id).rules, /At the end, switch back to the starting branch/)
    assert.doesNotMatch(callOf(one.task.id).input, /Worktree:/, 'only for runs in a worktree')

    release(b)
    await ended(two.task)
    assert.equal(two.task.audit.ok, true)
    assert.equal(two.task.audit.startBranch, null, 'no branch to be back on')
    assert.ok(!existsSync(wt), 'removed: nothing was left in it')
    assert.ok(!git(dir, 'worktree', 'list').includes(wt))
    assert.equal(two.task.worktreeRemoved, true)
    assert.match(workers.resultText(two.task), /The gateway removed its worktree/)
    assert.deepEqual(workers.runMeta(two.task), { worktree: two.task.id })
    release(a)
    await ended(one.task)
  } finally {
    workers.close()
  }
})

test("a submodule commit the checkout's module lacks: from the checkout all the same, and that one commit from its URL", async () => {
  const { root, dir, base, remotes, subRemote, workers, dispatch } = setup({ sub: 'initialised', maxPerRepo: 2 })
  try {
    // The submodule moves on, and so does alpha's origin, after the checkout was made.
    const lib = join(base, 'lib-work')
    writeFileSync(join(lib, 'lib.txt'), 'lib, newer\n')
    git(lib, 'commit', '-q', '-am', 'newer')
    git(lib, 'push', '-q', subRemote, 'main')
    const other = join(base, 'other')
    execFileSync('git', ['clone', '-q', join(remotes, 'alpha.git'), other])
    git(other, 'submodule', 'update', '-q', '--init')
    git(join(other, 'lib'), 'fetch', '-q', 'origin', 'main')
    git(join(other, 'lib'), 'checkout', '-q', 'FETCH_HEAD')
    git(other, 'commit', '-q', '-am', 'newer lib')
    git(other, 'push', '-q', 'origin', 'main')
    const needed = git(join(other, 'lib'), 'rev-parse', 'HEAD')
    const before = git(join(dir, 'lib'), 'rev-parse', 'HEAD')

    const a = hold()
    const one = await dispatch(`HOLD:${a} one`)
    const two = await dispatch(`HOLD:${a} two`, { parallel: true })
    const wt = join(worktreesOf(root), two.task.id)
    await until(() => callOf(two.task.id))
    assert.deepEqual(two.task.submodules.map(s => [s.path, s.how, s.ok]), [['lib', 'from the checkout', true]])
    assert.equal(git(join(wt, 'lib'), 'rev-parse', 'HEAD'), needed)
    assert.equal(readFileSync(join(wt, 'lib', 'lib.txt'), 'utf8'), 'lib, newer\n')
    assert.equal(git(join(dir, 'lib'), 'rev-parse', 'HEAD'), before, "the checkout's module as it was")
    release(a)
    await ended(two.task)
    await ended(one.task)
  } finally {
    workers.close()
  }
})

test("a worktree where the checkout's submodule is not initialised: a shallow clone from its URL", async () => {
  const { root, dir, workers, dispatch } = setup({ sub: 'not', maxPerRepo: 2 })
  try {
    const a = hold()
    const one = await dispatch(`HOLD:${a} one`)
    const two = await dispatch('two', { parallel: true })
    await ended(two.task)
    assert.deepEqual(two.task.submodules.map(s => [s.path, s.how, s.ok]), [['lib', 'shallow from its URL', true]])
    assert.ok(!existsSync(join(root, 'alpha', 'lib', 'lib.txt')), 'the checkout as it was')
    assert.throws(() => git(dir, 'config', '--get', 'submodule.lib.url'), 'and its config: the URL came with -c')
    release(a)
    await ended(one.task)
  } finally {
    workers.close()
  }
})

test('a run in a worktree that leaves a commit on no remote: the worktree stays, and the push decision names it', async () => {
  const { root, dir, ledger, workers, dispatch } = setup({ maxPerRepo: 2 })
  try {
    const a = hold()
    const one = await dispatch(`HOLD:${a} PUSH BRANCH:main-run one`)
    const two = await dispatch('COMMIT BRANCH:wt-run two', { parallel: true })
    await ended(two.task)
    const wt = join(worktreesOf(root), two.task.id)
    assert.ok(existsSync(wt), 'kept')
    assert.equal(two.task.audit.unpushed.length, 1)
    const decision = ledger.get(two.task.decision)
    assert.equal(decision.details.worktree, two.task.id)
    assert.match(decision.text, new RegExp(`left 1 commit on no remote in its worktree \\(${wt}\\)`))
    assert.match(workers.statusText('alpha'), new RegExp(`Kept worktrees: ${two.task.id} \\(1 commit on no remote\\)`))
    // The decision is about that worktree: other tasks go on; one for it waits.
    const next = await dispatch('next', { parallel: true })
    assert.equal(next.status, 'started')
    await ended(next.task)
    const there = await dispatch('there', { continues: two.task.id })
    assert.equal(there.status, 'queued')
    assert.equal(there.reason, 'decision')
    assert.deepEqual(there.holds.map(d => d.id), [decision.id])
    workers.drop('alpha', there.entry.id)
    // The run in the checkout pushed its own branch: the worktree's commit is
    // not counted as its own.
    release(a)
    await ended(one.task)
    assert.equal(one.task.audit.unpushed.length, 0, "the worktree's commit is not the checkout run's")
    assert.equal(one.task.decision, null)
    assert.ok(git(dir, 'worktree', 'list').includes(wt))
  } finally {
    workers.close()
  }
})

// --- answers and follow-ups ----------------------------------------------------------------

test("the driver's answer goes back to its run: the same worktree and session; continues names one; the checkout's own goes there", async () => {
  const { root, dir, workers, dispatch } = setup({ maxPerRepo: 2 })
  try {
    const a = hold()
    const one = await dispatch(`HOLD:${a} one`)
    // It pushes its branch and asks: nothing is left, so its worktree goes.
    const asked = await dispatch('QUESTION PUSH BRANCH:asked two', { parallel: true })
    await ended(asked.task)
    const wt = join(worktreesOf(root), asked.task.id)
    assert.ok(!existsSync(wt), 'removed: everything is pushed')
    const session = callOf(asked.task.id).session

    // The answer: no parallel needed, no continues; the run it is about. Its
    // worktree is made again at the same path, on the branch it ended on, so
    // that its session continues.
    const answer = await dispatch('the answer', { answered: asked.task.id })
    assert.equal(answer.status, 'started')
    assert.equal(answer.task.worktree, asked.task.id)
    const call = await until(() => callOf(answer.task.id))
    assert.equal(call.cwd, wt)
    assert.equal(call.resumed, true)
    assert.equal(call.session, session, 'its session, not the checkout one')
    assert.match(call.input, /made again for this follow-up at the same path, with voice\/asked checked out as your last run left it/)
    assert.equal(git(wt, 'branch', '--show-current'), 'voice/asked')
    assert.match(call.input, /^- Uncommitted files in your worktree: none$/m)
    await ended(answer.task)

    // continues: the same; a run of the checkout continues there, and waits for it.
    const again = await dispatch('again', { continues: asked.task.id })
    assert.equal(again.task.worktree, asked.task.id)
    await ended(again.task)
    assert.equal(callOf(again.task.id).cwd, wt)
    const main = await dispatch('main follow-up', { continues: one.task.id })
    assert.equal(main.status, 'queued', 'the checkout is taken')
    release(a)
    const ran = await until(() => workers.state.tasks.find(t => t.queued === main.entry.id))
    assert.equal((await until(() => callOf(ran.id))).cwd, dir)
    await ended(ran)
    const wrong = await dispatch('x', { continues: 'tzzz' })
    assert.equal(wrong.status, 'order')
  } finally {
    workers.close()
  }
})

test('answeredTask: the run whose result the answer is about, also through a question back on it or a reminder', () => {
  const store = new Store({ file: null })
  const ledger = new Ledger({ log: () => {} })
  const result = store.createRequest('Worker alpha finished task t2ab', { origin: 'worker', worker: { repo: 'alpha', task: 't2ab' } })
  const answer = store.createRequest('(Answer to x) yes', { answers: result.id })
  assert.equal(answeredTask(store, ledger, result.id), 't2ab')
  const back = store.createRequest('(Answer to y) the second', { answers: answer.id })
  assert.equal(answeredTask(store, ledger, back.id), 't2ab', 'a question back on the answer')
  const reminder = store.createRequest('Reminder 1 of 3', { origin: 'worker' })
  ledger.add({ kind: 'push', repo: 'alpha', text: 'push?', requestId: reminder.id, details: { task: 't3cd' } })
  assert.equal(answeredTask(store, ledger, reminder.id), 't3cd', 'the run of a decision asked on it')
  const voice = store.createRequest('Run the tests in alpha.')
  assert.equal(answeredTask(store, ledger, voice.id), null)
})

// --- stop, the kill switch, interrupted runs ------------------------------------------------

test('stop by task id: the other run goes on; a run in a worktree goes back to the queue with it, unless it is dropped', async () => {
  const { root, workers, dispatch } = setup({ maxPerRepo: 2 })
  try {
    const [a, b] = [hold(), hold()]
    const one = await dispatch(`HOLD:${a} one`)
    const two = await dispatch(`HOLD:${b} LEAVE two`, { parallel: true })
    await until(() => callOf(two.task.id))
    const wt = join(worktreesOf(root), two.task.id)
    const [stopped] = workers.stopRuns('alpha', { task: two.task.id })
    assert.equal(stopped, two.task)
    assert.ok(await workers.ended(two.task))
    assert.equal(two.task.state, 'stopped')
    assert.equal(one.task.state, 'running', 'the other run goes on')
    const back = two.task.requeuedAs
    assert.match(back, /^q[a-z0-9]{3}$/)
    await workers.audit(two.task)
    assert.equal(two.task.decision, null, 'no push decision: it goes on')
    assert.ok(existsSync(wt), 'kept for it')
    // It resumes there, in front of the repository's queue.
    const resumed = await until(() => workers.state.tasks.find(t => t.queued === back))
    const call = await until(() => callOf(resumed.id))
    assert.equal(call.cwd, wt)
    assert.match(call.input, /^- Resumed: this task was interrupted \(stopped by the controller\) and continues here, in the same session\./m)
    assert.equal(resumed.resumes, 1)
    // Stopped for good: drop.
    workers.stopRuns('alpha', { task: resumed.id, drop: true })
    assert.ok(await workers.ended(resumed))
    assert.equal(resumed.requeuedAs, undefined)
    assert.ok(!workers.queued('alpha').length)
    release(a)
    await ended(one.task)
  } finally {
    workers.close()
  }
})

test('the kill switch stops every run, also in worktrees, empties the queue and keeps the worktrees, as open decisions', async () => {
  const { root, ledger, killswitch, workers, dispatch } = setup({ maxPerRepo: 2 })
  try {
    const [a, b] = [hold(), hold()]
    const one = await dispatch(`HOLD:${a} one`)
    const two = await dispatch(`HOLD:${b} two`, { parallel: true })
    const queued = await dispatch('three', { parallel: true })
    await until(() => callOf(two.task.id))
    killswitch.locked = true
    killswitch.state = { trigger: 'rule', reason: 'test', at: new Date().toISOString() }
    const parked = workers.parkAll()
    assert.deepEqual(parked.map(e => e.id), [queued.entry.id])
    const stopped = workers.stopAll('kill switch (rule)')
    assert.deepEqual(stopped.map(t => t.id).sort(), [one.task.id, two.task.id].sort())
    await until(() => one.task.state !== 'running' && two.task.state !== 'running')
    assert.equal(two.task.state, 'stopped')
    assert.equal(two.task.requeuedAs, undefined, 'not back in the queue')
    assert.ok(existsSync(join(worktreesOf(root), two.task.id)), 'its worktree is kept')
    const decision = ledger.get(two.task.lockDecision)
    assert.equal(decision.details.worktree, two.task.id)
    assert.equal(decision.repo, null, 'it holds nothing')
    assert.match(decision.text, new RegExp(`Dispatch it again with continues="${two.task.id}"`))
    await workers.audit(two.task)
    assert.equal(two.task.decision, null)
    assert.ok(existsSync(join(worktreesOf(root), two.task.id)), 'still kept after its audit')
    assert.equal(workers.queued().length, 0)
    assert.equal((await dispatch('four')).status, 'locked')
  } finally {
    workers.close()
  }
})

test('an interrupted run in a worktree goes back to the queue and resumes there: at the time limit, after a crash', async () => {
  const { root, workers, dispatch } = setup({ maxPerRepo: 2, timeoutMinutes: 0.03 })
  try {
    const a = hold()
    const one = await dispatch(`HOLD:${a} one`)
    // The time limit (here about two seconds).
    const slow = await dispatch('SLOWONCE PUSH BRANCH:slow slow', { parallel: true })
    const wt = join(worktreesOf(root), slow.task.id)
    await until(() => slow.task.state !== 'running', 20000)
    assert.equal(slow.task.state, 'stopped')
    assert.match(slow.task.error, /time limit/)
    const back = slow.task.requeuedAs
    assert.ok(back)
    assert.equal(workers.queued('alpha')[0]?.id ?? back, back, 'in front of the repository')
    const resumed = await until(() => workers.state.tasks.find(t => t.queued === back))
    const call = await until(() => callOf(resumed.id))
    assert.equal(call.cwd, wt, 'the same worktree')
    assert.equal(call.resumed, true, 'its session')
    assert.match(call.input, /Resumed: this task was interrupted \(stopped at the time limit/)
    assert.match(call.input, /Before you push: git fetch origin, rebase/)
    await ended(resumed)
    assert.equal(resumed.state, 'done')
    assert.ok(!existsSync(wt), 'pushed and clean: removed only now')
    assert.match(workers.resultText(slow.task), /went back to the queue as q[a-z0-9]{3}, in front for alpha, with its worktree/)
    assert.deepEqual(workers.runMeta(slow.task), { worktree: slow.task.id, requeued: back })

    // A crash: no result of its own. The checkout's run met the time limit
    // too, so another one takes the checkout first.
    await ended(one.task)
    assert.equal(one.task.requeuedAs, undefined, 'a run in the checkout does not go back to the queue')
    const occupy = await dispatch(`HOLD:${a} occupy`)
    const crash = await dispatch('CRASH LEAVE crash', { parallel: true })
    assert.ok(crash.task.worktree)
    await until(() => crash.task.state !== 'running')
    assert.equal(crash.task.state, 'failed')
    assert.ok(crash.task.requeuedAs)
    const again = await until(() => workers.state.tasks.find(t => t.queued === crash.task.requeuedAs))
    assert.equal((await until(() => callOf(again.id))).cwd, join(worktreesOf(root), crash.task.id))
    await ended(again)
    assert.equal(again.state, 'done')
    release(a)
    await ended(occupy.task)
  } finally {
    workers.close()
  }
})

test('across a restart: a run in a worktree goes on and reports to the next gateway; one whose worktree was being made resumes from the queue', async () => {
  const { root, stateDir, workers, make, dispatch } = setup({ maxPerRepo: 2 })
  const a = hold()
  const one = await dispatch(`HOLD:${a} one`)
  const b = hold()
  const two = await dispatch(`HOLD:${b} two`, { parallel: true })
  await until(() => callOf(two.task.id))
  workers.close() // the gateway restarts; the runs go on
  // As a gateway that ended while it was making a worktree left it.
  const saved = JSON.parse(readFileSync(join(stateDir, 'workers.json'), 'utf8'))
  const id = 'tprp'
  saved.tasks.push({
    ...saved.tasks.find(t => t.id === two.task.id),
    id,
    pid: null,
    pidStart: null,
    mark: 'never-started',
    preparing: true,
    worktree: id,
    dir: join(worktreesOf(root), id),
    reported: false,
    task: 'made when the gateway ended',
  })
  saved.worktrees[id] = { repo: 'alpha', dir: join(worktreesOf(root), id), sessionId: 's', resumable: false, task: id, createdAt: Date.now() }
  writeFileSync(join(stateDir, 'workers.json'), JSON.stringify(saved))
  const next = make()
  try {
    const adopted = next.taskById(two.task.id)
    assert.equal(adopted.state, 'running', 'followed by the next gateway')
    const lost = next.taskById(id)
    await until(() => lost.state !== 'running')
    assert.equal(lost.state, 'failed')
    assert.match(lost.error, /the gateway restarted while its worktree was being made/)
    assert.ok(lost.requeuedAs)
    assert.equal(next.queued('alpha')[0].id, lost.requeuedAs, 'in front')
    // Two runs go in alpha, as many as it may have: it waits for a slot there.
    release(b)
    await ended(adopted)
    assert.equal(adopted.state, 'done')
    const resumed = await until(() => next.state.tasks.find(t => t.queued === lost.requeuedAs))
    assert.equal(resumed.worktree, id)
    assert.equal((await until(() => callOf(resumed.id))).cwd, join(worktreesOf(root), id))
    await ended(resumed)
    release(a)
    await ended(next.taskById(one.task.id))
  } finally {
    next.close()
  }
})

// --- a changed limit ------------------------------------------------------------------------------

test('a limit raised since the queue was planned: the plan names the tasks that could run next to others; lowered: one after the other, runs going not stopped', async () => {
  const { stateDir, workers, make, dispatch } = setup({ maxRuns: 5 })
  const a = hold()
  const one = await dispatch(`HOLD:${a} one`)
  const x = (await dispatch('Update the changelog.')).entry
  const y = (await dispatch('Translate the README.')).entry
  assert.equal(workers.replan, null)
  workers.close()
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'workers.json'), 'utf8')).perRepo, 1, 'planned for one')

  const raised = make({ maxPerRepo: 3 })
  let lowered = null
  try {
    const plan = raised.replan
    assert.deepEqual(plan.repos.map(r => r.repo), ['alpha'])
    assert.equal(plan.from, 1)
    assert.equal(plan.to, 3)
    const text = planText(plan, 'since the queue was planned')
    assert.match(text, /^The limit of runs per repository went up from 1 to 3 since the queue was planned\./)
    assert.match(text, new RegExp(`^- alpha: running ${one.task.id} \\("HOLD:\\w+ one"\\); queued, in their order: ${x.id} \\("Update the changelog\\."\\), ${y.id} \\("Translate the README\\."\\)$`, 'm'))
    assert.match(text, /order_queue with parallel=true/)
    // A change of the global limit meanwhile keeps the plan for the controller.
    assert.equal(raised.setLimits({ maxRuns: 6, maxPerRepo: 3 }).plan, null)
    assert.equal(raised.replan, plan)
    raised.planned()
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'workers.json'), 'utf8')).perRepo, 3)
    // The controller marks one; it starts next to the run, in a worktree.
    raised.order('alpha', y.id, { parallel: true })
    const started = await until(() => raised.state.tasks.find(t => t.queued === y.id))
    assert.ok(started.worktree)
    assert.ok(!raised.state.tasks.some(t => t.queued === x.id), 'the other stays behind')
    const b = hold()
    const third = await raised.dispatch({ worker: 'alpha', task: `HOLD:${b} third`, words: 'the words', parallel: true })
    await until(() => callOf(third.task.id))
    await ended(started)
    raised.close()

    // Lowered to one: the two runs go on, and nothing new starts until none is left.
    lowered = make({ maxPerRepo: 1 })
    assert.equal(lowered.replan, null)
    assert.equal(lowered.runsOf('alpha').length, 2, 'not stopped')
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.ok(!lowered.state.tasks.some(t => t.queued === x.id))
    release(b)
    await ended(lowered.taskById(third.task.id))
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.ok(!lowered.state.tasks.some(t => t.queued === x.id), 'one still runs')
    release(a)
    const last = await until(() => lowered.state.tasks.find(t => t.queued === x.id))
    assert.equal(last.worktree, undefined, 'in the checkout again')
    await ended(last)
  } finally {
    raised.close()
    lowered?.close()
  }
})

test('setLimits while running: raised, the plan; lowered, nothing new above the limit; the global limit too', async () => {
  const { workers, dispatch } = setup({ maxRuns: 2 })
  try {
    const a = hold()
    const one = await dispatch(`HOLD:${a} one`)
    const x = (await dispatch('x')).entry
    const { was, plan } = workers.setLimits({ maxRuns: 2, maxPerRepo: 2 })
    assert.deepEqual(was, { maxRuns: 2, maxPerRepo: 1 })
    assert.deepEqual(plan.repos[0].queued.map(e => e.id), [x.id])
    assert.equal(workers.replan, plan)
    workers.planned()
    assert.equal(workers.state.perRepo, 2)
    workers.order('alpha', x.id, { parallel: true })
    const b = hold()
    x.task = `HOLD:${b} x`
    const started = await until(() => workers.state.tasks.find(t => t.queued === x.id))
    // The global limit down to one: two run, and nothing new starts.
    assert.deepEqual(workers.setLimits({ maxRuns: 1, maxPerRepo: 3 }).plan, null)
    const y = await dispatch('y', { parallel: true })
    assert.equal(y.reason, 'full')
    release(b)
    await ended(started)
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.ok(!workers.state.tasks.some(t => t.queued === y.entry.id), 'one runs, the limit is one')
    release(a)
    await ended(one.task)
    await ended(await until(() => workers.state.tasks.find(t => t.queued === y.entry.id)))
  } finally {
    workers.close()
  }
})

test('the settings file while the gateway runs: the limits change, the environment wins, bad values and a half-written file change nothing', () => {
  const file = join(TMP, 'live.env')
  const lines = []
  writeFileSync(file, 'VOICE_GW_PORT=8787\n')
  const env = { VOICE_GW_MAX_WORKERS: '2' }
  const watcher = new SettingsWatcher({
    file,
    env,
    limits: { VOICE_GW_MAX_WORKERS: 2, VOICE_GW_MAX_WORKERS_PER_REPO: 1 },
    log: (...args) => lines.push(args.join(' ')),
  })
  const changes = []
  watcher.on('change', change => changes.push(change))

  writeFileSync(file, 'VOICE_GW_PORT=8787\nVOICE_GW_MAX_WORKERS_PER_REPO=3\nVOICE_GW_MAX_WORKERS=6\n')
  const raised = watcher.reload()
  assert.deepEqual(raised.changed, { VOICE_GW_MAX_WORKERS_PER_REPO: 3 })
  assert.deepEqual(raised.limits, { VOICE_GW_MAX_WORKERS: 2, VOICE_GW_MAX_WORKERS_PER_REPO: 3 })
  assert.ok(lines.some(line => /VOICE_GW_MAX_WORKERS changed in the settings file, but the environment sets it to 2, which wins: it stays 2/.test(line)))

  writeFileSync(file, 'VOICE_GW_PORT=8787\nVOICE_GW_MAX_WORKERS_PER_REPO=many\n')
  assert.equal(watcher.reload(), null)
  assert.ok(lines.some(line => /VOICE_GW_MAX_WORKERS_PER_REPO=many in the settings file is no whole number from 1 to 100: ignored, it stays 3/.test(line)))
  writeFileSync(file, 'VOICE_GW_PORT=8787\nVOICE_GW_MAX_WORKERS_PER_REPO=0\n')
  assert.equal(watcher.reload(), null)
  assert.equal(watcher.limits.VOICE_GW_MAX_WORKERS_PER_REPO, 3)

  // Half written: once more later, then taken as it is.
  writeFileSync(file, 'VOICE_GW_PORT=8787\nVOICE_GW_MAX_WORKERS_PER_REPO=2')
  assert.equal(watcher.reload(), null)
  assert.ok(lines.some(line => /its last line has no end yet/.test(line)))
  clearTimeout(watcher.timer)
  assert.deepEqual(watcher.reload().changed, { VOICE_GW_MAX_WORKERS_PER_REPO: 2 })

  // Unreadable or gone: the limits stay.
  rmSync(file)
  mkdirSync(file)
  assert.equal(watcher.reload(), null)
  assert.ok(lines.some(line => /it cannot be read \(EISDIR\)/.test(line)))
  rmSync(file, { recursive: true })
  assert.equal(watcher.reload(), null)
  assert.ok(lines.some(line => /but it is gone: the worker limits stay as they are/.test(line)))
  assert.equal(watcher.limits.VOICE_GW_MAX_WORKERS_PER_REPO, 2)

  // Taken out: the default again; other settings count from the next start.
  writeFileSync(file, 'VOICE_GW_PORT=8790\n')
  const back = watcher.reload()
  assert.deepEqual(back.changed, { VOICE_GW_MAX_WORKERS_PER_REPO: 1 })
  assert.deepEqual(back.others, ['VOICE_GW_PORT'])
  assert.ok(lines.some(line => /settings file changed: VOICE_GW_PORT take effect at the next start of the controller/.test(line)))
  assert.equal(changes.length, 3)
  watcher.close()
})

// --- the rules ----------------------------------------------------------------------------------

test('the rules: a run in a worktree writes there and in its memory folders; the checkout is outside for it', () => {
  const workers = new EventEmitter()
  const tripped = []
  const runner = { dir: name => `/work/${name}`, git: async () => null }
  const guard = new RunGuard({ workers, runner, killswitch: { trip: event => tripped.push(event) }, ghBin: join(BIN, 'gh'), mainCheckSeconds: 3600, log: () => {} })
  try {
    const task = {
      id: 'twtr',
      repo: 'alpha',
      dir: '/work/.voice-worktrees/alpha/twtr',
      checkout: '/work/alpha',
      worktree: 'twtr',
      startedAt: Date.now(),
    }
    workers.emit('started', task)
    const tool = (name, input) => workers.emit('tool', task, { type: 'tool_use', name, input })
    tool('Write', { file_path: '/work/.voice-worktrees/alpha/twtr/src/a.js', content: 'x' })
    tool('Edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' })
    tool('Bash', { command: 'echo x > notes.txt && mkdir -p build' })
    const config = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude')
    tool('Write', { file_path: `${config}/projects/-work-alpha/memory/MEMORY.md`, content: 'x' })
    tool('Write', { file_path: `${config}/projects/-work--voice-worktrees-alpha-twtr/memory/MEMORY.md`, content: 'x' })
    assert.deepEqual(tripped, [])
    tool('Write', { file_path: '/work/alpha/src/a.js', content: 'x' })
    assert.equal(tripped.length, 1)
    assert.match(tripped[0].reason, /^write outside the allowed folders: Write \/work\/alpha\/src\/a\.js \(worker alpha, task twtr\)/)
  } finally {
    guard.close()
  }
})

test('the prompt of a run in a worktree where pull requests are off: a detached HEAD, pushed to the default branch', () => {
  const facts = {
    origin: 'acme/delta',
    visibility: 'private',
    branch: 'main',
    dirty: [],
    defaultBranch: 'main',
    pushDirect: true,
    worktree: { dir: '/w/.voice-worktrees/delta/t1ab', target: 'main', base: 'origin/main', created: true, fetched: true, submodules: [{ path: 'lib', ok: false, why: 'no network' }] },
  }
  const text = prompt({ task: 'Fix it.', words: 'fix it', facts })
  assert.match(text, /^- Pull requests: turned off on GitHub\. Your commits go to main, pushed there without a pull request \(Branch below\)\.$/m)
  assert.match(text, /^- Branch: commit here on the detached HEAD; do not switch to main/m)
  assert.match(text, /then git push origin HEAD:main\./)
  assert.match(text, /^- Submodule lib: not initialised \(no network\)\. If you need it: git submodule update --init --depth 1 -- lib$/m)
  const kept = prompt({ task: 'Go on.', words: 'go on', facts: { ...facts, dirty: ['left.txt'] } })
  assert.match(kept, /^- Uncommitted files in your worktree: left\.txt \(left by an earlier run of this task\)$/m)
  assert.doesNotMatch(kept, /not yours, leave them alone/)
})
