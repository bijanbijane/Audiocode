import { SampleIndex, SampleRate } from '../contracts/timebase.contract';

/**
 * PersianAcousticSnapper (PoC #3)
 * - Automatic Room Tone extraction at Cold Start (Group A)
 * - Minimum RMS Energy Valley boundary seeking
 * - Co-articulated vowel stretch onset detection («رفتیممممم») via ZCR + RMS stability
 * - Slope-Matched Zero-Crossing snap (both splice edges share rising/falling derivative)
 * - Trailing Ezafe risk detection («پادکستِ جذاب»)
 * - Equal-Power Micro-Crossfade & Room Tone injection
 */
export class PersianAcousticSnapper {
  public static extractRoomToneProfile(
    pcmMono: Float32Array,
    sampleRate: SampleRate,
  ): { roomToneRangeSamples: [SampleIndex, SampleIndex]; noiseFloorDb: number } {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || pcmMono.length === 0) {
      return {
        roomToneRangeSamples: [0, 0],
        noiseFloorDb: -80.0,
      };
    }

    const windowSize = Math.max(1, Math.min(pcmMono.length, Math.floor(sampleRate * 0.5)));
    const hopSize = Math.max(1, Math.floor(sampleRate * 0.1));
    let bestStart = 0;
    let lowestScore = Infinity;
    let bestRms = 0.0001;

    for (let start = 0; start + windowSize <= pcmMono.length; start += hopSize) {
      let sumSq = 0;
      let peak = 0;
      for (let i = start; i < start + windowSize; i++) {
        const raw = pcmMono[i];
        const val = Number.isFinite(raw) ? Math.abs(raw) : 0;
        sumSq += val * val;
        if (val > peak) peak = val;
      }
      const rms = Math.sqrt(sumSq / windowSize);
      if (rms < 1e-5) continue;

      const crestFactor = peak / (rms + 1e-9);
      const score = rms * (1 + 0.25 * crestFactor);
      if (score < lowestScore) {
        lowestScore = score;
        bestStart = start;
        bestRms = rms;
      }
    }

