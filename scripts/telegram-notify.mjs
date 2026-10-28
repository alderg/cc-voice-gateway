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

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTelegram } from '../src/telegram.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const secrets = process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets')

const telegram = loadTelegram({
  tokenFile: join(secrets, 'telegram_token'),
  chatIdFile: join(secrets, 'telegram_chat_id'),
  apiBase: process.env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org',
})
const text = process.argv.slice(2).join(' ').trim()

if (!telegram) {
  console.log('telegram: not set up')
  process.exit(0)
}
if (!text) {
  console.log('telegram: not sent: no text')
  process.exit(1)
}

try {
  await telegram.send(text)
  console.log('telegram: sent')
} catch (error) {
  // The shared Bot API call leaves the token out of its errors.
  console.log(`telegram: not sent: ${error.message}`)
  process.exit(1)
}
