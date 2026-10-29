// Worktrees: where the further runs of a repository work, when
// VOICE_GW_MAX_WORKERS_PER_REPO lets more than one run there at a time
// (workers.mjs). The first run of a repository works in its checkout, as
// always; every further one in a git worktree of its own, at
// <repositories folder>/.voice-worktrees/<repository>/<id>, the id being the
// task that made it. The dot keeps the folder from being listed as a
// repository, and it lies outside every checkout. Through the runner, so the
// same on this computer and in the worker container.
//
// A worktree starts on a detached HEAD at the branch the repository's
// checkout would start from, as origin has it after a fetch just now; a
// follow-up that finds its worktree removed gets it again at the same path,
// on the branch its last run ended on, so that its Claude session (kept by
// the folder's path) continues. Submodules are initialised from the
// checkout's own modules where it has them, a local clone that downloads
// nothing; where it does not, as a shallow clone of the one commit needed.
// A worktree is removed once a run there has ended with nothing uncommitted
// and nothing unpushed (Workers.tidy); git worktree remove needs --force for
// one with submodules, so the gateway checks first.

import { posix } from 'node:path'
import { preview } from './log.mjs'

export const WORKTREES = '.voice-worktrees'

const FETCH_MS = 5 * 60 * 1000 // fetching the start branch
const LOCAL_MS = 5 * 60 * 1000 // a submodule from the checkout's own module
const NETWORK_MS = 20 * 60 * 1000 // a submodule from its URL, shallow

// Where the worktree of a run is, as the runner reaches it.
export const worktreeDir = (runner, repo, id) => runner.dir(posix.join(WORKTREES, repo, id))

// The folder that holds the worktrees of a repository.
export const worktreesOf = (runner, repo) => runner.dir(posix.join(WORKTREES, repo))

// A URL git can clone from without the superproject to resolve it.
const absoluteUrl = url => /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/:]+@[^/:]+:|\/)/i.test(url ?? '')

const firstLine = text =>
  String(text ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1) ?? ''

// git in the runner with a time limit and the run's marks, so that stopping
// the run reaches it: { ok, stdout, stderr }.
const gitIn = (runner, dir, args, { env = {}, timeout = 60000 } = {}) => runner.gitRun(dir, args, { env, timeout })

// Whether dir is the top of a git work tree (a checkout, a worktree or an
// initialised submodule), not a folder inside another one.
export async function isTop(runner, dir) {
  const { ok, stdout } = await gitIn(runner, dir, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])
  if (!ok) return false
  const [inside, prefix = ''] = stdout.split('\n')
  return inside.trim() === 'true' && prefix.trim() === ''
}

// The worktrees git knows of in a checkout: [{ dir, head, branch }], the
// checkout itself first.
export async function listWorktrees(runner, main) {
  const { ok, stdout } = await gitIn(runner, main, ['worktree', 'list', '--porcelain'])
  if (!ok) return []
  const found = []
  for (const block of stdout.split('\n\n')) {
    const entry = {}
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ')
      if (key === 'worktree') entry.dir = rest.join(' ')
      else if (key === 'HEAD') entry.head = rest[0]
      else if (key === 'branch') entry.branch = rest.join(' ').replace(/^refs\/heads\//, '')
    }
    if (entry.dir) found.push({ head: null, branch: null, ...entry })
  }
  return found
}

