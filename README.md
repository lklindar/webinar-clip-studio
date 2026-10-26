# Webinar Clip Studio

Turn long webinar recordings (a **speaker camera** + a **slide screen recording**) into vertical
9:16 short clips for TikTok, Instagram Reels and YouTube Shorts — with AI‑suggested moments,
layout changes, subtle motion and burned‑in subtitles. Everything runs **on your Mac**.

## Start it

```bash
./start.sh
```

Your browser opens **http://127.0.0.1:8010**. Keep the Terminal window open; press Ctrl+C to stop.
The first run installs the Python environment (a few minutes). Requirements: macOS, Python 3.10+,
`ffmpeg` (`brew install ffmpeg`).

## Coming back to your work

Everything is saved automatically on this Mac (in `data/projects/`), so closing the browser, quitting
the app or restarting the computer loses nothing:
- Run `./start.sh` again → the start page shows **✏️ Continue editing** (your clips, newest first) and
  **Resume where you left off**, which opens the exact clip and step you were on. Exported videos are
  listed per clip.
- The editor shows **✓ All changes saved** / **Saving…**; if a change is still being saved the browser
  asks before closing, and failed saves are retried automatically.
- A backup of each project's data (`project.json.bak`) is kept and used automatically if the file is damaged.
- If a recording you used “in place” was moved or renamed, the project shows **Find the file again** —
  your edits stay intact.
- Undo history is kept while the page is open (it starts fresh after closing the page).

## Freeing disk space: “Keep only my clip parts”

In step 3 (Choose clips), under *Your clips*, **💾 Keep only my clip parts** copies just the minutes of
your clips — plus 15 s before and after each one — from both recordings, without re‑encoding (original
quality), into `data/projects/<project>/sources/kept/`. Each copy starts on a keyframe; its exact start is
measured so the timeline maps 1:1 (verified: exports from the kept parts are bit‑identical to exports
from the originals, picture and sound). Afterwards use *Show … in Finder* and delete the originals
yourself — the app never deletes your files. From then on, clips must stay inside the kept minutes
(the app explains if not), and whole‑webinar features (AI discovery, automatic sync) need the originals.
The small preview copies stay, so you can still watch the whole webinar. If you add clips later, click
*Update kept parts* before deleting the originals.

## The 7 steps

1. **Upload** — add the speaker and the presentation recording. For multi‑GB files choose
   **“Use file in place (no copy)”**: the original is read directly, nothing is duplicated.
   “Upload a copy” streams the file in 8 MB chunks (resumable, never held in browser memory).
   Each file gets a small 540p preview copy for smooth scrubbing; slide changes are detected.
   **Your assets** (optional): upload images (JPG/PNG/WebP) and short support videos (MP4/MOV, ≤ 1 GB)
   and describe each in a few words. Stored in `data/projects/<project>/assets/`.
2. **Synchronize** — the offset is detected automatically from the audio as soon as both
   recordings are added; check it here, adjust it if needed (or *Detect offset from audio* again),
   check it with both players, and choose which audio the clips use.
3. **Choose clips** — two ways:
   - **I'll pick the moments myself** (default): type start–end times (`12:30 – 13:15`, `1:02:30`,
     or plain minutes like `12.5`), use *Set START / Set END here* while watching, or paste a list
     (one `start - end name` per line). Only these minutes are transcribed for subtitles — seconds
     instead of 10–15 minutes for a whole hour. If you lengthen a clip later, just the new part is
     transcribed. You go straight to step 5; subtitles appear automatically when ready.
   - **Let the app suggest moments**: full local transcription (faster‑whisper, cached) plus clip
     discovery with your chosen provider (see below).
   **⬇ Download** (next to each of your clips): the clip's raw footage, cut exactly to its start/end —
   the speaker video, the screen recording (sync offset applied), and — once the person cutout is
   prepared — the speaker on a green screen (MP4), with a transparent background as a small HEVC .mov
   (Apple apps) or a ProRes 4444 .mov (Premiere/DaVinci; very large, disk space is checked first).
   Files are saved in `data/projects/<project>/downloads/`.
4. **Review AI ideas** (optional, only for suggestions) — sort/filter ideas, read the verbatim transcript, the suggested hook
   (clearly marked as *not* spoken), reasons, sub‑scores, confidence and caveats. Preview,
   adjust start/end (snap to sentence), approve/reject, find more, or add your own clip.
