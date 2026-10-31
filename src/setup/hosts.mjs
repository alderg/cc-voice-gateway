// The sign-in on the gateway's own computer (setup page, section 10).
//
// The Claude app reaches the gateway through the Funnel's public relays. A
// browser on the gateway's computer that opens the tailnet name reaches that
// computer itself instead: where another web server holds port 443 it gets
// that server, and on macOS the Tailscale app's network extension takes no
// port below 1024 on the tailnet address, so the connection is refused. Only
// the one-time sign-in in a browser there is affected.
//
// So, once the Funnel is on, the setup asks this computer for the gateway's
// sign-in metadata under the tailnet name, as that browser would (signInCheck).
// If what answers is not the gateway, the page offers to prepare the sign-in:
// one marked line in /etc/hosts that sends the tailnet name to one of the
// Funnel's public addresses, from a public resolver, not MagicDNS. It goes in
// with administrator rights (asAdmin: on macOS the system's password dialog
// through osascript, on Linux pkexec or sudo -n where they work, otherwise the
// exact command for the terminal), with a backup next to the file, and only
// that line is ever added or removed, by an exact match. The setup removes it
// once the pairing code is used, when the page or the assistant ends, and on
// "Remove it now".

import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { findCommand } from '../platform.mjs'

// The end of every line the setup adds, so that it finds them again, also
// those of an assistant that ended before it could remove them.
export const HOSTS_MARK = '# cc-voice-gateway setup: for the sign-in on this computer, removed again by itself'

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
const SAFE_PATH = /^\/[\w./-]+$/

export function hostsLine(address, host) {
  if (!IPV4.test(address) || !HOST.test(host)) throw new Error(`not an address and a host name: ${address} ${host}`)
  return `${address} ${host} ${HOSTS_MARK}`
}

// The setup's lines in the hosts file: [{ line, address, host }], exactly as
// it writes them; none when the file cannot be read.
export function markedLines(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.endsWith(` ${HOSTS_MARK}`))
    .map(line => {
      const [address, host] = line.split(' ')
      return { line, address, host }
    })
    .filter(({ line, address, host }) => IPV4.test(address) && HOST.test(host) && line === `${address} ${host} ${HOSTS_MARK}`)
}

// A string in single quotes for sh; the lines and paths here have none.
const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`

// The shell command, run as root, that takes the given lines out of the
// file by an exact match and adds one, after a backup next to it; the rest
// of the file stays as it is, in place (its owner and mode too). On macOS
// the resolver's cache is flushed after it.
export function hostsCommand(file, { remove = [], add = null, platform = 'linux' } = {}) {
  if (!SAFE_PATH.test(file)) throw new Error(`not a plain path: ${file}`)
  const f = quote(file)
  const steps = [`cp -p ${f} ${quote(`${file}.cc-voice-gateway.bak`)} || exit 1`]
  if (remove.length) {
    const patterns = remove.map(line => `-e ${quote(line)}`).join(' ')
    steps.push(
      't=$(mktemp) || exit 1',
      `grep -vxF ${patterns} ${f} > $t; [ $? -le 1 ] && cat $t > ${f}; s=$?; rm -f $t; [ $s = 0 ] || exit 1`,
    )
  }
  if (add) {
    steps.push(
      `grep -qxF -e ${quote(add)} ${f} || { [ -z "$(tail -c 1 ${f})" ] || echo >> ${f}; printf '%s\\n' ${quote(add)} >> ${f}; } || exit 1`,
    )
  }
  const main = `(${steps.join('; ')})`
  return platform === 'darwin' ? `${main} && { /usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder; true; }` : main
}

// An AppleScript string.
const appleScript = text => `"${String(text).replace(/[\\"]/g, '\\$&')}"`

// Runs a command as root: on macOS with the system's password dialog, on
// Linux with pkexec (a password dialog where a desktop session has a polkit
// agent) or sudo -n (where no password is needed). { ok, how } or, when none
// of them worked, { ok: false, command }: what to run in a terminal.
// run(command, args): the exit code.
export async function asAdmin(command, { platform, bin, path, run }) {
  if (platform === 'darwin') {
    const code = await run(bin.osascript, ['-e', `do shell script ${appleScript(command)} with administrator privileges`])
    if (code === 0) return { ok: true, how: 'the system\'s password dialog' }
  } else {
    for (const [tool, args] of [
      [bin.pkexec, ['sh', '-c', command]],
      [bin.sudo, ['-n', 'sh', '-c', command]],
    ]) {
      if (!findCommand(tool, path)) continue
      if ((await run(tool, args)) === 0) return { ok: true, how: tool.split('/').pop() }
    }
  }
  return { ok: false, command: `sudo sh -c ${quote(command)}` }
}

// Whether the gateway's own sign-in metadata answers under the connector's
// URL from this computer, as a browser here would get it: no connection
// kept, the system's resolver and Node's certificate check. { ok } or
// { ok: false, why }: refused, certificate, other (another server's answer),
// unreachable.
export function signInCheck(url) {
  const origin = String(url).replace(/\/mcp$/, '')
  return new Promise(resolve => {
    const req = request(`${origin}/.well-known/oauth-authorization-server`, { agent: false, timeout: 5000 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (body = (body + chunk).slice(0, 65536)))
      res.on('end', () => {
        let data = null
        try {
          data = res.statusCode === 200 ? JSON.parse(body) : null
        } catch {
          data = null
        }
        const ours = data?.issuer === origin && data.registration_endpoint === `${origin}/oauth/register`
        resolve(ours ? { ok: true } : { ok: false, why: 'other' })
      })
      res.on('error', () => resolve({ ok: false, why: 'unreachable' }))
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })))
    req.on('error', error => {
      const code = String(error.code ?? '')
      const why = code === 'ECONNREFUSED' ? 'refused' : /CERT|SELF_SIGNED|ERR_TLS|HOSTNAME|ALTNAME/.test(code) ? 'certificate' : 'unreachable'
      resolve({ ok: false, why })
    })
    req.end()
  })
}
