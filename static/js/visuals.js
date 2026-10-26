// Visual cards: designed illustration cards made from what the speaker says.
// They can replace static slide moments. Drawn by the browser (preview AND export overlay),
// so they look identical in both. Text always comes from the transcript (no invented claims).

export const CARD_KINDS = {
  keyword: "Keyword + icon",
  stat: "Big number",
  question: "Question",
  list: "Short list",
  quote: "Quote",
};

export const CARD_THEMES = {
  night:  { label: "Night",  bg: ["#141a3a", "#3b2a8c"], ink: "#ffffff", sub: "#c9c8ff", accent: "#ffd84d" },
  sunset: { label: "Sunset", bg: ["#ff7a59", "#c2306b"], ink: "#ffffff", sub: "#ffe3d6", accent: "#fff27a" },
  paper:  { label: "Paper",  bg: ["#fbf7ef", "#efe6d4"], ink: "#1d1b16", sub: "#6d6556", accent: "#e4572e" },
  ocean:  { label: "Ocean",  bg: ["#0b3d5c", "#118a8a"], ink: "#ffffff", sub: "#c6f1ef", accent: "#ffd166" },
  mint:   { label: "Mint",   bg: ["#e9fbf3", "#c6f0dc"], ink: "#0f3d2e", sub: "#3f7462", accent: "#12a150" },
};

const ICONS = [
  [/\b(ai|a\.i\.|artificial|model|gpt|chatgpt|chatgbt|gemini|claude|llm|bot)s?\b/i, "🤖"],
  [/\bagents?\b/i, "🕵️"],
  [/\b(intern|interns|student|graduate)s?\b/i, "🧑‍🎓"],
  [/\b(universit|college|school|ivy|degree|academ)/i, "🎓"],
  [/\b(business|company|companies|organi[sz]ation|owner|startup|firm)s?\b/i, "🏢"],
  [/\b(team|people|staff|hire|hiring|employee|colleague)s?\b/i, "👥"],
  [/\b(money|cost|price|revenue|sales|profit|budget|dollar)s?\b/i, "💰"],
  [/\b(time|hour|minute|fast|quick|speed|faster)s?\b/i, "⏱️"],
  [/\b(data|number|report|chart|metric|analytics)s?\b/i, "📊"],
  [/\b(grow|growth|increase|scale|double)/i, "📈"],
  [/\b(email|inbox|newsletter|message)s?\b/i, "📧"],
  [/\b(customer|client|partner)s?\b/i, "🤝"],
  [/\b(idea|creative|think|thinking|imagine)s?\b/i, "💡"],
  [/\b(problem|mistake|wrong|risk|fail|error)s?\b/i, "⚠️"],
  [/\b(secret|hidden|private)\b/i, "🔒"],
  [/\b(learn|teach|train|training|lesson|course)s?\b/i, "📚"],
  [/\b(tool|build|code|coding|software|app)s?\b/i, "🛠️"],
  [/\b(context|knowledge|information|memory|brain|smart)s?\b/i, "🧠"],
  [/\b(asia|world|global|country|countries|international)\b/i, "🌏"],
  [/\b(phone|mobile|device)s?\b/i, "📱"],
  [/\b(video|content|social|post|tiktok|youtube)s?\b/i, "🎬"],
  [/\b(goal|target|focus|result)s?\b/i, "🎯"],
  [/\b(work|job|task|workflow|process)s?\b/i, "📋"],
  [/\b(automat|system)/i, "⚙️"],
  [/\b(secur|safe|protect)/i, "🛡️"],
  [/\b(success|win|best|top)\b/i, "🏆"],
];

const STOP = new Set(("a an the and or but if then so of to in on at for with from by as is are was were be been it its this that these " +
  "those i you he she we they me him her us them my your our their what which who when where why how all any some no not only " +
  "can will just do does did have has had would could should may might must there here very really also like um uh yeah okay " +
  "know think going get got actually kind sort thing things lot way say said see well right want make much many even still " +
  "because one two three sometimes something find that's it's you're they're we're i'm don't more about much out there " +
  "today what's what probably first came then than into over").split(" "));

export function iconFor(text) {
  for (const [re, ic] of ICONS) if (re.test(text)) return ic;
  return "💡";
}

