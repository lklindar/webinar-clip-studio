// Vertical layout engine — the single source of truth for BOTH the live preview and the export.
// Given a clip's edit state and a time t (seconds from clip start) it returns draw operations:
//   {s: "spk"|"pres", c: [x,y,w,h] source crop (0..1), d: [x,y,w,h] destination (0..1), r: clip rect, a: alpha, b: blurred bg}
//   {fill: "#hex", d: [...], a}  solid rectangle
// The browser draws these ops on a canvas for the preview; the Python renderer executes the
// very same ops (sampled per output frame) with OpenCV for the final MP4.

export const OUT_W = 1080;
export const OUT_H = 1920;

export const LAYOUTS = {
  split:   { label: "Split screen",        short: "Split",   color: "#6366f1", desc: "Slides on top, speaker below (adjustable)" },
  pres:    { label: "Slides full screen",  short: "Slides",  color: "#0ea5e9", desc: "The presentation fills the screen" },
  speaker: { label: "Speaker full screen", short: "Speaker", color: "#f59e0b", desc: "The speaker fills the screen" },
  pip:     { label: "Speaker + slide card", short: "Card",   color: "#10b981", desc: "Speaker full screen with the slide as a card on top" },
  cutout:  { label: "Person cutout",       short: "Cutout", color: "#e11d48", desc: "The speaker without background, in front of the slides" },
  media:   { label: "Your asset",          short: "Asset",  color: "#8b5cf6", desc: "One of your uploaded images or videos" },
  visual:  { label: "Illustration card",   short: "Visual", color: "#ec4899", desc: "A designed card made from what is said, above the speaker" },
};

export const MOTIONS = {
  none:     { label: "No motion" },
  zoomIn:   { label: "Slow zoom in" },
  zoomOut:  { label: "Slow zoom out" },
  panLeft:  { label: "Slow pan left" },
  panRight: { label: "Slow pan right" },
  punchIn:  { label: "Punch-in (emphasis)" },
  tourRight: { label: "Glide across slide →" },
  tourLeft:  { label: "Glide across slide ←" },
};

export const FRAMING_LABELS = {
  pres_split: "Slides — in split screen",
  spk_split: "Speaker — in split screen",
  pres_full: "Slides — full screen",
  spk_full: "Speaker — full screen / behind card",
  pres_pip: "Slide card",
  cut_bg: "Slides — on top, behind the person cutout",
  cut_bgfill: "Slides — filling the background behind the person",
  cut_spk: "Speaker — person cutout",
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));
const easeSine = (p) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(p, 0, 1));

export function defaultFraming(face) {
  const fx = face ? face.x : 0.5, fy = face ? face.y : 0.42;
  return {
    pres_split: { fit: "fit", zoom: 1, x: 0.5, y: 0.5 },
    pres_full: { fit: "fit", zoom: 1, x: 0.5, y: 0.5 },
    pres_pip: { fit: "fill", zoom: 1, x: 0.5, y: 0.5 },
    spk_split: { fit: "fill", zoom: 1, x: fx, y: fy },
    spk_full: { fit: "fill", zoom: 1, x: fx, y: fy },
    cut_bg: { fit: "fit", zoom: 1.15, x: 0.5, y: 0.1 },
    cut_bgfill: { fit: "fill", zoom: 1, x: 0.5, y: 0.5 },
    cut_spk: { fit: "fill", zoom: 1, x: fx, y: 0.45 },
  };
}

// Which regions a layout uses. Rects are in output pixels.
export const mediaKey = (seg) => `m_${seg.uid}`;
// The uploaded asset a part shows: an "asset" part, or the background of a person-cutout part.
export function assetOf(seg) {
  if (seg.layout === "media") return seg.asset || null;
  if (seg.layout === "cutout" && seg.bgAsset && seg.uid) return seg.bgAsset;
  return null;
}
export const ASSET_PLACES = { top: "On top (speaker below)", full: "Full screen", card: "Card over the speaker" };

