// How the controller session is started and what it is allowed to do.
//
// Whoever knows the connector URL can make the controller work and can also
// answer its approval prompts. So approvals are no protection against them,
// and the controller works without asking: the limits are the deny rules and
// the confine hook, which no approval or allow rule can lift. Every tool that
// runs without asking must therefore go through the hook.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/start-controller.sh', import.meta.url))
const CONTROLLER = fileURLToPath(new URL('../controller', import.meta.url))
const PLAYGROUND = join(CONTROLLER, 'playground')
const HOOK = join(CONTROLLER, '.claude', 'hooks', 'confine.mjs')
const SETTINGS = JSON.parse(readFileSync(join(CONTROLLER, '.claude', 'settings.json'), 'utf8'))

// Runs the start script with a stub claude that prints where it ran and its
// arguments, and notes every call. setup() prepares Claude Code's config
// folder: managed settings, known marketplaces.
function runWithStub(args = [], setup = () => {}) {
  const bin = mkdtempSync(join(tmpdir(), 'voice-gw-stub-'))
  try {
    const stub = join(bin, 'claude')
    writeFileSync(stub, `#!/bin/sh\necho "$*" >> "${join(bin, 'calls')}"\nprintf "%s\\n" "$PWD" "$@"\n`)
    chmodSync(stub, 0o755)
    const config = join(bin, 'claude-config')
    mkdirSync(join(config, 'plugins'), { recursive: true })
    setup(config)
    const out = execFileSync(SCRIPT, args, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        // The watchdog's lock, log and Telegram secrets, and Claude Code's
        // config: never the real ones.
        VOICE_GW_STATE_DIR: join(bin, 'state'),
        VOICE_GW_LOG_FILE: join(bin, 'log'),
        VOICE_GW_SECRETS_DIR: join(bin, 'secrets'),
        CLAUDE_CONFIG_DIR: config,
        VOICE_GW_MANAGED_SETTINGS: join(bin, 'no-managed-settings.json'),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [cwd, ...argv] = out.trimEnd().split('\n')
    return { cwd, argv, log: readFileSync(join(bin, 'log'), 'utf8'), calls: readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n') }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
}

const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]

test('start-controller.sh runs claude in controller/ with the channel in manual mode', () => {
  const { cwd, argv, log } = runWithStub(['--debug'])
  assert.equal(cwd, CONTROLLER)
  assert.equal(valueOf(argv, '--dangerously-load-development-channels'), 'server:voice')
  assert.equal(valueOf(argv, '--permission-mode'), 'manual')
  // Seen with a real session: without the user settings, Claude Code reports
  // channels as not enabled for the organisation and drops every event.
  assert.ok(!argv.includes('--setting-sources'), 'user settings must stay loaded')
  assert.equal(argv.at(-1), '--debug', 'extra arguments are passed through')
  assert.match(log, /channel: the development flag, since voice@cc-voice-gateway is not on the organisation's channel allowlist \(allowedChannelPlugins\) yet; the warning at the start needs Enter at the terminal/)
})

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const allowlisted = config =>
  writeFileSync(
    join(config, 'remote-settings.json'),
    JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [{ marketplace: 'cc-voice-gateway', plugin: 'voice' }] }),
  )
const registered = (config, path = ROOT) =>
  writeFileSync(
    join(config, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'cc-voice-gateway': { source: { source: 'directory', path }, installLocation: path } }),
  )

