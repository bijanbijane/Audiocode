import { PersianTextNormalizer, TimedPersianToken } from './PersianTextNormalizer';
import { DisfluencyType } from '../contracts/persian-editing.contract';
import { Flicks, TimeMath, TimeRange } from '../contracts/timebase.contract';
import type {
  SpeechEventCategory,
  SpeechEventDetectionState,
  SpeechEventSubtype,
  SpeechEventUncertaintyState,
} from './speech-events/SpeechEventContracts';

export interface DetectedSpeechIssue {
  readonly issueId: string;
  readonly type: DisfluencyType;
  /** Suggested range to delete/shorten (Reparandum + Interregnum, preserving final Repair) */
  readonly targetRange: TimeRange;
  readonly affectedTokenIds: string[];
  readonly displayExcerpt: string;
  readonly reasonFa: string;
  readonly compositeConfidence: number;
  /** Natural pause duration to retain for LONG_PAUSE issues (in Flicks) */
  readonly suggestedRemainingPauseFlicks: Flicks;
}

export const PERSIAN_FILLER_LEXICON_VERSION = '2.0.0-fa-fillers';

export interface PersianFillerLexiconEntry {
  readonly lexiconId: string;
  readonly canonicalForm: string;
  readonly surfaceVariants: readonly string[];
  readonly category: 'VOCAL_FILLED_PAUSE' | 'DISCOURSE_MARKER' | 'COLLOQUIAL_FILLER';
  readonly linguisticRole: string;
  readonly typicalAcousticBehavior: string;
  readonly potentiallyRemovable: boolean;
  readonly preserveContexts: readonly string[];
  readonly baseLinguisticScore: number;
}

export const PERSIAN_FILLER_LEXICON: readonly PersianFillerLexiconEntry[] = [
  {
    lexiconId: 'fil-vocal-e',
    canonicalForm: 'اِ',
    surfaceVariants: ['ا', 'اه', 'اِ', 'اهه', 'اههه'],
    category: 'VOCAL_FILLED_PAUSE',
    linguisticRole: 'وقفه آوایی پرشده (Filled pause / vowel hesitation)',
    typicalAcousticBehavior: 'واکه کشیده یا خنثی با زیر و بمی یکنواخت و اطراف مکث‌دار',
    potentiallyRemovable: true,
    preserveContexts: ['در ترکیب با فعل یا ضمیر متصل'],
    baseLinguisticScore: 0.9,
  },
  {
    lexiconId: 'fil-vocal-am',
    canonicalForm: 'اَم',
    surfaceVariants: ['ام', 'اَم', 'امم', 'اممم', 'امممم'],
    category: 'VOCAL_FILLED_PAUSE',
    linguisticRole: 'تپق خیشومی میانه یا ابتدای جمله',
    typicalAcousticBehavior: 'همخوان خیشومی کشیده با افت انرژی در میانه عبارت',
    potentiallyRemovable: true,
    preserveContexts: ['به عنوان ضمیر ملکی متصل یا مخفف «هستم» در پایان جمله'],
    baseLinguisticScore: 0.92,
  },
  {
    lexiconId: 'fil-vocal-oom',
    canonicalForm: 'اوم',
    surfaceVariants: ['اوم', 'اومم', 'اوممم', 'اووم'],
    category: 'VOCAL_FILLED_PAUSE',
    linguisticRole: 'مکث آوایی محاوره‌ای هنگام جستجوی واژه',
    typicalAcousticBehavior: 'کشش واکه پسین با فرکانس پایه پایدار',
    potentiallyRemovable: true,
    preserveContexts: ['در ترکیب «اومد» / «اومدم» (فعل آمدن)'],
    baseLinguisticScore: 0.9,
  },
  {
    lexiconId: 'fil-vocal-aa',
    canonicalForm: 'آ',
    surfaceVariants: ['آ', 'آا', 'آاا', 'ااا', 'آه', 'آهه'],
    category: 'VOCAL_FILLED_PAUSE',
    linguisticRole: 'آوای تردید یا مکث پرشده',
    typicalAcousticBehavior: 'واکه باز کشیده بدون همخوان انتهایی',
    potentiallyRemovable: true,
    preserveContexts: ['ندا یا پاسخ تأیید آوایی مستقیم گوینده'],
    baseLinguisticScore: 0.85,
  },
  {
    lexiconId: 'fil-disc-yani',
    canonicalForm: 'یعنی',
    surfaceVariants: ['یعنی'],
    category: 'DISCOURSE_MARKER',
    linguisticRole: 'نشانگر توضیح، بازتعریف یا تردید زبانی',
    typicalAcousticBehavior: 'تند و کم‌تاکید در نقش حشو؛ واضح و پیش از بند توضیحی در نقش معنایی',
    potentiallyRemovable: true,
    preserveContexts: [
      'معرفی توضیح یا تعریف واقعی («... یعنی اینکه ...»)',
      'پرسش معنایی یا تأکید صریح',
      'نشانگر اصلاح در ساختار Self-Correction',
    ],
    baseLinguisticScore: 0.45,
  },
  {
    lexiconId: 'fil-disc-khob',
    canonicalForm: 'خب',
    surfaceVariants: ['خب', 'خوب'],
    category: 'DISCOURSE_MARKER',
    linguisticRole: 'نشانگر گذار گفتمانی یا شروع نوبت صحبت',
    typicalAcousticBehavior: 'در حشو با مکث دوطرفه و انرژی کم؛ در گذار گفتمانی بدون مکث تردیدی',
    potentiallyRemovable: true,
    preserveContexts: [
      'شروع نوبت صحبت یا جمع‌بندی منطقی',
      'صفت «خوب» پیش یا پس از اسم/فعل',
    ],
    baseLinguisticScore: 0.42,
  },
  {
    lexiconId: 'fil-disc-hala',
    canonicalForm: 'حالا',
    surfaceVariants: ['حالا'],
    category: 'DISCOURSE_MARKER',
    linguisticRole: 'قید زمان («اکنون») یا نشانگر گذار محاوره‌ای',
    typicalAcousticBehavior: 'در معنای زمانی پرتاکید؛ در حشو کوتاه و محصور در مکث تردید',
    potentiallyRemovable: true,
    preserveContexts: [
      'معنای زمانی («تا حالا»، «از حالا»، «حالا وقتشه»، «حالا که»)',
      'تقابل معنایی با گذشته یا آینده',
    ],
    baseLinguisticScore: 0.35,
  },
  {
    lexiconId: 'fil-disc-masalan',
    canonicalForm: 'مثلاً',
    surfaceVariants: ['مثلاً', 'مثلا'],
    category: 'DISCOURSE_MARKER',
    linguisticRole: 'نشانگر ارائه مصداق و مثال واقعی',
    typicalAcousticBehavior: 'پیوسته به مصداق بعدی؛ در حشو تکرارشده یا محصور در مکث‌های تردیدی',
    potentiallyRemovable: true,
    preserveContexts: [
      'معرفی مثال واقعی و مشخص در ادامه جمله',
      'بیان فرض منطقی',
    ],
    baseLinguisticScore: 0.35,
  },
  {
    lexiconId: 'fil-disc-darvaghe',
    canonicalForm: 'در واقع',
    surfaceVariants: ['در واقع', 'درواقع'],
    category: 'DISCOURSE_MARKER',
    linguisticRole: 'قید تأکید یا تصحیح بیان',
    typicalAcousticBehavior: 'در اصلاح واقعی متصل به بند جدید؛ در حشو تکراری و محصور در مکث',
    potentiallyRemovable: true,
    preserveContexts: [
      'اصلاح واقعی یا بیان حقیقت متمایز از بند پیشین',
    ],
    baseLinguisticScore: 0.42,
  },
  {
    lexiconId: 'fil-colloq-be-estelah',
    canonicalForm: 'به‌اصطلاح',
    surfaceVariants: ['به‌اصطلاح', 'به اصطلاح', 'بهاصطلاح'],
    category: 'COLLOQUIAL_FILLER',
    linguisticRole: 'عبارت تعدیل‌گر یا حشو محاوره‌ای',
    typicalAcousticBehavior: 'معمولاً محصور در مکث‌های کوتاه و با ریتم سریع',
    potentiallyRemovable: true,
    preserveContexts: [
      'ارجاع صریح به اصطلاح تخصصی که گوینده عمداً در گیومه بیان می‌کند',
    ],
    baseLinguisticScore: 0.72,
  },
  {
    lexiconId: 'fil-colloq-arzam',
    canonicalForm: 'عرضم به حضور شما',
    surfaceVariants: [
      'عرضم به حضور شما',
      'عرضم به حضورتون',
      'خدمت شما عرض کنم',
      'راستش رو بخواید',
      'حقیقتش',
      'خلاصه کلام',
    ],
    category: 'COLLOQUIAL_FILLER',
    linguisticRole: 'عبارت تعارفی/گفتمانی طولانی میان‌بند',
    typicalAcousticBehavior: 'فاصله مکث پیش و پس از عبارت در گفتار فی‌البداهه',
    potentiallyRemovable: true,
    preserveContexts: [
      'مخاطب قراردادن عمدی شنونده در شروع بخش رسمی',
    ],
    baseLinguisticScore: 0.78,
  },
  {
    lexiconId: 'fil-colloq-chiz',
    canonicalForm: 'چیز',
    surfaceVariants: ['چیز', 'چیزه'],
    category: 'COLLOQUIAL_FILLER',
    linguisticRole: 'اسم عام («شیء/موضوع») یا جایگزین تردیدی واژه فراموش‌شده',
    typicalAcousticBehavior: 'در تردید با مکث بعدی طولانی یا قبل از واژه جایگزین',
    potentiallyRemovable: true,
    preserveContexts: [
      'نقش اسمی واقعی («این چیز مهمه»، «همه چیز»، «یه چیز خوب»، «چه چیز»)',
    ],
    baseLinguisticScore: 0.3,
  },
  {
    lexiconId: 'fil-colloq-chi-migan',
    canonicalForm: 'چی میگن',
    surfaceVariants: ['چی میگن', 'چی می‌گن', 'چی می گن'],
    category: 'COLLOQUIAL_FILLER',
    linguisticRole: 'عبارت جستجوی واژه در حافظه',
    typicalAcousticBehavior: 'همراه با افت انرژی یا مکث پسین پیش از یافتن واژه هدف',
    potentiallyRemovable: true,
    preserveContexts: ['پرسش مستقیم از مخاطب درباره نقل قول'],
    baseLinguisticScore: 0.78,
  },
];

