#!/usr/bin/env python3
"""find-clips: find the best short-clip moments in a long talk.

Two modes:
  viral (recommended)  The agent itself (Claude) judges the transcript like a short-form strategist.
                       Step 1 --prompt prints the brief + numbered transcript; the agent answers with JSON;
                       step 2 --import checks that answer against the transcript (whole sentences only,
                       lengths fitted to --min/--max) and returns ready clips. No API key needed.
                       Source: webinar-clip-studio/app/analysis/llm.py (VIRAL_SYSTEM, "Your own AI chat")
                       + discover.py (fit_range, validate_rich).
  rules                Offline keyword/structure rules, instant, no AI (not semantic).
                       Source: webinar-clip-studio/app/analysis/heuristic.py + text.py.

Examples
  python find_clips.py --words w.json --prompt --count 5 --min 20 --max 60 > brief.txt
  python find_clips.py --words w.json --import answer.json --min 20 --max 60 --table
  python find_clips.py --video webinar.mp4 --save-words w.json   # rules mode (transcribes first)
  python find_clips.py --words w.json --ranges-only              # rules → "a-b, c-d"

The last line printed on stdout is JSON (list of clips) unless --prompt, --table or --ranges-only is used.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "lib"))
from words import load_words, transcribe  # noqa: E402


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------- from webinar-clip-studio/app/analysis/text.py ----------

STOP = set("""a an the and or but if then so of to in on at for with from by as is are was were be been being it its
this that these those i you he she we they me him her us them my your our their his hers what which who whom whose
when where why how all any both each few more most other some such no nor not only own same than too very can will
just do does did doing have has had having would could should may might must shall about above after again against
before below between during into through under until up down out off over once here there s t don now ll re ve m d
im it's i'm you're we're they're that's there's let's okay ok yeah um uh like really actually also get got go going
know think one two three thing things lot kind sort way say said see well right want make also much many even still
because thank thanks today everyone people time something anything everything
yang dan di ke dari ini itu untuk dengan ada adalah juga tidak bisa akan kita kamu saya aku jadi kalau atau sudah
mau karena tapi lagi aja nya ya kan sih dong deh banget gitu gimana""".split())


def build_sentences(words, max_words=40, gap=1.2):
    sents, cur = [], []

    def flush():
        if cur:
            sents.append({"id": len(sents), "start": cur[0]["start"], "end": cur[-1]["end"],
                          "text": " ".join(w["text"] for w in cur)})
            cur.clear()

    for w in words:
        if cur and w["start"] - cur[-1]["end"] > gap:
            flush()
        cur.append(w)
        t = w["text"]
        if re.search(r"[.!?…][\"')\]]*$", t):
            flush()
        elif len(cur) >= max_words and re.search(r"[,;:]$", t):
            flush()
        elif len(cur) >= max_words * 1.6:
            flush()
    flush()
    return sents


def keywords(text, n=3):
    toks = re.findall(r"[A-Za-z][A-Za-z'-]{2,}", text.lower())
    c = Counter(t for t in toks if t not in STOP and len(t) > 3)
    return [w for w, _ in c.most_common(n)]


def fmt_time(t):
    t = max(0, t)
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h}:{m:02d}:{s:04.1f}" if h else f"{m}:{s:04.1f}"


# ---------- from webinar-clip-studio/app/analysis/heuristic.py ----------

HOOK_PATTERNS = [
    (r"\?$", "opens with a question"),
    (r"\b(biggest|most common|number one|#1) (mistake|problem|myth|reason|lesson)", "names a big mistake/myth"),
    (r"\b(mistake|myth|secret|truth|surprising|counterintuitive|nobody|most people|everyone thinks)\b", "curiosity/contrast words"),
    (r"\b(here'?s (the thing|why|how|what)|let me (ask|tell|show) you|imagine|what if)\b", "direct hook phrase"),
    (r"\b(never|always|stop|don'?t)\b", "strong statement"),
    (r"\b\d+(\.\d+)?\s?(%|percent|x|times|days|weeks|months|years|minutes)\b", "specific number"),
]
VALUE_PATTERNS = [
    (r"\b(tip|trick|step|strategy|framework|rule|lesson|technique)s?\b", "practical advice"),
    (r"\b(how to|you can|you should|try|instead|use|start|remember|make sure)\b", "actionable language"),
    (r"\b(because|which means|the reason|so that)\b", "explains why"),
    (r"\b\d+(\.\d+)?\s?(%|percent|x|times)\b", "concrete result/statistic"),
]
STORY_PATTERNS = [
    (r"\b(let me tell you|story|one time|when i|i remember|a client|a customer|we worked with|i worked with)\b", "story/example"),
    (r"\b(honestly|i believe|i think the|in my opinion|the truth is)\b", "clear opinion"),
    (r"\b(you|your)\b", "speaks to the viewer"),
]
CONTEXT_START = re.compile(r"^(and|but|so|also|then|which|that|this|it|they|those|these|because|or|like)\b", re.I)
CONTEXT_REFS = re.compile(r"\b(as i (said|mentioned)|like i said|earlier|previous(ly)?|next slide|this slide|"
                          r"on the slide|as you can see|here we (see|have)|this (chart|graph|diagram|picture)|"
                          r"the question was|going back to)\b", re.I)
FILLER = re.compile(r"\b(um+|uh+|erm|you know|kind of|sort of|i mean|basically|like)\b", re.I)
WRAP_UP = re.compile(r"\b(let'?s move|next slide|moving on|any questions|we'?ll come back|before we start|"
                     r"thanks? (you )?for joining|welcome (everyone|back))\b", re.I)
WEIGHTS = {"hook": 0.25, "clarity": 0.15, "standalone": 0.25, "usefulness": 0.2, "engagement": 0.15}


def _hits(patterns, text):
    return [label for pat, label in patterns if re.search(pat, text, re.I)]


def score_window(sents):
    first = sents[0]["text"].strip()
    text = " ".join(s["text"] for s in sents)
    dur = sents[-1]["end"] - sents[0]["start"]
    nwords = len(text.split())
    reasons, caveats = [], []

    hook_hits = _hits(HOOK_PATTERNS, first)
    hook = 3 + 2.2 * len(hook_hits) + (1 if len(first.split()) <= 14 else 0)
    if hook_hits:
        reasons.append("First line " + ", ".join(hook_hits))

    fillers = len(FILLER.findall(text))
    filler_rate = fillers / max(nwords, 1)
    wps = nwords / max(dur, 1)
    clarity = 8 - min(5, filler_rate * 60) - (2 if wps < 1.6 or wps > 4.2 else 0)
    if filler_rate > 0.03:
        caveats.append(f"Contains filler words ({fillers}) — may feel slow")

    standalone = 8
    if CONTEXT_START.match(first):
        standalone -= 3
        caveats.append(f"Starts with “{first.split()[0]}” — may depend on what came before")
    if CONTEXT_REFS.findall(text):
        standalone -= 2
        caveats.append("Refers to a slide or earlier part — keep the presentation visible or trim")
    if WRAP_UP.search(text):
        standalone -= 2.5
        caveats.append("Includes housekeeping/transition talk (e.g. ‘next slide’)")
    if not re.search(r"[.!?]$", sents[-1]["text"].strip()):
        standalone -= 2
        caveats.append("May end mid-sentence")

    value_hits = _hits(VALUE_PATTERNS, text)
    usefulness = 3 + 1.6 * len(value_hits)
    if value_hits:
        reasons.append("Contains " + ", ".join(value_hits))

    story_hits = _hits(STORY_PATTERNS, text)
    engagement = 3 + 1.5 * len(story_hits) + min(2, text.count("?"))
    if story_hits:
        reasons.append("Has " + ", ".join(story_hits))

    def clamp(x):
        return int(round(max(1, min(10, x))))

    scores = {"hook": clamp(hook), "clarity": clamp(clarity), "standalone": clamp(standalone),
              "usefulness": clamp(usefulness), "engagement": clamp(engagement)}
    if not reasons:
        reasons.append("No strong hook or value signals detected")
    return {"scores": scores, "reasons": reasons, "caveats": caveats}


def total_score(scores):
    return int(round(10 * sum(WEIGHTS[k] * scores.get(k, 5) for k in WEIGHTS)))


def hook_idea(sents):
    """The punchiest *verbatim* line from the clip (never invented)."""
    best, best_s = sents[0]["text"], -1
    for s in sents:
        t = s["text"].strip()
        n = len(t.split())
        if n < 3 or n > 16:
            continue
        sc = len(_hits(HOOK_PATTERNS, t)) * 2 + (1 if t.endswith("?") else 0) - (2 if CONTEXT_START.match(t) else 0)
        if sc > best_s:
            best, best_s = t, sc
    w = best.split()
    return " ".join(w[:12]) + ("…" if len(w) > 12 else "")


def find_candidates(sents, min_dur=20, max_dur=60, count=10):
    """Score every sentence-aligned window in [min_dur, max_dur]; keep the best non-overlapping ones."""
    windows = []
    for i in range(len(sents)):
        for j in range(i, len(sents)):
            dur = sents[j]["end"] - sents[i]["start"]
            if dur > max_dur:
                break
            if dur < min_dur:
                continue
            r = score_window(sents[i:j + 1])
            sc = total_score(r["scores"]) + (2 if 25 <= dur <= 45 else 0)
            windows.append((sc, i, j, r))
    windows.sort(key=lambda x: -x[0])
    chosen, taken = [], []

    def overlaps(a, b):
        return any(min(b, y) - max(a, x) > 0.3 * min(b - a, y - x) for x, y in taken)

    for sc, i, j, r in windows:
        a, b = sents[i]["start"], sents[j]["end"]
        if overlaps(a, b):
            continue
        taken.append((a, b))
        clip = sents[i:j + 1]
        text = " ".join(s["text"] for s in clip)
        top = r["scores"]
        chosen.append({
            "rank": len(chosen) + 1,
            "start": round(a, 2), "end": round(b, 2), "duration": round(b - a, 1),
            "label": f"{fmt_time(a)} – {fmt_time(b)}",
            "topic": ", ".join(keywords(text, 2)) or "general",
            "hook": hook_idea(clip), "hook_kind": "verbatim",
            "score": min(100, sc), "scores": top,
            "confidence": "medium" if sc >= 65 and top["standalone"] >= 6 else "low",
            "why": "; ".join(r["reasons"]) + ".", "caveats": r["caveats"],
            "text": text,
        })
        if len(chosen) >= count:
            break
    return chosen


# ---------- viral mode: from webinar-clip-studio/app/analysis/llm.py + discover.py ----------

VIRAL_SYSTEM = """You are a senior short-form video strategist for TikTok, Instagram Reels and YouTube Shorts. \
You read a full transcript and pick the moments with the highest potential to perform on social media \
as standalone clips.

