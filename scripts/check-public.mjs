#!/usr/bin/env node
// Checks the gateway through the public Funnel relays, the way Claude's servers
// reach it, and retries while the certificate and the relays come up.
//
//   node scripts/check-public.mjs <host> [port] [seconds]
//
// The host name itself is no good for this check from here: inside the tailnet
// it resolves to this machine, where another web server may answer on 443.

import { Resolver } from 'node:dns/promises'
import { request } from 'node:https'

const [host, port = '443', seconds = '120'] = process.argv.slice(2)
if (!host) {
  console.error('usage: node scripts/check-public.mjs <host> [port] [seconds]')
  process.exit(2)
}
const resolver = new Resolver()
resolver.setServers(['1.1.1.1', '8.8.8.8'])
const deadline = Date.now() + Number(seconds) * 1000

function healthz(address) {
  return new Promise(resolve => {
    const req = request(
      {
        host: address,
        servername: host,
        port: Number(port),
        path: '/healthz',
        headers: { host: port === '443' ? host : `${host}:${port}` },
        timeout: 10000,
      },
      res => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

for (;;) {
  const addresses = await resolver.resolve4(host).catch(() => [])
  const answering = (await Promise.all(addresses.map(healthz))).filter(Boolean).length
  if (addresses.length && answering === addresses.length) {
    console.log(`Public check: all ${answering} Funnel relays answer.`)
    process.exit(0)
  }
  if (Date.now() > deadline) {
    console.error(
      addresses.length
        ? `Public check: ${answering} of ${addresses.length} Funnel relays answer so far; the rest usually follow within minutes.`
        : 'Public check: the name does not resolve publicly yet. On the first start that can take up to ten minutes.',
    )
    process.exit(1)
  }
  await new Promise(resolve => setTimeout(resolve, 5000))
}
