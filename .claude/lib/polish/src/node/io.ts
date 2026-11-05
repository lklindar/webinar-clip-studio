// Node-side I/O for the Polish port: ffprobe/ffmpeg, exact-size frame reading from a pipe,
// the per-video cache folder and typed-array (de)serialisation.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SourceMeta {
  path: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  sampleRate: number;
  channels: number;
  size: number;
  mtimeMs: number;
}

export function log(msg: string) {
  process.stderr.write(msg + '\n');
}

export function fail(msg: string): never {
  process.stderr.write('Error: ' + msg + '\n');
  process.exit(1);
}

export function probe(file: string): SourceMeta {
  if (!fs.existsSync(file)) fail(`File not found: ${file}`);
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  if (r.error) fail('ffprobe is not installed (brew install ffmpeg).');
  if (r.status !== 0) fail(`Could not read ${file} as a video: ${r.stderr.slice(-300)}`);
  const info = JSON.parse(r.stdout);
  const v = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  if (!v) fail(`${file} has no video track.`);
  const a = info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  let w = Number(v.width), h = Number(v.height);
  const rot = Math.abs(Number(v.tags?.rotate ?? (v.side_data_list ?? []).find((d: { rotation?: number }) => d.rotation != null)?.rotation ?? 0));
  if (rot === 90 || rot === 270) [w, h] = [h, w];
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

export function ffmpeg(args: string[]): ChildProcessWithoutNullStreams {
  const p = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args]);
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-2000)));
  p.on('error', () => fail('ffmpeg is not installed (brew install ffmpeg).'));
  (p as unknown as { errText: () => string }).errText = () => err;
  return p;
}

/** Reads fixed-size records (video frames, PCM blocks) from a readable stream. */
export class RecordReader {
  private chunks: Buffer[] = [];
  private have = 0;
  private ended = false;
  private waiting: (() => void) | null = null;

  constructor(private readonly stream: NodeJS.ReadableStream) {
    stream.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.have += d.length;
      if (this.have > 64 << 20) stream.pause();
      this.wake();
    });
    stream.on('end', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  /** Fills `out` completely; returns the number of bytes read (< out.length only at the end). */
  async read(out: Uint8Array): Promise<number> {
    while (this.have < out.length && !this.ended) {
      this.stream.resume();
      await new Promise<void>((r) => (this.waiting = r));
    }
    let off = 0;
    while (off < out.length && this.chunks.length) {
      const c = this.chunks[0];
      const take = Math.min(c.length, out.length - off);
      out.set(c.subarray(0, take), off);
      off += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.have -= off;
    if (this.have < 16 << 20) this.stream.resume();
    return off;
  }
}

export async function writeAll(stream: NodeJS.WritableStream, data: Uint8Array) {
  if (!stream.write(data)) await new Promise<void>((r) => stream.once('drain', () => r()));
}

export function waitExit(p: ChildProcessWithoutNullStreams, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed while ${what}: ${(p as unknown as { errText: () => string }).errText()}`));
    });
  });
}

// ---------------------------------------------------------------- cache folder

/** `<video folder>/<video name>.polish/` holds analysis, transcript and the edit (edl.json). */
export function cacheDir(video: string): string {
  const abs = path.resolve(video);
  const dir = path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + '.polish');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const TYPED: Record<string, { new (b: ArrayBuffer): ArrayBufferView }> = {
  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
};

export function saveJson(file: string, value: unknown) {
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

export function loadJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'), (_k, v) => {
    if (v && typeof v === 'object' && typeof v.__typed === 'string' && TYPED[v.__typed]) {
      const b = Buffer.from(v.b64, 'base64');
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return new TYPED[v.__typed](ab);
    }
    return v;
  }) as T;
}

/** Same source file as when the cache was made (size + mtime). */
export function sameSource(a: SourceMeta | null | undefined, b: SourceMeta): boolean {
  return !!a && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2;
}
