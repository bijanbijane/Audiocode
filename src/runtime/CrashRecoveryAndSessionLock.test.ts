import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerifiedCheckpointEnvelope,
  CrashRecoveryAndSessionLock,
  encodeProjectStorageKey,
  generateSecureSessionId,
  InMemoryAtomicLeaseStore,
  OpfsRecoveryDirectoryLike,
  OpfsRecoveryFileHandleLike,
  OpfsRecoveryJournalStore,
  OpfsRecoveryWritableLike,
  RecoveryJournalStore,
  validateProjectId,
  WebLocksApiLike,
  WebLocksCoordinator,
} from './CrashRecoveryAndSessionLock';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';
import { AssetIdentityRecord } from '../project-core/ProjectLifecycleAndMigrationEngine';
import { VerticalSliceOrchestrator } from '../core/VerticalSliceOrchestrator';

function makeMockProject(overrides?: Partial<ProjectDocument>): ProjectDocument {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  return {
    projectId: 'proj-recovery-1',
    name: 'پادکست آزمایشی',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: 'fa-asr-bundle-1.2',
    },
    revision: 7,
    tracks: [
      {
        id: 't1',
        name: 'میزبان',
        syncGroupId: null,
        speakerId: 'spk-host',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId: 'asset-voice-1',
            sourceRange: { start: 0, end: s(5) },
            timelineRange: { start: 0, end: s(5) },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [],
    ...overrides,
  };
}

function makeAsset(id: string, hash: string, size = 1024): AssetIdentityRecord {
  return {
    assetId: id,
    contentVersion: 1,
    fullContentSha256: hash,
    partialFingerprintSha256: `part_${hash}`,
    fileSize: size,
    sampleRate: 48000,
    channelCount: 1,
    sampleCount: 48000,
    originalFileName: `${id}.wav`,
  };
}

/**
 * Deterministic in-memory OPFS mock with configurable failure injection (quota, crash mid-write, etc.)
 */
class FakeOpfsDirectory implements OpfsRecoveryDirectoryLike {
  public readonly files = new Map<string, string>();
  public readonly subdirs = new Map<string, FakeOpfsDirectory>();
  public failOnFilenameMatch: {
    pattern: RegExp;
    error: Error;
    once?: boolean;
  } | null = null;

  public async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsRecoveryDirectoryLike> {
    let sub = this.subdirs.get(name);
    if (!sub) {
      if (!options?.create) {
        const err = new Error('NotFoundError');
        err.name = 'NotFoundError';
        throw err;
      }
      sub = new FakeOpfsDirectory();
      this.subdirs.set(name, sub);
    }
    const root = this;
    return {
      getDirectoryHandle: (n, o) => sub!.getDirectoryHandle(n, o),
      removeEntry: (n) => sub!.removeEntry(n),
      entries: () => sub!.entries(),
      async getFileHandle(fileName, fileOpts) {
        sub!.failOnFilenameMatch = root.failOnFilenameMatch;
        const handle = await sub!.getFileHandle(fileName, fileOpts);
        return {
          async createWritable() {
            const w = await handle.createWritable();
            return {
              async write(data: string) {
                try {
                  await w.write(data);
                } finally {
                  if (sub!.failOnFilenameMatch === null) {
                    root.failOnFilenameMatch = null;
                  }
                }
              },
              close: () => w.close(),
              abort: () => (w.abort ? w.abort() : Promise.resolve()),
            };
          },
          getFile: () => handle.getFile(),
        };
      },
    };
  }

  public async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsRecoveryFileHandleLike> {
    if (!this.files.has(name) && !options?.create) {
      const err = new Error('NotFoundError');
      err.name = 'NotFoundError';
      throw err;
    }
    const dir = this;
    return {
      async createWritable(): Promise<OpfsRecoveryWritableLike> {
        let staged = '';
        return {
          async write(data: string) {
            if (dir.failOnFilenameMatch && dir.failOnFilenameMatch.pattern.test(name)) {
              const err = dir.failOnFilenameMatch.error;
              if (dir.failOnFilenameMatch.once) {
                dir.failOnFilenameMatch = null;
              }
              throw err;
            }
            staged = data;
          },
          async close() {
            dir.files.set(name, staged);
          },
          async abort() {
            staged = '';
          },
        };
      },
      async getFile() {
        const content = dir.files.get(name);
        if (content === undefined) {
          const err = new Error('NotFoundError');
          err.name = 'NotFoundError';
          throw err;
        }
        return {
          async text() {
            return content;
          },
        };
      },
    };
  }

  public async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
    this.subdirs.delete(name);
  }

  public async *entries(): AsyncIterable<[string, { kind: 'file' | 'directory'; name: string }]> {
    for (const key of this.files.keys()) {
      yield [key, { kind: 'file', name: key }];
    }
    for (const key of this.subdirs.keys()) {
      yield [key, { kind: 'directory', name: key }];
    }
  }
}

