// Step 2: align the two recordings in time.
import { api, watchJob } from "../api.js";
import { h, toast, fmtTime, progressBar, errorBox } from "../ui.js";

export async function render(main, ctx) {
  const p = ctx.state.project;
  const spk = p.sources.speaker, pres = p.sources.presentation;
  main.append(h("div", { class: "page-head" }, h("div", {},
    h("h1", {}, "2. Synchronize the recordings"),
    h("p", {}, "The two recordings may have started at different moments. Set the offset so that the slides change exactly when the speaker talks about them. ",
      "Play both below and compare — or let the app find the offset from the audio."))));
  if (!spk || !pres) {
    main.append(h("div", { class: "alert info" }, "Only one recording was added, so there is nothing to synchronize."),
      audioCard(), h("div", { class: "row end" }, h("button", { class: "btn primary big", onclick: () => ctx.go("analyze") }, "Next: Choose clips →")));
    return;
  }
  const vS = h("video", { src: `/api/projects/${p.id}/media/speaker?v=${spk.fp}`, preload: "auto", playsinline: true });
  const vP = h("video", { src: `/api/projects/${p.id}/media/presentation?v=${pres.fp}`, preload: "auto", playsinline: true, muted: true });
  vP.muted = true;
  let offset = p.sync.offset;
  let playing = false, raf;
  const maxT = Math.max(spk.duration, pres.duration - offset);
  const scrub = h("input", { type: "range", min: 0, max: spk.duration.toFixed(1), step: 0.1, value: 0, class: "scrub" });
  const tEl = h("span", { class: "time" });
  const offIn = h("input", { class: "inline", value: offset.toFixed(2), type: "number", step: 0.05 });
  const autoBox = h("div");
  const status = h("div", { class: "small muted" });

  const seekBoth = (t) => {
    vS.currentTime = Math.max(0, t);
    const pt = t + offset;
    vP.currentTime = Math.max(0, Math.min(pres.duration - 0.05, pt));
    vP.style.opacity = pt < 0 || pt > pres.duration ? 0.25 : 1;
    tEl.textContent = `Speaker ${fmtTime(t)}  ·  Slides ${fmtTime(pt)}`;
  };
  const loop = () => {
    if (!playing) return;
    const t = vS.currentTime;
    const want = t + offset;
    if (want >= 0 && want <= pres.duration) {
      if (vP.paused) { vP.currentTime = want; vP.play().catch(() => {}); }
      else if (Math.abs(vP.currentTime - want) > 0.2) vP.currentTime = want;
      vP.style.opacity = 1;
    } else { vP.pause(); vP.style.opacity = 0.25; }
    scrub.value = t.toFixed(1);
    tEl.textContent = `Speaker ${fmtTime(t)}  ·  Slides ${fmtTime(want)}`;
    raf = requestAnimationFrame(loop);
  };
  const playBtn = h("button", { class: "btn play-btn", onclick: () => {
    playing = !playing;
    playBtn.textContent = playing ? "❚❚" : "▶";
    if (playing) { seekBoth(Number(scrub.value)); vS.play(); raf = requestAnimationFrame(loop); }
    else { vS.pause(); vP.pause(); cancelAnimationFrame(raf); }
  } }, "▶");
  scrub.addEventListener("input", () => seekBoth(Number(scrub.value)));

  const save = async (v) => {
    offset = Math.round(v * 1000) / 1000;
    offIn.value = offset.toFixed(2);
    seekBoth(Number(scrub.value));
    try {
      ctx.state.project = await api(`/api/projects/${p.id}`, { method: "PATCH", json: { sync: { offset } } });
      status.textContent = "Saved.";
    } catch (e) { toast(e.message, "error"); }
    explain();
  };
  offIn.addEventListener("change", () => save(Number(offIn.value) || 0));
  const nudge = (d) => h("button", { class: "btn small", onclick: () => save(offset + d) }, (d > 0 ? "+" : "−") + Math.abs(d) + " s");
  const expl = h("p", { class: "small" });
  const explain = () => {
    expl.textContent = offset === 0 ? "Both recordings start at the same moment." :
      offset > 0 ? `The presentation recording started ${offset.toFixed(2)} s before the speaker recording.` :
        `The presentation recording started ${(-offset).toFixed(2)} s after the speaker recording.`;
  };
  explain();

  // jump to the first slide change for easy checking
  const jumps = (p.slides_master || []).filter((t) => t > 1).slice(0, 8);

  async function runAuto() {
    autoBox.innerHTML = "";
    try {
      const job = await api(`/api/projects/${p.id}/sync/auto`, { method: "POST" });
      ctx.kickTasks();
      const done = await watchJob(job.id, (j) => { autoBox.innerHTML = ""; autoBox.append(progressBar(j.progress, j.message)); });
      const r = done.result;
      autoBox.innerHTML = "";
      if (r.confidence === "low") {
        autoBox.append(h("div", { class: "alert warn" }, `The audio match is uncertain (best guess ${r.offset.toFixed(2)} s). The offset was not changed. `,
          h("button", { class: "btn small", onclick: () => save(r.offset) }, "Use it anyway")));
      } else {
        autoBox.append(h("div", { class: "alert ok" }, `Found offset ${r.offset > 0 ? "+" : ""}${r.offset.toFixed(2)} s (${r.confidence} confidence). Please check it with the players.`));
        await save(r.offset);
      }
    } catch (e) { autoBox.innerHTML = ""; autoBox.append(errorBox(e.message)); }
  }

  const canAuto = spk.has_audio && pres.has_audio;
  main.append(
    h("div", { class: "card section" },
      h("div", { class: "sync-videos" },
        h("div", {}, h("h4", {}, "🎤 Speaker"), vS),
        h("div", {}, h("h4", {}, "🖥️ Presentation (shifted by the offset)"), vP)),
      h("div", { class: "player-controls" }, playBtn, scrub, tEl),
      jumps.length ? h("div", { class: "row small", style: { marginTop: "8px" } }, h("span", { class: "muted" }, "Jump to a slide change:"),
        jumps.map((t) => h("button", { class: "btn small ghost", onclick: () => { scrub.value = Math.max(0, t - 2); seekBoth(Math.max(0, t - 2)); } }, fmtTime(t, 0)))) : null),
    h("div", { class: "grid2" },
      h("div", { class: "card" },
        h("h3", {}, "Offset"),
        h("div", { class: "offset-box" }, nudge(-1), nudge(-0.1), offIn, h("span", {}, "seconds"), nudge(0.1), nudge(1)),
        expl, status,
        h("p", { class: "small muted" }, "Tip: find a moment where the speaker says “next slide” and adjust until the slide changes right then.")),
      h("div", { class: "card" },
        h("h3", {}, "Automatic sync"),
        canAuto ? h("p", { class: "small" }, "Compares the sound of both recordings (works when the screen recording also captured the audio).")
          : h("p", { class: "small muted" }, "Not available: one of the recordings has no audio. Please align manually."),
        h("button", { class: "btn", disabled: !canAuto, onclick: runAuto }, "Detect offset from audio"),
        p.sync.auto ? h("p", { class: "small muted" }, `Last detection: ${p.sync.auto.offset.toFixed(2)} s, ${p.sync.auto.confidence} confidence.`) : null,
        autoBox)),
    audioCard(),
    h("div", { class: "row end", style: { marginTop: "16px" } }, h("button", { class: "btn primary big", onclick: () => ctx.go("analyze") }, "Next: Choose clips →")));

  function audioCard() {
    const pp = ctx.state.project;
    const opts = ["speaker", "presentation"].filter((r) => pp.sources[r]);
    return h("div", { class: "card", style: { marginTop: "18px" } },
      h("h3", {}, "Which audio should the clips use?"),
      h("p", { class: "small muted" }, "This audio is transcribed and used in the exported clips. Usually the speaker camera has the best microphone."),
      h("div", { class: "seg-ctl" }, opts.map((r) => h("button", {
        class: pp.sync.audio === r ? "on" : "", disabled: !pp.sources[r].has_audio,
        onclick: async (e) => {
          try {
            ctx.state.project = await api(`/api/projects/${pp.id}`, { method: "PATCH", json: { sync: { audio: r } } });
            e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target));
            toast("Audio source changed. Transcription will be redone for this audio when you analyse.");
          } catch (err) { toast(err.message, "error"); }
        } }, r === "speaker" ? "🎤 Speaker audio" : "🖥️ Presentation audio" + (pp.sources[r].has_audio ? "" : " (none)")))));
  }

  vS.addEventListener("loadeddata", () => seekBoth(Number(scrub.value)), { once: true });
  vP.addEventListener("loadeddata", () => seekBoth(Number(scrub.value)), { once: true });
  return () => { playing = false; cancelAnimationFrame(raf); vS.pause(); vP.pause(); };
}
