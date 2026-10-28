#!/usr/bin/env node
// PreToolUse hook: confines the controller session's file tools and shell.
//
//   Read, Glob, Grep           only inside controller/
//   Write, Edit, NotebookEdit  only inside controller/playground/
//   Bash                       only `ls` inside controller/, `sleep <seconds>`,
//                              `rm [-f] <files in playground/>`, read-only
//                              `gh pr` and `gh run` commands with --repo, and
//                              `gh pr merge`, which always asks for approval
//
// Whoever knows the connector URL can also answer approval prompts, so an ask
// rule is no protection against them; the settings let these tools run without
// asking instead. A hook that exits with code 2 blocks the call before any
// permission rule or prompt, so no allow rule or approval can override it.
// Paths are resolved through symlinks, so a link in the playground that points
// elsewhere does not help.
//
// Bash is an allowlist instead of Claude Code's sandbox: on Ubuntu 24.04 and
// later, AppArmor's bwrap-userns-restrict profile stops the sandbox from
// starting. The three commands cover the test tasks (look, wait, clean up);
// everything else the controller does with the file tools. Recent Claude Code
// versions have no Glob or Grep tool, so `ls` is the only way to list a folder.
// The gh commands answer status questions about pull requests, reviews and
// checks; every subcommand, flag and value of them is on an allowlist too.
// A merge is the one write: for it the hook answers "ask" instead of letting
// it run, which overrides the settings' allow rule for Bash, so Claude Code
// opens an approval prompt that the channel relays to the car.
//
// Fails closed: anything unexpected blocks the call.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTROLLER = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const PLAYGROUND = join(CONTROLLER, 'playground')

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const SHELL_RULE =
  'Shell commands are limited to `ls [-aAlhR1tSr] [folders here]`, `sleep <seconds>`, ' +
  '`rm [-f] <files in playground/>`, read-only `gh pr view|list|checks|diff|status` and ' +
  '`gh run view|list` with `--repo owner/name`, and `gh pr merge <number> --repo owner/name ' +
  '--squash|--merge|--rebase [--delete-branch]`, without quotes, wildcards, pipes or other shell syntax. ' +
  'gh takes plain flags only: no --web, --jq or --template, and `--json` with a comma-separated field ' +
  'list. Use ls and Read to look around.'

function block(reason) {
  process.stderr.write(`${reason}\n`)
  process.exit(2)
}

// Lets the call go ahead only after an approval prompt, whatever the allow
// rules say. The reason is shown with the prompt.
function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
    }),
  )
  process.exit(0)
}

const inside = (path, root) => path === root || path.startsWith(root + sep)

const expandHome = path => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path)

// Absolute path with every existing part resolved through symlinks. Parts that
// do not exist yet (a file about to be written) are appended unchanged.
function realResolve(path, base) {
  let current = resolve(base, expandHome(path))
  const rest = []
  for (;;) {
    try {
      return join(realpathSync(current), ...rest)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(base, expandHome(path))
      rest.unshift(basename(current))
      current = parent
    }
  }
}

// The fixed directory part of a glob pattern, e.g. "/home/x/*.txt" -> "/home/x".
function globBase(pattern) {
  const parts = pattern.split('/')
  const fixed = []
  for (const part of parts) {
    if (/[*?[\]{}]/.test(part)) break
    fixed.push(part)
  }
  return fixed.join('/') || '.'
}

function paths(tool, input) {
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return [input.file_path]
    case 'NotebookEdit':
      return [input.notebook_path]
    case 'Glob': {
      const base = input.path || '.'
      const pattern = String(input.pattern ?? '')
      return isAbsolute(pattern) || pattern.startsWith('~') ? [base, globBase(pattern)] : [base, join(base, globBase(pattern))]
    }
    case 'Grep': {
      const base = input.path || '.'
      const glob = input.glob ? String(input.glob) : ''
      return glob ? [base, isAbsolute(glob) || glob.startsWith('~') ? globBase(glob) : join(base, globBase(glob))] : [base]
    }
    default:
      return []
  }
}

// Read-only gh commands about pull requests and workflow runs. Each one names
// its repository with --repo (or -R), because the controller does not sit in
// the driver's repositories. Every flag has a fixed shape for its value, or
// takes none (FLAG); whatever is not listed, such as gh api, gh auth, --web,
// --jq or a write subcommand, is blocked.
const FLAG = null
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/
const FIELDS = /^[A-Za-z]+(,[A-Za-z]+)*$/
const NUMBER = /^[0-9]{1,12}$/
const LIMIT = /^[0-9]{1,4}$/
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/ // branch, label or workflow file, never a flag
const LOGIN = /^(@me|(app\/)?[A-Za-z0-9][A-Za-z0-9-]*)$/
const PR = /^([0-9]{1,9}|[A-Za-z0-9_][A-Za-z0-9._/-]*)$/ // number or branch
const oneOf = (...values) => new RegExp(`^(${values.join('|')})$`)

