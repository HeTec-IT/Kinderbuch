/* Sichern & Wiederherstellen als ZIP-Datei.
   Aufbau:  manifest.json
            books/<id>/cover.jpg
            books/<id>/pages/001.jpg …
            books/<id>/original.pdf   (nur wenn gespeichert) */
import { buildZip, readZip } from "./zip.js";
import {
  getBooks, getPage, getOriginalPdf, savePage, saveBook, saveOriginalPdf,
  deleteBook, deleteBookPages, deleteOriginalPdf, getSetting, setSetting
} from "./db.js";
import { BACKUP_FORMAT, BACKUP_VERSION } from "./config.js";
import { fileSlug } from "./util.js";

/** kind: "invalid" | "newer" | "cancel" */
export class BackupError extends Error {
  constructor(kind, cause) { super(kind); this.kind = kind; this.cause = cause; }
}

const pageName = (i) => String(i + 1).padStart(3, "0") + ".jpg";
const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Bibliothek (oder einzelne Bücher) in eine ZIP-Datei packen. */
export async function exportLibrary({ bookIds = null, onProgress = () => {}, control = { cancelled: false } } = {}) {
  const all = await getBooks();
  const books = bookIds ? all.filter((b) => bookIds.includes(b.id)) : all;
  if (!books.length) throw new BackupError("invalid");

  const totalFiles = books.reduce((n, b) => n + b.pageCount + 1, 0);
  let seen = 0;
  const entries = [];
  const metas = [];
  for (const b of books) {
    const base = `books/${b.id}/`;
    const m = {
      id: b.id, title: b.title, subtitle: b.subtitle || "", category: b.category || "",
      order: b.order, active: b.active !== false, createdAt: b.createdAt || Date.now(),
      pageCount: b.pageCount, pageAspect: b.pageAspect, coverAspect: b.coverAspect || null,
      layout: b.layout || "", showCover: b.showCover !== false,
      pageWidth: b.pageWidth || 0, pageHeight: b.pageHeight || 0, hasPdf: false
    };
    if (b.coverBlob) entries.push({ name: base + "cover.jpg", data: b.coverBlob });
    for (let i = 0; i < b.pageCount; i++) {
      if (control.cancelled) throw new BackupError("cancel");
      const blob = await getPage(b.id, i);
      if (!blob) throw new BackupError("invalid");
      entries.push({ name: `${base}pages/${pageName(i)}`, data: blob });
      seen++;
      onProgress((seen / totalFiles) * 50, `Wird zusammengestellt … (${seen} von ${totalFiles})`);
    }
    const pdf = await getOriginalPdf(b.id);
    if (pdf) { entries.push({ name: base + "original.pdf", data: pdf }); m.hasPdf = true; }
    metas.push(m);
  }

  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    settings: { keepOriginalPdf: !!(await getSetting("keepPdf", false)) },
    books: metas
  };
  entries.unshift({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });

  if (control.cancelled) throw new BackupError("cancel");
  const blob = await buildZip(entries, (d, t) => onProgress(50 + (d / t) * 50, "Datei wird erstellt …"));
  const date = new Date().toISOString().slice(0, 10);
  const filename = bookIds && books.length === 1 ? `${fileSlug(books[0].title)}.zip` : `Kinderbuch-Backup-${date}.zip`;
  return { blob, filename, bookCount: books.length };
}

/** Backup-Datei prüfen (Aufbau, Version, alle Seiten vorhanden). */
export async function inspectBackup(file) {
  let zip;
  let manifest;
  try {
    zip = await readZip(file);
    manifest = JSON.parse(await (await zip.getBlob("manifest.json", "application/json")).text());
  } catch (e) {
    throw new BackupError("invalid", e);
  }
  if (!manifest || manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.books)) throw new BackupError("invalid");
  if (typeof manifest.version === "number" && manifest.version > BACKUP_VERSION) throw new BackupError("newer");

  let pageTotal = 0;
  for (const b of manifest.books) {
    if (!b || typeof b.id !== "string" || !SAFE_ID.test(b.id)) throw new BackupError("invalid");
    if (!Number.isInteger(b.pageCount) || b.pageCount < 1 || b.pageCount > 5000) throw new BackupError("invalid");
    for (let i = 0; i < b.pageCount; i++) {
      if (!zip.entries.has(`books/${b.id}/pages/${pageName(i)}`)) throw new BackupError("invalid");
    }
    pageTotal += b.pageCount;
  }
  return { zip, manifest, bookCount: manifest.books.length, pageTotal, createdAt: manifest.createdAt || null };
}

