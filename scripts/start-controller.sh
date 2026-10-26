#!/usr/bin/env bash
# Starts the controller session with the voice gateway loaded as a development
# channel. Claude Code spawns src/gateway.mjs itself (see controller/.mcp.json),
# which also opens the HTTP endpoint on 127.0.0.1:${VOICE_GW_PORT:-8787}.
#
# On the first start Claude Code shows two dialogs that must be answered at the
# terminal: the development-channel warning and the consent for the new MCP
# server from .mcp.json.
#
# The session runs in manual mode, whatever defaultMode the user settings set,
# and controller/.claude/settings.json has ask rules for Bash, Write and Edit,
# which win over allow rules such as Bash(*) in ~/.claude/settings.json.
# Otherwise every tool call could be approved silently: nothing would be
# relayed to the car, and whoever knows the connector URL could run commands
# unasked. (Do not drop the user settings with --setting-sources instead: then
# Claude Code reports channels as not enabled for the organisation.)
#
# For an always-on setup run it inside tmux:
#   tmux new -s voice scripts/start-controller.sh

set -euo pipefail
cd "$(dirname "$0")/../controller"
exec claude \
  --permission-mode manual \
  --dangerously-load-development-channels server:voice \
  "$@"
