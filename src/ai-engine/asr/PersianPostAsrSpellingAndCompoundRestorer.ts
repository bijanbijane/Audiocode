import { TimedPersianToken } from '../PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';

export interface BilingualTermMapping {
  readonly spokenPersianTokens: string[];
  readonly canonicalDisplayTerm: string;
}

/**
 * Section 110: Post-ASR Persian Compound Word, ZWNJ Prefix/Suffix & Bilingual Technical Term Restorer
 * Merges split tokens only when acoustic inter-token silence is <= maxMergeGapMs (180ms),
 * preserving immutable originalText and exact Flicks time spans.
 */
export class PersianPostAsrSpellingAndCompoundRestorer {
  private static readonly ZWNJ = '\u200c';

  /** Prefixes that attach to the following word via ZWNJ when inter-word gap <= 180ms */
  private static readonly ATTACHABLE_PREFIXES = new Set([
    'می',
    'نمی',
    'بی',
    'نا',
    'هم',
    'پسا',
    'پیش',
    'فرا',
    'ضد',
    'غیر',
    'فوق',
    'نیمه',
  ]);

  /** Suffixes that attach to the preceding word via ZWNJ when split by ASR */
  private static readonly ATTACHABLE_SUFFIXES = new Set([
    'ها',
    'های',
    'هایی',
    'هایم',
    'هایت',
    'هایش',
    'هایمان',
    'هایتان',
    'هایشان',
    'تر',
    'ترین',
    'ام',
    'ات',
    'اش',
    'ایم',
    'اید',
    'اند',
    'سازی',
    'گذاری',
    'پذیری',
    'شناسی',
    'نگاری',
    'بندی',
    'گرایی',
    'مند',
    'وار',
    'گونه',
  ]);

  /** High-frequency Persian compound bigrams commonly split by ASR models */
  private static readonly COMPOUND_BIGRAM_MAP: Readonly<Record<string, string>> = {
    'این\tجا': 'اینجا',
    'آن\tجا': 'آنجا',
    'هم\tاینجا': 'همین\u200cجا',
    'هیچ\tکس': 'هیچ\u200cکس',
    'همه\tچیز': 'همه\u200cچیز',
    'هیچ\tچیز': 'هیچ\u200cچیز',
    'کتاب\tخانه': 'کتاب\u200cخانه',
    'نرم\tافزار': 'نرم\u200cافزار',
    'سخت\tافزار': 'سخت\u200cافزار',
    'پایگاه\tداده': 'پایگاه\u200cداده',
    'برنامه\tنویسی': 'برنامه\u200cنویسی',
    'هوش\tمصنوعی': 'هوش مصنوعی',
    'گفت\tوگو': 'گفت\u200cوگو',
    'جست\tوجو': 'جست\u200cوجو',
    'پدر\tبزرگ': 'پدربزرگ',
    'مادر\tبزرگ': 'مادربزرگ',
    'دانش\tگاه': 'دانشگاه',
    'دانش\tآموز': 'دانش\u200cآموز',
    'دانش\tجو': 'دانشجو',
    'راه\tاندازی': 'راه\u200cاندازی',
    'بروز\tرسانی': 'به\u200cروزرسانی',
  };

  private readonly bilingualTerms: BilingualTermMapping[] = [
    { spokenPersianTokens: ['ای', 'پی', 'آی'], canonicalDisplayTerm: 'API' },
    { spokenPersianTokens: ['فست', 'ای', 'پی', 'آی'], canonicalDisplayTerm: 'FastAPI' },
    { spokenPersianTokens: ['وب', 'اسمبلی'], canonicalDisplayTerm: 'WebAssembly' },
    { spokenPersianTokens: ['وب', 'جی', 'پی', 'یو'], canonicalDisplayTerm: 'WebGPU' },
    { spokenPersianTokens: ['تایپ', 'اسکریپت'], canonicalDisplayTerm: 'TypeScript' },
    { spokenPersianTokens: ['پست', 'گرس'], canonicalDisplayTerm: 'PostgreSQL' },
    { spokenPersianTokens: ['داکر'], canonicalDisplayTerm: 'Docker' },
    { spokenPersianTokens: ['آی', 'او', 'اس'], canonicalDisplayTerm: 'iOS' },
  ];

  public registerCustomBilingualTerms(terms: BilingualTermMapping[]): void {
    this.bilingualTerms.push(...terms);
  }

