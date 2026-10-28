// The kill switch: every trigger (voice, Telegram, the rules on worker runs,
// the controller's alarm), its effects, that it survives a restart, and that
// only the local script unlocks it.
//
// Stand-ins: a fake claude for worker runs, a fake gh for GitHub, and a local
// HTTP server for the Telegram Bot API; nothing reaches the network. The
// Docker side (container stopped, read-only mounts) is in docker.test.mjs.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { adminRequest } from '../src/admin.mjs'
import { KillSwitch, emergencyPhrase } from '../src/killswitch.mjs'
import { RunGuard } from '../src/guard.mjs'
import { Telegram, TelegramCommands, isStopCommand } from '../src/telegram.mjs'

const GATEWAY = fileURLToPath(new URL('../src/gateway.mjs', import.meta.url))
const UNLOCK = fileURLToPath(new URL('../scripts/unlock.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-kill-'))
const BIN = join(TMP, 'bin')
const ROOT = join(TMP, 'Developer')
const SECRETS = join(TMP, 'secrets')
const LOCK = join(SECRETS, 'killswitch.json')
const TOKEN = '123456789:TEST-token-never-in-a-log'
const CHAT = '4242'
const GH_STATE = join(TMP, 'github.json')

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

// --- stand-ins ----------------------------------------------------------------------

const FAKE_GH = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const out = value => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(0) }
if (args[0] === 'repo' && args[1] === 'view') { process.stdout.write('PRIVATE\\n'); process.exit(0) }
if (args[0] === 'api') {
  const branch = /^repos\\/([^/]+\\/[^/]+)\\/branches\\/(.+)$/.exec(args[1])
  if (branch && state.heads?.[branch[1]]) out({ name: branch[2], commit: { sha: state.heads[branch[1]] } })
  const repo = /^repos\\/([^/]+\\/[^/]+)$/.exec(args[1])
  if (repo) out({ default_branch: 'main' })
}
process.stderr.write('not found\\n')
process.exit(1)
`

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, input: input.split('\\n')[0] }) + '\\n')
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const session_id = arg('--session-id') ?? arg('--resume')
const out = message => process.stdout.write(JSON.stringify({ ...message, session_id }) + '\\n')
const bash = command => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
out({ type: 'system', subtype: 'init' })
if (/PUSHMAIN/.test(input)) bash('git add -A && git commit -qm fix && git push origin main')
setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }), /SLOW/.test(input) ? 15000 : 300)
`

const telegram = { server: null, url: '', sent: [], updates: [], nextId: 1 }

function telegramUpdate(chatId, text, { type = 'private', age = 0 } = {}) {
  telegram.updates.push({
    update_id: telegram.nextId++,
    message: { message_id: 1, date: Math.floor(Date.now() / 1000) - age, chat: { id: Number(chatId), type }, from: { id: Number(chatId) }, text },
  })
}

