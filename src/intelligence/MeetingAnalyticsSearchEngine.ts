/**
 * PHASE 11 — STAGES 11D, 11E & 11F:
 *  - Stage 11D: Evidence-Grounded Meeting Intelligence (with Prompt-Injection Neutralization & Hallucination Guard)
 *  - Stage 11E: Objective Conversation Analytics, Structured Information Extraction & Tenant-Isolated Semantic Search
 *  - Stage 11F: Real-Time Speech Intelligence Event Pipeline with ASR Latency Isolation
 */

import crypto from 'node:crypto';
import type {
  ActionItemRecord,
  ConversationAnalyticsPayload,
  ConversationMetricDescriptor,
  DiarizationSegment,
  EvidenceLinkedStatement,
  EvidenceReference,
  ExtractedStructuredItem,
  MeetingIntelligencePayload,
  RealtimeIntelligenceEvent,
  SemanticSearchResultItem,
  StructuredExtractionPayload,
} from './SpeechIntelligenceContracts';
import {
  validateNoBiometricOrSensitiveClaims,
  type TimedSegmentInput,
} from './DiarizationAlignmentEngine';

// ── Stage 11D: Meeting Intelligence & Prompt Injection Protection ────────────

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/gi,
  /system\s+prompt\s*[:=]/gi,
  /execute\s+tool|grant\s+admin|bypass\s+tenant/gi,
  /دستورهای?\s+قبلی\s+را\s+نادیده\s+بگیر/g,
  /دسترسی\s+ادمین\s+بده/g,
];

export function sanitizeUntrustedTranscriptForIntelligence(rawText: string): {
  sanitizedText: string;
  neutralizedCount: number;
} {
  let neutralizedCount = 0;
  let out = rawText;
  for (const rx of PROMPT_INJECTION_PATTERNS) {
    const matches = out.match(rx);
    if (matches) {
      neutralizedCount += matches.length;
      out = out.replace(rx, '[UNTRUSTED_SPOKEN_DIRECTIVE_NEUTRALIZED]');
    }
  }
  return { sanitizedText: out, neutralizedCount };
}

function buildEvidence(seg: TimedSegmentInput): EvidenceReference {
  return {
    segmentId: seg.segmentId,
    startSec: Number(seg.startSec.toFixed(3)),
    endSec: Number(seg.endSec.toFixed(3)),
    excerpt: seg.text.slice(0, 140),
  };
}