  /**
   * Restore Persian compound words, ZWNJ prefixes/suffixes, and bilingual terms in ASR tokens
   * while enforcing acoustic contiguity (inter-token gap <= maxMergeGapMs) and preserving provenance
   */
  public restoreCompoundsAndBilingualTerms(
    tokens: TimedPersianToken[],
    maxMergeGapMs: number = 180,
  ): TimedPersianToken[] {
    if (tokens.length <= 1) return tokens;

    const maxGapFlicks = TimeMath.secondsToFlicks(maxMergeGapMs / 1000);
    const pass1Bilingual: TimedPersianToken[] = [];
    let i = 0;

    // Pass 1: Match multi-word spoken technical bilingual terms (e.g., «فست ای پی آی» -> «FastAPI»)
    while (i < tokens.length) {
      let matchedTerm: BilingualTermMapping | null = null;
      for (const term of this.bilingualTerms) {
        const len = term.spokenPersianTokens.length;
        if (i + len > tokens.length) continue;

        let allWordsMatch = true;
        let acousticallyContiguous = true;
        for (let k = 0; k < len; k++) {
          if (tokens[i + k].normalizedText !== term.spokenPersianTokens[k]) {
            allWordsMatch = false;
            break;
          }
          if (
            k > 0 &&
            tokens[i + k].range.start - tokens[i + k - 1].range.end > maxGapFlicks
          ) {
            acousticallyContiguous = false;
            break;
          }
        }

        if (allWordsMatch && acousticallyContiguous) {
          if (!matchedTerm || len > matchedTerm.spokenPersianTokens.length) {
            matchedTerm = term;
          }
        }
      }

      if (matchedTerm) {
        const spanLen = matchedTerm.spokenPersianTokens.length;
        const slice = tokens.slice(i, i + spanLen);
        pass1Bilingual.push(
          this.mergeTokenSlice(
            slice,
            slice.map((t) => t.normalizedText).join(' '),
            matchedTerm.canonicalDisplayTerm,
          ),
        );
        i += spanLen;
      } else {
        pass1Bilingual.push(tokens[i]);
        i++;
      }
    }

    // Pass 2: Reconstruct Persian compounds, detached prefixes, and detached suffixes with ZWNJ
    const finalTokens: TimedPersianToken[] = [];
    let j = 0;

    while (j < pass1Bilingual.length) {
      const curr = pass1Bilingual[j];
      const next = j + 1 < pass1Bilingual.length ? pass1Bilingual[j + 1] : null;

      if (next && next.range.start - curr.range.end <= maxGapFlicks) {
        const bigramKey = `${curr.normalizedText}\t${next.normalizedText}`;

        // A) Deterministic compound dictionary match
        if (PersianPostAsrSpellingAndCompoundRestorer.COMPOUND_BIGRAM_MAP[bigramKey]) {
          const mergedForm =
            PersianPostAsrSpellingAndCompoundRestorer.COMPOUND_BIGRAM_MAP[bigramKey];
          finalTokens.push(this.mergeTokenSlice([curr, next], mergedForm, mergedForm));
          j += 2;
          continue;
        }

        // B) Detached prefix («می خواهم» -> «می‌خواهم»)
        if (
          PersianPostAsrSpellingAndCompoundRestorer.ATTACHABLE_PREFIXES.has(
            curr.normalizedText,
          ) &&
          next.normalizedText.length >= 2
        ) {
          const joined = `${curr.normalizedText}${PersianPostAsrSpellingAndCompoundRestorer.ZWNJ}${next.normalizedText}`;
          finalTokens.push(this.mergeTokenSlice([curr, next], joined, joined));
          j += 2;
          continue;
        }

        // C) Detached suffix («کتاب ها» -> «کتاب‌ها», «برنامه سازی» -> «برنامه‌سازی»)
        if (
          PersianPostAsrSpellingAndCompoundRestorer.ATTACHABLE_SUFFIXES.has(
            next.normalizedText,
          ) &&
          curr.normalizedText.length >= 2
        ) {
          const joined = `${curr.normalizedText}${PersianPostAsrSpellingAndCompoundRestorer.ZWNJ}${next.normalizedText}`;
          finalTokens.push(this.mergeTokenSlice([curr, next], joined, joined));
          j += 2;
          continue;
        }
      }

      finalTokens.push(curr);
      j++;
    }

    return finalTokens;
  }

  private mergeTokenSlice(
    slice: TimedPersianToken[],
    newNormalized: string,
    newDisplay: string,
  ): TimedPersianToken {
    return {
      tokenId: slice.map((t) => t.tokenId).join('+'),
      trackId: slice[0].trackId,
      originalText: slice.map((t) => t.originalText).join(' '),
      normalizedText: newNormalized,
      displayText: newDisplay,
      range: {
        start: slice[0].range.start,
        end: slice[slice.length - 1].range.end,
      },
      confidence: Number(
        (slice.reduce((acc, t) => acc + t.confidence, 0) / slice.length).toFixed(3),
      ),
    };
  }
}
