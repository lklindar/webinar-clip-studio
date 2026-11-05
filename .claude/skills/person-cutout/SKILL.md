---
name: person-cutout
description: Separate the speaker from their background for part of a video (Apple Vision on the Mac), as a green-screen MP4, a transparent video (HEVC/ProRes 4444) or a black-and-white mask. Use when the user asks to "remove the background", "green screen", "cut out the person", or "transparent video".
---

# person-cutout

Step 1: every frame is analysed with Apple's built-in person segmentation (Vision framework, on the
Neural Engine; no download, nothing leaves the Mac). The result is a mask video (white = person),
about 1.3 s of processing per second of video.
Step 2: the mask is combined with the original video into the requested format.

Source: `webinar-clip-studio/app/workers/cutout.py` + `app/server.py` (`raw_download`: cutout_green /
cutout_alpha / cutout_prores).

## Reporting to the user

Always talk to the user in **English**.

## How to call

```bash
# must use the webinar-clip-studio .venv (has pyobjc Vision + Quartz + opencv)
~/Downloads/work/webinar-clip-studio/.venv/bin/python .claude/skills/person-cutout/scripts/person_cutout.py \
  SPEAKER --start 12:30 --end 13:15 --as green
```

| Option | Meaning |
|---|---|
| `--as green` | MP4 on a green #00B140 background (default, opens anywhere) |
| `--as alpha` | small transparent HEVC .mov (Final Cut, iMovie, Keynote, CapCut for Mac) |
| `--as prores` | transparent ProRes 4444 .mov (Premiere, DaVinci). **Very large** (~55 MB/s at 1080p); free disk space is checked first |
| `--as mask` | only the black-and-white mask |
| `--quality fast/balanced/accurate` | segmentation quality (default balanced) |
| `--mask FILE --mask-start S` | reuse an existing mask (no Vision), e.g. from `webinar-clip-studio/data/projects/<id>/cutouts/` |
| `-o OUT` | output file name |

## Output

Last line on stdout: `{"output", "mask", "size", "duration", "mask_frames", "mask_seconds"}`. The mask is kept next to
the result (`…-cutout-mask.mp4`) so it can be reused with `--mask`.

## Limits

- The Vision step and `--as alpha` are **macOS only**. Elsewhere only `--mask` + `--as green/prores` work.
- The mask is 480 px tall with softened edges; fine hair detail can be slightly soft.
