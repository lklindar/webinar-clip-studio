---
name: polish-zooms
description: Plan auto-zooms for a screen recording - zoom in around inferred clicks, aimed at the nearby content that has something to read, with pans between close clicks - and save preview images of each zoom. Use when the user asks for "auto zoom", "zoom into where I click", "Screen Studio style zooms", or a zoom plan to use in an editor.
---

# polish-zooms

Groups confident clicks (within 3 s of each other) into zoom blocks: the zoom is half-way in 0.4 s before
the first click, holds 1.2 s after the last, eases in/out, merges blocks that would touch so the camera
pans instead of zooming out and back, and aims each zoom at the content next to the click (zooms onto
empty background are dropped). The camera always stays inside the window.

Source: `polish/src/core/zoom.ts` (`planZooms`, `aimAtContent`, `cameraAt`, `viewport`) + `core/detail.ts`,
driven like `src/state/store.ts` (`planVision`).

## Reporting to the user

Always talk to the user in **English**. Show the preview images so the user can check each zoom.

## How to call

```bash
node .claude/skills/polish-zooms/scripts/polish.cjs zooms VIDEO --preview zoom-previews/ [options]
```

| Option | Meaning |
|---|---|
| `--scale 1.8` | zoom level, 1.3–2.5× |
| `--min-confidence 0.55` | clicks below this don't create zooms |
| `--no-follow` | don't follow the cursor inside a zoom |
| `--preview DIR` | one JPEG per zoom: the zoomed view (yellow) and focus point (red) on the frame |
| `--off` | remove auto zooms |

## Output

Saved into `<video name>.polish/edl.json` (`zooms`). Last line on stdout:
`{"zooms": [{"index", "from", "to", "start", "end", "scale", "focus": [{"t", "x", "y"}], "source"}], "previews": [...]}`.
Times in seconds of the original video, positions in source pixels. To apply zooms in another editor, use
`start`/`end`, `scale` and the focus point(s) as keyframes.

## Limits

- **polish-render does not draw zooms**; the plan is data (and previews). The Polish app renders them.
- Pixel-based click detection: some zooms may land on hovers; drop those from the plan.
- Needs Node.js 18+ and ffmpeg.
