// Workers: headless Claude Code runs in the git repositories next to this one
// (~/Developer by default), started by the controller through the channel
// tools list_workers, dispatch, worker_status and stop_worker. Optionally they
// run in a Docker container with its own clones instead (runners.mjs), with
// an access level per repository that the GitHub token decides (access.mjs).
//
// Each task is one `claude -p` run in the repository's checkout, without
// approvals. A follow-up resumes the repository's last Claude session, so the
// worker keeps its context. Runs are detached and write stream-json to
// .state/tasks/<id>.jsonl, so they survive a gateway restart, which comes with
// every controller restart; the gateway follows the file and the process id.
//
// The gateway checks the checkout before a run (uncommitted files, a run
// already going, the cap on parallel runs) in code, not in the worker's
// instructions. What the worker does with git is up to its instructions.
//
// The run output holds every tool input and result, so .state/tasks and
// .state/workers.json are for this user only (folders 0700, files 0600).

import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { log, preview } from './log.mjs'
import { HostRunner, alive } from './runners.mjs'

const POLL_MS = 1000
const GITHUB_CACHE_MS = 10 * 60 * 1000 // what gh says about a repository
const MAX_STEPS = 5
const KEEP_TASKS = 40
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

// Claude Code sets these for its own child processes, the gateway included. A
// worker must not look like part of the controller session, and must not reach
// its messaging socket.
const SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PROJECT_DIR',
  'AI_AGENT',
]

// Beyond the repository: the Claude account's connectors (Gmail, Slack, ...),
// other sessions, scheduled and remote agents. And nobody can fill in a form
// during a run.
export const WORKER_DENY = [
  'mcp__claude_ai_*',
  'SendMessage',
  'ListAgents',
  'RemoteTrigger',
  'CronCreate',
  'Artifact*',
  'Workflow',
  'Monitor',
  'EnterWorktree',
  'AskUserQuestion',
  'EnterPlanMode',
]

export const WORKER_RULES = `
You are a worker. The driver of a car gave this task by voice; a controller session passed it on and will
summarise your result for them. Nobody can answer you during the run.

- If you need a decision, stop and end with the question and the options. The answer comes back as a
  follow-up in this session.
- Git: start from the branch the checkout is on (named in the task; it may be dev rather than main). For
  changes, create a branch voice/<short-name> and commit there. Commit only your own changes: never commit,
  stash, reset or discard files you did not change. Never commit to the starting branch or the default
  branch. Never force-push, merge or delete branches. A follow-up continues on the same voice branch.
- Publish: push the branch and open a draft pull request against the starting branch with
  gh pr create --draft. If the task says the repository is public or its visibility is unknown, do not push:
  commit, then end by asking whether to publish, and push only in a follow-up after a yes. If the push is
  rejected, say so and do not fork. Without a remote, only commit.
- At the end, switch back to the starting branch, so the checkout is as the driver left it.
- Run the tests that cover your change. Tasks that change nothing, such as questions or test runs, need no
  branch.
- Review requests, only when the task asks for one: if it names a person, add them as reviewer with
  gh pr edit --add-reviewer. Otherwise review the pull request's diff yourself and post your findings as one
  pull request review with gh api (event COMMENT, comments inline on the changed lines where possible, the
  rest in the review body), and report how many findings you posted. If the pull request is a draft and that
  blocks it, do not mark it ready yourself: end by asking whether to.
- Review comments, only when the task asks to fix them: read the open review threads and review bodies (gh
  pr view --comments, and gh api graphql for the unresolved reviewThreads), fix what they ask for, run the
  tests, commit and push to the same branch, and reply in one sentence on each thread you addressed. Report
  what you fixed and what you left open, and why.
- End with at most three short sentences for the controller: the result first, then the branch or pull
  request, with the pull request's URL if you opened or updated one, then what is open. No code blocks, no
  lists.
`.trim()

