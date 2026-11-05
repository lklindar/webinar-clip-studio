#!/usr/bin/env python3
"""verify-export: check a finished video instead of trusting ffmpeg's exit code.

Source: webinar-clip-studio/app/workers/render.py (verify).

Checks: video + audio present, size (default 1080×1920), H.264 yuv420p, duration (if given),
decoding the whole file without errors, audio loudness (silent or clipping-loud audio is flagged).

Examples
  python verify_export.py export.mp4
  python verify_export.py export.mp4 --duration 34.5
  python verify_export.py exports/*.mp4 --width 1920 --height 1080

Exit code 1 if any file has problems. Last line on stdout = JSON (one result per file).
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import done  # noqa: E402


def verify(out, W, H, duration=None):
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", out],
                       capture_output=True, text=True)
    info = json.loads(r.stdout or "{}")
    v = next((s for s in info.get("streams", []) if s["codec_type"] == "video"), None)
    a = next((s for s in info.get("streams", []) if s["codec_type"] == "audio"), None)
    dur = float(info.get("format", {}).get("duration", 0))
    dec = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", out, "-f", "null", "-"], capture_output=True, text=True)
    vol = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", out, "-vn", "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    mean_db = max_db = None
    for line in vol.splitlines():
        if "mean_volume" in line:
            mean_db = float(line.split(":")[1].strip().split()[0])
        if "max_volume" in line:
            max_db = float(line.split(":")[1].strip().split()[0])
    problems, warnings = [], []
    if not v:
        problems.append("no video stream")
    else:
        if W and H and (int(v["width"]), int(v["height"])) != (W, H):
            problems.append(f"unexpected size {v['width']}x{v['height']} (expected {W}x{H})")
        if v.get("codec_name") != "h264" or v.get("pix_fmt") != "yuv420p":
            problems.append(f"video is {v.get('codec_name')} {v.get('pix_fmt')}, not H.264 yuv420p (may not play everywhere)")
    if not a:
        problems.append("no audio stream")
    elif mean_db is not None and mean_db < -50:
        problems.append(f"audio is almost silent (mean {mean_db} dB)")
    if max_db is not None and max_db >= 0:
        warnings.append("audio peaks reach 0 dB (may be clipping)")
    if duration and abs(dur - duration) > 0.25:
        problems.append(f"duration {dur:.2f}s differs from expected {duration:.2f}s")
    if dec.stderr.strip():
        problems.append("decoder reported errors: " + dec.stderr.strip()[:200])
    return {"file": out, "ok": not problems, "problems": problems, "warnings": warnings,
            "width": v and int(v["width"]), "height": v and int(v["height"]), "duration": round(dur, 3),
            "video_codec": v and v.get("codec_name"), "audio_codec": a and a.get("codec_name"),
            "mean_volume_db": mean_db, "max_volume_db": max_db,
            "size_bytes": os.path.getsize(out) if os.path.exists(out) else 0}


def main():
    ap = argparse.ArgumentParser(description="Check exported videos (size, codecs, duration, decode errors, audio).")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--width", type=int, default=1080)
    ap.add_argument("--height", type=int, default=1920)
    ap.add_argument("--any-size", action="store_true", help="do not check width/height")
    ap.add_argument("--duration", type=float, help="expected duration in seconds")
    a = ap.parse_args()
    results = []
    for f in a.files:
        if not os.path.isfile(f):
            results.append({"file": f, "ok": False, "problems": ["file not found"]})
            continue
        print(f"Checking {os.path.basename(f)}…", file=sys.stderr, flush=True)
        results.append(verify(f, None if a.any_size else a.width, None if a.any_size else a.height, a.duration))
    done({"ok": all(r["ok"] for r in results), "results": results})
    sys.exit(0 if all(r["ok"] for r in results) else 1)


if __name__ == "__main__":
    main()
