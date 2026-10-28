#!/usr/bin/env node
// Sends one short Telegram message to the driver's chat, if the Telegram
// secrets exist (.secrets/telegram_token and .secrets/telegram_chat_id), and
// otherwise does nothing. scripts/start-controller.sh uses it when the
// watchdog restarts the controller or gives up; it does not need the gateway.
//
//   node scripts/telegram-notify.mjs <text>
//
// Prints one line: "telegram: sent", "telegram: not set up" or
// "telegram: not sent: <reason>" (exit code 1). The token is read here and
// never reaches the command line, the output or a log.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const secrets = process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets')
const api = (process.env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '')

function read(name) {
  try {
    return readFileSync(join(secrets, name), 'utf8').trim()
  } catch {
    return ''
  }
}

const token = read('telegram_token')
const chatId = read('telegram_chat_id')
const text = process.argv.slice(2).join(' ').trim()

if (!token || !chatId) {
  console.log('telegram: not set up')
  process.exit(0)
}
if (!text) {
  console.log('telegram: not sent: no text')
  process.exit(1)
}

try {
  const response = await fetch(`${api}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    signal: AbortSignal.timeout(10000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok !== true) throw new Error(`${response.status} ${body.description ?? response.statusText}`)
  console.log('telegram: sent')
} catch (error) {
  const reason = error.cause?.message ? `${error.message} (${error.cause.message})` : error.message
  console.log(`telegram: not sent: ${reason.split(token).join('<token>')}`)
  process.exit(1)
}