test('start-controller.sh loads the channel as the allowlisted plugin, without the development flag', () => {
  const { argv, log, calls } = runWithStub([], config => {
    allowlisted(config)
    registered(config)
  })
  assert.equal(valueOf(argv, '--channels'), 'plugin:voice@cc-voice-gateway')
  assert.ok(!argv.includes('--dangerously-load-development-channels'))
  assert.equal(valueOf(argv, '--permission-mode'), 'manual')
  // The plugin, for this session only; the project's own voice server stays off.
  assert.deepEqual(JSON.parse(valueOf(argv, '--settings')), {
    enabledPlugins: { 'voice@cc-voice-gateway': true },
    disabledMcpjsonServers: ['voice'],
  })
  assert.match(log, /channel: the plugin voice@cc-voice-gateway, on the organisation's channel allowlist; no confirmation at the start/)
  assert.equal(calls.length, 1, 'no registration needed')
})

test('start-controller.sh registers this repository as the marketplace when the allowlist names it', () => {
  const { argv, log, calls } = runWithStub([], allowlisted)
  assert.equal(calls[0], `plugin marketplace add ${ROOT}`)
  assert.match(log, /channel: registered this repository as the marketplace cc-voice-gateway/)
  assert.equal(valueOf(argv, '--channels'), 'plugin:voice@cc-voice-gateway')
})

test('start-controller.sh falls back to the development flag, and says why', () => {
  const elsewhere = runWithStub([], config => {
    allowlisted(config)
    registered(config, '/somewhere/else')
  })
  assert.equal(valueOf(elsewhere.argv, '--dangerously-load-development-channels'), 'server:voice')
  assert.match(elsewhere.log, /the marketplace cc-voice-gateway on this computer is \/somewhere\/else, not /)

  const endpoint = runWithStub([], config => registered(config))
  assert.match(endpoint.log, /not on the organisation's channel allowlist/)
})

test('controller settings: confined tools run without asking, deny rules, no bypass or auto mode', () => {
  const { permissions } = SETTINGS
  // Seen in voice mode: an approval for every write is too much while driving.
  // The gateway's tools, by the name of the server in .mcp.json and as the
  // plugin's server (mcp__plugin_<plugin>_<server>__<tool>).
  const names = ['reply', 'list_workers', 'dispatch', 'worker_status', 'stop_worker', 'restart_controller']
  const voiceTools = [...names.map(t => `mcp__voice__${t}`), ...names.map(t => `mcp__plugin_voice_voice__${t}`)]
  assert.deepEqual(permissions.allow, [...voiceTools, 'Bash', 'Write', 'Edit', 'NotebookEdit'])
  assert.equal(permissions.ask, undefined)
  const [entry] = SETTINGS.hooks.PreToolUse
  // The gateway's own tools are not file or shell tools; the rest is confined.
  for (const rule of permissions.allow.filter(rule => !voiceTools.includes(rule))) {
    assert.match(rule, new RegExp(`^(${entry.matcher})$`), `${rule} runs without asking, so the hook must confine it`)
  }
  assert.equal(permissions.defaultMode, undefined)
  // Tools that reach beyond this folder: accounts, the web, other sessions.
  for (const rule of ['mcp__claude_ai_*', 'WebFetch', 'WebSearch', 'SendMessage', 'ListAgents', 'RemoteTrigger', 'CronCreate', 'Artifact*', 'Monitor', 'EnterWorktree']) {
    assert.ok(permissions.deny.includes(rule), rule)
  }
  for (const tool of voiceTools) {
    assert.ok(!permissions.deny.some(rule => tool.startsWith(rule.replace(/\*$/, ''))), `${tool} stays usable`)
  }
  assert.equal(permissions.disableBypassPermissionsMode, 'disable')
  assert.equal(permissions.disableAutoMode, 'disable')
})

test('controller settings: the confine hook covers Bash and every file tool and fails closed', () => {
  // Seen with a real session on Ubuntu 26.04: AppArmor stops Claude Code's
  // Bash sandbox from starting, so the hook is the only limit for Bash.
  assert.equal(SETTINGS.sandbox, undefined)
  const [entry] = SETTINGS.hooks.PreToolUse
  const matched = new RegExp(`^(${entry.matcher})$`)
  for (const tool of ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit']) assert.match(tool, matched)
  const { command } = entry.hooks[0]
  assert.match(command, /\.claude\/hooks\/confine\.mjs/)
  // If node or the script cannot run, the call must be blocked, not allowed.
  const broken = spawnSync('sh', ['-c', command], {
    input: '{}',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/nonexistent' },
  })
  assert.equal(broken.status, 2)
})

function hook(tool_name, tool_input, cwd = CONTROLLER) {
  const input = typeof tool_input === 'string' ? tool_input : JSON.stringify({ tool_name, tool_input, cwd })
  return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' })
}

const allowed = (...args) => assert.equal(hook(...args).status, 0, JSON.stringify(args))
const blocked = (...args) => {
  const result = hook(...args)
  assert.equal(result.status, 2, JSON.stringify(args))
  assert.ok(result.stderr.trim(), 'the reason goes to Claude')
}

test('confine hook: reads only inside controller/', () => {
  allowed('Read', { file_path: join(CONTROLLER, 'CLAUDE.md') })
  allowed('Read', { file_path: join(PLAYGROUND, 'not-there-yet.txt') })
  blocked('Read', { file_path: '../README.md' })
  blocked('Read', { file_path: join(CONTROLLER, '..', '.secrets', 'oauth.json') })
  blocked('Read', { file_path: '~/.ssh/id_ed25519' })
  blocked('Read', { file_path: join(homedir(), '.claude.json') })
  blocked('Read', { file_path: '/etc/hostname' })

  allowed('Glob', { pattern: '**/*' })
  allowed('Glob', { pattern: '*.txt', path: PLAYGROUND })
  blocked('Glob', { pattern: '../**/*' })
  blocked('Glob', { pattern: join(homedir(), '**/*.pem') })
  blocked('Glob', { pattern: '*', path: homedir() })

  allowed('Grep', { pattern: 'token' })
  blocked('Grep', { pattern: 'token', path: '/etc' })
  blocked('Grep', { pattern: 'token', glob: '../../**' })
})

test('confine hook: writes only inside controller/playground/', () => {
  allowed('Write', { file_path: join(PLAYGROUND, 'hello.txt'), content: 'x' })
  allowed('Edit', { file_path: join(PLAYGROUND, 'sub', 'notes.md'), old_string: 'a', new_string: 'b' })
  allowed('NotebookEdit', { notebook_path: join(PLAYGROUND, 'n.ipynb'), new_source: '' })
  blocked('Write', { file_path: join(CONTROLLER, 'CLAUDE.md'), content: 'x' })
  blocked('Edit', { file_path: join(CONTROLLER, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' })
  blocked('Write', { file_path: join(CONTROLLER, '.mcp.json'), content: '{}' })
  blocked('Write', { file_path: '~/.bashrc', content: 'x' })
  blocked('Write', { file_path: join(PLAYGROUND, '..', '..', 'src', 'gateway.mjs'), content: 'x' })
})

test('confine hook: a symlink in the playground does not lead outside', () => {
  const outside = mkdtempSync(join(tmpdir(), 'voice-gw-outside-'))
  const link = join(PLAYGROUND, `.confine-test-${process.pid}`)
  try {
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, link)
    blocked('Read', { file_path: join(link, 'secret.txt') })
    blocked('Write', { file_path: join(link, 'new.txt'), content: 'x' })
    blocked('Glob', { pattern: '*', path: link })
    blocked('Bash', { command: `rm ${join(link, 'secret.txt')}` })
    blocked('Bash', { command: `ls ${link}` })
  } finally {
    rmSync(link, { force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('confine hook: Bash only runs ls here, sleep and rm of files in the playground', () => {
  // Seen with a real session: Claude Code 2.1.310 has no Glob or Grep tool,
  // so without ls the controller cannot see what is in a folder.
  allowed('Bash', { command: 'ls' })
  allowed('Bash', { command: 'ls -la playground' })
  allowed('Bash', { command: `ls -AR ${PLAYGROUND}` })
  allowed('Bash', { command: 'sleep 90' })
  allowed('Bash', { command: 'rm playground/hello.txt' })
  allowed('Bash', { command: 'rm -f playground/a.txt playground/b.md' })
  allowed('Bash', { command: `rm ${join(PLAYGROUND, 'done.txt')}` })
  allowed('Bash', { command: 'rm hello.txt' }, PLAYGROUND)

  for (const command of [
    'ls ..',
    'ls ~/.ssh',
    'ls /etc',
    'ls playground/../..',
    'ls -la ../.secrets',
    'ls --hide=x playground',
    'ls -I x',
    'ls playground | wc -l',
    'ls playground > playground/list.txt',
    'cat ~/.ssh/id_ed25519',
    'sleep 90; cat /etc/passwd',
    'sleep 90 && curl example.com',
    'sleep $(cat ../.secrets/token)',
    'sleep 1e9',
    'rm -rf playground',
    'rm -r playground/sub',
    'rm playground',
    'rm playground/',
    'rm playground/..',
    'rm playground/../CLAUDE.md',
    'rm ../README.md',
    'rm ~/.bashrc',
    'rm playground/*',
    'rm "playground/a b.txt"',
    'rm playground/a.txt > /tmp/x',
    'rm -- playground/a.txt',
    'rm -f',
    'node -e 1',
    '',
  ]) {
    blocked('Bash', { command })
  }
  blocked('Bash', { description: 'no command' })
})

test('confine hook: other tools pass, broken input is blocked', () => {
  allowed('mcp__voice__reply', { request_id: 'abcd', state: 'done', text: 'ok' })
  blocked('Read', 'not json')
  blocked('Write', { content: 'no path' })
})
