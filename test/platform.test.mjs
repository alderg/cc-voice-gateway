// What differs between Linux and macOS (src/platform.mjs), for both platforms
// on either: the temporary folders workers may write to, the PATH for the
// autostart and the setup's checks, and finding a command on it.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LAUNCH_AGENT, SERVICE, findCommand, servicePath, tempFolders } from '../src/platform.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'vgw-platform-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

test('the autostart\'s names', () => {
  assert.equal(SERVICE, 'cc-voice-gateway')
  assert.equal(LAUNCH_AGENT, 'com.drawio.cc-voice-gateway')
})

test('temporary folders: on Linux as they are; on macOS also through /private, both ways', () => {
  assert.deepEqual(tempFolders({ platform: 'linux', tmp: '/tmp' }), ['/tmp', '/var/tmp'])
  assert.deepEqual(tempFolders({ platform: 'linux', tmp: '/run/user/1000/tmp/' }), ['/run/user/1000/tmp', '/tmp', '/var/tmp'])
  // os.tmpdir() on macOS: the per-user folder, unresolved; /tmp and /var are symlinks into /private.
  const mac = '/var/folders/k8/3k1vx1yd0gq_5bk3vymn1bz80000gn/T'
  assert.deepEqual(tempFolders({ platform: 'darwin', tmp: `${mac}/` }), [
    mac,
    '/tmp',
    '/var/tmp',
    `/private${mac}`,
    '/private/tmp',
    '/private/var/tmp',
  ])
  // Resolved already, as with TMPDIR=$(realpath …): the short spelling too.
  assert.ok(tempFolders({ platform: 'darwin', tmp: `/private${mac}` }).includes(mac))
  // Never a folder that is not temporary.
  assert.ok(!tempFolders({ platform: 'darwin', tmp: mac }).some(folder => ['/', '/private', '/var', '/private/var'].includes(folder)))
})

test('the service PATH: yours on Linux; on macOS also Homebrew, the installers and this Node.js, each once', () => {
  assert.equal(servicePath({ platform: 'linux', path: '/usr/bin:/bin', home: '/home/me' }), '/usr/bin:/bin')
  const mac = servicePath({ platform: 'darwin', path: '/usr/bin:/bin:/opt/homebrew/bin', home: '/Users/me', node: '/Users/me/.nvm/versions/node/v22.0.0/bin/node' })
  const dirs = mac.split(':')
  assert.deepEqual(dirs.slice(0, 3), ['/usr/bin', '/bin', '/opt/homebrew/bin'], 'yours first, in your order')
  for (const dir of ['/Users/me/.nvm/versions/node/v22.0.0/bin', '/Users/me/.local/bin', '/usr/local/bin', '/opt/homebrew/sbin', '/sbin']) {
    assert.ok(dirs.includes(dir), dir)
  }
  assert.equal(new Set(dirs).size, dirs.length, 'no folder twice')
  assert.ok(dirs.indexOf('/opt/homebrew/bin') < dirs.indexOf('/usr/local/bin'), 'Apple silicon before Intel')
  // launchd's own PATH alone still finds Homebrew and node.
  assert.ok(servicePath({ platform: 'darwin', path: '', home: '/Users/me', node: '/opt/homebrew/bin/node' }).startsWith('/opt/homebrew/bin:'))
})

test('findCommand: the first executable file on the PATH; a path as it is; null when nowhere', () => {
  const a = join(TMP, 'a')
  const b = join(TMP, 'b')
  mkdirSync(join(a, 'tmux'), { recursive: true }) // a folder of that name does not count
  mkdirSync(b, { recursive: true })
  writeFileSync(join(b, 'tmux'), '#!/bin/sh\n')
  chmodSync(join(b, 'tmux'), 0o755)
  writeFileSync(join(a, 'plain'), 'not executable')
  assert.equal(findCommand('tmux', `${a}::${b}`), join(b, 'tmux'))
  assert.equal(findCommand('plain', a), null, 'not executable')
  assert.equal(findCommand('nothing-like-this', `${a}:${b}`), null)
  assert.equal(findCommand('/opt/homebrew/bin/tmux', ''), '/opt/homebrew/bin/tmux')
  assert.equal(findCommand('node', dirname(process.execPath)), process.execPath.replace(/[^/]+$/, 'node'))
})
