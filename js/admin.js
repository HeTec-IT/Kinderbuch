/* Elternbereich: Buch hinzufügen, bearbeiten, Speicher, Backup, PIN.
   Alles lokal – es gibt keinen Server und keine Cloud. Wird erst geladen, wenn die
   Überschrift 5× angetippt wurde. */
import { COVER_WIDTH, COVER_QUALITY } from "./config.js";
import { el, formatBytes } from "./util.js";
import { getBooks, updateBook, deleteBook, getSetting, setSetting, getStorageStats } from "./db.js";
import { importPdf } from "./importer.js";
import { canvasToBlob } from "./pdf-tools.js";
import {
  exportLibrary, inspectBackup, importLibrary, canShareFile, shareFile, downloadBlob
} from "./backup.js";
import { requestPersistence, getStorageInfo } from "./storage.js";
import { hasPin, setPin, removePin, verifyPin, lockSecondsLeft, validPinFormat } from "./pin.js";

let ui = null;
let busy = false;
let onCloseCb = null;
let thumbUrls = [];

/* ---------------- Grundgerüst & Zugang ---------------- */

export async function openAdmin({ onClose } = {}) {
  onCloseCb = onClose;
  if (!ui) buildShell();
  ui.root.hidden = false;
  ui.body.replaceChildren();
  document.body.classList.add("admin-open");
  let ok = false;
  try {
    ok = await gate();
  } catch (e) {
    console.warn(e);
    await ask("Elternbereich", "Der Elternbereich konnte nicht geöffnet werden.", [{ key: "ok", label: "OK", primary: true }]);
  }
  if (!ok) { closeAdmin(true); return; }
  await showManage();
}

function closeAdmin(force) {
  if (busy && !force) return;
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  if (ui) {
    ui.root.querySelectorAll(".kb-modal").forEach((m) => m.remove());
    ui.root.hidden = true;
    ui.body.replaceChildren();
  }
  document.body.classList.remove("admin-open");
  if (onCloseCb) onCloseCb();
}

function buildShell() {
  const closeBtn = el("button", { class: "btn btn-quiet", type: "button", text: "Schließen", onclick: () => closeAdmin(false) });
  const body = el("div", { class: "admin-body" });
  const root = el("section", { class: "admin", hidden: true, "aria-label": "Elternbereich" }, [
    el("div", { class: "admin-panel" }, [
      el("header", { class: "admin-head" }, [
        el("h2", { text: "Elternbereich" }),
        el("div", { class: "admin-head-actions" }, [closeBtn])
      ]),
      body
    ])
  ]);
  document.body.appendChild(root);
  window.addEventListener("beforeunload", (e) => {
    if (busy) { e.preventDefault(); e.returnValue = ""; }
  });
  ui = { root, body };
}

/** PIN-Abfrage bzw. beim ersten Mal das Angebot, einen PIN einzurichten. */
async function gate() {
  if (await hasPin()) {
    let note = "";
    for (;;) {
      const left = lockSecondsLeft();
      if (left > 0) {
        await ask("Bitte kurz warten", `Zu viele Versuche. Bitte in ${left} Sekunden erneut versuchen.`, [{ key: "ok", label: "OK", primary: true }]);
        return false;
      }
      const pin = await pinDialog({ title: "Eltern-PIN", note });
      if (pin === null) return false;
      const r = await verifyPin(pin);
      if (r === "ok") return true;
      note = r === "locked" ? "Bitte kurz warten." : "Falscher PIN.";
    }
  }
  if (!(await getSetting("pinAsked", false))) {
    const a = await ask(
      "Eltern-PIN einrichten?",
      "Möchtest du einen Eltern-PIN einrichten? Er schützt den Elternbereich davor, versehentlich von Kindern geöffnet zu werden.",
      [{ key: "set", label: "PIN festlegen", primary: true }, { key: "no", label: "Ohne PIN fortfahren" }]
    );
    await setSetting("pinAsked", true);
    if (a === "set") {
      const pin = await pinDialog({ title: "Neuen PIN festlegen", text: "4 bis 8 Ziffern.", repeat: true });
      if (pin) await setPin(pin);
    }
  }
  return true;
}

