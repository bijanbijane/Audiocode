import { WhisperSpecialTokens } from './UnifiedOnnxPersianAsrEngine';
import { PersianTextNormalizer } from '../PersianTextNormalizer';

export interface ResolvedWhisperControlTokens extends WhisperSpecialTokens {
  readonly startOfPrevTokenId: number;
  readonly noSpeechTokenId: number;
  readonly noTimestampsTokenId: number;
}

/**
 * Section 128 (Part 1): Adaptive Whisper Control Token Resolver (v1/v2 51865 vs v3/turbo 51866)
 * & 224-Token Initial Prompt Sequence Builder
 */
export class WhisperPromptAndControlResolver {
  /**
   * 1. Resolve exact Whisper control token IDs based on vocabulary size (fixes v2 vs v3/turbo +1 shift bug)
   */
  public static resolveSpecialTokensForVocabSize(
    vocabSize: number,
  ): ResolvedWhisperControlTokens {
    // Whisper large-v3 and large-v3-turbo have vocabSize = 51866 (added 100th language <|yue|>)
    if (vocabSize === 51866) {
      return {
        sotTokenId: 50258,
        persianLangTokenId: 50300, // <|fa|>
        transcribeTaskTokenId: 50360, // Shifted by +1 in v3
        eotTokenId: 50257,
        startOfPrevTokenId: 50362, // <|startofprev|>
        noSpeechTokenId: 50363, // <|nospeech|>
        noTimestampsTokenId: 50364, // <|notimestamps|>
        timestampBeginId: 50365, // <|0.00|>
      };
    }

    // Whisper v1 / v2 standard (tiny, base, small, medium, large-v2 with vocabSize = 51865)
    if (vocabSize === 51865) {
      return {
        sotTokenId: 50258,
        persianLangTokenId: 50300,
        transcribeTaskTokenId: 50359,
        eotTokenId: 50257,
        startOfPrevTokenId: 50361,
        noSpeechTokenId: 50362,
        noTimestampsTokenId: 50363,
        timestampBeginId: 50364,
      };
    }

    throw new Error(
      `UNSUPPORTED_WHISPER_VOCAB_SIZE: اندازه واژه‌نامه ${vocabSize} برای مدل چندزبانه Whisper معتبر نیست.`,
    );
  }

  /**
   * 2. Build initial decoder prompt sequence injecting Persian hotwords and previous window tail transcript
   * Canonical layout: [<|startofprev|>, ...max_224_prompt_tokens, <|startoftranscript|>, <|fa|>, <|transcribe|>]
   */
  public static buildInitialDecoderPromptSequence(params: {
    vocabSize: number;
    encodeTextToTokenIds: (text: string) => number[];
    domainHotwordsFa?: string[];
    previousWindowTailTranscriptFa?: string;
  }): {
    initialTokenIds: number[];
    specialTokens: ResolvedWhisperControlTokens;
  } {
    const special = this.resolveSpecialTokensForVocabSize(params.vocabSize);
    const MAX_PROMPT_TOKENS = 224;

    const promptSegments: string[] = [];
    if (params.domainHotwordsFa && params.domainHotwordsFa.length > 0) {
      promptSegments.push(`موضوع گفتگو: ${params.domainHotwordsFa.join('، ')}.`);
    }
    if (params.previousWindowTailTranscriptFa?.trim()) {
      promptSegments.push(params.previousWindowTailTranscriptFa.trim());
    }

    const fullPromptText = promptSegments.join(' ').trim();
    if (!fullPromptText) {
      return {
        initialTokenIds: [
          special.sotTokenId,
          special.persianLangTokenId,
          special.transcribeTaskTokenId,
        ],
        specialTokens: special,
      };
    }

    const encodedPromptIds = params.encodeTextToTokenIds(fullPromptText);
    const truncatedPromptIds =
      encodedPromptIds.length > MAX_PROMPT_TOKENS
        ? encodedPromptIds.slice(encodedPromptIds.length - MAX_PROMPT_TOKENS)
        : encodedPromptIds;

    return {
      initialTokenIds: [
        special.startOfPrevTokenId,
        ...truncatedPromptIds,
        special.sotTokenId,
        special.persianLangTokenId,
        special.transcribeTaskTokenId,
      ],
      specialTokens: special,
    };
  }
}

