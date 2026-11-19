import { SampleRate } from '../../../src/contracts/timebase.contract';

export interface FourBandSpectralProfile {
  readonly lowBodyRms: number;        // 80Hz - 280Hz (fundamental pitch body)
  readonly warmthMidRms: number;      // 280Hz - 1000Hz (Persian vowel warmth)
  readonly presenceFormantRms: number; // 1kHz - 4kHz (consonant & formant clarity)
  readonly airSibilanceRms: number;   // 4kHz - 10kHz (breath & sibilance)
  readonly overallRms: number;
}

/**
 * Punch-In Voice Spectral Matcher & Group-C Synthetic Provenance Watermark Engine
 * (Architecture Doc Sections 8, 35 Group C, and 36)
 * 1. Matches 4-band spectral EQ profile of a re-recorded punch-in clip to the studio reference
 *    and blends subtle studio Room Tone underneath.
 * 2. Embeds and detects an inaudible 19 kHz (-66 dBFS) BPSK spread-spectrum watermark on
 *    AI-reconstructed speech segments to preserve provenance and prevent voice spoofing.
 */
export class SpeechReconstructionAndWatermarkEngine {
  /**
   * Matches spectral color across 4 vocal bands (clipped safely to [-8dB, +8dB]) and injects studio Room Tone.
   */
  public static matchPunchInClipToStudioContext(
    referenceStudioVoice: Float32Array,
    punchInReplacementClip: Float32Array,
    studioRoomToneBuffer: Float32Array,
    sampleRate: SampleRate,
  ): {
    matchedClipPcm: Float32Array;
    appliedBandGainsDb: [number, number, number, number];
  } {
    const len = punchInReplacementClip.length;
    if (len === 0) {
      return {
        matchedClipPcm: new Float32Array(0),
        appliedBandGainsDb: [0, 0, 0, 0],
      };
    }

    if (referenceStudioVoice.length === 0) {
      const copy = new Float32Array(punchInReplacementClip);
      return {
        matchedClipPcm: copy,
        appliedBandGainsDb: [0, 0, 0, 0],
      };
    }

    const refProfile = this.analyzeFourBandProfile(referenceStudioVoice, sampleRate);
    const punchProfile = this.analyzeFourBandProfile(punchInReplacementClip, sampleRate);

    const clampDb = (ratioLin: number): number => {
      const db = 20 * Math.log10(Math.max(0.1, Math.min(10.0, ratioLin)));
      return Math.max(-8.0, Math.min(8.0, db));
    };

    const gLowDb = clampDb(refProfile.lowBodyRms / (punchProfile.lowBodyRms + 1e-8));
    const gMidDb = clampDb(refProfile.warmthMidRms / (punchProfile.warmthMidRms + 1e-8));
    const gPresDb = clampDb(
      refProfile.presenceFormantRms / (punchProfile.presenceFormantRms + 1e-8),
    );
    const gAirDb = clampDb(refProfile.airSibilanceRms / (punchProfile.airSibilanceRms + 1e-8));

    const gLowLin = Math.pow(10, gLowDb / 20.0);
    const gMidLin = Math.pow(10, gMidDb / 20.0);
    const gPresLin = Math.pow(10, gPresDb / 20.0);
    const gAirLin = Math.pow(10, gAirDb / 20.0);

    const bands = this.splitIntoFourBands(punchInReplacementClip, sampleRate);
    const matchedClipPcm = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      const reconstructedVoice =
        bands.low[i] * gLowLin +
        bands.mid[i] * gMidLin +
        bands.presence[i] * gPresLin +
        bands.air[i] * gAirLin;

      const roomToneRaw =
        studioRoomToneBuffer.length > 0
          ? studioRoomToneBuffer[i % studioRoomToneBuffer.length]
          : 0;
      const roomToneSample = Number.isFinite(roomToneRaw) ? roomToneRaw * 0.35 : 0;

      matchedClipPcm[i] = Math.max(-0.99, Math.min(0.99, reconstructedVoice + roomToneSample));
    }