What makes a strong clip: a hook in the first seconds (a bold claim, a surprising analogy, a relatable problem, \
a question); one clear idea that a brand-new viewer understands without the rest of the video; memorable \
analogies and stories; practical, actionable takeaways; a satisfying ending (the idea lands). Prefer the moments \
people would share, save or comment on. Avoid housekeeping, slide navigation, long setups and answers that depend \
on earlier context.

Rules:
- Choose clips ONLY by sentence ID (start_id..end_id, inclusive). Never rewrite or invent the speaker's words.
- key_start_id..key_end_id = the single most quotable sentence(s) inside the clip (the "money line").
- title = a short theme name for the clip, like a chapter title.
- hook = on-screen text for the first 3 seconds (max 12 words). caption = a ready-to-post caption or \
text-on-screen line. Both must be faithful to what is said: no invented numbers, facts or quotes.
- why = 1–3 sentences: why this works as a Reel and who it is for.
- editing_tips = 1–3 concrete tips for this clip (e.g. what visual to show when the speaker mentions something).
- viral = "very_high" only for the best 1–2 clips, otherwise "high" or "medium". It is an honest judgement, \
not a promise.
- scores = honest 1–10 judgements; caveats = real weaknesses (e.g. "refers to the slide", "slow start").
- LENGTH IS A HARD RULE: every clip's duration (end time of end_id minus start time of start_id) must be inside \
the requested range. Check it with the timestamps. If a great moment is longer, choose the strongest part of it \
that fits; if it is shorter, include the sentences around it.
- Rank from best to worst. Prefer fewer, excellent clips over many weak ones."""

EXAMPLE = {"candidates": [{
    "start_id": 120, "end_id": 127, "duration_seconds": 0, "key_start_id": 121, "key_end_id": 122,
    "title": "Analogy: AI is an intern", "topic": "AI basics", "viral": "very_high",
    "hook": "Why your AI results are still bad", "caption": "Treat AI like a smart intern who needs direction.",
    "why": "A simple, relatable analogy that explains a common frustration.",
    "editing_tips": ["Show AI logos when he lists ChatGPT, Gemini and Claude"],
    "scores": {"hook": 9, "clarity": 8, "standalone": 9, "usefulness": 8, "engagement": 9},
    "confidence": "high", "caveats": []}]}

LANG_NAMES = {"en": "English", "id": "Indonesian (Bahasa Indonesia)"}
VIRAL_BONUS = {"very_high": 8, "high": 4, "medium": 0}
PAD = 0.4  # breathing room around a stored clip (0.15 s before + 0.25 s after)


def viral_prompt(sents, min_dur, max_dur, count, write_in="en", avoid=(), extra=""):
    lo, hi = int(min_dur), int(max_dur)
    lang = LANG_NAMES.get(write_in, write_in)
    task = (f"Pick the {count} best clips for social media from the whole transcript below — {count} clips, "
            f"each about a different moment.\n"
            f"CLIP LENGTH: every clip must be {lo} to {hi} seconds long. Aim for about "
            f"{round(lo + (hi - lo) * 0.7)} seconds: use the whole idea with its setup and payoff. Measure it with "
            f"the timestamps (end of the last sentence minus start of the first).\n"
            f"Write title, hook, caption, why, editing_tips and caveats in {lang}.")
    if avoid:
        task += " These ranges were already used — pick DIFFERENT moments: " + ", ".join(f"S{a}–S{b}" for a, b in avoid) + "."
    if extra:
        task += "\nEXTRA WISHES FROM THE USER: " + extra
    body = "TRANSCRIPT (each line: [S<id> start–end] text):\n" + "\n".join(
        f"[S{s['id']} {fmt_time(s['start'])}–{fmt_time(s['end'])}] {s['text']}" for s in sents)
    return (VIRAL_SYSTEM + "\n\n" + task + "\n\n"
            "ANSWER FORMAT: ONLY one JSON object like this example (fields of ONE clip; content made up):\n"
            + json.dumps(EXAMPLE, ensure_ascii=False, indent=1) + "\n"
            "viral is one of very_high, high, medium; confidence one of low, medium, high. "
            f"duration_seconds = the real length from the timestamps ({lo}–{hi}).\n\n" + body)


def parse_answer(text):
    """Read the JSON answer (tolerates code fences, extra text, smart quotes)."""
    t = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, re.S)
    raw = m.group(1) if m else (t[t.find("{"): t.rfind("}") + 1] if "{" in t else "")
    data = None
    for attempt in (t, raw, raw.replace("“", '"').replace("”", '"').replace("’", "'")):
        try:
            data = json.loads(attempt)
            break
        except json.JSONDecodeError:
            pass
    if isinstance(data, list):
        data = {"candidates": data}
    if not data or not isinstance(data.get("candidates"), list):
        sys.exit("The answer is not valid JSON with a \"candidates\" list.")
    return data


def fit_range(sents, a, b, ka, kb, min_dur, max_dur):
    """Adjust a sentence range (whole sentences only) to min_dur..max_dur, keeping the key sentence(s)."""
    lo, hi = min_dur, max_dur - PAD
    dur = lambda i, j: sents[j]["end"] - sents[i]["start"]  # noqa: E731
    if lo <= dur(a, b) <= hi:
        return a, b
    n = len(sents)
    i, j = ka, kb
    while j > i and dur(i, j) > hi:
        j -= 1
    inside = dur(a, b) > hi
    left_lim, right_lim = (a, b) if inside else (0, n - 1)
    while True:
        opts = []
        if j + 1 <= right_lim and dur(i, j + 1) <= hi:
            opts.append((i, j + 1))
        if i - 1 >= left_lim and dur(i - 1, j) <= hi:
            opts.append((i - 1, j))
        if not opts or (not inside and dur(i, j) >= lo):
            break
        opts.sort(key=lambda r: (not (a <= r[0] and r[1] <= b), r[0] != i))
        i, j = opts[0]
    return i, j


def validate_rich(c, sents, min_dur, max_dur, rank=0):
    """Check one suggestion against our own transcript; returns a clip or None."""
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
    note = None
    if not (min_dur - 0.5 <= new <= max_dur + 0.5):
        note = f"{round(new)} s — couldn't fit {int(min_dur)}–{int(max_dur)} s with whole sentences here."
    elif abs(new - orig) > 1:
        note = f"Length adjusted from {round(orig)} s to {round(new)} s to fit {int(min_dur)}–{int(max_dur)} s."
    sc = {k: int(max(1, min(10, int((c.get("scores") or {}).get(k, 6))))) for k in WEIGHTS}
    viral = c.get("viral") if c.get("viral") in VIRAL_BONUS else "medium"
    tips = c.get("editing_tips") or []
    tips = [tips] if isinstance(tips, str) else tips
    start, end = max(0.0, sents[a]["start"] - 0.15), sents[b]["end"] + 0.25
    return {
        "rank": rank, "start": round(start, 2), "end": round(end, 2), "duration": round(end - start, 1),
        "label": f"{fmt_time(start)} – {fmt_time(end)}", "start_id": a, "end_id": b,
        "title": str(c.get("title", ""))[:90], "topic": str(c.get("topic", "") or c.get("title", ""))[:60] or "general",
        "viral": viral, "hook": str(c.get("hook", ""))[:120], "hook_kind": "ai_suggested",
        "caption": str(c.get("caption", ""))[:300], "why": str(c.get("why", ""))[:700],
        "tips": [str(x)[:200] for x in tips][:4], "scores": sc,
        "score": min(100, total_score(sc) + VIRAL_BONUS[viral]),
        "confidence": c.get("confidence") if c.get("confidence") in ("low", "medium", "high") else "medium",
        "caveats": ([note] if note else []) + [str(x)[:200] for x in (c.get("caveats") or [])][:5],
        "key_line": " ".join(s["text"] for s in sents[ka:kb + 1]),
        "text": " ".join(s["text"] for s in sents[a:b + 1]),
    }


# ---------- CLI ----------

def main():
    ap = argparse.ArgumentParser(description="Find the best short-clip moments in a long talk (offline rules).")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--words", help="word-timed transcript JSON")
    src.add_argument("--video", help="video/audio file to transcribe first (faster-whisper, local)")
    ap.add_argument("--min", type=float, default=20, help="shortest clip, seconds (default 20)")
    ap.add_argument("--max", type=float, default=60, help="longest clip, seconds (default 60)")
    ap.add_argument("--count", type=int, default=10, help="how many clips (default 10)")
    ap.add_argument("--language", help="speech language for transcription, e.g. en, id")
    ap.add_argument("--model", default="small", help="faster-whisper model (default small)")
    ap.add_argument("--save-words", help="also save the transcript here (when using --video)")
    ap.add_argument("-o", "--out", help="write the clips JSON (or the --prompt text) to this file too")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--prompt", action="store_true", help="viral mode step 1: print the brief + numbered transcript")
    mode.add_argument("--import", dest="answer", help="viral mode step 2: JSON answer file to check and turn into clips")
    ap.add_argument("--write-in", default="en", help="viral mode: language for title/hook/caption (en, id, …)")
    ap.add_argument("--wishes", default="", help='viral mode: extra wishes, e.g. "for small business owners, funny moments"')
    ap.add_argument("--avoid", default="", help='viral mode: sentence ranges already used, e.g. "12-18, 40-47"')
    view = ap.add_mutually_exclusive_group()
    view.add_argument("--table", action="store_true", help="print a readable table instead of JSON")
    view.add_argument("--ranges-only", action="store_true", help='print only "a-b, c-d" (seconds)')
    a = ap.parse_args()

    for f in (a.words, a.video, a.answer):
        if f and not os.path.isfile(f):
            sys.exit(f"File not found: {f}")
    if a.words:
        words = load_words(a.words)
    else:
        words, lang = transcribe(a.video, a.model, a.language, log)
        if a.save_words:
            with open(a.save_words, "w") as f:
                json.dump({"language": lang, "words": words}, f, ensure_ascii=False)
    if not words:
        sys.exit("The transcript has no words.")
    sents = build_sentences(words)
    if a.prompt:
        avoid = [tuple(int(x) for x in r.split("-")) for r in a.avoid.replace(" ", "").split(",") if r]
        text = viral_prompt(sents, a.min, a.max, a.count, a.write_in, avoid, a.wishes)
        if a.out:
            with open(a.out, "w", encoding="utf-8") as f:
                f.write(text)
            log(f"Brief written to {a.out} ({len(sents)} sentences, {len(text)} characters).")
        else:
            print(text)
        return
    if a.answer:
        data = parse_answer(open(a.answer, encoding="utf-8").read())
        found, seen = [], set()
        for rank, c in enumerate(data["candidates"], 1):
            v = validate_rich(c, sents, a.min, a.max, rank) if isinstance(c, dict) else None
            if v and (v["start_id"], v["end_id"]) not in seen:
                seen.add((v["start_id"], v["end_id"]))
                found.append(v)
        skipped = len(data["candidates"]) - len(found)
        if not found:
            sys.exit("None of the suggested clips fit this transcript (wrong sentence numbers?). "
                     "Make sure the answer was written for the --prompt of THIS transcript.")
        if skipped:
            log(f"{skipped} suggestion(s) skipped (invalid sentence numbers or duplicates).")
        clips = sorted(found, key=lambda c: (-c["score"], c["rank"]))
        for i, c in enumerate(clips, 1):
            c["rank"] = i
    else:
        clips = find_candidates(sents, a.min, a.max, a.count)
    if a.out:
        with open(a.out, "w") as f:
            json.dump(clips, f, ensure_ascii=False, indent=2)
    if not clips:
        log(f"No sentence-aligned window between {a.min:g} and {a.max:g} s. Try a wider --min/--max.")
    if a.ranges_only:
        print(", ".join(f"{c['start']}-{c['end']}" for c in clips))
    elif a.table:
        for c in clips:
            viral = f"  viral: {c['viral']}" if "viral" in c else ""
            print(f"#{c['rank']:<2} {c['label']:<20} {c['duration']:>5.1f}s  score {c['score']:>3} ({c['confidence']}){viral}")
            if c.get("title"):
                print(f"    title:   {c['title']}")
            print(f"    hook:    {c['hook']}")
            if c.get("caption"):
                print(f"    caption: {c['caption']}")
            print(f"    why:     {c['why']}")
            for tip in c.get("tips", []):
                print(f"    tip:     {tip}")
            for cv in c["caveats"]:
                print(f"    !     {cv}")
    else:
        print(json.dumps(clips, ensure_ascii=False))


if __name__ == "__main__":
    main()
