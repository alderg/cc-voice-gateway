#!/usr/bin/env bash
# Starts the controller session with the voice gateway as its channel. Claude
# Code spawns the gateway itself, which also opens the HTTP endpoint on
# 127.0.0.1:${VOICE_GW_PORT:-8787}. Two ways, chosen before every start
# (scripts/channel-mode.mjs):
#
#   plugin       --channels plugin:voice@cc-voice-gateway, when the
#                organisation's channel allowlist names the plugin: no prompt.
#                This repository is the marketplace (.claude-plugin/); the
#                project's own voice server in .mcp.json stays off.
#   development  --dangerously-load-development-channels server:voice, from
#                controller/.mcp.json: Claude Code shows a warning at every
#                start that must be answered at the terminal. With
#                --strict-mcp-config --mcp-config controller/.mcp.json, so
#                that the gateway is the only MCP server. (Not for the plugin:
#                --strict-mcp-config also drops plugins' MCP servers, the
#                gateway's included. There the confine hook blocks every
#                other server's tools.)
#
# Both read the gateway's settings from controller/.mcp.json and from
# .secrets/gateway.env, which the setup assistant writes (scripts/setup.mjs).
# From the latter this script also takes the session's model and effort:
# VOICE_GW_CONTROLLER_MODEL and VOICE_GW_CONTROLLER_EFFORT.
#
# The session runs in manual mode, whatever defaultMode the user settings set.
# controller/.claude/settings.json lets Bash, Write and Edit run without asking,
# because its confine hook limits them, and denies tools that reach beyond this
# folder. The hook sees every tool call and blocks whatever is not on its list,
# also the tools of MCP servers and plugins from the user settings. Anything
# else that needs an approval is relayed to the car. (Do not drop the user
# settings with --setting-sources: then Claude Code reports channels as not
# enabled for the organisation.)
#
# VOICE_GW_CONTROLLER_LEVEL sets how far the session may go: confined (the
# default), clone-delete or unrestricted. The deny rules, or at unrestricted
# the allow rules, come with --settings, and above confined a word about the
# level with --append-system-prompt (scripts/controller-settings.mjs); the
# confine hook reads the level too. A new level counts from the next start of
# this script: --stop, then start it again.
#
# A watchdog keeps the session running: when it crashes, or its gateway stops
# answering, it starts it again, with a growing pause in between and at most
# VOICE_GW_WATCHDOG_MAX_RESTARTS restarts within VOICE_GW_WATCHDOG_WINDOW
# seconds. Quitting the session (exit code 0, or Ctrl+C) or --stop ends it for
# good. One watchdog at a time. Restarts go to the gateway's log, and to
# Telegram if .secrets/telegram_token and .secrets/telegram_chat_id exist.
# With the development flag, a restart waits for the warning to be answered at
# the terminal; see the README, "The watchdog". The
# controller can also ask for a restart (restart_controller, src/restart.mjs):
# that one starts again at once and does not count as a crash. Before every
# start the watchdog reads .secrets/gateway.env again, so that a restart takes
# changed settings; only the level and the folders this script took at its own
# start stay until it starts again. The log says who started and stopped it,
# and which settings each start got from where.
#
#   scripts/start-controller.sh [claude options]   start, with the watchdog
#   scripts/start-controller.sh --stop             stop the watchdog and the session
#   scripts/start-controller.sh --status           is it running?
#   VOICE_GW_WATCHDOG=0 scripts/start-controller.sh   without the watchdog
#
# For an always-on setup run it inside tmux:
#   tmux new -s voice scripts/start-controller.sh

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
. "$ROOT/scripts/settings.sh"
CONTROLLER=$ROOT/controller
STATE=${VOICE_GW_STATE_DIR:-$ROOT/.state}
LOCK=$STATE/controller.lock # a directory, since mkdir is atomic: pid, claude.pid
STOP=$STATE/controller.stop
LOG=${VOICE_GW_LOG_FILE-$ROOT/.logs/gateway.log} # empty: stderr only, as for the gateway

