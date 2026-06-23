# CouchDB Sync for Obsidian

Simple, reliable, **end-to-end encrypted** live synchronization of your Obsidian vault against a
self-hosted **CouchDB** server. A deliberately minimal alternative to the (excellent but very
complex) [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) — CouchDB only, almost no
settings, and **no pop-ups**.

> Status: early MVP (Phase 0 + 1). See [`REPORT.md`](./REPORT.md) for the full analysis and roadmap.

## Why

LiveSync is powerful but supports many backends (S3/MinIO, P2P/WebRTC), config/plugin sync, multiple
encryption and chunking generations, and requires **byte-identical settings across all devices**.
That power is the source of its most common complaints: settings complexity, mobile crashes, the
dreaded "rebuild database", and endless confirmation pop-ups.

This plugin does **one** thing well: live note sync over **one** CouchDB.

## Features (MVP)

- 🔄 **Live two-way sync** via PouchDB ↔ CouchDB continuous replication.
- 🧩 **Chunked storage** — files of any size (images, PDFs, audio, video) are split into 1 MiB
  content-addressed chunks, so large files sync reliably and unchanged chunks are reused.
- 🔐 **End-to-end encryption on by default** — AES-256-GCM (at rest), TLS (in transit). Only the
  passphrase must match across devices; it never touches the server.
- ⚖️ **No-prompt conflict resolution**: *newest version wins* or *master device wins*.
- 📊 **Index status view** — see at a glance whether this device and the database match (green),
  inspect drift, and browse the indexed file tree.
- 🧭 **~5 settings**, sensible defaults, no per-device tuning.
- 📵 **CORS-free** networking via Obsidian's `requestUrl` (works on mobile).

## Configuration

1. Set **Server URL** (use `https://`), **Database name**, **Username**, **Password** → *Test*.
2. Keep **encryption on** and set a **Passphrase** (the same on every device).
3. Choose a **conflict strategy**. For *master device wins*, enable *This device is the master* on
   exactly one device (e.g. your desktop).
4. *Restart sync*.

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

## Development

```bash
npm install
npm run dev      # watch build -> main.js
npm run build    # type-check + production bundle
```

Copy `manifest.json`, `main.js`, `styles.css` into `<vault>/.obsidian/plugins/couchdb-sync/`.

## License

MIT