export function createExtendedFillerLexicon(
  customEntries?: readonly PersianFillerLexiconEntry[],
): readonly PersianFillerLexiconEntry[] {
  if (!customEntries || customEntries.length === 0) {
    return PERSIAN_FILLER_LEXICON;
  }
  const merged = new Map<string, PersianFillerLexiconEntry>();
  for (const entry of PERSIAN_FILLER_LEXICON) {
    merged.set(entry.lexiconId, entry);
  }
  for (const custom of customEntries) {
    if (custom && custom.lexiconId && custom.surfaceVariants.length > 0) {
      merged.set(custom.lexiconId, custom);
    }
  }
  return Array.from(merged.values());
}

export interface DetailedDisfluencyDetection {
  readonly id: string;
  readonly category: SpeechEventCategory;
  readonly subtype: SpeechEventSubtype;
  readonly detectionState: SpeechEventDetectionState;
  readonly uncertaintyState: SpeechEventUncertaintyState;
  readonly trackId: string;
  readonly targetRange: TimeRange;
  readonly affectedTokenIds: readonly string[];
  readonly relatedText: string;
  readonly preservedSpanText?: string;
  readonly preservedSpanRange?: TimeRange;
  readonly matchedLexiconId?: string;
  readonly canonicalForm?: string;
  readonly linguisticRole?: string;
  readonly linguisticScore: number;
  readonly ruleEvidenceCount: number;
  readonly modelTokenConfidence: number | null;
  readonly potentiallyRemovable: boolean;
  readonly requiresHumanReview: boolean;
  readonly hasIncompleteTiming?: boolean;
  readonly nonMedicalNotice?: string;
  readonly reasonFa: string;
  readonly notes: readonly string[];
}

export class PersianDisfluencyEngine {
  /** Prepositions/conjunctions where an immediate pause indicates mid-clause hesitation */
  private static readonly MID_CLAUSE_BOUNDARY_WORDS = new Set([
    'که', 'و', 'یا', 'از', 'به', 'در', 'با', 'برای', 'تا', 'چون', 'اگر', 'وقتی', 'چرا', 'چطور',
  ]);

  /** Common colloquial Persian discourse fillers when isolated by pauses */
  private static readonly PERSIAN_DISCOURSE_FILLERS: readonly string[] = [
    'عرضم به حضورتون',
    'عرضم به حضور شما',
    'خدمت شما عرض کنم',
    'به اصطلاح',
    'بهاصطلاح',
    'راستش رو بخواید',
    'حقیقتش',
    'خلاصه کلام',
    'چی میگن',
  ].map((phrase) => PersianTextNormalizer.normalizeTokenText(phrase));

  private static readonly PURE_VOCAL_FILLERS = /^(ا+م+|ا+ه+|ا+و+م+|ه+م+|ا+آ+|آ+|ا{2,}|م{2,}|اِ|اَم)$/;

  private static readonly TEMPORAL_BEFORE_HALA = new Set(['تا', 'از', 'همین', 'الان']);
  private static readonly TEMPORAL_AFTER_HALA = new Set(['که', 'وقتشه', 'زوده', 'دیره', 'ببینیم']);
  private static readonly NOUN_MODIFIERS_BEFORE_CHIZ = new Set([
    'این', 'آن', 'اون', 'همه', 'هیچ', 'یه', 'یک', 'چه', 'هر', 'چند', 'بهترین', 'مهم‌ترین',
  ]);
  private static readonly EXPLICIT_CORRECTION_MARKERS = new Set([
    'نه', 'ببخشید', 'یعنی', 'درواقع', 'در واقع', 'منظورم', 'اصلاح', 'اشتباه',
  ]);

  /**
   * Analyzes timed Persian tokens for self-repairs (Reparandum + Interregnum + Repair),
   * N-gram repetitions, vocal fillers, isolated discourse fillers, and abnormal pauses.
   * Preserves legacy contract for existing callers.
   */
  private static sanitizeConfidence(conf: number, fallback = 0.85): number {
    return Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : fallback;
  }

  private static safeGapMs(startFlicks: number, endFlicks: number, fallback = 0): number {
    if (!Number.isFinite(startFlicks) || !Number.isFinite(endFlicks)) return fallback;
    return TimeMath.flicksToSeconds(endFlicks - startFlicks) * 1000;
  }

  private static hasValidTokenTiming(tok: TimedPersianToken): boolean {
    if (tok.timingValid === false || tok.alignmentPrecision === 'missing') return false;
    return (
      Number.isFinite(tok.range?.start) &&
      Number.isFinite(tok.range?.end) &&
      tok.range.start >= 0 &&
      tok.range.end > tok.range.start
    );
  }

  private static isSegmentOnlyTiming(tok: TimedPersianToken): boolean {
    return (
      tok.alignmentPrecision === 'segment_only' ||
      tok.alignmentPrecision === 'distributed_segment'
    );
  }

