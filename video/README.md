# The video

`docs/assets/cc-voice-gateway.mp4` explains in about 75 seconds what the project is and how it
works. It is built from four files:

- `script.json`: the voiceover, one entry per line, grouped in scenes. `say` is what is spoken
  (spelled for the voice, for example "C C voice gateway"), `caption` the text shown if it differs,
  `build` how far the scene's frame is built up. Scenes with `"captions": false` show none.
- `slides.html`: the frames at 1920 x 1080. Open it in a browser with
  `#s=dialog&b=3&c=Some%20caption` to see one.
- `tts.py`: speaks each line with [Kokoro][kokoro], voice `af_heart`. It tries a few takes per
  line and keeps the one whose pitch falls at the end of a statement, so that no statement sounds
  like a question; lines that still rise are marked `RISE` in its output.
- `build.mjs`: the voiceover from `tts.py`, one screenshot per line with headless Chrome, a slow
  zoom per scene and cross-fades, the voice mixed at -16 LUFS. It also writes
  `docs/assets/video-poster.png` and `docs/assets/video-thumbnail.png`.

Kokoro, once, in `~/.cache/kokoro`:

```bash
python3 -m venv ~/.cache/kokoro/venv
~/.cache/kokoro/venv/bin/pip install kokoro-onnx soundfile
curl -L -o ~/.cache/kokoro/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o ~/.cache/kokoro/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Then, with Google Chrome and ffmpeg installed:

```bash
node video/build.mjs
```

`KOKORO_DIR` and `KOKORO_PYTHON` point elsewhere; `VOICE` picks another Kokoro voice.
`TTS=say node video/build.mjs out.mp4` makes a quick draft with a macOS voice instead.

[kokoro]: https://github.com/thewh1teagle/kokoro-onnx
