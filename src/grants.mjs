// Path grants: folders outside its repository that the driver lets a
// repository's workers write to, as in the repository itself, for the kill
// switch's rule on writes outside (guard.mjs). Only for runs on this computer:
// in the Docker container a path of this computer means nothing, so the guard
// and the workers leave the grants out there, and work folders have none.
//
// Standing grants are a setting, VOICE_GW_PATH_GRANTS, in .secrets/gateway.env
// or the environment: repository=folder, the entries separated by semicolons,
// several folders of one repository by commas, as in
//
//   VOICE_GW_PATH_GRANTS=hauswache=/srv/wyze-events;alpha=/data/a,/data/b
//
// They apply at the start and, from the settings file, at once while the
// gateway runs (live.mjs). Strict, so that a typo never lets more through:
// a repository name, and the absolute path of a folder that is there, taken
// by its real path (realpath); never / or a folder right below it, the home
// folder or one that holds it, a folder in or around the gateway's checkout,
// state or secrets, the repositories folder, the work folders' root or
// Claude Code's folder, a hidden folder or one in it, a system folder (/etc,
// /usr, /var/lib, …), macOS's ~/Library, a folder in or around one on the
// PATH, or a git repository or a folder in one. An entry that is none is
// ignored, with a log line.
//
// Within a grant, the rule's ordinary "outside" does not apply: a run may
// make, change and remove files and folders there, rmdir included, and its
// file edits count against the rule on many changes as in its repository.
// What is sensitive in itself still locks, there too (check): a hidden file
// or folder (a git hook with it), a git repository in the folder, a link made
// there, a path that leads out of the folder through a link (as the kernel
// resolves it, a .. after a link included) or through a link that leads
// nowhere, a file with more than one hard link, removing the granted folder
// itself or changing its mode, the gateway's checkout and a folder on the
// PATH. The crontab locks as before, whatever the grants.
//
// One check for every kind of grant (check), over the folders that hold for a
// run now (folders): grants the driver gives for one path, one run and a
// time, which a worker asks for and the driver confirms by voice (planned,
// never by the worker itself), would join the standing ones there.

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, posix, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log as defaultLog } from './log.mjs'

export const GRANTS_SETTING = 'VOICE_GW_PATH_GRANTS'

const GATEWAY = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
// The system's own folders, and everything in them, also by the real paths
// macOS gives some of them.
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

// The folders on the PATH, but / and the home folder itself.
const pathFolders = (home, pathEnv) =>
  String(pathEnv ?? '')
    .split(':')
    .map(dir => dir.replace(/(.)\/+$/, '$1'))
    .filter(dir => dir.startsWith('/') && dir !== '/' && dir !== home)

// The setting's entries, [{ repo, path }], and what is wrong with the rest.
export function parseGrants(text) {
  const entries = []
  const problems = []
  for (const raw of String(text ?? '').split(';')) {
    const entry = raw.trim()
    if (!entry) continue
    const at = entry.indexOf('=')
    const repo = at < 0 ? '' : entry.slice(0, at).trim()
    if (!REPO.test(repo)) {
      problems.push(`"${entry}" is no repository=folder`)
      continue
    }
    const paths = entry
      .slice(at + 1)
      .split(',')
      .map(path => path.trim())
      .filter(Boolean)
    if (!paths.length) problems.push(`"${entry}" names no folder`)
    for (const path of paths) entries.push({ repo, path })
  }
  return { entries, problems }
}

// A path as the kernel resolves it, from / on: through every link that is
// there, also before a .., which goes up from where the link led. With
// follow false, a link at its end stays as it is, as rm and rmdir take it.
// What is not there yet is taken as written; null where it cannot tell: a
// link that leads nowhere, a component it may not look at, or a .. after
// one that is not there.
export function physicalPath(raw, { follow = true } = {}) {
  const parts = String(raw).split('/').filter(part => part && part !== '.')
  let path = '/'
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '..') {
      path = posix.dirname(path)
      continue
    }
    const next = path === '/' ? `/${part}` : `${path}/${part}`
    let stat
    try {
      stat = lstatSync(next)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null
      const rest = parts.slice(i + 1)
      return rest.includes('..') ? null : posix.join(next, ...rest)
    }
    if (stat.isSymbolicLink() && (follow || i < parts.length - 1)) {
      try {
        path = realpathSync(next)
      } catch {
        return null
      }
    } else {
      path = next
    }
  }
  return path
}

export class PathGrants {
  // setting: VOICE_GW_PATH_GRANTS's text; home, root (the repositories
  // folder), gateway (its checkout), guarded (the gateway's state and
  // secrets folders, the work folders' root, Claude Code's folder): what no
  // grant may be in or around; pathEnv: the PATH.
  constructor({ setting = '', home = homedir(), root = null, gateway = GATEWAY, guarded = [], pathEnv = process.env.PATH, log = defaultLog } = {}) {
    this.home = real(home)
    this.root = root ? real(root) : null
    this.gateway = real(gateway)
    this.guarded = guarded.filter(dir => typeof dir === 'string' && dir.startsWith('/')).map(real)
    this.pathEnv = pathEnv
    this.log = log
    this.standing = new Map() // repository -> its granted folders, by their real paths
    this.set(setting)
  }

