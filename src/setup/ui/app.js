// The setup page. Secrets typed here go to the server once, to be checked,
// and are cleared from the page right after; the server only ever answers
// whether one is saved or new. A pairing code (section 10) comes the other way,
// once, in the answer that made it; it stays on the page only while valid.

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]
const MASK = '••••••••'

let state = null
let clock = null
let overallEnd = 0 // when the server ends at the latest
let connectTimer = null // section 10's poll
let ended = false

function end() {
  ended = true
  clearInterval(clock)
  clearInterval(connectTimer)
  $('#ended').hidden = false
  for (const element of $$('button, input, select')) element.disabled = true
  $('#clock').textContent = 'Ended.'
}

async function api(path, body) {
  if (ended) throw new Error('The setup assistant has ended.')
  let response
  try {
    response =
      body === undefined
        ? await fetch(path, { credentials: 'same-origin' })
        : await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
  } catch {
    end()
    throw new Error('The setup assistant does not answer any more.')
  }
  const data = await response.json().catch(() => null)
  if (!data && (response.status === 401 || response.status === 403)) {
    end() // a plain-text page: no longer signed in
    throw new Error('This browser is no longer signed in to the setup.')
  }
  if (state?.remaining) state.remaining.idleMs = state.idleTotal // activity
  if (!response.ok) throw new Error(data?.error || `failed (${response.status})`)
  return data ?? {}
}

function show(target, text, kind = '') {
  const element = $(target)
  element.textContent = text
  element.className = `state ${kind}`
}

// Runs an action from a button, with its result next to it.
function action(button, target, work) {
  $(button).addEventListener('click', async () => {
    $(button).disabled = true
    show(target, 'working…')
    try {
      const text = await work()
      show(target, text, 'ok')
    } catch (error) {
      show(target, error.message, 'bad')
    } finally {
      if (!ended) $(button).disabled = false
    }
  })
}

