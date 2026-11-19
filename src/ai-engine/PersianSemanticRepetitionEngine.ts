import { TimedPersianToken } from './PersianTextNormalizer';
import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';
import type {
  SpeechEventDetectionState,
  SpeechEventSubtype,
  SpeechEventUncertaintyState,
} from './speech-events/SpeechEventContracts';

export interface SemanticRetakeCandidate {
  readonly retakeId: string;
  readonly trackId: string;
  /** First incomplete/suboptimal take range suggested for deletion (includes gap/hesitation before retake) */
  readonly firstTakeDeleteRange: TimeRange;
  /** Refined second take range recommended to keep */
  readonly secondTakeKeepRange: TimeRange;
  readonly firstTakeText: string;
  readonly secondTakeText: string;
  readonly semanticSimilarityScore: number;
  readonly reasonFa: string;
}

export interface WordRepetitionClassification {
  readonly id: string;
  readonly trackId: string;
  readonly subtype: Extract<
    SpeechEventSubtype,
    | 'ACCIDENTAL_WORD_REPETITION'
    | 'INTENTIONAL_EMPHASIS_REPETITION'
    | 'LEGITIMATE_LEXICAL_REPETITION'
  >;
  readonly detectionState: SpeechEventDetectionState;
  readonly uncertaintyState: SpeechEventUncertaintyState;
  readonly targetRange: TimeRange;
  readonly keptRepetitionRange: TimeRange;
  readonly affectedTokenIds: readonly string[];
  readonly repeatedText: string;
  readonly temporalSeparationMs: number;
  readonly acousticEnergyRatio: number | null;
  readonly linguisticScore: number;
  readonly acousticScore: number | null;
  readonly eligibleForDeletionSuggestion: boolean;
  readonly requiresHumanReview: boolean;
  readonly reasonFa: string;
}

interface ClauseSegment {
  readonly trackId: string;
  readonly tokens: TimedPersianToken[];
  readonly range: TimeRange;
  readonly rawText: string;
  readonly contentStems: string[];
  readonly charTrigrams: Map<string, number>;
}

/**
 * Persian Semantic Repetition & Retake Detection Engine (Section 2.2 & Group C Section 35)
 * Identifies consecutive spoken takes where the speaker rephrases the same meaning after a pause,
 * and distinguishes accidental repetitions from intentional emphasis and legitimate lexical reduplication.
 */
export class PersianSemanticRepetitionEngine {
  private static readonly STOP_WORDS = new Set([
    'و', 'در', 'به', 'از', 'که', 'این', 'آن', 'را', 'با', 'برای', 'تا', 'هم', 'بر', 'یا',
    'یک', 'ما', 'من', 'شما', 'او', 'آنها', 'ایشان', 'ولی', 'اما', 'چون', 'اگر', 'هر',
  ]);

  /** Adverbs / intensifiers intentionally repeated in Persian for rhetorical emphasis */
  private static readonly EMPHASIS_INTENSIFIERS = new Set([
    'خیلی', 'بسیار', 'حتماً', 'حتما', 'واقعاً', 'واقعا', 'دقیقاً', 'دقیقا',
    'کاملاً', 'کاملا', 'اصلاً', 'اصلا', 'فوق‌العاده', 'شدیداً', 'همیشه', 'هرگز', 'زود',
  ]);

  /** Legitimate Persian distributive/idiomatic reduplications */
  private static readonly LEGITIMATE_REDUPLICATIONS = new Set([
    'کم', 'تند', 'دونه', 'دانه', 'یکی', 'یواش', 'آروم', 'آرام', 'به‌زودی', 'تک', 'گام', 'لحظه',
  ]);