/* ---------------- Dialoge ---------------- */

function modal(nodes) {
  const card = el("div", { class: "kb-modal-card", role: "dialog", "aria-modal": "true" }, nodes.filter(Boolean));
  const wrap = el("div", { class: "kb-modal" }, [card]);
  ui.root.appendChild(wrap);
  return { wrap, card, close: () => wrap.remove() };
}

function ask(title, text, buttons) {
  return new Promise((resolve) => {
    const m = modal([
      el("h3", { text: title }),
      text ? el("p", { class: "kb-modal-info", text }) : null,
      el("div", { class: "kb-modal-actions" }, buttons.map((b) =>
        el("button", {
          class: "btn " + (b.primary ? "btn-primary" : b.danger ? "btn-danger" : "btn-quiet"),
          type: "button",
          text: b.label,
          onclick: () => { m.close(); resolve(b.key); }
        })))
    ]);
  });
}

function pinDialog({ title, text = "", note = "", repeat = false }) {
  return new Promise((resolve) => {
    const mk = (ph) => el("input", {
      type: "password", inputmode: "numeric", pattern: "[0-9]*", autocomplete: "off", maxlength: "8", placeholder: ph
    });
    const a = mk("PIN");
    const b = repeat ? mk("PIN wiederholen") : null;
    const msg = el("p", { class: "admin-msg", role: "alert", text: note });
    const cancel = el("button", { class: "btn btn-quiet", type: "button", text: "Abbrechen" });
    const ok = el("button", { class: "btn btn-primary", type: "submit", text: "OK" });
    const form = el("form", {}, [
      el("label", { class: "field" }, [a]),
      b ? el("label", { class: "field" }, [b]) : null,
      msg,
      el("div", { class: "kb-modal-actions" }, [cancel, ok])
    ]);
    const m = modal([el("h3", { text: title }), text ? el("p", { class: "kb-modal-info", text }) : null, form]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!validPinFormat(a.value)) { msg.textContent = "Bitte 4 bis 8 Ziffern eingeben."; return; }
      if (b && b.value !== a.value) { msg.textContent = "Die PINs stimmen nicht überein."; return; }
      m.close();
      resolve(a.value);
    });
    cancel.addEventListener("click", () => { m.close(); resolve(null); });
    setTimeout(() => a.focus(), 60);
  });
}

function progressModal(titleText) {
  const info = el("p", { class: "kb-modal-info" });
  const bar = el("progress", { max: "100", value: "0" });
  const pct = el("span", { class: "kb-pct", text: "0 %" });
  const cancel = el("button", { class: "btn btn-quiet", type: "button", text: "Abbrechen" });
  const m = modal([
    el("h3", { text: titleText }),
    info,
    el("div", { class: "kb-progress" }, [bar, pct]),
    el("div", { class: "kb-modal-actions" }, [cancel])
  ]);
  return {
    update(percent, text) {
      bar.value = percent;
      pct.textContent = Math.round(percent) + " %";
      if (text !== undefined) info.textContent = text;
    },
    onCancel(fn) {
      cancel.addEventListener("click", () => { cancel.disabled = true; cancel.textContent = "Wird abgebrochen …"; fn(); });
    },
    close: m.close
  };
}

const OK = [{ key: "ok", label: "OK", primary: true }];

/* ---------------- Verwaltungsansicht ---------------- */

function card(title, content, hint) {
  return el("section", { class: "admin-card" }, [
    el("h3", { text: title }),
    hint ? el("p", { class: "admin-hint", text: hint }) : null,
    content
  ]);
}

