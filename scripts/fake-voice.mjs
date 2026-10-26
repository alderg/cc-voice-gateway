#!/usr/bin/env node
// Plays the voice assistant at the desk: talks to the gateway's HTTP endpoint
// exactly like Claude voice mode or Grok would, so the whole chain can be
// tested before sitting in the car.
//
//   node scripts/fake-voice.mjs                     local endpoint (127.0.0.1)
//   node scripts/fake-voice.mjs https://…/mcp/…     through the tunnel
//
// Commands:
//   status                 gateway and controller status
//   ask <text>             send and wait in one call
//   send <text>            send, then follow with get_reply until done/question
//   answer <text>          answer the last question (send with in_reply_to)
//   allow <code>           approve a permission prompt
//   deny <code>            reject a permission prompt
//   quit

import { createInterface } from 'node:readline/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { config, loadToken } from '../src/config.mjs'

const url = new URL(process.argv[2] || `http://${config.host}:${config.port}/mcp/${loadToken()}`)
const shownUrl = url.href.replace(/\/mcp\/[^/?]+/, '/mcp/…')

const client = new Client({ name: 'fake-voice', version: '0.1.0' })
try {
  await client.connect(new StreamableHTTPClientTransport(url))
} catch (error) {
  console.error(`Keine Verbindung zu ${shownUrl}: ${error.message}`)
  console.error('Läuft die Controller-Session (scripts/start-controller.sh)? Stimmt das Token?')
  process.exit(1)
}
console.log(`Verbunden mit ${shownUrl}. Befehle: status, ask, send, answer, allow, deny, quit`)

let lastId = null
let lastQuestionId = null

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.map(c => c.text).join('\n')
  return { text, isError: result.isError }
}

const stateOf = text => /^\[state=([a-z]+)/.exec(text)?.[1]

// Returns true if the caller should keep polling: still running and no approval waiting.
function keepPolling(id, text) {
  const state = stateOf(text)
  if (state === 'question') lastQuestionId = id
  if (state !== 'working' && state !== 'sent') return false
  if (/approval=/.test(text)) {
    console.log('(Freigabe offen: mit allow/deny <code> beantworten, danach "follow")')
    return false
  }
  return true
}

async function follow(id) {
  for (;;) {
    const { text } = await call('get_reply', { id })
    console.log(text + '\n')
    if (!keepPolling(id, text)) return
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
rl.prompt()
// The async iterator buffers lines, so piped input (printf '...' | node ...) works too.
for await (const raw of rl) {
  const line = raw.trim()
  if (!line) {
    rl.prompt()
    continue
  }
  const [command, ...rest] = line.split(' ')
  const arg = rest.join(' ').trim()
  if (command === 'quit' || command === 'exit') break
  try {
    switch (command) {
      case 'status':
        console.log((await call('status')).text + '\n')
        break
      case 'ask': {
        const { text } = await call('ask', { message: arg })
        console.log(text + '\n')
        lastId = /id=([a-z0-9]+)/.exec(text)?.[1] ?? lastId
        if (keepPolling(lastId, text)) await follow(lastId)
        break
      }
      case 'send':
      case 'answer': {
        const args = { message: arg }
        if (command === 'answer' && lastQuestionId) args.in_reply_to = lastQuestionId
        const { text } = await call('send', args)
        console.log(text + '\n')
        lastId = /id=([a-z0-9]+)/.exec(text)?.[1]
        await follow(lastId)
        break
      }
      case 'follow':
        await follow(arg || lastId)
        break
      case 'allow':
      case 'deny':
        console.log((await call('approve', { code: arg, decision: command })).text + '\n')
        break
      default:
        console.log('Befehle: status, ask <text>, send <text>, answer <text>, follow [id], allow <code>, deny <code>, quit')
    }
  } catch (error) {
    console.error(`Fehler: ${error.message}`)
  }
  rl.prompt()
}
rl.close()
await client.close()
process.exit(0)
