// Small DOM helpers (no framework).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function fmtTime(t, decimals = 1) {
  if (t == null || isNaN(t)) return "–";
  const neg = t < 0;
  t = Math.abs(t);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const s = ss.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return (neg ? "-" : "") + (hh ? `${hh}:${String(mm).padStart(2, "0")}:${s}` : `${mm}:${s}`);
}

export function parseTime(str) {
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${u[i]}`;
}

export function fmtDur(s) {
  if (!s && s !== 0) return "–";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

let toastBox;
export function toast(msg, kind = "info", ms = 4500) {
  if (!toastBox) { toastBox = h("div", { class: "toasts" }); document.body.append(toastBox); }
  const t = h("div", { class: `toast ${kind}` }, msg);
  toastBox.append(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function modal(title, body, actions = []) {
  const close = () => wrap.remove();
  const wrap = h("div", { class: "modal-wrap", onclick: (e) => { if (e.target === wrap) close(); } },
    h("div", { class: "modal" },
      h("div", { class: "modal-head" }, h("h3", {}, title), h("button", { class: "icon-btn", onclick: close, title: "Close" }, "✕")),
      h("div", { class: "modal-body" }, body),
      actions.length ? h("div", { class: "modal-actions" }, actions.map((a) =>
        h("button", { class: a.class || "btn", onclick: async () => { if ((await a.onClick?.()) !== false) close(); } }, a.label))) : null));
  document.body.append(wrap);
  return { close, el: wrap };
}

export function confirmBox(title, text, okLabel = "OK") {
  return new Promise((resolve) => {
    const m = modal(title, h("p", {}, text), [
      { label: "Cancel", class: "btn ghost", onClick: () => resolve(false) },
      { label: okLabel, class: "btn primary", onClick: () => resolve(true) },
    ]);
    m.el.addEventListener("click", (e) => { if (e.target === m.el) resolve(false); });
  });
}

export function progressBar(p, label, opts = {}) {
  return h("div", { class: "progress" + (opts.error ? " error" : "") },
    h("div", { class: "progress-track" }, h("div", { class: "progress-fill", style: { width: `${Math.round((p || 0) * 100)}%` } })),
    h("div", { class: "progress-label" }, label || "", opts.pct === false ? "" : h("span", { class: "pct" }, ` ${Math.round((p || 0) * 100)}%`)));
}

// Error box with optional retry; long technical details are collapsed.
export function errorBox(message, retry) {
  const [main, ...rest] = String(message).split("\n\nDetails: ");
  return h("div", { class: "alert error" },
    h("div", {}, h("strong", {}, "Something needs attention. "), main),
    rest.length ? h("details", {}, h("summary", {}, "Technical details"), h("pre", {}, rest.join("\n"))) : null,
    retry ? h("button", { class: "btn small", onclick: retry }, "Try again") : null);
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function slider(label, value, min, max, step, onInput, fmt = (v) => v) {
  const out = h("span", { class: "slider-val" }, fmt(value));
  const inp = h("input", { type: "range", min, max, step, value });
  inp.addEventListener("input", () => { out.textContent = fmt(Number(inp.value)); onInput(Number(inp.value)); });
  return h("label", { class: "field slider" }, h("span", { class: "field-label" }, label, out), inp);
}

export function select(label, value, options, onChange) {
  const sel = h("select", { onchange: () => onChange(sel.value) },
    options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), sel);
}
