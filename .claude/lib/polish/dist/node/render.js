"use strict";
// Port of polish/src/workers/export.worker.ts for Node: applies the EDL (cuts, speed-ups, soft cuts,
// audio fades, whole-video speed) with ffmpeg decoding/encoding and Polish's own audio assembler and
// WSOLA time-stretcher. Zooms and burned-in captions (the WebGL compositor) are not rendered here.
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
exports.render = render;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const audioAssembler_1 = require("../core/audioAssembler");
const timeStretch_1 = require("../core/timeStretch");
const edl_1 = require("../core/edl");
const layout_1 = require("../core/layout");
const settings_1 = require("../core/settings");
const io_1 = require("./io");
/** From polish/src/render/softCut.ts: above this mean grey difference a dissolve would ghost. */
const SOFT_CUT_MAX_DIFF = 11;
const N24 = 24;
function cutRegion(layout, t, w, h) {
    const cam = layout ? (0, layout_1.webcamAt)(layout.webcam, t) : null;
    if (!cam)
        return { x: 0, y: 0, w, h };
    const s = cam.r * 1.2;
    return { x: cam.x - s / 2, y: cam.y - s / 2, w: s, h: s };
}
/** Mean luma difference of a 24×24 sampling of `r` (output px) in two yuv420p frames. */
function similar(a, b, W, H, r) {
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
async function render(meta, edl, o, onProgress) {
    const segs = edl.segments;
    if (!segs.length)
        throw new Error('Nothing is left to render: every part of the video is cut.');
    const starts = (0, edl_1.segmentOutStarts)(segs);
    const fps = Math.round(edl.source.fps) || 30;
    const size = (0, settings_1.outputSize)({ width: meta.width, height: meta.height }, o.resolution);
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
        const writePlanes = (planes) => {
            const n = planes[0]?.length ?? 0;
            if (!n)
                return;
            const inter = new Float32Array(n * ch);
            for (let i = 0; i < n; i++)
                for (let c = 0; c < ch; c++)
                    inter[i * ch + c] = planes[c][i];
            fs.writeSync(fd, Buffer.from(inter.buffer));
        };
        const stretcher = new timeStretch_1.TimeStretcher(sr, ch, edl.globalSpeed);
        const assembler = new audioAssembler_1.AudioAssembler(segs, {
            sampleRate: sr,
            channels: ch,
            fadeSec: o.fadeMs / 1000,
            emit: (planes) => writePlanes(stretcher.push(planes)),
        });
        const startFrame = Math.floor(first * sr);
        const p = (0, io_1.ffmpeg)(['-ss', (startFrame / sr).toFixed(6), '-i', meta.path, '-map', '0:a:0', '-vn', '-ac', String(ch), '-ar', String(sr), '-f', 'f32le', '-']);
        const done = (0, io_1.waitExit)(p, 'reading the audio');
        const reader = new io_1.RecordReader(p.stdout);
        const blockFrames = 8192;
        const raw = new Uint8Array(blockFrames * ch * 4);
        let pos = startFrame;
        let lastPost = 0;
        for (;;) {
            const got = await reader.read(raw);
            const n = Math.floor(got / (ch * 4));
            if (n <= 0)
                break;
            const inter = new Float32Array(raw.buffer.slice(0, n * ch * 4));
            const planes = Array.from({ length: ch }, (_, c) => {
                const pl = new Float32Array(n);
                for (let i = 0; i < n; i++)
                    pl[i] = inter[i * ch + c];
                return pl;
            });
            await assembler.push(planes, pos);
            pos += n;
            if (Date.now() - lastPost > 1000) {
                lastPost = Date.now();
                onProgress('audio', Math.min(1, (pos / sr - first) / Math.max(1e-6, lastEnd - first)));
            }
            if (pos / sr > lastEnd + 1 || got < raw.length)
                break;
        }
        p.kill();
        await done.catch(() => { });
        await assembler.finish();
        writePlanes(stretcher.flush());
        fs.closeSync(fd);
    }
    // ---- video: one decode pass → keep / drop / soft-cut frames on the output grid → encoder
    const frameBytes = W * H * 1.5;
    const lumaBytes = W * H;
    const enc = (0, io_1.ffmpeg)([
        '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
        ...(meta.hasAudio ? ['-f', 'f32le', '-ar', String(sr), '-ac', String(ch), '-i', tmpAudio] : []),
        '-map', '0:v', ...(meta.hasAudio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', String(settings_1.EXPORT_AUDIO_BITRATE)] : []),
        ...(o.hardware
            ? ['-c:v', 'h264_videotoolbox', '-b:v', String((0, settings_1.exportVideoBitrate)(o.bitrateMbps, size, fps))]
            : ['-c:v', 'libx264', '-preset', 'medium', '-b:v', String((0, settings_1.exportVideoBitrate)(o.bitrateMbps, size, fps)), '-profile:v', 'high']),
        '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-movflags', '+faststart', o.out,
    ]);
    const encDone = (0, io_1.waitExit)(enc, 'encoding');
    const dec = (0, io_1.ffmpeg)(['-ss', first.toFixed(6), '-i', meta.path, '-map', '0:v:0', '-an',
        '-vf', `fps=${fps},scale=${W}:${H}:flags=bicubic,format=yuv420p`, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    const decDone = (0, io_1.waitExit)(dec, 'reading the video');
    const reader = new io_1.RecordReader(dec.stdout);
    const dt = 1 / fps;
    const softSec = (o.softCutMs ?? 0) / 1000;
    const totalSrc = segs.reduce((a, s) => a + (s.srcEnd - s.srcStart), 0) || 1;
    let cur = new Uint8Array(frameBytes);
    let last = null;
    let fade = null;
    const mixed = new Uint8Array(frameBytes);
    let fadedSeg = -1;
    let nextGrid = 0;
    let si = 0;
    let doneSrc = 0;
    let framesOut = 0;
    let lastPost = 0;
    for (let fi = 0;; fi++) {
        const got = await reader.read(cur);
        if (got < frameBytes)
            break;
        const ts = first + fi / fps;
        while (si < segs.length && ts >= segs[si].srcEnd) {
            doneSrc += segs[si].srcEnd - segs[si].srcStart;
            si++;
        }
        if (si >= segs.length)
            break;
        const seg = segs[si];
        if (ts < seg.srcStart - 1e-4)
            continue;
        const outT = (starts[si] + (ts - seg.srcStart) / seg.speed) / edl.globalSpeed;
        if (outT + dt / 2 < nextGrid)
            continue; // dropped by a speed-up
        if (softSec > 0 && si !== fadedSeg && (0, edl_1.cutBefore)(segs, si) && last) {
            fadedSeg = si;
            fade = null;
            const r = cutRegion(edl.layout, ts, meta.width, meta.height);
            if (similar(last, cur, W, H, { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k })) {
                fade = { from: last, outStart: starts[si] / edl.globalSpeed };
                last = null;
            }
        }
        const mix = fade ? (0, edl_1.softCutMix)(outT - fade.outStart, softSec) : 0;
        if (fade && mix === 0 && outT - fade.outStart >= softSec)
            fade = null;
        let frame = cur;
        if (fade && mix > 0) {
            const a = 1 - mix;
            const from = fade.from;
            for (let i = 0; i < frameBytes; i++)
                mixed[i] = (cur[i] * a + from[i] * mix + 0.5) | 0;
            frame = mixed;
        }
        while (nextGrid <= outT + dt / 2) {
            await (0, io_1.writeAll)(enc.stdin, frame);
            nextGrid += dt;
            framesOut++;
        }
        // Keep this frame as "last before a cut" candidate; recycle the old buffer.
        const spare = last ?? new Uint8Array(frameBytes);
        last = cur;
        cur = spare;
        if (Date.now() - lastPost > 1000) {
            lastPost = Date.now();
            onProgress('video', Math.min(1, (doneSrc + (ts - seg.srcStart)) / totalSrc));
        }
    }
    dec.kill();
    await decDone.catch(() => { });
    enc.stdin.end();
    await encDone;
    if (fs.existsSync(tmpAudio))
        fs.unlinkSync(tmpAudio);
    void lumaBytes;
    (0, io_1.log)(`Rendered ${framesOut} frames.`);
    return { out: o.out, width: W, height: H, fps, frames: framesOut, durationSec: framesOut / fps };
}
