#!/usr/bin/env bash
# Starts the worker container (README, "Workers in Docker"), replacing one that
# exists; its state lives in the folder and the voice-home volume. The
# repositories folder is mounted read-write, or read-only while the kill switch
# is locked (.secrets/killswitch.json); then also without a restart policy, so
# that it does not come back by itself. The gateway stops a container with a
# writable /repos while it is locked, however it was started.
#
# Settings, from the environment or .secrets/gateway.env (scripts/settings.sh):
#   VOICE_GW_DOCKER         the container (voice-workers)
#   VOICE_GW_DOCKER_FOLDER  the host folder with the repositories (~/docker-developer)
#   VOICE_GW_DOCKER_IMAGE   the image (cc-voice-worker)
#   VOICE_GW_DOCKER_BIN     the Docker CLI (docker)

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
. "$ROOT/scripts/settings.sh"
container=${VOICE_GW_DOCKER:-voice-workers}
folder=${VOICE_GW_DOCKER_FOLDER:-$HOME/docker-developer}
image=${VOICE_GW_DOCKER_IMAGE:-cc-voice-worker}
docker=${VOICE_GW_DOCKER_BIN:-docker}
secrets=${VOICE_GW_SECRETS_DIR:-$ROOT/.secrets}

[ -d "$folder" ] || { echo "start-workers-container: no folder $folder" >&2; exit 1; }
mode=rw
restart=unless-stopped
if [ -e "$secrets/killswitch.json" ]; then
  mode=ro
  restart=no
  echo "start-workers-container: the kill switch is locked; $folder is mounted read-only" >&2
fi

"$docker" rm -f "$container" >/dev/null 2>&1 || true
"$docker" run -d --name "$container" --init --restart "$restart" \
  --user "$(id -u):$(id -g)" \
  -v "$folder:/repos:$mode" -v voice-home:/home/worker \
  -v "$secrets/worker:/run/secrets/voice:ro" \
  "$image"
