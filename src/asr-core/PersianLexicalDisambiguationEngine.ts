/**
 * AVP-P0-012 — Persian Lexical Fidelity, Contextual Disambiguation & Proper-Noun Preservation Engine
 *
 * Strictly evidence-constrained lexical analysis layer:
 * - Preserves rare/colloquial/regional spoken Persian vocabulary (never equates low frequency with error).
 * - Protects proper names, brands, acronyms, and technical terms without silent replacement or expansion.
 * - Uses indexed O(1) lookup for versioned local domain & user vocabularies (no O(N*M) full scans).
 * - Connects strictly to AVP-P0-010 (`evaluateProposedCorrection`) — never creates a duplicate authorization path.
 * - Never auto-learns unverified machine guesses as confirmed user vocabulary.
 * - 100% local, zero cloud upload, validates all imported vocabulary packages.
 */

import {
  normalizeUnicodeScriptAware,
  PERSIAN_LINGUISTIC_POLICY_VERSION,
} from './PersianLinguisticQualityEngine';
import {
  ConfidenceProvenanceRecord,
  CorrectionDecisionRecord,
  CorrectionEvidenceItem,
  evaluateProposedCorrection,
  PersianErrorCategoryId,
} from './PersianEvidenceCorrectionEngine';

export const LEXICAL_ANALYSIS_CONTRACT_VERSION = 'FA-LEXICAL-V1.0.0' as const;

export type LexicalProvenanceKind =
  | 'USER_CONFIRMED_VOCAB'
  | 'PROJECT_DOMAIN_VOCAB'
  | 'IMPORTED_VERIFIED_VOCAB'
  | 'STATIC_HOMOPHONE_TABLE'
  | 'ASR_ALTERNATIVE_HYPOTHESIS';

export type LexicalEntityKind =
  | 'PERSON_NAME'
  | 'GEOGRAPHIC_NAME'
  | 'ORGANIZATION_OR_BRAND'
  | 'SOFTWARE_OR_TECHNICAL'
  | 'ACRONYM'
  | 'DOMAIN_TERM'
  | 'COLLOQUIAL_OR_REGIONAL'
  | 'GENERAL';

export interface DomainVocabularyEntry {
  readonly entryId: string;
  readonly canonicalDisplayForm: string;
  readonly acceptedAlternatives: readonly string[];
  readonly languageScript: 'fa' | 'en' | 'fa-en';
  readonly entityKind: LexicalEntityKind;
  readonly domain: string;
  readonly pronunciationHints?: readonly string[];
  readonly provenance: LexicalProvenanceKind;
  readonly userVerified: boolean;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface LexicalCandidateAlternative {
  readonly surfaceForm: string;
  readonly provenance: LexicalProvenanceKind;
  /** Strictly separated from ASR acoustic confidence */
  readonly lexicalCompatibilityScore: number;
  readonly supportingEvidence: readonly CorrectionEvidenceItem[];
  readonly contradictoryEvidence: readonly CorrectionEvidenceItem[];
  readonly missingEvidence: readonly string[];
}

export type LexicalAmbiguityCategory =
  | 'HOMOPHONE'
  | 'NEAR_HOMOPHONE'
  | 'PROPER_NAME'
  | 'TECHNICAL_TERM'
  | 'COMPOUND_BOUNDARY'
  | 'COLLOQUIAL_VARIANT'
  | 'NUMERIC_OR_IDENTIFIER';

export interface LexicalAmbiguityRecord {
  readonly ambiguityId: string;
  readonly sourceTokenId: string;
  readonly originalAsrText: string;
  readonly charSpan: readonly [number, number];
  readonly category: LexicalAmbiguityCategory;
  readonly candidates: readonly LexicalCandidateAlternative[];
  readonly resolutionStatus: 'PRESERVED_ORIGINAL' | 'AMBIGUOUS_HUMAN_REVIEW' | 'DEFERRED_TO_P010';
  readonly p010Decision: CorrectionDecisionRecord | null;
  readonly analysisVersion: typeof LEXICAL_ANALYSIS_CONTRACT_VERSION;
}

export interface CompoundAnalysisAnnotation {
  readonly surfaceSpan: string;
  readonly sourceTokenIds: readonly string[];
  readonly unitKind: 'LEXICAL_COMPOUND' | 'LIGHT_VERB_CONSTRUCTION' | 'MULTIWORD_PROPER_NAME';
  readonly components: readonly string[];
  /** Non-destructive: canonical transcript tokens are NEVER mutated */
  readonly mutatesCanonicalTokens: false;
}

export interface VocabularyValidationResult {
  readonly valid: boolean;
  readonly conflicts: readonly string[];
  readonly errors: readonly string[];
}

const KNOWN_PERSIAN_HOMOPHONE_GROUPS: readonly (readonly string[])[] = [
  ['خواست', 'خاست'],
  ['خار', 'خوار'],
  ['سواب', 'ثواب'],
  ['اساس', 'اثاث'],
  ['حیات', 'حیاط'],
  ['سفر', 'صفر'],
  ['غذا', 'قضا'],
  ['عرض', 'ارز'],
  ['سد', 'صد'],
];

const LIGHT_VERB_FINALS = new Set(['کرد', 'کردم', 'کردند', 'شد', 'شدند', 'داد', 'زد', 'گرفت', 'داشت']);
const ACRONYM_RE = /^[A-Z]{2,8}(\d{0,3})?$/;
const IDENTIFIER_OR_VERSION_RE = /^(v?\d+(\.\d+){1,3}|[A-Z]{2,6}-\d{2,6}|[A-Za-z]+\d+[A-Za-z0-9\-_]*)$/;

/**
 * Indexed, versioned, local-only Domain & User Vocabulary Manager (`AVP-P0-012 §4, §5, §10, §13`).
 */
export class VersionedPersianVocabularyManager {
  private readonly entriesById = new Map<string, DomainVocabularyEntry>();
  private readonly surfaceIndex = new Map<string, Set<string>>(); // normalized surface -> entryIds
  private readonly revisionLog: Array<{
    readonly version: number;
    readonly action: 'ADD' | 'UPDATE' | 'REMOVE' | 'IMPORT';
    readonly entryId: string;
    readonly timestampMs: number;
  }> = [];
  private vocabularyVersion = 0;

