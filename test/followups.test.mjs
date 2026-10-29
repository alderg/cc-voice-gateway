// The check after a run and the decisions it raises, with what the driver
// answered: whose commits and files count, what a follow-up for an answer
// is about, and that a decision the driver settled stays settled. Workers and
// the ledger run here, without the gateway, on temporary git repositories,
// with a stand-in for claude that writes what it was asked.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-followups-')))
const BIN = join(TMP, 'bin')
const INPUTS = join(TMP, 'inputs.txt')

// Before the modules are loaded: no log file, no settings of this checkout.
process.env.VOICE_GW_LOG_FILE = ''
process.env.VOICE_GW_SECRETS_DIR = join(TMP, 'no-secrets')
const { Workers, auditSummary, auditText } = await import('../src/workers.mjs')
const { Ledger, decisionLine } = await import('../src/ledger.mjs')

// COMMIT: a commit on a voice branch, not pushed, back on the start branch.
// LEAVE: a new file, not committed. Then a result.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const cp = require('child_process')
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(INPUTS)}, input + '\\n----\\n')
const git = (...a) => cp.execFileSync('git', ['-c', 'user.name=W', '-c', 'user.email=w@example.com', ...a], { stdio: 'ignore' })
if (/COMMIT/.test(input)) {
  git('checkout', '-q', '-b', 'voice/x' + process.pid)
  fs.writeFileSync('c' + process.pid + '.txt', 'c')
  git('add', '.')
  git('commit', '-q', '-m', 'c')
  git('checkout', '-q', '-')
}
if (/LEAVE/.test(input)) fs.writeFileSync('left-over.txt', 'x')
const args = process.argv.slice(2)
const session = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1]
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session }))
`

before(() => {
  mkdirSync(BIN)
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  writeFileSync(join(BIN, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(BIN, 'claude'), 0o755)
  chmodSync(join(BIN, 'gh'), 0o755)
})

after(() => rmSync(TMP, { recursive: true, force: true }))

async function until(predicate, ms = 8000) {
  for (const started = Date.now(); Date.now() - started < ms; await new Promise(r => setTimeout(r, 25))) {
    const value = predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

// A folder of repositories with "alpha" in it, pushed to a bare remote, and
// Workers on it with a ledger. A finished run is checked and reported as the
// gateway does it; its result is the request "r" + the task id.
function setup(name) {
  const root = join(TMP, name, 'Developer')
  const dir = join(root, 'alpha')
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
  execFileSync('git', ['init', '-q', '--bare', join(TMP, name, 'remote.git')])
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', join(TMP, name, 'remote.git'))
  git('push', '-q', 'origin', 'main')
  const stateDir = join(TMP, name, 'state')
  const ledger = new Ledger({ file: join(stateDir, 'jobs.json'), log: () => {} })
  const workers = new Workers({ root, stateDir, claudeBin: join(BIN, 'claude'), ghBin: join(BIN, 'gh'), ledger })
  workers.on('finished', async task => {
    await workers.audit(task)
    if (task.decision) ledger.link(ledger.get(task.decision), `r${task.id}`)
    workers.markReported(task)
  })
  const run = async job => {
    const result = await workers.dispatch({ worker: 'alpha', words: 'the words', ...job })
    assert.equal(result.status, 'started', JSON.stringify(result.status))
    return until(() => (result.task.reported ? result.task : null))
  }
  return { root, dir, git, stateDir, ledger, workers, run }
}

test('a run without a record of its start is blamed for none of the driver\'s commits or files', async () => {
  const { dir, git, stateDir, ledger, workers } = setup('old')
  try {
    // The driver's own local branch and file, long before any run.
    git('checkout', '-q', '-b', 'experiment')
    writeFileSync(join(dir, 'e.txt'), 'e')
    git('add', '.')
    git('commit', '-q', '-m', 'experiment')
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'notes.txt'), 'mine')
    // A run as the version before this one saved it, or one where git did
    // not answer at the start: no unpushedBefore, no startDirty.
    const task = { id: 'told', repo: 'alpha', task: 'Run the tests.', state: 'done', dir, startedAt: 0, finishedAt: 60000, result: 'Done.' }
    const audit = await workers.audit(task)
    assert.deepEqual([audit.unpushed, audit.dirty, audit.baseline], [[], [], false])
    assert.equal(
      auditText(audit),
      "Git check by the gateway: the checkout as this run found it was not recorded, so no commit or file is counted as the run's own; it is on main.",
    )
    assert.equal(auditSummary(audit), 'its start not recorded')
    assert.equal(task.decision, null)
    assert.deepEqual(ledger.open(), [], 'no decision, no question, nothing held')
    assert.doesNotMatch(workers.resultText(task), /open decision/)
    assert.ok(readFileSync(join(stateDir, 'workers.json'), 'utf8'))
  } finally {
    workers.close()
  }
})

test("a follow-up for a decision about uncommitted files: those files are what it is for, not someone else's", async () => {
  const { ledger, workers, run } = setup('files')
  try {
    const left = await run({ task: 'LEAVE: write the notes.' })
    const decision = ledger.get(left.decision)
    assert.deepEqual(decision.details.files, ['left-over.txt'])
    ledger.ask(`r${left.id}`, { text: 'A file is left. Commit and push it?' })
    ledger.answer(`r${left.id}`, { text: 'Yes, commit it.', answerId: 'a001' })
    // No allow_dirty needed: the file is the decision's.
    const follow = await run({ task: 'Commit the notes and push them.', answers: `r${left.id}` })
    const input = readFileSync(INPUTS, 'utf8').split('\n----\n').at(-2)
    assert.match(input, /^- Uncommitted files before you start: none$/m)
    assert.match(input, /^- Uncommitted files an earlier run left, which this task follows up: left-over\.txt$/m)
    assert.doesNotMatch(input, /left-over\.txt \(not yours/)
    assert.equal(decision.state, 'closed')
    assert.equal(decision.closedBy, 'dispatch')
    // It did not commit the file: that counts again, as a new decision.
    assert.deepEqual(follow.audit.dirty, ['left-over.txt'])
    assert.match(ledger.get(follow.decision).text, /left 1 new uncommitted file/)

    // Any other uncommitted file still needs the driver's yes.
    writeFileSync(join(workers.runner.dir('alpha'), 'other.txt'), 'x')
    ledger.ask(`r${follow.id}`, { text: 'Still not committed. Commit it?' })
    ledger.answer(`r${follow.id}`, { text: 'Yes.', answerId: 'a002' })
    const dirty = await workers.dispatch({ worker: 'alpha', task: 'Commit it.', words: 'yes', answers: `r${follow.id}` })
    assert.deepEqual([dirty.status, dirty.files], ['dirty', ['other.txt']])
  } finally {
    workers.close()
  }
})

test('the driver\'s "keep it local" sticks: a later follow-up does not raise the same commit again', async () => {
  const { ledger, workers, run } = setup('keep')
  try {
    const committed = await run({ task: 'COMMIT: fix it.' })
    const decision = ledger.get(committed.decision)
    assert.equal(decision.details.commits.length, 1)
    ledger.ask(`r${committed.id}`, { text: 'Push the commit?' })
    ledger.answer(`r${committed.id}`, { text: 'No, keep it local and run the tests.', answerId: 'a010' })
    // The controller's "done" to the answer settles it.
    assert.deepEqual(ledger.settle('a010', 'Kept local.').map(d => d.id), [decision.id])
    const tests = await run({ task: 'Run the tests.', answers: `r${committed.id}` })
    assert.equal(tests.carried, undefined, 'it closed nothing, so it carries nothing')
    assert.deepEqual(tests.audit.unpushed, [])
    assert.equal(tests.decision, null)
    assert.deepEqual(ledger.open(), [])

    // A decision closed by the driver keeps its commit out of a later one,
    // also when a run would count it (a run whose start was not recorded).
    const again = await run({ task: 'COMMIT: one more.' })
    const second = ledger.get(again.decision)
    ledger.close(second, { outcome: 'keep it local', by: 'driver' })
    const old = { id: 'tdec', repo: 'alpha', task: 'x', state: 'done', dir: workers.runner.dir('alpha'), carried: { commits: [] } }
    old.unpushedBefore = []
    old.startDirty = []
    await workers.audit(old)
    assert.equal(old.audit.unpushed.length, 2, 'both commits are on no remote')
    assert.equal(old.decision, null, 'the driver decided about both')
  } finally {
    workers.close()
  }
})

test('a question back on the answer is the same decision, and the follow-up for its answer is not held by it', async () => {
  const { ledger, workers, run } = setup('clarify')
  try {
    const committed = await run({ task: 'COMMIT: fix it.' })
    const decision = ledger.get(committed.decision)
    const result = `r${committed.id}`
    ledger.ask(result, { text: 'Push the commit in alpha?' })
    ledger.answer(result, { text: 'Hmm, which one?', answerId: 'a020' })
    assert.ok(decision.requests.includes('a020'), 'the answer belongs to it')
    const back = ledger.ask('a020', { kind: 'other', text: 'The one on the voice branch. Push it?' })
    assert.deepEqual([back.created, back.asked], [null, [decision]], 'no second decision')
    ledger.answer('a020', { text: 'Yes, push it.', answerId: 'a021' })
    assert.equal(decision.answeredBy, 'a021')
    const follow = await workers.dispatch({ worker: 'alpha', task: 'Push it.', words: 'yes push it', answers: 'a020' })
    assert.equal(follow.status, 'started', 'not held')
    assert.deepEqual(follow.closed, [decision.id])
    await until(() => follow.task.reported)
    assert.equal(ledger.open().length, 1, 'it did not push: the commit counts again')
    assert.match(decisionLine(ledger.open()[0]), /^d[a-z0-9]{3} push, alpha, not asked yet \(request r/)
  } finally {
    workers.close()
  }
})

test('the kill switch turns queued tasks into decisions that hold nothing', async () => {
  const { ledger, workers } = setup('locked')
  try {
    workers.state.queue.push({ id: 'q1ab', worker: 'alpha', task: 'Run the tests.', words: 'run the tests', queuedAt: Date.now() })
    assert.equal(workers.parkAll().length, 1)
    const [decision] = ledger.open()
    assert.equal(decision.repo, null)
    assert.deepEqual(workers.holds('alpha'), [], 'new tasks there start after the unlock')
    assert.match(decisionLine(decision), /^d[a-z0-9]{3} other, alpha, not asked yet, on no request: The queued task q1ab for alpha did not start: the kill switch locked\./)
    assert.deepEqual(ledger.due(Date.now() + 31 * 60 * 1000), [decision], 'a reminder brings it to the driver')
  } finally {
    workers.close()
  }
})
