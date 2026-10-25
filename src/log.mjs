// Logging goes to stderr and an optional file, never to stdout:
// stdout is the MCP stdio connection to Claude Code.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.mjs'

let fileReady = false
if (config.logFile) {
  try {
    mkdirSync(dirname(config.logFile), { recursive: true })
    fileReady = true
  } catch {
    fileReady = false
  }
}

export function log(...parts) {
  const text = parts
    .map(part => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')
  const line = `${new Date().toISOString()} ${text}\n`
  process.stderr.write(line)
  if (fileReady) {
    try {
      appendFileSync(config.logFile, line)
    } catch {
      // logging must never take the gateway down
    }
  }
}

// Shortens free text for log lines (user messages can be long).
export function preview(text, max = 80) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}
