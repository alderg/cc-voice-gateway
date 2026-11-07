// Several Claude accounts for the workers' runs (accounts.mjs): the driver
// asked in the car "das verteilen der aufgaben auf mehrere abos ... wird wohl
// bald nötig wir sind schon bei 37% weekly und reset ist am donnerstag." The
// setting's fixed rules, the token files, the headroom each run's
// rate_limit_event says, the choice by it, sessions that stay on their
// account, the usage limit per account, the token in the run's environment
// on this computer and through docker exec and voice-run, list_workers,
// worker_status and the statistics, and the gateway as a whole.
//
// Workers run here without the gateway, on temporary git repositories, with
// a stand-in for claude that logs the token it got and says how much of its
// plan is used; the last test starts the gateway itself.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

process.env.VOICE_GW_LOG_FILE = ''
const { ACCOUNT_TOKEN_ENV, Accounts, accountKey, parseAccounts } = await import('../src/accounts.mjs')
const { HEADROOM_STALE_MS, Limits, windowsOf } = await import('../src/limits.mjs')
const { Workers } = await import('../src/workers.mjs')
const { DockerRunner } = await import('../src/runners.mjs')
const { SettingsWatcher } = await import('../src/live.mjs')
const { Stats, detailsLines } = await import('../src/stats.mjs')
const { adminRequest } = await import('../src/admin.mjs')

const HERE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const GATEWAY = join(HERE, 'src', 'gateway.mjs')
const VOICE_RUN = join(HERE, 'docker', 'voice-run')
// Short and resolved: the gateway's admin socket is in a folder below it.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'vgw-acct-')))
const BIN = join(TMP, 'bin')
const CALLS = join(TMP, 'calls.jsonl')
const HOLDS = join(TMP, 'holds')
const PRO = 'sk-ant-oat01-PRO-test-token-never-in-a-log'
const TEAM = 'sk-ant-oat01-TEAM-test-token-never-in-a-log'
const HOUR = 60 * 60 * 1000

after(() => {
  for (let i = 0; i < 50; i++) writeFileSync(join(HOLDS, `h${i}`), '')
  rmSync(TMP, { recursive: true, force: true })
})

// The stand-in for claude. Words in the task:
//   USE:<n>     says first that <n> % of its weekly limit is used
//   HOLD:<name> then waits until the file holds/<name> is there
//   LIMIT[:<s>] meets the account's 5-hour limit, resetting in <s> seconds (2), unless it resumes
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const input = fs.readFileSync(0, 'utf8')
const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({
  task: process.env.VOICE_GW_TASK, cwd: process.cwd(), session: session_id, resumed: args.includes('--resume'), args, input,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}) + '\\n')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
out({ type: 'system', subtype: 'init' })
;(async () => {
  const use = /USE:(\\d+)/.exec(input)?.[1]
  if (use) {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt, rateLimitType: 'seven_day', overageStatus: 'allowed', isUsingOverage: false,
      unifiedWindows: { seven_day: { utilization: Number(use) / 100, resetsAt, status: 'allowed' } } } })
  }
  const hold = /HOLD:(\\w+)/.exec(input)?.[1]
  if (hold) while (!fs.existsSync(path.join(process.env.FAKE_HOLDS, hold))) await new Promise(r => setTimeout(r, 50))
  const limit = /LIMIT(?::(\\d+))?/.exec(input)
  if (limit && !/Resumed: /.test(input)) {
    const info = { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + Number(limit[1] ?? 2), rateLimitType: 'five_hour' }
    const text = "You've hit your 5-hour limit · resets 3pm (Europe/Zurich)"
    out({ type: 'rate_limit_event', rate_limit_info: info })
    out({ type: 'assistant', message: { content: [{ type: 'text', text }] }, error: 'rate_limit', is_api_error_message: true, api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: info } })
    out({ type: 'result', subtype: 'success', is_error: true, result: text })
    process.exit(1)
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 1.5, num_turns: 2 })
})()
`

mkdirSync(BIN, { recursive: true })
mkdirSync(HOLDS, { recursive: true })
writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
chmodSync(join(BIN, 'claude'), 0o755)
process.env.FAKE_CALLS = CALLS
process.env.FAKE_HOLDS = HOLDS

const calls = () =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
const callOf = id => calls().findLast(call => call.task === id)
let holdCount = 0
const hold = () => `h${holdCount++}`
const release = name => writeFileSync(join(HOLDS, name), '')

async function until(predicate, ms = 15000) {
  for (const begun = Date.now(); Date.now() - begun < ms; await new Promise(resolve => setTimeout(resolve, 25))) {
    const value = predicate()
    if (value) return value
  }
  throw new Error('timed out waiting')
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })

// A secrets folder with the tokens of the accounts named, 0600 in 0700
// folders, as the README says to place them.
function secrets(at, tokens = { pro: PRO, team: TEAM }) {
  const dir = join(at, 'secrets', 'accounts')
  for (const [name, token] of Object.entries(tokens)) {
    mkdirSync(join(dir, name), { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, name, 'claude_token'), token ? `${token}\n` : '', { mode: 0o600 })
  }
  return dir
}

let count = 0
// A folder of repositories without remotes, a secrets folder with pro and
// team, and workers on them that report as the gateway does.
function setup({ repos = ['alpha', 'beta', 'gamma'], setting = '', tokens, ...options } = {}) {
  const base = join(TMP, `case${++count}`)
  const root = join(base, 'Developer')
  for (const name of repos) {
    mkdirSync(join(root, name), { recursive: true })
    git(join(root, name), 'init', '-q', '-b', 'main')
    writeFileSync(join(root, name, 'a.txt'), 'a\n')
    git(join(root, name), 'add', '.')
    git(join(root, name), 'commit', '-q', '-m', 'init')
  }
  const lines = []
  const log = (...args) => lines.push(args.join(' '))
  const limits = new Limits({ minWaitMs: 0, log })
  const accounts = new Accounts({ dir: secrets(base, tokens), setting, limits, log })
  const workers = new Workers({ root, stateDir: join(base, 'state'), claudeBin: join(BIN, 'claude'), ghBin: join(BIN, 'no-gh'), limits, accounts, killAfterMs: 1000, ...options })
  workers.on('finished', async task => {
    if (task.reported) return
    await workers.audit(task)
    if (!task.reported) workers.markReported(task)
  })
  const dispatch = (worker, task, extra = {}) => workers.dispatch({ worker, task, words: 'the words', ...extra })
  return { base, root, lines, limits, accounts, workers, dispatch }
}

const ended = task => until(() => task.state !== 'running' && task.reported)

// --- the setting and the token files ------------------------------------------------

test('the setting: repository=account or several, * for the rest; a name that is no account name allows less, never more', () => {
  const { rules, problems } = parseAccounts(' hauswache=default ; drawio-dev=team, Default ;*=default,pro,team;; alpha')
  assert.deepEqual([...rules], [['hauswache', ['default']], ['drawio-dev', ['team', 'default']], ['*', ['default', 'pro', 'team']]])
  assert.deepEqual(problems, ['"alpha" is no repository=account'])
  const odd = parseAccounts('beta=pro,../team;gamma=;beta=team;de lta=pro')
  assert.deepEqual([...odd.rules], [['beta', ['team']]])
  assert.deepEqual(odd.problems, [
    `"../team" in beta's entry is no account name (lower case letters, digits, - and _)`,
    '"gamma=" names no account',
    'beta has two entries; the last counts',
    '"de lta=pro" is no repository=account',
  ])
  assert.equal(accountKey('default'), 'host')
  assert.equal(accountKey('default', 'voice-workers'), 'container:voice-workers')
  assert.equal(accountKey('pro', 'voice-workers'), 'account:pro', 'the same subscription wherever it runs')
})

