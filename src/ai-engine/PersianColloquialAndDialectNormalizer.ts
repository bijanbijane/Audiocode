import { TimedPersianToken } from './PersianTextNormalizer';

export interface ColloquialMappedPersianToken extends TimedPersianToken {
  /** معادل فارسی رسمی/معیار کلمه محاوره‌ای با حفظ ۱۰۰٪ ارتباط با توکن اصلی (بخش ۲۷ سند) */
  readonly formalStandardEquivalent: string;
  readonly wasColloquialConverted: boolean;
}

export class PersianColloquialAndDialectNormalizer {
  private static readonly ZWNJ = '\u200c';

  /** فرهنگ لغت قطعی پربسامدترین افعال شکسته، ضمایر و واژگان محاوره‌ای فارسی به فارسی معیار */
  private static readonly EXACT_COLLOQUIAL_TO_FORMAL: Readonly<Record<string, string>> = {
    // ضمایر و اشاره‌ها
    اون: 'آن',
    اونا: 'آن\u200cها',
    اونها: 'آن\u200cها',
    اینا: 'این\u200cها',
    همون: 'همان',
    همینجوری: 'همین\u200cطور',
    اینجوری: 'این\u200cطور',
    اونجوری: 'آن\u200cطور',
    چجوری: 'چه\u200cطور',
    واسه: 'برای',
    رو: 'را',
    دیگه: 'دیگر',
    اگه: 'اگر',
    مگه: 'مگر',
    آره: 'بله',
    نه: 'خیر',
    الان: 'اکنون',
    خیلی: 'بسیار',
    یه: 'یک',

    // واژگان دارای تبدیل واکه‌ای «آ -> او» در محاوره
    خونه: 'خانه',
    تهرون: 'تهران',
    بارون: 'باران',
    نون: 'نان',
    جون: 'جان',
    آسمون: 'آسمان',
    زمستون: 'زمستان',
    تابستون: 'تابستان',
    خیابون: 'خیابان',
    تومن: 'تومان',
    دیقه: 'دقیقه',

    // افعال پرکاربرد شکسته محاوره‌ای
    'می\u200cخوام': 'می\u200cخواهم',
    'می\u200cخوای': 'می\u200cخواهی',
    'می\u200cخواد': 'می\u200cخواهد',
    'می\u200cخوایم': 'می\u200cخواهیم',
    'می\u200cخوان': 'می\u200cخواهند',
    'نمی\u200cخوام': 'نمی\u200cخواهم',
    'نمی\u200cخواد': 'نمی\u200cخواهد',

    'می\u200cتونم': 'می\u200cتوانم',
    'می\u200cتونی': 'می\u200cتوانی',
    'می\u200cتونه': 'می\u200cتواند',
    'می\u200cتونیم': 'می\u200cتوانیم',
    'می\u200cتونن': 'می\u200cتوانند',

    'می\u200cدونم': 'می\u200cدانم',
    'می\u200cدونی': 'می\u200cدانی',
    'می\u200cدونه': 'می\u200cداند',
    'می\u200cدونیم': 'می\u200cدانیم',
    'می\u200cدونن': 'می\u200cدانند',

    'می\u200cگم': 'می\u200cگویم',
    'می\u200cگمُ': 'می\u200cگویم',
    'می\u200cگی': 'می\u200cگویی',
    'می\u200cگه': 'می\u200cگوید',
    'می\u200cگیم': 'می\u200cگوییم',
    'می\u200cگن': 'می\u200cگویند',

    'می\u200cرم': 'می\u200cروم',
    'می\u200cری': 'می\u200cروی',
    'می\u200cره': 'می\u200cرود',
    'می\u200cریم': 'می\u200cرویم',
    'می\u200cرن': 'می\u200cروند',

    'می\u200cآم': 'می\u200cآیم',
    'می\u200cآد': 'می\u200cآید',
    'می\u200cآن': 'می\u200cآیند',

    'می\u200cشه': 'می\u200cشود',
    'نمی\u200cشه': 'نمی\u200cشود',
    'بشه': 'بشود',
    'نشه': 'نشود',
    'باشه': 'باشد',
    'نباشه': 'نباشد',
    'بدم': 'بدهم',
    'بده': 'بدهد',
    'برم': 'بروم',
    'بره': 'برود',
    'بیام': 'بیایم',
    'بیاد': 'بیاید',
    'بگم': 'بگویم',
    'بگه': 'بگوید',
  };

