// Cloning repositories into the worker root and deleting files and folders in
// it, by voice: the controller's tools clone_repo and delete_path, offered at
// the controller levels clone-delete and unrestricted
// (VOICE_GW_CONTROLLER_LEVEL), with workers on this computer only. The gateway
// does both itself, in code:
//
//   clone_repo   `gh repo clone` in the background, with your gh login; the
//                result reaches the controller as a channel event.
//   delete_path  first a plan, which says what would be lost (files, size,
//                uncommitted changes, commits on no remote) and deletes
//                nothing; then, with confirm, the deletion. The confine hook
//                makes Claude Code ask for an approval before every confirmed
//                call, and the channel relays it to the voice conversation.
//
// Both only on the driver's own words (channel.mjs), never while the kill
// switch is locked, never outside the worker root, never in the gateway's own
// checkout, and never in a repository while its worker runs. Symlinks are not
// followed: a link is deleted, not what it points to.

import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { ROOT } from './config.mjs'
import { log as defaultLog, preview } from './log.mjs'
import { WORKTREES } from './worktrees.mjs'

const CLONE_TIMEOUT_MS = 30 * 60 * 1000
const PLAN_VALID_MS = 15 * 60 * 1000 // a deletion needs a plan of the same path this recent
const MAX_COUNTED = 100000 // files counted for a plan before it says "more than"

// GitHub's rules for owner and repository names, roughly; never "." or "..".
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const inside = (path, root) => path === root || path.startsWith(root + sep)

function stop(child) {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

// "owner/name", a plain "name" (a repository of the gh login), or a GitHub
// URL. Returns { slug, name } or null.
export function parseRepo(text) {
  let value = String(text ?? '').trim()
  const url = /^(?:https?:\/\/github\.com\/|git@github\.com:|github\.com\/)([^/\s]+\/[^/\s]+?)\/?$/.exec(value)
  if (url) value = url[1]
  value = value.replace(/\.git$/, '')
  const parts = value.split('/')
  if (parts.length === 1 && NAME.test(parts[0])) return { slug: parts[0], name: parts[0] }
  if (parts.length === 2 && OWNER.test(parts[0]) && NAME.test(parts[1])) return { slug: value, name: parts[1] }
  return null
}

function git(dir, ...args) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { timeout: 15000 }, (error, stdout) => resolve(error ? null : stdout))
  })
}

const lines = text => (text ?? '').split('\n').filter(Boolean).length

// Files and bytes below a path, without following symlinks.
function measure(path) {
  let files = 0
  let bytes = 0
  const stack = [path]
  while (stack.length) {
    const current = stack.pop()
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      try {
        for (const entry of readdirSync(current)) stack.push(join(current, entry))
      } catch {
        // unreadable: counted as empty
      }
      continue
    }
    files++
    bytes += stat.size
    if (files >= MAX_COUNTED) return { files, bytes, more: true }
  }
  return { files, bytes, more: false }
}

