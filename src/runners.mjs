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

import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { log } from './log.mjs'

function run(command, args, timeout) {
  return new Promise(resolve => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr, error }))
  })
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export class HostRunner {
  constructor(root) {
    this.root = root
  }

  dir(name) {
    return join(this.root, name)
  }

  async names() {
    let entries = []
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
    } catch (error) {
      log('worker root unreadable:', this.root, error.message)
    }
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(this.root, e.name, '.git')))
      .map(e => e.name)
      .sort()
  }

  async git(dir, ...args) {
    const { ok, stdout } = await run('git', ['-C', dir, ...args], 10000)
    return ok ? stdout : null
  }

  // Detached: its own process group, so stopping it reaches the commands it
  // started, and a controller restart does not end it.
  spawn(taskId, command, args, { cwd, stdio, env }) {
    return spawn(command, args, { cwd, detached: true, stdio, env })
  }

  stop(task) {
    const signal = name => {
      try {
        process.kill(-task.pid, name)
      } catch {
        // already gone
      }
    }
    signal('SIGTERM')
    setTimeout(() => alive(task.pid) && signal('SIGKILL'), 5000).unref()
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

  // voice-run (docker/voice-run) hands the run its tokens and puts it in its
  // own process group, which voice-stop ends. The docker client here is
  // detached like a worker on the host, so a controller restart does not end it.
  spawn(taskId, command, args, { cwd, stdio, env }) {
    return spawn(
      this.dockerBin,
      ['exec', '-i', '-w', cwd, this.container, 'voice-run', taskId, command, ...args],
      { detached: true, stdio, env },
    )
  }

  stop(task) {
    this.exec(['voice-stop', task.id], 20000).then(({ ok, stderr }) => {
      if (!ok) log('voice-stop failed:', task.id, (stderr || '').trim().split('\n')[0])
      try {
        process.kill(-task.pid, 'SIGTERM') // the docker client, if it is still there
      } catch {
        // already gone
      }
    })
  }
}
