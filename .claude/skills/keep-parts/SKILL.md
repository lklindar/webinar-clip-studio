---
name: keep-parts
description: Keep only the minutes you need from a huge recording (no re-encoding, original quality) so the multi-GB original can be deleted, with a time map back to the original. Use when the user is running out of disk space, wants to archive only their clips, or says "just keep my clip parts".
---

# keep-parts

Copies parts of a recording as they are (stream copy, no quality loss). Each range gets padding
(default 15 s before and after), and overlapping ranges are merged. Because a copy must start on a
keyframe, the exact start of every piece is measured and recorded, so
`original_time = piece.start + time_inside_piece`. Rendering from the pieces gives the same result as
rendering from the original.

Source: `webinar-clip-studio/app/keep.py` ("Keep only my clip parts").

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
python3 .claude/skills/keep-parts/scripts/keep_parts.py SOURCE --ranges "12:30-13:15, 41:00-41:40" [options]
```

| Option | Meaning |
|---|---|
| `--ranges` | clip times |
| `--offset 4.0` | for the screen recording: added to the ranges (speaker clock → screen clock) |
| `--pad 15` | extra seconds before and after |
| `--outdir kept/` | output folder (default `kept/` next to SOURCE) |

For a two-file webinar, run it twice: the speaker without offset, the screen with `--offset`.

## Output

Pieces `NAME-001.mp4`, `NAME-002.mp4`, … plus a manifest `NAME.kept.json`. The last line on stdout is the
manifest: `{"pieces": [{"file", "start", "end", "size"}], "bytes", "original_bytes", "rule"}`.

## Limits

- **The original is never deleted.** After checking, the user deletes it themselves.
- This is the standalone version. The in-app feature (which updates `project.json`) is still the
  *💾 Keep only my clip parts* button in webinar-clip-studio.
- Needs `ffmpeg`/`ffprobe`.