MARKETPLACE=cc-voice-gateway
PLUGIN=voice

# --- settings ---------------------------------------------------------------

# awk and sleep with a decimal point, whatever the locale; the session itself
# keeps yours.
num() { LC_ALL=C "$@"; }

# Seconds (fractions allowed) as milliseconds; the default if not a number.
ms() {
  if [[ ${1:-} =~ ^[0-9]+(\.[0-9]+)?$ ]]; then num awk -v s="$1" 'BEGIN { printf "%d", s * 1000 }'; else echo "$2"; fi
}
count() { if [[ ${1:-} =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]; then echo "$1"; else echo "$2"; fi; }
interval_ms=$(ms "${VOICE_GW_WATCHDOG_INTERVAL:-}" 30000)      # how often the gateway is checked
health_fails=$(count "${VOICE_GW_WATCHDOG_HEALTH_FAILS:-}" 3)  # failed checks in a row before a restart
max_restarts=$(count "${VOICE_GW_WATCHDOG_MAX_RESTARTS:-}" 5)  # restarts within the window
window_s=$(count "${VOICE_GW_WATCHDOG_WINDOW:-}" 1800)
backoff_ms=$(ms "${VOICE_GW_WATCHDOG_BACKOFF:-}" 5000)         # first pause, doubled after each quick crash
backoff_max_ms=$(ms "${VOICE_GW_WATCHDOG_BACKOFF_MAX:-}" 300000)
stable_s=$(count "${VOICE_GW_WATCHDOG_STABLE:-}" 600)          # a run this long resets the pause

seconds() { num awk -v m="$1" 'BEGIN { s = m / 1000; if (s == int(s)) printf "%d", s; else printf "%g", s }'; }

# --- log and notify ---------------------------------------------------------

quiet=0 # while the session runs, the terminal belongs to it: log to the file only
log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog: $*"
  if [ -n "$LOG" ]; then
    (umask 077 && mkdir -p "$(dirname "$LOG")") && printf '%s\n' "$line" >>"$LOG" || true
  fi
  if [ "$quiet" = 0 ] || [ -z "$LOG" ]; then printf '%s\n' "$line" >&2; fi
}

# Who started or stopped this script, for the log: the autostart's service, or
# the user, process and terminal it came from. The service's own processes
# only: its ExecStart's tmux, or systemd for ExecStop; the session and workers
# below it inherit its INVOCATION_ID too.
invoker() {
  local unit=cc-voice-gateway.service parent tty
  if [ -n "${INVOCATION_ID:-}" ] &&
    [ "$(systemctl --user show -p InvocationID --value "$unit" 2>/dev/null)" = "$INVOCATION_ID" ] &&
    { [ "$(systemctl --user show -p MainPID --value "$unit" 2>/dev/null)" = "$PPID" ] ||
      [ "$(ps -o comm= -p "$PPID" 2>/dev/null)" = systemd ]; }; then
    echo "the service $unit"
    return
  fi
  parent=$(ps -o args= -p "$PPID" 2>/dev/null | cut -c1-80 || true)
  tty=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ' || true)
  [ "$tty" != '?' ] || tty=
  echo "$(id -un) from ${parent:-process $PPID}${tty:+ on $tty}"
}

# Each setting with where it came from; the environment wins over the file.
settings_line() {
  local name file=() outside=()
  for name in "${settings_from_file[@]+"${settings_from_file[@]}"}"; do file+=("$name=${!name-}"); done
  for name in "${settings_outside[@]+"${settings_outside[@]}"}"; do outside+=("$name=${!name-}"); done
  echo "settings from ${settings_path/#"$ROOT"\//}: ${file[*]:-none}; from the environment, which wins: ${outside[*]:-none}; gateway port $port"
}