/**
 * Deterministic controlled Web Locks mock supporting deferred grants, cross-tab exclusivity,
 * and request rejections without real sleeps.
 */
class ControlledWebLocksMock implements WebLocksApiLike {
  private readonly held = new Set<string>();
  public rejectNextWith: Error | null = null;
  public throwSyncNextWith: Error | null = null;
  public deferNextGrant = false;
  public pendingDeferredGrants: Array<() => void> = [];

  public request(
    name: string,
    options: { ifAvailable?: boolean; mode?: 'exclusive' | 'shared' },
    callback: (lock: { name: string } | null) => Promise<void> | void,
  ): Promise<unknown> {
    if (this.throwSyncNextWith) {
      const err = this.throwSyncNextWith;
      this.throwSyncNextWith = null;
      throw err;
    }
    if (this.rejectNextWith) {
      const err = this.rejectNextWith;
      this.rejectNextWith = null;
      return Promise.reject(err);
    }

    const executeGrant = async () => {
      if (this.held.has(name)) {
        if (options.ifAvailable) {
          await callback(null);
          return;
        }
      }
      this.held.add(name);
      try {
        await callback({ name });
      } finally {
        this.held.delete(name);
      }
    };

    if (this.deferNextGrant) {
      this.deferNextGrant = false;
      return new Promise<void>((resolve, reject) => {
        this.pendingDeferredGrants.push(() => {
          executeGrant().then(resolve, reject);
        });
      });
    }

    return executeGrant();
  }

  public isHeld(name: string): boolean {
    return this.held.has(name);
  }

  public heldCount(): number {
    return this.held.size;
  }
}

function makeSimpleDurableStore(backing = new Map<string, string>()): RecoveryJournalStore {
  return {
    isDurable: true,
    backendName: 'TEST_STORE',
    async write(id, json) {
      backing.set(id, json);
    },
    async read(id) {
      return backing.get(id) ?? null;
    },
  };
}

// ─── 1. SESSION IDENTITY & PROJECT ID HARDENING ─────────────────────────────

test('Session identity uses collision-resistant cryptographic UUIDs and remains stable', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const id = generateSecureSessionId('sess');
    assert.match(id, /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
  const mgr = new CrashRecoveryAndSessionLock({ disableDefaultLockBackends: true, disableDefaultJournalBackends: true });
  const first = mgr.getSessionId();
  assert.equal(mgr.getSessionId(), first);
});

