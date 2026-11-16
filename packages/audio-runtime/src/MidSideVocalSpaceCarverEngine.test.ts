import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MidSideVocalSpaceCarverEngine } from './MidSideVocalSpaceCarverEngine';

describe('MidSideVocalSpaceCarverEngine (Sections 2.4 & 33)', () => {
  it('reconstructs stereo Left/Right losslessly after Mid/Side round-trip encoding', () => {
    const left = new Float32Array([0.5, -0.25, 0.8, -0.4]);
    const right = new Float32Array([0.1, 0.35, -0.2, -0.4]);

    const { mid, side } = MidSideVocalSpaceCarverEngine.encodeStereoToMidSide(left, right);
    const [outL, outR] = MidSideVocalSpaceCarverEngine.decodeMidSideToStereo(mid, side, 1.0);

    for (let i = 0; i < left.length; i++) {
      assert.ok(Math.abs(outL[i] - left[i]) < 1e-6);
      assert.ok(Math.abs(outR[i] - right[i]) < 1e-6);
    }
  });

  it('carves 1kHz vocal-band energy in Mid channel during speech while keeping Side channel intact', () => {
    const sr = 48000 as const;
    const len = 12000; // 250ms
    const musicLeft = new Float32Array(len);
    const musicRight = new Float32Array(len);
    const narratorVoice = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      // In-phase 1000Hz center music component + out-of-phase 1000Hz side component
      const center1k = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / sr);
      const side2k = 0.2 * Math.sin((2 * Math.PI * 2000 * i) / sr);
      musicLeft[i] = center1k + side2k;
      musicRight[i] = center1k - side2k;
      narratorVoice[i] = 0.25 * Math.sin((2 * Math.PI * 180 * i) / sr);
    }

    const beforeMS = MidSideVocalSpaceCarverEngine.encodeStereoToMidSide(musicLeft, musicRight);
    const [carvedL, carvedR] = MidSideVocalSpaceCarverEngine.carveMidChannelSpaceForPersianVoice(
      musicLeft,
      musicRight,
      narratorVoice,
      sr,
      6.5,
    );
    const afterMS = MidSideVocalSpaceCarverEngine.encodeStereoToMidSide(carvedL, carvedR);

    let midRmsBefore = 0;
    let midRmsAfter = 0;
    let sideRmsBefore = 0;
    let sideRmsAfter = 0;

    // Measure steady state in second half of buffer
    for (let i = 6000; i < len; i++) {
      midRmsBefore += beforeMS.mid[i] * beforeMS.mid[i];
      midRmsAfter += afterMS.mid[i] * afterMS.mid[i];
      sideRmsBefore += beforeMS.side[i] * beforeMS.side[i];
      sideRmsAfter += afterMS.side[i] * afterMS.side[i];
    }

    assert.ok(midRmsAfter < midRmsBefore * 0.55, 'Mid vocal band must be significantly attenuated');
    assert.ok(sideRmsAfter >= sideRmsBefore, 'Side stereo image must remain unattenuated');
  });
});
