import { PersianTextNormalizer } from '../PersianTextNormalizer';

export interface AsrErrorBreakdownReport {
  readonly referenceWordCount: number;
  readonly hypothesisWordCount: number;
  readonly hits: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly werPercent: number;
  readonly cerPercent: number;
  readonly topWordSubstitutions: { expected: string; predicted: string; count: number }[];
}

export class DetailedAsrErrorBreakdownEvaluator {
  /**
   * Computes full Word Error Rate (WER with S/D/I breakdown) and Character Error Rate (CER) on normalized Persian text.
   */
  public static evaluateDetailedBreakdown(
    referenceText: string,
    hypothesisText: string,
    normalizeBeforeCompare: boolean = true
  ): AsrErrorBreakdownReport {
    const prep = (txt: string) =>
      (normalizeBeforeCompare ? PersianTextNormalizer.normalizeTokenText(txt) : txt)
        .replace(/[،؛.!؟«»"()\-:]/g, ' ')
        .trim();

    const refClean = prep(referenceText);
    const hypClean = prep(hypothesisText);

    const refWords = refClean.split(/\s+/).filter(Boolean);
    const hypWords = hypClean.split(/\s+/).filter(Boolean);

    const wordAlign = this.computeLevenshteinBreakdown(refWords, hypWords);

    // Count most frequent word substitution pairs for confusion matrix curation
    const subPairs = new Map<string, number>();
    for (const pair of wordAlign.substitutionPairs) {
      const key = `${pair.expected}\t${pair.predicted}`;
      subPairs.set(key, (subPairs.get(key) ?? 0) + 1);
    }

    const topWordSubstitutions = Array.from(subPairs.entries())
      .map(([k, count]) => {
        const [expected, predicted] = k.split('\t');
        return { expected, predicted, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Compute Character Error Rate (CER) for Persian orthographic/ZWNJ error analysis
    const refChars = Array.from(refClean.replace(/\s+/g, ' '));
    const hypChars = Array.from(hypClean.replace(/\s+/g, ' '));
    const charAlign = this.computeLevenshteinBreakdown(refChars, hypChars);

    const werPercent =
      refWords.length > 0
        ? ((wordAlign.substitutions + wordAlign.deletions + wordAlign.insertions) /
            refWords.length) *
          100
        : hypWords.length === 0
        ? 0
        : 100;

    const cerPercent =
      refChars.length > 0
        ? ((charAlign.substitutions + charAlign.deletions + charAlign.insertions) /
            refChars.length) *
          100
        : hypChars.length === 0
        ? 0
        : 100;

    return {
      referenceWordCount: refWords.length,
      hypothesisWordCount: hypWords.length,
      hits: wordAlign.hits,
      substitutions: wordAlign.substitutions,
      deletions: wordAlign.deletions,
      insertions: wordAlign.insertions,
      werPercent: Number(werPercent.toFixed(2)),
      cerPercent: Number(cerPercent.toFixed(2)),
      topWordSubstitutions,
    };
  }

  private static computeLevenshteinBreakdown(
    ref: string[],
    hyp: string[]
  ): {
    hits: number;
    substitutions: number;
    deletions: number;
    insertions: number;
    substitutionPairs: { expected: string; predicted: string }[];
  } {
    const n = ref.length;
    const m = hyp.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    // 0 = match/sub, 1 = deletion, 2 = insertion
    const ops = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

    for (let i = 1; i <= n; i++) {
      dp[i][0] = i * 3;
      ops[i][0] = 1;
    }
    for (let j = 1; j <= m; j++) {
      dp[0][j] = j * 3;
      ops[0][j] = 2;
    }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const isMatch = ref[i - 1] === hyp[j - 1];
        // Standard NIST sclite alignment weights: Hit=0, Del=3, Ins=3, Sub=4
        const subCost = dp[i - 1][j - 1] + (isMatch ? 0 : 4);
        const delCost = dp[i - 1][j] + 3;
        const insCost = dp[i][j - 1] + 3;

        if (subCost <= delCost && subCost <= insCost) {
          dp[i][j] = subCost;
          ops[i][j] = 0;
        } else if (delCost <= insCost) {
          dp[i][j] = delCost;
          ops[i][j] = 1;
        } else {
          dp[i][j] = insCost;
          ops[i][j] = 2;
        }
      }
    }

    let hits = 0;
    let substitutions = 0;
    let deletions = 0;
    let insertions = 0;
    const substitutionPairs: { expected: string; predicted: string }[] = [];

    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const op = ops[i][j];
      if (i > 0 && j > 0 && op === 0) {
        if (ref[i - 1] === hyp[j - 1]) {
          hits++;
        } else {
          substitutions++;
          substitutionPairs.push({ expected: ref[i - 1], predicted: hyp[j - 1] });
        }
        i--;
        j--;
      } else if (i > 0 && (j === 0 || op === 1)) {
        deletions++;
        i--;
      } else {
        insertions++;
        j--;
      }
    }

    return { hits, substitutions, deletions, insertions, substitutionPairs };
  }
}
