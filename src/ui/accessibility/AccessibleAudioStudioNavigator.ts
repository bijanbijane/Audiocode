import {
  AIRecommendationRecord,
  TimelineClip,
} from '../../contracts/project-schema.contract';
import { Flicks, SampleRate, TimeMath } from '../../contracts/timebase.contract';
import { TimedPersianToken } from '../../ai-engine/PersianTextNormalizer';

export interface AriaLiveAnnouncement {
  readonly politeness: 'polite' | 'assertive';
  readonly messageFa: string;
  readonly focusedTimeFlicks: Flicks;
  /** 60ms-80ms acoustic grain range for screen-reader scrubbing audition */
  readonly acousticScrubGrainRange: { startSample: number; frameCount: number };
}

/**
 * Screen-Reader & Acoustic Scrubbing Accessibility Navigator (Architecture Doc Sections 50 & 51)
 * Builds a virtual semantic ARIA timeline navigation controller with 60ms acoustic grain
 * scrubbing so blind and low-vision Persian audio editors (NVDA / VoiceOver) can navigate
 * word-by-word, clip-by-clip, and disfluency-by-disfluency inside the Canvas studio.
 */
export class AccessibleAudioStudioNavigator {
  private currentTokenCursor = 0;
  private currentRecommendationCursor = 0;

  /**
   * 1. Navigates word-by-word via keyboard for screen-reader users (NVDA / VoiceOver)
   * and returns a Persian ARIA announcement plus a 60ms acoustic scrubbing grain window.
   */
  public navigateTokensByStep(
    tokens: readonly TimedPersianToken[],
    stepDelta: -1 | 1,
    sampleRate: SampleRate,
  ): AriaLiveAnnouncement | null {
    if (tokens.length === 0) return null;

    this.currentTokenCursor = Math.max(
      0,
      Math.min(tokens.length - 1, this.currentTokenCursor + stepDelta),
    );
    const tok = tokens[this.currentTokenCursor];
    const startSec = TimeMath.flicksToSeconds(tok.range.start).toFixed(2);
    const confPct = Math.round(tok.confidence * 100);

    const startSample = TimeMath.flicksToSamplesFloor(tok.range.start, sampleRate);
    const grainFrames = Math.floor(sampleRate * 0.06); // 60ms Acoustic Scrubbing Grain

    return {
      politeness: 'polite',
      messageFa: `کلمه «${tok.displayText}»، ثانیه ${startSec}، اطمینان ${confPct} درصد.`,
      focusedTimeFlicks: tok.range.start,
      acousticScrubGrainRange: {
        startSample,
        frameCount: grainFrames,
      },
    };
  }

  /**
   * 2. Jumps directly between pending smart recommendations with full Persian ARIA context.
   */
  public navigatePendingRecommendations(
    recommendations: readonly AIRecommendationRecord[],
    stepDelta: -1 | 1,
    sampleRate: SampleRate,
  ): {
    announcement: AriaLiveAnnouncement;
    selectedRecommendation: AIRecommendationRecord;
  } | null {
    const pending = recommendations.filter((r) => r.status === 'PENDING');
    if (pending.length === 0) return null;

    this.currentRecommendationCursor =
      (this.currentRecommendationCursor + stepDelta + pending.length) % pending.length;

    const rec = pending[this.currentRecommendationCursor];
    const range = rec.spliceDescriptor.snappedAcousticRange;
    const startSec = TimeMath.flicksToSeconds(range.start).toFixed(2);
    const durationMs = Math.round(
      TimeMath.flicksToSeconds(range.end - range.start) * 1000,
    );

    const warningNote =
      rec.spliceDescriptor.prosodicWarnings.length > 0
        ? '، دارای هشدار آوایی کسره اضافه یا همزمانی'
        : '';

    const startSample = TimeMath.flicksToSamplesFloor(range.start, sampleRate);

    return {
      selectedRecommendation: rec,
      announcement: {
        politeness: 'assertive',
        messageFa: `پیشنهاد ${this.currentRecommendationCursor + 1} از ${pending.length}: ${rec.disfluencyType} روی عبارت «${rec.associatedText}» در ثانیه ${startSec} به مدت ${durationMs} میلی‌ثانیه${warningNote}. برای شنیدن پیش‌نمایش کلید P و برای تأیید کلید Enter را بزنید.`,
        focusedTimeFlicks: range.start,
        acousticScrubGrainRange: {
          startSample,
          frameCount: Math.floor(sampleRate * 0.08),
        },
      },
    };
  }

  /**
   * 3. Builds a semantic Persian ARIA summary of track clips alongside the waveform Canvas.
   */
  public static buildAriaTrackSummary(
    trackName: string,
    clips: readonly TimelineClip[],
  ): string {
    if (clips.length === 0) return `ترک ${trackName}: بدون کلیپ صوتی.`;
    const totalEndSec = TimeMath.flicksToSeconds(
      clips[clips.length - 1].timelineRange.end,
    ).toFixed(1);
    const roomToneCount = clips.filter((c) => c.kind === 'ROOM_TONE_FILL').length;

    return `ترک ${trackName}، شامل ${clips.length} قطعه صوتی و ${roomToneCount} پیوند صدای محیط، مجموع زمان ${totalEndSec} ثانیه.`;
  }
}
