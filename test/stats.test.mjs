// The statistics (src/stats.mjs): what a run's output says it used, the
// counters from the gateway's events, the file across a restart and a crash,
// the texts, scripts/stats.mjs for the watchdog, /stats on Telegram, and the
// gateway as a whole: a worker run counted, the controller's tool stats, and
// the message when the gateway shuts down without the watchdog.
//
// A local HTTP server stands in for the Telegram Bot API, a small script for
// claude; the real .state stays untouched.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

process.env.VOICE_GW_LOG_FILE = ''
const { adminRequest } = await import('../src/admin.mjs')
const { Store } = await import('../src/store.mjs')
const { Ledger } = await import('../src/ledger.mjs')
const { TelegramCommands, statsCommand } = await import('../src/telegram.mjs')
const stats = await import('../src/stats.mjs')
const { Stats, addResult, amount, detailsLines, overviewText, readStats, resultUsage, shutdownText, span, toolText, totalLine } = stats

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const GATEWAY = join(ROOT, 'src', 'gateway.mjs')
const SCRIPT = join(ROOT, 'scripts', 'stats.mjs')
// Short and resolved: the gateways' admin sockets are in folders below it.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'vgw-stats-')))
const BIN = join(TMP, 'bin')
const TOKEN = '123456789:TEST-token-never-in-a-log'
const MIN = 60 * 1000
const HOUR = 60 * MIN

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function waitUntil(predicate, ms = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = async () => {
      const value = await predicate()
      if (value) return resolve(value)
      if (Date.now() - started > ms) return reject(new Error('timed out waiting'))
      setTimeout(check, 25)
    }
    check()
  })
}

// A result as Claude Code 2.1 writes it at the end of a turn: usage since
// the result before, per model with the cost, and the session's totals.
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 17,
  total_cost_usd: 92.09, // the whole session, earlier runs included
  usage: { input_tokens: 28, output_tokens: 11602, cache_read_input_tokens: 7442053, cache_creation_input_tokens: 20139, output_tokens_details: { thinking_tokens: 3436 } },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 3710, outputTokens: 934854, costUSD: 92.09 } },
  model_usage_since_last_result: {
    'claude-opus-5-5': {
      inputTokens: 28,
      outputTokens: 11602,
      cacheReadInputTokens: 7442053,
      cacheCreationInputTokens: 20139,
      thinkingTokens: 3436,
      costUSD: 1.88,
    },
    'claude-haiku-4-5': { inputTokens: 2, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
  },
}

// --- stand-ins --------------------------------------------------------------------

// claude for a worker run: a subagent, two shell commands, a commit, and a
// result with its usage.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('fs')
const { execFileSync } = require('child_process')
readFileSync(0, 'utf8')
const args = process.argv.slice(2)
const session_id = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1]
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
out({ type: 'system', subtype: 'init' })
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'look around' } }] } })
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }, { type: 'tool_use', name: 'Bash', input: { command: 'git commit' } }] } })
writeFileSync('notes.md', 'one\\ntwo\\n')
const git = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' })
git('add', 'notes.md')
git('commit', '-q', '-m', 'notes')
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done, notes added.' }] } })
out(${JSON.stringify({ ...RESULT, result: 'Done, notes added.' })})
`

const telegram = { server: null, url: '', sent: [], updates: [] }

before(async () => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  chmodSync(join(BIN, 'claude'), 0o755)
  telegram.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {}
      const reply = data => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: data }))
      }
      if (req.url === `/bot${TOKEN}/sendMessage`) {
        telegram.sent.push(json)
        return reply({ message_id: telegram.sent.length })
      }
      if (req.url === `/bot${TOKEN}/getUpdates`) {
        const waiting = () => telegram.updates.filter(u => u.update_id >= (json.offset ?? 0))
        for (let i = 0; i < 10 && !waiting().length; i++) await sleep(50)
        return reply(waiting())
      }
      res.writeHead(404).end(JSON.stringify({ ok: false, description: 'Not Found' }))
    })
  })
  await new Promise(resolve => telegram.server.listen(0, '127.0.0.1', resolve))
  telegram.url = `http://127.0.0.1:${telegram.server.address().port}`
})

