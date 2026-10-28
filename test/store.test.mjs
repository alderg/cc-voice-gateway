// The gateway's state on disk: the saved requests (src/store.mjs) and the log
// file (src/log.mjs). What the voice client has read is saved too, a file
// with bad entries does not stop the start, answered approvals do not pile
// up, and the log is rotated. Everything happens in a temporary folder.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESTART_NOTE, Store } from '../src/store.mjs'
import { fileLog } from '../src/log.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-store-'))
const LOG_MODULE = fileURLToPath(new URL('../src/log.mjs', import.meta.url))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const mode = path => statSync(path).mode & 0o777
const saved = file => JSON.parse(readFileSync(file, 'utf8')).requests

after(() => rmSync(TMP, { recursive: true, force: true }))

function store(name, options = {}) {
  const logged = []
  const file = join(TMP, name, 'state', 'requests.json')
  const s = new Store({ file, log: (...parts) => logged.push(parts.join(' ')), ...options })
  return { store: s, file, logged }
}

// --- what the voice client has read ------------------------------------------------

test('what the voice client read reaches the file, without waking the long-polls', async () => {
  const { store: s, file } = store('read')
  const request = s.createRequest('How many files are there?')
  s.addUpdate(request.id, 'done', 'Three files.')
  await sleep(250) // past the save delay
  assert.equal(saved(file)[0].cursor, 0)

  let changes = 0
  s.on('change', () => changes++)
  assert.equal(s.takeUnread(request)[0].text, 'Three files.')
  s.markClosed(request)
  await sleep(250)
  assert.equal(changes, 0, 'reading is no change for the waiting long-polls or the Telegram fallback')
  assert.deepEqual([saved(file)[0].cursor, saved(file)[0].closed], [1, true])

  // Read once more: nothing new, nothing to save.
  assert.deepEqual(s.takeUnread(request), [])
})

test('the requests file and its folder are only for this user', async () => {
  const { store: s, file } = store('modes')
  s.createRequest('Hello?')
  await sleep(250)
  assert.equal(mode(file), 0o600)
  assert.equal(mode(join(TMP, 'modes', 'state')), 0o700)
})

// --- answering a question ------------------------------------------------------------

test('an answered question is settled: not open, nothing to deliver, no note after a restart', async () => {
  const { store: s, file, logged } = store('answered')
  const question = s.createRequest('Clean up the repository.')
  s.addUpdate(question.id, 'question', 'Delete the branches too?')
  const answer = s.createRequest(`(Answer to ${question.id}) No.`)
  s.markAnswered(question, answer.id)
  assert.deepEqual(s.openRequests().map(r => r.id), [answer.id])
  assert.equal(question.state, 'done')
  assert.equal(s.hasUnread(question), false)
  assert.equal(question.answeredBy, answer.id)
  s.save()

  const restored = new Store({ file, log: (...parts) => logged.push(parts.join(' ')) })
  const again = restored.getRequest(question.id)
  assert.equal(again.state, 'done')
  assert.ok(!again.updates.some(update => update.text === RESTART_NOTE), 'no restart note on an answered question')
  assert.ok(restored.getRequest(answer.id).updates.some(update => update.text === RESTART_NOTE), 'the answer itself was open')
  assert.deepEqual(logged, [])
})

// --- a damaged file ------------------------------------------------------------------

test('bad entries in the requests file are skipped and logged, the rest is restored', () => {
  const { file } = store('damaged')
  mkdirSync(join(TMP, 'damaged', 'state'), { recursive: true })
  const good = { id: 'good', text: 'Run the tests.', origin: 'voice', state: 'done', createdAt: Date.now(), updates: [{ at: Date.now(), state: 'done', text: 'All pass.' }], cursor: 0, closed: false }
  writeFileSync(
    file,
    JSON.stringify({
      requests: [
        good,
        { id: 'noupdates', text: 'x', origin: 'voice', state: 'sent', createdAt: Date.now(), cursor: 0 },
        null,
        'a string',
        { ...good, id: 'badcursor', cursor: 5 },
        { ...good, id: 'badstate', state: 'lost' },
        { ...good, id: '' },
      ],
    }),
  )
  const logged = []
  const s = new Store({ file, log: (...parts) => logged.push(parts.join(' ')) })
  assert.deepEqual([...s.requests.keys()], ['good'])
  assert.equal(s.takeUnread(s.getRequest('good'))[0].text, 'All pass.')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /requests file .*requests\.json: skipped 6 unusable entries/)
})

