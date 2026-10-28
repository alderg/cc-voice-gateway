// The channel as a plugin, and restarting the controller by voice.
//
// The plugin side: which way the start script loads the channel
// (scripts/channel-mode.mjs), and the plugin's entry point (src/plugin.mjs).
// The restart side: voice requests survive a restart of the gateway, the
// restart_controller tool plans first and restarts only under the watchdog,
// and the next gateway says on Telegram that it is ready. A small wrapper
// stands in for Claude Code, so that the gateway's SIGTERM reaches it and not
// this test; a local server stands in for the Telegram Bot API.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'
import { RESTART_NOTE } from '../src/store.mjs'
import { channelMode } from '../scripts/channel-mode.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const GATEWAY = join(ROOT, 'src', 'gateway.mjs')
const PLUGIN = join(ROOT, 'src', 'plugin.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-restart-'))
const BIN = join(TMP, 'bin')
const TOKEN = '123456789:TEST-token-never-in-a-log'

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

async function freePort() {
  const server = createNetServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

// --- stand-ins -------------------------------------------------------------------

const WRAPPER = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.VOICE_GW_WATCHDOG_LOCK + '/claude.pid', String(process.pid))
process.on('SIGTERM', () => { writeFileSync(process.env.WRAPPER_TERM, 'yes'); process.exit(143) })
spawn(process.execPath, [process.env.GATEWAY], { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 0))
`

const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id }) + '\\n')
setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id }) + '\\n'),
  /SLOW/.test(input) ? 20000 : 100)
`

const telegram = { server: null, url: '', sent: [] }

before(async () => {
  mkdirSync(BIN, { recursive: true })
  for (const [name, script] of [['wrapper', WRAPPER], ['claude', FAKE_CLAUDE]]) {
    writeFileSync(join(BIN, name), script)
    chmodSync(join(BIN, name), 0o755)
  }
  telegram.server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const ok = req.url === `/bot${TOKEN}/sendMessage`
      if (ok) telegram.sent.push(JSON.parse(body))
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { ok: true, result: {} } : { ok: false }))
    })
  })
  await new Promise(resolve => telegram.server.listen(0, '127.0.0.1', resolve))
  telegram.url = `http://127.0.0.1:${telegram.server.address().port}`
})

after(() => {
  telegram.server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

// --- which way the channel loads ------------------------------------------------------

test('channel mode: the plugin only when the allowlist names it and this repository is its marketplace', () => {
  const dir = join(TMP, 'modes')
  const config = join(dir, 'config')
  const endpoint = join(dir, 'managed-settings.json')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  const env = (extra = {}) => ({ CLAUDE_CONFIG_DIR: config, VOICE_GW_MANAGED_SETTINGS: endpoint, ...extra })
  const allow = { channelsEnabled: true, allowedChannelPlugins: [{ marketplace: 'cc-voice-gateway', plugin: 'voice' }] }
  const known = path =>
    writeFileSync(join(config, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'cc-voice-gateway': { source: { source: 'directory', path } } }))
  const mode = extra => channelMode({ env: env(extra), root: ROOT }).mode

  assert.equal(mode(), 'development')
  assert.match(channelMode({ env: env(), root: ROOT }).reason, /not on the organisation's channel allowlist/)

  writeFileSync(join(config, 'remote-settings.json'), JSON.stringify(allow))
  assert.equal(mode(), 'plugin-register', 'allowlisted, not yet registered here')
  known(ROOT)
  assert.equal(mode(), 'plugin')
  known('/somewhere/else')
  assert.equal(mode(), 'development')
  known(ROOT)

  // Server-managed settings with any key come first; then the file on this computer.
  writeFileSync(join(config, 'remote-settings.json'), JSON.stringify({ channelsEnabled: true }))
  writeFileSync(endpoint, JSON.stringify(allow))
  assert.equal(mode(), 'development')
  rmSync(join(config, 'remote-settings.json'))
  assert.equal(mode(), 'plugin')

  assert.equal(mode({ VOICE_GW_CHANNEL: 'development' }), 'development')
  rmSync(endpoint)
  assert.equal(mode({ VOICE_GW_CHANNEL: 'plugin' }), 'plugin', 'forced, as long as the marketplace is registered')
})

test('the plugin: settings from controller/.mcp.json, the channel named plugin:voice:voice', async () => {
  const port = await freePort()
  const mcpJson = join(TMP, 'plugin-mcp.json')
  writeFileSync(
    mcpJson,
    JSON.stringify({ mcpServers: { voice: { command: 'node', args: [], env: { VOICE_GW_PORT: '${TEST_GW_PORT}', VOICE_GW_LOG_FILE: '' } } } }),
  )
  const client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [PLUGIN],
      env: {
        ...process.env,
        VOICE_GW_MCP_JSON: mcpJson,
        TEST_GW_PORT: String(port),
        VOICE_GW_SECRETS_DIR: join(TMP, 'plugin-secrets'),
        VOICE_GW_STATE_DIR: join(TMP, 'plugin-state'),
        VOICE_GW_WORKER_ROOT: join(TMP, 'no-repositories'),
      },
      stderr: 'ignore',
    }),
  )
  try {
    assert.match(client.getInstructions(), /arrive as <channel source="plugin:voice:voice" request_id/)
    assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'], {})
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok)
  } finally {
    await client.close()
  }
})

