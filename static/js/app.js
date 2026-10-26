// App shell: routing, step navigation, background-task panel, settings.
import { api } from "./api.js";
import { h, $, toast, modal, progressBar, fmtBytes, fmtDur, fmtTime, confirmBox } from "./ui.js";
import * as uploadView from "./views/upload.js";
import * as syncView from "./views/sync.js";
import * as chooseView from "./views/choose.js";
import * as reviewView from "./views/review.js";
import * as layoutView from "./views/layout.js";
import * as subtitlesView from "./views/subtitles.js";
import * as exportView from "./views/export.js";
import { clipFromCandidate } from "./clipstate.js";
import { debounce } from "./ui.js";

export const STEPS = [
  { id: "upload", title: "Upload recordings", view: uploadView },
  { id: "sync", title: "Synchronize", view: syncView },
  { id: "analyze", title: "Choose clips", view: chooseView },
  { id: "review", title: "Review AI ideas", view: reviewView },
  { id: "layout", title: "Layout & cropping", view: layoutView },
  { id: "subtitles", title: "Subtitles", view: subtitlesView },
  { id: "export", title: "Preview & export", view: exportView },
];

const state = { system: null, project: null, transcript: null, step: null, clipId: null, cleanup: null, projectListeners: new Set() };
window.__state = state; // handy for debugging

// ----------------------------------------------------------------- context passed to views
export const ctx = {
  state,
  go(step, clipId) { location.hash = `#/p/${state.project.id}/${step}${clipId ? "/" + clipId : ""}`; },
  async refresh() {
    state.project = await api(`/api/projects/${state.project.id}`);
    renderSteps();
    for (const fn of state.projectListeners) fn(state.project);
    return state.project;
  },
  onProject(fn) { state.projectListeners.add(fn); return () => state.projectListeners.delete(fn); },
  async transcript(force = false) {
    if (!state.project.transcript) return null;
    if (!state.transcript || force || state.transcript._key !== state.project.transcript.created) {
      state.transcript = await api(`/api/projects/${state.project.id}/transcript`);
      state.transcript._key = state.project.transcript.created;
    }
    return state.transcript;
  },
  approved() { return state.project.candidates.filter((c) => c.status === "approved"); },
  // Clip edit state for an approved candidate (created on first use)
  async getClip(cid) {
    const p = state.project;
    if (p.clips[cid]) return p.clips[cid];
    const cand = p.candidates.find((c) => c.id === cid);
    if (!cand) return null;
    const tr = await ctx.transcript();
    let face = null;
    if (p.sources.speaker) {
      try { face = await api(`/api/projects/${p.id}/face?start=${cand.start}&end=${cand.end}`); } catch { /* optional */ }
      if (face && !face.found) face = null;
    }
    const clip = clipFromCandidate(cand, p, tr?.words || [], face);
    clip.faceFound = !!face;
    p.clips[cid] = clip;
    await api(`/api/projects/${p.id}/clips/${cid}`, { method: "PUT", json: clip });
    return clip;
  },
  saveClip: null, // set below (records undo history + saves)
  diskInfo: null,
};
ctx.diskInfo = diskInfo;

// Duplicate a clip to try a different approach (asks for a name). Resolves to the new clip id or null.
ctx.duplicateClip = (pid, cid, currentName) => new Promise((resolve) => {
  const inp = h("input", { class: "inline", value: `${currentName || "clip"} (copy)`, style: { width: "100%" } });
  const doIt = async () => {
    try {
      const r = await api(`/api/projects/${pid}/clips/${cid}/duplicate`, { json: { name: inp.value } });
      toast(`Copy created: “${r.name}”. The original is unchanged.`, "ok");
      resolve(r.id);
    } catch (e) { toast(e.message, "error"); resolve(null); return false; }
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { m.close(); doIt(); } });
  const m = modal("Duplicate clip", h("div", {},
    h("p", {}, "Makes a copy with all your edits (layout, effects, cards, assets, subtitles). Change the copy freely — the original stays as it is."),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Name of the copy"), inp)), [
    { label: "Cancel", class: "btn ghost", onClick: () => resolve(null) },
    { label: "⧉ Duplicate", class: "btn primary", onClick: doIt },
  ]);
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
});

