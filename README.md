# CouchDB Sync for Obsidian

Simple, reliable live synchronization of your Obsidian vault against a self-hosted **CouchDB**
server, with **end-to-end encrypted note content**. A deliberately minimal alternative to the
(excellent but very complex) [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) —
CouchDB only, a handful of settings, and **no pop-ups**.

> **Encryption scope:** with encryption on (the default), note *content* **and** metadata (file
> paths, sizes, timestamps) are encrypted end-to-end. A little residual metadata remains (total data
> volume, chunk dedup structure) — see [Security model](#security-model) for exactly what is and
> isn't protected.

> **Status (June 2026): working MVP, validated on desktop.** A vault (incl. large audio/`.lpf`
> files) syncs cleanly and reliably into CouchDB on a single desktop device. Multi-device sync
> (a second desktop) is the next test. See [Status & roadmap](#status--roadmap) and
> [`REPORT.md`](./REPORT.md) for the original analysis of LiveSync's pain points.

## Why

LiveSync is powerful but supports many backends (S3/MinIO, P2P/WebRTC), config/plugin sync, multiple
encryption and chunking generations, and requires **byte-identical settings across all devices**.
That power is the source of its most common complaints: settings complexity, mobile crashes, the
dreaded "rebuild database", and endless confirmation pop-ups.

This plugin does **one** thing well: live note sync over **one** CouchDB — with transparent,
plain-language UX.

## Features

- 🔄 **Live two-way sync** via PouchDB ↔ CouchDB continuous replication (or a one-shot "Force sync").
- 🧩 **Chunked, streaming storage** — files of any size (images, PDFs, audio, video) are split into
  1 MiB content-addressed chunks. Reads and writes stream to/from disk, so a 600 MB file never sits
  in memory; unchanged chunks are reused.
- 🔐 **End-to-end encryption on by default** — note **content and metadata** (file paths, sizes,
  timestamps, device ids) are encrypted at rest with AES-256-GCM (PBKDF2-derived key, 210k
  iterations), TLS in transit. Document ids are keyed HMACs of the path, so the server never sees a
  filename. The passphrase never touches the server and must match across devices. A little residual
  metadata remains — see [Security model](#security-model).
- ⚖️ **No-prompt conflict resolution**: *newest version wins* or *master device wins*.
- 📊 **Full-transparency index status** — at a glance: how many of your files are in sync (`X / Y`,
  with %), and a collapsible **Sync state** tree of every file across this device *and* the server,
  **colour-coded** into five distinct states so you can tell exactly what each file needs:
  🟢 green = in sync, 🟠 amber = local only (not uploaded yet), ⚪ grey = remote only (not downloaded
  here), 🟣 purple = content differs (auto-reconcilable drift), 🔴 red = unresolved conflict.
  Folders roll up to the most urgent state inside them (green only when the whole subtree is clean),
  and the summary/lists/tree all derive from one classification so they never disagree. Updates
  **in place** every few seconds — no flicker.
- 🎛️ **Reachable from the status bar** — the status-bar item is two controls: the icon switches sync
  on and off, and the label (`CouchDB 63%`) opens the full status panel in the right sidebar.
  That panel is the *same* component the settings tab embeds — same tree, same per-file actions, not
  a read-only copy — so you can manage sync without opening settings at all.
- ✨ **Live per-file feedback** — files being transferred pulse with a left-to-right "scan" shimmer
  and show **chunk progress** (`12 / 40 chunks · 30%`).
- 🩹 **Self-healing** — if a download references a chunk that went missing (e.g. an interrupted
  earlier upload) and the file exists locally, the plugin re-uploads it to regenerate the chunk
  instead of getting stuck.
- 🧰 **Per-file & per-folder controls** — every row has a **⋯ actions** menu (only the moves that make
  sense for its state: *download/overwrite local*, *upload/overwrite server*, *sync now/once*,
  *delete on this device*, *delete everywhere*, *remove from index*), a red **✕** to remove from the
  index, and a 🕘 **History** button (see below). Folders apply the same actions in bulk to everything
  inside them.
- 🕘 **Full file history & restore** — the plugin keeps an explicit, append-only version log per file
  (content chunks are deduplicated, so history costs only small metadata). Browse every version
  chronologically, **diff any two** versions *side-by-side* or *inline*, and **restore** any earlier
  version on all devices with one click — restores are themselves reversible.
- 🚫 **Excluded files, on demand** — optionally surface files the skip rules exclude (bounded, opt-in)
  so you can inspect or sync one once, for full transparency over *all* data.
- 📁 **Hidden files (optional)** — sync `.obsidian` (settings, plugins), `.git`, etc. with a simple
  toggle and an exclude/include list. Off by default.
- 🛟 **Safe by design** — no destructive "rebuild" ritual; a **crash guard** switches sync off
  (visibly, on the master switch) after an unclean shutdown so you can never get stuck in a crash
  loop; **Wipe local cache** only touches this device.
- 📵 **CORS-free** networking via Obsidian's `requestUrl` (works on mobile too).

## Design decisions (why it feels simple)

The whole point is to be the opposite of "too many settings, too many pop-ups". The choices below
are deliberate:

- **One backend only (CouchDB).** No S3/P2P/WebRTC. Removes whole classes of settings and bugs.
- **No confirmation pop-ups.** Conflicts resolve automatically by a rule you pick once. Destructive
  actions are local-only or clearly labelled; the master device is your backup.
- **Transparency over configuration.** Instead of asking you to understand the internals, the
  **Index status** shows the truth: counts, %, drift, the file tree, and what's being worked on
  right now — even when sync is idle.
- **One switch, one action.** Two controls, two clearly separated roles: the **switch** decides
  *whether* this vault syncs (a state — persisted, and also the way to stop), and **Force sync** just
  *does it once* (an action — it changes no setting). Turning the switch on starts syncing straight
  away; there is no second "start automatically" setting to contradict it, and no button that
  doubles as a second off switch.
- **Controls map to plain verbs.** *Force sync* (in the status card), *Download only* (pull, for
  followers), *Wipe local cache*. Toggles take effect immediately.
- **Memory- and mobile-safe pipeline.** Small files first; large files stream and trickle in the
  background; replication batches are bounded — so the app stays responsive and never OOMs.
- **Crash-safe, not crash-prone.** After an unclean shutdown sync is switched off rather than
  retrying a failing operation forever — and you can see that it is off, and why. Recovery is always
  reachable.
- **Single clean version.** No migration/back-compat cruft while in active development.

## Security model

Be precise about what "end-to-end encrypted" means here, so you can decide whether it fits your
threat model:

With **encryption enabled** (the default), the server stores no readable content *or* metadata.

**Encrypted (unreadable to the server or anyone with the CouchDB data):**

- **Note content.** Every chunk's bytes are encrypted with AES-256-GCM before upload. The key is
  derived from your passphrase via PBKDF2-SHA-256 (210k iterations) with a random per-message salt
  and IV. The passphrase is never sent to the server. TLS protects everything in transit.
- **File paths / names.** Document ids are `f:<HMAC-SHA-256(path)>` — a *keyed* one-way hash, so the
  server sees an opaque id, never the path. The real path travels **encrypted** inside the document.
- **File sizes, modification/creation timestamps, and device ids.** All of it lives in the
  encrypted document body, not in clear fields.
- **Which chunks a file is made of** — the file→chunk mapping is encrypted, so the server cannot tie
  chunk documents to files.

**Still visible to someone who can read the CouchDB database (residual metadata):**

- **The existence and approximate total volume of data** — the number of chunk documents and each
  chunk's size are visible (so an observer can estimate how much you store, but not which file any
  chunk belongs to).
- **Content-addressed dedup structure** — identical chunks share an id, so repetition is visible.
  The chunk id is a *keyed* hash (includes the passphrase), so it does **not** leak the plaintext.
- **That a document is a deletion** (a tombstone flag stays clear) and a coarse count of files/versions.
- **Version timestamps** — encoded in the history id so the timeline can sort chronologically.
- **The *master device* marker** — one device id in a small control document.

**On this device:**

- The local cache (PouchDB/IndexedDB) stores the **same encrypted form** as the server; metadata is
  only ever decrypted in memory. Turn on **“Forget local cache when plugin is disabled”** to destroy
  the cache on disable.
- Your **passphrase and CouchDB password are stored in clear** in the plugin's `data.json`
  (`.obsidian/plugins/couchdb-sync/data.json`) — as with essentially every Obsidian plugin that
  holds credentials. `data.json` is never synced, and “Forget local cache” does **not** remove it.
  Protect it with full-disk encryption, and rotate credentials if the file was ever exposed.

> **Changing the encryption setting or passphrase is a storage-format change:** the document ids
> depend on the passphrase, so switching encryption on/off or rotating the passphrase requires a
> **local wipe + fresh re-sync** (ideally a fresh remote database) so old and new documents don't
> mix. Keep the passphrase identical across devices.

## Configuration

1. Set **Server URL** (use `https://`), **Database name**, **Username**, **Password** → *Test*.
2. Keep **encryption on** and set a **Passphrase** (the same on every device).
3. Choose a **conflict strategy**. For *master device wins*, enable *This device is the master* on
   exactly one device (e.g. your desktop).
4. Make sure the master switch in the status card says **Sync on** — it starts syncing right away
   and on every launch. Press **Force sync** any time to re-trigger a full pass.

### CouchDB server (one-time)

```ini
[chttpd]
enable_cors = true
require_valid_user = true
max_http_request_size = 4294967296
[cors]
origins = app://obsidian.md,capacitor://localhost
credentials = true
```

Set a low `_revs_limit` (e.g. 100) and schedule compaction to keep the DB small. The plugin routes
requests through Obsidian's native HTTP, so CORS issues are largely avoided regardless.

## Status & roadmap

**Done (validated on desktop):**

- ✅ Core PouchDB ↔ CouchDB live + one-shot sync, CORS-free via `requestUrl`.
- ✅ Per-file documents keyed by path + content-addressed chunks; streaming read/write (any size).
- ✅ End-to-end **content** encryption (AES-256-GCM) on by default (metadata/paths in clear — see
  [Security model](#security-model)).
- ✅ No-prompt conflict resolution (newest-wins / master-wins).
- ✅ Memory-safe pipeline: small-files-first, background indexing, bounded replication batches,
  range-bounded DB scans (no whole-DB loads).
- ✅ Index-status UX: in-place updates, %, drift lists, file tree, live per-file chunk progress,
  per-file Sync button, per-entry remove-from-index ✕ — works while running **and** idle.
- ✅ Robustness: crash guard / safe mode, auto-heal of missing chunks, quiet teardown, content-based
  binary/text detection, leftover temp-file cleanup.
- ✅ Optional hidden-file sync with exclude/include list (off by default).

**Next:**

- ⏭️ **Multi-device test** — sync between two desktops; verify conflict resolution and convergence.
- ⏭️ **Mobile test/hardening** — iOS/Android (IndexedDB limits, memory budget).
- ⏭️ Optional: orphaned-chunk cleanup command; document-history view.

## Development

```bash
npm install
npm run dev      # watch build -> main.js
npm run build    # type-check + production bundle
```

Copy `manifest.json`, `main.js`, `styles.css` into `<vault>/.obsidian/plugins/couchdb-sync/`.

## License

MIT