test('Project ID validation rejects unsafe paths/control chars and storage-key encoding is injective', () => {
  const invalidIds = [
    '',
    '   ',
    '../escape',
    'a/b',
    'a\\b',
    '..',
    '.',
    '.hidden',
    'trailing.',
    'has\u0000null',
    'has\nnewline',
    'x'.repeat(129),
  ];
  for (const bad of invalidIds) {
    assert.equal(validateProjectId(bad).valid, false, `Expected '${bad}' to be rejected`);
  }

  // Distinct project IDs with punctuation must never collide
  const keyA = encodeProjectStorageKey('proj-a_b');
  const keyB = encodeProjectStorageKey('proj_a-b');
  const keyC = encodeProjectStorageKey('پروژه-۱');
  assert.notEqual(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.match(keyA, /^prj_[a-f0-9]+$/);
  assert.match(keyC, /^prj_[a-f0-9]+$/);
});

// ─── 2. WEB LOCKS & INDEXEDDB FALLBACK LOCKING ──────────────────────────────

test('Web Locks: independent tabs compete, different projects succeed, same-tab ref-counting & idempotency work', async () => {
  const mockLocks = new ControlledWebLocksMock();
  // Two separate tabs have independent WebLocksCoordinators backed by the same browser lock manager
  const tab1Coord = new WebLocksCoordinator(mockLocks);
  const tab2Coord = new WebLocksCoordinator(mockLocks);

  const tab1SessionA = new CrashRecoveryAndSessionLock({
    webLocksCoordinator: tab1Coord,
    leaseStore: null,
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
  });
  const tab1SessionB = new CrashRecoveryAndSessionLock({
    webLocksCoordinator: tab1Coord,
    leaseStore: null,
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
  });
  const tab2Session = new CrashRecoveryAndSessionLock({
    webLocksCoordinator: tab2Coord,
    leaseStore: null,
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
  });

  // Tab 1 acquires proj-A
  const res1 = await tab1SessionA.acquireProjectLock('proj-A');
  assert.equal(res1.acquired, true);
  assert.equal(res1.state, 'LOCKED');
  assert.equal(res1.strategy, 'WEB_LOCKS');
  assert.ok((res1.fencingToken ?? 0) >= 1);

  // Repeated acquire on same session is idempotent
  const res1Again = await tab1SessionA.acquireProjectLock('proj-A');
  assert.equal(res1Again.acquired, true);
  assert.equal(res1Again.reasonCode, 'LOCK_REENTRANT_SAME_SESSION');

  // Tab 2 competing for proj-A is CONTENDED
  const res2 = await tab2Session.acquireProjectLock('proj-A');
  assert.equal(res2.acquired, false);
  assert.equal(res2.state, 'CONTENDED');
  assert.equal(tab2Session.getHeldProjectId(), null);

  // Tab 2 editing a different project proj-B succeeds concurrently
  const res2B = await tab2Session.acquireProjectLock('proj-B');
  assert.equal(res2B.acquired, true);
  assert.equal(res2B.state, 'LOCKED');

  // Same-tab ref-counting: second consumer in Tab 1 joins proj-A
  const res1B = await tab1SessionB.acquireProjectLock('proj-A');
  assert.equal(res1B.acquired, true);
  assert.equal(tab1Coord.getSameTabHolderCount(encodeProjectStorageKey('proj-A')), 2);

  // First consumer releases -> Web Lock still held by second consumer in Tab 1
  await tab1SessionA.releaseProjectLockAsync();
  await tab1SessionA.releaseProjectLockAsync(); // Idempotent repeated release
  assert.equal(tab1Coord.getSameTabHolderCount(encodeProjectStorageKey('proj-A')), 1);
  assert.equal(mockLocks.heldCount(), 2);

  // Second consumer releases -> proj-A Web Lock fully released
  await tab1SessionB.releaseProjectLockAsync();
  assert.equal(tab1Coord.getActiveLockCount(), 0);
  await tab2Session.releaseProjectLockAsync();
  assert.equal(mockLocks.heldCount(), 0);
});

test('Web Locks: release before acquisition completes and request rejection never hang or leak registry entries', async () => {
  const mockLocks = new ControlledWebLocksMock();
  const coord = new WebLocksCoordinator(mockLocks);

  // 1. Release before deferred acquisition completes
  mockLocks.deferNextGrant = true;
  const sessionEarly = new CrashRecoveryAndSessionLock({
    webLocksCoordinator: coord,
    leaseStore: null,
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
  });

  const pendingAcquire = sessionEarly.acquireProjectLock('proj-early');
  assert.equal(sessionEarly.getLockState(), 'ACQUIRING');
  sessionEarly.releaseProjectLock();
  assert.equal(mockLocks.pendingDeferredGrants.length, 1);
  mockLocks.pendingDeferredGrants.shift()!();

  const earlyResult = await pendingAcquire;
  assert.equal(earlyResult.acquired, false);
  assert.equal(earlyResult.state, 'RELEASED');
  assert.equal(coord.getActiveLockCount(), 0);
  assert.equal(mockLocks.heldCount(), 0);

  // 2. Async rejection of navigator.locks.request()
  mockLocks.rejectNextWith = new Error('SecurityError: Locks blocked in opaque origin');
  const sessionReject = new CrashRecoveryAndSessionLock({
    webLocksCoordinator: coord,
    leaseStore: null,
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
  });
  const rejResult = await sessionReject.acquireProjectLock('proj-rej');
  assert.equal(rejResult.acquired, false);
  assert.equal(rejResult.state, 'ERROR');
  assert.equal(rejResult.reasonCode, 'LOCK_REQUEST_REJECTED');
  assert.equal(sessionReject.getHeldProjectId(), null);
  assert.equal(coord.getActiveLockCount(), 0);

  // 3. Synchronous throw of navigator.locks.request()
  mockLocks.throwSyncNextWith = new Error('DOMException: InvalidStateError');
  const syncRejResult = await sessionReject.acquireProjectLock('proj-rej');
  assert.equal(syncRejResult.acquired, false);
  assert.equal(syncRejResult.state, 'ERROR');
  assert.equal(coord.getActiveLockCount(), 0);
});

test('Fail-closed when neither Web Locks nor IndexedDB lease is available', async () => {
  const mgr = new CrashRecoveryAndSessionLock({
    webLocksCoordinator: null,
    leaseStore: null,
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
  });
  const res = await mgr.acquireProjectLock('proj-no-locks');
  assert.equal(res.acquired, false);
  assert.equal(res.state, 'LOCK_UNAVAILABLE');
  assert.equal(res.strategy, 'NONE');
  assert.equal(await mgr.acquireExclusiveProjectLock('proj-no-locks'), false);
});

test('IndexedDB atomic lease fallback: contention, renewal, expiration reclamation, fencing & stale owner release rejection', async () => {
  const leaseStore = new InMemoryAtomicLeaseStore();
  let fakeNow = 1_700_000_000_000;

  const s1 = new CrashRecoveryAndSessionLock({
    journalStore: makeSimpleDurableStore(),
    webLocksCoordinator: null,
    leaseStore,
    disableDefaultLockBackends: true,
    leaseTtlMs: 10_000,
    leaseRenewIntervalMs: 0,
    nowFn: () => fakeNow,
  });
  const s2 = new CrashRecoveryAndSessionLock({
    journalStore: makeSimpleDurableStore(),
    webLocksCoordinator: null,
    leaseStore,
    disableDefaultLockBackends: true,
    leaseTtlMs: 10_000,
    leaseRenewIntervalMs: 0,
    nowFn: () => fakeNow,
  });

  // Session 1 acquires lease with fencing token 1
  const acq1 = await s1.acquireProjectLock('proj-lease-1');
  assert.equal(acq1.acquired, true);
  assert.equal(acq1.strategy, 'INDEXEDDB_LEASE');
  assert.equal(acq1.fencingToken, 1);

  // Session 2 is contended while lease is active
  const acq2Blocked = await s2.acquireProjectLock('proj-lease-1');
  assert.equal(acq2Blocked.acquired, false);
  assert.equal(acq2Blocked.state, 'CONTENDED');

  // Session 1 renews lease successfully before expiration
  fakeNow += 6_000;
  const renew1 = await s1.renewProjectLock();
  assert.equal(renew1.renewed, true);
  assert.equal(renew1.leaseExpiresAtMs, fakeNow + 10_000);

  // Advance clock past expiration -> Session 2 reclaims expired lease with monotonic token 2
  fakeNow += 12_000;
  const acq2Reclaimed = await s2.acquireProjectLock('proj-lease-1');
  assert.equal(acq2Reclaimed.acquired, true);
  assert.equal(acq2Reclaimed.fencingToken, 2);

  // Session 1 (stale owner with token 1) triggers lock loss on renewal & CANNOT write checkpoint
  let lockLostTriggered = false;
  s1.onLockLost((ev) => {
    lockLostTriggered = true;
    assert.equal(ev.reasonCode, 'LOCK_LEASE_STOLEN');
    assert.equal(ev.previousFencingToken, 1);
  });
  const renewStale = await s1.renewProjectLock();
  assert.equal(renewStale.renewed, false);
  assert.equal(renewStale.state, 'CONTENDED');
  assert.equal(lockLostTriggered, true);

  // Stale owner release cannot delete Session 2's lease
  const staleRelease = await leaseStore.tryReleaseLease({
    projectKey: encodeProjectStorageKey('proj-lease-1'),
    ownerSessionId: s1.getSessionId(),
    expectedFencingToken: 1,
  });
  assert.equal(staleRelease.released, false);
  assert.equal(staleRelease.reason, 'NOT_OWNER');

  // Verify Session 2 still owns the lease intact
  assert.equal(await s2.verifyActiveLockOwnership('proj-lease-1'), true);

  // Expired lease cleanup removes only expired leases
  const s3 = new CrashRecoveryAndSessionLock({
    webLocksCoordinator: null,
    leaseStore,
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
    leaseTtlMs: 5_000,
    leaseRenewIntervalMs: 0,
    nowFn: () => fakeNow,
  });
  await s3.acquireProjectLock('proj-short-ttl');
  fakeNow += 6_000; // proj-short-ttl expired, proj-lease-1 still active (ttl 10_000)
  const maintenance = await s2.cleanupMaintenance();
  assert.equal(maintenance.expiredLeasesRemoved, 1);
  assert.equal(await s2.verifyActiveLockOwnership('proj-lease-1'), true);
});

// ─── 3. RECOVERY CHECKPOINT INTEGRITY, VALIDATION & ATOMIC PERSISTENCE ──────

test('Dirty checkpoint, clean shutdown semantics, and failed clean shutdown preserve recoverability', async () => {
  const backing = new Map<string, string>();
  let failNextWrite = false;
  const store: RecoveryJournalStore = {
    isDurable: true,
    async write(id, json) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('Simulated crash during clean shutdown');
      }
      backing.set(id, json);
    },
    async read(id) {
      return backing.get(id) ?? null;
    },
  };

  const sessionA = new CrashRecoveryAndSessionLock(store, {
    disableDefaultLockBackends: true,
  });
  const doc = makeMockProject({ revision: 7 });

  // 1. Write dirty checkpoint
  const dirtyWrite = await sessionA.persistRecoveryCheckpoint(doc, { shutdownState: 'DIRTY_ACTIVE' });
  assert.equal(dirtyWrite.persisted, true);
  assert.equal(dirtyWrite.envelope?.sequenceNumber, 1);
  assert.equal(dirtyWrite.envelope?.shutdownState, 'DIRTY_ACTIVE');

  // 2. Failed clean-shutdown write must leave previous dirty checkpoint recoverable!
  failNextWrite = true;
  const failedClean = await sessionA.persistRecoveryCheckpoint(doc, { shutdownState: 'CLEAN_SHUTDOWN' });
  assert.equal(failedClean.persisted, false);

  const sessionB = new CrashRecoveryAndSessionLock(store, { disableDefaultLockBackends: true });
  const stillDirty = await sessionB.inspectCrashRecovery(doc.projectId);
  assert.equal(stillDirty.status, 'RECOVERY_AVAILABLE');
  assert.equal(stillDirty.migratedSnapshot?.revision, 7);

  // 3. Successful clean shutdown clears crash recovery flag while keeping valid snapshot in envelope
  const cleanWrite = await sessionB.persistRecoveryCheckpoint(doc, { shutdownState: 'CLEAN_SHUTDOWN' });
  assert.equal(cleanWrite.persisted, true);
  assert.equal(cleanWrite.envelope?.sequenceNumber, 2);
  assert.equal(cleanWrite.envelope?.shutdownState, 'CLEAN_SHUTDOWN');

  const afterClean = await sessionB.inspectCrashRecovery(doc.projectId);
  assert.equal(afterClean.status, 'NO_RECOVERY_AVAILABLE');
  assert.equal(afterClean.envelope?.snapshot.revision, 7);
  assert.equal(await sessionB.checkCrashRecovery(doc.projectId), null);
});

