// "Suggestions for this clip": detects static screen-recording stretches and proposes
// (A) zooming into different content areas of your own slides, or
// (B) illustration cards made from what the speaker says at that moment.
import { api } from "../api.js";
import { h, toast, fmtTime } from "../ui.js";
import { segmentAt, insertPart } from "../compose.js";
import { cardFromSpeech, drawCard, ensureCardFonts, CARD_THEMES } from "../visuals.js";

const STATIC_SCORE = 0.006;   // scene-change score below this = picture basically unchanged
const MIN_STATIC = 8;         // seconds

export const TIPS = [
  "Change the slide (or reveal a new bullet/animation) every 15–30 seconds while you talk — each change gives the edit a natural visual beat.",
  "Use slide builds: show one point at a time instead of the whole whiteboard at once.",
  "Zoom in your screen-sharing app (or use a pointer/highlighter) on the part you are talking about — movement on screen keeps viewers watching.",
  "Put one big keyword or number on each slide; small dense text is unreadable on a phone.",
  "Keep a short list of moments you plan to clip and show a matching visual (photo, diagram, demo) exactly then.",
  "Record the screen at 1080p with a clean background; hide toolbars, notifications and the participant gallery.",
  "Look into the camera and use hand gestures on key lines — speaker close-ups then feel lively even when slides are static.",
  "If a section has no visuals at all, the app's illustration cards (option B) can fill it — but planning a real visual is always stronger.",
];

export function staticStretches(samples, dur) {
  const changes = [0, ...samples.filter(([, s]) => s > STATIC_SCORE).map(([t]) => t), dur];
  const out = [];
  for (let i = 1; i < changes.length; i++) {
    if (changes[i] - changes[i - 1] >= MIN_STATIC) out.push([changes[i - 1], changes[i]]);
  }
  return out;
}

