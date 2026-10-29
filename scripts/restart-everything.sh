#!/usr/bin/env bash
# Restarts everything of this gateway, for when something no longer works:
# run it as it is, without looking at anything first. It asks nothing, says in
# plain lines what it stops and starts, and ends with the status, or with what
# still fails and where to look.
#
#   scripts/restart-everything.sh
#
# 1. What runs: scripts/start-controller.sh --status, the worker runs going
#    and what the restart does to them, the queued tasks.
# 2. Telegram, as for any restart on purpose and nothing else: "a restart was
#    requested" (start-controller.sh --announce-restart, which also leaves the
#    reason for the watchdogs), then the stopping watchdog's message that the
#    gateway is shutting down, with its statistics, then the next gateway's
#    when the controller is ready again.
# 3. Down: the autostart (the systemd user service on Linux, stopped with
#    systemctl, whose ExecStop is start-controller.sh --stop; the LaunchAgent on
#    macOS, which has no stop of its own), and a watchdog in tmux, with
#    start-controller.sh --stop. Then what is left of this checkout, and only of
#    it (start-controller.sh --processes): the watchdog and the controller
#    session the lock names, gateway processes of this checkout (src/plugin.mjs,
#    src/gateway.mjs, by their resolved path), a stale lock. A process on the
#    gateway's port that is not this gateway is named, not touched. Other Claude
#    Code sessions, other projects and whatever it cannot attribute to this
#    checkout stay as they are.
# 4. The workers' container (VOICE_GW_DOCKER) and the work folders'
#    (VOICE_GW_SCRATCH_DOCKER), only when one is not running, which a clean
#    start needs, and the kill switch is not locked: scripts/start-workers-container.sh.
# 5. Up: the service, the LaunchAgent, or the tmux session "voice".
# 6. Waits until --status shows the watchdog running and the gateway's port
#    answering, at most VOICE_GW_RESTART_WAIT seconds (120).
#
# Worker runs on this computer belong to the service on Linux: its stop ends
# them. The gateway after the start then sends a run in a worktree back to the
# queue, where it resumes, and reports a run in a repository's checkout as
# failed, not queued again. Under tmux and the LaunchAgent, and in a
# container, they keep running, and the next gateway follows them. Queued
# tasks stay queued.
#
# Run from inside the service, such as a window of its tmux session, it moves
# itself out first (systemd-run --scope), or the stop would end it too. It logs
# to the gateway's log, as the watchdog does, as "restart-everything:" lines.

set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
. "$ROOT/scripts/settings.sh"
START=$ROOT/scripts/start-controller.sh
STATE=${VOICE_GW_STATE_DIR:-$ROOT/.state}
SECRETS=${VOICE_GW_SECRETS_DIR:-$ROOT/.secrets}
LOG=${VOICE_GW_LOG_FILE-$ROOT/.logs/gateway.log}
SERVICE=cc-voice-gateway.service # src/platform.mjs
AGENT=com.drawio.cc-voice-gateway
REASON='a restart of everything (scripts/restart-everything.sh)'
WAIT=${VOICE_GW_RESTART_WAIT:-120}
[[ $WAIT =~ ^[0-9]+$ ]] || WAIT=120

num() { LC_ALL=C "$@"; }

# Every line to the terminal and to the gateway's log.
say() {
  printf '%s\n' "$*"
  if [ -n "$LOG" ]; then
    (umask 077 && mkdir -p "$(dirname "$LOG")") &&
      printf '%s restart-everything: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG" || true
  fi
}

# Inside the service's processes, its stop would end this script too.
if [ -z "${VOICE_GW_RESTART_MOVED:-}" ] && grep -qs "/$SERVICE" /proc/self/cgroup && command -v systemd-run >/dev/null 2>&1; then
  export VOICE_GW_RESTART_MOVED=1
  exec systemd-run --user --scope --quiet --collect "$0" "$@"
fi

linux_service() {
  command -v systemctl >/dev/null 2>&1 && [ "$(systemctl --user show -p LoadState --value "$SERVICE" 2>/dev/null)" = loaded ]
}
macos=0
[ "$(uname -s 2>/dev/null)" = Darwin ] && macos=1
PLIST=$HOME/Library/LaunchAgents/$AGENT.plist
setup=tmux
if [ "$macos" = 1 ] && [ -f "$PLIST" ]; then
  setup=launchagent
