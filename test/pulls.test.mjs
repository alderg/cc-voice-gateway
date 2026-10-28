// Pull requests that workers open: which ones the gateway watches, and what
// it tells the controller about their checks and reviews.
//
// A fake gh answers from a JSON file the tests write, standing in for GitHub;
// nothing reaches the network. The watcher is tested on its own, and the
// gateway as a whole with a fake claude whose run opens a pull request.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { PullWatcher } from '../src/pulls.mjs'
import { WORKER_RULES } from '../src/workers.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-pulls-'))
const BIN = join(TMP, 'bin')
const GH = join(BIN, 'gh')
const GH_STATE = join(TMP, 'github.json')
const GH_LOG = join(TMP, 'gh-calls.jsonl')

const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const out = value => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(0) }
const fail = message => { process.stderr.write(message + '\\n'); process.exit(1) }
const [a, b, c] = args
if (a === 'auth' && b === 'status') state.me ? process.exit(0) : fail('You are not logged into any GitHub hosts.')
if (a === 'api' && b === 'user') state.me ? out({ login: state.me }) : fail('HTTP 401: Bad credentials')
const inline = a === 'api' && /^repos\\/(.+)\\/pulls\\/(\\d+)\\/comments/.exec(b)
if (inline) out(state.inline?.[inline[1] + '#' + inline[2]] ?? [])
if (a === 'pr' && b === 'view') {
  const pr = state.prs?.[args[args.indexOf('--repo') + 1] + '#' + c]
  pr ? out(pr) : fail('no pull requests found')
}
if (a === 'repo' && b === 'view') { process.stdout.write('PRIVATE\\n'); process.exit(0) }
fail('unknown command: ' + args.join(' '))
`

let github = {}
function setGitHub(change) {
  const next = structuredClone(github)
  github = change(next) ?? next
  writeFileSync(GH_STATE, JSON.stringify(github))
}

const pr = (number, extra = {}) => ({
  number,
  title: 'Fix the typo in the README',
  state: 'OPEN',
  isDraft: true,
  headRefName: 'voice/fix-typo',
  headRefOid: 'aaa111',
  url: `https://github.com/acme/alpha/pull/${number}`,
  statusCheckRollup: [],
  reviewRequests: [],
  reviews: [],
  comments: [],
  ...extra,
})
const run = (name, status, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion })

const ghCalls = () =>
  existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function waitUntil(predicate, ms = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      const value = predicate()
      if (value) return resolve(value)
      if (Date.now() - started > ms) return reject(new Error('timed out waiting'))
      setTimeout(check, 25)
    }
    check()
  })
}

// A watcher with a fast poll, its news and its log.
function watcher(name, options = {}) {
  const logged = []
  const news = []
  const w = new PullWatcher({
    ghBin: GH,
    stateFile: join(TMP, `${name}.json`),
    pollSeconds: 0.1,
    watchHours: 1,
    log: (...parts) => logged.push(parts.join(' ')),
    ...options,
  })
  w.on('news', item => news.push(item))
  return { w, news, logged }
}

const task = (pulls, extra = {}) => ({ id: 'tabc', repo: 'alpha', slug: 'acme/alpha', pulls, ...extra })

before(() => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(GH, FAKE_GH)
  chmodSync(GH, 0o755)
  process.env.FAKE_GH_STATE = GH_STATE
  process.env.FAKE_GH_LOG = GH_LOG
  setGitHub(() => ({ me: 'alderg', prs: {}, inline: {} }))
})

after(() => rmSync(TMP, { recursive: true, force: true }))

// --- which pull requests ------------------------------------------------------

test("only open pull requests of the run's repository on voice/ branches, as gh shows them", async () => {
  setGitHub(g => {
    g.prs['acme/alpha#7'] = pr(7)
    g.prs['acme/alpha#8'] = pr(8, { state: 'CLOSED' })
    g.prs['acme/alpha#9'] = pr(9, { headRefName: 'main', isDraft: false })
  })
  const { w } = watcher('which')
  try {
    assert.deepEqual(await w.fromRun(task([7, 8, 9, 10])), [
      { number: 7, title: 'Fix the typo in the README', isDraft: true, url: 'https://github.com/acme/alpha/pull/7' },
    ])
    assert.deepEqual(w.active().map(entry => entry.key), ['acme/alpha#7'])
    assert.deepEqual(await w.fromRun(task([7], { slug: null })), [], 'no GitHub remote')
    assert.deepEqual(await w.fromRun(task([])), [], 'the run named no pull request')
  } finally {
    w.close()
  }
})

