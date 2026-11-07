// Claude accounts for the workers' runs: the driver's subscriptions, so that
// the runs spread over them and no single plan carries the week. The one
// controller session steers them all; only the workers' runs move.
//
// The default account is the login the workers have without anything else:
// Claude Code's own on this computer, which is the controller session's, and
// in a container the container's token (.secrets/worker/claude_token). Every
// further account is a long-lived token of that subscription, made at the
// desk with `claude setup-token` while signed in to it (valid about a year),
// in .secrets/accounts/<name>/claude_token: the file 0600, the folders 0700;
// <name>, lower case, is the account's name in the setting, in list_workers
// and for the controller. A run on such an account gets the token as
// CLAUDE_CODE_OAUTH_TOKEN in its own environment only: on this computer
// through spawn, in the container through docker exec -e with the name alone
// (runners.mjs), which docker/voice-run hands on in place of the container's
// own; never on a command line, in the log or in the state. Claude Code's
// folder stays the same for every account (CLAUDE_CONFIG_DIR unchanged), so
// memory folders, CLAUDE.md, the settings and the sessions to resume are
// shared; only the plan that pays differs. A token file that is missing,
// empty, no plain file or readable by others makes its account unavailable,
// with a log line once; it is read again at every run's start, so a new or
// replaced one counts at once.
//
// Adding an account is putting its token file there; removing it, deleting
// its folder, or switching it off by giving the folder a name that starts
// with a dot (.team), which is passed over. Both count at the next run's
// start, without a restart or a change of the setting.
//
// Which account a run takes is decided when it starts, a dispatch or a
// queued task alike (Workers.start), and kept with the run and its session,
// so that a later change of the setting or the files never moves what ran:
//
// 1. A session stays on its account: a follow-up, the driver's answer, a run
//    that the usage limit or a restart interrupted, goes on in its session on
//    the account it was made on, where its context and prompt cache are. A
//    session never changes account: a run that takes another one starts a
//    new session there (Workers.start says so in its prompt and the log).
//    That happens when its account is gone, switched off or no longer
//    allowed (then the default account takes it), and when its account waits
//    for the usage limit longer than SESSION_WAIT_MS while another one it may
//    take has room; a shorter wait it waits out. A new session (fresh, a new
//    worktree, a review fix, which runs fresh by default) chooses freely.
// 2. The most headroom: of the accounts it may take that do not wait for
//    the usage limit, the one whose plan is least used, by the latest
//    rate_limit_event of its runs (Limits.headroom): the fuller of its
//    windows (5-hour, weekly, …), compared in steps of 5 %. One on usage
//    credits, or with less than 2 % left, only when none other has room;
//    among equals the one with fewer runs going, then the default. An
//    account without a run for six hours counts as unknown, which ranks as
//    empty: it is tried, and known again. When all of them wait, the task
//    waits too (reason usage), until the first of them goes on.
// 3. Fixed rules, optional and none by default: VOICE_GW_ACCOUNTS in
//    .secrets/gateway.env or the environment, repository=account, several
//    accounts separated by commas, the entries by semicolons, as
//    VOICE_GW_PATH_GRANTS; *=… for every repository without an entry and for
//    the work folders. One account pins the repository to it, several allow
//    only those, and 2. chooses among them. Applies at once when the settings
//    file changes (live.mjs).
//
//      VOICE_GW_ACCOUNTS=hauswache=default;*=default,team
//
//    An entry whose accounts are all unavailable counts as none: its runs go
//    to the default account, with a log line, rather than not at all.
// 4. dispatch's account names one for this start, refused where a fixed
//    rule allows another, or where the session it goes on with runs on
//    another account that does not wait.
//
// The usage limit is per account too (limits.mjs, workers.mjs): a wait on
// one holds only the runs that would take it, and the controller waits only
// with the default account, its own login (gateway.mjs).

import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { clock, limitName } from './limits.mjs'
import { log as defaultLog } from './log.mjs'

