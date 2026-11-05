---
name: sync-recordings
description: Find the time offset between two recordings of the same event, e.g. a speaker camera and a screen/Zoom recording, from their audio. Use when the user has two webinar files that start at different times, or another skill needs `--offset`.
---

# sync-recordings

Matches the sound of two recordings (the onset of every utterance) with cross-correlation to find how
many seconds the screen recording is ahead of or behind the speaker recording.

Source: `webinar-clip-studio/app/media.py` (`_envelope`, `auto_sync`).

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
.venv/bin/python .claude/skills/sync-recordings/scripts/sync_recordings.py SPEAKER SCREEN [options]
```

| Option | Meaning |
|---|---|
| `--window 900` | seconds of speaker audio compared (default 15 minutes) |
| `--max-offset 900` | largest offset searched, seconds |

## Output

Last line on stdout: `{"offset": 4.02, "confidence": "high|medium|low", "score", "meaning"}`.

**Meaning of the offset:** `screen_time = speaker_time + offset`. A positive offset means the screen recording started earlier.
This is the number to pass as `--offset` to **cut-clip**, **analyze-screen**, **keep-parts** and **find-spotlights**.

## Limits

- Both recordings must contain the same sound (different microphones are fine).
- `confidence: low`: check by hand in a player (a clap, the first word) before using it.
- Needs `numpy` (in the webinar-clip-studio `.venv`).
