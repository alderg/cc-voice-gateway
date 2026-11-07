// Fixed rules on the workers' runs, checked by the gateway while it follows
// them, whatever the instructions say. A violation trips the kill switch,
// which locks at VOICE_GW_KILLSWITCH=auto and only logs it otherwise.
//
// A push to the default branch, or a merge into it, is no rule: whether it is
// allowed is the repository's configuration on GitHub (branch protection,
// rulesets, the access level in Docker), not the kill switch's. Until
// 2026-11-04 it locked, and locked falsely when the default branch moved on
// GitHub during a run for another reason, such as the driver's merge.
//
//   outside         writes outside the repository (for a run in a worktree,
//                   outside its worktree), its run folder (workspaces.mjs),
//                   the temporary folders and
//                   the run's own Claude Code memory folder (memoryFolder):
//                   the file tools by their path, shell commands by explicit
//                   targets (redirections, tee, cp, mv and what it moves away,
//                   rm, mkdir, touch, ln, chmod, chown, truncate, sed -i, dd
//                   of=), after cd; crontab; and a git hook in any .git, also
//                   the run's own. The command line is read as a shell reads
//                   it (parseShell): quoted text, comments and heredocs are
//                   data; commands in $(…), `…`, <(…), >(…), sh -c, eval, a
//                   shell's heredoc and a script written from a heredoc that
//                   the same call runs are commands. Devices such as /dev/null
//                   are no write. A run in a work folder (workspaces.mjs) may
//                   write only there and in its memory folder. The folder a
//                   Bash call starts in is the one Claude Code names in the
//                   guard's hook (guardHooks), or else the one the rule
//                   followed: Claude Code keeps the shell's folder from one
//                   call of the main thread to the next, also after a cd,
//                   keeps it as it was after a command that failed, and goes
//                   back to the workspace when a call ends outside it, with
//                   "Shell cwd was reset to …" in the result; a subagent's
//                   calls start in the main thread's folder and change it
//                   never, and neither does a call in the background.
//                   The guard's hook (guardHooks, fence.mjs) reads each Bash,
//                   Write, Edit, MultiEdit and NotebookEdit call with the same
//                   code before it runs, and refuses one that would write
//                   outside, with a message that names the run's folders: it
//                   never runs. The rule counts such a call as no write, and
//                   as an invalid write (refuse); an attempt at something
//                   severe (severe: keys, settings that run code, a git hook,
//                   the crontab, a place outside the home and the
//                   repositories folder) locks at once all the same.
//                   Quarantine (QUARANTINE_FREE): the first two invalid writes
//                   of a run that make a new plain file in a place that is not
//                   sensitive (sensitive) are moved into the quarantine
//                   folder once the call has ended (decide), logged, kept with
//                   the task for its result and Telegram, and the worker is
//                   told by the hook; the third invalid write, refused or
//                   moved, locks. Everything else locks at once, as before:
//                   changing, appending to, removing or moving files, folders
//                   and links, hidden files and folders (but a new file under
//                   .voice-runs/<the run's repository> outside every run
//                   folder), other repositories, the gateway's checkout,
//                   places outside the home and the repositories folder, and
//                   whatever the guard cannot pin down.
//                   Path grants (grants.mjs, VOICE_GW_PATH_GRANTS): folders
//                   the driver granted to a repository count for its runs on
//                   this computer as the repository does, apart from what is
//                   sensitive in itself there too (hidden files and folders,
//                   git hooks and repositories, links, a path that leads out
//                   through one): one check for them (granted).
//   many changes    more file edits in a run than maxEdits; at the end, more
//                   files or lines changed than maxFiles or maxLines, counting
//                   commits made during the run on any branch, each by its
//                   own changes, and what is not committed; in a work folder,
//                   more files in it than maxFiles. What a commit that only
//                   branches the run made hold takes over from before the run
//                   counts nothing (reused): a file set to a version that a
//                   commit from before the run had at that path, or removed
//                   where the default branch does not have it, as review
//                   branches made of existing code, a cherry-pick or a rebase
//                   do. A commit on a branch from before the run (its reflog
//                   tells) counts in full: setting it back, removing what it
//                   has or rewriting its history is a change. So does all of
//                   it after a push to a URL, and whatever git cannot tell.
//                   The run's helper folder (HELPER_FOLDER, workspaces.mjs)
//                   counts apart, against maxHelperFiles: the file edits
//                   there, and at the end what is untracked there. What is
//                   committed or tracked from it counts as before. So do the
//                   file edits in its run folder and the temporary folders,
//                   which hold no change of the repository's; what is in
//                   them at the end is no change at all.
//
// What the size check at the end counted, with whether the run pushed, also
// goes to the statistics ('measured', stats.mjs): the commits made during
// the run, the files and lines changed.
//
// The rules observe the run; past the hook, they cannot stop its first
// step: a write locks once its command shows. What they miss is in the
// README ("Limits"): targets hidden in variables, scripts or other languages.
// In the Docker setup, git runs only in the container (runner.git); never on
// this computer in the mounted folder, and gh only on this computer.

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FENCE_VERSION, FILE_TOOLS, expandPath, gitHook, isDevice, parseShell, refusalTag, walkShell, within } from './fence.mjs'
import { log as defaultLog, preview } from './log.mjs'
import { tempFolders } from './platform.mjs'
import { HELPER_FOLDER, RUN_FOLDERS, inHelperFolder } from './workspaces.mjs'
import { WORKTREES, listWorktrees } from './worktrees.mjs'

export { isDevice, parseShell }

// The Claude Code memory folder of a session in the given folder, where its
// auto memory writes: <config>/projects/<folder with every character but
// letters and digits as ->/memory. Only the run's own, never another
// project's.
export function memoryFolder(config, dir) {
  return `${config}/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/memory`
}

// --- the guard's hooks in a worker's run ---------------------------------------
//
// In the worker's settings (workers.mjs, --settings with --include-hook-events,
// which puts every hook's output into the run's stream-json). Before a Bash or
// file tool call, PreToolUse asks the fence (fence.mjs, refusal) whether the
// call would write outside the run's allowed folders. If not, it prints the
// call's id, the folder Claude Code starts it in and when, as one line after
// TOOL_START; Claude Code shows the model nothing of it. If so, it refuses
// the call, with permissionDecision deny and the fence's message, which
// Claude Code hands the model as the call's result without running it, and
// the same line goes to its stderr with refused: true, for the rule. Checked
// in Claude Code 2.1.312, headless with bypassPermissions as the workers run:
// a refused Bash or Write asks nothing, does nothing, and the run goes on.
// It refuses, and never allows: without the fence or its module it only
// reports, as before. After a call, PostToolUse and PostToolUseFailure hand
// the model what the guard left for it in the file that GUARD_NOTES_ENV names
// (a write it moved to quarantine), as additional context, and empty the
// file. Before the run's turn ends, Stop waits while the guard still decides
// about a write (the file .wait next to it), and hands over what is left with
// decision block, so that the worker reads it before it ends. One script for
// all, run by node: this computer's for a run here, the container's there,
// with the fence's module as its argument. It holds no single quote, as it
// goes into one.

