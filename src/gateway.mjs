#!/usr/bin/env node
// Voice gateway entry point.
//
// Claude Code starts this file as an MCP server (see controller/.mcp.json).
// One process, two faces:
//   stdio  -> Claude Code controller session (a channel: push events, reply tool, permission relay)
//   HTTP   -> voice assistant in the car (MCP tools: status, send, ask, get_reply, approve,
//             emergency_stop, unlock),
//             behind an OAuth sign-in, and through the tunnel only from Anthropic's
//             addresses (ipguard.mjs)
// plus a Unix socket for scripts/pair.mjs (pairing codes, connections), the
// workers: headless Claude Code runs in the repositories next to this one, or
// in a Docker container with its own clones, and with VOICE_GW_SCRATCH=1 in
// work folders for tasks without a repository, a watch on the pull requests they
// open, for checks and reviews, with fixes for review comments queued without
// asking (VOICE_GW_AUTO_FIX_REVIEWS), and optionally Telegram, for approval
// requests at once, questions after the voice mode ended, alarms, and the
// driver's answers, requests and approvals typed there or pressed on their
// buttons (telegram.mjs). Approval grants, which answer a kind of the
// controller's prompts for a while, through its hook (approval-grants.mjs). At the
// controller levels clone-delete and unrestricted, also cloning and deleting
// in the worker root (folders.mjs). Over all of it, the kill switch (killswitch.mjs).
// And what is open, so that nothing is forgotten: decisions for the driver
// (ledger.mjs), the queue (workers.mjs), the requests (store.mjs). And the
// statistics of its running time and of all time (stats.mjs): for the
// controller's tool stats, /stats on Telegram, and the message when it shuts
// down.

