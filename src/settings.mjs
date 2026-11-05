// The gateway's settings file, .secrets/gateway.env, which the setup assistant
// writes (scripts/setup.mjs): one VOICE_GW_NAME=value per line, without
// quotes; lines starting with # are comments. The gateway reads it in
// config.mjs, the start scripts in scripts/settings.sh. A variable set in the
// environment from outside, for example in controller/.mcp.json, wins over
// the file (environmentWins). The file is read, never executed.

import { readFileSync } from 'node:fs'

export const SETTINGS_FILE_NAME = 'gateway.env'

const NAME = /^VOICE_GW_[A-Z0-9_]+$/

// The names scripts/settings.sh set from the file, as it lists them in the
// environment, separated by spaces.
export const FROM_FILE = 'VOICE_GW_SETTINGS_FROM_FILE'

// Whether a setting's value in the environment wins over the file's, by its
// name: only a value set from outside does. The watchdog's start script
// (scripts/settings.sh) exports the file's settings too, and lists their
// names in FROM_FILE: those are the file's. Without the list, when Claude
// Code started the gateway from controller/.mcp.json, someone by hand, or an
// older start script, a value equal to the file's (file: as it was at the
// start) counts as the file's. pinned: the names controller/.mcp.json sets,
// which always win.
export function environmentWins(env, file, pinned = []) {
  const listed = env[FROM_FILE]
  const fromFile = listed === undefined ? null : new Set(listed.split(/\s+/).filter(Boolean))
  return name => {
    if (env[name] === undefined || name === FROM_FILE) return false
    if (pinned.includes(name)) return true
    return fromFile ? !fromFile.has(name) : env[name] !== file[name]
  }
}

// The socket in the secrets folder where the controller's PermissionRequest
// hook hands its subagents' approval requests to the gateway (approvals.mjs).
export const APPROVAL_SOCKET_NAME = 'approval.sock'

// ${VAR} and ${VAR:-default}, as in .mcp.json files.
export const expandEnv = (value, env = process.env) =>
  String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => env[name] ?? fallback ?? '')

// The environment controller/.mcp.json gives the gateway's server, expanded
// as Claude Code would: for the plugin's server (plugin.mjs) and the
// controller's approval hook, which Claude Code starts without it. {} when
// the file is not there; throws when it cannot be read.
export function mcpEnv(file, env = process.env) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  // In order, each seeing those before it, as when they are set one by one.
  const result = {}
  for (const [name, value] of Object.entries(JSON.parse(text).mcpServers?.voice?.env ?? {})) {
    result[name] = expandEnv(value, { ...env, ...result })
  }
  return result
}

// The names controller/.mcp.json sets for the gateway; none when it cannot
// be read.
export function mcpEnvNames(file) {
  try {
    return Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers?.voice?.env ?? {})
  } catch {
    return []
  }
}

export function readSettings(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  return parseSettings(text)
}

// The settings in the file's text.
export function parseSettings(text) {
  const settings = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const at = line.indexOf('=')
    if (at < 0 || line.startsWith('#')) continue
    const name = line.slice(0, at)
    if (NAME.test(name)) settings[name] = line.slice(at + 1)
  }
  return settings
}

// The file's text; empty values are left out, so that the defaults apply.
export function formatSettings(settings, comments = []) {
  const lines = comments.map(comment => `# ${comment}`)
  for (const [name, value] of Object.entries(settings)) {
    if (!NAME.test(name)) throw new Error(`not a setting: ${name}`)
    const text = String(value ?? '')
    if (/[\r\n\0]/.test(text)) throw new Error(`${name}: one line only`)
    if (text) lines.push(`${name}=${text}`)
  }
  return lines.join('\n') + '\n'
}
