# The worker container: Claude Code, git and gh, and nothing else from this
# computer. The repositories come from a host folder mounted at /repos, and
# the container runs as your own user id, so their files stay yours. The
# gateway runs workers in it with docker exec when VOICE_GW_DOCKER names the
# container. See the README, "Workers: on this computer or in Docker".
#
#   docker build -t cc-voice-worker \
#     --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" docker/

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gh procps \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# A user with your user and group id: files it writes in the mounted folder
# belong to you, and git in the container sees them as its own. The base
# image's node user would hold uid 1000, so it goes.
ARG UID=1000
ARG GID=1000
RUN userdel --remove node \
 && (getent group "${GID}" >/dev/null || groupadd --gid "${GID}" worker) \
 && useradd --uid "${UID}" --gid "${GID}" --create-home --home-dir /home/worker --shell /bin/bash worker \
 && mkdir -p /repos && chown "${UID}:${GID}" /repos

COPY voice-run voice-stop git-credential-voice /usr/local/bin/
RUN chmod 755 /usr/local/bin/voice-run /usr/local/bin/voice-stop /usr/local/bin/git-credential-voice \
 && git config --system credential.https://github.com.helper voice \
 && git config --system init.defaultBranch main

# Claude Code's login state and sessions and git's settings live in the home
# folder, best in a volume; the repositories in the mounted /repos.
USER worker
ENV HOME=/home/worker
WORKDIR /repos
CMD ["sleep", "infinity"]