  public static analyzeTranscript(
    tokens: TimedPersianToken[],
    maxNaturalMidPauseMs = 450,
    maxNaturalSentencePauseMs = 950,
  ): DetectedSpeechIssue[] {
    const safeMidPauseMs =
      Number.isFinite(maxNaturalMidPauseMs) && maxNaturalMidPauseMs > 0
        ? maxNaturalMidPauseMs
        : 450;
    const safeSentencePauseMs =
      Number.isFinite(maxNaturalSentencePauseMs) && maxNaturalSentencePauseMs > 0
        ? Math.max(safeMidPauseMs, maxNaturalSentencePauseMs)
        : Math.max(safeMidPauseMs, 950);
    const issues: DetectedSpeechIssue[] = [];
    const consumedIndices = new Set<number>();

    // 1. N-gram Repetitions & Self-Repairs (1..4 words) + Vocal Fillers + Discourse Fillers
    for (let i = 0; i < tokens.length; i++) {
      if (consumedIndices.has(i)) continue;

      const repairMatch = this.detectNgramRepetitionWithInterregnum(
        tokens,
        i,
        consumedIndices,
      );
      if (repairMatch) {
        for (let k = repairMatch.deleteStartIdx; k <= repairMatch.deleteEndIdx; k++) {
          consumedIndices.add(k);
        }

        const deletedTokens = tokens.slice(
          repairMatch.deleteStartIdx,
          repairMatch.deleteEndIdx + 1,
        );
        const avgAsrConf =
          deletedTokens.reduce((acc, t) => acc + this.sanitizeConfidence(t.confidence), 0) /
          deletedTokens.length;

        issues.push({
          issueId: `rep_${tokens[i].tokenId}`,
          type: 'WORD_REPETITION',
          targetRange: {
            start: Number.isFinite(deletedTokens[0].range.start) ? deletedTokens[0].range.start : 0,
            end: Number.isFinite(deletedTokens[deletedTokens.length - 1].range.end)
              ? deletedTokens[deletedTokens.length - 1].range.end
              : 0,
          },
          affectedTokenIds: deletedTokens.map((t) => t.tokenId),
          displayExcerpt: deletedTokens.map((t) => t.displayText).join(' '),
          reasonFa:
            repairMatch.ngramLength > 1
              ? 'تکرار عبارت و اصلاح درجا (حذف بخش ناتمام اول و حفظ عبارت کامل دوم)'
              : 'تکرار متوالی کلمه',
          compositeConfidence: Number(Math.min(0.98, avgAsrConf * 0.95).toFixed(2)),
          suggestedRemainingPauseFlicks: TimeMath.secondsToFlicks(0.05),
        });
        continue;
      }

      // 2. Independent vocal fillers («اممم»، «ااا»)
      const tok = tokens[i];
      if (this.PURE_VOCAL_FILLERS.test(tok.normalizedText)) {
        consumedIndices.add(i);
        const safeConf = this.sanitizeConfidence(tok.confidence);
        issues.push({
          issueId: `fil_${tok.tokenId}`,
          type: 'INDEPENDENT_FILLER',
          targetRange: {
            start: Number.isFinite(tok.range.start) ? tok.range.start : 0,
            end: Number.isFinite(tok.range.end) ? tok.range.end : 0,
          },
          affectedTokenIds: [tok.tokenId],
          displayExcerpt: tok.displayText,
          reasonFa: 'تپق آوایی مستقل در میانه گفتار',
          compositeConfidence: Number(Math.min(0.96, safeConf * 0.92).toFixed(2)),
          suggestedRemainingPauseFlicks: TimeMath.secondsToFlicks(0.06),
        });
        continue;
      }

      // 3. Isolated Persian discourse fillers surrounded by pauses
      const discourseMatch = this.detectIsolatedDiscourseFiller(tokens, i, consumedIndices);
      if (discourseMatch) {
        for (let k = discourseMatch.startIdx; k <= discourseMatch.endIdx; k++) {
          consumedIndices.add(k);
        }
        const phraseTokens = tokens.slice(discourseMatch.startIdx, discourseMatch.endIdx + 1);
        const avgConf =
          phraseTokens.reduce((acc, t) => acc + this.sanitizeConfidence(t.confidence), 0) /
          phraseTokens.length;

        issues.push({
          issueId: `disc_${phraseTokens[0].tokenId}`,
          type: 'INDEPENDENT_FILLER',
          targetRange: {
            start: Number.isFinite(phraseTokens[0].range.start) ? phraseTokens[0].range.start : 0,
            end: Number.isFinite(phraseTokens[phraseTokens.length - 1].range.end)
              ? phraseTokens[phraseTokens.length - 1].range.end
              : 0,
          },
          affectedTokenIds: phraseTokens.map((t) => t.tokenId),
          displayExcerpt: phraseTokens.map((t) => t.displayText).join(' '),
          reasonFa: 'تکیه‌کلام یا حشو محاوره‌ای محصور در مکث',
          compositeConfidence: Number(Math.min(0.9, avgConf * 0.88).toFixed(2)),
          suggestedRemainingPauseFlicks: TimeMath.secondsToFlicks(0.08),
        });
      }
    }

    // 4. Mid-clause abnormal pauses vs. sentence-boundary pauses
    for (let i = 0; i < tokens.length - 1; i++) {
      if (consumedIndices.has(i) || consumedIndices.has(i + 1)) continue;

      const curr = tokens[i];
      const next = tokens[i + 1];
      if (!Number.isFinite(curr.range.end) || !Number.isFinite(next.range.start)) continue;
      const gapFlicks = next.range.start - curr.range.end;
      const gapMs = TimeMath.flicksToSeconds(gapFlicks) * 1000;

      if (!Number.isFinite(gapMs) || gapMs <= safeMidPauseMs) continue;

      const isMidClause = this.MID_CLAUSE_BOUNDARY_WORDS.has(curr.normalizedText);
      const thresholdMs = isMidClause ? safeMidPauseMs : safeSentencePauseMs;

      if (gapMs > thresholdMs) {
        const targetRemainingMs = isMidClause ? 150 : 400;
        const targetRemainingFlicks = TimeMath.secondsToFlicks(targetRemainingMs / 1000);

        issues.push({
          issueId: `pause_${curr.tokenId}_${next.tokenId}`,
          type: 'LONG_PAUSE',
          targetRange: {
            start: curr.range.end,
            end: next.range.start,
          },
          affectedTokenIds: [],
          displayExcerpt: `[مکث ${(gapMs / 1000).toFixed(2)} ثانیه‌ای بین «${curr.displayText}» و «${next.displayText}»]`,
          reasonFa: isMidClause
            ? `مکث غیرطبیعی در میانه عبارت (پس از «${curr.displayText}»)`
            : 'سکوت طولانی بین دو جمله',
          compositeConfidence: isMidClause ? 0.91 : 0.85,
          suggestedRemainingPauseFlicks: targetRemainingFlicks,
        });
      }
    }

    return issues;
  }

