#!/usr/bin/env node
// The gateway as the MCP server of the plugin voice@cc-voice-gateway
// (.claude-plugin/), for a controller started with
// --channels plugin:voice@cc-voice-gateway instead of the development flag.
//
// The gateway's settings stay where they are for the development-flag start:
// in the env block of the voice server in controller/.mcp.json. This file
// applies them, as Claude Code would for that server, and starts the gateway.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpEnv } from './settings.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mcpJson = process.env.VOICE_GW_MCP_JSON || join(ROOT, 'controller', '.mcp.json')

try {
  Object.assign(process.env, mcpEnv(mcpJson))
} catch (error) {
  process.stderr.write(`voice plugin: ${mcpJson} unreadable: ${error.message}\n`)
}

// As a plugin server, the channel's events carry this source.
process.env.VOICE_GW_CHANNEL_SOURCE ||= 'plugin:voice:voice'
await import('./gateway.mjs')