after(() => {
  telegram.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

// --- what a run used ----------------------------------------------------------------

test("a run's usage: from the result's usage since the one before, never the session's totals", () => {
  // Measured on real runs: a resumed run's total_cost_usd and modelUsage add
  // up the whole session, the run's own share is only in the since-figures.
  assert.deepEqual(resultUsage(RESULT, { resumed: true }), {
    input: 30,
    output: 11702,
    cacheRead: 7442053,
    cacheWrite: 20139,
    thinking: 3436,
    costUsd: 1.89,
    turns: 17,
  })
  // Two results in one run: a turn Claude Code answered on its own, then the task.
  let usage = addResult(null, { ...RESULT, num_turns: 0 }, { resumed: true })
  usage = addResult(usage, RESULT, { resumed: true })
  assert.equal(usage.output, 23404)
  assert.equal(usage.turns, 17)
  assert.ok(Math.abs(usage.costUsd - 3.78) < 1e-9)
  assert.equal(usage.costKnown, true)

  // An older Claude Code without the since-figures: tokens from usage; the
  // cost from the growth of the session's total, only in a session of its own.
  const { model_usage_since_last_result, ...older } = RESULT
  let fresh = addResult(null, { ...older, total_cost_usd: 0.5 })
  fresh = addResult(fresh, { ...older, total_cost_usd: 1.25 })
  assert.equal(fresh.input, 56)
  assert.ok(Math.abs(fresh.costUsd - 1.25) < 1e-9)
  assert.equal(fresh.costKnown, true)
  const resumed = addResult(null, older, { resumed: true })
  assert.deepEqual([resumed.cacheRead, resumed.costUsd, resumed.costKnown], [7442053, 0, false], 'its cost unknown, not the whole session')
  assert.deepEqual(resultUsage({ type: 'result', usage: { input_tokens: 'x' }, num_turns: -3 }), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
    costUsd: null,
    turns: 0,
  })
})

// --- the counters --------------------------------------------------------------------

// A Stats with a clock of its own, on the gateway's parts.
function counted(file = null) {
  const clock = { now: Date.UTC(2026, 9, 29, 8, 0) }
  const logged = []
  const s = new Stats({ file, now: () => clock.now, log: (...parts) => logged.push(parts.join(' ')) })
  return { s, clock, logged }
}

function run(id, repo, extra = {}) {
  return { id, repo, kind: 'repo', state: 'running', startedAt: 0, resumed: false, ...extra }
}

test('the counters: voice, questions and answers, approvals, decisions', () => {
  const { s } = counted()
  const store = new Store()
  const ledger = new Ledger({ log: () => {} })
  s.watch({ store, ledger })
  const ask = store.createRequest('Push the fix?')
  store.addUpdate(ask.id, 'question', 'To main or as a pull request?')
  ledger.ask(ask.id, { kind: 'push', text: 'To main or as a pull request?' })
  ask.updates.at(-1).at = Date.now() - 4 * MIN // asked four minutes ago
  const answer = store.createRequest('(Answer to x) As a pull request.', { answers: ask.id })
  store.addUpdate(answer.id, 'done', 'It is on its way.')
  // The gateway raises one itself, and the driver closes it ten minutes later.
  const push = ledger.add({ kind: 'push', repo: 'alpha', text: 'Two commits on no remote.' })
  push.createdAt -= 10 * MIN
  ledger.close(push, { outcome: 'keep them local', by: 'driver' })
  // A question on a worker's result counts; on the gateway's own event not.
  store.addUpdate(store.createRequest('Worker alpha finished', { origin: 'worker' }).id, 'question', 'Open the pull request?')
  store.addUpdate(store.createRequest('Open items', { origin: 'gateway' }).id, 'question', 'x')
  const code = store.addPermission({ request_id: 'abcde', tool_name: 'Bash', description: 'merge', input_preview: '' })
  store.resolvePermission(code, 'allow')
  // Long after the last request: a new conversation.
  s.lastVoiceAt = Date.now() - 2 * HOUR
  store.createRequest('Anything new?')

  const { current } = s.snapshot()
  const v = current.voice
  assert.deepEqual([v.requests, v.conversations, v.questions, v.answers], [3, 2, 2, 1])
  assert.equal(Math.round(v.answerMs[0] / 1000), 240, 'four minutes from the question to the answer')
  assert.equal(Math.round(v.maxAnswerMs / 1000), 240)
  assert.deepEqual([v.approvals, v.allowed, v.denied], [1, 1, 0])
  const d = current.decisions
  assert.deepEqual([d.raised, d.byGateway, d.kinds.push, d.closed, d.closedBy.driver], [2, 1, 2, 1, 1])
  assert.equal(Math.round(d.closeMs[0] / 1000), 600)
})

test('the counters: runs by outcome and repository, at once, the queue, tokens, git, pull requests, kill switch', () => {
  const { s, clock } = counted()
  const t0 = clock.now
  const a = run('t1', 'alpha', { startedAt: t0 })
  const b = run('t2', 'alpha', { startedAt: t0 + 10 * MIN, worktree: 't2', queuedAt: t0 + 4 * MIN, queued: 'q1' })
  const c = run('t3', 'scratch/abcd', { kind: 'scratch', startedAt: t0 + 20 * MIN, resumed: true })
  clock.now = a.startedAt
  s.runStarted(a)
  clock.now = b.startedAt
  s.runStarted(b)
  clock.now = c.startedAt
  s.runStarted(c)
  clock.now = t0 + 30 * MIN
  Object.assign(b, { state: 'done', finishedAt: clock.now, usage: addResult(null, RESULT, { resumed: false }), tools: 3, subagents: 1 })
  s.runEnded(b)
  clock.now = t0 + 40 * MIN
  Object.assign(c, { state: 'failed', finishedAt: clock.now })
  s.runEnded(c)
  clock.now = t0 + 60 * MIN
  Object.assign(a, { state: 'stopped', finishedAt: clock.now, requeuedAs: null })
  s.runEnded(a)
  s.measured(b, { commits: 2, files: 3, lines: 40, pushed: true })
  s.reported(b, [{ number: 7, opened: true }, { number: 5, opened: false }])
  s.reported(b, [{ number: 7, opened: true }]) // the result sent again: counted once
  s.reported({ ...c, audit: { ok: true, counts: { made: 2, changed: 1, removed: 0 } } })
  s.news({ checks: { passed: 2, failed: 1, skipped: 0 }, reviews: ['APPROVED', 'COMMENTED'], comments: 1 })
  s.news({ checks: null, reviews: ['CHANGES_REQUESTED'], comments: 0 })
  s.tripped({ trigger: 'rule' }, true)
  s.tripped({ trigger: 'voice' }, false)

  const { current } = s.snapshot()
  const r = current.runs
  assert.deepEqual([r.ended, r.done, r.failed, r.stopped, r.worktrees, r.scratch, r.followups], [3, 1, 1, 1, 1, 1, 1])
  assert.equal(r.ms, 20 * MIN + 20 * MIN + 60 * MIN)
  assert.deepEqual(r.longest, { ms: 60 * MIN, repo: 'alpha' })
  assert.deepEqual(Object.keys(current.repos).sort(), ['alpha', 'work folders'])
  assert.deepEqual([current.repos.alpha.runs, current.repos.alpha.maxAtOnce], [2, 2])
  // Two or more at once from t0+10 to t0+40; three from t0+20 to t0+30.
  assert.deepEqual([current.parallel.maxAtOnce, current.parallel.twoPlusMs], [3, 30 * MIN])
  assert.equal(current.repos.alpha.twoPlusMs, 20 * MIN, 'alpha had two runs from t0+10 to t0+30')
  assert.deepEqual([current.queue.started, current.queue.waitMs, current.queue.maxWaitMs], [1, [6 * MIN], 6 * MIN])
  const t = current.tokens
  assert.deepEqual([t.output, t.cacheRead, t.turns, t.tools, t.subagents, t.costUnknown], [11702, 7442053, 17, 3, 1, 0])
  assert.ok(Math.abs(t.costUsd - 1.89) < 1e-9)
  assert.deepEqual(current.git, { commits: 2, committedRuns: 1, pushedRuns: 1, files: 3, lines: 40, pullsOpened: 1, pullsUpdated: 1, scratchFiles: 3 })
  assert.deepEqual(current.pulls, { checks: 1, checksFailed: 1, reviews: 3, approved: 1, changesRequested: 1, comments: 1 })
  assert.deepEqual([current.killswitch.locks, current.killswitch.triggers.rule, current.killswitch.triggers.voice], [1, 1, 1])
})

test('runs going when the gateway starts count for the runs at once, not for the queue; a handler that fails counts nothing and says so', () => {
  const { s, logged } = counted()
  const workers = new EventEmitter()
  workers.running = () => [run('t1', 'alpha', { queuedAt: 0, startedAt: 1 })]
  s.watch({ workers })
  assert.equal(s.snapshot().current.parallel.maxAtOnce, 1)
  assert.equal(s.snapshot().current.queue.started, 0)
  workers.emit('ended', null) // not a task
  assert.match(logged.join('\n'), /statistics: not counted: /)
})

// --- the file ---------------------------------------------------------------------------

test('the file: all time across a restart and a crash, this running time from zero; mode 0600; a broken file starts again', () => {
  const file = join(TMP, 'file', 'stats.json')
  const first = counted(file)
  first.s.started()
  first.s.runEnded(run('t1', 'alpha', { state: 'done', startedAt: first.clock.now, finishedAt: first.clock.now + 30 * MIN }))
  first.clock.now += 2 * HOUR
  const ended = first.s.close()
  assert.equal(ended.current.upMs, 2 * HOUR)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const saved = readStats(file)
  assert.equal(saved.current.endedAt, first.clock.now, 'the end, for the watchdog')
  assert.equal(saved.total.runs.ended, 1)

  // A restart by voice: the totals go on, this running time starts at zero.
  const second = counted(file)
  second.clock.now = first.clock.now + MIN
  second.s.current.since = second.clock.now
  second.s.liveAt = second.clock.now
  second.s.started({ after: 'a restart requested by voice' })
  second.s.runEnded(run('t2', 'beta', { state: 'failed', startedAt: second.clock.now, finishedAt: second.clock.now + 10 * MIN }))
  second.clock.now += HOUR
  // A crash: no close, only the save a few seconds after the change.
  second.s.save()
  const third = counted(file)
  third.s.started({ after: 'a crash (exit code 1)' })
  const { current, total } = third.s.snapshot()
  assert.equal(current.runs.ended, 0)
  assert.equal(current.starts, 1)
  assert.deepEqual([total.starts, total.runs.ended, total.runs.done, total.runs.failed], [3, 2, 1, 1])
  assert.deepEqual(total.restarts, { crash: 1, requested: 1, service: 0, everything: 0 })
  assert.equal(total.upMs, 3 * HOUR, 'two hours, then one until the crash, then this start')
  assert.deepEqual(Object.keys(total.repos).sort(), ['alpha', 'beta'])
  assert.equal(total.since, Date.UTC(2026, 9, 29, 8, 0), 'since the first start')

  writeFileSync(file, '{ broken')
  const fourth = counted(file)
  assert.equal(fourth.s.snapshot().total.starts, 1)
  assert.match(fourth.logged.join('\n'), /statistics file .* unreadable, all-time totals start again/)
  // What a hand or an older version put there: only the known shape, numbers only.
  writeFileSync(
    file,
    JSON.stringify({ total: { starts: 'x', runs: { ended: 4, runMs: [1, 'y', -2] }, repos: { ['__proto__']: { runs: 9 }, alpha: { runs: 2, ms: -1 } } } }),
  )
  const fifth = counted(file).s.snapshot().total
  assert.deepEqual([fifth.starts, fifth.runs.ended, fifth.runs.runMs], [1, 4, [1]])
  assert.deepEqual(Object.keys(fifth.repos), ['alpha'])
  assert.deepEqual([fifth.repos.alpha.runs, fifth.repos.alpha.ms], [2, 0])
  assert.equal({}.runs, undefined, 'no prototype touched')
})

// --- the texts ----------------------------------------------------------------------------

function busy() {
  const p = stats.emptyPeriod(Date.UTC(2026, 9, 29, 8, 12))
  Object.assign(p, { upMs: 5 * HOUR + 20 * MIN, starts: 1 })
  Object.assign(p.runs, { ended: 12, done: 10, failed: 1, stopped: 1, followups: 5, worktrees: 3, scratch: 2, ms: 3 * HOUR + 10 * MIN, runMs: [10, 12, 14].map(m => m * MIN), longest: { ms: 48 * MIN, repo: 'alpha' } })
  p.repos.alpha = { runs: 6, ms: 100 * MIN, costUsd: 12.3, maxAtOnce: 2, twoPlusMs: 25 * MIN }
  p.repos.beta = { runs: 4, ms: 60 * MIN, costUsd: 0.4, maxAtOnce: 1, twoPlusMs: 0 }
  Object.assign(p.parallel, { maxAtOnce: 3, twoPlusMs: 80 * MIN })
  Object.assign(p.tokens, { input: 2000, output: 181234, cacheRead: 1900000, cacheWrite: 123456, thinking: 61000, costUsd: 23.4, turns: 450, tools: 912, subagents: 3 })
  Object.assign(p.git, { commits: 31, committedRuns: 9, pushedRuns: 8, files: 120, lines: 4512, pullsOpened: 4, pullsUpdated: 2 })
  Object.assign(p.voice, { requests: 25, conversations: 4, questions: 6, answers: 5, answerMs: [3, 4, 5].map(m => m * MIN), maxAnswerMs: 32 * MIN })
  Object.assign(p.queue, { started: 4, waitMs: [6 * MIN], maxWaitMs: 20 * MIN, parked: 1 })
  p.killswitch.locks = 1
  p.killswitch.triggers.rule = 1
  return p
}

test('the texts: round numbers, what matters first, in two or three sentences', () => {
  assert.deepEqual([amount(37), amount(1234), amount(12345), amount(973456), amount(2134567), amount(523.5e6)], ['37', '1,200', '12,000', '970,000', '2.1 million', '520 million'])
  assert.deepEqual([span(20000), span(45 * MIN), span(5 * HOUR + 20 * MIN), span(31 * HOUR), span(80 * HOUR)], ['less than a minute', '45 min', '5 h 20 min', '31 h', '3 days'])

  const p = busy()
  const overview = overviewText(p)
  assert.equal(
    overview,
    'In 5 h 20 min: 12 worker runs (10 done, 1 failed, 1 stopped), 3 h 10 min of work, at most 3 at once. ' +
      '31 commits and 4 pull requests opened, with 2.2 million tokens, about 23 dollars at API list prices. ' +
      '25 voice requests, 6 questions to the driver, answered after about 4 min; the kill switch locked once.',
  )
  assert.equal(overview.split('. ').length, 3, 'three sentences')
  assert.match(overviewText(p, { you: true }), /6 questions to you,/)
  const quiet = stats.emptyPeriod(Date.now())
  quiet.upMs = 2 * HOUR
  assert.equal(overviewText(quiet), 'In 2 h: no worker runs. No voice requests.')

  const lines = detailsLines(p, { total: { ...p, starts: 14, restarts: { crash: 3, requested: 2, service: 1 }, since: Date.UTC(2026, 9, 20) } })
  const line = start => lines.find(l => l.startsWith(start))
  assert.equal(line('Running:'), 'Running: 5 h 20 min, since 2026-10-29 08:12 UTC; 14 starts since 2026-10-20, of them 3 after a crash, 2 after a restart by voice and 1 after a restart of the service.')
  assert.equal(line('Voice:'), 'Voice: 25 requests in 4 conversations; 6 questions to the driver, 5 answered, typically after about 4 min, the longest after 32 min.')
  assert.equal(line('Worker runs:'), 'Worker runs: 12 ended, 10 done, 1 failed, 1 stopped; 5 follow-ups in the same session, 3 in worktrees, 2 in work folders. By repository: alpha 6 (1 h 40 min, about 12 dollars), beta 4 (1 h).')
  assert.equal(line('Worker time:'), 'Worker time: 3 h 10 min in all, typically 12 min a run, the longest 48 min (alpha).')
  assert.equal(line('At once:'), 'At once: at most 3 runs, 2 or more for 1 h 20 min; in one repository at most 2 (alpha), 2 or more there for 25 min.')
  assert.equal(line('Queue:'), 'Queue: 4 tasks waited, typically 6 min, the longest 20 min; 1 could not start when it was its turn.')
  assert.equal(line('Tokens:'), 'Tokens: 2 million in, of them 1.9 million read from the cache and 120,000 written to it; 180,000 out, of them 61,000 thinking. About 23 dollars at API list prices. 450 turns, 912 tool calls, 3 subagents.')
  assert.equal(line('Git:'), 'Git: 31 commits in 9 runs, pushed in 8 runs, 120 files and 4,500 lines changed; 4 pull requests opened, 2 updated.')
  assert.equal(line('Kill switch:'), 'Kill switch: locked once; triggered once by a rule.')
  assert.equal(line('Decisions:'), 'Decisions: none raised.')

  const total = { ...p, starts: 14, since: Date.UTC(2026, 9, 20) }
  assert.equal(totalLine(total), 'All time, since 2026-10-20 (14 starts): 12 worker runs, 3 h 10 min of work, 2.2 million tokens, about 23 dollars at API list prices, 4 pull requests opened.')

  const restart = shutdownText({ current: p, total }, { host: 'box', restart: true })
  assert.match(restart, /^cc-voice-gateway on box: the gateway is shutting down now for the restart\. Its statistics:\n\nIn 5 h 20 min: 12 worker runs/)
  assert.match(restart, /6 questions to you/)
  assert.match(restart, /\n\nAll time, since 2026-10-20 \(14 starts\): .*\n\nA message follows when it is ready again\.$/)
  assert.match(shutdownText({ current: p, total }, { host: 'box', why: 'stopped at the computer' }), /^cc-voice-gateway on box: the gateway is shutting down now \(stopped at the computer\)\. Its statistics:\n\n/)

  const tool = toolText({ current: p, total })
  assert.match(tool, /^\[stats period=this-start since=2026-10-29T08:12Z minutes=320 runs=12 voice=25\]\nIn 5 h 20 min: /)
  assert.match(tool, /\nDetails:\n- Running: /)
  assert.match(tool, /\nAll time, since 2026-10-20/)
  assert.match(tool, /Answer the driver from the first part in two or three short sentences, in their language, with round numbers; the details only when they ask\. For all time, call stats with all_time=true\.$/)
  assert.match(toolText({ current: p, total }, { allTime: true }), /^\[stats period=all-time .*\nSince 2026-10-20, in 5 h 20 min of running: /)
})

// --- /stats on Telegram ---------------------------------------------------------------------

test('/stats and /stats all on Telegram, only from the configured chat', () => {
  assert.deepEqual(statsCommand('/stats'), { all: false })
  assert.deepEqual(statsCommand('/stats@voice_bot all'), { all: true })
  assert.equal(statsCommand('stats please'), null)
  const commands = new TelegramCommands({ chatId: '4242' }, { log: () => {} })
  const heard = []
  commands.on('stats', event => heard.push(event))
  const message = (text, chat = 4242) => ({ message: { text, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: 'private' } } })
  commands.handle(message('/stats'))
  commands.handle(message('/stats all'))
  commands.handle(message('/stats', 99))
  assert.deepEqual(heard.map(e => e.all), [false, true])
})

// --- scripts/stats.mjs, for the watchdog ------------------------------------------------------

function runScript(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.on('close', status => resolve({ status, stdout: stdout.trim() }))
  })
}