async function showManage() {
  ui.listWrap = el("div", { class: "admin-list" });
  ui.storageWrap = el("div", { class: "admin-storage" });
  ui.pinWrap = el("div", {});
  ui.body.replaceChildren(
    await buildAddCard(),
    card("Alle Bücher", ui.listWrap, "Reihenfolge mit den Pfeilen ändern. Unsichtbare Bücher erscheinen nicht in der Bücherwand."),
    card("Speicher", ui.storageWrap),
    buildBackupCard(),
    card("Eltern-PIN", ui.pinWrap),
    el("p", { class: "admin-foot", text: "Deine Bücher werden ausschließlich auf diesem Gerät gespeichert." })
  );
  await refreshAll();
}

async function refreshAll() {
  await Promise.all([refreshList(), renderStorage(), renderPin()]);
}

/* ---------------- Buch hinzufügen ---------------- */

async function buildAddCard() {
  const file = el("input", { type: "file", accept: "application/pdf,.pdf" });
  const title = el("input", { type: "text", placeholder: "z. B. Lio und der kleine Donner-Bauch" });
  const subtitle = el("input", { type: "text", placeholder: "optional" });
  const category = el("input", { type: "text", placeholder: "optional" });
  const layout = el("select", {}, [
    el("option", { value: "auto", text: "Automatisch erkennen" }),
    el("option", { value: "spread", text: "Jede PDF-Seite ist eine Doppelseite" }),
    el("option", { value: "single", text: "Jede PDF-Seite ist eine Einzelseite" })
  ]);
  const keep = el("input", { type: "checkbox" });
  keep.checked = !!(await getSetting("keepPdf", false));
  const status = el("p", { class: "admin-status", "aria-live": "polite" });
  const submit = el("button", { class: "btn btn-primary", type: "submit", text: "Buch importieren" });

  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (f) {
      title.value = f.name.replace(/\.pdf$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
      status.textContent = "";
    }
  });

  const form = el("form", { class: "admin-card" }, [
    el("h3", { text: "+ Buch hinzufügen" }),
    el("p", { class: "admin-hint", text: "Die PDF-Auswahl öffnet die Dateien-App. Dort kannst du auch Google Drive wählen." }),
    el("label", { class: "field" }, [el("span", { text: "PDF-Datei" }), file]),
    el("label", { class: "field" }, [el("span", { text: "Titel" }), title]),
    el("div", { class: "field-row" }, [
      el("label", { class: "field" }, [el("span", { text: "Untertitel" }), subtitle]),
      el("label", { class: "field" }, [el("span", { text: "Kategorie" }), category])
    ]),
    el("label", { class: "field" }, [el("span", { text: "Seitenaufteilung" }), layout]),
    el("label", { class: "check" }, [keep, el("span", { text: "Original-PDF nach Import behalten (braucht viel Speicher)" })]),
    status,
    submit
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = file.files && file.files[0];
    if (!f) { status.textContent = "Bitte zuerst eine PDF-Datei auswählen."; return; }
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { status.textContent = "Das ist keine PDF-Datei."; return; }
    if (!title.value.trim()) { status.textContent = "Bitte einen Titel eingeben."; return; }
    await setSetting("keepPdf", keep.checked);
    submit.disabled = true;
    const done = await runImport({
      file: f,
      title: title.value.trim(),
      subtitle: subtitle.value.trim(),
      category: category.value.trim(),
      layout: layout.value,
      keepPdf: keep.checked
    });
    submit.disabled = false;
    if (done) {
      status.textContent = "Fertig! Das Buch steht jetzt in der Bücherwand.";
      file.value = ""; title.value = ""; subtitle.value = "";
    }
  });
  return form;
}

function importMessage(err) {
  const c = err && err.cause;
  const detail = c ? ` (Details: ${c.name || "Fehler"}${c.message ? " – " + String(c.message).slice(0, 80) : ""})` : "";
  return importText(err) + detail;
}

