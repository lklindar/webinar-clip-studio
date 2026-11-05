"use strict";
// Silence detection on 20 ms energy frames with a threshold that adapts to the file's own levels.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FRAME_SEC = void 0;
exports.toDb = toDb;
exports.smoothedDb = smoothedDb;
exports.percentile = percentile;
exports.adaptiveLevels = adaptiveLevels;
exports.detectPauses = detectPauses;
exports.planSilenceEdits = planSilenceEdits;
const activity_1 = require("./activity");
exports.FRAME_SEC = 0.02;
const SMOOTH_FRAMES = 5; // 100 ms moving average of power
// Shorter energy runs inside a pause are treated as noise (clicks, breaths). Measured after the
// 100 ms smoothing, so this is roughly a 70 ms raw burst.
const MIN_SPEECH_SEC = 0.15;
const DEAD_AIR_LEAD_SEC = 0.3;
function toDb(x) {
    return 20 * Math.log10(Math.max(x, 1e-6));
}
/** Smoothed dB per frame. */
function smoothedDb(rms, win = SMOOTH_FRAMES) {
    const n = rms.length;
    const out = new Float32Array(n);
    const half = win >> 1;
    let acc = 0;
    let count = 0;
    // Sliding window over power.
    for (let i = 0; i < Math.min(half, n); i++) {
        acc += rms[i] * rms[i];
        count++;
    }
    for (let i = 0; i < n; i++) {
        const add = i + half;
        if (add < n) {
            acc += rms[add] * rms[add];
            count++;
        }
        const drop = i - half - 1;
        if (drop >= 0) {
            acc -= rms[drop] * rms[drop];
            count--;
        }
        out[i] = 10 * Math.log10(Math.max(acc / count, 1e-12));
    }
    return out;
}
function percentile(values, p) {
    const sorted = Float32Array.from(values).sort();
    if (sorted.length === 0)
        return -120;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
}
function adaptiveLevels(db, ratio) {
    // Ignore digital silence (padding, muted stretches) so it doesn't drag the floor down.
    const live = db.filter((v) => v > -100);
    const src = live.length > 10 ? live : db;
    let floorDb = percentile(src, 10);
    let speechDb = percentile(src, 80);
    // Fewer than 10% pause frames puts p10 inside speech; fall back to the quietest 1%.
    if (speechDb - floorDb < 10)
        floorDb = Math.min(floorDb, percentile(src, 1));
    if (speechDb - floorDb < 6)
        speechDb = floorDb + 6; // near-constant signal: assume weak speech
    const span = speechDb - floorDb;
    return {
        floorDb,
        speechDb,
        thresholdDb: floorDb + ratio * span,
        hysteresisDb: Math.min(3, Math.max(1, 0.08 * span)),
    };
}
/**
 * All pauses (any length) as [start, end) in seconds. Hysteresis: speech starts above
 * threshold + h and ends below threshold − h. Speech blips under MIN_SPEECH_SEC are absorbed.
 */
function detectPauses(audio, ratio) {
    const db = smoothedDb(audio.rms);
    const levels = adaptiveLevels(db, ratio);
    const hi = levels.thresholdDb + levels.hysteresisDb;
    const lo = levels.thresholdDb - levels.hysteresisDb;
    const f = audio.frameSec;
    const raw = [];
    let inSpeech = db.length > 0 && db[0] > hi;
    let runStart = 0;
    for (let i = 0; i < db.length; i++) {
        if (inSpeech && db[i] < lo) {
            inSpeech = false;
            runStart = i;
        }
        else if (!inSpeech && db[i] > hi) {
            inSpeech = true;
            raw.push({ start: runStart * f, end: i * f });
        }
    }
    if (!inSpeech)
        raw.push({ start: runStart * f, end: db.length * f });
    // Absorb short speech blips between pauses.
    const pauses = [];
    for (const p of raw) {
        const last = pauses[pauses.length - 1];
        if (last && p.start - last.end < MIN_SPEECH_SEC)
            last.end = p.end;
        else if (p.end > p.start)
            pauses.push({ ...p });
    }
    return { pauses, levels };
}
/** Turns long pauses into cuts (static screen) or speed-ups (busy screen). */
function planSilenceEdits(audio, activity, s) {
    const duration = audio.rms.length * audio.frameSec;
    const { pauses, levels } = detectPauses(audio, s.thresholdRatio);
    const cuts = [];
    const speedups = [];
    if (!s.enabled)
        return { cuts, speedups, levels, longPauses: [], pauses };
    // Dead air at start/end: before the first speech or real action, after the last one.
    let headEnd = 0;
    let tailStart = duration;
    if (s.trimDeadAir) {
        const firstSpeech = pauses.length && pauses[0].start <= audio.frameSec ? pauses[0].end : 0;
        const lastPause = pauses[pauses.length - 1];
        const lastSpeech = lastPause && lastPause.end >= duration - audio.frameSec ? lastPause.start : duration;
        const firstAction = (0, activity_1.firstBusyTime)(activity);
        const lastAction = (0, activity_1.lastBusyTime)(activity);
        headEnd = Math.max(0, Math.min(firstSpeech, firstAction) - DEAD_AIR_LEAD_SEC);
        tailStart = Math.min(duration, Math.max(lastSpeech, lastAction) + DEAD_AIR_LEAD_SEC);
        if (headEnd > 0.25)
            cuts.push({ start: 0, end: headEnd, type: 'deadStartEnd', label: 'Dead air (start)', enabled: true });
        else
            headEnd = 0;
        if (duration - tailStart > 0.25)
            cuts.push({ start: tailStart, end: duration, type: 'deadStartEnd', label: 'Dead air (end)', enabled: true });
        else
            tailStart = duration;
    }
    const longPauses = pauses.filter((p) => p.end - p.start >= s.minSilenceSec);
    for (const p of longPauses) {
        const start = Math.max(p.start + s.paddingSec, headEnd);
        const end = Math.min(p.end - s.paddingSec, tailStart);
        const len = end - start;
        if (len < 0.1)
            continue;
        const busy = (0, activity_1.busyFraction)(activity, start, end) >= 0.2;
        if (busy && s.speedUpBusy) {
            if (len < 0.4)
                continue; // nothing to gain, and a cut here would jump mid-load
            const speed = Math.round(Math.min(s.maxSpeed, Math.max(s.minSpeed, len / s.speedUpTargetSec)) * 2) / 2;
            speedups.push({ start, end, speed, enabled: true });
        }
        else if (!busy) {
            cuts.push({ start, end, type: 'silence', label: `${(p.end - p.start).toFixed(1)}s pause`, enabled: true });
        }
    }
    cuts.sort((a, b) => a.start - b.start);
    return { cuts, speedups, levels, longPauses, pauses };
}