export function regionsFor(seg, clip, has) {
  const W = OUT_W, H = OUT_H;
  let layout = seg.layout;
  if (layout === "cutout") {
    // slides fill the background, the speaker (person only) stands in front at the bottom
    const bgA = assetOf(seg);
    const bg = bgA
      ? { src: mediaKey(seg), R: { x: 0, y: 0, w: W, h: H }, media: true,
          f: { fit: bgA.fit || "fill", zoom: bgA.zoom || 1, x: bgA.x ?? 0.5, y: bgA.y ?? 0.5 } }
      : seg.slidesMode === "top"
        ? { src: "pres", R: { x: 0, y: 0, w: W, h: H }, key: "cut_bg", fDefault: { fit: "fit", zoom: 1.15, x: 0.5, y: 0.1 } }
        : { src: "pres", R: { x: 0, y: 0, w: W, h: H }, key: "cut_bgfill", fDefault: { fit: "fill", zoom: 1, x: 0.5, y: 0.5 } };
    if (!has.spk) return bgA ? [bg] : [{ src: "pres", R: { x: 0, y: 0, w: W, h: H }, key: "pres_full" }];
    if (!has.pres && !bgA) layout = "speaker";
    else {
      const ph = clamp(seg.personH ?? 0.62, 0.35, 0.9);
      return [
        bg,
        { src: "spk", R: { x: 0, y: Math.round(H * (1 - ph)), w: W, h: Math.round(H * ph) }, key: "cut_spk", mask: true,
          fDefault: { fit: "fill", zoom: 1, x: 0.5, y: 0.45 } },
      ];
    }
  }
  if (layout === "media") {
    const key = mediaKey(seg);
    const f = { fit: seg.asset?.fit || "fit", zoom: seg.asset?.zoom || 1, x: seg.asset?.x ?? 0.5, y: seg.asset?.y ?? 0.5 };
    const place = has.spk ? (seg.asset?.place || "top") : "full";
    if (place === "full") return [{ src: key, R: { x: 0, y: 0, w: W, h: H }, f, media: true }];
    if (place === "card") {
      const cw = Math.round(W * 0.88), chh = Math.round(cw * 9 / 16);
      return [
        { src: "spk", R: { x: 0, y: 0, w: W, h: H }, key: "spk_full" },
        { src: key, R: { x: Math.round((W - cw) / 2), y: Math.round(H * 0.07), w: cw, h: chh }, f, media: true, card: true },
      ];
    }
    const s = clamp(seg.split ?? 0.5, 0.2, 0.8);
    const top = Math.round(H * s);
    return [
      { src: key, R: { x: 0, y: 0, w: W, h: top }, f, media: true },
      { src: "spk", R: { x: 0, y: top, w: W, h: H - top }, key: "spk_split" },
    ];
  }
  if (layout === "visual") {
    if (!has.spk) return [];
    const s = clamp(seg.split ?? 0.5, 0.2, 0.8);
    const top = Math.round(H * s);
    return [{ src: "spk", R: { x: 0, y: top, w: W, h: H - top }, key: "spk_split" }];
  }
  if (!has.pres && layout !== "speaker") layout = "speaker";
  if (!has.spk && layout !== "pres") layout = "pres";
  if (layout === "split") {
    const s = clamp(seg.split ?? 0.5, 0.2, 0.8);
    const top = { x: 0, y: 0, w: W, h: Math.round(H * s) };
    const bot = { x: 0, y: top.h, w: W, h: H - top.h };
    const presTop = (clip.splitOrder || "pres-top") === "pres-top";
    return [
      { src: "pres", R: presTop ? top : bot, key: "pres_split" },
      { src: "spk", R: presTop ? bot : top, key: "spk_split" },
    ];
  }
  if (layout === "pres") return [{ src: "pres", R: { x: 0, y: 0, w: W, h: H }, key: "pres_full" }];
  if (layout === "speaker") return [{ src: "spk", R: { x: 0, y: 0, w: W, h: H }, key: "spk_full" }];
  // pip: speaker full + slide card
  const cw = Math.round(W * 0.88), chh = Math.round(cw * 9 / 16);
  return [
    { src: "spk", R: { x: 0, y: 0, w: W, h: H }, key: "spk_full" },
    { src: "pres", R: { x: Math.round((W - cw) / 2), y: Math.round(H * 0.07), w: cw, h: chh }, key: "pres_pip", card: true },
  ];
}