// --- checks -------------------------------------------------------------------

test('checks: one event when every check on the head commit has finished, again only after a new push', async () => {
  setGitHub(g => {
    g.prs['acme/alpha#11'] = pr(11, { statusCheckRollup: [run('test', 'IN_PROGRESS'), run('lint', 'QUEUED')] })
  })
  const { w, news } = watcher('checks')
  try {
    await w.fromRun(task([11]))
    await sleep(400)
    assert.equal(news.length, 0, 'still running')
    setGitHub(g => {
      g.prs['acme/alpha#11'].statusCheckRollup = [
        run('test', 'COMPLETED', 'SUCCESS'),
        run('lint', 'COMPLETED', 'FAILURE'),
        run('docs', 'COMPLETED', 'SKIPPED'),
        { __typename: 'StatusContext', context: 'ci/other', state: 'SUCCESS' },
      ]
    })
    await waitUntil(() => news.length === 1)
    assert.equal(news[0].kind, 'checks')
    assert.deepEqual([news[0].worker, news[0].slug, news[0].number], ['alpha', 'acme/alpha', 11])
    assert.match(news[0].text, /^Pull request 11 in acme\/alpha \(worker alpha\): "Fix the typo in the README"\.$/m)
    assert.match(news[0].text, /^Checks finished on the latest push: 2 passed, 1 failed \(lint\), 1 skipped\.$/m)
    assert.match(news[0].text, /without asking anything/)
    await sleep(400)
    assert.equal(news.length, 1, 'once per commit')

    setGitHub(g => {
      g.prs['acme/alpha#11'].headRefOid = 'bbb222'
      g.prs['acme/alpha#11'].statusCheckRollup = [run('test', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'SUCCESS')]
    })
    await waitUntil(() => news.length === 2)
    assert.match(news[1].text, /Checks finished on the latest push: 2 passed\./)
  } finally {
    w.close()
  }
})

// --- reviews and comments ------------------------------------------------------

test('reviews and comments from others are news, with inline comments; those of the gh account are not', async () => {
  setGitHub(g => {
    g.prs['acme/alpha#12'] = pr(12, { isDraft: false, reviewRequests: [{ __typename: 'User', login: 'octo' }] })
  })
  const { w, news } = watcher('reviews')
  try {
    await w.fromRun(task([12]))
    await sleep(300)
    setGitHub(g => {
      Object.assign(g.prs['acme/alpha#12'], {
        reviews: [
          { id: 'R1', author: { login: 'copilot-pull-request-reviewer' }, state: 'COMMENTED', body: 'Two suggestions.' },
          { id: 'R2', author: { login: 'alderg' }, state: 'COMMENTED', body: 'Self-review: 3 findings.' },
          { id: 'R3', author: { login: 'octo' }, state: 'PENDING', body: 'not submitted yet' },
        ],
        comments: [
          { id: 'C1', author: { login: 'claude' }, body: 'Claude finished reviewing: looks good.' },
          { id: 'C2', author: { login: 'alderg' }, body: 'Own comment.' },
        ],
      })
      g.inline['acme/alpha#12'] = [
        { id: 1, user: { login: 'Copilot' }, path: 'src/a.js', line: 12, body: 'Use const here.' },
        { id: 2, user: { login: 'copilot-pull-request-reviewer[bot]' }, path: 'README.md', line: 3, body: 'Typo: recieve.' },
        { id: 3, user: { login: 'alderg' }, path: 'src/b.js', line: 1, body: 'Own inline comment.' },
      ]
    })
    await waitUntil(() => news.length === 1)
    const [item] = news
    assert.equal(item.kind, 'review,comment')
    assert.match(item.text, /^Review from copilot-pull-request-reviewer: commented, "Two suggestions\."\.$/m)
    assert.match(item.text, /^2 inline comments: src\/a\.js:12 "Use const here\."; README\.md:3 "Typo: recieve\."\.$/m)
    assert.match(item.text, /^Comment from claude: "Claude finished reviewing: looks good\."\.$/m)
    assert.doesNotMatch(item.text, /Self-review|Own comment|Own inline|not submitted/)
    await sleep(400)
    assert.equal(news.length, 1, 'nothing twice')

    setGitHub(g => {
      g.prs['acme/alpha#12'].reviews.push({ id: 'R4', author: { login: 'octo' }, state: 'APPROVED', body: '' })
    })
    await waitUntil(() => news.length === 2)
    assert.match(news[1].text, /^Review from octo: approved\.$/m)
    assert.doesNotMatch(news[1].text, /inline/, 'no inline comments that were news already')
  } finally {
    w.close()
  }
})