function importText(err) {
  switch (err && err.kind) {
    case "storage":
      return "Dieses Buch konnte nicht vollständig gespeichert werden. Auf dem Gerät ist möglicherweise nicht genügend Speicherplatz verfügbar.";
    case "read":
      return "Die Datei konnte nicht geöffnet werden. Bei Google Drive bitte warten, bis die Datei vollständig geladen ist, und erneut versuchen.";
    default:
      return "Diese PDF konnte nicht gelesen oder verarbeitet werden.";
  }
}

/** true = Buch importiert. Bei Fehlern: Dialog mit „Import erneut versuchen“ / „Abbrechen“. */
async function runImport(params) {
  if (busy) return false;
  busy = true;
  try {
    for (;;) {
      const control = { cancelled: false };
      const pm = progressModal(`„${params.title}“ wird vorbereitet`);
      pm.onCancel(() => { control.cancelled = true; });
      pm.update(1, "PDF wird gelesen …");
      let wake = null;
      try { wake = navigator.wakeLock ? await navigator.wakeLock.request("screen") : null; } catch (_) { /* egal */ }
      try {
        await importPdf(params.file, {
          ...params,
          control,
          onProgress: (p) => pm.update(
            p.percent,
            p.stage === "pages" ? `Seite ${p.done} von ${p.total}` : p.stage === "read" ? "PDF wird gelesen …" : "Wird abgeschlossen …"
          )
        });
        pm.close();
        requestPersistence();
        await refreshAll();
        return true;
      } catch (err) {
        pm.close();
        if (err && err.kind === "cancel") return false;
        console.warn("Import fehlgeschlagen:", err);
        const choice = await ask("Import nicht möglich", importMessage(err), [
          { key: "retry", label: "Import erneut versuchen", primary: true },
          { key: "cancel", label: "Abbrechen" }
        ]);
        if (choice !== "retry") return false;
      } finally {
        try { if (wake) wake.release(); } catch (_) { /* egal */ }
      }
    }
  } finally {
    busy = false;
  }
}

/* ---------------- Bücherliste ---------------- */

async function refreshList() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  let books;
  let sizes;
  try {
    books = await getBooks();
    sizes = (await getStorageStats()).perBook;
  } catch (_) {
    ui.listWrap.replaceChildren(el("p", { class: "admin-msg", text: "Die Bücher konnten nicht gelesen werden." }));
    return;
  }
  if (!books.length) {
    ui.listWrap.replaceChildren(el("p", { class: "admin-hint", text: "Noch keine Bücher vorhanden." }));
    return;
  }
  ui.listWrap.replaceChildren(...books.map((b, i) => renderRow(b, i, books, sizes.get(b.id) || 0)));
}

