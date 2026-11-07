// The fence of a worker's run (fence.mjs): the guard's hook, as Claude Code
// runs it with sh before a Bash or file tool call, refuses a call that would
// write outside the run's allowed folders, with a message that names them,
// and only ever refuses: without its fence or its module, or with a fence it
// cannot read, it only reports the call, as before. And the run folders'
// names (workspaces.mjs), with nothing in them to guess: <id>, with the
// dated ones from before still taken.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.VOICE_GW_LOG_FILE = ''
const { FENCE_MODULE, guardHooks, toolStarts } = await import('../src/guard.mjs')
const { FENCE_VERSION, fenceWrites, refusal, refusalTag } = await import('../src/fence.mjs')
const { runFolderEntries, runFolderTools } = await import('../src/workspaces.mjs')
const { HostRunner } = await import('../src/runners.mjs')
const { Workers } = await import('../src/workers.mjs')

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-fence-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const HOME = '/home/u'
const FENCE = {
  v: FENCE_VERSION,
  task: 'tf01',
  kind: 'repo',
  dir: '/work/alpha',
  home: HOME,
  runFolder: '/work/.voice-runs/alpha/84rf',
  allowed: ['/work/alpha', `${HOME}/.claude/projects/-work-alpha/memory`, '/tmp', '/var/tmp', '/work/.voice-runs/alpha/84rf', '/srv/granted'],
  granted: ['/srv/granted'],
}

// The hook as Claude Code runs it: { out, err, code }.
function hook(input, notes, module = FENCE_MODULE) {
  const command = guardHooks(process.execPath, module).PreToolUse[0].hooks[0].command
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (notes) env.VOICE_GW_GUARD_NOTES = notes
    else delete env.VOICE_GW_GUARD_NOTES
    const child = spawn('sh', ['-c', command], { env })
    let out = ''
    let err = ''
    child.stdout.on('data', data => (out += data))
    child.stderr.on('data', data => (err += data))
    child.on('error', reject)
    child.on('close', code => resolve({ code, out, err }))
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', ...input }))
  })
}

let fences = 0
function fenceFile(fence = FENCE) {
  const notes = join(TMP, `f${++fences}`, 'tf01.notes')
  mkdirSync(join(notes, '..'), { recursive: true })
  if (fence !== null) writeFileSync(`${notes}.fence`, typeof fence === 'string' ? fence : JSON.stringify(fence))
  return notes
}

test('the file tools: a write outside is refused, with the path; inside the workspace, the run folder, a granted folder, a device and the memory folder it is not', () => {
  for (const [name, input] of [
    ['Write', { file_path: '/home/u/notes.md', content: 'x' }],
    ['Edit', { file_path: '/home/u/notes.md', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: '/home/u/notes.md', edits: [] }],
    ['NotebookEdit', { notebook_path: '/home/u/n.ipynb', new_source: 'x' }],
    ['Write', { file_path: '../beta/a.md', content: 'x' }], // relative: from the workspace
    ['Write', { file_path: '/work/.voice-runs/alpha/2026-11-07-84rf/pr-body.md', content: 'x' }],
    ['Write', { file_path: '/work/alpha/.git/hooks/pre-push', content: 'x' }],
  ]) {
    assert.equal(fenceWrites(FENCE, name, input).length, 1, `${name} ${JSON.stringify(input)}`)
  }
  assert.deepEqual(fenceWrites(FENCE, 'Edit', { file_path: '/home/u/notes.md' })[0], { path: '/home/u/notes.md', op: 'edit', shown: 'Edit /home/u/notes.md' })
  for (const [name, input] of [
    ['Write', { file_path: '/work/alpha/src/a.js' }],
    ['Write', { file_path: 'src/b.js' }],
    ['Write', { file_path: '/work/.voice-runs/alpha/84rf/shots/a.png' }],
    ['Write', { file_path: '/srv/granted/data.json' }],
    ['Write', { file_path: '/tmp/x.txt' }],
    ['Write', { file_path: `${HOME}/.claude/projects/-work-alpha/memory/MEMORY.md` }],
    ['Write', { file_path: '/dev/null' }],
    ['Write', {}], // no path: nothing to read
    ['Read', { file_path: '/etc/passwd' }],
  ]) {
    assert.deepEqual(fenceWrites(FENCE, name, input), [], `${name} ${JSON.stringify(input)}`)
  }
})

