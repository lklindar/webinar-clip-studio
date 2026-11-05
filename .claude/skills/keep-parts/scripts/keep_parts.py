#!/usr/bin/env python3
"""keep-parts: save only the minutes you need from a huge recording, without re-encoding.

Source: webinar-clip-studio/app/keep.py ("Keep only my clip parts").

Each range gets `--pad` seconds extra on both sides; overlapping ranges are merged. Pieces are stream
copies (original quality) and must start on a keyframe, so every piece starts at the last keyframe
before the wanted time. The exact start of each piece on the ORIGINAL timeline is measured and written
to the manifest, so  original_time = piece_start + time_inside_piece.

Examples
  python keep_parts.py webinar-speaker.mp4 --ranges "12:30-13:15, 41:00-41:40" --outdir kept/
  python keep_parts.py webinar-screen.mp4 --ranges "12:30-13:15" --offset 4.0 --pad 15 --outdir kept/

The original is never deleted. Last line on stdout = JSON manifest (also saved as <outdir>/<name>.kept.json).
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import done, fmt_time, parse_ranges, probe  # noqa: E402


def merge(ranges):
    out = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def keyframe_before(path, t):
    """Time of the last video keyframe at or before t."""
    if t <= 0.05:
        return 0.0
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
                        "-show_entries", "frame=pts_time,best_effort_timestamp_time", "-of", "json",
                        "-read_intervals", f"{max(0, t - 60):.3f}%{t + 0.5:.3f}", path], capture_output=True, text=True)
    best = 0.0
    for fr in json.loads(r.stdout or "{}").get("frames", []):
        ts = fr.get("pts_time") or fr.get("best_effort_timestamp_time")
        if ts is not None and float(ts) <= t + 1e-3:
            best = max(best, float(ts))
    return best


def main():
    ap = argparse.ArgumentParser(description="Lossless copies of just the needed minutes of a recording.")
    ap.add_argument("source")
    ap.add_argument("--ranges", required=True, help='e.g. "12:30-13:15, 41:00-41:40" (clip times)')
    ap.add_argument("--offset", type=float, default=0.0, help="added to the ranges (speaker clock → this file's clock)")
    ap.add_argument("--pad", type=float, default=15.0, help="extra seconds before and after (default 15)")
    ap.add_argument("--outdir", help="folder for the pieces (default <source folder>/kept)")
    a = ap.parse_args()
    if not os.path.isfile(a.source):
        sys.exit(f"File not found: {a.source}")
    info = probe(a.source)
    vcodec = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
                             "-of", "csv=p=0", a.source], capture_output=True, text=True).stdout.strip()
    wanted = merge([[max(0.0, x + a.offset - a.pad), min(info["duration"], y + a.offset + a.pad)]
                    for x, y in parse_ranges(a.ranges)])
    outdir = a.outdir or os.path.join(os.path.dirname(os.path.abspath(a.source)), "kept")
    os.makedirs(outdir, exist_ok=True)
    name = os.path.splitext(os.path.basename(a.source))[0]
    pieces = []
    for i, (x, y) in enumerate(wanted, 1):
        k = keyframe_before(a.source, x)
        out = os.path.join(outdir, f"{name}-{i:03d}.mp4")
        print(f"Copying {fmt_time(x)}–{fmt_time(y)}…", file=sys.stderr, flush=True)
        cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{k:.3f}", "-i", a.source, "-t", f"{y - k:.3f}",
               "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-avoid_negative_ts", "make_zero",
               "-movflags", "+faststart"] + (["-tag:v", "hvc1"] if vcodec == "hevc" else []) + [out + ".part.mp4"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit("ffmpeg failed: " + r.stderr[-600:])
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_entries",
                            "format=duration:stream=codec_type,start_time", out + ".part.mp4"], capture_output=True, text=True)
        pinfo = json.loads(r.stdout or "{}")
        dur = float(pinfo.get("format", {}).get("duration") or 0)
        vst = next((float(s.get("start_time") or 0) for s in pinfo.get("streams", []) if s.get("codec_type") == "video"), 0.0)
        origin = k - vst  # original time = piece time + origin
        if dur <= 0 or dur < (y - k) - 1.0:
            os.unlink(out + ".part.mp4")
            sys.exit(f"The piece at {fmt_time(x)} came out too short; the original may be damaged there.")
        os.replace(out + ".part.mp4", out)
        pieces.append({"file": out, "start": round(origin, 4), "end": round(origin + dur, 4), "size": os.path.getsize(out)})
    manifest = {"source": os.path.abspath(a.source), "pad": a.pad, "offset": a.offset, "pieces": pieces,
                "bytes": sum(p["size"] for p in pieces), "original_bytes": os.path.getsize(a.source),
                "rule": "original_time = piece.start + time_inside_piece"}
    with open(os.path.join(outdir, f"{name}.kept.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    manifest["manifest"] = os.path.join(outdir, f"{name}.kept.json")
    done(manifest)


if __name__ == "__main__":
    main()
