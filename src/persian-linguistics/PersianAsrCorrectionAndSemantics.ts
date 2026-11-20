import {
  EpistemicSourceCategory,
  PersianTranscriptDocument,
  PersianTranscriptTokenRecord,
} from './PersianTranscriptModel';

export type CorrectionEvidenceStrength =
  | 'STRONG_EVIDENCE'
  | 'MODERATE_EVIDENCE'
  | 'WEAK_EVIDENCE'
  | 'AMBIGUOUS'
  | 'INSUFFICIENT_EVIDENCE';

export type MeaningPreservationRiskLevel =
  | 'NO_LEXICAL_CHANGE'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'CRITICAL'
  | 'UNKNOWN';

export type DisfluencyContextualDecision =
  | 'LIKELY_DISFLUENCY_CANDIDATE'
  | 'PRESERVE_DISCOURSE_MARKER'
  | 'PRESERVE_RHETORICAL_OR_EMPHATIC_REPETITION'
  | 'NEEDS_HUMAN_REVIEW';

export interface ContextualDisfluencyAssessment {
  readonly tokenId: string;
  readonly text: string;
  readonly decision: DisfluencyContextualDecision;
  readonly linkedSpeechEventIds: readonly string[];
  readonly sourceStartSample: number | null;
  readonly sourceEndSample: number | null;
  readonly rationale: string;
}

export interface SemanticChangeAssessment {
  readonly riskLevel: MeaningPreservationRiskLevel;
  readonly isLexicalChange: boolean;
  readonly altersNegation: boolean;
  readonly altersQuantityOrCurrency: boolean;
  readonly altersNamedEntity: boolean;
  readonly isWordDeletion: boolean;
  readonly safeForAutoApply: false;
  readonly reasons: readonly string[];
}

export interface PersianAsrCorrectionCandidate {
  readonly candidateId: string;
  readonly sourceTranscriptVersion: number;
  readonly tokenIds: readonly string[];
  readonly originalText: string;
  readonly proposedText: string;
  readonly category: 'ASR_LEXICAL_CANDIDATE' | 'ORTHOGRAPHY_READABLE' | 'PUNCTUATION_ONLY' | 'NUMBER_FORMAT';
  readonly evidenceStrength: CorrectionEvidenceStrength;
  readonly acousticEvidenceAvailable: boolean;
  readonly acousticConfidence: number | null;
  readonly linguisticEvidence: string;
  readonly semanticRisk: SemanticChangeAssessment;
  readonly alignmentImpact: 'NONE' | 'RECALCULATE_REQUIRED';
  readonly epistemicSource: EpistemicSourceCategory;
  readonly provenanceModule: string;
  readonly sourceStartSample: number | null;
  readonly sourceEndSample: number | null;
  readonly status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'REVERTED' | 'STALE';
}

const NEGATION_RE = /^(نه|نیست|نبود|نشد|نمی|نباید|نخواهد|هیچ|اصلاً|اصلا|نکرد|نمی‌شود|نمیشه|نمی‌توان|نتوانست)/;
const NUMBER_OR_CURRENCY_RE = /([0-9۰-۹]|تومان|تومن|ریال|دلار|یورو|درصد|هزار|میلیون|میلیارد)/;

/**
 * Meaning-Preservation Risk Analyzer (AVP-P13-001 Section 10).
 * Never treats UNKNOWN semantic risk as safe; strictly flags negation, quantity/currency,
 * word deletion, and named-entity edits.
 */
