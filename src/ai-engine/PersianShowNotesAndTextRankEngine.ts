import { TimedPersianToken } from './PersianTextNormalizer';
import { TimeMath, TimeRange } from '../contracts/timebase.contract';

export interface KeyTakeawaySentence {
  readonly rank: number;
  readonly textFa: string;
  readonly range: TimeRange;
  readonly timestampFormatted: string;
  readonly textRankScore: number;
}

export interface DetectedPersianNamedEntity {
  readonly entityType: 'PERSON' | 'ORGANIZATION_OR_INSTITUTE' | 'WORK_OR_BOOK' | 'LOCATION';
  readonly entityNameFa: string;
  readonly firstMentionTimestamp: string;
  readonly firstMentionRange: TimeRange;
  readonly mentionCount: number;
}

/**
 * Local Persian Show-Notes, TextRank Extractive Summarizer & Named-Entity Indexer
 * (Architecture Doc Sections 2.6 & 3)
 * 1. Runs 15 iterations of PageRank/TextRank over sentence lexical similarity graphs with
 *    Persian discourse importance markers to extract top timestamped key takeaways locally.
 * 2. Detects Persian named entities (People, Organizations, Books/Works, Locations) with
 *    first-mention timestamps and mention counts.
 */
export class PersianShowNotesAndTextRankEngine {
  private static readonly DISCOURSE_IMPORTANCE_MARKERS = [
    'مهمترین',
    'مهم‌ترین',
    'نتیجه',
    'خلاصه',
    'اصلیترین',
    'اصلی‌ترین',
    'نکته کلیدی',
    'به عبارت دیگر',
    'در واقع دلیل',
    'جمعبندی',
    'جمع‌بندی',
  ];

  private static readonly PERSON_PREFIXES = new Set([
    'دکتر', 'مهندس', 'استاد', 'آقای', 'خانم', 'پروفسور', 'سید', 'حاج',
  ]);

  private static readonly ORG_PREFIXES = new Set([
    'شرکت', 'دانشگاه', 'سازمان', 'مؤسسه', 'موسسه', 'وزارت', 'بانک', 'استارتاپ', 'پلتفرم',
  ]);

  private static readonly BOOK_PREFIXES = new Set([
    'کتاب', 'مقاله', 'رساله', 'پادکست', 'فیلم', 'مستند', 'سند',
  ]);

  private static readonly LOCATION_PREFIXES = new Set([
    'شهر', 'استان', 'کشور', 'منطقه', 'خیابان', 'میدان',
  ]);