// Fit/fill + zoom + position inside region R. f.x/f.y: 0..1 (0.5 = centre).
// Where the scaled image is larger than R, x/y choose the visible part (the focus point);
// where it is smaller (fit), x/y align it inside R.
export function place(R, sw, sh, f) {
  const base = f.fit === "fill" ? Math.max(R.w / sw, R.h / sh) : Math.min(R.w / sw, R.h / sh);
  const s = base * clamp(f.zoom || 1, 0.3, 4);
  const dispW = sw * s, dispH = sh * s;
  let cx, cw, dx, dw, cy, ch, dy, dh;
  if (dispW > R.w + 0.01) { cw = R.w / s; cx = clamp(f.x * sw - cw / 2, 0, sw - cw); dx = R.x; dw = R.w; }
  else { cw = sw; cx = 0; dw = dispW; dx = R.x + (R.w - dispW) * clamp(f.x, 0, 1); }
  if (dispH > R.h + 0.01) { ch = R.h / s; cy = clamp(f.y * sh - ch / 2, 0, sh - ch); dy = R.y; dh = R.h; }
  else { ch = sh; cy = 0; dh = dispH; dy = R.y + (R.h - dispH) * clamp(f.y, 0, 1); }
  const filled = dw >= R.w - 0.5 && dh >= R.h - 0.5;
  return { c: [cx, cy, cw, ch], d: [dx, dy, dw, dh], filled };
}

export function segmentAt(clip, t) {
  const segs = clip.segments;
  let i = 0;
  for (let k = 0; k < segs.length; k++) if (segs[k].t <= t + 1e-6) i = k;
  return i;
}

function segEnd(clip, i) {
  return i + 1 < clip.segments.length ? clip.segments[i + 1].t : clip.end - clip.start;
}

function motionTarget(seg) {
  if (seg.layout === "media" && (!seg.motionTarget || seg.motionTarget === "auto" || seg.motionTarget === "pres")) return mediaKey(seg);
  if (seg.motionTarget && seg.motionTarget !== "auto") return seg.motionTarget;
  return seg.layout === "pres" ? "pres" : "spk";
}

function applyMotion(f, seg, segStart, segEndT, t, strength) {
  const m = seg.motion || "none";
  if (m === "none") return f;
  const k = clamp(strength ?? 0.08, 0, 0.3);
  const p = easeSine((t - segStart) / Math.max(0.1, segEndT - segStart));
  const g = { ...f };
  if (m === "zoomIn") g.zoom = f.zoom * (1 + k * p);
  else if (m === "zoomOut") g.zoom = f.zoom * (1 + k * (1 - p));
  else if (m === "punchIn") g.zoom = f.zoom * (1 + k * 2.5);
  else if (m === "tourRight" || m === "tourLeft") {
    // zoom into the slide and travel across it, so even a static slide keeps moving
    g.zoom = f.zoom * (1 + k * 5);
    const dir = m === "tourRight" ? 1 : -1;
    g.x = clamp(0.5 + dir * (p - 0.5) * 0.7, 0, 1);
    g.y = clamp(f.y + (p - 0.5) * 0.1, 0, 1);
  }
  else if (m === "panLeft" || m === "panRight") {
    g.zoom = f.zoom * (1 + k * 1.5);
    const dir = m === "panLeft" ? -1 : 1;
    g.x = clamp(f.x + dir * k * (p - 0.5) * 2.2, 0, 1);
  }
  return g;
}

// Region states for segment i at time t (motion included).
function segState(clip, i, t, dims, has) {
  const seg = clip.segments[i];
  const st = seg.t, en = segEnd(clip, i);
  const out = [];
  for (const reg of regionsFor(seg, clip, has)) {
    const dim = dims[reg.src];
    if (!dim) continue;
    let f = reg.f ? { ...reg.f } : { ...(clip.framing[reg.key] || reg.fDefault || { fit: "fit", zoom: 1, x: 0.5, y: 0.5 }) };
    if (seg.focus && reg.src === "pres") {
      // this part shows a chosen region of the slide (zoom relative to the normal framing)
      f = { ...f, x: seg.focus.x, y: seg.focus.y, zoom: f.zoom * (reg.key === "pres_split" ? seg.focus.zoom * 0.8 : seg.focus.zoom) };
    }
    if (motionTarget(seg) === reg.src) f = applyMotion(f, seg, st, en, t, clip.motion?.strength);
    const pl = place(reg.R, dim.w, dim.h, f);
    let bg = null;
    if (!pl.filled && !reg.mask && (clip.background?.type || "blur") === "blur") {
      bg = place(reg.R, dim.w, dim.h, { fit: "fill", zoom: 1, x: 0.5, y: 0.5 });
    }
    out.push({ src: reg.src, R: reg.R, card: !!reg.card, pl, bg, dim, mask: !!reg.mask && !!dims.cutmask });
  }
  return out;
}