export function assessSemanticChangeRisk(params: {
  readonly originalText: string;
  readonly proposedText: string;
  readonly category: PersianAsrCorrectionCandidate['category'];
}): SemanticChangeAssessment {
  const orig = params.originalText.trim();
  const prop = params.proposedText.trim();
  const reasons: string[] = [];

  if (params.category === 'PUNCTUATION_ONLY') {
    const changesQuestionState = orig.includes('؟') !== prop.includes('؟');
    return {
      riskLevel: changesQuestionState ? 'MEDIUM' : 'NO_LEXICAL_CHANGE',
      isLexicalChange: false,
      altersNegation: false,
      altersQuantityOrCurrency: false,
      altersNamedEntity: false,
      isWordDeletion: false,
      safeForAutoApply: false,
      reasons: changesQuestionState
        ? ['تغییر علامت پرسش می‌تواند لحن/برداشت جمله را تغییر دهد.']
        : ['تنها تغییر نگارشی بدون تغییر واژگانی.'],
    };
  }

  const isWordDeletion = prop.length === 0 && orig.length > 0;
  const origNeg = NEGATION_RE.test(orig);
  const propNeg = NEGATION_RE.test(prop);
  const altersNegation = origNeg !== propNeg;
  const altersQuantityOrCurrency =
    (NUMBER_OR_CURRENCY_RE.test(orig) || NUMBER_OR_CURRENCY_RE.test(prop)) && orig !== prop;
  const altersNamedEntity =
    /^[A-Z][A-Za-z0-9_-]{2,}$/.test(orig) && orig !== prop;

  if (isWordDeletion) reasons.push('حذف واژه گفتاری همواره تغییر واژگانی محسوب می‌شود.');
  if (altersNegation) reasons.push('تغییر پیشنهادی روی ساختار نفی/اثبات جمله اثر می‌گذارد.');
  if (altersQuantityOrCurrency) reasons.push('تغییر پیشنهادی شامل مقدار عددی یا واحد پولی است.');
  if (altersNamedEntity) reasons.push('تغییر پیشنهادی شامل نام خاص یا اصطلاح فنی است.');

  if (params.category === 'ORTHOGRAPHY_READABLE' && !isWordDeletion && !altersNegation && !altersQuantityOrCurrency) {
    return {
      riskLevel: 'LOW',
      isLexicalChange: false,
      altersNegation: false,
      altersQuantityOrCurrency: false,
      altersNamedEntity: false,
      isWordDeletion: false,
      safeForAutoApply: false,
      reasons: ['اصلاح املایی/نیم‌فاصله در لایه خوانا بدون تغییر معنایی.'],
    };
  }

  let riskLevel: MeaningPreservationRiskLevel = 'UNKNOWN';
  if (altersNegation || altersQuantityOrCurrency) {
    riskLevel = 'CRITICAL';
  } else if (isWordDeletion || altersNamedEntity) {
    riskLevel = 'HIGH';
  } else if (orig !== prop) {
    riskLevel = 'MEDIUM';
  } else {
    riskLevel = 'NO_LEXICAL_CHANGE';
  }

  return {
    riskLevel,
    isLexicalChange: orig !== prop,
    altersNegation,
    altersQuantityOrCurrency,
    altersNamedEntity,
    isWordDeletion,
    safeForAutoApply: false,
    reasons: reasons.length > 0 ? reasons : ['تغییر واژگانی نیازمند بازبینی انسانی است.'],
  };
}

const PURE_HESITATION_FILLERS = new Set(['اِ', 'اَم', 'اوم', 'اومم', 'امم', 'آآ', 'آآآ']);
const CONTEXTUAL_DISCOURSE_MARKERS = new Set([
  'خب',
  'یعنی',
  'آره',
  'حالا',
  'مثلاً',
  'مثلا',
  'در واقع',
  'به‌اصطلاح',
  'بهاصطلاح',
  'عرضم به حضور شما',
  'چیز',
  'چی میگن',
  'ببین',
  'راستش',
  'البته',
]);

/**
 * Contextual Disfluency-Preservation Policy (AVP-P13-001 Section 9).
 * Distinguishes pure hesitations from meaningful Persian discourse markers and emphatic repetitions.
 */
