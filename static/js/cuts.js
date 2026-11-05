// Removing silences and filler words ("um", "uh", "ah", …) from a clip.
//
// A clip normally plays its recordings continuously from clip.start to clip.end. When parts are removed,
// clip.keep lists the parts that remain, as [a, b] seconds from clip.start in recording time ("source time").
// Everything the editor shows (layout parts, subtitles, hook, the export) uses the shortened timeline
// ("edit time"); toSrc / toEdit convert between the two.

export const FILLER_RE = /^(u+h+m*|u+m+|a+h+|a{2,}h*|e+h+m*|e+r+m*|e+m+|h+m+|m+h+m*|m{2,}|e{3,}|ehem|uhuh)$/i;
export const isFiller = (text) => FILLER_RE.test(String(text).toLowerCase().replace(/[^a-z]/g, ""));

const keyOf = (clip) => `${(+clip.start).toFixed(3)}-${(+clip.end).toFixed(3)}`;

// Kept parts (only valid for the timing they were made for; trimming the clip resets them).
export function keepRanges(clip) {
  if (clip.keep?.length && clip.keepFor === keyOf(clip)) return clip.keep;
  return [[0, clip.end - clip.start]];
}
export const hasCuts = (clip) => keepRanges(clip).length > 1 || (clip.keep?.length && clip.keepFor === keyOf(clip)
  && (clip.keep[0][0] > 0.01 || clip.keep[0][1] < clip.end - clip.start - 0.01));

export function clipDur(clip) {
  return keepRanges(clip).reduce((s, [a, b]) => s + (b - a), 0);
}

// edit time -> source time (seconds from clip.start)
export function toSrc(clip, t, ranges = keepRanges(clip)) {
  let acc = 0;
  for (const [a, b] of ranges) {
    if (t <= acc + (b - a) + 1e-9) return a + Math.max(0, t - acc);
    acc += b - a;
  }
  const last = ranges[ranges.length - 1];
  return last[1] + (t - acc);
}

// source time -> edit time (a time inside a removed part maps to where the next kept part starts)
export function toEdit(clip, s, ranges = keepRanges(clip)) {
  let acc = 0;
  for (const [a, b] of ranges) {
    if (s < a) return acc;
    if (s <= b) return acc + (s - a);
    acc += b - a;
  }
  return acc + Math.max(0, s - ranges[ranges.length - 1][1]);
}

// Edit-time position of every cut (for the timeline).
export function cutPoints(clip) {
  const r = keepRanges(clip);
  const out = [];
  let acc = 0;
  for (let i = 0; i < r.length - 1; i++) { acc += r[i][1] - r[i][0]; out.push(acc); }
  return out;
}

// Transcript words inside the clip, on the edit timeline (words in removed parts are dropped).
export function editWords(clip, words) {
  const r = keepRanges(clip);
  const out = [];
  for (const w of words || []) {
    if (w.end <= clip.start || w.start >= clip.end) continue;
    const s = w.start - clip.start, e = w.end - clip.start, mid = (s + e) / 2;
    const k = r.find(([a, b]) => mid >= a && mid <= b);
    if (!k) continue;
    out.push({ ...w, start: toEdit(clip, Math.max(s, k[0]), r), end: toEdit(clip, Math.min(e, k[1]), r) });
  }
  return out;
}

// Loudness helper: energy = {t0 (master s), hop (s), db: [...]} measured by the app for this clip.
function loudness(clip, energy) {
  if (!energy?.db?.length) return null;
  const { t0, hop, db } = energy;
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const quiet = Math.min(floor + 10, sorted[Math.floor(sorted.length * 0.5)] - 6);
  const at = (s) => db[Math.max(0, Math.min(db.length - 1, Math.round((clip.start + s - t0) / hop)))];
  const loud = (s) => at(s) > quiet;
  const quietest = (a, b) => {           // quietest moment in [a, b]
    let best = a, bv = Infinity;
    for (let t = a; t <= b + 1e-9; t += hop) { const v = at(t); if (v < bv) { bv = v; best = t; } }
    return best;
  };
  return { at, loud, quietest, hop, quiet };
}

