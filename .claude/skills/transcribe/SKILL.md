---
name: transcribe
description: Transcribe a video/audio file into text with per-word timings, locally on the Mac (faster-whisper), optionally only selected parts (much faster). Use when the user asks for a "transcript" or "the text of this video", or when another skill (find-clips, make-subtitles, find-spotlights) needs a words file.
---

# transcribe

Turns speech in a video or audio file into a list of words with start and end times. Everything runs
on the Mac with faster-whisper, nothing is uploaded. `--ranges` transcribes only the chosen minutes:
seconds instead of 10–15 minutes for an hour-long webinar.

Source: `webinar-clip-studio/app/workers/transcribe.py` + `app/segments.py` (transcribe only the clip parts).

## Reporting to the user

Always talk to the user in **English**, whatever language is spoken in the video.

## How to call

```bash
.venv/bin/python .claude/skills/transcribe/scripts/transcribe.py MEDIA [options]
```

| Option | Meaning |
|---|---|
| `-o FILE.json` | output (default `MEDIA.words.json`) |
| `--ranges "12:30-13:15, 41:00-41:40"` | only these parts. Word times stay on the original file's timeline |
| `--language id` / `en` | spoken language (default: auto-detect). Set it when known, results are more accurate |
| `--model small` | `tiny` / `base` / `small` (default) / `medium` (most accurate, ~3× slower) |
| `--verbatim` | keep filler words ("um", "uh", "eh") instead of cleaning them up, using Polish's hesitant prompt. The **polish-fillers** skill transcribes this way on its own |

## Output

JSON file `{"language", "model", "duration", "ranges", "words": [{"text", "start", "end"}, ...]}`. Last line on stdout:
`{"output", "words", "language", "audio_seconds", "took_seconds"}`.

## Recipes

- Typical chain: **transcribe** → **find-clips** (pick moments) → **cut-clip** → **make-subtitles** → **verify-export**.
- webinar-clip-studio already stores transcripts in `data/cache/transcripts/<fp>-<model>.json`. Use those
  before transcribing again.

## Limits

- Needs a Python with `faster-whisper` + `numpy`, i.e. the webinar-clip-studio `.venv`. Also needs `ffmpeg`.
- The first run downloads the model (a few hundred MB), so it needs internet.
- Speed ≈ 4–5× real time with `small` on an M-series Mac.