// --- a gateway, with or without a watchdog ------------------------------------------

async function startGateway(name, { wrapper = false, env = {} } = {}) {
  const state = join(TMP, `${name}-state`)
  const secrets = join(TMP, `${name}-secrets`)
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  const port = await freePort()
  const g = { events: [], log: '', state, secrets }
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
    args: [wrapper ? join(BIN, 'wrapper') : GATEWAY],
    env: {
      ...process.env,
      GATEWAY,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: secrets,
      VOICE_GW_STATE_DIR: state,
      VOICE_GW_WORKER_ROOT: join(TMP, `${name}-repos`),
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'no-gh'),
      VOICE_GW_MAX_WAIT: '2',
      VOICE_GW_DEFAULT_WAIT: '1',
      VOICE_GW_LOG_FILE: '',
      VOICE_GW_TELEGRAM_API: telegram.url,
      ...env,
    },
    stderr: 'pipe',
  })
  stdio.stderr.on('data', chunk => (g.log += chunk))
  await g.claudeCode.connect(stdio)
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      await sleep(50)
    }
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
  g.close = async () => {
    await g.voice.close()
    await g.claudeCode.close()
  }
  return g
}

const idOf = out => /id=([a-z0-9]+)/.exec(out)?.[1]

test('voice requests survive a restart of the gateway; an unfinished one ends with a note', async () => {
  const first = await startGateway('survive')
  const answered = idOf(await first.call('send', { message: 'How many files are there?' }))
  await first.controller('reply', { request_id: answered, state: 'done', text: 'There are three files.' })
  const unfinished = idOf(await first.call('send', { message: 'Run the long task.' }))
  await first.controller('reply', { request_id: unfinished, state: 'working', text: 'On it.' })
  assert.match(await first.call('get_reply', { id: unfinished }), /Claude Code: On it\./)
  await sleep(300)
  await first.close()
  await sleep(300)

  // A worker result the old controller never answered.
  const file = join(first.state, 'requests.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.requests.push({
    id: 'wkr2',
    text: 'Worker alpha finished task t123: done after 2 minutes.',
    origin: 'worker',
    state: 'sent',
    createdAt: Date.now(),
    updates: [],
    cursor: 0,
    closed: false,
    meta: { worker: 'alpha', task: 't123', outcome: 'done' },
  })
  writeFileSync(file, JSON.stringify(saved))

  const second = await startGateway('survive')
  try {
    assert.match(await second.call('get_reply', { id: answered }), /^\[state=done .*\nClaude Code: There are three files\./)
    const note = await second.call('get_reply', { id: unfinished })
    assert.match(note, /^\[state=done /)
    assert.ok(note.includes(RESTART_NOTE))
    assert.doesNotMatch(note, /On it\./, 'what the voice client heard before is not repeated')
    const resent = await waitUntil(() => second.events.find(e => e.meta?.resent === 'yes'))
    assert.deepEqual(
      { worker: resent.meta.worker, task: resent.meta.task, request_id: resent.meta.request_id },
      { worker: 'alpha', task: 't123', request_id: 'wkr2' },
    )
  } finally {
    await second.close()
  }
})

test('restart_controller: without the watchdog it cannot restart, and says so', async () => {
  const g = await startGateway('no-watchdog')
  try {
    assert.match(await g.controller('restart_controller'), /^\[restart=unavailable\] This session cannot restart itself: it was not started with scripts\/start-controller\.sh/)
    assert.match(await g.controller('restart_controller', { confirm: true }), /^\[restart=unavailable\]/)
  } finally {
    await g.close()
  }
})

test('restart_controller: first what would happen, running workers included; the restart only with confirm', async () => {
  const lock = join(TMP, 'watchdog.lock')
  mkdirSync(lock, { recursive: true })
  const repo = join(TMP, 'planned-repos', 'alpha')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '# alpha\n')
  git('add', '.')
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')

  const g = await startGateway('planned', {
    wrapper: true,
    env: {
      VOICE_GW_WATCHDOG_LOCK: lock,
      VOICE_GW_CHANNEL_MODE: 'plugin',
      VOICE_GW_WORKER_ROOT: join(TMP, 'planned-repos'),
      WRAPPER_TERM: join(TMP, 'wrapper-term'),
    },
  })
  try {
    const started = await g.controller('dispatch', { worker: 'alpha', task: 'SLOW: a long task.', words: 'x' })
    const task = /task=(t[a-z0-9]{3})/.exec(started)[1]
    await g.call('send', { message: 'Restart the controller.' })

    const plan = await g.controller('restart_controller')
    assert.match(plan, /^\[restart=plan watchdog=yes channel=plugin workers=1 requests=1\]/)
    assert.match(plan, new RegExp(`Worker runs going: alpha \\(task ${task}, running for less than a minute: "SLOW: a long task\\."\\)\\. They keep running outside this session and report their results to the restarted controller`))
    assert.match(plan, /Open voice requests: 1\. Answers already given stay deliverable; a request not finished yet ends with a note/)
    assert.match(plan, /loads as the allowlisted plugin, so the session is back within about half a minute, without a confirmation/)
    assert.match(plan, /Only after a yes: reply "done" to the driver first, then call restart_controller with confirm=true\./)
    assert.equal(existsSync(join(lock, 'restart')), false, 'a plan restarts nothing')

    assert.match(await g.controller('restart_controller', { confirm: true }), /^\[restart=requested\] The session ends in about 2 seconds/)
    assert.equal(JSON.parse(readFileSync(join(lock, 'restart'), 'utf8')).by, 'voice')
    assert.ok(existsSync(join(g.state, 'requests.json')), 'the requests are saved for the next gateway')
    await waitUntil(() => existsSync(join(TMP, 'wrapper-term')), 6000)
    assert.match(g.log, /restart of the controller session requested by voice; ending session \d+/)
  } finally {
    // The session is gone, and with it this connection; the worker run is not.
    const run = JSON.parse(readFileSync(join(TMP, 'planned-state', 'workers.json'), 'utf8')).tasks.find(t => t.state === 'running')
    try {
      process.kill(-run.pid, 'SIGTERM')
    } catch {
      // already gone
    }
    await g.voice.close().catch(() => {})
    await g.claudeCode.close().catch(() => {})
  }
})

test('after a restart by the watchdog, the driver hears on Telegram that the controller is ready again', async () => {
  const lock = join(TMP, 'ready.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'restarted'), 'a restart requested by voice\n')
  const secrets = join(TMP, 'ready-secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  writeFileSync(join(secrets, 'telegram_token'), `${TOKEN}\n`)
  writeFileSync(join(secrets, 'telegram_chat_id'), '4242\n')
  const before = telegram.sent.length
  const g = await startGateway('ready', { env: { VOICE_GW_WATCHDOG_LOCK: lock } })
  try {
    const message = await waitUntil(() => telegram.sent.slice(before).find(m => /ready again/.test(m.text)))
    assert.equal(message.chat_id, '4242')
    assert.match(message.text, /^cc-voice-gateway on .*: the controller is ready again, after a restart requested by voice\.$/)
    assert.equal(existsSync(join(lock, 'restarted')), false, 'said once')
    assert.ok(!g.log.includes(TOKEN))
  } finally {
    await g.close()
  }
})
