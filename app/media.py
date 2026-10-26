"""FFmpeg-based media helpers: probing, proxies, audio extraction, slide detection, auto-sync.

Nothing here loads a whole video into memory; ffmpeg streams from disk.
"""
import hashlib
import json
import re
import subprocess
from pathlib import Path

import numpy as np

from .config import CACHE
from .jobs import UserError

PROXY_HEIGHT = 540


def probe(path: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise UserError("This file could not be read as a video. It may be damaged, incomplete, or not a video. "
                        f"(ffprobe: {r.stderr.strip()[-300:]})")
    info = json.loads(r.stdout)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v:
        raise UserError("This file has no video track.")
    a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = abs(int(sd["rotation"]))
    if rot in (90, 270):
        w, h = h, w
    fps = 30.0
    try:
        n, d = v.get("avg_frame_rate", "30/1").split("/")
        fps = float(n) / float(d) if float(d) else 30.0
    except (ValueError, ZeroDivisionError):
        pass
    duration = float(info.get("format", {}).get("duration") or v.get("duration") or 0)
    return {
        "width": w, "height": h, "fps": round(fps, 3), "duration": duration,
        "vcodec": v.get("codec_name"), "acodec": a.get("codec_name") if a else None,
        "has_audio": a is not None, "bitrate": int(info.get("format", {}).get("bit_rate") or 0),
    }


def fingerprint(path: Path) -> str:
    """Fast content fingerprint (size + first/last 4 MB) so caches survive renames/moves."""
    st = path.stat()
    h = hashlib.sha1(str(st.st_size).encode())
    with path.open("rb") as f:
        h.update(f.read(4 << 20))
        if st.st_size > 8 << 20:
            f.seek(-(4 << 20), 2)
            h.update(f.read(4 << 20))
    return h.hexdigest()[:16]


def proxy_path(fp: str) -> Path:
    return CACHE / "proxies" / f"{fp}.mp4"


def make_proxy(job, src: Path, fp: str, duration: float, p0=0.0, p1=1.0) -> Path:
    """Small H.264 copy for smooth in-browser preview (keyframe every second for fast seeking)."""
    out = proxy_path(fp)
    if out.exists() and out.stat().st_size > 0:
        return out
    tmp = out.with_suffix(".tmp.mp4")
    base = ["ffmpeg", "-y", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", f"scale=-2:{PROXY_HEIGHT}:flags=bilinear,fps=30", "-g", "30",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart"]
    try:  # Apple hardware encoder: fast and light on the CPU
        job.run_ffmpeg(base + ["-c:v", "h264_videotoolbox", "-b:v", "1200k", "-pix_fmt", "yuv420p", str(tmp)],
                       duration, p0, p1, "Creating preview copy (hardware)…")
    except RuntimeError:
        job.run_ffmpeg(base + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
                               str(tmp)], duration, p0, p1, "Creating preview copy…")
    tmp.replace(out)
    return out


def audio_pcm_path(fp: str) -> Path:
    return CACHE / "audio" / f"{fp}.f32"


def extract_audio(job, src: Path, fp: str, duration: float, p0=0.0, p1=1.0) -> Path:
    """16 kHz mono float32 raw PCM, cached. ~230 MB per hour of audio."""
    out = audio_pcm_path(fp)
    if out.exists() and out.stat().st_size > 0:
        return out
    tmp = out.with_suffix(".tmp")
    job.run_ffmpeg(["ffmpeg", "-y", "-i", str(src), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
                    "-f", "f32le", str(tmp)], duration, p0, p1, "Extracting audio…")
    tmp.replace(out)
    return out


def detect_slide_changes(job, proxy: Path, fp: str, duration: float, p0=0.0, p1=1.0) -> list[float]:
    """Times (in that recording's own clock) where the picture changes a lot, e.g. a new slide."""
    cache = CACHE / "scenes" / f"{fp}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    job.set(p0, "Detecting slide changes…")
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-i", str(proxy), "-an",
           "-vf", "fps=2,scale=320:-2,select='gt(scene,0.02)',showinfo", "-f", "null", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    job._proc = proc
    times = []
    for line in proc.stderr:
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
            times.append(round(t, 2))
            if duration:
                job.progress = p0 + (p1 - p0) * min(1.0, t / duration)
    proc.wait()
    job._proc = None
    # merge changes closer than 1.5 s (animations / builds)
    merged = []
    for t in times:
        if not merged or t - merged[-1] > 1.5:
            merged.append(t)
    cache.write_text(json.dumps(merged))
    return merged


