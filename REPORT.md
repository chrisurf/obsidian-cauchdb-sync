# Obsidian CouchDB Sync — Analyse & Konzept für einen schlanken Neuanfang

> Expertenbericht / Research zu `vrtmrz/obsidian-livesync` und Konzept für ein minimales,
> CouchDB-only Live-Sync-Plugin.
> Stand: Juni 2026. Untersuchte LiveSync-Version: **v0.25.77**.

---

## 0. TL;DR — Das Wichtigste in einem Absatz

Obsidian LiveSync ist technisch hervorragend, aber **überladen**: Es unterstützt CouchDB, S3/MinIO/R2,
P2P/WebRTC, Plugin- & Settings-Sync, Hidden-File-Sync, E2EE mit mehreren Algorithmen-Generationen,
mehrere Chunking-Verfahren usw. Genau diese Vielfalt erzeugt die Probleme, die dich nerven:
**komplexe Settings, „alle Geräte müssen identische Einstellungen haben"-Zwang, ständige
Bestätigungs-Popups, Abstürze auf Mobilgeräten und das gefürchtete „Rebuild Database"**. Das mit
Abstand am häufigsten kommentierte/„gelikte" Issue heißt wörtlich *„Why make it so complex?"*.
Mein Vorschlag: Ein **neues Plugin, das nur CouchDB kann**, mit **einem Datenmodell, fast keinen
Settings, ohne Popups**, und einer **glasklaren Konfliktregel** (Master-Gerät gewinnt _oder_ neueste
Version gewinnt). Die bewährte Sync-Engine (PouchDB ↔ CouchDB Live-Replikation) übernehmen wir —
aber ohne den ganzen Ballast drumherum.

---

## 1. Wie LiveSync heute funktioniert (Architektur in Kürze)

LiveSync verwandelt deinen Vault in eine **replizierte Dokument-Datenbank**:

- Jedes Gerät betreibt eine eingebettete **PouchDB** (im Browser/Obsidian via IndexedDB).
- Der Server ist eine **CouchDB**. Da PouchDB und CouchDB dasselbe Replikationsprotokoll sprechen,
  ist „Sync" buchstäblich **Datenbank-Replikation**.
- Der Ablauf:
  1. Obsidian-Dateievent → LiveSync schreibt in die **lokale PouchDB**.
  2. PouchDB repliziert die Änderung zur **CouchDB**.
  3. Andere Geräte beobachten den CouchDB-`_changes`-Feed und ziehen Änderungen.
  4. LiveSync spiegelt die Änderungen zurück in den jeweiligen Vault.

### Das Datenmodell (vereinfacht)

Eine Datei wird **nicht** als ein Dokument gespeichert, sondern in zwei Teilen:

- **Metadaten-Dokument** (`type: "plain" | "newnote" | "notes"`): `_id` = Pfad, plus `mtime`,
  `ctime`, `size`, `deleted`, und vor allem `children: string[]` — eine **geordnete Liste von
  Chunk-IDs**.
- **Chunk-/„leaf"-Dokumente** (`type: "leaf"`): Die `_id` ist ein **Hash des Chunk-Inhalts**
  (content-addressable). Gleicher Inhalt → gleiche ID → wird nur **einmal** gespeichert
  (Deduplizierung). Beim Editieren eines Absatzes wandert nur der eine geänderte Chunk übers Netz.

Dazu kommen diverse Steuer-Dokumente: `versioninfo`, `syncinfo`, `sync-parameters` (E2EE-Parameter),
`milestoneinfo` (Cluster-Koordination, `locked`/`cleaned`-Flags), `nodeinfo`. Die Koordinations-Docs
liegen als `_local/...`-Dokumente vor (werden **nicht** repliziert — pro Endpunkt-State).

### Konfliktlösung heute

- CouchDB ist MVCC: parallele Edits erzeugen mehrere `_rev`-„Blätter" an einer `_id`. CouchDB wählt
  **deterministisch** einen Gewinner (längster Branch, bei Gleichstand Hash-Vergleich) — aber dieser
  Gewinner ist **willkürlich** bezüglich deiner Absicht.
