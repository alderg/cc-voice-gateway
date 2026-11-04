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
// While the kill switch is locked, the driver can unlock it here (unlock),
// with a PIN that goes to their Telegram chat (VoiceUnlock in killswitch.mjs):
// the PIN is in no result and no log line, and only this tool takes it.
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
import { PIN_MINUTES, PIN_TRIES, alarmText, emergencyPhrase, offText } from './killswitch.mjs'
import { IpGuard, accessLine } from './ipguard.mjs'
import { clock } from './limits.mjs'

// What the voice AI says, asked for in the car: before send and ask, one
// short line of its own that fits the request, worded freshly each time, and
// at least a short okay after everything the user says. With this it said
// varied, fitting things (the texts of 31 October); with "say nothing before
// send" and "your reply begins with the call" (1 November) it filled the
// moment before the call with one stock phrase. No text names a sentence to
// avoid, in any language: naming one, even as a ban, made the voice AI say it
// more often. One rule per line. askWait and replyWait: how long ask and a
// get_reply wait, in seconds.
const voiceLines = (askWait, replyWait) => [
  "This connector reaches Claude Code sessions running on the user's own computer. The user is usually driving, " +
    'so keep everything you say short.',
  'Never leave the user in silence: they cannot look at the screen, and silence sounds as if they were not heard. ' +
    'Whenever they have said something, say something back at once, at least a short okay in their language, and ' +
    'before every tool call. If you did not understand, ask back instead of staying quiet.',
  'Workflow: send (or ask) -> get_reply, repeated while state is "sent" or "working" (ask waits up to ' +
    `${plural(askWait, 'second')} for a quick answer, each get_reply up to ${plural(replyWait, 'second')}) -> read ` +
    "the answer. Before send or ask, acknowledge in one short line in the user's language that fits the request " +
    'and names what it is about: a task is on its way, a question goes to Claude Code and its answer follows. Word ' +
    'it freshly each time. Claude Code does the work, you pass it on. Between polls tell the user in a few words ' +
    "that it is still running. Relay Claude Code's answers faithfully; you may shorten them but never invent results.",
  'Approvals: read them out and call approve only after the user explicitly said yes or no to that action.',
  'News: results of work Claude Code finished in the background arrive with any call. Read them out too.',
  'Emergency: when the user says "emergency stop" or "kill switch", in any language, call emergency_stop at once, ' +
    'without asking back. An [ALARM] line in any result is read out first.',
]

// The unlock in voice mode, where Telegram is set up for its PIN (byPin): one
// rule more. Which gateway this connector reaches, for a user with several:
// the name, and a standby by the settings, which is known when the connector
// connects.
function voiceInstructions(presence, askWait, replyWait, byPin = false) {
  const lines = voiceLines(askWait, replyWait)
  if (byPin) {
    lines.push(
      'Unlock: when the user asks to unlock the kill switch, call unlock without a pin, read out the reason it gives, ' +
        'and ask for the PIN that went to their Telegram chat; then call unlock with it. Never guess a PIN.',
    )
  }
  if (!presence) return lines.join('\n')
  lines.push(
    `This connector is the gateway ${presence.label}. Every answer starts with a line that names it and says whether ` +
      'it is active; an inactive gateway hands nothing over. With several such connectors, one per computer, call ' +
      'status on each first and use the active one. Switch to another connector only when an answer says "use ' +
      'another connector" (a gateway on standby). ' +
      (byPin
        ? 'A locked kill switch is unlocked at the computer, or with unlock and a PIN from Telegram: tell the user so.'
        : 'A locked kill switch is unlocked only at the computer: tell the user so.'),
  )
  if (presence.standbySetting) {
    lines.push('This gateway is on standby by its settings: it hands nothing over. Use another connector.')
  }
  return lines.join('\n')
}

const RELAY_RULE =
  "Use it for anything about the user's projects, code, computer or running Claude Code sessions: " +
  'you cannot see their machine, Claude Code can. Pass the request on instead of answering from your ' +
  'own knowledge or searching the web.'

