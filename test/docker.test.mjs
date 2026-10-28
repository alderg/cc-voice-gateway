// Workers in the Docker container, and their access levels.
//
// A local HTTP server stands in for the GitHub API, so the level detection is
// tested without a real token. For the gateway as a whole, a fake `docker`
// runs `docker exec` commands right here, as if this computer were the
// container: its clones live in a temporary folder, and a fake `claude`
// stands in for Claude Code, as in workers.test.mjs.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { GitHubAccess } from '../src/access.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-docker-'))
const REPOS = join(TMP, 'container', 'repos') // /repos in the container
const HOST = join(TMP, 'host') // the checkouts on this computer, not used in Docker mode
const BIN = join(TMP, 'bin')
const SECRETS = join(TMP, 'secrets')
const TOKEN_FILE = join(SECRETS, 'worker', 'github_token')
const TOKEN = 'github_pat_TEST_token_never_in_a_log'
const CONTAINER = 'voice-workers'
const DOWN = join(TMP, 'container-down') // while it exists, the fake container does not answer

// --- the stand-in GitHub API -------------------------------------------------

// What the token may do per repository, and how main is protected.
const GITHUB = {
  'acme/open': { push: true, contents: true, pulls: true, protected: false, rules: [] },
  'acme/guarded': { push: true, contents: true, pulls: true, protected: false, rules: [{ type: 'pull_request' }] },
  'acme/classic': { push: true, contents: true, pulls: true, protected: true, rules: [] },
  'acme/forcepush': { push: true, contents: true, pulls: true, protected: false, rules: [{ type: 'non_fast_forward' }] },
  'acme/free': { push: true, contents: true, pulls: true, protected: false, rules: 403 },
  'acme/flaky': { push: true, contents: true, pulls: true, protected: false, rules: 502 },
  'acme/readonly': { push: true, contents: false, pulls: false },
  'acme/nopr': { push: true, contents: true, pulls: false },
  'acme/viewer': { push: false },
  'acme/site': { visibility: 'public', push: true, contents: true, pulls: true, protected: false, rules: [] },
}

const api = { server: null, url: '', requests: [] }

function answer(req, res, body) {
  const send = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  api.requests.push({ method: req.method, path: req.url, body, authorized: req.headers.authorization === `Bearer ${TOKEN}` })
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' })
  const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(req.url)
  const repo = match && GITHUB[match[1]]
  if (!repo) return send(404, { message: 'Not Found' })
  const forbidden = { message: 'Resource not accessible by personal access token' }
  const route = `${req.method} ${match[2] ?? ''}`
  if (route === 'GET ') {
    const visibility = repo.visibility ?? 'private'
    return send(200, { visibility, private: visibility !== 'public', default_branch: 'main', permissions: { push: repo.push } })
  }
  if (route === 'POST /git/refs') return repo.contents ? send(422, { message: 'Invalid request.' }) : send(403, forbidden)
  if (route === 'POST /pulls') return repo.pulls ? send(422, { message: 'Invalid request.' }) : send(403, forbidden)
  if (route === 'GET /branches/main') return send(200, { name: 'main', protected: repo.protected })
  if (route === 'GET /rules/branches/main') {
    return typeof repo.rules === 'number' ? send(repo.rules, { message: 'Upgrade to GitHub Pro' }) : send(200, repo.rules)
  }
  send(404, { message: 'Not Found' })
}

// --- fakes for docker and claude -----------------------------------------------

const FAKE_DOCKER = `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const argv = process.argv.slice(2)
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + '\\n')
if (argv.shift() !== 'exec') process.exit(2)
let cwd = process.cwd()
while (argv[0]?.startsWith('-')) if (argv.shift() === '-w') cwd = argv.shift()
const container = argv.shift()
if (container !== process.env.FAKE_DOCKER_CONTAINER || existsSync(process.env.FAKE_DOCKER_DOWN)) {
  process.stderr.write('Error response from daemon: container ' + container + ' is not running\\n')
  process.exit(1)
}
const [command, ...args] = argv
const runs = process.env.FAKE_DOCKER_RUNS
if (command === 'voice-run') {
  // As docker/voice-run: the run gets its own process group, here this one's.
  const [task, run, ...rest] = args
  mkdirSync(runs, { recursive: true })
  writeFileSync(join(runs, task), String(process.pid))
  spawn(run, rest, { cwd, stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1))
} else if (command === 'voice-stop') {
  try { process.kill(-Number(readFileSync(join(runs, args[0]), 'utf8')), 'SIGTERM') } catch {}
} else {
  process.exit(spawnSync(command, args, { cwd, stdio: 'inherit' }).status ?? 1)
}
`

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args, input, pid: process.pid }) + '\\n')
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
out({ type: 'system', subtype: 'init' })
setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'Committed on voice/fix.' }),
  /SLOW/.test(input) ? 8000 : 50)
