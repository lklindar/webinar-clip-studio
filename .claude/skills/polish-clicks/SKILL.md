---
name: polish-clicks
description: Track the mouse pointer in a screen recording and infer when and where the user clicked, from pixels only (no click metadata needed), with a confidence and reason per click. Use when the user asks "where did I click", wants click highlights, chapter points from actions, or before planning zooms.
---

# polish-clicks

Tracks the cursor from "became dark" blobs paired with where the pointer left, re-acquiring after fast flicks,
and infers a click when the pointer rests (≥ 270 ms) and then the screen reacts under or near it, or the
page changes. Clicks inside the webcam bubble or outside the window are ignored.

Source: `polish/src/core/clicks.ts` (`trackCursor`, `inferClicks`) + `core/layout.ts`; frame analysis ported
from `src/workers/analyzeVideo.worker.ts`.

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
node .claude/skills/polish-clicks/scripts/polish.cjs clicks VIDEO [--min-confidence 0.55]
```

`--min-confidence` only filters the printed list; every click is saved.

## Output

Saved into `<video name>.polish/edl.json` (`clicks`, `layout`). Last line on stdout:
`{"clicks", "cursor_frames_seen", "list": [{"at", "t", "x", "y", "confidence", "reason"}]}`, source pixels.
`reason`: `local` (UI reacted near the pointer), `navigation` (page change), `shape`, `hover`.

## Limits

- Pixel-based: hover tooltips and highlights can look like click reactions (on Polish's sample, 72% of real
  clicks were found; about half the low-confidence ones were hovers). Use the confidence.
- Needs Node.js 18+ and ffmpeg; shares the cached scan with polish-layout and polish-zooms.
