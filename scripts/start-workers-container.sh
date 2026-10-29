#!/usr/bin/env bash
# Starts the worker container (README, "Workers: on this computer or in
# Docker"), replacing one that exists; its state lives in the folder and the
# voice-home volume. The repositories folder is mounted read-write, or
# read-only while the kill switch is locked (.secrets/killswitch.json); then
# also without a restart policy, so that it does not come back by itself. The
# gateway stops a container with a writable /repos while it is locked, however
# it was started.
#
# With --scratch, the container for the work folders instead (README, "Work
# folders"), from the same image: it sees only the work folders, at /scratch,
# with a home volume of its own (voice-scratch-home), and of the secrets only
# Claude Code's token: no GitHub token, no repositories. Read-only and
# without a restart policy while locked, as above.
#
# Settings, from the environment or .secrets/gateway.env (scripts/settings.sh):
#   VOICE_GW_DOCKER          the container (voice-workers)
#   VOICE_GW_DOCKER_FOLDER   the host folder with the repositories (~/docker-developer)
#   VOICE_GW_SCRATCH_DOCKER  with --scratch: the container (voice-scratch)
#   VOICE_GW_SCRATCH_ROOT    with --scratch: the host folder of the work folders (~/voice-scratch)
#   VOICE_GW_DOCKER_IMAGE    the image (cc-voice-worker)
#   VOICE_GW_DOCKER_BIN      the Docker CLI (docker)

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
. "$ROOT/scripts/settings.sh"
image=${VOICE_GW_DOCKER_IMAGE:-cc-voice-worker}
docker=${VOICE_GW_DOCKER_BIN:-docker}
secrets=${VOICE_GW_SECRETS_DIR:-$ROOT/.secrets}

if [ "${1:-}" = --scratch ]; then
  container=${VOICE_GW_SCRATCH_DOCKER:-voice-scratch}
  folder=${VOICE_GW_SCRATCH_ROOT:-$HOME/voice-scratch}
  if [ "$container" = "${VOICE_GW_DOCKER:-}" ]; then
    echo "start-workers-container: $container is the worker container; the work folders need a container of their own" >&2
    exit 1
  fi
  [ -s "$secrets/worker/claude_token" ] || { echo "start-workers-container: no Claude Code token in $secrets/worker/claude_token (claude setup-token)" >&2; exit 1; }
  mkdir -p "$folder"
  chmod 700 "$folder"
  target=/scratch
  home=voice-scratch-home
  # Only this one file: the GitHub token next to it stays outside. A file
  # mounted on its own keeps its content until the container starts again.
  secret_mount="$secrets/worker/claude_token:/run/secrets/voice/claude_token:ro"
else
  container=${VOICE_GW_DOCKER:-voice-workers}
  folder=${VOICE_GW_DOCKER_FOLDER:-$HOME/docker-developer}
  [ -d "$folder" ] || { echo "start-workers-container: no folder $folder" >&2; exit 1; }
  target=/repos
  home=voice-home
  secret_mount="$secrets/worker:/run/secrets/voice:ro"
fi

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
  -v "$folder:$target:$mode" -v "$home:/home/worker" \
  -v "$secret_mount" \
  "$image"
