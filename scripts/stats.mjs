#!/usr/bin/env node
// The gateway's statistics (src/stats.mjs) from its state file,
// .state/stats.json, without the gateway.
//
//   node scripts/stats.mjs          the last running time in detail, and all time in a line
//   node scripts/stats.mjs --all    all time in detail
//   node scripts/stats.mjs --shutdown --session <pid> [--restart | --why <text>]
//
// --shutdown is for the watchdog in scripts/start-controller.sh, once the
// controller session has ended on purpose: a stop, a quit at the terminal, a
// restart. It sends the message that the gateway is shutting down, with the
// statistics of its running time, to Telegram if set up (as
// telegram-notify.mjs does), and prints one line: "telegram: sent",
// "telegram: not set up", "telegram: not sent: <reason>", or "statistics:
// none …" when no gateway of that session saved any: --session is the
// session's process, the claude whose pid the watchdog keeps, and the
// gateway's parent, which it notes in the file (it saves once as it starts).
// A file of an earlier session, or none at all as when the gateway never
// started, says nothing.
// It waits up to three seconds for the gateway's last save, which marks the
// end of its running time. A crash gets no such message: the watchdog's own
// is the one for it.

import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATS_FILE, detailsLines, overviewText, readStats, shutdownText, totalLine } from '../src/stats.mjs'
import { loadTelegram } from '../src/telegram.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateDir = process.env.VOICE_GW_STATE_DIR || join(ROOT, '.state')
const secrets = process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets')
const file = join(stateDir, STATS_FILE)
const WAIT_MS = 3000

const args = process.argv.slice(2)
const value = name => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? '') : null
}
const sleep = ms => new Promise(done => setTimeout(done, ms))

if (args.includes('--shutdown')) {
  const session = Number(value('--session'))
  const fresh = data => data && (!session || data.session === session)
  let data = readStats(file)
  for (let waited = 0; fresh(data) && !data.current.endedAt && waited < WAIT_MS; waited += 100) {
    await sleep(100)
    data = readStats(file)
  }
  if (!fresh(data)) {
    console.log('statistics: none saved by a gateway of this session')
    process.exit(0)
  }
  const telegram = loadTelegram({
    tokenFile: join(secrets, 'telegram_token'),
    chatIdFile: join(secrets, 'telegram_chat_id'),
    apiBase: process.env.VOICE_GW_TELEGRAM_API || 'https://api.telegram.org',
  })
  if (!telegram) {
    console.log('telegram: not set up')
    process.exit(0)
  }
  const restart = args.includes('--restart')
  const text = shutdownText(data, { host: hostname(), restart, why: restart ? '' : (value('--why') ?? '') })
  try {
    await telegram.send(text)
    console.log('telegram: sent the shutdown message with the statistics')
  } catch (error) {
    // The shared Bot API call leaves the token out of its errors.
    console.log(`telegram: not sent: ${error.message}`)
    process.exit(1)
  }
} else {
  const data = readStats(file)
  if (!data) {
    console.log(`No statistics yet (${file}).`)
    process.exit(0)
  }
  const allTime = args.includes('--all')
  const p = allTime ? data.total : data.current
  const ended = data.current.endedAt ? 'ended' : `saved ${new Date(data.savedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`
  console.log(allTime ? 'All time:' : `The last running time (${ended}):`)
  console.log(overviewText(p, { you: true, allTime }))
  console.log('')
  for (const line of detailsLines(p, { allTime, total: data.total })) console.log(line)
  if (!allTime) console.log(`\n${totalLine(data.total)}`)
}
