import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingPlaybackPumpController } from './StreamingPlaybackPumpController';
import { SharedAudioRingBuffer } from '../../../src/audio-engine/SharedRingBuffer';
import { ProjectDocument } from '../../../src/contracts/project-schema.contract';
import { TimeMath } from '../../../src/contracts/timebase.contract';

test('Section 92: StreamingPlaybackPumpController renders timeline clips with equal-power fades and primes SharedAudioRingBuffer on seek', async () => {
  const sr = 48000 as const;
  const doc: ProjectDocument = {
    projectId: 'proj_pump',
    name: 'پروژه تست پمپ',
    canonicalSampleRate: sr,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0.0',
      activeModelBundleVersion: '1.2.0',
    },
    revision: 1,
    tracks: [
      {
        id: 'trk_1',
        name: 'گوینده',
        syncGroupId: null,
        speakerId: 'S1',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 'trk_1',
            kind: 'AUDIO_ASSET',
            assetId: 'asset_1',
            sourceRange: { start: 0, end: TimeMath.secondsToFlicks(5.0) },
            timelineRange: { start: 0, end: TimeMath.secondsToFlicks(5.0) },
            fadeInFlicks: TimeMath.secondsToFlicks(0.01),
            fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [],
  };

  const ring = new SharedAudioRingBuffer(sr * 2, 2);
  const controller = new StreamingPlaybackPumpController(doc, ring, {
    readAssetSourceSamples: async (_assetId, _start, frameCount) => {
      const ch = new Float32Array(frameCount).fill(0.5);
      return [ch, ch];
    },
  });

  await controller.seekAndPrimeRingBuffer(0);
  assert.ok(ring.availableRead() >= 4096, 'Expected ring buffer to be primed with audio samples');

  ring.setPlaying(true);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  const pulledOk = ring.pull([outL, outR], 128);
  assert.equal(pulledOk, true);
  // First sample has sin(0) fade-in = 0, sample 100 is well into fade-in > 0
  assert.equal(outL[0], 0);
  assert.ok(outL[100] > 0.1);
});
