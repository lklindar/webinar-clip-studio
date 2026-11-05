"""Verbatim transcription for the Polish port (replaces polish/src/workers/whisper.worker.ts).

Whisper runs locally with faster-whisper on pause-aligned chunks (planned by the Node side with
Polish's planChunks). A disfluent text prompt makes Whisper keep "um"/"uh" instead of cleaning them
up. When a chunk leaves a lot of speech uncovered (Whisper skipped a passage), it is decoded again
without the prompt and the better result is kept: the same rule as the worker.

usage: python transcribe_chunks.py JOB_JSON OUT_JSON
JOB_JSON = {"pcm": path (16 kHz mono f32le), "chunks": [{start,end}], "pauses": [{start,end}],
            "model": "small", "language": "auto|en|id", "prompt": "..."}
Progress lines go to stderr. Output: {"words": [{"w","t0","t1"}], "language", "model", "retries"}.
"""
import json
import os
import sys
import unicodedata

SR = 16000


def norm(w):
    w = w.lower()
    # strip surrounding non-letter/digit characters (\p{L}\p{N})
    i, j = 0, len(w)
    while i < j and not unicodedata.category(w[i])[0] in "LN":
        i += 1
    while j > i and not unicodedata.category(w[j - 1])[0] in "LN":
        j -= 1
    return w[i:j]


def clean_chunk_words(words, chunk):
    """cleanChunkWords: drop decoder loops (same word 4+ times within 2 s) and words outside the chunk."""
    out = []
    for w in words:
        if w["t0"] > chunk["end"] + 0.2:
            continue
        t0 = max(chunk["start"], min(w["t0"], chunk["end"]))
        t1 = max(t0 + 0.02, min(w["t1"], chunk["end"]))
        n, k = len(out), norm(w["w"])
        if n >= 3 and all(norm(out[n - d]["w"]) == k for d in (1, 2, 3)) and t0 - out[n - 3]["t0"] < 2:
            continue
        out.append({"w": w["w"], "t0": t0, "t1": t1})
    return out


def uncovered_speech(words, chunk, pauses, min_gap=2.5):
    """uncoveredSpeech: seconds of speech in the chunk no word overlaps (stretches ≥ min_gap)."""
    def subtract(ranges, holes):
        out = ranges
        for hs, he in holes:
            nxt = []
            for rs, re_ in out:
                if he <= rs or hs >= re_:
                    nxt.append((rs, re_))
                    continue
                if hs > rs:
                    nxt.append((rs, hs))
                if he < re_:
                    nxt.append((he, re_))
            out = nxt
        return out

    unc = subtract(subtract([(chunk["start"], chunk["end"])], [(p["start"], p["end"]) for p in pauses]),
                   [(w["t0"], w["t1"]) for w in words])
    unc = sorted(r for r in unc if r[1] - r[0] > 0.05)
    groups = []
    for rs, re_ in unc:
        last = groups[-1] if groups else None
        pause_only = last is not None and not any(w["t1"] > last["end"] and w["t0"] < rs for w in words)
        if last and pause_only and rs - last["end"] < 0.8:
            last["end"] = re_
            last["speech"] += re_ - rs
        else:
            groups.append({"end": re_, "speech": re_ - rs})
    return sum(g["speech"] for g in groups if g["speech"] >= min_gap)


def main():
    job = json.load(open(sys.argv[1]))
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper is not installed for this Python. Use the webinar-clip-studio .venv/bin/python "
                 "(--python), or: pip install faster-whisper")
    model_name = job.get("model") or "small"
    print(f"Loading speech model '{model_name}' (first use downloads it)…", file=sys.stderr, flush=True)
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    audio_all = np.memmap(job["pcm"], dtype=np.float32, mode="r")
    prompt = (job.get("prompt") or "").strip()
    lang = "" if job.get("language", "auto") == "auto" else job["language"]
    words_all, retries = [], 0
    chunks = job["chunks"]

    def decode(audio, chunk, with_prompt):
        segs, info = model.transcribe(
            audio, language=lang or None, initial_prompt=prompt if (with_prompt and prompt) else None,
            word_timestamps=True, vad_filter=False, beam_size=5, condition_on_previous_text=False,
        )
        ws = []
        for seg in segs:
            for w in seg.words or []:
                t = w.word.strip()
                if t:
                    ws.append({"w": t, "t0": chunk["start"] + w.start, "t1": chunk["start"] + w.end})
        return clean_chunk_words(ws, chunk)

    for ci, chunk in enumerate(chunks):
        a = max(0, round(chunk["start"] * SR))
        b = min(len(audio_all), round(chunk["end"] * SR))
        if b - a < 1600:
            continue
        audio = np.array(audio_all[a:b])
        if not lang:
            # Detect once, on the first chunk, between English and Indonesian (as the worker does).
            _, info = model.transcribe(audio, language=None, beam_size=1, without_timestamps=True)
            probs = dict(info.all_language_probs or [])
            lang = "id" if probs.get("id", 0) > probs.get("en", 0) else "en"
            print(f"Language: {lang}", file=sys.stderr, flush=True)
        ws = decode(audio, chunk, True)
        missing = uncovered_speech(ws, chunk, job["pauses"])
        if missing >= 2.5:
            retries += 1
            alt = decode(audio, chunk, False)
            if uncovered_speech(alt, chunk, job["pauses"]) < missing - 0.5:
                ws = alt
        words_all.extend(ws)
        print(f"Transcribed chunk {ci + 1} of {len(chunks)}", file=sys.stderr, flush=True)
    for w in words_all:
        w["t0"], w["t1"] = round(w["t0"], 3), round(w["t1"], 3)
    json.dump({"words": words_all, "language": lang or "en", "model": f"faster-whisper-{model_name}",
               "retries": retries}, open(sys.argv[2], "w"), ensure_ascii=False)


if __name__ == "__main__":
    main()
