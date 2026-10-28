// Channel side: the MCP server that Claude Code spawns over stdio.
//
// It declares the `claude/channel` capability, so Claude Code injects every
// notifications/claude/channel event into the running controller session as a
// <channel source="voice" request_id="..."> tag. The controller answers with
// the `reply` tool. With `claude/channel/permission` declared, Claude Code also
// forwards tool approval prompts here, and the voice client can answer them.
// The worker tools (list_workers, dispatch, worker_status, stop_worker) let the
// controller hand repository work to headless runs; see workers.mjs.
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

Workers: the driver's repositories are worked on by workers, one per repository (list_workers). Anything about
a repository, questions included, goes to its worker with dispatch; do no repository work yourself. Put the
driver's own words in "words" and write "task" so that the worker can act without asking. dispatch returns at
once: tell the driver it is on its way and reply with state "done".
When a run ends, a message arrives as <channel source="${CHANNEL_NAME}" request_id="..." worker="..." task="..."
outcome="done|failed|stopped">. Summarise it for the driver like any answer and reply with that request_id:
state "done", or "question" when the worker asks something. The driver hears it as news. Their answer arrives
as a new message "(Answer to <id>) ...": pass it to the same worker with dispatch, as a follow-up.
When the run opened or updated a pull request, the tag also has pull_request="<number>": say only briefly
that it is out, and which one. Never offer or suggest a review; details only when the driver asks.
Checks and reviews that run on such a pull request by themselves arrive later as <channel source="${CHANNEL_NAME}"
request_id="..." worker="..." repo="owner/name" pull_request="..." kind="checks|review|comment">: summarise them
in one or two sentences and reply "done", without asking anything. The driver hears it as news.
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

const WORKER_PROPERTY = { type: 'string', description: 'The repository name, as list_workers shows it.' }

const WORKER_TOOLS = [
  {
    name: 'list_workers',
    description:
      'List the repositories a worker can work in: origin, public or private, current branch, uncommitted files ' +
      'and what the worker is doing. Use it to find the repository the driver means.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dispatch',
    description:
      "Hand a task to a repository's worker: a headless Claude Code run in its checkout, without approvals. " +
      'For changes it commits on a voice/ branch, pushes and opens a draft pull request; on public repositories ' +
      'it asks before pushing. Returns at once; when the run ends you get a channel event with that worker. ' +
      'By default the worker continues its previous session there, so follow-ups keep their context.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: WORKER_PROPERTY,
        task: { type: 'string', description: 'The task in your words, complete enough to act on without asking.' },
        words: { type: 'string', description: "The driver's own words for this task, as they arrived." },
        fresh: { type: 'boolean', description: 'Start a new session instead of continuing the previous one.' },
        allow_dirty: {
          type: 'boolean',
          description: 'Go ahead although the checkout has uncommitted changes. Only after the driver said yes.',
        },
      },
      required: ['worker', 'task', 'words'],
    },
  },
  {
    name: 'worker_status',
    description: 'What a worker is doing or did last: state, elapsed time, last steps, last message, result.',
    inputSchema: { type: 'object', properties: { worker: WORKER_PROPERTY }, required: ['worker'] },
  },
  {
    name: 'stop_worker',
    description: "Stop a worker's running task.",
    inputSchema: { type: 'object', properties: { worker: WORKER_PROPERTY }, required: ['worker'] },
  },
]

const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError })

function dispatchText(worker, result) {
  switch (result.status) {
    case 'started':
      return toolText(
        `[dispatch=started worker=${worker} task=${result.task.id} session=${result.task.resumed ? 'continued' : 'new'}] ` +
          `Started on branch ${result.facts.branch || 'detached'}. Tell the driver it is on its way. When it ends, ` +
          `a channel event with worker="${worker}" arrives.`,
      )
    case 'dirty': {
      const shown = result.files.slice(0, 5).join(', ') + (result.files.length > 5 ? ', …' : '')
      return toolText(
        `[dispatch=dirty worker=${worker} files=${result.files.length}] The checkout has uncommitted changes: ` +
          `${shown}. Ask the driver whether the worker should go ahead anyway; if yes, call dispatch again with ` +
          'allow_dirty=true.',
      )
    }
    case 'busy':
      return toolText(
        `[dispatch=busy worker=${worker} task=${result.task?.id ?? 'starting'}] A task is already running in this ` +
          'repository. Tell the driver; they can wait, or stop it with stop_worker.',
      )
    case 'full':
      return toolText(
        `[dispatch=full running=${result.running.length}] Workers are already running in ` +
          `${result.running.map(t => t.repo).join(' and ')}. Tell the driver to wait or to stop one.`,
      )
    default:
      return toolText(
        `[dispatch=unknown worker=${worker}] No repository with that name. Known: ${result.names.join(', ')}.`,
        true,
      )
  }
}

async function callWorkerTool(workers, name, args) {
  const worker = typeof args.worker === 'string' ? args.worker.trim() : ''
  if (name === 'list_workers') return toolText(await workers.listText())
  if (!worker) return toolText('worker is required: a repository name from list_workers.', true)
  if (!workers.repos().includes(worker)) {
    return toolText(`No repository "${worker}". Known: ${workers.repos().join(', ')}.`, true)
  }
  if (name === 'worker_status') return toolText(workers.statusText(worker))
  if (name === 'stop_worker') {
    const task = workers.stop(worker)
    return toolText(
      task ? `[worker=${worker} stopped task=${task.id}] Stopped.` : `[worker=${worker}] Nothing is running there.`,
    )
  }
  // dispatch
  if (typeof args.task !== 'string' || !args.task.trim()) return toolText('task is required.', true)
  const result = await workers.dispatch({
    worker,
    task: args.task,
    words: typeof args.words === 'string' ? args.words : '',
    fresh: args.fresh === true,
    allowDirty: args.allow_dirty === true,
  })
  return dispatchText(worker, result)
}

export async function startChannel(store, { permissionRelay, workers, onClose } = {}) {
  const experimental = { 'claude/channel': {} }
  if (permissionRelay) experimental['claude/channel/permission'] = {}

  const mcp = new Server(
    { name: CHANNEL_NAME, version: VERSION },
    { capabilities: { experimental, tools: {} }, instructions: INSTRUCTIONS },
  )

  const tools = workers ? [REPLY_TOOL, ...WORKER_TOOLS] : [REPLY_TOOL]
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    if (workers && WORKER_TOOLS.some(tool => tool.name === request.params.name)) {
      return callWorkerTool(workers, request.params.name, request.params.arguments ?? {})
    }
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

  // Events sent before Claude Code finished the handshake would be lost.
  let markReady
  const ready = new Promise(resolve => (markReady = resolve))
  mcp.oninitialized = () => markReady()

  await mcp.connect(new StdioServerTransport())
  log('channel connected over stdio', `permissionRelay=${Boolean(permissionRelay)}`)

  return {
    ready,

    // Pushes a request into the controller session. Claude Code drops the
    // event silently if the session was not started with the channel flag.
    // Extra meta keys become attributes of the <channel> tag.
    async push(request, meta = {}) {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: request.text, meta: { request_id: request.id, ...meta } },
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
