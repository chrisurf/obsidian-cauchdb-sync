# Sync correctness & privacy review

Critical review of `main` (`13b986e`) after the metadata-E2EE merge. Bugs were
found by tracing the code (engine, database, envelope, main, settings) and, where
noted, verified against the exact lines. Ordered by severity. Each entry has a
concrete failure scenario and the intended fix.

Legend: **DATA LOSS** > **PRIVACY** > **CORRECTNESS** > **MINOR**.

---

## B1 — DATA LOSS: "Resolve drift (use newest)" uploads local, discarding a newer remote

`engine.ts:918` (`forceSync`), wired at `settings.ts:696-703` and `:681`.

`forceSync` re-uploads the local file whenever it exists on disk — it never
compares mtimes. But the drift section's bulk button and the per-row drift button
are labelled with the strategy (`Resolve all (use newest)`) and call
`forceSyncPath` → `forceSync`. The mtime-aware `useNewestPath` is only wired to a
single context-menu item.

**Scenario:** Device B edits `note.md` (newer), pushes it; the doc replicates into
A's DB but A can't materialize it yet (chunk not arrived, or A has its own edit),
so A shows *drift*. A clicks "Resolve all (use newest)". `forceSync` uploads A's
**older** local content over B's newer version. B's edit is lost (recoverable only
via history).

**Fix:** the drift/conflict resolution buttons must resolve by the configured
strategy (`useNewestPath` for `newest`, master-aware otherwise), not force-upload
local. Keep `forceSync`/"Sync now" as the explicit push-local action.

## B2 — DATA LOSS (race): pulled change overwrites an unsynced local edit

`engine.ts:851-872` (`applyRemoteChange`).

The only guard before `vault.modify`/`writeBinary` is
`if (this.lastHash.get(path) === doc.hash) return;`. `lastHash` is what *this
engine last wrote/synced* — it is never compared against the file's actual current
on-disk content. Within the 400 ms `onModify` debounce window (or after a
skipped/failed push) an incoming pull writes the remote body straight over a fresh
local edit, records no version, raises no conflict.

**Scenario:** Live sync on. User types into `note.md` (modify debounced 400 ms). A
pull delivers B's edit of the same file. `applyRemoteChange` overwrites the file
and `recordSynced`s the new stat. The debounced local handler then sees
`isUnchanged` → true and returns. The user's keystrokes are gone, not in history,
no conflict.

**Fix:** before overwriting an existing file whose on-disk content differs from
`lastHash`, capture the current on-disk content to history first (recoverable), so
a concurrent local edit is never silently destroyed.

## B3 — PRIVACY / DATA MIXING: no origin-fingerprint guard before replication

`main.ts:320` (`doRestart`) → `engine.start()` / `startLiveSync`.

`doRestart` checks only `serverUrl`, `username`, and passphrase presence before
starting a **bidirectional** sync. The origin fingerprint (which detects that the
local cache belongs to a *different* remote) is consulted only by the idle index
view, never on the replication path. `markCleanState` then re-stamps the
fingerprint to the new remote, erasing the evidence.

**Scenario:** User syncs vault A to remote A, later repoints settings at remote B.
`invalidateConnection` clears `connectionVerified` but leaves the full replica. On
the next sync — automatic at launch if `autoStart` — every one of vault A's docs is
pushed into remote B, then the fingerprint is re-stamped to B.

**Fix:** in `doRestart`, before starting sync, compare the stored origin
fingerprint against the configured remote; on mismatch refuse to sync and direct
the user to wipe or adopt (the recovery actions already exist).

## B4 — PRIVACY LEAK: master-info doc replicates the device id in cleartext

`engine.ts:1362` (`publishMasterInfoIfNeeded`).

`putLocalDoc("couchdb-sync:masterinfo", { type:"masterinfo", masterId:<deviceId> })`
— the id is **not** `_local/`-prefixed, so it is a normal replicating document, and
`putLocalDoc` performs no encryption. With `isMaster` on, a cleartext
`{type:"masterinfo", masterId:<deviceId>}` reaches CouchDB even under E2EE,
contradicting envelope.ts's "the server never sees … device ids".

