# cc-voice-gateway

Control Claude Code by talking to Claude. In a voice conversation in the Claude app, on the phone
or for example on CarPlay, Claude calls a custom MCP connector. The connector hands the request to
a Claude Code session running on your computer: the controller. It answers, asks back, and hands
work in your repositories to workers: headless Claude Code runs that commit, push and open draft
pull requests. You can speak any language.

Plain JavaScript (ESM), no build step. The only dependencies are `@modelcontextprotocol/sdk` and `zod`.

> **Status:** works with Claude voice mode on the iPhone. Workers are built and tested with a
> stand-in for Claude Code and with one real run. Claude Code channels are a research preview.

![Architecture](docs/architecture.drawio.svg)

## How it works

**One process, two sides.** Claude Code starts `src/gateway.mjs` itself, because the server is
listed in `controller/.mcp.json`, and talks to it over stdio. The gateway declares the
`claude/channel` capability, so every voice request lands in the running controller session as
`<channel source="voice" request_id="…">text</channel>`. The same process listens on
`127.0.0.1:8787` and offers MCP tools to the voice assistant there. A public HTTPS address, from a
tunnel or a reverse proxy, forwards to this port, because Claude calls connectors from its own
cloud.

**Who thinks:** the gateway is deliberately not an AI. It keeps state and relays. The controller
session (Claude Code) understands, answers, summarises and asks back. The voice assistant, Claude
in the app, runs the conversation with you.