before(async () => {
  mkdirSync(BIN, { recursive: true })
  for (const [name, script] of [['gh', FAKE_GH], ['claude', FAKE_CLAUDE]]) {
    writeFileSync(join(BIN, name), script)
    chmodSync(join(BIN, name), 0o755)
  }
  writeFileSync(GH_STATE, JSON.stringify({ heads: {} }))
  process.env.FAKE_GH_STATE = GH_STATE
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
        for (let i = 0; i < 10 && !telegram.updates.some(u => u.update_id >= (json.offset ?? 0)); i++) await sleep(50)
        return reply(telegram.updates.filter(u => u.update_id >= (json.offset ?? 0)))
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

// --- the emergency phrase ---------------------------------------------------------

test('the emergency phrase: Notstopp and its variants; a mere mention or "do not stop" is none', () => {
  for (const phrase of [
    'Notstopp',
    'Notstopp!',
    'Not-Stopp',
    'NOTSTOPP sofort',
    'Notstopp, alles anhalten bitte',
    'Notfallstopp',
    'Nothalt',
    'Not-Aus',
    'Emergency stop',
    'emergency-stop now',
    'Kill switch!',
    'Killswitch',
    'Bitte Notstopp',
  ]) {
    assert.equal(emergencyPhrase(phrase), true, phrase)
  }
  for (const phrase of [
    'do not stop the build',
    "Please don't stop the worker",
    'What does the Notstopp in this project do exactly?',
    'stop the worker',
    'the build is not halting',
    '',
  ]) {
    assert.equal(emergencyPhrase(phrase), false, phrase)
  }
  assert.equal(isStopCommand('/stop'), true)
  assert.equal(isStopCommand('/notstopp@my_bot'), true)
  assert.equal(isStopCommand('stop the music'), false)
})

// --- the state ------------------------------------------------------------------------

test('the state: locked, saved for this user only, survives a new instance, fails closed, unlocks', () => {
  const file = join(TMP, 'unit', 'killswitch.json')
  const logged = []
  const first = new KillSwitch({ file, log: line => logged.push(line) })
  assert.equal(first.locked, false)
  const events = []
  first.on('tripped', (state, event, isFirst) => events.push([event.trigger, isFirst]))
  first.trip({ trigger: 'voice', reason: 'Notstopp' })
  first.trip({ trigger: 'rule', reason: 'push to the default branch' })
  assert.deepEqual(events, [['voice', true], ['rule', false]])
  assert.equal(statSync(file).mode & 0o777, 0o600)

  const again = new KillSwitch({ file, log: () => {} })
  assert.equal(again.locked, true)
  assert.equal(again.state.trigger, 'voice', 'the first trigger stays the reason')
  assert.deepEqual(again.state.events.map(e => e.trigger), ['voice', 'rule'])

  assert.equal(again.unlock({ by: 'test' }).trigger, 'voice')
  assert.equal(existsSync(file), false)
  assert.equal(new KillSwitch({ file, log: () => {} }).locked, false)

  writeFileSync(file, '{ not json')
  const damaged = new KillSwitch({ file, log: () => {} })
  assert.equal(damaged.locked, true, 'an unreadable file means locked')
  assert.match(damaged.state.reason, /unreadable/)
})

// --- the rules ---------------------------------------------------------------------------

function guarded({ git = {}, limits, direct = false } = {}) {
  const workers = new EventEmitter()
  const tripped = []
  const runner = {
    dir: name => `/work/${name}`,
    git: async (dir, ...args) => {
      const key = args.join(' ')
      const found = Object.keys(git).find(prefix => key.startsWith(prefix))
      return found ? git[found] : null
    },
  }
  const guard = new RunGuard({
    workers,
    runner,
    killswitch: { trip: event => tripped.push(event) },
    ghBin: join(BIN, 'gh'),
    limits,
    mainCheckSeconds: 3600,
    log: () => {},
  })
  const task = {
    id: 'tabc',
    repo: 'alpha',
    dir: '/work/alpha',
    slug: 'acme/alpha',
    defaultBranch: 'main',
    direct,
    access: direct ? 'full' : null,
    startedAt: Date.now() - 1000,
  }
  workers.emit('started', task)
  const tool = (name, input) => workers.emit('tool', task, { type: 'tool_use', name, input })
  return { guard, tripped, task, tool, bash: command => tool('Bash', { command }) }
}

test('rule: writes outside the repository and the temporary folders', () => {
  const inside = guarded()
  inside.tool('Write', { file_path: '/work/alpha/src/a.js', content: 'x' })
  inside.tool('Edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' })
  inside.tool('Write', { file_path: '/tmp/scratch.txt', content: 'x' })
  inside.bash('npm test 2> /dev/null && mkdir -p build/out && cp a.txt build/out/ && cat /etc/hosts')
  inside.bash('rm "$UNKNOWN"/x') // a variable hides the target: not seen
  assert.deepEqual(inside.tripped, [], 'nothing outside')
  inside.guard.close()

  // Each case in a run of its own: a rule trips once per run.
  for (const [kind, value, path] of [
    ['Write', '/etc/cron.d/x', '/etc/cron.d/x'],
    ['Bash', 'echo evil >> ~/.bashrc', `${homedir()}/.bashrc`],
    ['Bash', 'cd / && rm -rf etc', '/etc'],
    ['Bash', 'cp tool /usr/local/bin/tool', '/usr/local/bin/tool'],
    ['Bash', 'sed -i s/a/b/ ../other/config', '/work/other/config'],
    ['Bash', 'echo x | tee $HOME/.ssh/authorized_keys', `${homedir()}/.ssh/authorized_keys`],
  ]) {
    const run = guarded()
    if (kind === 'Write') run.tool('Write', { file_path: value, content: 'x' })
    else run.bash(value)
    assert.equal(run.tripped.length, 1, value)
    assert.equal(run.tripped[0].trigger, 'rule')
    assert.match(run.tripped[0].reason, /^write outside the allowed folders: /, value)
    assert.ok(run.tripped[0].reason.includes(path), `${value}: ${run.tripped[0].reason}`)
    assert.match(run.tripped[0].reason, /\(worker alpha, task tabc\)$/)
    run.guard.close()
  }
})

test('rule: a push to the default branch or a merge, unless it was an explicit direct dispatch', () => {
  for (const command of [
    'git push origin main',
    'git push origin HEAD:refs/heads/main',
    'git push --force origin +voice/x:main',
    'git -C . push --all origin',
    'gh pr merge 12 --squash',
  ]) {
    const { tripped, bash, guard } = guarded()
    bash(command)
    assert.equal(tripped.length, 1, command)
    assert.match(tripped[0].reason, /^push to the default branch: /, command)
    guard.close()
  }
  for (const command of ['git push -u origin voice/fix', 'git push origin HEAD:voice/fix', 'git pull origin main']) {
    const { tripped, bash, guard } = guarded()
    bash(command)
    assert.deepEqual(tripped, [], command)
    guard.close()
  }
  const direct = guarded({ direct: true })
  direct.bash('git push origin main')
  assert.deepEqual(direct.tripped, [], 'a direct dispatch at level full may push to main')
  direct.guard.close()
})

test('rule: the default branch moved on GitHub during the run, and the worker has the new head', async () => {
  writeFileSync(GH_STATE, JSON.stringify({ heads: { 'acme/alpha': 'aaaaaaa1111' } }))
  const own = guarded({ git: { 'cat-file -e bbbbbbb2222': '' } })
  const other = guarded({ git: {} })
  await own.guard.runs.get('tabc').ready
  await other.guard.runs.get('tabc').ready
  writeFileSync(GH_STATE, JSON.stringify({ heads: { 'acme/alpha': 'bbbbbbb2222' } }))
  await own.guard.ended(own.task)
  await other.guard.ended(other.task)
  assert.equal(own.tripped.length, 1)
  assert.match(own.tripped[0].reason, /^push to the default branch: main on GitHub moved from aaaaaaa to bbbbbbb during the run, and the worker's repository holds the new head/)
  assert.deepEqual(other.tripped, [], 'someone else pushed: the worker does not have that commit')
  own.guard.close()
  other.guard.close()
})

test('rule: unusually many changes, in edits during the run and in git at its end', async () => {
  const edits = guarded({ limits: { maxEdits: 3 } })
  for (let i = 0; i < 4; i++) edits.tool('Edit', { file_path: `f${i}.js`, old_string: 'a', new_string: 'b' })
  assert.equal(edits.tripped.length, 1)
  assert.match(edits.tripped[0].reason, /^many changes: more than 3 file edits in one run/)
  edits.guard.close()

  const numstat = Array.from({ length: 12 }, (_, i) => `100\t50\tsrc/f${i}.js`).join('\n')
  const big = guarded({ limits: { maxFiles: 10, maxLines: 100000 }, git: { 'log --all': numstat, 'diff --numstat': '3\t1\tREADME.md', 'ls-files': 'new.txt' } })
  await big.guard.ended(big.task)
  assert.equal(big.tripped.length, 1)
  assert.match(big.tripped[0].reason, /^many changes: 14 files and 1804 lines changed in one run \(limits 10 files, 100000 lines\)/)
  big.guard.close()

  const small = guarded({ limits: { maxFiles: 10, maxLines: 100000 }, git: { 'log --all': '1\t1\tREADME.md' } })
  await small.guard.ended(small.task)
  assert.deepEqual(small.tripped, [])
  small.guard.close()
})

// --- Telegram commands -------------------------------------------------------------------

test('Telegram: /stop only from the configured private chat, and only if recent', async () => {
  // A chat of its own: the gateway below polls the same stand-in, for chat CHAT.
  const mine = '7777'
  const logged = []
  const commands = new TelegramCommands(new Telegram({ token: TOKEN, chatId: mine, apiBase: telegram.url }), {
    pollSeconds: 1,
    log: line => logged.push(line),
  }).start()
  const stops = []
  commands.on('stop', stop => stops.push(stop.text))
  try {
    telegramUpdate('999', '/stop')
    telegramUpdate(mine, '/stop', { type: 'group' })
    telegramUpdate(mine, '/stop', { age: 600 })
    telegramUpdate(mine, 'hello')
    await sleep(600)
    assert.deepEqual(stops, [])
    telegramUpdate(mine, 'Notstopp')
    await waitUntil(() => stops.length === 1)
    assert.deepEqual(stops, ['Notstopp'])
    assert.ok(logged.some(line => /ignored a message from another chat/.test(line)))
    assert.ok(!logged.join('\n').includes(TOKEN))
  } finally {
    commands.close()
  }
})

// --- the gateway ---------------------------------------------------------------------------

async function freePort() {
  const server = createNetServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function repo(name) {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  git('add', '.')
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', `git@github.com:acme/${name}.git`)
}

let gw

async function startGateway() {
  const port = await freePort()
  const g = { events: [], verdicts: [], log: '' }
  g.claudeCode = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  g.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    }),
    ({ params }) => g.events.push(params),
  )
  g.claudeCode.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission'),
      params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
    }),
    ({ params }) => g.verdicts.push(params),
  )
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...process.env,
      VOICE_GW_PORT: String(port),
      VOICE_GW_SECRETS_DIR: SECRETS,
      VOICE_GW_STATE_DIR: join(TMP, 'state'),
      VOICE_GW_WORKER_ROOT: ROOT,
      VOICE_GW_CLAUDE_BIN: join(BIN, 'claude'),
      VOICE_GW_GH_BIN: join(BIN, 'gh'),
      VOICE_GW_TELEGRAM_API: telegram.url,
      VOICE_GW_TELEGRAM_POLL: '1',
      VOICE_GW_MAX_WAIT: '2',
      VOICE_GW_DEFAULT_WAIT: '1',
      VOICE_GW_LOG_FILE: '',
      FAKE_CLAUDE_LOG: join(TMP, 'claude-calls.jsonl'),
      FAKE_GH_STATE: GH_STATE,
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
  g.voice = {}
  for (const name of ['car', 'phone']) {
    const { access_token } = await adminRequest(join(SECRETS, 'admin.sock'), 'POST', '/token', { name })
    const client = new Client({ name, version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${access_token}` } },
      }),
    )
    g.voice[name] = async (tool, args = {}) => (await client.callTool({ name: tool, arguments: args })).content[0].text
    g.voice[`${name}Client`] = client
  }
  g.controller = async (name, args = {}) => {
    const result = await g.claudeCode.callTool({ name, arguments: args })
    return { text: result.content.map(c => c.text).join('\n'), isError: result.isError }
  }
  g.close = async () => {
    await g.voice.carClient.close()
    await g.voice.phoneClient.close()
    await g.claudeCode.close()
  }
  return g
}

const killswitchState = async () => adminRequest(join(SECRETS, 'admin.sock'), 'GET', '/killswitch')
const unlockByAdmin = () => adminRequest(join(SECRETS, 'admin.sock'), 'POST', '/unlock', { by: 'test' })

before(async () => {
  repo('alpha')
  repo('beta')
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 })
  writeFileSync(join(SECRETS, 'telegram_token'), `${TOKEN}\n`)
  writeFileSync(join(SECRETS, 'telegram_chat_id'), `${CHAT}\n`)
  gw = await startGateway()
})

after(async () => {
  await gw?.close()
})

test('voice: "Notstopp" locks before anything reaches the controller; every voice chat hears the alarm once', async () => {
  // An approval that is open when the switch trips gets denied.
  await gw.claudeCode.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'abcde', tool_name: 'Write', description: 'Create a file', input_preview: '{}' },
  })
  await sleep(100)
  const sentBefore = telegram.sent.length

  const out = await gw.voice.car('send', { message: 'Notstopp!' })
  assert.match(out, /^\[state=locked\] Emergency stop\. Kill switch locked since .* UTC, by voice: "Notstopp!" by voice\. The gateway takes no new tasks/)
  assert.ok(!gw.events.some(e => e.content.includes('Notstopp!') && e.meta?.kind !== 'killswitch'), 'the phrase never reached the controller as a request')
  const alarm = await waitUntil(() => gw.events.find(e => e.meta?.kind === 'killswitch'))
  assert.equal(alarm.meta.trigger, 'voice')
  await waitUntil(() => gw.verdicts.find(v => v.request_id === 'abcde'))
  assert.equal(gw.verdicts.find(v => v.request_id === 'abcde').behavior, 'deny')

  await waitUntil(() => telegram.sent.length > sentBefore)
  const message = telegram.sent.at(-1)
  assert.equal(message.chat_id, CHAT)
  assert.match(message.text, /KILL SWITCH at .* UTC, by voice: "Notstopp!" by voice\. No new tasks, workers stopped/)
  assert.equal(statSync(LOCK).mode & 0o777, 0o600)

  assert.match(await gw.voice.car('status'), /^\[gateway=ok .* locked=yes\]\n(?!\[ALARM\])/, 'the car heard it already')
  const phone = await gw.voice.phone('status')
  assert.match(phone, /^\[gateway=ok .* locked=yes\]\n\[ALARM\] Kill switch locked since .*, by voice: .* Read this to the user first\./)
  assert.doesNotMatch(await gw.voice.phone('status'), /\[ALARM\]/, 'once per voice chat')

  const dispatch = await gw.controller('dispatch', { worker: 'alpha', task: 'Fix it.', words: 'Fix it.' })
  assert.equal(dispatch.isError, true)
  assert.match(dispatch.text, /^\[dispatch=locked worker=alpha\] Kill switch locked since .*, by voice/)
  assert.match(await gw.voice.car('send', { message: 'Fix the typo.' }), /^\[state=locked\] .* Nothing was handed over\./)
  assert.ok(!gw.events.some(e => e.content === 'Fix the typo.'))
  assert.match(await gw.voice.car('approve', { code: 'fghjk', decision: 'allow' }), /^\[approval=locked code=fghjk\]/)

  // A new approval while locked is denied at once.
  await gw.claudeCode.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'mnpqr', tool_name: 'Bash', description: 'Run something', input_preview: '{}' },
  })
  await waitUntil(() => gw.verdicts.find(v => v.request_id === 'mnpqr'))
  assert.equal(gw.verdicts.find(v => v.request_id === 'mnpqr').behavior, 'deny')
  assert.ok(!gw.log.includes(TOKEN), 'the Telegram token never reaches the log')
})

test('the lock survives a restart, and only the local script unlocks it', async () => {
  await gw.close()
  gw = await startGateway()
  const dispatch = await gw.controller('dispatch', { worker: 'alpha', task: 'Fix it.', words: 'Fix it.' })
  assert.match(dispatch.text, /^\[dispatch=locked/)
  assert.match(await gw.voice.car('status'), /\[ALARM\] Kill switch locked since/, 'heard again after the restart')
  assert.match(gw.log, /kill switch is locked since .* by voice/)

  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [UNLOCK, ...args], { env: { ...process.env, VOICE_GW_SECRETS_DIR: SECRETS }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (out += chunk))
    child.on('close', status => resolve({ status, out }))
  })
  const status = await run(['--status'])
  assert.equal(status.status, 0)
  assert.match(status.out, /^The kill switch is locked since .*, by voice: "Notstopp!" by voice\n/)
  const noTerminal = await run([])
  assert.equal(noTerminal.status, 2, 'without a terminal it needs --yes')
  assert.equal((await killswitchState()).locked, true)

  const unlocked = await run(['--yes'])
  assert.equal(unlocked.status, 0, unlocked.out)
  assert.match(unlocked.out, /Unlocked: the gateway takes tasks again\./)
  assert.equal(existsSync(LOCK), false)
  assert.equal((await killswitchState()).locked, false)
  const again = await gw.controller('dispatch', { worker: 'alpha', task: 'Look at the README.', words: 'x' })
  assert.match(again.text, /^\[dispatch=started worker=alpha/)
  assert.match((await run([])).out, /The kill switch is not locked\./)
})

test('Telegram: /stop from the configured chat locks it; from any other chat nothing happens', async () => {
  telegramUpdate('999', '/stop')
  await sleep(1500)
  assert.equal((await killswitchState()).locked, false)
  telegramUpdate(CHAT, '/stop')
  const state = await waitUntil(async () => (await killswitchState()).state)
  assert.equal(state.trigger, 'telegram')
  assert.match(state.reason, /"\/stop" on Telegram/)
  await unlockByAdmin()
})

test("the controller's alarm locks it", async () => {
  const out = await gw.controller('raise_alarm', { reason: 'The worker in alpha writes to files nobody asked for.' })
  assert.match(out.text, /^\[killswitch=locked\] Kill switch locked since .*, by controller: The worker in alpha writes/)
  assert.equal((await killswitchState()).state.trigger, 'controller')
  await unlockByAdmin()
})

test('a rule: a push to main in a run locks it, and every running worker stops', async () => {
  const slow = await gw.controller('dispatch', { worker: 'beta', task: 'SLOW: a long task.', words: 'x' })
  const slowId = /task=(t[a-z0-9]{3})/.exec(slow.text)[1]
  await waitUntil(() => existsSync(join(TMP, 'claude-calls.jsonl')) && readFileSync(join(TMP, 'claude-calls.jsonl'), 'utf8').includes('SLOW'))
  const slowPid = JSON.parse(readFileSync(join(TMP, 'claude-calls.jsonl'), 'utf8').trim().split('\n').findLast(l => l.includes('SLOW'))).pid
  await gw.controller('dispatch', { worker: 'alpha', task: 'PUSHMAIN: push it.', words: 'x' })

  const state = await waitUntil(async () => (await killswitchState()).state)
  assert.equal(state.trigger, 'rule')
  assert.match(state.reason, /^push to the default branch: the command "git push origin main" \(worker alpha, task t[a-z0-9]{3}\)$/)
  const status = await gw.controller('worker_status', { worker: 'beta' })
  assert.match(status.text, new RegExp(`^\\[worker=beta state=stopped task=${slowId}`))
  assert.match(status.text, /Problem: kill switch \(rule\)/)
  await waitUntil(() => {
    try {
      process.kill(slowPid, 0)
      return false
    } catch {
      return true
    }
  })
  await unlockByAdmin()
})