function keyPhrase(text, max = 4) {
  // the longest run of content words, in the speaker's own order
  const toks = text.replace(/[“”"]/g, "").split(/\s+/).map((w) => w.replace(/[.,!?;:]+$/, ""));
  let best = [], cur = [];
  for (const w of toks) {
    if (w && !STOP.has(w.toLowerCase()) && w.length > 1) { cur.push(w); if (cur.length > best.length) best = cur.slice(); }
    else cur = [];
  }
  if (best.length < 3) {
    // short run: use the speaker's phrase around the word that matches an icon topic instead
    for (const [re] of ICONS) {
      const i = toks.findIndex((w) => re.test(w));
      if (i >= 0) {
        let win = toks.slice(Math.max(0, i - 3), i + 2);
        while (win.length > 1 && STOP.has(win[0].toLowerCase())) win.shift();
        while (win.length > 1 && STOP.has(win[win.length - 1].toLowerCase())) win.pop();
        if (win.length >= 2) return win.slice(0, max + 1).join(" ");
        break;
      }
    }
  }
  if (!best.length) best = toks.filter((w) => w && !STOP.has(w.toLowerCase())).slice(0, max);
  return best.slice(0, max).join(" ");
}

const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
// "forty percent" -> "40 percent", "three weeks" -> "3 weeks" (only before a unit, so normal speech is untouched)
function numberWords(t) {
  return t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_, a, b) => String(ONES[a.toLowerCase()] + ONES[b.toLowerCase()]))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b(?=\s+(%|percent|x|times|years?|months?|weeks?|days?|hours?|minutes?|people|clients?|customers?|million|billion))/gi,
      (w) => String(ONES[w.toLowerCase()]));
}

// Build a card from what is said (text = the speaker's words for that moment).
export function cardFromSpeech(text, theme = "night") {
  const t = (text || "").trim();
  const words = t.split(/\s+/);
  const tn = numberWords(t);
  const re = /(\d+(?:[.,]\d+)?)\s*(%|percent|x|times|years?|months?|weeks?|days?|hours?|minutes?|people|clients?|customers?|million|billion|k)\b/gi;
  const nums = [...tn.matchAll(re)];
  if (nums.length) {
    const rank = (m) => (/%|percent|x|times|million|billion/i.test(m[2]) ? 0 : 1);
    const num = nums.sort((a, b) => rank(a) - rank(b))[0];
    const unit = num[2].toLowerCase() === "percent" ? "%" : num[2];
    const clean = (arr) => {
      const w = arr.map((x) => x.replace(/[.,!?;:]+$/, "")).filter(Boolean);
      while (w.length > 1 && STOP.has(w[0].toLowerCase())) w.shift();
      while (w.length > 1 && STOP.has(w[w.length - 1].toLowerCase())) w.pop();
      return w.join(" ");
    };
    const after = clean(tn.slice(num.index + num[0].length).split(/[.,;!?]/)[0].split(/\s+/).slice(0, 6));
    const before = clean(tn.slice(0, num.index).split(/[.,;!?]/).pop().split(/\s+/).slice(-7));
    const label = after.split(/\s+/).length >= 2 ? after : before || after || keyPhrase(t);
    return { kind: "stat", icon: iconFor(t), title: `${num[1]}${unit === "%" ? "%" : " " + unit}`, lines: [cap(label)], theme };
  }
  const q = t.split(/(?<=[.!?])\s+/).find((s) => s.trim().endsWith("?"));
  if (q && q.split(/\s+/).length <= 16) return { kind: "question", icon: "❓", title: q.trim(), lines: [], theme };
  const parts = t.replace(/[.!?]+$/, "").split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter((s) => s && s.split(/\s+/).length <= 5);
  if (parts.length >= 3) return { kind: "list", icon: iconFor(t), title: cap(keyPhrase(t, 3)), lines: parts.slice(0, 4).map(cap), theme };
  if (words.length <= 12) return { kind: "quote", icon: iconFor(t), title: t.replace(/^(so|and|but|um|uh)\s+/i, ""), lines: [], theme };
  return { kind: "keyword", icon: iconFor(t), title: cap(keyPhrase(t, 4)), lines: [], theme };
}

// ---------------------------------------------------------------- drawing
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function wrapText(ctx, text, maxW) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitText(ctx, text, weight, maxW, maxLines, startPx, minPx, family = "Inter") {
  let px = startPx, lines;
  for (;;) {
    ctx.font = `${weight} ${px}px "${family}", system-ui, sans-serif`;
    lines = wrapText(ctx, text, maxW);
    if ((lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) || px <= minPx) break;
    px = Math.max(minPx, Math.floor(px * 0.9));
  }
  return { px, lines: lines.slice(0, maxLines) };
}

