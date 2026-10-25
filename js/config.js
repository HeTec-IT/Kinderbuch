/* =====================================================================
   EINSTELLUNGEN – alles läuft lokal auf dem Gerät, keine Cloud nötig.
   ===================================================================== */

export const APP_TITLE = "Unsere Bücher";

/* Lokale Datenbank (IndexedDB). Version nur erhöhen, wenn db.js eine Migration bekommt. */
export const DB_NAME = "kinderbuch";
export const DB_VERSION = 1;

/* Seitenbilder beim Import: längste Kante in Pixeln (Retina-iPad-tauglich) */
export const PAGE_IMAGE_LONG_SIDE = 2304;
export const PAGE_IMAGE_QUALITY = 0.86;

/* Coverbild für die Bücherwand */
export const COVER_WIDTH = 720;
export const COVER_QUALITY = 0.86;

/* Lesemodus */
export const FLIP_TIME_MS = 750;      // Dauer der Umblätter-Animation
export const EXIT_TAPS = 4;           // so oft muss der versteckte Zurück-Button getippt werden
export const EXIT_TAP_WINDOW_MS = 3000;
export const ADMIN_TAPS = 5;          // so oft auf die Überschrift tippen → Elternbereich
export const ADMIN_TAP_WINDOW_MS = 3000;

/* Backup-Datei (eine normale ZIP-Datei) */
export const BACKUP_FORMAT = "kinderbuch-backup";
export const BACKUP_VERSION = 1;