    return {
      matchedClipPcm,
      appliedBandGainsDb: [
        Number(gLowDb.toFixed(2)),
        Number(gMidDb.toFixed(2)),
        Number(gPresDb.toFixed(2)),
        Number(gAirDb.toFixed(2)),
      ],
    };
  }

  /**
   * Injects an inaudible 19 kHz (-66 dBFS) BPSK spread-spectrum provenance watermark in-place.
   */
  public static embedSyntheticProvenanceWatermarkInPlace(
    pcm: Float32Array,
    sampleRate: SampleRate,
    provenanceSeed = 0x5a3c9f11,
  ): void {
    if (!Number.isFinite(sampleRate) || sampleRate < 44100 || pcm.length < 256) return;

    const carrierHz = 19000.0;
    const amplitude = Math.pow(10, -66.0 / 20.0); // -66 dBFS
    let lfsr = (provenanceSeed >>> 0) || 1;

    for (let i = 0; i < pcm.length; i++) {
      if ((i & 63) === 0) {
        lfsr ^= lfsr << 13;
        lfsr ^= lfsr >>> 17;
        lfsr ^= lfsr << 5;
      }
      const chipSign = (lfsr & 1) === 1 ? 1.0 : -1.0;
      const carrier = Math.sin((2.0 * Math.PI * carrierHz * i) / sampleRate);
      const baseSample = Number.isFinite(pcm[i]) ? pcm[i] : 0;
      pcm[i] = Math.max(-1.0, Math.min(1.0, baseSample + chipSign * carrier * amplitude));
    }
  }

  /**
   * Detects Group-C spread-spectrum provenance watermark using a synchronous Matched Filter
   * preceded by an identical 4th-order 16.5 kHz High-Pass Filter on both input PCM and template
   * so vocal frequencies (80Hz - 10kHz) cannot leak into the -66 dBFS 19 kHz detector.
   */
  public static detectSyntheticProvenanceWatermark(
    pcm: Float32Array,
    sampleRate: SampleRate,
    provenanceSeed = 0x5a3c9f11,
  ): { isWatermarked: boolean; correlationConfidence: number } {
    if (!Number.isFinite(sampleRate) || sampleRate < 44100 || pcm.length < 256) {
      return { isWatermarked: false, correlationConfidence: 0 };
    }

    const cutoffHz = Math.min(16500, sampleRate * 0.37);
    const w0 = (2.0 * Math.PI * cutoffHz) / sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / Math.SQRT2;
    const a0 = 1.0 + alpha;
    const b0 = ((1.0 + cosW0) / 2.0) / a0;
    const b1 = -(1.0 + cosW0) / a0;
    const b2 = b0;
    const a1 = (-2.0 * cosW0) / a0;
    const a2 = (1.0 - alpha) / a0;

    // Two cascaded biquad states for input PCM and two for the BPSK template
    let px1_1 = 0, px1_2 = 0, py1_1 = 0, py1_2 = 0;
    let px2_1 = 0, px2_2 = 0, py2_1 = 0, py2_2 = 0;
    let tx1_1 = 0, tx1_2 = 0, ty1_1 = 0, ty1_2 = 0;
    let tx2_1 = 0, tx2_2 = 0, ty2_1 = 0, ty2_2 = 0;

    const carrierHz = 19000.0;
    let lfsr = (provenanceSeed >>> 0) || 1;
    let correlationSum = 0;
    let referenceEnergy = 0;

    for (let i = 0; i < pcm.length; i++) {
      if ((i & 63) === 0) {
        lfsr ^= lfsr << 13;
        lfsr ^= lfsr >>> 17;
        lfsr ^= lfsr << 5;
      }
      const chipSign = (lfsr & 1) === 1 ? 1.0 : -1.0;
      const rawTemplate = chipSign * Math.sin((2.0 * Math.PI * carrierHz * i) / sampleRate);
      const rawPcm = Number.isFinite(pcm[i]) ? pcm[i] : 0;

      // Stage 1 + Stage 2 HPF on PCM
      const hp1Pcm = b0 * rawPcm + b1 * px1_1 + b2 * px1_2 - a1 * py1_1 - a2 * py1_2;
      px1_2 = px1_1; px1_1 = rawPcm; py1_2 = py1_1; py1_1 = hp1Pcm;
      const hp2Pcm = b0 * hp1Pcm + b1 * px2_1 + b2 * px2_2 - a1 * py2_1 - a2 * py2_2;
      px2_2 = px2_1; px2_1 = hp1Pcm; py2_2 = py2_1; py2_1 = hp2Pcm;

      // Identical Stage 1 + Stage 2 HPF on Template
      const hp1Tmpl = b0 * rawTemplate + b1 * tx1_1 + b2 * tx1_2 - a1 * ty1_1 - a2 * ty1_2;
      tx1_2 = tx1_1; tx1_1 = rawTemplate; ty1_2 = ty1_1; ty1_1 = hp1Tmpl;
      const hp2Tmpl = b0 * hp1Tmpl + b1 * tx2_1 + b2 * tx2_2 - a1 * ty2_1 - a2 * ty2_2;
      tx2_2 = tx2_1; tx2_1 = hp1Tmpl; ty2_2 = ty2_1; ty2_1 = hp2Tmpl;

      if (i >= 32) {
        correlationSum += hp2Pcm * hp2Tmpl;
        referenceEnergy += hp2Tmpl * hp2Tmpl;
      }
    }

    const normalizedMetric = Math.abs(correlationSum) / (referenceEnergy + 1e-12);
    const expectedAmplitude = Math.pow(10, -66.0 / 20.0);
    const ratio = normalizedMetric / expectedAmplitude;

    return {
      isWatermarked: ratio >= 0.45,
      correlationConfidence: Number(Math.min(0.99, ratio).toFixed(2)),
    };
  }

  public static analyzeFourBandProfile(
    pcm: Float32Array,
    sampleRate: SampleRate,
  ): FourBandSpectralProfile {
    const bands = this.splitIntoFourBands(pcm, sampleRate);
    const rms = (arr: Float32Array): number => {
      if (arr.length === 0) return 0;
      let s = 0;
      for (let i = 0; i < arr.length; i++) {
        const v = Number.isFinite(arr[i]) ? arr[i] : 0;
        s += v * v;
      }
      return Math.sqrt(s / arr.length);
    };

    return {
      lowBodyRms: rms(bands.low),
      warmthMidRms: rms(bands.mid),
      presenceFormantRms: rms(bands.presence),
      airSibilanceRms: rms(bands.air),
      overallRms: rms(pcm),
    };
  }

  private static splitIntoFourBands(
    pcm: Float32Array,
    sampleRate: SampleRate,
  ): {
    low: Float32Array;
    mid: Float32Array;
    presence: Float32Array;
    air: Float32Array;
  } {
    const len = pcm.length;
    const low = new Float32Array(len);
    const mid = new Float32Array(len);
    const presence = new Float32Array(len);
    const air = new Float32Array(len);

    const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const a280 = Math.exp((-2.0 * Math.PI * 280.0) / safeRate);
    const a1000 = Math.exp((-2.0 * Math.PI * 1000.0) / safeRate);
    const a4000 = Math.exp((-2.0 * Math.PI * 4000.0) / safeRate);

    let lp280 = 0;
    let lp1000 = 0;
    let lp4000 = 0;

    for (let i = 0; i < len; i++) {
      const x = Number.isFinite(pcm[i]) ? pcm[i] : 0;
      lp280 = (1.0 - a280) * x + a280 * lp280;
      lp1000 = (1.0 - a1000) * x + a1000 * lp1000;
      lp4000 = (1.0 - a4000) * x + a4000 * lp4000;

      low[i] = lp280;
      mid[i] = lp1000 - lp280;
      presence[i] = lp4000 - lp1000;
      air[i] = x - lp4000;
    }

    return { low, mid, presence, air };
  }
}
