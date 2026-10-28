// Fixed rules on the workers' runs, checked by the gateway while it follows
// them, whatever the instructions say. A violation trips the kill switch.
//
//   default branch  a push to the repository's default branch, or a merge,
//                   that was not an explicit direct dispatch at level full,
//                   in a repository with pull requests turned on (without
//                   them, the default branch is where workers push).
//                   In the run's commands: git push with the default branch
//                   (or --all, --mirror) as target, gh pr merge, and gh api
//                   calls that merge (REST and GraphQL). On GitHub, with gh:
//                   the default branch moved during the run, and the worker's
//                   repository holds the new head, or the new head merged a
//                   pull request of the run (mergedPull).
//   outside         writes outside the repository and the temporary folders:
//                   the file tools by their path, shell commands by explicit
//                   targets (redirections, tee, cp, mv, rm, mkdir, touch, ln,
//                   chmod, chown, truncate, sed -i, dd of=), after cd.
//   many changes    more file edits in a run than maxEdits; at the end, more
//                   files or lines changed than maxFiles or maxLines, counting
//                   commits made during the run on any branch and what is not
//                   committed.
//
// The rules observe the run; they cannot stop its first step. What they miss
// is in the README ("Limits"): targets hidden in variables, scripts or
// other languages, and on GitHub anything gh cannot see. In the Docker setup,
// git runs only in the container (runner.git); never on this computer in the
// mounted folder.

import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { posix } from 'node:path'
import { log as defaultLog, preview } from './log.mjs'

const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const DEVICES = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'nice'])
const short = sha => String(sha).slice(0, 7)

// gh api options that take a value; -f and -F (fields) make it a POST.
const GH_API_VALUES = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview'])
const GH_API_FIELDS = new Set(['-f', '--raw-field', '-F', '--field', '--input'])
// GraphQL mutations that merge, or merge later (auto-merge).
const MERGE_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/
// A pull request opened this long before the run's start counts as opened
// during it: the clocks here and on GitHub differ a little.
const CLOCK_SLACK_MS = 60 * 1000

