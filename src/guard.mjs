// Fixed rules on the workers' runs, checked by the gateway while it follows
// them, whatever the instructions say. A violation trips the kill switch,
// which locks at VOICE_GW_KILLSWITCH=auto and only logs it otherwise.
//
//   default branch  a push to the repository's default branch, or a merge
//                   into it, that was not an explicit direct dispatch at
//                   level full, in a repository with pull requests turned on
//                   (without them, the default branch is where workers push).
//                   In the run's commands: git push with the default branch
//                   (or --all, --mirror) as target, gh api calls that merge
//                   (REST and GraphQL), and gh pr merge into the default
//                   branch: for gh pr merge the gateway looks up the pull
//                   request's base on GitHub with its own gh, also for runs in
//                   the container (prMerge), and lets it go only when that
//                   base is not the default branch. Whatever it cannot be sure
//                   of locks, as every gh pr merge did before: the command not
//                   alone on its line, --auto, --admin, a flag it does not
//                   know, a variable or a pattern in it, another repository,
//                   a repository that gh would take from a folder it cannot
//                   be sure of, a lookup that fails or takes longer than
//                   mergeLookupMs. A merge it let go is looked at again on
//                   GitHub later and at the end (recheckMerges): merged into
//                   the default branch after all, its base changed after the
//                   lookup, it locks; a gateway that takes the run over goes
//                   by the pull requests let go before (task.mergesLetGo).
//                   gh pr edit --base is no merge. On GitHub, with gh: the
//                   default branch moved during the run, and the worker's
//                   repository holds the new head, or the new head merged a
//                   pull request of the run (mergedPull).
//   outside         writes outside the repository (for a run in a worktree,
//                   outside its worktree), its run folder (workspaces.mjs),
//                   the temporary folders and
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
//                   commits made during the run on any branch, each by its
//                   own changes, and what is not committed; in a work folder,
//                   more files in it than maxFiles. What a commit that only
//                   branches the run made hold takes over from before the run
//                   counts nothing (reused): a file set to a version that a
//                   commit from before the run had at that path, or removed
//                   where the default branch does not have it, as review
//                   branches made of existing code, a cherry-pick or a rebase
//                   do. A commit on a branch from before the run (its reflog
//                   tells) counts in full: setting it back, removing what it
//                   has or rewriting its history is a change. So does all of
//                   it after a push to a URL, and whatever git cannot tell.
//                   The run's helper folder (HELPER_FOLDER, workspaces.mjs)
//                   counts apart, against maxHelperFiles: the file edits
//                   there, and at the end what is untracked there. What is
//                   committed or tracked from it counts as before. So do the
//                   file edits in its run folder and the temporary folders,
//                   which hold no change of the repository's; what is in
//                   them at the end is no change at all.
//
// What the size check at the end counted, with whether the run pushed, also
// goes to the statistics ('measured', stats.mjs): the commits made during
// the run, the files and lines changed.
//
// The rules observe the run; they cannot stop its first step. A gh pr merge
// into the default branch locks once the lookup has answered, a moment after
// the command started, as a push to it locks once its command shows. What
// they miss is in the README ("Limits"): targets hidden in variables, scripts
// or other languages, and on GitHub anything gh cannot see. In the Docker
// setup, git runs only in the container (runner.git); never on this computer
// in the mounted folder, and gh only on this computer.

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { log as defaultLog, preview } from './log.mjs'
import { tempFolders } from './platform.mjs'
import { HELPER_FOLDER, inHelperFolder } from './workspaces.mjs'
import { WORKTREES, listWorktrees } from './worktrees.mjs'

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
// The size check's look through the history of the files that the run's
// own branches changed (versionsBefore): at most this many paths in one git
// call, this many calls, each within this time. Beyond, nothing is left out.
const PATHS_PER_LOOK = 1000
const MAX_LOOKS = 10
const HISTORY_MS = 60 * 1000

