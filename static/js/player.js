// Live composite preview: two synced <video> proxies drawn onto a 9:16 canvas using the
// same layout ops (compose.js) and caption renderer (captions.js) as the export.
import { opsAt, captionY, visualAt, mediaKey, assetOf, cutoutFor, usesCutout, OUT_W, OUT_H } from "./compose.js";
import { drawCard } from "./visuals.js";
import { renderAt } from "./captions.js";
import { h, fmtTime } from "./ui.js";

const small = document.createElement("canvas");
const sctx = small.getContext("2d");
const cutA = document.createElement("canvas");
const cutActx = cutA.getContext("2d", { willReadFrequently: true });
const cutM = document.createElement("canvas");
const cutMctx = cutM.getContext("2d", { willReadFrequently: true });

// Draw the speaker crop through the person mask (white = person) — same crop for both videos.
function drawMasked(ctx, el, maskEl, op, cx, cy, cw, ch, dx, dy, dw, dh) {
  const w = Math.max(1, Math.round(dw)), h = Math.max(1, Math.round(dh));
  cutA.width = w; cutA.height = h; cutM.width = w; cutM.height = h;
  cutActx.drawImage(el, cx, cy, cw, ch, 0, 0, w, h);
  const mw = maskEl.videoWidth, mh = maskEl.videoHeight;
  cutMctx.drawImage(maskEl, op.c[0] * mw, op.c[1] * mh, op.c[2] * mw, op.c[3] * mh, 0, 0, w, h);
  const a = cutActx.getImageData(0, 0, w, h), m = cutMctx.getImageData(0, 0, w, h);
  const ad = a.data, md = m.data;
  for (let i = 3; i < ad.length; i += 4) ad[i] = md[i - 3];
  cutActx.putImageData(a, 0, 0);
  ctx.drawImage(cutA, dx, dy, dw, dh);
}

// Cutout from the combined preview video: picture in the top half, outline in the bottom half of the
// very same frame — so they always match.
function drawPacked(ctx, packEl, op, dx, dy, dw, dh) {
  const vw = packEl.videoWidth, vh = packEl.videoHeight / 2;
  const w = Math.max(1, Math.round(dw)), h = Math.max(1, Math.round(dh));
  cutA.width = w; cutA.height = h; cutM.width = w; cutM.height = h;
  const [cx, cy, cw, ch] = [op.c[0] * vw, op.c[1] * vh, op.c[2] * vw, op.c[3] * vh];
  cutActx.drawImage(packEl, cx, cy, cw, ch, 0, 0, w, h);
  cutMctx.drawImage(packEl, cx, cy + vh, cw, ch, 0, 0, w, h);
  const a = cutActx.getImageData(0, 0, w, h), m = cutMctx.getImageData(0, 0, w, h);
  const ad = a.data, md = m.data;
  for (let i = 3; i < ad.length; i += 4) ad[i] = md[i - 3];
  cutActx.putImageData(a, 0, 0);
  ctx.drawImage(cutA, dx, dy, dw, dh);
}

export function drawOps(ctx, W, H, ops, sources, bg = "#000") {
  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  for (const op of ops) {
    const [dx, dy, dw, dh] = [op.d[0] * W, op.d[1] * H, op.d[2] * W, op.d[3] * H];
    ctx.globalAlpha = op.a ?? 1;
    if (op.fill) { ctx.fillStyle = op.fill; ctx.fillRect(dx, dy, dw, dh); continue; }
    if (op.m && sources[op.m]?.pack && sources[op.m].ready()) {
      ctx.save();
      if (op.r) { ctx.beginPath(); ctx.rect(op.r[0] * W, op.r[1] * H, op.r[2] * W, op.r[3] * H); ctx.clip(); }
      drawPacked(ctx, sources[op.m].el, op, dx, dy, dw, dh);
      ctx.restore();
      continue;
    }
    const src = sources[op.s];
    if (!src || !src.ready()) continue;
    const el = src.el;
    const vw = el.videoWidth || el.naturalWidth || el.width, vh = el.videoHeight || el.naturalHeight || el.height;
    const [cx, cy, cw, ch] = [op.c[0] * vw, op.c[1] * vh, op.c[2] * vw, op.c[3] * vh];
    if (cw < 1 || ch < 1) continue;
    ctx.save();
    if (op.r) { ctx.beginPath(); ctx.rect(op.r[0] * W, op.r[1] * H, op.r[2] * W, op.r[3] * H); ctx.clip(); }
    if (op.b) {
      small.width = Math.max(2, Math.round(dw / 24));
      small.height = Math.max(2, Math.round(dh / 24));
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(el, cx, cy, cw, ch, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, dx, dy, dw, dh);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(dx, dy, dw, dh);
    } else if (op.m && sources[op.m]?.ready()) {
      drawMasked(ctx, el, sources[op.m].el, op, cx, cy, cw, ch, dx, dy, dw, dh);
    } else {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(el, cx, cy, cw, ch, dx, dy, dw, dh);
    }
    ctx.restore();
  }
  ctx.restore();
}