  public static classifyWordRepetitionsDetailed(
    tokens: readonly TimedPersianToken[],
    options?: {
      readonly pcmMono?: Float32Array;
      readonly sampleRate?: SampleRate;
    },
  ): WordRepetitionClassification[] {
    if (tokens.length < 2) return [];
    const results: WordRepetitionClassification[] = [];
    const pcm = options?.pcmMono;
    const sampleRate = options?.sampleRate;
    const hasAudio = Boolean(
      pcm && pcm.length > 0 && sampleRate && Number.isFinite(sampleRate) && sampleRate > 0,
    );

    for (let i = 0; i < tokens.length - 1; i++) {
      const first = tokens[i];
      const second = tokens[i + 1];
      if (first.trackId !== second.trackId) continue;

      const normA = first.normalizedText.replace(/[،؛.!؟«»()[\]\u200c\s]/g, '');
      const normB = second.normalizedText.replace(/[،؛.!؟«»()[\]\u200c\s]/g, '');
      if (!normA || normA !== normB) continue;

      if (
        !Number.isFinite(first.range.start) ||
        !Number.isFinite(first.range.end) ||
        !Number.isFinite(second.range.start) ||
        !Number.isFinite(second.range.end)
      ) {
        continue;
      }

      const rawGapMs = TimeMath.flicksToSeconds(second.range.start - first.range.end) * 1000;
      if (!Number.isFinite(rawGapMs)) continue;
      const gapMs = Math.max(0, rawGapMs);
      if (gapMs > 2200) continue;

      // Measure acoustic RMS ratio if PCM is supplied
      let acousticEnergyRatio: number | null = null;
      let acousticScore: number | null = null;
      if (hasAudio && pcm && sampleRate) {
        const rmsA = this.measureRangeRms(pcm, sampleRate, first.range);
        const rmsB = this.measureRangeRms(pcm, sampleRate, second.range);
        if (rmsA > 1e-6 && rmsB > 1e-6) {
          acousticEnergyRatio = Number((rmsB / rmsA).toFixed(3));
        }
      }

      // 1. Legitimate distributive / idiomatic lexical repetition («کم کم», «یکی یکی», «روز به روز»)
      if (this.LEGITIMATE_REDUPLICATIONS.has(normA)) {
        results.push({
          id: `wrep_legit_${first.tokenId}`,
          trackId: first.trackId,
          subtype: 'LEGITIMATE_LEXICAL_REPETITION',
          detectionState: 'NOT_DETECTED',
          uncertaintyState: 'LOW_UNCERTAINTY',
          targetRange: first.range,
          keptRepetitionRange: second.range,
          affectedTokenIds: [first.tokenId, second.tokenId],
          repeatedText: `${first.displayText} ${second.displayText}`,
          temporalSeparationMs: Math.round(gapMs),
          acousticEnergyRatio,
          linguisticScore: 0.15,
          acousticScore: hasAudio ? 0.2 : null,
          eligibleForDeletionSuggestion: false,
          requiresHumanReview: false,
          reasonFa: `تکرار دستوری/واژگانی معنادار («${first.displayText} ${second.displayText}») که تغییر معنا می‌دهد و نباید حذف شود.`,
        });
        i++;
        continue;
      }

      // 2. Intentional emphasis («خیلی خیلی مهمه», «حتماً حتماً», «باید باید» with prosodic accent)
      const isIntensifier = this.EMPHASIS_INTENSIFIERS.has(normA);
      const strongEmphaticAccent =
        acousticEnergyRatio !== null &&
        acousticEnergyRatio >= 1.18 &&
        gapMs <= 220 &&
        first.normalizedText.length >= 3;

      if (isIntensifier || strongEmphaticAccent) {
        results.push({
          id: `wrep_emph_${first.tokenId}`,
          trackId: first.trackId,
          subtype: 'INTENTIONAL_EMPHASIS_REPETITION',
          detectionState: hasAudio ? 'DETECTED' : 'PROBABLE',
          uncertaintyState: hasAudio ? 'MODERATE_UNCERTAINTY' : 'INSUFFICIENT_EVIDENCE',
          targetRange: first.range,
          keptRepetitionRange: second.range,
          affectedTokenIds: [first.tokenId, second.tokenId],
          repeatedText: `${first.displayText} ${second.displayText}`,
          temporalSeparationMs: Math.round(gapMs),
          acousticEnergyRatio,
          linguisticScore: isIntensifier ? 0.84 : 0.68,
          acousticScore: acousticEnergyRatio !== null ? 0.78 : null,
          eligibleForDeletionSuggestion: false,
          requiresHumanReview: true,
          reasonFa: isIntensifier
            ? `تکرار تأکیدی عمدی قید/صفت («${first.displayText} ${second.displayText}») برای شدت معنا — حذف توصیه نمی‌شود.`
            : `تکرار همراه با افزایش تاکید صوتی (${acousticEnergyRatio}x)؛ احتمال تأکید عمدی وجود دارد.`,
        });
        i++;
        continue;
      }

      // 3. Accidental repetition (function words like «من من», «این این», «باید باید» when flat/hesitant)
      const isFunctionWordOrShortPronoun =
        this.STOP_WORDS.has(normA) || normA.length <= 3 || ['باید', 'می‌خوام', 'میخوام'].includes(normA);
      const hesitationGap = gapMs >= 80 && gapMs <= 1200;
      const flatOrFalteringEnergy =
        acousticEnergyRatio !== null && acousticEnergyRatio >= 0.75 && acousticEnergyRatio <= 1.25;

      if (hasAudio && acousticEnergyRatio !== null) {
        acousticScore = flatOrFalteringEnergy ? 0.8 : 0.55;
      }

      const sufficientAcoustic = hasAudio && acousticEnergyRatio !== null;
      const accidentalConfidenceReady =
        sufficientAcoustic && (isFunctionWordOrShortPronoun || hesitationGap);

      results.push({
        id: `wrep_acc_${first.tokenId}`,
        trackId: first.trackId,
        subtype: 'ACCIDENTAL_WORD_REPETITION',
        detectionState: accidentalConfidenceReady
          ? 'PROBABLE'
          : sufficientAcoustic
            ? 'POSSIBLE'
            : 'UNCERTAIN',
        uncertaintyState: sufficientAcoustic
          ? accidentalConfidenceReady
            ? 'MODERATE_UNCERTAINTY'
            : 'HIGH_UNCERTAINTY'
          : 'INSUFFICIENT_EVIDENCE',
        targetRange: {
          start: first.range.start,
          end: second.range.start,
        },
        keptRepetitionRange: second.range,
        affectedTokenIds: [first.tokenId],
        repeatedText: `${first.displayText} ${second.displayText}`,
        temporalSeparationMs: Math.round(gapMs),
        acousticEnergyRatio,
        linguisticScore: isFunctionWordOrShortPronoun ? 0.82 : 0.64,
        acousticScore,
        eligibleForDeletionSuggestion: accidentalConfidenceReady,
        requiresHumanReview: true,
        reasonFa: sufficientAcoustic
          ? `تکرار متوالی کلمه «${first.displayText}» (فاصله ${Math.round(gapMs)}ms، نسبت انرژی ${acousticEnergyRatio}x)`
          : `تکرار کلمه «${first.displayText}» بدون شواهد آکوستیکی کافی (وضعیت نامطمئن؛ نیازمند بازبینی)`,
      });
      i++;
    }

    return results;
  }

