// Shared frame for the editor steps: clip picker + live 9:16 preview.
import { h, toast, fmtTime } from "../ui.js";
import { CompositePlayer } from "../player.js";
import { buildCaptions, applyAutoEdit } from "../clipstate.js";

export async function editorShell(main, ctx, { step, title, intro }) {
  const approved = ctx.approved();
  if (!approved.length) {
    main.append(h("div", { class: "alert info" }, "Approve at least one clip in step 4 first."),
      h("button", { class: "btn", onclick: () => ctx.go("review") }, "← Review clips"));
    return null;
  }
  const cid = approved.some((c) => c.id === ctx.state.clipId) ? ctx.state.clipId : approved[0].id;
  if (cid !== ctx.state.clipId) { history.replaceState(null, "", `#/p/${ctx.state.project.id}/${step}/${cid}`); ctx.state.clipId = cid; }
  const clip = await ctx.getClip(cid);
  if (clip.needsCaptionRebuild) {
    const tr = await ctx.transcript();
    if (!clip.captionsEdited && tr) {
      clip.captions = buildCaptions(tr.words, clip.start, clip.end, clip.style.maxWords);
      clip.captionsKey = ctx.state.project.transcript?.created || null;
      toast("Subtitles were updated for the new clip timing.");
    } else if (clip.captionsEdited) {
      toast("The clip timing changed. Check your edited subtitles (or rebuild them in the Subtitles step).", "info", 7000);
    }
    clip.needsCaptionRebuild = false;
    const dur = clip.end - clip.start;
    clip.segments = clip.segments.filter((s, i) => i === 0 || s.t < dur - 0.3);
    ctx.saveClip(clip, { merge: true });
  }
  // Subtitles follow the transcript automatically until the user edits them by hand.
  const syncCaptions = async (announce) => {
    const key = ctx.state.project.transcript?.created || null;
    if (!key || clip.captionsKey === key || clip.captionsEdited) return false;
    const tr = await ctx.transcript(true);
    if (!tr) return false;
    clip.captions = buildCaptions(tr.words, clip.start, clip.end, clip.style.maxWords);
    clip.captionsKey = key;
    // the automatic edit cuts at pauses in speech, so redo it once the words are known
    if (clip.autoEdit && !clip.layoutEdited && !clip.autoEditWords) applyAutoEdit(clip, ctx.state.project, tr.words, clip.autoEdit);
    ctx.saveClip(clip, { merge: true });
    if (announce) toast("Subtitles are ready.", "ok");
    return true;
  };
  await syncCaptions(false);
  if (!clip.autoEdit && !clip.layoutEdited && clip.segments.length === 1) {
    // clip made before auto-edit existed: give it the automatic effects too (undo in the Layout step)
    const tr = await ctx.transcript();
    clip.undoSegments = { segments: clip.segments, transition: clip.transition, motion: clip.motion };
    applyAutoEdit(clip, ctx.state.project, tr?.words || [], "dynamic");
    ctx.saveClip(clip, { merge: true });
    toast("Added automatic layout changes and motion to this clip. You can change or undo them in “Layout & cropping”.", "ok", 7000);
  }
  const subsBanner = h("div");
  const drawBanner = () => {
    subsBanner.innerHTML = "";
    const j = (ctx.state.project.jobs || []).find((x) => (x.kind === "subtitles" || x.kind === "discover") && (x.status === "running" || x.status === "queued"));
    if (j) subsBanner.append(h("div", { class: "alert info" }, "⏳ Preparing subtitles for your clips (transcribing only the chosen minutes)… You can already arrange the layout. ", h("b", {}, j.message || "")));
    else if (!clip.captions.length && !ctx.state.project.transcript) subsBanner.append(h("div", { class: "alert warn" }, "No transcript yet, so there are no subtitles. They will appear once transcription has run."));
  };
  drawBanner();
  const offProj = ctx.onProject(async () => {
    drawBanner();
    if (await syncCaptions(true)) { player.draw(); onCaptionsChanged?.(); }
  });
  const bannerTimer = setInterval(drawBanner, 1500);
  let onCaptionsChanged = null;
  const picker = h("select", { class: "inline", onchange: (e) => ctx.go(step, e.target.value) },
    approved.map((c, i) => h("option", { value: c.id, selected: c.id === cid },
      `Clip ${i + 1}: ${fmtTime(c.start, 0)}–${fmtTime(c.end, 0)} · ${(ctx.state.project.clips[c.id]?.name || c.hook || c.topic || "").slice(0, 50)}`)));
  const player = new CompositePlayer(ctx.state.project, { width: 540, height: 960 });
  window.__player = player;
  player.setClip(clip);
  if (ctx.state.resumeT != null) { player.seek(ctx.state.resumeT); ctx.state.resumeT = null; }
  // undo / redo
  ctx.history.init(clip);
  window.__editingClip = clip;
  const undoBtn = h("button", { class: "btn small", title: "Undo (⌘Z)", onclick: () => ctx.history.undo(clip) }, "↶ Undo");
  const redoBtn = h("button", { class: "btn small", title: "Redo (⇧⌘Z)", onclick: () => ctx.history.redo(clip) }, "↷ Redo");
  const syncHistoryButtons = () => { const c = ctx.history.can(clip); undoBtn.disabled = !c.undo; redoBtn.disabled = !c.redo; };
  syncHistoryButtons();
  const offHist = ctx.history.onChange(syncHistoryButtons);
  // save indicator, so it's clear the work is stored on disk
  const saveEl = h("span", { class: "small", style: { minWidth: "130px", textAlign: "right" } });
  const drawSave = (st) => {
    if (st.error) { saveEl.textContent = "⚠ Not saved — retrying…"; saveEl.style.color = "var(--bad)"; }
    else if (st.pending > 0 || st.queued) { saveEl.textContent = "Saving…"; saveEl.style.color = "var(--muted)"; }
    else { saveEl.textContent = "✓ All changes saved"; saveEl.style.color = "var(--ok)"; }
  };
  drawSave(ctx.saveStatus.get());
  const offSave = ctx.saveStatus.on(drawSave);
  const right = h("div", { class: "stack" });
  main.append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), h("p", {}, intro)),
      h("div", { class: "row" }, saveEl, undoBtn, redoBtn, h("span", { class: "small muted", style: { marginLeft: "8px" } }, "Editing"), picker,
        h("button", { class: "btn small", title: "Make a copy of this clip to try a different approach", onclick: async () => {
          ctx.saveClip.flush?.(clip);
          const id = await ctx.duplicateClip(ctx.state.project.id, clip.id, clip.name);
          if (id) { await ctx.refresh(); ctx.go(step, id); }
        } }, "⧉ Duplicate"))),
    subsBanner,
    h("div", { class: "editor" }, h("div", { class: "editor-left" }, player.el,
      h("p", { class: "small muted", style: { marginTop: "6px" } }, "Live preview (low-res). Click the video or press Space to play/pause.")), right));
  const changed = (redraw = true) => { ctx.saveClip(clip); if (redraw) player.draw(); };
  return { clip, player, right, changed, setOnCaptionsChanged: (fn) => { onCaptionsChanged = fn; },
    cleanup: () => { offSave(); offHist(); window.__editingClip = null; offProj(); clearInterval(bannerTimer); ctx.saveClip.flush?.(clip); player.destroy(); window.__player = null; } };
}