export function runMeetingIntelligenceCapability(params: {
  recordingId: string;
  segments: TimedSegmentInput[];
  diarizationSegments?: DiarizationSegment[];
  externalClaimCandidates?: Array<{ text: string; citedSegmentIds: string[] }>;
}): MeetingIntelligencePayload {
  let promptInjectionAttemptsNeutralized = 0;
  const cleanedSegments: TimedSegmentInput[] = params.segments.map((seg) => {
    const { sanitizedText, neutralizedCount } = sanitizeUntrustedTranscriptForIntelligence(seg.text);
    promptInjectionAttemptsNeutralized += neutralizedCount;
    return { ...seg, text: sanitizedText };
  });

  const validSegmentMap = new Map(cleanedSegments.map((s) => [s.segmentId, s]));

  // Find overlapping anonymous speaker from diarization if missing
  const resolveSpeaker = (seg: TimedSegmentInput): string | null => {
    if (seg.speakerHint && /^speaker_\d+$/i.test(seg.speakerHint)) return seg.speakerHint;
    if (!params.diarizationSegments) return null;
    for (const d of params.diarizationSegments) {
      if (seg.startSec < d.endSec && seg.endSec > d.startSec && d.speakerId !== 'UNKNOWN_SPEAKER') {
        return d.speakerId;
      }
    }
    return null;
  };

  const summary: EvidenceLinkedStatement[] = [];
  const decisions: EvidenceLinkedStatement[] = [];
  const actionItems: ActionItemRecord[] = [];
  const openQuestions: EvidenceLinkedStatement[] = [];
  const unresolvedIssues: EvidenceLinkedStatement[] = [];
  const namedEntities: Array<{ text: string; type: string; evidence: EvidenceReference[] }> = [];
  const topicBag = new Set<string>();

  for (const seg of cleanedSegments) {
    const ev = buildEvidence(seg);
    const t = seg.text;

    if (/تصمیم|توافق|مصوب|approved|decided|agreed/i.test(t)) {
      decisions.push({
        text: `تصمیم مشاهده‌شده در گفتار: «${t}»`,
        observationClass: 'DIRECTLY_OBSERVED',
        evidence: [ev],
        requiresHumanReview: true,
      });
    }

    if (/باید|انجام|پیگیری|آماده|ارسال|action|todo|follow\s*up|prepare|send/i.test(t)) {
      const spk = resolveSpeaker(seg);
      const explicitDateMatch = t.match(/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b|\b(?:Monday|Tuesday|Wednesday|Thursday|Friday)\b|شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنج‌شنبه|جمعه/);
      const ambiguousDateMatch = t.match(/هفته\s*آینده|فردا|زودتر|به\s*زودی|next\s*week|soon/i);
      const hasExplicitNameOrSpeaker = Boolean(spk && /من|خودم|speaker_/i.test(`${spk} ${t}`));

      actionItems.push({
        description: t,
        assigneeStatus: hasExplicitNameOrSpeaker ? 'attributed' : 'unknown',
        responsibleSpeakerId: hasExplicitNameOrSpeaker ? spk : null,
        dueDateStatus: explicitDateMatch ? 'explicit' : ambiguousDateMatch ? 'ambiguous' : 'none',
        dueDateRawText: explicitDateMatch?.[0] ?? ambiguousDateMatch?.[0] ?? null,
        status: explicitDateMatch ? 'confirmed' : 'proposed',
        evidence: [ev],
        requiresHumanReview: true,
      });
    }

    if (/[؟?]|آیا|چطور|کی|what|how|when|why/i.test(t)) {
      openQuestions.push({
        text: t,
        observationClass: 'DIRECTLY_OBSERVED',
        evidence: [ev],
        requiresHumanReview: false,
      });
    }

    if (/مشکل|نامشخص|ریسک|بلاک|معلق|blocked|unresolved|issue|risk/i.test(t)) {
      unresolvedIssues.push({
        text: t,
        observationClass: 'MODEL_GENERATED_INTERPRETATION',
        evidence: [ev],
        requiresHumanReview: true,
      });
    }

    // Extract English proper tokens & Persian domain terms
    const enTerms = t.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g) ?? [];
    for (const term of enTerms) {
      topicBag.add(term);
      namedEntities.push({ text: term, type: 'ORGANIZATION_OR_TERM', evidence: [ev] });
    }
    if (/آوا\s*پرداز|آواپرداز/.test(t)) {
      topicBag.add('آواپرداز');
      namedEntities.push({ text: 'آواپرداز', type: 'PROJECT_OR_PRODUCT', evidence: [ev] });
    }
  }

  // Generate bounded evidence-linked summary statements (up to 4)
  for (const seg of cleanedSegments.slice(0, 4)) {
    const check = validateNoBiometricOrSensitiveClaims(seg.text);
    if (!check.valid) continue;
    summary.push({
      text: seg.text,
      observationClass: 'DIRECTLY_OBSERVED',
      evidence: [buildEvidence(seg)],
      requiresHumanReview: true,
    });
  }

  // Hallucination Guard: reject any candidate statements lacking real transcript segment IDs (§9.4)
  let unsupportedStatementsRemoved = 0;
  if (params.externalClaimCandidates) {
    for (const cand of params.externalClaimCandidates) {
      const refs = cand.citedSegmentIds
        .map((id) => validSegmentMap.get(id))
        .filter((s): s is TimedSegmentInput => Boolean(s));
      if (refs.length === 0) {
        unsupportedStatementsRemoved++;
      } else {
        summary.push({
          text: cand.text,
          observationClass: 'MODEL_GENERATED_INTERPRETATION',
          evidence: refs.map(buildEvidence),
          requiresHumanReview: true,
        });
      }
    }
  }

  const totalClaims = summary.length + decisions.length + actionItems.length;
  const supportedClaims = [...summary, ...decisions, ...actionItems].filter((c) => c.evidence.length > 0).length;

  return {
    capability: 'speech.meeting_intelligence',
    recordingId: params.recordingId,
    authoritativeRecord: false,
    requiresCustomerReview: true,
    promptInjectionAttemptsNeutralized,
    summary,
    keyTopics: Array.from(topicBag),
    decisions,
    actionItems,
    openQuestions,
    unresolvedIssues,
    namedEntities,
    hallucinationCheck: {
      allClaimsSupportedByEvidence: unsupportedStatementsRemoved === 0 && supportedClaims === totalClaims,
      unsupportedStatementsRemoved,
      citationCoverageRate: totalClaims === 0 ? 1 : Number((supportedClaims / totalClaims).toFixed(3)),
    },
  };
}

