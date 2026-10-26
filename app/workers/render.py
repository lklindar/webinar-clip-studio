"""Render worker (separate process): executes a composition plan and encodes an MP4.

The plan is produced by the browser's layout engine (static/js/compose.js) — the same code
that draws the live preview — so preview and export use identical geometry:
  frames[i] = list of draw ops for output frame i, all coordinates normalised 0..1
     op = {"s": "spk"|"pres", "c": [x,y,w,h] source crop, "d": [x,y,w,h] destination,
           "a": alpha, "b": 1 if blurred background fill, "r": [x,y,w,h] clip rect (optional)}
  overlays = caption/title images (RGBA PNG, full frame) with [start, end) times, drawn by the
             browser's caption renderer (static/js/captions.js).

Only the clip's segment of each source is decoded (ffmpeg seeks straight to it).
usage: python -m app.workers.render PLAN_JSON
"""
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

cv2.setNumThreads(4)


def emit(**kw):
    print(json.dumps(kw), flush=True)


class SourceReader:
    """Streams decoded frames of [start, start+duration) at the output fps, resized to a working size."""

    def __init__(self, path, start, duration, fps, src_w, src_h, max_h, gray=False, loop=False):
        self.gray = gray
        scale = min(1.0, max_h / src_h)
        self.w = int(round(src_w * scale / 2)) * 2
        self.h = int(round(src_h * scale / 2)) * 2
        self.ch = 1 if gray else 3
        self.frame_bytes = self.w * self.h * self.ch
        self.lead = 0
        if start < 0:  # this recording had not started yet -> black frames first
            self.lead = int(math.ceil(-start * fps))
            duration += start
            start = 0.0
        self.black = np.zeros((self.h, self.w, self.ch), np.uint8) if not gray else np.zeros((self.h, self.w), np.uint8)
        self.last = None
        self.first = None
        self.pending_first = False
        self.i = 0
        self.proc = None
        if duration > 0:
            self.proc = subprocess.Popen(
                ["ffmpeg", "-nostdin", "-v", "error", *(["-stream_loop", "-1"] if loop else []), "-ss", f"{start:.3f}",
                 "-i", str(path), "-t", f"{duration:.3f}",
                 "-map", "0:v:0", "-vf", f"fps={fps},scale={self.w}:{self.h}:flags=bicubic", "-pix_fmt", "gray" if gray else "bgr24",
                 "-f", "rawvideo", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=self.frame_bytes * 2)

    def next(self):
        self.i += 1
        if not self.proc:
            return self.black
        if self.i <= self.lead:
            # not started yet: show the first frame (instead of black) so transitions into it look clean
            if self.first is None:
                buf = self.proc.stdout.read(self.frame_bytes)
                self.first = self._shape(buf) if len(buf) == self.frame_bytes else self.black
                self.last = self.first
                self.pending_first = True
            return self.first
        if self.pending_first:
            self.pending_first = False
            return self.first
        buf = self.proc.stdout.read(self.frame_bytes)
        if len(buf) < self.frame_bytes:  # recording ended -> hold the last frame
            return self.last if self.last is not None else self.black
        self.last = self._shape(buf)
        return self.last

    def _shape(self, buf):
        a = np.frombuffer(buf, np.uint8)
        return a.reshape(self.h, self.w) if self.gray else a.reshape(self.h, self.w, 3)

    def close(self):
        if self.proc:
            self.proc.kill()


class ImageReader:
    """A still image used as a source (your asset): the same frame every time."""

    def __init__(self, path, max_h):
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is None:
            img = np.zeros((16, 16, 3), np.uint8)
        if img.shape[0] > max_h * 1.5:
            k = max_h * 1.5 / img.shape[0]
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        self.img = img

    def next(self):
        return self.img

    def close(self):
        pass


def hex_bgr(h):
    h = h.lstrip("#")
    return (int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16))


