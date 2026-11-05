---
name: verify-export
description: Check an exported video before upload: 1080×1920 size, H.264, audio present, duration, decode errors, audio too quiet or clipping. Use after any export/render, or when the user asks "is this video safe to upload?".
---

# verify-export

Checks the result file instead of only trusting "ffmpeg finished without errors". The whole file is
decoded to find damage, and the audio level is measured.

Source: `webinar-clip-studio/app/workers/render.py` (`verify`).

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
python3 .claude/skills/verify-export/scripts/verify_export.py FILE [FILE …] [options]
```

| Option | Meaning |
|---|---|
| `--duration 34.5` | expected duration (0.25 s tolerance) |
| `--width 1080 --height 1920` | expected size (default vertical 9:16) |
| `--any-size` | do not check the size |

## Output

Exit code 0 if everything is fine, 1 if there are problems. Last line on stdout:
`{"ok", "results": [{"file", "ok", "problems": [...], "warnings": [...], "width", "height", "duration",
"video_codec", "audio_codec", "mean_volume_db", "max_volume_db", "size_bytes"}]}`.

Problems: no video/audio, wrong size, not H.264 yuv420p, wrong duration, decode errors,
near-silent audio (< −50 dB). Warning: audio peaks reach 0 dB.

## Recipes

- webinar-clip-studio exports: `data/projects/<id>/exports/*.mp4` (the app checks these itself; this skill re-checks).
- Always run it after **cut-clip**, **person-cutout** or any other render before telling the user a file is ready.
