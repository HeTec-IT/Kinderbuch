/* Lokale Datenbank (IndexedDB) – die einzige Stelle mit IndexedDB-Code.

   Stores:
     books  { id, title, subtitle, category, order, active, createdAt, pageCount,
              pageAspect, layout, showCover, pageWidth, pageHeight, hasPdf, coverBlob }
     pages  { bookId, n, blob }          n = 0-basierter Seitenindex, blob = JPEG
     files  { id, blob }                 id = bookId, blob = Original-PDF (optional)
     meta   { key, value }               kleine Einstellungen (PIN-Hash, Flags …)

   Ein Buch ist erst „da“, wenn sein Eintrag in "books" existiert. Der Import schreibt
   diesen Eintrag zuletzt. Seiten ohne Buch („Waisen“) werden beim Start entfernt.

   MIGRATIONEN: Die Datenbank wird NIE gelöscht. Neue Versionen ergänzen in
   migrate() nur Stores/Indizes oder schreiben vorhandene Daten um. */
import { DB_NAME, DB_VERSION } from "./config.js";

const S_BOOKS = "books";
const S_PAGES = "pages";
const S_FILES = "files";
const S_META = "meta";

let dbPromise = null;

function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore(S_BOOKS, { keyPath: "id" });
    db.createObjectStore(S_PAGES, { keyPath: ["bookId", "n"] });
    db.createObjectStore(S_FILES, { keyPath: "id" });
    db.createObjectStore(S_META, { keyPath: "key" });
  }
  // if (oldVersion < 2) { … neue Stores/Felder hier ergänzen, nie löschen … }
}

export function initDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window) || !window.indexedDB) {
      reject(new Error("indexeddb-unavailable"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("indexeddb-open-failed"));
    req.onblocked = () => { /* anderer Tab hält alte Version – wartet automatisch */ };
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/** Eine Transaktion ausführen. fn(tx) darf einen IDBRequest zurückgeben → dessen Ergebnis. */
async function run(stores, mode, fn) {
  const db = await initDatabase();
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("tx-error"));
    tx.onabort = () => reject(tx.error || new Error("tx-abort"));
    try {
      const r = fn(tx);
      if (r && typeof r === "object" && "onsuccess" in r) r.onsuccess = () => { result = r.result; };
    } catch (e) {
      try { tx.abort(); } catch (_) { /* egal */ }
      reject(e);
    }
  });
}

/* ---------------- Bücher ---------------- */

export async function getBooks({ includeInactive = true } = {}) {
  const all = (await run([S_BOOKS], "readonly", (tx) => tx.objectStore(S_BOOKS).getAll())) || [];
  const list = includeInactive ? all : all.filter((b) => b.active !== false);
  return list.sort((a, b) => (a.order - b.order) || String(a.title).localeCompare(String(b.title), "de"));
}

export async function getBook(id) {
  return (await run([S_BOOKS], "readonly", (tx) => tx.objectStore(S_BOOKS).get(id))) || null;
}

export async function saveBook(book) {
  await run([S_BOOKS], "readwrite", (tx) => tx.objectStore(S_BOOKS).put(book));
  return book;
}

/** Felder eines Buchs ändern (lesen + schreiben in einer Transaktion). */
export async function updateBook(id, changes) {
  const db = await initDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([S_BOOKS], "readwrite");
    const st = tx.objectStore(S_BOOKS);
    let updated = null;
    const g = st.get(id);
    g.onsuccess = () => {
      if (!g.result) return;
      updated = { ...g.result, ...changes, id };
      st.put(updated);
    };
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error || new Error("tx-error"));
    tx.onabort = () => reject(tx.error || new Error("tx-abort"));
  });
}

/** Buch samt Seiten und Original-PDF in EINER Transaktion löschen. */
export async function deleteBook(id) {
  await run([S_BOOKS, S_PAGES, S_FILES], "readwrite", (tx) => {
    tx.objectStore(S_PAGES).delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    tx.objectStore(S_FILES).delete(id);
    tx.objectStore(S_BOOKS).delete(id);
  });
}

export async function nextOrder() {
  const books = await getBooks();
  return books.reduce((m, b) => Math.max(m, typeof b.order === "number" ? b.order : 0), 0) + 1;
}