  /**
   * ۱. تبدیل یک توکن محاوره‌ای یا گویشی فارسی به معادل رسمی/معیار
   */
  public static convertWordToFormalStandard(normalizedWord: string): {
    formalWord: string;
    converted: boolean;
  } {
    const clean = normalizedWord.trim();
    if (this.EXACT_COLLOQUIAL_TO_FORMAL[clean]) {
      return {
        formalWord: this.EXACT_COLLOQUIAL_TO_FORMAL[clean],
        converted: true,
      };
    }

    // بررسی ضمایر متصل جمع محاوره‌ای در انتهای اسم‌ها («کتابامون -> کتاب‌هایمان»، «خونه‌هاشون -> خانه‌هایشان»)
    const pluralCliticMatch = clean.match(/^(.+?)(هامون|هاتون|هاشون|امون|اتون|اشون)$/);
    if (pluralCliticMatch && pluralCliticMatch[1].length >= 2) {
      const rawPluralStem = pluralCliticMatch[1].replace(/\u200c$/, '');
      const stem =
        this.EXACT_COLLOQUIAL_TO_FORMAL[rawPluralStem] ?? rawPluralStem;
      const suffix = pluralCliticMatch[2]
        .replace('مون', 'مان')
        .replace('تون', 'تان')
        .replace('شون', 'شان');

      const formalSuffix = suffix.startsWith('ها')
        ? `${this.ZWNJ}${suffix}`
        : `${this.ZWNJ}های${suffix.slice(1)}`;
      return {
        formalWord: `${stem}${formalSuffix}`,
        converted: true,
      };
    }

    // بررسی ضمایر متصل مفرد محاوره‌ای («خونه‌مون -> خانه‌مان»، «هدفتون -> هدفتان»، «کارشون -> کارشان»)
    const singularCliticMatch = clean.match(/^(.+?)(مون|تون|شون)$/);
    if (singularCliticMatch && singularCliticMatch[1].length >= 2) {
      const rawStem = singularCliticMatch[1].replace(/\u200c$/, '');
      const stem = this.EXACT_COLLOQUIAL_TO_FORMAL[rawStem] ?? rawStem;
      const formalClitic = singularCliticMatch[2]
        .replace('مون', 'مان')
        .replace('تون', 'تان')
        .replace('شون', 'شان');
      const connector = stem.endsWith('ه') ? this.ZWNJ : '';
      return {
        formalWord: `${stem}${connector}${formalClitic}`,
        converted: true,
      };
    }

    // بررسی افعال مضارع سوم شخص جمع محاوره‌ای («می‌کنن -> می‌کنند»، «می‌برن -> می‌برند»)
    if (/^ن?می\u200c.+ن$/.test(clean) && !clean.endsWith('ند')) {
      return {
        formalWord: `${clean}د`,
        converted: true,
      };
    }

    return { formalWord: clean, converted: false };
  }

  /**
   * ۲. غنی‌سازی آرایه توکن‌ها با لایه معادل رسمی و امکان سوئیچ غیرمخرب لایه نمایشی (بخش ۲۷ سند معماری)
   * متن اصلی (originalText) و بازه زمانی (range) تحت هیچ شرایطی تغییر نمی‌کنند!
   */
  public static enrichTranscriptWithFormalLayer(
    tokens: TimedPersianToken[],
    applyFormalToDisplayLayer: boolean = false,
  ): ColloquialMappedPersianToken[] {
    return tokens.map((tok) => {
      const { formalWord, converted } = this.convertWordToFormalStandard(
        tok.normalizedText,
      );
      return {
        ...tok,
        formalStandardEquivalent: formalWord,
        wasColloquialConverted: converted,
        displayText: applyFormalToDisplayLayer ? formalWord : tok.displayText,
      };
    });
  }
}