// ----------------------------------------------------------------- undo / redo for clip edits
// One history per clip, kept while the app is open. Every edit goes through ctx.saveClip, which
// snapshots the clip; quick successive changes (e.g. dragging a slider) are grouped into one step.
const MAX_STEPS = 150;
const histories = {}; // clip id -> { past: [json], future: [json], last: json }
const snap = (clip) => JSON.stringify(clip, (k, v) => (k === "updated" ? undefined : v));
// Save state shown in the editor ("✓ Saved" / "Saving…" / "Not saved — retrying").
const saveState = { pending: 0, error: null, listeners: new Set() };
const setSave = (patch) => { Object.assign(saveState, patch); saveState.listeners.forEach((fn) => fn(saveState)); };
ctx.saveStatus = { get: () => saveState, on: (fn) => { saveState.listeners.add(fn); return () => saveState.listeners.delete(fn); } };
let retryTimer = null;
async function putClip(pid, clip) {
  setSave({ pending: saveState.pending + 1 });
  try {
    await api(`/api/projects/${pid}/clips/${clip.id}`, { method: "PUT", json: clip });
    setSave({ pending: saveState.pending - 1, error: null, savedAt: Date.now(), queued: dirty !== null });
  } catch (e) {
    setSave({ pending: saveState.pending - 1, error: e.message });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => putClip(pid, clip), 3000);   // keep trying until the server is back
  }
}
let dirty = null; // clip waiting for the debounced save
const persistNow = (clip) => { dirty = null; return putClip(state.project.id, clip); };   // "queued" clears when the PUT finishes
const persistDebounced = debounce((clip) => persistNow(clip), 500);
const persist = (clip) => { dirty = clip; setSave({ queued: true }); persistDebounced(clip); };
persist.flush = (clip) => { if (dirty) persistDebounced.flush(clip); };
// Don't let the page close while a change is still on its way to disk.
window.addEventListener("beforeunload", (e) => {
  if (dirty) { persistDebounced.flush(dirty); }
  if (dirty || saveState.pending > 0 || saveState.error) { e.preventDefault(); e.returnValue = ""; }
});
const historyListeners = new Set();
const notifyHistory = () => historyListeners.forEach((fn) => fn());

function hist(clip) {
  if (!histories[clip.id]) histories[clip.id] = { past: [], future: [], last: snap(clip) };
  return histories[clip.id];
}
let recTimer = null, recClip = null;
function recordNow(clip) {
  const h = hist(clip);
  const now = snap(clip);
  if (now === h.last) return;
  h.past.push(h.last);
  if (h.past.length > MAX_STEPS) h.past.shift();
  h.future = [];
  h.last = now;
  notifyHistory();
}
function scheduleRecord(clip) {
  recClip = clip;
  clearTimeout(recTimer);
  recTimer = setTimeout(() => { recTimer = null; recordNow(clip); }, 400);
}
function flushRecord() {
  if (recTimer) { clearTimeout(recTimer); recTimer = null; recordNow(recClip); }
}

// opts.merge: an automatic follow-up change (e.g. subtitles rebuilt after the clip length changed)
// that belongs to the previous step instead of being a separate undo step.
ctx.saveClip = (clip, opts = {}) => {
  const h = hist(clip);
  if (opts.merge) {
    if (recTimer && recClip === clip) scheduleRecord(clip);   // part of the user's pending step
    else h.last = snap(clip);                                 // amend the current state silently
  } else scheduleRecord(clip);
  persist(clip);
};
ctx.saveClip.flush = (clip) => { flushRecord(); persist.flush(clip); };
ctx.history = {
  init: (clip) => hist(clip),
  can: (clip) => ({ undo: hist(clip).past.length > 0, redo: hist(clip).future.length > 0 }),
  onChange: (fn) => { historyListeners.add(fn); return () => historyListeners.delete(fn); },
  undo: (clip) => step(clip, -1),
  redo: (clip) => step(clip, +1),
};

