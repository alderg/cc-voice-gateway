// Workers in the Docker container, their access levels, and how changes get
// from the container's folder into a clean clone.
//
// A local HTTP server stands in for the GitHub API, so the level detection is
// tested without a real token. For the gateway as a whole, a fake `docker`
// runs `docker exec` commands right here, as if this computer were the
// container: the mounted folder is a temporary one, and a fake `claude`
// stands in for Claude Code, as in workers.test.mjs. What the fake container
// runs sees CONTAINER_SIDE=1, so the tests can tell it from the host.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'
import { GitHubAccess } from '../src/access.mjs'
import { DockerRunner } from '../src/runners.mjs'

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
const SCRIPT = fileURLToPath(new URL('../scripts/fetch-from-container.sh', import.meta.url))
const START_CONTAINER = fileURLToPath(new URL('../scripts/start-workers-container.sh', import.meta.url))
const CLEAN = join(TMP, 'clean') // the clean clones on this computer
const MARKERS = join(TMP, 'markers') // what ran on the host side

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
const verb = argv.shift()
if (['update', 'stop', 'rm', 'run'].includes(verb)) {
  // a stopped container no longer answers
  if (verb === 'stop') writeFileSync(process.env.FAKE_DOCKER_DOWN, '')
  process.exit(0)
}
if (verb === 'inspect') {
  // docker inspect [--format template] <container>: its mount of the host folder
  if (argv.at(-1) !== process.env.FAKE_DOCKER_CONTAINER) {
    process.stderr.write('Error: No such object: ' + argv.at(-1) + '\\n')
    process.exit(1)
  }
  const mount = { Type: process.env.FAKE_DOCKER_MOUNT_TYPE || 'bind', Source: process.env.FAKE_DOCKER_FOLDER, Destination: process.env.FAKE_DOCKER_REPOS, RW: true }
  const info = { State: { Running: !existsSync(process.env.FAKE_DOCKER_DOWN) }, Mounts: [mount] }
  process.stdout.write((argv[0] === '--format' ? mount.Source : JSON.stringify([info])) + '\\n')
  process.exit(0)
}
if (verb !== 'exec') process.exit(2)
const env = { ...process.env, CONTAINER_SIDE: '1' }
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
  spawn(run, rest, { cwd, stdio: 'inherit', env }).on('exit', code => process.exit(code ?? 1))
} else if (command === 'voice-stop') {
  try { process.kill(-Number(readFileSync(join(runs, args[0]), 'utf8')), 'SIGTERM') } catch {}
} else {
  process.exit(spawnSync(command, args, { cwd, stdio: 'inherit', env }).status ?? 1)
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
      VOICE_GW_KILL_CHECK: '1',
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'), // the command inside the container
      VOICE_GW_GH_BIN: join(BIN, 'no-gh'),
      VOICE_GW_LOG_FILE: '',
      FAKE_DOCKER_LOG: join(TMP, 'docker-calls.jsonl'),
      FAKE_DOCKER_CONTAINER: CONTAINER,
      FAKE_DOCKER_DOWN: DOWN,
      FAKE_DOCKER_RUNS: join(TMP, 'runs'),
      FAKE_DOCKER_FOLDER: REPOS, // the host folder mounted at /repos
      FAKE_DOCKER_REPOS: REPOS,
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
  assert.ok(dockerCalls().every(call => ['exec', 'inspect'].includes(call[0]) && call.includes(CONTAINER)))
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

// --- the host folder, the user, and getting changes out --------------------------

// What the fake docker needs when a test calls it directly.
const fakeDockerEnv = () => ({
  ...process.env,
  FAKE_DOCKER_LOG: join(TMP, 'docker-calls.jsonl'),
  FAKE_DOCKER_CONTAINER: CONTAINER,
  FAKE_DOCKER_DOWN: DOWN,
  FAKE_DOCKER_RUNS: join(TMP, 'runs'),
  FAKE_DOCKER_FOLDER: REPOS,
  FAKE_DOCKER_REPOS: REPOS,
})

test('Docker: the gateway names the host folder and the user the container runs as, and warns when they are off', async () => {
  const uid = `${process.getuid()}:${process.getgid()}`
  await waitUntil(() => /worker container voice-workers: repositories from host folder/.test(gw.log))
  assert.match(gw.log, new RegExp(`worker container voice-workers: repositories from host folder ${REPOS}, running as ${uid}\\n`))
  assert.doesNotMatch(gw.log, /worker container voice-workers: (no host folder|\S+ is a |it runs as)/)

  const runner = new DockerRunner({ container: CONTAINER, root: REPOS, dockerBin: join(BIN, 'docker') })
  Object.assign(process.env, fakeDockerEnv(), { FAKE_DOCKER_MOUNT_TYPE: 'volume' })
  try {
    const off = await runner.check(4242, 4243)
    assert.equal(off.folder, null)
    assert.deepEqual(off.warnings, [
      `${REPOS} is a volume, not a host folder`,
      `it runs as ${uid}, not as 4242:4243, so the files in the folder are not yours`,
    ])
  } finally {
    delete process.env.FAKE_DOCKER_MOUNT_TYPE
  }
})

// A repository in the container's folder whose config and hooks try to run
// something on the host: each payload leaves a marker, unless it runs in the
// container. And the commits carry a .gitattributes for a filter that the
// host user has configured, as with git-lfs.
function containerRepoAndCleanClone(name) {
  const q = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' })
  const origin = join(TMP, 'origin', `${name}.git`)
  mkdirSync(origin, { recursive: true })
  q(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = join(TMP, 'seed', name)
  mkdirSync(seed, { recursive: true })
  q(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'README.md'), `# ${name}\n`)
  q(seed, 'add', '.')
  q(seed, 'commit', '-q', '-m', 'init')
  q(seed, 'push', '-q', origin, 'main')
  q(TMP, 'clone', '-q', origin, join(CLEAN, name))
  const repo = join(REPOS, name)
  q(TMP, 'clone', '-q', origin, repo)
  q(repo, 'switch', '-q', '-c', 'voice/fix')
  writeFileSync(join(repo, '.gitattributes'), '* filter=lfstest\n')
  writeFileSync(join(repo, 'fix.txt'), 'fixed\n')
  q(repo, 'add', '.')
  q(repo, 'commit', '-q', '-m', 'Fix it')
  q(repo, 'branch', 'voice/hidden')
  const sha = q(repo, 'rev-parse', 'voice/fix').trim()
  q(repo, 'switch', '-q', 'main')

  mkdirSync(MARKERS, { recursive: true })
  const payload = join(TMP, 'payload.sh')
  writeFileSync(payload, `#!/bin/sh\n[ -n "$CONTAINER_SIDE" ] || touch "${MARKERS}/$LABEL"\ncat >/dev/null 2>&1\nexit 0\n`)
  chmodSync(payload, 0o755)
  const command = label => {
    const link = join(TMP, 'payloads', label)
    mkdirSync(join(TMP, 'payloads'), { recursive: true })
    if (!existsSync(link)) writeFileSync(link, `#!/bin/sh\nLABEL=${label}\nexport LABEL\nexec ${payload} "$@"\n`, { mode: 0o755 })
    return link
  }
  const hooks = join(repo, '.git', 'evil-hooks')
  mkdirSync(hooks, { recursive: true })
  for (const hook of ['pre-commit', 'post-checkout', 'reference-transaction', 'post-update', 'pre-auto-gc']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\nexec ${command(`hook-${hook}`)}\n`, { mode: 0o755 })
  }
  const set = (key, value) => q(repo, 'config', key, value)
  set('core.hooksPath', hooks)
  set('core.fsmonitor', command('fsmonitor'))
  set('uploadpack.packObjectsHook', command('packObjectsHook'))
  set('core.alternateRefsCommand', command('alternateRefsCommand'))
  set('core.pager', command('pager'))
  set('core.sshCommand', command('sshCommand'))
  set('uploadpack.hideRefs', 'refs/heads/voice/hidden')
  // The host user's own filter, as git-lfs would be configured.
  execFileSync('git', ['config', 'filter.lfstest.smudge', command('host-filter')], { cwd: join(CLEAN, name) })
  return { origin, repo, sha, clean: join(CLEAN, name) }
}

const markers = () => (existsSync(MARKERS) ? readdirSync(MARKERS).sort() : [])
const helper = (args, env = {}) =>
  spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...fakeDockerEnv(),
      LC_ALL: 'C',
      VOICE_GW_DOCKER: CONTAINER,
      VOICE_GW_DOCKER_REPOS: REPOS,
      VOICE_GW_DOCKER_BIN: join(BIN, 'docker'),
      VOICE_CLEAN_ROOT: CLEAN,
      ...env,
    },
  })

test('fetch-from-container: the branch reaches the clean clone as a bundle, nothing from the container runs here', () => {
  const { origin, sha, clean } = containerRepoAndCleanClone('fixme')
  const base = execFileSync('git', ['rev-parse', 'origin/HEAD'], { cwd: clean, encoding: 'utf8' }).trim()
  const out = helper(['fixme', 'voice/fix'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, new RegExp(`^Fetched voice/fix from the container into ${clean} as container/voice/fix:\\n[0-9a-f]+ Fix it\\n`))
  assert.match(out.stdout, new RegExp(`git -C ${clean} push origin refs/remotes/container/voice/fix:refs/heads/voice/fix`))

  const git = (...args) => execFileSync('git', args, { cwd: clean, encoding: 'utf8' }).trim()
  assert.equal(git('rev-parse', 'refs/remotes/container/voice/fix'), sha)
  assert.equal(git('branch', '--show-current'), 'main', 'nothing checked out')
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/voice'], { cwd: origin, encoding: 'utf8' }), '', 'nothing pushed')
  assert.deepEqual(markers(), [], 'no config, hook or filter ran on the host')

  // The bundle came from the container, with only what the clean clone lacks.
  const bundle = dockerCalls().findLast(call => call.includes('bundle'))
  assert.deepEqual(bundle.slice(0, 6), ['exec', CONTAINER, 'git', '-C', join(REPOS, 'fixme'), 'bundle'])
  assert.ok(bundle.includes(`^${base}`))
})

test('fetch-from-container: refuses a clean clone in the container folder, odd names and missing clones', () => {
  for (const [args, env, message] of [
    [['fixme', 'voice/fix'], { VOICE_CLEAN_ROOT: REPOS }, /is inside the container's folder/],
    [['fixme', '-x'], {}, /not a branch name: -x/],
    [['fixme', 'a..b'], {}, /not a branch name: a\.\.b/],
    [['../fixme', 'voice/fix'], {}, /not a repository name/],
    [['nope', 'voice/fix'], {}, /no clean clone at .*\/nope/],
    [['fixme'], {}, /usage/],
  ]) {
    const out = helper(args, env)
    assert.notEqual(out.status, 0, JSON.stringify(args))
    assert.match(out.stderr, message)
  }
  assert.deepEqual(markers(), [])
})

test('why a bundle: git on the host in the container folder reads its config, and git status runs its fsmonitor', () => {
  const clean = join(CLEAN, 'fixme')
  const direct = spawnSync('git', ['fetch', '-q', join(REPOS, 'fixme'), 'refs/heads/voice/hidden'], { cwd: clean, encoding: 'utf8' })
  assert.notEqual(direct.status, 0, 'a plain local fetch runs upload-pack with the container side\'s uploadpack.hideRefs')
  assert.deepEqual(markers(), [])
  spawnSync('git', ['status', '--short'], { cwd: join(REPOS, 'fixme') })
  assert.deepEqual(markers(), ['fsmonitor'], 'what a git-aware prompt or an editor would set off')
  rmSync(join(MARKERS, 'fsmonitor'))
})

// --- the kill switch in the Docker setup -------------------------------------------

test('start-workers-container.sh: the folder read-only and no restart policy while the kill switch is locked', () => {
  const secrets = join(TMP, 'start-secrets')
  mkdirSync(join(secrets, 'worker'), { recursive: true })
  const start = () =>
    spawnSync('bash', [START_CONTAINER], {
      encoding: 'utf8',
      env: { ...fakeDockerEnv(), VOICE_GW_DOCKER_BIN: join(BIN, 'docker'), VOICE_GW_DOCKER_FOLDER: REPOS, VOICE_GW_SECRETS_DIR: secrets, VOICE_GW_DOCKER_IMAGE: 'cc-voice-worker' },
    })
  const lastRun = () => dockerCalls().findLast(call => call[0] === 'run')

  assert.equal(start().status, 0)
  assert.ok(lastRun().includes(`${REPOS}:/repos:rw`))
  assert.equal(lastRun()[lastRun().indexOf('--restart') + 1], 'unless-stopped')

  writeFileSync(join(secrets, 'killswitch.json'), JSON.stringify({ trigger: 'voice', reason: 'test', at: new Date().toISOString() }))
  const locked = start()
  assert.equal(locked.status, 0)
  assert.match(locked.stderr, /the kill switch is locked; .* is mounted read-only/)
  assert.ok(lastRun().includes(`${REPOS}:/repos:ro`))
  assert.equal(lastRun()[lastRun().indexOf('--restart') + 1], 'no')
  assert.ok(lastRun().includes(`${secrets}/worker:/run/secrets/voice:ro`))
})

test('Docker: the kill switch stops the container for good, and again if it comes back with a writable /repos', async () => {
  const before = dockerCalls().length
  const out = await controller('raise_alarm', { reason: 'A worker reads files it has no business with.' })
  assert.match(out.text, /^\[killswitch=locked\]/)
  await waitUntil(() => dockerCalls().slice(before).some(call => call[0] === 'stop'))
  const calls = dockerCalls().slice(before)
  assert.ok(calls.some(call => call.join(' ') === `update --restart=no ${CONTAINER}`), 'no restart policy')
  assert.ok(calls.some(call => call.join(' ') === `stop --time 10 ${CONTAINER}`))
  assert.match((await controller('dispatch', { worker: 'open', task: 'x', words: 'x' })).text, /^\[dispatch=locked/)

  // Someone starts it again, with /repos writable: the gateway stops it.
  rmSync(DOWN)
  const stops = dockerCalls().filter(call => call[0] === 'stop').length
  await waitUntil(() => dockerCalls().filter(call => call[0] === 'stop').length > stops, 5000)
  await waitUntil(() => /runs with a writable \/repos; stopping it/.test(gw.log))

  await adminRequest(join(SECRETS, 'admin.sock'), 'POST', '/unlock', { by: 'test' })
  rmSync(DOWN, { force: true })
})
