// Workers: headless Claude Code runs in the git repositories next to this one
// (~/Developer by default), started by the controller through the channel
// tools list_workers, dispatch, worker_status and stop_worker. Optionally they
// run in a Docker container with its own clones instead (runners.mjs), with
// an access level per repository that the GitHub token decides (access.mjs).
// Where a run works is its workspace; its kind says which runner reaches it
// (workspaces.mjs).
//
// Each task is one `claude -p` run in the repository's checkout, without
// approvals. A follow-up resumes the repository's last Claude session, so the
// worker keeps its context. Runs are detached and write stream-json to
// .state/tasks/<id>.jsonl, so they survive a gateway restart, which comes with
// every controller restart; the gateway follows the file and the process id.
//
// A run has ended when its processes have: its own, and every process it
// started (runners.mjs). A result in its output does not end it. Claude Code
// may answer a turn of its own first, such as the notification of a
// background task left over in the session it resumes, and then go on with
// the task in the same process; and a run may leave a server or a test
// running. Until every process is gone, the run counts as running: the rules
// watch it, the kill switch stops it, and nothing else starts in its
// checkout. A run that gave its result and stays without a word, or whose own
// process ended while what it started did not, the gateway ends itself.
// Worker processes in a checkout that belong to no run the gateway follows
// (its state was lost, for example) are ended too, and nothing starts there
// until they are gone.
//
// A task for a repository whose worker is busy, or while every run slot is
// taken, waits in a queue in .state/workers.json and starts by itself when
// it is its turn (pump), so nobody has to remember to send it again. While a
// decision about a repository is open (ledger.mjs), its tasks wait too,
// except the follow-up for the driver's answer to it.
//
// Runs at a time: maxRuns in all (VOICE_GW_MAX_WORKERS), every run of a
// repository counting, and maxPerRepo in one repository
// (VOICE_GW_MAX_WORKERS_PER_REPO, 1 by default: one after the other). With
// more than one, the first run of a repository works in its checkout and
// every further one in a git worktree of its own (worktrees.mjs), with a
// Claude session of its own. The controller says per task whether it may run
// next to the others (parallel), or must wait for some of them (after); a
// task without either waits behind every run and queued task its repository
// had when it came. A run in a worktree that is interrupted (a restart, the
// time limit, a crash, stop_worker) goes back to the queue with its
// worktree, in front for its repository, and resumes there.
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
// While following it, the gateway also counts what a run used, for the
// statistics (stats.mjs): its tool calls, the subagents it started, and the
// tokens, cost and turns of its results, kept with the run.

import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { log, preview } from './log.mjs'
import { SUBAGENT_TOOLS, addResult } from './stats.mjs'
import { DockerRunner, HostRunner, MARK, MAX_FILES, alive, startOf } from './runners.mjs'
import {
  Repositories,
  SCRATCH_NEW,
  SCRATCH_RULES,
  age,
  fileChanges,
  filesSummary,
  filesText,
  kindOf,
  scratchEntries,
  scratchPrompt,
} from './workspaces.mjs'
import {
  WORKTREES,
  isTop,
  listWorktrees,
  makeWorktree,
  orphans,
  removeWorktree,
  worktreeDir,
  worktreeLines,
  worktreesOf,
} from './worktrees.mjs'

const POLL_MS = 1000
// A run that gave its result and has not ended after this long without
// writing anything more is ended by the gateway; normally claude ends at once.
const RESULT_GRACE_MS = 2 * 60 * 1000
const KILL_AFTER_MS = 5000 // SIGTERM to a run's processes, then SIGKILL after this long, again and again
const GITHUB_CACHE_MS = 10 * 60 * 1000 // what gh says about a repository
const MAX_STEPS = 5
const KEEP_TASKS = 40
const MAX_UNPUSHED = 200 // commits on no remote that the audit lists
const PAUSE_MS = 30 * 1000 // the queue waits this long when the worker container does not answer
const SWEEP_MS = 10 * 60 * 1000 // how often old work folders are looked for
const DAY_MS = 24 * 60 * 60 * 1000
const SCRATCH_SHOWN = 10 // work folders list_workers names, the last used first
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const MAX_RESUMES = 3 // an interrupted run in a worktree goes back to the queue at most this often
const TASK_ID = /^[tq][a-z0-9]{3}$/

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

// How a worker opens a pull request (VOICE_GW_PR_DRAFT): ready for review by
// default, so that automatic reviews start at once, and as a draft only when
// the task's prompt says "Draft pull request: yes" (dispatch's draft); as a
// draft with the setting, in the words of the rules from before it.
const OPEN_PR = {
  ready:
    'open a pull request ready for review against the starting branch with\n  gh pr create, not as a draft. Only if ' +
    'the task says "Draft pull request: yes", the driver asked for a draft:\n  open it as a draft then, and leave it ' +
    'one until a task says to mark it ready.',
  draft: 'open a draft pull request against the starting branch with\n  gh pr create --draft.',
}

// The same for the controller and the worker's prompt.
export const pullRequestKind = draft => (draft ? 'a draft pull request' : 'a pull request ready for review')

// Why a draft (dispatch's draft) changes nothing for a run, or null: there is
// no pull request to open.
export function draftIgnored(facts, direct = false) {
  if (facts.access?.level === 'read-only') return 'nothing leaves the container at access level read-only'
  if (facts.pushDirect) {
    return `pull requests are turned off on GitHub, the change goes straight to ${facts.defaultBranch || 'the default branch'}`
  }
  if (direct) return 'a direct push opens no pull request'
  if (!facts.origin) return 'the repository has no remote, so nothing is pushed'
  return null
}

