// Work folders (VOICE_GW_SCRATCH=1): a new empty folder per task for work
// that needs no repository, through the same worker tools with the worker
// scratch/new. No git there: the gateway lists the files a run made instead,
// raises no push decision, and the folder is the run's only place to write.
//
// First Workers on its own, with a stand-in for claude that makes and
// changes files as its task says; then the gateway as a whole, with the
// option on and off, as workers.test.mjs drives it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-scratch-')))
const BIN = join(TMP, 'bin')
const CALLS = join(TMP, 'claude-calls.jsonl')

process.env.VOICE_GW_LOG_FILE = ''
process.env.VOICE_GW_SECRETS_DIR = join(TMP, 'no-secrets')
const { Workers } = await import('../src/workers.mjs')
const { RunGuard } = await import('../src/guard.mjs')
const { HostRunner } = await import('../src/runners.mjs')
const { KillSwitch } = await import('../src/killswitch.mjs')
const { Ledger } = await import('../src/ledger.mjs')
const { adminRequest } = await import('../src/admin.mjs')
const { SCRATCH_NEW, ScratchFolders, fileChanges, filesSummary, filesText, scratchEntries, scratchProblem } = await import('../src/workspaces.mjs')

// The stand-in for claude. Words in the task:
//   MAKE      writes report.md and data/table.csv
//   CHANGE    appends to report.md and removes data/table.csv
//   OUTSIDE   a Bash call that writes to /tmp, and one into its folder
//   SLOW      takes long before its result
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args, input, pid: process.pid, repo: process.env.VOICE_GW_REPO }) + '\\n')
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
out({ type: 'system', subtype: 'init' })
if (/MAKE/.test(input)) {
  mkdirSync('data', { recursive: true })
  writeFileSync('report.md', '# Report\\n')
  writeFileSync('data/table.csv', 'a,b\\n1,2\\n')
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: process.cwd() + '/report.md', content: 'x' } }] } })
}
if (/CHANGE/.test(input)) {
  appendFileSync('report.md', 'More.\\n')
  rmSync('data/table.csv')
}
if (/OUTSIDE/.test(input)) {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'python3 calc.py > result.txt' } }] } })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo x > /tmp/voice-gw-scratch-outside' } }] } })
}
setTimeout(() => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done. The report is in report.md.' })
}, /SLOW/.test(input) ? 4000 : 50)
`

before(() => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  writeFileSync(join(BIN, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(BIN, 'claude'), 0o755)
  chmodSync(join(BIN, 'gh'), 0o755)
  process.env.FAKE_CLAUDE_LOG = CALLS
})

after(() => rmSync(TMP, { recursive: true, force: true }))

const calls = () =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []
const callOf = task => calls().find(call => call.input.startsWith(task))
const arg = (call, name) => call.args[call.args.indexOf(name) + 1]

async function until(predicate, ms = 10000) {
  for (const begun = Date.now(); Date.now() - begun < ms; await new Promise(resolve => setTimeout(resolve, 25))) {
    const value = await predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

let count = 0

// Workers with work folders in a root of their own, and a repository
// "alpha"; each finished run is checked and reported at once, as the
// gateway does it.
function setup({ scratch = true, maxRuns = 2, killswitch = null, ledger = null, days = 7, base = join(TMP, `case${++count}`) } = {}) {
  const root = join(base, 'Developer')
  const scratchRoot = join(base, 'voice-scratch')
  mkdirSync(join(root, 'alpha'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', join(root, 'alpha')])
  const stateDir = join(base, 'state')
  const make = (options = {}) => {
    const folders = (options.scratch ?? scratch) ? new ScratchFolders({ runner: new HostRunner(scratchRoot), root: scratchRoot, days }) : null
    const workers = new Workers({ root, stateDir, scratch: folders, claudeBin: join(BIN, 'claude'), ghBin: join(BIN, 'gh'), maxRuns, killswitch, ledger, killAfterMs: 1000 })
    workers.on('finished', task => workers.audit(task).then(() => workers.markReported(task)))
    return workers
  }
  const workers = make()
  const dispatch = (worker, task, extra = {}) => workers.dispatch({ worker, task, words: 'the words', ...extra })
  return { base, root, scratchRoot, stateDir, workers, make, dispatch }
}

const ended = task => until(() => task.state !== 'running' && task.reported && task)

// --- Workers --------------------------------------------------------------------

test('scratch/new: a new empty folder, the run in it with rules of its own; afterwards the files it made, and no decision', async () => {
  const ledger = new Ledger()
  const { workers, dispatch, scratchRoot } = setup({ ledger })
  try {
    assert.deepEqual(Object.keys(workers.kinds), ['repo', 'scratch'])
    assert.deepEqual(await workers.known(SCRATCH_NEW), [SCRATCH_NEW])
    const started = await dispatch(SCRATCH_NEW, 'MAKE: sum up the quarter in a report.')
    assert.equal(started.status, 'started')
    const { task, facts } = started
    assert.equal(task.kind, 'scratch')
    assert.match(task.repo, /^scratch\/[a-z0-9]{4}$/)
    assert.equal(facts.made, true)
    const folder = readdirSync(scratchRoot)
    assert.equal(folder.length, 1)
    assert.match(folder[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${task.repo.slice('scratch/'.length)}$`))
    assert.equal(task.dir, join(scratchRoot, folder[0]))
    assert.equal(task.hostDir, task.dir)
    assert.equal(task.container, null)
    assert.deepEqual(await workers.known(SCRATCH_NEW), [SCRATCH_NEW, task.repo])

    const call = await until(() => callOf('MAKE: sum up'))
    assert.equal(call.cwd, task.dir)
    assert.equal(call.repo, task.dir, 'the run is marked with its folder')
    const rules = arg(call, '--append-system-prompt')
    assert.match(rules, /^You are a worker\./)
    assert.match(rules, /Your work folder is the current directory/)
    assert.match(rules, /It is the only place you may write/)
    assert.doesNotMatch(rules, /voice\/<short-name>|gh pr create/)
    assert.match(call.input, /^MAKE: sum up the quarter in a report\.\n\nThe driver's own words: "the words"\n/)
    assert.match(call.input, new RegExp(`^- Work folder: ${task.repo}, new and empty$`, 'm'))
    assert.match(call.input, /^- It runs on this computer\.$/m)
    assert.doesNotMatch(call.input, /Repository:|Starting branch/)
    assert.ok(call.args.includes('--session-id'))

    await ended(task)
    assert.equal(task.state, 'done')
    assert.deepEqual(task.audit.made.sort(), ['data/table.csv', 'report.md'])
    assert.equal(task.decision, null, 'no push decision without git')
    assert.deepEqual(ledger.open(), [])
    assert.deepEqual(workers.checkMeta(task), { files: '2 files made' })
    const result = workers.resultText(task)
    assert.match(result, new RegExp(`^Worker ${task.repo} finished task ${task.id}: done after`))
    assert.match(result, /^Work folder check by the gateway: 2 files made \((data\/table\.csv, report\.md|report\.md, data\/table\.csv)\)\.$/m)
    assert.match(result, new RegExp(`^The work folder: ${task.dir} on this computer\\. Follow-ups and answers go to worker ${task.repo}\\.$`, 'm'))
    assert.ok(result.indexOf('Work folder check') < result.indexOf('Result:'), "the gateway's lines first")
    assert.match(workers.statusText(task.repo), /^Work folder check by the gateway: 2 files made/m)
  } finally {
    workers.close()
  }
})

