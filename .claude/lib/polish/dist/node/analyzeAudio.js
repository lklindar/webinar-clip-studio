"use strict";
// Port of polish/src/workers/analyzeAudio.worker.ts: one streamed pass over the audio track →
// 20 ms energy frames (RMS/peak of the mono mix), voicing/pitch/flux features, and a 16 kHz mono
// Float32 PCM file for transcription. Decoding is done by ffmpeg instead of Mediabunny.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeAudio = analyzeAudio;
const fs = __importStar(require("node:fs"));
const audioFeatures_1 = require("../core/audioFeatures");
const resample_1 = require("../core/resample");
const silence_1 = require("../core/silence");
const io_1 = require("./io");
async function analyzeAudio(meta, pcmPath, onProgress) {
    const sr = meta.sampleRate || 48000;
    const channels = meta.channels || 1;
    const duration = meta.durationSec;
    const frameLen = Math.round(silence_1.FRAME_SEC * sr);
    const nFrames = Math.ceil((duration * sr) / frameLen) + 1;
    const sumsq = new Float64Array(nFrames);
    const counts = new Uint32Array(nFrames);
    const peak = new Float32Array(nFrames);
    const voicing = new Float32Array(nFrames);
    const f0 = new Float32Array(nFrames);
    const flux = new Float32Array(nFrames);
    const features = new audioFeatures_1.FeatureExtractor((i, f) => {
        if (i >= nFrames)
            return;
        voicing[i] = f.voicing;
        f0[i] = f.f0;
        flux[i] = f.flux;
    });
    const resampler = new resample_1.StreamResampler(sr, audioFeatures_1.FEATURE_RATE);
    const pcm = fs.openSync(pcmPath, 'w');
    let pcmBytes = 0;
    const emit16k = (x) => {
        if (!x.length)
            return;
        features.push(x);
        fs.writeSync(pcm, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
        pcmBytes += x.byteLength;
    };
    // Mono mix = mean of the channels (as the worker does), at the source sample rate.
    const p = (0, io_1.ffmpeg)(['-i', meta.path, '-map', '0:a:0', '-vn', '-ac', String(channels), '-ar', String(sr), '-f', 'f32le', '-']);
    const done = (0, io_1.waitExit)(p, 'reading the audio');
    const reader = new io_1.RecordReader(p.stdout);
    const block = 4096;
    const raw = new Uint8Array(block * channels * 4);
    const mono = new Float32Array(block);
    let idx = 0;
    let lastPost = 0;
    for (;;) {
        const got = await reader.read(raw);
        const n = Math.floor(got / (channels * 4));
        if (n <= 0)
            break;
        const inter = new Float32Array(raw.buffer, 0, n * channels);
        for (let i = 0; i < n; i++) {
            let s = 0;
            for (let c = 0; c < channels; c++)
                s += inter[i * channels + c];
            mono[i] = s / channels;
        }
        emit16k(resampler.push(mono.subarray(0, n)));
        for (let i = 0; i < n; i++) {
            const f = Math.floor((idx + i) / frameLen);
            if (f >= nFrames)
                break;
            const v = mono[i];
            sumsq[f] += v * v;
            counts[f]++;
            const a = v < 0 ? -v : v;
            if (a > peak[f])
                peak[f] = a;
        }
        idx += n;
        const now = Date.now();
        if (now - lastPost > 1000) {
            lastPost = now;
            onProgress(Math.min(1, idx / sr / Math.max(duration, 0.1)));
        }
        if (got < raw.length)
            break;
    }
    await done;
    emit16k(resampler.flush());
    features.push(new Float32Array(640)); // let the last frames see a full window
    fs.closeSync(pcm);
    const used = Math.min(nFrames, Math.ceil((duration * sr) / frameLen));
    const rms = new Float32Array(used);
    for (let f = 0; f < used; f++)
        rms[f] = counts[f] ? Math.sqrt(sumsq[f] / counts[f]) : 0;
    return {
        frameSec: silence_1.FRAME_SEC,
        rms,
        peak: peak.slice(0, used),
        sampleRate: sr,
        channels,
        voicing: voicing.slice(0, used),
        f0: f0.slice(0, used),
        flux: flux.slice(0, used),
    };
}
