"""Spotlight the slide element the speaker is talking about.

For each slide shown during a clip, the slide's text is read with Apple's on-device text recognition
(Vision). Every sentence of the speaker is compared with the text blocks on the slide; when a sentence
clearly talks about one block (shared meaningful words), that block — grown to the card/box it sits in —
becomes a spotlight moment: the element stays sharp, the rest of the slide is dimmed and softened, and a
click ring appears on it.
"""
import json
import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

STOP = set("""a an the and or but if then so of to in on at for from by with about as is are was were be been being
this that these those it its it's i you he she we they them their our your my me us do does did done have has had
can could will would should may might must just very really also not no yes than too more most much many some any
all each every there here what which who whom whose when where why how into out up down over under again once
like get got make made going go know think thing things way one two three okay ok right well actually basically
lot lots kind sort mean say said see look use using used want need""".split())


def ocr(img_bgr):
    """Text lines on an image: [{"text", "box": [x, y, w, h] (0..1, top-left origin), "conf"}]."""
    import Quartz
    import Vision
    from Foundation import NSData
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


def content_words(text):
    ws = re.findall(r"[A-Za-z][A-Za-z0-9'+.-]*|\d+%?", text.lower())
    out = set()
    for w in ws:
        w = w.strip(".'-")
        if len(w) < 3 and not w.isdigit() and w not in ("ai",):
            continue
        if w in STOP:
            continue
        out.add(stem(w))
    return out


def stem(w):
    for suf in ("ing", "ers", "er", "es", "s", "ed", "ly"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def group_blocks(lines, gap=0.025):
    """Merge text lines that belong together (stacked lines of one label) into blocks."""
    lines = sorted(lines, key=lambda l: (l["box"][1], l["box"][0]))
    blocks = []
    for ln in lines:
        x, y, w, h = ln["box"]
        hit = None
        for b in blocks:
            bx, by, bw, bh = b["box"]
            overlap_x = min(x + w, bx + bw) - max(x, bx)
            if overlap_x > 0.3 * min(w, bw) and 0 <= y - (by + bh) < max(gap, 1.2 * h):
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


def card_around(img_bgr, box, max_area=0.35):
    """The smallest boxed area (card, panel, column) on the slide that contains the text box."""
    H, W = img_bgr.shape[:2]
    x, y, w, h = box[0] * W, box[1] * H, box[2] * W, box[3] * H
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in cnts:
        rx, ry, rw, rh = cv2.boundingRect(c)
        if rw * rh > max_area * W * H or rw * rh < 1.5 * w * h:
            continue
        if rx <= x - 2 and ry <= y - 2 and rx + rw >= x + w + 2 and ry + rh >= y + h + 2:
            if best is None or rw * rh < best[2] * best[3]:
                best = (rx, ry, rw, rh)
    if best is None:
        pad_x, pad_y = 0.02 * W, 0.025 * H
        best = (x - pad_x, y - pad_y, w + 2 * pad_x, h + 2 * pad_y)
    rx, ry, rw, rh = best
    rx, ry = max(0, rx), max(0, ry)
    return [round(rx / W, 4), round(ry / H, 4), round(min(W - rx, rw) / W, 4), round(min(H - ry, rh) / H, 4)]


def element_around(img_bgr, box, max_area=0.3):
    """Grow a text block to the visual element it labels: pictures/icons directly above or below it
    that line up with it (e.g. photo + label + logos of one column)."""
    H, W = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    bg = float(np.median(gray))
    mask = (np.abs(gray.astype(np.int16) - bg) > 28).astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if w * h > max_area * W * H or w * h < 0.0004 * W * H:
            continue
        if w < 0.012 * W and h > 0.15 * H:          # thin separator lines
            continue
        comps.append((x / W, y / H, w / W, h / H))
    rx, ry, rw, rh = box
    lx0, lx1 = rx, rx + rw                          # the label's columns
    changed = True
    while changed:
        changed = False
        for c in comps:
            cx, cy, cw, ch = c
            inside = cx >= rx - 1e-3 and cy >= ry - 1e-3 and cx + cw <= rx + rw + 1e-3 and cy + ch <= ry + rh + 1e-3
            if inside:
                continue
            ov = min(cx + cw, lx1 + 0.25 * (lx1 - lx0)) - max(cx, lx0 - 0.25 * (lx1 - lx0))
            if ov < 0.5 * cw:                        # must sit in the label's column
                continue
            gap = max(cy - (ry + rh), ry - (cy + ch), 0)
            if gap > 0.05:
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


# ---------------------------------------------------------------- matching speech to slide elements
def _frame(path, t, out):
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(path), "-frames:v", "1",
                        "-y", str(out)], capture_output=True, text=True)
    img = cv2.imread(str(out)) if out.exists() else None
    if img is None:
        raise RuntimeError("Could not read the slide at this moment: " + r.stderr[-200:])
    return img