test('a follow-up continues in the same folder and session, and counts only what it changed', async () => {
  const { workers, dispatch } = setup()
  try {
    const first = (await dispatch(SCRATCH_NEW, 'MAKE: write the report.')).task
    await ended(first)
    const session = arg(await until(() => callOf('MAKE: write the report.')), '--session-id')
    const next = await dispatch(first.repo, 'CHANGE: add a line, drop the table.')
    assert.equal(next.status, 'started')
    assert.equal(next.facts.made, false)
    assert.equal(next.task.repo, first.repo)
    assert.equal(next.task.dir, first.dir)
    assert.equal(next.task.resumed, true)
    const call = await until(() => callOf('CHANGE: add a line'))
    assert.equal(call.cwd, first.dir)
    assert.equal(arg(call, '--resume'), session)
    assert.match(call.input, new RegExp(`^- Work folder: ${first.repo}, with what earlier runs left: .*report\\.md`, 'm'))
    await ended(next.task)
    assert.deepEqual(next.task.audit.made, [])
    assert.deepEqual(next.task.audit.changed, ['report.md'])
    assert.deepEqual(next.task.audit.removed, ['data/table.csv'])
    assert.equal(workers.checkMeta(next.task).files, '1 changed, 1 removed')
  } finally {
    workers.close()
  }
})

