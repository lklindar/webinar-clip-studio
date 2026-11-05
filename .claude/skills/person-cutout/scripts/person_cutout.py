#!/usr/bin/env python3
"""person-cutout: the speaker without their background, for part of a recording (macOS).

Source: webinar-clip-studio/app/workers/cutout.py (Apple Vision person segmentation)
        + app/server.py raw_download (green screen / transparent HEVC / ProRes 4444).

Step 1 builds a mask video (white = person) with Apple's Vision framework on the Neural Engine
(no download, nothing leaves the Mac; ~1.3 s of work per second of video).
Step 2 turns it into the file you want.

Examples
  python person_cutout.py speaker.mp4 --start 12:30 --end 13:15 --as green     # MP4 on green #00B140
  python person_cutout.py speaker.mp4 --start 750 --end 795 --as alpha         # transparent HEVC .mov (Apple apps)
  python person_cutout.py speaker.mp4 --start 750 --end 795 --as prores        # ProRes 4444 .mov (Premiere/DaVinci, huge)
  python person_cutout.py speaker.mp4 --start 750 --end 795 --as mask          # just the black/white mask
  python person_cutout.py speaker.mp4 --start 750 --end 795 --mask mask.mp4 --as green   # reuse a mask

Needs: macOS + pyobjc-framework-Vision + pyobjc-framework-Quartz + opencv + numpy (the webinar-clip-studio .venv).
Last line on stdout = JSON.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import done, parse_time, probe  # noqa: E402

MASK_H = 480
PRORES_BYTES_PER_SEC = 55e6  # ProRes 4444 at 1080p30 (measured in webinar-clip-studio)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class Segmenter:
    def __init__(self, quality="balanced"):
        try:
            import Quartz
            import Vision
        except ImportError:
            raise SystemExit("Apple Vision is not available. Run this on macOS with the webinar-clip-studio .venv "
                             "(pyobjc-framework-Vision + pyobjc-framework-Quartz), or pass an existing --mask.")
        self.Q, self.V = Quartz, Vision
        self.req = Vision.VNGeneratePersonSegmentationRequest.alloc().initWithCompletionHandler_(None)
        lvl = {"fast": Vision.VNGeneratePersonSegmentationRequestQualityLevelFast,
               "balanced": Vision.VNGeneratePersonSegmentationRequestQualityLevelBalanced,
               "accurate": Vision.VNGeneratePersonSegmentationRequestQualityLevelAccurate}[quality]
        self.req.setQualityLevel_(lvl)
        self.req.setOutputPixelFormat_(1278226488)  # kCVPixelFormatType_OneComponent8
        self.cs = Quartz.CGColorSpaceCreateDeviceRGB()

    def mask(self, rgb):
        import numpy as np
        Q, V = self.Q, self.V
        h, w = rgb.shape[:2]
        rgba = np.dstack([rgb, np.full((h, w), 255, np.uint8)]).tobytes()
        prov = Q.CGDataProviderCreateWithData(None, rgba, len(rgba), None)
        img = Q.CGImageCreate(w, h, 8, 32, w * 4, self.cs, Q.kCGImageAlphaNoneSkipLast, prov, None, False,
                              Q.kCGRenderingIntentDefault)
        handler = V.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
        ok, err = handler.performRequests_error_([self.req], None)
        if not ok:
            raise RuntimeError(f"Vision failed: {err}")
        pb = self.req.results()[0].pixelBuffer()
        Q.CVPixelBufferLockBaseAddress(pb, 1)
        try:
            mw, mh = Q.CVPixelBufferGetWidth(pb), Q.CVPixelBufferGetHeight(pb)
            stride = Q.CVPixelBufferGetBytesPerRow(pb)
            buf = bytes(Q.CVPixelBufferGetBaseAddress(pb).as_buffer(stride * mh))
            return np.frombuffer(buf, np.uint8).reshape(mh, stride)[:, :mw].copy()
        finally:
            Q.CVPixelBufferUnlockBaseAddress(pb, 1)


def build_mask(src, start, dur, fps, out, quality, sw, sh):
    import cv2
    import numpy as np
    w, h = int(round(sw * MASK_H / sh / 2)) * 2, MASK_H
    n = int(round(dur * fps))
    seg = Segmenter(quality)
    dec = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{max(0, start):.3f}", "-i", src,
                            "-t", f"{dur:.3f}", "-map", "0:v:0", "-vf", f"fps={fps},scale={w}:{h}",
                            "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    enc = subprocess.Popen(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray",
                            "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-", "-c:v", "libx264", "-preset", "veryfast",
                            "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-movflags", "+faststart", out + ".part.mp4"],
                           stdin=subprocess.PIPE)
    fb, prev, i, t0 = w * h * 3, None, 0, time.time()
    while True:
        buf = dec.stdout.read(fb)
        if len(buf) < fb:
            break
        m = seg.mask(np.frombuffer(buf, np.uint8).reshape(h, w, 3))
        if m.shape != (h, w):
            m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
        if prev is not None:  # light temporal smoothing against flicker at the edges
            m = cv2.addWeighted(m, 0.7, prev, 0.3, 0)
        prev = m
        enc.stdin.write(m.tobytes())
        i += 1
        if i % 60 == 0:
            left = (time.time() - t0) / i * max(0, n - i)
            log(f"Cutting out the speaker… frame {i} of {n} (about {int(left) + 1} s left)")
    enc.stdin.close()
    enc.wait()
    dec.wait()
    if i == 0 or enc.returncode != 0:
        raise SystemExit("Could not read the speaker video for the cutout.")
    os.replace(out + ".part.mp4", out)
    return i


def compose(src, start, dur, mask, mask_start, kind, out, W, H):
    lead = ["-ss", f"{max(0, start):.3f}", "-t", f"{dur:.3f}", "-i", src]
    mlead = ["-ss", f"{mask_start:.3f}", "-t", f"{dur:.3f}", "-i", mask]
    alpha = (f"[1:v]scale={W}:{H}:flags=bicubic,gblur=sigma=1.2,format=gray[m];"
             f"[0:v]scale={W}:{H},format=yuva444p10le[v];[v][m]alphamerge[a]")
    if kind == "prores":
        tail = ["-filter_complex", alpha, "-map", "[a]", "-map", "0:a:0?", "-c:v", "prores_ks", "-profile:v", "4444",
                "-pix_fmt", "yuva444p10le", "-c:a", "pcm_s16le"]
    elif kind == "alpha":  # HEVC with alpha (Apple VideoToolbox): ~80x smaller than ProRes 4444
        tail = ["-filter_complex", alpha + ";[a]format=bgra[b]", "-map", "[b]", "-map", "0:a:0?",
                "-c:v", "hevc_videotoolbox", "-alpha_quality", "0.9", "-q:v", "65", "-allow_sw", "1",
                "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    else:
        green = alpha + f";color=c=0x00B140:s={W}x{H}:d={dur:.3f}[g];[g][a]overlay=format=auto:shortest=1,format=yuv420p[o]"
        tail = ["-filter_complex", green, "-map", "[o]", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    tmp = out + ".part" + os.path.splitext(out)[1]
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", *lead, *mlead, *tail, "-t", f"{dur:.3f}", tmp],
                       capture_output=True, text=True)
    if r.returncode != 0:
        hint = " (transparent HEVC needs macOS VideoToolbox; try --as prores or green)" if kind == "alpha" else ""
        raise SystemExit("ffmpeg failed" + hint + ": " + r.stderr[-600:])
    os.replace(tmp, out)


def main():
    ap = argparse.ArgumentParser(description="Speaker without background (Apple Vision), as green screen / transparent / mask.")
    ap.add_argument("source", help="speaker recording")
    ap.add_argument("--start", required=True, help="seconds or mm:ss")
    ap.add_argument("--end", required=True)
    ap.add_argument("--as", dest="kind", choices=["green", "alpha", "prores", "mask"], default="green")
    ap.add_argument("-o", "--out", help="output file (default next to the source)")
    ap.add_argument("--mask", help="existing mask video (white = person) instead of running Vision")
    ap.add_argument("--mask-start", type=float, default=0.0, help="where --start is inside --mask (s, default 0)")
    ap.add_argument("--quality", choices=["fast", "balanced", "accurate"], default="balanced")
    ap.add_argument("--fps", type=float, help="mask frame rate (default: source fps, max 30)")
    a = ap.parse_args()
    for f in (a.source, a.mask):
        if f and not os.path.isfile(f):
            sys.exit(f"File not found: {f}")
    start, end = parse_time(a.start), parse_time(a.end)
    dur = end - start
    if dur <= 0:
        sys.exit("--end must be after --start.")
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,avg_frame_rate", "-of", "csv=p=0", a.source], capture_output=True, text=True)
    W, H, fr = r.stdout.strip().split(",")[:3]
    W, H = int(W), int(H)
    num, den = (fr.split("/") + ["1"])[:2]
    fps = a.fps or min(30.0, float(num) / float(den or 1) if float(den or 1) else 30.0)
    base = os.path.splitext(a.out)[0] if a.out else f"{os.path.splitext(a.source)[0]}-{int(start // 60)}m{int(start % 60):02d}s"
    ext = {"green": ".mp4", "alpha": ".mov", "prores": ".mov", "mask": ".mp4"}[a.kind]
    out = a.out or base + {"green": "-cutout-greenscreen", "alpha": "-cutout-transparent",
                           "prores": "-cutout-transparent-prores", "mask": "-cutout-mask"}[a.kind] + ext
    if a.kind == "prores":
        need = PRORES_BYTES_PER_SEC * dur * (H / 1080) ** 2
        free = shutil.disk_usage(os.path.dirname(os.path.abspath(out))).free
        if need + 1e9 > free:
            sys.exit(f"The ProRes file would be about {need / 1e9:.1f} GB, but only {free / 1e9:.1f} GB is free. "
                     "Use --as alpha (small transparent HEVC) instead.")
    res = {"start": start, "end": end, "as": a.kind}
    if a.mask:
        mask, mstart = a.mask, a.mask_start
    else:
        mask = out if a.kind == "mask" else base + "-cutout-mask.mp4"
        log(f"Finding the person in {dur:.0f} s of video (Apple Vision, {a.quality})…")
        t0 = time.time()
        res["mask_frames"] = build_mask(a.source, start, dur, fps, mask, a.quality, W, H)
        res["mask_seconds"] = round(time.time() - t0, 1)
        mstart = 0.0
    res["mask"] = mask
    if a.kind != "mask":
        log("Building the output file…")
        compose(a.source, start, dur, mask, mstart, a.kind, out, W, H)
        res["output"] = out
        res["size"] = os.path.getsize(out)
        res["duration"] = round(probe(out)["duration"], 2) if a.kind != "alpha" else round(dur, 2)
    done(res)


if __name__ == "__main__":
    main()