export function assessContextualDisfluencies(
  doc: PersianTranscriptDocument,
): readonly ContextualDisfluencyAssessment[] {
  const assessments: ContextualDisfluencyAssessment[] = [];

  for (let i = 0; i < doc.tokens.length; i += 1) {
    const tok = doc.tokens[i];
    const norm = tok.normalizedText;

    if (PURE_HESITATION_FILLERS.has(norm)) {
      assessments.push({
        tokenId: tok.tokenId,
        text: tok.verbatimText,
        decision: 'LIKELY_DISFLUENCY_CANDIDATE',
        linkedSpeechEventIds: tok.speechEventIds,
        sourceStartSample: tok.sourceStartSample,
        sourceEndSample: tok.sourceEndSample,
        rationale: 'آوای مکث گفتاری شناسایی شد؛ بدون تأیید انسانی حذف نمی‌شود.',
      });
      continue;
    }

    if (CONTEXTUAL_DISCOURSE_MARKERS.has(norm)) {
      const isClauseInitial = i === 0 || doc.tokens[i - 1].language === 'punctuation';
      assessments.push({
        tokenId: tok.tokenId,
        text: tok.verbatimText,
        decision: isClauseInitial ? 'PRESERVE_DISCOURSE_MARKER' : 'NEEDS_HUMAN_REVIEW',
        linkedSpeechEventIds: tok.speechEventIds,
        sourceStartSample: tok.sourceStartSample,
        sourceEndSample: tok.sourceEndSample,
        rationale: isClauseInitial
          ? `نشانه گفتمانی «${tok.verbatimText}» در ابتدای جمله می‌تواند نقش ارتباطی/معنایی داشته باشد؛ به‌طور خودکار قابل حذف نیست.`
          : `عبارت گفتاری «${tok.verbatimText}» وابسته به بافت است و نیازمند تصمیم کاربر است.`,
      });
      continue;
    }

    // Repeated word check: distinguish emphatic «خیلی خیلی» / «بله بله» from accidental stutter
    if (i > 0 && doc.tokens[i - 1].normalizedText === norm && tok.language === 'fa') {
      const emphaticWords = new Set(['خیلی', 'بله', 'آره', 'نه', 'اصلاً', 'اصلا', 'واقعاً', 'واقعا', 'حتماً', 'حتما']);
      const isEmphatic = emphaticWords.has(norm);
      assessments.push({
        tokenId: tok.tokenId,
        text: tok.verbatimText,
        decision: isEmphatic
          ? 'PRESERVE_RHETORICAL_OR_EMPHATIC_REPETITION'
          : 'NEEDS_HUMAN_REVIEW',
        linkedSpeechEventIds: tok.speechEventIds,
        sourceStartSample: tok.sourceStartSample,
        sourceEndSample: tok.sourceEndSample,
        rationale: isEmphatic
          ? `تکرار تأکیدی معنادار («${tok.verbatimText} ${tok.verbatimText}») شناسایی شد و حفظ می‌گردد.`
          : `تکرار پیاپی واژه «${tok.verbatimText}» مشاهده شد؛ پیش از هر تغییری نیازمند بازبینی انسانی است.`,
      });
    }
  }

  return assessments;
}

/**
 * Generates evidence-backed ASR correction candidates using user-confirmed vocabulary
 * or explicit ASR alternatives (NEVER fabricating acoustic confidence).
 */
export function generateAsrCorrectionCandidates(params: {
  readonly doc: PersianTranscriptDocument;
  readonly userConfirmedVocabulary?: readonly string[];
  readonly asrAlternativesByTokenId?: Readonly<
    Record<string, readonly { readonly text: string; readonly acousticScore: number | null }[]>
  >;
}): readonly PersianAsrCorrectionCandidate[] {
  const candidates: PersianAsrCorrectionCandidate[] = [];
  const vocab = new Set((params.userConfirmedVocabulary ?? []).map((w) => w.trim()).filter(Boolean));
  let seq = 0;

  for (const tok of params.doc.tokens) {
    if (tok.userConfirmed) continue;
    const alts = params.asrAlternativesByTokenId?.[tok.tokenId] ?? [];
    for (const alt of alts) {
      if (alt.text.trim() === tok.verbatimText.trim()) continue;
      const inVocab = vocab.has(alt.text.trim());
      const hasAcoustic = typeof alt.acousticScore === 'number' && Number.isFinite(alt.acousticScore);
      const strength: CorrectionEvidenceStrength =
        inVocab && hasAcoustic && (alt.acousticScore ?? 0) >= 0.8
          ? 'STRONG_EVIDENCE'
          : inVocab || (hasAcoustic && (alt.acousticScore ?? 0) >= 0.7)
            ? 'MODERATE_EVIDENCE'
            : hasAcoustic
              ? 'WEAK_EVIDENCE'
              : 'INSUFFICIENT_EVIDENCE';

      const semanticRisk = assessSemanticChangeRisk({
        originalText: tok.verbatimText,
        proposedText: alt.text,
        category: 'ASR_LEXICAL_CANDIDATE',
      });

      candidates.push({
        candidateId: `asr_corr_${++seq}`,
        sourceTranscriptVersion: params.doc.version,
        tokenIds: [tok.tokenId],
        originalText: tok.verbatimText,
        proposedText: alt.text,
        category: 'ASR_LEXICAL_CANDIDATE',
        evidenceStrength: strength,
        acousticEvidenceAvailable: hasAcoustic,
        acousticConfidence: hasAcoustic ? alt.acousticScore : null,
        linguisticEvidence: inVocab
          ? 'تطابق با واژه‌نامه تأییدشده کاربر و خروجی جایگزین ASR.'
          : 'پیشنهاد جایگزین بدون تطابق واژه‌نامه تأییدشده؛ نیازمند بازبینی.',
        semanticRisk,
        alignmentImpact: 'RECALCULATE_REQUIRED',
        epistemicSource: 'MODEL_GENERATED_SUGGESTION',
        provenanceModule: 'PersianAsrCorrectionEngine',
        sourceStartSample: tok.sourceStartSample,
        sourceEndSample: tok.sourceEndSample,
        status: 'PROPOSED',
      });
    }
  }

  return candidates;
}

