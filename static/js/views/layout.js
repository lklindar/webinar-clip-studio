// Step 5: vertical layout, layout changes over time, cropping, motion.
import { api, watchJob } from "../api.js";
import { h, toast, fmtTime, parseTime, slider, select, progressBar } from "../ui.js";
import { TEMPLATES } from "../captions.js";
import { FRAME_STYLE, frameOn, SPOT_MODES } from "../compose.js";
import { LAYOUTS, MOTIONS, FRAMING_LABELS, AUTO_PRESETS, ASSET_PLACES, cutoutFor, defaultFraming, regionsFor, segmentAt, newSegment, autoLayoutFromSlides } from "../compose.js";
import { applyAutoEdit, buildCaptions } from "../clipstate.js";
import { clipDur, toEdit, editWords, setKeep, hasCuts, cutPoints } from "../cuts.js";
import { previewCanvas } from "./suggest.js";
import { assetsPanel, pickAsset, mediaPart, thumbUrl } from "./assets.js";
import { cardFromSpeech, CARD_KINDS, CARD_THEMES } from "../visuals.js";
import { editorShell } from "./editorshell.js";

const ICONS = {
  split: '<svg width="22" height="36" viewBox="0 0 22 36"><rect x="1" y="1" width="20" height="17" rx="2" fill="#0ea5e9"/><rect x="1" y="18" width="20" height="17" rx="2" fill="#f59e0b"/></svg>',
  pres: '<svg width="22" height="36" viewBox="0 0 22 36"><rect x="1" y="1" width="20" height="34" rx="2" fill="#334"/><rect x="1" y="12" width="20" height="12" fill="#0ea5e9"/></svg>',
  speaker: '<svg width="22" height="36" viewBox="0 0 22 36"><rect x="1" y="1" width="20" height="34" rx="2" fill="#f59e0b"/></svg>',
  pip: '<svg width="22" height="36" viewBox="0 0 22 36"><rect x="1" y="1" width="20" height="34" rx="2" fill="#f59e0b"/><rect x="3" y="4" width="16" height="9" rx="1" fill="#0ea5e9" stroke="#fff"/></svg>',
  cutout: '<svg width="22" height="36" viewBox="0 0 22 36"><rect x="1" y="1" width="20" height="34" rx="2" fill="#0ea5e9"/><circle cx="11" cy="18" r="4" fill="#fde68a"/><path d="M3 35c0-7 4-11 8-11s8 4 8 11z" fill="#e11d48"/></svg>',
  media: '<svg width="22" height="36" viewBox="0 0 22 36"><rect x="1" y="1" width="20" height="17" rx="2" fill="#8b5cf6"/><path d="M4 15l5-6 4 4 2-2 4 4z" fill="#fff"/><circle cx="15" cy="6" r="2" fill="#fff"/><rect x="1" y="18" width="20" height="17" rx="2" fill="#f59e0b"/></svg>',
  visual: '<svg width="22" height="36" viewBox="0 0 22 36"><rect x="1" y="1" width="20" height="17" rx="2" fill="#ec4899"/><circle cx="11" cy="8" r="3" fill="#fff"/><rect x="5" y="13" width="12" height="2" fill="#fff"/><rect x="1" y="18" width="20" height="17" rx="2" fill="#f59e0b"/></svg>',
};

