import { TimedPersianToken } from '../PersianTextNormalizer';
import { CustomPersianLexiconManager } from '../CustomPersianLexiconManager';
import { TimeMath } from '../../contracts/timebase.contract';

export type DetectedTokenLanguage = 'FA' | 'EN' | 'AR';

export type EnglishScriptRenderMode = 'LATIN_TECHNICAL' | 'PERSIAN_TRANSLITERATED';

export interface TrilingualNormalizationOptions {
  /** Whether to render recognized English loanwords/technical terms in Latin script (e.g. TypeScript, API) or Persian script (e.g. تایپ‌اسکریپت) */
  readonly englishRenderMode?: EnglishScriptRenderMode;
  /** Whether to preserve Arabic diacritics (Tanwin/Tashdid) and canonical Arabic orthography on Arabic loanwords/phrases */
  readonly preserveArabicOrthography?: boolean;
  /** Maximum acoustic gap (ms) to merge multi-part English or Arabic expressions (default 210ms) */
  readonly maxMergeGapMs?: number;
}

export interface TrilingualClassifiedToken extends TimedPersianToken {
  readonly detectedLanguage: DetectedTokenLanguage;
  readonly canonicalLatinForm?: string;
  readonly canonicalPersianForm?: string;
  readonly canonicalArabicForm?: string;
}

export interface TrilingualPipelineSummary {
  readonly tokens: TrilingualClassifiedToken[];
  readonly persianTokenCount: number;
  readonly englishTokenCount: number;
  readonly arabicTokenCount: number;
  readonly codeSwitchCount: number;
}

interface BilingualLexiconItem {
  readonly spokenPersianForms: readonly (readonly string[])[];
  readonly latinCanonical: string;
  readonly persianCanonical: string;
  readonly phoneticAliases: readonly string[];
}

interface ArabicLexiconItem {
  readonly spokenForms: readonly (readonly string[])[];
  readonly canonicalArabicDisplay: string;
  readonly canonicalNormalized: string;
}

/**
 * Inspired by OpenAI Whisper Large-v3, NVIDIA NeMo FastConformer-CTC/TDT, and ElevenLabs Scribe:
 * - Zero-shot Multilingual Code-Switching Detection (Persian `FA` + English `EN` + Arabic `AR`)
 * - Bidirectional Cross-Script Phonetic Transliteration & Homophone Equivalence
 *   (so searching `TypeScript` or `تایپ‌اسکریپت`, `Backend` or `بک‌اند`, `تحقیقاً` or `تحقیقا` matches seamlessly)
 * - 1-Click Script Mode Switching between Latin Technical Script (`API`, `Backend`, `Docker`) and
 *   Persian Transliterated Script (`ای‌پی‌آی`, `بک‌اند`, `داکر`) without altering `originalText` or `FlickRange`.
 */
