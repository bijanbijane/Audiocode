import { PersianTextNormalizer, TimedPersianToken } from './PersianTextNormalizer';

export interface LexiconEntry {
  readonly entryId: string;
  /** Canonical Persian/technical spelling chosen by user (e.g. «طالقانی» or «تایپ‌اسکریپت») */
  readonly canonicalDisplayForm: string;
  readonly phoneticAliases: readonly string[];
  readonly category: 'PERSON_NAME' | 'BRAND_OR_ORG' | 'TECHNICAL_TERM' | 'FOREIGN_LOANWORD';
}

export interface UncertainTokenSuggestion {
  readonly tokenId: string;
  readonly currentDisplayText: string;
  readonly asrConfidence: number;
  readonly suggestedReplacement: string;
  readonly matchSimilarity: number;
  readonly matchedLexiconEntryId?: string;
}

/**
 * Custom Persian Lexicon & Uncertain Token Manager (Sections 2.1 & 27)
 * Resolves Persian homophone misspellings (ت/ط، س/ص/ث، ز/ذ/ض/ظ، ق/غ، ه/ح) using
 * a deterministic Persian Phonetic Skeleton + Levenshtein similarity while keeping originalText immutable.
 */
export class CustomPersianLexiconManager {
  private readonly entries = new Map<
    string,
    { entry: LexiconEntry; phoneticSkeletons: string[] }
  >();

  public registerLexiconEntries(items: readonly LexiconEntry[]): void {
    for (const item of items) {
      const allForms = [item.canonicalDisplayForm, ...item.phoneticAliases];
      const skeletons = allForms
        .map((f) => CustomPersianLexiconManager.toPersianPhoneticSkeleton(f))
        .filter((s) => s.length > 0);
      this.entries.set(item.entryId, { entry: item, phoneticSkeletons: skeletons });
    }
  }

  public removeLexiconEntry(entryId: string): boolean {
    return this.entries.delete(entryId);
  }

  /**
   * Maps Persian homophone letters & joiners into a canonical phonetic skeleton.
   */
  public static toPersianPhoneticSkeleton(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[\u200c\s\-_]+/g, '')
      .replace(/[طت]/g, 'ت')
      .replace(/[ثسص]/g, 'س')
      .replace(/[ذزضظ]/g, 'ز')
      .replace(/[غق]/g, 'ق')
      .replace(/[حﻫهة]/g, 'ه')
      .replace(/[أإآعء]/g, 'ا')
      .replace(/[یيئى]/g, 'ی')
      .replace(/[کك]/g, 'ک')
      .replace(/[ؤو]/g, 'و');
  }

  public findUncertainWordsAndSuggestCorrections(
    tokens: readonly TimedPersianToken[],
    uncertaintyThreshold = 0.75,
  ): UncertainTokenSuggestion[] {
    const suggestions: UncertainTokenSuggestion[] = [];

    for (const token of tokens) {
      const tokenSkeleton = CustomPersianLexiconManager.toPersianPhoneticSkeleton(
        token.normalizedText,
      );
      if (tokenSkeleton.length < 2) continue;

      let bestEntry: LexiconEntry | null = null;
      let bestSim = 0;

      for (const { entry, phoneticSkeletons } of this.entries.values()) {
        for (const targetSkel of phoneticSkeletons) {
          const sim = this.computeSkeletonSimilarity(tokenSkeleton, targetSkel);
          if (sim > bestSim) {
            bestSim = sim;
            bestEntry = entry;
          }
        }
      }

      const isStrongLexiconMatch =
        bestEntry !== null &&
        bestSim >= 0.78 &&
        token.displayText !== bestEntry.canonicalDisplayForm;

      if (isStrongLexiconMatch || token.confidence < uncertaintyThreshold) {
        suggestions.push({
          tokenId: token.tokenId,
          currentDisplayText: token.displayText,
          asrConfidence: token.confidence,
          suggestedReplacement:
            isStrongLexiconMatch && bestEntry
              ? bestEntry.canonicalDisplayForm
              : token.displayText,
          matchSimilarity: Number(bestSim.toFixed(2)),
          matchedLexiconEntryId: isStrongLexiconMatch ? bestEntry?.entryId : undefined,
        });
      }
    }

    return suggestions;
  }

  /**
   * Updates only displayText & normalizedText while preserving immutable ASR originalText & Flicks range.
   */
  public applyLexiconCorrectionNonDestructively(
    tokens: readonly TimedPersianToken[],
    targetTokenId: string,
    correctedDisplayText: string,
  ): TimedPersianToken[] {
    const normalized = PersianTextNormalizer.normalizeTokenText(correctedDisplayText);
    return tokens.map((tok) =>
      tok.tokenId === targetTokenId
        ? {
            ...tok,
            normalizedText: normalized,
            displayText: correctedDisplayText,
          }
        : tok,
    );
  }

  /**
   * Batch-applies high-confidence lexicon replacements across all matching tokens in one pass.
   */
  public applyBatchLexiconCorrectionsNonDestructively(
    tokens: readonly TimedPersianToken[],
    uncertaintyThreshold = 0.75,
  ): { tokens: TimedPersianToken[]; appliedCount: number } {
    const suggestions = this.findUncertainWordsAndSuggestCorrections(tokens, uncertaintyThreshold);
    const replacementById = new Map<string, string>();
    for (const s of suggestions) {
      if (s.matchedLexiconEntryId && s.suggestedReplacement !== s.currentDisplayText) {
        replacementById.set(s.tokenId, s.suggestedReplacement);
      }
    }

    if (replacementById.size === 0) {
      return { tokens: [...tokens], appliedCount: 0 };
    }

    const updated = tokens.map((tok) => {
      const replacement = replacementById.get(tok.tokenId);
      if (!replacement) return tok;
      return {
        ...tok,
        normalizedText: PersianTextNormalizer.normalizeTokenText(replacement),
        displayText: replacement,
      };
    });

    return { tokens: updated, appliedCount: replacementById.size };
  }

  public computeSkeletonSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;

    const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0),
    );
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }

    return Math.max(0, 1.0 - dp[a.length][b.length] / maxLen);
  }
}
