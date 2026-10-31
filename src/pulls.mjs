// Pull requests that workers open: the gateway watches them with gh for the
// results that come without anyone asking, automatic checks and reviews, and
// tells the controller as news. The driver is not asked anything.
//
// Which pull requests: those a run names by URL for its own repository, in
// its tool output or its result, if gh shows them open on a voice/ branch,
// opened by the account gh is logged in as, from a branch of the repository
// itself. A fork can name its branch voice/ too, and anyone can open a pull
// request on a public repository; those are not watched.
// Whether results will come is not guessed from the repository's settings;
// the watcher looks: checks on the head commit (GitHub Actions and other CI),
// requested reviewers (CODEOWNERS, required reviewers, a person the driver
// named) or reviews and comments from others (bots such as Copilot or the
// Claude app, people). If none of that shows up within the first polls,
// nothing automatic runs, often because bot reviewers skip drafts, and it
// stops quietly. A later run that names the pull request again, for example
// one that requests a review, starts watching anew. So does a later run that
// pushed to it or marked it ready without naming it: at the end of a run the
// watcher looks again at the last pull requests it watched for that
// repository, and one whose head commit or draft state changed while the run
// went counts as the run's, as automatic reviews and checks run again then.
//
// News: checks finished on a head commit (once per commit), new reviews with
// their inline comments, and new comments. Reviews and comments of the account
// gh is logged in as are what workers post on the driver's behalf; they are
// not news. The text of a review or comment is passed on only from the
// repository's owner, members and collaborators; of anyone else the news names
// the author and says that the text is not forwarded. Even so it is not the
// driver's: the gateway marks it trusted="no" for the controller. Stops when
// the pull request is merged or closed, or after VOICE_GW_PR_WATCH_HOURS.
// Without a gh login it does nothing. It only reads JSON from gh; no token
// passes through it.
//
// Review comments, fixed without asking (VOICE_GW_AUTO_FIX_REVIEWS, on by
// default; autoFix): new inline comments, reviews that request changes or
// say something, and comments, of the repository's owner, members and
// collaborators or of a review bot (bots, VOICE_GW_REVIEW_BOTS), get a fix
// that the watcher queues itself (Workers.reviewFix): a task in the
// gateway's words, naming the pull request and its branch, never what the
// reviews say, as a follow-up of the run that pushed the pull request.
// Anyone else's text starts nothing. The fix pushes, the reviews run again,
// and new comments start the next round, at most autoFix.rounds per pull
// request until a run the driver dispatched works on it again. The news says
// what was queued, or why nothing was, so the controller only relays it.

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log as defaultLog, preview } from './log.mjs'

const GRACE_POLLS = 5 // polls without checks, review requests or reviews before it gives up
const FAST_POLLS = 15 // then every SLOW_FACTOR intervals
const SLOW_FACTOR = 5
const AUTH_CHECK_MS = 10 * 60 * 1000
const KEEP_STOPPED = 50
const RECHECK = 3 // earlier watches of a repository looked at again when a run there ends
const FOREIGN = 'not opened by the gh account from this repository'
const ENDED = ['merged', 'closed', FOREIGN] // no later push can matter
const FIELDS =
  'number,title,state,isDraft,isCrossRepository,author,headRefName,headRefOid,url,statusCheckRollup,reviewRequests,' +
  'reviews,comments'

// Whose words reach the controller: gh pr view gives authorAssociation for
// reviews and comments, the REST API author_association for inline comments.
const COLLABORATORS = ['OWNER', 'MEMBER', 'COLLABORATOR']
const NOT_FORWARDED = 'not a collaborator, the text is not forwarded'
// Whose reviews and comments a fix is queued for, besides collaborators: the
// Claude app, and Copilot's reviewer under both names GitHub gives it.
export const REVIEW_BOTS = ['claude', 'copilot-pull-request-reviewer', 'copilot']

