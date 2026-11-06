// Pull requests that workers open: the gateway watches them with gh for the
// results that come without anyone asking, automatic checks and reviews, and
// tells the controller as news. The driver is not asked anything.
//
// Which pull requests: those a run names by URL for its own repository, in
// its tool output or its result, if gh shows them open, opened by the
// account gh is logged in as, from a branch of the repository itself, and
// the run's (whose): on a voice/ branch, the workers' own; watched before;
// on a branch the run's git push named, on any branch, as the guard saw it
// (guard.mjs, the run's pushedBranches); opened while the run went; or with
// a head commit made while it went after a push that named no branch. A
// pull request the run only names, such as one the driver opened, is not
// watched. A fork can name its branch voice/ too, and anyone can open a pull
// request on a public repository; those are not watched either. Until
// 2026-11-06 only voice/ branches counted, and the pull requests of tasks
// that named another branch were missed; at its start the gateway picks up
// those the runs it still has records of pushed and it never watched
// (pickUp).
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
// collaborators or of a review bot (bots, VOICE_GW_REVIEW_BOTS, a listed
// login only where GitHub says it is a bot account), get a fix
// that the watcher queues itself (Workers.reviewFix): a task in the
// gateway's words, naming the pull request and its branch, never what the
// reviews say, as a follow-up of the run that pushed the pull request. Only
// the worker's prompt quotes the comments that asked (asking), as data.
// Anyone else's text starts nothing. The fix pushes, the reviews run again,
// and new comments start the next round, at most autoFix.rounds per pull
// request until a run the driver dispatched works on it again. The news says
// what was queued, or why nothing was, so the controller only relays it.
//
// With the digest on (VOICE_GW_REVIEW_DIGEST, digest.mjs), routine news, such
// as checks that passed and comments a fix was queued for, waits in the
// gateway and reaches the controller gathered in one event; the news says who
// asked for changes (asking) and has a compact form (brief) for that.

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
const CLOCK_SLACK_MS = 2 * 60 * 1000 // between this computer's clock and GitHub's, for what a run did while it went
const FOREIGN = 'not opened by the gh account from this repository'
const ENDED = ['merged', 'closed', FOREIGN] // no later push can matter
const FIELDS =
  'number,title,state,isDraft,isCrossRepository,author,headRefName,headRefOid,url,createdAt,statusCheckRollup,' +
  'reviewRequests,reviews,comments'

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
// Whether an author says whether it is a bot: the REST API's type, gh's
// is_bot, GraphQL's __typename.
const typed = author => ['type', 'is_bot', '__typename'].some(key => author?.[key] !== undefined)

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