  /**
   * Context-sensitive Persian speech disfluency, filler, syllable/phoneme repetition,
   * false-start, and self-correction analysis for the Unified Speech Event Engine.
   * Never deletes original text or assumes a speaker has a disorder.
   */
  public static analyzeSpeechDisfluenciesDetailed(
    tokens: readonly TimedPersianToken[],
    options: {
      hasAcousticEvidence?: boolean;
      customFillerLexicon?: readonly PersianFillerLexiconEntry[];
    } = {},
  ): DetailedDisfluencyDetection[] {
    if (tokens.length === 0) return [];
    const results: DetailedDisfluencyDetection[] = [];
    const consumed = new Set<number>();
    const hasAcoustic = options.hasAcousticEvidence ?? false;
    const activeLexicon = createExtendedFillerLexicon(options.customFillerLexicon);

    for (let i = 0; i < tokens.length; i++) {
      if (consumed.has(i)) continue;

      // A. Syllable / Initial-Phoneme Repetition & Stutter-like sequences («م م من میخواستم»)
      const sylMatch = this.detectSyllableOrInitialPhonemeRepetition(tokens, i);
      if (sylMatch) {
        for (let k = sylMatch.startIdx; k <= sylMatch.endIdx; k++) {
          consumed.add(k);
        }
        const spanTokens = tokens.slice(sylMatch.startIdx, sylMatch.endIdx + 1);
        const repeatedCount = spanTokens.length;
        const avgConf =
          spanTokens.reduce((a, t) => a + this.sanitizeConfidence(t.confidence), 0) /
          spanTokens.length;
        const spanTimingValid = spanTokens.every((t) => this.hasValidTokenTiming(t));
        const spanSegmentOnly = spanTokens.some((t) => this.isSegmentOnlyTiming(t));
        const durationSec = spanTimingValid
          ? Math.max(
              0,
              this.safeGapMs(spanTokens[0].range.start, spanTokens[spanTokens.length - 1].range.end, 0) /
                1000,
            )
          : 0;

        const isStutterLikeBlock =
          sylMatch.subtype === 'STUTTER_LIKE_BLOCK' || repeatedCount >= 3 || durationSec >= 0.9;
        const category: SpeechEventCategory = isStutterLikeBlock ? 'STUTTER' : 'SYLLABLE_REPETITION';

        results.push({
          id: `syl_${spanTokens[0].tokenId}`,
          category,
          subtype: sylMatch.subtype,
          detectionState: hasAcoustic && spanTimingValid && !spanSegmentOnly ? 'PROBABLE' : 'UNCERTAIN',
          uncertaintyState:
            hasAcoustic && spanTimingValid && !spanSegmentOnly
              ? 'MODERATE_UNCERTAINTY'
              : 'INSUFFICIENT_EVIDENCE',
          trackId: spanTokens[0].trackId,
          targetRange: {
            start: Number.isFinite(spanTokens[0].range.start) ? spanTokens[0].range.start : 0,
            end: Number.isFinite(spanTokens[spanTokens.length - 1].range.end)
              ? spanTokens[spanTokens.length - 1].range.end
              : 0,
          },
          affectedTokenIds: spanTokens.map((t) => t.tokenId),
          relatedText: spanTokens.map((t) => t.displayText).join(' '),
          preservedSpanText: sylMatch.resolvedWordToken.displayText,
          preservedSpanRange: sylMatch.resolvedWordToken.range,
          linguisticScore: hasAcoustic ? 0.78 : 0.62,
          ruleEvidenceCount: repeatedCount,
          modelTokenConfidence: Number(avgConf.toFixed(3)),
          potentiallyRemovable: false,
          requiresHumanReview: true,
          hasIncompleteTiming: !spanTimingValid || spanSegmentOnly,
          nonMedicalNotice:
            'الگوی قابل مشاهده تکرار هجا/واج آغازین در گفتار؛ این تشخیص به‌هیچ‌وجه ارزیابی پزشکی یا بالینی اختلال گفتار نیست.',
          reasonFa:
            !spanTimingValid
              ? `الگوی احتمالی تکرار هجا/واج پیش از «${sylMatch.resolvedWordToken.displayText}» (زمان‌بندی ناقص — بدون حذف خودکار)`
              : spanSegmentOnly
                ? `الگوی احتمالی تکرار هجا/واج پیش از «${sylMatch.resolvedWordToken.displayText}» (زمان‌بندی در سطح سگمنت؛ نیازمند بررسی انسانی)`
                : hasAcoustic
                  ? `تکرار هجا/واج آغازین پیش از واژه «${sylMatch.resolvedWordToken.displayText}» (نیازمند بررسی انسانی)`
                  : `الگوی احتمالی تکرار هجا/واج پیش از «${sylMatch.resolvedWordToken.displayText}» (بدون داده آکوستیکی تاییدنشده)`,
          notes: [
            `تعداد تکرار قطعه‌تکرار: ${repeatedCount}`,
            !spanTimingValid
              ? 'زمان‌بندی توکن‌ها ناقص است -> بدون برش خودکار'
              : spanSegmentOnly
                ? 'زمان‌بندی کلمه‌به‌کلمه موجود نیست -> محدود به سگمنت'
                : hasAcoustic
                  ? 'نیاز به بازبینی شنیداری پیش از هرگونه برش'
                  : 'شواهد آکوستیکی در دسترس نیست -> وضعیت نامطمئن',
          ],
        });
        continue;
      }

      // B. Explicit Self-Corrections & False Starts («من فکر میکردم که... نه، در واقع...», «میخواستم برم، نه، میخوام بمونم»)
      const repairOrFalseStart = this.detectFalseStartOrSelfCorrection(tokens, i);
      if (repairOrFalseStart) {
        for (let k = repairOrFalseStart.markStartIdx; k <= repairOrFalseStart.markEndIdx; k++) {
          consumed.add(k);
        }
        const spanTokens = tokens.slice(
          repairOrFalseStart.markStartIdx,
          repairOrFalseStart.markEndIdx + 1,
        );
        const spanTimingValid = spanTokens.every((t) => this.hasValidTokenTiming(t));
        const spanSegmentOnly = spanTokens.some((t) => this.isSegmentOnlyTiming(t));
        const avgConf =
          spanTokens.reduce((a, t) => a + this.sanitizeConfidence(t.confidence), 0) /
          spanTokens.length;
        results.push({
          id: `fs_${spanTokens[0].tokenId}`,
          category: repairOrFalseStart.category,
          subtype: repairOrFalseStart.subtype,
          detectionState: spanTimingValid ? 'PROBABLE' : 'UNCERTAIN',
          uncertaintyState: spanTimingValid ? 'MODERATE_UNCERTAINTY' : 'INSUFFICIENT_EVIDENCE',
          trackId: spanTokens[0].trackId,
          targetRange: {
            start: Number.isFinite(spanTokens[0].range.start) ? spanTokens[0].range.start : 0,
            end: Number.isFinite(spanTokens[spanTokens.length - 1].range.end)
              ? spanTokens[spanTokens.length - 1].range.end
              : 0,
          },
          affectedTokenIds: spanTokens.map((t) => t.tokenId),
          relatedText: spanTokens.map((t) => t.displayText).join(' '),
          preservedSpanText: repairOrFalseStart.continuationText,
          preservedSpanRange: repairOrFalseStart.continuationRange,
          linguisticScore: repairOrFalseStart.score,
          ruleEvidenceCount: repairOrFalseStart.ruleCount,
          modelTokenConfidence: Number(avgConf.toFixed(3)),
          potentiallyRemovable: false, // Never auto-delete semantic shifts or false starts
          requiresHumanReview: true,
          hasIncompleteTiming: !spanTimingValid || spanSegmentOnly,
          reasonFa: repairOrFalseStart.reasonFa,
          notes: repairOrFalseStart.notes,
        });
        continue;
      }

      // C. Context-Sensitive Persian Fillers (Versioned + Extensible Lexicon)
      const fillerCheck = this.classifyFillerContext(tokens, i, consumed, activeLexicon);
      if (fillerCheck) {
        for (let k = fillerCheck.startIdx; k <= fillerCheck.endIdx; k++) {
          consumed.add(k);
        }
        results.push(fillerCheck.detection);
      }
    }

    return results;
  }

