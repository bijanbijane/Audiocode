import { SampleRate } from '../../../src/contracts/timebase.contract';

/**
 * Mid/Side Matrix & Dynamic Vocal-Band Spectral Carver Engine (Architecture Doc Sections 2.4 & 33)
 * Decomposes stereo background music into Mid (M = (L+R)/sqrt(2)) and Side (S = (L-R)/sqrt(2))
 * channels, dynamically attenuating only the 300Hz-3500Hz speech formant band in the Mid channel
 * when the Persian narrator speaks, keeping stereo Side music wide and sub-300Hz bass intact.
 */
export class MidSideVocalSpaceCarverEngine {
  /**
   * 1. Encodes Left/Right stereo into unitary-power Mid/Side channels (-3dB matrix).
   */
  public static encodeStereoToMidSide(
    left: Float32Array,
    right: Float32Array,
  ): { mid: Float32Array; side: Float32Array } {
    const len = Math.min(left.length, right.length);
    const mid = new Float32Array(len);
    const side = new Float32Array(len);
    const invSqrt2 = Math.SQRT1_2;

    for (let i = 0; i < len; i++) {
      mid[i] = (left[i] + right[i]) * invSqrt2;
      side[i] = (left[i] - right[i]) * invSqrt2;
    }
    return { mid, side };
  }

  /**
   * 2. Decodes Mid/Side back to Left/Right stereo with configurable stereo width factor.
   */
  public static decodeMidSideToStereo(
    mid: Float32Array,
    side: Float32Array,
    stereoWidthFactor = 1.0, // 0.0 (full mono) to 1.6 (widened stereo image)
  ): [Float32Array, Float32Array] {
    const len = Math.min(mid.length, side.length);
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    const invSqrt2 = Math.SQRT1_2;
    const clampedWidth = Math.max(0.0, Math.min(1.6, stereoWidthFactor));

    for (let i = 0; i < len; i++) {
      const m = mid[i];
      const s = side[i] * clampedWidth;
      left[i] = (m + s) * invSqrt2;
      right[i] = (m - s) * invSqrt2;
    }
    return [left, right];
  }

  /**
   * 3. Carves 300Hz-3500Hz vocal formant space dynamically in the Mid channel of stereo music
   * whenever the Persian narrator is speaking, preserving Side width and low/high frequencies.
   */
  public static carveMidChannelSpaceForPersianVoice(
    musicLeft: Float32Array,
    musicRight: Float32Array,
    narratorVoiceMono: Float32Array,
    sampleRate: SampleRate,
    maxMidVocalCarveDb = 6.5,
  ): [Float32Array, Float32Array] {
    const { mid, side } = this.encodeStereoToMidSide(musicLeft, musicRight);
    const len = mid.length;

    const alphaLow300 = Math.exp((-2.0 * Math.PI * 300.0) / sampleRate);
    const alphaHigh3500 = Math.exp((-2.0 * Math.PI * 3500.0) / sampleRate);
    const envAttack = Math.exp(-1.0 / (0.015 * sampleRate));  // 15ms Attack
    const envRelease = Math.exp(-1.0 / (0.140 * sampleRate)); // 140ms Release

    const minCarveGainLin = Math.pow(10, -Math.abs(maxMidVocalCarveDb) / 20.0);

    let lp300 = 0;
    let lp3500 = 0;
    let voiceEnv = 0;

    for (let i = 0; i < len; i++) {
      const vAbs = i < narratorVoiceMono.length ? Math.abs(narratorVoiceMono[i]) : 0;
      if (vAbs > voiceEnv) {
        voiceEnv = envAttack * voiceEnv + (1.0 - envAttack) * vAbs;
      } else {
        voiceEnv = envRelease * voiceEnv + (1.0 - envRelease) * vAbs;
      }

      const x = mid[i];
      lp300 = (1.0 - alphaLow300) * x + alphaLow300 * lp300;
      lp3500 = (1.0 - alphaHigh3500) * x + alphaHigh3500 * lp3500;

      const bandLow = lp300;
      const bandVocalMid = lp3500 - lp300;
      const bandHighAir = x - lp3500;

      const activityFactor = Math.min(1.0, voiceEnv / 0.08);
      const dynamicMidBandGain = 1.0 - activityFactor * (1.0 - minCarveGainLin);

      mid[i] = bandLow + bandVocalMid * dynamicMidBandGain + bandHighAir;
    }

    return this.decodeMidSideToStereo(mid, side, 1.05);
  }
}
