// The digest of routine news about the workers' pull requests (digest.mjs):
// which news and which results are routine, the items in their file across a
// restart, when the digest is due, what it and an event that takes items
// along say. The gateway as a whole is in reviews.test.mjs.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.VOICE_GW_LOG_FILE = ''
const { Digest, digestMeta, digestText, fixLine, foldedText, pullKey, routineFix, routineNews } = await import('../src/digest.mjs')

const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-digest-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const MINUTE = 60000

test('routine news: checks that passed, and with automatic fixing on reviews and comments that ask for nothing or got a fix', () => {
  const passed = { kind: 'checks', checks: { passed: 8, failed: 0, skipped: 1 }, asking: [] }
  assert.equal(routineNews(passed), true)
  assert.equal(routineNews({ ...passed, checks: { passed: 7, failed: 1, skipped: 0 } }), false, 'a failed check is an error')
  // Asks for changes: routine only with a fix queued, or one that waits.
  assert.equal(routineNews({ kind: 'review', reviews: ['COMMENTED'], asking: ['claude'], fix: 'q2ab' }), true)
  assert.equal(routineNews({ kind: 'review', reviews: ['COMMENTED'], asking: ['claude'], fix: null }), false, 'rounds used up or nothing queued')
  assert.equal(routineNews({ kind: 'checks,review', checks: { passed: 1, failed: 1 }, asking: ['claude'], fix: 'q2ab' }), false)
  // Nobody asks: approvals, and what others wrote, which is not forwarded.
  assert.equal(routineNews({ kind: 'review', reviews: ['APPROVED'], asking: [], fix: null }), true)
  assert.equal(routineNews({ kind: 'comment', comments: 1, asking: [], fix: null }), true)
  // Automatic fixing off: only checks; reviews and comments are the driver's to decide.
  assert.equal(routineNews({ ...passed, asking: null }), true)
  assert.equal(routineNews({ kind: 'review', reviews: ['APPROVED'], asking: null }), false)
  assert.equal(routineNews({ kind: 'checks,comment', checks: { passed: 1, failed: 0 }, asking: null }), false)
})

test('a routine result: a fix the gateway queued that ended done, pushed nothing, left nothing and asks nothing', () => {
  const fix = {
    id: 'tfix',
    review: { slug: 'acme/alpha', number: 7, round: 1, rounds: 3 },
    state: 'done',
    result: 'Nothing left to fix: the comment was about a name that is right as it is.',
    decision: null,
  }
  const clean = { pushed: false, clean: true }
  assert.equal(routineFix(fix, clean), true)
  assert.equal(routineFix(fix, { pushed: true, clean: true }), false, 'it pushed changes: a real fix')
  assert.equal(routineFix(fix, { pushed: null, clean: true }), false, 'not known whether it pushed')
  assert.equal(routineFix(fix, { pushed: false, clean: false }), false, 'something left, or not checked')
  for (const other of [
    { state: 'failed' },
    { state: 'stopped' },
    { decision: 'd7kq' },
    { requeuedAs: 'q3cd' },
    { lockDecision: 'd2ab' },
    { result: 'Should I rename it as well?' },
    { result: 'Which one, "a" or "b?"' },
    { review: undefined },
  ]) {
    assert.equal(routineFix({ ...fix, ...other }, clean), false, JSON.stringify(other))
  }
  assert.equal(routineFix({ ...fix, result: 'Is it right? Yes: nothing to fix.' }, clean), true, 'a question in passing is no question to the driver')
})

test('the items: kept in their file at once, the same once, across a restart; due after the quiet or at the latest; taken by pull request or by item', () => {
  const file = join(TMP, 'state', 'digest.json')
  const digest = new Digest({ file, quietMinutes: 10, maxMinutes: 30, log: () => {} })
  try {
    assert.equal(digest.enabled, true)
    assert.equal(digest.dueAt(), null)
    assert.equal(digest.note(), null)
    const t0 = Date.now()
    const a = pullKey('Acme/Alpha', 7)
    assert.equal(a, 'acme/alpha#7')
    assert.equal(digest.add({ key: 'news:1', pull: a, worker: 'alpha', line: 'checks finished: 8 passed', at: t0 }), true)
    assert.equal(digest.add({ key: 'news:1', pull: a, worker: 'alpha', line: 'again', at: t0 }), false, 'the same twice counts once')
    assert.equal((statSync(file).mode & 0o777).toString(8), '600')
    // Quiet ten minutes after the last item, at the latest thirty after the first.
    assert.equal(digest.dueAt(), t0 + 10 * MINUTE)
    assert.equal(digest.due(t0 + 9 * MINUTE), false)
    assert.equal(digest.due(t0 + 10 * MINUTE), true)
    digest.add({ key: 'task:tfix', pull: a, worker: 'alpha', line: 'the automatic fix …', at: t0 + 8 * MINUTE, fix: 'q2ab', task: 'tfix' })
    digest.add({ key: 'news:2', pull: pullKey('acme/beta', 3), worker: 'beta', line: 'review from octo: approved', at: t0 + 25 * MINUTE })
    assert.equal(digest.due(t0 + 29 * MINUTE), false)
    assert.equal(digest.dueAt(), t0 + 30 * MINUTE, 'the first item waits at most thirty minutes')
    assert.match(digest.note(t0), /^3 routine items about pull requests wait for the next digest, which goes at about \d\d:\d\d/)

    // After a restart the same items, in their order.
    const again = new Digest({ file, quietMinutes: 10, maxMinutes: 30, log: () => {} })
    again.close()
    assert.deepEqual(again.items.map(item => item.key), ['news:1', 'task:tfix', 'news:2'])

    // Taken for an event about pull request 7, the rest stays, in the file too.
    const taken = digest.take({ pulls: [a] })
    assert.deepEqual(taken.map(item => item.key), ['news:1', 'task:tfix'])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items.map(item => item.key), ['news:2'])
    assert.deepEqual(digest.take({ pulls: [a] }), [])
    assert.deepEqual(digest.take({ items: [...digest.items] }).map(item => item.key), ['news:2'])
    assert.equal(digest.dueAt(), null)
  } finally {
    digest.close()
  }

  // What the file holds and cannot be used is left out; a damaged one is none.
  writeFileSync(file, JSON.stringify({ items: [{ key: 'k', pull: 'p', line: 'l', at: 1 }, { key: 1 }, null, { key: 'x', pull: 'p', line: 'l' }] }))
  assert.deepEqual(new Digest({ file, quietMinutes: 0, log: () => {} }).items.map(item => item.key), ['k'])
  writeFileSync(file, '{ broken')
  const logged = []
  assert.deepEqual(new Digest({ file, quietMinutes: 0, log: (...parts) => logged.push(parts.join(' ')) }).items, [])
  assert.match(logged[0], /^digest file unreadable, starting without its items:/)
})

