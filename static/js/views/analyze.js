// Step 3: transcribe + discover clip candidates.
import { api, watchJob } from "../api.js";
import { h, toast, progressBar, errorBox, fmtDur, select } from "../ui.js";
import { openSettings } from "../app.js";

export async function render(main, ctx, { embedded = false } = {}) {
  const sys = await ctx.diskInfo();
  const p = ctx.state.project;
  const s = sys.settings;
  const audioSrc = p.sources[p.sync.audio];
  const params = { min_dur: 20, max_dur: 60, count: 10, provider: s.provider, whisper_model: s.whisper_model };
  const jobBox = h("div");
  if (!embedded) main.append(h("div", { class: "page-head" }, h("div", {},
    h("h1", {}, "3. Discover clip ideas"),
    h("p", {}, "The app transcribes the webinar on your Mac (with word-level timestamps), then looks for moments that could work as standalone short videos: strong hooks, surprising statements, practical tips, stories and clear answers."))));

  const prov = sys.ai;
  const providerCard = h("div", { class: "card" });
  const estBox = h("div", { class: "small" });
  async function drawProvider() {
    providerCard.innerHTML = "";
    const name = { heuristic: "Offline rules (free, not semantic AI)", anthropic: `Claude — ${prov.anthropic.model}`, local: `Local model — ${prov.local.model}` }[params.provider];
    providerCard.append(h("h3", {}, "How clips are chosen"),
      h("div", { class: "seg-ctl", style: { marginBottom: "10px" } }, [["heuristic", "Offline rules"], ["anthropic", "Claude AI"], ["local", "Local AI"]].map(([v, l]) =>
        h("button", { class: params.provider === v ? "on" : "", onclick: () => { params.provider = v; drawProvider(); } }, l))),
      h("p", {}, h("b", {}, name)));
    if (params.provider === "heuristic") {
      providerCard.append(h("div", { class: "alert warn" },
        "Honest note: offline rules look for patterns (questions, “the biggest mistake…”, tips, numbers, stories) and penalise clips that start mid‑thought. They do not understand meaning. ",
        "For semantic suggestions and written hooks, enable Claude in Settings (about $0.10–0.25 per hour of webinar)."),
        h("button", { class: "btn small", onclick: () => openSettings(() => location.reload()) }, "Open AI settings"));
    } else if (params.provider === "anthropic") {
      if (!prov.anthropic.configured) {
        providerCard.append(h("div", { class: "alert error" }, "Claude is not set up yet: no API key. Add your Anthropic API key in Settings, or use the offline rules."),
          h("button", { class: "btn small primary", onclick: () => openSettings(() => location.reload()) }, "Add API key"));
      } else {
        providerCard.append(h("div", { class: "alert info" }, "Privacy: only the transcript text is sent to Anthropic. Your video and audio never leave this Mac."), estBox);
        try {
          const e = await api(`/api/projects/${p.id}/estimate`);
          estBox.textContent = `Estimated cost for this webinar: about $${Math.max(0.01, e.usd).toFixed(2)} (${e.chunks} request${e.chunks > 1 ? "s" : ""}, ~${Math.round(e.input_tokens / 1000)}k tokens in). Billed to your Anthropic account.`;
        } catch { /* ignore */ }
      }
    } else {
      providerCard.append(h("div", { class: "alert info" }, `Uses ${prov.local.base_url}. Free and private, but small local models give weaker suggestions and can be slow on 8 GB of memory.`),
        h("button", { class: "btn small", onclick: () => openSettings(() => location.reload()) }, "Local AI settings"));
    }
  }

  const tr = p.transcript;
  const est = audioSrc ? audioSrc.duration : 0;
  const speed = { tiny: 0.04, base: 0.08, small: 0.2, medium: 0.6 };
  const trCard = h("div", { class: "card" },
    h("h3", {}, "Transcription (on your Mac)"),
    tr ? h("div", { class: "alert ok" }, `Transcript ready: ${tr.words_count.toLocaleString()} words, language “${tr.language}”, model “${tr.model}”. It is saved and reused.`)
      : h("p", { class: "small" }, `Audio: ${p.sync.audio} recording (${fmtDur(est)}).`),
    select("Speech model", params.whisper_model, Object.entries(sys.whisper_models).map(([k, d]) => [k, `${k} — ${d}`]), (v) => { params.whisper_model = v; drawEta(); }),
    h("p", { class: "small muted", id: "eta" }));
  const drawEta = () => {
    const e = trCard.querySelector("#eta");
    const cached = tr && tr.model === params.whisper_model;
    e.textContent = cached ? "Already transcribed with this model — no waiting." :
      `Expected transcription time on this Mac: about ${fmtDur(Math.max(20, est * speed[params.whisper_model]))}.`;
  };

  const lenCard = h("div", { class: "card" },
    h("h3", {}, "Clip preferences"),
    h("div", { class: "grid2" },
      select("Shortest clip", String(params.min_dur), [["10", "10 s"], ["15", "15 s"], ["20", "20 s"], ["30", "30 s"], ["45", "45 s"]], (v) => { params.min_dur = +v; }),
      select("Longest clip", String(params.max_dur), [["30", "30 s"], ["45", "45 s"], ["60", "60 s"], ["90", "90 s"], ["120", "2 min"], ["180", "3 min"]], (v) => { params.max_dur = +v; })),
    select("Number of suggestions", String(params.count), [["5", "5"], ["10", "10"], ["15", "15"], ["25", "25"]], (v) => { params.count = +v; }));

  const startBtn = h("button", { class: "btn primary big", onclick: () => start(false) }, p.candidates.length ? "Analyse again" : "Transcribe & find clips");
  main.append(h("div", { class: "grid2" }, h("div", { class: "stack" }, trCard, lenCard), providerCard),
    h("div", { class: "card", style: { marginTop: "18px" } }, h("div", { class: "row between" },
      h("div", {}, h("h3", {}, "Run the analysis"), h("p", { class: "small muted" }, "You can leave this page; the work continues in the background (see the left panel).")),
      h("div", { class: "row" },
        p.candidates.length ? h("button", { class: "btn big", onclick: () => ctx.go("review") }, `Review ${p.candidates.length} ideas →`) : null,
        startBtn)), jobBox));
  drawEta();
  drawProvider();

  let watcher;
  async function start(more) {
    if (params.provider === "anthropic" && !prov.anthropic.configured) { toast("Add your Anthropic API key first (Settings).", "error"); return; }
    if (params.max_dur <= params.min_dur) { toast("The longest clip must be longer than the shortest clip.", "error"); return; }
    startBtn.disabled = true;
    try {
      const job = await api(`/api/projects/${p.id}/discover`, { json: { ...params, more } });
      ctx.kickTasks();
      follow(job.id);
    } catch (e) { startBtn.disabled = false; jobBox.innerHTML = ""; jobBox.append(errorBox(e.message)); }
  }

  function follow(id) {
    const cancelBtn = h("button", { class: "btn small ghost", onclick: () => api(`/api/jobs/${id}/cancel`, { method: "POST" }) }, "Cancel");
    watcher = watchJob(id, (j) => {
      jobBox.innerHTML = "";
      jobBox.append(progressBar(j.progress, j.status === "queued" ? "Waiting for another task to finish…" : j.message), cancelBtn);
    });
    watcher.then(async (j) => {
      await ctx.refresh();
      const r = j.result || {};
      toast(r.cached ? "Loaded saved suggestions." : `${r.added ?? "New"} clip ideas found.`, "ok");
      ctx.go("review");
    }).catch((e) => {
      startBtn.disabled = false;
      jobBox.innerHTML = "";
      if (!e.cancelled) jobBox.append(errorBox(e.message, () => start(false)));
      else jobBox.append(h("div", { class: "alert warn" }, "Cancelled. Already finished work (e.g. the transcript) is kept."));
    });
  }

  // re-attach to an analysis that is still running (e.g. after a page refresh)
  const running = (p.jobs || []).find((j) => j.kind === "discover" && (j.status === "running" || j.status === "queued"));
  if (running) { startBtn.disabled = true; follow(running.id); }
  return () => watcher?.stop();
}