    const noiseFloorDb = 20 * Math.log10(bestRms + 1e-9);
    return {
      roomToneRangeSamples: [bestStart, Math.min(pcmMono.length, bestStart + windowSize)],
      noiseFloorDb,
    };
  }

  public static findMinimumEnergySample(
    pcmMono: Float32Array,
    targetSample: SampleIndex,
    sampleRate: SampleRate,
    searchRadiusMs = 40,
  ): SampleIndex {
    if (pcmMono.length === 0) return 0;
    const clampedTarget = Math.max(
      0,
      Math.min(pcmMono.length - 1, Number.isFinite(targetSample) ? Math.floor(targetSample) : 0),
    );
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return clampedTarget;

    const safeRadiusMs = Number.isFinite(searchRadiusMs) && searchRadiusMs > 0 ? searchRadiusMs : 40;
    const radius = Math.floor((sampleRate * safeRadiusMs) / 1000);
    const frameLen = Math.max(1, Math.min(pcmMono.length, Math.floor((sampleRate * 5) / 1000)));
    const minIdx = Math.max(0, clampedTarget - radius);
    const maxIdx = Math.min(pcmMono.length - frameLen, clampedTarget + radius);

    let bestSample = clampedTarget;
    let minEnergy = Infinity;

    for (let s = minIdx; s <= maxIdx; s += Math.max(1, Math.floor(frameLen / 2))) {
      let energy = 0;
      for (let i = 0; i < frameLen; i++) {
        const raw = pcmMono[s + i];
        const v = Number.isFinite(raw) ? raw : 0;
        energy += v * v;
      }
      if (energy < minEnergy) {
        minEnergy = energy;
        bestSample = Math.min(pcmMono.length - 1, s + Math.floor(frameLen / 2));
      }
    }
    return bestSample;
  }

  public static findCoarticulatedStretchOnset(
    pcmMono: Float32Array,
    wordStartSample: SampleIndex,
    wordEndSample: SampleIndex,
    sampleRate: SampleRate,
  ): SampleIndex | null {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || pcmMono.length === 0) return null;
    const safeStart = Math.max(
      0,
      Math.min(pcmMono.length, Number.isFinite(wordStartSample) ? Math.floor(wordStartSample) : 0),
    );
    const safeEnd = Math.max(
      safeStart,
      Math.min(pcmMono.length, Number.isFinite(wordEndSample) ? Math.floor(wordEndSample) : 0),
    );

    const frameSize = Math.max(1, Math.floor((sampleRate * 15) / 1000));
    const minStretchFrames = 12;
    if (safeEnd - safeStart < frameSize * minStretchFrames) return null;

    let stableFramesCount = 0;
    let prevZcr = -1;
    let prevRms = -1;
    let stretchOnsetSample = safeEnd;

    for (let pos = safeEnd - frameSize; pos >= safeStart; pos -= frameSize) {
      let zcr = 0;
      let sumSq = 0;
      for (let i = pos + 1; i < pos + frameSize; i++) {
        const prev = Number.isFinite(pcmMono[i - 1]) ? pcmMono[i - 1] : 0;
        const curr = Number.isFinite(pcmMono[i]) ? pcmMono[i] : 0;
        if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
          zcr++;
        }
        sumSq += curr * curr;
      }
      const rms = Math.sqrt(sumSq / frameSize);

      if (prevZcr !== -1 && rms > 0.005) {
        const relZcrDiff = Math.abs(zcr - prevZcr) / (prevZcr + 1);
        const relRmsDiff = Math.abs(rms - prevRms) / (prevRms + 1e-6);

        if (relZcrDiff < 0.18 && relRmsDiff < 0.22) {
          stableFramesCount++;
          stretchOnsetSample = pos;
        } else if (stableFramesCount >= minStretchFrames) {
          break;
        } else {
          stableFramesCount = 0;
        }
      }
      prevZcr = zcr;
      prevRms = rms;
    }

    return stableFramesCount >= minStretchFrames ? stretchOnsetSample : null;
  }

  /**
   * Slope-Matched Zero-Crossing: locks cut edges to crossings with matching wave derivative sign
   * so the spliced waveform has no kink or derivative discontinuity.
   */
  public static snapToZeroCrossing(
    pcmMono: Float32Array,
    targetSample: SampleIndex,
    sampleRate: SampleRate,
    requireRisingSlope = true,
  ): SampleIndex {
    if (pcmMono.length === 0) return 0;
    const clampedTarget = Math.max(
      0,
      Math.min(pcmMono.length - 1, Number.isFinite(targetSample) ? Math.floor(targetSample) : 0),
    );
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return clampedTarget;

    const maxSearch = Math.max(1, Math.floor((sampleRate * 8) / 1000));
    for (let offset = 0; offset < maxSearch; offset++) {
      for (const dir of [1, -1]) {
        const idx = clampedTarget + offset * dir;
        if (idx <= 0 || idx >= pcmMono.length) continue;

        const prev = pcmMono[idx - 1];
        const curr = pcmMono[idx];
        if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
        const isRising = prev < 0 && curr >= 0;
        const isFalling = prev > 0 && curr <= 0;

        if ((requireRisingSlope && isRising) || (!requireRisingSlope && isFalling)) {
          return idx;
        }
      }
    }
    return clampedTarget;
  }

  public static detectTrailingEzafeRisk(
    precedingWordText: string,
    deletedWordText: string,
    precedingWordTailDurationMs: number,
  ): boolean {
    const nonEzafeWords = new Set(['و', 'یا', 'که', 'از', 'به', 'در', 'با', 'برای', 'تا', 'اما', 'چون']);
    if (nonEzafeWords.has(precedingWordText.trim())) return false;
    const isFiller = /^(ا+م+|ا+ه+|ی+ع+نی|ب+ه+ اصطلاح)$/.test(deletedWordText.trim());
    return isFiller || (Number.isFinite(precedingWordTailDurationMs) && precedingWordTailDurationMs > 65);
  }

  public static applySeamlessSplice(
    leftSegment: Float32Array,
    rightSegment: Float32Array,
    roomToneBuffer: Float32Array,
    sampleRate: SampleRate,
    crossfadeMs = 10,
    roomTonePadMs = 0,
  ): Float32Array {
    const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const safeCrossfadeMs =
      Number.isFinite(crossfadeMs) && crossfadeMs > 0 ? crossfadeMs : 0;
    const safeRoomTonePadMs =
      Number.isFinite(roomTonePadMs) && roomTonePadMs > 0 ? roomTonePadMs : 0;

    const fadeSamples = Math.max(
      0,
      Math.min(
        Math.floor((safeSampleRate * safeCrossfadeMs) / 1000),
        Math.floor(leftSegment.length / 2),
        Math.floor(rightSegment.length / 2),
      ),
    );
    const padSamples = Math.max(0, Math.floor((safeSampleRate * safeRoomTonePadMs) / 1000));

    if (padSamples === 0) {
      const totalLength = leftSegment.length + rightSegment.length - fadeSamples;
      const output = new Float32Array(totalLength);
      const keepLeft = leftSegment.length - fadeSamples;
      output.set(leftSegment.subarray(0, keepLeft), 0);

      for (let i = 0; i < fadeSamples; i++) {
        const phase = (i / fadeSamples) * (Math.PI / 2);
        const l = Number.isFinite(leftSegment[keepLeft + i]) ? leftSegment[keepLeft + i] : 0;
        const r = Number.isFinite(rightSegment[i]) ? rightSegment[i] : 0;
        output[keepLeft + i] = l * Math.cos(phase) + r * Math.sin(phase);
      }

      output.set(rightSegment.subarray(fadeSamples), keepLeft + fadeSamples);
      return output;
    }

    const rtLen = roomToneBuffer.length;
    const readRoomTone = (idx: number): number => {
      if (rtLen === 0) return 0;
      const sample = roomToneBuffer[idx % rtLen];
      return Number.isFinite(sample) ? sample : 0;
    };

    const effectivePad = Math.max(fadeSamples, padSamples);
    const totalLength = leftSegment.length + effectivePad + rightSegment.length - fadeSamples;
    const output = new Float32Array(totalLength);
    const keepLeft = leftSegment.length - fadeSamples;
    output.set(leftSegment.subarray(0, keepLeft), 0);

    for (let i = 0; i < fadeSamples; i++) {
      const phase = (i / fadeSamples) * (Math.PI / 2);
      const l = Number.isFinite(leftSegment[keepLeft + i]) ? leftSegment[keepLeft + i] : 0;
      output[keepLeft + i] = l * Math.cos(phase) + readRoomTone(i) * Math.sin(phase);
    }

    const padBody = effectivePad - fadeSamples;
    for (let i = 0; i < padBody; i++) {
      output[keepLeft + fadeSamples + i] = readRoomTone(fadeSamples + i);
    }

    const rightTransitionOffset = keepLeft + fadeSamples + padBody;
    for (let i = 0; i < fadeSamples; i++) {
      const phase = (i / fadeSamples) * (Math.PI / 2);
      const r = Number.isFinite(rightSegment[i]) ? rightSegment[i] : 0;
      output[rightTransitionOffset + i] =
        readRoomTone(fadeSamples + padBody + i) * Math.cos(phase) + r * Math.sin(phase);
    }

    output.set(rightSegment.subarray(fadeSamples), rightTransitionOffset + fadeSamples);
    return output;
  }
}
