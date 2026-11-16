/**
 * @file src/ai-engine/asr/PersianTopicAndKeywordIndexer.ts
 * @description Section 141: Local Persian Multi-Word Keyphrase Extractor (RAKE) & Topic Indexer.
 *              Adapts Rapid Automatic Keyword Extraction (RAKE) to Persian grammar, ZWNJ compounds,
 *              punctuation boundaries, and >600ms acoustic pauses using degree(w)/freq(w) scoring.
 */

import { TimedPersianToken } from '../PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';

export interface ExtractedPersianKeyphrase {
  readonly phraseFa: string;
  readonly rakeScore: number;
  readonly occurrenceCount: number;
  readonly firstAppearanceSeconds: number;
}

export class PersianTopicAndKeywordIndexer {
  /** Persian stopwords, prepositions, conjunctions, and auxiliary verbs that delimit keyphrase boundaries */
  private static readonly PERSIAN_PHRASE_DELIMITERS = new Set([
    'و', 'یا', 'در', 'به', 'از', 'با', 'برای', 'تا', 'که', 'را', 'بر', 'بی', 'درباره', 'مورد',
    'این', 'آن', 'اینها', 'آنها', 'این‌ها', 'آن‌ها', 'هم', 'نیز', 'ولی', 'اما',
    'چون', 'زیرا', 'اگر', 'وقتی', 'هنگامی', 'بنابراین', 'لذا', 'پس', 'حتی', 'فقط',
    'است', 'هست', 'نیست', 'بود', 'شد', 'می‌شود', 'میشود', 'می‌کند', 'میکند', 'می‌کنیم', 'میکنیم', 'صحبت', 'دارد', 'دارند', 'داریم',
    'کرد', 'کرده', 'شده', 'باید', 'نباید', 'بتواند', 'خیلی', 'بسیار', 'یک', 'دو', 'سه',
    'من', 'ما', 'تو', 'شما', 'او', 'ایشان', 'خود', 'همه', 'هر', 'هیچ', 'چه', 'چرا',
  ]);

  /**
   * Extracts ranked multi-word Persian keyphrases from timed ASR tokens using RAKE.
   */
  public static extractPersianKeyphrases(
    tokens: TimedPersianToken[],
    topK: number = 8,
    maxWordsPerPhrase: number = 4,
  ): ExtractedPersianKeyphrase[] {
    if (tokens.length === 0) return [];

    // 1. Segment candidate keyphrases across Persian stopwords, punctuation, and acoustic pauses > 600ms
    const candidatePhrases: { words: string[]; startSec: number }[] = [];
    let currentWords: string[] = [];
    let currentStartSec = 0;

    const flushPhrase = () => {
      if (currentWords.length >= 1 && currentWords.length <= maxWordsPerPhrase) {
        candidatePhrases.push({
          words: [...currentWords],
          startSec: currentStartSec,
        });
      } else if (currentWords.length > maxWordsPerPhrase) {
        for (let i = 0; i < currentWords.length; i += maxWordsPerPhrase) {
          candidatePhrases.push({
            words: currentWords.slice(i, i + maxWordsPerPhrase),
            startSec: currentStartSec,
          });
        }
      }
      currentWords = [];
    };

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const prev = i > 0 ? tokens[i - 1] : null;
      const gapMs = prev
        ? TimeMath.flicksToSeconds(tok.range.start - prev.range.end) * 1000
        : 0;

      if (gapMs > 600 && currentWords.length > 0) {
        flushPhrase();
      }

      const rawDisplay = tok.displayText;
      const hasTrailingPunct = /[،؛.!؟:]$/.test(rawDisplay);
      const cleanNorm = tok.normalizedText
        .replace(/[،؛.!؟:«»"()\-]/g, '')
        .trim();

      if (
        cleanNorm.length < 2 ||
        this.PERSIAN_PHRASE_DELIMITERS.has(cleanNorm)
      ) {
        flushPhrase();
        continue;
      }

      if (currentWords.length === 0) {
        currentStartSec = TimeMath.flicksToSeconds(tok.range.start);
      }
      currentWords.push(cleanNorm);

      if (hasTrailingPunct) {
        flushPhrase();
      }
    }
    flushPhrase();

    if (candidatePhrases.length === 0) return [];

    // 2. Compute word frequency freq(w) and co-occurrence degree(w)
    const wordFreq = new Map<string, number>();
    const wordDegree = new Map<string, number>();

    for (const cand of candidatePhrases) {
      const deg = cand.words.length;
      for (const w of cand.words) {
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
        wordDegree.set(w, (wordDegree.get(w) ?? 0) + deg);
      }
    }

    const wordScore = new Map<string, number>();
    for (const [w, freq] of wordFreq.entries()) {
      const deg = wordDegree.get(w) ?? freq;
      wordScore.set(w, deg / freq);
    }

    // 3. Aggregate phrase scores and sort descending
    const phraseStats = new Map<
      string,
      { score: number; count: number; firstSec: number; wordLen: number }
    >();

    for (const cand of candidatePhrases) {
      const phraseStr = cand.words.join(' ');
      let sumScore = 0;
      for (const w of cand.words) {
        sumScore += wordScore.get(w) ?? 0;
      }
      const multiWordBonus = cand.words.length >= 2 ? 1.15 : 1.0;
      const finalScore = sumScore * multiWordBonus;

      const existing = phraseStats.get(phraseStr);
      if (!existing) {
        phraseStats.set(phraseStr, {
          score: finalScore,
          count: 1,
          firstSec: cand.startSec,
          wordLen: cand.words.length,
        });
      } else {
        existing.count++;
      }
    }

    return Array.from(phraseStats.entries())
      .map(([phraseFa, st]) => ({
        phraseFa,
        rakeScore: Number(
          (st.score * (1 + Math.log2(st.count) * 0.25)).toFixed(2),
        ),
        occurrenceCount: st.count,
        firstAppearanceSeconds: Number(st.firstSec.toFixed(2)),
      }))
      .sort((a, b) => b.rakeScore - a.rakeScore)
      .slice(0, topK);
  }
}
