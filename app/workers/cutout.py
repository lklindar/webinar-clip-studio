"""Person cutout worker (separate process): builds a person mask video for part of the speaker recording.

Uses Apple's built-in person segmentation (Vision framework, runs on the Mac's Neural Engine) —
no model download, nothing leaves the Mac. Output: a grayscale H.264 video (white = person) aligned
frame-by-frame with the speaker recording from `start`, at `fps`.

usage: python -m app.workers.cutout SRC START DURATION FPS OUT_MP4 [quality]
"""
import json
import subprocess
import sys
import time

import numpy as np

MASK_H = 480  # mask resolution (height); the edge is smoothed when composited


def emit(**kw):
    print(json.dumps(kw), flush=True)


class Segmenter:
    def __init__(self, quality="balanced"):
        import Quartz
        import Vision
        self.Q, self.V = Quartz, Vision
        self.req = Vision.VNGeneratePersonSegmentationRequest.alloc().initWithCompletionHandler_(None)
        lvl = {"fast": Vision.VNGeneratePersonSegmentationRequestQualityLevelFast,
               "balanced": Vision.VNGeneratePersonSegmentationRequestQualityLevelBalanced,
               "accurate": Vision.VNGeneratePersonSegmentationRequestQualityLevelAccurate}[quality]
        self.req.setQualityLevel_(lvl)
        self.req.setOutputPixelFormat_(1278226488)  # kCVPixelFormatType_OneComponent8 ('L008')
        self.cs = Quartz.CGColorSpaceCreateDeviceRGB()

    def mask(self, rgb: np.ndarray) -> np.ndarray:
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
            base = Q.CVPixelBufferGetBaseAddress(pb)
            buf = bytes(base.as_buffer(stride * mh))
            m = np.frombuffer(buf, np.uint8).reshape(mh, stride)[:, :mw].copy()
        finally:
            Q.CVPixelBufferUnlockBaseAddress(pb, 1)
        return m


def main():
    src, start, dur, fps, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    quality = sys.argv[6] if len(sys.argv) > 6 else "balanced"
    import cv2
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                       "stream=width,height", "-of", "json", src], capture_output=True, text=True).stdout)
    sw, sh = probe["streams"][0]["width"], probe["streams"][0]["height"]
    w = int(round(sw * MASK_H / sh / 2)) * 2
    h = MASK_H
    n = int(round(dur * fps))
    emit(progress=0.0, message="Starting the person cutout…")
    seg = Segmenter(quality)
    dec = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{max(0, start):.3f}", "-i", src, "-t", f"{dur:.3f}",
                            "-map", "0:v:0", "-vf", f"fps={fps},scale={w}:{h}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    enc = subprocess.Popen(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}",
                            "-r", f"{fps}", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
                            "-pix_fmt", "yuv420p", "-g", "15", "-movflags", "+faststart", out + ".part.mp4"],
                           stdin=subprocess.PIPE)
    fb = w * h * 3
    prev = None
    t0 = time.time()
    i = 0
    while True:
        buf = dec.stdout.read(fb)
        if len(buf) < fb:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        m = seg.mask(frame)
        if m.shape != (h, w):
            m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
        # light temporal smoothing against flicker at the edges
        if prev is not None:
            m = cv2.addWeighted(m, 0.7, prev, 0.3, 0)
        prev = m
        enc.stdin.write(m.tobytes())
        i += 1
        if i % 15 == 0:
            left = (time.time() - t0) / i * max(0, n - i)
            emit(progress=min(0.99, i / max(n, 1)), message=f"Cutting out the speaker… frame {i} of {n} (about {int(left) + 1} s left)")
    enc.stdin.close()
    enc.wait()
    dec.wait()
    if i == 0 or enc.returncode != 0:
        emit(error="Could not read the speaker video for the cutout.")
        return
    import os
    os.replace(out + ".part.mp4", out)
    emit(progress=1.0, message=f"Person cutout ready ({i} frames)", result={"frames": i, "width": w, "height": h})


if __name__ == "__main__":
    main()
