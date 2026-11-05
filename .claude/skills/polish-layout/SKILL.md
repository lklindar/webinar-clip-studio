---
name: polish-layout
description: Find the layout of a screen recording - the app window rectangle (inside any padding or styled background) and the webcam bubble over time (where it is, how big, when it moves). Use when the user asks where the window or webcam is, or before zooming, cropping or placing captions away from the webcam.
---

# polish-layout

Scans the video once (15 fps, half resolution) and finds:
- **content**: the window rectangle, from long straight edges in the median frame, plus its corner radius
  and whether the recording is already styled (padding/background around the window);
- **webcam**: the talking-head bubble, from always-moving cells refined to the strongest circular edge, as
  spans over time (it may move between corners and change size).

Source: `polish/src/core/layout.ts` (`detectContentRect`, `detectWebcam`, `detectLayout`); frame analysis
ported from `src/workers/analyzeVideo.worker.ts`.

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
node .claude/skills/polish-layout/scripts/polish.cjs layout VIDEO
```

## Output

Saved into `<video name>.polish/edl.json` (`layout`), scan cached in `video.json`. Last line on stdout:
`{"content": {"x", "y", "w", "h"}, "radius", "styled", "webcam": [{"from", "to", "x", "y", "r"}]}` in source pixels.

## Limits

- Needs Node.js 18+ and ffmpeg. The scan takes about 1–2 min per 10 min of 1080p (cached afterwards).
- Unstyled full-screen recordings give the whole frame as content.
