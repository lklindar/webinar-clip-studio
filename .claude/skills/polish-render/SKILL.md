---
name: polish-render
description: Export the polished video - apply the edit from the polish-* skills (pause and filler cuts, sped-up busy pauses, soft cross-dissolve cuts, click-free audio fades, whole-video speed 1-2x with natural pitch) into an MP4, or run the whole one-click Polish flow at once. Use when the user asks to "export", "render", "make it premium/polished", "speed it up to 1.25x", or wants the finished file.
---

# polish-render

One decode pass over the source: kept frames are placed on the output frame grid, sped-up stretches drop
frames, and each cut gets a short **soft cut** (the last frame dissolves into the next segment, only when
the two frames look alike, so a moved speaker never ghosts). Audio is assembled with tiny fades at every
cut and time-stretched with WSOLA for the whole-video speed, so voices keep their pitch.

`all` = the one-click flow: pause cuts + fillers/repeats + captions (.srt) + render.

Source: `polish/src/workers/export.worker.ts`, `src/render/softCut.ts`, `core/audioAssembler.ts`,
`core/timeStretch.ts`, `core/edl.ts` (`buildSegments`, `softCutMix`), `core/settings.ts` (output size, bitrate).

## Reporting to the user

Always talk to the user in **English**. Report the output file, its length vs. the original, and what was removed.

## How to call

```bash
node .claude/skills/polish-render/scripts/polish.cjs render VIDEO [options]     # apply the current edit
node .claude/skills/polish-render/scripts/polish.cjs all VIDEO [options]        # plan everything + render
node .claude/skills/polish-render/scripts/polish.cjs report VIDEO               # what the edit removes
```

| Option | Meaning |
|---|---|
| `-o OUT.mp4` | output (default `<video>.polished.mp4`) |
| `--speed 1.25` | whole-video speed, 1–2× (pitch preserved); remembered in the edit |
| `--resolution 1080p` | `1080p` (default), `source`, `4k` |
| `--bitrate 12` | Mbit/s at 1080p30 (scaled for other sizes) |
| `--soft-cut-ms 150` | dissolve length after each cut (0 = hard cuts) |
| `--fade-ms 15` | audio fade at each cut |
| `--hw` | Apple hardware encoder (faster) |
| `all` only: `--no-transcript` | skip fillers (no Python/faster-whisper needed) |
| `all` only | also accepts the options of polish-silence and polish-fillers (`--python`, `--language`, …) |

## Output

H.264 High + AAC 160 kb/s MP4. Last line on stdout: `{"out", "width", "height", "fps", "frames", "durationSec",
"output", "removed_seconds", "removed_percent", …, "took_seconds"}`. Then run **verify-export** on the file
(`--any-size` unless it is 1080×1920).

## Limits

- Needs Node.js 18+ and ffmpeg. Roughly 1–3 min per 10 min of 1080p on an M-series Mac.
- **Zooms are not rendered** (polish-zooms plans them; the Polish app's WebGL renderer draws them).
- **Captions are not burned in**; use the .srt from polish-captions or `all`.
- Background music, denoise and loudness (Polish milestone 5) are not part of Polish yet.