**Fix:** encrypt the master-info body under the passphrase when E2EE is active
(mirroring the envelope `meta` blob); decrypt in `getMasterId`.

## B5 — LIVELOCK: conflict resolution never converges between two live devices

`engine.ts:1320-1334` (`resolveConflicts`), `util.ts` (`pickConflictWinner`).

`resolveConflicts` unconditionally writes a fresh revision of the winner even when
the current head already *is* the winner content. Two online devices each resolve
the same conflict, minting two new children of the base rev → a new conflict with
identical content, re-triggered by `resolveSoon()` on every pull → perpetual churn
and unbounded revision growth. `pickConflictWinner` also has no deterministic
tie-break on equal mtimes, so two devices can even pick *different* winners.

**Fix:** (a) if the current head already equals the winner content, only drop the
losing leaves — do not re-`put`; (b) give `pickConflictWinner` a deterministic
tie-break (hash, then deviceId) so all devices agree.

## B6 — SILENT FAILURE: a file the heal loop gives up on is stuck forever

`engine.ts:882-894`. After `HEAL_MAX_ATTEMPTS` the doc is re-parked in `pending`
and `healAttempts` is never reset, so every subsequent pull re-parks it. A file
whose chunks exist on no reachable device stays drift/conflict indefinitely with
only a `console.warn` — no ERROR status, no notice.

**Fix:** after the cap, stop re-parking; surface a one-time ERROR/notice and move
the path to a "stuck" set that is not retried on every pull.

## B7 — CORRECTNESS: wrong/empty passphrase misclassifies the whole index

`database.ts:142` (`getAll` swallows per-doc decrypt failures) + `main.ts:527`
(`getIndexReport` gates on `connectionVerified`, not passphrase validity). With a
wrong passphrase every file doc fails to decrypt, `getAll` returns `[]`, and every
local file is classified "local only". Clicking "Upload all" then re-encrypts under
the wrong passphrase → **divergent duplicate** docs (different HMAC id) instead of
reconciliation.

**Fix:** detect systemic decrypt failure and show a "passphrase mismatch" state
that blocks bulk upload, instead of "N local only".

## B8 — PRIVACY (accuracy): local cache holds plaintext paths despite UI claim

`engine.ts:1421` (`persistSyncState`) writes `_local/couchdb-sync-state:*` docs
whose bodies are `{ "<plaintext path>": {mtime,size,hash} }`. These never
replicate, but they sit in local IndexedDB as plaintext even under E2EE. The
settings copy states the cache "holds only encrypted data", which is false.

**Fix (minimum):** correct the misleading settings copy; the "forget cache on
disable" toggle already exists for users who need the local metadata gone.

## B9 — PRIVACY (residual): history id leaks an 8-char content-hash prefix

`engine.ts:958` builds the history id `H:<path>\n<ts>\n<hash[0:8]>`. In stored form
the path is HMAC'd but the timestamp and the 8-char content-hash prefix stay
cleartext. The README discloses the timestamp residual but not the hash prefix,
which partially exposes the file→chunk mapping for history versions (contradicting
the "the mapping is encrypted" claim for history docs).

**Fix:** either drop the hash from the stored history id (keep ts + a keyed
discriminator for uniqueness) or document it honestly. Deferred (id-format change
is storage-breaking) — documented for now.

## B10 — MINOR: change detection ignores content

`engine.ts:630` `isUnchanged` compares only mtime+size. An in-place edit that
preserves both (a tool restoring mtime) never re-syncs. Low probability; documented.

## B11 — MINOR: upgrade re-excludes hidden paths the user opted into

`migrate.ts:20` re-unions `DEFAULT_HIDDEN_EXCLUDE` into `hiddenExclude` on
migration, silently re-excluding e.g. `.obsidian/` for a user who deliberately
removed it. **Fix:** only seed defaults on first initialization, not on every
schema migration.

## B12 — MINOR: transient remote handle leak

`database.ts:100` `connectRemote` overwrites `this.remote` without closing the
prior handle. Idle history/conflict reads leak remote handles over a session.
**Fix:** reuse an existing open remote handle.

