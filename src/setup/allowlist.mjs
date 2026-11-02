// The channel allowlist in the managed settings file on this computer (setup
// page, section 8).
//
// Without the plugin on an allowlist, every start of the controller waits for
// the development channel's confirmation at the terminal. A personal account
// has no organisation, so no allowlist of its own; the same setting in the
// managed settings file on this computer works there too (README, "Known
// issues"; unofficial). Only while the organisation has no managed settings:
// theirs come first, and the file then does not count.
//
// The setup reads the file as this user, adds channelsEnabled and the plugin
// to the list, and keeps every other key and entry (withAllowlist in
// scripts/channel-mode.mjs). A file that is no JSON object is left alone.
// The new text goes in with administrator rights (asAdmin in hosts.mjs), with
// a backup of the old file next to it, readable for every user, as Claude
// Code reads it as theirs.

import { dirname, isAbsolute } from 'node:path'
import { quote } from './hosts.mjs'

// The shell command, run as root, that writes the text to the file, each of
// its lines with a newline: its folder made if missing, a backup of the file
// before, the new file in place in one step, from a temporary file that only
// root could have made. On one line, each line of the text an argument of
// printf, as the password dialog of macOS takes it (do shell script).
export function allowlistCommand(file, text) {
  if (!isAbsolute(file) || /[\0-\x1f]/.test(file)) throw new Error(`not a plain path: ${file}`)
  const f = quote(file)
  const lines = String(text).replace(/\n$/, '').split('\n').map(quote).join(' ')
  const write = `{ printf '%s\\n' ${lines} > "$t" && chmod 644 "$t" && mv "$t" ${f} || { rm -f "$t"; false; }; }`
  return `(${[
    `mkdir -p ${quote(dirname(file))}`,
    `{ [ ! -e ${f} ] || cp -p ${f} ${quote(`${file}.cc-voice-gateway.bak`)}; }`,
    `t=$(mktemp ${quote(`${dirname(file)}/.managed-settings.XXXXXX`)})`,
    write,
  ].join(' && ')})`
}