def _envelope(src: Path, start: float, seconds: float, rate=100) -> np.ndarray:
    """Loudness envelope at `rate` Hz, read straight from ffmpeg (no full decode in RAM)."""
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
    onset = np.maximum(0, np.diff(env, prepend=env[0]))  # emphasise speech onsets
    onset -= onset.mean()
    return onset / (onset.std() + 1e-9)


def auto_sync(speaker: Path, presentation: Path, window=900.0, max_offset=900.0) -> dict:
    """Find offset (seconds) such that presentation_time = speaker_time + offset, via audio cross-correlation."""
    rate = 100
    a = _envelope(speaker, 0, window, rate)
    b = _envelope(presentation, 0, window + max_offset, rate)
    if len(a) == 0 or len(b) == 0:
        raise UserError("Not enough audio in one of the recordings to synchronise automatically. "
                        "Please set the offset manually using the preview.")
    n = 1
    while n < len(a) + len(b):
        n *= 2
    corr = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    # lag L: b[t + L] ~ a[t]  -> positive lags at the start, negative wrap at the end
    maxlag = min(int(max_offset * rate), n // 2 - 1)
    lags = np.concatenate([np.arange(0, maxlag + 1), np.arange(-maxlag, 0)])
    vals = np.concatenate([corr[: maxlag + 1], corr[n - maxlag:]])
    i = int(np.argmax(vals))
    best = vals[i]
    # confidence: how much the best peak stands out from the rest (excluding its neighbourhood)
    mask = np.abs(lags - lags[i]) > rate * 2
    second = vals[mask].max() if mask.any() else 0
    noise = vals.std() + 1e-9
    ratio = float((best - second) / noise)
    conf = "high" if ratio > 4 else "medium" if ratio > 1.5 else "low"
    return {"offset": round(float(lags[i]) / rate, 2), "confidence": conf, "score": round(ratio, 2)}


def frame_jpeg(src: Path, t: float, width=640) -> bytes:
    seek = ["-ss", f"{t}"] if t > 0 else []  # seeking inside a still image returns nothing
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *seek, "-i", str(src), "-frames:v", "1",
                        "-vf", f"scale={width}:-2", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "-"],
                       capture_output=True)
    return r.stdout


def activity(proxy: Path, start: float, duration: float) -> list[list[float]]:
    """How much the picture changes, sampled twice per second: [[time, score], ...] (time relative to start)."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-ss", f"{max(0, start):.3f}", "-t", f"{duration:.3f}", "-i", str(proxy),
           "-an", "-vf", "fps=2,scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"]
    err = subprocess.run(cmd, capture_output=True, text=True).stderr
    out, t = [], None
    for line in err.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"lavfi.scene_score=([\d.]+)", line)
        if m and t is not None:
            out.append([round(t + min(0, start), 2), round(float(m.group(1)), 5)])
            t = None
    return out


def content_regions(proxy: Path, t: float, count: int = 3) -> list[dict]:
    """Where is the content on a slide? Edge density in vertical bands -> zoom targets."""
    import cv2
    img = cv2.imdecode(np.frombuffer(frame_jpeg(proxy, t, 640), np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []
    h, w = img.shape
    edges = cv2.Canny(img, 60, 160).astype(np.float32) / 255.0
    edges[: int(h * 0.06)] = 0          # ignore toolbars / title bars at the very top
    col = edges.sum(axis=0)
    row_total = edges.sum() + 1e-6
    win = int(w * 0.45)
    cands = []
    for x0 in range(0, w - win + 1, max(1, w // 40)):
        dens = col[x0:x0 + win].sum() / row_total
        cands.append((dens, x0))
    cands.sort(reverse=True)
    picked = []
    for dens, x0 in cands:
        cx = (x0 + win / 2) / w
        if all(abs(cx - p["x"]) > 0.22 for p in picked):
            band = edges[:, x0:x0 + win]
            rows = band.sum(axis=1)
            cy = float((rows * np.arange(h)).sum() / (rows.sum() + 1e-6)) / h
            label = "left part" if cx < 0.38 else "right part" if cx > 0.62 else "middle"
            picked.append({"x": round(cx, 3), "y": round(min(0.8, max(0.2, cy)), 3), "zoom": 1.9,
                           "density": round(float(dens), 3), "label": label})
        if len(picked) >= count:
            break
    return picked