// In the Docker container, the Git and Publish rules follow the repository's
// access level (access.mjs); the prompt names the level and why.
const CONTAINER_RULES = {
  'read-only': {
    Git: `- Git: you work in a container with clones of the driver's repositories, without write access to
  GitHub. Start from the branch the checkout is on (named in the task). For changes, create a branch
  voice/<short-name> and commit there; local worktrees are fine. Commit only your own changes: never commit,
  stash, reset or discard files you did not change. Never commit to the starting branch or the default
  branch. A follow-up continues on the same voice branch.`,
    Publish: `- Publish: nothing leaves the container. Never push and never open a pull request, and do not ask
  whether to publish. End by naming the local branch and the short commit hash.`,
  },
  full: {
    Git: `- Git: start from the branch the checkout is on (named in the task; it may be dev rather than main). For
  changes, create a branch voice/<short-name> and commit there. Commit only your own changes: never commit,
  stash, reset or discard files you did not change. Never commit to the starting branch or the default
  branch, unless the task says "Direct push: yes". Never force-push, merge or delete branches. A follow-up
  continues on the same voice branch.`,
    Publish: `- Publish: push the branch and open a draft pull request against the starting branch with
  gh pr create --draft. Only if the task says "Direct push: yes", the driver explicitly asked for it: commit
  on the default branch and push it there, without a pull request. If the task says the repository is public
  or its visibility is unknown, do not push: commit, then end by asking whether to publish, and push only in
  a follow-up after a yes. If the push is rejected, say so and do not fork. Without a remote, only commit.`,
  },
}

// Pull requests turned off on GitHub: no voice branch and no pull request, the
// commits go to the default branch. On this computer, or in the container at
// level full.
const DIRECT_RULES = {
  Git: `- Git: pull requests are turned off on GitHub for this repository, so changes go straight to the default
  branch (named in the task). Switch to it and update it with git pull --ff-only before you change anything,
  and commit there. Commit only your own changes: never commit, stash, reset or discard files you did not
  change. Never force-push, rebase pushed commits, merge other branches in or delete branches.`,
  Publish: `- Publish: push the default branch with git push, without a pull request. If the task says the
  repository is public or its visibility is unknown, do not push: commit, then end by asking whether to
  publish, and push only in a follow-up after a yes. If the push is rejected, say so: do not force-push and do
  not fork. Without a remote, only commit.`,
}