def warp_region(src, op, W, H, x0, y0, x1, y1):
    """The op's source crop mapped onto output region [x0,x1)x[y0,y1) (same math as the main draw)."""
    fh, fw = src.shape[:2]
    cx, cy, cw, ch = op["c"][0] * fw, op["c"][1] * fh, op["c"][2] * fw, op["c"][3] * fh
    dx, dy, dw, dh = op["d"][0] * W, op["d"][1] * H, op["d"][2] * W, op["d"][3] * H
    sx, sy = dw / cw, dh / ch
    M = np.array([[sx, 0, dx - cx * sx - x0], [0, sy, dy - cy * sy - y0]], np.float32)
    return cv2.warpAffine(src, M, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def draw_op(canvas, frame, op, W, H, cache, mask=None):
    fh, fw = frame.shape[:2]
    cx, cy, cw, ch = op["c"]
    dx, dy, dw, dh = op["d"]
    cx, cw = cx * fw, cw * fw
    cy, ch = cy * fh, ch * fh
    dx, dw = dx * W, dw * W
    dy, dh = dy * H, dh * H
    if cw < 1 or ch < 1 or dw < 1 or dh < 1:
        return
    # region to paint = destination ∩ clip rect ∩ canvas
    x0, y0, x1, y1 = dx, dy, dx + dw, dy + dh
    if op.get("r"):
        rx, ry, rw, rh = op["r"]
        x0, y0 = max(x0, rx * W), max(y0, ry * H)
        x1, y1 = min(x1, (rx + rw) * W), min(y1, (ry + rh) * H)
    x0, y0 = max(0, int(round(x0))), max(0, int(round(y0)))
    x1, y1 = min(W, int(round(x1))), min(H, int(round(y1)))
    if x1 <= x0 or y1 <= y0:
        return
    alpha = float(op.get("a", 1))
    if alpha <= 0.001:
        return

    if op.get("b"):  # blurred, darkened fill (behind 'fit' content)
        sx0, sy0 = max(0, int(cx)), max(0, int(cy))
        sx1, sy1 = min(fw, int(cx + cw)), min(fh, int(cy + ch))
        if sx1 <= sx0 or sy1 <= sy0:
            return
        small_w, small_h = max(2, int(dw / 24)), max(2, int(dh / 24))
        small = cv2.resize(frame[sy0:sy1, sx0:sx1], (small_w, small_h), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (3, 3), 0)
        big = cv2.resize(small, (int(round(dw)), int(round(dh))), interpolation=cv2.INTER_LINEAR)
        big = (big.astype(np.float32) * 0.55).astype(np.uint8)
        ox, oy = int(round(dx)), int(round(dy))
        patch = big[max(0, y0 - oy):max(0, y0 - oy) + (y1 - y0), max(0, x0 - ox):max(0, x0 - ox) + (x1 - x0)]
        if patch.shape[0] != y1 - y0 or patch.shape[1] != x1 - x0:
            patch = cv2.resize(patch, (x1 - x0, y1 - y0))
    else:
        sx, sy = dw / cw, dh / ch
        src = frame
        if min(sx, sy) < 0.6:  # strong downscale: pre-shrink with area filter to avoid aliasing
            f = min(sx, sy) / 0.8
            key = (id(frame), round(f, 3))
            if key not in cache:
                cache[key] = cv2.resize(frame, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
            src = cache[key]
            k = src.shape[1] / fw
            cx, cy, cw, ch = cx * k, cy * k, cw * k, ch * k
            sx, sy = dw / cw, dh / ch
        M = np.array([[sx, 0, dx - cx * sx - x0], [0, sy, dy - cy * sy - y0]], np.float32)
        patch = cv2.warpAffine(src, M, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    roi = canvas[y0:y1, x0:x1]
    if mask is not None and not op.get("b"):
        # person cutout: blend through the person mask (soft edge)
        mk = warp_region(mask, op, W, H, x0, y0, x1, y1)
        mk = cv2.GaussianBlur(mk, (5, 5), 0).astype(np.float32)[:, :, None] * (alpha / 255.0)
        roi[:] = (roi.astype(np.float32) * (1 - mk) + patch.astype(np.float32) * mk).astype(np.uint8)
        return
    if alpha >= 0.999:
        roi[:] = patch
    else:
        cv2.addWeighted(patch, alpha, roi, 1 - alpha, 0, dst=roi)


def fill_rect(canvas, op, W, H):
    x, y, w, h = op["d"]
    x0, y0 = max(0, int(round(x * W))), max(0, int(round(y * H)))
    x1, y1 = min(W, int(round((x + w) * W))), min(H, int(round((y + h) * H)))
    if x1 <= x0 or y1 <= y0:
        return
    roi = canvas[y0:y1, x0:x1]
    a = float(op.get("a", 1))
    col = np.array(hex_bgr(op["fill"]), np.float32)
    if a >= 0.999:
        roi[:] = col.astype(np.uint8)
    else:
        roi[:] = (roi.astype(np.float32) * (1 - a) + col * a).astype(np.uint8)


class Overlays:
    def __init__(self, items, W, H):
        self.items = sorted(items, key=lambda x: x["start"])
        self.W, self.H = W, H
        self.cur_file = None
        self.cur = None

    def at(self, t):
        for it in self.items:
            if it["start"] <= t < it["end"]:
                return self._load(it["file"])
        return None

    def _load(self, f):
        if f != self.cur_file:
            self.cur_file = f
            img = cv2.imread(f, cv2.IMREAD_UNCHANGED)
            self.cur = None
            if img is not None and img.ndim == 3 and img.shape[2] == 4:
                if img.shape[1] != self.W or img.shape[0] != self.H:
                    img = cv2.resize(img, (self.W, self.H), interpolation=cv2.INTER_AREA)
                a = img[:, :, 3]
                ys, xs = np.nonzero(a)
                if len(ys):
                    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
                    al = (a[y0:y1, x0:x1].astype(np.float32) / 255.0)[:, :, None]
                    # browser canvas PNGs are not premultiplied
                    self.cur = (y0, y1, x0, x1, img[y0:y1, x0:x1, :3].astype(np.float32) * al, 1.0 - al)
        return self.cur

    @staticmethod
    def blend(canvas, ov):
        y0, y1, x0, x1, rgb_a, inv = ov
        roi = canvas[y0:y1, x0:x1]
        roi[:] = np.clip(roi.astype(np.float32) * inv + rgb_a, 0, 255).astype(np.uint8)


def audio_args(audio, duration):
    """Returns (input args, filter string) for the clip's audio."""
    if not audio or not audio.get("path"):
        return ["-f", "lavfi", "-t", f"{duration:.3f}", "-i", "anullsrc=r=48000:cl=stereo"], "anull"
    start = float(audio["start"])
    filters = []
    if start < 0:
        filters.append(f"adelay={int(-start * 1000)}:all=1")
        dur_in, start = duration + start, 0.0
    else:
        dur_in = duration
    gain = float(audio.get("gain_db", 0))
    if gain:
        filters.append(f"volume={gain}dB")
    if audio.get("normalize", True):
        filters.append("loudnorm=I=-14:TP=-1.5:LRA=11")
    fade = float(audio.get("fade", 0.12))
    filters.append("aresample=48000")
    filters.append(f"apad=whole_dur={duration:.3f}")
    if fade > 0:
        filters.append(f"afade=t=in:st=0:d={fade}")
        filters.append(f"afade=t=out:st={max(0, duration - fade * 2):.3f}:d={fade * 2:.3f}")
    return ["-ss", f"{start:.3f}", "-t", f"{max(0.1, dur_in):.3f}", "-i", str(audio["path"])], ",".join(filters)


def verify(out: Path, W, H, duration) -> dict:
    """Check the exported file instead of trusting ffmpeg's exit code."""
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(out)],
                       capture_output=True, text=True)
    info = json.loads(r.stdout or "{}")
    v = next((s for s in info.get("streams", []) if s["codec_type"] == "video"), None)
    a = next((s for s in info.get("streams", []) if s["codec_type"] == "audio"), None)
    dur = float(info.get("format", {}).get("duration", 0))
    dec = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(out), "-f", "null", "-"],
                         capture_output=True, text=True)
    vol = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(out), "-vn", "-af", "volumedetect", "-f", "null",
                          "-"], capture_output=True, text=True).stderr
    mean_db = None
    for line in vol.splitlines():
        if "mean_volume" in line:
            mean_db = float(line.split(":")[1].strip().split()[0])
    problems = []
    if not v:
        problems.append("no video stream")
    else:
        if (int(v["width"]), int(v["height"])) != (W, H):
            problems.append(f"unexpected size {v['width']}x{v['height']}")
        if v.get("codec_name") != "h264" or v.get("pix_fmt") != "yuv420p":
            problems.append("video is not H.264 yuv420p")
    if not a:
        problems.append("no audio stream")
    if abs(dur - duration) > 0.25:
        problems.append(f"duration {dur:.2f}s differs from expected {duration:.2f}s")
    if dec.stderr.strip():
        problems.append("decoder reported errors: " + dec.stderr.strip()[:200])
    return {"ok": not problems, "problems": problems, "width": v and int(v["width"]), "height": v and int(v["height"]),
            "duration": round(dur, 3), "video_codec": v and v.get("codec_name"), "audio_codec": a and a.get("codec_name"),
            "mean_volume_db": mean_db, "size_bytes": out.stat().st_size if out.exists() else 0}


