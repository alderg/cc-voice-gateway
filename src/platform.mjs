// What differs between Linux and macOS, in one place: the temporary folders,
// where commands live when a service starts them, and the autostart's name.
// Each function takes the platform as a parameter, so that the tests cover
// both on either.

import { accessSync, constants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The autostart: a systemd user service on Linux, a LaunchAgent on macOS.
export const SERVICE = 'cc-voice-gateway'
export const LAUNCH_AGENT = `com.drawio.${SERVICE}`

// The Tailscale app's command line on macOS, when no tailscale is on the PATH.
export const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

// The temporary folders a worker on this computer may write to. On macOS /tmp
// and /var are symlinks into /private, and the per-user temporary folder is
// under /var/folders/…/T, so each comes in both spellings: a path may arrive
// resolved (pwd -P, realpath) or not.
export function tempFolders({ platform = process.platform, tmp = tmpdir() } = {}) {
  const folders = [tmp, '/tmp', '/var/tmp']
  if (platform === 'darwin') {
    for (const folder of [...folders]) {
      if (/^\/(tmp|var)(\/|$)/.test(folder)) folders.push(`/private${folder}`)
      else if (/^\/private\/(tmp|var)(\/|$)/.test(folder)) folders.push(folder.slice('/private'.length))
    }
  }
  return [...new Set(folders.map(folder => folder.replace(/(.)\/+$/, '$1')))]
}

// The PATH for the autostart and for the setup's checks. On Linux yours. On
// macOS also where Homebrew (/opt/homebrew on Apple silicon, /usr/local on
// Intel), Claude Code's installer (~/.local/bin), Docker Desktop and this
// Node.js put their commands: launchd starts a LaunchAgent with
// /usr/bin:/bin:/usr/sbin:/sbin only, and a Terminal without Homebrew's
// shellenv does not have them either.
export function servicePath({ platform = process.platform, path = process.env.PATH ?? '', home, node = process.execPath }) {
  const dirs = path.split(':').filter(Boolean)
  if (platform === 'darwin') {
    dirs.push(
      node.slice(0, node.lastIndexOf('/')) || '/',
      join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      join(home, '.docker', 'bin'),
      '/Applications/Docker.app/Contents/Resources/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    )
  }
  return [...new Set(dirs)].join(':')
}

// The command's file on the PATH, as a shell would find it; a name with a
// slash as it is; null when it is nowhere.
export function findCommand(name, path) {
  if (!name) return null
  if (name.includes('/')) return name
  for (const dir of String(path ?? '').split(':')) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {
      // not here
    }
  }
  return null
}