test('the token files: one folder per account; missing, empty, readable by others or misnamed makes it unavailable, said once; the token is read each time', () => {
  const at = join(TMP, 'tokens')
  const dir = secrets(at)
  for (const name of ['empty', 'open', 'none', 'default', 'Big']) mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, 'empty', 'claude_token'), '', { mode: 0o600 })
  writeFileSync(join(dir, 'open', 'claude_token'), PRO, { mode: 0o644 })
  chmodSync(join(dir, 'open', 'claude_token'), 0o644)
  writeFileSync(join(dir, 'default', 'claude_token'), PRO, { mode: 0o600 })
  const lines = []
  const accounts = new Accounts({ dir, log: line => lines.push(line) })
  assert.deepEqual(accounts.found(), [
    { name: 'Big', problem: 'its folder name is no account name (lower case letters, digits, - and _)' },
    { name: 'default', problem: 'default is the login of this computer; give the folder another name' },
    { name: 'empty', problem: 'its claude_token is empty' },
    { name: 'none', problem: 'it has no claude_token (claude setup-token at the desk, signed in to that account)' },
    { name: 'open', problem: 'its claude_token can be read by others (chmod 600 it)' },
    { name: 'pro', problem: null },
    { name: 'team', problem: null },
  ])
  accounts.found()
  assert.equal(lines.filter(line => line.startsWith('account open unavailable')).length, 1, 'said once')
  assert.equal(accounts.token('pro'), PRO, 'trimmed')
  assert.equal(accounts.token('open'), null)
  assert.equal(accounts.token('default'), null, 'the login has none')
  assert.equal(accounts.available('default'), true)
  assert.equal(accounts.available('open'), false)
  // Fixed: it counts at once.
  chmodSync(join(dir, 'open', 'claude_token'), 0o600)
  assert.equal(accounts.available('open'), true)
  writeFileSync(join(dir, 'pro', 'claude_token'), 'two words\n', { mode: 0o600 })
  assert.equal(accounts.token('pro'), null, 'no token in it')
  assert.ok(lines.some(line => line === 'account pro unavailable: its claude_token holds no token (one line, as claude setup-token prints it)'))
  assert.ok(!lines.join('\n').includes(PRO), 'never the token')
  assert.equal(new Accounts({ dir: join(at, 'nothing') }).configured(), false, 'without a folder or a rule: only the default')
})

// --- the headroom --------------------------------------------------------------------

