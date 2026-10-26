// “Keep only my clip parts”: save just the chosen minutes (+ extra) of both recordings as full-quality
// copies, so the big original files can be deleted. Shown in step 3 under “Your clips”.
import { api, watchJob } from "../api.js";
import { h, toast, fmtTime, fmtBytes, modal, progressBar, errorBox } from "../ui.js";

const ROLE_NAME = { speaker: "speaker recording", presentation: "screen recording" };

// Which approved clips are not inside the kept parts (per recording)?
function uncovered(p) {
  const out = [];
  for (const c of p.candidates.filter((x) => x.status === "approved")) {
    for (const [role, s] of Object.entries(p.sources)) {
      const pieces = s.kept?.pieces || [];
      if (!pieces.length) continue;
      const off = role === "presentation" ? p.sync.offset : 0;
      const a = Math.max(0, c.start + off), b = Math.min(s.duration, c.end + off);
      if (!pieces.some((pc) => pc.start - 0.05 <= a && b <= pc.end + 0.05)) { out.push(c); break; }
    }
  }
  return out;
}

export function keepPartsCard(ctx, redraw) {
  const p = ctx.state.project;
  const srcs = Object.entries(p.sources);
  if (!srcs.length) return null;
  const kept = srcs.filter(([, s]) => s.kept?.pieces?.length);
  const originalsGone = srcs.filter(([, s]) => s.original_missing);
  const box = h("div", { class: "card", style: { marginBottom: "16px", borderColor: "#cfe8d8", background: "#f8fdf9" } });
  const jobBox = h("div");
  const notCovered = uncovered(p);
  const keptSize = kept.reduce((a, [, s]) => a + s.kept.pieces.reduce((x, pc) => x + pc.size, 0), 0);
  const origSize = srcs.filter(([, s]) => !s.copied && !s.original_missing).reduce((a, [, s]) => a + s.size, 0);

  box.append(
    h("div", { class: "row between" },
      h("h3", {}, "💾 Keep only my clip parts"),
      h("button", { class: "btn small primary", disabled: !!originalsGone.length && !!kept.length, onclick: start },
        kept.length ? "Update kept parts" : "Keep only my clip parts")),
    h("p", { class: "small" }, "Saves just your chosen minutes of both recordings — plus 15 seconds extra around each clip so you can still fine‑tune — ",
      "as full‑quality copies (not re‑encoded). Afterwards you can delete the big original files; your edits keep working."));

  if (kept.length) {
    box.append(h("div", { class: "alert ok" },
      h("b", {}, `Saved: ${fmtBytes(keptSize)} of clip parts. `),
      kept.map(([role, s]) => h("div", { class: "small" }, `${ROLE_NAME[role]}: `,
        s.kept.pieces.map((pc) => `${fmtTime(pc.start, 0)}–${fmtTime(pc.end, 0)}`).join(", "),
        s.original_missing ? " · original deleted ✓ (using the kept parts)" : " · original still on disk"))));
    if (notCovered.length) {
      box.append(h("div", { class: "alert warn" }, `${notCovered.length} clip(s) are not inside the kept parts: `,
        notCovered.map((c) => `${fmtTime(c.start, 0)}–${fmtTime(c.end, 0)}`).join(", "), ". ",
        originalsGone.length ? "The originals are gone, so these clips can't be exported — remove them or put the originals back."
          : "Click “Update kept parts” before deleting the originals."));
    }
    const deletable = srcs.filter(([, s]) => !s.original_missing && !s.copied);
    if (deletable.length && !notCovered.length) {
      box.append(h("div", { class: "small", style: { marginTop: "6px" } },
        h("b", {}, `You can now delete the originals (${fmtBytes(origSize)}): `),
        deletable.map(([role]) => h("button", { class: "btn small", style: { marginLeft: "6px" }, onclick: () =>
          api(`/api/projects/${p.id}/sources/${role}/reveal`, { method: "POST" }).catch((e) => toast(e.message, "error")) }, `Show ${ROLE_NAME[role]} in Finder`)),
        h("div", { class: "small muted", style: { marginTop: "4px" } },
          "Move them to the Trash in Finder yourself — the app never deletes your files. Keep the preview copies; after deleting, new clips must stay within the kept minutes.")));
    }
    const copiedIn = srcs.filter(([, s]) => s.copied && !s.original_missing);
    if (copiedIn.length) box.append(h("p", { class: "small muted" }, "Recordings uploaded as a copy into the app are not removed automatically."));
  }
  box.append(jobBox);

  async function start() {
    let est;
    try { est = await api(`/api/projects/${p.id}/keep`); } catch (e) { toast(e.message, "error"); return; }
    const rows = Object.entries(est.roles).map(([role, r]) => h("div", { class: "card flat", style: { padding: "10px", marginBottom: "8px" } },
      h("b", {}, ROLE_NAME[role]), h("div", { class: "small" }, `Parts: ${r.ranges.map(([a, b]) => `${fmtTime(a, 0)}–${fmtTime(b, 0)}`).join(", ")} (${Math.round(r.seconds)} s)`),
      h("div", { class: "small muted" }, `About ${fmtBytes(r.bytes)} instead of ${fmtBytes(r.original_size)}`)));
    const enough = est.bytes + 500 * 1024 ** 2 < est.disk_free;
    modal("Keep only my clip parts", h("div", {},
      h("p", {}, `Copies the minutes of your ${est.clips} clip${est.clips > 1 ? "s" : ""} (plus ${est.pad} s before and after) from both recordings, in full original quality.`),
      rows,
      h("p", { class: enough ? "small muted" : "small", style: enough ? {} : { color: "var(--bad)" } },
        `Needs about ${fmtBytes(est.bytes)} · free disk space: ${fmtBytes(est.disk_free)}.`),
      h("p", { class: "small muted" }, "Nothing is deleted. When it's done you can delete the originals yourself.")), [
      { label: "Cancel", class: "btn ghost" },
      { label: "Save my clip parts", class: "btn primary", onClick: () => { if (!enough) { toast("Not enough free disk space.", "error"); return false; } run(); } },
    ]);
  }

  async function run() {
    jobBox.innerHTML = "";
    try {
      const job = await api(`/api/projects/${p.id}/keep`, { method: "POST" });
      ctx.kickTasks?.();
      const done = await watchJob(job.id, (j) => { jobBox.innerHTML = ""; jobBox.append(progressBar(j.progress, j.status === "queued" ? "Waiting for another task…" : j.message)); });
      jobBox.innerHTML = "";
      toast(done.message || "Clip parts saved.", "ok");
      await ctx.refresh();
      redraw();
    } catch (e) { jobBox.innerHTML = ""; if (!e.cancelled) jobBox.append(errorBox(e.message, run)); }
  }
  return box;
}
