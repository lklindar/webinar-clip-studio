---
name: polish-fillers
description: Remove filler words ("um", "uh", "eh", "hmm"), hesitation sounds Whisper leaves out, drawn-out words ("the......"), stutters and false starts ("we can, we can") from a recording, with a confidence per cut and a review list. Use when the user asks to "remove the ums", "cut filler words", "clean up hesitations", "remove stutters" or to review/keep specific cuts.
---

# polish-fillers

Plans precise cuts for:
- **fillers** from the transcript (lexicon: um, uh, uhm, er, erm, hmm, hm, mm, ah, eh, ehm, em; "ummm" also matches);
- **acoustic fillers**: steady "a…/uh…" sounds between words that Whisper left out;
- **held words**: drawn-out short words ("so……", "the……") trimmed to ~0.14 s;
- **repeats**: stutters ("the, the") and false starts, cut at the quietest point before the retake.

Each cut's edges are placed from the waveform (Whisper's word times are off by up to ~±130 ms), and the
pauses around a removed filler are closed so they don't merge into one long gap. "Maybe-fillers" like
*gitu* / *apa ya* are listed for review but not cut. Cuts below the confidence threshold are listed, not applied.

Source: `polish/src/core/fillers.ts` (`planFillerCuts`, `acousticFillers`, `heldWordCuts`, `repeatCuts`,
`closeGaps`) + `core/audioFeatures.ts`, driven like `src/state/store.ts` (`planEdl`). Transcription follows
`src/workers/whisper.worker.ts` (pause-aligned chunks, disfluent prompt, retry without prompt when speech is skipped)
using faster-whisper (`lib/polish/transcribe_chunks.py`).

## Reporting to the user

Always talk to the user in **English**. Show what will be cut (time, type, text, confidence) and what is only listed for review; let them change it.

## How to call

```bash
node .claude/skills/polish-fillers/scripts/polish.cjs fillers VIDEO [options]
```

The first run transcribes the video word by word (keeps "um"/"uh"). That needs a Python with faster-whisper:
it uses `--python PATH`, else `$POLISH_PYTHON`, else `./.venv/bin/python`, else `python3`.
The webinar-clip-studio venv works: `--python ~/Downloads/work/webinar-clip-studio/.venv/bin/python`.

| Option | Meaning |
|---|---|
| `--language auto` / `en` / `id` | spoken language (auto = detect English vs Indonesian on the first chunk) |
| `--model small` | faster-whisper model: `base`, `small` (default), `medium` |
| `--min-confidence 0.6` | cuts below this are listed for review, not applied |
| `--lexicon "um, uh, …"` | words always treated as fillers |
| `--soft-lexicon "anu, apa ya, gitu"` | words listed for review only |
| `--no-acoustic` / `--no-held` / `--no-repeats` | turn a detector off |
| `--off` | remove all filler and repeat cuts |
| `--table` | print every cut (to stderr) |

### Review and change cuts

```bash
node .claude/skills/polish-fillers/scripts/polish.cjs review VIDEO --type filler,repeat --table
node .claude/skills/polish-fillers/scripts/polish.cjs review VIDEO --disable 12,15 --enable 20
```

`review` lists every cut with its `index`; `--disable` keeps those words in the video, `--enable` cuts them.
These choices survive re-planning (re-running `fillers` or `silence`). `--type` filters: `silence`, `deadStartEnd`, `filler`, `repeat`, `manual`.

## Output

Updates `<video name>.polish/edl.json`; the transcript is cached in `transcript.json`. Last line on stdout:
`{"removed_seconds", "fillers_cut", "repeats_cut", "cut", "for_review", "cuts": [{"index", "type", "at", "start", "end", "label", "confidence", "enabled"}]}`.

## Next steps

**polish-captions** (subtitles without the cut words) → **polish-render**.

## Limits

- Needs Node.js 18+, ffmpeg, and Python with faster-whisper for the first transcription (the model downloads once).
- Ambiguous words in the user's language may need a custom `--lexicon` / `--soft-lexicon`.
- Grammatical doubles ("that that") are never cut.