async function step(clip, dir) {
  flushRecord();                 // capture the very latest change first
  const h = hist(clip);
  const from = dir < 0 ? h.past : h.future;
  if (!from.length) return false;
  (dir < 0 ? h.future : h.past).push(h.last);
  h.last = from.pop();
  const restored = JSON.parse(h.last);
  const timingChanged = restored.start !== clip.start || restored.end !== clip.end;
  // replace the clip's contents in place (views keep a reference to this object)
  for (const k of Object.keys(clip)) delete clip[k];
  Object.assign(clip, restored);
  state.project.clips[clip.id] = clip;
  await api(`/api/projects/${state.project.id}/clips/${clip.id}`, { method: "PUT", json: clip });
  if (timingChanged) {
    const upd = await api(`/api/projects/${state.project.id}/candidates/${clip.id}`, { method: "PATCH", json: { start: clip.start, end: clip.end } });
    const cand = state.project.candidates.find((c) => c.id === clip.id);
    if (cand) Object.assign(cand, upd);
  }
  notifyHistory();
  await ctx.rerender();
  toast(dir < 0 ? "Undone" : "Redone", "info", 1400);
  return true;
}

// Redraw the current page without losing the playhead or scroll position.
ctx.rerender = async () => {
  state.resumeT = window.__player ? window.__player.t : null;
  state.keepScroll = window.scrollY;
  await route();
};

// ----------------------------------------------------------------- routing
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  if (state.cleanup) { try { state.cleanup(); } catch (e) { console.error(e); } state.cleanup = null; }
  state.projectListeners.clear();
  const main = $("#main");
  main.innerHTML = "";
  if (parts[0] !== "p" || !parts[1]) {
    state.project = null;
    $("#projectTitle").textContent = "";
    $("#steps").innerHTML = "";
    return renderHome(main);
  }
  try {
    if (!state.project || state.project.id !== parts[1]) {
      state.transcript = null;
      state.project = await api(`/api/projects/${parts[1]}`);
    } else {
      state.project = await api(`/api/projects/${parts[1]}`);
    }
  } catch (e) {
    main.append(h("div", { class: "alert error" }, e.message), h("a", { href: "#/" }, "← Back to projects"));
    return;
  }
  state.step = STEPS.find((s) => s.id === parts[2]) ? parts[2] : "upload";
  state.clipId = parts[3] || null;
  renderProjectTitle();
  renderSteps();
  const step = STEPS.find((s) => s.id === state.step);
  rememberPlace();
  renderMissing(main);
  try {
    const res = await step.view.render(main, ctx);
    if (typeof res === "function") state.cleanup = res;
  } catch (e) {
    console.error(e);
    main.append(h("div", { class: "alert error" }, "This page failed to load: " + e.message));
  }
  if (state.keepScroll != null) { window.scrollTo(0, state.keepScroll); state.keepScroll = null; }
  else window.scrollTo(0, 0);
}

const rememberPlace = debounce(() => {
  if (!state.project) return;
  api(`/api/projects/${state.project.id}/last`, { json: { step: state.step, clip: state.clipId } }).catch(() => {});
}, 800);

// Recordings used "in place" that were moved/renamed: offer to find them again (edits are kept).
function renderMissing(main) {
  const p = state.project;
  const missing = Object.entries(p.sources).filter(([, s]) => s.missing);
  if (!missing.length) return;
  for (const [role, s] of missing) {
    main.append(h("div", { class: "alert error" },
      h("b", {}, `The ${role} recording can't be found. `),
      `It was used from ${s.path}, but it is no longer there (moved, renamed, or on a disconnected drive). `,
      "Your edits are safe — point the app to the file again: ",
      h("button", { class: "btn small primary", onclick: async () => {
        try {
          const r = await api("/api/pick-file", { json: { prompt: `Find the ${role} recording (${s.name})` } });
          if (!r.path) return;
          const res = await api(`/api/projects/${p.id}/sources/${role}/link`, { json: { path: r.path } });
          if (res.source.fp !== s.fp) toast("That looks like a different file than before — please check sync and your clips.", "error", 9000);
          else toast("Found it. Everything is connected again.", "ok");
          ctx.kickTasks();
          route();
        } catch (e) { toast(e.message, "error", 8000); }
      } }, "Find the file again"),
      h("span", { class: "small" }, " (or plug in the drive and reload this page)")));
  }
}

