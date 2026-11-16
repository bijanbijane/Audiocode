import { TimedPersianToken } from './PersianTextNormalizer';

/**
 * Bidirectional Persian Numeral & Currency Verbalizer and Display Formatter
 * (Architecture Doc Sections 26 & 27)
 * 1. Expands digits (e.g., 1405) into spoken Persian words («هزار و چهارصد و پنج»)
 *    for feeding into the CTC Forced Aligner (Section 48).
 * 2. Formats spoken/colloquial Persian number sequences (e.g., «پونصد میلیون تومن»)
 *    into standardized Persian digits with thousand separators («۵۰۰٬۰۰۰٬۰۰۰ تومان»)
 *    in the Display Transcript layer while preserving originalText and TimeRange.
 */
export class PersianNumeralAndCurrencyNormalizer {
  private static readonly ONES = [
    '', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه',
    'ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده',
  ];

  private static readonly TENS = [
    '', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود',
  ];

  private static readonly HUNDREDS = [
    '', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد',
  ];

  /** Spoken & colloquial Persian number word values */
  private static readonly SPOKEN_WORD_TO_VALUE: Readonly<Record<string, number>> = {
    صفر: 0, یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, چار: 4, پنج: 5,
    شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10,
    یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, چارده: 14,
    پانزده: 15, پونزده: 15, شانزده: 16, شونزده: 16, هفده: 17, هجده: 18, هفده_هجده: 18, نوزده: 19,
    بیست: 20, سی: 30, چهل: 40, چل: 40, پنجاه: 50, شصت: 60, هفتاد: 70, هشتاد: 80, نود: 90,
    صد: 100, یکصد: 100, دویست: 200, سیصد: 300, چهارصد: 400, چارصد: 400,
    پانصد: 500, پونصد: 500, ششصد: 600, شیشصد: 600, هفتصد: 700, هشتصد: 800, نهصد: 900,
  };

  private static readonly SCALE_MULTIPLIERS: Readonly<Record<string, number>> = {
    هزار: 1_000,
    میلیون: 1_000_000,
    ملیون: 1_000_000,
    میلیارد: 1_000_000_000,
  };

  /**
   * 1. Converts a non-negative integer into standard spoken Persian words.
   */
  public static numberToPersianSpokenWords(num: number): string {
    if (!Number.isFinite(num) || num < 0) return String(num);
    const n = Math.floor(num);
    if (n === 0) return 'صفر';

    const parts: string[] = [];
    const billions = Math.floor(n / 1_000_000_000);
    const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
    const thousands = Math.floor((n % 1_000_000) / 1_000);
    const remainder = n % 1_000;

    if (billions > 0) {
      parts.push(`${this.threeDigitToWords(billions)} میلیارد`);
    }
    if (millions > 0) {
      parts.push(`${this.threeDigitToWords(millions)} میلیون`);
    }
    if (thousands > 0) {
      parts.push(
        thousands === 1 ? 'هزار' : `${this.threeDigitToWords(thousands)} هزار`,
      );
    }
    if (remainder > 0) {
      parts.push(this.threeDigitToWords(remainder));
    }

    return parts.join(' و ');
  }

