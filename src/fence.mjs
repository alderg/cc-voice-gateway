// The fence of a worker's run: what the kill switch's rule on writes outside
// reads from a tool call (guard.mjs), and the refusal of the guard's hook,
// which keeps such a call from running at all (guardHooks).
//
// One module for both, so that they agree: the gateway's rule follows the
// run and locks the kill switch on what it finds; the hook, in the worker's
// own Claude Code, reads each Bash, Write, Edit, MultiEdit and NotebookEdit
// call with the same code before it runs, and refuses it with a message to
// the worker where the rule would find a write outside the allowed folders.
// It only ever refuses, never allows: a hook that cannot tell, does not run,
// or finds no fence leaves the call to the rule, which stays the safety net.
//
// Self-contained, with nothing but Node's own modules: the hook runs it on
// this computer from the gateway's checkout, and in the worker container
// from a copy the gateway puts there (CONTAINER_NOTES, guard.mjs).
//
// The fence is a small JSON file next to the guard's notes for the run
// (<notes>.fence), which the gateway writes when the run starts and again
// when the folders granted to its repository change: { v, task, dir, home,
// runFolder, allowed, kind, granted }.

import { readFileSync } from 'node:fs'
import { posix } from 'node:path'

export const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
export const FENCE_VERSION = 1

// The words every refusal of the guard's hook begins with; the call's id
// follows in brackets, which the command of the call cannot know, so that the
// rule can tell a refused call from one that ran and printed these words.
export const REFUSED = "The gateway's guard refused this call"
export const refusalTag = id => `${REFUSED} (${id})`

// Writing to these changes no file: the null device and its kind, the
// standard streams, terminals, and file descriptors that are open already
// (opening them for writing was a redirection of its own).
export function isDevice(path) {
  return (
    ['/dev/null', '/dev/zero', '/dev/full', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(path) ||
    /^\/(?:dev\/fd|proc\/self\/fd|dev\/pts)\/\d+$/.test(path)
  )
}

// A git hook, in any .git: also the run's own repository's.
export const gitHook = path => /(?:^|\/)\.git\/hooks(?:\/|$)/.test(path)

// Whether a path is one of the folders, or inside one.
export const within = (path, roots) => roots.some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'))

export const basename = name => String(name ?? '').split('/').pop()

// A text in one line, cut to max characters (as log.mjs's preview).
export function clip(text, max = 80) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'nice'])
// Words of compound commands before the command itself, or after it.
export const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac'])
// Commands whose words are not a command: a loop's list, a case's word.
export const CLAUSES = new Set(['for', 'select', 'case', 'function'])
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

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
    const current = at => (command ??= { type: 'command', words: [], writes: [], redirects: [], heredocs: [], start: at, end: at })
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
      if (target.text) {
        command.writes.push(target.text)
        command.redirects.push({ target: target.text, op: op.endsWith('>>') ? 'append' : op === '<>' ? 'edit' : 'create' })
      }
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
      command.heredocs.push(body) // a script it writes to a file may run later (walkShell)
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

// The command of a simple command's words: past keywords (if, do, …),
// wrappers (sudo, env, …) and variable assignments. { name, args }.
export function commandOf(words) {
  let at = 0
  while (at < words.length && (KEYWORDS.has(words[at]) || WRAPPERS.has(words[at]) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[at]))) {
    at++
  }
  const [name = null, ...args] = words.slice(at)
  return { name, args }
}

