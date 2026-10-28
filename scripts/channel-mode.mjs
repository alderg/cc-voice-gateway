#!/usr/bin/env node
// How scripts/start-controller.sh loads the voice channel, printed as one line:
//
//   plugin              as the plugin voice@cc-voice-gateway, which the
//                       organisation's channel allowlist names: no prompt
//   plugin-register     the same, once this repository is registered as the
//                       marketplace cc-voice-gateway on this computer
//   development <why>   with --dangerously-load-development-channels, which
//                       asks for a confirmation at the terminal at every start
//
// The allowlist is allowedChannelPlugins in the organisation's managed
// settings. Claude Code keeps the server-managed ones in
// ~/.claude/remote-settings.json; endpoint-managed ones are a file on this
// computer. VOICE_GW_CHANNEL=plugin or development decides instead.

import { readFileSync, realpathSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKETPLACE = 'cc-voice-gateway'
export const PLUGIN = 'voice'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const real = path => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function channelMode({ env = process.env, root = ROOT } = {}) {
  const forced = env.VOICE_GW_CHANNEL
  if (forced === 'development') return { mode: 'development', reason: 'VOICE_GW_CHANNEL=development' }
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

  if (forced !== 'plugin') {
    // Within the managed tier, the first source with any keys counts:
    // server-managed settings first, then the file on this computer.
    const endpoint =
      env.VOICE_GW_MANAGED_SETTINGS ||
      (platform() === 'darwin'
        ? '/Library/Application Support/ClaudeCode/managed-settings.json'
        : '/etc/claude-code/managed-settings.json')
    const managed = [readJson(join(config, 'remote-settings.json')), readJson(endpoint)].find(
      settings => settings && typeof settings === 'object' && Object.keys(settings).length,
    )
    const allowed = Array.isArray(managed?.allowedChannelPlugins) ? managed.allowedChannelPlugins : []
    if (!allowed.some(entry => entry?.marketplace === MARKETPLACE && entry?.plugin === PLUGIN)) {
      return {
        mode: 'development',
        reason: `${PLUGIN}@${MARKETPLACE} is not on the organisation's channel allowlist (allowedChannelPlugins) yet`,
      }
    }
  }

  const known = readJson(join(config, 'plugins', 'known_marketplaces.json'))?.[MARKETPLACE]
  if (!known) return { mode: 'plugin-register', reason: 'register this repository as the marketplace first' }
  const path = known.source?.path ?? known.installLocation
  if (!path || real(path) !== real(root)) {
    return { mode: 'development', reason: `the marketplace ${MARKETPLACE} on this computer is ${path ?? 'not a local folder'}, not ${root}` }
  }
  return { mode: 'plugin', reason: forced === 'plugin' ? 'VOICE_GW_CHANNEL=plugin' : 'on the organisation\'s channel allowlist' }
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const { mode, reason } = channelMode()
  console.log(mode === 'development' ? `development ${reason}` : mode)
}