test('headroom: each window from the run\'s rate_limit_event, as a fraction; a reset since is nothing used, an old one unknown; kept across a restart', () => {
  const resetsAt = 1794502800
  const info = { status: 'allowed', resetsAt, rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.35, resetsAt }, five_hour: { utilization: 0.6, resetsAt: resetsAt - 3600 } } }
  assert.deepEqual(windowsOf(info), { seven_day: { used: 0.35, resetsAt: resetsAt * 1000 }, five_hour: { used: 0.6, resetsAt: (resetsAt - 3600) * 1000 } })
  assert.deepEqual(windowsOf({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 92, resetsAt }), { five_hour: { used: 0.92, resetsAt: resetsAt * 1000 } }, 'percent')
  assert.deepEqual(windowsOf({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }), { five_hour: { used: 1, resetsAt: resetsAt * 1000 } }, 'refused: used up')
  assert.deepEqual(windowsOf({ status: 'allowed', unifiedWindows: { overage: { utilization: 0.5 } } }), {}, "the credits' own window is no part of the plan")

  const file = join(TMP, 'limits.json')
  let now = (resetsAt - 7200) * 1000
  const limits = new Limits({ file, now: () => now, log: () => {} })
  limits.observe('account:pro', info)
  assert.equal(limits.headroom('account:pro').left, 0.4, 'the fuller window')
  assert.equal(limits.headroom('host').left, null, 'nothing known')
  // The same window lower, as from a run's output read again: the higher stays.
  limits.observe('account:pro', { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: resetsAt - 3600 } } })
  assert.equal(limits.headroom('account:pro').left, 0.4)
  // Kept with the waits.
  assert.deepEqual(new Limits({ file, now: () => now, log: () => {} }).headroom('account:pro'), limits.headroom('account:pro'))
  // The 5-hour window resets: nothing used there; the week's still counts.
  now = (resetsAt - 3000) * 1000
  const after = limits.headroom('account:pro')
  assert.equal(after.left, 0.65)
  assert.deepEqual(after.windows.map(w => [w.name, w.used]), [['seven_day', 0.35], ['five_hour', 0]])
  // No run on it for six hours: unknown, not full.
  now += HEADROOM_STALE_MS + 1000
  assert.equal(limits.headroom('account:pro').left, 1, 'the reset window is known; the week is stale')
  limits.observe('host', { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: resetsAt + 9e5 } } })
  now += HEADROOM_STALE_MS + 1000
  assert.deepEqual(limits.headroom('host'), { left: null, windows: [{ name: 'seven_day', used: null, resetsAt: (resetsAt + 9e5) * 1000, at: now - HEADROOM_STALE_MS - 1000, stale: true }] })
})

// --- the choice ----------------------------------------------------------------------

test('the choice: the most headroom in steps of 5 %, unknown as empty; credits only without room elsewhere; among equals fewer runs, then the default', () => {
  const at = join(TMP, 'choice')
  const limits = new Limits({ log: () => {} })
  const accounts = new Accounts({ dir: secrets(at), limits, log: () => {} })
  // Each figure in a window of its own: within one, a lower figure changes nothing.
  let windows = 0
  const use = (key, used) => limits.observe(key, { status: 'allowed', unifiedWindows: { seven_day: { utilization: used, resetsAt: Math.floor(Date.now() / 1000) + 86400 + ++windows } } })
  const choose = (extra = {}) => accounts.choose({ repo: 'alpha', ...extra })
  // Nothing known: all as empty, the default first.
  assert.deepEqual(choose(), { status: 'ok', name: 'default', key: 'host', why: 'the most headroom' })
  assert.equal(choose({ busy: { default: 1 } }).name, 'pro', 'fewer runs going')
  use('host', 0.37)
  assert.equal(choose().name, 'pro', 'unknown ranks as empty: tried, and known again')
  use('account:pro', 0.1)
  use('account:team', 0.08)
  assert.equal(choose().name, 'pro', 'pro and team in the same step: by name')
  assert.equal(choose({ busy: { pro: 1 } }).name, 'team')
  use('account:team', 0.02)
  assert.equal(choose({ busy: { team: 3 } }).name, 'team', 'a step more room wins over the runs going')
  // On usage credits: only when none other has room.
  limits.credits('account:team', { limit: 'five_hour', resetsAt: Date.now() + HOUR })
  assert.equal(choose().name, 'pro')
  use('account:pro', 0.99)
  use('host', 0.985)
  assert.equal(choose().name, 'team', 'none other has room: the one on credits')
  // Waiting accounts are left out; all of them waiting, the task waits.
  limits.hit('account:team', { resetsAt: Date.now() + HOUR, text: 'limit' })
  assert.equal(choose().name, 'default', 'pro and the default in the same step, without room: the default')
  limits.hit('account:pro', { resetsAt: Date.now() + HOUR, text: 'limit' })
  limits.hit('host', { resetsAt: Date.now() + HOUR, text: 'limit' })
  assert.deepEqual(choose(), { status: 'usage', keys: ['host', 'account:pro', 'account:team'] })
})

