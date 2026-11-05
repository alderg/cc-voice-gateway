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
//
// Approval grants (approval-grants.mjs): the hook asks about every prompt,
// the main session's and an ordinary subagent's too, on POST /approval/check,
// which answers at once (the hook waits at most two seconds): allow when a
// grant of the driver's covers it, else nothing, and the prompt goes on as
// before. A teammate's prompt that a grant covers is allowed on POST
// /approval at once, and never listed. For the main session, Claude Code runs
// the hook next to its dialog and the channel's relay, and the first answer
// wins (seen with 2.1.312: a hook's allow ran the call 22 ms after the relay
// had sent the prompt). So that the driver never hears an approval that ran
// already, the channel's copy of a file write that a grant could decide waits
// here up to HOLD_MS for the hook's check of the same prompt (relayed): the
// same tool and path, within MATCH_MS. Allowed by a grant: the copy is
// dropped, never listed nor sent to Telegram. Not covered: it is listed with
// what the check knew, the grant it could get (the offer) and, for an
// ordinary subagent, its name. Only a check of the main session drops a
// copy: an ordinary subagent's prompt that a grant allowed never reaches the
// channel, as Claude Code waits for its hook before the dialog.

import { EventEmitter } from 'node:events'
import { randomInt } from 'node:crypto'
import { createServer } from 'node:http'
import { listenSocket } from './admin.mjs'
import { FILE_TOOLS, actorOf, filePathOf } from './approval-grants.mjs'
import { readBody, sendJson } from './http.mjs'
import { log as defaultLog, preview } from './log.mjs'

// Approval codes as Claude Code's: five lower-case letters without l.
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'
const MAX_BODY_BYTES = 256 * 1024
const PREVIEW_CHARS = 2000
// How long the channel's copy of a prompt waits for the hook's check, how
// far apart the two may be, and how long a check is kept for its copy.
export const HOLD_MS = 1500
const MATCH_MS = 5000
const CHECK_KEPT_MS = 10000

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

// What a prompt is about, to find the channel's copy of it: the file of a
// file tool, or the shell command, with its white space as Claude Code's
// preview has it. '' for anything else.
export function promptKey(tool, input) {
  const value = FILE_TOOLS.includes(tool) ? filePathOf(input) : typeof input?.command === 'string' ? input.command : ''
  return value.replace(/\s+/g, ' ').trim()
}

// The same, from the channel's copy: its input_preview, which Claude Code
// (2.1.312) writes as { "file_path": "/x", "content": "…" }, a value cut or
// redacted where it is long. '' where it holds no such value whole.
export function previewKey(tool, inputPreview) {
  const keys = FILE_TOOLS.includes(tool) ? ['file_path', 'notebook_path'] : ['command']
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\\\n]|\\\\.)*")`).exec(String(inputPreview ?? ''))
    if (!match) continue
    try {
      const value = JSON.parse(match[1])
      if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').trim()
    } catch {
      // cut: no key
    }
  }
  return ''
}

// What an approval keeps of its prompt, for a grant made later that covers
// it (gateway.mjs): the tool, the file, who asked. Never the content.
const keptPrompt = prompt => ({ tool: prompt.tool, input: { file_path: filePathOf(prompt.input) }, actor: prompt.actor })

