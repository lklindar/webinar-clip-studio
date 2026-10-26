// Step 3: choose clips — pick the minutes yourself (default) or let the AI suggest moments.
import { api } from "../api.js";
import { h, toast, fmtTime, select, confirmBox } from "../ui.js";
import * as analyzeView from "./analyze.js";
import { keepPartsCard } from "./keepparts.js";
import { openRawDownload } from "./rawdownload.js";

const MODE_KEY = "wcs.chooseMode";

// Friendly time parsing: "12:30", "1:02:30", "12m30s", "12m", "12" (= minutes), "12.5" (= 12 min 30 s)
export function parseFlexTime(str) {
  const s = String(str || "").trim().toLowerCase().replace(",", ".");
  if (!s) return NaN;
  if (s.includes(":")) {
    const parts = s.split(":").map(Number);
    if (parts.some(isNaN)) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  let m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/);
  if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) * 60; // a plain number means minutes
  return NaN;
}

export async function render(main, ctx) {
  const p = ctx.state.project;
  let mode = localStorage.getItem(MODE_KEY) || "manual";
  main.append(h("div", { class: "page-head" }, h("div", {},
    h("h1", {}, "3. Choose your clips"),
    h("p", {}, "Tell the app which minutes of the webinar you want as short videos. The app then crops, lays out and subtitles them for you."))));
  const modeBar = h("div", { class: "seg-ctl", style: { marginBottom: "16px" } });
  const body = h("div");
  main.append(modeBar, body);
  let cleanup = null;

  const draw = async () => {
    if (cleanup) { cleanup(); cleanup = null; }
    modeBar.innerHTML = "";
    for (const [k, l] of [["manual", "✍️ I'll pick the moments myself"], ["ai", "✨ Let the app suggest moments"]]) {
      modeBar.append(h("button", { class: mode === k ? "on" : "", onclick: () => { mode = k; try { localStorage.setItem(MODE_KEY, k); } catch {} draw(); } }, l));
    }
    body.innerHTML = "";
    const res = mode === "manual" ? await manual(body, ctx) : await analyzeView.render(body, ctx, { embedded: true });
    if (typeof res === "function") cleanup = res;
  };
  await draw();
  return () => cleanup && cleanup();
}