  /**
   * Context-sensitive Persian filler classification against an extensible filler lexicon.
   * Preserves meaningful uses of «خب», «یعنی», «حالا», «مثلاً», «چیز», etc.
   */
  public static classifyFillerContext(
    tokens: readonly TimedPersianToken[],
    startIdx: number,
    consumed: ReadonlySet<number> = new Set(),
    lexicon: readonly PersianFillerLexiconEntry[] = PERSIAN_FILLER_LEXICON,
  ): { startIdx: number; endIdx: number; detection: DetailedDisfluencyDetection } | null {
    const first = tokens[startIdx];
    const firstNormClean = this.cleanPersianLetters(first.normalizedText || first.originalText);

    // 1. Check multi-word lexicon entries first (longest match)
    const multiEntries = lexicon.filter((e) =>
      e.surfaceVariants.some((v) => v.includes(' ')),
    );
    for (const entry of multiEntries) {
      for (const variant of entry.surfaceVariants) {
        const words = PersianTextNormalizer.normalizeTokenText(variant)
          .replace(/\u200c/g, ' ')
          .split(/\s+/)
          .filter(Boolean);
        if (words.length <= 1 || startIdx + words.length > tokens.length) continue;

        let allMatch = true;
        for (let k = 0; k < words.length; k++) {
          if (
            consumed.has(startIdx + k) ||
            tokens[startIdx + k].trackId !== first.trackId ||
            this.cleanPersianLetters(tokens[startIdx + k].normalizedText || tokens[startIdx + k].originalText) !==
              this.cleanPersianLetters(words[k])
          ) {
            allMatch = false;
            break;
          }
        }
        if (!allMatch) continue;

        const endIdx = startIdx + words.length - 1;
        const spanTokens = tokens.slice(startIdx, endIdx + 1);
        const spanTimingValid = spanTokens.every((t) => this.hasValidTokenTiming(t));
        const spanSegmentOnly = spanTokens.some((t) => this.isSegmentOnlyTiming(t));
        const { prevGapMs, nextGapMs } = this.computeAdjacentGapsMs(tokens, startIdx, endIdx);
        const isolatedByPause = spanTimingValid && !spanSegmentOnly && prevGapMs >= 160 && nextGapMs >= 160;
        const repeatedNearby = this.isPhraseRepeatedNearby(tokens, startIdx, words.length);
        const avgConf =
          spanTokens.reduce((a, t) => a + this.sanitizeConfidence(t.confidence), 0) /
          spanTokens.length;

        const isFillerUsage = isolatedByPause || repeatedNearby || entry.lexiconId === 'fil-colloq-chi-migan';
        const score = isFillerUsage
          ? Math.min(0.92, entry.baseLinguisticScore + (isolatedByPause ? 0.1 : 0) + (repeatedNearby ? 0.08 : 0))
          : Math.max(0.28, entry.baseLinguisticScore - 0.35);

        return {
          startIdx,
          endIdx,
          detection: {
            id: `fill_${spanTokens[0].tokenId}`,
            category: 'FILLER',
            subtype: isFillerUsage ? 'DISCOURSE_FILLER' : 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED',
            detectionState: !spanTimingValid ? 'UNCERTAIN' : isFillerUsage ? 'PROBABLE' : 'POSSIBLE',
            uncertaintyState:
              !spanTimingValid || spanSegmentOnly
                ? 'INSUFFICIENT_EVIDENCE'
                : isFillerUsage
                  ? 'MODERATE_UNCERTAINTY'
                  : 'HIGH_UNCERTAINTY',
            trackId: first.trackId,
            targetRange: {
              start: Number.isFinite(spanTokens[0].range.start) ? spanTokens[0].range.start : 0,
              end: Number.isFinite(spanTokens[endIdx - startIdx].range.end)
                ? spanTokens[endIdx - startIdx].range.end
                : 0,
            },
            affectedTokenIds: spanTokens.map((t) => t.tokenId),
            relatedText: spanTokens.map((t) => t.displayText).join(' '),
            matchedLexiconId: entry.lexiconId,
            canonicalForm: entry.canonicalForm,
            linguisticRole: entry.linguisticRole,
            linguisticScore: Number(score.toFixed(3)),
            ruleEvidenceCount: (isolatedByPause ? 1 : 0) + (repeatedNearby ? 1 : 0) + 1,
            modelTokenConfidence: Number(avgConf.toFixed(3)),
            potentiallyRemovable:
              isFillerUsage && entry.potentiallyRemovable && spanTimingValid && !spanSegmentOnly,
            requiresHumanReview: true,
            hasIncompleteTiming: !spanTimingValid || spanSegmentOnly,
            reasonFa: !spanTimingValid
              ? `عبارت «${entry.canonicalForm}» با زمان‌بندی ناقص (نیازمند بررسی دستی)`
              : isFillerUsage
                ? `تکیه‌کلام/عبارت پرکننده «${entry.canonicalForm}» با مکث پیرامونی`
                : `عبارت «${entry.canonicalForm}» احتمالاً معنادار یا تعارفی عمدی است (نگهداری توصیه می‌شود)`,
            notes: [
              `مکث قبل: ${Math.round(prevGapMs)}ms، مکث بعد: ${Math.round(nextGapMs)}ms`,
              isFillerUsage ? 'رفتار مکث‌دار حشو' : 'پیوسته به جمله — حفظ ساختار معنایی',
            ],
          },
        };
      }
    }

    // 2. Single-token vocal fillers («اِ», «اَم», «اوم», «آ», «اممم», «ااا», or custom VOCAL_FILLED_PAUSE)
    const customVocalEntry = lexicon.find(
      (e) =>
        e.category === 'VOCAL_FILLED_PAUSE' &&
        e.surfaceVariants.some(
          (v) =>
            !v.includes(' ') &&
            this.cleanPersianLetters(PersianTextNormalizer.normalizeTokenText(v)) === firstNormClean,
        ),
    );
    if (
      this.PURE_VOCAL_FILLERS.test(first.normalizedText) ||
      this.PURE_VOCAL_FILLERS.test(firstNormClean) ||
      customVocalEntry !== undefined
    ) {
      const matchedEntry =
        customVocalEntry ??
        lexicon.find((e) =>
          e.surfaceVariants.some(
            (v) => this.cleanPersianLetters(v) === firstNormClean || v === first.displayText,
          ),
        ) ??
        PERSIAN_FILLER_LEXICON[1];
      const tokTimingValid = this.hasValidTokenTiming(first);
      const tokSegmentOnly = this.isSegmentOnlyTiming(first);
      const durMs = tokTimingValid
        ? Math.max(0, this.safeGapMs(first.range.start, first.range.end, 120))
        : 0;
      const { prevGapMs, nextGapMs } = this.computeAdjacentGapsMs(tokens, startIdx, startIdx);
      const repeatedVocal =
        startIdx + 1 < tokens.length &&
        this.PURE_VOCAL_FILLERS.test(tokens[startIdx + 1].normalizedText);
      const stretched = tokTimingValid && !tokSegmentOnly && durMs >= 160;
      const pauseContext = tokTimingValid && !tokSegmentOnly && (prevGapMs >= 100 || nextGapMs >= 100);
      const safeConf = this.sanitizeConfidence(first.confidence);
      const score = Math.min(
        0.95,
        matchedEntry.baseLinguisticScore * 0.85 + (stretched ? 0.06 : 0) + (pauseContext ? 0.05 : 0) + (repeatedVocal ? 0.05 : 0),
      );

      return {
        startIdx,
        endIdx: startIdx,
        detection: {
          id: `vfill_${first.tokenId}`,
          category: 'FILLER',
          subtype: 'VOCAL_FILLED_PAUSE',
          detectionState: !tokTimingValid ? 'UNCERTAIN' : tokSegmentOnly ? 'PROBABLE' : 'DETECTED',
          uncertaintyState:
            !tokTimingValid || tokSegmentOnly ? 'INSUFFICIENT_EVIDENCE' : 'LOW_UNCERTAINTY',
          trackId: first.trackId,
          targetRange: {
            start: Number.isFinite(first.range.start) ? first.range.start : 0,
            end: Number.isFinite(first.range.end) ? first.range.end : 0,
          },
          affectedTokenIds: [first.tokenId],
          relatedText: first.displayText,
          matchedLexiconId: matchedEntry.lexiconId,
          canonicalForm: matchedEntry.canonicalForm,
          linguisticRole: matchedEntry.linguisticRole,
          linguisticScore: Number(score.toFixed(3)),
          ruleEvidenceCount: 1 + (stretched ? 1 : 0) + (pauseContext ? 1 : 0) + (repeatedVocal ? 1 : 0),
          modelTokenConfidence: Number(safeConf.toFixed(3)),
          potentiallyRemovable: tokTimingValid && !tokSegmentOnly && matchedEntry.potentiallyRemovable,
          requiresHumanReview: !tokTimingValid || tokSegmentOnly || durMs < 90 || safeConf < 0.75,
          hasIncompleteTiming: !tokTimingValid || tokSegmentOnly,
          reasonFa: !tokTimingValid
            ? `تپق آوایی «${first.displayText}» شناسایی شد اما زمان‌بندی دقیق موجود نیست`
            : tokSegmentOnly
              ? `تپق آوایی «${first.displayText}» در سطح سگمنت (نیازمند بررسی انسانی؛ زمان‌بندی کلمه‌به‌کلمه موجود نیست)`
              : `تپق آوایی مستقل «${first.displayText}» (${Math.round(durMs)}ms)`,
          notes: [`مدت: ${Math.round(durMs)}ms`, `مکث اطراف: ${Math.round(prevGapMs)}ms / ${Math.round(nextGapMs)}ms`],
        },
      };
    }

    // 3. Single-token contextual discourse markers («خب», «یعنی», «حالا», «مثلاً», «چیز», «به‌اصطلاح», + custom)
    const singleEntry = lexicon.find(
      (e) =>
        e.category !== 'VOCAL_FILLED_PAUSE' &&
        e.surfaceVariants.some(
          (v) =>
            !v.includes(' ') &&
            this.cleanPersianLetters(PersianTextNormalizer.normalizeTokenText(v)) === firstNormClean,
        ),
    );
    if (!singleEntry) return null;

    const tokTimingValid = this.hasValidTokenTiming(first);
    const tokSegmentOnly = this.isSegmentOnlyTiming(first);
    const prevTok = startIdx > 0 && tokens[startIdx - 1].trackId === first.trackId ? tokens[startIdx - 1] : null;
    const nextTok =
      startIdx + 1 < tokens.length && tokens[startIdx + 1].trackId === first.trackId
        ? tokens[startIdx + 1]
        : null;
    const prevNorm = prevTok ? this.cleanPersianLetters(prevTok.normalizedText) : '';
    const nextNorm = nextTok ? this.cleanPersianLetters(nextTok.normalizedText) : '';
    const { prevGapMs, nextGapMs } = this.computeAdjacentGapsMs(tokens, startIdx, startIdx);
    const durMs = tokTimingValid
      ? Math.max(0, this.safeGapMs(first.range.start, first.range.end, 120))
      : 0;
    const safeConf = this.sanitizeConfidence(first.confidence);

    let preserveReason: string | null = null;

    if (singleEntry.canonicalForm === 'خب') {
      const adjContextWordsBefore = new Set([
        'خیلی', 'بسیار', 'واقعا', 'واقعاً', 'چقدر', 'یه', 'یک', 'این', 'خبر', 'حس', 'کار', 'اتفاق', 'روز',
      ]);
      const adjContextWordsAfter = new Set([
        'است', 'بود', 'شد', 'می‌شه', 'میشه', 'هست', 'هستم', 'نیست', 'نبود',
      ]);
      if (firstNormClean === 'خوب' && (adjContextWordsBefore.has(prevNorm) || adjContextWordsAfter.has(nextNorm))) {
        preserveReason = 'واژه «خوب» در نقش صفت یا قید معنادار به کار رفته است';
      } else if (startIdx === 0 && (nextGapMs < 220 || !tokTimingValid || tokSegmentOnly)) {
        preserveReason = '«خب» در آغاز جمله بدون مکث تردیدی (نشانگر گذار طبیعی گفتمان)';
      } else if (nextTok && adjContextWordsAfter.has(nextNorm)) {
        preserveReason = 'واژه «خوب/خب» به عنوان صفت یا خبر معنادار به کار رفته است';
      }
    } else if (singleEntry.canonicalForm === 'یعنی') {
      if (prevTok && nextTok && (nextGapMs < 240 || !tokTimingValid || tokSegmentOnly) && !this.PURE_VOCAL_FILLERS.test(nextTok.normalizedText)) {
        preserveReason = '«یعنی» پیونددهنده توضیح یا تعریف معنایی است (نه حشو تردیدی)';
      }
    } else if (singleEntry.canonicalForm === 'حالا') {
      if (this.TEMPORAL_BEFORE_HALA.has(prevNorm) || this.TEMPORAL_AFTER_HALA.has(nextNorm) || nextGapMs < 220) {
        preserveReason = '«حالا» در معنای قید زمان («اکنون») استفاده شده و باید حفظ شود';
      }
    } else if (singleEntry.canonicalForm === 'مثلاً') {
      if (nextTok && (nextGapMs < 240 || !tokTimingValid || tokSegmentOnly) && !this.PURE_VOCAL_FILLERS.test(nextTok.normalizedText)) {
        preserveReason = '«مثلاً» معرفی‌کننده یک مثال واقعی در ادامه جمله است';
      }
    } else if (singleEntry.canonicalForm === 'چیز') {
      if (this.NOUN_MODIFIERS_BEFORE_CHIZ.has(prevNorm) || (nextTok && ['مهم', 'مهمه', 'خوبی', 'جدید', 'بدی', 'عجیبی', 'است', 'بود'].includes(nextNorm))) {
        preserveReason = '«چیز» در نقش اسم معنادار به کار رفته و تپق نیست';
      }
    }

    const followedByVocalFiller = nextTok ? this.PURE_VOCAL_FILLERS.test(nextTok.normalizedText) : false;
    const precededByVocalFiller = prevTok ? this.PURE_VOCAL_FILLERS.test(prevTok.normalizedText) : false;
    const isolatedByHesitation = tokTimingValid && !tokSegmentOnly && prevGapMs >= 200 && nextGapMs >= 220;
    const repeatedSame = nextNorm === firstNormClean;

    if (preserveReason && !followedByVocalFiller && !precededByVocalFiller && !repeatedSame && !isolatedByHesitation) {
      return {
        startIdx,
        endIdx: startIdx,
        detection: {
          id: `disc_keep_${first.tokenId}`,
          category: 'FILLER',
          subtype: 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED',
          detectionState: 'NOT_DETECTED',
          uncertaintyState: 'LOW_UNCERTAINTY',
          trackId: first.trackId,
          targetRange: {
            start: Number.isFinite(first.range.start) ? first.range.start : 0,
            end: Number.isFinite(first.range.end) ? first.range.end : 0,
          },
          affectedTokenIds: [first.tokenId],
          relatedText: first.displayText,
          matchedLexiconId: singleEntry.lexiconId,
          canonicalForm: singleEntry.canonicalForm,
          linguisticRole: singleEntry.linguisticRole,
          linguisticScore: 0.18,
          ruleEvidenceCount: 1,
          modelTokenConfidence: Number(safeConf.toFixed(3)),
          potentiallyRemovable: false,
          requiresHumanReview: false,
          hasIncompleteTiming: !tokTimingValid || tokSegmentOnly,
          reasonFa: preserveReason,
          notes: [`حفظ بر اساس بافت زبانی: ${preserveReason}`],
        },
      };
    }

    // Hesitation / filler context detected
    const contextBoost =
      (isolatedByHesitation ? 0.24 : 0) +
      (followedByVocalFiller || precededByVocalFiller ? 0.22 : 0) +
      (repeatedSame ? 0.22 : 0) +
      (durMs >= 380 ? 0.08 : 0);

    const linguisticScore = Math.min(0.91, singleEntry.baseLinguisticScore + contextBoost);
    const strongFillerEvidence =
      followedByVocalFiller || precededByVocalFiller || isolatedByHesitation || repeatedSame;

    return {
      startIdx,
      endIdx: startIdx,
      detection: {
        id: `disc_${first.tokenId}`,
        category: 'FILLER',
        subtype:
          singleEntry.category === 'COLLOQUIAL_FILLER'
            ? 'CONTEXT_DEPENDENT_COLLOQUIAL'
            : 'DISCOURSE_FILLER',
        detectionState:
          !tokTimingValid
            ? 'UNCERTAIN'
            : strongFillerEvidence
              ? 'PROBABLE'
              : 'POSSIBLE',
        uncertaintyState:
          !tokTimingValid || tokSegmentOnly
            ? 'INSUFFICIENT_EVIDENCE'
            : strongFillerEvidence
              ? 'MODERATE_UNCERTAINTY'
              : 'HIGH_UNCERTAINTY',
        trackId: first.trackId,
        targetRange: {
          start: Number.isFinite(first.range.start) ? first.range.start : 0,
          end: Number.isFinite(first.range.end) ? first.range.end : 0,
        },
        affectedTokenIds: [first.tokenId],
        relatedText: first.displayText,
        matchedLexiconId: singleEntry.lexiconId,
        canonicalForm: singleEntry.canonicalForm,
        linguisticRole: singleEntry.linguisticRole,
        linguisticScore: Number(linguisticScore.toFixed(3)),
        ruleEvidenceCount:
          1 +
          (isolatedByHesitation ? 1 : 0) +
          (followedByVocalFiller || precededByVocalFiller ? 1 : 0) +
          (repeatedSame ? 1 : 0),
        modelTokenConfidence: Number(safeConf.toFixed(3)),
        potentiallyRemovable:
          strongFillerEvidence && singleEntry.potentiallyRemovable && tokTimingValid && !tokSegmentOnly,
        requiresHumanReview: true,
        hasIncompleteTiming: !tokTimingValid || tokSegmentOnly,
        reasonFa: !tokTimingValid
          ? `کاربرد احتمالی پرکننده «${first.displayText}» بدون زمان‌بندی دقیق (نیازمند بازبینی انسانی)`
          : strongFillerEvidence
            ? `کاربرد تردیدی/حشو احتمالی برای «${first.displayText}» در بافت مکث‌دار`
            : `عبارت بافت‌وابسته «${first.displayText}» (اطلاعاتی؛ نیازمند تایید کاربر)`,
        notes: [
          `مکث قبل: ${Math.round(prevGapMs)}ms، مکث بعد: ${Math.round(nextGapMs)}ms`,
          preserveReason ? `احتمال کاربرد معنادار نیز وجود دارد: ${preserveReason}` : 'فاقد نشانگر معنایی محافظت‌شده',
        ],
      },
    };
  }

