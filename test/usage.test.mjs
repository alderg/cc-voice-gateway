// The Claude usage limit (limits.mjs): how a run's output and the controller's
// transcript show it, the reset time in its text, the waits per account with
// their backoff, kept across a restart, and the gateway as a whole when the
// controller session meets the limit: one Telegram message, the events for it
// held and sent again once it answers. The worker runs that meet it are in
// parallel.test.mjs.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'
import { Limits, TranscriptWatch, clock, creditsOf, creditsText, limitOf, onCredits, parseReset, refused, track, transcriptFile, waitText, worse } from '../src/limits.mjs'
import { openItems } from '../src/ledger.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Store } from '../src/store.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-usage-'))
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT_ID = '4242'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

after(() => rmSync(TMP, { recursive: true, force: true }))

async function until(predicate, ms = 8000) {
  for (const begun = Date.now(); Date.now() - begun < ms; await sleep(25)) {
    const value = predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

// What Claude Code 2.1 writes at the account's limit, in a run's stream-json.
const LIMIT_TEXT = "You've hit your 5-hour limit · resets 3pm (Europe/Zurich)"
const RESET = 1793458800 // Unix seconds
const limitMessage = () => ({
  type: 'assistant',
  message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT_TEXT }] },
  error: 'rate_limit',
  is_api_error_message: true,
  api_error_status: 429,
  api_error: 'usage_limit_reached',
  api_error_params: { rate_limit_info: { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour' } },
})

// --- how it shows ------------------------------------------------------------------

test('limitOf: the usage limit in a run, by its typed kind, its event and its result; with the reset time', () => {
  assert.deepEqual(limitOf(limitMessage()), { kind: 'usage', resetsAt: RESET * 1000, exact: true, limit: 'five_hour', text: LIMIT_TEXT })
  assert.deepEqual(limitOf({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESET, rateLimitType: 'seven_day' } }), {
    kind: 'usage',
    resetsAt: RESET * 1000,
    exact: true,
    limit: 'seven_day',
    text: 'usage limit reached',
  })
  for (const status of ['allowed', 'allowed_warning']) {
    assert.equal(limitOf({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: RESET } }), null, status)
  }
  const now = new Date(2026, 9, 31, 10, 0).getTime()
  const result = limitOf({ type: 'result', subtype: 'success', is_error: true, result: LIMIT_TEXT })
  assert.equal(result.kind, 'usage')
  assert.equal(new Date(result.resetsAt).getHours(), 15, 'from the text: 3pm')
  assert.equal(result.exact, false)
  // Older versions.
  assert.equal(limitOf({ type: 'result', is_error: true, result: `Claude AI usage limit reached|${RESET}` }).resetsAt, RESET * 1000)
  assert.equal(parseReset(`Claude AI usage limit reached|${RESET}`, now), RESET * 1000)
})

test('limitOf: an overloaded or throttled API is a throttle; what a worker writes about rate limits is nothing', () => {
  const overloaded = { type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] }, error: 'overloaded', is_api_error_message: true }
  assert.equal(limitOf(overloaded).kind, 'throttle')
  const throttled = { type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 429 rate limited' }] }, error: 'rate_limit', is_api_error_message: true }
  assert.equal(limitOf(throttled).kind, 'throttle')
  assert.equal(limitOf({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"overloaded_error"}' }).kind, 'throttle')
  // Not API errors.
  const said = { type: 'assistant', message: { content: [{ type: 'text', text: "I added a rate limit; you've hit your limit is its message." }] } }
  assert.equal(limitOf(said), null)
  assert.equal(limitOf({ type: 'result', subtype: 'success', is_error: false, result: "Users who hit your limit now get a 429." }), null)
  assert.equal(limitOf({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'The tests failed.' }), null)
  assert.equal(limitOf({ type: 'assistant', message: { content: [{ type: 'text', text: 'Login expired' }] }, error: 'authentication_failed', isApiErrorMessage: true }), null)
  assert.equal(limitOf(null), null)
})

test("limitOf: the controller's transcript shows it with isApiErrorMessage and the text", () => {
  const line = {
    type: 'assistant',
    timestamp: '2026-10-31T13:00:00.000Z',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] },
    error: 'rate_limit',
    isApiErrorMessage: true,
  }
  assert.equal(limitOf(line).kind, 'usage')
  assert.ok(limitOf(line).resetsAt)
})

