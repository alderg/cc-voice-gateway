// Approval grants: the driver allows a kind of write for a while, instead of
// answering each of the controller's Claude Code prompts one by one. The
// driver asked in the car: "Dieser Prozess möchte in den nächsten 20 Minuten
// einige Schreibvorgänge machen. Willst du diese grundsätzlich erlauben, oder
// soll ich dich jedes Mal fragen?"
//
// A grant is for one asker (the controller session, one subagent, one
// teammate, or with words asked ahead the controller and every agent it
// spawns), one class of tools (the file tools Write, Edit, MultiEdit and
// NotebookEdit; no shell, no browser, no other MCP tool), the tightest folder
// the prompt shows (the memory folder of one project in ~/.claude, one
// repository of the repositories folder, or one plain folder), and a while:
// 20 minutes by default, at most VOICE_GW_GRANT_MAX_MINUTES (120), and at most
// VOICE_GW_GRANT_MAX_USES uses (100). It is kept in the ledger the path
// grants share (grants.mjs, GrantLedger), kind "approval".
//
// Where it acts (seen with Claude Code 2.1.312, approval-grants report of
// 2026-11-05): for a path Claude Code holds sensitive, any path with a .claude
// or .git segment among them, only a PermissionRequest hook that answers allow
// lifts the prompt, and it has to answer every time; an allow rule, a
// PreToolUse allow, acceptEdits, added folders and the session rules a hook
// may return do not. So the controller's hook (controller/.claude/hooks/
// approval.mjs) asks the gateway about every prompt, the main session's
// included (approvals.mjs), and answers allow when a grant here covers it.
// That is a hole in Claude Code's own protection for exactly that prompt, so
// the check is strict, by the path as the kernel resolves it:
//
//   never   a path that is not absolute, a link that leads nowhere, the file
//           itself a link or no file, a file with more than one hard link,
//           a hidden file or folder anywhere in the path (.claude, .git,
//           .github, .ssh, .config, shell rc files, .mcp.json, .claude.json),
//           CLAUDE.md, CLAUDE.local.md and AGENTS.md, everything else in
//           Claude Code's folder (its settings, hooks, other projects' files),
//           the gateway's checkout, state, secrets and logs, the system's
//           folders and the folders on the PATH; and every tool but the file
//           tools, so push, merge, delete and restart, which take the shell
//           or the gateway's tools, never
//   memory  Write and Edit of a *.md file right in ~/.claude/projects/<one
//           project>/memory, the one hidden place, which the morning of
//           2026-11-05 asked about five times
//   repo    files in one repository of the repositories folder, not the
//           gateway's own, nothing hidden in it and no git repository inside
//   folder  files in one folder, checked as strictly as a path grant
//           (PathGrants.folderOf): not hidden, no system folder, not in the
//           repositories folder, no git repository
//
// Nothing grants itself anything: a grant comes only from the driver's yes to
// an approval that offered it (approve with grant_minutes by voice, "yes 20"
// in their Telegram chat), or from the controller's grant_approvals with the
// driver's words, checked as standing_order checks them. The scope comes from
// the prompt as Claude Code gave it, never from text an agent wrote, and a
// grant is never extended. The kill switch and a standby end every grant
// (gateway.mjs), and while either holds nothing is allowed or made here.

import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clock } from './limits.mjs'
import { log as defaultLog, preview } from './log.mjs'
import { physicalPath } from './grants.mjs'

export const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
export const GRANT_SCOPES = ['memory', 'repo', 'folder']
export const MIN_GRANT_MINUTES = 5

const GATEWAY = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
// Files Claude Code reads as instructions when it works in a folder.
const INSTRUCTION_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md'])
const REPO_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const PROJECT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,250}$/
const SYSTEM = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/snap',
  '/sys', '/usr', '/var/lib', '/var/spool', '/var/db', '/Applications', '/Library', '/System', '/cores',
  '/private/etc', '/private/var/db', '/private/var/spool',
]

