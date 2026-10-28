# The worker container: clones of the driver's repositories and Claude Code,
# nothing else from this computer. The gateway runs workers in it with
# docker exec when VOICE_GW_DOCKER names the container. See the README,
# "Workers in Docker".
#
#   docker build -t cc-voice-worker docker/

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gh procps \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

COPY voice-run voice-stop git-credential-voice /usr/local/bin/
RUN chmod 755 /usr/local/bin/voice-run /usr/local/bin/voice-stop /usr/local/bin/git-credential-voice \
 && git config --system credential.https://github.com.helper voice \
 && git config --system init.defaultBranch main \
 && mkdir -p /repos && chown node:node /repos

# The image's own user; its home (Claude Code's login state and sessions, git
# settings) and /repos belong in volumes.
USER node
WORKDIR /repos
CMD ["sleep", "infinity"]
