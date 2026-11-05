#!/usr/bin/env python3
"""make-subtitles: turn a word-timed transcript into short subtitle lines (.srt and/or JSON).

Source: webinar-clip-studio/static/js/captions.js (groupWords, toSRT), ported to Python.

Examples
  python make_subtitles.py --words clip.words.json -o clip.srt
  python make_subtitles.py --words webinar.words.json --start 12:30 --end 13:15 --max-words 3 -o clip.srt
  python make_subtitles.py --words talk.words.json --json captions.json --upper

With --start/--end the subtitles start at 0:00 (for a clip cut from that point).
Last line on stdout = JSON summary.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import done, load_words, parse_time  # noqa: E402


def group_words(words, max_words=4):
    """Short caption chunks: break at max_words, sentence ends, pauses > 0.7 s, or commas after half."""
    caps, cur = [], []

    def flush():
        if cur:
            caps.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                         "text": " ".join(w["text"] for w in cur), "words": [dict(w) for w in cur]})
            cur.clear()

    for i, w in enumerate(words):
        prev = words[i - 1] if i else None
        if cur and prev:
            gap = w["start"] - prev["end"]
            ends = re.search(r"[.!?]$", prev["text"])
            comma = re.search(r"[,;:]$", prev["text"])
            if len(cur) >= max_words or ends or gap > 0.7 or (comma and len(cur) >= -(-max_words // 2)):
                flush()
        cur.append(w)
    flush()
    for a, b in zip(caps, caps[1:]):          # close small gaps so captions don't flicker
        if 0 < b["start"] - a["end"] < 0.4:
            a["end"] = b["start"]
    for c in caps:
        if c["end"] - c["start"] < 0.3:
            c["end"] = c["start"] + 0.3
    return caps


def srt_time(t):
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(caps):
    return "\n".join(f"{i}\n{srt_time(c['start'])} --> {srt_time(c['end'])}\n{c['text']}\n"
                     for i, c in enumerate(caps, 1))


def main():
    ap = argparse.ArgumentParser(description="Word-timed transcript → subtitles (.srt / JSON).")
    ap.add_argument("--words", required=True, help="word-timed transcript JSON")
    ap.add_argument("-o", "--out", help="output .srt (default <words>.srt)")
    ap.add_argument("--json", help="also write the caption chunks (with word timings) as JSON")
    ap.add_argument("--start", help="clip start (seconds or mm:ss); times become relative to it")
    ap.add_argument("--end", help="clip end")
    ap.add_argument("--max-words", type=int, default=4, help="words per subtitle (default 4)")
    ap.add_argument("--upper", action="store_true", help="UPPERCASE text")
    ap.add_argument("--strip-punct", action="store_true", help="remove trailing , . from each subtitle")
    a = ap.parse_args()
    if not os.path.isfile(a.words):
        sys.exit(f"File not found: {a.words}")
    words = load_words(a.words)
    s0 = parse_time(a.start) if a.start else 0.0
    s1 = parse_time(a.end) if a.end else float("inf")
    ws = [{"text": w["text"], "start": round(max(0.0, w["start"] - s0), 3), "end": round(min(s1, w["end"]) - s0, 3)}
          for w in words if w["end"] > s0 + 0.02 and w["start"] < s1 - 0.02]
    if not ws:
        sys.exit("No words in that time range.")
    caps = group_words(ws, max(1, a.max_words))
    for c in caps:
        if a.strip_punct:
            c["text"] = re.sub(r"[,.;:]+$", "", c["text"])
        if a.upper:
            c["text"] = c["text"].upper()
    out = a.out or os.path.splitext(a.words)[0].removesuffix(".words") + ".srt"
    with open(out, "w", encoding="utf-8") as f:
        f.write(to_srt(caps))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(caps, f, ensure_ascii=False)
    done({"srt": out, "json": a.json, "subtitles": len(caps), "duration": round(caps[-1]["end"], 2)})


if __name__ == "__main__":
    main()
