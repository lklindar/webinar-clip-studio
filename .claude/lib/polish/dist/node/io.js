"use strict";
// Node-side I/O for the Polish port: ffprobe/ffmpeg, exact-size frame reading from a pipe,
// the per-video cache folder and typed-array (de)serialisation.
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
exports.RecordReader = void 0;
exports.log = log;
exports.fail = fail;
exports.probe = probe;
exports.ffmpeg = ffmpeg;
exports.writeAll = writeAll;
exports.waitExit = waitExit;
exports.cacheDir = cacheDir;
exports.saveJson = saveJson;
exports.loadJson = loadJson;
exports.sameSource = sameSource;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
function log(msg) {
    process.stderr.write(msg + '\n');
}
function fail(msg) {
    process.stderr.write('Error: ' + msg + '\n');
    process.exit(1);
}
function probe(file) {
    if (!fs.existsSync(file))
        fail(`File not found: ${file}`);
    const r = (0, node_child_process_1.spawnSync)('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
    if (r.error)
        fail('ffprobe is not installed (brew install ffmpeg).');
    if (r.status !== 0)
        fail(`Could not read ${file} as a video: ${r.stderr.slice(-300)}`);
    const info = JSON.parse(r.stdout);
    const v = info.streams.find((s) => s.codec_type === 'video');
    if (!v)
        fail(`${file} has no video track.`);
    const a = info.streams.find((s) => s.codec_type === 'audio');
    let w = Number(v.width), h = Number(v.height);
    const rot = Math.abs(Number(v.tags?.rotate ?? (v.side_data_list ?? []).find((d) => d.rotation != null)?.rotation ?? 0));
    if (rot === 90 || rot === 270)
        [w, h] = [h, w];
    const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
    const fps = d ? n / d : 30;
    const st = fs.statSync(file);
    return {
        path: path.resolve(file),
        durationSec: Number(info.format?.duration ?? v.duration ?? 0),
        width: w,
        height: h,
        fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
        hasAudio: !!a,
        sampleRate: a ? Number(a.sample_rate) : 0,
        channels: a ? Number(a.channels) : 0,
        size: st.size,
        mtimeMs: st.mtimeMs,
    };
}
function ffmpeg(args) {
    const p = (0, node_child_process_1.spawn)('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-2000)));
    p.on('error', () => fail('ffmpeg is not installed (brew install ffmpeg).'));
    p.errText = () => err;
    return p;
}
/** Reads fixed-size records (video frames, PCM blocks) from a readable stream. */
class RecordReader {
    stream;
    chunks = [];
    have = 0;
    ended = false;
    waiting = null;
    constructor(stream) {
        this.stream = stream;
        stream.on('data', (d) => {
            this.chunks.push(d);
            this.have += d.length;
            if (this.have > 64 << 20)
                stream.pause();
            this.wake();
        });
        stream.on('end', () => {
            this.ended = true;
            this.wake();
        });
    }
    wake() {
        const w = this.waiting;
        this.waiting = null;
        w?.();
    }
    /** Fills `out` completely; returns the number of bytes read (< out.length only at the end). */
    async read(out) {
        while (this.have < out.length && !this.ended) {
            this.stream.resume();
            await new Promise((r) => (this.waiting = r));
        }
        let off = 0;
        while (off < out.length && this.chunks.length) {
            const c = this.chunks[0];
            const take = Math.min(c.length, out.length - off);
            out.set(c.subarray(0, take), off);
            off += take;
            if (take === c.length)
                this.chunks.shift();
            else
                this.chunks[0] = c.subarray(take);
        }
        this.have -= off;
        if (this.have < 16 << 20)
            this.stream.resume();
        return off;
    }
}
exports.RecordReader = RecordReader;
async function writeAll(stream, data) {
    if (!stream.write(data))
        await new Promise((r) => stream.once('drain', () => r()));
}
function waitExit(p, what) {
    return new Promise((resolve, reject) => {
        p.on('close', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`ffmpeg failed while ${what}: ${p.errText()}`));
        });
    });
}
// ---------------------------------------------------------------- cache folder
/** `<video folder>/<video name>.polish/` holds analysis, transcript and the edit (edl.json). */
function cacheDir(video) {
    const abs = path.resolve(video);
    const dir = path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + '.polish');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
const TYPED = {
    Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
};
function saveJson(file, value) {
    const json = JSON.stringify(value, (_k, v) => {
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
            const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
            return { __typed: v.constructor.name, b64: buf.toString('base64') };
        }
        return v;
    });
    fs.writeFileSync(file + '.tmp', json);
    fs.renameSync(file + '.tmp', file);
}
function loadJson(file) {
    if (!fs.existsSync(file))
        return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'), (_k, v) => {
        if (v && typeof v === 'object' && typeof v.__typed === 'string' && TYPED[v.__typed]) {
            const b = Buffer.from(v.b64, 'base64');
            const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            return new TYPED[v.__typed](ab);
        }
        return v;
    });
}
/** Same source file as when the cache was made (size + mtime). */
function sameSource(a, b) {
    return !!a && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2;
}
