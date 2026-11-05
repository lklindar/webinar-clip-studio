// Port of polish/src/workers/analyzeAudio.worker.ts: one streamed pass over the audio track →
// 20 ms energy frames (RMS/peak of the mono mix), voicing/pitch/flux features, and a 16 kHz mono
// Float32 PCM file for transcription. Decoding is done by ffmpeg instead of Mediabunny.

import * as fs from 'node:fs';
import { FEATURE_RATE, FeatureExtractor } from '../core/audioFeatures';
import { StreamResampler } from '../core/resample';
import { FRAME_SEC, type AudioAnalysis } from '../core/silence';
import { ffmpeg, RecordReader, waitExit, type SourceMeta } from './io';

export async function analyzeAudio(meta: SourceMeta, pcmPath: string, onProgress: (f: number) => void): Promise<AudioAnalysis> {
  const sr = meta.sampleRate || 48000;
  const channels = meta.channels || 1;
  const duration = meta.durationSec;
  const frameLen = Math.round(FRAME_SEC * sr);
  const nFrames = Math.ceil((duration * sr) / frameLen) + 1;
  const sumsq = new Float64Array(nFrames);
  const counts = new Uint32Array(nFrames);
  const peak = new Float32Array(nFrames);
  const voicing = new Float32Array(nFrames);
  const f0 = new Float32Array(nFrames);
  const flux = new Float32Array(nFrames);
  const features = new FeatureExtractor((i, f) => {
    if (i >= nFrames) return;
    voicing[i] = f.voicing;
    f0[i] = f.f0;
    flux[i] = f.flux;
  });
  const resampler = new StreamResampler(sr, FEATURE_RATE);
  const pcm = fs.openSync(pcmPath, 'w');
  let pcmBytes = 0;
  const emit16k = (x: Float32Array) => {
    if (!x.length) return;
    features.push(x);
    fs.writeSync(pcm, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
    pcmBytes += x.byteLength;
  };

  // Mono mix = mean of the channels (as the worker does), at the source sample rate.
  const p = ffmpeg(['-i', meta.path, '-map', '0:a:0', '-vn', '-ac', String(channels), '-ar', String(sr), '-f', 'f32le', '-']);
  const done = waitExit(p, 'reading the audio');
  const reader = new RecordReader(p.stdout);
  const block = 4096;
  const raw = new Uint8Array(block * channels * 4);
  const mono = new Float32Array(block);
  let idx = 0;
  let lastPost = 0;
  for (;;) {
    const got = await reader.read(raw);
    const n = Math.floor(got / (channels * 4));
    if (n <= 0) break;
    const inter = new Float32Array(raw.buffer, 0, n * channels);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += inter[i * channels + c];
      mono[i] = s / channels;
    }
    emit16k(resampler.push(mono.subarray(0, n)));
    for (let i = 0; i < n; i++) {
      const f = Math.floor((idx + i) / frameLen);
      if (f >= nFrames) break;
      const v = mono[i];
      sumsq[f] += v * v;
      counts[f]++;
      const a = v < 0 ? -v : v;
      if (a > peak[f]) peak[f] = a;
    }
    idx += n;
    const now = Date.now();
    if (now - lastPost > 1000) {
      lastPost = now;
      onProgress(Math.min(1, idx / sr / Math.max(duration, 0.1)));
    }
    if (got < raw.length) break;
  }
  await done;
  emit16k(resampler.flush());
  features.push(new Float32Array(640)); // let the last frames see a full window
  fs.closeSync(pcm);

  const used = Math.min(nFrames, Math.ceil((duration * sr) / frameLen));
  const rms = new Float32Array(used);
  for (let f = 0; f < used; f++) rms[f] = counts[f] ? Math.sqrt(sumsq[f] / counts[f]) : 0;
  return {
    frameSec: FRAME_SEC,
    rms,
    peak: peak.slice(0, used),
    sampleRate: sr,
    channels,
    voicing: voicing.slice(0, used),
    f0: f0.slice(0, used),
    flux: flux.slice(0, used),
  };
}
