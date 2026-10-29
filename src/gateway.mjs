#!/usr/bin/env node
// Voice gateway entry point.
//
// Claude Code starts this file as an MCP server (see controller/.mcp.json).
// One process, two faces:
//   stdio  -> Claude Code controller session (a channel: push events, reply tool, permission relay)
//   HTTP   -> voice assistant in the car (MCP tools: status, send, ask, get_reply, approve),
//             behind an OAuth sign-in, and through the tunnel only from Anthropic's
//             addresses (ipguard.mjs)
// plus a Unix socket for scripts/pair.mjs (pairing codes, connections), the
// workers: headless Claude Code runs in the repositories next to this one, or
// in a Docker container with its own clones, a watch on the pull requests they
// open, for checks and reviews, and optionally Telegram, for questions and
// approvals after the voice mode ended, and for alarms. At the controller
// levels clone-delete and unrestricted, also cloning and deleting in the
// worker root (folders.mjs). Over all of it, the kill switch (killswitch.mjs).
// And what is open, so that nothing is forgotten: decisions for the driver
// (ledger.mjs), the queue (workers.mjs), the requests (store.mjs).

import { CONTROLLER_LEVELS, EFFORTS, KILLSWITCH_MODES, ROOT, VERSION, config } from './config.mjs'
import { log } from './log.mjs'
import { execFileSync } from 'node:child_process'
import { Store } from './store.mjs'
import { Auth } from './oauth.mjs'
import { startAdmin } from './admin.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'
import { Workers, auditSummary, gitState, hostGit, parkedText, queueList } from './workers.mjs'
import { Restarter } from './restart.mjs'
import { PullWatcher } from './pulls.mjs'
import { TelegramCommands, TelegramFallback, loadTelegram } from './telegram.mjs'
import { KillSwitch, alarmText, offText } from './killswitch.mjs'
import { RunGuard } from './guard.mjs'
import { hostname } from 'node:os'
import { DockerRunner, HostRunner } from './runners.mjs'
import { ACCESS_LEVELS, GitHubAccess } from './access.mjs'
import { FolderTools, clonedText } from './folders.mjs'
import { FunnelSwitch, staleText } from './funnel.mjs'
import { Alerts, IpGuard } from './ipguard.mjs'
import { Ledger, openItems, reminderText, startupText } from './ledger.mjs'

// The first line of every start: which code runs, so the log tells after a
// restart whether the new commit is in.
function commit() {
  const git = (...args) =>
    execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const head = git('rev-parse', '--short', 'HEAD')
    return git('status', '--porcelain', '--untracked-files=no') ? `${head} with uncommitted changes` : head
  } catch {
    return 'unknown (not a git checkout)'
  }
}
log(`cc-voice-gateway ${VERSION} starting, commit ${commit()}, pid ${process.pid}, node ${process.version}`)

