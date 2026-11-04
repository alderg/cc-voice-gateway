// The kill switch's rule on writes outside the allowed folders, with its
// quarantine (guard.mjs): the first two invalid writes of a run that make a
// new plain file in a place that is not sensitive are moved into the
// quarantine folder once their call has ended, and the worker is told by the
// guard's hook; the third locks, and so does everything sensitive, at once.
// In a temporary home folder with a repositories folder: alpha is the run's
// repository, beta another one, cc-voice-gateway the gateway's checkout. The
// guard's hook itself runs as Claude Code runs it, with sh.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.VOICE_GW_LOG_FILE = ''
const { RunGuard, TOOL_START, guardHooks, toolStarts } = await import('../src/guard.mjs')
const { DockerRunner, HostRunner } = await import('../src/runners.mjs')
const { Workers } = await import('../src/workers.mjs')

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-quarantine-')))
after(() => rmSync(TMP, { recursive: true, force: true }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let homes = 0
// A home folder of its own for each run, so that files of one never meet another's.
function place() {
  const home = join(TMP, `home${++homes}`)
  const root = join(home, 'Developer')
  for (const dir of ['alpha/.git', 'beta/.git', 'cc-voice-gateway/.git', 'alpha/ws']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'alpha', 'ws', 'report.md'), 'report')
  return { home, root, alpha: join(root, 'alpha'), state: join(home, '..', `state${homes}`) }
}

// One run with the rule and its quarantine, call by call: a call's tool_use,
// what the call does on disk (effect), the hook's report and the result.
function session({ runner: given = null, killswitch = null, quarantine = true, task: more = {} } = {}) {
  const where = place()
  const host = new HostRunner(where.root)
  const runner = given?.(where) ?? {
    root: where.root,
    dir: name => join(where.root, name),
    git: async () => null,
    inspect: path => host.inspect(path),
    quarantine: (path, dest) => host.quarantine(path, dest),
  }
  const workers = new EventEmitter()
  const tripped = []
  const logged = []
  const warned = []
  const folder = join(where.state, 'quarantine')
  const guard = new RunGuard({
    workers,
    runner,
    killswitch: killswitch ?? { trip: event => tripped.push(event.reason), locks: () => true },
    quarantine: quarantine ? folder : null,
    home: where.home,
    temp: ['/nowhere/tmp'], // the test's folders are in the temporary folder
    gateway: join(where.root, 'cc-voice-gateway'),
    ghBin: '/bin/false',
    log: (...parts) => logged.push(parts.join(' ')),
  })
  guard.on('quarantined', (task, entry) => warned.push(entry))
  const notes = join(where.state, 'tasks', 'tq01.notes')
  const task = { id: 'tq01', repo: 'alpha', dir: where.alpha, slug: null, defaultBranch: 'main', startedAt: Date.now() - 1000, guardNotes: notes, ...more }
  workers.emit('started', task)
  let n = 0
  // A call that ends: what it does on disk, then its result.
  const call = async (command, { effect = null, name = 'Bash', input = null, error = false, report = null } = {}) => {
    const id = `toolu_${++n}`
    workers.emit('tool', task, { type: 'tool_use', id, name, input: input ?? (name === 'Bash' ? { command } : { file_path: command, content: 'x' }) })
    if (report) workers.emit('toolStart', task, { id, ...report })
    effect?.()
    workers.emit('toolResult', task, { id, error, text: '' })
    await decided()
    return id
  }
  const decided = async () => {
    const run = guard.runs.get(task.id)
    while (run?.deciding.size) await Promise.all([...run.deciding])
    await run?.mailbox
  }
  const notesText = () => (existsSync(notes) ? readFileSync(notes, 'utf8') : '')
  return { ...where, guard, task, tripped, logged, warned, folder, notes, notesText, call, end: async () => (await guard.ended(task), guard.close()) }
}

const make = (path, text = 'x') => () => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

test('the first two new files outside go to quarantine, the worker is told, the third locks', async () => {
  const s = session()
  const first = join(s.root, 'report-2026-10-31-end.md')
  await s.call('cp ws/report.md ../report-2026-10-31-end.md', { effect: make(first, 'report') })
  assert.deepEqual(s.tripped, [])
  assert.ok(!existsSync(first), 'moved away')
  const file = join(s.folder, 'tq01', '1-report-2026-10-31-end.md')
  assert.equal(readFileSync(file, 'utf8'), 'report')
  assert.deepEqual(
    s.task.quarantined.map(({ n, tool, path, file: to, command }) => ({ n, tool, path, file: to, command })),
    [{ n: 1, tool: 'toolu_1', path: first, file, command: '"cp ws/report.md ../report-2026-10-31-end.md"' }],
  )
  assert.equal(s.warned.length, 1, 'for the warning on Telegram')
  const record = JSON.parse(readFileSync(join(s.folder, 'tq01', 'quarantine.jsonl'), 'utf8'))
  assert.equal(record.path, first)
  assert.equal(record.command, '"cp ws/report.md ../report-2026-10-31-end.md"')
  assert.equal(record.worker, 'alpha')
  assert.ok(s.logged.some(line => line.includes(`moved ${first} to quarantine (${file}), invalid write 1 of the run`)), s.logged.join('\n'))
  assert.match(s.notesText(), /^The gateway's guard: the command "cp ws\/report\.md \.\.\/report-2026-10-31-end\.md" wrote .*report-2026-10-31-end\.md, outside your allowed folders\./)
  assert.match(s.notesText(), /after a cd, give writes absolute paths, and keep backups and copies inside these folders too\. The third invalid write of a run locks the kill switch/)
  assert.ok(!existsSync(`${s.notes}.wait`), 'the turn may end again')

  await s.call('echo hi > ~/notes.txt', { effect: make(join(s.home, 'notes.txt')) })
  assert.deepEqual(s.tripped, [])
  assert.ok(existsSync(join(s.folder, 'tq01', '2-notes.txt')))
  assert.match(s.notesText(), /This was the second invalid write of this run: the next one locks the kill switch/)

  await s.call('touch ~/Desktop/third.txt', { effect: make(join(s.home, 'Desktop', 'third.txt')) })
  assert.equal(s.tripped.length, 1)
  assert.match(s.tripped[0], /^write outside the allowed folders: "touch ~\/Desktop\/third\.txt" writes .*\/Desktop\/third\.txt: the third invalid write in one run, after 2 went to quarantine \(worker alpha, task tq01\)$/)
  await s.end()
})

test('a Write call that makes a new file outside goes to quarantine as a command does; an Edit locks', async () => {
  const s = session()
  const draft = join(s.home, 'draft.md')
  await s.call(draft, { name: 'Write', effect: make(draft) })
  assert.deepEqual(s.tripped, [])
  assert.match(s.notesText(), /^The gateway's guard: the Write tool wrote .*\/draft\.md, outside your allowed folders/)
  await s.call(join(s.home, 'old.md'), { name: 'Edit', input: { file_path: join(s.home, 'old.md'), old_string: 'a', new_string: 'b' } })
  assert.match(s.tripped[0], /Edit .*\/old\.md: it changes a file in place, which locks at once/)
  await s.end()
})

test('what locks at once, the first time: changes, removals, links, folders, sensitive places, and what the guard cannot pin down', async () => {
  const saved = process.env.PATH
  try {
    const cases = [
      ['echo x >> ~/log.txt', null, /: it appends to a file, which locks at once/],
      ['echo x | tee -a ~/log.txt', null, /: it appends to a file/],
      ['rm ~/old.txt', null, /: it removes or moves files away/],
      ['mv a.txt ~/a.txt', null, /: it moves files there/],
      ['mv ~/b.txt .', null, /b\.txt: it removes or moves files away/],
      ['mkdir ~/made', null, /: it makes a folder/],
      ['ln -s ws/report.md ~/link.md', null, /: it makes a link/],
      ['chmod +x ~/run.sh', null, /: it changes a mode or an owner/],
      ['sed -i s/a/b/ ~/notes.txt', null, /: it changes a file in place/],
      ['truncate -s 0 ~/big.log', null, /: it truncates a file/],
      ['cp ws/report.md ../beta/report.md', s => make(join(s.root, 'beta', 'report.md')), /beta\/report\.md, in a git repository, which locks at once/],
      ['echo x > ../beta/.git/config', null, /: a hidden file or folder, where settings, keys and configuration live/],
      ['cp hook.sh ../beta/.git/hooks/pre-push', null, /: a git hook, which locks at once/],
      ['cp x.js ../cc-voice-gateway/src/x.js', null, /: the gateway's own checkout/],
      ['cp rc ~/.profile', null, /\.profile: a hidden file or folder/],
      ['cp rc ~/profile', null, /: a shell profile or rc file/],
      ['echo key >> ~/.ssh/authorized_keys', null, /authorized_keys: it appends to a file/],
      ['cp key ~/.ssh/id_new', null, /\.ssh\/id_new: a hidden file or folder/],
      ['cp s.json ~/.claude/settings.json', null, /\.claude\/settings\.json: a hidden file or folder/],
      ['cp x.desktop ~/.config/autostart/x.desktop', null, /autostart\/x\.desktop: a hidden file or folder/],
      ['cp x.service ~/.config/systemd/user/x.service', null, /x\.service: a hidden file or folder/],
      ['cp ci.yml ~/proj/.github/workflows/ci.yml', null, /ci\.yml: a hidden file or folder/],
      ['cp ci ~/proj/Jenkinsfile', null, /Jenkinsfile: a CI workflow file/],
      ['cp x ~/hooks/post-merge', null, /post-merge: a hooks folder/],
      ['cp x.plist ~/Library/LaunchAgents/x.plist', null, /x\.plist: macOS's Library folder/],
      ['cp tool ~/bin/tool', null, /bin\/tool: a folder on the PATH/],
      ['cp tool /opt/tool', null, /\/opt\/tool: outside the home folder and the repositories folder/],
      ['cp ws/report.md ~/ghost.md', null, /ghost\.md, which is not there afterwards, so the guard cannot tell what it wrote, which locks at once/],
      ['cp -r ws ~/copied', s => () => mkdirSync(join(s.home, 'copied'), { recursive: true }), /copied, which is no plain file/],
      ['ln ws/report.md ~/hard.md', null, /: it makes a link/],
    ]
    for (const [command, effect, reason] of cases) {
      const s = session()
      process.env.PATH = `${join(s.home, 'bin')}:${saved}`
      await s.call(command, { effect: effect?.(s) })
      assert.equal(s.tripped.length, 1, `${command}: ${s.tripped.join(' | ')}`)
      assert.match(s.tripped[0], reason, command)
      assert.equal(s.task.quarantined, undefined, command)
      await s.end()
    }
  } finally {
    process.env.PATH = saved
  }
})

test('a file that was there before the call is changed, not made: it locks', async () => {
  const s = session({ task: { guardHooks: true } })
  const old = join(s.home, 'existing.txt')
  writeFileSync(old, 'mine')
  await sleep(1100)
  await s.call('cp ws/report.md ../../existing.txt', { report: { cwd: s.alpha, at: Date.now() }, effect: () => writeFileSync(old, 'report') })
  assert.match(s.tripped[0], /existing\.txt, which was there before: the command changed an existing file, which locks at once/)
  assert.ok(existsSync(old), 'left where it is')
  await s.end()
})

test('a gateway that takes the run over finds what an earlier one moved, kept with the task, and counts it', async () => {
  const s = session()
  const earlier = join(s.root, 'report.md')
  // As the earlier gateway left it: moved, and kept with the task.
  s.task.quarantined = [{ n: 1, tool: 'toolu_1', path: earlier, file: join(s.folder, 'tq01', '1-report.md'), command: '"cp ws/report.md ../report.md"', at: Date.now() }]
  await s.call('cp ws/report.md ../report.md') // read again: the file is gone, nothing to look at
  assert.deepEqual(s.tripped, [])
  assert.equal(s.notesText(), '', 'told before')
  await s.call('cp ws/report.md ~/second.md', { effect: make(join(s.home, 'second.md')) })
  assert.deepEqual(s.tripped, [])
  assert.equal(s.task.quarantined.at(-1).n, 2)
  await s.call('cp ws/report.md ~/third.md', { effect: make(join(s.home, 'third.md')) })
  assert.match(s.tripped[0], /the third invalid write in one run/)
  await s.end()
})

test('without a quarantine folder, or with the rules only logging, every invalid write locks as before and the file stays', async () => {
  const s = session({ quarantine: false })
  const file = join(s.root, 'x.md')
  await s.call('cp ws/report.md ../x.md', { effect: make(file) })
  assert.match(s.tripped[0], /^write outside the allowed folders: "cp ws\/report\.md \.\.\/x\.md" writes .*\/Developer\/x\.md \(worker alpha, task tq01\)$/)
  assert.ok(existsSync(file))
  await s.end()
  const reported = []
  const t = session({ killswitch: { trip: event => reported.push(event.reason), locks: () => false } }) // VOICE_GW_KILLSWITCH=manual
  const other = join(t.root, 'y.md')
  await t.call('cp ws/report.md ../y.md', { effect: make(other) })
  assert.match(reported[0], /writes .*\/Developer\/y\.md \(/)
  assert.ok(existsSync(other), 'nothing moved')
  await t.end()
})

test('a run that ends before the result of its call: the write is decided at the end', async () => {
  const s = session()
  const file = join(s.home, 'late.txt')
  s.guard.workers.emit('tool', s.task, { type: 'tool_use', id: 'toolu_late', name: 'Bash', input: { command: 'node gen.js > ~/late.txt' } })
  make(file)()
  await s.end()
  assert.deepEqual(s.tripped, [])
  assert.ok(existsSync(join(s.folder, 'tq01', '1-late.txt')))
})

test('in the container: the look and the move through docker exec and docker cp, the note too', async () => {
  // A stand-in for docker that runs what docker exec would run, here.
  const bin = join(TMP, 'docker-bin')
  mkdirSync(bin, { recursive: true })
  const docker = join(bin, 'docker')
  writeFileSync(
    docker,
    '#!/bin/sh\necho "$*" >> "$(dirname "$0")/calls.log"\ncmd=$1; shift\ncase "$cmd" in\n  exec) shift; exec "$@" ;;\n  cp) cp -- "${1#*:}" "$2" ;;\nesac\n',
  )
  chmodSync(docker, 0o755)
  const s = session({ runner: where => new DockerRunner({ container: 'workers', root: where.root, dockerBin: docker }) })
  const file = join(s.root, 'shared.md')
  await s.call('cp ws/report.md ../shared.md', { effect: make(file, 'shared') })
  assert.deepEqual(s.tripped, [])
  assert.equal(readFileSync(join(s.folder, 'tq01', '1-shared.md'), 'utf8'), 'shared')
  assert.ok(!existsSync(file))
  assert.match(s.notesText(), /^The gateway's guard: the command "cp ws\/report\.md \.\.\/shared\.md" wrote/)
  const calls = readFileSync(join(bin, 'calls.log'), 'utf8')
  assert.match(calls, /^exec workers sh -c f=\$1/m)
  assert.match(calls, new RegExp(`^cp workers:${file} `, 'm'))
  assert.match(calls, /^exec workers rm -f -- /m)
  // In a git repository of the container, the look says so.
  await s.call('cp ws/report.md ../beta/x.md', { effect: make(join(s.root, 'beta', 'x.md')) })
  assert.match(s.tripped[0], /beta\/x\.md, in a git repository/)
  await s.end()
})

// --- the guard's hook, as Claude Code runs it ------------------------------------

function hook(input, notes, { event = 'PostToolUse' } = {}) {
  const command = guardHooks(process.execPath)[event][0].hooks[0].command
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env: { ...process.env, VOICE_GW_GUARD_NOTES: notes } })
    let out = ''
    child.stdout.on('data', data => (out += data))
    child.on('error', reject)
    child.on('close', code => resolve({ code, out }))
    child.stdin.end(JSON.stringify({ hook_event_name: event, ...input }))
  })
}

test("the guard's hook: the folder a call starts in before it, the guard's notes after it, and before the turn ends", async () => {
  const dir = join(TMP, 'hook')
  mkdirSync(dir, { recursive: true })
  const notes = join(dir, 'notes')
  // PreToolUse: one line, which Claude Code shows the model nothing of.
  const before = await hook({ tool_name: 'Bash', tool_use_id: 'toolu_9', cwd: '/work/alpha/sub', agent_id: 'a7', tool_input: { command: "echo 'x'" } }, notes, { event: 'PreToolUse' })
  assert.equal(before.code, 0)
  assert.ok(before.out.startsWith(TOOL_START))
  const [report] = toolStarts(`noise\n${before.out}`)
  assert.equal(report.id, 'toolu_9')
  assert.equal(report.cwd, '/work/alpha/sub')
  assert.equal(report.agent, 'a7')
  assert.ok(Math.abs(report.at - Date.now()) < 5000)
  // PostToolUse and PostToolUseFailure: nothing without notes; with notes, all of them once.
  assert.equal((await hook({ tool_name: 'Bash' }, notes)).out, '')
  writeFileSync(notes, "The gateway's guard: one.\n\nThe gateway's guard: two.\n\n")
  const told = JSON.parse((await hook({ tool_name: 'Bash' }, notes)).out)
  assert.deepEqual(told, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: "The gateway's guard: one.\n\nThe gateway's guard: two." } })
  assert.ok(!existsSync(notes))
  assert.equal((await hook({ tool_name: 'Bash' }, notes)).out, '', 'once')
  writeFileSync(notes, "The gateway's guard: failed.\n")
  assert.equal(JSON.parse((await hook({ tool_name: 'Bash' }, notes, { event: 'PostToolUseFailure' })).out).hookSpecificOutput.hookEventName, 'PostToolUseFailure')
  // Stop: it waits while the guard decides, then the worker reads it before it ends.
  writeFileSync(`${notes}.wait`, '')
  setTimeout(() => {
    writeFileSync(notes, "The gateway's guard: late.\n")
    rmSync(`${notes}.wait`)
  }, 400)
  const started = Date.now()
  const stop = await hook({}, notes, { event: 'Stop' })
  assert.ok(Date.now() - started >= 350, 'it waited')
  assert.deepEqual(JSON.parse(stop.out), { decision: 'block', reason: "The gateway's guard: late." })
  assert.equal((await hook({ stop_hook_active: true }, notes, { event: 'Stop' })).out, '', 'the turn ends then')
  // The settings: before Bash and Write, after every tool, at the end.
  const hooks = guardHooks('/usr/bin/node')
  assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'])
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash|Write')
  assert.match(hooks.Stop[0].hooks[0].command, /^'\/usr\/bin\/node' -e '/)
  assert.ok(!hooks.Stop[0].hooks[0].command.slice(20, -1).includes("'"), 'one single-quoted script')
})

test("the run's result and worker_status say what went to quarantine, as a warning", () => {
  const root = join(TMP, 'result', 'Developer')
  mkdirSync(root, { recursive: true })
  const workers = new Workers({ root, stateDir: join(TMP, 'result', 'state') })
  try {
    const task = {
      id: 'tq02',
      repo: 'alpha',
      task: 'Write the report.',
      state: 'done',
      startedAt: Date.now() - 60000,
      finishedAt: Date.now(),
      steps: [],
      result: 'Done.',
      quarantined: [{ n: 1, tool: 'toolu_1', path: '/home/u/voice-scratch/report.md', file: '/gw/.state/quarantine/tq02/1-report.md', command: '"cp ws/report.md ../report.md"', at: Date.now() }],
    }
    const text = workers.resultText(task)
    assert.match(
      text,
      /^Warning: the run wrote 1 new file outside its allowed folders, and the gateway's guard moved it to quarantine as invalid writes: \/home\/u\/voice-scratch\/report\.md \(by "cp ws\/report\.md \.\.\/report\.md", now \/gw\/\.state\/quarantine\/tq02\/1-report\.md\)\. The third invalid write of a run locks the kill switch\. Tell the driver in a sentence, as a warning/m,
    )
    assert.ok(text.indexOf('Warning:') < text.indexOf('Result: Done.'), "the gateway's own lines first")
    assert.match(workers.taskLines('alpha', task).join('\n'), /^Warning: the run wrote 1 new file outside its allowed folders/m)
  } finally {
    workers.close()
  }
})

test('the guard\'s hook in a real shell line: Claude Code runs the command with sh, and the script survives the quoting', () => {
  const command = guardHooks(process.execPath).PreToolUse[0].hooks[0].command
  const out = execFileSync('sh', ['-c', command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_use_id: "toolu_'quoted'", cwd: "/work/it's here" }) }).toString()
  const [report] = toolStarts(out)
  assert.equal(report.id, "toolu_'quoted'")
  assert.equal(report.cwd, "/work/it's here")
})