test('any number of new work folders within the run slots; one run at a time in each', async () => {
  const { workers, dispatch } = setup({ maxRuns: 2 })
  try {
    const a = await dispatch(SCRATCH_NEW, 'SLOW: look up the first thing.')
    const b = await dispatch(SCRATCH_NEW, 'SLOW: look up the second thing.')
    assert.equal(a.status, 'started')
    assert.equal(b.status, 'started', 'a second new one at once: each has its own folder')
    assert.notEqual(a.task.repo, b.task.repo)
    const full = await dispatch(SCRATCH_NEW, 'Look up a third thing.')
    assert.equal(full.status, 'queued')
    assert.equal(full.reason, 'full', 'the global cap counts them')
    const busy = await dispatch(a.task.repo, 'Then add the sources.')
    assert.equal(busy.status, 'queued')
    assert.equal(busy.reason, 'busy', 'one run at a time in a folder')
    const list = await workers.listText()
    assert.match(list, /^\[workers=1 running=2 queued=2 max=2 scratch=on\]$/m)
    assert.match(list, new RegExp(`^scratch/new: a new empty work folder for a task without a repository .*, on this computer; idle; queued: ${full.entry.id} \\("Look up a third thing\\."\\)$`, 'm'))
    assert.match(list, new RegExp(`^${a.task.repo}: work folder made 0 minutes ago, running ${a.task.id} for .*; queued: ${busy.entry.id} `, 'm'))
    // The queued new one gets a folder of its own when it starts.
    workers.stop(a.task.repo)
    const third = await until(() => workers.state.tasks.find(t => t.queued === full.entry.id))
    assert.ok(![a.task.repo, b.task.repo].includes(third.repo))
    await ended(third)
    workers.stop(b.task.repo)
    const followUp = await until(() => workers.state.tasks.find(t => t.queued === busy.entry.id))
    assert.equal(followUp.repo, a.task.repo)
    await ended(followUp)
  } finally {
    workers.close()
  }
})

test('old work folders go after their days, not while something runs, waits or is open there; others stay', async () => {
  const ledger = new Ledger()
  const { workers, dispatch, scratchRoot } = setup({ ledger })
  try {
    const old = (await dispatch(SCRATCH_NEW, 'MAKE: an old report.')).task
    const open = (await dispatch(SCRATCH_NEW, 'MAKE: another old report.')).task
    await ended(old)
    await ended(open)
    const recent = (await dispatch(SCRATCH_NEW, 'SLOW: a recent one.')).task
    mkdirSync(join(scratchRoot, 'mine')) // not made by the gateway
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    for (const task of [old, open, recent]) {
      Object.assign(workers.scratch.entry(task.repo), { createdAt: weekAgo, usedAt: weekAgo })
      task.finishedAt &&= weekAgo
    }
    ledger.add({ kind: 'other', repo: open.repo, text: 'Keep the report?' })
    workers.sweptAt = 0
    await workers.sweep()
    assert.ok(!existsSync(old.dir), 'removed')
    assert.equal(workers.scratch.entry(old.repo), null)
    assert.equal(workers.state.repos[old.repo], undefined, 'its session too')
    assert.ok(!(await workers.known(SCRATCH_NEW)).includes(old.repo))
    assert.ok(existsSync(open.dir), 'an open decision keeps it')
    assert.ok(existsSync(recent.dir), 'a run going keeps it')
    assert.ok(existsSync(join(scratchRoot, 'mine')), 'not the gateway\'s')
    const gone = await dispatch(old.repo, 'Look again.')
    assert.equal(gone.status, 'unknown')
    workers.stop(recent.repo)
    await ended(recent)
  } finally {
    workers.close()
  }
})

test('the kill switch: no new work folder while locked, and a run in one stops like any other', async () => {
  const base = join(TMP, `case${++count}`)
  const killswitch = new KillSwitch({ file: join(base, 'killswitch.json'), log: () => {} })
  const { workers, dispatch, scratchRoot } = setup({ killswitch, base })
  try {
    const run = (await dispatch(SCRATCH_NEW, 'SLOW: a long look.')).task
    const second = await dispatch(SCRATCH_NEW, 'Then another.')
    assert.equal(second.status, 'started', 'two slots')
    const third = await dispatch(SCRATCH_NEW, 'And a third.')
    assert.equal(third.status, 'queued')
    killswitch.trip({ trigger: 'voice', reason: 'emergency stop' })
    assert.deepEqual(workers.parkAll().map(entry => entry.id), [third.entry.id])
    const stopped = workers.stopAll('kill switch (voice)')
    assert.ok(stopped.includes(run))
    await until(() => run.state !== 'running')
    assert.equal(run.state, 'stopped')
    const before = readdirSync(scratchRoot).length
    assert.equal((await dispatch(SCRATCH_NEW, 'One more.')).status, 'locked')
    assert.equal(readdirSync(scratchRoot).length, before, 'no folder made')
  } finally {
    workers.close()
  }
})

