/* Start, Bücherwand, versteckter Elternzugang */
import { APP_TITLE, ADMIN_TAPS, ADMIN_TAP_WINDOW_MS } from "./config.js";
import { initDatabase, getBooks, cleanupOrphans, getSetting, setSetting } from "./db.js";
import { requestPersistence } from "./storage.js";
import { Reader } from "./reader.js";
import { el, sleep, enterFullscreen } from "./util.js";

const $ = (id) => document.getElementById(id);

const splash = $("splash");
const library = $("library");
const shelf = $("shelf");
const libTitle = $("lib-title");
const libMessage = $("lib-message");

let coverUrls = [];

/* ---------- Globale Schutzmaßnahmen (Zoom, Kontextmenü, Ziehen) ---------- */
["gesturestart", "gesturechange", "gestureend"].forEach((t) =>
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false })
);
document.addEventListener("touchmove", (e) => {
  if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault();
}, { passive: false });
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest || !e.target.closest(".admin input, .admin textarea")) e.preventDefault();
});
document.addEventListener("dragstart", (e) => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  // Doppeltipp-Zoom verhindern (außer in Bedienelementen)
  const now = Date.now();
  if (now - lastTouchEnd < 320 && e.cancelable && !(e.target.closest && e.target.closest("input, select, textarea, button, label"))) {
    e.preventDefault();
  }
  lastTouchEnd = now;
}, { passive: false });

/* ---------- Leser ---------- */
const reader = new Reader({
  root: $("reader"),
  area: $("reader-area"),
  sizer: $("book-sizer"),
  exitBtn: $("reader-exit"),
  loading: $("reader-loading"),
  error: $("reader-error"),
  retryBtn: $("reader-retry"),
  backBtn: $("reader-back"),
  onClose: () => {
    library.hidden = false;
    requestAnimationFrame(() => library.classList.remove("is-leaving"));
    shelf.querySelectorAll(".is-opening").forEach((n) => n.classList.remove("is-opening"));
  }
});

function openBook(book, btn) {
  enterFullscreen(); // muss direkt in der Tipp-Geste passieren
  btn.classList.add("is-opening");
  library.classList.add("is-leaving");
  setTimeout(() => {
    library.hidden = true;
    reader.open(book);
  }, 220);
}

/* ---------- Bücherwand ---------- */
function groupByCategory(list) {
  const groups = new Map();
  for (const b of list) {
    const key = b.category || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.entries()];
}

function renderShelf(list) {
  coverUrls.forEach((u) => URL.revokeObjectURL(u));
  coverUrls = [];
  shelf.replaceChildren();
  libMessage.hidden = true;
  if (!list.length) {
    showLibMessage("Noch keine Bücher vorhanden.", false);
    return;
  }
  let n = 0;
  for (const [category, items] of groupByCategory(list)) {
    const row = el("div", { class: "shelf-row" });
    for (const book of items) {
      const aspect = book.coverAspect || book.pageAspect || 0.7;
      let url = "";
      if (book.coverBlob) { url = URL.createObjectURL(book.coverBlob); coverUrls.push(url); }
      const img = el("img", { src: url, alt: "", draggable: "false", decoding: "async" });
      img.addEventListener("error", () => img.closest(".book-cover").classList.add("is-missing"), { once: true });
      const btn = el("button", { class: "book", type: "button", "aria-label": book.title }, [
        el("span", { class: "book-cover" + (url ? "" : " is-missing"), style: { aspectRatio: String(aspect) } }, [
          img,
          el("span", { class: "book-cover-fallback", text: book.title })
        ]),
        el("span", { class: "book-plank", "aria-hidden": "true" }),
        el("span", { class: "book-title", text: book.title }),
        book.subtitle ? el("span", { class: "book-sub", text: book.subtitle }) : null
      ]);
      btn.style.setProperty("--i", String(n));
      btn.addEventListener("click", () => openBook(book, btn));
      row.appendChild(btn);
      n++;
    }
    shelf.appendChild(el("section", { class: "shelf-group" }, [
      category ? el("h2", { class: "shelf-label", text: category }) : null,
      row
    ]));
  }
}

function showLibMessage(text, withRetry) {
  const parts = [el("p", { text })];
  if (withRetry) parts.push(el("button", { class: "btn-soft", type: "button", text: "Nochmal versuchen", onclick: () => refresh() }));
  libMessage.replaceChildren(...parts);
  libMessage.hidden = false;
}

async function refresh() {
  try {
    await initDatabase();
    renderShelf(await getBooks({ includeInactive: false }));
  } catch (err) {
    console.warn("Bibliothek konnte nicht geladen werden:", err);
    shelf.replaceChildren();
    showLibMessage("Der Gerätespeicher ist gerade nicht verfügbar.", true);
  }
}

/* ---------- Versteckter Zugang: 5× auf die Überschrift tippen ---------- */
function setupAdminTrigger() {
  let taps = 0;
  let first = 0;
  libTitle.addEventListener("pointerdown", () => {
    const now = Date.now();
    if (!taps || now - first > ADMIN_TAP_WINDOW_MS) { taps = 0; first = now; }
    taps++;
    if (taps >= ADMIN_TAPS) {
      taps = 0;
      import("./admin.js")
        .then((m) => m.openAdmin({ onClose: () => refresh() }))
        .catch((e) => console.error("Elternbereich konnte nicht geladen werden:", e));
    }
  });
}

/* ---------- Einmalig: Reste der früheren Cloud-Version entfernen ---------- */
async function cleanupLegacy() {
  try {
    if (await getSetting("legacyCleaned", false)) return;
    localStorage.removeItem("kb.books.v1");
    localStorage.removeItem("kb.adminEmail");
    if (indexedDB.databases) {
      for (const d of await indexedDB.databases()) {
        if (d.name && /^(firebase|firestore)/i.test(d.name)) indexedDB.deleteDatabase(d.name);
      }
    }
    await setSetting("legacyCleaned", true);
  } catch (_) { /* egal */ }
}

/* ---------- Service Worker (nur App-Dateien) ---------- */
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
  navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW:", e));
}

/* ---------- Start ---------- */
async function start() {
  document.title = APP_TITLE;
  libTitle.textContent = APP_TITLE;
  registerSW();
  setupAdminTrigger();

  const minSplash = sleep(650);
  await refresh();
  await minSplash;
  library.hidden = false;
  splash.classList.add("is-done");
  setTimeout(() => splash.remove(), 500);

  // Aufräumen nur beim Start (dann läuft garantiert kein Import)
  cleanupOrphans().catch(() => {});
  cleanupLegacy();
  requestPersistence();
}

start();