export const GUARD_NOTES_ENV = 'VOICE_GW_GUARD_NOTES'
export const TOOL_START = 'voice-gw-tool '
// The folder of the notes in the container, which the gateway writes with
// docker exec; on this computer they are next to the run's output.
export const CONTAINER_NOTES = '/tmp/voice-gw'
// The fence's module (fence.mjs): on this computer in the gateway's checkout,
// in the container a copy the gateway puts next to the notes (fence).
export const FENCE_MODULE = fileURLToPath(new URL('./fence.mjs', import.meta.url))
export const CONTAINER_FENCE_MODULE = `${CONTAINER_NOTES}/fence.mjs`
let fenceText = null
const fenceSource = () => (fenceText ??= readFileSync(FENCE_MODULE, 'utf8'))
// The version of the hooks a run gets (task.guardHooks): 2 asks the fence
// and reports the file tools too; true, from before, reports Bash and Write.
export const GUARD_HOOKS = 2
const STOP_WAIT_MS = 30 * 1000
const MAX_PUSHED = 20 // branches a run's git push named, kept on its record
const HOOK_SCRIPT =
  'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{' +
  'let i={};try{i=JSON.parse(s)}catch{}' +
  `const e=i.hook_event_name,n=process.env.${GUARD_NOTES_ENV};` +
  'if(e==="PreToolUse"){' +
  'const r={id:i.tool_use_id,cwd:i.cwd,agent:i.agent_id||null,at:Date.now()},m=process.argv[1];' +
  'const go=d=>{if(!d)return process.stdout.write(' +
  `"${TOOL_START}"+JSON.stringify(r)+"\\n");` +
  `process.stderr.write("${TOOL_START}"+JSON.stringify({...r,refused:true})+"\\n");` +
  'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:e,permissionDecision:"deny",permissionDecisionReason:d}}))};' +
  'if(!m||!n)return go(null);' +
  'return import(require("url").pathToFileURL(m).href).then(f=>{let d=null;try{d=f.refusal(i,n+".fence")}catch{}go(d)},()=>go(null))}' +
  'if(!n)return;' +
  'const take=()=>{const t=n+".taken"+process.pid;try{fs.renameSync(n,t)}catch{return""}' +
  'try{return fs.readFileSync(t,"utf8").trim()}catch{return""}finally{try{fs.unlinkSync(t)}catch{}}};' +
  `if(e==="Stop"){const end=Date.now()+${STOP_WAIT_MS};const go=()=>{` +
  'if(fs.existsSync(n+".wait")&&Date.now()<end)return setTimeout(go,250);' +
  'const x=take();if(x)process.stdout.write(JSON.stringify({decision:"block",reason:x}))};return go()}' +
  'const x=take();if(x)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:e,additionalContext:x}}))})'

const shellQuote = text => `'${String(text).replace(/'/g, `'\\''`)}'`

// The hooks for the worker's settings; node: the node that runs the script,
// fence: the fence's module where that node finds it.
export function guardHooks(node, fence = FENCE_MODULE) {
  const hook = { type: 'command', command: `${shellQuote(node)} -e ${shellQuote(HOOK_SCRIPT)} ${shellQuote(fence)}` }
  return {
    PreToolUse: [{ matcher: ['Bash', ...Object.keys(FILE_TOOLS)].join('|'), hooks: [hook] }],
    PostToolUse: [{ matcher: '*', hooks: [hook] }],
    PostToolUseFailure: [{ matcher: '*', hooks: [hook] }],
    Stop: [{ hooks: [{ ...hook, timeout: STOP_WAIT_MS / 1000 + 30 }] }],
  }
}

// The calls' reports in a PreToolUse hook's output, its stdout and, for a
// call it refused, its stderr: [{ id, cwd, agent, at, refused }].
export function toolStarts(stdout) {
  const found = []
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.startsWith(TOOL_START)) continue
    try {
      const report = JSON.parse(line.slice(TOOL_START.length))
      if (typeof report?.id === 'string' && report.id) found.push(report)
    } catch {
      // not the guard's
    }
  }
  return found
}

// The calls the guard's hook reports before they start (guardHooks): of a
// run with the hooks from before the fence, Bash and Write only.
const REPORTED = new Set(['Bash', ...Object.keys(FILE_TOOLS)])
const REPORTED_BEFORE = new Set(['Bash', 'Write'])
// How long the rule waits for a call's report before it goes by the folder
// it followed: the hooks may not run, as with disableAllHooks.
const REPORT_WAIT_MS = 10 * 1000
// Claude Code's own words when it takes the shell back to the workspace.
const RESET = /(?:^|\n)Shell cwd was reset to (.+)$/
const OUTSIDE = 'write outside the allowed folders'
// Invalid writes of a run that go to quarantine before the next one locks.
const QUARANTINE_FREE = 2
// A file a call made is born after the call started: as its report says,
// or without one up to this long before the rule saw the call; a second
// less, for birth times in whole seconds.
const START_SLACK_MS = 5000
// What locks at once whatever the place: everything but making a new file.
const LOCKING_OPS = {
  append: 'it appends to a file',
  edit: 'it changes a file in place',
  remove: 'it removes or moves files away',
  move: 'it moves files there',
  mode: 'it changes a mode or an owner',
  truncate: 'it truncates a file',
  mkdir: 'it makes a folder',
  link: 'it makes a link',
}
// Shell profiles and rc files, also without their dot.
const SHELL_FILES = /^\.?(bash_profile|bash_login|bash_logout|bashrc|profile|zshrc|zshenv|zprofile|zlogin|zlogout|kshrc|cshrc|tcshrc|login|logout|inputrc|xprofile|xinitrc|xsessionrc|envrc)$/
// CI workflow files that live outside a hidden folder.
const CI_FILES = new Set(['Jenkinsfile', 'azure-pipelines.yml', 'azure-pipelines.yaml', 'bitbucket-pipelines.yml', 'appveyor.yml', 'cloudbuild.yaml', 'cloudbuild.yml', 'buildspec.yml', 'codemagic.yaml'])
// In the home folder: where keys and credentials live, and the settings that
// hand them to tools (severe).
const SECRETS = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.pki', '.netrc', '.git-credentials',
  '.gitconfig', '.npmrc', '.pypirc', '.Xauthority', '.config/git', '.config/gh', '.config/gcloud', '.local/share/keyrings',
])
// In the home folder: what starts programs by itself (severe).
const AUTOSTART = ['.config/autostart', '.config/systemd', '.local/share/systemd', '.config/environment.d', 'Library/LaunchAgents', 'Library/LaunchDaemons']
// The gateway's own checkout.
const GATEWAY = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')

// The size check's look through the history of the files that the run's
// own branches changed (versionsBefore): at most this many paths in one git
// call, this many calls, each within this time. Beyond, nothing is left out.
const PATHS_PER_LOOK = 1000
const MAX_LOOKS = 10
const HISTORY_MS = 60 * 1000

// The gh on this computer, the gateway's, also for runs in the container.
function gh(ghBin, args, timeout = 30000) {
  return new Promise(resolve => {
    execFile(ghBin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

// The folders on this computer's PATH, but / and the home folder itself.
const pathFolders = home =>
  String(process.env.PATH ?? '')
    .split(':')
    .map(dir => dir.replace(/(.)\/+$/, '$1'))
    .filter(dir => dir.startsWith('/') && dir !== '/' && dir !== home)

// What the worker reads, through the guard's hook, about a write the guard
// moved to quarantine (RunGuard.toQuarantine).
function quarantineNote(run, entry, granted = []) {
  const by = entry.command.startsWith('"') ? `the command ${entry.command}` : `the ${entry.command.split(' ')[0]} tool`
  const own = run.scratch
    ? `your work folder ${run.dir}`
    : `${run.worktree ? 'your worktree' : 'the repository'} ${run.dir}${run.runFolder ? `, your run folder ${run.runFolder}` : ''}` +
      (granted.length ? `, the folders granted to this repository (${granted.join(', ')})` : '')
  const next =
    entry.n >= QUARANTINE_FREE
      ? 'This was the second invalid write of this run: the next one locks the kill switch, which stops all work.'
      : 'The third invalid write of a run locks the kill switch, which stops all work.'
  return (
    `The gateway's guard: ${by} wrote ${entry.path}, outside your allowed folders. The gateway moved the file to ` +
    `quarantine as an invalid write, so it is no longer there. Write only in ${own} and the temporary folders; after a ` +
    `cd, give writes absolute paths, and keep backups and copies inside these folders too. ${next} Say in your result ` +
    'what you wrote there.'
  )
}

// What the worker reads, through the guard's hook, after the second invalid
// write of a run that the hook refused (RunGuard.refuse); the refusal itself
// said the rest.
function refusedNote(entry) {
  const by = entry.command.startsWith('"') ? `the command ${entry.command}` : `the ${entry.command.split(' ')[0]} tool`
  return (
    `The gateway's guard: it refused ${by} before it ran, as the second invalid write of this run: the next one ` +
    'locks the kill switch, which stops all work. Write only in your allowed folders, leave files outside them as ' +
    'they are, and name them in your result.'
  )
}