test('the rules: a run in a work folder writes only there and in its memory folder, not even in /tmp', async () => {
  const { workers, dispatch } = setup()
  const tripped = []
  const guard = new RunGuard({
    workers,
    runner: workers.runner,
    killswitch: { trip: event => tripped.push(event) },
    ghBin: join(BIN, 'gh'),
    allowed: ['/opt/allowed'],
    limits: { maxFiles: 1 },
    mainCheckSeconds: 3600,
    log: () => {},
  })
  try {
    const { task } = await dispatch(SCRATCH_NEW, 'MAKE OUTSIDE: compute it.')
    await ended(task)
    await until(() => tripped.length >= 2)
    const reasons = tripped.map(event => event.reason)
    assert.match(reasons[0], new RegExp(`^write outside the allowed folders: "echo x > /tmp/voice-gw-scratch-outside" writes /tmp/voice-gw-scratch-outside \\(worker ${task.repo}, task ${task.id}\\)$`))
    assert.match(reasons[1], new RegExp(`^many changes: more than 1 files in the work folder after one run \\(worker ${task.repo}`))
    assert.equal(tripped.length, 2, 'its own folder is no write outside')

    // The same commands in a repository's run: /tmp is fine there.
    const plain = new EventEmitter()
    const repoTripped = []
    const repoGuard = new RunGuard({ workers: plain, runner: workers.runner, killswitch: { trip: e => repoTripped.push(e) }, mainCheckSeconds: 3600, log: () => {} })
    const repoTask = { id: 'trep', repo: 'alpha', dir: '/work/alpha', startedAt: Date.now() }
    plain.emit('started', repoTask)
    plain.emit('tool', repoTask, { type: 'tool_use', name: 'Bash', input: { command: 'echo x > /tmp/voice-gw-scratch-outside' } })
    assert.deepEqual(repoTripped, [])
    repoGuard.close()

    // Its memory folder is its own; the allowed paths of repositories are not its.
    const scratchTask = { id: 'tscr', kind: 'scratch', repo: 'scratch/abcd', dir: '/scratch/2026-01-01-abcd', startedAt: Date.now() }
    const third = new EventEmitter()
    const thirdTripped = []
    const scratchGuard = new RunGuard({ workers: third, runner: workers.runner, killswitch: { trip: e => thirdTripped.push(e.reason) }, allowed: ['/opt/allowed'], mainCheckSeconds: 3600, log: () => {} })
    third.emit('started', scratchTask)
    third.emit('tool', scratchTask, { type: 'tool_use', name: 'Write', input: { file_path: `${homedir()}/.claude/projects/-scratch-2026-01-01-abcd/memory/note.md` } })
    third.emit('tool', scratchTask, { type: 'tool_use', name: 'Write', input: { file_path: 'notes/a.md' } })
    assert.deepEqual(thirdTripped, [])
    third.emit('tool', scratchTask, { type: 'tool_use', name: 'Write', input: { file_path: '/opt/allowed/x' } })
    assert.match(thirdTripped[0], /^write outside the allowed folders: Write \/opt\/allowed\/x/)
    scratchGuard.close()
  } finally {
    guard.close()
    workers.close()
  }
})

