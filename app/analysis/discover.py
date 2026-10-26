"""Clip discovery pipeline: transcript -> sentences -> chunked analysis -> validated, ranked candidates."""
import hashlib
import json
import math
import time
import uuid

from .. import store
from ..config import CACHE, load_settings
from ..jobs import UserError
from . import heuristic, llm
from .text import build_sentences, text_in_range

CHUNK_SEC = 8 * 60      # selectable span per request
CTX_BEFORE = 75         # seconds of context before each chunk
CTX_AFTER = 40


def transcript_cache_path(fp, model):
    return CACHE / "transcripts" / f"{fp}-{model}.json"


def master_words(p: dict) -> list[dict]:
    """Transcript words on the master (speaker) clock."""
    t = p.get("transcript")
    if not t:
        return []
    if t.get("mode") == "segments":  # only the user's chosen minutes were transcribed (already master clock)
        from ..segments import segment_words
        return segment_words(t)
    data = json.loads(transcript_cache_path(t["fp"], t["model"]).read_text())
    shift = -p["sync"]["offset"] if t["audio_role"] == "presentation" else 0.0
    if not shift:
        return data["words"]
    return [{**w, "start": round(w["start"] + shift, 3), "end": round(w["end"] + shift, 3)} for w in data["words"]]


def slide_changes_master(p: dict) -> list[float]:
    pres = p["sources"].get("presentation")
    if not pres or not pres.get("slides"):
        return []
    off = p["sync"]["offset"]
    return [round(t - off, 2) for t in pres["slides"]]


def _overlap(a, b, x, y):
    inter = min(b, y) - max(a, x)
    return inter > 0.5 * min(b - a, y - x)


def run(job, pid: str, params: dict):
    p = store.load(pid)
    words = master_words(p)
    if not words:
        raise UserError("There is no transcript yet. Please run the transcription first.")
    sents = build_sentences(words)
    min_dur = float(params.get("min_dur", 20))
    max_dur = float(params.get("max_dur", 60))
    count = int(params.get("count", 10))
    more = bool(params.get("more"))
    s = load_settings()
    provider = params.get("provider") or s["provider"]
    model = {"anthropic": s["anthropic_model"], "local": s["local_model"]}.get(provider, "rules-v1")

    existing = [c for c in p["candidates"]] if more else []
    avoid_times = [(c["start"], c["end"]) for c in existing]

    # ---- cache: same transcript + provider + settings -> reuse results (not for "more")
    key = hashlib.sha1(json.dumps([p["transcript"]["fp"], p["transcript"]["model"], p["sync"]["offset"]
                                   if p["transcript"]["audio_role"] == "presentation" else 0,
                                   provider, model, min_dur, max_dur, count]).encode()).hexdigest()[:16]
    cache_file = store.project_dir(pid) / f"analysis_{key}.json"
    if not more and cache_file.exists():
        found = json.loads(cache_file.read_text())
        job.set(0.95, "Loaded saved analysis (no need to re-analyse)")
        return _store_candidates(pid, found, sents, words, provider, model, replace=True, cached=True)

    slide_t = slide_changes_master(p)
    slide_marks = set()
    for t in slide_t:
        for x in sents:
            if x["start"] - 0.5 <= t <= x["end"] + 0.5:
                slide_marks.add(x["id"])
                break

    usage_total = {"input_tokens": 0, "output_tokens": 0}
    if provider == "heuristic":
        job.set(0.2, "Scoring every possible clip with the offline rules…")
        exclude = avoid_times
        found = heuristic.find_candidates(sents, words, min_dur, max_dur, count, exclude)
        for c in found:
            c["source"] = "heuristic"
    elif provider in ("anthropic", "local"):
        found = []
        total = sents[-1]["end"]
        nchunks = max(1, math.ceil(total / CHUNK_SEC))
        avoid_ids = [(c["start_id"], c["end_id"]) for c in existing if "start_id" in c]
        for k in range(nchunks):
            a_t, b_t = k * CHUNK_SEC, (k + 1) * CHUNK_SEC
            sel = [x["id"] for x in sents if a_t <= x["start"] < b_t]
            if not sel:
                continue
            sel_a, sel_b = sel[0], sel[-1] + 1
            ctx_a = next((x["id"] for x in sents if x["start"] >= sents[sel_a]["start"] - CTX_BEFORE), sel_a)
            ctx_b = sel_b
            while ctx_b < len(sents) and sents[ctx_b]["end"] <= sents[sel_b - 1]["end"] + CTX_AFTER:
                ctx_b += 1
            share = (min(b_t, total) - a_t) / max(total, 1)  # this chunk's share of the webinar
            want = min(count, max(2, math.ceil(count * share) + 1))
            local_avoid = [(a, b) for a, b in avoid_ids if b >= sel_a and a < sel_b]
            prompt = llm.build_prompt(sents, sel_a, sel_b, ctx_a, ctx_b, min_dur, max_dur, want, local_avoid,
                                      slide_marks)
            job.set(0.05 + 0.85 * k / nchunks,
                    f"AI is reading part {k + 1} of {nchunks} ({provider}: {model})…")
            if provider == "anthropic":
                out, usage = llm.call_anthropic(prompt, model)
            else:
                out, usage = llm.call_local(prompt, s["local_base_url"], model)
            for kk in usage_total:
                usage_total[kk] += usage.get(kk, 0) or 0
            for c in out.get("candidates", []):
                v = _validate(c, sents, sel_a, sel_b, ctx_b, min_dur, max_dur)
                if v:
                    v["source"] = f"{provider}:{model}"
                    found.append(v)
    else:
        raise UserError(f"Unknown AI provider '{provider}'")

    # ---- merge: best first, drop duplicates/overlaps (also with already-shown candidates)
    found.sort(key=lambda c: -c["score"])
    kept = []
    for c in found:
        a, b = sents[c["start_id"]]["start"], sents[c["end_id"]]["end"]
        if any(_overlap(a, b, x, y) for x, y in avoid_times):
            continue
        if any(_overlap(a, b, sents[k["start_id"]]["start"], sents[k["end_id"]]["end"]) for k in kept):
            continue
        kept.append(c)
    kept = kept[:count]
    if not more:
        cache_file.write_text(json.dumps(kept))
    res = _store_candidates(pid, kept, sents, words, provider, model, replace=not more, cached=False)
    res["usage"] = usage_total
    return res


