import { TimeMath, TimeRange } from '../../contracts/timebase.contract';

export type PreAsrWindowClassification =
  | 'SPEECH_CANDIDATE'
  | 'PURE_MUSIC_OR_JINGLE'
  | 'SILENCE_OR_AMBIENCE';

export interface ClassifiedAudioRegion {
  readonly classification: PreAsrWindowClassification;
  readonly range: TimeRange;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly syllableModulationIndex: number;
  readonly zcrStdDev: number;
}

/**
 * Section 132: Pre-ASR Intro/Outro Music & Jingle Boundary Filter
 * Separates sustained intro/outro music pads from syllable-modulated speech (3-6Hz envelope modulation + ZCR variance)
 * so ASR models do not hallucinate Persian words over musical intros.
 */
export class PreAsrMusicAndJingleBoundaryFilter {
  private static readonly SAMPLE_RATE = 16000;

  public static classifyAudioRegionsBeforeAsr(
    pcm16kMono: Float32Array,
    windowDurationSec: number = 1.0,
  ): ClassifiedAudioRegion[] {
    const winSamples = Math.floor(this.SAMPLE_RATE * windowDurationSec);
    const subFrameSamples = Math.floor(this.SAMPLE_RATE * 0.025); // 25ms sub-frames (40 sub-frames/sec)
    const regions: ClassifiedAudioRegion[] = [];

    for (
      let start = 0;
      start + subFrameSamples * 4 <= pcm16kMono.length;
      start += winSamples
    ) {
      const end = Math.min(pcm16kMono.length, start + winSamples);
      const subEnergies: number[] = [];
      const subZcrs: number[] = [];

      for (let pos = start; pos + subFrameSamples <= end; pos += subFrameSamples) {
        let sumSq = 0;
        let zcr = 0;
        for (let i = pos; i < pos + subFrameSamples; i++) {
          const s = pcm16kMono[i];
          sumSq += s * s;
          if (
            i > pos &&
            ((pcm16kMono[i - 1] >= 0 && s < 0) || (pcm16kMono[i - 1] < 0 && s >= 0))
          ) {
            zcr++;
          }
        }
        subEnergies.push(Math.sqrt(sumSq / subFrameSamples));
        subZcrs.push(zcr / subFrameSamples);
      }

      const meanRms =
        subEnergies.reduce((a, b) => a + b, 0) / Math.max(1, subEnergies.length);
      const meanDb = 20 * Math.log10(meanRms + 1e-9);

      let classification: PreAsrWindowClassification;
      let syllableModulationIndex = 0;
      let zcrStdDev = 0;

      if (meanDb < -45.0) {
        classification = 'SILENCE_OR_AMBIENCE';
      } else {
        const rmsVar =
          subEnergies.reduce((acc, e) => acc + (e - meanRms) * (e - meanRms), 0) /
          subEnergies.length;
        syllableModulationIndex = Math.sqrt(rmsVar) / (meanRms + 1e-9);

        const meanZcr = subZcrs.reduce((a, b) => a + b, 0) / subZcrs.length;
        const zcrVar =
          subZcrs.reduce((acc, z) => acc + (z - meanZcr) * (z - meanZcr), 0) /
          subZcrs.length;
        zcrStdDev = Math.sqrt(zcrVar);

        if (syllableModulationIndex < 0.28 && zcrStdDev < 0.035) {
          classification = 'PURE_MUSIC_OR_JINGLE';
        } else {
          classification = 'SPEECH_CANDIDATE';
        }
      }

      regions.push({
        classification,
        range: {
          start: TimeMath.samplesToFlicks(start, 16000),
          end: TimeMath.samplesToFlicks(end, 16000),
        },
        startSample16k: start,
        endSample16k: end,
        syllableModulationIndex: Number(syllableModulationIndex.toFixed(3)),
        zcrStdDev: Number(zcrStdDev.toFixed(4)),
      });
    }

    return this.mergeAdjacentRegions(regions);
  }

  private static mergeAdjacentRegions(
    regions: ClassifiedAudioRegion[],
  ): ClassifiedAudioRegion[] {
    if (regions.length <= 1) return regions;
    const merged: ClassifiedAudioRegion[] = [regions[0]];

    for (let i = 1; i < regions.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = regions[i];
      if (prev.classification === curr.classification) {
        merged[merged.length - 1] = {
          ...prev,
          endSample16k: curr.endSample16k,
          range: { start: prev.range.start, end: curr.range.end },
          syllableModulationIndex: Number(
            ((prev.syllableModulationIndex + curr.syllableModulationIndex) / 2).toFixed(
              3,
            ),
          ),
          zcrStdDev: Number(((prev.zcrStdDev + curr.zcrStdDev) / 2).toFixed(4)),
        };
      } else {
        merged.push(curr);
      }
    }
    return merged;
  }
}