// Draw a card into rect {x,y,w,h} (canvas pixels). a = 0..1 entrance progress.
export function drawCard(ctx, rect, card, a = 1) {
  const th = CARD_THEMES[card.theme] || CARD_THEMES.night;
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, th.bg[0]); g.addColorStop(1, th.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // soft decorative circles
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.beginPath(); ctx.arc(x + w * 0.88, y + h * 0.12, w * 0.28, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + w * 0.08, y + h * 0.95, w * 0.22, 0, Math.PI * 2); ctx.fill();
  const lift = (1 - Math.min(1, a)) * h * 0.04;
  ctx.translate(0, lift);
  const S = Math.min(w, h * 1.1);
  const cx = x + w / 2, pad = w * 0.09, maxW = w - pad * 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const kind = card.kind || "keyword";
  ctx.fillStyle = "#000";
  if (kind === "stat") {
    ctx.font = `${S * 0.11}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.fillText(card.icon || "📈", cx, y + h * 0.2);
    const big = fitText(ctx, card.title, 900, maxW, 1, S * 0.26, S * 0.1, "Montserrat");
    ctx.fillStyle = th.accent;
    ctx.font = `900 ${big.px}px "Montserrat", system-ui, sans-serif`;
    ctx.fillText(big.lines[0] || "", cx, y + h * 0.47);
    const sub = fitText(ctx, (card.lines || [])[0] || "", 700, maxW, 2, S * 0.065, S * 0.04);
    ctx.fillStyle = th.ink;
    sub.lines.forEach((l, i) => ctx.fillText(l, cx, y + h * 0.7 + i * sub.px * 1.2));
  } else if (kind === "list") {
    const ttl = fitText(ctx, `${card.icon || ""} ${card.title}`.trim(), 800, maxW, 2, S * 0.075, S * 0.045);
    ctx.fillStyle = th.ink;
    ttl.lines.forEach((l, i) => ctx.fillText(l, cx, y + h * 0.17 + i * ttl.px * 1.15));
    const items = (card.lines || []).slice(0, 4);
    const top = y + h * 0.36, step = Math.min(h * 0.15, (h * 0.58) / Math.max(1, items.length));
    ctx.textAlign = "left";
    items.forEach((it, i) => {
      const yy = top + step * (i + 0.5);
      const fs = fitText(ctx, it, 700, maxW - S * 0.12, 1, S * 0.058, S * 0.035);
      ctx.fillStyle = th.accent;
      roundRect(ctx, x + pad, yy - S * 0.03, S * 0.06, S * 0.06, S * 0.015); ctx.fill();
      ctx.fillStyle = th.ink;
      ctx.font = `700 ${fs.px}px "Inter", system-ui, sans-serif`;
      ctx.fillText(fs.lines[0] || "", x + pad + S * 0.1, yy);
    });
  } else if (kind === "quote") {
    ctx.fillStyle = th.accent;
    ctx.font = `900 ${S * 0.26}px "DM Serif Display", Georgia, serif`;
    ctx.fillText("“", cx, y + h * 0.2);
    const q = fitText(ctx, card.title, 800, maxW, 5, S * 0.085, S * 0.045);
    ctx.fillStyle = th.ink;
    const total = q.lines.length * q.px * 1.2;
    q.lines.forEach((l, i) => ctx.fillText(l, cx, y + h * 0.56 - total / 2 + (i + 0.5) * q.px * 1.2));
  } else {
    // keyword / question
    ctx.fillStyle = "#000";
    ctx.font = `${S * 0.2}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.fillText(card.icon || "💡", cx, y + h * 0.3);
    const tt = fitText(ctx, card.title, kind === "question" ? 800 : 900, maxW, 3, S * (kind === "question" ? 0.075 : 0.095), S * 0.045,
      kind === "question" ? "Inter" : "Montserrat");
    ctx.fillStyle = th.ink;
    const base = y + h * 0.62;
    tt.lines.forEach((l, i) => ctx.fillText(kind === "keyword" ? l.toUpperCase() : l, cx, base + i * tt.px * 1.18));
    if (card.lines?.[0]) {
      ctx.fillStyle = th.sub;
      const s2 = fitText(ctx, card.lines[0], 600, maxW, 1, S * 0.05, S * 0.035);
      ctx.fillText(s2.lines[0], cx, base + tt.lines.length * tt.px * 1.18 + s2.px);
    }
    ctx.fillStyle = th.accent;
    roundRect(ctx, cx - S * 0.08, base - tt.px * 0.95, S * 0.16, S * 0.012, S * 0.006); ctx.fill();
  }
  ctx.restore();
}

export async function ensureCardFonts() {
  await Promise.all(['900 40px "Montserrat"', '800 40px "Inter"', '700 40px "Inter"', '400 40px "DM Serif Display"']
    .map((f) => document.fonts.load(f).catch(() => {})));
}
