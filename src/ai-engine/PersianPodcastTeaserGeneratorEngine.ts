import { TimedPersianToken } from './PersianTextNormalizer';
import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';

export interface PodcastTeaserHookSegment {
  readonly hookId: string;
  readonly rank: number;
  readonly audioRange: TimeRange;
  readonly durationSeconds: number;
  readonly transcriptExcerptFa: string;
  readonly acousticExcitementScore: number;
  readonly rhetoricalHookScore: number;
  readonly combinedTeaserScore: number;
}

/**
 * Persian Podcast Cold-Open Teaser & Highlight Hook Generator
 * (Architecture Doc Section 2.6)
 * Scans a full Persian episode for 10s-18s segments combining high acoustic dynamic
 * excitement with Persian rhetorical curiosity hooks («بزرگ‌ترین اشتباه», «نکته عجیب»,
 * «رازی که», «هیچ‌کس فکر نمی‌کرد») separated by at least 60 seconds.
 */
export class PersianPodcastTeaserGeneratorEngine {
  private static readonly PERSIAN_HOOK_PHRASES = [
    'بزرگترین اشتباه',
    'بزرگ‌ترین اشتباه',
    'نکته عجیب',
    'جالبه بدونید',
    'رازی که',
    'هیچکس فکر نمیکرد',
    'هیچ‌کس فکر نمی‌کرد',
    'اولین باره که',
    'واقعیت اینه که',
    'ترسناکترین',
    'ترسناک‌ترین',
    'مهمترین درس',
    'مهم‌ترین درس',
    'نقطه عطف',
    'شکست خوردم',
    'چالش اصلی',
  ];

  /**
   * Extracts top cold-open teaser hook segments from an episode.
   */
  public static findBestColdOpenTeaserHooks(
    tokens: readonly TimedPersianToken[],
    pcmMono: Float32Array,
    sampleRate: SampleRate,
    maxHooksCount = 3,
  ): PodcastTeaserHookSegment[] {
    if (tokens.length < 15 || pcmMono.length === 0) return [];

    const candidateSegments = this.buildCandidateHookSegments(tokens, 10.0, 18.0);
    if (candidateSegments.length === 0) return [];

    const globalRms = this.computeSliceRms(pcmMono, 0, pcmMono.length);

    const scoredHooks: PodcastTeaserHookSegment[] = candidateSegments.map(
      (seg, idx) => {
        const startSample = TimeMath.flicksToSamplesFloor(seg.range.start, sampleRate);
        const endSample = Math.min(
          pcmMono.length,
          TimeMath.flicksToSamplesFloor(seg.range.end, sampleRate),
        );

        const segRms = this.computeSliceRms(pcmMono, startSample, endSample);
        const dynamicContrast = this.computeDynamicEnvelopeContrast(
          pcmMono,
          startSample,
          endSample,
          sampleRate,
        );
        const acousticScore = Math.min(
          1.0,
          0.6 * (segRms / (globalRms + 1e-6)) + 0.4 * dynamicContrast,
        );

        const rhetoricalScore = this.computePersianRhetoricalScore(seg.textFa);

        const combined = 0.45 * acousticScore + 0.55 * rhetoricalScore;
        const durSec = TimeMath.flicksToSeconds(seg.range.end - seg.range.start);

        return {
          hookId: `hook_${idx}_${seg.range.start}`,
          rank: 0,
          audioRange: seg.range,
          durationSeconds: Number(durSec.toFixed(2)),
          transcriptExcerptFa: seg.textFa,
          acousticExcitementScore: Number(acousticScore.toFixed(2)),
          rhetoricalHookScore: Number(rhetoricalScore.toFixed(2)),
          combinedTeaserScore: Number(combined.toFixed(3)),
        };
      },
    );

    const sortedByScore = scoredHooks.sort(
      (a, b) => b.combinedTeaserScore - a.combinedTeaserScore,
    );
    const chosen: PodcastTeaserHookSegment[] = [];
    const minSeparationFlicks = TimeMath.secondsToFlicks(60.0);

    for (const cand of sortedByScore) {
      if (chosen.length >= maxHooksCount) break;
      const tooClose = chosen.some(
        (existing) =>
          Math.abs(existing.audioRange.start - cand.audioRange.start) <
          minSeparationFlicks,
      );
      if (!tooClose) {
        chosen.push({ ...cand, rank: chosen.length + 1 });
      }
    }

    return chosen;
  }

  private static buildCandidateHookSegments(
    tokens: readonly TimedPersianToken[],
    minSec: number,
    maxSec: number,
  ): { range: TimeRange; textFa: string }[] {
    const segments: { range: TimeRange; textFa: string }[] = [];
    let startIdx = 0;

    while (startIdx < tokens.length) {
      const startFlicks = tokens[startIdx].range.start;
      let endIdx = startIdx;

      while (endIdx < tokens.length - 1) {
        const durSec = TimeMath.flicksToSeconds(
          tokens[endIdx].range.end - startFlicks,
        );
        if (durSec >= maxSec) break;

        const gapToNextSec = TimeMath.flicksToSeconds(
          tokens[endIdx + 1].range.start - tokens[endIdx].range.end,
        );
        if (durSec >= minSec && gapToNextSec >= 0.35) {
          break;
        }
        endIdx++;
      }

      const slice = tokens.slice(startIdx, endIdx + 1);
      const totalDur = TimeMath.flicksToSeconds(
        slice[slice.length - 1].range.end - startFlicks,
      );
      if (totalDur >= minSec && totalDur <= maxSec + 2.0) {
        segments.push({
          range: { start: startFlicks, end: slice[slice.length - 1].range.end },
          textFa: slice.map((t) => t.displayText).join(' '),
        });
      }

      startIdx = Math.max(startIdx + 5, endIdx + 1);
    }

    return segments;
  }

  private static computePersianRhetoricalScore(textFa: string): number {
    let score = 0.35;
    for (const phrase of this.PERSIAN_HOOK_PHRASES) {
      if (textFa.includes(phrase)) {
        score += 0.3;
      }
    }
    if (textFa.includes('؟') || textFa.includes('چرا') || textFa.includes('چطور')) {
      score += 0.2;
    }
    return Math.min(1.0, score);
  }

  private static computeSliceRms(
    pcm: Float32Array,
    start: number,
    end: number,
  ): number {
    const count = Math.max(1, end - start);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      sumSq += pcm[i] * pcm[i];
    }
    return Math.sqrt(sumSq / count);
  }

  private static computeDynamicEnvelopeContrast(
    pcm: Float32Array,
    start: number,
    end: number,
    sampleRate: SampleRate,
  ): number {
    const step = Math.floor(sampleRate * 0.1);
    const envValues: number[] = [];
    for (let pos = start; pos + step <= end; pos += step) {
      envValues.push(this.computeSliceRms(pcm, pos, pos + step));
    }
    if (envValues.length < 2) return 0.5;
    const maxE = Math.max(...envValues);
    const minE = Math.min(...envValues);
    return Math.min(1.0, (maxE - minE) / (maxE + 1e-6));
  }
}
