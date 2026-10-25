// Voice side: a Streamable HTTP MCP endpoint for the voice assistant
// (Claude voice mode, Grok, ...), reached through a tunnel.
//
// Stateless by design: every POST gets its own short-lived MCP server, all
// state lives in the shared Store. Long tasks are followed with short polls
// (get_reply), because a single tool call has to finish before the client's
// request deadline (commonly 60 s).

import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { VERSION, tokenMatches } from './config.mjs'
import { log, preview } from './log.mjs'

const VOICE_INSTRUCTIONS = `
This connector reaches Claude Code sessions running on the user's own computer. The user is usually
driving, so keep everything you say short.
Workflow: send (or ask) -> get_reply, repeated while state is "sent" or "working" (each call waits up
to about 40 seconds) -> read the answer. Between polls tell the user in a few words that it is still
running. Relay Claude Code's answers faithfully; you may shorten them but never invent results.
Approvals: read them out and call approve only after the user explicitly said yes or no to that action.
`.trim()

const RELAY_RULE =
  "Use it for anything about the user's projects, code, computer or running Claude Code sessions: " +
  'you cannot see their machine, Claude Code can. Pass the request on instead of answering from your ' +
  'own knowledge or searching the web.'

const MESSAGE_DESCRIPTION =
  "The user's request word for word, in their language. Do not summarise, translate or add your own framing."

const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError })

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

function ago(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 90) return `vor ${seconds} Sekunden`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `vor ${minutes} Minuten`
  return `vor ${Math.round(minutes / 60)} Stunden`
}