test('the choice: fixed rules pin or allow; a rule without an account available goes to the default, said once; a session stays, waits out a short wait, and leaves only for a new session', () => {
  const at = join(TMP, 'rules')
  const limits = new Limits({ log: () => {} })
  const lines = []
  const accounts = new Accounts({ dir: secrets(at), setting: 'beta=pro;gamma=team,default;delta=ultra;*=default,team', limits, log: line => lines.push(line) })
  const later = Date.now() / 1000 + 86400
  limits.observe('host', { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: later } } })
  limits.observe('account:team', { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: later } } })
  assert.deepEqual(accounts.choose({ repo: 'beta' }), { status: 'ok', name: 'pro', key: 'account:pro', why: 'the only one allowed' })
  assert.equal(accounts.choose({ repo: 'gamma' }).name, 'team')
  assert.equal(accounts.choose({ repo: 'alpha' }).name, 'team', 'the * entry: not pro')
  assert.equal(accounts.choose({ repo: 'scratch/new' }).name, 'team', 'work folders by the * entry too')
  // An account without a token: its runs on the default, said once.
  assert.deepEqual(accounts.choose({ repo: 'delta' }), { status: 'ok', name: 'default', key: 'host', why: 'the default, as its fixed rule names no account available' })
  accounts.choose({ repo: 'delta' })
  assert.equal(lines.filter(line => line.startsWith('VOICE_GW_ACCOUNTS: the entry delta=ultra names no account available')).length, 1)
  // A session stays on its account, also with less headroom.
  assert.deepEqual(accounts.choose({ repo: 'gamma', session: 'default' }), { status: 'ok', name: 'default', key: 'host', why: "its session's" })
  // Pinned: a wait holds it.
  limits.hit('account:pro', { resetsAt: Date.now() + HOUR, text: 'limit' })
  assert.deepEqual(accounts.choose({ repo: 'beta', session: 'pro' }), { status: 'usage', keys: ['account:pro'] })
  // Several allowed: an hour's wait it waits out with its session, where its context and cache are.
  limits.hit('host', { resetsAt: Date.now() + HOUR - 1000, text: 'limit' })
  assert.deepEqual(accounts.choose({ repo: 'gamma', session: 'default' }), { status: 'usage', keys: ['host'] })
  assert.equal(accounts.choose({ repo: 'gamma' }).name, 'team', 'a new session goes elsewhere at once')
  // A longer one: a new session on one that has room (Workers.start).
  limits.hit('host', { resetsAt: Date.now() + 3 * HOUR, text: 'limit' })
  const moved = accounts.choose({ repo: 'gamma', session: 'default' })
  assert.equal(moved.name, 'team')
  assert.match(moved.why, /^its session's account default waits until \d\d:\d\d(?: on \d+ \w+)?; the only one without a wait$/)
  // A session on an account that is gone, switched off or no longer allowed: the default, in a new session.
  limits.end('host')
  assert.deepEqual(accounts.choose({ repo: 'alpha', session: 'pro' }), {
    status: 'ok',
    name: 'default',
    key: 'host',
    why: "its session's account pro is gone, switched off or not allowed; the default",
  })
  assert.equal(accounts.choose({ repo: 'beta', session: 'ultra' }).status, 'usage', 'pinned to pro, which waits')
  // In a container whose voice-run is older: only its own login.
  assert.deepEqual(accounts.choose({ repo: 'gamma', container: 'voice-workers', named: false }), { status: 'ok', name: 'default', key: 'container:voice-workers', why: 'the only one allowed' })
})

test("dispatch's account: refused where it does not exist, is unavailable, a rule allows another, or the session goes on elsewhere; else taken, also while it waits", () => {
  const at = join(TMP, 'override')
  const limits = new Limits({ log: () => {} })
  const accounts = new Accounts({ dir: secrets(at, { pro: PRO, team: TEAM, old: '' }), setting: 'beta=pro', limits, log: () => {} })
  const refused = extra => accounts.choose({ repo: 'alpha', ...extra })
  assert.deepEqual(refused({ account: 'ultra' }), { status: 'refused', why: 'there is no account "ultra"; the accounts are default, old, pro, team' })
  assert.match(refused({ account: 'old' }).why, /^the account old is unavailable: its claude_token is empty$/)
  assert.equal(accounts.choose({ repo: 'beta', account: 'team' }).why, "a fixed rule of the driver's (VOICE_GW_ACCOUNTS) keeps beta on pro")
  assert.equal(
    refused({ account: 'team', session: 'pro' }).why,
    'the session it goes on with runs on pro, and a follow-up stays on its session\'s account; with fresh=true a new session may start on team',
  )
  assert.match(refused({ account: 'team', container: 'voice-workers', named: false }).why, /^runs in the container voice-workers take only its own login/)
  assert.deepEqual(refused({ account: 'team' }), { status: 'ok', name: 'team', key: 'account:team', why: 'named in dispatch' })
  // The session's account waits: it would move anyway, so the one named is taken.
  limits.hit('account:pro', { resetsAt: Date.now() + HOUR, text: 'limit' })
  assert.equal(refused({ account: 'team', session: 'pro' }).name, 'team')
  // The one named waits: the task waits for it.
  assert.deepEqual(accounts.choose({ repo: 'beta', account: 'pro' }), { status: 'usage', keys: ['account:pro'] })
})

// --- runs ----------------------------------------------------------------------------

test("a run on an account: its token as CLAUDE_CODE_OAUTH_TOKEN, no API key, in its environment only; the default's runs get none; kept with the run and its session", async () => {
  const { base, lines, workers, dispatch } = setup({ setting: 'beta=pro' })
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-key-of-the-callers'
  try {
    const pro = await dispatch('beta', 'Fix it.')
    assert.equal(pro.status, 'started')
    assert.equal(pro.task.account, 'pro')
    assert.equal(pro.task.accountWhy, 'the only one allowed')
    assert.equal(pro.accounts, true)
    const call = await until(() => callOf(pro.task.id))
    assert.equal(call.token, PRO)
    assert.equal(call.apiKey, null, 'nothing Claude Code would take before it')
    await ended(pro.task)
    const def = await dispatch('alpha', 'Fix that.')
    assert.equal(def.task.account, 'default')
    const plain = await until(() => callOf(def.task.id))
    assert.equal(plain.token, null)
    assert.equal(plain.apiKey, 'sk-ant-api03-a-key-of-the-callers', 'the login as before')
    await ended(def.task)
    // The session keeps its account; the token is never kept or logged.
    const state = readFileSync(join(base, 'state', 'workers.json'), 'utf8')
    assert.equal(JSON.parse(state).repos.beta.account, 'pro')
    for (const text of [state, JSON.stringify(calls().map(c => c.args)), lines.join('\n')]) assert.ok(!text.includes(PRO), 'never the token')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    workers.close()
  }
})