// ── Stage 11E.1: Objective Conversation Analytics (§10) ──────────────────────

export function runConversationAnalyticsCapability(params: {
  recordingId: string;
  totalDurationSec: number;
  diarizationSegments: DiarizationSegment[];
  transcriptSegments: TimedSegmentInput[];
  prohibitedPsychologicalClaimRequested?: boolean;
}): ConversationAnalyticsPayload {
  if (params.prohibitedPsychologicalClaimRequested) {
    throw new Error(
      'POLICY_FORBIDDEN: Psychological state, honesty, personality, or emotion-truthfulness inferences are prohibited.'
    );
  }

  const speakingBySpeaker = new Map<string, { dur: number; turns: number }>();
  let totalSpeechCoveredSec = 0;
  let overlapDurationSec = 0;
  let heuristicInterruptionCount = 0;

  const sortedDiar = [...params.diarizationSegments].sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i < sortedDiar.length; i++) {
    const seg = sortedDiar[i];
    const dur = Math.max(0, seg.endSec - seg.startSec);
    totalSpeechCoveredSec += dur;
    const prev = speakingBySpeaker.get(seg.speakerId) ?? { dur: 0, turns: 0 };
    prev.dur += dur;
    prev.turns += 1;
    speakingBySpeaker.set(seg.speakerId, prev);

    if (seg.overlap) {
      overlapDurationSec += dur;
    }
    if (i > 0) {
      const prevSeg = sortedDiar[i - 1];
      if (prevSeg.speakerId !== seg.speakerId && seg.startSec < prevSeg.endSec - 0.05) {
        heuristicInterruptionCount++;
      }
    }
  }

  const effectiveTotalDur = Math.max(params.totalDurationSec, totalSpeechCoveredSec, 0.1);
  const silenceDurationSec = Math.max(0, effectiveTotalDur - Math.min(effectiveTotalDur, totalSpeechCoveredSec));
  const speechToSilenceRatio =
    silenceDurationSec > 0.01 ? Number((totalSpeechCoveredSec / silenceDurationSec).toFixed(3)) : totalSpeechCoveredSec;

  const questionCount = params.transcriptSegments.filter((s) => /[؟?]|آیا/i.test(s.text)).length;
  const nonEmptySegs = params.transcriptSegments.filter((s) => s.text.trim().length > 0).length;
  const completenessRatio =
    params.transcriptSegments.length === 0
      ? 0
      : Number((nonEmptySegs / params.transcriptSegments.length).toFixed(3));

  const speakerMetrics = Array.from(speakingBySpeaker.entries()).map(([speakerId, st]) => ({
    speakerId,
    speakingDurationSec: Number(st.dur.toFixed(3)),
    turnCount: st.turns,
    averageTurnDurationSec: Number((st.dur / Math.max(1, st.turns)).toFixed(3)),
  }));

  const metrics: ConversationMetricDescriptor[] = [
    {
      metricId: 'analytics.speaking_duration_by_speaker',
      label: 'Speaking Duration per Anonymous Speaker',
      value: Object.fromEntries(speakerMetrics.map((m) => [m.speakerId, m.speakingDurationSec])),
      unit: 'seconds',
      definition: 'Cumulative acoustic speech span assigned to each anonymous local speaker label.',
      calculationMethod: 'Sum of (endSec - startSec) over non-deleted diarization segments grouped by speaker_id.',
      inputArtifacts: ['speech.diarization'],
      validityStatus: 'VERIFIED',
      knownLimitations: ['Accuracy depends on underlying diarization overlap boundary precision.'],
    },
    {
      metricId: 'analytics.interruption_like_overlap_heuristic',
      label: 'Interruption-Like Overlap Events (Operational Heuristic)',
      value: heuristicInterruptionCount,
      unit: 'count',
      definition: 'Operational acoustic overlap onset between distinct speaker labels (>50ms overlap).',
      calculationMethod: 'Count adjacent segment pairs where speaker_i != speaker_{i-1} and start_i < end_{i-1} - 0.05.',
      inputArtifacts: ['speech.diarization'],
      validityStatus: 'HEURISTIC_OPERATIONAL_ONLY',
      knownLimitations: [
        'Does NOT measure interpersonal dominance, rudeness, psychological intent, or conversational fault.',
        'Backchannel agreements (e.g. بله / right) trigger this heuristic identically to turn overlaps.',
      ],
    },
    {
      metricId: 'analytics.speech_to_silence_ratio',
      label: 'Speech-to-Silence Ratio',
      value: Number(speechToSilenceRatio.toFixed(3)),
      unit: 'ratio',
      definition: 'Ratio of cumulative detected speech time to remaining recording non-speech time.',
      calculationMethod: 'sum(speechDur) / max(0.01, totalDurationSec - sum(speechDur)).',
      inputArtifacts: ['speech.diarization'],
      validityStatus: 'VERIFIED',
      knownLimitations: ['Uncomparable across recordings captured with heterogeneous VAD noise floors.'],
    },
    {
      metricId: 'analytics.question_count',
      label: 'Question Utterance Count',
      value: questionCount,
      unit: 'count',
      definition: 'Count of transcript segments containing interrogative punctuation or Persian question marker آیا.',
      calculationMethod: 'Deterministic regex match on transcript segments.',
      inputArtifacts: ['asr.transcription'],
      validityStatus: 'VERIFIED',
      knownLimitations: ['Prosodic questions without punctuation are not counted unless restored upstream.'],
    },
  ];

  return {
    capability: 'speech.conversation_analytics',
    recordingId: params.recordingId,
    psychologicalOrBiometricInferencesAllowed: false,
    metrics,
    speakerMetrics,
    totalDurationSec: Number(effectiveTotalDur.toFixed(3)),
    silenceDurationSec: Number(silenceDurationSec.toFixed(3)),
    overlapDurationSec: Number(overlapDurationSec.toFixed(3)),
    interruptionLikeOverlapHeuristicCount: heuristicInterruptionCount,
    questionCount,
    speechToSilenceRatio: Number(speechToSilenceRatio.toFixed(3)),
    transcriptCompletenessRatio: completenessRatio,
  };
}

