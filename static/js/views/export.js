// Step 7: exact preview render + final MP4 export with verification.
import { api, watchJob } from "../api.js";
import { h, toast, fmtTime, fmtBytes, progressBar, errorBox, select, slider } from "../ui.js";
import { LAYOUTS } from "../compose.js";
import { startRender } from "../clipstate.js";
import { editorShell } from "./editorshell.js";

export async function render(main, ctx) {
  const ed = await editorShell(main, ctx, { step: "export", title: "7. Preview & export",
    intro: "Check the final result, then export a 1080×1920 MP4 with the subtitles burned in. Only this clip's part of the recordings is processed." });
  if (!ed) return;
  const { clip, player, right, changed } = ed;
  const p = ctx.state.project;
  let quality = "standard";
  const jobBox = h("div");
  const previewBox = h("div");
  const exportsBox = h("div", { class: "stack" });
  const audioOpts = ["speaker", "presentation"].filter((r) => p.sources[r]?.has_audio);

  const summary = h("div", { class: "card" },
    h("h3", {}, "Summary"),
    h("dl", { class: "kv" },
      h("dt", {}, "Webinar time"), h("dd", {}, `${fmtTime(clip.start)} – ${fmtTime(clip.end)} (${(clip.end - clip.start).toFixed(1)} s)`),
      h("dt", {}, "Sync offset"), h("dd", {}, `${p.sync.offset >= 0 ? "+" : ""}${p.sync.offset.toFixed(2)} s`),
      h("dt", {}, "Layouts"), h("dd", {}, clip.segments.map((s) => `${fmtTime(s.t, 1)} ${LAYOUTS[s.layout].short}${s.motion && s.motion !== "none" ? " (" + s.motion + ")" : ""}`).join(" → ")),
      h("dt", {}, "Transitions"), h("dd", {}, clip.transition.type === "cut" ? "hard cut" : `${clip.transition.type}, ${clip.transition.dur}s`),
      h("dt", {}, "Subtitles"), h("dd", {}, clip.captionsOn === false ? "off" : `${clip.captions.length} lines, template “${clip.templateId}”${clip.smartPos !== false ? ", smart position" : ""}`),
      h("dt", {}, "Title"), h("dd", {}, clip.hook?.enabled ? `“${clip.hook.line1} ${clip.hook.line2}” for ${clip.hook.end}s` : "none"),
      h("dt", {}, "Output"), h("dd", {}, "1080×1920, 30 fps, H.264 + AAC (plays everywhere)")));

  const audioCard = h("div", { class: "card" },
    h("h3", {}, "Audio"),
    audioOpts.length ? select("Audio from", clip.audio.source, audioOpts.map((r) => [r, r === "speaker" ? "🎤 Speaker recording" : "🖥️ Presentation recording"]), (v) => { clip.audio.source = v; changed(false); }) :
      h("div", { class: "alert warn" }, "Neither recording has audio — the clip will be silent."),
    slider("Volume", clip.audio.gain_db, -12, 12, 1, (v) => { clip.audio.gain_db = v; changed(false); }, (v) => (v > 0 ? "+" : "") + v + " dB"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: clip.audio.normalize, onchange: (e) => { clip.audio.normalize = e.target.checked; changed(false); } }),
      "Normalise loudness for social media (−14 LUFS)"),
    h("p", { class: "small muted" }, "The live preview plays the original volume; loudness normalisation is applied in the rendered preview and the export."));

  const actions = h("div", { class: "card" },
    h("h3", {}, "Render"),
    select("Export quality", quality, [["standard", "Standard — fast, great for social media"], ["high", "High — sharper, slower"]], (v) => { quality = v; }),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => run("preview").catch(() => {}) }, "▶ Render exact preview (fast, low-res)"),
      h("button", { class: "btn primary big", onclick: () => run(quality).catch(() => {}) }, "⬇ Export MP4")),
    h("p", { class: "small muted" }, "The exact preview runs the real export pipeline at half resolution, so you can double-check timing, cropping, transitions, subtitles and audio before the full export."),
    jobBox, previewBox);

  const batch = ctx.approved().length > 1 ? h("div", { class: "card" },
    h("h3", {}, "Export all selected clips"),
    h("p", { class: "small muted" }, `Exports all ${ctx.approved().length} approved clips one after another with their current settings (clips you haven't edited use the defaults).`),
    h("button", { class: "btn", onclick: exportAll }, `Export all ${ctx.approved().length} clips`)) : null;

  right.append(summary, audioCard, actions, batch, h("div", { class: "card" }, h("h3", {}, "Exported files"), exportsBox));

  let watcher;
  async function run(q, theClip = clip) {
    jobBox.innerHTML = "";
    jobBox.append(progressBar(0, "Preparing…"));
    try {
      await api(`/api/projects/${p.id}/clips/${theClip.id}`, { method: "PUT", json: theClip });
      const job = await startRender(theClip, ctx.state.project, q, (msg) => { jobBox.innerHTML = ""; jobBox.append(progressBar(0.01, msg)); });
      ctx.kickTasks();
      const cancel = h("button", { class: "btn small ghost", onclick: () => api(`/api/jobs/${job.id}/cancel`, { method: "POST" }) }, "Cancel");
      watcher = watchJob(job.id, (j) => { jobBox.innerHTML = ""; jobBox.append(progressBar(j.progress, j.status === "queued" ? "Waiting for another task…" : j.message), cancel); });
      const done = await watcher;
      jobBox.innerHTML = "";
      const v = done.result?.verify;
      if (q === "preview") {
        previewBox.innerHTML = "";
        previewBox.append(h("div", { class: "export-item", style: { marginTop: "12px" } },
          h("video", { src: `/api/projects/${p.id}/renders/preview-${theClip.id}.mp4?t=${Date.now()}`, controls: true, autoplay: true, playsinline: true }),
          h("div", {}, h("b", {}, "Exact preview (540×960)"), verifyList(v, 540, 960),
            h("p", { class: "small muted" }, `Rendered in ${done.result.seconds}s. If it looks right, click “Export MP4”.`))));
      } else {
        toast("Export finished and verified.", v?.ok ? "ok" : "error");
        await ctx.refresh();
        drawExports();
      }
      return done;
    } catch (e) {
      jobBox.innerHTML = "";
      if (!e.cancelled) jobBox.append(errorBox(e.message, () => run(q, theClip).catch(() => {})));
      throw e;
    }
  }

  async function exportAll() {
    for (const c of ctx.approved()) {
      const cl = await ctx.getClip(c.id);
      toast(`Exporting clip ${fmtTime(c.start, 0)}…`);
      try { await run(quality, cl); } catch { return; }
    }
    toast("All clips exported.", "ok");
  }

  function verifyList(v, W = 1080, H = 1920) {
    if (!v) return null;
    return h("ul", { class: "verify" },
      h("li", {}, v.ok ? "✅ File checked: plays correctly" : "⚠️ Problems: " + v.problems.join("; ")),
      h("li", {}, `${v.width === W && v.height === H ? "✅" : "⚠️"} ${v.width}×${v.height}, ${v.video_codec?.toUpperCase()} + ${v.audio_codec?.toUpperCase()}`),
      h("li", {}, `⏱ ${v.duration.toFixed(2)} s · ${fmtBytes(v.size_bytes)}`),
      h("li", {}, v.mean_volume_db == null ? "🔇 no audio level" : v.mean_volume_db < -50 ? `⚠️ audio is (almost) silent (${v.mean_volume_db} dB)` : `🔊 audio level ${v.mean_volume_db} dB (mean)`));
  }

  function drawExports() {
    const list = (ctx.state.project.exports || []).filter((e) => e.clip === clip.id).slice().reverse();
    exportsBox.innerHTML = "";
    if (!list.length) { exportsBox.append(h("p", { class: "muted small" }, "Nothing exported for this clip yet.")); return; }
    for (const e of list) {
      exportsBox.append(h("div", { class: "export-item" },
        h("video", { src: `/api/projects/${p.id}/exports/${encodeURIComponent(e.file)}`, controls: true, preload: "metadata", playsinline: true }),
        h("div", {},
          h("b", {}, e.file), h("div", { class: "small muted" }, new Date(e.created * 1000).toLocaleString(), ` · rendered in ${e.seconds}s`),
          verifyList(e.verify),
          h("p", { class: "small" }, "Saved at: ", h("span", { class: "mono" }, e.path)),
          h("div", { class: "row" },
            h("a", { class: "btn small primary", href: `/api/projects/${p.id}/exports/${encodeURIComponent(e.file)}?download=1` }, "⬇ Download"),
            h("button", { class: "btn small", onclick: () => api("/api/reveal", { json: { path: e.path } }).catch((x) => toast(x.message, "error")) }, "Show in Finder"),
            h("button", { class: "btn small", onclick: async () => {
              try { const r = await api(`/api/projects/${p.id}/exports/${encodeURIComponent(e.file)}/copy-to-downloads`, { method: "POST" }); toast("Copied to " + r.path, "ok", 7000); }
              catch (x) { toast(x.message, "error"); }
            } }, "Copy to Downloads")))));
    }
  }
  drawExports();
  return () => { watcher?.stop(); ed.cleanup(); };
}