export class MultilingualCodeSwitchAndArabicEngine {
  public static readonly ENGLISH_LEXICON: readonly BilingualLexiconItem[] = [
    {
      spokenPersianForms: [['ای', 'پی', 'آی'], ['ای‌پی‌آی'], ['ایپیآی']],
      latinCanonical: 'API',
      persianCanonical: 'ای\u200cپی\u200cآی',
      phoneticAliases: ['api', 'ایپیآی', 'ای پی آی'],
    },
    {
      spokenPersianForms: [['فست', 'ای', 'پی', 'آی'], ['فست\u200cای\u200cپی\u200cآی']],
      latinCanonical: 'FastAPI',
      persianCanonical: 'فست\u200cای\u200cپی\u200cآی',
      phoneticAliases: ['fastapi', 'fast api', 'فست ای پی آی'],
    },
    {
      spokenPersianForms: [['تایپ', 'اسکریپت'], ['تایپ\u200cاسکریپت'], ['تایپاسکریپت']],
      latinCanonical: 'TypeScript',
      persianCanonical: 'تایپ\u200cاسکریپت',
      phoneticAliases: ['typescript', 'ts', 'تایپ اسکریپت'],
    },
    {
      spokenPersianForms: [['جاوا', 'اسکریپت'], ['جاوا\u200cاسکریپت']],
      latinCanonical: 'JavaScript',
      persianCanonical: 'جاوا\u200cاسکریپت',
      phoneticAliases: ['javascript', 'js', 'جاوا اسکریپت'],
    },
    {
      spokenPersianForms: [['بک', 'اند'], ['بک\u200cاند'], ['بکند']],
      latinCanonical: 'Backend',
      persianCanonical: 'بک\u200cاند',
      phoneticAliases: ['backend', 'back-end', 'back end', 'بک اند', 'بکند'],
    },
    {
      spokenPersianForms: [['فرانت', 'اند'], ['فرانت\u200cاند'], ['فرانتند']],
      latinCanonical: 'Frontend',
      persianCanonical: 'فرانت\u200cاند',
      phoneticAliases: ['frontend', 'front-end', 'front end', 'فرانت اند'],
    },
    {
      spokenPersianForms: [['فول', 'استک'], ['فول\u200cاستک']],
      latinCanonical: 'Full-Stack',
      persianCanonical: 'فول\u200cاستک',
      phoneticAliases: ['fullstack', 'full-stack', 'فول استک'],
    },
    {
      spokenPersianForms: [['وب', 'جی', 'پی', 'یو'], ['وب\u200cجی\u200cپی\u200cیو']],
      latinCanonical: 'WebGPU',
      persianCanonical: 'وب\u200cجی\u200cپی\u200cیو',
      phoneticAliases: ['webgpu', 'وب جی پی یو'],
    },
    {
      spokenPersianForms: [['وب', 'اسمبلی'], ['وب\u200cاسمبلی']],
      latinCanonical: 'WebAssembly',
      persianCanonical: 'وب\u200cاسمبلی',
      phoneticAliases: ['webassembly', 'wasm', 'وب اسمبلی'],
    },
    {
      spokenPersianForms: [['داکر']],
      latinCanonical: 'Docker',
      persianCanonical: 'داکر',
      phoneticAliases: ['docker', 'داکر'],
    },
    {
      spokenPersianForms: [['کوبرنتیز'], ['کوبرنتس']],
      latinCanonical: 'Kubernetes',
      persianCanonical: 'کوبرنتیز',
      phoneticAliases: ['kubernetes', 'k8s', 'کوبرنتیز'],
    },
    {
      spokenPersianForms: [['پست', 'گرس'], ['پستگرس']],
      latinCanonical: 'PostgreSQL',
      persianCanonical: 'پستگرس',
      phoneticAliases: ['postgresql', 'postgres', 'پست گرس'],
    },
    {
      spokenPersianForms: [['ری', 'اکت'], ['ری\u200cاکت'], ['ریاکت']],
      latinCanonical: 'React',
      persianCanonical: 'ری\u200cاکت',
      phoneticAliases: ['react', 'reactjs', 'ری اکت'],
    },
    {
      spokenPersianForms: [['نکست', 'جی', 'اس'], ['نکست\u200cجی\u200cاس']],
      latinCanonical: 'Next.js',
      persianCanonical: 'نکست\u200cجی\u200cاس',
      phoneticAliases: ['nextjs', 'next.js', 'نکست جی اس'],
    },
    {
      spokenPersianForms: [['نود', 'جی', 'اس'], ['نود\u200cجی\u200cاس']],
      latinCanonical: 'Node.js',
      persianCanonical: 'نود\u200cجی\u200cاس',
      phoneticAliases: ['nodejs', 'node.js', 'نود جی اس'],
    },
    {
      spokenPersianForms: [['پایتون']],
      latinCanonical: 'Python',
      persianCanonical: 'پایتون',
      phoneticAliases: ['python', 'پایتون'],
    },
    {
      spokenPersianForms: [['ال', 'ال', 'ام'], ['ال\u200cال\u200cام']],
      latinCanonical: 'LLM',
      persianCanonical: 'ال\u200cال\u200cام',
      phoneticAliases: ['llm', 'ال ال ام'],
    },
    {
      spokenPersianForms: [['ای', 'آی'], ['ای\u200cآی']],
      latinCanonical: 'AI',
      persianCanonical: 'ای\u200cآی',
      phoneticAliases: ['ai', 'ای آی'],
    },
    {
      spokenPersianForms: [['ویسپر']],
      latinCanonical: 'Whisper',
      persianCanonical: 'ویسپر',
      phoneticAliases: ['whisper', 'ویسپر'],
    },
    {
      spokenPersianForms: [['پادکست']],
      latinCanonical: 'Podcast',
      persianCanonical: 'پادکست',
      phoneticAliases: ['podcast', 'پادکست'],
    },
    {
      spokenPersianForms: [['استارتاپ'], ['استارت', 'آپ'], ['استارت\u200cآپ']],
      latinCanonical: 'Startup',
      persianCanonical: 'استارتاپ',
      phoneticAliases: ['startup', 'start-up', 'استارتاپ'],
    },
    {
      spokenPersianForms: [['کلود'], ['کلاود']],
      latinCanonical: 'Cloud',
      persianCanonical: 'کلود',
      phoneticAliases: ['cloud', 'کلود', 'کلاود'],
    },
    {
      spokenPersianForms: [['سرور']],
      latinCanonical: 'Server',
      persianCanonical: 'سرور',
      phoneticAliases: ['server', 'سرور'],
    },
    {
      spokenPersianForms: [['کلاینت']],
      latinCanonical: 'Client',
      persianCanonical: 'کلاینت',
      phoneticAliases: ['client', 'کلاینت'],
    },
    {
      spokenPersianForms: [['دیتابیس'], ['دیتا', 'بیس']],
      latinCanonical: 'Database',
      persianCanonical: 'دیتابیس',
      phoneticAliases: ['database', 'db', 'دیتابیس'],
    },
    {
      spokenPersianForms: [['آفلاین']],
      latinCanonical: 'Offline',
      persianCanonical: 'آفلاین',
      phoneticAliases: ['offline', 'آفلاین'],
    },
    {
      spokenPersianForms: [['آنلاین']],
      latinCanonical: 'Online',
      persianCanonical: 'آنلاین',
      phoneticAliases: ['online', 'آنلاین'],
    },
    {
      spokenPersianForms: [['میکرو', 'سرویس'], ['میکروسرویس']],
      latinCanonical: 'Microservice',
      persianCanonical: 'میکروسرویس',
      phoneticAliases: ['microservice', 'microservices', 'میکروسرویس'],
    },
    {
      spokenPersianForms: [['تایم', 'لاین'], ['تایم\u200cلاین']],
      latinCanonical: 'Timeline',
      persianCanonical: 'تایم\u200cلاین',
      phoneticAliases: ['timeline', 'تایم لاین'],
    },
  ];

