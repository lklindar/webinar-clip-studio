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
                                   provider, model, min_dur, max_dur, count, "en",
                                   "v2"]).encode()).hexdigest()[:16]
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
    elif provider == "anthropic" and llm.estimate(sents, model, 1)["input_tokens"] < 600_000:
        # like asking Gemini about the whole video: one request, global ranking, rich fields
        avoid_ids = [(c["start_id"], c["end_id"]) for c in existing if "start_id" in c]
        prompt = llm.build_global_prompt(sents, min_dur, max_dur, count, avoid_ids, slide_marks,
                                         "en")
        job.set(0.15, f"Claude is reading the whole webinar ({model})… this takes about a minute")
        out, usage_total = llm.call_anthropic_rich(prompt, model)
        found = []
        for rank, c in enumerate(out.get("candidates", [])):
            v = validate_rich(c, sents, min_dur, max_dur, rank)
            if v:
                v["source"] = f"anthropic:{model}"
                found.append(v)
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
    elif provider == "chat":
        raise UserError("“Your AI chat” works by copy & paste: in step 3, copy the request, paste it into your AI chat, "
                        "then paste the answer back.")
    else:
        raise UserError(f"Unknown AI provider '{provider}'")

    # ---- merge: best first, drop duplicates/overlaps (also with already-shown candidates)
    found.sort(key=lambda c: (-c["score"], c.get("rank", 0)))
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
        "caveats": ([len_note] if len_note else []) + [str(x)[:200] for x in (c.get("caveats") or [])][:5],
    }


VIRAL_BONUS = {"very_high": 8, "high": 4, "medium": 0}
PAD = 0.4   # breathing room added around a clip when it is stored (0.15 s before + 0.25 s after)


def fit_range(sents, a, b, ka, kb, min_dur, max_dur):
    """Adjust a sentence range (whole sentences only) so the final clip is min_dur..max_dur long.
    Keeps the key sentence(s); stays inside the AI's chosen range when shortening and grows into
    the neighbouring sentences when lengthening."""
    lo, hi = min_dur, max_dur - PAD
    dur = lambda i, j: sents[j]["end"] - sents[i]["start"]
    if lo <= dur(a, b) <= hi:
        return a, b
    n = len(sents)
    i, j = ka, kb
    while j > i and dur(i, j) > hi:          # the key part alone is too long: keep its beginning
        j -= 1
    inside = dur(a, b) > hi                  # shortening: only use sentences the AI picked
    left_lim, right_lim = (a, b) if inside else (0, n - 1)
    while True:
        opts = []
        if j + 1 <= right_lim and dur(i, j + 1) <= hi:
            opts.append((i, j + 1))
        if i - 1 >= left_lim and dur(i - 1, j) <= hi:
            opts.append((i - 1, j))
        if not opts or (not inside and dur(i, j) >= lo):
            break
        # prefer the side that stays inside the AI's range, then continuing forward
        opts.sort(key=lambda r: (not (a <= r[0] and r[1] <= b), r[0] != i))
        i, j = opts[0]
    return i, j


