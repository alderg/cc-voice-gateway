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
// A task for a repository whose worker is busy, or while every run slot is
// taken, waits in a queue in .state/workers.json and starts by itself when
// it is its turn (pump), so nobody has to remember to send it again. While a
// decision about a repository is open (ledger.mjs), its tasks wait too,
// except the follow-up for the driver's answer to it.
//
// The gateway checks the checkout before a run (uncommitted files, a run
// already going, the cap on parallel runs) in code, not in the worker's
// instructions. What the worker does with git is up to its instructions;
// after the run the gateway looks again (audit): commits on no remote,
// uncommitted files that were not there at the start, and the branch. The
// controller gets that with the result, whatever the worker wrote.
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
const MAX_UNPUSHED = 200 // commits on no remote that the audit lists
const PAUSE_MS = 30 * 1000 // the queue waits this long when the worker container does not answer
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
- Before you end, look at git status and git log --branches --not --remotes. Never end a run with commits of
  yours on no remote, or uncommitted changes of yours, without naming them in your result. Where the Publish
  rule lets you push and you did not, end by asking whether to push. The gateway checks git after every run
  and asks the driver about whatever is left.
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

// Queued tasks in a list, first the next: q2ab ("Run the tests."), …; with
// the repositories when they are not all the same.
export const queueList = (entries, { max = 5, repos = false } = {}) =>
  entries
    .slice(0, max)
    .map(entry => `${entry.id}${repos ? ` for ${entry.worker}` : ''} ("${preview(entry.task, 50)}")`)
    .join(', ') + (entries.length > max ? `, and ${entries.length - max} more` : '')

// What the controller hears when a queued task could not start and left the
// queue: the controller's own task, which may quote a worker (so the event is
// trusted="no"), and the gateway's reason. decision: the open decision it
// became.
export function parkedText(entry, why, status, decision = null) {
  const hint =
    status === 'dirty'
      ? 'If the driver says to go ahead anyway, dispatch it again with allow_dirty and their words.'
      : 'If the driver still wants it, dispatch it again with their words.'
  return (
    `The queued task ${entry.id} for ${entry.worker} did not start: ${why}. It has left the queue. ` +
    `Task: "${preview(entry.task, 200)}". Tell the driver and ask what to do. ${hint}` +
    (decision
      ? ` It is open decision ${decision.id} now, and other tasks for ${entry.worker} wait until it is closed: ` +
        'the follow-up for the answer closes it, or resolve_decision.'
      : '')
  )
}

// The push decision after a run, in the gateway's words.
function pushText(task, commits, files) {
  const left = [commits && plural(commits, 'commit') + ' on no remote', files && plural(files, 'new uncommitted file')]
  const what = left.filter(Boolean).join(' and ')
  const ask = task.access === 'read-only' ? 'Commit them in the container' : commits ? 'Push them' : 'Commit and push them'
  return `${task.repo}: task ${task.id} left ${what}. ${ask}, or leave them as they are?`
}

// A queued task that could not start, as an open decision.
const parkedDecision = (entry, why) =>
  `The queued task ${entry.id} for ${entry.worker} did not start: ${why}. Task: "${preview(entry.task, 120)}". ` +
  'Dispatch it again, or let it go?'

function duration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return plural(seconds, 'second')
  return plural(Math.round(seconds / 60), 'minute')
}

// A saved queue entry the gateway can start. Anything else in the file, from
// an older version or edited by hand, is left out.
const queuable = entry =>
  entry !== null &&
  typeof entry === 'object' &&
  ['id', 'worker', 'task', 'words'].every(key => typeof entry[key] === 'string' && entry[key] !== '')

export function githubSlug(url) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '')
  return match ? match[1] : null
}

function workerEnv() {
  const env = { ...process.env }
  for (const name of SESSION_ENV) delete env[name]
  return env
}

// The files in the output of git status --porcelain.
const changedFiles = status =>
  (status ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3))

