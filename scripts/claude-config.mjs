// Claude Code's global config, ~/.claude.json ($CLAUDE_CONFIG_DIR/.claude.json
// when that is set), as the start script and the setup assistant change it so
// that an unattended start of the controller does not wait at the terminal:
// Claude in Chrome's notice (chrome-onboarding.mjs) and the folder trust
// question (folder-trust.mjs).
//
// A change sets what it needs and leaves every other key as it is, writes
// only when something is missing, and holds the lock Claude Code takes for
// that file meanwhile (the folder .claude.json.lock next to it, made by
// proper-lockfile). Running sessions re-read the file under that lock before
// they save theirs, so none of them loses the change or one of its own. The
// new file replaces the old one in one step, with the old one's mode; a
// symlinked config stays a link. A file that is missing, cannot be read or
// does not parse is left alone: nothing broken is ever written.

import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const STALE_MS = 10000 // proper-lockfile's default, which Claude Code keeps: an older lock was left behind

export const configFile = (env = process.env, home = homedir()) => join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')

// For the log: ~/.claude.json rather than the whole path.
export const shown = path => (path.startsWith(homedir() + '/') ? '~' + path.slice(homedir().length) : path)

// The parsed config, or why not. A missing file is no config to add to:
// Claude Code writes it at its first start, together with the sign-in, which
// needs the terminal anyway.
export function readConfig(path) {
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

// Applies change(config) where done(config) is not true yet. { state }:
// seen (nothing to do, nothing written), marked (written now), or failed
// with why (nothing written).
export async function updateConfig({ env = process.env, waitMs = 5000, done, change }) {
  const path = configFile(env)
  const first = readConfig(path)
  if (first.why) return { state: 'failed', why: first.why }
  if (done(first.config)) return { state: 'seen' }

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
    const { config, text, why } = readConfig(target)
    if (why) return { state: 'failed', why }
    if (done(config)) return { state: 'seen' }
    change(config)
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

export const real = path => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Whether a module runs as the script itself (url: its import.meta.url).
export const isMain = (argv1, url) => Boolean(argv1) && real(argv1) === real(fileURLToPath(url))