export function captionProject(clip, t, dims) {
  const style = { ...clip.style, backdrop: clip.backdrop !== false };
  if (clip.smartPos !== false) style.posY = captionY(clip, t, dims);
  return { captions: clip.captionsOn === false ? [] : clip.captions || [], style, hook: clip.hook, emphasis: clip.emphasis };
}

// Everything drawn on top of the video: illustration cards, then subtitles. Returns true if anything was drawn.
export function drawOverlay(ctx, W, H, clip, t, dims) {
  let drew = false;
  const v = visualAt(clip, t, dims);
  if (v) {
    const k = W / OUT_W, kh = H / OUT_H;
    drawCard(ctx, { x: v.rect.x * k, y: v.rect.y * kh, w: v.rect.w * k, h: v.rect.h * kh }, v.card, v.a);
    drew = true;
  }
  return renderAt(ctx, W, H, t, captionProject(clip, t, dims)) || drew;
}

export class CompositePlayer {
  constructor(project, { width = 540, height = 960, showCaptions = true, controls = true } = {}) {
    this.project = project;
    this.W = width;
    this.H = height;
    this.showCaptions = showCaptions;
    this.t = 0;
    this.playing = false;
    this.listeners = [];
    this.canvas = h("canvas", { width, height, class: "comp-canvas" });
    this.ctx = this.canvas.getContext("2d");
    this.dims = {};
    this.sources = {};
    const off = project.sync.offset;
    for (const [role, key] of [["speaker", "spk"], ["presentation", "pres"]]) {
      const s = project.sources[role];
      if (!s) continue;
      this.dims[key] = { w: s.width, h: s.height };
      const v = h("video", { preload: "auto", playsinline: true, muted: true, crossorigin: "anonymous" });
      v.muted = role !== project.sync.audio;
      v.src = `/api/projects/${project.id}/media/${role}?v=${s.fp}${s.proxy === "ready" ? "p" : ""}`;
      const offset = key === "pres" ? off : 0;
      const dur = s.duration;
      this.sources[key] = {
        el: v, offset, role, dur,
        timeAt: (t) => this.clip.start + t + offset,           // clip time -> this video's time
        clipTime: (vt) => vt - offset - this.clip.start,       // this video's time -> clip time
        inRange: (t) => this.clip.start + t + offset >= 0 && this.clip.start + t + offset <= dur,
        ready: () => v.readyState >= 2 && this.sources[key].visible !== false,
      };
      v.addEventListener("seeked", () => { if (!this.playing) this.draw(); });
      v.addEventListener("loadeddata", () => { if (!this.playing) this.seek(this.t); });
    }
    this.audioKey = project.sync.audio === "presentation" ? "pres" : "spk";
    this.el = h("div", { class: "player" }, h("div", { class: "canvas-wrap" }, this.canvas));
    if (controls) this.el.append(this._controls());
    this.canvas.addEventListener("click", () => this.toggle());
  }

  _controls() {
    this.btn = h("button", { class: "btn play-btn", onclick: () => this.toggle(), title: "Play / pause (space)" }, "▶");
    this.timeEl = h("span", { class: "time" }, "0:00.0");
    this.scrub = h("input", { type: "range", min: 0, max: 1, step: 0.01, value: 0, class: "scrub" });
    this.scrub.addEventListener("input", () => this.seek(Number(this.scrub.value)));
    return h("div", { class: "player-controls" }, this.btn, this.scrub, this.timeEl);
  }

