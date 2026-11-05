#!/usr/bin/env node
// PermissionRequest hook: hands the approval prompts of the controller's
// teammates to the gateway, which relays them to the car and to Telegram, and
// answers with the driver's verdict (src/approvals.mjs).
//
// A background agent spawned with a name while agent teams are on runs as an
// in-process teammate, and Claude Code (seen with 2.1.312) shows its prompts
// only at the terminal, without the channel's permission relay. Before that
// dialog, Claude Code runs this hook and waits for it: an allow or deny here
// decides, and no dialog opens; no decision lets the dialog open as before.
//
//   the main session          nothing: the channel relays its prompts, and
//                             the hook runs next to its dialog anyway
//   an ordinary subagent      nothing: after the hook, its dialog and the
//                             channel's relay open as for the main session
//   a teammate                to the gateway's approval socket, then wait for
//                             the driver's verdict, as long as it takes
//
// Whether an agent is a teammate: Claude Code's record of it next to the
// session's transcript (subagents/agent-<id>.meta.json, taskKind
// in_process_teammate), or else its id, "a<name>-<16 hex digits>".
//
// Fails open to the terminal: whatever goes wrong (no gateway, the socket
// gone, the permission relay off, an error here), the hook decides nothing
// and exits 0, so the prompt opens at the terminal as it did without it.

import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPROVAL_SOCKET_NAME, mcpEnv } from '../../../src/settings.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}$/
const MAX_STRING = 2000

// The teammate's name, or null for the main session and any other agent.
function teammate(input) {
  const id = input.agent_id
  if (typeof id !== 'string' || !SAFE.test(id) || id.includes('..')) return null
  const type = typeof input.agent_type === 'string' ? input.agent_type : ''
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  if (transcript.endsWith('.jsonl')) {
    try {
      const meta = JSON.parse(readFileSync(join(transcript.slice(0, -'.jsonl'.length), 'subagents', `agent-${id}.meta.json`), 'utf8'))
      return meta?.taskKind === 'in_process_teammate' ? String(meta.name || type || id) : null
    } catch {
      // No record: by the id below.
    }
  }
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return type && new RegExp(`^a${escaped}-[0-9a-f]{16}$`).test(id) ? type : null
}

// The gateway's secrets folder, as it finds it (src/config.mjs): from the
// environment, from the gateway's entry in controller/.mcp.json, or .secrets.
function secretsDir() {
  if (process.env.VOICE_GW_SECRETS_DIR) return process.env.VOICE_GW_SECRETS_DIR
  try {
    const fromMcp = mcpEnv(process.env.VOICE_GW_MCP_JSON || join(ROOT, 'controller', '.mcp.json')).VOICE_GW_SECRETS_DIR
    if (fromMcp) return fromMcp
  } catch {
    // unreadable: the default
  }
  return join(ROOT, '.secrets')
}

// Long texts, a file's whole content say, cut: the gateway shows a preview.
const cut = value =>
  typeof value === 'string'
    ? value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
    : Array.isArray(value)
      ? value.slice(0, 50).map(cut)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, cut(item)]))
        : value

// Waits for the gateway's answer: { behavior: 'allow' | 'deny', message? },
// or { behavior: null } when it decides nothing.
function ask(socketPath, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: 'POST', path: '/approval', headers: { 'content-type': 'application/json' } }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (data += chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`the gateway answered ${res.statusCode}: ${data}`))
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function main() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const input = JSON.parse(text)
  const name = teammate(input)
  if (!name) return
  const answer = await ask(join(secretsDir(), APPROVAL_SOCKET_NAME), {
    tool_name: input.tool_name,
    tool_input: cut(input.tool_input ?? {}),
    mcp_server: input.mcp_server,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    agent_name: name,
    session_id: input.session_id,
  })
  if (answer?.behavior !== 'allow' && answer?.behavior !== 'deny') {
    if (answer?.why) process.stderr.write(`voice gateway: ${answer.why}; the prompt goes to the terminal\n`)
    return
  }
  const decision = { behavior: answer.behavior, ...(answer.behavior === 'deny' && answer.message ? { message: String(answer.message) } : {}) }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
}

try {
  await main()
} catch (error) {
  process.stderr.write(`voice gateway: approval not relayed (${error.message}); the prompt goes to the terminal\n`)
}
process.exitCode = 0
