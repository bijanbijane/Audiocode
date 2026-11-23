import test from 'node:test';
import assert from 'node:assert/strict';
import { WespeakerKaldiFbank80 } from './WespeakerKaldiFbank80';

test('WeSpeaker Kaldi FBANK emits 80 bins, Kaldi snipped frame count and finite CMN features', () => {
  const sampleRate = 16000;
  const pcm = new Float32Array(sampleRate * 2);
  for (let i = 0; i < pcm.length; i++) {
    const time = i / sampleRate;
    pcm[i] =
      0.18 * Math.sin(2 * Math.PI * 173 * time) +
      0.07 * Math.sin(2 * Math.PI * 311 * time);
  }

  const result = new WespeakerKaldiFbank80().compute(pcm);
  assert.equal(result.numMelBins, 80);
  assert.equal(result.numFrames, 198);
  assert.equal(result.features.length, 198 * 80);

  for (const value of result.features) {
    assert.ok(Number.isFinite(value), 'FBANK output must be finite');
  }

  for (let mel = 0; mel < 80; mel++) {
    let mean = 0;
    for (let frame = 0; frame < result.numFrames; frame++) {
      mean += result.features[frame * 80 + mel];
    }
    mean /= result.numFrames;
    assert.ok(Math.abs(mean) < 1e-4, `CMN mean for mel bin ${mel} should be approximately zero`);
  }
});

test('WeSpeaker Kaldi FBANK handles silence without non-finite values', () => {
  const silence = new Float32Array(16000);
  const result = new WespeakerKaldiFbank80().compute(silence);
  assert.equal(result.numFrames, 98);
  for (const value of result.features) assert.ok(Number.isFinite(value));
  assert.ok(result.features.every((value) => value === 0));
});

test('WeSpeaker Kaldi FBANK returns no frames for audio shorter than a 25 ms frame', () => {
  const result = new WespeakerKaldiFbank80().compute(new Float32Array(399));
  assert.equal(result.numFrames, 0);
  assert.equal(result.features.length, 0);
});
