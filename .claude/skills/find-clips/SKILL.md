---
name: find-clips
description: Find the best, most shareable moments for short clips (TikTok/Reels/Shorts) in a long video or transcript. You (the agent) judge the transcript yourself like a short-form strategist, with no API key; an instant offline rules mode also exists. Use when the user asks to "find the good/viral parts", "pick moments for reels", "which clips are worth it".
---

# find-clips

Source: `webinar-clip-studio/app/analysis/llm.py` (`VIRAL_SYSTEM`, "Your own AI chat" mode) + `discover.py`
(`fit_range`, `validate_rich`) for the viral mode; `analysis/heuristic.py` + `text.py` for the rules mode.

## Reporting to the user

Always talk to the user in **English**, and write every title, hook, caption, reason and tip in English
(`--write-in en`, the default), even when the video is in another language.

There are two modes:

| Mode | Who judges | When |
|---|---|---|
| **viral** (default, recommended) | **you, this agent**, reading the whole transcript like a short-form strategist | the user wants really good results |
| **rules** | offline keyword rules (not AI, English patterns) | instant results needed, or the user asks for "quick/offline" |

## Viral mode (do this by default)

1. **Transcript.** If there is no words file yet, run the **transcribe** skill first (pass the spoken
   language, e.g. `--language id` for Indonesian). Or reuse an existing transcript:
   webinar-clip-studio `data/cache/transcripts/<fp>-<model>.json`.
2. **Get the brief:**
   ```bash
   python3 .claude/skills/find-clips/scripts/find_clips.py --words W.json --prompt \
     --count 5 --min 20 --max 60 --wishes "<the user's wishes>" -o /tmp/brief.txt
   ```
   The brief contains the strategist criteria, the answer format and the numbered transcript
   `[S<id> start–end] text`. `--wishes` = the user's special requests (audience, tone, topic).
3. **Read the whole brief and judge it yourself, honestly.** Follow its rules: choose by sentence number only,
   never invent the speaker's words, check durations from the timestamps. Write your answer to a file:
   `/tmp/answer.json` = `{"candidates": [ … ]}`.
4. **Validate and turn it into clips:**
   ```bash
   python3 .claude/skills/find-clips/scripts/find_clips.py --words W.json --import /tmp/answer.json \
     --min 20 --max 60 --table
   ```
   The script checks sentence numbers, snaps to whole sentences, fits the length to `--min`/`--max`
   (keeping the "money line"), and gives exact start/end times. Invalid clips are dropped and reported.
5. **Show the user** a table: time, duration, viral, title, hook, caption, why, tip, caveats. Let them choose.
   For "find more": repeat step 2 with `--avoid "12-18, 40-47"` (sentence numbers already used).

## Rules mode (offline, instant)

```bash
python3 .claude/skills/find-clips/scripts/find_clips.py --words W.json --count 10 --min 20 --max 60 --table
python3 .claude/skills/find-clips/scripts/find_clips.py --video talk.mp4 --save-words W.json --table   # transcribes first
```

Score weights: hook 25 %, standalone 25 %, usefulness 20 %, clarity 15 %, engagement 15 %.

## Other options

| Option | Meaning |
|---|---|
| `--ranges-only` | print only `"a-b, c-d"` (seconds), for scripts (both modes) |
| `-o clips.json` | save the full result |
| (no `--table`) | one-line JSON: `start`, `end`, `duration`, `label`, `title`, `viral`, `hook`, `caption`, `why`, `tips`, `scores`, `score`, `confidence`, `caveats`, `key_line`, `text` |

## After choosing clips

- **Raw files**: **cut-clip** (with `--screen` + `--offset` for a webinar) → **make-subtitles** → **verify-export**.
- **webinar-clip-studio** has the same feature in its UI (step 3 → "Let the app suggest moments" → Claude
  provider or "Your own AI chat"). This skill is for using it from Claude Code.

## Limits

- The viral rating is a judgement, not a promise of views.
- Hook and caption are suggested on-screen text. The speaker's words always come from the transcript.
- Needs a punctuated transcript (faster-whisper provides it) to split sentences.