export interface ScoredHypothesisInput {
  readonly transcript: string;
  readonly totalLogScore: number;
}

export interface WordConfusionSlot {
  readonly slotIndex: number;
  readonly bestWord: string;
  readonly alternatives: { readonly word: string; readonly posteriorProb: number }[];
  readonly isUncertain: boolean;
}

/**
 * Section 128 (Part 2): Persian N-Best Word Confusion Network (Sausage Lattice) Builder
 * Aligns N-Best CTC beam hypotheses onto the top backbone hypothesis via word-level Levenshtein
 * and computes normalized posterior probabilities for uncertain words.
 */
export class PersianNBestConfusionNetworkBuilder {
  public static buildWordConfusionNetwork(
    nBestHypotheses: ScoredHypothesisInput[],
    uncertaintyThreshold: number = 0.78,
  ): WordConfusionSlot[] {
    if (nBestHypotheses.length === 0) return [];

    // A) Convert log scores of N-Best beams into normalized posterior probabilities (Softmax over N-Best)
    const maxScore = Math.max(...nBestHypotheses.map((h) => h.totalLogScore));
    const expScores = nBestHypotheses.map((h) =>
      Math.exp(Math.max(-30, h.totalLogScore - maxScore)),
    );
    const sumExp = expScores.reduce((a, b) => a + b, 0) + 1e-12;
    const posteriors = expScores.map((e) => e / sumExp);

    // B) Use top hypothesis as the Sausage Lattice backbone
    const backboneWords = PersianTextNormalizer.normalizeTokenText(
      nBestHypotheses[0].transcript,
    )
      .split(/\s+/)
      .filter(Boolean);

    if (backboneWords.length === 0) return [];

    const slotMassMaps: Map<string, number>[] = backboneWords.map((w) => {
      const m = new Map<string, number>();
      m.set(w, posteriors[0]);
      return m;
    });

    // C) Align each secondary hypothesis onto the backbone via word-level Levenshtein
    for (let hIdx = 1; hIdx < nBestHypotheses.length; hIdx++) {
      const hypWords = PersianTextNormalizer.normalizeTokenText(
        nBestHypotheses[hIdx].transcript,
      )
        .split(/\s+/)
        .filter(Boolean);
      const hypProb = posteriors[hIdx];

      const alignment = this.alignWordsToBackbone(backboneWords, hypWords);
      for (const pair of alignment) {
        if (pair.backboneIdx !== null && pair.hypWord !== null) {
          const map = slotMassMaps[pair.backboneIdx];
          map.set(pair.hypWord, (map.get(pair.hypWord) ?? 0) + hypProb);
        }
      }
    }

    return slotMassMaps.map((massMap, slotIdx) => {
      const sortedAlts = Array.from(massMap.entries())
        .map(([word, prob]) => ({
          word,
          posteriorProb: Number(prob.toFixed(3)),
        }))
        .sort((a, b) => b.posteriorProb - a.posteriorProb);

      const top = sortedAlts[0];
      return {
        slotIndex: slotIdx,
        bestWord: top.word,
        alternatives: sortedAlts,
        isUncertain:
          top.posteriorProb < uncertaintyThreshold && sortedAlts.length > 1,
      };
    });
  }

  private static alignWordsToBackbone(
    backbone: string[],
    hyp: string[],
  ): { backboneIdx: number | null; hypWord: string | null }[] {
    const n = backbone.length;
    const m = hyp.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

    for (let i = 0; i <= n; i++) dp[i][0] = i;
    for (let j = 0; j <= m; j++) dp[0][j] = j;

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const cost = backbone[i - 1] === hyp[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }

    const pairs: { backboneIdx: number | null; hypWord: string | null }[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (
        i > 0 &&
        j > 0 &&
        dp[i][j] === dp[i - 1][j - 1] + (backbone[i - 1] === hyp[j - 1] ? 0 : 1)
      ) {
        pairs.push({ backboneIdx: i - 1, hypWord: hyp[j - 1] });
        i--;
        j--;
      } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
        pairs.push({ backboneIdx: i - 1, hypWord: '<eps>' });
        i--;
      } else {
        pairs.push({ backboneIdx: null, hypWord: hyp[j - 1] });
        j--;
      }
    }
    return pairs.reverse();
  }
}