/**
 * Bücher aus einem geprüften Backup importieren.
 * mode "merge":   vorhandene Bücher (gleiche ID) bleiben, neue werden hinten angehängt.
 * mode "replace": Backup-Bücher überschreiben gleiche IDs, alle anderen Bücher werden danach gelöscht.
 */
export async function importLibrary(inspected, { mode = "merge", onProgress = () => {}, control = { cancelled: false } } = {}) {
  const { zip, manifest } = inspected;
  const existing = await getBooks();
  const existingIds = new Set(existing.map((b) => b.id));
  let order = existing.reduce((m, b) => Math.max(m, typeof b.order === "number" ? b.order : 0), 0);
  const total = manifest.books.reduce((n, b) => n + b.pageCount + 1, 0);
  let done = 0;
  let added = 0;
  let skipped = 0;
  const list = manifest.books.slice().sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const bk of list) {
    if (control.cancelled) throw new BackupError("cancel");
    if (existingIds.has(bk.id)) {
      if (mode === "merge") { skipped++; done += bk.pageCount + 1; continue; }
      await deleteBook(bk.id);
    }
    const base = `books/${bk.id}/`;
    try {
      for (let i = 0; i < bk.pageCount; i++) {
        if (control.cancelled) throw new BackupError("cancel");
        const blob = await zip.getBlob(`${base}pages/${pageName(i)}`, "image/jpeg");
        await savePage(bk.id, i, blob);
        done++;
        onProgress((done / total) * 100, `„${bk.title}“ – Seite ${i + 1} von ${bk.pageCount}`);
      }
      const coverBlob = zip.entries.has(base + "cover.jpg") ? await zip.getBlob(base + "cover.jpg", "image/jpeg") : null;
      let hasPdf = false;
      if (bk.hasPdf && zip.entries.has(base + "original.pdf")) {
        await saveOriginalPdf(bk.id, await zip.getBlob(base + "original.pdf", "application/pdf"));
        hasPdf = true;
      }
      order += 1;
      await saveBook({
        id: bk.id,
        title: String(bk.title || "Ohne Titel"),
        subtitle: String(bk.subtitle || ""),
        category: String(bk.category || ""),
        order: mode === "replace" && typeof bk.order === "number" ? bk.order : order,
        active: bk.active !== false,
        createdAt: bk.createdAt || Date.now(),
        pageCount: bk.pageCount,
        pageAspect: bk.pageAspect || 0.7,
        coverAspect: bk.coverAspect || undefined,
        layout: bk.layout || "",
        showCover: bk.showCover !== false,
        pageWidth: bk.pageWidth || 0,
        pageHeight: bk.pageHeight || 0,
        hasPdf,
        coverBlob
      });
      done++;
      added++;
    } catch (e) {
      await deleteBookPages(bk.id).catch(() => {});
      await deleteOriginalPdf(bk.id).catch(() => {});
      throw e;
    }
  }

  if (mode === "replace") {
    const keep = new Set(manifest.books.map((b) => b.id));
    for (const id of existingIds) if (!keep.has(id)) await deleteBook(id);
    if (manifest.settings && typeof manifest.settings.keepOriginalPdf === "boolean") {
      await setSetting("keepPdf", manifest.settings.keepOriginalPdf);
    }
  }
  return { added, skipped };
}

/* ---------------- Datei ausliefern (iPad: Teilen-Dialog → „In Dateien sichern“ / Google Drive) ---------------- */

export function canShareFile(blob, filename) {
  try {
    if (!navigator.share || !navigator.canShare) return false;
    return navigator.canShare({ files: [new File([blob], filename, { type: blob.type || "application/zip" })] });
  } catch (_) {
    return false;
  }
}

export async function shareFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || "application/zip" });
  await navigator.share({ files: [file], title: filename });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
