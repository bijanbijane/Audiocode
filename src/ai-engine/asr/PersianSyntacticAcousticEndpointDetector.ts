/**
 * @file src/ai-engine/asr/PersianSyntacticAcousticEndpointDetector.ts
 * @description Section 135: Live Persian Syntactic & Acoustic Utterance Endpoint Detector (EOU).
 *              Prevents mid-sentence cutoffs during Persian "که..." / "برای..." pauses while
 *              committing finished verb phrases rapidly (~380ms) by combining trailing silence,
 *              Persian SOV syntactic completeness, and terminal F0 pitch slope.
 */

export type PersianSyntacticState = 'COMPLETE_VERB_OR_CLAUSE' | 'NEUTRAL_NOMINAL' | 'INCOMPLETE_CONJUNCTION_OR_PREP';

export interface EndpointingAcousticFrame {
  /** Trailing non-speech duration accumulated since the last active speech frame (ms) */
  trailingSilenceMs: number;
  /** Total active utterance duration accumulated so far (ms) */
  utteranceDurationMs: number;
  /** Optional terminal F0 pitch contour over the last 180ms of voiced speech (Hz) */
  recentVoicedF0ContourHz?: number[];
  /** Current stabilized partial Persian transcript */
  partialPersianTranscript: string;
}

export interface EndpointingDecision {
  shouldCommitUtterance: boolean;
  syntacticState: PersianSyntacticState;
  requiredSilenceThresholdMs: number;
  terminalPitchSlopeHzPerSec: number;
  reason: 'SYNTACTIC_FAST_COMMIT' | 'STANDARD_SILENCE_COMMIT' | 'HELD_FOR_INCOMPLETE_SYNTAX' | 'MAX_DURATION_FORCE_COMMIT' | 'SPEAKING_OR_SHORT_PAUSE';
}

export class PersianSyntacticAcousticEndpointDetector {
  constructor(
    private readonly baseSilenceThresholdMs: number = 680,
    private readonly incompleteClauseSilenceMs: number = 1450
  ) {}

  /**
   * Instance helper used by WebSocketLiveAsrGateway for streaming endpoint evaluation.
   */
  public evaluateEndOfUtterance(params: {
    trailingSilenceMs: number;
    recentRecognizedWords: string[];
    recentVoicedF0ContourHz?: number[];
  }): {
    decision: 'UTTERANCE_ENDPOINT_REACHED' | 'HOLD_UTTERANCE_OPEN';
    reasonTag: string;
    requiredSilenceMs: number;
  } {
    const partialPersianTranscript = params.recentRecognizedWords.join(' ');
    const syntacticState = PersianSyntacticAcousticEndpointDetector.classifyTrailingPersianSyntax(
      partialPersianTranscript
    );
    const pitchSlope = PersianSyntacticAcousticEndpointDetector.computeTerminalPitchSlopeHzPerSec(
      params.recentVoicedF0ContourHz
    );

    let requiredSilenceMs = this.baseSilenceThresholdMs;
    if (syntacticState === 'COMPLETE_VERB_OR_CLAUSE') {
      requiredSilenceMs = pitchSlope < -25 ? 360 : 450;
    } else if (syntacticState === 'INCOMPLETE_CONJUNCTION_OR_PREP') {
      requiredSilenceMs = this.incompleteClauseSilenceMs;
    }

    if (params.trailingSilenceMs >= requiredSilenceMs) {
      return {
        decision: 'UTTERANCE_ENDPOINT_REACHED',
        reasonTag:
          syntacticState === 'COMPLETE_VERB_OR_CLAUSE'
            ? 'SYNTACTIC_FAST_COMMIT'
            : 'STANDARD_SILENCE_COMMIT',
        requiredSilenceMs,
      };
    }

    return {
      decision: 'HOLD_UTTERANCE_OPEN',
      reasonTag:
        syntacticState === 'INCOMPLETE_CONJUNCTION_OR_PREP'
          ? 'HELD_FOR_INCOMPLETE_SYNTAX'
          : 'SPEAKING_OR_SHORT_PAUSE',
      requiredSilenceMs,
    };
  }

  /**
   * Persian tokens that strongly indicate the speaker is mid-clause (hesitation pause).
   * Includes subordinating conjunctions, prepositions, and ezafe/conjunction markers.
   */
  private static readonly INCOMPLETE_TRAILING_TOKENS = new Set<string>([
    'که', 'و', 'یا', 'اما', 'ولی', 'چون', 'زیرا', 'اگر', 'هرچند',
    'برای', 'در', 'به', 'از', 'با', 'تا', 'بر', 'بدون', 'درباره', 'مورد',
    'اینکه', 'آنکه', 'وقتی', 'هنگامی', 'چنانچه', 'لذا', 'بنابراین'
  ]);

  /**
   * Persian sentence-final verbs, copulas, and common SOV past/present verbal inflections.
   */
  private static readonly COMPLETE_VERB_TOKENS = new Set<string>([
    'است', 'نیست', 'بود', 'نبود', 'شد', 'نشد', 'شود', 'نشود',
    'می‌شود', 'نمی‌شود', 'دارد', 'ندارد', 'داشت', 'نداشت',
    'کرد', 'نکرد', 'کردم', 'کردی', 'کردیم', 'کردید', 'کردند',
    'می‌کند', 'می‌کنند', 'می‌کنیم', 'می‌کنم', 'شده', 'نشده',
    'باشید', 'باشیم', 'باشم', 'باشند', 'باشد', 'هستم', 'هستی', 'هستیم', 'هستید', 'هستند',
    'گفت', 'گفتند', 'فرمود', 'رسید', 'رسیدیم', 'رفت', 'آمد', 'ماند'
  ]);

