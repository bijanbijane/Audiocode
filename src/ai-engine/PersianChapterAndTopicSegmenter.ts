import { TimedPersianToken } from './PersianTextNormalizer';
import { TimeMath, TimeRange } from '../contracts/timebase.contract';

export interface PodcastChapterMarker {
  readonly chapterIndex: number;
  readonly range: TimeRange;
  readonly startTimestampFormatted: string; // e.g. "00:14:25"
  readonly suggestedTitleFa: string;
  readonly topKeywordsFa: string[];
}

/**
 * Automatic Persian Topic Chapter Segmenter (Sections 2.1 & 2.6)
 * Combines TextTiling lexical cohesion valleys, boundary acoustic pauses, and cross-chapter
 * TF-IDF keyword extraction to generate podcast/audiobook show-notes chapter markers.
 */
export class PersianChapterAndTopicSegmenter {
  private static readonly STOP_WORDS = new Set([
    'و', 'در', 'به', 'از', 'که', 'این', 'آن', 'را', 'با', 'برای', 'تا', 'هم', 'یا',
    'یک', 'ما', 'من', 'شما', 'او', 'آنها', 'ولی', 'اما', 'چون', 'اگر', 'بود', 'شد',
    'است', 'هست', 'دارد', 'کرد', 'شود', 'کنند', 'بشه', 'باشه', 'داریم', 'دارن', 'خیلی',
    'های', 'هایی', 'میشه', 'کنیم', 'میکنیم', 'می‌کنیم', 'بوده', 'باشند', 'خود', 'همین',
  ]);

  /**
   * Segments transcript tokens into coherent thematic chapters using TextTiling + acoustic pause boundaries.
   */
  public static generateChapters(
    tokens: readonly TimedPersianToken[],
    targetBlockDurationSec = 90.0,
  ): PodcastChapterMarker[] {
    const validTokens = tokens.filter(
      (t) => Number.isFinite(t.range.start) && Number.isFinite(t.range.end),
    );
    if (validTokens.length === 0) return [];
    const safeBlockDurationSec =
      Number.isFinite(targetBlockDurationSec) && targetBlockDurationSec > 0
        ? Math.max(5.0, targetBlockDurationSec)
        : 90.0;

    // 1. Partition tokens into temporal blocks with content-word frequency maps
    const blocks: { tokens: TimedPersianToken[]; termFreq: Map<string, number> }[] = [];
    let currentBlock: TimedPersianToken[] = [];
    let blockStartFlicks = validTokens[0].range.start;

    for (const tok of validTokens) {
      const elapsedFromBlockStartSec = TimeMath.flicksToSeconds(tok.range.start - blockStartFlicks);
      if (currentBlock.length > 0 && elapsedFromBlockStartSec >= safeBlockDurationSec) {
        blocks.push({
          tokens: currentBlock,
          termFreq: this.extractContentWordFrequencies(currentBlock),
        });
        currentBlock = [];
        blockStartFlicks = tok.range.start;
      }
      currentBlock.push(tok);
    }
    if (currentBlock.length > 0) {
      blocks.push({
        tokens: currentBlock,
        termFreq: this.extractContentWordFrequencies(currentBlock),
      });
    }

    // Document frequency across blocks for TF-IDF weighting
    const docFreq = new Map<string, number>();
    for (const blk of blocks) {
      for (const word of blk.termFreq.keys()) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    if (blocks.length === 1) {
      return [this.buildChapterObject(0, blocks[0].tokens, docFreq, blocks.length)];
    }

    // 2. Detect lexical cohesion valleys + acoustic pause reinforcement between adjacent blocks
    const boundaryBlockIndices: number[] = [0];
    for (let i = 0; i < blocks.length - 1; i++) {
      const sim = this.cosineSimilarity(blocks[i].termFreq, blocks[i + 1].termFreq);
      const prevEnd = blocks[i].tokens[blocks[i].tokens.length - 1].range.end;
      const nextStart = blocks[i + 1].tokens[0].range.start;
      const boundaryPauseSec = Math.max(0, TimeMath.flicksToSeconds(nextStart - prevEnd));

      const isLexicalValley = sim < 0.22;
      const isPauseAssistedShift = sim < 0.35 && boundaryPauseSec >= 1.8;

      if (isLexicalValley || isPauseAssistedShift) {
        boundaryBlockIndices.push(i + 1);
      }
    }

    // 3. Build merged chapters with TF-IDF salient keywords
    const chapters: PodcastChapterMarker[] = [];
    for (let c = 0; c < boundaryBlockIndices.length; c++) {
      const startBlk = boundaryBlockIndices[c];
      const endBlk =
        c + 1 < boundaryBlockIndices.length ? boundaryBlockIndices[c + 1] : blocks.length;

      const chapterTokens: TimedPersianToken[] = [];
      for (let b = startBlk; b < endBlk; b++) {
        chapterTokens.push(...blocks[b].tokens);
      }

      if (chapterTokens.length > 0) {
        chapters.push(
          this.buildChapterObject(chapters.length, chapterTokens, docFreq, blocks.length),
        );
      }
    }

    return chapters;
  }

  /**
   * Formats chapter markers as standard Show Notes / YouTube timestamps ("HH:MM:SS - Title").
   */
  public static formatChaptersForShowNotes(chapters: readonly PodcastChapterMarker[]): string {
    return chapters
      .map((ch) => `${ch.startTimestampFormatted} - ${ch.suggestedTitleFa}`)
      .join('\n');
  }

  private static buildChapterObject(
    chapterIndex: number,
    chapterTokens: readonly TimedPersianToken[],
    docFreq: ReadonlyMap<string, number>,
    totalBlocks: number,
  ): PodcastChapterMarker {
    const freqMap = this.extractContentWordFrequencies(chapterTokens);

    const scoredKeywords = Array.from(freqMap.entries())
      .map(([word, tf]) => {
        const df = docFreq.get(word) ?? 1;
        const idf = totalBlocks > 1 ? Math.log((totalBlocks + 1) / (df + 1)) + 1.0 : 1.0;
        return { word, score: tf * idf, tf };
      })
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.tf - a.tf))
      .slice(0, 4)
      .map((entry) => entry.word);

