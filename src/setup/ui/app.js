// The setup page. Secrets typed here go to the server once, to be checked,
// and are cleared from the page right after; the server only ever answers
// whether one is saved or new.

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]
const MASK = '••••••••'

let state = null
let clock = null
let ended = false

function end() {
  ended = true
  clearInterval(clock)
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
  const started = Date.now()
  const { overallMs, idleMs } = state.remaining
  state.idleTotal = idleMs
  let last = Date.now()
  clock = setInterval(() => {
    state.remaining.idleMs -= Date.now() - last
    last = Date.now()
    const overall = overallMs - (Date.now() - started)
    $('#clock').textContent = `Ends by itself in ${minutes(Math.min(overall, state.remaining.idleMs))} (${minutes(overall)} at most; any action resets the idle time).`
    if (overall <= 0 || state.remaining.idleMs <= 0) end()
  }, 1000)
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

function fillSettings() {
  for (const element of $$('[data-setting]')) {
    const value = state.settings[element.dataset.setting]
    if (value !== undefined) element.value = value
  }
  $('#docker-on').checked = Boolean(state.settings.VOICE_GW_DOCKER)
  $('#docker').hidden = !$('#docker-on').checked
  if (!$('#docker-name').value) $('#docker-name').value = 'voice-workers'
  $('#telegram-on').checked = Boolean(state.secrets.telegramToken && state.secrets.telegramChatId)
  $('#git-name').value = state.git.name
  $('#git-email').value = state.git.email
  for (const repo of state.repos.host) addRepo(repo.slug, false)
  $('#docker-existing').textContent = state.repos.docker.join(', ') || 'none'
}

function fillWatchdog() {
  $('#watchdog-status').textContent = state.watchdog.status || 'unknown'
  $('#watchdog-unit').textContent =
    state.watchdog.platform === 'darwin'
      ? `(a LaunchAgent, ${state.watchdog.unit})`
      : `(a systemd user service, ${state.watchdog.unit}${state.watchdog.unitExists ? ', exists already' : ''})`
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

$('#docker-on').addEventListener('change', () => ($('#docker').hidden = !$('#docker-on').checked))

function collect() {
  const settings = {}
  for (const element of $$('[data-setting]')) settings[element.dataset.setting] = element.value.trim()
  for (const select of $$('[data-model]')) {
    settings[select.dataset.model] = select.value === 'other' ? $(`#${select.id}-other`).value.trim() : select.value
  }
  const docker = $('#docker-on').checked
  if (!docker) settings.VOICE_GW_DOCKER = ''
  return {
    settings,
    telegram: { enabled: $('#telegram-on').checked },
    docker: docker
      ? { enabled: true, repos: chosenRepos(), gitName: $('#git-name').value.trim(), gitEmail: $('#git-email').value.trim() }
      : { enabled: false },
    watchdog: { autostart: $('#watchdog-autostart').checked, startNow: $('#watchdog-now').checked },
    plugin: { register: $('#plugin-register').checked },
  }
}

action('#finish', '#finish-state', async () => {
  const { job } = await api('/api/finish', collect())
  $('#cancel').disabled = true
  const result = await follow(job, '#finish-log', '#finish-state')
  $('#next').hidden = false
  setTimeout(end, 1500)
  if (result.state !== 'done') throw new Error('Written, but not everything worked; see above.')
  return 'Done.'
})

$('#cancel').addEventListener('click', async () => {
  try {
    await api('/api/cancel', {})
  } finally {
    end()
  }
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
})()
