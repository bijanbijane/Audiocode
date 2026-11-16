import { PersianTextNormalizer, TimedPersianToken } from '../PersianTextNormalizer';
import { CustomPersianLexiconManager } from '../CustomPersianLexiconManager';
import { TimeMath, TimeRange } from '../../contracts/timebase.contract';

export interface ModelHypothesisInput {
  readonly modelId: string;
  /** Weight of this model in word-level text voting (e.g. 1.2 for Whisper, 1.0 for FastConformer) */
  readonly textAccuracyWeight: number;
  /** Weight of this model in timestamp boundary computation (e.g. 1.4 for CTC/Aligner, 0.8 for Whisper) */
  readonly timestampPrecisionWeight: number;
  readonly tokens: TimedPersianToken[];
}

export interface RoverConsensusToken extends TimedPersianToken {
  readonly agreementRatio: number; // Ratio of total model weight agreeing on winning word (0.0 to 1.0)
  readonly competingCandidates: { word: string; voteScore: number }[];
}

interface WordVoteAccumulator {
  wordNormalized: string;
  originalSample: string;
  voteWeightSum: number;
  confidenceWeightedSum: number;
  voteCount: number;
  weightedStartFlicksSum: number;
  weightedEndFlicksSum: number;
  timestampWeightSum: number;
}

interface RoverWtnSlot {
  minStartFlicks: number;
  maxEndFlicks: number;
  nullVoteWeightSum: number;
  wordVotes: Map<string, WordVoteAccumulator>;
}