// The worker's rules: as above on this computer and at level pr, with the
// Git and Publish rules of the level otherwise, or of a direct push where
// pull requests are turned off.
export function workerRules(level, { pushDirect = false } = {}) {
  const replace = pushDirect ? DIRECT_RULES : CONTAINER_RULES[level]
  if (!replace) return WORKER_RULES
  return WORKER_RULES.split('\n- ')
    .map((rule, i) => {
      const name = /^(\w+):/.exec(rule)?.[1]
      return i > 0 && replace[name] ? replace[name].slice(2) : rule
    })
    .join('\n- ')
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`
const originName = slug => slug ?? 'no GitHub remote'

function duration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return plural(seconds, 'second')
  return plural(Math.round(seconds / 60), 'minute')
}

export function githubSlug(url) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '')
  return match ? match[1] : null
}

function workerEnv() {
  const env = { ...process.env }
  for (const name of SESSION_ENV) delete env[name]
  return env
}

// The text of a tool result: a string, or a list of text blocks.
function resultContent(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n') : ''
}

const PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi

function describeStep(name, input, dir) {
  const target = input?.file_path ?? input?.notebook_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url
  const shown = typeof target === 'string' && target.startsWith(dir) ? relative(dir, target) || '.' : target
  return preview(shown ? `${name} ${shown}` : name, 80)
}

export class Workers extends EventEmitter {
  constructor({
    root,
    runner = new HostRunner(root),
    access = null,
    killswitch = null,
    stateDir,
    claudeBin = 'claude',
    ghBin = 'gh',
    model = '',
    effort = '',
    maxRuns = 2,
    timeoutMinutes = 60,
  }) {
    super()
    this.runner = runner
    this.access = access // GitHubAccess in the container, null on this computer
    this.killswitch = killswitch // while it is locked, nothing starts
    this.stateDir = stateDir
    this.stateFile = join(stateDir, 'workers.json')
    this.tasksDir = join(stateDir, 'tasks')
    this.claudeBin = claudeBin
    this.ghBin = ghBin
    this.model = model // claude --model for every run; empty: Claude Code's default
    this.effort = effort // claude --effort
    this.maxRuns = maxRuns
    this.timeoutMs = timeoutMinutes * 60 * 1000
    this.github = new Map() // owner/repo -> { at, info: { visibility, pulls, branch } }
    this.starting = new Set() // repositories between the checks and the start
    this.followed = new Map() // task id -> { offset, partial }
    this.state = this.load()
    // Also a folder an older version left with the default mode.
    try {
      chmodSync(this.tasksDir, 0o700)
    } catch {
      // not there before the first run
    }
    this.timer = setInterval(() => this.poll(), POLL_MS)
    this.timer.unref()
  }

  // --- state --------------------------------------------------------------

  // origins: in the container, the GitHub slug the gateway saw first per
  // repository (pinOrigin), without a prototype, as the names are folder names.
  load() {
    const origins = data => Object.assign(Object.create(null), data?.origins)
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      return { repos: data.repos ?? {}, tasks: data.tasks ?? [], origins: origins(data) }
    } catch (error) {
      if (error.code !== 'ENOENT') log('worker state unreadable, starting empty:', error.message)
      return { repos: {}, tasks: [], origins: origins(null) }
    }
  }

  save() {
    // Runs that drop out of the history take their output files with them.
    for (const old of this.state.tasks.slice(0, -KEEP_TASKS)) {
      if (old.state === 'running') continue
      rmSync(old.file, { force: true })
      rmSync(old.errFile, { force: true })
    }
    this.state.tasks = this.state.tasks.filter((t, i, all) => t.state === 'running' || i >= all.length - KEEP_TASKS)
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${this.stateFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.stateFile)
  }

  close() {
    clearInterval(this.timer)
  }

  newTaskId() {
    for (;;) {
      let id = 't'
      for (let i = 0; i < 3; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      if (!this.state.tasks.some(t => t.id === id)) return id
    }
  }

  running() {
    return this.state.tasks.filter(t => t.state === 'running')
  }

  lastTask(repo) {
    return this.state.tasks.findLast(t => t.repo === repo) ?? null
  }

  // Finished runs whose result has not reached the controller yet, for
  // example because the gateway restarted in between.
  unreported() {
    return this.state.tasks.filter(t => t.state !== 'running' && !t.reported)
  }

  markReported(task) {
    task.reported = true
    this.save()
  }

  // --- repositories -------------------------------------------------------

  // Throws when the worker container does not answer.
  repos() {
    return this.runner.names()
  }

  // What gh on this computer says about a repository: { visibility, pulls,
  // branch }, pulls being whether pull requests are turned on. null when gh
  // cannot tell; then it is asked again next time.
  async githubInfo(slug) {
    if (!slug) return null
    const cached = this.github.get(slug)
    if (cached && Date.now() - cached.at < GITHUB_CACHE_MS) return cached.info
    const repo = await new Promise(resolve => {
      execFile(this.ghBin, ['api', `repos/${slug}`], { timeout: 15000 }, (error, stdout) => {
        try {
          resolve(error ? null : JSON.parse(stdout))
        } catch {
          resolve(null)
        }
      })
    })
    const visibility = String(repo?.visibility ?? '').toLowerCase()
    if (!['public', 'private', 'internal'].includes(visibility)) return null
    const info = { visibility, pulls: repo.has_pull_requests !== false, branch: repo.default_branch || null }
    this.github.set(slug, { at: Date.now(), info })
    return info
  }

  // In the container, a worker can change its clone's origin, and with it the
  // repository that the access check and the kill switch's rules look at. So
  // the GitHub slug the gateway saw first counts (null: no GitHub remote).
  // Returns { from, to } while the origin says something else, otherwise null.
  pinOrigin(name, slug) {
    if (!this.runner.container) return null
    const origins = this.state.origins
    if (!Object.hasOwn(origins, name)) {
      origins[name] = slug
      try {
        this.save()
      } catch (error) {
        log('worker state not saved:', error.message) // the pin holds in this gateway
      }
      return null
    }
    const pinned = origins[name]
    return (pinned ?? '').toLowerCase() === (slug ?? '').toLowerCase() ? null : { from: pinned, to: slug }
  }

  async inspect(name) {
    const dir = this.runner.dir(name)
    const [branch, status, originUrl] = await Promise.all([
      this.runner.git(dir, 'branch', '--show-current'),
      this.runner.git(dir, 'status', '--porcelain'),
      this.runner.git(dir, 'remote', 'get-url', 'origin'),
    ])
    const origin = originUrl?.trim() || null
    const moved = this.pinOrigin(name, githubSlug(origin))
    const slug = moved ? moved.from : githubSlug(origin)
    const access = this.access ? await this.access.check(slug) : null
    // In the container the token's check knows it; otherwise gh on this computer.
    const github = origin && !access?.visibility ? await this.githubInfo(slug) : null
    return {
      name,
      dir,
      slug, // owner/repo on GitHub, or null
      branch: branch?.trim() ?? '',
      dirty: (status ?? '').split('\n').filter(Boolean).map(line => line.slice(3)),
      origin: slug ?? origin,
      visibility: !origin ? 'none' : (access?.visibility ?? github?.visibility ?? 'unknown'),
      defaultBranch: access?.branch ?? github?.branch ?? null,
      // Pull requests turned off on GitHub: commits go to the default branch.
      // In the container only at level full, which the check makes sure of.
      pushDirect: access ? access.level === 'full' && access.pulls === false : github?.pulls === false,
      access, // { level, reason, ... } in the container, null on this computer
      moved, // { from, to } when the origin in the container changed (pinOrigin)
    }
  }

  // --- runs ---------------------------------------------------------------

  async dispatch({ worker, task, words, fresh = false, allowDirty = false, direct = false }) {
    if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
    const names = await this.repos()
    if (!names.includes(worker)) return { status: 'unknown', names }
    const busy = this.running().find(t => t.repo === worker)
    if (busy || this.starting.has(worker)) return { status: 'busy', task: busy ?? null }
    if (this.running().length + this.starting.size >= this.maxRuns) {
      return { status: 'full', running: this.running() }
    }
    this.starting.add(worker)
    try {
      const facts = await this.inspect(worker)
      // The checks take a while (git, gh, the GitHub API), and the kill switch
      // stops only runs that are already going.
      if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
      if (facts.moved) return { status: 'origin', facts }
      // A push to the default branch only at level full, and only when asked;
      // or where pull requests are turned off, where it is the only way.
      if (direct && !facts.pushDirect && facts.access?.level !== 'full') return { status: 'refused', facts }
      if (facts.dirty.length && !allowDirty) return { status: 'dirty', files: facts.dirty }
      return this.start(facts, { task, words, fresh, direct })
    } finally {
      this.starting.delete(worker)
    }
  }

  start(facts, { task, words, fresh, direct = false }) {
    if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
    const previous = fresh ? null : this.state.repos[facts.name]?.sessionId
    const sessionId = previous || randomUUID()
    const id = this.newTaskId()
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 })
    const file = join(this.tasksDir, `${id}.jsonl`)
    const errFile = join(this.tasksDir, `${id}.err`)
    const out = openSync(file, 'a', 0o600)
    const err = openSync(errFile, 'a', 0o600)
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--settings', JSON.stringify({ permissions: { deny: WORKER_DENY } }),
      '--append-system-prompt', workerRules(facts.access?.level, { pushDirect: facts.pushDirect }),
      ...(this.model ? ['--model', this.model] : []),
      ...(this.effort ? ['--effort', this.effort] : []),
      ...(previous ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ]
    let child
    try {
      child = this.runner.spawn(id, this.claudeBin, args, { cwd: facts.dir, stdio: ['pipe', out, err], env: workerEnv() })
    } finally {
      closeSync(out)
      closeSync(err)
    }
    const record = {
      id,
      repo: facts.name,
      task,
      words,
      state: 'running',
      pid: child.pid ?? null,
      sessionId,
      resumed: Boolean(previous),
      access: facts.access?.level ?? null,
      direct,
      pushDirect: Boolean(facts.pushDirect), // pull requests turned off: commits go to the default branch
      dir: facts.dir,
      slug: facts.slug ?? null, // owner/repo on GitHub, or null
      defaultBranch: facts.defaultBranch ?? null,
      pulls: [], // numbers of this repository's pull requests the run named
      startedAt: Date.now(),
      finishedAt: null,
      file,
      errFile,
      steps: [],
      lastText: '',
      result: null,
      error: null,
      reported: false,
    }
    child.on('error', error => this.finish(record, 'failed', `could not start ${error.path || this.claudeBin}: ${error.message}`))
    child.stdin.on('error', () => {}) // the run may end before it read everything
    child.stdin.end(prompt({ task, words, facts, direct }))
    child.unref()
    this.state.tasks.push(record)
    this.state.repos[facts.name] = { sessionId }
    this.save()
    log('worker start', facts.name, id, previous ? 'resumed session' : 'new session', preview(task, 60))
    this.emit('started', record)
    return { status: 'started', task: record, facts }
  }

  // Stopped by the controller, which knows and needs no event; or by the time
  // limit, which the controller hears about like any other end of a run.
  stop(worker, { reason = 'stopped by the controller', report = false } = {}) {
    const task = this.running().find(t => t.repo === worker)
    if (!task) return null
    this.runner.stop(task)
    task.reported = !report
    this.finish(task, 'stopped', reason)
    return task
  }

  // The kill switch: every run stops. The controller hears about it once,
  // from the gateway, not per run. Every run gets its signal and is marked
  // stopped before the state is saved; an error in saving comes after that.
  stopAll(reason) {
    const stopped = this.running()
    for (const task of stopped) {
      this.runner.stop(task)
      task.reported = true
    }
    let failed = null
    for (const task of stopped) {
      try {
        this.finish(task, 'stopped', reason)
      } catch (error) {
        failed ??= error
      }
    }
    if (failed) throw failed
    return stopped
  }

  // --- following runs -----------------------------------------------------

  poll() {
    for (const task of this.running()) {
      this.follow(task)
      if (task.state !== 'running') continue
      if (task.resultSeen) {
        this.finish(task, task.isError ? 'failed' : 'done', task.isError ? task.result : null)
      } else if (!alive(task.pid)) {
        this.follow(task) // whatever it wrote last
        if (task.resultSeen) this.finish(task, task.isError ? 'failed' : 'done', task.isError ? task.result : null)
        else this.finish(task, 'failed', this.errorTail(task) || 'ended without a result')
      } else if (Date.now() - task.startedAt > this.timeoutMs) {
        this.stop(task.repo, { reason: `stopped at the time limit of ${duration(this.timeoutMs)}`, report: true })
      }
    }
    for (const task of this.unreported()) this.emit('finished', task)
  }

  follow(task) {
    const cursor = this.followed.get(task.id) ?? { offset: 0, partial: '' }
    let fd
    try {
      fd = openSync(task.file, 'r')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      if (size <= cursor.offset) return
      const buffer = Buffer.alloc(size - cursor.offset)
      readSync(fd, buffer, 0, buffer.length, cursor.offset)
      cursor.offset = size
      const lines = (cursor.partial + buffer.toString('utf8')).split('\n')
      cursor.partial = lines.pop()
      for (const line of lines) this.handleLine(task, line)
    } finally {
      closeSync(fd)
      this.followed.set(task.id, cursor)
    }
  }

  handleLine(task, line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.session_id && message.session_id !== task.sessionId) {
      task.sessionId = message.session_id
      this.state.repos[task.repo] = { sessionId: message.session_id }
    }
    if (message.type === 'assistant') {
      for (const part of message.message?.content ?? []) {
        if (part.type === 'tool_use') {
          task.steps = [...task.steps, describeStep(part.name, part.input, this.runner.dir(task.repo))].slice(-MAX_STEPS)
          this.emit('tool', task, part) // for the kill switch's rules (guard.mjs)
        } else if (part.type === 'text' && part.text?.trim()) {
          task.lastText = preview(part.text, 300)
          this.notePulls(task, part.text)
        }
      }
    } else if (message.type === 'user') {
      for (const part of message.message?.content ?? []) {
        if (part.type === 'tool_result') this.notePulls(task, resultContent(part.content))
      }
    } else if (message.type === 'result') {
      task.resultSeen = true
      task.isError = Boolean(message.is_error) || message.subtype !== 'success'
      task.result = String(message.result ?? message.subtype ?? '').trim()
      this.notePulls(task, task.result)
    }
  }

  // Pull requests of the run's own repository that it names by URL, for
  // example in the output of gh pr create; pulls.mjs checks them with gh.
  notePulls(task, text) {
    if (!task.slug || !text) return
    for (const [, slug, number] of text.matchAll(PULL_URL)) {
      const pulls = task.pulls ?? []
      if (slug.toLowerCase() === task.slug.toLowerCase() && !pulls.includes(Number(number))) {
        task.pulls = [...pulls, Number(number)].slice(-5)
      }
    }
  }

  errorTail(task) {
    try {
      return preview(readFileSync(task.errFile, 'utf8').trim().split('\n').slice(-3).join(' '), 300)
    } catch {
      return ''
    }
  }

  finish(task, state, error = null) {
    if (task.state !== 'running') return
    task.state = state
    task.finishedAt = Date.now()
    task.error = error
    this.followed.delete(task.id)
    this.save()
    log(`worker ${state}`, task.repo, task.id, `after ${duration(task.finishedAt - task.startedAt)}`, error ? preview(error, 120) : '')
    this.emit('ended', task)
  }

  // --- texts for the controller -------------------------------------------

  async listText() {
    const names = await this.repos()
    const facts = await Promise.all(names.map(name => this.inspect(name)))
    const container = this.runner.container
    const lines = [
      `[workers=${names.length} running=${this.running().length} max=${this.maxRuns}${container ? ` docker=${container}` : ''}]`,
    ]
    for (const f of facts) {
      const where = f.moved
        ? `the origin changed in the container from ${originName(f.moved.from)} to ${originName(f.moved.to)}; ` +
          'check it at the desk, no dispatch until then'
        : f.origin
          ? `${f.origin}, ${f.visibility}`
          : 'no remote'
      const access = f.access && !f.moved ? `, access ${f.access.level} (${f.access.reason})` : ''
      const direct = f.pushDirect && !f.access ? `, pull requests off: pushes to ${f.defaultBranch || 'the default branch'}` : ''
      const changes = f.dirty.length ? plural(f.dirty.length, 'uncommitted file') : 'clean'
      lines.push(`${f.name}: ${where}${access}${direct}, branch ${f.branch || 'detached'}, ${changes}, ${this.stateText(f.name)}`)
    }
    if (!names.length) {
      lines.push(`No git repositories in ${this.runner.root}${container ? ` in the container ${container}` : ''}.`)
    }
    return lines.join('\n')
  }

  stateText(repo) {
    const task = this.lastTask(repo)
    if (!task) return 'idle'
    if (task.state === 'running') {
      return `running ${task.id} for ${duration(Date.now() - task.startedAt)} ("${preview(task.task, 50)}")`
    }
    return `idle, last task ${task.id} ${task.state} ${duration(Date.now() - task.finishedAt)} ago`
  }

  statusText(repo) {
    const task = this.lastTask(repo)
    if (!task) return `[worker=${repo} state=idle] No task yet.`
    const lines = []
    if (task.state === 'running') {
      lines.push(`[worker=${repo} state=running task=${task.id} elapsed=${Math.round((Date.now() - task.startedAt) / 1000)}s]`)
    } else {
      lines.push(`[worker=${repo} state=${task.state} task=${task.id} took=${duration(task.finishedAt - task.startedAt)}]`)
    }
    lines.push(`Task: ${preview(task.task, 200)}`)
    if (task.steps.length) lines.push(`Last steps: ${task.steps.join('; ')}`)
    if (task.state === 'running' && task.lastText) lines.push(`Last message: ${task.lastText}`)
    if (task.result) lines.push(`Result: ${task.result}`)
    if (task.error && task.error !== task.result) lines.push(`Problem: ${task.error}`)
    return lines.join('\n')
  }

  // The channel event the controller gets when a run ends, with the pull
  // requests it opened or worked on, as gh shows them (pulls.mjs).
  resultText(task, pulls = []) {
    const lines = [
      `Worker ${task.repo} finished task ${task.id}: ${task.state} after ${duration(task.finishedAt - task.startedAt)}.`,
      `Task: ${preview(task.task, 200)}`,
    ]
    if (task.result) lines.push(`Result: ${task.result}`)
    if (task.error && task.error !== task.result) lines.push(`Problem: ${task.error}`)
    for (const pull of pulls) {
      lines.push(`Pull request: ${pull.number} in ${task.slug}, "${preview(pull.title, 80)}"${pull.isDraft ? ', a draft' : ''}.`)
    }
    return lines.join('\n')
  }
}

const ACCESS_TEXT = {
  'read-only': 'Nothing leaves this container: no push, no pull request.',
  pr: 'Push a voice/ branch and open a draft pull request.',
  full: 'Push a voice/ branch and open a draft pull request; a direct push only with "Direct push: yes".',
}

// What the worker reads on stdin: the task in the controller's words, the
// driver's own words, and what the gateway checked.
export function prompt({ task, words, facts, direct = false }) {
  const visibility = {
    public: 'public',
    private: 'private',
    internal: 'internal to the organisation',
    unknown: 'visibility unknown, treat it as public',
  }[facts.visibility]
  const lines = [
    task.trim(),
    '',
    `The driver's own words: "${String(words ?? '').trim()}"`,
    '',
    'Checked by the gateway just now:',
    `- Repository: ${facts.origin ? `${facts.origin} (${visibility})` : 'no remote'}`,
    `- Starting branch: ${facts.branch || 'detached HEAD'}`,
    `- Uncommitted files before you start: ${facts.dirty.length ? facts.dirty.join(', ') + ' (not yours, leave them alone)' : 'none'}`,
  ]
  const target = facts.defaultBranch || 'the default branch'
  if (facts.access) {
    const { level, reason } = facts.access
    lines.push(`- Access level: ${level} (${reason}). ${facts.pushDirect ? '' : ACCESS_TEXT[level]}`.trimEnd())
    if (direct && !facts.pushDirect) {
      lines.push(`- Direct push: yes. The driver explicitly asked to push straight to ${target}.`)
    }
  }
  if (facts.pushDirect) {
    lines.push(`- Pull requests: turned off on GitHub. Commit on ${target} and push it there, without a pull request.`)
  }
  return lines.join('\n') + '\n'
}