test('after a restart: the work folders, a queued new one and a follow-up go on; turned off, the queue says so', async () => {
  const { workers, make, dispatch } = setup({ maxRuns: 1 })
  const first = (await dispatch(SCRATCH_NEW, 'MAKE: the first report.')).task
  await ended(first)
  const slow = (await dispatch(first.repo, 'SLOW: read it again.')).task
  const queued = await dispatch(SCRATCH_NEW, 'A second report.')
  assert.equal(queued.status, 'queued')
  workers.close() // the gateway restarts; the run goes on
  const next = make()
  try {
    assert.deepEqual(await next.known(SCRATCH_NEW), [SCRATCH_NEW, first.repo], 'known again')
    assert.equal(next.dirOf(first.repo), first.dir)
    const adopted = next.running().find(t => t.id === slow.id)
    assert.ok(adopted, 'still followed')
    await until(() => adopted.state !== 'running' && adopted.reported, 12000)
    assert.equal(adopted.state, 'done')
    assert.deepEqual(adopted.audit.made, [])
    const second = await until(() => next.state.tasks.find(t => t.queued === queued.entry.id))
    assert.notEqual(second.repo, first.repo, 'a folder of its own')
    await until(() => second.reported)
  } finally {
    next.close()
  }

  // Turned off: a new one waiting in the queue cannot start, and says why.
  const off = make({ scratch: false })
  try {
    let parked = null
    off.once('parked', (entry, why) => (parked = why))
    off.state.queue.push({ id: 'qoff', worker: SCRATCH_NEW, task: 'A third report.', words: 'the words', queuedAt: Date.now() })
    const why = await until(() => parked)
    assert.equal(why, 'work folders are turned off')
    assert.equal(off.workspace(SCRATCH_NEW), null)
    assert.equal((await off.dispatch({ worker: SCRATCH_NEW, task: 'x', words: 'the words' })).status, 'unknown')
    assert.ok(off.state.scratch[first.repo.slice('scratch/'.length)], 'its folders are kept for later')
  } finally {
    off.close()
  }
})

test('a run in a work folder that began before the gateway turned them off is still followed where it runs', async () => {
  const { workers, make, dispatch } = setup()
  const { task } = await dispatch(SCRATCH_NEW, 'SLOW MAKE: a long look.')
  workers.close()
  const off = make({ scratch: false })
  try {
    const adopted = off.running().find(t => t.id === task.id)
    assert.ok(adopted)
    const runner = off.runnerOf(adopted)
    assert.ok(runner instanceof HostRunner)
    assert.notEqual(runner, off.runner, 'not the repositories\'')
    await until(() => adopted.state !== 'running' && adopted.reported, 12000)
    assert.deepEqual(adopted.audit.made.sort(), ['data/table.csv', 'report.md'])
  } finally {
    off.close()
  }
})

test('the saved work folders: only ids and folder names the gateway makes', () => {
  const entries = scratchEntries({
    abcd: { folder: '2026-10-29-abcd', createdAt: 1, usedAt: 2 },
    efgh: { folder: '../../home', createdAt: 1 },
    ijkm: { folder: '2026-10-29-zzzz', createdAt: 1 },
    'x/..': { folder: '2026-10-29-x/..', createdAt: 1 },
    npqr: { folder: '2026-10-29-npqr' },
    __proto__: { folder: '2026-10-29-abcd', createdAt: 1 },
  })
  assert.deepEqual(Object.keys(entries), ['abcd'])
  assert.deepEqual(entries.abcd, { folder: '2026-10-29-abcd', createdAt: 1, usedAt: 2 })
  assert.equal(Object.getPrototypeOf(entries), null)
})

test('the root of the work folders: outside every repository, this checkout and the repositories folder', () => {
  const base = join(TMP, 'roots')
  const repo = join(base, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const gateway = join(base, 'gateway')
  const developer = join(base, 'Developer')
  mkdirSync(gateway, { recursive: true })
  const check = root => scratchProblem(root, { gateway, workerRoot: developer, home: join(base, 'home') })
  assert.equal(check(join(base, 'voice-scratch')), null)
  assert.equal(check(join(base, 'not', 'there', 'yet')), null, 'made at the first task')
  assert.equal(check('voice-scratch'), 'is not an absolute path')
  assert.equal(check(join(base, 'home')), 'is the home folder itself')
  assert.equal(check(join(gateway, 'scratch')), "is inside the gateway's own checkout")
  assert.equal(check(base), "holds the gateway's own checkout")
  assert.equal(check(join(developer, 'scratch')), 'is inside the repositories folder (VOICE_GW_WORKER_ROOT)')
  assert.equal(check(join(repo, 'scratch')), `is inside the git repository ${repo}`)
})

test('what changed in a folder, in words for the attribute and in a line with the names', () => {
  const before = [{ path: 'a.md', bytes: 1, mtime: 1 }, { path: 'b.md', bytes: 1, mtime: 1 }, { path: 'c.md', bytes: 1, mtime: 1 }]
  const after = [{ path: 'a.md', bytes: 1, mtime: 1 }, { path: 'b.md', bytes: 2, mtime: 5 }, { path: 'd.pdf', bytes: 9, mtime: 5 }]
  const check = { ok: true, ...fileChanges(before, after, 100) }
  assert.deepEqual(check, { ok: true, made: ['d.pdf'], changed: ['b.md'], removed: ['c.md'], more: false })
  assert.equal(filesSummary(check), '1 file made, 1 changed, 1 removed')
  assert.equal(filesText(check), 'Work folder check by the gateway: 1 file made (d.pdf), 1 changed (b.md), 1 removed (c.md).')
  const none = { ok: true, ...fileChanges(before, before, 100) }
  assert.equal(filesSummary(none), 'nothing made or changed')
  assert.equal(filesText(none), 'Work folder check by the gateway: no file made, changed or removed.')
  assert.equal(filesSummary({ ok: false }), 'not checked')
  assert.match(filesText({ ok: false }), /not possible, the folder could not be read/)
})

// --- the gateway --------------------------------------------------------------------

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))

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

