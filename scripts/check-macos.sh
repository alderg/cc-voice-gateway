#!/bin/bash
# Checks on a Mac what needs no one at the keyboard, one line per check:
# PASS, WARN (optional, or not running yet) or FAIL, and exits 1 after any
# FAIL. Step 1 of the install and test guide, docs/macos.md. It starts, stops
# and changes nothing; the test suite writes only to temporary folders.
#
#   scripts/check-macos.sh                  all checks, with the test suite (about two minutes)
#   scripts/check-macos.sh --quick          without the test suite
#   scripts/check-macos.sh --before-setup   as before the setup, whatever is there
#   scripts/check-macos.sh --after-setup    as after the setup, whatever is there
#
# Before the setup (node scripts/setup.mjs) there is no .secrets/gateway.env
# yet. Then an INFO line says so, and what only the setup brings is INFO, not
# WARN: the settings file, the LaunchAgent, the gateway answering. After the
# setup they are WARN when missing. --before-setup and --after-setup decide
# instead of the file; --quick goes with either.
#
# The test suite, in a terminal: one line, written over after each test, with
# how far it is and how many passed, failed and were skipped, then the failed
# tests by name (scripts/test-progress.mjs). Into a file or a pipe: a dot per
# test, X for a failure. On a failure, its FAIL line names the log.
#
# On purpose /bin/bash: on macOS that is bash 3.2, which every script here has
# to run with. It runs on Linux as well, without the macOS checks.

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT" || exit 1
quick=0
setup= # before or after; empty: before if there is no .secrets/gateway.env
for arg; do
  case $arg in
    --quick) quick=1 ;;
    --before-setup) setup=before ;;
    --after-setup) setup=after ;;
    *)
      echo "usage: scripts/check-macos.sh [--quick] [--before-setup | --after-setup]" >&2
      exit 2
      ;;
  esac
done
failed=0

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  failed=$((failed + 1))
}
info() { printf 'INFO  %s\n' "$*"; }
first() { printf '%s\n' "$1" | head -n 1; }

system=$(uname -s)
mac=0
if [ "$system" = Darwin ]; then
  mac=1
  info "macOS $(sw_vers -productVersion 2>/dev/null) on $(uname -m), /bin/bash $(/bin/bash -c 'echo $BASH_VERSION')"
  # Where the setup assistant and the LaunchAgent look too (src/platform.mjs).
  PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin"
else
  warn "not macOS but $system: the macOS checks are left out"
fi
secrets=${VOICE_GW_SECRETS_DIR:-$ROOT/.secrets}
brings='the settings, the LaunchAgent and the gateway are INFO, not WARN'
if [ "$setup" = before ]; then
  info "before the setup, as --before-setup says: $brings"
elif [ -z "$setup" ] && [ ! -e "$secrets/gateway.env" ]; then
  setup=before
  info "before the setup: no $secrets/gateway.env yet, so $brings"
fi

# Version $2 at least $1, both as 1.2.3.
at_least() {
  node -e 'const [a, b] = process.argv.slice(1).map(v => v.split(".").map(Number))
    for (let i = 0; i < 3; i++) if ((b[i] || 0) !== (a[i] || 0)) process.exit((b[i] || 0) > (a[i] || 0) ? 0 : 1)' "$1" "$2"
}
version() { printf '%s\n' "$1" | sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\).*/\1/p' | head -n 1; }

# --- the scripts under this bash --------------------------------------------