// ── Stage 11E.2: Schema-Constrained Structured Extraction (§12) ───────────────

export function runStructuredExtractionCapability(params: {
  recordingId: string;
  segments: TimedSegmentInput[];
  modelVersion?: string;
}): StructuredExtractionPayload {
  const modelVersion = params.modelVersion ?? 'avapardaz-schema-extractor-v1.0';
  const items: ExtractedStructuredItem[] = [];

  for (const seg of params.segments) {
    const t = seg.text;

    // 1. Ambiguous numeric/approximate expressions MUST NOT be turned into fake exact numbers
    const approxMatches = t.match(/(?:حدود|تقریباً|یکی\s+دو|شاید\s+\d+|around|roughly|approximately)\s+\S+/gi) ?? [];
    for (const span of approxMatches) {
      items.push({
        fieldType: 'NUMBER',
        extractedValue: null,
        originalTextSpan: span,
        sourceSegmentIds: [seg.segmentId],
        startSec: seg.startSec,
        endSec: seg.endSec,
        extractionModelVersion: modelVersion,
        validationStatus: 'AMBIGUOUS',
        reviewStatus: 'PENDING_REVIEW',
      });
    }

    // 2. Exact currency amounts
    const currencyMatches = t.match(/\b\d+(?:[.,]\d+)?\s*(?:USD|EUR|IRR|دلار|تومان|ریال)\b/gi) ?? [];
    for (const span of currencyMatches) {
      items.push({
        fieldType: 'CURRENCY',
        extractedValue: span,
        originalTextSpan: span,
        sourceSegmentIds: [seg.segmentId],
        startSec: seg.startSec,
        endSec: seg.endSec,
        extractionModelVersion: modelVersion,
        validationStatus: 'VALID',
        reviewStatus: 'PENDING_REVIEW',
      });
    }

    // 3. Explicit dates (ISO or Jalali numeric)
    const dateMatches = t.match(/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g) ?? [];
    for (const span of dateMatches) {
      items.push({
        fieldType: 'DATE',
        extractedValue: span,
        originalTextSpan: span,
        sourceSegmentIds: [seg.segmentId],
        startSec: seg.startSec,
        endSec: seg.endSec,
        extractionModelVersion: modelVersion,
        validationStatus: 'VALID',
        reviewStatus: 'PENDING_REVIEW',
      });
    }

    // 4. Contract / Project IDs
    const refMatches = t.match(/\b(?:PRJ|CTR|CNT|ORD|INV)-[A-Z0-9-]{3,}\b/gi) ?? [];
    for (const span of refMatches) {
      items.push({
        fieldType: 'CONTRACT_REF',
        extractedValue: span.toUpperCase(),
        originalTextSpan: span,
        sourceSegmentIds: [seg.segmentId],
        startSec: seg.startSec,
        endSec: seg.endSec,
        extractionModelVersion: modelVersion,
        validationStatus: 'VALID',
        reviewStatus: 'PENDING_REVIEW',
      });
    }

    // 5. Explicit technical terms
    const techMatches = t.match(/\b(?:TypeScript|PostgreSQL|FastConformer|WebSocket|ONNX|ASR|Diarization|Docker|Kubernetes)\b/gi) ?? [];
    for (const span of techMatches) {
      items.push({
        fieldType: 'TECH_TERM',
        extractedValue: span,
        originalTextSpan: span,
        sourceSegmentIds: [seg.segmentId],
        startSec: seg.startSec,
        endSec: seg.endSec,
        extractionModelVersion: modelVersion,
        validationStatus: 'VALID',
        reviewStatus: 'PENDING_REVIEW',
      });
    }

    // 6. Questions
    if (/[؟?]/.test(t)) {
      items.push({
        fieldType: 'QUESTION',
        extractedValue: t,
        originalTextSpan: t,
        sourceSegmentIds: [seg.segmentId],
        startSec: seg.startSec,
        endSec: seg.endSec,
        extractionModelVersion: modelVersion,
        validationStatus: 'VALID',
        reviewStatus: 'PENDING_REVIEW',
      });
    }
  }

  return {
    capability: 'speech.structured_extraction',
    recordingId: params.recordingId,
    items,
    ambiguousOrReviewCount: items.filter((i) => i.validationStatus !== 'VALID').length,
  };
}

