import test from 'node:test';
import assert from 'node:assert/strict';
import { CrashRecoveryAndSessionLock, RecoveryJournalStore } from './CrashRecoveryAndSessionLock';
import { ProjectDocument } from '../contracts/project-schema.contract';

function makeMockProject(): ProjectDocument {
  return {
    projectId: 'proj-recovery-1',
    name: 'پادکست آزمایشی',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 1,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0.0',
      activeModelBundleVersion: 'fa-asr-bundle-1.2',
    },
    revision: 7,
    tracks: [],
    recommendations: [],
  };
}

test('CrashRecoveryAndSessionLock detects dirty shutdowns and clears recovery after clean exit', async () => {
  const memory = new Map<string, string>();
  const store: RecoveryJournalStore = {
    async write(id, json) {
      memory.set(id, json);
    },
    async read(id) {
      return memory.get(id) ?? null;
    },
  };

  const sessionA = new CrashRecoveryAndSessionLock(store);
  const doc = makeMockProject();

  // Simulate dirty checkpoint written during editing (tab crashes before clean exit)
  await sessionA.writeRecoveryCheckpoint(doc, false);

  const sessionB = new CrashRecoveryAndSessionLock(store);
  const recovered = await sessionB.checkCrashRecovery(doc.projectId);
  assert.ok(recovered);
  assert.equal(recovered.dirtyShutdownDetected, true);
  assert.equal(recovered.snapshot.revision, 7);

  // Now simulate clean shutdown
  await sessionB.writeRecoveryCheckpoint(doc, true);
  const afterCleanExit = await sessionB.checkCrashRecovery(doc.projectId);
  assert.equal(afterCleanExit, null);
});