elif [ "$macos" = 0 ] && linux_service; then
  setup=service
fi

say "restarting everything of the gateway in $ROOT, started by $(id -un)$(tty -s 2>/dev/null && printf ' on %s' "$(tty)")"
case $setup in
  service) say "the autostart: the systemd user service $SERVICE" ;;
  launchagent) say "the autostart: the LaunchAgent $AGENT" ;;
  *) say 'no autostart: the controller runs in the tmux session "voice"' ;;
esac

# --- 1. what runs, and what the restart does to it ---------------------------

"$START" --status | while IFS= read -r line; do say "before: ${line#start-controller: }"; done

# Worker runs on this computer end with the service's stop (KillMode
# control-group or mixed, systemd's default being control-group).
kills=0
if [ "$setup" = service ]; then
  case $(systemctl --user show -p KillMode --value "$SERVICE" 2>/dev/null) in control-group | mixed | '') kills=1 ;; esac
fi
node -e '
  const [file, kills] = [process.argv[1], process.argv[2] === "1"]
  let state
  try { state = JSON.parse(require("fs").readFileSync(file, "utf8")) } catch { process.exit(0) }
  const minutes = ms => { const m = Math.round(ms / 60000); return m < 1 ? "less than a minute" : m + " min" }
  for (const t of (state.tasks ?? []).filter(t => t && t.state === "running")) {
    const where = t.worktree ? "in a worktree of " + t.repo : t.kind === "scratch" ? "in the work folder " + t.repo : "in " + t.repo
    const head = "worker run " + t.id + " " + where + ", running for " + minutes(Date.now() - (t.startedAt ?? Date.now())) + ": "
    if (t.container) console.log(head + "it runs in the container " + t.container + " and keeps running; the gateway after the start follows it")
    else if (!kills) console.log(head + "it keeps running; the gateway after the start follows it")
    else if (t.worktree) console.log(head + "the stop of the service ends it; after the start it goes back to the queue and resumes in its worktree")
    else console.log(head + "the stop of the service ends it; after the start the gateway reports it as failed, and it is not queued again")
  }
  const queued = (state.queue ?? []).length
  if (queued === 1) console.log("1 queued task: it stays queued and starts by itself after the start")
  else if (queued) console.log(queued + " queued tasks: they stay queued and start by themselves after the start, in their order")
' "$STATE/workers.json" "$kills" 2>/dev/null | while IFS= read -r line; do say "$line"; done

# --- 2. Telegram: a restart was requested --------------------------------------

"$START" --announce-restart "$REASON" >/dev/null 2>&1 || true

# --- 3. down ---------------------------------------------------------------------

if [ "$setup" = service ] && [ "$(systemctl --user is-active "$SERVICE" 2>/dev/null)" != inactive ]; then
  say "stopping the service $SERVICE"
  systemctl --user stop "$SERVICE" >/dev/null 2>&1 || say "systemctl --user stop $SERVICE failed; going on"
fi
stopped=$("$START" --stop 2>&1)
case $stopped in
  *'not running'*) ;;
  *stopped*) say "stopped the watchdog and the controller session" ;;
  *) say "the watchdog did not stop by itself: ${stopped#start-controller: }" ;;
esac

# What is left of this checkout: SIGTERM, then SIGKILL after five seconds.
processes() { "$START" --processes 2>/dev/null; }
alive() { kill -0 "$1" 2>/dev/null; }
end_process() {
  local pid=$1 what=$2
  alive "$pid" || return 0
  say "ending $what (process $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    alive "$pid" || return 0
    num sleep 0.2
  done
  say "$what (process $pid) did not end: SIGKILL"
  kill -KILL "$pid" 2>/dev/null || true
}
left=$(processes)
while read -r kind pid ppid script; do
  case $kind in
    watchdog) end_process "$pid" 'the watchdog left over' ;;
    session) end_process "$pid" 'the controller session left over' ;;
    gateway) end_process "$pid" "a gateway of this checkout left over ($script)" ;;
  esac
done <<<"$left"
left=$(processes)
if grep -q '^lock stale' <<<"$left"; then
  rm -rf "${STATE:?}/controller.lock"
  say 'removed the lock a watchdog left behind'