  onTime(fn) { this.listeners.push(fn); }

  // Your assets (images / short videos) used by "media" parts of the clip.
  _syncAssets() {
    if (!this.clip) return;
    const assets = (window.__state?.project?.id === this.project.id ? window.__state.project : this.project).assets || [];
    for (const seg of this.clip.segments) {
      const spec = assetOf(seg);
      if (!spec) continue;
      const key = mediaKey(seg);
      const a = assets.find((x) => x.id === spec.id);
      const cur = this.sources[key];
      if (cur && cur.assetId === spec.id) { cur.seg = seg; continue; }
      if (cur) { cur.el.removeAttribute?.("src"); delete this.sources[key]; }
      if (!a) continue;
      this.dims[key] = { w: a.width, h: a.height };
      const url = `/api/projects/${this.project.id}/assets/${a.id}/file?p=${a.proxy || ""}`;
      if (a.kind === "image") {
        const img = new Image();
        img.src = url;
        img.onload = () => { if (!this.playing) this.draw(); };
        this.sources[key] = { el: img, image: true, assetId: a.id, seg, ready: () => img.complete && img.naturalWidth > 0, inRange: () => true };
      } else {
        const v = h("video", { preload: "auto", playsinline: true, muted: true });
        v.muted = true;
        v.src = url;
        const src = { el: v, assetId: a.id, seg, dur: a.duration, asset: true };
        const loops = () => !!assetOf(src.seg)?.loop;
        const segEnd = () => {
          const i = this.clip.segments.indexOf(src.seg);
          return i >= 0 && i + 1 < this.clip.segments.length ? this.clip.segments[i + 1].t : this.duration();
        };
        src.loops = loops;
        src.timeAt = (t) => {
          const x = (assetOf(src.seg)?.in || 0) + Math.max(0, t - src.seg.t);
          return loops() && src.dur > 0.2 ? x % src.dur : x;    // background videos loop
        };
        src.clipTime = (vt) => vt - (assetOf(src.seg)?.in || 0) + src.seg.t;
        src.inRange = (t) => t >= src.seg.t - 0.6 && t <= segEnd() + 0.6;
        src.ready = () => v.readyState >= 2;
        v.addEventListener("seeked", () => { if (!this.playing) this.draw(); });
        v.addEventListener("loadeddata", () => { if (!this.playing) this.seek(this.t); });
        this.sources[key] = src;
      }
    }
    // person cutout mask video (follows the speaker's timing)
    const proj = window.__state?.project?.id === this.project.id ? window.__state.project : this.project;
    const cut = usesCutout(this.clip) ? cutoutFor(proj, this.clip) : null;
    const curM = this.sources.cutmask;
    if (curM && (!cut || curM.cutId !== cut.id)) { curM.el.pause(); delete this.sources.cutmask; delete this.dims.cutmask; }
    if (cut && !this.sources.cutmask) {
      const v = h("video", { preload: "auto", playsinline: true, muted: true });
      v.muted = true;
      v.src = `/api/projects/${this.project.id}/cutouts/${cut.id}/pack`;
      this.dims.cutmask = { w: cut.width, h: cut.height };
      this.sources.cutmask = {
        el: v, cutId: cut.id, dur: cut.end - cut.start, mask: true, pack: true,
        timeAt: (t) => this.clip.start + t - cut.start,
        clipTime: (vt) => vt + cut.start - this.clip.start,
        inRange: () => true,
        ready: () => v.readyState >= 2,
      };
      v.addEventListener("seeked", () => { if (!this.playing) this.draw(); });
      v.addEventListener("loadeddata", () => { if (!this.playing) this.seek(this.t); });
    }
    // drop assets no longer used
    for (const key of Object.keys(this.sources)) {
      if (key.startsWith("m_") && !this.clip.segments.some((sg) => assetOf(sg) && mediaKey(sg) === key)) {
        this.sources[key].el.pause?.();
        delete this.sources[key];
      }
    }
  }