const REVIEW_STATE = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`
const login = name => String(name ?? '').replace(/\[bot\]$/i, '')
const sameLogin = (a, b) => Boolean(a && b) && login(a).toLowerCase() === login(b).toLowerCase()
const collaborator = association => COLLABORATORS.includes(String(association ?? '').toUpperCase())
// Created after a time (ms), or of no known time.
const since = (at, time) => !at || !time || !(Date.parse(time) < at)

// A check run (GitHub Actions, apps) or a commit status (other CI).
const isStatus = check => check.__typename === 'StatusContext' || (!('status' in check) && 'state' in check)
const complete = check => (isStatus(check) ? !['PENDING', 'EXPECTED'].includes(check.state) : check.status === 'COMPLETED')

function outcome(check) {
  if (isStatus(check)) return check.state === 'SUCCESS' ? 'passed' : 'failed'
  if (['SUCCESS', 'NEUTRAL'].includes(check.conclusion)) return 'passed'
  if (['SKIPPED', 'STALE'].includes(check.conclusion)) return 'skipped'
  return 'failed'
}

// The checks' outcomes in numbers, for the statistics.
function checkCounts(checks) {
  const count = what => checks.filter(c => outcome(c) === what).length
  return { passed: count('passed'), failed: count('failed'), skipped: count('skipped') }
}

function describeChecks(checks) {
  const failed = checks.filter(c => outcome(c) === 'failed').map(c => c.name || c.context || 'unnamed')
  const passed = checks.filter(c => outcome(c) === 'passed').length
  const skipped = checks.filter(c => outcome(c) === 'skipped').length
  const parts = [`${passed} passed`]
  if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''})`)
  if (skipped) parts.push(`${skipped} skipped`)
  return `Checks finished on the latest push: ${parts.join(', ')}.`
}

export class PullWatcher extends EventEmitter {
  // autoFix: { rounds, queue(fix) } to fix review comments without asking,
  // queue being Workers.reviewFix; null leaves it to the driver.
  constructor({ ghBin = 'gh', stateFile, pollSeconds = 60, watchHours = 24, autoFix = null, bots = REVIEW_BOTS, log = defaultLog }) {
    super()
    this.ghBin = ghBin
    this.stateFile = stateFile
    this.pollMs = pollSeconds * 1000
    this.watchMs = watchHours * 60 * 60 * 1000
    this.autoFix = autoFix
    this.bots = bots
    this.log = log
    this.auth = null // { at, ok, me }
    this.busy = false
    this.watches = this.load()
    this.timer = setInterval(() => this.tick(), Math.min(5000, Math.max(100, this.pollMs / 4)))
    this.timer.unref()
  }

  close() {
    clearInterval(this.timer)
  }

  // --- state --------------------------------------------------------------

