// Caption renderer shared by the live preview AND the export.
// Adapted from Subtitle Studio (copied, not linked). Additions: horizontal position,
// text alignment, webinar-friendly templates.
// Everything is sized relative to the video width, so it renders identically
// on a small preview canvas and on the full-resolution export canvas.

export const FONTS = {
  "Inter": [300, 500, 600, 700, 800],
  "Montserrat": [500, 800, 900],
  "Arimo": [500, 700],
  "Poppins": [600, 800],
  "Merriweather": [900],
  "Anton": [400],
  "Bebas Neue": [400],
  "DM Serif Display": [400],
};

export const ANIM_DURATION = 0.18; // seconds for pop / fade / rise in

// ---- Templates -----------------------------------------------------------
// karaoke: "none" | "reveal" (spoken = text colour, upcoming = dim)
//          "highlight" (current word in accent colour) | "build" (words appear one by one)
const base = {
  font: "Inter", weight: 600, sizePct: 4.5, uppercase: false, letterSpacing: 0,
  textColor: "#FFFFFF", accentColor: "#FFE600", upcomingColor: "#A6A6A6",
  karaoke: "none", activeBg: false,
  outlineWidth: 0, outlineColor: "#000000",
  shadow: 0, shadowColor: "#000000",
  box: "none", boxColor: "#000000", boxOpacity: 0.4, boxRadius: 0.12,
  posY: 0.72, posX: 0.5, align: "center", maxWords: 4, maxLines: 2, maxWidthPct: 0.84, lineHeight: 1.18,
  balance: false, anim: "none", stripPunct: false,
};

export const TEMPLATES = [
  { id: "clean", name: "Clean Karaoke", note: "Inspired by your FAFO reference: small, two-line, words light up",
    ...base, font: "Inter", weight: 600, sizePct: 4.2, karaoke: "reveal",
    textColor: "#FFFFFF", upcomingColor: "#A3A3A3", stripPunct: true,
    box: "line", boxColor: "#000000", boxOpacity: 0.55, boxRadius: 0,
    posY: 0.76, maxWords: 6, maxLines: 2, maxWidthPct: 0.7, balance: true, lineHeight: 1.22 },
  { id: "yellow", name: "Yellow Pop", note: "Inspired by your Minecraft reference: 1–3 yellow words that pop in",
    ...base, font: "Arimo", weight: 700, sizePct: 6.2, letterSpacing: -0.03,
    textColor: "#F1F23C", outlineWidth: 0.07, outlineColor: "#1C1C1C",
    shadow: 0.25, shadowColor: "#000000",
    posY: 0.5, maxWords: 3, maxLines: 2, maxWidthPct: 0.8, anim: "pop" },
  { id: "bold", name: "Bold Highlight", note: "Karaoke: the spoken word turns yellow",
    ...base, font: "Montserrat", weight: 900, sizePct: 7.0, uppercase: true,
    karaoke: "highlight", accentColor: "#FFE600",
    outlineWidth: 0.16, outlineColor: "#000000", shadow: 0.3,
    posY: 0.5, maxWords: 3, maxLines: 2, anim: "pop" },
  { id: "contrast", name: "High Contrast", note: "White on solid black box — readable on any slide",
    ...base, font: "Inter", weight: 800, sizePct: 5.4,
    karaoke: "highlight", accentColor: "#FFD400",
    box: "block", boxColor: "#000000", boxOpacity: 0.92, boxRadius: 0.18,
    posY: 0.5, maxWords: 5, maxLines: 2, maxWidthPct: 0.86, anim: "none" },
  { id: "pill", name: "White Pill", note: "Clean TikTok-style box",
    ...base, font: "Poppins", weight: 800, sizePct: 5.2,
    textColor: "#111111", box: "block", boxColor: "#FFFFFF", boxOpacity: 1, boxRadius: 0.35,
    posY: 0.5, maxWords: 4, maxLines: 2, anim: "pop" },
  { id: "neon", name: "Word Box", note: "Active word on a coloured box",
    ...base, font: "Anton", weight: 400, sizePct: 8.0, uppercase: true, letterSpacing: 0.01,
    karaoke: "highlight", activeBg: true, accentColor: "#7C3AED",
    shadow: 0.25, posY: 0.5, maxWords: 3, maxLines: 2, anim: "pop" },
  { id: "minimal", name: "Minimal", note: "Subtle and calm, for serious topics",
    ...base, font: "Inter", weight: 500, sizePct: 4.6, shadow: 0.35,
    posY: 0.5, maxWords: 7, maxLines: 2, maxWidthPct: 0.84 },
  { id: "serif", name: "Serif Hook", note: "Editorial serif with gold highlight",
    ...base, font: "Merriweather", weight: 900, sizePct: 5.6,
    karaoke: "highlight", accentColor: "#F5C518", shadow: 0.35,
    posY: 0.5, maxWords: 4, maxLines: 2, anim: "rise" },
];