async function startGateway(env = {}) {
  const port = await freePort()
  const base = join(TMP, `gateway${++count}`)
  mkdirSync(join(base, 'Developer', 'alpha'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', join(base, 'Developer', 'alpha')])
  const events = []
  const claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => events.push(params),
  )
  let log = ''
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: join(base, 'secrets'),
      VOICE_GW_STATE_DIR: join(base, 'state'),
      VOICE_GW_WORKER_ROOT: join(base, 'Developer'),
      VOICE_GW_SCRATCH_ROOT: join(base, 'voice-scratch'),
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'gh'),
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_SELF_CHECKOUT: '',
      VOICE_GW_SCRATCH: '',
      VOICE_GW_MAX_WORKERS: '2',
      VOICE_GW_PR_DRAFT: '',
      ...env,
    },
    stderr: 'pipe',
  })
  transport.stderr.on('data', chunk => (log += chunk))
  await claudeCode.connect(transport)
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await new Promise(r => setTimeout(r, 50))
    }
  }
  const { access_token } = await adminRequest(join(base, 'secrets', 'admin.sock'), 'POST', '/token', { name: 'test' })
  const voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await voice.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    }),
  )
  const text = result => result.content.map(c => c.text).join('\n')
  return {
    base,
    events,
    log: () => log,
    claudeCode,
    controller: async (name, args = {}) => {
      const result = await claudeCode.callTool({ name, arguments: args })
      return { text: text(result), isError: result.isError }
    },
    say: async message => text(await voice.callTool({ name: 'send', arguments: { message } })),
    tools: async () => (await claudeCode.listTools()).tools,
    close: async () => {
      await voice.close()
      await claudeCode.close()
    },
  }
}

