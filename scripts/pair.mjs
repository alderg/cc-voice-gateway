#!/usr/bin/env node
// Pairing codes and connections for the connector's OAuth sign-in. Talks to the
// running gateway over its admin socket (.secrets/admin.sock).
//
//   node scripts/pair.mjs               code for the sign-in page (five minutes, one sign-in)
//   node scripts/pair.mjs list          connected clients
//   node scripts/pair.mjs revoke <id>   disconnect one; "revoke all" disconnects every client

import { adminRequest } from '../src/admin.mjs'
import { config } from '../src/config.mjs'

const [command = 'code', arg] = process.argv.slice(2)
const call = (method, path, body) => adminRequest(config.adminSocket, method, path, body)
const when = ms => (ms ? new Date(ms).toLocaleString() : 'never')

try {
  if (command === 'code') {
    const { code, expiresIn } = await call('POST', '/pairing')
    console.log(`Pairing code: ${code}`)
    console.log(`Enter it on the sign-in page within ${expiresIn / 60} minutes. It works for one sign-in.`)
  } else if (command === 'list') {
    const grants = await call('GET', '/grants')
    if (!grants.length) console.log('No connections.')
    for (const g of grants) {
      console.log(`${g.id}  ${g.client}  signed in ${when(g.createdAt)}, last used ${when(g.lastUsedAt)}`)
    }
  } else if (command === 'revoke' && arg) {
    const { revoked } = await call('POST', '/revoke', { id: arg })
    console.log(revoked ? `Revoked ${revoked}. That client has to sign in again.` : `No connection "${arg}".`)
  } else {
    console.log('usage: node scripts/pair.mjs [list | revoke <id> | revoke all]')
    process.exit(2)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
