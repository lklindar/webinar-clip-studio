// Step 1: add the speaker and presentation recordings.
import { api, uploadFile, watchJob } from "../api.js";
import { h, toast, progressBar, fmtBytes, fmtDur, fmtTime, errorBox, confirmBox } from "../ui.js";
import { assetsSection } from "./assets.js";

const ROLE_INFO = {
  speaker: { icon: "🎤", title: "Speaker recording", desc: "The camera recording of the person talking (horizontal). Its audio is used for transcription by default." },
  presentation: { icon: "🖥️", title: "Presentation recording", desc: "The screen recording of the slides (horizontal). Optional, but needed for split-screen layouts." },
};

export async function render(main, ctx) {
  const sys = await ctx.diskInfo();
  const uploads = {}; // role -> {abort, progress, error, file}
  const head = h("div", { class: "page-head" }, h("div", {},
    h("h1", {}, "1. Upload your recordings"),
    h("p", {}, "Add the two recordings of your webinar. You don't need to cut or crop anything — the app only processes the parts you choose later.")));
  const tips = h("div", { class: "alert info" },
    h("b", {}, "Large files (several GB)? "),
    "Choose “Use file in place”. The app then reads your original file directly — nothing is duplicated, and it is never loaded fully into memory. ",
    `Free disk space right now: ${fmtBytes(sys?.disk_free)}.`);
  const cards = h("div", { class: "grid2" });
  const foot = h("div", { class: "sticky-foot" });
  main.append(head, tips, cards, assetsSection(ctx), foot);

  function draw() {
    const p = ctx.state.project;
    cards.innerHTML = "";
    for (const role of ["speaker", "presentation"]) cards.append(card(role, p.sources[role]));
    foot.innerHTML = "";
    const hasAny = p.sources.speaker || p.sources.presentation;
    foot.append(
      h("div", { class: "row" },
        p.sources.speaker || p.sources.presentation ? h("button", { class: "btn", onclick: swap, title: "Use this if the two files were added to the wrong slots" }, "⇅ Swap speaker / presentation") : null,
        !p.sources.presentation && p.sources.speaker ? h("span", { class: "muted small" }, "No presentation? You can continue with the speaker only (full-screen speaker layouts).") : null),
      h("button", { class: "btn primary big", disabled: !hasAny, onclick: () => ctx.go("sync") }, "Next: Synchronize →"));
  }

  function card(role, src) {
    const info = ROLE_INFO[role];
    const up = uploads[role];
    const c = h("div", { class: "card src-card" }, h("h3", {}, h("span", { class: "role-icon" }, info.icon), info.title));
    if (up && !up.done) {
      c.append(h("p", { class: "muted" }, up.file.name, " — ", fmtBytes(up.file.size)));
      if (up.error) c.append(errorBox(up.error));
      if (up.progress) {
        const pr = up.progress;
        c.append(progressBar(pr.loaded / pr.total, up.paused ? "Paused" :
          `Uploading ${fmtBytes(pr.loaded)} of ${fmtBytes(pr.total)} · ${fmtBytes(pr.rate)}/s · about ${fmtDur(pr.eta)} left`));
      } else c.append(progressBar(0, "Starting upload…"));
      c.append(h("div", { class: "row" },
        up.paused || up.error ? h("button", { class: "btn primary small", onclick: () => startUpload(role, up.file) }, "Resume") :
          h("button", { class: "btn small", onclick: () => { up.paused = true; up.abort.abort(); draw(); } }, "Pause"),
        h("button", { class: "btn small ghost", onclick: () => { up.abort.abort(); delete uploads[role]; draw(); } }, "Cancel")));
      return c;
    }
    if (!src) {
      c.append(h("p", { class: "muted" }, info.desc));
      const fileIn = h("input", { type: "file", accept: "video/mp4,video/quicktime,.mp4,.mov,.m4v", style: { display: "none" },
        onchange: () => fileIn.files[0] && startUpload(role, fileIn.files[0]) });
      const drop = h("div", { class: "drop" },
        h("div", { class: "big-icon" }, "⬆"),
        h("p", {}, h("b", {}, "Drag an MP4 here"), " or"),
        h("div", { class: "row", style: { justifyContent: "center" } },
          h("button", { class: "btn primary", onclick: () => pickInPlace(role) }, "Use file in place (no copy)"),
          h("button", { class: "btn", onclick: () => fileIn.click() }, "Upload a copy")),
        h("p", { class: "small muted", style: { marginTop: "10px" } }, "In place = fastest and uses no extra disk space. ",
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); pastePath(role); } }, "Paste a file path instead")),
        fileIn);
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => {
        e.preventDefault(); drop.classList.remove("over");
        const f = e.dataTransfer.files[0];
        if (f) startUpload(role, f);
      });
      c.append(drop);
      return c;
    }
    const p = ctx.state.project;
    const proxyJob = (p.jobs || []).filter((j) => j.kind === "proxy" && j.label.includes(role)).pop();
    c.append(
      h("img", { class: "thumb", src: `/api/projects/${p.id}/frame/${role}?t=${Math.min(30, src.duration / 3) - (role === "presentation" ? p.sync.offset : 0)}&w=480&fp=${src.fp}`, alt: "" }),
      h("dl", { class: "kv" },
        h("dt", {}, "File"), h("dd", {}, src.name),
        h("dt", {}, "Stored"), h("dd", {}, src.original_missing && src.kept?.pieces?.length
          ? h("span", {}, "✂️ Only your clip parts are kept (original deleted): ",
              src.kept.pieces.map((pc) => `${fmtTime(pc.start, 0)}–${fmtTime(pc.end, 0)}`).join(", "))
          : src.copied ? "Copy inside this app" : h("span", {}, "In place (original, not copied): ", h("span", { class: "mono" }, src.path))),
        h("dt", {}, "Size"), h("dd", {}, fmtBytes(src.size)),
        h("dt", {}, "Duration"), h("dd", {}, fmtDur(src.duration)),
        h("dt", {}, "Video"), h("dd", {}, `${src.width}×${src.height}, ${Math.round(src.fps)} fps, ${src.vcodec}`),
        h("dt", {}, "Audio"), h("dd", {}, src.has_audio ? src.acodec : h("span", { class: "chip warn" }, "no audio track")),
        h("dt", {}, "Preview copy"), h("dd", {}, src.proxy === "ready" ? h("span", { class: "chip ok" }, "ready") :
          proxyJob?.status === "error" ? h("span", { class: "chip bad" }, "failed") : h("span", { class: "chip" }, "being created…"))),
      ...(src.warnings || []).map((w) => h("div", { class: "alert warn" }, w)));
    if (src.proxy !== "ready" && proxyJob) {
      if (proxyJob.status === "error") c.append(errorBox(proxyJob.error, async () => {
        await api(`/api/projects/${p.id}/sources/${role}/retry`, { method: "POST" }); ctx.kickTasks(); await ctx.refresh(); draw();
      }));
      else c.append(progressBar(proxyJob.progress, proxyJob.status === "queued" ? "Waiting for the other file…" : proxyJob.message),
        h("p", { class: "small muted" }, "You can continue meanwhile — this small preview copy makes scrubbing smooth."));
    }
    c.append(h("div", { class: "row" },
      h("button", { class: "btn small", onclick: () => pickInPlace(role) }, "Replace…"),
      h("button", { class: "btn small ghost danger", onclick: async () => {
        if (!(await confirmBox("Remove recording?", src.copied ? "The copy stored in this app will be deleted." : "Your original file is NOT deleted; it is only removed from this project.", "Remove"))) return;
        await api(`/api/projects/${p.id}/sources/${role}`, { method: "DELETE" });
        await ctx.refresh(); draw();
      } }, "Remove")));
    return c;
  }

  async function pickInPlace(role) {
    try {
      const r = await api("/api/pick-file", { json: { prompt: `Choose the ${role} recording` } });
      if (!r.path) return;
      await linkPath(role, r.path);
    } catch (e) { toast(e.message, "error", 8000); }
  }

  function pastePath(role) {
    const path = prompt("Paste the full path of the video file (tip: in Finder, right-click the file while holding Option → “Copy … as Pathname”):");
    if (path) linkPath(role, path);
  }

  async function linkPath(role, path) {
    toast("Reading video information…");
    try {
      await api(`/api/projects/${ctx.state.project.id}/sources/${role}/link`, { json: { path } });
      ctx.kickTasks();
      await ctx.refresh();
      draw();
      toast(`${ROLE_INFO[role].title} added`, "ok");
    } catch (e) { toast(e.message, "error", 9000); }
  }

  async function startUpload(role, file) {
    if (!/\.(mp4|mov|m4v)$/i.test(file.name)) { toast("Please choose an MP4 video file.", "error"); return; }
    const abort = new AbortController();
    uploads[role] = { file, abort, progress: null };
    draw();
    try {
      await uploadFile(ctx.state.project.id, role, file, (pr) => { uploads[role].progress = pr; draw(); }, abort.signal);
      uploads[role].done = true;
      delete uploads[role];
      ctx.kickTasks();
      await ctx.refresh();
      toast(`${ROLE_INFO[role].title} uploaded`, "ok");
    } catch (e) {
      if (uploads[role]) { if (!e.cancelled) uploads[role].error = e.message; }
    }
    draw();
  }

  async function swap() {
    await api(`/api/projects/${ctx.state.project.id}/sources/swap`, { method: "POST" });
    ctx.kickTasks();
    await ctx.refresh();
    draw();
    toast("Swapped. The sync offset was inverted accordingly.");
  }

  draw();
  const off = ctx.onProject(() => { if (!Object.values(uploads).some((u) => !u.done)) draw(); });
  return () => { off(); for (const u of Object.values(uploads)) u.abort?.abort(); };
}