  /**
   * 2. Formats multi-token spoken numbers (e.g., [«هزار»، «و»، «چهارصد»، «و»، «پنج»])
   * into Persian numerals («۱۴۰۵» or «۵۰۰٬۰۰۰٬۰۰۰ تومان») strictly in the Display layer
   * while preserving originalText and exact TimeRange boundaries.
   */
  public static formatSpokenNumbersInDisplayLayer(
    tokens: readonly TimedPersianToken[],
  ): TimedPersianToken[] {
    const result: TimedPersianToken[] = [];
    let i = 0;

    while (i < tokens.length) {
      const parsedSpan = this.tryParseSpokenNumberSequence(tokens, i);
      if (parsedSpan && parsedSpan.tokenCount >= 2) {
        const slice = tokens.slice(i, i + parsedSpan.tokenCount);
        const formattedPersianDigits = this.formatWithPersianDigits(
          parsedSpan.numericValue,
          parsedSpan.numericValue >= 10000,
        );

        result.push({
          tokenId: slice.map((t) => t.tokenId).join('+'),
          trackId: slice[0].trackId,
          originalText: slice.map((t) => t.originalText).join(' '),
          normalizedText: slice.map((t) => t.normalizedText).join(' '),
          displayText:
            formattedPersianDigits +
            (parsedSpan.currencySuffix ? ` ${parsedSpan.currencySuffix}` : ''),
          range: {
            start: slice[0].range.start,
            end: slice[slice.length - 1].range.end,
          },
          confidence:
            slice.reduce((acc, t) => acc + t.confidence, 0) / slice.length,
        });

        i += parsedSpan.tokenCount;
      } else {
        const tok = tokens[i];
        const displayFixed =
          tok.normalizedText === 'تومن' ? 'تومان' : tok.displayText;
        result.push({ ...tok, displayText: displayFixed });
        i++;
      }
    }

    return result;
  }

  private static tryParseSpokenNumberSequence(
    tokens: readonly TimedPersianToken[],
    startIdx: number,
  ): { numericValue: number; tokenCount: number; currencySuffix?: string } | null {
    let total = 0;
    let currentGroup = 0;
    let count = 0;
    let hasAtLeastOneNumber = false;

    for (let k = startIdx; k < tokens.length; k++) {
      const w = tokens[k].normalizedText;

      if (w === 'و' && hasAtLeastOneNumber && k + 1 < tokens.length) {
        const nextW = tokens[k + 1].normalizedText;
        if (
          this.SPOKEN_WORD_TO_VALUE[nextW] !== undefined ||
          this.SCALE_MULTIPLIERS[nextW] !== undefined
        ) {
          count++;
          continue;
        }
        break;
      }

      if (this.SPOKEN_WORD_TO_VALUE[w] !== undefined) {
        currentGroup += this.SPOKEN_WORD_TO_VALUE[w];
        hasAtLeastOneNumber = true;
        count++;
      } else if (this.SCALE_MULTIPLIERS[w] !== undefined) {
        const mult = this.SCALE_MULTIPLIERS[w];
        total += (currentGroup === 0 ? 1 : currentGroup) * mult;
        currentGroup = 0;
        hasAtLeastOneNumber = true;
        count++;
      } else {
        break;
      }
    }

    if (!hasAtLeastOneNumber) return null;
    const finalValue = total + currentGroup;

    let currencySuffix: string | undefined;
    const nextIdx = startIdx + count;
    if (nextIdx < tokens.length) {
      const nextWord = tokens[nextIdx].normalizedText;
      if (nextWord === 'تومان' || nextWord === 'تومن') {
        currencySuffix = 'تومان';
        count++;
      } else if (nextWord === 'ریال' || nextWord === 'درصد') {
        currencySuffix = nextWord;
        count++;
      }
    }

    return {
      numericValue: finalValue,
      tokenCount: count,
      currencySuffix,
    };
  }

  private static threeDigitToWords(n: number): string {
    const h = Math.floor(n / 100);
    const rem = n % 100;
    const parts: string[] = [];

    if (h > 0) parts.push(this.HUNDREDS[h]);
    if (rem > 0) {
      if (rem < 20) {
        parts.push(this.ONES[rem]);
      } else {
        const t = Math.floor(rem / 10);
        const o = rem % 10;
        parts.push(this.TENS[t]);
        if (o > 0) parts.push(this.ONES[o]);
      }
    }
    return parts.join(' و ');
  }

  public static formatWithPersianDigits(
    num: number,
    useThousandSeparator = false,
  ): string {
    const raw = useThousandSeparator
      ? num.toLocaleString('en-US').replace(/,/g, '٬')
      : String(num);
    return raw.replace(/[0-9]/g, (d) =>
      String.fromCharCode(d.charCodeAt(0) + 1728),
    );
  }
}
