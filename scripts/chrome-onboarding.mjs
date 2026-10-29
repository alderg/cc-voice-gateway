#!/usr/bin/env node
// Marks Claude in Chrome's first-start notice as seen, so that an unattended
// start of the controller session does not wait at the terminal.
// scripts/start-controller.sh runs it before every start with
// VOICE_GW_CONTROLLER_CHROME=1.
//
// At the first interactive start with Claude in Chrome on (--chrome), Claude
// Code shows a notice before the session starts: "Claude in Chrome works with
// the Chrome extension to let you control your browser directly from Claude
// Code. …", with "Enter to confirm · Esc to cancel". Nothing goes on until
// someone presses a key, so a start by the watchdog or the autostart hung
// there. Claude Code notes that the notice was shown as
// hasCompletedClaudeInChromeOnboarding in its global config, ~/.claude.json
// ($CLAUDE_CONFIG_DIR/.claude.json when that is set), and skips it from then
// on, on every project and after updates. Neither a flag nor an environment
// variable skips it, and `claude config` is gone, so this script sets that
// key. Read from Claude Code 2.1.310.
//
// It sets that one key and leaves every other one as it is, writes only when
// the key is not set yet, and holds the lock Claude Code takes for that file
// meanwhile (the folder .claude.json.lock next to it, made by proper-lockfile).
// Running sessions re-read the file under that lock before they save theirs,
// so none of them loses the key or a change of its own. The new file replaces
// the old one in one step. Prints one line:
//
//   seen           the key was set already; nothing written
//   marked         set now
//   failed <why>   not set: if Claude Code shows the notice, the session
//                  waits for Enter at the terminal

import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const KEY = 'hasCompletedClaudeInChromeOnboarding'
const STALE_MS = 10000 // proper-lockfile's default, which Claude Code keeps: an older lock was left behind

export const configFile = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')

// For the log: ~/.claude.json rather than the whole path.
const shown = path => (path.startsWith(homedir() + '/') ? '~' + path.slice(homedir().length) : path)

// The parsed config, or why not. A missing file is no config to add to:
// Claude Code writes it at its first start, together with the sign-in, which
// needs the terminal anyway.
function read(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { why: `${shown(path)} does not exist yet: Claude Code has not run here as this user` }
    return { why: `${shown(path)} cannot be read (${error.code ?? error.message})` }
  }
  let config
  try {
    config = JSON.parse(text)
  } catch {
    return { why: `${shown(path)} is not valid JSON` }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { why: `${shown(path)} holds no JSON object` }
  return { config, text }
}

// Claude Code's lock on its config: a folder, since mkdir either makes it or
// fails. Waits while another process holds it, and takes over one that was
// left behind, as proper-lockfile does. Returns the release, or null.
async function lock(path, waitMs) {
  const dir = `${path}.lock`
  const until = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(dir)
      return () => rmdirSync(dir)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    try {
      if (Date.now() - statSync(dir).mtimeMs > STALE_MS) {
        rmdirSync(dir)
        continue
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue // released meanwhile
    }
    if (Date.now() >= until) return null
    await sleep(50)
  }
}

export async function markChromeOnboarding({ env = process.env, waitMs = 5000 } = {}) {
  const path = configFile(env)
  const first = read(path)
  if (first.why) return { state: 'failed', why: first.why }
  if (first.config[KEY] === true) return { state: 'seen' }

  // A symlinked config stays a link: the new file replaces its target.
  let target
  try {
    target = realpathSync(path)
  } catch (error) {
    return { state: 'failed', why: `${shown(path)} cannot be resolved (${error.code ?? error.message})` }
  }
  let release
  try {
    release = await lock(path, waitMs)
  } catch (error) {
    return { state: 'failed', why: `the lock next to ${shown(path)} cannot be taken (${error.code ?? error.message})` }
  }
  if (!release) return { state: 'failed', why: `another Claude Code process held the lock on ${shown(path)} for ${waitMs / 1000} s` }
  const temp = join(dirname(target), `.claude.json.voice-gw-${process.pid}`)
  try {
    // Read again under the lock: a session may have saved meanwhile.
    const { config, text, why } = read(target)
    if (why) return { state: 'failed', why }
    if (config[KEY] === true) return { state: 'seen' }
    config[KEY] = true
    // Indented as Claude Code writes it, with the same mode.
    writeFileSync(temp, JSON.stringify(config, null, 2) + (text.endsWith('\n') ? '\n' : ''), { mode: 0o600 })
    chmodSync(temp, statSync(target).mode & 0o777)
    renameSync(temp, target)
    return { state: 'marked' }
  } catch (error) {
    rmSync(temp, { force: true })
    return { state: 'failed', why: `${shown(path)} cannot be written (${error.code ?? error.message})` }
  } finally {
    try {
      release()
    } catch {}
  }
}

const real = path => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const { state, why } = await markChromeOnboarding()
  console.log(why ? `${state} ${why}` : state)
}