const within = (path, folder) => path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`)
const real = path => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// The file a file tool's prompt is about, as Claude Code gives it.
export function filePathOf(input) {
  for (const key of ['file_path', 'notebook_path']) if (typeof input?.[key] === 'string' && input[key]) return input[key]
  return ''
}

// A project folder's name in Claude Code's projects folder, for the driver:
// the folder it was started in, after the repositories folder or the home
// folder: "-home-u-Developer-hauswache" is hauswache.
export function projectName(folder, { root = null, home = homedir() } = {}) {
  const mangled = path => String(path ?? '').replace(/[^A-Za-z0-9]/g, '-')
  for (const base of [root, home].filter(Boolean).map(mangled)) {
    if (folder.startsWith(`${base}-`) && folder.length > base.length + 1) return folder.slice(base.length + 1)
  }
  return folder
}

// Who asked, from the hook's input (approvals.mjs): the controller's main
// session, an ordinary subagent by its id, or a teammate by its name in this
// session. name: the agent's name or description from Claude Code's record.
export function actorOf({ agent_id, agent_name, agent_type, session_id } = {}, { teammate = false } = {}) {
  if (typeof agent_id !== 'string' || !agent_id) return { who: 'controller' }
  const name = preview(String(agent_name || agent_type || agent_id), 60)
  return teammate
    ? { who: 'teammate', name, ...(typeof session_id === 'string' && session_id ? { session: session_id } : {}) }
    : { who: 'agent', id: agent_id, name }
}

// The asker in a few words: "the subagent standorte-drive-3".
export function actorText(actor) {
  if (actor?.who === 'controller') return 'the controller session'
  if (actor?.who === 'any') return 'the controller and every agent it starts'
  return `the subagent ${actor?.name ?? 'without a name'}`
}

// Whether a grant's asker covers the one that asks now.
function actorCovers(granted, asking) {
  if (granted?.who === 'any') return true
  if (granted?.who !== asking?.who) return false
  if (granted.who === 'controller') return true
  if (granted.who === 'agent') return granted.id === asking.id
  return granted.name === asking.name && (!granted.session || granted.session === asking.session)
}

// What a grant of the scope allows, in a few words.
export function scopeText(scope) {
  if (scope.kind === 'memory') return `writes to the memory files of ${scope.name}`
  if (scope.kind === 'repo') return `file writes in the repository ${scope.name}`
  return `file writes in ${scope.folder}`
}

export class ApprovalGrants extends EventEmitter {
  // ledger: GrantLedger (grants.mjs). pathGrants: PathGrants, whose strict
  // check of a folder the folder kind uses. claudeHome: Claude Code's folder;
  // root: the repositories folder; gateway: the gateway's checkout; guarded:
  // its state, secrets and logs folders; pathEnv: the PATH. killswitch and
  // standby: while either holds, nothing is allowed or made. enabled: false
  // with VOICE_GW_APPROVAL_GRANTS=0, then the prompts ask as before.
  constructor({
    ledger,
    pathGrants = null,
    home = homedir(),
    claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    root = null,
    gateway = GATEWAY,
    guarded = [],
    pathEnv = process.env.PATH,
    killswitch = null,
    standby = null,
    enabled = true,
    defaultMinutes = 20,
    maxMinutes = 120,
    maxUses = 100,
    log = defaultLog,
  }) {
    super()
    this.ledger = ledger
    this.pathGrants = pathGrants
    this.home = real(home)
    this.claudeHome = real(claudeHome)
    this.root = root ? real(root) : null
    this.gateway = real(gateway)
    this.guarded = guarded.filter(dir => typeof dir === 'string' && dir.startsWith('/')).map(real)
    this.pathEnv = pathEnv
    this.killswitch = killswitch
    this.standby = standby
    this.enabled = enabled
    this.maxMinutes = Math.max(MIN_GRANT_MINUTES, Math.floor(maxMinutes))
    this.defaultMinutes = Math.min(Math.max(MIN_GRANT_MINUTES, Math.floor(defaultMinutes)), this.maxMinutes)
    this.maxUses = Math.max(1, Math.floor(maxUses))
    this.log = log
  }

  // Why nothing is allowed or made now, or null.
  closed() {
    if (!this.enabled) return 'approval grants are off (VOICE_GW_APPROVAL_GRANTS=0)'
    if (this.killswitch?.locked) return 'the kill switch is locked'
    if (this.standby?.active) return 'the gateway is in a standby'
    return null
  }

  active() {
    return this.ledger.active('approval')
  }

  // The folders on the PATH, but / and the home folder itself.
  pathFolders() {
    return String(this.pathEnv ?? '')
      .split(':')
      .map(dir => dir.replace(/(.)\/+$/, '$1'))
      .filter(dir => dir.startsWith('/') && dir !== '/' && dir !== this.home)
      .map(real)
  }

  // What a prompt of a file tool writes: { physical, scope } where a grant
  // could cover it, { physical, scope: null, why } where none of the kinds
  // fits, { never } where no grant may ever cover it.
  target(tool, input) {
    if (!FILE_TOOLS.includes(tool)) return { never: `only file writes (${FILE_TOOLS.join(', ')}) can be granted, not ${tool}` }
    const raw = filePathOf(input)
    if (!raw.startsWith('/') || raw.includes('\0')) return { never: 'it names no absolute path' }
    const physical = physicalPath(raw)
    if (!physical) return { never: 'a link that leads nowhere, or a path the gateway cannot follow' }
    let stat = null
    try {
      stat = lstatSync(raw)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return { never: `the gateway cannot look at it (${error.code})` }
    }
    if (stat?.isSymbolicLink()) return { never: 'the file is a link' }
    if (stat && !stat.isFile()) return { never: 'it is no file' }
    if (stat && stat.nlink > 1) return { never: 'a file with more than one hard link: the same file is elsewhere too' }
    const never = why => ({ never: why, physical })
    if (physical.split('/').includes('.git')) return never('a git folder')
    // The one hidden place: the memory files of one project.
    const projects = `${this.claudeHome}/projects/`
    if (physical.startsWith(projects)) {
      const [project, folder, file, ...more] = physical.slice(projects.length).split('/')
      if (!more.length && folder === 'memory' && PROJECT_NAME.test(project ?? '') && /^[^./][^/]*\.md$/i.test(file ?? '') && !INSTRUCTION_FILES.has(file.toLowerCase())) {
        return { physical, scope: { kind: 'memory', folder: `${projects}${project}/memory`, project, name: projectName(project, { root: this.root, home: this.home }) } }
      }
    }
    if (within(physical, this.claudeHome)) return never("Claude Code's own folder, apart from the memory files of a project")
    if (physical.split('/').some(part => part.startsWith('.'))) {
      return never('a hidden file or folder, where settings, hooks, keys and git live')
    }
    if (INSTRUCTION_FILES.has(basename(physical).toLowerCase())) return never('a file Claude Code reads as instructions')
    if ([this.gateway, ...this.guarded].some(dir => within(physical, dir))) return never("the gateway's own checkout, state or secrets")
    if (SYSTEM.some(dir => within(physical, dir))) return never('a system folder')
    if (this.pathFolders().some(dir => within(physical, dir))) return never('a folder on the PATH')
    // A repository of the repositories folder.
    if (this.root && physical.startsWith(`${this.root}/`)) {
      const [name, ...inside] = physical.slice(this.root.length + 1).split('/')
      const folder = `${this.root}/${name}`
      if (!inside.length) return never('no file in a repository')
      if (!REPO_NAME.test(name) || !existsSync(`${folder}/.git`)) {
        return { physical, scope: null, why: `${folder} is no repository of the repositories folder` }
      }
      if (this.nested(dirname(physical), folder)) return never(`a git repository inside ${name}`)
      return { physical, scope: { kind: 'repo', folder, name } }
    }
    // Else the folder the file is in, if it may be granted.
    const { folder, problem } = this.folderOf(dirname(physical))
    return problem ? { physical, scope: null, why: `${dirname(physical)} ${problem}` } : { physical, scope: { kind: 'folder', folder, name: folder } }
  }

  // A plain folder a grant may name: as strictly as a path grant's.
  folderOf(path) {
    if (!this.pathGrants) return { problem: 'cannot be granted here' }
    return this.pathGrants.folderOf(path)
  }

  // Whether a folder from dir up to, not including, top is a git repository.
  nested(dir, top) {
    for (let at = dir; at !== top && within(at, top); at = posix.dirname(at)) {
      if (existsSync(`${at}/.git`)) return true
    }
    return false
  }

  // Whether a grant covers a write to target (target()).
  covers(grant, target) {
    if (!target || target.never) return false
    const { kind, folder } = grant.scope
    if (kind === 'memory' || kind === 'repo') return target.scope?.kind === kind && target.scope.folder === folder
    if (kind !== 'folder' || !within(target.physical, folder) || target.physical === folder) return false
    const inside = posix.relative(folder, target.physical).split('/')
    return !inside.some(part => part.startsWith('.')) && !this.nested(dirname(target.physical), folder)
  }

  // Whether a grant covers a prompt, { tool, input, actor }: its tools, its
  // asker and its folder.
  coversPrompt(grant, prompt, target = this.target(prompt.tool, prompt.input)) {
    return grant.tools.includes(prompt.tool) && actorCovers(grant.actor, prompt.actor) && this.covers(grant, target)
  }

  // The grant that covers a prompt, { tool, input, actor }, or null.
  match(prompt) {
    if (this.closed()) return null
    const target = this.target(prompt.tool, prompt.input)
    if (target.never) return null
    return this.active().find(grant => this.coversPrompt(grant, prompt, target)) ?? null
  }

  // A prompt the hook asks about: the grant that allows it, counted, or null.
  allow(prompt, where = '') {
    const grant = this.match(prompt)
    if (!grant) return null
    this.ledger.use(grant)
    this.log(
      `permission allowed by grant ${grant.id}`,
      `tool=${prompt.tool}`,
      `path=${preview(filePathOf(prompt.input), 160)}`,
      `(${actorText(prompt.actor)}${where ? `, ${where}` : ''}; use ${grant.uses} of ${grant.maxUses})`,
    )
    return grant
  }

  // The grant a prompt could get, for the approval request to offer:
  // { scope, actor, minutes, text }, or null where none could cover it.
  offer(prompt) {
    if (this.closed()) return null
    const target = this.target(prompt.tool, prompt.input)
    if (target.never || !target.scope) return null
    const { kind, folder, name, project } = target.scope
    return {
      scope: { kind, folder, name, ...(project ? { project } : {}) },
      actor: prompt.actor,
      minutes: this.defaultMinutes,
      text: `${scopeText(target.scope)} by ${prompt.actor.who === 'controller' ? 'the controller session' : 'this subagent'}`,
    }
  }

  // Minutes as the driver said them, within MIN_GRANT_MINUTES and the most.
  minutes(value) {
    const n = Math.round(Number(value))
    return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : this.defaultMinutes, MIN_GRANT_MINUTES), this.maxMinutes)
  }

  make({ scope, actor, minutes, via, fromApproval = null, words = null, request = null }) {
    const until = Date.now() + this.minutes(minutes) * 60 * 1000
    const grant = this.ledger.add({
      kind: 'approval',
      actor,
      scope,
      tools: FILE_TOOLS,
      label: `${scopeText(scope)} by ${actorText(actor)}`,
      until,
      maxUses: this.maxUses,
      via,
      fromApproval,
      words,
      request,
    })
    this.log(
      `grant ${grant.id} made: ${grant.label}, until ${new Date(grant.until).toISOString()}, at most ${grant.maxUses} uses`,
      `(${via}${fromApproval ? `, with approval ${fromApproval}` : ''})`,
    )
    this.emit('made', grant)
    return grant
  }

  // The driver allowed an approval that offered a grant and chose the
  // minutes: { grant } or { why } none was made.
  fromApproval(permission, minutes, via) {
    const closed = this.closed()
    if (closed) return { why: closed }
    if (!permission?.offer) return { why: 'this approval offers no grant: only file writes in one folder can be granted' }
    const { scope, actor } = permission.offer
    return { grant: this.make({ scope, actor, minutes, via, fromApproval: permission.code }) }
  }

  // A grant the controller asks for ahead, on the driver's words, which the
  // caller checked: kind memory (target: a project's name, as "hauswache"),
  // repo (a repository's name) or folder (an absolute path); agent: "any",
  // "controller" or a teammate's name. { grant } or { why }.
  ahead({ kind, target, agent, minutes, words, via, request = null }) {
    const closed = this.closed()
    if (closed) return { why: closed }
    const scope = this.scopeOf(kind, String(target ?? '').trim())
    if (scope.why) return { why: scope.why }
    const name = String(agent ?? '').trim()
    if (!name) return { why: 'agent is required: "any", "controller" or a subagent\'s name' }
    const actor = name.toLowerCase() === 'any' ? { who: 'any' } : name.toLowerCase() === 'controller' ? { who: 'controller' } : { who: 'teammate', name: preview(name, 60) }
    return { grant: this.make({ scope, actor, minutes, via, words, request }) }
  }

  // The scope of a grant asked ahead, or { why }.
  scopeOf(kind, target) {
    if (!target) return { why: 'target is required' }
    if (kind === 'memory') {
      const projects = join(this.claudeHome, 'projects')
      let names = []
      try {
        names = readdirSync(projects).filter(name => PROJECT_NAME.test(name) && !name.startsWith('.'))
      } catch {
        // no projects yet
      }
      const found = names.filter(name => name === target || projectName(name, { root: this.root, home: this.home }) === target)
      if (found.length !== 1) {
        return { why: found.length ? `"${preview(target, 60)}" names ${found.length} projects: ${found.join(', ')}` : `no project "${preview(target, 60)}" in Claude Code's projects folder` }
      }
      const [project] = found
      if (!statSync(join(projects, project)).isDirectory() || lstatSync(join(projects, project)).isSymbolicLink()) return { why: `${project} is no folder` }
      return { kind, folder: `${projects}/${project}/memory`, project, name: projectName(project, { root: this.root, home: this.home }) }
    }
    if (kind === 'repo') {
      const folder = this.root ? `${this.root}/${target}` : ''
      if (!this.root || !REPO_NAME.test(target) || !existsSync(`${folder}/.git`) || lstatSync(folder).isSymbolicLink()) {
        return { why: `"${preview(target, 60)}" is no repository of the repositories folder` }
      }
      if (real(folder) === this.gateway) return { why: "the gateway's own checkout is never granted" }
      return { kind, folder, name: target }
    }
    if (kind === 'folder') {
      const { folder, problem } = this.folderOf(target)
      if (problem) return { why: `${preview(target, 120)} ${problem}` }
      return { kind, folder, name: folder }
    }
    return { why: `kind must be one of ${GRANT_SCOPES.join(', ')}` }
  }

  // One grant in a few words, with its end: for the answers.
  static text(grant, now = Date.now()) {
    return `${grant.id}: ${grant.label}, until ${clock(grant.until, now)}`
  }
}
