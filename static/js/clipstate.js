// Clip edit state: creation from a candidate, subtitle building, and export plan generation.
import { TEMPLATES, DEFAULT_HOOK, DEFAULT_EMPHASIS, groupWords, changePoints, renderAt } from "./captions.js";
import { defaultFraming, newSegment, opsAt, round4, autoEdit, mediaKey, assetOf, cutoutFor, usesCutout, OUT_W, OUT_H } from "./compose.js";
import { drawOverlay } from "./player.js";
import { ensureCardFonts } from "./visuals.js";
import { api } from "./api.js";

export function dimsOf(project, clip) {
  const d = {};
  const cut = clip && usesCutout(clip) ? cutoutFor(project, clip) : null;
  if (cut) d.cutmask = { w: cut.width, h: cut.height };
  for (const seg of clip?.segments || []) {
    const spec = assetOf(seg);
    if (!spec) continue;
    const a = (project.assets || []).find((x) => x.id === spec.id);
    if (a) d[mediaKey(seg)] = { w: a.width, h: a.height };
  }
  if (project.sources.speaker) d.spk = { w: project.sources.speaker.width, h: project.sources.speaker.height };
  if (project.sources.presentation) d.pres = { w: project.sources.presentation.width, h: project.sources.presentation.height };
  return d;
}

export function buildCaptions(words, start, end, maxWords) {
  const dur = end - start;
  const ws = (words || [])
    .filter((w) => w.end > start + 0.05 && w.start < end - 0.05)
    .map((w) => ({ text: w.text, start: Math.max(0, +(w.start - start).toFixed(3)), end: Math.min(dur, +(w.end - start).toFixed(3)) }));
  const caps = groupWords(ws, maxWords || 4);
  caps.forEach((c) => { c.end = Math.min(c.end, dur); });
  return caps.filter((c) => c.end - c.start > 0.05);
}

// Apply (or re-apply) the automatic engaging edit to a clip.
export function applyAutoEdit(clip, project, words, preset) {
  const has = { spk: !!project.sources.speaker, pres: !!project.sources.presentation };
  const r = autoEdit(clip, { slides: project.slides_master || [], words: words || [], has, preset });
  clip.segments = r.segments;
  clip.transition = r.transition;
  clip.motion = { strength: r.strength };
  clip.autoEdit = preset;
  clip.autoEditWords = (words || []).length > 0;
  clip.layoutEdited = false;
  return clip;
}

export function clipFromCandidate(cand, project, words, face) {
  const style = { ...TEMPLATES[0] };
  const hasPres = !!project.sources.presentation, hasSpk = !!project.sources.speaker;
  const layout = hasPres && hasSpk ? "split" : hasPres ? "pres" : "speaker";
  const clip = {
    id: cand.id,
    candidateId: cand.id,
    name: (cand.topic && cand.topic !== "general" ? cand.topic : "clip").slice(0, 40),
    start: cand.start,
    end: cand.end,
    segments: [newSegment(0, layout, 0.5)],
    splitOrder: "pres-top",
    transition: { type: "smooth", dur: 0.4 },
    framing: defaultFraming(face),
    background: { type: "blur", color: "#111111" },
    motion: { strength: 0.08 },
    templateId: style.id,
    style,
    smartPos: true,
    captionsOn: true,
    captions: buildCaptions(words, cand.start, cand.end, style.maxWords),
    captionsEdited: false,
    captionsKey: project.transcript?.created || null, // which transcript version the subtitles were built from
    hook: { ...DEFAULT_HOOK, enabled: false, line1: cand.hook_kind === "ai_suggested" ? cand.hook : "", line2: "",
            posY: 0.1, sizePct: 6.0, start: 0, end: 3 },
    emphasis: { ...DEFAULT_EMPHASIS },
    audio: { source: project.sync.audio, gain_db: 0, normalize: true, fade: 0.12 },
    fps: 30,
  };
  return applyAutoEdit(clip, project, words, "dynamic");
}

export async function ensureFonts(clip) {
  const fams = [[clip.style.weight, clip.style.font]];
  if (clip.hook?.enabled) fams.push([clip.hook.weight, clip.hook.font]);
  await Promise.all(fams.map(([w, f]) => document.fonts.load(`${w} 40px "${f}"`).catch(() => {})));
  await ensureCardFonts();
  await document.fonts.ready;
}

