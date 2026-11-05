# cc-voice-gateway

**Claude Code, by voice.** Talk to Claude in the Claude app's voice mode, in the car, on a walk
or at your desk, and Claude Code sessions on your own computer do the work: answer questions about
your repositories, change code, push branches, open, review and merge pull requests. Plain
JavaScript (ESM, Node.js), no build step.

This README is the technical documentation. What it is for, in a two-minute video, is on the
[product page](https://alderg.github.io/cc-voice-gateway/).

[![Video: cc-voice-gateway, Claude Code, by voice](docs/assets/video-thumbnail.jpg)](https://alderg.github.io/cc-voice-gateway/#video)

| | What it does | Details |
|---|---|---|
| **Voice control** | Claude's voice mode, through a custom MCP connector, as the front end of Claude Code: in the car with CarPlay or Android Auto, on the phone, or at the desk next to mouse and keyboard. Answers are written to be heard; approvals by voice | [Overview](#1-overview), [voice commands](#84-voice-commands) |
| **Three layers of AI** | The voice AI (Claude voice mode) hands each request to the controller, a Claude Code session on your computer reached through a channel. The controller keeps the context, dispatches workers (headless `claude -p` runs) and sums up their results. The gateway in between has no AI of its own | [Overview](#1-overview), [architecture](#41-architecture) |
| **Parallel workers** | Several repositories at once, several runs per repository in git worktrees of their own, a queue that survives restarts, work folders for tasks without a repository; on this computer or in Docker | [Workers](#55-workers-on-this-computer-or-in-docker), [several runs](#several-runs-per-repository), [work folders](#work-folders) |
| **It comes back to you** | Results as spoken news; approval requests on Telegram at once, questions once the call has ended, and if you turn it on, questions and approvals answered there by Reply and requests written there as to the controller itself, with its replies in the chat; pull requests watched, review comments fixed automatically; open items and reminders; the controller in the Claude app with Remote Control | [Telegram](#58-the-telegram-fallback), [open items](#84-voice-commands), [review fixes](#automatic-fixes-for-review-comments), [Remote Control](#remote-control-from-the-claude-app) |
| **Safe by design** | Pull requests on `voice/` branches; a merge after your yes and an approval; workers only on your own words; Docker access levels set by the GitHub token; a confined controller; a kill switch in code; sign-in with a pairing code, `/mcp` only from Anthropic's addresses | [Security design](#5-security-design) |

> [!WARNING]
> **Driving comes first.** When you use this in the car, keep your full attention on the traffic,
> not on the conversation or the work. It is built so that you can, at any moment: open items and
> unanswered questions are kept, and when you come back, ask for the status and everything is
> listed, brought up to date and followed up.
>
> **Use at your own risk.** Follow the traffic rules and laws where you drive, including those on
> phone use. The authors accept no liability for accidents, injuries or damage of any kind arising
> from its use; see also sections 7 and 8 of the [licence](LICENSE).

> **Provided as-is, as a prototype.** This is solely a prototype of an idea: a way to use Claude
> Code from Claude's voice mode, which cannot reach Claude Code on its own. It comes without
> warranty and without support, and there is no communication of any kind about this project: no
> announcements, no support, no answers to issues or messages. It is not an Anthropic product.
>
> Used with Claude voice mode in the Claude app, on the phone and in the car with CarPlay or Android
> Auto; tested so far only on the iPhone and with CarPlay. Claude Code channels are a research
> preview; their flags and protocol may change.

Licensed under the [Apache License 2.0](LICENSE).

## Getting started

From a clone to the first voice request, on a computer with the [prerequisites](#6-prerequisites):
Node.js 20 or later, Claude Code logged in with claude.ai, `gh` logged in, tmux and Tailscale. On
Team and Enterprise an Owner first does the [admin steps](#74-admin-steps-for-team-and-enterprise).
Linux or macOS ([install and test on a Mac](docs/macos.md)); on Windows, inside WSL.

1. **Clone the repository** with the GitHub CLI:

   ```bash
   gh repo clone alderg/cc-voice-gateway && cd cc-voice-gateway
   ```

   You are in the new folder `cc-voice-gateway`.

2. **Install the dependencies:**

   ```bash
   npm install
   ```

   95 packages land in `node_modules`; nothing is compiled ([what it installs](#6-prerequisites)).

3. **Run the setup assistant,** a temporary web server on this computer that writes the
   configuration files and then helps you connect the Claude app. Without it, the gateway runs with
   its defaults.

   ```bash
   node scripts/setup.mjs
   ```

   It prints a one-time link per address of this computer, `http://<address>:8790/?t=<token>`. Open
   one in a browser on your own network, since it is plain HTTP; from elsewhere use an SSH tunnel.
   The page writes `.secrets/gateway.env`, plus Telegram, Docker workers and the autostart if you
   choose them ([7.1](#71-with-the-setup-assistant), [files](#510-secrets-and-files)). Tick "Start
   it now" in its section 7, and leave "keep this page open" ticked in section 9: after writing,
   the assistant stays up, and its section 10, "Connect the Claude app", goes with you through
   steps 4 to 7, with the connector URL and the pairing code. No second terminal is needed for them.

4. **The controller** runs in the tmux session `voice` once the assistant started it; without the
   assistant, start it yourself. It comes before the funnel and the pairing code: Claude Code starts
   the gateway inside it, and both need the running gateway.

   ```bash
   tmux new -s voice scripts/start-controller.sh
   ```

   Claude Code opens in `controller/`, and until it is through its questions at the terminal, the
   gateway does not start. Its folder trust question does not come: the setup assistant and the
   start script mark `controller/` as trusted in Claude Code's config beforehand
   ([8.1](#81-starting-and-stopping)). With the development flag, the channel warning comes at
   every start: attach with `tmux attach -t voice`, press Enter, and detach with Ctrl-b, then d.
   Should Claude Code ask "Is this a project you created or one you trust?" all the same, press the
   down arrow once to "Yes, I trust this folder", then Enter: Enter alone picks "No, exit". While
   the assistant runs, its own terminal is busy: attach from another one on this computer, or over
   SSH. While the tmux session runs and the gateway does not answer, section 10 of the page says
   how, names the question when it sees it in the tmux session, and notices by itself when the
   gateway is up.

5. **Start the funnel:** "Start the Funnel" in section 10 of the page, or at the computer:

   ```bash
   scripts/funnel.sh start
   ```

   On Linux, run `sudo tailscale set --operator=$USER` once before; the macOS app needs nothing.
   Either way it reports when all Funnel relays answer, which can take a few minutes the first
   time, and prints the connector URL `https://<host>.ts.net/mcp`, which the page then shows too.
   A browser on this computer may not reach the gateway under that URL, on a Mac with the Tailscale
   app or where another web server holds port 443 here; the Claude app does. Section 10 of the page
   checks it once the Funnel is on, and then offers "Prepare the sign-in on this computer", or sign
   in from another device ([known issues](#810-known-issues)).
   The URL holds no secret; the sign-in needs the pairing code from step 7. Without Tailscale, any
   HTTPS address on port 443 that forwards to `127.0.0.1:8787` will do
   ([7.3](#73-publishing-the-endpoint)).

6. **Add the connector in Claude Desktop:** Customize → Connectors → add a custom connector, with
   the URL from step 5. Use Claude's published OAuth client; if signing in fails with it, choose to
   register automatically ([5.2](#52-the-voice-endpoint-and-oauth)). Labels vary between app
   versions.

   Claude opens the sign-in page "Connect to Claude Code", which asks for a pairing code.

7. **Get the pairing code:** "Show a pairing code" in section 10 of the setup page. It shows an
   eight-digit code for the sign-in page with a countdown, valid for ten minutes and one sign-in;
   "New code" replaces it, and the page says when a client signed in with it. Without the page, at
   the computer:

   ```bash
   node scripts/pair.mjs
   ```

   It prints a code valid for five minutes, or up to ten with `--minutes 10`
   ([5.2](#52-the-voice-endpoint-and-oauth)). Then choose "Always allow" for the connector's tools,
   or voice mode asks at every call. Last, "End the assistant" on the page; otherwise it ends by
   itself after ten minutes without activity.

Then try it in voice mode with the same account: "Ask Claude Code whether the gateway is up."

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
  `emergency_stop`, `unlock`) during a voice conversation, after an OAuth sign-in with a pairing
  code from your computer.
- **Towards Claude Code:** a [channel][channels], an MCP server that pushes each voice request into
  a running Claude Code session, the **controller**. The controller answers through the channel's
  `reply` tool. By default it may read its own folder and the status of pull requests, and does no
  repository work itself; two higher [levels](#53-the-controllers-confinement) let it also clone
  and delete, or do everything. At every level it does only quick lookups itself and hands anything
  longer off at once, several jobs side by side, to a worker, a work folder, or at `unrestricted` a
  subagent in the background, so that it stays free for your next request.

Work in a repository goes to a **worker**: a headless `claude -p` run in that repository, started
by the gateway when the controller calls `dispatch`. One run per repository, two at a time by
default; with a higher limit per repository, further runs work next to the first in
[git worktrees of their own](#several-runs-per-repository). Workers run in your checkouts, or in a Docker container whose GitHub token sets what they
may publish: nothing, pull requests, or also a direct push to the default branch. A worker's
result reaches the controller as a channel event; the controller summarises it, and you hear it
as news in the voice conversation. If it asks you something after the conversation has ended,
the question also goes to Telegram. Optionally, a task that needs no repository, such as a
question to look up, a calculation or a draft, gets a [work folder](#work-folders) of its own, on
this computer or in a container.

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

The goal: talk to Claude, for example while driving, and have real work done in your
repositories, with results and questions coming back by voice, without touching a screen.

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
| Telegram as an optional fallback for what needs you | Voice assistants only poll. Once you hang up, a question or an approval would wait until the next conversation, and Claude Code waits on an approval. Results can wait; they stay off Telegram |
| Docker with access levels derived from the GitHub token | Host workers run as you, with your logins. A container with a scoped token limits what a run can reach and publish |
| Changes out of a read-only container as a git bundle into a clean clone | Fetching from the container's folder would run git with config that the container controls |
| A kill switch in the gateway's code | A lock that does not depend on the controller following instructions |
| A watchdog, and the channel as an allowlisted plugin | The session has to come back after a crash without someone at the terminal. With the development flag, Claude Code asks at every start; an organisation allowlist is the supported way around it |
| A setup assistant | Many keys, files and steps; a page with a guide per field is less error-prone than a long manual |

Things that did not work and were replaced:

- **Claude Code's Bash sandbox** for the controller: on Ubuntu 24.04 and later, AppArmor's
  `bwrap-userns-restrict` profile stops it from starting ([sandboxing][sandbox]). A PreToolUse hook
  with a command allowlist confines the controller instead.
- **Tailscale Funnel on port 8443:** Funnel serves it publicly, also with a valid certificate, but
  claude.ai's connector did not connect to it in our tests ("no server answered", and no request
  in the log); port 443 works.
- **Another web server's port 443 on the gateway's computer limited to 127.0.0.1:** the Tailscale
  app on macOS still did not take 443 on the tailnet address
  ([known issues](#810-known-issues)).
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
| **cc-voice-gateway** | Claude's voice mode in the Claude app, through a custom MCP connector | A running Claude Code session (channel), which dispatches headless workers | Your computer; workers optionally in Docker | CarPlay or Android Auto, wherever the Claude app's voice mode runs; tested with CarPlay | This repository, Apache 2.0 |
| [carcode][carcode] | Siri: a Siri Shortcut ("Hey Siri, Jarvis") on the iPhone | The Claude Code CLI on your Mac, with your login | Your Mac, reached through a Cloudflare quick tunnel; the server can run on Linux, the Shortcut needs macOS once | CarPlay, through Siri | Open source, MIT |
| [DashVox][dashvox] | Its own iPhone app, with CarPlay and Apple Watch | Claude Code, Claude Cowork, Codex or another CLI, over SSH on your machines | Your machines; the app's backend is DashVox Cloud or self-hosted | CarPlay | App free, with a paid tier; source code unverified |
| [VoiceMode][voicemode] | Microphone and speakers of the computer; speech recognition and output local (Whisper.cpp, Kokoro) or through OpenAI-compatible services | Claude Code itself, as an MCP server or plugin | Your computer | None documented | Open source, MIT |
| [Claude Code Remote Control][rc] | None: the Claude app and claude.ai offer dictation, not voice mode, for Claude Code ([voice mode][voice]) | A local Claude Code session, from claude.ai/code or the Claude app | Your computer, outbound HTTPS only, no inbound port | No | Anthropic. Pro, Max, Team, Enterprise; on Team and Enterprise an Owner enables it |
| Claude for Android Auto | Unverified: no official or third-party Claude app for Android Auto was found | – | – | – | – |

For the car itself, the Claude app supports CarPlay ([MacRumors, 2026-09-04][carplay]); this
project uses whatever voice mode the app offers there. Nothing in it is specific to CarPlay, so
Android Auto should work the same where the app offers voice mode; so far it was tested only with
CarPlay.

What this project adds over the others:

- **Claude is the voice.** No Siri phrase, no speech pipeline of its own. The same assistant that
  understands you also decides what to hand to Claude Code, and reads back a short answer in your
  language.
- **A controller and workers.** One conversation drives a persistent session that knows what you
  asked before, and several repositories at once. Results arrive later as news; questions from a
  worker come back to you.
- **Approvals and merges by voice.** Claude Code's approval prompts reach the conversation. A merge
  needs your yes and then an approval ([confinement](#53-the-controllers-confinement)), by voice or,
  if you turn Telegram input on, in your Telegram chat.
- **Telegram**, optional: approval requests at once, questions after the call, and alerts, and if
  you turn it on, requests, answers and approvals you write there, push, merge, restart and delete
  included, unless you keep those with your voice.
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

The product page follows the system's light or dark setting. In dark mode it shows a copy of the
architecture diagram exported with draw.io's dark theme. After changing the diagram, export that
copy again:

```bash
drawio -x -f svg --theme dark -o docs/assets/architecture-dark.svg docs/architecture.drawio.svg
```

`drawio` is the command line of the draw.io desktop app; on macOS it is
`/Applications/draw.io.app/Contents/MacOS/draw.io`.

### 4.1 Architecture

See the diagram in the [Overview](#1-overview). The gateway is the only own code at run time;
everything blue is Claude Code.

### 4.2 A request

![Flow of a request](docs/request-flow.drawio.svg)

The voice AI calls `send` and then `get_reply` until the state is `done`. Before `send` or `ask`
it says one short line in your language that fits the request and names what it is about, in its
own words each time: a task is on its way, a question goes to Claude Code. The descriptions of
`send` and `ask` give two examples each, such as "Ich gebe den Abgleich der Branches an Claude Code
weiter", and no fixed phrase, since you may speak any language. `send` returns at once, and its
result says to go straight on with `get_reply` after such a line; `ask` waits only briefly for a
quick answer, 8 seconds by default (`VOICE_GW_ASK_WAIT`), since you hear nothing more until it
returns. Between polls the voice AI says in a few words that it is still running, and before
`approve` it confirms your decision. It never stays silent: in a car silence sounds as if you were
not heard, so the instructions ask for at least a short okay after everything you say, and the
result of `send` asks for one if it has not acknowledged the request yet. A beep would not do, since
it sounds like an error.

This is the approach of 31 October, with which the voice AI said varied, fitting things. On
1 November the texts asked it first to say nothing before `send`, naming the filler to avoid, and
then to begin its reply with the tool call; both times it filled the moment before the call with
the same stock phrase, so the texts are back to asking for a line of its own there. No text of the
connector names a phrase to avoid, in any language, and the tests check that: a filler named in the
voice assistant's instructions or in its memory on claude.ai, even as a prohibition, makes it more
likely to say it.

Every result that ends a request, the answer, a question back from Claude Code and the answer of
`status` with any news it brings, ends with one line for the voice AI about your next request, not
to be read out: "For the user's next request (not to read out): before send or ask, say its subject
in a few of their own words and that it goes to Claude Code, e.g. „Die Tests in alpha, geht an
Claude Code“." Results while a request still runs, results that list an open approval, `status`'s
included, `approve`, the emergency stop and `unlock` have none, as what you say next there is no new
request.
The line is there because claude.ai fetches the connector's instructions and tool descriptions only
when it connects, with `initialize` (a `voice initialize client=Anthropic/ClaudeAI/…` line in
`.logs/gateway.log`, every two to four hours), not with each voice chat, while it follows a tool
result at once and almost word for word: a fixed phrase in `send`'s result on 1 November was heard
right away. So try a change to what the voice AI says in the results first, which the next call in
the car shows; one in the instructions or descriptions shows only after the next connect. The
instructions and descriptions stayed as they were with this line, so that its effect can be told
apart in the car.

Every result starts with a machine-readable line, for example `[state=working id=k7f3 elapsed=34s]`.
Requests and approvals have these states:

![States](docs/states.drawio.svg)

### 4.3 Setup

![Setup assistant](docs/setup.drawio.svg)

### 4.4 Variants

![Variants](docs/variants.drawio.svg)

| Variant | Turned on by | Effect |
|---|---|---|
| Voice only | default | News reaches you when the voice AI calls |
| Voice + Telegram | `.secrets/telegram_token` and `.secrets/telegram_chat_id` | Approval requests go to Telegram at once; after 10 minutes without a voice call, questions too; results wait for the next call. With Telegram input on (off by default), a message there is a request or an answer, with the controller's replies back in the chat. `/stop` locks the kill switch |
| Workers on this computer | default (`VOICE_GW_DOCKER` empty) | Runs in your checkouts as you |
| Workers in Docker | `VOICE_GW_DOCKER=<container>` | Runs in the container; the level per repository comes from its GitHub token, or from `VOICE_GW_ACCESS` |
| Work folders | `VOICE_GW_SCRATCH=1`; off by default | Tasks without a repository run in a new empty folder each, on this computer as you ([work folders](#work-folders)) |
| Work folders in a container | also `VOICE_GW_SCRATCH_DOCKER=<container>` | Those runs in a container of their own that sees only the work folders, with no GitHub token |

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
| Anyone on the internet | Reach the sign-in page; get a line in the log, and for anything suspicious a message on Telegram | Reach `/mcp` from outside Anthropic's addresses; call a tool without a token; get a token without a pairing code from your computer |
| A signed-in voice client | Send requests, read answers, answer approvals, lock the kill switch; with Telegram set up, unlock it with the PIN that comes to your Telegram chat ([5.9](#59-the-kill-switch)) | Unlock the kill switch without that PIN, after three wrong ones, in a standby or without Telegram; reach the controller's tools directly |
| The controller, level `confined` (default) | Read `controller/`, write `controller/playground/`, read pull request and CI status, merge after an approval, dispatch workers with your words from a recent voice request, raise the alarm | Start a worker on words that only a worker result or a pull request brought in (see 5.4); anything else (see 5.3) |
| The controller at `clone-delete` | As at `confined`; also clone GitHub repositories into the worker root and delete files and folders there, each deletion after its plan, your words and an approval | Delete outside the worker root, the gateway's own checkout, or in a repository while its worker runs |
| The controller at `unrestricted` | Everything your user can: any command, any file, `.secrets/` included, the web, subagents; your MCP servers and connectors after an approval | Nothing is blocked; a merge in the strict form and a confirmed `delete_path` still ask (see 5.3) |
| The controller with Claude in Chrome (only at `unrestricted`) | Everything the Chrome profile is signed in to: open sessions and logins on any site, and what a password manager in that profile fills in ([the warning](#claude-in-chrome)) | Nothing more is blocked by the gateway |
| Whoever is signed in to your claude.ai account, with Remote Control on | Follow the controller in the Claude app or at claude.ai/code, type to it, answer its approvals, stop its turn, switch it between Manual, Accept edits and Plan ([Remote Control](#remote-control-from-the-claude-app)) | Start a worker, clone or delete by typing (see 5.4); lift the confinement; see or steer the workers' runs |
| A worker on this computer | Everything your user can, without approvals | Nothing is blocked; rules only observe (see 5.9) |
| A worker in Docker | The mounted folder, the container's tokens, the network | Your other files, SSH keys, `gh` login; more on GitHub than its token allows |
| A run in a work folder on this computer | Everything your user can, without approvals; the rules allow writes only in its folder | Nothing is blocked; rules only observe, as for any worker |
| A run in a work folder in its container | The work folders, Claude Code's token, the network | Your other files, SSH keys, `gh` login, the repositories, any GitHub token |
| Others on GitHub | Comment on a watched pull request: the news names them; the text of the repository's owner, members and collaborators reaches the controller, marked `trusted="no"` | Get anyone else's text to the controller through the watch; have a fork or someone else's pull request watched (see 8.4) |
| The Telegram chat | Receive questions, approval requests, alerts and the PIN for unlocking in voice mode; send `/stop`; turn the Funnel on and off; with Telegram input on (off by default), answer an open question by Reply or with its code, push, merge, restart and delete included, answer an approval request with yes or no, and send the controller a request, which counts as one by voice and can start workers ([5.8](#58-the-telegram-fallback)) | Unlock (a PIN typed there counts for nothing); with `VOICE_GW_TELEGRAM_CONFIRM=0`, approve, or settle or confirm a push, merge, restart or delete; pass anything on while the kill switch is locked or the gateway is inactive; groups, other senders, bots, forwarded and edited messages count for nothing |

### 5.2 The voice endpoint and OAuth

- **Binding and exposure.** The gateway listens on `127.0.0.1` only (`VOICE_GW_HOST`). A tunnel or
  reverse proxy publishes it at HTTPS on port 443. A certificate from a public authority, Tailscale
  Funnel's included, puts the host name into the certificate transparency logs, and scanners find it
  within hours.
- **`/mcp` only from Anthropic's addresses** (`src/ipguard.mjs`). Claude voice mode calls the
  connector from Anthropic's servers, which use the published range `160.79.104.0/21`. A request to
  `/mcp` that came through the tunnel from anywhere else gets a 403 before its token is looked at.
  The address is the last `X-Forwarded-For` entry, the one the tunnel set; Tailscale Funnel also
  marks its requests with `Tailscale-Funnel-Request`. Programs on this computer that call without
  `X-Forwarded-For`, such as `scripts/fake-voice.mjs`, pass. Other ranges, or none:
  `VOICE_GW_MCP_ALLOW` ([8.8](#88-configuration)). The sign-in pages stay open to every address:
  you sign in from your own browser.
- **Every request in the log**: one line with the caller's address, `funnel`, `proxy` or `local`,
  the method, the path without its query, and the status. Only the watchdog's local `/healthz`
  checks are left out.
- **Alerts on Telegram**, if it is set up: a request to `/mcp` from outside the range; one from
  Anthropic's addresses without a valid token (you connecting the connector, or someone else's
  Claude account that found the address); a sign-in without a valid pairing code, a wrong code, too
  many wrong codes, a burnt code; and every successful sign-in, with the client's name. Each names
  the address. An expired token of a known connection, the hourly refresh, is only logged.
  Throttled: one message per kind and address in 15 minutes, six an hour in all; what is held back
  is counted in the next message, or in a summary once messages may go out again. A successful
  sign-in always goes out. Where Telegram's `/funnel off` works (Telegram set up, and
  `scripts/funnel.sh` answers), the suspicious-activity alert about a request from outside the range
  and the summary of more suspicious requests end with "Send /funnel off to take the gateway off the
  internet."; `/funnel off` from your chat removes the Funnel, `/funnel on` brings it back.
- **The gateway is its own OAuth server.** OAuth metadata, dynamic client registration, client ID
  metadata documents, and the authorisation code flow with PKCE (S256).
- **Redirect addresses** must be HTTPS on `claude.ai` or `claude.com` (`VOICE_GW_OAUTH_HOSTS`), or
  a loopback address.
- **Sign-in needs a pairing code** from your computer: on the setup assistant's page
  ([5.11](#511-the-setup-assistant)), or from `node scripts/pair.mjs`. Eight digits, valid for one
  sign-in: ten minutes from the page, five from `pair.mjs` (`--minutes` up to ten, never more).
  Only one code is valid at a time; a new one replaces the one before, wherever it came from. Five
  wrong attempts lock out the client and the address they came from (the last `X-Forwarded-For`
  entry, set by the tunnel), so a stranger cannot burn your code; twenty wrong attempts in all burn
  it.
- **Tokens.** Access tokens last one hour. The refresh token rotates on every use and expires after
  30 days. Local tokens for `scripts/fake-voice.mjs` last 12 hours.
- **Stored as hashes only:** tokens, codes and client secrets are stored as SHA-256 hashes in
  `.secrets/oauth.json`.
- **Revocation:** `node scripts/pair.mjs list`, `revoke <id>`, `revoke all` at the computer; a
  connector may revoke its own token at `/oauth/revoke` (RFC 7009), which the sign-in metadata names.
  Either, once no connector is left, switches the gateway to standby
  ([standby](#several-gateways-and-the-standby-after-a-disconnect)).
- **The admin socket** `.secrets/admin.sock` (pairing, unlocking) is a Unix socket in a folder
  with mode 0700. `pair.mjs` and the setup assistant, run as the same user, ask it for codes.

### 5.3 The controller's confinement

`VOICE_GW_CONTROLLER_LEVEL` sets how far the controller may go. The setup assistant offers it, with
a warning for the two levels above the default:

| Level | What the controller can do | Warning |
|---|---|---|
| `confined` (default) | What the rest of this section describes: answer, dispatch workers, read pull request status, merge after an approval | – |
| `clone-delete` | The same, plus `clone_repo` and `delete_path` (below) | Whoever can talk to the connector can have repositories cloned, and files and folders in the worker root deleted, whole repositories with work that exists nowhere else included. Whoever can call the connector also gives the approval for each deletion. A deletion cannot be undone |
| `unrestricted` | Everything your user can: the hook lets every tool through, and the start script passes allow rules instead of deny rules. Tools of other MCP servers and claude.ai connectors still ask, by voice | Whoever can talk to the connector can run any command as you, read and change any file (`.secrets/`, SSH keys and logins included) and reach the web. Text that a worker result or a web page brings in can steer a session that can do everything, and the kill switch's rules watch only the workers. Only on a computer or VM you can afford to lose |

**Claude in Chrome** (`VOICE_GW_CONTROLLER_CHROME=1`) gives the controller a browser, and with it
whatever that browser profile is signed in to. Its tools pass the confine hook only at
`unrestricted`; below it, `--chrome` loads them and the hook blocks them. Read
[the warning](#claude-in-chrome) before turning it on.

Above `confined`, the start script also tells the session its level with
`--append-system-prompt`, since `controller/CLAUDE.md` describes the confined working area. The
level counts from the next start of `scripts/start-controller.sh` (`--stop`, then start again); an
unknown value counts as `confined`. At no level does the session run in bypass mode or
with `--dangerously-skip-permissions`.

**Cloning and deleting** (`src/folders.mjs`), at `clone-delete` and `unrestricted`, with workers
on this computer only:

- **`clone_repo`** runs `gh repo clone` with your `gh` login, for `owner/name` or a name of your
  own, into the worker root, in the background. The result arrives as a channel event, and you
  hear it as news. A failed clone leaves nothing behind; the kill switch ends one that is going.
- **`delete_path`** takes a path relative to the worker root. Without `confirm` it deletes nothing
  and says what would be lost: files, size, uncommitted changes, commits on no remote, stashes.
  With `confirm` it deletes only a path planned in the last 15 minutes, and the confine hook
  answers "ask": Claude Code raises an approval that the channel relays. So, as for a merge, your
  yes and then the approval, each by voice or, with Telegram input on, in your Telegram chat.
- **Never:** outside the worker root (the folder a path sits in is resolved through symlinks; a
  link is deleted, not its target), the gateway's own checkout or a folder that holds it, a
  repository while its worker runs or a clone is going.
- **Both** need your words from a recent voice request, as `dispatch` does
  ([5.4](#54-approvals-by-voice)), and do nothing while the kill switch is locked.

At the levels `confined` and `clone-delete`: the controller runs without approvals for its few tools, since whoever can reach it could answer
approvals anyway. Its limits are enforced by a PreToolUse hook, `controller/.claude/hooks/confine.mjs`.
A hook that exits with code 2 blocks a call before any permission rule or prompt. The hook sees
every tool call (matcher `*`) and blocks every tool that is not on its list. It resolves symlinks
and fails closed.

| Tool | Allowed |
|---|---|
| The gateway's tools | `reply`, `list_workers`, `dispatch`, `worker_status`, `stop_worker`, `open_items`, `resolve_decision`, `stats`, `restart_controller`, `raise_alarm`, and above `confined` `clone_repo` and `delete_path` (a confirmed one gets "ask"), as `mcp__voice__…` and `mcp__plugin_voice_voice__…` |
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
  search; MCP resources; `AskUserQuestion` and plan mode, since nobody can click a form in a
  voice conversation.
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
  every merge needs your yes and then the approval, each by voice or, with Telegram input on, in
  your Telegram chat ([5.8](#58-the-telegram-fallback)).
- **Denied below `unrestricted`:** claude.ai connectors (`mcp__claude_ai_*`), web fetch and
  search, messages to other sessions, remote and scheduled agents, artifacts, Monitor, workflows
  and worktrees. The start script passes these deny rules with `--settings`
  (`scripts/controller-settings.mjs`): in `controller/.claude/settings.json` they would hold at
  every level. Bypass and auto mode cannot be turned on there, at any level.
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
  code and covers one action. It stays open as long as Claude Code may wait on it: no time limit,
  and none outlives the controller session, as the gateway ends with it.
- **In every result.** The open prompts come with whatever the voice AI calls next: `get_reply`,
  `ask`, `status`, and also `send` and `approve`, the latter listing those still open after the one
  it answered. The voice AI reads them out and asks you.
- **At once on Telegram**, if it is set up: every prompt goes to your chat as soon as Claude Code
  raises it, whether voice mode is on or not, and in the night too
  ([5.8](#58-the-telegram-fallback)). Only a standby holds it until it is over; while the kill
  switch is locked, every prompt is denied anyway.
- **Whoever can call `approve` can approve.** The voice AI is told to approve only after an
  explicit yes; that is an instruction, not enforcement.
- **Answered in Telegram.** With answers by Telegram on (`VOICE_GW_TELEGRAM_ANSWERS=1`), an
  approval request in your chat is answered there too: a Reply with a plain yes or no, a message
  with its code and yes or no, or a plain yes or no alone while it is the only one open; "yes to
  all" allows every one open ([5.8](#58-the-telegram-fallback)). The verdict goes to Claude Code
  as one by voice does; the first answer wins, and the voice AI hears that it was answered in
  Telegram. `VOICE_GW_TELEGRAM_CONFIRM=0` keeps approvals with the voice and the
  terminal.
- **What it guarantees:** the controller cannot merge on its own, for example because a pull
  request's text told it to.
- **Turning it off:** `VOICE_GW_PERMISSION_RELAY=0`. Then approvals, merges included, happen only
  at the terminal.
- **Answered elsewhere.** With [Remote Control](#remote-control-from-the-claude-app) on, the Claude
  app shows the prompt too, as a third place. An answer at the terminal or in the app does not
  reach the gateway, so it guesses: below `unrestricted`, the next call of a gateway tool by the
  controller means every prompt relayed before was answered, since the session waits on its
  prompts and has no subagents there. Such a prompt leaves the lists, by voice and in Telegram,
  and the voice AI hears once that it was answered at the computer. It is only a guess: an answer
  to it by voice, or by Reply or code in Telegram, still goes to Claude Code, which drops a verdict
  that comes too late, and the answer says so ("It looked answered at the computer already; if it
  was, that answer stands."). At `unrestricted` the controller can run subagents, whose prompts
  wait while the session goes on, and nothing in a prompt says whose it is, so there the gateway
  guesses nothing: a prompt answered at the terminal or in the app stays listed until you answer
  it by voice or in Telegram too, or the session restarts.
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
  said; the gateway's prefix alone does not count. With Telegram input on, so does an answer you
  typed in your Telegram chat, as a Reply to a question or with its code
  ([5.8](#58-the-telegram-fallback)): the gateway routes it itself, only from your own account in
  your private chat with the bot and only to an open question, and the controller sees it with
  `via="telegram"`.
- **Requests by Telegram count**, with Telegram input on. Any other message you write in that chat
  is a request of yours, as one by voice is, also with `via="telegram"`. When it replies to another
  message the gateway sent, that message is quoted after your words as context; only your own
  words count, never the quote.
- **Push, merge, restart and delete too.** Words typed in Telegram settle such a decision through
  `resolve_decision`, start the follow-up `dispatch` for an answer to one and a `dispatch` with
  `direct`, and confirm a `delete_path` and a `restart_controller`, as the same words spoken do.
  With `VOICE_GW_TELEGRAM_CONFIRM=0` they do none of this: each answers `needs_driver`, and the
  controller asks you by voice ([5.8](#58-the-telegram-fallback)).
- **Every dispatch.** With `direct`, `draft` and `allow_dirty` too; with
  `VOICE_GW_TELEGRAM_CONFIRM=0`, `direct` only on spoken words, or under a standing order you made
  by voice. Otherwise `dispatch=needs_driver`: nothing starts, and the controller is told to ask
  you by voice. `list_workers`, `worker_status`, `stop_worker`, `open_items` and `stats` are not
  checked.
- **Cloning, deleting, restarting.** `clone_repo`, a confirmed `delete_path` and
  `restart_controller` with `confirm` are checked the same way; with `VOICE_GW_TELEGRAM_CONFIRM=0`
  the last two only on spoken words.
- **Queued tasks and decisions.** A queued task's words are checked when it is queued, not again
  at its turn. `resolve_decision`, which closes an open decision
  ([8.4](#84-voice-commands)), is checked the same way, and so are `set_away` (night mode) and
  `standing_order`.
- **Standing orders.** Without fresh words, a dispatch may cite a [standing order](#standing-orders)
  you made by voice: only for its repository, only until it runs out, and the kill switch ends it.
  Its words are yours from when you made it. No text of a worker or GitHub makes or extends one.
- **What it guarantees:** text in a repository, a run's result or a pull request cannot start a
  worker by itself.
- **What it does not:** the controller still reads that text, and it writes the `task` itself. A
  phrase you said recently can be quoted again for another task, another repository or with
  `direct`, as long as it is within the window. And whoever can call `send`, or with Telegram
  input on write in your Telegram chat, supplies the words, like whoever can call `approve`
  approves.

### 5.5 Workers: on this computer or in Docker

What applies to every worker run (`src/workers.mjs`):

- **Options:** `claude -p --permission-mode bypassPermissions --permission-prompts none
  --strict-mcp-config --include-hook-events`. A repository's own MCP servers do not start.
- **The kill switch's hooks:** in `--settings`, next to the denied tools. Before each `Bash` and
  `Write` call one names the folder Claude Code starts it in, for the rule on writes outside; after
  each call, and before the run ends its turn, it hands the worker the gateway's notes, such as a
  write moved to [quarantine](#quarantine) ([5.9](#the-folder-a-command-runs-in)). Run with this
  computer's `node`, in the container with the container's.
- **Denied tools:** claude.ai connectors, messages to other sessions, remote and scheduled agents,
  artifacts, workflows, Monitor, worktrees, `AskUserQuestion`, plan mode and the `security-review`
  skill. That skill puts its own prompt in place of the task, so a run that called it near the end
  stopped with the review's report, before its commit and push. The rules ask workers to finish
  the job themselves (commit, push, pull request, without asking first) and to carry on after any
  review, subagent or skill.
- **Environment:** the controller session's variables (`CLAUDECODE`, its messaging socket and
  token, the session id) are removed, so a worker cannot reach the controller.
- **Sessions and what they cost:** a follow-up resumes the session of its place, the checkout's
  last or its worktree's, so the worker keeps its context; `fresh` starts a new one. What a run
  costs is mostly that context, read again from the prompt cache on every call, and written again
  whenever the cache has expired. Two settings in its `--settings` keep that down, the same on this
  computer and in Docker, and only for the workers, never the controller:
  - **The prompt cache** of the run's main conversation is kept an hour
    (`VOICE_GW_WORKER_CACHE_TTL`, `1h`). Claude Code's own choice is an hour on a subscription
    within its limits, but 5 minutes as soon as a run goes on on usage credits: every wait of more
    than 5 minutes in a run (a `sleep` while tests or a background subagent run) then wrote the
    whole context again, and so did most first calls of the next run in that session, even a few
    minutes later. An hour's cache write costs 1.6 times a 5-minute one,
    far less than writing it again. Subagents keep Claude Code's 5 minutes: they rarely wait.
  - **Compaction:** Claude Code summarises a session once it reaches 300k tokens
    (`VOICE_GW_WORKER_AUTOCOMPACT`), instead of near the model's whole window, about a million
    tokens on Opus 5.5; long sessions grew that far, and their follow-ups started at a median of
    about 450k. The run's subagents inherit the window. The summary loses detail of a long build
    session, and the worker may read files again: keep what matters in the repository (a concept
    or style guide), or raise the setting.
  - **What it saves:** replayed on six days of real worker runs (about 28,000 calls, 2026-10-29 to
    11-04, mostly long builds), about 18 % for the hour's cache, 41 % for compaction at 300k, and
    46 % for both; estimates, give or take a third. Review fixes in a new session
    ([automatic fixes](#automatic-fixes-for-review-comments), `VOICE_GW_AUTO_FIX_FRESH`) save
    some more of the same.
  - `auto` or `0` leaves either to Claude Code. A `CLAUDE_CODE_PROMPT_CACHE_TTL`,
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `FORCE_PROMPT_CACHING_5M` in the gateway's environment wins
    over both, as Claude Code decides; the gateway's log names what the workers get.
- **Before a run:** the gateway refuses a dispatch without your words from a recent voice request
  ([5.4](#54-approvals-by-voice)) and a checkout with uncommitted changes until you agree. A
  second run in the same repository (more than `VOICE_GW_MAX_WORKERS_PER_REPO`, one by default),
  or one more than `VOICE_GW_MAX_WORKERS` runs in all, waits in the queue instead
  ([several runs per repository](#several-runs-per-repository)). A run stops after
  `VOICE_GW_WORKER_TIMEOUT` minutes, six hours by default (`0`: no time limit).
- **When a run has ended:** when every process of it has, not when its output shows a result.
  Claude Code can answer a turn of its own first, such as the notification of a background task
  left over in the session it resumes, write a result for it and go on with the task in the same
  process; a run can also leave a server or a test running. Every process of a run carries marks
  in its environment, which whatever it starts inherits (`VOICE_GW_RUN`, `VOICE_GW_TASK`,
  `VOICE_GW_REPO`). The gateway finds them by these, on Linux in `/proc` and on macOS with
  `ps -E`, besides the run's process group and the tree below it: also those that left the group
  or whose parent ended. Until all of them are
  gone, the run counts as running (`state=ending` once it is being stopped): the rules watch it,
  the kill switch stops it, nothing else starts in its checkout, and its git check waits. When the
  run's own process ends while processes it started still run, the gateway ends those; a run that
  gave its result and stays without a word for two minutes, the gateway ends too. Stopping sends
  SIGTERM to all of it, then SIGKILL every five seconds until it is gone, also from the next
  gateway after a restart. A run's own process is recognised by its start time, so a later
  process with the same id is never taken for it. Worker processes in a checkout that belong to no
  run the gateway follows (its state was lost, for example) are ended when the gateway starts,
  before a run there, and by the kill switch, and nothing starts in that checkout until they are
  gone. These two, the start time and the processes of no run, need `/proc`: Linux only.
- **The queue:** `dispatch` answers `dispatch=queued` with the task's id (`q…`), its position and
  why: `busy` (a run is going there), `queue` (tasks queued there go first) or `full` (no run
  slot); with several runs per repository also `limit` and `after`. Your words are checked when it
  is queued, not again. The gateway starts queued tasks by itself, in their order and one
  repository at a time, once the repository is idle, its last result has reached the controller
  and a slot is free; the result event names the queue id
  (`queued="q…"`). At its turn a task goes through the same checks as any dispatch: kill switch,
  origin, `direct`, uncommitted changes. One that fails them leaves the queue, and the controller
  gets an event with `kind="queue"` and the reason, to ask you; nothing is dropped silently. The
  queue lives in `.state/workers.json` and survives restarts. `list_workers`, `worker_status` and
  the restart plan show it; `stop_worker` with `drop` drops one queued task by its id, or with
  `"all"` every one of the repository, together with the running task. The kill switch empties it;
  each of its tasks becomes an open decision that holds nothing, so new tasks start after the
  unlock.
- **After a run:** the gateway looks at the checkout with git itself, whatever the worker wrote
  (`audit` in `src/workers.mjs`, on this computer or through `docker exec`): commits that no
  remote branch has and that were not there when the run started, uncommitted files that were not
  there either, and whether the checkout is back on its starting branch. Without a remote,
  commits do not count. Without a record of the start (a run of an older version, or git did not
  answer then), no commit or file counts as the run's own, and the check says so
  (`git="its start not recorded"`). The result event carries it twice: in the attribute `git`, in the
  gateway's words only ("clean", or "1 commit on no remote, 1 new uncommitted file"), and in a line
  with the branches and files, before the worker's text. `worker_status` and `stop_worker` show it
  too. A run that was stopped or failed also brings the worker's last message. Commits on no remote
  (not at `read-only`, where they stay in the container by design) and new uncommitted files become
  an open push decision ([8.4](#84-voice-commands)): the controller has to ask you, and the
  repository's queue waits until you decided; after `stop_worker`, its answer names the decision.
  A follow-up that was to push and did not is caught too: what the decisions it closed were about
  counts again in its own check, and the files they are about need no `allow_dirty` and are not
  called someone else's in its prompt. A commit you already decided to keep local raises no new
  decision.
- **The helper folder:** test reports, screenshots, logs, temporary files and other scratch output
  go to `.voice-scratch` at the top of the run's checkout or worktree; the worker's rules say so,
  and to commit none of it and delete what it no longer needs. What is untracked there is no
  change: the look for uncommitted files before a run and the check after it pass over it, so it
  raises no push decision, and the kill switch counts it apart, against a limit of its own
  ([5.9](#59-the-kill-switch)). What is committed from there counts as any change. The gateway
  goes by the path and writes nothing into your repository's `.gitignore` or `info/exclude`, so
  `git status` at the desk shows it. A worktree takes it along when the gateway removes it; in the
  checkout it stays, for a follow-up in the same session and a look at the desk, and what is left
  there counts again at the end of the next run there.
- **The run folder:** what belongs nowhere in the repository, such as screenshots and other files
  for you, browser profiles, downloads and temporary files, goes to a folder of the run's own
  outside every checkout, next to the worktrees: `<VOICE_GW_WORKER_ROOT>/.voice-runs/<repository>/<date>-<id>`
  (in Docker `/repos/.voice-runs/…`, in the mounted folder of clones, so you find it on this
  computer too). The gateway makes it before the run, for your user only, and hands it over as
  `TMPDIR` and `VOICE_GW_RUN_FOLDER` (in Docker with `docker exec -e`, inside the container only);
  the prompt names it, and the rules say to write nowhere else outside the repository, also when a
  task names another place. It belongs to the worker's Claude session: a follow-up in the same
  session gets the same folder, at the same path, so that what the worker remembers writing there
  it may write again; a run next to it, in a worktree, or a `fresh` session gets one of its own. The
  kill switch lets the run write there, and never into another run's folder or the folders around
  them ([5.9](#59-the-kill-switch)); what is in it is no change. The result names it, with how many
  files are in it and the newest, when it is not empty, and `worker_status` always does, so that
  the controller can tell you where to find them. It is removed `VOICE_GW_RUN_FOLDER_DAYS` (7) days
  after its session's last run, never while a run of that repository goes or the kill switch is
  locked, and made again, empty, at the same path when the session goes on (`0`: kept for good).
- **The gateway's own checkout** gets the same look whenever the controller replies "done": if it
  has uncommitted changes or commits on no remote, the reply's result says so in one line
  (`VOICE_GW_SELF_CHECKOUT`), and it becomes an open push decision, until you were asked. Only the
  commits of the branch that is checked out count, not those of other local branches such as
  Claude Code's worktrees. Once you decided about exactly these files and commits, it stays quiet;
  once the checkout is clean, the decision closes. The reply itself goes out first.
- **Not this repository.** On this computer the gateway's own checkout is no worker, even inside
  `VOICE_GW_WORKER_ROOT`: a run there could change the gateway, the confine hook and
  `controller/CLAUDE.md`. `VOICE_GW_WORKER_SELF=1` lists it anyway. In Docker, the container's
  clones are what counts.
- **Rules for the run** (`WORKER_RULES`): branch `voice/<name>`, commit only its own changes, never
  force-push, merge or delete branches, ask before pushing a public repository, scratch output only
  in the helper folder and the run folder, never end the turn, which ends the run, while tests, a build or a helper
  agent still run in the background, never end with commits on no remote or uncommitted changes
  without naming them and asking about the push. These are rules, not limits; the check after the
  run is code.
- **Pull requests** are opened ready for review, so that automatic reviews start at once.
  `VOICE_GW_PR_DRAFT=1` makes them drafts, as before; bot reviewers usually skip a draft, and it
  has to be marked ready before a merge.
- **A single draft:** `dispatch` with `draft` opens that task's pull request as a draft, also when
  the task waits in the queue first: its prompt says `Draft pull request: yes`, and the Publish
  rule refers to it. The controller passes it only when you ask for a draft, or say yes to its
  question whether to open it as one because more tasks for the same pull request follow; the
  last of them marks it ready ([8.4](#84-voice-commands)). At `read-only`, where pull requests are
  turned off and with `direct` there is nothing to open: the run starts all the same, and
  `dispatch` says the draft has no effect.

| | On this computer | In Docker |
|---|---|---|
| Runs as | You, in your checkouts in `VOICE_GW_WORKER_ROOT` | Your user id, in the container's clones in the mounted folder |
| Reaches | Everything your user can: files, SSH keys, the `gh` login, `.secrets/`, this repository's code | The mounted folder, `/run/secrets/voice` (read-only), the network |
| GitHub | Your `gh` login: every repository you can write to | The container's token, at the level it allows |
| Started by | `spawn` in its own process group, with the run's marks | `docker exec … voice-run`, which hands over the tokens, marks the run (`VOICE_GW_TASK`) and starts its own process group |
| Stopped by | Signals to its process group, the tree below it and every process with its marks | `voice-stop`: its process group and every process with its mark, in the container; also once its own process has ended |
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

#### Several runs per repository

By default a repository has one run at a time, and the rest of its tasks wait in the queue.
`VOICE_GW_MAX_WORKERS_PER_REPO` (`1`), or "Runs per repository" in the setup assistant, allows more.
`VOICE_GW_MAX_WORKERS` stays the limit over all of them: every run of a repository counts, so it
still protects your subscription.

- **Where they run.** The first run of a repository works in its checkout, as always. Every
  further one works in a git worktree of its own, in
  `<VOICE_GW_WORKER_ROOT>/.voice-worktrees/<repository>/<task id>`: outside every checkout, and
  not listed as a repository because of the dot. In Docker the same, in the container's clones
  under `/repos/.voice-worktrees`, every git command through `docker exec`.
- **How a worktree is made.** The gateway fetches the branch the checkout's run would start from
  (`origin/<branch>`, usually the default branch) and adds the worktree there, on a detached
  HEAD. Submodules come from the checkout's own modules, a local clone that downloads nothing, also
  for a shallow one such as `drawio` in traffic; only a commit the checkout's module lacks comes
  from the submodule's URL, as one shallow commit. Where the checkout has not initialised a
  submodule, it is a shallow clone from its URL. The URL goes with `-c`, so the checkout's config
  stays as it was. A submodule that fails is named in the worker's prompt, and the run starts all
  the same.
- **Its own session and rules.** A run in a worktree has a Claude session of its own, not the
  repository's, and the same options, denied tools, environment, marks and time limit as any run.
  For the kill switch's rule on writes, its worktree is its repository; the checkout is outside.
  Its prompt says how it works there: create its `voice/` branch there and stay on it; before
  pushing, `git fetch origin`, rebase onto the branch its pull request goes to (or the default
  branch, where pull requests are off or with `direct`), run the tests, resolve conflicts itself
  and run the tests again; push only when they pass, a branch of its own that was pushed before
  with `--force-with-lease`; where pull requests are off, `git push origin HEAD:<default branch>`.
- **Who waits for whom.** The controller decides per task, without asking you: `parallel` when
  it needs none of the other tasks' results and works on other files, `after` with the ids of
  runs or queued tasks it must wait for, or neither, which keeps it behind everything the
  repository had when it came. `dispatch=queued` lists the runs and queued tasks there with their
  texts; `order_queue` changes how a queued task waits later, without your words, as it changes
  only the order, not what is done. Its confirmation says in a few words whether it runs in
  parallel or what it waits for, and why. A task waits until a run slot and a slot in its
  repository are free and what it waits for has ended.
- **Follow-ups and answers.** A follow-up for a run in a worktree goes there (`continues`), and
  your answer to a run's result goes there by itself: the same worktree and session. A worktree
  removed meanwhile is made again at the same path, on the branch its run ended on, so that the
  session continues.
- **After a run.** The gateway's git check looks at the worktree: the commits its HEAD has and its
  files; a run in the checkout is not blamed for the commits of runs in worktrees. With nothing
  uncommitted, nothing unpushed and no commit only its HEAD has, the worktree is removed, its
  helper folder with it; otherwise it is kept, and the push decision names it. A decision about a
  worktree holds only the tasks for that worktree. `list_workers` and `worker_status` show every
  run and the kept worktrees; the result event says `worktree="…"`. Kept worktrees that nothing
  needs any more are looked at again every ten minutes, and removed once nothing would be lost.
- **Interrupted runs.** A run in a worktree that a restart of the gateway or the computer, the time
  limit, a crash or `stop_worker` interrupts goes back to the queue with its worktree, in front for
  its repository, at most three times. At its turn it resumes there, in its session where that can
  be continued, finishes, rebases, tests and pushes, and only then is the worktree removed. Its
  result event says so (`requeued="q…"`). `stop_worker` with the run's own id in `drop` stops it
  for good. The kill switch is the exception: it empties the queue as always and stops every run,
  but keeps their worktrees, each as an open decision that holds nothing; after the unlock,
  `dispatch` with `continues` finishes one there.
- **A changed limit.** The queue remembers the limit it was planned for (`.state/workers.json`).
  Raised, at a start or in the settings file while the gateway runs, the controller gets an event
  with `kind="plan"` that lists the queued tasks that could now run next to others, with their
  texts, and marks them with `order_queue`. Lowered, the tasks run one after the other again by
  themselves. Runs going always run to the end, also above a lower limit: nothing new starts in
  that repository until it is below.

| | Run in the checkout | Run in a worktree |
|---|---|---|
| Folder | `VOICE_GW_WORKER_ROOT/<repository>` | `VOICE_GW_WORKER_ROOT/.voice-worktrees/<repository>/<id>` |
| Starts from | The branch the checkout is on | That branch as `origin` has it, fetched just now |
| Session | The repository's | Its own, kept for follow-ups there |
| At the end | Back on its starting branch | On its own branch; rebased, tested, pushed |
| Interrupted | Ends; its result says so | Back in the queue, in front, with its worktree |

#### Work folders

Off by default; `VOICE_GW_SCRATCH=1`, or the setup assistant, turns them on. A task that needs no
repository, such as a question to look up, research, a calculation, a draft or a conversion, then
gets a work folder: a new empty folder of its own (`src/workspaces.mjs`). Each run in one is a
worker run like any other, with the same options, denied tools and environment as above.

- **Where.** In `VOICE_GW_SCRATCH_ROOT` (`~/voice-scratch`), as `<date>-<id>`, mode 0700. The
  root must lie outside every git repository, this checkout and the repositories folder, and not be
  the home folder itself; otherwise the gateway leaves work folders off and logs why
  (`work folders off: …`).
- **The tools.** The controller uses the same ones: `dispatch` with the worker `scratch/new` makes
  a folder and answers with its name, `scratch/<id>`; follow-ups and answers go to that name and
  continue in the same folder and Claude session. `list_workers` shows `scratch/new` and the last
  used work folders; `worker_status` and `stop_worker` take their names. `direct`, `draft` and
  `allow_dirty` have no effect there, and `dispatch` says so.
- **Runs at a time.** New ones take any free slot of `VOICE_GW_MAX_WORKERS` and count against it,
  as many as there are slots; in each folder one run at a time, whatever
  `VOICE_GW_MAX_WORKERS_PER_REPO` says. The rest waits in the queue, as for repositories.
- **The same safety.** Only on your words from a recent voice request
  ([5.4](#54-approvals-by-voice)); the kill switch stops their runs, empties their queue and makes no
  new folder while locked; the queue, the folders and their sessions survive restarts in
  `.state/workers.json`.
- **Only that folder to write.** The rule on writes outside ([5.9](#59-the-kill-switch)) allows a
  run in a work folder only its folder, the temporary folders and its own Claude Code memory folder:
  not `VOICE_GW_KILL_ALLOW_PATHS`. Its rules say so, and to name the files it made, push nothing and
  change nothing elsewhere. So a run that writes to the home folder locks the switch at `auto`,
  unless it only adds a new file there, the first or second time in the run: that file goes to
  [quarantine](#quarantine), with a warning.
- **After a run** the gateway looks at the folder itself, whatever the worker wrote: the files it
  made, changed and removed. There is no git, so there is no push decision. The result event
  carries `files="2 files made, 1 changed"` instead of `git`, and a line with the names and where
  the folder is.
- **Removed** `VOICE_GW_SCRATCH_DAYS` (60) days after its last run, with its session, unless a run
  goes, a task waits or a decision is open there; with `0`, never. Folders in the root that the gateway did not make
  stay, and so does everything while work folders are turned off. A run that began before they
  were turned off is still followed where it runs.

**In a container of their own** (`VOICE_GW_SCRATCH_DOCKER`, empty by default): for a protected
environment, their runs run in a container from the worker image instead of on this computer.

- **Started with** `scripts/start-workers-container.sh --scratch`, which the setup assistant runs:
  `--user <uid>:<gid> --init --restart unless-stopped`, the root at `/scratch`
  (`VOICE_GW_DOCKER_SCRATCH`), read-write or read-only while the kill switch is locked, its own
  volume `voice-scratch-home` at `/home/worker`, and of the secrets only
  `.secrets/worker/claude_token`, as a file of its own: no GitHub token, no repositories. A new
  token counts once the container starts again.
- **Not the workers' container.** The gateway and the script refuse its name; with workers in
  Docker, the two are separate containers from the same image.
- **Through `docker exec`.** The gateway makes a folder, lists it after a run and removes it in the
  container, as it runs every git command there; on this computer it never walks or deletes what a
  run could have laid out, such as a link to your home. Runs start and stop with `voice-run` and
  `voice-stop`, as in the workers' container.
- **The kill switch** stops it and takes its restart policy; the gateway stops it again if it runs
  with a writable folder while locked.

| | Work folders on this computer | In their container |
|---|---|---|
| Runs as | You, in the work folder | Your user id, in the work folder at `/scratch/<date>-<id>` |
| Reaches | Everything your user can | The work folders, Claude Code's token, the network |
| GitHub | Your `gh` login, which its rules forbid it to use for anything but reading | Nothing beyond what anyone can read |
| Isolation | None; the rules only observe | The container |

### 5.6 Access levels and their detection

In Docker, each repository gets a level (`src/access.mjs`). `list_workers` and `dispatch` show it
with the reason, for example `access pr (main is protected by a ruleset)`.

| Level | Token | Default branch | Workers |
|---|---|---|---|
| `read-only` | None, or one that cannot push or open pull requests | Any | Commit on a local `voice/` branch. Never push, never open a pull request ([4.5](#45-pushing-from-a-read-only-container)) |
| `pr` | Can push (Contents) and open pull requests | Protected by branch protection or a ruleset | Push a `voice/` branch and open a pull request |
| `full` | As `pr` | Not protected | A pull request by default; a push to the default branch only when you ask, through `dispatch` with `direct` |

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
- `dispatch` answers with `push=direct`.
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
- **Approval requests at once.** Every approval request of Claude Code's goes to the chat as soon
  as it is raised, once: whether voice mode is on or not, whether the voice AI has read it out or
  not, and in night mode too, by day as at night. Claude Code waits on it, and the next voice call
  may be long in coming. Only a standby holds it, until the connector signs in again; while the kill
  switch is locked, Claude Code's prompts are denied before they reach anyone. With answers by
  Telegram on you answer it there (below); otherwise its last line says to answer it in voice mode
  or at the terminal.
- **Questions after the call:** after `VOICE_GW_TELEGRAM_AFTER` seconds (600) without a voice tool
  call, voice mode counts as ended. Gaps of a few minutes between calls are normal while you talk,
  so the wait is long. Questions that voice mode has not picked up then also go to the chat, each
  once. A question the controller settled in the meantime is not sent.
- **Never there:** results, news and interim `working` updates; they wait for the next voice call,
  apart from the controller's replies to an answer or a request you gave in the chat (below).
- **Not waiting either:** the kill switch alarm goes at once, whether voice mode is on or not, and
  so do the PIN to unlock it in voice mode and the notes about that unlock (below), the warning when
  a run's write outside goes to [quarantine](#quarantine), a note when the gateway ends because
  another process holds its port, the alerts about suspicious requests and sign-ins
  ([5.2](#52-the-voice-endpoint-and-oauth)), the Funnel's messages
  ([7.3](#73-publishing-the-endpoint)), the watchdog's around a restart ([8.2](#82-the-watchdog)),
  and the statistics when the gateway shuts down ([8.5](#85-statistics)).
- **In night mode** ([night mode](#night-mode)), also when you turn it on by day, the fallback
  pauses for questions and news. What still comes: approval requests, at once as always; alarms
  (the kill switch, a standby, a wait for the usage limit, once each, and the warning about a write
  that went to quarantine); the PIN when you ask to unlock in voice mode; and the controller's
  replies to what you wrote in the chat yourself. The morning summary names what the night left,
  instead of one message each.
- **Inbound, only from you:** your own account (`from.id`), in your private chat with the bot, the
  configured chat. In a private chat the chat id is your user id, so `.secrets/telegram_chat_id`
  is all it needs; the log names it at every start. Groups, supergroups, channels, other senders,
  bots and messages on behalf of a chat are ignored, without a word back; forwarded messages,
  messages written through an inline bot, edits and messages without text are refused, with the
  reason in the chat. Commands: the kill switch (`/stop`, `/killswitch`, `/emergencystop` or an
  emergency phrase), the Funnel (`/funnel on`, `/funnel off`, `/funnel`, "keep alive";
  [7.3](#73-publishing-the-endpoint)), the statistics (`/stats`, `/stats all`;
  [8.5](#85-statistics)) and night mode (`/night`, "good night" on, `/night 09:00` until then;
  `/back`, "I'm back" off; [night mode](#night-mode)). The kill switch comes first, also in a
  forwarded or edited message: a stop can only lock. With Telegram input on, also answers to
  questions and any other message as a request (below); a Reply to a question is its answer,
  whatever it says, and with requests on, a command stays a command as a Reply to any other
  message, such as news. With answers on, approval requests too: a Reply with yes or no, or a plain
  yes or no while only one is open (below).
- **Telegram input, off by default.** Answers and requests by Telegram are an option in the setup
  assistant ("Take answers and requests from Telegram too"), which turns both on
  (`VOICE_GW_TELEGRAM_ANSWERS=1`, `VOICE_GW_TELEGRAM_REQUESTS=1`). Off, the chat takes only the
  commands above, and any other message gets "Not passed on: Telegram input is off…". An
  installation whose settings file names neither setting has it off after the update, also if it
  answered questions there before: turn it on in the setup, or put the two lines into
  `.secrets/gateway.env`. A value the gateway does not know counts as off; `other`, the name of
  the earlier middle setting, counts as `1`. With input on, push, merge, restart, delete and
  approvals count there as by voice; a third setting, `VOICE_GW_TELEGRAM_CONFIRM` (on by default,
  in the setup "Push, merge, restart, delete and approvals in Telegram"), keeps them with your
  voice at `0` (below).
- **Answers by Telegram** (`VOICE_GW_TELEGRAM_ANSWERS=1`). Every question there shows
  its code in its first and last line ("Question for request 8cep …"). Answer it with Telegram's
  Reply on that message, whatever you write, unless it is `/stop`, an emergency phrase or another
  slash command; or, without a Reply, with a message that names the code of exactly one open
  question, a request's or a decision's ("8cep yes", "Answer dk3p: no"). The gateway maps the
  Reply to the question by the id of the message it sent, kept with the request, also across a
  restart. It reaches the controller exactly like an answer by voice, "(Answer to 8cep) yes",
  marked `via="telegram"`: the question counts as answered, its open decisions keep your answer,
  and `dispatch` and `resolve_decision` take its words ([5.4](#54-approvals-by-voice)). The chat
  confirms it ("Passed on to the controller as your answer to 8cep."), and the controller's
  replies to it come back there as replies to your message, also while voice mode is on or in
  the night; only a standby holds them.
- **Requests by Telegram** (`VOICE_GW_TELEGRAM_REQUESTS=1`). Any other message you
  write to the bot, neither a command nor an answer, works like typing to the controller: it
  reaches it as a request of yours, exactly like one by voice, with `via="telegram"` and without
  `trusted="no"`, so `dispatch`, `clone_repo`, a confirmed `delete_path`, `resolve_decision`,
  `set_away` and `standing_order` take its words ([5.4](#54-approvals-by-voice)). The chat
  confirms it ("Passed on to the controller as request 7hqm."), and the controller's replies come
  back as replies to your message: "On your request 7hqm, still working: …", then "On your
  request 7hqm: …", also while voice mode is on or in the night, and never as voice news. A
  question it asks back carries its code and can be answered there, as any other. A Reply to
  another message of the gateway's, such as the controller's last answer, news or an alert, is a
  request too, with that message quoted after your words: "(In reply to the gateway's message,
  quoted as data: "…")". The quote gives the controller the context; only your own words count.
  Only a message this gateway sent since its start is quoted: one of the bot's that it did not
  send, which whoever else had the token could have written, is not.
- **Not passed on,** with a short reason in the chat: with input off, anything but a command;
  with requests off, a message with no Reply
  to a question and no code of an open question (it lists the open ones); a message that names
  several open questions; a Reply to a question that is answered or settled already, or to an
  approval request that is answered already, or with `VOICE_GW_TELEGRAM_CONFIRM=0` to any approval
  request, which never becomes a request either; an answer to an approval request that is not a
  plain yes or no; a plain yes or no while several approval requests are open, or one and a
  question shown after it, where the chat lists them and asks which one is meant, and with `VOICE_GW_TELEGRAM_CONFIRM=0` while any is open; a
  forwarded or edited message, or one without text; and anything while the kill
  switch is locked ("It is unlocked at the computer, or in voice mode with a PIN sent here.") or
  the gateway is inactive, in a standby or without a controller. While the controller waits for the
  usage limit, the confirmation says until when. Telegram never unlocks.
- **The unlock PIN.** To unlock the kill switch in voice mode ([5.9](#59-the-kill-switch)), the
  gateway sends a PIN to this chat, "Entsperr-PIN 4 7 1 9, gültig 5 Minuten" or "Unlock PIN 4 7 1
  9, valid 5 minutes", digit by digit so that CarPlay reads it out as digits, and only when the
  configured chat is your private chat with the bot. It counts only spoken in voice mode. Typed
  here, also in a command such as `/unlock 4719`, it is refused ("Not passed on: it holds the
  unlock PIN, which counts only when you say it in voice mode."), and it reaches neither the
  controller nor a log: the input log, the gateway's log and every event have it masked as
  `****`. The PIN's message is never quoted to the controller: a Reply to it comes without its
  text. The gateway also says here when three wrong PINs blocked the unlock in voice mode, and when
  you unlocked it there.
- **Push, merge, restart and delete as by voice.** With Telegram input on, these count there as
  any other request or answer, by default (`VOICE_GW_TELEGRAM_CONFIRM=1`). A request typed there
  that asks for one, such as "merge pull request 3", "push it", "restart the controller", "delete
  alpha" or a push straight to main, reaches the controller, which prepares it and asks you, as it
  would by voice; your answer there, by Reply or with the code, confirms it as the same words
  spoken do. `resolve_decision` for a push, merge, restart or delete decision, the follow-up
  `dispatch` for an answer to one, `dispatch` with `direct`, `delete_path` with `confirm` and
  `restart_controller` with `confirm` take words typed in Telegram ([5.4](#54-approvals-by-voice)).
- **Approvals by Telegram.** A merge and a confirmed delete also need Claude Code's approval
  ([5.3](#53-the-controllers-confinement)), and with answers by Telegram on, you give it there too.
  Every approval request comes to the chat at once (above), so a merge you confirmed there does not
  wait for the voice. Its last line says how to answer it: Telegram's Reply on it with a plain
  yes or no ("ja", "ok", "allow"; "nein", "no", "deny"), or a message with its five-letter code and
  yes or no ("qwert yes"). Anything else, or both at once ("not ok"), leaves it open and the chat
  asks for a plain yes or no. A message that is nothing but a yes or a no ("yes", "Ja.", "ok", "👍";
  "no", "nein", "👎"), without a Reply and without a code, answers the approval request open when it
  is the only one: the controller waits on it and would read such a message only afterwards anyway.
  With several open it answers none: the chat lists them, each with its code and a few words, and
  asks which one is meant; it asks too while a question shown after the only one is open, which the
  yes may be meant for. Anything longer stays what it was, a request or an answer, and with none
  open, so does the plain yes. "Yes to all" ("ja zu allen", "alle ja", "allow all") allows every
  approval request open at that moment, "no to all" denies them all, and the chat lists each;
  questions stay open, and with none open the chat says so. The verdict goes to Claude Code as one
  by voice does; the chat confirms it and names it ("Allowed: approval request qwert (Bash: gh pr
  merge 3 --repo driver/alpha --squash). Claude Code goes on."), the input log keeps it, and the
  voice AI hears that it was answered in Telegram. The first answer wins: one answered by voice
  already is said to be settled, and a plain yes no longer counts for it. One the gateway only
  guessed answered at the computer ([5.4](#54-approvals-by-voice)) is left out of a plain yes and
  of "yes to all", but a Reply to it or its code still sends your verdict, and the chat adds that an
  answer given at the computer stands; Claude Code drops a verdict that comes too late. Every
  protection of Telegram input holds: only your own account in your private chat, no forwarded or
  edited message, nothing older than two minutes, nothing while the kill switch is locked (which
  denies every open approval anyway) or the gateway is inactive. With answers by Telegram off, or
  with `VOICE_GW_TELEGRAM_CONFIRM=0`, approval requests still come to the chat at once, to answer
  by voice or at the terminal; without the permission relay there are none.
- **Keeping them with your voice** (`VOICE_GW_TELEGRAM_CONFIRM=0`, or any value but `1`, so that a
  typo lets nothing more through). Ordinary requests and answers still come by Telegram; push,
  merge, restart, delete and approvals do not. Their questions on Telegram say "Answer in voice
  mode and mention 8cep". An answer there is not carried out: nothing reaches the controller, the
  decision stays open, and the chat says that it must be confirmed by voice, in German when you
  wrote in German ("Nicht ausgeführt: 8cep ist eine Push-Entscheidung, und die muss per Voice
  bestätigt werden…"), else in English. A request typed there that asks for one reaches the
  controller, which prepares it and asks you; the words that confirm it must be spoken. The
  gateway enforces that in code: the tools above refuse words typed in Telegram (`needs_driver`),
  and an approval request there says "Telegram cannot approve". `clone_repo` takes Telegram words
  either way, as it only adds a folder.
- **Answers off.** `VOICE_GW_TELEGRAM_ANSWERS=0` turns answers by Telegram off: a Reply to a
  question or an approval request, or a message with its code, is not passed on, while other
  messages are still requests while `VOICE_GW_TELEGRAM_REQUESTS=1`.
- **Night mode and Telegram.** "good night" or `/night` there turns night mode on at once, as a
  command, and `/night 09:00` or `/night until 2026-11-03T09:00` until then. A longer request,
  such as "I'm off to bed, keep going with alpha" or "good night until 9", reaches the
  controller, which calls `set_away` on its words, as it would on the same words spoken or typed
  as an answer there; the night's log says it came by Telegram.
- **Only if recent.** A command, an answer or a request counts only if Telegram's timestamp on it
  is at most two minutes old when the gateway reads it. Telegram keeps messages for a day, and a
  `/stop`, `/funnel on` or "yes" sent while the gateway was not running must not act hours later.
  Such a message gets an answer instead: "Ignored "/funnel on": it was sent 15 minutes ago, while
  the gateway was not listening… Send it again if you still want it."
- **The input log.** Every message the bot receives, yours and anyone else's, accepted, refused
  or ignored, is a JSON line in `.state/telegram-input.log`: the time, the sender's id, the chat's
  id and type, the first 80 characters, the decision with its reason or what it became, and the
  request id. Never the token: it, and anything shaped like a bot token, is cut out first. Past
  1 MB the file moves to `telegram-input.log.1`, replacing the one before; mode 0600, folder 0700.
- **The token** lives only in `.secrets/telegram_token`, not in the settings file. At every start
  the gateway tightens it, `telegram_chat_id` and the `.secrets` folder to 0600 and 0700 if they are
  open to others, and says so in the log with the advice to get a new token. It removes any
  environment variable that holds the token, so that no worker run inherits it, and it never
  appears in a log line, an error message, the statistics or the input log.

**How safe is Telegram as input?** In short: as safe as your Telegram account. By default a
stolen account can do in the chat what you can there; `VOICE_GW_TELEGRAM_CONFIRM=0` keeps what it
could do small.

- **Who can write as you:** anyone signed in to your Telegram account. That is you on your phone
  and on every other device or Telegram Web session you once signed in to, and whoever takes over
  the account: a SIM swap that receives the login code, a stolen or leaked session, a device left
  signed in. Telegram has no second factor by default. Turn on two-step verification (a cloud
  password: Settings, Privacy and Security), and look through the active sessions now and then
  (Settings, Devices) and end those you do not know.
- **A leaked bot token** lets someone read what you write to the bot, swallow your messages before
  the gateway reads them (then the log says that another program takes the bot's updates, and
  `/stop` would not reach the gateway), and send messages to you as the bot. It does not let them
  write as you: the gateway takes only messages from your own account. Nor does it show them the
  unlock PIN, which the bot sends and which its updates do not contain, unless you reply to the
  PIN's message or type the PIN yourself. A fake question from them
  that you reply to reaches the controller without its text, as the gateway quotes only messages it
  sent itself. If the token may have leaked, revoke it with @BotFather (`/revoke`) and enter the new
  one in the setup.
- **Not end-to-end encrypted.** Bot chats go through Telegram's servers in a form Telegram can
  read, unlike its secret chats. What you write there and what the gateway sends (questions,
  summaries of results, alerts) is readable by Telegram. Leave Telegram out if that is not
  acceptable.
- **What the hardening covers:** only your account in your private chat counts; groups, channels,
  other senders and bots are ignored without an answer; forwarded, inline-bot and edited messages
  and anything older than two minutes are refused; the kill switch comes first and Telegram never
  unlocks: the PIN it carries unlocks only spoken, through your signed-in voice connector; nothing
  passes while the kill switch is locked or the gateway is inactive; an approval takes a plain yes
  or no; the input log keeps every attempt.
- **What it does not cover:** someone who has your account can do in the chat what you can: ask
  for work, which workers carry out as on your voice (read code, run tests, open pull requests),
  and, by default, push, merge, restart, delete and approve. The kill switch's rules and `/stop`
  (also from your phone) remain the brake. A worker on this computer runs as your user and could
  read `.secrets/` like any of your files; only workers in Docker cannot.
- **Recommendation:** turn Telegram input on only with two-step verification on the account, and
  look through its active sessions. Push, merge, restart, delete and approvals by Telegram are the
  default with input on, so that no question and no approval has to wait for the voice; they cannot
  be undone, or go out to others. If a stolen session should not be able to do them, set
  `VOICE_GW_TELEGRAM_CONFIRM=0` (in the setup, "Push, merge, restart, delete and approvals in
  Telegram": off), and they take your voice again.

### 5.9 The kill switch

One lock in the gateway's code (`src/killswitch.mjs`, `src/guard.mjs`). It does not depend on the
controller following instructions.

![Kill switch](docs/killswitch.drawio.svg)

**What locks it** is a setting, `VOICE_GW_KILLSWITCH`, also in the setup assistant:

| Setting | Locks it | The rules |
|---|---|---|
| `auto`, the default | Every trigger below | Lock it |
| `manual` | Voice, Telegram and the controller | Only write to the gateway log what they would have done (`kill switch not locked, VOICE_GW_KILLSWITCH=manual; rule would have locked it: …`) |
| `off` | Nothing; each trigger is only logged | Only log, as at `manual` |

At `off`, "emergency stop" by voice answers that the kill switch is off and hands nothing over,
`/stop` on Telegram gets the same answer there, and `raise_alarm` tells the controller to tell you;
workers can still be stopped one by one with `stop_worker`. The setting decides only what locks it
from now on: a lock from before stays until you unlock it, and the gateway's log names the setting
at every start.

**Triggers:**

| Trigger | How | Checked |
|---|---|---|
| Voice | "emergency stop" or "kill switch"; or the tool `emergency_stop`, which the voice AI calls for the same words in any language | In `send` and `ask` before anything reaches the controller: the message starts with the phrase, or has at most six words |
| Telegram | `/stop` or a phrase | See 5.8 |
| Rule: outside | Writes outside the repository (for a run in a [worktree](#several-runs-per-repository), outside its worktree), its own [run folder](#55-workers-on-this-computer-or-in-docker) (never another run's, nor `.voice-runs` around it, nor `~/voice-scratch`), `/tmp`, `/var/tmp` (and the system's temp folder on this computer), the run's own Claude Code memory folder (`~/.claude/projects/<repository path with - for every other character>/memory`, where auto memory writes; another project's is outside), `VOICE_GW_KILL_ALLOW_PATHS` and, on this computer, the folders granted to its repository ([path grants](#path-grants)); for a run in a [work folder](#work-folders), writes outside that folder, those temporary folders and its memory folder; writing to `/dev/null`, the standard streams, a terminal or `/dev/fd/N` is none. Also a git hook in any `.git`, the run's own too, and `crontab` other than `-l`. The first two invalid writes of a run that make a new file in a place that is not sensitive go to [quarantine](#quarantine) instead, with a warning; the third locks | The file tools by path. Shell commands by explicit targets: redirections, `tee`, `cp`, `mv` (also what it moves away), `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`, `truncate`, `sed -i`, `dd of=`, also after `cd`, from the folder Claude Code names for each call in the gateway's hook, or else the folder the rule follows ([below](#the-folder-a-command-runs-in)); `$HOME` and `~` are expanded, and so are `$TMPDIR` and `$VOICE_GW_RUN_FOLDER` to the run folder. The command line is read as a shell reads it: quoted text, comments, here-strings and heredoc bodies are data, so a `>` or `;` in a pattern, a commit message or a script written to a file is none; the commands in `$(…)`, backticks, `<(…)`, `>(…)`, `sh -c`, `eval` and a heredoc a shell reads are checked like any other, and so is a script written from a heredoc that the same call runs |
| Rule: many changes | More than 500 file edits in a run; at its end more than 300 files or 30,000 lines changed; in a work folder, more than 300 files in it. Apart from these, the run's [helper folder](#55-workers-on-this-computer-or-in-docker) `.voice-scratch`, for its test reports, screenshots and logs: more than 10,000 file edits there, its run folder and the temporary folders together, or untracked files in the helper folder at the end | Edits as they happen; at the end the commits made during the run, each by its own changes, plus what is not committed, or the files in the work folder. What commits on branches the run made take over from before it counts nothing, on a branch from before the run everything counts (below). What is untracked in the helper folder counts only against its own limit, so the limit for real code stays as strict; what is committed or tracked there counts as any change. What is in the run folder and the temporary folders at the end is no change at all. `VOICE_GW_KILL_MAX_*` |
| Controller | `raise_alarm` with a reason | One more signal, never the only one |

A push to the default branch, or a merge into it, is no trigger. Whether workers may do that is the
repository's configuration on GitHub: branch protection and rulesets, in Docker also the access
level of the token ([5.6](#56-access-levels-and-their-detection)), and the workers' rules, which say
to push to it only after a `direct` dispatch or where pull requests are off, and never to merge: a
merge belongs only in a task that asks for it. Until 2026-11-04 it was a rule, which read the run's
`git push`, `gh pr merge` and `gh api` commands and asked GitHub whether the default branch moved
during the run. It locked falsely when the default branch moved for another reason: that day the
controller squash-merged a pull request and pulled the checkout while a run of the same repository
went on in a worktree, so the worker's repository held the new head.

**What a run took over.** The count of changes at the end is of what the run changed, not of the
code it carried from one branch to another. Of a commit that only branches the run made hold (or
no branch at all, such as a worktree's detached HEAD), a file counts nothing when the commit sets
it to a version that a commit from before the run had at that path, or removes it where the
default branch does not have it. So review-only branches made of a long-lived branch's existing
code count nothing: on 2026-11-02 a drawio-dev run made one at the merge base of `simple-modern`
and `dev` for each of six areas and one on it with `simple-modern`'s tree, and the count of
223,478 lines in 161 files locked the switch, of which 678 lines in 77 files were the run's own
fixes. Neither does a cherry-pick or a rebase of commits from before the run onto a new branch.
Everything else counts, as before:

- every commit that a branch from before the run holds, in the repository or as a remote branch:
  setting such a branch back to old versions, removing its files, or rewriting its history and
  force-pushing it counts in full. A branch is the run's when its reflog begins during the run
  with its creation, for a remote branch by a push; a branch without a reflog counts as from
  before;
- new code, also a version from before the run under another path, and the removal of files the
  default branch has, such as a wipe, on any branch;
- what is not committed;
- all of it after a `git push` to a URL or a path, which no remote branch in the repository shows,
  and whatever git cannot tell.

The gateway's log names what it left out (`kill switch rule on many changes: 77 files and 678
lines changed in one run, not counting 222800 lines in 159 files that branches the run made took
over from before it (worker drawio-dev, task tsz4)`), and so does the reason when it still locks.
The statistics count what the rule counted.

#### The folder a command runs in

A relative target such as `../report.md` counts from the folder the shell is in. Each worker run
gets a hook of the gateway's in its settings (`--settings`, with `--include-hook-events`): before
every `Bash` and `Write` call, Claude Code's `PreToolUse` hook prints the call's id, the folder
Claude Code starts it in, and the time into the run's output, and the rule checks the call from
that folder, a moment after it appeared. The model sees nothing of it. Without that report (a
Claude Code that runs no hooks, such as with `disableAllHooks`, or a run from before this version),
the rule follows the shell as Claude Code keeps it, as checked in Claude Code 2.1.312:

- the main thread's shell keeps its folder from one call to the next, also after a `cd`;
- after a command that failed it stays where it was: Claude Code takes the new folder only from a
  command that succeeded;
- when a call ends outside the workspace, Claude Code goes back to the workspace, and its result
  ends with `Shell cwd was reset to …`;
- a subagent's calls start in the main thread's folder and never move it, and neither does a call
  in the background.

The log says once per run when the hook's report is missing (`kill switch rule on writes outside:
no report of the guard's hook in this run, so the rule follows the shell's folder itself`). On
2026-11-03 a work folder's run had a read-only subagent survey a repository with `cd /tmp; …`
while its main thread worked in `sources/history/replay`. The rule took the subagent's `cd` for the
main thread's, went back to the work folder, and read the main thread's
`cp ws/report.md ../report-2026-10-31-end.md`, which went to `sources/history` in the work folder,
as a write above it: the switch locked for nothing.

#### Quarantine

A slip that only adds a file outside does not stop all work at once. The first and the second
invalid write of a run that make a new plain file in a place that is not sensitive go to
quarantine: once the call has ended, the gateway looks that the file is there, a plain file born
after the call started and in no git repository, and moves it into
`.state/quarantine/<task>/<n>-<name>` on this computer (for a run in Docker out of the container
with `docker cp`), with a line in `quarantine.jsonl` there: where it was, the command, when. The
log names it (`kill switch rule on writes outside the allowed folders: moved … to quarantine (…),
invalid write 1 of the run, by "cp ws/report.md ../report.md"; the third locks the kill switch
(worker …, task …)`), Telegram warns at once, the run's result and `worker_status` say so, and the
controller tells you as a warning. The worker reads it in the same run, from the gateway's hook,
with its next tool call, or before it ends its turn, which the hook holds while the gateway still
decides (`The gateway's guard: the command "…" wrote …, outside your allowed folders. The gateway
moved the file to quarantine as an invalid write …`); after the second, that the next one locks.
The third invalid write of the run locks. These lock at once, the first time, as before:

- changing, appending to, truncating or removing a file outside, moving one there or away (`mv`),
  `mkdir`, `ln`, `chmod`, `sed -i`, an `Edit`, and a file that was there before the call;
- anything in another git repository or its `.git` (hooks, config), a git hook anywhere, also in
  the run's own repository, a `hooks` folder, the gateway's own checkout;
- hidden files and folders: shell profiles and rc files, `~/.ssh`, `~/.claude`, `~/.config` with
  autostart and systemd, `.github` with the CI workflows; also `profile` and the like without a dot,
  `Jenkinsfile` and other CI files, macOS's `~/Library`, a folder on the `PATH`, and `crontab`;
- every place outside the home folder and the repositories folder (the run's: `/repos` in the
  container, the work folders' root for a work folder);
- whatever the guard cannot pin down: a file that is not there afterwards, a folder or a link, a
  file whose age the file system does not tell, one it could not look at or move.

Only at `VOICE_GW_KILLSWITCH=auto`: at `manual` and `off` the rule logs as before and moves nothing.
Nothing is deleted; the files wait in `.state/quarantine` for you.

#### Path grants

Some repositories have a folder of their own outside every checkout, such as the data folder of a
service the repository runs on this computer, where its workers test and deploy. A path grant lets
one repository's workers write there as in the repository, without a lock or the quarantine:
`VOICE_GW_PATH_GRANTS` in `.secrets/gateway.env`, `repository=folder`, entries separated by `;`,
several folders of one repository by `,`:

```bash
VOICE_GW_PATH_GRANTS=hauswache=/srv/wyze-events;alpha=/data/a,/data/b
```

On 2026-11-04 at 18:30 UTC the switch locked when the hauswache worker removed its own empty test
folders in its watcher's data folder, `rmdir /srv/wyze-events/live/2026-11-04 /srv/wyze-events/live`:
removing anything outside locks at once. With the grant above, that run goes on.

The grants apply from the gateway's start and, when the settings file changes, at once, as the
[worker limits](#88-configuration) do. The gateway checks every folder strictly: an absolute path of
a folder that is there, taken by its real path. Never `/` or a folder right below it, the home folder or a folder that
holds it, a folder in or around the repositories folder, the gateway's checkout, its state and
secrets, the work folders' root or Claude Code's folder, a hidden folder or one in it, a system
folder (`/etc`, `/usr`, `/var/lib` and the like), macOS's `~/Library`, a folder in or around one on
the `PATH`, or a git repository or a folder in one. An entry that is none, or a repository name
that is none, is ignored, with a line in the log (`VOICE_GW_PATH_GRANTS: ignored, alpha=/home/you is
the home folder or holds it`), so a typo never lets more through. The log names the grants at every
start, `list_workers` on the repository's line (`may also write in /srv/wyze-events (path grant)`),
and the worker's prompt says where it may write besides the repository.

In a granted folder the worker may make, change, move and remove files and folders, `rmdir`
included, and its file edits count against the rule on many changes as in its repository. What is
sensitive in itself still locks at once, there too:

- a hidden file or folder in it, and so a git hook;
- a git repository in it, another repository's files;
- making a link (`ln`), a path that leads out of the folder through a link, as the kernel resolves
  it (also `link/..`), and a link that leads nowhere;
- a file with more than one hard link, which is the same file somewhere else too;
- removing the granted folder itself or changing its mode;
- `crontab`, and everything outside the granted folders, as before.

Only for workers on this computer: in the Docker container a path of this computer means nothing,
so the grants count for nothing there, and the log says so. A work folder has none. One check in
`src/grants.mjs` decides for every grant, so that grants for one path, one run and a while, which a
worker would ask for and you would confirm by voice, can join the standing ones later. No tool lets
a worker grant itself one ([limits](#512-limits)).

#### Effects and unlocking

**Effects**, at once:

- **No new work:** `dispatch` answers `locked`, also a dispatch whose checks were still running
  when the switch tripped; `send` and `ask` hand nothing over. The queue is emptied, and the
  controller's alarm names its tasks: they do not start after the unlock by themselves.
- **Approvals:** open ones are denied, new ones are denied automatically.
- **Workers:** every run stops, with every process it started, also a run that is ending or
  making its worktree, and so do worker processes that no run accounts for and a clone that is
  going. A run in a worktree does not go back to the queue: its worktree is kept, as an open
  decision that holds nothing. With Docker the container stops and loses its restart policy, and
  so does the work folders' container.
  While locked, `scripts/start-workers-container.sh` mounts the folder read-only, and the gateway
  stops a container with a writable `/repos`, or a work folders' container with a writable
  folder, within `VOICE_GW_KILL_CHECK` seconds.
- **Alarm:** to Telegram at once, to every voice chat with its next call (`[ALARM]`), and to the
  controller.
- **State:** saved in `.secrets/killswitch.json`, mode 0600, with the count of wrong PINs in voice
  mode (below); it survives restarts. A file that cannot be read counts as locked.

**Unlocking at the server's terminal**, which always works:

```bash
node scripts/unlock.mjs --status   # what locked it
node scripts/unlock.mjs            # asks you to type "unlock"
scripts/start-workers-container.sh # Docker: start the container again
scripts/start-workers-container.sh --scratch # and the work folders' container, if you use one
```

It unlocks the running gateway through the admin socket, or removes the file, also after three
wrong PINs in voice mode, which `--status` then names.

**Unlocking in voice mode**, with a PIN from Telegram (`VoiceUnlock` in `src/killswitch.mjs`), so
that nobody has to reach the server by SSH from the car:

1. Say "unlock the kill switch" ("Entsperre den Kill Switch"). The voice AI calls `unlock` without
   a PIN and reads out why the switch locked, and the gateway sends a new PIN of four random
   digits to your Telegram chat, valid five minutes: "Entsperr-PIN 4 7 1 9, gültig 5 Minuten" when
   the voice AI names German as your language, else "Unlock PIN 4 7 1 9, valid 5 minutes". CarPlay
   reads it out.
2. Say the PIN. The voice AI calls `unlock` with it, and the gateway compares it itself, in
   constant time. The right one unlocks exactly as `scripts/unlock.mjs` does; the log says so
   (`kill switch unlocked by the driver in voice mode, with a PIN from Telegram; …`), and so does
   Telegram, with the containers that stay stopped: with Docker, start them again at the computer,
   as above.

The rules:

- **One PIN at a time.** A new one replaces the one before. A new trigger of the lock, which has a
  reason of its own, and an unlock at the server void it. After five minutes it counts for
  nothing, and neither does anything that is not four digits; neither counts as a try.
- **Three wrong PINs per lock,** across PINs, block the unlock in voice mode for that lock: the
  voice AI hears that it is unlocked only at the computer now, Telegram says so, and from then on
  only `scripts/unlock.mjs` unlocks it. The count is kept with the lock in
  `.secrets/killswitch.json`, so a restart does not reset it; the next lock starts again at zero.
- **Only the voice connector's tool.** The controller has no tool for it, and the PIN never
  reaches it; Telegram has no command for it, and a PIN typed there is refused and masked
  ([5.8](#58-the-telegram-fallback)). Not in a standby
  ([several gateways](#several-gateways-and-the-standby-after-a-disconnect)), and not for a kill
  switch file that cannot be read.
- **The PIN lives in the gateway's memory only,** as a salted SHA-256 hash: never in a file, a log
  line, a tool's result or an event for the controller. A restart forgets it; ask for a new one.
- **Without Telegram,** or with a configured chat that is no private chat, `unlock` answers that it
  needs Telegram for the PIN and that the kill switch is unlocked only at the computer.

While the unlock in voice mode is open for a lock, the alarm on Telegram ends "Unlock at the
server: node scripts/unlock.mjs, or in voice mode with a PIN sent here.", and the alarm for the
voice AI and the controller, the connector's line (`…: inactive, kill switch locked; it is unlocked
at the computer, or with unlock and a PIN from Telegram`) and the refusal of a Telegram message say
the same. Otherwise they say: only at the computer.

### 5.10 Secrets and files

| Path | Content | Mode |
|---|---|---|
| `.secrets/` | Folder for everything below | 0700 |
| `.secrets/oauth.json` | Clients and grants, hashes only | 0600 |
| `.secrets/admin.sock` | Admin socket of the running gateway | socket in the 0700 folder |
| `.secrets/gateway.env` | Settings from the setup assistant | 0600 |
| `.secrets/telegram_token`, `.secrets/telegram_chat_id` | The Telegram bot, and your chat with it, whose id is your user id | 0600, tightened at every start |
| `.secrets/killswitch.json` | Kill switch state, present while locked, with the count of wrong PINs in voice mode; never a PIN, which lives only in the gateway's memory | 0600 |
| `.secrets/worker/claude_token`, `.secrets/worker/github_token` | The container's logins, mounted read-only into it; into the work folders' container only `claude_token` | 0600, folder 0700 |
| `.state/` | Worker state, run output, open requests and decisions, watched pull requests, the watchdog's lock | 0700 when the gateway creates it |
| `.state/tasks/`, `.state/workers.json` | Each run's output with every tool input and result, and the kill switch's notes for the run, which its hook hands to the worker (`<task>.notes`; in the container `/tmp/voice-gw/<task>.notes`); the workers' state, with the queue, the worktrees, the limit per repository the queue was planned for, the work folders, and what each run's writes outside went to quarantine | 0600, folder 0700 |
| `.state/quarantine/<task>/` | The files the rule on writes outside moved out of the way ([quarantine](#quarantine)), as `<n>-<name>`, with `quarantine.jsonl`: where each was, the command, when; never removed by the gateway | The files as they were, `quarantine.jsonl` 0600, folders 0700 |
| `VOICE_GW_WORKER_ROOT/.voice-worktrees/<repository>/<id>` | The worktrees of further runs of a repository ([several runs per repository](#several-runs-per-repository)), while something is left in them | As git makes them |
| `~/voice-scratch/<date>-<id>` (`VOICE_GW_SCRATCH_ROOT`) | The work folders, with what their runs made | 0700, and the root too when the gateway or the start script makes it |
| `.state/requests.json` | Voice requests and the answers, with what the voice client has read | 0600 |
| `.state/telegram-input.log`, `.state/telegram-input.log.1` | Every message the bot received, with the decision and why; without the token ([5.8](#58-the-telegram-fallback)); rotated at 1 MB | 0600, folder 0700 |
| `.state/jobs.json` | Open decisions, with the driver's answers, and the last 100 closed ones for a week | 0600 |
| `.state/stats.json` | The statistics: this running time and all time, counts, sums and the last 100 durations per figure, repository names; no texts ([8.5](#85-statistics)) | 0600 |
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
  (`--timeout`), after writing, and on Cancel. With "keep this page open" ticked (the default) it
  stays after writing, for connecting the Claude app, and ends on "End the assistant", after the
  idle time, or at its limit, of which writing leaves at least 20 minutes (at most `--timeout`).
  The page's polling of the gateway does not count as activity.
- **Pairing codes only for that browser.** Section 10 asks the running gateway for a code over its
  admin socket only on a click, with the session cookie and from the page's own origin, so only
  the browser that opened the one-time link gets one: as good as being at the terminal. The code
  goes to that browser once, in the answer to its request; never into a URL, the terminal or a
  log. The assistant keeps only its expiry and an id, to tell the page whether it still works or
  was used, replaced or burnt. Valid ten minutes and one sign-in; a new one replaces the one
  before in the gateway.
- **Plain HTTP, by decision:** a notice at the top of the page says to use it only on your own
  network, since the one-time token, the keys and the pairing codes travel unencrypted. From
  elsewhere, use an SSH tunnel.
- **No secret leaves it.** None goes back to the browser (saved ones show as `••••••••`), to the
  terminal or to a log; a pairing code goes only to the page that asked for it. Output of the
  commands it runs shows a known secret as `‹secret›`.

### 5.12 Limits

- **Nothing is undone.** A push, a merged pull request or a deleted branch stays as it is. The kill
  switch stops what comes next.
- **The unlock in voice mode rests on two accounts.** Whoever has both your claude.ai account,
  with the voice connector signed in, and your Telegram account can unlock the kill switch from
  anywhere. A guess has three tries in 10,000 per lock. The salted hash keeps the PIN out of files
  and logs, not from a program that reads the gateway's memory, which only your own user can; a
  controller at `unrestricted`, or a worker on this computer, could run `scripts/unlock.mjs` as
  you anyway, though no worker runs while the switch is locked. If you do not want it, leave
  Telegram out: without it only the server unlocks.
- **The rules see a step only after it ran.** They read the commands Claude Code reports; the
  command that breaks a rule has usually run already.
- **Hidden actions are missed.** Not seen:
  - a write inside a script, an alias or another language, such as a Python script that
    writes a file into another repository; of a shell script that `cat` or `tee` writes from a
    heredoc, only what the same Bash call runs is seen;
  - targets in variables other than `$HOME`, and relative targets after a `cd` into one;
  - writes by programs, such as `npm install` into `~/.npm`, and other ways to run something later
    than `crontab`, such as `systemctl --user enable` or `git config core.hooksPath`;
  - paths behind symlinks, except in a [granted folder](#path-grants).
- **A path grant opens its folder.** In a granted folder the rule on writes outside watches only
  what is sensitive in itself; what the worker does to the service's data there is up to it, as in
  its repository. The links in it are looked at when the rule reads the call: a link that the same
  call makes with something other than `ln` (`cp -a`, `tar`) and writes through, or one made between
  the look and the write, is not seen. Host workers could write the settings file by a script, and a
  grant there applies at once.
- **The folder of a command, without the hook.** Where the gateway's hook does not report a call's
  folder ([5.9](#the-folder-a-command-runs-in)), the rule follows the shell as Claude Code 2.1.312
  keeps it; another version may keep it otherwise, and calls side by side in one turn may start
  from another folder than the rule thinks.
- **The quarantine comes after the call.** A file is moved once its call has ended, so a long
  command writes its log outside until then, and the worker learns of it only with its next tool
  call or before it ends its turn; without the hooks, only the result and Telegram say so. Whether a
  file is new goes by its birth time against the call's start; where the file system keeps none,
  it locks. A file the call made and removed again, or one that a write by a script left, is not
  seen.
- **The count of changes goes by the repository's git.** It takes the commits by their committer
  date since the run's start, and the branches the run made by their reflogs. Merges count
  nothing of their own, and a force-push that only drops commits adds none to count. A remote
  branch that the repository had not fetched looks like the run's after its push there, and a
  branch moved with `gh api` or by another tool is not seen.
- **On this computer the kill switch is a tripwire, not a boundary.** Host workers run as you,
  without approvals. They can write `.secrets/` (including `killswitch.json` and `gateway.env`),
  use your SSH keys and `gh` login, and change this repository's code (the gateway, the confine
  hook, `controller/CLAUDE.md`), which takes effect at the next restart; leaving this checkout out
  of the workers ([5.5](#55-workers-on-this-computer-or-in-docker)) only keeps runs from starting
  in it. A process that clears its environment and leaves both the run's process group and the
  tree below it can survive a stop (the gateway reads the run's marks in the environment from
  `/proc` on Linux and with `ps -E` on macOS). **Only Docker isolates.** The same holds for
  [work folders](#work-folders) on this computer: their rule on writes is stricter, but a run there
  can read and do everything your user can; in their container it reaches only the work folders.
- **Several runs in one repository share its git.** Their worktrees share its objects and refs. The
  count of changes at the end leaves out the branches other runs pushed and their worktrees' commits
  only as far as this gateway saw them. Whether two tasks touch the same files is the controller's
  judgement, from their texts; a conflict is resolved by the run that pushes second, when it
  rebases.
- **The container's scripts come with the image.** `voice-run` and `voice-stop` are copied into
  it when it is built; rebuild it (`docker build`, see `docker/Dockerfile`) for a newer version.
- **In Docker,** the container can do what its token allows on GitHub, and reaches the network.
- **The controller reads untrusted text.** Worker results, pull request news and what read-only
  `gh` shows reach it. `trusted="no"` and its instructions ask it to treat them as data; that is
  an instruction, not enforcement. The dispatch check ([5.4](#54-approvals-by-voice)) holds in
  code, but a phrase you said within `VOICE_GW_DISPATCH_WINDOW` can be reused for another task,
  and the controller writes the task itself. Merges still need your approval; its answers to you,
  `restart_controller` and `raise_alarm` are not checked. Of an open decision, the gateway makes
  sure that the controller asks you, not how well.
- **The voice AI is an instruction-follower.** If it rewrites "emergency stop" into a longer
  sentence, the phrase check can miss it, and the check knows only English; the `emergency_stop`
  tool is there for that. Approvals depend on
  it asking you.
- **The endpoint is public.** The pairing code protects the sign-in, and `/mcp` answers through the
  tunnel only Anthropic's addresses; but every Claude account calls from those too, and the sign-in
  pages answer everyone. Nothing limits the request rate, and nothing protects the availability.
- **Above `confined`, more rests on the sign-in.** At `clone-delete`, a deletion needs words and
  an approval that whoever can call the connector can give. At `unrestricted`, nothing in this
  design limits the controller, and the kill switch's rules do not watch it.
- **Run it on a computer or VM you can afford to lose,** and when in doubt:
  `node scripts/pair.mjs revoke all`.

## 6. Prerequisites

| Component | Version | Needed for | Notes |
|---|---|---|---|
| Node.js and npm | Node.js 20 or later (`engines` in `package.json`); tested with 22.22.1 and npm 10.9.4 | The gateway, scripts, tests | npm comes with Node.js |
| Claude Code | 2.1.80 or later for channels, 2.1.81 for the permission relay, 2.1.84 for `allowedChannelPlugins` (plugin mode). Tested with 2.1.310; the workers' hooks for the kill switch (`--include-hook-events`, `PostToolUseFailure`) with 2.1.312 | Controller and workers | Logged in with claude.ai. Channels need claude.ai or Console authentication; not on Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry ([channels][channels]) |
| Claude subscription | See below | Voice mode, connector, channels, `setup-token` | |
| git | 2.29 or later on the host for `scripts/fetch-from-container.sh` (`--no-write-fetch-head`); tested with 2.53.0 | Workers, the fetch helper | The container brings its own (Debian bookworm) |
| GitHub CLI `gh` | Tested with 2.46.0 | Host workers (push, pull requests), the controller's status questions and merges, the pull request watch | `gh auth login` on this computer |
| Docker | Tested with 29.8.0 | Optional: workers in a container | Docker installed as a snap cannot mount folders from `/tmp` |
| tmux | Tested with 3.6 | Optional: the controller in the background | The setup assistant's autostart uses it |
| systemd user services | – | Optional: autostart at boot on Linux | With lingering (`loginctl enable-linger`), which the setup assistant turns on; without it, only at a login and until the last logout |
| launchd (macOS) | – | Optional: autostart at login on macOS | A LaunchAgent, which the setup assistant writes and loads; at boot only with automatic login |
| bash | 3.2 or later | The start scripts | macOS's `/bin/bash` 3.2 will do; no GNU tools needed |
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
- **In total,** 95 packages in `node_modules`, pinned by `package-lock.json`. Nothing is compiled.

**Operating systems:**

- **Tested:** Ubuntu 26.04.1 LTS, for the gateway, workers on the host and in Docker, the
  watchdog and the setup assistant. The controller's Bash allowlist exists because of Ubuntu
  24.04+.
- **macOS:** supported, with Homebrew's `node`, `git`, `gh` and `tmux`, the `claude-code` cask,
  and Tailscale and Docker Desktop where wanted; [install and test on a Mac](docs/macos.md). The
  scripts run with macOS's own `/bin/bash` 3.2 and BSD tools; the test suite checks them with bash
  3.2. What differs from Linux:
  - **Autostart:** a LaunchAgent, `~/Library/LaunchAgents/com.drawio.cc-voice-gateway.plist`, that
    starts the controller in tmux at login (not at boot: with automatic login it comes back after a
    restart). The setup assistant writes it with your `PATH` plus Homebrew's folders, checks it
    with `plutil` and loads it with `launchctl` ([7.2](#72-by-hand), [8.1](#81-starting-and-stopping)).
  - **Sleep:** while the watchdog runs, `caffeinate` keeps the Mac from idle sleep
    (`VOICE_GW_CAFFEINATE=0` turns it off). A closed laptop lid still sends it to sleep.
  - **Paths:** the managed settings in `/Library/Application Support/ClaudeCode/`; the temporary
    folders the kill switch allows include `/private/tmp` and `/var/folders/…/T`; the Tailscale
    app's command line is found without "Install CLI".
  - Written and checked on Linux, with bash 3.2 in Docker and the macOS code paths in the tests;
    the first run on a Mac follows the checklist in [docs/macos.md](docs/macos.md).
- **Windows:** through WSL 2. Follow the Linux instructions inside WSL (Ubuntu); the gateway,
  tmux and the workers run there, and the autostart is a systemd user service if WSL runs systemd.
  Nothing runs on Windows itself.
- **Phone and car:** the Claude app on the iPhone, in the car with CarPlay. Android and Android
  Auto are not tested; nothing in the gateway is specific to either.

**Claude subscription.** The account that runs Claude Code and the account in the Claude app may
differ.

| Feature | Plans | Admin step on Team and Enterprise |
|---|---|---|
| Voice mode in the Claude app | All plans ([voice mode][voice]) | – |
| Custom connector (remote MCP) | Free (one connector), Pro, Max, Team, Enterprise ([connectors][connectors]) | On Team, only Owners and Primary Owners add connectors |
| Claude Code channels | Pro and Max without an admin step ([channels][channels]) | An Owner enables channels: Organization settings → Claude Code → Channels, or `channelsEnabled: true` |
| Remote Control for the controller, optional | Pro, Max, Team, Enterprise; not with an API key or a token from `setup-token` ([Remote Control][rc]) | An Owner turns on Remote Control: Organization settings → Claude Code |
| Channel plugin without the prompt | Team and Enterprise managed setting `allowedChannelPlugins` ([channels][channels-admin]) | Owner, see [7.4](#74-admin-steps-for-team-and-enterprise) |
| `claude setup-token` for the container | Pro, Max, Team or Enterprise ([authentication][auth]) | – |

On a Team plan this means:

- an Owner enables channels and adds the custom connector;
- optionally, an Owner puts the plugin on the channel allowlist;
- `claude setup-token` works.

A token from `setup-token` can only make model requests; it is used for the workers in the
container, not for the controller. It cannot open a Remote Control session either.

## 7. Installation

### 7.1 With the setup assistant

```bash
gh repo clone alderg/cc-voice-gateway && cd cc-voice-gateway
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
| Gateway | Port, the gateway's name for the voice assistant, whether it is in use or on standby, whether it switches off when its connector is disconnected (on by default; [several gateways](#several-gateways-and-the-standby-after-a-disconnect)), repositories folder, runs at a time and per repository (both apply at once in a running gateway), time limit, pull requests ready for review or drafts, review comments fixed without asking (on by default) and how many automatic rounds per pull request ([automatic fixes](#automatic-fixes-for-review-comments)), approvals by voice, Remote Control for the controller (off by default), what the controller may do (with a warning above `confined`), what locks the kill switch (with a warning below `auto`), the Funnel off when idle and after how many minutes, the Funnel's port, 443 by default and never changed by itself (with a line about the connector for another port) | Choices |
| Models | Model and effort for the controller (`--model`, `--effort` from `start-controller.sh`) and for every worker run, on the host and in Docker. Claude in Chrome for the controller (off by default); turned on, a warning unless Claude in Chrome's notice for the first start is confirmed already (below) | Choices, or Claude Code's defaults |
| Telegram | Checks the token (`getMe`), finds your private chat with `getUpdates` once you wrote to the bot, sends a test message | A token from [@BotFather](https://t.me/BotFather), one message to the bot |
| Workers in Docker | Checks the GitHub token and shows the level per repository with the gateway's detection. Builds the image with its progress shown. Starts the container, sets git's name and email in it, and clones the chosen repositories inside it. While Docker does not answer (section 1), the checkbox is greyed out, with a line why and what it takes; one on from before stays as it is, and the line says that the container cannot run until Docker answers | A token from `claude setup-token`, optionally a GitHub token ([5.6](#56-access-levels-and-their-detection)), the repositories |
| Work folders | Off by default. Turned on: checks their folder as the gateway does, and with a container of their own, builds the image if it is missing and starts the container with `start-workers-container.sh --scratch` ([work folders](#work-folders)). The container's checkbox is greyed out while Docker does not answer, as in section 5 | The folder, the days they are kept, and for the container its name and the token from `claude setup-token` |
| Watchdog | On Linux, writes and enables a systemd user service that starts the controller in tmux at boot, and turns on lingering for your user so that it keeps running without a login (if that is refused, it shows the `sudo` command); or starts it now in tmux. On macOS it writes a LaunchAgent that starts it in tmux at login, checks it with `plutil`, and with "start it now" loads it with `launchctl bootstrap`, which starts it (`kickstart` if it is loaded already); without, launchd loads it at the next login. Before it starts the controller, it marks `controller/` as trusted in Claude Code's config, so that the first start does not wait at the folder trust question ([8.1](#81-starting-and-stopping)) | Choices |
| Plugin | Shows whether `voice@cc-voice-gateway` is on the organisation's channel allowlist; registers the marketplace if it is; otherwise shows the admin steps, and, while the organisation has no managed settings of its own, "Put it on the allowlist on this computer", the unofficial workaround for personal accounts ([known issues](#810-known-issues)) | The admin, or your administrator password |
| Finish | Writes `.secrets/` (5.10). Then it ends, or with "keep this page open" (the default) stays for the next step | Whether to stay |
| Connect the Claude app | Shows whether the gateway runs; until it does, what to do: start the controller, or, while its tmux session runs, confirm what Claude Code waits for at the terminal, in a notice with the keys to press (`tmux attach -t voice`, the down arrow to "Yes, I trust this folder" and Enter, Enter for further questions, Ctrl-b d). It looks at the tmux pane (`tmux capture-pane`) for the folder trust question or the development channel's confirmation and names the one it sees; only which one reaches the page, never the pane's text. It notices by itself when the gateway runs. Then the Funnel's state on its port, a button that starts it with `scripts/funnel.sh start` and its output, the connector URL while it is on, and, once the Funnel is on, whether this computer gets the gateway's sign-in metadata under the connector URL as a browser here would; if not, why (naming another web server on 443 if `netstat -anv -p tcp` on macOS or `ss -ltnp` on Linux shows one, Tailscale's own left out) and two ways: another device, or "Prepare the sign-in on this computer", a marked line in `/etc/hosts` with administrator rights that it removes again by itself, with "Remove it now" ([known issues](#810-known-issues)); and a pairing code with a countdown, valid ten minutes and one sign-in, with "New code"; says when a client signed in with it, or why the code no longer works. Works before writing too, if a gateway runs already | Clicks |

#### Claude in Chrome

> [!WARNING]
> **A real security risk.** While Chrome stays open for the controller, the controller can use
> everything that browser profile is signed in to: active logins and sessions on any site, and
> extensions such as password managers (1Password and the like) that fill in credentials. Anyone
> who can steer the controller can reach that too: by voice, through Remote Control in the Claude
> app, and at the level `unrestricted`, where the browser tools pass the confine hook, with
> everything else your user can do. Take care. Use a separate Chrome profile only for Claude, or a
> separate user of the computer, with the Claude extension and nothing else: no password manager,
> no private or work logins, signed in only to what the controller is meant to use; close or sign
> out of what it no longer needs.

**What it needs while the gateway runs.** Claude in Chrome works only while someone is signed in
at the desktop of the user the controller runs as, or in a remote desktop session that stays when
you disconnect, with Chrome open and the Claude extension signed in to the same claude.ai account.
Without that, the controller's browser tools answer that the extension is not connected, and the
controller tells you so in a sentence. Keep a Chrome window of your own open, not only the window
Claude opens for its tab group: if Claude Code closes its last window or tab and no other Chrome
window is open, Chrome quits entirely, and the browser tools stop working until someone starts it
again at the desktop. The controller's instructions therefore never close the last tab of its tab
group nor a window (`controller/CLAUDE.md`). At each start with Chrome on, the log says whether a
desktop session of the user and a Chrome run (`watchdog: chrome desktop: …`). Workers get no Chrome: they
run headless (`claude -p`) without `--chrome`, with `--strict-mcp-config`, so no rule is needed for
them.

**Its notice for the first start.** At its first start with Claude in Chrome, Claude Code shows a notice about it
and waits for Enter at the terminal, so a restart by the watchdog or the autostart can hang there.
The start script marks it as seen before each start ([8.1](#81-starting-and-stopping)), but cannot
always. With Claude in Chrome on, the assistant therefore shows a warning, and repeats it when it
writes the setup: before relying on unattended restarts, start Claude Code once at the terminal, as
the user the controller runs as, with `claude --chrome`, confirm the Claude in Chrome notice with
Enter and leave with `/exit`. If Claude Code's config (`~/.claude.json`, or
`$CLAUDE_CONFIG_DIR/.claude.json`) says that the notice is confirmed already
(`hasCompletedClaudeInChromeOnboarding`), it says so instead; it only reads that file. If it cannot
tell, it warns. Next to the option, the page also says what Claude in Chrome needs while the gateway
runs, and points to the warning above in one line; the finish log repeats both.

Values equal to their default are left out of `.secrets/gateway.env`, and other settings already in
it stay. Unticking Telegram deletes its two files. Options: `--host` (`0.0.0.0`), `--port` (`8790`),
`--timeout` (minutes, `30`), `--idle` (minutes, `10`), or `VOICE_SETUP_HOST`, `VOICE_SETUP_PORT`,
`VOICE_SETUP_TIMEOUT`, `VOICE_SETUP_IDLE`. Run it again to change something.

Then go on with [Getting started](#getting-started) from step 4, with the page's section 10 while
it is open: start the controller, publish the endpoint, add the connector and pair.

### 7.2 By hand

Everything the assistant does can be done with files and commands.

**Settings:** `.secrets/gateway.env`, one `VOICE_GW_NAME=value` per line, mode 0600. The values
are in [8.8](#88-configuration). The gateway (`src/settings.mjs`) and the shell scripts
(`scripts/settings.sh`) read it line by line and never execute it. Variables set in the
environment or in `controller/.mcp.json` win. The watchdog reads it again before every start of the
session, so a restart, also one by voice, takes a change; only the controller level waits for the
next start of the start script (8.2).

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
  ordinary clones from GitHub outside the folder. Your checkouts in the worker root will do: the
  helper only adds refs to them.

**Autostart on Linux:** a systemd user service that runs
`tmux new-session -d -s voice <repo>/scripts/start-controller.sh` (Type=forking, with your
`PATH`), then `systemctl --user enable cc-voice-gateway.service` and `loginctl enable-linger`, so
that it starts at boot and keeps running without a login.

**Autostart on macOS:** a LaunchAgent, `~/Library/LaunchAgents/com.drawio.cc-voice-gateway.plist`,
whose `ProgramArguments` are the same tmux command with tmux's full path (launchd does not search
the `PATH`), with `EnvironmentVariables` `PATH` (yours plus `/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin` and Node's folder), `WorkingDirectory` the repository, `RunAtLoad` true, `KeepAlive`
false (tmux returns at once; the watchdog restarts), `AbandonProcessGroup` true, and
`StandardOutPath`/`StandardErrorPath` `~/Library/Logs/cc-voice-gateway.log`. Then:

```bash
plutil -lint ~/Library/LaunchAgents/com.drawio.cc-voice-gateway.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drawio.cc-voice-gateway.plist  # starts it now, and at every login
```

Then go on with [Getting started](#getting-started) from step 4.

### 7.3 Publishing the endpoint

Claude's servers call the connector from Anthropic's cloud. Any tunnel or reverse proxy works that:

- serves **HTTPS on port 443** with a valid certificate (Tailscale Funnel serves 8443 publicly too,
  but claude.ai's connector did not connect to it in our tests);
- forwards **every path** to `127.0.0.1:8787`, not only `/mcp`: the sign-in uses
  `/.well-known/…` and `/oauth/…`. Do not open port 8787 itself;
- passes the **public host name** in `Host` or `X-Forwarded-Host`, and sends
  `X-Forwarded-Proto: https`: the sign-in metadata is built from them;
- adds the **caller's address** as the last `X-Forwarded-For` entry: only Anthropic's addresses
  may call `/mcp` ([5.2](#52-the-voice-endpoint-and-oauth)). A tunnel that cannot do that needs
  `VOICE_GW_MCP_ALLOW=any`;
- allows **responses of up to a minute**, since `get_reply` waits up to 40 seconds.

**Tailscale Funnel** (tested). On Linux run `sudo tailscale set --operator=$USER` once. On macOS
the script finds the Tailscale app's command line by itself; `VOICE_GW_TAILSCALE_BIN` names
another.

```bash
scripts/funnel.sh start    # prints https://<host>.ts.net/mcp; reports when all relays answer
scripts/funnel.sh stop
scripts/funnel.sh state    # on or off
scripts/funnel.sh url
```

The first start fetches a certificate; the name and all relays can take a few minutes. The port is
`VOICE_GW_FUNNEL_PORT` from `.secrets/gateway.env`: 443 by default, or 8443 or 10000, the only
other ones Funnel allows; `FUNNEL_PORT` overrides it for one call. With another port the URL ends
in `:<port>/mcp`, and the gateway builds its sign-in metadata with that port by itself, but
claude.ai's connector did not connect to the Funnel on 8443 in our test: keep 443 for it. Neither
the setup assistant nor the script changes the port by itself. Another web server on port 443 of
the computer: [known issues](#810-known-issues).

**The Funnel on demand** (`src/funnel.mjs`), so that the endpoint is public only while you use it:

- **From Telegram** ([5.8](#58-the-telegram-fallback)): `/funnel on` or "keep alive" turns it
  on, `/funnel off` off, `/funnel` says whether it is on. Every command gets an answer; a start
  gets a second one once the public relays answer, usually within two minutes. So send it before
  you start driving, not with the first voice request.
- **Off by itself**, with `VOICE_GW_FUNNEL_IDLE` minutes set (the setup assistant offers it,
  90 suggested; off by default). That long after the last voice call, or after the last
  `/funnel on`, "keep alive" or gateway start, the gateway turns the Funnel off and says on
  Telegram how to turn it on again. Without Telegram, it comes back on only at the computer.
- **The gateway runs `scripts/funnel.sh`**, so the operator setting above is needed for this too.

**Reverse proxy**, for example Caddy, which gets a certificate and sets the headers by default:

```text
voice.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

With nginx add `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-Proto https;` and
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.

### 7.4 Admin steps for Team and Enterprise

On claude.ai, as Owner or Primary Owner:

1. **Enable channels:** Organization settings → Claude Code → Channels, or `channelsEnabled: true`
   in the managed settings ([channels][channels-admin]).
2. **Custom connector:** on Team, only Owners and Primary Owners add it ([connectors][connectors]).
3. **Optional, Remote Control** for the controller
   ([Remote Control](#remote-control-from-the-claude-app)): Organization settings → Claude Code →
   Remote Control, on; it is off by default there. On Enterprise with custom roles, your roles also
   need the cloud sessions and the Claude Code remote control permission ([Remote Control][rc]).
4. **Optional, the channel without the prompt.** Open
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
`Managed settings (remote)` line. Nothing is left to do on the server. The start script reads
Claude Code's local copy of these settings, which Claude Code refreshes when it starts, so the
first start after saving may still use the development flag; the one after it uses the plugin.

## 8. Operation

> [!TIP]
> **If anything stops working: run `scripts/restart-everything.sh`.** Nothing to check first,
> no questions: it stops everything of this gateway, ends what is left of it, starts it again
> and waits until the gateway answers, saying each step in a line
> ([details](#restarting-everything)).

### 8.1 Starting and stopping

```bash
tmux new -s voice scripts/start-controller.sh   # start, with the watchdog
scripts/start-controller.sh --status            # running? The watchdog, the session, the gateway
scripts/start-controller.sh --stop              # stop session and watchdog
VOICE_GW_WATCHDOG=0 scripts/start-controller.sh # without the watchdog
```

`--status` answers in two lines, the first as it always did:

```text
start-controller: running (watchdog 1489647, session 1489724)
start-controller: gateway process 1493320 (src/plugin.mjs), running for 1 h 48 min; port 8787 answers
```

The second names the gateway's process, `src/plugin.mjs` with the plugin and `src/gateway.mjs`
with the development flag, how long it runs, and whether its port (`VOICE_GW_PORT`, 8787)
answers `/healthz`. It counts only processes of this checkout, by the resolved path of their
script, never those of another checkout or worktree. A gateway whose session is gone shows as "of
no session of the watchdog", also after "not running"; "no gateway process of this checkout"
says that none runs, and "port … answers" then means that something else answers there.

With the autostart, the service or LaunchAgent only starts tmux; `--stop` ends the controller in
either case.

| | Linux (systemd user service) | macOS (LaunchAgent) |
|---|---|---|
| Start | `systemctl --user start cc-voice-gateway` | `launchctl kickstart gui/$(id -u)/com.drawio.cc-voice-gateway` |
| Stop | `systemctl --user stop cc-voice-gateway` | `scripts/start-controller.sh --stop` |
| Restart | `systemctl --user restart cc-voice-gateway` | `--stop`, then `kickstart` |
| Status | `systemctl --user status cc-voice-gateway` | `launchctl print gui/$(id -u)/com.drawio.cc-voice-gateway` |
| On at boot or login | `systemctl --user enable cc-voice-gateway` | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drawio.cc-voice-gateway.plist` |
| Off | `systemctl --user disable cc-voice-gateway` | `launchctl bootout gui/$(id -u)/com.drawio.cc-voice-gateway` |
| Its own output | `journalctl --user -u cc-voice-gateway` | `~/Library/Logs/cc-voice-gateway.log` |

**What the start script does:**

- **Folder and mode:** starts `claude` in `controller/` with `--permission-mode manual`.
- **Model and effort:** `--model`/`--effort` from `VOICE_GW_CONTROLLER_MODEL` and
  `VOICE_GW_CONTROLLER_EFFORT`, `--chrome` with `VOICE_GW_CONTROLLER_CHROME=1`, and
  `--remote-control "Voice controller"` with `VOICE_GW_REMOTE_CONTROL=1`
  ([below](#remote-control-from-the-claude-app)); options given to the script come last and win.
- **The folder trust question:** at the first start in a folder, Claude Code asks "Quick safety
  check: Is this a project you created or one you trust?", with "No, exit" chosen, and waits at
  the terminal. Before every start, `scripts/folder-trust.mjs` therefore marks `controller/` as
  trusted where Claude Code notes the answer: `projects["<folder>"].hasTrustDialogAccepted` in
  `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` if set), on the exact folder as the system
  names it, also where a parent folder is trusted already. Only that key of that project, only when
  it is missing, under Claude Code's own lock, the new file in place of the old in one step; a file
  that does not parse is left alone. So it holds after the folder moved or the config was reset
  too. The setup assistant does the same right before it starts the controller. If it cannot (no
  such file yet, not valid JSON, locked for 5 s), the log line `watchdog: trust: …` says that the
  start may ask at the terminal.
- **Claude in Chrome's notice for the first start:** at the first interactive start with
  `--chrome`, Claude Code shows a notice about Claude in Chrome before the session starts ("Enter to
  confirm · Esc to cancel") and waits for a key, so a start by the watchdog or the autostart would
  hang there. Before every start with Chrome on, `scripts/chrome-onboarding.mjs` therefore marks it
  as seen: `hasCompletedClaudeInChromeOnboarding` in Claude Code's `~/.claude.json`
  (`$CLAUDE_CONFIG_DIR/.claude.json` if set), the key Claude Code sets itself once it has shown the
  notice. Only that key, only when it is missing, under Claude Code's own lock on the file. If it
  cannot (no such file yet, not valid JSON, locked for 5 s), the log line `watchdog: chrome: …` says
  that the start may wait for Enter at the terminal, and so does the next restart's Telegram message
  ([8.2](#82-the-watchdog)). A second line says whether a desktop session of the user and a Chrome
  run, which Claude in Chrome needs ([Claude in Chrome](#claude-in-chrome)); the log only.
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
    Claude Code asks at every start; answer at the terminal. With a personal account this is the only
    official way, and no start runs unattended; an unofficial workaround is in the
    [known issues](#810-known-issues).
    `VOICE_GW_CHANNEL=plugin|development` overrides the choice; `node scripts/channel-mode.mjs` shows
    it.

Claude Code starts the gateway itself, from `controller/.mcp.json` or as the plugin's server, so
the gateway lives and ends with the session. Do not drop the user settings with
`--setting-sources`: Claude Code then reports channels as not enabled for the organisation. Your
plugins, hooks and allow rules therefore load into the controller; the confine hook blocks every
tool that is not on its list ([confinement](#53-the-controllers-confinement)).

#### Restarting everything

`scripts/restart-everything.sh` is for when something no longer works and you do not want to find
out what first. It asks nothing, and works the same with the autostart and without it:

1. **What runs.** `--status`, then each worker run going and what the restart does to it, and the
   queued tasks, which stay queued.
2. **"A restart was requested"** on Telegram, as for every restart on purpose; the stopping
   watchdog then sends the shutdown message with the statistics, and the next gateway the ready
   message ([8.2](#82-the-watchdog)). No other messages.
3. **Down.** The systemd user service (`systemctl --user stop`), or on macOS, where the LaunchAgent
   has no stop of its own, and in tmux, the watchdog with `start-controller.sh --stop`.
4. **What is left, of this checkout only:** the watchdog and the controller session that its lock
   names, gateway processes of this checkout (by the resolved path of `src/plugin.mjs` or
   `src/gateway.mjs`), each with SIGTERM and after five seconds SIGKILL, and a lock no watchdog
   holds. A process on the gateway's port that is not this gateway is named, not touched. Other
   Claude Code sessions, other projects and whatever it cannot attribute to this checkout stay as
   they are.
5. **The containers,** with workers in Docker or work folders in a container of their own: started
   with `scripts/start-workers-container.sh` only when one does not run, and not while the kill
   switch is locked. A running one is left as it is.
6. **Up.** The service, the LaunchAgent (`launchctl kickstart`, or `bootstrap` when it is not
   loaded), or a new tmux session `voice` (a new window in it, if a session of that name stays).
7. **Until it runs:** `--status` once a second, until the watchdog runs and the gateway's port
   answers, at most `VOICE_GW_RESTART_WAIT` seconds (120). It ends with that status, or with what
   still fails and where to look: `journalctl --user -u cc-voice-gateway`, the LaunchAgent's log,
   `tmux attach -t voice`, the gateway's log; with the development flag, the warning waits for
   Enter at the terminal.

**Worker runs.** On Linux the service's stop ends the runs on this computer with it, as they are
its processes (`KillMode` control-group, systemd's default), as every `systemctl --user restart`
does. After the start the gateway sends a run in a worktree back to the queue, where it resumes,
and reports a run in a repository's checkout as failed; that one is not queued again. Under tmux
and the LaunchAgent, and in a container, runs keep going, and the new gateway follows them. Run
from inside the service, a window of its tmux session for example, the script first moves itself
out with `systemd-run --user --scope`, or the stop would end it too. Its lines go to the gateway's
log as well, as `restart-everything:`.

#### Remote Control from the Claude app

Off by default; `VOICE_GW_REMOTE_CONTROL=1`, or the setup assistant, turns it on, from the next
start of the session (a restart by voice will do). The start script then passes
`--remote-control "Voice controller"` ([Remote Control][rc]). At claude.ai/code or in the Claude
app's Code tab, on an iPad for example, the session "Voice controller" shows what reaches the
controller and what it does: the voice requests, its answers, the worker results.

| Session | Remote Control | Why |
|---|---|---|
| Controller | Yes | An interactive session, signed in with claude.ai |
| Workers on this computer, work folders | No | Headless `claude -p` runs. `--remote-control` and the setting `remoteControlAtStartup` are for interactive sessions; in a `-p` run Claude Code ignores the flag without a word (checked with 2.1.310) |
| Workers in Docker, the work folders' container | No | Headless too, and the token from `claude setup-token` only makes model requests: it cannot open a Remote Control session ([authentication][auth]) |

The gateway's log says the same at its start. From the app, on the controller:

- **Type to it.** A typed message reaches the session as your turn, not through the channel: no
  `request_id`, nothing read aloud. The controller answers it in the app (`controller/CLAUDE.md`).
- **No worker by typing.** Typed words are no voice request, so `dispatch` answers `needs_driver`
  ([5.4](#54-approvals-by-voice)), as do `clone_repo`, a confirmed `delete_path` and
  `resolve_decision`. Say it by voice, or with Telegram input on write it in your Telegram chat:
  a request or an answer there is different, as the gateway routes it itself, from your own
  private chat with the bot ([5.8](#58-the-telegram-fallback)). Status questions, `list_workers`, `worker_status`,
  `open_items`, `stop_worker` and a merge (your yes, then the approval) work.
- **Approvals** show in the terminal, in the car and in the app; the first answer counts
  ([5.4](#54-approvals-by-voice)).
- **Stop, mode, commands.** Stop ends the current turn, as Esc does. The mode picker offers
  Manual, Accept edits and Plan; leave it at Manual. Bypass and auto are turned off in
  `controller/.claude/settings.json`. `/exit` from the app ends the session as at the terminal,
  and the watchdog takes that as quitting: it does not start it again.
- **The confinement holds.** The confine hook sees every tool call, whoever asked for it, in every
  mode ([5.3](#53-the-controllers-confinement)). The workers and the kill switch's rules are not
  touched.
- **Each start is a new session** in the app; after a restart the one before shows as offline.

It needs Claude Code on this computer signed in with claude.ai, not an API key, `apiKeyHelper` or
`ANTHROPIC_AUTH_TOKEN`; Anthropic's API, not Amazon Bedrock, Google Cloud's Agent Platform,
Microsoft Foundry or another `ANTHROPIC_BASE_URL`; and neither
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` nor `DISABLE_GROWTHBOOK` set. On Team and Enterprise
an Owner turns it on ([7.4](#74-admin-steps-for-team-and-enterprise)). Without that, the session starts all the same,
with a notice in its terminal; `claude doctor` names the check that failed. If Claude Code asks
once whether to enable Remote Control, answer at the terminal (`tmux attach -t voice`).

Claude Code's documentation names no conflict between Remote Control and channels; the
combination has not been tried with a live session here yet. Before relying on it in the car, try
a voice request and an approval with the app open.

**Security.**

- **Your claude.ai account steers the controller.** Whoever is signed in to it, on any device, can
  read the session and act in it, with your approvals: merge at `confined`, delete at
  `clone-delete`, anything at `unrestricted`. Protect the account; "Require trusted devices" ties
  Remote Control to devices you enrolled ([Remote Control][rc]).
- **The transcript is stored at Anthropic** while connected, voice requests, worker results and
  tool output included, to keep the devices in sync ([Remote Control][rc]).
- **Typed is not spoken.** The dispatch check holds in code. The controller takes a typed message
  as yours, as it should; what it does without the check (stopping a worker, a restart, a merge
  with your approval) a typed message can ask for.
- **Your sessions on other machines reach it too.** Over the same connection they can send it
  messages ([cross-session messaging][csm]), as sessions on this computer always could; its
  instructions treat them as data.

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
| Settings read again before every start, so a restart takes a change; the controller level, `VOICE_GW_SECRETS_DIR`, `VOICE_GW_STATE_DIR`, `VOICE_GW_LOG_FILE` and the watchdog's own settings stay until the start script starts again | – | `.secrets/gateway.env` |
| Log | `watchdog:` lines in `.logs/gateway.log`: who started and who stopped it (the autostart's service or LaunchAgent, or user, process and terminal), and each start's settings with where they came from | – |
| Telegram around a restart, a stop and a crash, and when it gives up; the gateway sends another when the controller is ready again (below) | if the two Telegram files exist | – |
| macOS: no idle sleep while it runs (`caffeinate -i -s`, ended with the watchdog) | on | `VOICE_GW_CAFFEINATE` |

**Telegram.** A restart on purpose comes in three messages: that it was requested, that the
gateway is shutting down, with the statistics of its running time ([8.5](#85-statistics)), and that
the controller is ready again. A crash keeps its single message, then the ready one:

| What | 1. It begins | 2. The gateway shuts down | 3. Ready again (from the next gateway) |
|---|---|---|---|
| A crash, or a gateway that stopped answering | "the controller session crashed (exit code 1) and starts again in 5 s, without a confirmation. A message follows when it is ready." | – | "the controller is ready again, after a crash (exit code 1)." |
| By voice, `restart_controller` ([8.3](#83-restarting-the-controller-by-voice)) | "a restart was requested by voice; the controller restarts now. A message follows when it is ready." | "the gateway is shutting down now for the restart. Its statistics: …" | "… after a restart requested by voice." |
| The autostart's service, `systemctl --user restart cc-voice-gateway` | "a restart of the service cc-voice-gateway.service was requested; the controller restarts now. …" | the same | "… after a restart of the service cc-voice-gateway.service." |
| `scripts/restart-everything.sh` ([8.1](#restarting-everything)) | "a restart of everything (scripts/restart-everything.sh) was requested; the controller restarts now. …" | the same | "… after a restart of everything (scripts/restart-everything.sh)." |
| A stop: `--stop`, `systemctl --user stop`, quitting the session | – | "the gateway is shutting down now (stopped at the computer). Its statistics: …", or "(the service cc-voice-gateway.service was stopped)", "(the controller session was ended at the terminal)" | – |

Each starts with "cc-voice-gateway on <host>:". The second comes from the watchdog, from the file
the gateway saves as it ends (`scripts/stats.mjs`), and only for the gateway of the session that
ended: one that never started, or never saved, sends none. A plain start or a boot sends nothing.
The service's restart runs `start-controller.sh --stop` as systemd's `ExecStop` with the job
`restart` (`systemctl --user list-jobs`): that `--stop` sends the first message and leaves the
reason in `.state/controller.restarting`, where the stopping watchdog finds it for the second and
the watchdog systemd starts next for the third. The LaunchAgent on macOS has no restart of its own:
`--stop`, then `kickstart`, is a stop and a start.

With the development flag, a restarted session waits for the channel warning to be answered at the
terminal (`tmux attach -t voice`, Enter); with the plugin it does not. With a personal account there
is no plugin, so every restart waits for it ([known issues](#810-known-issues)). Claude in Chrome's notice for
the first start would wait there too, at a start by the watchdog or the autostart alike; the start
script marks it as seen beforehand ([8.1](#81-starting-and-stopping)). The message when a restart
begins names what it may wait for: "Confirm the development channel at the terminal (tmux attach -t
voice), otherwise voice requests do not arrive." instead of "without a confirmation", and, when the
last start could not mark Claude in Chrome's notice as seen, "Claude in Chrome's notice for the first
start may wait for Enter at the terminal (tmux attach -t voice)."

### 8.3 Restarting the controller by voice

"Restart the controller":

1. **The controller explains and asks.** It asks `restart_controller` what a restart would do and
   tells you, then asks: which worker runs are going, what happens to open requests, whether
   someone has to confirm at the terminal.
2. **Only after your yes** it calls `restart_controller` with `confirm` and your words, which the
   gateway checks as for `dispatch`: spoken, or with Telegram input on typed in your Telegram chat,
   unless `VOICE_GW_TELEGRAM_CONFIRM=0` keeps restarts with your voice.
3. **The restart.** The gateway leaves a note for the watchdog and ends the session. The watchdog
   says on Telegram that a restart was requested ("a restart was requested by voice; the
   controller restarts now", or "by telegram" when your words came from there), then that the
   gateway is shutting down, with the statistics of its running time ([8.5](#85-statistics)),
   starts it again at once, without a pause, and does not count it as a crash.
4. **Ready message.** A Telegram message says when the controller is ready again, if Telegram is
   set up ([8.2](#82-the-watchdog)).

What survives:

- **Worker runs:** detached; the new gateway follows them and reports their results.
- **Queued tasks:** in `.state/workers.json`; the new gateway starts them in their order.
- **Open decisions:** in `.state/jobs.json`, with your answers.
- **Requests:** kept in `.state/requests.json`. Answers given before the restart stay deliverable.
  An unfinished request ends with a note to say it again; a question to you stays open, and you
  can still answer it. A worker result the old controller had not answered goes to the new one
  again.
- **What is open, for the new session:** once it is connected, the gateway sends it one event with
  `kind="summary"`: open decisions, queued tasks, runs going, requests not finished, and the
  requests the restart ended. The controller works from it instead of memory files. Its reply to
  it is for the gateway only: no news, no Telegram.
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
| "Tell the alpha worker to fix the typo in the README." | The worker commits on a `voice/` branch, pushes and opens a pull request (in Docker: depends on the level); you hear that it is out |
| "Open it as a draft." / "Ja" to "Es folgt noch die Übersetzung, als Draft öffnen?" | `dispatch` with `draft`: that one pull request opens as a draft. The controller asks only when more tasks for the same pull request are queued or named; the last of them marks it ready |
| "Tell it to add a test for that too." | A follow-up in the same worker session, on the same branch |
| "Then also update the changelog in alpha." (while alpha works) | `dispatch=queued`: it starts by itself after the run, and you hear its result. With several runs per repository, the controller lets it run next to the other in a worktree of its own when it needs nothing from it, and says so: "It runs in parallel to the test fix." |
| "Stop the second alpha run." / "Stop it for good." | `stop_worker` with that task; a run in a worktree goes back to the queue and resumes, unless you say to stop it for good |
| "What is the alpha worker doing?" | `worker_status`, with the queue there |
| "Stop the alpha worker." | `stop_worker`; the next queued task there starts |
| "Forget the changelog task." / "Stop alpha and drop the rest." | `stop_worker` with `drop` and the task's id, or with `"all"` |
| "What is open?" / "Is anything waiting for me?" | `open_items`: open decisions, queued tasks, runs, unfinished requests; the controller answers from it |
| "How did it go today?" / "What did the workers cost?" / "Statistics of all time." | `stats`: since this start, or with `all_time` of all time; the controller answers in two or three sentences, details when you ask ([8.5](#85-statistics)) |
| "Leave the commits in alpha as they are." | `resolve_decision` with your words closes the push decision; alpha's queued tasks go on |
| "Clone drawio-mcp from alderg." | Above `confined`: `clone_repo`; you hear when it is there |
| "Delete the folder old-experiment." | Above `confined`: `delete_path` says what would be lost, the controller asks; you say yes, then confirm the approval |
| "Look up the release notes of the latest Claude Code." | With [work folders](#work-folders) on, at every level: a run in a new work folder looks it up. Without them, only at `unrestricted`: the controller hands it to a subagent in the background and stays free; you hear the result as news |
| "Rechne mir die Fahrtkosten nach Basel aus." / "Draft a reply to the landlord." | With work folders on: `dispatch` with `scratch/new`; you hear the result, and the files are in that folder at the desk. "Make it shorter." goes to the same folder |
| "Is anyone reviewing pull request 12 in alpha?" / "Did the last CI run on main pass?" | The controller answers itself with read-only `gh` |
| "Request a review for pull request 12 in alpha." | Only on your word: the worker reviews the diff and posts a review, or adds the person you name as reviewer |
| "Fix the review comments on pull request 12." | Without a word from you while `VOICE_GW_AUTO_FIX_REVIEWS` is on, the default: the gateway queues the fix itself when new review comments ask for changes, and you hear it as news ([below](#automatic-fixes-for-review-comments)). Said anyway, or with the setting off, or after the automatic rounds are used up: the worker fixes them, runs the tests, pushes to the same branch, replies on each thread, and says what is left open |
| "Merge pull request 12 in alpha." | The controller asks back with the title and the method; after your yes, `gh pr merge` raises an approval; you confirm a second time |
| "Push it straight to main." | Only in Docker at level `full`: `dispatch` with `direct`. Otherwise the controller says why it stays a pull request |
| "Emergency stop!" | The kill switch locks before anything reaches the controller ([5.9](#59-the-kill-switch)) |
| "Unlock the kill switch." / "Entsperre den Kill Switch." | With Telegram set up: `unlock`; the voice AI reads out why it locked, and a PIN of four digits comes to your Telegram chat, valid five minutes. Say it ("4 7 1 9"): `unlock` with the PIN unlocks it. Three wrong PINs leave only the server for that lock ([5.9](#59-the-kill-switch)) |
| "Restart the controller." | Restart through the watchdog after your yes ([8.3](#83-restarting-the-controller-by-voice)) |
| "Good night." / "I'm back." | `set_away`: [night mode](#night-mode) on until the end of the quiet hours, or off, with the summary of the night |
| "Do not disturb until tomorrow morning at 9." | `set_away` with `until`: night mode on, or longer or shorter if it is on, until 09:00 |
| "Keep going with the Simple Modern milestones in alpha tonight." | `standing_order`: until the end of the quiet hours the controller dispatches the next tasks there within that scope itself ([standing orders](#standing-orders)) |

**Work folders by voice**, once they are turned on ([work folders](#work-folders)), for a task
that needs no repository:

- **Start one** by saying the task without naming a repository: "Rechne mir die Fahrtkosten nach
  Basel aus." or "Draft a reply to the landlord." The controller sends what needs no repository to
  a new work folder and tells you it is on its way. To be sure, say so: "In a new work folder:
  compare the three phone plans." or "Neuer Arbeitsordner: …". At `unrestricted` that is how you
  get a run instead of the controller answering itself.
- **Follow up** in the same conversation: "Make it shorter." or "Und jetzt als Tabelle." continues
  in the same folder and Claude session. Later, name its topic, "the folder with the travel costs":
  the controller looks among the last work folders with `worker_status`. Something new, or "a new
  work folder", gets a folder of its own.
- **While it runs:** "What is the work folder doing?" and "Stop the work folder." work as for a
  repository. When every run slot is taken, it waits in the queue.
- **The result** comes as news: what the files hold, not where. At the desk they are in
  `~/voice-scratch/<date>-<id>` (`VOICE_GW_SCRATCH_ROOT`), for 60 days after the last run
  (`VOICE_GW_SCRATCH_DAYS`, `0` for good); copy out what you want to keep. There is no git, so no branch, no pull
  request and no question about pushing.

**Your words.** The controller passes your words with every dispatch. If they are not from a voice
request of the last `VOICE_GW_DISPATCH_WINDOW` minutes, the gateway starts nothing and the
controller asks you first ([5.4](#54-approvals-by-voice)), unless a [standing order](#standing-orders)
you gave by voice covers the task. When a worker result or a review asks for something, the
controller is told to tell you and let you decide. The one exception is your standing instruction
to fix review comments, which the gateway carries out itself, not the controller
([below](#automatic-fixes-for-review-comments)).

**Open items** (`src/ledger.mjs`), so that nothing is forgotten while you drive:

- **Every question is an open decision,** kept in `.state/jobs.json`: the controller's questions,
  of kind `push`, `merge`, `restart`, `delete` or `other`, and what the gateway raises itself: a
  push decision after a run that left commits on no remote or uncommitted files
  ([5.5](#55-workers-on-this-computer-or-in-docker)) or a stop, one for a queued task that could
  not start or that the kill switch took out of the queue, and one for the gateway's own checkout.
- **Pending, asked, answered, closed.** Your answer to the question ("(Answer to <id>) …"), by
  voice or [by Telegram](#58-the-telegram-fallback), is kept with it, and a question back on your
  answer is the same decision. It closes when the follow-up
  dispatch with your answer starts, when the controller replies "done" to your answer (unless that
  follow-up still waits in the queue), or with `resolve_decision` and your words. When you decide
  in a new request instead of answering, the controller closes it with `resolve_decision`.
- **The controller has to ask.** It cannot reply "done" to a request whose decision was never put
  to you; the reply tool says why.
- **The queue waits.** While a decision about a repository is open, its tasks wait
  (`dispatch=queued … reason=decision`); the follow-up for your answer goes first.
- **Reminders.** A decision you were never asked about, or a question you have not answered, comes
  back to the controller after `VOICE_GW_REMIND_MINUTES` (30), at most three times, also one that
  belongs to no request yet; none while the kill switch is locked. It asks you, and you hear it as
  news.
- **What is open?** `open_items` lists everything in one call. At every start of the controller
  session, the gateway sends it the same list as an event, so a restarted controller needs no
  memory files.
- **Texts.** These lists hold what the gateway, the controller and you said; of a worker result
  only its ids. The controller's tasks and questions may quote a worker or a pull request, so the
  summary, reminder and queue events come with `trusted="no"`.

**Pull requests and reviews:**

- **Before a push** that opens a pull request (a push decision, a public repository), the
  controller asks only whether to open it ("Soll ich den PR öffnen?"), without a word about drafts:
  it opens ready for review, and its reviews start at once. A draft only when you say so, or when
  more tasks for the same pull request are queued: then it asks "Es folgt noch X, als Draft
  öffnen?".
- **After a push** you hear only that the pull request is out, and which one. The controller never
  offers a review.
- **The watch.** The gateway takes the pull request URLs in a run's output and checks with `gh`
  that each is open on a `voice/` branch, comes from the repository itself (not a fork), and was
  opened by the account `gh` is logged in as. It watches those: every `VOICE_GW_PR_POLL` seconds
  (60), five times as long after 15 looks. Without a `gh` login it watches nothing. In Docker, a
  pull request opened with the container's token is watched only if that token belongs to the
  same account.
- **Later pushes.** A later run that names the pull request watches it anew, from the start, also
  after the watch stopped, so the reviews and checks that run again reach you. One that pushed to
  it or marked it ready without naming it is caught too: when a run ends, the gateway looks again
  at the last three pull requests it watched for that repository, and one whose head commit or
  draft state changed while the run went counts as the run's.
- **What becomes news:**
  - finished checks, once per push;
  - new reviews and comments, except those of the account `gh` is logged in as;
  - their text only from the repository's owner, members and collaborators. Of anyone else, which
    as a rule includes bots such as Copilot, you hear who reviewed or commented, not what;
  - the fix the gateway queued for them, or why it queued none ([below](#automatic-fixes-for-review-comments));
  - you hear them as a sentence or two. The controller gets them marked `trusted="no"`.
- **When the watch stops:**
  - nothing shows up in the first five looks;
  - the pull request is merged or closed;
  - after `VOICE_GW_PR_WATCH_HOURS` (24); a later push starts it again (above).

#### Automatic fixes for review comments

Your standing instruction: review comments on the workers' pull requests are fixed without
asking, round after round (`VOICE_GW_AUTO_FIX_REVIEWS`, on by default; the setup assistant offers
it). The watch above does it, in code (`src/pulls.mjs`, `Workers.reviewFix`):

- **What starts a fix:** new inline comments, reviews that request changes or have a text, and
  comments with a text, from the repository's owner, members and collaborators, or from a review
  bot of `VOICE_GW_REVIEW_BOTS` (the Claude app, `claude`, and Copilot's reviewer). A login on that
  list counts only where GitHub does not say it is a person. Anyone else's reviews and comments
  start nothing, as their text is not forwarded either. Approvals without a comment start nothing.
- **The fix** is a task in the gateway's own words, naming the pull request and its branch, never
  what the reviews say: that is what the controller sees. Its prompt says that the gateway queued
  it, with no words of yours, and quotes the comments that asked for it, as the gateway saw them
  then: those of collaborators and review bots only, as their words from GitHub, at most 20, each
  cut at 1,500 characters. The worker still reads the open threads on GitHub, for newer ones and to
  reply there, under its rules, and acts only on those of collaborators and review bots.
- **Through the queue,** always, as the follow-up of the run that pushed the pull request: in its
  worktree if it had one, otherwise in the checkout. So it waits like any task: behind a run going
  there, while an open decision holds the repository, for a free run slot. One that waits already
  takes newer comments too, into its prompt as well. While the kill switch is locked nothing is
  queued, and the lock empties the queue as always.
- **In a new session** (`VOICE_GW_AUTO_FIX_FRESH`, on by default): the session of the run that
  pushed was often several hundred thousand tokens, which every call of the fix read again, for a
  few small changes. So the fix starts a session of its own in that run's place, and its prompt
  carries what it needs from that run: its task (in a later round, the task the pull request was
  made for), its last result, and to look at the pull request and its branch first. The next
  follow-up there continues the fix's session. `0` resumes the session of the run that pushed, as
  before.
- **Rounds.** The fix pushes, the automatic reviews run again, and new comments start the next
  round. At most `VOICE_GW_AUTO_FIX_ROUNDS` (3) per pull request; then the news says they are used
  up, and the controller tells you. A further fix takes your word, and a run you dispatch that
  works on the pull request gives it its rounds again.
- **What you hear:** the news about the review, which says that a fix was queued (with
  `fix="q…"` for the controller, which dispatches nothing for it), and later the fix's result,
  both gathered into the digest below while they are routine.
  `open_items`, `list_workers` and `worker_status` show such a task as "from the review of pull
  request 12"; its runs count in the statistics like any other.
- **Off,** with `VOICE_GW_AUTO_FIX_REVIEWS=0`: news only, and a fix only when you ask for it.

#### The digest of routine review news

Within a few hours of automatic rounds, one event each made dozens of near-identical news items:
"checks passed", "Claude commented, round 2 queued", "nothing needed fixing". So the gateway
gathers the routine ones and tells the controller once, in one short summary
(`VOICE_GW_REVIEW_DIGEST`, `src/digest.mjs`), by fixed rules in its code:

- **Routine:** checks that all finished without a failure; with automatic fixes on, reviews and
  comments that ask for nothing (approvals, others' text, which is not forwarded) or that a fix
  was queued for, or that a fix waiting already takes; and an automatic fix that ended done, pushed
  nothing to its pull request (its head did not move during the run, as `gh` shows it right after),
  left nothing on no remote or uncommitted, and does not end with a question. With automatic
  fixes off, only passed checks.
- **Still one by one:** failed checks, comments that ask for changes with no fix queued (the
  automatic rounds used up, the kill switch locked), a fix that pushed changes, failed, asks or
  left something, and every run you or a standing order dispatched. Such an event takes along the
  routine items of its own pull request that were not told yet, so the order stays.
- **When:** once the news has been quiet for `VOICE_GW_REVIEW_DIGEST` minutes (10), at the latest
  `VOICE_GW_REVIEW_DIGEST_MAX` minutes (30) after its first item; not before the controller is
  connected, nor in a standby. It reaches the controller as one event, `kind="digest"`,
  `trusted="no"`, with `items`, `pull_requests` (owner/name#number), `fix` (the fixes queued) and
  `tasks` (the fix runs) as attributes and one line per item with its time; the controller answers
  it once, in two or three sentences, and you hear that as news.
- **Nothing lost:** the items wait in `.state/digest.json`, and leave it only once their digest is
  a request, which goes to the controller again after a restart if it was never answered.
  `open_items` and the start-up summary say how many wait, and when they go.
- **Off,** with `VOICE_GW_REVIEW_DIGEST=0`: one event each, as before; items gathered before go
  once as one digest at the next start.

#### Several gateways, and the standby after a disconnect

With several gateways, each a connector in claude.ai (this computer, a Raspberry Pi, a Mac), they
all look alike to the voice assistant (`src/presence.mjs`):

- **Every answer of the connector starts with one line** that names the gateway and says whether to
  use it: `Gateway sky (Mac): active`. The name is `VOICE_GW_NAME`, by default the computer's, the
  one in the gateway's Telegram messages, with the kind of computer (Mac, Raspberry Pi, Linux); a
  name with its own brackets gets none added. `status` gives it first.
- **Active** means: a controller session is connected to the gateway and the kill switch is not
  locked. **Inactive**, with what then:
  - on standby by its settings (`VOICE_GW_STANDBY=1`, a test install for example), or in standby
    after the connector was disconnected (below): `…; use another connector`, the only case that
    sends the voice assistant elsewhere;
  - the kill switch locked: `Gateway sky (Mac): inactive, kill switch locked; it can only be
    unlocked at the computer`, or, while the [unlock in voice mode](#59-the-kill-switch) is open,
    `…; it is unlocked at the computer, or with unlock and a PIN from Telegram`; never another
    connector, which would carry the work past an emergency stop;
  - no controller connected, mostly while it starts or restarts: `…; it is starting or not
    running; try again in a minute`.
- **While inactive, `send` and `ask` hand nothing over** and say so: with a locked kill switch as
  before (`[state=locked]`), otherwise `[state=inactive]`, with the same advice as the line. So no
  request waits for a controller that is not there; `status`, `get_reply` and `emergency_stop`
  work in every state, and `unlock` in every state but a standby.
- **The connector's instructions and every tool description** name the gateway, and a standby by the
  settings; the instructions and `status` tell the voice assistant to call `status` on its
  connectors first and to use an active one, and the instructions to switch connectors only when an
  answer says so, and that a locked kill switch is unlocked only at the computer, or, with Telegram
  set up, also with `unlock` and a PIN from Telegram, for which they have a rule of their own. They
  are fetched when the connector connects, so the live state is only in the answers.

**The standby after a disconnect** (`src/standby.mjs`, `VOICE_GW_DISCONNECT_STANDBY`, on by
default). A connector removed in claude.ai goes on calling the address without a token when a
voice session starts, and an open question of the controller would go on to Telegram as reminders.
So the gateway notices the disconnect and switches itself off:

- **What counts as a disconnect:** the connector revokes its token at the gateway's revocation
  endpoint (RFC 7009, `/oauth/revoke`, named in the sign-in metadata), or its grant is revoked at the
  computer (`node scripts/pair.mjs revoke`), and no connector grant is left; or voice requests from
  Anthropic's addresses without a token, or with one the gateway does not know, while the last
  connector grant has not been used, by a call or a refresh, for `VOICE_GW_DISCONNECT_UNUSED` (10)
  minutes, and then for `VOICE_GW_DISCONNECT_GRACE` (15) more minutes neither a use nor a new
  sign-in follows. The hourly refresh never counts: it comes with the expired token, which the
  gateway knows, and is itself a use. A connector added again signs in within a pairing code's ten
  minutes, which the grace waits for. Local programs, other addresses and a gateway that was never
  connected never count.
- **First one message,** on Telegram ("the connector was disconnected (…), I am switching off now")
  and as an event to the controller. Then the worker runs stop, their results wait, and nothing new
  starts; a run in a worktree goes back to the queue. The queue and the open decisions stay as they
  are. No reminders, no Telegram fallback, no news about pull requests, and no alerts: suspicious
  requests are only counted, for at most one summary a day; a successful sign-in still goes out at
  once. The connector's answers say `inactive, connector disconnected, in standby`. The standby
  holds across a restart (`.state/standby.json`).
- **The controller session stays running, idle:** the gateway runs inside it, and so do the sign-in
  and the pairing codes (`scripts/pair.mjs`, the setup page) that a reconnect needs. Ending the
  session would take them along, and with the development flag the start after it would wait at the
  terminal for the channel's confirmation.
- **A new sign-in wakes it up:** one message that it is back, the controller gets an event and what
  waited (the stopped runs' results, the open items), and the queue goes on.
- **Off,** with `VOICE_GW_DISCONNECT_STANDBY=0`: the gateway stays on, as before.

A worker's checkout must not be used at the desk while it runs there: workers switch branches in
your checkouts. A worker never commits, stashes or discards changes it did not make.

#### The Claude usage limit

When the account's usage limit is reached (the 5-hour or weekly limit, a per-model one, a spend
cap), nothing can run until it resets. The gateway waits it out by itself and goes on afterwards
(`src/limits.mjs`):

- **How it sees it:** Claude Code ends such a turn with an API error, in a worker run's
  stream-json (`claude -p`) and in the controller's transcript alike: `error: "rate_limit"`,
  `api_error: "usage_limit_reached"` with `api_error_params.rate_limit_info` (`resetsAt` in Unix
  seconds, `rateLimitType`), a `rate_limit_event` with `status: "rejected"`, and the text "You've
  hit your 5-hour limit · resets 3pm (Europe/Zurich)". Older versions wrote "Claude AI usage limit
  reached|<seconds>". An overloaded or throttled API (`error: "overloaded"`, or `"rate_limit"`
  without `usage_limit_reached`, after Claude Code's own retries) counts as a shorter wait of the
  same kind. Only API errors count, never what a worker writes about rate limits.
- **Usage credits are no limit:** with usage credits on (once "extra usage"), Claude Code goes on
  past the plan's limit by itself, headless runs too, and bills the credits. Its
  `rate_limit_event` then still says `status: "rejected"`, but with `overageStatus: "allowed"`
  (or `"allowed_warning"`) and `isUsingOverage: true`, so such an event counts only when the
  credits are refused too: `overageStatus: "rejected"` or none, or `errorCode:
  "credits_required"`. A run on credits goes on undisturbed, and nothing waits or is held. The
  gateway notes it once in its log, in `list_workers` (`usage=credits`, `Credits: …`) until the
  plan's reset, and in the statistics ("partly on usage credits"). Claude Code then keeps the
  prompt cache 5 minutes instead of an hour, except in the workers' main conversation, which the
  gateway keeps at an hour (`VOICE_GW_WORKER_CACHE_TTL`,
  [5.5](#55-workers-on-this-computer-or-in-docker)); the statistics say how many runs had the
  5 minutes. When the credits or their monthly spend limit run
  out, the run fails at once ("You're out of usage credits · resets 3pm", "You've hit your
  monthly spend limit · … · your 5-hour limit resets 3pm"), and that is a wait as below, until
  the plan's reset or the spend limit's (`overageResetsAt`), whichever comes first.
- **A worker run that meets it** goes back to the queue, in front for its repository, with its
  session, and its worktree if it had one, as a run interrupted by a restart does; in its checkout
  too, where what it found at its start still counts for the look at the end, so what it left is
  the task's. No result event, no push decision, nothing counted as failed (the statistics say
  "held up by the usage limit"), and it does not count as one of the three interruptions a run in a
  worktree may have. It resumes with a line that says so, once the wait is over.
- **The wait:** until the reset time Claude Code gives (from `resetsAt`, else from the text, in the
  computer's time), at least a minute; without one, 15, then 30, then 60 minutes, until a run gets
  through again. Per account: the workers on this computer, those in a container (its own login),
  and the controller session. Nothing new starts on an account that waits; `dispatch` answers
  `queued` with `reason=usage`, and the queue goes on by itself afterwards. Kept across a restart
  (`.state/limits.json`).
- **What says so:** one Telegram message when the wait starts, one when it ends; `list_workers`
  (`usage=waiting`), `worker_status`, `status` (`Waiting: …`), `open_items` and the start-up summary
  ("The gateway now: …"), and the first line of every connector answer:
  `Gateway sky (Mac): active; the workers on this computer wait for the Claude usage limit until
  03:00, when it resets`. The gateway stays active.
- **The controller session:** the workers on this computer use its login, so it counts as waiting
  with them. The gateway also follows its own transcript (`CLAUDE_CODE_SESSION_ID`, which Claude
  Code gives the gateway, in `<CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl`, every
  `VOICE_GW_TRANSCRIPT_POLL` seconds). Before, an event that came while the controller was at the
  limit started a turn that failed at once, and was never answered. Now, while it waits, events for
  it are held in the gateway, and those it got since its last answer are marked to go again; the
  voice assistant hears that a request waits and reaches Claude Code at the reset
  (`[state=sent … held=usage]`), without the "has not picked up" hint. The queue and the worker runs
  on other accounts go on. Its first tool call, or the reset, ends its wait, and the held events go
  to it in their order, marked `resent="yes"`.

#### Night mode

The gateway can work through the night without you (`src/night.mjs`): it decides what it can,
defers what needs you, goes on with other work meanwhile, and tells you in the morning.

- **On:** in the quiet hours, `VOICE_GW_QUIET_HOURS` (for example `23:00-07:30`, in the computer's
  time zone), and when you say so: "Good night" by voice (the controller's `set_away`, on your words
  from a recent voice request, as `dispatch` checks them, or from a request or an answer you typed
  on Telegram), or `/night` or "good night" on Telegram.
  Then it lasts until the end of the quiet hours, or 12 hours without them.
- **Until a time you name:** "until tomorrow morning at 9" by voice, and the controller passes the
  end to `set_away` as `until`: a clock time such as `09:00`, in the computer's time zone as the
  quiet hours are, the next time it comes, or a date and time such as `2026-11-03T09:00`; on
  Telegram `/night 09:00`. It must lie in the future and at most 48 hours ahead, else nothing
  changes and the controller hears why. Said again while night mode is on, the new end counts,
  also to make it longer. The end you name is the end: later than the quiet hours, night mode
  holds past them; within them, it ends them then, as "I'm back" would, unless they just begin
  at that time. Kept with the rest in `.state/night.json`.
- **Off:** at the end of the quiet hours or of the time you named, or with "I'm back" by voice,
  `/back` or "I'm back" on Telegram, which also ends the rest of the quiet hours; the next ones
  count again.
- **While it is on:**
  - Worker runs started in it get a rule: decide what the concept, the task or sensible defaults
    allow, choosing the conservative option; note each such choice as an assumption, in the report
    and the pull request description; when something really needs you, skip that part, note it as
    a deferred question and carry on with the rest, instead of ending with a question. The report
    ends with "Assumptions:" and "Deferred questions:".
  - Questions and decisions that still come wait for the morning, holding only what they hold by
    day: their repository, or their worktree, never other work. No reminders.
  - Telegram carries alarms: the kill switch, a standby, a wait for the usage limit, once each,
    and the warning when a run's write outside goes to [quarantine](#quarantine). Approval
    requests still go there at once, as by day ([5.8](#58-the-telegram-fallback)): Claude Code
    waits on them, also at night. No questions or news; the PIN when you ask to unlock the kill
    switch in voice mode still comes, and the controller's replies to what you write there
    yourself still come back.
  - The controller hears that the night began (an event of the gateway), goes on with what is
    queued, and chains work within your [standing orders](#standing-orders).
  - `status` and `open_items` say so.
- **In the morning:** one summary, on Telegram and as an event for the controller, which tells you
  as news: what was done (each run that ended, with its pull request), the assumptions made, the
  deferred questions, the decisions waiting, and the waits for the usage limit. The night's news
  and its questions on Telegram count as told then. A night that ended while the gateway was down
  gets its summary at the next start (`.state/night.json`).

#### Standing orders

A dispatch takes your words from a voice request of the last minutes, so at night nothing new
could start. A standing order lets the controller chain work while you are away
(`src/orders.mjs`):

- **You give it by voice:** "Keep going with the Simple Modern milestones in alpha tonight." The
  controller makes it with `standing_order`: a repository (or `scratch/new` with work folders on), a
  scope in your words, and an expiry, by default the end of the night or the next quiet hours,
  otherwise 12 hours, at most 24. It takes your words as `dispatch` does: never typed ones, and
  never a worker's or GitHub's, which can neither make nor extend an order. A new one takes new
  words.
- **While it holds,** the controller may dispatch tasks for that repository within that scope
  citing the order (`order="o2ab"`) instead of fresh words, one after the other as the work needs.
  The gateway checks the repository and the expiry, logs each, and the worker reads the scope and
  stays within it, noting what falls outside as a deferred question. `open_items` shows the order
  with the tasks dispatched under it.
- **What still stops everything:** the kill switch, which also ends every order (after an alarm,
  you say again what may go on), a standby, and the wait for the usage limit, during which its
  tasks wait in the queue.
- **Ended** when it runs out, or with `end_order` when you say so or its work is done
  (`.state/orders.json`).

### 8.5 Statistics

The gateway counts over its running time, and keeps all-time totals across starts
(`src/stats.mjs`). Nothing is looked up for it: it counts what the gateway sees anyway.

| Figure | Where it comes from |
|---|---|
| Running time, starts, and what each start came after (a crash, a restart by voice, of the service) | The gateway's start, and the watchdog's note `restarted` |
| Voice requests, in conversations (a new one after 10 minutes without a request); questions to you, answered, and how long you took (typical and longest); approvals by voice | The requests, the controller's replies with state "question", the answers "(Answer to …)" (`store.mjs`) |
| Decisions raised, by kind and whether the gateway raised them itself; closed, by whom, and how long they were open | `ledger.mjs` |
| Worker runs by outcome (done, failed, stopped), follow-ups, in worktrees, in work folders, interrupted and queued again; by repository (top three, with time and cost); worker time, typical and longest run | The runs as they end (`workers.mjs`); every work folder counts under "work folders" |
| The most runs at once, and the time with two or more; the same in one repository | The runs' starts and ends |
| Queue: tasks that waited, typical and longest wait; tasks that could not start; dropped | The queue |
| Tokens in (with cache reads and writes) and out (with thinking), cost at API list prices, turns, tool calls, subagents | Each run's output, which the gateway follows anyway: per result `model_usage_since_last_result` (the usage since the result before, with the cost; `total_cost_usd` adds up the whole session, earlier runs included), the tool calls, and the `Agent` (or `Task`) calls for subagents |
| Commits made during a run, runs that pushed, files and lines changed; pull requests opened and updated; files made or changed in work folders | The kill switch's size check at the end of each run (`guard.mjs`), the pull requests the gateway watches (`pulls.mjs`), the check of a work folder |
| Checks finished on those pull requests (and with failures), reviews (approved, changes requested), comments | The watch on pull requests |
| Kill switch locks, and by what | `killswitch.mjs` |

**Not counted:** the controller session's own tokens. They are only in its transcript, whose cost
line Claude Code writes when the session ends, and the sum of its messages does not match that
line; neither is cheap and reliable while the session runs. The cost is Claude Code's at API list
prices; on a subscription it is not what is billed. What makes up the workers' cost, and the
settings that keep it down: [5.5](#55-workers-on-this-computer-or-in-docker).

**Where you see them:**

- **By voice:** "How did it go today?", "What did that cost?", "Statistics of all time." The
  controller calls `stats` (with `all_time` for all time) and answers from its first sentences:
  "In 5 h 20 min: 12 worker runs (10 done, 1 failed, 1 stopped), 3 h 10 min of work, at most 3 at
  once. 31 commits and 4 pull requests opened, with 2.2 million tokens, about 23 dollars at API
  list prices. 25 voice requests, 6 questions to the driver, answered after about 4 min." The
  details follow in the tool's answer, one line per subject, for when you ask.
- **On Telegram:** `/stats` for this running time in detail, `/stats all` for all time.
- **When the gateway shuts down,** on Telegram: on a stop, when the session is quit, and before a
  restart on purpose, between "a restart was requested" and "ready again"
  ([8.2](#82-the-watchdog)). Not after a crash, which keeps its single message, so a crash loop
  sends no statistics at all:

  ```text
  cc-voice-gateway on <host>: the gateway is shutting down now for the restart. Its statistics:

  In 5 h 20 min: 12 worker runs (10 done, 1 failed, 1 stopped), 3 h 10 min of work, at most 3 at once. 31 commits and 4 pull requests opened, with 2.2 million tokens, about 23 dollars at API list prices. 25 voice requests, 6 questions to you, answered after about 4 min.

  All time, since 2026-10-20 (14 starts): 140 worker runs, 52 h of work, 31 million tokens, about 410 dollars at API list prices, 60 pull requests opened.

  A message follows when it is ready again.
  ```

  Under the watchdog the watchdog sends it, as only it knows whether the session was stopped,
  restarted or crashed (`scripts/stats.mjs --shutdown`); it waits at most three seconds for the
  gateway's last save. Without the watchdog the gateway sends it itself as it ends, with a limit of
  three seconds; not when it ends for an error, such as its port taken.
- **At the desk:** `node scripts/stats.mjs` (the last running time), `node scripts/stats.mjs --all`.

**The file** `.state/stats.json` (0600): this running time and all time, written atomically a few
seconds after a change, every five minutes, and as the gateway ends; a crash loses only those
seconds. It holds counts, sums, maxima and the last 100 durations per figure for the typical
values (medians), repository names and the process id of the controller session it belongs to:
no texts, prompts or secrets. A start takes the totals from it and counts its own running time
from zero; a file that cannot be read starts the totals again, with a line in the log.

### 8.6 Connections and testing at the desk

```bash
node scripts/pair.mjs                # pairing code for the sign-in page, valid five minutes
node scripts/pair.mjs --minutes 10   # the same, valid up to ten minutes
node scripts/pair.mjs list           # connected clients and when they last called
node scripts/pair.mjs revoke <id>    # disconnect one; "revoke all" disconnects every client
node scripts/fake-voice.mjs          # play the voice AI against the local gateway; "unlock" and "unlock <PIN>" too
npm test                             # both ends without Claude Code or a phone
```

`pair.mjs` and `fake-voice.mjs` talk to the running gateway, so the controller must run. The setup
assistant's page shows pairing codes too, valid ten minutes (section 10, "Connect the Claude app"). A
connector unused for more than 30 days must sign in again. `.logs/gateway.log` has one line per
connector call and sign-in step, and one per HTTP request with the caller's address
(`http 160.79.106.3 funnel POST /mcp 200`); it shows whether and how far the voice AI got, and who
else knocked.

### 8.7 Getting changes out of the container

See [4.5](#45-pushing-from-a-read-only-container). At levels `pr` and `full` the container pushes
by itself; the clean clone still works for trying a branch here first.

### 8.8 Configuration

Settings come from the environment, then from `.secrets/gateway.env`. Claude Code starts the
gateway, so environment variables for it go into the `env` block of `controller/.mcp.json`. The
gateway reads them at its start: restart the controller after a change. Under the watchdog, every
start reads `.secrets/gateway.env` again, and the log line `watchdog: settings from …` shows each
setting with where it came from.

**The worker limits and the path grants apply at once.** The gateway watches `.secrets/gateway.env`
(`src/live.mjs`). Once a change has settled for a second or two, it reads the file again and applies
`VOICE_GW_MAX_WORKERS` and `VOICE_GW_MAX_WORKERS_PER_REPO` without a restart, as it would at a
start: raised per repository, the controller hears which queued tasks could now run next to
others; lowered, runs going run to the end and nothing new starts above the limit. So does
`VOICE_GW_PATH_GRANTS` ([path grants](#path-grants)), for the next write of every run, with a log
line that names the grants now and one for each entry it ignored. Every other
changed setting is logged as counting from the next start. A value set in the environment from
outside still wins over the file, and the log says so; one the watchdog's start script exported
from the file does not, as it lists those names in `VOICE_GW_SETTINGS_FROM_FILE`
(`scripts/settings.sh`). Without that list, when Claude Code or you start the gateway yourself, a
value in the environment that equals the file's at the start counts as the file's. A file that cannot be read, is gone or looks half written
(its last line without an end) keeps the limits and the grants as they are; a value that is no whole number from
1 to 100 is ignored, with a log line. The setup assistant says when a running gateway takes its
limits at once.

**Gateway** (`src/config.mjs`):

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_PORT` | `8787` | Local HTTP port |
| `VOICE_GW_HOST` | `127.0.0.1` | Bind address; keep loopback |
| `VOICE_GW_SECRETS_DIR` | `.secrets` | Secrets, settings file, admin socket |
| `VOICE_GW_STATE_DIR` | `.state` | Worker state and queue, run output, requests, open decisions, pull request watches, usage limit waits, night mode, standing orders |
| `VOICE_GW_SELF_CHECKOUT` | This checkout | The checkout whose uncommitted changes and commits on no remote a "done" reply mentions ([5.5](#55-workers-on-this-computer-or-in-docker)); empty: none. Tests use a stand-in |
| `VOICE_GW_REMIND_MINUTES` | `30` | Minutes before a decision you were never asked about, or a question you have not answered, comes back to the controller as a reminder, at most three times ([8.4](#84-voice-commands)) |
| `VOICE_GW_LOG_FILE` | `.logs/gateway.log` | Empty: stderr only |
| `VOICE_GW_LOG_MAX_MB` | `10` | Past this size the log moves to `gateway.log.1`, replacing the one before |
| `VOICE_GW_OAUTH_HOSTS` | `claude.ai,claude.com` | Hosts allowed in redirect addresses and client ID metadata documents |
| `VOICE_GW_MCP_ALLOW` | `160.79.104.0/21`, Anthropic's | Ranges (CIDR) or addresses that may call `/mcp` through the tunnel, comma-separated; `any`: no limit, for a tunnel without `X-Forwarded-For` ([5.2](#52-the-voice-endpoint-and-oauth)) |
| `VOICE_GW_PERMISSION_RELAY` | on | `0`: approvals only at the terminal |
| `VOICE_GW_DEFAULT_WAIT` | `25` | Seconds `get_reply` waits by default |
| `VOICE_GW_MAX_WAIT` | `40` | Upper limit for `get_reply` and `ask` |
| `VOICE_GW_ASK_WAIT` | `8` | Seconds `ask` waits for a quick answer before it returns still running; at most `VOICE_GW_MAX_WAIT` |
| `VOICE_GW_HINT_AFTER` | `20` | Seconds without a reaction from the controller before a diagnostic hint |
| `VOICE_GW_WORKER_ROOT` | The folder holding this repository | Every git repository directly in it has a worker |
| `VOICE_GW_WORKER_SELF` | off | `1`: this repository's own checkout is a worker on this computer too |
| `VOICE_GW_CONTROLLER_LEVEL` | `confined` | `clone-delete` or `unrestricted` ([5.3](#53-the-controllers-confinement)); the gateway, the confine hook and the start script read it |
| `VOICE_GW_DISPATCH_WINDOW` | `30` | Minutes a voice request counts for `dispatch`: only words from requests this recent start a run |
| `VOICE_GW_MAX_WORKERS` | `2` | Runs at the same time, in all; every run of a repository counts. Applies at once when the settings file changes, without a restart |
| `VOICE_GW_MAX_WORKERS_PER_REPO` | `1` | Runs at the same time in one repository; further runs work in git worktrees of their own ([several runs per repository](#several-runs-per-repository)). Applies at once when the settings file changes |
| `VOICE_GW_WORKER_TIMEOUT` | `360` | Minutes before a run is stopped; `0`: no time limit |
| `VOICE_GW_RUN_FOLDER_DAYS` | `7` | Days after its session's last run before a run's [run folder](#55-workers-on-this-computer-or-in-docker) in `.voice-runs` is removed, never while a run of its repository goes or the kill switch is locked; `0`: never |
| `VOICE_GW_WORKER_MODEL` | Claude Code's default | `--model` for every worker run, host and Docker |
| `VOICE_GW_WORKER_EFFORT` | Claude Code's default | `--effort`: `low`, `medium`, `high`, `xhigh`, `max` |
| `VOICE_GW_WORKER_CACHE_TTL` | `1h` | The prompt cache of every worker run's main conversation, host and Docker (`promptCacheTtl` in its `--settings`, [5.5](#55-workers-on-this-computer-or-in-docker)): `1h`, also on usage credits, where Claude Code's own choice is 5 minutes; `5m`; `auto` or `0`: Claude Code's choice. Any other value counts as `1h`, with a log line |
| `VOICE_GW_WORKER_AUTOCOMPACT` | `300k` | Tokens at which Claude Code compacts a worker's session, its subagents' too (`autoCompactWindow` in its `--settings`): from `100k` to `1m`, as `400k` or `400000`; `auto` or `0`: Claude Code's own window, about the model's whole context. Any other value counts as `300k`, with a log line |
| `VOICE_GW_CLAUDE_BIN` | `claude` | Claude Code for workers (inside the container in Docker mode) |
| `VOICE_GW_GH_BIN` | `gh` | GitHub CLI on this computer |
| `VOICE_GW_PR_DRAFT` | `0` | `1`: workers open their pull requests as drafts; `0`: ready for review |
| `VOICE_GW_SCRATCH` | `0` | `1`: [work folders](#work-folders) for tasks without a repository; any other value counts as `0` |
| `VOICE_GW_SCRATCH_ROOT` | `~/voice-scratch` | Where the work folders are made, on this computer; outside every git repository, this checkout and the repositories folder |
| `VOICE_GW_SCRATCH_DAYS` | `60` | Days after its last run before a work folder is removed, up to 365; `0`: never |
| `VOICE_GW_SCRATCH_DOCKER` | empty | The work folders' container; empty: their runs run on this computer |
| `VOICE_GW_DOCKER_SCRATCH` | `/scratch` | Where that container mounts `VOICE_GW_SCRATCH_ROOT` |
| `VOICE_GW_PR_POLL` | `60` | Seconds between looks at a watched pull request |
| `VOICE_GW_PR_WATCH_HOURS` | `24` | Hours before a watch ends |
| `VOICE_GW_AUTO_FIX_REVIEWS` | `1` | `1`: new review comments that ask for changes, from collaborators and review bots, get a fix the gateway queues itself ([automatic fixes](#automatic-fixes-for-review-comments)); `0`: only on the driver's word |
| `VOICE_GW_AUTO_FIX_ROUNDS` | `3` | Automatic fixes per pull request, until the driver dispatches something for it again |
| `VOICE_GW_AUTO_FIX_FRESH` | `1` | `1`: an automatic fix runs in the place of the run that pushed, in a new session, with that run's task and last result and the comments in its prompt ([automatic fixes](#automatic-fixes-for-review-comments)); `0`: it resumes that run's session, as before |
| `VOICE_GW_REVIEW_DIGEST` | `10` | Minutes of quiet before routine news about the workers' pull requests goes to the controller as one [digest](#the-digest-of-routine-review-news); `0`: one event each, as before |
| `VOICE_GW_REVIEW_DIGEST_MAX` | `30` | Minutes after its first item at the latest before the digest goes, however busy the news is |
| `VOICE_GW_REVIEW_BOTS` | `claude,copilot-pull-request-reviewer,copilot` | Review bots whose reviews and comments start a fix, by GitHub login without `[bot]` |
| `VOICE_GW_NAME` | the computer's name | The gateway's name in the first line of every connector answer, in its instructions and tool descriptions, with the kind of computer unless it has brackets of its own ([several gateways](#several-gateways-and-the-standby-after-a-disconnect)) |
| `VOICE_GW_STANDBY` | `0` | `1`: inactive on purpose, a standby install: the connector answers, says it is inactive, and hands nothing over |
| `VOICE_GW_DISCONNECT_STANDBY` | `1` | `1`: when the connector is disconnected, one message, then standby until a new sign-in; `0`: stays on |
| `VOICE_GW_DISCONNECT_UNUSED`, `VOICE_GW_DISCONNECT_GRACE` | `10`, `15` | Minutes: calls without a token count only after the connector's sign-in went unused this long, and the standby follows only if this many more pass without a use or a new sign-in |
| `VOICE_GW_TELEGRAM_AFTER` | `600` | Seconds without a voice call before questions also go to Telegram ([5.8](#58-the-telegram-fallback)); approval requests go there at once |
| `VOICE_GW_TELEGRAM_ANSWERS` | `0` | Telegram input, off by default ([5.8](#58-the-telegram-fallback)). `1`: a Reply to a question on Telegram, or a message with its code, reaches the controller as your answer, and approval requests are answered there with yes or no; `0`: off, questions and approvals are answered by voice only. `other`, its earlier middle value, counts as `1`; any other value as `0`. The setup turns it on with requests |
| `VOICE_GW_TELEGRAM_REQUESTS` | `0` | Telegram input, off by default ([5.8](#58-the-telegram-fallback)). `1`: any other message in your Telegram chat, no command and no answer, reaches the controller as a request of yours, as one by voice does, and its replies come back there; `0`: off, such a message is not passed on. Any other value counts as `0` |
| `VOICE_GW_TELEGRAM_CONFIRM` | `1` | With Telegram input on ([5.8](#58-the-telegram-fallback)): `1`, push, merge, restart and delete count there as by voice (`resolve_decision`, the follow-up `dispatch`, `dispatch` with `direct`, a confirmed `delete_path`, `restart_controller` with `confirm`), and with answers on, approval requests are answered there with yes or no; `0`: they take your voice, as before, and an answer there to such a question is not carried out. Any other value counts as `0` |
| `VOICE_GW_TELEGRAM_POLL` | `25` | Seconds one poll of the bot for `/stop`, answers and requests waits |
| `VOICE_GW_TRANSCRIPT_POLL` | `5` | Seconds between looks at the controller's own transcript for the usage limit ([the usage limit](#the-claude-usage-limit)) |
| `VOICE_GW_QUIET_HOURS` | empty | Night mode by the clock, as `23:00-07:30` in the computer's time zone ([night mode](#night-mode)); empty: only when you say good night |
| `VOICE_GW_NIGHT_POLL` | `30` | Seconds between looks whether the night began or ended |
| `VOICE_GW_TELEGRAM_API` | `https://api.telegram.org` | Bot API; tests use a stand-in |
| `VOICE_GW_FUNNEL_IDLE` | `0`, off | Minutes after the last voice call before the gateway turns the Funnel off ([7.3](#73-publishing-the-endpoint)) |
| `VOICE_GW_FUNNEL_PORT` | `443` | The Funnel's public port, for `scripts/funnel.sh` and the setup assistant: `443`, `8443` or `10000`, the only ones Funnel allows. Keep `443` for claude.ai's connector, which did not connect on 8443 in our test ([7.3](#73-publishing-the-endpoint)) |
| `VOICE_GW_FUNNEL_SCRIPT` | `scripts/funnel.sh` | What the gateway runs to switch the Funnel; tests use a stand-in |
| `VOICE_GW_DOCKER` | empty | Worker container; empty: workers on this computer |
| `VOICE_GW_DOCKER_REPOS` | `/repos` | The mounted folder inside the container |
| `VOICE_GW_DOCKER_BIN` | `docker` | Docker CLI |
| `VOICE_GW_ACCESS` | empty | `read-only`, `pr` or `full` for every repository; empty: detected |
| `VOICE_GW_GITHUB_API` | `https://api.github.com` | GitHub API for the level check |
| `VOICE_GW_KILLSWITCH` | `auto` | What locks the kill switch ([5.9](#59-the-kill-switch)): `auto`, the rules and the manual triggers; `manual`, only "emergency stop" by voice, `/stop` on Telegram and the controller's `raise_alarm`, while the rules only log what they would have done; `off`, nothing, every trigger is only logged. Another value counts as `auto` |
| `VOICE_GW_KILL_MAX_EDITS` | `500` | Kill switch: file edits in one run |
| `VOICE_GW_KILL_MAX_FILES` | `300` | Kill switch: files changed in one run |
| `VOICE_GW_KILL_MAX_LINES` | `30000` | Kill switch: lines changed in one run |
| `VOICE_GW_KILL_MAX_SCRATCH_FILES` | `10000` | Kill switch: untracked files in a run's helper folder `.voice-scratch` at its end, and file edits there, in its run folder and in the temporary folders; they count for none of the three above |
| `VOICE_GW_KILL_ALLOW_PATHS` | empty | More folders workers may write to, comma-separated |
| `VOICE_GW_PATH_GRANTS` | empty | Folders one repository's workers on this computer may write to as in the repository ([path grants](#path-grants)): `repository=folder`, entries separated by `;`, folders by `,`, such as `hauswache=/srv/wyze-events`. Checked strictly; an entry that is no such folder is ignored with a log line. Hidden files, links and git repositories there still lock. Not in Docker. Applies at once when the settings file changes |
| `VOICE_GW_KILL_CHECK` | `30` | Seconds between checks of the containers for a writable mount while the kill switch is locked |
| `VOICE_GW_MCP_JSON` | `controller/.mcp.json` | Plugin mode: where `src/plugin.mjs` reads the env block |
| `VOICE_GW_CHANNEL_SOURCE` | `voice`, or `plugin:voice:voice` as plugin | The channel's `source` in events |

**Start script and channel** (`scripts/start-controller.sh`, `scripts/channel-mode.mjs`):

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_CONTROLLER_MODEL` | Claude Code's default | `--model` for the controller |
| `VOICE_GW_CONTROLLER_EFFORT` | Claude Code's default | `--effort` for the controller |
| `VOICE_GW_CONTROLLER_CHROME` | `0` | `1`: `--chrome` for the controller, so it can use Claude in Chrome, at the level `unrestricted` only: a Chrome with the Claude extension, signed in, open in a window of its own on a desktop of the same user (a remote desktop session that stays when you disconnect works). A security risk: read [the warning](#claude-in-chrome) first. Before each start the script marks Claude in Chrome's notice for the first start as seen, so that the session does not wait at the terminal ([8.1](#81-starting-and-stopping)); to be sure, confirm it once at the terminal with `claude --chrome` ([7.1](#71-with-the-setup-assistant)) |
| `VOICE_GW_REMOTE_CONTROL` | `0` | `1`: `--remote-control "Voice controller"` for the controller, to follow and steer it at claude.ai/code and in the Claude app ([Remote Control](#remote-control-from-the-claude-app)); not the workers, whose headless runs Remote Control does not connect. Any other value counts as `0`. The gateway reads it too, to say so in its log |
| `VOICE_GW_WATCHDOG` | `1` | `0`: start without the watchdog |
| `VOICE_GW_WATCHDOG_INTERVAL` | `30` | Seconds between health checks |
| `VOICE_GW_WATCHDOG_HEALTH_FAILS` | `3` | Failed checks before a restart |
| `VOICE_GW_WATCHDOG_MAX_RESTARTS` | `5` | Restarts within the window before giving up |
| `VOICE_GW_WATCHDOG_WINDOW` | `1800` | The window, in seconds |
| `VOICE_GW_WATCHDOG_BACKOFF` | `5` | First pause in seconds |
| `VOICE_GW_WATCHDOG_BACKOFF_MAX` | `300` | Longest pause |
| `VOICE_GW_WATCHDOG_STABLE` | `600` | A run this long resets the pause |
| `VOICE_GW_CAFFEINATE` | `1` | macOS: `0` lets the Mac sleep by its energy settings while the watchdog runs |
| `VOICE_GW_CHANNEL` | chosen | `plugin` or `development` |
| `VOICE_GW_MANAGED_SETTINGS` | `/etc/claude-code/managed-settings.json`, on macOS `/Library/Application Support/ClaudeCode/managed-settings.json` | Managed settings file on this computer |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps `remote-settings.json` and the marketplaces |

The start script exports `VOICE_GW_CHANNEL_MODE`, `VOICE_GW_WATCHDOG_LOCK` and
`VOICE_GW_SETTINGS_FROM_FILE` (the names it took from the settings file at that start) for the
gateway; do not set them.

**Container and fetch helper** (`scripts/start-workers-container.sh`,
`scripts/fetch-from-container.sh`, `docker/`):

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_DOCKER` | `voice-workers` | The container |
| `VOICE_GW_DOCKER_FOLDER` | `~/docker-developer` | Host folder mounted at `/repos` |
| `VOICE_GW_SCRATCH_DOCKER` | `voice-scratch` | With `--scratch`: the work folders' container |
| `VOICE_GW_SCRATCH_ROOT` | `~/voice-scratch` | With `--scratch`: the host folder mounted at `/scratch`, made if missing |
| `VOICE_GW_DOCKER_IMAGE` | `cc-voice-worker` | Image, for both containers |
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
| `VOICE_SETUP_GIT_BIN`, `VOICE_SETUP_TMUX_BIN`, `VOICE_SETUP_SYSTEMCTL_BIN`, `VOICE_SETUP_LOGINCTL_BIN`, `VOICE_SETUP_LAUNCHCTL_BIN`, `VOICE_SETUP_PLUTIL_BIN`, `VOICE_SETUP_NETSTAT_BIN`, `VOICE_SETUP_SS_BIN`, `VOICE_SETUP_OSASCRIPT_BIN`, `VOICE_SETUP_PKEXEC_BIN`, `VOICE_SETUP_SUDO_BIN`, `VOICE_SETUP_TAILSCALE_BIN` | `git`, `tmux`, `systemctl`, `loginctl`, `launchctl`, `plutil`, `netstat`, `ss`, `osascript`, `pkexec`, `sudo`, `tailscale` | Commands the assistant runs; tests use stand-ins. On macOS it also looks in Homebrew's folders, and for Tailscale in the app |
| `VOICE_SETUP_HOSTS_FILE` | `/etc/hosts` | The hosts file of "Prepare the sign-in on this computer"; tests use a file of their own |
| `VOICE_GW_TAILSCALE_BIN` | `tailscale`, on macOS else the Tailscale app's | The tailscale command `scripts/funnel.sh` runs |
| `FUNNEL_PORT` | `VOICE_GW_FUNNEL_PORT`, else `443` | Public port of the Funnel for one call of `scripts/funnel.sh`, over the setting |

### 8.9 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Connector dialog says no server answered, and nothing is in the log | The public address is not on port 443 (claude.ai's connector did not connect to the Funnel on 8443 in our test, although it answers publicly there), or it was only just set up. Tailscale Funnel needs a few minutes on the first start; `scripts/funnel.sh start` reports when all relays answer. |
| The sign-in in a browser on the gateway's own computer says "Not secure" and shows another server's page, such as Apache's "Not Found", while other devices connect | Another web server on that computer listens on port 443, and connections from the computer to its own tailnet name reach it, not the Funnel; on a Mac with the Tailscale app such a connection is refused when nothing else listens there. Sign in from another device, or "Prepare the sign-in on this computer" in section 10 of the setup page ([known issues](#810-known-issues)). |
| Sign-in goes to an `http://` address or to the wrong host | The tunnel or proxy does not pass the public host name or `X-Forwarded-Proto: https` (see [Publishing the endpoint](#73-publishing-the-endpoint)). |
| Sign-in page says the app is not registered | The sign-in state was reset, for example because `.secrets/oauth.json` was deleted. Remove the connector and add it again. |
| Sign-in fails with Claude's published identity | Choose to register automatically instead. If the log shows `client id document not allowed: <URL>`, that host is missing from `VOICE_GW_OAUTH_HOSTS`. |
| "Wrong or expired code" | "New code" on the setup page, or `node scripts/pair.mjs` again. A code lasts ten minutes from the page, five from `pair.mjs`, and one sign-in; the newest code replaces every one before, and a restart of the gateway forgets it. Five wrong attempts from one browser or address, or twenty in all, burn it. |
| `pair.mjs` says the gateway is not running | Start the controller; the gateway runs inside its session. |
| The connector stopped working after weeks unused | The refresh token expired after 30 days. Sign in again from the connector's settings. |
| Claude asks before every tool call | Choose "Always allow" for the connector's tools. |
| Startup warning that channels are not enabled for the organisation | Team and Enterprise, including a Max seat in a Team organisation: an Owner enables Organization settings → Claude Code → Channels. `claude --debug` logs "the organization is team" in that case. |
| Channel event arrives, but no answer | The controller's turn failed, for example "Login expired". Look at the controller terminal; `/login` there. |
| `status` reports `controller=unconfirmed`, `get_reply` shows a hint | The session runs without the channel (neither the plugin nor `--dangerously-load-development-channels server:voice`), or the organisation blocks channels. Start it with `scripts/start-controller.sh` and check `/mcp`; otherwise Claude Code drops events silently. |
| `voice port … is in use by another process` in the log, and the same on Telegram | Another process holds `VOICE_GW_PORT`: a second controller session, or a gateway left over from an earlier session, which also answers the watchdog's `/healthz`. The new gateway ends with an error. `lsof -nP -iTCP:8787 -sTCP:LISTEN` shows the process; end it, start only one controller, then restart it. |
| Voice assistant answers itself instead of asking | Say "Ask Claude Code …" explicitly. |
| Voice assistant says the connector does not work | Look at `.logs/gateway.log`. No `voice initialize`: the request never arrived (URL, tunnel or proxy, DNS). `voice 401`: the client has to sign in again. `voice 403`: the caller's address is not allowed, see the next row. `initialize` and `tools/list` but no `tools/call`: the assistant chose not to call a tool. |
| `voice 403 … not an allowed address` for Claude's own calls | Anthropic calls from a range missing in `VOICE_GW_MCP_ALLOW`, or the tunnel does not put the caller's address last in `X-Forwarded-For` (then every call shows the same address). Add the range, or set `VOICE_GW_MCP_ALLOW=any`, and restart the controller. |
| A Telegram alert about a request without a token, or a sign-in | It names the address. A request without a token from Anthropic's addresses comes with every new sign-in of the connector, and from a connector removed in claude.ai when a voice session starts: then the gateway soon switches itself off and stays quiet ([standby](#several-gateways-and-the-standby-after-a-disconnect)). If you did not connect it, nothing got in, and the pairing code keeps it so. A successful sign-in you did not make: `node scripts/pair.mjs list`, then `revoke`. |
| Telegram says "the connector was disconnected (…), I am switching off now", or the voice assistant hears "inactive, connector disconnected, in standby" | The connector was removed in claude.ai, revoked, or its calls came without a token while it went unused ([standby](#several-gateways-and-the-standby-after-a-disconnect)). Add the connector again and sign in with a pairing code (the setup page, or `node scripts/pair.mjs`): the gateway is back at once, with its queue. `.state/standby.json` holds the reason; `VOICE_GW_DISCONNECT_STANDBY=0` turns it off. |
| The voice assistant uses the wrong one of several connectors | Each answer starts with `Gateway <name> (<computer>): active` or `inactive`; give each gateway a name of its own (`VOICE_GW_NAME`), and set a test install to `VOICE_GW_STANDBY=1`. Tell the assistant which computer you mean, or to check status first. |
| A repository is missing from `list_workers` | Only folders directly in the worker root with a `.git` count. Check `VOICE_GW_WORKER_ROOT`. |
| `work folders off: …` in the log, and no `scratch/new` in `list_workers` | `VOICE_GW_SCRATCH=1` is set, but the root is inside a git repository, this checkout or the repositories folder, or is the home folder (a home folder that is itself a git repository counts too), or `VOICE_GW_SCRATCH_DOCKER` names the workers' container. Choose another `VOICE_GW_SCRATCH_ROOT` or container, then restart the controller. |
| `No work folder "scratch/…"` | It was removed `VOICE_GW_SCRATCH_DAYS` after its last run. Its files are gone with it; a new task starts with `scratch/new`. |
| The kill switch locked on a run in a work folder | Such a run may write only in its folder, the temporary folders and its memory folder; a file in the home folder or in `VOICE_GW_KILL_ALLOW_PATHS` is enough. Read the reason; the worker's rules ask it to keep everything in its folder. |
| `The container voice-scratch does not answer` or `could not make …` | The work folders' container is stopped or was removed: `scripts/start-workers-container.sh --scratch`. |
| The controller says it cannot clone or delete | The level is `confined`, or workers run in Docker; the log line `controller level …` says which. A new level counts from the next start of the start script: `--stop`, then start it again. |
| `delete=unplanned` | A deletion needs a plan of the same path from the last 15 minutes: the controller calls `delete_path` without `confirm` first. |
| A worker fails at once | `could not start claude`: Claude Code is not on the gateway's `PATH`; set `VOICE_GW_CLAUDE_BIN`. Otherwise read `.state/tasks/<task>.err`. |
| A queued task does not start | It waits while a run goes on in its repository (or as many as `VOICE_GW_MAX_WORKERS_PER_REPO` allows, or one it waits for with `after`), while that run's result has not reached the controller (is the session connected?), while every `VOICE_GW_MAX_WORKERS` slot is taken, and while the kill switch is locked; behind a worker container that does not answer it tries again every 30 s. `list_workers` shows the queue, `.state/workers.json` holds it under `queue`. |
| A worktree stays in `.voice-worktrees` | Something in it is not committed or not pushed, a queued task resumes there, or a decision refers to it: `worker_status` names it. Push or drop the work there at the desk (`git worktree remove`), or have the run finished with `dispatch` and `continues`. |
| An event with `kind="queue"` | A queued task could not start at its turn and left the queue: uncommitted changes, the origin changed in the container, a `direct` push not allowed, or the repository is gone. It is an open decision now; the controller asks you, and dispatched again, it starts from the beginning. |
| `dispatch=queued … reason=decision`, and nothing starts | An open decision about the repository holds its tasks, for example unpushed commits after the last run. Answer it, or tell the controller to leave it: `resolve_decision` closes it with your words, and the tasks start. `open_items` lists what holds what. |
| The controller says a reply was "Not sent: decision … was never asked" | The gateway raised a decision on that request, and the controller has to put it to you before it may reply "done". It is meant to ask with state "question"; nothing is lost in between. |
| A decision stays open although it was settled | It closes by itself only through the follow-up dispatch for your answer or the controller's "done" to it. Say what you decided; the controller closes it with `resolve_decision`. `.state/jobs.json` holds them all. |
| A result says `git="1 commit on no remote"` although the worker pushed | The check counts commits that no remote-tracking branch (`refs/remotes/…`) has. A push to a URL instead of a named remote does not update them; `git fetch` in the checkout does. Without any remote, commits never count. |
| What did a worker do? | `.state/tasks/<task>.jsonl` holds the whole run. `claude --resume <session>` in the repository opens the session; `.state/workers.json` lists the session ids. |
| A worker no longer remembers details of an earlier task | Its session was compacted at `VOICE_GW_WORKER_AUTOCOMPACT` (300k tokens), or an automatic review fix ran there in a new session (`VOICE_GW_AUTO_FIX_FRESH`), which the next follow-up continues. Name what it needs in the task, keep it in the repository, or raise the setting ([5.5](#55-workers-on-this-computer-or-in-docker)). |
| A private repository is handled like a public one | `gh` is not logged in or not on the `PATH`, so the visibility is unknown, and the worker asks before pushing to be safe. |
| Passed checks or a queued review fix are not told at once | They are routine and wait for the [digest](#the-digest-of-routine-review-news): `VOICE_GW_REVIEW_DIGEST` minutes after the news went quiet, at the latest `VOICE_GW_REVIEW_DIGEST_MAX` after the first. `open_items` says how many wait; the log has `digest: routine news kept …`; `.state/digest.json` holds them. `VOICE_GW_REVIEW_DIGEST=0` brings back one event each. |
| No news about checks or reviews on a worker's pull request | The log says why: `gh is not logged in`, or `stopped watching pull request … : nothing automatic runs` (often a draft that bot reviewers skip, with `VOICE_GW_PR_DRAFT=1` or `draft`; marking it ready in a later run watches it again), `merged`, `closed` or `time limit`. Only pull requests on `voice/` branches that a run linked to, or pushed to after that, are watched. `.state/pulls.json` lists the watches. |
| The controller cannot merge a pull request | A draft must be marked ready first (a task for the worker). Required reviews or checks, conflicts and other branch protection apply; `--admin` is blocked on purpose. With `VOICE_GW_PERMISSION_RELAY=0` the approval only appears at the terminal. |
| The controller says a `gh` command was blocked | Only the commands in [The controller's confinement](#53-the-controllers-confinement) pass, each with `--repo owner/name` and flags as separate words. If it does not know about `gh` at all, restart the controller so that it reads the current `controller/CLAUDE.md`. |
| The controller says a tool is blocked | Expected for every tool that is not on the confine hook's list ([confinement](#53-the-controllers-confinement)): MCP tools from your settings or plugins, subagents, skills, web access. Ask for it at the desk, or let a worker do it with `dispatch`. |
| The controller says one of its own voice tools is blocked | The gateway has a tool that the hook does not know. Add its name to `GATEWAY_TOOLS` in `controller/.claude/hooks/confine.mjs` and to the allow rules in `controller/.claude/settings.json`, then restart the controller. |
| The controller cannot write `CLAUDE.md`, `AGENTS.md`, `.mcp.json` or into a `.claude` folder | Expected, also in `playground/`: Claude Code would read them as instructions or settings. Choose another name. |
| With the development flag, Claude Code refuses `--mcp-config` or `--strict-mcp-config` at the start | Your organisation's managed settings forbid it. `disableSideloadFlags`: use the plugin instead ([Admin steps](#74-admin-steps-for-team-and-enterprise)). "An enterprise MCP config is present": the organisation's `managed-mcp.json` decides which MCP servers run; ask its admin. |
| The setup link says it is not valid or already used | The link works once, in one browser. Go on in that browser, or start `node scripts/setup.mjs` again for a new link. |
| The setup page says "Too many wrong links" | Five wrong links from one address within ten minutes, or 30 in total, block every attempt for a while. Wait, or start the assistant again. |
| The setup assistant does not start | `needs a terminal`: it shows its link only on a terminal, so run it directly, not with its output redirected. `cannot listen on …: EADDRINUSE`: choose another `--port`. |
| Section 10 of the setup page says "not running yet" although the controller runs in tmux | Claude Code waits at the terminal, and the gateway starts only after the answer. `tmux attach -t voice`: at "Is this a project you created or one you trust?" (once for the folder) press the down arrow once to "Yes, I trust this folder", then Enter, since Enter alone picks "No, exit"; at the development channel's warning (every start without the allowlist) Enter. Leave with Ctrl-b, then d. |
| The setup page cannot be reached from another computer | A firewall blocks the port, or `--host` names one address only. Or use the SSH tunnel the terminal shows. |
| "Find my chat" finds nothing | Write to the bot after checking the token; Telegram keeps messages for 24 hours. A running gateway that polls the same bot takes them away: quit the controller first. |
| No Telegram message | Approval requests go out at once, also while voice mode is on and at night; only a standby holds them. Questions go out only after `VOICE_GW_TELEGRAM_AFTER` seconds (600) without a voice call, and only if the voice assistant has not picked them up. Results never go to Telegram. `telegram fallback off` in the log: a file was missing or empty when the gateway started; fix it and restart the controller. `telegram send failed: 400 Bad Request: chat not found`: wrong chat ID, or you never wrote to the bot. `401 Unauthorized`: wrong token. |
| `The worker container voice-workers does not answer` | The container is stopped or was removed: `docker start voice-workers`, or `scripts/start-workers-container.sh`. |
| `access read-only (no GitHub token)` although there is one | It must be `.secrets/worker/github_token`, readable for the gateway. A new token counts at the next check, within ten minutes. |
| `access read-only (the token cannot see the repository (404))` | The token's repository access does not include it, or the organisation has not approved the token yet. |
| `access full` where you expected `pr` | No ruleset or branch protection requires pull requests on the default branch, or the private repository's plan has none. Protect it, or set `VOICE_GW_ACCESS=pr`. |
| `worker container …: /repos is a volume, not a host folder` or `… it runs as …` | The container was started without `-v <folder>:/repos` or without `--user "$(id -u):$(id -g)"`. Remove it (`docker rm -f voice-workers`) and start it with `scripts/start-workers-container.sh`. |
| `fetch-from-container: the container could not bundle …` | The branch does not exist in the container's repository, or the container is not running. The worker names its branch at the end of each run. |
| A worker in Docker fails at once | Claude Code is not logged in: `.secrets/worker/claude_token` is missing or expired; run `claude setup-token` again. Otherwise read `.state/tasks/<task>.err`. |
| `dispatch=locked`, `[state=locked]` or an `[ALARM]` line | The kill switch is locked; the alarm names the trigger. `node scripts/unlock.mjs --status` shows it, `node scripts/unlock.mjs` at the server unlocks it. In the car, with Telegram set up: say "unlock the kill switch", then the PIN that comes to Telegram ([5.9](#59-the-kill-switch)). |
| `[unlock=blocked]` | Three wrong PINs for this lock, or a kill switch file that cannot be read: only `node scripts/unlock.mjs` at the server unlocks it now. |
| `[unlock=no-telegram]` or no PIN arrives | The unlock in voice mode needs Telegram, with your private chat with the bot as the configured chat. `[unlock=unsent]` names Telegram's error; `[unlock=standby]`: not in a standby. A PIN is valid five minutes (`[unlock=expired]`); ask for a new one. |
| `dispatch=origin` | In the container, the repository's `origin` is no longer the GitHub repository the gateway saw first ([5.6](#56-access-levels-and-their-detection)). Check the clone at the desk; if the change is wanted, stop the controller and remove the repository's line under `origins` in `.state/workers.json`. |
| The kill switch locked for no good reason | Read the reason. A rule that misfires: raise its `VOICE_GW_KILL_*` threshold, grant a folder to one repository in `VOICE_GW_PATH_GRANTS` ([path grants](#path-grants)), or add one for all of them to `VOICE_GW_KILL_ALLOW_PATHS`. |
| The kill switch locked on `many changes` for code that was there already, such as review branches or a rebase | It counts nothing only on branches the run made ([5.9](#59-the-kill-switch), "What a run took over"). Such commits on a branch from before the run count in full, and so does everything after a `git push` to a URL, or when the repository keeps no reflogs (`core.logAllRefUpdates=false`). `kill switch rule on many changes` in the gateway's log names what was left out. |
| Telegram warns that a worker wrote a file outside its allowed folders and the guard moved it to quarantine | The run went on: the rule on writes outside moves the first two new files a run writes in a place that is not sensitive into `.state/quarantine/<task>/` instead of locking ([quarantine](#quarantine)), and the third locks. `quarantine.jsonl` there names where each was and the command. Put a file back where it was meant to go yourself if you want it; the gateway removes nothing there. If a task needs files in such a place, have the worker use its run folder, or add the folder to `VOICE_GW_KILL_ALLOW_PATHS`. |
| The kill switch locked on `write outside the allowed folders` for a relative path such as `../report.md` that went into the workspace | The rule counts it from the folder each call starts in, as Claude Code names it in the gateway's hook ([5.9](#the-folder-a-command-runs-in)). A line `no report of the guard's hook in this run` in `.logs/gateway.log` means the hooks did not run (for example `disableAllHooks` in your Claude Code settings, or managed settings that allow only managed hooks), and the rule followed the shell itself; a run from before this version has no hook either. Before this version a subagent's `cd` counted for the main thread's shell (2026-11-03). |
| The kill switch locked on `write outside the allowed folders` for screenshots or other helper files, such as in `~/voice-scratch/…` | The worker wrote outside its repository, its run folder and the temporary folders, often because a task named such a place. Its run folder (`.voice-runs/<repository>/…`, also `$TMPDIR`) is the place for them: its prompt and rules say so, and the controller's instructions say to ask for such files there and to name no other folder. A run from before this version has no run folder. A folder outside every repository that workers may really use goes into `VOICE_GW_KILL_ALLOW_PATHS`, never the work folders' root. |
| The kill switch locked on `write outside the allowed folders` when a worker removed, changed or made files in a folder its repository uses outside the checkout, such as a service's data folder (`rmdir /srv/wyze-events/live/2026-11-04 /srv/wyze-events/live` on 2026-11-04) | Removing, changing or making folders outside locks at once. Grant that folder to the repository: `VOICE_GW_PATH_GRANTS=hauswache=/srv/wyze-events` in `.secrets/gateway.env` applies at once ([path grants](#path-grants)), and `list_workers` then shows it on the repository's line. Only for workers on this computer. If it still locks, read the reason: an entry the log says it ignored (`VOICE_GW_PATH_GRANTS: ignored, …`), or something that locks in a granted folder too, such as a hidden file, a link, a git repository or a path that leads out through a link. |
| A run folder in `.voice-runs` is gone, with the screenshots in it | It is removed `VOICE_GW_RUN_FOLDER_DAYS` (7) after its session's last run; copy out what you want to keep, or set `0`. `worker_status` names the folder of the last run, and `.state/workers.json` lists them under `runFolders`. |
| An answer or a request on Telegram is "not passed on" | The reason follows in the chat. "Telegram input is off": turn it on in the setup (section 4), or set `VOICE_GW_TELEGRAM_ANSWERS=1` and `VOICE_GW_TELEGRAM_REQUESTS=1`; it is off by default, also after an update. For an answer, reply to the question's own message, or name its code (the four characters after "Question for request"); a decision's code works too. Only questions still open count: one answered by voice is settled. With `VOICE_GW_TELEGRAM_CONFIRM=0`, a push, merge, restart or delete question, or an approval request, is never answered there ("must be confirmed by voice", "Telegram cannot approve"): say it in voice mode. An approval request takes a plain yes or no, as a Reply to it, with its code, or alone while it is the only one open; with several open, a plain yes gets a list of them and the question which one is meant, and "yes to all" allows them all. A forwarded or edited message, or one without text, is never passed on: write it yourself, as a new message. While the kill switch is locked or the gateway is inactive nothing goes through; try again once it is unlocked or active again. `telegram answers off` in the log: `VOICE_GW_TELEGRAM_ANSWERS` is not `1`; `telegram requests off`: `VOICE_GW_TELEGRAM_REQUESTS` is not `1`. `.state/telegram-input.log` says for every message what became of it. |
| A message on Telegram became a request, not the answer you meant | Without a Reply to the question and without its code, a message is a new request. Reply to the question's own message, or start yours with its code. The controller sees the request all the same and may ask back. |
| A message on Telegram became an answer, not a request | A Reply to a question answers it, whatever it says, and so does a message that names the code of exactly one open question. Write it without a Reply, and without that code. |
| `/stop` on Telegram does nothing, or the bot never answers | Only your own account in your private chat with the bot counts: messages from a group, another account or a bot are ignored without an answer (`telegram commands: ignored a message …` in the log, every one in `.state/telegram-input.log`). `telegram_chat_id names no private chat` in the log: choose your private chat in the setup. And the gateway must poll the bot: the log says `telegram commands: …` if a webhook or another program takes the updates; if that is not you, the token may have leaked: revoke it with @BotFather. |
| `/funnel on` answers "Ignored …: it was sent … ago" | The gateway was not running when you sent it, for example during a restart or right after boot. Send it again. |
| `/funnel on` answers "The Funnel did not come on: Access denied" | Run `sudo tailscale set --operator=$USER` once on the computer. |
| The Funnel goes off while you still use voice mode | It goes off `VOICE_GW_FUNNEL_IDLE` minutes after the last voice call; a long silence counts. Raise the minutes, or send "keep alive". |
| No approval by voice | Expected for Bash, Write and Edit: they run without asking. For other tools: the session runs in auto or bypass mode, an allow rule covers the tool, or it is a trust or consent dialog, which is not relayed. Start the session with `scripts/start-controller.sh`. |
| The terminal shows an approval waiting, the car and Telegram nothing | Every open approval comes with any voice call's result, `send` and `approve` included, and goes to Telegram at once; none drops after a time. Below `unrestricted`, a tool call of the controller after the prompt makes the gateway guess it was answered at the computer and take it off the lists ([5.4](#54-approvals-by-voice)): if one still waits then, answer it at the terminal, or by voice or in Telegram with its code from its Telegram message, which still reaches Claude Code. In a standby nothing goes out until the connector signs in again. |
| The controller still starts with the development flag after the admin step | The log line `channel: the development flag, since …` says why. The script reads Claude Code's local copy of the managed settings (`~/.claude/remote-settings.json`), which Claude Code updates when a session starts, so the first start after the admin step still sees the old copy: answer the warning or quit, and start again. `node scripts/channel-mode.mjs` shows what the next start will use; `claude doctor` shows whether the managed settings arrived. |
| With `VOICE_GW_REMOTE_CONTROL=1`, "Voice controller" is missing in the Claude app | It counts from the next start of the session; the log line `watchdog: remote control: …` shows that it was passed. The controller's terminal (`tmux attach -t voice`) shows why it did not connect, and `claude doctor` which check failed: Claude Code signed in with an API key or a token instead of claude.ai, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK` set, or on Team and Enterprise Remote Control not turned on by an Owner ([7.4](#74-admin-steps-for-team-and-enterprise)). After a restart, take the newest session of that name. |
| No worker shows up in the Claude app | Expected: only the controller connects. Worker runs are headless (`claude -p`), which Remote Control does not connect ([Remote Control](#remote-control-from-the-claude-app)); ask the controller what a worker does, or read `.state/tasks/<task>.jsonl`. |
| "Restart the controller" and the controller says it cannot restart itself | It was not started by `scripts/start-controller.sh` with the watchdog. Restart it at the computer. |
| Voice requests stop arriving after a crash | The watchdog started the session again, and the development-channel warning waits: `tmux attach -t voice`, then Enter. `grep watchdog .logs/gateway.log` shows what happened. |
| After a start with `VOICE_GW_CONTROLLER_CHROME=1` the controller does not come up, and its terminal shows "Claude in Chrome" with "Enter to confirm · Esc to cancel" | Claude in Chrome's notice for the first start; Enter or Esc goes on (`tmux attach -t voice`), and Claude Code does not show it again. The start script marks it as seen beforehand; the log line `watchdog: chrome: …` says why it could not. |
| `the controller is already running (watchdog …)` | A watchdog runs already, for example in another tmux window. `scripts/start-controller.sh --status`; `--stop` ends it. |
| `watchdog: giving up …` | The session kept crashing, for example because the login expired. Look at the controller terminal, fix the cause, and start it again. |
| After a reboot the controller runs only while you are logged in, and stops when your SSH session ends | Lingering is off for your user: `loginctl enable-linger`, or `sudo loginctl enable-linger $USER` if that is refused. The setup assistant turns it on with the autostart. |
| macOS: after a restart of the Mac the controller does not run | LaunchAgents start at a login. Log in, or turn on automatic login (System Settings, Users & Groups; not with FileVault). `launchctl print gui/$(id -u)/com.drawio.cc-voice-gateway` shows whether it is loaded. |
| macOS: the LaunchAgent does not start the controller | `~/Library/Logs/cc-voice-gateway.log` has tmux's message: `duplicate session: voice` means it runs already. `scripts/check-macos.sh` checks the plist, its tmux and whether its `PATH` finds node, claude, git and gh; run the setup again from a Terminal that finds them. |
| macOS: `launchctl bootstrap` says `Bootstrap failed: 5: Input/output error` | It is loaded already: `launchctl bootout gui/$(id -u)/com.drawio.cc-voice-gateway` first, or `launchctl kickstart` to start it. Or the plist is invalid: `plutil -lint` says where. |
| macOS: voice requests stop while nobody uses the Mac | The Mac sleeps. The watchdog's `caffeinate` prevents idle sleep (log line `caffeinate: …`, `pmset -g assertions`), not a closed lid without an external display; check that `VOICE_GW_CAFFEINATE` is not `0`. |
| A start script fails at once with `mapfile: command not found` or another bash error on macOS | A checkout from before macOS support: pull. Since then the scripts run with bash 3.2; `scripts/check-macos.sh` runs `bash -n` on each with `/bin/bash`. |

Claude Code's debug log is at `~/.claude/debug/<session-id>.txt`.

### 8.10 Known issues

**With a personal account, every start of the controller waits for a confirmation at the
terminal.** A personal claude.ai account, Pro or Max for example, has no organisation and so no
channel allowlist for the plugin ([7.4](#74-admin-steps-for-team-and-enterprise)). The controller
then runs with the development channel flag, and Claude Code shows a confirmation prompt at every
start of it. So the gateway cannot start or restart fully by itself: not after a crash, not by the
watchdog, not by the autostart and not by `scripts/restart-everything.sh`. After every start,
someone has to confirm the dialog in the Claude process through tmux, over SSH if need be:

```bash
tmux attach -t voice   # then Enter; leave tmux again with Ctrl+B, then D
```

Until then voice requests do not arrive. The Telegram message that a restart begins says when the
start waits for it ([8.2](#82-the-watchdog)). Officially, fully automatic, unattended operation is
only possible with a Team or Enterprise account whose Owner has put the plugin on the channel
allowlist ([8.1](#81-starting-and-stopping), plugin mode).

**Workaround, unofficial: the allowlist in the managed settings file on this computer.** The
setting of [7.4](#74-admin-steps-for-team-and-enterprise), put into the managed settings file on
this computer instead of the organisation's, also works with a personal account. Tested with a Max
account and Claude Code 2.1.312: the controller starts in plugin mode, without the confirmation. As
root:

```bash
sudo mkdir -p /etc/claude-code
sudo tee /etc/claude-code/managed-settings.json <<'EOF'
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "cc-voice-gateway", "plugin": "voice" }
  ]
}
EOF
```

On macOS the file is `/Library/Application Support/ClaudeCode/managed-settings.json`; if it exists
already, add the two keys to it. The start script reads the file and chooses the plugin at the next
start.

The setup assistant does it too: section 8 of its page, "Put it on the allowlist on this computer"
(`src/setup/allowlist.mjs`). It reads the file as you, turns `channelsEnabled` on and adds the
plugin to `allowedChannelPlugins`, keeping every other key and entry, and writes it with
administrator rights as for `/etc/hosts` below: the system's password dialog on macOS, `pkexec` or
`sudo -n` on Linux, otherwise the command for a terminal. The old file stays next to it as
`managed-settings.json.cc-voice-gateway.bak`; the new one is readable for every user, as Claude Code
reads it as theirs. A file that is no JSON object is left alone. The page offers it only while the
organisation has no managed settings of its own: theirs come first, and a file here does not count
then. As in 7.4, the list replaces the default list of channel plugins, here for every user of this
computer. Anthropic documents the allowlist for organisations only, so this is unofficial and may
break with any update of Claude Code: if a start waits for the confirmation again, confirm it as
above and check whether the workaround still holds.

**A browser on the gateway's own computer cannot sign in under the tailnet name.** The Funnel
answers other devices and Claude's servers as it should, so the Claude app reaches the gateway; only
the sign-in in a browser on the computer the gateway runs on fails. On macOS the Tailscale app's
network extension binds the tailnet address only for ports from 1024 up (`netstat -anv -p tcp`
shows `IPNExtension` on 8443, never on 443), so a connection from the Mac to its own tailnet name
on 443 is refused, or, where another web server listens on `*:443`, such as macOS's built-in Apache
with `/etc/apache2/extra/httpd-ssl.conf`, gets that server: "Not secure" and its own page. Letting
that server listen only on `127.0.0.1` does not help: the Tailscale app still does not take 443 on
the tailnet address. On Linux the same happens where another web server listens on 443.

Section 10 of the setup page finds out instead of guessing: once the Funnel is on, the assistant
fetches `https://<host>.ts.net/.well-known/oauth-authorization-server` from this computer, as a
browser here would, and only if what answers is not the gateway (refused, the wrong certificate,
another server's page) it says so, naming another web server on 443 if `netstat -anv -p tcp` on
macOS or `ss -ltnp` on Linux shows one. Then, for the one-time sign-in:

- add the connector and sign in from another device, for example claude.ai in a browser on your
  phone, with a pairing code from the setup page or `node scripts/pair.mjs`;
- or "Prepare the sign-in on this computer": the assistant looks up one of the Funnel's public
  addresses through public resolvers (1.1.1.1, 8.8.8.8; not MagicDNS) and adds one marked line to
  `/etc/hosts`, `<address> <host>.ts.net # cc-voice-gateway setup: …`, so that the browser goes
  out through the public Funnel with its valid certificate. It asks for administrator rights: on
  macOS the system's password dialog (`osascript … with administrator privileges`), which also
  flushes the resolver's cache (`dscacheutil -flushcache`, `killall -HUP mDNSResponder`); on Linux
  `pkexec`, or `sudo -n` where no password is needed; otherwise the page shows the exact command for
  a terminal. It keeps a backup next to the file (`/etc/hosts.cc-voice-gateway.bak`), never touches
  another line, and checks again whether the gateway answers now. It removes the line again, by an
  exact match, as soon as the page's pairing code is used, when the page or the assistant ends, and
  with "Remove it now"; that may ask for the password a second time. A line an assistant left
  behind, after a crash for example, shows on the page with "Remove it now" too.

The setup never changes that other server, and never moves the Funnel off 443: Funnel serves 8443
publicly, but claude.ai's connector did not connect to it in our test ("no server answered at this
URL", and no request from Anthropic's addresses in the log).

## 9. Repository layout

```text
src/
  gateway.mjs        entry point: wires both sides, exits with the session
  channel.mjs        stdio side: channel, reply and worker tools, permission relay
  voice.mjs          HTTP side: the voice tools
  oauth.mjs          sign-in: OAuth metadata, registration, pairing page, tokens
  ipguard.mjs        the door: access log, /mcp only from Anthropic's addresses, alerts on Telegram
  presence.mjs       which gateway answers the connector, and whether it is active
  standby.mjs        the standby when the connector is disconnected, until a new sign-in
  limits.mjs         the Claude usage limit, in runs and the controller's transcript, waited out; credits noted
  night.mjs          night mode: the quiet hours, good night and I'm back, the morning summary
  orders.mjs         standing orders: what the controller may dispatch without fresh words, at night
  workers.mjs        workers: repositories, claude -p runs, the queue, the check after a run, results
  workspaces.mjs     where a run works: a repository, or a work folder, with its rules and check; run folders
  worktrees.mjs      the worktrees of further runs of a repository: made, with submodules, removed
  live.mjs           the worker limits and path grants from the settings file while the gateway runs
  ledger.mjs         open decisions for the driver, and the open items
  stats.mjs          the statistics: this running time and all time, the texts
  runners.mjs        where workers run: this computer, or the Docker container; a run's processes
  access.mjs         access levels in the container, from the GitHub token
  pulls.mjs          the watch on pull requests that workers open
  digest.mjs         routine news about them, gathered into one event for the controller
  telegram.mjs       Telegram fallback; /stop, /funnel, answers, approvals and requests from your own chat (off by default), the input log
  funnel.mjs         the Funnel on and off from Telegram, and off by itself when idle
  killswitch.mjs     the kill switch: state, emergency phrases, alarm, the unlock in voice mode with a PIN
  guard.mjs          the kill switch's rules on the workers' runs
  grants.mjs         path grants: folders a repository's workers may write to, checked strictly
  restart.mjs        restarting the controller by voice, through the watchdog
  plugin.mjs         the gateway as the MCP server of the plugin voice@cc-voice-gateway
  store.mjs          requests and approvals, persisted across restarts
  folders.mjs        cloning and deleting in the worker root, above the level confined
  admin.mjs          Unix socket for pair.mjs, unlock.mjs, fake-voice and the setup's pairing codes
  config.mjs         settings from the environment and .secrets/gateway.env
  settings.mjs       reads and writes .secrets/gateway.env
  platform.mjs       what differs on macOS: temporary folders, the autostart's PATH and names
  setup/             the setup assistant: server.mjs (guard), actions.mjs (steps), ui/ (page),
                     hosts.mjs and allowlist.mjs (/etc/hosts and the managed settings, as root)
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
  restart-everything.sh        everything of this gateway down and up again, for when something no longer works
  channel-mode.mjs             plugin or development flag
  controller-settings.mjs      the session's --settings for its level
  chrome-onboarding.mjs        Claude in Chrome's notice for the first start, marked as seen
  folder-trust.mjs             controller/ marked as trusted, so that no folder trust question waits
  claude-config.mjs            both changes to Claude Code's ~/.claude.json, under its lock, in one step
  settings.sh                  .secrets/gateway.env for the shell scripts
  start-workers-container.sh   the worker container, or with --scratch the work folders'; read-only while locked
  fetch-from-container.sh      a branch from the container into a clean clone, as a bundle
  unlock.mjs                   unlock the kill switch at the server, which always works
  pair.mjs                     pairing codes (also on the setup page), connections
  funnel.sh, check-public.mjs  Tailscale Funnel, and a check through its relays
  telegram-notify.mjs          one Telegram message, for the watchdog
  stats.mjs                    the statistics at the desk, and the shutdown message for the watchdog
  fake-voice.mjs               play the voice AI at the desk
  check-macos.sh               the checks on a Mac, PASS, WARN or FAIL each, and the tests (docs/macos.md)
  test-progress.mjs            the tests as one line in a terminal, written over, for check-macos.sh
test/                one file per area; npm test runs them all, with stand-ins for Claude Code,
                     gh, docker, the GitHub API and Telegram
  env.cjs            loaded first: clears the caller's settings (VOICE_GW_*, Claude Code's
                     session), so the tests run alike from any shell, the controller's too
docs/
  *.drawio.svg       the diagrams, made with draw.io
  index.html         the product page (GitHub Pages, from this folder)
  macos.md           install and test on a Mac, step by step
  assets/            the video, its poster, the README thumbnail, the dark architecture diagram,
                     and the page's Barlow fonts (fonts/, SIL Open Font License)
video/               the video's sources: storyboard.md (the messages), script.json (voiceover),
                     slides.html (animated scenes), tts.py, build.mjs
```

## 10. Sources

- [Claude Code: channels][channels], [channels reference][ref], [enterprise controls][channels-admin]
- [Claude Code: Remote Control][rc], [cross-session messaging][csm], [authentication and
  setup-token][auth], [sandboxing][sandbox], [permissions][perm]
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
[csm]: https://code.claude.com/docs/en/cross-session-messaging
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