// --- usage credits ---------------------------------------------------------------------
//
// A run's stream-json as Claude Code 2.1 writes it around the plan's limit
// with usage credits on: the rate_limit_info as it reads the API's headers,
// isUsingOverage being status "rejected" with the overage allowed.

const HOUR = 60 * 60 * 1000
const SESSION = { session_id: '5f0c3a52-9d1e-4c57-a3a8-2f7b6c1d9e40' }
const OVERAGE_RESET = RESET - 3600 // the credits' monthly spend limit resets an hour before the plan's limit
const rateEvent = info => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'b7d1f0e2-6a43-4d8e-9c21-0f5e7a3b8c64', ...SESSION })
const say = text => ({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, ...SESSION })
const toolUse = () => ({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'npm test' } }] },
  parent_tool_use_id: null,
  ...SESSION,
})
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '438 passed' }] }, parent_tool_use_id: null, ...SESSION })
const result = (text, { error = false, subtype = 'success' } = {}) => ({ type: 'result', subtype, is_error: error, result: text, num_turns: 4, total_cost_usd: 0.42, ...SESSION })
// The turn Claude Code ends at a refusal (a 429), with its typed kind.
const refusal = (text, info) => ({
  type: 'assistant',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  error: 'rate_limit',
  is_api_error_message: true,
  api_error_status: 429,
  api_error: 'usage_limit_reached',
  api_error_params: { rate_limit_info: info },
  parent_tool_use_id: null,
  ...SESSION,
})
const WARNING = { status: 'allowed_warning', resetsAt: RESET, rateLimitType: 'five_hour', utilization: 0.92, surpassedThreshold: 0.9, overageStatus: 'allowed', isUsingOverage: false }
const ON_CREDITS = { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour', overageStatus: 'allowed', overageResetsAt: OVERAGE_RESET, isUsingOverage: true, overageInUse: true }

// A run's lines as Workers.handleLine reads them (track, creditsOf), and how
// Workers.conclude ends it: limited when a limit it found ended it without
// a good result.
function runOf(lines) {
  let limit = null
  let credits = 0
  let last = null
  for (const line of lines.map(line => JSON.parse(JSON.stringify(line)))) {
    limit = track(limit, line)
    if (creditsOf(line)) credits++
    if (line.type === 'result') last = line
  }
  const isError = Boolean(last && (last.is_error || last.subtype !== 'success'))
  const ends = limit && (!last || isError) ? 'limited' : last && !isError ? 'done' : 'failed'
  return { limit, credits, ends }
}

test('usage credits: past the plan\'s limit, after its warning, a run goes on on them; no line of it is a limit, and the credits are noted', () => {
  const lines = [
    { type: 'system', subtype: 'init', ...SESSION },
    rateEvent(WARNING),
    say('Running the tests first.'),
    rateEvent(ON_CREDITS),
    toolUse(),
    toolResult(),
    rateEvent({ ...ON_CREDITS, overageStatus: 'allowed_warning', utilization: 0.4 }), // the credits near their spend limit
    say('All green; the fix is pushed.'),
    result('All green; the fix is pushed.'),
  ]
  for (const line of lines) assert.equal(limitOf(line), null, JSON.stringify(line))
  assert.deepEqual(runOf(lines), { limit: null, credits: 2, ends: 'done' })
  assert.deepEqual(creditsOf(rateEvent(ON_CREDITS)), { limit: 'five_hour', resetsAt: RESET * 1000 })
  assert.equal(creditsOf(rateEvent(WARNING)), null, 'the credits allowed, but the plan still pays')
  assert.equal(creditsOf(say('Now using usage credits.')), null, 'only the event says so')
  // Overage in use while the plan's limit is not reached, as for a model that bills to the credits.
  assert.equal(onCredits({ status: 'allowed', rateLimitType: 'seven_day_overage_included', overageStatus: 'allowed', overageInUse: true }), true)
})

test('usage credits: "rejected" with the credits allowed is no limit, also as the last word of a run that ends otherwise: failed, not held', () => {
  // Without isUsingOverage, as Claude Code before it wrote it.
  const older = { status: 'rejected', resetsAt: RESET, rateLimitType: 'seven_day', overageStatus: 'allowed' }
  assert.equal(refused(older), false)
  assert.equal(onCredits(older), true)
  assert.equal(limitOf(rateEvent(older)), null)
  // Before, the event held the run and its account until the plan's reset.
  const maxTurns = runOf([rateEvent(ON_CREDITS), toolUse(), toolResult(), rateEvent(older), result('', { error: true, subtype: 'error_max_turns' })])
  assert.deepEqual(maxTurns, { limit: null, credits: 2, ends: 'failed' })
  assert.deepEqual(runOf([rateEvent(ON_CREDITS), say('Building.'), rateEvent(ON_CREDITS)]), { limit: null, credits: 2, ends: 'failed' }, 'a crash on credits is a crash')
  // An overloaded API at its end is the short wait, not the plan's reset.
  const overloaded = { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] }, error: 'overloaded', is_api_error_message: true }
  const run = runOf([rateEvent(ON_CREDITS), say('Next.'), rateEvent(ON_CREDITS), overloaded, result('API Error: 529 Overloaded', { error: true })])
  assert.equal(run.ends, 'limited')
  assert.equal(run.limit.kind, 'throttle')
  assert.equal(run.limit.resetsAt, null)
})