const W = OUT_W, H = OUT_H;
const nd = (r) => [r[0] / W, r[1] / H, r[2] / W, r[3] / H];
const nc = (c, dim) => [c[0] / dim.w, c[1] / dim.h, c[2] / dim.w, c[3] / dim.h];
const rr = (R) => [R.x, R.y, R.w, R.h];

function regionOps(rs, alpha = 1, override = null) {
  const ops = [];
  const R = override?.R || rr(rs.R);
  if (rs.card) {
    const b = 6;
    ops.push({ fill: "#ffffff", d: nd([R[0] - b, R[1] - b, R[2] + 2 * b, R[3] + 2 * b]), a: alpha * 0.9 });
  }
  if (rs.bg && !override?.noBg) ops.push({ s: rs.src, c: nc(rs.bg.c, rs.dim), d: nd(rs.bg.d), r: nd(R), a: alpha * (override?.bgAlpha ?? 1), b: 1 });
  const c = override?.c || rs.pl.c, d = override?.d || rs.pl.d;
  const op = { s: rs.src, c: nc(c, rs.dim), d: nd(d), r: nd(R), a: alpha };
  if (rs.mask) op.m = "cutmask"; // draw the speaker through the person mask
  ops.push(op);
  return ops;
}

export function transitionInfo(clip, t) {
  const tr = clip.transition || { type: "smooth", dur: 0.4 };
  if (tr.type === "cut") return null;
  const d = clamp(tr.dur || 0.4, 0.1, 1.5);
  for (let i = 1; i < clip.segments.length; i++) {
    const tb = clip.segments[i].t;
    if (t >= tb - d / 2 && t < tb + d / 2) return { i, p: ease((t - (tb - d / 2)) / d), type: tr.type };
  }
  return null;
}

// Main entry: draw ops at time t. dims = {spk: {w,h}, pres: {w,h}} (true source sizes)
export function opsAt(clip, t, dims) {
  const has = { spk: !!dims.spk, pres: !!dims.pres };
  const tr = transitionInfo(clip, t);
  if (!tr) return segState(clip, segmentAt(clip, t), t, dims, has).flatMap((rs) => regionOps(rs));
  const A = segState(clip, tr.i - 1, t, dims, has);
  const B = segState(clip, tr.i, t, dims, has);
  const p = tr.p;
  if (tr.type === "fade") return [...A.flatMap((rs) => regionOps(rs)), ...B.flatMap((rs) => regionOps(rs, p))];
  // smooth: morph each source from its A placement to its B placement
  const ops = [];
  for (const rs of A) if (rs.bg) ops.push(...regionOps(rs, 1 - p).filter((o) => o.b));
  for (const rs of B) if (rs.bg) ops.push(...regionOps(rs, p).filter((o) => o.b));
  const area = (rs) => (rs ? rs.R.w * rs.R.h : -1);
  const srcs = [...new Set([...A, ...B].map((r) => r.src))];
  const items = srcs.map((src) => ({ src, a: A.find((r) => r.src === src), b: B.find((r) => r.src === src) }));
  items.sort((x, y) => (x.b?.card ? 1 : 0) - (y.b?.card ? 1 : 0) || area(x.b) - area(y.b));
  for (const it of items) {
    const { a, b } = it;
    if (a && b) {
      const Ra = rr(a.R), Rb = rr(b.R);
      const R = Ra.map((v, k) => lerp(v, Rb[k], p));
      const c = a.pl.c.map((v, k) => lerp(v, b.pl.c[k], p));
      const d = a.pl.d.map((v, k) => lerp(v, b.pl.d[k], p));
      const card = a.card && b.card;
      ops.push(...regionOps({ ...b, card }, 1, { R, c, d, noBg: true }));
    } else {
      const rs = a || b;
      if (rs.R.w >= W && rs.R.h >= H) {
        // full-screen element: fade in on top / stay in place underneath (sliding would leave a gap)
        ops.push(...regionOps(rs, a ? 1 : p, { noBg: false, bgAlpha: 1 }));
        continue;
      }
      // appears or disappears: slide in/out vertically, away from the centre
      const q = a ? p : 1 - p;
      const cy = rs.R.y + rs.R.h / 2;
      const dir = cy < H / 2 ? -1 : 1;
      const shift = dir * q * (rs.card ? rs.R.y + rs.R.h + 12 : rs.R.h);
      const R = [rs.R.x, rs.R.y + shift, rs.R.w, rs.R.h];
      const d = [rs.pl.d[0], rs.pl.d[1] + shift, rs.pl.d[2], rs.pl.d[3]];
      ops.push(...regionOps(rs, rs.card ? 1 : 1, { R, d, noBg: true }));
    }
  }
  return ops;
}

