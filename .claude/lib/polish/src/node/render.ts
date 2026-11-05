// Port of polish/src/workers/export.worker.ts for Node: applies the EDL (cuts, speed-ups, soft cuts,
// audio fades, whole-video speed) with ffmpeg decoding/encoding and Polish's own audio assembler and
// WSOLA time-stretcher. Zooms and burned-in captions (the WebGL compositor) are not rendered here.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AudioAssembler } from '../core/audioAssembler';
import { TimeStretcher } from '../core/timeStretch';
import { cutBefore, segmentOutStarts, softCutMix, type EDL } from '../core/edl';
import { webcamAt, type Layout, type Rect } from '../core/layout';
import { EXPORT_AUDIO_BITRATE, exportVideoBitrate, outputSize, type ExportSettings } from '../core/settings';
import { ffmpeg, log, RecordReader, waitExit, writeAll, type SourceMeta } from './io';

/** From polish/src/render/softCut.ts: above this mean grey difference a dissolve would ghost. */
const SOFT_CUT_MAX_DIFF = 11;
const N24 = 24;

function cutRegion(layout: Layout | undefined, t: number, w: number, h: number): Rect {
  const cam = layout ? webcamAt(layout.webcam, t) : null;
  if (!cam) return { x: 0, y: 0, w, h };
  const s = cam.r * 1.2;
  return { x: cam.x - s / 2, y: cam.y - s / 2, w: s, h: s };
}

/** Mean luma difference of a 24×24 sampling of `r` (output px) in two yuv420p frames. */
function similar(a: Uint8Array, b: Uint8Array, W: number, H: number, r: Rect): boolean {
  let sum = 0;
  for (let j = 0; j < N24; j++) {
    const y = Math.min(H - 1, Math.max(0, Math.floor(r.y + ((j + 0.5) * r.h) / N24)));
    for (let i = 0; i < N24; i++) {
      const x = Math.min(W - 1, Math.max(0, Math.floor(r.x + ((i + 0.5) * r.w) / N24)));
      // Y is limited range (16–235); scale the difference to full range like the RGB grey value.
      sum += (Math.abs(a[y * W + x] - b[y * W + x]) * 255) / 219;
    }
  }
  return sum / (N24 * N24) <= SOFT_CUT_MAX_DIFF;
}

export interface RenderOptions extends ExportSettings {
  out: string;
  hardware: boolean;
}