export interface TransformationApplyResult {
  readonly applied: boolean;
  readonly document: PersianTranscriptDocument;
  readonly updatedCandidate: PersianAsrCorrectionCandidate;
  readonly rejectionReason?: string;
}

/**
 * Versioned Transcript Transformation Engine with staleness protection, conflict detection,
 * and reversible user-controlled acceptance/rejection (AVP-P13-001 Section 11).
 */
export class TranscriptTransformationEngine {
  private readonly appliedHistory: Array<{
    readonly candidateId: string;
    readonly tokenId: string;
    readonly previousReadable: string;
    readonly previousUserCorrected: string | null;
    readonly previousUserConfirmed: boolean;
    readonly absorbedSnapshots?: ReadonlyArray<{
      readonly tokenId: string;
      readonly previousReadable: string;
      readonly previousUserCorrected: string | null;
      readonly previousUserConfirmed: boolean;
    }>;
  }> = [];

  public applyAcceptedCandidate(params: {
    readonly document: PersianTranscriptDocument;
    readonly candidate: PersianAsrCorrectionCandidate;
    readonly allowWeakOrUnknownRiskExplicitly?: boolean;
  }): TransformationApplyResult {
    const { document, candidate } = params;

    // 1. Staleness guard: never apply stale suggestions over a newer transcript version
    if (candidate.sourceTranscriptVersion !== document.version) {
      return {
        applied: false,
        document,
        updatedCandidate: { ...candidate, status: 'STALE' },
        rejectionReason: `Stale suggestion (created for v${candidate.sourceTranscriptVersion}, current is v${document.version}).`,
      };
    }

    if (!candidate.tokenIds || candidate.tokenIds.length === 0) {
      return {
        applied: false,
        document,
        updatedCandidate: candidate,
        rejectionReason: 'Candidate has no target tokenIds.',
      };
    }

    const firstTargetId = candidate.tokenIds[0];
    if (!document.tokens.some((t) => t.tokenId === firstTargetId)) {
      return {
        applied: false,
        document,
        updatedCandidate: candidate,
        rejectionReason: `Target token ${firstTargetId} not found in transcript document.`,
      };
    }

    // 2. Weak/insufficient evidence or UNKNOWN risk requires explicit user override
    if (
      (candidate.evidenceStrength === 'WEAK_EVIDENCE' ||
        candidate.evidenceStrength === 'INSUFFICIENT_EVIDENCE' ||
        candidate.semanticRisk.riskLevel === 'UNKNOWN') &&
      !params.allowWeakOrUnknownRiskExplicitly
    ) {
      return {
        applied: false,
        document,
        updatedCandidate: candidate,
        rejectionReason: 'Weak/insufficient evidence or UNKNOWN semantic risk requires explicit human confirmation.',
      };
    }

    // 3. Conflict guard: never silently overwrite an already user-confirmed token
    const targetIds = new Set(candidate.tokenIds);
    for (const tok of document.tokens) {
      if (targetIds.has(tok.tokenId) && tok.userConfirmed && candidate.category !== 'ORTHOGRAPHY_READABLE') {
        return {
          applied: false,
          document,
          updatedCandidate: candidate,
          rejectionReason: `Conflict: token ${tok.tokenId} already has a human-confirmed correction.`,
        };
      }
    }

    const absorbedIds =
      candidate.category !== 'PUNCTUATION_ONLY' && candidate.tokenIds.length > 1
        ? new Set(candidate.tokenIds.slice(1))
        : new Set<string>();
    const absorbedSnapshots = document.tokens
      .filter((t) => absorbedIds.has(t.tokenId))
      .map((t) => ({
        tokenId: t.tokenId,
        previousReadable: t.readableText,
        previousUserCorrected: t.userCorrectedText,
        previousUserConfirmed: t.userConfirmed,
      }));

    const updatedTokens: PersianTranscriptTokenRecord[] = document.tokens.map((tok) => {
      if (absorbedIds.has(tok.tokenId)) {
        return {
          ...tok,
          readableText: '',
        };
      }
      if (tok.tokenId !== firstTargetId) return tok;
      this.appliedHistory.push({
        candidateId: candidate.candidateId,
        tokenId: tok.tokenId,
        previousReadable: tok.readableText,
        previousUserCorrected: tok.userCorrectedText,
        previousUserConfirmed: tok.userConfirmed,
        absorbedSnapshots,
      });

      if (candidate.category === 'ORTHOGRAPHY_READABLE' || candidate.category === 'NUMBER_FORMAT') {
        // Never overwrite rawAsrText or verbatimText!
        return {
          ...tok,
          readableText: candidate.proposedText,
        };
      }
      if (candidate.category === 'PUNCTUATION_ONLY') {
        return {
          ...tok,
          readableText: `${tok.readableText}${candidate.proposedText}`,
        };
      }
      // Lexical correction accepted by human -> stored in userCorrectedText & readableText, preserving rawAsrText & verbatimText
      return {
        ...tok,
        readableText: candidate.proposedText,
        userCorrectedText: candidate.proposedText,
        userConfirmed: true,
        epistemicSource: 'HUMAN_CORRECTION',
      };
    });

    const nextVersion = document.version + 1;
    const nextDoc: PersianTranscriptDocument = {
      ...document,
      version: nextVersion,
      tokens: updatedTokens,
      revisions: [
        ...document.revisions,
        {
          revisionId: `rev_${nextVersion}`,
          version: nextVersion,
          createdAtIso: new Date().toISOString(),
          author: 'LINGUISTIC_PROPOSAL_ACCEPTED',
          summary: `Accepted ${candidate.category} (${candidate.candidateId}): "${candidate.originalText}" -> "${candidate.proposedText}"`,
          affectedTokenIds: [...candidate.tokenIds],
        },
      ],
    };

    return {
      applied: true,
      document: nextDoc,
      updatedCandidate: { ...candidate, status: 'ACCEPTED' },
    };
  }