  setClip(clip) {
    this.clip = clip;
    this._syncAssets();
    const dur = clip.end - clip.start;
    if (this.scrub) this.scrub.max = dur.toFixed(2);
    if (this.t > dur) this.t = 0;
    this.seek(this.t);
  }

  duration() { return this.clip ? this.clip.end - this.clip.start : 0; }

  seek(t) {
    if (!this.clip) return;
    this.t = Math.max(0, Math.min(this.duration(), t));
    this._syncAssets();
    for (const s of Object.values(this.sources)) {
      if (s.image) continue;
      if (s.asset) s.visible = true; else s.visible = s.inRange(this.t);
      const target = Math.max(0, Math.min((s.dur || 1e9) - 0.05, s.timeAt(this.t)));
      if (Math.abs(s.el.currentTime - target) > 0.02) s.el.currentTime = target;
    }
    this.draw();
    this._emit();
  }

  _emit() {
    if (this.scrub && document.activeElement !== this.scrub) this.scrub.value = this.t.toFixed(2);
    if (this.timeEl) this.timeEl.textContent = `${fmtTime(this.t)} / ${fmtTime(this.duration())}`;
    for (const fn of this.listeners) fn(this.t);
  }

  async play() {
    if (!this.clip || this.playing) return;
    if (this.t >= this.duration() - 0.05) this.seek(0);
    this.playing = true;
    if (this.btn) this.btn.textContent = "❚❚";
    this._syncAssets();
    for (const s of Object.values(this.sources)) {
      if (s.image) continue;
      s.el.currentTime = Math.max(0, s.timeAt(this.t));
      if (s.inRange(this.t) || s === this.sources[this.audioKey]) s.el.play().catch(() => {});
    }
    this.clock0 = performance.now() - this.t * 1000;
    const loop = () => {
      if (!this.playing) return;
      const master = this.sources[this.audioKey];
      let t;
      if (master && !master.el.paused && master.inRange(this.t) && master.el.readyState >= 3) {
        t = master.clipTime(master.el.currentTime);
        this.clock0 = performance.now() - t * 1000;
      } else {
        t = (performance.now() - this.clock0) / 1000;
      }
      this.t = Math.max(0, t);
      for (const s of Object.values(this.sources)) {
        if (s.image) continue;
        const active = s.inRange(this.t);
        if (!s.asset) s.visible = active;
        if (!active) { if (!s.el.paused) s.el.pause(); continue; }
        const want = s.timeAt(this.t);
        if (s.asset && !s.loops?.() && want >= s.dur - 0.05) { if (!s.el.paused) s.el.pause(); continue; } // hold the last frame
        if (s.loops?.()) s.el.loop = true;
        if (s.el.paused) {
          if (!s.starting) {
            s.starting = true;
            s.el.currentTime = want;
            s.el.play().catch(() => {}).finally(() => { s.starting = false; });
          }
        } else if (s !== master && !s.el.seeking && performance.now() - (s.lastFix || 0) > 1200 && (() => {
          let d = Math.abs(s.el.currentTime - want);
          if (s.loops?.()) d = Math.min(d, s.dur - d);          // looping: compare around the wrap point
          return d > (s.mask ? 0.15 : 0.35);
        })()) {
          s.lastFix = performance.now();  // one correction at a time, then let it play (no seek storms)
          s.el.currentTime = want + 0.05; // small lead: the video keeps playing while it catches up
        }
      }
      if (this.t >= this.duration()) {
        this.pause();
        this.seek(this.duration());
        return;
      }
      this.draw();
      this._emit();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.btn) this.btn.textContent = "▶";
    for (const s of Object.values(this.sources)) s.el.pause?.();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  draw() {
    if (!this.clip) return;
    this._syncAssets();
    const ops = opsAt(this.clip, this.t, this.dims);
    const bg = this.clip.background?.type === "color" ? this.clip.background.color : "#000000";
    drawOps(this.ctx, this.W, this.H, ops, this.sources, bg);
    if (this.showCaptions) drawOverlay(this.ctx, this.W, this.H, this.clip, this.t, this.dims);
  }

  destroy() {
    this.pause();
    for (const s of Object.values(this.sources)) { if (!s.image) { s.el.removeAttribute("src"); s.el.load(); } }
  }
}
