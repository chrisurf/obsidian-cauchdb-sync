# Code-Review: Obsidian CouchDB Sync

**Datum:** 2026-07-01
**Version:** 0.32.0
**Umfang:** vollständiges, kritisches Review der gesamten Codebase (`src/`, 4150 Zeilen über 8 Module), Build-/Test-Status, Datenbank-Verhalten und der konkreten Symptome aus den aktuellen Screenshots.

> Dieses Dokument ist bewusst hart und ehrlich. Es ergänzt die ältere `REPORT.md` (das ist das *Konzept*-Dokument von vor dem Bau) und bewertet die *tatsächliche Implementierung*.

---

## 0. TL;DR — Gesamteinschätzung

Die Codebase ist **handwerklich überraschend sauber** für ein „noch in Entwicklung"-Plugin: gute Kommentare, klare Modulgrenzen, durchdachtes Chunking, ordentliche Krypto. `tsc --noEmit` ist grün, ESLint ist grün, 57 Unit-Tests laufen durch.

**Aber:** Die Tests decken nur die zwei reinen Module (`util.ts`, `crypto.ts`) ab. Der gesamte gefährliche Teil — `engine.ts` (1337 Zeilen), `database.ts`, `main.ts`, `settings.ts` — hat **null automatisierte Abdeckung**. Alle relevanten Bugs sitzen genau dort.

Die drei Symptome aus deinen Screenshots haben klar identifizierbare Ursachen im Code:

| Symptom | Ursache | Schweregrad |
|---|---|---|
| `Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing` | **Race zwischen zwei unabhängigen Timern**, die dieselbe PouchDB per Name öffnen und schließen (siehe §2.1) | 🔴 kritisch |
| 1309 Dateien „local only", nur 53 „synced", 1319 pending | Der Vault indexiert **`.git/` und `.obsidian/` komplett mit** (Config-Regression, §2.2) + langsamer serieller Initial-Index | 🔴 kritisch |
| 7 Konflikte auf `.mp3`-Dateien, dauerhaft rot | Der Konflikt-Resolver läuft **nur bei aktiver Session**; die Session ist per Crash-Guard aus (§2.3) | 🟠 hoch |

Kurz: Das Fundament ist gut, aber es gibt **eine echte Datenbank-Race-Condition**, eine **Config-Regression, die `.git` synchronisiert** (potenziell repo-zerstörend), und **strukturell fehlende Robustheit** bei Skalierung und Nebenläufigkeit.

---

## 1. Was gut ist (damit das Review fair bleibt)

- **Content-addressed Chunking** (`h:<sha256>`) mit Dedup ist das richtige Datenmodell. Immutable Chunks können nie in Konflikt geraten — sauber gelöst.
- **CORS-Bypass** via `requestUrl()` als `fetch`-Ersatz (`database.ts:18`) ist der pragmatisch korrekte Weg für Desktop **und** Mobile.
- **Range-Queries** über `f:`/`h:`/`H:`-Präfixe, um Chunk-Daten nie versehentlich in den Speicher zu laden — das ist genau die Lektion aus den früheren OOM-Abstürzen und gut umgesetzt (`database.ts:99`).
- **Krypto** (`crypto.ts`): AES-256-GCM, PBKDF2 210k Iterationen, per-message Salt+IV, Key-Cache. Standardkonform. Kein selbstgebautes Krypto.
- **Streaming-Download auf Desktop** (`writeBinaryStreaming`, `engine.ts:1139`) mit Temp-Datei + atomarem Rename ist robust gegen Abbrüche.
- **Vault-Isolation** über zufällige `localDbId` (`main.ts:36`) — löst das „alle Vaults teilen sich eine PouchDB unter `app://obsidian.md`"-Problem korrekt.
- **Crash-Guard** (`unsafeShutdown`) ist konzeptionell richtig gedacht.

Das ist keine schlechte Codebase. Die Probleme sind spezifisch, nicht flächendeckend.

---

## 2. Kritische Bugs (nach Schweregrad)

### 2.1 🔴 IDBDatabase-Race: zwei Timer öffnen/schließen dieselbe PouchDB

**Das ist die Ursache der roten Fehlermeldung im Screenshot.**

Es gibt zwei **komplett unabhängige** Timer, die beide `getIndexReport()` aufrufen, wenn keine Session läuft:

