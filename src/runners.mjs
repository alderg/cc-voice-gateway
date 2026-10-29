// Where the workers' repositories are and where git and claude run for them:
// in the checkouts on this computer (HostRunner, the default), or in the
// worker container (DockerRunner, when VOICE_GW_DOCKER names one; see
// docker/). The gateway itself always runs here.
//
// In the container, the repositories live in a host folder mounted at /repos,
// written as your user. Still, git on this computer never runs in that folder:
// its config, hooks and fsmonitor come from the container's side. The gateway
// runs every git command there through docker exec, and changes reach a clean
// clone here as a bundle (scripts/fetch-from-container.sh).

import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { ROOT, config } from './config.mjs'
import { log } from './log.mjs'

function run(command, args, timeout) {
  return new Promise(resolve => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr, error }))
  })
}

// Whether a process still exists; EPERM means it does, as someone else's.
export function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// --- the processes of a run ---------------------------------------------------
//
// A run is more than its claude process: claude starts shells, tests and
// servers, some in a process group or session of their own, and some outlive
// the shell that started them, their parent then being init or systemd. So
// every run carries marks in its environment, which whatever it starts
// inherits: VOICE_GW_RUN (unique per run), VOICE_GW_TASK (its task id) and
// VOICE_GW_REPO (its checkout). On Linux the gateway finds a run's processes
// by them in /proc, besides its process group and the tree below it; on other
// systems only by the group and the tree (ps).

export const MARK = { run: 'VOICE_GW_RUN', task: 'VOICE_GW_TASK', repo: 'VOICE_GW_REPO' }

const PROC = existsSync('/proc/self/stat')
const BOOT = (() => {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return ''
  }
})()

// One process from /proc: { pid, ppid, pgid, start, ended }, start being
// the boot and the start time, which tell it from a later process with the
// same id; null when it is gone.
function procStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'latin1')
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
    return {
      pid: Number(pid),
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      start: `${BOOT}:${fields[19]}`,
      ended: fields[0] === 'Z' || fields[0] === 'X', // a zombie has ended, only its parent has not looked yet
    }
  } catch {
    return null
  }
}

// The marks in a process's environment; none where it cannot be read, as for
// another user's process.
function procMarks(pid) {
  let text
  try {
    text = readFileSync(`/proc/${pid}/environ`, 'utf8')
  } catch {
    return {}
  }
  const marks = {}
  if (!text.includes('VOICE_GW_')) return marks
  for (const entry of text.split('\0')) {
    for (const [key, name] of Object.entries(MARK)) if (entry.startsWith(`${name}=`)) marks[key] = entry.slice(name.length + 1)
  }
  return marks
}

// The start of a process, to recognise it later (Linux; null elsewhere).
export const startOf = pid => (PROC && pid ? (procStat(pid)?.start ?? null) : null)

const ticks = start => Number(String(start).split(':')[1])
const sameBoot = start => String(start).split(':')[0] === BOOT

// Whether the process started as pid is still there and has not ended. With
// its start known, a later process that got the same id does not count.
export function running(pid, start = null) {
  if (!alive(pid)) return false
  if (!PROC) return true
  const stat = procStat(pid)
  return Boolean(stat) && !stat.ended && (!start || stat.start === start)
}

// Every process that has not ended: { pid, ppid, pgid, start, marks }.
export function processList() {
  if (PROC) {
    const list = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const stat = procStat(name)
      if (stat && !stat.ended) list.push({ ...stat, marks: procMarks(name) })
    }
    return list
  }
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 5000 })
    return out
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(fields => fields.length >= 4 && !fields[3].startsWith('Z'))
      .map(([pid, ppid, pgid]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), start: null, marks: {} }))
  } catch {
    return []
  }
}

// The processes given and everything below them, without this gateway and
// the processes it runs under.
function withTree(roots, list) {
  const children = new Map()
  for (const p of list) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p.pid)
  }
  const found = new Set()
  const queue = [...roots]
  while (queue.length) {
    const pid = queue.pop()
    if (found.has(pid)) continue
    found.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  const parent = new Map(list.map(p => [p.pid, p.ppid]))
  for (let pid = process.pid, seen = 0; pid > 1 && seen < 1000; pid = parent.get(pid), seen++) found.delete(pid)
  return [...found]
}

