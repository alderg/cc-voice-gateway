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
// in a Docker container with its own clones, and with VOICE_GW_SCRATCH=1 in
// work folders for tasks without a repository, a watch on the pull requests they
// open, for checks and reviews, and optionally Telegram, for questions and
// approvals after the voice mode ended, and for alarms. At the controller
// levels clone-delete and unrestricted, also cloning and deleting in the
// worker root (folders.mjs). Over all of it, the kill switch (killswitch.mjs).
// And what is open, so that nothing is forgotten: decisions for the driver
// (ledger.mjs), the queue (workers.mjs), the requests (store.mjs). And the
// statistics of its running time and of all time (stats.mjs): for the
// controller's tool stats, /stats on Telegram, and the message when it shuts
// down.

import { CONTROLLER_LEVELS, EFFORTS, KILLSWITCH_MODES, ROOT, VERSION, WORKER_LIMITS, config, environmentWinsOver, limitValue } from './config.mjs'
import { FROM_FILE } from './settings.mjs'
import { log } from './log.mjs'
import { execFileSync } from 'node:child_process'
import { Store } from './store.mjs'
import { Auth } from './oauth.mjs'
import { startAdmin } from './admin.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'
import { Workers, gitState, hostGit, parkedText, planText, queueList } from './workers.mjs'
import { SettingsWatcher, othersText } from './live.mjs'
import { Restarter } from './restart.mjs'
import { PullWatcher } from './pulls.mjs'
import { TelegramCommands, TelegramFallback, loadTelegram } from './telegram.mjs'
import { KillSwitch, alarmText, offText } from './killswitch.mjs'
import { RunGuard } from './guard.mjs'
import { realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { DockerRunner, HostRunner } from './runners.mjs'
import { ACCESS_LEVELS, GitHubAccess } from './access.mjs'
import { FolderTools, clonedText } from './folders.mjs'
import { FunnelSwitch, staleText } from './funnel.mjs'
import { Alerts, IpGuard } from './ipguard.mjs'
import { Ledger, openItems, reminderText, startupText } from './ledger.mjs'
import { ScratchFolders, scratchProblem } from './workspaces.mjs'
import { Stats, shutdownText, telegramText } from './stats.mjs'

// How long a shutdown waits at most for its message on Telegram.
const FAREWELL_MS = 3000

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
// The statistics: all time from the file, this running time from zero. The
// session is this gateway's parent, the controller session's claude.
const stats = new Stats({ file: config.statsFile, session: process.ppid })
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
if (config.prDraft) log('workers open their pull requests as drafts (VOICE_GW_PR_DRAFT=1)')
if (limitValue('VOICE_GW_MAX_WORKERS_PER_REPO', config.maxWorkersPerRepoSetting) === null) {
  log(`VOICE_GW_MAX_WORKERS_PER_REPO=${config.maxWorkersPerRepoSetting} is no whole number from 1 to 100; 1 instead`)
}
// Both limits: every run of a repository counts toward the first. They also
// change while the gateway runs, with the settings file (live.mjs).
log(
  `worker limits: ${config.maxWorkers} runs at a time (VOICE_GW_MAX_WORKERS), ${config.maxWorkersPerRepo} per repository ` +
    `(VOICE_GW_MAX_WORKERS_PER_REPO)` +
    (config.maxWorkersPerRepo > 1 ? '; further runs of a repository work in git worktrees of their own' : '; one after the other'),
)
const runner = config.docker
  ? new DockerRunner({ container: config.docker, root: config.dockerRepos, dockerBin: config.dockerBin })
  : new HostRunner(config.workerRoot)
if (config.docker) {
  runner.check().then(({ folder, user, warnings }) => {
    log(`worker container ${config.docker}: repositories from host folder ${folder ?? '?'}, running as ${user ?? '?'}`)
    for (const warning of warnings) log(`worker container ${config.docker}: ${warning}`)
  })
}
// Work folders for tasks without a repository (workspaces.mjs): off unless
// VOICE_GW_SCRATCH=1, and off with a log line where the root is no place
// for them. On this computer, or with VOICE_GW_SCRATCH_DOCKER in a container
// of their own, which mounts the root.
let scratch = null
if (config.scratch) {
  const where = scratchProblem(config.scratchRoot, { gateway: ROOT, workerRoot: config.docker ? null : config.workerRoot })
  const problem =
    config.scratchDocker && config.scratchDocker === config.docker
      ? `VOICE_GW_SCRATCH_DOCKER=${config.scratchDocker} is the worker container; they need a container of their own`
      : where && `VOICE_GW_SCRATCH_ROOT=${config.scratchRoot} ${where}`
  if (problem) {
    log(`work folders off: ${problem}`)
  } else {
    const scratchRunner = config.scratchDocker
      ? new DockerRunner({ container: config.scratchDocker, root: config.dockerScratch, dockerBin: config.dockerBin })
      : new HostRunner(config.scratchRoot)
    scratch = new ScratchFolders({ runner: scratchRunner, root: config.scratchRoot, days: config.scratchDays })
    const kept = config.scratchDays ? `removed ${config.scratchDays} days after their last run` : 'kept for good'
    log(`work folders on: a new folder per task in ${config.scratchRoot}, ${scratch.where()}, ${kept}`)
  }
}
if (scratch?.runner.container) {
  const name = scratch.runner.container
  scratch.runner.check().then(({ folder, user, warnings }) => {
    log(`work folder container ${name}: work folders from host folder ${folder ?? '?'}, running as ${user ?? '?'}`)
    for (const warning of warnings) log(`work folder container ${name}: ${warning}`)
    const real = path => {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    }
    if (folder && real(folder) !== real(config.scratchRoot)) {
      log(`work folder container ${name}: it mounts ${folder}, not VOICE_GW_SCRATCH_ROOT=${config.scratchRoot}`)
    }
  })
}
// The containers the kill switch stops: the workers', and the work folders'.
const containers = [config.docker ? runner : null, scratch?.runner.container ? scratch.runner : null].filter(Boolean)
const workers = new Workers({
  runner,
  scratch,
  dockerBin: config.dockerBin,
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
  prDraft: config.prDraft,
  maxRuns: config.maxWorkers,
  maxPerRepo: config.maxWorkersPerRepo,
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
// Remote Control is the start script's, for the controller session only
// (config.mjs); the log says why the workers do not get it.
if (config.remoteControl) {
  log(
    'remote control: the start script connects the controller session (--remote-control); worker runs do not get ' +
      'it: they are headless (claude -p), and Claude Code connects only interactive sessions' +
      (containers.length ? '; in the containers, the token from claude setup-token cannot connect one either' : ''),
  )
}
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
let settings = null // the watch on the settings file (live.mjs)
let farewell = null // without the watchdog: the message that the gateway shuts down (below)
let shuttingDown = false
// planned: false when the gateway ends by itself for an error (its port is
// taken), which gets no message with the statistics.
function shutdown(reason, code = process.exitCode ?? 0, { planned = true } = {}) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down:', reason)
  http?.close()
  admin?.close()
  workers.close() // runs go on; the next gateway picks them up
  settings?.close()
  guard.close()
  telegramCommands?.close()
  funnel?.close()
  pulls.close() // so do the watches on pull requests
  store.save() // the requests, with what the voice client has read
  // The last save of the statistics, with the end of this running time,
  // which the watchdog's message waits for (scripts/stats.mjs).
  const last = stats.close()
  const told = planned ? farewell?.(reason, last) : null
  // Give pending log writes and HTTP responses a moment, then leave; a
  // message on its way gets a few seconds at most.
  Promise.race([told ?? null, delay(FAREWELL_MS, null, { ref: false })]).finally(() =>
    setTimeout(() => process.exit(code), 200).unref(),
  )
}

// Restarting the controller by voice, through the watchdog (restart.mjs).
const restarter = new Restarter({ store, workers, ledger, secretsDir: config.secretsDir })
// Under the watchdog, as this session started: the watchdog then sends the
// message when the gateway shuts down (scripts/start-controller.sh), and
// none after a crash; without it, the gateway itself (farewell).
const watched = restarter.watchdog().ok
// What this start came after, and the events the statistics count.
stats.started({ after: restarter.restartedReason() })
stats.watch({ store, ledger, workers, guard, pulls, killswitch })

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
  stats,
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
    stats.reported(task, opened)
    const request = store.createRequest(workers.resultText(task, opened), {
      origin: 'worker',
      worker: { repo: task.repo, task: task.id },
    })
    // trusted="no": the result carries whatever the run read (channel.mjs).
    // git, or files for a work folder: the gateway's look, in its words,
    // without the run's.
    // worktree and requeued for a run in a worktree of its own (workers.mjs).
    request.meta = { worker: task.repo, task: task.id, outcome: task.state, ...workers.checkMeta(task), ...workers.runMeta(task), trusted: 'no' } // for sending it again
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
  // /stats: this running time in detail; /stats all: all time.
  telegramCommands.on('stats', ({ all }) => say(telegramText(stats.snapshot(), { host: hostname(), allTime: all })))
  // Without the watchdog the gateway itself says that it shuts down, with
  // its statistics. Under the watchdog the watchdog says it, as only it knows
  // whether the session was stopped, restarted or crashed; a crash keeps its
  // own message (scripts/start-controller.sh).
  if (!watched) {
    farewell = (reason, snapshot) => {
      const why = /^SIG/.test(reason) ? `on ${reason}` : 'the controller session ended'
      return telegram
        .send(shutdownText(snapshot, { host: hostname(), why }))
        .then(() => log('telegram sent: the gateway shuts down, with its statistics'))
        .catch(error => log('shutdown message not sent by Telegram:', error.message))
    }
  }
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
  for (const container of containers) {
    const ok = await container.lockdown()
    const what = container === runner ? 'worker container' : 'work folder container'
    log(`kill switch: ${what} ${container.container} ${ok ? 'stopped' : 'not stopped (was it running?)'}`)
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
// it was started, and so is a work folder container with a writable mount.
if (containers.length) {
  setInterval(async () => {
    if (!killswitch.locked) return
    for (const container of containers) {
      const mounts = await container.mounts()
      if (mounts?.running && mounts.writable) {
        const what = container === runner ? 'worker container' : 'work folder container'
        const mount = container === runner ? '/repos' : 'mount of the work folders'
        log(`kill switch: ${what} ${container.container} runs with a writable ${mount}; stopping it`)
        await container.lockdown()
      }
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
  shutdown(`voice port ${config.port} in use`, 1, { planned: false })
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

// A higher limit of runs per repository than the queue was planned for, at
// the start or in the settings file while the gateway runs: the controller
// hears which queued tasks could now run next to others, and marks them
// with order_queue, without the driver (planText). For the controller only
// (origin "gateway"); trusted="no", as the tasks may quote a worker.
let planning = Promise.resolve()
function sendPlan(why, note = '') {
  planning = planning.then(() => deliverPlan(why, note)) // one after the other: a plan goes once
  return planning
}

async function deliverPlan(why, note) {
  if (!workers.replan) return
  try {
    await channel.ready
    const plan = workers.replan
    if (!plan) return
    const request = store.createRequest(planText(plan, why) + note, { origin: 'gateway' })
    await channel.push(request, { kind: 'plan', trusted: 'no' })
    workers.planned()
  } catch (error) {
    log('queue plan not delivered:', error.message)
  }
}

// The worker limits while the gateway runs (live.mjs): a change in the
// settings file applies at once. Runs going always run to the end.
settings = new SettingsWatcher({
  file: config.settingsFile,
  limits: { VOICE_GW_MAX_WORKERS: workers.maxRuns, VOICE_GW_MAX_WORKERS_PER_REPO: workers.maxPerRepo },
  wins: environmentWinsOver, // only values set from outside win (settings.mjs)
}).start()
if (process.env[FROM_FILE] === undefined && Object.keys(WORKER_LIMITS).some(name => process.env[name] !== undefined)) {
  log(
    `settings: the environment does not say which values came from the settings file (${FROM_FILE}, set by ` +
      "scripts/settings.sh); a worker limit there counts as the file's while it equals the file's value at the start",
  )
}
settings.on('change', ({ limits, changed, others }) => {
  if (!Object.keys(changed).length) return
  const { was, plan } = workers.setLimits({
    maxRuns: limits.VOICE_GW_MAX_WORKERS,
    maxPerRepo: limits.VOICE_GW_MAX_WORKERS_PER_REPO,
  })
  log(
    `worker limits from the settings file, at once: ${workers.maxRuns} runs at a time (was ${was.maxRuns}), ` +
      `${workers.maxPerRepo} per repository (was ${was.maxPerRepo})` +
      (workers.maxPerRepo < was.maxPerRepo ? '; runs going run to the end, nothing new starts above the limit' : '') +
      (plan ? '; the controller hears which queued tasks could run next to others' : ''),
  )
  if (plan) sendPlan('in the settings file just now, while the gateway runs', othersText(others))
})

channel.ready.then(async () => {
  connected = true
  try {
    const items = openItems({ ledger, workers, store, interrupted: store.interrupted })
    const summary = store.createRequest(startupText(items), { origin: 'gateway' })
    await channel.push(summary, { kind: 'summary', trusted: 'no' })
  } catch (error) {
    log('start-up summary not delivered:', error.message)
  }
  await sendPlan('since the queue was planned, before this start')
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
