# cc-voice-gateway on macOS: install and test

The gateway, the watchdog, the setup assistant and the workers run on macOS as on Linux. What
differs: the autostart is a LaunchAgent (at login, not at boot), the watchdog keeps the Mac from
idle sleep, and the scripts run with macOS's own `/bin/bash` 3.2. No newer bash and no GNU tools
are needed. This guide takes a Mac from nothing to a tested setup; the README has the details.

## 1. Prerequisites

With [Homebrew](https://brew.sh):

```bash
brew install node git gh tmux
brew install --cask claude-code        # or: curl -fsSL https://claude.ai/install.sh | bash
brew install --cask tailscale-app      # for the Funnel; open it once and log in
brew install --cask docker-desktop     # only for workers in Docker; open it once
gh auth login
claude                                 # log in with claude.ai, then /exit
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Tailscale from the App Store or tailscale.com works too: `scripts/funnel.sh` finds the app's command
line (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`) when no `tailscale` is on the `PATH`.
Funnel must be allowed for the tailnet, as on Linux; the app needs no `--operator`.

## 2. Clone and install

```bash
mkdir -p ~/Developer && cd ~/Developer
gh repo clone alderg/cc-voice-gateway && cd cc-voice-gateway
npm install
scripts/check-macos.sh --quick
```

`check-macos.sh` prints PASS, WARN or FAIL per check: tools and versions, `bash -n` of every script
with `/bin/bash`, the settings, the LaunchAgent, what runs. Without `--quick` it also runs the test
suite, the same files as `npm test`: an INFO line says it starts, about 340 tests in about two
minutes, then it prints a dot per test, X for a failure, and its PASS or FAIL. WARN is fine for
what is optional or not set up yet.

## 3. The setup assistant

```bash
node scripts/setup.mjs
```

Open the `127.0.0.1` link in a browser on the Mac. If macOS asks whether `node` may accept
incoming connections, allow it only for links from other computers. In "Keeping the controller
running", tick both "Start it automatically" (the LaunchAgent) and "Start it now": the assistant
writes `~/Library/LaunchAgents/com.drawio.cc-voice-gateway.plist`, checks it with `plutil` and
loads it with `launchctl bootstrap`, which starts the controller in the tmux session `voice`.

Leave "keep this page open" ticked in "Write the setup": the assistant then stays up, and its
section 10, "Connect the Claude app", takes you through the rest of the README's Getting started.
Until the gateway runs it says what to do: at the first start Claude Code waits for a few
questions, which you answer in a second Terminal tab with `tmux attach -t voice`, then Ctrl-b d.
Then "Start the Funnel" publishes the endpoint and the page shows the connector URL, and "Show a
pairing code" a code for the sign-in page, valid ten minutes, with "New code" for another. Neither
`scripts/funnel.sh` nor `node scripts/pair.mjs` is needed. "End the assistant" when the connector
is signed in.

## 4. Starting and stopping

By hand, without the LaunchAgent:

```bash
tmux new -s voice scripts/start-controller.sh   # answer Claude Code's questions, then Ctrl-b d
scripts/start-controller.sh --status
scripts/start-controller.sh --stop
```

With the LaunchAgent, after `agent=gui/$(id -u)/com.drawio.cc-voice-gateway` in the shell:

