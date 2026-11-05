// Approval requests of the controller's teammates, which the channel never
// gets: the controller's PermissionRequest hook (controller/.claude/hooks/
// approval.mjs) hands them to the gateway over a Unix socket in the secrets
// folder, and waits on that connection for the driver's verdict.
//
// Why a hook (seen with Claude Code 2.1.312, in its code and with a real
// session): Claude Code relays a permission prompt to a channel server only
// from the dialog of the main session and of an ordinary subagent. A
// background agent spawned with a name while agent teams are on
// (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) runs as an in-process teammate;
// its prompts show only at the leader's terminal ("from the standorte-drive
// agent"), without the channel relay or Remote Control, so in the car and in
// Telegram nobody heard of them, and the teammate waited all night. Before
// that dialog, Claude Code runs the PermissionRequest hooks and waits for
// them: a hook's allow or deny decides, and no dialog opens at all; a hook
// that decides nothing lets the dialog open as before.
//
// So an approval from here is listed and answered like one from the channel
// (store.mjs, voice.mjs, telegram.mjs), with the subagent's name, and its
// verdict goes back to the waiting hook instead of the channel
// (channel.mjs, sendVerdict). While the hook waits, the terminal shows
// nothing, so it cannot be answered twice; the gateway guesses nothing about
// it either (closePermissionsElsewhere). When the hook stops waiting (its
// time runs out, the session ends), the approval is withdrawn: off the lists,
// and the voice client hears it once. Stopping the teammate does not end the
// wait: its call still runs on a yes, as seen with 2.1.312, so the approval
// stays open until it is answered.
//
// Every gate holds as for the channel's: the kill switch denies at once while
// it is locked and every waiting one when it locks (gateway.mjs, lockdown);
// a standby holds the Telegram message; VOICE_GW_TELEGRAM_CONFIRM=0 keeps the
// answer with the voice; without the permission relay
// (VOICE_GW_PERMISSION_RELAY=0) the hook decides nothing, and the prompt goes
// to the terminal as before.
//
// The socket is 0600 in the 0700 secrets folder, like the admin socket, so
// only processes of this user reach it; a verdict goes back only on the
// connection that asked.

import { randomInt } from 'node:crypto'
import { createServer } from 'node:http'
import { listenSocket } from './admin.mjs'
import { readBody, sendJson } from './http.mjs'
import { log as defaultLog, preview } from './log.mjs'

// Approval codes as Claude Code's: five lower-case letters without l.
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'
const MAX_BODY_BYTES = 256 * 1024
const PREVIEW_CHARS = 2000

export function newCode(taken = () => false) {
  for (;;) {
    let code = ''
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    if (!taken(code)) return code
  }
}

// What the prompt is about, in a few words, from the tool's input, as Claude
// Code's own descriptions are: the shell command's description, the file,
// the address. '' when the input says nothing such; the details follow.
export function describeInput(tool, input) {
  const value = key => (typeof input?.[key] === 'string' && input[key].trim() ? input[key].trim() : '')
  if (tool === 'Bash') return value('description') || value('command')
  if (tool === 'Write') return value('file_path') && `Write ${value('file_path')}`
  if (['Edit', 'MultiEdit'].includes(tool)) return value('file_path') && `Edit ${value('file_path')}`
  if (tool === 'NotebookEdit') return value('notebook_path') && `Edit ${value('notebook_path')}`
  if (tool === 'Read') return value('file_path') && `Read ${value('file_path')}`
  if (tool === 'WebFetch') return value('url') && `Fetch ${value('url')}`
  if (tool === 'WebSearch') return value('query') && `Search the web for ${value('query')}`
  return value('description')
}

export class HookApprovals {
  // store: the gateway's (store.mjs). killswitch: denies while locked.
  // relay: whether approvals go to the driver at all
  // (VOICE_GW_PERMISSION_RELAY); without it the hook decides nothing.
  constructor({ store, killswitch = null, relay = true, log = defaultLog }) {
    this.store = store
    this.killswitch = killswitch
    this.relay = relay
    this.log = log
    this.waiting = new Map() // code -> { res, agent }
    this.server = null
  }