// crontab's words that only list the table, and so change nothing.
const cronListing = args =>
  args.some(arg => /^-[a-zA-Z]*l/.test(arg)) &&
  !args.some(arg => /^-[a-zA-Z]*[er]/.test(arg)) &&
  args.filter(arg => !arg.startsWith('-')).length <= (args.includes('-u') ? 1 : 0)

// git [-C dir] [-c key=value] push [options] [remote [refspec...]]: the
// branches it names as targets, and whether it pushes to a URL or a path
// rather than to a remote, so that no remote branch in the repository shows
// what it pushed; null for another git command. For the size check
// (commitRefs, reused), not a rule of its own.
function pushTargets(args) {
  let at = 0
  while (at < args.length && args[at] !== 'push') at += ['-C', '-c'].includes(args[at]) ? 2 : 1
  if (args[at] !== 'push') return null
  const rest = args.slice(at + 1)
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (['--repo', '-o', '--push-option', '--receive-pack', '--exec'].includes(rest[i])) i++
    else if (!rest[i].startsWith('-')) positional.push(rest[i])
  }
  return {
    branches: positional.slice(1).map(spec => spec.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '')),
    elsewhere: rest.some(arg => arg === '--repo' || arg.startsWith('--repo=')) || /[:/]/.test(positional[0] ?? ''),
  }
}

export class RunGuard extends EventEmitter {
  constructor({
    workers,
    runner,
    killswitch,
    ghBin = 'gh',
    limits = {},
    allowed = [],
    grants = null,
    quarantine = null,
    gateway = GATEWAY,
    home = null,
    temp = null,
    log = defaultLog,
  }) {
    super()
    this.workers = workers
    this.runner = runner
    this.killswitch = killswitch
    this.ghBin = ghBin
    // The rule on writes outside: the folder on this computer where the
    // invalid writes it lets off go, one folder per task (null: none, every
    // invalid write locks), and the gateway's own checkout.
    this.quarantine = quarantine
    this.gateway = gateway
    // The home folder and the temporary folders on this computer: homedir()
    // and tempFolders(), unless a test names others.
    this.home = home
    this.temp = temp
    this.timers = new Set()
    this.maxEdits = limits.maxEdits ?? 500
    this.maxFiles = limits.maxFiles ?? 300
    this.maxLines = limits.maxLines ?? 30000
    this.maxHelperFiles = limits.maxHelperFiles ?? 10000 // in the helper folder: files at the end, and edits
    this.log = log
    this.allowedPaths = allowed // VOICE_GW_KILL_ALLOW_PATHS
    // The folders granted to each repository (PathGrants, grants.mjs), for
    // its runs on this computer; null: none.
    this.grants = grants
    this.runs = new Map() // task id -> what the rules know about the run
    // repository \0 branch -> the task whose git push named it last: with
    // several runs in one repository, one run's branch is not another's.
    this.pushedBy = new Map()
    workers.on('started', task => this.started(task))
    workers.on('tool', (task, part, parent) => this.tool(task, part, parent))
    workers.on('toolStart', (task, report) => this.toolStart(task, report))
    workers.on('toolResult', (task, result) => this.toolResult(task, result))
    workers.on('ended', task => this.ended(task))
  }