// Smart caption position: keep captions off slide text and off the speaker's face.
function captionYFor(clip, i, dims, has) {
  const seg = clip.segments[i];
  const regs = regionsFor(seg, clip, has);
  const lay = regs.length === 1 ? regs[0].key : seg.layout;
  if (lay === "split") {
    const top = regs[0].R;
    return (top.y + top.h) / H; // on the seam between the two halves
  }
  if (lay === "pres_full" && dims.pres) {
    const pl = place(regs[0].R, dims.pres.w, dims.pres.h, clip.framing.pres_full);
    if (pl.filled) return 0.84;
    return clamp((pl.d[1] + pl.d[3]) / H + 0.075, 0.55, 0.86);
  }
  if (lay === "pip") return 0.74;
  if (seg.layout === "visual") return has.spk ? clamp(seg.split ?? 0.5, 0.2, 0.8) : 0.84;
  if (seg.layout === "cutout") return 0.8;
  if (seg.layout === "media") {
    const m = regs.find((r) => r.media);
    if (!m) return 0.74;
    if (m.card) return 0.74;
    if (m.R.h < H) return (m.R.y + m.R.h) / H;          // on the seam below the asset
    const dm = dims[m.src];
    if (!dm) return 0.8;
    const pl = place(m.R, dm.w, dm.h, m.f);
    return pl.filled ? 0.8 : clamp((pl.d[1] + pl.d[3]) / H + 0.075, 0.55, 0.86);
  }
  return 0.74; // speaker full: below the face, chest area
}

export function captionY(clip, t, dims) {
  const has = { spk: !!dims.spk, pres: !!dims.pres };
  const tr = transitionInfo(clip, t);
  if (!tr) return captionYFor(clip, segmentAt(clip, t), dims, has);
  return lerp(captionYFor(clip, tr.i - 1, dims, has), captionYFor(clip, tr.i, dims, has), tr.p);
}

export function newSegment(t, layout = "split", split = 0.5) {
  return { t, layout, split, motion: "none", motionTarget: "auto" };
}

// Suggest layout changes from detected slide changes: show the new slide full screen
// for a few seconds, then return to split screen. Conservative on purpose.
export function autoLayoutFromSlides(clip, slideTimes, opts = {}) {
  const dur = clip.end - clip.start;
  const hold = opts.hold ?? 3.5;
  const segs = [newSegment(0, "split")];
  let lastEnd = -10;
  for (const ts of slideTimes) {
    const t = ts - clip.start;
    if (t < 1.5 || t > dur - 2.5 || t < lastEnd + 3) continue;
    segs.push({ ...newSegment(Math.round(t * 10) / 10, "pres"), motion: "none" });
    const back = Math.min(dur - 0.5, t + hold);
    segs.push(newSegment(Math.round(back * 10) / 10, "split"));
    lastEnd = back;
  }
  return segs.filter((s, i, a) => i === 0 || s.t - a[i - 1].t >= 0.8);
}

export function round4(ops) {
  const r = (v) => Math.round(v * 1e5) / 1e5;
  return ops.map((o) => {
    const q = { d: o.d.map(r), a: Math.round((o.a ?? 1) * 1000) / 1000 };
    if (o.fill) q.fill = o.fill;
    else { q.s = o.s; q.c = o.c.map(r); if (o.r) q.r = o.r.map(r); if (o.b) q.b = 1; if (o.m) q.m = o.m; }
    return q;
  });
}