function stepStatus(id) {
  const p = state.project;
  const both = p.sources.speaker || p.sources.presentation;
  switch (id) {
    case "upload": return { done: !!(p.sources.speaker && p.sources.presentation), enabled: true };
    case "sync": return { done: !!(p.sync.auto || p.sync.offset), enabled: !!both };
    case "analyze": return { done: p.candidates.some((c) => c.status === "approved"), enabled: !!both };
    case "review": return { done: false, enabled: p.candidates.some((c) => c.source !== "manual"), optional: true };
    case "layout": case "subtitles": return { done: Object.keys(p.clips).length > 0, enabled: p.candidates.some((c) => c.status === "approved") };
    case "export": return { done: (p.exports || []).length > 0, enabled: p.candidates.some((c) => c.status === "approved") };
  }
  return { done: false, enabled: true };
}

function renderProjectTitle() {
  const el = $("#projectTitle");
  el.innerHTML = "";
  const inp = h("input", { class: "inline", value: state.project.name, style: { border: "0", fontWeight: "600", width: "100%", background: "transparent" },
    title: "Rename project" });
  inp.addEventListener("change", async () => {
    await api(`/api/projects/${state.project.id}`, { method: "PATCH", json: { name: inp.value } });
    toast("Project renamed");
  });
  el.append(inp);
}

let tasksBox;
function renderSteps() {
  const nav = $("#steps");
  nav.innerHTML = "";
  STEPS.forEach((s, i) => {
    const st = stepStatus(s.id);
    const cls = ["step-link", state.step === s.id ? "active" : "", st.done ? "done" : "", st.enabled ? "" : "disabled"].join(" ");
    const clip = ["layout", "subtitles", "export"].includes(s.id) && state.clipId ? "/" + state.clipId : "";
    nav.append(h("a", { class: cls, href: `#/p/${state.project.id}/${s.id}${clip}` },
      h("span", { class: "step-num" }, st.done && state.step !== s.id ? "✓" : i + 1), s.title,
      st.optional ? h("span", { class: "small muted", style: { marginLeft: "auto", fontWeight: "500" } }, "optional") : null));
  });
  tasksBox = h("div", { class: "tasks" });
  nav.append(tasksBox, h("div", { style: { marginTop: "18px" } }, h("a", { href: "#/", class: "small" }, "← All projects")));
  renderTasks();
}

function renderTasks() {
  if (!tasksBox || !state.project) return;
  const active = (state.project.jobs || []).filter((j) => j.status === "running" || j.status === "queued");
  const recentErr = (state.project.jobs || []).filter((j) => j.status === "error" && Date.now() / 1000 - j.finished < 600);
  tasksBox.innerHTML = "";
  if (!active.length && !recentErr.length) return;
  tasksBox.append(h("h4", {}, "Background tasks"));
  for (const j of active) {
    tasksBox.append(h("div", { class: "task" }, h("b", {}, j.label),
      progressBar(j.progress, j.status === "queued" ? "Waiting…" : j.message)));
  }
  for (const j of recentErr) tasksBox.append(h("div", { class: "task", style: { color: "var(--bad)" } }, `⚠ ${j.label} failed`));
}

// Poll project jobs so the task panel stays live (and views can react to finished work).
let lastActive = 0;
setInterval(async () => {
  if (!state.project || document.hidden) return;
  const active = (state.project.jobs || []).filter((j) => j.status === "running" || j.status === "queued").length;
  if (!active && !lastActive) return;
  try {
    const p = await api(`/api/projects/${state.project.id}`);
    if (!state.project || p.id !== state.project.id) return;
    const before = active;
    // keep the browser's clip edits (they are the source of truth while editing)
    p.clips = { ...p.clips, ...state.project.clips };
    state.project = p;
    renderTasks();
    const now = (p.jobs || []).filter((j) => j.status === "running" || j.status === "queued").length;
    if (now < before) { renderSteps(); for (const fn of state.projectListeners) fn(p); }
    lastActive = now;
  } catch { /* server restarting */ }
}, 1500);
ctx.kickTasks = () => { lastActive = 1; };

