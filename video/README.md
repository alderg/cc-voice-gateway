# The video

`docs/assets/cc-voice-gateway.mp4` shows in about two minutes what the project is for, along the
five messages of the product page ([storyboard](storyboard.md)). It is built from four files:

- `script.json`: the voiceover, one entry per line, grouped in scenes. `say` is what is spoken
  (spelled for the voice, for example "C C voice gateway"), `caption` the text shown if it differs.
  `hold` keeps a scene a little longer after its last line; scenes with `"captions": false` show
  none.
- `slides.html`: the scenes at 1920 x 1080, animated. Elements appear when a line of their scene
  starts (`data-in`, `data-d`, `data-fx`); the waveforms follow the voiceover's loudness. Opened on
  its own, it plays with a guessed timeline: `slides.html#play`, or `#t=30` for second 30.
- `tts.py`: speaks each line with [Kokoro][kokoro], voice `af_heart`. It tries a few takes per
  line and keeps the one whose pitch falls at the end of a statement, so that no statement sounds
  like a question; lines that still rise are marked `RISE` in its output, and are best reworded.
- `build.mjs`: the voiceover from `tts.py` (kept in the system's temporary folder, so that a change
  to the frames needs no new voice), then every frame at 30 frames per second with headless Chrome
  over the DevTools protocol, encoded with ffmpeg, the voice mixed at -16 LUFS. It also writes
  `docs/assets/video-poster.jpg` and `docs/assets/video-thumbnail.jpg`. A full build takes about
  six minutes.

Kokoro, once, in `~/.cache/kokoro`:

```bash
python3 -m venv ~/.cache/kokoro/venv
~/.cache/kokoro/venv/bin/pip install kokoro-onnx soundfile
curl -L -o ~/.cache/kokoro/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o ~/.cache/kokoro/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Then, with Google Chrome, ffmpeg and Node.js 22 or later (for its built-in WebSocket) installed:

```bash
node video/build.mjs
```

`STILLS=<folder> node video/build.mjs` writes one frame per line into that folder instead, to look
at the layout in a few seconds. `KOKORO_DIR` and `KOKORO_PYTHON` point elsewhere; `VOICE` picks
another Kokoro voice. `TTS=say node video/build.mjs out.mp4` makes a quick draft with a macOS voice
instead.

[kokoro]: https://github.com/thewh1teagle/kokoro-onnx