  private static measureRangeRms(
    pcm: Float32Array,
    sampleRate: SampleRate,
    range: TimeRange,
  ): number {
    if (
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0
    ) {
      return 0;
    }
    const startSample = Math.max(0, TimeMath.flicksToSamplesFloor(range.start, sampleRate));
    const endSample = Math.min(pcm.length, TimeMath.flicksToSamplesFloor(range.end, sampleRate));
    if (endSample <= startSample) return 0;
    let sumSq = 0;
    let validCount = 0;
    for (let i = startSample; i < endSample; i++) {
      const s = pcm[i];
      if (Number.isFinite(s)) {
        sumSq += s * s;
        validCount++;
      }
    }
    return validCount > 0 ? Math.sqrt(sumSq / validCount) : 0;
  }

  public static detectSemanticRetakes(
    tokens: readonly TimedPersianToken[],
    maxWindowSecondsBetweenTakes = 18.0,
    similarityThreshold = 0.54,
  ): SemanticRetakeCandidate[] {
    if (tokens.length < 2) return [];
    const safeMaxWindowSec =
      Number.isFinite(maxWindowSecondsBetweenTakes) && maxWindowSecondsBetweenTakes > 0
        ? maxWindowSecondsBetweenTakes
        : 18.0;
    const safeSimilarityThreshold =
      Number.isFinite(similarityThreshold) && similarityThreshold > 0 && similarityThreshold <= 1
        ? similarityThreshold
        : 0.54;

    const clauses = this.segmentTokensIntoClauses(tokens);
    const candidates: SemanticRetakeCandidate[] = [];

    for (let i = 0; i < clauses.length - 1; i++) {
      const take1 = clauses[i];
      if (take1.contentStems.length < 3) continue;

      // Inspect up to 3 subsequent clauses on the same speaker track within safeMaxWindowSec
      for (let j = i + 1; j <= Math.min(clauses.length - 1, i + 3); j++) {
        const take2 = clauses[j];
        if (take2.trackId !== take1.trackId) continue;
        if (take2.contentStems.length < 3) continue;

        const gapSeconds = TimeMath.flicksToSeconds(take2.range.start - take1.range.end);
        if (!Number.isFinite(gapSeconds) || gapSeconds < 0) continue;
        if (gapSeconds > safeMaxWindowSec) break;

        const stemSim = this.computeJaccardSimilarity(take1.contentStems, take2.contentStems);
        const trigramSim = this.computeCosineSimilarity(take1.charTrigrams, take2.charTrigrams);
        const combinedSimilarity = 0.55 * stemSim + 0.45 * trigramSim;

        if (combinedSimilarity >= safeSimilarityThreshold) {
          candidates.push({
            retakeId: `retake_${take1.tokens[0].tokenId}_${take2.tokens[0].tokenId}`,
            trackId: take1.trackId,
            firstTakeDeleteRange: {
              start: take1.range.start,
              end: take2.range.start,
            },
            secondTakeKeepRange: take2.range,
            firstTakeText: take1.rawText,
            secondTakeText: take2.rawText,
            semanticSimilarityScore: Number(combinedSimilarity.toFixed(2)),
            reasonFa: `تکرار معنایی / برداشت مجدد گوینده (شباهت معنایی ${Math.round(combinedSimilarity * 100)}٪ با جمله بعدی)`,
          });
          i = j; // Advance past paired second take
          break;
        }
      }
    }

    return candidates;
  }

