/**
 * SHAHAB-008 — Persian Context Memory, Acoustic Evidence Ledger & False-Correction Prevention
 *
 * Implements:
 * - SHAHABPersianMemoryManager (4 isolated scopes: RECORDING, PROJECT, DOMAIN, USER_VOCABULARY)
 * - Strict 7-state vocabulary evidence model (UNVERIFIED_CANDIDATE .. DISABLED)
 * - SHAHABPersianLexicalRepresentation (5 separated forms + real tokens.txt BPE encoding)
 * - SHAHABContextualVocabularyProvider (real BPE hotword bias map ONLY when supported by decoder)
 * - SHAHABFalseInsertionGuard (adversarial evaluation + automatic bias disablement on false insertions)
 * - SHAHABAcousticEvidenceLedger (preserves Layer A Raw, Layer B Context-Assisted, Layer C Authorized Final)
 * - SHAHABSelectiveRiskController (6 explicit actions; integrates with existing P0-009, P0-010, P0-012)
 */

import crypto from 'node:crypto';
import { normalizePersianTextDeterministic } from './ShahabContracts';
import {
  detectMeaningCriticalTokens,
  evaluateProposedCorrection,
} from '../asr-core/PersianEvidenceCorrectionEngine';
import type { ShahabHotwordBiasMap } from './ShahabZipformerEngine';

export type ShahabMemoryScope =
  | 'RECORDING'
  | 'PROJECT'
  | 'DOMAIN'
  | 'USER_VOCABULARY';

export type ShahabVocabularyEvidenceState =
  | 'UNVERIFIED_CANDIDATE'
  | 'USER_CONFIRMED'
  | 'SOURCE_VERIFIED'
  | 'PROJECT_CONFIRMED'
  | 'CONFLICTING'
  | 'OUTDATED'
  | 'DISABLED';

export type ShahabLegacyMemoryTier =
  | 'VERIFIED_PROJECT_TERMS'
  | 'VERIFIED_DOMAIN_TERMS'
  | 'UNVERIFIED_CANDIDATES';

export interface SHAHABPersianLexicalRepresentation {
  readonly originalUserText: string;
  readonly normalizedLookupKey: string;
  readonly modelTokenizerIds: readonly number[];
  readonly modelTokenizerPieces: readonly string[];
  readonly tokenizableByModel: boolean;
  readonly optionalPronunciation: string | null; // Unknown stays null!
  readonly preferredDisplaySpelling: string;
  readonly provenanceNote: string;
}

export interface ShahabVocabularyEntry {
  readonly entryId: string;
  readonly term: string;
  readonly representation: SHAHABPersianLexicalRepresentation;
  readonly language: 'fa' | 'en' | 'fa-en';
  readonly domain: string | null;
  readonly scope: ShahabMemoryScope;
  readonly scopeOwnerId: string; // recordingId, projectId, domainId, or userId
  readonly state: ShahabVocabularyEvidenceState;
  readonly legacyTier: ShahabLegacyMemoryTier;
  readonly evidenceSource: string;
  readonly confirmationMethod: string;
  readonly createdAtUtc: string;
  readonly lastConfirmedAtUtc: string | null;
  readonly version: number;
  readonly active: boolean;
}

/**
 * Encodes a Persian string strictly using the actual selected model's `tokens.txt` BPE vocabulary
 * (greedy longest-piece SentencePiece matching with `▁` word-boundary prefix).
 * Never assumes a Persian word maps to a single token.
 */
