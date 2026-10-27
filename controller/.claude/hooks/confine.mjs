#!/usr/bin/env node
// PreToolUse hook: confines the controller session's file tools and shell.
//
//   Read, Glob, Grep           only inside controller/
//   Write, Edit, NotebookEdit  only inside controller/playground/
//   Bash                       only `ls` inside controller/, `sleep <seconds>` and
//                              `rm [-f] <files in playground/>`
//
// Whoever knows the connector URL can also answer approval prompts, so an ask
// rule is no protection against them. A hook that exits with code 2 blocks the
// call before any permission rule or prompt, so no approval can override it.
// Paths are resolved through symlinks, so a link in the playground that points
// elsewhere does not help.
//
// Bash is an allowlist instead of Claude Code's sandbox: on Ubuntu 24.04 and
// later, AppArmor's bwrap-userns-restrict profile stops the sandbox from
// starting. The three commands cover the test tasks (look, wait, clean up);
// everything else the controller does with the file tools. Recent Claude Code
// versions have no Glob or Grep tool, so `ls` is the only way to list a folder.
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
  'Shell commands are limited to `ls [-aAlhR1tSr] [folders here]`, `sleep <seconds>` and ' +
  '`rm [-f] <files in playground/>`, without quotes, wildcards, pipes or other shell syntax. ' +
  'Use ls and Read to look around.'

function block(reason) {
  process.stderr.write(`${reason}\n`)
  process.exit(2)
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

// Only three command shapes, made of plain words: no quoting, variables,
// globbing, redirection or chaining can hide in them.
function checkShell(command, base) {
  if (typeof command !== 'string' || !/^[A-Za-z0-9._/ -]+$/.test(command)) return false
  const words = command.trim().split(/ +/)
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
  if (!checkShell(event.tool_input?.command, base)) block(`Blocked in the voice controller session. ${SHELL_RULE}`)
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
