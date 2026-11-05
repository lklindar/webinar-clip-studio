#!/usr/bin/env python3
"""transcribe: word-timed transcript of a video/audio file, locally with faster-whisper.

Source: webinar-clip-studio/app/workers/transcribe.py + app/segments.py (only the clip minutes).

Examples
  python transcribe.py webinar.mp4 -o webinar.words.json
  python transcribe.py webinar.mp4 --ranges "12:30-13:15, 41:00-41:40" --language id -o clips.words.json
  python transcribe.py talk.mp4 --verbatim      # keep "um"/"uh" (prompt from Polish)

Last line on stdout = JSON summary. Word times are always on the source file's own timeline.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import clean, done, parse_ranges, probe, transcribe  # noqa: E402


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def main():
    ap = argparse.ArgumentParser(description="Word-timed transcript (faster-whisper, local).")
    ap.add_argument("media", help="video or audio file")
    ap.add_argument("-o", "--out", help="output JSON (default <media>.words.json)")
    ap.add_argument("--ranges", help='only these parts, e.g. "12:30-13:15, 41:00-41:40" (much faster than the whole file)')
    ap.add_argument("--language", help="en, id, … (default: detect)")
    ap.add_argument("--model", default="small", help="tiny / base / small (default) / medium")
    ap.add_argument("--verbatim", action="store_true", help='keep filler words ("um", "uh", "eh") instead of cleaning them up')
    a = ap.parse_args()
    if not os.path.isfile(a.media):
        sys.exit(f"File not found: {a.media}")
    info = probe(a.media)
    if not info["hasAudio"]:
        sys.exit("This file has no audio track.")
    ranges = parse_ranges(a.ranges) if a.ranges else None
    t0 = time.time()
    words, lang = transcribe(a.media, a.model, a.language, log, ranges, a.verbatim)
    out = a.out or os.path.splitext(a.media)[0] + ".words.json"
    with open(out, "w") as f:
        json.dump({"language": lang, "model": a.model, "verbatim": a.verbatim, "duration": info["duration"], "ranges": ranges,
                   "words": clean(words)}, f, ensure_ascii=False)
    seconds = sum(b - x for x, b in ranges) if ranges else info["duration"]
    done({"output": out, "words": len(words), "language": lang, "audio_seconds": round(seconds, 1),
          "took_seconds": round(time.time() - t0, 1)})


if __name__ == "__main__":
    main()
