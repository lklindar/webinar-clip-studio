---
name: make-subtitles
description: Make .srt subtitles (and per-word JSON) from a transcript, split into short 1–8 word lines like webinar-clip-studio does. Use when the user asks for "subtitles", "captions", "an srt file", or subtitles for just one clip.
---

# make-subtitles

Splits a word-timed transcript into short subtitle lines. A line breaks when it reaches the maximum
word count, at the end of a sentence, at a pause longer than 0.7 s, or at a comma after half a line.
Small gaps (under 0.4 s) are closed so subtitles do not flicker.

Source: `webinar-clip-studio/static/js/captions.js` (`groupWords`, `toSRT`), ported to Python.

## Reporting to the user

Always talk to the user in **English**. The subtitle text itself stays in the spoken language.

## How to call

```bash
python3 .claude/skills/make-subtitles/scripts/make_subtitles.py --words FILE.json [options]
```

No extra packages needed, any Python works.

| Option | Meaning |
|---|---|
| `--words FILE.json` | word-timed transcript (from **transcribe** or the webinar-clip-studio cache) |
| `-o clip.srt` | output .srt |
| `--start 12:30 --end 13:15` | only this part, with times starting at 0:00 (for a clip cut from that point) |
| `--max-words 4` | words per line (default 4; one-word style = 1) |
| `--json captions.json` | also save the lines + per-word timings (for karaoke/animation) |
| `--upper` | ALL CAPS |
| `--strip-punct` | remove trailing commas/periods from each line |

## Output

A standard `.srt` (opens in CapCut, Premiere, YouTube). Last line on stdout:
`{"srt", "json", "subtitles", "duration"}`.

## Recipes

- A clip from **cut-clip**: use the original transcript + the same `--start`/`--end` as the cut.

## Limits

- Only makes the subtitle file. Visual style (font, colour, highlight) is still set in the app or editor.