# A Telegram message, if the Telegram secrets exist; never shows the token.
notify() {
  local result
  result=$(node "$ROOT/scripts/telegram-notify.mjs" "$1" 2>&1) || true
  [ "$result" = 'telegram: not set up' ] || log "$result"
}

# --- lock -------------------------------------------------------------------

running_pid() {
  local pid
  pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -q start-controller; then
    echo "$pid"
  fi
}

take_lock() {
  (umask 077 && mkdir -p "$STATE")
  if ! mkdir "$LOCK" 2>/dev/null; then
    local other
    other=$(running_pid)
    if [ -n "$other" ]; then
      echo "start-controller: the controller is already running (watchdog $other). Stop it with: $0 --stop" >&2
      exit 1
    fi
    rm -rf "${LOCK:?}" # left behind by a watchdog that was killed
    mkdir "$LOCK" || { echo "start-controller: cannot take the lock $LOCK" >&2; exit 1; }
  fi
  echo $$ >"$LOCK/pid"
  rm -f "$STOP"
}

release_lock() {
  if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = $$ ]; then rm -rf "${LOCK:?}"; fi
  rm -f "$STOP"
}

# --- --stop and --status ----------------------------------------------------

if [ "${1:-}" = --status ] || [ "${1:-}" = --stop ]; then
  pid=$(running_pid)
  if [ -z "$pid" ]; then
    echo "start-controller: not running"
    exit 0
  fi
  session=$(cat "$LOCK/claude.pid" 2>/dev/null || true)
  if [ "$1" = --status ]; then
    echo "start-controller: running (watchdog $pid, session ${session:-starting})"
    exit 0
  fi
  by=$(invoker)
  log "stop requested by $by"
  echo "$by" >"$STOP"
  [ -n "$session" ] && kill -TERM "$session" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true # in case it is pausing between two runs
  for _ in $(seq 1 100); do
    [ -n "$(running_pid)" ] || { echo "start-controller: stopped"; exit 0; }
    num sleep 0.2
  done
  echo "start-controller: still running after 20 seconds (watchdog $pid)" >&2
  exit 1
fi

cd "$CONTROLLER"

# --- the channel ----------------------------------------------------------

# Sets claude_args and channel_mode for the next start, and says why.
choose_channel() {
  local line
  line=$(node "$ROOT/scripts/channel-mode.mjs" 2>/dev/null || echo 'development the channel check failed')
  channel_mode=${line%% *}
  if [ "$channel_mode" = plugin-register ]; then
    if claude plugin marketplace add "$ROOT" >/dev/null 2>&1; then
      log "channel: registered this repository as the marketplace $MARKETPLACE"
      channel_mode=plugin
    else
      line="development registering the marketplace failed (claude plugin marketplace add $ROOT)"
      channel_mode=development
    fi
  fi
  if [ "$channel_mode" = plugin ]; then
    claude_args=(--permission-mode manual --channels "plugin:$PLUGIN@$MARKETPLACE")
    log "channel: the plugin $PLUGIN@$MARKETPLACE, on the organisation's channel allowlist; no confirmation at the start"
  else
    channel_mode=development
    claude_args=(--permission-mode manual --strict-mcp-config --mcp-config "$CONTROLLER/.mcp.json"
      --dangerously-load-development-channels server:voice)
    log "channel: the development flag, since ${line#development }; the warning at the start needs Enter at the terminal"
  fi
  # What the session may do: its level and the settings for it, with the
  # plugin's (scripts/controller-settings.mjs).
  local out level prompt
  if ! out=$(node "$ROOT/scripts/controller-settings.mjs" "$channel_mode") || [ -z "$out" ]; then
    log "the controller's settings could not be built (scripts/controller-settings.mjs): not starting"
    exit 1
  fi
  level=$(sed -n 1p <<<"$out")
  prompt=$(sed -n 3p <<<"$out")
  claude_args+=(--settings "$(sed -n 2p <<<"$out")")
  if [ -n "$prompt" ]; then claude_args+=(--append-system-prompt "$prompt"); fi
  # The session's hook and gateway go by the same level, until the next start.
  export VOICE_GW_CONTROLLER_LEVEL=$level
  case $level in
    clone-delete)
      log "controller level clone-delete: by voice, the controller clones repositories into the repositories folder and deletes files and folders there, each deletion after an approval by voice" ;;
    unrestricted)
      log "controller level unrestricted: the confinement is off. By voice, the controller can run any command as $(id -un), read and change any file, .secrets/ included, and use the web" ;;
  esac
  # The session's model and effort from the settings; options given to this
  # script come later and win.
  if [ -n "${VOICE_GW_CONTROLLER_MODEL:-}" ]; then claude_args+=(--model "$VOICE_GW_CONTROLLER_MODEL"); fi
  if [ -n "${VOICE_GW_CONTROLLER_EFFORT:-}" ]; then claude_args+=(--effort "$VOICE_GW_CONTROLLER_EFFORT"); fi
  export VOICE_GW_CHANNEL_MODE=$channel_mode # for the gateway (restart.mjs)
}

