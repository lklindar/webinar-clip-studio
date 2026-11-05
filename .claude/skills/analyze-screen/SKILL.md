---
name: analyze-screen
description: Analyse a screen/slide recording: when slides change, which parts are static (frozen screen), and content areas worth zooming into. Use when the user wants to know when slides change, why a clip feels boring, or needs zoom/b-roll targets for static parts.
---

# analyze-screen

Measures how much the picture changes twice per second, then reports:
- **slide_changes**: big changes (new slide); changes closer than 1.5 s are merged.
- **static_stretches**: parts of ≥ 8 s where the picture barely changes, i.e. candidates for zoom, cards or b-roll.
- **zoom_targets** (with `--start`/`--end`): for each slide, 1–3 content-dense areas
  (`x`, `y` 0..1, `zoom` 1.9, label left/middle/right).

Source: `webinar-clip-studio/app/media.py` (`detect_slide_changes`, `activity`, `content_regions`) +
`static/js/views/suggest.js` (`staticStretches`).

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
.venv/bin/python .claude/skills/analyze-screen/scripts/analyze_screen.py SCREEN [options]
```

| Option | Meaning |
|---|---|
| (no options) | slide changes over the whole file |
| `--start 12:30 --end 13:15` | one clip; adds static stretches and zoom targets |
| `--offset 4.0` | when clip times are on the speaker clock (from **sync-recordings**) |
| `--min-static 8` | shortest static stretch reported, seconds |
| `--regions 3` | zoom targets per slide (0 = skip) |

## Output

Last line on stdout: JSON `{"slide_changes": [...], "slides", "static_stretches": [[a, b], ...],
"static_seconds", "zoom_targets": [...]}`. Times are relative to `--start`.

## Recipes

- Before editing a webinar clip: run it for that clip, then suggest zooming to `zoom_targets` or b-roll in
  `static_stretches`. For "zoom to what he is talking about", use **find-spotlights**.
- `slide_changes` can be used as layout switch points in any editor.

## Limits

- The whole file is decoded (scaled down to 320 px). For multi-hour recordings this takes a few minutes.
- Empty or plain slides produce no zoom targets. Needs `opencv` + `numpy` (in the webinar-clip-studio `.venv`).
