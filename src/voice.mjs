// Voice side: a Streamable HTTP MCP endpoint for the voice assistant
// (Claude voice mode), reached through a tunnel and protected by the OAuth
// sign-in in oauth.mjs. Through the tunnel, only Anthropic's servers may call
// it (ipguard.mjs), and every request gets a line in the log.
//
// Stateless by design: every POST gets its own short-lived MCP server, all
// state lives in the shared Store. Long tasks are followed with short polls
// (get_reply), because a single tool call has to finish before the client's
// request deadline (commonly 60 s).
//
// The driver may have several gateways, each a connector that looks alike
// to the voice assistant: every answer starts with a line that names this one
// and says whether it is active (presence.mjs), and the instructions and tool
// descriptions name it too. They are fetched when the connector connects, so
// they carry the name and a standby by the settings, not the live state;
// status gives that first. While it is inactive, send and ask hand nothing
// over and say so, so that nothing waits for a controller that is not there.

import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { VERSION } from './config.mjs'
import { readBody } from './http.mjs'
import { log, preview } from './log.mjs'
import { alarmText, emergencyPhrase, offText } from './killswitch.mjs'
import { IpGuard, accessLine } from './ipguard.mjs'
import { clock } from './limits.mjs'

// What the voice AI says, asked for in the car: nothing before a call, then,
// right after a request went on, a few words that name what went on, worded
// differently each time, not one phrase for every request. Only positive
// rules and examples, in the instructions and in every description: a list of
// sentences not to say made the voice AI say them more often. The rules for
// speaking stand in the tool descriptions too, next to each tool.
const VOICE_INSTRUCTIONS = `
This connector reaches Claude Code on the user's own computer. The user is usually driving: keep
everything short and in their language, and answer at once whenever they have said something, since
silence sounds as if they were not heard. If you did not understand, ask back.
When the user asks for something, call the tool straight away and speak once it returns. Requests go
on with send, which returns at once, or ask, which waits up to about 40 seconds for a short answer.
Right after send, and after ask while it still runs, confirm in a few words what you passed on, fitting
the request and worded differently each time, such as "The branch sync is on its way" or "Restart
requested" (in German "Der Abgleich der Branches ist unterwegs", "Neustart ist angefragt"). Then call
get_reply while the state is "sent" or "working"; between calls, say in a short phrase that it is
still running.
Claude Code does the work: relay its answers and questions faithfully, shortened if you like.
Approvals: read them out, and call approve only after the user explicitly said yes or no to that
action; then confirm it in a short phrase, such as "Allowed" (in German "Erlaubt").
News: results of work Claude Code finished in the background come with any call; read them out too.
Emergency: when the user says "emergency stop" or "kill switch", in any language, call emergency_stop
at once, without asking back. An [ALARM] line in any result is read out first.
`.trim()

// Which gateway this connector reaches, for a user with several: the name,
// and a standby by the settings, which is known when the connector connects.
function voiceInstructions(presence) {
  if (!presence) return VOICE_INSTRUCTIONS
  const lines = [
    VOICE_INSTRUCTIONS,
    `This connector is the gateway ${presence.label}. Every answer starts with a line that names it and says whether ` +
      'it is active; an inactive gateway hands nothing over. With several such connectors, one per computer, call ' +
      'status on each first and use the active one. Switch to another connector only when an answer says "use ' +
      'another connector" (a gateway on standby). A locked kill switch is unlocked only at the computer: tell the ' +
      'user so.',
  ]
  if (presence.standbySetting) {
    lines.push('This gateway is on standby by its settings: it hands nothing over. Use another connector.')
  }
  return lines.join('\n')
}

const RELAY_RULE =
  "Use it, rather than your own knowledge or the web, for anything about the user's projects, code, computer " +
  'or Claude Code sessions: Claude Code sees their machine.'

// Right after a request went on: what went on, in a few words.
const CONFIRM =
  'confirm in a few words of their language what you passed on, fitting the request and worded differently ' +
  'each time, such as "The branch sync is on its way", "Your question about the tests is with Claude Code" or ' +
  '"Restart requested" (in German "Der Abgleich der Branches ist unterwegs", "Die Frage zu den Tests ist bei ' +
  'Claude Code", "Neustart ist angefragt").'

// In the results of send and of ask while it still runs: the same, short.
const CONFIRM_NOW =
  'Now confirm to the user in a few words of their language what you passed on, fitting this request and ' +
  'worded differently each time.'