// What git says about a checkout: its branch, the uncommitted files, whether
// it has a remote, and the commits that no remote branch has, each with the
// branch it was found on (at most MAX_UNPUSHED). Without a remote there is
// nowhere to push, so none count. null when git does not answer. git is a
// runner's git(dir, ...args), on this computer or in the container.
// current: only the commits of the branch that is checked out, for the
// gateway's own checkout, where other local branches (Claude Code's
// worktrees, for example) are not the driver's to push.
export async function gitState(git, dir, { current = false } = {}) {
  const [branch, status, remotes] = await Promise.all([
    git(dir, 'branch', '--show-current'),
    git(dir, 'status', '--porcelain'),
    git(dir, 'remote'),
  ])
  if (status === null || remotes === null) return null
  const remote = remotes.trim() !== ''
  const refs = current ? ['HEAD'] : ['--branches']
  const log = remote
    ? await git(dir, 'log', ...refs, '--not', '--remotes', '--source', `--max-count=${MAX_UNPUSHED}`, '--format=%h %S')
    : ''
  if (log === null) return null
  const unpushed = log
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, ...ref] = line.split(' ')
      return { hash, branch: ref.join(' ') }
    })
  return { branch: branch?.trim() ?? '', dirty: changedFiles(status), remote, unpushed }
}

// git on this computer, for the gateway's own checkout.
export const hostGit = (dir, ...args) => new HostRunner(dir).git(dir, ...args)

const commits = n => `${plural(n, 'commit')} on no remote`
const newFiles = n => plural(n, 'new uncommitted file')

// The audit in a few words for the result event's git attribute, from a fixed
// vocabulary: no branch or file name, which the run chose.
export function auditSummary(audit) {
  if (!audit?.ok) return 'not checked'
  const parts = []
  if (audit.unpushed.length) parts.push(commits(audit.unpushed.length))
  if (audit.dirty.length) parts.push(newFiles(audit.dirty.length))
  if (audit.startBranch && audit.branch !== audit.startBranch) parts.push('not back on its starting branch')
  if (audit.baseline === false) parts.push('its start not recorded')
  return parts.length ? parts.join(', ') : 'clean'
}