// Which parts to keep. words = transcript words (master time); opts = {maxPause (s, 0 = keep pauses), fillers};
// energy (optional) = the clip's loudness, used to place every cut in a truly quiet moment.
export function computeKeep(clip, words, { maxPause = 0.5, fillers = true } = {}, energy = null) {
  const L = loudness(clip, energy);
  const D = clip.end - clip.start;
  const ws = (words || []).filter((w) => w.end > clip.start && w.start < clip.end)
    .map((w) => ({ text: w.text, s: Math.max(0, w.start - clip.start), e: Math.min(D, w.end - clip.start), filler: isFiller(w.text) }));
  const speech = fillers ? ws.filter((w) => !w.filler) : ws;
  const removed = [];
  let pauses = 0, fill = 0;
  const LEAVE_A = 0.09, LEAVE_B = 0.11;       // natural breathing room kept on each side of a cut
  const cut = (a, b) => { if (b - a >= 0.12) { removed.push([a, b]); return true; } return false; };
  if (!speech.length) return { keep: [[0, D]], pauses: 0, fillers: 0, removed: 0 };
  // silence before the first / after the last word
  const onset = (s) => { if (!L) return s; let t = s; while (t > s - 0.3 && L.loud(t - L.hop)) t -= L.hop; return t; };  // real start of a word
  const offset = (e) => { if (!L) return e; let t = e; while (t < e + 0.3 && L.loud(t)) t += L.hop; return t; };    // real end of a word
  if (maxPause > 0 && onset(speech[0].s) > maxPause) if (cut(0, onset(speech[0].s) - 0.15)) pauses++;
  for (let i = 1; i < speech.length; i++) {
    const p = speech[i - 1], n = speech[i];
    const gap = n.s - p.e;
    const fl = fillers ? ws.filter((w) => w.filler && w.s >= p.e - 0.05 && w.e <= n.s + 0.05) : [];
    if (fl.length && L) {
      // the filler's real sound: grow from its middle while it is loud (Whisper's timings are approximate)
      const lo = p.e - 0.05, hi = n.s + 0.05;
      let mid = (fl[0].s + fl[fl.length - 1].e) / 2;
      if (!L.loud(mid)) {                 // timing is off: use the nearest loud moment inside the gap
        let best = null;
        for (let t = lo; t <= hi; t += L.hop) if (L.loud(t) && (best === null || Math.abs(t - mid) < Math.abs(best - mid))) best = t;
        if (best !== null) mid = best;
      }
      let rs = mid, re = mid;
      while (rs - L.hop > lo && L.loud(rs - L.hop)) rs -= L.hop;
      while (re + L.hop < hi && L.loud(re + L.hop)) re += L.hop;
      const a = L.quietest(Math.min(lo + 0.05, rs), rs), b = L.quietest(re, Math.max(re, hi - 0.05));
      if (cut(a, b)) fill += fl.length;
    } else if (fl.length || (maxPause > 0 && gap > maxPause)) {
      const pe = offset(p.e), ns = onset(n.s), g2 = Math.max(0, ns - pe);
      if (fl.length || g2 > maxPause) {
        const a = pe + Math.min(LEAVE_A, g2 / 3), b = ns - Math.min(LEAVE_B, g2 / 3);
        if (cut(a, b)) { if (fl.length) fill += fl.length; else pauses++; }
      }
    }
  }
  const last = speech[speech.length - 1];
  if (maxPause > 0 && D - offset(last.e) > maxPause) if (cut(offset(last.e) + 0.2, D)) pauses++;
  // keep = everything that was not removed
  const keep = [];
  let pos = 0;
  for (const [a, b] of removed.sort((x, y) => x[0] - y[0])) {
    if (a > pos + 0.05) keep.push([+pos.toFixed(3), +a.toFixed(3)]);
    pos = Math.max(pos, b);
  }
  if (D > pos + 0.05) keep.push([+pos.toFixed(3), +D.toFixed(3)]);
  const kept = keep.reduce((s, [a, b]) => s + b - a, 0);
  return { keep: keep.length ? keep : [[0, D]], pauses, fillers: fill, removed: D - kept };
}

// Apply new kept parts and move everything on the edit timeline (layout parts, subtitles, hook) along.
export function setKeep(clip, keep) {
  const oldR = keepRanges(clip);
  const D = clip.end - clip.start;
  const whole = !keep || (keep.length === 1 && keep[0][0] <= 0.01 && keep[0][1] >= D - 0.01);
  const newR = whole ? [[0, D]] : keep;
  const move = (t) => toEdit(clip, toSrc(clip, t, oldR), newR);
  const newDur = newR.reduce((s, [a, b]) => s + b - a, 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  // layout parts
  let segs = clip.segments.map((sg) => ({ ...sg, t: r2(move(sg.t)) }));
  segs[0].t = 0;
  segs = segs.filter((s, i, a) => i === 0 || (s.t - a[i - 1].t >= 0.4 && s.t < newDur - 0.3));
  clip.segments = segs;
  // subtitles (edited ones are moved; automatic ones are rebuilt by the caller)
  for (const c of clip.captions || []) {
    c.start = move(c.start); c.end = Math.max(c.start + 0.1, move(c.end));
    for (const w of c.words || []) { w.start = move(w.start); w.end = Math.max(w.start + 0.02, move(w.end)); }
  }
  clip.captions = (clip.captions || []).filter((c) => c.start < newDur - 0.05);
  if (clip.hook) { clip.hook.start = r2(move(clip.hook.start)); clip.hook.end = r2(Math.min(newDur, move(clip.hook.end))); }
  if (whole) { delete clip.keep; delete clip.keepFor; }
  else { clip.keep = newR; clip.keepFor = keyOf(clip); }
}