// ---------------------------------------------------------------- auto-edit
// Builds an engaging layout timeline automatically: layout changes on a rhythm, cut at pauses in
// speech, full-screen slides when a slide changes, punch-ins on questions/emphasis, and subtle
// motion on every part (a static slide gets a slow "tour" across it).
export const AUTO_PRESETS = {
  calm:      { label: "Calm",      every: [7, 10],  strength: 0.06 },
  dynamic:   { label: "Dynamic",   every: [4.5, 7], strength: 0.08 },
  energetic: { label: "Energetic", every: [3, 4.5], strength: 0.11 },
};
const EMPHASIS = /\b(never|always|biggest|most|secret|mistake|important|key|truth|actually|really|huge|crazy|stop|must|best|worst)\b/i;

export function autoEdit(clip, { slides = [], words = [], has = { spk: true, pres: true }, preset = "dynamic" } = {}) {
  const P = AUTO_PRESETS[preset] || AUTO_PRESETS.dynamic;
  const D = clip.end - clip.start;
  const rnd = (i) => { const x = Math.sin(i * 12.9898 + D * 78.233) * 43758.5453; return x - Math.floor(x); };
  const ws = words.filter((w) => w.end > clip.start && w.start < clip.end)
    .map((w) => ({ text: w.text, s: w.start - clip.start, e: w.end - clip.start }));
  // natural cut points = pauses between words / sentence ends
  const pauses = [];
  for (let i = 1; i < ws.length; i++) {
    const gap = ws[i].s - ws[i - 1].e;
    if (gap > 0.22 || /[.!?,;:]$/.test(ws[i - 1].text)) pauses.push((ws[i - 1].e + ws[i].s) / 2);
  }
  const snap = (t, win = 1.2) => {
    let best = t, bd = win;
    for (const q of pauses) { const d = Math.abs(q - t); if (d < bd) { bd = d; best = q; } }
    return best;
  };
  // events: slide changes -> show slides full screen; questions/emphasis -> speaker punch-in
  const events = [];
  if (has.pres) {
    // a burst of slide changes (animations, quick clicks) becomes one longer full-screen moment
    for (const st of slides) {
      const t = st - clip.start;
      if (t <= 1.5 || t >= D - 2.5) continue;
      const last = events[events.length - 1];
      if (last && t - (last.t + last.hold) < 2) last.hold = Math.min(7, t - last.t + 3);
      else events.push({ t, layout: "pres", hold: 4 });
    }
  }
  if (has.spk && has.pres) {
    let sentStart = ws.length ? ws[0].s : null;
    ws.forEach((w, i) => {
      const end = /[.!?]$/.test(w.text);
      if (end && sentStart != null) {
        const sent = ws.filter((x) => x.s >= sentStart - 1e-3 && x.e <= w.e + 1e-3).map((x) => x.text).join(" ");
        if ((/\?$/.test(w.text) || EMPHASIS.test(sent)) && sentStart > 1.5 && sentStart < D - 2.5 &&
            !events.some((ev) => Math.abs(ev.t - sentStart) < 4)) {
          events.push({ t: Math.max(0, sentStart - 0.15), layout: "speaker", hold: Math.min(3.5, Math.max(2, w.e - sentStart + 0.3)), punch: true });
        }
        sentStart = ws[i + 1] ? ws[i + 1].s : null;
      }
    });
  }
  events.sort((a, b) => a.t - b.t);

  const motionFor = (layout, i, punch) => {
    if (layout === "pres") return { motion: i % 2 ? "tourLeft" : "tourRight", motionTarget: "pres" };
    if (layout === "speaker") return { motion: punch ? "punchIn" : (i % 2 ? "zoomOut" : "zoomIn"), motionTarget: "spk" };
    if (layout === "pip") return { motion: "zoomIn", motionTarget: "spk" };
    return { motion: i % 2 ? "zoomOut" : "zoomIn", motionTarget: "spk" };
  };
  const only = !has.pres ? "speaker" : !has.spk ? "pres" : null;
  const cycle = ["pres", "speaker", "pres", "pip"]; // what to cut to after a split-screen part
  const segs = [];
  const push = (t, layout, punch = false) => {
    const L = only || layout;
    const prev = segs[segs.length - 1];
    if (prev && prev.layout === L && !only) return;
    segs.push({ t: Math.round(t * 100) / 100, layout: L, split: 0.5, ...motionFor(L, segs.length, punch) });
  };
  push(0, "split");
  let t = 0, c = 0, ei = 0;
  const minLen = 2;
  while (t < D) {
    const L = P.every[0] + (P.every[1] - P.every[0]) * rnd(segs.length);
    let next = snap(t + L);
    while (ei < events.length && events[ei].t < t + minLen) ei++;
    const ev = events[ei];
    if (ev && ev.t <= next + 0.5) {
      const st = snap(ev.t, 0.6);
      if (st - t >= minLen && D - st >= minLen) {
        push(st, ev.layout, ev.punch);
        ei++;
        const back = snap(st + ev.hold, 0.8);
        if (D - back < minLen) break;
        push(back, "split");
        t = back;
        continue;
      }
      ei++;
    }
    if (D - next < minLen + 0.5) break;
    if (only) push(next, only); else push(next, segs[segs.length - 1].layout === "split" ? cycle[c++ % cycle.length] : "split");
    t = next;
  }
  // tidy: drop parts that ended up too short
  const out = [];
  for (const sg of segs) {
    if (out.length && sg.t - out[out.length - 1].t < 1.5) { out[out.length - 1] = { ...sg, t: out[out.length - 1].t }; continue; }
    if (out.length && out[out.length - 1].layout === sg.layout && !only) continue;
    out.push(sg);
  }
  out[0].t = 0;
  if (cycle.includes("split") && !only) out.forEach((s) => { if (s.layout === "split" && s.motion === "none") s.motion = "zoomIn"; });
  return { segments: out, strength: P.strength, transition: { type: "smooth", dur: preset === "energetic" ? 0.3 : 0.4 } };
}