function minutes(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function startClock() {
  const { overallMs, idleMs } = state.remaining
  overallEnd = Date.now() + overallMs
  state.idleTotal = idleMs
  let last = Date.now()
  clock = setInterval(() => {
    state.remaining.idleMs -= Date.now() - last
    last = Date.now()
    const overall = overallEnd - Date.now()
    $('#clock').textContent = `Ends by itself in ${minutes(Math.min(overall, state.remaining.idleMs))} (${minutes(overall)} at most; any action resets the idle time).`
    if (overall <= 0 || state.remaining.idleMs <= 0) end()
  }, 1000)
}

// The server's own count: after a poll, which is no activity, and after
// writing, which may have moved the limit for the pairing.
function syncClock(remaining) {
  if (!state?.remaining || !(remaining?.overallMs >= 0) || !(remaining?.idleMs >= 0)) return
  overallEnd = Date.now() + remaining.overallMs
  state.remaining.idleMs = remaining.idleMs
}

function secretState(name, target) {
  const value = state.secrets[name]
  show(target, value ? `${MASK} ${value === 'new' ? 'new, checked' : 'saved; leave empty to keep it'}` : 'not set')
}

// --- filling the page ----------------------------------------------------------

function fillChecks() {
  const table = $('#checks')
  table.replaceChildren()
  for (const check of state.checks) {
    const row = table.insertRow()
    const mark = row.insertCell()
    mark.className = `mark ${check.ok ? '' : check.optional ? '' : 'bad'}`
    mark.textContent = check.ok ? '✓' : check.optional ? '–' : '✗'
    row.insertCell().textContent = check.name
    row.insertCell().textContent = check.detail
    row.insertCell().textContent = check.ok ? '' : `${check.optional ? 'optional' : 'needed'}: ${check.need}`
  }
  if (state.overridden.length) {
    $('#overridden').hidden = false
    $('#overridden').textContent = `controller/.mcp.json sets ${state.overridden.join(', ')}; those values win over what you set here.`
  }
}

function fillModels() {
  for (const select of $$('[data-model]')) {
    const current = state.settings[select.dataset.model]
    const options = ['', ...state.models, 'other']
    select.replaceChildren(
      ...options.map(value => new Option(value === '' ? 'Default' : value === 'other' ? 'Other…' : value, value)),
    )
    const other = $(`#${select.id}-other`)
    if (current && !state.models.includes(current)) {
      select.value = 'other'
      other.value = current
      other.hidden = false
    } else select.value = current
    select.addEventListener('change', () => (other.hidden = select.value !== 'other'))
  }
  for (const select of $$('[data-efforts]')) {
    select.replaceChildren(...['', ...state.efforts].map(value => new Option(value || 'Default', value)))
  }
}

function addRepo(slug, checked) {
  if ($$('#repo-list input').some(input => input.value === slug)) return
  const label = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.value = slug
  box.checked = checked
  label.append(box, ` ${slug}`)
  $('#repo-list').append(label)
}

// Shown for the levels above confined, so that it is clear what can happen.
const LEVEL_WARNINGS = {
  'clone-delete':
    'Warning: whoever can talk to the connector can then have GitHub repositories cloned into the repositories ' +
    'folder, and files and folders there deleted, whole repositories included, with uncommitted work and ' +
    'commits that are on no remote. Every deletion needs an approval by voice, but whoever can call the ' +
    'connector can give it too. A deletion cannot be undone. The gateway\'s own checkout is never deleted.',
  unrestricted:
    'Warning: the controller session is then no longer confined. Whoever can talk to the connector can have any ' +
    'command run as your user, read and change any file (.secrets/, SSH keys and logins included), reach the ' +
    'web, and use your MCP servers and connectors after an approval by voice. Text a worker brings back or a ' +
    'web page the controller reads can steer a session that can do everything, and the kill switch\'s rules ' +
    'only watch the workers, not the controller. Use it only on a computer or VM you can afford to lose.',
}

function showLevelWarning() {
  const text = LEVEL_WARNINGS[$('#controller-level').value]
  $('#level-warning').textContent = text ?? ''
  $('#level-warning').hidden = !text
}

// Shown for a kill switch that does less than lock by itself.
const KILLSWITCH_WARNINGS = {
  manual:
    'Warning: the rules then only write to the gateway log what they would have done. A worker that pushes to ' +
    'the default branch, writes outside its repository or changes unusually much goes on until you say ' +
    '"emergency stop", send /stop on Telegram, or the controller raises the alarm.',
  off:
    'Warning: nothing then locks the gateway, not even "emergency stop" by voice or /stop on Telegram; the ' +
    'gateway only logs them. Workers can be stopped one by one with stop_worker. A lock from before stays ' +
    'until it is unlocked at the computer.',
}

function showKillSwitchWarning() {
  const text = KILLSWITCH_WARNINGS[$('#killswitch-mode').value]
  $('#killswitch-warning').textContent = text ?? ''
  $('#killswitch-warning').hidden = !text
}

// Claude in Chrome: its notice at the first start waits for Enter at the
// terminal. A warning unless the server saw it confirmed in Claude Code's
// config (state.chrome.noticeSeen true); null means it cannot tell.
const CHROME_WARNING =
  'Warning: at its first start with Claude in Chrome, Claude Code shows a notice about it and waits for Enter at the ' +
  'terminal, so a restart by the watchdog or the autostart can hang on it. The start script tries to mark it as seen ' +
  'beforehand, but cannot always. Before relying on unattended restarts, start Claude Code once at the terminal, as ' +
  'this user: claude --chrome, confirm the Claude in Chrome notice with Enter, and leave with /exit.'
const CHROME_CONFIRMED = 'Claude in Chrome\'s notice for the first start is confirmed already for this user: restarts do not wait for it.'

// With it on, also what it needs (a desktop, Chrome open) and the risk.
function showChromeNotice() {
  const box = $('#chrome-notice')
  box.hidden = $('#controller-chrome').value !== '1'
  $('#chrome-guide').hidden = box.hidden
  $('#chrome-security').hidden = box.hidden
  const confirmed = state.chrome?.noticeSeen === true
  box.className = confirmed ? 'guide wide' : 'notice wide'
  if (confirmed) box.removeAttribute('role')
  else box.setAttribute('role', 'alert')
  box.textContent = confirmed ? CHROME_CONFIRMED : CHROME_WARNING
}

// The Funnel on another port than 443: Funnel serves it, but claude.ai's
// connector did not connect to it in our test.
function funnelPortNote(port) {
  return port && port !== '443'
    ? `The Funnel is set to port ${port}: Funnel serves it publicly, but claude.ai's connector did not connect to it ` +
        'in our test. Keep 443 for the connector.'
    : ''
}

function showFunnelPortNote() {
  const text = funnelPortNote($('#funnel-port').value)
  $('#funnel-port-note').textContent = text
  $('#funnel-port-note').hidden = !text
}

// The sign-in from a browser on this computer, when the setup's check under
// the tailnet name did not get the gateway (the poll's funnel.signIn): the
// name leads to this computer itself, where another web server holds port
// 443 (funnel.web443) or the Tailscale app cannot take it.
function signInText(funnel) {
  const web = funnel.web443
  const where = web ? `another web server${web.name ? ` (${web.name})` : ''} holds port 443` : 'the Tailscale app cannot take port 443'
  return (
    'The Claude app reaches the gateway over the Funnel, but a browser on this computer cannot sign in: under the ' +
    `tailnet name it reaches this computer itself, where ${where}. Sign in from another device, for example claude.ai ` +
    'in a browser on your phone with a pairing code from this page, or prepare the sign-in on this computer: with your ' +
    "administrator password, a marked line in /etc/hosts sends the name to the Funnel's public address until you have " +
    'signed in.'
  )
}

// The setup's lines in /etc/hosts (the poll's prepared: [{ address, host }]).
function showPrepared(prepared = []) {
  $('#signin-prepared').hidden = !prepared.length
  $('#signin-prepared-text').textContent = prepared.length
    ? `The sign-in on this computer is prepared: /etc/hosts sends ${prepared.map(p => `${p.host} to ${p.address}`).join(', ')}, ` +
      "the Funnel's public address. Sign in now; the line goes again by itself once the code is used or this page ends."
    : ''
}

// What to run in a terminal, where the setup has no administrator rights.
function showCommand(command) {
  $('#signin-command').hidden = !command
  $('#signin-command').textContent = command ? `In a terminal on this computer:\n${command}` : ''
}

// The work folders in a container of their own, when they are on.
const scratchDocker = () => $('#scratch-on').checked && $('#scratch-docker-on').checked

// Docker as section 1 found it: without an answer from its server neither
// container can run, so ticking one is blocked, with a line why. One that is
// on from before stays as it is, and the line says it cannot run until
// Docker answers; unticked, the setting goes when the setup is written.
const DOCKER_MISSING = what =>
  `Docker is not available on this computer (section 1), so ${what} cannot run in a container. It takes Docker ` +
  'Desktop, or the Docker engine on Linux, installed and running; then reload this page.'
const DOCKER_MISSING_KEPT = (what, name) =>
  `Docker does not answer on this computer (section 1). The setup has ${what} in the container ${name} from before ` +
  'and keeps it, but until Docker answers, that container cannot run and writing the setup cannot start it. Start ' +
  `Docker, then reload this page; or untick it to run ${what} on this computer.`

function showDockerAvailability() {
  const ready = state.checks.find(check => check.name === 'Docker')?.ok === true
  for (const [box, note, setting, what] of [
    ['#docker-on', '#docker-unavailable', 'VOICE_GW_DOCKER', 'the workers'],
    ['#scratch-docker-on', '#scratch-docker-unavailable', 'VOICE_GW_SCRATCH_DOCKER', 'the work folders'],
  ]) {
    const before = state.settings[setting]
    $(box).disabled = !ready && !before
    $(note).hidden = ready
    $(note).textContent = ready ? '' : before ? DOCKER_MISSING_KEPT(what, before) : DOCKER_MISSING(what)
  }
}

// What the two containers need on the page: the workers' everything, Claude
// Code's token for either.
function showContainers() {
  const docker = $('#docker-on').checked
  $('#docker').hidden = !docker
  $('#docker-more').hidden = !docker
  $('#claude-login').hidden = !docker && !scratchDocker()
  $('#scratch').hidden = !$('#scratch-on').checked
  $('#scratch-docker').hidden = !scratchDocker()
}

function fillSettings() {
  for (const element of $$('[data-setting]')) {
    const value = state.settings[element.dataset.setting]
    if (value !== undefined) element.value = value
  }
  showLevelWarning()
  showKillSwitchWarning()
  showChromeNotice()
  showFunnelPortNote()
  // The Funnel's idle time: 0 means never; ticking the box suggests 90.
  const idle = $('#funnel-idle')
  $('#funnel-idle-on').checked = idle.value !== '' && idle.value !== '0'
  if (!$('#funnel-idle-on').checked) idle.value = '90'
  idle.disabled = !$('#funnel-idle-on').checked
  $('#docker-on').checked = Boolean(state.settings.VOICE_GW_DOCKER)
  if (!$('#docker-name').value) $('#docker-name').value = 'voice-workers'
  $('#scratch-on').checked = state.settings.VOICE_GW_SCRATCH === '1'
  $('#scratch-docker-on').checked = Boolean(state.settings.VOICE_GW_SCRATCH_DOCKER)
  if (!$('#scratch-docker-name').value) $('#scratch-docker-name').value = 'voice-scratch'
  showDockerAvailability()
  showContainers()
  $('#telegram-on').checked = Boolean(state.secrets.telegramToken && state.secrets.telegramChatId)
  $('#git-name').value = state.git.name
  $('#git-email').value = state.git.email
  for (const repo of state.repos.host) addRepo(repo.slug, false)
  $('#docker-existing').textContent = state.repos.docker.join(', ') || 'none'
}

function fillWatchdog() {
  $('#watchdog-status').textContent = state.watchdog.status || 'unknown'
  $('#watchdog-linux').hidden = state.watchdog.platform === 'darwin'
  $('#watchdog-macos').hidden = state.watchdog.platform !== 'darwin'
  $('#watchdog-unit').textContent =
    state.watchdog.platform === 'darwin'
      ? `(at login: a LaunchAgent, ${state.watchdog.unit}${state.watchdog.unitExists ? ', exists already' : ''}${state.watchdog.loaded ? ', loaded' : ''})`
      : `(at boot: a systemd user service, ${state.watchdog.unit}${state.watchdog.unitExists ? ', exists already' : ''}${state.watchdog.linger ? ', lingering on already' : ''})`
  const tmux = state.checks.find(check => check.name === 'tmux')
  if (!tmux?.ok) {
    for (const id of ['#watchdog-autostart', '#watchdog-now']) $(id).disabled = true
  }
}

function fillPlugin() {
  const { mode, reason, allowlist } = state.plugin
  $('#plugin-status').textContent =
    mode === 'plugin'
      ? 'Ready: the plugin is on the allowlist and registered. The controller starts without the confirmation.'
      : mode === 'plugin-register'
        ? 'On the allowlist. This repository still has to be registered as the marketplace on this computer (the start script does it too).'
        : `The controller starts with the development flag: ${reason}.`
  $('#plugin-register-box').hidden = mode !== 'plugin-register'
  $('#plugin-admin').hidden = mode !== 'development'
  $('#plugin-warning').hidden = mode !== 'development'
  $('#plugin-json').textContent = JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [allowlist] }, null, 2)
}