export function sentencesIn(words, clip) {
  const ws = (words || []).filter((w) => w.end > clip.start && w.start < clip.end)
    .map((w) => ({ text: w.text, s: w.start - clip.start, e: w.end - clip.start }));
  const out = [];
  let cur = [];
  ws.forEach((w, i) => {
    cur.push(w);
    const gap = ws[i + 1] ? ws[i + 1].s - w.e : 9;
    // phrase ends at a full stop, a comma or pause after a few words, or when it gets long
    if (/[.!?]$/.test(w.text) || (/[,;:]$/.test(w.text) && cur.length >= 5) || (gap > 0.45 && cur.length >= 4) || cur.length >= 16) {
      out.push(cur); cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out.map((c) => ({ a: c[0].s, b: c[c.length - 1].e, text: c.map((w) => w.text).join(" ") }));
}

function cardScore(sent, card) {
  let sc = 0;
  if (card.kind === "stat") sc += 4;
  if (card.kind === "question") sc += 3;
  if (card.kind === "list") sc += 2.5;
  if (card.icon && card.icon !== "💡") sc += 2;
  const d = sent.b - sent.a;
  if (d >= 2.5 && d <= 6.5) sc += 2;
  const t = sent.text.trim().toLowerCase();
  if (/^(of|the|and|but|so|or|that|to|for|with|you know|um|uh|like|it|is)\b/.test(t)) sc -= 3;   // starts mid-thought
  if (/[.!?]$/.test(t)) sc += 1.5;                                                                // complete sentence
  if (/\b(you know|um|uh|the the)\b/.test(t)) sc -= 1.5;
  return sc;
}

export function previewCanvas(card, w = 240, ht = 213) {
  const c = h("canvas", { width: w * 2, height: ht * 2, style: { width: `${w}px`, height: `${ht}px`, borderRadius: "10px", display: "block" } });
  ensureCardFonts().then(() => drawCard(c.getContext("2d"), { x: 0, y: 0, w: w * 2, h: ht * 2 }, card, 1));
  return c;
}

export function suggestionsPanel(ctx, clip, { onApply }) {
  const p = ctx.state.project;
  const box = h("div", { class: "card", style: { borderColor: "#f9c6dd", background: "#fffafc" } });
  const body = h("div");
  box.append(
    h("div", { class: "row between" }, h("h3", {}, "💡 Suggestions for this clip"),
      h("button", { class: "btn small primary", onclick: () => run() }, "Analyse this clip")),
    h("p", { class: "small muted" }, "Checks whether the screen recording actually changes during this clip, and suggests how to keep it visually interesting."),
    body);

  async function run() {
    body.innerHTML = "";
    body.append(h("p", { class: "small" }, "Analysing the screen recording…"));
    const dur = clip.end - clip.start;
    let act = { samples: [], regions: [] };
    try { act = await api(`/api/projects/${p.id}/activity?start=${clip.start}&end=${clip.end}`); }
    catch (e) { body.innerHTML = ""; body.append(h("div", { class: "alert error" }, e.message)); return; }
    const tr = await ctx.transcript();
    const stretches = p.sources.presentation ? staticStretches(act.samples, dur) : [];
    const staticSecs = stretches.reduce((a, [x, y]) => a + (y - x), 0);
    const lens = clip.segments.map((s, i) => (i + 1 < clip.segments.length ? clip.segments[i + 1].t : dur) - s.t);
    body.innerHTML = "";

    // ---- summary
    const pct = Math.round((staticSecs / dur) * 100);
    body.append(h("div", { class: pct > 50 ? "alert warn" : "alert ok" },
      !p.sources.presentation ? "No screen recording in this project — suggestions use illustration cards only." :
        pct > 0 ? `The screen recording is static for ${Math.round(staticSecs)} of ${Math.round(dur)} seconds (${pct}%) in this clip` +
          ` (${stretches.map(([a, b]) => `${fmtTime(a, 0)}–${fmtTime(b, 0)}`).join(", ")}). Moving effects help, but the content shown stays the same.` :
          "The screen recording changes regularly in this clip — good material. The suggestions below are optional.",
      h("div", { class: "small", style: { marginTop: "4px" } }, `Layout parts: ${clip.segments.length}, longest without a change: ${Math.max(...lens).toFixed(1)} s.`)));

    // ---- option A: zoom into content regions of your own slides
    const regions = act.regions || [];
    if (p.sources.presentation && regions.length) {
      const frameT = clip.start + dur / 2;
      const img = `/api/projects/${p.id}/frame/presentation?t=${frameT}&w=640`;
      const thumbs = regions.map((r, i) => {
        const wFrac = 1 / r.zoom;
        return h("div", { style: { flex: "1", minWidth: "150px" } },
          h("div", { style: { position: "relative", borderRadius: "8px", overflow: "hidden", aspectRatio: "16/9", background: "#000" } },
            h("img", { src: img, style: { width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: "0.45" } }),
            h("div", { style: { position: "absolute", top: "0", bottom: "0", left: `${Math.max(0, r.x - wFrac / 2) * 100}%`, width: `${wFrac * 100}%`,
              backgroundImage: `url(${img})`, backgroundSize: `${100 / wFrac}% 100%`, backgroundPosition: `${(Math.max(0, r.x - wFrac / 2) / (1 - wFrac)) * 100}% 0`,
              outline: "3px solid #ec4899" } })),
          h("div", { class: "small", style: { marginTop: "4px" } }, `${i + 1}. ${r.label}`));
      });
      body.append(h("div", { class: "card flat", style: { marginTop: "10px" } },
        h("h4", {}, "A · Use your slides, but show different parts"),
        h("p", { class: "small" }, "Each time the slides are on screen, the camera moves to a different area with content (highlighted below), instead of always showing the whole slide. Uses only what you uploaded."),
        h("div", { class: "row", style: { alignItems: "flex-start" } }, thumbs),
        h("button", { class: "btn small primary", style: { marginTop: "8px" }, onclick: () => applyFocus(regions, stretches) }, "Apply: zoom into these areas")));
    }

    // ---- option B: illustration cards from what is said
    const sents = sentencesIn(tr?.words, clip);
    const inStatic = (s) => !p.sources.presentation || stretches.some(([a, b]) => s.a >= a - 0.5 && s.b <= b + 0.5);
    const scored = sents.filter((s) => s.b - s.a >= 1.8 && s.a > 1 && s.b < dur - 1 && inStatic(s))
      .map((s, i) => ({ s, card: cardFromSpeech(s.text, Object.keys(CARD_THEMES)[i % 3]) }))
      .map((x) => ({ ...x, score: cardScore(x.s, x.card) }))
      .sort((a, b) => b.score - a.score);
    const picked = [];
    const maxCards = Math.max(1, Math.round(dur / 14));
    for (const x of scored) {
      if (picked.length >= maxCards) break;
      if (picked.some((y) => Math.abs(y.s.a - x.s.a) < 9)) continue;
      picked.push(x);
    }
    picked.sort((a, b) => a.s.a - b.s.a);
    const cardsBox = h("div", { class: "stack" });
    if (!tr) cardsBox.append(h("p", { class: "small muted" }, "Subtitles are still being prepared — card ideas need the words. Try again in a moment."));
    else if (!picked.length) cardsBox.append(h("p", { class: "small muted" }, "No good moments for cards found in the static parts."));
    for (const x of picked) {
      const added = () => clip.segments.some((sg) => sg.layout === "visual" && Math.abs(sg.t - Math.max(0, x.s.a - 0.1)) < 0.3);
      const btn = h("button", { class: "btn small", onclick: () => { addCard(x); btn.textContent = "✓ Added"; btn.disabled = true; } }, added() ? "✓ Added" : "Add this card");
      btn.disabled = added();
      cardsBox.append(h("div", { class: "row", style: { alignItems: "flex-start", borderTop: "1px solid var(--line)", paddingTop: "10px" } },
        previewCanvas(x.card),
        h("div", { style: { flex: "1", minWidth: "200px" } },
          h("div", {}, h("span", { class: "chip accent" }, `${fmtTime(x.s.a)} – ${fmtTime(x.s.b)}`), " ", h("span", { class: "chip" }, x.card.kind)),
          h("p", { class: "small", style: { margin: "6px 0" } }, h("b", {}, "He says: "), `“${x.s.text}”`),
          h("p", { class: "small muted" }, "Shown above the speaker instead of the static slide, while he says this line. Text and icon can be edited after adding."),
          btn)));
    }
    body.append(h("div", { class: "card flat", style: { marginTop: "10px" } },
      h("div", { class: "row between" }, h("h4", {}, "B · Illustration cards made from what he says"),
        picked.length > 1 ? h("button", { class: "btn small primary", onclick: () => { picked.forEach(addCard); run(); } }, `Add all ${picked.length}`) : null),
      h("p", { class: "small" }, "Designed cards (icon, keyword, number, question or quote) built from the speaker's own words at that moment — they replace the static slide for a few seconds. Nothing is invented."),
      cardsBox));

    // ---- tips for next recordings
    body.append(h("details", { class: "card flat", style: { marginTop: "10px" } },
      h("summary", { style: { cursor: "pointer", fontWeight: 700 } }, "📝 For your next recordings: avoiding static screens"),
      h("ul", { class: "small", style: { paddingLeft: "18px", marginBottom: 0 } }, TIPS.map((t) => h("li", { style: { marginBottom: "4px" } }, t)))));
  }

  function applyFocus(regions, stretches) {
    const dur = clip.end - clip.start;
    let k = 0, n = 0;
    clip.segments.forEach((sg, i) => {
      const en = i + 1 < clip.segments.length ? clip.segments[i + 1].t : dur;
      const mid = (sg.t + en) / 2;
      const isStatic = !stretches.length || stretches.some(([a, b]) => mid >= a && mid <= b);
      if (!isStatic || !["pres", "split", "pip"].includes(sg.layout)) return;
      const r = regions[k++ % regions.length];
      sg.focus = { x: r.x, y: r.y, zoom: sg.layout === "pip" ? 1.4 : r.zoom };
      if (sg.layout === "pres" && /^tour/.test(sg.motion || "")) sg.motion = "zoomIn";
      n++;
    });
    onApply(`Zoomed into ${n} slide part${n === 1 ? "" : "s"}, cycling through ${regions.length} areas.`);
  }

  function addCard(x) {
    const a = Math.max(0, x.s.a - 0.1), b = Math.min(clip.end - clip.start, x.s.b + 0.25);
    insertPart(clip, a, b, { layout: "visual", split: 0.5, motion: "zoomIn", motionTarget: "spk", card: { ...x.card } });
    onApply(`Card added at ${fmtTime(a)}.`);
  }

  return box;
}
