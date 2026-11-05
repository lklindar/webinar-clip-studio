#!/usr/bin/env python3
"""analyze-screen: what happens in a screen/slide recording: slide changes, static stretches, zoom targets.

Source: webinar-clip-studio/app/media.py (detect_slide_changes, activity, content_regions)
        + static/js/views/suggest.js (staticStretches).

Examples
  python analyze_screen.py screen.mp4                               # slide changes over the whole file
  python analyze_screen.py screen.mp4 --start 12:30 --end 13:15     # one clip: changes, static parts, zoom targets
  python analyze_screen.py screen.mp4 --start 750 --end 795 --offset 4.0   # clip times given on the speaker clock

Times in the output are relative to --start (or to the file when no --start).
Last line on stdout = JSON.
"""
import argparse
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from screen import scene_scores, slide_changes  # noqa: E402
from words import done, fmt_time, parse_time, probe  # noqa: E402

STATIC_SCORE = 0.006   # scene score below this = picture basically unchanged


def static_stretches(samples, dur, min_static=8.0):
    changes = [0.0] + [t for t, s in samples if s > STATIC_SCORE] + [dur]
    return [[round(a, 2), round(b, 2)] for a, b in zip(changes, changes[1:]) if b - a >= min_static]


def frame_gray(src, t, width=640):
    seek = ["-ss", f"{t}"] if t > 0 else []
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *seek, "-i", str(src), "-frames:v", "1",
                          "-vf", f"scale={width}:-2", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True).stdout
    h = len(raw) // width
    return np.frombuffer(raw[: width * h], np.uint8).reshape(h, width) if h else None


def content_regions(src, t, count=3):
    """Where is the content on a slide? Edge density in vertical bands → zoom targets (x, y 0..1)."""
    import cv2
    img = frame_gray(src, t)
    if img is None:
        return []
    h, w = img.shape
    edges = cv2.Canny(img, 60, 160).astype(np.float32) / 255.0
    edges[: int(h * 0.06)] = 0
    col = edges.sum(axis=0)
    total = edges.sum() + 1e-6
    if total < h * w * 0.002:   # (almost) empty slide: nothing to zoom into
        return []
    win = int(w * 0.45)
    cands = sorted(((col[x0:x0 + win].sum() / total, x0) for x0 in range(0, w - win + 1, max(1, w // 40))),
                   reverse=True)
    picked = []
    for dens, x0 in cands:
        cx = (x0 + win / 2) / w
        if all(abs(cx - p["x"]) > 0.22 for p in picked):
            rows = edges[:, x0:x0 + win].sum(axis=1)
            cy = float((rows * np.arange(h)).sum() / (rows.sum() + 1e-6)) / h
            label = "left part" if cx < 0.38 else "right part" if cx > 0.62 else "middle"
            picked.append({"x": round(cx, 3), "y": round(min(0.8, max(0.2, cy)), 3), "zoom": 1.9,
                           "density": round(float(dens), 3), "label": label})
        if len(picked) >= count:
            break
    return picked


def main():
    ap = argparse.ArgumentParser(description="Slide changes, static stretches and zoom targets of a screen recording.")
    ap.add_argument("screen")
    ap.add_argument("--start", help="part to analyse: start (seconds or mm:ss)")
    ap.add_argument("--end", help="part to analyse: end")
    ap.add_argument("--offset", type=float, default=0.0, help="add to --start/--end (speaker clock → screen clock)")
    ap.add_argument("--min-static", type=float, default=8.0, help="shortest static stretch reported (s, default 8)")
    ap.add_argument("--regions", type=int, default=3, help="zoom targets per slide (0 = skip, default 3)")
    a = ap.parse_args()
    if not os.path.isfile(a.screen):
        sys.exit(f"File not found: {a.screen}")
    info = probe(a.screen)
    s0 = (parse_time(a.start) if a.start else 0.0) + a.offset
    s1 = (parse_time(a.end) + a.offset) if a.end else info["duration"]
    dur = max(0.0, min(s1, info["duration"]) - s0)
    print(f"Analysing {fmt_time(dur)} of {os.path.basename(a.screen)}…", file=sys.stderr)
    samples = scene_scores(a.screen, s0, dur if a.start or a.end else None)
    changes = slide_changes(samples)
    stat = static_stretches(samples, dur, a.min_static)
    res = {"screen": a.screen, "from": round(s0, 2), "duration": round(dur, 2),
           "slide_changes": changes, "slides": len(changes) + 1,
           "static_stretches": stat, "static_seconds": round(sum(b - x for x, b in stat), 1)}
    if a.regions and (a.start or a.end):
        # zoom targets for each slide shown in the part (sampled in the middle of each slide)
        bounds = [0.0] + changes + [dur]
        res["zoom_targets"] = [{"slide_from": round(x, 2), "slide_to": round(y, 2),
                                "regions": content_regions(a.screen, s0 + (x + y) / 2, a.regions)}
                               for x, y in zip(bounds, bounds[1:]) if y - x >= 2]
    done(res)


if __name__ == "__main__":
    main()
