/* Lesemodus: Vollbild-Bilderbuch mit echtem Umblättern (StPageFlip, HTML-Modus).
   Die Seiten kommen als fertige Bilder aus der lokalen Datenbank (IndexedDB) –
   schnell und komplett offline. */
import { SwipeFlip } from "./swipe-flip.js";
import { getPage } from "./db.js";
import { FLIP_TIME_MS, EXIT_TAPS, EXIT_TAP_WINDOW_MS } from "./config.js";
import { el, exitFullscreen } from "./util.js";

/* Wie viele Seiten rund um die aktuelle Seite im Speicher gehalten werden */
const KEEP_BEHIND = 3;
const KEEP_AHEAD = 4;

/* ---------------- Seitenquelle: Bilder aus der lokalen Datenbank ---------------- */

class LocalSource {
  constructor(book) {
    this.book = book;
    this.count = book.pageCount | 0;
    this.showCover = book.showCover !== false;
    this.aspect = book.pageAspect || (book.pageWidth && book.pageHeight ? book.pageWidth / book.pageHeight : 0) || 0.7;
    this.cache = new Map(); // Seitenindex → Promise<Objekt-URL>
  }
  async init() {
    if (!this.count) throw new Error("Keine Seiten");
  }
  setTargetSize() {}
  getUrl(i) {
    let p = this.cache.get(i);
    if (!p) {
      p = getPage(this.book.id, i).then((blob) => {
        if (!blob) throw new Error("Seite fehlt");
        return URL.createObjectURL(blob);
      });
      this.cache.set(i, p);
      p.catch(() => { if (this.cache.get(i) === p) this.cache.delete(i); });
    }
    return p;
  }
  /** Objekt-URL einer nicht mehr benötigten Seite freigeben (Speicher!). */
  release(i) {
    const p = this.cache.get(i);
    if (!p) return;
    this.cache.delete(i);
    p.then((u) => URL.revokeObjectURL(u), () => {});
  }
  dispose() {
    for (const i of [...this.cache.keys()]) this.release(i);
  }
}

/* ---------------- Leser ---------------- */