test("the hook refuses a write outside with permissionDecision deny and the fence's message; its report goes to stderr with refused", async () => {
  const notes = fenceFile()
  const { out, err, code } = await hook(
    { tool_name: 'Bash', tool_use_id: 'toolu_x1', cwd: '/work/alpha', tool_input: { command: 'mkdir -p $TMPDIR/w && mv ~/.config/.wrangler/a.json $TMPDIR/w/' } },
    notes,
  )
  assert.equal(code, 0)
  const decision = JSON.parse(out).hookSpecificOutput
  assert.equal(decision.hookEventName, 'PreToolUse')
  assert.equal(decision.permissionDecision, 'deny')
  assert.equal(
    decision.permissionDecisionReason,
    `${refusalTag('toolu_x1')} before it ran: it would remove or move away /home/u/.config/.wrangler/a.json, outside your allowed ` +
      'folders, and nothing of it ran. Write only in your repository /work/alpha, your run folder /work/.voice-runs/alpha/84rf ' +
      '(also $TMPDIR and $VOICE_GW_RUN_FOLDER), the folders granted to this repository (/srv/granted) and the temporary folders. ' +
      'Do not move, remove or tidy up files outside them, not even ones a tool left there, such as caches and logs in your home ' +
      'folder: leave them where they are and name them in your result instead. Do not look for another way around this. A refused ' +
      'call counts as an invalid write: the third invalid write of a run stops all work.',
  )
  const [report] = toolStarts(err)
  assert.deepEqual([report.id, report.cwd, report.agent, report.refused], ['toolu_x1', '/work/alpha', null, true])

  // A subagent's call, from the folder Claude Code names for it.
  const sub = await hook({ tool_name: 'Bash', tool_use_id: 'toolu_x2', agent_id: 'a1', cwd: '/work/alpha/deep/er', tool_input: { command: 'echo x > ../../../notes.md' } }, notes)
  assert.match(JSON.parse(sub.out).hookSpecificOutput.permissionDecisionReason, /it would write \/work\/notes\.md, outside/)
  assert.equal(toolStarts(sub.err)[0].agent, 'a1')

  // A work folder's run, and a worktree's: the message names theirs.
  const scratch = fenceFile({ ...FENCE, kind: 'scratch', dir: '/scratch/2026-11-07-ab12', runFolder: null, granted: [], allowed: ['/scratch/2026-11-07-ab12', '/tmp'] })
  const s = await hook({ tool_name: 'Write', tool_use_id: 'toolu_x3', cwd: '/scratch/2026-11-07-ab12', tool_input: { file_path: '/home/u/r.md' } }, scratch)
  assert.match(JSON.parse(s.out).hookSpecificOutput.permissionDecisionReason, /Write only in your work folder \/scratch\/2026-11-07-ab12 and the temporary folders\./)
  const worktree = fenceFile({ ...FENCE, kind: 'worktree', dir: '/work/.voice-worktrees/alpha/w1', granted: [] })
  const w = await hook({ tool_name: 'Write', tool_use_id: 'toolu_x4', cwd: '/work/alpha', tool_input: { file_path: '/home/u/r.md' } }, worktree)
  assert.match(JSON.parse(w.out).hookSpecificOutput.permissionDecisionReason, /Write only in your worktree \/work\/\.voice-worktrees\/alpha\/w1, your run folder/)
})