export class PersianRoverMultiModelEnsembleEngine {
  /**
   * Executes time-constrained ROVER (Recognizer Output Voting Error Reduction) across 2 or more independent Persian ASR models.
   */
  public static combineModelOutputs(
    hypotheses: ModelHypothesisInput[],
    options?: {
      maxAlignmentTimeGapSec?: number; // Default 1.5s
      nullPenaltyFactor?: number;      // Weight factor for <NULL> deletion voting
    }
  ): RoverConsensusToken[] {
    const nonEmpty = hypotheses
      .filter((h) => h.tokens.length > 0)
      .sort((a, b) => b.textAccuracyWeight - a.textAccuracyWeight);

    if (nonEmpty.length === 0) return [];

    const maxGapFlicks = TimeMath.secondsToFlicks(options?.maxAlignmentTimeGapSec ?? 1.5);
    const nullPenalty = options?.nullPenaltyFactor ?? 0.85;
    const totalModelsWeight = nonEmpty.reduce((acc, h) => acc + h.textAccuracyWeight, 0);

    // 1. Initialize Word Transition Network (WTN) backbone from the highest-weighted primary model
    const primary = nonEmpty[0];
    let wtnSlots: RoverWtnSlot[] = primary.tokens.map((tok) => {
      const slot = this.createEmptySlot(tok.range);
      this.addWordVoteToSlot(slot, tok, primary.textAccuracyWeight, primary.timestampPrecisionWeight);
      return slot;
    });

    // 2. Iteratively align each subsequent model onto the WTN using time-constrained dynamic programming
    for (let mIdx = 1; mIdx < nonEmpty.length; mIdx++) {
      const modelHyp = nonEmpty[mIdx];
      const alignedOps = this.alignTokensToWtnSlots(wtnSlots, modelHyp.tokens, maxGapFlicks);

      const nextWtnSlots: RoverWtnSlot[] = [];
      const modelsSeenSoFarWeight = nonEmpty
        .slice(0, mIdx)
        .reduce((acc, h) => acc + h.textAccuracyWeight, 0);

      for (const op of alignedOps) {
        if (op.slotIdx !== null && op.token !== null) {
          // Match or substitution into existing slot
          const slot = wtnSlots[op.slotIdx];
          this.addWordVoteToSlot(
            slot,
            op.token,
            modelHyp.textAccuracyWeight,
            modelHyp.timestampPrecisionWeight
          );
          nextWtnSlots.push(slot);
        } else if (op.slotIdx !== null && op.token === null) {
          // Current model omitted this word -> cast <NULL> vote
          const slot = wtnSlots[op.slotIdx];
          slot.nullVoteWeightSum += modelHyp.textAccuracyWeight * nullPenalty;
          nextWtnSlots.push(slot);
        } else if (op.slotIdx === null && op.token !== null) {
          // Insertion from current model -> create new slot and record <NULL> votes for earlier models
          const newSlot = this.createEmptySlot(op.token.range);
          newSlot.nullVoteWeightSum = modelsSeenSoFarWeight * nullPenalty;
          this.addWordVoteToSlot(
            newSlot,
            op.token,
            modelHyp.textAccuracyWeight,
            modelHyp.timestampPrecisionWeight
          );
          nextWtnSlots.push(newSlot);
        }
      }

      wtnSlots = nextWtnSlots;
    }

    // 3. Final weighted voting per slot and precision-weighted timestamp selection
    const finalConsensusTokens: RoverConsensusToken[] = [];

    for (let sIdx = 0; sIdx < wtnSlots.length; sIdx++) {
      const slot = wtnSlots[sIdx];
      const candidates = Array.from(slot.wordVotes.values())
        .map((acc) => ({
          acc,
          score: acc.voteWeightSum * (0.7 + 0.3 * (acc.confidenceWeightedSum / acc.voteWeightSum)),
        }))
        .sort((a, b) => b.score - a.score);

      if (candidates.length === 0) continue;

      const winner = candidates[0];
      // Drop hallucinated single-model insertions if <NULL> vote weight exceeds the winning word score
      if (slot.nullVoteWeightSum > winner.score) {
        continue;
      }

      const startFlicks = Math.round(
        winner.acc.weightedStartFlicksSum / Math.max(1e-6, winner.acc.timestampWeightSum)
      );
      const endFlicks = Math.max(
        startFlicks + TimeMath.secondsToFlicks(0.04),
        Math.round(
          winner.acc.weightedEndFlicksSum / Math.max(1e-6, winner.acc.timestampWeightSum)
        )
      );

      const rawNorm = PersianTextNormalizer.normalizeTokenText(winner.acc.wordNormalized);
      const avgConf = winner.acc.confidenceWeightedSum / Math.max(1e-6, winner.acc.voteWeightSum);
      const agreementRatio = Math.min(1.0, winner.acc.voteWeightSum / totalModelsWeight);

      finalConsensusTokens.push({
        tokenId: `rover_${sIdx}`,
        trackId: primary.tokens[0]?.trackId ?? 'default-track',
        originalText: winner.acc.originalSample,
        normalizedText: rawNorm,
        displayText: rawNorm,
        range: { start: startFlicks, end: endFlicks },
        confidence: Number(Math.min(0.99, avgConf).toFixed(3)),
        agreementRatio: Number(agreementRatio.toFixed(2)),
        competingCandidates: candidates.map((c) => ({
          word: c.acc.wordNormalized,
          voteScore: Number(c.score.toFixed(3)),
        })),
      });
    }

    return finalConsensusTokens;
  }