  /** Tracks unverified machine guesses separately — NEVER promotes them to user-confirmed vocabulary */
  private readonly unverifiedMachineGuessCounts = new Map<string, number>();

  public getVersion(): number {
    return this.vocabularyVersion;
  }

  public getEntryCount(): number {
    return this.entriesById.size;
  }

  public getRevisionHistory() {
    return [...this.revisionLog];
  }

  public recordUnverifiedMachineGuess(term: string): void {
    const key = normalizeUnicodeScriptAware(term);
    this.unverifiedMachineGuessCounts.set(key, (this.unverifiedMachineGuessCounts.get(key) ?? 0) + 1);
    // Explicitly NEVER inserts into entriesById or marks userVerified = true!
  }

  public getUnverifiedGuessCount(term: string): number {
    return this.unverifiedMachineGuessCounts.get(normalizeUnicodeScriptAware(term)) ?? 0;
  }

  public static validateVocabularyPackage(rawEntries: unknown): VocabularyValidationResult {
    const errors: string[] = [];
    const conflicts: string[] = [];
    if (!Array.isArray(rawEntries)) {
      return { valid: false, conflicts: [], errors: ['Vocabulary package must be a JSON array.'] };
    }
    if (rawEntries.length > 50_000) {
      return { valid: false, conflicts: [], errors: ['Vocabulary package exceeds 50,000 entry safety bound.'] };
    }
    const seenCanonical = new Map<string, string>();
    for (let i = 0; i < rawEntries.length; i++) {
      const e = rawEntries[i] as Record<string, unknown>;
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        errors.push(`Entry[${i}] must be an object.`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(e, '__proto__') || Object.prototype.hasOwnProperty.call(e, 'constructor')) {
        errors.push(`Entry[${i}] contains forbidden prototype key.`);
        continue;
      }
      if (typeof e.canonicalDisplayForm !== 'string' || e.canonicalDisplayForm.trim().length === 0 || e.canonicalDisplayForm.length > 200) {
        errors.push(`Entry[${i}] has invalid canonicalDisplayForm.`);
        continue;
      }
      if (/[\0\r\n]/.test(e.canonicalDisplayForm)) {
        errors.push(`Entry[${i}] contains illegal control characters.`);
        continue;
      }
      const normKey = normalizeUnicodeScriptAware(e.canonicalDisplayForm).toLowerCase();
      const prev = seenCanonical.get(normKey);
      if (prev && prev !== e.canonicalDisplayForm) {
        conflicts.push(`Conflicting canonical forms for "${normKey}": "${prev}" vs "${e.canonicalDisplayForm}".`);
      }
      seenCanonical.set(normKey, e.canonicalDisplayForm);
    }
    return { valid: errors.length === 0, conflicts, errors };
  }

