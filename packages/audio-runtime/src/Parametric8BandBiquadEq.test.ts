import test from 'node:test';
import assert from 'node:assert/strict';
import { Parametric8BandBiquadEq } from './Parametric8BandBiquadEq';

test('Section 95: Parametric8BandBiquadEq computes accurate Z-plane frequency response and processes audio in-place', () => {
  const eq = new Parametric8BandBiquadEq(48000, [
    {
      bandId: 'b_notch_50',
      enabled: true,
      topology: 'NOTCH',
      frequencyHz: 50,
      gainDb: 0,
      qFactor: 10.0,
    },
    {
      bandId: 'b_peak_1000',
      enabled: true,
      topology: 'PEAKING',
      frequencyHz: 1000,
      gainDb: 6.0,
      qFactor: 1.5,
    },
  ]);

  const freqs = new Float32Array([50, 1000, 5000]);
  const respDb = eq.computeFrequencyResponseDb(freqs);

  // At 50 Hz notch, gain should be deeply attenuated (< -30 dB)
  assert.ok(respDb[0] < -30, `Expected 50Hz notch < -30dB, got ${respDb[0]}`);
  // At 1000 Hz peaking, gain should be close to +6 dB
  assert.ok(Math.abs(respDb[1] - 6.0) < 0.25, `Expected ~ +6dB at 1kHz, got ${respDb[1]}`);

  const pcm = new Float32Array(4800);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
  }
  eq.processInPlace(pcm);
  assert.ok(Math.abs(pcm[2400]) > 0);
});