// The submodules a checkout declares: [{ name, path, url }].
async function submodules(runner, dir) {
  const paths = await gitIn(runner, dir, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  if (!paths.ok) return []
  const list = []
  for (const line of paths.stdout.split('\n').filter(Boolean)) {
    const [key, ...rest] = line.split(' ')
    const name = key.replace(/^submodule\./, '').replace(/\.path$/, '')
    const url = await gitIn(runner, dir, ['config', '-f', '.gitmodules', '--get', `submodule.${name}.url`])
    list.push({ name, path: rest.join(' '), url: url.ok ? url.stdout.trim() : '' })
  }
  return list
}

// One submodule in a new worktree. From the checkout's own module when it is
// initialised there: a local clone, shallow or not as that module is, which
// downloads nothing; the commit the worktree needs is fetched from the
// submodule's URL only if the module lacks it, as one shallow commit. Without
// one in the checkout: a shallow clone from the URL. The URL given with -c
// keeps git from writing it into the repository's config, which the checkout
// shares. Returns { path, how, ok, why }.
async function submodule(runner, { main, dir, sub, env }) {
  const target = posix.join(dir, sub.path)
  const local = posix.join(main, sub.path)
  const fileOk = ['-c', 'protocol.file.allow=always']
  const urlOk = absoluteUrl(sub.url) ? ['-c', `submodule.${sub.name}.url=${sub.url}`] : []
  if (await isTop(runner, local)) {
    const fromLocal = ['-c', `submodule.${sub.name}.url=${local}`]
    let done = await gitIn(runner, dir, [...fileOk, ...fromLocal, 'submodule', 'update', '--init', '--', sub.path], { env, timeout: LOCAL_MS })
    if (!done.ok && sub.url && (await isTop(runner, target))) {
      // The checkout's module lacks the commit: that one commit from the URL.
      const need = await gitIn(runner, dir, ['ls-tree', 'HEAD', '--', sub.path])
      const sha = /\bcommit\s+([0-9a-f]{40,64})\b/.exec(need.stdout ?? '')?.[1]
      if (sha) {
        const fetched = await gitIn(runner, target, ['fetch', '--quiet', '--depth', '1', sub.url, sha], { env, timeout: NETWORK_MS })
        if (fetched.ok) done = await gitIn(runner, dir, [...fileOk, ...fromLocal, 'submodule', 'update', '--', sub.path], { env, timeout: LOCAL_MS })
      }
    }
    // Its origin is the submodule's own again, not the checkout's module.
    if (done.ok && absoluteUrl(sub.url)) await gitIn(runner, target, ['remote', 'set-url', 'origin', sub.url])
    return { path: sub.path, how: 'from the checkout', ok: done.ok, why: done.ok ? null : preview(firstLine(done.stderr), 160) }
  }
  const done = await gitIn(runner, dir, [...urlOk, 'submodule', 'update', '--init', '--depth', '1', '--', sub.path], { env, timeout: NETWORK_MS })
  return { path: sub.path, how: 'shallow from its URL', ok: done.ok, why: done.ok ? null : preview(firstLine(done.stderr), 160) }
}

// A worktree for a run, or the one it had, again: { ok, created, base,
// branch, submodules, error }. main: the repository's checkout; branch: the
// branch to start from, fetched first; again: the branch the worktree's
// last run ended on, checked out again where it is free; remote: whether
// there is an origin to fetch from; env: the run's marks.
export async function makeWorktree(runner, { main, dir, branch = null, again = null, remote = true, env = {} }) {
  if (await isTop(runner, dir)) return { ok: true, created: false, base: null, branch: again, submodules: [] }
  await gitIn(runner, main, ['worktree', 'prune'])
  let fetched = false
  // Not into the submodules: a commit of one that the worktree needs comes
  // as that one shallow commit (submodule), not as everything since.
  const fetch = ['fetch', '--quiet', '--no-recurse-submodules', 'origin', branch]
  if (remote && branch) fetched = (await gitIn(runner, main, fetch, { env, timeout: FETCH_MS })).ok
  const exists = async ref => (await gitIn(runner, main, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok
  let args = null
  let base = null
  if (again && !again.startsWith('(') && (await exists(`refs/heads/${again}`))) {
    const taken = (await listWorktrees(runner, main)).some(w => w.branch === again)
    args = taken ? ['--detach', dir, again] : [dir, again]
    base = again
  }
  if (!args) {
    base = branch && (await exists(`refs/remotes/origin/${branch}`)) ? `origin/${branch}` : branch && (await exists(branch)) ? branch : 'HEAD'
    args = ['--detach', dir, base]
  }
  const added = await gitIn(runner, main, ['worktree', 'add', '--quiet', ...args], { env, timeout: 120000 })
  if (!added.ok) return { ok: false, error: preview(firstLine(added.stderr) || 'git worktree add failed', 200) }
  const list = []
  const subs = (await gitIn(runner, dir, ['ls-files', '--', '.gitmodules'])).stdout?.trim() ? await submodules(runner, dir) : []
  for (const sub of subs) list.push(await submodule(runner, { main, dir, sub, env }))
  const head = await gitIn(runner, dir, ['branch', '--show-current'])
  return { ok: true, created: true, base, fetched, branch: head.ok ? head.stdout.trim() || null : null, submodules: list }
}

// Removes a worktree and what git keeps of it. --force: one with submodules
// cannot go otherwise; the caller has checked that nothing is left in it.
export async function removeWorktree(runner, { main, dir }) {
  const removed = await gitIn(runner, main, ['worktree', 'remove', '--force', dir], { timeout: 120000 })
  await gitIn(runner, main, ['worktree', 'prune'])
  return removed.ok || !(await isTop(runner, dir))
}

// Commits reachable from HEAD that no branch and no remote branch has: they
// would be lost with the worktree. null when git does not answer.
export async function orphans(runner, dir) {
  const { ok, stdout } = await gitIn(runner, dir, ['rev-list', '--max-count=1', 'HEAD', '--not', '--branches', '--remotes'])
  return ok ? stdout.trim() !== '' : null
}

// What the worker reads about its worktree, as lines of its prompt; only for
// runs in a worktree. facts: what inspect found; wt: { dir, base, target,
// created, again, fetched, submodules, resumed, resumedSession }, target
// being the branch it started from, where its pull request goes.
export function worktreeLines(facts, wt, { direct = false } = {}) {
  const lines = []
  const target = (facts.pushDirect || direct ? facts.defaultBranch || wt.target : wt.target || facts.defaultBranch) || 'the default branch'
  const readOnly = facts.access?.level === 'read-only'
  const made = wt.created
    ? wt.again
      ? `made again for this follow-up at the same path, with ${wt.base} checked out as your last run left it`
      : `made for this task from ${wt.base}${wt.fetched ? ', as fetched just now' : ''}, on a detached HEAD`
    : 'as your last run left it'
  lines.push(
    `- Worktree: you work in a git worktree of your own, ${wt.dir}, ${made}. Other workers run in this repository at ` +
      'the same time, in its checkout and in other worktrees: leave them alone, and never check out a branch that one ' +
      'of them has out.',
  )
  if (wt.resumed) {
    lines.push(
      `- Resumed: this task was interrupted (${wt.resumed}) and continues here${wt.resumedSession ? ', in the same session' : ''}. ` +
        'Look at git status and git log first to see how far it got, then finish it.',
    )
  }
  if (facts.pushDirect || direct) {
    lines.push(
      `- Branch: commit here on the detached HEAD; do not switch to ${target}, which the repository's checkout may have ` +
        'out. Stay here at the end; there is no need to switch back.',
    )
  } else {
    lines.push(
      '- Branch: create voice/<short-name> here, or continue on the voice/ branch of this task, and commit there. Stay ' +
        'on it at the end; there is no need to switch back to the starting branch.',
    )
  }
  if (readOnly) {
    lines.push('- Nothing is pushed from here: the branch stays in the clone when the gateway removes the worktree.')
  } else {
    const push = facts.pushDirect || direct ? `git push origin HEAD:${target}` : 'push your branch as the rules say'
    lines.push(
      `- Before you push: git fetch origin, rebase your commits onto origin/${target}, and run the repository's tests. ` +
        'Resolve conflicts yourself: keep the intent of both sides, run the tests, continue the rebase. Push only when ' +
        `the tests pass, then ${push}. If a conflict cannot be resolved or the tests fail after the rebase, do not push: ` +
        'abort the rebase and end by saying why.' +
        (facts.pushDirect || direct ? '' : ' A branch of yours that was pushed before goes up again with git push --force-with-lease, never another.'),
    )
  }
  for (const sub of wt.submodules ?? []) {
    if (!sub.ok) {
      lines.push(
        `- Submodule ${sub.path}: not initialised (${sub.why || 'git failed'}). If you need it: git submodule update ` +
          `--init --depth 1 -- ${sub.path}`,
      )
    }
  }
  lines.push('- The gateway removes this worktree after the run once nothing is left uncommitted or unpushed in it.')
  return lines
}
