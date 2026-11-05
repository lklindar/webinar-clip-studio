"""Shared helpers for screen/slide recordings: picture-change scores and slide changes.

From webinar-clip-studio/app/media.py (detect_slide_changes, activity).
"""
import re
import subprocess


def scene_scores(src, start=0.0, duration=None):
    """[[time, score], ...] twice per second (time relative to start). Streams from ffmpeg."""
    seek = ["-ss", f"{start:.3f}"] if start > 0 else []
    dur = ["-t", f"{duration:.3f}"] if duration else []
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", *seek, *dur, "-i", str(src), "-an",
           "-vf", "fps=2,scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    out, t = [], None
    for line in proc.stderr:
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"lavfi.scene_score=([\d.]+)", line)
        if m and t is not None:
            out.append([round(t, 2), round(float(m.group(1)), 5)])
            t = None
    proc.wait()
    return out


def slide_changes(samples, threshold=0.02, merge=1.5):
    """Big picture changes (new slide), merged when closer than `merge` seconds (animations / builds)."""
    merged = []
    for t, s in samples:
        if s > threshold and (not merged or t - merged[-1] > merge):
            merged.append(t)
    return merged