  /**
   * Canonical Arabic phrases, Quranic/classical expressions, and Tanwin/Definite-Article loanwords
   * common in Persian broadcasts, lectures, and literary podcasts.
   */
  public static readonly ARABIC_LEXICON: readonly ArabicLexiconItem[] = [
    {
      spokenForms: [['بسم', 'الله', 'الرحمن', 'الرحیم'], ['بسم\u200cالله']],
      canonicalArabicDisplay: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
      canonicalNormalized: 'بسم الله الرحمن الرحیم',
    },
    {
      spokenForms: [['ان', 'شا', 'الله'], ['انشاالله'], ['انشالله'], ['ان', 'شاء', 'الله']],
      canonicalArabicDisplay: 'إِنْ شَاءَ اللَّهُ',
      canonicalNormalized: 'ان شاء الله',
    },
    {
      spokenForms: [['ما', 'شا', 'الله'], ['ماشاالله'], ['ماشالله']],
      canonicalArabicDisplay: 'مَا شَاءَ اللَّهُ',
      canonicalNormalized: 'ما شاء الله',
    },
    {
      spokenForms: [['الحمد', 'لله'], ['الحمدلله']],
      canonicalArabicDisplay: 'الْحَمْدُ لِلَّهِ',
      canonicalNormalized: 'الحمد لله',
    },
    {
      spokenForms: [['سبحان', 'الله'], ['سبحان\u200cالله']],
      canonicalArabicDisplay: 'سُبْحَانَ اللَّهِ',
      canonicalNormalized: 'سبحان الله',
    },
    {
      spokenForms: [['السلام', 'علیکم'], ['سلام', 'علیکم']],
      canonicalArabicDisplay: 'السَّلَامُ عَلَيْكُمْ',
      canonicalNormalized: 'السلام علیکم',
    },
    {
      spokenForms: [['فی', 'الواقع'], ['فی\u200cالواقع']],
      canonicalArabicDisplay: 'فِي الْوَاقِعِ',
      canonicalNormalized: 'فی الواقع',
    },
    {
      spokenForms: [['علی', 'ای', 'حال'], ['علی\u200cای\u200cحال']],
      canonicalArabicDisplay: 'عَلَىٰ أَيِّ حَالٍ',
      canonicalNormalized: 'علی ای حال',
    },
    {
      spokenForms: [['مع', 'ذلک'], ['مع\u200cذلک']],
      canonicalArabicDisplay: 'مَعَ ذَٰلِكَ',
      canonicalNormalized: 'مع ذلک',
    },
    {
      spokenForms: [['بلا', 'فاصله'], ['بلافاصله']],
      canonicalArabicDisplay: 'بِلَافَاصِلَة',
      canonicalNormalized: 'بلافاصله',
    },
    {
      spokenForms: [['دقیقا'], ['دقیقاً']],
      canonicalArabicDisplay: 'دقیقاً',
      canonicalNormalized: 'دقیقاً',
    },
    {
      spokenForms: [['تقریبا'], ['تقریباً']],
      canonicalArabicDisplay: 'تقریباً',
      canonicalNormalized: 'تقریباً',
    },
    {
      spokenForms: [['معمولا'], ['معمولاً']],
      canonicalArabicDisplay: 'معمولاً',
      canonicalNormalized: 'معمولاً',
    },
    {
      spokenForms: [['کاملا'], ['کاملاً']],
      canonicalArabicDisplay: 'کاملاً',
      canonicalNormalized: 'کاملاً',
    },
    {
      spokenForms: [['حتما'], ['حتماً']],
      canonicalArabicDisplay: 'حتماً',
      canonicalNormalized: 'حتماً',
    },
    {
      spokenForms: [['احتمالا'], ['احتمالاً']],
      canonicalArabicDisplay: 'احتمالاً',
      canonicalNormalized: 'احتمالاً',
    },
    {
      spokenForms: [['خصوصا'], ['خصوصاً']],
      canonicalArabicDisplay: 'خصوصاً',
      canonicalNormalized: 'خصوصاً',
    },
    {
      spokenForms: [['مثلا'], ['مثلاً']],
      canonicalArabicDisplay: 'مثلاً',
      canonicalNormalized: 'مثلاً',
    },
    {
      spokenForms: [['اصولا'], ['اصولاً']],
      canonicalArabicDisplay: 'اصولاً',
      canonicalNormalized: 'اصولاً',
    },
    {
      spokenForms: [['نسبتا'], ['نسبتاً']],
      canonicalArabicDisplay: 'نسبتاً',
      canonicalNormalized: 'نسبتاً',
    },
    {
      spokenForms: [['صرفا'], ['صرفاً']],
      canonicalArabicDisplay: 'صرفاً',
      canonicalNormalized: 'صرفاً',
    },
    {
      spokenForms: [['قطعا'], ['قطعاً']],
      canonicalArabicDisplay: 'قطعاً',
      canonicalNormalized: 'قطعاً',
    },
  ];