  private static detectSyllableOrInitialPhonemeRepetition(
    tokens: readonly TimedPersianToken[],
    startIdx: number,
  ): {
    startIdx: number;
    endIdx: number;
    subtype: SpeechEventSubtype;
    resolvedWordToken: TimedPersianToken;
  } | null {
    const first = tokens[startIdx];
    const firstClean = this.cleanPersianLetters(first.normalizedText);
    if (firstClean.length === 0 || firstClean.length > 3) return null;
    if (this.PURE_VOCAL_FILLERS.test(firstClean)) return null;

    // Look ahead for repeated fragments («م م من», «می می میخواستم», «ب ب باید», «سلا... سلام»)
    let j = startIdx + 1;
    while (j < tokens.length && j - startIdx <= 4) {
      if (tokens[j].trackId !== first.trackId) break;
      const bothTimed = this.hasValidTokenTiming(tokens[j - 1]) && this.hasValidTokenTiming(tokens[j]);
      if (bothTimed) {
        const gapSec =
          this.safeGapMs(tokens[j - 1].range.end, tokens[j].range.start, Number.POSITIVE_INFINITY) /
          1000;
        if (!Number.isFinite(gapSec) || gapSec > 1.2 || gapSec < 0) break;
      }

      const curClean = this.cleanPersianLetters(tokens[j].normalizedText);
      // Either another identical short fragment or the full target word starting with this phoneme/syllable
      if (curClean === firstClean && j < tokens.length - 1) {
        j++;
        continue;
      }

      if (curClean.length > firstClean.length && curClean.startsWith(firstClean)) {
        const fragCount = j - startIdx;
        // Require either >= 2 repeated short fragments («م م من») OR single 1-char non-lexical fragment («ب باید») OR explicitly broken partial prefix («سلا... سلام»)
        const nonLexicalOneChar = firstClean.length === 1 && !['و'].includes(firstClean);
        const explicitBrokenPrefix =
          firstClean.length >= 2 &&
          curClean.length >= firstClean.length + 2 &&
          (/[…\-–—]$|\.\.\.$/.test(first.displayText.trim()) ||
            !new Set(['در', 'با', 'از', 'به', 'تا', 'بر', 'که', 'ما', 'من', 'تو', 'او', 'این', 'آن', 'هم', 'چه', 'کی', 'نه', 'پس', 'سر', 'تن', 'دو', 'سه', 'یک']).has(firstClean));
        if (fragCount >= 2 || nonLexicalOneChar || explicitBrokenPrefix) {
          return {
            startIdx,
            endIdx: j - 1,
            subtype:
              firstClean.length === 1
                ? fragCount >= 2
                  ? 'STUTTER_LIKE_BLOCK'
                  : 'INITIAL_PHONEME_REPETITION'
                : 'SYLLABLE_REPETITION',
            resolvedWordToken: tokens[j],
          };
        }
      }
      break;
    }

    return null;
  }