function checkParts(checks) {
  const failed = checks.filter(c => outcome(c) === 'failed').map(c => c.name || c.context || 'unnamed')
  const passed = checks.filter(c => outcome(c) === 'passed').length
  const skipped = checks.filter(c => outcome(c) === 'skipped').length
  const parts = [`${passed} passed`]
  if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''})`)
  if (skipped) parts.push(`${skipped} skipped`)
  return parts.join(', ')
}

const describeChecks = checks => `Checks finished on the latest push: ${checkParts(checks)}.`

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
    this.paused = false
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
    const add = (pr, why) => {
      const opened = !this.watches.some(w => w.key === `${task.slug}#${pr.number}`)
      found.push({ number: pr.number, title: pr.title, isDraft: Boolean(pr.isDraft), url: pr.url, opened })
      this.note(this.watch({ worker: task.repo, slug: task.slug, number: pr.number, title: pr.title, task, why }), pr)
    }
    for (const number of named) {
      const pr = await this.view(task.slug, number)
      if (!pr || pr.state !== 'OPEN') continue
      if (!this.ours(pr)) {
        const why = pr.isCrossRepository !== false ? 'from a fork' : `opened by ${login(pr.author?.login) || 'someone else'}`
        this.log('not watching pull request', `${task.slug}#${pr.number}:`, why)
        continue
      }
      const reason = await this.whose(task, pr)
      if (!reason) {
        const branch = pr.headRefName ? `its branch ${pr.headRefName}` : 'it'
        const why = `the run ${task.id} names it, but neither pushed ${branch} nor opened it`
        this.log('not watching pull request', `${task.slug}#${pr.number}:`, why)
        continue
      }
      add(pr, reason)
    }
    // A push or "ready for review" the run did not name.
    const views = await Promise.all(earlier.map(entry => this.view(entry.slug, entry.number)))
    earlier.forEach((entry, i) => {
      const pr = views[i]
      if (!pr) return
      if (pr.state !== 'OPEN') return this.stop(entry, pr.state === 'MERGED' ? 'merged' : 'closed')
      if (!this.ours(pr)) return this.stop(entry, FOREIGN)
      this.note(entry, pr)
      if (entry.changedAt >= since) add(pr, 'changed during the run')
    })
    if (found.length || earlier.length) this.save()
    return found
  }

  // Why a pull request the run names, open and the gh account's, is the
  // run's, or null: on a voice/ branch, the workers' own; watched before, as
  // a worker's; on a branch the run's git push named (pushedBranches, which
  // the guard notes on the run's record); opened while the run went; or,
  // after a push that named no branch (HEAD), with a head commit made while
  // it went. A little slack on both ends for the clocks.
  async whose(task, pr) {
    const branch = String(pr.headRefName ?? '')
    const pushed = Array.isArray(task.pushedBranches) ? task.pushedBranches : []
    const during = time => {
      const at = Date.parse(time ?? '')
      if (!Number.isFinite(at) || !Number.isFinite(task.startedAt)) return false
      return at >= task.startedAt - CLOCK_SLACK_MS && at <= (task.finishedAt ?? Date.now()) + CLOCK_SLACK_MS
    }
    const key = `${task.slug}#${pr.number}`.toLowerCase()
    if (branch.startsWith('voice/')) return 'a voice/ branch'
    if (this.watches.some(w => w.key.toLowerCase() === key && w.stopped !== FOREIGN)) return 'watched before'
    if (branch && pushed.includes(branch)) return `the run pushed ${branch}`
    if (during(pr.createdAt)) return 'opened during the run'
    if (pushed.includes('HEAD') && pr.headRefOid) {
      const commit = await this.json(['api', `repos/${task.slug}/commits/${pr.headRefOid}`])
      if (during(commit?.commit?.committer?.date)) return 'its head commit made during the run'
    }
    return null
  }

  // At the start: the pull requests that ended runs pushed or opened and the
  // gateway never watched, such as those of tasks that named a branch other
  // than voice/ before 2026-11-06, or of a run whose end it could not check
  // with gh. From the runs' records (tasks, the workers' state): runs that
  // ended within the watch time (VOICE_GW_PR_WATCH_HOURS) and were reported,
  // as an unreported one goes through fromRun again; the same checks as
  // fromRun, the newest run first, so that a fix continues the last run that
  // pushed it. Watched from now: what came before is news once, but asks for
  // no fix, as a run may be on it already (pickedUp, poll). The keys
  // (owner/name#number) of those it picked up.
  async pickUp(tasks = []) {
    const from = Date.now() - this.watchMs
    const runs = tasks
      .filter(t => t?.slug && t.pulls?.length && t.state !== 'running' && t.reported && (t.finishedAt ?? 0) >= from)
      .sort((a, b) => b.finishedAt - a.finishedAt)
    if (!runs.length || !(await this.ready())) return []
    const picked = []
    const seen = new Set(this.watches.map(w => w.key.toLowerCase()))
    const views = new Map() // several runs may name one
    for (const task of runs) {
      for (const number of task.pulls) {
        const key = `${task.slug}#${number}`.toLowerCase()
        if (seen.has(key)) continue
        if (!views.has(key)) views.set(key, await this.view(task.slug, number))
        const pr = views.get(key)
        if (!pr || pr.state !== 'OPEN' || !this.ours(pr)) continue
        const why = await this.whose(task, pr)
        // A run reported again at the start may have watched it meanwhile (fromRun).
        if (!why || this.watches.some(w => w.key.toLowerCase() === key)) continue
        seen.add(key)
        const entry = this.watch({ worker: task.repo, slug: task.slug, number: pr.number, title: pr.title, task, why, pickedUp: true })
        this.note(entry, pr)
        picked.push(entry.key)
      }
    }
    if (picked.length) this.save()
    return picked
  }

  // The last pull requests watched for the run's repository and worker that
  // it did not name, unless merged, closed or someone else's; for a fix of
  // review comments (task.review) always its own pull request too, so that
  // whether it pushed there is known now (changedSince).
  earlier(task, named) {
    const slug = task.slug.toLowerCase()
    const open = w => w.slug.toLowerCase() === slug && !named.includes(w.number) && !ENDED.includes(w.stopped)
    const last = this.watches.filter(w => open(w) && w.worker === task.repo).slice(-RECHECK)
    const fixed = task.review?.slug?.toLowerCase() === slug ? this.watches.find(w => open(w) && w.number === task.review.number) : null
    return fixed && !last.includes(fixed) ? [...last, fixed] : last
  }

  // The head commit, its branch and the draft state as last seen, when the
  // commit or the draft state changed, and when it was last seen.
  note(entry, pr) {
    const draft = Boolean(pr.isDraft)
    if (entry.head && (entry.head !== pr.headRefOid || entry.draft !== draft)) entry.changedAt = Date.now()
    entry.head = pr.headRefOid
    entry.branch = pr.headRefName ?? entry.branch ?? null
    entry.draft = draft
    entry.seenAt = Date.now()
  }

  // Whether a watched pull request's head commit (or draft state) changed
  // since a time, as seen at or after another: a run pushed to it during the
  // run (since its start, seen after its end). null when it cannot tell: not
  // watched, or not seen since then.
  changedSince(slug, number, since, seenAfter = since) {
    const entry = this.watches.find(w => w.key.toLowerCase() === `${String(slug).toLowerCase()}#${number}`)
    if (!entry?.head || !((entry.seenAt ?? 0) >= seenAfter)) return null
    return (entry.changedAt ?? 0) >= since
  }

  // task: the run that opened or worked on it, which a fix continues. One
  // the driver dispatched gives the automatic fixing its rounds again; a fix
  // the gateway queued does not (task.review). why: for the log.
  // pickedUp: one the gateway missed when the run ended (pickUp), watched
  // from now on.
  watch({ worker, slug, number, title, task = null, why = null, pickedUp = false }) {
    const key = `${slug}#${number}`
    let entry = this.watches.find(w => w.key === key)
    if (!entry) {
      // since: what came before the run that started the watch, that run
      // could see; for one picked up, what came before now asks for no fix.
      const from = pickedUp ? Date.now() : (task?.startedAt ?? Date.now())
      entry = { key, worker, slug, number, reviews: [], comments: [], inline: [], checked: [], fixes: 0, since: from }
      if (pickedUp) entry.pickedUp = from
      this.watches.push(entry)
    }
    const now = Date.now()
    Object.assign(entry, { worker, title, active: true, stopped: null, until: now + this.watchMs, polls: 0, quiet: 0, nextAt: now })
    if (task) {
      entry.task = task.id
      if (!task.review) entry.fixes = 0
    }
    const how = [why, pickedUp && task ? `picked up from the run ${task.id}` : null].filter(Boolean).join(', ')
    this.log('watching pull request', key, `for ${worker}${how ? ` (${how})` : ''}`)
    return entry
  }

  stop(entry, reason) {
    entry.active = false
    entry.stopped = reason
    this.log('stopped watching pull request', entry.key + ':', reason)
  }

  async tick() {
    const due = this.active().filter(w => w.nextAt <= Date.now())
    // paused: in a standby after the connector was disconnected (gateway.mjs).
    if (this.busy || this.paused || !due.length) return
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
    const brief = [] // the same in a few words, for a digest (digest.mjs)
    const kinds = []
    let finished = null // the checks' outcomes, for the statistics

    if (checks.length && checks.every(complete) && pr.headRefOid && !entry.checked.includes(pr.headRefOid)) {
      entry.checked = [...entry.checked, pr.headRefOid].slice(-20)
      lines.push(describeChecks(checks))
      brief.push(`checks finished: ${checkParts(checks)}`)
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
        brief.push(`review from ${login(review.author?.login)}: ${state}`)
      }
      inline = await this.newInline(entry, own)
      if (inline.length) brief.push(plural(inline.length, 'inline comment'))
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
        brief.push(`comment from ${login(comment.author?.login)}`)
      }
    }
    // Review comments fixed without asking: a fix queued, or why not.
    const asked = this.autoFix ? await this.asking(entry, newReviews, inline, newComments) : []
    const asking = [...new Set(asked.map(item => item.author))]
    const fix = asking.length ? await this.fix(entry, pr, asking, asked) : null
    if (fix) lines.push(fix.line)
    if (fix?.brief) brief.push(fix.brief)
    // Picked up at the start (pickUp): its first look says so, and who asked
    // for changes before, which no fix is queued for.
    let missed = []
    if (entry.pickedUp) {
      delete entry.pickedUp
      const before = this.autoFix ? await this.asking(entry, newReviews, inline, newComments, { before: true }) : []
      missed = [...new Set(before.map(item => item.author))]
      if (lines.length) {
        lines.push(
          `The gateway missed this pull request when the run ${entry.task ?? 'that pushed it'} ended, and picked it up at its start` +
            (missed.length
              ? `: the review comments from before, from ${missed.join(', ')}, get no automatic fix, as a run may be on them ` +
                'already. Tell the driver; a fix of them takes their word, like any dispatch.'
              : '.'),
        )
        const unfixed = missed.length ? `, no automatic fix for the comments from before (${missed.join(', ')})` : ''
        brief.push(`picked up at the start${unfixed}`)
      }
    }

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
        // Who asks for changes, with automatic fixing on; null with it off.
        // With brief and title, for the digest of routine news (digest.mjs).
        asking: this.autoFix ? asking : null,
        // Who asked before a watch picked up at the start: no fix, not routine.
        missed,
        brief: brief.join('; '),
        title: pr.title,
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
  // the watch began. Each as { author, kind, where, state, text }, for the
  // fix's prompt (Workers.reviewComments): the words the worker would act on
  // anyway, of nobody else. gh names the authors of reviews and comments
  // without saying whether they are bots; for a login on the list, the REST
  // API says it (authors). before: those made before that instead, which
  // ask for nothing (a watch picked up at the start).
  async asking(entry, reviews, inline, comments, { before = false } = {}) {
    const untyped = item => !collaborator(item.authorAssociation) && this.listed(item.author) && !typed(item.author)
    const rest = {
      reviews: reviews.some(untyped) ? await this.authors(`repos/${entry.slug}/pulls/${entry.number}/reviews?per_page=100`) : new Map(),
      comments: comments.some(untyped) ? await this.authors(`repos/${entry.slug}/issues/${entry.number}/comments?per_page=100`) : new Map(),
    }
    const author = (item, found) => (untyped(item) ? (found.get(item.id) ?? null) : item.author)
    const counts = (author, association, time) =>
      (collaborator(association) || this.isBot(author)) && since(entry.since, time) !== before
    const said = text => String(text ?? '').trim() !== ''
    const items = [
      ...reviews
        .filter(r => r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && said(r.body)))
        .filter(r => counts(author(r, rest.reviews), r.authorAssociation, r.submittedAt))
        .map(r => ({ name: r.author?.login, kind: 'review', state: REVIEW_STATE[r.state], text: r.body })),
      ...inline
        .filter(c => counts(c.user, c.author_association, c.created_at))
        .map(c => ({ name: c.user?.login, kind: 'inline', where: `${c.path}${c.line ? `:${c.line}` : ''}`, text: c.body })),
      ...comments
        .filter(c => said(c.body) && counts(author(c, rest.comments), c.authorAssociation, c.createdAt))
        .map(c => ({ name: c.author?.login, kind: 'comment', text: c.body })),
    ]
    return items.map(({ name, text, ...item }) => ({ author: login(name) || 'someone', ...item, text: String(text ?? '').trim() }))
  }

  // A login on the list of review bots.
  listed(author) {
    return this.bots.some(name => sameLogin(name, author?.login))
  }

  // A review bot: its login on the list, and GitHub says it is a bot (type
  // in the REST API, is_bot from gh, __typename in GraphQL). Without that it
  // is not: a person may have an account of that name.
  isBot(author) {
    const bot = author?.type === 'Bot' || author?.is_bot === true || author?.__typename === 'Bot'
    return bot && this.listed(author)
  }

  // The authors of a pull request's reviews, or of its comments, as the REST
  // API gives them, with their type, by the node id that gh gives as the id:
  // node id -> { login, type }. Empty when gh does not answer.
  async authors(path) {
    const all = await this.json(['api', path])
    return new Map((Array.isArray(all) ? all : []).filter(item => item?.node_id && item.user).map(item => [item.node_id, item.user]))
  }

  // A fix for those who ask (autoFix.queue, Workers.reviewFix), or why there
  // is none: { line, queued }, the line for the news and the queued task.
  // Each fix queued is one of the pull request's automatic rounds. asking:
  // their logins; asked: what they said (asking), for the fix's prompt.
  async fix(entry, pr, asking, asked = []) {
    const { rounds, queue } = this.autoFix
    const done = entry.fixes ?? 0
    const head = `Automatic fixing: new review comments from ${asking.join(', ')} ask for changes`
    const relay = 'Relay it as news; dispatch nothing for it.'
    if (done >= rounds) {
      return {
        line:
          `${head}, but the automatic rounds for this pull request are used up (${done} of ${rounds}), so the gateway ` +
          'queued no fix. Tell the driver; another fix takes their word, like any dispatch.',
        brief: `automatic rounds used up (${done} of ${rounds}), no fix queued`,
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
        comments: asked,
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
        brief: `${asking.join(', ')} asked for changes: fix ${result.entry.id} queued, automatic round ${entry.fixes} of ${rounds}`,
      }
    }
    if (result?.status === 'waiting') {
      return {
        queued: result.entry.id,
        line: `${head}: the fix queued before as ${result.entry.id} has not started yet and takes them too. ${relay}`,
        brief: `${asking.join(', ')} asked for changes: the fix ${result.entry.id} queued before takes them too`,
      }
    }
    const why = result?.status === 'locked' ? 'the kill switch is locked' : (result?.why ?? `it could not be queued (${result?.status})`)
    this.log('review fix not queued', entry.key, why)
    return { line: `${head}, but the gateway queued no fix: ${why}. Tell the driver.`, brief: `no fix queued: ${why}` }
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