test('a session stays on its account: a follow-up goes on there with less headroom; fresh chooses again, and the next runs follow what the runs said', async () => {
  const { limits, workers, dispatch } = setup()
  try {
    const first = await dispatch('alpha', 'USE:80 first')
    assert.equal(first.task.account, 'default', 'nothing known: the default')
    await ended(first.task)
    assert.equal(Math.round(limits.headroom('host').left * 100), 20, 'from its rate_limit_event')
    const second = await dispatch('beta', 'USE:10 second')
    assert.equal(second.task.account, 'pro', 'unknown ranks as empty')
    await ended(second.task)
    const follow = await dispatch('alpha', 'go on')
    assert.equal(follow.task.account, 'default', "its session's")
    assert.equal(follow.task.accountWhy, "its session's")
    assert.equal(follow.task.resumed, true)
    await ended(follow.task)
    assert.equal(callOf(follow.task.id).token, null)
    const fresh = await dispatch('alpha', 'USE:15 start again', { fresh: true })
    assert.equal(fresh.task.account, 'team', 'a new session: team, unknown, before pro at 10 %')
    await ended(fresh.task)
    // The checkout's session is on team now.
    assert.equal(workers.state.repos.alpha.account, 'team')
    const next = await dispatch('gamma', 'third')
    assert.equal(next.task.account, 'pro', '90 % left, against 85 % and 20 %')
    await ended(next.task)
  } finally {
    workers.close()
  }
})

test('the usage limit per account: a wait on one holds only its runs; a short one the session waits out, a long one it leaves for a new session on another account; a pinned repository waits for its account', async () => {
  const { limits, workers, dispatch } = setup({ setting: 'beta=pro;*=pro,default' })
  try {
    // pro first: its use is unknown, the default's known.
    limits.observe('host', { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: Date.now() / 1000 + 86400 } } })
    const one = await dispatch('alpha', 'LIMIT:3 one')
    assert.equal(one.task.account, 'pro')
    await until(() => one.task.state === 'limited')
    assert.ok(limits.active('account:pro'), 'pro waits')
    assert.equal(limits.active('host'), null, 'the default does not')
    // A new session goes on at once on the default; the stopped run waits for pro, three seconds.
    const other = await dispatch('gamma', 'meanwhile')
    assert.equal(other.status, 'started')
    assert.equal(other.task.account, 'default')
    assert.equal(other.task.accountWhy, 'the only one without a wait')
    await ended(other.task)
    const resumed = await until(() => workers.state.tasks.find(t => t.queued === one.task.requeuedAs), 10000)
    assert.equal(resumed.account, 'pro')
    assert.equal(resumed.accountWhy, "its session's")
    let call = await until(() => callOf(resumed.id))
    assert.equal(call.resumed, true)
    assert.equal(call.session, callOf(one.task.id).session, 'the same session, on the same account')
    assert.equal(call.token, PRO)
    await ended(resumed)

    // A long wait: the task goes on on the default, in a new session.
    const two = await dispatch('alpha', 'LIMIT:7200 two')
    assert.equal(two.task.account, 'pro', "its session's")
    await until(() => two.task.state === 'limited')
    assert.match(await workers.listText(), /\nWaiting: the workers on the account pro wait for the Claude usage limit \(5-hour limit\) until \d\d:\d\d(?: on \d+ \w+)?, when it resets; nothing new starts there/)
    const moved = await until(() => workers.state.tasks.find(t => t.queued === two.task.requeuedAs))
    assert.equal(moved.account, 'default')
    assert.match(moved.accountWhy, /^its session's account pro waits until \d\d:\d\d(?: on \d+ \w+)?; the only one without a wait$/)
    assert.equal(moved.leftAccount, 'pro')
    call = await until(() => callOf(moved.id))
    assert.equal(call.resumed, false)
    assert.notEqual(call.session, callOf(two.task.id).session)
    assert.equal(call.token, null)
    assert.match(call.input, /^- New session: the earlier runs here worked in a session on another Claude account/m)
    assert.match(call.input, /^- Resumed: this task was interrupted \(the Claude usage limit was reached/m)
    await ended(moved)
    assert.equal(workers.state.repos.alpha.account, 'default', 'the checkout\'s session is on the default now')
    // Pinned to pro: it waits, and says for what.
    const beta = await dispatch('beta', 'pinned')
    assert.equal(beta.status, 'queued')
    assert.equal(beta.reason, 'usage')
    assert.match(beta.wait, /^the workers on the account pro wait for the Claude usage limit \(5-hour limit\) until \d\d:\d\d(?: on \d+ \w+)?, when it resets$/)
    assert.match(workers.statusText('beta'), /\nWaiting: the workers on the account pro wait for the Claude usage limit/)
    // pro goes on: it starts there.
    limits.end('account:pro', 'the test')
    const started = await until(() => workers.state.tasks.find(t => t.queued === beta.entry.id), 10000)
    assert.equal(started.account, 'pro')
    assert.equal((await until(() => callOf(started.id))).token, PRO)
    await ended(started)
  } finally {
    workers.close()
  }
})

