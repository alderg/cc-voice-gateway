// Workspaces: where a worker run works. A workspace has a name, a folder and
// a kind. The kind says which runner (runners.mjs) reaches its folders, on
// this computer or in a container, and which names are its own; Workers
// (workers.mjs) asks it for both, and checks before and after a run by the
// kind:
//
//   repo     a git repository directly in the worker root, on this computer
//            or in the worker container, named by its folder. One run at a
//            time. Before a run the gateway looks at uncommitted files, the
//            origin and the access level; after it, at git (Workers.audit),
//            and what is left becomes a push decision.
//   scratch  a work folder, only with VOICE_GW_SCRATCH=1: a new empty folder
//            per task under VOICE_GW_SCRATCH_ROOT, for what needs no
//            repository, such as a question to look up, research, a
//            calculation, a draft or a conversion. "scratch/new" makes one;
//            it is named scratch/<id> from then on, and a follow-up there
//            continues in the same folder and session, one run at a time.
//            New ones take any free run slot. No git, so no push decision:
//            after a run the gateway lists the files it made. The folder is
//            the run's only place to write (guard.mjs). Removed
//            VOICE_GW_SCRATCH_DAYS after its last run, never with 0.
//
// Task records and queue entries name their workspace in `repo` and `worker`,
// as before. A task record's `kind` says which kind it is; one without, from
// an older version, is a repository.

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { preview } from './log.mjs'

// The kind of a task record, or of a queue entry.
export const kindOf = record => record?.kind ?? 'repo'

// The repositories in the worker root, as the runner lists them.
export class Repositories {
  constructor(runner) {
    this.kind = 'repo'
    this.runner = runner
  }

  // Folder names have no slash; the names of every other kind have one.
  owns(name) {
    return typeof name === 'string' && name !== '' && !name.includes('/')
  }

  // Throws when the worker container does not answer.
  names() {
    return this.runner.names()
  }

  dir(name) {
    return this.runner.dir(name)
  }
}

// --- work folders -------------------------------------------------------------

// The name that makes a new work folder; the others are scratch/<id>.
export const SCRATCH_NEW = 'scratch/new'
const PREFIX = 'scratch/'
// What the state may hold: the id, and its folder, <date>-<id>, in the root.
const SCRATCH_ID = /^[a-z0-9]{4}$/
const SCRATCH_FOLDER = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/

export const scratchName = id => `${PREFIX}${id}`
export const scratchId = name => (typeof name === 'string' && name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null)

// The saved work folders that the gateway can use: { id: { folder,
// createdAt, usedAt } }, without a prototype. Anything else in the file, from
// an older version or edited by hand, is left out: a folder name from there
// could otherwise point anywhere.
export function scratchEntries(saved) {
  const entries = Object.create(null)
  for (const [id, entry] of Object.entries(saved ?? {})) {
    if (!SCRATCH_ID.test(id) || !SCRATCH_FOLDER.test(entry?.folder ?? '') || !entry.folder.endsWith(`-${id}`)) continue
    if (!Number.isFinite(entry.createdAt)) continue
    entries[id] = { folder: entry.folder, createdAt: entry.createdAt, usedAt: Number.isFinite(entry.usedAt) ? entry.usedAt : null }
  }
  return entries
}

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

// Symlinks resolved as far as the path exists.
function real(path) {
  const rest = []
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest.reverse())
    } catch {
      if (dirname(at) === at) return resolve(path)
      rest.push(at.slice(dirname(at).length).replace(/^[/\\]+/, ''))
    }
  }
}

// Why the root of the work folders is no place for them, or null: not an
// absolute path, the home folder itself, inside or around the gateway's
// checkout or the repositories folder, or inside a git repository (the
// nearest .git above it).
export function scratchProblem(root, { gateway, workerRoot = null, home = homedir() }) {
  if (!root || !isAbsolute(root)) return 'is not an absolute path'
  const path = real(root)
  if (path === real(home)) return 'is the home folder itself'
  for (const [what, other] of [
    ["the gateway's own checkout", gateway],
    ['the repositories folder (VOICE_GW_WORKER_ROOT)', workerRoot],
  ]) {
    if (!other) continue
    const place = real(other)
    if (inside(path, place)) return `is inside ${what}`
    if (inside(place, path)) return `holds ${what}`
  }
  for (let at = path; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return `is inside the git repository ${at}`
    if (dirname(at) === at) return null
  }
}

// Work folders: the kind, with its runner and its entries, which Workers keeps
// in its state (workers.json, under scratch).
export class ScratchFolders {
  // runner: on this computer a HostRunner on the root, in a container a
  // DockerRunner on the root's mount there; root: the folder on this
  // computer; days: how long one is kept after its last run, 0: for good.
  constructor({ runner, root, days = 60 }) {
    this.kind = 'scratch'
    this.runner = runner
    this.root = root
    this.days = days
    this.entries = Object.create(null) // id -> { folder, createdAt, usedAt }
  }

  // Every name with the prefix, so that one removed or mistyped is told so.
  owns(name) {
    return typeof name === 'string' && name.startsWith(PREFIX)
  }

  // scratch/new, then the work folders, the last used first.
  names() {
    const used = ([, entry]) => entry.usedAt ?? entry.createdAt
    const ids = Object.entries(this.entries)
      .sort((a, b) => used(b) - used(a))
      .map(([id]) => scratchName(id))
    return [SCRATCH_NEW, ...ids]
  }

  entry(name) {
    const id = scratchId(name)
    return id && Object.hasOwn(this.entries, id) ? this.entries[id] : null
  }

  // Where the runner reaches it, and where it is on this computer; null for
  // scratch/new and for names it does not know.
  dir(name) {
    const entry = this.entry(name)
    return entry ? this.runner.dir(entry.folder) : null
  }

