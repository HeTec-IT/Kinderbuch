/* Bücher aus dem Repository (Ordner library/) einmalig aufs Gerät laden.
   - library/books.json listet die Bücher; jedes Buch hat cover.jpg und p001.jpg, p002.jpg …
   - Übersetzte Fassungen (z. B. Português) können mit "base" auf das Original-Buch verweisen:
     "own" nennt die Seiten (1-basiert), die im eigenen Ordner liegen, alle anderen kommen aus dem
     Ordner von "base". "ownCover": false = Titelbild vom Original.
   - Geladene Bücher liegen danach ganz normal in der lokalen Datenbank (offline lesbar).
   - Selbst gelöschte Repo-Bücher kommen nicht wieder.
   - "removed": [ids] in books.json entfernt Repo-Bücher auch von Geräten, die sie schon geladen haben.
   - Fehler/Offline: stilles Überspringen, nächster Start versucht es erneut. */
import { getBook, saveBook, deleteBook, savePage, deleteBookPages, getSetting, setSetting, nextOrder } from "./db.js";

const BASE = "library/";
const DELETED_KEY = "deletedRepoBooks";

export async function markRepoBookDeleted(id) {
  try {
    const list = await getSetting(DELETED_KEY, []);
    if (!list.includes(id)) await setSetting(DELETED_KEY, [...list, id]);
  } catch (_) { /* egal */ }
}

async function fetchBlob(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.blob();
}

/** onBook(book) wird nach jedem fertig geladenen Buch aufgerufen, onStart() einmal vor dem ersten Download. */
export async function syncRepoLibrary({ onStart, onBook } = {}) {
  let manifest;
  try {
    const res = await fetch(BASE + "books.json", { cache: "no-cache" });
    if (!res.ok) return 0;
    manifest = await res.json();
  } catch (_) {
    return 0; // offline oder kein Ordner library/
  }
  const entries = Array.isArray(manifest && manifest.books) ? manifest.books : [];
  const deleted = await getSetting(DELETED_KEY, []);
  const removed = Array.isArray(manifest && manifest.removed) ? manifest.removed : [];
  for (const id of removed) {
    try {
      const b = await getBook(id);
      if (b && b.source === "repo") { await deleteBook(id); if (onBook) onBook(b); }
    } catch (_) { /* egal */ }
  }
  let added = 0;
  let started = false;

  for (const e of entries) {
    if (!e || !e.id || !e.pages || deleted.includes(e.id)) continue;
    const existing = await getBook(e.id);
    // Regal („Kategorie“) aus dem Repo nachziehen, solange es auf dem Gerät nicht selbst geändert wurde
    if (existing && existing.source === "repo") {
      const was = existing.repoCategory || "";
      const now = e.category || "";
      if (now !== was && (existing.category || "") === was) {
        existing.category = now;
        existing.repoCategory = now;
        try { await saveBook(existing); if (onBook) onBook(existing); } catch (_) { /* egal */ }
      }
    }
    if (existing && existing.repoRev === e.rev) continue;
    try {
      if (!started) { started = true; if (onStart) onStart(); }
      const dir = BASE + e.dir + "/";
      const baseDir = e.base ? BASE + e.base + "/" : dir;
      const own = Array.isArray(e.own) ? new Set(e.own) : null;
      const coverBlob = await fetchBlob((e.base && e.ownCover === false ? baseDir : dir) + "cover.jpg");
      if (existing) await deleteBookPages(e.id);
      for (let i = 0; i < e.pages; i++) {
        const src = own && !own.has(i + 1) ? baseDir : dir;
        const blob = await fetchBlob(src + "p" + String(i + 1).padStart(3, "0") + ".jpg");
        await savePage(e.id, i, blob);
      }
      const book = {
        id: e.id,
        title: (existing && existing.title) || e.title,
        subtitle: (existing && existing.subtitle) || e.subtitle || "",
        category: existing ? existing.category : (e.category || ""),
        order: existing ? existing.order : (typeof e.order === "number" ? e.order : await nextOrder()),
        active: existing ? existing.active : true,
        createdAt: existing ? existing.createdAt : Date.now(),
        pageCount: e.pages,
        pageAspect: e.pageAspect,
        layout: e.layout,
        showCover: e.showCover,
        pageWidth: e.pageWidth,
        pageHeight: e.pageHeight,
        hasPdf: false,
        source: "repo",
        repoRev: e.rev,
        repoCategory: existing && existing.repoCategory !== undefined ? existing.repoCategory : (e.category || ""),
        coverBlob
      };
      await saveBook(book); // erst jetzt ist das Buch „da“
      added++;
      if (onBook) onBook(book);
    } catch (err) {
      console.warn("Repo-Buch konnte nicht geladen werden:", e.id, err);
      if (!existing) await deleteBookPages(e.id).catch(() => {});
    }
  }
  return added;
}
