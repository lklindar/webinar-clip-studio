---
name: find-spotlights
description: Find which slide element the speaker is talking about and when (Apple Vision OCR on the Mac), for spotlight/click/zoom effects on that part of the slide. Use when the user asks to "highlight what he's talking about on the slide", "spotlight effect", "zoom to what's being discussed", or works on webinar clips with busy slides.
---

# find-spotlights

For every slide shown in the clip, the slide text is read with Apple's built-in text recognition
(Vision, on the Mac, no upload). Each spoken sentence is compared with the text blocks on the slide.
When a sentence clearly talks about one block (shared meaningful words; words that appear on many
blocks count less), that block, grown to the picture/icon it labels, becomes a spotlight moment: that
part stays sharp, the rest is dimmed and blurred, and a click ring appears.

Source: `webinar-clip-studio/app/spotlight.py` + `app/server.py` (`/api/projects/{pid}/spotlights`).

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
# must use the webinar-clip-studio .venv (pyobjc Vision + Quartz, opencv, numpy)
~/Downloads/work/webinar-clip-studio/.venv/bin/python .claude/skills/find-spotlights/scripts/find_spotlights.py \
  --screen SCREEN.mp4 --words TRANSCRIPT.json --start 12:30 --end 13:15 --offset 4.0 --preview spot-previews/
```

| Option | Meaning |
|---|---|
| `--screen` | screen/slide recording |
| `--words` | word-timed transcript (speaker clock), from **transcribe** or the webinar-clip-studio cache |
| `--start`, `--end` | the clip, on the speaker clock |
| `--offset` | `screen_time = speaker_time + offset` (from **sync-recordings**; 0 for a single file) |
| `--slides "755.5, 770"` | slide change times (speaker clock). Default: detected automatically |
| `--preview DIR` | save one PNG per moment showing the spotlight. **Show them to the user** to check |

## Output

Last line on stdout: `{"slides", "events": [{"start", "end", "clip_start", "clip_end", "text", "box": [x, y, w, h],
"click": [x, y], "said", "preview"}]}`.
`box`/`click` are 0..1 of the screen (top-left origin). `clip_start`/`clip_end` are relative to the clip start.

## Recipes

- Use `box` as a zoom/crop target on the screen part in any editor, or as the highlighted area.
- In webinar-clip-studio this effect already exists in the editor. This skill is for seeing the result from Claude Code,
  or using the data in another editor.

## Limits

- **macOS only** (Vision OCR). Text inside pictures or photos that OCR cannot read cannot be matched.
- Word-based matching with English stop words. Slides + speech in other languages give fewer results.
- Moments shorter than 1.2 s are dropped.