  hostDir(name) {
    const entry = this.entry(name)
    return entry ? join(this.root, entry.folder) : null
  }

  // A new empty folder: { id, name, dir }, kept in the entries. The id is
  // one that neither the entries nor the root have.
  async make(newId, now = Date.now()) {
    const date = new Date(now).toISOString().slice(0, 10)
    for (let tries = 0; tries < 10; tries++) {
      const id = newId()
      if (Object.hasOwn(this.entries, id)) continue
      const folder = `${date}-${id}`
      if (!(await this.runner.makeDir(this.runner.dir(folder)))) continue
      this.entries[id] = { folder, createdAt: now, usedAt: null }
      return { id, name: scratchName(id), dir: this.runner.dir(folder) }
    }
    throw new Error(`no new work folder could be made in ${this.root}`)
  }

  // Removes the folder and its entry; false when the folder stays.
  async remove(name) {
    const dir = this.dir(name)
    if (!dir) return false
    if (!(await this.runner.remove(dir))) return false
    delete this.entries[scratchId(name)]
    return true
  }

  // Where its runs run, for the controller and the prompt.
  where() {
    return this.runner.container
      ? `in the container ${this.runner.container}, which sees only the work folders`
      : 'on this computer'
  }
}

// --- the run in a work folder -------------------------------------------------

export const SCRATCH_RULES = `
You are a worker. The driver of a car gave this task by voice; a controller session passed it on and will
summarise your result for them. Nobody can answer you during the run.

- If you need a decision, stop and end with the question and the options. The answer comes back as a
  follow-up in this session.
- Your work folder is the current directory, made empty for this task; a follow-up finds it as you left it.
  Every file you make goes there, scripts included; only temporary files may also go to /tmp. Never write
  to your home folder or anywhere else: the gateway stops all work when a run writes elsewhere.
- There is no repository here. Never push, never open pull requests or issues, and change nothing anywhere
  else: no installing software, no settings, no messages to anyone. Reading the web and running commands
  that only read are fine.
- Name the files you made or changed at the end, each with what it holds in a few words. The gateway lists
  them too.
- End with at most three short sentences for the controller: the result first, then the files, then what is
  open. No code blocks, no lists.
`.trim()

// What the worker reads on stdin in a work folder: the task in the
// controller's words, the driver's own words, and what the gateway knows of
// the folder. facts: { name, files (as runners' files()), made, where }.
export function scratchPrompt({ task, words, facts }) {
  const files = facts.files ?? []
  const shown = files.slice(0, 20).map(file => file.path).join(', ') + (files.length > 20 ? ', …' : '')
  return (
    [
      task.trim(),
      '',
      `The driver's own words: "${String(words ?? '').trim()}"`,
      '',
      'Checked by the gateway just now:',
      `- Work folder: ${facts.name}, ${facts.made ? 'new and empty' : files.length ? `with what earlier runs left: ${shown}` : 'empty'}`,
      `- It runs ${facts.where ?? 'on this computer'}.`,
    ].join('\n') + '\n'
  )
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`

// The names a check keeps of each kind of change; the counts are whole.
const KEPT = 20

// What a run changed in its work folder, from the files before and after it
// (runners' files()): the paths made, changed (size or time) and removed,
// the first KEPT of each, and how many of each there are. more: there were
// more files than a look lists.
export function fileChanges(before, after, max) {
  const was = new Map(before.map(file => [file.path, file]))
  const now = new Set(after.map(file => file.path))
  const made = after.filter(file => !was.has(file.path)).map(file => file.path)
  const changed = after
    .filter(file => was.has(file.path) && (was.get(file.path).bytes !== file.bytes || was.get(file.path).mtime !== file.mtime))
    .map(file => file.path)
  const removed = before.filter(file => !now.has(file.path)).map(file => file.path)
  return {
    made: made.slice(0, KEPT),
    changed: changed.slice(0, KEPT),
    removed: removed.slice(0, KEPT),
    counts: { made: made.length, changed: changed.length, removed: removed.length },
    more: after.length > max,
  }
}

// The look after a run in a few words, for the result event's files
// attribute: a fixed vocabulary, no file name, which the run chose.
export function filesSummary(check) {
  if (!check?.ok) return 'not checked'
  const { made, changed, removed } = check.counts
  const parts = []
  if (made) parts.push(`${plural(made, 'file')} made`)
  if (changed) parts.push(`${changed} changed`)
  if (removed) parts.push(`${removed} removed`)
  return parts.length ? parts.join(', ') + (check.more ? ', more not counted' : '') : 'nothing made or changed'
}

// The look as a line of the result event, with the names.
export function filesText(check) {
  if (!check) return null
  if (!check.ok) return 'Work folder check by the gateway: not possible, the folder could not be read.'
  const list = (paths, count) => preview(paths.slice(0, 8).join(', ') + (count > 8 ? ', …' : ''), 240)
  const { made, changed, removed } = check.counts
  const parts = []
  if (made) parts.push(`${plural(made, 'file')} made (${list(check.made, made)})`)
  if (changed) parts.push(`${changed} changed (${list(check.changed, changed)})`)
  if (removed) parts.push(`${removed} removed (${list(check.removed, removed)})`)
  if (check.more) parts.push('and more than it counts')
  return `Work folder check by the gateway: ${parts.length ? parts.join(', ') : 'no file made, changed or removed'}.`
}

// How long ago, roughly: minutes, hours, days.
export function age(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 90) return plural(Math.max(minutes, 0), 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 36) return plural(hours, 'hour')
  return plural(Math.round(hours / 24), 'day')
}