test('a requests file that is not JSON is logged, and replaced at the next change', async () => {
  const { file } = store('unreadable')
  mkdirSync(join(TMP, 'unreadable', 'state'), { recursive: true })
  writeFileSync(file, '{"requests": [ {"id": "half')
  const logged = []
  const s = new Store({ file, log: (...parts) => logged.push(parts.join(' ')) })
  assert.equal(s.requests.size, 0)
  assert.match(logged.join('\n'), /requests file .*requests\.json unreadable, starting without the saved requests: /)

  s.createRequest('Hello again.')
  await sleep(250)
  assert.equal(saved(file).length, 1)

  writeFileSync(file, '{"something": "else"}')
  const other = []
  new Store({ file, log: (...parts) => other.push(parts.join(' ')) })
  assert.match(other.join('\n'), /holds no list of requests/)

  // No file at all is the normal first start: nothing to say.
  const quiet = []
  new Store({ file: join(TMP, 'unreadable', 'none', 'requests.json'), log: (...parts) => quiet.push(parts.join(' ')) })
  assert.deepEqual(quiet, [])
})

// --- approvals ---------------------------------------------------------------------

test('answered approvals leave after the TTL, like open ones', async () => {
  const s = new Store({ permissionTtlSeconds: 0.1 })
  s.addPermission({ request_id: 'abcde', tool_name: 'Bash', description: 'Run ls', input_preview: '' })
  s.addPermission({ request_id: 'fghjk', tool_name: 'Write', description: 'Write a file', input_preview: '' })
  assert.ok(s.resolvePermission('abcde', 'allow'))
  assert.equal(s.resolvePermission('abcde', 'deny'), null, 'answered once')
  assert.equal(s.permissions.size, 2)
  await sleep(150)
  assert.deepEqual(s.openPermissions(), [])
  assert.equal(s.permissions.size, 0, 'neither the open nor the answered one is kept')
})

// --- the log file ------------------------------------------------------------------

test('the log file is rotated past its size, keeps one old file, and is only for this user', () => {
  const dir = join(TMP, 'logs', 'nested')
  const file = join(dir, 'gateway.log')
  const write = fileLog(file, { maxBytes: 1000 })
  assert.equal(existsSync(dir), false, 'nothing on disk before the first line')
  for (let i = 0; i < 60; i++) write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(50)}\n`)
  assert.ok(statSync(file).size <= 1000)
  assert.ok(statSync(`${file}.1`).size <= 1000)
  assert.match(readFileSync(file, 'utf8'), /line 59/)
  assert.doesNotMatch(readFileSync(`${file}.1`, 'utf8'), /line 0[0-9] /, 'only one old file is kept')
  assert.equal(mode(file), 0o600)
  assert.equal(mode(`${file}.1`), 0o600)
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(join(TMP, 'logs')), 0o700)

  // A log file from before, readable for everyone, is tightened at the first line.
  const old = join(TMP, 'old.log')
  writeFileSync(old, 'from before\n', { mode: 0o644 })
  fileLog(old)('now\n')
  assert.equal(mode(old), 0o600)
  assert.equal(readFileSync(old, 'utf8'), 'from before\nnow\n')
})

test('VOICE_GW_LOG_MAX_MB sets the size of the gateway log', () => {
  const file = join(TMP, 'configured', 'gateway.log')
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import { log } from ${JSON.stringify(LOG_MODULE)}; for (let i = 0; i < 40; i++) log('x'.repeat(60))`],
    {
      env: { ...process.env, VOICE_GW_LOG_FILE: file, VOICE_GW_LOG_MAX_MB: '0.002', VOICE_GW_SECRETS_DIR: join(TMP, 'no-secrets') },
      stdio: 'ignore',
    },
  )
  assert.ok(existsSync(`${file}.1`))
  assert.ok(statSync(file).size <= 0.002 * 1024 * 1024)
})
