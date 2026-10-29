// Fixed rules on the workers' runs, checked by the gateway while it follows
// them, whatever the instructions say. A violation trips the kill switch,
// which locks at VOICE_GW_KILLSWITCH=auto and only logs it otherwise.
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
//   outside         writes outside the repository, the temporary folders and
//                   the run's own Claude Code memory folder (memoryFolder):
//                   the file tools by their path, shell commands by explicit
//                   targets (redirections, tee, cp, mv, rm, mkdir, touch, ln,
//                   chmod, chown, truncate, sed -i, dd of=), after cd. The
//                   command line is read as a shell reads it (parseShell):
//                   quoted text, comments and heredocs are data; commands in
//                   $(…), `…`, <(…), >(…), sh -c, eval, a shell's heredoc and
//                   a script written from a heredoc that the same call runs
//                   are commands. Devices such as /dev/null are no write. A
//                   run in a work folder (workspaces.mjs) may write only
//                   there and in its memory folder.
//   many changes    more file edits in a run than maxEdits; at the end, more
//                   files or lines changed than maxFiles or maxLines, counting
//                   commits made during the run on any branch and what is not
//                   committed; in a work folder, more files in it than
//                   maxFiles.
//
// The rules observe the run; they cannot stop its first step. What they miss
// is in the README ("Limits"): targets hidden in variables, scripts or
// other languages, and on GitHub anything gh cannot see. In the Docker setup,
// git runs only in the container (runner.git); never on this computer in the
// mounted folder.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { log as defaultLog, preview } from './log.mjs'
import { tempFolders } from './platform.mjs'

// The Claude Code memory folder of a session in the given folder, where its
// auto memory writes: <config>/projects/<folder with every character but
// letters and digits as ->/memory. Only the run's own, never another
// project's.
export function memoryFolder(config, dir) {
  return `${config}/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/memory`
}

