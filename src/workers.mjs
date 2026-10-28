// Workers: headless Claude Code runs in the git repositories next to this one
// (~/Developer by default), started by the controller through the channel
// tools list_workers, dispatch, worker_status and stop_worker.
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

import { execFile, spawn } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { log, preview } from './log.mjs'

const POLL_MS = 1000
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

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`

function duration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return plural(seconds, 'second')
  return plural(Math.round(seconds / 60), 'minute')
}

function git(dir, ...args) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout))
  })
}

function githubSlug(url) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '')
  return match ? match[1] : null
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
  constructor({ root, stateDir, claudeBin = 'claude', ghBin = 'gh', maxRuns = 2, timeoutMinutes = 60 }) {
    super()
    this.root = root
    this.stateDir = stateDir
    this.stateFile = join(stateDir, 'workers.json')
    this.tasksDir = join(stateDir, 'tasks')
    this.claudeBin = claudeBin
    this.ghBin = ghBin
    this.maxRuns = maxRuns
    this.timeoutMs = timeoutMinutes * 60 * 1000
    this.visibilities = new Map() // owner/repo -> public | private | internal
    this.starting = new Set() // repositories between the checks and the start
    this.followed = new Map() // task id -> { offset, partial }
    this.state = this.load()
    this.timer = setInterval(() => this.poll(), POLL_MS)
    this.timer.unref()
  }

  // --- state --------------------------------------------------------------

  load() {
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      return { repos: data.repos ?? {}, tasks: data.tasks ?? [] }
    } catch (error) {
      if (error.code !== 'ENOENT') log('worker state unreadable, starting empty:', error.message)
      return { repos: {}, tasks: [] }
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
    mkdirSync(this.stateDir, { recursive: true })
    const tmp = `${this.stateFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n')
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

  repos() {
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

  async visibility(slug, origin) {
    if (!origin) return 'none'
    if (!slug) return 'unknown'
    if (this.visibilities.has(slug)) return this.visibilities.get(slug)
    const answer = await new Promise(resolve => {
      execFile(this.ghBin, ['repo', 'view', slug, '--json', 'visibility', '-q', '.visibility'], { timeout: 15000 }, (error, stdout) =>
        resolve(error ? null : stdout.trim().toLowerCase()),
      )
    })
    if (!['public', 'private', 'internal'].includes(answer)) return 'unknown'
    this.visibilities.set(slug, answer)
    return answer
  }

  async inspect(name) {
    const dir = join(this.root, name)
    const [branch, status, originUrl] = await Promise.all([
      git(dir, 'branch', '--show-current'),
      git(dir, 'status', '--porcelain'),
      git(dir, 'remote', 'get-url', 'origin'),
    ])
    const origin = originUrl?.trim() || null
    const slug = githubSlug(origin)
    return {
      name,
      dir,
      slug, // owner/repo on GitHub, or null
      branch: branch?.trim() ?? '',
      dirty: (status ?? '').split('\n').filter(Boolean).map(line => line.slice(3)),
      origin: slug ?? origin,
      visibility: await this.visibility(slug, origin),
    }
  }

  // --- runs ---------------------------------------------------------------

  async dispatch({ worker, task, words, fresh = false, allowDirty = false }) {
    const names = this.repos()
    if (!names.includes(worker)) return { status: 'unknown', names }
    const busy = this.running().find(t => t.repo === worker)
    if (busy || this.starting.has(worker)) return { status: 'busy', task: busy ?? null }
    if (this.running().length + this.starting.size >= this.maxRuns) {
      return { status: 'full', running: this.running() }
    }
    this.starting.add(worker)
    try {
      const facts = await this.inspect(worker)
      if (facts.dirty.length && !allowDirty) return { status: 'dirty', files: facts.dirty }
      return this.start(facts, { task, words, fresh })
    } finally {
      this.starting.delete(worker)
    }
  }

  start(facts, { task, words, fresh }) {
    const previous = fresh ? null : this.state.repos[facts.name]?.sessionId
    const sessionId = previous || randomUUID()
    const id = this.newTaskId()
    mkdirSync(this.tasksDir, { recursive: true })
    const file = join(this.tasksDir, `${id}.jsonl`)
    const errFile = join(this.tasksDir, `${id}.err`)
    const out = openSync(file, 'a')
    const err = openSync(errFile, 'a')
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--settings', JSON.stringify({ permissions: { deny: WORKER_DENY } }),
      '--append-system-prompt', WORKER_RULES,
      ...(previous ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ]
    let child
    try {
      // Detached: its own process group, so stopping it reaches the commands
      // it started, and a controller restart does not end it.
      child = spawn(this.claudeBin, args, { cwd: facts.dir, detached: true, stdio: ['pipe', out, err], env: workerEnv() })
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
      slug: facts.slug, // owner/repo on GitHub, or null
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
    child.on('error', error => this.finish(record, 'failed', `could not start ${this.claudeBin}: ${error.message}`))
    child.stdin.on('error', () => {}) // the run may end before it read everything
    child.stdin.end(prompt({ task, words, facts }))
    child.unref()
    this.state.tasks.push(record)
    this.state.repos[facts.name] = { sessionId }
    this.save()
    log('worker start', facts.name, id, previous ? 'resumed session' : 'new session', preview(task, 60))
    return { status: 'started', task: record, facts }
  }

  // Stopped by the controller, which knows and needs no event; or by the time
  // limit, which the controller hears about like any other end of a run.
  stop(worker, { reason = 'stopped by the controller', report = false } = {}) {
    const task = this.running().find(t => t.repo === worker)
    if (!task) return null
    try {
      process.kill(-task.pid, 'SIGTERM')
    } catch {
      // already gone
    }
    const pid = task.pid
    setTimeout(() => {
      if (alive(pid)) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // gone after all
        }
      }
    }, 5000).unref()
    task.reported = !report
    this.finish(task, 'stopped', reason)
    return task
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
          task.steps = [...task.steps, describeStep(part.name, part.input, join(this.root, task.repo))].slice(-MAX_STEPS)
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
  }

  // --- texts for the controller -------------------------------------------

  async listText() {
    const names = this.repos()
    const facts = await Promise.all(names.map(name => this.inspect(name)))
    const lines = [`[workers=${names.length} running=${this.running().length} max=${this.maxRuns}]`]
    for (const f of facts) {
      const where = f.origin ? `${f.origin}, ${f.visibility}` : 'no remote'
      const changes = f.dirty.length ? plural(f.dirty.length, 'uncommitted file') : 'clean'
      lines.push(`${f.name}: ${where}, branch ${f.branch || 'detached'}, ${changes}, ${this.stateText(f.name)}`)
    }
    if (!names.length) lines.push(`No git repositories in ${this.root}.`)
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

// What the worker reads on stdin: the task in the controller's words, the
// driver's own words, and what the gateway checked.
export function prompt({ task, words, facts }) {
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
  return lines.join('\n') + '\n'
}