  /**
   * Extracts top K key takeaway sentences using local TextRank power iteration.
   */
  public static extractTopKeyTakeaways(
    tokens: readonly TimedPersianToken[],
    topK = 5,
  ): KeyTakeawaySentence[] {
    const validTokens = tokens.filter(
      (t) => Number.isFinite(t.range.start) && Number.isFinite(t.range.end),
    );
    const sentences = this.splitIntoSentences(validTokens);
    const n = sentences.length;
    if (n === 0 || !Number.isFinite(topK) || topK <= 0) return [];
    const safeTopK = Math.floor(topK);

    const weights: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
    const rowSums = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = this.computeTermOverlapSimilarity(sentences[i].terms, sentences[j].terms);
        if (sim > 0.05) {
          weights[i][j] = sim;
          weights[j][i] = sim;
          rowSums[i] += sim;
          rowSums[j] += sim;
        }
      }
    }

    const damping = 0.85;
    const scores = new Float64Array(n).fill(1.0 / n);
    const nextScores = new Float64Array(n);

    for (let iter = 0; iter < 15; iter++) {
      for (let i = 0; i < n; i++) {
        let incomingSum = 0;
        for (let j = 0; j < n; j++) {
          if (i !== j && rowSums[j] > 0) {
            incomingSum += (weights[j][i] / rowSums[j]) * scores[j];
          }
        }
        const markerBoost = this.DISCOURSE_IMPORTANCE_MARKERS.some((m) =>
          sentences[i].textFa.includes(m),
        )
          ? 1.35
          : 1.0;

        nextScores[i] = ((1.0 - damping) / n + damping * incomingSum) * markerBoost;
      }
      scores.set(nextScores);
    }

    return sentences
      .map((s, idx) => ({
        ...s,
        score: scores[idx],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, safeTopK)
      .sort((a, b) => a.range.start - b.range.start)
      .map((item, rankIdx) => ({
        rank: rankIdx + 1,
        textFa: item.textFa,
        range: item.range,
        timestampFormatted: this.formatTimestamp(
          TimeMath.flicksToSeconds(item.range.start),
        ),
        textRankScore: Number(item.score.toFixed(4)),
      }));
  }

  /**
   * Extracts Persian Named Entities (People, Organizations, Books/Works, Locations) with first-mention timestamps.
   */
  public static extractNamedEntitiesWithTimestamps(
    tokens: readonly TimedPersianToken[],
  ): DetectedPersianNamedEntity[] {
    const validTokens = tokens.filter(
      (t) => Number.isFinite(t.range.start) && Number.isFinite(t.range.end),
    );
    const entityMap = new Map<
      string,
      {
        type: DetectedPersianNamedEntity['entityType'];
        name: string;
        firstRange: TimeRange;
        count: number;
      }
    >();

    for (let i = 0; i < validTokens.length - 1; i++) {
      const prefix = validTokens[i].normalizedText.replace(/[،؛.!؟]/g, '');
      let entityType: DetectedPersianNamedEntity['entityType'] | null = null;

      if (this.PERSON_PREFIXES.has(prefix)) {
        entityType = 'PERSON';
      } else if (this.ORG_PREFIXES.has(prefix)) {
        entityType = 'ORGANIZATION_OR_INSTITUTE';
      } else if (this.BOOK_PREFIXES.has(prefix)) {
        entityType = 'WORK_OR_BOOK';
      } else if (this.LOCATION_PREFIXES.has(prefix)) {
        entityType = 'LOCATION';
      }

      if (!entityType) continue;

      const cleanDisplay = (s: string) => s.replace(/[،؛.!؟«»"]/g, '');
      const nameParts: string[] = [
        cleanDisplay(validTokens[i].displayText),
        cleanDisplay(validTokens[i + 1].displayText),
      ];
      let endRange = validTokens[i + 1].range.end;

      if (
        i + 2 < validTokens.length &&
        validTokens[i + 2].normalizedText.length > 2 &&
        TimeMath.flicksToSeconds(validTokens[i + 2].range.start - validTokens[i + 1].range.end) < 0.25
      ) {
        nameParts.push(cleanDisplay(validTokens[i + 2].displayText));
        endRange = validTokens[i + 2].range.end;
      }

      const fullEntityName = nameParts.filter(Boolean).join(' ');
      const existing = entityMap.get(fullEntityName);
      if (existing) {
        existing.count++;
      } else {
        entityMap.set(fullEntityName, {
          type: entityType,
          name: fullEntityName,
          firstRange: { start: validTokens[i].range.start, end: endRange },
          count: 1,
        });
      }
    }

    return Array.from(entityMap.values())
      .sort((a, b) => b.count - a.count)
      .map((e) => ({
        entityType: e.type,
        entityNameFa: e.name,
        firstMentionRange: e.firstRange,
        firstMentionTimestamp: this.formatTimestamp(
          TimeMath.flicksToSeconds(e.firstRange.start),
        ),
        mentionCount: e.count,
      }));
  }

  private static splitIntoSentences(
    tokens: readonly TimedPersianToken[],
  ): { textFa: string; range: TimeRange; terms: string[] }[] {
    const out: { textFa: string; range: TimeRange; terms: string[] }[] = [];
    let group: TimedPersianToken[] = [];

    for (let i = 0; i < tokens.length; i++) {
      group.push(tokens[i]);
      const next = tokens[i + 1];
      const gapSec = next
        ? TimeMath.flicksToSeconds(next.range.start - tokens[i].range.end)
        : 999;

      if ((gapSec >= 0.5 || /[.!؟]$/.test(tokens[i].displayText)) && group.length >= 5) {
        out.push({
          textFa: group.map((t) => t.displayText).join(' '),
          range: { start: group[0].range.start, end: group[group.length - 1].range.end },
          terms: group
            .map((t) => t.normalizedText.replace(/[،؛.!؟]/g, ''))
            .filter((w) => w.length > 2),
        });
        group = [];
      }
    }

    if (group.length > 0 && out.length === 0) {
      out.push({
        textFa: group.map((t) => t.displayText).join(' '),
        range: { start: group[0].range.start, end: group[group.length - 1].range.end },
        terms: group
          .map((t) => t.normalizedText.replace(/[،؛.!؟]/g, ''))
          .filter((w) => w.length > 2),
      });
    }

    return out;
  }

  private static computeTermOverlapSimilarity(termsA: string[], termsB: string[]): number {
    if (termsA.length === 0 || termsB.length === 0) return 0;
    const setB = new Set(termsB);
    let shared = 0;
    for (const w of termsA) {
      if (setB.has(w)) shared++;
    }
    return shared / (Math.log(termsA.length + 1) + Math.log(termsB.length + 1) + 1e-6);
  }

  private static formatTimestamp(sec: number): string {
    const safeSec = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    const hrs = Math.floor(safeSec / 3600);
    const mins = Math.floor((safeSec % 3600) / 60);
    const secs = Math.floor(safeSec % 60);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
}
