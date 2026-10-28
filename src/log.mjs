// Logging goes to stderr and an optional file, never to stdout:
// stdout is the MCP stdio connection to Claude Code.
//
// The file gets about one line per voice call, so it is rotated: past
// VOICE_GW_LOG_MAX_MB it moves to <file>.1, replacing the one before. It holds
// what the driver asked for, so folder 0700 and file 0600 when created here.
// The watchdog in scripts/start-controller.sh appends to the same file.

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.mjs'

// A writer for one log file. Never throws: logging must never take the
// gateway down. Nothing happens on disk before the first line.
export function fileLog(file, { maxBytes = 10 * 1024 * 1024 } = {}) {
  let prepared = false
  return line => {
    try {
      if (!prepared) {
        prepared = true
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        tighten(file) // a file from an older version, or the watchdog's
      }
      const stat = statSync(file, { throwIfNoEntry: false })
      if (stat?.isFile() && stat.size > 0 && stat.size + Buffer.byteLength(line) > maxBytes) {
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, line, { mode: 0o600 })
    } catch {
      // the line is on stderr all the same
    }
  }
}

// Only a regular file, here and for the rotation: VOICE_GW_LOG_FILE may name
// a device such as /dev/stderr.
function tighten(file) {
  const stat = statSync(file, { throwIfNoEntry: false })
  if (stat?.isFile() && (stat.mode & 0o077) !== 0) chmodSync(file, 0o600)
}

const toFile = config.logFile ? fileLog(config.logFile, { maxBytes: config.logMaxMb * 1024 * 1024 }) : null

export function log(...parts) {
  const text = parts
    .map(part => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')
  const line = `${new Date().toISOString()} ${text}\n`
  process.stderr.write(line)
  toFile?.(line)
}

// Shortens free text for log lines (user messages can be long).
export function preview(text, max = 80) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}