// Every time where the caption layer looks different.
function overlayTimes(clip, dur, fps, dims) {
  const proj = { captions: clip.captionsOn === false ? [] : clip.captions, style: clip.style, hook: clip.hook };
  const pts = new Set(changePoints(proj, dur, fps));
  if (clip.smartPos !== false && clip.captionsOn !== false && clip.captions.length) {
    // captions glide with layout transitions: sample every frame inside transition windows
    const d = clip.transition?.type === "cut" ? 0 : (clip.transition?.dur || 0.4);
    for (let i = 1; i < clip.segments.length; i++) {
      const tb = clip.segments[i].t;
      if (d === 0) pts.add(+tb.toFixed(3));
      for (let t = tb - d / 2; t <= tb + d / 2 + 1e-6; t += 1 / fps) if (t >= 0 && t < dur) pts.add(Math.round(t * 1000) / 1000);
    }
  }
  // illustration cards: appear/disappear smoothly -> sample every frame around their edges
  const d = clip.transition?.type === "cut" ? 0 : (clip.transition?.dur || 0.4);
  clip.segments.forEach((sg, i) => {
    if (sg.layout !== "visual") return;
    const en = i + 1 < clip.segments.length ? clip.segments[i + 1].t : dur;
    for (const edge of [sg.t, en]) {
      pts.add(Math.round(edge * 1000) / 1000);
      for (let t = edge - d / 2; t <= edge + d / 2 + 1e-6; t += 1 / fps) if (t >= 0 && t < dur) pts.add(Math.round(t * 1000) / 1000);
    }
  });
  return [...pts].filter((t) => t >= 0 && t < dur).sort((a, b) => a - b);
}

// Builds the render request: per-frame layout ops + caption images. onProgress(text)
export async function buildRenderRequest(clip, project, quality, onProgress) {
  const cut = usesCutout(clip) ? cutoutFor(project, clip) : null;
  if (usesCutout(clip) && !cut) throw new Error("This clip uses the person cutout, but it isn't prepared yet (or the clip timing changed). In Layout & cropping, select a cutout part and click “Prepare person cutout”.");
  await ensureFonts(clip);
  const fps = clip.fps || 30;
  const dur = clip.end - clip.start;
  const n = Math.round(dur * fps);
  const dims = dimsOf(project, clip);
  const frames = new Array(n);
  for (let i = 0; i < n; i++) frames[i] = round4(opsAt(clip, i / fps, dims));
  const W = quality === "preview" ? 540 : OUT_W, H = quality === "preview" ? 960 : OUT_H;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const times = overlayTimes(clip, dur, fps, dims);
  const blobs = [];
  const overlays = [];
  let prevUrl = null;
  for (let k = 0; k < times.length; k++) {
    if (k % 10 === 0) { onProgress?.(`Preparing subtitles ${k + 1}/${times.length}…`); await new Promise((r) => setTimeout(r)); }
    const t0 = times[k], t1 = k + 1 < times.length ? times[k + 1] : dur;
    ctx.clearRect(0, 0, W, H);
    const drew = drawOverlay(ctx, W, H, clip, t0 + 1e-4, dims);
    if (!drew) { prevUrl = null; continue; }
    const url = cv.toDataURL("image/png");
    if (url === prevUrl && overlays.length) { overlays[overlays.length - 1].end = t1; continue; }
    prevUrl = url;
    const blob = await (await fetch(url)).blob();
    overlays.push({ i: blobs.length, start: t0, end: t1 });
    blobs.push(blob);
  }
  const spec = {
    name: clip.name, start: clip.start, end: clip.end, fps, width: OUT_W, height: OUT_H, quality, frames, overlays,
    background: clip.background?.type === "color" ? clip.background.color : "#000000",
    audio: clip.audio,
    // assets used: video time at clip t=0 is (start point - part start)
    cutout: cut ? cut.id : null,
    assets: clip.segments.filter((sg) => assetOf(sg))
      .map((sg) => ({ key: mediaKey(sg), id: assetOf(sg).id, start: (assetOf(sg).in || 0) - sg.t, loop: !!assetOf(sg).loop })),
  };
  const fd = new FormData();
  fd.append("plan", new Blob([JSON.stringify(spec)], { type: "application/json" }), "plan.json");
  blobs.forEach((b, i) => fd.append("overlays", b, `ov${i}.png`));
  return fd;
}

export async function startRender(clip, project, quality, onProgress) {
  const fd = await buildRenderRequest(clip, project, quality, onProgress);
  onProgress?.("Sending to the renderer…");
  return api(`/api/projects/${project.id}/clips/${clip.id}/render`, { body: fd });
}

export function toSRT(captions, offset = 0) {
  const ts = (t) => {
    const ms = Math.max(0, Math.round((t + offset) * 1000));
    const hh = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.words.map((w) => w.text).join(" ")}\n`).join("\n");
}
