"""Offline, free clip finder based on transparent keyword/structure rules.

This is NOT semantic AI. It looks for patterns that often make good short clips
(questions, "the biggest mistake…", practical tips, numbers, stories) and penalises
clips that start mid-thought or reference things the viewer cannot see.
Every score comes with the reasons that produced it, so users can judge it.
"""
import re

from .text import keywords

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


def _hits(patterns, text):
    found = []
    for pat, label in patterns:
        if re.search(pat, text, re.I):
            found.append(label)
    return found


def score_window(sents, words) -> dict:
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
    refs = CONTEXT_REFS.findall(text)
    if refs:
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
    q = text.count("?")
    engagement = 3 + 1.5 * len(story_hits) + min(2, q)
    if story_hits:
        reasons.append("Has " + ", ".join(story_hits))

    def clamp(x):
        return int(round(max(1, min(10, x))))

    scores = {"hook": clamp(hook), "clarity": clamp(clarity), "standalone": clamp(standalone),
              "usefulness": clamp(usefulness), "engagement": clamp(engagement)}
    if not reasons:
        reasons.append("No strong hook or value signals detected")
    return {"scores": scores, "reasons": reasons, "caveats": caveats}


WEIGHTS = {"hook": 0.25, "clarity": 0.15, "standalone": 0.25, "usefulness": 0.2, "engagement": 0.15}


def total_score(scores: dict) -> int:
    return int(round(10 * sum(WEIGHTS[k] * scores.get(k, 5) for k in WEIGHTS)))


def hook_idea(sents) -> str:
    """Pick the punchiest *verbatim* line from the clip (we never invent text in heuristic mode)."""
    best, best_s = sents[0]["text"], -1
    for s in sents:
        t = s["text"].strip()
        n = len(t.split())
        if n < 3 or n > 16:
            continue
        sc = len(_hits(HOOK_PATTERNS, t)) * 2 + (1 if t.endswith("?") else 0) - (2 if CONTEXT_START.match(t) else 0)
        if sc > best_s:
            best, best_s = t, sc
    words = best.split()
    return " ".join(words[:12]) + ("…" if len(words) > 12 else "")


def find_candidates(sents, words, min_dur=20, max_dur=60, count=10, exclude=()):
    """Score every sentence-aligned window with a duration in [min_dur, max_dur]; keep the best non-overlapping."""
    windows = []
    n = len(sents)
    for i in range(n):
        for j in range(i, n):
            dur = sents[j]["end"] - sents[i]["start"]
            if dur > max_dur:
                break
            if dur < min_dur:
                continue
            r = score_window(sents[i:j + 1], words)
            sc = total_score(r["scores"])
            # small bonus for durations in the 25–45 s sweet spot
            if 25 <= dur <= 45:
                sc += 2
            windows.append((sc, i, j, r))
    windows.sort(key=lambda x: -x[0])
    chosen = []
    taken = [(a, b) for a, b in exclude]

    def overlaps(a, b):
        for x, y in taken:
            inter = min(b, y) - max(a, x)
            if inter > 0.3 * min(b - a, y - x):
                return True
        return False

    for sc, i, j, r in windows:
        a, b = sents[i]["start"], sents[j]["end"]
        if overlaps(a, b):
            continue
        taken.append((a, b))
        clip_sents = sents[i:j + 1]
        text = " ".join(s["text"] for s in clip_sents)
        top = r["scores"]
        conf = "medium" if sc >= 65 and top["standalone"] >= 6 else "low"
        chosen.append({
            "start_id": i, "end_id": j,
            "topic": ", ".join(keywords(text, 2)) or "general",
            "hook": hook_idea(clip_sents),
            "hook_kind": "verbatim",
            "why": "; ".join(r["reasons"]) + ".",
            "scores": top, "score": min(100, sc), "confidence": conf, "caveats": r["caveats"],
        })
        if len(chosen) >= count:
            break
    return chosen