// What a command writes by its operands, [{ target, op }]: the files and
// folders of the commands that make, change or remove them, with what it
// does to them (append, edit, remove, move, mode, truncate, mkdir, link, or
// create for a new file). mv also removes what it moves.
export function operationsOf(name, args) {
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
  const as = (op, targets) => targets.map(target => ({ target, op }))
  if (name === 'tee') return as(args.some(arg => arg === '--append' || /^-[a-zA-Z]*a/.test(arg)) ? 'append' : 'create', operands)
  if (['rm', 'rmdir', 'shred', 'unlink'].includes(name)) return as('remove', operands)
  if (name === 'mkdir') return as('mkdir', operands)
  if (name === 'touch') return as('create', operands)
  if (name === 'truncate') return as('truncate', operands)
  if (['chmod', 'chown', 'chgrp'].includes(name)) return as('mode', operands.slice(1))
  if (['cp', 'mv', 'install', 'ln', 'rsync'].includes(name)) {
    const op = { mv: 'move', ln: 'link' }[name] ?? 'create'
    if (name === 'install' && args.includes('-d') && into === null) return as('mkdir', operands)
    const [target, sources] = into !== null ? [into, operands] : operands.length > 1 ? [operands.at(-1), operands.slice(0, -1)] : [null, []]
    if (target === null) return []
    return [{ target, op }, ...(name === 'mv' ? as('remove', sources) : [])]
  }
  if (name === 'sed' && args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) {
    // The script is the first operand, unless -e or -f gave it.
    const scripts = args.some(arg => /^-[a-zA-Z]*[ef]$/.test(arg) || /^--(expression|file)/.test(arg))
    const files = []
    for (let i = 0; i < args.length; i++) {
      if (/^-[a-zA-Z]*[ef]$/.test(args[i]) || ['--expression', '--file'].includes(args[i])) i++
      else if (!args[i].startsWith('-')) files.push(args[i])
    }
    return as('edit', scripts ? files : files.slice(1))
  }
  if (name === 'dd') return as('create', args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)))
  return []
}

