#!/usr/bin/env node
// Marks Claude in Chrome's first-start notice as seen, so that an unattended
// start of the controller session does not wait at the terminal.
// scripts/start-controller.sh runs it before every start with
// VOICE_GW_CONTROLLER_CHROME=1; the setup assistant only reads whether the
// notice was confirmed (chromeNoticeSeen), to warn when it was not.
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
// It sets that one key and leaves every other one as it is, under Claude
// Code's own lock on the file, and only when the key is not set yet
// (claude-config.mjs). Prints one line:
//
//   seen           the key was set already; nothing written
//   marked         set now
//   failed <why>   not set: if Claude Code shows the notice, the session
//                  waits for Enter at the terminal

import { homedir } from 'node:os'
import { configFile, isMain, readConfig, updateConfig } from './claude-config.mjs'

export { configFile }
export const KEY = 'hasCompletedClaudeInChromeOnboarding'

// Whether the notice was confirmed already, for the setup assistant: true or
// false, or null when the config cannot be read. Reads only.
export function chromeNoticeSeen({ env = process.env, home = homedir() } = {}) {
  const { config } = readConfig(configFile(env, home))
  return config ? config[KEY] === true : null
}

export function markChromeOnboarding({ env = process.env, waitMs = 5000 } = {}) {
  return updateConfig({
    env,
    waitMs,
    done: config => config[KEY] === true,
    change: config => {
      config[KEY] = true
    },
  })
}

if (isMain(process.argv[1], import.meta.url)) {
  const { state, why } = await markChromeOnboarding()
  console.log(why ? `${state} ${why}` : state)
}