- `main.ts:136` — `refreshDriftSummary()` alle **5 s** (läuft *immer*, auch bei geschlossenem Settings-Tab)
- `settings.ts:402` — `loadIndex()` alle **3 s** (wenn Settings offen)

Wenn keine Engine läuft, öffnet `getIndexReport()` jedes Mal eine **neue** `SyncDatabase` mit demselben Namen und schließt sie im `finally` wieder:

```ts
// main.ts:517
const db = new SyncDatabase(this.settings, localDbName(this.settings));
try {
    ...
    return await buildIndexReport(this.app, this.settings, db);
} finally {
    await db.close().catch(() => undefined);   // <-- schließt die geteilte IDB-Verbindung
}
```

PouchDB-browser teilt sich die zugrunde liegende `IDBDatabase`-Verbindung **pro Datenbankname**. Wenn Timer A `close()` aufruft, während Timer B noch eine offene `allDocs`-Transaktion hat → **`The database connection is closing`**.

Der Kommentar bei `main.ts:513` behauptet, das sei durch „ONE open/close per call" gelöst. **Ist es nicht.** Der Guard verhindert nur, dass sich *ein* Call selbst überlappt. Er verhindert nicht, dass die **zwei unabhängigen Timer** einander ins Handle grätschen. Der `indexLoading`-Guard in `settings.ts:502` schützt `loadIndex` ebenfalls nur gegen sich selbst — nicht gegen `main.refreshDriftSummary`.

Zusätzliche TOCTOU-Variante: `getIndexReport` liest `this.engine` (Zeile 506), findet `null`, öffnet ein eigenes Handle — und wenn zwischenzeitlich `doRestart()` eine Engine mit **demselben** DB-Namen hochzieht, killt das `close()` des Reports die frische Engine-Verbindung.

**Fix (empfohlen):**
1. **Ein einziges, langlebiges `SyncDatabase`-Handle** im Plugin halten (auch im Idle-Zustand). Nie pro Report öffnen/schließen. Idle heißt nur „keine Replikation läuft", nicht „DB-Handle zu".
2. Alle Reader (`getIndexReport`, `checkOriginFingerprint`, `stampOriginFingerprint`, `withReader`, `removeFromIndex`) über **dieses eine Handle** laufen lassen.
3. Die beiden Timer über **einen** serialisierten Refresh-Pfad (ein `Promise`-Lock wie `restartLock`) führen, sodass sich Drift-Refresh und Index-Refresh nie überlappen.

Solange Handles pro Name geöffnet/geschlossen werden, wird dieser Fehler sporadisch wiederkommen — egal wie viele lokale Guards dazukommen.

---

### 2.2 🔴 Der Vault synchronisiert `.git/` und `.obsidian/` komplett mit

Deine aktive `data.json` zeigt:

```jsonc
"syncHidden": true,
"hiddenExclude": [
  ".trash/", ".DS_Store", "node_modules/", ".claude/", "tmp/",
  ".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".obsidian/cache"
]
```

`.git/` und `.obsidian/` **fehlen** in dieser Liste — obwohl `DEFAULT_SETTINGS.hiddenExclude` (`types.ts:108`) beide enthält. Weil `loadSettings()` mit `Object.assign({}, DEFAULT_SETTINGS, await this.loadData())` (`main.ts:646`) arbeitet, **überschreibt die persistierte Liste die Defaults vollständig** (kein Merge pro Array-Eintrag).

Konsequenz mit `syncHidden: true`:
- `listHidden()` (`engine.ts:70`) läuft rekursiv durch `.git/` — hunderte bis tausende Objekte, Packs, Refs.
- All das wird als „local only" gezählt → **das sind deine 1309 pending Dateien.**
- Der Initial-Index arbeitet **seriell, eine Datei pro Event-Loop-Tick** (`engine.ts:584`, `await this.yieldToUi()`), und persistiert dabei den kompletten State (siehe §2.4) → er wird bei tausenden Git-Objekten praktisch **nie fertig**.

Zusätzlich liegen in `data.json` **Leichen aus einem alten Datenmodell**:

```jsonc
"excludePatterns": [ ".git/", ... ],   // <-- wird vom aktuellen Code NICHT gelesen
"ignorePatterns":  [ ".git/", ... ]    // <-- ebenfalls tot
```

Das ist eine **Migrations-Regression:** Als das Modell von `excludePatterns`/`ignorePatterns` auf `hiddenExclude`/`hiddenInclude` umgestellt wurde, wurde `.git/`/`.obsidian/` **nicht in die neue Liste übernommen**. Die alten Keys blieben liegen und suggerieren fälschlich, `.git` sei ausgeschlossen.

