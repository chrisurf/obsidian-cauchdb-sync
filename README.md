# CouchDB Sync for Obsidian

Simple, reliable, **end-to-end encrypted** live synchronization of your Obsidian vault against a
self-hosted **CouchDB** server. A deliberately minimal alternative to the (excellent but very
complex) [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) — CouchDB only, a handful
of settings, and **no pop-ups**.

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

- 🔄 **Live two-way sync** via PouchDB ↔ CouchDB continuous replication (or one-shot "Sync now").
- 🧩 **Chunked, streaming storage** — files of any size (images, PDFs, audio, video) are split into
  1 MiB content-addressed chunks. Reads and writes stream to/from disk, so a 600 MB file never sits
  in memory; unchanged chunks are reused.
- 🔐 **End-to-end encryption on by default** — AES-256-GCM at rest (PBKDF2-derived key), TLS in
  transit. Only the passphrase must match across devices; it never touches the server.
- ⚖️ **No-prompt conflict resolution**: *newest version wins* or *master device wins*.
- 📊 **Full-transparency index status** — at a glance: how many of your files are in sync (`X / Y`,
  with %), and a collapsible **Sync state** tree of every file across this device *and* the server,
  **colour-coded** into five distinct states so you can tell exactly what each file needs:
  🟢 green = in sync, 🟠 amber = local only (not uploaded yet), ⚪ grey = remote only (not downloaded
  here), 🟣 purple = content differs (auto-reconcilable drift), 🔴 red = unresolved conflict.
  Folders roll up to the most urgent state inside them (green only when the whole subtree is clean),
  and the summary/lists/tree all derive from one classification so they never disagree. Updates
  **in place** every few seconds — no flicker.
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
- 🛟 **Safe by design** — no destructive "rebuild" ritual; a **crash guard** disables auto-start
  after an unclean shutdown so you can never get stuck in a crash loop; **Wipe local cache** only
  touches this device.
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
- **Controls map to plain verbs.** *Sync now* (both ways), *Download only* (pull, for followers),
  *Stop*, *Wipe local cache*. Toggles take effect immediately and stay consistent (e.g. *Stop* also
  switches off live sync and auto-start so nothing fights it).
- **Memory- and mobile-safe pipeline.** Small files first; large files stream and trickle in the
  background; replication batches are bounded — so the app stays responsive and never OOMs.
- **Crash-safe, not crash-prone.** Errors disable auto-start rather than retrying a failing
  operation forever. Recovery is always reachable.
- **Single clean version.** No migration/back-compat cruft while in active development.

## Configuration

1. Set **Server URL** (use `https://`), **Database name**, **Username**, **Password** → *Test*.
2. Keep **encryption on** and set a **Passphrase** (the same on every device).
3. Choose a **conflict strategy**. For *master device wins*, enable *This device is the master* on
   exactly one device (e.g. your desktop).
4. Press **Sync now** (or turn on **Live sync**).

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
- ✅ End-to-end encryption (AES-256-GCM) on by default.
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
