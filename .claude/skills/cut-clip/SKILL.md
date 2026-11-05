---
name: cut-clip
description: Cut the exact minutes of a clip out of a recording (frame-exact), plus the same moment from a synced screen recording. Use when the user asks to "download the raw footage of this clip", "cut 12:30 to 13:15", or needs a separate clip file to edit in another app.
---

# cut-clip

Cuts an exact time range out of a recording and checks the length of the result. With a screen
recording, the same moment is cut from it too, using the sync offset.

Source: `webinar-clip-studio/app/server.py` (`raw_download`, kinds "speaker" and "presentation").

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
python3 .claude/skills/cut-clip/scripts/cut_clip.py SOURCE --start 12:30 --end 13:15 [options]
```

| Option | Meaning |
|---|---|
| `--start`, `--end` | seconds, `mm:ss`, or `h:mm:ss` |
| `-o OUT.mp4` | output (default `SOURCE-12m30s.mp4`) |
| `--screen SCREEN.mp4 --offset 4.0` | also cut the screen recording → `OUT-screen.mp4` |
| `--copy` | no re-encode: fast, original quality, but starts at the nearest keyframe (not frame-exact) |

## Output

Default: H.264 CRF 18 + AAC 192k, length checked (±0.3 s). Last line on stdout:
`{"speaker": {"file", "duration", "size"}, "screen": {...}}`.

## Compared with other skills

- **keep-parts**: keeps large pieces (with padding) without re-encoding, to save disk space.
- **person-cutout**: the speaker cut without background.

## Limits

- Needs `ffmpeg`.