// What the voice AI says before it hands a request over. No fixed phrase:
// the user may speak any language, and a line that names what goes on fits
// better than one for every request. Never skipped: in a car, silence sounds
// as if the request was not heard. examples: two that fit the tool, in German
// and English, of different shapes.
const ACK_RULE = examples =>
  ' Before the call, always, say one short line to the user in their language that fits this request and names ' +
  'what it is about: for a task, that it is on its way (in the sense of "will do"); for a plain question, that it ' +
  `goes to Claude Code and the answer follows. Word it freshly each time, in your own words, such as ${examples}, ` +
  'not as a fixed phrase. You only pass the request on; Claude Code does the work.'

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

// Approvals the voice client heard that were answered at the computer or in
// the user's Telegram chat since, each once.
const answeredElsewhereLines = store =>
  store
    .takeAnsweredElsewhere()
    .map(
      permission =>
        `Approval ${permission.code} was answered ${permission.status === 'elsewhere' ? 'at the computer' : 'in Telegram'} and is ` +
        'settled; it needs nothing from the user.',
    )

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

// The last line of every result that ends a request (the answer, a question
// back, status): what the voice AI says before the user's next send or ask.
// claude.ai fetches the instructions and tool descriptions only when the
// connector connects, every few hours, but follows a result at once and
// almost word for word. Not while a request runs, nor with an approval, an
// emergency stop or unlock, whose next words are no new request. Names no
// filler.
const NEXT_REQUEST =
  "For the user's next request (not to read out): before send or ask, say its subject in a few of their own words " +
  'and that it goes to Claude Code, e.g. „Die Tests in alpha, geht an Claude Code“.'

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
  lines.push(...answeredElsewhereLines(store))
  // After this, further answers to the request count as news.
  if (request.state === 'done') store.markClosed(request)
  const news = store.takeNews(request)
  if (news.length) lines.push(...describeNews(news))

  if (permissions.length) {
    lines.push(
      'Read the approval to the user and ask: allow or deny? Call approve with the code only after their explicit ' +
        'yes or no.',
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
      lines.push(`Still working. Tell the user briefly and call get_reply again with id=${request.id}.`)
    }
  }
  if ((request.state === 'done' || request.state === 'question') && !permissions.length) lines.push(NEXT_REQUEST)
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

// What unlock answers, by what VoiceUnlock made of the call (killswitch.mjs);
// never the PIN. containers: whether workers run in a container, which stays
// stopped after an unlock.
function unlockText(result, containers = false) {
  switch (result.status) {
    case 'sent':
      return (
        `[unlock=pin-sent minutes=${result.minutes}] ${alarmText(result.state, { short: true })} A new PIN of four ` +
        `digits went to the user's Telegram chat, valid ${result.minutes} minutes. Read the reason to the user, then ask ` +
        'them for the PIN and call unlock with it.'
      )
    case 'unlocked':
      return (
        '[unlock=done] Unlocked: the gateway takes tasks again.' +
        (containers ? ' Workers in a container wait until it is started again at the computer.' : '') +
        ' Tell the user.'
      )
    case 'wrong':
      return (
        `[unlock=wrong left=${result.left}] Wrong PIN, still locked; ${result.left === 1 ? 'one try' : `${result.left} tries`} ` +
        'left. Ask the user to read the PIN again, digit by digit.'
      )
    case 'blocked':
      return (
        (result.now
          ? '[unlock=blocked] Wrong PIN, and that was the last try: '
          : `[unlock=blocked] After ${PIN_TRIES} wrong PINs, `) +
        'unlocking by voice is blocked for this lock; it is unlocked only at the computer now. Tell the user.'
      )
    case 'invalid':
      return (
        '[unlock=invalid] A PIN has four digits; nothing was tried. Ask the user for the four digits from Telegram and ' +
        'call unlock with them.'
      )
    case 'no-pin':
      return (
        '[unlock=no-pin] No PIN is valid for this lock now. Call unlock without a pin, and a new one goes to the ' +
        "user's Telegram chat."
      )
    case 'expired':
      return (
        `[unlock=expired] That PIN has expired, after ${PIN_MINUTES} minutes; still locked. Call unlock without a pin for a ` +
        'new one, then ask the user for it.'
      )
    case 'unsent':
      return (
        `[unlock=unsent] The PIN could not be sent by Telegram (${preview(result.why, 120)}); still locked. Tell the user: ` +
        'try again later, or unlock at the computer.'
      )
    case 'standby':
      return (
        '[unlock=standby] This gateway is in a standby: it unlocks nothing by voice until it is active again. Tell ' +
        'the user.'
      )
    case 'no-telegram':
      return (
        '[unlock=no-telegram] Unlocking by voice needs Telegram for the PIN, and this gateway has no Telegram chat of the ' +
        "user's, so it is unlocked only at the computer. Tell the user."
      )
    case 'unreadable':
      return '[unlock=blocked] The kill switch file cannot be read, so it is unlocked only at the computer. Tell the user.'
    default:
      return '[unlock=none] The kill switch is not locked; there is nothing to unlock. Tell the user.'
  }
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
  if (!permissions.length) lines.push(NEXT_REQUEST)
  return lines.join('\n')
}

