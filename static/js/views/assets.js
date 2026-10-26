// Your assets: upload images / short support videos, pick them for a layout part, and let the app
// decide where they fit in a clip (matched to what the speaker says, or filling static moments).
import { api } from "../api.js";
import { h, toast, fmtTime, fmtBytes, fmtDur, modal, confirmBox, progressBar } from "../ui.js";
import { insertPart, segmentAt } from "../compose.js";
import { sentencesIn, staticStretches } from "./suggest.js";

const STOP = new Set(("a an the and or but of to in on at for with from by as is are was were be this that these those it its " +
  "my our your their img image photo picture video clip final copy new v1 v2 jpg jpeg png mov mp4 screenshot screen shot " +
  "about into over very just").split(" "));

const assetUrl = (pid, a) => `/api/projects/${pid}/assets/${a.id}/file?p=${a.proxy || ""}`;
export const thumbUrl = (pid, a) => `/api/projects/${pid}/assets/${a.id}/thumb`;

function uploadOne(pid, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${pid}/assets`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d?.detail || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — is the app still running?"));
    const fd = new FormData();
    fd.append("file", file, file.name);
    xhr.send(fd);
  });
}

// ---------------------------------------------------------------- Upload page section
export function assetsSection(ctx) {
  const p = ctx.state.project;
  const box = h("div", { class: "card", style: { marginTop: "18px" } });
  const status = h("div");
  const draw = () => {
    const assets = ctx.state.project.assets || [];
    box.innerHTML = "";
    const fileIn = h("input", { type: "file", multiple: true, accept: "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mp4,.mov,.m4v,.jpg,.jpeg,.png,.webp",
      style: { display: "none" }, onchange: () => upload([...fileIn.files]) });
    const drop = h("div", { class: "drop", style: { padding: "18px" } },
      h("b", {}, "Drag images or short videos here"), " or ",
      h("button", { class: "btn small", onclick: () => fileIn.click() }, "Choose files"), fileIn,
      h("div", { class: "small muted", style: { marginTop: "6px" } }, "JPG, PNG, WebP images · MP4/MOV videos up to 1 GB. Give each a short description so the app knows where it fits."));
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files]); });
    box.append(
      h("h3", {}, "🖼️ Your assets ", h("span", { class: "muted small", style: { fontWeight: 500 } }, "(optional — photos, logos, diagrams, short demo videos, B-roll)")),
      drop, status,
      assets.length ? h("div", { class: "grid3", style: { marginTop: "12px" } }, assets.map((a) => assetCard(a))) : null);
  };
  const assetCard = (a) => {
    const desc = h("input", { class: "inline", value: a.description || "", placeholder: "What is it? e.g. “Ivy League campus”", style: { width: "100%" } });
    desc.addEventListener("change", async () => {
      try { Object.assign(a, await api(`/api/projects/${p.id}/assets/${a.id}`, { method: "PATCH", json: { description: desc.value } })); toast("Description saved", "ok", 1500); }
      catch (e) { toast(e.message, "error"); }
    });
    return h("div", { class: "card flat", style: { padding: "10px" } },
      h("div", { style: { position: "relative" } },
        h("img", { src: thumbUrl(p.id, a), style: { width: "100%", aspectRatio: "16/10", objectFit: "cover", borderRadius: "8px", background: "#111", display: "block" } }),
        h("span", { class: "chip", style: { position: "absolute", top: "6px", left: "6px" } }, a.kind === "video" ? `🎬 ${fmtDur(a.duration)}` : "🖼️ image")),
      h("div", { class: "small", style: { margin: "6px 0 4px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: a.name }, a.name),
      h("div", { class: "small muted" }, `${a.width}×${a.height} · ${fmtBytes(a.size)}${a.kind === "video" && !a.proxy ? " · preparing preview…" : ""}`),
      desc,
      h("div", { class: "row end", style: { marginTop: "6px" } },
        h("button", { class: "btn small ghost danger", onclick: async () => {
          const used = Object.values(ctx.state.project.clips).filter((c) => c.segments.some((s) => s.layout === "media" && s.asset?.id === a.id));
          if (!(await confirmBox("Delete asset?", used.length ? `It is used in ${used.length} clip(s); those parts will need another asset.` : "The file is removed from this project.", "Delete"))) return;
          await api(`/api/projects/${p.id}/assets/${a.id}`, { method: "DELETE" });
          await ctx.refresh(); draw();
        } }, "Delete")));
  };
  async function upload(files) {
    for (const [i, f] of files.entries()) {
      status.innerHTML = "";
      status.append(progressBar(0, `Uploading ${f.name} (${i + 1} of ${files.length})…`));
      try {
        await uploadOne(p.id, f, (x) => { status.innerHTML = ""; status.append(progressBar(x, `Uploading ${f.name} (${i + 1} of ${files.length})…`)); });
      } catch (e) { toast(`${f.name}: ${e.message}`, "error", 7000); }
    }
    status.innerHTML = "";
    ctx.kickTasks?.();
    await ctx.refresh();
    draw();
    if (files.length) toast("Assets added. Describe them so the app can place them well.", "ok");
  }
  draw();
  return box;
}

// ---------------------------------------------------------------- picker
export function pickAsset(ctx, current) {
  const p = ctx.state.project;
  const assets = p.assets || [];
  return new Promise((resolve) => {
    if (!assets.length) {
      modal("No assets yet", h("div", {}, h("p", {}, "Upload images or short videos in step 1 (Upload recordings → “Your assets”) first.")),
        [{ label: "Go to step 1", class: "btn primary", onClick: () => { resolve(null); ctx.go("upload"); } }, { label: "Close", class: "btn ghost", onClick: () => resolve(null) }]);
      return;
    }
    let m;
    const grid = h("div", { class: "grid3" }, assets.map((a) => h("div", {
      class: "card flat" + (a.id === current ? " sel-row" : ""), style: { padding: "8px", cursor: "pointer" },
      onclick: () => { m.close(); resolve(a); } },
    h("img", { src: thumbUrl(p.id, a), style: { width: "100%", aspectRatio: "16/10", objectFit: "cover", borderRadius: "8px", display: "block" } }),
    h("div", { class: "small", style: { fontWeight: 600, marginTop: "4px" } }, a.name),
    h("div", { class: "small muted" }, a.description || (a.kind === "video" ? `video · ${fmtDur(a.duration)}` : "image")))));
    m = modal("Choose an asset", grid, [{ label: "Cancel", class: "btn ghost", onClick: () => resolve(null) }]);
  });
}

// A good default placement for an asset (wide -> on top of the speaker, tall -> full screen)
export function mediaPart(a, hasSpk, uid) {
  const ar = a.width / a.height;
  const place = !hasSpk ? "full" : ar < 0.9 ? "full" : "top";
  return {
    layout: "media", uid: uid || Math.random().toString(36).slice(2, 10), split: 0.5,
    motion: "zoomIn", motionTarget: "auto",
    asset: { id: a.id, place, in: 0, fit: place === "full" && ar < 0.9 ? "fill" : "fit", zoom: 1, x: 0.5, y: 0.5 },
  };
}

// ---------------------------------------------------------------- "Place my assets"
const stem = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(ing|ed|es|s)$/, "");
function assetTerms(a) {
  const base = a.name.replace(/\.[a-z0-9]+$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return [...new Set(`${base} ${a.description || ""}`.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w)).map(stem))];
}

export function planAssets(ctx, clip, stretches) {
  const p = ctx.state.project;
  const assets = p.assets || [];
  const dur = clip.end - clip.start;
  const words = ctx.state.transcript?.words || [];
  const sents = sentencesIn(words, clip);
  const used = clip.segments.filter((s) => s.layout === "media" || s.layout === "visual").map((s, i, arr) => {
    const k = clip.segments.indexOf(s);
    return [s.t, k + 1 < clip.segments.length ? clip.segments[k + 1].t : dur];
  });
  const taken = [...used];
  const free = (a, b) => a >= 1.2 && b <= dur - 1.5 && !taken.some(([x, y]) => Math.min(b, y) - Math.max(a, x) > -2);
  const lenFor = (a, sentLen) => a.kind === "video" ? Math.max(2.5, Math.min(8, a.duration || 4, (sentLen || 4) + 2)) : Math.max(3, Math.min(6, (sentLen || 4) + 1));
  const plans = [];
  const unmatched = [];
  for (const a of assets) {
    const terms = assetTerms(a);
    let best = null;
    for (const s of sents) {
      const sw = new Set(s.text.split(/\s+/).map(stem));
      const hits = terms.filter((t) => sw.has(t));
      if (hits.length && (!best || hits.length > best.hits.length)) best = { s, hits };
    }
    if (best) {
      const L = lenFor(a, best.s.b - best.s.a);
      const st = Math.max(1.2, best.s.a - 0.2), en = Math.min(dur - 1.5, st + L);
      if (en - st >= 2 && free(st, en)) {
        plans.push({ asset: a, a: st, b: en, why: `He says “${best.hits.join("”, “")}” here: “${best.s.text.slice(0, 120)}”` });
        taken.push([st, en]);
        continue;
      }
    }
    unmatched.push(a);
  }
  // assets without a matching line: fill the most static moments (or spread them evenly)
  const gaps = (stretches.length ? stretches : [[0, dur]]).map(([x, y]) => [Math.max(1.2, x), Math.min(dur - 1.5, y)]).filter(([x, y]) => y - x > 3);
  for (const a of unmatched) {
    const L = lenFor(a, 4);
    let spot = null;
    for (const [x, y] of gaps.sort((g1, g2) => (g2[1] - g2[0]) - (g1[1] - g1[0]))) {
      // middle of the longest free stretch, snapped to a sentence start when possible
      for (let c = x + (y - x) / 2 - L / 2, k = 0; k < 12 && !spot; k++, c += (k % 2 ? 1 : -1) * k * 1.5) {
        const sn = sents.find((s) => Math.abs(s.a - c) < 1.2);
        const st = Math.max(x, sn ? sn.a - 0.1 : c), en = st + L;
        if (en <= y && free(st, en)) spot = [st, en];
      }
      if (spot) break;
    }
    if (spot) {
      plans.push({ asset: a, a: spot[0], b: spot[1], why: stretches.length ? "No matching words — it fills a static part of the screen recording." : "No matching words — placed where it doesn't overlap other visuals." });
      taken.push(spot);
    } else plans.push({ asset: a, a: null, b: null, why: "No free spot left in this clip (it is already full of visuals) — add it by hand if you want." });
  }
  return plans.sort((x, y) => (x.a ?? 1e9) - (y.a ?? 1e9));
}

export function assetsPanel(ctx, clip, { onApply }) {
  const p = ctx.state.project;
  const box = h("div", { class: "card", style: { borderColor: "#d9ccfb", background: "#fbf9ff" } });
  const body = h("div");
  box.append(
    h("div", { class: "row between" }, h("h3", {}, "🧩 Place my assets"),
      h("button", { class: "btn small primary", onclick: () => run() }, "Suggest where they go")),
    h("p", { class: "small muted" }, "The app matches each asset's name and description to what the speaker says; assets without a match fill static moments. Wide pictures go above the speaker, tall ones full screen."),
    body);

  async function run() {
    body.innerHTML = "";
    const assets = ctx.state.project.assets || [];
    if (!assets.length) {
      body.append(h("div", { class: "alert info" }, "No assets uploaded yet. ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); ctx.go("upload"); } }, "Add images or videos in step 1"), "."));
      return;
    }
    body.append(h("p", { class: "small" }, "Looking for the best moments…"));
    await ctx.transcript();
    let stretches = [];
    if (p.sources.presentation) {
      try {
        const act = await api(`/api/projects/${p.id}/activity?start=${clip.start}&end=${clip.end}`);
        stretches = staticStretches(act.samples, clip.end - clip.start);
      } catch { /* optional */ }
    }
    const plans = planAssets(ctx, clip, stretches);
    body.innerHTML = "";
    const placeable = plans.filter((x) => x.a != null);
    for (const x of plans) {
      const a = x.asset;
      const part = mediaPart(a, !!p.sources.speaker);
      const btn = h("button", { class: "btn small", disabled: x.a == null, onclick: () => { add(x, part); btn.textContent = "✓ Added"; btn.disabled = true; } }, "Add");
      body.append(h("div", { class: "row", style: { alignItems: "flex-start", borderTop: "1px solid var(--line)", paddingTop: "10px", marginTop: "8px" } },
        h("img", { src: thumbUrl(p.id, a), style: { width: "110px", aspectRatio: "16/10", objectFit: "cover", borderRadius: "8px" } }),
        h("div", { style: { flex: "1", minWidth: "200px" } },
          h("div", {}, h("b", { class: "small" }, a.name), " ",
            x.a != null ? h("span", { class: "chip accent" }, `${fmtTime(x.a)} – ${fmtTime(x.b)}`) : h("span", { class: "chip" }, "no spot"),
            " ", h("span", { class: "chip" }, part.asset.place === "top" ? "on top" : part.asset.place === "full" ? "full screen" : "card")),
          h("p", { class: "small", style: { margin: "4px 0" } }, x.why),
          btn)));
    }
    if (placeable.length > 1) body.prepend(h("div", { class: "row end" }, h("button", { class: "btn small primary", onclick: () => { placeable.forEach((x) => add(x, mediaPart(x.asset, !!p.sources.speaker))); run(); } }, `Add all ${placeable.length}`)));
  }

  function add(x, part) {
    insertPart(clip, x.a, x.b, part);
    onApply(`Placed “${x.asset.name}” at ${fmtTime(x.a)}.`);
  }
  return box;
}