async function manual(root, ctx) {
  const p = ctx.state.project;
  const sys = ctx.state.system || (await ctx.diskInfo());
  const role = p.sources.speaker ? "speaker" : "presentation";
  const src = p.sources[role];
  if (!src) { root.append(h("div", { class: "alert info" }, "Add your recordings in step 1 first.")); return; }
  const offset = role === "presentation" ? p.sync.offset : 0;     // video time = master time + offset
  const total = src.duration - offset;
  let model = sys?.settings?.whisper_model || "small";

  // ---------------------------------------------------------------- video
  const video = h("video", { src: `/api/projects/${p.id}/media/${role}?v=${src.fp}`, controls: true, preload: "auto", playsinline: true,
    style: { width: "100%", aspectRatio: "16/9", background: "#000", borderRadius: "10px", display: "block" } });
  const nowEl = h("b", { style: { fontSize: "22px", fontVariantNumeric: "tabular-nums" } }, "0:00.0");
  const masterNow = () => Math.max(0, video.currentTime - offset);
  let stopAt = null;
  video.addEventListener("timeupdate", () => {
    nowEl.textContent = fmtTime(masterNow());
    if (stopAt != null && masterNow() >= stopAt) { video.pause(); stopAt = null; }
  });
  const jump = (d) => { video.currentTime = Math.max(0, video.currentTime + d); };

  // ---------------------------------------------------------------- rows
  const rows = [];      // {start, end, label, startTxt, endTxt}
  let sel = 0;
  const list = h("div", { class: "stack" });
  const addRow = (start = null, end = null, label = "") => {
    rows.push({ start, end, label, startTxt: start == null ? "" : fmtTime(start), endTxt: end == null ? "" : fmtTime(end) });
    sel = rows.length - 1;
    drawRows();
  };

  function problem(r) {
    if (r.start == null || isNaN(r.start)) return r.startTxt ? "Start time not understood" : "Enter a start time";
    if (r.end == null || isNaN(r.end)) return r.endTxt ? "End time not understood" : "Enter an end time";
    if (r.end <= r.start) return "The end must be after the start";
    if (r.end - r.start < 3) return "At least 3 seconds";
    if (r.end - r.start > 600) return "At most 10 minutes";
    if (r.start >= total) return `Start is after the end of the recording (${fmtTime(total, 0)})`;
    return null;
  }

  function drawRows() {
    list.innerHTML = "";
    rows.forEach((r, i) => {
      const err = problem(r);
      const dur = !err ? r.end - r.start : null;
      const timeInput = (key) => {
        const inp = h("input", { class: "inline time", value: r[key + "Txt"], placeholder: key === "start" ? "e.g. 12:30" : "e.g. 13:15",
          onfocus: () => { sel = i; markSel(); } });
        inp.addEventListener("change", () => { r[key + "Txt"] = inp.value; r[key] = parseFlexTime(inp.value); drawRows(); });
        return inp;
      };
      const interp = (key) => r[key] != null && !isNaN(r[key]) && r[key + "Txt"] && !r[key + "Txt"].includes(":")
        ? h("span", { class: "small muted" }, `= ${fmtTime(r[key], 0)}`) : null;
      const card = h("div", { class: "card flat" + (i === sel ? " sel-row" : ""), style: { padding: "12px" }, "data-i": i,
        onclick: () => { sel = i; markSel(); } },
        h("div", { class: "row" },
          h("b", {}, `Clip ${i + 1}`),
          h("span", { class: "muted small" }, "from"), timeInput("start"), interp("start"),
          h("span", { class: "muted small" }, "to"), timeInput("end"), interp("end"),
          dur ? h("span", { class: "chip " + (dur > 90 ? "warn" : "") }, `${Math.round(dur)} s`) : null,
          h("span", { class: "spacer" }),
          h("button", { class: "btn small", disabled: !!err, title: "Play this part", onclick: (e) => {
            e.stopPropagation(); video.currentTime = r.start + offset; stopAt = r.end; video.play();
          } }, "▶ Play"),
          h("button", { class: "icon-btn", title: "Remove", onclick: (e) => { e.stopPropagation(); rows.splice(i, 1); sel = Math.max(0, Math.min(sel, rows.length - 1)); drawRows(); } }, "✕")),
        h("div", { class: "row", style: { marginTop: "6px" } },
          h("input", { class: "inline", placeholder: "Name (optional), e.g. “Biggest email mistake”", value: r.label, style: { flex: "1" },
            oninput: (e) => { r.label = e.target.value; } })),
        err && (r.startTxt || r.endTxt) ? h("div", { class: "small", style: { color: "var(--bad)", marginTop: "4px" } }, "⚠ " + err) : null,
        dur > 90 ? h("div", { class: "small muted", style: { marginTop: "4px" } }, "Tip: most short videos work best under 60–90 seconds.") : null);
      list.append(card);
    });
    drawFoot();
  }
  const markSel = () => list.querySelectorAll("[data-i]").forEach((el) => el.classList.toggle("sel-row", Number(el.dataset.i) === sel));

  const setFromVideo = (key) => {
    if (!rows.length) addRow();
    const r = rows[sel];
    const t = Math.round(masterNow() * 10) / 10;
    r[key] = t; r[key + "Txt"] = fmtTime(t);
    if (key === "start" && (r.end == null || isNaN(r.end) || r.end <= t)) { r.end = Math.min(total, t + 30); r.endTxt = fmtTime(r.end); }
    drawRows();
  };

  // ---------------------------------------------------------------- paste a list
  const pasteBox = h("textarea", { rows: 4, placeholder: "12:30 - 13:15 Biggest email mistake\n24:05 - 24:50\n41:10 - 42:00 The bakery story",
    style: { width: "100%", border: "1px solid var(--line)", borderRadius: "8px", padding: "8px", fontFamily: "inherit" } });
  const importPaste = () => {
    let n = 0, bad = 0;
    for (const line of pasteBox.value.split(/\n+/)) {
      const m = line.trim().match(/^([\dhms:.,\s]+?)\s*(?:-|–|—|to|bis)\s*([\dhms:.,]+)\s*(.*)$/i);
      if (!m) { if (line.trim()) bad++; continue; }
      const a = parseFlexTime(m[1]), b = parseFlexTime(m[2]);
      if (isNaN(a) || isNaN(b)) { bad++; continue; }
      rows.push({ start: a, end: b, label: m[3].trim(), startTxt: fmtTime(a), endTxt: fmtTime(b) });
      n++;
    }
    // drop the empty starter row if the list replaced it
    for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].startTxt && !rows[i].endTxt && rows.length > 1) rows.splice(i, 1);
    sel = rows.length - 1;
    drawRows();
    toast(n ? `Added ${n} clip${n > 1 ? "s" : ""}.` + (bad ? ` ${bad} line(s) not understood.` : "") : "No times found. Use one line per clip, like 12:30 - 13:15", n ? "ok" : "error");
    if (n) pasteBox.value = "";
  };

  // ---------------------------------------------------------------- existing clips
  const existing = h("div");
  const drawExisting = () => {
    existing.innerHTML = "";
    const mine = ctx.state.project.candidates.filter((c) => c.status === "approved");
    if (!mine.length) return;
    existing.append(h("div", { class: "card", style: { marginBottom: "16px" } },
      h("div", { class: "row between" }, h("h3", {}, `Your clips (${mine.length})`),
        h("button", { class: "btn primary", onclick: () => ctx.go("layout", mine[0].id) }, "Edit layout & subtitles →")),
      h("div", { class: "stack" }, mine.sort((a, b) => a.start - b.start).map((c) => h("div", { class: "row", style: { borderTop: "1px solid var(--line)", paddingTop: "8px" } },
        h("span", { class: "chip accent" }, `${fmtTime(c.start, 0)} – ${fmtTime(c.end, 0)}`),
        h("span", { class: "chip" }, `${Math.round(c.end - c.start)} s`),
        h("span", {}, c.topic && c.topic !== "my pick" ? c.topic : ""),
        h("span", { class: "small muted", style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          c.text ? `“${c.text.slice(0, 110)}${c.text.length > 110 ? "…" : ""}”` : "(subtitles not ready yet)"),
        h("button", { class: "btn small", title: "Download this clip's raw footage (speaker, screen recording, or speaker cutout)", onclick: () => openRawDownload(ctx, c) }, "⬇ Download"),
        h("button", { class: "btn small", onclick: () => ctx.go("layout", c.id) }, "Edit"),
        h("button", { class: "btn small ghost danger", onclick: async () => {
          if (!(await confirmBox("Remove clip?", "This clip is removed from your list. You can add it again any time.", "Remove"))) return;
          await api(`/api/projects/${p.id}/candidates/${c.id}`, { method: "PATCH", json: { status: "rejected" } });
          await ctx.refresh(); drawExisting();
        } }, "Remove"))))));
    const kc = keepPartsCard(ctx, drawExisting);
    if (kc) existing.append(kc);
  };
  drawExisting();

  // ---------------------------------------------------------------- footer / create
  const foot = h("div", { class: "sticky-foot" });
  function drawFoot() {
    const ok = rows.filter((r) => !problem(r));
    const secs = ok.reduce((a, r) => a + (r.end - r.start), 0);
    const speed = { tiny: 0.06, base: 0.1, small: 0.25, medium: 0.7 }[model] || 0.25;
    foot.innerHTML = "";
    foot.append(
      h("div", { class: "small" }, ok.length
        ? `Only these ${Math.round(secs)} seconds will be transcribed for subtitles — about ${Math.max(10, Math.round(secs * speed + 8 * ok.length))} s of waiting, not the whole webinar.`
        : "Add at least one clip with a start and end time."),
      h("div", { class: "row" },
        select("", model, Object.keys(sys?.whisper_models || { small: 1 }).map((k) => [k, `Speech model: ${k}`]), (v) => { model = v; drawFoot(); }),
        h("button", { class: "btn primary big", disabled: !ok.length || rows.some((r) => problem(r) && (r.startTxt || r.endTxt)), onclick: create },
          ok.length > 1 ? `Create ${ok.length} clips →` : "Create clip →")));
  }

  async function create() {
    const ok = rows.filter((r) => !problem(r));
    try {
      const res = await api(`/api/projects/${p.id}/manual-clips`, { json: { ranges: ok.map((r) => ({ start: r.start, end: r.end, label: r.label })), whisper_model: model } });
      ctx.kickTasks();
      if (res.warning) toast(res.warning, "error", 9000);
      else toast(res.job ? "Clips created. Subtitles are being prepared in the background." : "Clips created.", "ok");
      await ctx.refresh();
      ctx.go("layout", res.clips[0].id);
    } catch (e) { toast(e.message, "error", 8000); }
  }

  root.append(existing,
    h("div", { class: "grid2" },
      h("div", { class: "card" },
        h("h3", {}, "Watch & mark"),
        video,
        h("div", { class: "row between", style: { marginTop: "10px" } },
          h("div", {}, h("div", { class: "small muted" }, "Current time"), nowEl),
          h("div", { class: "row" },
            h("button", { class: "btn small", onclick: () => jump(-5) }, "−5 s"),
            h("button", { class: "btn small", onclick: () => jump(5) }, "+5 s"),
            h("button", { class: "btn small", onclick: () => jump(60) }, "+1 min"))),
        h("div", { class: "row", style: { marginTop: "10px" } },
          h("button", { class: "btn", onclick: () => setFromVideo("start") }, "⏵ Set START of selected clip here"),
          h("button", { class: "btn", onclick: () => setFromVideo("end") }, "⏹ Set END here"),
          h("button", { class: "btn ghost", onclick: () => { const t = masterNow(); addRow(Math.round(t * 10) / 10, Math.min(total, Math.round(t * 10) / 10 + 30)); } }, "+ New clip from here")),
        h("p", { class: "small muted", style: { marginTop: "8px" } },
          `Times are on the ${role} recording (${fmtTime(total, 0)} long). The other recording is matched automatically using the sync offset.`)),
      h("div", {},
        h("div", { class: "card" },
          h("div", { class: "row between" }, h("h3", {}, "Clips to create"), h("button", { class: "btn small", onclick: () => addRow() }, "+ Add another clip")),
          h("p", { class: "small muted" }, "Type times like 12:30 or 1:02:30. A plain number means minutes (12 = 12:00, 12.5 = 12:30)."),
          list),
        h("details", { class: "card", style: { marginTop: "14px" } },
          h("summary", { style: { cursor: "pointer", fontWeight: "600" } }, "Paste a list of times"),
          h("p", { class: "small muted" }, "One clip per line: start - end, optionally followed by a name."),
          pasteBox, h("button", { class: "btn small", style: { marginTop: "8px" }, onclick: importPaste }, "Add these clips")))),
    foot);
  addRow();
  return () => video.pause();
}
