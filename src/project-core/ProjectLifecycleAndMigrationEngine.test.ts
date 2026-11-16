import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssetIdentityRecord,
  ProjectLifecycleAndMigrationEngine,
} from './ProjectLifecycleAndMigrationEngine';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

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
