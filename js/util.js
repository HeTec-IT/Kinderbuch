/* Kleine Hilfsfunktionen ohne Abhängigkeiten */

const loadedScripts = new Map();

/** Lädt ein klassisches Script genau einmal (relativ zur index.html). */
export function loadScript(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => {
      loadedScripts.delete(src);
      s.remove();
      reject(new Error("Script konnte nicht geladen werden: " + src));
    };
    document.head.appendChild(s);
  });
  loadedScripts.set(src, p);
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Element-Helfer: el("div", {class:"x", onclick: fn}, [kinder]) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function newId() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch (_) { /* weiter */ }
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function formatBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "–";
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const digits = i < 2 ? 0 : 1;
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits }) + " " + units[i];
}

export function fileSlug(title) {
  const s = String(title || "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return s || "Buch";
}

export function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.navigator.standalone === true
  );
}

export function enterFullscreen() {
  if (isStandalone()) return;
  const d = document.documentElement;
  try {
    const fn = d.requestFullscreen || d.webkitRequestFullscreen;
    if (fn) {
      const r = fn.call(d, { navigationUI: "hide" });
      if (r && r.catch) r.catch(() => {});
    }
  } catch (_) { /* nicht unterstützt – egal */ }
}

export function exitFullscreen() {
  try {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn) {
      const r = fn.call(document);
      if (r && r.catch) r.catch(() => {});
    }
  } catch (_) { /* egal */ }
}