  public clearHistory(): void {
    this.appliedHistory.length = 0;
  }

  public revertCandidateById(
    document: PersianTranscriptDocument,
    candidateId: string,
  ): {
    readonly reverted: boolean;
    readonly document: PersianTranscriptDocument;
    readonly revertedTokenId: string | null;
    readonly restoredReadableText: string | null;
    readonly restoredTokens: ReadonlyArray<{
      readonly tokenId: string;
      readonly readableText: string;
    }>;
  } {
    let matchIdx = -1;
    for (let i = this.appliedHistory.length - 1; i >= 0; i--) {
      if (this.appliedHistory[i].candidateId === candidateId) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === -1) {
      return {
        reverted: false,
        document,
        revertedTokenId: null,
        restoredReadableText: null,
        restoredTokens: [],
      };
    }

    const [entry] = this.appliedHistory.splice(matchIdx, 1);
    const absorbedMap = new Map((entry.absorbedSnapshots ?? []).map((s) => [s.tokenId, s]));
    const updatedTokens = document.tokens.map((tok) => {
      if (tok.tokenId === entry.tokenId) {
        return {
          ...tok,
          readableText: entry.previousReadable,
          userCorrectedText: entry.previousUserCorrected,
          userConfirmed: entry.previousUserConfirmed,
        };
      }
      const absorbed = absorbedMap.get(tok.tokenId);
      if (absorbed) {
        return {
          ...tok,
          readableText: absorbed.previousReadable,
          userCorrectedText: absorbed.previousUserCorrected,
          userConfirmed: absorbed.previousUserConfirmed,
        };
      }
      return tok;
    });

    const restoredTokens = [
      { tokenId: entry.tokenId, readableText: entry.previousReadable },
      ...(entry.absorbedSnapshots ?? []).map((s) => ({
        tokenId: s.tokenId,
        readableText: s.previousReadable,
      })),
    ];
    const affectedTokenIds = restoredTokens.map((t) => t.tokenId);
    const nextVersion = document.version + 1;
    return {
      reverted: true,
      revertedTokenId: entry.tokenId,
      restoredReadableText: entry.previousReadable,
      restoredTokens,
      document: {
        ...document,
        version: nextVersion,
        tokens: updatedTokens,
        revisions: [
          ...document.revisions,
          {
            revisionId: `rev_${nextVersion}`,
            version: nextVersion,
            createdAtIso: new Date().toISOString(),
            author: 'REVERT',
            summary: `Reverted transformation ${entry.candidateId}`,
            affectedTokenIds,
          },
        ],
      },
    };
  }

