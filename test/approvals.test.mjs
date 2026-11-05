// The approval requests of the controller's teammates, which Claude Code never
// relays to the channel (seen with 2.1.312: an agent spawned with a name runs
// as an in-process teammate, its prompts show only at the terminal, and the
// standorte-drive teammate waited all night on a Google Drive search and on a
// Write into another project's memory folder). The controller's
// PermissionRequest hook (controller/.claude/hooks/approval.mjs) hands them
// to the gateway (src/approvals.mjs), which lists them like the channel's
// and sends the driver's verdict back to the waiting hook.
//
// The hook runs here as Claude Code runs it: a process with the hook's input
// on stdin, its decision on stdout.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HookApprovals, describeInput, newCode } from '../src/approvals.mjs'
import { Store, pending } from '../src/store.mjs'
import { TelegramAnswers, TelegramFallback } from '../src/telegram.mjs'

const CONTROLLER = fileURLToPath(new URL('../controller', import.meta.url))
const HOOK = join(CONTROLLER, '.claude', 'hooks', 'approval.mjs')
const SETTINGS = JSON.parse(readFileSync(join(CONTROLLER, '.claude', 'settings.json'), 'utf8'))
const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-appr-'))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

after(() => rmSync(TMP, { recursive: true, force: true }))

async function waitUntil(predicate, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(10)
  }
}

let folders = 0
// A secrets folder of its own, with the session's transcript folder of
// Claude Code next to it, where a teammate's record is.
function place() {
  const dir = join(TMP, String(++folders))
  const secrets = join(dir, 's')
  const session = join(dir, 'projects', 'sess-1')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  mkdirSync(join(session, 'subagents'), { recursive: true })
  return { dir, secrets, socket: join(secrets, 'approval.sock'), transcript: `${session}.jsonl`, subagents: join(session, 'subagents') }
}

// Claude Code's record of an agent, as 2.1.312 writes it next to the transcript.
function record(p, id, meta) {
  writeFileSync(join(p.subagents, `agent-${id}.meta.json`), JSON.stringify(meta))
}
const TEAMMATE_META = name => ({
  agentType: name,
  isBuiltIn: false,
  name,
  spawnDepth: 0,
  requestShape: 'background',
  requestNonInteractive: true,
  taskKind: 'in_process_teammate',
  teamName: 'session-sess-1',
  spawnedAgentType: 'general-purpose',
  permissionMode: 'default',
})

// The hook's input, as Claude Code 2.1.312 gives it (recorded with a real session).
function hookInput(p, { agent_id, agent_type, tool_name = 'Bash', tool_input = { command: 'date > x.txt', description: 'Write the date' } } = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: p.transcript,
    cwd: CONTROLLER,
    permission_mode: 'manual',
    ...(agent_id ? { agent_id, agent_type } : {}),
    hook_event_name: 'PermissionRequest',
    tool_name,
    tool_input,
    permission_suggestions: [],
  }
}

// Runs the hook as Claude Code does; resolves with { status, stdout, stderr }.
// env: on top of a clean environment with the place's secrets folder.
function runHook(p, input, env = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, VOICE_GW_SECRETS_DIR: p.secrets, CLAUDE_PROJECT_DIR: CONTROLLER, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const out = { status: null, stdout: '', stderr: '', child }
  child.stdout.on('data', chunk => (out.stdout += chunk))
  child.stderr.on('data', chunk => (out.stderr += chunk))
  out.done = new Promise(resolve => child.on('close', status => resolve(Object.assign(out, { status }))))
  child.stdin.end(JSON.stringify(input))
  return out
}
const decisionOf = stdout => JSON.parse(stdout).hookSpecificOutput

// A socket that records every request and answers with answer.
async function fakeGateway(p, answer = { behavior: 'allow' }) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  await new Promise(resolve => server.listen(p.socket, resolve))
  return { seen, close: () => new Promise(resolve => server.close(resolve)) }
}