  public upsertConfirmedEntry(params: {
    readonly entryId: string;
    readonly canonicalDisplayForm: string;
    readonly acceptedAlternatives?: readonly string[];
    readonly languageScript: 'fa' | 'en' | 'fa-en';
    readonly entityKind: LexicalEntityKind;
    readonly domain: string;
    readonly pronunciationHints?: readonly string[];
    readonly provenance: LexicalProvenanceKind;
    readonly userVerified: boolean;
    readonly nowMs?: number;
  }): DomainVocabularyEntry {
    const now = params.nowMs ?? Date.now();
    const existing = this.entriesById.get(params.entryId);
    if (existing) {
      this.unindexEntry(existing);
    }
    this.vocabularyVersion += 1;
    const entry: DomainVocabularyEntry = {
      entryId: params.entryId,
      canonicalDisplayForm: params.canonicalDisplayForm.trim(),
      acceptedAlternatives: [...(params.acceptedAlternatives ?? [])],
      languageScript: params.languageScript,
      entityKind: params.entityKind,
      domain: params.domain,
      pronunciationHints: params.pronunciationHints ? [...params.pronunciationHints] : undefined,
      provenance: params.provenance,
      userVerified: params.userVerified,
      version: this.vocabularyVersion,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };
    this.entriesById.set(entry.entryId, entry);
    this.indexEntry(entry);
    this.revisionLog.push({
      version: this.vocabularyVersion,
      action: existing ? 'UPDATE' : 'ADD',
      entryId: entry.entryId,
      timestampMs: now,
    });
    return entry;
  }

  public removeEntry(entryId: string, nowMs = Date.now()): boolean {
    const existing = this.entriesById.get(entryId);
    if (!existing) return false;
    this.unindexEntry(existing);
    this.entriesById.delete(entryId);
    this.vocabularyVersion += 1;
    this.revisionLog.push({
      version: this.vocabularyVersion,
      action: 'REMOVE',
      entryId,
      timestampMs: nowMs,
    });
    return true;
  }

  /** O(1) indexed lookup by surface form or accepted alternative */
  public lookupBySurface(surface: string): readonly DomainVocabularyEntry[] {
    const key = normalizeUnicodeScriptAware(surface).toLowerCase();
    const ids = this.surfaceIndex.get(key);
    if (!ids || ids.size === 0) return [];
    const results: DomainVocabularyEntry[] = [];
    for (const id of ids) {
      const entry = this.entriesById.get(id);
      if (entry) results.push(entry);
    }
    return results;
  }

  public getAllProperNameStrings(): string[] {
    const out: string[] = [];
    for (const entry of this.entriesById.values()) {
      if (
        entry.entityKind === 'PERSON_NAME' ||
        entry.entityKind === 'GEOGRAPHIC_NAME' ||
        entry.entityKind === 'ORGANIZATION_OR_BRAND' ||
        entry.entityKind === 'SOFTWARE_OR_TECHNICAL'
      ) {
        out.push(entry.canonicalDisplayForm);
      }
    }
    return out;
  }

  public exportPackageJson(): string {
    return JSON.stringify(
      {
        contractVersion: LEXICAL_ANALYSIS_CONTRACT_VERSION,
        vocabularyVersion: this.vocabularyVersion,
        entries: Array.from(this.entriesById.values()),
      },
      null,
      2,
    );
  }

  private indexEntry(entry: DomainVocabularyEntry): void {
    const keys = [entry.canonicalDisplayForm, ...entry.acceptedAlternatives];
    for (const k of keys) {
      const norm = normalizeUnicodeScriptAware(k).toLowerCase();
      if (!norm) continue;
      let set = this.surfaceIndex.get(norm);
      if (!set) {
        set = new Set<string>();
        this.surfaceIndex.set(norm, set);
      }
      set.add(entry.entryId);
    }
  }