// --- actions --------------------------------------------------------------------

action('#telegram-check', '#telegram-token-state', async () => {
  const token = $('#telegram-token').value.trim()
  if (!token) throw new Error('Paste the token first.')
  const { bot } = await api('/api/telegram/token', { token })
  $('#telegram-token').value = ''
  state.secrets.telegramToken = 'new'
  return `${MASK} new, checked: ${bot}`
})

action('#telegram-find', '#telegram-chats', async () => {
  const { chats } = await api('/api/telegram/chats', {})
  const box = $('#telegram-chats')
  if (!chats.length) throw new Error('No message from you yet. Send one to the bot, then try again.')
  setTimeout(() => {
    box.replaceChildren(
      ...chats.map((chat, index) => {
        const label = document.createElement('label')
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = 'chat'
        radio.value = chat.id
        radio.checked = index === 0
        label.append(radio, ` ${chat.name} `)
        return label
      }),
    )
  })
  return ''
})

action('#telegram-test', '#telegram-test-state', async () => {
  const chatId = $('input[name=chat]:checked')?.value
  if (!chatId) throw new Error('Find your chat first.')
  await api('/api/telegram/test', { chatId })
  state.secrets.telegramChatId = 'new'
  $('#telegram-on').checked = true
  return 'Sent. Did it arrive?'
})