  private static detectFalseStartOrSelfCorrection(
    tokens: readonly TimedPersianToken[],
    startIdx: number,
  ): {
    category: SpeechEventCategory;
    subtype: SpeechEventSubtype;
    markStartIdx: number;
    markEndIdx: number;
    continuationText: string;
    continuationRange: TimeRange;
    score: number;
    ruleCount: number;
    reasonFa: string;
    notes: string[];
  } | null {
    // Look ahead within 1..6 tokens on same track for an explicit correction marker or abandoned break
    const startTok = tokens[startIdx];
    const maxLookahead = Math.min(tokens.length - 1, startIdx + 6);

    for (let m = startIdx + 1; m <= maxLookahead; m++) {
      const markerTok = tokens[m];
      if (markerTok.trackId !== startTok.trackId) break;
      const markerNorm = this.cleanPersianLetters(markerTok.normalizedText);
      const isCorrectionMarker =
        this.EXPLICIT_CORRECTION_MARKERS.has(markerNorm) ||
        (m + 1 <= maxLookahead &&
          markerNorm === 'در' &&
          this.cleanPersianLetters(tokens[m + 1].normalizedText) === 'واقع');

      if (!isCorrectionMarker) continue;

      const prevBeforeMarker = tokens[m - 1];
      const gapBeforeMarkerMs = this.safeGapMs(
        prevBeforeMarker.range.end,
        markerTok.range.start,
        0,
      );
      const nextAfterMarker = m + 1 <= maxLookahead ? tokens[m + 1] : null;
      const nextAfterNorm = nextAfterMarker
        ? this.cleanPersianLetters(nextAfterMarker.normalizedText)
        : '';
      const hasCompoundCorrectionMarker =
        nextAfterMarker !== null &&
        nextAfterMarker.trackId === startTok.trackId &&
        (this.EXPLICIT_CORRECTION_MARKERS.has(nextAfterNorm) ||
          (m + 2 <= maxLookahead &&
            nextAfterNorm === 'در' &&
            this.cleanPersianLetters(tokens[m + 2].normalizedText) === 'واقع'));

      const hasAbandonedClauseCue =
        gapBeforeMarkerMs >= 160 ||
        hasCompoundCorrectionMarker ||
        /\.\.\.|…|،$/.test(prevBeforeMarker.displayText) ||
        this.MID_CLAUSE_BOUNDARY_WORDS.has(this.cleanPersianLetters(prevBeforeMarker.normalizedText));

      if (!hasAbandonedClauseCue) continue;

      let repairStartIdx =
        markerNorm === 'در' && m + 1 <= maxLookahead ? m + 2 : m + 1;
      if (hasCompoundCorrectionMarker) {
        repairStartIdx = nextAfterNorm === 'در' ? m + 3 : m + 2;
      }
      if (repairStartIdx >= tokens.length) continue;

      const repairEndIdx = Math.min(tokens.length - 1, repairStartIdx + 3);
      const repairSpan = tokens.slice(repairStartIdx, repairEndIdx + 1);
      const abandonedSpan = tokens.slice(startIdx, m);
      if (abandonedSpan.length === 0) continue;

      const firstAbandonedWord = this.cleanPersianLetters(abandonedSpan[0].normalizedText);
      const firstRepairWord = this.cleanPersianLetters(repairSpan[0].normalizedText);
      const isRestartOrReformulation =
        firstAbandonedWord === firstRepairWord ||
        markerNorm === 'نه' ||
        markerNorm === 'ببخشید' ||
        markerNorm === 'اشتباه';

      const category: SpeechEventCategory =
        markerNorm === 'نه' || markerNorm === 'ببخشید' || markerNorm === 'اشتباه' || markerNorm === 'منظورم'
          ? 'SELF_CORRECTION'
          : 'FALSE_START';
      const subtype: SpeechEventSubtype =
        category === 'SELF_CORRECTION'
          ? isRestartOrReformulation
            ? 'EXPLICIT_CORRECTION'
            : 'REFORMULATION'
          : 'ABANDONED_PHRASE';

      return {
        category,
        subtype,
        markStartIdx: startIdx,
        markEndIdx: m - 1,
        continuationText: repairSpan.map((t) => t.displayText).join(' '),
        continuationRange: {
          start: Number.isFinite(repairSpan[0].range.start) ? repairSpan[0].range.start : 0,
          end: Number.isFinite(repairSpan[repairSpan.length - 1].range.end)
            ? repairSpan[repairSpan.length - 1].range.end
            : 0,
        },
        score: gapBeforeMarkerMs >= 280 ? 0.8 : 0.68,
        ruleCount: 2 + (gapBeforeMarkerMs >= 280 ? 1 : 0),
        reasonFa:
          category === 'SELF_CORRECTION'
            ? `اصلاح درجا یا بازگویی پس از «${abandonedSpan.map((t) => t.displayText).join(' ')}» با نشانگر «${markerTok.displayText}» (بازه اول و دوم هر دو حفظ شده‌اند)`
            : `شروع ناتمام و تغییر مسیر عبارت پیش از «${markerTok.displayText}» (نیازمند بررسی کاربر)`,
        notes: [
          `بازه پیشین: «${abandonedSpan.map((t) => t.displayText).join(' ')}»`,
          `بازه اصلاحی/ادامه: «${repairSpan.map((t) => t.displayText).join(' ')}»`,
          'حذف خودکار مجاز نیست؛ ممکن است بخش اول حاوی معنای معتبر باشد.',
        ],
      };
    }

    return null;
  }

