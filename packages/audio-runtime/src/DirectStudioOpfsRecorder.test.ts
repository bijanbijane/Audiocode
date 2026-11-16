import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectStudioOpfsRecorder,
  OpfsDirectoryLike,
} from './DirectStudioOpfsRecorder';

function createMemoryOpfsDirectory(): OpfsDirectoryLike {
  const dirs = new Map<string, OpfsDirectoryLike>();
  const files = new Map<string, Uint8Array>();

  return {
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      const existing = dirs.get(name);
      if (existing) return existing;
      if (!options?.create) throw new Error(`DIR_NOT_FOUND:${name}`);
      const created = createMemoryOpfsDirectory();
      dirs.set(name, created);
      return created;
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) {
        throw new Error(`FILE_NOT_FOUND:${name}`);
      }
      return {
        async createWritable() {
          let pending = new Uint8Array(0);
          return {
            async write(data: Uint8Array) {
              pending = new Uint8Array(data);
            },
            async close() {
              files.set(name, pending);
            },
          };
        },
        async getFile() {
          const data = files.get(name) ?? new Uint8Array(0);
          return {
            async arrayBuffer() {
              return data.slice().buffer;
            },
          };
        },
      };
    },
  };
}

test('Section 64: DirectStudioOpfsRecorder enforces raw studio microphone constraints and crash-safe OPFS block flushing & recovery', async () => {
  const rootDir = createMemoryOpfsDirectory();
  let capturedConstraints: MediaStreamConstraints | null = null;
  let trackStopped = false;
  let ctxClosed = false;

  const recorder = new DirectStudioOpfsRecorder({
    getStorageRoot: async () => rootDir,
    getUserMedia: async (constraints) => {
      capturedConstraints = constraints;
      return {
        getTracks: () => [{ stop: () => { trackStopped = true; } }],
      } as unknown as MediaStream;
    },
    createAudioContext: (opts) =>
      ({
        sampleRate: opts.sampleRate ?? 48000,
        state: 'running',
        close: async () => {
          ctxClosed = true;
        },
      }) as unknown as AudioContext,
  });

  const { actualSampleRate } = await recorder.requestRawStudioMicrophone(undefined, 48000);
  assert.equal(actualSampleRate, 48000);
  assert.equal(recorder.getIsRecording(), true);

  const audioConstraints = capturedConstraints!.audio as MediaTrackConstraints;
  assert.equal(audioConstraints.echoCancellation, false);
  assert.equal(audioConstraints.noiseSuppression, false);
  assert.equal(audioConstraints.autoGainControl, false);

  // Flush two blocks simulating 10 seconds of studio recording before a crash
  const block0 = new Float32Array([0.1, -0.2, 0.3, -0.4]);
  const block1 = new Float32Array([0.5, -0.6, 0.7, -0.8]);

  const meta0 = await recorder.flush5SecondRecordedBlockToOpfs('sess_rec_1', 0, block0);
  const meta1 = await recorder.flush5SecondRecordedBlockToOpfs('sess_rec_1', 1, block1);

  assert.equal(meta0.flushedBlocksCount, 1);
  assert.equal(meta1.flushedBlocksCount, 2);

  await recorder.stopStudioRecording();
  assert.equal(recorder.getIsRecording(), false);
  assert.equal(trackStopped, true);
  assert.equal(ctxClosed, true);

  // Simulate brand-new recorder instance after browser crash recovering OPFS blocks
  const recoveryInstance = new DirectStudioOpfsRecorder({
    getStorageRoot: async () => rootDir,
  });
  const recovered = await recoveryInstance.recoverSessionBlocksFromOpfs('sess_rec_1');
  assert.equal(recovered.length, 8);
  assert.ok(Math.abs(recovered[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(recovered[7] - -0.8) < 1e-6);
});