action('#claude-check', '#claude-token-state', async () => {
  const token = $('#claude-token').value.trim()
  if (!token) throw new Error('Paste the token first.')
  await api('/api/claude/token', { token })
  $('#claude-token').value = ''
  state.secrets.claudeToken = 'new'
  return `${MASK} new`
})

action('#github-check', '#github-token-state', async () => {
  const token = $('#github-token').value.trim()
  if (!token) throw new Error('Paste the token first.')
  const user = await api('/api/github/token', { token })
  $('#github-token').value = ''
  state.secrets.githubToken = 'new'
  const scopes = user.kind === 'classic' && user.scopes !== null ? `, scopes: ${user.scopes || 'none'}` : ''
  const expires = user.expires ? `, expires ${user.expires}` : ''
  return `${MASK} new: ${user.kind} token of ${user.login}${scopes}${expires}`
})

$('#repo-add-button').addEventListener('click', () => {
  const slug = $('#repo-add').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return show('#levels-state', 'Write it as owner/name.', 'bad')
  addRepo(slug, true)
  $('#repo-add').value = ''
})

const chosenRepos = () => $$('#repo-list input:checked').map(input => input.value)

action('#levels-check', '#levels-state', async () => {
  const repos = chosenRepos()
  if (!repos.length) throw new Error('Choose repositories first.')
  const { levels } = await api('/api/github/levels', { repos, forced: $('#access-forced').value })
  const table = $('#levels')
  table.replaceChildren()
  for (const { slug, level, reason, visibility } of levels) {
    const row = table.insertRow()
    row.insertCell().textContent = slug
    row.insertCell().textContent = level
    row.insertCell().textContent = reason
    row.insertCell().textContent = visibility ?? ''
  }
  return ''
})

