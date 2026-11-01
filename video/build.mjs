#!/usr/bin/env node
// Builds the product video from script.json and slides.html:
//   node video/build.mjs [output.mp4]
// One voiceover clip per line (Kokoro, voice af_heart, through tts.py), then the animated frames:
// headless Chrome renders slides.html at every frame's time, and ffmpeg encodes them with the
// voice. The voice-mode level meters in the frames follow the voiceover's loudness. Needs Google
// Chrome (CHROME points elsewhere), ffmpeg and Kokoro (see video/README.md). VOICE overrides the voice in script.json. TTS=say speaks with
// macOS `say` instead, for a quick draft. STILLS=<folder> writes one frame per line there instead
// of the video, to look at the layout.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = resolve(process.argv[2] ?? join(ROOT, 'docs', 'assets', 'cc-voice-gateway.mp4'))
const STILLS = process.env.STILLS ? resolve(process.env.STILLS) : null
const CHROME = process.env.CHROME ?? findChrome()
function findChrome() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  return 'google-chrome'
}
const script = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'))
const TTS = process.env.TTS ?? 'kokoro'
const VOICE = process.env.VOICE ?? (TTS === 'say' ? 'Samantha' : script.voice)
const KOKORO_PYTHON = process.env.KOKORO_PYTHON ?? join(homedir(), '.cache', 'kokoro', 'venv', 'bin', 'python')
const CACHE = join(tmpdir(), 'ccvg-voice-cache') // spoken lines, by voice and text

const FPS = 30
const LEAD = 0.6 // before the first line
const VOICE_DELAY = 0.25 // a line's voice starts this long after its animations
const GAP_LINE = 0.45 // after a line within a scene
const GAP_SCENE = 0.9 // after the last line of a scene, plus the scene's "hold"

const tmp = mkdtempSync(join(tmpdir(), 'ccvg-video-'))
function run(cmd, args, input) {
  try {
    return execFileSync(cmd, args, { input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`${cmd} failed: ${String(error.stderr ?? error.message).trim().slice(-2000)}`)
  }
}
const duration = file =>
  Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString())