export async function render(meta: SourceMeta, edl: EDL, o: RenderOptions, onProgress: (phase: string, f: number) => void) {
  const segs = edl.segments;
  if (!segs.length) throw new Error('Nothing is left to render: every part of the video is cut.');
  const starts = segmentOutStarts(segs);
  const fps = Math.round(edl.source.fps) || 30;
  const size = outputSize({ width: meta.width, height: meta.height }, o.resolution);
  const W = size.width;
  const H = size.height;
  const k = W / meta.width;
  const tmpAudio = path.join(os.tmpdir(), `polish-audio-${process.pid}-${Date.now()}.f32`);
  const first = segs[0].srcStart;
  const lastEnd = segs[segs.length - 1].srcEnd;

  // ---- audio: assemble (fades at cuts, decimated speed-ups) → time-stretch (global speed) → file
  const sr = meta.sampleRate || 48000;
  const ch = Math.max(1, meta.channels || 1);
  if (meta.hasAudio) {
    const fd = fs.openSync(tmpAudio, 'w');
    const writePlanes = (planes: Float32Array[]) => {
      const n = planes[0]?.length ?? 0;
      if (!n) return;
      const inter = new Float32Array(n * ch);
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) inter[i * ch + c] = planes[c][i];
      fs.writeSync(fd, Buffer.from(inter.buffer));
    };
    const stretcher = new TimeStretcher(sr, ch, edl.globalSpeed);
    const assembler = new AudioAssembler(segs, {
      sampleRate: sr,
      channels: ch,
      fadeSec: o.fadeMs / 1000,
      emit: (planes) => writePlanes(stretcher.push(planes)),
    });
    const startFrame = Math.floor(first * sr);
    const p = ffmpeg(['-ss', (startFrame / sr).toFixed(6), '-i', meta.path, '-map', '0:a:0', '-vn', '-ac', String(ch), '-ar', String(sr), '-f', 'f32le', '-']);
    const done = waitExit(p, 'reading the audio');
    const reader = new RecordReader(p.stdout);
    const blockFrames = 8192;
    const raw = new Uint8Array(blockFrames * ch * 4);
    let pos = startFrame;
    let lastPost = 0;
    for (;;) {
      const got = await reader.read(raw);
      const n = Math.floor(got / (ch * 4));
      if (n <= 0) break;
      const inter = new Float32Array(raw.buffer.slice(0, n * ch * 4));
      const planes = Array.from({ length: ch }, (_, c) => {
        const pl = new Float32Array(n);
        for (let i = 0; i < n; i++) pl[i] = inter[i * ch + c];
        return pl;
      });
      await assembler.push(planes, pos);
      pos += n;
      if (Date.now() - lastPost > 1000) {
        lastPost = Date.now();
        onProgress('audio', Math.min(1, (pos / sr - first) / Math.max(1e-6, lastEnd - first)));
      }
      if (pos / sr > lastEnd + 1 || got < raw.length) break;
    }
    p.kill();
    await done.catch(() => {});
    await assembler.finish();
    writePlanes(stretcher.flush());
    fs.closeSync(fd);
  }

  // ---- video: one decode pass → keep / drop / soft-cut frames on the output grid → encoder
  const frameBytes = W * H * 1.5;
  const lumaBytes = W * H;
  const enc = ffmpeg([
    '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
    ...(meta.hasAudio ? ['-f', 'f32le', '-ar', String(sr), '-ac', String(ch), '-i', tmpAudio] : []),
    '-map', '0:v', ...(meta.hasAudio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', String(EXPORT_AUDIO_BITRATE)] : []),
    ...(o.hardware
      ? ['-c:v', 'h264_videotoolbox', '-b:v', String(exportVideoBitrate(o.bitrateMbps, size, fps))]
      : ['-c:v', 'libx264', '-preset', 'medium', '-b:v', String(exportVideoBitrate(o.bitrateMbps, size, fps)), '-profile:v', 'high']),
    '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-movflags', '+faststart', o.out,
  ]);
  const encDone = waitExit(enc, 'encoding');
  const dec = ffmpeg(['-ss', first.toFixed(6), '-i', meta.path, '-map', '0:v:0', '-an',
    '-vf', `fps=${fps},scale=${W}:${H}:flags=bicubic,format=yuv420p`, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  const decDone = waitExit(dec, 'reading the video');
  const reader = new RecordReader(dec.stdout);

  const dt = 1 / fps;
  const softSec = (o.softCutMs ?? 0) / 1000;
  const totalSrc = segs.reduce((a, s) => a + (s.srcEnd - s.srcStart), 0) || 1;
  let cur: Uint8Array = new Uint8Array(frameBytes);
  let last: Uint8Array | null = null;
  let fade: { from: Uint8Array; outStart: number } | null = null;
  const mixed = new Uint8Array(frameBytes);
  let fadedSeg = -1;
  let nextGrid = 0;
  let si = 0;
  let doneSrc = 0;
  let framesOut = 0;
  let lastPost = 0;
  for (let fi = 0; ; fi++) {
    const got = await reader.read(cur);
    if (got < frameBytes) break;
    const ts = first + fi / fps;
    while (si < segs.length && ts >= segs[si].srcEnd) {
      doneSrc += segs[si].srcEnd - segs[si].srcStart;
      si++;
    }
    if (si >= segs.length) break;
    const seg = segs[si];
    if (ts < seg.srcStart - 1e-4) continue;
    const outT = (starts[si] + (ts - seg.srcStart) / seg.speed) / edl.globalSpeed;
    if (outT + dt / 2 < nextGrid) continue; // dropped by a speed-up
    if (softSec > 0 && si !== fadedSeg && cutBefore(segs, si) && last) {
      fadedSeg = si;
      fade = null;
      const r = cutRegion(edl.layout, ts, meta.width, meta.height);
      if (similar(last, cur, W, H, { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k })) {
        fade = { from: last, outStart: starts[si] / edl.globalSpeed };
        last = null;
      }
    }
    const mix = fade ? softCutMix(outT - fade.outStart, softSec) : 0;
    if (fade && mix === 0 && outT - fade.outStart >= softSec) fade = null;
    let frame = cur;
    if (fade && mix > 0) {
      const a = 1 - mix;
      const from = fade.from;
      for (let i = 0; i < frameBytes; i++) mixed[i] = (cur[i] * a + from[i] * mix + 0.5) | 0;
      frame = mixed;
    }
    while (nextGrid <= outT + dt / 2) {
      await writeAll(enc.stdin, frame);
      nextGrid += dt;
      framesOut++;
    }
    // Keep this frame as "last before a cut" candidate; recycle the old buffer.
    const spare: Uint8Array = last ?? new Uint8Array(frameBytes);
    last = cur;
    cur = spare;
    if (Date.now() - lastPost > 1000) {
      lastPost = Date.now();
      onProgress('video', Math.min(1, (doneSrc + (ts - seg.srcStart)) / totalSrc));
    }
  }
  dec.kill();
  await decDone.catch(() => {});
  enc.stdin.end();
  await encDone;
  if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio);
  void lumaBytes;
  log(`Rendered ${framesOut} frames.`);
  return { out: o.out, width: W, height: H, fps, frames: framesOut, durationSec: framesOut / fps };
}
