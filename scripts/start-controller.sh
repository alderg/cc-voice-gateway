#!/usr/bin/env bash
# Starts the controller session with the voice gateway loaded as a development
# channel. Claude Code spawns src/gateway.mjs itself (see controller/.mcp.json),
# which also opens the HTTP endpoint on 127.0.0.1:${VOICE_GW_PORT:-8787}.
#
# On the first start Claude Code shows two dialogs that must be answered at the
# terminal: the development-channel warning and the consent for the new MCP
# server from .mcp.json.
#
# The session runs in manual mode, whatever defaultMode the user settings set.
# controller/.claude/settings.json lets Bash, Write and Edit run without asking,
# because its confine hook limits them, and denies tools that reach beyond this
# folder. Anything else that needs an approval is relayed to the car. (Do not
# drop the user settings with --setting-sources: then Claude Code reports
# channels as not enabled for the organisation.)
#
# For an always-on setup run it inside tmux:
#   tmux new -s voice scripts/start-controller.sh

set -euo pipefail
cd "$(dirname "$0")/../controller"
exec claude \
  --permission-mode manual \
  --dangerously-load-development-channels server:voice \
  "$@"
