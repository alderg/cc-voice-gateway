# cc-voice-gateway

Talk to Claude in the Claude app's voice mode, on the phone or in the car, and have a Claude Code
session on your own computer do the work: answer questions about your repositories, change code,
push branches, open and merge pull requests. Plain JavaScript (ESM, Node.js), no build step.

This README is the technical documentation. The idea in a short video is on the
[product page](https://alderg.github.io/cc-voice-gateway/).

[![Video: cc-voice-gateway, Claude Code from Claude's voice mode](docs/assets/video-thumbnail.png)](https://alderg.github.io/cc-voice-gateway/#video)

> **Provided as-is, as a prototype.** This is solely a prototype of an idea: a way to use Claude
> Code from Claude's voice mode, which cannot reach Claude Code on its own. It comes without
> warranty and without support, and there is no communication of any kind about this project: no
> announcements, no support, no answers to issues or messages. It is not an Anthropic product.
>
> Used with Claude voice mode in the Claude app on the iPhone. Claude Code channels are a research
> preview; their flags and protocol may change.

## Contents

1. [Overview](#1-overview)
2. [Motivation](#2-motivation)
3. [Comparison with existing solutions](#3-comparison-with-existing-solutions)
4. [Diagrams](#4-diagrams)
5. [Security design](#5-security-design)
6. [Prerequisites](#6-prerequisites)
7. [Installation](#7-installation)
8. [Operation](#8-operation)
9. [Repository layout](#9-repository-layout)
10. [Sources](#10-sources)

## 1. Overview

cc-voice-gateway connects two things that do not talk to each other: Claude's voice mode in the
Claude app, and Claude Code on your computer. It is one Node.js process with two sides:

- **Towards the Claude app:** an MCP server over HTTPS. You add it in the Claude app as a custom
  connector. Claude's servers call its tools (`send`, `ask`, `get_reply`, `status`, `approve`,
  `emergency_stop`) during a voice conversation, after an OAuth sign-in with a pairing code from
  your computer.
- **Towards Claude Code:** a [channel][channels], an MCP server that pushes each voice request into
  a running Claude Code session, the **controller**. The controller answers through the channel's
  `reply` tool. It may read its own folder and the status of pull requests; it does no repository
  work itself.

Work in a repository goes to a **worker**: a headless `claude -p` run in that repository, started
by the gateway when the controller calls `dispatch`. One worker per repository, two at a time by
default. Workers run in your checkouts, or in a Docker container whose GitHub token sets what they
may publish: nothing, draft pull requests, or also a direct push to the default branch. A worker's
result reaches the controller as a channel event; the controller summarises it, and you hear it
as news in the voice conversation, or by Telegram once the conversation has ended.

| Part | Code | Runs where | Role |
|---|---|---|---|
| Gateway | `src/gateway.mjs` and the rest of `src/` | Started by Claude Code, inside the controller session | State, relay, OAuth, workers, kill switch. No AI |
| Controller | Claude Code in `controller/` | Your computer, in tmux, under a watchdog | Understands, answers, dispatches, asks back |
| Workers | `claude -p` | Your checkouts, or a Docker container | The work in the repositories |
| Voice AI | Claude app, voice mode | Anthropic's cloud | The conversation with you |
| Tunnel | Tailscale Funnel or a reverse proxy | Your computer or a server | Public HTTPS address for Claude's servers |
| Setup assistant | `scripts/setup.mjs` | Your computer, only while setting up | Writes the settings and secrets into `.secrets/` |

![Architecture](docs/architecture.drawio.svg)

## 2. Motivation

The goal: drive, talk to Claude, and have real work done in your repositories, with results and
questions coming back by voice, without touching a screen.

Claude does not offer this by itself. In the Claude app, voice mode is not available for Claude
Code; there it only has dictation ([voice mode][voice]). Claude Code Remote Control reaches a local
session from the app, but in text ([Remote Control][rc]). Voice mode can use connected tools
([voice mode][voice]); the help article does not name custom MCP connectors
([connectors][connectors]), but in our use voice mode calls them. So the bridge is a connector that
Claude's voice mode calls, and that hands each request to Claude Code.

What this project tries, and why:

| Decision | Reason |
|---|---|
| Use Claude's own voice mode as the front end | No speech recognition or speech output of its own. Claude understands the request in any language, keeps the conversation's context and reads the answer out |
| Long polling with short calls (`send`, then `get_reply` for at most 40 s) | MCP clients often abort a tool call after 60 s ([talk-to-claude-code][t2cc]). Work takes minutes |
| A running Claude Code session (the controller) as the receiver, through a channel | It keeps context across requests, asks back and summarises. A fresh `claude -p` per request would forget everything |
| Workers as separate headless runs | The controller stays responsive and confined; several repositories can be worked on at once; a run survives a controller restart |
| Approvals relayed to the voice conversation | The channel's permission relay lets Claude Code's approval prompts be answered by voice |
| Telegram as an optional second return channel | Voice assistants only poll. Once you hang up, a late result would wait until the next conversation |
| Docker with access levels derived from the GitHub token | Host workers run as you, with your logins. A container with a scoped token limits what a run can reach and publish |
| Changes out of a read-only container as a git bundle into a clean clone | Fetching from the container's folder would run git with config that the container controls |
| A kill switch in the gateway's code | A lock that does not depend on the controller following instructions |
| A watchdog, and the channel as an allowlisted plugin | The session has to come back after a crash without someone at the terminal. With the development flag, Claude Code asks at every start; an organisation allowlist is the supported way around it |
| A setup assistant | Many keys, files and steps; a page with a guide per field is less error-prone than a long manual |

Things that did not work and were replaced:

- **Claude Code's Bash sandbox** for the controller: on Ubuntu 24.04 and later, AppArmor's
  `bwrap-userns-restrict` profile stops it from starting ([sandboxing][sandbox]). A PreToolUse hook
  with a command allowlist confines the controller instead.
- **Tailscale Funnel on port 8443:** Claude's servers did not reach it in our tests; port 443 works.
- **Skipping the development-channel prompt:** there is no supported way for a channel that is not
  on the approved list ([channels reference][ref]). The plugin on the organisation's allowlist is
  the way without a prompt.
- **`git fetch` from the container's folder:** it starts `git upload-pack` in a repository the
  container controls. A bundle is plain data ([details](#57-the-mounted-folder-and-the-clean-clone)).

## 3. Comparison with existing solutions

Checked on 2026-10-28 against the sources linked in each row. "Unverified" means no source
confirmed it.

| | Voice front end | What it controls | Where the code runs | Car | Source and licence |
|---|---|---|---|---|---|
| **cc-voice-gateway** | Claude's voice mode in the Claude app, through a custom MCP connector | A running Claude Code session (channel), which dispatches headless workers | Your computer; workers optionally in Docker | Wherever the Claude app's voice mode runs | This repository, private |
| [carcode][carcode] | Siri: a Siri Shortcut ("Hey Siri, Jarvis") on the iPhone | The Claude Code CLI on your Mac, with your login | Your Mac, reached through a Cloudflare quick tunnel; the server can run on Linux, the Shortcut needs macOS once | CarPlay, through Siri | Open source, MIT |
| [DashVox][dashvox] | Its own iPhone app, with CarPlay and Apple Watch | Claude Code, Claude Cowork, Codex or another CLI, over SSH on your machines | Your machines; the app's backend is DashVox Cloud or self-hosted | CarPlay | App free, with a paid tier; source code unverified |
| [VoiceMode][voicemode] | Microphone and speakers of the computer; speech recognition and output local (Whisper.cpp, Kokoro) or through OpenAI-compatible services | Claude Code itself, as an MCP server or plugin | Your computer | None documented | Open source, MIT |
| [Claude Code Remote Control][rc] | None: the Claude app and claude.ai offer dictation, not voice mode, for Claude Code ([voice mode][voice]) | A local Claude Code session, from claude.ai/code or the Claude app | Your computer, outbound HTTPS only, no inbound port | No | Anthropic. Pro, Max, Team, Enterprise; on Team and Enterprise an Owner enables it |
| Claude for Android Auto | Unverified: no official or third-party Claude app for Android Auto was found | – | – | – | – |

For the car itself, the Claude app supports CarPlay ([MacRumors, 2026-09-04][carplay]); this
project uses whatever voice mode the app offers there.

What this project adds over the others:

- **Claude is the voice.** No Siri phrase, no speech pipeline of its own. The same assistant that
  understands you also decides what to hand to Claude Code, and reads back a short answer in your
  language.
- **A controller and workers.** One conversation drives a persistent session that knows what you
  asked before, and several repositories at once. Results arrive later as news; questions from a
  worker come back to you.
- **Approvals and merges by voice.** Claude Code's approval prompts reach the conversation. A merge
  needs your spoken yes and then an approval ([confinement](#53-the-controllers-confinement)).
- **Telegram after the call**, optional.
- **Isolation as a choice.** Workers on the host, or in Docker at a level that the GitHub token
  decides, with a defined path out for read-only containers.
- **A kill switch in code**, with triggers by voice, Telegram, fixed rules and the controller.

What it costs:

- **A public HTTPS endpoint** that Claude's servers can reach.
- **A research-preview feature:** channels, with the development flag or an organisation
  allowlist. Team and Enterprise need an Owner for channels and connectors.
- **More moving parts** than carcode or DashVox.
- **Others do some things better:** carcode installs with one `npx` command; DashVox has a
  polished app with an Apple Watch and several agents; VoiceMode works at the desk without any
  cloud voice; Remote Control is supported by Anthropic and needs no inbound connection.

## 4. Diagrams

All diagrams are made with [draw.io](https://www.drawio.com) and saved as `.drawio.svg`: an SVG
image with the diagram embedded, so GitHub shows it as a picture and draw.io opens it for editing.
In VS Code, the [vscode-drawio](https://github.com/hediet/vscode-drawio) extension edits them
inline, right in the repository.

The product page is dark, so it shows a copy of the architecture diagram exported with draw.io's
dark theme. After changing the diagram, export that copy again:

```bash
draw.io -x -f svg --theme dark -o docs/assets/architecture-dark.svg docs/architecture.drawio.svg
```

### 4.1 Architecture

See the diagram in the [Overview](#1-overview). The gateway is the only own code at run time;
everything blue is Claude Code.

### 4.2 A request

![Flow of a request](docs/request-flow.drawio.svg)

The voice AI calls `send` and then `get_reply` until the state is `done`. Every result starts with
a machine-readable line, for example `[state=working id=k7f3 elapsed=34s]`. Requests and approvals
have these states:

![States](docs/states.drawio.svg)

### 4.3 Setup

![Setup assistant](docs/setup.drawio.svg)

### 4.4 Variants

![Variants](docs/variants.drawio.svg)

| Variant | Turned on by | Effect |
|---|---|---|
| Voice only | default | News reaches you when the voice AI calls |
| Voice + Telegram | `.secrets/telegram_token` and `.secrets/telegram_chat_id` | After 60 s without a voice call, results, questions and approvals also go to Telegram; `/stop` locks the kill switch |
| Workers on this computer | default (`VOICE_GW_DOCKER` empty) | Runs in your checkouts as you |
| Workers in Docker | `VOICE_GW_DOCKER=<container>` | Runs in the container; the level per repository comes from its GitHub token, or from `VOICE_GW_ACCESS` |

### 4.5 Pushing from a read-only container

The container has no token that can write, so nothing leaves it by itself. You bring a branch out
at the desk, review it in a clean clone and push it from there.

![Pushing from a read-only container](docs/push-read-only.drawio.svg)

```bash
scripts/fetch-from-container.sh alpha voice/fix-typo
git -C ~/Developer/alpha log -p origin/HEAD..container/voice/fix-typo
git -C ~/Developer/alpha push origin refs/remotes/container/voice/fix-typo:refs/heads/voice/fix-typo
```

What `scripts/fetch-from-container.sh <repository> <branch>` does:

1. **Checks the names and the clone.** Plain repository and branch names only. There must be a
   clean clone at `$VOICE_CLEAN_ROOT/<repository>` (default: the folder that holds this
   repository). It asks Docker which host folder is mounted at `/repos` and refuses a clean clone
   inside it.
2. **Bundles in the container.** `docker exec <container> git -C /repos/<repository> bundle create
   - refs/heads/<branch> ^<origin/HEAD>`: only the commits the clean clone does not have, when it
   knows `origin/HEAD`; otherwise the whole branch. The bundle comes back on stdout into a
   temporary file on this computer. It is not written into the mounted folder.
3. **Verifies and fetches.** In the clean clone, `git bundle verify`, then `git -c
   transfer.fsckObjects=true fetch --no-tags --no-recurse-submodules --no-write-fetch-head <bundle>
   +refs/heads/<branch>:refs/remotes/container/<branch>`.
4. **Hands over.** Prints the new commits and the review and push commands. Nothing is checked
   out and nothing is pushed: pushing is your step, with your own login.

Settings: `VOICE_GW_DOCKER` (container, `voice-workers`), `VOICE_GW_DOCKER_REPOS` (`/repos`),
`VOICE_CLEAN_ROOT`, `VOICE_GW_DOCKER_BIN`.

### 4.6 Pushing at levels pr and full

![Pushing at levels pr and full](docs/push-pr.drawio.svg)

## 5. Security design

The guiding assumption: whoever can talk to the connector, and any text a worker reads, may be
hostile. Prompt injection through a repository, a pull request or a web page is the main risk, next
to a lost phone or a leaked token.

### 5.1 Who can do what

| Actor | Can | Cannot |
|---|---|---|
| Anyone on the internet | Reach the sign-in page | Call a tool without a token; get a token without a pairing code from your computer |
| A signed-in voice client | Send requests, read answers, answer approvals, lock the kill switch | Unlock the kill switch; reach the controller's tools directly |
| The controller | Read `controller/`, write `controller/playground/`, read pull request and CI status, merge after an approval, dispatch workers with your words from a recent voice request, raise the alarm | Start a worker on words that only a worker result or a pull request brought in (see 5.4); anything else (see 5.3) |
| A worker on this computer | Everything your user can, without approvals | Nothing is blocked; rules only observe (see 5.9) |
| A worker in Docker | The mounted folder, the container's tokens, the network | Your other files, SSH keys, `gh` login; more on GitHub than its token allows |
| Others on GitHub | Comment on a watched pull request: the news names them; the text of the repository's owner, members and collaborators reaches the controller, marked `trusted="no"` | Get anyone else's text to the controller through the watch; have a fork or someone else's pull request watched (see 8.4) |
| The Telegram chat | Receive news; send `/stop` | Anything else; other chats are ignored |

### 5.2 The voice endpoint and OAuth

- **Binding and exposure.** The gateway listens on `127.0.0.1` only (`VOICE_GW_HOST`). A tunnel or
  reverse proxy publishes it at HTTPS on port 443. A certificate from a public authority, Tailscale
  Funnel's included, puts the host name into the certificate transparency logs.
- **The gateway is its own OAuth server.** OAuth metadata, dynamic client registration, client ID
  metadata documents, and the authorisation code flow with PKCE (S256).
- **Redirect addresses** must be HTTPS on `claude.ai` or `claude.com` (`VOICE_GW_OAUTH_HOSTS`), or
  a loopback address.
- **Sign-in needs a pairing code** from `node scripts/pair.mjs` on your computer: eight digits,
  valid for five minutes and one sign-in. Five wrong attempts lock out the client and the address
  they came from (the last `X-Forwarded-For` entry, set by the tunnel), so a stranger cannot burn
  your code; twenty wrong attempts in all burn it.
- **Tokens.** Access tokens last one hour. The refresh token rotates on every use and expires after
  30 days. Local tokens for `scripts/fake-voice.mjs` last 12 hours.
- **Stored as hashes only:** tokens, codes and client secrets are stored as SHA-256 hashes in
  `.secrets/oauth.json`.
- **Revocation:** `node scripts/pair.mjs list`, `revoke <id>`, `revoke all`.
- **The admin socket** `.secrets/admin.sock` (pairing, unlocking) is a Unix socket in a folder
  with mode 0700.

### 5.3 The controller's confinement

The controller runs without approvals for its few tools, since whoever can reach it could answer
approvals anyway. Its limits are enforced by a PreToolUse hook, `controller/.claude/hooks/confine.mjs`.
A hook that exits with code 2 blocks a call before any permission rule or prompt. The hook sees
every tool call (matcher `*`) and blocks every tool that is not on its list. It resolves symlinks
and fails closed.

| Tool | Allowed |
|---|---|
| The gateway's tools | `reply`, `list_workers`, `dispatch`, `worker_status`, `stop_worker`, `restart_controller`, `raise_alarm`, as `mcp__voice__…` and `mcp__plugin_voice_voice__…` |
| ToolSearch, TodoWrite, TaskCreate, TaskGet, TaskList, TaskUpdate | Always. They load deferred tools and keep the to-do list |
| Read, Glob, Grep | Inside `controller/` |
| Write, Edit, MultiEdit, NotebookEdit | Inside `controller/playground/` |
| Bash | `ls` inside `controller/`; `sleep <seconds>`; `rm [-f]` with plain file names in `playground/`; the `gh` commands below |
| `gh`, read-only | `gh pr view`, `list`, `checks`, `diff`, `status`; `gh run view`, `list`. Each needs `--repo owner/name` and only takes listed flags, for example `--json` with a plain field list, `--state`, `--limit`, `--author`, `--branch`, `--log`, `--log-failed` |
| `gh pr merge` | `gh pr merge <number> --repo owner/name` with exactly one of `--squash`, `--merge`, `--rebase`, optionally `--delete-branch`. The hook answers "ask" |
| Everything else | Blocked, with a reason for the controller |

- **Why deny by default.** The controller keeps your user settings, because Claude Code needs them
  for channels. So your plugins (with their skills and hooks), your allow rules and, in plugin
  mode, your MCP servers load into it too. An MCP tool that your settings allow would otherwise
  run unconfined and without a prompt.
- **Blocked, among others:** every other MCP server's tools, also those from plugins; subagents
  (Agent, Task), since it is not clear that the hook sees their calls; skills; web fetch and
  search; MCP resources; `AskUserQuestion` and plan mode, since nobody can click a form in the car.
- **Only the gateway as MCP server, with the development flag.** The start script passes
  `--strict-mcp-config --mcp-config controller/.mcp.json`, so no other MCP server starts.
- **Not with the plugin.** `--strict-mcp-config` also drops plugins' MCP servers, the gateway's
  included (checked in Claude Code 2.1.284). In plugin mode your MCP servers start, and the hook
  blocks their tools.
- **No planted instructions.** The file tools and `rm` never touch files named `CLAUDE.md`,
  `CLAUDE.local.md`, `AGENTS.md` or `.mcp.json`, or anything in a `.claude` folder, also in
  `playground/`. Claude Code would read them as instructions or settings. Case does not matter.
- **Blocked `gh` commands:** `gh auth` (prints the token), `gh api` (can write), `gh config`,
  `gh alias`, `gh extension`, every other subcommand that writes (checkout, edit, comment, review,
  close, ready, run rerun, cancel, delete, download), and `--web`, `--jq`, `--template`.
- **Blocked merge options:** `--admin`, `--auto`, `--disable-auto`, `--match-head-commit`, the
  message options, and branch names instead of numbers.
- **"Ask" for a merge.** The hook answers "ask", which overrides the settings' allow rule for Bash:
  Claude Code opens an approval prompt, and the channel relays it to the voice conversation.
  Verified with Claude Code 2.1.310: without "ask" the allow rule lets the merge run at once; with
  it, the merge waits for the approval.
- **Two confirmations per merge.** `controller/CLAUDE.md` makes the controller ask you first, so
  every merge needs a spoken yes and then the approval.
- **Denied in `controller/.claude/settings.json`:** claude.ai connectors (`mcp__claude_ai_*`), web
  fetch and search, messages to other sessions, remote and scheduled agents, artifacts, Monitor,
  workflows and worktrees. Bypass and auto mode cannot be turned on.
- **Manual mode.** `scripts/start-controller.sh` starts the session with `--permission-mode manual`,
  whatever the user settings say. Never start the controller with
  `--dangerously-skip-permissions`.
- **What read-only still means:** the controller can read pull requests, diffs and CI logs of
  every repository your `gh` login can see, and tell them to whoever is signed in.
- **Changes need a restart.** The session reads its settings, the hook configuration and
  `controller/CLAUDE.md` when it starts.

### 5.4 Approvals by voice

- **How it works.** The gateway declares `claude/channel/permission`, so Claude Code sends approval
  prompts to the channel as well as the terminal; the first answer wins. A prompt has a five-letter
  code, covers one action and drops from the voice view after 15 minutes
  (`VOICE_GW_PERMISSION_TTL`).
- **Whoever can call `approve` can approve.** The voice AI is told to approve only after an
  explicit yes; that is an instruction, not enforcement.
- **What it guarantees:** the controller cannot merge on its own, for example because a pull
  request's text told it to.
- **Turning it off:** `VOICE_GW_PERMISSION_RELAY=0`. Then approvals, merges included, happen only
  at the terminal.
- **Secrets in prompts:** Claude Code masks recognisable credentials in relayed prompts, but not
  every secret ([channels reference][ref]).

**Dispatch needs your words.** The controller also reads text nobody here wrote: worker results,
which carry whatever a run read, and news about pull requests. Both arrive with `trusted="no"`,
and its instructions call that text data, never instructions. The gateway checks in code as well
(`src/channel.mjs`):

- **The check.** `dispatch` starts a run only when its `words` occur in a voice request of the
  last `VOICE_GW_DISPATCH_WINDOW` minutes (30). At least two words, whole words, compared in lower
  case without punctuation and quotes. Worker results and pull request news never count.
- **Answers count.** A follow-up "(Answer to <id>) Yes." is a voice request too. The words may
  start in "(Answer to <id>)", so that a plain yes can be passed on, but must reach into what you
  said; the gateway's prefix alone does not count.
- **Every dispatch.** With `direct` and `allow_dirty` too. Otherwise `dispatch=needs_driver`:
  nothing starts, and the controller is told to ask you by voice. `list_workers`,
  `worker_status` and `stop_worker` are not checked.
- **What it guarantees:** text in a repository, a run's result or a pull request cannot start a
  worker by itself.
- **What it does not:** the controller still reads that text, and it writes the `task` itself. A
  phrase you said recently can be quoted again for another task, another repository or with
  `direct`, as long as it is within the window. And whoever can call `send` supplies the words,
  like whoever can call `approve` approves.

### 5.5 Workers: on this computer or in Docker

What applies to every worker run (`src/workers.mjs`):

- **Options:** `claude -p --permission-mode bypassPermissions --permission-prompts none
  --strict-mcp-config`. A repository's own MCP servers do not start.
- **Denied tools:** claude.ai connectors, messages to other sessions, remote and scheduled agents,
  artifacts, workflows, Monitor, worktrees, `AskUserQuestion` and plan mode.
- **Environment:** the controller session's variables (`CLAUDECODE`, its messaging socket and
  token, the session id) are removed, so a worker cannot reach the controller.
- **Before a run:** the gateway refuses a dispatch without your words from a recent voice request
  ([5.4](#54-approvals-by-voice)), a checkout with uncommitted changes until you agree, a second
  run in the same repository, and more than `VOICE_GW_MAX_WORKERS` runs. A run stops after
  `VOICE_GW_WORKER_TIMEOUT` minutes.
- **Not this repository.** On this computer the gateway's own checkout is no worker, even inside
  `VOICE_GW_WORKER_ROOT`: a run there could change the gateway, the confine hook and
  `controller/CLAUDE.md`. `VOICE_GW_WORKER_SELF=1` lists it anyway. In Docker, the container's
  clones are what counts.
- **Rules for the run** (`WORKER_RULES`): branch `voice/<name>`, commit only its own changes, never
  force-push, merge or delete branches, ask before pushing a public repository. These are rules,
  not limits.

| | On this computer | In Docker |
|---|---|---|
| Runs as | You, in your checkouts in `VOICE_GW_WORKER_ROOT` | Your user id, in the container's clones in the mounted folder |
| Reaches | Everything your user can: files, SSH keys, the `gh` login, `.secrets/`, this repository's code | The mounted folder, `/run/secrets/voice` (read-only), the network |
| GitHub | Your `gh` login: every repository you can write to | The container's token, at the level it allows |
| Started by | `spawn` in its own process group | `docker exec … voice-run`, which hands over the tokens and starts its own process group |
| Isolation | None | The container |

![Workers in Docker](docs/docker.drawio.svg)

**The container** (`docker/Dockerfile`, `scripts/start-workers-container.sh`):

- **Image:** `node:22-bookworm-slim` with git, `gh`, procps and Claude Code. Its user `worker` has
  your user and group id.
- **Started with** `--user <uid>:<gid> --init --restart unless-stopped`.
- **Mounts:** the folder of clones at `/repos`, read-write, or read-only while the kill switch is
  locked; the volume `voice-home` at `/home/worker`; `.secrets/worker` at `/run/secrets/voice`,
  read-only.
- **Tokens:** `voice-run` reads them for each run (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`). git
  gets the GitHub token from the credential helper `git-credential-voice`. They are never part of
  the container's configuration.
- **Docker itself:** whoever controls the gateway can control Docker, which on Linux is as good as
  root.

### 5.6 Access levels and their detection

In Docker, each repository gets a level (`src/access.mjs`). `list_workers` and `dispatch` show it
with the reason, for example `access pr (main is protected by a ruleset)`.

| Level | Token | Default branch | Workers |
|---|---|---|---|
| `read-only` | None, or one that cannot push or open pull requests | Any | Commit on a local `voice/` branch. Never push, never open a pull request ([4.5](#45-pushing-from-a-read-only-container)) |
| `pr` | Can push (Contents) and open pull requests | Protected by branch protection or a ruleset | Push a `voice/` branch and open a draft pull request |
| `full` | As `pr` | Not protected | A draft pull request by default; a push to the default branch only when you ask, through `dispatch` with `direct` |

**How the level is detected**, per repository:

1. **No token or no GitHub remote:** `read-only`.
2. **Can your account push?** It asks `GET /repos/{owner}/{repo}`; `permissions.push` false
   means `read-only`.
3. **Can the token write?** It sends two write requests without content, `POST …/git/refs` and
   `POST …/pulls`. GitHub answers 422 when the token may write and 403 or 404 when not; neither
   creates anything. Either one failing means `read-only`. In a repository with pull requests
   turned off (`has_pull_requests` false), only the first is asked.
4. **Is the default branch protected?** It looks at branch protection (`GET …/branches/{branch}`)
   and the rulesets (`GET …/rules/branches/{branch}`). Protection, or a ruleset of type
   `pull_request`, `update`, `required_status_checks` or `merge_queue`, means `pr`; otherwise
   `full`. Rulesets answering 403 or 404, for example on a private repository without GitHub Pro,
   count as none.
5. **Whatever it cannot tell counts as the lower level.**

**Pull requests turned off.** In Settings > General > Features, pull requests can be turned off for
a repository. There is nothing to open then, so a worker commits on the default branch and pushes
it there:

- In Docker this happens at `full`, shown as `access full (pull requests are turned off, main is
  not protected: direct push)`. With the default branch protected, nothing could be published, so
  the repository is `read-only`.
- On this computer, `gh api repos/{owner}/{repo}` tells; `list_workers` shows `pull requests off:
  pushes to main`.
- `dispatch` answers with `push=direct`, and the kill switch's rule on the default branch
  ([5.9](#59-the-kill-switch)) lets such a run push there, as after an explicit `direct`.
- Public repositories still need your yes before the push. With pull requests limited to
  collaborators (`collaborators_only`), nothing changes: workers open pull requests as before.

The token is read at every check, and each result is kept for ten minutes (one minute after an
API error). `VOICE_GW_ACCESS=read-only|pr|full` sets one level for every repository instead. A
level is only as strict as the token: a worker forced to `read-only` with a write token could still
push; only its rules forbid it.

**The repository is pinned.** The level is detected for the GitHub repository that the clone's
origin names, and the kill switch watches that one ([5.9](#59-the-kill-switch)). A worker in the
container can change the origin, so the gateway keeps the repository it saw first for each clone,
in `.state/workers.json` under `origins` ("no GitHub remote" counts too). If the origin later names
another one:

- `dispatch` answers `dispatch=origin` and starts nothing, also with `direct`.
- `list_workers` shows `the origin changed in the container from acme/x to acme/y; check it at
  the desk`.
- At the desk, set the origin back in the container:
  `docker exec voice-workers git -C /repos/x remote set-url origin <url>`. If you changed it
  yourself, stop the controller (`scripts/start-controller.sh --stop`), remove the clone's line
  under `origins`, and start it again.

Creating tokens:

| For | GitHub token |
|---|---|
| `read-only`, public repositories | None |
| `read-only`, private repositories | [Fine-grained][pat-fine]: only the chosen repositories, Contents: Read-only. Not a classic token: its `repo` scope can also write |
| `pr` and `full` | [Fine-grained][pat-fine]: Contents and Pull requests: Read and write; Workflows: Read and write only if workers should change `.github/workflows`. Or a [classic token][pat-classic] with `repo` (and `workflow`), for all your repositories |
| `pr` additionally | A [ruleset][rulesets] on the default branch that requires pull requests, with an empty bypass list, or branch protection with "Do not allow bypassing". On private repositories this needs GitHub Pro, Team or Enterprise |

An organisation may have to approve a fine-grained token first ([personal access tokens][pat]).

### 5.7 The mounted folder and the clean clone

**Rules:**

1. **git on this computer never runs in the mounted folder.** Not by hand, not through a
   git-aware shell prompt, not through an editor that opens the folder. The gateway runs every git
   command for the container through `docker exec`.
2. **Changes come out only as a bundle into a clean clone** outside the folder
   ([4.5](#45-pushing-from-a-read-only-container)). The helper refuses a clean clone inside the
   folder.
3. **Review before you push or check out.** A checkout applies the branch's `.gitattributes` with
   filters configured on this computer, such as git-lfs. Workflow files under `.github/` run on
   GitHub with the repository's secrets.

**Why, checked with git 2.53:**

- **Fetching from the folder starts the container's side.** A fetch from a local path, plain or
  `file://`, starts `git upload-pack` in the source repository, which reads that repository's
  config. A container-side `uploadpack.hideRefs` decided which branches the host could fetch.
- **No command ran that way, but the surface is open.** git ignores `uploadpack.packObjectsHook`
  from a repository's own config, upload-pack runs no hooks, and since 2.45.1 it refuses the lazy
  fetch of a crafted partial clone (CVE-2024-32004). Still, the host opens a repository the other
  side controls, and every config key that upload-pack honours widens that.
- **No flag avoids it.** `--no-local` does not exist for `git fetch`. `protocol.file.allow=never`
  blocks local paths and bundles alike.
- **`git status` in the folder ran a container-side `core.fsmonitor` command.** That is rule 1.
- **A bundle is data:** a list of refs and a pack. Fetching it reads no config of the other side,
  runs no hook and needs no repository there. Fetching it, `git log -p` and `git diff` ran nothing.
  A checkout did run a filter from `.gitattributes` (rule 3).

**Threat model:** anything in the container may be hostile; a worker controls every file in the
folder, `.git` included.

- **What this protects:** nothing from the folder runs on this computer, and nothing goes to
  GitHub from this computer unless you push it.
- **What it does not do:** judge whether the changes are good.
- **Above `read-only`:** at `pr` and `full` the container pushes by itself, within its token.

### 5.8 The Telegram fallback

- **On only with both files:** `.secrets/telegram_token` and `.secrets/telegram_chat_id`.
- **When:** after `VOICE_GW_TELEGRAM_AFTER` seconds (60) without a voice tool call, voice mode
  counts as ended. Results, questions and approval requests then also go to the chat, each once;
  interim `working` updates do not. The kill switch alarm goes at once, whether voice mode is on
  or not, and so does a note when the gateway ends because another process holds its port.
- **Inbound:** only `/stop`, `/notstopp`, `/killswitch`, `/emergencystop` or an emergency phrase,
  only from the configured private chat, only if sent in the last two minutes. Everything else is
  ignored. You cannot answer questions or approvals by Telegram.
- **Through Telegram's servers.** Bot chats are not end-to-end encrypted, so leave the files out
  if that is not acceptable.
- **The token** never appears in a log line or error message.

### 5.9 The kill switch

One lock in the gateway's code (`src/killswitch.mjs`, `src/guard.mjs`). It does not depend on the
controller following instructions.

![Kill switch](docs/killswitch.drawio.svg)

**Triggers:**

| Trigger | How | Checked |
|---|---|---|
| Voice | "Notstopp", "Not-Stopp", "Notfallstopp", "Nothalt", "Not-Aus", "emergency stop", "kill switch"; or the tool `emergency_stop` | In `send` and `ask` before anything reaches the controller: the message starts with the phrase, or has at most six words |
| Telegram | `/stop` or a phrase | See 5.8 |
| Rule: default branch | A push to the default branch, or a merge, without a direct dispatch at level `full`, in a repository with pull requests turned on | In the run's commands: `git push` to the default branch, `--all`, `--mirror`, `gh pr merge`, and `gh api` calls that merge (`PUT …/pulls/<n>/merge`, `POST …/merges`, the GraphQL mutations `mergePullRequest`, `enablePullRequestAutoMerge`, `mergeBranch`). With `gh`, every `VOICE_GW_KILL_CHECK` seconds and at the end: the default branch moved on GitHub, and the worker's repository holds the new head, or the new head merged a pull request of the run (below) |
| Rule: outside | Writes outside the repository, `/tmp`, `/var/tmp` (and the system's temp folder on this computer) and `VOICE_GW_KILL_ALLOW_PATHS` | The file tools by path. Shell commands by explicit targets: redirections, `tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`, `truncate`, `sed -i`, `dd of=`, also after `cd`; `$HOME` and `~` are expanded |
| Rule: many changes | More than 500 file edits in a run; at its end more than 300 files or 30,000 lines changed | Edits as they happen; at the end the commits made during the run plus what is not committed. `VOICE_GW_KILL_MAX_*` |
| Controller | `raise_alarm` with a reason | One more signal, never the only one |

**Whose merge it is.** A merge on GitHub makes a commit that the worker's repository does not
have. So when the default branch moved to such a commit, the gateway asks
`gh api repos/{owner}/{repo}/commits/{sha}/pulls` which pull request it merged. That merge counts
as the run's when:

- **the run pushed the pull request's branch:** named in a `git push`, or logged in the worker's
  repository as a push since the run started (the reflog of `origin/<branch>`); or
- **the pull request was opened during the run,** from a `voice/` branch.

A pull request that was there before the run, and that the run did not push to, is not the run's:
your merge at the desk of an earlier worker's pull request does not trip the switch. Your merge of
the running worker's own pull request does, so wait until the run has ended. GitHub cannot tell
who merged when you and the workers use the same account. Direct dispatches and repositories with
pull requests turned off are exempt, as for pushes.

**Effects**, at once:

- **No new work:** `dispatch` answers `locked`, also a dispatch whose checks were still running
  when the switch tripped; `send` and `ask` hand nothing over.
- **Approvals:** open ones are denied, new ones are denied automatically.
- **Workers:** every run stops. With Docker the container stops and loses its restart policy.
  While locked, `scripts/start-workers-container.sh` mounts the folder read-only, and the gateway
  stops a container with a writable `/repos` within `VOICE_GW_KILL_CHECK` seconds.
- **Alarm:** to Telegram at once, to every voice chat with its next call (`[ALARM]`), and to the
  controller.
- **State:** saved in `.secrets/killswitch.json`, mode 0600; it survives restarts. A file that
  cannot be read counts as locked.

**Unlocking**, only at the server's terminal:

```bash
node scripts/unlock.mjs --status   # what locked it
node scripts/unlock.mjs            # asks you to type "unlock"
scripts/start-workers-container.sh # Docker: start the container again
```

It unlocks the running gateway through the admin socket, or removes the file. There is no way to
unlock by voice, Telegram or the controller.

### 5.10 Secrets and files

| Path | Content | Mode |
|---|---|---|
| `.secrets/` | Folder for everything below | 0700 |
| `.secrets/oauth.json` | Clients and grants, hashes only | 0600 |
| `.secrets/admin.sock` | Admin socket of the running gateway | socket in the 0700 folder |
| `.secrets/gateway.env` | Settings from the setup assistant | 0600 |
| `.secrets/telegram_token`, `.secrets/telegram_chat_id` | The Telegram bot | 0600 |
| `.secrets/killswitch.json` | Kill switch state, present while locked | 0600 |
| `.secrets/worker/claude_token`, `.secrets/worker/github_token` | The container's logins, mounted read-only into it | 0600, folder 0700 |
| `.state/` | Worker state, run output, open requests, watched pull requests, the watchdog's lock | 0700 when the gateway creates it |
| `.state/tasks/`, `.state/workers.json` | Each run's output with every tool input and result; the workers' state | 0600, folder 0700 |
| `.state/requests.json` | Voice requests and the answers, with what the voice client has read | 0600 |
| `.logs/gateway.log`, `.logs/gateway.log.1` | Log, without tokens; rotated at `VOICE_GW_LOG_MAX_MB` | 0600, folder 0700 when the gateway creates it |

Folders created by an earlier version keep their mode; tighten them once with
`chmod 700 .state .logs`.

`.secrets/`, `.state/` and `.logs/` are ignored by git. The controller's confinement keeps it
away from `.secrets/`; the container sees only `.secrets/worker`.

### 5.11 The setup assistant

It runs only while you set up, listens on every interface by default (for headless servers), and
is guarded as follows:

- **One-time link:** a token of 256 random bits, shown only on the terminal and compared in
  constant time. With its output in a pipe or a file the assistant does not start, so the link
  never lands in a log.
- **One browser:** the first use spends the token and binds the setup to that browser with an
  HttpOnly, SameSite=Strict cookie.
- **Wrong links:** after five from one address in ten minutes, or 30 in total, every attempt is
  refused for a while.
- **Write requests** must come from the page's own origin, as JSON. The page has a strict Content
  Security Policy, sends no referrer and is not cached.
- **It ends by itself:** after 10 minutes without activity (`--idle`), after 30 minutes at most
  (`--timeout`), after writing, and on Cancel.
- **Plain HTTP, by decision:** a notice at the top of the page says to use it only on your own
  network, since the one-time token and the keys travel unencrypted. From elsewhere, use an SSH
  tunnel.
- **No secret leaves it.** None goes back to the browser (saved ones show as `••••••••`), to the
  terminal or to a log. Output of the commands it runs shows a known secret as `‹secret›`.

### 5.12 Limits

- **Nothing is undone.** A push, a merged pull request or a deleted branch stays as it is. The kill
  switch stops what comes next.
- **The rules see a step only after it ran.** They read the commands Claude Code reports; the
  command that breaks a rule has usually run already.
- **Hidden actions are missed.** Not seen:
  - a push or a write inside a script, an alias or another language;
  - targets in variables other than `$HOME`;
  - writes by programs, such as `npm install` into `~/.npm`;
  - paths behind symlinks.

  A worker that fetched someone else's push can look guilty. A push whose commit the worker did
  not keep is missed. A merge that you approved through the controller while a worker in the same
  repository fetches can also look like the worker's push.
- **On this computer the kill switch is a tripwire, not a boundary.** Host workers run as you,
  without approvals. They can write `.secrets/` (including `killswitch.json` and `gateway.env`),
  use your SSH keys and `gh` login, and change this repository's code (the gateway, the confine
  hook, `controller/CLAUDE.md`), which takes effect at the next restart; leaving this checkout out
  of the workers ([5.5](#55-workers-on-this-computer-or-in-docker)) only keeps runs from starting
  in it. A process a worker detached from its process group can survive a stop. **Only Docker
  isolates.**
- **In Docker,** the container can do what its token allows on GitHub, and reaches the network.
- **The controller reads untrusted text.** Worker results, pull request news and what read-only
  `gh` shows reach it. `trusted="no"` and its instructions ask it to treat them as data; that is
  an instruction, not enforcement. The dispatch check ([5.4](#54-approvals-by-voice)) holds in
  code, but a phrase you said within `VOICE_GW_DISPATCH_WINDOW` can be reused for another task,
  and the controller writes the task itself. Merges still need your approval; its answers to you,
  `restart_controller` and `raise_alarm` are not checked.
- **The voice AI is an instruction-follower.** If it rewrites "Notstopp" into a longer sentence,
  the phrase check can miss it; the `emergency_stop` tool is there for that. Approvals depend on
  it asking you.
- **The endpoint is public.** The pairing code protects the sign-in; nothing limits the request
  rate, and nothing protects the availability.
- **Run it on a computer or VM you can afford to lose,** and when in doubt:
  `node scripts/pair.mjs revoke all`.

## 6. Prerequisites

| Component | Version | Needed for | Notes |
|---|---|---|---|
| Node.js and npm | Node.js 20 or later (`engines` in `package.json`); tested with 22.22.1 and npm 10.9.4 | The gateway, scripts, tests | npm comes with Node.js |
| Claude Code | 2.1.80 or later for channels, 2.1.81 for the permission relay, 2.1.84 for `allowedChannelPlugins` (plugin mode). Tested with 2.1.310 | Controller and workers | Logged in with claude.ai. Channels need claude.ai or Console authentication; not on Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry ([channels][channels]) |
| Claude subscription | See below | Voice mode, connector, channels, `setup-token` | |
| git | 2.29 or later on the host for `scripts/fetch-from-container.sh` (`--no-write-fetch-head`); tested with 2.53.0 | Workers, the fetch helper | The container brings its own (Debian bookworm) |
| GitHub CLI `gh` | Tested with 2.46.0 | Host workers (push, pull requests), the controller's status questions and merges, the pull request watch, the kill switch's default-branch check | `gh auth login` on this computer |
| Docker | Tested with 29.8.0 | Optional: workers in a container | Docker installed as a snap cannot mount folders from `/tmp` |
| tmux | Tested with 3.6 | Optional: the controller in the background | The setup assistant's autostart uses it |
| systemd user services | – | Optional: autostart at login on Linux | `loginctl enable-linger` for a start at boot |
| A public HTTPS address on port 443 | – | Claude's servers reach the gateway | Tailscale Funnel (tested, 1.104.2) or a reverse proxy |
| Claude app | Current | Voice mode with the connector | Used on the iPhone |

**What `npm install` installs:**

- **Two direct dependencies,** from `package.json`:
  - `@modelcontextprotocol/sdk` `^1.32.2` (installed 1.32.2): the MCP server for both sides (stdio
    and Streamable HTTP), and the clients in the tests;
  - `zod` `^4.6.7` (installed 4.6.7): schemas for the tool inputs.
- **What the SDK brings:** `@hono/node-server`, `ajv`, `ajv-formats`, `content-type`, `cors`,
  `cross-spawn`, `eventsource`, `eventsource-parser`, `express`, `express-rate-limit`, `hono`,
  `jose`, `json-schema-typed`, `pkce-challenge`, `raw-body`, `zod-to-json-schema`, and their
  dependencies.
- **In total,** 92 packages in `node_modules`, pinned by `package-lock.json`. Nothing is compiled.

**Operating systems:**

- **Tested:** Ubuntu 26.04.1 LTS, for the gateway, workers on the host and in Docker, the
  watchdog and the setup assistant. The controller's Bash allowlist exists because of Ubuntu
  24.04+.
- **Not tested:** macOS. The scripts know its paths (managed settings, LaunchAgent).
- **Phone:** the Claude app on the iPhone; Android not tested.

**Claude subscription.** The account that runs Claude Code and the account in the Claude app may
differ.

| Feature | Plans | Admin step on Team and Enterprise |
|---|---|---|
| Voice mode in the Claude app | All plans ([voice mode][voice]) | – |
| Custom connector (remote MCP) | Free (one connector), Pro, Max, Team, Enterprise ([connectors][connectors]) | On Team, only Owners and Primary Owners add connectors |
| Claude Code channels | Pro and Max without an admin step ([channels][channels]) | An Owner enables channels: Organization settings → Claude Code → Channels, or `channelsEnabled: true` |
| Channel plugin without the prompt | Team and Enterprise managed setting `allowedChannelPlugins` ([channels][channels-admin]) | Owner, see [7.4](#74-admin-steps-for-team-and-enterprise) |
| `claude setup-token` for the container | Pro, Max, Team or Enterprise ([authentication][auth]) | – |

On the draw.io Team plan this means:

- an Owner enables channels and adds the custom connector;
- optionally, an Owner puts the plugin on the channel allowlist;
- `claude setup-token` works.

A token from `setup-token` can only make model requests; it is used for the workers in the
container, not for the controller.

## 7. Installation

### 7.1 With the setup assistant

```bash
git clone git@github.com:alderg/cc-voice-gateway.git
cd cc-voice-gateway
npm install
node scripts/setup.mjs
```

The assistant prints a one-time link per address of the computer. Open one in a browser on your
own network. It is a local setup over plain HTTP: the one-time token and the keys you enter travel
unencrypted. From anywhere else, use an SSH tunnel (`ssh -L 8790:localhost:8790 <server>`, then
the `localhost` link).

| Step | What the assistant does | What you give it |
|---|---|---|
| This computer | Checks Node.js, `npm install`, Claude Code (2.1.80+), git, the `gh` login, Docker, tmux, Tailscale | Fixes for what is marked as needed |
| Gateway | Port, repositories folder, runs at a time, time limit, approvals by voice | Choices |
| Models | Model and effort for the controller (`--model`, `--effort` from `start-controller.sh`) and for every worker run, on the host and in Docker | Choices, or Claude Code's defaults |
| Telegram | Checks the token (`getMe`), finds your private chat with `getUpdates` once you wrote to the bot, sends a test message | A token from [@BotFather](https://t.me/BotFather), one message to the bot |
| Workers in Docker | Checks the GitHub token and shows the level per repository with the gateway's detection. Builds the image with its progress shown. Starts the container, sets git's name and email in it, and clones the chosen repositories inside it | A token from `claude setup-token`, optionally a GitHub token ([5.6](#56-access-levels-and-their-detection)), the repositories |
| Watchdog | On Linux, writes and enables a systemd user service that starts the controller in tmux at login; or starts it now in tmux. On macOS it writes a LaunchAgent and shows the `launchctl bootstrap` command | Choices |
| Plugin | Shows whether `voice@cc-voice-gateway` is on the organisation's channel allowlist; registers the marketplace if it is; otherwise shows the admin steps | The admin |
| Finish | Writes `.secrets/` (5.10) and ends | – |

Values equal to their default are left out of `.secrets/gateway.env`, and other settings already in
it stay. Unticking Telegram deletes its two files. Options: `--host` (`0.0.0.0`), `--port` (`8790`),
`--timeout` (minutes, `30`), `--idle` (minutes, `10`), or `VOICE_SETUP_HOST`, `VOICE_SETUP_PORT`,
`VOICE_SETUP_TIMEOUT`, `VOICE_SETUP_IDLE`. Run it again to change something.

Then:

1. **Start the controller** unless the assistant did:
   `tmux new -s voice scripts/start-controller.sh`. On the first start Claude Code asks in the
   terminal for trust in the folder and consent for the MCP server from `.mcp.json`. With the
   development flag it also shows the channel warning, at every start. If the assistant started it,
   attach first: `tmux attach -t voice`.
2. **Publish the endpoint** ([7.3](#73-publishing-the-endpoint)). The connector URL is the public
   address followed by `/mcp`.
3. **Add the connector** in the Claude app: Customize → Connectors → add a custom connector, with
   the URL and sign-in. Use Claude's published OAuth client; if signing in fails with it, choose to
   register automatically. Labels vary between app versions.
4. **Pair.** Claude opens the page "Connect to Claude Code". On the computer run
   `node scripts/pair.mjs` and enter the eight-digit code within five minutes.
5. **Allow the tools.** Choose "Always allow" for the connector's tools. Otherwise voice mode stops
   for a confirmation at every call, every `get_reply` included.
6. **Try it** in voice mode: "Ask Claude Code whether the gateway is up."

### 7.2 By hand

Everything the assistant does can be done with files and commands.

**Settings:** `.secrets/gateway.env`, one `VOICE_GW_NAME=value` per line, mode 0600. The values
are in [8.7](#87-configuration). The gateway (`src/settings.mjs`) and the shell scripts
(`scripts/settings.sh`) read it line by line and never execute it. Variables set in the
environment or in `controller/.mcp.json` win.

```bash
mkdir -p -m 700 .secrets
(umask 077; printf 'VOICE_GW_WORKER_MODEL=opus\n' >> .secrets/gateway.env)
```

**Telegram:**

```bash
(umask 077; read -rsp 'Bot token: ' t; printf '%s' "$t" > .secrets/telegram_token)
# write to the bot from your Telegram account, then:
# printf is built into the shell, so the token stays off every command line (ps)
printf 'url = "https://api.telegram.org/bot%s/getUpdates"\n' "$(cat .secrets/telegram_token)" \
  | curl -s -K - | jq '.result[].message.chat | {id, type, first_name}'
(umask 077; printf '%s' '<id of your private chat>' > .secrets/telegram_chat_id)
```

Take the `id` of the chat of type `private`. A webhook on the bot makes `getUpdates` answer
`409 Conflict`; another program polling the same bot takes the updates away.

**Docker:**

```bash
folder="$HOME/docker-developer"; mkdir -p "$folder"
docker build -t cc-voice-worker --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" docker/
mkdir -p -m 700 .secrets/worker
(umask 077; read -rsp 'Claude token: ' t; printf '%s' "$t" > .secrets/worker/claude_token)
(umask 077; read -rsp 'GitHub token: ' t; printf '%s' "$t" > .secrets/worker/github_token)
VOICE_GW_DOCKER_FOLDER="$folder" scripts/start-workers-container.sh
docker exec voice-workers git clone https://github.com/<owner>/<repo>.git /repos/<repo>
docker exec voice-workers git config --global user.name "Your Name"
docker exec voice-workers git config --global user.email "you@example.com"
(umask 077; echo 'VOICE_GW_DOCKER=voice-workers' >> .secrets/gateway.env)
```

- **The Claude token** comes from `claude setup-token` on this computer.
- **The GitHub token** is optional ([5.6](#56-access-levels-and-their-detection)).
- **Clones** use `https://` addresses, since the container has no SSH keys.
  `--build-arg CLAUDE_CODE_VERSION=<version>` pins Claude Code; rebuild to update it.
- **Clean clones** for the fetch helper ([4.5](#45-pushing-from-a-read-only-container)) are
  ordinary clones from GitHub outside the folder. Your checkouts in `~/Developer` will do: the
  helper only adds refs to them.

**Autostart on Linux:** a systemd user service that runs
`tmux new-session -d -s voice <repo>/scripts/start-controller.sh` (Type=forking, with your
`PATH`), then `systemctl --user enable cc-voice-gateway.service`.

### 7.3 Publishing the endpoint

Claude's servers call the connector from Anthropic's cloud. Any tunnel or reverse proxy works that:

- serves **HTTPS on port 443** with a valid certificate (port 8443 was not reached in our tests);
- forwards **every path** to `127.0.0.1:8787`, not only `/mcp`: the sign-in uses
  `/.well-known/…` and `/oauth/…`. Do not open port 8787 itself;
- passes the **public host name** in `Host` or `X-Forwarded-Host`, and sends
  `X-Forwarded-Proto: https`: the sign-in metadata is built from them;
- allows **responses of up to a minute**, since `get_reply` waits up to 40 seconds.

**Tailscale Funnel** (tested). On Linux run `sudo tailscale set --operator=$USER` once.

```bash
scripts/funnel.sh start    # prints https://<host>.ts.net/mcp; reports when all relays answer
scripts/funnel.sh stop
scripts/funnel.sh url
```

The first start fetches a certificate; the name and all relays can take a few minutes.

**Reverse proxy**, for example Caddy, which gets a certificate and sets the headers by default:

```text
voice.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

With nginx add `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-Proto https;`.

### 7.4 Admin steps for Team and Enterprise

On claude.ai, as Owner or Primary Owner:

1. **Enable channels:** Organization settings → Claude Code → Channels, or `channelsEnabled: true`
   in the managed settings ([channels][channels-admin]).
2. **Custom connector:** on Team, only Owners and Primary Owners add it ([connectors][connectors]).
3. **Optional, the channel without the prompt.** Open
   [Organization settings → Claude Code → Managed settings](https://claude.ai/admin-settings/claude-code),
   keep what is there, and add:

   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [
       { "marketplace": "cc-voice-gateway", "plugin": "voice" }
     ]
   }
   ```

   **Before saving:** this list replaces Anthropic's default list of channel plugins for the whole
   organisation. Telegram, Discord, iMessage and fakechat from `claude-plugins-official` stop
   working as channels for every member unless the list names them too, for example
   `{ "marketplace": "claude-plugins-official", "plugin": "telegram" }`. An entry matches by name:
   whoever registers a marketplace called `cc-voice-gateway` with a plugin `voice` can load it as a
   channel, and still has to opt in per session with `--channels`.

Claude Code picks the setting up at its next start, or within an hour; `claude doctor` shows the
`Managed settings (remote)` line. Nothing is left to do on the server: the next start of the
controller uses the plugin.

## 8. Operation

### 8.1 Starting and stopping

```bash
tmux new -s voice scripts/start-controller.sh   # start, with the watchdog
scripts/start-controller.sh --status            # running?
scripts/start-controller.sh --stop              # stop session and watchdog
VOICE_GW_WATCHDOG=0 scripts/start-controller.sh # without the watchdog
```

**What the start script does:**

- **Folder and mode:** starts `claude` in `controller/` with `--permission-mode manual`.
- **Model and effort:** `--model`/`--effort` from `VOICE_GW_CONTROLLER_MODEL` and
  `VOICE_GW_CONTROLLER_EFFORT`; options given to the script come last and win.
- **The channel,** chosen by `scripts/channel-mode.mjs` before every start:
  - **plugin**, when the organisation's managed settings (`~/.claude/remote-settings.json`, or the
    managed settings file on this computer) name `voice@cc-voice-gateway` in
    `allowedChannelPlugins`. It registers this repository as the marketplace once
    (`claude plugin marketplace add <repo>`) and starts with
    `--channels plugin:voice@cc-voice-gateway`, the plugin enabled for that session only and the
    project's own `voice` server switched off. The plugin's MCP server is `src/plugin.mjs`, which
    applies the env block of `controller/.mcp.json` and starts the gateway. Tool names become
    `mcp__plugin_voice_voice__…`; `controller/.claude/settings.json` and the confine hook allow
    both forms. Your own MCP servers start too: `--strict-mcp-config` would also drop the plugin's
    server. The confine hook blocks their tools.
  - **development** otherwise: `--dangerously-load-development-channels server:voice`, with
    `--strict-mcp-config --mcp-config controller/.mcp.json`. So the gateway is the only MCP server.
    Claude Code asks at every start; answer at the terminal. `VOICE_GW_CHANNEL=plugin|development`
    overrides the choice; `node scripts/channel-mode.mjs` shows it.

Claude Code starts the gateway itself, from `controller/.mcp.json` or as the plugin's server, so
the gateway lives and ends with the session. Do not drop the user settings with
`--setting-sources`: Claude Code then reports channels as not enabled for the organisation. Your
plugins, hooks and allow rules therefore load into the controller; the confine hook blocks every
tool that is not on its list ([confinement](#53-the-controllers-confinement)).

### 8.2 The watchdog

![Watchdog](docs/watchdog.drawio.svg)

| Behaviour | Default | Setting |
|---|---|---|
| Exit code 0 or 130 (you quit, Ctrl+C) ends the watchdog; any other code or a signal is a crash | – | – |
| Health check of the gateway's `/healthz` | every 30 s | `VOICE_GW_WATCHDOG_INTERVAL` |
| Failed checks in a row (after the gateway answered once) before a restart | 3 | `VOICE_GW_WATCHDOG_HEALTH_FAILS` |
| Pause before a restart, doubled after each quick crash | 5 s, up to 300 s | `VOICE_GW_WATCHDOG_BACKOFF`, `VOICE_GW_WATCHDOG_BACKOFF_MAX` |
| A run this long starts the pause over | 600 s | `VOICE_GW_WATCHDOG_STABLE` |
| Gives up after this many restarts within the window | 5 in 1800 s | `VOICE_GW_WATCHDOG_MAX_RESTARTS`, `VOICE_GW_WATCHDOG_WINDOW` |
| One watchdog at a time | lock in `.state/controller.lock` | – |
| Log | `watchdog:` lines in `.logs/gateway.log` | – |
| Telegram on each restart and when it gives up | if the two Telegram files exist | – |

With the development flag, a restarted session waits for the channel warning to be answered at the
terminal (`tmux attach -t voice`, Enter); with the plugin it does not.

### 8.3 Restarting the controller by voice

"Controller neu starten" ("restart the controller"):

1. **The controller explains and asks.** It asks `restart_controller` what a restart would do and
   tells you, then asks: which worker runs are going, what happens to open requests, whether
   someone has to confirm at the terminal.
2. **Only after your yes** it calls `restart_controller` with `confirm`.
3. **The restart.** The gateway leaves a note for the watchdog and ends the session. The watchdog
   starts it again at once, without a pause, and does not count it as a crash.
4. **Ready message.** A Telegram message says when the controller is ready again, if Telegram is
   set up.

What survives:

- **Worker runs:** detached; the new gateway follows them and reports their results.
- **Requests:** kept in `.state/requests.json`. Answers given before the restart stay deliverable.
  An unfinished request ends with a note to say it again. A worker result the old controller had
  not answered goes to the new one again.
- **Not:** open approvals, and the old session's conversation.

Without the watchdog the controller says it cannot restart itself.

### 8.4 Voice commands

Start with "Ask Claude Code …" or "Tell Claude Code …"; within a conversation, follow-ups usually
go there without it. Any language works: the controller answers in the language of the request, in
at most three short sentences, without code, paths or lists.

| You say | What happens |
|---|---|
| "Ask Claude Code whether the gateway is up." | `ask`; an answer within seconds |
| "Tell Claude Code to wait 90 seconds and then let me know." | `send`, then `get_reply` every 25 to 40 s; interim status, then the result |
| "What is Claude Code working on?" | `status`: open requests, approvals, when the controller last answered |
| "Allow." / "Deny." | `approve` with the five-letter code |
| "Which repositories can you work in?" | `list_workers`: branch, uncommitted changes, what each worker does; in Docker the level |
| "Ask the alpha worker whether the tests pass." | `dispatch`; the controller confirms, the result follows as news |
| "Tell the alpha worker to fix the typo in the README." | The worker commits on a `voice/` branch, pushes and opens a draft pull request (in Docker: depends on the level); you hear that it is out |
| "Tell it to add a test for that too." | A follow-up in the same worker session, on the same branch |
| "What is the alpha worker doing?" | `worker_status` |
| "Stop the alpha worker." | `stop_worker` |
| "Is anyone reviewing pull request 12 in alpha?" / "Did the last CI run on main pass?" | The controller answers itself with read-only `gh` |
| "Request a review for pull request 12 in alpha." | Only on your word: the worker reviews the diff and posts a review, or adds the person you name as reviewer |
| "Fix the review comments on pull request 12." | Only on your word: the worker fixes them, runs the tests, pushes to the same branch, replies on each thread, and says what is left open |
| "Merge pull request 12 in alpha." | The controller asks back with the title and the method; after your yes, `gh pr merge` raises an approval; you confirm a second time |
| "Push it straight to main." | Only in Docker at level `full`: `dispatch` with `direct`. Otherwise the controller says why it stays a pull request |
| "Notstopp!" / "emergency stop" | The kill switch locks before anything reaches the controller ([5.9](#59-the-kill-switch)) |
| "Controller neu starten." | Restart through the watchdog after your yes ([8.3](#83-restarting-the-controller-by-voice)) |

**Your words.** The controller passes your words with every dispatch. If they are not from a voice
request of the last `VOICE_GW_DISPATCH_WINDOW` minutes, the gateway starts nothing and the
controller asks you first ([5.4](#54-approvals-by-voice)). When a worker result or a review asks
for something, the controller is told to tell you and let you decide.

**Pull requests and reviews:**

- **After a push** you hear only that the pull request is out, and which one. The controller never
  offers a review.
- **The watch.** The gateway takes the pull request URLs in a run's output and checks with `gh`
  that each is open on a `voice/` branch, comes from the repository itself (not a fork), and was
  opened by the account `gh` is logged in as. It watches those: every `VOICE_GW_PR_POLL` seconds
  (60), five times as long after 15 looks. Without a `gh` login it watches nothing. In Docker, a
  pull request opened with the container's token is watched only if that token belongs to the
  same account.
- **What becomes news:**
  - finished checks, once per push;
  - new reviews and comments, except those of the account `gh` is logged in as;
  - their text only from the repository's owner, members and collaborators. Of anyone else, which
    as a rule includes bots such as Copilot, you hear who reviewed or commented, not what;
  - you hear them as a sentence or two. The controller gets them marked `trusted="no"`.
- **When the watch stops:**
  - nothing shows up in the first five looks;
  - the pull request is merged or closed;
  - after `VOICE_GW_PR_WATCH_HOURS` (24).

A worker's checkout must not be used at the desk while it runs there: workers switch branches in
your checkouts. A worker never commits, stashes or discards changes it did not make.

### 8.5 Connections and testing at the desk

```bash
node scripts/pair.mjs                # pairing code for the sign-in page
node scripts/pair.mjs list           # connected clients and when they last called
node scripts/pair.mjs revoke <id>    # disconnect one; "revoke all" disconnects every client
node scripts/fake-voice.mjs          # play the voice AI against the local gateway
npm test                             # both ends without Claude Code or a phone
```

`pair.mjs` and `fake-voice.mjs` talk to the running gateway, so the controller must run. A
connector unused for more than 30 days must sign in again. `.logs/gateway.log` has one line per
connector call and sign-in step; it shows whether and how far the voice AI got.

### 8.6 Getting changes out of the container

See [4.5](#45-pushing-from-a-read-only-container). At levels `pr` and `full` the container pushes
by itself; the clean clone still works for trying a branch here first.

### 8.7 Configuration

Settings come from the environment, then from `.secrets/gateway.env`. Claude Code starts the
gateway, so environment variables for it go into the `env` block of `controller/.mcp.json`. The
gateway reads them at its start: restart the controller after a change.

**Gateway** (`src/config.mjs`):

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_PORT` | `8787` | Local HTTP port |
| `VOICE_GW_HOST` | `127.0.0.1` | Bind address; keep loopback |
| `VOICE_GW_SECRETS_DIR` | `.secrets` | Secrets, settings file, admin socket |
| `VOICE_GW_STATE_DIR` | `.state` | Worker state, run output, requests, pull request watches |
| `VOICE_GW_LOG_FILE` | `.logs/gateway.log` | Empty: stderr only |
| `VOICE_GW_LOG_MAX_MB` | `10` | Past this size the log moves to `gateway.log.1`, replacing the one before |
| `VOICE_GW_OAUTH_HOSTS` | `claude.ai,claude.com` | Hosts allowed in redirect addresses and client ID metadata documents |
| `VOICE_GW_PERMISSION_RELAY` | on | `0`: approvals only at the terminal |
| `VOICE_GW_PERMISSION_TTL` | `900` | Seconds before an open approval leaves the voice view |
| `VOICE_GW_DEFAULT_WAIT` | `25` | Seconds `get_reply` waits by default |
| `VOICE_GW_MAX_WAIT` | `40` | Upper limit for `get_reply` and `ask` |
| `VOICE_GW_HINT_AFTER` | `20` | Seconds without a reaction from the controller before a diagnostic hint |
| `VOICE_GW_WORKER_ROOT` | The folder holding this repository | Every git repository directly in it has a worker |
| `VOICE_GW_WORKER_SELF` | off | `1`: this repository's own checkout is a worker on this computer too |
| `VOICE_GW_DISPATCH_WINDOW` | `30` | Minutes a voice request counts for `dispatch`: only words from requests this recent start a run |
| `VOICE_GW_MAX_WORKERS` | `2` | Runs at the same time |
| `VOICE_GW_WORKER_TIMEOUT` | `60` | Minutes before a run is stopped |
| `VOICE_GW_WORKER_MODEL` | Claude Code's default | `--model` for every worker run, host and Docker |
| `VOICE_GW_WORKER_EFFORT` | Claude Code's default | `--effort`: `low`, `medium`, `high`, `xhigh`, `max` |
| `VOICE_GW_CLAUDE_BIN` | `claude` | Claude Code for workers (inside the container in Docker mode) |
| `VOICE_GW_GH_BIN` | `gh` | GitHub CLI on this computer |
| `VOICE_GW_PR_POLL` | `60` | Seconds between looks at a watched pull request |
| `VOICE_GW_PR_WATCH_HOURS` | `24` | Hours before a watch ends |
| `VOICE_GW_TELEGRAM_AFTER` | `60` | Seconds without a voice call before Telegram takes over |
| `VOICE_GW_TELEGRAM_POLL` | `25` | Seconds one poll of the bot for `/stop` waits |
| `VOICE_GW_TELEGRAM_API` | `https://api.telegram.org` | Bot API; tests use a stand-in |
| `VOICE_GW_DOCKER` | empty | Worker container; empty: workers on this computer |
| `VOICE_GW_DOCKER_REPOS` | `/repos` | The mounted folder inside the container |
| `VOICE_GW_DOCKER_BIN` | `docker` | Docker CLI |
| `VOICE_GW_ACCESS` | empty | `read-only`, `pr` or `full` for every repository; empty: detected |
| `VOICE_GW_GITHUB_API` | `https://api.github.com` | GitHub API for the level check |
| `VOICE_GW_KILL_MAX_EDITS` | `500` | Kill switch: file edits in one run |
| `VOICE_GW_KILL_MAX_FILES` | `300` | Kill switch: files changed in one run |
| `VOICE_GW_KILL_MAX_LINES` | `30000` | Kill switch: lines changed in one run |
| `VOICE_GW_KILL_ALLOW_PATHS` | empty | More folders workers may write to, comma-separated |
| `VOICE_GW_KILL_CHECK` | `30` | Seconds between checks of the default branch and, while locked, of the container |
| `VOICE_GW_MCP_JSON` | `controller/.mcp.json` | Plugin mode: where `src/plugin.mjs` reads the env block |
| `VOICE_GW_CHANNEL_SOURCE` | `voice`, or `plugin:voice:voice` as plugin | The channel's `source` in events |

**Start script and channel** (`scripts/start-controller.sh`, `scripts/channel-mode.mjs`):

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_CONTROLLER_MODEL` | Claude Code's default | `--model` for the controller |
| `VOICE_GW_CONTROLLER_EFFORT` | Claude Code's default | `--effort` for the controller |
| `VOICE_GW_WATCHDOG` | `1` | `0`: start without the watchdog |
| `VOICE_GW_WATCHDOG_INTERVAL` | `30` | Seconds between health checks |
| `VOICE_GW_WATCHDOG_HEALTH_FAILS` | `3` | Failed checks before a restart |
| `VOICE_GW_WATCHDOG_MAX_RESTARTS` | `5` | Restarts within the window before giving up |
| `VOICE_GW_WATCHDOG_WINDOW` | `1800` | The window, in seconds |
| `VOICE_GW_WATCHDOG_BACKOFF` | `5` | First pause in seconds |
| `VOICE_GW_WATCHDOG_BACKOFF_MAX` | `300` | Longest pause |
| `VOICE_GW_WATCHDOG_STABLE` | `600` | A run this long resets the pause |
| `VOICE_GW_CHANNEL` | chosen | `plugin` or `development` |
| `VOICE_GW_MANAGED_SETTINGS` | `/etc/claude-code/managed-settings.json`, on macOS `/Library/Application Support/ClaudeCode/managed-settings.json` | Managed settings file on this computer |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps `remote-settings.json` and the marketplaces |

The start script exports `VOICE_GW_CHANNEL_MODE` and `VOICE_GW_WATCHDOG_LOCK` for the gateway;
do not set them.

**Container and fetch helper** (`scripts/start-workers-container.sh`,
`scripts/fetch-from-container.sh`, `docker/`):

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_DOCKER` | `voice-workers` | The container |
| `VOICE_GW_DOCKER_FOLDER` | `~/docker-developer` | Host folder mounted at `/repos` |
| `VOICE_GW_DOCKER_IMAGE` | `cc-voice-worker` | Image |
| `VOICE_GW_DOCKER_REPOS` | `/repos` | Path inside the container |
| `VOICE_CLEAN_ROOT` | The folder holding this repository | Where the clean clones are |
| `VOICE_SECRETS` | `/run/secrets/voice` | Inside the container: where `voice-run` and the credential helper read the tokens |

**Setup assistant and Funnel** (`scripts/setup.mjs`, `scripts/funnel.sh`):

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_SETUP_HOST` | `0.0.0.0` | Bind address |
| `VOICE_SETUP_PORT` | `8790` | Port |
| `VOICE_SETUP_TIMEOUT` | `30` | Minutes at most |
| `VOICE_SETUP_IDLE` | `10` | Minutes without activity |
| `VOICE_SETUP_GIT_BIN`, `VOICE_SETUP_TMUX_BIN`, `VOICE_SETUP_SYSTEMCTL_BIN`, `VOICE_SETUP_TAILSCALE_BIN` | `git`, `tmux`, `systemctl`, `tailscale` | Commands the assistant runs; tests use stand-ins |
| `FUNNEL_PORT` | `443` | Public port of the Funnel |

### 8.8 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Connector dialog says no server answered, and nothing is in the log | The public address is not on port 443, or it was only just set up. Tailscale Funnel needs a few minutes on the first start; `scripts/funnel.sh start` reports when all relays answer. |
| Sign-in goes to an `http://` address or to the wrong host | The tunnel or proxy does not pass the public host name or `X-Forwarded-Proto: https` (see [Publishing the endpoint](#73-publishing-the-endpoint)). |
| Sign-in page says the app is not registered | The sign-in state was reset, for example because `.secrets/oauth.json` was deleted. Remove the connector and add it again. |
| Sign-in fails with Claude's published identity | Choose to register automatically instead. If the log shows `client id document not allowed: <URL>`, that host is missing from `VOICE_GW_OAUTH_HOSTS`. |
| "Wrong or expired code" | Run `node scripts/pair.mjs` again. A code lasts five minutes and one sign-in. Five wrong attempts from one browser or address, or twenty in all, burn it. |
| `pair.mjs` says the gateway is not running | Start the controller; the gateway runs inside its session. |
| The connector stopped working after weeks unused | The refresh token expired after 30 days. Sign in again from the connector's settings. |
| Claude asks before every tool call | Choose "Always allow" for the connector's tools. |
| Startup warning that channels are not enabled for the organisation | Team and Enterprise, including a Max seat in a Team organisation: an Owner enables Organization settings → Claude Code → Channels. `claude --debug` logs "the organization is team" in that case. |
| Channel event arrives, but no answer | The controller's turn failed, for example "Login expired". Look at the controller terminal; `/login` there. |
| `status` reports `controller=unconfirmed`, `get_reply` shows a hint | The session runs without the channel (neither the plugin nor `--dangerously-load-development-channels server:voice`), or the organisation blocks channels. Start it with `scripts/start-controller.sh` and check `/mcp`; otherwise Claude Code drops events silently. |
| `voice port … is in use by another process` in the log, and the same on Telegram | Another process holds `VOICE_GW_PORT`: a second controller session, or a gateway left over from an earlier session, which also answers the watchdog's `/healthz`. The new gateway ends with an error. `lsof -nP -iTCP:8787 -sTCP:LISTEN` shows the process; end it, start only one controller, then restart it. |
| Voice assistant answers itself instead of asking | Say "Ask Claude Code …" explicitly. |
| Voice assistant says the connector does not work | Look at `.logs/gateway.log`. No `voice initialize`: the request never arrived (URL, tunnel or proxy, DNS). `voice 401`: the client has to sign in again. `initialize` and `tools/list` but no `tools/call`: the assistant chose not to call a tool. |
| A repository is missing from `list_workers` | Only folders directly in the worker root with a `.git` count. Check `VOICE_GW_WORKER_ROOT`. |
| A worker fails at once | `could not start claude`: Claude Code is not on the gateway's `PATH`; set `VOICE_GW_CLAUDE_BIN`. Otherwise read `.state/tasks/<task>.err`. |
| What did a worker do? | `.state/tasks/<task>.jsonl` holds the whole run. `claude --resume <session>` in the repository opens the session; `.state/workers.json` lists the session ids. |
| A private repository is handled like a public one | `gh` is not logged in or not on the `PATH`, so the visibility is unknown, and the worker asks before pushing to be safe. |
| No news about checks or reviews on a worker's pull request | The log says why: `gh is not logged in`, or `stopped watching pull request … : nothing automatic runs` (often a draft that bot reviewers skip), `merged`, `closed` or `time limit`. Only pull requests on `voice/` branches that a run linked to are watched. `.state/pulls.json` lists the watches. |
| The controller cannot merge a pull request | A draft must be marked ready first (a task for the worker). Required reviews or checks, conflicts and other branch protection apply; `--admin` is blocked on purpose. With `VOICE_GW_PERMISSION_RELAY=0` the approval only appears at the terminal. |
| The controller says a `gh` command was blocked | Only the commands in [The controller's confinement](#53-the-controllers-confinement) pass, each with `--repo owner/name` and flags as separate words. If it does not know about `gh` at all, restart the controller so that it reads the current `controller/CLAUDE.md`. |
| The controller says a tool is blocked | Expected for every tool that is not on the confine hook's list ([confinement](#53-the-controllers-confinement)): MCP tools from your settings or plugins, subagents, skills, web access. Ask for it at the desk, or let a worker do it with `dispatch`. |
| The controller says one of its own voice tools is blocked | The gateway has a tool that the hook does not know. Add its name to `GATEWAY_TOOLS` in `controller/.claude/hooks/confine.mjs` and to the allow rules in `controller/.claude/settings.json`, then restart the controller. |
| The controller cannot write `CLAUDE.md`, `AGENTS.md`, `.mcp.json` or into a `.claude` folder | Expected, also in `playground/`: Claude Code would read them as instructions or settings. Choose another name. |
| With the development flag, Claude Code refuses `--mcp-config` or `--strict-mcp-config` at the start | Your organisation's managed settings forbid it. `disableSideloadFlags`: use the plugin instead ([Admin steps](#74-admin-steps-for-team-and-enterprise)). "An enterprise MCP config is present": the organisation's `managed-mcp.json` decides which MCP servers run; ask its admin. |
| The setup link says it is not valid or already used | The link works once, in one browser. Go on in that browser, or start `node scripts/setup.mjs` again for a new link. |
| The setup page says "Too many wrong links" | Five wrong links from one address within ten minutes, or 30 in total, block every attempt for a while. Wait, or start the assistant again. |
| The setup assistant does not start | `needs a terminal`: it shows its link only on a terminal, so run it directly, not with its output redirected. `cannot listen on …: EADDRINUSE`: choose another `--port`. |
| The setup page cannot be reached from another computer | A firewall blocks the port, or `--host` names one address only. Or use the SSH tunnel the terminal shows. |
| "Find my chat" finds nothing | Write to the bot after checking the token; Telegram keeps messages for 24 hours. A running gateway that polls the same bot takes them away: quit the controller first. |
| No Telegram message | Messages go out only after `VOICE_GW_TELEGRAM_AFTER` seconds without a voice call, and only for what the voice assistant has not picked up. `telegram fallback off` in the log: a file was missing or empty when the gateway started; fix it and restart the controller. `telegram send failed: 400 Bad Request: chat not found`: wrong chat ID, or you never wrote to the bot. `401 Unauthorized`: wrong token. |
| `The worker container voice-workers does not answer` | The container is stopped or was removed: `docker start voice-workers`, or `scripts/start-workers-container.sh`. |
| `access read-only (no GitHub token)` although there is one | It must be `.secrets/worker/github_token`, readable for the gateway. A new token counts at the next check, within ten minutes. |
| `access read-only (the token cannot see the repository (404))` | The token's repository access does not include it, or the organisation has not approved the token yet. |
| `access full` where you expected `pr` | No ruleset or branch protection requires pull requests on the default branch, or the private repository's plan has none. Protect it, or set `VOICE_GW_ACCESS=pr`. |
| `worker container …: /repos is a volume, not a host folder` or `… it runs as …` | The container was started without `-v <folder>:/repos` or without `--user "$(id -u):$(id -g)"`. Remove it (`docker rm -f voice-workers`) and start it with `scripts/start-workers-container.sh`. |
| `fetch-from-container: the container could not bundle …` | The branch does not exist in the container's repository, or the container is not running. The worker names its branch at the end of each run. |
| A worker in Docker fails at once | Claude Code is not logged in: `.secrets/worker/claude_token` is missing or expired; run `claude setup-token` again. Otherwise read `.state/tasks/<task>.err`. |
| `dispatch=locked`, `[state=locked]` or an `[ALARM]` line | The kill switch is locked; the alarm names the trigger. `node scripts/unlock.mjs --status` shows it, `node scripts/unlock.mjs` at the server unlocks it. |
| `dispatch=origin` | In the container, the repository's `origin` is no longer the GitHub repository the gateway saw first ([5.6](#56-access-levels-and-their-detection)). Check the clone at the desk; if the change is wanted, stop the controller and remove the repository's line under `origins` in `.state/workers.json`. |
| The kill switch locked for no good reason | Read the reason. A rule that misfires: raise its `VOICE_GW_KILL_*` threshold, or add a folder to `VOICE_GW_KILL_ALLOW_PATHS`. |
| `/stop` on Telegram does nothing | Only your configured private chat counts, and the gateway must poll the bot: the log says `telegram commands: …` if a webhook or another program takes the updates. |
| No approval by voice | Expected for Bash, Write and Edit: they run without asking. For other tools: the session runs in auto or bypass mode, an allow rule covers the tool, or it is a trust or consent dialog, which is not relayed. Start the session with `scripts/start-controller.sh`. |
| The controller still starts with the development flag after the admin step | The log line `channel: the development flag, since …` says why. `node scripts/channel-mode.mjs` checks again; Claude Code fetches the organisation's settings at its start, so start any `claude` once (or wait an hour). `claude doctor` shows whether the managed settings arrived. |
| "Controller neu starten" and the controller says it cannot restart itself | It was not started by `scripts/start-controller.sh` with the watchdog. Restart it at the computer. |
| Voice requests stop arriving after a crash | The watchdog started the session again, and the development-channel warning waits: `tmux attach -t voice`, then Enter. `grep watchdog .logs/gateway.log` shows what happened. |
| `the controller is already running (watchdog …)` | A watchdog runs already, for example in another tmux window. `scripts/start-controller.sh --status`; `--stop` ends it. |
| `watchdog: giving up …` | The session kept crashing, for example because the login expired. Look at the controller terminal, fix the cause, and start it again. |

Claude Code's debug log is at `~/.claude/debug/<session-id>.txt`.

## 9. Repository layout

```text
src/
  gateway.mjs        entry point: wires both sides, exits with the session
  channel.mjs        stdio side: channel, reply and worker tools, permission relay
  voice.mjs          HTTP side: the voice tools
  oauth.mjs          sign-in: OAuth metadata, registration, pairing page, tokens
  workers.mjs        workers: repositories, claude -p runs, results
  runners.mjs        where workers run: this computer, or the Docker container
  access.mjs         access levels in the container, from the GitHub token
  pulls.mjs          the watch on pull requests that workers open
  telegram.mjs       Telegram fallback, and /stop from your chat
  killswitch.mjs     the kill switch: state, emergency phrases, alarm
  guard.mjs          the kill switch's rules on the workers' runs
  restart.mjs        restarting the controller by voice, through the watchdog
  plugin.mjs         the gateway as the MCP server of the plugin voice@cc-voice-gateway
  store.mjs          requests and approvals, persisted across restarts
  admin.mjs          Unix socket for pair.mjs, unlock.mjs and fake-voice
  config.mjs         settings from the environment and .secrets/gateway.env
  settings.mjs       reads and writes .secrets/gateway.env
  setup/             the setup assistant: server.mjs (guard), actions.mjs (steps), ui/ (page)
  http.mjs, log.mjs  small HTTP helpers; log to stderr and file, never stdout
controller/
  .mcp.json          starts the gateway as the server "voice"
  .claude/settings.json        allow and deny rules, the hook
  .claude/hooks/confine.mjs    the controller's confinement
  CLAUDE.md          the controller's instructions
  playground/        the one folder the controller writes to
.claude-plugin/      this repository as the marketplace cc-voice-gateway, with the plugin voice
docker/              Dockerfile, voice-run, voice-stop, git-credential-voice
scripts/
  setup.mjs                    the setup assistant
  start-controller.sh          controller with its channel, under the watchdog
  channel-mode.mjs             plugin or development flag
  settings.sh                  .secrets/gateway.env for the shell scripts
  start-workers-container.sh   the worker container; read-only while locked
  fetch-from-container.sh      a branch from the container into a clean clone, as a bundle
  unlock.mjs                   unlock the kill switch, at the server only
  pair.mjs                     pairing codes, connections
  funnel.sh, check-public.mjs  Tailscale Funnel, and a check through its relays
  telegram-notify.mjs          one Telegram message, for the watchdog
  fake-voice.mjs               play the voice AI at the desk
test/                one file per area; npm test runs them all, with stand-ins for Claude Code,
                     gh, docker, the GitHub API and Telegram
docs/
  *.drawio.svg       the diagrams, made with draw.io
  index.html         the product page (GitHub Pages, from this folder)
  assets/            the video, its poster, the README thumbnail, the dark architecture diagram
video/               the video's sources: script.json (voiceover), slides.html (frames), build.mjs
```

## 10. Sources

- [Claude Code: channels][channels], [channels reference][ref], [enterprise controls][channels-admin]
- [Claude Code: Remote Control][rc], [authentication and setup-token][auth], [sandboxing][sandbox],
  [permissions][perm]
- [Claude Help Center: voice mode][voice], [custom connectors][connectors]
- [MCP authorisation][mcpauth], [Tailscale Funnel][funnel]
- [carcode][carcode], [DashVox][dashvox], [VoiceMode][voicemode], [Claude on CarPlay][carplay]
- [talk-to-claude-code][t2cc]: the model for polling and voice-friendly tool results
- GitHub: [fine-grained tokens][pat-fine], [classic tokens][pat-classic],
  [personal access tokens][pat], [rulesets][rulesets]
- Claude Code release notes: [2.1.80][rel-80] (channels), [2.1.81][rel-81] (permission relay),
  [changelog][changelog] (2.1.84: `allowedChannelPlugins`)

[channels]: https://code.claude.com/docs/en/channels
[channels-admin]: https://code.claude.com/docs/en/channels#enterprise-controls
[ref]: https://code.claude.com/docs/en/channels-reference
[rc]: https://code.claude.com/docs/en/remote-control
[auth]: https://code.claude.com/docs/en/authentication
[perm]: https://code.claude.com/docs/en/permissions
[sandbox]: https://code.claude.com/docs/en/sandboxing
[voice]: https://support.claude.com/en/articles/11101966-use-voice-mode
[connectors]: https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
[mcpauth]: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
[funnel]: https://tailscale.com/docs/reference/tailscale-cli/funnel
[t2cc]: https://github.com/osaighi/talk-to-claude-code
[carcode]: https://github.com/Harsh-Rastogi-03/carcode
[dashvox]: https://apps.apple.com/app/dashvox/id6762529006
[voicemode]: https://github.com/mbailey/voicemode
[carplay]: https://www.macrumors.com/2026/09/04/anthropics-claude-is-coming-to-carplay/
[pat-fine]: https://github.com/settings/personal-access-tokens/new
[pat-classic]: https://github.com/settings/tokens/new?scopes=repo&description=cc-voice-gateway
[pat]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
[rulesets]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
[rel-80]: https://github.com/anthropics/claude-code/releases/tag/v2.1.80
[rel-81]: https://github.com/anthropics/claude-code/releases/tag/v2.1.81
[changelog]: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
