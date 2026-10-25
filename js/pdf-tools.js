/* PDF.js-Werkzeuge: Laden, Layout erkennen, Seiten 1:1 rendern.
   Wird vom Adminbereich (Hochladen) und vom Leser (Fallback ohne
   vorgerenderte Seitenbilder) verwendet. */
import { loadScript } from "./util.js";

const BASE = new URL(".", document.baseURI);
const PDFJS_SRC = "vendor/pdfjs/pdf.min.js";
const WORKER_SRC = new URL("vendor/pdfjs/pdf.worker.min.js", BASE).href;
const STANDARD_FONTS = new URL("vendor/pdfjs/standard_fonts/", BASE).href;

export async function loadPdfJs() {
  if (!window.pdfjsLib) await loadScript(PDFJS_SRC);
  const lib = window.pdfjsLib;
  if (!lib) throw new Error("PDF.js nicht verfügbar");
  lib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
  return lib;
}

/** src = { data: ArrayBuffer|Uint8Array } oder { url: string } */
export async function openPdf(src) {
  const lib = await loadPdfJs();
  const params = {
    standardFontDataUrl: STANDARD_FONTS,
    isEvalSupported: false,
    enableXfa: false,
    // Ganze Datei in einem Request laden → vom Service Worker cachebar
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true
  };
  if (src.data) params.data = src.data instanceof Uint8Array ? src.data : new Uint8Array(src.data);
  else params.url = src.url;
  return lib.getDocument(params).promise;
}

/**
 * Öffnet eine PDF direkt aus einer File-Auswahl, ohne die ganze Datei in den Speicher zu laden:
 * pdf.js fordert nur die benötigten Bereiche an (File.slice). Wirft NotReadableError o. Ä.,
 * wenn die Datei nicht lesbar ist (z. B. Cloud-Datei, die noch nicht heruntergeladen ist).
 */
export async function openPdfFile(file) {
  const lib = await loadPdfJs();
  const first = new Uint8Array(await file.slice(0, Math.min(file.size, 65536)).arrayBuffer());
  class FileTransport extends lib.PDFDataRangeTransport {
    requestDataRange(begin, end) {
      file.slice(begin, end).arrayBuffer().then(
        (buf) => this.onDataRange(begin, new Uint8Array(buf)),
        () => { /* Fehler zeigt sich als Timeout/PDF-Fehler */ }
      );
    }
  }
  return lib.getDocument({
    range: new FileTransport(file.size, first),
    length: file.size,
    standardFontDataUrl: STANDARD_FONTS,
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true
  }).promise;
}

/* ---------- Layout-Erkennung ---------- */

async function halfBlankness(page) {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = 240 / vp1.width;
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  const half = Math.floor(width / 2);
  const ratio = (x0, x1) => {
    let blank = 0, total = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * width + x) * 4;
        total++;
        if (data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238) blank++;
      }
    }
    return total ? blank / total : 1;
  };
  const left = ratio(2, half - 2);
  const right = ratio(half + 2, width - 2);
  c.width = c.height = 0;
  return { leftBlank: left > 0.985, rightBlank: right > 0.985 };
}

/**
 * Ermittelt, wie die PDF als Buch gezeigt wird.
 * layout "spread": jede (Quer-)PDF-Seite ist eine Doppelseite → wird in
 *                  linke/rechte Buchseite geteilt (echtes Buch-Umblättern).
 * layout "single": jede PDF-Seite ist eine Buchseite.
 * forced: "auto" | "spread" | "single"
 */
export async function analyzePdf(doc, forced = "auto") {
  const p1 = await doc.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  const aspect = vp.width / vp.height;
  const layout = forced === "spread" || forced === "single" ? forced : aspect > 1.15 ? "spread" : "single";

  let cover = false;
  let backCover = false;
  if (layout === "spread") {
    const a = await halfBlankness(p1);
    cover = a.leftBlank && !a.rightBlank;
    if (doc.numPages > 1) {
      const last = await doc.getPage(doc.numPages);
      const b = await halfBlankness(last);
      backCover = b.rightBlank && !b.leftBlank;
      last.cleanup();
    }
  }
  p1.cleanup();

  const pages = [];
  if (layout === "spread") {
    for (let n = 1; n <= doc.numPages; n++) {
      const isFirst = n === 1;
      const isLast = n === doc.numPages && n > 1;
      if (!(isFirst && cover)) pages.push({ page: n, part: "left" });
      if (!(isLast && backCover)) pages.push({ page: n, part: "right" });
    }
  } else {
    for (let n = 1; n <= doc.numPages; n++) pages.push({ page: n, part: "full" });
  }

  return {
    layout,
    showCover: layout === "single" ? true : cover,
    pageAspect: layout === "spread" ? vp.width / 2 / vp.height : aspect,
    pages,
    pdfPageCount: doc.numPages,
    pdfWidthPt: vp.width,
    pdfHeightPt: vp.height
  };
}

/* ---------- Rendern ---------- */

/**
 * Rendert eine Buchseite (ganze PDF-Seite oder linke/rechte Hälfte) 1:1.
 * size: { longSide } oder { width }
 */
export async function renderDescriptor(doc, desc, size) {
  const page = await doc.getPage(desc.page);
  try {
    const vp1 = page.getViewport({ scale: 1 });
    const partW = desc.part === "full" ? vp1.width : vp1.width / 2;
    const partH = vp1.height;
    let scale = size.width ? size.width / partW : size.longSide / Math.max(partW, partH);
    // iOS-Canvas-Grenze (~16,7 MP) sicher einhalten
    const maxPixels = 12e6;
    if (partW * scale * partH * scale > maxPixels) scale = Math.sqrt(maxPixels / (partW * partH));
    const vp = page.getViewport({ scale });
    const cw = Math.max(1, Math.round(partW * scale));
    const ch = Math.max(1, Math.round(partH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    const transform = desc.part === "right" ? [1, 0, 0, 1, -(vp.width - cw), 0] : null;
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      transform,
      background: "#ffffff",
      intent: "display"
    }).promise;
    return canvas;
  } finally {
    page.cleanup();
  }
}

export function canvasToBlob(canvas, type = "image/jpeg", quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob fehlgeschlagen"))), type, quality);
  });
}

export function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}
