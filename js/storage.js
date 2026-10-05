/* Browser-Speicher: dauerhaft anfordern + Auslastung schätzen (alles optional, nie ein Fehler). */

export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch (_) {
    return false;
  }
}

/** { persisted: true|false|null, usage: Zahl|null, quota: Zahl|null } */
export async function getStorageInfo() {
  const info = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage && navigator.storage.persisted) info.persisted = await navigator.storage.persisted();
  } catch (_) { /* egal */ }
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (typeof e.usage === "number") info.usage = e.usage;
      if (typeof e.quota === "number") info.quota = e.quota;
    }
  } catch (_) { /* egal */ }
  return info;
}