export const WORKER_RULES = `
You are a worker. The driver of a car gave this task by voice; a controller session passed it on and will
summarise your result for them. Nobody can answer you during the run.

- If you need a decision, stop and end with the question and the options. The answer comes back as a
  follow-up in this session.
- Git: start from the branch the checkout is on (named in the task; it may be dev rather than main). For
  changes, create a branch voice/<short-name> and commit there. Commit only your own changes: never commit,
  stash, reset or discard files you did not change. Never commit to the starting branch or the default
  branch. Never force-push, merge or delete branches. A follow-up continues on the same voice branch.
- Publish: push the branch and ${OPEN_PR.ready} If the task says the repository is public or its visibility is unknown, do not push:
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
    Publish: `- Publish: push the branch and ${OPEN_PR.ready} Only if the task says "Direct push: yes", the driver explicitly asked for it: commit
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
// pull requests are turned off. draft: every pull request as a draft
// (VOICE_GW_PR_DRAFT=1); a single task's draft is a line in its prompt.
// worktree: a run in a worktree of its own, which stays on its branch at the
// end; its prompt says how it works there (worktrees.mjs).
export function workerRules(level, { pushDirect = false, draft = false, worktree = false } = {}) {
  const replace = pushDirect ? DIRECT_RULES : CONTAINER_RULES[level]
  let rules = replace
    ? WORKER_RULES.split('\n- ')
        .map((rule, i) => {
          const name = /^(\w+):/.exec(rule)?.[1]
          return i > 0 && replace[name] ? replace[name].slice(2) : rule
        })
        .join('\n- ')
    : WORKER_RULES
  if (worktree) {
    rules = rules
      .split('\n- ')
      .filter(rule => !rule.startsWith('At the end, switch back'))
      .join('\n- ')
  }
  return draft ? rules.replace(OPEN_PR.ready, OPEN_PR.draft) : rules
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`
const randomId = length => Array.from({ length }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('')
const originName = slug => slug ?? 'no GitHub remote'

// How a queued task waits, in a few words, or '': next to the others, after
// named ones, or as an interrupted run that resumes in its worktree.
export function queueMarks(entry) {
  if (entry.requeued) return `resumes ${entry.continues} in its worktree`
  if (entry.after?.length) return `after ${entry.after.join(', ')}`
  if (entry.parallel) return 'parallel'
  return ''
}

// Queued tasks in a list, first the next: q2ab ("Run the tests."), …; with
// the repositories when they are not all the same, and how they wait when
// it is not behind the others.
export const queueList = (entries, { max = 5, repos = false, length = 50 } = {}) =>
  entries
    .slice(0, max)
    .map(entry => {
      const marks = queueMarks(entry)
      return `${entry.id}${repos ? ` for ${entry.worker}` : ''}${marks ? ` [${marks}]` : ''} ("${preview(entry.task, length)}")`
    })
    .join(', ') + (entries.length > max ? `, and ${entries.length - max} more` : '')

// Runs in a list: t2ab ("Run the tests."), t3cd in a worktree (…).
export const runList = (tasks, { length = 50 } = {}) =>
  tasks.map(t => `${t.id}${t.worktree ? ' in a worktree' : ''} ("${preview(t.task, length)}")`).join(', ')

// Task ids in a text: t… and q…, separated by commas or spaces. null when one
// is not an id.
export function taskIds(text) {
  const list = Array.isArray(text) ? text : String(text ?? '').split(/[\s,]+/)
  const ids = [...new Set(list.map(id => String(id).trim().toLowerCase()).filter(Boolean))]
  return ids.every(id => TASK_ID.test(id)) ? ids : null
}

// What the controller hears when a queued task could not start and left the
// queue: the controller's own task, which may quote a worker (so the event is
// trusted="no"), and the gateway's reason. decision: the open decision it
// became.
export function parkedText(entry, why, status, decision = null) {
  const hint =
    status === 'dirty'
      ? 'If the driver says to go ahead anyway, dispatch it again with allow_dirty and their words.'
      : 'If the driver still wants it, dispatch it again with their words.'
  const draft = entry.draft ? ' It was to open its pull request as a draft: pass draft again.' : ''
  const resume = entry.requeued
    ? ` It was to resume task ${entry.continues} in its worktree, which is kept: pass continues="${entry.continues}" to ` +
      'finish it there.'
    : ''
  return (
    `The queued task ${entry.id} for ${entry.worker} did not start: ${why}. It has left the queue. ` +
    `Task: "${preview(entry.task, 200)}". Tell the driver and ask what to do. ${hint}${draft}${resume}` +
    (decision?.repo
      ? ` It is open decision ${decision.id} now, and other tasks for ${entry.worker} wait until it is closed: ` +
        'the follow-up for the answer closes it, or resolve_decision.'
      : decision
        ? ` It is open decision ${decision.id} now, which holds nothing: the follow-up for the answer closes it, or ` +
          'resolve_decision.'
        : '')
  )
}

// The push decision after a run, in the gateway's words.
function pushText(task, commits, files) {
  const left = [commits && plural(commits, 'commit') + ' on no remote', files && plural(files, 'new uncommitted file')]
  const what = left.filter(Boolean).join(' and ')
  const ask = task.access === 'read-only' ? 'Commit them in the container' : commits ? 'Push them' : 'Commit and push them'
  const where = task.worktree ? ` in its worktree (${task.dir})` : ''
  return `${task.repo}: task ${task.id} left ${what}${where}. ${ask}, or leave them as they are?`
}

// A queued task that could not start, as an open decision.
const parkedDecision = (entry, why) =>
  `The queued task ${entry.id} for ${entry.worker} did not start: ${why}. Task: "${preview(entry.task, 120)}". ` +
  (entry.requeued ? `It was to resume task ${entry.continues} in its worktree, which is kept. ` : '') +
  'Dispatch it again, or let it go?'

// A run in a worktree that the kill switch stopped, as an open decision.
const lockedDecision = task =>
  `The kill switch stopped task ${task.id} for ${task.repo} in its worktree (${task.dir}), which is kept with what it ` +
  `did. Task: "${preview(task.task, 120)}". Dispatch it again with continues="${task.id}" to finish it there, or let ` +
  'it go?'

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

// How a saved queue entry waits, as far as it can be used: lists of ids, an
// id of a task and of a worktree. Anything else counts as not given.
function queueEntry(entry) {
  const ids = list => (Array.isArray(list) && list.every(id => typeof id === 'string' && TASK_ID.test(id)) ? list : null)
  const id = value => (typeof value === 'string' && /^t[a-z0-9]{3}$/.test(value) ? value : null)
  const out = { ...entry, parallel: entry.parallel === true, after: ids(entry.after), behind: ids(entry.behind) }
  out.continues = id(entry.continues)
  out.worktree = id(entry.worktree)
  if (!out.worktree || !out.continues) delete out.requeued
  return out
}

// The worktrees the state may hold: id -> { repo, dir, sessionId,
// resumable, task, branch, createdAt, removedAt }; anything else is left out.
function worktreeEntries(saved) {
  const entries = Object.create(null)
  for (const [id, wt] of Object.entries(saved ?? {})) {
    if (!/^t[a-z0-9]{3}$/.test(id) || typeof wt?.repo !== 'string' || typeof wt.dir !== 'string') continue
    if (!wt.dir.split('/').includes(WORKTREES) || !wt.dir.endsWith(`/${id}`)) continue
    entries[id] = {
      repo: wt.repo,
      dir: wt.dir,
      sessionId: typeof wt.sessionId === 'string' ? wt.sessionId : null,
      resumable: wt.resumable === true,
      task: typeof wt.task === 'string' ? wt.task : id,
      branch: typeof wt.branch === 'string' ? wt.branch : null,
      createdAt: Number.isFinite(wt.createdAt) ? wt.createdAt : Date.now(),
      removedAt: Number.isFinite(wt.removedAt) ? wt.removedAt : null,
    }
  }
  return entries
}

export function githubSlug(url) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '')
  return match ? match[1] : null
}

// marks: the run's marks (runners.mjs), which everything it starts inherits.
function workerEnv(marks = {}) {
  const env = { ...process.env }
  for (const name of SESSION_ENV) delete env[name]
  return { ...env, ...marks }
}

const processes = n => `${n} process${n === 1 ? '' : 'es'}`

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
// worktrees, for example) are not the driver's to push, and for a run in a
// worktree, whose work is what its HEAD has. exclude: commits whose own
// commits do not count, the HEADs of the other runs' worktrees.
export async function gitState(git, dir, { current = false, exclude = [] } = {}) {
  const [branch, status, remotes] = await Promise.all([
    git(dir, 'branch', '--show-current'),
    git(dir, 'status', '--porcelain'),
    git(dir, 'remote'),
  ])
  if (status === null || remotes === null) return null
  const remote = remotes.trim() !== ''
  const refs = current ? ['HEAD'] : ['--branches']
  const log = remote
    ? await git(dir, 'log', ...refs, '--not', '--remotes', ...exclude, '--source', `--max-count=${MAX_UNPUSHED}`, '--format=%h %S')
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
    scratch = null,
    dockerBin = 'docker',
    sweepMs = SWEEP_MS,
    access = null,
    killswitch = null,
    ledger = null,
    stateDir,
    claudeBin = 'claude',
    ghBin = 'gh',
    model = '',
    effort = '',
    prDraft = false,
    maxRuns = 2,
    maxPerRepo = 1,
    timeoutMinutes = 360, // 0: no time limit
    resultGraceMs = RESULT_GRACE_MS,
    killAfterMs = KILL_AFTER_MS,
  }) {
    super()
    this.runner = runner // the repositories'
    // The kinds of workspace, by name (workspaces.mjs); work folders only
    // when they are on.
    this.kinds = { repo: new Repositories(runner) }
    this.scratch = scratch // ScratchFolders, or null
    this.dockerBin = dockerBin // for a run in a container its kind no longer uses (runnerOf)
    this.elsewhere = new Map() // container or '' -> the runner for such runs
    this.sweepMs = sweepMs
    this.sweptAt = 0
    this.sweeping = null // old work folders being removed
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
    this.prDraft = prDraft // pull requests as drafts (VOICE_GW_PR_DRAFT=1)
    this.maxRuns = maxRuns // runs at a time, in all
    this.maxPerRepo = maxPerRepo // runs at a time in one repository
    this.timeoutMs = timeoutMinutes * 60 * 1000
    this.resultGraceMs = resultGraceMs
    this.killAfterMs = killAfterMs
    this.github = new Map() // owner/repo -> { at, info: { visibility, pulls, branch } }
    this.starting = new Set() // repositories between the checks and the start
    this.auditing = new Map() // repository -> how many of its runs the audit looks at
    this.audits = new Map() // task id -> its audit going
    this.preparing = new Set() // task ids whose worktree this gateway is making
    this.tidying = null // kept worktrees being looked at (tidyKept)
    this.removing = new Set() // worktree ids being removed
    this.pumping = false // a queued task is being started
    this.pausedUntil = 0 // the queue waits for the worker container
    this.followed = new Map() // task id -> { offset, partial }
    this.strays = new Map() // checkout -> { at, signalled }: worker processes of no run followed here, being ended
    this.cleaning = new Map() // repository -> what the runner still clears up after a run there (the container)
    this.swept = false // the first poll looks for strays
    this.state = this.load()
    if (scratch) {
      scratch.entries = this.state.scratch // kept and saved with the rest
      this.kinds.scratch = scratch
    }
    // The queue was planned for the limit per repository in the state (one
    // at a time before there was one). Raised since: the controller hears
    // which queued tasks could now run next to others (replan); lowered:
    // they run one after the other again, by themselves.
    const planned = this.state.perRepo ?? 1
    this.replan = maxPerRepo > planned ? this.planFor(planned) : null
    if (maxPerRepo !== planned) {
      log(
        `runs per repository ${maxPerRepo > planned ? 'raised' : 'lowered'} from ${planned} to ${maxPerRepo} since the queue ` +
          `was planned${this.replan ? '; the controller hears which queued tasks could run next to others' : ''}` +
          (maxPerRepo < planned ? '; runs going run to the end, and nothing new starts in a repository above the limit' : ''),
      )
    }
    if (!this.replan) this.state.perRepo = maxPerRepo
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
  // queue: the tasks waiting for their turn, in order. scratch: the work
  // folders (workspaces.mjs), also while they are turned off, so that they
  // are known again when turned on. worktrees: the worktrees of runs, by the
  // id of the task that made them, also once removed, so that a follow-up
  // makes its worktree again at the same path, with its session. perRepo:
  // the limit per repository the queue was planned for.
  load() {
    const origins = data => Object.assign(Object.create(null), data?.origins)
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      const queue = (Array.isArray(data.queue) ? data.queue : []).filter(queuable).map(queueEntry)
      const perRepo = Number.isInteger(data.perRepo) && data.perRepo >= 1 ? data.perRepo : undefined
      return {
        repos: data.repos ?? {},
        tasks: data.tasks ?? [],
        origins: origins(data),
        queue,
        scratch: scratchEntries(data.scratch),
        worktrees: worktreeEntries(data.worktrees),
        perRepo,
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log('worker state unreadable, starting empty:', error.message)
      return { repos: {}, tasks: [], origins: origins(null), queue: [], scratch: scratchEntries(null), worktrees: worktreeEntries(null) }
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
    // A removed worktree is kept in mind while a task of it is.
    for (const [id, wt] of Object.entries(this.state.worktrees)) {
      if (wt.removedAt && !this.state.tasks.some(t => t.worktree === id)) delete this.state.worktrees[id]
    }
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
      const id = prefix + randomId(3)
      const taken = this.state.tasks.some(t => t.id === id) || this.state.queue.some(q => q.id === id)
      if (!taken && !Object.hasOwn(this.state.worktrees, id)) return id
    }
  }

  running() {
    return this.state.tasks.filter(t => t.state === 'running')
  }

  // The runs going in a repository: in its checkout and its worktrees.
  runsOf(repo) {
    return this.running().filter(t => t.repo === repo)
  }

  lastTask(repo) {
    return this.state.tasks.findLast(t => t.repo === repo) ?? null
  }

  taskById(id) {
    return this.state.tasks.find(t => t.id === id) ?? null
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

  // --- workspaces ---------------------------------------------------------

  // The kind whose name it is, or null (workspaces.mjs).
  workspace(name) {
    return Object.values(this.kinds).find(kind => kind.owns(name)) ?? null
  }

  // The runner that reaches a run's workspace: of its kind, by its record. A
  // run that began where its kind no longer runs, turned off since, or moved
  // to or from a container, is reached where it runs, as its record says.
  runnerOf(task) {
    const runner = this.kinds[kindOf(task)]?.runner
    const where = task?.container
    if (runner && (where === undefined || where === (runner.container ?? null))) return runner
    if (!runner && where === undefined) return this.runner // nothing says otherwise
    const key = where ?? ''
    if (!this.elsewhere.has(key)) {
      const root = task.dir ? (where ? posix.dirname(task.dir) : dirname(task.dir)) : '/'
      this.elsewhere.set(key, where ? new DockerRunner({ container: where, root, dockerBin: this.dockerBin }) : new HostRunner(root))
    }
    return this.elsewhere.get(key)
  }

  dirOf(name) {
    return (this.workspace(name) ?? this.kinds.repo).dir(name)
  }

  // The names of the kind that `name` belongs to, for checking it; the
  // repositories for a name of no kind. Throws when the worker container does
  // not answer.
  async known(name) {
    return (this.workspace(name) ?? this.kinds.repo).names()
  }

  // Every runner, once.
  runners() {
    return [...new Set(Object.values(this.kinds).map(kind => kind.runner))]
  }

  // --- repositories -------------------------------------------------------

  // Throws when the worker container does not answer.
  repos() {
    return this.kinds.repo.names()
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
  // and goes before the tasks they hold. draft: its pull request opens as a
  // draft; kept with a queued task like the rest.
  //
  // In a repository, how it waits for the others there (with more than one
  // run per repository; with one they run one after the other anyway):
  // parallel, next to them; after, only for the tasks named (t… runs, q…
  // queued tasks); neither, behind every run and queued task the repository
  // has now. continues: the task (t…) whose place and session it continues,
  // its worktree if it ran in one; answered: the task whose result the
  // driver's answer is about, which it continues unless continues names one.
  async dispatch({
    worker,
    task,
    words,
    fresh = false,
    allowDirty = false,
    direct = false,
    draft = false,
    request = null,
    answers = null,
    parallel = false,
    after = null,
    continues = null,
    answered = null,
  }) {
    if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
    const names = await this.known(worker)
    if (!names.includes(worker)) return { status: 'unknown', names }
    const job = { worker, task, words, fresh, allowDirty, direct, draft, request, answers }
    if (this.workspace(worker)?.kind !== 'scratch') {
      const order = this.checkOrder(worker, { after, continues })
      if (order.problems.length) return { status: 'order', problems: order.problems }
      const fromAnswer = !continues && answered && this.taskById(answered)?.repo === worker ? answered : null
      Object.assign(job, { parallel: Boolean(parallel), after: order.after.length ? order.after : null, continues: order.continues ?? fromAnswer })
    }
    const first = this.follows(worker, answers).length > 0
    const why = this.blocked(job, { first })
    if (why) return this.enqueue(job, why, { first })
    const result = await this.launch(job)
    // Worker processes of a run nobody followed were still in the checkout.
    if (result.status === 'busy') return this.enqueue(job, 'busy', { first })
    return result
  }

  // Whether the tasks a dispatch names are of its repository: after, runs
  // (t…, also ended ones) and queued tasks (q…); continues, a run the gateway
  // still knows. { after, continues, problems }.
  checkOrder(repo, { after = null, continues = null } = {}) {
    const problems = []
    const ids = after === null || after === '' ? [] : taskIds(after)
    if (ids === null) problems.push(`after takes task ids, t… or q…, separated by commas: "${preview(String(after), 60)}"`)
    for (const id of ids ?? []) {
      const known = id.startsWith('q') ? this.queued(repo).some(e => e.id === id) : this.taskById(id)?.repo === repo
      if (!known) problems.push(`${id} is no ${id.startsWith('q') ? 'queued task' : 'task'} of ${repo}`)
    }
    let run = null
    if (continues) {
      run = String(continues).trim().toLowerCase()
      if (this.taskById(run)?.repo !== repo) problems.push(`${preview(run, 20)} is no task of ${repo} that the gateway still knows`)
    }
    return { after: ids ?? [], continues: run, problems }
  }

  // The decisions that the driver's answer on request `answers` is about, of
  // this repository or of none: the follow-up's start closes them.
  follows(repo, answers) {
    if (!answers || !this.ledger) return []
    return this.ledger.forRequest(answers, { closed: true }).filter(d => d.repo === repo || d.repo === null)
  }

  // The open decisions that hold a repository's tasks: all of them, except
  // those that a follow-up answers. One about a worktree (a run there left
  // something) holds only the tasks that go there, given an entry: the
  // others run elsewhere.
  holds(repo, answers = null, entry = null) {
    const place = entry ? this.placeOf(entry) : null
    return (
      this.ledger?.forRepo(repo).filter(d => {
        if (answers && d.requests.includes(answers)) return false
        const worktree = d.details?.worktree
        return !worktree || !place || place.worktree === worktree
      }) ?? []
    )
  }

  // The checks before a run, and the start: for a dispatch, and for a queued
  // task when it is its turn (entry). Where it runs: in the repository's
  // checkout, or in a worktree (worktrees.mjs), its own one for a task that
  // continues a run there, a new one when the checkout is taken. The
  // checkout's uncommitted files are a question only for a run there; a
  // worktree is the task's own.
  async launch(job, entry = null) {
    const { worker, task, words, fresh = false, allowDirty = false, direct = false, draft = false, answers = null } = job
    if (this.workspace(worker)?.kind === 'scratch') return this.launchScratch({ worker, task, words, fresh, answers }, entry)
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
      let place = this.placeOf(job)
      if (place === 'any') place = this.checkoutTaken(worker) ? { worktree: null } : 'main'
      if (place === 'main' && this.checkoutTaken(worker)) return { status: 'busy' }
      // What the last run in the container left there is cleared first.
      await this.cleaning.get(worker)
      if (place !== 'main') {
        facts.decided = [...decided]
        const dir = place.worktree ? this.worktreeOf(place.worktree, worker) : null
        if (dir && this.stopStrays({ dir, why: 'found before a new run there' }).length) return { status: 'busy', strays: true }
        return this.start(facts, { task, words, fresh, direct, draft, answers }, entry, place)
      }
      facts.followed = facts.dirty.filter(file => decided.has(file))
      const foreign = facts.dirty.filter(file => !decided.has(file))
      if (foreign.length && !allowDirty) return { status: 'dirty', files: foreign }
      facts.unpushed = await this.baseline(facts.dir)
      // Never a second run in a checkout where a worker process still runs:
      // one of a run nobody follows is ended, and the task waits for it.
      if (this.stopStrays({ dir: facts.dir, why: 'found before a new run there' }).length) return { status: 'busy', strays: true }
      return this.start(facts, { task, words, fresh, direct, draft, answers }, entry)
    } finally {
      this.starting.delete(worker)
    }
  }

  // Where a task must run: 'main', the repository's checkout, for one that
  // continues a run there; { worktree } for one that continues a run in a
  // worktree, or resumes it; 'any' otherwise: the checkout when it is free,
  // else a new worktree.
  placeOf(entry) {
    if (entry.worktree) return { worktree: entry.worktree }
    if (entry.continues) {
      const task = this.taskById(entry.continues)
      if (task?.worktree) return { worktree: task.worktree }
      if (task) return 'main'
    }
    return 'any'
  }

  // Whether a run goes in the repository's checkout, or worker processes of
  // a run nobody follows are being ended there.
  checkoutTaken(repo) {
    return this.runsOf(repo).some(t => !t.worktree) || this.strays.has(this.dirOf(repo))
  }

  // The folder of a worktree, as the state has it, or where it is made.
  worktreeOf(id, repo) {
    return this.state.worktrees[id]?.dir ?? worktreeDir(this.runner, repo, id)
  }

  // A task in a work folder: a new one for scratch/new, made now, or the one
  // it names, for a follow-up. There is no git to check; the files there now
  // are kept, so that the look after the run tells what it made. Any number
  // of new ones may start at once, within the run slots: each is a starting
  // of its own. A new folder whose run did not start goes again.
  async launchScratch({ worker, task, words, fresh = false, answers = null }, entry = null) {
    const isNew = worker === SCRATCH_NEW
    const key = isNew ? Symbol(worker) : worker
    this.starting.add(key)
    let made = null
    try {
      if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
      if (entry && !this.state.queue.some(waiting => waiting.id === entry.id)) return { status: 'dropped' }
      if (isNew) {
        made = await this.scratch.make(() => randomId(4))
        this.save()
      }
      const name = made?.name ?? worker
      const dir = made?.dir ?? this.dirOf(name)
      const files = made ? [] : await this.scratch.runner.files(dir)
      if (!files) return { status: 'gone', why: 'its folder cannot be read; it may have been removed at the desk' }
      if (this.stopStrays({ dir, why: 'found before a new run there' }).length) return { status: 'busy', strays: true }
      const facts = { kind: 'scratch', name, dir, hostDir: this.scratch.hostDir(name), files, made: Boolean(made), where: this.scratch.where() }
      const result = this.start(facts, { task, words, fresh, answers }, entry)
      if (result.status === 'started') made = null
      return result
    } finally {
      this.starting.delete(key)
      if (made) this.dropScratch(made.name)
    }
  }

  // A work folder away again, with its entry.
  dropScratch(name) {
    this.scratch
      .remove(name)
      .then(removed => {
        if (!removed) return
        delete this.state.repos[name]
        this.save()
      })
      .catch(error => log('work folder not removed:', name, error.message))
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

  // facts: what launch found, of a repository (inspect) or of a work folder
  // (launchScratch, of kind scratch), which has its own rules and prompt.
  // place: 'main', the repository's checkout (or the work folder); or
  // { worktree }, a worktree by its id, null for a new one. A run in a
  // worktree starts at once as a record, and its worktree is made (or found
  // again) before claude starts in it (prepare); until then it is
  // "preparing", and counts as running.
  start(facts, { task, words, fresh, direct = false, draft = false, answers = null }, entry = null, place = 'main') {
    if (this.killswitch?.locked) return { status: 'locked', state: this.killswitch.state }
    if (entry && !this.state.queue.some(waiting => waiting.id === entry.id)) return { status: 'dropped' }
    const id = this.newTaskId()
    const kind = kindOf(facts)
    const scratch = kind === 'scratch'
    if (scratch) direct = draft = false // nothing to push in a work folder
    const runner = this.runnerOf({ kind })
    // A worktree has a session of its own, as does the repository's checkout.
    const wid = place === 'main' || scratch ? null : (place.worktree ?? id)
    const wt = wid ? this.state.worktrees[wid] : null
    const previous = fresh ? null : wid ? (wt?.resumable ? wt.sessionId : null) : this.state.repos[facts.name]?.sessionId
    const sessionId = previous || randomUUID()
    const dir = wid ? (wt?.dir ?? worktreeDir(runner, facts.name, wid)) : facts.dir
    const record = {
      id,
      kind, // of its workspace (workspaces.mjs)
      repo: facts.name, // the workspace's name
      container: runner.container ?? null, // where it runs: the container, or null for this computer
      task,
      words,
      state: 'running', // until every process of the run has ended (check)
      pid: null,
      pidStart: null, // to tell it from a later process with the same id
      mark: randomUUID(), // VOICE_GW_RUN of every process of the run
      sessionId,
      resumed: Boolean(previous),
      access: facts.access?.level ?? null,
      direct,
      draft, // the driver asked for a draft pull request (dispatch's draft)
      pushDirect: Boolean(facts.pushDirect), // pull requests turned off: commits go to the default branch
      dir,
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
      file: join(this.tasksDir, `${id}.jsonl`),
      errFile: join(this.tasksDir, `${id}.err`),
      steps: [],
      lastText: '',
      result: null,
      error: null,
      reported: false,
    }
    if (wid) {
      record.worktree = wid // the worktree it runs in, by the task that made it
      record.checkout = facts.dir // the repository's checkout, whose git the worktree shares
      record.preparing = true
      // As the worktree is when the run starts (prepare).
      Object.assign(record, { startBranch: null, startDirty: null, unpushedBefore: null })
    }
    if (entry) Object.assign(record, { queued: entry.id, queuedAt: entry.queuedAt }) // it waited in the queue as this, since then
    if (entry?.requeued) Object.assign(record, { resumes: entry.resumes ?? 1, requeued: entry.requeued })
    if (scratch) {
      // For the look at the end: the files as the run found them.
      record.hostDir = facts.hostDir ?? null // the folder on this computer
      record.startFiles = facts.files
      const used = this.scratch.entry(facts.name)
      if (used) used.usedAt = record.startedAt
    }
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
    const job = { task, words, direct, draft }
    if (!wid) this.spawnRun(record, facts, job) // before the record is kept: a run that cannot start is no run
    this.state.tasks.push(record)
    if (wid) {
      const now = record.startedAt
      this.state.worktrees[wid] = {
        ...(wt ?? { repo: facts.name, branch: null, createdAt: now, removedAt: null }),
        dir,
        sessionId,
        resumable: Boolean(previous),
        task: id,
      }
    } else {
      this.state.repos[facts.name] = { sessionId }
    }
    if (entry) this.state.queue = this.state.queue.filter(waiting => waiting.id !== entry.id)
    this.save()
    const queued = entry ? [`queued as ${entry.id}`] : []
    const where = wid ? [wt ? `in its worktree ${wid}` : 'in a new worktree'] : []
    log('worker start', facts.name, id, previous ? 'resumed session' : 'new session', ...where, ...queued, preview(task, 60))
    if (wid) {
      this.preparing.add(id)
      this.prepare(record, facts, job, entry).finally(() => this.preparing.delete(id))
    } else {
      this.emit('started', record)
    }
    const others = this.runsOf(facts.name).filter(t => t !== record)
    return { status: 'started', task: record, facts, closed: closed.map(d => d.id), others }
  }

  // Starts claude for a run whose record is made, in its folder.
  spawnRun(record, facts, { task, words, direct = false, draft = false }) {
    const scratch = kindOf(record) === 'scratch'
    const runner = this.runnerOf(record)
    const rules = scratch
      ? SCRATCH_RULES
      : workerRules(facts.access?.level, { pushDirect: facts.pushDirect, draft: this.prDraft, worktree: Boolean(record.worktree) })
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 })
    const out = openSync(record.file, 'a', 0o600)
    const err = openSync(record.errFile, 'a', 0o600)
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--settings', JSON.stringify({ permissions: { deny: WORKER_DENY } }),
      '--append-system-prompt', rules,
      ...(this.model ? ['--model', this.model] : []),
      ...(this.effort ? ['--effort', this.effort] : []),
      ...(record.resumed ? ['--resume', record.sessionId] : ['--session-id', record.sessionId]),
    ]
    const env = workerEnv({ [MARK.run]: record.mark, [MARK.task]: record.id, [MARK.repo]: record.dir })
    let child
    try {
      child = runner.spawn(record.id, this.claudeBin, args, { cwd: record.dir, stdio: ['pipe', out, err], env })
    } finally {
      closeSync(out)
      closeSync(err)
    }
    record.pid = child.pid ?? null
    record.pidStart = startOf(child.pid)
    child.on('error', error => this.finish(record, 'failed', `could not start ${error.path || this.claudeBin}: ${error.message}`))
    child.stdin.on('error', () => {}) // the run may end before it read everything
    child.stdin.end(scratch ? scratchPrompt({ task, words, facts }) : prompt({ task, words, facts, direct, draft, prDraft: this.prDraft }))
    child.unref()
  }

  // The branch a worktree starts from: the one the repository's checkout
  // would start from (the run there started from it), the default branch
  // where pushes go straight to it, or when that is a voice/ branch or none.
  baseBranch(facts, record) {
    const primary = this.runsOf(facts.name).find(t => !t.worktree)
    let branch = primary ? primary.startBranch : facts.branch
    if (facts.pushDirect || record.direct) branch = facts.defaultBranch || branch
    if (!branch || branch.startsWith('voice/')) branch = facts.defaultBranch || branch || null
    return branch
  }

  // Makes the worktree of a run, or finds it again, then starts claude in
  // it. Its git commands carry the run's marks, so that a stop or the kill
  // switch ends them. A run stopped meanwhile does not start; one whose
  // worktree cannot be made fails, and does not go back to the queue.
  async prepare(record, facts, job, entry) {
    const runner = this.runnerOf(record)
    const wt = this.state.worktrees[record.worktree]
    const env = { [MARK.run]: record.mark, [MARK.task]: record.id, [MARK.repo]: record.dir }
    const branch = this.baseBranch(facts, record)
    record.startFrom = branch // where its pull request goes, as the checkout's run's would
    let made
    try {
      made = await makeWorktree(runner, {
        main: facts.dir,
        dir: record.dir,
        branch,
        again: wt?.removedAt ? wt.branch : null,
        remote: Boolean(facts.origin),
        env,
      })
    } catch (error) {
      made = { ok: false, error: error.message }
    }
    try {
      if (record.state !== 'running') return
      if (record.stopping || this.killswitch?.locked) {
        return this.finish(record, 'stopped', record.stopping?.reason ?? 'kill switch')
      }
      if (!made.ok) {
        record.prepFailed = true
        return this.finish(record, 'failed', `its worktree could not be made: ${made.error}`)
      }
      // The worktree as the run finds it: everything in it is the task's,
      // and for a run that resumes an interrupted one, all of it counts as
      // its own at the end.
      const now = await gitState((...args) => this.git(...args), record.dir, { current: true })
      const resumed = Boolean(entry?.requeued)
      Object.assign(record, {
        base: made.base,
        startDirty: resumed ? [] : (now?.dirty ?? null),
        unpushedBefore: resumed ? [] : now ? now.unpushed.map(commit => commit.hash) : null,
        submodules: made.submodules,
      })
      if (wt) wt.removedAt = null
      const followed = (facts.decided ?? []).filter(file => now?.dirty.includes(file))
      const worktree = {
        dir: record.dir,
        target: branch,
        base: made.base ?? 'the branch its last run left',
        created: made.created,
        again: made.created && Boolean(wt?.branch && made.base === wt.branch),
        fetched: made.fetched,
        submodules: made.submodules,
        resumed: entry?.requeued?.why ?? null,
        resumedSession: record.resumed,
      }
      const promptFacts = { ...facts, dirty: now?.dirty ?? [], followed, worktree }
      if (record.state !== 'running') return
      if (record.stopping || this.killswitch?.locked) return this.finish(record, 'stopped', record.stopping?.reason ?? 'kill switch')
      record.preparing = false
      this.spawnRun(record, promptFacts, job)
      const subs = made.submodules?.length ? `, submodules ${made.submodules.map(s => `${s.path} ${s.ok ? s.how : 'failed'}`).join(', ')}` : ''
      log('worker worktree', record.repo, record.id, made.created ? `made from ${made.base}` : 'found again', record.dir + subs)
      this.save()
      this.emit('started', record)
    } catch (error) {
      log('worker', record.repo, record.id, 'did not start in its worktree:', error.message)
      record.prepFailed = true
      this.finish(record, 'failed', `it could not start in its worktree: ${error.message}`)
    }
  }

  // Stopped by the controller, which knows and needs no event (by the time
  // limit, see check). The run gets its signals at once and ends once all its
  // processes are gone, which ended() waits for. task: only the run with
  // this id; otherwise every run of the repository. drop: a run in a
  // worktree does not go back to the queue. Returns the runs.
  stopRuns(worker, { task = null, reason = 'stopped by the controller', report = false, drop = false } = {}) {
    const runs = this.runsOf(worker).filter(t => !task || t.id === task)
    for (const run of runs) this.halt(run, { reason, report, drop })
    return runs
  }

  // As stopRuns, the first of them, or null; for one run per repository.
  stop(worker, options = {}) {
    return this.stopRuns(worker, options)[0] ?? null
  }

  // SIGTERM to every process of the run, then SIGKILL every killAfterMs
  // until they are gone (check), also from the next gateway, as it is kept in
  // the state. reason: why it was stopped, its outcome then; null for a run
  // the gateway only makes end, whose result counts. report: whether the
  // controller hears about the stop as an event. drop: a run in a worktree
  // stays out of the queue; lock: the kill switch stopped it. The signals go
  // out before the state is saved; an error in saving comes after them.
  halt(task, { reason = null, report = false, drop = false, lock = false } = {}) {
    const now = Date.now()
    if (!task.stopping) task.stopping = { reason, at: now, signalled: now }
    else if (reason && !task.stopping.reason) task.stopping.reason = reason // the gateway's end becomes a stop
    if (drop) task.stopping.drop = true
    if (lock) task.stopping.lock = true
    if (reason) task.reported = !report
    this.runnerOf(task).stop(task, 'SIGTERM')
    this.save()
  }

  // Waits until the run has ended, at most ms; whether it has.
  async ended(task, ms = 15000) {
    for (const until = Date.now() + ms; task.state === 'running' && Date.now() < until; ) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try {
        this.check(task)
      } catch (error) {
        log('following worker runs failed:', error.message)
      }
    }
    return task.state !== 'running'
  }

  // The kill switch: every run stops, and so do worker processes of runs
  // nobody follows here. The controller hears about it once, from the
  // gateway, not per run. Every run gets its signals before the state is
  // saved; an error in saving comes after that. Runs whose processes are
  // gone already end at once, the others with the next polls. A run in a
  // worktree keeps it, and becomes an open decision (finish).
  stopAll(reason) {
    const stopped = this.running()
    let failed = null
    const attempt = action => {
      try {
        action()
      } catch (error) {
        failed ??= error
      }
    }
    for (const task of stopped) attempt(() => this.halt(task, { reason, lock: true }))
    attempt(() => this.stopStrays({ why: 'the kill switch locked' }))
    for (const task of stopped) attempt(() => this.check(task))
    if (failed) throw failed
    return stopped
  }

  // --- the queue ----------------------------------------------------------

  // Queued tasks start in the order they came, once a run slot is free and
  // their repository can take them: with one run per repository, once it is
  // idle and its last result has reached the controller, one task after the
  // other; with more, once it has fewer runs than its limit and what the task
  // waits for has ended (blocked). The driver's words were checked when a
  // task was queued. One that cannot start when it is its turn (uncommitted
  // changes, the origin changed in the container, a direct push no longer
  // allowed, the repository gone) leaves the queue with its reason, and the
  // controller hears about it ('parked'): none is dropped silently.

  queued(repo = null) {
    return this.state.queue.filter(entry => repo === null || entry.worker === repo)
  }

  slotsFull() {
    return this.running().length + this.starting.size >= this.maxRuns
  }

  // 'busy' while a repository cannot take a run: one is going, ending or
  // starting, worker processes nobody followed are being ended there, or the
  // last run is still being checked or reported. 'decision' while an open
  // decision holds it (except those that `answers` answers). Otherwise null.
  waiting(repo, answers = null) {
    const last = this.lastTask(repo)
    if (this.running().some(t => t.repo === repo) || this.starting.has(repo) || this.auditing.has(repo)) return 'busy'
    if (this.strays.has(this.dirOf(repo))) return 'busy'
    if (last && !last.reported) return 'busy'
    if (this.holds(repo, answers).length) return 'decision'
    return null
  }

  // 'busy' while nothing new may start in a repository, whatever runs there:
  // a run is starting, a run's audit is going, worker processes nobody
  // followed are being ended in its checkout or a worktree, or a result has
  // not reached the controller yet. Otherwise null.
  repoBusy(repo) {
    if (this.starting.has(repo) || this.auditing.has(repo)) return 'busy'
    const worktrees = worktreesOf(this.runner, repo) + '/'
    if ([...this.strays.keys()].some(dir => dir === this.dirOf(repo) || dir.startsWith(worktrees))) return 'busy'
    if (this.state.tasks.some(t => t.repo === repo && t.state !== 'running' && !t.reported)) return 'busy'
    return null
  }

  // Why a task cannot start now, or null; a dispatch that is not queued yet
  // (first: a follow-up that goes before the other tasks of its repository),
  // or a queued one. busy: the repository cannot take it, or (behind) a run
  // it waits for goes; queue: a task queued before it goes first; after: a
  // task it waits for (after) has not ended; limit: its repository has as
  // many runs as it may; decision: an open decision holds it; full: every
  // run slot is taken.
  blocked(entry, { first = false } = {}) {
    const repo = entry.worker
    const mine = this.queued(repo)
    const inQueue = mine.includes(entry)
    const ahead = inQueue ? mine.slice(0, mine.indexOf(entry)) : first ? [] : mine
    if (this.workspace(repo)?.kind !== 'repo') {
      return this.waiting(repo, entry.answers) ?? (this.slotsFull() ? 'full' : ahead.length ? 'queue' : null)
    }
    const busy = this.repoBusy(repo)
    if (busy) return busy
    const runs = this.runsOf(repo)
    // What a task without parallel or after waits for: what its repository
    // had when it came. One that continues a run waits only for its place.
    if (!inQueue && !entry.behind) entry.behind = first || entry.continues ? [] : [...runs.map(t => t.id), ...ahead.map(e => e.id)]
    if (this.maxPerRepo <= 1) {
      if (runs.length || this.removing.has(this.placeOf(entry).worktree)) return 'busy'
      if (this.holds(repo, entry.answers, entry).length) return 'decision'
      if (this.slotsFull()) return 'full'
      return ahead.length ? 'queue' : null
    }
    const wait = this.dependsOn(entry, ahead)
    if (wait) return wait
    if (runs.length >= this.maxPerRepo) return 'limit'
    const place = this.placeOf(entry)
    if (place === 'main' && this.checkoutTaken(repo)) return 'busy'
    const taken = id => runs.some(t => t.worktree === id) || this.removing.has(id) || this.strays.has(this.worktreeOf(id, repo))
    if (place.worktree && taken(place.worktree)) {
      return 'busy'
    }
    if (this.holds(repo, entry.answers, entry).length) return 'decision'
    if (this.slotsFull()) return 'full'
    return null
  }

  // What a task waits for, of the tasks it names: after, those; parallel,
  // none; neither, those its repository had when it came (behind), or for
  // an entry of an older version every one before it. An interrupted run
  // that resumes waits for none.
  dependsOn(entry, ahead) {
    if (entry.requeued) return null
    const ids = entry.after ?? (entry.parallel ? [] : entry.behind)
    if (!ids) return ahead.length ? 'queue' : this.runsOf(entry.worker).length ? 'busy' : null
    for (const id of ids) {
      const left = this.pending(id)
      if (left) return entry.after ? 'after' : left
    }
    return null
  }

  // Whether a task is still to come: 'queue' while it waits in the queue,
  // 'busy' while it runs or its result has not reached the controller; null
  // once it has ended, or is unknown. A queued task counts as the run it
  // became, and a run that went back to the queue as its new entry.
  pending(id, depth = 0) {
    if (depth > 20) return null
    if (id.startsWith('q')) {
      if (this.state.queue.some(entry => entry.id === id)) return 'queue'
      const started = this.state.tasks.findLast(t => t.queued === id)
      return started ? this.pending(started.id, depth + 1) : null
    }
    const task = this.taskById(id)
    if (!task) return null
    if (task.state === 'running' || !task.reported) return 'busy'
    return task.requeuedAs ? this.pending(task.requeuedAs, depth + 1) : null
  }

  // Whether the queued task `id` waits, directly or through others, for
  // `target`.
  waitsFor(id, target, seen = new Set()) {
    if (id === target) return true
    if (seen.has(id)) return false
    seen.add(id)
    const entry = this.state.queue.find(e => e.id === id)
    if (!entry) return false
    const mine = this.queued(entry.worker)
    const ids = entry.after ?? (entry.parallel ? [] : (entry.behind ?? mine.slice(0, mine.indexOf(entry)).map(e => e.id)))
    return ids.some(dep => dep.startsWith('q') && this.waitsFor(dep, target, seen))
  }

  // Where a queued task goes: at the end, or (first) before the other tasks
  // of its repository; in either case behind the queued tasks it waits for,
  // so that one run at a time keeps the order too.
  place(entry, { first = false } = {}) {
    let at = first ? this.state.queue.findIndex(waiting => waiting.worker === entry.worker) : -1
    if (at < 0) at = this.state.queue.length
    const named = (entry.after ?? []).map(id => this.state.queue.findIndex(waiting => waiting.id === id)).filter(i => i >= 0)
    if (named.length) at = Math.max(at, Math.max(...named) + 1)
    this.state.queue.splice(at, 0, entry)
  }

  // first: before the other tasks of its repository, for a follow-up.
  enqueue(job, reason, { first = false } = {}) {
    const entry = { id: this.newTaskId('q'), ...job, queuedAt: Date.now() }
    if (this.workspace(job.worker)?.kind === 'repo' && !entry.behind) {
      entry.behind = first || entry.continues ? [] : [...this.runsOf(job.worker).map(t => t.id), ...this.queued(job.worker).map(e => e.id)]
    }
    this.place(entry, { first })
    try {
      this.save()
    } catch (error) {
      this.state.queue = this.state.queue.filter(waiting => waiting !== entry) // not kept, so not queued
      throw error
    }
    log('worker queued', job.worker, entry.id, reason, ...(queueMarks(entry) ? [queueMarks(entry)] : []), preview(job.task, 60))
    return {
      status: 'queued',
      entry,
      reason, // busy, decision, queue (others before it), after, limit, full (no run slot)
      position: this.queued(job.worker).indexOf(entry) + 1,
      task: this.running().find(t => t.repo === job.worker) ?? null,
      strays: this.strays.has(this.dirOf(job.worker)), // worker processes of a run nobody followed, being ended
      running: this.running(),
      runs: this.runsOf(job.worker), // the runs of its repository
      others: this.queued(job.worker).filter(waiting => waiting !== entry), // the other tasks queued there
      perRepo: this.maxPerRepo,
      holds: this.holds(job.worker, job.answers, entry),
    }
  }

  // Starts the next queued task that can start; poll() calls it every
  // second. With one run per repository only the first task of a repository
  // may start; with more, any whose repository and dependencies let it
  // (blocked). Nothing starts while the kill switch is locked.
  async pump() {
    if (this.pumping || !this.state.queue.length || this.killswitch?.locked || Date.now() < this.pausedUntil) return
    this.pumping = true
    try {
      for (const entry of [...this.state.queue]) {
        if (this.slotsFull()) return
        if (this.blocked(entry)) continue
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
      names = await this.known(entry.worker)
    } catch (error) {
      this.pausedUntil = Date.now() + PAUSE_MS
      log('queue waits:', error.message)
      return
    }
    // Meanwhile a dispatch may have taken the slot, or the controller dropped it.
    if (!this.queued(entry.worker).includes(entry) || this.slotsFull() || this.blocked(entry)) return
    if (!names.includes(entry.worker)) {
      const gone = !entry.worker.includes('/')
        ? 'the repository is gone'
        : this.scratch
          ? 'its work folder is gone'
          : 'work folders are turned off'
      return this.park(entry, gone)
    }
    let result
    try {
      result = await this.launch(entry, entry)
    } catch (error) {
      log('queued task', entry.id, 'could not start:', error.message)
      return this.park(entry, 'it could not start; the gateway log says why')
    }
    // locked and busy: it waits; dropped: the controller took it out meanwhile.
    if (['started', 'locked', 'dropped', 'busy'].includes(result.status)) return
    const why = {
      origin: 'the origin of the repository changed in the container; it needs a look at the desk',
      refused: 'a direct push needs access level full, and the repository is not at full',
      dirty: `the checkout has ${plural(result.files?.length ?? 0, 'uncommitted file')}`,
      gone: result.why,
    }[result.status]
    this.park(entry, why ?? `it could not start (${result.status})`, result.status)
  }

  // Takes a queued task out of the queue because it cannot start; it becomes
  // an open decision, which holds the repository's other tasks. One for a
  // new work folder holds nothing: the next new one has a folder of its own.
  // One that was to resume a run in its worktree keeps the worktree.
  park(entry, why, status = 'gone') {
    this.state.queue = this.state.queue.filter(waiting => waiting.id !== entry.id)
    try {
      this.save()
    } catch (error) {
      log('worker state not saved:', error.message)
    }
    log('queued task left the queue', entry.worker, entry.id, why)
    const repo = entry.worker === SCRATCH_NEW ? null : entry.worker
    const details = { queued: entry, ...(entry.worktree ? { worktree: entry.worktree } : {}) }
    const decision = this.ledger?.add({ kind: 'other', repo, text: parkedDecision(entry, why), details }) ?? null
    this.emit('parked', entry, why, status, decision)
  }

  // The kill switch empties the queue: nothing starts while it is locked,
  // nor by itself after the unlock. Each task becomes an open decision, so
  // that the driver hears of it; it names the repository (in the queued
  // task) but does not hold it, so that new tasks there start after the
  // unlock. A worktree an interrupted run was to resume in is kept. Returns
  // the tasks that were queued.
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
      this.ledger?.add({ kind: 'other', text, details: { queued: entry, ...(entry.worktree ? { worktree: entry.worktree } : {}) } })
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
    this.emit('dropped', dropped)
    return dropped
  }

  // On the controller's word, without the driver's (it changes when, not
  // what): how a queued task of a repository waits. parallel, next to the
  // others; after, for the tasks named (t… runs, q… queued tasks), and the
  // task moves behind those queued, so that one run at a time keeps the
  // order; neither, behind what its repository had when it came. No task may
  // wait for itself, through others neither. { status, entry, problems }.
  order(worker, id, { parallel = null, after = null } = {}) {
    const entry = this.queued(worker).find(e => e.id === String(id ?? '').trim().toLowerCase())
    if (!entry) return { status: 'unknown' }
    if (entry.requeued) return { status: 'requeued', entry }
    const order = this.checkOrder(worker, { after })
    const problems = [...order.problems]
    if (order.after.includes(entry.id)) problems.push(`${entry.id} cannot wait for itself`)
    const loop = order.after.find(dep => dep !== entry.id && dep.startsWith('q') && this.waitsFor(dep, entry.id))
    if (loop) problems.push(`${loop} waits for ${entry.id} already; mark that one first`)
    if (problems.length) return { status: 'order', problems }
    if (order.after.length) Object.assign(entry, { after: order.after, parallel: false })
    else Object.assign(entry, { after: null, parallel: parallel === true })
    const named = order.after.map(dep => this.state.queue.findIndex(waiting => waiting.id === dep)).filter(i => i >= 0)
    const at = this.state.queue.indexOf(entry)
    if (named.length && Math.max(...named) > at) {
      // Right behind the last of them; those behind it moved up by one.
      this.state.queue.splice(at, 1)
      this.state.queue.splice(Math.max(...named), 0, entry)
    }
    this.save()
    log('worker queue order', worker, entry.id, queueMarks(entry) || 'behind the others')
    return { status: 'ordered', entry, effect: this.maxPerRepo > 1 }
  }

  // --- the limits -----------------------------------------------------------

  // Queued tasks that a higher limit per repository could let run next to
  // others: per repository, its runs and its queued tasks, where some queued
  // task waits behind the others without a word of the controller about it
  // (no parallel, no after). { from, to, repos } or null.
  planFor(from) {
    const repos = []
    for (const repo of [...new Set(this.state.queue.map(entry => entry.worker))]) {
      if (this.workspace(repo)?.kind !== 'repo') continue
      const queued = this.queued(repo)
      const open = queued.filter(entry => !entry.parallel && !entry.after && !entry.requeued)
      const runs = this.runsOf(repo)
      if (!open.length || runs.length + queued.length < 2) continue
      repos.push({ repo, runs, queued })
    }
    return repos.length ? { from, to: this.maxPerRepo, repos } : null
  }

  // New limits while the gateway runs (live.mjs). Runs going are never
  // stopped: above a lower limit, nothing new starts in a repository until it
  // is below it. A higher limit per repository: the plan for the controller,
  // as at a start (replan), which the gateway delivers and then confirms
  // (planned). Returns { was, plan }.
  setLimits({ maxRuns = this.maxRuns, maxPerRepo = this.maxPerRepo } = {}) {
    const was = { maxRuns: this.maxRuns, maxPerRepo: this.maxPerRepo }
    this.maxRuns = maxRuns
    this.maxPerRepo = maxPerRepo
    if (maxPerRepo === was.maxPerRepo) return { was, plan: null }
    // A plan not delivered yet (the controller was not there) counts from
    // the limit its queue was planned for.
    const from = Math.min(this.replan?.from ?? was.maxPerRepo, was.maxPerRepo)
    const plan = maxPerRepo > from ? this.planFor(from) : null
    if (plan) this.replan = plan
    else this.planned()
    return { was, plan: maxPerRepo > was.maxPerRepo ? plan : null }
  }

  // The controller has the plan, or there was none: the queue counts as
  // planned for the limit per repository now.
  planned() {
    this.replan = null
    if (this.state.perRepo === this.maxPerRepo) return
    this.state.perRepo = this.maxPerRepo
    try {
      this.save()
    } catch (error) {
      log('worker state not saved:', error.message)
    }
  }

  // --- following runs -----------------------------------------------------

  poll() {
    if (!this.swept) {
      this.swept = true
      // A worktree being made when the gateway before this one ended: its
      // run never started, and goes back to the queue (finish).
      for (const task of this.running().filter(t => t.preparing && !this.preparing.has(t.id))) {
        this.finish(task, 'failed', 'the gateway restarted while its worktree was being made; nothing ran yet')
      }
      this.stopStrays({ why: 'found when the gateway started' })
    }
    for (const task of this.running()) {
      try {
        this.check(task)
      } catch (error) {
        log('following worker runs failed:', error.message) // the run is checked again next time
      }
    }
    this.checkStrays()
    for (const task of this.unreported()) this.emit('finished', task)
    this.pump()
    this.sweep()
    this.tidyKept()
  }

  // Work folders whose last run is more than their days ago are removed,
  // with their session, once nothing runs, waits or is open there; at most
  // every sweepMs. Folders the gateway did not make are left alone, and so
  // are all of them while work folders are turned off or kept for good (days 0).
  sweep(now = Date.now()) {
    if (!this.scratch?.days || this.sweeping || now - this.sweptAt < this.sweepMs) return this.sweeping
    this.sweptAt = now
    const old = this.scratch.names().filter(name => {
      const entry = this.scratch.entry(name)
      if (!entry) return false // scratch/new
      const last = Math.max(entry.usedAt ?? 0, entry.createdAt, this.lastTask(name)?.finishedAt ?? 0)
      return now - last > this.scratch.days * DAY_MS && !this.waiting(name) && !this.queued(name).length
    })
    if (!old.length) return null
    this.sweeping = (async () => {
      for (const name of old) {
        try {
          if (!(await this.scratch.remove(name))) continue
          delete this.state.repos[name]
          this.save()
          log('work folder removed,', `${this.scratch.days} days after its last run:`, name)
        } catch (error) {
          log('work folder not removed:', name, error.message) // tried again at the next sweep
        }
      }
    })().finally(() => (this.sweeping = null))
    return this.sweeping
  }

  // Whether the run's own process is still there.
  ownAlive(task) {
    const runner = this.runnerOf(task)
    return runner.alive ? runner.alive(task) : alive(task.pid)
  }

  // One look at a running run: what it wrote, and whether its processes are
  // still there. It ends only when every one of them has (conclude). Its own
  // process ended but processes it started did not: the gateway ends those.
  // It gave its result and stays without a word for resultGraceMs: the
  // gateway ends it. Being stopped: SIGKILL every killAfterMs. At the time
  // limit: stopped, and the controller hears about it like any other end.
  // A run whose worktree is being made has no process yet (prepare).
  check(task) {
    if (task.preparing) return
    this.follow(task)
    if (task.state !== 'running') return
    const own = this.ownAlive(task)
    const left = own ? null : (this.runnerOf(task).processes?.(task) ?? [])
    if (!own && !left.length) {
      this.follow(task) // whatever it wrote last
      return this.conclude(task)
    }
    const now = Date.now()
    if (task.stopping) {
      if (now - task.stopping.signalled >= this.killAfterMs) {
        task.stopping.signalled = now
        this.runnerOf(task).stop(task, 'SIGKILL')
      }
      return
    }
    if (!own) {
      log('worker', task.repo, task.id, `has ended, but ${processes(left.length)} it started still run; ending them`)
      return this.halt(task)
    }
    if (task.results && !task.turnOpen && now - (task.lastLineAt ?? now) >= this.resultGraceMs) {
      log('worker', task.repo, task.id, `gave its result and has not ended after ${duration(this.resultGraceMs)}; ending it`)
      return this.halt(task)
    }
    if (this.timeoutMs && now - task.startedAt > this.timeoutMs) {
      this.halt(task, { reason: `stopped at the time limit of ${duration(this.timeoutMs)}`, report: true })
    }
  }

  // Every process of the run is gone: its outcome. Stopped, with the reason;
  // otherwise by its result.
  conclude(task) {
    const cleanup = this.runnerOf(task).cleanup?.(task)
    if (cleanup) {
      const done = cleanup.finally(() => this.cleaning.get(task.repo) === done && this.cleaning.delete(task.repo))
      this.cleaning.set(task.repo, done)
    }
    if (task.stopping?.reason) return this.finish(task, 'stopped', task.stopping.reason)
    if (task.resultSeen) return this.finish(task, task.isError ? 'failed' : 'done', task.isError ? task.result : null)
    const why = task.results ? 'it answered only a notification of its own, not its task' : 'ended without a result'
    return this.finish(task, 'failed', this.errorTail(task) || why)
  }

  // --- worker processes nobody follows ------------------------------------

  // The marks of the runs this gateway follows, and of those another
  // gateway on the same state follows, as its file says.
  knownMarks() {
    const marks = new Set(this.running().map(task => task.mark).filter(Boolean))
    try {
      for (const task of JSON.parse(readFileSync(this.stateFile, 'utf8')).tasks ?? []) {
        if (task?.state === 'running' && task.mark) marks.add(task.mark)
      }
    } catch {
      // no state yet
    }
    return marks
  }

  // The runs nobody follows that the runners find, of every kind, each with
  // the runner that ends it; one found by two runners counts once.
  findStrays() {
    const known = this.knownMarks()
    const found = new Map()
    for (const runner of this.runners()) {
      for (const stray of runner.strays?.(known) ?? []) if (!found.has(stray.run)) found.set(stray.run, { ...stray, runner })
    }
    return [...found.values()]
  }

  // Worker processes in the workspaces here (or only in dir) of a run that no
  // gateway follows: from a run whose record was lost, for example. Nobody
  // watches them, so they get SIGTERM now and SIGKILL later (checkStrays),
  // and no run starts in their checkout until they are gone. Returns them.
  stopStrays({ dir = null, why = 'found' } = {}) {
    const strays = this.findStrays().filter(stray => !dir || stray.repo === dir)
    const now = Date.now()
    for (const stray of strays) {
      if (!this.strays.has(stray.repo)) {
        log(`worker ${processes(stray.pids.length)} of a run nobody follows in ${stray.repo} (task ${stray.task ?? 'unknown'}), ${why}: ending them`)
        this.strays.set(stray.repo, { at: now, signalled: now })
      }
      stray.runner.stopStray(stray, 'SIGTERM')
    }
    return strays
  }

  checkStrays() {
    if (!this.strays.size) return
    const strays = this.findStrays()
    const now = Date.now()
    for (const [dir, entry] of this.strays) {
      const left = strays.filter(stray => stray.repo === dir)
      if (!left.length) {
        this.strays.delete(dir)
        log('the worker processes nobody followed in', dir, 'have ended')
      } else if (now - entry.signalled >= this.killAfterMs) {
        entry.signalled = now
        for (const stray of left) stray.runner.stopStray(stray, 'SIGKILL')
      }
    }
  }

  follow(task) {
    if (!this.followed.has(task.id)) {
      // Read from the start, also by a gateway that took the run over: what
      // the output says is counted again, its figures for the statistics too.
      Object.assign(task, { steps: [], results: 0, turnOpen: false, resultSeen: false, usage: null, tools: 0, subagents: 0 })
    }
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
    // The session of the checkout, or of the worktree, which a follow-up
    // there continues; a worktree's once it has written: one that never
    // did cannot be continued.
    const wt = task.worktree ? this.state.worktrees[task.worktree] : null
    if (message.session_id && message.session_id !== task.sessionId) {
      task.sessionId = message.session_id
      if (!wt) this.state.repos[task.repo] = { sessionId: message.session_id }
    }
    if (wt && message.session_id && wt.task === task.id) Object.assign(wt, { sessionId: message.session_id, resumable: true })
    // For the end of a run that gave its result (check): when it last wrote,
    // and whether a turn is going.
    task.lastLineAt = Date.now()
    if (['assistant', 'user'].includes(message.type) || (message.type === 'system' && message.subtype === 'init')) {
      task.turnOpen = true
    }
    if (message.type === 'assistant') {
      for (const part of message.message?.content ?? []) {
        if (part.type === 'tool_use') {
          task.tools = (task.tools ?? 0) + 1
          if (SUBAGENT_TOOLS.has(part.name)) task.subagents = (task.subagents ?? 0) + 1
          task.steps = [...task.steps, describeStep(part.name, part.input, task.dir ?? this.dirOf(task.repo))].slice(-MAX_STEPS)
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
      // The end of a turn, not of the run: the process may go on (check).
      task.results = (task.results ?? 0) + 1
      task.turnOpen = false
      task.usage = addResult(task.usage, message, { resumed: task.resumed })
      // A turn Claude Code answered on its own, such as the notification of
      // a background task from the session it resumed: not the task's result.
      if (message.origin?.kind === 'task-notification') return
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
    task.preparing = false
    this.followed.delete(task.id)
    if (task.worktree) this.afterWorktreeRun(task)
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
    // Stopped by the controller (stopRuns): no result event, and stop_worker's
    // answer brings the check. It starts now, with the end: the poll may see
    // the end before stop_worker does, and would start the next queued task
    // in the same go, before the check could raise the decision that is to
    // hold it. Also when nobody waits for it any more, after a restart.
    if (task.stopping?.reason && !task.stopping.lock && task.reported) {
      this.audit(task).catch(auditError => log('worker audit failed', task.repo, task.id, auditError.message))
    }
    if (unsaved) throw unsaved
  }

  // --- interrupted runs in worktrees ----------------------------------------

  // Why a run in a worktree was interrupted, and goes back to the queue, or
  // null: stopped (the time limit, stop_worker without drop), or ended
  // without a result of its own (a crash, a restart of the computer, a
  // restart of the gateway while its worktree was made). Not when the
  // driver had it dropped, nor by the kill switch, nor when its worktree
  // could not be made, nor more than MAX_RESUMES times.
  interrupted(task) {
    if (!task.worktree || this.killswitch?.locked) return null
    const stop = task.stopping ?? {}
    if (stop.drop || stop.lock || task.prepFailed) return null
    if ((task.resumes ?? 0) >= MAX_RESUMES) return null
    if (task.state === 'stopped') return task.error || 'it was stopped'
    if (task.state === 'failed' && !task.resultSeen) return task.error || 'it ended without a result'
    return null
  }

  // A run in a worktree has ended: interrupted, its task goes back to the
  // queue with the worktree, in front of the other tasks of its repository,
  // and resumes there when it is its turn; stopped by the kill switch, its
  // worktree is kept, and the task becomes an open decision that holds
  // nothing, as the queued tasks do (parkAll).
  afterWorktreeRun(task) {
    const why = this.interrupted(task)
    if (why) return this.requeue(task, why)
    const stopped = task.state === 'stopped' || (task.state === 'failed' && !task.resultSeen)
    if (stopped && (task.stopping?.lock || this.killswitch?.locked) && this.ledger) {
      const decision = this.ledger.add({
        kind: 'other',
        text: lockedDecision(task),
        details: { task: task.id, worker: task.repo, worktree: task.worktree },
      })
      task.lockDecision = decision.id
    }
  }

  requeue(task, why) {
    const entry = {
      id: this.newTaskId('q'),
      worker: task.repo,
      task: task.task,
      words: task.words,
      fresh: false,
      allowDirty: false,
      direct: Boolean(task.direct),
      draft: Boolean(task.draft),
      request: null,
      answers: null,
      parallel: false,
      after: null,
      behind: [],
      continues: task.id,
      worktree: task.worktree,
      resumes: (task.resumes ?? 0) + 1,
      requeued: { task: task.id, why: preview(why, 160) },
      queuedAt: Date.now(),
    }
    const at = this.state.queue.findIndex(waiting => waiting.worker === task.repo)
    this.state.queue.splice(at >= 0 ? at : this.state.queue.length, 0, entry)
    task.requeuedAs = entry.id
    log('worker requeued', task.repo, task.id, `as ${entry.id} with its worktree, attempt ${entry.resumes} of ${MAX_RESUMES}:`, preview(why, 100))
    return entry
  }

  // --- after a run --------------------------------------------------------

  // A repository's audit is going: the next queued task there waits.
  auditStart(repo) {
    this.auditing.set(repo, (this.auditing.get(repo) ?? 0) + 1)
  }

  auditDone(repo) {
    const left = (this.auditing.get(repo) ?? 1) - 1
    if (left > 0) this.auditing.set(repo, left)
    else this.auditing.delete(repo)
  }

  // The HEADs of the worktrees of a repository's runs, whose commits are
  // theirs, not those of a run in its checkout.
  async worktreeHeads(main) {
    const list = await listWorktrees(this.runner, main).catch(() => [])
    return list.filter(w => w.head && w.dir.split('/').includes(WORKTREES)).map(w => w.head)
  }

  // Looks at the run's checkout once it has ended, whatever the worker wrote:
  // commits on no remote that were not there at its start, uncommitted files
  // that were not there at its start, and whether it is back on its starting
  // branch. What the decisions it follows up were about counts again: a
  // follow-up that was to push and did not is caught too. Without a record
  // of the start (a run of an older version, or git did not answer then),
  // nothing else counts: the driver's own local branches and files are not
  // the run's. Kept with the task, so that the result says the same after a
  // gateway restart; { ok: false } when git does not answer. Then the
  // decision (decide). A run in a worktree: the commits its HEAD has, and no
  // branch to be back on; then the worktree goes, if nothing is left in it
  // (tidy). A run in the checkout next to runs in worktrees: not their
  // commits.
  // Once per run, also when the report and stop_worker ask at the same time.
  audit(task) {
    if (task.audit) return Promise.resolve(task.audit)
    if (!this.audits.has(task.id)) {
      const done = (kindOf(task) === 'scratch' ? this.auditScratch(task) : this.auditRun(task)).finally(() => this.audits.delete(task.id))
      this.audits.set(task.id, done)
    }
    return this.audits.get(task.id)
  }

  async auditRun(task) {
    // Until it is done, the next queued task there waits.
    this.auditStart(task.repo)
    try {
      const dir = task.dir ?? this.dirOf(task.repo)
      const worktree = Boolean(task.worktree)
      const now = await Promise.resolve()
        .then(async () => {
          const exclude = worktree ? [] : await this.worktreeHeads(dir)
          return gitState((...args) => this.git(...args), dir, { current: worktree, exclude })
        })
        .catch(() => null)
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
          startBranch: worktree ? null : (task.startBranch ?? null),
          remote: now.remote,
          baseline: before !== null && dirtyBefore !== null,
          unpushed: now.unpushed.filter(commit => counts(before, commit.hash)),
          dirty: now.dirty.filter(file => counts(dirtyBefore, file)),
        }
      }
      log('worker audit', task.repo, task.id, auditSummary(task.audit))
      this.decide(task)
      if (worktree) await this.tidy(task, now)
    } finally {
      this.auditDone(task.repo)
    }
    try {
      this.save()
    } catch (error) {
      log('worker state not saved:', error.message) // the audit holds in this gateway
    }
    return task.audit
  }

  // The look at a work folder once its run has ended, whatever the worker
  // wrote: the files it made, changed and removed. There is no git, so there
  // is no push decision. { ok: false } when the folder cannot be read.
  async auditScratch(task) {
    this.auditStart(task.repo)
    const now = await Promise.resolve()
      .then(() => this.runnerOf(task).files(task.dir))
      .catch(() => null)
      .finally(() => this.auditDone(task.repo))
    task.audit = now ? { ok: true, at: Date.now(), ...fileChanges(task.startFiles ?? [], now, MAX_FILES) } : { ok: false, at: Date.now() }
    delete task.startFiles // done with; the state keeps only what the check found
    task.decision = null
    log('worker check', task.repo, task.id, filesSummary(task.audit))
    try {
      this.save()
    } catch (error) {
      log('worker state not saved:', error.message)
    }
    return task.audit
  }

  // What the audit found becomes a push decision for the driver: commits on
  // no remote (not at read-only, where commits stay in the container by
  // design) and new uncommitted files. It replaces an open one of an earlier
  // audit in the same place: the checkout, or the same worktree. Its text
  // names no branch or file: those come from the run. A commit the driver has
  // decided about already (resolve_decision, or the controller's "done" to
  // their answer) raises none again, unless this run was the follow-up that
  // was to push it. Files need no such list: one left uncommitted is there at
  // the next start, so it is no run's own any more. None for a run that went
  // back to the queue, which goes on, nor for one the kill switch stopped in
  // its worktree, which is a decision already (afterWorktreeRun).
  decide(task) {
    if (!this.ledger || task.decision !== undefined) return
    task.decision = null
    if (task.requeuedAs || task.lockDecision) return
    const carried = new Set(task.carried?.commits ?? [])
    const decided = new Set(
      this.ledger.decisions
        .filter(d => d.repo === task.repo && d.state === 'closed' && ['driver', 'reply'].includes(d.closedBy))
        .flatMap(d => d.details?.commits ?? []),
    )
    const fresh = commit => carried.has(commit.hash) || !decided.has(commit.hash)
    const commits = task.audit.ok && task.access !== 'read-only' ? task.audit.unpushed.filter(fresh) : []
    const files = task.audit.ok ? task.audit.dirty : []
    if (!commits.length && !files.length) return
    const samePlace = d => (d.details?.worktree ?? null) === (task.worktree ?? null)
    const earlier = this.ledger.forRepo(task.repo).filter(d => d.kind === 'push' && d.details?.task && samePlace(d))
    const details = { task: task.id, commits: commits.map(commit => commit.hash), files }
    if (task.worktree) details.worktree = task.worktree
    const decision = this.ledger.add({ kind: 'push', repo: task.repo, text: pushText(task, commits.length, files.length), details })
    for (const d of earlier) this.ledger.close(d, { outcome: `replaced by ${decision.id}, after task ${task.id}`, by: 'gateway' })
    task.decision = decision.id
  }

  // --- worktrees after their runs --------------------------------------------

  // Whether something still needs a worktree: a run in it, a queued task
  // that resumes or continues there, an open decision about it.
  worktreeHeld(id) {
    if (this.running().some(t => t.worktree === id)) return true
    if (this.state.queue.some(e => e.worktree === id || (e.continues && this.taskById(e.continues)?.worktree === id))) return true
    return this.ledger?.open().some(d => d.details?.worktree === id) ?? false
  }

  // Whether a worktree can go without anything getting lost: nothing
  // uncommitted, nothing unpushed (where there is anywhere to push it), and
  // no commit that only its HEAD has. now: gitState of it.
  async removable(task, now) {
    if (!now) return false
    const canPush = now.remote && task.access !== 'read-only'
    if (now.dirty.length || (canPush && now.unpushed.length)) return false
    return (await orphans(this.runnerOf(task), task.dir)) === false
  }

  // After a run in a worktree, and its decision: the worktree goes when
  // nothing needs it and nothing would get lost; otherwise it is kept, and
  // the decision or the queued task refers to it. The branch it ended on is
  // kept in mind, for a follow-up that makes it again.
  async tidy(task, now) {
    const wt = this.state.worktrees[task.worktree]
    if (!wt || wt.removedAt || wt.task !== task.id) return
    if (now?.branch) wt.branch = now.branch
    if (task.stopping?.lock || this.worktreeHeld(task.worktree) || !(await this.removable(task, now))) {
      task.worktreeKept = true
      log('worker worktree kept', task.repo, task.worktree, task.dir)
      return
    }
    this.removing.add(task.worktree)
    const removed = await removeWorktree(this.runnerOf(task), { main: task.checkout ?? this.dirOf(task.repo), dir: task.dir })
      .catch(() => false)
      .finally(() => this.removing.delete(task.worktree))
    if (removed) {
      wt.removedAt = Date.now()
      task.worktreeRemoved = true
      log('worker worktree removed', task.repo, task.worktree, 'nothing left in it')
    } else {
      task.worktreeKept = true
      log('worker worktree not removed, git did not', task.repo, task.worktree)
    }
  }

  // The worktrees kept after their runs, looked at again every sweepMs:
  // one that nothing needs any more and that would lose nothing goes, as
  // after a run (a decision about it was closed, a queued task dropped); one
  // removed at the desk is forgotten. Returns the promise, for the tests.
  tidyKept(now = Date.now()) {
    if (this.tidying || now - (this.tidiedAt ?? 0) < this.sweepMs) return this.tidying
    this.tidiedAt = now
    const kept = Object.entries(this.state.worktrees).filter(([id, wt]) => !wt.removedAt && !this.worktreeHeld(id))
    if (!kept.length) return null
    this.tidying = (async () => {
      for (const [id, wt] of kept) {
        try {
          const task = this.taskById(wt.task) ?? { repo: wt.repo, dir: wt.dir, worktree: id, kind: 'repo' }
          const runner = this.runnerOf(task)
          const main = task.checkout ?? this.dirOf(wt.repo)
          if (!(await isTop(runner, wt.dir))) {
            await runner.gitRun(main, ['worktree', 'prune'])
            wt.removedAt = Date.now()
            log('worker worktree gone, removed at the desk:', wt.repo, id)
          } else {
            const state = await gitState((...args) => runner.git(...args), wt.dir, { current: true })
            if (this.worktreeHeld(id) || !(await this.removable(task, state))) continue
            if (state?.branch) wt.branch = state.branch
            this.removing.add(id)
            const removed = await removeWorktree(runner, { main, dir: wt.dir }).finally(() => this.removing.delete(id))
            if (removed) {
              wt.removedAt = Date.now()
              log('worker worktree removed, nothing left in it and nothing needs it:', wt.repo, id)
            }
          }
          this.save()
        } catch (error) {
          log('worker worktree not looked at:', wt.repo, id, error.message) // again at the next sweep
        }
      }
    })().finally(() => (this.tidying = null))
    return this.tidying
  }

  // The worktrees of a repository kept after their runs: [{ id, task }].
  keptWorktrees(repo) {
    return Object.entries(this.state.worktrees)
      .filter(([id, wt]) => wt.repo === repo && !wt.removedAt && !this.running().some(t => t.worktree === id))
      .map(([id, wt]) => ({ id, ...wt, last: this.taskById(wt.task) }))
  }

  // --- texts for the controller -------------------------------------------

  // The gateway's look after a run as a line, by its kind: git for a
  // repository, the files for a work folder.
  checkText(task) {
    return kindOf(task) === 'scratch' ? filesText(task.audit) : auditText(task.audit)
  }

  // The same in a few words, as the attribute of the result event: git for
  // a repository, files for a work folder.
  checkMeta(task) {
    return kindOf(task) === 'scratch' ? { files: filesSummary(task.audit) } : { git: auditSummary(task.audit) }
  }

  // The lines of list_workers for the work folders: scratch/new, then the
  // last used.
  scratchLines(now = Date.now()) {
    const [fresh, ...names] = this.scratch.names()
    const lines = [
      `${fresh}: a new empty work folder for a task without a repository (a question, research, a calculation, a draft, ` +
        `a conversion), ${this.scratch.where()}; ${this.stateText(fresh)}`,
    ]
    for (const name of names.slice(0, SCRATCH_SHOWN)) {
      lines.push(`${name}: work folder made ${age(now - this.scratch.entry(name).createdAt)} ago, ${this.stateText(name)}`)
    }
    if (names.length > SCRATCH_SHOWN) lines.push(`${names.length - SCRATCH_SHOWN} older work folders.`)
    return lines
  }

  async listText() {
    const names = await this.repos()
    const facts = await Promise.all(names.map(name => this.inspect(name)))
    const container = this.runner.container
    const queued = this.queued().length
    const perRepo = this.maxPerRepo > 1 ? ` per_repo=${this.maxPerRepo}` : ''
    const lines = [
      `[workers=${names.length} running=${this.running().length}${queued ? ` queued=${queued}` : ''} max=${this.maxRuns}${perRepo}` +
        `${container ? ` docker=${container}` : ''}${this.scratch ? ' scratch=on' : ''}]`,
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
    if (this.scratch) lines.push(...this.scratchLines())
    return lines.join('\n')
  }

  // A run as list_workers and open_items say it: running, ending, or
  // preparing its worktree.
  runText(task, length = 50) {
    const what = task.stopping ? 'ending' : task.preparing ? 'preparing' : 'running'
    return `${what} ${task.id}${task.worktree ? ' in a worktree' : ''} for ${duration(Date.now() - task.startedAt)} ("${preview(task.task, length)}")`
  }

  // The worktrees kept after their runs, in a few words each.
  keptText(repo) {
    return this.keptWorktrees(repo)
      .map(wt => {
        const why = this.state.queue.find(e => e.worktree === wt.id)
          ? `its task waits in the queue as ${this.state.queue.find(e => e.worktree === wt.id).id}`
          : wt.last?.audit
            ? auditSummary(wt.last.audit)
            : 'not checked'
        return `${wt.id} (${why})`
      })
      .join(', ')
  }

  stateText(repo) {
    const task = this.lastTask(repo)
    const runs = this.runsOf(repo)
    const queued = this.queued(repo)
    const open = this.holds(repo).map(d => `${d.id} (${d.kind}, ${d.state})`)
    const kept = this.workspace(repo)?.kind === 'repo' ? this.keptText(repo) : ''
    const queue =
      (queued.length ? `; queued: ${queueList(queued)}` : '') +
      (open.length ? `; open decisions: ${open.join(', ')}` : '') +
      (kept ? `; kept worktrees: ${kept}` : '')
    if (runs.length) return runs.map(t => this.runText(t)).join(', ') + queue
    if (!task) return `idle${queue}`
    return `idle, last task ${task.id} ${task.state} ${duration(Date.now() - task.finishedAt)} ago${queue}`
  }

  // The queue of a repository in one line, for stop_worker.
  queueText(repo) {
    const queued = this.queued(repo)
    return queued.length ? `Queued there: ${queueList(queued)}.` : 'Nothing is queued there.'
  }

  // What worker_status says about a run.
  taskLines(repo, task) {
    const lines = []
    const worktree = task.worktree ? ` worktree=${task.worktree}` : ''
    if (task.state === 'running') {
      // Ending: stopped, or done, while processes of it are still there.
      const state = task.stopping ? 'ending' : task.preparing ? 'preparing' : 'running'
      lines.push(`[worker=${repo} state=${state} task=${task.id}${worktree} elapsed=${Math.round((Date.now() - task.startedAt) / 1000)}s]`)
      if (task.stopping) lines.push(`Ending: ${task.stopping.reason ?? 'it gave its result, and the gateway ends what is left of it'}; nothing else starts here until all its processes are gone.`)
      if (task.preparing) lines.push(`Preparing: the gateway makes its worktree (${task.dir}); then claude starts there.`)
    } else {
      lines.push(`[worker=${repo} state=${task.state} task=${task.id}${worktree} took=${duration(task.finishedAt - task.startedAt)}]`)
    }
    lines.push(`Task: ${preview(task.task, 200)}`)
    if (task.steps.length) lines.push(`Last steps: ${task.steps.join('; ')}`)
    if (task.audit) lines.push(this.checkText(task))
    if (task.state === 'running' && task.lastText) lines.push(`Last message: ${task.lastText}`)
    if (task.result) lines.push(`Result: ${task.result}`)
    if (task.error && task.error !== task.result) lines.push(`Problem: ${task.error}`)
    if (task.requeuedAs) lines.push(`It went back to the queue as ${task.requeuedAs}, with its worktree.`)
    return lines
  }

  // Every run going in the repository; with none, the last one.
  statusText(repo) {
    const task = this.lastTask(repo)
    const runs = this.runsOf(repo)
    const queued = this.queued(repo)
    if (!task) return `[worker=${repo} state=idle] No task yet.${queued.length ? ` Queued: ${queueList(queued)}.` : ''}`
    const blocks = (runs.length ? runs : [task]).map(t => this.taskLines(repo, t).join('\n'))
    const lines = [blocks.join('\n\n')]
    if (queued.length) lines.push(`Queued: ${queueList(queued)}.`)
    const kept = this.workspace(repo)?.kind === 'repo' ? this.keptText(repo) : ''
    if (kept) lines.push(`Kept worktrees: ${kept}.`)
    return lines.join('\n')
  }

  // What the result event says about where a run in a worktree ran, and
  // what became of it; nothing for a run in the checkout.
  worktreeText(task) {
    if (!task.worktree) return []
    const lines = [
      `It ran in a worktree of its own (${task.dir}), next to the repository's other runs. A follow-up continues there ` +
        `with dispatch continues="${task.id}"; the driver's answer to this result goes there by itself.`,
    ]
    if (task.requeuedAs) {
      lines.push(
        `It was interrupted (${preview(task.error ?? 'stopped', 120)}) and went back to the queue as ${task.requeuedAs}, in ` +
          `front for ${task.repo}, with its worktree: it resumes there when it is its turn (resume ${task.resumes ? task.resumes + 1 : 1} ` +
          `of ${MAX_RESUMES}). Tell the driver in a sentence; nothing to dispatch.`,
      )
    } else if (task.lockDecision) {
      lines.push(`The kill switch stopped it; its worktree is kept, as open decision ${task.lockDecision}.`)
    } else if (task.worktreeRemoved) {
      lines.push('The gateway removed its worktree: nothing was left uncommitted or unpushed in it.')
    } else if (task.worktreeKept) {
      lines.push('Its worktree is kept: something in it is not committed or not pushed, or a decision refers to it.')
    }
    return lines
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
    if (task.audit) lines.push(this.checkText(task))
    lines.push(...this.worktreeText(task))
    if (kindOf(task) === 'scratch') {
      const mounted = task.container ? `, mounted in the container ${task.container}` : ''
      lines.push(
        `The work folder: ${task.hostDir ?? task.dir} on this computer${mounted}. Follow-ups and answers go to worker ` +
          `${task.repo}.`,
      )
    }
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

  // The attributes of the result event besides the check: the worktree it
  // ran in, and the queued task it went back to the queue as.
  runMeta(task) {
    return { ...(task.worktree ? { worktree: task.worktree } : {}), ...(task.requeuedAs ? { requeued: task.requeuedAs } : {}) }
  }
}