fi
ours=$(awk '$1 == "gateway" { print $2 }' <<<"$left")
port=$(awk '$1 == "port" { print $2 }' <<<"$left")
foreign=
for pid in $(awk '$1 == "listener" { print $2 }' <<<"$left"); do
  if ! grep -qx "$pid" <<<"$ours"; then
    foreign="$foreign $pid"
    say "the gateway's port $port is taken by process $pid ($(ps -p "$pid" -o args= 2>/dev/null | cut -c1-80)), which is not this gateway: not touched; the gateway cannot start until it is free"
  fi
done

# --- 4. the containers, only when a clean start needs them ------------------------

docker_bin=${VOICE_GW_DOCKER_BIN:-docker}
container() {
  local name=$1 flag=$2 what=$3 running
  [ -n "$name" ] || return 0
  running=$("$docker_bin" inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo missing)
  if [ "$running" = true ]; then
    say "$what $name runs: left as it is"
  elif [ -e "$SECRETS/killswitch.json" ]; then
    say "$what $name does not run, and the kill switch is locked: it stays stopped (node scripts/unlock.mjs --status)"
  else
    say "$what $name does not run: starting it"
    "$ROOT/scripts/start-workers-container.sh" $flag >/dev/null 2>&1 || say "starting $what $name failed: run scripts/start-workers-container.sh $flag at the terminal"
  fi
}
container "${VOICE_GW_DOCKER:-}" '' "the workers' container"
container "${VOICE_GW_SCRATCH_DOCKER:-}" --scratch "the work folders' container"

# --- 5. up -----------------------------------------------------------------------

case $setup in
  service)
    say "starting the service $SERVICE"
    systemctl --user start "$SERVICE" >/dev/null 2>&1 || say "systemctl --user start $SERVICE failed"
    ;;
  launchagent)
    domain=gui/$(id -u)
    if launchctl print "$domain/$AGENT" >/dev/null 2>&1; then
      say "starting the LaunchAgent $AGENT"
      launchctl kickstart "$domain/$AGENT" >/dev/null 2>&1 || say "launchctl kickstart $domain/$AGENT failed"
    else
      say "loading the LaunchAgent $AGENT, which starts it"
      launchctl bootstrap "$domain" "$PLIST" >/dev/null 2>&1 || say "launchctl bootstrap $domain $PLIST failed"
    fi
    ;;
  *)
    if tmux has-session -t voice 2>/dev/null; then
      say 'starting the controller in a new window of the tmux session "voice"'
      tmux new-window -d -t voice -n controller "$START" || say 'tmux new-window failed'
    else
      say 'starting the controller in the tmux session "voice"'
      tmux new-session -d -s voice "$START" || say 'tmux new-session failed'
    fi
    ;;
esac

# --- 6. until it runs ------------------------------------------------------------

say "waiting for the controller and its gateway, at most $WAIT s"
status=
deadline=$(($(date +%s) + WAIT))
while :; do
  status=$("$START" --status 2>&1)
  if grep -q '^start-controller: running ' <<<"$status" && grep -q 'port [0-9]* answers$' <<<"$status"; then
    while IFS= read -r line; do say "now: ${line#start-controller: }"; done <<<"$status"
    say 'everything runs again'
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  num sleep 1
done
while IFS= read -r line; do say "now: ${line#start-controller: }"; done <<<"$status"
if ! grep -q '^start-controller: running ' <<<"$status"; then
  case $setup in
    service) say "the watchdog did not start: see journalctl --user -u $SERVICE and the gateway's log ${LOG:-(none)}" ;;
    launchagent) say "the watchdog did not start: see ~/Library/Logs/cc-voice-gateway.log and the gateway's log ${LOG:-(none)}" ;;
    *) say "the watchdog did not start: see tmux attach -t voice and the gateway's log ${LOG:-(none)}" ;;
  esac
elif [ -n "$foreign" ]; then
  say "the gateway cannot start while process${foreign} holds its port $port: end it (lsof -nP -iTCP:$port -sTCP:LISTEN), then run this script again"
elif [ "$(node "$ROOT/scripts/channel-mode.mjs" 2>/dev/null | cut -d' ' -f1)" != plugin ]; then
  say 'the gateway does not answer yet: the development channel waits for its warning to be confirmed at the terminal (tmux attach -t voice, then Enter)'
else
  say "the gateway does not answer: see tmux attach -t voice and the gateway's log ${LOG:-(none)}"
fi
exit 1