| What | Command |
|---|---|
| Load it: starts the controller now and at every login | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drawio.cc-voice-gateway.plist` |
| Status | `launchctl print $agent \| head -20`, `scripts/start-controller.sh --status` |
| Stop the controller and the watchdog | `scripts/start-controller.sh --stop` |
| Start it again | `launchctl kickstart $agent` |
| Restart | `scripts/start-controller.sh --stop && launchctl kickstart $agent` |
| Unload: no start at login | `launchctl bootout $agent` (stop the controller first) |
| Take a changed plist | `launchctl bootout $agent`, then the bootstrap line |
| The session | `tmux attach -t voice` (Ctrl-b d detaches) |
| Logs | `tail -f .logs/gateway.log`; tmux's own output in `~/Library/Logs/cc-voice-gateway.log` |

The LaunchAgent only runs tmux, which returns at once (no `KeepAlive`); the watchdog in the tmux
session restarts the controller after a crash. launchd starts LaunchAgents at login: for a Mac that
comes back by itself after a power cut, turn on automatic login (System Settings, Users & Groups;
not possible with FileVault). While the watchdog runs, `caffeinate -i -s` keeps the Mac from idle
sleep (`VOICE_GW_CAFFEINATE=0` turns that off); a closed laptop lid without an external display
still sends it to sleep.

Claude Code keeps its login in the macOS keychain, which a process reaches only from your login
session. Start the controller from the LaunchAgent or a Terminal on the Mac; a tmux server first
started over SSH may not find the login (the session then says to log in). If that happens, stop
it, `tmux kill-server`, and start it again from the Mac.

## 5. What to test

Run them in this order; each says what you should see. Note the number of any step that does not
behave so, with `grep watchdog .logs/gateway.log | tail -20` and
`cat ~/Library/Logs/cc-voice-gateway.log`.

1. **The check script and the test suite.** `scripts/check-macos.sh`. Expected: no FAIL, and
   `PASS  npm test: … passed`. On a failure it names the log with the details.
2. **The scripts with bash 3.2.** `/bin/bash --version` says 3.2.57;
   `for f in scripts/*.sh; do /bin/bash -n "$f" && echo "ok $f"; done` prints `ok` for each.
3. **The setup's checks.** In step 1 of the setup page: Node.js, npm install, Claude Code, git and
   GitHub CLI green; tmux, Docker and Tailscale green where installed. Step 6 shows "at login: a
   LaunchAgent" and the macOS note, not lingering.
4. **The controller starts.** After step 3 of this guide, or `launchctl kickstart $agent`:
   `tmux attach -t voice` shows Claude Code in `controller/`; answer its questions (with the
   development flag, Enter at the channel warning), Ctrl-b d. Then `curl -s 127.0.0.1:8787/healthz`
   answers, `.logs/gateway.log` has `started by the LaunchAgent com.drawio.cc-voice-gateway` and
   `caffeinate: this Mac does not go to sleep`, and `pmset -g assertions | grep caffeinate` shows it.
   If the setup page is still open, its section 10 says "running" within a few seconds, and "Show a
   pairing code" shows eight digits with a countdown from 10:00.
5. **A voice request.** `node scripts/fake-voice.mjs`, then `ask Is the gateway up?`. Expected: a
   short answer from the controller within a minute. Leave fake-voice open for the next steps.
6. **A worker run and the git check.** A sample repository next to the gateway, with a local
   remote (the check counts commits on no remote only where there is one):

   ```bash
   git init --bare ~/voice-sample-origin.git
   cd ~/Developer && mkdir voice-sample && cd voice-sample
   git init -b main && echo hello > README.md && git add . && git commit -m init
   git remote add origin ~/voice-sample-origin.git && git push -u origin main
   ```

   In fake-voice: `send Tell the voice-sample worker to add the line "tested on macOS" to the README and commit it, without pushing.`
   Expected: the result says it is done, and the controller says the commit is on no remote and asks
   whether to push (the gateway's git check: `worker audit voice-sample … 1 commit on no remote` in
   `.logs/gateway.log`, perhaps also "not back on its starting branch").
   `answer No, keep it local.` closes it. Had the worker pushed anyway, the check says clean.
7. **stop_worker ends the whole run.** `send Tell the voice-sample worker to run sleep 100 in the shell, then report.`
   Within 30 seconds, in a second terminal: `pgrep -fl "sleep 100"` and `pgrep -fl "claude -p"` show
   it. `send Stop the voice-sample worker.` Expected: within 10 seconds both `pgrep` commands print
   nothing.
8. **The kill switch ends the whole run.** Start the same run again, then `send Emergency stop.`
   Expected: the answer says the kill switch is locked; within 10 seconds both `pgrep` commands
   print nothing; `node scripts/unlock.mjs --status` shows the lock. Unlock with
   `node scripts/unlock.mjs`, typing `unlock`.
9. **restart_controller through the watchdog.** `send Restart the controller.`, then `answer Yes.`
   Expected: the session ends and starts again at once; the log says
   `ended for a restart requested by voice … starting it again at once`. With the development flag,
   `tmux attach -t voice` and Enter. Then `ask Is the gateway up?` answers again.
10. **The LaunchAgent after logout or reboot.** Log out and in again, or reboot with automatic
    login. Expected: within a minute `tmux ls` lists `voice`, `scripts/start-controller.sh --status`
    says running, and the log has a new `started by the LaunchAgent`.
11. **Telegram, if set up.** `node scripts/telegram-notify.mjs "Test from the Mac"` prints
    `telegram: sent` and the message arrives; `/funnel` in the chat gets an answer.
12. **The Funnel, if Tailscale is set up.** `scripts/funnel.sh start` prints the connector URL and
    reports the relays; `scripts/funnel.sh state` says `on`; `scripts/funnel.sh stop`.

Afterwards: `rm -rf ~/Developer/voice-sample ~/voice-sample-origin.git`.