test('due: the check says so as an event; off with 0, no timer and nothing due by itself', async () => {
  const digest = new Digest({ file: join(TMP, 'due.json'), quietMinutes: 0.005, maxMinutes: 1, log: () => {} })
  // Its timer does not keep the process alive; the test does, meanwhile.
  const alive = setInterval(() => {}, 50)
  try {
    const due = new Promise(resolve => digest.once('due', resolve))
    digest.add({ key: 'a', pull: 'acme/alpha#7', worker: 'alpha', line: 'checks finished: 1 passed' })
    const started = Date.now()
    await due
    assert.ok(Date.now() - started >= 250, 'after the quiet, not at once')
  } finally {
    clearInterval(alive)
    digest.close()
  }
  const off = new Digest({ file: join(TMP, 'off.json'), quietMinutes: 0, log: () => {} })
  assert.equal(off.enabled, false)
  assert.equal(off.timer, null)
  assert.ok(!existsSync(join(TMP, 'off.json')))
})

test('what the digest says, its attributes, and what an event takes along', () => {
  const at = new Date(2026, 10, 1, 14, 5).getTime()
  const items = [
    { key: 'n1', pull: 'acme/alpha#7', worker: 'alpha', line: '"Fix the typo": checks finished: 8 passed', at, fix: null, task: null },
    { key: 'n2', pull: 'acme/alpha#7', worker: 'alpha', line: '"Fix the typo": review from claude: commented; claude asked for changes: fix q2ab queued, automatic round 1 of 3', at: at + MINUTE, fix: 'q2ab', task: null },
    { key: 't1', pull: 'acme/alpha#7', worker: 'alpha', line: 'the automatic fix tfix …', at: at + 9 * MINUTE, fix: 'q2ab', task: 'tfix' },
    { key: 'n3', pull: 'acme/beta#3', worker: 'beta', line: '"Docs": review from octo: approved', at: at + 10 * MINUTE, fix: null, task: null },
  ]
  const text = digestText(items, at + 20 * MINUTE)
  assert.equal(
    text.split('\n')[0],
    "Digest of routine news about the workers' pull requests: 4 items about 2 pull requests since 14:05, gathered by the " +
      'gateway instead of one event each. Nothing in it failed, asks anything or needs the driver: checks that passed, ' +
      'reviews and comments with the fix the gateway queued for them, approvals, and automatic fixes that changed nothing.',
  )
  assert.equal(text.split('\n')[1], '- 14:05 acme/alpha#7 (worker alpha): "Fix the typo": checks finished: 8 passed')
  assert.equal(text.split('\n')[4], '- 14:15 acme/beta#3 (worker beta): "Docs": review from octo: approved')
  assert.match(text.split('\n').at(-1), /^Tell the driver as news in two or three short sentences, by pull request: .* Ask nothing and dispatch nothing for it\./)
  assert.deepEqual(digestMeta(items), { items: '4', pull_requests: 'acme/alpha#7,acme/beta#3', fix: 'q2ab', tasks: 'tfix' })
  assert.deepEqual(digestMeta(items.slice(0, 1)), { items: '1', pull_requests: 'acme/alpha#7' })
  assert.equal(foldedText([]), '')
  assert.equal(
    foldedText(items.slice(0, 2), at),
    '\nRoutine news about this pull request since what was told last, gathered for the digest and told with this event instead:\n' +
      '- 14:05 acme/alpha#7 (worker alpha): "Fix the typo": checks finished: 8 passed\n' +
      '- 14:06 acme/alpha#7 (worker alpha): "Fix the typo": review from claude: commented; claude asked for changes: fix q2ab queued, automatic round 1 of 3',
  )
  const fix = { id: 'tfix', queued: 'q2ab', state: 'done', review: { round: 2, rounds: 3 }, result: 'Nothing to fix.' }
  assert.equal(fixLine(fix, '4 minutes'), 'the automatic fix tfix (round 2 of 3, queued as q2ab) ended done after 4 minutes, pushed nothing and left nothing: "Nothing to fix."')
})