for file in scripts/*.sh; do
  if out=$(/bin/bash -n "$file" 2>&1); then pass "bash -n $file"; else fail "bash -n $file: $(first "$out")"; fi
done
# Sourced and run, not only parsed: bash 4 builtins fail only when they run.
if out=$(/bin/bash -c 'set -euo pipefail; ROOT=$1; . "$ROOT/scripts/settings.sh"; echo "${#settings_outside[@]}"' check "$ROOT" 2>&1); then
  pass "scripts/settings.sh runs with /bin/bash"
else
  fail "scripts/settings.sh with /bin/bash: $(first "$out")"
fi
. "$ROOT/scripts/settings.sh"

# --- the tools ----------------------------------------------------------------

if v=$(node --version 2>/dev/null) && at_least 20.0.0 "${v#v}"; then pass "Node.js $v"; else fail "Node.js 20 or later: brew install node"; fi
if node --input-type=module -e 'import "@modelcontextprotocol/sdk/server/index.js"; import "zod"' >/dev/null 2>&1; then
  pass "npm install done"
else
  fail "the dependencies are missing: npm install"
fi
if v=$(version "$(git --version 2>/dev/null)") && [ -n "$v" ] && at_least 2.29.0 "$v"; then pass "git $v"; else fail "git 2.29 or later: brew install git"; fi
if v=$(version "$(claude --version 2>/dev/null)") && [ -n "$v" ] && at_least 2.1.80 "$v"; then
  pass "Claude Code $v ($(command -v claude))"
else
  fail "Claude Code 2.1.80 or later: brew install --cask claude-code, or curl -fsSL https://claude.ai/install.sh | bash"
fi
if ! command -v gh >/dev/null 2>&1; then
  fail "GitHub CLI: brew install gh"
elif gh auth status >/dev/null 2>&1; then
  pass "GitHub CLI $(version "$(gh --version)"), logged in"
else
  fail "GitHub CLI not logged in: gh auth login"
fi
if v=$(tmux -V 2>/dev/null); then pass "$v ($(command -v tmux))"; else fail "tmux: brew install tmux"; fi
if [ "$mac" = 1 ]; then
  if command -v caffeinate >/dev/null 2>&1; then pass "caffeinate"; else fail "caffeinate is missing"; fi
  if [ -x /usr/libexec/PlistBuddy ] && command -v plutil >/dev/null 2>&1 && command -v launchctl >/dev/null 2>&1; then
    pass "launchctl, plutil, PlistBuddy"
  else
    fail "launchctl, plutil or PlistBuddy is missing"
  fi
fi
if [ -n "${VOICE_GW_DOCKER:-}" ]; then
  if v=$(docker version --format '{{.Server.Version}}' 2>/dev/null); then pass "Docker $v"; else fail "Docker does not answer: start Docker Desktop"; fi
  case $(docker inspect -f '{{.State.Running}}' "$VOICE_GW_DOCKER" 2>/dev/null) in
    true) pass "the worker container $VOICE_GW_DOCKER runs" ;;
    false) fail "the worker container $VOICE_GW_DOCKER is stopped: scripts/start-workers-container.sh" ;;
    *) fail "no worker container $VOICE_GW_DOCKER: run the setup's Docker step, or scripts/start-workers-container.sh" ;;
  esac
  folder=${VOICE_GW_DOCKER_FOLDER:-$HOME/docker-developer}
  case $folder in
    /Users/* | /Volumes/* | /private/* | /tmp/*) [ "$mac" = 0 ] || pass "$folder is in a folder Docker Desktop shares by default" ;;
    *) [ "$mac" = 0 ] || warn "$folder: add it in Docker Desktop, Settings, Resources, File sharing" ;;
  esac
elif command -v docker >/dev/null 2>&1; then
  info "Docker installed, workers on this computer (VOICE_GW_DOCKER not set)"
else
  info "no Docker: workers run on this computer"
fi
if out=$(scripts/funnel.sh state 2>/dev/null); then
  info "Tailscale Funnel: $out"
else
  warn "Tailscale not found or not logged in: only needed for the Funnel (brew install --cask tailscale-app, then log in)"
fi

# --- settings and files -------------------------------------------------------

if [ -r "$secrets/gateway.env" ]; then
  pass "settings: $secrets/gateway.env"
elif [ "$setup" = before ]; then
  info "no settings yet: the setup writes $secrets/gateway.env"
else
  warn "no $secrets/gateway.env yet: node scripts/setup.mjs"
fi
socket=$secrets/admin.sock
if [ ${#socket} -le 103 ]; then
  pass "the admin socket's path has ${#socket} characters (at most 103 on macOS)"
else
  fail "the admin socket's path is ${#socket} characters long, more than macOS allows (103): move the checkout, or set VOICE_GW_SECRETS_DIR"
fi
if [ -e "$secrets/telegram_token" ] && [ -e "$secrets/telegram_chat_id" ]; then info "Telegram set up"; else info "Telegram not set up"; fi
info "channel: $(node scripts/channel-mode.mjs 2>&1)"
if [ -e "$secrets/killswitch.json" ]; then warn "the kill switch is locked: node scripts/unlock.mjs --status"; else pass "the kill switch is not locked"; fi

# --- the autostart ----------------------------------------------------------------

agent=com.drawio.cc-voice-gateway
plist=$HOME/Library/LaunchAgents/$agent.plist
if [ "$mac" = 1 ] && [ -e "$plist" ]; then
  if out=$(plutil -lint "$plist" 2>&1); then pass "LaunchAgent: $out"; else fail "LaunchAgent invalid: $out"; fi
  value() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null; }
  starter=$(value ProgramArguments:0)
  if [ -x "$starter" ]; then pass "the LaunchAgent starts $starter"; else fail "the LaunchAgent's $starter is not there: run the setup again"; fi
  script=$(value ProgramArguments:5)
  if [ "$script" = "$ROOT/scripts/start-controller.sh" ]; then pass "the LaunchAgent starts this checkout"; else warn "the LaunchAgent starts $script, not this checkout"; fi
  [ "$(value KeepAlive)" = false ] && [ "$(value RunAtLoad)" = true ] && pass "RunAtLoad without KeepAlive" || fail "RunAtLoad and KeepAlive are not as the setup writes them"
  agent_path=$(value EnvironmentVariables:PATH)
  for command in node claude git gh tmux; do
    if (PATH=$agent_path command -v "$command" >/dev/null 2>&1); then
      pass "the LaunchAgent's PATH finds $command"
    else
      fail "the LaunchAgent's PATH does not find $command: run the setup again from a Terminal that finds it"
    fi
  done
  if launchctl print "gui/$(id -u)/$agent" >/dev/null 2>&1; then
    pass "the LaunchAgent is loaded (launchctl print gui/$(id -u)/$agent)"
  else
    warn "the LaunchAgent is not loaded yet: launchctl bootstrap gui/$(id -u) $plist, or log in again"
  fi
elif [ "$mac" = 1 ] && [ "$setup" = before ]; then
  info "no LaunchAgent yet: the setup writes it when its autostart is chosen ($plist)"
elif [ "$mac" = 1 ]; then
  warn "no LaunchAgent: the setup's autostart was not chosen ($plist)"
fi

# --- what runs -----------------------------------------------------------------------

status=$(scripts/start-controller.sh --status 2>&1)
info "$status"
port=${VOICE_GW_PORT:-8787}
if curl -fsS -m 5 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
  pass "the gateway answers on 127.0.0.1:$port"
  if [ "$mac" = 1 ]; then
    if pmset -g assertions 2>/dev/null | grep -q caffeinate; then pass "caffeinate keeps the Mac awake"; else warn "no caffeinate assertion (VOICE_GW_CAFFEINATE=0, or started without the watchdog)"; fi
  fi
  if tmux has-session -t voice 2>/dev/null; then pass "the tmux session voice runs"; else warn "no tmux session voice: the controller runs outside tmux"; fi
elif [ "$setup" = before ]; then
  info "the gateway does not answer on 127.0.0.1:$port: it runs once the setup has started the controller"
else
  warn "the gateway does not answer on 127.0.0.1:$port: the controller is not running, or waits at the terminal (tmux attach -t voice)"
fi

# --- the test suite -------------------------------------------------------------------

if [ "$quick" = 0 ] && ! at_least 20.0.0 "$(node --version 2>/dev/null | sed 's/^v//')"; then
  fail "npm test: the test suite needs Node.js 20 or later"
elif [ "$quick" = 0 ]; then
  results=${TMPDIR:-/tmp}
  results=${results%/}/cc-voice-gateway-tests.log
  # In a terminal one line, written over after each test (the reporter counts
  # the tests itself); otherwise, as into a file, a dot per test.
  if [ -t 1 ]; then
    reporter=./scripts/test-progress.mjs
    info "the test suite runs now, as npm test, about two minutes:"
  else
    reporter=dot
    tests=$(cat test/*.test.mjs | grep -c '^test(')
    info "the test suite runs now, as npm test: about $(((tests + 5) / 10 * 10)) tests, about two minutes; a dot per test, X for a failure"
  fi
  # Without this session's settings, as a clean terminal would run it: the
  # preload of npm test clears them (test/env.cjs). The files of npm test,
  # with node itself: options given to npm test land after the files, where
  # node does not take them, and NODE_OPTIONS would reach the gateways the
  # tests start. TAP into the file, for the counts below (Node 23 and later
  # write their default reporter, spec, into a file too), and the line or the
  # dots to the terminal.
  node --require ./test/env.cjs --test --test-reporter=tap --test-reporter-destination="$results" \
    --test-reporter="$reporter" --test-reporter-destination=stdout test/*.test.mjs
  passed=$(sed -n 's/^# pass //p' "$results" | tail -n 1)
  failing=$(sed -n 's/^# fail //p' "$results" | tail -n 1)
  if [ "${failing:-x}" = 0 ] && [ -n "$passed" ]; then
    pass "npm test: $passed passed"
  else
    fail "npm test: ${failing:-?} failed of $((${passed:-0} + ${failing:-0})); see $results (grep -A30 '^not ok')"
  fi
fi

echo
if [ "$failed" = 0 ]; then echo "All checks passed."; else echo "$failed check(s) failed."; fi
[ "$failed" = 0 ]
