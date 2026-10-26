// Step 4: review, adjust, approve/reject candidates.
import { api, watchJob } from "../api.js";
import { h, toast, fmtTime, parseTime, modal, progressBar, errorBox, select } from "../ui.js";
import { CompositePlayer } from "../player.js";
import { clipFromCandidate } from "../clipstate.js";

const SUB_LABELS = { hook: "Hook", clarity: "Clarity", standalone: "Standalone", usefulness: "Usefulness", engagement: "Engagement" };

export async function render(main, ctx) {
  const p = ctx.state.project;
  const tr = await ctx.transcript();
  const sents = tr?.sentences || [];
  const view = { sort: "score", topic: "", len: "", status: "active" };
  const list = h("div", { class: "cands" });
  const foot = h("div", { class: "sticky-foot" });
  const moreBox = h("div");

  const a = p.analysis || {};
  const banner = a.semantic
    ? h("div", { class: "alert info" }, `Suggestions by ${a.provider === "anthropic" ? "Claude" : "a local AI model"} (${a.model}). `,
      "Scores are heuristic judgements of hook strength, clarity, standalone value, usefulness and engagement — not predictions of views. Nothing guarantees a clip will go viral.")
    : h("div", { class: "alert warn" }, "Suggestions by the offline rules (not semantic AI). The scores reflect simple patterns and are only a rough guide — please judge each clip yourself. Nothing guarantees a clip will go viral.");

  main.append(h("div", { class: "page-head" }, h("div", {},
    h("h1", {}, "4. Review & select clips"),
    h("p", {}, "Preview each idea, fine-tune where it starts and ends, then approve the ones you want to turn into videos."))), banner);

  const topics = [...new Set(p.candidates.map((c) => c.topic).filter(Boolean))];
  const toolbar = h("div", { class: "toolbar" },
    select("Sort by", view.sort, [["score", "Highest potential"], ["duration", "Shortest first"], ["durationDesc", "Longest first"], ["time", "Order in webinar"]], (v) => { view.sort = v; draw(); }),
    select("Topic", view.topic, [["", "All topics"], ...topics.map((t) => [t, t])], (v) => { view.topic = v; draw(); }),
    select("Length", view.len, [["", "Any length"], ["s", "Under 30 s"], ["m", "30–60 s"], ["l", "Over 60 s"]], (v) => { view.len = v; draw(); }),
    select("Show", view.status, [["active", "Not rejected"], ["approved", "Approved only"], ["rejected", "Rejected only"], ["all", "Everything"]], (v) => { view.status = v; draw(); }),
    h("div", { class: "spacer" }),
    h("button", { class: "btn", onclick: addOwn }, "+ Add my own clip"),
    h("button", { class: "btn", onclick: findMore }, "↻ Find more suggestions"));
  main.append(toolbar, moreBox, list, foot);

  function filtered() {
    let cs = ctx.state.project.candidates.slice();
    if (view.status === "active") cs = cs.filter((c) => c.status !== "rejected");
    else if (view.status !== "all") cs = cs.filter((c) => c.status === view.status);
    if (view.topic) cs = cs.filter((c) => c.topic === view.topic);
    const d = (c) => c.end - c.start;
    if (view.len === "s") cs = cs.filter((c) => d(c) < 30);
    if (view.len === "m") cs = cs.filter((c) => d(c) >= 30 && d(c) <= 60);
    if (view.len === "l") cs = cs.filter((c) => d(c) > 60);
    const sorters = {
      score: (x, y) => (y.score ?? -1) - (x.score ?? -1),
      duration: (x, y) => d(x) - d(y), durationDesc: (x, y) => d(y) - d(x), time: (x, y) => x.start - y.start,
    };
    return cs.sort(sorters[view.sort]);
  }

  function draw() {
    list.innerHTML = "";
    const cs = filtered();
    if (!ctx.state.project.candidates.length) list.append(h("div", { class: "alert info" }, "No suggestions yet. Go back to step 3 and run the analysis."));
    else if (!cs.length) list.append(h("p", { class: "muted" }, "No clips match these filters."));
    for (const c of cs) list.append(card(c));
    const n = ctx.approved().length;
    foot.innerHTML = "";
    foot.append(h("span", {}, n ? `${n} clip${n > 1 ? "s" : ""} selected for editing` : "Approve at least one clip to continue."),
      h("button", { class: "btn primary big", disabled: !n, onclick: () => ctx.go("layout", ctx.approved()[0].id) }, `Edit ${n || ""} selected →`));
  }

  function card(c) {
    const dur = c.end - c.start;
    const scoreCls = c.score == null ? "lo" : c.score >= 70 ? "hi" : c.score < 50 ? "lo" : "";
    const hookLbl = c.hook_kind === "ai_suggested" ? "Suggested hook — on-screen text written by AI, NOT said by the speaker"
      : c.hook_kind === "verbatim" ? "Hook idea — a line the speaker actually says in this clip" : null;
    const st = h("input", { class: "inline time", value: fmtTime(c.start) });
    const en = h("input", { class: "inline time", value: fmtTime(c.end) });
    const setTimes = async (start, end) => {
      try {
        const upd = await api(`/api/projects/${p.id}/candidates/${c.id}`, { method: "PATCH", json: { start, end } });
        Object.assign(c, upd);
        if (ctx.state.project.clips[c.id]) {
          // keep an existing edit in sync with the new timing
          const clip = ctx.state.project.clips[c.id];
          clip.start = upd.start; clip.end = upd.end; clip.needsCaptionRebuild = true;
          ctx.saveClip(clip);
        }
        draw();
      } catch (e) { toast(e.message, "error"); draw(); }
    };
    st.addEventListener("change", () => { const v = parseTime(st.value); if (!isNaN(v)) setTimes(v, c.end); });
    en.addEventListener("change", () => { const v = parseTime(en.value); if (!isNaN(v)) setTimes(c.start, v); });
    const snap = (which, dir) => {
      if (!sents.length) return;
      if (which === "start") {
        const cands = sents.map((s) => s.start - 0.15);
        const t = dir < 0 ? [...cands].reverse().find((x) => x < c.start - 0.3) : cands.find((x) => x > c.start + 0.3);
        if (t != null && t < c.end - 1) setTimes(Math.max(0, t), c.end);
      } else {
        const cands = sents.map((s) => s.end + 0.25);
        const t = dir < 0 ? [...cands].reverse().find((x) => x < c.end - 0.3) : cands.find((x) => x > c.end + 0.3);
        if (t != null && t > c.start + 1) setTimes(c.start, t);
      }
    };
    const setStatus = async (status) => {
      const upd = await api(`/api/projects/${p.id}/candidates/${c.id}`, { method: "PATCH", json: { status } });
      Object.assign(c, upd);
      draw();
    };
    const changed = Math.abs(c.start - c.orig_start) > 0.05 || Math.abs(c.end - c.orig_end) > 0.05;
    return h("div", { class: `card cand ${c.status}` },
      h("div", {},
        h("div", { class: `score ${scoreCls}`, title: "Heuristic potential score (0–100). Not a prediction of views." },
          h("b", {}, c.score ?? "–"), h("span", {}, "potential")),
        c.confidence ? h("div", { class: "small muted", style: { textAlign: "center", marginTop: "6px" } }, `${c.confidence} confidence`) : null),
      h("div", {},
        h("div", { class: "row" },
          h("span", { class: "chip accent" }, c.topic || "general"),
          h("span", { class: "chip" }, `${Math.round(dur)} s`),
          h("span", { class: "chip" }, `${fmtTime(c.start)} – ${fmtTime(c.end)}`),
          c.status === "approved" ? h("span", { class: "chip ok" }, "✓ approved") : null,
          c.status === "rejected" ? h("span", { class: "chip bad" }, "rejected") : null,
          h("span", { class: "spacer" }),
          h("span", { class: "small muted" }, c.source === "heuristic" ? "offline rules" : c.source === "manual" ? "added by you" : c.source)),
        hookLbl && c.hook ? h("div", { class: "hookbox" }, h("span", { class: "lbl" }, hookLbl), h("b", {}, c.hook)) : null,
        c.why ? h("p", { style: { margin: "6px 0" } }, h("b", {}, "Why it may work: "), c.why) : null,
        c.scores ? h("div", { class: "subs" }, Object.entries(SUB_LABELS).map(([k, l]) => h("div", { class: "sub" }, `${l} ${c.scores[k]}/10`,
          h("div", { class: "bar" }, h("i", { style: { width: `${c.scores[k] * 10}%` } }))))) : null,
        c.caveats?.length ? h("ul", { class: "caveats" }, c.caveats.map((x) => h("li", {}, "⚠ " + x))) : null,
        h("div", { class: "quote" }, h("span", { class: "lbl" }, "What the speaker says (transcript)"), "“", c.text || "(no speech in this range)", "”"),
        h("div", { class: "trim-row" },
          h("span", { class: "muted" }, "Start"), h("button", { class: "btn small", title: "Previous sentence", onclick: () => snap("start", -1) }, "◀"), st,
          h("button", { class: "btn small", title: "Next sentence", onclick: () => snap("start", 1) }, "▶"),
          h("span", { class: "muted", style: { marginLeft: "10px" } }, "End"), h("button", { class: "btn small", onclick: () => snap("end", -1) }, "◀"), en,
          h("button", { class: "btn small", onclick: () => snap("end", 1) }, "▶"),
          changed ? h("button", { class: "btn small ghost", onclick: () => setTimes(c.orig_start, c.orig_end) }, "Reset") : null,
          h("span", { class: "spacer" }),
          h("button", { class: "btn", onclick: () => preview(c) }, "▶ Preview"),
          c.status === "approved" ? h("button", { class: "btn", onclick: () => setStatus("new") }, "Unapprove")
            : h("button", { class: "btn ok", onclick: () => setStatus("approved") }, "✓ Approve"),
          c.status === "rejected" ? h("button", { class: "btn", onclick: () => setStatus("new") }, "Restore")
            : h("button", { class: "btn ghost danger", onclick: () => setStatus("rejected") }, "✕ Reject"))));
  }

  function preview(c) {
    const pr = ctx.state.project;
    const clip = pr.clips[c.id] ? { ...pr.clips[c.id], start: c.start, end: c.end } : clipFromCandidate(c, pr, tr?.words || [], null);
    const player = new CompositePlayer(pr, { width: 360, height: 640 });
    window.__player = player;
    player.setClip(clip);
    const m = modal(`Preview · ${fmtTime(c.start)} – ${fmtTime(c.end)}`, h("div", { class: "grid2" },
      h("div", { style: { maxWidth: "300px" } }, player.el),
      h("div", {},
        h("p", { class: "small muted" }, pr.clips[c.id] ? "Showing your current layout and subtitles." : "Default layout: slides on top, speaker below, with automatic subtitles. You can change everything in the next steps."),
        h("div", { class: "quote", style: { maxHeight: "420px" } }, c.text))));
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { player.destroy(); window.__player = null; obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
    setTimeout(() => player.play(), 300);
  }

  async function addOwn() {
    const st = h("input", { class: "inline time", placeholder: "12:30" });
    const en = h("input", { class: "inline time", placeholder: "13:10" });
    modal("Add your own clip", h("div", {}, h("p", {}, "Know a good moment already? Enter its start and end time (minutes:seconds, speaker recording time)."),
      h("div", { class: "row" }, "Start", st, "End", en)), [
      { label: "Cancel", class: "btn ghost" },
      { label: "Add", class: "btn primary", onClick: async () => {
        const a = parseTime(st.value), b = parseTime(en.value);
        if (isNaN(a) || isNaN(b) || b <= a) { toast("Please enter a valid start and end time.", "error"); return false; }
        try { await api(`/api/projects/${p.id}/candidates`, { json: { start: a, end: b } }); await ctx.refresh(); draw(); }
        catch (e) { toast(e.message, "error"); return false; }
      } },
    ]);
  }

  async function findMore() {
    moreBox.innerHTML = "";
    try {
      const sys = ctx.state.system;
      const job = await api(`/api/projects/${p.id}/discover`, { json: { more: true, count: 5, provider: p.analysis?.provider || sys?.settings.provider } });
      ctx.kickTasks();
      await watchJob(job.id, (j) => { moreBox.innerHTML = ""; moreBox.append(progressBar(j.progress, j.message)); });
      moreBox.innerHTML = "";
      await ctx.refresh();
      const n = ctx.state.project.candidates.length - p.candidates.length;
      toast(n > 0 ? `${n} more ideas added` : "No further good moments found with these settings.", n > 0 ? "ok" : "info");
      Object.assign(p, ctx.state.project);
      draw();
    } catch (e) { moreBox.innerHTML = ""; moreBox.append(errorBox(e.message)); }
  }

  draw();
}