  private unindexEntry(entry: DomainVocabularyEntry): void {
    const keys = [entry.canonicalDisplayForm, ...entry.acceptedAlternatives];
    for (const k of keys) {
      const norm = normalizeUnicodeScriptAware(k).toLowerCase();
      const set = this.surfaceIndex.get(norm);
      if (set) {
        set.delete(entry.entryId);
        if (set.size === 0) this.surfaceIndex.delete(norm);
      }
    }
  }
}

export interface LexicalTokenInput {
  readonly tokenId: string;
  readonly text: string;
  readonly providerConfidence?: number;
  readonly asrAlternatives?: readonly string[];
  readonly acousticEvidence?: readonly CorrectionEvidenceItem[];
}

export interface LexicalAnalysisResult {
  readonly analysisVersion: typeof LEXICAL_ANALYSIS_CONTRACT_VERSION;
  readonly policyVersion: typeof PERSIAN_LINGUISTIC_POLICY_VERSION;
  readonly vocabularyVersion: number;
  readonly preservedOriginalTokens: readonly string[];
  readonly ambiguities: readonly LexicalAmbiguityRecord[];
  readonly compoundAnnotations: readonly CompoundAnalysisAnnotation[];
  readonly protectedIdentifiers: readonly string[];
  readonly regionalCoverageLimitation: string;
}

/**
 * Runs conservative, evidence-constrained Persian lexical analysis and routes any
 * proposed replacement strictly through the canonical P0-010 correction decision engine.
 */
export function analyzePersianLexicalFidelity(params: {
  readonly segmentId: string;
  readonly transcriptRevision: number;
  readonly tokens: readonly LexicalTokenInput[];
  readonly vocabulary: VersionedPersianVocabularyManager;
  readonly maxCandidatesPerToken?: number;
  readonly abortSignal?: AbortSignal;
}): LexicalAnalysisResult {
  const maxCandidates = Math.max(1, Math.min(8, params.maxCandidatesPerToken ?? 4));
  const ambiguities: LexicalAmbiguityRecord[] = [];
  const compoundAnnotations: CompoundAnalysisAnnotation[] = [];
  const protectedIdentifiers: string[] = [];
  const properNames = params.vocabulary.getAllProperNameStrings();

  let charCursor = 0;

  for (let i = 0; i < params.tokens.length; i++) {
    if (params.abortSignal?.aborted) {
      throw new Error('LEXICAL_ANALYSIS_ABORTED');
    }
    const tok = params.tokens[i];
    const spanStart = charCursor;
    const spanEnd = charCursor + tok.text.length;
    charCursor = spanEnd + 1;

    const norm = normalizeUnicodeScriptAware(tok.text);

    // Protect acronyms, software identifiers, and version strings from expansion or mutation
    if (ACRONYM_RE.test(tok.text) || IDENTIFIER_OR_VERSION_RE.test(tok.text)) {
      protectedIdentifiers.push(tok.text);
      continue;
    }

    // Non-destructive light-verb compound detection (analysis layer only; NEVER mutates canonical tokens)
    if (i + 1 < params.tokens.length) {
      const nextNorm = normalizeUnicodeScriptAware(params.tokens[i + 1].text);
      if (LIGHT_VERB_FINALS.has(nextNorm)) {
        compoundAnnotations.push({
          surfaceSpan: `${tok.text} ${params.tokens[i + 1].text}`,
          sourceTokenIds: [tok.tokenId, params.tokens[i + 1].tokenId],
          unitKind: 'LIGHT_VERB_CONSTRUCTION',
          components: [norm, nextNorm],
          mutatesCanonicalTokens: false,
        });
      }
    }

    const candidates: LexicalCandidateAlternative[] = [];
    let category: LexicalAmbiguityCategory | null = null;
    let errorCat: PersianErrorCategoryId = 'LEX_DOMAIN_VOCABULARY';

    // 1. Check indexed user/domain vocabulary (O(1))
    const vocabHits = params.vocabulary.lookupBySurface(tok.text);
    for (const hit of vocabHits) {
      if (hit.canonicalDisplayForm !== tok.text) {
        category =
          hit.entityKind === 'PERSON_NAME' ||
          hit.entityKind === 'GEOGRAPHIC_NAME' ||
          hit.entityKind === 'ORGANIZATION_OR_BRAND'
            ? 'PROPER_NAME'
            : 'TECHNICAL_TERM';
        errorCat = category === 'PROPER_NAME' ? 'LEX_PROPER_NAME_SUBSTITUTION' : 'LEX_TECHNICAL_TERM';
        candidates.push({
          surfaceForm: hit.canonicalDisplayForm,
          provenance: hit.provenance,
          lexicalCompatibilityScore: hit.userVerified ? 0.85 : 0.65,
          supportingEvidence: [
            {
              evidenceId: `voc_${hit.entryId}`,
              tier: 'DOMAIN',
              polarity: 'SUPPORTING',
              source: hit.provenance,
              summary: `Matched ${hit.userVerified ? 'user-confirmed' : 'domain'} vocabulary entry "${hit.canonicalDisplayForm}" (${hit.domain}).`,
            },
          ],
          contradictoryEvidence: [],
          missingEvidence: tok.acousticEvidence?.length ? [] : ['DIRECT_ACOUSTIC'],
        });
      }
    }

    // 2. Check known Persian homophone inventory (without assuming higher frequency is correct)
    for (const group of KNOWN_PERSIAN_HOMOPHONE_GROUPS) {
      if (group.includes(norm)) {
        category = category ?? 'HOMOPHONE';
        errorCat = 'LEX_HOMOPHONE';
        for (const alt of group) {
          if (alt !== norm && candidates.length < maxCandidates) {
            candidates.push({
              surfaceForm: alt,
              provenance: 'STATIC_HOMOPHONE_TABLE',
              lexicalCompatibilityScore: 0.5,
              supportingEvidence: [
                {
                  evidenceId: `hom_${tok.tokenId}_${alt}`,
                  tier: 'LINGUISTIC',
                  polarity: 'SUPPORTING',
                  source: 'PERSIAN_HOMOPHONE_INVENTORY',
                  summary: `Homophone alternative "${alt}" shares pronunciation with "${norm}".`,
                },
              ],
              contradictoryEvidence: [],
              missingEvidence: ['DIRECT_ACOUSTIC', 'ASR_RECOGNITION'],
            });
          }
        }
      }
    }

    // 3. Include actual provider-supplied ASR alternatives (never invented)
    for (const alt of tok.asrAlternatives ?? []) {
      if (alt !== tok.text && candidates.length < maxCandidates) {
        candidates.push({
          surfaceForm: alt,
          provenance: 'ASR_ALTERNATIVE_HYPOTHESIS',
          lexicalCompatibilityScore: 0.6,
          supportingEvidence: [
            {
              evidenceId: `asr_alt_${tok.tokenId}`,
              tier: 'ASR_RECOGNITION',
              polarity: 'SUPPORTING',
              source: 'ASR_NBEST_HYPOTHESIS',
              summary: `Alternative ASR hypothesis "${alt}" emitted by local recognizer.`,
            },
          ],
          contradictoryEvidence: [],
          missingEvidence: [],
        });
      }
    }

    if (candidates.length > 0 && category) {
      const top = candidates[0];
      const allEvidence: CorrectionEvidenceItem[] = [
        ...(tok.acousticEvidence ?? []),
        ...top.supportingEvidence,
        ...top.contradictoryEvidence,
      ];
      const confRecord: ConfidenceProvenanceRecord =
        typeof tok.providerConfidence === 'number'
          ? {
              providerRawConfidence: tok.providerConfidence,
              providerSource: 'ASR_TOKEN_LOGPROB',
              linguisticCompatibilityScore: top.lexicalCompatibilityScore,
              calibrationDatasetQualified: false,
            }
          : {
              providerSource: 'UNAVAILABLE',
              linguisticCompatibilityScore: top.lexicalCompatibilityScore,
              calibrationDatasetQualified: false,
            };

      // Strictly route through P0-010 Correction Decision Engine — ZERO duplicate authorization!
      const p010Decision = evaluateProposedCorrection({
        proposalId: `lex_${params.segmentId}_${tok.tokenId}`,
        transcriptRevision: params.transcriptRevision,
        segmentId: params.segmentId,
        tokenIds: [tok.tokenId],
        originalText: tok.text,
        proposedText: top.surfaceForm,
        category: errorCat,
        evidence: allEvidence,
        confidence: confRecord,
        knownProperNames: properNames,
      });

      ambiguities.push({
        ambiguityId: `amb_${params.segmentId}_${tok.tokenId}`,
        sourceTokenId: tok.tokenId,
        originalAsrText: tok.text,
        charSpan: [spanStart, spanEnd],
        category,
        candidates: candidates.slice(0, maxCandidates),
        resolutionStatus:
          p010Decision.outcome === 'REJECTED_CORRECTION' || p010Decision.outcome === 'NO_CHANGE'
            ? 'PRESERVED_ORIGINAL'
            : 'DEFERRED_TO_P010',
        p010Decision,
        analysisVersion: LEXICAL_ANALYSIS_CONTRACT_VERSION,
      });
    }
  }

  return {
    analysisVersion: LEXICAL_ANALYSIS_CONTRACT_VERSION,
    policyVersion: PERSIAN_LINGUISTIC_POLICY_VERSION,
    vocabularyVersion: params.vocabulary.getVersion(),
    preservedOriginalTokens: params.tokens.map((t) => t.text),
    ambiguities,
    compoundAnnotations,
    protectedIdentifiers,
    regionalCoverageLimitation:
      'No verified regional Persian dialect lexicon is installed; uncommon regional words are preserved verbatim rather than substituted.',
  };
}