def validate_rich(c, sents, min_dur, max_dur, rank=0, strict_len=True):
    """Check one rich suggestion (from Claude or a pasted AI-chat answer) against our own transcript."""
    n = len(sents)
    try:
        a, b = int(c["start_id"]), int(c["end_id"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (0 <= a <= b < n):
        return None
    try:
        ka, kb = int(c.get("key_start_id", a)), int(c.get("key_end_id", c.get("key_start_id", a)))
    except (TypeError, ValueError):
        ka, kb = a, a
    ka, kb = max(a, min(ka, b)), max(a, min(max(kb, ka), b))
    orig = sents[b]["end"] - sents[a]["start"] + PAD
    a, b = fit_range(sents, a, b, ka, kb, min_dur, max_dur)
    ka, kb = max(a, min(ka, b)), max(a, min(kb, b))
    new = sents[b]["end"] - sents[a]["start"] + PAD
    len_note = None
    if not (min_dur - 0.5 <= new <= max_dur + 0.5):
        len_note = (f"{round(new)} s — couldn't fit {int(min_dur)}–{int(max_dur)} s with whole sentences here. "
                    "Adjust Start/End below.")
    elif abs(new - orig) > 1:
        len_note = f"Length adjusted from {round(orig)} s to {round(new)} s to fit {int(min_dur)}–{int(max_dur)} s."
    sc = {k: int(max(1, min(10, int((c.get("scores") or {}).get(k, 6))))) for k in heuristic.WEIGHTS}
    viral = c.get("viral") if c.get("viral") in VIRAL_BONUS else "medium"
    tips = c.get("editing_tips") or []
    if isinstance(tips, str):
        tips = [tips]
    return {
        "start_id": a, "end_id": b, "key_start_id": ka, "key_end_id": kb, "rank": rank,
        "title": str(c.get("title", ""))[:90], "topic": str(c.get("topic", "") or c.get("title", ""))[:60] or "general",
        "viral": viral, "hook": str(c.get("hook", ""))[:120], "hook_kind": "ai_suggested",
        "caption": str(c.get("caption", ""))[:300], "why": str(c.get("why", ""))[:700],
        "tips": [str(x)[:200] for x in tips][:4],
        "scores": sc, "score": min(100, heuristic.total_score(sc) + VIRAL_BONUS[viral]),
        "confidence": c.get("confidence") if c.get("confidence") in ("low", "medium", "high") else "medium",
        "caveats": ([len_note] if len_note else []) + [str(x)[:200] for x in (c.get("caveats") or [])][:5],
    }


def _sentences_marks(p, sents):
    marks = set()
    for t in slide_changes_master(p):
        for x in sents:
            if x["start"] - 0.5 <= t <= x["end"] + 0.5:
                marks.add(x["id"])
                break
    return marks


def chat_prompt(pid, params):
    """The self-contained prompt to paste into Gemini / ChatGPT (whole transcript + answer format)."""
    p = store.load(pid)
    words = master_words(p)
    if not words:
        raise UserError("There is no transcript yet. Transcribe the webinar first.")
    sents = build_sentences(words)
    existing = p["candidates"] if params.get("more") else []
    avoid = [(c["start_id"], c["end_id"]) for c in existing if "start_id" in c]
    text = llm.build_global_prompt(sents, float(params.get("min_dur", 30)), float(params.get("max_dur", 180)),
                                   int(params.get("count", 8)), avoid, _sentences_marks(p, sents),
                                   "en", for_chat=True)
    return {"prompt": text, "sentences": len(sents), "chars": len(text)}


def import_chat(pid, text, params):
    """Turn a pasted AI-chat answer into clip suggestions (validated against our own transcript)."""
    p = store.load(pid)
    words = master_words(p)
    if not words:
        raise UserError("There is no transcript yet. Transcribe the webinar first.")
    sents = build_sentences(words)
    data = llm.parse_chat_answer(text)
    min_dur, max_dur = float(params.get("min_dur", 30)), float(params.get("max_dur", 180))
    more = bool(params.get("more"))
    found, skipped = [], 0
    for rank, c in enumerate(data["candidates"]):
        v = validate_rich(c, sents, min_dur, max_dur, rank, strict_len=False) if isinstance(c, dict) else None
        if v:
            v["source"] = "chat:" + str(params.get("ai_name") or "your AI chat")[:30]
            found.append(v)
        else:
            skipped += 1
    if not found:
        raise UserError("None of the suggested clips could be used — the sentence numbers don't fit this "
                        "transcript or the lengths are far outside the chosen range. Make sure you pasted the "
                        "answer to the prompt copied from THIS project.")
    # The user chose what to paste, so keep every valid clip (even overlapping ones);
    # only skip exact repeats of the same sentence range.
    existing = {(c.get("start_id"), c.get("end_id")) for c in p["candidates"]
                if more or c["status"] == "approved"}
    found.sort(key=lambda c: (-c["score"], c["rank"]))
    kept, seen = [], set(existing)
    for c in found:
        key = (c["start_id"], c["end_id"])
        if key in seen:
            continue
        seen.add(key)
        kept.append(c)
    res = _store_candidates(pid, kept, sents, words, "chat", str(params.get("ai_name") or "your AI chat"),
                            replace=not more, cached=False, dedupe_approved=False)
    res["skipped"] = skipped + (len(found) - len(kept))
    res["received"] = len(data["candidates"])
    return res


def _store_candidates(pid, found, sents, words, provider, model, replace, cached, dedupe_approved=True):
    now = time.time()
    new = []
    for c in found:
        a, b = sents[c["start_id"]]["start"], sents[c["end_id"]]["end"]
        start, end = max(0.0, round(a - 0.15, 2)), round(b + 0.25, 2)  # small breathing room
        extra = {}
        if "key_start_id" in c:   # the "money line" — always the speaker's exact words from our transcript
            ks, ke = sents[c["key_start_id"]]["start"], sents[c["key_end_id"]]["end"]
            extra = {"key_text": text_in_range(words, ks - 0.01, ke + 0.01), "key_start": ks, "key_end": ke}
        new.append({**c, **extra, "id": uuid.uuid4().hex[:8], "start": start, "end": end,
                    "orig_start": start, "orig_end": end, "text": text_in_range(words, start, end),
                    "status": "new", "created": now})

    def apply(p):
        if replace:
            # keep candidates the user already approved; replace the rest
            keep = [c for c in p["candidates"] if c["status"] == "approved"]
            keep_ranges = [(c["start"], c["end"]) for c in keep]
            fresh = [c for c in new if not dedupe_approved
                     or not any(_overlap(c["start"], c["end"], x, y) for x, y in keep_ranges)]
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