async function follow(id, log, target) {
  $(log).hidden = false
  for (;;) {
    const job = await api(`/api/jobs/${id}`)
    $(log).textContent = job.lines.join('\n')
    $(log).scrollTop = $(log).scrollHeight
    if (job.state !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 1000))
    show(target, 'working…')
  }
}

action('#docker-build', '#build-state', async () => {
  const { job } = await api('/api/docker/build', { image: $('[data-setting=VOICE_GW_DOCKER_IMAGE]').value })
  const result = await follow(job, '#build-log', '#build-state')
  if (result.state !== 'done') throw new Error('The build failed; see above.')
  return 'Built.'
})

for (const id of ['#docker-on', '#scratch-on', '#scratch-docker-on']) $(id).addEventListener('change', showContainers)
$('#controller-level').addEventListener('change', showLevelWarning)
$('#killswitch-mode').addEventListener('change', showKillSwitchWarning)
$('#controller-chrome').addEventListener('change', showChromeNotice)
$('#funnel-port').addEventListener('change', showFunnelPortNote)
$('#funnel-idle-on').addEventListener('change', () => ($('#funnel-idle').disabled = !$('#funnel-idle-on').checked))

function collect() {
  const settings = {}
  for (const element of $$('[data-setting]')) settings[element.dataset.setting] = element.value.trim()
  if (!$('#funnel-idle-on').checked) settings.VOICE_GW_FUNNEL_IDLE = '0'
  for (const select of $$('[data-model]')) {
    settings[select.dataset.model] = select.value === 'other' ? $(`#${select.id}-other`).value.trim() : select.value
  }
  const docker = $('#docker-on').checked
  if (!docker) settings.VOICE_GW_DOCKER = ''
  settings.VOICE_GW_SCRATCH = $('#scratch-on').checked ? '1' : '0'
  if (!scratchDocker()) settings.VOICE_GW_SCRATCH_DOCKER = ''
  return {
    settings,
    stay: $('#stay').checked,
    telegram: { enabled: $('#telegram-on').checked },
    docker: docker
      ? { enabled: true, repos: chosenRepos(), gitName: $('#git-name').value.trim(), gitEmail: $('#git-email').value.trim() }
      : { enabled: false },
    watchdog: { autostart: $('#watchdog-autostart').checked, startNow: $('#watchdog-now').checked },
    plugin: { register: $('#plugin-register').checked },
  }
}

action('#finish', '#finish-state', async () => {
  const body = collect()
  const { job } = await api('/api/finish', body)
  $('#cancel').disabled = true
  const result = await follow(job, '#finish-log', '#finish-state')
  $('#next').hidden = false
  if (body.stay) stayForPairing()
  else setTimeout(end, 1500)
  if (result.state !== 'done') throw new Error('Written, but not everything worked; see above.')
  return 'Done.'
})

