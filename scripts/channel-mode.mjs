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
// computer, which the setup assistant can write, for a personal account
// without an organisation (src/setup/allowlist.mjs). VOICE_GW_CHANNEL=plugin
// or development decides instead.

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

// The managed settings file on this computer.
export const managedSettingsFile = (env = process.env, os = platform()) =>
  env.VOICE_GW_MANAGED_SETTINGS ||
  (os === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json')

const hasKeys = settings => Boolean(settings) && typeof settings === 'object' && !Array.isArray(settings) && Object.keys(settings).length > 0

// The managed settings that count: within the managed tier, the first source
// with any keys, the organisation's server-managed settings first, then the
// file on this computer. { settings, from: 'organisation' | 'computer' |
// null, file }: with the organisation's, the file does not count.
export function managedSettings({ env = process.env } = {}) {
  const file = managedSettingsFile(env)
  const remote = readJson(join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'remote-settings.json'))
  if (hasKeys(remote)) return { settings: remote, from: 'organisation', file }
  const local = readJson(file)
  if (hasKeys(local)) return { settings: local, from: 'computer', file }
  return { settings: null, from: null, file }
}

// Whether the settings' channel allowlist names the plugin.
export const allowlisted = settings =>
  Array.isArray(settings?.allowedChannelPlugins) &&
  settings.allowedChannelPlugins.some(entry => entry?.marketplace === MARKETPLACE && entry?.plugin === PLUGIN)

// The text of a managed settings file with channels on and the plugin on its
// channel allowlist, every other key and entry as it was; text null or empty
// for a new file. null when the text is no JSON object, or its allowlist no
// list: such a file is left alone.
export function withAllowlist(text) {
  let settings = {}
  if (text?.trim()) {
    try {
      settings = JSON.parse(text)
    } catch {
      return null
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const list = settings.allowedChannelPlugins ?? []
  if (!Array.isArray(list)) return null
  const allowedChannelPlugins = allowlisted(settings) ? list : [...list, { marketplace: MARKETPLACE, plugin: PLUGIN }]
  return JSON.stringify({ ...settings, channelsEnabled: true, allowedChannelPlugins }, null, 2) + '\n'
}

export function channelMode({ env = process.env, root = ROOT } = {}) {
  const forced = env.VOICE_GW_CHANNEL
  if (forced === 'development') return { mode: 'development', reason: 'VOICE_GW_CHANNEL=development' }
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

  if (forced !== 'plugin') {
    if (!allowlisted(managedSettings({ env }).settings)) {
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