// ── Stage 11E.3: Replaceable Embedding & Tenant-Isolated Semantic Search ──────

export interface EmbeddingProvider {
  readonly providerId: string;
  readonly dimensions: number;
  embedText(text: string): number[];
}

/**
 * Deterministic 64-dim character-trigram + lexical token hash embedder for zero-dependency CPU search.
 */
export class LocalBilingualTrigramEmbedder implements EmbeddingProvider {
  public readonly providerId = 'avapardaz-local-trigram-embedder-v1';
  public readonly dimensions = 64;

  public embedText(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const clean = text.toLowerCase().replace(/\u200c/g, ' ').trim();
    const tokens = clean.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const h = crypto.createHash('sha256').update(tok, 'utf8').digest();
      vec[h[0] % this.dimensions] += 1.5;
      for (let i = 0; i + 2 < tok.length; i++) {
        const tri = tok.slice(i, i + 3);
        const th = crypto.createHash('sha256').update(tri, 'utf8').digest();
        vec[th[0] % this.dimensions] += 1.0;
      }
    }
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    return norm > 0 ? vec.map((v) => v / norm) : vec;
  }
}

interface IndexedSemanticSegment {
  organizationId: string;
  projectId: string;
  recordingId: string;
  segmentId: string;
  transcriptText: string;
  startSec: number;
  endSec: number;
  speakerId?: string;
  language: 'fa' | 'en' | 'fa-en';
  transcriptVersion: number;
  indexedAtIso: string;
  vector: number[];
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
  }
  return Number(Math.max(0, Math.min(1, dot)).toFixed(4));
}

/**
 * Enforces strict tenant & project authorization BEFORE vector ranking or retrieval (§11.4).
 */
export class TenantIsolatedSemanticIndex {
  private readonly rows: IndexedSemanticSegment[] = [];
  constructor(private readonly embedder: EmbeddingProvider = new LocalBilingualTrigramEmbedder()) {}

