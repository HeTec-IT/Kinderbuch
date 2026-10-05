/* Minimaler ZIP-Writer/-Reader (ohne Kompression – JPEGs sind schon komprimiert).
   Die Backup-Dateien sind normale ZIP-Dateien und lassen sich auch am PC öffnen. */

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

/** CRC-32 über einen Blob, in 2-MB-Stücken (speicherschonend). */
export async function crc32Blob(blob) {
  const t = table();
  let crc = 0xffffffff;
  const CH = 2 * 1024 * 1024;
  for (let o = 0; o < blob.size; o += CH) {
    const bytes = new Uint8Array(await blob.slice(o, o + CH).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

/** entries: [{ name, data: Blob | string | Uint8Array }] → Blob (application/zip) */
export async function buildZip(entries, onProgress) {
  if (entries.length >= 0xffff) throw new Error("zip-too-many-files");
  const parts = [];
  const central = [];
  const stamp = dosDateTime(new Date());
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = enc.encode(e.name);
    const data = e.data instanceof Blob ? e.data : new Blob([e.data]);
    if (data.size >= 0xffffffff) throw new Error("zip-too-large");
    const crc = await crc32Blob(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);          // Namen in UTF-8
    lh.setUint16(8, 0, true);               // gespeichert, nicht komprimiert
    lh.setUint16(10, stamp.time, true);
    lh.setUint16(12, stamp.date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.size, true);
    lh.setUint32(22, data.size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, stamp.time, true);
    ch.setUint16(14, stamp.date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.size, true);
    ch.setUint32(24, data.size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push({ head: new Uint8Array(ch.buffer), name });

    offset += 30 + name.length + data.size;
    if (offset >= 0xffffffff) throw new Error("zip-too-large");
    if (onProgress) onProgress(i + 1, entries.length);
  }

  let cdSize = 0;
  for (const c of central) {
    parts.push(c.head, c.name);
    cdSize += 46 + c.name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  parts.push(new Uint8Array(end.buffer));
  return new Blob(parts, { type: "application/zip" });
}

/** Liest das Inhaltsverzeichnis einer ZIP-Datei (File/Blob). Dateien werden erst bei getBlob() gelesen. */
export async function readZip(file) {
  const size = file.size;
  if (size < 22) throw new Error("zip-invalid");
  const tailLen = Math.min(size, 22 + 65535);
  const tail = new DataView(await file.slice(size - tailLen, size).arrayBuffer());
  let p = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  }
  if (p < 0) throw new Error("zip-invalid");
  const count = tail.getUint16(p + 10, true);
  const cdSize = tail.getUint32(p + 12, true);
  const cdOffset = tail.getUint32(p + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("zip64-unsupported");

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = new Map();
  let q = 0;
  for (let i = 0; i < count; i++) {
    if (q + 46 > cd.byteLength || cd.getUint32(q, true) !== 0x02014b50) throw new Error("zip-invalid");
    const method = cd.getUint16(q + 10, true);
    const crc = cd.getUint32(q + 16, true);
    const csize = cd.getUint32(q + 20, true);
    const usize = cd.getUint32(q + 24, true);
    const nl = cd.getUint16(q + 28, true);
    const xl = cd.getUint16(q + 30, true);
    const cl = cd.getUint16(q + 32, true);
    const off = cd.getUint32(q + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + q + 46, nl));
    entries.set(name, { name, method, crc, csize, usize, off });
    q += 46 + nl + xl + cl;
  }

  async function getBlob(name, type = "application/octet-stream", verify = true) {
    const e = entries.get(name);
    if (!e) throw new Error("zip-missing:" + name);
    const lh = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("zip-invalid");
    const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = file.slice(start, start + e.csize);
    let blob;
    if (e.method === 0) {
      blob = raw.slice(0, raw.size, type);
    } else if (e.method === 8) {
      if (typeof DecompressionStream === "undefined") throw new Error("zip-deflate-unsupported");
      const out = await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
      blob = out.slice(0, out.size, type);
    } else {
      throw new Error("zip-method-unsupported");
    }
    if (verify && e.crc && (await crc32Blob(blob)) !== e.crc) throw new Error("zip-crc:" + name);
    return blob;
  }

  return { entries, getBlob };
}