  /** High-frequency Arabic loanword roots/forms in Persian speech (featuring ط، ص، ض، ظ، ع، غ، ح، ث، ذ، ق) */
  private static readonly ARABIC_LOANWORD_SET = new Set<string>([
    'صحبت',
    'نتیجه',
    'مصنوعی',
    'تحقیق',
    'تحقیقات',
    'معماری',
    'موضوع',
    'اطلاعات',
    'تولید',
    'محتوا',
    'کیفیت',
    'اصلاح',
    'دقیق',
    'دقیقاً',
    'تقریباً',
    'معمولاً',
    'کاملاً',
    'حتماً',
    'احتمالاً',
    'خصوصاً',
    'مثلاً',
    'قطعاً',
    'صرفاً',
    'اصولاً',
    'نسبتاً',
  ]);

  /**
   * Converts any English Latin word, Arabic word, or Persian word into a unified
   * Cross-Script Phonetic Skeleton so searching `TypeScript` matches `تایپ‌اسکریپت`,
   * searching `Backend` matches `بک‌اند`, and searching `انشالله` matches `إِنْ شَاءَ اللَّهُ`.
   */
  public static toCrossScriptPhoneticSkeleton(rawInput: string): string {
    const trimmed = rawInput
      .trim()
      .toLowerCase()
      // Strip Arabic harakat/tashkeel (fatha, kasra, damma, tanwin, shadda, sukun, superscript alef)
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');

    if (!trimmed) return '';

    // 1. Check direct match against bilingual English lexicon (Latin or Persian form)
    for (const item of this.ENGLISH_LEXICON) {
      if (
        item.latinCanonical.toLowerCase() === trimmed ||
        item.persianCanonical.replace(/[\u200c\s]+/g, '') ===
          trimmed.replace(/[\u200c\s]+/g, '') ||
        item.phoneticAliases.some(
          (a) => a.toLowerCase().replace(/[\u200c\s\-_]+/g, '') === trimmed.replace(/[\u200c\s\-_]+/g, ''),
        )
      ) {
        return CustomPersianLexiconManager.toPersianPhoneticSkeleton(item.persianCanonical);
      }
    }

    // 2. Check direct match against Arabic lexicon (spoken colloquial or formal diacritic form)
    const cleanJoin = trimmed.replace(/[\u200c\s\-_]+/g, '');
    for (const ar of this.ARABIC_LEXICON) {
      const arDispClean = ar.canonicalArabicDisplay
        .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u200c\s]+/g, '');
      const arNormClean = ar.canonicalNormalized
        .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u200c\s]+/g, '');
      if (
        cleanJoin === arDispClean ||
        cleanJoin === arNormClean ||
        ar.spokenForms.some((sf) => sf.join('').replace(/[\u200c\s]+/g, '') === cleanJoin)
      ) {
        return CustomPersianLexiconManager.toPersianPhoneticSkeleton(ar.canonicalNormalized)
          .replace(/ا+/g, 'ا');
      }
    }

    // 3. If input contains Latin ASCII letters, transliterate Latin phoneme clusters into Persian phonetic skeleton
    if (/[a-z]/.test(trimmed)) {
      const latinToFa = trimmed
        .replace(/typescript/g, 'تایپاسکریپت')
        .replace(/javascript/g, 'جاوااسکریپت')
        .replace(/fastapi/g, 'فستایپیآی')
        .replace(/api/g, 'ایپیآی')
        .replace(/backend|back-end/g, 'بکاند')
        .replace(/frontend|front-end/g, 'فرانتاند')
        .replace(/webgpu/g, 'وبجیپییو')
        .replace(/webassembly|wasm/g, 'وباسمبلی')
        .replace(/docker/g, 'داکر')
        .replace(/kubernetes|k8s/g, 'کوبرنتیز')
        .replace(/postgres(ql)?/g, 'پستگرس')
        .replace(/react(js)?/g, 'ریاکت')
        .replace(/next(\.?js)?/g, 'نکستجیاس')
        .replace(/node(\.?js)?/g, 'نودجیاس')
        .replace(/python/g, 'پایتون')
        .replace(/podcast/g, 'پادکست')
        .replace(/startup/g, 'استارتاپ')
        .replace(/cloud/g, 'کلود')
        .replace(/server/g, 'سرور')
        .replace(/client/g, 'کلاینت')
        .replace(/database/g, 'دیتابیس')
        .replace(/offline/g, 'آفلاین')
        .replace(/online/g, 'آنلاین')
        .replace(/timeline/g, 'تایملاین')
        .replace(/whisper/g, 'ویسپر')
        .replace(/sh/g, 'ش')
        .replace(/ch/g, 'چ')
        .replace(/kh/g, 'خ')
        .replace(/gh/g, 'ق')
        .replace(/zh/g, 'ژ')
        .replace(/ph/g, 'ف')
        .replace(/th/g, 'ت')
        .replace(/ck/g, 'ک')
        .replace(/a/g, 'ا')
        .replace(/b/g, 'ب')
        .replace(/c/g, 'ک')
        .replace(/d/g, 'د')
        .replace(/e/g, '')
        .replace(/f/g, 'ف')
        .replace(/g/g, 'گ')
        .replace(/h/g, 'ه')
        .replace(/i/g, 'ی')
        .replace(/j/g, 'ج')
        .replace(/k/g, 'ک')
        .replace(/l/g, 'ل')
        .replace(/m/g, 'م')
        .replace(/n/g, 'ن')
        .replace(/o/g, 'و')
        .replace(/p/g, 'پ')
        .replace(/q/g, 'ق')
        .replace(/r/g, 'ر')
        .replace(/s/g, 'س')
        .replace(/t/g, 'ت')
        .replace(/u/g, 'و')
        .replace(/v/g, 'و')
        .replace(/w/g, 'و')
        .replace(/x/g, 'کس')
        .replace(/y/g, 'ی')
        .replace(/z/g, 'ز');

      return CustomPersianLexiconManager.toPersianPhoneticSkeleton(latinToFa);
    }

    return CustomPersianLexiconManager.toPersianPhoneticSkeleton(trimmed);
  }

  /**
   * Classifies a single token into 'EN', 'AR', or 'FA' and returns its canonical script variants.
   */
  public static classifySingleTokenLanguage(rawText: string): {
    language: DetectedTokenLanguage;
    canonicalLatin?: string;
    canonicalPersian?: string;
    canonicalArabic?: string;
  } {
    const clean = rawText
      .replace(/[،؛.!؟«»"()[\]]+/g, '')
      .trim();
    if (!clean) return { language: 'FA' };

    const cleanLower = clean.toLowerCase();
    const cleanNoZwnj = cleanLower.replace(/[\u200c\s]+/g, '');

    // 1. Check English lexicon match (either Latin or Persian transliterated form)
    for (const item of this.ENGLISH_LEXICON) {
      const itemFaNoZwnj = item.persianCanonical.replace(/[\u200c\s]+/g, '');
      if (
        item.latinCanonical.toLowerCase() === cleanLower ||
        itemFaNoZwnj === cleanNoZwnj ||
        item.phoneticAliases.some(
          (a) => a.toLowerCase().replace(/[\u200c\s]+/g, '') === cleanNoZwnj,
        )
      ) {
        return {
          language: 'EN',
          canonicalLatin: item.latinCanonical,
          canonicalPersian: item.persianCanonical,
        };
      }
    }

    // Direct ASCII Latin word
    if (/^[A-Za-z][A-Za-z0-9.\-_+#]*$/.test(clean)) {
      return {
        language: 'EN',
        canonicalLatin: clean,
        canonicalPersian: clean,
      };
    }

    // 2. Check Arabic lexicon match
    const strippedHarakat = clean.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
    for (const ar of this.ARABIC_LEXICON) {
      const arStripped = ar.canonicalArabicDisplay.replace(
        /[\u064B-\u065F\u0670\u06D6-\u06ED]/g,
        '',
      );
      if (
        clean === ar.canonicalArabicDisplay ||
        strippedHarakat === arStripped ||
        strippedHarakat === ar.canonicalNormalized ||
        ar.spokenForms.some(
          (sf) => sf.join('') === strippedHarakat.replace(/[\u200c\s]+/g, ''),
        )
      ) {
        return {
          language: 'AR',
          canonicalArabic: ar.canonicalArabicDisplay,
          canonicalPersian: ar.canonicalNormalized,
        };
      }
    }

    // Check Arabic Tanwin (ـاً / ـٍ / ـٌ), Definite Article ال..., or Arabic orthographic loanwords
    if (
      /[\u064B\u064C\u064D]/.test(clean) ||
      /^ال[^\s]{2,}$/.test(strippedHarakat) ||
      /[طصضظعغحثذ]/.test(strippedHarakat) ||
      this.ARABIC_LOANWORD_SET.has(strippedHarakat)
    ) {
      return {
        language: 'AR',
        canonicalArabic: clean,
        canonicalPersian: clean,
      };
    }

    return { language: 'FA' };
  }

  /**
   * Processes a timed transcript stream to detect and normalize trilingual (Persian + English + Arabic)
   * code-switching tokens, merging multi-word spoken English technical terms (e.g. «تایپ اسکریپت» -> `TypeScript`)
   * and multi-word Arabic expressions (e.g. «ان شا الله» -> `إِنْ شَاءَ اللَّهُ` or `ان شاء الله`) when
   * acoustically contiguous, while strictly preserving `originalText` and `FlickRange`.
   */
  public static processTrilingualTranscript(
    tokens: readonly TimedPersianToken[],
    options?: TrilingualNormalizationOptions,
  ): TrilingualPipelineSummary {
    const englishMode = options?.englishRenderMode ?? 'LATIN_TECHNICAL';
    const preserveArabic = options?.preserveArabicOrthography ?? true;
    const maxGapFlicks = TimeMath.secondsToFlicks((options?.maxMergeGapMs ?? 210) / 1000);

    const out: TrilingualClassifiedToken[] = [];
    let i = 0;

    while (i < tokens.length) {
      const curr = tokens[i];
      const punctMatch = curr.displayText.match(/[،؛.!؟]+$/);
      const trailingPunct = punctMatch ? punctMatch[0] : '';

      // 1. Try multi-token English phrase match (longest first)
      let matchedEn: { item: BilingualLexiconItem; spanLen: number } | null = null;
      for (const item of this.ENGLISH_LEXICON) {
        for (const pattern of item.spokenPersianForms) {
          const len = pattern.length;
          if (i + len > tokens.length) continue;
          let ok = true;
          for (let k = 0; k < len; k++) {
            const tokNorm = tokens[i + k].normalizedText
              .replace(/[،؛.!؟]+$/g, '')
              .replace(/\u200c/g, '');
            const patNorm = pattern[k].replace(/\u200c/g, '');
            if (tokNorm !== patNorm) {
              ok = false;
              break;
            }
            if (
              k > 0 &&
              (tokens[i + k].trackId !== tokens[i + k - 1].trackId ||
                tokens[i + k].range.start - tokens[i + k - 1].range.end > maxGapFlicks)
            ) {
              ok = false;
              break;
            }
          }
          if (ok && (!matchedEn || len > matchedEn.spanLen)) {
            matchedEn = { item, spanLen: len };
          }
        }
      }

      if (matchedEn) {
        const slice = tokens.slice(i, i + matchedEn.spanLen);
        const lastPunct =
          slice[slice.length - 1].displayText.match(/[،؛.!؟]+$/)?.[0] ?? '';
        const chosenDisplay =
          englishMode === 'LATIN_TECHNICAL'
            ? `${matchedEn.item.latinCanonical}${lastPunct}`
            : `${matchedEn.item.persianCanonical}${lastPunct}`;

        out.push({
          tokenId: slice.map((t) => t.tokenId).join('+'),
          trackId: slice[0].trackId,
          originalText: slice.map((t) => t.originalText).join(' '),
          normalizedText: matchedEn.item.persianCanonical,
          displayText: chosenDisplay,
          range: {
            start: slice[0].range.start,
            end: slice[slice.length - 1].range.end,
          },
          confidence: Number(
            (slice.reduce((acc, t) => acc + t.confidence, 0) / slice.length).toFixed(3),
          ),
          isDisfluency: slice.some((t) => t.isDisfluency),
          hasTrailingEzafeRisk: slice[slice.length - 1].hasTrailingEzafeRisk,
          detectedLanguage: 'EN',
          canonicalLatinForm: matchedEn.item.latinCanonical,
          canonicalPersianForm: matchedEn.item.persianCanonical,
        });
        i += matchedEn.spanLen;
        continue;
      }

      // 2. Try multi-token Arabic expression match (longest first)
      let matchedAr: { item: ArabicLexiconItem; spanLen: number } | null = null;
      for (const item of this.ARABIC_LEXICON) {
        for (const pattern of item.spokenForms) {
          const len = pattern.length;
          if (i + len > tokens.length) continue;
          let ok = true;
          for (let k = 0; k < len; k++) {
            const tokNorm = tokens[i + k].normalizedText
              .replace(/[،؛.!؟\u064B-\u065F\u0670]+/g, '')
              .replace(/\u200c/g, '');
            const patNorm = pattern[k]
              .replace(/[\u064B-\u065F\u0670]+/g, '')
              .replace(/\u200c/g, '');
            if (tokNorm !== patNorm) {
              ok = false;
              break;
            }
            if (
              k > 0 &&
              (tokens[i + k].trackId !== tokens[i + k - 1].trackId ||
                tokens[i + k].range.start - tokens[i + k - 1].range.end > maxGapFlicks)
            ) {
              ok = false;
              break;
            }
          }
          if (ok && (!matchedAr || len > matchedAr.spanLen)) {
            matchedAr = { item, spanLen: len };
          }
        }
      }

      if (matchedAr) {
        const slice = tokens.slice(i, i + matchedAr.spanLen);
        const lastPunct =
          slice[slice.length - 1].displayText.match(/[،؛.!؟]+$/)?.[0] ?? '';
        const chosenDisplay = preserveArabic
          ? `${matchedAr.item.canonicalArabicDisplay}${lastPunct}`
          : `${matchedAr.item.canonicalNormalized}${lastPunct}`;

        out.push({
          tokenId: slice.map((t) => t.tokenId).join('+'),
          trackId: slice[0].trackId,
          originalText: slice.map((t) => t.originalText).join(' '),
          normalizedText: matchedAr.item.canonicalNormalized,
          displayText: chosenDisplay,
          range: {
            start: slice[0].range.start,
            end: slice[slice.length - 1].range.end,
          },
          confidence: Number(
            (slice.reduce((acc, t) => acc + t.confidence, 0) / slice.length).toFixed(3),
          ),
          isDisfluency: slice.some((t) => t.isDisfluency),
          hasTrailingEzafeRisk: slice[slice.length - 1].hasTrailingEzafeRisk,
          detectedLanguage: 'AR',
          canonicalArabicForm: matchedAr.item.canonicalArabicDisplay,
          canonicalPersianForm: matchedAr.item.canonicalNormalized,
        });
        i += matchedAr.spanLen;
        continue;
      }

      // 3. Single token classification (including multi-word single tokens)
      const singleClass = this.classifySingleTokenLanguage(curr.displayText);
      let nextDisplay = curr.displayText;

      if (singleClass.language === 'EN') {
        const targetWord =
          englishMode === 'LATIN_TECHNICAL'
            ? (singleClass.canonicalLatin ?? curr.displayText)
            : (singleClass.canonicalPersian ?? curr.displayText);
        nextDisplay = `${targetWord.replace(/[،؛.!؟]+$/g, '')}${trailingPunct}`;
      } else if (singleClass.language === 'AR') {
        const targetWord = preserveArabic
          ? (singleClass.canonicalArabic ?? curr.displayText)
          : (singleClass.canonicalPersian ?? curr.displayText);
        nextDisplay = `${targetWord.replace(/[،؛.!؟]+$/g, '')}${trailingPunct}`;
      }

      out.push({
        ...curr,
        displayText: nextDisplay,
        detectedLanguage: singleClass.language,
        canonicalLatinForm: singleClass.canonicalLatin,
        canonicalPersianForm: singleClass.canonicalPersian,
        canonicalArabicForm: singleClass.canonicalArabic,
      });
      i++;
    }

    let persianTokenCount = 0;
    let englishTokenCount = 0;
    let arabicTokenCount = 0;
    let codeSwitchCount = 0;

    for (let idx = 0; idx < out.length; idx++) {
      const lang = out[idx].detectedLanguage;
      if (lang === 'EN') englishTokenCount++;
      else if (lang === 'AR') arabicTokenCount++;
      else persianTokenCount++;

      if (idx > 0 && out[idx].detectedLanguage !== out[idx - 1].detectedLanguage) {
        codeSwitchCount++;
      }
    }

    return {
      tokens: out,
      persianTokenCount,
      englishTokenCount,
      arabicTokenCount,
      codeSwitchCount,
    };
  }
}
