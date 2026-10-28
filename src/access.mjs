// Access levels for workers in the Docker container (see docker/): what the
// GitHub token in .secrets/worker/github_token lets them do with a
// repository. The driver chooses the level through the token they hand over:
//
//   read-only  no token, or one that cannot push or open pull requests:
//              everything stays in the container, workers never push
//   pr         the token can push and open pull requests, and the default
//              branch is protected (branch protection or a ruleset): workers
//              push a voice/ branch and open a draft pull request
//   full       as pr, but the default branch is not protected: still a pull
//              request by default, a direct push only when the driver asks
//
// The gateway checks each repository with the GitHub API, or takes the level
// from VOICE_GW_ACCESS. Whatever it cannot tell counts as the lower level.
// The token never reaches a log line or an error message.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const ACCESS_LEVELS = ['read-only', 'pr', 'full']

const CACHE_MS = 10 * 60 * 1000
const RETRY_MS = 60 * 1000 // after the API failed
const TIMEOUT_MS = 10000

// Ruleset rules that keep a direct push off a branch.
const BLOCKING_RULES = ['pull_request', 'update', 'required_status_checks', 'merge_queue']

const fingerprint = token => createHash('sha256').update(token).digest('hex').slice(0, 12)

export class GitHubAccess {
  // token: a fixed token instead of the file, for the setup assistant.
  constructor({ tokenFile, token = null, apiBase = 'https://api.github.com', forced = '' }) {
    this.tokenFile = tokenFile
    this.fixedToken = token
    this.apiBase = apiBase.replace(/\/+$/, '')
    this.forced = ACCESS_LEVELS.includes(forced) ? forced : ''
    this.cache = new Map() // "owner/repo fingerprint" -> { at, ttl, result }
  }

  // Read at every check, so that a new token counts without a restart.
  token() {
    if (this.fixedToken !== null) return this.fixedToken
    try {
      return readFileSync(this.tokenFile, 'utf8').trim()
    } catch {
      return ''
    }
  }

  // { level, reason, visibility, branch } for a repository. slug is
  // owner/repo for a GitHub remote, otherwise null. visibility and branch are
  // null where the API was not asked.
  async check(slug) {
    const result = (level, reason) => ({ level, reason, visibility: null, branch: null })
    if (this.forced) return result(this.forced, 'set by VOICE_GW_ACCESS')
    if (!slug) return result('read-only', 'no GitHub remote')
    const token = this.token()
    if (!token) return result('read-only', 'no GitHub token')

    const key = `${slug} ${fingerprint(token)}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < cached.ttl) return cached.result
    let checked
    let ttl = CACHE_MS
    try {
      checked = await this.detect(slug, token)
    } catch (error) {
      checked = result('read-only', `GitHub API not reachable: ${error.message.split(token).join('<token>')}`)
      ttl = RETRY_MS
    }
    this.cache.set(key, { at: Date.now(), ttl, result: checked })
    return checked
  }

  async request(token, method, path, body) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cc-voice-gateway',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: response.status, data: await response.json().catch(() => null) }
  }

  async detect(slug, token) {
    const repo = await this.request(token, 'GET', `/repos/${slug}`)
    if (repo.status === 401) return { level: 'read-only', reason: 'GitHub rejected the token', visibility: null, branch: null }
    if (repo.status !== 200) {
      return { level: 'read-only', reason: `the token cannot see the repository (${repo.status})`, visibility: null, branch: null }
    }
    const visibility = repo.data.visibility ?? (repo.data.private ? 'private' : 'public')
    const branch = repo.data.default_branch || 'main'
    const level = (name, reason) => ({ level: name, reason, visibility, branch })

    // The account's own permission first; a fine-grained token can have less.
    if (!repo.data.permissions?.push) return level('read-only', 'the account cannot push to it')
    // Write requests without content: 422 means the token may write, 403 or
    // 404 that it may not. Neither creates anything.
    const refs = await this.request(token, 'POST', `/repos/${slug}/git/refs`, {})
    if (refs.status !== 422) return level('read-only', 'the token cannot push (Contents is read-only)')
    const pulls = await this.request(token, 'POST', `/repos/${slug}/pulls`, {})
    if (pulls.status !== 422) return level('read-only', 'the token cannot open pull requests')

    const name = encodeURIComponent(branch)
    const [classic, rules] = await Promise.all([
      this.request(token, 'GET', `/repos/${slug}/branches/${name}`),
      this.request(token, 'GET', `/repos/${slug}/rules/branches/${name}`),
    ])
    if (classic.status !== 200) return level('pr', `could not tell whether ${branch} is protected`)
    if (classic.data?.protected) return level('pr', `${branch} is protected by branch protection`)
    // 403 or 404: rulesets are not available for this repository, for
    // example a private one without GitHub Pro, so none applies.
    if (rules.status === 200) {
      if ((Array.isArray(rules.data) ? rules.data : []).some(rule => BLOCKING_RULES.includes(rule.type))) {
        return level('pr', `${branch} is protected by a ruleset`)
      }
    } else if (rules.status !== 403 && rules.status !== 404) {
      return level('pr', `could not tell whether ${branch} is protected`)
    }
    return level('full', `${branch} is not protected`)
  }
}