  // Takes the setting's text, in place of the grants before. Returns what
  // it ignored, each with why; the log names it too.
  set(text) {
    const { entries, problems } = parseGrants(text)
    const ignored = [...problems]
    const standing = new Map()
    for (const { repo, path } of entries) {
      const { folder, problem } = this.folderOf(path)
      if (problem) {
        ignored.push(`${repo}=${path} ${problem}`)
        continue
      }
      const folders = standing.get(repo) ?? []
      if (!folders.includes(folder)) standing.set(repo, [...folders, folder])
    }
    for (const why of ignored) this.log(`${GRANTS_SETTING}: ignored, ${why}`)
    this.standing = standing
    return ignored
  }

  // The real path of a folder a grant may name, or what is wrong with it.
  folderOf(path) {
    if (!path.startsWith('/')) return { problem: 'is no absolute path' }
    let folder
    try {
      folder = realpathSync(path)
      if (!statSync(folder).isDirectory()) return { problem: 'is no folder' }
    } catch {
      return { problem: 'is not there' }
    }
    const holds = dir => Boolean(dir) && within(dir, folder)
    const around = dir => Boolean(dir) && (holds(dir) || within(folder, dir))
    const where = folder === path ? '' : ` (${folder})`
    const problem =
      folder === '/' || folder.split('/').length <= 2
        ? 'is / or a folder right below it'
        : holds(this.home)
          ? 'is the home folder or holds it'
          : around(this.root)
            ? 'is in or around the repositories folder'
            : [this.gateway, ...this.guarded].some(around)
              ? "is in or around the gateway's own folders"
              : folder.split('/').some(part => part.startsWith('.'))
                ? 'is or lies in a hidden folder'
                : SYSTEM.some(dir => within(folder, dir))
                  ? 'is a system folder or lies in one'
                  : within(folder, `${this.home}/Library`)
                    ? "lies in macOS's Library folder"
                    : pathFolders(this.home, this.pathEnv).map(real).some(around)
                      ? 'is in or around a folder on the PATH'
                      : this.inRepository(folder, '/')
                        ? 'is or lies in a git repository'
                        : null
    return problem ? { problem: `${problem}${where}` } : { folder }
  }

  // Whether a folder, or one above it up to top, is a git repository.
  inRepository(dir, top) {
    for (let at = dir; ; at = posix.dirname(at)) {
      if (existsSync(`${at}/.git`)) return true
      if (at === top || at === '/') return false
    }
  }

  // The folders granted to a repository's runs now: the standing ones. run,
  // { task, at }, is for grants that hold for one run and a while.
  folders(repo, run = {}) {
    return this.standing.get(repo) ?? []
  }

  // The grants in a few words, for the log: "hauswache: /srv/wyze-events".
  text() {
    return [...this.standing].map(([repo, folders]) => `${repo}: ${folders.join(', ')}`).join('; ')
  }

  // A write of a run of the repository against its grants: null when it
  // lies in none; otherwise { folder, why }, why null where the grant lets
  // it, or why it still locks. path: the absolute path, as the guard
  // resolved it; raw: the same before .. and . were taken out, as the
  // kernel gets it; op: what the write does (guard.mjs, LOCKING_OPS, or
  // create).
  check(repo, path, op = 'create', raw = path, run = {}) {
    const folders = this.folders(repo, run)
    if (!folders.length) return null
    const physical = physicalPath(raw, { follow: op !== 'remove' })
    const named = folders.find(folder => within(path, folder))
    const folder = physical && folders.find(dir => within(physical, dir))
    const granted = dir => `${dir} granted to ${repo}`
    if (!folder) {
      if (!named) return null
      return {
        folder: named,
        why: physical
          ? `it leads out of ${granted(named)} through a link, to ${physical}`
          : `a link that leads nowhere, or a path the guard cannot follow, in ${granted(named)}`,
      }
    }
    const parts = posix.relative(folder, physical).split('/').filter(Boolean)
    const why =
      op === 'link'
        ? `it makes a link, also in ${granted(folder)}: a link could lead out of it`
        : !parts.length && (op === 'remove' || op === 'mode')
          ? `it removes ${folder} itself or changes its mode, the folder granted to ${repo}`
          : parts.some(part => part.startsWith('.'))
            ? `a hidden file or folder in ${granted(folder)}, where settings, keys and git hooks live`
            : this.inRepository(physical, folder)
              ? `a git repository in ${granted(folder)}`
              : op !== 'remove' && hardLinked(physical)
                ? `a file with more than one hard link in ${granted(folder)}: the same file is elsewhere too`
                : within(physical, this.gateway)
                  ? "the gateway's own checkout"
                  : pathFolders(this.home, this.pathEnv).includes(posix.dirname(physical))
                    ? 'a folder on the PATH'
                    : null
    return { folder, why }
  }
}

function hardLinked(path) {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && stat.nlink > 1
  } catch {
    return false
  }
}
