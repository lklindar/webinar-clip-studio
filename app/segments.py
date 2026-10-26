"""Transcribe only selected time ranges (manual clip picking).

Instead of transcribing a whole 60-minute webinar, only the minutes the user picked
(plus a little padding) are extracted with ffmpeg and transcribed. Results are stored as
non-overlapping "covered" intervals on the master (speaker) clock:
    project["transcript"] = {"mode": "segments", "fp", "model", "audio_role", "offset",
                             "segments": [{"start", "end", "file"}], ...}
Later requests only transcribe the parts that are not covered yet.
"""
import json
import subprocess
import tempfile
import time
from pathlib import Path

from . import store
from .config import CACHE, PYTHON
from .jobs import UserError, manager

PAD = 1.5      # seconds of extra audio on each side (context for the speech model)
MARGIN = 0.5   # requested range is widened by this much


def _covered(t: dict) -> list[tuple[float, float]]:
    if not t:
        return []
    if t.get("mode") != "segments":
        return [(float("-inf"), float("inf"))]
    return sorted((s["start"], s["end"]) for s in t["segments"])


def _subtract(a: float, b: float, covered) -> list[tuple[float, float]]:
    gaps, cur = [], a
    for x, y in covered:
        if y <= cur or x >= b:
            continue
        if x > cur:
            gaps.append((cur, x))
        cur = max(cur, y)
    if cur < b:
        gaps.append((cur, b))
    return [(x, y) for x, y in gaps if y - x >= 0.3]


def _usable(p: dict, model: str) -> dict | None:
    """The existing transcript if it matches the current audio settings, else None."""
    t = p.get("transcript")
    role = p["sync"]["audio"]
    src = p["sources"].get(role)
    if not t or not src or t["fp"] != src["fp"] or t["audio_role"] != role:
        return None
    if t.get("mode") == "segments":
        if t["model"] != model:
            return None
        if role == "presentation" and abs(t.get("offset", 0) - p["sync"]["offset"]) > 1e-3:
            return None
    return t


def missing_ranges(p: dict, ranges, model: str):
    t = _usable(p, model)
    cov = _covered(t)
    out = []
    for a, b in ranges:
        out.extend(_subtract(max(0.0, a - MARGIN), b + MARGIN, cov))
    return out


def queue(pid: str, ranges, model: str, language: str = ""):
    """Queue transcription of the not-yet-covered parts of `ranges` (master seconds). Returns a job or None."""
    p = store.load(pid)
    role = p["sync"]["audio"]
    src = p["sources"].get(role)
    if not src or not src.get("has_audio"):
        raise UserError(f"The {role} recording has no audio, so subtitles cannot be generated. "
                        "Choose the other recording as audio source in step 2.")
    if not missing_ranges(p, ranges, model):
        return None

    def work(job):
        pp = store.load(pid)
        src2 = pp["sources"][role]
        off = pp["sync"]["offset"] if role == "presentation" else 0.0
        gaps = missing_ranges(pp, ranges, model)
        new_segs = []
        language_found = None
        with tempfile.TemporaryDirectory(dir=CACHE / "audio") as td:
            batch = []
            for i, (a, b) in enumerate(gaps):
                s0 = max(0.0, a - PAD)
                dur = (b + PAD) - s0
                job.set(0.02 * i / len(gaps), f"Reading audio for clip {i + 1} of {len(gaps)}…")
                pcm, out = Path(td) / f"seg{i}.f32", Path(td) / f"seg{i}.json"
                from .keep import resolve
                path, local = resolve(pid, src2, s0 + off, s0 + off + dur, role)
                r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{max(0, local):.3f}", "-t", f"{dur:.3f}",
                                    "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "f32le",
                                    str(pcm)], capture_output=True, text=True)
                if r.returncode != 0 or not pcm.exists() or pcm.stat().st_size == 0:
                    raise UserError(f"Could not read audio at {int(a // 60)}:{int(a % 60):02d}. "
                                    f"Is this time inside the recording? {r.stderr[-200:]}")
                batch.append({"pcm": str(pcm), "out": str(out), "a": a, "b": b, "s0": s0})
            jobs_file = Path(td) / "jobs.json"
            jobs_file.write_text(json.dumps(batch))
            # one worker process: the speech model is loaded only once for all clips
            job.run_worker([PYTHON, "-m", "app.workers.transcribe", "--batch", str(jobs_file), model, language or ""],
                           0.03, 0.98)
            for it in batch:
                a, b, s0 = it["a"], it["b"], it["s0"]
                data = json.loads(Path(it["out"]).read_text())
                language_found = language_found or data.get("language")
                words = []
                for w in data["words"]:
                    ws, we = round(w["start"] + s0, 3), round(w["end"] + s0, 3)
                    if a <= (ws + we) / 2 < b:  # keep each word in exactly one segment
                        words.append({**w, "start": ws, "end": we})
                f = CACHE / "transcripts" / f"{src2['fp']}-{model}-seg-{a:.2f}-{b:.2f}.json"
                f.write_text(json.dumps({"words": words, "language": data.get("language")}))
                new_segs.append({"start": round(a, 3), "end": round(b, 3), "file": f.name})

        def apply(x):
            t = _usable(x, model)
            if not t or t.get("mode") != "segments":
                t = {"mode": "segments", "fp": src2["fp"], "model": model, "audio_role": role,
                     "offset": x["sync"]["offset"], "segments": [], "language": None, "words_count": 0}
            t["segments"] = sorted(t["segments"] + new_segs, key=lambda s: s["start"])
            t["language"] = t.get("language") or language_found
            t["words_count"] = sum(len(json.loads((CACHE / "transcripts" / s["file"]).read_text())["words"])
                                   for s in t["segments"])
            t["created"] = time.time()
            x["transcript"] = t
            # refresh clip texts shown in the clip list
        store.update(pid, apply)
        from .analysis.discover import master_words
        from .analysis.text import text_in_range
        pp = store.load(pid)
        mw = master_words(pp)

        def apply_text(x):
            for c in x["candidates"]:
                c["text"] = text_in_range(mw, c["start"], c["end"])
        store.update(pid, apply_text)
        job.message = "Subtitles ready"
        return {"segments": len(new_segs)}

    return manager.submit("subtitles", pid, "ai", work, "Transcribing your clips")


def segment_words(t: dict) -> list[dict]:
    words = []
    for s in t["segments"]:
        f = CACHE / "transcripts" / s["file"]
        if f.exists():
            words.extend(json.loads(f.read_text())["words"])
    return sorted(words, key=lambda w: w["start"])
