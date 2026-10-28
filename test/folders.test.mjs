// Cloning and deleting in the worker root (src/folders.mjs), and the tools
// clone_repo and delete_path that the gateway offers the controller at the
// levels clone-delete and unrestricted. Temporary git repositories play the
// worker root; a small script plays gh.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'
import { FolderTools, parseRepo, size } from '../src/folders.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'vgw-folders-')))
const BIN = join(TMP, 'bin')
const OUTSIDE = join(TMP, 'outside')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' })

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

// A worker root: alpha, a repository with a remote, one commit that is on no
// remote, an uncommitted file and a stash; plain, a folder; a file; a link to
// a folder outside; gateway, which plays the gateway's own checkout.
function makeRoot(name) {
  const root = join(TMP, name)
  mkdirSync(root, { recursive: true })
  const remote = join(TMP, `${name}-remote.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const alpha = join(root, 'alpha')
  execFileSync('git', ['init', '-q', '-b', 'main', alpha])
  git(alpha, 'remote', 'add', 'origin', remote)
  mkdirSync(join(alpha, 'build'))
  writeFileSync(join(alpha, 'build', 'out.log'), 'log\n')
  writeFileSync(join(alpha, 'README.md'), 'alpha\n')
  git(alpha, 'add', '.')
  git(alpha, 'commit', '-q', '-m', 'first')
  git(alpha, 'push', '-q', 'origin', 'main')
  writeFileSync(join(alpha, 'NOTES.md'), 'only here\n')
  git(alpha, 'add', 'NOTES.md')
  git(alpha, 'commit', '-q', '-m', 'second, not pushed')
  writeFileSync(join(alpha, 'README.md'), 'alpha, changed\n')
  git(alpha, 'stash', '-q')
  writeFileSync(join(alpha, 'README.md'), 'alpha, changed again\n')
  mkdirSync(join(root, 'plain', 'sub'), { recursive: true })
  writeFileSync(join(root, 'plain', 'a.txt'), 'a')
  writeFileSync(join(root, 'plain', 'sub', 'b.txt'), 'bb')
  writeFileSync(join(root, 'file.txt'), 'hello')
  symlinkSync(OUTSIDE, join(root, 'away'))
  mkdirSync(join(root, 'gateway', 'src'), { recursive: true })
  return root
}

before(() => {
  mkdirSync(BIN, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  writeFileSync(join(OUTSIDE, 'keep.txt'), 'keep')
  // gh repo clone <repo> <folder>: a new repository, or a failure that leaves
  // a half folder behind.
  writeFileSync(
    join(BIN, 'gh'),
    `#!/bin/sh
[ "$1 $2" = "repo clone" ] || exit 2
case "$3" in
  *missing*) mkdir -p "$4"; echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1 ;;
  *slow*) sleep 30 ;;