export const DEFAULT_EMPHASIS = {
  font: "Inter", weight: 300, sizePct: 14, color: "#FFFFFF", posY: 0.26, uppercase: true,
};

export const DEFAULT_HOOK = {
  enabled: false, line1: "", line2: "",
  font: "Merriweather", weight: 900, sizePct: 6.4,
  color1: "#FFFFFF", color2: "#F5C518", posY: 0.2, start: 0, end: 4, anim: "fade",
};

// ---- Helpers -------------------------------------------------------------
function rgba(hex, a = 1) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function setFont(ctx, s, px) {
  ctx.font = `${s.weight} ${px}px "${s.font}", system-ui, sans-serif`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${(s.letterSpacing || 0) * px}px`;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function animState(anim, sinceStart) {
  const p = Math.max(0, Math.min(1, sinceStart / ANIM_DURATION));
  if (anim === "pop") {
    // overshoot: 0.7 -> 1.08 -> 1.0
    const s = p < 0.6 ? 0.7 + (1.08 - 0.7) * (p / 0.6) : 1.08 - 0.08 * ((p - 0.6) / 0.4);
    return { scale: s, alpha: Math.min(1, p * 2.5), dy: 0 };
  }
  if (anim === "fade") return { scale: 1, alpha: p, dy: 0 };
  if (anim === "rise") return { scale: 1, alpha: p, dy: (1 - p) * 0.4 };
  return { scale: 1, alpha: 1, dy: 0 };
}

// Split a list of {text,width} tokens into lines.
function wrap(tokens, maxW, space, maxLines, balance) {
  const lines = [];
  let cur = [], curW = 0;
  for (const t of tokens) {
    const add = cur.length ? space + t.width : t.width;
    if (cur.length && curW + add > maxW) { lines.push(cur); cur = [t]; curW = t.width; }
    else { cur.push(t); curW += add; }
  }
  if (cur.length) lines.push(cur);
  if (balance && lines.length === 1 && tokens.length >= 3 && maxLines >= 2) {
    // Two balanced lines, like Instagram/CapCut "two-liner" captions.
    let best = null;
    for (let i = 1; i < tokens.length; i++) {
      const w1 = tokens.slice(0, i).reduce((a, t) => a + t.width, 0) + space * (i - 1);
      const w2 = tokens.slice(i).reduce((a, t) => a + t.width, 0) + space * (tokens.length - i - 1);
      const score = Math.max(w1, w2) + (w2 < w1 ? 0 : 0.01);
      if (!best || score < best.score) best = { score, i };
    }
    return [tokens.slice(0, best.i), tokens.slice(best.i)];
  }
  return lines;
}

// Draw a block of words. `colorFor(i)` returns fill colour for word i or null (= hidden).
function drawBlock(ctx, W, H, words, s, opts) {
  let px = (s.sizePct / 100) * W;
  const texts = words.map((w) => {
    let text = s.uppercase ? w.text.toUpperCase() : w.text;
    if (s.stripPunct) text = text.replace(/[.,;:]+$/, "");
    return text;
  });
  setFont(ctx, s, px);
  // Shrink if a single word is wider than the allowed width
  const widest = Math.max(...texts.map((t) => ctx.measureText(t).width));
  if (widest > s.maxWidthPct * W) {
    px *= (s.maxWidthPct * W) / widest;
    setFont(ctx, s, px);
  }
  const space = ctx.measureText(" ").width;
  const tokens = texts.map((text, i) => ({ i, text, width: ctx.measureText(text).width }));
  const lines = wrap(tokens, s.maxWidthPct * W, space, s.maxLines, s.balance);
  const lh = px * s.lineHeight;
  const blockH = lh * lines.length;
  const cx = (s.posX ?? 0.5) * W;
  const cy = s.posY * H;
  const a = opts.anim || { scale: 1, alpha: 1, dy: 0 };

  ctx.save();
  ctx.globalAlpha = a.alpha;
  ctx.translate(cx, cy + a.dy * px);
  ctx.scale(a.scale, a.scale);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  // Lay out positions
  const placed = [];
  const lineBoxes = [];
  const lineW = lines.map((line) => line.reduce((acc, t) => acc + t.width, 0) + space * (line.length - 1));
  const blockW = Math.max(...lineW);
  lines.forEach((line, li) => {
    const lw = lineW[li];
    let x = s.align === "left" ? -blockW / 2 : s.align === "right" ? blockW / 2 - lw : -lw / 2;
    const y = -blockH / 2 + lh * (li + 0.5);
    lineBoxes.push({ x, y, w: lw });
    for (const t of line) { placed.push({ ...t, x, y }); x += t.width + space; }
  });

  // Background boxes
  const padX = px * 0.22, padY = px * 0.1;
  if (s.box === "none" && s.backdrop) {
    // soft dark band so box-less templates stay readable on light slides
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    for (const b of lineBoxes) {
      roundRect(ctx, b.x - padX * 1.3, b.y - lh / 2 - padY * 0.3, b.w + padX * 2.6, lh + padY * 0.6, px * 0.3);
      ctx.fill();
    }
  }
  if (s.box === "line") {
    ctx.fillStyle = rgba(s.boxColor, s.boxOpacity);
    for (const b of lineBoxes) {
      roundRect(ctx, b.x - padX, b.y - lh / 2 - padY * 0.2, b.w + padX * 2, lh + padY * 0.4, s.boxRadius * px);
      ctx.fill();
    }
  } else if (s.box === "block") {
    const maxW = Math.max(...lineBoxes.map((b) => b.w));
    ctx.fillStyle = rgba(s.boxColor, s.boxOpacity);
    roundRect(ctx, -maxW / 2 - padX * 1.6, -blockH / 2 - padY * 2, maxW + padX * 3.2, blockH + padY * 4, s.boxRadius * px);
    ctx.fill();
  }

  const visible = placed.filter((p) => opts.colorFor(p.i) !== null);

  // Active-word background (e.g. "Word Box" template)
  if (s.activeBg && opts.activeIndex != null) {
    const p = placed.find((q) => q.i === opts.activeIndex);
    if (p) {
      ctx.fillStyle = s.accentColor;
      roundRect(ctx, p.x - px * 0.14, p.y - px * 0.62, p.width + px * 0.28, px * 1.18, px * 0.16);
      ctx.fill();
    }
  }

  // Shadow + outline pass (all words first so strokes never cover neighbouring fills)
  if (s.shadow > 0 || s.outlineWidth > 0) {
    ctx.save();
    if (s.shadow > 0) {
      ctx.shadowColor = rgba(s.shadowColor, 0.75);
      ctx.shadowBlur = s.shadow * px;
      ctx.shadowOffsetY = s.shadow * px * 0.25;
    }
    for (const p of visible) {
      if (s.outlineWidth > 0) {
        ctx.strokeStyle = s.outlineColor;
        ctx.lineWidth = s.outlineWidth * px * 2;
        ctx.strokeText(p.text, p.x, p.y);
      } else {
        ctx.fillStyle = opts.colorFor(p.i);
        ctx.fillText(p.text, p.x, p.y);
      }
    }
    ctx.restore();
  }
  for (const p of visible) {
    ctx.fillStyle = opts.colorFor(p.i);
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.restore();
}

// Index of the word being spoken at time t (-1 = before first word)
function activeWordIndex(cap, t) {
  let idx = -1;
  cap.words.forEach((w, i) => { if (w.start <= t + 1e-4) idx = i; });
  return idx;
}

export function findCaption(captions, t) {
  return captions.find((c) => t >= c.start && t < c.end) || null;
}

// ---- Main entry: draw everything visible at time t. Returns true if anything was drawn.
export function renderAt(ctx, W, H, t, project) {
  const { captions, style: s, hook, emphasis } = project;
  let drew = false;

  // Hook title
  if (hook && hook.enabled && (hook.line1 || hook.line2) && t >= hook.start && t < hook.end) {
    const hs = { ...base, font: hook.font, weight: hook.weight, sizePct: hook.sizePct, posY: hook.posY,
      shadow: 0.3, maxLines: 4, maxWidthPct: 0.9, lineHeight: 1.15 };
    const words = [];
    const colors = [];
    for (const [line, col] of [[hook.line1, hook.color1], [hook.line2, hook.color2]]) {
      for (const w of (line || "").split(/\s+/).filter(Boolean)) { words.push({ text: w }); colors.push(col); }
    }
    // keep line 1 and line 2 on separate rows: draw them as two blocks
    const n1 = (hook.line1 || "").split(/\s+/).filter(Boolean).length;
    const anim = animState(hook.start > 0 ? hook.anim : "none", t - hook.start);
    const px = (hook.sizePct / 100) * W;
    const gap = (px * 1.15) / H / 2;
    if (n1) drawBlock(ctx, W, H, words.slice(0, n1), { ...hs, posY: hook.posY - (words.length > n1 ? gap : 0) },
      { colorFor: () => hook.color1, anim });
    if (words.length > n1) drawBlock(ctx, W, H, words.slice(n1), { ...hs, posY: hook.posY + (n1 ? gap : 0) },
      { colorFor: () => hook.color2, anim });
    drew = true;
  }

  const cap = findCaption(captions, t);
  if (!cap || !cap.words.length) return drew;
  const active = activeWordIndex(cap, t);

  if (cap.emphasis) {
    const es = { ...base, font: emphasis.font, weight: emphasis.weight, sizePct: emphasis.sizePct,
      uppercase: emphasis.uppercase, posY: emphasis.posY, shadow: 0.2, maxLines: 4, stripPunct: true,
      maxWidthPct: 0.9, lineHeight: 1.08, letterSpacing: 0.01 };
    drawBlock(ctx, W, H, cap.words, es, {
      colorFor: (i) => (i <= Math.max(0, active) ? emphasis.color : null),
    });
    return true;
  }

  const anim = animState(s.anim, t - cap.start);
  const a = Math.max(0, active);
  const colorFor = (i) => {
    switch (s.karaoke) {
      case "reveal": return i <= a ? s.textColor : s.upcomingColor;
      case "highlight": return i === a && !s.activeBg ? s.accentColor : s.textColor;
      case "build": return i <= a ? s.textColor : null;
      default: return s.textColor;
    }
  };
  drawBlock(ctx, W, H, cap.words, s, {
    colorFor, anim, activeIndex: s.karaoke === "highlight" ? a : null,
  });
  return true;
}

// Every moment where the picture changes — used by the exporter.
export function changePoints(project, duration, fps = 30) {
  const pts = new Set([0]);
  const add = (t) => { if (t >= 0 && t < duration) pts.add(Math.round(t * 1000) / 1000); };
  const animSteps = (start, anim) => {
    if (!anim || anim === "none") return;
    const n = Math.ceil(ANIM_DURATION * fps);
    for (let k = 1; k <= n; k++) add(start + k / fps);
  };
  const { captions, style, hook } = project;
  for (const c of captions) {
    add(c.start); add(c.end);
    if (c.emphasis || style.karaoke !== "none") c.words.forEach((w) => add(w.start));
    if (!c.emphasis) animSteps(c.start, style.anim);
  }
  if (hook && hook.enabled && (hook.line1 || hook.line2)) {
    add(hook.start); add(hook.end); if (hook.start > 0) animSteps(hook.start, hook.anim);
  }
  return [...pts].sort((a, b) => a - b);
}

// ---- Caption building / editing -----------------------------------------
let _id = 0;
export const newId = () => `c${Date.now().toString(36)}${(++_id).toString(36)}`;

export function groupWords(words, maxWords) {
  const caps = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    caps.push({ id: newId(), start: cur[0].start, end: cur[cur.length - 1].end,
      words: cur.map((w) => ({ ...w })), text: cur.map((w) => w.text).join(" "), emphasis: false });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (cur.length && prev) {
      const gap = w.start - prev.end;
      const endsSentence = /[.!?]$/.test(prev.text);
      const comma = /[,;:]$/.test(prev.text);
      if (cur.length >= maxWords || endsSentence || gap > 0.7 || (comma && cur.length >= Math.ceil(maxWords / 2))) flush();
    }
    cur.push(w);
  });
  flush();
  // Close small gaps so captions don't flicker between phrases
  for (let i = 0; i < caps.length - 1; i++) {
    const gap = caps[i + 1].start - caps[i].end;
    if (gap > 0 && gap < 0.4) caps[i].end = caps[i + 1].start;
  }
  caps.forEach((c) => { if (c.end - c.start < 0.3) c.end = c.start + 0.3; });
  return caps;
}

// When text is edited, keep word timings if word count is unchanged,
// otherwise spread the words across the caption's time span by length.
export function retimeWords(cap, text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === cap.words.length) {
    cap.words = cap.words.map((w, i) => ({ ...w, text: tokens[i] }));
  } else {
    const total = tokens.reduce((a, t) => a + t.length + 1, 0) || 1;
    let t = cap.start;
    const span = cap.end - cap.start;
    cap.words = tokens.map((tok) => {
      const d = (span * (tok.length + 1)) / total;
      const w = { text: tok, start: t, end: t + d };
      t += d;
      return w;
    });
  }
  cap.text = tokens.join(" ");
}

export function rescaleCaption(cap, newStart, newEnd) {
  const os = cap.start, oe = cap.end;
  const k = (newEnd - newStart) / Math.max(0.001, oe - os);
  cap.words = cap.words.map((w) => ({
    ...w, start: newStart + (w.start - os) * k, end: newStart + (w.end - os) * k,
  }));
  cap.start = newStart;
  cap.end = newEnd;
}

export function toSRT(captions) {
  const ts = (t) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
}