test("dispatch's account: refused with the reason, nothing started; taken, also by a queued task across a restart", async () => {
  const { base, root, limits, accounts, workers, dispatch } = setup({ setting: 'beta=pro' })
  try {
    const refused = await dispatch('beta', 'on team', { account: 'team' })
    assert.deepEqual(refused, { status: 'account', account: 'team', why: "a fixed rule of the driver's (VOICE_GW_ACCOUNTS) keeps beta on pro" })
    assert.equal(workers.running().length, 0)
    const h = hold()
    const busy = await dispatch('alpha', `HOLD:${h} busy`)
    assert.equal(busy.task.account, 'default')
    // A follow-up goes on in the checkout's session, on the default.
    const follow = await dispatch('alpha', 'on team, later', { account: 'TEAM' })
    assert.equal(follow.status, 'account')
    assert.match(follow.why, /^the session it goes on with runs on default, and a follow-up stays on its session's account; with fresh=true a new session may start on team$/)
    const queued = await dispatch('alpha', 'on team, later', { account: 'TEAM', fresh: true })
    assert.equal(queued.status, 'queued')
    assert.equal(queued.entry.account, 'team')
    workers.close()
    // A new gateway on the same state: the queued task keeps it.
    const again = new Workers({ root, stateDir: join(base, 'state'), claudeBin: join(BIN, 'claude'), limits, accounts, killAfterMs: 1000 })
    again.on('finished', async task => {
      await again.audit(task)
      if (!task.reported) again.markReported(task)
    })
    try {
      assert.equal(again.queued('alpha')[0].account, 'team')
      release(h)
      const started = await until(() => again.state.tasks.find(t => t.queued === queued.entry.id))
      assert.equal(started.account, 'team')
      assert.equal(started.accountWhy, 'named in dispatch')
      assert.equal(started.resumed, false, 'a new session')
      assert.equal((await until(() => callOf(started.id))).token, TEAM)
      await ended(started)
    } finally {
      again.close()
    }
  } finally {
    workers.close()
  }
})

test('list_workers and worker_status: the accounts with their use and rules, and the account of each run; nothing about them with the default alone', async () => {
  const { workers, dispatch } = setup({ setting: 'beta=pro' })
  try {
    const h = hold()
    const run = await dispatch('beta', `USE:12 HOLD:${h} working`)
    await until(() => callOf(run.task.id))
    await until(() => workers.limits.headroom('account:pro').left !== null)
    const list = await workers.listText()
    assert.match(list, /^\[workers=3 running=1 max=2 accounts=3\]$/m)
    assert.match(
      list,
      /^Accounts: default \(this computer's login, the controller's\) use unknown, no run seen yet; pro 12 % of the weekly limit \(resets \d\d:\d\d on \d+ \w+\) used, 1 run going; team use unknown, no run seen yet\. Fixed rules \(VOICE_GW_ACCOUNTS\): beta: pro; the rest by headroom\.$/m,
    )
    assert.match(list, new RegExp(`^beta: no remote, branch main, clean, running ${run.task.id} on pro for `, 'm'))
    const status = workers.statusText('beta')
    assert.match(status, new RegExp(`^\\[worker=beta state=running task=${run.task.id} account=pro elapsed=\\d+s\\]$`, 'm'))
    assert.match(status, /^Account: pro \(the only one allowed\)\.$/m)
    release(h)
    await ended(run.task)
  } finally {
    workers.close()
  }
  // Without further accounts or rules: as before.
  const plain = new Workers({ root: join(TMP, 'case1', 'Developer'), stateDir: join(TMP, 'plain-state') })
  try {
    const list = await plain.listText()
    assert.match(list, /^\[workers=3 running=0 max=2\]$/m)
    assert.doesNotMatch(list, /Accounts:|accounts=/)
  } finally {
    plain.close()
  }
})

test('adding and removing an account at the desk: a token file, or its folder deleted or switched off with a dot, counts at the next start; its sessions go on on the default, in new sessions', async () => {
  const { base, lines, workers, dispatch } = setup({ tokens: { team: TEAM } })
  const dir = join(base, 'secrets', 'accounts')
  try {
    const first = await dispatch('alpha', 'USE:40 first')
    assert.equal(first.task.account, 'default')
    await ended(first.task)
    const team = await dispatch('beta', 'on team')
    assert.equal(team.task.account, 'team', 'unknown ranks as empty')
    await ended(team.task)
    // Added: a new folder with a token, no restart.
    secrets(base, { extra: PRO })
    assert.match(await workers.listText(), /accounts=3\]/)
    assert.match(await workers.listText(), /; extra use unknown, no run seen yet; team /)
    // Switched off: the folder named with a dot. Its session goes on on the default, anew.
    renameSync(join(dir, 'team'), join(dir, '.team'))
    assert.doesNotMatch(await workers.listText(), /team/)
    const follow = await dispatch('beta', 'go on')
    assert.equal(follow.task.account, 'default')
    assert.equal(follow.task.accountWhy, "its session's account team is gone, switched off or not allowed; the default")
    assert.equal(follow.task.resumed, false)
    assert.equal(follow.task.leftAccount, 'team')
    await ended(follow.task)
    // Switched on again, the next new session may take it; deleted, it is gone for good.
    renameSync(join(dir, '.team'), join(dir, 'team'))
    assert.equal(workers.accounts.available('team'), true)
    rmSync(join(dir, 'team'), { recursive: true })
    assert.equal(workers.accounts.available('team'), false)
    assert.doesNotMatch(await workers.listText(), /team/)
    assert.ok(lines.includes("accounts for the workers' runs now: default, extra, team; added extra"))
    assert.ok(lines.includes("accounts for the workers' runs now: default, extra; no longer team, whose sessions go on on the default, anew"))
  } finally {
    workers.close()
  }
})

