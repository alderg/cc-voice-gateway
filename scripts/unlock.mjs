#!/usr/bin/env node
// Unlocks the kill switch, the only way there is: on the server, at its
// terminal. Shows what locked it and asks you to type "unlock".
//
//   node scripts/unlock.mjs            show the lock, confirm, unlock
//   node scripts/unlock.mjs --status   only show it
//   node scripts/unlock.mjs --yes      unlock without asking
//
// With the gateway running, it unlocks through the gateway's admin socket
// (.secrets/admin.sock), so the running gateway takes tasks again at once.
// Without it, it removes .secrets/killswitch.json. Neither the controller (its
// shell runs no scripts), nor a worker container (no .secrets), nor voice or
// Telegram can do this.

import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { adminRequest } from '../src/admin.mjs'
import { config } from '../src/config.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const secrets = process.env.VOICE_GW_SECRETS_DIR || join(ROOT, '.secrets')
const file = join(secrets, 'killswitch.json')
const args = process.argv.slice(2)

let state
try {
  state = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('The kill switch is not locked.')
    process.exit(0)
  }
  state = { trigger: '?', reason: `the file ${file} is unreadable (${error.message})`, at: '?', events: [] }
}

console.log(`The kill switch is locked since ${state.at}, by ${state.trigger}: ${state.reason}`)
for (const event of (state.events ?? []).slice(1)) console.log(`  then, ${event.at}, by ${event.trigger}: ${event.reason}`)
if (args.includes('--status')) process.exit(0)

if (!args.includes('--yes')) {
  if (!process.stdin.isTTY) {
    console.error('Run it at the terminal to confirm, or with --yes.')
    process.exit(2)
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question('Anything already pushed stays pushed. Type "unlock" to unlock: ')
  prompt.close()
  if (answer.trim() !== 'unlock') {
    console.log('Still locked.')
    process.exit(1)
  }
}

try {
  const result = await adminRequest(join(secrets, 'admin.sock'), 'POST', '/unlock', { by: 'scripts/unlock.mjs' })
  rmSync(file, { force: true })
  console.log(result.unlocked ? 'Unlocked: the gateway takes tasks again.' : 'Unlocked.')
} catch (error) {
  if (!/not running/.test(error.message)) {
    console.error(`Not unlocked: ${error.message}`)
    process.exit(1)
  }
  rmSync(file, { force: true })
  console.log('Unlocked. The gateway was not running; it starts unlocked.')
}
// The lock stops the worker container; without one, there is nothing to start.
if (config.docker) {
  console.log(`The worker container ${config.docker} stays stopped: start it again with scripts/start-workers-container.sh.`)
}
