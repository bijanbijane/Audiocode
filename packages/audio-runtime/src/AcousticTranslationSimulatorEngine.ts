import { SampleRate } from '../../../src/contracts/timebase.contract';

export type ListeningEnvironmentProfile =
  | 'STUDIO_FLAT_BYPASS'       // صدای مرجع استودیویی بدون تغییر
  | 'SMARTPHONE_MONO_SPEAKER'  // اسپیکر موبایل (جمع مونو + حذف بم زیر 320Hz + رزونانس 2.2kHz)
  | 'CAR_CABIN_IN_TRAFFIC'     // خودرو در حرکت (تقویت بم 130Hz + نویز پوشاننده جاده در -38dBFS)
  | 'LAPTOP_SMALL_SPEAKERS';   // اسپیکر لپ‌تاپ (برش زیر 210Hz)

/**
 * Real-World Listening Environment Acoustic Translation Simulator
 * (Architecture Doc Sections 2.4 & 2.6)
 * Allows Persian podcast/audiobook editors to audition how speech intelligibility
 * translates across smartphone mono speakers, car cabins in traffic, and laptop speakers
 * prior to final mastering export.
 */
export class AcousticTranslationSimulatorEngine {
  /**
   * Simulates real-world playback environments on a stereo audio buffer.
   */
  public static simulateListeningEnvironment(
    stereoInput: [Float32Array, Float32Array],
    sampleRate: SampleRate,
    profile: ListeningEnvironmentProfile,
  ): [Float32Array, Float32Array] {
    const [inL, inR] = stereoInput;
    const len = Math.min(inL.length, inR.length);

    if (profile === 'STUDIO_FLAT_BYPASS' || len === 0) {
      return [new Float32Array(inL), new Float32Array(inR)];
    }

    if (profile === 'SMARTPHONE_MONO_SPEAKER') {
      // 1. Sum to mono
      const mono = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        mono[i] = (inL[i] + inR[i]) * 0.5;
      }

      // 2. High-pass at 320Hz (micro-transducer bass roll-off)
      const afterHp = this.applyOnePoleHighPass(mono, sampleRate, 320.0);
      // 3. Low-pass at 8500Hz and chassis resonance boost around 1800-2800Hz
      const afterLp = this.applyOnePoleLowPass(afterHp, sampleRate, 8500.0);
      const midBoost = this.applyOnePoleBandPass(afterLp, sampleRate, 1800.0, 2800.0);

      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = Math.max(-0.99, Math.min(0.99, afterLp[i] * 0.8 + midBoost[i] * 0.45));
      }
      return [out, new Float32Array(out)];
    }

    if (profile === 'LAPTOP_SMALL_SPEAKERS') {
      const outL = this.applyOnePoleHighPass(inL, sampleRate, 210.0);
      const outR = this.applyOnePoleHighPass(inR, sampleRate, 210.0);
      return [outL, outR];
    }

    // CAR_CABIN_IN_TRAFFIC: cabin low-end boost + deterministic low-frequency road masking floor (-38dBFS)
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    const lowCabL = this.applyOnePoleLowPass(inL, sampleRate, 130.0);
    const lowCabR = this.applyOnePoleLowPass(inR, sampleRate, 130.0);

    let roadRumbleState = 0;
    const rumbleAlpha = Math.exp((-2.0 * Math.PI * 140.0) / sampleRate);
    const rumbleAmp = Math.pow(10, -38.0 / 20.0);

    for (let i = 0; i < len; i++) {
      const white = ((Math.sin(i * 12.9898) * 43758.5453) % 1.0) - 0.5;
      roadRumbleState = (1.0 - rumbleAlpha) * white + rumbleAlpha * roadRumbleState;
      const rumble = roadRumbleState * rumbleAmp * 3.0;

      outL[i] = Math.max(-0.99, Math.min(0.99, inL[i] * 0.85 + lowCabL[i] * 0.35 + rumble));
      outR[i] = Math.max(-0.99, Math.min(0.99, inR[i] * 0.85 + lowCabR[i] * 0.35 + rumble));
    }

    return [outL, outR];
  }

  private static applyOnePoleHighPass(
    input: Float32Array,
    sampleRate: SampleRate,
    cutoffHz: number,
  ): Float32Array {
    const out = new Float32Array(input.length);
    const rc = 1.0 / (2.0 * Math.PI * cutoffHz);
    const dt = 1.0 / sampleRate;
    const alpha = rc / (rc + dt);

    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = alpha * (prevOut + x - prevIn);
      out[i] = y;
      prevIn = x;
      prevOut = y;
    }
    return out;
  }

  private static applyOnePoleLowPass(
    input: Float32Array,
    sampleRate: SampleRate,
    cutoffHz: number,
  ): Float32Array {
    const out = new Float32Array(input.length);
    const alpha = Math.exp((-2.0 * Math.PI * cutoffHz) / sampleRate);
    let state = 0;
    for (let i = 0; i < input.length; i++) {
      state = (1.0 - alpha) * input[i] + alpha * state;
      out[i] = state;
    }
    return out;
  }

  private static applyOnePoleBandPass(
    input: Float32Array,
    sampleRate: SampleRate,
    lowCutHz: number,
    highCutHz: number,
  ): Float32Array {
    const hp = this.applyOnePoleHighPass(input, sampleRate, lowCutHz);
    return this.applyOnePoleLowPass(hp, sampleRate, highCutHz);
  }
}
