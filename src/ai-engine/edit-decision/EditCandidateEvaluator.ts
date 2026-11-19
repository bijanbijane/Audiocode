import { SpeechEvent } from '../speech-events/SpeechEventContracts';
import {
  CandidateEligibilityClass,
  EditConfidenceClassification,
  EditOperationType,
} from './EditDecisionTypes';

export interface CandidateEvaluationResult {
  readonly operation: EditOperationType;
  readonly eligibility: CandidateEligibilityClass;
  readonly confidenceClassification: EditConfidenceClassification;
  readonly requiresHumanReview: boolean;
  readonly protectedEvent: boolean;
  readonly reason: string;
  readonly explanationFa: string;
  readonly policyNotes: readonly string[];
}

/**
 * Contextual Persian expressions requiring pragmatic disambiguation before any deletion.
 */
const CONTEXT_SENSITIVE_PERSIAN_MARKERS = new Set([
  'یعنی',
  'خب',
  'خوب',
  'حالا',
  'مثلاً',
  'مثلا',
  'در واقع',
  'درواقع',
  'به‌اصطلاح',
  'به اصطلاح',
  'بهاصطلاح',
  'عرضم به حضور شما',
  'چیز',
  'چی میگن',
  'چی می‌گن',
]);

const PURE_VOCAL_FILLER_FORMS = new Set([
  'اِ',
  'ا',
  'اه',
  'اَم',
  'ام',
  'امم',
  'اممم',
  'اوم',
  'اومم',
  'آ',
  'آه',
  'ااا',
]);