- LiveSync versucht **Auto-Merge** „vernünftiger" Konflikte: Weil Markdown pro Absatz/Überschrift
  gechunkt ist, mergen Edits an *verschiedenen* Stellen sauber (via `diff-match-patch`).
- Wenn das nicht geht, kommt der **interaktive Konflikt-Dialog** — und das ist eine der
  Hauptquellen für die nervigen Popups.

### E2EE & Pfad-Obfuskation

AES-256-GCM (V1 mit PBKDF2, V2 mit HKDF), optional werden sogar Metadaten-Properties und Dateinamen
verschlüsselt/verschleiert. Ein E2EE-Mismatch **stoppt** den Sync hart. Mächtig — aber eine große
Komplexitäts- und Fehlerquelle.

### Warum „alle Geräte müssen gleiche Settings haben"

Zwei Dinge **müssen** clusterweit übereinstimmen, sonst bricht die Deduplizierung oder E2EE:
**Chunk-Größe, Chunk-Splitter-Version, Hash-Algorithmus** und die E2EE-Parameter. LiveSync
veröffentlicht diese „Tweak Values" im Milestone-Doc und zwingt dich bei Abweichung in einen
„Mine vs. Theirs"-Dialog. **Genau das ist die Ursache deiner „Configuration mismatch"-Frustration.**

---

## 2. Warum es bei dir abstürzt & nervt — die echten Schmerzpunkte

Aus der Analyse von 300+ offenen Issues, dem Obsidian-Forum und Reddit. Sortiert nach Schmerz:

| # | Problemklasse | Belege (Issue-Nr.) | Ursache (soweit erkennbar) |
|---|---|---|---|
| 1 | **Settings zu komplex** | #396 *„Why make it so complex?"* (Top-Issue), #853 *„focus on the UI"*, #606 *„Configuration mismatch"* | Power-User-Feature-Set mit minimalem Onboarding + harter Zwang zu identischen Sync-Parametern |
| 2 | **Abstürze/Freezes mobil** | #385 *„Not working on mobile"*, #692 *„iPhone keeps restarting"*, #171/#526 iOS-Crashes | Chunk-Enumeration + Hashing + Encryption + IndexedDB-Writes sprengen das Speicher-/CPU-Budget mobiler WebViews |
| 3 | **Sync hängt → „Rebuild"** | #382, #289, #660, #750 *„denkt alles ok, schreibt aber nicht"*, #905 *„SCRAM!"* (man muss `redflag.md`-Dateien manuell löschen) | Unvollständige Chunk-Transfers hinterlassen inkonsistenten Zustand; Reparatur = manuelle Rekonziliation |
| 4 | **Popup-Müdigkeit** | #764 *„conflict every time"*, #850 *„unlösbare data.json-Konflikte"*, #770 *„bitte alle Notifications abschaltbar"*, #830 | Settings-Dateien ändern ständig Timestamps → Dauerkonflikte; viele Warn-Dialoge by-design |
| 5 | **Datenverlust** | #492 *„0.23.22 löschte alle Dateien"*, #813 *„Dateien weg nach Rebuild"*, #754 (S3) | Rebuild + Chunk-Struktur-/Case-Änderungen zwischen Versionen + zu früh replizierte Löschungen |
| 6 | **CouchDB-Konfig-Fallen** | #676 CORS, #510 *„Chunks are not valid"*, #866 *„DB-Bloat bei Mini-Edits"*, #762 | CORS-Minenfeld (Reverse-Proxy vs. CouchDB), Size-Limits, MVCC speichert volle Revisionen statt Diffs |
| 7 | **Performance große Vaults** | #468 (jede Notiz triggert Re-Sync aller Attachments), #475, #134 | Chunking/Hashing skaliert schlecht mit Dateianzahl; Hidden-File-Sync vervielfacht Objekte |

**Kernerkenntnis:** Die meisten dieser Bugs sind **Folgen der Mächtigkeit**. Wer S3 + P2P + E2EE +
Chunk-Dedup + Plugin-Sync gleichzeitig stabil halten muss, baut zwangsläufig viele Schalter und
viele Sicherheitsabfragen ein. **Wenn wir radikal auf „nur CouchDB, nur Notizen" reduzieren,
verschwinden ganze Problemklassen automatisch.**