  public revertLastTransformation(
    document: PersianTranscriptDocument,
  ): { readonly reverted: boolean; readonly document: PersianTranscriptDocument } {
    const last = this.appliedHistory.pop();
    if (!last) return { reverted: false, document };

    const absorbedMap = new Map((last.absorbedSnapshots ?? []).map((s) => [s.tokenId, s]));
    const updatedTokens = document.tokens.map((tok) => {
      if (tok.tokenId === last.tokenId) {
        return {
          ...tok,
          readableText: last.previousReadable,
          userCorrectedText: last.previousUserCorrected,
          userConfirmed: last.previousUserConfirmed,
        };
      }
      const absorbed = absorbedMap.get(tok.tokenId);
      if (absorbed) {
        return {
          ...tok,
          readableText: absorbed.previousReadable,
          userCorrectedText: absorbed.previousUserCorrected,
          userConfirmed: absorbed.previousUserConfirmed,
        };
      }
      return tok;
    });

    const affectedTokenIds = [last.tokenId, ...(last.absorbedSnapshots ?? []).map((s) => s.tokenId)];
    const nextVersion = document.version + 1;
    return {
      reverted: true,
      document: {
        ...document,
        version: nextVersion,
        tokens: updatedTokens,
        revisions: [
          ...document.revisions,
          {
            revisionId: `rev_${nextVersion}`,
            version: nextVersion,
            createdAtIso: new Date().toISOString(),
            author: 'REVERT',
            summary: `Reverted transformation ${last.candidateId}`,
            affectedTokenIds,
          },
        ],
      },
    };
  }
}

export function diffTranscriptVersions(
  beforeDoc: PersianTranscriptDocument,
  afterDoc: PersianTranscriptDocument,
): ReadonlyArray<{
  readonly tokenId: string;
  readonly beforeReadable: string;
  readonly afterReadable: string;
  readonly beforeUserCorrected: string | null;
  readonly afterUserCorrected: string | null;
}> {
  const beforeMap = new Map(beforeDoc.tokens.map((t) => [t.tokenId, t]));
  const diffs: Array<{
    tokenId: string;
    beforeReadable: string;
    afterReadable: string;
    beforeUserCorrected: string | null;
    afterUserCorrected: string | null;
  }> = [];

  for (const afterTok of afterDoc.tokens) {
    const beforeTok = beforeMap.get(afterTok.tokenId);
    if (
      !beforeTok ||
      beforeTok.readableText !== afterTok.readableText ||
      beforeTok.userCorrectedText !== afterTok.userCorrectedText
    ) {
      diffs.push({
        tokenId: afterTok.tokenId,
        beforeReadable: beforeTok?.readableText ?? '',
        afterReadable: afterTok.readableText,
        beforeUserCorrected: beforeTok?.userCorrectedText ?? null,
        afterUserCorrected: afterTok.userCorrectedText,
      });
    }
  }
  return diffs;
}