function renderRow(book, index, books, bytes) {
  const textField = (field, label, placeholder) => {
    const input = el("input", { type: "text", value: book[field] || "", placeholder: placeholder || "" });
    input.addEventListener("change", async () => {
      const value = input.value.trim();
      if (field === "title" && !value) { input.value = book.title; return; }
      if ((book[field] || "") === value) return;
      input.classList.remove("is-saved", "is-error");
      try { await updateBook(book.id, { [field]: value }); book[field] = value; input.classList.add("is-saved"); }
      catch (_) { input.classList.add("is-error"); }
    });
    return el("label", { class: "field field-compact" }, [el("span", { text: label }), input]);
  };

  const active = el("input", { type: "checkbox" });
  active.checked = book.active !== false;
  active.addEventListener("change", async () => {
    active.disabled = true;
    try { await updateBook(book.id, { active: active.checked }); book.active = active.checked; row.classList.toggle("is-inactive", !book.active); }
    catch (_) { active.checked = book.active !== false; }
    finally { active.disabled = false; }
  });

  const up = el("button", { class: "btn btn-icon", type: "button", "aria-label": "Nach oben", text: "↑", disabled: index === 0 });
  const down = el("button", { class: "btn btn-icon", type: "button", "aria-label": "Nach unten", text: "↓", disabled: index === books.length - 1 });
  up.addEventListener("click", () => moveBook(books, index, -1));
  down.addEventListener("click", () => moveBook(books, index, 1));

  const coverInput = el("input", { type: "file", accept: "image/*", hidden: true });
  coverInput.addEventListener("change", async () => {
    const f = coverInput.files && coverInput.files[0];
    coverInput.value = "";
    if (!f) return;
    try {
      const { blob, aspect } = await imageToCover(f);
      await updateBook(book.id, { coverBlob: blob, coverAspect: aspect });
      await refreshList();
    } catch (_) {
      await ask("Cover ändern", "Dieses Bild konnte nicht verwendet werden.", OK);
    }
  });
  const coverBtn = el("button", { class: "btn btn-quiet", type: "button", text: "Cover ändern", onclick: () => coverInput.click() });
  const exportBtn = el("button", { class: "btn btn-quiet", type: "button", text: "Buch exportieren", onclick: () => doExport([book.id], `„${book.title}“ wird gesichert`) });
  const delBtn = el("button", {
    class: "btn btn-danger", type: "button", text: "Löschen",
    onclick: async () => {
      if (busy) return;
      const a = await ask("Buch löschen?", `„${book.title}“ wird endgültig von diesem Gerät gelöscht.`, [
        { key: "yes", label: "Löschen", danger: true }, { key: "no", label: "Abbrechen", primary: true }
      ]);
      if (a !== "yes") return;
      try { await deleteBook(book.id); } catch (_) { await ask("Löschen", "Das Buch konnte nicht gelöscht werden.", OK); }
      await refreshAll();
    }
  });

  let thumbUrl = "";
  if (book.coverBlob) { thumbUrl = URL.createObjectURL(book.coverBlob); thumbUrls.push(thumbUrl); }
  const row = el("article", { class: "admin-row" + (book.active === false ? " is-inactive" : "") }, [
    el("div", { class: "admin-thumb" }, thumbUrl ? [el("img", { src: thumbUrl, alt: "" })] : []),
    el("div", { class: "admin-row-fields" }, [
      textField("title", "Titel"),
      textField("subtitle", "Untertitel", "optional"),
      textField("category", "Kategorie", "optional"),
      el("p", { class: "admin-size", text: `${book.pageCount} Seiten · ${formatBytes(bytes)}${book.hasPdf ? " · inkl. Original-PDF" : ""}` })
    ]),
    el("div", { class: "admin-row-actions" }, [
      el("label", { class: "switch" }, [active, el("span", { class: "switch-ui", "aria-hidden": "true" }), el("span", { class: "switch-label", text: "Sichtbar" })]),
      el("div", { class: "admin-order" }, [up, down]),
      coverBtn, coverInput, exportBtn, delBtn
    ])
  ]);
  return row;
}

async function moveBook(books, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= books.length) return;
  const arr = books.slice();
  [arr[index], arr[target]] = [arr[target], arr[index]];
  try {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].order !== i + 1) await updateBook(arr[i].id, { order: i + 1 });
    }
  } catch (_) {
    await ask("Reihenfolge", "Die Reihenfolge konnte nicht gespeichert werden.", OK);
  }
  await refreshList();
}