// The plan for a higher limit per repository, for the controller: the
// queued tasks that could now run next to others, with their texts, and how
// to say so. why: since when, in a few words.
export function planText(plan, why = 'since the queue was planned') {
  const repos = plan.repos.map(({ repo, runs, queued }) => {
    const going = runs.length ? `running ${runList(runs, { length: 120 })}` : 'nothing running'
    return `- ${repo}: ${going}; queued, in their order: ${queueList(queued, { max: 20, length: 120 })}`
  })
  return [
    `The limit of runs per repository went up from ${plan.from} to ${plan.to} ${why}. These queued tasks were planned ` +
      'one after the other, and could now run next to others of their repository:',
    ...repos,
    'Decide for each queued task from these texts, without asking the driver: order_queue with parallel=true when it ' +
      "needs none of the others' results and works on other files; with after=\"<ids>\" when it needs some of them to " +
      'end first or works on the same files; leave it as it is to keep it behind all of them. This changes only the ' +
      'order, not what is done, so it needs no words of the driver. Reply "done" to this event; the driver does not ' +
      'hear it.',
  ].join('\n')
}

// What the prompt says about the level; pull: the kind of pull request.
const ACCESS_TEXT = {
  'read-only': () => 'Nothing leaves this container: no push, no pull request.',
  pr: pull => `Push a voice/ branch and open ${pull}.`,
  full: pull => `Push a voice/ branch and open ${pull}; a direct push only with "Direct push: yes".`,
}

