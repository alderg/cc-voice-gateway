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
    echo "Tailscale host name not found. Has 'tailscale up' run?" >&2
    exit 1
  fi
  [ "$FUNNEL_PORT" != "443" ] && suffix=":$FUNNEL_PORT"
  echo "https://${host}${suffix}/mcp/${token}"
}

case "${1:-start}" in
  start)
    if ! out="$(tailscale funnel --bg --https="$FUNNEL_PORT" "http://127.0.0.1:${PORT}" 2>&1)"; then
      echo "$out" >&2
      if grep -q 'Access denied' <<<"$out"; then
        echo "Run 'sudo tailscale set --operator=\$USER' once, then this works without sudo." >&2
      fi
      exit 1
    fi
    echo "$out"
    # The first HTTPS request makes Tailscale fetch the certificate, which can
    # take a while; do it now instead of during the first connector call.
    host="$(dns_name)"
    if ! curl -fsS -o /dev/null --max-time 90 "https://${host}:${FUNNEL_PORT}/healthz"; then
      echo "Note: https://${host}:${FUNNEL_PORT}/healthz does not answer yet (certificate or controller?)." >&2
    fi
    echo
    echo "Connector URL (keep it private, it contains the secret):"
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
