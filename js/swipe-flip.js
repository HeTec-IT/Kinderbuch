/* Eigene Wisch-Steuerung für StPageFlip.
   - Nur bewusstes waagrechtes Wischen blättert (kein Tippen, keine Ecken).
   - Die Seite folgt dem Finger (echter Page-Curl), egal wo das Wischen beginnt.
   - Rechts → links = nächste Seite, links → rechts = vorherige Seite.
   - Zwei Finger, Zoom, Scrollen usw. werden komplett ignoriert/unterdrückt. */

const LOCK_PX = 14;        // ab dieser Strecke gilt eine Bewegung als Wischen
const GAIN = 2.0;          // Seitenecke bewegt sich schneller als der Finger
const COMMIT_PROGRESS = 0.28;
const COMMIT_VELOCITY = 0.35; // px/ms

export class SwipeFlip {
  /**
   * @param {HTMLElement} surface  Fläche, die die Gesten empfängt
   * @param {() => any} getPageFlip liefert die aktuelle PageFlip-Instanz
   * @param {Object} [opts]
   * @param {HTMLElement[]} [opts.ignore] Elemente, deren Berührung ignoriert wird
   */
  constructor(surface, getPageFlip, opts = {}) {
    this.surface = surface;
    this.getPf = getPageFlip;
    this.ignore = opts.ignore || [];
    this.pointers = new Set();
    this.g = null;
    this.busy = false;
    this.enabled = true;

    this._down = this._down.bind(this);
    this._move = this._move.bind(this);
    this._up = this._up.bind(this);
    this._cancel = this._cancel.bind(this);
    this._blockTouch = this._blockTouch.bind(this);
    this._blockEvt = (e) => e.preventDefault();

    surface.addEventListener("pointerdown", this._down);
    surface.addEventListener("pointermove", this._move);
    surface.addEventListener("pointerup", this._up);
    surface.addEventListener("pointercancel", this._cancel);
    surface.addEventListener("lostpointercapture", this._cancel);
    // Browser-Gesten (Scrollen, Zoom, Lupe, Kontextmenü) hart unterdrücken
    surface.addEventListener("touchstart", this._blockTouch, { passive: false });
    surface.addEventListener("touchmove", this._blockTouch, { passive: false });
    surface.addEventListener("touchend", this._blockTouch, { passive: false });
    surface.addEventListener("contextmenu", this._blockEvt);
    surface.addEventListener("dblclick", this._blockEvt);
    surface.addEventListener("dragstart", this._blockEvt);
  }

  destroy() {
    const s = this.surface;
    s.removeEventListener("pointerdown", this._down);
    s.removeEventListener("pointermove", this._move);
    s.removeEventListener("pointerup", this._up);
    s.removeEventListener("pointercancel", this._cancel);
    s.removeEventListener("lostpointercapture", this._cancel);
    s.removeEventListener("touchstart", this._blockTouch);
    s.removeEventListener("touchmove", this._blockTouch);
    s.removeEventListener("touchend", this._blockTouch);
    s.removeEventListener("contextmenu", this._blockEvt);
    s.removeEventListener("dblclick", this._blockEvt);
    s.removeEventListener("dragstart", this._blockEvt);
    this.g = null;
    this.pointers.clear();
  }

  _isIgnored(target) {
    return this.ignore.some((n) => n && (n === target || n.contains(target)));
  }

  _blockTouch(e) {
    if (this._isIgnored(e.target)) return;
    if (e.cancelable) e.preventDefault();
  }

  /** Kann in Richtung dir geblättert werden? */
  canFlip(pf, dir) {
    try {
      const pc = pf.getPageCollection();
      const cs = pc.getCurrentSpreadIndex();
      const last = pc.getSpreadIndexByPage(pf.getPageCount() - 1);
      return dir === "next" ? cs < last : cs > 0;
    } catch (_) {
      return false;
    }
  }

  _down(e) {
    if (!this.enabled || this._isIgnored(e.target)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.pointers.add(e.pointerId);
    if (this.pointers.size > 1) {
      // Zweiter Finger → laufende Geste abbrechen
      this._abort();
      return;
    }
    if (this.busy) return;
    const pf = this.getPf();
    if (!pf || pf.getState() !== "read") return;
    try { this.surface.setPointerCapture(e.pointerId); } catch (_) { /* egal */ }
    this.g = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      dir: null,
      dead: false,
      samples: [{ x: e.clientX, t: performance.now() }],
      px: 0
    };
  }

