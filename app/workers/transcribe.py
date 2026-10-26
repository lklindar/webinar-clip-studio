"""Transcription worker (separate process). Speech recognition runs locally with faster-whisper.

usage: python -m app.workers.transcribe PCM_F32 OUT_JSON MODEL [LANGUAGE]
       python -m app.workers.transcribe --batch JOBS_JSON MODEL [LANGUAGE]   (JOBS_JSON: [{"pcm","out"}, ...])
Prints JSON progress lines on stdout.
"""
import json
import os
import sys
import time

import numpy as np


def emit(**kw):
    print(json.dumps(kw), flush=True)


def load_model(model_name):
    emit(progress=0.0, message=f"Loading speech model '{model_name}' (first use downloads it)…")
    try:
        from faster_whisper import WhisperModel
        return WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    except Exception as e:  # most likely: no internet on first download
        emit(error=f"Could not load the speech model '{model_name}'. The first use needs an internet connection "
                   f"to download it. Details: {e}")
        return None


def main():
    if sys.argv[1] == "--batch":  # several short clips, one model load
        jobs = json.loads(open(sys.argv[2]).read())
        model_name = sys.argv[3]
        language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        model = load_model(model_name)
        if not model:
            return
        sizes = [os.path.getsize(j["pcm"]) for j in jobs]
        total = sum(sizes) or 1
        done = 0
        for k, j in enumerate(jobs):
            transcribe(model, model_name, j["pcm"], j["out"], language,
                       p0=0.05 + 0.95 * done / total, p1=0.05 + 0.95 * (done + sizes[k]) / total,
                       label=f"Transcribing clip {k + 1} of {len(jobs)}")
            done += sizes[k]
        emit(progress=1.0, message=f"Transcribed {len(jobs)} clip(s)", result={"clips": len(jobs)})
        return
    pcm, out, model_name = sys.argv[1], sys.argv[2], sys.argv[3]
    language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    model = load_model(model_name)
    if not model:
        return
    transcribe(model, model_name, pcm, out, language)


def transcribe(model, model_name, pcm, out, language, p0=0.02, p1=1.0, label=None):
    audio = np.memmap(pcm, dtype=np.float32, mode="r")
    duration = len(audio) / 16000
    emit(progress=p0, message=label or "Listening to the webinar…")
    t0 = time.time()
    segments, info = model.transcribe(
        np.asarray(audio), language=language, word_timestamps=True, vad_filter=True,
        beam_size=5, condition_on_previous_text=False,
    )
    words, segs = [], []
    for seg in segments:
        sw = []
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                sw.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3),
                           "p": round(w.probability, 3)})
        words.extend(sw)
        segs.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()})
        done = seg.end / max(duration, 1)
        el = time.time() - t0
        eta = el / max(done, 1e-3) * (1 - done)
        if label:
            emit(progress=p0 + (p1 - p0) * min(1, done), message=label + "…")
        else:
            emit(progress=p0 + (p1 - p0) * min(1, done),
                 message=f"Transcribing… {int(seg.end // 60)}:{int(seg.end % 60):02d} of "
                         f"{int(duration // 60)}:{int(duration % 60):02d}  (about {int(eta // 60) + 1} min left)")
    result = {"language": info.language, "duration": duration, "model": model_name, "words": words, "segments": segs}
    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(result, f)
    os.replace(tmp, out)
    if not label:
        emit(progress=1.0, message=f"Transcribed {len(words)} words", result={"words": len(words), "language": info.language})


if __name__ == "__main__":
    main()