const REPO_FLAGS = { '--repo': REPO, '-R': REPO }
const GH = {
  'pr view': { arg: PR, flags: { '--json': FIELDS, '--comments': FLAG, '-c': FLAG } },
  'pr list': {
    flags: {
      '--json': FIELDS,
      '--state': oneOf('open', 'closed', 'merged', 'all'),
      '-s': oneOf('open', 'closed', 'merged', 'all'),
      '--limit': LIMIT,
      '-L': LIMIT,
      '--author': LOGIN,
      '-A': LOGIN,
      '--assignee': LOGIN,
      '-a': LOGIN,
      '--base': NAME,
      '-B': NAME,
      '--head': NAME,
      '-H': NAME,
      '--label': NAME,
      '-l': NAME,
      '--draft': FLAG,
      '-d': FLAG,
    },
  },
  'pr checks': { arg: PR, flags: { '--json': FIELDS, '--required': FLAG } },
  'pr diff': { arg: PR, flags: { '--name-only': FLAG, '--patch': FLAG } },
  'pr status': { flags: { '--json': FIELDS, '--conflict-status': FLAG, '-c': FLAG } },
  'run view': {
    arg: NUMBER,
    flags: {
      '--json': FIELDS,
      '--log': FLAG,
      '--log-failed': FLAG,
      '--verbose': FLAG,
      '-v': FLAG,
      '--job': NUMBER,
      '-j': NUMBER,
      '--attempt': NUMBER,
      '-a': NUMBER,
      '--exit-status': FLAG,
    },
  },
  'run list': {
    flags: {
      '--json': FIELDS,
      '--limit': LIMIT,
      '-L': LIMIT,
      '--branch': NAME,
      '-b': NAME,
      '--status': oneOf(
        'queued', 'completed', 'in_progress', 'requested', 'waiting', 'action_required', 'cancelled',
        'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out',
      ),
      '--workflow': NAME, // not -w: that is --web elsewhere
      '--event': /^[a-z_]+$/,
      '-e': /^[a-z_]+$/,
      '--user': LOGIN,
      '-u': LOGIN,
      '--commit': /^[0-9a-f]{7,40}$/,
      '-c': /^[0-9a-f]{7,40}$/,
    },
  },
}

const MERGE_METHODS = { '--squash': 'squash', '--merge': 'merge commit', '--rebase': 'rebase' }

// gh pr merge <number> --repo owner/name --squash|--merge|--rebase [--delete-branch]
// and nothing else: no --admin past branch protection, no --auto, no message
// flags, no branch instead of a number. Returns what the approval prompt says.
function checkMerge(words) {
  let number = null
  let repo = null
  let method = null
  let deleteBranch = false
  for (let i = 2; i < words.length; i++) {
    const word = words[i]
    if (NUMBER.test(word) && number === null) number = word
    else if ((word === '--repo' || word === '-R') && repo === null && REPO.test(words[i + 1] ?? '')) repo = words[++i]
    else if (Object.hasOwn(MERGE_METHODS, word) && method === null) method = MERGE_METHODS[word]
    else if (word === '--delete-branch' && !deleteBranch) deleteBranch = true
    else return null
  }
  if (number === null || repo === null || method === null) return null
  return (
    `Merge pull request ${number} in ${repo} (${method}${deleteBranch ? ', then delete its branch' : ''}). ` +
    'Every merge needs the driver\'s approval.'
  )
}

// words: everything after "gh". Returns 'allow', or the reason for an
// approval prompt (a merge), or false.
function checkGh(words) {
  if (words[0] === 'pr' && words[1] === 'merge') return checkMerge(words) ?? false
  const spec = GH[`${words[0]} ${words[1]}`]
  if (!spec) return false
  const flags = { ...REPO_FLAGS, ...spec.flags }
  let repo = false
  let args = 0
  for (let i = 2; i < words.length; i++) {
    const word = words[i]
    if (!word.startsWith('-')) {
      if (!spec.arg || ++args > 1 || !spec.arg.test(word)) return false
      continue
    }
    if (!Object.hasOwn(flags, word)) return false
    if (flags[word] === FLAG) continue
    const value = words[++i]
    if (value === undefined || !flags[word].test(value)) return false
    if (word in REPO_FLAGS) repo = true
  }
  return repo && 'allow'
}

// Four command shapes, made of plain words: no quoting, variables, globbing,
// redirection or chaining can hide in them. Commas (field lists) and @ (@me)
// only for gh. Returns 'allow', the reason for an approval prompt, or false.
function checkShell(command, base) {
  if (typeof command !== 'string' || !/^[A-Za-z0-9._/ ,@-]+$/.test(command)) return false
  const words = command.trim().split(/ +/)
  if (words[0] === 'gh') return checkGh(words.slice(1))
  if (/[,@]/.test(command)) return false
  return checkLocal(words, base) && 'allow'
}

function checkLocal(words, base) {
  if (words[0] === 'sleep') return words.length === 2 && /^[0-9]{1,4}$/.test(words[1])
  if (words[0] === 'ls') {
    return words
      .slice(1)
      .every(word => (word.startsWith('-') ? /^-[aAlhR1tSr]+$/.test(word) : inside(realResolve(word, base), CONTROLLER)))
  }
  if (words[0] !== 'rm') return false
  const files = words[1] === '-f' ? words.slice(2) : words.slice(1)
  return (
    files.length > 0 &&
    files.every(file => {
      if (file.startsWith('-') || ['.', '..'].includes(basename(file))) return false
      const real = realResolve(file, base)
      return real !== PLAYGROUND && inside(real, PLAYGROUND)
    })
  )
}

let event
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
} catch {
  block('confine: could not read the hook input')
}

const tool = event.tool_name
const base = event.cwd || CONTROLLER

if (tool === 'Bash') {
  const decision = checkShell(event.tool_input?.command, base)
  if (!decision) block(`Blocked in the voice controller session. ${SHELL_RULE}`)
  if (decision !== 'allow') ask(decision)
  process.exit(0)
}
if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) process.exit(0)

const root = WRITE_TOOLS.has(tool) ? PLAYGROUND : CONTROLLER
for (const path of paths(tool, event.tool_input ?? {})) {
  if (typeof path !== 'string' || !path) block(`confine: ${tool} without a path`)
  const real = realResolve(path, base)
  if (!inside(real, root)) {
    block(
      `Blocked in the voice controller session: ${tool} is only allowed inside ${root}. ` +
        `${real} is outside. Tell the driver this is not possible from the car.`,
    )
  }
}
process.exit(0)