const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'nice'])
// Words of compound commands before the command itself, or after it.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac'])
// Commands whose words are not a command: a loop's list, a case's word.
const CLAUSES = new Set(['for', 'select', 'case', 'function'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const short = sha => String(sha).slice(0, 7)

// Writing to these changes no file: the null device and its kind, the
// standard streams, terminals, and file descriptors that are open already
// (opening them for writing was a redirection of its own).
export function isDevice(path) {
  return (
    ['/dev/null', '/dev/zero', '/dev/full', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(path) ||
    /^\/(?:dev\/fd|proc\/self\/fd|dev\/pts)\/\d+$/.test(path)
  )
}

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

// --- shell command lines ------------------------------------------------------
//
// What the rules need from a command line, read as a shell reads it: the
// simple commands in the order they run, each with its words (quotes removed,
// escapes resolved; an expansion stays as written, $name or ${…}, and a
// command substitution becomes $(…)) and the targets of its redirections that
// write. Quoted text, comments, here-strings and heredoc bodies are data, so a
// > or a ; in a pattern, a message or a script that is written to a file is
// none. The commands in $(…), `…`, <(…) and >(…), in the body of a heredoc
// without quotes around its delimiter, and in a heredoc a shell reads, are
// commands, between { type: 'open' } and { type: 'close' }, as are those of a
// subshell ( … ): a cd in them stays there. In (( … )), $(( … )) and [[ … ]],
// < and > compare. Not a whole shell: what it does not see is in the README.

export function parseShell(source) {
  return new ShellParser(String(source)).parse(0, null).events
}

const REDIRECT = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/
const WRITES = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])

class ShellParser {
  constructor(src) {
    this.src = src
  }

  // From i to the end, or to the ) that closes what began before i (closer).
  // Returns { events, end }, end being after the closer. Every step moves on
  // by at least one character.
  parse(i, closer) {
    const src = this.src
    const events = []
    const pending = [] // heredocs, whose bodies begin with the next line
    let command = null
    let depth = 0 // subshells opened here
    const current = at => (command ??= { type: 'command', words: [], writes: [], heredocs: [], start: at, end: at })
    const finish = () => {
      if (!command) return
      command.text = src.slice(command.start, command.end).trim()
      events.push(command)
      command = null
    }
    // In [[ … ]], < > ( ) && || belong to the test.
    const inTest = () => {
      const open = command?.words.lastIndexOf('[[') ?? -1
      return open >= 0 && !command.words.slice(open).includes(']]')
    }
    while (i < src.length) {
      const c = src[i]
      const next = src[i + 1]
      const test = '<>()&|'.includes(c) && inTest()
      if (c === ' ' || c === '\t' || c === '\r') {
        i++
      } else if (c === '\\' && next === '\n') {
        i += 2
      } else if (c === '\n') {
        finish()
        i = this.heredocs(i + 1, pending, events)
      } else if (c === '#') {
        while (i < src.length && src[i] !== '\n') i++
      } else if (test && '<>()'.includes(c)) {
        current(i).words.push(c)
        command.end = ++i
      } else if (test && ((c === '&' && next === '&') || (c === '|' && next === '|'))) {
        current(i).words.push(c + next)
        command.end = i += 2
      } else if (c === ')') {
        finish()
        if (depth === 0 && closer === ')') return { events, end: i + 1 }
        if (depth > 0) {
          depth--
          events.push({ type: 'close' })
        }
        i++
      } else if (c === '(' && next === '(' && (!command || command.words.every(w => KEYWORDS.has(w) || w === 'for'))) {
        current(i).words.push('((…))') // arithmetic
        command.end = i = this.arithmetic(i + 2)
      } else if (c === '(') {
        finish()
        depth++
        events.push({ type: 'open' })
        i++
      } else if ((c === '<' || c === '>') && next === '(') {
        // A process substitution: its commands run, it is a word here.
        current(i)
        i = this.nested(i + 2, events)
        command.words.push('$(…)')
        command.end = i
      } else if (REDIRECT.test(src.slice(i, i + 12)) && !(c === '&' && next !== '>')) {
        i = this.redirect(i, current(i), pending, events)
        command.end = i
      } else if (c === ';' || c === '&' || c === '|') {
        finish()
        i += c === next || (c === '|' && next === '&') || (c === ';' && next === '&') ? 2 : 1
        if (c === ';' && src[i] === '&') i++ // ;;&
      } else {
        const word = this.word(i, events)
        current(i).words.push(word.text)
        command.end = i = word.end
      }
    }
    finish()
    return { events, end: i }
  }

  // A redirection at i: a write target goes to the command, a heredoc waits
  // for the next line. Returns the index after it.
  redirect(i, command, pending, events) {
    const src = this.src
    const [all, fd, op] = REDIRECT.exec(src.slice(i, i + 12))
    i += all.length
    while (src[i] === ' ' || src[i] === '\t') i++
    const target = this.word(i, events)
    if (op === '<<' || op === '<<-') {
      pending.push({ delimiter: target.text, strip: op === '<<-', quoted: target.quoted, command })
    } else if (WRITES.has(op) || (op === '>&' && !fd && !/^(\d+-?|-)$/.test(target.text))) {
      // >&word with a word that is no file descriptor writes to that file
      if (target.text) command.writes.push(target.text)
    }
    return target.end
  }

  // A substitution's commands from i to its ), between open and close.
  nested(i, events) {
    const inner = this.parse(i, ')')
    events.push({ type: 'open' }, ...inner.events, { type: 'close' })
    return inner.end
  }

  // From inside (( to after the matching )).
  arithmetic(i) {
    let depth = 2
    while (i < this.src.length) {
      const c = this.src[i++]
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i
    }
    return i
  }

  // One word from i: { text, quoted, end }.
  word(i, events) {
    const src = this.src
    let text = ''
    let quoted = false
    while (i < src.length && !' \t\r\n;&|()<>'.includes(src[i])) {
      const c = src[i]
      if (c === '\\') {
        if (src[i + 1] !== '\n') text += src[i + 1] ?? ''
        quoted = true
        i += 2
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1)
        const stop = end < 0 ? src.length : end
        text += src.slice(i + 1, stop)
        quoted = true
        i = stop + 1
      } else if (c === '$' && src[i + 1] === "'") {
        // $'…', with backslash escapes
        i += 2
        while (i < src.length && src[i] !== "'") {
          if (src[i] === '\\') {
            text += src[i + 1] ?? ''
            i += 2
          } else {
            text += src[i++]
          }
        }
        quoted = true
        i++
      } else if (c === '"') {
        quoted = true
        i++
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) {
            if (src[i + 1] !== '\n') text += src[i + 1]
            i += 2
          } else if (src[i] === '$' || src[i] === '`') {
            const expansion = this.expansion(i, events)
            text += expansion.text
            i = expansion.end
          } else {
            text += src[i++]
          }
        }
        i++
      } else if (c === '$' || c === '`') {
        const expansion = this.expansion(i, events)
        text += expansion.text
        i = expansion.end
      } else {
        text += c
        i++
      }
    }
    return { text, quoted, end: i }
  }

  // An expansion at i ($ or `): { text, end }; the commands of a
  // substitution go to events.
  expansion(i, events) {
    const src = this.src
    if (src[i] === '`') {
      // In backticks, \` \\ and \$ stand for the character itself.
      let j = i + 1
      let code = ''
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\' && '`\\$'.includes(src[j + 1] ?? '')) {
          code += src[j + 1]
          j += 2
        } else {
          code += src[j++]
        }
      }
      const inner = new ShellParser(code).parse(0, null)
      events.push({ type: 'open' }, ...inner.events, { type: 'close' })
      return { text: '$(…)', end: j + 1 }
    }
    const next = src[i + 1]
    if (next === '(' && src[i + 2] === '(') return { text: '$((…))', end: this.arithmetic(i + 3) }
    if (next === '(') return { text: '$(…)', end: this.nested(i + 2, events) }
    if (next === '{') {
      // ${…} to its brace; a substitution in it runs
      let j = i + 2
      let depth = 1
      let text = '${'
      while (j < src.length && depth) {
        const c = src[j]
        if (c === '\\') {
          text += src.slice(j, j + 2)
          j += 2
        } else if (c === "'") {
          const end = src.indexOf("'", j + 1)
          const stop = end < 0 ? src.length : end + 1
          text += src.slice(j, stop)
          j = stop
        } else if (c === '$' || c === '`') {
          const expansion = this.expansion(j, events)
          text += expansion.text
          j = expansion.end
        } else {
          if (c === '{') depth++
          else if (c === '}') depth--
          text += c
          j++
        }
      }
      return { text, end: j }
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(i + 1, i + 129))?.[0] ?? ''
    return { text: `$${name}`, end: i + 1 + name.length }
  }

  // The bodies of the heredocs opened on the line before, from i on. A body
  // is data, unless a shell reads it as its script. In one without quotes
  // around its delimiter, $(…) and `…` run. Returns the index after them.
  heredocs(i, pending, events) {
    const src = this.src
    while (pending.length) {
      const { delimiter, strip, quoted, command } = pending.shift()
      let body = ''
      while (i < src.length) {
        const end = src.indexOf('\n', i)
        const stop = end < 0 ? src.length : end
        const line = src.slice(i, stop)
        i = stop + 1
        if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
        body += `${line}\n`
      }
      command.heredocs.push(body) // a script it writes to a file may run later (RunGuard.shell)
      const { name, args } = commandOf(command.words)
      if (SHELLS.has(basename(name)) && !args.some(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))) {
        const inner = new ShellParser(body).parse(0, null)
        events.push({ type: 'open' }, ...inner.events, { type: 'close' })
      } else if (!quoted) {
        const inner = new ShellParser(body)
        for (let j = 0; j < body.length; ) {
          if (body[j] === '\\') j += 2
          else if (body[j] === '$' || body[j] === '`') j = inner.expansion(j, events).end
          else j++
        }
      }
    }
    return Math.min(i, src.length)
  }
}