  public indexRecordingSegments(params: {
    organizationId: string;
    projectId: string;
    recordingId: string;
    transcriptVersion: number;
    language: 'fa' | 'en' | 'fa-en';
    segments: TimedSegmentInput[];
  }): { indexedCount: number; providerId: string } {
    // Remove previous chunks for the same recording + version to keep re-indexing idempotent
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (
        this.rows[i].organizationId === params.organizationId &&
        this.rows[i].recordingId === params.recordingId &&
        this.rows[i].transcriptVersion === params.transcriptVersion
      ) {
        this.rows.splice(i, 1);
      }
    }

    const nowIso = new Date().toISOString();
    for (const seg of params.segments) {
      this.rows.push({
        organizationId: params.organizationId,
        projectId: params.projectId,
        recordingId: params.recordingId,
        segmentId: seg.segmentId,
        transcriptText: seg.text,
        startSec: seg.startSec,
        endSec: seg.endSec,
        speakerId: seg.speakerHint,
        language: seg.language ?? params.language,
        transcriptVersion: params.transcriptVersion,
        indexedAtIso: nowIso,
        vector: this.embedder.embedText(seg.text),
      });
    }

    return { indexedCount: params.segments.length, providerId: this.embedder.providerId };
  }

  public deleteRecordingEmbeddings(params: { organizationId: string; recordingId: string }): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (
        this.rows[i].organizationId === params.organizationId &&
        this.rows[i].recordingId === params.recordingId
      ) {
        this.rows.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  public searchAuthorized(params: {
    organizationId: string;
    projectId: string;
    query: string;
    recordingId?: string;
    speakerId?: string;
    language?: 'fa' | 'en' | 'fa-en';
    minStartSec?: number;
    maxEndSec?: number;
    topK?: number;
  }): SemanticSearchResultItem[] {
    // 1. MANDATORY PRE-RANKING TENANT & PROJECT AUTHORIZATION FILTER
    const authorizedSlice = this.rows.filter((r) => {
      if (r.organizationId !== params.organizationId || r.projectId !== params.projectId) return false;
      if (params.recordingId && r.recordingId !== params.recordingId) return false;
      if (params.speakerId && r.speakerId !== params.speakerId) return false;
      if (params.language && r.language !== params.language) return false;
      if (params.minStartSec !== undefined && r.endSec < params.minStartSec) return false;
      if (params.maxEndSec !== undefined && r.startSec > params.maxEndSec) return false;
      return true;
    });

    const qTrim = params.query.trim();
    if (!qTrim) return [];
    const qLower = qTrim.toLowerCase();
    const qVec = this.embedder.embedText(qTrim);

    const scored: SemanticSearchResultItem[] = authorizedSlice.map((row) => {
      const exactHit = row.transcriptText.toLowerCase().includes(qLower);
      const vecSim = cosineSim(qVec, row.vector);
      const retrievalMethod: SemanticSearchResultItem['retrievalMethod'] = exactHit
        ? qLower.includes(' ')
          ? 'PHRASE'
          : 'EXACT_SUBSTRING'
        : 'SEMANTIC_EMBEDDING_LOCAL';
      const score = exactHit ? Number(Math.max(0.92, vecSim).toFixed(4)) : vecSim;
      return {
        recordingId: row.recordingId,
        segmentId: row.segmentId,
        transcriptText: row.transcriptText,
        startSec: row.startSec,
        endSec: row.endSec,
        speakerId: row.speakerId,
        language: row.language,
        similarityScore: score,
        similarityNotice: 'RETRIEVAL_SCORE_NOT_FACTUAL_CONFIDENCE',
        retrievalMethod,
        transcriptVersion: row.transcriptVersion,
        organizationId: row.organizationId,
        projectId: row.projectId,
      };
    });

    return scored
      .filter((s) => s.similarityScore > 0)
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, params.topK ?? 10);
  }

  public countForRecording(organizationId: string, recordingId: string): number {
    return this.rows.filter(
      (r) => r.organizationId === organizationId && r.recordingId === recordingId
    ).length;
  }
}

// ── Stage 11F: Real-Time Speech Intelligence Event Bus & Latency Isolation ───

export class RealtimeIntelligenceStreamCoordinator {
  private sequenceCounter = 0;
  private readonly events: RealtimeIntelligenceEvent[] = [];
  private throttledOptionalWorkers = false;