test('the statistics: runs and their cost by account, once another than the default took some', () => {
  const stats = new Stats({ log: () => {} })
  const run = (account, costUsd) => ({ id: `t${Math.random()}`, repo: 'alpha', state: 'done', startedAt: 0, finishedAt: 20 * 60 * 1000, account, usage: { costUsd, costKnown: true } })
  stats.runEnded(run(undefined, 3))
  let line = detailsLines(stats.snapshot().current).find(l => l.startsWith('Worker runs:'))
  assert.doesNotMatch(line, /By account/, 'the default alone: nothing to say')
  stats.runEnded(run('default', 40))
  stats.runEnded(run('pro', 6))
  line = detailsLines(stats.snapshot().current).find(l => l.startsWith('Worker runs:'))
  assert.match(line, /By account: default 2 \(40 min, about 43 dollars\), pro 1 \(20 min, about 6 dollars\)\.$/)
  assert.deepEqual({ ...stats.snapshot().total.accounts.pro }, { runs: 1, ms: 20 * 60 * 1000, costUsd: 6 })
})

// --- the container --------------------------------------------------------------------

test('in the container: docker exec names the token only, its value from the client\'s environment; voice-run makes it the run\'s login in place of the container\'s', async () => {
  const log = join(TMP, 'docker.jsonl')
  const docker = join(BIN, 'docker-acct')
  writeFileSync(
    docker,
    `#!/usr/bin/env node
const { spawnSync } = require('child_process')
const argv = process.argv.slice(2)
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, token: process.env.${ACCOUNT_TOKEN_ENV} ?? null }) + '\\n')
// docker exec <container> sh -c <script>: run here, as the container would
if (argv[0] === 'exec' && argv[2] === 'sh') process.exit(spawnSync('sh', argv.slice(3), { stdio: 'ignore', env: process.env }).status ?? 1)
`,
  )
  chmodSync(docker, 0o755)
  const runner = new DockerRunner({ container: 'voice-workers', root: '/repos', dockerBin: docker })
  const child = runner.spawn('t2ab', 'claude', ['-p'], { cwd: '/repos/alpha', stdio: 'ignore', env: { PATH: process.env.PATH }, runEnv: { TMPDIR: '/repos/.voice-runs/x' }, token: PRO })
  await new Promise(resolve => child.on('exit', resolve))
  const [call] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(call.argv, ['exec', '-i', '-w', '/repos/alpha', '-e', 'TMPDIR=/repos/.voice-runs/x', '-e', ACCOUNT_TOKEN_ENV, 'voice-workers', 'voice-run', 't2ab', 'claude', '-p'])
  assert.equal(call.token, PRO, 'from the client\'s environment')
  assert.ok(!JSON.stringify(call.argv).includes(PRO), 'on no command line')
  // Whether its voice-run takes it: by the variable's name in the file on its PATH.
  assert.equal(runner.accountTokens, false, 'unknown: no')
  const old = await runner.takesAccounts()
  assert.equal(old, false)
  const path = join(TMP, 'image-bin')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'voice-run'), readFileSync(VOICE_RUN))
  chmodSync(join(path, 'voice-run'), 0o755)
  const saved = process.env.PATH
  process.env.PATH = `${path}:${saved}`
  try {
    assert.equal(await runner.takesAccounts(), true)
    assert.equal(runner.accountTokens, true)
  } finally {
    process.env.PATH = saved
  }
})

const setsid = spawnSync('sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }).status === 0

test('docker/voice-run: the account\'s token over the container\'s, the variable gone; without it, the container\'s own', { skip: !setsid && 'no setsid here (macOS)' }, () => {
  const folder = join(TMP, 'run-secrets')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'claude_token'), 'container-token\n', { mode: 0o600 })
  const task = `tacct${process.pid}`
  const run = env =>
    execFileSync('sh', [VOICE_RUN, task, 'sh', '-c', 'printf "%s|%s|%s" "$CLAUDE_CODE_OAUTH_TOKEN" "${VOICE_GW_ACCOUNT_TOKEN-unset}" "${ANTHROPIC_API_KEY-unset}"'], {
      env: { PATH: process.env.PATH, VOICE_SECRETS: folder, ...env },
      encoding: 'utf8',
    })
  try {
    assert.equal(run({ [ACCOUNT_TOKEN_ENV]: PRO, ANTHROPIC_API_KEY: 'key' }), `${PRO}|unset|unset`)
    assert.equal(run({ ANTHROPIC_API_KEY: 'key' }), 'container-token|unset|key')
  } finally {
    rmSync(join('/tmp/voice-runs', task), { force: true })
  }
})

// --- the settings file --------------------------------------------------------------