/* ---------------- Seiten ---------------- */

export async function savePage(bookId, pageNumber, blob) {
  await run([S_PAGES], "readwrite", (tx) => tx.objectStore(S_PAGES).put({ bookId, n: pageNumber, blob }));
}

export async function getPage(bookId, pageNumber) {
  const rec = await run([S_PAGES], "readonly", (tx) => tx.objectStore(S_PAGES).get([bookId, pageNumber]));
  return rec ? rec.blob : null;
}

export async function deleteBookPages(bookId) {
  await run([S_PAGES], "readwrite", (tx) =>
    tx.objectStore(S_PAGES).delete(IDBKeyRange.bound([bookId, 0], [bookId, Infinity])));
}

/* ---------------- Original-PDF (optional) ---------------- */

export async function saveOriginalPdf(bookId, blob) {
  await run([S_FILES], "readwrite", (tx) => tx.objectStore(S_FILES).put({ id: bookId, blob }));
}

export async function getOriginalPdf(bookId) {
  const rec = await run([S_FILES], "readonly", (tx) => tx.objectStore(S_FILES).get(bookId));
  return rec ? rec.blob : null;
}

export async function deleteOriginalPdf(bookId) {
  await run([S_FILES], "readwrite", (tx) => tx.objectStore(S_FILES).delete(bookId));
}

/* ---------------- Einstellungen ---------------- */

export async function getSetting(key, fallback = null) {
  const rec = await run([S_META], "readonly", (tx) => tx.objectStore(S_META).get(key));
  return rec && rec.value !== undefined ? rec.value : fallback;
}

export async function setSetting(key, value) {
  await run([S_META], "readwrite", (tx) => tx.objectStore(S_META).put({ key, value }));
}

export async function deleteSetting(key) {
  await run([S_META], "readwrite", (tx) => tx.objectStore(S_META).delete(key));
}

/* ---------------- Aufräumen & Statistik ---------------- */

/** Entfernt Seiten/PDFs ohne Buch-Eintrag (abgebrochene Importe, Absturz). Nur beim App-Start aufrufen. */
export async function cleanupOrphans() {
  const db = await initDatabase();
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction([S_BOOKS, S_PAGES, S_FILES], "readonly");
    const out = {};
    const get = (name, store) => { const r = tx.objectStore(store).getAllKeys(); r.onsuccess = () => { out[name] = r.result; }; };
    get("books", S_BOOKS);
    get("pages", S_PAGES);
    get("files", S_FILES);
    tx.oncomplete = () => resolve(out);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("tx-error"));
  });
  const known = new Set(keys.books);
  const orphanIds = new Set();
  for (const k of keys.pages) if (!known.has(k[0])) orphanIds.add(k[0]);
  for (const k of keys.files) if (!known.has(k)) orphanIds.add(k);
  for (const id of orphanIds) {
    await deleteBookPages(id).catch(() => {});
    await deleteOriginalPdf(id).catch(() => {});
  }
  return orphanIds.size;
}

/** Speicherverbrauch der lokalen Bücher: { bookCount, bytes, perBook: Map(id → bytes) } */
export async function getStorageStats() {
  const db = await initDatabase();
  return new Promise((resolve, reject) => {
    const per = new Map();
    let count = 0;
    const tx = db.transaction([S_BOOKS, S_PAGES, S_FILES], "readonly");
    const add = (id, n) => per.set(id, (per.get(id) || 0) + n);
    const walk = (store, fn) => {
      const r = tx.objectStore(store).openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (c) { fn(c.value); c.continue(); }
      };
    };
    walk(S_BOOKS, (v) => { count++; add(v.id, v.coverBlob ? v.coverBlob.size : 0); });
    walk(S_PAGES, (v) => add(v.bookId, v.blob ? v.blob.size : 0));
    walk(S_FILES, (v) => add(v.id, v.blob ? v.blob.size : 0));
    tx.oncomplete = () => {
      let total = 0;
      for (const v of per.values()) total += v;
      resolve({ bookCount: count, bytes: total, perBook: per });
    };
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("tx-error"));
  });
}
