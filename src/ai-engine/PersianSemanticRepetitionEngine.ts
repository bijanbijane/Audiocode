import { TimedPersianToken } from './PersianTextNormalizer';
import { TimeMath, TimeRange } from '../contracts/timebase.contract';

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
 * combining light Persian morphological stemming, Jaccard stem overlap, and 3-gram cosine similarity.
 */
export class PersianSemanticRepetitionEngine {
  private static readonly STOP_WORDS = new Set([
    'و', 'در', 'به', 'از', 'که', 'این', 'آن', 'را', 'با', 'برای', 'تا', 'هم', 'بر', 'یا',
    'یک', 'ما', 'من', 'شما', 'او', 'آنها', 'ایشان', 'ولی', 'اما', 'چون', 'اگر', 'هر',
  ]);

  public static detectSemanticRetakes(
    tokens: readonly TimedPersianToken[],
    maxWindowSecondsBetweenTakes = 18.0,
    similarityThreshold = 0.54,
  ): SemanticRetakeCandidate[] {
    if (tokens.length < 2) return [];

    const clauses = this.segmentTokensIntoClauses(tokens);
    const candidates: SemanticRetakeCandidate[] = [];

    for (let i = 0; i < clauses.length - 1; i++) {
      const take1 = clauses[i];
      if (take1.contentStems.length < 3) continue;

      // Inspect up to 3 subsequent clauses on the same speaker track within maxWindowSecondsBetweenTakes
      for (let j = i + 1; j <= Math.min(clauses.length - 1, i + 3); j++) {
        const take2 = clauses[j];
        if (take2.trackId !== take1.trackId) continue;
        if (take2.contentStems.length < 3) continue;

        const gapSeconds = TimeMath.flicksToSeconds(take2.range.start - take1.range.end);
        if (gapSeconds < 0) continue;
        if (gapSeconds > maxWindowSecondsBetweenTakes) break;

        const stemSim = this.computeJaccardSimilarity(take1.contentStems, take2.contentStems);
        const trigramSim = this.computeCosineSimilarity(take1.charTrigrams, take2.charTrigrams);
        const combinedSimilarity = 0.55 * stemSim + 0.45 * trigramSim;

        if (combinedSimilarity >= similarityThreshold) {
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
      const gapMs = TimeMath.flicksToSeconds(curr.range.start - prev.range.end) * 1000;

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
        start: group[0].range.start,
        end: group[group.length - 1].range.end,
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
