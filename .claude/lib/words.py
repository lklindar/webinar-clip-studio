"""Shared helpers for capability scripts: word-timed transcripts, ffprobe, time parsing.

Words use the webinar-clip-studio format: {"text": "hello", "start": 1.20, "end": 1.48}.
"""
import json
import subprocess


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def probe(path):
    out = run(["ffprobe", "-v", "error", "-show_entries",
               "stream=codec_type,width,height:format=duration", "-of", "json", str(path)]).stdout
    info = json.loads(out)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not v:
        raise ValueError(f"{path} has no video stream.")
    return {
        "duration": float(info["format"]["duration"]),
        "width": v.get("width"), "height": v.get("height"),
        "hasAudio": any(s["codec_type"] == "audio" for s in info["streams"]),
    }


def normalize(raw):
    """A list of words or {"words": [...]} (webinar-clip-studio format) → sorted text/start/end list."""
    if isinstance(raw, dict):
        raw = raw.get("words") or []
    out = []
    for w in raw:
        text = str(w.get("text", "")).strip()
        if text and w.get("start") is not None and w.get("end") is not None:
            out.append({"text": text, "start": float(w["start"]), "end": float(w["end"])})
    return sorted(out, key=lambda w: w["start"])


def clean(words):
    """Words for writing to JSON: text/start/end, rounded to ms."""
    return [{"text": w["text"], "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in words]


def load_words(path):
    return normalize(json.loads(open(path, encoding="utf-8").read()))


# From polish/src/core/fillers.ts: a hesitant prompt makes Whisper write "um"/"uh" down instead of cleaning them up.
DISFLUENT_PROMPT = "Umm, so, uh, I mean, like, hmm, okay. Eh, jadi, apa, ehm, gitu ya."


def transcribe(path, model_name="small", language=None, log=print, ranges=None, verbatim=False):
    """Word-timed transcript with faster-whisper, run locally (needs faster-whisper + numpy).
    `ranges` ([[start, end], …] seconds) = only transcribe those parts; word times stay on the file's timeline.
    Settings as in webinar-clip-studio/app/workers/transcribe.py (int8 CPU, VAD, beam 5)."""
    import os
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError:
        raise SystemExit("faster-whisper is not installed for this Python. Run the script with the "
                         "webinar-clip-studio .venv/bin/python, or: pip install faster-whisper")
    log(f"Loading speech model '{model_name}' (first use downloads it)…")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    words, lang = [], None
    for a, b in (ranges or [[0.0, None]]):
        seek = ["-ss", f"{a:.3f}"] + (["-t", f"{b - a:.3f}"] if b else [])
        pcm = run(["ffmpeg", "-v", "error", *seek, "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "16000",
                   "-f", "f32le", "-"]).stdout
        audio = np.frombuffer(pcm, np.float32)
        log(f"Transcribing {len(audio) / 16000:.0f} s of audio from {fmt_time(a)}…")
        segs, info = model.transcribe(audio, language=language or None, word_timestamps=True, vad_filter=not verbatim,
                                      beam_size=5, condition_on_previous_text=False,
                                      initial_prompt=DISFLUENT_PROMPT if verbatim else None)
        lang = lang or info.language
        for seg in segs:
            for w in seg.words or []:
                t = w.word.strip()
                if t:
                    words.append({"text": t, "start": round(a + w.start, 3), "end": round(a + w.end, 3),
                                  "p": round(w.probability, 3)})
    return sorted(words, key=lambda w: w["start"]), lang


def fmt_time(t):
    t = max(0.0, float(t))
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h}:{m:02d}:{s:04.1f}" if h else f"{m}:{s:04.1f}"


def parse_time(x):
    """'750', '12:30', '1:02:30.5' → seconds."""
    v = 0.0
    for p in str(x).strip().split(":"):
        v = v * 60 + float(p)
    return v


def done(result):
    """Every capability script ends with one JSON line on stdout."""
    print(json.dumps(result, ensure_ascii=False))


def parse_ranges(text):
    """'12.5-40, 1:20-1:35' → [[12.5, 40.0], [80.0, 95.0]] (seconds, mm:ss or h:mm:ss)."""
    out = []
    for chunk in text.replace("–", "-").split(","):
        if chunk.strip():
            a, b = chunk.split("-")
            out.append([parse_time(a), parse_time(b)])
    return out


def build_sentences(words, max_words=40, gap=1.2):
    """Sentences from text/start/end words (webinar-clip-studio/app/analysis/text.py)."""
    import re
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