---

## 3. Was wir weglassen — und was wir behalten

### ❌ Streichen (für das MVP komplett raus)
- **Andere Backends:** S3 / MinIO / R2 / WebDAV (Journal-Sync), P2P / WebRTC / Trystero.
- **Customization Sync** (Themes, Snippets, Community-Plugins) & **Hidden-File-Sync** (`.obsidian/`).
  → Das ist die Quelle der `data.json`-Dauerkonflikte (#850, #475).
- **Eden-Chunks** (vom Autor selbst eingestellt) & Chunk-Packs.
- **Multiple-Remote-Management** + Connection-String-Layer — eine einzige CouchDB reicht.
- **Setup-URI / QR-Code / CLI-Bootstrap**, Dokument-/Global-History-Viewer, WebClip, i18n-Pipeline,
  Standalone-CLI/Web-Apps.
- **Mehrere Chunking-Algorithmen & mehrere E2EE-Generationen** — wir wählen **je genau eines**.

### ✅ Übernehmen (Konzept, ggf. Code-Schnipsel als Vorlage)
- **PouchDB ↔ CouchDB Live-Replikation** (`db.sync({live:true, retry:true})`) — das Herzstück.
- **Die lokale DB-Abstraktion** als Vorbild (`LiveSyncLocalDB`), stark vereinfacht.
- **Chunking** — aber **nur ein** simples, content-adressiertes Verfahren, primär für große/binäre
  Dateien. Für normale Notizen reicht zunächst „ganze Datei = 1–n Chunks".
- **CORS-Umgehung via Obsidian `requestUrl`** (eigener `fetch` für PouchDB) — löst die mobile
  CORS-Hölle elegant.
- **Auto-Merge mit `diff-match-patch`** als optionale Kür (nicht MVP-kritisch).

---

## 4. Konzept: „obsidian-couchdb-sync" — so würde ich es bauen

### Designprinzipien
1. **Eine Aufgabe, exzellent:** Live-Sync von Notizen über *eine* CouchDB. Sonst nichts.
2. **Konvention statt Konfiguration:** Sinnvolle Defaults, die *nicht* pro Gerät getunt werden müssen.
3. **Niemals nach Backups fragen.** Der Master *ist* das Backup. Keine „Bist du sicher?"-Popups.
4. **Stiller Betrieb:** Eine kleine Status-Anzeige in der Statusleiste, sonst Ruhe. Fehler ins Log,
   nicht in Modal-Dialoge.
5. **Fail-safe statt fail-loud:** Im Zweifel niemals lokal löschen/überschreiben ohne klare Regel;
   verlierende Versionen landen optional in `.trash`, nie im Nirwana.

### 4.1 Settings — bewusst minimal

Genau **fünf** Felder + zwei Schalter. Mehr nicht:

```
Server-URL        https://couch.example.com:6984
Datenbank-Name    obsidian
Benutzer          user
Passwort          ••••••••
[Verbindung testen]

Konfliktregel:  ( ) Master-Gerät gewinnt   (•) Neueste Version gewinnt
Dieses Gerät als Master festlegen:  [x]      (nur bei „Master gewinnt" relevant)
```

Optional „Erweitert" (eingeklappt, mit guten Defaults, die man nie anfassen muss):
E2EE-Passphrase (leer = aus), Chunk-Größe, Ordner-/Dateifilter (z. B. `.obsidian/` ignorieren).

**Kein** Zwang zu identischen Settings: Server-URL/User/Passwort sind ohnehin pro Gerät frei;
das Einzige, was übereinstimmen muss, ist die E2EE-Passphrase (falls genutzt) und die Chunk-Größe —
und die fixieren wir auf einen Default, den niemand ändern muss.

### 4.2 Datenmodell — so einfach wie möglich

Ein Dokument pro Datei, `_id` = Vault-relativer Pfad:

```jsonc
{
  "_id": "Notizen/todo.md",
  "type": "file",
  "mtime": 1718000000000,   // ms — Basis für „Neueste gewinnt"
  "ctime": 1717000000000,
  "size": 12345,
  "deleted": false,          // Tombstone (logisch), nicht hart löschen
  "deviceId": "laptop-A",    // Ursprungsgerät — Basis für „Master gewinnt"
  "children": ["h:<sha256>", "h:<sha256>"]  // Chunk-IDs; bei kleinen Dateien evtl. nur 1
}
```

```jsonc
// Chunk, content-adressiert, dedupliziert
{ "_id": "h:<sha256-des-chunks>", "type": "leaf", "data": "<bytes-oder-base64>" }
```

- **Renames:** `rename`-Event → Tombstone auf alte `_id`, neues Doc unter neuer `_id`. (Simpel; eine
  spätere Optimierung wäre eine stabile File-ID, im MVP nicht nötig.)
- **Löschen = Tombstone** (`deleted:true`), damit die Löschung repliziert und unterscheidbar bleibt
  von „gab es nie".
- **Binär/große Dateien:** chunken (deshalb das `children`-Array). Kleine Markdown-Dateien: ein Chunk.

### 4.3 Sync-Engine

```js
const handler = localDB.sync(remoteDB, { live: true, retry: true })
  .on('change',  info => applyRemoteChanges(info))   // direction 'pull' → in Vault schreiben
  .on('paused',  () => setStatus('synced/offline'))
  .on('active',  () => setStatus('syncing'))
  .on('error',   e  => logQuietly(e));
```

- `live:true` + `retry:true` = dauerhafter, selbstheilender Sync über den `_changes`-Feed. Der
  **Checkpoint-Mechanismus** (`_local`-Doc mit `last_seq`) sorgt dafür, dass nach Offline-Phasen dort
  weitergemacht wird, wo es aufhörte — das müssen wir nicht selbst verwalten.
- **CORS-Umgehung:** PouchDB einen eigenen `fetch` geben, der über Obsidians `requestUrl` geht →
  keine CORS-Probleme, funktioniert auf Mobil. (Genau LiveSyncs „Use Request API"-Trick.)

### 4.4 Der „Feedback-Loop" — das eigentliche Kernproblem

Wenn wir eine Remote-Änderung in den Vault schreiben, feuert Obsidian ein `modify`-Event, das wir
sonst wieder zur DB pushen → Endlosschleife. Lösung (kombiniert):
1. **Self-Write-Suppression:** Pfad vor dem Schreiben in ein `ignoreNext`-Set legen.
2. **Hash-Vergleich (robust):** Pro Pfad den zuletzt synchronisierten Inhalts-Hash merken; im
   `modify`-Handler neu hashen — gleich ⇒ ignorieren. Immun gegen doppelte/spurious Events.
3. **mtime-Abgleich** als Zusatz.

Dazu Vault-Events mit `debounce(…, 300)` entprellen, damit Tippen nicht jeden Tastendruck pusht.

### 4.5 Konfliktlösung — glasklar, ohne Popups

Nach jedem Pull (oder periodisch) `allDocs({conflicts:true})` scannen. Für jedes Doc mit `_conflicts`:

**Variante A — „Master-Gerät gewinnt":**
```js
const revs = [doc._rev, ...doc._conflicts];
const cands = await Promise.all(revs.map(r => db.get(id, {rev:r})));
const winner = cands.find(c => c.deviceId === masterId)
            ?? cands.sort((a,b)=>b.mtime-a.mtime)[0];   // Fallback: neueste
await db.put({ ...winner, _id:id, _rev:doc._rev });       // Gewinner durchsetzen
for (const r of revs) if (r!==doc._rev) await db.remove(id, r);  // Verlierer tomben
```

**Variante B — „Neueste Version gewinnt":** wie oben, aber Gewinner = größte `mtime`.
⚠️ **Uhren-Caveat:** `mtime` kommt von der lokalen Geräteuhr → bei Uhr-Schräglage kann eine *ältere*
Änderung als „neuer" erscheinen. Gegenmaßnahmen: NTP voraussetzen, zusätzlich einen
Lamport-/Sequenz-Zähler als Tiebreaker mitführen.

**Wichtig:** Konflikte **nur auf einem Gerät** auflösen (z. B. nur der Master, oder per Lock),
sonst entstehen neue Konflikte. Die `db.remove(losingRev)` repliziert die Bereinigung an alle.
Optional: verlierende Version vor dem Löschen als `Pfad (conflict laptop-B 2026-06-22).md` ablegen —
so geht **garantiert nie** etwas verloren, ganz ohne Rückfrage.

### 4.6 Erststart / Initial-Sync

1. Lokale Dateien enumerieren (`vault.getFiles()`), Hash + mtime bilden.
2. DB-Index ziehen (`allDocs({include_docs:true})`, paginiert).
3. Pro Pfad rekonziliieren: nur-lokal → hochladen; nur-DB → lokal anlegen; beide → Hash-Vergleich,
   bei Unterschied Konfliktregel anwenden; DB-Tombstone → lokal in `.trash`.
4. „last-synced Hash+mtime"-Map persistieren (`saveData`).
5. **Erst danach** Vault-Event-Listener anhängen (sonst Event-Sturm) und `db.sync(live)` starten.

---

## 5. CouchDB-Server: die Pflicht-Konfiguration (einmalig)

Damit der Sync läuft (und nicht an CORS scheitert):

| Setting | Sektion | Wert | Warum |
|---|---|---|---|
| `enable_cors` | `[chttpd]` | `true` | Browser/Mobile-Zugriff |
| `origins` | `[cors]` | `app://obsidian.md,capacitor://localhost` | Obsidians Origins (nicht `*` bei Credentials!) |
| `credentials` | `[cors]` | `true` | Auth mitsenden |
| `require_valid_user` | `[chttpd]` | `true` | Kein anonymer Zugriff |
| `max_http_request_size` | `[chttpd]` | `4294967296` | Große `_bulk_docs`/Attachments |
| `_revs_limit` | `PUT /{db}/_revs_limit` | `100` | Weniger Revisions-Ballast (gegen Bloat) |
| Compaction | `POST /{db}/_compact` | regelmäßig | Platz von alten Revisionen zurückholen |

- Einfachster CORS-Bootstrap: `npx add-cors-to-couchdb <url> -u admin -p pw`.
- **Reverse-Proxy darf CORS/OPTIONS NICHT selbst behandeln** — sonst doppelte Header (#676).
- **Mobil zwingend echtes HTTPS**, kein `http://`, kein self-signed Zertifikat.
- Per-`requestUrl`-Ansatz im Plugin umgeht die CORS-Konfiguration weitgehend — Gürtel + Hosenträger.

---

## 6. Tech-Stack-Empfehlung für das neue Plugin

- **TypeScript**, gebündelt mit **esbuild** (analog `obsidianmd/obsidian-sample-plugin`),
  `obsidian`/`electron` als externals, Target Browser (PouchDB-Browser-Build).
- **PouchDB v9**: `pouchdb-core` + `pouchdb-adapter-indexeddb` (lokal) + `pouchdb-adapter-http`
  (remote) + `pouchdb-replication` + `pouchdb-find`.
- `manifest.json` mit `isDesktopOnly: false` (Mobil-Support), keine Node/Electron-Imports.
- Optional: `diff-match-patch` (Auto-Merge), `xxhash-wasm` oder Web-Crypto-`SHA-256` (Chunk-Hash).
- **UI minimal:** Settings-Tab + ein Statusleisten-Icon. Kein Svelte-Overhead nötig.

---

## 7. Roadmap — in Phasen, jede für sich nutzbar

**Phase 0 — Skeleton (1–2 Tage):** Plugin-Gerüst, Settings-Tab (5 Felder), „Verbindung testen",
PouchDB lokal + remote verbinden.

**Phase 1 — MVP One-Shot-Sync (Kern):** Datei↔Doc-Mapping (1 Doc/Datei, kein Chunking),
Initial-Rekonziliation, manuelles „Sync now", Feedback-Loop-Schutz via Hash. **Ziel: Notizen
fließen zuverlässig hin und her.**

**Phase 2 — Live-Sync:** `db.sync({live, retry})` + Vault-Events (debounced) → echtes Live-Update
einer offenen Notiz auf dem anderen Gerät. CORS-Umgehung via `requestUrl`. Statusleisten-Anzeige.

**Phase 3 — Konfliktlösung:** Master-wins / Newest-wins, automatische Bereinigung verlierender
Revisionen, optionale `.trash`-Sicherung. **Keine Popups.**

**Phase 4 — Robustheit:** Chunking für große/binäre Dateien, Mobil-Härtung (Speicherbudget,
Batch-Größen), Offline-Resume-Tests, Self-Heal ohne „Rebuild".

**Phase 5 — Kür (optional):** E2EE (genau ein Verfahren: AES-256-GCM/HKDF), Ordnerfilter,
absatzweiser Auto-Merge via `diff-match-patch`.

---

## 8. Risiken & wie wir sie entschärfen

| Risiko | Entschärfung |
|---|---|
| Feedback-Loop (Echo-Writes) | Hash- + mtime-Abgleich + Suppression-Set; früh & gründlich testen |
| Uhr-Schräglage bei „Newest wins" | Lamport-/Sequenz-Tiebreaker; NTP empfehlen; Default = „Master wins" |
| Mobile OOM bei großen Vaults | Kein Hidden-File-Sync, Batch-Größen begrenzen, Chunks lazy laden |
| CouchDB-Bloat (MVCC) | `_revs_limit` niedrig + automatische Compaction dokumentieren |
| Datenverlust bei Konflikt | Verlierer nie hart weg — optional in `.trash`; nur 1 Gerät löst auf |
| Versions-Drift zwischen Geräten | Genau *ein* Chunking-/E2EE-Verfahren, fest verdrahtet, keine Tweaks |

---

## 9. Mein Fazit & Empfehlung

LiveSync ist ein Schweizer Taschenmesser; du willst ein **scharfes Küchenmesser**. Die richtige
Strategie ist **nicht**, LiveSync zu forken und auszudünnen (der Code ist tief modular und auf alle
Backends/Features ausgelegt — Ausbauen ist mühsamer als Neubauen), sondern **die bewährte
Sync-Engine-Idee neu und minimal zu implementieren**: PouchDB-Live-Replikation gegen *eine* CouchDB,
ein simples Datenmodell, eine glasklare Konfliktregel, fünf Settings, null Popups.

Damit adressieren wir direkt die vier lautesten Beschwerden der LiveSync-Community
(Komplexität, Mobil-Crashes, Rebuild-Hölle, Popup-Müdigkeit) — und du bekommst genau das, was du
willst: **Notizen, die live über alle Geräte hinweg zuverlässig synchron sind, und bei Konflikten
gewinnt entweder dein Master-Desktop oder die neueste Version. Punkt.**

**Vorgeschlagener nächster Schritt:** Ich baue **Phase 0 + Phase 1** als lauffähiges Plugin-Gerüst
auf diesem Branch — dann kannst du es gegen deinen CouchDB-Server testen, und wir iterieren von dort.

---

### Quellen (Auswahl)
- LiveSync Repo & Doku: `github.com/vrtmrz/obsidian-livesync` (README, `docs/tech_info.md`,
  `docs/datastructure.md`, diverse `design_docs_*`), `github.com/vrtmrz/livesync-commonlib`.
- Top-Issues: #396 (Komplexität), #385/#692 (Mobil-Crashes), #606 (Config-Mismatch),
  #813/#492 (Datenverlust nach Rebuild), #510 (Chunks invalid), #866 (DB-Bloat), #905 (SCRAM),
  #764/#850 (Konflikte), #676 (CORS).
- PouchDB: `pouchdb.com/guides/replication.html`, `…/conflicts.html`, `…/attachments.html`,
  `…/changes.html`, `pouchdb.com/api.html`.
- CouchDB: `docs.couchdb.org` (Replikations-/Konflikt-Modell, HTTP/CORS-Config, Compaction,
  `_revs_limit`), `github.com/pouchdb/add-cors-to-couchdb`.
- Obsidian: `docs.obsidian.md/Plugins/Vault`, `…/Events`, `…/Reference/Manifest`,
  `obsidianmd/obsidian-sample-plugin`.