esac
git init -q -b main "$4" && git -C "$4" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
`,
  )
  chmodSync(join(BIN, 'gh'), 0o755)
})

after(() => rmSync(TMP, { recursive: true, force: true }))

// --- unit ----------------------------------------------------------------------

test('parseRepo: owner/name, a plain name, GitHub URLs; nothing else', () => {
  assert.deepEqual(parseRepo('alderg/cc-voice-gateway'), { slug: 'alderg/cc-voice-gateway', name: 'cc-voice-gateway' })
  assert.deepEqual(parseRepo(' drawio-mcp '), { slug: 'drawio-mcp', name: 'drawio-mcp' })
  assert.deepEqual(parseRepo('https://github.com/jgraph/drawio.git'), { slug: 'jgraph/drawio', name: 'drawio' })
  assert.deepEqual(parseRepo('git@github.com:jgraph/drawio.git'), { slug: 'jgraph/drawio', name: 'drawio' })
  assert.deepEqual(parseRepo('github.com/jgraph/drawio/'), { slug: 'jgraph/drawio', name: 'drawio' })
  for (const bad of ['', '..', '../x', 'a/b/c', '-x', 'a/.git', 'a b', 'https://example.com/a/b', 'a/..', '/x']) {
    assert.equal(parseRepo(bad), null, bad)
  }
  assert.equal(size(500), '500 bytes')
  assert.equal(size(2048), '2.0 KB')
  assert.equal(size(40 * 1024 * 1024), '40 MB')
})

test('delete: a plan first, which says what would be lost; then the deletion', async () => {
  const root = makeRoot('plan')
  const tools = new FolderTools({ root, self: join(root, 'gateway') })

  const plan = await tools.plan('alpha')
  assert.equal(plan.status, 'plan')
  assert.equal(plan.kind, 'repository')
  assert.ok(plan.files > 5, 'the .git folder counts too')
  assert.deepEqual(plan.git, { dirty: 1, remotes: 1, unpushed: 1, stashes: 1 })

  const inside = await tools.plan('alpha/build/')
  assert.equal(inside.path, 'alpha/build')
  assert.equal(inside.kind, 'folder')
  assert.deepEqual(inside.inRepo, { repo: 'alpha', tracked: 1, dirty: 0 })

  const folder = await tools.plan('plain')
  assert.deepEqual([folder.kind, folder.files, folder.bytes, folder.git, folder.inRepo], ['folder', 2, 3, undefined, undefined])
  assert.deepEqual([(await tools.plan('file.txt')).kind, (await tools.plan('file.txt')).bytes], ['file', 5])

  // Without a plan of the same path, nothing goes.
  assert.equal(tools.remove('plain/sub').status, 'unplanned')
  assert.ok(existsSync(join(root, 'plain', 'sub')))
  assert.deepEqual(tools.remove('alpha'), { status: 'deleted', path: 'alpha' })
  assert.ok(!existsSync(join(root, 'alpha')))
  assert.equal(tools.remove('alpha').status, 'missing')
  // A plan counts once.
  assert.equal(tools.remove('plain').status, 'deleted')
  await tools.plan('file.txt')
  assert.equal(tools.remove('./file.txt').status, 'deleted')
})

test('delete: never outside the worker root, never the gateway, a link only as a link', async () => {
  const root = makeRoot('limits')
  const tools = new FolderTools({ root, self: join(root, 'gateway') })
  for (const path of ['..', '../limits-remote.git', 'plain/../../x', '.', '']) {
    assert.ok(['outside', 'invalid'].includes((await tools.plan(path)).status), path)
  }
  for (const path of ['/etc', '~/x', `${root}/plain`]) assert.equal((await tools.plan(path)).status, 'invalid', path)
  // Through a symlinked folder that leads outside.
  assert.equal((await tools.plan('away/keep.txt')).status, 'outside')
  assert.equal((await tools.plan('gateway')).status, 'self')
  assert.equal((await tools.plan('gateway/src')).status, 'self')
  assert.equal((await tools.plan('nothing/here')).status, 'missing')

  // The link itself goes, not what it points to.
  const link = await tools.plan('away')
  assert.deepEqual([link.kind, link.files], ['link', 1])
  assert.equal(tools.remove('away').status, 'deleted')
  assert.ok(existsSync(join(OUTSIDE, 'keep.txt')))

  // A root that holds the gateway cannot go as a whole either.
  const outer = new FolderTools({ root: TMP, self: join(root, 'gateway') })
  assert.equal((await outer.plan('limits')).status, 'self')
})

test('delete and clone: not while a worker runs there, not while the kill switch is locked', async () => {
  const root = makeRoot('busy')
  const workers = { running: () => [{ repo: 'plain', id: 'tq7x' }], starting: new Set(['alpha']) }
  const killswitch = { locked: false, state: null }
  const tools = new FolderTools({ root, workers, killswitch, self: join(root, 'gateway'), ghBin: join(BIN, 'gh') })
  assert.deepEqual(await tools.plan('plain/sub'), { status: 'busy', path: 'plain/sub', repo: 'plain', task: 'tq7x' })
  assert.equal((await tools.plan('alpha')).status, 'busy')
  await tools.plan('file.txt')
  killswitch.locked = true
  killswitch.state = { at: new Date().toISOString(), trigger: 'voice', reason: 'test' }
  assert.equal((await tools.plan('file.txt')).status, 'locked')
  assert.equal(tools.remove('file.txt').status, 'locked')
  assert.equal(tools.clone({ repo: 'alderg/x' }).status, 'locked')
  assert.ok(existsSync(join(root, 'file.txt')))
})

test('clone: gh repo clone in the background, the result as an event; a failure leaves nothing behind', async () => {
  const root = makeRoot('clone')
  const tools = new FolderTools({ root, self: join(root, 'gateway'), ghBin: join(BIN, 'gh') })
  const events = []
  tools.on('cloned', event => events.push(event))

  assert.deepEqual(tools.clone({ repo: 'alderg/drawio-mcp' }), { status: 'started', slug: 'alderg/drawio-mcp', name: 'drawio-mcp' })
  assert.equal(tools.clone({ repo: 'alderg/drawio-mcp' }).status, 'exists', 'while it runs')
  await waitUntil(() => events.length === 1)
  assert.deepEqual(events[0], { slug: 'alderg/drawio-mcp', name: 'drawio-mcp', ok: true, branch: 'main', error: null })
  assert.ok(existsSync(join(root, 'drawio-mcp', '.git')))
  assert.equal(tools.clone({ repo: 'alderg/drawio-mcp' }).status, 'exists')
  assert.equal(tools.clone({ repo: 'plain' }).status, 'exists')
  assert.equal(tools.clone({ repo: 'other/drawio', folder: 'drawio-2' }).name, 'drawio-2')
  await waitUntil(() => events.length === 2)

  assert.equal(tools.clone({ repo: 'alderg/missing' }).status, 'started')
  await waitUntil(() => events.length === 3)
  assert.equal(events[2].ok, false)
  assert.match(events[2].error, /Could not resolve to a Repository/)
  assert.ok(!existsSync(join(root, 'missing')), 'the half folder is gone')

  for (const [repo, folder] of [['../x', undefined], ['a/b/c', undefined], ['alderg/x', '../x'], ['alderg/x', 'a/b']]) {
    assert.equal(tools.clone({ repo, folder }).status, 'invalid', `${repo} ${folder}`)
  }

  // The kill switch ends a clone that is still going.
  assert.equal(tools.clone({ repo: 'alderg/slow' }).status, 'started')
  await sleep(200)
  tools.stopAll()
  await waitUntil(() => events.length === 4)
  assert.equal(events[3].ok, false)
  assert.ok(!existsSync(join(root, 'slow')))
})

// --- through the gateway ---------------------------------------------------------

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startGateway(name, level) {
  const secrets = join(TMP, `${name}-secrets`)
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  const root = makeRoot(`${name}-repos`)
  const port = await freePort()
  const g = { events: [], root }
  g.claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  g.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => g.events.push(params),
  )
  await g.claudeCode.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [GATEWAY],
      env: {
        ...process.env,
        VOICE_GW_PORT: String(port),
        VOICE_GW_SECRETS_DIR: secrets,
        VOICE_GW_STATE_DIR: join(TMP, `${name}-state`),
        VOICE_GW_WORKER_ROOT: root,
        VOICE_GW_GH_BIN: join(BIN, 'gh'),
        VOICE_GW_CLAUDE_BIN: join(BIN, 'no-claude'),
        VOICE_GW_CONTROLLER_LEVEL: level,
        VOICE_GW_LOG_FILE: '',
        VOICE_GW_MAX_WAIT: '1',
        VOICE_GW_DEFAULT_WAIT: '1',
      },
      stderr: 'pipe',
    }),
  )
  for (let i = 0; i < 100; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok) break
    await sleep(50)
  }
  const { access_token } = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/token', { name })
  g.voice = new Client({ name: 'fake-voice', version: '0.0.0' })
  await g.voice.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    }),
  )
  g.call = async (tool, args = {}) => (await g.voice.callTool({ name: tool, arguments: args })).content[0].text
  g.controller = async (tool, args = {}) => (await g.claudeCode.callTool({ name: tool, arguments: args })).content[0].text
  g.tools = async () => (await g.claudeCode.listTools()).tools.map(tool => tool.name)
  g.close = async () => {
    await g.voice.close()
    await g.claudeCode.close()
  }
  return g
}

test('the gateway offers clone_repo and delete_path only above the level confined', async () => {
  const confined = await startGateway('confined', '')
  try {
    const tools = await confined.tools()
    assert.ok(tools.includes('dispatch'))
    assert.ok(!tools.includes('clone_repo') && !tools.includes('delete_path'))
    assert.doesNotMatch(confined.claudeCode.getInstructions(), /clone_repo|unrestricted/)
  } finally {
    await confined.close()
  }
  const open = await startGateway('open', 'unrestricted')
  try {
    assert.ok((await open.tools()).includes('delete_path'))
    assert.match(open.claudeCode.getInstructions(), /Cloning and deleting: the driver turned on clone_repo/)
    assert.match(open.claudeCode.getInstructions(), /Level unrestricted: the driver turned the confinement off/)
  } finally {
    await open.close()
  }
})

test('clone_repo and delete_path by voice: only on the driver\'s words, a deletion only after its plan', async () => {
  const g = await startGateway('voice', 'clone-delete')
  try {
    assert.doesNotMatch(g.claudeCode.getInstructions(), /Level unrestricted/)
    // Text from a worker result does not count.
    assert.match(await g.controller('clone_repo', { repo: 'alderg/drawio-mcp', words: 'clone drawio mcp' }), /^\[clone=needs_driver\]/)
    await g.call('send', { message: 'Please clone drawio mcp from alderg.' })
    assert.match(
      await g.controller('clone_repo', { repo: 'alderg/drawio-mcp', words: 'clone drawio mcp' }),
      /^\[clone=started repo=alderg\/drawio-mcp folder=drawio-mcp\]/,
    )
    const cloned = await waitUntil(() => g.events.find(e => e.meta?.kind === 'clone'))
    assert.deepEqual(cloned.meta, {
      request_id: cloned.meta.request_id,
      kind: 'clone',
      repo: 'alderg/drawio-mcp',
      folder: 'drawio-mcp',
      outcome: 'done',
      trusted: 'no',
    })
    assert.match(cloned.content, /^The clone of alderg\/drawio-mcp is done: folder drawio-mcp .* on branch main/)
    assert.match(await g.controller('list_workers'), /drawio-mcp/)

    // The plan, without words; the deletion only with them.
    const plan = await g.controller('delete_path', { path: 'alpha' })
    assert.match(plan, /^\[delete=plan path=alpha\] It would delete the git repository folder alpha: \d+ files, /)
    assert.match(plan, /Lost for good: 1 files with uncommitted changes, 1 commits on no remote, 1 stashes\./)
    assert.match(await g.controller('delete_path', { path: 'alpha', confirm: true, words: 'delete alpha' }), /needs_driver/)
    assert.ok(existsSync(join(g.root, 'alpha')))
    await g.call('send', { message: 'Delete the folder alpha, I do not need it any more.' })
    assert.match(
      await g.controller('delete_path', { path: 'alpha', confirm: true, words: 'Delete the folder alpha' }),
      /^\[delete=done path=alpha\] Deleted\./,
    )
    assert.ok(!existsSync(join(g.root, 'alpha')))
    // Without a fresh plan, nothing.
    assert.match(
      await g.controller('delete_path', { path: 'plain', confirm: true, words: 'Delete the folder alpha' }),
      /^\[delete=unplanned path=plain\]/,
    )
    assert.match(await g.controller('delete_path', { path: 'gateway/../..' }), /^\[delete=refused/)
  } finally {
    await g.close()
  }
})