export class Reader {
  constructor({ root, area, sizer, exitBtn, loading, error, retryBtn, backBtn, onClose }) {
    Object.assign(this, { root, area, sizer, exitBtn, loading, error, retryBtn, backBtn, onClose });
    this.pf = null;
    this.source = null;
    this.imgs = new Map();
    this.shells = [];
    this.key = "";
    this.token = 0;
    this.isOpen = false;

    this.swipe = new SwipeFlip(root, () => this.pf, { ignore: [exitBtn, error] });
    this.swipe.enabled = false;

    this._setupExit();
    this.retryBtn.addEventListener("click", () => this.book && this.open(this.book));
    this.backBtn.addEventListener("click", () => this.close());

    let t = null;
    this.ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => this.isOpen && this.source && this.build(false), 120);
    });
    this.ro.observe(area);

    window.addEventListener("keydown", (e) => {
      if (!this.isOpen || !this.pf || this.pf.getState() !== "read") return;
      if (e.key === "ArrowRight" && this.swipe.canFlip(this.pf, "next")) this.pf.flipNext("bottom");
      if (e.key === "ArrowLeft" && this.swipe.canFlip(this.pf, "prev")) this.pf.flipPrev("bottom");
    });
  }

  /* Versteckter Zurück-Button: 4× innerhalb von 3 s tippen */
  _setupExit() {
    let taps = 0;
    let first = 0;
    let timer = null;
    const reset = () => {
      taps = 0;
      this.exitBtn.dataset.taps = "0";
    };
    this.exitBtn.addEventListener("touchstart", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    this.exitBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    this.exitBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (!taps || now - first > EXIT_TAP_WINDOW_MS) { taps = 0; first = now; }
      taps++;
      this.exitBtn.dataset.taps = String(Math.min(taps, 3));
      clearTimeout(timer);
      timer = setTimeout(reset, EXIT_TAP_WINDOW_MS - (now - first));
      if (taps >= EXIT_TAPS) {
        clearTimeout(timer);
        reset();
        this.close();
      }
    });
  }

  async open(book) {
    const token = ++this.token;
    this._teardown();
    this.book = book;
    this.isOpen = true;
    this.root.hidden = false;
    this.root.classList.add("is-visible");
    this.error.hidden = true;
    this.loading.hidden = false;
    this.loading.classList.remove("is-done");
    this.swipe.enabled = false;

    try {
      const source = new LocalSource(book);
      this.source = source;
      await source.init();
      if (token !== this.token) return;
      this.build(true);
      await this._waitVisible(token, 20000);
      if (token !== this.token) return;
      this.loading.classList.add("is-done");
      setTimeout(() => { if (token === this.token) this.loading.hidden = true; }, 260);
      this.swipe.enabled = true;
    } catch (err) {
      if (token !== this.token) return;
      console.warn("Buch konnte nicht geöffnet werden:", err);
      this._teardown();
      this.loading.hidden = true;
      this.error.hidden = false;
    }
  }

  close() {
    this.token++;
    this.isOpen = false;
    this.swipe.enabled = false;
    this._teardown();
    this.root.classList.remove("is-visible");
    this.root.hidden = true;
    this.error.hidden = true;
    exitFullscreen();
    if (this.onClose) this.onClose();
  }

  _teardown() {
    if (this.pf) {
      try { this.pf.destroy(); } catch (_) { /* egal */ }
      this.pf = null;
    }
    for (const entry of this.imgs.values()) this._dropImg(entry);
    this.imgs.clear();
    this.shells = [];
    this.sizer.innerHTML = "";
    this.key = "";
    if (this.source) {
      this.source.dispose();
      this.source = null;
    }
  }

  /* Buchgröße berechnen und StPageFlip (neu) aufbauen */
  build(force) {
    const src = this.source;
    if (!src) return;
    const W = this.area.clientWidth;
    const H = this.area.clientHeight;
    if (W < 20 || H < 20) return;
    const a = src.aspect;
    const n = src.count;
    const twoH = Math.min(H, W / (2 * a));
    const oneH = Math.min(H, W / a);
    // Doppelseite nur, wenn sie nicht deutlich kleiner wird als eine Einzelseite
    const two = n > 1 && twoH >= 0.72 * oneH;
    const pageH = Math.max(50, Math.floor(two ? twoH : oneH));
    const pageW = Math.max(30, Math.floor(pageH * a));
    const key = `${pageW}x${pageH}x${two}`;
    if (!force && key === this.key) return;
    this.key = key;

    const startPage = this.pf ? this.pf.getCurrentPageIndex() : 0;
    if (this.pf) {
      try { this.pf.destroy(); } catch (_) { /* egal */ }
      this.pf = null;
    }
    src.setTargetSize(pageW, pageH);

    this.sizer.innerHTML = "";
    this.sizer.style.width = (two ? pageW * 2 : pageW) + "px";
    this.sizer.style.height = pageH + "px";
    const rootEl = el("div", { class: "book-root" });
    this.sizer.appendChild(rootEl);

    this.shells = [];
    for (let i = 0; i < n; i++) {
      const shell = el("div", { class: "page", "data-density": "soft" });
      const entry = this.imgs.get(i);
      if (entry) shell.appendChild(entry.img);
      this.shells.push(shell);
    }

    const pf = new window.St.PageFlip(rootEl, {
      width: pageW,
      height: pageH,
      size: "fixed",
      autoSize: true,
      usePortrait: !two,
      showCover: !!src.showCover,
      startPage: Math.min(startPage, n - 1),
      drawShadow: true,
      maxShadowOpacity: 0.45,
      flippingTime: FLIP_TIME_MS,
      useMouseEvents: false,
      mobileScrollSupport: false,
      showPageCorners: false,
      disableFlipByClick: true,
      clickEventForward: false,
      startZIndex: 0
    });
    pf.loadFromHTML(this.shells);
    pf.on("flip", (e) => this._updateWindow(e.data));
    this.pf = pf;
    this._updateWindow(Math.min(startPage, n - 1));
  }

  _visibleIndices(center) {
    const n = this.source ? this.source.count : 0;
    return [center, center + 1].filter((i) => i >= 0 && i < n);
  }

  _updateWindow(center) {
    if (!this.source) return;
    const n = this.source.count;
    const lo = center - KEEP_BEHIND;
    const hi = center + KEEP_AHEAD;
    for (const [i, entry] of this.imgs) {
      if (i < lo || i > hi) {
        this._dropImg(entry);
        this.imgs.delete(i);
        this.source.release(i);
      }
    }
    const order = [0, 1, 2, -1, 3, 4, -2, -3];
    for (const d of order) {
      const i = center + d;
      if (i >= 0 && i < n) this._ensure(i).catch(() => {});
    }
  }

  _ensure(i) {
    const existing = this.imgs.get(i);
    if (existing) {
      const shell = this.shells[i];
      if (shell && existing.img.parentNode !== shell) shell.appendChild(existing.img);
      return existing.ready;
    }
    const img = new Image();
    img.className = "page-img";
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    const entry = { img, ready: null };
    entry.ready = (async () => {
      const url = await this.source.getUrl(i);
      if (this.imgs.get(i) !== entry) return;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      try { await img.decode(); } catch (_) { /* bereits geladen – reicht */ }
    })();
    entry.ready.catch(() => {
      if (this.imgs.get(i) === entry) {
        this.imgs.delete(i);
        this._dropImg(entry);
      }
    });
    this.imgs.set(i, entry);
    const shell = this.shells[i];
    if (shell) shell.appendChild(img);
    return entry.ready;
  }

  _dropImg(entry) {
    const img = entry.img;
    img.onload = img.onerror = null;
    img.removeAttribute("src");
    img.remove();
  }

  async _waitVisible(token, timeoutMs) {
    const start = Date.now();
    while (token === this.token) {
      const pf = this.pf;
      const center = pf ? pf.getCurrentPageIndex() : 0;
      const idx = this._visibleIndices(center);
      try {
        await Promise.race([
          Promise.all(idx.map((i) => this._ensure(i))),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))
        ]);
        return;
      } catch (err) {
        if (Date.now() - start > timeoutMs) throw err;
        // einmal erneut versuchen (z. B. kurzer Netzaussetzer)
        await new Promise((r) => setTimeout(r, 800));
        if (Date.now() - start > timeoutMs) throw err;
      }
    }
  }
}
