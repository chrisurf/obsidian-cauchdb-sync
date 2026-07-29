# End-to-end tests

These drive the **built** plugin inside a **real Obsidian** instance using
[`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service)
(WebdriverIO v9 + Mocha). They cover the Obsidian-API-dependent surface that the
Vitest unit tests deliberately exclude (`main.ts`, `settings.ts`): plugin
lifecycle, command registration, the settings/index UI, live vault I/O, and a
real sync round-trip against CouchDB.

## Layout

```
wdio.conf.mts              WDIO config (Obsidian version matrix, service, reporter)
tsconfig.e2e.json          TS config for the specs (WDIO + Obsidian types)
e2e/
  specs/
    helpers.ts             executeObsidian wrappers (plugin/app introspection)
    plugin-load.e2e.ts     loads, enables, registers commands + status bar        (no server)
    settings-ui.e2e.ts     settings tab renders; index gated until verified        (no server)
    commands.e2e.ts        commands run safely unconfigured                        (no server)
    vault-lifecycle.e2e.ts create/modify/delete files; plugin survives churn       (no server)
    sync-roundtrip.e2e.ts  real upload to CouchDB + metadata-privacy check         (needs CouchDB)
  vaults/
    simple/                the committed starting vault (reset per test)
```

## Run it

The service downloads Obsidian binaries on first run (cached in `.obsidian-cache/`).

```bash
# Build the plugin, then run everything except the gated sync spec:
npm run test:e2e

# Only one Obsidian version, faster iteration:
OBSIDIAN_VERSIONS="latest/latest" npm run test:e2e:only   # assumes an existing build
```

### Including the real CouchDB sync round-trip

The `sync-roundtrip` spec is skipped unless `COUCHDB_URL` is set. Spin up a
throwaway CouchDB and point the spec at it:

```bash
docker compose -f docker-compose.couchdb.yml up -d
COUCHDB_URL=http://127.0.0.1:5984 COUCHDB_USER=admin COUCHDB_PASS=password npm run test:e2e
docker compose -f docker-compose.couchdb.yml down -v
```

That spec uploads a vault file to CouchDB and then inspects the server-side
documents directly, asserting both the round-trip **and** this branch's
metadata-privacy guarantee (no plaintext path/content on the server; docs are in
encrypted envelope form).

## Linux / CI

Obsidian is an Electron app, so headless Linux needs a virtual display **and** a
window manager (a bare `Xvfb` leaves some features broken). See
`.github/workflows/e2e.yml` — it sets up `Xvfb` + `herbstluftwm`, caches the
Obsidian binaries, and runs a CouchDB service container so the sync spec runs in
CI too.

## Notes

- `browser.executeObsidian(({ app, obsidian }) => …, ...args)` runs in Obsidian's
  renderer. The callback is serialized, so it can't close over outer variables —
  pass them as args — and must use the injected `obsidian` param, not a top-level
  `import`.
- Reset vault state per test with `obsidianPage.resetVault(...)` (fast, in-place).
  Use `browser.reloadObsidian(...)` only for a full reboot.
- The version matrix `earliest/earliest latest/latest` tests the minimum API we
  promise (`manifest.minAppVersion`) and the newest Obsidian. `appVersion` is the
  JS bundle; `installerVersion` is the Electron/Chromium base — independent axes.
