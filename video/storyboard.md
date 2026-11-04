# Storyboard: the messages, the product page and the video

What the product page (`docs/index.html`) and the video (`video/`) say, and in which order. The
README stays the technical documentation; it uses the same names for the same things.

**Who it is for:** developers who already use Claude Code and the Claude app, and who want their
Claude Code sessions to keep working while they are away from the keyboard, or while they work on something else at
the computer.

**The problem it solves:** Claude's voice mode is a great partner to talk with, but it cannot reach
Claude Code. In the Claude app, Claude Code only has dictation. So the moment you leave the
keyboard, your agents stop hearing from you, and you stop hearing from them.

**One line:** Claude Code, by voice. Talk to Claude, and a team of Claude Code agents on your own
computer does the work and tells you how it went.

## The five messages

| # | Message | What it means for the user | Proof points |
|---|---|---|---|
| 1 | **Voice control for Claude Code** | Talk instead of type, wherever you are | Claude's voice mode in any language; in the car with CarPlay or Android Auto (tested with CarPlay); at the desk, a voice conversation in the Claude app runs while you keep using mouse and keyboard; on the go, on the phone. Answers are written to be heard: short, no code, no paths |
| 2 | **Three layers of AI, one conversation** | You talk to one assistant; behind it, a team is organised for you | The **voice AI** (Claude voice mode) listens, understands and passes the request on. The **controller** (a Claude Code session on your computer) keeps the context, dispatches and steers the workers, asks back and sums up their results. The **workers** (headless Claude Code runs) do the work in your repositories |
| 3 | **Parallel workers, isolated where you want** | Several things get done at once, without stepping on each other | Several repositories at once; several runs per repository in git worktrees of their own; a queue that starts the next task by itself; work folders for tasks without a repository (research, calculations, drafts); on your computer or in Docker containers |
| 4 | **It comes back to you** | Nothing gets lost after you hang up | Results as short spoken news, summed up by the controller; questions and approvals pushed to Telegram after the call; pull requests watched, checks and reviews as news, review comments fixed automatically; "What is open?" lists every open decision; reminders; follow the controller in the Claude app with Remote Control |
| 5 | **Safe by design** | You stay in control of what lands | Every change on a branch, as a pull request; merges need your yes, twice; workers start only on your spoken words, never on text a pull request or a web page brought in; Docker containers whose GitHub token sets what they may publish; a confined controller; "emergency stop" locks everything in code, unlocked only by you, at your computer or in voice mode with a PIN from Telegram; sign-in with a pairing code; runs on your own computer |

Always with them, never left out: driving comes first; a prototype, provided as-is, without
support; not an Anthropic product.

## Use cases

- **The commute.** In the car with CarPlay or Android Auto: "Why did the build fail on main?",
  "Fix it and open a pull request." The result comes as news a few minutes later.
- **At the desk, next to your own work.** A voice conversation runs in the Claude app while you
  work with mouse and keyboard on something else: "Tell the alpha worker to update the changelog."
- **Away from the desk.** On a walk, at the gym, while cooking: review comments, CI, small fixes,
  research in a work folder. The files wait at your desk.
- **The long task.** Start it by voice, hang up. If a worker needs a decision, the question reaches
  you on Telegram.

## The product page, top to bottom

1. **Hero:** "Claude Code, by voice." One paragraph, two buttons (video, GitHub), where it works
   (car, desk, phone), the video.
2. **The gap:** voice mode can talk, Claude Code can work; until now they did not reach each other.
3. **01 Voice control:** the three use cases as cards.
4. **02 Three layers of AI:** the voice AI, the controller and the workers, as an animated diagram.
5. **03 Parallel workers:** lanes of runs, worktrees, work folders and containers, with the queue.
6. **04 It comes back to you:** a phone with spoken news and a Telegram push; the feedback loop.
7. **05 Safe by design:** six guarantees and the emergency stop.
8. **What you can say:** sample requests and what they lead to.
9. **Get started:** three steps and the prerequisites.
10. **Driving comes first** and **a prototype, provided as-is.**

## The video, scene by scene

About two minutes, voice Kokoro `af_heart`, captions in the frame. The spoken text is in
`script.json`; the frames are animated in `slides.html`, in the product page's look: a drive past
the signs of a motorway, with each message's green sign at the top right, as on the page.

| Scene | Message | Picture | Voiceover (short) |
|---|---|---|---|
| `intro` | – | The page's green direction sign on its posts: the name, then "Claude Code, by voice." with the car, the desk, the phone and any language | This is cc-voice-gateway: Claude Code, by voice. |
| `gap` | Problem | The route from voice mode to Claude Code, closed by a road barrier, then bridged by the gateway's sign | Voice mode can talk, but it cannot reach Claude Code. The gateway connects them. |
| `anywhere` | 1 | Three blue information signs: car, desk, on the go, each with the driver's words | In the car, at your desk while you keep working with mouse and keyboard, or on the go. |
| `dialog` | 1 | A transcript of the conversation, a worker's terminal on a dark display next to it | Ask why the build failed; ask for a fix; a pull request is open. |
| `layers` | 2 | Voice AI, controller, workers as numbered cards, a short stretch of road between them | Three layers of AI: listen and pass on; keep context, steer and sum up; do the work. |
| `parallel` | 3 | The page's board of workers on a dark display, filling up to four running and one queued | Several workers in parallel, in worktrees, in work folders, in containers. |
| `back` | 4 | A phone in voice mode, and what reaches you: spoken news, a Telegram question, checks, a review fixed | Results come back as short news; questions follow you to Telegram; reviews get fixed. |
| `safe` | 5 | The rules build up, then the red STOP sign and "Emergency stop." | Pull requests; a merge needs your yes twice; your words only; emergency stop. |
| `end` | – | The direction sign again, the GitHub address on a blue plate beneath it, the notice on a plain plate on its posts | Open source, on GitHub. A prototype, provided as-is. |
