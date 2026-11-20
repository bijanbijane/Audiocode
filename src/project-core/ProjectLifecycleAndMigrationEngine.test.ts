import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  AssetIdentityRecord,
  ProjectLifecycleAndMigrationEngine,
} from './ProjectLifecycleAndMigrationEngine';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';
import { HASH_CHUNK_BYTES } from '../utils/StreamingSha256';
import { ingestAudioFileStreaming } from '../engine/streamingIngest';
import { encodeAndValidateWavExport } from '../engine/storageBroker';

function buildDummyProject(schemaVersion: number, corruptClip = false): ProjectDocument {
  return {
    projectId: 'proj_test_1',
    name: 'پادکست آزمایشی',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: schemaVersion,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: '2.4.1',
    },
    revision: 4,
    tracks: [
      {
        id: 'track-1',
        name: 'میزبان',
        syncGroupId: null,
        speakerId: 'spk-1',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'clip-1',
            trackId: 'track-1',
            kind: 'AUDIO_ASSET',
            assetId: 'asset-1',
            sourceRange: {
              start: 0,
              end: TimeMath.secondsToFlicks(5),
            },
            timelineRange: {
              start: 0,
              end: corruptClip ? 0 : TimeMath.secondsToFlicks(5),
            },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [],
  };
}

test('Missing Media Resolution relinks renamed identical 256KB+ media via partial + full SHA-256', async () => {
  // 260 KB payload exercises 64KB head + middle + tail partial fingerprint path
  const rawBytes = new Uint8Array(260 * 1024);
  for (let i = 0; i < rawBytes.length; i++) {
    rawBytes[i] = (i * 31) & 0xff;
  }
  const originalBlob = new Blob([rawBytes]);

  const partial = await ProjectLifecycleAndMigrationEngine.computePartialFingerprint(originalBlob);
  const full = await ProjectLifecycleAndMigrationEngine.computeFullContentHash(originalBlob);

  const missingAsset: AssetIdentityRecord = {
    assetId: 'asset-1',
    contentVersion: 1,
    fullContentSha256: full,
    partialFingerprintSha256: partial,
    fileSize: rawBytes.byteLength,
    sampleRate: 48000,
    channelCount: 1,
    sampleCount: 48000 * 5,
    originalFileName: 'ep42-host.wav',
  };

  // Case 1: Identical bytes, renamed filename -> HASH_VERIFIED
  const renamedEval = await ProjectLifecycleAndMigrationEngine.evaluateCandidateForMissingAsset(
    missingAsset,
    new Blob([rawBytes]),
    'ep42-host-backup-renamed.wav',
  );
  assert.equal(renamedEval.status, 'HASH_VERIFIED');
  assert.equal(renamedEval.requiresNewContentVersion, false);

  // Case 2: Same filename, modified middle byte -> CONTENT_CHANGED
  const mutatedBytes = new Uint8Array(rawBytes);
  mutatedBytes[Math.floor(mutatedBytes.length / 2)] ^= 0xff;
  const changedEval = await ProjectLifecycleAndMigrationEngine.evaluateCandidateForMissingAsset(
    missingAsset,
    new Blob([mutatedBytes]),
    'ep42-host.wav',
  );
  assert.equal(changedEval.status, 'CONTENT_CHANGED');
  assert.equal(changedEval.requiresNewContentVersion, true);
});

test('Safe 4D project migration upgrades v1 -> v2 cleanly, marks v3 READ_ONLY, and rolls back invalid clips', () => {
  const v1Doc = buildDummyProject(1);
  const migrated = ProjectLifecycleAndMigrationEngine.migrateProjectSafely(v1Doc);
  assert.equal(migrated.compatibility, 'COMPATIBLE_WITH_MIGRATION');
  assert.equal(migrated.sourceSnapshot.versions.projectSchemaVersion, 1);
  assert.equal(migrated.migratedDocument.versions.projectSchemaVersion, 2);

  const v3Doc = buildDummyProject(3);
  const futureRes = ProjectLifecycleAndMigrationEngine.migrateProjectSafely(v3Doc);
  assert.equal(futureRes.compatibility, 'READ_ONLY');

  const corruptV1 = buildDummyProject(1, true);
  assert.throws(
    () => ProjectLifecycleAndMigrationEngine.migrateProjectSafely(corruptV1),
    /PROJECT_MIGRATION_VALIDATION_FAILED/,
  );

  const pkg = ProjectLifecycleAndMigrationEngine.buildProjectPackageArchive(
    migrated.migratedDocument,
    [],
    [{ action: 'MIGRATE_V1_TO_V2' }],
  );
  assert.equal(pkg.packageFormatVersion, 1);
  assert.equal(pkg.provenanceLog.length, 1);
});

// ============================================================================
// AVP-IDENTITY-STREAMING-SHA256-002 — Unified Bounded-Memory Relinking Tests
// ============================================================================

function createTrackedLargeBlob(totalSize: number, mutatedOffset?: number) {
  let maxReadSize = 0;
  let totalBytesRead = 0;
  let fullReadAttempted = false;
  let sliceCount = 0;

  const generateSlice = (start: number, end: number): ArrayBuffer => {
    const len = end - start;
    const buf = new ArrayBuffer(len);
    const view = new Uint8Array(buf);
    for (let i = 0; i < len; i++) {
      const pos = start + i;
      let b = ((pos * 1103515245 + 12345) >>> 16) & 0xff;
      if (mutatedOffset !== undefined && pos === mutatedOffset) {
        b ^= 0x80;
      }
      view[i] = b;
    }
    return buf;
  };

  const blob = {
    size: totalSize,
    type: 'audio/wav',
    slice(start = 0, end = totalSize): Blob {
      const s = Math.max(0, Math.min(totalSize, start));
      const e = Math.max(s, Math.min(totalSize, end));
      const len = e - s;
      sliceCount++;
      if (len > maxReadSize) maxReadSize = len;
      totalBytesRead += len;
      return {
        size: len,
        type: 'audio/wav',
        async arrayBuffer(): Promise<ArrayBuffer> {
          return generateSlice(s, e);
        },
      } as unknown as Blob;
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      fullReadAttempted = true;
      throw new Error('Full-file arrayBuffer() must not be invoked during bounded relink hashing');
    },
  } as unknown as Blob;

  const referenceSha256 = (): string => {
    const h = createHash('sha256');
    const step = 1024 * 1024;
    for (let off = 0; off < totalSize; off += step) {
      h.update(new Uint8Array(generateSlice(off, Math.min(off + step, totalSize))));
    }
    return h.digest('hex');
  };

  return {
    blob,
    referenceSha256,
    getMaxReadSize: () => maxReadSize,
    getTotalBytesRead: () => totalBytesRead,
    wasFullReadAttempted: () => fullReadAttempted,
    getSliceCount: () => sliceCount,
  };
}

test('ProjectLifecycleAndMigrationEngine: computeFullContentHash matches independent SHA-256 reference and stays bounded on > 8 MiB files', async () => {
  const smallPayload = new Uint8Array(12_345);
  for (let i = 0; i < smallPayload.length; i++) {
    smallPayload[i] = (i * 17 + 3) & 0xff;
  }
  const smallExpected = createHash('sha256').update(smallPayload).digest('hex');
  const smallActual = await ProjectLifecycleAndMigrationEngine.computeFullContentHash(
    new Blob([smallPayload]),
  );
  assert.equal(smallActual, smallExpected);
  assert.match(smallActual, /^[0-9a-f]{64}$/);

  // Large file (10 MiB): verify bounded 1 MiB reads and zero full-file arrayBuffer() allocation
  const largeSize = 10 * 1024 * 1024;
  const trackedLarge = createTrackedLargeBlob(largeSize);
  const largeActual = await ProjectLifecycleAndMigrationEngine.computeFullContentHash(
    trackedLarge.blob,
  );
  assert.equal(largeActual, trackedLarge.referenceSha256());
  assert.equal(trackedLarge.wasFullReadAttempted(), false);
  assert.ok(trackedLarge.getMaxReadSize() <= HASH_CHUNK_BYTES);
  assert.equal(trackedLarge.getTotalBytesRead(), largeSize);
  assert.equal(trackedLarge.getSliceCount(), Math.ceil(largeSize / HASH_CHUNK_BYTES));
});

test('ProjectLifecycleAndMigrationEngine: detects interior byte mutation outside partial windows, preserves renamed HASH_VERIFIED, CONTENT_CHANGED, and distinct partial fingerprint', async () => {
  // 10 MiB payload; partial fingerprint only hashes 64 KiB head, 64 KiB mid, 64 KiB tail.
  // Mutate one byte at 2 MiB + 777 (strictly outside all three 64 KiB windows).
  const size = 10 * 1024 * 1024;
  const interiorMutationOffset = 2 * 1024 * 1024 + 777;

  const original = createTrackedLargeBlob(size);
  const mutated = createTrackedLargeBlob(size, interiorMutationOffset);

  const partialOriginal = await ProjectLifecycleAndMigrationEngine.computePartialFingerprint(
    original.blob,
  );
  const fullOriginal = await ProjectLifecycleAndMigrationEngine.computeFullContentHash(
    original.blob,
  );
  const partialMutated = await ProjectLifecycleAndMigrationEngine.computePartialFingerprint(
    mutated.blob,
  );
  const fullMutated = await ProjectLifecycleAndMigrationEngine.computeFullContentHash(
    mutated.blob,
  );

  // Partial fingerprint remains distinct from full-content hash on files > 192 KiB
  assert.notEqual(partialOriginal, fullOriginal);
  // Partial screening collides on the unsampled interior mutation, proving full SHA-256 is essential
  assert.equal(partialOriginal, partialMutated);
  assert.notEqual(fullOriginal, fullMutated);

  const missingAsset: AssetIdentityRecord = {
    assetId: 'asset-large-10mib',
    contentVersion: 1,
    fullContentSha256: fullOriginal,
    partialFingerprintSha256: partialOriginal,
    fileSize: size,
    sampleRate: 48000,
    channelCount: 1,
    sampleCount: 48000 * 100,
    originalFileName: 'master-interview.wav',
  };

  // Renamed identical large file -> HASH_VERIFIED
  const renamedOriginal = createTrackedLargeBlob(size);
  const renamedEval = await ProjectLifecycleAndMigrationEngine.evaluateCandidateForMissingAsset(
    missingAsset,
    renamedOriginal.blob,
    'master-interview-moved-backup.wav',
  );
  assert.equal(renamedEval.status, 'HASH_VERIFIED');
  assert.equal(renamedEval.requiresNewContentVersion, false);
  assert.equal(renamedEval.candidateFullHash, fullOriginal);
  assert.equal(renamedOriginal.wasFullReadAttempted(), false);

  // Identically sized file with same filename and interior byte mutation -> CONTENT_CHANGED
  const sameNameMutated = createTrackedLargeBlob(size, interiorMutationOffset);
  const changedEval = await ProjectLifecycleAndMigrationEngine.evaluateCandidateForMissingAsset(
    missingAsset,
    sameNameMutated.blob,
    'master-interview.wav',
  );
  assert.equal(changedEval.status, 'CONTENT_CHANGED');
  assert.equal(changedEval.requiresNewContentVersion, true);
  assert.equal(changedEval.candidateFullHash, fullMutated);
  assert.equal(sameNameMutated.wasFullReadAttempted(), false);
});

test('ProjectLifecycleAndMigrationEngine: full-content hash matches ingestAudioFileStreaming contentHash representation', async () => {
  const pcm = new Float32Array(16_000 * 3);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 180 * i) / 16_000) * 0.4;
  }
  const wavBlob = encodeAndValidateWavExport([pcm], 16_000).blob;
  const wavBytes = new Uint8Array(await wavBlob.arrayBuffer());
  const file = new File([wavBytes], 'relink-parity-check.wav', { type: 'audio/wav' });

  const [ingested, relinkFullHash] = await Promise.all([
    ingestAudioFileStreaming(file, { chunkSeconds: 1 }),
    ProjectLifecycleAndMigrationEngine.computeFullContentHash(file),
  ]);

  const asset = Object.values(ingested.assets)[0];
  const expectedRef = createHash('sha256').update(wavBytes).digest('hex');

  assert.equal(relinkFullHash, expectedRef);
  assert.equal(asset.contentHash, `sha256:${relinkFullHash}`);
});

