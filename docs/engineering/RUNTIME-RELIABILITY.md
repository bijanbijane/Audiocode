# Runtime Reliability — Session Locking, Crash-Safe Recovery Journal & Export Integrity

**Last Updated:** 2026-11-18  
**Authoritative Modules:**
- `src/runtime/CrashRecoveryAndSessionLock.ts`
- `src/runtime/ProjectLockAdapters.ts`
- `src/runtime/RecoveryCheckpointSchema.ts`
- `src/processing-core/ExportValidator.ts`
- `src/project-core/ProjectLifecycleAndMigrationEngine.ts`
- `src/project-core/BackupAndEnvironmentRestoreManager.ts`

---

## 1. Lock Ownership Semantics & Lifecycle

Project editing requires exclusive lock ownership before entering an editable state.

### Explicit Lock States
- `UNLOCKED` — Initial state prior to acquisition.
- `ACQUIRING` — Lock request is currently in flight.
- `LOCKED` — Exclusive lock confirmed by Web Locks or atomic IndexedDB lease.
- `CONTENDED` — Another active tab or session currently owns the project lock; caller enters safe read-only mode.
- `LOCK_UNAVAILABLE` — Neither Web Locks nor IndexedDB is available; system fails closed and refuses concurrent editing.
- `RELEASED` — Lock has been released cleanly (idempotent on repeated calls).
- `ERROR` — Underlying lock API threw or rejected (e.g., `SecurityError` in opaque origin, IndexedDB transaction failure).

### Session Identity
- Session IDs (`sess_<uuid-v4>`) are generated using `crypto.randomUUID()` with an RFC 4122 v4 fallback over `crypto.getRandomValues()`.
- Non-cryptographic randomness (`Math.random()`) is never used.
- The session identifier remains immutable for the lifetime of the `CrashRecoveryAndSessionLock` instance.

---

## 2. Browser Support & Dual-Strategy Fallback

1. **Primary Strategy — Browser Web Locks API (`navigator.locks`)**
   - Acquires an exclusive lock named `avapardaz_project_edit_lock_<encodedProjectKey>` with `{ ifAvailable: true, mode: 'exclusive' }`.
   - Same-tab reference counting allows multiple same-tab consumers to share a single browser Web Lock cleanly without dropping ownership until the final consumer releases.
   - Handles release-before-grant, synchronous throws, and rejected `navigator.locks.request()` promises deterministically with zero hung promises and zero leaked registry entries.
2. **Fallback Strategy — Atomic IndexedDB Lease (`avapardaz_runtime_locks_v1`)**
   - Used automatically when Web Locks is unavailable and IndexedDB is available.
   - Every acquire, renew, and release executes inside a single `readwrite` IndexedDB transaction (compare-and-set). `localStorage` read-then-write is never used for locking.
3. **Fail-Closed Guarantee**
   - If neither Web Locks nor IndexedDB is available (e.g., restricted/private iframe environments or Node without an injected lock store), `acquireProjectLock()` returns `{ acquired: false, state: 'LOCK_UNAVAILABLE', strategy: 'NONE' }` and `acquireExclusiveProjectLock()` returns `false`.
   - We explicitly do **not** claim durable cross-tab locking in environments where no reliable cross-tab lock mechanism exists.

---

## 3. Lease Expiration, Renewal & Monotonic Fencing

In IndexedDB lease mode, each lease record stores:
- `projectKey`, `projectId`, `ownerSessionId`
- `acquiredAtMs`, `renewedAtMs`, `expiresAtMs` (default TTL: `30,000 ms`, default renewal cadence: `10,000 ms`)
- `fencingToken` — strictly monotonic integer incremented whenever a new owner acquires or reclaims a lease.

Protections enforced atomically inside IndexedDB transactions:
- **Expired Lease Reclamation:** A new session can reclaim a lease only when `existing.expiresAtMs <= nowMs`, receiving `fencingToken = previous + 1`.
- **Ownership Verification on Renewal & Release:** Renewal and release check both `ownerSessionId` and `expectedFencingToken`. A stale owner with an older fencing token cannot renew or delete a newer owner's lease.
- **Lock-Loss Enforcement:** Failed renewal or ownership verification transitions the session out of `LOCKED`, invokes registered `onLockLost` listeners, switches the UI/orchestrator into read-only mode, and blocks further timeline mutations and checkpoint writes.