import {
  CONTROLLER_LEVELS,
  EFFORTS,
  KILLSWITCH_MODES,
  ROOT,
  VERSION,
  WORKER_LIMITS,
  autoCompactValue,
  cacheTtlValue,
  config,
  environmentWinsOver,
  limitValue,
} from './config.mjs'
import { FROM_FILE } from './settings.mjs'
import { log, preview } from './log.mjs'
import { execFileSync } from 'node:child_process'
import { Store } from './store.mjs'
import { Auth } from './oauth.mjs'
import { startAdmin } from './admin.mjs'
import { HookApprovals } from './approvals.mjs'
import { startChannel } from './channel.mjs'
import { startVoiceHttp } from './voice.mjs'
import { Workers, auditSummary, duration, gitState, hostGit, parkedText, planText, queueList } from './workers.mjs'
import { Digest, digestMeta, digestText, fixLine, foldedText, pullKey, routineFix, routineNews } from './digest.mjs'
import { SettingsWatcher, othersText } from './live.mjs'
import { Restarter } from './restart.mjs'
import { PullWatcher } from './pulls.mjs'
import {
  INPUT_OFF,
  TelegramAnswers,
  TelegramCommands,
  TelegramFallback,
  TelegramInputLog,
  driverId,
  loadTelegram,
  scrubEnv,
  secureSecrets,
} from './telegram.mjs'
import { KillSwitch, PIN_DIGITS, PIN_MINUTES, PIN_TRIES, VoiceUnlock, alarmText, offText } from './killswitch.mjs'
import { RunGuard } from './guard.mjs'
import { GRANTS_SETTING, GrantLedger, PathGrants } from './grants.mjs'
import { ApprovalGrants, actorText, filePathOf } from './approval-grants.mjs'
import { realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DockerRunner, HostRunner } from './runners.mjs'
import { ACCESS_LEVELS, GitHubAccess } from './access.mjs'
import { FolderTools, clonedText } from './folders.mjs'
import { FunnelSwitch, staleText } from './funnel.mjs'
import { Alerts, IpGuard } from './ipguard.mjs'
import { Ledger, decisionLine, openItems, reminderText, startupText } from './ledger.mjs'
import { RUN_FOLDERS, ScratchFolders, scratchProblem } from './workspaces.mjs'
import { Stats, shutdownText, telegramText } from './stats.mjs'
import { Standby } from './standby.mjs'
import { Presence } from './presence.mjs'
import { Limits, TranscriptWatch, accountName, clock } from './limits.mjs'
import { Night, morningText, parseUntil } from './night.mjs'
import { Orders } from './orders.mjs'

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
const store = new Store({ file: config.requestsFile, keep: id => ledger.needs(id) })
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
  if (killswitch.mode !== 'auto') log('kill switch: the setting does not unlock it; only scripts/unlock.mjs or the driver in voice mode does')
}
const auth = new Auth({ stateFile: config.oauthStateFile, allowedHosts: config.oauthHosts })
// The standby after the connector was disconnected (standby.mjs), and which
// gateway this is for the voice assistant, active or not (presence.mjs).
const standby = new Standby({
  file: config.standbyFile,
  auth,
  enabled: config.disconnectStandby,
  unusedMs: config.disconnectUnusedMinutes * 60000,
  graceMs: config.disconnectGraceMinutes * 60000,
})
// The waits for the Claude usage limit (limits.mjs): per account, kept across
// a restart; its events are heard once everything is set up (below).
const limits = new Limits({ file: config.limitsFile })
const presence = new Presence({ name: config.gatewayName, standbySetting: config.standby, killswitch, standby, limits })
// Night mode (night.mjs): by the quiet hours, or the driver's "good night";
// its events too are heard once everything is set up (below).
const night = new Night({ hours: config.quietHours, file: config.nightFile, pollMs: config.nightPollSeconds * 1000 })
if (config.quietHours && !night.hours) log(`VOICE_GW_QUIET_HOURS=${config.quietHours} is no range such as 23:00-07:30; night mode only when the driver says good night`)
else log(night.hours ? `night mode in the quiet hours ${config.quietHours}, and when the driver says good night` : 'night mode when the driver says good night (no quiet hours set)')
// Standing orders (orders.mjs): what the controller may dispatch without
// fresh words of the driver, at night say; the kill switch ends them.
const orders = new Orders({ file: config.ordersFile })
log(
  `gateway ${presence.label}${config.standby ? ', on standby by its settings (VOICE_GW_STANDBY=1): the connector hands nothing over' : ''}; ` +
    `standby when the connector is disconnected: ${config.disconnectStandby ? 'on' : 'off (VOICE_GW_DISCONNECT_STANDBY=0)'}`,
)
if (standby.active) log(`starting in standby since ${new Date(standby.state.at).toISOString()}: ${standby.state.reason}; a new sign-in ends it`)
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
if (cacheTtlValue(config.workerCacheTtlSetting) === null) {
  log(`VOICE_GW_WORKER_CACHE_TTL=${config.workerCacheTtlSetting} is not 1h, 5m or auto; 1h instead`)
}
if (autoCompactValue(config.workerAutoCompactSetting) === null) {
  log(`VOICE_GW_WORKER_AUTOCOMPACT=${config.workerAutoCompactSetting} is no size from 100k to 1m tokens, nor auto; 300k instead`)
}
// What the workers' runs cost: their prompt cache, and when their sessions
// are compacted (config.mjs).
log(
  `worker sessions: prompt cache ${config.workerCacheTtl || "Claude Code's own (5m on usage credits)"} ` +
    `(VOICE_GW_WORKER_CACHE_TTL), compacted at ` +
    `${config.workerAutoCompact ? `${config.workerAutoCompact / 1000}k tokens` : "Claude Code's own window"} ` +
    '(VOICE_GW_WORKER_AUTOCOMPACT)',
)
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
// The grants the driver gives for a while, in one ledger (grants.mjs):
// approval grants for the controller's prompts now, temporary path grants for
// workers later. Those for one subagent end with this start, as their agents
// ended with the session before; the controller's keep their time.
const grantLedger = new GrantLedger({ file: config.grantsFile })
grantLedger.endAll('the controller session restarted, and its subagents with it', grant => ['agent', 'teammate'].includes(grant.actor?.who))
// Folders a repository's workers on this computer may write to as in the
// repository (grants.mjs), checked strictly; an entry that is no such folder
// is ignored with a log line. They also change with the settings file while
// the gateway runs (below). In the container a path of this computer means
// nothing: there they count for nothing.
const grants = new PathGrants({
  setting: config.pathGrants,
  root: config.workerRoot,
  gateway: ROOT,
  guarded: [config.stateDir, config.secretsDir, config.scratchRoot, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')],
  ledger: grantLedger,
  log,
})
// Approval grants (approval-grants.mjs): the driver allows a kind of file
// write by one asker in one folder for a while, and the controller's hook
// answers such prompts itself. Only with the permission relay.
const approvalGrants = new ApprovalGrants({
  ledger: grantLedger,
  pathGrants: grants,
  root: config.workerRoot,
  gateway: ROOT,
  guarded: [config.stateDir, config.secretsDir, ...(config.logFile ? [dirname(config.logFile)] : [])],
  killswitch,
  standby,
  enabled: config.approvalGrants && config.permissionRelay,
  defaultMinutes: config.grantMinutes,
  maxMinutes: config.grantMaxMinutes,
  maxUses: config.grantMaxUses,
  log,
})
log(
  approvalGrants.enabled
    ? `approval grants on: an approval prompt for a file write offers to allow all such writes of its asker in its folder for ` +
        `${approvalGrants.defaultMinutes} minutes (at most ${approvalGrants.maxMinutes}, ${approvalGrants.maxUses} writes), and the ` +
        "controller's hook answers them; never the shell, settings, hooks, .git or anything hidden but a project's memory files" +
        (grantLedger.lines().length ? `; holding: ${grantLedger.active().map(grant => grant.id).join(', ')}` : '')
    : `approval grants off (${config.permissionRelay ? 'VOICE_GW_APPROVAL_GRANTS=0' : 'the permission relay is off'}): every prompt asks`,
)
if (standby.active) grantLedger.endAll('the gateway is in a standby')
function grantsLog(when) {
  const text = grants.text()
  if (!text && !when) return
  log(
    `path grants (${GRANTS_SETTING})${when ? `, ${when}` : ''}: ${text || 'none'}` +
      (text && config.docker ? `; ignored, as workers run in the container ${config.docker}` : ''),
  )
}
grantsLog()
const workers = new Workers({
  runner,
  scratch,
  dockerBin: config.dockerBin,
  access: config.docker
    ? new GitHubAccess({ tokenFile: config.githubTokenFile, apiBase: config.githubApi, forced: config.access })
    : null,
  killswitch,
  standby,
  limits,
  night,
  ledger,
  stateDir: config.stateDir,
  claudeBin: config.claudeBin,
  ghBin: config.ghBin,
  model: config.workerModel,
  effort: EFFORTS.includes(config.workerEffort) ? config.workerEffort : '',
  cacheTtl: config.workerCacheTtl,
  autoCompact: config.workerAutoCompact,
  freshFixes: config.autoFixFresh,
  prDraft: config.prDraft,
  maxRuns: config.maxWorkers,
  maxPerRepo: config.maxWorkersPerRepo,
  timeoutMinutes: config.workerTimeoutMinutes,
  runFolderDays: config.runFolderDays,
  grants,
})
log(
  `run folders of the workers' runs: in ${RUN_FOLDERS} in the repositories folder${config.docker ? ` of the container ${config.docker}` : ''}, ` +
    (config.runFolderDays ? `removed ${config.runFolderDays} days after their last run` : 'kept for good (VOICE_GW_RUN_FOLDER_DAYS=0)'),
)
const guard = new RunGuard({
  workers,
  runner,
  killswitch,
  ghBin: config.ghBin,
  limits: {
    maxEdits: config.killMaxEdits,
    maxFiles: config.killMaxFiles,
    maxLines: config.killMaxLines,
    maxHelperFiles: config.killMaxHelperFiles,
  },
  allowed: config.killAllowPaths,
  grants,
  quarantine: config.quarantineDir,
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

// Review comments on those pull requests, fixed without asking: the watcher
// queues the fix itself, through the workers' queue (Workers.reviewFix).
const pulls = new PullWatcher({
  ghBin: config.ghBin,
  stateFile: config.pullsStateFile,
  pollSeconds: config.prPollSeconds,
  watchHours: config.prWatchHours,
  autoFix: config.autoFixReviews ? { rounds: config.autoFixRounds, queue: fix => workers.reviewFix(fix) } : null,
  bots: config.reviewBots,
})
pulls.paused = standby.active // no news, no fixes in a standby
// Routine news about them gathered into one digest (digest.mjs), which goes
// once it has been quiet for a while; 0 keeps one event each.
const digest = new Digest({ file: config.digestFile, quietMinutes: config.reviewDigestMinutes, maxMinutes: config.reviewDigestMaxMinutes })
log(
  digest.enabled
    ? `routine news about workers' pull requests: one digest after ${config.reviewDigestMinutes} quiet minutes, at most ` +
        `${Math.max(config.reviewDigestMinutes, config.reviewDigestMaxMinutes)} after its first item (VOICE_GW_REVIEW_DIGEST)` +
        (digest.items.length ? `; ${digest.items.length} waiting from before` : '')
    : "routine news about workers' pull requests: one event each (VOICE_GW_REVIEW_DIGEST=0)" +
        (digest.items.length ? `; ${digest.items.length} gathered before go as one digest` : ''),
)
log(
  config.autoFixReviews
    ? `review comments on workers' pull requests: fixed without asking, at most ${config.autoFixRounds} automatic ` +
        `rounds per pull request, for collaborators and the review bots ${config.reviewBots.join(', ')} (VOICE_GW_AUTO_FIX_REVIEWS), ` +
        (config.autoFixFresh
          ? 'each in a new session (VOICE_GW_AUTO_FIX_FRESH)'
          : 'each in the session of the run that pushed (VOICE_GW_AUTO_FIX_FRESH=0)')
    : "review comments on workers' pull requests: fixed only on the driver's word (VOICE_GW_AUTO_FIX_REVIEWS=0)",
)

let http
let admin
let funnel = null
let settings = null // the watch on the settings file (live.mjs)
let transcript = null // the watch on the controller's own transcript, for the usage limit (limits.mjs)
let fallback = null // the Telegram fallback, with Telegram set up
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
  hookApprovals.close() // the hooks waiting now let their prompts open at the terminal
  workers.close() // runs go on; the next gateway picks them up
  settings?.close()
  guard.close()
  telegramCommands?.close()
  funnel?.close()
  standby.close()
  limits.close()
  night.close()
  transcript?.close()
  pulls.close() // so do the watches on pull requests
  digest.close() // its items are in its file already
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

// The approval requests of the controller's teammates, which the channel
// never gets: its PermissionRequest hook hands them over this socket
// (approvals.mjs). Listed and answered like the channel's, and the verdict
// goes back to the hook.
const hookApprovals = new HookApprovals({ store, killswitch, relay: config.permissionRelay, grants: approvalGrants })
if (await hookApprovals.listen(config.approvalSocket)) {
  log(
    config.permissionRelay
      ? "approval socket ready: the approval requests of the controller's teammates (agents spawned with a name) reach the driver too, through its PermissionRequest hook"
      : "approval socket ready, but the permission relay is off: the controller's hook leaves its teammates' approval requests at the terminal",
  )
}

const channel = await startChannel(store, {
  hookApprovals,
  approvalGrants,
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
  // While the controller waits for the usage limit, events for it are held;
  // a tool call of it ends the wait (limits.mjs, below).
  hold: () => Boolean(limits.active('controller')),
  alive: () => limits.end('controller', 'it answered again'),
  notes: () => openNotes(),
  night,
  orders,
})

const capital = text => `${text[0].toUpperCase()}${text.slice(1)}`

// What the gateway waits for or how it works now, for open_items and the
// start-up summary: night mode, the standing orders, the grants that hold,
// the usage limit waits.
function openNotes() {
  const notes = night.text() ? [`${capital(night.text())}.`] : []
  const digested = digest.note() ? [`${capital(digest.note())}.`] : []
  const granted = grantLedger.lines()
  const endHint = granted.length ? ['end_grant ends them when the driver says "Freigaben zurücknehmen".'] : []
  return [...notes, ...orders.lines(), ...granted, ...endHint, ...limits.list().map(item => `${capital(item.text)}.`), ...digested]
}

// A grant the driver just gave also allows the approvals open now that it
// covers: their yes for all such writes covers those too. Then the chat hears
// of it, unless they gave it there with "yes 20", whose answer says so.
approvalGrants.on('made', grant => {
  for (const permission of store.openPermissions()) {
    if (!permission.prompt || !approvalGrants.coversPrompt(grant, permission.prompt)) continue
    if (!store.resolvePermission(permission.code, 'allow', 'grant', grant.id)) continue
    grantLedger.use(grant)
    log(
      `permission allowed by grant ${grant.id}`,
      `code=${permission.code}`,
      `tool=${permission.toolName}`,
      `path=${preview(filePathOf(permission.prompt.input), 160)}`,
      `(${actorText(permission.prompt.actor)}, open when the grant was made)`,
    )
    channel.sendVerdict(permission.code, 'allow').catch(error => log(`verdict of grant ${grant.id} not sent:`, error.message))
  }
  if (grant.via === 'telegram' && grant.fromApproval) return
  try {
    say(
      `cc-voice-gateway on ${hostname()}: granted ${grant.id}, ${grant.fromApproval ? 'by voice' : "on your words, asked ahead by the controller"}: ` +
        `all ${grant.label}, until ${clock(grant.until)}, at most ${grant.maxUses} writes. Such approval prompts no longer ask until then. ` +
        'Send "revoke" or "Freigaben zurücknehmen" to end it.',
    )
  } catch (error) {
    log(`grant ${grant.id}: not told on Telegram:`, error.message) // made before Telegram was set up
  }
})

// When a run ends, the gateway looks at its checkout (Workers.audit), and the
// result goes to the controller as a channel event, with what the gateway saw
// and the pull requests the run opened or worked on. The controller's reply
// to it reaches the driver as news. A fix the gateway queued for review
// comments that changed nothing is routine: it waits for the digest
// (digest.mjs). Any other result takes along the routine items of its pull
// requests that wait there.
const reporting = new Set()
workers.on('finished', async task => {
  // In a standby the result waits; the poll offers it again after it.
  if (standby.active || reporting.has(task.id)) return
  reporting.add(task.id)
  try {
    await channel.ready
    await workers.audit(task)
    const opened = await pulls.fromRun(task).catch(error => {
      log('pull requests of', task.id, 'not checked:', error.message)
      return []
    })
    stats.reported(task, opened)
    const record = () =>
      night.record({ repo: task.repo, task: task.id, outcome: task.state, pulls: opened.map(pull => pull.number), result: task.result ?? '' })
    if (digest.enabled && task.review) {
      // Whether it pushed to its pull request: its head moved during the run.
      const pushed = pulls.changedSince(task.review.slug, task.review.number, task.startedAt, task.finishedAt)
      if (routineFix(task, { pushed, clean: auditSummary(task.audit) === 'clean' })) {
        digest.add({
          key: `task:${task.id}`,
          pull: pullKey(task.review.slug, task.review.number),
          worker: task.repo,
          line: fixLine(task, duration(task.finishedAt - task.startedAt)),
          fix: task.queued ?? null,
          task: task.id,
        })
        workers.markReported(task)
        record()
        return
      }
    }
    const own = [...opened.map(pull => pullKey(task.slug, pull.number)), ...(task.review ? [pullKey(task.review.slug, task.review.number)] : [])]
    const folded = task.slug && own.length ? digest.take({ pulls: own }) : []
    const request = store.createRequest(workers.resultText(task, opened) + foldedText(folded), {
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
    // In the night, for the morning summary (night.mjs).
    record()
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
// too, and the driver as news; with fix, the fix the gateway queued for
// review comments. Routine news waits for the digest (digest.mjs); other news
// takes along what of its pull request waits there.
let newsCount = 0
pulls.on('news', async news => {
  try {
    const pull = pullKey(news.slug, news.number)
    if (digest.enabled && routineNews(news)) {
      digest.add({
        key: `news:${pull}:${Date.now()}:${++newsCount}`,
        pull,
        worker: news.worker,
        line: `"${preview(news.title ?? '', 60)}": ${news.brief}`,
        fix: news.fix ?? null,
      })
      return
    }
    await channel.ready
    const request = store.createRequest(news.text + foldedText(digest.take({ pulls: [pull] })), { origin: 'worker' })
    // trusted="no": it quotes what others wrote on GitHub.
    request.meta = { worker: news.worker, repo: news.slug, pull_request: String(news.number), kind: news.kind, trusted: 'no' }
    if (news.fix) request.meta.fix = news.fix
    await channel.push(request, request.meta)
  } catch (error) {
    log('pull request news not delivered:', error.message)
  }
})

// Telegram, if set up, reaches the driver with approval requests and alarms at
// once, and with questions once the voice mode has ended.
const telegram = loadTelegram({
  tokenFile: config.telegramTokenFile,
  chatIdFile: config.telegramChatIdFile,
  apiBase: config.telegramApi,
})
// The bot token: its file 0600 in the 0700 secrets folder, and in no
// variable that a worker or anything else the gateway starts inherits.
let inputLog = null
if (telegram) {
  for (const note of secureSecrets({ dir: config.secretsDir, tokenFile: config.telegramTokenFile, files: [config.telegramChatIdFile] })) log(note)
  const removed = scrubEnv(process.env, [telegram.token])
  if (removed.length) {
    log(`telegram: removed ${removed.join(', ')} from the environment: ${removed.length === 1 ? 'it holds' : 'they hold'} the bot token, which nothing the gateway starts may inherit`)
  }
  // Every message the bot receives, accepted, refused or ignored.
  inputLog = new TelegramInputLog({ file: config.telegramInputLog, secrets: [telegram.token] })
}
// The unlock in voice mode (killswitch.mjs): a PIN to the driver's own
// private chat with the bot, never quoted to the controller, taken back only
// by the voice connector's tool unlock, and not in a standby. Without
// Telegram, or with a chat that is no person's, only scripts/unlock.mjs
// unlocks. The containers the lock stopped stay stopped, as after the script.
const unlock = new VoiceUnlock({
  killswitch,
  send: telegram && driverId(telegram.chatId) ? text => telegram.send(text, { quote: false }) : null,
  paused: () => Boolean(presence.state().standby),
  host: hostname(),
  stopped: containers.map(container =>
    container === runner
      ? `The worker container ${container.container} stays stopped: start it again with scripts/start-workers-container.sh.`
      : `The work folder container ${container.container} stays stopped: start it again with scripts/start-workers-container.sh --scratch.`,
  ),
})
log(
  unlock.send
    ? `kill switch: the driver can unlock it in voice mode, with a PIN of ${PIN_DIGITS} digits sent to their Telegram chat, ` +
        `valid ${PIN_MINUTES} minutes; ${PIN_TRIES} wrong ones block that for the lock. scripts/unlock.mjs always unlocks`
    : 'kill switch: no unlock in voice mode, which needs Telegram for its PIN; only scripts/unlock.mjs unlocks',
)
let telegramCommands = null
// The Funnel on demand (funnel.mjs): from Telegram, and off by itself when idle.
const say = text => telegram?.send(text).catch(error => log('telegram message not sent:', error.message)) ?? Promise.resolve()
funnel = new FunnelSwitch({ script: config.funnelScript, store, idleMinutes: config.funnelIdleMinutes, say })
if (config.funnelIdleMinutes) {
  log(`funnel auto-off: ${config.funnelIdleMinutes} minutes after the last voice call${telegram ? '' : '; without Telegram, only at the computer on again'}`)
}
if (telegram) {
  const record = entry => inputLog?.record(entry)
  const reply = (text, replyTo = null) =>
    telegram.send(text, { replyTo }).catch(error => log('telegram message not sent:', error.message))
  // Telegram as input, only when the driver turned it on (off by default):
  // their answers to questions, typed in the chat as a Reply or with the
  // question's code (VOICE_GW_TELEGRAM_ANSWERS), and their other messages as
  // requests (VOICE_GW_TELEGRAM_REQUESTS), to the controller like answers and
  // requests by voice, never past a locked kill switch or a standby. Push,
  // merge, restart and delete count there too, and with answers on, their
  // yes or no to an approval request goes to Claude Code as one by voice
  // does, unless VOICE_GW_TELEGRAM_CONFIRM=0 keeps them with the voice.
  const answers =
    config.telegramAnswers === 'off' && !config.telegramRequests
      ? null
      : new TelegramAnswers({
          store,
          ledger,
          mode: config.telegramAnswers,
          requests: config.telegramRequests,
          confirm: config.telegramConfirm,
          killswitch,
          presence,
          record,
          push: async request => {
            await channel.ready
            await channel.push(request, request.meta)
          },
          // Without the permission relay, Claude Code sends no approval requests here.
          verdict: config.permissionRelay
            ? async (code, behavior) => {
                await channel.ready
                await channel.sendVerdict(code, behavior)
              }
            : null,
          say: reply,
          held: () => {
            const wait = limits.active('controller')
            return wait ? `The controller waits for the usage limit until ${clock(wait.until)} and reads it then.` : ''
          },
          // "yes 20" on an approval request that offers a grant.
          grants: approvalGrants.enabled ? approvalGrants : null,
          // The notice over a button the driver pressed.
          pressed: (id, text) => telegram.answerPress(id, text),
        })
  // A value it does not know counts as off, so that a typo opens nothing.
  const answersSetting = config.telegramAnswersSetting.trim().toLowerCase()
  if (answersSetting === 'other') {
    log('VOICE_GW_TELEGRAM_ANSWERS=other is the same as 1 now; VOICE_GW_TELEGRAM_CONFIRM decides about push, merge, restart and delete')
  } else if (answersSetting && !['1', '0'].includes(answersSetting)) {
    log(`VOICE_GW_TELEGRAM_ANSWERS=${config.telegramAnswersSetting} is not 1 or 0; 0 (off) instead`)
  }
  log(
    config.telegramAnswers === 'on'
      ? 'telegram answers on (VOICE_GW_TELEGRAM_ANSWERS=1): a Reply to a question, or a message with its code, reaches the controller ' +
          'as the driver\'s answer' +
          (config.telegramConfirm ? '' : ', except for push, merge, restart and delete decisions, which must be confirmed by voice')
      : 'telegram answers off (VOICE_GW_TELEGRAM_ANSWERS not 1, off by default): questions are answered by voice only',
  )
  if (config.telegramRequestsSetting.trim() && !['1', '0'].includes(config.telegramRequestsSetting.trim())) {
    log(`VOICE_GW_TELEGRAM_REQUESTS=${config.telegramRequestsSetting} is not 1 or 0; 0 (off) instead`)
  }
  log(
    config.telegramRequests
      ? 'telegram requests on (VOICE_GW_TELEGRAM_REQUESTS=1): any other message from the chat reaches the controller as a request of the driver\'s, and its replies come back there'
      : 'telegram requests off (VOICE_GW_TELEGRAM_REQUESTS not 1, off by default): a message that is no command and no answer is not passed on',
  )
  // Whose messages count: the driver's own, in their private chat with the
  // bot. Its id is their user id, so the chat id is all the setup stores.
  const driver = driverId(telegram.chatId)
  log(
    driver
      ? `telegram input only from the driver's user id ${driver}, in their private chat with the bot (telegram_chat_id: in a private ` +
          'chat the chat id is the user id); groups, channels, other senders and bots are ignored without an answer, forwarded, ' +
          `edited and non-text messages refused; every message in ${config.telegramInputLog}`
      : 'telegram: telegram_chat_id names no private chat (the id of a group or a channel is negative), so no message counts, ' +
          'not even /stop; choose your private chat with the bot in the setup',
  )
  // A value it does not know keeps them with the voice, so that a typo lets nothing more through.
  if (config.telegramConfirmSetting.trim() && !['1', '0'].includes(config.telegramConfirmSetting.trim())) {
    log(`VOICE_GW_TELEGRAM_CONFIRM=${config.telegramConfirmSetting} is not 1 or 0; 0 (only by voice) instead`)
  }
  if (answers && !config.telegramConfirm) {
    log('telegram: push, merge, restart, delete and approvals take the driver\'s voice (VOICE_GW_TELEGRAM_CONFIRM=0); words typed in Telegram settle none of them')
  } else if (answers) {
    log(
      'telegram: push, merge, restart and delete count by Telegram as by voice (VOICE_GW_TELEGRAM_CONFIRM=1, the default)' +
        (answers.approves()
          ? '; approval requests are answered there too, with a yes or a no'
          : config.telegramAnswers === 'off'
            ? '; approval requests are answered by voice, as answers by Telegram are off'
            : '; approval requests are answered by voice, as the permission relay is off'),
    )
  }
  // Questions paused in a standby, and in night mode, where Telegram carries
  // alarms and approval requests only; what the night left, the morning
  // summary names (night.mjs). Approval requests, and the controller's
  // replies to an answer or a request typed there, wait only in a standby.
  fallback = new TelegramFallback(store, {
    send: (text, options) => telegram.send(text, options),
    afterSeconds: config.telegramAfterSeconds,
    paused: () => standby.active || night.active(),
    held: () => standby.active,
    answerable: request => answers?.accepts(request) ?? false,
    approvable: () => answers?.approves() ?? false,
    // Buttons under approval requests and questions, where they are answered
    // there; a question's give way once its decisions are answered or closed.
    edit: (id, markup) => telegram.editButtons(id, markup),
    ledger,
  })
  log(`telegram fallback ready: approval requests at once, questions after ${config.telegramAfterSeconds} s without a voice call`)
  // Inbound, only from the driver in the configured private chat: the kill
  // switch, the Funnel, night mode, the statistics, and with Telegram input
  // on, answers to questions and approval requests, and requests. With
  // requests, a Reply to a message that asks nothing, news or an alarm, is
  // read like any message: a command is a command there too. A Reply to a
  // message of the bot's that this gateway did not send is never quoted.
  telegramCommands = new TelegramCommands(telegram, {
    pollSeconds: config.telegramPollSeconds,
    answers: Boolean(answers),
    record,
    // The unlock PIN, typed there: masked, and not passed on.
    masked: text => unlock.masked(text),
    known: id => telegram.sent(id) || (answers?.asks(id) ?? false),
    ...(config.telegramRequests ? { asks: id => answers.asks(id) } : {}),
  }).start()
  if (answers) telegramCommands.on('answer', message => answers.route(message))
  // A button under an approval request or a question; without Telegram
  // input none is shown, and one pressed on an old message hears why.
  telegramCommands.on('press', press => {
    if (answers) return answers.press(press)
    record({ ...press.seen, decision: 'refused', why: INPUT_OFF })
    telegram.answerPress(press.id, INPUT_OFF).catch(error => log('telegram press not answered:', error.message))
  })
  // The driver's own message that does not count, and why.
  telegramCommands.on('refused', ({ why, messageId }) => reply(`Not passed on: ${why}`, messageId))
  telegramCommands.on('stop', ({ text }) => {
    const state = killswitch.trip({ trigger: 'telegram', reason: `"${text}" on Telegram` })
    if (!state && !killswitch.locked) say(`cc-voice-gateway on ${hostname()}: "${text}" locked nothing. ${offText()}`)
  })
  telegramCommands.on('funnel', ({ action }) => funnel.command(action))
  // Night mode on (/night, "good night", /night 09:00 with an end) or off
  // (/back, "I'm back"); off, the morning summary follows (night.mjs, below).
  telegramCommands.on('away', ({ on, until }) => {
    if (on) {
      const named = until ? parseUntil(until) : null
      if (named?.error) return say(`cc-voice-gateway on ${hostname()}: night mode unchanged. ${named.error}`)
      night.away('telegram', named?.at ?? null)
      say(`cc-voice-gateway on ${hostname()}: good night. ${capital(night.text())}. Send /back or "I'm back" to end it.`)
    } else if (!night.back('telegram')) {
      say(`cc-voice-gateway on ${hostname()}: night mode was not on.`)
    }
  })
  telegramCommands.on('stale', stale => say(staleText(stale)))
  // /revoke, "revoke" or "Freigaben zurücknehmen": the grants end, all or one,
  // also while the controller is busy. It only narrows, so it needs no input on.
  telegramCommands.on('revoke', ({ id }) => {
    const ended = id ? [grantLedger.end(id, 'taken back in Telegram')].filter(Boolean) : grantLedger.endAll('taken back in Telegram')
    say(
      `cc-voice-gateway on ${hostname()}: ` +
        (ended.length
          ? `ended ${ended.length === 1 ? 'the grant' : `${ended.length} grants`} ${ended.map(grant => `${grant.id} (${grant.label})`).join('; ')}. ` +
            'Such approval prompts ask one by one again.'
          : `${id ? `no grant ${id} holds now` : 'no grant holds now'}; nothing to end.`),
    )
  })
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
const alerts = new Alerts({ send: telegram ? text => telegram.send(text) : null })
if (standby.active) alerts.pause() // in a standby: at most one summary a day
// /funnel off on Telegram takes the gateway off the internet (funnel.mjs):
// the alerts about suspicious requests say so, where it works, with the
// Telegram commands on and scripts/funnel.sh able to tell the Funnel's state.
if (telegramCommands) {
  funnel
    .state()
    .then(state => {
      if (state) alerts.advice = 'Send /funnel off to take the gateway off the internet.'
    })
    .catch(() => {})
}
const ipGuard = new IpGuard({ allow: config.mcpAllow, alerts })
auth.on('pairing', event => ipGuard.pairing(event))
log(`${ipGuard.describe()}; suspicious requests ${telegram ? 'reported on Telegram' : 'only in the log'}`)

// --- the kill switch's effects, in code ---------------------------------------

// No new tasks (Workers.dispatch and the voice tools check the switch), the
// queue is emptied, every run and the worker container stop, the approvals
// Claude Code may wait on are denied. An error here is logged; the lock holds
// whatever happens, and so does the gateway. Returns the tasks that were
// queued.
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
  // After an alarm the driver says again what may go on without them, and
  // which approvals may run without asking.
  orders.endAll(`the kill switch locked (${why})`)
  grantLedger.endAll(`the kill switch locked (${why})`)
  for (const permission of store.pendingPermissions()) {
    store.resolvePermission(permission.code, 'deny', 'killswitch')
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

// A write outside that the kill switch's rule moved to quarantine instead of
// locking (guard.mjs): a warning on Telegram at once; the controller hears it
// with the run's result.
guard.on('quarantined', (task, entry) => {
  telegram
    ?.send(
      `cc-voice-gateway on ${hostname()}: warning, worker ${task.repo} (task ${task.id}) wrote ${entry.path} outside its ` +
        `allowed folders. The guard moved it to quarantine: ${entry.file}. Invalid write ${entry.n} of the run; the ` +
        `${entry.n >= 2 ? 'next one' : 'third'} locks the kill switch.`,
    )
    .catch(error => log('quarantine warning not sent by Telegram:', error.message))
})

killswitch.on('tripped', async (state, event, first) => {
  const parked = (await lockdown(event.trigger).catch(lockdownFailed)) ?? []
  // Telegram at once; every voice chat hears it with its next call (voice.mjs).
  const when = new Date(event.at).toISOString().replace('T', ' ').slice(0, 16)
  telegram
    ?.send(
      `cc-voice-gateway on ${hostname()}: ${first ? 'KILL SWITCH' : 'kill switch, again'} at ${when} UTC, ` +
        `by ${event.trigger}: ${event.reason}. No new tasks, workers stopped, repositories read-only for the ` +
        (killswitch.byVoice
          ? 'worker container. Unlock at the server: node scripts/unlock.mjs, or in voice mode with a PIN sent here.'
          : 'worker container. Unlock only at the server: node scripts/unlock.mjs'),
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
      `${first ? 'Kill switch locked' : 'Kill switch triggered again'}: ${alarmText(state, { voice: killswitch.byVoice })} ` +
        `Do not try to get around it.${queue} Reply "done".`,
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
http = startVoiceHttp(store, channel, auth, config, { killswitch, onPortBusy: portBusy, guard: ipGuard, presence, standby, limits, night, unlock, approvalGrants })

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

// The worker limits and the path grants while the gateway runs (live.mjs): a
// change in the settings file applies at once. Runs going always run to the
// end; the grants count for their next write.
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
settings.on('change', ({ limits, changed, others, grants: grantsText }) => {
  if (grantsText !== undefined) {
    grants.set(grantsText)
    grantsLog('from the settings file, at once')
  }
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

// What a connected controller gets first: everything open, the plan, and the
// events the previous session never answered. In a standby after the
// connector was disconnected, it waits until the standby ends (below).
async function deliverStartup() {
  try {
    const items = openItems({ ledger, workers, store, interrupted: store.interrupted, notes: openNotes() })
    const summary = store.createRequest(startupText(items), { origin: 'gateway' })
    await channel.push(summary, { kind: 'summary', trusted: 'no' })
  } catch (error) {
    log('start-up summary not delivered:', error.message)
  }
  await sendPlan('since the queue was planned, before this start')
  await resendHeld()
  // Routine news gathered before the digest was turned off goes now, as one.
  if (!digest.enabled) await sendDigest({ force: true })
}

// The digest of routine news about the workers' pull requests (digest.mjs):
// one event once the news has been quiet for a while, kind="digest" and
// trusted="no", as it quotes what workers and GitHub said. Its answer is news
// for the driver (origin "worker"). The request is kept before its items go
// from the digest's file, and a request the controller never answered goes
// again after a restart (store.mjs), so no item is lost. Not before the
// session is connected, nor in a standby: then later. One at a time.
let digesting = Promise.resolve()
function sendDigest({ force = false } = {}) {
  digesting = digesting.then(() => deliverDigest(force)).catch(error => log('digest not delivered:', error.message))
  return digesting
}

async function deliverDigest(force) {
  if (!connected || standby.active || !digest.items.length || (!force && !digest.due())) return
  const items = [...digest.items]
  const request = store.createRequest(digestText(items), { origin: 'worker' })
  request.meta = { kind: 'digest', ...digestMeta(items), trusted: 'no' }
  store.save()
  digest.take({ items })
  log(`digest: ${items.length} routine item${items.length === 1 ? '' : 's'} about pull requests to the controller as one event`)
  await channel.push(request, request.meta)
}

digest.on('due', () => sendDigest())

// The events to send again, in their order: worker results the previous
// session never answered, and those held while the controller waited for
// the usage limit, or that met it as failed turns. While it waits, they stay
// (channel.mjs holds them again); a voice request a restart ended is not sent.
let resending = Promise.resolve()
function resendHeld() {
  resending = resending.then(async () => {
    for (const request of [...store.requests.values()].filter(r => r.resend)) {
      if (limits.active('controller')) return
      delete request.resend
      if (request.origin === 'voice' && request.state === 'done') continue
      try {
        await channel.push(request, { ...request.meta, resent: 'yes' })
      } catch (error) {
        request.resend = true
        log('event not sent again:', error.message)
      }
      store.changed()
    }
  })
  return resending
}

channel.ready.then(async () => {
  connected = true
  presence.connected = true // the connector's answers say active from now on
  if (!standby.active) await deliverStartup()
  restarter.announceReady()
})

// --- the standby after the connector was disconnected (standby.mjs) -----------

// One message first, on Telegram and to the controller; then the worker runs
// stop (their results wait), nothing starts, the watches on pull requests,
// the reminders, the Telegram fallback and the alerts pause (one summary a
// day at most), and the connector's answers say inactive. The controller
// session stays: the gateway runs inside it, and so do the sign-in and the
// pairing codes a reconnect needs; ending it would also leave a development
// channel's confirmation waiting at the terminal for the wake-up. The queue
// and the open decisions stay as they are.
const tell = text =>
  telegram?.send(`cc-voice-gateway on ${hostname()}: ${text}`).catch(error => log('standby message not sent by Telegram:', error.message)) ??
  Promise.resolve()

standby.on('enter', async ({ reason }) => {
  // The driver disconnected: nothing runs on their earlier yes any more.
  const ended = grantLedger.endAll(`a standby began: ${reason}`)
  await tell(
    `the connector was disconnected (${reason}), I am switching off now. Worker runs stop and nothing new starts; no ` +
      'reminders and no alerts, at most one summary a day. The queue and the open decisions are kept' +
      (ended.length ? `; the approval grants ${ended.map(grant => grant.id).join(', ')} ended` : '') +
      '. A new sign-in with a pairing code (the setup page, or node scripts/pair.mjs) switches me on again.',
  )
  alerts.pause()
  pulls.paused = true
  let stopped = []
  try {
    stopped = workers.stopForStandby(`the gateway went to standby: ${reason}`)
  } catch (error) {
    log('standby: worker runs stopped, but their state was not saved:', error.message)
  }
  if (stopped.length) log('standby stopped', stopped.map(task => `${task.repo} ${task.id}`).join(', '))
  if (!connected) return
  try {
    const request = store.createRequest(
      `Standby: the connector in claude.ai was disconnected (${reason}), so the gateway switched off. It stopped ` +
        `${stopped.length === 1 ? '1 worker run' : `${stopped.length} worker runs`}, whose results follow after the ` +
        'standby, starts nothing, sends no reminders, and the voice assistant hears that this gateway is inactive. ' +
        'The queue and the open decisions are kept. A new sign-in of the connector ends it. Reply "done"; the driver ' +
        'does not hear it.',
      { origin: 'gateway' },
    )
    await channel.push(request, { kind: 'standby', state: 'on' })
  } catch (error) {
    log('standby event not delivered to the controller:', error.message)
  }
})

standby.on('leave', async ({ why }) => {
  alerts.resume()
  pulls.paused = false
  await tell(`I am back: the connector is connected again (${why}). Queued tasks go on, and what waited reaches the controller.`)
  if (!connected) return
  try {
    const request = store.createRequest(
      `Standby over: the connector signed in again (${why}). Queued tasks go on, and the events that waited follow. ` +
        'Reply "done"; the driver does not hear it.',
      { origin: 'gateway' },
    )
    await channel.push(request, { kind: 'standby', state: 'off' })
  } catch (error) {
    log('standby event not delivered to the controller:', error.message)
  }
  await deliverStartup()
})

// --- the Claude usage limit (limits.mjs) ---------------------------------------
//
// A worker run that meets it goes back to the queue (Workers.limited), and
// its account waits: one Telegram message when the wait starts, one when it
// ends, and the queue goes on by itself. The workers on this computer share
// the controller session's login, so the controller counts as waiting too:
// its events are held (channel.mjs) instead of ending as failed turns. Its
// own transcript says when it meets the limit itself; then the events it
// got since its last answer go again too. A tool call of it ends its wait,
// and so does the reset; then the held events go to it.
limits.on('wait', (account, wait, first) => {
  if (!first) return
  const until = wait.reset ? `at ${clock(wait.until)}, when it resets` : `at ${clock(wait.until)}`
  if (account === 'controller') {
    if (wait.source === 'transcript' && !limits.active('host')) {
      tell(`the controller session reached the Claude usage limit (${wait.text}). What comes for it waits, and reaches it ${until}.`)
    }
    return
  }
  const tasks = wait.tasks.length ? `${wait.tasks.join(', ')} went back to the queue and resume${wait.tasks.length === 1 ? 's' : ''} ` : 'The queue goes on '
  const what = wait.kind === 'usage' ? `reached the Claude usage limit (${wait.text})` : `met an overloaded Claude API (${wait.text})`
  tell(`${accountName(account)} ${what}. ${tasks}${until}; nothing new starts there until then, and I go on by myself.`)
  if (account === 'host') limits.hit('controller', { kind: wait.kind, resetsAt: wait.until, limit: wait.limit, text: wait.text, source: 'account' })
})

limits.on('resume', (account, wait, why) => {
  if (account === 'controller') {
    if (wait.source === 'transcript') tell(`the controller session goes on (${why}); what waited reaches it now.`)
    resendHeld()
    return
  }
  tell(`the usage limit wait is over for ${accountName(account)} (${why}): the queue goes on.`)
})

// The controller met the limit itself: it waits, and what it got since its
// last answer goes again, as those turns failed.
function controllerLimited(hit) {
  limits.hit('controller', { ...hit, source: 'transcript' })
  let marked = 0
  for (const request of store.requests.values()) {
    if (!request.pushedAt || request.resend || !['sent', 'working'].includes(request.state)) continue
    request.resend = true
    marked++
  }
  if (marked) {
    store.changed()
    log(`usage limit: ${marked} event${marked === 1 ? '' : 's'} the controller did not answer go to it again after the wait`)
  }
}

transcript = new TranscriptWatch({ onLimit: hit => controllerLimited(hit), pollMs: config.transcriptPollSeconds * 1000 }).start()
// The night's summary names the waits too.
limits.on('wait', (account, wait, first) => first && account !== 'controller' && night.note(`${accountName(account)} began to wait for the usage limit`))
limits.on('resume', account => account !== 'controller' && night.note(`${accountName(account)} went on after the usage limit`))
limits.start()

// --- night mode (night.mjs) ---------------------------------------------------------
//
// When it begins, the controller hears it as an event of the gateway (the
// driver does not); Telegram says nothing then, unless the driver switched it
// on there. When it ends, by the clock or by "I'm back": one summary of the
// night, on Telegram and as an event for the controller, whose answer the
// driver hears as news. The night's news and its questions on Telegram count
// as told then: the summary names them, instead of one message each.
night.on('night', async ({ until, by }) => {
  log(`night mode: the night began (${by})${until ? `, until ${new Date(until).toISOString()}` : ''}`)
  try {
    await channel.ready
    const request = store.createRequest(
      `Night mode is on${by === 'quiet hours' ? ', for the quiet hours' : `, as the driver said (${by})`}` +
        `${until ? ` until ${clock(until)}` : ', until the driver says they are back'}. Workers decide what they can, ` +
        'conservatively, note their assumptions and defer what needs the driver; questions and decisions wait for the ' +
        'morning, and Telegram carries alarms and approval prompts only. Go on with what is queued, and with what ' +
        'standing orders allow' +
        `${orders.active().length ? ` (${orders.active().map(order => `${order.id} for ${order.worker}`).join(', ')})` : ': none holds now'}. ` +
        'Reply "done"; the driver does not hear it.',
      { origin: 'gateway' },
    )
    await channel.push(request, { kind: 'night', state: 'on' })
  } catch (error) {
    log('night event not delivered to the controller:', error.message)
  }
})

night.on('morning', async summary => {
  const text = morningText(summary, ledger.open().map(d => decisionLine(d)))
  log(`night mode: the night is over (${summary.by}), ${summary.log.length} things noted`)
  fallback?.settle()
  store.settleNews(summary.since)
  tell(`good morning. ${text}`)
  try {
    await channel.ready
    const request = store.createRequest(
      `${text}\nThe night is over (${summary.by}). Tell the driver as news, in at most three short sentences: what was ` +
        'done, then the assumptions and deferred questions in a few words, then which decisions wait; details when they ' +
        'ask. Reply "done". Ask about the waiting decisions afterwards, one at a time, as usual.',
      { origin: 'worker' },
    )
    // trusted="no": it quotes what the workers wrote.
    request.meta = { kind: 'morning', trusted: 'no' }
    await channel.push(request, request.meta)
  } catch (error) {
    log('morning summary not delivered to the controller:', error.message)
  }
})
night.start()

// A decision never put to the driver, or a question they have not answered: a
// reminder event after VOICE_GW_REMIND_MINUTES, at most three times; none
// while the kill switch is locked. The controller asks on it, and the driver
// hears that as news (origin "worker"). The reminder belongs to the decision
// from then on, so a decision that belonged to no request (after stop_worker,
// or from the kill switch) has one now. trusted="no", as for the summary.
const reminders = setInterval(
  async () => {
    // None in night mode either: the decisions wait for the morning.
    if (!connected || killswitch.locked || standby.active || night.active()) return
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
