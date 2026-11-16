import { PersianLanguageModelScorer } from './PersianCtcPrefixBeamSearchDecoder';
import { PersianTextNormalizer, TimedPersianToken } from '../PersianTextNormalizer';
import { CustomPersianLexiconManager } from '../CustomPersianLexiconManager';

export interface PhoneticConfusionRule {
  readonly confusedForm: string;
  readonly intendedForm: string;
  /** Prior log-prob bonus derived from Baseline Confusion Matrix */
  readonly empiricalPriorBonus: number;
}

export interface AppliedPhoneticCorrectionAudit {
  readonly tokenId: string;
  readonly originalAsrNormalized: string;
  readonly correctedDisplayText: string;
  readonly contextScoreGain: number;
  readonly acousticConfidence: number;
}

/**
 * Section 125: Persian Phonetic Confusion Corrector with Bilateral Context Bigram Rescoring
 * Corrects systematic quantized ASR homophone/phonetic confusions only when bilateral
 * Left+Right language model context confirms a >= minContextualLogProbGain safety margin,
 * preserving immutable originalText and Flicks time ranges.
 */
export class PersianPhoneticConfusionCorrector {
  private readonly skeletonToCanonicalCandidates = new Map<string, string[]>();
  private readonly explicitConfusionMap = new Map<string, PhoneticConfusionRule[]>();

  constructor(
    private readonly lmScorer: PersianLanguageModelScorer,
    canonicalVocabularyWords: string[] = [],
    empiricalConfusionRules: PhoneticConfusionRule[] = [],
  ) {
    for (const word of canonicalVocabularyWords) {
      this.indexCanonicalWord(word);
    }
    for (const rule of empiricalConfusionRules) {
      this.registerExplicitConfusionRule(rule);
    }
  }

  public indexCanonicalWord(rawWord: string): void {
    const norm = PersianTextNormalizer.normalizeTokenText(rawWord);
    if (norm.length < 2) return;
    const skel = CustomPersianLexiconManager.toPersianPhoneticSkeleton(norm);
    const list = this.skeletonToCanonicalCandidates.get(skel);
    if (list) {
      if (!list.includes(norm)) list.push(norm);
    } else {
      this.skeletonToCanonicalCandidates.set(skel, [norm]);
    }
  }

  public registerExplicitConfusionRule(rule: PhoneticConfusionRule): void {
    const confusedNorm = PersianTextNormalizer.normalizeTokenText(rule.confusedForm);
    const intendedNorm = PersianTextNormalizer.normalizeTokenText(rule.intendedForm);
    this.indexCanonicalWord(intendedNorm);

    const existing = this.explicitConfusionMap.get(confusedNorm) ?? [];
    existing.push({
      ...rule,
      confusedForm: confusedNorm,
      intendedForm: intendedNorm,
    });
    this.explicitConfusionMap.set(confusedNorm, existing);
  }

  /**
   * Bilateral Context Bigram Rescoring over uncertain ASR tokens without mutating originalText or TimeRange
   */
  public correctTranscriptWithContextRescoring(
    tokens: TimedPersianToken[],
    options?: {
      maxConfidenceToAttemptCorrection?: number; // Default 0.88
      minContextualLogProbGain?: number; // Default 2.1 safety margin
    },
  ): {
    correctedTokens: TimedPersianToken[];
    appliedCorrections: AppliedPhoneticCorrectionAudit[];
  } {
    const maxConf = options?.maxConfidenceToAttemptCorrection ?? 0.88;
    const minGain = options?.minContextualLogProbGain ?? 2.1;

    const result = [...tokens];
    const appliedCorrections: AppliedPhoneticCorrectionAudit[] = [];

    for (let i = 0; i < result.length; i++) {
      const tok = result[i];
      if (tok.confidence > maxConf && this.lmScorer.isKnownPersianWord(tok.normalizedText)) {
        continue;
      }

      const prevWord = i > 0 ? result[i - 1].normalizedText : null;
      const nextWord = i + 1 < result.length ? result[i + 1].normalizedText : null;

      const candidates = this.gatherCandidatesForToken(tok.normalizedText);
      if (candidates.length === 0) continue;

      const currentContextScore = this.scoreBilateralContext(
        prevWord,
        tok.normalizedText,
        nextWord,
      );

      let bestCandidate: string | null = null;
      let bestScore = currentContextScore;

      for (const cand of candidates) {
        if (cand.word === tok.normalizedText) continue;
        const candScore =
          this.scoreBilateralContext(prevWord, cand.word, nextWord) + cand.priorBonus;

        if (candScore > bestScore) {
          bestScore = candScore;
          bestCandidate = cand.word;
        }
      }

      const gain = bestScore - currentContextScore;
      if (bestCandidate && gain >= minGain) {
        result[i] = {
          ...tok,
          normalizedText: bestCandidate,
          displayText: bestCandidate,
        };
        appliedCorrections.push({
          tokenId: tok.tokenId,
          originalAsrNormalized: tok.normalizedText,
          correctedDisplayText: bestCandidate,
          contextScoreGain: Number(gain.toFixed(2)),
          acousticConfidence: tok.confidence,
        });
      }
    }

    return {
      correctedTokens: result,
      appliedCorrections,
    };
  }

  private gatherCandidatesForToken(
    normalizedWord: string,
  ): { word: string; priorBonus: number }[] {
    const out: { word: string; priorBonus: number }[] = [];
    const seen = new Set<string>();

    const explicitRules = this.explicitConfusionMap.get(normalizedWord);
    if (explicitRules) {
      for (const r of explicitRules) {
        if (!seen.has(r.intendedForm)) {
          seen.add(r.intendedForm);
          out.push({ word: r.intendedForm, priorBonus: r.empiricalPriorBonus });
        }
      }
    }

    const skel = CustomPersianLexiconManager.toPersianPhoneticSkeleton(normalizedWord);
    const homophones = this.skeletonToCanonicalCandidates.get(skel);
    if (homophones) {
      for (const hw of homophones) {
        if (!seen.has(hw)) {
          seen.add(hw);
          out.push({ word: hw, priorBonus: 0.35 });
        }
      }
    }

    return out;
  }

  private scoreBilateralContext(
    prevWord: string | null,
    centerWord: string,
    nextWord: string | null,
  ): number {
    let score = this.lmScorer.scoreWordTransitionLogProb(prevWord, centerWord);
    if (nextWord) {
      score += this.lmScorer.scoreWordTransitionLogProb(centerWord, nextWord);
    }
    if (this.lmScorer.isKnownPersianWord(centerWord)) {
      score += 1.2;
    }
    return score;
  }
}