test('Envelope verification rejects corrupted JSON, bad version, project mismatch, tampered digest, invalid schema, future schema, oversized payload & secrets', async () => {
  const backing = new Map<string, string>();
  const store = makeSimpleDurableStore(backing);
  const mgr = new CrashRecoveryAndSessionLock(store, {
    disableDefaultLockBackends: true,
    maxCheckpointBytes: 8_192,
  });
  const doc = makeMockProject();

  // 1. Corrupted JSON
  backing.set(doc.projectId, '{"envelopeVersion": 2, "broken');
  const corruptRes = await mgr.inspectCrashRecovery(doc.projectId);
  assert.equal(corruptRes.status, 'RECOVERY_CORRUPTED');
  assert.equal(corruptRes.errorCode, 'CORRUPT_JSON');

  // 2. Unsupported envelope version
  const validBuilt = await buildVerifiedCheckpointEnvelope({
    snapshot: doc,
    sessionId: mgr.getSessionId(),
    checkpointId: generateSecureSessionId('chk'),
    sequenceNumber: 1,
    createdAtMs: Date.now(),
    shutdownState: 'DIRTY_ACTIVE',
    fencingToken: null,
  });
  const badVer = { ...validBuilt.envelope, envelopeVersion: 99 };
  backing.set(doc.projectId, JSON.stringify(badVer));
  const verRes = await mgr.inspectCrashRecovery(doc.projectId);
  assert.equal(verRes.status, 'RECOVERY_INCOMPATIBLE');
  assert.equal(verRes.errorCode, 'UNSUPPORTED_ENVELOPE_VERSION');

  // 3. Project ID mismatch
  const otherProjBuilt = await buildVerifiedCheckpointEnvelope({
    snapshot: makeMockProject({ projectId: 'other-project-id' }),
    sessionId: mgr.getSessionId(),
    checkpointId: generateSecureSessionId('chk'),
    sequenceNumber: 1,
    createdAtMs: Date.now(),
    shutdownState: 'DIRTY_ACTIVE',
    fencingToken: null,
  });
  backing.set(doc.projectId, otherProjBuilt.serializedJson);
  const mismatchRes = await mgr.inspectCrashRecovery(doc.projectId);
  assert.equal(mismatchRes.status, 'RECOVERY_VALIDATION_FAILED');
  assert.equal(mismatchRes.errorCode, 'PROJECT_ID_MISMATCH');

  // 4. Invalid digest / Tampered snapshot
  const tampered = structuredClone(validBuilt.envelope);
  (tampered.snapshot as { name: string }).name = 'TAMPERED_NAME';
  backing.set(doc.projectId, JSON.stringify(tampered));
  const tamperedRes = await mgr.inspectCrashRecovery(doc.projectId);
  assert.equal(tamperedRes.status, 'RECOVERY_CORRUPTED');
  assert.equal(tamperedRes.errorCode, 'DIGEST_MISMATCH');

  // 5. Invalid project schema (even if re-signed with a matching digest!)
  const badDocEnvelopePayload = {
    ...validBuilt.envelope,
    snapshot: { ...doc, revision: -5, canonicalSampleRate: 12345 },
  };
  delete (badDocEnvelopePayload as Record<string, unknown>).integrity;
  // Re-sign manually using canonicalizeJsonValue + computeSha256Hex via dynamic helper check
  const { canonicalizeJsonValue, computeSha256Hex } = await import('./RecoveryCheckpointSchema');
  const badSchemaDigest = await computeSha256Hex(canonicalizeJsonValue(badDocEnvelopePayload));
  backing.set(
    doc.projectId,
    JSON.stringify({
      ...badDocEnvelopePayload,
      integrity: {
        algorithm: 'SHA-256',
        canonicalization: 'SORTED_KEYS_JSON_V1',
        digestHex: badSchemaDigest,
      },
    }),
  );
  const badSchemaRes = await mgr.inspectCrashRecovery(doc.projectId);
  assert.equal(badSchemaRes.status, 'RECOVERY_VALIDATION_FAILED');
  assert.equal(badSchemaRes.errorCode, 'INVALID_PROJECT_SCHEMA');

  // 6. Unsupported future project schema version (v99)
  const futureDoc = makeMockProject({
    versions: { ...doc.versions, projectSchemaVersion: 99 },
  });
  const futureBuilt = await buildVerifiedCheckpointEnvelope({
    snapshot: futureDoc,
    sessionId: mgr.getSessionId(),
    checkpointId: generateSecureSessionId('chk'),
    sequenceNumber: 1,
    createdAtMs: Date.now(),
    shutdownState: 'DIRTY_ACTIVE',
    fencingToken: null,
  });
  backing.set(doc.projectId, futureBuilt.serializedJson);
  const futureRes = await mgr.inspectCrashRecovery(doc.projectId);
  assert.equal(futureRes.status, 'RECOVERY_INCOMPATIBLE');
  assert.equal(futureRes.errorCode, 'UNSUPPORTED_PROJECT_SCHEMA');

  // 7. Oversized snapshot rejected on both write & read
  const hugeDoc = makeMockProject({
    tracks: Array.from({ length: 40 }, (_, i) => ({
      id: `t_${i}`,
      name: `Track_${i}_${'x'.repeat(120)}`,
      syncGroupId: null,
      speakerId: null,
      muted: false,
      solo: false,
      clips: [],
    })),
  });
  const oversizedWrite = await mgr.persistRecoveryCheckpoint(hugeDoc);
  assert.equal(oversizedWrite.persisted, false);
  assert.equal(oversizedWrite.errorCode, 'PAYLOAD_TOO_LARGE');

  // 8. Forbidden API credentials / raw audio fields rejected before write
  const leakyDoc = makeMockProject() as unknown as Record<string, unknown>;
  leakyDoc.apiKey = 'sk-secret-do-not-store';
  const secretWrite = await mgr.persistRecoveryCheckpoint(leakyDoc as unknown as ProjectDocument);
  assert.equal(secretWrite.persisted, false);
  assert.equal(secretWrite.errorCode, 'FORBIDDEN_SECRET_DATA');
});