  _move(e) {
    const g = this.g;
    if (!g || e.pointerId !== g.id || g.dead) return;
    const pf = this.getPf();
    if (!pf) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;

    if (!g.dir) {
      if (Math.abs(dx) < LOCK_PX) {
        if (Math.abs(dy) > 40) g.dead = true;
        return;
      }
      if (Math.abs(dx) < Math.abs(dy) * 1.2) { g.dead = true; return; }
      const dir = dx < 0 ? "next" : "prev";
      if (pf.getState() !== "read" || !this.canFlip(pf, dir)) { g.dead = true; return; }
      const rect = pf.getRender().getRect();
      const block = pf.getUI().getDistElement().getBoundingClientRect();
      const yInBook = g.y0 - block.top - rect.top;
      g.dir = dir;
      g.rect = rect;
      g.block = block;
      g.baseY = yInBook >= rect.height / 2 ? rect.height - 1 : 1;
    }

    const amount = Math.max(0, (g.dir === "next" ? -dx : dx) - LOCK_PX);
    this._foldTo(pf, g, amount, dy);

    const t = performance.now();
    g.samples.push({ x: e.clientX, t });
    while (g.samples.length > 2 && t - g.samples[0].t > 120) g.samples.shift();
  }

  _foldTo(pf, g, amount, dy) {
    const r = g.rect;
    const W = r.pageWidth;
    const H = r.height;
    let px = W - 1 - amount * GAIN;
    px = Math.max(px, -W + 2);
    let py = g.baseY + dy * 0.25;
    py = Math.min(H - 1, Math.max(1, py));
    const mid = r.left + r.width / 2;
    const x = g.dir === "next" ? px + mid : mid - px;
    g.px = px;
    g.py = py;
    pf.getFlipController().fold({ x, y: py + r.top });
  }

  _velocity(g) {
    const s = g.samples;
    if (s.length < 2) return 0;
    const a = s[0], b = s[s.length - 1];
    const dt = Math.max(1, b.t - a.t);
    const v = (b.x - a.x) / dt;
    return g.dir === "next" ? -v : v;
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    this.g = null;
    if (!g.dir) return; // Tippen oder senkrechte Bewegung → nichts tun
    const pf = this.getPf();
    if (!pf) return;
    const W = g.rect.pageWidth;
    const progress = (W - 1 - g.px) / W;
    const v = this._velocity(g);
    if (progress > COMMIT_PROGRESS || (v > COMMIT_VELOCITY && progress > 0.04)) {
      this._complete(pf, g);
    } else {
      this._revert(pf);
    }
  }

  _cancel(e) {
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    this.g = null;
    if (g.dir) {
      const pf = this.getPf();
      if (pf) this._revert(pf);
    }
  }

  _abort() {
    const g = this.g;
    this.g = null;
    if (g && g.dir) {
      const pf = this.getPf();
      if (pf) this._revert(pf);
    }
  }

  _revert(pf) {
    try { pf.getFlipController().stopMove(); } catch (_) { /* egal */ }
    this._unstickLater(pf);
  }

  /** Seite kurz weiterziehen bis über den Buchrücken, dann sauber zu Ende animieren. */
  _complete(pf, g) {
    this.busy = true;
    const W = g.rect.pageWidth;
    const from = g.px;
    const to = -W * 0.06;
    const startY = g.py;
    const endY = g.baseY;
    const dur = 110;
    const t0 = performance.now();
    const mid = g.rect.left + g.rect.width / 2;
    const step = (now) => {
      if (this.getPf() !== pf) { this.busy = false; return; }
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 2);
      const px = from + (to - from) * e;
      const py = startY + (endY - startY) * e;
      const x = g.dir === "next" ? px + mid : mid - px;
      try { pf.getFlipController().fold({ x, y: py + g.rect.top }); } catch (_) { /* egal */ }
      if (k < 1) {
        requestAnimationFrame(step);
      } else {
        try { pf.getFlipController().stopMove(); } catch (_) { /* egal */ }
        this.busy = false;
        this._unstickLater(pf);
      }
    };
    requestAnimationFrame(step);
  }

  /** Sicherheitsnetz: falls die Bibliothek ohne laufende Animation hängen bleibt. */
  _unstickLater(pf) {
    setTimeout(() => {
      try {
        const fc = pf.getFlipController();
        if (pf.getState() !== "read" && fc.calc === null && fc.setState) fc.setState("read");
      } catch (_) { /* egal */ }
    }, 1600);
  }
}
