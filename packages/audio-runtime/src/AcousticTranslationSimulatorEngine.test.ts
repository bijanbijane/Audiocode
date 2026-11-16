import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AcousticTranslationSimulatorEngine } from './AcousticTranslationSimulatorEngine';

describe('AcousticTranslationSimulatorEngine (Sections 2.4 & 2.6)', () => {
  it('sums stereo to identical mono channels and attenuates sub-100Hz bass on SMARTPHONE_MONO_SPEAKER', () => {
    const sr = 48000 as const;
    const len = 4800; // 100ms
    const inL = new Float32Array(len);
    const inR = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      // 70Hz deep bass on Left only
      inL[i] = 0.5 * Math.sin((2 * Math.PI * 70 * i) / sr);
      inR[i] = 0.1 * Math.sin((2 * Math.PI * 70 * i) / sr);
    }

    const [outL, outR] = AcousticTranslationSimulatorEngine.simulateListeningEnvironment(
      [inL, inR],
      sr,
      'SMARTPHONE_MONO_SPEAKER',
    );

    let inEnergy = 0;
    let outEnergy = 0;
    for (let i = 1000; i < len; i++) {
      assert.equal(outL[i], outR[i]);
      const monoIn = 0.5 * (inL[i] + inR[i]);
      inEnergy += monoIn * monoIn;
      outEnergy += outL[i] * outL[i];
    }

    assert.ok(outEnergy < inEnergy * 0.25, 'Smartphone speaker must strongly roll off 70Hz bass');
  });

  it('injects low-frequency road masking floor in CAR_CABIN_IN_TRAFFIC even during digital silence', () => {
    const sr = 48000 as const;
    const silence = new Float32Array(2400);
    const [carL, carR] = AcousticTranslationSimulatorEngine.simulateListeningEnvironment(
      [silence, silence],
      sr,
      'CAR_CABIN_IN_TRAFFIC',
    );

    let rumbleEnergy = 0;
    for (let i = 0; i < carL.length; i++) {
      rumbleEnergy += carL[i] * carL[i] + carR[i] * carR[i];
    }
    assert.ok(rumbleEnergy > 0, 'Car cabin simulation must include road rumble masking floor');
  });
});