// The audit as a line of the result event, with the branches and files.
export function auditText(audit) {
  if (!audit) return null
  if (!audit.ok) return 'Git check by the gateway: not possible, git did not answer.'
  if (audit.baseline === false && !audit.unpushed.length && !audit.dirty.length) {
    return (
      'Git check by the gateway: the checkout as this run found it was not recorded, so no commit or file is ' +
      `counted as the run's own; it is on ${audit.branch || 'a detached HEAD'}.`
    )
  }
  const parts = []
  if (audit.unpushed.length) {
    const branches = [...new Set(audit.unpushed.map(c => c.branch).filter(Boolean))]
    parts.push(`${commits(audit.unpushed.length)}${branches.length ? ` (on ${branches.slice(0, 3).join(', ')})` : ''}`)
  }
  if (audit.dirty.length) {
    const shown = audit.dirty.slice(0, 5).join(', ') + (audit.dirty.length > 5 ? ', …' : '')
    parts.push(`${newFiles(audit.dirty.length)} (${preview(shown, 160)})`)
  }
  if (audit.startBranch && audit.branch !== audit.startBranch) {
    parts.push(`the checkout is on ${audit.branch || 'a detached HEAD'}, not on ${audit.startBranch} as at the start`)
  }
  return `Git check by the gateway: ${parts.length ? parts.join(', ') : 'clean, nothing left unpushed or uncommitted'}.`
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
    ledger = null,
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
    this.ledger = ledger // open decisions: they hold a repository's queue
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
    this.auditing = new Set() // repositories whose checkout the audit looks at
    this.pumping = false // a queued task is being started
    this.pausedUntil = 0 // the queue waits for the worker container
    this.followed = new Map() // task id -> { offset, partial }
    this.state = this.load()
    // Also a folder an older version left with the default mode.
    try {
      chmodSync(this.tasksDir, 0o700)
    } catch {
      // not there before the first run
    }
    this.timer = setInterval(() => {
      try {
        this.poll()
      } catch (error) {
        log('following worker runs failed:', error.message) // for example .state not writable; the next poll tries again
      }
    }, POLL_MS)
    this.timer.unref()
  }

  // --- state --------------------------------------------------------------

  // origins: in the container, the GitHub slug the gateway saw first per
  // repository (pinOrigin), without a prototype, as the names are folder names.
  // queue: the tasks waiting for their turn, in order.
  load() {
    const origins = data => Object.assign(Object.create(null), data?.origins)
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      const queue = (Array.isArray(data.queue) ? data.queue : []).filter(queuable)
      return { repos: data.repos ?? {}, tasks: data.tasks ?? [], origins: origins(data), queue }
    } catch (error) {
      if (error.code !== 'ENOENT') log('worker state unreadable, starting empty:', error.message)
      return { repos: {}, tasks: [], origins: origins(null), queue: [] }
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

  newTaskId(prefix = 't') {
    for (;;) {
      let id = prefix
      for (let i = 0; i < 3; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
      if (!this.state.tasks.some(t => t.id === id) && !this.state.queue.some(q => q.id === id)) return id
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
      dirty: changedFiles(status),
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

  // A task on the driver's words, which the caller has checked (channel.mjs).
  // It starts at once, or waits in the queue: behind a run in the same
  // repository, behind an open decision about it, behind tasks queued there
  // before it, or for a free run slot. request: the id of the voice request
  // with the words; answers: the request whose question those words answer.
  // The follow-up for an answer is not held by that question's decisions,
  // and goes before the tasks they hold.
  async dispatch({ worker, task, words, fresh = false, allowDirty = false, direct = false, request = null, answers = null }) {
    if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
    const names = await this.repos()
    if (!names.includes(worker)) return { status: 'unknown', names }
    const job = { worker, task, words, fresh, allowDirty, direct, request, answers }
    const first = this.follows(worker, answers).length > 0
    const ahead = this.queued(worker).length && !first
    const why = this.waiting(worker, answers) ?? (this.slotsFull() ? 'full' : ahead ? 'queue' : null)
    if (why) return this.enqueue(job, why, { first })
    return this.launch(job)
  }

  // The decisions that the driver's answer on request `answers` is about, of
  // this repository or of none: the follow-up's start closes them.
  follows(repo, answers) {
    if (!answers || !this.ledger) return []
    return this.ledger.forRequest(answers, { closed: true }).filter(d => d.repo === repo || d.repo === null)
  }

  // The open decisions that hold a repository's tasks: all of them, except
  // those that a follow-up answers.
  holds(repo, answers = null) {
    return this.ledger?.forRepo(repo).filter(d => !answers || !d.requests.includes(answers)) ?? []
  }

  // The checks before a run, and the start: for a dispatch, and for a queued
  // task when it is its turn (entry).
  async launch({ worker, task, words, fresh = false, allowDirty = false, direct = false, answers = null }, entry = null) {
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
      // The files the decisions it follows up are about are what a follow-up
      // is for: neither a reason to ask again nor someone else's.
      const decided = new Set(this.follows(worker, answers).flatMap(d => d.details?.files ?? []))
      facts.followed = facts.dirty.filter(file => decided.has(file))
      const foreign = facts.dirty.filter(file => !decided.has(file))
      if (foreign.length && !allowDirty) return { status: 'dirty', files: foreign }
      facts.unpushed = await this.baseline(facts.dir)
      return this.start(facts, { task, words, fresh, direct, answers }, entry)
    } finally {
      this.starting.delete(worker)
    }
  }

  git(dir, ...args) {
    return this.runner.git(dir, ...args)
  }

  // The commits on no remote before a run, so that its audit tells the run's
  // own from what was there already. null when git does not answer.
  async baseline(dir) {
    const state = await gitState((...args) => this.git(...args), dir)
    return state ? state.unpushed.map(commit => commit.hash) : null
  }

  start(facts, { task, words, fresh, direct = false, answers = null }, entry = null) {
    if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
    if (entry && !this.state.queue.some(waiting => waiting.id === entry.id)) return { status: 'dropped' }
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
      // For the audit at the end: the checkout as the run found it.
      startBranch: facts.branch,
      startDirty: facts.dirty,
      unpushedBefore: facts.unpushed ?? null, // commit hashes; null: unknown
      audit: null,
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
    if (entry) record.queued = entry.id // it waited in the queue as this
    // The follow-up for the driver's answer: the decisions it answers close
    // now, and what they were about counts again in this run's audit, so a
    // follow-up that was to push and did not is caught. Only those still open
    // until now: one the driver closed before ("keep it local") stays closed.
    const follows = this.follows(facts.name, answers)
    const closed = follows.filter(d => this.ledger.close(d, { outcome: `the follow-up task ${id} started`, by: 'dispatch' }))
    if (closed.length) {
      record.follows = closed.map(d => d.id)
      record.carried = { commits: closed.flatMap(d => d.details?.commits ?? []), files: closed.flatMap(d => d.details?.files ?? []) }
    }
    child.on('error', error => this.finish(record, 'failed', `could not start ${error.path || this.claudeBin}: ${error.message}`))
    child.stdin.on('error', () => {}) // the run may end before it read everything
    child.stdin.end(prompt({ task, words, facts, direct }))
    child.unref()
    this.state.tasks.push(record)
    this.state.repos[facts.name] = { sessionId }
    if (entry) this.state.queue = this.state.queue.filter(waiting => waiting.id !== entry.id)
    this.save()
    const queued = entry ? [`queued as ${entry.id}`] : []
    log('worker start', facts.name, id, previous ? 'resumed session' : 'new session', ...queued, preview(task, 60))
    this.emit('started', record)
    return { status: 'started', task: record, facts, closed: closed.map(d => d.id) }
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

  // --- the queue ----------------------------------------------------------

  // Queued tasks start in the order they came, one repository at a time,
  // once the repository is idle and its last result has reached the
  // controller, and a run slot is free. The driver's words were checked when
  // a task was queued. One that cannot start when it is its turn (uncommitted
  // changes, the origin changed in the container, a direct push no longer
  // allowed, the repository gone) leaves the queue with its reason, and the
  // controller hears about it ('parked'): none is dropped silently.

  queued(repo = null) {
    return this.state.queue.filter(entry => repo === null || entry.worker === repo)
  }

  slotsFull() {
    return this.running().length + this.starting.size >= this.maxRuns
  }

  // 'busy' while a repository cannot take a run: one is going or starting,
  // or the last one is still being checked or reported. 'decision' while an
  // open decision holds it (except those that `answers` answers). Otherwise
  // null.
  waiting(repo, answers = null) {
    const last = this.lastTask(repo)
    if (last?.state === 'running' || this.starting.has(repo) || this.auditing.has(repo)) return 'busy'
    if (last && !last.reported) return 'busy'
    if (this.holds(repo, answers).length) return 'decision'
    return null
  }

  // first: before the other tasks of its repository, for a follow-up.
  enqueue(job, reason, { first = false } = {}) {
    const entry = { id: this.newTaskId('q'), ...job, queuedAt: Date.now() }
    const at = first ? this.state.queue.findIndex(waiting => waiting.worker === job.worker) : -1
    this.state.queue.splice(at >= 0 ? at : this.state.queue.length, 0, entry)
    try {
      this.save()
    } catch (error) {
      this.state.queue = this.state.queue.filter(waiting => waiting !== entry) // not kept, so not queued
      throw error
    }
    log('worker queued', job.worker, entry.id, reason, preview(job.task, 60))
    return {
      status: 'queued',
      entry,
      reason, // busy, decision, queue (others before it), full (no run slot)
      position: this.queued(job.worker).indexOf(entry) + 1,
      task: this.running().find(t => t.repo === job.worker) ?? null,
      running: this.running(),
      holds: this.holds(job.worker, job.answers),
    }
  }

  // Starts the next queued task that can start; poll() calls it every
  // second. Only the first task of a repository may start, and nothing
  // starts while the kill switch is locked.
  async pump() {
    if (this.pumping || !this.state.queue.length || this.killswitch?.locked || Date.now() < this.pausedUntil) return
    this.pumping = true
    try {
      const seen = new Set()
      for (const entry of [...this.state.queue]) {
        if (seen.has(entry.worker)) continue
        seen.add(entry.worker)
        if (this.slotsFull()) return
        if (this.waiting(entry.worker, entry.answers)) continue
        await this.startQueued(entry)
        return
      }
    } catch (error) {
      log('queued task not started:', error.message)
    } finally {
      this.pumping = false
    }
  }

  async startQueued(entry) {
    let names
    try {
      names = await this.repos()
    } catch (error) {
      this.pausedUntil = Date.now() + PAUSE_MS
      log('queue waits:', error.message)
      return
    }
    // Meanwhile a dispatch may have taken the slot, or the controller dropped it.
    if (!this.queued(entry.worker).includes(entry) || this.slotsFull() || this.waiting(entry.worker, entry.answers)) return
    if (!names.includes(entry.worker)) return this.park(entry, 'the repository is gone')
    let result
    try {
      result = await this.launch(entry, entry)
    } catch (error) {
      log('queued task', entry.id, 'could not start:', error.message)
      return this.park(entry, 'it could not start; the gateway log says why')
    }
    // locked: it waits; dropped: the controller took it out meanwhile.
    if (['started', 'locked', 'dropped'].includes(result.status)) return
    const why = {
      origin: 'the origin of the repository changed in the container; it needs a look at the desk',
      refused: 'a direct push needs access level full, and the repository is not at full',
      dirty: `the checkout has ${plural(result.files?.length ?? 0, 'uncommitted file')}`,
    }[result.status]
    this.park(entry, why ?? `it could not start (${result.status})`, result.status)
  }

  // Takes a queued task out of the queue because it cannot start; it becomes
  // an open decision, which holds the repository's other tasks.
  park(entry, why, status = 'gone') {
    this.state.queue = this.state.queue.filter(waiting => waiting.id !== entry.id)
    try {
      this.save()
    } catch (error) {
      log('worker state not saved:', error.message)
    }
    log('queued task left the queue', entry.worker, entry.id, why)
    const decision = this.ledger?.add({ kind: 'other', repo: entry.worker, text: parkedDecision(entry, why), details: { queued: entry } }) ?? null
    this.emit('parked', entry, why, status, decision)
  }

  // The kill switch empties the queue: nothing starts while it is locked,
  // nor by itself after the unlock. Each task becomes an open decision, so
  // that the driver hears of it; it names the repository (in the queued
  // task) but does not hold it, so that new tasks there start after the
  // unlock. Returns the tasks that were queued.
  parkAll() {
    const parked = this.state.queue
    if (!parked.length) return []
    this.state.queue = []
    try {
      this.save()
    } catch (error) {
      log('worker state not saved:', error.message)
    }
    for (const entry of parked) {
      const text = parkedDecision(entry, 'the kill switch locked')
      this.ledger?.add({ kind: 'other', text, details: { queued: entry } })
    }
    return parked
  }

  // On the controller's word: one queued task by its id, or every one of a
  // repository ("all"). Returns those dropped.
  drop(repo, which) {
    const dropped = this.queued(repo).filter(entry => which === 'all' || entry.id === which)
    if (!dropped.length) return []
    this.state.queue = this.state.queue.filter(entry => !dropped.includes(entry))
    this.save()
    log('dropped from the queue', repo, dropped.map(entry => entry.id).join(', '))
    return dropped
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
    this.pump()
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
    // The run has ended whether or not the state can be saved: the rules and
    // the report hear about it first, then the caller about the save.
    let unsaved = null
    try {
      this.save()
    } catch (saveError) {
      unsaved = saveError
    }
    log(`worker ${state}`, task.repo, task.id, `after ${duration(task.finishedAt - task.startedAt)}`, error ? preview(error, 120) : '')
    this.emit('ended', task)
    if (unsaved) throw unsaved
  }

  // --- after a run --------------------------------------------------------

  // Looks at the run's checkout once it has ended, whatever the worker wrote:
  // commits on no remote that were not there at its start, uncommitted files
  // that were not there at its start, and whether it is back on its starting
  // branch. What the decisions it follows up were about counts again: a
  // follow-up that was to push and did not is caught too. Without a record
  // of the start (a run of an older version, or git did not answer then),
  // nothing else counts: the driver's own local branches and files are not
  // the run's. Kept with the task, so that the result says the same after a
  // gateway restart; { ok: false } when git does not answer. Then the
  // decision (decide).
  async audit(task) {
    if (task.audit) return task.audit
    // Until it is done, the next queued task there waits.
    this.auditing.add(task.repo)
    const now = await gitState((...args) => this.git(...args), task.dir ?? this.runner.dir(task.repo))
      .catch(() => null)
      .finally(() => this.auditing.delete(task.repo))
    if (!now) {
      task.audit = { ok: false, at: Date.now() }
    } else {
      const carried = new Set([...(task.carried?.commits ?? []), ...(task.carried?.files ?? [])])
      // A set of what was there at the start, or null when that is unknown.
      const known = list => (Array.isArray(list) ? new Set(list) : null)
      const before = known(task.unpushedBefore)
      const dirtyBefore = known(task.startDirty)
      const counts = (seen, item) => carried.has(item) || (seen !== null && !seen.has(item))
      task.audit = {
        ok: true,
        at: Date.now(),
        branch: now.branch,
        startBranch: task.startBranch ?? null,
        remote: now.remote,
        baseline: before !== null && dirtyBefore !== null,
        unpushed: now.unpushed.filter(commit => counts(before, commit.hash)),
        dirty: now.dirty.filter(file => counts(dirtyBefore, file)),
      }
    }
    log('worker audit', task.repo, task.id, auditSummary(task.audit))
    this.decide(task)
    try {
      this.save()
    } catch (error) {
      log('worker state not saved:', error.message) // the audit holds in this gateway
    }
    return task.audit
  }

  // What the audit found becomes a push decision for the driver: commits on
  // no remote (not at read-only, where commits stay in the container by
  // design) and new uncommitted files. It replaces an open one of an earlier
  // audit there. Its text names no branch or file: those come from the run.
  // A commit the driver has decided about already (resolve_decision, or the
  // controller's "done" to their answer) raises none again, unless this run
  // was the follow-up that was to push it. Files need no such list: one left
  // uncommitted is there at the next start, so it is no run's own any more.
  decide(task) {
    if (!this.ledger || task.decision !== undefined) return
    const carried = new Set(task.carried?.commits ?? [])
    const decided = new Set(
      this.ledger.decisions
        .filter(d => d.repo === task.repo && d.state === 'closed' && ['driver', 'reply'].includes(d.closedBy))
        .flatMap(d => d.details?.commits ?? []),
    )
    const fresh = commit => carried.has(commit.hash) || !decided.has(commit.hash)
    const commits = task.audit.ok && task.access !== 'read-only' ? task.audit.unpushed.filter(fresh) : []
    const files = task.audit.ok ? task.audit.dirty : []
    task.decision = null
    if (!commits.length && !files.length) return
    const earlier = this.ledger.forRepo(task.repo).filter(d => d.kind === 'push' && d.details?.task)
    const decision = this.ledger.add({
      kind: 'push',
      repo: task.repo,
      text: pushText(task, commits.length, files.length),
      details: { task: task.id, commits: commits.map(commit => commit.hash), files },
    })
    for (const d of earlier) this.ledger.close(d, { outcome: `replaced by ${decision.id}, after task ${task.id}`, by: 'gateway' })
    task.decision = decision.id
  }

  // --- texts for the controller -------------------------------------------

  async listText() {
    const names = await this.repos()
    const facts = await Promise.all(names.map(name => this.inspect(name)))
    const container = this.runner.container
    const queued = this.queued().length
    const lines = [
      `[workers=${names.length} running=${this.running().length}${queued ? ` queued=${queued}` : ''} max=${this.maxRuns}` +
        `${container ? ` docker=${container}` : ''}]`,
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
    const queued = this.queued(repo)
    const open = this.holds(repo).map(d => `${d.id} (${d.kind}, ${d.state})`)
    const queue = (queued.length ? `; queued: ${queueList(queued)}` : '') + (open.length ? `; open decisions: ${open.join(', ')}` : '')
    if (!task) return `idle${queue}`
    if (task.state === 'running') {
      return `running ${task.id} for ${duration(Date.now() - task.startedAt)} ("${preview(task.task, 50)}")${queue}`
    }
    return `idle, last task ${task.id} ${task.state} ${duration(Date.now() - task.finishedAt)} ago${queue}`
  }

  // The queue of a repository in one line, for stop_worker.
  queueText(repo) {
    const queued = this.queued(repo)
    return queued.length ? `Queued there: ${queueList(queued)}.` : 'Nothing is queued there.'
  }

  statusText(repo) {
    const task = this.lastTask(repo)
    const queued = this.queued(repo)
    if (!task) return `[worker=${repo} state=idle] No task yet.${queued.length ? ` Queued: ${queueList(queued)}.` : ''}`
    const lines = []
    if (task.state === 'running') {
      lines.push(`[worker=${repo} state=running task=${task.id} elapsed=${Math.round((Date.now() - task.startedAt) / 1000)}s]`)
    } else {
      lines.push(`[worker=${repo} state=${task.state} task=${task.id} took=${duration(task.finishedAt - task.startedAt)}]`)
    }
    lines.push(`Task: ${preview(task.task, 200)}`)
    if (task.steps.length) lines.push(`Last steps: ${task.steps.join('; ')}`)
    if (task.audit) lines.push(auditText(task.audit))
    if (task.state === 'running' && task.lastText) lines.push(`Last message: ${task.lastText}`)
    if (task.result) lines.push(`Result: ${task.result}`)
    if (task.error && task.error !== task.result) lines.push(`Problem: ${task.error}`)
    if (queued.length) lines.push(`Queued: ${queueList(queued)}.`)
    return lines.join('\n')
  }

  // The channel event the controller gets when a run ends, with the pull
  // requests it opened or worked on, as gh shows them (pulls.mjs). The
  // gateway's own lines come first, the worker's text after them. A run that
  // was stopped or failed also gets the worker's last message, which may say
  // how far it got.
  resultText(task, pulls = []) {
    const lines = [
      `Worker ${task.repo} finished task ${task.id}: ${task.state} after ${duration(task.finishedAt - task.startedAt)}.`,
      `Task: ${preview(task.task, 200)}`,
    ]
    if (task.audit) lines.push(auditText(task.audit))
    if (task.decision) {
      lines.push(
        `The gateway made it open decision ${task.decision}: ask the driver whether to push (state "question"); ` +
          '"done" is refused until you asked.',
      )
    }
    if (task.result) lines.push(`Result: ${task.result}`)
    if (task.state !== 'done' && task.lastText && task.lastText !== preview(task.result ?? '', 300)) {
      lines.push(`Last message: ${task.lastText}`)
    }
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
  // facts.followed: files of the decisions a follow-up answers (Workers.launch).
  const followed = facts.followed ?? []
  const others = facts.dirty.filter(file => !followed.includes(file))
  const lines = [
    task.trim(),
    '',
    `The driver's own words: "${String(words ?? '').trim()}"`,
    '',
    'Checked by the gateway just now:',
    `- Repository: ${facts.origin ? `${facts.origin} (${visibility})` : 'no remote'}`,
    `- Starting branch: ${facts.branch || 'detached HEAD'}`,
    `- Uncommitted files before you start: ${others.length ? others.join(', ') + ' (not yours, leave them alone)' : 'none'}`,
  ]
  if (followed.length) {
    lines.push(`- Uncommitted files an earlier run left, which this task follows up: ${followed.join(', ')}`)
  }
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