// A path as the run writes it, with its .. and . as written, as the kernel
// gets it: absolute, or null where a variable hides it. ~ and $HOME are the
// run's home, $TMPDIR and $VOICE_GW_RUN_FOLDER its run folder, which the
// gateway set for it (workers.mjs); a relative path counts from base.
export function expandPath(path, base, { home, runFolder = null }) {
  let expanded = String(path)
  if (expanded === '~' || expanded.startsWith('~/')) expanded = home + expanded.slice(1)
  expanded = expanded.replace(/^\$\{?HOME\}?(?=\/|$)/, () => home)
  if (runFolder) expanded = expanded.replace(/^\$(?:\{(TMPDIR|VOICE_GW_RUN_FOLDER)\}|(TMPDIR|VOICE_GW_RUN_FOLDER)\b)(?=\/|$)/, () => runFolder)
  if (/[$`]/.test(expanded)) return null
  if (expanded.startsWith('/')) return expanded
  return base === null ? null : `${base}/${expanded}`
}

const resolved = raw => (raw === null ? null : posix.resolve(raw))

// The commands of a Bash call, as a shell runs them (parseShell), with the
// folder each runs in: cd changes it for what follows, but not out of a
// subshell or a substitution; after a cd whose target a variable hides,
// only absolute targets count. sh -c, bash -c and eval run their text, and
// a script that cat or tee wrote from a heredoc is checked as shell
// commands when the same call runs it, with a shell or by its path.
// visit.command(name, args, { cwd, shown }) for each command, before its
// writes; visit.write({ target, op, raw, path, cwd, shown }) for each write,
// path null where a variable hides it. place: { home, runFolder }. Returns
// the folder the call leaves its shell in, null where it cannot tell.
export function walkShell(command, cwd, place, visit) {
  const outer = []
  const scripts = new Map() // path -> script written from a heredoc in this call
  const resolve = (base, path) => resolved(expandPath(path, base, place))
  for (const event of parseShell(command)) {
    if (event.type === 'open') {
      outer.push(cwd)
      continue
    }
    if (event.type === 'close') {
      if (outer.length) cwd = outer.pop()
      continue
    }
    const shown = `"${clip(event.text, 120)}"`
    const { name, args } = commandOf(event.words)
    const ops = [...event.redirects]
    if (name && !CLAUSES.has(name)) {
      if (name === 'cd' || name === 'pushd') {
        const dir = args.find(arg => !arg.startsWith('-') || arg === '-')
        cwd = dir === undefined ? place.home : dir === '-' ? null : resolve(cwd, dir)
      } else if (name === 'popd') {
        cwd = null
      }
      visit.command?.(name, args, { cwd, shown })
      ops.push(...operationsOf(name, args))
      const c = SHELLS.has(basename(name)) ? args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) : -1
      if (c >= 0 && args[c + 1] !== undefined) walkShell(args[c + 1], cwd, place, visit)
      if (name === 'eval' && args.length) walkShell(args.join(' '), cwd, place, visit)
      if (event.heredocs.length && ['cat', 'tee'].includes(name)) {
        for (const { target } of ops) {
          const path = resolve(cwd, target)
          if (path) scripts.set(path, event.heredocs.join(''))
        }
      }
      const file = SHELLS.has(basename(name)) || ['source', '.'].includes(name) ? args.find(arg => !arg.startsWith('-')) : name
      const script = file !== undefined && scripts.get(resolve(cwd, file))
      if (script) walkShell(script, cwd, place, visit)
    }
    for (const { target, op } of ops) {
      const raw = expandPath(target, cwd, place)
      visit.write({ target, op, raw, path: resolved(raw), cwd, shown })
    }
  }
  return outer.length ? outer[0] : cwd
}

// --- the guard's hook -----------------------------------------------------------

// The writes outside the fence that a call would make, as the rule reads
// them: [{ path, op, shown }]. A file tool's path counts from the workspace,
// a command from the folder Claude Code starts it in. What the fence allows:
// its folders (the workspace, the memory folders, the temporary folders, the
// run folder, VOICE_GW_KILL_ALLOW_PATHS and every folder granted to the
// repository) and the devices; a git hook never.
export function fenceWrites(fence, name, input, cwd = null) {
  const place = { home: fence.home, runFolder: fence.runFolder ?? null }
  const allowed = fence.allowed.filter(dir => typeof dir === 'string' && dir.startsWith('/'))
  const out = path => Boolean(path) && (gitHook(path) || !(isDevice(path) || within(path, allowed)))
  const found = []
  if (FILE_TOOLS[name]) {
    const given = input?.[FILE_TOOLS[name]]
    const path = typeof given === 'string' ? resolved(expandPath(given, fence.dir, place)) : null
    if (out(path)) found.push({ path, op: name === 'Write' ? 'create' : 'edit', shown: `${name} ${path}` })
    return found
  }
  if (name !== 'Bash' || typeof input?.command !== 'string') return found
  const start = typeof cwd === 'string' && cwd.startsWith('/') ? posix.normalize(cwd) : fence.dir
  walkShell(input.command, start, place, {
    write: ({ path, op, shown }) => {
      if (out(path)) found.push({ path, op, shown })
    },
  })
  return found
}

const WOULD = {
  create: 'write',
  append: 'append to',
  edit: 'change',
  remove: 'remove or move away',
  move: 'move files to',
  mode: 'change the mode or owner of',
  truncate: 'truncate',
  mkdir: 'make the folder',
  link: 'make a link at',
}

// What the worker reads when the hook refuses a call: what it would touch,
// that it must not, where it may write, and to name leftover files in its
// result rather than clean them up.
export function refusalText(fence, id, writes) {
  const [first] = writes
  const others = new Set(writes.map(write => write.path)).size - 1
  const what = gitHook(first.path) ? `write the git hook ${first.path}` : `${WOULD[first.op] ?? 'write'} ${first.path}`
  const more = others > 0 ? ` (and ${others} more path${others === 1 ? '' : 's'})` : ''
  const granted = Array.isArray(fence.granted) && fence.granted.length ? `, the folders granted to this repository (${fence.granted.join(', ')})` : ''
  const own =
    fence.kind === 'scratch'
      ? `your work folder ${fence.dir}`
      : `${fence.kind === 'worktree' ? 'your worktree' : 'your repository'} ${fence.dir}` +
        (fence.runFolder ? `, your run folder ${fence.runFolder} (also $TMPDIR and $VOICE_GW_RUN_FOLDER)` : '') +
        granted
  return (
    `${refusalTag(id)} before it ran: it would ${what}${more}, outside your allowed folders, and nothing of it ran. ` +
    `Write only in ${own} and the temporary folders. Do not move, remove or tidy up files outside them, not even ` +
    'ones a tool left there, such as caches and logs in your home folder: leave them where they are and name them ' +
    'in your result instead. Do not look for another way around this. A refused call counts as an invalid write: ' +
    'the third invalid write of a run stops all work.'
  )
}

// The hook's question, for a call about to run (input: what Claude Code
// hands a PreToolUse hook): the refusal's text, or null to let the call
// go on. Never throws; without a fence that it can read, null.
export function refusal(input, fenceFile) {
  try {
    const fence = JSON.parse(readFileSync(fenceFile, 'utf8'))
    if (fence?.v !== FENCE_VERSION || typeof fence.dir !== 'string' || typeof fence.home !== 'string' || !Array.isArray(fence.allowed)) return null
    const writes = fenceWrites(fence, input?.tool_name, input?.tool_input, input?.cwd)
    return writes.length && typeof input?.tool_use_id === 'string' ? refusalText(fence, input.tool_use_id, writes) : null
  } catch {
    return null
  }
}