## B13 — SUSPECTED: differing passphrases across devices diverge silently

`engine.ts:710` guards only the *empty* passphrase. Two devices with different
non-empty passphrases write into disjoint id spaces and fail to decrypt each
other's docs (ERROR flap), with no "your passphrases differ" message.
**Fix (later):** a shared sentinel doc to detect a passphrase mismatch explicitly.

---

## Implementation plan

**Phase 1 — clear, low-risk, unit-testable**
- B4 encrypt master-info body (+ test: no plaintext deviceId in wire).
- B5 idempotent conflict resolution + deterministic `pickConflictWinner` tie-break
  (+ unit tests for the tie-break and the no-op-when-head-equals-winner path).
- B1 point the drift/conflict resolution buttons at strategy-aware resolution.
- B6 surface a stuck-heal error instead of infinite re-park.
- B8 correct the settings privacy copy.
- B12 reuse the remote handle.

**Phase 2 — higher value, careful**
- B3 origin-fingerprint guard in `doRestart` (refuse sync on mismatch).
- B2 capture on-disk content to history before an overwriting pull.
- B7 passphrase-mismatch index state gating bulk upload.
- B11 seed hidden-exclude defaults only on first init.

**Phase 3 — documented / deferred**
- B9 history-id hash-prefix (id-format change) — documented.
- B10 content-aware change detection (perf trade-off) — documented.
- B13 cross-device passphrase sentinel.

Each fix ships with a unit test where the layer is testable (util, envelope,
database via `pouchdb-adapter-memory`) and is exercised by the existing E2E suite
where it touches the live plugin.

---

## Status (this branch)

| Bug | Disposition |
|-----|-------------|
| B1 data-loss "use newest" | **Fixed** — drift/conflict buttons and rows call a strategy-aware `resolveByStrategy` (mtime-aware / master-wins); the plain force path stays only for the directional states. |
| B2 overwrite race | **Fixed** — `preserveUnsyncedLocalEdit` hashes the on-disk file before an overwriting pull and saves an un-synced local edit to history first (bounded to ≤8 MiB). |
| B3 cross-remote mixing | **Fixed** — `doRestart` blocks replication on an origin-fingerprint mismatch and points at Wipe / Adopt. |
| B4 masterinfo cleartext | **Fixed** — the master-info body is encrypted under the passphrase when E2EE is on; `getMasterId` decrypts. |
| B5 conflict livelock | **Fixed** — resolution no longer rewrites the head when it already equals the winner; `pickConflictWinner` has a deterministic tie-break. Unit-tested. |
| B6 stuck heal | **Fixed** — after the cap the path is marked `stuck` (not re-parked), surfaced once as an ERROR, and retried on a local edit / manual resolve / new remote rev. |
| B7 wrong-passphrase misclassification | **Fixed** — `getDecryptStats` detects systemic decrypt failure; the index shows a passphrase warning and hides the file lists (no tempting "Upload all"). Unit-tested. Also surfaces B13. |
| B8 misleading cache-privacy copy | **Fixed** — settings copy now states the local cache always keeps cleartext metadata. |
| B12 remote handle leak | **Fixed** — `connectRemote` closes the prior handle. |
| B9 history-id hash prefix | **Documented, no code change.** The tail hash is `cyrb53(child-id list)`, not a chunk id, so it does not directly reveal the file→chunk mapping; it is a version-content-equality (dedup) + timestamp correlation, both already disclosed as residuals in the README. Changing the id format is storage-breaking and not warranted. |
| B10 mtime+size change detection | **Documented, no change.** A content hash on every stat would defeat the fast-path; the failure mode (an in-place edit that preserves both size and mtime) is rare. |
| B11 migration re-excludes hidden paths | **By design, no change.** The re-union runs once (gated `priorVersion < 1`) and protects the majority from leaking `.git/`/`.obsidian/`; "fixing" it would re-open that risk. |
| B13 differing passphrases diverge silently | **Mitigated by B7** — a device that cannot decrypt the shared DB now shows an explicit passphrase-mismatch warning. A dedicated cross-device sentinel is left as a follow-up. |