---

## 4. Recovery Envelope Format (`envelopeVersion: 2`)

Every checkpoint is persisted as a self-describing, versioned envelope (`RecoveryCheckpointEnvelope`):

```json
{
  "envelopeVersion": 2,
  "projectId": "proj-example-1",
  "sessionId": "sess_<uuid-v4>",
  "checkpointId": "chk_<uuid-v4>",
  "sequenceNumber": 3,
  "createdAtMs": 1700000000000,
  "shutdownState": "DIRTY_ACTIVE",
  "projectSchemaVersion": 2,
  "runtimeCompatibility": {
    "audioEngineMajor": "1",
    "processingNodeCatalogVersion": "1.2",
    "minSupportedEnvelopeVersion": 2
  },
  "fencingToken": 1,
  "requiredAssetIdentities": [],
  "snapshot": { "...canonical ProjectDocument..." },
  "integrity": {
    "algorithm": "SHA-256",
    "canonicalization": "SORTED_KEYS_JSON_V1",
    "digestHex": "<64-char-hex>"
  }
}
```

### Namespace & Storage-Key Hardening
- `projectId` is validated before lock or storage access: rejects empty/whitespace strings, control characters, path separators (`/` and `\`), traversal sequences (`.` / `..`), and IDs longer than `128` characters.
- Storage filenames use an injective UTF-8 hex key (`prj_<hex>`), guaranteeing two distinct project IDs never collide and no ID can escape the `recovery-journal/` directory.

### Memory & Privacy Guardrails
- Checkpoints carry canonical project state and asset hash references only — **never** raw PCM audio buffers, API keys, access tokens, or provider secrets (enforced by `detectForbiddenCheckpointContent`).
- Default checkpoint envelope size cap is `4 MiB` (strictly within the `32 MiB` audio cache and `1 GiB` hard memory budget).

---

## 5. Integrity Verification & Interruption-Safe Persistence

- **Hashing vs. Encryption:** `integrity.digestHex` is a Web Crypto `SHA-256` digest over deterministic sorted-key canonical JSON (`SORTED_KEYS_JSON_V1`). This provides tamper and corruption detection; it does **not** encrypt data at rest.
- **Per-Project Serialized Writes & Monotonic Sequencing:** Concurrent checkpoint writes for the same project are queued sequentially and enforce strictly increasing `sequenceNumber` so an older write cannot overwrite a newer checkpoint.
- **OPFS Two-Phase Write (`OpfsRecoveryJournalStore`):**
  1. Stages payload to `${projectKey}.tmp.${checkpointId}.json`.
  2. Reads back and verifies byte/digest integrity before touching `${projectKey}.current.json`.
  3. Rotates the prior valid checkpoint to a single bounded backup slot (`${projectKey}.prev.json`).
  4. Writes verified payload to `${projectKey}.current.json` and deletes the temporary file.
  - Interrupted or quota-failed writes leave the previous `.current.json` intact.
  - `cleanupMaintenance(projectId)` deletes orphaned `.tmp.*.json` files without touching `.current.json` or `.prev.json`.
- **IndexedDB Transactional Fallback (`IndexedDbRecoveryJournalStore`):** Stores bounded `{ current, previous }` slots in a single `readwrite` transaction; aborts roll back atomically.
- **Clean vs. Dirty Shutdown Semantics:** Editing persists `DIRTY_ACTIVE` checkpoints. Clean shutdown persists a monotonically newer `CLEAN_SHUTDOWN` checkpoint (preserving the latest valid snapshot) and releases the lock **only after** persistence finishes. If clean shutdown fails, the previous `DIRTY_ACTIVE` checkpoint remains recoverable.

---

## 6. Storage Degradation Behavior

Explicit recovery inspection statuses:
- `NO_RECOVERY_AVAILABLE` — No checkpoint exists, or the latest verified checkpoint recorded `CLEAN_SHUTDOWN`.
- `RECOVERY_AVAILABLE` — Verified, schema-valid `DIRTY_ACTIVE` checkpoint ready for conflict-checked restoration.
- `RECOVERY_CORRUPTED` — Truncated/invalid JSON, structural envelope corruption, or SHA-256 digest mismatch (preserved diagnosably; never silently discarded).
- `RECOVERY_INCOMPATIBLE` — Unsupported envelope version, newer engine major version, or unsupported future project schema version.
- `RECOVERY_VALIDATION_FAILED` — Project ID mismatch, schema validation error, forbidden secret/binary payload, oversized payload, or migration failure.
- `RECOVERY_STORAGE_UNAVAILABLE` — Neither OPFS nor IndexedDB is available or permission was denied.

When durable storage is unavailable, writes return `{ persisted: false, status: 'DEGRADED_STORAGE_UNAVAILABLE' }` and the application visibly warns the user that crash recovery is degraded. Volatile memory is never silently substituted as durable persistence.

---

## 7. Recovery Compatibility, Migration & Conflict Handling

Before restoring any snapshot (`planCrashRecovery` / `executeSafeCrashRecovery`):
1. Verifies exclusive lock ownership and blocks restoration if another session owns the project (`LOCK_CONTENDED`).
2. Verifies SHA-256 digest and runs deep runtime schema validation (`validateProjectDocumentSchema`) — zero unchecked `JSON.parse` casts and zero silent repair of malformed data.
3. Rejects unsupported future schema versions (`projectSchemaVersion > CURRENT_SCHEMA_VERSION`) and applies `ProjectLifecycleAndMigrationEngine.migrateProjectSafely()` for supported legacy versions (e.g., `v1 -> v2`), re-validating post-migration output.
4. Detects stale checkpoints (`recovered.revision < currentSavedProject.revision` -> `CONFLICT_STALE_CHECKPOINT`) and newer-checkpoint races (`CONFLICT_NEWER_CHECKPOINT_EXISTS`), requiring explicit user conflict resolution (`FORCE_RESTORE_STALE`) before overwriting a newer saved revision.
5. Verifies referenced media asset identities (`verifyRecoveredMediaReferences`), explicitly distinguishing `missingAssetIds`, `contentChangedAssetIds`, and `unverifiedAssetIds` without modifying original audio files.
6. Any validation or migration failure leaves the original project untouched (`originalProjectPreserved: true`).

---

## 8. Export PCM Integrity Validation (`ExportValidator`)

`ExportValidator.validateRenderedPcm()` enforces fail-safe structural and numerical checks prior to WAV export without mutating input PCM:
- Validates channel array structure, non-empty `Float32Array` channels, identical frame counts across all channels, finite strictly positive `sampleRate`, and finite non-negative `expectedDurationSeconds`.
- Scans all samples in O(1) extra memory (no buffer cloning or `Math.max(...spread)`), counting `NaN`/`±Infinity` separately (`invalidSamplesCount`) from clipping (`clippedSamplesCount >= 0.9999`), computing peak dB strictly over finite samples, and checking duration tolerance (`0.002 s`) and boundary click risk (`> 0.05`).

---

## 9. Known Browser Limitations

- **Private / Incognito or Opaque Origins:** Some browsers disable OPFS, IndexedDB, or `navigator.locks` inside opaque iframes or strict private browsing modes. In those environments Avapardaz fails closed (`LOCK_UNAVAILABLE` / `RECOVERY_STORAGE_UNAVAILABLE`) and operates in read-only or visibly degraded mode.
- **Process-Kill During `pagehide`:** Browsers may terminate asynchronous OPFS/IndexedDB clean-shutdown writes initiated inside `pagehide`. Because dirty checkpoints are persisted during editing and clean-shutdown writes are atomic, an interrupted clean shutdown safely leaves the last verified `DIRTY_ACTIVE` checkpoint recoverable on next open.
- **IndexedDB Lease Clock Skew:** IndexedDB fallback leases rely on the local device clock (`Date.now()`). Significant backward or forward manual system-clock jumps during an active fallback session can prematurely expire or delay reclamation of a lease until the next renewal check.