function describePermission(permission) {
  const details = preview(permission.inputPreview || '', 200)
  return (
    `Freigabe nötig (code=${permission.code}): ${permission.toolName} – ${permission.description}` +
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

  if (permissions.length) {
    lines.push(
      'Lies dem Nutzer die Freigabe vor und frag: erlauben oder ablehnen? Ruf danach approve mit dem code auf. ' +
        'Ohne ausdrückliches Ja nichts freigeben.',
    )
  }

  switch (request.state) {
    case 'done':
      lines.push(fresh.length ? 'Fertig. Lies die Antwort vor.' : 'Fertig, keine neuen Nachrichten.')
      break
    case 'question':
      lines.push(
        `Claude Code wartet auf eine Entscheidung. Lies die Frage vor und schick die Antwort des Nutzers mit send ` +
          `(in_reply_to=${request.id}).`,
      )
      break
    default: {
      if (request.state === 'sent' && elapsed >= settings.hintAfterSeconds) {
        lines.push(
          store.controllerLastReplyAt === null
            ? 'Hinweis: Claude Code hat seit dem Start des Gateways noch nie geantwortet. Läuft die Controller-Session ' +
                'mit --dangerously-load-development-channels server:voice?'
            : 'Hinweis: Claude Code hat den Auftrag noch nicht aufgenommen, vermutlich ist die Session noch beschäftigt.',
        )
      }
      lines.push(`Noch in Arbeit. Sag dem Nutzer kurz Bescheid und ruf get_reply erneut mit id=${request.id} auf.`)
    }
  }
  return lines.join('\n')
}

async function waitAndReport(store, request, waitSeconds, signal, settings) {
  await store.waitFor(
    () =>
      store.hasUnread(request) ||
      store.hasUnannouncedPermission() ||
      request.state === 'done' ||
      request.state === 'question',
    waitSeconds * 1000,
    signal,
  )
  return text(report(store, request, settings))
}

function statusText(store, settings) {
  const open = store.openRequests()
  const permissions = store.openPermissions()
  const confirmed = store.controllerLastReplyAt !== null
  const uptime = Math.round((Date.now() - store.startedAt) / 60000)
  const lines = [
    `[gateway=ok controller=${confirmed ? 'confirmed' : 'unconfirmed'} open=${open.length} ` +
      `approvals=${permissions.length} relay=${settings.permissionRelay ? 'on' : 'off'} uptime=${uptime}m]`,
    confirmed
      ? `Gateway erreichbar. Claude Code hat zuletzt ${ago(store.controllerLastReplyAt)} geantwortet.`
      : 'Gateway erreichbar. Claude Code hat seit dem Start noch nie geantwortet; ein kurzer Auftrag mit ask zeigt, ob der Kanal funktioniert.',
  ]
  if (open.length) {
    lines.push(
      'Offene Aufträge: ' + open.map(r => `${r.id} (${r.state}, „${preview(r.text, 40)}“)`).join('; '),
    )
  }
  if (permissions.length) {
    lines.push('Offene Freigaben: ' + permissions.map(p => `${p.code} (${p.toolName})`).join('; '))
  }
  return lines.join('\n')
}

// One MCP server instance per HTTP request; cheap, and keeps the endpoint stateless.
function buildVoiceServer(store, channel, settings) {
  const mcp = new McpServer({ name: 'claude-code-voice', version: VERSION }, { instructions: VOICE_INSTRUCTIONS })

  const enqueue = async (message, inReplyTo) => {
    const textForController = inReplyTo ? `(Antwort auf ${inReplyTo}) ${message}` : message
    const request = store.createRequest(textForController)
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
    async () => text(statusText(store, settings)),
  )

  mcp.registerTool(
    'send',
    {
      title: 'An Claude Code senden',
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
          .describe('If this answers a question from Claude Code (state=question), the id of that request.'),
      },
    },
    async ({ message, in_reply_to }) => {
      const request = await enqueue(message, in_reply_to)
      return text(`[state=sent id=${request.id}] Übergeben. Ruf jetzt get_reply mit id=${request.id} auf.`)
    },
  )

  mcp.registerTool(
    'ask',
    {
      title: 'Claude Code fragen',
      description:
        'Send a short question to Claude Code and wait up to about 40 seconds for the answer in one call. ' +
        RELAY_RULE +
        ' If the result says state=working, continue with get_reply and the returned id; never call ask again ' +
        'for the same request, that would send it twice.',
      inputSchema: {
        message: z.string().min(1).max(4000).describe(MESSAGE_DESCRIPTION),
      },
    },
    async ({ message }, extra) => {
      const request = await enqueue(message)
      return waitAndReport(store, request, settings.maxWaitSeconds, extra.signal, settings)
    },
  )

  mcp.registerTool(
    'get_reply',
    {
      title: 'Antwort abholen',
      description:
        'Wait for news on a request sent with send or ask, then return what Claude Code said since the last call. ' +
        'The first line is machine-readable: [state=... id=...]. state=sent or working: tell the user briefly ' +
        'that it is still running and call get_reply again with the same id. state=question: read the question ' +
        'and send the answer with send (in_reply_to=id). state=done: read the answer. If an approval is listed, ' +
        'ask the user before calling approve.',
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
    async ({ id, wait_seconds }, extra) => {
      const request = store.getRequest(id)
      if (!request) {
        return text(`[state=unknown id=${id}] Diesen Auftrag kenne ich nicht. Mit send einen neuen starten.`)
      }
      const wait = clamp(wait_seconds ?? settings.defaultWaitSeconds, 1, settings.maxWaitSeconds)
      return waitAndReport(store, request, wait, extra.signal, settings)
    },
  )

  if (settings.permissionRelay) {
    mcp.registerTool(
      'approve',
      {
        title: 'Freigabe beantworten',
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
      async ({ code, decision }) => {
        const permission = store.resolvePermission(code, decision)
        if (!permission) {
          return text(`[approval=unknown code=${code}] Diese Freigabe ist unbekannt oder schon erledigt.`)
        }
        await channel.sendVerdict(permission.code, decision)
        return text(
          decision === 'allow'
            ? `[approval=allow code=${permission.code}] Erlaubt. Claude Code arbeitet weiter; ruf get_reply auf.`
            : `[approval=deny code=${permission.code}] Abgelehnt.`,
        )
      },
    )
  }

  return mcp
}

// Accepts the secret as path segment (/mcp/<token>), bearer header or ?token=.
// Anything unauthenticated gets a bare 404: a 401 would make some clients
// start an OAuth discovery flow that does not exist here.
function authenticate(req, url, token) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'mcp' || parts.length > 2) return false
  if (parts.length === 2) return tokenMatches(token, parts[1])
  const header = req.headers.authorization || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  return tokenMatches(token, bearer) || tokenMatches(token, url.searchParams.get('token') || '')
}

export function startVoiceHttp(store, channel, settings) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return
    }
    if (!authenticate(req, url, settings.token)) {
      log('rejected', req.method, url.pathname.startsWith('/mcp') ? '/mcp/…' : url.pathname)
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no sessions (DELETE).
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }

    const mcp = buildVoiceServer(store, channel, settings)
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
      await transport.handleRequest(req, res)
    } catch (error) {
      log('voice request failed', error?.message || String(error))
      if (!res.headersSent) res.writeHead(500).end()
    }
  })

  server.on('error', error => {
    const hint =
      error.code === 'EADDRINUSE'
        ? ' (port busy: is another controller session or an old gateway still running?)'
        : ''
    log(`voice HTTP server error on ${settings.host}:${settings.port}: ${error.message}${hint}`)
  })
  server.listen(settings.port, settings.host, () => {
    log(`voice endpoint listening on http://${settings.host}:${settings.port}/mcp/<token>`)
  })
  return server
}