// The voiceover, one clip per line, kept in CACHE so that a change to the frames needs no new voice.
const lines = script.scenes.flatMap(scene => scene.lines)
function speak() {
  mkdirSync(CACHE, { recursive: true })
  const keyed = lines.map(line => {
    const key = createHash('sha256').update(`${TTS}\n${VOICE}\n${line.say}`).digest('hex').slice(0, 20)
    return { say: line.say, key, file: join(CACHE, `${key}.${TTS === 'say' ? 'aiff' : 'wav'}`) }
  })
  const missing = keyed.filter(line => !existsSync(line.file))
  if (TTS === 'say') {
    for (const line of missing) run('say', ['-v', VOICE, '-o', line.file, line.say])
  } else if (missing.length) {
    const job = JSON.stringify({ voice: VOICE, lines: missing.map(line => ({ id: line.key, say: line.say })) })
    const result = spawnSync(KOKORO_PYTHON, [join(HERE, 'tts.py'), CACHE], {
      input: job,
      stdio: ['pipe', 'pipe', 'inherit'],
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`tts.py failed (${result.error?.message ?? `exit ${result.status}`}); see video/README.md`)
  }
  return keyed.map(line => ({ file: line.file, seconds: duration(line.file) }))
}
const voices = speak()

// The timeline: when each scene and line starts, when its voice starts and ends.
let at = LEAD
let k = 0
const scenes = script.scenes.map(scene => {
  const start = at
  const sceneLines = scene.lines.map((line, li) => {
    const voice = voices[k++]
    const l = { start: at, voice: at + VOICE_DELAY, caption: line.caption ?? line.say, file: voice.file }
    l.end = l.voice + voice.seconds
    at = l.end + (li === scene.lines.length - 1 ? GAP_SCENE + (scene.hold ?? 0) : GAP_LINE)
    return l
  })
  return { id: scene.id, start, lines: sceneLines, captions: scene.captions !== false }
})
scenes[0].start = 0
scenes.forEach((scene, i) => { scene.end = scenes[i + 1]?.start ?? at })
const total = at
const frames = Math.ceil(total * FPS)
console.log(`${lines.length} lines, ${scenes.length} scenes, ${total.toFixed(1)} s, voice ${VOICE} (${TTS})`)

// The voice track, normalised, and its loudness per frame for the waveforms.
const voiceTrack = join(tmp, 'voice.wav')
const placed = scenes.flatMap(scene => scene.lines)
run('ffmpeg', [
  '-v', 'error', '-y', ...placed.flatMap(line => ['-i', line.file]),
  '-filter_complex',
  placed.map((line, i) => {
    const delay = Math.round(line.voice * 1000)
    return `[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${delay}[a${i}]`
  }).join(';') + ';' +
    `${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:normalize=0,` +
    `apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`,
  '-map', '[a]', '-ac', '2', '-ar', '48000', voiceTrack,
])
const pcm = run('ffmpeg', ['-v', 'error', '-i', voiceTrack, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
const per = 48000 / FPS
const levels = []
let held = 0
for (let f = 0; f < frames; f++) {
  let sum = 0
  for (let i = f * per; i < (f + 1) * per && i < samples.length; i++) sum += (samples[i] / 32768) ** 2
  const db = 10 * Math.log10(sum / per + 1e-10)
  const now = Math.max(0, Math.min(1, (db + 42) / 30))
  held = now > held ? held + (now - held) * 0.7 : held * 0.82 + now * 0.18
  levels.push(Number(held.toFixed(3)))
}

// Chrome over the DevTools protocol: one page, render(t), one screenshot per frame.
async function chrome() {
  const profile = join(tmp, 'chrome')
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars',
    '--window-size=1920,1080', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100))
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = message => {
    const msg = JSON.parse(message.data)
    if (!msg.id || !pending.has(msg.id)) return
    const { res, rej } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`slides.html: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result.value
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__BUILD__ = true' })
  await send('Page.navigate', { url: pathToFileURL(join(HERE, 'slides.html')).href })
  for (let i = 0; i < 100 && (await evaluate('document.readyState + typeof window.render')) !== 'completefunction'; i++)
    await new Promise(r => setTimeout(r, 100))
  await evaluate('document.fonts.ready.then(() => true)')
  const timeline = { total, fps: FPS, levels, scenes: scenes.map(({ id, start, end, captions, lines }) => ({ id, start, end, captions, lines: lines.map(({ file, ...line }) => line) })) }
  await evaluate(`setup(${JSON.stringify(timeline)}), true`)
  const shot = async (t, opts = {}, format = 'png') => {
    await evaluate(`render(${t}, ${JSON.stringify(opts)}), new Promise(r => requestAnimationFrame(() => r(true)))`)
    const { data } = await send('Page.captureScreenshot', format === 'png' ? { format, optimizeForSpeed: true } : { format, quality: 88 })
    return Buffer.from(data, 'base64')
  }
  const exited = new Promise(r => proc.once('exit', r))
  return { shot, close: async () => { ws.close(); proc.kill(); await exited } }
}

const browser = await chrome()
try {
  if (STILLS) {
    mkdirSync(STILLS, { recursive: true })
    let n = 0
    for (const scene of scenes) {
      for (const [li, line] of scene.lines.entries()) {
        const t = line.voice + (line.end - line.voice) * 0.8
        writeFileSync(join(STILLS, `${String(++n).padStart(2, '0')}-${scene.id}-${li}.png`), await browser.shot(t))
      }
      writeFileSync(join(STILLS, `${String(n).padStart(2, '0')}-${scene.id}-end.png`), await browser.shot(scene.end - 0.4))
    }
    console.log(`${STILLS}: ${n} lines`)
  } else {
    mkdirSync(dirname(OUT), { recursive: true })
    const encoder = spawn('ffmpeg', [
      '-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', '-', '-i', voiceTrack,
      '-map', '0:v', '-map', '1:a',
      // Converted with the BT.709 matrix and tagged BT.709 throughout, so that browsers show the
      // page's own colours (untagged, ffmpeg's default BT.601 matrix turns the signs' green darker);
      // the tags go on the frames, which win over the encoder's options. Square pixels said
      // explicitly (SAR 1:1, so 16:9), and High profile at level 4.1 with at most 4 reference
      // frames, which every phone decodes (tune animation alone asks for 10 and level 5.0).
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,' +
        'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-tune', 'animation',
      '-profile:v', 'high', '-level:v', '4.1', '-refs', '4', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-t', total.toFixed(3), OUT,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    const finished = new Promise((res, rej) => encoder.on('close', code => (code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)))))
    const began = Date.now()
    for (let f = 0; f < frames; f++) {
      const png = await browser.shot(f / FPS)
      if (!encoder.stdin.write(png)) await new Promise(r => encoder.stdin.once('drain', r))
      if (f % (FPS * 10) === 0) process.stdout.write(`\r${(f / FPS).toFixed(0)} of ${total.toFixed(0)} s, ${((Date.now() - began) / 1000).toFixed(0)} s so far`)
    }
    encoder.stdin.end()
    await finished
    process.stdout.write('\n')

    // The poster, and the thumbnail with a play button for the README.
    const assets = dirname(OUT)
    const posterAt = scenes[0].lines[1].voice + 1.2
    writeFileSync(join(assets, 'video-poster.jpg'), await browser.shot(posterAt, { captions: false, bare: true }, 'jpeg'))
    writeFileSync(join(assets, 'video-thumbnail.jpg'), await browser.shot(posterAt, { captions: false, play: true }, 'jpeg'))
    console.log(`${OUT}: ${duration(OUT).toFixed(1)} s`)
  }
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}