test('the hook only refuses: what stays inside, a target a variable hides, and a hook without its fence or module only report the call', async () => {
  const notes = fenceFile()
  const report = async (input, given = notes, module = FENCE_MODULE) => {
    const { out, err, code } = await hook({ tool_use_id: 'toolu_y', cwd: '/work/alpha', ...input }, given, module)
    assert.equal(code, 0)
    assert.equal(err, '', JSON.stringify(input))
    const [line] = toolStarts(out)
    assert.equal(line?.id, 'toolu_y', `${JSON.stringify(input)}: ${out}`)
    assert.equal(line.refused, undefined)
  }
  await report({ tool_name: 'Bash', tool_input: { command: 'npm ci > $TMPDIR/npm-ci.log 2>&1; npm test 2>/dev/null | tail -5' } })
  await report({ tool_name: 'Bash', tool_input: { command: 'cd /work/alpha && git commit -m "a > b" && git push origin voice/x' } })
  await report({ tool_name: 'Bash', tool_input: { command: 'cp a.txt "$UNKNOWN"/x' } })
  await report({ tool_name: 'Bash', tool_input: { command: 'crontab -l' } })
  await report({ tool_name: 'Write', tool_input: { file_path: '/work/alpha/a.md' } })
  await report({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } })
  // Without the fence, with a broken one or one of another version, without
  // the module or the notes: nothing is refused.
  const outside = { tool_name: 'Write', tool_input: { file_path: '/home/u/x.md' } }
  await report(outside, fenceFile(null))
  await report(outside, fenceFile('{"v":1,'))
  await report(outside, fenceFile({ ...FENCE, v: 99 }))
  await report(outside, fenceFile({ ...FENCE, allowed: 'everything' }))
  await report(outside, notes, join(TMP, 'no-such-module.mjs'))
  const none = await hook({ tool_use_id: 'toolu_y', cwd: '/work/alpha', ...outside }, null)
  assert.equal(toolStarts(none.out)[0].id, 'toolu_y')
  assert.equal(refusal({ tool_name: 'Write', tool_input: { file_path: '/home/u/x.md' } }, `${notes}.fence`), null, 'no id, no refusal: it could not be told apart')
})

test('run folders are named by their id alone; the dated ones from before are still taken, and a session that goes on keeps its own', async () => {
  const at = Date.now()
  const entry = { repo: 'alpha', container: null, usedAt: at, removedAt: null }
  const kept = runFolderEntries({
    '/w/.voice-runs/alpha/84rf': entry,
    '/w/.voice-runs/alpha/2026-11-06-84rf': entry,
    '/w/.voice-runs/alpha/84rf-x': entry,
    '/w/.voice-runs/alpha/2026-11-06': entry,
    '/w/.voice-runs/alpha/../../etc': entry,
    '/w/.voice-runs/beta/abcd': entry, // another repository's name
  })
  assert.deepEqual(Object.keys(kept), ['/w/.voice-runs/alpha/84rf', '/w/.voice-runs/alpha/2026-11-06-84rf'])

  const root = join(TMP, 'names', 'Developer')
  mkdirSync(join(root, 'alpha', '.git'), { recursive: true })
  const workers = new Workers({ root, stateDir: join(TMP, 'names', 'state') })
  try {
    const runner = new HostRunner(root)
    const made = await workers.runFolder('alpha', { runner })
    assert.match(made.dir, new RegExp(`^${join(root, '.voice-runs', 'alpha')}/[a-z0-9]{4}$`), 'nothing to guess')
    assert.ok(existsSync(made.dir))
    // A session from before goes on in its dated folder.
    const dated = join(root, '.voice-runs', 'alpha', '2026-11-06-84rf')
    workers.state.runFolders[dated] = { ...entry }
    const again = await workers.runFolder('alpha', { runner, holder: { sessionId: 's1', runFolder: dated }, resumed: true })
    assert.equal(again.dir, dated)
    assert.ok(existsSync(dated), 'made again where it was removed')
  } finally {
    workers.close()
  }
  // The logs of tools that keep them in the home folder go to the run folder.
  assert.deepEqual(runFolderTools('/w/.voice-runs/alpha/84rf'), { WRANGLER_LOG_PATH: '/w/.voice-runs/alpha/84rf/wrangler-logs', WRANGLER_SEND_METRICS: 'false' })
})