// The gh on this computer, the gateway's, also for runs in the container.
function gh(ghBin, args, timeout = 30000) {
  return new Promise(resolve => {
    execFile(ghBin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (error, stdout) => {
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

// Whether a path is one of the folders, or inside one.
const within = (path, roots) => roots.some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'))

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
// branches it names as targets, whether it pushes all of them, and whether
// it pushes to a URL or a path rather than to a remote, so that no remote
// branch in the repository shows what it pushed; null for another git
// command.
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
    elsewhere: rest.some(arg => arg === '--repo' || arg.startsWith('--repo=')) || /[:/]/.test(positional[0] ?? ''),
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

// What a gh api command merges, in a few words, or null. The whole command
// line for GraphQL, whose query may span lines. gh pr merge is prMerge's.
function ghMerge(args, command) {
  if (args[0] !== 'api') return null
  const { method, endpoint } = ghApi(args)
  const path = endpoint.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const mutation = MERGE_MUTATIONS.exec(command)?.[1]
  if (/(?:^|\/)graphql$/.test(path) && mutation) return `merges through the GraphQL API (${mutation})`
  if (method === 'PUT' && /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(path)) return 'merges a pull request'
  if (method === 'POST' && /(?:^|\/)repos\/[^/]+\/[^/]+\/merges$/.test(path)) return 'merges a branch'
  return null
}

// --- gh pr merge ----------------------------------------------------------------
//
// gh pr merge [<number> | <url> | <branch>] [flags], as gh 2.x reads it. The
// flags that take a value, the switches that change only how it merges, and
// the two that keep locking: --auto merges later, when the base may have
// changed, and --admin goes past the branch protection. Any other flag,
// --disable-auto and --help too, is one the rule does not read: it locks.
const PR_MERGE_VALUES = new Set(['--author-email', '--body', '--body-file', '--match-head-commit', '--subject', '--repo'])
const PR_MERGE_SWITCHES = new Set(['--delete-branch', '--merge', '--rebase', '--squash'])
const PR_MERGE_SHORT_VALUES = { A: '--author-email', b: '--body', F: '--body-file', t: '--subject', R: '--repo' }
const PR_MERGE_SHORT_SWITCHES = new Set(['d', 'm', 'r', 's'])
// What the shell would still expand in a word, as far as parseShell leaves it
// there: a variable, a pattern, braces. Such a word may be more words, or
// other ones, when the command runs.
const EXPANDS = /[$`*?[\]{}\n]/
// A GitHub remote, or a repository given as a URL: owner and name.
const GITHUB_URL = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?\/|(?:[^@/\s]+@)?github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
const PULL_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// The flags and the argument of gh pr merge (args after "gh"): { selector,
// repos, auto, admin }, or { unknown } with the word the rule cannot read.
// Short flags may be clustered (-sd), and take their value attached (-Rx,
// -R=x) or as the next word, as gh's flag parser does.
export function prMergeArgs(args) {
  const repos = []
  const positional = []
  let auto = false
  let admin = false
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (/^--auto(?:=|$)/.test(arg)) auto = true
    else if (/^--admin(?:=|$)/.test(arg)) admin = true
    else if (PR_MERGE_SWITCHES.has(arg)) continue
    else if (arg.startsWith('--')) {
      const [, flag, inline] = /^(--[^=]*)(?:=([\s\S]*))?$/.exec(arg)
      if (!PR_MERGE_VALUES.has(flag)) return { unknown: arg }
      const value = inline ?? args[++i]
      if (value === undefined) return { unknown: arg }
      if (flag === '--repo') repos.push(value)
    } else if (arg.length > 1 && arg.startsWith('-')) {
      for (let j = 1; j < arg.length; j++) {
        if (PR_MERGE_SHORT_SWITCHES.has(arg[j])) continue
        const flag = PR_MERGE_SHORT_VALUES[arg[j]]
        if (!flag) return { unknown: arg }
        const value = arg.slice(j + 1).replace(/^=/, '') || args[++i]
        if (value === undefined) return { unknown: arg }
        if (flag === '--repo') repos.push(value)
        break
      }
    } else {
      positional.push(arg)
    }
  }
  if (positional.length > 1) return { unknown: positional.join(' ') }
  return { selector: positional[0] ?? null, repos, auto, admin }
}

// Which pull request the argument names, as gh reads it: { number }, a URL's
// { slug, number }, a branch's { branch, owner } (owner:branch for one from
// a fork), { current } for none, the current branch's; null for a URL gh
// would not read as a pull request's.
export function prSelector(selector) {
  if (selector === null) return { current: true }
  if (/^#?\d+$/.test(selector)) return { number: Number(selector.replace('#', '')) }
  if (/^[a-z]+:\/\//i.test(selector)) {
    const url = PULL_URL.exec(selector)
    return url ? { slug: `${url[1]}/${url[2]}`, number: Number(url[3]) } : null
  }
  const colon = selector.indexOf(':')
  return colon > 0 ? { owner: selector.slice(0, colon), branch: selector.slice(colon + 1) } : { owner: null, branch: selector }
}

// owner/name of --repo's [HOST/]OWNER/REPO or URL on github.com, or null.
export function repoFlag(value) {
  const url = GITHUB_URL.exec(value)
  if (url) return `${url[1]}/${url[2]}`
  const parts = String(value).split('/')
  if (parts.length === 3 && /^(?:www\.)?github\.com$/i.test(parts[0])) parts.shift()
  return parts.length === 2 && parts.every(part => /^[\w.-]+$/.test(part)) ? parts.join('/') : null
}

// owner/name of a git remote's URL on github.com, or null.
export function remoteRepo(url) {
  const match = GITHUB_URL.exec(String(url ?? '').trim())
  return match ? `${match[1]}/${match[2]}` : null
}

const pullList = numbers => (numbers.length === 1 ? `pull request ${numbers[0]}` : `pull requests ${numbers.join(', ')}`)

export class RunGuard extends EventEmitter {
  constructor({
    workers,
    runner,
    killswitch,
    ghBin = 'gh',
    limits = {},
    allowed = [],
    mainCheckSeconds = 30,
    mergeLookupMs = 10000,
    mergeRecheckMs = 30000,
    log = defaultLog,
  }) {
    super()
    this.workers = workers
    this.runner = runner
    this.killswitch = killswitch
    this.ghBin = ghBin
    // gh pr merge: how long the lookup of its base may take before the rule
    // locks, and when a merge it let go is looked at again (prMerge).
    this.mergeLookupMs = mergeLookupMs
    this.mergeRecheckMs = mergeRecheckMs
    this.timers = new Set()
    this.maxEdits = limits.maxEdits ?? 500
    this.maxFiles = limits.maxFiles ?? 300
    this.maxLines = limits.maxLines ?? 30000
    this.maxHelperFiles = limits.maxHelperFiles ?? 10000 // in the helper folder: files at the end, and edits
    this.log = log
    this.allowedPaths = allowed // VOICE_GW_KILL_ALLOW_PATHS
    this.runs = new Map() // task id -> what the rules know about the run
    // repository \0 branch -> the task whose git push named it last: with
    // several runs in one repository, one run's branch is not another's.
    this.pushedBy = new Map()
    this.ghWarned = false
    workers.on('started', task => this.started(task))
    workers.on('tool', (task, part) => this.tool(task, part))
    workers.on('ended', task => this.ended(task))
    this.timer = setInterval(() => this.checkAll(), mainCheckSeconds * 1000)
    this.timer.unref()
  }

  close() {
    clearInterval(this.timer)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    timer.unref()
    this.timers.add(timer)
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
    const temp = docker ? ['/tmp', '/var/tmp'] : tempFolders()
    return {
      home,
      claudeConfig: (!docker && process.env.CLAUDE_CONFIG_DIR) || `${home}/.claude`,
      temp,
      roots: [...new Set([...temp, ...this.allowedPaths])],
    }
  }

  // Also for runs that were going when the gateway started. The runner of
  // the run's workspace, as Workers knows it. A run in a work folder may
  // write only there, in the temporary folders and in its memory folder: not
  // in VOICE_GW_KILL_ALLOW_PATHS.
  started(task) {
    if (this.runs.has(task.id)) return
    const runner = this.workers.runnerOf?.(task) ?? this.runner
    const { home, claudeConfig, temp, roots } = this.places(runner)
    const scratch = task.kind === 'scratch'
    // A run in a repository also has its run folder (workspaces.mjs), its
    // own: never the folders around it, nor another run's.
    const runFolder = !scratch && typeof task.runFolder === 'string' && task.runFolder.startsWith('/') ? task.runFolder : null
    const run = {
      id: task.id,
      task, // the workers' record of it, in their state
      repo: task.repo,
      scratch,
      runner,
      home,
      runFolder,
      roots: scratch ? temp : [...roots, ...(runFolder ? [runFolder] : [])], // where it may write besides its workspace and its memory folder
      // Where its file edits count apart, with the helper folder's: its run
      // folder and the temporary folders, which hold no change of its own.
      helpers: scratch ? [] : [...temp, ...(runFolder ? [runFolder] : [])],
      dir: task.dir ?? runner.dir(task.repo), // a run in a worktree: the worktree, not the checkout
      memories: [],
      slug: task.slug ?? null,
      branch: task.defaultBranch ?? null,
      direct: (Boolean(task.direct) && task.access === 'full') || Boolean(task.pushDirect),
      startedAt: task.startedAt,
      head: null,
      pushed: new Set(), // branches the run's git push commands name
      // A git push to a URL or a path: where its commits went, no remote
      // branch in the repository shows (reused).
      pushedElsewhere: false,
      edits: 0,
      helperEdits: 0, // file edits in the helper folder, which count apart
      files: new Set(),
      tripped: new Set(),
      checking: null,
      lookups: new Set(), // gh pr merge: the lookups of a base going (prMerge)
      merges: [], // gh pr merge: the merges let go, for the look again (recheckMerges)
      // Whether run.cwd is where the shell really is: not after a cd the
      // rules could not follow, nor after a script run with source.
      cwdSure: true,
    }
    // Claude Code may key the memory of a worktree by the repository it
    // belongs to: both are the run's own.
    run.memories = [run.dir, task.checkout].filter(Boolean).map(dir => memoryFolder(claudeConfig, dir))
    run.worktree = Boolean(task.worktree)
    run.checkout = task.checkout ?? null
    run.cwd = run.dir // the shell's folder after its last Bash call (see shell)
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
      const target = typeof path === 'string' ? this.resolve(run, run.dir, path) : null
      if (target) run.files.add(target)
      if (target && !this.allowed(run, target)) this.violation(run, 'write outside the allowed folders', `${part.name} ${target}`)
      // A work folder is all the run's own; its edits count as edits.
      const helper = target && !run.scratch && (inHelperFolder(posix.relative(run.dir, target)) || within(target, run.helpers))
      if (helper) run.helperEdits++
      else run.edits++
      if (run.edits > this.maxEdits) {
        this.violation(run, 'many changes', `more than ${this.maxEdits} file edits in one run`)
      }
      if (run.helperEdits > this.maxHelperFiles) {
        this.violation(
          run,
          'many changes',
          `more than ${this.maxHelperFiles} file edits in the helper folder ${HELPER_FOLDER}, the run folder and the temporary folders in one run`,
        )
      }
    } else if (part.name === 'Bash' && typeof part.input?.command === 'string') {
      // Claude Code keeps the shell's folder from one Bash call to the next
      // while it stays in the workspace, and goes back to the workspace when
      // a call leaves it. After a cd it cannot follow, the workspace, as
      // before: a relative path is checked rather than let through.
      run.toolId = typeof part.id === 'string' && part.id ? part.id : null // Claude Code's id of the tool call
      const cwd = this.shell(run, part.input.command, run.cwd, true)
      if (cwd === null) run.cwdSure = false // for the rest of the run
      run.cwd = cwd && (cwd === run.dir || cwd.startsWith(run.dir.replace(/\/$/, '') + '/')) ? cwd : run.dir
    }
  }

  async ended(task) {
    const run = this.runs.get(task.id)
    if (!run) return
    this.runs.delete(task.id)
    await run.ready
    await this.settled(run)
    await this.recheckMerges(run)
    await this.checkHead(run)
    const size = await this.checkSize(run)
    if (size) this.emit('measured', task, { ...size, pushed: run.pushed.size > 0 })
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
      // A run next to it in the same repository that may push there: its
      // worktree shares the objects, so the head is no sign of this run.
      const direct = [...this.runs.values()].some(other => other !== run && other.repo === run.repo && other.direct)
      if (local !== null && !direct) {
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
  // the driver's merge at the desk of an earlier worker's pull request; nor
  // one of another run of the same repository, by the branch it pushed or
  // the pull request it named (several runs per repository).
  async mergedPull(run, head) {
    const pulls = await gh(this.ghBin, ['api', `repos/${run.slug}/commits/${head}/pulls`])
    for (const pull of Array.isArray(pulls) ? pulls : []) {
      const branch = pull?.head?.ref
      if (!pull?.merged_at || pull.base?.ref !== run.branch || typeof branch !== 'string') continue
      const from = pull.head.repo?.full_name
      if (from && from.toLowerCase() !== run.slug.toLowerCase()) continue // from a fork
      const found = { number: pull.number, branch }
      if (run.pushed.has(branch)) return { ...found, why: 'which the run pushed' }
      if (this.anotherRun(run, { branch, number: pull.number })) continue
      if (await this.pushedSince(run, branch)) return { ...found, why: 'which the run pushed' }
      const opened = Date.parse(pull.created_at)
      if (branch.startsWith('voice/') && opened >= run.startedAt - CLOCK_SLACK_MS) {
        return { ...found, why: 'opened during the run' }
      }
    }
    return null
  }

  // Whether a pull request or a branch is another run's of the same
  // repository: it named the pull request, or pushed the branch last.
  anotherRun(run, { branch = null, number = null }) {
    const pusher = branch ? this.pushedBy.get(`${run.repo}\0${branch}`) : null
    if (pusher && pusher !== run.id) return true
    const tasks = this.workers.state?.tasks ?? []
    return number !== null && tasks.some(t => t.id !== run.id && t.repo === run.repo && (t.pulls ?? []).includes(number))
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

  // --- gh pr merge -------------------------------------------------------------

  // A gh pr merge in the run merges into its pull request's base, which only
  // GitHub knows. So the rule looks the base up there, with the gh on this
  // computer, also for a run in the container, and lets the merge go when
  // the base is not the default branch. What it cannot be sure of locks, as
  // every gh pr merge did before: what the command line says at once
  // (mergePlan), the rest once the lookup has answered (lookupMerge). The
  // command runs meanwhile, as it did before: the rules see a step only
  // after it started.
  prMerge(run, { words, args, cwd, shown, alone }) {
    const lock = (why, what = 'a pull request') =>
      this.violation(run, 'push to the default branch', `the command ${shown} merges ${what}${why ? `, ${why}` : ''}`)
    const plan = this.mergePlan(run, { words, args, alone })
    if (plan.why) return lock(plan.why)
    // The same command read again, by a gateway that took the run over: the
    // pull requests an earlier gateway let it merge, whose bases are as they
    // were merged, rather than the branch and the folder as they are now.
    const id = run.toolId
    const earlier = id ? run.task.mergesLetGo?.[id] : null
    const again = sameRepo(earlier?.slug, plan.slug) && Array.isArray(earlier.numbers) && earlier.numbers.length > 0
    const lookup = this.withinLookupTime(again ? this.lookupPulls(plan.slug, earlier.numbers) : this.lookupMerge(run, plan, cwd))
      .then(found => this.decideMerge(run, found, lock, id))
      .catch(error => lock(`and the lookup of its base failed (${preview(error?.message ?? error, 60)})`))
      .catch(error => this.log('kill switch rule on the default branch:', error?.message ?? error))
      .finally(() => run.lookups.delete(lookup))
    run.lookups.add(lookup)
  }

  // What the command line says: { selector, slug, local }, local when gh
  // takes the repository or the branch from the folder it runs in; or
  // { why } it locks at once. Short reasons: the kill switch keeps 300
  // characters of one, with the command's.
  mergePlan(run, { words, args, alone }) {
    if (!alone || words[0] !== 'gh') return { why: 'not alone on its line, so its base is not looked up' }
    if (words.some(word => EXPANDS.test(word))) return { why: 'with a variable, a pattern or braces in it' }
    const parsed = prMergeArgs(args)
    if (parsed.unknown !== undefined) return { why: `with ${preview(parsed.unknown, 40)}, which the rule does not read` }
    if (parsed.auto) return { why: 'with --auto, which merges later' }
    if (parsed.admin) return { why: 'with --admin' }
    const selector = prSelector(parsed.selector)
    if (!selector || selector.branch === '') return { why: `and the rule cannot tell which pull request ${preview(parsed.selector, 40)} is` }
    if (!run.slug) return { why: "and the worker's repository is not on GitHub" }
    const repos = [...parsed.repos.map(repoFlag), ...(selector.slug ? [selector.slug] : [])]
    if (repos.some(repo => !sameRepo(repo, run.slug))) return { why: `in another repository than ${run.slug}` }
    // Without --repo or a URL, gh takes the repository from the git remotes
    // of the folder it runs in; without an argument, the pull request of
    // that folder's current branch.
    const local = Boolean(selector.current) || !repos.length
    if (local && !run.cwdSure) return { why: 'and the folder gh takes the repository from is not certain' }
    if (local && !run.runner.container && process.env.GH_REPO) return { why: 'and GH_REPO chooses the repository' }
    return { selector, slug: run.slug, local }
  }

  withinLookupTime(lookup) {
    let timer
    const late = new Promise(resolve => {
      timer = setTimeout(
        () => resolve({ why: `and the lookup of its base took longer than ${Math.round(this.mergeLookupMs / 100) / 10} seconds` }),
        this.mergeLookupMs,
      )
    })
    return Promise.race([lookup, late]).finally(() => clearTimeout(timer))
  }

  // The pull requests the command may merge, with their bases as GitHub has
  // them now: { slug, pulls: [{ number, base, defaultBranch }] }, or { why }.
  // For a branch, every open pull request from it: gh takes one of them.
  async lookupMerge(run, { selector, slug, local }, cwd) {
    let head = selector.branch !== undefined ? { owner: selector.owner, branch: selector.branch } : null
    if (local) {
      const folder = await this.mergeFolder(run, cwd, Boolean(selector.current))
      if (folder.why) return folder
      if (selector.current) head = { owner: null, branch: folder.branch }
    }
    if (!head) return this.lookupPulls(slug, [selector.number])
    const label = `${head.owner ?? slug.split('/')[0]}:${head.branch}`
    const query = `state=open&per_page=100&head=${encodeURIComponent(label)}`
    const pulls = await gh(this.ghBin, ['api', `repos/${slug}/pulls?${query}`], this.mergeLookupMs)
    if (!Array.isArray(pulls)) return { why: 'and gh could not look up its base on GitHub' }
    if (!pulls.length) return { why: `and GitHub has no open pull request from ${label}` }
    if (pulls.length >= 100) return { why: `and GitHub has too many open pull requests from ${label} to tell` }
    return this.bases(slug, pulls)
  }

  // Pull requests by their numbers.
  async lookupPulls(slug, numbers) {
    const pulls = await Promise.all(numbers.map(number => gh(this.ghBin, ['api', `repos/${slug}/pulls/${number}`], this.mergeLookupMs)))
    if (pulls.some((pull, i) => pull?.number !== numbers[i])) return { why: 'and gh could not look up its base on GitHub' }
    return this.bases(slug, pulls)
  }

  // What GitHub says of the pull requests: { slug, pulls }, or { why }.
  bases(slug, pulls) {
    const found = []
    for (const pull of pulls) {
      const base = pull?.base?.ref
      if (!Number.isInteger(pull?.number) || typeof base !== 'string' || !base) return { why: "and GitHub's answer names no base" }
      if (!sameRepo(pull.base.repo?.full_name, slug)) return { why: `and GitHub has its base in another repository than ${slug}` }
      const defaultBranch = pull.base.repo.default_branch
      found.push({ number: pull.number, base, defaultBranch: typeof defaultBranch === 'string' && defaultBranch ? defaultBranch : null })
    }
    return { slug, pulls: found }
  }

  // The folder a command runs in: gh takes the repository from its git
  // remotes, and the pull request of its current branch when the command
  // names none. {} or { branch } when gh can only take the worker's
  // repository, and of that branch the pull request from the same branch;
  // otherwise { why }. git runs where the run's does, in the container for a
  // run there.
  async mergeFolder(run, cwd, current) {
    const [remotes, config, head] = await Promise.all([
      run.runner.git(cwd, 'remote', '-v'),
      run.runner.git(cwd, 'config', '--get-regexp', '^(remote|branch)\\.'),
      current ? run.runner.git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD') : '',
    ])
    const where = 'the folder it runs in'
    if (remotes === null || config === null) return { why: `and git could not tell the remotes of ${where}` }
    // As gh sees them: git remote -v shows the URLs after url.*.insteadOf.
    const names = new Set()
    let foreign = null
    for (const line of remotes.split('\n')) {
      if (!line.trim()) continue
      const match = /^(\S+)\t(.+) \((?:fetch|push)\)$/.exec(line.trim())
      if (!match) return { why: `and the rule does not read the remotes of ${where}` }
      names.add(match[1])
      if (!sameRepo(remoteRepo(match[2]), run.slug)) foreign = match[1]
    }
    if (names.size !== 1) return { why: `and ${where} has ${names.size} git remotes` }
    const [remote] = names
    if (foreign) return { why: `and the remote ${remote} of ${where} is not ${run.slug} on GitHub` }
    const settings = new Map()
    for (const line of config.split('\n')) {
      if (!line) continue
      const space = line.indexOf(' ')
      const [key, value] = space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]
      // gh repo set-default: another repository as gh's base
      if (/^remote\..*\.gh-resolved$/.test(key) && value !== 'base' && !sameRepo(value, run.slug)) {
        return { why: `and ${where} has another repository set as gh's default` }
      }
      settings.set(key, value)
    }
    if (!current) return {}
    const branch = (head ?? '').trim()
    if (!branch) return { why: `and ${where} is on no branch` }
    const merge = settings.get(`branch.${branch}.merge`)
    const tracks = settings.get(`branch.${branch}.remote`)
    const pushes = settings.get(`branch.${branch}.pushremote`) ?? settings.get('remote.pushdefault')
    if ((merge !== undefined && merge !== `refs/heads/${branch}`) || (tracks !== undefined && tracks !== remote) || (pushes !== undefined && pushes !== remote)) {
      return { why: `and the branch ${preview(branch, 40)} tracks or pushes to another branch or remote` }
    }
    return { branch }
  }

  // Into the default branch, or not: the default branch as the run knew it
  // at its start, and as GitHub names it with the pull request now. What it
  // lets go is kept with the run's task, by the tool call's id, in the
  // workers' state, for a gateway that takes the run over and reads its
  // output again (prMerge).
  decideMerge(run, found, lock, id = null) {
    if (found.why) return lock(found.why)
    const { slug, pulls } = found
    const defaults = [...new Set([run.branch, ...pulls.map(pull => pull.defaultBranch)].filter(Boolean))]
    if (!defaults.length) return lock(`and the default branch of ${slug} is not known`)
    const isDefault = branch => defaults.some(name => name.toLowerCase() === branch.toLowerCase())
    const into = pulls.find(pull => isDefault(pull.base))
    if (into) return lock(null, `pull request ${into.number} in ${slug} into ${into.base}, the default branch`)
    const numbers = pulls.map(pull => pull.number)
    const bases = [...new Set(pulls.map(pull => pull.base))].join(', ')
    this.log(
      `kill switch rule on the default branch: let gh pr merge of ${pullList(numbers)} in ${slug} go, into ${bases}, ` +
        `not the default branch ${defaults.join(', ')} (worker ${run.repo}, task ${run.id})`,
    )
    const merge = { slug, numbers, bases: new Map(pulls.map(pull => [pull.number, pull.base])), defaults, settled: new Set() }
    run.merges.push(merge)
    this.later(this.mergeRecheckMs, () => this.recheckMerge(run, merge))
    if (id) {
      run.task.mergesLetGo = { ...run.task.mergesLetGo, [id]: { slug, numbers } }
      try {
        this.workers.save?.()
      } catch (error) {
        this.log('worker state not saved:', error.message)
      }
    }
  }

  // A merge the rule let go, looked at again on GitHub, a while later and at
  // the end of the run: merged into the default branch after all, its base
  // changed after the lookup, it locks. A merged pull request's base stays as
  // it was merged. A look that fails changes nothing; the check of the
  // default branch on GitHub (checkHead) still runs.
  async recheckMerge(run, merge) {
    for (const number of merge.numbers) {
      if (merge.settled.has(number)) continue
      const pull = await gh(this.ghBin, ['api', `repos/${merge.slug}/pulls/${number}`], this.mergeLookupMs)
      const base = pull?.base?.ref
      if (!(pull?.merged === true || pull?.merged_at) || typeof base !== 'string') continue
      merge.settled.add(number)
      const defaults = [...merge.defaults, pull.base.repo?.default_branch].filter(name => typeof name === 'string' && name)
      if (defaults.some(name => name.toLowerCase() === base.toLowerCase())) {
        this.violation(
          run,
          'push to the default branch',
          `pull request ${number} in ${merge.slug}, whose gh pr merge the rule let go into ${merge.bases.get(number)}, ` +
            `was merged into ${base}, the default branch: its base changed after the lookup`,
        )
      }
    }
  }

  async recheckMerges(run) {
    for (const merge of run.merges) await this.recheckMerge(run, merge)
  }

  // The lookups of gh pr merge still going in a run (prMerge).
  async settled(run) {
    while (run.lookups.size) await Promise.all([...run.lookups])
  }

  // The commands of a Bash call, as a shell runs them (parseShell), with the
  // folder each runs in: cd changes it for what follows, but not out of a
  // subshell or a substitution; after a cd whose target a variable hides,
  // only absolute targets count. sh -c, bash -c and eval run their text, and
  // a script that cat or tee wrote from a heredoc is checked as shell
  // commands when the same call runs it, with a shell or by its path.
  // Returns the folder the call leaves its shell in, null where it cannot
  // tell. top: the Bash call's own command line, not one it runs (sh -c,
  // eval, a script); only there may a gh pr merge stand alone (prMerge).
  shell(run, command, cwd = run.dir, top = false) {
    const outer = []
    const scripts = new Map() // path -> script written from a heredoc in this call
    const events = parseShell(command)
    // The line is this one simple command and nothing else: no other command,
    // no operator, no subshell, no substitution, no heredoc, no comment.
    const alone = top && events.length === 1 && events[0].type === 'command' && events[0].text === String(command).trim()
    for (const event of events) {
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
          for (const branch of push.branches) {
            run.pushed.add(branch)
            if (branch !== 'HEAD') this.pushedBy.set(`${run.repo}\0${branch}`, run.id)
          }
          if (push.elsewhere) run.pushedElsewhere = true
          // Whatever the command line says, GitHub has the last word, a moment later.
          setTimeout(() => this.checkHead(run), 5000).unref()
        }
        if (name === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
          if (!run.direct) this.prMerge(run, { words: event.words, args, cwd, shown, alone })
        } else {
          const merge = name === 'gh' && !run.direct ? ghMerge(args, command) : null
          if (merge) this.violation(run, 'push to the default branch', `the command ${shown} ${merge}`)
        }
        // A script run in this shell may cd anywhere.
        if (['source', '.'].includes(name)) run.cwdSure = false
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
    return outer.length ? outer[0] : cwd
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
  // the run's home, $TMPDIR and $VOICE_GW_RUN_FOLDER its run folder, which
  // the gateway set for it (workers.mjs).
  resolve(run, base, path) {
    let expanded = String(path)
    if (expanded === '~' || expanded.startsWith('~/')) expanded = run.home + expanded.slice(1)
    expanded = expanded.replace(/^\$\{?HOME\}?(?=\/|$)/, run.home)
    if (run.runFolder) expanded = expanded.replace(/^\$(?:\{(TMPDIR|VOICE_GW_RUN_FOLDER)\}|(TMPDIR|VOICE_GW_RUN_FOLDER)\b)(?=\/|$)/, run.runFolder)
    if (/[$`]/.test(expanded)) return null
    if (!expanded.startsWith('/') && base === null) return null
    return posix.resolve(base ?? '/', expanded)
  }

  allowed(run, path) {
    if (isDevice(path)) return true
    return within(path, [run.dir, ...run.memories, ...run.roots])
  }

  // --- size ---------------------------------------------------------------------

  // The refs whose commits since its start a run made: in a worktree, what
  // its HEAD and the branches it pushed have; in the checkout every ref, but
  // not what the worktrees of other runs of the repository have, nor the
  // branches they pushed. Several runs in one repository share its refs.
  async commitRefs(run) {
    // Refs that may be gone (a branch never pushed) are left out by git.
    const pushed = [...run.pushed].filter(b => b !== 'HEAD').map(b => `refs/remotes/origin/${b}`)
    if (run.worktree) return ['--ignore-missing', 'HEAD', ...pushed]
    const others = []
    for (const [key, id] of this.pushedBy) {
      const [repo, branch] = key.split('\0')
      if (repo === run.repo && id !== run.id) others.push(`refs/remotes/origin/${branch}`, `refs/heads/${branch}`)
    }
    const worktrees = run.runner.gitRun ? await listWorktrees(run.runner, run.dir).catch(() => []) : []
    for (const w of worktrees) if (w.head && w.dir.split('/').includes(WORKTREES)) others.push(w.head)
    return others.length ? ['--ignore-missing', '--all', '--not', ...others] : ['--all']
  }

  // Returns what it found, { commits, files, lines }, or null for a work
  // folder. What is untracked in the helper folder is no change of the run's:
  // it counts apart, against maxHelperFiles, and not in what it found. What
  // was committed from there, or is tracked there, counts as anywhere else.
  // What commits on the run's own branches took over from before the run
  // counts nothing (reused), and is not in what it found either.
  async checkSize(run) {
    if (run.scratch) {
      await this.checkFiles(run)
      return null
    }
    const since = Math.floor(run.startedAt / 1000)
    const refs = await this.commitRefs(run)
    const [committed, pending, untracked] = await Promise.all([
      run.runner.git(run.dir, 'log', ...refs, `--since=@${since}`, '--numstat', '--format=commit %H'),
      run.runner.git(run.dir, 'diff', '--numstat', 'HEAD'),
      run.runner.git(run.dir, 'ls-files', '--others', '--exclude-standard'),
    ])
    const reused = await this.reused(run, refs, committed).catch(() => new Set())
    const files = new Set()
    let lines = 0
    let commits = 0
    const left = { files: new Set(), lines: 0 } // what reused left out, for the log
    let sha = null
    for (const line of (committed ?? '').split('\n')) {
      if (line.startsWith('commit ')) {
        commits++
        sha = line.slice('commit '.length).trim()
        continue
      }
      const [added, deleted, path] = line.split('\t')
      if (!path) continue
      const size = (Number(added) || 0) + (Number(deleted) || 0)
      if (reused.has(`${sha}\0${path}`)) {
        left.files.add(path)
        left.lines += size
      } else {
        files.add(path)
        lines += size
      }
    }
    for (const line of (pending ?? '').split('\n')) {
      const [added, deleted, path] = line.split('\t')
      if (!path) continue
      files.add(path)
      lines += (Number(added) || 0) + (Number(deleted) || 0)
    }
    let helpers = 0
    for (const path of (untracked ?? '').split('\n')) {
      if (path && inHelperFolder(path)) helpers++
      else if (path) files.add(path)
    }
    const notCounted = left.files.size
      ? `, not counting ${left.lines} lines in ${left.files.size} files that branches the run made took over from before it`
      : ''
    if (notCounted) {
      this.log(`kill switch rule on many changes: ${files.size} files and ${lines} lines changed in one run${notCounted} (worker ${run.repo}, task ${run.id})`)
    }
    const over = []
    if (files.size > this.maxFiles || lines > this.maxLines) {
      over.push(`${files.size} files and ${lines} lines changed in one run (limits ${this.maxFiles} files, ${this.maxLines} lines)${notCounted}`)
    }
    if (helpers > this.maxHelperFiles) {
      over.push(`${helpers} untracked files in the helper folder ${HELPER_FOLDER} after one run (limit ${this.maxHelperFiles})`)
    }
    if (over.length) this.violation(run, 'many changes', over.join('; '))
    return { commits, files: files.size, lines }
  }

  // The file changes of the run's commits, as `${sha}\0${path}`, that take
  // over what was there before the run, and count nothing: on a branch the
  // run made, or on no branch, a file set to a version that a commit from
  // before the run had at that path (a review branch made of a branch's
  // existing code, a cherry-pick, a rebase), or removed where the default
  // branch does not have it (a branch without another branch's own files).
  // A commit that a branch from before the run holds, in the repository or
  // as a remote branch, counts in full: setting such a branch back, or
  // removing what it has, is a change, and so is rewriting its history.
  // Whatever git cannot tell counts, as before; so does all of it after a
  // push to a URL or a path, which no remote branch here shows.
  async reused(run, refs, committed) {
    const none = new Set()
    const shas = [...String(committed ?? '').matchAll(/^commit ([0-9a-f]{40,64})$/gm)].map(match => match[1])
    if (!shas.length || run.pushedElsewhere) return none
    const since = Math.floor(run.startedAt / 1000)
    const git = (...args) => run.runner.git(run.dir, ...args)
    // The branches that hold them, and of those the ones from before the run.
    const holding = await git('for-each-ref', '--format=%(refname)', ...shas.map(sha => `--contains=${sha}`), 'refs/heads', 'refs/remotes')
    if (holding === null) return none
    const before = await this.branchesBefore(run, holding.split('\n').filter(Boolean))
    if (!before) return none
    const theirs = before.length ? await git('rev-list', `--since=@${since}`, ...before) : ''
    if (theirs === null) return none
    const onBefore = new Set(theirs.split('\n'))
    const own = new Set(shas.filter(sha => !onBefore.has(sha)))
    if (!own.size) return none
    // What each of them did to each file: the version it left, or D. A
    // rename or a copy (two paths) counts, as does a path git quoted.
    const raw = await git('log', ...refs, `--since=@${since}`, '--raw', '--no-abbrev', '--format=commit %H')
    if (raw === null) return none
    const changes = []
    let sha = null
    for (const line of raw.split('\n')) {
      if (line.startsWith('commit ')) sha = line.slice('commit '.length).trim()
      if (!line.startsWith(':') || !own.has(sha)) continue
      const [meta, path, renamed] = line.split('\t') // :mode mode before after status, then the path
      const [, , , after, status] = meta.split(' ')
      if (path && renamed === undefined && !path.startsWith('"')) changes.push({ key: `${sha}\0${path}`, path, after, status })
    }
    const kept = changes.filter(change => ['A', 'M', 'T'].includes(change.status))
    const removed = changes.filter(change => change.status === 'D')
    const [versions, onDefault] = await Promise.all([
      kept.length ? this.versionsBefore(run, [...new Set(kept.map(change => change.path))]) : null,
      removed.length ? this.defaultPaths(run) : null,
    ])
    const reused = new Set()
    for (const change of kept) if (versions?.has(`${change.path}\0${change.after}`)) reused.add(change.key)
    for (const change of removed) if (onDefault && !onDefault.has(change.path)) reused.add(change.key)
    return reused
  }

  // Of the given branches, the ones from before the run: all but those it
  // made, whose reflog begins during the run with the branch's creation,
  // for a remote branch by a push (one a fetch brought was on the remote).
  // A creation has no value before it, so ref@{n} past the oldest entry
  // names none; after git expired older entries it names the value before.
  // A branch without a reflog counts as from before. null when git cannot
  // tell.
  async branchesBefore(run, branches) {
    if (!branches.length) return []
    const since = Math.floor(run.startedAt / 1000)
    const git = (...args) => run.runner.git(run.dir, ...args)
    const reflog = await git('log', '--walk-reflogs', '--date=unix', '--format=%gD %gs', ...branches)
    if (reflog === null) return null
    const entries = new Map() // branch -> { count, at, what } of its oldest entry; the newest come first
    for (const line of reflog.split('\n')) {
      const match = /^(.+)@\{(\d+)\}(?: (.*))?$/.exec(line)
      if (!match) continue
      const entry = entries.get(match[1]) ?? { count: 0 }
      entries.set(match[1], { count: entry.count + 1, at: Number(match[2]), what: match[3] ?? '' })
    }
    const made = await Promise.all(
      branches.map(async branch => {
        const oldest = entries.get(branch)
        if (!oldest || oldest.at < since) return false
        if (branch.startsWith('refs/remotes/') && oldest.what !== 'update by push') return false
        // Its oldest entry names a value and nothing came before it: a
        // creation, and not a git that did not answer.
        const [last, past] = await Promise.all(
          [oldest.count - 1, oldest.count].map(n => git('rev-parse', '--quiet', '--verify', `${branch}@{${n}}`)),
        )
        return last !== null && past === null
      }),
    )
    return branches.filter((branch, i) => !made[i])
  }

  // The versions that commits from before the run had at the given paths,
  // as `${path}\0${blob}`, from the whole history of the repository; null
  // when git cannot tell, or for too many paths.
  async versionsBefore(run, paths) {
    if (paths.length > PATHS_PER_LOOK * MAX_LOOKS) return null
    const until = Math.floor(run.startedAt / 1000) - 1
    const versions = new Set()
    for (let i = 0; i < paths.length; i += PATHS_PER_LOOK) {
      const out = await this.slowGit(run, [
        '--literal-pathspecs',
        'log',
        '--all',
        `--until=@${until}`,
        '--full-history',
        '-m',
        '--root',
        '--no-renames',
        '--raw',
        '--no-abbrev',
        '--format=',
        '--',
        ...paths.slice(i, i + PATHS_PER_LOOK),
      ])
      if (out === null) return null
      for (const line of out.split('\n')) {
        const [meta, path] = line.split('\t')
        if (!line.startsWith(':') || !path) continue
        const [, , before, after] = meta.split(' ')
        for (const blob of [before, after]) if (!/^0+$/.test(blob)) versions.add(`${path}\0${blob}`)
      }
    }
    return versions
  }

  // The paths of the default branch as the remote has it, or null.
  async defaultPaths(run) {
    if (!run.branch) return null
    const out = await this.slowGit(run, ['ls-tree', '-r', '--name-only', '--full-tree', `refs/remotes/origin/${run.branch}`])
    return out === null ? null : new Set(out.split('\n').filter(Boolean))
  }

  // git for a look that may take longer: with a time limit of its own where
  // the runner has gitRun, on this computer or in the container.
  async slowGit(run, args) {
    if (!run.runner.gitRun) return run.runner.git(run.dir, ...args)
    const { ok, stdout } = await run.runner.gitRun(run.dir, args, { timeout: HISTORY_MS })
    return ok ? stdout : null
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
