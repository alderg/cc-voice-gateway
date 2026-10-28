// Local administration of the OAuth sign-in over a Unix socket in .secrets/:
// pairing codes, the list of connections, revoking them, and tokens for local
// tools such as fake-voice. Also the only way to unlock the kill switch
// (scripts/unlock.mjs): the controller's shell cannot reach the socket, the
// container does not have it, and voice and Telegram have no route to it. The folder is mode 0700, so only processes of the
// same user reach the socket, and the tunnel never exposes it.
//
// The server runs inside the gateway; scripts/pair.mjs and fake-voice use
// adminRequest() as the client.

import { createServer, request } from 'node:http'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { readBody, sendJson } from './http.mjs'
import { log } from './log.mjs'

function socketInUse(path) {
  return new Promise(resolve => {
    const socket = connect(path)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

export async function startAdmin(auth, socketPath, { killswitch = null } = {}) {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  if (existsSync(socketPath)) {
    if (await socketInUse(socketPath)) {
      log('admin socket in use (is another gateway running?):', socketPath)
      return null
    }
    unlinkSync(socketPath) // left over from a gateway that was killed
  }

  const server = createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? JSON.parse((await readBody(req, 4096)) || '{}') : {}
      const route = `${req.method} ${req.url}`
      if (route === 'POST /pairing') return sendJson(res, 200, auth.newPairingCode())
      if (route === 'GET /grants') return sendJson(res, 200, auth.listGrants())
      if (route === 'POST /revoke') return sendJson(res, 200, { revoked: auth.revoke(String(body.id ?? '')) })
      if (route === 'POST /token') return sendJson(res, 200, auth.issueLocal(body.name))
      if (route === 'GET /killswitch') return sendJson(res, 200, { locked: Boolean(killswitch?.locked), state: killswitch?.state ?? null })
      if (route === 'POST /unlock' && killswitch) {
        const was = killswitch.unlock({ by: String(body.by ?? 'scripts/unlock.mjs').slice(0, 80) })
        return sendJson(res, 200, { unlocked: Boolean(was), was })
      }
      sendJson(res, 404, { error: 'unknown command' })
    } catch (error) {
      sendJson(res, 400, { error: error.message })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  chmodSync(socketPath, 0o600)
  server.on('close', () => {
    try {
      unlinkSync(socketPath)
    } catch {
      // already gone
    }
  })
  return server
}

export function adminRequest(socketPath, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (data += chunk))
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data))
        else reject(new Error(`Gateway answered ${res.statusCode}: ${data}`))
      })
    })
    req.on('error', error => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        reject(new Error('The gateway is not running. Start the controller with scripts/start-controller.sh.'))
      } else {
        reject(error)
      }
    })
    req.end(body ? JSON.stringify(body) : undefined)
  })
}