// Open decisions keep their requests past the retention time.
const ledger = new Ledger({ file: config.jobsFile, remindMinutes: config.remindMinutes })
const store = new Store({ permissionTtlSeconds: config.permissionTtlSeconds, file: config.requestsFile, keep: id => ledger.needs(id) })
// The driver's answer to a question: the decisions of its request keep it.
store.on('answer', request => {
  try {
    ledger.answer(request.answers, { text: request.text.replace(/^\(Answer to [^)]*\)\s*/, ''), answerId: request.id })
  } catch (error) {
    log('answer not kept with its decisions:', error.message)
  }
})
const killswitch = new KillSwitch({ file: config.killSwitchFile, mode: config.killSwitchMode })
if (config.killSwitchSetting && !KILLSWITCH_MODES.includes(config.killSwitchSetting)) {
  log(`VOICE_GW_KILLSWITCH=${config.killSwitchSetting} is not one of ${KILLSWITCH_MODES.join(', ')}; auto instead`)
}
log(
  `kill switch ${killswitch.mode}: ` +
    {
      auto: 'the rules and the manual triggers lock it',
      manual: 'only the manual triggers lock it (voice, Telegram, raise_alarm); the rules only log',
      off: 'nothing locks it; every trigger is only logged',
    }[killswitch.mode],
)
if (killswitch.locked) {
  log(`kill switch is locked since ${killswitch.state.at} by ${killswitch.state.trigger}: ${killswitch.state.reason}`)
  if (killswitch.mode !== 'auto') log('kill switch: the setting does not unlock it; only scripts/unlock.mjs does')
}
const auth = new Auth({ stateFile: config.oauthStateFile, allowedHosts: config.oauthHosts })
if (config.access && !ACCESS_LEVELS.includes(config.access)) {
  log(`VOICE_GW_ACCESS=${config.access} is not one of ${ACCESS_LEVELS.join(', ')}; detecting the level instead`)
}
if (config.docker) {
  log(
    `workers run in the Docker container ${config.docker},`,
    ACCESS_LEVELS.includes(config.access)
      ? `access level ${config.access} (VOICE_GW_ACCESS)`
      : 'access level per repository from the GitHub token',
  )
}
if (config.workerEffort && !EFFORTS.includes(config.workerEffort)) {
  log(`VOICE_GW_WORKER_EFFORT=${config.workerEffort} is not one of ${EFFORTS.join(', ')}; workers run with the default`)
}
if (config.workerModel || config.workerEffort) {
  log(`workers run with model ${config.workerModel || 'default'}, effort ${config.workerEffort || 'default'}`)
}
const runner = config.docker
  ? new DockerRunner({ container: config.docker, root: config.dockerRepos, dockerBin: config.dockerBin })
  : new HostRunner(config.workerRoot)
if (config.docker) {
  runner.check().then(({ folder, user, warnings }) => {
    log(`worker container ${config.docker}: repositories from host folder ${folder ?? '?'}, running as ${user ?? '?'}`)
    for (const warning of warnings) log(`worker container ${config.docker}: ${warning}`)
  })
}
const workers = new Workers({
  runner,
  access: config.docker
    ? new GitHubAccess({ tokenFile: config.githubTokenFile, apiBase: config.githubApi, forced: config.access })
    : null,
  killswitch,
  ledger,
  stateDir: config.stateDir,
  claudeBin: config.claudeBin,
  ghBin: config.ghBin,
  model: config.workerModel,
  effort: EFFORTS.includes(config.workerEffort) ? config.workerEffort : '',
  maxRuns: config.maxWorkers,
  timeoutMinutes: config.workerTimeoutMinutes,
})
const guard = new RunGuard({
  workers,
  runner,
  killswitch,
  ghBin: config.ghBin,
  limits: { maxEdits: config.killMaxEdits, maxFiles: config.killMaxFiles, maxLines: config.killMaxLines },
  allowed: config.killAllowPaths,
  mainCheckSeconds: config.killCheckSeconds,
})
for (const task of workers.running()) guard.started(task) // runs from before this gateway

// What the controller may do; see config.mjs and the confine hook.
if (config.controllerLevelSetting && !CONTROLLER_LEVELS.includes(config.controllerLevelSetting)) {
  log(`VOICE_GW_CONTROLLER_LEVEL=${config.controllerLevelSetting} is not one of ${CONTROLLER_LEVELS.join(', ')}; confined instead`)
}
log(`controller level ${config.controllerLevel}`)
let folders = null
if (config.controllerLevel !== 'confined') {
  if (config.docker) log('clone_repo and delete_path: not with workers in Docker')
  else folders = new FolderTools({ root: config.workerRoot, workers, killswitch, ghBin: config.ghBin })
}

const pulls = new PullWatcher({
  ghBin: config.ghBin,
  stateFile: config.pullsStateFile,
  pollSeconds: config.prPollSeconds,
  watchHours: config.prWatchHours,
})

