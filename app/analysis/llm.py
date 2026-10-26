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


def call_anthropic(prompt, model) -> tuple[dict, dict]:
    import anthropic
    client = _anthropic_client()
    kwargs = dict(model=model, max_tokens=16000, system=SYSTEM,
                  messages=[{"role": "user", "content": prompt}],
                  output_config={"format": {"type": "json_schema", "schema": SCHEMA}})
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