test('OPFS atomic writes: interrupted write preserves previous checkpoint, quota fails cleanly, concurrent writes preserve newest seq, temp cleanup preserves valid checkpoints', async () => {
  const fakeRoot = new FakeOpfsDirectory();
  const opfsStore = new OpfsRecoveryJournalStore(async () => fakeRoot);
  const mgr = new CrashRecoveryAndSessionLock(opfsStore, { disableDefaultLockBackends: true });

  // 1. Write valid revision 1
  const w1 = await mgr.persistRecoveryCheckpoint(makeMockProject({ revision: 1 }));
  assert.equal(w1.persisted, true);
  assert.equal(w1.envelope?.sequenceNumber, 1);

  // 2. Inject QuotaExceededError during temp-file write -> previous revision 1 MUST survive intact
  const quotaErr = new Error('QuotaExceededError: disk full');
  quotaErr.name = 'QuotaExceededError';
  fakeRoot.failOnFilenameMatch = { pattern: /\.tmp\./, error: quotaErr, once: true };

  const w2Quota = await mgr.persistRecoveryCheckpoint(makeMockProject({ revision: 2 }));
  assert.equal(w2Quota.persisted, false);
  assert.equal(w2Quota.errorCode, 'STORAGE_QUOTA_EXCEEDED');

  const afterQuotaInspect = await mgr.inspectCrashRecovery('proj-recovery-1');
  assert.equal(afterQuotaInspect.status, 'RECOVERY_AVAILABLE');
  assert.equal(afterQuotaInspect.migratedSnapshot?.revision, 1);

  // 3. Concurrent writes serialized per project preserve the newest sequence
  const [c1, c2, c3] = await Promise.all([
    mgr.persistRecoveryCheckpoint(makeMockProject({ revision: 10 })),
    mgr.persistRecoveryCheckpoint(makeMockProject({ revision: 11 })),
    mgr.persistRecoveryCheckpoint(makeMockProject({ revision: 12 })),
  ]);
  assert.equal(c1.persisted, true);
  assert.equal(c2.persisted, true);
  assert.equal(c3.persisted, true);
  assert.ok((c3.envelope?.sequenceNumber ?? 0) > (c2.envelope?.sequenceNumber ?? 0));
  assert.ok((c2.envelope?.sequenceNumber ?? 0) > (c1.envelope?.sequenceNumber ?? 0));

  const latest = await mgr.inspectCrashRecovery('proj-recovery-1');
  assert.equal(latest.migratedSnapshot?.revision, 12);

  // 4. Temp file cleanup deletes orphaned `.tmp.*.json` without deleting `.current.json` or `.prev.json`
  const key = encodeProjectStorageKey('proj-recovery-1');
  const recDir = fakeRoot.subdirs.get('recovery-journal')!;
  recDir.files.set(`${key}.tmp.orphaned_1.json`, 'partial garbage');
  recDir.files.set(`${key}.tmp.orphaned_2.json`, 'partial garbage');

  const cleaned = await mgr.cleanupMaintenance('proj-recovery-1');
  assert.equal(cleaned.obsoleteTempFilesRemoved, 2);
  assert.equal(recDir.files.has(`${key}.current.json`), true);
  assert.equal(recDir.files.has(`${key}.prev.json`), true);

  // 5. Missing durable storage fails explicitly as RECOVERY_STORAGE_UNAVAILABLE
  const noStorageMgr = new CrashRecoveryAndSessionLock(null, {
    disableDefaultLockBackends: true,
    disableDefaultJournalBackends: true,
  });
  const noStorageWrite = await noStorageMgr.persistRecoveryCheckpoint(makeMockProject());
  assert.equal(noStorageWrite.persisted, false);
  assert.equal(noStorageWrite.status, 'DEGRADED_STORAGE_UNAVAILABLE');
  assert.equal(noStorageWrite.errorCode, 'STORAGE_UNAVAILABLE');
  const noStorageInspect = await noStorageMgr.inspectCrashRecovery('proj-recovery-1');
  assert.equal(noStorageInspect.status, 'RECOVERY_STORAGE_UNAVAILABLE');
});

