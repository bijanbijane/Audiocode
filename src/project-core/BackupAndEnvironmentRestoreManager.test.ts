import test from 'node:test';
import assert from 'node:assert/strict';
import { BackupAndEnvironmentRestoreManager } from './BackupAndEnvironmentRestoreManager';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { AssetIdentityRecord } from './ProjectLifecycleAndMigrationEngine';
import { STANDARD_EXPORT_PROFILES } from '../processing-core/StreamingExportEncoder';

function makeSampleProject(schemaVersion = 2): ProjectDocument {
  return {
    projectId: 'proj-bkp-1',
    name: 'اپیزود تستی پشتیبان‌گیری',
    canonicalSampleRate: 48000,
    revision: 5,
    versions: {
      projectSchemaVersion: schemaVersion,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: 'persian-asr-v1',
    },
    tracks: [],
    recommendations: [],
  };
}

const SAMPLE_ASSETS: AssetIdentityRecord[] = [
  {
    assetId: 'asset-voice-1',
    contentVersion: 1,
    fullContentSha256: 'abc123full',
    partialFingerprintSha256: 'abc123partial',
    fileSize: 2_500_000,
    sampleRate: 48000,
    channelCount: 1,
    sampleCount: 1_200_000,
    originalFileName: 'guest_voice.wav',
  },
  {
    assetId: 'asset-music-2',
    contentVersion: 1,
    fullContentSha256: 'def456full',
    partialFingerprintSha256: 'def456partial',
    fileSize: 4_000_000,
    sampleRate: 48000,
    channelCount: 2,
    sampleCount: 2_000_000,
    originalFileName: 'intro_music.wav',
  },
];

test('Project Backup verifies SHA-256, migrates v1 -> v2, and classifies missing vs changed media assets', async () => {
  const v1Project = makeSampleProject(1);
  const bundle = await BackupAndEnvironmentRestoreManager.createProjectBackup(
    v1Project,
    SAMPLE_ASSETS,
    '1.2.0',
  );

  assert.equal(bundle.manifest.kind, 'PROJECT_BACKUP');

  // Local machine has asset-voice-1 with DIFFERENT hash, and is missing asset-music-2
  const localMap = new Map<string, AssetIdentityRecord>([
    ['asset-voice-1', { ...SAMPLE_ASSETS[0], fullContentSha256: 'modified_sha' }],
  ]);

  const restored = await BackupAndEnvironmentRestoreManager.validateAndRestoreProjectBackup(
    bundle,
    localMap,
    1,
  );

  assert.equal(restored.wasMigrated, true);
  assert.equal(restored.restoredDocument.versions.projectSchemaVersion, 2);
  assert.deepEqual(restored.missingAssetIds, ['asset-music-2']);
  assert.deepEqual(restored.contentChangedAssetIds, ['asset-voice-1']);
  assert.equal(restored.validationStages.length, 5);
  assert.ok(restored.validationStages.every((s) => s.passed));

  // Tampered bundle fails SHA-256 integrity gate cleanly in preflight AND throws in restore
  const tampered = {
    ...bundle,
    projectDocument: { ...bundle.projectDocument, name: 'عنوان دستکاری‌شده' },
  };
  const preflightTampered = await BackupAndEnvironmentRestoreManager.preflightValidateProjectBackup(
    tampered,
    localMap,
    1,
  );
  assert.equal(preflightTampered.canRestore, false);
  assert.equal(preflightTampered.failedStage, 'STAGE_2_SHA256_INTEGRITY');

  await assert.rejects(
    () => BackupAndEnvironmentRestoreManager.validateAndRestoreProjectBackup(tampered, localMap, 1),
    /RESTORE_HASH_MISMATCH/,
  );

  // Newer runtime major rejects cleanly at Stage 3
  const futureBundle = await BackupAndEnvironmentRestoreManager.createProjectBackup(
    makeSampleProject(2),
    [],
    '2.0.0',
  );
  const preflightFuture = await BackupAndEnvironmentRestoreManager.preflightValidateProjectBackup(
    futureBundle,
    localMap,
    1,
  );
  assert.equal(preflightFuture.canRestore, false);
  assert.equal(preflightFuture.failedStage, 'STAGE_3_RUNTIME_COMPATIBILITY');

  await assert.rejects(
    () => BackupAndEnvironmentRestoreManager.validateAndRestoreProjectBackup(futureBundle, localMap, 1),
    /RESTORE_RUNTIME_INCOMPATIBLE/,
  );
});

test('Media Backup and Environment Recovery bundles validate independently with SHA-256 verification', async () => {
  const mediaBundle = await BackupAndEnvironmentRestoreManager.createMediaBackup(
    SAMPLE_ASSETS,
    '1.2.0',
  );
  const restoredMedia = await BackupAndEnvironmentRestoreManager.validateAndRestoreMediaBackup(
    mediaBundle,
  );
  assert.equal(restoredMedia.assetIdentities.length, 2);

  const envBundle = await BackupAndEnvironmentRestoreManager.createEnvironmentRecoveryBundle(
    [STANDARD_EXPORT_PROFILES.PODCAST_STEREO_STANDARD],
    {
      externalApiGloballyEnabled: false,
      maxAllowedAudioSnippetSeconds: 120,
      allowedProviderIds: [],
    },
    [{ modelId: 'whisper-fa-v1', version: '1.0.2' }],
    '1.2.0',
  );

  const restoredEnv = await BackupAndEnvironmentRestoreManager.validateAndRestoreEnvironmentRecovery(
    envBundle,
    1,
  );
  assert.equal(restoredEnv.customExportProfiles.length, 1);
  assert.equal(restoredEnv.userApiPolicy.externalApiGloballyEnabled, false);
  assert.equal(restoredEnv.installedModelRefs[0].modelId, 'whisper-fa-v1');
});