for (const id of ['#cancel', '#end']) {
  $(id).addEventListener('click', async () => {
    try {
      await api('/api/cancel', {})
    } finally {
      end()
    }
  })
}

// --- section 10: the endpoint and a pairing code --------------------------------

let code = null // { text, until } while the code on the page is valid
let codeTimer = null
let polling = false

// Written, and staying for the pairing: the sections above are done.
function stayForPairing() {
  for (const element of $$('main > section:not(#s-connect) :is(button, input, select)')) element.disabled = true
  $('#finish').hidden = true
  $('#cancel').hidden = true
  $('#end-row').hidden = false
  $('#end-note').textContent =
    `This page stays open for connecting the Claude app. When you are done, end it here; otherwise it ends by itself ` +
    `after ${Math.round((state.idleTotal ?? 600000) / 60000)} minutes without activity (waiting for the gateway does not count).`
  $('#s-connect').scrollIntoView?.({ behavior: 'smooth' })
  connect()
}

function hideCode(text, kind = '') {
  code = null
  clearInterval(codeTimer)
  $('#pairing-code').textContent = ''
  $('#pairing-timer').textContent = ''
  $('#pairing-box').hidden = true
  if (text !== undefined) show('#pairing-state', text, kind)
}

function tickCode() {
  if (!code) return
  const left = code.until - Date.now()
  if (left <= 0) return hideCode('The code has expired. Make a new one.', 'bad')
  $('#pairing-timer').textContent = `valid for ${minutes(left)}, for one sign-in`
}

function showCode(text, expiresIn) {
  code = { text, until: Date.now() + expiresIn * 1000 }
  $('#pairing-code').textContent = text
  $('#pairing-box').hidden = false
  $('#pairing-new').textContent = 'New code'
  clearInterval(codeTimer)
  codeTimer = setInterval(tickCode, 1000)
  tickCode()
}

// While the tmux session runs and the gateway does not answer, Claude Code
// most likely waits for a confirmation at the terminal. The server looks at
// the tmux pane and names the question it sees (status.waiting): the
// development channel's, at every start without the allowlist (section 8),
// whose default goes on; or the folder trust question, whose default is "No,
// exit", which should not come, as the setup and the start script mark the
// folder as trusted beforehand. Otherwise both, in one text.
const TRUST_STEP =
  'press the down arrow once to "Yes, I trust this folder" (Enter alone picks "No, exit"), then Enter'
const LEAVE = 'then leave tmux with Ctrl-b, then d. This page notices by itself when the gateway runs.'
const WAIT_TMUX = {
  trust:
    'Action needed: Claude Code waits at the terminal for its one-time question whether you trust this folder, so the ' +
    'gateway does not start. In a terminal on this computer, or over SSH: run tmux attach -t voice, ' +
    `${TRUST_STEP}. Answer any further question with Enter, ${LEAVE}`,
  channel:
    'Action needed: Claude Code waits at the terminal for the development channel\'s confirmation, which it asks at ' +
    'every start while the plugin is not on the allowlist (section 8), so the gateway does not start. In a terminal on ' +
    'this computer, or over SSH: run tmux attach -t voice, press Enter for "I am using this for local development", ' +
    LEAVE,
  unknown:
    'Action needed: the controller runs in the tmux session "voice", but its gateway does not answer yet. Most likely ' +
    'Claude Code waits for a confirmation at the terminal, such as the development channel\'s, which comes at every ' +
    'start while the plugin is not on the allowlist (section 8). In a terminal on this computer, or over SSH: run tmux ' +
    'attach -t voice and answer it with Enter. Should it ask whether you trust this folder, which the setup marks ' +
    `as trusted beforehand, ${TRUST_STEP}; ${LEAVE}`,
}
const WAIT_START =
  'The controller is not running. Start it: tick "Start it now" in section 7 and write the setup, or at the computer: ' +
  'tmux new -s voice scripts/start-controller.sh. This page notices by itself when the gateway runs.'

function showPairing(pairing) {
  if (!pairing || !code) return
  if (pairing.state === 'valid') code.until = Date.now() + pairing.expiresInMs
  else if (pairing.state === 'used') {
    const at = pairing.at ? ` at ${new Date(pairing.at).toLocaleTimeString()}` : ''
    hideCode(`Used: ${pairing.client || 'a client'} signed in${at}. The connector is connected.`, 'ok')
  } else if (pairing.state === 'expired') hideCode('The code has expired. Make a new one.', 'bad')
  else if (pairing.state === 'gone') {
    hideCode('This code no longer works: used, replaced by a newer one (scripts/pair.mjs), burnt by wrong attempts, or the gateway restarted. Make a new one.', 'bad')
  }
}