  private static segmentTokensIntoClauses(tokens: readonly TimedPersianToken[]): ClauseSegment[] {
    if (tokens.length === 0) return [];
    const clauses: ClauseSegment[] = [];
    let currentGroup: TimedPersianToken[] = [tokens[0]];

    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1];
      const curr = tokens[i];
      const rawGapMs = TimeMath.flicksToSeconds(curr.range.start - prev.range.end) * 1000;
      const gapMs = Number.isFinite(rawGapMs) ? rawGapMs : 0;

      if (
        curr.trackId !== prev.trackId ||
        gapMs >= 350 ||
        /[؟!.؛]$/.test(prev.displayText)
      ) {
        clauses.push(this.buildClauseObject(currentGroup));
        currentGroup = [curr];
      } else {
        currentGroup.push(curr);
      }
    }

    if (currentGroup.length > 0) {
      clauses.push(this.buildClauseObject(currentGroup));
    }
    return clauses;
  }

  private static buildClauseObject(group: TimedPersianToken[]): ClauseSegment {
    const rawText = group.map((t) => t.displayText).join(' ');
    const contentStems = group
      .map((t) => t.normalizedText)
      .filter((w) => w.length > 1 && !this.STOP_WORDS.has(w))
      .map((w) => this.stemPersianWord(w));

    const joinedStems = contentStems.join(' ');
    const charTrigrams = new Map<string, number>();
    for (let i = 0; i <= joinedStems.length - 3; i++) {
      const tri = joinedStems.slice(i, i + 3);
      charTrigrams.set(tri, (charTrigrams.get(tri) ?? 0) + 1);
    }

    return {
      trackId: group[0].trackId,
      tokens: group,
      range: {
        start: Number.isFinite(group[0].range.start) ? group[0].range.start : 0,
        end: Number.isFinite(group[group.length - 1].range.end)
          ? group[group.length - 1].range.end
          : 0,
      },
      rawText,
      contentStems,
      charTrigrams,
    };
  }

  public static stemPersianWord(word: string): string {
    let stem = word.replace(/\u200c/g, '');
    const withoutPrefix = stem.replace(/^(ن?می)/, '');
    if (withoutPrefix.length >= 2) {
      stem = withoutPrefix;
    }

    const withoutPlural = stem.replace(
      /(هایمان|هایتان|هایشان|هایی|های|ها|تر|ترین)$/,
      '',
    );
    if (withoutPlural.length >= 2) {
      stem = withoutPlural;
    }

    const withoutPronoun = stem.replace(/(مان|تان|شان|اش|ام|ات|یم|ید|ند)$/, '');
    if (withoutPronoun.length >= 2) {
      stem = withoutPronoun;
    }

    // Strip attributive '-ی' (e.g., نرم‌افزاری -> نرمافزار) only on long compound stems
    if (stem.length >= 7 && stem.endsWith('ی')) {
      stem = stem.slice(0, -1);
    }

    return stem;
  }

  private static computeJaccardSimilarity(stemsA: readonly string[], stemsB: readonly string[]): number {
    const setA = new Set(stemsA);
    const setB = new Set(stemsB);
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private static computeCosineSimilarity(
    vecA: Map<string, number>,
    vecB: Map<string, number>,
  ): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (const [k, valA] of vecA.entries()) {
      magA += valA * valA;
      const valB = vecB.get(k);
      if (valB !== undefined) dot += valA * valB;
    }
    for (const valB of vecB.values()) {
      magB += valB * valB;
    }
    return dot / (Math.sqrt(magA * magB) + 1e-12);
  }
}