test('the gateway with VOICE_GW_SCRATCH=1: scratch/new in the tools, the instructions and list_workers; a result with files="…"', async () => {
  const gw = await startGateway({ VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_DAYS: '3' })
  try {
    const instructions = gw.claudeCode.getInstructions()
    assert.match(instructions, /^Work folders: the driver turned them on\. A task that needs no repository/m)
    assert.match(instructions, /goes to dispatch with worker "scratch\/new": a run in a new empty folder, on this computer\./)
    assert.match(instructions, /It is removed 3 days after its last\s+run\./)
    const tools = await gw.tools()
    const dispatchTool = tools.find(tool => tool.name === 'dispatch')
    assert.match(dispatchTool.description, /worker "scratch\/new": a run in a new empty work folder, on this computer, with no git/)
    assert.match(dispatchTool.inputSchema.properties.worker.description, /scratch\/new for a new work folder/)
    assert.match(tools.find(tool => tool.name === 'stop_worker').inputSchema.properties.worker.description, /scratch\/<id>/)
    assert.match(gw.log(), /work folders on: a new folder per task in .*voice-scratch, on this computer, removed 3 days after their last run/)
    const list = await gw.controller('list_workers')
    assert.match(list.text, /^\[workers=1 running=0 max=2 scratch=on\]$/m)
    assert.match(list.text, /^alpha: no remote, branch main, clean, idle$/m)
    assert.match(list.text, /^scratch\/new: a new empty work folder for a task without a repository \(a question, research, a calculation, a draft, a conversion\), on this computer; idle$/m)

    // Only on the driver's words, as for a repository.
    const refused = await gw.controller('dispatch', { worker: SCRATCH_NEW, task: 'MAKE: a report.', words: 'make a report please' })
    assert.match(refused.text, /^\[dispatch=needs_driver worker=scratch\/new\] Nothing started\./)
    assert.ok(!existsSync(join(gw.base, 'voice-scratch')), 'no folder made')

    await gw.say('Mach mir einen Bericht über das Quartal, als Entwurf.')
    const started = await gw.controller('dispatch', {
      worker: SCRATCH_NEW,
      task: 'MAKE: write a report on the quarter.',
      words: 'Mach mir einen Bericht über das Quartal',
      draft: true,
      direct: true,
    })
    const name = /worker=(scratch\/[a-z0-9]{4})/.exec(started.text)?.[1]
    assert.ok(name, started.text)
    assert.match(
      started.text,
      new RegExp(
        `^\\[dispatch=started worker=${name} task=t[a-z0-9]{3} session=new\\] Started in a new work folder, ${name}\\. Tell the ` +
          `driver it is on its way\\. When it ends, a channel event with worker="${name}" arrives; follow-ups and answers go ` +
          'to that name\\. direct and draft have no effect in a work folder\\.$',
      ),
    )
    const event = await until(() => gw.events.find(e => e.meta?.worker === name))
    assert.equal(event.meta.outcome, 'done')
    assert.equal(event.meta.trusted, 'no')
    assert.equal(event.meta.files, '2 files made')
    assert.equal(event.meta.git, undefined, 'no git there')
    assert.equal(event.meta.decision, undefined)
    assert.match(event.content, /^Work folder check by the gateway: 2 files made \(/m)
    assert.match(event.content, new RegExp(`^The work folder: ${gw.base}/voice-scratch/\\d{4}-\\d{2}-\\d{2}-[a-z0-9]{4} on this computer\\.`, 'm'))
    assert.equal((await gw.controller('reply', { request_id: event.meta.request_id, state: 'done', text: 'Der Bericht ist fertig.' })).isError, false)
    assert.match((await gw.controller('list_workers')).text, new RegExp(`^${name}: work folder made 0 minutes ago, idle, last task t[a-z0-9]{3} done`, 'm'))
    assert.match((await gw.controller('worker_status', { worker: name })).text, /^Work folder check by the gateway: 2 files made/m)

    // A name it does not know, with the prefix.
    const unknown = await gw.controller('dispatch', { worker: 'scratch/zzzz', task: 'x', words: 'x y' })
    assert.equal(unknown.isError, true)
    assert.match(unknown.text, new RegExp(`^No work folder "scratch/zzzz": it was removed 3 days after its last run, or never made\\. Known: scratch/new, ${name}\\.`))
  } finally {
    await gw.close()
  }
})

test('the gateway with work folders off, the default: tools, instructions and list_workers as before', async () => {
  const gw = await startGateway()
  try {
    assert.doesNotMatch(gw.claudeCode.getInstructions(), /work folder|scratch/i)
    for (const tool of await gw.tools()) assert.doesNotMatch(JSON.stringify(tool), /work folder|scratch/i, tool.name)
    const list = await gw.controller('list_workers')
    assert.equal(list.text, '[workers=1 running=0 max=2]\nalpha: no remote, branch main, clean, idle')
    await gw.say('Mach mir einen Bericht über das Quartal.')
    const out = await gw.controller('dispatch', { worker: SCRATCH_NEW, task: 'MAKE: a report.', words: 'Mach mir einen Bericht' })
    assert.equal(out.isError, true)
    assert.equal(out.text, 'No repository "scratch/new". Known: alpha.')
    assert.ok(!existsSync(join(gw.base, 'voice-scratch')))
    assert.doesNotMatch(gw.log(), /work folders/)
  } finally {
    await gw.close()
  }
})

test('the gateway turns work folders off where their root is no place for them, and says why', async () => {
  const gw = await startGateway({ VOICE_GW_SCRATCH: '1', VOICE_GW_SCRATCH_ROOT: fileURLToPath(new URL('../scratch-here', import.meta.url)) })
  try {
    assert.match(gw.log(), /work folders off: VOICE_GW_SCRATCH_ROOT=.*scratch-here is inside the gateway's own checkout/)
    assert.doesNotMatch(gw.claudeCode.getInstructions(), /Work folders/)
    assert.doesNotMatch((await gw.controller('list_workers')).text, /scratch/)
  } finally {
    await gw.close()
  }
})
