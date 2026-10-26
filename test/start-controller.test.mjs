// How the controller session is started, and which approvals it must ask for.
//
// User-level settings must not switch approvals off: a user-wide
// bypassPermissions default or allow rules like Write(*) approve every tool
// call silently, so no approval ever reaches the car.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/start-controller.sh', import.meta.url))
const CONTROLLER = fileURLToPath(new URL('../controller', import.meta.url))

function runWithStub(...args) {
  const bin = mkdtempSync(join(tmpdir(), 'voice-gw-stub-'))
  try {
    const stub = join(bin, 'claude')
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n')
    chmodSync(stub, 0o755)
    const out = execFileSync(SCRIPT, args, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })
    const [cwd, ...argv] = out.trimEnd().split('\n')
    return { cwd, argv }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
}

const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]

test('start-controller.sh runs claude in controller/ with the channel in manual mode', () => {
  const { cwd, argv } = runWithStub('--debug')
  assert.equal(cwd, CONTROLLER)
  assert.equal(valueOf(argv, '--dangerously-load-development-channels'), 'server:voice')
  assert.equal(valueOf(argv, '--permission-mode'), 'manual')
  // Seen with a real session: without the user settings, Claude Code reports
  // channels as not enabled for the organisation and drops every event.
  assert.ok(!argv.includes('--setting-sources'), 'user settings must stay loaded')
  assert.equal(argv.at(-1), '--debug', 'extra arguments are passed through')
})

test('controller settings ask for Bash, Write and Edit, overriding user allow rules', () => {
  const settings = JSON.parse(readFileSync(new URL('../controller/.claude/settings.json', import.meta.url), 'utf8'))
  // Ask rules are checked before allow rules from any settings file.
  for (const tool of ['Bash', 'Write', 'Edit']) assert.ok(settings.permissions.ask.includes(tool), tool)
  assert.deepEqual(settings.permissions.allow, ['mcp__voice__reply'])
  assert.equal(settings.permissions.defaultMode, undefined)
})