  private static computeAdjacentGapsMs(
    tokens: readonly TimedPersianToken[],
    startIdx: number,
    endIdx: number,
  ): { prevGapMs: number; nextGapMs: number } {
    const first = tokens[startIdx];
    const last = tokens[endIdx];
    const prevGapMs =
      startIdx === 0 || tokens[startIdx - 1].trackId !== first.trackId
        ? 250
        : Math.max(0, this.safeGapMs(tokens[startIdx - 1].range.end, first.range.start, 250));
    const nextGapMs =
      endIdx === tokens.length - 1 || tokens[endIdx + 1].trackId !== last.trackId
        ? 250
        : Math.max(0, this.safeGapMs(last.range.end, tokens[endIdx + 1].range.start, 250));
    return { prevGapMs, nextGapMs };
  }

  private static isPhraseRepeatedNearby(
    tokens: readonly TimedPersianToken[],
    startIdx: number,
    len: number,
  ): boolean {
    if (startIdx + len * 2 > tokens.length) return false;
    for (let k = 0; k < len; k++) {
      if (
        this.cleanPersianLetters(tokens[startIdx + k].normalizedText) !==
        this.cleanPersianLetters(tokens[startIdx + len + k].normalizedText)
      ) {
        return false;
      }
    }
    return true;
  }

  private static cleanPersianLetters(text: string): string {
    return PersianTextNormalizer.toCanonicalComparisonForm(text);
  }

  private static detectNgramRepetitionWithInterregnum(
    tokens: TimedPersianToken[],
    startIdx: number,
    consumedIndices: Set<number>,
  ): { deleteStartIdx: number; deleteEndIdx: number; ngramLength: number } | null {
    // Do not treat vocal fillers as the start of a lexical N-gram repetition
    if (this.PURE_VOCAL_FILLERS.test(tokens[startIdx].normalizedText)) {
      return null;
    }

    for (let n = 4; n >= 1; n--) {
      if (startIdx + n * 2 > tokens.length) continue;

      const firstSpan = tokens.slice(startIdx, startIdx + n);
      if (firstSpan.some((_t, offset) => consumedIndices.has(startIdx + offset))) continue;

      // Skip zero or more consecutive vocal fillers (Interregnum) between Reparandum & Repair
      let repairStartIdx = startIdx + n;
      while (
        repairStartIdx < tokens.length &&
        this.PURE_VOCAL_FILLERS.test(tokens[repairStartIdx].normalizedText)
      ) {
        repairStartIdx++;
      }

      if (repairStartIdx + n > tokens.length) continue;
      const secondSpan = tokens.slice(repairStartIdx, repairStartIdx + n);

      const timingComparable =
        this.hasValidTokenTiming(firstSpan[firstSpan.length - 1]) &&
        this.hasValidTokenTiming(secondSpan[0]);
      if (timingComparable) {
        const gapSeconds =
          this.safeGapMs(
            firstSpan[firstSpan.length - 1].range.end,
            secondSpan[0].range.start,
            Number.POSITIVE_INFINITY,
          ) / 1000;
        if (!Number.isFinite(gapSeconds) || gapSeconds > 2.5 || gapSeconds < 0) continue;
      }

      const hasSubstantiveToken = firstSpan.some(
        (tok) => this.cleanPersianLetters(tok.normalizedText || tok.originalText).length > 1,
      );
      if (!hasSubstantiveToken) continue;

      const isExactMatch = firstSpan.every((tok, idx) => {
        const a = this.cleanPersianLetters(tok.normalizedText || tok.originalText);
        const b = this.cleanPersianLetters(secondSpan[idx].normalizedText || secondSpan[idx].originalText);
        return a.length > 0 && a === b;
      });

      if (isExactMatch) {
        return {
          deleteStartIdx: startIdx,
          deleteEndIdx: repairStartIdx - 1,
          ngramLength: n,
        };
      }
    }
    return null;
  }

  private static detectIsolatedDiscourseFiller(
    tokens: TimedPersianToken[],
    startIdx: number,
    consumedIndices: Set<number>,
  ): { startIdx: number; endIdx: number } | null {
    for (const fillerPhrase of this.PERSIAN_DISCOURSE_FILLERS) {
      const fillerWords = fillerPhrase.replace(/\u200c/g, ' ').split(' ');
      const endIdx = startIdx + fillerWords.length - 1;

      let matchedEndIdx = -1;
      // Case A: Multi-token match (space-separated ASR tokens)
      if (endIdx < tokens.length) {
        let matches = true;
        for (let k = 0; k < fillerWords.length; k++) {
          const cleanTok = tokens[startIdx + k].normalizedText.replace(/\u200c/g, '');
          if (consumedIndices.has(startIdx + k) || cleanTok !== fillerWords[k]) {
            matches = false;
            break;
          }
        }
        if (matches) matchedEndIdx = endIdx;
      }

      // Case B: Single ZWNJ-joined ASR token (e.g., «به‌اصطلاح»)
      if (matchedEndIdx === -1 && !consumedIndices.has(startIdx)) {
        const singleClean = tokens[startIdx].normalizedText.replace(/\u200c/g, ' ');
        if (singleClean === fillerWords.join(' ')) {
          matchedEndIdx = startIdx;
        }
      }

      if (matchedEndIdx === -1) continue;

      const prevGapMs =
        startIdx === 0
          ? 250
          : this.safeGapMs(tokens[startIdx - 1].range.end, tokens[startIdx].range.start, 250);
      const nextGapMs =
        matchedEndIdx === tokens.length - 1
          ? 250
          : this.safeGapMs(
              tokens[matchedEndIdx].range.end,
              tokens[matchedEndIdx + 1].range.start,
              250,
            );

      if (prevGapMs >= 180 && nextGapMs >= 180) {
        return { startIdx, endIdx: matchedEndIdx };
      }
    }
    return null;
  }
}