5. **Layout & cropping** — every new clip gets an automatic **Auto-edit** (Calm / Dynamic /
   Energetic): layout changes on a rhythm, cut at pauses in speech, slides full screen when they
   change, speaker punch-ins on questions and strong statements, slow zooms, and a slow glide across
   static slides so the screen recording never looks frozen. Undo it or fine-tune any part.
   **💡 Suggestions for this clip** measures how much the screen recording really changes and, for static
   stretches, offers (A) zooming into different content areas of your own slides, or (B) illustration
   cards (icon + keyword, big number, question, list or quote) built from the speaker's own words at that
   moment — plus tips for recording less static screens next time.
   **🧩 Place my assets** decides where your uploaded images/videos go: it matches each asset's name and
   description to what the speaker says (e.g. “coffee-cup.jpg” appears when he says “coffee”); assets
   without a match fill static moments. Wide assets go above the speaker, tall ones full screen; you can
   switch to full screen / on top / card, crop, zoom, and choose where a video starts. (The asset's own
   sound is not used — the speaker's audio continues.) (Cards are designed graphics drawn by
   the app, not AI-generated pictures; nothing is invented.) Layouts: split screen (default, adjustable ratio), slides full screen, speaker
   full screen, speaker + slide card. Change layout at any time on the timeline, auto‑layout from
   slide changes, fit/fill, zoom, position, centre on face, smooth/fade/cut transitions,
   subtle zoom/pan/punch‑in motion.
   **Person cutout** layout: the speaker without their background, standing in front of the slides
   (like news/explainer videos). The person is found in every frame with Apple's built-in person
   segmentation (Vision framework, on the Mac's Neural Engine — no download, nothing leaves the Mac;
   about 1.3 s of processing per second of clip, once). Pick “Person cutout” for any part, click
   *Prepare person cutout*, then adjust the speaker size and the slides behind in Cropping & position.
   **Background behind the speaker:** the slides (screen recording) or **one of your uploaded assets** —
   an image or a video (choose the start point; videos loop by default so they never freeze), with
   fit/fill, zoom and position.
6. **Subtitles** — readability backdrop (on by default) keeps box-less templates readable on
   light slides; 8 templates (two inspired by your reference videos), font/size/colours/
   highlight/outline/shadow/box/position/alignment/line width, karaoke modes, smart positioning
   that avoids slide text and the face, edit text & timing, split/merge, .srt download, title/hook.
7. **Preview & export** — *Render exact preview* (the real pipeline at half resolution), then
   *Export MP4* (1080×1920, 30 fps, H.264 + AAC). Every export is checked automatically
   (resolution, codecs, duration, decode errors, audio level). Download, Show in Finder or Copy to
   Downloads. Files live in `data/projects/<project>/exports/`.

## AI provider for clip discovery (Settings → AI provider)

| Provider | Cost | Privacy | Quality |
|---|---|---|---|
| **Offline rules** (default) | free | nothing leaves your Mac | pattern‑based, *not* semantic AI |
| **Claude** (Anthropic API) | ≈ $0.10–0.25 per hour of webinar with Opus 5.5, < $0.01 with Haiku 5.5 | only **transcript text** is sent to Anthropic; never video/audio | best |
| **Local model** (Ollama / LM Studio) | free | stays on your Mac | depends on the model; small models on 8 GB RAM are weak |

Claude setup: create a key at console.anthropic.com → paste it in Settings. It is stored in `.env`
in this folder (git‑ignored, readable only by you). The app never uses a paid API unless you
select it. The AI only chooses sentence IDs — clip text always comes from your transcript, so it
cannot invent quotes. Scores are heuristic judgements, not view predictions.

## Realistic limits (60‑minute, 8 GB recordings on an M‑series Mac with 8 GB RAM)

- **Disk**: preview copies ≈ 0.5 GB per hour per recording, audio cache ≈ 0.25 GB/hour,
  exports ≈ 10–30 MB per clip. “Upload a copy” needs the full file size again — use “in place”.
- **Time** (estimates): preview copies 3–8 min per hour of video (hardware encoder);
  transcription with “small” ≈ 10–15 min per hour of audio (≈ 4–5× faster than real time
  measured on the samples); discovery seconds (rules) to a few minutes (Claude);
  export ≈ 1× clip length (a 26 s clip rendered in ~20 s).
- **Memory**: heavy tasks run one at a time; nothing loads a whole video into RAM.
- Only the selected segment of each source is decoded for export; sources are never re‑encoded.

## How it works

- `app/server.py` — FastAPI server; `app/jobs.py` — background job lanes (media / ai) with progress
  and cancel; `app/media.py` — ffmpeg probing, proxies, audio, slide detection, audio auto‑sync.
- `app/workers/transcribe.py` — faster‑whisper in its own process.
- `app/analysis/` — sentences, offline rules (`heuristic.py`), LLM providers (`llm.py`),
  chunked discovery with context + caching (`discover.py`).
- `static/js/compose.js` — **one layout engine** that produces draw operations for both the live
  canvas preview and the export; `static/js/captions.js` — **one caption renderer** (adapted from
  Subtitle Studio) for preview and export. The installed ffmpeg has no libass/drawtext, so the
  browser draws caption images and `app/workers/render.py` composites everything with OpenCV and
  encodes with ffmpeg.

## Test material

`tools/make_samples.py` generates two short synthetic recordings (speech via macOS `say`,
presentation starting 4 s earlier, timecodes burned in) used to validate sync, layout, subtitles
and audio before trying full‑length webinars.