if [ "${VOICE_GW_WATCHDOG:-1}" = 0 ]; then
  choose_channel
  exec claude "${claude_args[@]}" "$@"
fi

# --- the gateway's health ---------------------------------------------------

# Before every start: the settings may have changed it.
gateway_port() {
  port=${VOICE_GW_PORT:-$(node -e '
    try {
      const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      process.stdout.write(String(config.mcpServers?.voice?.env?.VOICE_GW_PORT ?? 8787))
    } catch { process.stdout.write("8787") }' "$CONTROLLER/.mcp.json")}
}

healthy() {
  node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
    "http://127.0.0.1:$port/healthz" </dev/null >/dev/null 2>&1
}

# Runs next to the session: once the gateway has answered, enough failed
# checks in a row end the session, which the watchdog then restarts. Before
# that, for example while the development-channel warning waits, it only waits.
monitor() {
  # Not the watchdog's traps: its kill must end this loop, and its exit must
  # not release the lock.
  trap - INT TERM HUP EXIT
  local fails=0 seen=0 pid
  # Without the terminal: a sleep left over when the session ends must not
  # keep the watchdog's output open.
  while num sleep "$(seconds "$interval_ms")" </dev/null >/dev/null 2>&1; do
    pid=$(cat "$LOCK/claude.pid" 2>/dev/null || true)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || exit 0
    if healthy; then
      seen=1
      fails=0
      continue
    fi
    [ "$seen" = 1 ] || continue
    fails=$((fails + 1))
    if [ "$fails" -ge "$health_fails" ]; then
      log "the gateway has not answered on port $port for $fails checks: ending the session so that it starts again"
      touch "$LOCK/unhealthy"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 10
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
      exit 0
    fi
  done
}

# --- the watchdog -----------------------------------------------------------

take_lock
monitor_pid=
stopping=0
trap 'stopping=1' INT TERM HUP
trap '[ -n "$monitor_pid" ] && kill "$monitor_pid" 2>/dev/null; release_lock' EXIT

restarts=() # times of the restarts within the window
pause_ms=$backoff_ms
next="starting the controller session (watchdog $$, started by $(invoker))"
host=$(hostname 2>/dev/null || echo 'this computer')
export VOICE_GW_WATCHDOG_LOCK=$LOCK # for the gateway: restart requests, readiness

while :; do
  rm -f "$LOCK/unhealthy" "$LOCK/claude.pid" "$LOCK/restart"
  log "$next"
  # The settings file again (scripts/settings.sh), so that a restart takes
  # what changed meanwhile. The level stays until this script starts again
  # (see the top), and so do the folders it took at its start.
  reload_settings VOICE_GW_CONTROLLER_LEVEL VOICE_GW_SECRETS_DIR VOICE_GW_STATE_DIR VOICE_GW_LOG_FILE
  gateway_port
  log "$(settings_line)"
  choose_channel
  started=$(date +%s)
  quiet=1
  monitor &
  monitor_pid=$!
  status=0
  # In the foreground, so that the session owns the terminal; the small shell
  # notes its process id and then becomes claude.
  sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$LOCK/claude.pid" claude "${claude_args[@]}" "$@" || status=$?
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  monitor_pid=
  quiet=0
  lasted=$(($(date +%s) - started))

  if [ "$stopping" = 1 ] || [ -e "$STOP" ]; then
    by=$(cat "$STOP" 2>/dev/null || true)
    log "the controller session was stopped${by:+ by $by} (exit code $status): not restarting"
    exit 0
  fi
  if [ -e "$LOCK/restart" ]; then
    by=$(sed -n 's/.*"by":"\([^"]*\)".*/\1/p' "$LOCK/restart")
    log "the controller session ended for a restart requested by ${by:-the controller} (exit code $status): starting it again at once, not counted as a crash"
    printf 'a restart requested by %s\n' "${by:-the controller}" >"$LOCK/restarted"
    next="starting the controller session again (requested restart)"
    continue
  fi
  if [ -e "$LOCK/unhealthy" ]; then
    reason="its gateway stopped answering"
  elif [ "$status" = 0 ]; then
    log "the controller session ended normally (exit code 0): not restarting"
    exit 0
  elif [ "$status" = 130 ]; then
    log "the controller session ended with Ctrl+C (exit code 130): not restarting"
    exit 0
  elif [ "$status" -gt 128 ]; then
    reason="killed by signal $(kill -l $((status - 128)) 2>/dev/null || echo $((status - 128))) (exit code $status)"
  else
    reason="exit code $status"
  fi

  now=$(date +%s)
  recent=()
  for t in "${restarts[@]+"${restarts[@]}"}"; do
    if [ $((now - t)) -lt "$window_s" ]; then recent+=("$t"); fi
  done
  restarts=("${recent[@]+"${recent[@]}"}")
  if [ "${#restarts[@]}" -ge "$max_restarts" ]; then
    log "giving up: the controller session ended unexpectedly ($reason) after $max_restarts restarts within $window_s seconds. Start it again with scripts/start-controller.sh"
    notify "cc-voice-gateway on $host: the controller session crashed again ($reason). The watchdog gave up after $max_restarts restarts within $((window_s / 60)) minutes. Start it again at the computer."
    exit 1
  fi
  if [ "$lasted" -ge "$stable_s" ]; then pause_ms=$backoff_ms; fi
  restarts+=("$now")
  log "the controller session ended unexpectedly ($reason) after ${lasted} s: restart ${#restarts[@]} of at most $max_restarts within $window_s s, in $(seconds "$pause_ms") s"
  printf 'a crash (%s)\n' "$reason" >"$LOCK/restarted"
  next="starting the controller session again (restart ${#restarts[@]})"
  if [ "$channel_mode" = plugin ]; then
    notify "cc-voice-gateway on $host: the controller session crashed ($reason) and starts again in $(seconds "$pause_ms") s, without a confirmation. A message follows when it is ready."
  else
    notify "cc-voice-gateway on $host: the controller session crashed ($reason) and starts again in $(seconds "$pause_ms") s. Confirm the development channel at the terminal (tmux attach -t voice), otherwise voice requests do not arrive."
  fi
  num sleep "$(seconds "$pause_ms")" &
  wait $! || true
  if [ "$stopping" = 1 ] || [ -e "$STOP" ]; then
    by=$(cat "$STOP" 2>/dev/null || true)
    log "stopped${by:+ by $by} while waiting to restart"
    exit 0
  fi
  pause_ms=$((pause_ms * 2))
  if [ "$pause_ms" -gt "$backoff_max_ms" ]; then pause_ms=$backoff_max_ms; fi
done