`

function repo(root, name, origin) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  run('add', '.')
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')
  if (origin) run('remote', 'add', 'origin', origin)
}

// --- the gateway in Docker mode ----------------------------------------------

let gw

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

before(async () => {
  api.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => answer(req, res, body))
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  api.url = `http://127.0.0.1:${api.server.address().port}`

  mkdirSync(BIN, { recursive: true })
  for (const [name, script] of [['docker', FAKE_DOCKER], ['claude', FAKE_CLAUDE]]) {
    writeFileSync(join(BIN, name), script)
    chmodSync(join(BIN, name), 0o755)
  }
  for (const name of ['open', 'guarded', 'readonly', 'site']) repo(REPOS, name, `https://github.com/acme/${name}.git`)
  repo(REPOS, 'local')
  repo(HOST, 'host-only', 'git@github.com:acme/open.git')
  mkdirSync(join(SECRETS, 'worker'), { recursive: true, mode: 0o700 })
  writeFileSync(TOKEN_FILE, `${TOKEN}\n`, { mode: 0o600 })

  gw = { events: [], log: '' }
  gw.claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  gw.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => gw.events.push(params),
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(await freePort()),
      VOICE_GW_SECRETS_DIR: SECRETS,
      VOICE_GW_STATE_DIR: join(TMP, 'state'),
      VOICE_GW_WORKER_ROOT: HOST,
      VOICE_GW_DOCKER: CONTAINER,
      VOICE_GW_DOCKER_BIN: join(BIN, 'docker'),
      VOICE_GW_DOCKER_REPOS: REPOS,
      VOICE_GW_GITHUB_API: api.url,
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'), // the command inside the container
      VOICE_GW_GH_BIN: join(BIN, 'no-gh'),
      VOICE_GW_LOG_FILE: '',
      FAKE_DOCKER_LOG: join(TMP, 'docker-calls.jsonl'),
      FAKE_DOCKER_CONTAINER: CONTAINER,
      FAKE_DOCKER_DOWN: DOWN,
      FAKE_DOCKER_RUNS: join(TMP, 'runs'),
      FAKE_CLAUDE_LOG: join(TMP, 'claude-calls.jsonl'),
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (gw.log += chunk))
  await gw.claudeCode.connect(stdio)
})