function normalizeText(text?: string): string {
  if (!text) return '';
  return text
    .replace(/[\u200c\u064B-\u0652]/g, '')
    .replace(/[،؛.!؟«»()[\]…]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .trim();
}

export function classifyEventConfidence(event: SpeechEvent): EditConfidenceClassification {
  if (
    event.detectionState === 'UNSUPPORTED' ||
    event.uncertaintyState === 'UNSUPPORTED_CAPABILITY'
  ) {
    return 'UNSUPPORTED';
  }
  if (
    event.uncertaintyState === 'INSUFFICIENT_EVIDENCE' ||
    event.uncertaintyState === 'CONFLICTING_EVIDENCE' ||
    event.detectionState === 'UNCERTAIN'
  ) {
    return 'INSUFFICIENT';
  }

  const score = event.scores.calibratedProbability ?? event.confidence;
  const calStatus = event.scores.scoreCalibrationStatus;

  if (calStatus === 'CALIBRATED_EMPIRICAL') {
    if (score >= 0.82) return 'CALIBRATED_HIGH';
    if (score >= 0.58) return 'CALIBRATED_MEDIUM';
    return 'CALIBRATED_LOW';
  }

  if (calStatus === 'MODEL_RAW_CONFIDENCE') {
    return 'MODEL_RAW';
  }

  if (score >= 0.82) return 'HIGH_HEURISTIC';
  if (score >= 0.58) return 'MEDIUM_HEURISTIC';
  return 'LOW_HEURISTIC';
}

/**
 * Explicit, testable Event-to-Decision Policy Evaluator (AVP-P05-001 Sections 4 & 5)
 * Strictly distinguishes:
 * 1. Detectable event
 * 2. Valid editing candidate
 * 3. Safe editing candidate
 * 4. Requires human interpretation
 * 5. Should not be edited (NO_EDIT_RECOMMENDED)
 */
export class EditCandidateEvaluator {
  public static evaluate(
    event: SpeechEvent,
    context?: {
      readonly allEventsInRecording?: readonly SpeechEvent[];
    },
  ): CandidateEvaluationResult {
    const confClass = classifyEventConfidence(event);
    const notes: string[] = [];

    // 0. Unsupported or non-detected events are NEVER deletion candidates
    if (
      event.detectionState === 'UNSUPPORTED' ||
      event.uncertaintyState === 'UNSUPPORTED_CAPABILITY'
    ) {
      return {
        operation: 'NO_EDIT_RECOMMENDED',
        eligibility: 'INVALID_CANDIDATE',
        confidenceClassification: 'UNSUPPORTED',
        requiresHumanReview: true,
        protectedEvent: false,
        reason: 'Unsupported detector capability cannot authorize an editing operation.',
        explanationFa:
          'قابلیت تشخیص برای این رویداد پشتیبانی نمی‌شود؛ پیشنهاد ویرایش تولید نمی‌شود.',
        policyNotes: ['UNSUPPORTED detector -> NO_EDIT_RECOMMENDED'],
      };
    }

    if (event.detectionState === 'NOT_DETECTED') {
      return {
        operation: 'NO_EDIT_RECOMMENDED',
        eligibility: 'DO_NOT_EDIT',
        confidenceClassification: confClass,
        requiresHumanReview: false,
        protectedEvent: true,
        reason: `Event subtype ${event.subtype} explicitly marked preserved / not a disfluency.`,
        explanationFa: event.explanationFa || 'عبارت معنادار است و نیازی به ویرایش ندارد.',
        policyNotes: ['NOT_DETECTED / preserved meaningful expression -> NO_EDIT_RECOMMENDED'],
      };
    }

    // Check insufficient or conflicting evidence upfront
    const hasConflicts = event.scores.conflicts.length > 0;
    const isInsufficient =
      event.detectionState === 'UNCERTAIN' ||
      event.uncertaintyState === 'INSUFFICIENT_EVIDENCE' ||
      event.uncertaintyState === 'CONFLICTING_EVIDENCE';

    // --- 5.1 FILLERS ---
    if (event.category === 'FILLER') {
      const canonical = normalizeText(
        event.linguisticEvidence?.canonicalForm ?? event.relatedText,
      );
      const rawNorm = normalizeText(event.relatedText);

      // Explicitly preserved meaningful discourse markers («یعنی», «خب», «حالا», «مثلاً», «چیز»)
      if (event.subtype === 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED') {
        return {
          operation: 'NO_EDIT_RECOMMENDED',
          eligibility: 'DO_NOT_EDIT',
          confidenceClassification: confClass,
          requiresHumanReview: false,
          protectedEvent: true,
          reason: `Meaningful Persian discourse marker («${event.relatedText ?? canonical}») must be preserved.`,
          explanationFa: `کاربرد معنادار «${event.relatedText ?? canonical}» در جمله حفظ می‌شود و نباید حذف شود.`,
          policyNotes: ['Protected meaningful discourse marker'],
        };
      }

      const isContextSensitive =
        CONTEXT_SENSITIVE_PERSIAN_MARKERS.has(canonical) ||
        CONTEXT_SENSITIVE_PERSIAN_MARKERS.has(rawNorm) ||
        event.subtype === 'DISCOURSE_FILLER' ||
        event.subtype === 'CONTEXT_DEPENDENT_COLLOQUIAL';

      const isPureVocalFiller =
        event.subtype === 'VOCAL_FILLED_PAUSE' ||
        PURE_VOCAL_FILLER_FORMS.has(canonical) ||
        PURE_VOCAL_FILLER_FORMS.has(rawNorm);

      // Ambiguous or low-evidence filler -> NEEDS_REVIEW (never automatic deletion)
      if (isInsufficient || hasConflicts || event.confidence < 0.58) {
        notes.push('Insufficient or conflicting filler evidence; held for manual review.');
        return {
          operation: 'NO_EDIT_RECOMMENDED',
          eligibility: 'DETECTABLE_NOT_EDITABLE',
          confidenceClassification: confClass,
          requiresHumanReview: true,
          protectedEvent: false,
          reason: 'Filler candidate lacks sufficient reliable acoustic/linguistic evidence for deletion.',
          explanationFa: `شواهد برای حذف «${event.relatedText ?? 'تپق'}» کافی یا هم‌راستا نیست؛ نیازمند بررسی انسانی.`,
          policyNotes: notes,
        };
      }

      // Context-sensitive Persian markers require human review unless overwhelmingly corroborated
      if (isContextSensitive && !isPureVocalFiller) {
        const strongCorroboration =
          event.eligibleForEditSuggestion &&
          event.confidence >= 0.84 &&
          event.scores.acousticScore !== null &&
          event.scores.acousticScore >= 0.72 &&
          event.scores.ruleEvidenceCount >= 2;

        if (!strongCorroboration) {
          notes.push(
            `Context-sensitive Persian expression «${canonical}» cannot be auto-removed solely from lexicon match.`,
          );
          return {
            operation: 'REMOVE_FILLER',
            eligibility: 'REVIEW_REQUIRED_CANDIDATE',
            confidenceClassification: confClass,
            requiresHumanReview: true,
            protectedEvent: false,
            reason: `Ambiguous Persian discourse filler («${canonical}») requires human review to verify no pragmatic/explanatory meaning is lost.`,
            explanationFa: `عبارت بافت‌وابسته «${event.relatedText ?? canonical}» ممکن است نقش معنایی/گفتمانی داشته باشد؛ حذف فقط پس از بازبینی انسانی مجاز است.`,
            policyNotes: notes,
          };
        }
      }

      // Pure non-semantic vocal hesitation («اِ»، «اَم»، «اوم»، «آ») with strong evidence
      const safeCandidate =
        isPureVocalFiller &&
        event.eligibleForEditSuggestion &&
        event.confidence >= 0.82 &&
        !hasConflicts &&
        event.scores.acousticScore !== null;

      return {
        operation: 'REMOVE_FILLER',
        eligibility: safeCandidate ? 'SAFE_EDIT_CANDIDATE' : 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: !safeCandidate || event.requiresHumanReview,
        protectedEvent: false,
        reason: safeCandidate
          ? `Non-semantic vocal hesitation («${event.relatedText ?? canonical}») corroborated acoustically and linguistically.`
          : `Vocal filler candidate («${event.relatedText ?? canonical}») requires human review before approval.`,
        explanationFa: safeCandidate
          ? `تپق آوایی غیرمعنایی «${event.relatedText ?? canonical}» با شواهد آکوستیکی و زبانی قابل بررسی برای حذف.`
          : `تپق احتمالی «${event.relatedText ?? canonical}» نیازمند بررسی انسانی پیش از تایید است.`,
        policyNotes: [
          isPureVocalFiller ? 'Non-semantic vocal filled pause' : 'Corroborated discourse filler',
        ],
      };
    }

    // --- 5.2 REPETITIONS & STUTTER ---
    if (event.category === 'WORD_REPETITION') {
      if (
        event.subtype === 'INTENTIONAL_EMPHASIS_REPETITION' ||
        event.subtype === 'LEGITIMATE_LEXICAL_REPETITION'
      ) {
        return {
          operation: 'NO_EDIT_RECOMMENDED',
          eligibility: 'DO_NOT_EDIT',
          confidenceClassification: confClass,
          requiresHumanReview: event.subtype === 'INTENTIONAL_EMPHASIS_REPETITION',
          protectedEvent: true,
          reason: `Protected repetition (${event.subtype}): rhetorical emphasis or legitimate Persian reduplication must not be deleted.`,
          explanationFa: `تکرار معنادار یا تأکیدی («${event.relatedText ?? ''}») حفظ می‌شود و نباید حذف شود.`,
          policyNotes: [`Protected subtype: ${event.subtype}`],
        };
      }

      // Accidental word repetition: never delete on text match alone!
      const hasAcousticCorroboration =
        event.scores.acousticScore !== null && event.scores.acousticScore >= 0.65;
      const reliableAsr =
        event.scores.modelTokenConfidence === null || event.scores.modelTokenConfidence >= 0.7;

      if (isInsufficient || !hasAcousticCorroboration || !reliableAsr || hasConflicts) {
        notes.push(
          'Word repetition lacks reliable acoustic/ASR corroboration; routed to human review rather than removal.',
        );
        return {
          operation: 'REVIEW_FALSE_START',
          eligibility: 'REVIEW_REQUIRED_CANDIDATE',
          confidenceClassification: confClass,
          requiresHumanReview: true,
          protectedEvent: false,
          reason:
            'Repeated word distinction is uncertain (possible emphasis, distinct grammar, or ASR segmentation error); requires human review.',
          explanationFa: `تکرار واژه «${event.relatedText ?? ''}» بدون شواهد آکوستیکی/ASR قطعی است؛ صرفاً برای بازبینی انسانی علامت‌گذاری شد.`,
          policyNotes: notes,
        };
      }

      const safeRemovalCandidate =
        event.eligibleForEditSuggestion && event.confidence >= 0.82 && hasAcousticCorroboration;

      return {
        operation: 'REMOVE_ACCIDENTAL_REPETITION',
        eligibility: safeRemovalCandidate ? 'SAFE_EDIT_CANDIDATE' : 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: true, // Repetitions still benefit from human verification
        protectedEvent: false,
        reason: `Accidental whole-word repetition («${event.relatedText ?? ''}») corroborated by acoustic and temporal evidence.`,
        explanationFa: `تکرار ناخواسته واژه «${event.relatedText ?? ''}» با شواهد آکوستیک و فاصله زمانی — پیشنهاد حذف تکرار اول پس از بررسی.`,
        policyNotes: ['Corroborated accidental whole-word repetition'],
      };
    }

    if (event.category === 'SYLLABLE_REPETITION' || event.category === 'STUTTER') {
      return {
        operation: 'REVIEW_FALSE_START',
        eligibility: 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: true,
        protectedEvent: false,
        reason: `Observable ${event.subtype} pattern requires careful human audition; never auto-deleted.`,
        explanationFa: `تکرار هجا یا الگوی گیر آوایی قابل مشاهده («${event.relatedText ?? ''}») — نیازمند بازبینی انسانی و غیرمجاز برای حذف خودکار.`,
        policyNotes: [
          'Observable speech pattern only (non-medical); mandatory human review',
        ],
      };
    }

    // --- 5.3 FALSE STARTS ---
    if (event.category === 'FALSE_START') {
      return {
        operation: 'REVIEW_FALSE_START',
        eligibility: 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: true,
        protectedEvent: false,
        reason:
          'False start preserves original linguistic sequence; human interpretation required to ensure meaning is not lost.',
        explanationFa: `شروع ناتمام عبارت («${event.relatedText ?? ''}») با حفظ کامل توالی اصلی برای بررسی کاربر ثبت شد.`,
        policyNotes: ['Preserves original sequence; no automatic false-start deletion'],
      };
    }

    // --- 5.4 SELF-CORRECTIONS ---
    if (event.category === 'SELF_CORRECTION') {
      return {
        operation: 'REVIEW_SELF_CORRECTION',
        eligibility: 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: true,
        protectedEvent: false,
        reason:
          'Self-correction preserved by default; a later reformulation does not prove the earlier statement is dispensable.',
        explanationFa: `اصلاح درجا یا بازگویی («${event.relatedText ?? ''}») به‌صورت پیش‌فرض حفظ شده و فقط برای بررسی انسانی ارائه می‌شود.`,
        policyNotes: ['Self-correction review-only; never assumes earlier utterance is wrong'],
      };
    }

    // --- 5.5 BREATHING & NON-VERBAL VOCAL EVENTS ---
    if (event.category === 'BREATH') {
      return {
        operation: 'REVIEW_BREATH',
        eligibility: 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: true,
        protectedEvent: true, // Protected from silent deletion by overlapping silence proposals
        reason:
          'Breathing events are never automatically removed; preserving natural speaker rhythm and identity requires human review.',
        explanationFa: `رویداد تنفسی (${event.subtype}) محافظت‌شده است و هرگز خودکار حذف نمی‌شود؛ قابل بازبینی انسانی.`,
        policyNotes: ['Protected breath event; review-only in Mission 05'],
      };
    }

    if (event.category === 'NON_VERBAL_VOCALIZATION') {
      return {
        operation: 'REVIEW_NON_VERBAL_EVENT',
        eligibility: 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: true,
        protectedEvent: true, // Protected from accidental deletion
        reason: `Non-verbal vocal event (${event.subtype}) is protected from automatic deletion to preserve emotional expression and naturalness.`,
        explanationFa: `رویداد غیرکلامی (${event.subtype}) هرگز خودکار حذف نمی‌شود و جهت بررسی انسانی ارائه شده است.`,
        policyNotes: ['Protected non-verbal vocal event; review-only'],
      };
    }

    // --- 5.6 SILENCE ---
    if (event.category === 'SILENCE') {
      // Natural pauses, breath pauses, input failures -> DO NOT SHORTEN automatically
      if (
        event.subtype === 'NATURAL_SHORT_PAUSE' ||
        event.subtype === 'SENTENCE_BOUNDARY_PAUSE' ||
        event.subtype === 'BREATH_RELATED_PAUSE'
      ) {
        return {
          operation: 'NO_EDIT_RECOMMENDED',
          eligibility: 'DO_NOT_EDIT',
          confidenceClassification: confClass,
          requiresHumanReview: event.subtype === 'BREATH_RELATED_PAUSE',
          protectedEvent: true,
          reason: `Natural or breath-related pause (${event.subtype}) preserved for conversational rhythm.`,
          explanationFa: `مکث طبیعی یا تنفسی (${event.subtype}) برای حفظ ریتم طبیعی گفتار نگهداری می‌شود.`,
          policyNotes: ['Preserved rhetorical/natural/breath pause'],
        };
      }

      if (event.subtype === 'INPUT_FAILURE_OR_DIGITAL_ZERO') {
        return {
          operation: 'NO_EDIT_RECOMMENDED',
          eligibility: 'DETECTABLE_NOT_EDITABLE',
          confidenceClassification: confClass,
          requiresHumanReview: true,
          protectedEvent: true,
          reason: 'Possible microphone/input failure (digital zero) requires human inspection, not automatic trimming.',
          explanationFa: 'صفر دیجیتال یا احتمال قطع ورودی میکروفون شناسایی شد؛ نیازمند بررسی انسانی است و کوتاه‌سازی خودکار مجاز نیست.',
          policyNotes: ['Input failure / digital zero -> inspection only'],
        };
      }

      // Quiet speech / VAD active speech inside apparent silence -> DO NOT SHORTEN
      if (
        event.acousticEvidence?.vadActiveOverlap ||
        event.acousticEvidence?.isWhisperOrLowVolumeProtected
      ) {
        return {
          operation: 'NO_EDIT_RECOMMENDED',
          eligibility: 'DO_NOT_EDIT',
          confidenceClassification: confClass,
          requiresHumanReview: true,
          protectedEvent: true,
          reason: 'Apparent silence contains quiet speech or active VAD signal; shortening blocked to prevent speech loss.',
          explanationFa: 'در این بازه احتمال گفتار کم‌صدا یا نجوا (VAD فعال) وجود دارد؛ کوتاه‌سازی مسدود شد.',
          policyNotes: ['Quiet speech / VAD overlap protection triggered'],
        };
      }

      // Check if silence overlaps any breath or non-verbal vocal event in the recording
      const overlappingProtected = (context?.allEventsInRecording ?? []).some(
        (other) =>
          other.eventId !== event.eventId &&
          other.trackId === event.trackId &&
          (other.category === 'BREATH' || other.category === 'NON_VERBAL_VOCALIZATION') &&
          Math.min(other.endSec, event.endSec) > Math.max(other.startSec, event.startSec),
      );

      if (overlappingProtected) {
        return {
          operation: 'NO_EDIT_RECOMMENDED',
          eligibility: 'REVIEW_REQUIRED_CANDIDATE',
          confidenceClassification: confClass,
          requiresHumanReview: true,
          protectedEvent: false,
          reason: 'Silence interval contains a breath or non-verbal vocal event; shortening blocked pending human review.',
          explanationFa: 'بازه سکوت شامل نفس یا رویداد غیرکلامی محافظت‌شده است؛ کوتاه‌سازی خودکار مجاز نیست.',
          policyNotes: ['Contains overlapping breath/non-verbal event'],
        };
      }

      // Utterance-internal ambiguous silence or insufficient evidence -> require review
      if (
        event.subtype === 'UTTERANCE_INTERNAL_SILENCE' ||
        isInsufficient ||
        hasConflicts ||
        !event.eligibleForEditSuggestion
      ) {
        return {
          operation: 'SHORTEN_SILENCE',
          eligibility: 'REVIEW_REQUIRED_CANDIDATE',
          confidenceClassification: confClass,
          requiresHumanReview: true,
          protectedEvent: false,
          reason:
            'Silence could be an intentional rhetorical pause or lacks conclusive evidence; requires human review.',
          explanationFa: 'تشخیص عمدی یا غیرضروری بودن این مکث قطعی نیست؛ کوتاه‌سازی فقط با بررسی انسانی مجاز است.',
          policyNotes: ['Ambiguous silence -> human review required'],
        };
      }

      // Excessive silence / hesitation pause / recording gap / edge silence with reliable evidence
      const safeShortening =
        event.confidence >= 0.8 &&
        !event.requiresHumanReview &&
        (event.subtype === 'LONG_UNNECESSARY_SILENCE' || event.subtype === 'EDGE_SILENCE');

      return {
        operation: 'SHORTEN_SILENCE',
        eligibility: safeShortening ? 'SAFE_EDIT_CANDIDATE' : 'REVIEW_REQUIRED_CANDIDATE',
        confidenceClassification: confClass,
        requiresHumanReview: !safeShortening || event.subtype === 'RECORDING_GAP',
        protectedEvent: false,
        reason: `Excessive silence (${event.subtype}) eligible for partial shortening while preserving natural spacing.`,
        explanationFa: `سکوت طولانی (${event.durationSec.toFixed(2)}s) قابل کوتاه‌سازی با حفظ حاشیه تنفس طبیعی است.`,
        policyNotes: ['Prefer shortening excessive silence over full removal'],
      };
    }

    // --- PACING ANOMALY & UNCERTAIN ---
    return {
      operation: 'NO_EDIT_RECOMMENDED',
      eligibility: 'DETECTABLE_NOT_EDITABLE',
      confidenceClassification: confClass,
      requiresHumanReview: true,
      protectedEvent: false,
      reason: `Event category ${event.category} is informational only and does not authorize deletion.`,
      explanationFa: event.explanationFa || 'رویداد صرفاً اطلاع‌رسانی است و ویرایش خودکار توصیه نمی‌شود.',
      policyNotes: [`Informational category: ${event.category}`],
    };
  }
}