// The processes of a run that are still there: its own, as long as it is the
// one that was started; the members of its process group, once its own has
// ended only those that started after it, and only while no other process
// has taken its id; those with its mark; and everything below them.
export function runProcesses(task, list = processList()) {
  const own = running(task.pid, task.pidStart)
  const taken = !own && list.some(p => p.pid === task.pid)
  const later = p =>
    !task.pidStart || !p.start || (sameBoot(p.start) && sameBoot(task.pidStart) && ticks(p.start) >= ticks(task.pidStart))
  const roots = []
  for (const p of list) {
    const member = Boolean(task.pid) && p.pgid === task.pid && (own || (!taken && later(p)))
    if ((p.pid === task.pid && own) || member || (task.mark && p.marks?.run === task.mark)) roots.push(p.pid)
  }
  return withTree(roots, list)
}

// Processes with the marks of a run in a checkout `inside` takes, of none of
// the runs in `known` (their VOICE_GW_RUN marks): a run that the gateway lost
// track of. Per run: [{ run, task, repo, pids }].
export function strayRuns(inside, known, list = processList()) {
  const runs = new Map()
  for (const p of list) {
    const { run, task, repo } = p.marks ?? {}
    if (!run || !repo || known.has(run) || !inside(repo)) continue
    if (!runs.has(run)) runs.set(run, { run, task: task ?? null, repo, roots: [] })
    runs.get(run).roots.push(p.pid)
  }
  return [...runs.values()].map(({ roots, ...stray }) => ({ ...stray, pids: withTree(roots, list) })).filter(stray => stray.pids.length)
}

// A signal to each of the processes; how many got it.
export function signalAll(pids, name) {
  let sent = 0
  for (const pid of pids) {
    try {
      process.kill(pid, name)
      sent++
    } catch {
      // gone meanwhile
    }
  }
  return sent
}

const under = root => repo => repo.startsWith(root.replace(/\/+$/, '') + '/')

export class HostRunner {
  constructor(root) {
    this.root = root
  }

  dir(name) {
    return join(this.root, name)
  }

  // The gateway's own checkout is left out: a run there could change the
  // gateway, the confine hook and controller/CLAUDE.md, which take effect at
  // the next start. Compared by device and inode, so a symlinked or
  // differently spelled root still finds it. VOICE_GW_WORKER_SELF=1 lists it.
  async names() {
    let entries = []
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
    } catch (error) {
      log('worker root unreadable:', this.root, error.message)
    }
    const self = config.workerSelf ? null : statSync(ROOT, { throwIfNoEntry: false })
    const isSelf = dir => {
      const stat = self && statSync(dir, { throwIfNoEntry: false })
      return Boolean(stat) && stat.dev === self.dev && stat.ino === self.ino
    }
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(this.root, e.name, '.git')))
      .filter(e => !isSelf(join(this.root, e.name)))
      .map(e => e.name)
      .sort()
  }

  async git(dir, ...args) {
    const { ok, stdout } = await run('git', ['-C', dir, ...args], 10000)
    return ok ? stdout : null
  }

  // Detached: its own process group, so stopping it reaches the commands it
  // started, and a controller restart does not end it. env carries the
  // run's marks (MARK).
  spawn(taskId, command, args, { cwd, stdio, env }) {
    return spawn(command, args, { cwd, detached: true, stdio, env })
  }

  // The kill switch stops the runs; there is no container here.
  async lockdown() {
    return true
  }

  async mounts() {
    return null
  }

  // Whether the run's own process is still there; cheap, for every poll.
  alive(task) {
    return running(task.pid, task.pidStart)
  }

  // Every process of the run that is still there.
  processes(task) {
    return runProcesses(task)
  }

  // A signal to every process of the run, and to its process group while its
  // own process is there. Escalating to SIGKILL is the caller's (Workers).
  stop(task, name = 'SIGTERM') {
    const pids = runProcesses(task)
    if (this.alive(task)) {
      try {
        process.kill(-task.pid, name)
      } catch {
        // gone meanwhile
      }
    }
    return signalAll(pids, name)
  }

  // Runs in the checkouts here that nobody follows (strayRuns).
  strays(known) {
    return PROC ? strayRuns(under(this.root), known) : []
  }

  stopStray(stray, name = 'SIGTERM') {
    signalAll(stray.pids, name)
  }
}

// Repository folders directly in $1 with a .git, one name per line.
const LIST_REPOS = 'for d in "$1"/*/; do [ -e "$d.git" ] && basename "$d"; done; true'

export class DockerRunner {
  constructor({ container, root = '/repos', dockerBin = 'docker' }) {
    this.container = container
    this.root = root
    this.dockerBin = dockerBin
  }

  dir(name) {
    return posix.join(this.root, name)
  }

  exec(args, timeout = 15000) {
    return run(this.dockerBin, ['exec', this.container, ...args], timeout)
  }

