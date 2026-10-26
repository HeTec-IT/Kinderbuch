/* Ein Buch als PDF-Datei speichern (Elternbereich).
   - Ist das Original-PDF auf dem Gerät gespeichert, wird genau dieses gegeben.
   - Sonst wird aus den Seitenbildern ein PDF gebaut (JPEGs werden 1:1 eingebettet, nichts wird neu komprimiert).
     Bei Doppelseiten-Büchern entstehen wieder Querformat-Doppelseiten (Cover einzeln rechts). */
import { getBook, getPage, getOriginalPdf } from "./db.js";
import { fileSlug } from "./util.js";

const PT_PER_PX = 0.24; // 300 dpi

function jpegInfo(u8) {
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xff) { i++; continue; }
    const m = u8[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (u8[i + 5] << 8) | u8[i + 6], w: (u8[i + 7] << 8) | u8[i + 8], comps: u8[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

/** Bild in ein DeviceRGB-/Gray-JPEG bringen (nur falls es kein passendes JPEG ist). */
async function toJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const out = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.93));
  c.width = c.height = 0;
  return out;
}

async function loadImage(blob) {
  let b = blob;
  let u8 = new Uint8Array(await b.arrayBuffer());
  let info = jpegInfo(u8);
  if (!info || (info.comps !== 3 && info.comps !== 1)) {
    b = await toJpeg(blob);
    u8 = new Uint8Array(await b.arrayBuffer());
    info = jpegInfo(u8);
    if (!info) throw new Error("Bildformat nicht lesbar");
  }
  return { blob: b, w: info.w, h: info.h, comps: info.comps };
}

function utf16hex(s) {
  let h = "FEFF";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return "<" + h + ">";
}

/** → { blob, filename } */
export async function exportBookPdf(bookId, { onProgress = () => {}, control = { cancelled: false } } = {}) {
  const book = await getBook(bookId);
  if (!book) throw new Error("Buch nicht gefunden");
  const filename = fileSlug(book.title) + ".pdf";

  const orig = await getOriginalPdf(bookId);
  if (orig) return { blob: orig.type === "application/pdf" ? orig : new Blob([orig], { type: "application/pdf" }), filename };

  const imgs = [];
  for (let i = 0; i < book.pageCount; i++) {
    if (control.cancelled) { const e = new Error("cancel"); e.kind = "cancel"; throw e; }
    const blob = await getPage(bookId, i);
    if (!blob) throw new Error("Seite fehlt");
    imgs.push(await loadImage(blob));
    onProgress(((i + 1) / book.pageCount) * 80, `Wird zusammengestellt … (${i + 1} von ${book.pageCount})`);
  }

  // Seitenfolge: [links, rechts] (null = leer)
  const spread = book.layout === "spread";
  const sheets = [];
  if (spread) {
    let k = 0;
    if (book.showCover !== false) sheets.push([null, 0]), (k = 1);
    for (; k < imgs.length; k += 2) sheets.push([k, k + 1 < imgs.length ? k + 1 : null]);
  } else {
    for (let k = 0; k < imgs.length; k++) sheets.push([k]);
  }

  const cw = imgs[0].w * PT_PER_PX;
  const ch = imgs[0].h * PT_PER_PX;
  const enc = new TextEncoder();
  const parts = [];
  const xref = [];
  let off = 0;
  const push = (x) => {
    if (typeof x === "string") { const b = enc.encode(x); parts.push(b); off += b.length; }
    else { parts.push(x); off += x.size !== undefined ? x.size : x.length; }
  };
  const begin = (n) => { xref[n] = off; push(`${n} 0 obj\n`); };
  const num = (v) => String(Math.round(v * 100) / 100);

  const nImg = imgs.length;
  const imgObj = (k) => 4 + k;
  const contentObj = (j) => 4 + nImg + 2 * j;
  const pageObj = (j) => 4 + nImg + 2 * j + 1;
  const total = 4 + nImg + 2 * sheets.length; // = Anzahl Objekte + 1

  push("%PDF-1.4\n%âãÏÓ\n");
  begin(1); push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2);
  push(`<< /Type /Pages /Count ${sheets.length} /Kids [${sheets.map((_, j) => pageObj(j) + " 0 R").join(" ")}] >>\nendobj\n`);
  begin(3); push(`<< /Title ${utf16hex(book.title || "")} /Producer (Unsere Buecher) >>\nendobj\n`);

  imgs.forEach((im, k) => {
    begin(imgObj(k));
    push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.comps === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.blob.size} >>\nstream\n`);
    push(im.blob);
    push("\nendstream\nendobj\n");
    onProgress(80 + ((k + 1) / nImg) * 15, "PDF wird geschrieben …");
  });

  sheets.forEach((sh, j) => {
    const W = cw * sh.length;
    let content = "";
    const xo = [];
    sh.forEach((k, side) => {
      if (k === null) return;
      content += `q ${num(cw)} 0 0 ${num(ch)} ${num(side * cw)} 0 cm /Im${k} Do Q\n`;
      xo.push(`/Im${k} ${imgObj(k)} 0 R`);
    });
    begin(contentObj(j));
    push(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
    begin(pageObj(j));
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(ch)}] /Resources << /XObject << ${xo.join(" ")} >> >> /Contents ${contentObj(j)} 0 R >>\nendobj\n`);
  });

  const xrefAt = off;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) x += String(xref[n]).padStart(10, "0") + " 00000 n \n";
  x += `trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(x);

  onProgress(100, "Fertig");
  return { blob: new Blob(parts, { type: "application/pdf" }), filename };
}