  private static alignTokensToWtnSlots(
    slots: RoverWtnSlot[],
    tokens: TimedPersianToken[],
    maxGapFlicks: number
  ): { slotIdx: number | null; token: TimedPersianToken | null }[] {
    const N = slots.length;
    const M = tokens.length;
    const dp = Array.from({ length: N + 1 }, () => new Float64Array(M + 1));
    const ops = Array.from({ length: N + 1 }, () => new Uint8Array(M + 1)); // 0=sub/match, 1=del(slot), 2=ins(tok)

    for (let i = 1; i <= N; i++) {
      dp[i][0] = i;
      ops[i][0] = 1;
    }
    for (let j = 1; j <= M; j++) {
      dp[0][j] = j;
      ops[0][j] = 2;
    }

    for (let i = 1; i <= N; i++) {
      const slot = slots[i - 1];
      const slotDominantWord = this.getSlotLeadingWord(slot);
      const slotSkel = CustomPersianLexiconManager.toPersianPhoneticSkeleton(slotDominantWord);

      for (let j = 1; j <= M; j++) {
        const tok = tokens[j - 1];
        const timeDist =
          tok.range.end < slot.minStartFlicks
            ? slot.minStartFlicks - tok.range.end
            : tok.range.start > slot.maxEndFlicks
            ? tok.range.start - slot.maxEndFlicks
            : 0;

        let subCost = 1.0;
        if (timeDist > maxGapFlicks) {
          subCost = 6.0; // Forbid aligning words separated by more than maxAlignmentTimeGapSec
        } else if (tok.normalizedText === slotDominantWord) {
          subCost = 0.0;
        } else if (
          CustomPersianLexiconManager.toPersianPhoneticSkeleton(tok.normalizedText) === slotSkel
        ) {
          subCost = 0.35; // High phonetic similarity (Persian homophones)
        } else if (timeDist === 0) {
          subCost = 0.8; // Direct temporal overlap
        }

        const cMatch = dp[i - 1][j - 1] + subCost;
        const cDel = dp[i - 1][j] + 1.0;
        const cIns = dp[i][j - 1] + 1.0;

        if (cMatch <= cDel && cMatch <= cIns) {
          dp[i][j] = cMatch;
          ops[i][j] = 0;
        } else if (cDel <= cIns) {
          dp[i][j] = cDel;
          ops[i][j] = 1;
        } else {
          dp[i][j] = cIns;
          ops[i][j] = 2;
        }
      }
    }

    const result: { slotIdx: number | null; token: TimedPersianToken | null }[] = [];
    let i = N;
    let j = M;
    while (i > 0 || j > 0) {
      const op = ops[i][j];
      if (i > 0 && j > 0 && op === 0) {
        result.push({ slotIdx: i - 1, token: tokens[j - 1] });
        i--;
        j--;
      } else if (i > 0 && (j === 0 || op === 1)) {
        result.push({ slotIdx: i - 1, token: null });
        i--;
      } else {
        result.push({ slotIdx: null, token: tokens[j - 1] });
        j--;
      }
    }

    return result.reverse();
  }

  private static createEmptySlot(initialRange: TimeRange): RoverWtnSlot {
    return {
      minStartFlicks: initialRange.start,
      maxEndFlicks: initialRange.end,
      nullVoteWeightSum: 0,
      wordVotes: new Map(),
    };
  }

  private static addWordVoteToSlot(
    slot: RoverWtnSlot,
    tok: TimedPersianToken,
    textWeight: number,
    tsWeight: number
  ): void {
    slot.minStartFlicks = Math.min(slot.minStartFlicks, tok.range.start);
    slot.maxEndFlicks = Math.max(slot.maxEndFlicks, tok.range.end);

    const key = tok.normalizedText;
    const existing = slot.wordVotes.get(key);
    if (!existing) {
      slot.wordVotes.set(key, {
        wordNormalized: key,
        originalSample: tok.originalText,
        voteWeightSum: textWeight,
        confidenceWeightedSum: textWeight * tok.confidence,
        voteCount: 1,
        weightedStartFlicksSum: tok.range.start * tsWeight,
        weightedEndFlicksSum: tok.range.end * tsWeight,
        timestampWeightSum: tsWeight,
      });
    } else {
      existing.voteWeightSum += textWeight;
      existing.confidenceWeightedSum += textWeight * tok.confidence;
      existing.voteCount++;
      existing.weightedStartFlicksSum += tok.range.start * tsWeight;
      existing.weightedEndFlicksSum += tok.range.end * tsWeight;
      existing.timestampWeightSum += tsWeight;
    }
  }

  private static getSlotLeadingWord(slot: RoverWtnSlot): string {
    let bestWord = '';
    let bestScore = -1;
    for (const acc of slot.wordVotes.values()) {
      if (acc.voteWeightSum > bestScore) {
        bestScore = acc.voteWeightSum;
        bestWord = acc.wordNormalized;
      }
    }
    return bestWord;
  }
}
