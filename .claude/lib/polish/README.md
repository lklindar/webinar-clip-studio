# lib/polish

Node.js port of the Polish app's editing engine, used by the `polish-*` skills.

- `src/core/` = Polish's own pure TypeScript (`polish/src/core`), copied unchanged: silence, fillers, captions,
  EDL, audio assembler, time-stretch, layout, clicks, zoom, detail, settings.
- `src/node/` = what replaces the browser parts: ffmpeg-based audio/video analysis (ports of
  `analyzeAudio.worker.ts` / `analyzeVideo.worker.ts`), the render (port of `export.worker.ts`), and `cli.ts`
  (the planning from `src/state/store.ts` + commands).
- `transcribe_chunks.py` = verbatim transcription with faster-whisper (port of `whisper.worker.ts`).
- `dist/` = built CommonJS, what the skills run. Rebuild with `sh tools/build-polish.sh` after any change.

When Polish's `src/core` changes, copy the changed files into `src/core/` and rebuild.
