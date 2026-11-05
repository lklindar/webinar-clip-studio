#!/usr/bin/env python3
"""find-face: where is the speaker's face, and how to crop the video to 9:16 around it.

Source: webinar-clip-studio/app/server.py (/api/projects/{pid}/face).

Samples a few frames, finds the largest face (OpenCV), and returns the median position.
`y` aims slightly below the face centre so head + shoulders stay in frame.

Examples
  python find_face.py speaker.mp4                        # whole video
  python find_face.py speaker.mp4 --start 12:30 --end 13:15 --samples 9

Last line on stdout = JSON {"found", "x", "y", "face_height", "crop_9x16": {"x", "y", "w", "h"}, "ffmpeg_crop"}.
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import done, parse_time, probe  # noqa: E402


def gray_frame(src, t, width=640):
    import numpy as np
    seek = ["-ss", f"{t:.3f}"] if t > 0 else []
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *seek, "-i", src, "-frames:v", "1",
                          "-vf", f"scale={width}:-2", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    h = len(raw) // width
    return np.frombuffer(raw[: width * h], np.uint8).reshape(h, width) if h else None


def main():
    ap = argparse.ArgumentParser(description="Speaker face position + 9:16 crop box.")
    ap.add_argument("video")
    ap.add_argument("--start", help="part to look at (seconds or mm:ss)")
    ap.add_argument("--end")
    ap.add_argument("--samples", type=int, default=5, help="frames to sample (default 5)")
    a = ap.parse_args()
    if not os.path.isfile(a.video):
        sys.exit(f"File not found: {a.video}")
    try:
        import cv2
        import numpy as np
    except ImportError:
        sys.exit("Needs opencv + numpy: run with the webinar-clip-studio .venv/bin/python.")
    det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if det.empty():
        sys.exit("OpenCV's face model file is missing in this Python environment.")
    info = probe(a.video)
    W, H = info["width"], info["height"]
    s0 = parse_time(a.start) if a.start else 0.0
    s1 = parse_time(a.end) if a.end else info["duration"]
    pts = []
    for k in range(max(1, a.samples)):
        img = gray_frame(a.video, s0 + (s1 - s0) * (k + 0.5) / a.samples)
        if img is None:
            continue
        faces = det.detectMultiScale(img, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            pts.append(((x + w / 2) / img.shape[1], (y + h / 2) / img.shape[0], h / img.shape[0]))
    if pts:
        xs, ys, hs = zip(*pts)
        fx = float(np.median(xs))
        fy = min(0.8, float(np.median(ys)) + float(np.median(hs)) * 0.35)
        fh = float(np.median(hs))
    else:
        fx, fy, fh = 0.5, 0.42, None
    # largest 9:16 window that fits, centred on the face (clamped to the frame)
    cw, ch = (W, int(W * 16 / 9)) if W * 16 / 9 <= H else (int(H * 9 / 16), H)
    cw, ch = cw // 2 * 2, ch // 2 * 2
    cx = int(min(max(fx * W - cw / 2, 0), W - cw))
    cy = int(min(max(fy * H - ch / 2, 0), H - ch))
    done({"found": bool(pts), "samples": len(pts), "x": round(fx, 3), "y": round(fy, 3),
          "face_height": round(fh, 3) if fh else None, "video": {"width": W, "height": H},
          "crop_9x16": {"x": cx, "y": cy, "w": cw, "h": ch},
          "ffmpeg_crop": f"crop={cw}:{ch}:{cx}:{cy},scale=1080:1920"})


if __name__ == "__main__":
    main()