// ----------------------------------------------------------------- home
async function renderHome(main) {
  const list = await api("/api/projects").catch(() => []);
  const nameInp = h("input", { placeholder: "e.g. March webinar — Email marketing", class: "inline", style: { width: "340px" } });
  const create = async () => {
    const p = await api("/api/projects", { json: { name: nameInp.value } });
    location.hash = `#/p/${p.id}/upload`;
  };
  nameInp.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  const recent = list.flatMap((p) => (p.clip_list || []).map((c) => ({ ...c, project: p })))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 8);
  const lastOf = (p) => p.last?.step ? `#/p/${p.id}/${p.last.step}${p.last.clip ? "/" + p.last.clip : ""}` : `#/p/${p.id}/upload`;
  const continueBox = recent.length ? h("div", { class: "card section" },
    h("div", { class: "row between" }, h("h3", {}, "✏️ Continue editing"),
      list[0]?.last ? h("a", { class: "btn primary small", href: lastOf(list[0]) }, `Resume where you left off (${list[0].name}) →`) : null),
    h("p", { class: "small muted" }, "Everything you edit is saved automatically on this Mac — open a clip to keep working on it."),
    h("div", { class: "stack" }, recent.map((c) => h("div", { class: "row", style: { borderTop: "1px solid var(--line)", paddingTop: "8px" } },
      h("img", { src: `/api/projects/${c.project.id}/frame/speaker?t=${(c.start || 0) + 1}&w=160`, alt: "",
        style: { width: "80px", aspectRatio: "16/9", objectFit: "cover", borderRadius: "6px", background: "#111" }, onerror: (e) => { e.target.style.visibility = "hidden"; } }),
      h("div", { style: { flex: "1", minWidth: "200px" } },
        h("b", {}, c.name), h("div", { class: "small muted" },
          `${c.project.name} · ${fmtTime(c.start || 0, 0)}–${fmtTime(c.end || 0, 0)} · ${c.parts} parts · edited ${c.updated ? new Date(c.updated * 1000).toLocaleString() : "—"}`)),
      c.exports ? h("a", { class: "btn small", href: `#/p/${c.project.id}/export/${c.id}` }, `🎬 ${c.exports} export${c.exports > 1 ? "s" : ""}`) : null,
      h("button", { class: "btn small", title: "Make a copy of this clip to try a different approach", onclick: async () => {
        const id = await ctx.duplicateClip(c.project.id, c.id, c.name);
        if (id) route();
      } }, "⧉ Copy"),
      h("a", { class: "btn small primary", href: `#/p/${c.project.id}/layout/${c.id}` }, "Open & edit"))))) : null;
  main.append(
    h("div", { class: "hero" },
      h("h1", {}, "Turn long webinars into vertical short clips"),
      h("p", {}, "Add your speaker and presentation recordings. Pick the minutes you want (or let the app suggest moments), and it helps you compose 9:16 videos with burned-in subtitles for TikTok, Reels and Shorts."),
      h("div", { class: "flow" }, ["Upload", "Sync", "Choose clips", "Review AI ideas (optional)", "Layout", "Subtitles", "Export MP4"].map((s, i) => h("span", {}, `${i + 1}. ${s}`)))),
    continueBox,
    h("div", { class: "card section" },
      h("h3", {}, "Start a new project"),
      h("div", { class: "row" }, nameInp, h("button", { class: "btn primary", onclick: create }, "Create project"))),
    h("h2", {}, "Your projects"),
    list.length ? h("div", { class: "proj-list" }, list.map((p) => h("div", { class: "card proj", onclick: () => (location.hash = lastOf(p)) },
      h("h3", {}, p.name),
      h("div", { class: "muted small" }, new Date(p.created * 1000).toLocaleString()),
      h("div", { class: "row", style: { marginTop: "8px" } },
        h("span", { class: "chip" }, `${Object.keys(p.sources).length}/2 recordings`),
        h("span", { class: "chip" }, `${p.candidates} ideas`), h("span", { class: "chip" }, `${p.clips} clips`)),
      h("div", { class: "row end", style: { marginTop: "8px" } },
        h("button", { class: "btn small ghost danger", onclick: async (e) => {
          e.stopPropagation();
          if (!(await confirmBox("Delete project?", `“${p.name}” and its exports/copies will be deleted from this app. Original files you used “in place” are not touched.`, "Delete"))) return;
          await api(`/api/projects/${p.id}`, { method: "DELETE" });
          route();
        } }, "Delete")))))
      : h("p", { class: "muted" }, "No projects yet."),
  );
}

