// Approval grants (approval-grants.mjs): the driver allows a kind of file
// write by one asker in one folder for a while, and the controller's hook
// answers such prompts itself. The driver asked in the car on 2026-11-05:
// "Dieser Prozess möchte in den nächsten 20 Minuten einige Schreibvorgänge
// machen. Willst du diese grundsätzlich erlauben, oder soll ich dich jedes
// Mal fragen?" That morning the controller's main session and a teammate
// wrote the hauswache project's memory files in ~/.claude/projects/…/memory
// five times, and every write asked, as Claude Code takes any path with a
// .claude segment for a sensitive file that only a hook's allow lets through.
// A grant there is a hole in that protection, so these tests try every way
// out of it that the path grants' tests try (grants.test.mjs), and more.
//
// In a temporary home folder with Claude Code's folder, a repositories folder
// (alpha and beta, and the gateway's checkout) and a plain folder outside.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.VOICE_GW_LOG_FILE = ''
const { ApprovalGrants, FILE_TOOLS, actorOf, actorText, projectName } = await import('../src/approval-grants.mjs')
const { GrantLedger, PathGrants } = await import('../src/grants.mjs')

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'voice-gw-approval-grants-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const MINUTE = 60 * 1000
let places = 0

// Claude Code's folder with the hauswache project's memory folder, the
// repositories folder, the gateway's checkout with its state and secrets, a
// plain folder outside, and a folder on the PATH.
function place() {
  const at = join(TMP, `place${++places}`)
  const home = join(at, 'home')
  const claude = join(home, '.claude')
  const root = join(home, 'Developer')
  // As Claude Code names a project's folder: the path it was started in, with "-" for "/" and ".".
  const mangled = root.replace(/[^A-Za-z0-9]/g, '-')
  const project = `${mangled}-hauswache`
  const memory = join(claude, 'projects', project, 'memory')
  mkdirSync(memory, { recursive: true })
  mkdirSync(join(claude, 'projects', `${mangled}-cc-voice-gateway`, 'memory'), { recursive: true })
  mkdirSync(join(claude, 'hooks'), { recursive: true })
  writeFileSync(join(memory, 'MEMORY.md'), '- index\n')
  for (const dir of ['alpha/.git', 'alpha/src', 'alpha/.github/workflows', 'alpha/vendor/lib/.git', 'beta/.git', 'cc-voice-gateway/.git', 'cc-voice-gateway/.state', 'cc-voice-gateway/.secrets', 'notes']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  const plain = join(at, 'srv', 'reports')
  mkdirSync(join(plain, '2026'), { recursive: true })
  mkdirSync(join(plain, '.cache'), { recursive: true })
  const bin = join(at, 'bin')
  mkdirSync(bin, { recursive: true })
  const outside = join(at, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  return { at, home, claude, root, project, memory, plain, bin, outside, gateway: join(root, 'cc-voice-gateway') }
}

// The grants over a place, with a ledger of their own; killswitch and
// standby as stand-ins the test may flip.
function grantsAt(p, { enabled = true, file = null, now = null } = {}) {
  const logged = []
  const log = (...parts) => logged.push(parts.join(' '))
  const ledger = new GrantLedger({ file, log, ...(now ? { now } : {}) })
  const pathGrants = new PathGrants({ home: p.home, root: p.root, gateway: p.gateway, guarded: [p.claude], pathEnv: p.bin, log })
  const killswitch = { locked: false }
  const standby = { active: false }
  const grants = new ApprovalGrants({
    ledger,
    pathGrants,
    home: p.home,
    claudeHome: p.claude,
    root: p.root,
    gateway: p.gateway,
    guarded: [join(p.gateway, '.state'), join(p.gateway, '.secrets')],
    pathEnv: p.bin,
    killswitch,
    standby,
    enabled,
    log,
  })
  return { grants, ledger, killswitch, standby, logged }
}

const controller = { who: 'controller' }
const teammate = (name, session = 'sess-1') => ({ who: 'teammate', name, session })
const agent = (id, name = 'Build daily portfolio report') => ({ who: 'agent', id, name })
const write = (file_path, actor = controller, tool = 'Write') => ({ tool, input: { file_path, content: 'x' }, actor })

test('what a grant could cover: a memory file of one project, a file in one repository, a file in one plain folder; the tightest folder, named for the driver', () => {
  const p = place()
  const { grants } = grantsAt(p)
  const memory = grants.target('Write', { file_path: join(p.memory, 'standort-tessin-bedigliora.md') })
  assert.deepEqual(memory.scope, { kind: 'memory', folder: p.memory, project: p.project, name: 'hauswache' })
  // MEMORY.md, the index the driver's sed changed that morning, by Edit.
  assert.equal(grants.target('Edit', { file_path: join(p.memory, 'MEMORY.md') }).scope.kind, 'memory')
  assert.deepEqual(grants.target('Edit', { file_path: join(p.root, 'alpha', 'src', 'app.js') }).scope, { kind: 'repo', folder: join(p.root, 'alpha'), name: 'alpha' })
  assert.deepEqual(grants.target('NotebookEdit', { notebook_path: join(p.plain, '2026', 'n.ipynb') }).scope, { kind: 'folder', folder: join(p.plain, '2026'), name: join(p.plain, '2026') })
  // The offer says it in a few words, with the asker.
  assert.equal(grants.offer(write(join(p.memory, 'a.md'), teammate('standorte-drive-3'))).text, 'writes to the memory files of hauswache by this subagent')
  assert.equal(grants.offer(write(join(p.root, 'beta', 'x.md'))).text, 'file writes in the repository beta by the controller session')
  assert.equal(grants.offer(write(join(p.memory, 'a.md'))).minutes, 20)
  // A project's name for the driver: the folder after the repositories folder or the home folder.
  assert.equal(projectName('-home-u-Developer-cc-voice-gateway', { root: '/home/u/Developer', home: '/home/u' }), 'cc-voice-gateway')
  assert.equal(projectName('-home-u-notes', { root: '/home/u/Developer', home: '/home/u' }), 'notes')
  assert.equal(projectName('-srv-x', { root: '/home/u/Developer', home: '/home/u' }), '-srv-x')
})

test('never covered: the shell and every tool but the file tools, settings, hooks, CLAUDE.md, .git, hidden files, the gateway, system folders, the PATH', () => {
  const p = place()
  const { grants } = grantsAt(p)
  const never = (tool, input, why) => {
    const target = grants.target(tool, input)
    assert.ok(target.never, `${tool} ${JSON.stringify(input)}: ${JSON.stringify(target)}`)
    if (why) assert.match(target.never, why)
    assert.equal(grants.offer({ tool, input, actor: controller }), null)
  }
  // Push, merge, delete, restart go through the shell or the gateway's tools.
  for (const tool of ['Bash', 'Monitor', 'WebFetch', 'mcp__claude-in-chrome__navigate', 'mcp__voice__delete_path', 'mcp__claude_ai_Gmail__send_email']) {
    never(tool, { command: 'gh pr merge 3 --repo driver/alpha --squash', file_path: join(p.memory, 'a.md') }, /only file writes/)
  }
  assert.deepEqual(FILE_TOOLS, ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  // Claude Code's own folder, but for the memory files of a project.
  never('Write', { file_path: join(p.claude, 'settings.json') }, /Claude Code's own folder/)
  never('Write', { file_path: join(p.claude, 'hooks', 'temp-allow.mjs') }, /Claude Code's own folder/)
  never('Write', { file_path: join(p.claude, 'projects', p.project, 'notes.md') })
  never('Write', { file_path: join(p.memory, 'sub', 'deeper.md') })
  never('Write', { file_path: join(p.memory, 'script.sh') })
  never('Write', { file_path: join(p.memory, '.hidden.md') })
  never('Write', { file_path: join(p.memory, 'CLAUDE.md') })
  never('Write', { file_path: join(p.home, '.claude.json') }, /hidden/)
  // Hidden files and folders anywhere else: settings, hooks, keys, git, CI.
  for (const path of [
    join(p.root, 'alpha', '.claude', 'settings.json'),
    join(p.root, 'alpha', '.claude', 'hooks', 'x.mjs'),
    join(p.root, 'alpha', '.git', 'hooks', 'pre-commit'),
    join(p.root, 'alpha', '.git', 'config'),
    join(p.root, 'alpha', '.github', 'workflows', 'ci.yml'),
    join(p.root, 'alpha', '.mcp.json'),
    join(p.root, 'alpha', '.env'),
    join(p.home, '.bashrc'),
    join(p.home, '.ssh', 'authorized_keys'),
    join(p.home, '.config', 'systemd', 'user', 'x.timer'),
    join(p.plain, '.cache', 'x'),
  ]) {
    never('Write', { file_path: path })
  }
  never('Edit', { file_path: join(p.root, 'alpha', 'CLAUDE.md') }, /instructions/)
  never('Edit', { file_path: join(p.root, 'alpha', 'src', 'AGENTS.md') }, /instructions/)
  // The gateway's checkout, its state and secrets.
  never('Write', { file_path: join(p.gateway, 'src', 'gateway.mjs') }, /gateway's own/)
  never('Write', { file_path: join(p.gateway, 'controller', 'CLAUDE.md') })
  // A git repository inside a repository.
  never('Write', { file_path: join(p.root, 'alpha', 'vendor', 'lib', 'x.js') }, /git repository inside alpha/)
  // System folders and the PATH.
  never('Write', { file_path: '/etc/crontab' }, /hidden|system/)
  never('Write', { file_path: '/usr/local/bin/x' }, /system/)
  never('Write', { file_path: join(p.bin, 'claude') }, /PATH/)
  // No absolute path.
  never('Write', { file_path: 'memory/a.md' }, /absolute/)
  never('Write', {}, /absolute/)
})

test('links and hard links: a .. after a link goes where the kernel takes it, a link that leads nowhere and a linked file are never covered', () => {
  const p = place()
  const { grants } = grantsAt(p)
  // A link in the memory folder that leads out, to a plain file elsewhere.
  symlinkSync(join(p.outside, 'secret.txt'), join(p.memory, 'linked.md'))
  assert.match(grants.target('Write', { file_path: join(p.memory, 'linked.md') }).never, /the file is a link/)
  // A folder link out of a repository: the file is where the link leads.
  symlinkSync(p.claude, join(p.root, 'alpha', 'src', 'claude'))
  assert.ok(grants.target('Write', { file_path: join(p.root, 'alpha', 'src', 'claude', 'settings.json') }).never)
  // A .. after a link goes up from where the link led: ../hooks is Claude Code's hooks folder.
  symlinkSync(join(p.claude, 'projects'), join(p.root, 'alpha', 'src', 'projects'))
  // (written out: join() would take the .. away before the kernel sees it)
  const after = `${join(p.root, 'alpha', 'src', 'projects')}/../hooks/h.mjs`
  assert.match(grants.target('Write', { file_path: after }).never, /Claude Code's own folder/)
  // Without the link the same .. stays in the repository.
  assert.equal(grants.target('Write', { file_path: `${join(p.root, 'alpha', 'src')}/../README.md` }).scope.kind, 'repo')
  // A link that leads nowhere.
  symlinkSync(join(p.at, 'gone'), join(p.root, 'alpha', 'src', 'gone'))
  assert.match(grants.target('Write', { file_path: join(p.root, 'alpha', 'src', 'gone', 'x.js') }).never, /leads nowhere/)
  // A file with a second hard link: the same file is elsewhere too.
  writeFileSync(join(p.outside, 'shared.md'), 'x')
  linkSync(join(p.outside, 'shared.md'), join(p.memory, 'shared.md'))
  assert.match(grants.target('Edit', { file_path: join(p.memory, 'shared.md') }).never, /hard link/)
  // A grant for the memory folder covers none of these.
  const { grant } = grants.fromApproval({ code: 'qwert', offer: grants.offer(write(join(p.memory, 'a.md'))) }, 20, 'voice')
  for (const path of [join(p.memory, 'linked.md'), join(p.memory, 'shared.md'), `${p.memory}/../../../settings.json`, `${p.memory}/../other.md`, after]) {
    assert.equal(grants.match(write(path)), null, path)
  }
  assert.equal(grants.match(write(join(p.memory, 'b.md'))), grant)
})

test('a grant covers only its asker, its tools and its folder: another subagent, the main session, another project or repository, the shell all still ask', () => {
  const p = place()
  const { grants, logged } = grantsAt(p)
  const asker = teammate('standorte-drive-3')
  const offer = grants.offer(write(join(p.memory, 'engelberg-moebel-raumreolon.md'), asker))
  const { grant } = grants.fromApproval({ code: 'hexqp', offer }, 20, 'voice')
  assert.match(grant.id, /^g[a-z0-9]{3}$/)
  assert.equal(grant.label, 'writes to the memory files of hauswache by the subagent standorte-drive-3')
  assert.deepEqual(grant.tools, FILE_TOOLS)
  assert.ok(logged.some(line => line.startsWith(`grant ${grant.id} made: writes to the memory files of hauswache by the subagent standorte-drive-3, until `)))
  // Its asker, a Write and an Edit there: allowed, counted.
  assert.equal(grants.allow(write(join(p.memory, 'standort-tessin-bedigliora.md'), asker)), grant)
  assert.equal(grants.allow(write(join(p.memory, 'MEMORY.md'), asker, 'Edit')), grant)
  assert.equal(grant.uses, 2)
  assert.ok(logged.some(line => line.startsWith(`permission allowed by grant ${grant.id} tool=Edit path=${join(p.memory, 'MEMORY.md')}`)))
  // Not another teammate, the same name in another session, the main session, an ordinary subagent.
  for (const other of [teammate('standorte-drive-4'), teammate('standorte-drive-3', 'sess-2'), controller, agent('aa442687c1e1c600b')]) {
    assert.equal(grants.match(write(join(p.memory, 'x.md'), other)), null, JSON.stringify(other))
  }
  // Not another project's memory, nor a repository, nor the shell.
  assert.equal(grants.match(write(join(p.claude, 'projects', `${p.root.replace(/[^A-Za-z0-9]/g, '-')}-cc-voice-gateway`, 'memory', 'x.md'), asker)), null)
  assert.equal(grants.match(write(join(p.root, 'alpha', 'src', 'x.js'), asker)), null)
  assert.equal(grants.match({ tool: 'Bash', input: { command: `printf x >> ${join(p.memory, 'MEMORY.md')}` }, actor: asker }), null)

  // An ordinary subagent by its id, which is new with every spawn.
  const sub = agent('a93a755244a630dc4')
  const subGrant = grants.fromApproval({ code: 'mteuh', offer: grants.offer(write(join(p.root, 'alpha', 'src', 'a.js'), sub)) }, 20, 'telegram').grant
  assert.equal(subGrant.label, 'file writes in the repository alpha by the subagent Build daily portfolio report')
  assert.equal(grants.match(write(join(p.root, 'alpha', 'README.md'), sub)), subGrant)
  assert.equal(grants.match(write(join(p.root, 'alpha', 'README.md'), agent('a4bb6e2c1e185aaa7'))), null)
  assert.equal(grants.match(write(join(p.root, 'beta', 'README.md'), sub)), null)
  assert.equal(grants.match(write(join(p.root, 'alpha', '.github', 'workflows', 'ci.yml'), sub)), null)

  // A plain folder: its subfolders too, never a hidden one there.
  const folder = grants.fromApproval({ code: 'dcura', offer: grants.offer(write(join(p.plain, 'a.md'))) }, 20, 'voice').grant
  assert.equal(folder.scope.folder, p.plain)
  assert.equal(grants.match(write(join(p.plain, '2026', 'nov.md'))), folder)
  assert.equal(grants.match(write(join(p.plain, '.cache', 'x'))), null)
  assert.equal(grants.match(write(join(p.at, 'srv', 'other.md'))), null)
})

test('asked ahead, with "any": the controller and every agent it starts; by project, repository or folder; never the gateway\'s checkout or a folder that is none', () => {
  const p = place()
  const { grants } = grantsAt(p)
  const ahead = args => grants.ahead({ minutes: 30, words: 'ja, alle erlauben', via: 'voice', ...args })
  const { grant } = ahead({ kind: 'memory', target: 'hauswache', agent: 'any' })
  assert.equal(grant.label, 'writes to the memory files of hauswache by the controller and every agent it starts')
  assert.equal(grant.words, 'ja, alle erlauben')
  assert.ok(Math.abs(grant.until - Date.now() - 30 * MINUTE) < 5000)
  for (const actor of [controller, teammate('x'), agent('a1')]) assert.equal(grants.match(write(join(p.memory, 'a.md'), actor)), grant)
  // A teammate's name: that one only, in whatever session of this gateway's.
  const named = ahead({ kind: 'repo', target: 'alpha', agent: 'research' }).grant
  assert.equal(grants.match(write(join(p.root, 'alpha', 'src', 'a.js'), teammate('research', 'sess-9'))), named)
  assert.equal(grants.match(write(join(p.root, 'alpha', 'src', 'a.js'), controller)), null)
  assert.equal(ahead({ kind: 'folder', target: p.plain, agent: 'controller' }).grant.scope.folder, p.plain)
  // What it refuses.
  assert.match(ahead({ kind: 'memory', target: 'nowhere', agent: 'any' }).why, /no project "nowhere"/)
  assert.match(ahead({ kind: 'repo', target: 'cc-voice-gateway', agent: 'any' }).why, /gateway's own checkout/)
  assert.match(ahead({ kind: 'repo', target: 'notes', agent: 'any' }).why, /no repository/)
  assert.match(ahead({ kind: 'repo', target: '../alpha', agent: 'any' }).why, /no repository/)
  assert.match(ahead({ kind: 'folder', target: p.home, agent: 'any' }).why, /home folder/)
  assert.match(ahead({ kind: 'folder', target: p.claude, agent: 'any' }).why, /hidden|gateway's own/)
  assert.match(ahead({ kind: 'folder', target: join(p.root, 'alpha'), agent: 'any' }).why, /repositories folder/)
  assert.match(ahead({ kind: 'settings', target: 'x', agent: 'any' }).why, /kind must be one of memory, repo, folder/)
  assert.match(ahead({ kind: 'memory', target: 'hauswache', agent: '' }).why, /agent is required/)
})

test('a while and a number of writes: 20 minutes by default, 5 to 120, at most 100 writes; it ends by itself, and none is ever extended', () => {
  const p = place()
  let now = Date.now()
  const { grants, ledger, logged } = grantsAt(p, { now: () => now })
  const offer = grants.offer(write(join(p.memory, 'a.md')))
  assert.equal(grants.minutes(undefined), 20)
  assert.equal(grants.minutes(1), 5)
  assert.equal(grants.minutes(500), 120)
  const { grant } = grants.fromApproval({ code: 'abcde', offer }, 20, 'voice')
  // The ledger's clock: the grant's end comes from the gateway's own clock, Date.now().
  assert.ok(Math.abs(grant.until - Date.now() - 20 * MINUTE) < 5000)
  assert.equal(grant.maxUses, 100)
  for (let i = 0; i < 99; i++) grants.allow(write(join(p.memory, `f${i}.md`)))
  assert.equal(grant.uses, 99)
  assert.ok(grants.allow(write(join(p.memory, 'last.md'))))
  assert.equal(grants.match(write(join(p.memory, 'one-more.md'))), null, 'used up')
  assert.ok(logged.some(line => line === `grant ${grant.id} ended (used 100 times, its most)`))
  // Another, then its time runs out.
  const second = grants.fromApproval({ code: 'bcdef', offer }, 5, 'voice').grant
  assert.notEqual(second.id, grant.id)
  assert.equal(grants.match(write(join(p.memory, 'a.md'))), second)
  now = second.until + 1
  assert.equal(grants.match(write(join(p.memory, 'a.md'))), null)
  assert.ok(logged.some(line => line === `grant ${second.id} ended (its time ran out)`))
  assert.deepEqual(ledger.lines(), [])
})

test('the kill switch, a standby and the setting off: nothing is allowed, offered or made', () => {
  const p = place()
  const { grants, killswitch, standby } = grantsAt(p)
  const offer = grants.offer(write(join(p.memory, 'a.md')))
  const { grant } = grants.fromApproval({ code: 'abcde', offer }, 20, 'voice')
  killswitch.locked = true
  assert.equal(grants.match(write(join(p.memory, 'a.md'))), null)
  assert.equal(grants.offer(write(join(p.memory, 'a.md'))), null)
  assert.match(grants.fromApproval({ code: 'x', offer }, 20, 'voice').why, /kill switch is locked/)
  assert.match(grants.ahead({ kind: 'memory', target: 'hauswache', agent: 'any', words: 'ja bitte', via: 'voice' }).why, /kill switch/)
  killswitch.locked = false
  standby.active = true
  assert.equal(grants.match(write(join(p.memory, 'a.md'))), null)
  assert.match(grants.fromApproval({ code: 'x', offer }, 20, 'voice').why, /standby/)
  standby.active = false
  assert.equal(grants.match(write(join(p.memory, 'a.md'))), grant, 'the gateway ends them in both (gateway.mjs); here only nothing is allowed meanwhile')
  const off = grantsAt(p, { enabled: false }).grants
  assert.equal(off.offer(write(join(p.memory, 'a.md'))), null)
  assert.match(off.fromApproval({ code: 'x', offer }, 20, 'voice').why, /VOICE_GW_APPROVAL_GRANTS=0/)
  // An approval that offers none.
  assert.match(grants.fromApproval({ code: 'x' }, 20, 'voice').why, /offers no grant/)
})

test('the ledger: kept in .state/grants.json, 0600; the controller\'s keep their time after a restart, a subagent\'s end; the lines for open_items; its path grants join a repository\'s folders', () => {
  const p = place()
  const file = join(p.at, 'state', 'grants.json')
  const first = grantsAt(p, { file })
  const offer = first.grants.offer(write(join(p.memory, 'a.md')))
  const mine = first.grants.fromApproval({ code: 'abcde', offer }, 20, 'voice').grant
  const theirs = first.grants.fromApproval({ code: 'bcdef', offer: first.grants.offer(write(join(p.memory, 'a.md'), teammate('t1'))) }, 20, 'voice').grant
  first.grants.allow(write(join(p.memory, 'a.md')))
  assert.equal((readFileSync(file).length > 0), true)
  assert.equal(statMode(file), 0o600)
  // The next start: as gateway.mjs does, a subagent's end, the controller's stay.
  const again = grantsAt(p, { file })
  again.ledger.endAll('the controller session restarted, and its subagents with it', grant => ['agent', 'teammate'].includes(grant.actor?.who))
  assert.deepEqual(again.ledger.active().map(grant => grant.id), [mine.id])
  assert.equal(again.ledger.get(theirs.id).endedWhy, 'the controller session restarted, and its subagents with it')
  const [line] = again.ledger.lines()
  assert.match(line, new RegExp(`^Grant ${mine.id}: writes to the memory files of hauswache by the controller session, until \\d\\d:\\d\\d, used once\\.$`))
  assert.equal(again.grants.match(write(join(p.memory, 'b.md'))).id, mine.id)
  // One ending, for all of them: the driver's "Freigaben zurücknehmen".
  assert.deepEqual(again.ledger.endAll('taken back in Telegram').map(grant => grant.id), [mine.id])
  assert.equal(again.grants.match(write(join(p.memory, 'b.md'))), null)
  // A path grant in the ledger joins a repository's standing folders, for one run or for all.
  const { ledger } = again
  const paths = new PathGrants({ setting: '', home: p.home, root: p.root, gateway: p.gateway, ledger, log: () => {} })
  ledger.add({ kind: 'path', actor: { who: 'worker', task: 't3cz' }, scope: { repo: 'alpha', folder: p.plain }, label: 'x', until: Date.now() + MINUTE })
  assert.deepEqual(paths.folders('alpha', { task: 't3cz' }), [p.plain])
  assert.deepEqual(paths.folders('alpha', { task: 'other' }), [])
  assert.deepEqual(paths.folders('beta', { task: 't3cz' }), [])
  // A file that is no ledger starts without grants.
  writeFileSync(file, 'nonsense')
  assert.deepEqual(grantsAt(p, { file }).ledger.active(), [])
})

test('who asked, from the hook: the main session, an ordinary subagent by its id, a teammate by its name and session', () => {
  assert.deepEqual(actorOf({ tool_name: 'Write' }), { who: 'controller' })
  assert.deepEqual(actorOf({ agent_id: 'aa44', agent_name: 'Research the redesign' }), { who: 'agent', id: 'aa44', name: 'Research the redesign' })
  assert.deepEqual(actorOf({ agent_id: 'astandorte-drive-3-6726', agent_name: 'standorte-drive-3', session_id: 'f8df' }, { teammate: true }), {
    who: 'teammate',
    name: 'standorte-drive-3',
    session: 'f8df',
  })
  assert.equal(actorText({ who: 'any' }), 'the controller and every agent it starts')
})

function statMode(file) {
  return statSync(file).mode & 0o777
}
