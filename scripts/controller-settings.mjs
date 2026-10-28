#!/usr/bin/env node
// The settings that scripts/start-controller.sh passes to the controller
// session with --settings, for the way the channel loads (plugin or
// development) and the controller level (VOICE_GW_CONTROLLER_LEVEL, see
// src/config.mjs). Prints the level on the first line and the JSON on the
// second:
//
//   confined, clone-delete   deny rules for tools that reach beyond this
//                            computer. The confine hook blocks them anyway;
//                            the rules are a second line.
//   unrestricted             allow rules for Claude Code's own tools instead,
//                            so they run without asking. Tools of other MCP
//                            servers and claude.ai connectors still ask, and
//                            the channel relays the prompt.
//
// Deny rules win over allow rules from every other source, so they cannot sit
// in controller/.claude/settings.json: there they would hold at every level.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.mjs'
import { MARKETPLACE, PLUGIN } from './channel-mode.mjs'

// Accounts, the web, other sessions, scheduled and remote agents.
export const CONTROLLER_DENY = [
  'mcp__claude_ai_*',
  'WebFetch',
  'WebSearch',
  'SendMessage',
  'ListAgents',
  'RemoteTrigger',
  'CronCreate',
  'Artifact*',
  'Monitor',
  'Workflow',
  'EnterWorktree',
]

export const UNRESTRICTED_ALLOW = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'Skill',
  'TodoWrite',
]

export function controllerSettings({ mode, level }) {
  const settings = {}
  if (mode === 'plugin') {
    // The plugin, for this session only; the project's own voice server stays off.
    settings.enabledPlugins = { [`${PLUGIN}@${MARKETPLACE}`]: true }
    settings.disabledMcpjsonServers = ['voice']
  }
  settings.permissions = level === 'unrestricted' ? { allow: UNRESTRICTED_ALLOW } : { deny: CONTROLLER_DENY }
  return settings
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const level = config.controllerLevel
  console.log(level)
  console.log(JSON.stringify(controllerSettings({ mode: process.argv[2], level })))
}