after(async () => {
  await gw?.claudeCode.close()
  api.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

// --- helpers ------------------------------------------------------------------

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

async function controller(name, args = {}) {
  const result = await gw.claudeCode.callTool({ name, arguments: args })
  return { text: result.content.map(c => c.text).join('\n'), isError: result.isError }
}

const jsonLines = file =>
  existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
const dockerCalls = () => jsonLines(join(TMP, 'docker-calls.jsonl'))
const claudeCalls = () => jsonLines(join(TMP, 'claude-calls.jsonl'))
const arg = (call, name) => call.args[call.args.indexOf(name) + 1]

async function dispatch(worker, task, extra = {}) {
  const out = await controller('dispatch', { worker, task, words: task, ...extra })
  return { ...out, id: /task=(t[a-z0-9]{3})/.exec(out.text)?.[1] }
}

// The claude call of a run, once the run has ended.
async function runOf(worker, id) {
  await waitUntil(() => gw.events.find(e => e.meta?.worker === worker && e.meta?.task === id))
  return claudeCalls().findLast(call => call.cwd === join(REPOS, worker))
}

// --- level detection -----------------------------------------------------------

test('access: no token means read-only; no GitHub remote too; VOICE_GW_ACCESS forces a level', async () => {
  const none = new GitHubAccess({ tokenFile: join(TMP, 'no-such-file'), apiBase: api.url })
  assert.deepEqual(await none.check('acme/open'), { level: 'read-only', reason: 'no GitHub token', visibility: null, branch: null })
  const access = new GitHubAccess({ tokenFile: TOKEN_FILE, apiBase: api.url })
  assert.equal((await access.check(null)).reason, 'no GitHub remote')
  for (const level of ['read-only', 'pr', 'full']) {
    const forced = new GitHubAccess({ tokenFile: join(TMP, 'no-such-file'), apiBase: api.url, forced: level })
    assert.deepEqual(await forced.check('acme/viewer'), {
      level,
      reason: 'set by VOICE_GW_ACCESS',
      visibility: null,
      branch: null,
    })
  }
  const invalid = new GitHubAccess({ tokenFile: TOKEN_FILE, apiBase: api.url, forced: 'admin' })
  assert.equal((await invalid.check('acme/open')).level, 'full', 'an unknown level is ignored')
})

test('access: detected per repository from what the token may do and how main is protected', async () => {
  const access = new GitHubAccess({ tokenFile: TOKEN_FILE, apiBase: api.url })
  const expected = {
    'acme/open': ['full', 'main is not protected'],
    'acme/site': ['full', 'main is not protected'],
    'acme/forcepush': ['full', 'main is not protected'], // blocking force pushes keeps direct pushes possible
    'acme/free': ['full', 'main is not protected'], // rulesets not available: none applies
    'acme/guarded': ['pr', 'main is protected by a ruleset'],
    'acme/classic': ['pr', 'main is protected by branch protection'],
    'acme/flaky': ['pr', 'could not tell whether main is protected'],
    'acme/readonly': ['read-only', 'the token cannot push (Contents is read-only)'],
    'acme/nopr': ['read-only', 'the token cannot open pull requests'],
    'acme/viewer': ['read-only', 'the account cannot push to it'],
    'acme/unknown': ['read-only', 'the token cannot see the repository (404)'],
  }
  for (const [slug, [level, reason]] of Object.entries(expected)) {
    const result = await access.check(slug)
    assert.deepEqual([result.level, result.reason], [level, reason], slug)
  }
  assert.equal((await access.check('acme/site')).visibility, 'public')
  assert.equal((await access.check('acme/open')).visibility, 'private')

  // The write checks carry no content, so they cannot create anything.
  const probes = api.requests.filter(r => r.method === 'POST')
  assert.ok(probes.length > 0)
  for (const probe of probes) assert.equal(probe.body, '{}', probe.path)
})

test('access: cached per repository and token; a new token is checked again; errors never show the token', async () => {
  const file = join(TMP, 'token-cache')
  writeFileSync(file, TOKEN)
  const access = new GitHubAccess({ tokenFile: file, apiBase: api.url })
  const before = api.requests.length
  await access.check('acme/guarded')
  const asked = api.requests.length - before
  await access.check('acme/guarded')
  assert.equal(api.requests.length - before, asked, 'the second check comes from the cache')

  writeFileSync(file, 'github_pat_another_one')
  const rejected = await access.check('acme/guarded')
  assert.deepEqual([rejected.level, rejected.reason], ['read-only', 'GitHub rejected the token'])

  const nowhere = new GitHubAccess({ tokenFile: TOKEN_FILE, apiBase: 'http://127.0.0.1:1' })
  const unreachable = await nowhere.check('acme/open')
  assert.equal(unreachable.level, 'read-only')
  assert.match(unreachable.reason, /^GitHub API not reachable: /)
  assert.ok(!unreachable.reason.includes(TOKEN))
})

// --- the gateway with workers in the container ----------------------------------

test('Docker: list_workers shows the clones in the container with their access level', async () => {
  const { text } = await controller('list_workers')
  assert.match(text, /^\[workers=5 running=0 max=2 docker=voice-workers\]/)
  assert.match(text, /^guarded: acme\/guarded, private, access pr \(main is protected by a ruleset\), branch main, clean, idle$/m)
  assert.match(text, /^open: acme\/open, private, access full \(main is not protected\), branch main, clean, idle$/m)
  assert.match(text, /^readonly: acme\/readonly, private, access read-only \(the token cannot push \(Contents is read-only\)\), /m)
  assert.match(text, /^site: acme\/site, public, access full /m)
  assert.match(text, /^local: no remote, access read-only \(no GitHub remote\), branch main, clean, idle$/m)
  assert.doesNotMatch(text, /host-only/, 'the checkouts on this computer are not used')
  assert.ok(dockerCalls().every(call => call[0] === 'exec' && call.includes(CONTAINER)))
})

test('Docker: runs go through voice-run in the container, with the rules of their level', async () => {
  const readonly = await dispatch('readonly', 'Fix the typo.')
  assert.match(readonly.text, /^\[dispatch=started worker=readonly task=t[a-z0-9]{3} session=new access=read-only\]/)
  let call = await runOf('readonly', readonly.id)
  const exec = dockerCalls().find(c => c.includes('voice-run') && c.includes(readonly.id))
  assert.deepEqual(exec.slice(0, 8), ['exec', '-i', '-w', join(REPOS, 'readonly'), CONTAINER, 'voice-run', readonly.id, join(BIN, 'claude')])
  assert.equal(arg(call, '--permission-mode'), 'bypassPermissions')
  assert.match(arg(call, '--append-system-prompt'), /Publish: nothing leaves the container\. Never push and never open a pull request/)
  assert.doesNotMatch(arg(call, '--append-system-prompt'), /gh pr create/)
  assert.match(call.input, /^- Access level: read-only \(the token cannot push \(Contents is read-only\)\)\. Nothing leaves this container: no push, no pull request\.$/m)

  const guarded = await dispatch('guarded', 'Fix the typo.')
  assert.match(guarded.text, /access=pr\]/)
  call = await runOf('guarded', guarded.id)
  assert.match(arg(call, '--append-system-prompt'), /Publish: push the branch and open a draft pull request against the starting branch with\n  gh pr create --draft\./)
  assert.doesNotMatch(arg(call, '--append-system-prompt'), /Direct push/)
  assert.match(call.input, /^- Access level: pr \(main is protected by a ruleset\)\. Push a voice\/ branch and open a draft pull request\.$/m)

  const open = await dispatch('open', 'Fix the typo.')
  assert.match(open.text, /access=full\]/)
  call = await runOf('open', open.id)
  assert.match(arg(call, '--append-system-prompt'), /Only if the task says "Direct push: yes"/)
  assert.match(call.input, /^- Access level: full \(main is not protected\)\. .*a direct push only with "Direct push: yes"\.$/m)
  assert.doesNotMatch(call.input, /^- Direct push: yes/m, 'a pull request by default')
})

