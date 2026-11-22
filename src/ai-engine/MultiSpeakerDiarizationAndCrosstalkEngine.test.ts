import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiSpeakerDiarizationAndCrosstalkEngine } from './MultiSpeakerDiarizationAndCrosstalkEngine';
import { TimeMath } from '../contracts/timebase.contract';

test('Multi-track crosstalk detector classifies 3ms attenuated bleed as CROSSTALK_MIC_BLEED and distinct simultaneous speakers as OVERLAPPING_SPEECH', () => {
  const sr = 48000 as const;
  const durationSamples = sr * 1; // 1 second
  const host = new Float32Array(durationSamples);
  const guestBleed = new Float32Array(durationSamples);
  const guestSimultaneous = new Float32Array(durationSamples);

  const delaySamples = Math.floor(0.003 * sr); // 3ms room acoustic delay
  for (let i = 0; i < durationSamples; i++) {
    host[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / sr);
    if (i >= delaySamples) {
      // -16dB attenuated bleed copy of host (linear ~0.158)
      guestBleed[i] = 0.15 * host[i - delaySamples];
    }
    // Uncorrelated speaker at different pitch & comparable energy
    guestSimultaneous[i] = 0.32 * Math.sin((2 * Math.PI * 373 * i) / sr);
  }

  const bleedAnalysis = MultiSpeakerDiarizationAndCrosstalkEngine.analyzeMultiTrackCrosstalkAndOverlap(
    [
      { trackId: 'track-host', speakerId: 'HOST', pcmMono: host },
      { trackId: 'track-guest', speakerId: 'GUEST', pcmMono: guestBleed },
    ],
    sr,
  );
  assert.ok(bleedAnalysis.some((s) => s.trackId === 'track-guest' && s.classification === 'CROSSTALK_MIC_BLEED'));
  assert.ok(bleedAnalysis.some((s) => s.trackId === 'track-host' && s.classification === 'PRIMARY_SPEECH'));

  const overlapAnalysis = MultiSpeakerDiarizationAndCrosstalkEngine.analyzeMultiTrackCrosstalkAndOverlap(
    [
      { trackId: 'track-host', speakerId: 'HOST', pcmMono: host },
      { trackId: 'track-guest', speakerId: 'GUEST', pcmMono: guestSimultaneous },
    ],
    sr,
  );
  assert.ok(overlapAnalysis.some((s) => s.trackId === 'track-guest' && s.classification === 'OVERLAPPING_SPEECH'));
  assert.ok(overlapAnalysis.some((s) => s.trackId === 'track-host' && s.classification === 'OVERLAPPING_SPEECH'));
});

test('Embedding clustering separates speakers, emits UNKNOWN_SPEAKER, and supports manual correction', () => {
  const vecA = new Float32Array([1, 0, 0, 0]);
  const vecB = new Float32Array([0, 1, 0, 0]);

  const segs = MultiSpeakerDiarizationAndCrosstalkEngine.assignSpeakersFromEmbeddings('t1', [
    {
      range: { start: 0, end: TimeMath.secondsToFlicks(1) },
      embeddingVector: vecA,
      vadProbability: 0.9,
    },
    {
      range: { start: TimeMath.secondsToFlicks(1), end: TimeMath.secondsToFlicks(2) },
      embeddingVector: vecB,
      vadProbability: 0.55, // Too low to register new centroid -> UNKNOWN_SPEAKER
    },
  ]);

  assert.equal(segs[0].speakerId, 'SPEAKER_1');
  assert.equal(segs[1].classification, 'UNKNOWN_SPEAKER');

  const corrected = MultiSpeakerDiarizationAndCrosstalkEngine.applyManualSpeakerCorrection(
    segs,
    segs[1].segmentId,
    'SPEAKER_2',
  );
  assert.equal(corrected[1].speakerId, 'SPEAKER_2');
  assert.equal(corrected[1].manuallyVerifiedByUser, true);
});


test('Speaker assignment rejects invalid or dimension-mismatched embeddings instead of comparing partial vectors', () => {
  const segments = MultiSpeakerDiarizationAndCrosstalkEngine.assignSpeakersFromEmbeddings('track-guard', [
    {
      range: { start: 0, end: 100 },
      embeddingVector: new Float32Array([1, 0]),
      vadProbability: 0.95,
    },
    {
      range: { start: 300, end: 400 },
      embeddingVector: new Float32Array([1, 0, 0]),
      vadProbability: 0.95,
    },
    {
      range: { start: 600, end: 700 },
      embeddingVector: new Float32Array([0, 0]),
      vadProbability: 0.95,
    },
    {
      range: { start: 900, end: 1000 },
      embeddingVector: new Float32Array([Number.NaN, 1]),
      vadProbability: 0.95,
    },
  ]);

  assert.equal(segments.length, 4);
  assert.equal(segments[0].speakerId, 'SPEAKER_1');
  assert.deepEqual(
    segments.slice(1).map((segment) => segment.classification),
    ['UNKNOWN_SPEAKER', 'UNKNOWN_SPEAKER', 'UNKNOWN_SPEAKER'],
  );
  assert.throws(
    () =>
      MultiSpeakerDiarizationAndCrosstalkEngine.assignSpeakersFromEmbeddings(
        'track-guard',
        [],
        1.1,
      ),
    /DIARIZATION_SIMILARITY_THRESHOLD_MUST_BE_BETWEEN_MINUS_ONE_AND_ONE/,
  );
});
