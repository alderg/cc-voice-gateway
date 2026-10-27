# cc-voice-gateway

Feasibility test: drive Claude Code sessions by voice from the car. A voice assistant on CarPlay
(Claude voice mode or Grok) calls a custom MCP connector. The connector hands the request to a
running Claude Code session, which acts as a controller: it answers, asks back and gets approvals.

Plain JavaScript (ESM), no build step. The only dependencies are `@modelcontextprotocol/sdk` and `zod`.

> **Status:** test setup, not for continuous use. State lives in memory only, and Claude Code
> channels are a research preview.

## What the test is meant to answer

1. Does the voice assistant on CarPlay call a custom MCP connector at all? Everything else depends
   on this.
2. Does it keep polling through tasks that take longer than 60 seconds?
3. Do questions and approvals (Bash, Write, Edit) work by voice?

![Architecture](docs/architecture.drawio.svg)

## How it works

**One process, two sides.** Claude Code starts `src/gateway.mjs` itself, because the server is
listed in `controller/.mcp.json`, and talks to it over stdio. The gateway declares the
`claude/channel` capability, so every voice request lands in the running controller session as
`<channel source="voice" request_id="…">text</channel>`. The same process listens on
`127.0.0.1:8787` and offers MCP tools to the voice assistant there. Tailscale Funnel makes this
port reachable over HTTPS, because Claude and Grok call connectors from their own cloud.

**Who thinks:** the gateway is deliberately not an AI. It keeps state and relays. The controller
session (Claude Code) understands, answers, summarises and asks back. The voice assistant runs the
conversation in the car.

| Side | Tool | Purpose |
|---|---|---|
| Voice assistant | `status` | Reachability, open requests and approvals |
| Voice assistant | `send` | Hand over a request, returns at once with an `id` |
| Voice assistant | `ask` | Hand over a request and wait up to 40 s for the answer |
| Voice assistant | `get_reply` | Fetch news for an `id`, waits up to 40 s |
| Voice assistant | `approve` | Allow or deny an approval with its five-letter code |
| Controller | `reply` | Answer with `state` `working`, `question` or `done` |

![Request flow](docs/request-flow.drawio.svg)

**Why polling:** a single tool call must not block for long. MCP clients often abort requests
after 60 seconds ([talk-to-claude-code][t2cc]). `get_reply` therefore waits at most 40 seconds and
returns as soon as there is news. The first line of every result is machine-readable, for example
`[state=working id=k7f3 elapsed=34s]`, so the voice assistant knows whether to poll again.

**Approvals:** because the gateway also declares `claude/channel/permission`, Claude Code sends
every approval prompt to the channel in parallel with the terminal dialog. The first answer wins,
whether it comes from the car or from the terminal ([channels reference][ref]). Workspace trust
and MCP consent dialogs are not relayed.

**Questions:** nobody can click a form (`AskUserQuestion`) in the car. `controller/CLAUDE.md`
therefore asks for questions as plain text with `state: "question"`. The driver's answer arrives as
a new request that refers to the original `id`.

![States](docs/states.drawio.svg)

## Requirements

- Node.js 20 or newer (tested with 22) and npm
- Claude Code with a claude.ai login, channels need v2.1.80 or later. Team and Enterprise
  organisations need an admin to enable channels; Pro and Max do not ([channels][channels]).
- Tailscale with Funnel, or another HTTPS tunnel. On Linux, run `sudo tailscale set --operator=$USER`
  once so `scripts/funnel.sh` works without root.
- A voice assistant with custom connectors: the Claude app (custom connectors on paid plans only)
  or Grok ([grok.com/connectors][grok])

## Installation

```bash
git clone git@github.com:alderg/cc-voice-gateway.git
cd cc-voice-gateway
npm install
npm test          # 22 tests, no Claude Code and no car needed
```

`npm test` starts the gateway over stdio and plays both ends: Claude Code (channel events,
`reply`, approval prompts) and the voice assistant (HTTP tools).

## Test plan

Go through the stages in order. Each stage adds exactly one new link.

### Stage 0: desk, no tunnel

```bash
scripts/start-controller.sh        # terminal 1: controller with the channel
node scripts/fake-voice.mjs        # terminal 2: plays the voice assistant
```

On the first start Claude Code asks in the terminal: trust for the folder, a warning about the
development channel, and consent for the new MCP server from `.mcp.json`. Confirm all of them; the
permission for `mcp__voice__reply` in `controller/.claude/settings.json` only applies once the
folder is trusted.

The script starts the session in manual mode (`--permission-mode manual`), and
`controller/.claude/settings.json` has ask rules for Bash, Write and Edit. Ask rules win over
allow rules, so a user-wide `bypassPermissions` default or allow rules like `Bash(*)` in
`~/.claude/settings.json` cannot approve these calls silently; otherwise there would be no
approval to relay. Stay in manual mode: in auto mode a classifier decides instead of you.

In the second terminal:

```text
> status
> ask How many files are in the playground?
> send Create the file hello.txt in the playground with the text Grüezi
  … [state=sent … approval=abcde] Approval needed (code=abcde): Write – …
> allow abcde
> follow
```

The gateway's tool results are in English; the voice assistant speaks in your language either
way, and the controller answers in the language of the request. The log is in `.logs/gateway.log`;
it has one line per connector call (`voice initialize client=…`, `voice tools/list`,
`voice tools/call ask`), so you can see whether a voice assistant called the connector at all.

### Stage 1: tunnel

```bash
scripts/funnel.sh start            # prints the connector URL
node scripts/fake-voice.mjs "https://<host>.ts.net:8443/mcp/<token>"
```

The first start fetches a certificate (the script triggers that with one request), and the public
DNS name can take up to about ten minutes to appear. From inside the tailnet the name resolves to
the machine's Tailscale address, so that test skips the public path.

Best checked from another network, for example the phone's hotspot.

### Stage 2: connector in text chat

Add a connector with the URL from stage 1, **without authentication**, because the secret is in the
path:

- **Claude:** Customize → Connectors → add a custom connector. Labels vary between app versions.
- **Grok:** grok.com/connectors → New Connector → Custom ([xAI docs][grok]).

In text chat on the phone: "Ask Claude Code for the gateway status."

### Stage 3: voice mode on the phone, standing still

Same question in voice mode. **This is the decisive test.** If the voice assistant does not call
the tool here, that app is unsuitable for the car, however the server is built.

### Stage 4: CarPlay, parked

1. "Ask Claude Code for the status."
2. "Ask Claude Code how many files are in the playground."
3. Long task with approval: "Tell Claude Code to wait 90 seconds and then create the file
   done.txt in the playground." Expected: progress updates over a good 90 seconds and an approval
   question, at the start or at the end depending on how Claude Code goes about it, then "done".
4. Question: "Tell Claude Code to clean up the playground and to ask first what may go."

### Results

| Check | Claude voice | Grok |
|---|---|---|
| Tool called in text chat | | |
| Tool called in voice mode on the phone | | |
| Tool called on CarPlay | | |
| Polling beyond 60 s without dropping out | | |
| Approval by voice | | |
| Question answered | | |
| Answers read out short and usable | | |

## Security

- **Whoever knows the URL can make Claude Code work on your computer.** That includes a voice
  assistant that has been manipulated by prompt injection. Keep the URL secret and close the
  tunnel after testing (`scripts/funnel.sh stop`).
- **Tailscale Funnel is public.** It needs no open port on your router, but anyone on the
  internet can reach the mapped port, and the host name is published in the certificate
  transparency logs. Funnel has no authentication of its own; the secret in the path is the only
  key.
- **The controller session is confined**, because whoever has the URL can also answer approval
  prompts (see below). These limits hold whatever is approved:
  - File tools read only inside `controller/` and write only inside `controller/playground/`
    (PreToolUse hook `controller/.claude/hooks/confine.mjs`, resolves symlinks, fails closed).
  - Bash runs only `ls` inside `controller/`, `sleep <seconds>` and `rm [-f]` with plain file
    names in `playground/` (same hook). Claude Code's own Bash sandbox would allow more, but on Ubuntu 24.04 and later
    AppArmor's `bwrap-userns-restrict` profile stops it from starting ([sandboxing][sandbox]).
  - Denied: claude.ai connectors (Gmail, Slack, Drive, …), web fetch and search, messages to
    other Claude sessions, remote and scheduled agents, artifacts, Monitor, workflows and
    worktrees. Bypass and auto mode cannot be switched on.
  - What is left: reading `controller/`, and writing or deleting in the playground with an
    approval. The answers go back to the voice assistant.
- New secret: delete `.secrets/token`, restart the controller, update the connector URL.
- The gateway binds to `127.0.0.1` only. Requests without a valid secret get a bare 404, so
  clients do not start an OAuth flow.
- Approval by voice means: whoever can call `approve` can approve tools. The voice assistant is
  told to approve only after an explicit yes; that is an instruction, not enforcement. Turn it off
  with `VOICE_GW_PERMISSION_RELAY=0`.
- Claude Code masks recognisable credentials in relayed approval texts, but not every secret
  ([channels reference][ref]).
- Start the controller only with `scripts/start-controller.sh`, never with
  `--dangerously-skip-permissions`.

## Configuration

Claude Code starts the gateway, so environment variables go into `controller/.mcp.json`:

