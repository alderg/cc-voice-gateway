// Path grants (grants.mjs, VOICE_GW_PATH_GRANTS): folders outside its
// repository that the driver lets one repository's workers on this computer
// write to as in the repository, for the kill switch's rule on writes outside
// (guard.mjs). On 2026-11-04 at 18:30 UTC the rule locked when the hauswache
// worker (task ttxw) removed its own empty test folders in the watcher's data
// folder: rmdir /srv/wyze-events/live/2026-11-04 /srv/wyze-events/live.
// In a temporary home folder with a repositories folder (alpha, the run's
// repository, beta another one) and a granted folder outside both.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.VOICE_GW_LOG_FILE = ''
const { RunGuard } = await import('../src/guard.mjs')
const { GRANTS_SETTING, PathGrants, parseGrants, physicalPath } = await import('../src/grants.mjs')
const { HostRunner } = await import('../src/runners.mjs')
const { SettingsWatcher } = await import('../src/live.mjs')
const { Workers, prompt } = await import('../src/workers.mjs')

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-grants-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

// The exact command of 2026-11-04.
const RMDIR = 'rmdir /srv/wyze-events/live/2026-11-04 /srv/wyze-events/live'

let places = 0
// A home folder, a repositories folder, a granted folder like the watcher's
// (with its log, a camera folder and a report), and a folder outside them all.
function place() {
  const at = join(TMP, `place${++places}`)
  const home = join(at, 'home')
  const root = join(home, 'Developer')
  for (const dir of ['alpha/.git', 'beta/.git', 'cc-voice-gateway/.git']) mkdirSync(join(root, dir), { recursive: true })
  const granted = join(at, 'srv', 'wyze-events')
  mkdirSync(join(granted, '2026', '11'), { recursive: true })
  mkdirSync(join(granted, 'berichte'), { recursive: true })
  writeFileSync(join(granted, 'index.jsonl'), '{"event":1}\n')
  writeFileSync(join(granted, 'berichte', 'tag.md'), 'old')
  const outside = join(at, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  return { at, home, root, granted, outside, gateway: join(root, 'cc-voice-gateway') }
}

// One run with the rule, call by call, with the grant alpha=<granted folder>
// unless setting says otherwise; repo: the run's repository.
function session({ repo = 'alpha', setting = null, runner: given = null, quarantine = true, limits = {} } = {}) {
  const where = place()
  const host = new HostRunner(where.root)
  const runner = given?.(where) ?? {
    root: where.root,
    dir: name => join(where.root, name),
    git: async () => null,
    inspect: path => host.inspect(path),
    quarantine: (path, dest) => host.quarantine(path, dest),
  }
  const logged = []
  const grants = new PathGrants({
    setting: setting?.(where) ?? `alpha=${where.granted}`,
    home: where.home,
    root: where.root,
    gateway: where.gateway,
    log: (...parts) => logged.push(parts.join(' ')),
  })
  const workers = new EventEmitter()
  const tripped = []
  const warned = []
  const guard = new RunGuard({
    workers,
    runner,
    killswitch: { trip: event => tripped.push(event.reason), locks: () => true },
    grants,
    quarantine: quarantine ? join(where.at, 'quarantine') : null,
    home: where.home,
    temp: ['/nowhere/tmp'], // the test's folders are in the temporary folder
    gateway: where.gateway,
    ghBin: '/bin/false',
    limits,
    log: (...parts) => logged.push(parts.join(' ')),
  })
  guard.on('quarantined', (task, entry) => warned.push(entry))
  const notes = join(where.at, 'tasks', 'tg01.notes')
  const task = { id: 'tg01', repo, dir: join(where.root, repo), slug: null, defaultBranch: 'main', startedAt: Date.now() - 1000, guardNotes: notes }
  workers.emit('started', task)
  let n = 0
  // A call that ends: what it does on disk, then its result.
  const call = async (command, { effect = null, name = 'Bash', input = null } = {}) => {
    const id = `toolu_${++n}`
    workers.emit('tool', task, { type: 'tool_use', id, name, input: input ?? (name === 'Bash' ? { command } : { file_path: command, content: 'x' }) })
    effect?.()
    workers.emit('toolResult', task, { id, error: false, text: '' })
    const run = guard.runs.get(task.id)
    while (run?.deciding.size) await Promise.all([...run.deciding])
    await run?.mailbox
  }
  const notesText = () => (existsSync(notes) ? readFileSync(notes, 'utf8') : '')
  return { ...where, grants, guard, task, tripped, warned, logged, notesText, call, end: async () => (await guard.ended(task), guard.close()) }
}

// What one command trips in a run of its own: the reasons.
async function trial(command, options = {}) {
  const s = session(options)
  const text = typeof command === 'function' ? command(s) : command
  await s.call(text)
  await s.end()
  return { reasons: s.tripped, warned: s.warned, s }
}

test("2026-11-04: the granted repository's run removes its empty test folders and writes in the granted folder, nothing locks and nothing goes to quarantine", async () => {
  const s = session({ limits: { maxEdits: 100 } })
  const live = join(s.granted, 'live')
  // The run makes its test folder, works in it, and removes it again.
  await s.call(`mkdir -p ${live}/2026-11-04`, { effect: () => mkdirSync(join(live, '2026-11-04'), { recursive: true }) })
  await s.call(`echo '{"event":2}' >> ${s.granted}/index.jsonl && touch ${live}/2026-11-04/cam1.jpg`)
  await s.call(`cd ${live}/2026-11-04 && cp ../../index.jsonl ./copy.jsonl && rm -f copy.jsonl cam1.jpg`)
  await s.call(`rmdir ${live}/2026-11-04 ${live}`, { effect: () => rmSync(live, { recursive: true }) })
  // Changes, moves and removals in place, by the file tools too.
  await s.call(`sed -i s/old/new/ ${s.granted}/berichte/tag.md && mv ${s.granted}/berichte/tag.md ${s.granted}/berichte/tag-1.md`)
  await s.call(join(s.granted, 'berichte', 'neu.md'), { name: 'Write' })
  await s.call(join(s.granted, 'index.jsonl'), { name: 'Edit', input: { file_path: join(s.granted, 'index.jsonl'), old_string: '1', new_string: '3' } })
  await s.call(`rm -rf ${s.granted}/2026/11 && chmod 600 ${s.granted}/index.jsonl`)
  // The run's own repository and run folder stay as they were.
  await s.call(`touch ${s.root}/alpha/README.md`)
  assert.deepEqual(s.tripped, [])
  assert.deepEqual(s.warned, [])
  assert.equal(s.task.quarantined, undefined)
  // A new file elsewhere still goes to quarantine, and the worker reads that it may write in the granted folder.
  await s.call(`touch ${s.home}/notes.txt`, { effect: () => writeFileSync(join(s.home, 'notes.txt'), 'x') })
  assert.equal(s.warned.length, 1)
  assert.match(s.notesText(), new RegExp(`Write only in the repository .*/alpha, the folders granted to this repository \\(${s.granted}\\) and the temporary folders`))
  await s.end()
  assert.deepEqual(s.tripped, [])
})

test('the same rmdir for another repository, or outside the granted folder, locks as before', async () => {
  // beta has no grant: the exact command of 2026-11-04 locks at once.
  const beta = await trial(RMDIR, { repo: 'beta' })
  assert.deepEqual(beta.reasons, [
    `write outside the allowed folders: "${RMDIR}" writes /srv/wyze-events/live/2026-11-04: it removes or moves files away, which locks at once (worker beta, task tg01)`,
  ])
  // alpha's grant is another folder: /srv/wyze-events itself is outside it.
  const alpha = await trial(RMDIR)
  assert.equal(alpha.reasons.length, 1)
  assert.match(alpha.reasons[0], /^write outside the allowed folders: "rmdir \/srv\/wyze-events\/live\/2026-11-04 \/srv\/wyze-events\/live" writes \/srv\/wyze-events\/live\/2026-11-04: it removes or moves files away/)
  // beta removing in alpha's granted folder.
  const foreign = await trial(s => `rmdir ${s.granted}/2026/11`, { repo: 'beta' })
  assert.match(foreign.reasons[0], /writes .*\/srv\/wyze-events\/2026\/11: it removes or moves files away, which locks at once \(worker beta/)
  // Next to the granted folder, and the folder above it.
  const next = await trial(s => `rm -f ${join(s.granted, '..')}/wyze-events.bak`)
  assert.match(next.reasons[0], /\/srv\/wyze-events\.bak: it removes or moves files away/)
  // Without the setting, as before this version.
  const none = await trial(s => `rmdir ${s.granted}/2026/11`, { setting: () => '' })
  assert.match(none.reasons[0], /it removes or moves files away, which locks at once \(worker alpha/)
})

test('.. and links that lead out of the granted folder still lock', async () => {
  // .. out of it, by its words.
  const up = await trial(s => `rm ${s.granted}/2026/../../../outside/secret.txt`)
  assert.match(up.reasons[0], /writes .*\/outside\/secret\.txt: it removes or moves files away/)
  // A link in it that leads out: through it, after a cd into it, and a .. after it, which the kernel takes from where the link led.
  const linked = s => symlinkSync(s.outside, join(s.granted, 'out'))
  for (const command of [
    s => `touch ${s.granted}/out/new.txt`,
    s => `rm ${s.granted}/out/secret.txt`,
    s => `cd ${s.granted}/out && touch ../escaped.txt`,
    s => `echo x > ${s.granted}/out/../escaped.txt`,
  ]) {
    const { reasons, warned } = await trial(s => (linked(s), command(s)))
    assert.equal(reasons.length, 1, String(command))
    assert.match(reasons[0], /: it leads out of .*\/srv\/wyze-events granted to alpha through a link, to .*\/(outside\/(new|secret)|escaped)\.txt, which locks at once/, reasons[0])
    assert.deepEqual(warned, [])
  }
  // The Write tool with a .. after the link.
  const s = session()
  linked(s)
  await s.call(`${s.granted}/out/../written.md`, { name: 'Write' })
  assert.match(s.tripped[0], /^write outside the allowed folders: Write .*\/srv\/wyze-events\/written\.md: it leads out of .* through a link/)
  await s.end()
  // A link that leads nowhere: the guard cannot tell where a write through it goes.
  const dangling = await trial(s => (symlinkSync(join(s.outside, 'gone'), join(s.granted, 'dangling')), `echo x > ${s.granted}/dangling`))
  assert.match(dangling.reasons[0], /a link that leads nowhere, or a path the guard cannot follow, in .* granted to alpha/)
  // Removing the link itself is a write in the granted folder; a link within it is fine.
  const removed = await trial(s => (linked(s), `rm ${s.granted}/out`))
  assert.deepEqual(removed.reasons, [])
  const inside = await trial(s => (symlinkSync(join(s.granted, '2026'), join(s.granted, 'current')), `touch ${s.granted}/current/11/x.jpg`))
  assert.deepEqual(inside.reasons, [])
})

test('what is sensitive in itself still locks in the granted folder', async () => {
  const cases = [
    [s => `echo KEY=1 > ${s.granted}/.env`, /a hidden file or folder in .*\/srv\/wyze-events granted to alpha/],
    [s => `mkdir -p ${s.granted}/.cache/x`, /a hidden file or folder in/],
    [s => (mkdirSync(join(s.granted, 'clone', '.git', 'hooks'), { recursive: true }), `touch ${s.granted}/clone/.git/hooks/post-checkout`), /a hidden file or folder in .*, where settings, keys and git hooks live/],
    [s => (mkdirSync(join(s.granted, 'clone', '.git'), { recursive: true }), `touch ${s.granted}/clone/src.js`), /a git repository in .*\/srv\/wyze-events granted to alpha/],
    [s => (mkdirSync(join(s.granted, 'clone', '.git'), { recursive: true }), `rm -rf ${s.granted}/clone`), /a git repository in/],
    [s => `ln -s ${s.outside} ${s.granted}/out`, /it makes a link, also in .* granted to alpha: a link could lead out of it/],
    [s => (linkSync(join(s.outside, 'secret.txt'), join(s.granted, 'hard.txt')), `echo x >> ${s.granted}/hard.txt`), /a file with more than one hard link in .*: the same file is elsewhere too/],
    [s => `rm -rf ${s.granted}`, /it removes .*\/srv\/wyze-events itself or changes its mode, the folder granted to alpha/],
    [s => `rmdir ${s.granted}`, /it removes .*\/srv\/wyze-events itself/],
    [s => `chmod 777 ${s.granted}`, /changes its mode/],
    [s => `rm -rf ${s.root}/beta/src`, /\/beta\/src: it removes or moves files away/],
    [() => 'crontab -r', /changes the crontab, which locks at once/],
  ]
  for (const [command, reason] of cases) {
    const { reasons, warned } = await trial(command)
    assert.equal(reasons.length, 1, `${command}: ${reasons.join(' | ')}`)
    assert.match(reasons[0], reason)
    assert.deepEqual(warned, [], 'never to quarantine')
  }
  // Without the quarantine, the reason is named all the same.
  const plain = await trial(s => `echo KEY=1 > ${s.granted}/.env`, { quarantine: false })
  assert.match(plain.reasons[0], /writes .*\/\.env: a hidden file or folder in .* granted to alpha/)
})

test('file edits in the granted folder count against the rule on many changes', async () => {
  const s = session({ limits: { maxEdits: 2 } })
  for (const name of ['a.md', 'b.md', 'c.md']) await s.call(join(s.granted, 'berichte', name), { name: 'Write' })
  assert.deepEqual(s.tripped, ['many changes: more than 2 file edits in one run (worker alpha, task tg01)'])
  await s.end()
})

test('in the container the grants count for nothing', async () => {
  const { reasons } = await trial(s => `rmdir ${s.granted}/2026/11`, {
    runner: where => ({ container: 'workers', root: where.root, dir: name => join(where.root, name), git: async () => null }),
    quarantine: false,
  })
  assert.match(reasons[0], /^write outside the allowed folders: "rmdir .*\/srv\/wyze-events\/2026\/11" writes .*\/srv\/wyze-events\/2026\/11 \(worker alpha, task tg01\)$/)
})

test('the setting: entries that are no folder a grant may name are ignored, with a log line, and let nothing through', async () => {
  const where = place()
  const repo = join(TMP, `repo${places}`)
  mkdirSync(join(repo, '.git', 'x'), { recursive: true })
  mkdirSync(join(repo, 'data'), { recursive: true })
  mkdirSync(join(where.at, '.hidden', 'data'), { recursive: true })
  mkdirSync(join(where.at, 'bin'), { recursive: true })
  mkdirSync(join(where.at, 'state'), { recursive: true })
  mkdirSync(join(where.at, 'gateway', 'src'), { recursive: true })
  symlinkSync(where.home, join(where.at, 'home-link'))
  const entries = {
    relative: 'srv/wyze-events',
    root: '/',
    top: '/usr',
    system: '/usr/share',
    home: where.home,
    holder: where.at,
    homeLink: join(where.at, 'home-link'),
    repositories: where.root,
    repository: join(where.root, 'beta'),
    inRepository: join(repo, 'data'),
    gitFolder: join(repo, '.git', 'x'),
    hidden: join(where.at, '.hidden', 'data'),
    gateway: join(where.at, 'gateway', 'src'),
    state: join(where.at, 'state'),
    pathFolder: join(where.at, 'bin'),
    file: join(where.granted, 'index.jsonl'),
    missing: join(where.at, 'missing'),
  }
  const logged = []
  const setting = [...Object.values(entries).map(path => `alpha=${path}`), 'not a name=/srv', 'beta', `hauswache=${where.granted},${where.granted}`].join(';')
  const grants = new PathGrants({
    setting,
    home: where.home,
    root: where.root,
    gateway: join(where.at, 'gateway'),
    guarded: [join(where.at, 'state')],
    pathEnv: `/usr/bin:${join(where.at, 'bin')}`,
    log: (...parts) => logged.push(parts.join(' ')),
  })
  assert.deepEqual(grants.folders('alpha'), [], 'none of them')
  assert.deepEqual(grants.folders('hauswache'), [where.granted], 'the valid one, once')
  assert.equal(grants.text(), `hauswache: ${where.granted}`)
  const why = {
    relative: 'is no absolute path',
    root: 'is / or a folder right below it',
    top: 'is / or a folder right below it',
    system: 'is a system folder or lies in one',
    home: 'is the home folder or holds it',
    holder: 'is the home folder or holds it',
    homeLink: `is the home folder or holds it (${where.home})`,
    repositories: 'is in or around the repositories folder',
    repository: 'is in or around the repositories folder',
    inRepository: 'is or lies in a git repository',
    gitFolder: 'is or lies in a hidden folder',
    hidden: 'is or lies in a hidden folder',
    gateway: "is in or around the gateway's own folders",
    state: "is in or around the gateway's own folders",
    pathFolder: 'is in or around a folder on the PATH',
    file: 'is no folder',
    missing: 'is not there',
  }
  for (const [name, path] of Object.entries(entries)) {
    assert.ok(logged.includes(`${GRANTS_SETTING}: ignored, alpha=${path} ${why[name]}`), `${name}: ${logged.join('\n')}`)
  }
  assert.ok(logged.includes(`${GRANTS_SETTING}: ignored, "not a name=/srv" is no repository=folder`))
  assert.ok(logged.includes(`${GRANTS_SETTING}: ignored, "beta" is no repository=folder`))
  assert.deepEqual(parseGrants(' hauswache = /srv/wyze-events ; alpha=/a, /b ;; ').entries, [
    { repo: 'hauswache', path: '/srv/wyze-events' },
    { repo: 'alpha', path: '/a' },
    { repo: 'alpha', path: '/b' },
  ])
  // A run of alpha with only ignored entries: the home folder is not granted.
  const { reasons } = await trial(s => `rm ${s.home}/old.txt`, { setting: s => `alpha=${s.home};alpha=relative` })
  assert.match(reasons[0], /old\.txt: it removes or moves files away, which locks at once/)
  // As the kernel resolves a path: links, also before a ..
  const s = place()
  symlinkSync(s.outside, join(s.granted, 'out'))
  assert.equal(physicalPath(`${s.granted}/out/../x`), join(s.at, 'x'))
  assert.equal(physicalPath(`${s.granted}/out`, { follow: false }), join(s.granted, 'out'))
  assert.equal(physicalPath(`${s.granted}/new/deeper/file`), join(s.granted, 'new', 'deeper', 'file'))
  assert.equal(physicalPath(`${s.granted}/new/../file`), null, 'a .. after what is not there')
})

test('the settings file while the gateway runs: a changed grant comes at once, the environment wins', () => {
  const file = join(TMP, 'live.env')
  writeFileSync(file, 'VOICE_GW_PORT=8787\n')
  const lines = []
  const watcher = new SettingsWatcher({ file, env: {}, limits: { VOICE_GW_MAX_WORKERS: 2, VOICE_GW_MAX_WORKERS_PER_REPO: 1 }, log: (...args) => lines.push(args.join(' ')) })
  writeFileSync(file, 'VOICE_GW_PORT=8787\nVOICE_GW_PATH_GRANTS=hauswache=/srv/wyze-events\n')
  const added = watcher.reload()
  assert.equal(added.grants, 'hauswache=/srv/wyze-events')
  assert.deepEqual(added.changed, {})
  assert.deepEqual(added.others, [], 'no restart needed')
  writeFileSync(file, 'VOICE_GW_PORT=8787\nVOICE_GW_PATH_GRANTS=hauswache=/srv/wyze-events\nVOICE_GW_MAX_WORKERS=3\n')
  assert.equal(watcher.reload().grants, undefined, 'unchanged')
  writeFileSync(file, 'VOICE_GW_PORT=8787\n')
  assert.equal(watcher.reload().grants, '', 'taken out: none')
  watcher.close()
  // Set from outside, the environment's value wins.
  writeFileSync(file, 'VOICE_GW_PATH_GRANTS=alpha=/data/a\n')
  const pinned = new SettingsWatcher({
    file,
    env: { VOICE_GW_PATH_GRANTS: 'alpha=/data/b' },
    limits: { VOICE_GW_MAX_WORKERS: 2, VOICE_GW_MAX_WORKERS_PER_REPO: 1 },
    log: (...args) => lines.push(args.join(' ')),
  })
  writeFileSync(file, 'VOICE_GW_PATH_GRANTS=alpha=/data/c\n')
  assert.equal(pinned.reload(), null)
  assert.ok(lines.some(line => /VOICE_GW_PATH_GRANTS changed in the settings file, but the environment sets it, which wins: the path grants stay as they are/.test(line)))
  pinned.close()
})

test('list_workers names the granted folder on its repository\'s line, and the worker\'s prompt names it', async () => {
  const where = place()
  execFileSync('git', ['init', '-q', '-b', 'main', join(where.root, 'alpha')])
  rmSync(join(where.root, 'beta'), { recursive: true })
  const grants = new PathGrants({ setting: `alpha=${where.granted}`, home: where.home, root: where.root, gateway: where.gateway, log: () => {} })
  const workers = new Workers({ root: where.root, stateDir: join(where.at, 'state'), grants })
  try {
    const list = await workers.listText()
    assert.match(list, new RegExp(`^alpha: no remote, may also write in ${where.granted} \\(path grant\\), branch main, `, 'm'))
    // In the container they count for nothing, so it names none.
    assert.deepEqual(workers.grantedFolders('alpha', { container: 'workers' }), [])
  } finally {
    workers.close()
  }
  const facts = { origin: null, visibility: 'private', branch: 'main', dirty: [], runFolder: null }
  const text = prompt({ task: 'Test the watcher live.', words: 'test the watcher', facts, grants: ['/srv/wyze-events'] })
  assert.match(text, /^- Granted folders: \/srv\/wyze-events, outside the repository\. The driver lets this repository's runs write there as in the repository: make, change and remove files and folders\. Not hidden files or folders, links or git repositories there, nor the granted folder itself/m)
  assert.doesNotMatch(prompt({ task: 'Fix it.', words: 'fix it', facts }), /Granted folders/)
})