  /**
   * Classifies the syntactic completeness of the trailing Persian word.
   */
  public static classifyTrailingPersianSyntax(partialTranscript: string): PersianSyntacticState {
    const cleaned = partialTranscript
      .replace(/[.،؛؟!?:«»"()\-\[\]]+/g, ' ')
      .trim();

    if (!cleaned) return 'NEUTRAL_NOMINAL';

    const tokens = cleaned.split(/\s+/);
    const lastWord = tokens[tokens.length - 1];

    if (this.INCOMPLETE_TRAILING_TOKENS.has(lastWord)) {
      return 'INCOMPLETE_CONJUNCTION_OR_PREP';
    }

    if (
      this.COMPLETE_VERB_TOKENS.has(lastWord) ||
      (lastWord.startsWith('می\u200c') && (
        lastWord.endsWith('م') ||
        lastWord.endsWith('ی') ||
        lastWord.endsWith('د') ||
        lastWord.endsWith('یم') ||
        lastWord.endsWith('ید') ||
        lastWord.endsWith('ند')
      ))
    ) {
      return 'COMPLETE_VERB_OR_CLAUSE';
    }

    return 'NEUTRAL_NOMINAL';
  }

  /**
   * Computes linear regression slope of F0 (Hz/sec) over the final voiced window (assumed 20ms frame hop).
   * Negative slope (< -25 Hz/sec) indicates declarative terminal pitch fall; positive or flat slope
   * indicates continuation rise or mid-clause suspension.
   */
  public static computeTerminalPitchSlopeHzPerSec(f0ContourHz?: number[], frameHopSec: number = 0.02): number {
    if (!f0ContourHz || f0ContourHz.length < 3) return 0;

    const voiced = f0ContourHz.filter((hz) => hz > 50 && hz < 500);
    if (voiced.length < 3) return 0;

    const n = voiced.length;
    let sumT = 0;
    let sumY = 0;
    let sumTY = 0;
    let sumT2 = 0;

    for (let i = 0; i < n; i++) {
      const t = i * frameHopSec;
      const y = voiced[i];
      sumT += t;
      sumY += y;
      sumTY += t * y;
      sumT2 += t * t;
    }

    const denom = n * sumT2 - sumT * sumT;
    if (Math.abs(denom) < 1e-9) return 0;

    return Number(((n * sumTY - sumT * sumY) / denom).toFixed(2));
  }

  /**
   * Evaluates whether the live streaming ASR utterance has reached a true semantic/prosodic endpoint.
   */
  public static evaluateEndpoint(
    frame: EndpointingAcousticFrame,
    maxUtteranceDurationMs: number = 18_000
  ): EndpointingDecision {
    const syntacticState = this.classifyTrailingPersianSyntax(frame.partialPersianTranscript);
    const pitchSlope = this.computeTerminalPitchSlopeHzPerSec(frame.recentVoicedF0ContourHz);

    // Hard safety cap so unbounded monologues still flush periodically
    if (frame.utteranceDurationMs >= maxUtteranceDurationMs && frame.trailingSilenceMs >= 220) {
      return {
        shouldCommitUtterance: true,
        syntacticState,
        requiredSilenceThresholdMs: 220,
        terminalPitchSlopeHzPerSec: pitchSlope,
        reason: 'MAX_DURATION_FORCE_COMMIT',
      };
    }

    // Dynamic silence threshold based on Persian syntax + terminal F0 slope
    let requiredSilenceMs = 680; // Neutral nominal baseline

    if (syntacticState === 'COMPLETE_VERB_OR_CLAUSE') {
      // Fast commit when SOV verb is complete; even faster if pitch falls declaratively
      requiredSilenceMs = pitchSlope < -25 ? 360 : 450;
    } else if (syntacticState === 'INCOMPLETE_CONJUNCTION_OR_PREP') {
      // Hold utterance open across mid-clause "که..." or "برای..." hesitation pauses
      requiredSilenceMs = pitchSlope >= -10 ? 1250 : 1050;
    } else {
      // Neutral nominal phrase: adjust slightly by pitch slope
      requiredSilenceMs = pitchSlope < -30 ? 540 : 700;
    }

    if (frame.trailingSilenceMs >= requiredSilenceMs) {
      return {
        shouldCommitUtterance: true,
        syntacticState,
        requiredSilenceThresholdMs: requiredSilenceMs,
        terminalPitchSlopeHzPerSec: pitchSlope,
        reason: syntacticState === 'COMPLETE_VERB_OR_CLAUSE' ? 'SYNTACTIC_FAST_COMMIT' : 'STANDARD_SILENCE_COMMIT',
      };
    }

    return {
      shouldCommitUtterance: false,
      syntacticState,
      requiredSilenceThresholdMs: requiredSilenceMs,
      terminalPitchSlopeHzPerSec: pitchSlope,
      reason:
        syntacticState === 'INCOMPLETE_CONJUNCTION_OR_PREP' && frame.trailingSilenceMs >= 400
          ? 'HELD_FOR_INCOMPLETE_SYNTAX'
          : 'SPEAKING_OR_SHORT_PAUSE',
    };
  }
}
