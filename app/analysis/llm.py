"""Semantic clip selection with an LLM.

Providers:
  anthropic  Claude API (paid, needs an API key; transcript TEXT is sent to Anthropic — never video/audio)
  local      Any OpenAI-compatible local server (Ollama, LM Studio). Free and private, needs a separate install.

The model only returns sentence IDs + its assessment. The clip text itself always comes
from our own transcript, so the model cannot put invented words into the speaker's mouth.
"""
import json
import os
import re
import urllib.error
import urllib.request

from ..config import get_secret, load_settings
from ..jobs import UserError
from .text import fmt_time

# $ per million tokens (input, output) — used only for the cost estimate shown to the user.
PRICES = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-fable-5-1": (10.0, 50.0),
}
ANTHROPIC_MODELS = list(PRICES)

SYSTEM = """You are an experienced short-form video editor. You review webinar transcripts and pick excerpts \
that can work as standalone vertical videos (TikTok, Reels, Shorts).

Look for: strong opening hooks and curiosity gaps; surprising, counterintuitive or thought-provoking statements; \
practical, actionable advice; strong opinions, relatable problems, common mistakes; compelling stories, memorable \
examples, interesting questions with clear answers; anything a brand-new viewer can understand without the rest of \
the webinar.

Avoid: repetitive or dull passages; housekeeping ("next slide", "any questions"); excerpts that start mid-thought \
or end abruptly; excerpts that depend on missing context; edits whose meaning differs from what the speaker meant.

Rules:
- Select excerpts ONLY by sentence ID (start_id..end_id inclusive) from the SELECTABLE section. Never rewrite the \
speaker's words.
- `hook` is YOUR suggested on-screen title text (max 10 words). It must be faithful to the excerpt, must not \
invent facts, numbers or quotes, and must not claim the speaker said something they did not.
- Scores are honest 1–10 judgements; most excerpts should land between 4 and 7. Reserve 9–10 for exceptional \
moments. Do not promise virality.
- `caveats` lists real weaknesses (e.g. "refers to a chart on the slide", "ends slightly abruptly").
- Respect the requested duration range. Prefer fewer, better excerpts over many weak ones. Return an empty list \
if nothing is good enough."""

SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_id": {"type": "integer"},
                    "end_id": {"type": "integer"},
                    "topic": {"type": "string"},
                    "hook": {"type": "string"},
                    "why": {"type": "string"},
                    "scores": {
                        "type": "object",
                        "properties": {k: {"type": "integer"} for k in
                                       ("hook", "clarity", "standalone", "usefulness", "engagement")},
                        "required": ["hook", "clarity", "standalone", "usefulness", "engagement"],
                        "additionalProperties": False,
                    },
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                    "caveats": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["start_id", "end_id", "topic", "hook", "why", "scores", "confidence", "caveats"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["candidates"],
    "additionalProperties": False,
}


def build_prompt(sents, sel_a, sel_b, ctx_a, ctx_b, min_dur, max_dur, want, avoid, slide_marks):
    def line(s):
        mark = " [slide changes here]" if s["id"] in slide_marks else ""
        return f"[S{s['id']} {fmt_time(s['start'])}–{fmt_time(s['end'])}]{mark} {s['text']}"

    parts = []
    if ctx_a < sel_a:
        parts.append("CONTEXT BEFORE (for understanding only — do not select):\n" +
                     "\n".join(line(s) for s in sents[ctx_a:sel_a]))
    parts.append("SELECTABLE:\n" + "\n".join(line(s) for s in sents[sel_a:sel_b]))
    if sel_b < ctx_b:
        parts.append("CONTEXT AFTER (for understanding only — do not select):\n" +
                     "\n".join(line(s) for s in sents[sel_b:ctx_b]))
    task = (f"Suggest up to {want} excerpts from the SELECTABLE section, each between {min_dur} and {max_dur} "
            f"seconds long (use the timestamps).")
    if avoid:
        task += " These ranges were already suggested; pick DIFFERENT moments that do not overlap them: " + \
                ", ".join(f"S{a}–S{b}" for a, b in avoid) + "."
    return "\n\n".join(parts) + "\n\n" + task


