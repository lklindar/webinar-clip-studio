#!/usr/bin/env python3
"""sync-recordings: find the time offset between two recordings of the same event from their audio.

Source: webinar-clip-studio/app/media.py (_envelope, auto_sync).

Result: offset such that  screen_time = speaker_time + offset  (seconds).
Positive offset = the screen recording started earlier.

Examples
  python sync_recordings.py speaker.mp4 screen.mp4
  python sync_recordings.py cam.mp4 zoom.mp4 --window 300 --max-offset 120

Last line on stdout = JSON {"offset", "confidence": high/medium/low, "score"}.
"""
import argparse
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import done  # noqa: E402


def envelope(src, start, seconds, rate=100):
    """Speech-onset envelope at `rate` Hz, streamed from ffmpeg."""
    sr = 8000
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start}", "-t", f"{seconds}", "-i", str(src),
                        "-map", "0:a:0", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], capture_output=True)
    x = np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32)
    hop = sr // rate
    n = len(x) // hop
    if n < rate * 5:
        return np.zeros(0)
    env = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-6)
    env = np.log(env + 1.0)
    onset = np.maximum(0, np.diff(env, prepend=env[0]))
    onset -= onset.mean()
    return onset / (onset.std() + 1e-9)


def auto_sync(speaker, screen, window=900.0, max_offset=900.0):
    rate = 100
    a = envelope(speaker, 0, window, rate)
    b = envelope(screen, 0, window + max_offset, rate)
    if len(a) == 0 or len(b) == 0:
        raise SystemExit("Not enough audio in one of the recordings to synchronise automatically.")
    n = 1
    while n < len(a) + len(b):
        n *= 2
    corr = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    maxlag = min(int(max_offset * rate), n // 2 - 1)
    lags = np.concatenate([np.arange(0, maxlag + 1), np.arange(-maxlag, 0)])
    vals = np.concatenate([corr[: maxlag + 1], corr[n - maxlag:]])
    i = int(np.argmax(vals))
    mask = np.abs(lags - lags[i]) > rate * 2
    second = vals[mask].max() if mask.any() else 0
    ratio = float((vals[i] - second) / (vals.std() + 1e-9))
    conf = "high" if ratio > 4 else "medium" if ratio > 1.5 else "low"
    return {"offset": round(float(lags[i]) / rate, 2), "confidence": conf, "score": round(ratio, 2)}


def main():
    ap = argparse.ArgumentParser(description="Audio offset between two recordings (screen = speaker + offset).")
    ap.add_argument("speaker")
    ap.add_argument("screen")
    ap.add_argument("--window", type=float, default=900, help="seconds of speaker audio compared (default 900)")
    ap.add_argument("--max-offset", type=float, default=900, help="largest offset searched, seconds (default 900)")
    a = ap.parse_args()
    for f in (a.speaker, a.screen):
        if not os.path.isfile(f):
            sys.exit(f"File not found: {f}")
    res = auto_sync(a.speaker, a.screen, a.window, a.max_offset)
    res["meaning"] = "screen_time = speaker_time + offset"
    if res["confidence"] == "low":
        res["advice"] = "Low confidence: check in a player (clap, first word) and set the offset by hand."
    done(res)


if __name__ == "__main__":
    main()