    const startFlicks = chapterTokens[0].range.start;
    const endFlicks = chapterTokens[chapterTokens.length - 1].range.end;
    const startSec = TimeMath.flicksToSeconds(startFlicks);

    const suggestedTitleFa =
      scoredKeywords.length > 0
        ? `بخش ${chapterIndex + 1}: محورهای «${scoredKeywords.slice(0, 3).join('، ')}»`
        : `بخش ${chapterIndex + 1}`;

    return {
      chapterIndex,
      range: { start: startFlicks, end: endFlicks },
      startTimestampFormatted: this.formatHhMmSs(startSec),
      suggestedTitleFa,
      topKeywordsFa: scoredKeywords,
    };
  }

  private static extractContentWordFrequencies(
    tokens: readonly TimedPersianToken[],
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const tok of tokens) {
      const w = tok.normalizedText.replace(/[^\u0621-\u06CC\u200c]/g, '');
      if (w.length < 3 || this.STOP_WORDS.has(w)) continue;
      map.set(w, (map.get(w) ?? 0) + 1);
    }
    return map;
  }

  private static cosineSimilarity(
    a: ReadonlyMap<string, number>,
    b: ReadonlyMap<string, number>,
  ): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (const [k, vA] of a.entries()) {
      magA += vA * vA;
      const vB = b.get(k);
      if (vB !== undefined) dot += vA * vB;
    }
    for (const vB of b.values()) magB += vB * vB;
    return dot / (Math.sqrt(magA * magB) + 1e-12);
  }

  private static formatHhMmSs(totalSeconds: number): string {
    const safeSec = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
    const hrs = Math.floor(safeSec / 3600);
    const mins = Math.floor((safeSec % 3600) / 60);
    const secs = Math.floor(safeSec % 60);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
}