let http
let admin
let funnel = null
let shuttingDown = false
function shutdown(reason, code = process.exitCode ?? 0) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down:', reason)
  http?.close()
  admin?.close()
  workers.close() // runs go on; the next gateway picks them up
  guard.close()
  telegramCommands?.close()
  funnel?.close()
  pulls.close() // so do the watches on pull requests
  store.save() // the requests, with what the voice client has read
  // Give pending log writes and HTTP responses a moment, then leave.
  setTimeout(() => process.exit(code), 200).unref()
}

// Restarting the controller by voice, through the watchdog (restart.mjs).
const restarter = new Restarter({ store, workers, ledger, secretsDir: config.secretsDir })

// The gateway's own checkout, each time the controller answers a request with
// "done": uncommitted changes and commits on no remote become a push
// decision, and the reply's result says so in a line until the driver was
// asked, so that work on the gateway itself is not forgotten. Once the driver
// decided about exactly these files and commits, nothing more; once the
// checkout is clean, an open one closes. Only the commits of the branch that
// is checked out count: other local branches, such as those of Claude Code's
// worktrees, are not the driver's to push.
async function selfCheck() {
  if (!config.selfCheckout) return null
  const state = await gitState(hostGit, config.selfCheckout, { current: true })
  if (!state) return null
  const open = ledger.open().filter(d => d.scope === 'gateway')
  if (!state.dirty.length && !state.unpushed.length) {
    for (const d of open) ledger.close(d, { outcome: 'the checkout is clean now', by: 'gateway' })
    return null
  }
  const fingerprint = [...state.dirty, ...state.unpushed.map(commit => commit.hash)].sort().join(' ')
  const last = ledger.decisions.findLast(d => d.scope === 'gateway')
  const parts = []
  if (state.dirty.length) parts.push(`${state.dirty.length} uncommitted file${state.dirty.length === 1 ? '' : 's'}`)
  if (state.unpushed.length) parts.push(`${state.unpushed.length} commit${state.unpushed.length === 1 ? '' : 's'} on no remote`)
  const what = `The gateway's own checkout has ${parts.join(' and ')}, on ${state.branch || 'a detached HEAD'}`
  let decision = last?.details?.fingerprint === fingerprint ? last : null
  if (decision && decision.state !== 'pending') return null // asked or decided already
  if (!decision) {
    decision = ledger.add({ kind: 'push', scope: 'gateway', text: `${what}. Commit and push them, or leave them?`, details: { fingerprint } })
    for (const d of open) ledger.close(d, { outcome: `replaced by ${decision.id}`, by: 'gateway' })
  }
  return (
    `${what}: open decision ${decision.id}. Tell the driver once, in a later answer (state "question", ` +
    `decisions="${decision.id}").`
  )
}

const channel = await startChannel(store, {
  permissionRelay: config.permissionRelay,
  workers,
  restarter,
  killswitch,
  folders,
  ledger,
  selfCheck,
  level: config.controllerLevel,
  onClose: () => shutdown('stdio closed'),
})

// When a run ends, the gateway looks at its checkout (Workers.audit), and the
// result goes to the controller as a channel event, with what the gateway saw
// and the pull requests the run opened or worked on. The controller's reply
// to it reaches the driver as news.
const reporting = new Set()
workers.on('finished', async task => {
  if (reporting.has(task.id)) return
  reporting.add(task.id)
  try {
    await channel.ready
    await workers.audit(task)
    const opened = await pulls.fromRun(task).catch(error => {
      log('pull requests of', task.id, 'not checked:', error.message)
      return []
    })
    const request = store.createRequest(workers.resultText(task, opened), {
      origin: 'worker',
      worker: { repo: task.repo, task: task.id },
    })
    // trusted="no": the result carries whatever the run read (channel.mjs).
    // git: the audit in the gateway's words, without the run's.
    request.meta = { worker: task.repo, task: task.id, outcome: task.state, git: auditSummary(task.audit), trusted: 'no' } // for sending it again
    if (opened.length) request.meta.pull_request = opened.map(pull => pull.number).join(',')
    if (task.queued) request.meta.queued = task.queued // the id it had in the queue
    // What the audit found is an open decision; it belongs to this result.
    const decision = task.decision ? ledger.get(task.decision) : null
    if (decision && decision.state !== 'closed') {
      ledger.link(decision, request.id)
      request.meta.decision = decision.id
    }
    await channel.push(request, request.meta)
    workers.markReported(task)
  } catch (error) {
    log('worker result not delivered:', error.message)
  } finally {
    reporting.delete(task.id)
  }
})