| Side | Tool | Purpose |
|---|---|---|
| Voice assistant | `status` | Reachability, open requests and approvals |
| Voice assistant | `send` | Hand over a request, returns at once with an `id` |
| Voice assistant | `ask` | Hand over a request and wait up to 40 s for the answer |
| Voice assistant | `get_reply` | Fetch news for an `id`, waits up to 40 s |
| Voice assistant | `approve` | Allow or deny an approval with its five-letter code |
| Voice assistant | `emergency_stop` | Lock the [kill switch](#kill-switch) |
| Controller | `reply` | Answer with `state` `working`, `question` or `done` |
| Controller | `list_workers` | The repositories: origin, public or private, branch, uncommitted files, what each worker does |
| Controller | `dispatch` | Hand a task to a repository's worker, returns at once |
| Controller | `worker_status` | What a worker is doing or did last |
| Controller | `stop_worker` | Stop a worker's run |
| Controller | `raise_alarm` | Lock the kill switch when something looks wrong |
| Controller | `restart_controller` | [Restart its own session](#restarting-the-controller-by-voice) through the watchdog, after your yes |

![Request flow](docs/request-flow.drawio.svg)

**Why polling:** a single tool call must not block for long. MCP clients often abort requests
after 60 seconds ([talk-to-claude-code][t2cc]). `get_reply` therefore waits at most 40 seconds and
returns as soon as there is news. The first line of every result is machine-readable, for example
`[state=working id=k7f3 elapsed=34s]`, so the voice assistant knows whether to poll again.

**Sign-in:** the gateway is its own OAuth server. When you add the connector, Claude opens a
sign-in page served by the gateway, and you type a pairing code that this computer shows. After
that, Claude's servers call the tools with an access token. The URL holds no secret.

**Approvals:** the controller runs its few tools without asking (see [Security](#security)). If
anything else asks for approval, Claude Code also sends the prompt to the channel, because the
gateway declares `claude/channel/permission`. The voice assistant reads it out, and the first
answer wins, whether it comes by voice or from the terminal ([channels reference][ref]).

**Questions:** nobody can click a form (`AskUserQuestion`) in a voice conversation.
`controller/CLAUDE.md` therefore asks for questions as plain text with `state: "question"`. Your
answer arrives as a new request that refers to the original `id`.

**Workers:** every git repository in the folder that holds this one (`~/Developer`) has a worker,
named after its folder. The controller does no repository work itself; it only answers status
questions about pull requests, reviews and checks with read-only `gh` commands, and merges pull
requests when you ask, each one after your approval by voice. For everything else it calls
`dispatch`, and the gateway starts `claude -p` in that checkout, without approvals:
- **Before the run** the gateway checks for uncommitted changes, a run already going in that
  repository, and the limit of two runs at a time.
- **During the run** the worker branches `voice/<name>` off the current branch, commits only its
  own changes, pushes, and opens a draft pull request against that branch. On public repositories
  it asks before pushing. At the end it switches the checkout back.
- **Follow-ups** continue the same Claude session, so the worker keeps its context.
- **The result** goes to the controller as a channel event. The controller summarises it, and its
  answer reaches you as news with the next call; once the voice mode has ended, also by
  [Telegram](#telegram-fallback) if it is set up.
- **Restarts:** runs are detached and survive a controller restart; the new gateway picks them up.
- **Optionally in Docker:** the workers run in a container that sees only one folder of your
  repositories, and Claude Code. The GitHub token you give it sets what they may do: keep everything
  local, open pull requests, or also push to main. See [Workers in Docker](#workers-in-docker).
- **Kill switch:** "Notstopp" by voice, `/stop` on Telegram, fixed rules on the workers' runs, or the
  controller's alarm lock the gateway: no new tasks, every worker stops. Only a script on this
  computer unlocks it. See [Kill switch](#kill-switch).

**Telegram (optional):** voice assistants only poll, so once the conversation has ended, nobody
hears a late result. If a Telegram bot is set up, the gateway notices the silence and sends
results, questions and approval requests to your Telegram chat as well. See
[Telegram fallback](#telegram-fallback).

![States](docs/states.drawio.svg)

## Requirements

- Node.js 20 or newer (tested with 22) and npm
- Claude Code with a claude.ai login, version 2.1.80 or later for channels. In Team and Enterprise
  organisations an Owner has to enable channels; Pro and Max do not need this ([channels][channels]).
- A public HTTPS address that forwards to the gateway: a tunnel such as Tailscale Funnel, or a
  reverse proxy on a machine with a public IP. See [Publishing the endpoint](#publishing-the-endpoint).
- The Claude app on a paid plan, for custom connectors. The connector's Claude account does not
  have to be the one that runs Claude Code.
- For workers: git, and the GitHub CLI `gh`, logged in, for pushing and pull requests.
- Optional, for the [Telegram fallback](#telegram-fallback): a Telegram account and a bot. The setup
  assistant reads the chat ID; by hand, `jq` helps.
- Optional, for [workers in Docker](#workers-in-docker): Docker. The container brings its own
  git, `gh` and Claude Code.

## Setup

1. **Install.**

   ```bash
   git clone git@github.com:alderg/cc-voice-gateway.git
   cd cc-voice-gateway
   npm install
   npm test
   ```

2. **Run the setup assistant** on the computer that runs the gateway, also over SSH on a
   headless server:

   ```bash
   node scripts/setup.mjs
   ```

   It prints a one-time link for each address of the computer. Open one in a browser on any
   device in your network. The page goes through everything in order, with a short guide and a
   link to where each key comes from: the gateway's settings, the models, Telegram, workers in
   Docker, the watchdog and the plugin. At the end it writes everything into `.secrets/` and ends
   by itself. See [The setup assistant](#the-setup-assistant).

3. **Start the controller**, unless the assistant already started it in tmux:

   ```bash
   tmux new -s voice scripts/start-controller.sh
   ```

   On the first start Claude Code asks in the terminal: trust for the folder, a warning about the
   development channel, and consent for the MCP server from `.mcp.json`. Confirm all three (if the
   assistant started it, attach first with `tmux attach -t voice`). The warning comes again at
   every start, until the channel loads as a plugin on the organisation's allowlist
   ([The channel as a plugin](#the-channel-as-a-plugin-without-the-warning)). A watchdog in the
   script starts the session again after a crash
   ([Keeping the controller running](#keeping-the-controller-running)).

4. **Publish the endpoint** at a public HTTPS address, as described in
   [Publishing the endpoint](#publishing-the-endpoint). With Tailscale Funnel that is
   `scripts/funnel.sh start`. The connector URL is that address followed by `/mcp`.

5. **Add the connector** in the Claude app under Customize → Connectors → add a custom connector.
   Labels vary between app versions.
   - URL: `https://<your public host>/mcp`.
   - Authentication: sign in.
   - OAuth client: Claude's published identity. If signing in fails with it, choose to register
     automatically instead.

   Claude opens the page "Connect to Claude Code". On the computer, in this folder, run:

   ```bash
   node scripts/pair.mjs
   ```

   Enter the eight-digit code it prints. It is valid for five minutes and for one sign-in.

6. **Allow the tools.** The Claude app asks before every call to a new connector's tools. Choose
   **Always allow**, or set it per tool in the connector's settings. Otherwise voice mode stops for
   a confirmation at every step, including every `get_reply` during a long task.

7. **Try it** in voice mode: "Ask Claude Code whether the gateway is up."

### The setup assistant

![Setup assistant](docs/setup.drawio.svg)

`node scripts/setup.mjs` serves one page, which you open with the link from the terminal. It
automates what it can, and for every key it needs says in a sentence where to get it, with a link.

| Step | What the assistant does | What you give it |
|---|---|---|
| This computer | Checks Node.js, `npm install`, Claude Code (2.1.80 or later), git, the `gh` login, Docker, tmux and Tailscale | Fixes for what is marked as needed |
| Gateway | Port, repositories folder, runs at a time, time limit, approvals by voice | Your choices |
| Models | Model and effort for the controller (`--model`, `--effort` from `start-controller.sh`) and for every worker run, on this computer and in Docker | Your choices, or Claude Code's defaults |
| Telegram | Checks the bot token (`getMe`), finds your private chat with `getUpdates` once you wrote to the bot, sends a test message | A token from [@BotFather](https://t.me/BotFather), one message to the bot |
| Workers in Docker | Checks the GitHub token and shows the access level per repository, with the gateway's own detection; builds the image with its progress on the page; starts the container, sets git's name and email in it and clones the chosen repositories inside it | A token from `claude setup-token`; a GitHub token if needed ([fine-grained or classic, per level](#github-tokens-for-each-level)); the repositories |
| Watchdog | On Linux, writes a systemd user service that starts the controller in the tmux session `voice` at login, and enables it; or starts it now in tmux | Your choice; `loginctl enable-linger` for a start at boot without a login |
| Plugin | Shows whether `voice@cc-voice-gateway` is on the organisation's channel allowlist; if it is, registers this repository as the marketplace; if not, shows the admin's steps | The admin, on claude.ai |

On macOS the assistant writes a LaunchAgent and shows the `launchctl bootstrap` command that turns
it on, without running it.

**What it writes**, when you press "Write the setup":

| File | Content |
|---|---|
| `.secrets/gateway.env` | The settings, one `VOICE_GW_…=value` per line; values equal to their default are left out, others already in the file stay |
| `.secrets/telegram_token`, `.secrets/telegram_chat_id` | The bot, if the Telegram fallback is on; turned off on the page, both are deleted |
| `.secrets/worker/claude_token`, `.secrets/worker/github_token` | The container's logins, with Docker |

The folders get mode 0700 and the files 0600. Each file is written fresh with mode 0600 and then
moved into place, so it is never readable for others. Secrets you saved before stay as they are
unless you enter new ones; the page only shows them as `••••••••`. The gateway,
`start-controller.sh`, `start-workers-container.sh` and `funnel.sh` read `gateway.env` at their
next start, line by line, without running anything in it. A variable set in the environment or in
`controller/.mcp.json` wins. Run the assistant again to change something; it starts from the
current settings.

**How it is guarded.** It listens on every interface by default, so that a headless server can be
set up from a laptop.

- **One-time link:** the token in it is 256 random bits, shown only in the terminal and compared in
  constant time. With its output in a pipe or a file the assistant does not start, so the link
  never ends up in a log.
- **One browser:** the first use spends the token and binds the setup to that browser with an
  HttpOnly, SameSite=Strict session cookie. The token leaves the address bar. The same link in
  another browser is refused.
- **Wrong links:** after five from one address within ten minutes, or 30 in total, every attempt is
  refused for a while, the right one too.
- **Write requests** must come from the page's own origin, as JSON. The page has a strict Content
  Security Policy, sends no referrer, and nothing is cached.
- **It ends by itself:** after 10 minutes without a request from the page, after 30 minutes at most,
  after writing the setup, and on Cancel. Wrong links do not count as activity.
- **No HTTPS:** the page says so. Use it only in your own network, or through an SSH tunnel:
  `ssh -L 8790:localhost:8790 <server>`, then open the link with `localhost`.
- **No secret leaves it:** none goes to a log, to the terminal or back to the browser. Output of the
  commands it runs, such as `docker build`, shows a known secret as `‹secret›`.

Options: `--host` (the bind address, `0.0.0.0`), `--port` (`8790`), `--timeout` and `--idle` (in
minutes, `30` and `10`), or `VOICE_SETUP_HOST`, `VOICE_SETUP_PORT`, `VOICE_SETUP_TIMEOUT` and
`VOICE_SETUP_IDLE`.

Everything it does is also described step by step for doing it by hand:
- [Telegram fallback](#telegram-fallback)
- [Workers in Docker](#set-it-up)
- [Keeping the controller running](#keeping-the-controller-running)
- [The channel as a plugin](#the-channel-as-a-plugin-without-the-warning)
- [Configuration](#configuration)

## Publishing the endpoint

Claude's servers have to reach the gateway from the internet. Any tunnel or reverse proxy works if
it meets these conditions:

- **HTTPS on port 443** with a valid certificate. In our tests Claude's servers never reached
  port 8443.
- **Forwards every path to `127.0.0.1:8787`,** not only `/mcp`: the sign-in uses `/.well-known/…`
  and `/oauth/…`. Keep the gateway bound to loopback, and do not open port 8787 itself.
- **Passes the public host name** in `Host` or `X-Forwarded-Host`, and sends
  `X-Forwarded-Proto: https`. The gateway builds the addresses in its sign-in metadata from them.
- **Allows responses that take up to a minute,** because `get_reply` waits up to 40 seconds.

**Tailscale Funnel** (tested). On Linux, run `sudo tailscale set --operator=$USER` once, so that
the script works without root.

```bash
scripts/funnel.sh start    # prints https://<host>.ts.net/mcp
scripts/funnel.sh stop
```

On the first start Tailscale fetches a certificate, and the public name and all of Funnel's relays
can take a few minutes. The script checks through the relays and reports when all of them answer.
If another web server on the same machine listens on port 443, devices inside the tailnet reach
that one instead; the public path is not affected.

**Reverse proxy on a machine with a public IP,** for example Caddy, which gets a certificate on its
own and sets the headers above by default:

```text
voice.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

With nginx, add `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-Proto https;`.
Other tunnels, such as Cloudflare Tunnel or ngrok, work the same way when they meet the conditions.

## Using it by voice

Start a request with "Ask Claude Code …" or "Tell Claude Code …"; otherwise the voice assistant may
answer by itself. Within the same conversation it usually sends follow-ups to Claude Code without
being told.

| What you want | Example | What happens |
|---|---|---|
| Check the connection | "Ask Claude Code whether the gateway is up." | `ask`, answer within seconds |
| Ask something | "Ask Claude Code how many files are in the playground." | `ask`; the controller looks with `ls` and answers |
| Have something done | "Tell Claude Code to create a file shopping.txt in the playground with milk and bread." | `ask` or `send`; the controller writes the file without an approval and says it is done |
| Follow up | "Add eggs to it." | Same session, so the controller knows that "it" is `shopping.txt` |
| A longer task | "Tell Claude Code to wait 90 seconds and then let me know." | `send`, then `get_reply` about every 25 seconds. You hear interim statuses, then the result |
| Let it ask back | "Tell Claude Code to clean up the playground and to ask me first what may go." | The controller answers with a question, which the assistant reads out. Your answer ("Only the test files") goes back with `send` |
| See what is going on | "What is Claude Code working on right now?" | `status`: open requests, pending approvals, when the controller last answered |
| Answer an approval | "Allow." or "Deny." | `approve` with the code. Rare: only tools outside the allow list ask |
| Something out of reach | "Ask Claude Code what is in my email." | The controller says in one sentence that this is not possible |

**Any language works.** Say the same things in German, French or any other language. The voice
assistant passes your words to Claude Code unchanged, and the controller answers in the language
of the request. The Claude app reads answers out in its own app language, so speak the language
your app is set to.

The answers are short by design: at most three sentences, no code, paths or lists
(`controller/CLAUDE.md`). Requests that arrive while the controller is busy are answered together
in its next turn, so one request at a time works best.

### Working in your repositories

Name the repository as its folder is called; the controller matches loosely ("draw io m c p" is
`drawio-mcp`) and asks when unsure.

| Example | What happens |
|---|---|
| "Ask Claude Code which repositories it can work in." | `list_workers`: names, branch, uncommitted changes, what each worker is doing |
| "Ask the cc-voice-gateway worker whether the tests pass." | `dispatch`; the controller confirms at once that it is on its way, and the result follows as news |
| "Tell the cc-voice-gateway worker to fix the typo in the README." | The worker commits on a `voice/` branch, pushes and opens a draft pull request; you hear only that it is out |
| "Request a review for pull request 12 in alpha." | Only on your word: the worker reviews the diff itself and posts its findings as a review, or adds the person you name as reviewer |
| "Fix the review comments on pull request 12." | Only on your word: the worker fixes them, runs the tests, pushes to the same branch, replies on each thread, and says what is left open |
| "What is the cc-voice-gateway worker doing?" | `worker_status`, summarised in one or two sentences |
| "Anything new from Claude Code?" | Results of workers that have finished since you last asked |
| "Is anyone reviewing pull request 1 in cc-voice-gateway?" | The controller answers itself with `gh pr view` and `gh pr checks`, without a worker |
| "Did the last CI run on main pass?" | `gh run list` and, for a failure, `gh run view --log-failed`; why it fails in the code is a task for the worker |
| "Merge pull request 3 in cc-voice-gateway." | The controller asks back with the title and the merge method. After your yes it runs `gh pr merge`, which raises an approval: you confirm a second time, then hear the result |
| "Notstopp!" | The [kill switch](#kill-switch): the gateway locks before anything reaches the controller, every worker stops. Unlocking only at the computer |
| "Controller neu starten." | The controller says what a restart would do, running workers included, and asks; after your yes it [restarts through the watchdog](#restarting-the-controller-by-voice), and Telegram tells you when it is ready again |
| "Tell it to add a test for that too." | Follow-up in the same worker session, on the same branch |
| "Yes, publish it." | Answer to a worker's question, for example before pushing a public repository |
| "Stop the drawio-mcp worker." | `stop_worker` |
| "Push it straight to main." | Only for [workers in Docker](#workers-in-docker) at access level `full`: `dispatch` with `direct`. Otherwise the controller says why it stays a pull request |

If a checkout has uncommitted changes, the controller asks first whether the worker should go
ahead; a worker never commits, stashes or discards changes it did not make. Workers change files
and switch branches in your checkouts, so do not work in the same repository at the desk while a
worker runs there.

### Pull requests and reviews

Reviews do not get in your way:

- **After a push** you only hear that the pull request is out, and which one. Details when you ask.
- **No review offers.** The controller never suggests a review, not even where nothing reviews
  automatically. A review happens when you ask for one ("request a review"), and comments get
  fixed when you say so ("fix the review comments").
- **Automatic checks and reviews** run where the repository has them: GitHub Actions on pull
  requests, required reviewers or CODEOWNERS, bots such as Copilot or the Claude app. Their results
  reach you later as news, summarised in a sentence or two, without a question.

How the gateway knows: when a run ends, it looks for links to pull requests of that repository in
the run's output, and asks `gh` whether they are open on a `voice/` branch. It names them in the
result for the controller and then watches them with `gh`, every minute at first and every five
minutes later (`VOICE_GW_PR_POLL`). It does not guess from the repository's settings what will
run; it watches what shows up on the pull request:

- **Checks:** when every check on the latest push has finished, once per push.
- **Reviews and comments:** new ones, with their inline comments. Reviews and comments of the
  account `gh` is logged in as are what workers post on your behalf, so they are not news.
- **Nothing shows up** within the first five polls (no checks, no requested reviewers, no
  reviews): nothing automatic runs, and it stops quietly. Bot reviewers often skip drafts. A
  later run on the same pull request, such as a requested review, starts watching again.
- **It stops** when the pull request is merged or closed, or after 24 hours
  (`VOICE_GW_PR_WATCH_HOURS`).
- **Without a `gh` login** it does nothing; the log says so once.

Workers in Docker at access level `read-only` open no pull requests, so none of this applies there.

## Telegram fallback

Optional. Voice assistants only poll: once the voice conversation has ended, nobody picks up a
late result, question or approval request. With a Telegram bot set up, the gateway also sends these
to your Telegram chat. The dashed parts of the diagrams show it. The one thing it takes from
Telegram is `/stop` for the [kill switch](#kill-switch), and only from your chat.

**When it kicks in.** The gateway decides by itself. Every voice tool call (`status`, `send`,
`ask`, `get_reply`, `approve`) shows that the voice mode is on, and so does a `get_reply` that is
still waiting. When no call has come for 60 seconds (`VOICE_GW_TELEGRAM_AFTER`), the voice mode
counts as ended, and the log says `voice mode ended (no voice call for 60 s): telegram fallback on`.
From then on the gateway sends to Telegram:

- what the voice assistant had not picked up at that moment, and
- everything that arrives later, for example the controller's summary of a worker run that ends
  twenty minutes after you hung up.

As soon as the voice assistant calls again, Telegram goes quiet
(`voice mode on: telegram fallback paused`).

**What goes out.** Each message starts with what it is and what it belongs to:

| Kind | Sent for | First line, for example |
|---|---|---|
| Result | an answer with state `done`, including the controller's summary of a finished worker run | `Result for request k7f3 ("Run the tests.")`, `Result for request m2pq (worker cc-voice-gateway, task t3cz)` |
| Question | an answer with state `question` | `Question for request k7f3 (…)`; the message ends with `Answer in voice mode and mention k7f3.` |
| Approval request | an approval Claude Code relays (see [Security](#security)) | `Approval request abcde (controller session)`, then the tool and its details |

Interim `working` updates stay off Telegram. Each item goes out once, and only if the voice
assistant has not received it; an approval it already read out is not repeated. Telegram comes on
top of the voice path, not instead of it: when you open voice mode again, the assistant still
hears everything it has not picked up. You cannot answer by Telegram. Answer questions and
approvals in voice mode, naming the id or code, or at the terminal.

**Setup.** The [setup assistant](#the-setup-assistant) does all of this: it checks the token, finds
your chat and sends a test message. By hand: the fallback is on only when `.secrets/telegram_token`
and `.secrets/telegram_chat_id` both exist and are not empty. Without them the gateway logs one line,
`telegram fallback off: telegram_token and telegram_chat_id not both set`, and works as before.

1. **Create a bot.** In Telegram, write `/newbot` to [@BotFather](https://t.me/BotFather) and copy
   the token it gives you.
2. **Store the token** without leaving it in the shell history:

   ```bash
   mkdir -p -m 700 .secrets
   (umask 077; read -rsp 'Bot token: ' t; printf '%s' "$t" > .secrets/telegram_token)
   ```

3. **Write to your bot** from your own Telegram account: open it with the link from BotFather, tap
   Start and send any message, for example "Hallo".
4. **Read your chat ID** from the bot's updates (needs `jq`) and store it:

   ```bash
   curl -s "https://api.telegram.org/bot$(cat .secrets/telegram_token)/getUpdates" \
     | jq '.result[].message.chat | {id, type, first_name}'
   (umask 077; printf '%s' '<id of your private chat>' > .secrets/telegram_chat_id)
   ```

   Take the `id` of the chat with type `private`. If the list is empty, send the message again:
   Telegram keeps updates for 24 hours, and another program polling the same bot takes them
   away. If the bot has a webhook, `getUpdates` answers `409 Conflict`.
5. **Restart the controller** (quit the session and run `scripts/start-controller.sh` again). The
   gateway reads both files and `VOICE_GW_TELEGRAM_AFTER` only at startup, so restart it after
   every change, also to turn the fallback off by deleting a file. The log then shows
   `telegram fallback ready: after 60 s without a voice call`.

**Timeout.** 60 seconds by default. To change it, set `VOICE_GW_TELEGRAM_AFTER` (in seconds) in
`controller/.mcp.json`, as described in [Configuration](#configuration), for example
`"env": { "VOICE_GW_TELEGRAM_AFTER": "120" }`, and restart the controller. Much less than 30
seconds risks messages while the voice assistant is only speaking between two polls.

**Logs and failures.** The token stays in `.secrets/` and never appears in the log. Every message
is logged as `telegram sent: <first line>`, a failed one as
`telegram send failed: <first line> - <Telegram's error>`. A failed message is not retried, and the
voice path does not notice it.

## Connections

```bash
node scripts/pair.mjs               # pairing code for the sign-in page
node scripts/pair.mjs list          # connected clients, with when they last called
node scripts/pair.mjs revoke <id>   # disconnect one client
node scripts/pair.mjs revoke all    # disconnect every client
```

`pair.mjs` talks to the running gateway, so the controller must be running. An access token lasts
an hour, and Claude renews it with a refresh token. Each renewal issues a new refresh token valid
for 30 days, so a connector that stays unused for longer has to sign in again. Take the endpoint
offline when you do not need it, for example with `scripts/funnel.sh stop`.

## Keeping the controller running

`scripts/start-controller.sh` runs the controller session under a watchdog. The session keeps the
terminal, in tmux as above; the watchdog waits for it to end and starts it again after a crash.

![Watchdog](docs/watchdog.drawio.svg)

- **Crash or on purpose.** Exit code 0 (quitting the session) or 130 (Ctrl+C) means you ended it,
  and the watchdog ends too; so does `scripts/start-controller.sh --stop`. Any other exit code, or
  a signal such as SEGV or the kernel's out-of-memory KILL, is a crash.
- **A session that runs but no longer works.** Every 30 seconds the watchdog asks the gateway's
  `/healthz` (on the port from `controller/.mcp.json`). Once the gateway has answered, three
  failed checks in a row end the session, and it starts again. Before that, for example while the
  development-channel warning waits, it only waits.
- **No restart loops.** The pause before a restart starts at 5 seconds and doubles after each
  quick crash, up to 5 minutes; a session that ran for 10 minutes starts the pause over. After 5
  restarts within 30 minutes the watchdog gives up and exits with an error.
- **One at a time.** A lock in `.state/controller.lock` keeps a second watchdog from starting.
  `scripts/start-controller.sh --status` says whether one runs; `--stop` ends the session and the
  watchdog, without a restart. A lock left behind by a killed watchdog does not block the next
  start.
- **Log and Telegram.** Each start, each restart with its reason, and giving up go to
  `.logs/gateway.log` as `watchdog:` lines. If `.secrets/telegram_token` and
  `.secrets/telegram_chat_id` exist, a bot token from [@BotFather](https://t.me/BotFather) and your
  chat id, the watchdog also sends a short Telegram message on each restart and when it gives up,
  through `scripts/telegram-notify.mjs`, which never shows the token.
- **Without it:** `VOICE_GW_WATCHDOG=0 scripts/start-controller.sh` starts the session directly,
  as before.

### The channel as a plugin, without the warning

With `--dangerously-load-development-channels`, Claude Code asks at every start whether to load the
channel, and nothing skips that question for a channel that is not on the approved list
([channels reference][ref]). After a restart the session then waits at the terminal, and voice
requests do not arrive until someone presses Enter. The supported way around it: this repository
is also a plugin marketplace, `cc-voice-gateway`, with one plugin, `voice`
(`.claude-plugin/`), whose MCP server is the gateway (`src/plugin.mjs`) and whose channel is that
server. Once the organisation's channel allowlist names it, the controller starts with
`--channels plugin:voice@cc-voice-gateway` instead, and Claude Code asks nothing.

**What the start script does, before every start** (`scripts/channel-mode.mjs`):

- It reads the allowlist from the organisation's managed settings: the copy Claude Code keeps in
  `~/.claude/remote-settings.json`, or the managed settings file on this computer.
- If `allowedChannelPlugins` names `voice` from `cc-voice-gateway`, it registers this repository as
  that marketplace on this computer, once (`claude plugin marketplace add <this folder>`), and
  starts the session with the plugin enabled for that session only, and the project's own `voice`
  server from `controller/.mcp.json` switched off for it. The log says
  `channel: the plugin voice@cc-voice-gateway, on the organisation's channel allowlist`.
- Otherwise it starts as before, with the development flag, and the log says why:
  `channel: the development flag, since voice@cc-voice-gateway is not on the organisation's channel allowlist (allowedChannelPlugins) yet`.
- Both ways read the gateway's settings from `controller/.mcp.json`. The plugin never loads in
  other sessions, workers included: it is off unless a session enables it.
- `node scripts/channel-mode.mjs` shows the decision; `VOICE_GW_CHANNEL=development` or `plugin`
  overrides it.

**For the draw.io admin** (Owner or Primary Owner of the organisation on claude.ai; a worker
cannot do this):

1. Sign in at claude.ai and open
   [Organization settings > Claude Code > Managed settings](https://claude.ai/admin-settings/claude-code).
2. In the JSON there, keep what is in it, such as `"channelsEnabled": true`, and add the
   allowlist:

   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [
       { "marketplace": "cc-voice-gateway", "plugin": "voice" }
     ]
   }
   ```

3. **Mind the consequence before you save:** this list replaces Anthropic's default list of
   approved channel plugins **for the whole organisation**. Telegram, Discord, iMessage and
   fakechat from `claude-plugins-official` stop working as channels for every member unless the
   list names them too, for example `{ "marketplace": "claude-plugins-official", "plugin": "telegram" }`.
   An entry matches by name only: whoever registers a marketplace called `cc-voice-gateway` with a
   plugin `voice` can load it as a channel, and still has to opt in per session with `--channels`.
4. Save. Claude Code picks it up at its next start, or within an hour in a running session;
   `claude doctor` shows the `Managed settings (remote)` line.

Then nothing is left to do on the server: the next start or restart of the controller uses the
plugin. The tools keep their names in the controller's rules, but Claude Code calls them
`mcp__plugin_voice_voice__…` instead of `mcp__voice__…`; `controller/.claude/settings.json` allows
both.

If the allowlist cannot be used, two options remain: answer the warning at the terminal
(`tmux attach -t voice`, then Enter; over SSH from the phone works too), or answer it automatically,
for example with `tmux send-keys` after each restart. The latter confirms a safety prompt without a
person and is not built.

### Restarting the controller by voice

"Controller neu starten" ("restart the controller"):

1. The controller asks `restart_controller` what a restart would do, and asks you, with that, in
   plain words: which worker runs are going (they keep running and report to the restarted
   controller), that open requests with an answer stay deliverable while unfinished ones end with
   a note, and whether someone has to confirm at the terminal (only with the development flag).
2. Only after your yes it answers you ("restarting now") and calls `restart_controller` with
   `confirm`.
3. The gateway leaves a note for the watchdog (`.state/controller.lock/restart`) and ends the
   session. The watchdog starts it again at once: a requested restart, without a pause, and not
   counted towards the crash limit.
4. Once the new gateway and session are connected, you get a Telegram message that the controller
   is ready again, if the Telegram secrets exist. The same message follows a restart after a
   crash.

What survives, since the gateway runs inside the session and ends with it:

- **Worker runs:** they run outside the session, and the new gateway follows them and reports
  their results. A result the old controller had not answered yet goes to the new one again.
- **Voice requests:** the gateway keeps them in `.state/requests.json`. Answers given before the
  restart stay deliverable; a request the old session had not finished ends with
  "The controller restarted before it finished this request. Say it again if it is still needed."
- **Not:** open approvals, which belong to the old session, and the old session's conversation.
  The restarted controller starts fresh.

Without the watchdog (`VOICE_GW_WATCHDOG=0`, or a session not started by
`scripts/start-controller.sh`) the controller says it cannot restart itself.

## At the desk

`scripts/fake-voice.mjs` plays the voice assistant, so the chain can be tried without a phone. It
gets its token from the running gateway instead of the sign-in page.

```bash
node scripts/fake-voice.mjs                                 # local endpoint
node scripts/fake-voice.mjs https://<your public host>/mcp  # through the public address
```

```text
> status
> ask How many files are in the playground?
> send Create the file hello.txt in the playground with the text Grüezi
> follow
```

If Claude Code asks for an approval, fake-voice shows `Approval needed (code=abcde)`; answer with
`allow abcde` or `deny abcde`, then `follow`.

`.logs/gateway.log` has one line per connector call (`voice initialize client=… grant=…`,
`voice tools/list`, `voice tools/call ask`) and one per sign-in step (`oauth discovery`,
`oauth registered`, `oauth sign-in accepted`). It shows whether the voice assistant reached the
gateway at all, and how far it got.

`npm test` plays both ends without Claude Code or a phone: Claude Code (channel events, `reply`,
approval prompts) and the voice assistant, including the whole sign-in.

## Workers in Docker

Optional. Without it, workers run in your checkouts on this computer, as described above. With
it, they run in a container that holds Claude Code, git and `gh`, and sees nothing of this
computer but one folder of repositories, for example `~/docker-developer`, mounted at `/repos`:
no other files, no SSH keys, no `gh` login. The container runs as your own user id, so the files
in that folder are yours. The gateway stays on this computer and starts every git command and
every run in the container with `docker exec`.

On this computer, git never runs in that folder, and nobody pushes from it: the container's side
controls its config, hooks and attributes. Changes come out as a bundle into a separate clean
clone, and you push from there ([Getting changes out of the container](#getting-changes-out-of-the-container)).

![Workers in Docker](docs/docker.drawio.svg)

### Access levels

What workers in the container may do with a repository depends on the GitHub token you give the
container. The gateway checks it for each repository and tells the worker and the controller;
`list_workers` shows the level and why, for example `access pr (main is protected by a ruleset)`.

| Level | Token | Default branch | What workers do | How changes reach GitHub |
|---|---|---|---|---|
| `read-only` | none, or one that cannot push or open pull requests | any | Commit on a local `voice/` branch, worktrees too. Never push, never open a pull request; they report the local branch and commit | Only through the clean clone: you fetch the branch and push it yourself |
| `pr` | can push (Contents) and open pull requests | protected by a ruleset or branch protection | Push a `voice/` branch and open a draft pull request, so that GitHub's reviews run | The container pushes; the clean clone works as well, for example to try a branch here first |
| `full` | as `pr` | not protected | A draft pull request too, by default. A direct push to the default branch only when you explicitly ask for it ("push it straight to main") | As for `pr` |

On public repositories, workers ask before every push, at every level.

**How the gateway decides**, per repository: no token or no GitHub remote: `read-only`. Otherwise
it asks the GitHub API whether your account may push, then sends two write requests without
content (create a branch, open a pull request). GitHub answers them with "invalid request" if the
token may write, and with "forbidden" if not; neither creates anything. If both may write, it
looks at the default branch: protected by branch protection, or by a ruleset that requires pull
requests, status checks or a merge queue, or restricts updates, means `pr`; otherwise `full`. Whatever it
cannot tell counts as the lower level. It reads the token at every check and keeps each result for
ten minutes. `VOICE_GW_ACCESS=read-only`, `pr` or `full` sets one level for every repository
instead.

### Set it up

The [setup assistant](#the-setup-assistant) does steps 1 to 6: it builds the image, stores the
tokens, starts the container, clones the repositories you choose and points the gateway at the
container. By hand:

1. **Choose the folder** for the container's repositories. It must not hold your own checkouts,
   and this computer's git will never run in it. Docker installed as a snap cannot mount folders
   from `/tmp`; a folder in your home is fine.

   ```bash
   folder="$HOME/docker-developer"
   mkdir -p "$folder"
   ```

2. **Build the image** (Debian, Node 22, git, `gh`, Claude Code) for your user and group id:

   ```bash
   docker build -t cc-voice-worker --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" docker/
   ```

   The image's user `worker` gets your ids, so it owns what it writes in the folder, and git in the
   container sees the repositories as its own. `--build-arg CLAUDE_CODE_VERSION=<version>` pins
   Claude Code; rebuild to update it.

3. **Store the container's secrets** in `.secrets/worker/`, which the container mounts read-only.
   Claude Code's login comes from a long-lived token: run `claude setup-token` on this computer and
   paste the token. The GitHub token is optional; see
   [GitHub tokens for each level](#github-tokens-for-each-level).

   ```bash
   mkdir -p -m 700 .secrets/worker
   (umask 077; read -rsp 'Claude token: ' t; printf '%s' "$t" > .secrets/worker/claude_token)
   (umask 077; read -rsp 'GitHub token: ' t; printf '%s' "$t" > .secrets/worker/github_token)
   ```

   The container runs as you, so mode 0600 is enough.

4. **Start the container**, from this folder:

   ```bash
   VOICE_GW_DOCKER_FOLDER="$folder" scripts/start-workers-container.sh
   ```

   It runs, replacing a container of that name:

   ```bash
   docker run -d --name voice-workers --init --restart unless-stopped \
     --user "$(id -u):$(id -g)" \
     -v "$folder:/repos:rw" -v voice-home:/home/worker \
     -v "$PWD/.secrets/worker:/run/secrets/voice:ro" \
     cc-voice-worker
   ```

   While the [kill switch](#kill-switch) is locked, it mounts the folder `:ro` instead and sets no
   restart policy.

   `voice-home` keeps Claude Code's settings and sessions, so that follow-ups continue, and git's
   settings. The tokens never become part of the container's configuration: the gateway's
   `voice-run` hands them to each run, and git gets the GitHub token from a credential helper.

5. **Clone the repositories** the workers should see, from inside the container, and tell git who
   commits:

   ```bash
   docker exec voice-workers git clone https://github.com/<owner>/<repo>.git /repos/<repo>
   docker exec voice-workers git config --global user.name "Your Name"
   docker exec voice-workers git config --global user.email "you@example.com"
   ```

   Use `https://` addresses; the container has no SSH keys. Private repositories need a token
   that can read them, even at level `read-only`.

6. **Point the gateway at the container** in `.secrets/gateway.env`, or in `controller/.mcp.json`,
   then restart the controller:

   ```bash
   (umask 077; echo 'VOICE_GW_DOCKER=voice-workers' >> .secrets/gateway.env)
   ```

   The log shows `worker container voice-workers: repositories from host folder …, running as
   <uid>:<gid>`, with a warning if `/repos` is not a host folder or the container runs as someone
   else. "Which repositories can you work in?" lists the repositories with their access levels.
   Remove the variable and restart to go back to workers on this computer.

7. **Have a clean clone** of each repository whose changes you want to bring out: an ordinary
   clone from GitHub, outside the container's folder. Your checkouts in `~/Developer` will do; the
   helper below only adds refs to them and never touches their working tree.

### Getting changes out of the container

```bash
scripts/fetch-from-container.sh <repo> <branch>
```

1. The container writes a git bundle of the branch (`docker exec … git bundle create`), with only
   the commits your clean clone does not have yet.
2. git on this computer verifies the bundle in the clean clone and fetches it as
   `container/<branch>`, checking every object (`transfer.fsckObjects`), without tags or
   submodules.
3. It shows the new commits and prints two commands: one to review them (`git log -p`), and the
   push from the clean clone. It never checks out and never pushes. Pushing is your explicit
   step:

   ```bash
   git -C ~/Developer/<repo> push origin refs/remotes/container/<branch>:refs/heads/<branch>
   ```

`VOICE_CLEAN_ROOT` says where the clean clones are (default: the folder that holds this
repository), `VOICE_GW_DOCKER` and `VOICE_GW_DOCKER_REPOS` which container and path. The script
refuses a clean clone inside the container's folder, and names that are not plain repository or
branch names.

**Why a bundle, and not `git fetch ~/docker-developer/<repo>`.** Checked with git 2.53:

- A fetch from a local path, plain or `file://`, starts `git upload-pack` in the source
  repository, and upload-pack reads that repository's config. A container-side
  `uploadpack.hideRefs` decided which branches the host could fetch. No command ran: git ignores
  `uploadpack.packObjectsHook` from a repository's own config, upload-pack runs no hooks, and
  since 2.45.1 it refuses the lazy fetch of a crafted "partial clone" that once allowed code
  execution (CVE-2024-32004). Still, the host then opens a repository that the other side
  controls, and every new config key that upload-pack honours widens that.
- `--no-local` does not exist for `git fetch`; it only changes how `git clone` copies a local
  repository. `protocol.file.allow` does not help either: it is `user` by default, which allows
  fetches you start yourself, and `never` blocks local paths and bundles alike.
- A bundle is data: a list of refs and a pack. Fetching it reads no config, runs no hook and needs
  no repository on the other side. The container creates it, with its own config, where that does
  no harm.
- `git status` on this computer inside the container's folder ran a container-side
  `core.fsmonitor` command. That is why git must never run there: not by hand, not through a
  git-aware shell prompt, not through an editor that opens the folder.
- Fetching, `git log -p` and `git diff` of the fetched branch ran nothing. Checking it out did:
  its committed `.gitattributes` called a filter that was configured on this computer, as git-lfs
  is. Review before you check out.

**Threat model.** Anything in the container may be hostile: a worker can be steered by prompt
injection from the repositories it reads, and it controls every file in the mounted folder,
`.git` included. What this setup keeps from your computer: nothing from that folder runs here,
because git on this computer never opens a repository in it and only fetches a verified bundle
into a clean clone; and nothing goes to GitHub from this computer unless you push it. What it
does not do: decide whether the changes are good. Review them before you push or check them out,
workflow files under `.github/` above all, since they run with the repository's secrets on
GitHub. At levels `pr` and `full` the container can push by itself, within what its token allows.

### GitHub tokens for each level

Create tokens under GitHub → Settings → Developer settings → Personal access tokens. Fine-grained
tokens are limited to the repositories and permissions you pick; prefer them. A classic token
applies to every repository your account can reach. If an organisation owns the repositories,
choose it as resource owner; it may have to allow or approve fine-grained tokens first.

**Level `read-only`:**

- Public repositories only: no token. Leave out `.secrets/worker/github_token`.
- Private repositories: a fine-grained token.
  1. Fine-grained tokens → Generate new token. Give it a name and an expiration.
  2. Resource owner: your account, or the organisation that owns the repositories.
  3. Repository access: Only select repositories, and pick the ones you clone.
  4. Repository permissions: Contents: Read-only. Metadata: Read-only is added by itself. Nothing
     else.
  5. Generate the token and store it as `.secrets/worker/github_token`.
- Not with a classic token: its only scope for private repositories, `repo`, can also write.

**Level `pr`:** a token that can push and open pull requests, and a protected default branch.

1. Fine-grained token as above, with these repository permissions: Contents: Read and write, Pull
   requests: Read and write. Add Workflows: Read and write only if workers should change files in
   `.github/workflows`.
   A classic token with the `repo` scope (and `workflow` for workflow files) works too, but for
   all your repositories at once.
2. Protect the default branch in each repository, with a ruleset or with branch protection.

   **Ruleset:** the repository's Settings → Rules → Rulesets → New ruleset → New branch ruleset.
   1. Ruleset name, for example "Protect main"; Enforcement status: Active.
   2. Bypass list: leave it empty. A bypass for you or for the admin role would also let your
      token push to main.
   3. Target branches: Add target → Include default branch.
   4. Rules: Restrict deletions, Require a pull request before merging, Block force pushes. Add
      required approvals or status checks as you like.
   5. Create.

   **Branch protection:** the repository's Settings → Branches → Add classic branch protection
   rule.
   1. Branch name pattern: `main`.
   2. Require a pull request before merging.
   3. Do not allow bypassing the above settings; otherwise admins, and their tokens, can still
      push.
   4. Create.

   Rulesets and branch protection on private repositories need GitHub Pro, Team or Enterprise.
   Without them a private repository's main cannot be protected and counts as `full`;
   `VOICE_GW_ACCESS=pr` keeps workers to pull requests anyway, by their rules.
3. Check: `list_workers` shows `access pr (main is protected by a ruleset)` or
   `(… by branch protection)`.

**Level `full`:** the same token as for `pr`, and a default branch without a ruleset or branch
protection that requires pull requests. Rules that only block force pushes or deletions leave
main open. Workers still open a draft pull request unless you explicitly ask for a direct push.

**Levels are limits only as far as the token goes.** With a write token, a worker at
`read-only` (for example by `VOICE_GW_ACCESS`) could still push; its rules forbid it. To be sure
nothing leaves the container but through the clean clone, give it no write token.

## Kill switch

One switch that stops everything, in the gateway's code: it does not depend on the controller
following instructions.

![Kill switch](docs/killswitch.drawio.svg)

**What locks it:**

| Trigger | How | Checked |
|---|---|---|
| Voice | "Notstopp", "Not-Stopp", "Notfallstopp", "Nothalt", "Not-Aus", "emergency stop", "kill switch" | In `send` and `ask`, before anything reaches the controller: the message starts with the phrase, or has at most six words. "Stopp" needs its double p, so "do not stop the build" is none. Also the voice tool `emergency_stop`, which the voice assistant is told to call at once |
| Telegram | `/stop`, `/notstopp` or one of the phrases | Only from the configured private chat, and only if sent in the last two minutes; every other chat and message is ignored. The gateway polls the bot for this |
| Rule: default branch | A push to the default branch, or a merge, without an explicit direct dispatch at level `full` | `git push` with the default branch, `--all` or `--mirror` as target, and `gh pr merge`, in the run's commands. And with `gh`: the default branch moved on GitHub during the run, and the worker's repository holds the new head |
| Rule: outside | Writes outside the repository and the temporary folders | The file tools by their path; shell commands by explicit targets: redirections, `tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`, `truncate`, `sed -i`, `dd of=`, also after `cd` |
| Rule: many changes | More than 500 file edits in a run; at its end more than 300 files or 30,000 lines changed | The edits as the run makes them; at the end `git log --numstat` for commits made during the run, on any branch, plus what is not committed. Thresholds: `VOICE_GW_KILL_MAX_*` |
| Controller | `raise_alarm` with a reason | The controller may report what looks wrong; it is one more signal, never the only one |

**What it does**, at once and in this order:

- `dispatch` answers `locked` with the trigger and the time; `send` and `ask` hand nothing over;
  approvals can only be denied, open ones are denied, new ones are denied automatically.
- Every worker run stops. In the Docker setup the container stops too, and loses its restart policy.
  While locked, `scripts/start-workers-container.sh` mounts the repositories read-only, and the
  gateway stops a container with a writable `/repos` within `VOICE_GW_KILL_CHECK` seconds,
  however it was started.
- An alarm with trigger and time goes to Telegram at once, if it is set up, and to every connected
  voice chat with its next call, once per chat (`[ALARM]`). The controller is told as well.
- The state is saved in `.secrets/killswitch.json`, mode 0600: the controller's confine hook keeps it
  away from `.secrets/`, and the container only has `.secrets/worker`, read-only. It survives
  restarts of the gateway and the controller; a file that cannot be read counts as locked.

**Unlocking**, only here, at the server's terminal:

```bash
node scripts/unlock.mjs            # shows what locked it, asks you to type "unlock"
node scripts/unlock.mjs --status   # only shows it
```

It unlocks the running gateway through its admin socket, or removes the file if the gateway is not
running. There is no way to unlock by voice, Telegram or the controller. Start the worker container
again afterwards: `scripts/start-workers-container.sh`.

**What it cannot do, rule by rule:**

- **Nothing is undone.** A push, a merged pull request or a deleted branch on GitHub stays as it
  is; so do changes already written. The switch stops what comes next.
- **The rules observe, they do not prevent.** They read a run's commands as Claude Code reports
  them, so the command that breaks a rule has usually run already.
- **Default branch:** a push hidden in a script, an alias or another language is not seen in the
  commands. The check on GitHub sees the result, but only through `gh` (logged in here, every 30
  seconds and at the end of the run), and only if the worker's repository holds the new head; a
  worker that fetched someone else's push during its run can look guilty, and a push the worker
  made without keeping the commit is missed.
- **Outside:** only explicit paths count. Targets in variables (other than `$HOME`), in scripts the
  worker writes, in programs (`npm install` into `~/.npm`, a Python script) or behind symlinks are
  not seen. In the Docker setup the container limits writes anyway; on this computer it matters
  most.
- **Many changes:** a harmful change can be small, and a large refactoring can trip it; tune the
  thresholds. A run counts commits made during it, on any branch, so a fetched commit can count.
- **Voice:** if the voice assistant rewrites "Notstopp" into a longer sentence, the phrase check can
  miss it; the `emergency_stop` tool and its description are meant for that.
- **Host workers:** without Docker, a worker runs as you and could in principle reach
  `.secrets/`. While locked none runs, and none can start; a process a worker detached from its
  process group could survive the stop.

## Security

- **Only signed-in clients get in.** Signing in needs a pairing code from this computer: eight
  digits, valid for five minutes and for one sign-in, burnt after five wrong attempts. Return
  addresses are limited to Claude's hosts (`claude.ai`, `claude.com`) and loopback.
- **The setup assistant** listens on every interface while it runs, behind a one-time link, a
  session cookie for one browser, a rate limit and an origin check, and ends by itself; without
  HTTPS only in your own network ([how it is guarded](#the-setup-assistant)).
- **Tokens are stored as hashes only,** in `.secrets/oauth.json`. `pair.mjs` reaches the gateway
  through the Unix socket `.secrets/admin.sock`. Both are mode 0600, in a folder that is mode 0700.
- **Whoever is signed in can have any command run as you.** Workers run without approvals and
  outside the controller's confinement, as your user. They can use what this machine is signed in
  to: your GitHub login (push to every repository you can write to), your SSH keys and your network.
  That includes a voice assistant manipulated by prompt injection, and prompt injection through
  repository content. Run it on a VM, and if in doubt, run `node scripts/pair.mjs revoke all`.
- **What limits workers:**
  - The Claude account's connectors, messages to other sessions, and remote and scheduled agents
    are denied.
  - A repository's own MCP servers do not start.
  - Workers do not inherit the controller session's variables, so they cannot reach its messaging
    socket.
  - Public repositories: the worker asks before pushing.
  - Uncommitted changes: the controller asks before a run.
  - A run stops after 60 minutes, and at most two run at a time.
  - Everything else, such as staying on a `voice/` branch or never force-pushing, is in the
    worker's instructions: rules, not limits.
- **Workers in Docker** see only the mounted folder, the container's tokens and the network. They
  do not reach your other files, SSH keys or `gh` login, and a level is only as strict as the
  token (see [Access levels](#access-levels)). Everything in that folder counts as hostile: git on
  this computer never runs there, and changes come out only as a verified bundle into a clean
  clone (see the [threat model](#getting-changes-out-of-the-container)). Whoever controls the
  gateway can control Docker, which on Linux is as good as root.
- **Kill switch.** Voice, Telegram, fixed rules on the workers' runs and the controller's alarm can
  lock the gateway; only `scripts/unlock.mjs` at the server unlocks it. It stops what comes next,
  it undoes nothing already pushed. See [Kill switch](#kill-switch) for what each rule cannot see.
- **The endpoint is public.** Anyone on the internet can reach the sign-in page. A certificate from
  a public authority, Tailscale Funnel's included, also publishes the host name in the certificate
  transparency logs.
- **The controller session is confined.** It works without approvals, because whoever can reach it
  could answer them anyway. These limits hold regardless:
  - File tools read only inside `controller/` and write only inside `controller/playground/`
    (PreToolUse hook `controller/.claude/hooks/confine.mjs`, resolves symlinks, fails closed).
  - Bash runs only `ls` inside `controller/`, `sleep <seconds>`, `rm [-f]` with plain file
    names in `playground/`, and read-only `gh` commands (same hook). Claude Code's own Bash
    sandbox would allow more, but on Ubuntu 24.04 and later AppArmor's `bwrap-userns-restrict`
    profile stops it from starting ([sandboxing][sandbox]).
  - `gh` is an allowlist as well: `gh pr view`, `list`, `checks`, `diff` and `status`, and
    `gh run view` and `list`, each with `--repo owner/name` and only with listed read-only flags,
    such as `--json` with a plain field list, `--state`, `--limit`, `--author`, `--branch`, and
    `--log` or `--log-failed` for runs. Everything else is blocked, in particular `gh auth` (it
    would print the token), `gh api` (it can write), `gh config`, `gh alias`, `gh extension`,
    every other subcommand that writes (checkout, edit, comment, review, close, ready, rerun,
    cancel, delete, download), `--web`, `--jq` and `--template`. Read-only still means: the
    controller can read pull requests, diffs and CI logs of every repository your `gh` login can
    see, and tell them to whoever is signed in.
  - The one write is `gh pr merge <number> --repo owner/name` with exactly one of `--squash`,
    `--merge` or `--rebase`, and optionally `--delete-branch`. Blocked: `--admin` (past branch
    protection), `--auto`, `--disable-auto`, `--match-head-commit`, the message options and branch
    names instead of numbers. For an allowed merge the hook answers "ask" instead of letting it
    run: that overrides the settings' allow rule for Bash, so Claude Code opens an approval prompt,
    which the channel relays to the car. Verified with Claude Code 2.1.310: without the "ask" the
    allow rule lets the merge run at once; with it, the merge runs only once the prompt is
    allowed. `controller/CLAUDE.md` adds a spoken yes before the command, so every merge needs
    two: first to the controller's question, then to the approval.
  - Denied: claude.ai connectors (Gmail, Slack, Drive, …), web fetch and search, messages to
    other Claude sessions, remote and scheduled agents, artifacts, Monitor, workflows and
    worktrees. Bypass and auto mode cannot be switched on.
  - What is left: reading `controller/`, writing or deleting in the playground, reading the
    state of pull requests and runs on GitHub, and merging pull requests after an approval. The
    answers go back to the voice assistant.
  - Changes to the confinement, such as the `gh` commands, take effect after a controller
    restart: the session reads `controller/CLAUDE.md` and its settings when it starts.
  - The confinement keeps the controller to its job, talking and dispatching. It does not limit
    workers.
- The gateway binds to `127.0.0.1` only.
- Approval by voice means: whoever can call `approve` can approve tools, merges included. The voice
  assistant is told to approve only after an explicit yes; that is an instruction, not
  enforcement. What the approval does guarantee: the controller cannot merge by itself, for
  example because a pull request's text told it to. Turn it off with
  `VOICE_GW_PERMISSION_RELAY=0`; then merges can only be approved at the terminal.
- Claude Code masks recognisable credentials in relayed approval texts, but not every secret
  ([channels reference][ref]).
- The Telegram fallback sends results, questions and approval details through Telegram's servers.
  Bot chats are not end-to-end encrypted. Leave the two files out if that is not acceptable.
- Start the controller only with `scripts/start-controller.sh`, never with
  `--dangerously-skip-permissions`. It runs the session in manual mode, whatever default
  `~/.claude/settings.json` sets.

## Configuration

The [setup assistant](#the-setup-assistant) writes the settings into `.secrets/gateway.env`, one
`VOICE_GW_…=value` per line, which the gateway and the start scripts read at their next start
(`src/settings.mjs`, `scripts/settings.sh`). Environment variables win over the file. Claude Code
starts the gateway, so they go into `controller/.mcp.json`:

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
| `VOICE_GW_SECRETS_DIR` | `.secrets` | sign-in state and the admin socket |
| `VOICE_GW_OAUTH_HOSTS` | `claude.ai,claude.com` | hosts allowed as sign-in return addresses and for client ID metadata documents |
| `VOICE_GW_PERMISSION_RELAY` | on | `0` turns approval by voice off |
| `VOICE_GW_DEFAULT_WAIT` | `25` | wait time of `get_reply` in seconds |
| `VOICE_GW_MAX_WAIT` | `40` | upper limit for `get_reply` and `ask` |
| `VOICE_GW_HINT_AFTER` | `20` | when a diagnostic hint appears |
| `VOICE_GW_PERMISSION_TTL` | `900` | open approvals expire after this many seconds |
| `VOICE_GW_LOG_FILE` | `.logs/gateway.log` | set empty for stderr only |
| `VOICE_GW_WORKER_ROOT` | the folder holding this repository | every git repository directly in it has a worker |
| `VOICE_GW_MAX_WORKERS` | `2` | runs at the same time |
| `VOICE_GW_WORKER_TIMEOUT` | `60` | minutes before a run is stopped |
| `VOICE_GW_WORKER_MODEL` | empty | `--model` for every worker run, on this computer and in Docker, for example `opus`; empty: Claude Code's default |
| `VOICE_GW_WORKER_EFFORT` | empty | `--effort` for every worker run: `low`, `medium`, `high`, `xhigh` or `max` |
| `VOICE_GW_CONTROLLER_MODEL` | empty | for `scripts/start-controller.sh`: `--model` for the controller session; options given to the script win |
| `VOICE_GW_CONTROLLER_EFFORT` | empty | for `scripts/start-controller.sh`: `--effort` for the controller session |
| `VOICE_GW_PR_POLL` | `60` | seconds between looks at a [watched pull request](#pull-requests-and-reviews); five times as long after 15 looks |
| `VOICE_GW_PR_WATCH_HOURS` | `24` | hours after which the gateway stops watching a pull request |
| `VOICE_GW_DOCKER` | empty | name of the [worker container](#workers-in-docker); empty: workers run on this computer |
| `VOICE_GW_DOCKER_REPOS` | `/repos` | where the mounted folder is inside the container |
| `VOICE_CLEAN_ROOT` | the folder holding this repository | for `scripts/fetch-from-container.sh` only: where the clean clones are |
| `VOICE_GW_DOCKER_BIN` | `docker` | the Docker CLI |
| `VOICE_GW_ACCESS` | empty | `read-only`, `pr` or `full` for every repository in the container; empty: [detected](#access-levels) from the token |
| `VOICE_GW_GITHUB_API` | `https://api.github.com` | GitHub API for the level check; the tests point it at a stand-in |
| `VOICE_GW_KILL_MAX_EDITS` | `500` | [kill switch](#kill-switch): file edits in one run |
| `VOICE_GW_KILL_MAX_FILES` | `300` | kill switch: files changed in one run |
| `VOICE_GW_KILL_MAX_LINES` | `30000` | kill switch: lines changed in one run |
| `VOICE_GW_KILL_ALLOW_PATHS` | empty | kill switch: more folders, comma-separated, that workers may write to |
| `VOICE_GW_KILL_CHECK` | `30` | kill switch: seconds between checks of the default branch on GitHub and, while locked, of the container |
| `VOICE_GW_TELEGRAM_POLL` | `25` | seconds one poll of the Telegram bot for `/stop` waits |
| `VOICE_GW_DOCKER_FOLDER` | `~/docker-developer` | for `scripts/start-workers-container.sh`: the repositories folder |
| `VOICE_GW_DOCKER_IMAGE` | `cc-voice-worker` | for `scripts/start-workers-container.sh`: the image |
| `VOICE_GW_STATE_DIR` | `.state` | worker state and the output of every run |
| `VOICE_GW_CLAUDE_BIN` | `claude` | the Claude Code command for workers; with Docker, inside the container |
| `VOICE_GW_GH_BIN` | `gh` | the GitHub CLI, used to tell public from private repositories |
| `VOICE_GW_TELEGRAM_AFTER` | `60` | seconds without a voice tool call after which the voice mode counts as ended and the [Telegram fallback](#telegram-fallback) sends; read at startup |
| `VOICE_GW_TELEGRAM_API` | `https://api.telegram.org` | Telegram Bot API address; the tests point it at a stand-in |
| `FUNNEL_PORT` | `443` | for `scripts/funnel.sh` only; keep 443 for Claude |

The [watchdog](#keeping-the-controller-running) reads its settings from the environment of
`scripts/start-controller.sh`, for example `VOICE_GW_WATCHDOG_MAX_RESTARTS=10 scripts/start-controller.sh`:

| Variable | Default | Meaning |
|---|---|---|
| `VOICE_GW_WATCHDOG` | `1` | `0` starts the session without the watchdog |
| `VOICE_GW_CHANNEL` | decided per start | `plugin` or `development`: how the channel loads, instead of [the allowlist check](#the-channel-as-a-plugin-without-the-warning) |
| `VOICE_GW_WATCHDOG_INTERVAL` | `30` | seconds between checks of the gateway's `/healthz` |
| `VOICE_GW_WATCHDOG_HEALTH_FAILS` | `3` | failed checks in a row, after the gateway has answered once, that end the session |
| `VOICE_GW_WATCHDOG_MAX_RESTARTS` | `5` | restarts within the window before the watchdog gives up |
| `VOICE_GW_WATCHDOG_WINDOW` | `1800` | that window, in seconds |
| `VOICE_GW_WATCHDOG_BACKOFF` | `5` | first pause before a restart, in seconds; doubled after each quick crash |
| `VOICE_GW_WATCHDOG_BACKOFF_MAX` | `300` | longest pause, in seconds |
| `VOICE_GW_WATCHDOG_STABLE` | `600` | seconds a session must run for the pause to start over |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Connector dialog says no server answered, and nothing is in the log | The public address is not on port 443, or it was only just set up. Tailscale Funnel needs a few minutes on the first start; `scripts/funnel.sh start` reports when all relays answer. |
| Sign-in goes to an `http://` address or to the wrong host | The tunnel or proxy does not pass the public host name or `X-Forwarded-Proto: https` (see [Publishing the endpoint](#publishing-the-endpoint)). |
| Sign-in page says the app is not registered | The sign-in state was reset, for example because `.secrets/oauth.json` was deleted. Remove the connector and add it again. |
| Sign-in fails with Claude's published identity | Choose to register automatically instead. If the log shows `client id document not allowed: <URL>`, that host is missing from `VOICE_GW_OAUTH_HOSTS`. |
| "Wrong or expired code" | Run `node scripts/pair.mjs` again. A code lasts five minutes and one sign-in, and five wrong attempts burn it. |
| `pair.mjs` says the gateway is not running | Start the controller; the gateway runs inside its session. |
| The connector stopped working after weeks unused | The refresh token expired after 30 days. Sign in again from the connector's settings. |
| Claude asks before every tool call | Choose "Always allow" for the connector's tools. |
| Startup warning that channels are not enabled for the organisation | Team and Enterprise, including a Max seat in a Team organisation: an Owner enables Organization settings → Claude Code → Channels. `claude --debug` logs "the organization is team" in that case. |
| Channel event arrives, but no answer | The controller's turn failed, for example "Login expired". Look at the controller terminal; `/login` there. |
| `status` reports `controller=unconfirmed`, `get_reply` shows a hint | Session started without `--dangerously-load-development-channels server:voice`, or the organisation blocks channels. Check `/mcp` in the session; otherwise Claude Code drops events silently. |
| `EADDRINUSE` in the log | A second controller session is running. Start only one. |
| Voice assistant answers itself instead of asking | Say "Ask Claude Code …" explicitly. |
| Voice assistant says the connector does not work | Look at `.logs/gateway.log`. No `voice initialize`: the request never arrived (URL, tunnel or proxy, DNS). `voice 401`: the client has to sign in again. `initialize` and `tools/list` but no `tools/call`: the assistant chose not to call a tool. |
| A repository is missing from `list_workers` | Only folders directly in the worker root with a `.git` count. Check `VOICE_GW_WORKER_ROOT`. |
| A worker fails at once | `could not start claude`: Claude Code is not on the gateway's `PATH`; set `VOICE_GW_CLAUDE_BIN`. Otherwise read `.state/tasks/<task>.err`. |
| What did a worker do? | `.state/tasks/<task>.jsonl` holds the whole run. `claude --resume <session>` in the repository opens the session; `.state/workers.json` lists the session ids. |
| A private repository is handled like a public one | `gh` is not logged in or not on the `PATH`, so the visibility is unknown, and the worker asks before pushing to be safe. |
| The setup link says it is not valid or already used | The link works once, in one browser. Go on in that browser, or start `node scripts/setup.mjs` again for a new link. |
| The setup page says "Too many wrong links" | Five wrong links from one address within ten minutes, or 30 in total, block every attempt for a while. Wait, or start the assistant again. |
| The setup assistant does not start | `needs a terminal`: it shows its link only on a terminal, so run it directly, not with its output redirected. `cannot listen on …: EADDRINUSE`: choose another `--port`. |
| The setup page cannot be reached from another computer | A firewall blocks the port, or `--host` names one address only. Or use the SSH tunnel the terminal shows. |
| "Find my chat" finds nothing | Write to the bot after checking the token; Telegram keeps messages for 24 hours. A running gateway that polls the same bot takes them away: quit the controller first. |
| No Telegram message | Messages go out only after `VOICE_GW_TELEGRAM_AFTER` seconds without a voice call, and only for what the voice assistant has not picked up. `telegram fallback off` in the log: a file was missing or empty when the gateway started; fix it and restart the controller. `telegram send failed: 400 Bad Request: chat not found`: wrong chat ID, or you never wrote to the bot. `401 Unauthorized`: wrong token. |
| `The worker container voice-workers does not answer` | The container is stopped or was removed: `docker start voice-workers`, or start it as in [Workers in Docker](#workers-in-docker). |
| `access read-only (no GitHub token)` although there is one | It must be `.secrets/worker/github_token`, readable for the gateway. A new token counts at the next check, within ten minutes. |
| `access read-only (the token cannot see the repository (404))` | The token's repository access does not include it, or the organisation has not approved the token yet. |
| `access full` where you expected `pr` | No ruleset or branch protection requires pull requests on the default branch, or the private repository's plan has none. Protect it, or set `VOICE_GW_ACCESS=pr`. |
| `worker container …: /repos is a volume, not a host folder` or `… it runs as …` | The container was started without `-v <folder>:/repos` or without `--user "$(id -u):$(id -g)"`. Remove it (`docker rm -f voice-workers`) and start it as in [Set it up](#set-it-up). |
| `fetch-from-container: the container could not bundle …` | The branch does not exist in the container's repository, or the container is not running. The worker names its branch at the end of each run. |
| A worker in Docker fails at once | Claude Code is not logged in: `.secrets/worker/claude_token` is missing or expired; run `claude setup-token` again. Otherwise read `.state/tasks/<task>.err`. |
| `dispatch=locked`, `[state=locked]` or an `[ALARM]` line | The kill switch is locked; the alarm names the trigger. `node scripts/unlock.mjs --status` shows it, `node scripts/unlock.mjs` at the server unlocks it. |
| The kill switch locked for no good reason | Read the reason. A rule that misfires: raise its `VOICE_GW_KILL_*` threshold, or add a folder to `VOICE_GW_KILL_ALLOW_PATHS`. |
| `/stop` on Telegram does nothing | Only your configured private chat counts, and the gateway must poll the bot: the log says `telegram commands: …` if a webhook or another program takes the updates. |
| No news about checks or reviews on a worker's pull request | The log says why: `gh is not logged in`, or `stopped watching pull request … : nothing automatic runs` (often a draft that bot reviewers skip), `merged`, `closed` or `time limit`. Only pull requests on `voice/` branches that a run linked to are watched. `.state/pulls.json` lists the watches. |
| The controller cannot merge a pull request | A draft must be marked ready first (a task for the worker). Required reviews or checks, conflicts and other branch protection apply; `--admin` is blocked on purpose. With `VOICE_GW_PERMISSION_RELAY=0` the approval only appears at the terminal. |
| The controller says a `gh` command was blocked | Only the read-only commands under [Security](#security) pass, each with `--repo owner/name` and flags as separate words. If it does not know about `gh` at all, restart the controller so that it reads the current `controller/CLAUDE.md`. |
| No approval by voice | Expected for Bash, Write and Edit: they run without asking. For other tools: the session runs in auto or bypass mode, an allow rule covers the tool, or it is a trust or consent dialog, which is not relayed. Start the session with `scripts/start-controller.sh`. |
| The controller still starts with the development flag after the admin step | The log line `channel: the development flag, since …` says why. `node scripts/channel-mode.mjs` checks again; Claude Code fetches the organisation's settings at its start, so start any `claude` once (or wait an hour). `claude doctor` shows whether the managed settings arrived. |
| "Controller neu starten" and the controller says it cannot restart itself | It was not started by `scripts/start-controller.sh` with the watchdog. Restart it at the computer. |
| Voice requests stop arriving after a crash | The watchdog started the session again, and the development-channel warning waits: `tmux attach -t voice`, then Enter. `grep watchdog .logs/gateway.log` shows what happened. |
| `the controller is already running (watchdog …)` | A watchdog runs already, for example in another tmux window. `scripts/start-controller.sh --status`; `--stop` ends it. |
| `watchdog: giving up …` | The session kept crashing, for example because the login expired. Look at the controller terminal, fix the cause, and start it again. |

Claude Code's debug log is at `~/.claude/debug/<session-id>.txt`.

## Layout

```text
src/
  gateway.mjs        entry point: wires both sides, exits with the session
  channel.mjs        stdio side: channel, reply tool, permission relay
  voice.mjs          HTTP side: MCP tools for the voice assistant
  oauth.mjs          sign-in: OAuth metadata, registration, sign-in page, tokens
  workers.mjs        workers: find repositories, start and follow claude -p runs
  telegram.mjs       Telegram fallback once the voice mode has ended, and /stop from your chat
  killswitch.mjs     the kill switch: state, emergency phrases, the alarm
  guard.mjs          the kill switch's rules on the workers' runs
  runners.mjs        where workers run: this computer, or the Docker container
  access.mjs         access levels in the container, from the GitHub token
  pulls.mjs          watch the pull requests workers open: checks and reviews as news
  plugin.mjs         the gateway as the MCP server of the plugin voice@cc-voice-gateway
  restart.mjs        restarting the controller by voice, through the watchdog
  admin.mjs          Unix socket for pair.mjs and fake-voice
  store.mjs          requests, approvals, waiting for changes
  http.mjs           small HTTP helpers
  config.mjs         environment variables and .secrets/gateway.env
  settings.mjs       reads and writes .secrets/gateway.env
  setup/             the setup assistant: server.mjs (link, session, limits), actions.mjs (the steps), ui/ (the page)
  log.mjs            log to stderr and file, never to stdout
docker/
  Dockerfile         the worker container: Claude Code, git and gh, as your user id
  voice-run          starts a run with its tokens, in its own process group
  voice-stop         ends a run with everything it started
  git-credential-voice   the GitHub token for git
.claude-plugin/
  marketplace.json   this repository as the marketplace cc-voice-gateway
  plugin.json        the plugin voice: the gateway as an MCP server, and its channel
controller/
  .mcp.json          starts the gateway as server "voice"; settings in its env block win over .secrets/gateway.env
  .claude/settings.json   allow and deny rules, confine hook
  .claude/hooks/confine.mjs   file tools inside controller/ (writes: playground/), Bash allowlist, read-only gh
  CLAUDE.md          rules for the controller session
  playground/        working folder for requests
scripts/
  setup.mjs          the setup assistant: a temporary page that sets everything up
  settings.sh        .secrets/gateway.env for the shell scripts, read without running it
  start-controller.sh   start the controller with its channel, under a watchdog
  channel-mode.mjs   plugin or development flag: is the plugin on the organisation's allowlist?
  telegram-notify.mjs   one Telegram message, for the watchdog and the gateway
  funnel.sh          publish the endpoint with Tailscale Funnel, print the connector URL
  check-public.mjs   check the endpoint through Funnel's public relays
  pair.mjs           pairing codes, list and revoke connections
  fake-voice.mjs     play the voice assistant at the desk
  fetch-from-container.sh   bring a branch from the container into a clean clone, as a bundle
  start-workers-container.sh   start the worker container, read-only while the kill switch is locked
  unlock.mjs         unlock the kill switch, at the server only
test/
  e2e.test.mjs       both sides end to end, without Claude Code
  oauth.test.mjs     the sign-in as Claude's connector goes through it
  workers.test.mjs   workers with a stand-in for claude and gh
  telegram.test.mjs  Telegram fallback with a stand-in Bot API
  killswitch.test.mjs   the kill switch: every trigger, its effects, restart and unlocking
  docker.test.mjs    workers in the container, access levels and the bundle helper, with stand-ins for docker and GitHub
  pulls.test.mjs     watching pull requests, with a stand-in for gh
  controller.test.mjs   launcher flags, controller settings, confine hook
  watchdog.test.mjs  the watchdog, with stand-ins for claude and Telegram
  restart.test.mjs   the channel as a plugin, restarting by voice, requests across restarts
  setup.test.mjs     the setup assistant: link, session, limits, timeouts, file modes, no secret in any output, with stand-ins for Telegram, GitHub and Docker
docs/
  *.drawio.svg       diagrams: an image on GitHub, editable in draw.io
  workers-plan.md    how workers came about, and what is next
.state/              worker state, run output, watched pull requests, the watchdog's lock (not in git)
```

## Limits and next steps

- Workers have no live view. Follow a run with `worker_status`, or read its output in `.state/tasks/`.
- Voice assistants only poll, so you hear about a finished run with your next request, not when it
  ends. With the Telegram fallback, the result also arrives as a message once the voice mode has
  ended.
- Telegram takes only `/stop` from you: answers and approvals still go through voice mode or the
  terminal.
- While the controller is busy, new events arrive together in its next turn. Real parallelism
  needs separate sessions ([channels reference][ref]).
- Open requests survive a restart of the controller (`.state/requests.json`), but a request the old
  session had not finished must be said again. Connections and worker runs survive restarts too.
- During the research preview, custom channels only run with the development flag, or as a plugin
  on the organisation's allowlist. Flag syntax and protocol may change ([channels][channels]).
- After a crash the watchdog starts the session again, but with the development flag its warning
  needs someone at the terminal ([Keeping the controller running](#keeping-the-controller-running)).

## Sources

- [Claude Code: channels][channels]
- [Claude Code: channels reference][ref]
- [Claude Code: permissions][perm]
- [Claude Code: sandboxing][sandbox]
- [Claude: custom connectors][connectors]
- [Claude: voice mode with connected tools][voice]
- [MCP: authorization][mcpauth]
- [Tailscale: `tailscale funnel`][funnel]
- [talk-to-claude-code][t2cc]: model for polling and voice-friendly tool results

[channels]: https://code.claude.com/docs/en/channels
[channels-admin]: https://code.claude.com/docs/en/channels#enterprise-controls
[ref]: https://code.claude.com/docs/en/channels-reference
[perm]: https://code.claude.com/docs/en/permissions
[sandbox]: https://code.claude.com/docs/en/sandboxing
[connectors]: https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
[voice]: https://support.claude.com/en/articles/11101966-use-voice-mode
[mcpauth]: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
[funnel]: https://tailscale.com/docs/reference/tailscale-cli/funnel
[t2cc]: https://github.com/osaighi/talk-to-claude-code
