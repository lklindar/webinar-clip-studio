// Step 3 (AI tab): transcribe + let an AI suggest the clips with the best social-media potential.
import { api, watchJob } from "../api.js";
import { h, toast, progressBar, errorBox, fmtDur, select } from "../ui.js";
import { openSettings } from "../app.js";

const LENGTHS = [
  ["40-60", "Up to 60 seconds (40–60 s)"],
  ["60-90", "60 to 90 seconds"],
];
const PREF_KEY = "wcs.aiPrefs";

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ provider: p.provider, length: p.length, count: p.count })); } catch { /* ignore */ }
}

export async function render(main, ctx, { embedded = false } = {}) {
  const sys = await ctx.diskInfo();
  const p = ctx.state.project;
  const s = sys.settings;
  const audioSrc = p.sources[p.sync.audio];
  const prefs = loadPrefs();
  const params = {
    provider: prefs.provider || "chat", length: LENGTHS.some(([v]) => v === prefs.length) ? prefs.length : "40-60", count: prefs.count || 8,
    language: "en", whisper_model: s.whisper_model,
  };
  const range = () => params.length.split("-").map(Number);
  const jobBox = h("div");
  if (!embedded) main.append(h("div", { class: "page-head" }, h("div", {},
    h("h1", {}, "3. Discover clip ideas"),
    h("p", {}, "Let an AI read the whole webinar and pick the moments with the best potential for TikTok, Reels and Shorts."))));

  const prov = sys.ai;
  const providerCard = h("div", { class: "card" });
  const actionCard = h("div", { class: "card", style: { marginTop: "18px" } });

  // ---------------------------------------------------------------- transcription
  const tr = () => ctx.state.project.transcript;
  const fullTranscript = () => tr() && tr().mode !== "segments";
  const est = audioSrc ? audioSrc.duration : 0;
  const speed = { tiny: 0.04, base: 0.08, small: 0.2, medium: 0.6 };
  const trCard = h("div", { class: "card" });
  const drawTr = () => {
    trCard.innerHTML = "";
    const t = tr();
    trCard.append(h("h3", {}, "1 · Transcript (made on your Mac)"),
      fullTranscript() ? h("div", { class: "alert ok" }, `Ready: ${t.words_count.toLocaleString()} words, language “${t.language}”, model “${t.model}”. Saved and reused.`)
        : h("p", { class: "small" }, t?.mode === "segments" ? "Only your hand-picked minutes are transcribed so far. The AI needs the whole webinar." : `Audio: ${p.sync.audio} recording (${fmtDur(est)}).`),
      select("Speech model", params.whisper_model, Object.entries(sys.whisper_models).map(([k, d]) => [k, `${k} — ${d}`]), (v) => { params.whisper_model = v; drawTr(); }),
      h("p", { class: "small muted" }, fullTranscript() && t.model === params.whisper_model ? "No waiting needed." :
        `Transcribing the whole webinar takes about ${fmtDur(Math.max(20, est * speed[params.whisper_model]))} on this Mac.`));
  };

  // ---------------------------------------------------------------- preferences
  const prefCard = h("div", { class: "card" },
    h("h3", {}, "2 · What you want"),
    select("Clip length", params.length, LENGTHS, (v) => { params.length = v; savePrefs(params); }),
    select("Number of ideas", String(params.count), [["3", "3"], ["5", "5"], ["8", "8"], ["10", "10"], ["15", "15"]], (v) => { params.count = +v; savePrefs(params); }),
    h("p", { class: "small muted" }, "Titles, hooks and captions are written in English."));

  // ---------------------------------------------------------------- provider choice
  function drawProvider() {
    providerCard.innerHTML = "";
    providerCard.append(h("h3", {}, "How the clips are chosen"),
      h("div", { class: "seg-ctl", style: { marginBottom: "10px", flexWrap: "wrap" } }, [
        ["chat", "✨ Your AI chat (free)"], ["anthropic", "Claude (built in)"], ["heuristic", "Offline rules"], ["local", "Local AI"],
      ].map(([v, l]) => h("button", { class: params.provider === v ? "on" : "", onclick: () => { params.provider = v; savePrefs(params); drawProvider(); drawAction(); } }, l))));
    if (params.provider === "chat") {
      providerCard.append(h("div", { class: "alert ok" },
        h("b", {}, "Recommended. "), "Use Gemini, ChatGPT or Claude.ai — whichever you like. The app writes a ready-made request that includes the whole transcript; ",
        "you paste it into the AI chat and paste the answer back. Free, no API key. Like asking Gemini about the video, the AI reads the whole webinar."),
        h("p", { class: "small muted" }, "Privacy: you decide what you paste — only the transcript text goes to that AI service, never the video."));
    } else if (params.provider === "anthropic") {
      if (!prov.anthropic.configured) {
        providerCard.append(h("div", { class: "alert warn" }, "Needs an Anthropic API key (about $0.10–0.25 per hour of webinar). Or use “Your AI chat” for free."),
          h("button", { class: "btn small primary", onclick: () => openSettings(() => location.reload()) }, "Add API key"));
      } else {
        const estBox = h("div", { class: "small" });
        providerCard.append(h("div", { class: "alert info" }, `Claude (${prov.anthropic.model}) reads the whole webinar at once and returns titles, hooks, captions and editing tips. Only the transcript text is sent to Anthropic.`), estBox);
        api(`/api/projects/${p.id}/estimate`).then((e) => { estBox.textContent = `Estimated cost: about $${Math.max(0.01, e.usd).toFixed(2)}, billed to your Anthropic account.`; }).catch(() => {});
      }
    } else if (params.provider === "heuristic") {
      providerCard.append(h("div", { class: "alert warn" },
        "Offline rules only spot patterns (questions, numbers, “the biggest mistake…”). They don't understand meaning and can't write titles or captions — use an AI option for results like Gemini's."));
    } else {
      providerCard.append(h("div", { class: "alert info" }, `Uses ${prov.local.base_url}. Free and private, but small local models on 8 GB of memory give weak suggestions.`),
        h("button", { class: "btn small", onclick: () => openSettings(() => location.reload()) }, "Local AI settings"));
    }
  }

  // ---------------------------------------------------------------- actions
  let watcher;
  function drawAction() {
    actionCard.innerHTML = "";
    jobBox.innerHTML = "";
    const reviewBtn = ctx.state.project.candidates.length ? h("button", { class: "btn", onclick: () => ctx.go("review") }, `Review ${ctx.state.project.candidates.length} ideas →`) : null;
    if (params.provider !== "chat") {
      const startBtn = h("button", { class: "btn primary big", onclick: () => start(false, startBtn) }, fullTranscript() ? "Find clips" : "Transcribe & find clips");
      actionCard.append(h("div", { class: "row between" },
        h("div", {}, h("h3", {}, "3 · Run"), h("p", { class: "small muted" }, "You can leave this page; the work continues in the background.")),
        h("div", { class: "row" }, reviewBtn, startBtn)), jobBox);
      return;
    }
    // --- Your AI chat: transcript -> copy prompt -> paste answer
    if (!fullTranscript()) {
      const tBtn = h("button", { class: "btn primary big", onclick: () => transcribe(tBtn) }, "Transcribe the webinar");
      actionCard.append(h("div", { class: "row between" },
        h("div", {}, h("h3", {}, "3 · First, transcribe the whole webinar"), h("p", { class: "small muted" }, "The AI needs the transcript. This runs on your Mac.")),
        h("div", { class: "row" }, reviewBtn, tBtn)), jobBox);
      return;
    }
    const more = h("input", { type: "checkbox" });
    try { if (localStorage.getItem("wcs.askMore")) { more.checked = true; localStorage.removeItem("wcs.askMore"); } } catch { /* ignore */ }
    const status = h("span", { class: "small muted" });
    const answer = h("textarea", { rows: 8, placeholder: "Paste the AI's whole answer here (it starts with ```json or {) …",
      style: { width: "100%", border: "1px solid var(--line)", borderRadius: "8px", padding: "8px", fontFamily: "ui-monospace, Menlo, monospace", fontSize: "12px" } });
    const aiName = h("select", { class: "inline" }, ["Gemini", "ChatGPT", "Claude.ai", "Other AI"].map((n) => h("option", { value: n }, n)));
    const getPrompt = async () => {
      const [min_dur, max_dur] = range();
      return api(`/api/projects/${p.id}/ai-prompt`, { json: { min_dur, max_dur, count: params.count, language: params.language, more: more.checked } });
    };
    const copyBtn = h("button", { class: "btn primary", onclick: async () => {
      try {
        const r = await getPrompt();
        try { await navigator.clipboard.writeText(r.prompt); }
        catch { const ta = h("textarea", {}, r.prompt); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
        status.textContent = `✓ Copied (${Math.round(r.chars / 1000)}k characters, ${r.sentences} sentences). Now paste it into your AI chat.`;
        status.style.color = "var(--ok)";
      } catch (e) { toast(e.message, "error"); }
    } }, "📋 Copy the request");
    const dlBtn = h("button", { class: "btn", onclick: async () => {
      try {
        const r = await getPrompt();
        const a = h("a", { href: URL.createObjectURL(new Blob([r.prompt], { type: "text/plain" })), download: `${p.name.replace(/[^\w-]+/g, "-")}-clip-request.txt` });
        document.body.append(a); a.click(); a.remove();
      } catch (e) { toast(e.message, "error"); }
    } }, "⬇ Save as .txt");
    const importBtn = h("button", { class: "btn primary big", onclick: async () => {
      if (!answer.value.trim()) { toast("Paste the AI's answer first.", "error"); return; }
      importBtn.disabled = true;
      try {
        const [min_dur, max_dur] = range();
        const r = await api(`/api/projects/${p.id}/ai-import`, { json: { text: answer.value, min_dur, max_dur, more: more.checked, ai_name: aiName.value } });
        if (r.received < params.count) toast(`${aiName.value} sent only ${r.received} of the ${params.count} clips you asked for. To get more: tick “Add to my current ideas”, copy the request again and paste it into a new ${aiName.value} chat.`, "info", 12000);
        toast(`${r.added} clip ideas from ${aiName.value}${r.skipped ? ` (${r.skipped} skipped: sentence numbers not in this transcript, or already in your list)` : ""}.`, "ok", 7000);
        await ctx.refresh();
        ctx.go("review");
      } catch (e) { importBtn.disabled = false; jobBox.innerHTML = ""; jobBox.append(errorBox(e.message)); }
    } }, "Create clip ideas →");
    actionCard.append(
      h("div", { class: "row between" }, h("h3", {}, "3 · Ask your AI chat"), reviewBtn),
      h("ol", { style: { paddingLeft: "20px", margin: "6px 0 12px" } },
        h("li", { style: { marginBottom: "8px" } }, h("b", {}, "Copy the request "), "(it already contains the whole transcript). ",
          h("div", { class: "row", style: { marginTop: "6px" } }, copyBtn, dlBtn, status)),
        h("li", { style: { marginBottom: "8px" } }, h("b", {}, "Paste it into your AI chat "), "and send it. ",
          h("a", { href: "https://gemini.google.com/app", target: "_blank", rel: "noopener" }, "Open Gemini"), " · ",
          h("a", { href: "https://chatgpt.com", target: "_blank", rel: "noopener" }, "ChatGPT"), " · ",
          h("a", { href: "https://claude.ai/new", target: "_blank", rel: "noopener" }, "Claude.ai"),
          h("div", { class: "small muted" }, "Tip: if the chat says the text is too long, attach the saved .txt file instead and write “follow the instructions in this file”.")),
        h("li", {}, h("b", {}, "Copy the AI's whole answer and paste it here:"),
          answer,
          h("div", { class: "row between", style: { marginTop: "8px" } },
            h("div", { class: "row" }, h("span", { class: "small" }, "Answer from"), aiName,
              h("label", { class: "check", style: { margin: "0 0 0 10px" } }, more, "Add to my current ideas (ask for different moments)")),
            importBtn))),
      jobBox);
  }

  async function transcribe(btn) {
    btn.disabled = true;
    try {
      const job = await api(`/api/projects/${p.id}/discover`, { json: { transcribe_only: true, whisper_model: params.whisper_model } });
      ctx.kickTasks();
      follow(job.id, async () => { await ctx.refresh(); drawTr(); drawAction(); toast("Transcript ready. Now copy the request.", "ok"); });
    } catch (e) { btn.disabled = false; jobBox.innerHTML = ""; jobBox.append(errorBox(e.message)); }
  }

  async function start(more, btn) {
    if (params.provider === "anthropic" && !prov.anthropic.configured) { toast("Add your Anthropic API key first (Settings).", "error"); return; }
    btn.disabled = true;
    const [min_dur, max_dur] = range();
    try {
      const job = await api(`/api/projects/${p.id}/discover`, { json: { ...params, min_dur, max_dur, more } });
      ctx.kickTasks();
      follow(job.id, async (j) => {
        await ctx.refresh();
        const r = j.result || {};
        toast(r.cached ? "Loaded saved suggestions." : `${r.added ?? "New"} clip ideas found.`, "ok");
        ctx.go("review");
      }, () => { btn.disabled = false; });
    } catch (e) { btn.disabled = false; jobBox.innerHTML = ""; jobBox.append(errorBox(e.message)); }
  }

  function follow(id, onDone, onFail) {
    const cancelBtn = h("button", { class: "btn small ghost", onclick: () => api(`/api/jobs/${id}/cancel`, { method: "POST" }) }, "Cancel");
    watcher = watchJob(id, (j) => {
      jobBox.innerHTML = "";
      jobBox.append(progressBar(j.progress, j.status === "queued" ? "Waiting for another task to finish…" : j.message), cancelBtn);
    });
    watcher.then(onDone).catch((e) => {
      onFail?.();
      jobBox.innerHTML = "";
      if (!e.cancelled) jobBox.append(errorBox(e.message));
      else jobBox.append(h("div", { class: "alert warn" }, "Cancelled. Already finished work (e.g. the transcript) is kept."));
      drawAction();
    });
  }

  main.append(h("div", { class: "grid2" }, h("div", { class: "stack" }, trCard, prefCard), providerCard), actionCard);
  drawTr();
  drawProvider();
  drawAction();
  // re-attach to work that is still running (e.g. after a page refresh)
  const running = (p.jobs || []).find((j) => j.kind === "discover" && (j.status === "running" || j.status === "queued"));
  if (running) follow(running.id, async () => { await ctx.refresh(); drawTr(); drawAction(); });
  return () => watcher?.stop();
}
