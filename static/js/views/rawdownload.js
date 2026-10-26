// Download the raw footage of a chosen clip: the speaker part, the screen-recording part,
// or the speaker cutout (green screen MP4 / transparent ProRes MOV).
import { api, watchJob } from "../api.js";
import { h, toast, fmtTime, fmtBytes, modal, progressBar, errorBox } from "../ui.js";
import { cutoutFor } from "../compose.js";

export function openRawDownload(ctx, cand) {
  const p = ctx.state.project;
  const ed = p.clips[cand.id];
  const range = { start: ed?.start ?? cand.start, end: ed?.end ?? cand.end };
  const hasCut = !!cutoutFor(p, range);
  const options = [
    ["speaker", "🎤 Speaker video", "The clip's minutes of the speaker recording, with sound (MP4).", !!p.sources.speaker],
    ["presentation", "🖥️ Screen recording", "The same minutes of the screen recording, matched with the sync offset (MP4).", !!p.sources.presentation],
    ["cutout_green", "🧍 Speaker cutout — green screen", "The speaker on a green background, for any editor's green-screen / chroma key (MP4).", hasCut],
    ["cutout_alpha", "🧍 Speaker cutout — transparent (small)", "Transparent background, HEVC .mov — Final Cut Pro, iMovie, Keynote, Motion and other Apple apps. Small file.", hasCut],
    ["cutout_prores", "🧍 Speaker cutout — transparent (ProRes, very large)",
      `Transparent background, ProRes 4444 .mov — for Premiere, DaVinci Resolve and most pro editors. About ${(55 * (range.end - range.start) / 1000).toFixed(1)} GB for this clip.`, hasCut],
  ];
  const body = h("div", {},
    h("p", {}, `Clip ${fmtTime(range.start)} – ${fmtTime(range.end)} (${(range.end - range.start).toFixed(1)} s). Cut exactly to the start and end, in high quality.`),
    !hasCut ? h("p", { class: "small muted" }, "The cutout downloads appear after you prepare the person cutout for this clip (Layout & cropping → Person cutout).") : null);
  for (const [kind, title, desc, ok] of options) {
    if (!ok) continue;
    const status = h("div");
    const btn = h("button", { class: "btn small primary", onclick: () => run(kind, btn, status) }, "⬇ Prepare download");
    body.append(h("div", { class: "card flat", style: { padding: "10px", marginBottom: "8px" } },
      h("div", { class: "row between" }, h("div", {}, h("b", {}, title), h("div", { class: "small muted" }, desc)), btn), status));
  }
  modal("Download this clip's footage", body, [{ label: "Close", class: "btn ghost" }]);

  async function run(kind, btn, status) {
    btn.disabled = true;
    status.innerHTML = "";
    try {
      const job = await api(`/api/projects/${p.id}/clips/${cand.id}/raw`, { json: { kind } });
      ctx.kickTasks?.();
      const done = await watchJob(job.id, (j) => { status.innerHTML = ""; status.append(progressBar(j.progress, j.status === "queued" ? "Waiting for another task…" : j.message)); });
      const r = done.result;
      status.innerHTML = "";
      status.append(h("div", { class: "row", style: { marginTop: "6px" } },
        h("span", { class: "small", style: { color: "var(--ok)", fontWeight: 600 } }, `✓ ${r.file} · ${fmtBytes(r.size)}`),
        h("a", { class: "btn small primary", href: `/api/projects/${p.id}/downloads/${encodeURIComponent(r.file)}`, download: r.file }, "Save file"),
        h("button", { class: "btn small", onclick: () => api("/api/reveal", { json: { path: r.path } }).catch((e) => toast(e.message, "error")) }, "Show in Finder")));
      btn.textContent = "↻ Prepare again";
    } catch (e) {
      status.innerHTML = "";
      if (!e.cancelled) status.append(errorBox(e.message));
    }
    btn.disabled = false;
  }
}
