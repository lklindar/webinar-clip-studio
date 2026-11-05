---
name: find-face
description: Find where the speaker's face is in a video and a 9:16 crop box around it (ready for ffmpeg). Use when a landscape video should become vertical, or a centre crop cuts off the face.
---

# find-face

Takes a few sample frames, finds the largest face (OpenCV), and uses the median position. The focus
point sits slightly below the face centre so head and shoulders stay in frame.

Source: `webinar-clip-studio/app/server.py` (`/api/projects/{pid}/face`).

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
~/Downloads/work/webinar-clip-studio/.venv/bin/python .claude/skills/find-face/scripts/find_face.py VIDEO [options]
```

| Option | Meaning |
|---|---|
| `--start`, `--end` | only this part (the speaker's position can change between parts) |
| `--samples 5` | number of frames checked |

## Output

Last line on stdout: `{"found", "x", "y", "face_height", "crop_9x16": {"x", "y", "w", "h"}, "ffmpeg_crop"}`.
`x`/`y` are 0..1. Without a face: `found: false`, falling back to the centre (0.5, 0.42).

## Recipes

- ffmpeg directly: `-vf "<ffmpeg_crop>"` → 1080×1920.
- webinar-clip-studio: `x`/`y` match the "centre on face" framing in the layout editor.

## Limits

- The face must look towards the camera (frontal face detection). Use more `--samples` if the speaker moves a lot.
- Needs `opencv` (in the webinar-clip-studio `.venv`).
