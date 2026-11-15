# Familienkalender im Dashboard

Das Dashboard kann den **iCloud-Familienkalender** anzeigen (nur lesen):

- **Rechts am Bildschirm** (Tablet, ab ca. 900 px Breite): die Termine von heute. Bei schmaleren Bildschirmen steht oben eine Karte mit den heutigen Terminen, bei mittlerer Breite gibt es einen 📅-Knopf in der Kopfzeile.
- **Vergrößern-Knopf** (⤢): öffnet einen großen Kalender mit **Monats-** und **Wochenansicht**, Blättern und „Heute“. Auf dem Handy zeigt die Wochenansicht eine Tagesliste, auf dem Tablet ein Zeitraster.
- Termin oder Tag antippen zeigt Details (Uhrzeit, Ort, Notizen).

Die App darf iCloud nicht direkt ansprechen (Zugangsdaten, Browser-Sperre). Dazwischen steht ein kleiner **Worker** (`worker/worker.mjs`), der bei Cloudflare kostenlos läuft. Er liest nur und speichert nichts.

```
Dashboard  ──(Zugangscode)──▶  Worker bei Cloudflare  ──(Apple-ID + App-Passwort)──▶  iCloud-Kalender
```

## Was du brauchst

1. Ein kostenloses **Cloudflare-Konto** (cloudflare.com).
2. Ein **App-spezifisches Passwort** von Apple. Das ist nicht dein Apple-Passwort und lässt sich jederzeit löschen.
3. Den **Namen des Kalenders** (bei Apple meist „Familie“ oder „Family“).

## Einrichtung (geht auch im Browser am Handy)

### 1. App-spezifisches Passwort bei Apple
appleid.apple.com → Anmelden und Sicherheit → **App-spezifische Passwörter** → neues Passwort „Familienkalender“ erzeugen und kopieren (Format `abcd-efgh-ijkl-mnop`).

### 2. Worker bei Cloudflare anlegen
1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**, Name z. B. `familienkalender` → **Deploy**.
2. **Edit code**, den gesamten Inhalt von `worker/worker.mjs` einfügen, **Deploy**.
3. **Settings → Variables and Secrets** → folgende Werte als **Secret** anlegen:

| Name | Wert |
|---|---|
| `APP_TOKEN` | frei gewählter, langer Zufallscode (z. B. 30 Zeichen). Den trägst du später im Dashboard ein. |
| `APPLE_ID` | deine Apple-ID (E-Mail) |
| `APPLE_APP_PASSWORD` | das App-spezifische Passwort |
| `CALENDAR_NAME` | optional, z. B. `Familie`. Ohne Angabe sucht der Worker „Familie“ und „Family“. |

Die Adresse des Workers steht oben, z. B. `https://familienkalender.deinname.workers.dev`.

### 3. Im Dashboard verbinden
⚙️ Einstellungen (PIN) → **Kalender (nur Anzeige)** → **iCloud (Worker)** → Adresse des Workers und Zugangscode (`APP_TOKEN`) eintragen → **Speichern und verbinden**.
Die App meldet „Verbunden: N Termine“ oder einen Fehler im Klartext.

Zum Ausprobieren der Oberfläche ohne Worker gibt es den Modus **Demo** mit Beispielterminen.

## Wenn etwas nicht klappt

| Meldung | Bedeutung |
|---|---|
| Zugangscode falsch | Der Code im Dashboard stimmt nicht mit `APP_TOKEN` im Worker überein. |
| iCloud hat die Zugangsdaten abgelehnt | Apple-ID oder App-Passwort falsch oder gelöscht. Neues App-Passwort erzeugen. |
| Kalender „Familie“ nicht gefunden. Vorhanden: … | Die Meldung nennt die vorhandenen Kalender. Den richtigen Namen als `CALENDAR_NAME` eintragen. |
| Keine Verbindung zum Worker | Adresse falsch oder Worker nicht veröffentlicht. |
| APP_TOKEN ist im Worker nicht gesetzt | Secret fehlt im Worker. |

Bei Verbindungsproblemen zeigt das Dashboard „Offline – Stand HH:MM“ und behält den letzten Stand. Er wird im Browser zwischengespeichert, auch nach einem Neustart.

## Alternative ohne Apple-Passwort: veröffentlichter Kalender
In der Kalender-App den Kalender als **Öffentlicher Kalender** teilen und die `webcal://`-Adresse kopieren. Diese Adresse kann jeder lesen, der sie kennt. Im Dashboard unter **ICS-Adresse** eintragen. Das klappt nur, wenn Apple das Laden von anderen Seiten erlaubt. Sonst die Adresse im Worker als `ICS_URL` hinterlegen (Modus iCloud/Worker, `APPLE_ID` weglassen).

## Datenschutz und Sicherheit
- Im Worker liegen Apple-ID und App-Passwort als Secrets. Löschst du das App-Passwort bei Apple, ist der Zugriff sofort beendet.
- Das Dashboard bekommt nur Termindaten, nie die Apple-Zugangsdaten.
- Den Zugangscode (`APP_TOKEN`) schützt nur die Abfrage. Er liegt im Browser des Geräts, aber **nicht** im Backup der Aufgabendaten.
- Termine werden im Browser zwischengespeichert (Offline-Anzeige) und beim Ausschalten des Kalenders gelöscht.

## Grenzen
- Nur Anzeige, keine Termine anlegen oder ändern.
- Wiederholungen: täglich, wöchentlich, monatlich, jährlich mit Intervall, Wochentagen, `COUNT`/`UNTIL`, Ausnahmen und verschobenen Einzelterminen. Seltene Regeln (z. B. `BYSETPOS`) zeigen nur den ersten Termin.
- Zeiten erscheinen in der Zeitzone des Geräts.
- Getestet wurde der Worker gegen einen nachgebauten Kalenderserver, **nicht gegen echtes iCloud**. Antworten von Apple können im Detail abweichen. Meldet sich der Worker mit einem Fehler, nennt er die Ursache.