function gh(ghBin, args) {
  return new Promise(resolve => {
    execFile(ghBin, args, { timeout: 30000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

// Words of one shell command, quotes removed; good enough for explicit paths.
const words = segment =>
  (segment.match(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g) ?? []).map(word => word.replace(/'([^']*)'|"([^"]*)"/g, '$1$2'))

// Segments of a command line: && || ; | and new lines.
const segments = command => String(command).split(/&&|\|\||;|\n|\|/).map(s => s.trim()).filter(Boolean)

// git [-C dir] [-c key=value] push [options] [remote [refspec...]]: the
// branches it names as targets, and whether it pushes all of them; null for
// another git command.
function pushTargets(args) {
  let at = 0
  while (at < args.length && args[at] !== 'push') at += ['-C', '-c'].includes(args[at]) ? 2 : 1
  if (args[at] !== 'push') return null
  const rest = args.slice(at + 1)
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (['--repo', '-o', '--push-option', '--receive-pack', '--exec'].includes(rest[i])) i++
    else if (!rest[i].startsWith('-')) positional.push(rest[i])
  }
  return {
    all: rest.includes('--all') || rest.includes('--mirror'),
    branches: positional.slice(1).map(spec => spec.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '')),
  }
}

// gh api [options] <endpoint> [options]: the method and the endpoint, the
// method as gh chooses it: GET, or POST once there are fields or an input.
function ghApi(args) {
  let method = null
  let body = false
  let endpoint = null
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    const inline = /^(?:-X=?|--method=)(.+)$/.exec(arg)
    if (arg === '-X' || arg === '--method') method = args[++i] ?? null
    else if (inline) method = inline[1]
    else if (GH_API_FIELDS.has(arg)) {
      body = true
      i++
    } else if (/^(?:-[fF].|--(?:raw-)?field=|--input=)/.test(arg)) body = true
    else if (GH_API_VALUES.has(arg)) i++
    else if (!arg.startsWith('-') && endpoint === null) endpoint = arg
  }
  return { method: String(method ?? (body ? 'POST' : 'GET')).toUpperCase(), endpoint: endpoint ?? '' }
}

// What a gh command merges, in a few words, or null. The whole command line
// for GraphQL, whose query may span lines.
function ghMerge(args, command) {
  if (args[0] === 'pr' && args[1] === 'merge') return 'merges a pull request'
  if (args[0] !== 'api') return null
  const { method, endpoint } = ghApi(args)
  const path = endpoint.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const mutation = MERGE_MUTATIONS.exec(command)?.[1]
  if (/(?:^|\/)graphql$/.test(path) && mutation) return `merges through the GraphQL API (${mutation})`
  if (method === 'PUT' && /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(path)) return 'merges a pull request'
  if (method === 'POST' && /(?:^|\/)repos\/[^/]+\/[^/]+\/merges$/.test(path)) return 'merges a branch'
  return null
}

export class RunGuard {
  constructor({ workers, runner, killswitch, ghBin = 'gh', limits = {}, allowed = [], mainCheckSeconds = 30, log = defaultLog }) {
    this.workers = workers
    this.runner = runner
    this.killswitch = killswitch
    this.ghBin = ghBin
    this.maxEdits = limits.maxEdits ?? 500
    this.maxFiles = limits.maxFiles ?? 300
    this.maxLines = limits.maxLines ?? 30000
    this.log = log
    const docker = Boolean(runner.container)
    this.home = docker ? '/home/worker' : homedir()
    this.allowedRoots = [...new Set([...(docker ? [] : [tmpdir()]), '/tmp', '/var/tmp', ...allowed])]
    this.runs = new Map() // task id -> what the rules know about the run
    this.ghWarned = false
    workers.on('started', task => this.started(task))
    workers.on('tool', (task, part) => this.tool(task, part))
    workers.on('ended', task => this.ended(task))
    this.timer = setInterval(() => this.checkAll(), mainCheckSeconds * 1000)
    this.timer.unref()
  }

  close() {
    clearInterval(this.timer)
  }

  violation(run, rule, detail) {
    if (run.tripped.has(rule)) return
    run.tripped.add(rule)
    this.killswitch.trip({ trigger: 'rule', reason: `${rule}: ${detail} (worker ${run.repo}, task ${run.id})` })
  }

  // --- the run --------------------------------------------------------------

  // Also for runs that were going when the gateway started.
  started(task) {
    if (this.runs.has(task.id)) return
    const run = {
      id: task.id,
      repo: task.repo,
      dir: task.dir ?? this.runner.dir(task.repo),
      slug: task.slug ?? null,
      branch: task.defaultBranch ?? null,
      direct: (Boolean(task.direct) && task.access === 'full') || Boolean(task.pushDirect),
      startedAt: task.startedAt,
      head: null,
      pushed: new Set(), // branches the run's git push commands name
      edits: 0,
      files: new Set(),
      tripped: new Set(),
      checking: null,
    }
    this.runs.set(task.id, run)
    run.ready = this.baseline(run)
  }

  async baseline(run) {
    if (!run.slug) return
    if (!run.branch) run.branch = (await gh(this.ghBin, ['api', `repos/${run.slug}`]))?.default_branch ?? null
    run.head = await this.head(run)
  }

  async head(run) {
    if (!run.slug || !run.branch) return null
    const branch = await gh(this.ghBin, ['api', `repos/${run.slug}/branches/${encodeURIComponent(run.branch)}`])
    if (!branch?.commit?.sha && !this.ghWarned) {
      this.ghWarned = true
      this.log('kill switch rule on the default branch: gh cannot read it on GitHub, so only the commands are checked')
    }
    return branch?.commit?.sha ?? null
  }

  tool(task, part) {
    const run = this.runs.get(task.id)
    if (!run) return
    if (FILE_TOOLS[part.name]) {
      const path = part.input?.[FILE_TOOLS[part.name]]
      run.edits++
      if (typeof path === 'string') {
        const target = this.resolve(run.dir, path)
        if (target) run.files.add(target)
        if (target && !this.allowed(run, target)) this.violation(run, 'write outside the allowed folders', `${part.name} ${target}`)
      }
      if (run.edits > this.maxEdits) {
        this.violation(run, 'many changes', `more than ${this.maxEdits} file edits in one run`)
      }
    } else if (part.name === 'Bash' && typeof part.input?.command === 'string') {
      this.shell(run, part.input.command)
    }
  }

  async ended(task) {
    const run = this.runs.get(task.id)
    if (!run) return
    this.runs.delete(task.id)
    await run.ready
    await this.checkHead(run)
    await this.checkSize(run)
  }

  checkAll() {
    for (const run of this.runs.values()) this.checkHead(run)
  }

  // --- the default branch -----------------------------------------------------

  async checkHead(run) {
    if (run.direct || !run.head) return
    if (run.checking) return run.checking
    run.checking = (async () => {
      const head = await this.head(run)
      if (!head || head === run.head) return
      const moved = `${run.branch} on GitHub moved from ${short(run.head)} to ${short(head)} during the run`
      const local = await this.runner.git(run.dir, 'cat-file', '-e', `${head}^{commit}`)
      if (local !== null) {
        this.violation(run, 'push to the default branch', `${moved}, and the worker's repository holds the new head`)
      } else {
        // A merge on GitHub makes a commit the worker does not have.
        const pull = await this.mergedPull(run, head)
        if (pull) {
          this.violation(run, 'push to the default branch', `${moved}: it merged pull request ${pull.number} from ${pull.branch}, ${pull.why}`)
        }
      }
      run.head = head // otherwise someone else pushed or merged; that is the new baseline
    })().finally(() => {
      run.checking = null
    })
    return run.checking
  }

  // The pull request the new head merged into the default branch, if it is
  // the run's: the run pushed its branch (named in a git push, or logged by
  // the worker's repository since the run started), or it was opened during
  // the run from a voice/ branch. Not the run's: a merge of a pull request
  // that was there before the run and that the run did not push to, such as
  // the driver's merge at the desk of an earlier worker's pull request.
  async mergedPull(run, head) {
    const pulls = await gh(this.ghBin, ['api', `repos/${run.slug}/commits/${head}/pulls`])
    for (const pull of Array.isArray(pulls) ? pulls : []) {
      const branch = pull?.head?.ref
      if (!pull?.merged_at || pull.base?.ref !== run.branch || typeof branch !== 'string') continue
      const from = pull.head.repo?.full_name
      if (from && from.toLowerCase() !== run.slug.toLowerCase()) continue // from a fork
      const found = { number: pull.number, branch }
      if (run.pushed.has(branch) || (await this.pushedSince(run, branch))) return { ...found, why: 'which the run pushed' }
      const opened = Date.parse(pull.created_at)
      if (branch.startsWith('voice/') && opened >= run.startedAt - CLOCK_SLACK_MS) {
        return { ...found, why: 'opened during the run' }
      }
    }
    return null
  }

  // Whether the worker's repository logged a push to the branch since the run
  // started: git push moves origin/<branch>, with "update by push".
  async pushedSince(run, branch) {
    const reflog = await this.runner.git(run.dir, 'reflog', 'show', '--date=unix', '--format=%gd %gs', `refs/remotes/origin/${branch}`)
    const since = Math.floor(run.startedAt / 1000)
    return (reflog ?? '').split('\n').some(line => {
      const match = /@\{(\d+)\} update by push$/.exec(line.trim())
      return Boolean(match) && Number(match[1]) >= since
    })
  }

  shell(run, command) {
    let cwd = run.dir
    for (const segment of segments(command)) {
      const all = words(segment)
      let at = 0
      while (at < all.length && (WRAPPERS.has(all[at]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[at]))) at++
      const [name, ...args] = all.slice(at)
      if (!name) continue
      if (name === 'cd') {
        cwd = args[0] ? this.resolve(cwd, args[0]) : this.home
        continue
      }
      const push = name === 'git' ? pushTargets(args) : null
      if (push && (push.all || push.branches.includes(run.branch ?? 'main')) && !run.direct) {
        this.violation(run, 'push to the default branch', `the command "${preview(segment, 120)}"`)
      }
      if (push) {
        for (const branch of push.branches) run.pushed.add(branch)
        // Whatever the command line says, GitHub has the last word, a moment later.
        setTimeout(() => this.checkHead(run), 5000).unref()
      }
      const merge = name === 'gh' && !run.direct ? ghMerge(args, command) : null
      if (merge) this.violation(run, 'push to the default branch', `the command "${preview(segment, 120)}" ${merge}`)
      for (const target of this.targets(segment, name, args)) {
        const path = cwd === null ? null : this.resolve(cwd, target)
        if (path && !this.allowed(run, path)) {
          this.violation(run, 'write outside the allowed folders', `"${preview(segment, 120)}" writes ${path}`)
        }
      }
    }
  }

  // --- writes -------------------------------------------------------------------

  // Explicit write targets of one command: redirections and known commands.
  targets(segment, name, args) {
    const found = []
    for (const match of segment.matchAll(/(?:^|[^<>&0-9])(?:[0-9]|&)?>>?\s*([^\s;&|<>]+)/g)) {
      if (!match[1].startsWith('&')) found.push(match[1])
    }
    const operands = args.filter(arg => !arg.startsWith('-'))
    if (['tee', 'rm', 'rmdir', 'mkdir', 'touch', 'truncate', 'shred', 'unlink'].includes(name)) found.push(...operands)
    else if (['chmod', 'chown', 'chgrp'].includes(name)) found.push(...operands.slice(1))
    else if (['cp', 'mv', 'install', 'ln', 'rsync'].includes(name) && operands.length > 1) found.push(operands.at(-1))
    else if (name === 'sed' && args.some(arg => /^-i/.test(arg) || arg === '--in-place')) found.push(...operands.slice(1))
    else if (name === 'dd') found.push(...args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)))
    return found.filter(path => !DEVICES.includes(path))
  }

  // An absolute path, or null where a variable hides it.
  resolve(base, path) {
    let expanded = String(path)
    if (expanded === '~' || expanded.startsWith('~/')) expanded = this.home + expanded.slice(1)
    expanded = expanded.replace(/^\$\{?HOME\}?(?=\/|$)/, this.home)
    if (/[$`]/.test(expanded)) return null
    if (!expanded.startsWith('/') && base === null) return null
    return posix.resolve(base ?? '/', expanded)
  }

  allowed(run, path) {
    return [run.dir, ...this.allowedRoots].some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'))
  }

  // --- size ---------------------------------------------------------------------

  async checkSize(run) {
    const since = Math.floor(run.startedAt / 1000)
    const [committed, pending, untracked] = await Promise.all([
      this.runner.git(run.dir, 'log', '--all', `--since=@${since}`, '--numstat', '--format='),
      this.runner.git(run.dir, 'diff', '--numstat', 'HEAD'),
      this.runner.git(run.dir, 'ls-files', '--others', '--exclude-standard'),
    ])
    const files = new Set()
    let lines = 0
    for (const line of `${committed ?? ''}\n${pending ?? ''}`.split('\n')) {
      const [added, deleted, path] = line.split('\t')
      if (!path) continue
      files.add(path)
      lines += (Number(added) || 0) + (Number(deleted) || 0)
    }
    for (const path of (untracked ?? '').split('\n')) if (path) files.add(path)
    if (files.size > this.maxFiles || lines > this.maxLines) {
      this.violation(run, 'many changes', `${files.size} files and ${lines} lines changed in one run (limits ${this.maxFiles} files, ${this.maxLines} lines)`)
    }
  }
}