export class HookApprovals extends EventEmitter {
  // store: the gateway's (store.mjs). killswitch: denies while locked.
  // relay: whether approvals go to the driver at all
  // (VOICE_GW_PERMISSION_RELAY); without it the hook decides nothing.
  // grants: the approval grants (approval-grants.mjs), or null.
  constructor({ store, killswitch = null, relay = true, grants = null, holdMs = HOLD_MS, log = defaultLog }) {
    super()
    this.setMaxListeners(0) // one listener per copy that waits
    this.store = store
    this.killswitch = killswitch
    this.relay = relay
    this.grants = grants
    this.holdMs = holdMs
    this.log = log
    this.waiting = new Map() // code -> { res, agent }
    this.checks = [] // the hook's recent checks, for the channel's copies (relayed)
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

  // A prompt of the main session or of an ordinary subagent, which the
  // channel relays itself: allow when a grant covers it, else nothing. Kept
  // a moment for the channel's copy (relayed).
  check(prompt, agent) {
    // The channel denies its copy while the kill switch is locked.
    if (this.killswitch?.locked) return { behavior: null, why: 'the kill switch is locked' }
    const grant = this.grants?.allow(prompt, agent ? 'ordinary subagent' : 'main session') ?? null
    const key = promptKey(prompt.tool, prompt.input)
    // A subagent's that a grant allowed never reaches the channel.
    if (key && !(grant && agent)) {
      this.remember({
        tool: prompt.tool,
        key,
        main: !agent,
        grant,
        offer: grant ? null : (this.grants?.offer(prompt) ?? null),
        agent,
        prompt: keptPrompt(prompt),
      })
    }
    return grant ? { behavior: 'allow' } : { behavior: null }
  }

  remember(entry) {
    const now = Date.now()
    this.checks = this.checks.filter(check => now - check.at < CHECK_KEPT_MS)
    this.checks.push({ ...entry, at: now, used: false })
    this.emit('check')
  }

  // The channel's copy of a prompt ({ tool_name, input_preview }), before it
  // is listed: the hook's check of the same prompt, waited for up to holdMs
  // where a grant could decide it. { drop } when a grant of the main session
  // allowed it; else what the check knew, { offer, agent, prompt }, or {}.
  async relayed({ tool_name, input_preview }) {
    const tool = String(tool_name ?? '')
    const key = previewKey(tool, input_preview)
    if (!key) return {}
    const take = () => {
      const now = Date.now()
      const entry = this.checks.find(check => !check.used && check.tool === tool && check.key === key && Math.abs(now - check.at) <= MATCH_MS)
      if (entry) entry.used = true
      return entry ?? null
    }
    let entry = take()
    if (!entry && this.holds(tool, key)) {
      entry = await new Promise(resolve => {
        const done = value => {
          clearTimeout(timer)
          this.off('check', onCheck)
          resolve(value)
        }
        const onCheck = () => {
          const found = take()
          if (found) done(found)
        }
        const timer = setTimeout(() => done(null), this.holdMs)
        this.on('check', onCheck)
      })
    }
    if (!entry) return {}
    if (entry.grant && entry.main) return { drop: true, grant: entry.grant }
    return { offer: entry.offer, agent: entry.agent, prompt: entry.prompt }
  }

  // Whether the copy of a prompt waits for the hook's check: a file write a
  // grant could decide, now or with the driver's yes.
  holds(tool, key) {
    if (!this.relay || !this.grants || !FILE_TOOLS.includes(tool) || !key.startsWith('/')) return false
    if (this.grants.active().length) return true
    return Boolean(this.grants.offer({ tool, input: { file_path: key }, actor: { who: 'controller' } }))
  }

  async handle(req, res) {
    try {
      const route = `${req.method} ${req.url}`
      if (route !== 'POST /approval' && route !== 'POST /approval/check') return sendJson(res, 404, { error: 'unknown command' })
      // POST /approval: a teammate's, which waits for the driver; the check: anyone else's, at once.
      const teammate = route === 'POST /approval'
      const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
      const tool = typeof body.tool_name === 'string' ? body.tool_name.trim() : ''
      if (!tool) return sendJson(res, 400, { error: 'tool_name missing' })
      const named = String(body.agent_name || body.agent_type || body.agent_id || '')
      const agent = teammate ? preview(named || 'unnamed', 60) : body.agent_id ? preview(named, 60) : null
      if (!this.relay) {
        return sendJson(res, 200, { behavior: null, why: 'the permission relay is off (VOICE_GW_PERMISSION_RELAY=0)' })
      }
      const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : {}
      const prompt = { tool, input, actor: actorOf(body, { teammate }) }
      if (!teammate) return sendJson(res, 200, this.check(prompt, agent))
      if (this.killswitch?.locked) {
        // Nothing gets allowed while the kill switch is locked.
        this.log('permission_request denied, kill switch locked', `tool=${tool}`, `(subagent ${agent})`)
        return sendJson(res, 200, { behavior: 'deny', message: 'Denied: the kill switch of the voice gateway is locked.' })
      }
      if (this.grants?.allow(prompt, 'teammate')) return sendJson(res, 200, { behavior: 'allow' })
      const code = newCode(code => Boolean(this.store.getPermission(code)) || this.waiting.has(code))
      this.waiting.set(code, { res, agent })
      // The hook gave up, its time ran out or the session ended: withdrawn.
      res.on('close', () => {
        if (this.waiting.get(code)?.res !== res) return
        this.waiting.delete(code)
        if (this.store.withdrawPermission(code)) this.log('permission withdrawn: the hook stopped waiting', `code=${code}`, `(subagent ${agent})`)
      })
      // Else the tool's own name, "search files" for mcp__claude_ai_Google_Drive__search_files.
      const toolName = tool.replace(/^mcp__.*?__/, '').replace(/_/g, ' ')
      const server = typeof body.mcp_server === 'string' && body.mcp_server.trim() ? preview(body.mcp_server, 60) : ''
      const description = describeInput(tool, input) || (server ? `${toolName} (${server})` : toolName)
      const offer = this.grants?.offer(prompt) ?? null
      this.store.addPermission(
        {
          request_id: code,
          tool_name: tool,
          description,
          input_preview: preview(JSON.stringify(input), PREVIEW_CHARS),
        },
        { source: 'hook', agent, offer, prompt: FILE_TOOLS.includes(tool) ? keptPrompt(prompt) : null },
      )
      this.log('permission_request', `code=${code}`, `tool=${tool}`, `subagent=${agent}`, preview(description), ...(offer ? [`(offers a grant: ${offer.text})`] : []))
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status ?? 400, { error: error.message })
    }
  }
}
