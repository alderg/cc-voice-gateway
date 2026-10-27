#!/usr/bin/env node
// Prints the shared secret (creates .secrets/token on first use).
//
//   node scripts/token.mjs           token and local test URL
//   node scripts/token.mjs --quiet   token only (for scripts)

import { config, loadToken } from '../src/config.mjs'

const token = loadToken()
if (process.argv.includes('--quiet')) {
  process.stdout.write(token + '\n')
} else {
  console.log(`Token:      ${token}`)
  console.log(`File:       ${config.tokenFile}`)
  console.log(`Local:      http://${config.host}:${config.port}/mcp/${token}`)
  console.log('Public:     scripts/funnel.sh url')
}