// A queued task that could not start when it was its turn has left the
// queue; the controller hears why, and the driver through its answer. The
// text holds the controller's task and the gateway's reason. trusted="no":
// the task may quote what a worker or GitHub said.
workers.on('parked', async (entry, why, status, decision) => {
  try {
    await channel.ready
    const request = store.createRequest(parkedText(entry, why, status, decision), { origin: 'worker' })
    request.meta = { kind: 'queue', worker: entry.worker, queued: entry.id, outcome: status, trusted: 'no' }
    if (decision) {
      ledger.link(decision, request.id)
      request.meta.decision = decision.id
    }
    await channel.push(request, request.meta)
  } catch (error) {
    log('queue news not delivered:', error.message)
  }
})

// A clone's result reaches the controller the same way.
folders?.on('cloned', async event => {
  try {
    await channel.ready
    const request = store.createRequest(clonedText(event), { origin: 'worker' })
    // trusted="no": a failure quotes git and GitHub.
    request.meta = { kind: 'clone', repo: event.slug, folder: event.name, outcome: event.ok ? 'done' : 'failed', trusted: 'no' }
    await channel.push(request, request.meta)
  } catch (error) {
    log('clone result not delivered:', error.message)
  }
})

// Checks and reviews on those pull requests reach the controller as events
// too, and the driver as news.
pulls.on('news', async news => {
  try {
    await channel.ready
    const request = store.createRequest(news.text, { origin: 'worker' })
    // trusted="no": it quotes what others wrote on GitHub.
    request.meta = { worker: news.worker, repo: news.slug, pull_request: String(news.number), kind: news.kind, trusted: 'no' }
    await channel.push(request, request.meta)
  } catch (error) {
    log('pull request news not delivered:', error.message)
  }
})

// Telegram, if set up, reaches the driver with questions and approvals once the
// voice mode has ended, and with alarms at once.
const telegram = loadTelegram({
  tokenFile: config.telegramTokenFile,
  chatIdFile: config.telegramChatIdFile,
  apiBase: config.telegramApi,
})
let telegramCommands = null
// The Funnel on demand (funnel.mjs): from Telegram, and off by itself when idle.
const say = text => telegram?.send(text).catch(error => log('telegram message not sent:', error.message)) ?? Promise.resolve()
funnel = new FunnelSwitch({ script: config.funnelScript, store, idleMinutes: config.funnelIdleMinutes, say })
if (config.funnelIdleMinutes) {
  log(`funnel auto-off: ${config.funnelIdleMinutes} minutes after the last voice call${telegram ? '' : '; without Telegram, only at the computer on again'}`)
}
if (telegram) {
  new TelegramFallback(store, { send: text => telegram.send(text), afterSeconds: config.telegramAfterSeconds })
  log(`telegram fallback ready: questions and approvals after ${config.telegramAfterSeconds} s without a voice call`)
  // Inbound, only the kill switch and the Funnel, only from the configured chat.
  telegramCommands = new TelegramCommands(telegram, { pollSeconds: config.telegramPollSeconds }).start()
  telegramCommands.on('stop', ({ text }) => {
    const state = killswitch.trip({ trigger: 'telegram', reason: `"${text}" on Telegram` })
    if (!state && !killswitch.locked) say(`cc-voice-gateway on ${hostname()}: "${text}" locked nothing. ${offText()}`)
  })
  telegramCommands.on('funnel', ({ action }) => funnel.command(action))
  telegramCommands.on('stale', stale => say(staleText(stale)))
} else {
  log('telegram fallback off: telegram_token and telegram_chat_id not both set')
}

