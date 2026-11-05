// Command-line front end for the Polish skills. Mirrors polish/src/state/store.ts (analysis →
// planEdl → finalize) with an on-disk cache next to the video: <name>.polish/.
//
//   node polish.cjs <command> VIDEO [options]
//   commands: analyze · transcribe · silence · fillers · review · captions · render · layout · clicks · zooms · report · all
//
// Every command prints progress to stderr and ONE JSON line on stdout at the end.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeActivity, type VideoActivityRaw } from '../core/activity';
import { buildCaptions, toSrt, toTranscriptText } from '../core/captions';
import { inferClicks, trackCursor } from '../core/clicks';
import { buildDetail, detailIn } from '../core/detail';
import { editStats, emptyEdl, withSegments, type Cut, type EDL } from '../core/edl';
import { closeGaps, heldWordCuts, planFillerCuts, repeatCuts } from '../core/fillers';
import { fmtTime } from '../core/format';
import type { FrameData } from '../core/frameData';
import { detectLayout } from '../core/layout';
import { PRESETS, cloneSettings, type Settings } from '../core/settings';
import { detectPauses, planSilenceEdits, type AudioAnalysis } from '../core/silence';
import { planChunks, type Transcript } from '../core/transcript';
import { cameraAt, planZooms, viewport } from '../core/zoom';
import { analyzeAudio } from './analyzeAudio';
import { analyzeVideo } from './analyzeVideo';
import { cacheDir, fail, loadJson, log, probe, sameSource, saveJson, type SourceMeta } from './io';
import { render } from './render';

// ---------------------------------------------------------------- arguments

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-o') a.out = argv[++i];
    else if (t.startsWith('--')) {
      const [k, v] = t.slice(2).split('=');
      if (v !== undefined) a[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !BOOL.has(k)) a[k] = argv[++i];
      else a[k] = true;
    } else a._.push(t);
  }
  return a;
}
const BOOL = new Set(['force', 'no-video', 'no-speedup', 'no-dead-air', 'off', 'no-acoustic', 'no-repeats', 'no-held', 'hw', 'no-follow', 'table', 'no-transcript']);
const num = (a: Args, k: string, d: number) => (a[k] === undefined || a[k] === true ? d : Number(a[k]));
const str = (a: Args, k: string, d: string) => (typeof a[k] === 'string' ? (a[k] as string) : d);

function done(result: unknown) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

// ---------------------------------------------------------------- project state on disk

interface Ctx {
  video: string;
  dir: string;
  meta: SourceMeta;
  settings: Settings;
}

function open(video: string | undefined): Ctx {
  if (!video) fail('Give the video file as the first argument.');
  const meta = probe(video);
  const dir = cacheDir(video);
  const saved = loadJson<Settings>(path.join(dir, 'settings.json'));
  const settings = saved ?? cloneSettings(PRESETS.premium.settings);
  return { video, dir, meta, settings };
}

const file = (c: Ctx, name: string) => path.join(c.dir, name);
const saveSettings = (c: Ctx) => saveJson(file(c, 'settings.json'), c.settings);

function loadEdl(c: Ctx): EDL {
  const e = loadJson<EDL & { srcMeta?: SourceMeta }>(file(c, 'edl.json'));
  if (e && sameSource(e.srcMeta, c.meta)) return e;
  return emptyEdl({ durationSec: c.meta.durationSec, width: c.meta.width, height: c.meta.height, fps: c.meta.fps });
}

/** finalize() from store.ts: segments + captions derived from cuts, then saved. */
function saveEdl(c: Ctx, edl: EDL): EDL {
  const withSegs = withSegments(edl);
  const words = edl.transcript?.words ?? [];
  const out = { ...withSegs, captions: words.length ? buildCaptions(words, withSegs.cuts, c.settings.captions) : [] };
  saveJson(file(c, 'edl.json'), { ...out, srcMeta: c.meta });
  return out;
}

function progress(label: string) {
  let last = -1;
  return (f: number) => {
    const p = Math.floor(f * 10) * 10;
    if (p !== last) {
      last = p;
      log(`${label}… ${p}%`);
    }
  };
}

