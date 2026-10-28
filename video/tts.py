#!/usr/bin/env python3
# The voiceover's lines spoken by Kokoro (voice af_heart by default), one WAV per line.
# Reads {"voice": ..., "lines": [{"id": ..., "say": ...}]} on stdin, writes <out>/<id>.wav
# and prints one JSON object per line: id, file, seconds, speed, rise.
#
# Intonation: each line is spoken in a few takes (whole or sentence by sentence, slightly
# different speeds), and the take wins whose pitch ends where it should: a statement
# falls at its end, a question rises. A rise of more than about 1.5 semitones at the end
# of a statement sounds like a question; such lines are flagged with "RISE" on stderr.
#
# Needs: pip install kokoro-onnx soundfile, and kokoro-v1.0.onnx and voices-v1.0.bin from
# github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0) in KOKORO_DIR
# (default ~/.cache/kokoro).
import json, os, re, shutil, sys
import numpy as np
import soundfile as sf
import espeakng_loader
from kokoro_onnx import Kokoro, EspeakConfig

MODELS = os.path.expanduser(os.environ.get('KOKORO_DIR', '~/.cache/kokoro'))
SR = 24000


def f0_track(x, sr, fmin=110, fmax=420, hop=0.01, win=0.04, thr=0.15):
    """Pitch per 10 ms frame with a simple YIN; NaN where unvoiced."""
    n, h = int(win * sr), int(hop * sr)
    tmin, tmax = int(sr / fmax), int(sr / fmin)
    out = []
    for i in range(0, len(x) - n - tmax, h):
        seg = x[i:i + n + tmax].astype(np.float64)
        if np.sqrt((seg[:n] ** 2).mean()) < 0.01:
            out.append(np.nan)
            continue
        d = np.array([((seg[:n] - seg[t:t + n]) ** 2).sum() for t in range(tmax + 1)])
        cmnd = np.ones_like(d)
        cmnd[1:] = d[1:] * np.arange(1, tmax + 1) / (np.cumsum(d[1:]) + 1e-12)
        cand = np.where(cmnd[tmin:] < thr)[0]
        if len(cand) == 0:
            out.append(np.nan)
            continue
        t = cand[0] + tmin
        while t + 1 <= tmax and cmnd[t + 1] < cmnd[t]:
            t += 1
        out.append(sr / t)
    return np.array(out)


def ending(x, sr):
    """(rise of the last voiced ~350 ms over the line's median, in semitones; jumpiness)."""
    x, sr = x[::2], sr // 2  # 12 kHz is enough for pitch
    f = f0_track(x, sr)
    v = f[~np.isnan(f)]
    if len(v) < 10:
        return 0.0, 0.0
    med = np.median(v)
    idx = np.where(~np.isnan(f))[0]
    last = f[idx[-1] - 35:idx[-1] + 1]
    last = last[~np.isnan(last)]
    end = np.median(last[-12:]) if len(last) else med
    jumps = np.abs(np.diff(12 * np.log2(v)))
    return float(12 * np.log2(end / med)), float(np.mean(jumps > 4))


def trim(x, thr=0.012):
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    return x[max(0, idx[0] - int(0.02 * SR)):min(len(x), idx[-1] + int(0.08 * SR))]


def sentences(text):
    return [s for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s]


def espeak_config():
    # espeak cuts data paths at about 230 characters; a long one goes to a short copy
    data = espeakng_loader.get_data_path()
    if len(data) > 200:
        short = os.path.join(MODELS, 'espeak-ng-data')
        if not os.path.isdir(short):
            shutil.copytree(data, short)
        data = short
    return EspeakConfig(lib_path=espeakng_loader.get_library_path(), data_path=data)


def speak(k, voice, parts, speed):
    out = []
    for j, part in enumerate(parts):
        x, _ = k.create(part, voice=voice, speed=speed, lang='en-us')
        if j:
            out.append(np.zeros(int(0.18 * SR), np.float32))
        out.append(trim(np.asarray(x, np.float32)))
    return np.concatenate(out)


def score(x, text, speed):
    """Lower is better: the right ending, few pitch jumps, a speed close to 1."""
    rise, jumps = ending(x, SR)
    tone = -rise if text.rstrip().endswith('?') else max(rise, -2.5)
    return tone + 4 * jumps + 6 * abs(speed - 1), rise


def main():
    out_dir = sys.argv[1]
    job = json.load(sys.stdin)
    voice = job.get('voice', 'af_heart')
    os.makedirs(out_dir, exist_ok=True)
    k = Kokoro(os.path.join(MODELS, 'kokoro-v1.0.onnx'), os.path.join(MODELS, 'voices-v1.0.bin'),
               espeak_config=espeak_config())
    for line in job['lines']:
        text = line['say']
        takes = [[text]] + ([sentences(text)] if len(sentences(text)) > 1 else [])
        best = None
        for parts in takes:
            for speed in (0.94, 0.97, 1.0):
                x = speak(k, voice, parts, speed)
                sc, rise = score(x, text, speed)
                if best is None or sc < best[0]:
                    best = (sc, x, speed, rise)
        _, x, speed, rise = best
        path = os.path.join(out_dir, '%s.wav' % line['id'])
        sf.write(path, x, SR)
        flag = '  RISE' if rise > 1.5 and not text.rstrip().endswith('?') else ''
        print('%s speed %.2f rise %+.1f%s  %s' % (line['id'], speed, rise, flag, text), file=sys.stderr, flush=True)
        print(json.dumps({'id': line['id'], 'file': path, 'seconds': round(len(x) / SR, 3),
                          'speed': speed, 'rise': round(rise, 2)}), flush=True)


if __name__ == '__main__':
    main()