def main():
    plan = json.loads(Path(sys.argv[1]).read_text())
    W, H, fps = int(plan["width"]), int(plan["height"]), float(plan["fps"])
    frames = plan["frames"]
    n = len(frames)
    duration = n / fps
    out = Path(plan["out"])
    tmp = out.with_name(out.stem + ".part.mp4")
    max_h = int(plan.get("decode_max_height", 1440))
    used = {op["s"] for ops in frames for op in ops if "s" in op} | {op["m"] for ops in frames for op in ops if op.get("m")}
    readers = {}
    for key, src in plan["sources"].items():
        if key in used and src.get("image"):
            readers[key] = ImageReader(src["path"], max_h)
        elif key in used:
            readers[key] = SourceReader(src["path"], float(src["start"]), duration, fps, int(src["width"]),
                                        int(src["height"]), max_h, gray=bool(src.get("gray")), loop=bool(src.get("loop")))
    overlays = Overlays(plan.get("overlays", []), W, H)
    a_in, a_filter = audio_args(plan.get("audio"), duration)
    q = plan.get("quality", "standard")
    preset, crf = {"preview": ("ultrafast", "28"), "standard": ("veryfast", "20"), "high": ("medium", "18")}[q]
    enc_log = out.with_suffix(".log")
    enc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
         "-r", f"{fps}", "-i", "-", *a_in, "-map", "0:v", "-map", "1:a", "-af", a_filter,
         "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p", "-profile:v", "high",
         "-r", f"{fps}", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-t", f"{duration:.3f}",
         "-movflags", "+faststart", str(tmp)],
        stdin=subprocess.PIPE, stderr=open(enc_log, "w"))
    bg = hex_bgr(plan.get("background", "#000000"))
    canvas = np.zeros((H, W, 3), np.uint8)
    t0 = time.time()
    try:
        for i in range(n):
            t = i / fps
            src_frames = {k: r.next() for k, r in readers.items()}
            canvas[:] = bg
            cache = {}
            for op in frames[i]:
                if "fill" in op:
                    fill_rect(canvas, op, W, H)
                    continue
                f = src_frames.get(op["s"])
                if f is not None:
                    draw_op(canvas, f, op, W, H, cache, src_frames.get(op["m"]) if op.get("m") else None)
            ov = overlays.at(t)
            if ov is not None:
                Overlays.blend(canvas, ov)
            enc.stdin.write(canvas.tobytes())
            if i % 10 == 0:
                el = time.time() - t0
                left = el / (i + 1) * (n - i - 1)
                emit(progress=0.95 * i / n, message=f"Rendering frame {i + 1} of {n} (about {int(left) + 1} s left)")
        enc.stdin.close()
        code = enc.wait()
    except BrokenPipeError:
        code = enc.wait()
    finally:
        for r in readers.values():
            r.close()
    if code != 0:
        emit(error="The video encoder failed: " + enc_log.read_text()[-800:])
        return
    emit(progress=0.97, message="Checking the exported file…")
    tmp.replace(out)
    enc_log.unlink(missing_ok=True)
    v = verify(out, W, H, duration)
    emit(progress=1.0, message="Done" if v["ok"] else "Exported with warnings", result={"file": str(out), "verify": v,
                                                                                       "seconds": round(time.time() - t0, 1)})


if __name__ == "__main__":
    main()