  close() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    timer.unref()
    this.timers.add(timer)
  }

  violation(run, rule, detail) {
    if (run.tripped.has(rule)) return
    run.tripped.add(rule)
    this.killswitch.trip({ trigger: 'rule', reason: `${rule}: ${detail} (worker ${run.repo}, task ${run.id})` })
  }

  // --- the run --------------------------------------------------------------

  // Where the runs of a runner live: in the container or on this computer.
  // Their home, Claude Code's folder there, and the folders they may write to
  // besides their workspace: the temporary ones (on macOS also /private/tmp
  // and the per-user /var/folders/…/T, platform.mjs) and
  // VOICE_GW_KILL_ALLOW_PATHS.
  places(runner) {
    const docker = Boolean(runner.container)
    const home = docker ? '/home/worker' : (this.home ?? homedir())
    const temp = this.temp ?? (docker ? ['/tmp', '/var/tmp'] : tempFolders())
    return {
      home,
      claudeConfig: (!docker && process.env.CLAUDE_CONFIG_DIR) || `${home}/.claude`,
      temp,
      roots: [...new Set([...temp, ...this.allowedPaths])],
    }
  }

  // Also for runs that were going when the gateway started. The runner of
  // the run's workspace, as Workers knows it. A run in a work folder may
  // write only there, in the temporary folders and in its memory folder: not
  // in VOICE_GW_KILL_ALLOW_PATHS.
  started(task) {
    if (this.runs.has(task.id)) return
    const runner = this.workers.runnerOf?.(task) ?? this.runner
    const { home, claudeConfig, temp, roots } = this.places(runner)
    const scratch = task.kind === 'scratch'
    // A run in a repository also has its run folder (workspaces.mjs), its
    // own: never the folders around it, nor another run's.
    const runFolder = !scratch && typeof task.runFolder === 'string' && task.runFolder.startsWith('/') ? task.runFolder : null
    const run = {
      id: task.id,
      task, // the workers' record of it, in their state
      repo: task.repo,
      scratch,
      runner,
      home,
      runFolder,
      roots: scratch ? temp : [...roots, ...(runFolder ? [runFolder] : [])], // where it may write besides its workspace and its memory folder
      // Where its file edits count apart, with the helper folder's: its run
      // folder and the temporary folders, which hold no change of its own.
      helpers: scratch ? [] : [...temp, ...(runFolder ? [runFolder] : [])],
      dir: task.dir ?? runner.dir(task.repo), // a run in a worktree: the worktree, not the checkout
      memories: [],
      slug: task.slug ?? null,
      branch: task.defaultBranch ?? null, // the default branch, for the size check (defaultPaths)
      startedAt: task.startedAt,
      pushed: new Set(), // branches the run's git push commands name
      // A git push to a URL or a path: where its commits went, no remote
      // branch in the repository shows (reused).
      pushedElsewhere: false,
      edits: 0,
      helperEdits: 0, // file edits in the helper folder, which count apart
      files: new Set(),
      tripped: new Set(),
      // Its Bash and file tool calls until their results, by Claude Code's id.
      calls: new Map(),
      // Whether its Claude Code reports its Bash and file tool calls before
      // they start (guardHooks), which of them, and whether a report came yet.
      hooks: Boolean(task.guardHooks),
      reports: task.guardHooks === GUARD_HOOKS ? REPORTED : REPORTED_BEFORE,
      reported: false,
      notes: typeof task.guardNotes === 'string' && task.guardNotes ? task.guardNotes : null, // for the hook (guardHooks)
      claudeConfig,
      // Invalid writes: those that went or go to quarantine, and the calls
      // the guard's hook refused.
      invalid: 0,
      kinds: [], // of those, which went to quarantine and which were refused, for the reason of the third
      pending: 0, // of those, the ones still to decide
      deciding: new Set(), // the decisions going (decide)
    }
    // Claude Code may key the memory of a worktree by the repository it
    // belongs to: both are the run's own.
    run.memories = [run.dir, task.checkout].filter(Boolean).map(dir => memoryFolder(claudeConfig, dir))
    run.worktree = Boolean(task.worktree)
    run.checkout = task.checkout ?? null
    run.cwd = run.dir // the shell's folder after its last Bash call (see shell)
    this.runs.set(task.id, run)
    run.ready = this.baseline(run)
    this.fence(run)
  }

  // --- the fence, for the guard's hook (fence.mjs) ------------------------------

  // What the hook of a run needs to read its calls as the rule does: its
  // workspace, home and run folder, and the folders it may write in.
  fenceOf(run) {
    const granted = this.grantedFolders(run)
    return {
      v: FENCE_VERSION,
      task: run.id,
      kind: run.scratch ? 'scratch' : run.worktree ? 'worktree' : 'repo',
      dir: run.dir,
      home: run.home,
      runFolder: run.runFolder,
      allowed: [...new Set([run.dir, ...run.memories, ...run.roots, ...granted])],
      granted,
    }
  }

  // Writes the run's fence next to its notes, whole or not at all: on this
  // computer at once, in the container through docker exec, with the fence's
  // module beside it. Again when the grants change (fences). Not for a run
  // whose hooks do not ask the fence.
  fence(run) {
    if (!run.notes || run.task.guardHooks !== GUARD_HOOKS) return Promise.resolve()
    const file = `${run.notes}.fence`
    const text = JSON.stringify(this.fenceOf(run))
    return this.mailbox(run, 'fence for the guard\'s hook not written', () => {
      if (run.runner.container) {
        const put = 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1.$$" && mv -f "$1.$$" "$1"'
        return run.runner
          .sh(put, [CONTAINER_FENCE_MODULE, fenceSource()])
          .then(result => (result?.ok === false ? result : run.runner.sh(put, [file, text])))
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(`${file}.${process.pid}`, text, { mode: 0o600 })
      renameSync(`${file}.${process.pid}`, file)
    })
  }

  // The fences of every run going, after the folders granted to their
  // repositories changed (gateway.mjs).
  fences() {
    return Promise.all([...this.runs.values()].map(run => this.fence(run)))
  }

  // The default branch's name, where the task does not have it, for the size
  // check (defaultPaths): what a commit removes counts nothing where the
  // default branch does not have it either.
  async baseline(run) {
    if (!run.slug || run.branch) return
    run.branch = (await gh(this.ghBin, ['api', `repos/${run.slug}`]))?.default_branch ?? null
  }

  // A tool call as the run's stream shows it, before it runs. parent: the
  // subagent's call (Agent) it belongs to, null for the main thread. With the
  // guard's hooks, the rule waits for the call's report (toolStart), which
  // comes right after, before the call runs, or else for its result.
  tool(task, part, parent = null) {
    const run = this.runs.get(task.id)
    if (!run) return
    const bash = part.name === 'Bash' && typeof part.input?.command === 'string'
    if (!FILE_TOOLS[part.name] && !bash) return
    const id = typeof part.id === 'string' && part.id ? part.id : null // Claude Code's id of the tool call
    const call = { id, part, parent: typeof parent === 'string' && parent ? parent : null, seenAt: Date.now(), at: null, checked: false, refused: null, candidates: [] }
    if (id) run.calls.set(id, call)
    if (run.hooks && id && run.reports.has(part.name)) {
      this.later(REPORT_WAIT_MS, () => this.runs.get(run.id) === run && this.check(run, call))
      return
    }
    this.check(run, call)
  }

  // A call's report from the guard's hook: the folder Claude Code starts it
  // in, exactly, and when. One the hook refused never runs: the rule waits
  // for its result, which says so for sure (toolResult), and keeps the
  // folder, which a call that does not run leaves as it was.
  toolStart(task, { id, cwd = null, agent = null, at = null, refused = false } = {}) {
    const run = this.runs.get(task.id)
    const call = run?.calls.get(id)
    if (!call) return
    run.reported = true
    const where = typeof cwd === 'string' && cwd.startsWith('/') ? posix.normalize(cwd) : null
    if (refused === true && !call.checked) {
      call.refused = { cwd: where, at, agent }
      if (where && !call.parent && !agent) run.cwd = where
      return
    }
    this.check(run, call, { cwd: where, at, agent })
  }

  // A call's result: the folder the main thread's shell is in afterwards, as
  // Claude Code keeps it, and the decision on the writes that may go to
  // quarantine, now that the call has ended. Without a report before, the
  // hooks do not run in this Claude Code: the rule goes by the folder it
  // followed from then on, without waiting. A call the guard's hook refused
  // has an error for its result with the refusal's words and the call's own
  // id, which the call's command cannot know: it goes to refuse. One the
  // hook reported refused without such a result is checked as one that ran.
  toolResult(task, { id, error = false, text = '' } = {}) {
    const run = this.runs.get(task.id)
    const call = run?.calls.get(id)
    if (!call) return
    if (!call.checked && error && call.id && String(text).includes(refusalTag(call.id))) {
      run.reported = true
      run.calls.delete(id)
      return this.refuse(run, call, call.refused ?? {})
    }
    if (call.refused) {
      const report = call.refused
      call.refused = null
      this.log(
        `kill switch rule on writes outside: the guard's hook refused the call ${call.id}, but its result does not say so; ` +
          `the rule checks it as one that ran (worker ${run.repo}, task ${run.id})`,
      )
      this.check(run, call, report)
    }
    if (!call.checked && run.hooks && !run.reported) {
      run.hooks = false
      this.log(`kill switch rule on writes outside: no report of the guard's hook in this run, so the rule follows the shell's folder itself (worker ${run.repo}, task ${run.id})`)
    }
    this.check(run, call)
    run.calls.delete(id)
    const { part } = call
    // Claude Code takes the shell's new folder only from a command that
    // succeeded, and goes back to the workspace from one outside it with
    // these words; never from a subagent's call, or one in the background.
    if (part.name === 'Bash' && !call.parent && !part.input.run_in_background) {
      if (RESET.test(String(text).trimEnd())) run.cwd = run.dir // back to where it started, the workspace, whatever the words name
      else if (error) run.cwd = call.before
      else if (call.after) run.cwd = call.after
    }
    if (call.candidates.length) this.decide(run, call)
  }

  // What a call writes, checked once: from the folder its report names, or
  // the one the rule followed. A file tool's path is absolute.
  check(run, call, { cwd = null, at = null, agent = null } = {}) {
    if (call.checked || call.refused) return
    call.checked = true
    if (Number.isFinite(at)) call.at = at
    const { part } = call
    if (FILE_TOOLS[part.name]) {
      const path = part.input?.[FILE_TOOLS[part.name]]
      const raw = typeof path === 'string' ? this.expand(run, run.dir, path) : null
      const target = raw === null ? null : posix.resolve(raw)
      const op = part.name === 'Write' ? 'create' : 'edit'
      if (target) run.files.add(target)
      if (target && (!this.allowed(run, target, op, raw) || gitHook(target))) {
        this.outside(run, call, { path: target, raw, op, detail: `${part.name} ${target}` })
      }
      // A work folder is all the run's own; its edits count as edits.
      const helper = target && !run.scratch && (inHelperFolder(posix.relative(run.dir, target)) || within(target, run.helpers))
      if (helper) run.helperEdits++
      else run.edits++
      if (run.edits > this.maxEdits) {
        this.violation(run, 'many changes', `more than ${this.maxEdits} file edits in one run`)
      }
      if (run.helperEdits > this.maxHelperFiles) {
        this.violation(
          run,
          'many changes',
          `more than ${this.maxHelperFiles} file edits in the helper folder ${HELPER_FOLDER}, the run folder and the temporary folders in one run`,
        )
      }
    } else {
      // The main thread's shell keeps its folder from one call to the next;
      // a subagent's call starts there and leaves it as it was (toolResult).
      // A report names the folder exactly: for the main thread, it is the
      // shell's, also after a cd the rule could not follow.
      const main = !call.parent && !agent
      if (cwd && main) run.cwd = cwd
      call.before = cwd ?? run.cwd
      const after = this.shell(run, part.input.command, call.before, call)
      call.after = after
      // Until the result says more: a folder in the workspace stays, as
      // Claude Code keeps it; one outside it, or one the rule cannot tell,
      // leaves the folder as it was.
      if (main && !part.input.run_in_background && after && within(after, [run.dir])) run.cwd = after
    }
    if (call.candidates.length) {
      if (!run.pending) this.waiting(run, true)
      run.pending += call.candidates.length
    }
  }

  async ended(task) {
    const run = this.runs.get(task.id)
    if (!run) return
    this.runs.delete(task.id)
    // The calls without a result, such as the one a stop ended: what they
    // wrote is there now. One the guard's hook refused never ran.
    for (const call of run.calls.values()) {
      if (call.refused) {
        this.refuse(run, call, call.refused)
        continue
      }
      this.check(run, call)
      if (call.candidates.length) this.decide(run, call)
    }
    run.calls.clear()
    await run.ready
    while (run.deciding.size) await Promise.all([...run.deciding])
    const size = await this.checkSize(run)
    if (size) this.emit('measured', task, { ...size, pushed: run.pushed.size > 0 })
  }

  // The commands of a Bash call, as a shell runs them (walkShell, fence.mjs,
  // the same code the guard's hook reads them with), with the folder each
  // runs in: cd changes it for what follows, but not out of a subshell or a
  // substitution; after a cd whose target a variable hides, only absolute
  // targets count. sh -c, bash -c and eval run their text, and a script that
  // cat or tee wrote from a heredoc is checked as shell commands when the
  // same call runs it, with a shell or by its path. Returns the folder the
  // call leaves its shell in, null where it cannot tell. call: the tool call,
  // whose writes may go to quarantine (outside). A git push is no rule of its
  // own: the branches it names are for the size check (commitRefs, reused),
  // and for the pull requests the run pushed. found: for a call that did not
  // run (refuse), where its writes outside and a change of the crontab go
  // instead, with nothing else done.
  shell(run, command, cwd = run.dir, call = null, found = null) {
    return walkShell(command, cwd, { home: run.home, runFolder: run.runFolder }, {
      command: (name, args, { shown }) => {
        // A cron job runs whatever it says, later: only a listing is no write.
        const crontab = name === 'crontab' && !cronListing(args)
        if (found) {
          if (crontab) found.push({ path: 'the crontab', op: 'crontab', detail: `${shown} changes the crontab` })
          return
        }
        const push = name === 'git' ? pushTargets(args) : null
        if (push) {
          for (const branch of push.branches) {
            run.pushed.add(branch)
            if (branch !== 'HEAD') this.pushedBy.set(`${run.repo}\0${branch}`, run.id)
          }
          if (push.elsewhere) run.pushedElsewhere = true
          // On the run's record too, for the pull requests it pushed
          // (pulls.mjs, PullWatcher.whose): HEAD for a push that names no
          // branch, such as a bare git push.
          const names = push.branches.length ? push.branches : ['HEAD']
          const known = Array.isArray(run.task.pushedBranches) ? run.task.pushedBranches : []
          run.task.pushedBranches = [...known.filter(b => !names.includes(b)), ...names].slice(-MAX_PUSHED)
        }
        if (crontab) this.violation(run, OUTSIDE, `${shown} changes the crontab, which locks at once`)
      },
      write: ({ path, raw, op, shown }) => {
        if (!path || (this.allowed(run, path, op, raw) && !gitHook(path))) return
        const write = { path, raw, op, detail: `${shown} writes ${path}`, shown }
        if (found) found.push(write)
        else this.outside(run, call, write)
      },
    })
  }

  // --- writes -------------------------------------------------------------------

  // An invalid write: it locks, or goes to quarantine once the call has
  // ended (decide), as the first or second of the run that makes a new plain
  // file in a place that is not sensitive. Only where the gateway has a
  // quarantine folder, the runner can look and move, and the rules lock
  // (VOICE_GW_KILLSWITCH=auto); otherwise every one locks, as before. A
  // gateway that took the run over and reads its calls again finds what an
  // earlier one moved kept with the task, by the call and the path.
  // A write in a folder granted to the run's repository comes here only for
  // what is sensitive in itself there too (granted), and locks at once.
  outside(run, call, { path, raw = path, op, detail, shown = detail }) {
    const refused = this.granted(run, path, op, raw)?.why ?? null
    const why = refused ?? this.sensitive(run, path, op)
    const lets = Boolean(this.quarantine && call && run.runner.inspect && run.runner.quarantine) && this.killswitch.locks?.('rule') !== false
    if (!lets) return this.violation(run, OUTSIDE, refused || gitHook(path) ? `${detail}: ${why}` : detail)
    if (why) return this.violation(run, OUTSIDE, `${detail}: ${why}, which locks at once`)
    const earlier = call.id && (run.task.quarantined ?? []).find(entry => entry.tool === call.id && entry.path === path)
    if (earlier) {
      run.invalid = Math.max(run.invalid, earlier.n)
      return
    }
    if (run.invalid >= QUARANTINE_FREE) {
      return this.violation(run, OUTSIDE, `${detail}: the third invalid write in one run, ${this.earlier(run)}`)
    }
    run.invalid++
    run.kinds.push('quarantine')
    call.candidates.push({ path, detail, shown, n: run.invalid })
  }

  // The invalid writes of a run before its third, in a few words: those
  // that went to quarantine and those the guard's hook refused.
  earlier(run) {
    const moved = run.kinds.filter(kind => kind === 'quarantine').length
    const refused = run.kinds.length - moved
    if (run.kinds.length < run.invalid) return `after ${run.invalid} that went to quarantine or that the guard's hook refused`
    if (moved && refused) return `after ${moved} went to quarantine and the guard's hook refused ${refused}`
    return refused ? `after the guard's hook refused ${refused}` : `after ${moved} went to quarantine`
  }

  // The place a path is in: the repositories folder (the run's runner's,
  // also the work folders'), or the home folder; null for neither.
  placeOf(run, path) {
    const sameSide = this.runner !== run.runner && Boolean(this.runner.container) === Boolean(run.runner.container)
    const places = [run.runner.root, sameSide ? this.runner.root : null, run.home]
      .filter(root => typeof root === 'string' && root.startsWith('/'))
      .sort((a, b) => b.length - a.length)
    return places.find(root => within(path, [root])) ?? null
  }

  // The run folders the gateway knows (workspaces.mjs, Workers' state), and
  // those of the runs going.
  runFolders() {
    const known = Object.keys(this.workers.state?.runFolders ?? {})
    const going = [...this.runs.values()].map(run => run.runFolder).filter(Boolean)
    return [...new Set([...known, ...going])]
  }

  // The folder that holds the run folders of the run's repository,
  // <repositories folder>/.voice-runs/<repository>, if the path is under it
  // and in none of the run folders there; else null. A new file there is a
  // slip with a run folder's path, such as one with a guessed date (tu46 on
  // 2026-11-07 wrote .voice-runs/drawio-mcp/2026-11-07-84rf/pr-body.md while
  // its folder was 2026-11-06-84rf), and may go to quarantine as one in
  // the home folder may; another run's folder, another repository's, the
  // worktrees and everything hidden there still lock at once.
  ownRunTree(run, path) {
    if (run.scratch || typeof run.runner.root !== 'string') return null
    const tree = posix.join(run.runner.root, RUN_FOLDERS, run.repo)
    if (!path.startsWith(`${tree}/`)) return null
    return within(path, this.runFolders()) ? null : tree
  }

  // Why an invalid write locks at once, or null for a new file in a place
  // that is not sensitive: in the home folder or the repositories folder (the
  // run's runner's, also the work folders'), outside every hidden file and
  // folder (shell profiles and rc files, ~/.ssh, ~/.claude, ~/.config with
  // autostart and systemd, .git, .github with the CI workflows), not a shell
  // profile, a hooks folder, a CI file, ~/Library on macOS, the gateway's
  // own checkout or a folder on the PATH. The one hidden folder that may
  // take one is the run folders' of the run's own repository, outside every
  // run folder (ownRunTree). Whether it is in a git repository only a look
  // tells (decide).
  sensitive(run, path, op) {
    if (gitHook(path)) return 'a git hook'
    if (LOCKING_OPS[op]) return LOCKING_OPS[op]
    const place = this.placeOf(run, path)
    if (!place) return 'outside the home folder and the repositories folder'
    const parts = posix.relative(place, path).split('/')
    const name = parts.at(-1)
    const tree = this.ownRunTree(run, path)
    if (!tree && place === run.runner.root && parts[0] === RUN_FOLDERS && within(path, this.runFolders())) return "another run's run folder"
    const hidden = tree ? posix.relative(tree, path).split('/') : parts
    if (hidden.some(part => part.startsWith('.'))) return 'a hidden file or folder, where settings, keys and configuration live'
    if (SHELL_FILES.test(name)) return 'a shell profile or rc file'
    if (parts.includes('hooks')) return 'a hooks folder'
    if (CI_FILES.has(name)) return 'a CI workflow file'
    if (place === run.home && parts[0] === 'Library') return "macOS's Library folder, with the settings and launch agents of its apps"
    if (!run.runner.container && within(path, [this.gateway])) return "the gateway's own checkout"
    if (!run.runner.container && pathFolders(run.home).includes(posix.dirname(path))) return 'a folder on the PATH'
    return null
  }

  // Why an attempt at a write outside locks at once even though the guard's
  // hook refused it before it ran, or null where the attempt only counts as
  // an invalid write (refuse). A worker that tidies up a tool's cache or log
  // in the home folder, guesses its run folder's name or makes a folder for a
  // browser profile is not after these; one that reaches for them is, and
  // must not get more tries for a way the rule cannot see: a git hook or a
  // .git folder, a hooks folder, a shell profile, the crontab, keys and
  // credentials (SECRETS), what starts programs by itself (AUTOSTART), Claude
  // Code's own folder and the .claude settings of any project, CI workflows,
  // a folder on the PATH, the gateway's checkout, and every place outside the
  // home folder and the repositories folder.
  severe(run, path, op) {
    if (op === 'crontab') return 'it changes the crontab'
    if (gitHook(path)) return 'a git hook'
    const place = this.placeOf(run, path)
    if (!place) return 'outside the home folder and the repositories folder'
    const parts = posix.relative(place, path).split('/')
    const name = parts.at(-1)
    const under = folders => folders.some(folder => within(parts.join('/'), [folder]))
    if (parts.includes('.git')) return "a git repository's .git folder"
    if (SHELL_FILES.test(name)) return 'a shell profile or rc file'
    if (parts.includes('hooks')) return 'a hooks folder'
    if (parts.includes('.github') || CI_FILES.has(name)) return 'a CI workflow file'
    if (parts.includes('.claude') || within(path, [run.claudeConfig])) return "Claude Code's settings, hooks or memory"
    if (place === run.home && under([...SECRETS])) return 'keys, credentials or the settings that hand them to tools'
    if (place === run.home && under(AUTOSTART)) return 'what starts programs by itself'
    if (!run.runner.container && within(path, [this.gateway])) return "the gateway's own checkout"
    if (!run.runner.container && pathFolders(run.home).includes(posix.dirname(path))) return 'a folder on the PATH'
    return null
  }

  // A call the guard's hook refused before it ran (toolResult): nothing of
  // it ran, so it is no write and no edit, and the shell's folder stays. The
  // rule reads it all the same, from the folder the hook's report names, for
  // what it would have written outside. An attempt at something severe
  // (severe) locks at once; any other counts as an invalid write of the
  // run, as one that went to quarantine does, and the third locks, as a
  // worker that keeps pushing against the fence. Kept with the task, for its
  // result, Telegram and a gateway that takes the run over. One in which the
  // rule finds nothing outside (a folder granted since, say) counts nothing.
  refuse(run, call, { cwd = null } = {}) {
    call.checked = true // never checked as a call that ran, also not by the wait for its report (tool)
    const { part } = call
    const found = []
    if (FILE_TOOLS[part.name]) {
      const given = part.input?.[FILE_TOOLS[part.name]]
      const raw = typeof given === 'string' ? this.expand(run, run.dir, given) : null
      const path = raw === null ? null : posix.resolve(raw)
      const op = part.name === 'Write' ? 'create' : 'edit'
      if (path && (!this.allowed(run, path, op, raw) || gitHook(path))) found.push({ path, op, detail: `${part.name} ${path}` })
    } else if (typeof part.input?.command === 'string') {
      this.shell(run, part.input.command, cwd ?? run.cwd, null, found)
    }
    const shown = FILE_TOOLS[part.name] ? `${part.name} ${found[0]?.path ?? part.input?.[FILE_TOOLS[part.name]]}` : `"${preview(part.input?.command ?? '', 120)}"`
    const where = `(worker ${run.repo}, task ${run.id})`
    if (!found.length) {
      return this.log(`kill switch rule on writes outside: the guard's hook refused ${shown}, in which the rule finds no write outside; it counts nothing ${where}`)
    }
    const severe = found.map(write => ({ write, why: this.severe(run, write.path, write.op) })).find(each => each.why)
    if (severe) {
      return this.violation(run, OUTSIDE, `${severe.write.detail}: ${severe.why}; the guard's hook refused it before it ran, but an attempt at that locks at once`)
    }
    const earlier = call.id && (run.task.refused ?? []).find(entry => entry.tool === call.id)
    if (earlier) {
      run.invalid = Math.max(run.invalid, earlier.n)
      return
    }
    const detail = found[0].detail
    if (run.invalid >= QUARANTINE_FREE) {
      return this.violation(run, OUTSIDE, `${detail}: the third invalid write in one run, refused by the guard's hook before it ran, ${this.earlier(run)}`)
    }
    run.invalid++
    run.kinds.push('refused')
    const entry = { n: run.invalid, tool: call.id, paths: [...new Set(found.map(write => write.path))].slice(0, 5), command: shown, at: Date.now() }
    run.task.refused = [...(run.task.refused ?? []), entry]
    try {
      this.workers.save?.()
    } catch (error) {
      this.log('worker state not saved:', error.message)
    }
    this.log(
      `kill switch rule on writes outside the allowed folders: the guard's hook refused ${shown} before it ran, which would ` +
        `have written ${entry.paths.join(', ')}; invalid write ${entry.n} of the run; the ${entry.n >= QUARANTINE_FREE ? 'next' : 'third'} ` +
        `locks the kill switch ${where}`,
    )
    this.emit('refused', run.task, entry)
    if (entry.n >= QUARANTINE_FREE) this.note(run, refusedNote(entry))
  }

  // The invalid writes of a call that may go to quarantine, now that it has
  // ended: each a new plain file, born after the call started, in no git
  // repository, moved into the quarantine folder; otherwise it locks.
  decide(run, call) {
    const candidates = call.candidates.splice(0)
    const deciding = (async () => {
      for (const candidate of candidates) await this.toQuarantine(run, call, candidate)
    })()
      .catch(error => this.violation(run, OUTSIDE, `${candidates[0].detail}, and the guard could not quarantine it (${preview(error?.message ?? error, 60)})`))
      .finally(() => {
        run.pending -= candidates.length
        if (run.pending <= 0) this.waiting(run, false)
        run.deciding.delete(deciding)
      })
    run.deciding.add(deciding)
  }

  async toQuarantine(run, call, { path, detail, shown, n }) {
    const found = await Promise.resolve()
      .then(() => run.runner.inspect(path))
      .catch(() => null)
    const since = (call.at ?? call.seenAt - START_SLACK_MS) - 1000
    const why = !found
      ? 'which the guard could not look at afterwards'
      : found.repo
        ? 'in a git repository'
        : found.kind === 'missing'
          ? 'which is not there afterwards, so the guard cannot tell what it wrote'
          : found.kind !== 'file' || found.links > 1
            ? 'which is no plain file'
            : found.born === null
              ? 'whose age the file system does not tell'
              : found.born < since
                ? 'which was there before: the command changed an existing file'
                : null
    if (why) return this.violation(run, OUTSIDE, `${detail}, ${why}, which locks at once`)
    const file = join(this.quarantine, run.id, `${n}-${posix.basename(path)}`)
    const moved = await Promise.resolve()
      .then(() => run.runner.quarantine(path, file))
      .catch(() => false)
    if (!moved) return this.violation(run, OUTSIDE, `${detail}, and the guard could not move it to quarantine`)
    const tidied = await this.tidy(run, path, since)
    const entry = { n, tool: call.id, path, file, command: shown, at: Date.now(), ...(tidied.length ? { folders: tidied } : {}) }
    run.task.quarantined = [...(run.task.quarantined ?? []), entry]
    try {
      this.workers.save?.()
    } catch (error) {
      this.log('worker state not saved:', error.message)
    }
    try {
      appendFileSync(join(this.quarantine, run.id, 'quarantine.jsonl'), JSON.stringify({ ...entry, worker: run.repo, task: run.id }) + '\n', { mode: 0o600 })
    } catch (error) {
      this.log('quarantine record not written:', error.message)
    }
    this.log(
      `kill switch rule on writes outside the allowed folders: moved ${path} to quarantine (${file}), invalid write ${n} of ` +
        `the run, by ${shown}; the ${n >= QUARANTINE_FREE ? 'next' : 'third'} locks the kill switch (worker ${run.repo}, task ${run.id})` +
        (tidied.length ? `; removed the empty folder${tidied.length === 1 ? '' : 's'} it made, ${tidied.join(', ')}` : ''),
    )
    this.emit('quarantined', run.task, entry)
    await this.note(run, quarantineNote(run, entry, this.grantedFolders(run)))
  }

  // After a file under the run folders of the run's own repository went to
  // quarantine (ownRunTree): the folders above it up to there that the call
  // made, such as the Write tool makes for a path it is given, once they are
  // empty, so that nothing is left that looks like a run folder. Only
  // folders born after the call started; never one that holds anything.
  // Returns the folders removed.
  async tidy(run, path, since) {
    const tree = this.ownRunTree(run, path)
    const removed = []
    if (!tree || !run.runner.removeEmpty) return removed
    for (let dir = posix.dirname(path); dir !== tree && dir.startsWith(`${tree}/`); dir = posix.dirname(dir)) {
      const found = await Promise.resolve()
        .then(() => run.runner.inspect(dir))
        .catch(() => null)
      if (found?.kind !== 'dir' || found.born === null || found.born < since) break
      if (!(await Promise.resolve().then(() => run.runner.removeEmpty(dir)).catch(() => false))) break
      removed.push(dir)
    }
    return removed
  }

  // For the guard's hook, which hands it to the worker with its next tool
  // call, or before it ends its turn (guardHooks): through docker exec into
  // the container, on this computer next to the run's output.
  // One after the other, in the order the guard gives them, so that the
  // hook never finds the wait cleared before the note is there.
  note(run, text) {
    return this.mailbox(run, 'note for the worker not written', () => {
      if (run.runner.container) return run.runner.sh('mkdir -p "$(dirname "$1")" && printf "%s\\n\\n" "$2" >> "$1"', [run.notes, text])
      mkdirSync(dirname(run.notes), { recursive: true, mode: 0o700 })
      appendFileSync(run.notes, `${text}\n\n`, { mode: 0o600 })
    })
  }

  // While the guard decides about a write, the hook lets the turn end only
  // after it (guardHooks): a file .wait next to the notes.
  waiting(run, on) {
    const file = `${run.notes}.wait`
    return this.mailbox(run, `wait for the guard not ${on ? 'set' : 'cleared'}`, () => {
      if (run.runner.container) return run.runner.sh(on ? 'mkdir -p "$(dirname "$1")" && : > "$1"' : 'rm -f "$1"', [file])
      if (!on) return rmSync(file, { force: true })
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, '', { mode: 0o600 })
    })
  }

  mailbox(run, failed, write) {
    if (!run.notes) return Promise.resolve()
    run.mailbox = (run.mailbox ?? Promise.resolve())
      .then(write)
      .then(result => {
        if (result && result.ok === false) throw new Error('docker exec failed')
      })
      .catch(error => this.log(`${failed} (worker ${run.repo}, task ${run.id}):`, error.message))
    return run.mailbox
  }

  // A path as the run writes it, with its .. and . as written, as the kernel
  // gets it (after a link, .. goes up from where the link led: grants.mjs,
  // physicalPath), or null where a variable hides it; ~ and $HOME are the
  // run's home, $TMPDIR and $VOICE_GW_RUN_FOLDER its run folder, which the
  // gateway set for it (workers.mjs). As the guard's hook reads it
  // (fence.mjs, expandPath).
  expand(run, base, path) {
    return expandPath(path, base, { home: run.home, runFolder: run.runFolder })
  }

  // Whether a write may go there without the rule: its workspace, its memory
  // folders, the temporary folders, its run folder, VOICE_GW_KILL_ALLOW_PATHS,
  // or a folder granted to its repository, for what is not sensitive in
  // itself there (granted). op: what the write does (LOCKING_OPS, or
  // create); raw: the path as expand gave it.
  allowed(run, path, op = 'create', raw = path) {
    if (isDevice(path)) return true
    if (within(path, [run.dir, ...run.memories, ...run.roots])) return true
    const grant = this.granted(run, path, op, raw)
    return Boolean(grant && !grant.why)
  }

  // The one check of a write against the path grants (grants.mjs): null
  // where it lies in no folder granted to the run's repository, otherwise
  // { folder, why }, why null where the grant lets it. Only for runs in a
  // repository on this computer: a path of this computer means nothing in
  // the container, and a work folder has no grants.
  granted(run, path, op = 'create', raw = path) {
    if (!this.grants || run.scratch || run.runner.container) return null
    return this.grants.check(run.repo, path, op, raw, { task: run.id, at: Date.now() })
  }

  // The folders granted to the run's repository now, for the worker's note.
  grantedFolders(run) {
    if (!this.grants || run.scratch || run.runner.container) return []
    return this.grants.folders(run.repo, { task: run.id, at: Date.now() })
  }

  // --- size ---------------------------------------------------------------------

  // The refs whose commits since its start a run made: in a worktree, what
  // its HEAD and the branches it pushed have; in the checkout every ref, but
  // not what the worktrees of other runs of the repository have, nor the
  // branches they pushed. Several runs in one repository share its refs.
  async commitRefs(run) {
    // Refs that may be gone (a branch never pushed) are left out by git.
    const pushed = [...run.pushed].filter(b => b !== 'HEAD').map(b => `refs/remotes/origin/${b}`)
    if (run.worktree) return ['--ignore-missing', 'HEAD', ...pushed]
    const others = []
    for (const [key, id] of this.pushedBy) {
      const [repo, branch] = key.split('\0')
      if (repo === run.repo && id !== run.id) others.push(`refs/remotes/origin/${branch}`, `refs/heads/${branch}`)
    }
    const worktrees = run.runner.gitRun ? await listWorktrees(run.runner, run.dir).catch(() => []) : []
    for (const w of worktrees) if (w.head && w.dir.split('/').includes(WORKTREES)) others.push(w.head)
    return others.length ? ['--ignore-missing', '--all', '--not', ...others] : ['--all']
  }

  // Returns what it found, { commits, files, lines }, or null for a work
  // folder. What is untracked in the helper folder is no change of the run's:
  // it counts apart, against maxHelperFiles, and not in what it found. What
  // was committed from there, or is tracked there, counts as anywhere else.
  // What commits on the run's own branches took over from before the run
  // counts nothing (reused), and is not in what it found either.
  async checkSize(run) {
    if (run.scratch) {
      await this.checkFiles(run)
      return null
    }
    const since = Math.floor(run.startedAt / 1000)
    const refs = await this.commitRefs(run)
    const [committed, pending, untracked] = await Promise.all([
      run.runner.git(run.dir, 'log', ...refs, `--since=@${since}`, '--numstat', '--format=commit %H'),
      run.runner.git(run.dir, 'diff', '--numstat', 'HEAD'),
      run.runner.git(run.dir, 'ls-files', '--others', '--exclude-standard'),
    ])
    const reused = await this.reused(run, refs, committed).catch(() => new Set())
    const files = new Set()
    let lines = 0
    let commits = 0
    const left = { files: new Set(), lines: 0 } // what reused left out, for the log
    let sha = null
    for (const line of (committed ?? '').split('\n')) {
      if (line.startsWith('commit ')) {
        commits++
        sha = line.slice('commit '.length).trim()
        continue
      }
      const [added, deleted, path] = line.split('\t')
      if (!path) continue
      const size = (Number(added) || 0) + (Number(deleted) || 0)
      if (reused.has(`${sha}\0${path}`)) {
        left.files.add(path)
        left.lines += size
      } else {
        files.add(path)
        lines += size
      }
    }
    for (const line of (pending ?? '').split('\n')) {
      const [added, deleted, path] = line.split('\t')
      if (!path) continue
      files.add(path)
      lines += (Number(added) || 0) + (Number(deleted) || 0)
    }
    let helpers = 0
    for (const path of (untracked ?? '').split('\n')) {
      if (path && inHelperFolder(path)) helpers++
      else if (path) files.add(path)
    }
    const notCounted = left.files.size
      ? `, not counting ${left.lines} lines in ${left.files.size} files that branches the run made took over from before it`
      : ''
    if (notCounted) {
      this.log(`kill switch rule on many changes: ${files.size} files and ${lines} lines changed in one run${notCounted} (worker ${run.repo}, task ${run.id})`)
    }
    const over = []
    if (files.size > this.maxFiles || lines > this.maxLines) {
      over.push(`${files.size} files and ${lines} lines changed in one run (limits ${this.maxFiles} files, ${this.maxLines} lines)${notCounted}`)
    }
    if (helpers > this.maxHelperFiles) {
      over.push(`${helpers} untracked files in the helper folder ${HELPER_FOLDER} after one run (limit ${this.maxHelperFiles})`)
    }
    if (over.length) this.violation(run, 'many changes', over.join('; '))
    return { commits, files: files.size, lines }
  }

  // The file changes of the run's commits, as `${sha}\0${path}`, that take
  // over what was there before the run, and count nothing: on a branch the
  // run made, or on no branch, a file set to a version that a commit from
  // before the run had at that path (a review branch made of a branch's
  // existing code, a cherry-pick, a rebase), or removed where the default
  // branch does not have it (a branch without another branch's own files).
  // A commit that a branch from before the run holds, in the repository or
  // as a remote branch, counts in full: setting such a branch back, or
  // removing what it has, is a change, and so is rewriting its history.
  // Whatever git cannot tell counts, as before; so does all of it after a
  // push to a URL or a path, which no remote branch here shows.
  async reused(run, refs, committed) {
    const none = new Set()
    const shas = [...String(committed ?? '').matchAll(/^commit ([0-9a-f]{40,64})$/gm)].map(match => match[1])
    if (!shas.length || run.pushedElsewhere) return none
    const since = Math.floor(run.startedAt / 1000)
    const git = (...args) => run.runner.git(run.dir, ...args)
    // The branches that hold them, and of those the ones from before the run.
    const holding = await git('for-each-ref', '--format=%(refname)', ...shas.map(sha => `--contains=${sha}`), 'refs/heads', 'refs/remotes')
    if (holding === null) return none
    const before = await this.branchesBefore(run, holding.split('\n').filter(Boolean))
    if (!before) return none
    const theirs = before.length ? await git('rev-list', `--since=@${since}`, ...before) : ''
    if (theirs === null) return none
    const onBefore = new Set(theirs.split('\n'))
    const own = new Set(shas.filter(sha => !onBefore.has(sha)))
    if (!own.size) return none
    // What each of them did to each file: the version it left, or D. A
    // rename or a copy (two paths) counts, as does a path git quoted.
    const raw = await git('log', ...refs, `--since=@${since}`, '--raw', '--no-abbrev', '--format=commit %H')
    if (raw === null) return none
    const changes = []
    let sha = null
    for (const line of raw.split('\n')) {
      if (line.startsWith('commit ')) sha = line.slice('commit '.length).trim()
      if (!line.startsWith(':') || !own.has(sha)) continue
      const [meta, path, renamed] = line.split('\t') // :mode mode before after status, then the path
      const [, , , after, status] = meta.split(' ')
      if (path && renamed === undefined && !path.startsWith('"')) changes.push({ key: `${sha}\0${path}`, path, after, status })
    }
    const kept = changes.filter(change => ['A', 'M', 'T'].includes(change.status))
    const removed = changes.filter(change => change.status === 'D')
    const [versions, onDefault] = await Promise.all([
      kept.length ? this.versionsBefore(run, [...new Set(kept.map(change => change.path))]) : null,
      removed.length ? this.defaultPaths(run) : null,
    ])
    const reused = new Set()
    for (const change of kept) if (versions?.has(`${change.path}\0${change.after}`)) reused.add(change.key)
    for (const change of removed) if (onDefault && !onDefault.has(change.path)) reused.add(change.key)
    return reused
  }

  // Of the given branches, the ones from before the run: all but those it
  // made, whose reflog begins during the run with the branch's creation,
  // for a remote branch by a push (one a fetch brought was on the remote).
  // A creation has no value before it, so ref@{n} past the oldest entry
  // names none; after git expired older entries it names the value before.
  // A branch without a reflog counts as from before. null when git cannot
  // tell.
  async branchesBefore(run, branches) {
    if (!branches.length) return []
    const since = Math.floor(run.startedAt / 1000)
    const git = (...args) => run.runner.git(run.dir, ...args)
    const reflog = await git('log', '--walk-reflogs', '--date=unix', '--format=%gD %gs', ...branches)
    if (reflog === null) return null
    const entries = new Map() // branch -> { count, at, what } of its oldest entry; the newest come first
    for (const line of reflog.split('\n')) {
      const match = /^(.+)@\{(\d+)\}(?: (.*))?$/.exec(line)
      if (!match) continue
      const entry = entries.get(match[1]) ?? { count: 0 }
      entries.set(match[1], { count: entry.count + 1, at: Number(match[2]), what: match[3] ?? '' })
    }
    const made = await Promise.all(
      branches.map(async branch => {
        const oldest = entries.get(branch)
        if (!oldest || oldest.at < since) return false
        if (branch.startsWith('refs/remotes/') && oldest.what !== 'update by push') return false
        // Its oldest entry names a value and nothing came before it: a
        // creation, and not a git that did not answer.
        const [last, past] = await Promise.all(
          [oldest.count - 1, oldest.count].map(n => git('rev-parse', '--quiet', '--verify', `${branch}@{${n}}`)),
        )
        return last !== null && past === null
      }),
    )
    return branches.filter((branch, i) => !made[i])
  }

  // The versions that commits from before the run had at the given paths,
  // as `${path}\0${blob}`, from the whole history of the repository; null
  // when git cannot tell, or for too many paths.
  async versionsBefore(run, paths) {
    if (paths.length > PATHS_PER_LOOK * MAX_LOOKS) return null
    const until = Math.floor(run.startedAt / 1000) - 1
    const versions = new Set()
    for (let i = 0; i < paths.length; i += PATHS_PER_LOOK) {
      const out = await this.slowGit(run, [
        '--literal-pathspecs',
        'log',
        '--all',
        `--until=@${until}`,
        '--full-history',
        '-m',
        '--root',
        '--no-renames',
        '--raw',
        '--no-abbrev',
        '--format=',
        '--',
        ...paths.slice(i, i + PATHS_PER_LOOK),
      ])
      if (out === null) return null
      for (const line of out.split('\n')) {
        const [meta, path] = line.split('\t')
        if (!line.startsWith(':') || !path) continue
        const [, , before, after] = meta.split(' ')
        for (const blob of [before, after]) if (!/^0+$/.test(blob)) versions.add(`${path}\0${blob}`)
      }
    }
    return versions
  }

  // The paths of the default branch as the remote has it, or null.
  async defaultPaths(run) {
    if (!run.branch) return null
    const out = await this.slowGit(run, ['ls-tree', '-r', '--name-only', '--full-tree', `refs/remotes/origin/${run.branch}`])
    return out === null ? null : new Set(out.split('\n').filter(Boolean))
  }

  // git for a look that may take longer: with a time limit of its own where
  // the runner has gitRun, on this computer or in the container.
  async slowGit(run, args) {
    if (!run.runner.gitRun) return run.runner.git(run.dir, ...args)
    const { ok, stdout } = await run.runner.gitRun(run.dir, args, { timeout: HISTORY_MS })
    return ok ? stdout : null
  }

  // A work folder has no git: the files in it at the end count.
  async checkFiles(run) {
    const files = await Promise.resolve()
      .then(() => run.runner.files?.(run.dir, this.maxFiles))
      .catch(() => null)
    if (files && files.length > this.maxFiles) {
      this.violation(run, 'many changes', `more than ${this.maxFiles} files in the work folder after one run`)
    }
  }
}
