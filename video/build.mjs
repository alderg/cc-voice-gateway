#!/usr/bin/env node
// Builds the product video from script.json and slides.html:
//   node video/build.mjs [output.mp4]
// One voiceover clip per line (macOS `say`), one frame per line (headless Chrome),
// a slow zoom per scene, cross-fades between lines and scenes, captions in the
// frames. Needs macOS, Google Chrome and ffmpeg. VOICE and RATE override the
// voice and words per minute in script.json, for example
//   VOICE="Ava (Premium)" node video/build.mjs
// after adding that voice in System Settings > Accessibility > Spoken Content.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = resolve(process.argv[2] ?? join(ROOT, 'docs', 'assets', 'cc-voice-gateway.mp4'))
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const script = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'))
const VOICE = process.env.VOICE ?? script.voice
const RATE = process.env.RATE ?? String(script.rate)

const FPS = 30
const LEAD = 0.5 // silence before the first line
const VOICE_DELAY = 0.2 // a line's voice starts this long into its segment
const GAP_LINE = 0.5 // after a line within a scene
const GAP_SCENE = 1.3 // after the last line of a scene
const HOLD_END = 3.5 // the end card stays this long after its line
const FADE_LINE = 0.35
const FADE_SCENE = 0.7
const ZOOM_PER_SECOND = 0.0035 // 1.00 to about 1.04 over a scene

const tmp = mkdtempSync(join(tmpdir(), 'ccvg-video-'))
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`${cmd} failed: ${String(error.stderr ?? error.message).trim().slice(-2000)}`)
  }
}
const duration = file =>
  Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString())

// The lines, each with its voice clip and its segment's length.
const segments = []
script.scenes.forEach((scene, si) => {
  scene.lines.forEach((line, li) => {
    const i = segments.length
    const voice = join(tmp, `voice-${i}.aiff`)
    run('say', ['-v', VOICE, '-r', RATE, '-o', voice, line.say])
    const spoken = duration(voice)
    const last = li === scene.lines.length - 1
    const final = last && si === script.scenes.length - 1
    let length = VOICE_DELAY + spoken + (final ? HOLD_END : last ? GAP_SCENE : GAP_LINE)
    if (i === 0) length += LEAD
    segments.push({
      scene: scene.id,
      build: line.build,
      caption: scene.captions === false ? '' : line.caption ?? line.say,
      voice,
      length,
      fade: final ? 0 : last ? FADE_SCENE : FADE_LINE, // into the next segment
      lead: i === 0 ? LEAD : 0,
    })
  })
})
let at = 0
let sceneStart = 0
segments.forEach((segment, i) => {
  if (i === 0 || segments[i - 1].scene !== segment.scene) sceneStart = at
  segment.start = at
  segment.inScene = at - sceneStart
  at += segment.length
})
const total = at
console.log(`${segments.length} lines, ${total.toFixed(1)} s, voice ${VOICE} at ${RATE} words per minute`)

// One frame per line.
const page = join(HERE, 'slides.html')
const shoot = (file, hash) =>
  run(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    `--screenshot=${file}`,
    `file://${page}#${new URLSearchParams(hash)}`,
  ])
segments.forEach((segment, i) => {
  segment.frame = join(tmp, `frame-${i}.png`)
  shoot(segment.frame, { s: segment.scene, b: segment.build, c: segment.caption, p: (segment.start + segment.length) / total })
})

// One clip per line, with the scene's zoom continuing across its lines.
segments.forEach((segment, i) => {
  segment.clip = join(tmp, `clip-${i}.mp4`)
  const seconds = segment.length + segment.fade
  const z0 = segment.inScene * ZOOM_PER_SECOND
  const zoom = `1+${z0.toFixed(5)}+${(ZOOM_PER_SECOND / FPS).toFixed(7)}*on`
  run('ffmpeg', [
    '-v', 'error', '-y', '-loop', '1', '-framerate', String(FPS), '-t', seconds.toFixed(3), '-i', segment.frame,
    '-vf', `scale=3840:2160:flags=lanczos,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', segment.clip,
  ])
})

// Cross-fades: each one starts where the next line's segment starts.
const inputs = segments.flatMap(segment => ['-i', segment.clip])
const filters = []
let label = '[0:v]'
segments.slice(1).forEach((segment, j) => {
  const out = j === segments.length - 2 ? '[v]' : `[x${j}]`
  filters.push(`${label}[${j + 1}:v]xfade=transition=fade:duration=${segments[j].fade}:offset=${segment.start.toFixed(3)}${out}`)
  label = out
})

// The voiceover: each clip at its segment's start, then normalised.
const audioInputs = segments.flatMap(segment => ['-i', segment.voice])
const base = segments.length
segments.forEach((segment, i) => {
  const delay = Math.round((segment.start + segment.lead + VOICE_DELAY) * 1000)
  filters.push(`[${base + i}:a]aresample=48000,adelay=${delay}|${delay}[a${i}]`)
})
filters.push(
  `${segments.map((_, i) => `[a${i}]`).join('')}amix=inputs=${segments.length}:normalize=0,` +
    `apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
)

mkdirSync(dirname(OUT), { recursive: true })
run('ffmpeg', [
  '-v', 'error', '-y', ...inputs, ...audioInputs,
  '-filter_complex', filters.join(';'),
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
  '-movflags', '+faststart', '-t', total.toFixed(3), OUT,
])

// The poster, and the thumbnail with a play button for the README.
const assets = dirname(OUT)
shoot(join(assets, 'video-poster.png'), { s: 'payoff', b: 1, c: '', p: 0 })
shoot(join(assets, 'video-thumbnail.png'), { s: 'payoff', b: 1, c: '', p: 0, play: 1 })

rmSync(tmp, { recursive: true, force: true })
console.log(`${OUT}: ${duration(OUT).toFixed(1)} s`)