// The door of the voice endpoint (ipguard.mjs): /mcp through the tunnel only
// from the allowed addresses, and suspicious requests and every sign-in step
// on Telegram, throttled. Without Telegram, the log has them.
const ipGuard = new IpGuard({
  allow: config.mcpAllow,
  alerts: new Alerts({ send: telegram ? text => telegram.send(text) : null }),
})
auth.on('pairing', event => ipGuard.pairing(event))
log(`${ipGuard.describe()}; suspicious requests ${telegram ? 'reported on Telegram' : 'only in the log'}`)

// --- the kill switch's effects, in code ---------------------------------------

// No new tasks (Workers.dispatch and the voice tools check the switch), the
// queue is emptied, every run and the worker container stop, open approvals
// are denied. An error here is logged; the lock holds whatever happens, and
// so does the gateway. Returns the tasks that were queued.
async function lockdown(why) {
  const parked = workers.parkAll()
  if (parked.length) log('kill switch emptied the queue:', parked.map(entry => `${entry.worker} ${entry.id}`).join(', '))
  try {
    const stopped = workers.stopAll(`kill switch (${why})`)
    if (stopped.length) log('kill switch stopped', stopped.map(task => `${task.repo} ${task.id}`).join(', '))
  } catch (error) {
    // The runs got their signal before the state was to be saved.
    log('kill switch: worker runs stopped, but their state was not saved:', error.message)
  }
  folders?.stopAll()
  for (const permission of store.openPermissions()) {
    store.resolvePermission(permission.code, 'deny')
    channel.sendVerdict(permission.code, 'deny').catch(() => {})
  }
  if (config.docker) {
    const ok = await runner.lockdown()
    log(`kill switch: worker container ${config.docker} ${ok ? 'stopped' : 'not stopped (was it running?)'}`)
  }
  return parked
}

const lockdownFailed = error => log('kill switch: lockdown incomplete, still locked:', error.message)

killswitch.on('tripped', async (state, event, first) => {
  const parked = (await lockdown(event.trigger).catch(lockdownFailed)) ?? []
  // Telegram at once; every voice chat hears it with its next call (voice.mjs).
  const when = new Date(event.at).toISOString().replace('T', ' ').slice(0, 16)
  telegram
    ?.send(
      `cc-voice-gateway on ${hostname()}: ${first ? 'KILL SWITCH' : 'kill switch, again'} at ${when} UTC, ` +
        `by ${event.trigger}: ${event.reason}. No new tasks, workers stopped, repositories read-only for the ` +
        'worker container. Unlock only at the server: node scripts/unlock.mjs',
    )
    .catch(error => log('kill switch alarm not sent by Telegram:', error.message))
  // The controller hears it too; its acknowledgement is not news.
  try {
    await channel.ready
    // The queue's tasks are the controller's own words; they do not start
    // after the unlock by themselves.
    const list = queueList(parked, { max: 10, repos: true })
    const queue = parked.length
      ? ` These queued tasks left the queue and will not start by themselves: ${list}. Each is an open decision ` +
        'now, which holds nothing. Tell the driver; after the unlock they can have them dispatched again.'
      : ''
    const request = store.createRequest(
      `${first ? 'Kill switch locked' : 'Kill switch triggered again'}: ${alarmText(state)} Do not try to get ` +
        `around it.${queue} Reply "done".`,
      { origin: 'alarm' },
    )
    await channel.push(request, { kind: 'killswitch', trigger: event.trigger })
  } catch (error) {
    log('kill switch event not delivered to the controller:', error.message)
  }
})

if (killswitch.locked) lockdown('locked at startup').catch(lockdownFailed)