export const ACCOUNTS_SETTING = 'VOICE_GW_ACCOUNTS'
export const DEFAULT_ACCOUNT = 'default'
export const TOKEN_FILE = 'claude_token'
// The variable that hands a run in the container its account's token
// (runners.mjs, docker/voice-run).
export const ACCOUNT_TOKEN_ENV = 'VOICE_GW_ACCOUNT_TOKEN'
export const ACCOUNT_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const REPO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const STEP = 0.05 // headroom is compared in steps of this much
const ROOM = 0.02 // less than this left is no room
// A wait of its account this short a session waits out, keeping its context
// and its prompt cache, which the workers keep an hour (config.mjs); a longer
// one it leaves for a new session on another account.
export const SESSION_WAIT_MS = 60 * 60 * 1000
// A token is one word of printable characters, as claude setup-token prints it.
const TOKEN = /^[\x21-\x7e]{20,4096}$/

// The key of an account for the usage limit (limits.mjs): the default
// account is the login where the run runs, this computer's or the
// container's; any other is the same subscription wherever it runs.
export function accountKey(name, container = null) {
  if (name && name !== DEFAULT_ACCOUNT) return `account:${name}`
  return container ? `container:${container}` : 'host'
}

// The setting's entries: { rules: Map(repository or * -> [accounts]),
// problems }. A name that is no account name is left out of its entry, so
// that a typo allows less, never more.
export function parseAccounts(text) {
  const rules = new Map()
  const problems = []
  for (const raw of String(text ?? '').split(';')) {
    const entry = raw.trim()
    if (!entry) continue
    const at = entry.indexOf('=')
    const repo = at < 0 ? '' : entry.slice(0, at).trim()
    if (repo !== '*' && !REPO.test(repo)) {
      problems.push(`"${entry}" is no repository=account`)
      continue
    }
    const names = entry
      .slice(at + 1)
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(Boolean)
    for (const name of names.filter(name => !ACCOUNT_NAME.test(name))) {
      problems.push(`"${name}" in ${repo}'s entry is no account name (lower case letters, digits, - and _)`)
    }
    const good = [...new Set(names.filter(name => ACCOUNT_NAME.test(name)))]
    if (!good.length) {
      problems.push(`"${entry}" names no account`)
      continue
    }
    if (rules.has(repo)) problems.push(`${repo} has two entries; the last counts`)
    rules.set(repo, good)
  }
  return { rules, problems }
}

const percent = used => `${Math.round(used * 100)} %`
const runsText = n => (n ? `, ${n} run${n === 1 ? '' : 's'} going` : '')

export class Accounts {
  // dir: .secrets/accounts, with a folder per further account; null: only
  // the default. setting: VOICE_GW_ACCOUNTS's text. limits: the waits and
  // the headroom of every account (limits.mjs), whose texts then name the
  // accounts as label does.
  constructor({ dir = null, setting = '', limits = null, now = () => Date.now(), log = defaultLog } = {}) {
    this.dir = dir
    this.limits = limits
    this.now = now
    this.log = log
    this.rules = new Map()
    this.noted = new Map() // what was said about an account or a rule, so that it is said once
    this.usable = null // the further accounts that could take runs at the last look (found)
    if (limits) limits.label = key => this.label(key)
    this.set(setting)
  }

  // Takes the setting's text, in place of the rules before. Returns what it
  // ignored; the log names it too.
  set(text) {
    const { rules, problems } = parseAccounts(text)
    for (const why of problems) this.log(`${ACCOUNTS_SETTING}: ignored, ${why}`)
    this.rules = rules
    this.noted.clear()
    return problems
  }

  // The rules in a few words, for the log: "hauswache: default; *: default, pro".
  text() {
    return [...this.rules].map(([repo, names]) => `${repo}: ${names.join(', ')}`).join('; ')
  }