// --- when to stop -------------------------------------------------------------

test('nothing automatic: it stops quietly after the first polls, and notes a draft', async () => {
  setGitHub(g => {
    g.prs['acme/alpha#13'] = pr(13)
  })
  const { w, news, logged } = watcher('quiet')
  try {
    await w.fromRun(task([13]))
    await waitUntil(() => !w.active().length, 3000)
    const [entry] = w.watches
    assert.equal(entry.stopped, 'nothing automatic runs (a draft)')
    assert.equal(news.length, 0)
    assert.ok(logged.some(line => /stopped watching pull request acme\/alpha#13: nothing automatic runs/.test(line)))

    // A later run that names it again, for example one that asked for a review, starts anew.
    setGitHub(g => {
      g.prs['acme/alpha#13'].reviewRequests = [{ __typename: 'User', login: 'octo' }]
    })
    await w.fromRun(task([13]))
    await sleep(800)
    assert.equal(w.active().length, 1, 'a requested review is expected')
  } finally {
    w.close()
  }
})

test('merged or closed pull requests and the time limit end the watch', async () => {
  setGitHub(g => {
    g.prs['acme/alpha#14'] = pr(14, { statusCheckRollup: [run('test', 'IN_PROGRESS')] })
    g.prs['acme/alpha#15'] = pr(15, { statusCheckRollup: [run('test', 'IN_PROGRESS')] })
  })
  const { w } = watcher('ends')
  const short = watcher('time-limit', { watchHours: 0.5 / 3600 })
  try {
    await w.fromRun(task([14]))
    await sleep(250)
    setGitHub(g => {
      g.prs['acme/alpha#14'].state = 'MERGED'
    })
    await waitUntil(() => w.watches[0]?.stopped === 'merged')

    await short.w.fromRun(task([15]))
    await waitUntil(() => short.w.watches[0]?.stopped === 'time limit', 3000)
  } finally {
    w.close()
    short.w.close()
  }
})

test('without a gh login it does nothing', async () => {
  setGitHub(g => {
    g.me = null
    g.prs['acme/alpha#16'] = pr(16, { statusCheckRollup: [run('test', 'COMPLETED', 'SUCCESS')] })
  })
  const { w, news, logged } = watcher('no-login')
  const before = ghCalls().length
  try {
    assert.deepEqual(await w.fromRun(task([16])), [])
    assert.deepEqual(await w.fromRun(task([16])), [])
    assert.equal(w.watches.length, 0)
    assert.equal(news.length, 0)
    assert.ok(!ghCalls().slice(before).some(call => call[0] === 'pr'), 'not a single pull request was looked at')
    assert.equal(logged.filter(line => /gh is not logged in/.test(line)).length, 1, 'said once')
  } finally {
    w.close()
    setGitHub(g => {
      g.me = 'alderg'
    })
  }
})

test('watches survive a restart, and nothing is news twice', async () => {
  setGitHub(g => {
    g.prs['acme/alpha#17'] = pr(17, { statusCheckRollup: [run('test', 'COMPLETED', 'SUCCESS')] })
  })
  const first = watcher('restart')
  await first.w.fromRun(task([17]))
  await waitUntil(() => first.news.length === 1)
  await sleep(150)
  first.w.close()

  const second = watcher('restart')
  try {
    assert.deepEqual(second.w.active().map(entry => entry.key), ['acme/alpha#17'])
    await sleep(400)
    assert.equal(second.news.length, 0, 'the checks were news already')
    setGitHub(g => {
      g.prs['acme/alpha#17'].comments = [{ id: 'C9', author: { login: 'octo' }, body: 'Nice.' }]
    })
    await waitUntil(() => second.news.length === 1)
    assert.equal(second.news[0].kind, 'comment')
  } finally {
    second.w.close()
  }
})

// --- the gateway: a run opens a pull request -------------------------------------

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, input: readFileSync(0, 'utf8') }) + '\\n')
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
out({ type: 'system', subtype: 'init' })
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'gh pr create --draft' } }] } })
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'https://github.com/acme/alpha/pull/7\\n' }] } })
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Like https://github.com/other/repo/pull/99 did.' }] } })
out({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the typo; draft pull request 7 is open.' })
`

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test("gateway: the run's pull request is named in its result, and its checks follow as an event", async () => {
  const root = join(TMP, 'Developer')
  const dir = join(root, 'alpha')
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# alpha\n')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', 'git@github.com:acme/alpha.git')
  writeFileSync(join(BIN, 'claude'), FAKE_CLAUDE)
  chmodSync(join(BIN, 'claude'), 0o755)
  setGitHub(g => {
    g.prs['acme/alpha#7'] = pr(7, { statusCheckRollup: [run('test', 'IN_PROGRESS')] })
  })

  const events = []
  const claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => events.push(params),
  )
  await claudeCode.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [GATEWAY],
      env: {
        ...process.env,
        VOICE_GW_PORT: String(await freePort()),
        VOICE_GW_SECRETS_DIR: join(TMP, 'secrets'),
        VOICE_GW_STATE_DIR: join(TMP, 'state'),
        VOICE_GW_WORKER_ROOT: root,
        VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
        VOICE_GW_GH_BIN: GH,
        VOICE_GW_PR_POLL: '0.2',
        VOICE_GW_LOG_FILE: '',
        FAKE_CLAUDE_LOG: join(TMP, 'claude-calls.jsonl'),
      },
      stderr: 'ignore',
    }),
  )
  try {
    const started = await claudeCode.callTool({
      name: 'dispatch',
      arguments: { worker: 'alpha', task: 'Fix the typo.', words: 'Fix the typo.' },
    })
    const id = /task=(t[a-z0-9]{3})/.exec(started.content[0].text)[1]
    const result = await waitUntil(() => events.find(e => e.meta?.task === id))
    assert.equal(result.meta.pull_request, '7')
    assert.match(result.content, /^Pull request: 7 in acme\/alpha, "Fix the typo in the README", a draft\.$/m)
    assert.ok(!ghCalls().some(call => call.includes('99')), 'a pull request of another repository is not looked at')

    const call = JSON.parse(readFileSync(join(TMP, 'claude-calls.jsonl'), 'utf8').trim().split('\n').at(-1))
    const rules = call.args[call.args.indexOf('--append-system-prompt') + 1]
    assert.match(rules, /Review requests, only when the task asks for one/)
    assert.match(rules, /Review comments, only when the task asks to fix them/)

    setGitHub(g => {
      g.prs['acme/alpha#7'].statusCheckRollup = [run('test', 'COMPLETED', 'FAILURE')]
    })
    const checks = await waitUntil(() => events.find(e => e.meta?.kind === 'checks'))
    assert.deepEqual(
      { worker: checks.meta.worker, repo: checks.meta.repo, pull_request: checks.meta.pull_request },
      { worker: 'alpha', repo: 'acme/alpha', pull_request: '7' },
    )
    assert.match(checks.content, /Checks finished on the latest push: 0 passed, 1 failed \(test\)\./)
  } finally {
    await claudeCode.close()
  }
})

test('the worker rules: reviews and fixes only when the task asks, and the URL of a pull request in the answer', () => {
  assert.match(WORKER_RULES, /add them as reviewer with\n  gh pr edit --add-reviewer/)
  assert.match(WORKER_RULES, /post your findings as one\n  pull request review with gh api \(event COMMENT, comments inline/)
  assert.match(WORKER_RULES, /do not mark it ready yourself: end by asking whether to\./)
  assert.match(WORKER_RULES, /reply in one sentence on each thread you addressed\. Report\n  what you fixed and what you left open/)
  assert.match(WORKER_RULES, /with the pull request's URL if you opened or updated one/)
})