def estimate(sents, model, chunks):
    chars = sum(len(s["text"]) + 24 for s in sents) * 1.3 + chunks * (len(SYSTEM) + 600)
    tin = chars / 3.6
    tout = chunks * 1500 + chunks * 2000  # answer + thinking allowance
    pin, pout = PRICES.get(model, (4.0, 20.0))
    return {"input_tokens": int(tin), "output_tokens": int(tout), "usd": round(tin / 1e6 * pin + tout / 1e6 * pout, 3)}


# ------------------------------------------------------------------ providers
def _anthropic_client():
    key = get_secret("ANTHROPIC_API_KEY")
    if not key:
        raise UserError("Claude is selected but no API key is set. Open Settings → AI provider and paste your "
                        "Anthropic API key, or switch to the free offline heuristic.")
    import anthropic
    # Only use the key the user configured for this app; ignore unrelated tokens/base URLs in the environment.
    for v in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        os.environ.pop(v, None)
    return anthropic.Anthropic(api_key=key, base_url="https://api.anthropic.com", max_retries=3, timeout=600)


def call_anthropic(prompt, model, system=None, schema=None) -> tuple[dict, dict]:
    import anthropic
    client = _anthropic_client()
    kwargs = dict(model=model, max_tokens=16000, system=system or SYSTEM,
                  messages=[{"role": "user", "content": prompt}],
                  output_config={"format": {"type": "json_schema", "schema": schema or SCHEMA}})
    if model in ("claude-opus-5-5", "claude-sonnet-5-5"):
        # Server-side fallback: if a safety classifier declines, Anthropic retries on a suitable model.
        fb = dict(extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
                  extra_body={"fallbacks": "default"})
    else:
        fb = {}
    try:
        try:
            resp = client.messages.create(**kwargs, **fb)
        except anthropic.BadRequestError as e:
            if fb and "fallback" in str(e).lower():
                resp = client.messages.create(**kwargs)
            else:
                raise
    except anthropic.AuthenticationError:
        raise UserError("Anthropic rejected the API key. Check it in Settings (it should start with 'sk-ant-').")
    except anthropic.PermissionDeniedError as e:
        raise UserError(f"Your Anthropic account cannot use model '{model}'. Pick another model in Settings. ({e})")
    except anthropic.NotFoundError:
        raise UserError(f"Model '{model}' was not found. Pick another model in Settings.")
    except anthropic.RateLimitError:
        raise UserError("Anthropic rate limit or credit limit reached. Wait a minute or check your billing, then retry.")
    except anthropic.APIConnectionError:
        raise UserError("Could not reach the Anthropic API. Check your internet connection and retry.")
    except anthropic.APIStatusError as e:
        raise UserError(f"The Anthropic API returned an error ({e.status_code}). Please retry. Details: {e.message}")
    if resp.stop_reason == "refusal":
        raise UserError("The AI declined to analyse this section. Try the offline heuristic for this webinar.")
    if resp.stop_reason == "max_tokens":
        raise UserError("The AI response was cut off. Try a shorter chunk size or fewer suggestions.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    return json.loads(text), usage


def call_local(prompt, base_url, model) -> tuple[dict, dict]:
    url = base_url.rstrip("/") + "/v1/chat/completions"
    body = {
        "model": model, "temperature": 0.2,
        "messages": [{"role": "system", "content": SYSTEM + "\n\nReply with JSON only, matching this schema:\n" +
                      json.dumps(SCHEMA)},
                     {"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            data = json.loads(r.read())
    except urllib.error.URLError as e:
        raise UserError(f"Could not reach the local AI server at {base_url}. Is Ollama/LM Studio running and is "
                        f"the model '{model}' downloaded? ({e})")
    text = data["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise UserError("The local model did not return valid JSON. Try a larger/better instruction-following model.")
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        raise UserError("The local model returned malformed JSON. Try again or use a different model.")
    u = data.get("usage") or {}
    return parsed, {"input_tokens": u.get("prompt_tokens", 0), "output_tokens": u.get("completion_tokens", 0)}


def provider_status() -> dict:
    s = load_settings()
    has_key = bool(get_secret("ANTHROPIC_API_KEY"))
    return {
        "provider": s["provider"],
        "anthropic": {"configured": has_key, "model": s["anthropic_model"], "models": ANTHROPIC_MODELS,
                      "prices": PRICES},
        "local": {"base_url": s["local_base_url"], "model": s["local_model"]},
    }


def check_local(base_url) -> dict:
    try:
        with urllib.request.urlopen(base_url.rstrip("/") + "/v1/models", timeout=3) as r:
            data = json.loads(r.read())
        return {"ok": True, "models": [m.get("id") for m in data.get("data", [])]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ================================================================== whole-webinar "viral strategist" brief
# Used for Claude and for "Your own AI chat" (paste into Gemini / ChatGPT). The model sees the WHOLE
# transcript (like asking Gemini about the video), ranks globally, and returns rich, ready-to-use fields.
LANGUAGES = {"en": "English"}

VIRAL_SYSTEM = """You are a senior short-form video strategist for TikTok, Instagram Reels and YouTube Shorts. \
You read a full webinar transcript and pick the moments with the highest potential to perform on social media \
as standalone clips.

What makes a strong clip: a hook in the first seconds (a bold claim, a surprising analogy, a relatable problem, \
a question); one clear idea that a brand-new viewer understands without the rest of the webinar; memorable \
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
the requested range. Check it with the timestamps before answering and put it in duration_seconds. If a great \
moment is longer, choose the strongest part of it that fits; if it is shorter, include the sentences around it.
- Rank from best to worst. Prefer fewer, excellent clips over many weak ones."""

VIRAL_SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_id": {"type": "integer"}, "end_id": {"type": "integer"},
                    "duration_seconds": {"type": "integer"},
                    "key_start_id": {"type": "integer"}, "key_end_id": {"type": "integer"},
                    "title": {"type": "string"}, "topic": {"type": "string"},
                    "viral": {"type": "string", "enum": ["very_high", "high", "medium"]},
                    "hook": {"type": "string"}, "caption": {"type": "string"}, "why": {"type": "string"},
                    "editing_tips": {"type": "array", "items": {"type": "string"}},
                    "scores": {
                        "type": "object",
                        "properties": {k: {"type": "integer"} for k in
                                       ("hook", "clarity", "standalone", "usefulness", "engagement")},
                        "required": ["hook", "clarity", "standalone", "usefulness", "engagement"],
                        "additionalProperties": False,
                    },
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                    "caveats": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["start_id", "end_id", "duration_seconds", "key_start_id", "key_end_id", "title", "topic", "viral", "hook",
                             "caption", "why", "editing_tips", "scores", "confidence", "caveats"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["candidates"],
    "additionalProperties": False,
}

EXAMPLE = {"candidates": [{
    "start_id": 120, "end_id": 127, "duration_seconds": 0, "key_start_id": 121, "key_end_id": 122,
    "title": "Analogy: AI is an intern", "topic": "AI basics", "viral": "very_high",
    "hook": "Why your AI results are still bad", "caption": "Treat AI like a smart intern who needs direction.",
    "why": "A simple, relatable analogy that explains a common frustration.",
    "editing_tips": ["Show AI logos when he lists ChatGPT, Gemini and Claude"],
    "scores": {"hook": 9, "clarity": 8, "standalone": 9, "usefulness": 8, "engagement": 9},
    "confidence": "high", "caveats": []}]}


def build_global_prompt(sents, min_dur, max_dur, count, avoid, slide_marks, language="en", for_chat=False):
    lang = LANGUAGES["en"]

    def line(s):
        mark = " [slide changes]" if s["id"] in slide_marks else ""
        return f"[S{s['id']} {fmt_time(s['start'])}–{fmt_time(s['end'])}]{mark} {s['text']}"

    lo, hi = int(min_dur), int(max_dur)
    task = (f"Pick the {count} best clips for social media from the whole webinar below — exactly {count} clips, "
            f"each about a different moment.\n"
            f"CLIP LENGTH: every clip must be {lo} to {hi} seconds long — not shorter than {lo} s and not longer "
            f"than {hi} s. Aim for about {round(lo + (hi - lo) * 0.7)} seconds: use the whole idea with its setup and "
            f"payoff, don't stop at the minimum. Measure it with the timestamps (end of the last sentence minus start "
            f"of the first).\n"
            f"Write title, hook, caption, why, editing_tips and caveats in {lang}.")
    if avoid:
        task += " These ranges were already suggested — pick DIFFERENT moments that do not overlap them: " + \
                ", ".join(f"S{a}–S{b}" for a, b in avoid) + "."
    body = "TRANSCRIPT (each line: [S<id> start–end] text):\n" + "\n".join(line(s) for s in sents)
    if not for_chat:
        return task + "\n\n" + body
    # self-contained version to paste into Gemini / ChatGPT / Claude.ai
    return (VIRAL_SYSTEM + "\n\n" + task + "\n\n"
            "ANSWER FORMAT: reply with ONLY one JSON code block (```json ... ```), no other text. The example below "
            f"shows the fields of ONE clip; your \"candidates\" list must contain {count} clip objects like it "
            "(the example's content is made up — use the real transcript):\n"
            + json.dumps(EXAMPLE, ensure_ascii=False, indent=1) + "\n"
            "Use the S-numbers from the transcript for start_id, end_id, key_start_id and key_end_id. "
            "viral is one of very_high, high, medium; confidence one of low, medium, high. "
            f"duration_seconds = the real length of the clip from the timestamps (must be {lo}–{hi}; the 0 in the "
            "example is only a placeholder).\n\n" + body +
            f"\n\nREMINDER: \"candidates\" must contain {count} clips (not 1), each {lo} to {hi} seconds long, "
            f"ideally about {round(lo + (hi - lo) * 0.7)} s "
            "(check the timestamps). "
            "Reply with only the JSON code block.")


def parse_chat_answer(text: str) -> dict:
    """Read the JSON an AI chat answered with (tolerates code fences, extra text, smart quotes)."""
    t = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, re.S)
    raw = m.group(1) if m else (t[t.find("{"): t.rfind("}") + 1] if "{" in t else "")
    if not raw and "{" in t:
        raise UserError("The pasted answer seems cut off (it doesn't end properly). Ask the AI: “Please send the "
                        "complete JSON again in one code block”, then paste it here.")
    if not raw:
        raise UserError("No answer found. Paste the AI's whole reply (the part that starts with ```json or {).")
    for attempt in (raw, raw.replace("“", '"').replace("”", '"').replace("’", "'")):
        try:
            data = json.loads(attempt)
            break
        except json.JSONDecodeError:
            data = None
    if data is None:
        raise UserError("The pasted answer isn't valid JSON — it may be cut off. Ask the AI: “Please send the "
                        "complete JSON again in one code block”, then paste it here.")
    if isinstance(data, list):
        data = {"candidates": data}
    if not isinstance(data.get("candidates"), list) or not data["candidates"]:
        raise UserError("The answer has no clips in it (expected a “candidates” list).")
    return data


def call_anthropic_rich(prompt, model):
    """Claude with the whole-webinar brief and the rich schema."""
    return call_anthropic(prompt, model, system=VIRAL_SYSTEM, schema=VIRAL_SCHEMA)