  // The further accounts by their folders, each with what is wrong with its
  // token file, if anything: [{ name, problem }], by name.
  found() {
    if (!this.dir) return []
    let entries
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
    } catch {
      return [] // no folder: no further account
    }
    const found = entries
      .filter(entry => !entry.name.startsWith('.') && !entry.isFile()) // a note next to the folders is none
      .map(entry => ({ name: entry.name, problem: this.problem(entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // One added, removed or switched off at the desk: said once.
    const usable = found.filter(a => !a.problem).map(a => a.name)
    if (this.usable && this.usable.join() !== usable.join()) {
      const added = usable.filter(name => !this.usable.includes(name))
      const gone = this.usable.filter(name => !usable.includes(name))
      this.log(
        `accounts for the workers' runs now: ${[DEFAULT_ACCOUNT, ...usable].join(', ')}` +
          `${added.length ? `; added ${added.join(', ')}` : ''}${gone.length ? `; no longer ${gone.join(', ')}, whose sessions go on on the default, anew` : ''}`,
      )
    }
    this.usable = usable
    return found
  }

  // What keeps an account from taking runs, or null. Said in the log once.
  problem(name) {
    let problem = null
    if (name === DEFAULT_ACCOUNT) {
      problem = 'default is the login of this computer; give the folder another name'
    } else if (!ACCOUNT_NAME.test(name)) {
      problem = 'its folder name is no account name (lower case letters, digits, - and _)'
    } else {
      const file = join(this.dir ?? '', name, TOKEN_FILE)
      const stat = this.dir ? lstatSync(file, { throwIfNoEntry: false }) : null
      problem = !stat
        ? `it has no ${TOKEN_FILE} (claude setup-token at the desk, signed in to that account)`
        : !stat.isFile()
          ? `its ${TOKEN_FILE} is no plain file`
          : stat.mode & 0o077
            ? `its ${TOKEN_FILE} can be read by others (chmod 600 it)`
            : stat.size === 0
              ? `its ${TOKEN_FILE} is empty`
              : null
    }
    this.note(name, problem && `account ${name} unavailable: ${problem}`)
    return problem
  }

  // A line in the log when what it says about something changes.
  note(what, text) {
    if ((this.noted.get(what) ?? null) === text) return
    this.noted.set(what, text)
    if (text) this.log(text)
  }

  // Whether an account can take runs now: the default always; another
  // while its token file is fine.
  available(name) {
    return name === DEFAULT_ACCOUNT || (ACCOUNT_NAME.test(name ?? '') && this.found().some(a => a.name === name && !a.problem))
  }

  // Whether there is more than the default to speak of: a further account,
  // or a rule.
  configured() {
    return this.rules.size > 0 || this.found().length > 0
  }

  // The token of an account, or null: the default has none (its login), and
  // an account whose file is not fine neither.
  token(name) {
    if (!name || name === DEFAULT_ACCOUNT || this.problem(name)) return null
    try {
      const text = readFileSync(join(this.dir, name, TOKEN_FILE), 'utf8').trim()
      if (TOKEN.test(text)) return text
      this.note(name, `account ${name} unavailable: its ${TOKEN_FILE} holds no token (one line, as claude setup-token prints it)`)
    } catch (error) {
      this.note(name, `account ${name} unavailable: its ${TOKEN_FILE} cannot be read (${error.code ?? error.message})`)
    }
    return null
  }

  // The rule for a repository (or work folder): { names, from }, from being
  // the repository or *; null without one.
  rule(repo) {
    if (this.rules.has(repo)) return { names: this.rules.get(repo), from: repo }
    if (this.rules.has('*')) return { names: this.rules.get('*'), from: '*' }
    return null
  }

  // The accounts a repository's runs may take now, by the rules and the
  // token files: { names, rule, fallback }. named: whether accounts with a
  // token can run where it runs (a container whose voice-run is older
  // cannot). A rule whose accounts are all unavailable: the default, said
  // once (fallback).
  allowed(repo, { named = true } = {}) {
    const rule = this.rule(repo)
    const usable = name => name === DEFAULT_ACCOUNT || (named && this.available(name))
    const all = rule ? rule.names : [DEFAULT_ACCOUNT, ...this.found().filter(a => !a.problem).map(a => a.name)]
    const names = all.filter(usable)
    if (names.length) {
      if (rule) this.note(`rule:${repo}`, null)
      return { names, rule, fallback: false }
    }
    const where = rule.from === '*' ? `the entry *=${rule.names.join(',')}` : `the entry ${repo}=${rule.names.join(',')}`
    this.note(`rule:${repo}`, `${ACCOUNTS_SETTING}: ${where} names no account available ${named ? 'now' : 'where its runs run'}; ${repo} runs on the default account`)
    return { names: [DEFAULT_ACCOUNT], rule, fallback: true }
  }

  waits(name, container) {
    return Boolean(this.limits?.active(accountKey(name, container)))
  }

  // Why dispatch's account cannot be taken for this run, or null: an
  // account that does not exist or is unavailable, one a fixed rule does not
  // allow, one that cannot run where the run runs, or a session that goes on
  // on another account, which does not wait (it would move by itself then).
  refusal({ repo, container = null, named = true, account, session = null }) {
    const known = [DEFAULT_ACCOUNT, ...this.found().map(a => a.name)]
    if (!ACCOUNT_NAME.test(account ?? '') || !known.includes(account)) {
      return `there is no account "${String(account ?? '').slice(0, 40)}"; the accounts are ${known.join(', ')}`
    }
    if (account !== DEFAULT_ACCOUNT && !named) {
      return `runs in the container ${container} take only its own login, as its voice-run is older than the accounts; rebuild its image`
    }
    const problem = account === DEFAULT_ACCOUNT ? null : this.problem(account)
    if (problem) return `the account ${account} is unavailable: ${problem}`
    const rule = this.rule(repo)
    if (rule && !rule.names.includes(account)) {
      const which = rule.names.length === 1 ? `keeps ${repo} on ${rule.names[0]}` : `allows only ${rule.names.join(', ')} for ${repo}`
      return `a fixed rule of the driver's (${ACCOUNTS_SETTING}) ${which}`
    }
    const stays = session && (session === DEFAULT_ACCOUNT || named) && this.available(session) && (!rule || rule.names.includes(session))
    if (stays && session !== account && !this.waits(session, container)) {
      return `the session it goes on with runs on ${session}, and a follow-up stays on its session's account; with fresh=true a new session may start on ${account}`
    }
    return null
  }

  // Which account a run takes now (see the head of this file): { status:
  // 'ok', name, key, why }, { status: 'usage', keys } when every account it
  // may take waits for the usage limit, or its session's account waits only
  // a while, or { status: 'refused', why } for dispatch's account. A name
  // other than session's means a new session (Workers.start). repo: its
  // workspace's name; container: where it runs, null on this computer;
  // named: whether accounts with a token can run there; session: the
  // account of the session it goes on with, null for a new one; account:
  // dispatch's; busy: account -> runs going on it.
  choose({ repo, container = null, named = true, session = null, account = null, busy = {} }) {
    const key = name => accountKey(name, container)
    const ok = (name, why) => ({ status: 'ok', name, key: key(name), why })
    if (account) {
      const why = this.refusal({ repo, container, named, account, session })
      if (why) return { status: 'refused', why }
      return this.waits(account, container) ? { status: 'usage', keys: [key(account)] } : ok(account, 'named in dispatch')
    }
    const { names, fallback } = this.allowed(repo, { named })
    let moved = ''
    if (session && names.includes(session)) {
      const wait = this.limits?.active(key(session))
      if (!wait) return ok(session, "its session's")
      // Waited out with its session, also when it is the only one allowed.
      if (wait.until - this.now() <= SESSION_WAIT_MS || names.length === 1) return { status: 'usage', keys: [key(session)] }
      moved = `its session's account ${session} waits until ${clock(wait.until, this.now())}; `
    }
    const free = names.filter(name => !this.waits(name, container))
    if (!free.length) return { status: 'usage', keys: names.map(key) }
    if (session && !names.includes(session)) {
      // Gone, switched off or no longer allowed: the default takes the task, in a new session.
      const to = free.includes(DEFAULT_ACCOUNT) ? DEFAULT_ACCOUNT : this.rank(free, { container, busy })[0]
      return ok(to, `its session's account ${session} is gone, switched off or not allowed; ${to === DEFAULT_ACCOUNT ? 'the default' : 'the most headroom'}`)
    }
    const [best] = this.rank(free, { container, busy })
    const why = fallback
      ? 'the default, as its fixed rule names no account available'
      : names.length === 1
        ? 'the only one allowed'
        : free.length === 1
          ? 'the only one without a wait'
          : 'the most headroom'
    return ok(best, moved + why)
  }

  // The accounts by their room, the best first (3. at the head of this file).
  rank(names, { container = null, busy = {} } = {}) {
    const facts = names.map(name => {
      const key = accountKey(name, container)
      const left = this.limits?.headroom(key).left ?? null
      return { name, left, credits: Boolean(this.limits?.paying(key)), busy: busy[name] ?? 0 }
    })
    const room = f => !f.credits && (f.left === null || f.left >= ROOM)
    const some = facts.some(room)
    const step = f => Math.floor((f.left ?? 1) / STEP + 1e-9)
    return facts
      .sort(
        (a, b) =>
          (some ? Number(room(b)) - Number(room(a)) : 0) ||
          step(b) - step(a) ||
          a.busy - b.busy ||
          Number(b.name === DEFAULT_ACCOUNT) - Number(a.name === DEFAULT_ACCOUNT) ||
          a.name.localeCompare(b.name),
      )
      .map(f => f.name)
  }

  // Who waits or runs on credits, in a few words, for the texts of limits.mjs:
  // with further accounts, which login.
  label(key) {
    const several = this.configured()
    if (key === 'host' && several) return `the workers on the default account (this computer's login)`
    if (String(key).startsWith('container:') && several) return `the workers on the default account (the container ${key.slice('container:'.length)}'s login)`
    if (key === 'controller') return 'the controller session'
    if (key === 'host') return 'the workers on this computer'
    if (String(key).startsWith('container:')) return `the workers in the container ${key.slice('container:'.length)}`
    if (String(key).startsWith('account:')) return `the workers on the account ${key.slice('account:'.length)}`
    return String(key)
  }

  // One account's state in a few words, for list_workers: its use, when its
  // fullest window resets, its wait or credits, the runs going on it.
  describe(name, { container = null, busy = {} } = {}) {
    if (name !== DEFAULT_ACCOUNT) {
      const problem = this.problem(name)
      if (problem) return `${name} unavailable (${problem})`
    }
    const key = accountKey(name, container)
    const who = name === DEFAULT_ACCOUNT ? `${name} (${container ? `the container ${container}'s login` : "this computer's login, the controller's"})` : name
    const wait = this.limits?.active(key)
    if (wait) return `${who} waits for the usage limit until ${clock(wait.until, this.now())}${runsText(busy[name])}`
    const { windows } = this.limits?.headroom(key) ?? { windows: [] }
    const known = windows.filter(window => window.used !== null)
    const credits = this.limits?.paying(key) ? ', on usage credits' : ''
    if (!known.length) {
      const last = windows.length ? Math.max(...windows.map(window => window.at)) : null
      return `${who} use unknown${last ? `, no run since ${clock(last, this.now())}` : ', no run seen yet'}${credits}${runsText(busy[name])}`
    }
    const used = known
      .sort((a, b) => b.used - a.used)
      .map(window => `${percent(window.used)} of the ${limitName(window.name)}${window.resetsAt ? ` (resets ${clock(window.resetsAt, this.now())})` : ''}`)
    return `${who} ${used.join(', ')} used${credits}${runsText(busy[name])}`
  }

  // Every account in one line for list_workers, the default first; with the
  // rules when there are some.
  line({ container = null, named = true, busy = {} } = {}) {
    const names = [DEFAULT_ACCOUNT, ...this.found().map(a => a.name)]
    const states = names.map(name => (name !== DEFAULT_ACCOUNT && !named && !this.problem(name) ? `${name} not in the container ${container} (its voice-run is older than the accounts)` : this.describe(name, { container, busy })))
    const rules = this.text()
    return `Accounts: ${states.join('; ')}.${rules ? ` Fixed rules (${ACCOUNTS_SETTING}): ${rules}; the rest by headroom.` : ' No fixed rules: every run by headroom.'}`
  }
}