def _validate(c, sents, sel_a, sel_b, ctx_b, min_dur, max_dur):
    try:
        a, b = int(c["start_id"]), int(c["end_id"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (sel_a <= a < sel_b) or not (a <= b < ctx_b):
        return None
    dur = sents[b]["end"] - sents[a]["start"]
    if dur < min_dur * 0.7 or dur > max_dur * 1.3:
        return None
    sc = {k: int(max(1, min(10, int(c.get("scores", {}).get(k, 5))))) for k in heuristic.WEIGHTS}
    return {
        "start_id": a, "end_id": b,
        "topic": str(c.get("topic", ""))[:60] or "general",
        "hook": str(c.get("hook", ""))[:90],
        "hook_kind": "ai_suggested",
        "why": str(c.get("why", ""))[:600],
        "scores": sc, "score": heuristic.total_score(sc),
        "confidence": c.get("confidence") if c.get("confidence") in ("low", "medium", "high") else "low",
        "caveats": [str(x)[:200] for x in (c.get("caveats") or [])][:5],
    }


def _store_candidates(pid, found, sents, words, provider, model, replace, cached):
    now = time.time()
    new = []
    for c in found:
        a, b = sents[c["start_id"]]["start"], sents[c["end_id"]]["end"]
        start, end = max(0.0, round(a - 0.15, 2)), round(b + 0.25, 2)  # small breathing room
        new.append({**c, "id": uuid.uuid4().hex[:8], "start": start, "end": end,
                    "orig_start": start, "orig_end": end, "text": text_in_range(words, start, end),
                    "status": "new", "created": now})

    def apply(p):
        if replace:
            # keep candidates the user already approved; replace the rest
            keep = [c for c in p["candidates"] if c["status"] == "approved"]
            keep_ranges = [(c["start"], c["end"]) for c in keep]
            fresh = [c for c in new if not any(_overlap(c["start"], c["end"], x, y) for x, y in keep_ranges)]
            p["candidates"] = keep + fresh
            added = len(fresh)
        else:
            p["candidates"].extend(new)
            added = len(new)
        p["analysis"] = {"provider": provider, "model": model, "created": now, "cached": cached,
                         "semantic": provider != "heuristic"}
        return added

    n = store.update(pid, apply)
    return {"added": n, "provider": provider, "model": model, "cached": cached}
