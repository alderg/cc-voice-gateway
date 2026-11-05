#!/usr/bin/env node
// PermissionRequest hook: hands the approval prompts of the controller's
// teammates to the gateway, which relays them to the car and to Telegram, and
// answers with the driver's verdict (src/approvals.mjs). And asks the gateway
// about every other prompt too, which it answers with allow when an approval
// grant of the driver's covers it (src/approval-grants.mjs).
//
// A background agent spawned with a name while agent teams are on runs as an
// in-process teammate, and Claude Code (seen with 2.1.312) shows its prompts
// only at the terminal, without the channel's permission relay. Before that
// dialog, Claude Code runs this hook and waits for it: an allow or deny here
// decides, and no dialog opens; no decision lets the dialog open as before.
//
//   the main session          to the gateway's check, at once: allow when a
//                             grant covers it, else nothing, and the channel
//                             relays it; the hook runs next to its dialog,
//                             and the first answer wins
//   an ordinary subagent      the same; Claude Code waits for the hook, then
//                             its dialog and the channel's relay open
//   a teammate                to the gateway's approval socket, then wait for
//                             the driver's verdict, as long as it takes; a
//                             grant that covers it allows it at once
//
// Why a hook for the grants: for a path Claude Code holds sensitive (any with
// a .claude or .git segment, a project's memory folder in ~/.claude among
// them), only a PermissionRequest hook's allow lifts the prompt, and it has to
// answer every time; allow rules, a PreToolUse allow and the session rules a
// hook may return do not (seen with 2.1.312).
//
// Whether an agent is a teammate: Claude Code's record of it next to the
// session's transcript (subagents/agent-<id>.meta.json, taskKind
// in_process_teammate), or else its id, "a<name>-<16 hex digits>". The record
// also gives an ordinary subagent's name or description, for the driver.
//
// Fails open, to the terminal and the channel's relay: whatever goes wrong (no
// gateway, the socket gone, the gateway slow to answer a check, the
// permission relay off, an error here), the hook decides nothing and exits 0,
// so the prompt opens as it did without it. It never denies anything but a
// teammate's prompt, on the gateway's word.

import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPROVAL_SOCKET_NAME, mcpEnv } from '../../../src/settings.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}$/
const MAX_STRING = 2000
// How long a check may take: Claude Code waits for the hook before an
// ordinary subagent's dialog. The gateway answers in milliseconds.
const CHECK_MS = 2000

// Who asks: { teammate, name }, name null for the main session, and for an
// ordinary subagent the name or description in its record.
function asker(input) {
  const id = input.agent_id
  if (typeof id !== 'string' || !SAFE.test(id) || id.includes('..')) return { teammate: false, name: null }
  const type = typeof input.agent_type === 'string' ? input.agent_type : ''
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  if (transcript.endsWith('.jsonl')) {
    try {
      const meta = JSON.parse(readFileSync(join(transcript.slice(0, -'.jsonl'.length), 'subagents', `agent-${id}.meta.json`), 'utf8'))
      if (meta?.taskKind === 'in_process_teammate') return { teammate: true, name: String(meta.name || type || id) }
      return { teammate: false, name: String(meta?.name || meta?.description || type || id) }
    } catch {
      // No record: by the id below.
    }
  }
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (type && new RegExp(`^a${escaped}-[0-9a-f]{16}$`).test(id)) return { teammate: true, name: type }
  return { teammate: false, name: type || id }
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

// The gateway's answer: { behavior: 'allow' | 'deny', message? }, or
// { behavior: null } when it decides nothing. ms: how long to wait at most,
// 0 for as long as it takes (a teammate's, which waits for the driver).
function ask(socketPath, path, body, ms = 0) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: 'POST', path, headers: { 'content-type': 'application/json' } }, res => {
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
    if (ms) req.setTimeout(ms, () => req.destroy(new Error(`the gateway did not answer within ${ms} ms`)))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const decide = (behavior, message) => {
  const decision = { behavior, ...(behavior === 'deny' && message ? { message: String(message) } : {}) }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
}

async function main() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const input = JSON.parse(text)
  const { teammate, name } = asker(input)
  const body = {
    tool_name: input.tool_name,
    tool_input: cut(input.tool_input ?? {}),
    mcp_server: input.mcp_server,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    agent_name: name,
    session_id: input.session_id,
  }
  const socket = join(secretsDir(), APPROVAL_SOCKET_NAME)
  if (!teammate) {
    // A grant of the driver's, or nothing: the channel relays the prompt.
    const answer = await ask(socket, '/approval/check', body, CHECK_MS)
    if (answer?.behavior === 'allow') decide('allow')
    return
  }
  const answer = await ask(socket, '/approval', body)
  if (answer?.behavior !== 'allow' && answer?.behavior !== 'deny') {
    if (answer?.why) process.stderr.write(`voice gateway: ${answer.why}; the prompt goes to the terminal\n`)
    return
  }
  decide(answer.behavior, answer.message)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`voice gateway: approval not relayed (${error.message}); the prompt goes to the terminal\n`)
}
process.exitCode = 0