test('scripts/stats.mjs: the shutdown message for a gateway of this session, nothing for an older one, nothing without Telegram', async () => {
  const dir = join(TMP, 'script')
  const state = join(dir, 'state')
  const secrets = join(dir, 'secrets')
  mkdirSync(secrets, { recursive: true })
  writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`)
  writeFileSync(join(secrets, 'telegram_chat_id'), '4242\n')
  const env = { VOICE_GW_STATE_DIR: state, VOICE_GW_SECRETS_DIR: secrets, VOICE_GW_TELEGRAM_API: telegram.url }
  const session = 4711 // the session's claude, the gateway's parent
  const s = new Stats({ file: join(state, 'stats.json'), session, log: () => {} })
  s.started()
  s.runEnded(run('t1', 'alpha', { state: 'done', startedAt: Date.now() - 20 * MIN, finishedAt: Date.now() }))
  s.close()

  const before = telegram.sent.length
  const restart = await runScript(['--shutdown', '--session', String(session), '--restart'], env)
  assert.deepEqual(restart, { status: 0, stdout: 'telegram: sent the shutdown message with the statistics' })
  const text = telegram.sent.at(-1).text
  assert.match(text, /^cc-voice-gateway on .*: the gateway is shutting down now for the restart\. Its statistics:\n\nIn less than a minute: 1 worker run \(1 done\), 20 min of work\./)
  assert.match(text, /A message follows when it is ready again\.$/)
  const stop = await runScript(['--shutdown', '--session', String(session), '--why', 'stopped at the computer'], env)
  assert.equal(stop.status, 0)
  assert.match(telegram.sent.at(-1).text, /: the gateway is shutting down now \(stopped at the computer\)\. Its statistics:/)

  // Another session, whose gateway saved nothing: not this file's.
  const other = await runScript(['--shutdown', '--session', String(session + 1)], env)
  assert.deepEqual(other, { status: 0, stdout: 'statistics: none saved by a gateway of this session' })
  assert.equal(telegram.sent.length, before + 2)
  const without = await runScript(['--shutdown', '--session', String(session)], { ...env, VOICE_GW_SECRETS_DIR: join(dir, 'none') })
  assert.deepEqual(without, { status: 0, stdout: 'telegram: not set up' })
  // At the desk.
  const desk = await runScript([], env)
  assert.match(desk.stdout, /^The last running time \(ended\):\nIn less than a minute: 1 worker run/)
  assert.match((await runScript(['--all'], env)).stdout, /^All time:\nSince \d{4}-\d\d-\d\d, in less than a minute of running: 1 worker run/)
})

// --- the gateway as a whole -------------------------------------------------------------------

async function freePort() {
  const server = createNetServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startGateway(name) {
  const state = join(TMP, `${name}-state`)
  const secrets = join(TMP, `${name}-secrets`)
  const repos = join(TMP, `${name}-repos`)
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`)
  writeFileSync(join(secrets, 'telegram_chat_id'), '4242\n')
  if (!existsSync(join(repos, 'alpha'))) {
    mkdirSync(join(repos, 'alpha'), { recursive: true })
    // Long before the run: the size check counts the commits since its start.
    const dated = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
    const git = (...args) => execFileSync('git', args, { cwd: join(repos, 'alpha'), stdio: 'ignore', env: dated })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repos, 'alpha', 'README.md'), '# alpha\n')
    git('add', '.')
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
  }
  const port = await freePort()
  const g = { events: [], log: '', state }
  g.claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  g.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => g.events.push(params),
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: state,
      VOICE_GW_WORKER_ROOT: repos,
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'no-gh'),
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_SELF_CHECKOUT: '',
      VOICE_GW_TELEGRAM_API: telegram.url,
      VOICE_GW_TELEGRAM_POLL: '1',
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (g.log += chunk))
  await g.claudeCode.connect(stdio)
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok)
  const { access_token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name })
  g.voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await g.voice.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    }),
  )
  g.call = async (tool, args = {}) => (await g.voice.callTool({ name: tool, arguments: args })).content[0].text
  g.controller = async (tool, args = {}) => (await g.claudeCode.callTool({ name: tool, arguments: args })).content[0].text
  g.close = async () => {
    await g.voice.close()
    await g.claudeCode.close()
  }
  return g
}

