---
name: polish-silence
description: Tighten a screen recording or talking video the Polish way - shorten every pause to a natural length, speed up silent-but-busy stretches (page loads, scrolling) instead of cutting them, and trim dead air at the start and end. Use when the user asks to "remove the pauses", "tighten this recording", "cut the silences" or "make it snappier".
---

# polish-silence

Detects pauses on 20 ms audio frames with a threshold that adapts to the file's own levels, then:
- **cuts** each pause of ≥ 0.35 s down to about 0.2 s (0.1 s of padding kept on each side);
- **speeds up** pauses where the screen is busy (loading, scrolling) to last about 0.8 s, at 3–12×;
- **trims dead air** before the first speech/action and after the last one.

The result is an edit (cut list) saved next to the video. Nothing is rendered until **polish-render**.

Source: `polish/src/core/silence.ts` (`detectPauses`, `planSilenceEdits`) + `core/activity.ts`, driven like
`src/state/store.ts` (`planEdl`). Audio/video analysis ported from `src/workers/analyzeAudio.worker.ts` and
`analyzeVideo.worker.ts` (ffmpeg instead of WebCodecs).

## Reporting to the user

Always talk to the user in **English**. Report what was removed (seconds and %), how many pauses were cut and sped up.

## How to call

```bash
node .claude/skills/polish-silence/scripts/polish.cjs silence VIDEO [options]
```

| Option | Meaning |
|---|---|
| `--min-pause 0.35` | pauses at least this long are shortened (seconds) |
| `--padding 0.1` | speech kept on each side of a cut; a long pause becomes ~2× this |
| `--threshold 0.4` | 0–1, higher = more counts as silence |
| `--max-speed 12` | fastest speed-up for busy pauses |
| `--no-speedup` | leave busy pauses untouched instead of speeding them up |
| `--no-dead-air` | keep the start and end as they are |
| `--no-video` | skip the screen scan (faster; no speed-ups, dead air judged by audio only) |
| `--off` | remove all pause cuts from the edit |
| `--table` | also print every cut (to stderr) |

Settings are remembered per video. Re-running replaces earlier pause cuts but keeps cuts the user toggled (see **polish-fillers** → `review`).

## Output

Files go in `<video name>.polish/` next to the video: `audio.json`, `pcm16k.f32`, `video.json` (analysis cache),
`edl.json` (the edit), `settings.json`. Last line on stdout: JSON
`{"source", "output", "removed_seconds", "removed_percent", "pauses_cut", "sped_up", "speedups": [...], ...}`.

## Next steps

**polish-fillers** (um/uh, stutters) → **polish-captions** → **polish-render**. Or do everything at once:
`node .claude/skills/polish-render/scripts/polish.cjs all VIDEO`.

## Limits

- Needs **Node.js 18+** and **ffmpeg**. The first run scans the whole video (about 1–2 min per 10 min of 1080p).
- Very quiet speakers or constant background music can make pauses hard to find: raise or lower `--threshold`.
