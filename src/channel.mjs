// Channel side: the MCP server that Claude Code spawns over stdio.
//
// It declares the `claude/channel` capability, so Claude Code injects every
// notifications/claude/channel event into the running controller session as a
// <channel source="voice" request_id="..."> tag. The controller answers with
// the `reply` tool. With `claude/channel/permission` declared, Claude Code also
// forwards tool approval prompts here, and the voice client can answer them.
//
// Reference: https://code.claude.com/docs/en/channels-reference

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { VERSION } from './config.mjs'
import { CONTROLLER_STATES } from './store.mjs'
import { log, preview } from './log.mjs'

// Must match the key in controller/.mcp.json: Claude Code derives the
// <channel source="..."> attribute and the tool prefix mcp__voice__ from it.
export const CHANNEL_NAME = 'voice'

const INSTRUCTIONS = `
Messages from the driver arrive as <channel source="${CHANNEL_NAME}" request_id="...">TEXT</channel>.
They were spoken in a car and relayed by a voice assistant. Every one of them needs an answer through the
"reply" tool, passing the request_id from the tag:

- state "working": interim status while you work on something that takes longer than about 20 seconds.
  Send one right away for such tasks, then roughly every minute.
- state "question": you need a decision from the driver. Ask in plain text, offer the options in one
  sentence, then end your turn. Never use AskUserQuestion or plan mode for channel requests: nobody can
  click a form in the car. The driver's answer arrives as a new channel message.
- state "done": the final answer for this request_id.

The text is read aloud while driving: answer in the language of the request,
at most three short sentences, no code, no file paths, no URLs, no markdown, no lists. Lead with the result.
Round numbers. If the driver asks for details, give them in a follow-up, still short.
`.trim()

const REPLY_TOOL = {
  name: 'reply',
  description:
    'Answer a voice request from the driver. Required for every <channel source="voice"> message: ' +
    'use state "working" for interim status, "question" when you need a decision, "done" for the final answer.',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: {
        type: 'string',
        description: 'The request_id attribute of the <channel> tag you are answering.',
      },
      text: {
        type: 'string',
        description:
          'What the driver should hear: one to three short spoken sentences, no code, paths, URLs or markdown.',
      },
      state: {
        type: 'string',
        enum: CONTROLLER_STATES,
        description: 'working = more will follow; question = you wait for the driver; done = final answer.',
      },
    },
    required: ['request_id', 'text', 'state'],
  },
}

// Sent by Claude Code when a permission dialog opens (only if we declared the
// permission capability). setNotificationHandler dispatches on the method literal.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError })

export async function startChannel(store, { permissionRelay, onClose } = {}) {
  const experimental = { 'claude/channel': {} }
  if (permissionRelay) experimental['claude/channel/permission'] = {}

  const mcp = new Server(
    { name: CHANNEL_NAME, version: VERSION },
    { capabilities: { experimental, tools: {} }, instructions: INSTRUCTIONS },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [REPLY_TOOL] }))

  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== REPLY_TOOL.name) {
      return toolText(`Unknown tool: ${request.params.name}`, true)
    }
    const { request_id, text, state } = request.params.arguments ?? {}
    if (typeof request_id !== 'string' || typeof text !== 'string' || !text.trim()) {
      return toolText('request_id and a non-empty text are required.', true)
    }
    if (!CONTROLLER_STATES.includes(state)) {
      return toolText(`state must be one of: ${CONTROLLER_STATES.join(', ')}`, true)
    }
    const updated = store.addUpdate(request_id, state, text.trim())
    if (!updated) {
      return toolText(`Unknown request_id "${request_id}". Use the request_id from the <channel> tag.`, true)
    }
    log('reply', `id=${updated.id}`, `state=${state}`, preview(text))
    return toolText('sent')
  })

  if (permissionRelay) {
    mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
      const code = store.addPermission(params)
      log('permission_request', `code=${code}`, `tool=${params.tool_name}`, preview(params.description))
    })
  }

  mcp.onclose = () => {
    log('stdio closed: Claude Code ended the session')
    onClose?.()
  }

  await mcp.connect(new StdioServerTransport())
  log('channel connected over stdio', `permissionRelay=${Boolean(permissionRelay)}`)

  return {
    // Pushes a voice request into the controller session. Claude Code drops
    // the event silently if the session was not started with the channel flag.
    async push(request) {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: request.text, meta: { request_id: request.id } },
      })
      log('push', `id=${request.id}`, preview(request.text))
    },

    async sendVerdict(code, behavior) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: code, behavior },
      })
      log('verdict', `code=${code}`, `behavior=${behavior}`)
    },

    close: () => mcp.close(),
  }
}