test('the gateway: a run counted with its tokens, subagents and commit; the tool stats; /stats; without the watchdog its own shutdown message; all time after a restart', async () => {
  const g = await startGateway('whole')
  const before = telegram.sent.length
  try {
    const { tools } = await g.claudeCode.listTools()
    const tool = tools.find(t => t.name === 'stats')
    assert.ok(tool, 'the controller has the tool')
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['all_time'])
    assert.match(await g.controller('stats'), /^\[stats period=this-start .* runs=0 voice=0\]\nIn less than a minute: no worker runs\. No voice requests\./)

    const said = /id=([a-z0-9]+)/.exec(await g.call('send', { message: 'Add notes to alpha.' }))[1]
    const started = await g.controller('dispatch', { worker: 'alpha', task: 'Add notes.', words: 'Add notes to alpha.' })
    assert.match(started, /dispatch=started/)
    await g.controller('reply', { request_id: said, state: 'question', text: 'Notes in English?' })
    await g.call('send', { message: 'Yes.', in_reply_to: said })
    const result = await waitUntil(() => g.events.find(e => e.meta?.outcome === 'done'))
    await g.controller('reply', { request_id: result.meta.request_id, state: 'done', text: 'Notes added.' })
    // The size check runs after the run, with git: the commit, its file and lines.
    const text = await waitUntil(async () => {
      const out = await g.controller('stats')
      return /1 commit/.test(out) && out
    })
    assert.match(text, /\nIn less than a minute: 1 worker run \(1 done\), less than a minute of work\. 1 commit, with 7\.5 million tokens, about 1\.9 dollars at API list prices\. 2 voice requests, 1 question to the driver, answered after less than a minute\./)
    assert.match(text, /\n- Tokens: 7\.5 million in, of them 7\.4 million read from the cache and 20,000 written to it; 12,000 out, of them 3,400 thinking\. About 1\.9 dollars at API list prices\. 17 turns, 3 tool calls, 1 subagent\./)
    assert.match(text, /\n- Git: 1 commit in 1 run, 1 file and 2 lines changed\./)
    assert.match(text, /\n- Worker runs: 1 ended, 1 done\. By repository: alpha 1 \(less than a minute, about 1\.9 dollars\)\./)
    assert.match(text, /\n- Decisions: 1 raised \(1 other\)/)

    // /stats from the driver's chat.
    telegram.updates.push({ update_id: 1, message: { text: '/stats', date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: 'private' } } })
    const answer = await waitUntil(() => telegram.sent.slice(before).find(m => /: statistics since /.test(m.text)))
    assert.match(answer.text, /\n\nIn less than a minute: 1 worker run \(1 done\)/)
    assert.match(answer.text, /\nGit: 1 commit in 1 run/)
  } finally {
    await g.close()
  }
  // The session has ended, and no watchdog says so: the gateway does.
  const bye = await waitUntil(() => telegram.sent.slice(before).find(m => /shutting down now/.test(m.text)))
  assert.match(bye.text, /^cc-voice-gateway on .*: the gateway is shutting down now \(the controller session ended\)\. Its statistics:\n\nIn less than a minute: 1 worker run \(1 done\)/)
  assert.ok(!g.log.includes(TOKEN))
  await waitUntil(() => readStats(join(g.state, 'stats.json'))?.current.endedAt)

  const again = await startGateway('whole')
  try {
    assert.match(await again.controller('stats'), /\nIn less than a minute: no worker runs\./, 'this running time starts at zero')
    const all = await again.controller('stats', { all_time: true })
    assert.match(all, /^\[stats period=all-time .* runs=1 voice=2\]\nSince \d{4}-\d\d-\d\d, in less than a minute of running: 1 worker run \(1 done\)/)
    assert.match(all, /\n- Running: less than a minute in all; 2 starts since /)
  } finally {
    await again.close()
  }
})