  load() {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')).watches ?? []
    } catch {
      return []
    }
  }

  save() {
    const stopped = this.watches.filter(w => !w.active)
    this.watches = this.watches.filter(w => w.active || stopped.indexOf(w) >= stopped.length - KEEP_STOPPED)
    mkdirSync(dirname(this.stateFile), { recursive: true })
    const tmp = `${this.stateFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ watches: this.watches }, null, 2) + '\n')
    renameSync(tmp, this.stateFile)
  }

  active() {
    return this.watches.filter(w => w.active)
  }

  // --- gh -----------------------------------------------------------------

  gh(args) {
    return new Promise(resolve => {
      execFile(
        this.ghBin,
        args,
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
        (error, stdout) => resolve(error ? null : stdout),
      )
    })
  }

  async json(args) {
    const out = await this.gh(args)
    try {
      return out === null ? null : JSON.parse(out)
    } catch {
      return null
    }
  }

  // Logged in, and as whom; checked every ten minutes.
  async ready() {
    if (this.auth && Date.now() - this.auth.at < AUTH_CHECK_MS) return this.auth.ok
    const me = (await this.gh(['auth', 'status'])) === null ? null : (await this.json(['api', 'user']))?.login
    const ok = typeof me === 'string' && me.length > 0
    if (!ok && this.auth?.ok !== false) this.log('gh is not logged in: pull requests that workers open are not watched')
    this.auth = { at: Date.now(), ok, me: ok ? me : null }
    return ok
  }

  view(slug, number) {
    return this.json(['pr', 'view', String(number), '--repo', slug, '--json', FIELDS])
  }

  // Opened by the gh account, from a branch of the repository itself.
  ours(pr) {
    return pr.isCrossRepository === false && sameLogin(pr.author?.login, this.auth?.me)
  }

  // --- watching -----------------------------------------------------------

  // The pull requests a finished run opened or worked on, as gh shows them:
  // [{ number, title, isDraft, url, opened }], opened when the gateway never
  // watched it before, for the statistics. Starts watching each of them: those
  // it names by URL, and earlier ones of its repository that changed while it
  // went (earlier).
  async fromRun(task) {
    if (!task.slug) return []
    const named = task.pulls ?? []
    const earlier = this.earlier(task, named)
    if ((!named.length && !earlier.length) || !(await this.ready())) return []
    const since = task.startedAt ?? Date.now()
    const found = []
    const add = pr => {
      const opened = !this.watches.some(w => w.key === `${task.slug}#${pr.number}`)
      found.push({ number: pr.number, title: pr.title, isDraft: Boolean(pr.isDraft), url: pr.url, opened })
      this.note(this.watch({ worker: task.repo, slug: task.slug, number: pr.number, title: pr.title, task }), pr)
    }
    for (const number of named) {
      const pr = await this.view(task.slug, number)
      if (!pr || pr.state !== 'OPEN' || !String(pr.headRefName).startsWith('voice/')) continue
      if (!this.ours(pr)) {
        const why = pr.isCrossRepository !== false ? 'from a fork' : `opened by ${login(pr.author?.login) || 'someone else'}`
        this.log('not watching pull request', `${task.slug}#${pr.number}:`, why)
        continue
      }
      add(pr)
    }
    // A push or "ready for review" the run did not name.
    const views = await Promise.all(earlier.map(entry => this.view(entry.slug, entry.number)))
    earlier.forEach((entry, i) => {
      const pr = views[i]
      if (!pr) return
      if (pr.state !== 'OPEN') return this.stop(entry, pr.state === 'MERGED' ? 'merged' : 'closed')
      if (!this.ours(pr)) return this.stop(entry, FOREIGN)
      this.note(entry, pr)
      if (entry.changedAt >= since) add(pr)
    })
    if (found.length || earlier.length) this.save()
    return found
  }

  // The last pull requests watched for the run's repository and worker that
  // it did not name, unless merged, closed or someone else's.
  earlier(task, named) {
    const slug = task.slug.toLowerCase()
    return this.watches
      .filter(w => w.slug.toLowerCase() === slug && w.worker === task.repo && !named.includes(w.number) && !ENDED.includes(w.stopped))
      .slice(-RECHECK)
  }

  // The head commit, its branch and the draft state as last seen, and when
  // the commit or the draft state changed.
  note(entry, pr) {
    const draft = Boolean(pr.isDraft)
    if (entry.head && (entry.head !== pr.headRefOid || entry.draft !== draft)) entry.changedAt = Date.now()
    entry.head = pr.headRefOid
    entry.branch = pr.headRefName ?? entry.branch ?? null
    entry.draft = draft
  }

  // task: the run that opened or worked on it, which a fix continues. One
  // the driver dispatched gives the automatic fixing its rounds again; a fix
  // the gateway queued does not (task.review).
  watch({ worker, slug, number, title, task = null }) {
    const key = `${slug}#${number}`
    let entry = this.watches.find(w => w.key === key)
    if (!entry) {
      // since: what came before the run that started the watch, that run could see.
      const from = task?.startedAt ?? Date.now()
      entry = { key, worker, slug, number, reviews: [], comments: [], inline: [], checked: [], fixes: 0, since: from }
      this.watches.push(entry)
    }
    const now = Date.now()
    Object.assign(entry, { worker, title, active: true, stopped: null, until: now + this.watchMs, polls: 0, quiet: 0, nextAt: now })
    if (task) {
      entry.task = task.id
      if (!task.review) entry.fixes = 0
    }
    this.log('watching pull request', key, `for ${worker}`)
    return entry
  }

  stop(entry, reason) {
    entry.active = false
    entry.stopped = reason
    this.log('stopped watching pull request', entry.key + ':', reason)
  }

  async tick() {
    const due = this.active().filter(w => w.nextAt <= Date.now())
    if (this.busy || !due.length) return
    this.busy = true
    try {
      if (!(await this.ready())) {
        for (const entry of due) entry.nextAt = Date.now() + this.pollMs
        return
      }
      for (const entry of due) await this.poll(entry)
      this.save()
    } catch (error) {
      this.log('pull request watch failed:', error.message)
    } finally {
      this.busy = false
    }
  }

  async poll(entry) {
    entry.polls++
    entry.nextAt = Date.now() + this.pollMs * (entry.polls >= FAST_POLLS ? SLOW_FACTOR : 1)
    if (Date.now() > entry.until) return this.stop(entry, 'time limit')
    const pr = await this.view(entry.slug, entry.number)
    if (!pr) return // gh or GitHub not reachable; again at the next poll
    if (pr.state !== 'OPEN') return this.stop(entry, pr.state === 'MERGED' ? 'merged' : 'closed')
    if (!this.ours(pr)) return this.stop(entry, FOREIGN)
    this.note(entry, pr)

    const own = name => sameLogin(name, this.auth.me)
    const checks = pr.statusCheckRollup ?? []
    const reviews = (pr.reviews ?? []).filter(r => r.state !== 'PENDING' && !own(r.author?.login))
    const comments = (pr.comments ?? []).filter(c => !own(c.author?.login))
    const lines = []
    const kinds = []
    let finished = null // the checks' outcomes, for the statistics

    if (checks.length && checks.every(complete) && pr.headRefOid && !entry.checked.includes(pr.headRefOid)) {
      entry.checked = [...entry.checked, pr.headRefOid].slice(-20)
      lines.push(describeChecks(checks))
      kinds.push('checks')
      finished = checkCounts(checks)
    }
    const newReviews = reviews.filter(r => !entry.reviews.includes(r.id))
    let inline = []
    if (newReviews.length) {
      kinds.push('review')
      entry.reviews = [...entry.reviews, ...newReviews.map(r => r.id)].slice(-200)
      for (const review of newReviews) {
        const state = REVIEW_STATE[review.state] ?? String(review.state).toLowerCase()
        const body = String(review.body ?? '').trim()
        const said = !body ? '' : collaborator(review.authorAssociation) ? `, "${preview(body, 200)}"` : `; ${NOT_FORWARDED}`
        lines.push(`Review from ${login(review.author?.login)}: ${state}${said}.`)
      }
      inline = await this.newInline(entry, own)
      if (inline.length) {
        const shown = inline
          .slice(0, 5)
          .map(c => {
            const where = `${c.path}${c.line ? `:${c.line}` : ''}`
            return collaborator(c.author_association)
              ? `${where} "${preview(c.body, 120)}"`
              : `${where} from ${login(c.user?.login)}, text not forwarded`
          })
          .join('; ')
        lines.push(`${plural(inline.length, 'inline comment')}: ${shown}${inline.length > 5 ? '; …' : ''}.`)
      }
    }
    const newComments = comments.filter(c => !entry.comments.includes(c.id))
    if (newComments.length) {
      kinds.push('comment')
      entry.comments = [...entry.comments, ...newComments.map(c => c.id)].slice(-200)
      for (const comment of newComments) {
        const said = collaborator(comment.authorAssociation) ? `"${preview(comment.body, 200)}"` : NOT_FORWARDED
        lines.push(`Comment from ${login(comment.author?.login)}: ${said}.`)
      }
    }
    // Review comments fixed without asking: a fix queued, or why not.
    const asking = this.autoFix ? this.asking(entry, newReviews, inline, newComments) : []
    const fix = asking.length ? await this.fix(entry, pr, asking) : null
    if (fix) lines.push(fix.line)

    const expected = checks.length || pr.reviewRequests?.length || reviews.length || comments.length
    if (!expected && ++entry.quiet >= GRACE_POLLS) {
      this.stop(entry, pr.isDraft ? 'nothing automatic runs (a draft)' : 'nothing automatic runs')
    }
    if (lines.length) {
      entry.title = pr.title
      this.emit('news', {
        worker: entry.worker,
        slug: entry.slug,
        number: entry.number,
        kind: kinds.join(','),
        // In numbers, for the statistics (stats.mjs).
        checks: finished,
        reviews: newReviews.map(review => String(review.state)),
        comments: newComments.length,
        fix: fix?.queued ?? null, // the queued fix, for the event's fix attribute
        text: [
          `Pull request ${entry.number} in ${entry.slug} (worker ${entry.worker}): "${preview(pr.title, 80)}".`,
          ...lines,
          'Tell the driver as news in one or two sentences, without asking anything. Details: gh pr view or gh pr checks.',
        ].join('\n'),
      })
    }
  }

  // Who asks for a fix, of the new reviews and comments: inline comments,
  // reviews that request changes or say something, and comments with a
  // text, of a collaborator or a review bot, made since the run that started
  // the watch began. Their logins, once each.
  asking(entry, reviews, inline, comments) {
    const counts = (author, association, time) => (collaborator(association) || this.isBot(author)) && since(entry.since, time)
    const said = text => String(text ?? '').trim() !== ''
    const who = [
      ...reviews
        .filter(r => (r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && said(r.body))) && counts(r.author, r.authorAssociation, r.submittedAt))
        .map(r => r.author?.login),
      ...inline.filter(c => counts(c.user, c.author_association, c.created_at)).map(c => c.user?.login),
      ...comments.filter(c => said(c.body) && counts(c.author, c.authorAssociation, c.createdAt)).map(c => c.author?.login),
    ]
    return [...new Set(who.map(name => login(name) || 'someone'))]
  }

  // A review bot: its login on the list, unless GitHub says it is a person
  // (type in the REST API, is_bot from gh, __typename in GraphQL).
  isBot(author) {
    if (!author || author.type === 'User' || author.is_bot === false || author.__typename === 'User') return false
    return this.bots.some(name => sameLogin(name, author.login))
  }

  // A fix for those who ask (autoFix.queue, Workers.reviewFix), or why there
  // is none: { line, queued }, the line for the news and the queued task.
  // Each fix queued is one of the pull request's automatic rounds.
  async fix(entry, pr, asking) {
    const { rounds, queue } = this.autoFix
    const done = entry.fixes ?? 0
    const head = `Automatic fixing: new review comments from ${asking.join(', ')} ask for changes`
    const relay = 'Relay it as news; dispatch nothing for it.'
    if (done >= rounds) {
      return {
        line:
          `${head}, but the automatic rounds for this pull request are used up (${done} of ${rounds}), so the gateway ` +
          'queued no fix. Tell the driver; another fix takes their word, like any dispatch.',
      }
    }
    let result
    try {
      result = await queue({
        worker: entry.worker,
        slug: entry.slug,
        number: entry.number,
        branch: pr.headRefName ?? entry.branch ?? null,
        task: entry.task ?? null,
        round: done + 1,
        rounds,
      })
    } catch (error) {
      result = { status: 'failed', why: `it could not be queued: ${error.message}` }
    }
    if (result?.status === 'queued') {
      entry.fixes = done + 1
      this.log('review fix queued', entry.key, result.entry.id, `round ${entry.fixes} of ${rounds}`)
      return {
        queued: result.entry.id,
        line:
          `${head}: the gateway queued a fix for worker ${entry.worker} by itself, as ${result.entry.id}, automatic round ` +
          `${entry.fixes} of ${rounds}, as the driver's standing instruction says. ${relay}`,
      }
    }
    if (result?.status === 'waiting') {
      return { queued: result.entry.id, line: `${head}: the fix queued before as ${result.entry.id} has not started yet and takes them too. ${relay}` }
    }
    const why = result?.status === 'locked' ? 'the kill switch is locked' : (result?.why ?? `it could not be queued (${result?.status})`)
    this.log('review fix not queued', entry.key, why)
    return { line: `${head}, but the gateway queued no fix: ${why}. Tell the driver.` }
  }

  // Inline review comments from others that were not news yet.
  async newInline(entry, own) {
    const all = await this.json(['api', `repos/${entry.slug}/pulls/${entry.number}/comments?per_page=100`])
    if (!Array.isArray(all)) return []
    const fresh = all.filter(c => !own(c.user?.login) && !entry.inline.includes(c.id))
    entry.inline = [...entry.inline, ...fresh.map(c => c.id)].slice(-500)
    return fresh
  }
}