// What the worker reads on stdin: the task in the controller's words, the
// driver's own words, and what the gateway checked. draft: this task's pull
// request as a draft, where it opens one (dispatch's draft); prDraft: every
// pull request as a draft (VOICE_GW_PR_DRAFT=1).
export function prompt({ task, words, facts, direct = false, draft = false, prDraft = false }) {
  const visibility = {
    public: 'public',
    private: 'private',
    internal: 'internal to the organisation',
    unknown: 'visibility unknown, treat it as public',
  }[facts.visibility]
  // facts.followed: files of the decisions a follow-up answers (Workers.launch).
  const followed = facts.followed ?? []
  const others = facts.dirty.filter(file => !followed.includes(file))
  // facts.worktree: a run in a worktree of its own (Workers.prepare), whose
  // files are this task's.
  const wt = facts.worktree ?? null
  const lines = [
    task.trim(),
    '',
    `The driver's own words: "${String(words ?? '').trim()}"`,
    '',
    'Checked by the gateway just now:',
    `- Repository: ${facts.origin ? `${facts.origin} (${visibility})` : 'no remote'}`,
    wt
      ? `- Starting branch: ${wt.target || 'the default branch'} (in a worktree of its own, below)`
      : `- Starting branch: ${facts.branch || 'detached HEAD'}`,
    wt
      ? `- Uncommitted files in your worktree: ${facts.dirty.length ? `${facts.dirty.join(', ')} (left by an earlier run of this task)` : 'none'}`
      : `- Uncommitted files before you start: ${others.length ? others.join(', ') + ' (not yours, leave them alone)' : 'none'}`,
  ]
  if (followed.length && !wt) {
    lines.push(`- Uncommitted files an earlier run left, which this task follows up: ${followed.join(', ')}`)
  }
  const target = facts.defaultBranch || 'the default branch'
  const asDraft = draft && !draftIgnored(facts, direct)
  if (facts.access) {
    const { level, reason } = facts.access
    const what = facts.pushDirect ? '' : (ACCESS_TEXT[level]?.(pullRequestKind(prDraft || asDraft)) ?? '')
    lines.push(`- Access level: ${level} (${reason}). ${what}`.trimEnd())
    if (direct && !facts.pushDirect) {
      lines.push(`- Direct push: yes. The driver explicitly asked to push straight to ${target}.`)
    }
  }
  if (facts.pushDirect) {
    lines.push(
      wt
        ? `- Pull requests: turned off on GitHub. Your commits go to ${target}, pushed there without a pull request (Branch below).`
        : `- Pull requests: turned off on GitHub. Commit on ${target} and push it there, without a pull request.`,
    )
  }
  if (asDraft) {
    lines.push(
      '- Draft pull request: yes. The driver asked to open the pull request as a draft, with gh pr create --draft; ' +
        'one that is open already stays as it is.',
    )
  }
  if (wt) lines.push(...worktreeLines(facts, wt, { direct }))
  return lines.join('\n') + '\n'
}
