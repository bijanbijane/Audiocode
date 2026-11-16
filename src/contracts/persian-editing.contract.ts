import { TimeRange } from './timebase.contract';

export type DisfluencyType =
  | 'INDEPENDENT_FILLER'     // تپق مستقل («اممم»، «ااا»)
  | 'COARTICULATED_STRETCH'  // تپق چسبیده به انتهای کلمه («رفتیمممم»)
  | 'WORD_REPETITION'        // تکرار کلمه
  | 'LONG_PAUSE'             // مکث غیرطبیعی
  | 'INCOMPLETE_PHRASE';     // عبارت ناتمام

export type ProsodicWarningType =
  | 'TRAILING_EZAFE_RISK'     // احتمال باقی ماندن کسره اضافه «ـِ» روی کلمه قبلی پس از حذف
  | 'COMPOUND_VERB_SPLIT'     // برش در میانه فعل مرکب یا پیشوند «می»
  | 'CROSSTALK_BLEED_ACTIVE'; // فعال بودن صدای گوینده دیگر در ترک موازی

export type MultiTrackCutStrategy =
  | 'GLOBAL_SYNC_RIPPLE'      // برش و جمع‌کردن زمان در تمام ترک‌های قفل‌شده (وقتی سایر ترک‌ها ساکت‌اند)
  | 'IN_PLACE_ROOM_TONE';     // جایگزینی درجا با صدای محیط بدون تغییر طول زمان (برای حفظ سینک)

export interface SmartSpliceDescriptor {
  readonly rawAiRange: TimeRange;
  readonly snappedAcousticRange: TimeRange;
  readonly fadeInDurationFlicks: number;   // 5ms..15ms Equal-Power
  readonly fadeOutDurationFlicks: number;
  readonly injectRoomToneFlicks: number;
  readonly cutStrategy: MultiTrackCutStrategy;
  readonly prosodicWarnings: ProsodicWarningType[];
  readonly confidence: number;
}
