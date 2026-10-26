// Step 6: subtitle templates, styling, text/timing editing, hook title.
import { h, toast, fmtTime, parseTime, slider, select } from "../ui.js";
import { TEMPLATES, FONTS, renderAt, retimeWords, rescaleCaption, newId } from "../captions.js";
import { buildCaptions, toSRT, ensureFonts, dimsOf } from "../clipstate.js";
import { captionProject } from "../player.js";
import { editorShell } from "./editorshell.js";

const SAMPLE = [
  { text: "This", start: 0, end: 0.3 }, { text: "one", start: 0.3, end: 0.6 }, { text: "change", start: 0.6, end: 1.0 },
  { text: "doubled", start: 1.0, end: 1.4 }, { text: "the", start: 1.4, end: 1.6 }, { text: "results", start: 1.6, end: 2.2 },
];

export async function render(main, ctx) {
  const ed = await editorShell(main, ctx, { step: "subtitles", title: "6. Subtitles",
    intro: "Subtitles are generated from the transcript. Pick a template, adjust the style, and correct any words or timings." });
  if (!ed) return;
  const { clip, player, right, changed } = ed;
  const tr = await ctx.transcript();
  const dims = dimsOf(ctx.state.project, clip);
  let tab = ctx.state.subTab || "style";
  const tabs = h("div", { class: "tabs" });
  const body = h("div");
  const tplBox = h("div", { class: "card" });
  right.append(
    h("div", { class: "card" }, h("div", { class: "row between" },
      h("label", { class: "check", style: { margin: 0 } }, h("input", { type: "checkbox", checked: clip.captionsOn !== false,
        onchange: (e) => { clip.captionsOn = e.target.checked; changed(); } }), "Show subtitles"),
      h("label", { class: "check", style: { margin: 0 }, title: "Places subtitles between slides and speaker, below full-screen slides, and below the face" },
        h("input", { type: "checkbox", checked: clip.smartPos !== false, onchange: (e) => { clip.smartPos = e.target.checked; changed(); drawBody(); } }),
        "Smart position (avoid slide text and face)"),
      h("label", { class: "check", style: { margin: 0 }, title: "Adds a soft dark band behind subtitles that have no background box, so they stay readable on light slides" },
        h("input", { type: "checkbox", checked: clip.backdrop !== false, onchange: (e) => { clip.backdrop = e.target.checked; changed(); drawTemplates(); } }),
        "Readability backdrop"))),
    tplBox,
    h("div", { class: "card" }, tabs, body),
    h("div", { class: "row end" }, h("button", { class: "btn primary big", onclick: () => ctx.go("export", clip.id) }, "Next: Preview & export →")));

  // ------------------------------------------------------------ templates with visual previews
  async function drawTemplates() {
    tplBox.innerHTML = "";
    tplBox.append(h("h3", {}, "Templates"), h("p", { class: "small muted" },
      "Templates marked “inspired by” follow the caption look of your two reference videos (font, size, colours, motion) — they are not exact copies."));
    const grid = h("div", { class: "tpl-grid" });
    tplBox.append(grid);
    await Promise.all(TEMPLATES.map((t) => document.fonts.load(`${t.weight} 40px "${t.font}"`).catch(() => {})));
    // background = the current composite frame (without captions)
    const bg = document.createElement("canvas");
    bg.width = 180; bg.height = 320;
    bg.getContext("2d").drawImage(player.canvas, 0, 0, 180, 320);
    for (const t of TEMPLATES) {
      const cv = h("canvas", { width: 180, height: 320 });
      const c2 = cv.getContext("2d");
      c2.drawImage(bg, 0, 0);
      const style = { ...t, backdrop: clip.backdrop !== false, posY: clip.smartPos !== false ? captionProject(clip, player.t, dims).style.posY : clip.style.posY };
      renderAt(c2, 180, 320, 1.05, { captions: [{ start: 0, end: 3, words: SAMPLE, text: "" }], style, hook: null, emphasis: null });
      grid.append(h("div", { class: "tpl" + (clip.templateId === t.id ? " on" : ""), onclick: () => applyTemplate(t) }, cv,
        h("div", {}, h("b", {}, t.name), h("small", {}, t.note))));
    }
  }

  function applyTemplate(t) {
    const keepPos = { posX: clip.style.posX };
    const oldMax = clip.style.maxWords;
    clip.style = { ...t, ...keepPos };
    clip.templateId = t.id;
    if (t.maxWords !== oldMax && !clip.captionsEdited) regroup();
    ensureFonts(clip).then(() => player.draw());
    changed();
    drawTemplates(); drawBody();
  }

  function regroup() {
    clip.captions = buildCaptions(tr?.words || [], clip.start, clip.end, clip.style.maxWords);
    clip.captionsKey = ctx.state.project.transcript?.created || null;
  }

  // ------------------------------------------------------------ tabs
  function drawTabs() {
    tabs.innerHTML = "";
    for (const [k, l] of [["style", "Style"], ["text", "Text & timing"], ["hook", "Title / hook"]]) {
      tabs.append(h("button", { class: tab === k ? "on" : "", onclick: () => { tab = k; ctx.state.subTab = k; drawTabs(); drawBody(); } }, l));
    }
  }

  function drawBody() {
    body.innerHTML = "";
    player.capHighlight = null;
    if (tab === "style") body.append(styleForm());
    if (tab === "text") body.append(textEditor());
    if (tab === "hook") body.append(hookForm());
  }

  function styleForm() {
    const s = clip.style;
    const set = (k, v, redrawTpl = false) => { s[k] = v; clip.templateId = clip.templateId; changed(); if (k === "font" || k === "weight") ensureFonts(clip).then(() => player.draw()); if (redrawTpl) drawBody(); };
    const weights = FONTS[s.font] || [400];
    const color = (label, k) => h("label", { class: "color-row" }, h("input", { type: "color", value: s[k], oninput: (e) => set(k, e.target.value) }), label);
    return h("div", {},
      h("div", { class: "style-grid" },
        select("Font", s.font, Object.keys(FONTS).map((f) => [f, f]), (v) => { s.font = v; if (!FONTS[v].includes(s.weight)) s.weight = FONTS[v][FONTS[v].length - 1]; set("font", v, true); }),
        select("Boldness", String(s.weight), weights.map((w) => [String(w), { 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" }[w] || w]), (v) => set("weight", Number(v))),
        slider("Font size", s.sizePct, 2.5, 14, 0.1, (v) => set("sizePct", v), (v) => `${v.toFixed(1)}`),
        slider("Max line width", Math.round(s.maxWidthPct * 100), 40, 96, 1, (v) => set("maxWidthPct", v / 100), (v) => `${v}%`),
        select("Word highlighting", s.karaoke, [["none", "None (static)"], ["reveal", "Karaoke: upcoming words dimmed"], ["highlight", "Karaoke: spoken word highlighted"], ["build", "Words appear one by one"]], (v) => set("karaoke", v, true)),
        select("Animation", s.anim, [["none", "None"], ["pop", "Pop in"], ["fade", "Fade in"], ["rise", "Rise in"]], (v) => set("anim", v)),
        select("Words per subtitle", String(s.maxWords), [1, 2, 3, 4, 5, 6, 7, 8, 10].map((n) => [String(n), String(n)]), (v) => {
          s.maxWords = Number(v);
          if (clip.captionsEdited) { toast("You edited subtitles by hand — use “Rebuild from transcript” in Text & timing to regroup.", "info", 6000); }
          else regroup();
          changed();
        }),
        select("Lines per subtitle", String(s.maxLines), [["1", "1"], ["2", "2"], ["3", "3"]], (v) => set("maxLines", Number(v))),
      ),
      h("div", { class: "row", style: { gap: "18px" } }, color("Text", "textColor"), color("Highlight", "accentColor"),
        s.karaoke === "reveal" ? color("Upcoming words", "upcomingColor") : null,
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.uppercase, onchange: (e) => set("uppercase", e.target.checked) }), "UPPERCASE")),
      h("div", { class: "style-grid" },
        slider("Outline", Math.round(s.outlineWidth * 100), 0, 25, 1, (v) => set("outlineWidth", v / 100), (v) => v ? `${v}` : "off"),
        h("label", { class: "color-row", style: { marginTop: "18px" } }, h("input", { type: "color", value: s.outlineColor, oninput: (e) => set("outlineColor", e.target.value) }), "Outline colour"),
        slider("Shadow", Math.round(s.shadow * 100), 0, 60, 1, (v) => set("shadow", v / 100), (v) => v ? `${v}` : "off"),
        h("label", { class: "color-row", style: { marginTop: "18px" } }, h("input", { type: "color", value: s.shadowColor, oninput: (e) => set("shadowColor", e.target.value) }), "Shadow colour"),
        select("Background box", s.box, [["none", "None"], ["line", "Behind each line"], ["block", "One box"]], (v) => set("box", v, true)),
        s.box !== "none" ? h("div", { class: "row" },
          h("label", { class: "color-row" }, h("input", { type: "color", value: s.boxColor, oninput: (e) => set("boxColor", e.target.value) }), "Box"),
          slider("Box opacity", Math.round(s.boxOpacity * 100), 10, 100, 1, (v) => set("boxOpacity", v / 100), (v) => `${v}%`)) : h("div")),
      h("h4", { style: { marginTop: "8px" } }, "Position"),
      h("div", { class: "style-grid" },
        clip.smartPos !== false ? h("p", { class: "small muted" }, "Smart position is on: subtitles sit between slides and speaker, below full-screen slides, or below the face. Turn it off above to place them yourself.")
          : slider("Vertical position", Math.round(s.posY * 100), 5, 95, 1, (v) => set("posY", v / 100), (v) => `${v}% from top`),
        slider("Horizontal position", Math.round((s.posX ?? 0.5) * 100), 20, 80, 1, (v) => set("posX", v / 100), (v) => v === 50 ? "centre" : `${v}%`),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Text alignment"),
          h("div", { class: "seg-ctl" }, ["left", "center", "right"].map((a) => h("button", { class: (s.align || "center") === a ? "on" : "", onclick: () => set("align", a, true) }, a))))));
  }

  // ------------------------------------------------------------ caption text/timing editor
  function textEditor() {
    const caps = clip.captions;
    const box = h("div", { class: "caplist" });
    const markEdited = () => { clip.captionsEdited = true; changed(); };
    caps.forEach((c, i) => {
      const st = h("input", { value: fmtTime(c.start, 2), title: "Start (from clip start)" });
      const en = h("input", { value: fmtTime(c.end, 2), title: "End" });
      const tx = h("input", { value: c.words.map((w) => w.text).join(" ") });
      st.addEventListener("change", () => {
        const v = parseTime(st.value);
        if (isNaN(v) || v >= c.end) { st.value = fmtTime(c.start, 2); toast("Start must be before the end.", "error"); return; }
        rescaleCaption(c, Math.max(0, v), c.end); markEdited(); redraw();
      });
      en.addEventListener("change", () => {
        const v = parseTime(en.value);
        if (isNaN(v) || v <= c.start) { en.value = fmtTime(c.end, 2); toast("End must be after the start.", "error"); return; }
        rescaleCaption(c, c.start, Math.min(clip.end - clip.start, v)); markEdited(); redraw();
      });
      tx.addEventListener("change", () => { if (!tx.value.trim()) { caps.splice(i, 1); } else retimeWords(c, tx.value); markEdited(); redraw(); });
      tx.addEventListener("focus", () => player.seek(c.start + 0.01));
      const split = () => {
        // split at the cursor position (or in the middle)
        const pos = tx.selectionStart ?? Math.floor(tx.value.length / 2);
        const before = tx.value.slice(0, pos).trim().split(/\s+/).filter(Boolean).length;
        const k = Math.max(1, Math.min(c.words.length - 1, before || Math.ceil(c.words.length / 2)));
        if (c.words.length < 2) { toast("A subtitle with one word cannot be split.", "error"); return; }
        const a = c.words.slice(0, k), b = c.words.slice(k);
        const c2 = { id: newId(), start: b[0].start, end: c.end, words: b, text: b.map((w) => w.text).join(" "), emphasis: false };
        c.words = a; c.end = b[0].start; c.text = a.map((w) => w.text).join(" ");
        caps.splice(i + 1, 0, c2); markEdited(); redraw();
      };
      const merge = () => {
        const n = caps[i + 1];
        if (!n) return;
        c.words = [...c.words, ...n.words]; c.end = n.end; c.text = c.words.map((w) => w.text).join(" ");
        caps.splice(i + 1, 1); markEdited(); redraw();
      };
      box.append(h("div", { class: "caprow", "data-i": i }, st, en, tx,
        h("div", { class: "acts" },
          h("button", { title: "Play from here", onclick: () => { player.seek(c.start); player.play(); } }, "▶"),
          h("button", { title: "Split at cursor (or in the middle)", onclick: split }, "✂"),
          h("button", { title: "Merge with next", onclick: merge }, "⤓"),
          h("button", { title: "Delete", onclick: () => { caps.splice(i, 1); markEdited(); redraw(); } }, "✕"))));
    });
    const highlight = (t) => {
      box.querySelectorAll(".caprow").forEach((r) => {
        const c = caps[Number(r.dataset.i)];
        r.classList.toggle("active", !!c && t >= c.start && t < c.end);
      });
    };
    player.capHighlight = highlight;
    const redraw = () => { player.draw(); drawBody(); };
    return h("div", {},
      h("div", { class: "row", style: { marginBottom: "10px" } },
        h("button", { class: "btn small", onclick: () => {
          if (clip.captionsEdited && !confirm("Replace your edited subtitles with fresh ones from the transcript?")) return;
          regroup(); clip.captionsEdited = false; changed(); redraw();
        } }, "↺ Rebuild from transcript"),
        h("button", { class: "btn small", onclick: () => {
          const add = { id: newId(), start: player.t, end: Math.min(clip.end - clip.start, player.t + 1.5), words: [], text: "" };
          retimeWords(add, "New text");
          caps.push(add); caps.sort((a, b) => a.start - b.start); markEdited(); redraw();
        } }, "+ Add subtitle at playhead"),
        h("button", { class: "btn small", onclick: () => {
          const blob = new Blob([toSRT(caps)], { type: "text/plain" });
          const a = h("a", { href: URL.createObjectURL(blob), download: `${clip.name || "clip"}.srt` });
          a.click();
        } }, "⬇ Download .srt")),
      h("p", { class: "small muted" }, "Times are relative to the clip start (m:ss.xx). Click a text to jump there; edit words directly. If you change the number of words, their timing is spread evenly."),
      box);
  }

  // ------------------------------------------------------------ hook title
  function hookForm() {
    const hk = clip.hook;
    const cand = ctx.state.project.candidates.find((c) => c.id === clip.id);
    const set = (k, v) => { hk[k] = v; changed(); if (k === "font" || k === "weight") ensureFonts(clip).then(() => player.draw()); };
    return h("div", {},
      h("p", { class: "small" }, "An optional on-screen title for the first seconds of the clip."),
      cand?.hook && cand.hook_kind === "ai_suggested" ? h("div", { class: "alert info" }, "AI-suggested hook (not said by the speaker): ", h("b", {}, cand.hook), " ",
        h("button", { class: "btn small", onclick: () => { hk.line1 = cand.hook; hk.enabled = true; changed(); drawBody(); } }, "Use it")) : null,
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: hk.enabled, onchange: (e) => set("enabled", e.target.checked) }), "Show title"),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Line 1"), h("input", { value: hk.line1, oninput: (e) => set("line1", e.target.value) })),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Line 2 (highlight colour)"), h("input", { value: hk.line2, oninput: (e) => set("line2", e.target.value) })),
      h("div", { class: "style-grid" },
        select("Font", hk.font, Object.keys(FONTS).map((f) => [f, f]), (v) => { hk.weight = FONTS[v][FONTS[v].length - 1]; set("font", v); }),
        slider("Size", hk.sizePct, 3, 12, 0.1, (v) => set("sizePct", v), (v) => v.toFixed(1)),
        slider("Vertical position", Math.round(hk.posY * 100), 5, 90, 1, (v) => set("posY", v / 100), (v) => `${v}%`),
        slider("Show until", hk.end, 1, Math.min(15, clip.end - clip.start), 0.5, (v) => set("end", v), (v) => `${v.toFixed(1)} s`)),
      h("div", { class: "row" },
        h("label", { class: "color-row" }, h("input", { type: "color", value: hk.color1, oninput: (e) => set("color1", e.target.value) }), "Line 1"),
        h("label", { class: "color-row" }, h("input", { type: "color", value: hk.color2, oninput: (e) => set("color2", e.target.value) }), "Line 2")),
      h("p", { class: "small muted" }, "Tip: in split screen the title covers the top of the slides; it is only shown briefly."));
  }

  ed.setOnCaptionsChanged(() => drawBody());
  player.onTime((t) => player.capHighlight?.(t));
  drawTabs();
  drawBody();
  await ensureFonts(clip);
  player.draw();
  setTimeout(drawTemplates, 400); // wait for the first video frame for nicer previews
  return ed.cleanup;
}