const basename = name => String(name ?? '').split('/').pop()

// The command of a simple command's words: past keywords (if, do, …),
// wrappers (sudo, env, …) and variable assignments. { name, args }.
function commandOf(words) {
  let at = 0
  while (at < words.length && (KEYWORDS.has(words[at]) || WRAPPERS.has(words[at]) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[at]))) {
    at++
  }
  const [name = null, ...args] = words.slice(at)
  return { name, args }
}

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
    this.allowedPaths = allowed // VOICE_GW_KILL_ALLOW_PATHS
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

  // Where the runs of a runner live: in the container or on this computer.
  // Their home, Claude Code's folder there, and the folders they may write to
  // besides their workspace: the temporary ones (on macOS also /private/tmp
  // and the per-user /var/folders/…/T, platform.mjs) and
  // VOICE_GW_KILL_ALLOW_PATHS.
  places(runner) {
    const docker = Boolean(runner.container)
    const home = docker ? '/home/worker' : homedir()
    return {
      home,
      claudeConfig: (!docker && process.env.CLAUDE_CONFIG_DIR) || `${home}/.claude`,
      roots: [...new Set([...(docker ? ['/tmp', '/var/tmp'] : tempFolders()), ...this.allowedPaths])],
    }
  }

  // Also for runs that were going when the gateway started. The runner of
  // the run's workspace, as Workers knows it. A run in a work folder may
  // write only there and in its memory folder: not even in the temporary
  // folders or VOICE_GW_KILL_ALLOW_PATHS.
  started(task) {
    if (this.runs.has(task.id)) return
    const runner = this.workers.runnerOf?.(task) ?? this.runner
    const { home, claudeConfig, roots } = this.places(runner)
    const scratch = task.kind === 'scratch'
    const run = {
      id: task.id,
      repo: task.repo,
      scratch,
      runner,
      home,
      roots: scratch ? [] : roots, // where it may write besides its workspace and its memory folder
      dir: task.dir ?? runner.dir(task.repo),
      memory: null,
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
    run.memory = memoryFolder(claudeConfig, run.dir)
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
        const target = this.resolve(run, run.dir, path)
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
      const local = await run.runner.git(run.dir, 'cat-file', '-e', `${head}^{commit}`)
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
    const reflog = await run.runner.git(run.dir, 'reflog', 'show', '--date=unix', '--format=%gd %gs', `refs/remotes/origin/${branch}`)
    const since = Math.floor(run.startedAt / 1000)
    return (reflog ?? '').split('\n').some(line => {
      const match = /@\{(\d+)\} update by push$/.exec(line.trim())
      return Boolean(match) && Number(match[1]) >= since
    })
  }

  // The commands of a Bash call, as a shell runs them (parseShell), with the
  // folder each runs in: cd changes it for what follows, but not out of a
  // subshell or a substitution; after a cd whose target a variable hides,
  // only absolute targets count. sh -c, bash -c and eval run their text, and
  // a script that cat or tee wrote from a heredoc is checked as shell
  // commands when the same call runs it, with a shell or by its path.
  shell(run, command, cwd = run.dir) {
    const outer = []
    const scripts = new Map() // path -> script written from a heredoc in this call
    for (const event of parseShell(command)) {
      if (event.type === 'open') {
        outer.push(cwd)
        continue
      }
      if (event.type === 'close') {
        if (outer.length) cwd = outer.pop()
        continue
      }
      const shown = `"${preview(event.text, 120)}"`
      const { name, args } = commandOf(event.words)
      const targets = [...event.writes]
      if (name && !CLAUSES.has(name)) {
        if (name === 'cd' || name === 'pushd') {
          const dir = args.find(arg => !arg.startsWith('-') || arg === '-')
          cwd = dir === undefined ? run.home : dir === '-' ? null : this.resolve(run, cwd, dir)
        } else if (name === 'popd') {
          cwd = null
        }
        const push = name === 'git' ? pushTargets(args) : null
        if (push && (push.all || push.branches.includes(run.branch ?? 'main')) && !run.direct) {
          this.violation(run, 'push to the default branch', `the command ${shown}`)
        }
        if (push) {
          for (const branch of push.branches) run.pushed.add(branch)
          // Whatever the command line says, GitHub has the last word, a moment later.
          setTimeout(() => this.checkHead(run), 5000).unref()
        }
        const merge = name === 'gh' && !run.direct ? ghMerge(args, command) : null
        if (merge) this.violation(run, 'push to the default branch', `the command ${shown} ${merge}`)
        targets.push(...this.targets(name, args))
        const c = SHELLS.has(basename(name)) ? args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) : -1
        if (c >= 0 && args[c + 1] !== undefined) this.shell(run, args[c + 1], cwd)
        if (name === 'eval' && args.length) this.shell(run, args.join(' '), cwd)
        if (event.heredocs.length && ['cat', 'tee'].includes(name)) {
          for (const target of targets) {
            const path = this.resolve(run, cwd, target)
            if (path) scripts.set(path, event.heredocs.join(''))
          }
        }
        const file = SHELLS.has(basename(name)) || ['source', '.'].includes(name) ? args.find(arg => !arg.startsWith('-')) : name
        const script = file !== undefined && scripts.get(this.resolve(run, cwd, file))
        if (script) this.shell(run, script, cwd)
      }
      for (const target of targets) {
        const path = this.resolve(run, cwd, target)
        if (path && !this.allowed(run, path)) {
          this.violation(run, 'write outside the allowed folders', `${shown} writes ${path}`)
        }
      }
    }
  }

  // --- writes -------------------------------------------------------------------

  // What a command writes by its operands: the files and folders of the
  // commands that make, change or remove them.
  targets(name, args) {
    const operands = []
    const valued = { cp: ['-t', '-S'], mv: ['-t', '-S'], install: ['-t', '-m', '-o', '-g', '-S'], ln: ['-t', '-S'], rsync: [] }[name] ?? []
    let into = null // -t / --target-directory
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--') {
        operands.push(...args.slice(i + 1))
        break
      }
      if (['-t', '--target-directory'].includes(arg) && valued.includes('-t')) into = args[++i]
      else if (arg.startsWith('--target-directory=')) into = arg.slice('--target-directory='.length)
      else if (valued.includes(arg)) i++
      else if (!arg.startsWith('-') || arg === '-') operands.push(arg)
    }
    if (['tee', 'rm', 'rmdir', 'mkdir', 'touch', 'truncate', 'shred', 'unlink'].includes(name)) return operands
    if (['chmod', 'chown', 'chgrp'].includes(name)) return operands.slice(1)
    if (['cp', 'mv', 'install', 'ln', 'rsync'].includes(name)) {
      if (into !== null) return [into]
      if (name === 'install' && args.includes('-d')) return operands
      return operands.length > 1 ? [operands.at(-1)] : []
    }
    if (name === 'sed' && args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) {
      // The script is the first operand, unless -e or -f gave it.
      const scripts = args.some(arg => /^-[a-zA-Z]*[ef]$/.test(arg) || /^--(expression|file)/.test(arg))
      const files = []
      for (let i = 0; i < args.length; i++) {
        if (/^-[a-zA-Z]*[ef]$/.test(args[i]) || ['--expression', '--file'].includes(args[i])) i++
        else if (!args[i].startsWith('-')) files.push(args[i])
      }
      return scripts ? files : files.slice(1)
    }
    if (name === 'dd') return args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3))
    return []
  }

  // An absolute path, or null where a variable hides it; ~ and $HOME are
  // the run's home.
  resolve(run, base, path) {
    let expanded = String(path)
    if (expanded === '~' || expanded.startsWith('~/')) expanded = run.home + expanded.slice(1)
    expanded = expanded.replace(/^\$\{?HOME\}?(?=\/|$)/, run.home)
    if (/[$`]/.test(expanded)) return null
    if (!expanded.startsWith('/') && base === null) return null
    return posix.resolve(base ?? '/', expanded)
  }

  allowed(run, path) {
    if (isDevice(path)) return true
    return [run.dir, run.memory, ...run.roots].some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'))
  }

  // --- size ---------------------------------------------------------------------

  async checkSize(run) {
    if (run.scratch) return this.checkFiles(run)
    const since = Math.floor(run.startedAt / 1000)
    const [committed, pending, untracked] = await Promise.all([
      run.runner.git(run.dir, 'log', '--all', `--since=@${since}`, '--numstat', '--format='),
      run.runner.git(run.dir, 'diff', '--numstat', 'HEAD'),
      run.runner.git(run.dir, 'ls-files', '--others', '--exclude-standard'),
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

  // A work folder has no git: the files in it at the end count.
  async checkFiles(run) {
    const files = await Promise.resolve()
      .then(() => run.runner.files?.(run.dir, this.maxFiles))
      .catch(() => null)
    if (files && files.length > this.maxFiles) {
      this.violation(run, 'many changes', `more than ${this.maxFiles} files in the work folder after one run`)
    }
  }
}
