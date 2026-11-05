"use strict";
// Edit Decision List: the single source of truth for an edit. Nothing is re-encoded until export.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_SEGMENT_SEC = void 0;
exports.emptyEdl = emptyEdl;
exports.mergeRanges = mergeRanges;
exports.buildSegments = buildSegments;
exports.cutBefore = cutBefore;
exports.softCutMix = softCutMix;
exports.withSegments = withSegments;
exports.segmentOutStarts = segmentOutStarts;
exports.outputDuration = outputDuration;
exports.segmentIndexAt = segmentIndexAt;
exports.nextSegmentIndex = nextSegmentIndex;
exports.srcToOut = srcToOut;
exports.outToSrc = outToSrc;
exports.clamp = clamp;
exports.editStats = editStats;
/** Kept pieces shorter than this are swallowed by neighbouring cuts (avoids flashes and clicks). */
exports.MIN_SEGMENT_SEC = 0.08;
function emptyEdl(source) {
    return {
        source,
        segments: [{ srcStart: 0, srcEnd: source.durationSec, speed: 1, reason: 'keep' }],
        cuts: [],
        speedups: [],
        zooms: [],
        clicks: [],
        captions: [],
        audio: { denoise: true, targetLufs: -16 },
        style: {},
        globalSpeed: 1,
    };
}
/** Union of overlapping/touching ranges, sorted. */
function mergeRanges(ranges, joinGap = 0) {
    const sorted = ranges
        .filter((r) => r.end > r.start)
        .map((r) => ({ start: r.start, end: r.end }))
        .sort((a, b) => a.start - b.start);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r.start <= last.end + joinGap)
            last.end = Math.max(last.end, r.end);
        else
            out.push({ ...r });
    }
    return out;
}
/**
 * Turns enabled cuts and speed-ups into the ordered list of kept segments.
 * Cuts win over speed-ups. Kept slivers shorter than MIN_SEGMENT_SEC merge into the cut.
 */
function buildSegments(durationSec, cuts, speedups) {
    const removed = mergeRanges(cuts.filter((c) => c.enabled).map((c) => ({ start: clamp(c.start, 0, durationSec), end: clamp(c.end, 0, durationSec) })), exports.MIN_SEGMENT_SEC);
    // Kept ranges = complement of removed.
    const kept = [];
    let t = 0;
    for (const r of removed) {
        if (r.start - t >= exports.MIN_SEGMENT_SEC)
            kept.push({ start: t, end: r.start });
        t = Math.max(t, r.end);
    }
    if (durationSec - t >= exports.MIN_SEGMENT_SEC)
        kept.push({ start: t, end: durationSec });
    const fast = speedups.filter((s) => s.enabled && s.end > s.start).sort((a, b) => a.start - b.start);
    const segments = [];
    for (const k of kept) {
        let cursor = k.start;
        for (const s of fast) {
            const a = Math.max(s.start, k.start);
            const b = Math.min(s.end, k.end);
            if (b - a < exports.MIN_SEGMENT_SEC || a < cursor)
                continue;
            if (a - cursor > 1e-6)
                segments.push({ srcStart: cursor, srcEnd: a, speed: 1, reason: 'keep' });
            segments.push({ srcStart: a, srcEnd: b, speed: s.speed, reason: 'speedup' });
            cursor = b;
        }
        if (k.end - cursor > 1e-6)
            segments.push({ srcStart: cursor, srcEnd: k.end, speed: 1, reason: 'keep' });
    }
    return segments;
}
/** True when segment `i` starts after a cut (not where a speed-up begins or ends). */
function cutBefore(segments, i) {
    return i > 0 && i < segments.length && Math.abs(segments[i - 1].srcEnd - segments[i].srcStart) > 1e-6;
}
/**
 * Soft cut: how much of the last frame before a cut still shows, `t` output seconds after it.
 * Starts at 0.85 (the new shot is already visible, so lips stay in sync) and eases out.
 */
function softCutMix(t, durSec) {
    if (durSec <= 0 || t < 0 || t >= durSec)
        return 0;
    const x = t / durSec;
    return 0.85 * (1 - x * x * (3 - 2 * x));
}
/** Recomputes `segments` from the EDL's cuts and speed-ups. */
function withSegments(edl) {
    return { ...edl, segments: buildSegments(edl.source.durationSec, edl.cuts, edl.speedups) };
}
/** Output start time of each segment (before global speed), plus total at the end. */
function segmentOutStarts(segments) {
    const starts = new Array(segments.length + 1);
    let acc = 0;
    for (let i = 0; i < segments.length; i++) {
        starts[i] = acc;
        acc += (segments[i].srcEnd - segments[i].srcStart) / segments[i].speed;
    }
    starts[segments.length] = acc;
    return starts;
}
function outputDuration(segments, globalSpeed = 1) {
    return segmentOutStarts(segments)[segments.length] / globalSpeed;
}
/** Index of the segment containing src time `t`, or -1 when `t` is inside a cut. */
function segmentIndexAt(segments, t) {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = segments[mid];
        if (t < s.srcStart)
            hi = mid - 1;
        else if (t >= s.srcEnd)
            lo = mid + 1;
        else
            return mid;
    }
    return -1;
}
/** Index of the first segment starting at or after src time `t` (segments.length if none). */
function nextSegmentIndex(segments, t) {
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (segments[mid].srcEnd <= t)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
/** Source → output time. Times inside a cut snap to where the next kept segment begins. */
function srcToOut(segments, t, globalSpeed = 1) {
    const starts = segmentOutStarts(segments);
    const i = nextSegmentIndex(segments, t);
    if (i >= segments.length)
        return starts[segments.length] / globalSpeed;
    const s = segments[i];
    const local = Math.max(0, t - s.srcStart) / s.speed;
    return (starts[i] + local) / globalSpeed;
}
/** Output → source time. */
function outToSrc(segments, tOut, globalSpeed = 1) {
    if (segments.length === 0)
        return 0;
    const starts = segmentOutStarts(segments);
    const target = Math.max(0, tOut * globalSpeed);
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= target)
            lo = mid;
        else
            hi = mid - 1;
    }
    const s = segments[lo];
    return Math.min(s.srcEnd, s.srcStart + (target - starts[lo]) * s.speed);
}
function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}
/** Summary used in the edit report. */
function editStats(edl) {
    const out = outputDuration(edl.segments, edl.globalSpeed);
    const enabled = edl.cuts.filter((c) => c.enabled);
    return {
        sourceSec: edl.source.durationSec,
        outputSec: out,
        removedSec: edl.source.durationSec - out,
        silences: enabled.filter((c) => c.type === 'silence').length,
        fillers: enabled.filter((c) => c.type === 'filler').length,
        repeats: enabled.filter((c) => c.type === 'repeat').length,
        manual: enabled.filter((c) => c.type === 'manual').length,
        speedups: edl.speedups.filter((s) => s.enabled).length,
        zooms: edl.zooms.length,
    };
}