// The gateway's side: a store and the approval socket.
async function gateway(p, { killswitch = { locked: false }, relay = true } = {}) {
  const logged = []
  const store = new Store({ log: () => {} })
  const approvals = new HookApprovals({ store, killswitch, relay, log: (...parts) => logged.push(parts.join(' ')) })
  assert.equal(await approvals.listen(p.socket), true)
  return { store, approvals, logged, killswitch }
}

// --- the hook ------------------------------------------------------------------

test('controller settings: the approval hook sees every prompt, waits a week, and never blocks one when it fails', () => {
  assert.equal(SETTINGS.hooks.PermissionRequest.length, 1)
  const [entry] = SETTINGS.hooks.PermissionRequest
  assert.equal(entry.matcher, '*')
  assert.equal(entry.hooks.length, 1)
  const [hook] = entry.hooks
  assert.equal(hook.type, 'command')
  assert.match(hook.command, /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/approval\.mjs" \|\| true$/)
  // Claude Code's default for a hook is ten minutes: the driver may take longer.
  assert.equal(hook.timeout, 7 * 24 * 3600)
  // If node or the script cannot run: no decision, so the prompt opens at the terminal.
  const broken = spawnSync('sh', ['-c', hook.command], { input: '{}', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '/nonexistent' } })
  assert.equal(broken.status, 0)
  assert.equal(broken.stdout, '')
  // The confine hook stays as it was.
  assert.equal(SETTINGS.hooks.PreToolUse.length, 1)
})

test('the hook leaves the main session and ordinary subagents to the channel: no decision, no call to the gateway', async () => {
  const p = place()
  const fake = await fakeGateway(p)
  try {
    // The main session: no agent_id. The channel relays its prompts.
    const main = await runHook(p, hookInput(p)).done
    assert.deepEqual([main.status, main.stdout], [0, ''])
    // An ordinary subagent: its record has no taskKind; after the hook, its
    // dialog and the channel's relay open (seen with 2.1.312).
    record(p, 'aa442687c1e1c600b', { agentType: 'general-purpose', isBuiltIn: true, requestShape: 'background', requestNonInteractive: true })
    const ordinary = await runHook(p, hookInput(p, { agent_id: 'aa442687c1e1c600b', agent_type: 'general-purpose' })).done
    assert.deepEqual([ordinary.status, ordinary.stdout], [0, ''])
    // One spawned with a name but without agent teams has the same kind of record.
    record(p, 'a62cdb0ffa0aed54a', { agentType: 'general-purpose', name: 'gateway-stats', requestShape: 'background' })
    assert.equal((await runHook(p, hookInput(p, { agent_id: 'a62cdb0ffa0aed54a', agent_type: 'general-purpose' })).done).stdout, '')
    // An id that would lead out of the folder is no teammate either.
    assert.equal((await runHook(p, hookInput(p, { agent_id: '../../x', agent_type: 'x' })).done).stdout, '')
    assert.equal(fake.seen.length, 0)
  } finally {
    await fake.close()
  }
})

