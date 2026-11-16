import { TimedPersianToken, PersianTextNormalizer } from './PersianTextNormalizer';
import { CustomPersianLexiconManager } from './CustomPersianLexiconManager';
import { TimeRange } from '../contracts/timebase.contract';

export interface TranscriptSearchHit {
  readonly matchType: 'EXACT_NORMALIZED' | 'HOMOPHONE_PHONETIC' | 'PREFIX_PARTIAL';
  readonly matchedTokenIds: string[];
  readonly matchedDisplayText: string;
  readonly audioRange: TimeRange;
  readonly relevanceScore: number;
}

/**
 * Instant Phonetic, ZWNJ-Tolerant & Phrase Transcript Search Engine (Sections 2.1, 27 & 51)
 * Builds an inverted index over Persian phonetic skeletons so multi-hour projects resolve
 * exact, homophone (ت/ط، س/ص/ث، ز/ذ/ض/ظ، ق/غ، ه/ح), and prefix queries in sub-millisecond time.
 */
export class PersianPhoneticTranscriptSearchEngine {
  private tokens: TimedPersianToken[] = [];
  private phoneticSkeletons: string[] = [];
  private skeletonInvertedIndex = new Map<string, number[]>();
  private adjacentBigramIndex = new Map<string, number[]>();

  public indexTranscript(tokens: readonly TimedPersianToken[]): void {
    this.tokens = [...tokens];
    this.phoneticSkeletons = new Array(tokens.length);
    this.skeletonInvertedIndex.clear();
    this.adjacentBigramIndex.clear();

    for (let i = 0; i < tokens.length; i++) {
      const skel = CustomPersianLexiconManager.toPersianPhoneticSkeleton(
        tokens[i].normalizedText,
      );
      this.phoneticSkeletons[i] = skel;

      const list = this.skeletonInvertedIndex.get(skel);
      if (list) {
        list.push(i);
      } else {
        this.skeletonInvertedIndex.set(skel, [i]);
      }

      if (i > 0) {
        const joinedSkel = this.phoneticSkeletons[i - 1] + skel;
        if (joinedSkel.length > 0) {
          const bigramList = this.adjacentBigramIndex.get(joinedSkel);
          if (bigramList) {
            bigramList.push(i - 1);
          } else {
            this.adjacentBigramIndex.set(joinedSkel, [i - 1]);
          }
        }
      }
    }
  }

  /**
   * Searches single words or multi-word Persian phrases across normalized, homophone-phonetic,
   * ZWNJ-joined/split variants, and prefix matches.
   */
  public searchPhrase(query: string, maxResults = 50): TranscriptSearchHit[] {
    if (maxResults <= 0 || this.tokens.length === 0) return [];

    const normalizedQuery = PersianTextNormalizer.normalizeTokenText(query);
    const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryWords.length === 0) return [];

    const querySkeletons = queryWords.map((w) =>
      CustomPersianLexiconManager.toPersianPhoneticSkeleton(w),
    );
    if (querySkeletons.some((s) => s.length === 0)) return [];

    const firstSkel = querySkeletons[0];
    const phraseLen = queryWords.length;
    const matchedStartSet = new Set<number>();
    const hits: TranscriptSearchHit[] = [];

    // 1. Direct token-aligned candidates (exact inverted bucket first, then prefix scan)
    const candidateStartIndices = new Set<number>();
    const exactBucket = this.skeletonInvertedIndex.get(firstSkel);
    if (exactBucket) {
      for (const idx of exactBucket) candidateStartIndices.add(idx);
    }

    if (firstSkel.length >= 2) {
      for (let i = 0; i <= this.tokens.length - phraseLen; i++) {
        if (this.phoneticSkeletons[i].startsWith(firstSkel)) {
          candidateStartIndices.add(i);
        }
      }
    }

    for (const startIdx of candidateStartIndices) {
      if (startIdx + phraseLen > this.tokens.length) continue;

      let allExactNormalized = true;
      let allPhoneticMatch = true;
      let allPrefixMatch = true;

      for (let k = 0; k < phraseLen; k++) {
        const tok = this.tokens[startIdx + k];
        const tokSkel = this.phoneticSkeletons[startIdx + k];
        const qWord = queryWords[k];
        const qSkel = querySkeletons[k];

        if (tok.normalizedText !== qWord) allExactNormalized = false;
        if (tokSkel !== qSkel) allPhoneticMatch = false;
        if (!tokSkel.startsWith(qSkel)) {
          allPrefixMatch = false;
          break;
        }
      }

      if (!allPrefixMatch) continue;

      matchedStartSet.add(startIdx);
      const matchedSlice = this.tokens.slice(startIdx, startIdx + phraseLen);
      const matchType = allExactNormalized
        ? 'EXACT_NORMALIZED'
        : allPhoneticMatch
          ? 'HOMOPHONE_PHONETIC'
          : 'PREFIX_PARTIAL';

      const relevanceScore =
        matchType === 'EXACT_NORMALIZED'
          ? 1.0
          : matchType === 'HOMOPHONE_PHONETIC'
            ? 0.92
            : 0.75;

      hits.push({
        matchType,
        matchedTokenIds: matchedSlice.map((t) => t.tokenId),
        matchedDisplayText: matchedSlice.map((t) => t.displayText).join(' '),
        audioRange: {
          start: matchedSlice[0].range.start,
          end: matchedSlice[matchedSlice.length - 1].range.end,
        },
        relevanceScore,
      });
    }

    // 2. ZWNJ / split-compound tolerance:
    //    - 1-word query matching 2 adjacent split tokens (e.g. "می‌خواهم" -> ["می", "خواهم"])
    //    - 2-word query matching 1 joined token (e.g. "می خواهم" -> ["می‌خواهم"])
    if (phraseLen === 1) {
      const splitMatches = this.adjacentBigramIndex.get(firstSkel);
      if (splitMatches) {
        for (const startIdx of splitMatches) {
          if (matchedStartSet.has(startIdx) || startIdx + 1 >= this.tokens.length) continue;
          const pair = [this.tokens[startIdx], this.tokens[startIdx + 1]];
          hits.push({
            matchType: 'HOMOPHONE_PHONETIC',
            matchedTokenIds: pair.map((t) => t.tokenId),
            matchedDisplayText: pair.map((t) => t.displayText).join(' '),
            audioRange: { start: pair[0].range.start, end: pair[1].range.end },
            relevanceScore: 0.89,
          });
        }
      }
    } else if (phraseLen === 2) {
      const joinedQuerySkel = querySkeletons.join('');
      const singleMatches = this.skeletonInvertedIndex.get(joinedQuerySkel);
      if (singleMatches) {
        for (const idx of singleMatches) {
          if (matchedStartSet.has(idx)) continue;
          const tok = this.tokens[idx];
          hits.push({
            matchType: 'HOMOPHONE_PHONETIC',
            matchedTokenIds: [tok.tokenId],
            matchedDisplayText: tok.displayText,
            audioRange: { start: tok.range.start, end: tok.range.end },
            relevanceScore: 0.89,
          });
        }
      }
    }

    return hits
      .sort((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) {
          return b.relevanceScore - a.relevanceScore;
        }
        return a.audioRange.start - b.audioRange.start;
      })
      .slice(0, maxResults);
  }
}