// ----------------------------------------------------------------- settings + help
async function diskInfo() {
  try {
    state.system = await api("/api/system");
    $("#diskInfo").textContent = `Disk free: ${fmtBytes(state.system.disk_free)}`;
  } catch { /* ignore */ }
  return state.system;
}

export async function openSettings(onSaved) {
  const sys = await diskInfo();
  const s = sys.settings, ai = sys.ai;
  const form = { provider: s.provider, anthropic_model: s.anthropic_model, local_base_url: s.local_base_url, local_model: s.local_model,
    whisper_model: s.whisper_model, language: s.language };
  let keyInput;
  const localStatus = h("span", { class: "small" });
  const body = h("div", {},
    h("h3", {}, "AI provider for clip discovery"),
    h("div", { class: "stack" },
      ...[
        ["heuristic", "Offline rules (free, private, default)", "Runs on your Mac with transparent keyword/structure rules. It is NOT semantic AI: it cannot understand meaning, so treat its suggestions as a starting point."],
        ["anthropic", "Claude by Anthropic (paid, best quality)", `Understands meaning and context. Sends ONLY the transcript text to Anthropic's API — never your video or audio. Typical cost for a 60‑minute webinar: about $${(0.25).toFixed(2)} with Opus 5.5, under $0.01 with Haiku 5.5. Requires an API key from console.anthropic.com (billing is to your Anthropic account). Anthropic's API data policy applies.`],
        ["local", "Local AI model (free, private, advanced)", "Uses a model running on your Mac through Ollama or LM Studio. You must install it separately. Note: with 8 GB of memory only small models fit; their suggestions are weaker and slower than Claude's."],
      ].map(([v, title, desc]) => h("label", { class: "card flat check", style: { alignItems: "flex-start", padding: "12px" } },
        h("input", { type: "radio", name: "prov", value: v, checked: form.provider === v, onchange: () => { form.provider = v; } }),
        h("div", {}, h("b", {}, title), h("div", { class: "small muted" }, desc))))),
    h("div", { class: "grid2", style: { marginTop: "14px" } },
      h("div", {},
        h("h4", {}, "Claude"),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "API key ", ai.anthropic.configured ? h("span", { class: "chip ok" }, "saved") : h("span", { class: "chip" }, "not set")),
          keyInput = h("input", { type: "password", placeholder: ai.anthropic.configured ? "•••••••• (leave empty to keep)" : "sk-ant-…", autocomplete: "off" })),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Model"),
          h("select", { onchange: (e) => { form.anthropic_model = e.target.value; } },
            ai.anthropic.models.map((m) => h("option", { value: m, selected: m === form.anthropic_model },
              `${m}  ($${ai.anthropic.prices[m][0]} / $${ai.anthropic.prices[m][1]} per M tokens)`)))),
        h("p", { class: "small muted" }, "The key is stored only in the .env file of this app folder on your Mac (not in the browser, not in source control)."),
        ai.anthropic.configured ? h("button", { class: "btn small danger", onclick: async () => {
          await api("/api/settings", { json: { anthropic_api_key: "" } }); toast("API key removed"); m.close(); openSettings(onSaved);
        } }, "Remove saved key") : null),
      h("div", {},
        h("h4", {}, "Local model (Ollama / LM Studio)"),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Server address"),
          h("input", { value: form.local_base_url, onchange: (e) => { form.local_base_url = e.target.value; } })),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Model name"),
          h("input", { value: form.local_model, onchange: (e) => { form.local_model = e.target.value; } })),
        h("div", { class: "row" }, h("button", { class: "btn small", onclick: async () => {
          await api("/api/settings", { json: { local_base_url: form.local_base_url } });
          const r = await api("/api/settings/check-local");
          localStatus.textContent = r.ok ? `✓ Connected. Models: ${r.models.join(", ") || "none"}` : `✗ Not reachable (${r.error})`;
        } }, "Test connection"), localStatus))),
    h("h3", { style: { marginTop: "16px" } }, "Speech recognition (runs on your Mac)"),
    h("div", { class: "grid2" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Speech model"),
        h("select", { onchange: (e) => { form.whisper_model = e.target.value; } },
          Object.entries(sys.whisper_models).map(([k, d]) => h("option", { value: k, selected: k === form.whisper_model }, `${k} — ${d}`)))),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Language"),
        h("select", { onchange: (e) => { form.language = e.target.value; } },
          [["", "Detect automatically"], ["en", "English"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"],
           ["nl", "Dutch"], ["pt", "Portuguese"], ["pl", "Polish"], ["ko", "Korean"], ["ja", "Japanese"], ["zh", "Chinese"]]
            .map(([v, l]) => h("option", { value: v, selected: v === form.language }, l))))));
  const m = modal("Settings", body, [
    { label: "Cancel", class: "btn ghost" },
    { label: "Save", class: "btn primary", onClick: async () => {
      const payload = { ...form };
      if (keyInput.value.trim()) payload.anthropic_api_key = keyInput.value.trim();
      if (payload.provider === "anthropic" && !ai.anthropic.configured && !payload.anthropic_api_key) {
        toast("Paste your Anthropic API key to use Claude.", "error"); return false;
      }
      try { await api("/api/settings", { json: payload }); }
      catch (e) { toast(e.message, "error"); return false; }
      toast("Settings saved", "ok");
      await diskInfo();
      onSaved && onSaved();
    } },
  ]);
}