def slide_elements(img):
    """Text blocks on a slide that could be talked about, each with the element area it belongs to."""
    out = []
    for b in group_blocks([l for l in ocr(img) if l["conf"] >= 0.3]):
        words = content_words(b["text"])
        if not words or len(re.sub(r"[^A-Za-z]", "", b["text"])) < 3:
            continue
        lines_n = max(1, round(b["box"][3] / 0.02))
        if len(words) < 2 and b["box"][3] / lines_n < 0.02:   # tiny single labels = app menus/toolbars, not slide content
            continue
        out.append({"text": b["text"], "words": sorted(words), "label": b["box"], "box": element_around(img, b["box"])})
    return out


def match(sentences, elements, min_score=0.99):
    """For each sentence the element it clearly talks about (or nothing).
    Words that appear in many elements (like "AI" on every card) count less."""
    df = {}
    for e in elements:
        for w in e["words"]:
            df[w] = df.get(w, 0) + 1
    res = []
    for s in sentences:
        sw = content_words(s["text"])
        scored = []
        for i, e in enumerate(elements):
            common = sw & set(e["words"])
            score = sum(1.0 / df[w] for w in common)
            if score > 0:
                scored.append((score, i, common))
        scored.sort(reverse=True)
        if scored and scored[0][0] >= min_score and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.3):
            res.append((s, scored[0][1], scored[0][2]))
    return res


def find(job, words, sents, slide_times, pres_path, offset, start, end, work_dir: Path):
    """Spotlight moments in [start, end] (master seconds)."""
    bounds = [start] + [t for t in slide_times if start + 0.5 < t < end - 0.5] + [end]
    events = []
    for k in range(len(bounds) - 1):
        a, b = bounds[k], bounds[k + 1]
        job.set(0.05 + 0.9 * k / (len(bounds) - 1), f"Reading slide {k + 1} of {len(bounds) - 1}…")
        t_img = a + min(1.0, (b - a) / 2)
        img = _frame(pres_path, t_img + offset, work_dir / f"slide{k}.png")
        elements = slide_elements(img)
        ss = [s for s in sents if s["end"] > a and s["start"] < b]
        for s, i, common in match(ss, elements):
            e = elements[i]
            hit = [w for w in words if s["start"] - 0.01 <= w["start"] <= s["end"] + 0.01 and content_words(w["text"]) & common]
            t0 = max(a, (hit[0]["start"] if hit else s["start"]) - 0.25)
            t1 = min(b, s["end"] + 0.6)
            if events and events[-1]["text"] == e["text"] and t0 - events[-1]["end"] < 2.5:
                events[-1]["end"] = t1           # still talking about the same element
                continue
            lx, ly, lw, lh = e["label"]
            events.append({"start": round(t0, 2), "end": round(t1, 2), "text": e["text"], "box": e["box"],
                           "click": [round(lx + lw / 2, 4), round(ly + lh / 2, 4)], "said": s["text"][:140]})
    return [e for e in events if e["end"] - e["start"] >= 1.2]