export async function render(main, ctx) {
  const ed = await editorShell(main, ctx, { step: "layout", title: "5. Layout & cropping",
    intro: "Arrange the vertical 9:16 video. Change the layout at any moment, adjust cropping and zoom, and add subtle motion." });
  if (!ed) return;
  const { clip, player, right } = ed;
  // any manual change to the layout stops the automatic edit from overwriting it
  const changed = (redraw = true) => { clip.layoutEdited = true; ed.changed(redraw); };
  const p = ctx.state.project;
  const has = { spk: !!p.sources.speaker, pres: !!p.sources.presentation };
  let sel = Math.min(ctx.state.layoutSel ?? 0, clip.segments.length - 1);  // selected segment index
  let framingKey = null;    // selected framing region
  const dur = () => clipDur(clip);

  const tl = h("div", { class: "timeline" });
  const segBox = h("div", { class: "card" });
  const frameBox = h("div", { class: "card" });
  const lookBox = h("div", { class: "card" });
  const timingBox = h("div", { class: "card" });
  const autoBox = h("div", { class: "card", style: { borderColor: "#d6d6fb", background: "#fbfbff" } });
  const drawAuto = () => {
    autoBox.innerHTML = "";
    autoBox.append(
      h("div", { class: "row between" },
        h("h3", {}, "✨ Auto-edit (keeps viewers watching)"),
        clip.autoEdit && !clip.layoutEdited ? h("span", { class: "chip ok" }, `${AUTO_PRESETS[clip.autoEdit].label} edit applied`) :
          clip.layoutEdited ? h("span", { class: "chip" }, "edited by you") : null),
      h("p", { class: "small muted" }, "Automatically switches between split screen, full-screen slides, speaker close-ups and the slide card; ",
        "cuts at pauses in speech, shows slides full screen when they change, punches in on questions and strong statements, ",
        "and adds slow zooms and glides so even a static slide keeps moving."),
      h("div", { class: "row" },
        h("div", { class: "seg-ctl" }, Object.entries(AUTO_PRESETS).map(([k, v]) =>
          h("button", { class: clip.autoEdit === k && !clip.layoutEdited ? "on" : "", onclick: () => runAuto(k),
            title: `About one change every ${v.every[0]}–${v.every[1]} s` }, v.label))),
        clip.undoSegments ? h("button", { class: "btn small ghost", onclick: undoAuto }, "↶ Undo") : null,
        h("span", { class: "small muted" }, "Then fine-tune any part below.")));
  };
  async function runAuto(preset) {
    const tr = await ctx.transcript();
    clip.undoSegments = { segments: clip.segments, transition: clip.transition, motion: clip.motion, layoutEdited: clip.layoutEdited, autoEdit: clip.autoEdit };
    applyAutoEdit(clip, p, tr?.words || [], preset);
    sel = 0; framingKey = null;
    ed.changed(); drawAll();
    toast(`${AUTO_PRESETS[preset].label} edit: ${clip.segments.length} parts. Press play to watch it.`, "ok");
  }
  function undoAuto() {
    const u = clip.undoSegments;
    Object.assign(clip, { segments: u.segments, transition: u.transition, motion: u.motion, layoutEdited: !!u.layoutEdited, autoEdit: u.autoEdit || null });
    clip.undoSegments = null;
    sel = 0; ed.changed(); drawAll();
  }
  const tr0 = await ctx.transcript();
  const speechIn = (a, b) => editWords(clip, tr0?.words || []).filter((w) => w.end > a && w.start < b).map((w) => w.text).join(" ");
  // ---------------------------------------------------------------- edit style (Standard / Header & safe zone)
  const styleBox = h("div", { class: "card", style: { borderColor: "#d6d6fb", background: "#fbfbff" } });
  const cand = p.candidates.find((c) => c.id === clip.candidateId || c.id === clip.id);
  const logoKey = `wcs.headerLogo.${p.id}`;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignore */ } };
  function applyHeaderStyle() {
    const snap = JSON.parse(JSON.stringify({ segments: clip.segments, framing: clip.framing, style: clip.style, templateId: clip.templateId,
      smartPos: clip.smartPos !== false, backdrop: clip.backdrop !== false, captions: clip.captions, captionsEdited: clip.captionsEdited, transition: clip.transition, layoutEdited: clip.layoutEdited }));
    if (!frameOn(clip)) clip.undoStyle = snap;
    const top = FRAME_STYLE.top, bottom = FRAME_STYLE.bottom;
    clip.frame = { on: true, top, bottom };
    clip.header = { on: true, font: "DM Serif Display", color: "#FFFFFF",
      title: clip.header?.title ?? (cand?.title || clip.name || ""), logoUrl: clip.header?.logoUrl ?? lsGet(logoKey) ?? "" };
    // slides full width at their own aspect ratio on top, the room camera below — no layout changes
    const pd = p.sources.presentation, box = 1 - top - bottom;
    const slideH = pd ? (1080 * pd.height / pd.width) / 1920 : 0.32;
    const split = Math.max(0.3, Math.min(0.7, slideH / box));
    clip.segments = [{ ...newSegment(0, has.pres && has.spk ? "split" : has.pres ? "pres" : "speaker", split), motion: "none" }];
    clip.splitOrder = "pres-top";
    clip.layoutEdited = true;
    // subtitles: one word at a time, key words in orange, on the upper part of the camera picture
    const tpl = TEMPLATES.find((x) => x.id === "oneword");
    const camTop = top + box * (has.pres && has.spk ? split : 0), camBot = 1 - bottom;
    clip.templateId = tpl.id;
    clip.style = { ...tpl, keywords: clip.style?.keywords && clip.style.keywordsOn ? clip.style.keywords : tpl.keywords,
      posY: +(camTop + (camBot - camTop) * 0.8).toFixed(3) };   // lower part of the camera: stays off the speaker's face
    clip.smartPos = false;
    clip.backdrop = false;          // just a shadow behind the word, no dark box
    if (!clip.captionsEdited) clip.captions = buildCaptions(tr0?.words || [], clip.start, clip.end, clip.style.maxWords, clip);
    sel = 0;
  }
  function applyStandard() {
    const u = clip.undoStyle;
    if (u) Object.assign(clip, u);
    clip.frame = { ...(clip.frame || {}), on: false };
    if (clip.header) clip.header.on = false;
    delete clip.undoStyle;
    sel = 0;
  }
  const drawStyle = () => {
    styleBox.innerHTML = "";
    const on = frameOn(clip);
    const choose = (v) => { if (v === "header" && !on) applyHeaderStyle(); if (v === "standard" && on) applyStandard(); ed.changed(); drawStyle(); drawAll(); };
    styleBox.append(h("div", { class: "row between" }, h("h3", {}, "🎬 Edit style"),
      h("div", { class: "seg-ctl" },
        h("button", { class: on ? "" : "on", onclick: () => choose("standard") }, "Standard"),
        h("button", { class: on ? "on" : "", onclick: () => choose("header") }, "Header & safe zone"))));
    if (!on) {
      styleBox.append(h("p", { class: "small muted" }, "Standard: slides and speaker fill the whole 9:16 frame. ",
        "“Header & safe zone” = like your boss's video: title and logo on top, slides, the camera below, an empty band at the bottom, and one-word subtitles with key words in orange."));
      return;
    }
    const hd = clip.header;
    const title = h("input", { type: "text", value: hd.title || "", placeholder: "e.g. 3 AI levels for business owners", style: { width: "100%" } });
    title.addEventListener("input", () => { hd.title = title.value; ed.changed(false); player.draw(); });
    title.addEventListener("change", () => ed.changed());
    const kw = h("input", { type: "text", value: clip.style.keywords || "", placeholder: "AI, ChatGPT, COO", style: { width: "100%" } });
    kw.addEventListener("change", () => { clip.style.keywords = kw.value; ed.changed(); player.draw(); });
    const logoImg = hd.logoUrl ? h("img", { src: hd.logoUrl, style: { height: "34px", maxWidth: "120px", objectFit: "contain", background: "#333", borderRadius: "6px", padding: "3px" } }) : null;
    styleBox.append(
      h("p", { class: "small muted" }, "Top: title + logo · middle: slides and camera · bottom: left empty for the TikTok / Reels buttons. Subtitles show one word at a time."),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Title at the top (stays the whole clip)"), title),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Logo"),
        h("div", { class: "row" }, logoImg,
          h("button", { class: "btn small", onclick: async () => {
            const a = await pickAsset(ctx, null);
            if (!a) return;
            if (a.kind !== "image") { toast("Choose an image (PNG with a transparent background works best).", "error"); return; }
            hd.logoUrl = `/api/projects/${p.id}/assets/${a.id}/file`;
            lsSet(logoKey, hd.logoUrl);
            ed.changed(); drawStyle(); player.draw();
          } }, hd.logoUrl ? "Change logo" : "Choose logo…"),
          hd.logoUrl ? h("button", { class: "btn small ghost", onclick: () => { hd.logoUrl = ""; lsSet(logoKey, ""); ed.changed(); drawStyle(); player.draw(); } }, "Remove") : null,
          h("span", { class: "small muted" }, "Upload it first under “Your assets” (step 1)."))),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Words shown in orange (besides abbreviations like AI and numbers)"), kw));
  };
  drawStyle();

  // ---------------------------------------------------------------- spotlight + click on what he talks about
  const spotBox = h("div", { class: "card" });
  const drawSpots = () => {
    spotBox.innerHTML = "";
    if (!has.pres) { spotBox.style.display = "none"; return; }
    const list = clip.spotlights || [];
    const jobBox = h("div");
    const find = h("button", { class: "btn small primary", onclick: async () => {
      find.disabled = true;
      try {
        const job = await api(`/api/projects/${p.id}/spotlights`, { json: { start: clip.start, end: clip.end } });
        const done = await watchJob(job.id, (j) => { jobBox.innerHTML = ""; jobBox.append(progressBar(j.progress, j.message || "Reading the slides…")); });
        jobBox.innerHTML = "";
        const D = clip.end - clip.start;
        clip.spotlights = (done.result.events || []).map((e, i) => ({ id: `s${i}`, on: true, text: e.text, said: e.said, box: e.box, click: e.click,
          t0: +toEdit(clip, Math.max(0, e.start - clip.start)).toFixed(2), t1: +toEdit(clip, Math.min(D, e.end - clip.start)).toFixed(2) }))
          .filter((e) => e.t1 - e.t0 >= 0.8);
        if (clip.spotOn === undefined) clip.spotOn = true;
        ed.changed();
        toast(clip.spotlights.length ? `Found ${clip.spotlights.length} moment${clip.spotlights.length > 1 ? "s" : ""}. Press play to see it.` : "No slide element clearly matches what he says in this clip.", clip.spotlights.length ? "ok" : "info", 6000);
      } catch (e) { if (!e.cancelled) toast(e.message, "error"); }
      drawSpots();
    } }, list.length ? "Find again" : "Find the important points");
    spotBox.append(
      h("div", { class: "row between" }, h("h3", {}, "🔦 Spotlight on what he talks about"),
        list.length ? h("label", { class: "check", style: { margin: 0 } }, h("input", { type: "checkbox", checked: clip.spotOn !== false,
          onchange: (e) => { clip.spotOn = e.target.checked; ed.changed(); } }), "On") : null),
      h("p", { class: "small muted" }, "The app reads the text on the slides and listens to what he says. When he talks about one element (e.g. “AI Chatbot – a knowledgeable intern”), ",
        "that element stays sharp, the rest of the slide dims, and a click ring pops on it."),
      h("div", { class: "row" }, find,
        list.length ? select("Effect", clip.spotMode || "both", Object.entries(SPOT_MODES), (v) => { clip.spotMode = v; ed.changed(); }) : null),
      jobBox);
    if (list.length) {
      spotBox.append(h("div", { style: { marginTop: "8px" } }, list.map((e) => h("div", { class: "row", style: { padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "nowrap", alignItems: "flex-start" } },
        h("input", { type: "checkbox", checked: e.on !== false, title: "Use this moment", onchange: (ev) => { e.on = ev.target.checked; ed.changed(); } }),
        h("button", { class: "btn small ghost", title: "Watch this moment", onclick: () => { player.seek(Math.max(0, e.t0 - 0.5)); player.play(); } }, `▶ ${fmtTime(e.t0)}–${fmtTime(e.t1)}`),
        h("div", { style: { flex: "1", minWidth: 0 } }, h("b", { class: "small" }, e.text.slice(0, 60)),
          h("div", { class: "small muted", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "“", e.said || "", "”"))))));
    }
  };
  drawSpots();

  const assetBox = assetsPanel(ctx, clip, { onApply: (msg) => { changed(); drawAll(); toast(msg + " Press play to watch it.", "ok"); } });
  right.append(
    styleBox,
    spotBox,
    assetBox,
    h("div", { class: "card" },
      h("div", { class: "row between" }, h("h3", {}, "Layout timeline"),
        h("div", { class: "row" },
          h("button", { class: "btn small primary", onclick: addAtPlayhead }, "+ Layout change at playhead"),
          has.pres && has.spk ? h("button", { class: "btn small", onclick: autoSlides, title: "Show each new slide full screen for a few seconds" }, "✨ Auto from slide changes") : null,
          h("button", { class: "btn small ghost", onclick: resetLayout }, "Reset"))),
      tl,
      h("div", { class: "tl-legend" }, Object.entries(LAYOUTS).map(([k, v]) => h("span", {}, h("i", { style: { background: v.color } }), v.short)),
        h("span", {}, h("i", { style: { background: "#0ea5e9", width: "2px" } }), "slide change"), h("span", {}, h("i", { style: { background: "#9aa0bd" } }), "subtitles"),
        h("span", { class: "muted" }, "Drag the black lines to change timing; click a block to select it."))),
    segBox, frameBox, lookBox, timingBox,
    h("div", { class: "row end" }, h("button", { class: "btn primary big", onclick: () => ctx.go("subtitles", clip.id) }, "Next: Subtitles →")));

  // ------------------------------------------------------------ timeline
  function drawTimeline() {
    tl.innerHTML = "";
    const D = dur();
    const pct = (t) => `${(t / D) * 100}%`;
    clip.segments.forEach((s, i) => {
      const end = i + 1 < clip.segments.length ? clip.segments[i + 1].t : D;
      const L = LAYOUTS[s.layout];
      const seg = h("div", { class: "tl-seg" + (i === sel ? " sel" : ""), style: { left: pct(s.t), width: pct(end - s.t), background: L.color },
        title: `${L.label} · ${fmtTime(s.t)}–${fmtTime(end)}` },
        L.short + (s.layout === "split" ? ` ${Math.round((s.split ?? 0.5) * 100)}%` : "") + (s.motion && s.motion !== "none" ? " · " + MOTIONS[s.motion].label.toLowerCase() : ""));
      seg.addEventListener("click", (e) => { e.stopPropagation(); sel = i; framingKey = null; player.seek(Math.max(s.t, Math.min(end - 0.05, player.t))); drawAll(); });
      tl.append(seg);
      if (i > 0) {
        const hd = h("div", { class: "tl-handle", style: { left: pct(s.t) }, title: "Drag to change when this layout starts" });
        hd.addEventListener("pointerdown", (e) => {
          e.preventDefault(); e.stopPropagation();
          hd.setPointerCapture(e.pointerId);
          const rect = tl.getBoundingClientRect();
          const move = (ev) => {
            const t = ((ev.clientX - rect.left) / rect.width) * D;
            const lo = clip.segments[i - 1].t + 0.5, hi = (i + 1 < clip.segments.length ? clip.segments[i + 1].t : D) - 0.5;
            s.t = Math.round(Math.max(lo, Math.min(hi, t)) * 10) / 10;
            player.seek(s.t);
            drawTimeline();
          };
          const up = () => { hd.removeEventListener("pointermove", move); changed(); drawSegment(); };
          hd.addEventListener("pointermove", move);
          hd.addEventListener("pointerup", up, { once: true });
        });
        tl.append(hd);
      }
    });
    for (const t of p.slides_master || []) {
      if (t <= clip.start || t >= clip.end) continue;
      const r = toEdit(clip, t - clip.start);
      if (r > 0 && r < D) tl.append(h("div", { class: "tl-slide", style: { left: pct(r) }, title: `Slide change at ${fmtTime(r)}` }));
    }
    for (const ct of cutPoints(clip)) tl.append(h("div", { class: "tl-slide", style: { left: pct(ct), background: "#ef4444", opacity: 0.55 }, title: `Silence / filler removed here (${fmtTime(ct)})` }));
    for (const c of clip.captions || []) tl.append(h("div", { class: "tl-cap", style: { left: pct(c.start), width: pct(Math.max(0.05, c.end - c.start - 0.03)) } }));
    const ph = h("div", { class: "tl-play", style: { left: pct(player.t) } });
    tl.append(ph);
    tl._ph = ph;
  }
  tl.addEventListener("click", (e) => {
    const rect = tl.getBoundingClientRect();
    player.seek(((e.clientX - rect.left) / rect.width) * dur());
  });
  player.onTime((t) => {
    if (tl._ph) tl._ph.style.left = `${(t / dur()) * 100}%`;
    const i = segmentAt(clip, t);
    if (i !== sel && player.playing) { sel = i; framingKey = null; drawTimeline(); drawSegment(); drawFraming(); }
  });

  function addAtPlayhead() {
    const t = Math.round(player.t * 10) / 10;
    if (t < 0.3 || t > dur() - 0.3) { toast("Move the playhead inside the clip first.", "error"); return; }
    if (clip.segments.some((s) => Math.abs(s.t - t) < 0.4)) { toast("There is already a layout change here.", "error"); return; }
    const cur = clip.segments[segmentAt(clip, t)];
    const next = cur.layout === "split" ? (has.pres ? "pres" : "speaker") : "split";
    clip.segments.push({ ...newSegment(t, next, cur.split ?? 0.5) });
    clip.segments.sort((a, b) => a.t - b.t);
    sel = clip.segments.findIndex((s) => s.t === t);
    framingKey = null;
    changed(); drawAll();
    toast(`Added a change to “${LAYOUTS[next].label}” at ${fmtTime(t)}. Pick another layout below if you like.`);
  }

  function autoSlides() {
    const segs = autoLayoutFromSlides(clip, p.slides_master || []);
    if (segs.length <= 1) { toast("No slide changes were detected inside this clip.", "info"); return; }
    clip.segments = segs;
    sel = 0; changed(); drawAll();
    toast(`Added ${segs.length - 1} layout changes around ${Math.floor((segs.length - 1) / 2)} slide change(s).`, "ok");
  }

  function resetLayout() {
    clip.segments = [newSegment(0, has.pres && has.spk ? "split" : has.pres ? "pres" : "speaker")];
    sel = 0; changed(); drawAll();
  }

  // ------------------------------------------------------------ selected segment
  function drawSegment() {
    const s = clip.segments[sel];
    const end = sel + 1 < clip.segments.length ? clip.segments[sel + 1].t : dur();
    segBox.innerHTML = "";
    const tIn = h("input", { class: "inline time", value: fmtTime(s.t), disabled: sel === 0 });
    tIn.addEventListener("change", () => {
      const v = parseTime(tIn.value);
      const lo = clip.segments[sel - 1].t + 0.5, hi = (sel + 1 < clip.segments.length ? clip.segments[sel + 1].t : dur()) - 0.5;
      if (isNaN(v) || v < lo || v > hi) { toast(`Enter a time between ${fmtTime(lo)} and ${fmtTime(hi)}.`, "error"); tIn.value = fmtTime(s.t); return; }
      s.t = Math.round(v * 10) / 10; changed(); drawAll();
    });
    segBox.append(
      h("div", { class: "row between" }, h("h3", {}, `Selected part: ${fmtTime(s.t)} – ${fmtTime(end)}`),
        sel > 0 ? h("button", { class: "btn small ghost danger", onclick: () => { clip.segments.splice(sel, 1); sel = Math.max(0, sel - 1); changed(); drawAll(); } }, "Remove this change") : null),
      h("div", { class: "layout-pick" }, Object.entries(LAYOUTS).map(([k, v]) => {
        const disabled = k === "cutout" ? !has.spk : k !== "visual" && k !== "media" && ((k !== "speaker" && !has.pres) || (k !== "pres" && !has.spk));
        return h("button", { class: "layout-btn" + (s.layout === k ? " on" : ""), disabled, title: v.desc, html: ICONS[k] + v.label,
          onclick: async () => {
            if (k === "media") {
              const a = await pickAsset(ctx, s.asset?.id);
              if (!a) return;
              const part = mediaPart(a, has.spk, s.uid);
              Object.assign(s, { layout: "media", uid: part.uid, asset: part.asset, motion: s.motion && s.motion !== "none" && !/^tour/.test(s.motion) ? s.motion : "zoomIn", motionTarget: "auto" });
              framingKey = null; changed(); drawAll();
              return;
            }
            s.layout = k;
            if (k === "visual" && !s.card) s.card = cardFromSpeech(speechIn(s.t, end) || "Key idea", "night");
            framingKey = null; changed(); drawAll();
          } });
      })),
      s.layout === "visual" && s.card ? cardEditor(s, end) : null,
      s.layout === "media" && s.asset ? assetEditor(s, end) : null,
      s.layout === "cutout" ? cutoutEditor(s) : null,
      s.layout === "split" || s.layout === "visual" || (s.layout === "media" && (s.asset?.place || "top") === "top") ? slider(s.layout === "split" ? "Split: slides height" : "Split: top area height", Math.round((s.split ?? 0.5) * 100), 25, 75, 1,
        (v) => { s.split = v / 100; changed(); drawTimeline(); }, (v) => `${v}% / ${100 - v}%`) : null,
      h("div", { class: "grid2" },
        select("Motion in this part", s.motion || "none", Object.entries(MOTIONS).map(([k, v]) => [k, v.label]), (v) => { s.motion = v; changed(); drawTimeline(); }),
        select("Motion applies to", s.motionTarget || "auto", [["auto", "Automatic"], ["spk", "Speaker"], ["pres", "Slides"]], (v) => { s.motionTarget = v; changed(); })),
      h("div", { class: "row small" }, h("span", { class: "muted" }, "Starts at"), tIn, sel === 0 ? h("span", { class: "muted" }, "(the first part always starts at 0:00)") : null));
  }

  function cutoutEditor(s) {
    const box = h("div", { class: "card flat", style: { margin: "10px 0", padding: "12px" } });
    const cut = cutoutFor(ctx.state.project, clip);
    const running = (ctx.state.project.jobs || []).find((j) => j.kind === "cutout" && (j.status === "running" || j.status === "queued"));
    const dur = clipDur(clip);
    if (cut) box.append(h("div", { class: "small", style: { color: "var(--ok)", fontWeight: 600 } }, "✓ Person cutout ready — the speaker's background is replaced by the slides."));
    else if (running) box.append(progressBar(running.progress, running.message || "Cutting out the speaker…"));
    else box.append(h("div", { class: "alert info", style: { marginBottom: 0 } },
      "To remove the speaker's background, the app first finds the person in every frame of this clip (on your Mac, ",
      `about ${Math.max(10, Math.round(dur * 30 * 0.05))} s). Until then the preview shows the normal speaker picture. `,
      h("button", { class: "btn small primary", onclick: prepareCutout }, "Prepare person cutout")));
    // what is behind the speaker: the slides, or one of the uploaded assets
    const bgA = s.bgAsset;
    const asset = bgA && (ctx.state.project.assets || []).find((x) => x.id === bgA.id);
    const chooseAsset = async () => {
      const a = await pickAsset(ctx, bgA?.id);
      if (!a) return;
      s.uid = s.uid || Math.random().toString(36).slice(2, 10);
      s.bgAsset = { id: a.id, in: 0, fit: "fill", zoom: 1, x: 0.5, y: 0.5, loop: a.kind === "video" };
      changed(); drawSegment();
    };
    const bgBox = h("div", { style: { margin: "10px 0" } },
      h("div", { class: "field-label", style: { marginBottom: "6px" } }, "Background behind the speaker"),
      h("div", { class: "seg-ctl" },
        h("button", { class: !bgA && s.slidesMode !== "top" ? "on" : "", disabled: !has.pres, title: "The slides fill the whole background behind the speaker",
          onclick: () => { delete s.bgAsset; s.slidesMode = "fill"; framingKey = null; changed(); drawSegment(); drawFraming(); } }, "🖥️ Slides fill the background"),
        h("button", { class: !bgA && s.slidesMode === "top" ? "on" : "", disabled: !has.pres, title: "Whole slide at the top, blurred copy behind the speaker",
          onclick: () => { delete s.bgAsset; s.slidesMode = "top"; framingKey = null; changed(); drawSegment(); drawFraming(); } }, "Slides on top"),
        h("button", { class: bgA ? "on" : "", onclick: chooseAsset }, "🖼️ One of my assets…")));
    if (bgA && !asset) bgBox.append(h("div", { class: "alert error", style: { marginTop: "8px" } }, "That asset was deleted. ",
      h("button", { class: "btn small", onclick: chooseAsset }, "Pick another")));
    if (bgA && asset) {
      const upd = (k, v, redraw = false) => { bgA[k] = v; changed(); if (redraw) drawSegment(); };
      bgBox.append(h("div", { class: "row", style: { alignItems: "flex-start", marginTop: "8px" } },
        h("img", { src: thumbUrl(p.id, asset), style: { width: "120px", aspectRatio: "16/10", objectFit: "cover", borderRadius: "8px" } }),
        h("div", { style: { flex: "1", minWidth: "220px" } },
          h("div", { class: "row between" }, h("b", { class: "small" }, asset.name), h("button", { class: "btn small", onclick: chooseAsset }, "Change")),
          asset.kind === "video" ? h("div", {},
            slider("Start the video at", bgA.in || 0, 0, Math.max(0, Math.floor((asset.duration - 0.5) * 10) / 10), 0.1, (v) => upd("in", v), (v) => `${v.toFixed(1)} s of ${asset.duration.toFixed(1)} s`),
            h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!bgA.loop, onchange: (e) => upd("loop", e.target.checked) }),
              "Loop the video (otherwise its last frame stays when it ends)")) : null,
          h("div", { class: "row" }, h("div", { class: "seg-ctl" },
            h("button", { class: (bgA.fit || "fill") === "fill" ? "on" : "", onclick: () => upd("fit", "fill", true) }, "Fill (crop)"),
            h("button", { class: bgA.fit === "fit" ? "on" : "", onclick: () => upd("fit", "fit", true) }, "Fit (show all)"))),
          h("div", { class: "grid3" },
            slider("Zoom", Math.round((bgA.zoom || 1) * 100), 50, 300, 1, (v) => upd("zoom", v / 100), (v) => `${v}%`),
            slider("Horizontal", Math.round((bgA.x ?? 0.5) * 100), 0, 100, 1, (v) => upd("x", v / 100), (v) => `${v}`),
            slider("Vertical", Math.round((bgA.y ?? 0.5) * 100), 0, 100, 1, (v) => upd("y", v / 100), (v) => `${v}`)))));
    }
    box.append(
      bgBox,
      slider("Speaker size (height of the screen)", Math.round((s.personH ?? 0.62) * 100), 35, 90, 1, (v) => { s.personH = v / 100; changed(); }, (v) => `${v}%`),
      h("p", { class: "small muted", style: { margin: 0 } }, bgA ? "Move or zoom the speaker in “Cropping & position” below." : "Move or zoom the speaker — or choose which part of the slide is shown behind them — in “Cropping & position” below."));
    return box;
  }

  async function prepareCutout() {
    try {
      const r = await api(`/api/projects/${p.id}/cutout`, { json: { start: clip.start, end: clip.end, quality: "accurate" } });
      ctx.kickTasks();
      if (r.job) {
        drawSegment();
        await watchJob(r.job.id, () => drawSegment());
      }
      await ctx.refresh();
      player.draw();
      drawSegment();
      toast("Person cutout ready. Press play to watch it.", "ok");
    } catch (e) { toast(e.message, "error", 8000); drawSegment(); }
  }

  function assetEditor(s, end) {
    const a = (ctx.state.project.assets || []).find((x) => x.id === s.asset.id);
    if (!a) return h("div", { class: "alert error" }, "This asset was deleted. ", h("button", { class: "btn small", onclick: async () => {
      const b = await pickAsset(ctx); if (b) { s.asset = mediaPart(b, has.spk, s.uid).asset; changed(); drawAll(); } } }, "Pick another"));
    const A = s.asset;
    const upd = (k, v, redraw = false) => { A[k] = v; changed(); if (redraw) drawSegment(); };
    const partLen = end - s.t;
    return h("div", { class: "card flat", style: { margin: "10px 0", padding: "12px" } },
      h("div", { class: "row", style: { alignItems: "flex-start" } },
        h("img", { src: thumbUrl(p.id, a), style: { width: "150px", aspectRatio: "16/10", objectFit: "cover", borderRadius: "8px" } }),
        h("div", { style: { flex: "1", minWidth: "220px" } },
          h("div", { class: "row between" }, h("b", { class: "small" }, a.name),
            h("button", { class: "btn small", onclick: async () => { const b = await pickAsset(ctx, a.id); if (b) { s.asset = { ...mediaPart(b, has.spk, s.uid).asset, place: A.place }; changed(); drawAll(); } } }, "Change asset")),
          has.spk ? h("div", { class: "seg-ctl", style: { margin: "8px 0" } }, Object.entries(ASSET_PLACES).map(([k, l]) =>
            h("button", { class: (A.place || "top") === k ? "on" : "", onclick: () => upd("place", k, true) }, l))) : null,
          a.kind === "video" ? slider("Start the video at", A.in || 0, 0, Math.max(0, Math.floor((a.duration - 0.5) * 10) / 10), 0.1,
            (v) => upd("in", v), (v) => `${v.toFixed(1)} s of ${a.duration.toFixed(1)} s`) : null,
          a.kind === "video" && a.duration - (A.in || 0) < partLen - 0.2 ? h("p", { class: "small muted" }, `The video is shorter than this part (${partLen.toFixed(1)} s); its last frame is held at the end.`) : null,
          a.kind === "video" && a.has_audio ? h("p", { class: "small muted" }, "The asset's own sound is not used — the speaker's audio continues.") : null)),
      h("div", { class: "row", style: { marginTop: "8px" } },
        h("div", { class: "seg-ctl" },
          h("button", { class: (A.fit || "fit") === "fit" ? "on" : "", onclick: () => upd("fit", "fit", true) }, "Fit (show all)"),
          h("button", { class: A.fit === "fill" ? "on" : "", onclick: () => upd("fit", "fill", true) }, "Fill (crop)"))),
      h("div", { class: "grid3" },
        slider("Zoom", Math.round((A.zoom || 1) * 100), 50, 300, 1, (v) => upd("zoom", v / 100), (v) => `${v}%`),
        slider("Horizontal", Math.round((A.x ?? 0.5) * 100), 0, 100, 1, (v) => upd("x", v / 100), (v) => `${v}`),
        slider("Vertical", Math.round((A.y ?? 0.5) * 100), 0, 100, 1, (v) => upd("y", v / 100), (v) => `${v}`)));
  }

  function cardEditor(s, end) {
    const c = s.card;
    const prev = h("div");
    const redrawPrev = () => { prev.innerHTML = ""; prev.append(previewCanvas(c, 200, 178)); player.draw(); };
    const upd = (k, v) => { c[k] = v; changed(); redrawPrev(); };
    const box = h("div", { class: "card flat", style: { margin: "10px 0", padding: "12px" } },
      h("div", { class: "row", style: { alignItems: "flex-start" } }, prev,
        h("div", { style: { flex: "1", minWidth: "220px" } },
          h("div", { class: "grid2" },
            h("label", { class: "field" }, h("span", { class: "field-label" }, "Card type"),
              h("select", { onchange: (e) => upd("kind", e.target.value) }, Object.entries(CARD_KINDS).map(([k, l]) => h("option", { value: k, selected: c.kind === k }, l)))),
            h("label", { class: "field" }, h("span", { class: "field-label" }, "Style"),
              h("select", { onchange: (e) => upd("theme", e.target.value) }, Object.entries(CARD_THEMES).map(([k, t]) => h("option", { value: k, selected: c.theme === k }, t.label))))),
          h("div", { class: "row" },
            h("label", { class: "field", style: { width: "70px" } }, h("span", { class: "field-label" }, "Icon"),
              h("input", { value: c.icon || "", oninput: (e) => upd("icon", e.target.value) })),
            h("label", { class: "field", style: { flex: "1" } }, h("span", { class: "field-label" }, c.kind === "stat" ? "Big number" : "Main text"),
              h("input", { value: c.title || "", oninput: (e) => upd("title", e.target.value) }))),
          h("label", { class: "field" }, h("span", { class: "field-label" }, c.kind === "list" ? "List items (one per line)" : "Extra line (optional)"),
            h("textarea", { rows: c.kind === "list" ? 3 : 1, style: { border: "1px solid var(--line)", borderRadius: "8px", padding: "6px" },
              oninput: (e) => upd("lines", e.target.value.split("\n").filter((x) => x.trim())) }, (c.lines || []).join("\n"))),
          h("button", { class: "btn small", onclick: () => { s.card = cardFromSpeech(speechIn(s.t, end) || c.title, c.theme); changed(); drawAll(); } }, "↺ Make from what he says here"))),
      h("p", { class: "small muted", style: { margin: "6px 0 0" } }, `He says: “${speechIn(s.t, end).slice(0, 160) || "…"}”`));
    redrawPrev();
    return box;
  }

  // ------------------------------------------------------------ framing / crop
  function drawFraming() {
    const s = clip.segments[sel];
    const keys = regionsFor(s, clip, has).map((r) => r.key).filter(Boolean);
    const defs = defaultFraming();
    for (const k of keys) if (!clip.framing[k]) clip.framing[k] = { ...defs[k] };
    if (!keys.length) { frameBox.innerHTML = ""; frameBox.append(h("h3", {}, "Cropping & position"), h("p", { class: "small muted" }, "This part shows only the illustration card.")); return; }
    if (!framingKey || !keys.includes(framingKey)) framingKey = keys[0];
    const f = clip.framing[framingKey];
    const isSpk = framingKey.includes("spk");
    frameBox.innerHTML = "";
    const upd = () => { changed(); };
    frameBox.append(
      h("h3", {}, "Cropping & position"),
      s.focus ? h("div", { class: "alert info", style: { padding: "8px 12px" } }, "This part zooms into one area of the slide (from Suggestions). ",
        h("button", { class: "btn small", onclick: () => { delete s.focus; changed(); drawAll(); } }, "Show whole slide again")) : null,
      keys.length > 1 ? h("div", { class: "seg-ctl", style: { marginBottom: "10px" } }, keys.map((k) =>
        h("button", { class: k === framingKey ? "on" : "", onclick: () => { framingKey = k; drawFraming(); } }, k.includes("spk") ? "🎤 Speaker" : "🖥️ Slides"))) : null,
      h("p", { class: "small muted" }, FRAMING_LABELS[framingKey], " — applies everywhere this region appears in the clip."),
      h("div", { class: "row", style: { marginBottom: "10px" } },
        h("div", { class: "seg-ctl" },
          h("button", { class: f.fit === "fit" ? "on" : "", onclick: () => { f.fit = "fit"; upd(); drawFraming(); }, title: "Show the whole picture (may leave blurred bars)" }, "Fit (show all)"),
          h("button", { class: f.fit === "fill" ? "on" : "", onclick: () => { f.fit = "fill"; upd(); drawFraming(); }, title: "Fill the area (crops the edges)" }, "Fill (crop)")),
        !isSpk && f.fit === "fill" ? h("span", { class: "chip warn" }, "Slide edges are cut off — check text is readable") : null),
      slider("Zoom", Math.round(f.zoom * 100), 50, 300, 1, (v) => { f.zoom = v / 100; upd(); }, (v) => `${v}%`),
      slider("Horizontal position", Math.round(f.x * 100), 0, 100, 1, (v) => { f.x = v / 100; upd(); }, (v) => (v < 45 ? "← left" : v > 55 ? "right →" : "centre") + ` (${v})`),
      slider("Vertical position", Math.round(f.y * 100), 0, 100, 1, (v) => { f.y = v / 100; upd(); }, (v) => (v < 45 ? "↑ top" : v > 55 ? "bottom ↓" : "centre") + ` (${v})`),
      h("div", { class: "row" },
        isSpk ? h("button", { class: "btn small", onclick: centerFace }, "🙂 Centre on the speaker's face") : null,
        h("button", { class: "btn small ghost", onclick: () => {
          Object.assign(f, defaultFraming()[framingKey] || (framingKey.startsWith("pres") ? { fit: "fit", zoom: 1, x: 0.5, y: 0.5 } : { fit: "fill", zoom: 1, x: 0.5, y: 0.42 }));
          upd(); drawFraming();
        } }, "Reset")),
      isSpk ? h("p", { class: "small muted" }, clip.faceFound ? "Face position was detected automatically for this clip." : "Tip: use the sliders so the face sits in the upper half of the speaker area.") : null);
  }

  async function centerFace() {
    try {
      const r = await api(`/api/projects/${p.id}/face?start=${clip.start}&end=${clip.end}`);
      if (!r.found) { toast("No face found automatically. Please use the sliders.", "info"); return; }
      for (const k of ["spk_split", "spk_full", "cut_spk"]) if (clip.framing[k]) Object.assign(clip.framing[k], { x: r.x, y: r.y });
      clip.faceFound = true;
      changed(); drawFraming();
      toast("Centred on the detected face.", "ok");
    } catch (e) { toast(e.message, "error"); }
  }

  // ------------------------------------------------------------ look & timing
  function drawLook() {
    lookBox.innerHTML = "";
    lookBox.append(h("h3", {}, "Transitions, motion & background"),
      h("div", { class: "grid2" },
        select("Transition between layouts", clip.transition.type, [["smooth", "Smooth glide"], ["fade", "Cross-fade"], ["cut", "Hard cut"]], (v) => { clip.transition.type = v; changed(); drawLook(); }),
        clip.transition.type !== "cut" ? slider("Transition length", clip.transition.dur, 0.2, 1, 0.05, (v) => { clip.transition.dur = v; changed(); }, (v) => `${v.toFixed(2)} s`) : h("div")),
      slider("Motion strength (for zoom/pan parts)", Math.round(clip.motion.strength * 100), 2, 20, 1, (v) => { clip.motion.strength = v / 100; changed(); }, (v) => `${v}% ${v <= 8 ? "(subtle)" : v <= 14 ? "(noticeable)" : "(strong)"}`),
      h("div", { class: "grid2" },
        select("Empty space behind ‘Fit’ content", clip.background.type, [["blur", "Blurred copy (recommended)"], ["color", "Solid colour"]], (v) => { clip.background.type = v; changed(); drawLook(); }),
        clip.background.type === "color" ? h("label", { class: "field" }, h("span", { class: "field-label" }, "Colour"),
          h("input", { type: "color", value: clip.background.color, oninput: (e) => { clip.background.color = e.target.value; changed(); } })) : h("div")),
      has.pres && has.spk ? select("Split screen order", clip.splitOrder || "pres-top", [["pres-top", "Slides on top, speaker below"], ["spk-top", "Speaker on top, slides below"]], (v) => { clip.splitOrder = v; changed(); }) : null);
  }

  function drawTiming() {
    timingBox.innerHTML = "";
    const st = h("input", { class: "inline time", value: fmtTime(clip.start) });
    const en = h("input", { class: "inline time", value: fmtTime(clip.end) });
    const apply = async (a, b) => {
      if (isNaN(a) || isNaN(b) || b - a < 1) { toast("Invalid times.", "error"); drawTiming(); return; }
      try {
        const upd = await api(`/api/projects/${p.id}/candidates/${clip.id}`, { method: "PATCH", json: { start: a, end: b } });
        const cand = ctx.state.project.candidates.find((c) => c.id === clip.id);
        if (cand) Object.assign(cand, upd);
        if (hasCuts(clip)) setKeep(clip, null);
        clip.start = upd.start; clip.end = upd.end;
        clip.needsCaptionRebuild = true;
        ctx.saveClip(clip);
        ctx.saveClip.flush(clip);
        await ctx.rerender();
      } catch (e) { toast(e.message, "error"); }
    };
    st.addEventListener("change", () => apply(parseTime(st.value), clip.end));
    en.addEventListener("change", () => apply(clip.start, parseTime(en.value)));
    timingBox.append(h("h3", {}, "Clip start & end (webinar time)"),
      h("div", { class: "trim-row" },
        h("button", { class: "btn small", onclick: () => apply(clip.start - 0.5, clip.end) }, "−0.5 s"), st,
        h("button", { class: "btn small", onclick: () => apply(clip.start + 0.5, clip.end) }, "+0.5 s"),
        h("span", { class: "muted" }, "to"),
        h("button", { class: "btn small", onclick: () => apply(clip.start, clip.end - 0.5) }, "−0.5 s"), en,
        h("button", { class: "btn small", onclick: () => apply(clip.start, clip.end + 0.5) }, "+0.5 s"),
        h("span", { class: "chip" }, `${(clip.end - clip.start).toFixed(1)} s`),
        hasCuts(clip) ? h("span", { class: "chip ok" }, `${clipDur(clip).toFixed(1)} s after removing silences`) : null),
      h("p", { class: "small muted" }, "Changing the timing rebuilds automatic subtitles. Layout changes keep their position relative to the clip start."));
  }

  function drawAll() { ctx.state.layoutSel = sel; drawTimeline(); drawSegment(); drawFraming(); drawLook(); drawTiming(); player.draw(); }
  drawAll();
  return ed.cleanup;
}
