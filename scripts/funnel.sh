#!/usr/bin/env bash
# Publishes the local voice endpoint through Tailscale Funnel and prints the
# connector URL (the secret is part of the path, keep the URL private).
#
#   scripts/funnel.sh start    expose http://127.0.0.1:$VOICE_GW_PORT on https://<host>:$FUNNEL_PORT
#   scripts/funnel.sh stop     remove that funnel again
#   scripts/funnel.sh status   show Tailscale's serve/funnel config
#   scripts/funnel.sh url      print the connector URL only
#
# Funnel accepts only the HTTPS ports 443, 8443 and 10000. 8443 is the default
# here so an existing mapping on 443 stays untouched.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${VOICE_GW_PORT:-8787}"
FUNNEL_PORT="${FUNNEL_PORT:-8443}"

dns_name() {
  tailscale status --json | node -e '
    let s = ""
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const name = (JSON.parse(s).Self || {}).DNSName || ""
      process.stdout.write(name.replace(/\.$/, ""))
    })'
}

connector_url() {
  local host token suffix=""
  host="$(dns_name)"
  token="$(node "$ROOT/scripts/token.mjs" --quiet)"
  if [ -z "$host" ]; then
    echo "Tailscale-Hostname nicht gefunden. Ist 'tailscale up' gelaufen?" >&2
    exit 1
  fi
  [ "$FUNNEL_PORT" != "443" ] && suffix=":$FUNNEL_PORT"
  echo "https://${host}${suffix}/mcp/${token}"
}

case "${1:-start}" in
  start)
    tailscale funnel --bg --https="$FUNNEL_PORT" "http://127.0.0.1:${PORT}"
    echo
    echo "Connector-URL (geheim halten, enthält das Secret):"
    connector_url
    ;;
  stop)
    tailscale funnel --https="$FUNNEL_PORT" off
    ;;
  status)
    tailscale funnel status
    ;;
  url)
    connector_url
    ;;
  *)
    echo "usage: $0 start|stop|status|url" >&2
    exit 2
    ;;
esac