export function size(bytes) {
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export class FolderTools extends EventEmitter {
  constructor({ root, workers = null, killswitch = null, ghBin = 'gh', self = ROOT, log = defaultLog }) {
    super()
    this.log = log
    this.root = root
    this.workers = workers // no deletion in a repository while its worker runs
    this.killswitch = killswitch
    this.ghBin = ghBin
    this.self = self // the gateway's own checkout: never deleted
    this.planned = new Map() // relative path -> when its plan was made
    this.cloning = new Map() // folder name -> child process
  }

  locked() {
    return this.killswitch?.locked ? { status: 'locked', state: this.killswitch.state } : null
  }

  // --- clone ----------------------------------------------------------------

  clone({ repo, folder }) {
    const locked = this.locked()
    if (locked) return locked
    const parsed = parseRepo(repo)
    if (!parsed) return { status: 'invalid', why: 'repo must be owner/name on GitHub, or a name of the gh login' }
    const name = String(folder ?? '').trim() || parsed.name
    if (!NAME.test(name)) return { status: 'invalid', why: `"${preview(name, 40)}" is no plain folder name` }
    let root
    try {
      root = realpathSync(this.root)
    } catch {
      return { status: 'invalid', why: 'the repositories folder does not exist' }
    }
    const dir = join(root, name)
    if (lstatSync(dir, { throwIfNoEntry: false }) || this.cloning.has(name)) return { status: 'exists', name }

    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }
    // In its own process group, so that stopping it reaches git too.
    const child = spawn(this.ghBin, ['repo', 'clone', parsed.slug, dir], {
      env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.cloning.set(name, child)
    let stderr = ''
    child.stderr.on('data', chunk => (stderr = (stderr + chunk).slice(-4000)))
    const timer = setTimeout(() => stop(child), CLONE_TIMEOUT_MS)
    let done = false
    const finish = async (ok, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      this.cloning.delete(name)
      // Whatever a failed clone left behind; the folder did not exist before.
      if (!ok) rmSync(dir, { recursive: true, force: true })
      const branch = ok ? (await git(dir, 'branch', '--show-current'))?.trim() || null : null
      this.log(`clone of ${parsed.slug} into ${name}:`, ok ? `done, branch ${branch ?? '?'}` : `failed, ${error}`)
      this.emit('cloned', { slug: parsed.slug, name, ok, branch, error: ok ? null : error })
    }
    child.on('error', error => finish(false, `could not start ${this.ghBin} (${error.code ?? error.message})`))
    child.on('close', (code, signal) => {
      const why = stderr.trim().split('\n').filter(Boolean).at(-1) || (signal ? `ended by ${signal}` : `exit code ${code}`)
      finish(code === 0, preview(why, 200))
    })
    this.log(`clone of ${parsed.slug} into ${name} started`)
    return { status: 'started', slug: parsed.slug, name }
  }

  // Clones still going end with the kill switch.
  stopAll() {
    for (const child of this.cloning.values()) stop(child)
  }

  // --- delete ---------------------------------------------------------------

  // Where a path relative to the worker root leads, and whether it may go.
  // The folder it sits in is resolved through symlinks; the last part is not.
  resolve(path) {
    const text = String(path ?? '').trim()
    if (!text || text.includes('\0') || isAbsolute(text) || text.startsWith('~')) {
      return { status: 'invalid', why: 'path must be relative to the repositories folder, for example "alpha/build"' }
    }
    const rel = normalize(text).replace(/\/+$/, '')
    if (rel === '.' || rel === '..' || rel.startsWith(`..${sep}`)) return { status: 'outside', path: text }
    let root
    try {
      root = realpathSync(this.root)
    } catch {
      return { status: 'invalid', why: 'the repositories folder does not exist' }
    }
    let parent
    try {
      parent = realpathSync(join(root, dirname(rel)))
    } catch {
      return { status: 'missing', path: rel }
    }
    if (!inside(parent, root)) return { status: 'outside', path: rel }
    const target = join(parent, basename(rel))
    const stat = lstatSync(target, { throwIfNoEntry: false })
    if (!stat) return { status: 'missing', path: rel }
    if (target === root) return { status: 'outside', path: rel }
    let self = this.self
    try {
      self = realpathSync(this.self)
    } catch {
      // not there: nothing to protect
    }
    if (inside(target, self) || inside(self, target)) return { status: 'self', path: rel }
    const shown = relative(root, target)
    // The worktrees of runs (worktrees.mjs) are in .voice-worktrees/<repository>/<id>:
    // busy while a run of that repository works in one.
    const parts = shown.split(sep)
    const inWorktrees = parts[0] === WORKTREES
    const repo = inWorktrees ? (parts[1] ?? null) : parts[0]
    const running = this.workers
      ?.running()
      .find(task => (inWorktrees ? Boolean(task.worktree) && (!repo || task.repo === repo) : task.repo === repo))
    if (running || (repo && (this.workers?.starting?.has(repo) || this.cloning.has(repo)))) {
      return { status: 'busy', path: shown, repo: repo ?? WORKTREES, task: running?.id ?? null }
    }
    const top = inWorktrees ? parts.slice(0, 3).join(sep) : repo
    return { status: 'ok', path: shown, target, stat, repo: join(root, top) }
  }

  async plan(path) {
    const locked = this.locked()
    if (locked) return locked
    const found = this.resolve(path)
    if (found.status !== 'ok') return found
    const { target, stat } = found
    const facts = { status: 'plan', path: found.path }
    if (stat.isSymbolicLink()) facts.kind = 'link'
    else if (!stat.isDirectory()) facts.kind = 'file'
    else facts.kind = lstatSync(join(target, '.git'), { throwIfNoEntry: false }) ? 'repository' : 'folder'
    if (stat.isDirectory()) Object.assign(facts, measure(target))
    else Object.assign(facts, { files: 1, bytes: stat.size, more: false })

    if (facts.kind === 'repository') {
      const [status, remotes, unpushed, stashes] = await Promise.all([
        git(target, 'status', '--porcelain'),
        git(target, 'remote'),
        git(target, 'log', '--branches', '--not', '--remotes', '--oneline'),
        git(target, 'stash', 'list'),
      ])
      facts.git = { dirty: lines(status), remotes: lines(remotes), unpushed: lines(unpushed), stashes: lines(stashes) }
    } else if (found.repo !== target && lstatSync(join(found.repo, '.git'), { throwIfNoEntry: false })) {
      // Inside a repository: what git knows about it there.
      const rel = relative(found.repo, target)
      const [tracked, status] = await Promise.all([
        git(found.repo, 'ls-files', '--', rel),
        git(found.repo, 'status', '--porcelain', '--', rel),
      ])
      facts.inRepo = { repo: basename(found.repo), tracked: lines(tracked), dirty: lines(status) }
    }
    this.planned.set(found.path, Date.now())
    return facts
  }

  remove(path) {
    const locked = this.locked()
    if (locked) return locked
    const found = this.resolve(path)
    if (found.status !== 'ok') return found
    const at = this.planned.get(found.path)
    if (!at || Date.now() - at > PLAN_VALID_MS) return { status: 'unplanned', path: found.path }
    this.planned.delete(found.path)
    try {
      rmSync(found.target, { recursive: true, maxRetries: 2 })
    } catch (error) {
      this.log(`delete of ${found.path} failed:`, error.message)
      return { status: 'failed', path: found.path, why: error.code ?? error.message }
    }
    this.log(`deleted ${found.path} in the repositories folder`)
    return { status: 'deleted', path: found.path }
  }
}

// The channel event when a clone has ended.
export function clonedText({ slug, name, ok, branch, error }) {
  return ok
    ? `The clone of ${slug} is done: folder ${name} in the repositories folder, on branch ${branch ?? 'unknown'}. ` +
        `Its worker is "${name}".`
    : `The clone of ${slug} into ${name} failed: ${error}`
}