test("the hook hands a teammate's prompt to the gateway and gives Claude Code the driver's verdict", async () => {
  const p = place()
  const fake = await fakeGateway(p, { behavior: 'allow' })
  try {
    record(p, 'astandorte-drive-b0d52828dcc05b49', TEAMMATE_META('standorte-drive'))
    const input = hookInput(p, {
      agent_id: 'astandorte-drive-b0d52828dcc05b49',
      agent_type: 'standorte-drive',
      tool_name: 'Write',
      // A file's whole content goes to the gateway cut short.
      tool_input: { file_path: '/home/u/.claude/projects/-home-u-hauswache/memory/engelberg.md', content: 'x'.repeat(5000) },
    })
    const allowed = await runHook(p, input).done
    assert.equal(allowed.status, 0)
    assert.deepEqual(decisionOf(allowed.stdout), { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } })
    const [{ url, body }] = fake.seen
    assert.equal(url, '/approval')
    assert.equal(body.tool_name, 'Write')
    assert.equal(body.agent_name, 'standorte-drive')
    assert.equal(body.agent_id, 'astandorte-drive-b0d52828dcc05b49')
    assert.equal(body.tool_input.file_path, '/home/u/.claude/projects/-home-u-hauswache/memory/engelberg.md')
    assert.equal(body.tool_input.content.length, 2001, 'cut at 2000 characters')
  } finally {
    await fake.close()
  }

  // Without its record: by the id, "a", the name, "-" and 16 hex digits.
  const q = place()
  const denying = await fakeGateway(q, { behavior: 'deny', message: 'Denied by the driver through the voice gateway.' })
  try {
    const denied = await runHook(q, hookInput(q, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' })).done
    assert.deepEqual(decisionOf(denied.stdout).decision, { behavior: 'deny', message: 'Denied by the driver through the voice gateway.' })
    assert.equal(denying.seen[0].body.agent_name, 'probe-tm')
  } finally {
    await denying.close()
  }
})

test('the hook fails open to the terminal: no gateway, the relay off, an error', async () => {
  const p = place()
  record(p, 'aprobe-tm-2c8e2040eb4580c9', TEAMMATE_META('probe-tm'))
  const input = hookInput(p, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' })
  // No gateway listens.
  const none = await runHook(p, input).done
  assert.deepEqual([none.status, none.stdout], [0, ''])
  assert.match(none.stderr, /voice gateway: approval not relayed \(.*\); the prompt goes to the terminal/)
  // The gateway decides nothing: the permission relay is off.
  const fake = await fakeGateway(p, { behavior: null, why: 'the permission relay is off (VOICE_GW_PERMISSION_RELAY=0)' })
  try {
    const off = await runHook(p, input).done
    assert.deepEqual([off.status, off.stdout], [0, ''])
    assert.match(off.stderr, /the permission relay is off/)
  } finally {
    await fake.close()
  }
  // Input that is no JSON.
  const bad = spawnSync(process.execPath, [HOOK], { input: 'nonsense', encoding: 'utf8', env: { ...process.env, VOICE_GW_SECRETS_DIR: p.secrets } })
  assert.deepEqual([bad.status, bad.stdout], [0, ''])
})

test("the hook finds the secrets folder in controller/.mcp.json's entry for the gateway, as the plugin does", async () => {
  const p = place()
  record(p, 'aprobe-tm-2c8e2040eb4580c9', TEAMMATE_META('probe-tm'))
  const mcp = join(p.dir, 'mcp.json')
  writeFileSync(mcp, JSON.stringify({ mcpServers: { voice: { command: 'node', env: { VOICE_GW_SECRETS_DIR: '${PLACE}/s' } } } }))
  const fake = await fakeGateway(p)
  try {
    const { VOICE_GW_SECRETS_DIR, ...env } = process.env
    const child = spawn(process.execPath, [HOOK], { env: { ...env, VOICE_GW_MCP_JSON: mcp, PLACE: p.dir }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stdin.end(JSON.stringify(hookInput(p, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' })))
    await new Promise(resolve => child.on('close', resolve))
    assert.equal(decisionOf(stdout).decision.behavior, 'allow')
    assert.equal(fake.seen.length, 1)
  } finally {
    await fake.close()
  }
})

// --- the gateway's side ----------------------------------------------------------

test("a teammate's approval: listed like the channel's, with its name; the verdict goes back to its hook", async () => {
  const p = place()
  const gw = await gateway(p)
  try {
    record(p, 'astandorte-drive-b0d52828dcc05b49', TEAMMATE_META('standorte-drive'))
    const hook = runHook(p, hookInput(p, {
      agent_id: 'astandorte-drive-b0d52828dcc05b49',
      agent_type: 'standorte-drive',
      tool_name: 'mcp__claude_ai_Google_Drive__search_files',
      tool_input: { query: "title contains 'Bedigliora'" },
    }))
    const [permission] = await waitUntil(() => gw.store.openPermissions().length && gw.store.openPermissions())
    assert.match(permission.code, /^[a-km-z]{5}$/)
    assert.equal(permission.toolName, 'mcp__claude_ai_Google_Drive__search_files')
    assert.equal(permission.source, 'hook')
    assert.equal(permission.agent, 'standorte-drive')
    assert.equal(permission.inputPreview, `{"query":"title contains 'Bedigliora'"}`)
    assert.ok(pending(permission))
    assert.ok(gw.approvals.owns(permission.code))
    assert.ok(gw.logged.some(line => line.startsWith(`permission_request code=${permission.code} tool=mcp__claude_ai_Google_Drive__search_files subagent=standorte-drive`)))

    // The session going on is no sign that a teammate's prompt was answered.
    assert.deepEqual(gw.store.closePermissionsElsewhere(), [])
    assert.ok(pending(permission))

    // The driver's yes, claimed in the store first as voice.mjs and telegram.mjs do.
    assert.equal(hook.stdout, '', 'the hook waits')
    gw.store.resolvePermission(permission.code, 'allow', 'voice')
    await gw.approvals.verdict(permission.code, 'allow')
    const done = await hook.done
    assert.deepEqual(decisionOf(done.stdout).decision, { behavior: 'allow' })
    assert.ok(!gw.approvals.owns(permission.code))
    assert.ok(gw.logged.includes(`verdict code=${permission.code} behavior=allow (subagent standorte-drive)`))
  } finally {
    gw.approvals.close()
  }
})

test('kill switch: a teammate is denied at once while it is locked; without the relay the hook decides nothing', async () => {
  const p = place()
  record(p, 'aprobe-tm-2c8e2040eb4580c9', TEAMMATE_META('probe-tm'))
  const input = hookInput(p, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' })
  const locked = await gateway(p, { killswitch: { locked: true } })
  try {
    const denied = await runHook(p, input).done
    assert.deepEqual(decisionOf(denied.stdout).decision, { behavior: 'deny', message: 'Denied: the kill switch of the voice gateway is locked.' })
    assert.equal(locked.store.permissions.size, 0, 'nothing listed')
    assert.ok(locked.logged.some(line => line.startsWith('permission_request denied, kill switch locked tool=Bash (subagent probe-tm)')))
  } finally {
    locked.approvals.close()
  }
  const q = place()
  record(q, 'aprobe-tm-2c8e2040eb4580c9', TEAMMATE_META('probe-tm'))
  const off = await gateway(q, { relay: false })
  try {
    const out = await runHook(q, hookInput(q, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' })).done
    assert.deepEqual([out.status, out.stdout], [0, ''])
    assert.equal(off.store.permissions.size, 0)
  } finally {
    off.approvals.close()
  }
})

test('a hook that stops waiting withdraws its approval: off the lists, heard once, and an answer reaches nobody', async () => {
  const p = place()
  const gw = await gateway(p)
  try {
    record(p, 'aprobe-tm-2c8e2040eb4580c9', TEAMMATE_META('probe-tm'))
    const hook = runHook(p, hookInput(p, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' }))
    const [permission] = await waitUntil(() => gw.store.openPermissions().length && gw.store.openPermissions())
    permission.announced = true // the voice client read it out
    // Claude Code ends the hook: its time ran out, or the session ended.
    hook.child.kill('SIGTERM')
    await hook.done
    await waitUntil(() => permission.withdrawn)
    assert.equal(permission.status, 'withdrawn')
    assert.ok(!pending(permission))
    assert.deepEqual(gw.store.openPermissions(), [])
    assert.deepEqual(gw.store.pendingPermissions(), [])
    assert.ok(gw.logged.some(line => line.startsWith(`permission withdrawn: the hook stopped waiting code=${permission.code}`)))
    assert.deepEqual(gw.store.takeAnsweredElsewhere().map(item => item.code), [permission.code])
    assert.deepEqual(gw.store.takeAnsweredElsewhere(), [], 'once')
    await assert.rejects(gw.approvals.verdict(permission.code, 'allow'), /the subagent that asked stopped waiting for it/)
    assert.equal(gw.store.resolvePermission(permission.code, 'allow'), null)

    // Claimed by an answer that then could not reach the hook: an answer that
    // sets its status back (telegram.mjs) does not list it again.
    const second = runHook(p, hookInput(p, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' }))
    const [other] = await waitUntil(() => gw.store.openPermissions().length && gw.store.openPermissions())
    gw.store.resolvePermission(other.code, 'allow', 'telegram')
    second.child.kill('SIGTERM')
    await second.done
    await waitUntil(() => other.withdrawn)
    assert.equal(other.status, 'allow', 'the status the answer claimed')
    Object.assign(other, { status: 'open', by: undefined })
    assert.deepEqual(gw.store.openPermissions(), [])
    assert.ok(!pending(other))
  } finally {
    gw.approvals.close()
  }
})

test('the gateway shutting down lets the waiting hooks go: their prompts open at the terminal', async () => {
  const p = place()
  const gw = await gateway(p)
  record(p, 'aprobe-tm-2c8e2040eb4580c9', TEAMMATE_META('probe-tm'))
  const hook = runHook(p, hookInput(p, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' }))
  const [permission] = await waitUntil(() => gw.store.openPermissions().length && gw.store.openPermissions())
  gw.approvals.close()
  const out = await hook.done
  assert.deepEqual([out.status, out.stdout], [0, ''])
  assert.ok(permission.withdrawn)
})

test('Telegram: the approval request names the subagent and no terminal; a yes there goes to the hook; one withdrawn says so', async () => {
  const p = place()
  const gw = await gateway(p)
  const sent = []
  const fallback = new TelegramFallback(gw.store, {
    send: async text => {
      sent.push(text)
      return { message_id: 100 + sent.length }
    },
    approvable: () => true,
    log: () => {},
  })
  const said = []
  const answers = new TelegramAnswers({
    store: gw.store,
    mode: 'on',
    confirm: true,
    killswitch: gw.killswitch,
    presence: { state: () => ({ active: true }) },
    push: async () => {},
    say: async text => said.push(text),
    // As gateway.mjs: channel.sendVerdict, which sends a hook's verdict to the hook.
    verdict: (code, behavior) => gw.approvals.verdict(code, behavior),
    record: () => {},
    log: () => {},
  })
  try {
    record(p, 'astandorte-drive-b0d52828dcc05b49', TEAMMATE_META('standorte-drive'))
    const hook = runHook(p, hookInput(p, { agent_id: 'astandorte-drive-b0d52828dcc05b49', agent_type: 'standorte-drive' }))
    const [permission] = await waitUntil(() => gw.store.openPermissions().length && gw.store.openPermissions())
    await waitUntil(() => permission.telegramMessage)
    assert.match(sent[0], new RegExp(`^Approval request ${permission.code} \\(subagent standorte-drive of the controller session\\)\n\nBash: Write the date\n`))
    assert.match(sent[0], /\("yes to all" allows every one open\)\. Or answer in voice mode\.$/)
    assert.doesNotMatch(sent[0], /terminal/)

    await answers.route({ text: 'Yes', replyTo: permission.telegramMessage, messageId: 7 })
    assert.deepEqual(decisionOf((await hook.done).stdout).decision, { behavior: 'allow' })
    assert.match(said.at(-1), new RegExp(`^Allowed: approval request ${permission.code} \\(Bash: Write the date\\)\\. Claude Code goes on\\.`))

    // A second one, whose hook stops waiting before the driver answers.
    const second = runHook(p, hookInput(p, { agent_id: 'astandorte-drive-b0d52828dcc05b49', agent_type: 'standorte-drive' }))
    const [other] = await waitUntil(() => gw.store.openPermissions().length && gw.store.openPermissions())
    await waitUntil(() => other.telegramMessage)
    second.child.kill('SIGTERM')
    await waitUntil(() => other.withdrawn)
    await answers.route({ text: 'yes', replyTo: other.telegramMessage, messageId: 8 })
    assert.equal(said.at(-1), `Not passed on: approval request ${other.code} is not open any more: the subagent that asked stopped waiting for it.`)
  } finally {
    fallback.close()
    gw.approvals.close()
  }
})

test("Telegram: a standby holds a teammate's approval request; with VOICE_GW_TELEGRAM_CONFIRM=0 a yes there answers nothing, the voice does", async () => {
  const p = place()
  const gw = await gateway(p)
  const sent = []
  let standby = true
  const fallback = new TelegramFallback(gw.store, {
    send: async text => {
      sent.push(text)
      return { message_id: 200 + sent.length }
    },
    held: () => standby,
    paused: () => standby,
    approvable: () => false,
    log: () => {},
  })
  const said = []
  const answers = new TelegramAnswers({
    store: gw.store,
    mode: 'on',
    confirm: false,
    killswitch: gw.killswitch,
    presence: { state: () => ({ active: true }) },
    push: async () => {},
    say: async text => said.push(text),
    verdict: (code, behavior) => gw.approvals.verdict(code, behavior),
    record: () => {},
    log: () => {},
  })
  try {
    record(p, 'aprobe-tm-2c8e2040eb4580c9', TEAMMATE_META('probe-tm'))
    const hook = runHook(p, hookInput(p, { agent_id: 'aprobe-tm-2c8e2040eb4580c9', agent_type: 'probe-tm' }))
    const [permission] = await waitUntil(() => gw.store.openPermissions().length && gw.store.openPermissions())
    await sleep(100)
    assert.deepEqual(sent, [], 'held in the standby')
    standby = false
    fallback.check()
    await waitUntil(() => permission.telegramMessage)
    assert.match(sent[0], /\n\nAnswer in voice mode; Telegram cannot approve\.$/)

    await answers.route({ text: 'yes', replyTo: permission.telegramMessage, messageId: 9 })
    assert.equal(said.at(-1), `Not passed on: approval request ${permission.code} is answered in voice mode; Telegram cannot approve.`)
    assert.ok(pending(permission))
    assert.equal(hook.stdout, '', 'the hook still waits')
    // By voice (voice.mjs, approve): claimed, then to the hook.
    gw.store.resolvePermission(permission.code, 'deny', 'voice')
    await gw.approvals.verdict(permission.code, 'deny')
    assert.deepEqual(decisionOf((await hook.done).stdout).decision, { behavior: 'deny', message: 'Denied by the driver through the voice gateway.' })
  } finally {
    fallback.close()
    gw.approvals.close()
  }
})

test('what a prompt is about, from the tool input; codes as Claude Code makes them', () => {
  assert.equal(describeInput('Bash', { command: 'gh pr list', description: 'List pull requests' }), 'List pull requests')
  assert.equal(describeInput('Bash', { command: 'gh pr list' }), 'gh pr list')
  assert.equal(describeInput('Write', { file_path: '/a/b.md', content: 'x' }), 'Write /a/b.md')
  assert.equal(describeInput('Edit', { file_path: '/a/b.md' }), 'Edit /a/b.md')
  assert.equal(describeInput('WebFetch', { url: 'https://example.com' }), 'Fetch https://example.com')
  assert.equal(describeInput('mcp__claude_ai_Google_Drive__search_files', { query: 'x' }), '')
  const taken = new Set(['abcde'])
  for (let i = 0; i < 200; i++) {
    const code = newCode(code => taken.has(code))
    assert.match(code, /^[a-km-z]{5}$/)
    assert.ok(!taken.has(code))
    taken.add(code)
  }
})