test('Docker: a direct push only at level full, and only when asked', async () => {
  const before = claudeCalls().length
  const refused = await dispatch('guarded', 'Push it straight to main.', { direct: true })
  assert.match(refused.text, /^\[dispatch=refused worker=guarded access=pr\] A direct push needs access level full; this repository is at pr \(main is protected by a ruleset\)\. Nothing started\./)
  assert.match((await dispatch('readonly', 'Push it.', { direct: true })).text, /^\[dispatch=refused worker=readonly access=read-only\]/)
  assert.equal(claudeCalls().length, before, 'nothing started')

  const direct = await dispatch('open', 'Push it straight to main.', { direct: true })
  assert.match(direct.text, /dispatch=started .*access=full/)
  const call = await runOf('open', direct.id)
  assert.match(call.input, /^- Direct push: yes\. The driver explicitly asked to push straight to main\.$/m)

  // On a public repository the worker still asks before it pushes: same rules, and the prompt says public.
  const site = await dispatch('site', 'Push it straight to main.', { direct: true })
  const siteCall = await runOf('site', site.id)
  assert.match(siteCall.input, /Repository: acme\/site \(public\)/)
  assert.match(arg(siteCall, '--append-system-prompt'), /If the task says the repository is public\n  or its visibility is unknown, do not push/)
})

test('Docker: stop_worker ends the run in the container with voice-stop', async () => {
  const run = await dispatch('local', 'SLOW: a long task.')
  assert.match(run.text, /dispatch=started/)
  const call = await waitUntil(() => claudeCalls().find(c => c.input.startsWith('SLOW')))
  assert.match((await controller('stop_worker', { worker: 'local' })).text, /^\[worker=local stopped task=t/)
  await waitUntil(() => dockerCalls().some(c => c.includes('voice-stop') && c.includes(run.id)))
  await waitUntil(() => {
    try {
      process.kill(call.pid, 0)
      return false
    } catch {
      return true
    }
  })
})

test('Docker: a container that does not answer is an error for the controller, not a crash', async () => {
  writeFileSync(DOWN, '')
  try {
    const list = await controller('list_workers')
    assert.equal(list.isError, true)
    assert.match(list.text, /The worker container voice-workers does not answer \(.*is not running\)\. Start it with: docker start voice-workers/)
    assert.equal((await controller('dispatch', { worker: 'open', task: 'x', words: 'x' })).isError, true)
  } finally {
    rmSync(DOWN)
  }
  assert.equal((await controller('list_workers')).isError, false)
})

test('Docker: the token never reaches the log, the docker calls or the worker arguments', async () => {
  await sleep(100)
  assert.match(gw.log, /workers run in the Docker container voice-workers, access level per repository from the GitHub token/)
  assert.ok(!gw.log.includes(TOKEN), 'log')
  assert.ok(!JSON.stringify(dockerCalls()).includes(TOKEN), 'docker calls')
  assert.ok(!JSON.stringify(claudeCalls()).includes(TOKEN), 'claude calls')
})
