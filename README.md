# Unsere Bücher – digitale Kinderbuch-App (iPad-PWA)

Bücherwand → Cover antippen → Buch öffnet sich im Vollbild → mit dem Finger echte Seiten umblättern.

**Kostenlos und ohne Cloud:** Die App liegt auf GitHub Pages. Deine Bücher werden ausschließlich auf dem Gerät gespeichert (IndexedDB). Google Drive ist nur deine Ablage für die Original-PDFs und Backups. Es gibt keinen Server, kein Firebase, keine Kreditkarte, kein Tracking.

## Bedienung

| Wo | Was | Wirkung |
|---|---|---|
| Lesemodus | von rechts nach links wischen | nächste Seite |
| Lesemodus | von links nach rechts wischen | vorherige Seite |
| Lesemodus | fast unsichtbarer Strich unten mittig, **4× innerhalb von 3 s** antippen | zurück zur Bücherwand |
| Bücherwand | Überschrift „Unsere Bücher“ **5× schnell** antippen | Elternbereich |

Tippen blättert nie. Zoomen, Scrollen, Markieren und Kontextmenüs sind gesperrt.

---

## Einrichtung

### 1. Auf GitHub Pages veröffentlichen
1. Im Repository **alle alten Dateien löschen** (besonders den Ordner `vendor/firebase` und die Dateien `firebase.json`, `firestore.rules`, `storage.rules`, `cors.json`, `js/firebase.js`).
2. Den **Inhalt** dieses Ordners hochladen (**Add file → Upload files**). Die Ordner `css`, `js`, `vendor`, `fonts`, `icons` und alle Dateien müssen direkt im Hauptverzeichnis liegen. → **Commit**.
3. **Settings → Pages → Branch `main` / `(root)` → Save**.
4. Die App ist nach 1–2 Minuten erreichbar unter `https://hetec-it.github.io/Kinderbuch-App/`.

### 2. Auf dem iPad installieren – **vor dem ersten Import!**
1. Die Adresse in **Safari** öffnen (nicht Chrome).
2. **Teilen-Symbol → „Zum Home-Bildschirm“ → Hinzufügen**.
3. Die App ab jetzt **nur noch über das Symbol** starten.

> **Wichtig:** Safari und die Home-Bildschirm-App haben **getrennte Speicher**. Bücher müssen **in der installierten App** importiert werden. Bücher aus einem normalen Safari-Tab erscheinen dort nicht.

### 3. Elternbereich und PIN
1. In der App **5× schnell auf „Unsere Bücher“** tippen.
2. Beim ersten Mal fragt die App, ob du einen **Eltern-PIN** (4–8 Ziffern) einrichten willst. Der PIN wird nur als Hash gespeichert und dient als Kindersicherung.
3. PIN später ändern oder entfernen: Elternbereich → **Eltern-PIN**.
4. Nach 5 falschen Eingaben ist der Zugang 30 Sekunden gesperrt.
5. PIN vergessen? Dann hilft nur, die App-Daten zu löschen (Einstellungen → Safari → Verlauf und Websitedaten löschen). Dabei gehen alle Bücher verloren. Darum regelmäßig ein Backup machen.

### 4. Buch hinzufügen (PDF aus Google Drive)
1. Elternbereich → **+ Buch hinzufügen** → bei „PDF-Datei“ **Datei auswählen**.
2. Die **Dateien-App** öffnet sich. Wähle **Google Drive → Kinderbücher → deine PDF**.
3. Titel prüfen. Untertitel und Kategorie sind optional.
4. **Seitenaufteilung** auf „Automatisch erkennen“ lassen.
5. „Original-PDF nach Import behalten“ **aus** lassen. Die fertigen Seitenbilder reichen zum Lesen. Mit Haken wird die PDF zusätzlich gespeichert und kommt mit ins Backup.
6. **Buch importieren**. Ein Fortschrittsdialog zeigt „Seite 4 von 10“ mit Balken. Das Buch erscheint erst in der Bücherwand, wenn alles gespeichert ist. Bei **Abbrechen** oder einem Fehler wird alles Halbfertige entfernt.
7. **Schließen** → das Cover steht in der Bücherwand.

Wenn die PDF in Google Drive noch nicht auf dem iPad ist, lädt die Dateien-App sie erst herunter. Das dauert bei großen Dateien. Sehr große PDFs (über 100 MB) brauchen viel Arbeitsspeicher. Am besten die PDF vorher verkleinern, z. B. mit `new jsPDF({ compress: true })` und JPEG-Bildern.

### 5. Lesen
Cover antippen und wischen. Zurück: unten mittig 4× tippen. Alle Bücher funktionieren auch ohne Internet.

