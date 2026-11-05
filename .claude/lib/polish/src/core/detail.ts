// Where the screen has something to look at. Zooms exist so viewers can read what's being shown;
// zooming into blank page background helps no one. The video analysis keeps, once a second, the
// share of edge pixels per small cell (text and UI are dense with edges, empty background has
// none); here the webcam bubble and everything outside the window are masked out.

import type { FrameData } from './frameData';
import { webcamAt, type Layout, type Rect } from './layout';

export interface DetailMap {
  cols: number;
  rows: number;
  /** Cell size in source px. */
  cell: number;
  everySec: number;
  count: number;
  /** 0–255 per cell per sample, 0 where masked. */
  data: Uint8Array;
}

export function buildDetail(fd: FrameData, layout: Layout): DetailMap {
  const { cols, rows, cell, everySec, count } = fd.detail;
  const data = fd.detail.data.slice();
  const cs = cell / fd.scale;
  const c = layout.content;
  for (let k = 0; k < count; k++) {
    const cam = webcamAt(layout.webcam, k * everySec);
    const base = k * cols * rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const sx = (x + 0.5) * cs;
        const sy = (y + 0.5) * cs;
        const out = sx < c.x || sy < c.y || sx > c.x + c.w || sy > c.y + c.h;
        if (out || (cam && Math.hypot(sx - cam.x, sy - cam.y) < cam.r * 1.1 + cs)) data[base + y * cols + x] = 0;
      }
    }
  }
  return { cols, rows, cell: cs, everySec, count, data };
}

/** Mean detail (0–1) inside `r` (source px) in sample `k`. */
function densityAt(d: DetailMap, k: number, r: Rect): number {
  const x0 = Math.max(0, Math.floor(r.x / d.cell));
  const y0 = Math.max(0, Math.floor(r.y / d.cell));
  const x1 = Math.min(d.cols, Math.ceil((r.x + r.w) / d.cell));
  const y1 = Math.min(d.rows, Math.ceil((r.y + r.h) / d.cell));
  if (x1 <= x0 || y1 <= y0) return 0;
  const base = k * d.cols * d.rows;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += d.data[base + y * d.cols + x];
  return n / 255 / ((x1 - x0) * (y1 - y0));
}

/**
 * Detail in `r` over [t0, t1]: the median of the per-second samples, i.e. what the view mostly
 * shows during that time (a page still loading for a moment doesn't count as empty, nor does a
 * flash of content count as full).
 */
export function detailIn(d: DetailMap, t0: number, t1: number, r: Rect): number {
  const k0 = Math.max(0, Math.round(t0 / d.everySec));
  const k1 = Math.min(d.count - 1, Math.max(k0, Math.round(t1 / d.everySec)));
  const v: number[] = [];
  for (let k = k0; k <= k1; k++) v.push(densityAt(d, k, r));
  v.sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}
