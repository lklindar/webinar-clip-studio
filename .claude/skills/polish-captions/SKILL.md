---
name: polish-captions
description: Make captions (.srt) and a timestamped transcript for a recording edited with the polish-* skills, timed to the EDITED video (cuts and speed changes applied) and wrapped by characters per line. Use when the user wants subtitles or a transcript for the polished video.
---

# polish-captions

Builds caption lines from the transcript words that are **not** inside an enabled cut, wraps them to a
maximum number of characters and lines, and converts every time to the edited video's timeline (cuts,
speed-ups and whole-video speed). Without any cuts it simply gives captions for the original video.

Source: `polish/src/core/captions.ts` (`keptWords`, `buildCaptions`, `toSrt`, `toTranscriptText`) +
`core/edl.ts` (`srcToOut`).

## Reporting to the user

Always talk to the user in **English** (the caption text itself stays in the spoken language).

## How to call

```bash
node .claude/skills/polish-captions/scripts/polish.cjs captions VIDEO [options]
```

| Option | Meaning |
|---|---|
| `-o FILE.srt` | output (default `<video>.polished.srt`) |
| `--text FILE.txt` | timestamped transcript (default next to the .srt) |
| `--max-chars 42` | characters per line |
| `--max-lines 2` | lines per caption |
| `--language`, `--model`, `--python` | only used when the video has not been transcribed yet (see **polish-fillers**) |

Run it **after** the cuts are final (polish-silence / polish-fillers / review), and again after any change,
so the timing matches the rendered video.

## Output

`.srt` + `.txt`. Last line on stdout: `{"srt", "transcript", "captions", "timing": "edited video" | "original video"}`.

## Limits

- Captions are not burned into the video (the Polish app does that in its WebGL renderer; the ffmpeg on our
  Macs has no subtitle filter). Import the .srt into CapCut, Premiere or YouTube.