  async names() {
    const { ok, stdout, stderr, error } = await this.exec(['sh', '-c', LIST_REPOS, 'sh', this.root])
    if (!ok) {
      const why = (stderr || error?.message || '').trim().split('\n')[0]
      throw new Error(
        `The worker container ${this.container} does not answer (${why}). Start it with: docker start ${this.container}`,
      )
    }
    return stdout.split('\n').filter(Boolean).sort()
  }

  async git(dir, ...args) {
    const { ok, stdout } = await this.exec(['git', '-C', dir, ...args])
    return ok ? stdout : null
  }

  // Which host folder is mounted at /repos and as whom the container runs,
  // with what is not as it should be: { folder, user, warnings }.
  async check(uid = process.getuid(), gid = process.getgid()) {
    const inspected = await run(this.dockerBin, ['inspect', this.container], 15000)
    if (!inspected.ok) {
      const why = (inspected.stderr || inspected.error?.message || '').trim().split('\n')[0]
      return { folder: null, user: null, warnings: [`docker inspect failed (${why})`] }
    }
    let mount
    try {
      mount = (JSON.parse(inspected.stdout)[0]?.Mounts ?? []).find(m => m.Destination === this.root)
    } catch {
      mount = undefined
    }
    const id = await this.exec(['sh', '-c', 'echo "$(id -u):$(id -g)"'])
    const user = id.ok ? id.stdout.trim() : null
    const warnings = []
    if (!mount) warnings.push(`no host folder is mounted at ${this.root}`)
    else if (mount.Type !== 'bind') warnings.push(`${this.root} is a ${mount.Type}, not a host folder`)
    if (user && user !== `${uid}:${gid}`) {
      warnings.push(`it runs as ${user}, not as ${uid}:${gid}, so the files in the folder are not yours`)
    }
    return { folder: mount?.Type === 'bind' ? mount.Source : null, user, warnings }
  }

  // The kill switch: the container stops, and does not come back by itself.
  // Started again while locked (scripts/start-workers-container.sh), it gets
  // the repositories read-only.
  async lockdown() {
    await run(this.dockerBin, ['update', '--restart=no', this.container], 15000)
    const stopped = await run(this.dockerBin, ['stop', '--time', '10', this.container], 30000)
    return stopped.ok
  }

  // Whether the container runs, and whether /repos is writable in it.
  async mounts() {
    const inspected = await run(this.dockerBin, ['inspect', this.container], 15000)
    if (!inspected.ok) return null
    try {
      const [info] = JSON.parse(inspected.stdout)
      const mount = (info.Mounts ?? []).find(m => m.Destination === this.root)
      return { running: info.State?.Running !== false, writable: mount ? mount.RW !== false : null }
    } catch {
      return null
    }
  }

  // voice-run (docker/voice-run) hands the run its tokens, marks it with
  // VOICE_GW_TASK and puts it in its own process group, which voice-stop
  // ends with every process that has the mark. The docker client here is
  // detached like a worker on the host, so a controller restart does not end
  // it, and it carries the run's marks on this side; it lives as long as the
  // run's own process in the container (voice-run waits for it).
  spawn(taskId, command, args, { cwd, stdio, env }) {
    return spawn(
      this.dockerBin,
      ['exec', '-i', '-w', cwd, this.container, 'voice-run', taskId, command, ...args],
      { detached: true, stdio, env },
    )
  }

  // The docker client of the run.
  alive(task) {
    return running(task.pid, task.pidStart)
  }

  // On this side: the docker client of the run.
  processes(task) {
    return runProcesses(task)
  }

  // voice-stop in the container, which escalates to SIGKILL itself, then the
  // docker client, if it is still there. Not the client first: ending it
  // does not end the run in the container.
  stop(task, name = 'SIGTERM') {
    this.voiceStop(task.id).then(() => signalAll(runProcesses(task), name))
    return 1
  }

  voiceStop(taskId) {
    return this.exec(['voice-stop', taskId], 20000).then(({ ok, stderr }) => {
      if (!ok) log('voice-stop failed:', taskId, (stderr || '').trim().split('\n')[0])
    })
  }

  // Once the run's own process in the container has ended: whatever it left
  // running there.
  cleanup(task) {
    return this.voiceStop(task.id)
  }

  // Runs whose docker client here nobody follows.
  strays(known) {
    return PROC ? strayRuns(under(this.root), known) : []
  }

  stopStray(stray, name = 'SIGTERM') {
    if (stray.task) this.voiceStop(stray.task)
    signalAll(stray.pids, name)
  }
}
