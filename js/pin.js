/* Eltern-PIN (nur Kindersicherung). Der PIN wird nie im Klartext gespeichert:
   PBKDF2-SHA-256 mit zufälligem Salt (Web Crypto API). */
import { getSetting, setSetting, deleteSetting } from "./db.js";

const ITERATIONS = 150000;

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin, salt, iterations) {
  if (!window.crypto || !crypto.subtle) throw new Error("crypto-unavailable");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export const validPinFormat = (p) => /^[0-9]{4,8}$/.test(p);

export async function hasPin() {
  return !!(await getSetting("pin", null));
}

export async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  await setSetting("pin", { salt: toB64(salt), hash: toB64(hash), iter: ITERATIONS });
}

export async function removePin() {
  await deleteSetting("pin");
}

let fails = 0;
let lockUntil = 0;

export function lockSecondsLeft() {
  return Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000));
}

/** "ok" | "wrong" | "locked" – nach 5 Fehlversuchen 30 Sekunden Sperre. */
export async function verifyPin(pin) {
  if (lockSecondsLeft() > 0) return "locked";
  const rec = await getSetting("pin", null);
  if (!rec) return "ok";
  const hash = toB64(await derive(pin, fromB64(rec.salt), rec.iter));
  if (hash === rec.hash) { fails = 0; return "ok"; }
  fails++;
  if (fails >= 5) { fails = 0; lockUntil = Date.now() + 30000; }
  return "wrong";
}