function openHelp() {
  modal("How it works & limits", h("div", { class: "stack" },
    h("p", {}, h("b", {}, "Privacy. "), "Videos, audio and transcription stay on your Mac. Only if you choose Claude in Settings is the transcript text (not audio/video) sent to Anthropic."),
    h("p", {}, h("b", {}, "Large files. "), "Use “Use file in place (no copy)” for multi‑GB recordings — the app reads the original and never loads it fully into memory. Uploading a copy duplicates the file on disk."),
    h("p", {}, h("b", {}, "Storage per 60‑minute webinar. "), "Preview copies ≈ 0.5 GB per recording, audio cache ≈ 0.25 GB, each exported 45‑second clip ≈ 15–30 MB. Copies (if you upload) need the full original size."),
    h("p", {}, h("b", {}, "Time on an Apple M‑series Mac (estimates). "), "Preview copies: ~3–8 min per hour of video. Transcription (‘small’ model): ~10–15 min per hour of audio. Clip discovery: seconds (offline rules) to ~1–3 min (Claude). Export: roughly 1–3× the clip length."),
    h("p", {}, h("b", {}, "Memory. "), "Heavy tasks run one at a time to stay within 8 GB of RAM. Close other heavy apps during transcription/export."),
    h("p", {}, h("b", {}, "Scores. "), "Potential scores are heuristic judgements of hook, clarity, standalone value, usefulness and engagement. They are not predictions of views and nothing guarantees a clip will go viral."),
    h("p", {}, h("b", {}, "Where files go. "), "Everything lives in the app's data folder: ", h("span", { class: "mono" }, state.system?.data_dir || "data/"), ". Exports are in data/projects/<project>/exports — use “Show in Finder” or “Copy to Downloads” on the export page.")));
}

$("#settingsBtn").addEventListener("click", () => openSettings(() => route()));
$("#helpBtn").addEventListener("click", openHelp);
window.addEventListener("hashchange", route);
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && document.activeElement.type !== "range";
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing && window.__editingClip) {
    e.preventDefault();
    if (e.shiftKey) ctx.history.redo(window.__editingClip); else ctx.history.undo(window.__editingClip);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !typing && window.__editingClip) {
    e.preventDefault(); ctx.history.redo(window.__editingClip); return;
  }
  if (e.code === "Space" && !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(document.activeElement.tagName) && window.__player) {
    e.preventDefault();
    window.__player.toggle();
  }
});
diskInfo();
route();