  // Resolves with whether the socket listens; without it, the hook decides
  // nothing and the prompts go to the terminal, as before.
  async listen(socketPath) {
    const server = createServer((req, res) => this.handle(req, res))
    // A request waits as long as the driver takes to answer.
    server.requestTimeout = 0
    this.server = await listenSocket(server, socketPath, {
      what: 'approval socket',
      missing: "the approval requests of the controller's teammates show only at the terminal",
    })
    return Boolean(this.server)
  }

  close() {
    this.server?.close()
    // The hooks waiting now decide nothing: their prompts open at the terminal.
    for (const [code, { res }] of this.waiting) {
      this.waiting.delete(code)
      this.store.withdrawPermission(code)
      res.destroy()
    }
  }

  // Whether a hook waits on this approval.
  owns(code) {
    return this.waiting.has(String(code).toLowerCase())
  }

  // The driver's verdict, to the hook that waits on it. Throws when it no
  // longer waits; the approval is withdrawn then.
  async verdict(code, behavior) {
    const key = String(code).toLowerCase()
    const entry = this.waiting.get(key)
    const gone = () => {
      this.store.withdrawPermission(key)
      return new Error('the subagent that asked stopped waiting for it')
    }
    if (!entry) throw gone()
    this.waiting.delete(key)
    const lock = this.store.getPermission(key)?.by === 'killswitch'
    const message =
      behavior !== 'deny'
        ? undefined
        : lock
          ? 'Denied: the kill switch of the voice gateway locked.'
          : 'Denied by the driver through the voice gateway.'
    const { res } = entry
    // The hook may have gone a moment ago, before its close was seen.
    if (res.destroyed) throw gone()
    await new Promise((resolve, reject) => {
      res.once('finish', resolve)
      res.once('close', () => (res.writableFinished ? resolve() : reject(gone())))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ behavior, ...(message ? { message } : {}) }))
    })
    this.log('verdict', `code=${key}`, `behavior=${behavior}`, `(subagent ${entry.agent})`)
  }

  async handle(req, res) {
    try {
      if (`${req.method} ${req.url}` !== 'POST /approval') return sendJson(res, 404, { error: 'unknown command' })
      const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
      const tool = typeof body.tool_name === 'string' ? body.tool_name.trim() : ''
      if (!tool) return sendJson(res, 400, { error: 'tool_name missing' })
      const agent = preview(String(body.agent_name || body.agent_type || body.agent_id || 'unnamed'), 60)
      if (!this.relay) {
        return sendJson(res, 200, { behavior: null, why: 'the permission relay is off (VOICE_GW_PERMISSION_RELAY=0)' })
      }
      if (this.killswitch?.locked) {
        // Nothing gets allowed while the kill switch is locked.
        this.log('permission_request denied, kill switch locked', `tool=${tool}`, `(subagent ${agent})`)
        return sendJson(res, 200, { behavior: 'deny', message: 'Denied: the kill switch of the voice gateway is locked.' })
      }
      const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : {}
      const code = newCode(code => Boolean(this.store.getPermission(code)) || this.waiting.has(code))
      this.waiting.set(code, { res, agent })
      // The hook gave up, its time ran out or the session ended: withdrawn.
      res.on('close', () => {
        if (this.waiting.get(code)?.res !== res) return
        this.waiting.delete(code)
        if (this.store.withdrawPermission(code)) this.log('permission withdrawn: the hook stopped waiting', `code=${code}`, `(subagent ${agent})`)
      })
      // Else the tool's own name, "search files" for mcp__claude_ai_Google_Drive__search_files.
      const named = tool.replace(/^mcp__.*?__/, '').replace(/_/g, ' ')
      const server = typeof body.mcp_server === 'string' && body.mcp_server.trim() ? preview(body.mcp_server, 60) : ''
      const description = describeInput(tool, input) || (server ? `${named} (${server})` : named)
      this.store.addPermission(
        {
          request_id: code,
          tool_name: tool,
          description,
          input_preview: preview(JSON.stringify(input), PREVIEW_CHARS),
        },
        { source: 'hook', agent },
      )
      this.log('permission_request', `code=${code}`, `tool=${tool}`, `subagent=${agent}`, preview(description))
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status ?? 400, { error: error.message })
    }
  }
}
