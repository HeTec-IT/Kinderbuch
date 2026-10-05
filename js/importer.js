/* PDF-Import: PDF → Seitenbilder (JPEG) → lokale Datenbank.
   Transaktionssicher: das Buch-Metadatum wird ZULETZT gespeichert. Bei Fehler oder Abbruch
   werden alle Seiten dieses Imports wieder entfernt. Eine Seite nach der anderen, Canvas
   wird sofort freigegeben (speicherschonend für Safari/iPadOS). */
import { openPdf, analyzePdf, renderDescriptor, canvasToBlob, releaseCanvas } from "./pdf-tools.js";
import { savePage, saveBook, deleteBookPages, saveOriginalPdf, deleteOriginalPdf, nextOrder } from "./db.js";
import { PAGE_IMAGE_LONG_SIDE, PAGE_IMAGE_QUALITY, COVER_WIDTH, COVER_QUALITY } from "./config.js";
import { newId, sleep } from "./util.js";

/** kind: "cancel" | "storage" | "pdf" | "read" */
export class ImportError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * @param {File} file
 * @param {{title:string, subtitle?:string, category?:string, layout?:string, keepPdf?:boolean,
 *          onProgress?:(p:{stage:string,done:number,total:number,percent:number})=>void,
 *          control?:{cancelled:boolean}}} opts
 */
export async function importPdf(file, opts) {
  const {
    title, subtitle = "", category = "", layout = "auto", keepPdf = false,
    onProgress = () => {}, control = { cancelled: false }
  } = opts;
  const id = newId();
  let doc = null;
  const check = () => { if (control.cancelled) throw new ImportError("cancel"); };
  const store = async (fn) => {
    try { return await fn(); } catch (e) { throw new ImportError("storage", e); }
  };

  try {
    onProgress({ stage: "read", done: 0, total: 0, percent: 1 });
    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) { throw new ImportError("read", e); }
    check();
    try { doc = await openPdf({ data: buf }); } catch (e) { throw new ImportError("pdf", e); }
    buf = null;

    let info;
    try { info = await analyzePdf(doc, layout); } catch (e) { throw new ImportError("pdf", e); }
    const total = info.pages.length;
    let pageW = 0;
    let pageH = 0;

    for (let i = 0; i < total; i++) {
      check();
      let canvas;
      let blob;
      try {
        canvas = await renderDescriptor(doc, info.pages[i], { longSide: PAGE_IMAGE_LONG_SIDE });
        if (i === 0) { pageW = canvas.width; pageH = canvas.height; }
        blob = await canvasToBlob(canvas, "image/jpeg", PAGE_IMAGE_QUALITY);
      } catch (e) {
        throw new ImportError("pdf", e);
      } finally {
        releaseCanvas(canvas);
      }
      await store(() => savePage(id, i, blob));
      blob = null;
      onProgress({ stage: "pages", done: i + 1, total, percent: 5 + Math.round(((i + 1) / total) * 90) });
      await sleep(20); // UI darf zwischendurch zeichnen
    }

    check();
    let coverBlob;
    let cc;
    try {
      cc = await renderDescriptor(doc, info.pages[0], { width: COVER_WIDTH });
      coverBlob = await canvasToBlob(cc, "image/jpeg", COVER_QUALITY);
    } catch (e) {
      throw new ImportError("pdf", e);
    } finally {
      releaseCanvas(cc);
    }

    onProgress({ stage: "finish", done: total, total, percent: 97 });
    if (keepPdf) await store(() => saveOriginalPdf(id, file));
    check();

    const book = {
      id,
      title,
      subtitle,
      category,
      order: await nextOrder(),
      active: true,
      createdAt: Date.now(),
      pageCount: total,
      pageAspect: info.pageAspect,
      layout: info.layout,
      showCover: info.showCover,
      pageWidth: pageW,
      pageHeight: pageH,
      hasPdf: !!keepPdf,
      coverBlob
    };
    await store(() => saveBook(book)); // erst jetzt ist das Buch „da“
    onProgress({ stage: "done", done: total, total, percent: 100 });
    return book;
  } catch (err) {
    await deleteBookPages(id).catch(() => {});
    await deleteOriginalPdf(id).catch(() => {});
    throw err instanceof ImportError ? err : new ImportError("pdf", err);
  } finally {
    try { if (doc) doc.destroy(); } catch (_) { /* egal */ }
  }
}