### 6. Backup erstellen und in Google Drive speichern
1. Elternbereich → **Sichern & Wiederherstellen → Bibliothek sichern**.
2. Wenn „Sicherung ist fertig“ erscheint: **Speichern / Teilen → In Dateien sichern → Google Drive** (Ordner wählen).
3. Einzelne Bücher: bei dem Buch **Buch exportieren**.

Das Backup ist eine normale **ZIP-Datei** (`Kinderbuch-Backup-JJJJ-MM-TT.zip`) mit Metadaten, Covern, allen Seitenbildern und (falls gespeichert) den Original-PDFs. Auch am PC lässt sie sich öffnen.

### 7. Backup wiederherstellen
1. Elternbereich → **Bibliothek wiederherstellen** → Datei aus Google Drive wählen.
2. Die App prüft das Backup und fragt: **Zusammenführen** (vorhandene Bücher bleiben) oder **Alles ersetzen**.
3. Funktioniert auch auf einem anderen iPad oder einer frischen Installation.

### 8. App-Updates
Neue Dateien auf GitHub hochladen und in `service-worker.js` die Zeile `const VERSION = "2.0.0"` erhöhen. Die App aktualisiert sich beim übernächsten Start. **Deine Bücher bleiben dabei immer erhalten.** Updates fassen die Datenbank nicht an.

---

## Speicher
Im Elternbereich unter **Speicher** siehst du Bücher, Verbrauch und ob der Speicher „persistent“ ist. Die App fordert das automatisch an. Zusätzlich schützt die Installation auf dem Home-Bildschirm vor dem automatischen Aufräumen durch Safari.

Wenn der Speicher nicht reicht, erscheint: „Dieses Buch konnte nicht vollständig gespeichert werden …“ mit **Import erneut versuchen** und **Abbrechen**.

## Testanleitung PC
1. Lokal starten, z. B. im Projektordner `python3 -m http.server 8000` und `http://localhost:8000` öffnen. Ein Doppelklick auf `index.html` funktioniert nicht.
2. Überschrift 5× anklicken → Elternbereich → PDF importieren.
3. Buch öffnen und mit gedrückter Maus wischen (oder Pfeiltasten ← →). Zurück: unten mittig 4× klicken.
4. Offline-Test: in den Entwicklertools Netzwerk auf „Offline“ stellen und die Seite neu laden.
5. Backup erstellen, Buch löschen, Backup wiederherstellen.

## Testanleitung iPad
Ablauf wie in Schritt 2 bis 7. Zum Offline-Test den Flugmodus einschalten, die App komplett schließen und neu starten.

## Hinweise zu Safari / iPadOS
- **Getrennter Speicher:** Safari-Tab und Home-Bildschirm-App teilen keine Daten. Importiere nur in der installierten App.
- **Kein OPFS:** Safari kann das Origin Private File System nur eingeschränkt beschreiben. Deshalb nutzt die App ausschließlich IndexedDB mit echten Blobs. Das ist in Safari stabiler.
- **Datenverlust möglich:** Safari kann Website-Daten löschen, wenn „Verlauf und Websitedaten löschen“ ausgeführt wird oder der Speicher knapp wird. Darum ab und zu ein Backup machen.
- **Vollbild:** Der echte Vollbildmodus gelingt nur über die installierte App. Im Safari-Tab bleibt die Browserleiste.
- **Backup teilen:** Der Teilen-Dialog nutzt die iPad-eigene Funktion. Falls er nicht erscheint, gibt es den Knopf „Herunterladen“.
- **Große PDFs:** Beim Import wird die PDF komplett in den Arbeitsspeicher gelesen. Sehr große Dateien können auf älteren iPads scheitern. Dann erscheint eine normale Fehlermeldung.

## Dateien

```
index.html               Grundgerüst (Splash, Bücherwand, Lesemodus)
css/style.css            Design
js/config.js             Einstellungen (Bildqualität, Taps, Zeiten)
js/app.js                Start, Bücherwand, versteckter Zugang
js/reader.js             Lesemodus (Vollbild, Speicherverwaltung, Zurück-Button)
js/swipe-flip.js         Wischgesten → Page-Curl
js/pdf-tools.js          PDF.js: Layout-Erkennung, 1:1-Rendering
js/db.js                 lokale Datenbank (IndexedDB), einzige Stelle mit DB-Code
js/storage.js            Speicherschätzung, persistenter Speicher
js/importer.js           PDF → Seitenbilder → Datenbank (transaktionssicher)
js/backup.js, js/zip.js  Sichern & Wiederherstellen als ZIP
js/pin.js                Eltern-PIN (gehasht)
js/admin.js              Elternbereich
service-worker.js        Offline-Start der App (nur App-Dateien)
manifest.json, icons/    PWA / Home-Bildschirm
vendor/                  PDF.js 3.11.174, StPageFlip 2.0.7 (angepasst, MIT)
fonts/                   Fraunces (SIL OFL)
```
