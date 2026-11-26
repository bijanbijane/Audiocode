import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineHistoryManager } from './timeline';

function commitPcmEdit(
  manager: TimelineHistoryManager,
  description: string,
  before: Float32Array,
  after: Float32Array,
) {
  return manager.commitTransaction({
    coalescingKey: '',
    type: 'dsp-parameter-change',
    description,
    beforeTracks: [],
    afterTracks: [],
    beforePcmSources: { main: before },
    afterPcmSources: { main: after },
  });
}

test('TimelineHistoryManager counts unique PCM arrays across Undo and Redo without double-counting shared references', () => {
  const manager = new TimelineHistoryManager(10, 1024 * 1024);
  const shared = new Float32Array(100_000);
  const changed = new Float32Array(100_000);
  commitPcmEdit(manager, 'first', shared, changed);

  assert.equal(manager.getRetainedPcmBytes(), shared.byteLength + changed.byteLength);
  assert.equal(manager.getMaxRetainedPcmBytes(), 1024 * 1024);
  assert.equal(manager.canUndo(), true);

  manager.undo();
  assert.equal(manager.getRetainedPcmBytes(), shared.byteLength + changed.byteLength);
  manager.redo();
  assert.equal(manager.getRetainedPcmBytes(), shared.byteLength + changed.byteLength);
});

test('TimelineHistoryManager evicts oldest Undo snapshots when the unique PCM budget is reached', () => {
  const manager = new TimelineHistoryManager(10, 1024 * 1024);
  const first = new Float32Array(100_000);
  const shared = new Float32Array(100_000);
  const third = new Float32Array(100_000);
  commitPcmEdit(manager, 'first', first, shared);
  commitPcmEdit(manager, 'second', shared, third);

  assert.deepEqual(manager.getHistory().map((tx) => tx.description), ['second']);
  assert.equal(manager.getRetainedPcmBytes(), shared.byteLength + third.byteLength);
  assert.equal(manager.canUndo(), true);
});

test('TimelineHistoryManager clears stale history when one PCM-changing edit alone exceeds the byte cap', () => {
  const manager = new TimelineHistoryManager(10, 1024 * 1024);
  const before = new Float32Array(150_000);
  const after = new Float32Array(150_000);
  commitPcmEdit(manager, 'oversized', before, after);

  assert.equal(manager.canUndo(), false);
  assert.equal(manager.canRedo(), false);
  assert.equal(manager.getRetainedPcmBytes(), 0);
  assert.equal(manager.wasLastCommitRetained(), false);
});

test('TimelineHistoryManager omits unchanged PCM snapshots so ordinary edits do not pin project audio', () => {
  const manager = new TimelineHistoryManager(10, 1024 * 1024);
  const unchanged = new Float32Array(500_000);
  const tx = manager.commitTransaction({
    coalescingKey: '',
    type: 'dsp-parameter-change',
    description: 'metadata-only edit',
    beforeTracks: [],
    afterTracks: [],
    beforePcmSources: { main: unchanged },
    afterPcmSources: { main: unchanged },
  });

  assert.equal(tx.beforePcmSources, undefined);
  assert.equal(tx.afterPcmSources, undefined);
  assert.equal(manager.getRetainedPcmBytes(), 0);
  assert.equal(manager.canUndo(), true);
});

test('TimelineHistoryManager rejects invalid PCM history budgets', () => {
  assert.throws(() => new TimelineHistoryManager(10, -1), RangeError);
  assert.throws(() => new TimelineHistoryManager(10, Number.NaN), RangeError);
});


test('TimelineHistoryManager counts shared ArrayBuffer backing stores only once', () => {
  const manager = new TimelineHistoryManager(10, 1024 * 1024);
  const backing = new ArrayBuffer(800_000);
  const before = new Float32Array(backing, 0, 50_000);
  const after = new Float32Array(backing, 100_000, 50_000);
  commitPcmEdit(manager, 'shared-backing-store', before, after);

  assert.equal(manager.getRetainedPcmBytes(), backing.byteLength);
});