**Warum das gefährlich ist:** Ein Git-Repository über CouchDB zu synchronisieren ist **repo-zerstörend**. Objekte, Packs und Refs replizieren unabhängig und mit Verzögerung; ein halb-synchronisiertes `.git/` auf einem zweiten Gerät ist ein korruptes Repo. `.obsidian/workspace.json` ist bereits ausgeschlossen — aber der Rest von `.obsidian/` (inkl. Plugin-Binaries, `main.js` mit 1,4 MB) wird mitgeschleift.

**Fix:**
1. **`.git/` immer hart ausschließen**, unabhängig von der Nutzer-Config — genau wie das eigene `data.json` bereits hart ausgeschlossen wird (`engine.ts:60`). Das gehört in `isSkipped()`, nicht in eine editierbare Liste.
2. **Migration schreiben:** beim Laden alte Keys erkennen und in `hiddenExclude` mergen; fehlendes `.git/`/`.obsidian/` ergänzen.
3. `Object.assign`-Merge für Array-Defaults überdenken (z. B. Pflicht-Ausschlüsse immer zur Nutzerliste dazu-unionen).

---

### 2.3 🟠 Konflikt-Resolver läuft nur bei aktiver Session

Die 7 `.mp3`-Konflikte bleiben rot, weil:
- `resolveConflicts()` (`engine.ts:1248`) wird nur aus `runInitialIndex`, `replicateOnce`, `downloadOnce`, `applyPulledDocs` und den Per-File-Aktionen aufgerufen — **alle setzen eine laufende Engine voraus**.
- Deine Session ist per Crash-Guard aus (`unsafeShutdown` hatte gegriffen → `autoStart` off, `liveSync` off).

Damit sammeln sich Konflikte an und **niemand räumt sie automatisch auf**, solange nicht manuell „Sync now" gedrückt wird. Das ist genau der Zustand im Screenshot: „Idle", aber 7 Konflikte + 3 Differs stehen offen.

**Warum überhaupt Konflikte auf identischen MP3s?** Content-addressed Chunks kollidieren nie, aber das **File-Doc** `f:<path>` ist mutable. Zwei Geräte, die dieselbe Datei anlegen/berühren, erzeugen zwei `_rev`-Leaves → CouchDB-Konflikt, auch wenn `children`/`hash` identisch sind. Das ist normal — nur wird es eben nur *in* einer Session aufgelöst.

