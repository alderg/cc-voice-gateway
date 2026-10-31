#!/usr/bin/env node
// Marks the controller's folder as trusted in Claude Code's config, so that
// an unattended start of the controller session does not wait at the folder
// trust question. scripts/start-controller.sh runs it before every start,
// so that it holds after the folder moved or the config was reset too, and
// the setup assistant before it starts the controller.
//
//   node scripts/folder-trust.mjs <folder>
//
// At the first start in a folder, Claude Code asks "Quick safety check: Is
// this a project you created or one you trust?", with the cursor on "No,
// exit": Enter alone ends the session, and nothing goes on until someone
// picks "Yes, I trust this folder" at the terminal. Claude Code notes the
// answer as projects["<absolute path>"].hasTrustDialogAccepted in its global
// config, ~/.claude.json ($CLAUDE_CONFIG_DIR/.claude.json when that is set);
// trust on a parent folder seems to count too, but this sets it on the exact
// folder the session starts in, as the system names it (its real path, as
// Claude Code sees its working folder), to be safe.
//
// It sets that one key of that one project and leaves every other key of the
// project and of the file as it is, under Claude Code's own lock on the file,
// and only when it is not set yet (claude-config.mjs). The start script runs
// it only while the controller's Claude Code is not running, before it
// starts. Prints one line:
//
//   seen           trusted already; nothing written
//   marked         set now
//   failed <why>   not set: Claude Code may ask at the terminal

import { homedir } from 'node:os'
import { configFile, isMain, readConfig, real, updateConfig } from './claude-config.mjs'

export const KEY = 'hasTrustDialogAccepted'

const projectOf = (config, folder) => {
  const project = config.projects?.[folder]
  return project && typeof project === 'object' && !Array.isArray(project) ? project : null
}

// Whether the folder is trusted in Claude Code's config, itself or through a
// parent folder: true or false, or null when the config cannot be read.
// Reads only.
export function folderTrusted(folder, { env = process.env, home = homedir() } = {}) {
  const { config } = readConfig(configFile(env, home))
  if (!config) return null
  const path = real(folder)
  return Object.entries(config.projects ?? {}).some(
    ([key, project]) => project?.[KEY] === true && (key === path || path.startsWith(key.endsWith('/') ? key : `${key}/`)),
  )
}

export function markFolderTrust(folder, { env = process.env, waitMs = 5000 } = {}) {
  const path = real(folder)
  return updateConfig({
    env,
    waitMs,
    done: config => projectOf(config, path)?.[KEY] === true,
    change: config => {
      if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) config.projects = {}
      config.projects[path] = { ...(projectOf(config, path) ?? {}), [KEY]: true }
    },
  })
}

if (isMain(process.argv[1], import.meta.url)) {
  const folder = process.argv[2]
  if (!folder) {
    console.log('failed no folder given (node scripts/folder-trust.mjs <folder>)')
  } else {
    const { state, why } = await markFolderTrust(folder)
    console.log(why ? `${state} ${why}` : state)
  }
}