// Illustration card visible at time t: {card, rect (output px), a (0..1 entrance/exit)} or null
export function visualAt(clip, t, dims) {
  const has = { spk: !!dims.spk, pres: !!dims.pres };
  const D = clip.end - clip.start;
  const tr = clip.transition || { type: "smooth", dur: 0.4 };
  const d = tr.type === "cut" ? 0 : clamp(tr.dur || 0.4, 0.1, 1.5);
  for (let i = 0; i < clip.segments.length; i++) {
    const seg = clip.segments[i];
    if (seg.layout !== "visual" || !seg.card) continue;
    const st = seg.t, en = i + 1 < clip.segments.length ? clip.segments[i + 1].t : D;
    if (t < st - d / 2 || t >= en + d / 2) continue;
    let a = 1;
    if (d > 0) {
      if (i > 0 && t < st + d / 2) a = ease((t - (st - d / 2)) / d);
      if (i + 1 < clip.segments.length && t > en - d / 2) a = Math.min(a, 1 - ease((t - (en - d / 2)) / d));
    } else if (t >= en) a = 0;
    if (a <= 0.001) continue;
    const s = clamp(seg.split ?? 0.5, 0.2, 0.8);
    const rect = has.spk ? { x: 0, y: 0, w: W, h: Math.round(H * s) } : { x: 0, y: 0, w: W, h: H };
    return { card: seg.card, rect, a };
  }
  return null;
}

// Replace [a, b) of the timeline with a new part; what was showing at b continues afterwards.
export function insertPart(clip, a, b, part) {
  const D = clip.end - clip.start;
  a = clamp(a, 0, D); b = clamp(b, a + 0.5, D);
  const atB = clip.segments[segmentAt(clip, b)];
  const out = clip.segments.filter((s) => s.t < a - 0.05 || s.t > b + 0.05);
  out.push({ ...part, t: Math.round(a * 100) / 100 });
  if (b < D - 0.6 && !out.some((s) => Math.abs(s.t - b) < 0.05)) out.push({ ...atB, t: Math.round(b * 100) / 100 });
  out.sort((x, y) => x.t - y.t);
  out[0].t = 0;
  clip.segments = out.filter((s, i, arr) => i === 0 || s.t - arr[i - 1].t >= 0.5);
}

// The prepared person cutout (mask video) that covers this clip, if any.
export function cutoutFor(project, clip) {
  return (project.cutouts || []).filter((c) => c.start <= clip.start + 0.05 && c.end >= clip.end - 0.05)
    .sort((a, b) => (b.quality === "accurate") - (a.quality === "accurate"))[0] || null;
}
export const usesCutout = (clip) => clip.segments.some((s) => s.layout === "cutout");