Ein subtilerer Fall: wenn `mtime` sich zwischen Geräten unterscheidet (z. B. Google-Drive-Umweg, unterschiedliche Dateisysteme), erzeugt jede Seite ein neues File-Doc, obwohl der Inhalt byte-identisch ist. `pushPathInner` fängt das teilweise ab („identical content already in the DB — adopt it", `engine.ts:726`), aber nur wenn das existierende Doc **vor** dem Schreiben schon da war — bei echter Nebenläufigkeit greift das nicht.

**Fix:**
- Konfliktauflösung **auch im Idle-Betrieb** anbieten/ausführen (ein leichter periodischer `getConflicted()` + resolve, ohne volle Live-Session).
- Bei `pushPathInner`: wenn `existing.hash === hash`, nicht nur adоptieren, sondern auch **losing revs droppen** (aktuell nur bei `takeLocal`/`takeRemote`).

---

### 2.4 🟠 Per-Device-State wird bei jedem Datei-Index komplett neu serialisiert (O(N²))

`recordSynced()` → `saveStateSoon()` (debounced 1,5 s) → `persistSyncState()` schreibt **die gesamte Map als ein einziges `_local`-Doc**:

```ts
// engine.ts:1322
await this.db.putLocalDoc(SYNC_STATE_DOC, {
    records: Object.fromEntries(this.syncState),   // <-- ganze Map, jedes Mal
});
```

Bei 1372 Dateien wird dieses Dokument bei jeder Index-Welle komplett neu geschrieben. Während des Initial-Index (jede Datei ruft `recordSynced`) ist das effektiv **O(N²)** an Serialisierungsarbeit und ein einzelnes, stetig wachsendes `_local`-Doc. Das erklärt einen guten Teil der IDB-Last (und verschärft §2.1).

**Fix:** Pro-Datei-Records als **einzelne** `_local/rec:<path>`-Docs speichern (inkrementelles Schreiben), oder gebündelt in Batches statt „ganze Map bei jeder Änderung".

---

### 2.5 🟡 `cyrb53` als Content-Identität → theoretischer Datenverlust

`hash = cyrb53(children.join("|"))` (`engine.ts:723`). Dieser 53-Bit-Nicht-Krypto-Hash entscheidet in `pushPathInner`:

```ts
if (existing && !existing.deleted && existing.hash === hash) {
    // identical content — adopt, kein Upload, kein Konflikt
    return;
}
```

Bei einer `cyrb53`-Kollision zweier **unterschiedlicher** `children`-Listen würde eine Datei fälschlich als „identisch" adоptiert → **stiller Inhaltsverlust**. Die echte Identität steckt bereits in der `children`-Liste (SHA-256). Der abgeleitete `cyrb53` ist als *Fingerprint* okay, aber nicht als *Gleichheitsbeweis*.

**Fix:** Für die Gleichheitsentscheidung die `children`-Arrays direkt vergleichen (elementweise), nicht den `cyrb53`. Der Hash darf für UI/Drift-Anzeige bleiben.

---

## 3. Nebenläufigkeit & Echo-Guard

### 3.1 🟡 Debounce + `suppress`-Set kann echte Nutzer-Edits verschlucken

`attachVaultEvents()` debounced `modify` um 400 ms (`engine.ts:607`). Beim Anwenden einer Remote-Änderung wird `suppress.add(path)` gesetzt und dann `vault.modify()` aufgerufen. Das ausgelöste `modify`-Event soll durch `suppress` geschluckt werden.

Problem: `suppress` ist ein `Set<string>` **ohne Zähler**. Szenario:
1. Remote-Write auf `foo.md` → `suppress.add("foo.md")`, `vault.modify(...)`.
2. Nutzer editiert `foo.md` innerhalb der 400-ms-Debounce-Fenster.
3. Beide `modify`-Events kollabieren zu **einem** debounced Call.
4. Der Call sieht `suppress`, löscht es, `return` → **die echte Nutzer-Änderung wird nie hochgeladen.**

Selten, aber es ist ein echter Datenverlust-Pfad. Gleiches gilt, wenn zwei aufeinanderfolgende Remote-Writes nur ein `suppress`-Token hinterlassen.

**Fix:** `suppress` als `Map<path, count>` oder mit einem Erwartungs-Hash („ignoriere das nächste Event *nur* wenn der Inhalt exakt dem entspricht, was ich geschrieben habe").

### 3.2 🟡 Healing-Schleife kann pingpongen

In `applyRemoteChange` (`engine.ts:825`) wird bei fehlendem Chunk „geheilt", indem die lokale Datei neu hochgeladen wird (`forceSync`). Wenn der lokale Inhalt aber **vom Doc abweicht**, erzeugt das ein neues Doc/Hash → das andere Gerät zieht es → ggf. wieder Konflikt → wieder Heal. Unter gleichzeitiger Bearbeitung besteht Schleifengefahr. Zumindest ein Zähler/Backoff pro Pfad wäre sinnvoll.

---

## 4. Sicherheit & E2EE

Das ist solide gebaut, aber die **Marketing-Aussage „end-to-end encrypted" ist zu stark** für das, was tatsächlich verschlüsselt wird.

- **Metadaten sind Klartext auf dem Server:** Datei-**Pfade** (`f:<path>` als Doc-ID *und* `path`-Feld), **Größen**, **mtime**, **Device-IDs**, `binary`/`enc`-Flags. Nur der Chunk-*Inhalt* ist verschlüsselt. Wer Zugriff auf den CouchDB hat, sieht die komplette Ordner-/Dateistruktur und Änderungszeiten. Die Settings-Beschreibung erwähnt das immerhin („UNENCRYPTED file paths, sizes, and hashes") — die Haupt-Description im `manifest.json` („End-to-end encrypted by default") nicht.
- **Passphrase + Passwort liegen im Klartext in `data.json`** (im Review sichtbar). Das ist bei Obsidian-Plugins systembedingt, aber: `forgetCacheOnDisable` löscht nur die PouchDB, **nicht** `data.json`. Die „Privacy-Mode"-Zusage ist damit unvollständig — der geheimste Wert bleibt liegen.
- **Chunk-Dedup leakt Struktur:** Gleiche Klartext-Chunks → gleiche `h:`-ID (weil `id = sha256(pass + ":" + b64)`). Der Server sieht, welche Chunks sich innerhalb/zwischen Dateien wiederholen. Der Passphrase-Präfix verhindert immerhin *Known-Plaintext*-Angriffe ohne Passphrase — gut. Aber die Wiederholungsstruktur ist sichtbar.
- **Keine Passphrase-Verifikation gegen den Server-Bestand:** Wenn ein zweites Gerät eine *falsche* Passphrase setzt, schlägt erst beim Entschlüsseln einzelner Chunks fehl (`crypto.ts:96`). Ein Startup-Check („kann ich ein bekanntes Sentinel-Doc entschlüsseln?") würde das früh und klar melden.

**Empfehlung:** Entweder Pfad-Obfuskation nachrüsten (HMAC der Pfade, wie es die REPORT.md bereits als bewusst weggelassen dokumentiert) **oder** die Beschreibung ehrlich auf „Inhalts-Verschlüsselung; Metadaten unverschlüsselt" anpassen.

---

## 5. Performance & Skalierung

- **Base64-Inflation:** Chunks werden als base64-JSON-String im Doc gespeichert → +33 % Größe, plus JSON-Overhead. Ein 1-MiB-Chunk wird zu ~1,4 MB Doc (im Code selbst notiert, `engine.ts:410`). Für einen media-lastigen Vault (deine `.mp3`s) bläht das die DB stark auf. **CouchDB-Attachments** wären hier effizienter (binär, kein base64, separate Kompaktierung).
- **Mobile-OOM bleibt möglich:** Der Streaming-Pfad greift nur auf Desktop + `FileSystemAdapter` (`engine.ts:761`, `816`). Auf Mobile geht *jede* Datei durch `writeAssembled` → **alle Chunks in den Speicher** + zusätzliche `ArrayBuffer`-Kopie (`engine.ts:1195`). Ein 100-MB-Video auf dem Handy = OOM. Bekannte Einschränkung, aber `isDesktopOnly: false` im Manifest verspricht mehr, als der Code für große Binärdateien halten kann.
- **Serieller Initial-Index** mit `setTimeout(0)` pro Datei ist UI-freundlich, aber bei tausenden Dateien quälend langsam (verschärft durch §2.2 und §2.4).
- **`connectRemote()` erzeugt bei jedem Aufruf ein neues Remote-PouchDB-Objekt** (`database.ts:68`), u. a. in `start`, `replicateOnce`, `downloadOnce`. Für HTTP-Remotes unkritisch, aber unsauber.

---

## 6. Weitere Auffälligkeiten (kleiner, aber real)

- **`putLocalDoc` ist irreführend benannt:** Es schreibt nur dann ein echtes `_local/`-Doc, wenn die ID mit `_local/` beginnt. `MASTER_INFO_ID = "couchdb-sync:masterinfo"` (`engine.ts:39`) tut das **nicht** → das Master-Info-Doc **repliziert** (vermutlich gewollt, aber der Name suggeriert „lokal, nicht repliziert" — Stolperfalle).
- **`Test connection` legt eine Wegwerf-PouchDB `couchdb-sync-test-probe` an** (`settings.ts:136`) und ruft `close()`, aber `destroy()` nie → leere lokale DB bleibt liegen.
- **Tombstones werden nie gepurged:** Logische Deletes (`deleted:true`, `engine.ts:645`) bleiben als File-Docs für immer in der DB und replizieren ewig. Bei viel Lösch-Aktivität wächst die DB monoton.
- **`legacyLocalDbDocCount()`** öffnet bei jedem `display()` des Settings-Tabs eine Probe-DB (`settings.ts:350`) — ein weiterer paralleler PouchDB-Open, der mit §2.1 interagieren kann.
- **`padStart(15, "0")`** für den History-Timestamp (`engine.ts:890`) reicht bis Jahr 2286 — okay, nur der Vollständigkeit halber.

---

## 7. Test- & Architektur-Lücken

- **Kernlogik ist ungetestet.** `engine.ts` (Konfliktauflösung, Chunking, Heal-Logik, Echo-Guard), `database.ts` (Range-Queries, `putIfAbsent`-Races) und die Lebenszyklus-Logik in `main.ts` haben **keine** Tests. Das ist die eigentliche Wurzel dafür, dass „sehr viele Bugs drin sind": Es gibt kein Netz, das Regressionen wie §2.1 oder §2.2 fängt.
- **CLAUDE.md sagt selbst**, `engine.ts` sei „excluded from unit test coverage. Test them via integration/manual testing" — aber es gibt kein Integrations-Setup. Das ist der teuerste blinde Fleck.
- **Empfehlung:** Ein `pouchdb-adapter-memory`-basiertes Test-Harness. Damit lassen sich `engine.ts` und `database.ts` **ohne** Obsidian-API testen (nur `App`/`Vault`/`TFile` mocken). Prioritär abzudecken:
  1. Konflikt: zwei Devices schreiben denselben Pfad → korrekter Winner, losing revs gedroppt.
  2. Heal: fehlender Chunk + lokale Datei vorhanden → Re-Upload, kein Endlos-Loop.
  3. Skip-Regeln: `.git/` **immer** ausgeschlossen, egal welche Config.
  4. Echo-Guard: Remote-Write + gleichzeitiger lokaler Edit → Edit geht nicht verloren.

---

## 8. Priorisierte Maßnahmen

**Sofort (blockiert stabiles Testen):**
1. **§2.2** `.git/` hart ausschließen + Migration für fehlende Default-Ausschlüsse. Sonst indexierst du bei jedem Test wieder tausende Git-Objekte.
2. **§2.1** Ein einziges langlebiges DB-Handle + serialisierter Refresh-Pfad. Beendet den `IDBDatabase`-Fehler dauerhaft.
3. **Lokale DB einmal wipen** (siehe §9) — der aktuelle lokale Bestand ist durch §2.2/§2.4 verunreinigt.

**Kurzfristig:**
4. **§2.3** Konfliktauflösung idle-fähig machen.
5. **§2.4** Per-Device-State inkrementell statt „ganze Map".
6. **§2.5 / §3.1** `children`-Vergleich statt `cyrb53`; `suppress` mit Zähler/Hash.

**Mittelfristig:**
7. Test-Harness mit `pouchdb-adapter-memory` für `engine`/`database`.
8. Base64 → CouchDB-Attachments (DB-Größe, Mobile-Speicher).
9. Manifest-/README-Aussage zu E2EE ehrlich schärfen oder Pfad-Obfuskation nachrüsten.

---

## 9. Konkret: so testest du sauber weiter

Dein Verdacht stimmt — die lokale DB ist „veraltet"/verunreinigt. Vorgehen:

1. **Config zuerst reparieren**, sonst holst du dir den Müll sofort wieder rein. In den Plugin-Settings `hiddenExclude` um `.git/` und `.obsidian/` ergänzen — **oder** `syncHidden` erstmal ausschalten, bis §2.2 im Code gefixt ist.
2. **Lokalen Cache wipen:** Settings → „Wipe local cache" (bzw. Command „Wipe local cache"). Das löscht **nur** die lokale PouchDB, der Server bleibt unberührt (`main.ts:424`).
3. Falls der Server-Bestand `vault-testing` selbst schon durch `.git`/`.obsidian` verunreinigt ist (1372 Docs sprechen dafür): erwäge, die **Remote-DB serverseitig neu anzulegen**, da ihr eh nur Testdaten habt. Sonst replizierst du den Müll wieder herunter.
4. Danach „Sync now" mit sauberer Config → der Index sollte dann realistisch (~60–70 echte Dateien) statt 1372 zeigen.

> Hinweis: Passphrase und Passwort stehen im Klartext in `data.json`. Da hier laut deiner Aussage nur Testdaten liegen, ist das okay — aber **vor** irgendeinem echten Einsatz die Credentials rotieren, da sie in dieser Review-Session (und im Git-Verlauf, falls `data.json` je committed wurde) sichtbar waren.

---

## 10. Fazit

Das Plugin ist **kein Wegwerf-Prototyp** — das Datenmodell und die Krypto tragen. Die aktuellen Schmerzen kommen aus **drei konkreten, behebbaren Stellen**: der DB-Handle-Race (§2.1), der `.git`/`.obsidian`-Config-Regression (§2.2) und dem idle-blinden Konflikt-Resolver (§2.3). Keine davon erfordert einen Neuanfang.

Der größte strukturelle Hebel ist **Testabdeckung für `engine.ts`**. Solange die riskanteste Logik ungetestet bleibt, wird jede neue Funktion neue Bugs derselben Art produzieren — und du entdeckst sie erst wieder als rote Kachel im Screenshot statt als fehlgeschlagener Test.
