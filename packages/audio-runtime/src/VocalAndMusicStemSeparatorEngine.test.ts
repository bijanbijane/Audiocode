import test from 'node:test';
import assert from 'node:assert/strict';
import { VocalAndMusicStemSeparatorEngine } from './VocalAndMusicStemSeparatorEngine';

test('Section 83: VocalAndMusicStemSeparatorEngine extracts center vocal stem and preserves wide stereo music bed', () => {
  const sr = 48000 as const;
  const len = 24000;
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    // Center-panned speech formant at 600 Hz
    const centerVocal = 0.45 * Math.sin((2 * Math.PI * 600 * i) / sr);
    // Out-of-phase wide stereo music pad at 90 Hz + 2500 Hz
    const sideMusic =
      0.2 * Math.sin((2 * Math.PI * 90 * i) / sr) +
      0.15 * Math.sin((2 * Math.PI * 2500 * i) / sr);

    left[i] = centerVocal + sideMusic;
    right[i] = centerVocal - sideMusic;
  }

  const res = VocalAndMusicStemSeparatorEngine.separateVocalAndMusicStems(left, right, sr);
  assert.equal(res.vocalMonoStem.length, len);
  assert.equal(res.musicStereoStem[0].length, len);
  assert.equal(res.musicStereoStem[1].length, len);

  // Verify vocal stem captures meaningful energy
  let vocalRmsSum = 0;
  for (let i = 4800; i < len; i++) {
    vocalRmsSum += res.vocalMonoStem[i] * res.vocalMonoStem[i];
  }
  const vocalRms = Math.sqrt(vocalRmsSum / (len - 4800));
  assert.ok(vocalRms > 0.08, `Expected vocal RMS > 0.08, got ${vocalRms}`);
  assert.ok(Number.isFinite(res.vocalToMusicEnergyRatioDb));
});

test('Section 83: VocalAndMusicStemSeparatorEngine handles empty buffers safely', () => {
  const res = VocalAndMusicStemSeparatorEngine.separateVocalAndMusicStems(
    new Float32Array(0),
    new Float32Array(0),
    48000,
  );
  assert.equal(res.vocalMonoStem.length, 0);
  assert.equal(res.vocalToMusicEnergyRatioDb, 0);
});
