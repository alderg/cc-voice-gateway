// Voice side: a Streamable HTTP MCP endpoint for the voice assistant
// (Claude voice mode), reached through a tunnel and protected by the OAuth
// sign-in in oauth.mjs.
//
// Stateless by design: every POST gets its own short-lived MCP server, all
// state lives in the shared Store. Long tasks are followed with short polls
// (get_reply), because a single tool call has to finish before the client's
// request deadline (commonly 60 s).

import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { VERSION } from './config.mjs'
import { readBody } from './http.mjs'
import { log, preview } from './log.mjs'
import { alarmText, emergencyPhrase } from './killswitch.mjs'

const VOICE_INSTRUCTIONS = `
This connector reaches Claude Code sessions running on the user's own computer. The user is usually
driving, so keep everything you say short.
Workflow: send (or ask) -> get_reply, repeated while state is "sent" or "working" (each call waits up
to about 40 seconds) -> read the answer. Between polls tell the user in a few words that it is still
running. Relay Claude Code's answers faithfully; you may shorten them but never invent results.
Approvals: read them out and call approve only after the user explicitly said yes or no to that action.
News: results of work Claude Code finished in the background arrive with any call. Read them out too.
Emergency: when the user says "Notstopp", "Not-Aus", "emergency stop" or "kill switch", call emergency_stop at
once, without asking back. An [ALARM] line in any result is read out first.
`.trim()

const RELAY_RULE =
  "Use it for anything about the user's projects, code, computer or running Claude Code sessions: " +
  'you cannot see their machine, Claude Code can. Pass the request on instead of answering from your ' +
  'own knowledge or searching the web.'

const MESSAGE_DESCRIPTION =
  "The user's request word for word, in their language. Do not summarise, translate or add your own framing."

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
// depends on reading prose.
function report(store, request, settings) {
  const fresh = store.takeUnread(request)
  const permissions = store.openPermissions()
  for (const permission of permissions) permission.announced = true

  const elapsed = Math.round((Date.now() - request.createdAt) / 1000)
  const head = [`state=${request.state}`, `id=${request.id}`, `elapsed=${elapsed}s`]
  if (permissions.length) head.push(`approval=${permissions.map(p => p.code).join(',')}`)

  const lines = [`[${head.join(' ')}]`]
  for (const update of fresh) lines.push(`Claude Code: ${update.text}`)
  for (const permission of permissions) lines.push(describePermission(permission))
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
      if (request.state === 'sent' && !permissions.length && elapsed >= settings.hintAfterSeconds) {
        lines.push(
          store.controllerLastReplyAt === null
            ? 'Hint: Claude Code has not answered once since the gateway started. Check the terminal of the ' +
                'controller session: is --dangerously-load-development-channels server:voice missing, has the ' +
                'login expired, or did the turn fail with an error?'
            : 'Hint: Claude Code has not picked up the request yet. The session is probably still busy, or its ' +
                'turn failed with an error, for example because the login expired.',
        )
      }
      lines.push(`Still working. Tell the user briefly and call get_reply again with id=${request.id}.`)
    }
  }
  return lines.join('\n')
}

async function waitAndReport(store, request, waitSeconds, signal, settings) {
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
  return text(report(store, request, settings))
}