async function audioOf(c: Ctx, force = false): Promise<AudioAnalysis | null> {
  if (!c.meta.hasAudio) return null;
  const cached = loadJson<{ meta: SourceMeta; audio: AudioAnalysis }>(file(c, 'audio.json'));
  if (!force && cached && sameSource(cached.meta, c.meta) && fs.existsSync(file(c, 'pcm16k.f32'))) return cached.audio;
  log('Analysing the audio…');
  const audio = await analyzeAudio(c.meta, file(c, 'pcm16k.f32'), progress('Audio'));
  saveJson(file(c, 'audio.json'), { meta: c.meta, audio });
  return audio;
}

async function videoOf(c: Ctx, force = false): Promise<{ activity: VideoActivityRaw; frameData: FrameData }> {
  const cached = loadJson<{ meta: SourceMeta; activity: VideoActivityRaw; frameData: FrameData }>(file(c, 'video.json'));
  if (!force && cached && sameSource(cached.meta, c.meta)) return cached;
  log('Scanning the screen (15 fps, half resolution)…');
  const r = await analyzeVideo(c.meta, progress('Video'));
  saveJson(file(c, 'video.json'), { meta: c.meta, ...r });
  return r;
}

function findPython(a: Args): string {
  const cands = [str(a, 'python', ''), process.env.POLISH_PYTHON ?? '', path.resolve('.venv/bin/python'), 'python3'].filter(Boolean);
  for (const p of cands) {
    const r = spawnSync(p, ['-c', 'import faster_whisper'], { encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  fail('No Python with faster-whisper found. Pass --python /path/to/.venv/bin/python (the webinar-clip-studio .venv has it).');
}

async function transcriptOf(c: Ctx, a: Args, force = false): Promise<Transcript | null> {
  const t = c.settings.transcription;
  if (typeof a.language === 'string') t.language = a.language as typeof t.language;
  if (typeof a.model === 'string') t.model = a.model as typeof t.model;
  // The browser app defaults to whisper-base; faster-whisper "small" is the better local default.
  else if (t.model === 'base') t.model = 'small';
  const cached = loadJson<{ meta: SourceMeta; key: string; transcript: Transcript }>(file(c, 'transcript.json'));
  const key = `${t.model}|${t.language}|${t.prompt}`;
  if (!force && cached && sameSource(cached.meta, c.meta) && cached.key === key) return cached.transcript;
  const audio = await audioOf(c);
  if (!audio) return null;
  const { pauses } = detectPauses(audio, c.settings.silence.thresholdRatio);
  const chunks = planChunks(c.meta.durationSec, pauses);
  const job = file(c, 'transcribe-job.json');
  const out = file(c, 'transcribe-out.json');
  fs.writeFileSync(job, JSON.stringify({
    pcm: file(c, 'pcm16k.f32'), chunks, pauses: pauses.map((p) => ({ start: p.start, end: p.end })),
    model: t.model, language: t.language, prompt: t.prompt,
  }));
  const py = findPython(a);
  log(`Transcribing ${chunks.length} chunks word by word (keeps "um"/"uh")…`);
  const script = path.join(__dirname, '..', '..', 'transcribe_chunks.py');
  const r = spawnSync(py, [script, job, out], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) fail('Transcription failed (see the messages above).');
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  const transcript: Transcript = { words: res.words, language: res.language, model: res.model, device: 'cpu' };
  saveJson(file(c, 'transcript.json'), { meta: c.meta, key, transcript, retries: res.retries });
  fs.unlinkSync(job);
  fs.unlinkSync(out);
  return transcript;
}

// ---------------------------------------------------------------- planning (store.ts planEdl)

const SILENCE_TYPES = new Set(['silence', 'deadStartEnd']);
const FILLER_TYPES = new Set(['filler', 'repeat']);

/** Keeps the user's toggles (userSet) on cuts that are re-planned, like store.ts `remember`. */
function remember(old: Cut[], fresh: Cut[]): Cut[] {
  const userSet = old.filter((c) => c.userSet && c.type !== 'manual');
  const overlaps = (x: Cut, y: Cut) =>
    x.type === y.type && Math.min(x.end, y.end) - Math.max(x.start, y.start) > 0.5 * Math.min(x.end - x.start, y.end - y.start);
  return fresh.map((cut) => {
    const prev = userSet.find((u) => overlaps(cut, u));
    return prev ? { ...cut, enabled: prev.enabled, userSet: true } : cut;
  });
}

async function activityOf(c: Ctx, a: Args) {
  if (a['no-video']) return null;
  const v = await videoOf(c);
  return computeActivity(v.activity);
}

function applySilenceFlags(c: Ctx, a: Args) {
  const s = c.settings.silence;
  s.minSilenceSec = num(a, 'min-pause', s.minSilenceSec);
  s.paddingSec = num(a, 'padding', s.paddingSec);
  s.thresholdRatio = num(a, 'threshold', s.thresholdRatio);
  s.maxSpeed = num(a, 'max-speed', s.maxSpeed);
  if (a['no-speedup']) s.speedUpBusy = false;
  if (a['no-dead-air']) s.trimDeadAir = false;
  if (a.off) s.enabled = false;
  else if (a._[0] === 'silence') s.enabled = true;
}

function applyFillerFlags(c: Ctx, a: Args) {
  const f = c.settings.fillers;
  f.minConfidence = num(a, 'min-confidence', f.minConfidence);
  f.lexicon = str(a, 'lexicon', f.lexicon);
  f.softLexicon = str(a, 'soft-lexicon', f.softLexicon);
  if (a['no-acoustic']) f.acoustic = false;
  if (a['no-repeats']) f.removeRepeats = false;
  if (a['no-held']) f.trimHeldWords = false;
  if (a.off) f.enabled = false;
  else if (a._[0] === 'fillers') f.enabled = true;
}

async function planSilence(c: Ctx, a: Args, edl: EDL): Promise<EDL> {
  const audio = await audioOf(c);
  if (!audio) return edl;
  const plan = planSilenceEdits(audio, await activityOf(c, a), c.settings.silence);
  const cuts = remember(edl.cuts, plan.cuts)
    .concat(edl.cuts.filter((x) => !SILENCE_TYPES.has(x.type)))
    .sort((x, y) => x.start - y.start);
  return { ...edl, cuts, speedups: plan.speedups };
}

async function planFillers(c: Ctx, a: Args, edl: EDL): Promise<EDL> {
  const audio = await audioOf(c);
  if (!audio) return edl;
  const transcript = await transcriptOf(c, a);
  if (!transcript) return edl;
  edl = { ...edl, transcript: { ...transcript } };
  const plan = planSilenceEdits(audio, null, c.settings.silence); // pauses + levels only
  const words = transcript.words;
  const fs_ = c.settings.fillers;
  const base = planFillerCuts(audio, plan.levels, words, fs_);
  const held = fs_.enabled && fs_.trimHeldWords && words.length ? heldWordCuts(words, audio) : [];
  const repeats = fs_.enabled && fs_.removeRepeats && words.length ? repeatCuts(words, audio, base) : [];
  const fillers = closeGaps([...base, ...held, ...repeats], plan.pauses, c.settings.silence.paddingSec);
  const cuts = remember(edl.cuts, fillers)
    .concat(edl.cuts.filter((x) => !FILLER_TYPES.has(x.type)))
    .sort((x, y) => x.start - y.start);
  return { ...edl, cuts };
}

function summary(edl: EDL) {
  const s = editStats(edl);
  return {
    source: fmtTime(s.sourceSec), output: fmtTime(s.outputSec), removed_seconds: Math.round(s.removedSec * 10) / 10,
    removed_percent: Math.round((s.removedSec / Math.max(1, s.sourceSec)) * 1000) / 10,
    pauses_cut: s.silences, fillers_cut: s.fillers, repeats_cut: s.repeats, manual_cuts: s.manual,
    sped_up: s.speedups, zooms: s.zooms, global_speed: edl.globalSpeed,
  };
}

function cutList(edl: EDL, types?: Set<string>) {
  return edl.cuts
    .map((x, i) => ({ i, ...x }))
    .filter((x) => !types || types.has(x.type))
    .map((x) => ({
      index: x.i, type: x.type, at: fmtTime(x.start, true), start: Math.round(x.start * 1000) / 1000,
      end: Math.round(x.end * 1000) / 1000, seconds: Math.round((x.end - x.start) * 100) / 100,
      label: x.label ?? '', confidence: x.confidence != null ? Math.round(x.confidence * 100) / 100 : null,
      enabled: x.enabled,
    }));
}

function printTable(rows: ReturnType<typeof cutList>) {
  for (const r of rows) {
    const conf = r.confidence != null ? ` ${Math.round(r.confidence * 100)}%` : '';
    process.stderr.write(`${r.enabled ? '✂' : '·'} #${String(r.index).padEnd(4)} ${r.at.padEnd(10)} ${r.type.padEnd(12)} ${r.seconds.toFixed(2)}s  ${r.label}${conf}\n`);
  }
}

// ---------------------------------------------------------------- vision (store.ts analyzeVision / planVision)

async function visionOf(c: Ctx) {
  const { frameData } = await videoOf(c);
  const layout = detectLayout(frameData);
  const track = trackCursor(frameData, layout);
  const clicks = inferClicks(frameData, layout, track);
  return { layout, track, clicks, detail: buildDetail(frameData, layout) };
}

function applyExportFlags(c: Ctx, a: Args) {
  const ex = c.settings.export;
  ex.resolution = str(a, 'resolution', ex.resolution) as typeof ex.resolution;
  if (!['1080p', 'source', '4k'].includes(ex.resolution)) fail('--resolution must be 1080p, source or 4k.');
  ex.softCutMs = num(a, 'soft-cut-ms', ex.softCutMs);
  ex.fadeMs = num(a, 'fade-ms', ex.fadeMs);
  ex.bitrateMbps = num(a, 'bitrate', ex.bitrateMbps);
  return ex;
}

function applyZoomFlags(c: Ctx, a: Args) {
  const z = c.settings.zoom;
  z.scale = num(a, 'scale', z.scale);
  z.minConfidence = num(a, 'min-confidence', z.minConfidence);
  if (a['no-follow']) z.followCursor = false;
  if (a.off) z.enabled = false;
  else z.enabled = true;
}

function previewZooms(c: Ctx, edl: EDL, dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const outs: string[] = [];
  const content = edl.layout?.content ?? { x: 0, y: 0, w: c.meta.width, h: c.meta.height };
  edl.zooms.forEach((z, i) => {
    const t = Math.min(z.end - 0.05, z.start + Math.min(1.2, (z.end - z.start) / 2));
    const v = viewport(cameraAt(edl.zooms, content, t), content);
    const focus = z.focus.find((f) => f.t >= z.start) ?? z.focus[0];
    const out = path.join(dir, `zoom-${String(i + 1).padStart(2, '0')}-${Math.floor(z.start)}s.jpg`);
    const draw = [
      `drawbox=x=${Math.round(v.x)}:y=${Math.round(v.y)}:w=${Math.round(v.w)}:h=${Math.round(v.h)}:color=yellow@0.9:t=6`,
      focus ? `drawbox=x=${Math.round(focus.x - 14)}:y=${Math.round(focus.y - 14)}:w=28:h=28:color=red@0.9:t=4` : '',
      'scale=1280:-2',
    ].filter(Boolean).join(',');
    spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', c.meta.path, '-frames:v', '1', '-vf', draw, out]);
    if (fs.existsSync(out)) outs.push(out);
  });
  return outs;
}

// ---------------------------------------------------------------- commands

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  const c = open(a._[1]);
  const force = !!a.force;

  switch (cmd) {
    case 'analyze': {
      const audio = await audioOf(c, force);
      const v = a['no-video'] ? null : await videoOf(c, force);
      done({ cache: c.dir, audio_frames: audio?.rms.length ?? 0, video_frames: v?.frameData.frames ?? 0 });
      return;
    }
    case 'transcribe': {
      const t = await transcriptOf(c, a, force);
      saveSettings(c);
      if (!t) fail('This video has no audio.');
      done({ cache: c.dir, words: t.words.length, language: t.language, model: t.model, file: file(c, 'transcript.json') });
      return;
    }
    case 'silence': {
      applySilenceFlags(c, a);
      saveSettings(c);
      const edl = saveEdl(c, await planSilence(c, a, loadEdl(c)));
      const rows = cutList(edl, SILENCE_TYPES);
      if (a.table) printTable(rows);
      done({ edit: file(c, 'edl.json'), ...summary(edl), speedups: edl.speedups.map((s) => ({ at: fmtTime(s.start), seconds: +(s.end - s.start).toFixed(2), speed: s.speed })), cuts: rows.length });
      return;
    }
    case 'fillers': {
      applyFillerFlags(c, a);
      saveSettings(c);
      const edl = saveEdl(c, await planFillers(c, a, loadEdl(c)));
      const rows = cutList(edl, FILLER_TYPES);
      if (a.table) printTable(rows);
      done({ edit: file(c, 'edl.json'), ...summary(edl), cut: rows.filter((r) => r.enabled).length, for_review: rows.filter((r) => !r.enabled).length, cuts: rows });
      return;
    }
    case 'review': {
      let edl = loadEdl(c);
      const ids = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x)) : []);
      const toggles: [number, boolean][] = [...ids('disable').map((i) => [i, false] as [number, boolean]), ...ids('enable').map((i) => [i, true] as [number, boolean])];
      if (toggles.length || a.speed !== undefined) {
        const cuts = edl.cuts.map((x, i) => {
          const t = toggles.find(([j]) => j === i);
          return t ? { ...x, enabled: t[1], userSet: true } : x;
        });
        edl = { ...edl, cuts, globalSpeed: num(a, 'speed', edl.globalSpeed) };
        edl = saveEdl(c, edl);
      }
      const types = typeof a.type === 'string' ? new Set((a.type as string).split(',')) : undefined;
      const rows = cutList(edl, types);
      if (a.table) printTable(rows);
      done({ edit: file(c, 'edl.json'), ...summary(edl), cuts: rows });
      return;
    }
    case 'captions': {
      const cap = c.settings.captions;
      cap.maxCharsPerLine = num(a, 'max-chars', cap.maxCharsPerLine);
      cap.maxLines = num(a, 'max-lines', cap.maxLines);
      saveSettings(c);
      let edl = loadEdl(c);
      if (!edl.transcript?.words.length) {
        const t = await transcriptOf(c, a);
        if (!t) fail('This video has no audio, so there are no captions.');
        edl = { ...edl, transcript: { ...t } };
      }
      edl = saveEdl(c, edl);
      const base = path.join(path.dirname(c.meta.path), path.basename(c.meta.path, path.extname(c.meta.path)));
      const srt = str(a, 'out', base + '.polished.srt');
      const txt = str(a, 'text', srt.replace(/\.srt$/i, '') + '.txt');
      fs.writeFileSync(srt, toSrt(edl.captions, edl.segments, edl.globalSpeed));
      fs.writeFileSync(txt, toTranscriptText(edl.captions, edl.segments, edl.globalSpeed));
      done({ srt, transcript: txt, captions: edl.captions.length, timing: edl.cuts.some((x) => x.enabled) || edl.globalSpeed !== 1 ? 'edited video' : 'original video' });
      return;
    }
    case 'render': {
      let edl = loadEdl(c);
      if (a.speed !== undefined) edl = saveEdl(c, { ...edl, globalSpeed: num(a, 'speed', edl.globalSpeed) });
      else edl = withSegments(edl);
      const ex = applyExportFlags(c, a);
      saveSettings(c);
      const base = path.join(path.dirname(c.meta.path), path.basename(c.meta.path, path.extname(c.meta.path)));
      const out = path.resolve(str(a, 'out', base + '.polished.mp4'));
      const t0 = Date.now();
      const r = await render(c.meta, edl, { ...ex, out, hardware: !!a.hw }, (phase, f) => log(`Rendering ${phase}… ${Math.round(f * 100)}%`));
      done({ ...r, ...summary(edl), took_seconds: Math.round((Date.now() - t0) / 100) / 10, note: edl.zooms.length ? 'Zoom blocks are in the edit but are not rendered by this skill (use the Polish app for zooms).' : undefined });
      return;
    }
    case 'layout': {
      const v = await visionOf(c);
      const edl = saveEdl(c, { ...loadEdl(c), layout: v.layout });
      done({ edit: file(c, 'edl.json'), content: v.layout.content, radius: v.layout.radius, styled: v.layout.styled,
        webcam: v.layout.webcam.map((w) => ({ from: fmtTime(w.t0), to: fmtTime(w.t1), x: Math.round(w.x), y: Math.round(w.y), r: Math.round(w.r) })), zooms: edl.zooms.length });
      return;
    }
    case 'clicks': {
      const v = await visionOf(c);
      const clicks = v.clicks.map((k) => ({ t: k.t, x: k.x, y: k.y, confidence: k.confidence, reason: k.reason }));
      saveEdl(c, { ...loadEdl(c), layout: v.layout, clicks });
      const min = num(a, 'min-confidence', 0);
      done({ edit: file(c, 'edl.json'), clicks: clicks.length, cursor_frames_seen: v.track.seen.reduce((s, x) => s + x, 0),
        list: clicks.filter((k) => k.confidence >= min).map((k) => ({ at: fmtTime(k.t, true), t: +k.t.toFixed(2), x: Math.round(k.x), y: Math.round(k.y), confidence: +k.confidence.toFixed(2), reason: k.reason })) });
      return;
    }
    case 'zooms': {
      applyZoomFlags(c, a);
      saveSettings(c);
      const v = await visionOf(c);
      let edl = loadEdl(c);
      const manual = edl.zooms.filter((z) => z.source === 'manual');
      const overlaps = (x: { start: number; end: number }, y: { start: number; end: number }) => x.start < y.end && y.start < x.end;
      const auto = planZooms(v.clicks, v.track, v.layout.content, c.settings.zoom, (t0, t1, r) => detailIn(v.detail, t0, t1, r)).filter(
        (z) => !manual.some((m) => overlaps(m, z)) && !(edl.dismissedZooms ?? []).some((d) => overlaps(d, z)),
      );
      edl = saveEdl(c, {
        ...edl, layout: v.layout,
        clicks: v.clicks.map((k) => ({ t: k.t, x: k.x, y: k.y, confidence: k.confidence, reason: k.reason })),
        zooms: [...manual, ...auto].sort((x, y) => x.start - y.start),
      });
      const previews = typeof a.preview === 'string' ? previewZooms(c, edl, a.preview as string) : [];
      done({ edit: file(c, 'edl.json'), zooms: edl.zooms.map((z, i) => ({ index: i, from: fmtTime(z.start, true), to: fmtTime(z.end, true), start: +z.start.toFixed(2), end: +z.end.toFixed(2), scale: z.scale,
        focus: z.focus.map((f) => ({ t: +f.t.toFixed(2), x: Math.round(f.x), y: Math.round(f.y) })), source: z.source })), previews });
      return;
    }
    case 'report': {
      const edl = withSegments(loadEdl(c));
      done({ edit: file(c, 'edl.json'), ...summary(edl) });
      return;
    }
    case 'all': {
      applySilenceFlags(c, a);
      applyFillerFlags(c, a);
      applyExportFlags(c, a);
      saveSettings(c);
      let edl = loadEdl(c);
      edl = await planSilence(c, a, edl);
      if (!a['no-transcript']) edl = await planFillers(c, a, edl);
      if (a.speed !== undefined) edl.globalSpeed = num(a, 'speed', 1);
      edl = saveEdl(c, edl);
      const base = path.join(path.dirname(c.meta.path), path.basename(c.meta.path, path.extname(c.meta.path)));
      const out = path.resolve(str(a, 'out', base + '.polished.mp4'));
      let srt: string | null = null;
      if (edl.captions.length) {
        srt = out.replace(/\.mp4$/i, '') + '.srt';
        fs.writeFileSync(srt, toSrt(edl.captions, edl.segments, edl.globalSpeed));
      }
      const r = await render(c.meta, edl, { ...c.settings.export, out, hardware: !!a.hw }, (phase, f) => log(`Rendering ${phase}… ${Math.round(f * 100)}%`));
      done({ ...r, srt, ...summary(edl) });
      return;
    }
    default:
      fail(`Unknown command "${cmd}". Commands: analyze, transcribe, silence, fillers, review, captions, render, layout, clicks, zooms, report, all.`);
  }
}

main().catch((e) => fail(String(e?.message ?? e)));