test('a real stop with usage credits on: credits_required, the credits refused or disabled, or none at all; the plan\'s reset', () => {
  const required = { status: 'rejected', resetsAt: RESET, rateLimitType: 'seven_day', isUsingOverage: false, errorCode: 'credits_required', canUserPurchaseCredits: true, hasChargeableSavedPaymentMethod: true }
  const weekly = "You've hit your weekly limit · resets Nov 5, 9am (Europe/Zurich)"
  const run = runOf([say('Starting.'), rateEvent(required), refusal(weekly, required), result(weekly, { error: true })])
  assert.equal(run.ends, 'limited')
  assert.deepEqual(run.limit, { kind: 'usage', resetsAt: RESET * 1000, exact: true, limit: 'seven_day', text: weekly })
  assert.equal(refused({ ...required, overageStatus: 'allowed' }), true, 'no credits can pay, whatever else it says')
  assert.equal(onCredits({ ...required, overageStatus: 'allowed', isUsingOverage: true }), false)

  const disabled = { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false }
  const notProvisioned = { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour', overageDisabledReason: 'overage_not_provisioned', isUsingOverage: false }
  const none = { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour' }
  for (const info of [disabled, notProvisioned, none]) {
    assert.equal(refused(info), true, JSON.stringify(info))
    assert.equal(onCredits(info), false)
    assert.deepEqual(limitOf(rateEvent(info)), { kind: 'usage', resetsAt: RESET * 1000, exact: true, limit: 'five_hour', text: 'usage limit reached' })
    const stopped = runOf([say('Starting.'), rateEvent(info), refusal(LIMIT_TEXT, info), result(LIMIT_TEXT, { error: true })])
    assert.deepEqual(stopped, { limit: { kind: 'usage', resetsAt: RESET * 1000, exact: true, limit: 'five_hour', text: LIMIT_TEXT }, credits: 0, ends: 'limited' })
    // The refused event alone, and the run gone without a word more.
    assert.equal(runOf([say('Starting.'), rateEvent(info)]).ends, 'limited')
  }
})

test('the credits run out: out of usage credits, or their monthly spend limit; it waits until the plan\'s reset, or the spend limit\'s when that comes first', () => {
  // An empty balance: the plan's reset, as no date refills it.
  const empty = { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour', overageStatus: 'rejected', overageResetsAt: OVERAGE_RESET, overageDisabledReason: 'out_of_credits', isUsingOverage: false }
  const emptyText = "You're out of usage credits · resets 3pm (Europe/Zurich)"
  const out = runOf([rateEvent(ON_CREDITS), toolUse(), toolResult(), rateEvent(empty), refusal(emptyText, empty), result(emptyText, { error: true })])
  assert.deepEqual(out, { limit: { kind: 'usage', resetsAt: RESET * 1000, exact: true, limit: 'five_hour', text: emptyText }, credits: 1, ends: 'limited' })
  // The monthly spend limit, which resets before the plan's limit: the credits pay again then.
  const spend = { ...empty, overageDisabledReason: 'org_level_disabled_until' }
  const spendText = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your 5-hour limit resets 3pm (Europe/Zurich)"
  const capped = runOf([rateEvent(ON_CREDITS), say('Next, the docs.'), rateEvent(spend), refusal(spendText, spend), result(spendText, { error: true })])
  assert.deepEqual(capped, { limit: { kind: 'usage', resetsAt: OVERAGE_RESET * 1000, exact: true, limit: 'five_hour', text: spendText }, credits: 1, ends: 'limited' })
  assert.equal(limitOf(rateEvent({ ...spend, overageResetsAt: RESET + 3600 })).resetsAt, RESET * 1000, 'the plan\'s reset when it comes first')
})

test('the run\'s final error alone says it: the usage limit, the monthly spend limit, out of usage credits; the reset from its text', () => {
  for (const text of [
    LIMIT_TEXT,
    "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your 5-hour limit resets 3pm (Europe/Zurich)",
    "You're out of usage credits · resets 3pm (Europe/Zurich)",
  ]) {
    const run = runOf([rateEvent(ON_CREDITS), say('Working.'), result(text, { error: true })])
    assert.equal(run.ends, 'limited', text)
    assert.equal(run.limit.kind, 'usage')
    assert.equal(run.limit.exact, false)
    assert.equal(new Date(run.limit.resetsAt).getHours(), 15, text)
    assert.equal(run.limit.text, text)
  }
  // An API error with the text but without its typed kind, as older versions wrote it.
  const flagged = { type: 'assistant', message: { content: [{ type: 'text', text: "You're out of usage credits · resets 3pm" }] }, error: 'rate_limit', is_api_error_message: true }
  assert.equal(limitOf(flagged).kind, 'usage')
  // What a worker writes about credits is nothing.
  assert.equal(limitOf(say("You're out of usage credits, says the banner we built.")), null)
  assert.equal(limitOf(result("You've hit your monthly spend limit is the banner's new text.")), null)
})

test('runs on usage credits: said once in the log, listed until the plan\'s reset, ended by a real stop; nothing waits', () => {
  const { clockState, now } = clockAt()
  const logged = []
  const limits = new Limits({ now, log: line => logged.push(line) })
  const resetsAt = clockState.now + 2 * HOUR
  limits.credits('host', { limit: 'five_hour', resetsAt })
  limits.credits('host', { limit: 'five_hour', resetsAt })
  assert.equal(logged.length, 1, 'once')
  assert.match(logged[0], /^usage credits: the workers on this computer run on usage credits since \d\d:\d\d, as the 5-hour limit is reached until it resets at \d\d:\d\d; nothing waits$/)
  assert.equal(limits.active('host'), null, 'nothing waits')
  assert.equal(limits.any(), false)
  assert.deepEqual(limits.list(), [])
  assert.deepEqual(limits.creditsList().map(item => item.account), ['host'])
  // A later reset, of the weekly limit, extends it; once that is past, it is over.
  limits.credits('host', { limit: 'seven_day', resetsAt: resetsAt + HOUR })
  assert.deepEqual(limits.paying('host'), { since: clockState.now, until: resetsAt + HOUR, limit: 'seven_day', reset: true })
  clockState.now = resetsAt + HOUR
  assert.deepEqual(limits.creditsList(), [])
  // A reset that is past, as in a run's output read again: nothing.
  assert.equal(limits.credits('host', { limit: 'five_hour', resetsAt: clockState.now - HOUR }), null)
  assert.deepEqual(limits.creditsList(), [])
  // On credits again, without a reset time: said again; a real stop ends it.
  limits.credits('host', {})
  assert.equal(logged.length, 2)
  assert.match(logged[1], /as the plan's limit is reached; nothing waits$/)
  limits.hit('host', { kind: 'usage', resetsAt: clockState.now + HOUR, limit: 'overage', text: "You're out of usage credits · resets 3pm" })
  assert.deepEqual(limits.creditsList(), [])
  assert.match(waitText('host', limits.active('host'), clockState.now), /^the workers on this computer wait for the Claude usage limit \(usage credits\) until \d\d:\d\d, when it resets$/)
  assert.equal(
    creditsText('container:dev', { since: clockState.now, until: clockState.now + HOUR, limit: 'overage', reset: false }, clockState.now),
    `the workers in the container dev run on usage credits since ${clock(clockState.now, clockState.now)}, as the plan's limit is reached; nothing waits`,
  )
  limits.close()
})

test('parseReset: the times Claude Code writes, the next such moment, in the computer\'s time', () => {
  const now = new Date(2026, 9, 31, 10, 0).getTime() // Sat 31 Oct, 10:00
  const at = text => {
    const ms = parseReset(text, now)
    return ms === null ? null : new Date(ms).toString().slice(0, 21)
  }
  assert.equal(at(LIMIT_TEXT), 'Sat Oct 31 2026 15:00')
  assert.equal(at('resets 9:30am'), 'Sun Nov 01 2026 09:30', 'past today: tomorrow')
  assert.equal(at('resets 12am'), 'Sun Nov 01 2026 00:00')
  assert.equal(at('resets 12pm'), 'Sat Oct 31 2026 12:00')
  assert.equal(at('resets Nov 3, 9am (Europe/Zurich)'), 'Tue Nov 03 2026 09:00')
  assert.equal(at('resets at 15:00'), 'Sat Oct 31 2026 15:00')
  assert.equal(at('resets 3'), null, 'no time')
  assert.equal(at('resets 13pm'), null)
  assert.equal(at('no reset here'), null)
})

test('worse: a usage limit over a throttle; the exact reset time over the text\'s; the words over the generic text', () => {
  const event = { kind: 'usage', resetsAt: 5000, exact: true, limit: 'five_hour', text: 'usage limit reached' }
  const fromText = { kind: 'usage', resetsAt: 9000, exact: false, limit: null, text: LIMIT_TEXT }
  const throttle = { kind: 'throttle', resetsAt: null, exact: false, limit: null, text: 'c' }
  assert.equal(worse(throttle, event), event)
  assert.equal(worse(event, throttle), event)
  // In a run's order: the event, then the result with its text.
  assert.deepEqual(worse(event, fromText), { kind: 'usage', resetsAt: 5000, exact: true, limit: 'five_hour', text: LIMIT_TEXT })
  assert.deepEqual(worse(fromText, { ...event, text: LIMIT_TEXT }), { kind: 'usage', resetsAt: 5000, exact: true, limit: 'five_hour', text: LIMIT_TEXT })
  const none = { kind: 'usage', resetsAt: null, exact: false, limit: null, text: 'x' }
  assert.equal(worse(fromText, none).resetsAt, 9000, 'a reset time is kept')
  assert.equal(worse(null, event), event)
})

// --- the waits ------------------------------------------------------------------------

function clockAt(start = Date.UTC(2026, 9, 31, 12)) {
  const clockState = { now: start }
  return { clockState, now: () => clockState.now }
}

test('a wait: until the reset, extended and never shortened, said once; ended by its time or by hand', () => {
  const { clockState, now } = clockAt()
  const events = []
  const limits = new Limits({ now, log: () => {} })
  limits.on('wait', (account, wait, first) => events.push(['wait', account, first]))
  limits.on('resume', (account, wait, why) => events.push(['resume', account, why]))
  const reset = clockState.now + 2 * 3600 * 1000
  const wait = limits.hit('host', { kind: 'usage', resetsAt: reset, limit: 'five_hour', text: LIMIT_TEXT, task: 'alpha t1ab' })
  assert.equal(wait.until, reset)
  assert.equal(wait.reset, true)
  assert.deepEqual(wait.tasks, ['alpha t1ab'])
  limits.hit('host', { resetsAt: reset - 3600 * 1000, task: 'beta t2cd' })
  assert.equal(limits.active('host').until, reset, 'not shortened')
  assert.deepEqual(limits.active('host').tasks, ['alpha t1ab', 'beta t2cd'])
  assert.deepEqual(events, [['wait', 'host', true], ['wait', 'host', false]])
  assert.equal(limits.active('controller'), null)
  assert.match(waitText('host', limits.active('host'), clockState.now), /^the workers on this computer wait for the Claude usage limit \(5-hour limit\) until \d\d:\d\d, when it resets$/)
  assert.equal(limits.list().length, 1)
  assert.ok(limits.any({ workers: true }))

  clockState.now = reset + 1
  assert.equal(limits.active('host'), null, 'its time is up')
  assert.deepEqual(events.at(-1), ['resume', 'host', 'its time is up'])
  limits.hit('controller', { resetsAt: reset + 3600 * 1000 })
  assert.equal(limits.end('controller', 'it answered again'), true)
  assert.equal(limits.end('controller'), false, 'once')
  assert.deepEqual(events.at(-1), ['resume', 'controller', 'it answered again'])
  limits.close()
})

test('without a reset time: a backoff of 15, 30, then 60 minutes; a run that gets through starts it again', () => {
  const { clockState, now } = clockAt()
  const limits = new Limits({ now, log: () => {} })
  const minutes = () => Math.round((limits.active('host').until - clockState.now) / 60000)
  const next = () => {
    clockState.now = limits.active('host').until + 1
    limits.active('host')
    limits.hit('host', { kind: 'throttle' })
    return minutes()
  }
  limits.hit('host', { kind: 'throttle', text: 'overloaded' })
  assert.equal(minutes(), 15)
  assert.equal(next(), 30)
  assert.equal(next(), 60)
  assert.equal(next(), 60)
  limits.hit('host', { kind: 'throttle' })
  assert.equal(minutes(), 60, 'a hit while it waits does not count again')
  limits.ok('host')
  assert.equal(next(), 15)
  assert.match(waitText('host', limits.active('host'), clockState.now), /the Claude API, which was overloaded, until \d\d:\d\d, then they try again$/)
  // A reset due already, or in a moment: the least wait.
  const short = new Limits({ now, minWaitMs: 60000, log: () => {} })
  assert.equal(short.hit('host', { resetsAt: clockState.now + 1000 }).until, clockState.now + 60000)
  limits.close()
  short.close()
})

test('the waits are kept across a restart; one over meanwhile ends at the start, with its event', () => {
  const file = join(TMP, 'limits.json')
  const { clockState, now } = clockAt()
  const first = new Limits({ file, now, log: () => {} })
  first.hit('host', { resetsAt: clockState.now + 3600 * 1000, text: LIMIT_TEXT })
  first.hit('container:workers', { resetsAt: clockState.now + 7200 * 1000 })
  first.close()
  clockState.now += 1800 * 1000
  const second = new Limits({ file, now, log: () => {} })
  assert.ok(second.active('host'), 'still waiting')
  clockState.now += 3600 * 1000
  const resumed = []
  second.on('resume', account => resumed.push(account))
  second.start()
  assert.deepEqual(resumed, ['host'])
  assert.ok(second.active('container:workers'))
  assert.match(second.list()[0].text, /^the workers in the container workers wait/)
  second.close()
})

test('clock: today as the time, another day with its date', () => {
  const now = new Date(2026, 9, 31, 10, 0).getTime()
  assert.equal(clock(new Date(2026, 9, 31, 15, 5).getTime(), now), '15:05')
  assert.equal(clock(new Date(2026, 10, 1, 9, 0).getTime(), now), '09:00 on 1 Nov')
})

test("open_items says what the gateway waits for, before the decisions", () => {
  const ledger = new Ledger({ log: () => {} })
  const text = openItems({ ledger, store: new Store(), notes: ['The workers on this computer wait for the Claude usage limit until 15:00, when it resets.'] })
  assert.match(text, /^\[open decisions=0 queued=0 running=0 requests=0 unanswered=0\]\nThe gateway now:\n- The workers on this computer wait for the Claude usage limit until 15:00, when it resets\.$/)
})

// --- the controller's transcript -----------------------------------------------------------

test("the controller's transcript: found by the session id; followed from its end, each limit once", async () => {
  const config = join(TMP, 'claude-config')
  const file = join(config, 'projects', '-home-someone-controller', 'session-1.jsonl')
  mkdirSync(join(config, 'projects', '-home-someone-controller'), { recursive: true })
  mkdirSync(join(config, 'projects', 'other'), { recursive: true })
  const old = { ...limitMessage(), timestamp: '2026-10-30T10:00:00Z' }
  writeFileSync(file, JSON.stringify(old) + '\n')
  assert.equal(transcriptFile({ sessionId: 'session-1', configDir: config }), file)
  assert.equal(transcriptFile({ sessionId: 'nope', configDir: config }), null)
  assert.equal(transcriptFile({ sessionId: '../x', configDir: config }), null)
  assert.equal(transcriptFile({ sessionId: undefined, configDir: config }), null)

  const hits = []
  const watch = new TranscriptWatch({ find: () => file, onLimit: (hit, at) => hits.push([hit.kind, at]), pollMs: 20, log: () => {} }).start()
  try {
    await sleep(80)
    assert.deepEqual(hits, [], 'what was there before is not this run')
    appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n')
    const line = JSON.stringify({ ...limitMessage(), timestamp: '2026-10-31T13:00:00.000Z' })
    appendFileSync(file, line.slice(0, 40))
    await sleep(60)
    appendFileSync(file, line.slice(40) + '\n')
    await until(() => hits.length === 1)
    assert.deepEqual(hits[0], ['usage', Date.parse('2026-10-31T13:00:00.000Z')])
    await sleep(80)
    assert.equal(hits.length, 1)
  } finally {
    watch.close()
  }
})

// --- the gateway as a whole -------------------------------------------------------------------

// The Bot API: messages are kept; getUpdates waits a little and has nothing.
const api = { messages: [], server: null, url: '' }
before(async () => {
  api.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const answer = result => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (req.url === `/bot${TOKEN}/sendMessage`) {
        api.messages.push(JSON.parse(body || '{}').text)
        return answer({ message_id: api.messages.length })
      }
      setTimeout(() => answer([]), 300)
    })
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  api.url = `http://127.0.0.1:${api.server.address().port}`
})
after(() => api.server?.close())

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('the controller meets the limit: one message, the events for it held, sent again once it answers', async () => {
  const secrets = join(TMP, 'gateway')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`, { mode: 0o600 })
  writeFileSync(join(secrets, 'telegram_chat_id'), CHAT_ID, { mode: 0o600 })
  const config = join(secrets, 'claude')
  const transcript = join(config, 'projects', '-home-someone-controller', 'usage-test.jsonl')
  mkdirSync(join(config, 'projects', '-home-someone-controller'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'start' } }) + '\n')
  const port = await freePort()
  const events = []
  let log = ''
  const claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  claudeCode.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }),
    ({ params }) => events.push(params),
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: join(secrets, 'state'),
      VOICE_GW_WORKER_ROOT: join(secrets, 'no-repositories'),
      VOICE_GW_PORT: String(port),
      VOICE_GW_MAX_WAIT: '2',
      VOICE_GW_DEFAULT_WAIT: '1',
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_SELF_CHECKOUT: '',
      VOICE_GW_NAME: 'Usage (test)',
      VOICE_GW_TELEGRAM_API: api.url,
      VOICE_GW_TRANSCRIPT_POLL: '0.1',
      CLAUDE_CODE_SESSION_ID: 'usage-test',
      CLAUDE_CONFIG_DIR: config,
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (log += chunk))
  await claudeCode.connect(stdio)
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await sleep(50)
    }
  }
  const { access_token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name: 'usage' })
  const voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await voice.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access_token}` } } }))
  const call = async (name, args = {}) => (await voice.callTool({ name, arguments: args })).content.map(c => c.text).join('\n')
  const idOf = out => /id=([a-z0-9]+)/.exec(out)?.[1]
  try {
    await until(() => log.includes("following the controller's transcript"))
    const summary = await until(() => events.find(e => e.meta?.kind === 'summary'))
    await claudeCode.callTool({ name: 'reply', arguments: { request_id: summary.meta.request_id, state: 'done', text: 'ok' } })

    // A request reaches the controller; its turn meets the limit.
    const first = idOf(await call('send', { message: 'How many files are in the playground?' }))
    await until(() => events.some(e => e.meta?.request_id === first))
    appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT_TEXT }] }, error: 'rate_limit', isApiErrorMessage: true }) + '\n')
    await until(() => log.includes('usage limit: the controller session wait until'))
    await until(() => api.messages.some(text => /the controller session reached the Claude usage limit/.test(text)))
    assert.match(api.messages.at(-1), /^cc-voice-gateway on \S+: the controller session reached the Claude usage limit \(You've hit your 5-hour limit .*\)\. What comes for it waits, and reaches it at \d\d:\d\d.*, when it resets\.$/)
    assert.match(log, /usage limit: 1 event the controller did not answer go to it again after the wait/)

    // What the driver sends now waits; the voice assistant hears so.
    const pushed = events.length
    const sent = await call('send', { message: 'And in the docs folder?' })
    const second = idOf(sent)
    assert.match(sent, /^Gateway Usage \(test\): active; the controller session wait for the Claude usage limit until \d\d:\d\d.*, when it resets\n\[state=sent id=\w+ held=usage\] Handed over\. Claude Code has reached its usage limit and answers again at /)
    const reply = await call('get_reply', { id: second, wait_seconds: 1 })
    assert.match(reply, /the request waits until then and reaches it by itself/)
    assert.doesNotMatch(reply, /Hint:/)
    assert.match(await call('status'), /\nWaiting: the controller session wait for the Claude usage limit until /)
    await sleep(200)
    assert.equal(events.length, pushed, 'held, not pushed')

    // The controller answers again (a tool call): both go to it, once each.
    await claudeCode.callTool({ name: 'list_workers', arguments: {} })
    await until(() => events.filter(e => e.meta?.resent === 'yes').length === 2)
    const again = events.filter(e => e.meta?.resent === 'yes').map(e => e.meta.request_id)
    assert.deepEqual(again, [first, second])
    await until(() => api.messages.some(text => /the controller session goes on \(it answered again\); what waited reaches it now\.$/.test(text)))
    assert.equal(api.messages.filter(text => /usage limit/.test(text)).length, 1, 'one message for the wait')
    await claudeCode.callTool({ name: 'reply', arguments: { request_id: second, state: 'done', text: 'Twelve.' } })
    assert.match(await call('get_reply', { id: second }), /^Gateway Usage \(test\): active\n\[state=done/)
    assert.ok(!log.includes(TOKEN))
  } finally {
    await voice.close()
    await claudeCode.close()
  }
})
