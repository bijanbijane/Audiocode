import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GranularDataDeletionManager,
  OpfsDirectoryLike,
} from './GranularDataDeletionManager';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

function makeProject(projectId: string, assetId: string): ProjectDocument {
  return {
    projectId,
    name: projectId,
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: '2.4.1',
    },
    revision: 1,
    tracks: [
      {
        id: 't1',
        name: 'میزبان',
        syncGroupId: null,
        speakerId: 's1',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId,
            sourceRange: { start: 0, end: TimeMath.secondsToFlicks(2) },
            timelineRange: { start: 0, end: TimeMath.secondsToFlicks(2) },
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

function createMockOpfsRoot(removedPaths: string[]): OpfsDirectoryLike {
  const mkDir = (prefix: string): OpfsDirectoryLike => ({
    async getDirectoryHandle(name: string) {
      return mkDir(prefix ? `${prefix}/${name}` : name);
    },
    async removeEntry(name: string) {
      removedPaths.push(prefix ? `${prefix}/${name}` : name);
    },
  });
  return mkDir('');
}

test('GranularDataDeletionManager blocks physical deletion of shared source assets and handles all scopes independently', async () => {
  const projA = makeProject('proj-a', 'shared-asset-1');
  const projB = makeProject('proj-b', 'shared-asset-1');
  const removedPaths: string[] = [];
  const opfsRoot = createMockOpfsRoot(removedPaths);

  // 1. Deleting source asset shared with projB MUST throw
  await assert.rejects(
    () =>
      GranularDataDeletionManager.executeGranularDeletion({
        scope: 'DELETE_SOURCE_ASSET_FILE',
        targetProject: projA,
        allLocalProjects: [projA, projB],
        targetAssetId: 'shared-asset-1',
        opfsRoot,
      }),
    /ASSET_IN_USE_BY_OTHER_PROJECTS/,
  );

  // 2. Removing reference from projA ONLY leaves disk untouched and removes clip
  const refRes = await GranularDataDeletionManager.executeGranularDeletion({
    scope: 'REMOVE_ASSET_REFERENCE_FROM_PROJECT',
    targetProject: projA,
    allLocalProjects: [projA, projB],
    targetAssetId: 'shared-asset-1',
    opfsRoot,
  });
  assert.equal(refRes.updatedProject?.tracks[0].clips.length, 0);
  assert.equal(refRes.freedDiskEntities.length, 0);

  // 3. Now projB is the only owner -> DELETE_SOURCE_ASSET_FILE succeeds cleanly
  const delSource = await GranularDataDeletionManager.executeGranularDeletion({
    scope: 'DELETE_SOURCE_ASSET_FILE',
    targetProject: projB,
    allLocalProjects: [refRes.updatedProject!, projB],
    targetAssetId: 'shared-asset-1',
    opfsRoot,
  });
  assert.deepEqual(delSource.freedDiskEntities, ['assets/shared-asset-1.bin']);

  // 4. DELETE_DERIVED_RENDERS & CLEAR_EDIT_TRANSACTION_HISTORY remove their own entries cleanly
  await GranularDataDeletionManager.executeGranularDeletion({
    scope: 'DELETE_DERIVED_RENDERS',
    targetProject: projB,
    allLocalProjects: [projB],
    opfsRoot,
  });
  await GranularDataDeletionManager.executeGranularDeletion({
    scope: 'CLEAR_EDIT_TRANSACTION_HISTORY',
    targetProject: projB,
    allLocalProjects: [projB],
    opfsRoot,
  });

  assert.ok(removedPaths.includes('derived-renders/proj-b'));
  assert.ok(removedPaths.includes('transaction-history/proj-b.journal.json'));
});
