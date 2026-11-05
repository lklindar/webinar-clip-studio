#!/usr/bin/env python3
"""cut-clip: cut the exact minutes of a clip out of a recording (and its synced screen recording).

Source: webinar-clip-studio/app/server.py (raw_download: "speaker" / "presentation").
Accurate seek + re-encode (H.264 CRF 18 + AAC 192k), so the cut is frame-exact; the length is checked.

Examples
  python cut_clip.py speaker.mp4 --start 12:30 --end 13:15 -o clip-speaker.mp4
  python cut_clip.py speaker.mp4 --start 750 --end 795 --screen screen.mp4 --offset 4.0
  python cut_clip.py screen.mp4 --start 12:34 --end 13:19 --copy      # fast, no re-encode (starts on a keyframe)

Last line on stdout = JSON with the output file(s).
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import done, parse_time, probe  # noqa: E402


def cut(src, start, dur, out, copy=False):
    lead = ["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0, start):.3f}", "-t", f"{dur:.3f}", "-i", src,
            "-map", "0:v:0", "-map", "0:a:0?"]
    if copy:
        cmd = lead + ["-c", "copy", "-avoid_negative_ts", "make_zero"]
    else:
        cmd = lead + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                      "-c:a", "aac", "-b:a", "192k"]
    tmp = out + ".part.mp4"
    r = subprocess.run(cmd + ["-movflags", "+faststart", "-t", f"{dur:.3f}", tmp], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("ffmpeg failed: " + r.stderr[-600:])
    got = probe(tmp)["duration"]
    if not copy and abs(got - dur) > 0.3:
        os.unlink(tmp)
        raise SystemExit(f"The cut came out {got:.1f} s instead of {dur:.1f} s.")
    os.replace(tmp, out)
    return {"file": out, "duration": round(got, 2), "size": os.path.getsize(out)}


def main():
    ap = argparse.ArgumentParser(description="Cut an exact time range out of a recording.")
    ap.add_argument("source", help="speaker (or any) recording")
    ap.add_argument("--start", required=True, help="seconds or mm:ss / h:mm:ss")
    ap.add_argument("--end", required=True)
    ap.add_argument("-o", "--out", help="output MP4 (default <source>-<start>.mp4)")
    ap.add_argument("--screen", help="synced screen recording: cut the same moment from it too")
    ap.add_argument("--offset", type=float, default=0.0, help="screen_time = speaker_time + offset")
    ap.add_argument("--copy", action="store_true", help="no re-encode: fast, original quality, starts on a keyframe")
    a = ap.parse_args()
    for f in (a.source, a.screen):
        if f and not os.path.isfile(f):
            sys.exit(f"File not found: {f}")
    start, end = parse_time(a.start), parse_time(a.end)
    if end <= start:
        sys.exit("--end must be after --start.")
    stamp = f"{int(start // 60)}m{int(start % 60):02d}s"
    out = a.out or f"{os.path.splitext(a.source)[0]}-{stamp}.mp4"
    res = {"start": start, "end": end, "speaker": cut(a.source, start, end - start, out, a.copy)}
    if a.screen:
        sout = os.path.splitext(out)[0] + "-screen.mp4"
        res["screen"] = cut(a.screen, start + a.offset, end - start, sout, a.copy)
        res["offset"] = a.offset
    done(res)


if __name__ == "__main__":
    main()