test('the settings file while the gateway runs: a changed VOICE_GW_ACCOUNTS comes at once; the environment wins', () => {
  const file = join(TMP, 'live.env')
  writeFileSync(file, 'VOICE_GW_PORT=8787\n')
  const lines = []
  const limits = { VOICE_GW_MAX_WORKERS: 2, VOICE_GW_MAX_WORKERS_PER_REPO: 1 }
  const watcher = new SettingsWatcher({ file, env: {}, limits, log: line => lines.push(line) })
  writeFileSync(file, 'VOICE_GW_PORT=8787\nVOICE_GW_ACCOUNTS=beta=pro\n')
  const added = watcher.reload()
  assert.equal(added.accounts, 'beta=pro')
  assert.deepEqual(added.others, [], 'no restart needed')
  writeFileSync(file, 'VOICE_GW_PORT=8787\n')
  assert.equal(watcher.reload().accounts, '', 'taken out: none')
  watcher.close()
  writeFileSync(file, 'VOICE_GW_ACCOUNTS=beta=pro\n')
  const pinned = new SettingsWatcher({ file, env: { VOICE_GW_ACCOUNTS: 'beta=team' }, limits, log: line => lines.push(line) })
  writeFileSync(file, 'VOICE_GW_ACCOUNTS=beta=default\n')
  assert.equal(pinned.reload(), null)
  assert.ok(lines.some(line => /VOICE_GW_ACCOUNTS changed in the settings file, but the environment sets it, which wins: the accounts' rules stay as they are/.test(line)))
  pinned.close()
  // Applied, the rules count for the next run that starts.
  const accounts = new Accounts({ setting: 'beta=pro', log: () => {} })
  assert.deepEqual(accounts.set('beta=team;x y=pro'), ['"x y=pro" is no repository=account'])
  assert.equal(accounts.text(), 'beta: team')
})

// --- the gateway as a whole ------------------------------------------------------------

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

test('the gateway: list_workers names the accounts, dispatch takes one or says why not, a wait on one holds neither the others nor the controller, and stats count by account', async () => {
  const base = join(TMP, 'gw')
  const root = join(base, 'Developer')
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(root, name), { recursive: true })
    git(join(root, name), 'init', '-q', '-b', 'main')
    writeFileSync(join(root, name, 'a.txt'), 'a\n')
    git(join(root, name), 'add', '.')
    git(join(root, name), 'commit', '-q', '-m', 'init')
  }
  secrets(base)
  const port = await freePort()
  const events = []
  let stderr = ''
  const claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  claudeCode.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }),
    ({ params }) => events.push(params),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: join(base, 'secrets'),
      VOICE_GW_STATE_DIR: join(base, 'state'),
      VOICE_GW_WORKER_ROOT: root,
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'no-gh'),
      VOICE_GW_SELF_CHECKOUT: '',
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_MAX_WORKERS: '3',
      VOICE_GW_ACCOUNTS: 'beta=pro;gamma=team',
    },
    stderr: 'pipe',
  })
  transport.stderr.on('data', chunk => (stderr += chunk))
  await claudeCode.connect(transport)
  let voice
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    const { access_token } = await adminRequest(join(base, 'secrets', 'admin.sock'), 'POST', '/token', { name: 'test' })
    voice = new Client({ name: 'fake-voice', version: '0.0.0' })
    await voice.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access_token}` } } }))
    const tool = async (name, args = {}) => (await claudeCode.callTool({ name, arguments: args })).content.map(c => c.text).join('\n')
    const dispatch = async (worker, task, extra = {}) => {
      await voice.callTool({ name: 'send', arguments: { message: task } })
      return tool('dispatch', { worker, task, words: task, ...extra })
    }
    const idOf = text => /task=(t[a-z0-9]{3})/.exec(text)?.[1]
    const result = id => until(() => events.find(e => e.meta?.task === id))

    assert.match(stderr, /accounts for the workers' runs: default \(the login\), pro, team; fixed rules \(VOICE_GW_ACCOUNTS\): beta: pro; gamma: team; the rest by headroom/)
    const list = await tool('list_workers')
    assert.match(list, /^\[workers=3 running=0 max=3 accounts=3\]$/m)
    assert.match(list, /^Accounts: default \(this computer's login, the controller's\) use unknown, no run seen yet; pro use unknown, no run seen yet; team use unknown, no run seen yet\. Fixed rules \(VOICE_GW_ACCOUNTS\): beta: pro; gamma: team; the rest by headroom\.$/m)

    const refused = await dispatch('beta', 'Please fix the beta tests.', { account: 'team' })
    assert.match(refused, /^\[dispatch=refused worker=beta account=team\] Nothing started: a fixed rule of the driver's \(VOICE_GW_ACCOUNTS\) keeps beta on pro\. Tell the driver/)
    const gamma = await dispatch('gamma', 'Please fix the gamma docs.')
    assert.match(gamma, /^\[dispatch=started worker=gamma task=t[a-z0-9]{3} session=new account=team\]/)
    await result(idOf(gamma))
    assert.equal(callOf(idOf(gamma)).token, TEAM)

    // pro meets its limit; the gateway waits at least a minute for it.
    const beta = await dispatch('beta', 'Please LIMIT the beta work.')
    assert.match(beta, /account=pro/)
    await until(() => /usage limit: the workers on the account pro wait until/.test(stderr))
    const again = await dispatch('beta', 'Please run the beta tests again.')
    assert.match(again, /^\[dispatch=queued worker=beta queued=q[a-z0-9]{3} position=\d reason=usage\] Queued, because the workers on the account pro wait for the Claude usage limit/)
    // The default and the controller go on: a run there reports at once.
    const alpha = await dispatch('alpha', 'Please check alpha.')
    assert.match(alpha, /dispatch=started worker=alpha .*account=default/)
    const done = await result(idOf(alpha))
    assert.equal(done.meta.outcome, 'done')
    assert.doesNotMatch(stderr, /usage limit: the controller session wait/)
    const status = (await voice.callTool({ name: 'status', arguments: {} })).content.map(c => c.text).join('\n')
    assert.match(status, /Waiting: the workers on the account pro wait for the Claude usage limit/)
    assert.doesNotMatch(status, /controller session wait/)

    const byAccount = /By account: ([^\n]*)/.exec(await tool('stats'))?.[1] ?? ''
    for (const name of ['default', 'team', 'pro']) assert.match(byAccount, new RegExp(`\\b${name} 1 \\(`), name)
    assert.ok(!stderr.includes(PRO) && !stderr.includes(TEAM), 'never a token in the log')
  } finally {
    await voice?.close()
    await claudeCode.close()
  }
})
