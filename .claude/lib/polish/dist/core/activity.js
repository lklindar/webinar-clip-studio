"use strict";
// Visual activity from a low-res frame-diff grid. Cells that are *always* moving (the webcam
// bubble, an animated background) are masked out by comparing each cell to its own rolling median.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUSY_CELLS = exports.DIFF_QUANT = void 0;
exports.computeActivity = computeActivity;
exports.busyFraction = busyFraction;
exports.firstBusyTime = firstBusyTime;
exports.lastBusyTime = lastBusyTime;
exports.DIFF_QUANT = 4;
const CELL_ACTIVE = 4; // mean abs luma diff (0–255) for a cell to count as changed
const MASK_BASELINE = 1.2; // rolling median above this → cell is "always moving"
// A cell changing in more than this share of samples in its window is "always moving" too: a
// talking head is often still enough for a low median, but it's active far more often than UI is.
const MASK_ACTIVE_SHARE = 0.12;
const BLOCK_SEC = 10;
const WINDOW_SEC = 30;
function computeActivity(raw) {
    const cells = raw.cols * raw.rows;
    const blockFrames = Math.max(1, Math.round(BLOCK_SEC * raw.hz));
    const half = Math.round(WINDOW_SEC * raw.hz);
    const blocks = Math.ceil(raw.frames / blockFrames);
    const mask = new Uint8Array(blocks * cells);
    const scratch = new Float32Array(2 * half + blockFrames + 1);
    for (let b = 0; b < blocks; b++) {
        const center0 = b * blockFrames;
        const lo = Math.max(1, center0 - half);
        const hi = Math.min(raw.frames, center0 + blockFrames + half);
        for (let c = 0; c < cells; c++) {
            let n = 0;
            let active = 0;
            for (let f = lo; f < hi; f++) {
                const d = raw.diffs[f * cells + c] / exports.DIFF_QUANT;
                scratch[n++] = d;
                if (d >= CELL_ACTIVE)
                    active++;
            }
            const median = n ? quickSelect(scratch, n, n >> 1) : 0;
            mask[b * cells + c] = median > MASK_BASELINE || (n && active / n > MASK_ACTIVE_SHARE) ? 1 : 0;
        }
    }
    const score = new Float32Array(raw.frames);
    const thr = CELL_ACTIVE * exports.DIFF_QUANT;
    for (let f = 1; f < raw.frames; f++) {
        const b = Math.floor(f / blockFrames);
        let s = 0;
        for (let c = 0; c < cells; c++) {
            if (!mask[b * cells + c] && raw.diffs[f * cells + c] >= thr)
                s++;
        }
        score[f] = s;
    }
    return { hz: raw.hz, score, mask };
}
/**
 * Busy = enough cells changed that it's more than a cursor move (page load, scroll, dropdown).
 * At 5 Hz a moving cursor smears across 2–5 cells of a 24-column grid.
 */
exports.BUSY_CELLS = 6;
function busyFraction(track, start, end) {
    if (!track || end <= start)
        return 0;
    const a = Math.max(0, Math.floor(start * track.hz));
    const b = Math.min(track.score.length, Math.ceil(end * track.hz));
    if (b <= a)
        return 0;
    let busy = 0;
    for (let i = a; i < b; i++)
        if (track.score[i] >= exports.BUSY_CELLS)
            busy++;
    return busy / (b - a);
}
function firstBusyTime(track, from = 0) {
    if (!track)
        return Infinity;
    for (let i = Math.max(0, Math.floor(from * track.hz)); i < track.score.length; i++) {
        if (track.score[i] >= exports.BUSY_CELLS)
            return i / track.hz;
    }
    return Infinity;
}
function lastBusyTime(track) {
    if (!track)
        return -Infinity;
    for (let i = track.score.length - 1; i >= 0; i--)
        if (track.score[i] >= exports.BUSY_CELLS)
            return i / track.hz;
    return -Infinity;
}
/** In-place k-th smallest of arr[0..n). */
function quickSelect(arr, n, k) {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const pivot = arr[(lo + hi) >> 1];
        let i = lo;
        let j = hi;
        while (i <= j) {
            while (arr[i] < pivot)
                i++;
            while (arr[j] > pivot)
                j--;
            if (i <= j) {
                const t = arr[i];
                arr[i] = arr[j];
                arr[j] = t;
                i++;
                j--;
            }
        }
        if (k <= j)
            hi = j;
        else if (k >= i)
            lo = i;
        else
            break;
    }
    return arr[k];
}