  constructor(
    public readonly sessionId: string,
    private readonly asrP95BudgetOverheadRatio: number = 0.1
  ) {}

  public emitChunkEvents(params: {
    asrBaselineLatencyMs: number;
    chunkStartSample: number;
    chunkEndSample: number;
    partialText?: string;
    finalText?: string;
    speakerId?: string;
    enableOptionalIntelligence: boolean;
    simulatedOptionalWorkerLatencyMs?: number;
    simulateTranslationFailure?: boolean;
  }): {
    asrStreamAlive: true;
    throttledOptionalWorkers: boolean;
    emittedEvents: RealtimeIntelligenceEvent[];
  } {
    const startSec = Number((params.chunkStartSample / 16000).toFixed(3));
    const endSec = Number((params.chunkEndSample / 16000).toFixed(3));
    const batch: RealtimeIntelligenceEvent[] = [];

    const pushEvent = (
      eventType: RealtimeIntelligenceEvent['eventType'],
      mutable: boolean,
      sourceArtifactRef: string,
      payload: Record<string, unknown>
    ) => {
      this.sequenceCounter += 1;
      const ev: RealtimeIntelligenceEvent = {
        sessionId: this.sessionId,
        eventId: `rte_${crypto.randomUUID()}`,
        sequenceNumber: this.sequenceCounter,
        eventType,
        payloadVersion: '1.0',
        startSample: params.chunkStartSample,
        endSample: params.chunkEndSample,
        startSec,
        endSec,
        sourceArtifactRef,
        mutable,
        payload,
        createdAtIso: new Date().toISOString(),
      };
      this.events.push(ev);
      batch.push(ev);
    };

    // Priority 1: Core ASR transcript events always emit unblocked
    if (params.partialText) {
      pushEvent('transcript.partial', true, 'asr.transcription:hypothesis', { text: params.partialText });
    }
    if (params.finalText) {
      pushEvent('transcript.final', false, `asr.transcription:rev_${this.sequenceCounter + 1}`, {
        text: params.finalText,
        immutableRevision: this.sequenceCounter + 1,
      });
    }

    // Priority 2: Optional Real-Time Intelligence with strict latency isolation budget (§13.3)
    if (params.enableOptionalIntelligence) {
      const optLat = params.simulatedOptionalWorkerLatencyMs ?? 2;
      const maxAllowedOptLat = Math.max(10, params.asrBaselineLatencyMs * (1 + this.asrP95BudgetOverheadRatio) - params.asrBaselineLatencyMs);
      if (optLat > maxAllowedOptLat) {
        this.throttledOptionalWorkers = true;
        pushEvent('capability.failed', false, 'speech.realtime_backpressure', {
          reason: 'OPTIONAL_INTELLIGENCE_THROTTLED_FOR_ASR_LATENCY_ISOLATION',
          observedLatencyMs: optLat,
          asrCoreUnimpacted: true,
        });
        return {
          asrStreamAlive: true,
          throttledOptionalWorkers: true,
          emittedEvents: batch,
        };
      }

      this.throttledOptionalWorkers = false;
      if (params.speakerId) {
        pushEvent('speaker.detected', true, 'speech.diarization:live', { speaker_id: params.speakerId });
      }
      if (params.simulateTranslationFailure) {
        pushEvent('capability.failed', false, 'speech.translation:live', {
          capability_id: 'speech.translation',
          error_code: 'MODEL_EXECUTION_FAILED',
          isolatedFromAsrStream: true,
        });
      } else if (params.finalText) {
        pushEvent('translation.final', false, 'speech.translation:live', {
          targetLanguage: 'en',
          text: `[EN] ${params.finalText}`,
        });
        pushEvent('caption.updated', true, 'speech.subtitles:live', {
          text: params.finalText,
          startSec,
          endSec,
        });
      }
      pushEvent('analytics.updated', true, 'speech.conversation_analytics:live', {
        activeSpeakerId: params.speakerId ?? 'speaker_1',
        windowSec: Number((endSec - startSec).toFixed(3)),
      });
    }

    return {
      asrStreamAlive: true,
      throttledOptionalWorkers: this.throttledOptionalWorkers,
      emittedEvents: batch,
    };
  }

  public listOrderedEvents(): RealtimeIntelligenceEvent[] {
    return [...this.events];
  }
}