// The poll: the gateway, the Funnel, and whether the code is still valid.
async function connect() {
  if (polling || ended) return
  polling = true
  try {
    const status = await api('/api/connect')
    syncClock(status.remaining)
    const running = status.gateway === true
    show('#connect-gateway', running ? 'running' : 'not running yet', running ? 'ok' : '')
    const question = Object.hasOwn(WAIT_TMUX, status.waiting ?? '') ? status.waiting : 'unknown'
    const wait = running ? '' : status.tmux ? WAIT_TMUX[question] : WAIT_START
    $('#connect-wait').hidden = running
    // Only when it changes: it is an alert, which a screen reader reads out.
    if ($('#connect-wait').textContent !== wait) $('#connect-wait').textContent = wait
    $('#connect-ready').hidden = !running
    showPrepared(status.prepared)
    if (running) {
      const funnel = status.funnel ?? {}
      show(
        '#connect-funnel',
        funnel.state === 'on'
          ? 'on: the endpoint is public'
          : funnel.state === 'off'
            ? 'off'
            : 'not available here (Tailscale missing or not logged in); publish the endpoint another way, README 7.3',
        funnel.state === 'on' ? 'ok' : '',
      )
      const portNote = funnelPortNote(funnel.port)
      $('#connect-port-note').textContent = portNote
      $('#connect-port-note').hidden = !portNote
      const blocked = Boolean(funnel.signIn && !funnel.signIn.ok)
      $('#signin-box').hidden = !blocked
      const note = blocked ? signInText(funnel) : ''
      if ($('#signin-note').textContent !== note) $('#signin-note').textContent = note
      $('#connect-url').textContent = funnel.url ?? ''
      $('#connect-url-row').hidden = !funnel.url
      $('#funnel-row').hidden = funnel.state !== 'off'
      showPairing(status.pairing)
    }
  } catch {
    // The page shows the end by itself when the server is gone.
  } finally {
    polling = false
  }
}

action('#pairing-new', '#pairing-state', async () => {
  const made = await api('/api/pairing', {})
  showCode(made.code, made.expiresIn)
  return 'Enter it on the sign-in page. A new code replaces this one.'
})

action('#signin-prepare', '#signin-state', async () => {
  const result = await api('/api/signin/prepare', {})
  showCommand(result.prepared ? null : result.command)
  if (!result.prepared) throw new Error('The setup has no administrator rights here: run the command below, then sign in.')
  connect()
  return result.works
    ? `Prepared: ${result.host} now reaches the gateway from this computer too. Sign in.`
    : `Prepared, but the check still does not reach the gateway (${result.why}); wait a moment, or sign in from another device.`
})

action('#signin-remove', '#signin-remove-state', async () => {
  const result = await api('/api/signin/remove', {})
  showCommand(result.command ?? null)
  if (result.command) throw new Error('The setup has no administrator rights here: run the command below.')
  connect()
  return result.removed ? 'Removed from /etc/hosts.' : 'Nothing to remove.'
})

action('#funnel-start', '#funnel-start-state', async () => {
  const { job } = await api('/api/funnel/start', {})
  const result = await follow(job, '#funnel-log', '#funnel-start-state')
  connect()
  if (result.state !== 'done') throw new Error('The Funnel did not start; see above.')
  return 'Started.'
})

// --- start ------------------------------------------------------------------------

;(async () => {
  try {
    state = await api('/api/state')
  } catch (error) {
    $('#where').textContent = error.message
    return
  }
  $('#where').textContent = `On ${state.host}, in ${state.root}.`
  fillChecks()
  fillModels()
  fillSettings()
  fillWatchdog()
  fillPlugin()
  secretState('telegramToken', '#telegram-token-state')
  secretState('claudeToken', '#claude-token-state')
  secretState('githubToken', '#github-token-state')
  if (state.secrets.telegramChatId) show('#telegram-test-state', `${MASK} chat saved`)
  startClock()
  connect()
  connectTimer = setInterval(connect, 4000)
})()