export function buildPersianLexicalRepresentation(params: {
  readonly originalUserText: string;
  readonly preferredDisplaySpelling?: string;
  readonly optionalPronunciation?: string | null;
  readonly vocab: readonly string[];
}): SHAHABPersianLexicalRepresentation {
  const originalUserText = params.originalUserText.trim();
  const preferredDisplaySpelling = (params.preferredDisplaySpelling ?? originalUserText).trim();
  const norm = normalizePersianTextDeterministic(originalUserText, {
    digitPolicy: 'PRESERVE_ORIGINAL',
  });
  const normalizedLookupKey = norm.normalized.replace(/\u200c+/g, ' ').replace(/\s+/g, ' ').trim();

  // Build reverse piece -> id lookup from the real model tokens.txt
  const pieceToId = new Map<string, number>();
  let maxPieceLen = 1;
  for (let id = 1; id < params.vocab.length; id++) {
    const p = params.vocab[id];
    if (!p || p === '<blk>' || p === '<unk>' || p === '<sos/eos>') continue;
    pieceToId.set(p, id);
    if (p.length > maxPieceLen) maxPieceLen = p.length;
  }

  const spInput = `▁${norm.normalized.replace(/\u200c/g, '').replace(/\s+/g, '▁')}`;
  const ids: number[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  let allMatched = spInput.length > 0 && pieceToId.size > 0;

  while (cursor < spInput.length && pieceToId.size > 0) {
    let matchedLen = 0;
    let matchedId = -1;
    let matchedPiece = '';
    const maxTry = Math.min(maxPieceLen, spInput.length - cursor);
    for (let len = maxTry; len >= 1; len--) {
      const sub = spInput.slice(cursor, cursor + len);
      const id = pieceToId.get(sub);
      if (id !== undefined) {
        matchedLen = len;
        matchedId = id;
        matchedPiece = sub;
        break;
      }
    }
    if (matchedLen > 0) {
      ids.push(matchedId);
      pieces.push(matchedPiece);
      cursor += matchedLen;
    } else {
      allMatched = false;
      cursor += 1;
    }
  }

  return {
    originalUserText,
    normalizedLookupKey,
    modelTokenizerIds: ids,
    modelTokenizerPieces: pieces,
    tokenizableByModel: allMatched && ids.length > 0,
    optionalPronunciation: params.optionalPronunciation ?? null,
    preferredDisplaySpelling,
    provenanceNote:
      'Original spelling preserved; lookup key normalized via P0-009; BPE IDs resolved directly against selected model tokens.txt.',
  };
}

const VERIFIED_STATES = new Set<ShahabVocabularyEvidenceState>([
  'USER_CONFIRMED',
  'SOURCE_VERIFIED',
  'PROJECT_CONFIRMED',
]);

export function isVerifiedVocabularyState(state: ShahabVocabularyEvidenceState): boolean {
  return VERIFIED_STATES.has(state);
}

/**
 * SHAHABPersianMemoryManager — 4-scope isolated Persian vocabulary store.
 * Guarantees:
 * - Recording memory never silently becomes global User vocabulary.
 * - Project memory is strictly isolated per `projectId`.
 * - UNVERIFIED_CANDIDATE entries are NEVER silently promoted or injected as verified vocabulary.
 */
export class SHAHABPersianMemoryManager {
  private readonly entries = new Map<string, ShahabVocabularyEntry>();

  public addEntry(params: {
    readonly term: string;
    readonly preferredDisplaySpelling?: string;
    readonly optionalPronunciation?: string | null;
    readonly language?: 'fa' | 'en' | 'fa-en';
    readonly domain?: string | null;
    readonly scope: ShahabMemoryScope;
    readonly scopeOwnerId: string;
    readonly state: ShahabVocabularyEvidenceState;
    readonly evidenceSource: string;
    readonly confirmationMethod: string;
    readonly vocab: readonly string[];
  }): ShahabVocabularyEntry {
    const nowUtc = new Date().toISOString();
    const repr = buildPersianLexicalRepresentation({
      originalUserText: params.term,
      preferredDisplaySpelling: params.preferredDisplaySpelling,
      optionalPronunciation: params.optionalPronunciation,
      vocab: params.vocab,
    });

    const entryId = `vocab_${crypto.randomBytes(5).toString('hex')}`;
    const legacyTier: ShahabLegacyMemoryTier = !isVerifiedVocabularyState(params.state)
      ? 'UNVERIFIED_CANDIDATES'
      : params.scope === 'DOMAIN'
        ? 'VERIFIED_DOMAIN_TERMS'
        : 'VERIFIED_PROJECT_TERMS';

    const entry: ShahabVocabularyEntry = {
      entryId,
      term: params.term.trim(),
      representation: repr,
      language: params.language ?? 'fa',
      domain: params.domain ?? null,
      scope: params.scope,
      scopeOwnerId: params.scopeOwnerId,
      state: params.state,
      legacyTier,
      evidenceSource: params.evidenceSource,
      confirmationMethod: params.confirmationMethod,
      createdAtUtc: nowUtc,
      lastConfirmedAtUtc: isVerifiedVocabularyState(params.state) ? nowUtc : null,
      version: 1,
      active: params.state !== 'DISABLED' && params.state !== 'OUTDATED',
    };

    this.entries.set(entryId, entry);
    return entry;
  }

  public confirmCandidate(
    entryId: string,
    confirmationMethod: string,
    targetState: 'USER_CONFIRMED' | 'PROJECT_CONFIRMED' | 'SOURCE_VERIFIED' = 'USER_CONFIRMED',
  ): ShahabVocabularyEntry {
    const existing = this.entries.get(entryId);
    if (!existing) throw new Error(`VOCAB_ENTRY_NOT_FOUND: ${entryId}`);
    const nowUtc = new Date().toISOString();
    const updated: ShahabVocabularyEntry = {
      ...existing,
      state: targetState,
      legacyTier: existing.scope === 'DOMAIN' ? 'VERIFIED_DOMAIN_TERMS' : 'VERIFIED_PROJECT_TERMS',
      confirmationMethod,
      lastConfirmedAtUtc: nowUtc,
      version: existing.version + 1,
      active: true,
    };
    this.entries.set(entryId, updated);
    return updated;
  }

  public disableEntry(entryId: string): ShahabVocabularyEntry {
    const existing = this.entries.get(entryId);
    if (!existing) throw new Error(`VOCAB_ENTRY_NOT_FOUND: ${entryId}`);
    const updated: ShahabVocabularyEntry = {
      ...existing,
      state: 'DISABLED',
      active: false,
      version: existing.version + 1,
    };
    this.entries.set(entryId, updated);
    return updated;
  }

  public deleteEntry(entryId: string): boolean {
    return this.entries.delete(entryId);
  }

  /**
   * Retrieves ONLY verified, active entries matching explicit scope isolation rules.
   * Never leaks entries from another project or recording, and never returns UNVERIFIED_CANDIDATE.
   */
  public retrieveVerifiedForContext(params: {
    readonly recordingId?: string;
    readonly projectId?: string;
    readonly domainId?: string;
    readonly includeUserVocabulary?: boolean;
  }): ShahabVocabularyEntry[] {
    const out: ShahabVocabularyEntry[] = [];
    for (const e of this.entries.values()) {
      if (!e.active || !isVerifiedVocabularyState(e.state)) continue;
      if (e.scope === 'RECORDING' && params.recordingId && e.scopeOwnerId === params.recordingId) {
        out.push(e);
      } else if (e.scope === 'PROJECT' && params.projectId && e.scopeOwnerId === params.projectId) {
        out.push(e);
      } else if (e.scope === 'DOMAIN' && params.domainId && e.scopeOwnerId === params.domainId) {
        out.push(e);
      } else if (e.scope === 'USER_VOCABULARY' && params.includeUserVocabulary) {
        out.push(e);
      }
    }
    return out;
  }

  public listAll(): ShahabVocabularyEntry[] {
    return Array.from(this.entries.values());
  }

  public exportJson(): string {
    return JSON.stringify(this.listAll(), null, 2);
  }
}

/**
 * SHAHABContextualVocabularyProvider — Supplies verified BPE hotword biases ONLY
 * for Modified Beam Search (explicitly refuses Greedy Search and UNVERIFIED entries).
 */
export class SHAHABContextualVocabularyProvider {
  public buildBiasMap(params: {
    readonly entries: readonly ShahabVocabularyEntry[];
    readonly decodingMethod: 'greedy_search' | 'modified_beam_search';
    readonly biasScore: number;
    readonly maxBiasScoreCap?: number;
  }): {
    readonly supported: boolean;
    readonly biasMap: ShahabHotwordBiasMap | null;
    readonly skippedReason: string | null;
  } {
    if (params.decodingMethod !== 'modified_beam_search') {
      return {
        supported: false,
        biasMap: null,
        skippedReason: 'Contextual hotword biasing is disabled for greedy_search (requires modified_beam_search).',
      };
    }
    const safeScore = Math.max(0, Math.min(params.maxBiasScoreCap ?? 1.5, params.biasScore));
    const tokenBiases = new Map<number, number>();
    const activeTerms: string[] = [];

    for (const e of params.entries) {
      if (!e.active || !isVerifiedVocabularyState(e.state)) continue;
      if (!e.representation.tokenizableByModel || e.representation.modelTokenizerIds.length === 0) continue;
      activeTerms.push(e.term);
      // Apply modest per-piece bias distributed by piece count to avoid overpowering acoustics
      const pieceBias = Number((safeScore / Math.max(1, Math.sqrt(e.representation.modelTokenizerIds.length))).toFixed(4));
      for (const id of e.representation.modelTokenizerIds) {
        if (id <= 0) continue;
        tokenBiases.set(id, Math.max(tokenBiases.get(id) ?? 0, pieceBias));
      }
    }

    return {
      supported: true,
      biasMap: { tokenBiases, activeTerms },
      skippedReason: null,
    };
  }
}

export interface FalseInsertionAuditResult {
  readonly targetTermRecoveryRate: number | null;
  readonly falseInsertionRate: number;
  readonly incorrectSubstitutionRate: number;
  readonly thresholdExceeded: boolean;
  readonly recommendedAction: 'KEEP_BIAS_ENABLED' | 'DISABLE_CONTEXTUAL_BIAS';
  readonly falseInsertedTerms: readonly string[];
}

/**
 * SHAHABFalseInsertionGuard — Detects contextual hallucinations and disables biasing
 * automatically when false insertions exceed the acceptance threshold.
 */
export class SHAHABFalseInsertionGuard {
  constructor(private readonly maxFalseInsertionRate = 0.05) {}

  public evaluate(params: {
    readonly referenceVerbatim: string;
    readonly rawBaselineText: string;
    readonly contextAssistedText: string;
    readonly activeContextTerms: readonly string[];
  }): FalseInsertionAuditResult {
    const refNorm = normalizePersianTextDeterministic(params.referenceVerbatim).normalized;
    const baseNorm = normalizePersianTextDeterministic(params.rawBaselineText).normalized;
    const ctxNorm = normalizePersianTextDeterministic(params.contextAssistedText).normalized;

    let presentInRef = 0;
    let recoveredByCtx = 0;
    let absentInRef = 0;
    const falseInsertedTerms: string[] = [];

    for (const term of params.activeContextTerms) {
      const tNorm = normalizePersianTextDeterministic(term).normalized;
      if (!tNorm) continue;
      const inRef = refNorm.includes(tNorm);
      const inCtx = ctxNorm.includes(tNorm);
      if (inRef) {
        presentInRef++;
        if (inCtx) recoveredByCtx++;
      } else {
        absentInRef++;
        if (inCtx && !baseNorm.includes(tNorm)) {
          falseInsertedTerms.push(term);
        }
      }
    }

    const falseInsertionRate =
      absentInRef > 0 ? Number((falseInsertedTerms.length / absentInRef).toFixed(4)) : 0;
    const targetTermRecoveryRate =
      presentInRef > 0 ? Number((recoveredByCtx / presentInRef).toFixed(4)) : null;

    // Count regressions where baseline matched reference word and context-assisted broke it
    const refWords = refNorm.split(/\s+/).filter(Boolean);
    const baseWords = baseNorm.split(/\s+/).filter(Boolean);
    const ctxWords = ctxNorm.split(/\s+/).filter(Boolean);
    let wrongSubs = 0;
    const minLen = Math.min(refWords.length, baseWords.length, ctxWords.length);
    for (let i = 0; i < minLen; i++) {
      if (baseWords[i] === refWords[i] && ctxWords[i] !== refWords[i]) {
        wrongSubs++;
      }
    }
    const incorrectSubstitutionRate =
      refWords.length > 0 ? Number((wrongSubs / refWords.length).toFixed(4)) : 0;

    const thresholdExceeded =
      falseInsertionRate > this.maxFalseInsertionRate || incorrectSubstitutionRate > this.maxFalseInsertionRate;

    return {
      targetTermRecoveryRate,
      falseInsertionRate,
      incorrectSubstitutionRate,
      thresholdExceeded,
      recommendedAction: thresholdExceeded ? 'DISABLE_CONTEXTUAL_BIAS' : 'KEEP_BIAS_ENABLED',
      falseInsertedTerms,
    };
  }
}

export type ShahabSegmentEvidenceClass =
  | 'RAW_MODEL_OUTPUT'
  | 'OBSERVED_AUDIO_METADATA'
  | 'DECODER_SCORE'
  | 'ALTERNATIVE_HYPOTHESIS'
  | 'HEURISTIC_SIGNAL'
  | 'CALIBRATED_CONFIDENCE'
  | 'USER_PROVIDED'
  | 'USER_CONFIRMED'
  | 'SOURCE_VERIFIED'
  | 'INFERRED'
  | 'UNKNOWN'
  | 'CONFLICTING';

export type ShahabSelectiveRiskAction =
  | 'ACCEPT_RAW_OUTPUT'
  | 'ACCEPT_CONTEXT_ASSISTED_OUTPUT'
  | 'PRESERVE_MULTIPLE_HYPOTHESES'
  | 'REQUEST_USER_REVIEW'
  | 'DISABLE_CONTEXTUAL_BIAS'
  | 'ABSTAIN_FROM_AUTOMATIC_CORRECTION';

export interface ShahabTranscriptSegmentEvidence {
  readonly segmentId: string;
  readonly audioSha256: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly decoderProfile: string;
  /** Layer A — Immutable unmodified raw acoustic transcript */
  readonly layerARawAcoustic: string;
  /** Layer B — Optional context-assisted alternative (never overwrites Layer A) */
  readonly layerBContextAssisted: string | null;
  /** Layer C — Authorized final transcript (governed by P0-009 / P0-010 / user edits) */
  readonly layerCAuthorizedFinal: string;
  readonly contextTermsApplied: readonly string[];
  readonly contextScope: string | null;
  readonly rawDecoderLogProb: number | null;
  readonly scoreProvenance: 'RAW_RNNT_LOG_PROB_UNCALIBRATED';
  readonly evidenceClasses: readonly ShahabSegmentEvidenceClass[];
  readonly p010CorrectionProposalCount: number;
  readonly authorizationStatus: 'RAW_UNMODIFIED' | 'P010_PROPOSALS_PENDING_REVIEW' | 'USER_CONFIRMED';
  readonly riskAction: ShahabSelectiveRiskAction;
  readonly userEdits: readonly { readonly timestampUtc: string; readonly previousText: string; readonly newText: string }[];
}

export class SHAHABAcousticEvidenceLedger {
  private readonly records = new Map<string, ShahabTranscriptSegmentEvidence>();

  public recordSegment(entry: Omit<ShahabTranscriptSegmentEvidence, 'p010CorrectionProposalCount' | 'authorizationStatus'>): ShahabTranscriptSegmentEvidence {
    // Route any proposed context/authorized differences strictly through existing Avapardaz P0-010 (never bypass!)
    const candidateDiffers =
      entry.layerBContextAssisted !== null && entry.layerBContextAssisted !== entry.layerARawAcoustic;
    let proposalCount = 0;
    if (candidateDiffers && entry.layerBContextAssisted) {
      const critical = detectMeaningCriticalTokens(entry.layerARawAcoustic);
      const decision = evaluateProposedCorrection({
        proposalId: `p010_${entry.segmentId}`,
        transcriptRevision: 1,
        segmentId: entry.segmentId,
        tokenIds: [`${entry.segmentId}_t0`],
        originalText: entry.layerARawAcoustic,
        proposedText: entry.layerBContextAssisted,
        category: critical.length > 0 ? 'LEX_PROPER_NAME_SUBSTITUTION' : 'LEX_DOMAIN_VOCABULARY',
        evidence: [
          {
            evidenceId: `ev_${entry.segmentId}`,
            tier: 'DOMAIN',
            polarity: 'SUPPORTING',
            source: entry.contextScope ?? 'SHAHAB_PERSIAN_MEMORY',
            summary: `Context terms: ${entry.contextTermsApplied.join(', ')}`,
          },
        ],
        confidence: {
          providerRawConfidence: entry.rawDecoderLogProb ?? undefined,
          providerSource: entry.rawDecoderLogProb !== null ? 'ASR_SEGMENT_AVG' : 'UNAVAILABLE',
          calibrationDatasetQualified: false,
        },
        knownProperNames: entry.contextTermsApplied,
      });
      proposalCount = decision.outcome === 'REJECTED_CORRECTION' || decision.outcome === 'INSUFFICIENT_EVIDENCE' ? 0 : 1;
    }

    const full: ShahabTranscriptSegmentEvidence = {
      ...entry,
      p010CorrectionProposalCount: proposalCount,
      authorizationStatus:
        proposalCount > 0 ? 'P010_PROPOSALS_PENDING_REVIEW' : 'RAW_UNMODIFIED',
    };
    this.records.set(entry.segmentId, full);
    return full;
  }

  public getSegment(segmentId: string): ShahabTranscriptSegmentEvidence | null {
    return this.records.get(segmentId) ?? null;
  }

  public listAll(): ShahabTranscriptSegmentEvidence[] {
    return Array.from(this.records.values());
  }
}

export class SHAHABSelectiveRiskController {
  public selectAction(params: {
    readonly rawText: string;
    readonly contextAssistedText: string | null;
    readonly falseInsertionAudit: FalseInsertionAuditResult | null;
    readonly acousticUncertain: boolean;
  }): ShahabSelectiveRiskAction {
    if (params.falseInsertionAudit?.thresholdExceeded) {
      return 'DISABLE_CONTEXTUAL_BIAS';
    }
    if (params.acousticUncertain && params.contextAssistedText && params.contextAssistedText !== params.rawText) {
      return 'PRESERVE_MULTIPLE_HYPOTHESES';
    }
    if (params.acousticUncertain) {
      return 'REQUEST_USER_REVIEW';
    }
    if (params.contextAssistedText && params.contextAssistedText !== params.rawText) {
      return 'ABSTAIN_FROM_AUTOMATIC_CORRECTION';
    }
    return 'ACCEPT_RAW_OUTPUT';
  }
}