async function imageToCover(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, COVER_WIDTH / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await canvasToBlob(c, "image/jpeg", COVER_QUALITY);
    const aspect = c.width / c.height;
    c.width = c.height = 0;
    return { blob, aspect };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------------- Speicher ---------------- */

async function renderStorage() {
  let stats = { bookCount: 0, bytes: 0 };
  try { stats = await getStorageStats(); } catch (_) { /* egal */ }
  const info = await getStorageInfo();
  const nodes = [
    el("p", { class: "admin-line" }, [el("strong", { text: "Lokale Kinderbücher" })]),
    el("p", { class: "admin-line", text: `${stats.bookCount} ${stats.bookCount === 1 ? "Buch" : "Bücher"} · ${formatBytes(stats.bytes)} verwendet` })
  ];
  if (info.quota) {
    const used = typeof info.usage === "number" ? info.usage : stats.bytes;
    nodes.push(
      el("div", { class: "meter" }, [el("i", { style: { width: Math.max(1, Math.min(100, (used / info.quota) * 100)) + "%" } })]),
      el("p", { class: "admin-line admin-size", text: `${formatBytes(used)} von geschätzt ${formatBytes(info.quota)} verwendet (gesamte App)` })
    );
  }
  nodes.push(el("p", {
    class: "admin-line",
    text: "Persistenter Speicher: " + (info.persisted === true ? "aktiviert" : info.persisted === false ? "nicht aktiviert" : "unbekannt")
  }));
  if (info.persisted === false) {
    nodes.push(el("div", { class: "admin-btnrow" }, [
      el("button", {
        class: "btn btn-quiet", type: "button", text: "Dauerhaften Speicher anfordern",
        onclick: async () => { await requestPersistence(); await renderStorage(); }
      })
    ]));
  }
  ui.storageWrap.replaceChildren(...nodes);
}

/* ---------------- PIN ---------------- */

async function renderPin() {
  const has = await hasPin();
  const nodes = [
    el("p", { class: "admin-hint", text: has ? "Ein PIN ist eingerichtet." : "Kein PIN eingerichtet. Der Elternbereich öffnet sich ohne Abfrage." })
  ];
  const row = el("div", { class: "admin-btnrow" }, [
    el("button", {
      class: "btn btn-quiet", type: "button", text: has ? "PIN ändern" : "PIN festlegen",
      onclick: async () => {
        const pin = await pinDialog({ title: has ? "Neuen PIN festlegen" : "PIN festlegen", text: "4 bis 8 Ziffern.", repeat: true });
        if (pin) { await setPin(pin); await setSetting("pinAsked", true); }
        await renderPin();
      }
    })
  ]);
  if (has) {
    row.appendChild(el("button", {
      class: "btn btn-danger", type: "button", text: "PIN entfernen",
      onclick: async () => {
        const a = await ask("PIN entfernen?", "Der Elternbereich lässt sich danach ohne PIN öffnen.", [
          { key: "yes", label: "Entfernen", danger: true }, { key: "no", label: "Abbrechen", primary: true }
        ]);
        if (a === "yes") await removePin();
        await renderPin();
      }
    }));
  }
  nodes.push(row);
  ui.pinWrap.replaceChildren(...nodes);
}

/* ---------------- Backup ---------------- */

function buildBackupCard() {
  const restoreInput = el("input", { type: "file", accept: ".zip,.kbook,application/zip", hidden: true });
  restoreInput.addEventListener("change", async () => {
    const f = restoreInput.files && restoreInput.files[0];
    restoreInput.value = "";
    if (f) await doRestore(f);
  });
  const content = el("div", {}, [
    el("div", { class: "admin-btnrow" }, [
      el("button", { class: "btn btn-primary", type: "button", text: "Bibliothek sichern", onclick: () => doExport(null, "Bibliothek wird gesichert") }),
      el("button", { class: "btn btn-quiet", type: "button", text: "Bibliothek wiederherstellen", onclick: () => !busy && restoreInput.click() })
    ]),
    restoreInput
  ]);
  return card("Sichern & Wiederherstellen", content,
    "Das Backup ist eine ZIP-Datei mit allen Büchern. Speichere sie z. B. in Google Drive.");
}

async function doExport(bookIds, label) {
  if (busy) return;
  busy = true;
  const control = { cancelled: false };
  const pm = progressModal(label);
  pm.onCancel(() => { control.cancelled = true; });
  pm.update(0, "Wird zusammengestellt …");
  try {
    const res = await exportLibrary({ bookIds, control, onProgress: (p, t) => pm.update(p, t) });
    pm.close();
    await offerFile(res.blob, res.filename);
  } catch (err) {
    pm.close();
    if (!(err && err.kind === "cancel")) {
      console.warn(err);
      await ask("Sichern nicht möglich", "Die Sicherung konnte nicht erstellt werden. Möglicherweise ist nicht genug Speicherplatz frei.", OK);
    }
  } finally {
    busy = false;
  }
}

function offerFile(blob, filename) {
  return new Promise((resolve) => {
    const buttons = [];
    if (canShareFile(blob, filename)) {
      buttons.push(el("button", {
        class: "btn btn-primary", type: "button", text: "Speichern / Teilen",
        onclick: async () => {
          try { await shareFile(blob, filename); }
          catch (e) { if (!e || e.name !== "AbortError") downloadBlob(blob, filename); }
        }
      }));
    }
    buttons.push(el("button", { class: "btn btn-quiet", type: "button", text: "Herunterladen", onclick: () => downloadBlob(blob, filename) }));
    const m = modal([
      el("h3", { text: "Sicherung ist fertig" }),
      el("p", { class: "kb-modal-info", text: `${filename} · ${formatBytes(blob.size)}` }),
      el("p", { class: "kb-modal-info", text: "Auf dem iPad: „Speichern / Teilen“ → „In Dateien sichern“ → Google Drive." }),
      el("div", { class: "kb-modal-actions" }, [
        ...buttons,
        el("button", { class: "btn btn-quiet", type: "button", text: "Fertig", onclick: () => { m.close(); resolve(); } })
      ])
    ]);
  });
}

function backupMessage(err) {
  if (err && err.kind === "newer") return "Dieses Backup stammt aus einer neueren App-Version. Bitte die App aktualisieren.";
  return "Diese Datei ist kein gültiges Kinderbuch-Backup.";
}

async function doRestore(file) {
  if (busy) return;
  busy = true;
  try {
    const checking = progressModal("Backup wird geprüft");
    checking.update(50, "Einen Moment …");
    let insp;
    try { insp = await inspectBackup(file); }
    catch (err) { checking.close(); await ask("Backup nicht lesbar", backupMessage(err), OK); return; }
    checking.close();

    const when = insp.createdAt ? ` (erstellt am ${new Date(insp.createdAt).toLocaleDateString("de-DE")})` : "";
    const choice = await ask(
      "Bibliothek wiederherstellen",
      `Das Backup enthält ${insp.bookCount} ${insp.bookCount === 1 ? "Buch" : "Bücher"}${when}. Bestehende Bücher behalten oder komplette Bibliothek ersetzen?`,
      [{ key: "merge", label: "Zusammenführen", primary: true }, { key: "replace", label: "Alles ersetzen", danger: true }, { key: "cancel", label: "Abbrechen" }]
    );
    if (choice === "cancel") return;
    if (choice === "replace") {
      const sure = await ask("Wirklich alles ersetzen?", "Alle Bücher auf diesem Gerät, die nicht im Backup stehen, werden gelöscht.", [
        { key: "yes", label: "Ja, ersetzen", danger: true }, { key: "no", label: "Abbrechen", primary: true }
      ]);
      if (sure !== "yes") return;
    }

    const control = { cancelled: false };
    const pm = progressModal("Bücher werden wiederhergestellt");
    pm.onCancel(() => { control.cancelled = true; });
    try {
      const res = await importLibrary(insp, { mode: choice, control, onProgress: (p, t) => pm.update(p, t) });
      pm.close();
      requestPersistence();
      await ask("Fertig", `${res.added} ${res.added === 1 ? "Buch" : "Bücher"} wiederhergestellt${res.skipped ? `, ${res.skipped} bereits vorhanden` : ""}.`, OK);
    } catch (err) {
      pm.close();
      if (!(err && err.kind === "cancel")) {
        console.warn(err);
        await ask("Wiederherstellen nicht möglich",
          "Das Backup konnte nicht vollständig geladen werden. Auf dem Gerät ist möglicherweise nicht genügend Speicherplatz verfügbar.", OK);
      }
    }
  } finally {
    busy = false;
    await refreshAll();
  }
}