// ─── 4. RECOVERY LIFECYCLE, CONFLICTS, MEDIA VERIFICATION & APP ORCHESTRATOR ─

test('Recovery lifecycle: lock contention blocks restore, v1->v2 migration works, stale revision conflicts, missing vs changed media distinguished, failed recovery leaves original untouched', async () => {
  const backing = new Map<string, string>();
  const store = makeSimpleDurableStore(backing);
  const leaseStore = new InMemoryAtomicLeaseStore();
  let fakeNow = 1_700_000_000_000;

  const opts = {
    leaseStore,
    disableDefaultLockBackends: true,
    leaseTtlMs: 30_000,
    leaseRenewIntervalMs: 0,
    nowFn: () => fakeNow,
  };

  const sessionOwner = new CrashRecoveryAndSessionLock(store, opts);
  const sessionRecoverer = new CrashRecoveryAndSessionLock(store, opts);

  await sessionOwner.acquireProjectLock('proj-recovery-1');
  // Write a v1 schema dirty checkpoint referencing two media assets
  const v1Doc = makeMockProject({
    revision: 8,
    versions: {
      projectSchemaVersion: 1,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: 'fa-asr-bundle-1.2',
    },
  });
  const assets = [
    makeAsset('asset-voice-1', 'sha_voice_orig', 2048),
    makeAsset('asset-music-2', 'sha_music_orig', 4096),
  ];
  await sessionOwner.persistRecoveryCheckpoint(v1Doc, {
    shutdownState: 'DIRTY_ACTIVE',
    requiredAssetIdentities: assets,
  });

  // 1. Recovery while another session owns the project is blocked (LOCK_CONTENDED)
  const savedRev5 = makeMockProject({ revision: 5 });
  const contendedExec = await sessionRecoverer.executeSafeCrashRecovery({
    currentSavedProject: savedRev5,
  });
  assert.equal(contendedExec.restored, false);
  assert.equal(contendedExec.errorCode, 'LOCK_CONTENDED');
  assert.equal(contendedExec.originalProjectPreserved, true);
  assert.equal(contendedExec.document.revision, 5);

  // 2. Owner crashes (lease expires) -> Recoverer acquires lock & restores safely with v1->v2 migration + media diff
  fakeNow += 35_000;
  const acq = await sessionRecoverer.acquireProjectLock('proj-recovery-1');
  assert.equal(acq.acquired, true);

  const localAssets = new Map<string, AssetIdentityRecord>([
    ['asset-voice-1', makeAsset('asset-voice-1', 'sha_voice_MODIFIED', 2048)],
    // asset-music-2 is missing
  ]);

  const safeRestore = await sessionRecoverer.executeSafeCrashRecovery({
    currentSavedProject: savedRev5,
    availableLocalAssetsMap: localAssets,
  });
  assert.equal(safeRestore.restored, true);
  assert.equal(safeRestore.wasMigrated, true);
  assert.equal(safeRestore.document.versions.projectSchemaVersion, 2);
  assert.equal(safeRestore.document.revision, 8);
  assert.deepEqual(safeRestore.mediaVerification?.missingAssetIds, ['asset-music-2']);
  assert.deepEqual(safeRestore.mediaVerification?.contentChangedAssetIds, ['asset-voice-1']);
  assert.equal(safeRestore.mediaVerification?.allReferencedAssetsVerified, false);

  // 3. Stale checkpoint (rev 8) vs newer saved project (rev 12) blocked unless explicitly resolved
  const newerSaved = makeMockProject({ revision: 12, name: 'نسخه جدیدتر ذخیره‌شده' });
  const staleBlocked = await sessionRecoverer.executeSafeCrashRecovery({
    currentSavedProject: newerSaved,
  });
  assert.equal(staleBlocked.restored, false);
  assert.equal(staleBlocked.errorCode, 'CONFLICT_STALE_CHECKPOINT');
  assert.equal(staleBlocked.originalProjectPreserved, true);
  assert.equal(staleBlocked.document.revision, 12);

  // Explicit conflict resolution allows restoring stale checkpoint
  const staleForced = await sessionRecoverer.executeSafeCrashRecovery({
    currentSavedProject: newerSaved,
    conflictResolution: 'FORCE_RESTORE_STALE',
  });
  assert.equal(staleForced.restored, true);
  assert.equal(staleForced.document.revision, 8);

  // 4. Failed recovery (corrupted checkpoint) leaves original project unchanged
  backing.set('proj-recovery-1', '{corrupted');
  const failedRestore = await sessionRecoverer.executeSafeCrashRecovery({
    currentSavedProject: newerSaved,
  });
  assert.equal(failedRestore.restored, false);
  assert.equal(failedRestore.status, 'RECOVERY_CORRUPTED');
  assert.equal(failedRestore.originalProjectPreserved, true);
  assert.equal(failedRestore.document.revision, 12);
  assert.equal(failedRestore.document.name, 'نسخه جدیدتر ذخیره‌شده');
});