```json
{
  "mcpServers": {
    "voice": {
      "command": "node",
      "args": ["../src/gateway.mjs"],
      "env": { "VOICE_GW_PORT": "8790" }
    }
  }
}
```

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_PORT` | `8787` | local HTTP port |
| `VOICE_GW_HOST` | `127.0.0.1` | bind address, only change it if you know why |
| `VOICE_GW_TOKEN` | – | set the secret directly, otherwise `.secrets/token` |
| `VOICE_GW_TOKEN_FILE` | `.secrets/token` | location of the secret file |
| `VOICE_GW_PERMISSION_RELAY` | on | `0` turns approval by voice off |
| `VOICE_GW_DEFAULT_WAIT` | `25` | wait time of `get_reply` in seconds |
| `VOICE_GW_MAX_WAIT` | `40` | upper limit for `get_reply` and `ask` |
| `VOICE_GW_HINT_AFTER` | `20` | when a diagnostic hint appears |
| `VOICE_GW_PERMISSION_TTL` | `900` | open approvals expire after this many seconds |
| `VOICE_GW_LOG_FILE` | `.logs/gateway.log` | set empty for stderr only |
| `FUNNEL_PORT` | `8443` | for `scripts/funnel.sh`; allowed are 443, 8443, 10000 |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Startup warning that channels are not enabled for the organisation | Team and Enterprise, including a Max seat in a Team organisation: an Owner enables Organization settings → Claude Code → Channels. `claude --debug` logs "the organization is team" in that case. In our test channels still worked without it until the session was started with `--setting-sources project,local`; do not rely on that. |
| Channel event arrives, but no answer | The controller's turn failed, for example "Login expired". Look at the controller terminal; `/login` there. |
| `status` reports `controller=unconfirmed`, `get_reply` shows a hint | Session started without `--dangerously-load-development-channels server:voice`, or the organisation blocks channels. Check `/mcp` in the session; otherwise Claude Code drops events silently. |
| Connector asks for OAuth | URL without the secret in the path. It must be `…/mcp/<token>`. |
| `EADDRINUSE` in the log | A second controller session is running. Start only one. |
| Voice assistant answers itself instead of asking | Say "ask Claude Code …" explicitly. |
| Voice assistant says the connector does not work | Look at `.logs/gateway.log`. No `voice initialize`: the request never arrived (URL, Funnel, DNS). `initialize` and `tools/list` but no `tools/call`: the assistant chose not to call a tool. `rejected`: wrong URL or token. |
| Voice assistant stops after the first `working` | Known risk with some clients. Stage 4 tests exactly this. |
| No approval in the car | Session in auto or bypass mode, an allow rule covers the tool, or it is a trust or consent dialog, which is not relayed. Start the session with `scripts/start-controller.sh`. |

Claude Code's debug log is at `~/.claude/debug/<session-id>.txt`.

## Layout

```text
src/
  gateway.mjs        entry point: wires both sides, exits with the session
  channel.mjs        stdio side: channel, reply tool, permission relay
  voice.mjs          HTTP side: MCP tools for the voice assistant, secret check
  store.mjs          requests, approvals, waiting for changes
  config.mjs         environment variables, secret
  log.mjs            log to stderr and file, never to stdout
controller/
  .mcp.json          starts the gateway as server "voice"
  .claude/settings.json   approvals, deny rules, confine hook
  .claude/hooks/confine.mjs   file tools inside controller/ (writes: playground/), Bash allowlist
  CLAUDE.md          rules for the controller session
  playground/        working folder for test requests
scripts/
  start-controller.sh   start the controller with the development channel
  funnel.sh          start or stop Tailscale Funnel, print the URL
  fake-voice.mjs     play the voice assistant at the desk
  token.mjs          show or create the secret
test/
  e2e.test.mjs       end-to-end test without Claude Code
  controller.test.mjs   launcher flags, controller settings, confine hook
docs/*.drawio.svg    diagrams: an image on GitHub, editable in draw.io
```

## Limits and next steps

- One controller session only, no workers yet. Next step: a small channel with its own port per
  worker, plus controller tools such as `list_workers`, `dispatch` and `worker_status`.
- While the controller is busy, new events arrive together in its next turn. Real parallelism
  needs separate sessions ([channels reference][ref]).
- State lives in memory only; a restart forgets open requests.
- During the research preview, custom channels only run with the development flag. Flag syntax and
  protocol may change ([channels][channels]).

## Sources

- [Claude Code: channels][channels]
- [Claude Code: channels reference][ref]
- [Claude Code: permissions, rules for MCP tools][perm]
- [Claude Code: sandboxing][sandbox]
- [Tailscale: `tailscale funnel`][funnel]
- [xAI: Grok connectors][grok]
- [Claude: voice mode with connected tools][voice]
- [talk-to-claude-code][t2cc]: model for polling, the secret in the path and voice-friendly tool results

[channels]: https://code.claude.com/docs/en/channels
[ref]: https://code.claude.com/docs/en/channels-reference
[perm]: https://code.claude.com/docs/en/permissions
[sandbox]: https://code.claude.com/docs/en/sandboxing
[funnel]: https://tailscale.com/docs/reference/tailscale-cli/funnel
[grok]: https://docs.x.ai/grok/connectors
[voice]: https://support.claude.com/en/articles/11101966-use-voice-mode
[t2cc]: https://github.com/osaighi/talk-to-claude-code
