// The gateway's settings file, .secrets/gateway.env, which the setup assistant
// writes (scripts/setup.mjs): one VOICE_GW_NAME=value per line, without
// quotes; lines starting with # are comments. The gateway reads it in
// config.mjs, the start scripts in scripts/settings.sh. A variable set in the
// environment, for example in controller/.mcp.json, wins over the file. The
// file is read, never executed.

import { readFileSync } from 'node:fs'

export const SETTINGS_FILE_NAME = 'gateway.env'

const NAME = /^VOICE_GW_[A-Z0-9_]+$/

export function readSettings(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
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