const MESSAGE_DESCRIPTION = "The user's request word for word, in their language, as they said it."

const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError })

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`

function ago(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 90) return `${plural(seconds, 'second')} ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${plural(minutes, 'minute')} ago`
  return `${plural(Math.round(minutes / 60), 'hour')} ago`
}

function describeNews(news) {
  const lines = news.map(
    item => `News from Claude Code (id=${item.id}${item.state === 'question' ? ', a question' : ''}): ${item.text}`,
  )
  const question = news.find(item => item.state === 'question')
  lines.push(
    'Read the news to the user.' +
      (question ? ` If they answer a question, send the answer with send (in_reply_to=${question.id}).` : ''),
  )
  return lines
}

// Approvals the voice client heard that were answered at the computer since,
// each once.
const answeredElsewhereLines = store =>
  store
    .takeAnsweredElsewhere()
    .map(permission => `Approval ${permission.code} was answered at the computer and is settled; it needs nothing from the user.`)

// While the controller waits for the Claude usage limit (limits.mjs), what is
// sent waits in the gateway and reaches it after the wait: a sentence that
// says so, or ''.
function heldText(settings) {
  const wait = settings.limits?.active('controller')
  return wait
    ? `Claude Code has reached its usage limit and answers again at ${clock(wait.until)}; the request waits until then ` +
        'and reaches it by itself. Tell the user in a few words; the answer comes later as news.'
    : ''
}

function describePermission(permission) {
  const details = preview(permission.inputPreview || '', 200)
  // Claude Code's descriptions often end with a full stop already.
  const description = String(permission.description).replace(/[\s.]+$/, '')
  return (
    `Approval needed (code=${permission.code}): ${permission.toolName} – ${description}` +
    (details ? `. Details: ${details}` : '')
  )
}

// Builds the text a voice client receives for one request.
// The first line is machine-readable so the decision to poll again never
// depends on reading prose. first: the result of ask, before which the voice
// AI said nothing, so while it still runs it confirms what went on.
function report(store, request, settings, { first = false } = {}) {
  const fresh = store.takeUnread(request)
  const permissions = store.openPermissions()
  for (const permission of permissions) permission.announced = true

  const elapsed = Math.round((Date.now() - request.createdAt) / 1000)
  const head = [`state=${request.state}`, `id=${request.id}`, `elapsed=${elapsed}s`]
  if (permissions.length) head.push(`approval=${permissions.map(p => p.code).join(',')}`)

  const lines = [`[${head.join(' ')}]`]
  for (const update of fresh) lines.push(`Claude Code: ${update.text}`)
  for (const permission of permissions) lines.push(describePermission(permission))
  lines.push(...answeredElsewhereLines(store))
  // After this, further answers to the request count as news.
  if (request.state === 'done') store.markClosed(request)
  const news = store.takeNews(request)
  if (news.length) lines.push(...describeNews(news))

  if (permissions.length) {
    lines.push(
      'Read the approval to the user and ask: allow or deny? Then call approve with the code. ' +
        'Approve nothing without an explicit yes.',
    )
  }
  const held = request.state === 'sent' ? heldText(settings) : ''
  if (held) lines.push(held)

  switch (request.state) {
    case 'done':
      lines.push(fresh.length ? 'Done. Read the answer to the user.' : 'Done, no new messages.')
      break
    case 'question':
      lines.push(
        `Claude Code is waiting for a decision. Read the question to the user and send their answer with send ` +
          `(in_reply_to=${request.id}).`,
      )
      break
    default: {
      // While an approval is open, Claude Code is waiting for the driver, not stuck.
      if (request.state === 'sent' && !permissions.length && !held && elapsed >= settings.hintAfterSeconds) {
        lines.push(
          store.controllerLastReplyAt === null
            ? 'Hint: Claude Code has not answered once since the gateway started. Check the terminal of the ' +
                'controller session: is --dangerously-load-development-channels server:voice missing, has the ' +
                'login expired, or did the turn fail with an error?'
            : 'Hint: Claude Code has not picked up the request yet. The session is probably still busy, or its ' +
                'turn failed with an error, for example because the login expired.',
        )
      }
      lines.push(
        fresh.length
          ? `Still working. Tell the user briefly and call get_reply again with id=${request.id}.`
          : first && !held
            ? `Still working. ${CONFIRM_NOW} Then call get_reply with id=${request.id}.`
            : 'Still working. Tell the user in a short phrase that it is still running, fitting the request, and ' +
                `call get_reply again with id=${request.id}.`,
      )
    }
  }
  return lines.join('\n')
}

async function waitAndReport(store, request, waitSeconds, signal, settings, options) {
  await store.waitFor(
    () =>
      store.hasUnread(request) ||
      store.hasNews(request) ||
      store.hasUnannouncedPermission() ||
      request.state === 'done' ||
      request.state === 'question',
    waitSeconds * 1000,
    signal,
  )
  return text(report(store, request, settings, options))
}

function statusText(store, settings, killswitch) {
  const open = store.openRequests()
  const permissions = store.openPermissions()
  const confirmed = store.controllerLastReplyAt !== null
  const uptime = Math.round((Date.now() - store.startedAt) / 60000)
  const lines = [
    `[gateway=ok controller=${confirmed ? 'confirmed' : 'unconfirmed'} open=${open.length} ` +
      `approvals=${permissions.length} relay=${settings.permissionRelay ? 'on' : 'off'} uptime=${uptime}m` +
      `${killswitch && killswitch.mode !== 'auto' ? ` killswitch=${killswitch.mode}` : ''}` +
      `${killswitch ? ` locked=${killswitch.locked ? 'yes' : 'no'}` : ''}]`,
    confirmed
      ? `Gateway reachable. Claude Code last answered ${ago(store.controllerLastReplyAt)}.`
      : 'Gateway reachable. Claude Code has not answered since the gateway started; a short request with ask ' +
        'shows whether the channel works.',
  ]
  if (open.length) {
    lines.push(
      'Open requests: ' + open.map(r => `${r.id} (${r.state}, "${preview(r.text, 40)}")`).join('; '),
    )
  }
  if (permissions.length) {
    lines.push('Pending approvals: ' + permissions.map(p => `${p.code} (${p.toolName})`).join('; '))
  }
  if (settings.night?.text()) lines.push(`Night mode: ${settings.night.text()}.`)
  for (const item of settings.limits?.list() ?? []) lines.push(`Waiting: ${item.text}.`)
  lines.push(...answeredElsewhereLines(store))
  const news = store.takeNews()
  if (news.length) lines.push(...describeNews(news))
  return lines.join('\n')
}

// Which connected voice chats (sign-in grants) heard the alarm of a lock.
const alarmed = new Map() // lock id -> Set of grant ids

// One MCP server instance per HTTP request; cheap, and keeps the endpoint stateless.
function buildVoiceServer(store, channel, config, { killswitch = null, grant = null, presence = null, limits = null, night = null } = {}) {
  // The waits for the Claude usage limit (limits.mjs) and night mode
  // (night.mjs) go with the settings into the reports.
  const settings = limits || night ? { ...config, limits, night } : config
  const mcp = new McpServer({ name: 'claude-code-voice', version: VERSION }, { instructions: voiceInstructions(presence) })
  // The gateway in a tool's description, for a user with several.
  const named = description =>
    presence ? `${description} This is the gateway ${presence.label}${presence.standbySetting ? ', on standby by its settings' : ''}.` : description

  // Every answer starts with the line that names this gateway and says
  // whether it is active, before the machine-readable one.
  const withLine = handler => async (...args) => {
    const result = await handler(...args)
    if (!presence) return result
    const [first, ...rest] = result.content
    return { ...result, content: [{ ...first, text: `${presence.line()}\n${first.text}` }, ...rest] }
  }

  const heard = state => {
    if (!alarmed.has(state.id)) alarmed.set(state.id, new Set())
    const seen = alarmed.get(state.id)
    const first = !seen.has(grant?.id)
    seen.add(grant?.id)
    return !first
  }

  // While the kill switch is locked, each voice chat hears the alarm once,
  // with its next call, whatever it called; after the first line, which stays
  // machine-readable.
  const withAlarm = handler => async (...args) => {
    const result = await handler(...args)
    const state = killswitch?.state
    if (!state || heard(state)) return result
    const [head, ...rest] = result.content[0].text.split('\n')
    const alarm = `[ALARM] ${alarmText(state)} Read this to the user first.`
    return { ...result, content: [{ type: 'text', text: [head, alarm, ...rest].join('\n') }, ...result.content.slice(1)] }
  }

  // The emergency stop: locked, or, with the kill switch turned off in the
  // settings, an answer that says so.
  const emergency = reason => {
    const state = killswitch.trip({ trigger: 'voice', reason }) ?? killswitch.state
    if (!state) return text(`[state=off] Emergency stop: ${offText()} Tell the user.`)
    heard(state)
    return text(`[state=locked] Emergency stop. ${alarmText(state)} Tell the user it is done.`)
  }

  // An emergency phrase locks the gateway before anything reaches Claude Code;
  // while it is locked, nothing new is handed over. With the switch off, the
  // phrase does not reach Claude Code either.
  const refuse = message => {
    if (killswitch && emergencyPhrase(message)) return emergency(`"${preview(message, 80)}" by voice`)
    if (killswitch?.locked) {
      heard(killswitch.state)
      return text(`[state=locked] ${alarmText(killswitch.state)} Nothing was handed over. Tell the user.`)
    }
    // Inactive otherwise: nothing waits here for a controller that is not
    // there. Only a standby sends the work to another connector.
    const { active, why, standby } = presence?.state() ?? { active: true }
    if (!active) {
      return text(
        `[state=inactive] Nothing was handed over: this gateway is inactive, ${why}. ` +
          (standby
            ? 'Tell the user in a few words, and use another connector whose status says active.'
            : 'Its controller is starting or not running: tell the user in a few words, and try again in a minute.'),
      )
    }
    return null
  }

  // An answer to a question settles the question: it is no longer open, and
  // a restart does not end it with a note. The open decisions of the
  // question's request keep the answer (ledger.mjs).
  const enqueue = async (message, question = null) => {
    const textForController = question ? `(Answer to ${question.id}) ${message}` : message
    const request = store.createRequest(textForController, { answers: question?.id ?? null })
    if (question?.state === 'question') store.markAnswered(question, request.id)
    await channel.push(request)
    return request
  }

  mcp.registerTool(
    'status',
    {
      title: 'Status',
      description: named(
        'Whether this gateway is reachable and Claude Code answers, with open requests and pending approvals. Use ' +
          'it when the user asks whether the connection works or what is going on, and, with several such ' +
          'connectors, on each first to find the active one.',
      ),
      annotations: { readOnlyHint: true },
    },
    withLine(withAlarm(async () => text(statusText(store, settings, killswitch)))),
  )

  if (killswitch) {
    mcp.registerTool(
      'emergency_stop',
      {
        title: 'Emergency stop',
        description: named(
          'Emergency stop (kill switch). Call it at once, without asking back, when the user says "emergency stop" ' +
            "or \"kill switch\", in any language. Locks the gateway: all work on the user's computer stops and " +
            'nothing new starts, until someone unlocks it at the computer.',
        ),
        inputSchema: {
          words: z.string().max(400).optional().describe("The user's words, if any."),
        },
        annotations: { destructiveHint: true },
      },
      withLine(async ({ words }) => emergency(words ? `"${preview(words, 80)}" by voice` : 'emergency_stop by voice')),
    )
  }

  mcp.registerTool(
    'send',
    {
      title: 'Send to Claude Code',
      description: named(
        "Pass the user's request on to Claude Code on their computer. " +
          RELAY_RULE +
          ' Returns at once with an id: follow it with get_reply until the state is done or question. Use send for ' +
          'anything that may take longer than half a minute. Call it straight away, and right after it ' +
          CONFIRM,
      ),
      inputSchema: {
        message: z.string().min(1).max(4000).describe(MESSAGE_DESCRIPTION),
        in_reply_to: z
          .string()
          .optional()
          .describe('For an answer to a question from Claude Code (state=question): the id of that request.'),
      },
    },
    withLine(withAlarm(async ({ message, in_reply_to }) => {
      const refused = refuse(message)
      if (refused) return refused
      const question = in_reply_to ? store.getRequest(in_reply_to) : null
      if (in_reply_to && !question) {
        const shown = preview(in_reply_to, 20).replace(/[\s\]]/g, '')
        return text(
          `[state=unknown in_reply_to=${shown}] No request has this id, so nothing was handed over. Send the ` +
            'answer again with the id from the question, or without in_reply_to.',
          true,
        )
      }
      const request = await enqueue(message, question)
      const held = heldText(settings)
      return text(
        `[state=sent id=${request.id}${held ? ' held=usage' : ''}] Handed over${question ? ` as the answer to ${question.id}` : ''}. ` +
          `${held || CONFIRM_NOW} Then call get_reply with id=${request.id}.`,
      )
    })),
  )

  mcp.registerTool(
    'ask',
    {
      title: 'Ask Claude Code',
      description: named(
        'Pass a short question on to Claude Code and wait up to about 40 seconds for its answer, in one call; ' +
          "like send, for anything about the user's projects, code, computer or Claude Code sessions. Call it " +
          'straight away, then read the answer. While it still runs (state=sent or working), the question is sent ' +
          'already: first confirm in a few words what you passed on, as after send, then follow the returned id ' +
          'with get_reply.',
      ),
      inputSchema: {
        message: z.string().min(1).max(4000).describe(MESSAGE_DESCRIPTION),
      },
    },
    withLine(withAlarm(async ({ message }, extra) => {
      const refused = refuse(message)
      if (refused) return refused
      const request = await enqueue(message)
      return waitAndReport(store, request, settings.maxWaitSeconds, extra.signal, settings, { first: true })
    })),
  )

  mcp.registerTool(
    'get_reply',
    {
      title: 'Get reply',
      description: named(
        'Wait for news on a request from send or ask; returns what Claude Code said since the last call, with a ' +
          'line [state=... id=...]. state=sent or working: read out briefly what Claude Code said, or else say in a ' +
          'short phrase that it is still running, varied and fitting the request, such as "Still running" or "The ' +
          'sync is still going" (in German "Läuft noch", "Der Abgleich läuft noch"); then call get_reply again with ' +
          "the same id. state=question: read the question, then send the user's answer with send (in_reply_to=id). " +
          'state=done: read the answer. A listed approval: read it to the user and ask, allow or deny.',
      ),
      inputSchema: {
        id: z.string().min(1).describe('The id returned by send or ask.'),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Seconds to wait for news; best left out, the default suits voice.'),
      },
      annotations: { readOnlyHint: true },
    },
    withLine(withAlarm(async ({ id, wait_seconds }, extra) => {
      const request = store.getRequest(id)
      if (!request) {
        return text(`[state=unknown id=${id}] Unknown request. Start a new one with send.`)
      }
      const wait = clamp(wait_seconds ?? settings.defaultWaitSeconds, 1, settings.maxWaitSeconds)
      return waitAndReport(store, request, wait, extra.signal, settings)
    })),
  )

  if (settings.permissionRelay) {
    mcp.registerTool(
      'approve',
      {
        title: 'Answer approval',
        description: named(
          'Answer a permission prompt from Claude Code, such as running a shell command or writing a file. Call it ' +
            'only after you read the request to the user and they explicitly said yes (allow) or no (deny) to this ' +
            'action, then straight away; right after it, confirm their decision in a short phrase of their language, ' +
            'such as "Allowed" or "Denied" (in German "Erlaubt", "Abgelehnt").',
        ),
        inputSchema: {
          code: z
            .string()
            .regex(/^[a-km-z]{5}$/i, 'five letters, as listed in get_reply')
            .describe('The five-letter approval code from get_reply.'),
          decision: z.enum(['allow', 'deny']).describe('allow if the user said yes, deny if they said no.'),
        },
        annotations: { destructiveHint: true },
      },
      withLine(withAlarm(async ({ code, decision }) => {
        // Answered in the terminal or through Remote Control: a verdict now
        // would apply to nothing.
        const known = store.getPermission(code)
        if (known?.status === 'elsewhere') {
          return text(
            `[approval=elsewhere code=${known.code}] Already answered at the computer; nothing to do. Tell the user ` +
              'in a few words.',
          )
        }
        if (killswitch?.locked && decision === 'allow') {
          return text(`[approval=locked code=${code}] The kill switch is locked: nothing can be allowed now.`)
        }
        const permission = store.resolvePermission(code, decision)
        if (!permission) {
          return text(`[approval=unknown code=${code}] This approval is unknown or already answered.`)
        }
        await channel.sendVerdict(permission.code, decision)
        return text(
          decision === 'allow'
            ? `[approval=allow code=${permission.code}] Allowed. Claude Code continues; call get_reply.`
            : `[approval=deny code=${permission.code}] Denied.`,
        )
      })),
    )
  }

  return mcp
}

const MAX_BODY_BYTES = 1024 * 1024

// One log line per JSON-RPC message, so the log shows whether the
// voice assistant called the connector at all, and which tool. Message texts are
// logged by the channel side (push) only when a request reaches the controller.
function logCall(req, body, grant, caller) {
  for (const message of Array.isArray(body) ? body : [body]) {
    const method = message?.method
    if (!method || method.startsWith('notifications/')) continue
    if (method === 'initialize') {
      const client = message.params?.clientInfo ?? {}
      log(
        'voice initialize',
        `client=${client.name ?? '?'}/${client.version ?? '?'}`,
        `protocol=${message.params?.protocolVersion ?? '?'}`,
        `ua=${JSON.stringify(preview(req.headers['user-agent'] ?? '', 60))}`,
        `from=${caller.address}`,
        `grant=${grant.id}`,
      )
    } else if (method === 'tools/call') {
      log('voice tools/call', message.params?.name ?? '?')
    } else {
      log('voice', method)
    }
  }
}

// A request target that is no URL at all, such as "http://[", is answered
// with a 400 instead of failing the handler.
function parseUrl(target) {
  try {
    return new URL(target || '/', 'http://localhost')
  } catch {
    return null
  }
}

// onPortBusy: called when another process holds the port (gateway.mjs ends
// the gateway then); without it, that is only logged. guard: who may call
// /mcp, and the alerts (ipguard.mjs). presence: which gateway this is, and
// whether it is active (presence.mjs). standby: the standby after a
// disconnect, which hears of every voice request without a valid token
// (standby.mjs).
export function startVoiceHttp(
  store,
  channel,
  auth,
  settings,
  { killswitch = null, onPortBusy = null, guard = new IpGuard(), presence = null, standby = null, limits = null, night = null } = {},
) {
  const server = createServer(async (req, res) => {
    const caller = guard.caller(req)
    const url = parseUrl(req.url)
    // The watchdog checks /healthz every 30 s; those lines would drown the rest.
    if (url?.pathname !== '/healthz' || caller.via !== 'local') {
      res.on('close', () => log(accessLine(req, res, url, caller)))
    }
    if (!url) {
      res.writeHead(400).end()
      return
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return
    }
    try {
      if (await auth.handle(req, res, url)) return
    } catch (error) {
      log('oauth request failed:', error.message)
      if (!res.headersSent) res.writeHead(error.status ?? (error instanceof SyntaxError ? 400 : 500)).end()
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end() // the access log has it, with the caller's address
      return
    }
    // Claude voice mode calls only from Anthropic's servers: through the
    // tunnel, anyone else is turned away before the token is looked at.
    if (!guard.allows(caller)) {
      guard.blocked(req, caller)
      res.writeHead(403).end()
      return
    }
    const { grant, error, reason } = auth.verify(req)
    if (!grant) {
      standby?.refused(caller, reason)
      guard.refused(caller, reason)
      auth.challenge(res, req, error)
      return
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no sessions (DELETE).
      log('voice', req.method, '-> 405, POST only')
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }

    let body
    try {
      body = JSON.parse(await readBody(req, MAX_BODY_BYTES))
    } catch (error) {
      log('voice request unreadable:', error.message)
      const status = error.status ?? 400
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
      return
    }
    logCall(req, body, grant, caller)

    // Tool calls show that the voice mode is still on (Telegram fallback).
    if ((Array.isArray(body) ? body : [body]).some(message => message?.method === 'tools/call')) {
      store.voiceCallStarted()
      res.on('close', () => store.voiceCallEnded())
    }

    const mcp = buildVoiceServer(store, channel, settings, { killswitch, grant, presence, limits, night })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      transport.close().catch(() => {})
      mcp.close().catch(() => {})
    })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      log('voice request failed', error?.message || String(error))
      if (!res.headersSent) res.writeHead(500).end()
    }
  })

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      log(
        `voice port ${settings.host}:${settings.port} is in use by another process: a second controller session, ` +
          `or a gateway left over from an earlier one. lsof -nP -iTCP:${settings.port} -sTCP:LISTEN shows it.`,
      )
      onPortBusy?.(error)
      return
    }
    log(`voice HTTP server error on ${settings.host}:${settings.port}: ${error.message}`)
  })
  server.listen(settings.port, settings.host, () => {
    log(`voice endpoint listening on http://${settings.host}:${settings.port}/mcp (OAuth sign-in)`)
  })
  return server
}