test('VerticalSliceOrchestrator enforces read-only on contention, halts mutations on lock loss, and persists clean shutdown before lock release', async () => {
  const store = makeSimpleDurableStore();
  const leaseStore = new InMemoryAtomicLeaseStore();
  let fakeNow = 1_700_000_000_000;
  const opts = {
    leaseStore,
    disableDefaultLockBackends: true,
    leaseTtlMs: 10_000,
    leaseRenewIntervalMs: 0,
    nowFn: () => fakeNow,
  };

  const doc = makeMockProject({ revision: 1 });
  const orch1 = new VerticalSliceOrchestrator(store, opts);
  const orch2 = new VerticalSliceOrchestrator(store, opts);

  const s1 = await orch1.initializeProjectSession(doc);
  assert.equal(s1.lockAcquired, true);
  assert.equal(s1.readOnly, false);

  // Second session opens in safe read-only mode on contention
  const s2 = await orch2.initializeProjectSession(doc, { allowReadOnlyOnContention: true });
  assert.equal(s2.lockAcquired, false);
  assert.equal(s2.readOnly, true);
  assert.equal(s2.lockResult.state, 'CONTENDED');
  await assert.rejects(
    () => orch2.acceptRecommendationAndSaveCheckpoint('rec_any'),
    /SESSION_READ_ONLY_LOCK_REQUIRED/,
  );

  // Lock loss during active session stops new mutations
  fakeNow += 15_000;
  const orch3 = new VerticalSliceOrchestrator(store, opts);
  const s3 = await orch3.initializeProjectSession(doc);
  assert.equal(s3.lockAcquired, true);

  await assert.rejects(
    () => orch1.acceptRecommendationAndSaveCheckpoint('rec_any'),
    /PROJECT_LOCK_LOST/,
  );
  assert.equal(orch1.isReadOnly(), true);

  // Clean shutdown persists clean checkpoint BEFORE releasing lock
  await orch3.closeSessionCleanly();
  assert.equal(orch3.getLockState(), 'RELEASED');
  const postClean = await orch3.getSessionManager().inspectCrashRecovery(doc.projectId);
  assert.equal(postClean.status, 'NO_RECOVERY_AVAILABLE');
});
