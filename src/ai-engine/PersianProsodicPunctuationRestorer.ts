import { TimedPersianToken } from './PersianTextNormalizer';
import { SampleRate, TimeMath } from '../contracts/timebase.contract';

export class PersianProsodicPunctuationRestorer {
  private static readonly INTERROGATIVE_WORDS = new Set([
    'آیا',
    'چرا',
    'چطور',
    'چگونه',
    'کجا',
    'کی',
    'کدام',
    'کو',
    'چند',
    'مگر',
    'مگه',
  ]);

  private static readonly CONJUNCTION_AFTER_COMMA = new Set([
    'اما',
    'ولی',
    'چون',
    'زیرا',
    'بنابراین',
    'لذا',
    'بلکه',
    'اگرچه',
    'هرچند',
  ]);

  /**
   * بازسازی علائم نگارشی فارسی (، . ؟) در لایه نمایشی با ترکیب تحلیل آهنگ صدا (F0 Pitch Rise/Fall) و مکث‌ها
   */
  public static restorePunctuationInDisplayLayer(
    tokens: TimedPersianToken[],
    pcmMono: Float32Array,
    sampleRate: SampleRate,
  ): TimedPersianToken[] {
    if (tokens.length === 0) return [];

    const out: TimedPersianToken[] = [];
    let currentClauseHasInterrogative = false;
    let clauseLengthWords = 0;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const nextTok = i + 1 < tokens.length ? tokens[i + 1] : null;
      clauseLengthWords++;

      if (this.INTERROGATIVE_WORDS.has(tok.normalizedText)) {
        currentClauseHasInterrogative = true;
      }

      // حذف علائم نگارشی تکراری احتمالی از انتهای کلمه پیش از تصمیم‌گیری
      const cleanDisplay = tok.displayText.replace(/[،؛.!؟]+$/, '');

      const pauseAfterMs = nextTok
        ? TimeMath.flicksToSeconds(nextTok.range.start - tok.range.end) * 1000
        : 1000;

      const nextIsConjunction =
        nextTok !== null && this.CONJUNCTION_AFTER_COMMA.has(nextTok.normalizedText);

      // ۱. بررسی پایان جمله (مکث بالای ۴۲۰ میلی‌ثانیه یا آخرین کلمه فایل)
      if (pauseAfterMs >= 420 || !nextTok) {
        if (clauseLengthWords >= 2) {
          // محاسبه شیب زیر و بمی صدا (Terminal Pitch Slope) روی کلمه پایانی جمله
          const startSample = TimeMath.flicksToSamplesFloor(tok.range.start, sampleRate);
          const endSample = Math.min(
            pcmMono.length,
            TimeMath.flicksToSamplesFloor(tok.range.end, sampleRate),
          );
          const pitchRiseSemitones = this.measureWordPitchSlopeSemitones(
            pcmMono,
            startSample,
            endSample,
            sampleRate,
          );

          // در زبان فارسی، خیز فرکانس پایه بیش از +2.0 نیم‌پرده در انتهای عبارت یا وجود واژه پرسشی = علامت سؤال (؟)
          const isQuestion =
            currentClauseHasInterrogative || pitchRiseSemitones >= 2.0;
          const punct = isQuestion ? '؟' : '.';

          out.push({
            ...tok,
            displayText: `${cleanDisplay}${punct}`,
          });
        } else {
          out.push(tok);
        }

        currentClauseHasInterrogative = false;
        clauseLengthWords = 0;
        continue;
      }

      // ۲. بررسی ویرگول میانه جمله (مکث ۱۸۰ تا ۴۲۰ میلی‌ثانیه یا قرارگیری قبل از «اما / ولی / چون»)
      if ((pauseAfterMs >= 180 || nextIsConjunction) && clauseLengthWords >= 3) {
        out.push({
          ...tok,
          displayText: `${cleanDisplay}،`,
        });
        clauseLengthWords = 0;
        continue;
      }

      out.push(tok);
    }

    return out;
  }

  /**
   * اندازه‌گیری اختلاف زیر و بمی صدا (نیم‌پرده) بین نیمه اول و نیمه دوم یک کلمه برای تشخیص خیز سؤالی فارسی
   */
  private static measureWordPitchSlopeSemitones(
    pcm: Float32Array,
    startSample: number,
    endSample: number,
    sampleRate: SampleRate,
  ): number {
    const len = endSample - startSample;
    if (len < sampleRate * 0.12) return 0; // کلمات زیر ۱۲۰ میلی‌ثانیه برای سنجش شیب F0 کوتاه‌اند

    const midSample = startSample + (len >> 1);
    const f0FirstHalf = this.estimateQuickF0(pcm, startSample, midSample, sampleRate);
    const f0SecondHalf = this.estimateQuickF0(pcm, midSample, endSample, sampleRate);

    if (f0FirstHalf <= 0 || f0SecondHalf <= 0) return 0;
    return 12.0 * Math.log2(f0SecondHalf / f0FirstHalf);
  }

  private static estimateQuickF0(
    pcm: Float32Array,
    start: number,
    end: number,
    sampleRate: SampleRate,
  ): number {
    const sliceLen = end - start;
    const minLag = Math.floor(sampleRate / 350);
    const maxLag = Math.min(Math.floor(sliceLen / 2), Math.floor(sampleRate / 80));
    if (maxLag <= minLag) return 0;

    const lagCount = maxLag - minLag + 1;
    const corrs = new Float64Array(lagCount);
    const compareLen = sliceLen - maxLag;
    let maxCorr = 0;

    for (let idx = 0; idx < lagCount; idx++) {
      const lag = minLag + idx;
      let dot = 0;
      let e1 = 0;
      let e2 = 0;
      for (let i = 0; i < compareLen; i += 2) {
        const a = pcm[start + i];
        const b = pcm[start + i + lag];
        dot += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      const corr = dot / (Math.sqrt(e1 * e2) + 1e-12);
      corrs[idx] = corr;
      if (corr > maxCorr) {
        maxCorr = corr;
      }
    }

    if (maxCorr < 0.55) return 0;

    // Pick the first strong local peak (>= 85% of global max) to prevent octave-halving at 2*T0
    const peakThreshold = Math.max(0.55, maxCorr * 0.85);
    let bestIdx = -1;
    for (let idx = 1; idx < lagCount - 1; idx++) {
      const c = corrs[idx];
      if (c >= peakThreshold && c >= corrs[idx - 1] && c >= corrs[idx + 1]) {
        bestIdx = idx;
        break;
      }
    }

    if (bestIdx === -1) {
      let fallbackMax = -Infinity;
      for (let idx = 0; idx < lagCount; idx++) {
        if (corrs[idx] > fallbackMax) {
          fallbackMax = corrs[idx];
          bestIdx = idx;
        }
      }
    }

    if (bestIdx < 0) return 0;

    // Parabolic interpolation around bestIdx for sub-sample period accuracy
    let refinedLag = minLag + bestIdx;
    if (bestIdx > 0 && bestIdx < lagCount - 1) {
      const y0 = corrs[bestIdx - 1];
      const y1 = corrs[bestIdx];
      const y2 = corrs[bestIdx + 1];
      const denom = 2 * (y0 - 2 * y1 + y2);
      if (Math.abs(denom) > 1e-9) {
        const delta = Math.max(-0.5, Math.min(0.5, (y0 - y2) / denom));
        refinedLag += delta;
      }
    }

    return refinedLag > 0 ? sampleRate / refinedLag : 0;
  }
}
