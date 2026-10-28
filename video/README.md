# The product video

`docs/assets/cc-voice-gateway.mp4`, about 90 seconds, is built from three files:

- `script.json`: the voiceover, one entry per line, grouped in scenes. `say` is what is spoken
  (spelled for the voice, for example "C C voice gateway"), `caption` the text shown if it differs,
  `build` how far the scene's frame is built up. Scenes with `"captions": false` show none.
- `slides.html`: the frames at 1920 x 1080. Open it in a browser with
  `#s=dialog&b=3&c=Some%20caption` to see one.
- `build.mjs`: speaks each line with macOS `say`, takes one screenshot per line with headless
  Chrome, adds a slow zoom per scene and cross-fades, and mixes the voice at -16 LUFS.

Rebuild on a Mac with Google Chrome and ffmpeg:

```bash
node video/build.mjs
```

It also writes `docs/assets/video-poster.png` and `docs/assets/video-thumbnail.png`.

The voice is `Daniel`, a compact macOS voice. A better one is free to add in System Settings >
Accessibility > Spoken Content > System Voice > Manage Voices, for example an English "Premium"
voice. Then:

```bash
VOICE="Zoe (Premium)" node video/build.mjs
```

`say -v '?'` lists the voices installed. `RATE` sets the words per minute; some compact voices
ignore it.