// Which connected voice chats (sign-in grants) heard the alarm of a lock.
const alarmed = new Map() // lock id -> Set of grant ids

// One MCP server instance per HTTP request; cheap, and keeps the endpoint stateless.
// unlock: the unlock in voice mode (VoiceUnlock in killswitch.mjs), or null.
function buildVoiceServer(
  store,
  channel,
  config,
  { killswitch = null, grant = null, presence = null, limits = null, night = null, unlock = null } = {},
) {
  // The waits for the Claude usage limit (limits.mjs) and night mode
  // (night.mjs) go with the settings into the reports.
  const settings = limits || night ? { ...config, limits, night } : config
  const askWait = clamp(settings.askWaitSeconds, 1, settings.maxWaitSeconds)
  const replyWait = clamp(settings.defaultWaitSeconds, 1, settings.maxWaitSeconds)
  // Whether Telegram is there for the unlock's PIN.
  const byPin = Boolean(killswitch && unlock?.send)
  const mcp = new McpServer(
    { name: 'claude-code-voice', version: VERSION },
    { instructions: voiceInstructions(presence, askWait, replyWait, byPin) },
  )
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
    const alarm = `[ALARM] ${alarmText(state, { voice: killswitch.byVoice })} Read this to the user first.`
    return { ...result, content: [{ type: 'text', text: [head, alarm, ...rest].join('\n') }, ...result.content.slice(1)] }
  }

  // The emergency stop: locked, or, with the kill switch turned off in the
  // settings, an answer that says so.
  const emergency = reason => {
    const state = killswitch.trip({ trigger: 'voice', reason }) ?? killswitch.state
    if (!state) return text(`[state=off] Emergency stop: ${offText()} Tell the user.`)
    heard(state)
    return text(`[state=locked] Emergency stop. ${alarmText(state, { voice: killswitch.byVoice })} Tell the user it is done.`)
  }

  // An emergency phrase locks the gateway before anything reaches Claude Code;
  // while it is locked, nothing new is handed over. With the switch off, the
  // phrase does not reach Claude Code either.
  const refuse = message => {
    if (killswitch && emergencyPhrase(message)) return emergency(`"${preview(message, 80)}" by voice`)
    if (killswitch?.locked) {
      heard(killswitch.state)
      return text(`[state=locked] ${alarmText(killswitch.state, { voice: killswitch.byVoice })} Nothing was handed over. Tell the user.`)
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
            'nothing new starts, until ' +
            (byPin ? 'it is unlocked at the computer, or with unlock.' : 'someone unlocks it at the computer.'),
        ),
        inputSchema: {
          words: z.string().max(400).optional().describe("The user's words, if any."),
        },
        annotations: { destructiveHint: true },
      },
      withLine(async ({ words }) => emergency(words ? `"${preview(words, 80)}" by voice` : 'emergency_stop by voice')),
    )
  }

  // Only here, and only with the PIN that went to the user's Telegram chat.
  // Without one, a new PIN goes there, and the result names the lock, whose
  // alarm this voice chat has heard then.
  if (killswitch && unlock) {
    mcp.registerTool(
      'unlock',
      {
        title: 'Unlock the kill switch',
        description: named(
          'Unlock the kill switch with a PIN from Telegram, only when the user asks for it. First call it without pin: ' +
            'the result gives the reason it locked, which you read to the user, and a new PIN of four digits goes to the ' +
            `user's Telegram chat, valid ${PIN_MINUTES} minutes. Then ask the user for the PIN and call unlock again with ` +
            `it. Never guess a PIN: ${PIN_TRIES} wrong ones block unlocking by voice for this lock, and then it is ` +
            'unlocked only at the computer.',
        ),
        inputSchema: {
          pin: z
            .string()
            .max(40)
            .optional()
            .describe('The PIN as the user read it out, as digits. Leave it out to have a new one sent.'),
          language: z
            .string()
            .max(20)
            .optional()
            .describe("The user's language, such as de or en, for the message with the PIN."),
        },
        annotations: { destructiveHint: true },
      },
      withLine(withAlarm(async ({ pin, language }) => {
        const state = killswitch.state
        if (!state) return text(unlockText({ status: 'not-locked' }))
        const result = pin?.trim()
          ? unlock.attempt(pin)
          : await unlock.request({ german: /^(de|ger|deu)/i.test(String(language ?? '').trim()) })
        if (result.status === 'sent') heard(state)
        return text(unlockText(result, unlock.stopped.length > 0))
      })),
    )
  }

  mcp.registerTool(
    'send',
    {
      title: 'Send to Claude Code',
      description: named(
        "Send the user's request to Claude Code on their computer. " +
          RELAY_RULE +
          ' Returns immediately with an id; then call get_reply with that id until state is done or question.' +
          ACK_RULE('"Ich gebe den Abgleich der Branches an Claude Code weiter" or "The README fix is on its way"'),
      ),
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
      // An acknowledgement before the call is enough: a second one right after
      // it sounds superfluous.
      const held = heldText(settings)
      return text(
        `[state=sent id=${request.id}${held ? ' held=usage' : ''}] Handed over${question ? ` as the answer to ${question.id}` : ''}. ` +
          (held
            ? `${held} Then call get_reply with id=${request.id}.`
            : `If you have acknowledged the request already, call get_reply with id=${request.id} now; otherwise ` +
              'say a short okay in their language first.'),
      )
    })),
  )

  mcp.registerTool(
    'ask',
    {
      title: 'Ask Claude Code',
      description: named(
        `Send a short question to Claude Code and wait up to ${plural(askWait, 'second')} for the answer in one ` +
          'call. ' +
          RELAY_RULE +
          ' If the result says state=sent or working, continue with get_reply and the returned id; never call ask ' +
          'again for the same request, that would send it twice.' +
          ACK_RULE('"Ich frage Claude Code nach den Tests" or "Asking Claude Code whether the build is green"'),
      ),
      inputSchema: {
        message: z.string().min(1).max(4000).describe(MESSAGE_DESCRIPTION),
      },
    },
    withLine(withAlarm(async ({ message }, extra) => {
      const refused = refuse(message)
      if (refused) return refused
      const request = await enqueue(message)
      return waitAndReport(store, request, askWait, extra.signal, settings)
    })),
  )

  mcp.registerTool(
    'get_reply',
    {
      title: 'Get reply',
      description: named(
        'Wait for news on a request sent with send or ask, then return what Claude Code said since the last call. ' +
          'After the line about the gateway, a machine-readable line follows: [state=... id=...]. state=sent or ' +
          'working: tell the user briefly, in a few varied words of their language, that Claude Code is still on it, ' +
          'and call get_reply again with the same id. state=question: read the question and send the answer with ' +
          'send (in_reply_to=id), then follow the new id. state=done: read the answer. If an approval is listed, ask ' +
          'the user before calling approve.',
      ),
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
          'Answer a permission prompt from Claude Code, for example running a shell command or writing a file. ' +
            'Only call this after you read the request to the user and they explicitly said yes (allow) or no ' +
            '(deny) to this specific action. Never approve on your own. Before the call, confirm their decision in ' +
            'a few words of their language.',
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
        // Answered in the user's Telegram chat (telegram.mjs).
        if (known && known.status !== 'open' && known.by === 'telegram') {
          return text(
            `[approval=telegram code=${known.code}] Already ${known.status === 'allow' ? 'allowed' : 'denied'} in Telegram; ` +
              'nothing to do. Tell the user in a few words.',
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
// (standby.mjs). unlock: the unlock in voice mode (killswitch.mjs).
export function startVoiceHttp(
  store,
  channel,
  auth,
  settings,
  {
    killswitch = null,
    onPortBusy = null,
    guard = new IpGuard(),
    presence = null,
    standby = null,
    limits = null,
    night = null,
    unlock = null,
  } = {},
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

    const mcp = buildVoiceServer(store, channel, settings, { killswitch, grant, presence, limits, night, unlock })
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
