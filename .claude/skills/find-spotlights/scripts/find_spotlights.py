#!/usr/bin/env python3
"""find-spotlights: which element on the slide is the speaker talking about, and when (macOS).

Source: webinar-clip-studio/app/spotlight.py (+ /api/projects/{pid}/spotlights in app/server.py).

For each slide shown in the clip, the slide text is read with Apple's on-device text recognition (Vision OCR).
Every spoken sentence is compared with the text blocks; when a sentence clearly talks about one block
(shared meaningful words, words that appear on many blocks count less), that block, grown to the
picture/card it labels, becomes a spotlight moment: keep it sharp, dim the rest, show a click ring.

Examples
  python find_spotlights.py --screen screen.mp4 --words webinar.words.json --start 12:30 --end 13:15 --offset 4.0
  python find_spotlights.py --screen screen.mp4 --words w.json --start 750 --end 795 --preview spot-previews/

Times (start/end of each moment) are on the transcript/speaker clock; `clip_start`/`clip_end` are relative to --start.
Boxes are 0..1 of the screen recording (x, y, w, h from top-left).
Needs macOS + the webinar-clip-studio .venv (pyobjc Vision/Quartz, opencv, numpy).
Last line on stdout = JSON {"events": [...]}.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from screen import scene_scores, slide_changes  # noqa: E402
from words import build_sentences, done, fmt_time, load_words, parse_time  # noqa: E402

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("Needs opencv + numpy: run with the webinar-clip-studio .venv/bin/python.")

STOP = set("""a an the and or but if then so of to in on at for from by with about as is are was were be been being
this that these those it its it's i you he she we they them their our your my me us do does did done have has had
can could will would should may might must just very really also not no yes than too more most much many some any
all each every there here what which who whom whose when where why how into out up down over under again once
like get got make made going go know think thing things way one two three okay ok right well actually basically
lot lots kind sort mean say said see look use using used want need""".split())


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def ocr(img_bgr):
    """Text lines: [{"text", "box": [x, y, w, h] (0..1, top-left origin), "conf"}] via Apple Vision."""
    try:
        import Quartz
        import Vision
        from Foundation import NSData
    except ImportError:
        sys.exit("Apple Vision is not available: run on macOS with the webinar-clip-studio .venv/bin/python.")
    ok, png = cv2.imencode(".png", img_bgr)
    data = NSData.dataWithBytes_length_(png.tobytes(), len(png))
    src = Quartz.CGImageSourceCreateWithData(data, None)
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    handler.performRequests_error_([req], None)
    out = []
    for r in req.results() or []:
        cand = r.topCandidates_(1)
        if not cand:
            continue
        c = cand[0]
        bb = r.boundingBox()  # normalised, bottom-left origin
        x, y, w, h = bb.origin.x, bb.origin.y, bb.size.width, bb.size.height
        out.append({"text": str(c.string()), "box": [round(x, 4), round(1 - y - h, 4), round(w, 4), round(h, 4)],
                    "conf": round(float(c.confidence()), 3)})
    return out


def stem(w):
    for suf in ("ing", "ers", "er", "es", "s", "ed", "ly"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def content_words(text):
    out = set()
    for w in re.findall(r"[A-Za-z][A-Za-z0-9'+.-]*|\d+%?", text.lower()):
        w = w.strip(".'-")
        if (len(w) < 3 and not w.isdigit() and w not in ("ai",)) or w in STOP:
            continue
        out.add(stem(w))
    return out


def group_blocks(lines, gap=0.025):
    """Merge stacked text lines of one label into blocks."""
    blocks = []
    for ln in sorted(lines, key=lambda l: (l["box"][1], l["box"][0])):
        x, y, w, h = ln["box"]
        hit = None
        for b in blocks:
            bx, by, bw, bh = b["box"]
            if min(x + w, bx + bw) - max(x, bx) > 0.3 * min(w, bw) and 0 <= y - (by + bh) < max(gap, 1.2 * h):
                hit = b
                break
        if hit:
            bx, by, bw, bh = hit["box"]
            nx, ny = min(x, bx), min(y, by)
            hit["box"] = [nx, ny, max(x + w, bx + bw) - nx, max(y + h, by + bh) - ny]
            hit["text"] += " " + ln["text"]
        else:
            blocks.append({"text": ln["text"], "box": [x, y, w, h]})
    return blocks


def element_around(img_bgr, box, max_area=0.3):
    """Grow a text block to the picture/icons directly above or below it in the same column."""
    H, W = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    bg = float(np.median(gray))
    mask = (np.abs(gray.astype(np.int16) - bg) > 28).astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, _area = stats[i]
        if w * h > max_area * W * H or w * h < 0.0004 * W * H or (w < 0.012 * W and h > 0.15 * H):
            continue
        comps.append((x / W, y / H, w / W, h / H))
    rx, ry, rw, rh = box
    lx0, lx1 = rx, rx + rw
    changed = True
    while changed:
        changed = False
        for cx, cy, cw, ch in comps:
            if cx >= rx - 1e-3 and cy >= ry - 1e-3 and cx + cw <= rx + rw + 1e-3 and cy + ch <= ry + rh + 1e-3:
                continue
            if min(cx + cw, lx1 + 0.25 * (lx1 - lx0)) - max(cx, lx0 - 0.25 * (lx1 - lx0)) < 0.5 * cw:
                continue
            if max(cy - (ry + rh), ry - (cy + ch), 0) > 0.05:
                continue
            nx0, ny0 = min(rx, cx), min(ry, cy)
            nx1, ny1 = max(rx + rw, cx + cw), max(ry + rh, cy + ch)
            if (nx1 - nx0) > max(2.0 * (lx1 - lx0), 0.16) or (nx1 - nx0) * (ny1 - ny0) > max_area:
                continue
            rx, ry, rw, rh = nx0, ny0, nx1 - nx0, ny1 - ny0
            changed = True
    pad = 0.008
    rx, ry = max(0.0, rx - pad), max(0.0, ry - pad)
    return [round(rx, 4), round(ry, 4), round(min(1 - rx, rw + 2 * pad), 4), round(min(1 - ry, rh + 2 * pad), 4)]


def slide_elements(img):
    out = []
    for b in group_blocks([l for l in ocr(img) if l["conf"] >= 0.3]):
        words = content_words(b["text"])
        if not words or len(re.sub(r"[^A-Za-z]", "", b["text"])) < 3:
            continue
        lines_n = max(1, round(b["box"][3] / 0.02))
        if len(words) < 2 and b["box"][3] / lines_n < 0.02:   # tiny single labels = app menus/toolbars
            continue
        out.append({"text": b["text"], "words": sorted(words), "label": b["box"], "box": element_around(img, b["box"])})
    return out


def match(sentences, elements, min_score=0.99):
    """For each sentence, the element it clearly talks about (or nothing)."""
    df = {}
    for e in elements:
        for w in e["words"]:
            df[w] = df.get(w, 0) + 1
    res = []
    for s in sentences:
        sw = content_words(s["text"])
        scored = sorted(((sum(1.0 / df[w] for w in sw & set(e["words"])), i, sw & set(e["words"]))
                         for i, e in enumerate(elements)), reverse=True)
        scored = [x for x in scored if x[0] > 0]
        if scored and scored[0][0] >= min_score and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.3):
            res.append((s, scored[0][1], scored[0][2]))
    return res


def frame(path, t, out):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(path),
                    "-frames:v", "1", "-y", out], capture_output=True)
    img = cv2.imread(out) if os.path.exists(out) else None
    if img is None:
        sys.exit(f"Could not read the screen recording at {fmt_time(t)}.")
    return img


def preview(img, ev, out):
    """Slide with the spotlight drawn like the app does: rest blurred + dimmed, white frame, click ring."""
    H, W = img.shape[:2]
    x, y, w, h = ev["box"]
    x0, y0, x1, y1 = int(x * W), int(y * H), int((x + w) * W), int((y + h) * H)
    eff = (cv2.GaussianBlur(img, (0, 0), sigmaX=max(1.0, W * 0.004)) * 0.5).astype(np.uint8)
    eff[y0:y1, x0:x1] = img[y0:y1, x0:x1]
    cv2.rectangle(eff, (x0, y0), (x1 - 1, y1 - 1), (255, 255, 255), max(1, int(W * 0.003)), cv2.LINE_AA)
    cx, cy, r = int(ev["click"][0] * W), int(ev["click"][1] * H), max(6, int(W * 0.018))
    fill = eff.copy()
    cv2.circle(fill, (cx, cy), r, (36, 165, 245), -1, cv2.LINE_AA)
    eff = cv2.addWeighted(fill, 0.5, eff, 0.5, 0)
    cv2.circle(eff, (cx, cy), r, (255, 255, 255), max(2, int(W * 0.004)), cv2.LINE_AA)
    cv2.imwrite(out, eff)


def main():
    ap = argparse.ArgumentParser(description="Find which slide element the speaker talks about (Apple Vision OCR).")
    ap.add_argument("--screen", required=True, help="screen/slide recording")
    ap.add_argument("--words", required=True, help="transcript JSON (speaker clock)")
    ap.add_argument("--start", required=True, help="clip start (seconds or mm:ss, speaker clock)")
    ap.add_argument("--end", required=True)
    ap.add_argument("--offset", type=float, default=0.0, help="screen_time = speaker_time + offset (sync-recordings)")
    ap.add_argument("--slides", help='slide change times on the speaker clock, e.g. "755.5, 770" (default: detect)')
    ap.add_argument("--preview", help="folder: save one PNG per moment showing the spotlight")
    a = ap.parse_args()
    for f in (a.screen, a.words):
        if not os.path.isfile(f):
            sys.exit(f"File not found: {f}")
    start, end = parse_time(a.start), parse_time(a.end)
    words = load_words(a.words)
    sents = build_sentences(words)
    if a.slides:
        slides = [float(x) for x in a.slides.split(",") if x.strip()]
    else:
        log("Detecting slide changes…")
        slides = [start + t for t in slide_changes(scene_scores(a.screen, start + a.offset, end - start))]
    bounds = [start] + [t for t in slides if start + 0.5 < t < end - 0.5] + [end]
    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
    events = []
    with tempfile.TemporaryDirectory() as td:
        for k in range(len(bounds) - 1):
            s0, s1 = bounds[k], bounds[k + 1]
            log(f"Reading slide {k + 1} of {len(bounds) - 1} ({fmt_time(s0)}–{fmt_time(s1)})…")
            img = frame(a.screen, s0 + min(1.0, (s1 - s0) / 2) + a.offset, os.path.join(td, f"s{k}.png"))
            elements = slide_elements(img)
            for s, i, common in match([x for x in sents if x["end"] > s0 and x["start"] < s1], elements):
                e = elements[i]
                hit = [w for w in words if s["start"] - 0.01 <= w["start"] <= s["end"] + 0.01
                       and content_words(w["text"]) & common]
                t0 = max(s0, (hit[0]["start"] if hit else s["start"]) - 0.25)
                t1 = min(s1, s["end"] + 0.6)
                if events and events[-1]["text"] == e["text"] and t0 - events[-1]["end"] < 2.5:
                    events[-1]["end"] = round(t1, 2)   # still talking about the same element
                    continue
                lx, ly, lw, lh = e["label"]
                events.append({"start": round(t0, 2), "end": round(t1, 2), "text": e["text"], "box": e["box"],
                               "click": [round(lx + lw / 2, 4), round(ly + lh / 2, 4)], "said": s["text"][:140],
                               "_img": k})
            if a.preview:
                for j, ev in enumerate(events):
                    if ev.get("_img") == k and "preview" not in ev:
                        ev["preview"] = os.path.join(a.preview, f"spot-{j + 1:02d}-{int(ev['start'])}s.png")
                        preview(img, ev, ev["preview"])
    for e in events:   # too short to show: drop (and its preview)
        if e["end"] - e["start"] < 1.2 and e.get("preview") and os.path.exists(e["preview"]):
            os.unlink(e["preview"])
    events = [e for e in events if e["end"] - e["start"] >= 1.2]
    for e in events:
        e.pop("_img", None)
        e["clip_start"], e["clip_end"] = round(e["start"] - start, 2), round(e["end"] - start, 2)
    done({"start": start, "end": end, "slides": len(bounds) - 1, "events": events})


if __name__ == "__main__":
    main()