// While locked, a worker container with a writable /repos is stopped, however
// it was started.
if (config.docker) {
  setInterval(async () => {
    if (!killswitch.locked) return
    const mounts = await runner.mounts()
    if (mounts?.running && mounts.writable) {
      log(`kill switch: worker container ${config.docker} runs with a writable /repos; stopping it`)
      await runner.lockdown()
    }
  }, config.killCheckSeconds * 1000).unref()
}

// Without its port the gateway is of no use, and whatever holds the port, a
// gateway left over from an earlier session for example, answers the
// watchdog's /healthz in its place. So the gateway ends with an error, and
// says so on Telegram too.
async function portBusy() {
  process.exitCode = 1 // also if the session goes away while the message is on its way
  await telegram
    ?.send(
      `cc-voice-gateway on ${hostname()}: the voice port ${config.port} is in use by another process, so the ` +
        'gateway of the controller session ends and voice requests do not reach it. Find the process with ' +
        `lsof -nP -iTCP:${config.port} -sTCP:LISTEN, end it, then restart the controller.`,
    )
    .catch(error => log('port alarm not sent by Telegram:', error.message))
  shutdown(`voice port ${config.port} in use`, 1)
}

admin = await startAdmin(auth, config.adminSocket, { killswitch })
http = startVoiceHttp(store, channel, auth, config, { killswitch, onPortBusy: portBusy, guard: ipGuard })

// Once the session is connected: first one event with everything open, so
// that a restarted controller knows it without memory files; its answer is
// for the gateway only (origin "gateway": no news, no Telegram). trusted="no":
// its tasks and questions are the controller's words, which may quote a
// worker or GitHub (ledger.mjs). Then the worker results the previous session
// never answered go to this one, and after a restart by the watchdog the
// driver hears on Telegram that the controller is ready again.
let connected = false
channel.ready.then(async () => {
  connected = true
  try {
    const items = openItems({ ledger, workers, store, interrupted: store.interrupted })
    const summary = store.createRequest(startupText(items), { origin: 'gateway' })
    await channel.push(summary, { kind: 'summary', trusted: 'no' })
  } catch (error) {
    log('start-up summary not delivered:', error.message)
  }
  for (const request of [...store.requests.values()].filter(r => r.resend)) {
    try {
      await channel.push(request, { ...request.meta, resent: 'yes' })
      delete request.resend
      store.changed()
    } catch (error) {
      log('worker result not sent again:', error.message)
    }
  }
  restarter.announceReady()
})

// A decision never put to the driver, or a question they have not answered: a
// reminder event after VOICE_GW_REMIND_MINUTES, at most three times; none
// while the kill switch is locked. The controller asks on it, and the driver
// hears that as news (origin "worker"). The reminder belongs to the decision
// from then on, so a decision that belonged to no request (after stop_worker,
// or from the kill switch) has one now. trusted="no", as for the summary.
const reminders = setInterval(
  async () => {
    if (!connected || killswitch.locked) return
    for (const decision of ledger.due()) {
      try {
        const request = store.createRequest(reminderText(decision, ledger.maxReminders), { origin: 'worker' })
        request.meta = { kind: 'reminder', decision: decision.id, trusted: 'no' }
        if (decision.repo) request.meta.worker = decision.repo
        ledger.reminded(decision, request.id)
        await channel.push(request, request.meta)
      } catch (error) {
        log('reminder not delivered:', error.message)
      }
    }
  },
  Math.max(1000, Math.min(60000, (config.remindMinutes * 60000) / 4)),
)
reminders.unref()

// The SDK's stdio transport does not notice when Claude Code goes away (it only
// listens for data and errors). Without this, a crashed or killed session
// would leave an orphaned gateway behind that keeps the HTTP port busy.
process.stdin.on('end', () => shutdown('stdin ended'))
process.stdin.on('close', () => shutdown('stdin closed'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