function statusText(store, settings, killswitch) {
  const open = store.openRequests()
  const permissions = store.openPermissions()
  const confirmed = store.controllerLastReplyAt !== null
  const uptime = Math.round((Date.now() - store.startedAt) / 60000)
  const lines = [
    `[gateway=ok controller=${confirmed ? 'confirmed' : 'unconfirmed'} open=${open.length} ` +
      `approvals=${permissions.length} relay=${settings.permissionRelay ? 'on' : 'off'} uptime=${uptime}m` +
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
  const news = store.takeNews()
  if (news.length) lines.push(...describeNews(news))
  return lines.join('\n')
}

// Which connected voice chats (sign-in grants) heard the alarm of a lock.
const alarmed = new Map() // lock id -> Set of grant ids

// One MCP server instance per HTTP request; cheap, and keeps the endpoint stateless.
function buildVoiceServer(store, channel, settings, { killswitch = null, grant = null } = {}) {
  const mcp = new McpServer({ name: 'claude-code-voice', version: VERSION }, { instructions: VOICE_INSTRUCTIONS })

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

  // An emergency phrase locks the gateway before anything reaches Claude Code;
  // while it is locked, nothing new is handed over.
  const refuse = message => {
    if (killswitch && emergencyPhrase(message)) {
      const state = killswitch.trip({ trigger: 'voice', reason: `"${preview(message, 80)}" by voice` })
      heard(state)
      return text(`[state=locked] Emergency stop. ${alarmText(state)} Tell the user it is done.`)
    }
    if (killswitch?.locked) {
      heard(killswitch.state)
      return text(`[state=locked] ${alarmText(killswitch.state)} Nothing was handed over. Tell the user.`)
    }
    return null
  }

  // An answer to a question settles the question: it is no longer open, and
  // a restart does not end it with a note.
  const enqueue = async (message, question = null) => {
    const textForController = question ? `(Answer to ${question.id}) ${message}` : message
    const request = store.createRequest(textForController)
    if (question?.state === 'question') store.markAnswered(question, request.id)
    await channel.push(request)
    return request
  }

  mcp.registerTool(
    'status',
    {
      title: 'Status',
      description:
        'Check that the voice gateway is reachable and whether Claude Code is answering; lists open requests ' +
        'and pending approvals. Use when the user asks if the connection works or what is going on.',
      annotations: { readOnlyHint: true },
    },
    withAlarm(async () => text(statusText(store, settings, killswitch))),
  )

  if (killswitch) {
    mcp.registerTool(
      'emergency_stop',
      {
        title: 'Emergency stop',
        description:
          'Emergency stop (kill switch). Call it at once, without asking back, when the user says "Notstopp", ' +
          '"Not-Aus", "emergency stop" or "kill switch". Locks the gateway: no new tasks, all work on the ' +
          "user's computer stops. Only someone at the computer can unlock it.",
        inputSchema: {
          words: z.string().max(400).optional().describe("The user's words, if any."),
        },
        annotations: { destructiveHint: true },
      },
      async ({ words }) => {
        const state = killswitch.trip({ trigger: 'voice', reason: words ? `"${preview(words, 80)}" by voice` : 'emergency_stop by voice' })
        heard(state)
        return text(`[state=locked] Emergency stop. ${alarmText(state)} Tell the user it is done.`)
      },
    )
  }

  mcp.registerTool(
    'send',
    {
      title: 'Send to Claude Code',
      description:
        'Send the user\'s request to Claude Code on their computer. ' +
        RELAY_RULE +
        ' Returns immediately with an id; then call get_reply with that id until state is done or question. ' +
        'Prefer this over ask for anything that may take longer than half a minute.',
      inputSchema: {
        message: z.string().min(1).max(4000).describe(MESSAGE_DESCRIPTION),
        in_reply_to: z
          .string()
          .optional()
          .describe(
            'If this answers a question from Claude Code (state=question), the id of that request. The question ' +
              'then counts as answered; follow the answer with get_reply and the new id.',
          ),
      },
    },
    withAlarm(async ({ message, in_reply_to }) => {
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
      return text(
        `[state=sent id=${request.id}] Handed over${question ? ` as the answer to ${question.id}` : ''}. ` +
          `Now call get_reply with id=${request.id}.`,
      )
    }),
  )

  mcp.registerTool(
    'ask',
    {
      title: 'Ask Claude Code',
      description:
        'Send a short question to Claude Code and wait up to about 40 seconds for the answer in one call. ' +
        RELAY_RULE +
        ' If the result says state=working, continue with get_reply and the returned id; never call ask again ' +
        'for the same request, that would send it twice.',
      inputSchema: {
        message: z.string().min(1).max(4000).describe(MESSAGE_DESCRIPTION),
      },
    },
    withAlarm(async ({ message }, extra) => {
      const refused = refuse(message)
      if (refused) return refused
      const request = await enqueue(message)
      return waitAndReport(store, request, settings.maxWaitSeconds, extra.signal, settings)
    }),
  )

  mcp.registerTool(
    'get_reply',
    {
      title: 'Get reply',
      description:
        'Wait for news on a request sent with send or ask, then return what Claude Code said since the last call. ' +
        'The first line is machine-readable: [state=... id=...]. state=sent or working: tell the user briefly ' +
        'that it is still running and call get_reply again with the same id. state=question: read the question ' +
        'and send the answer with send (in_reply_to=id), then follow the new id. state=done: read the answer. If ' +
        'an approval is listed, ask the user before calling approve.',
      inputSchema: {
        id: z.string().min(1).describe('The id returned by send or ask.'),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('How long to wait for news before returning. Leave it out; the default is right for voice.'),
      },
      annotations: { readOnlyHint: true },
    },
    withAlarm(async ({ id, wait_seconds }, extra) => {
      const request = store.getRequest(id)
      if (!request) {
        return text(`[state=unknown id=${id}] Unknown request. Start a new one with send.`)
      }
      const wait = clamp(wait_seconds ?? settings.defaultWaitSeconds, 1, settings.maxWaitSeconds)
      return waitAndReport(store, request, wait, extra.signal, settings)
    }),
  )

  if (settings.permissionRelay) {
    mcp.registerTool(
      'approve',
      {
        title: 'Answer approval',
        description:
          'Answer a permission prompt from Claude Code, for example running a shell command or writing a file. ' +
          'Only call this after you read the request to the user and they explicitly said yes (allow) or no ' +
          '(deny) to this specific action. Never approve on your own.',
        inputSchema: {
          code: z
            .string()
            .regex(/^[a-km-z]{5}$/i, 'five letters, as listed in get_reply')
            .describe('The five-letter approval code from get_reply.'),
          decision: z.enum(['allow', 'deny']).describe('allow if the user said yes, deny if they said no.'),
        },
        annotations: { destructiveHint: true },
      },
      withAlarm(async ({ code, decision }) => {
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
      }),
    )
  }

  return mcp
}

const MAX_BODY_BYTES = 1024 * 1024

// One log line per JSON-RPC message, so the log shows whether the
// voice assistant called the connector at all, and which tool. Message texts are
// logged by the channel side (push) only when a request reaches the controller.
function logCall(req, body, grant) {
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
        `from=${req.headers['x-forwarded-for'] ?? req.socket.remoteAddress}`,
        `grant=${grant.id}`,
      )
    } else if (method === 'tools/call') {
      log('voice tools/call', message.params?.name ?? '?')
    } else {
      log('voice', method)
    }
  }
}

// onPortBusy: called when another process holds the port (gateway.mjs ends
// the gateway then); without it, that is only logged.
export function startVoiceHttp(store, channel, auth, settings, { killswitch = null, onPortBusy = null } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')

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
      // Old connector URLs had the secret in the path; keep it out of the log.
      log('rejected', req.method, url.pathname.startsWith('/mcp/') ? '/mcp/…' : preview(url.pathname, 60))
      res.writeHead(404).end()
      return
    }
    const { grant, error } = auth.verify(req)
    if (!grant) {
      log('voice 401', error === 'missing' ? 'no token: the client has to sign in' : 'unknown or expired token')
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
    logCall(req, body, grant)

    // Tool calls show that the voice mode is still on (Telegram fallback).
    if ((Array.isArray(body) ? body : [body]).some(message => message?.method === 'tools/call')) {
      store.voiceCallStarted()
      res.on('close', () => store.voiceCallEnded())
    }

    const mcp = buildVoiceServer(store, channel, settings, { killswitch, grant })
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
