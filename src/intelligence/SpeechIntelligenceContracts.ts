/**
 * PHASE 11 — SPEECH INTELLIGENCE PRODUCT SUITE, MULTIMODAL ANALYTICS & ENTERPRISE INTEGRATIONS
 * Pure TypeScript Contracts, Provenance, DAG Job States, Consent Governance & Capability Schemas.
 * (Zero Node.js runtime imports so frontend & backend safely share exact wire contracts.)
 */

export type SpeechCapabilityId =
  | 'asr.transcription'
  | 'speech.diarization'
  | 'speech.alignment'
  | 'speech.translation'
  | 'speech.subtitles'
  | 'speech.meeting_intelligence'
  | 'speech.conversation_analytics'
  | 'speech.semantic_indexing'
  | 'speech.structured_extraction';

export type CapabilityQualityStatus =
  | 'VERIFIED'
  | 'EXPERIMENTAL'
  | 'DEGRADED'
  | 'DISABLED'
  | 'UNSUPPORTED';

export type CapabilityAvailabilityStatus =
  | 'AVAILABLE_IN_G0_CPU'
  | 'REQUIRES_EXTERNAL_PROVIDER'
  | 'BLOCKED_BY_EXTERNAL_DEPENDENCY';

export type CapabilityImplementationStatus =
  | 'IMPLEMENTED_AND_VERIFIED'
  | 'IMPLEMENTED_BUT_UNVERIFIED'
  | 'PARTIALLY_IMPLEMENTED'
  | 'MOCKED_OR_SIMULATED'
  | 'DOCUMENTED_ONLY'
  | 'MISSING'
  | 'BLOCKED_BY_EXTERNAL_DEPENDENCY';

export type WorkerPoolId =
  | 'pool_asr_realtime'
  | 'pool_diarization'
  | 'pool_alignment'
  | 'pool_translation'
  | 'pool_nlp_intelligence'
  | 'pool_embeddings'
  | 'pool_analytics';

export interface CapabilityDescriptor {
  capabilityId: SpeechCapabilityId;
  capabilityVersion: string;
  displayName: string;
  modelId: string;
  modelVersion: string;
  supportedLanguages: Array<'fa' | 'en' | 'fa-en'>;
  supportedAudioFormats: Array<'pcm16' | 'wav' | 'mp3' | 'ogg'>;
  supportedProcessingModes: Array<'batch' | 'streaming'>;
  streamingSupport: boolean;
  batchSupport: boolean;
  maximumAudioDurationSec: number;
  maximumInputSizeBytes: number;
  resourceClass: 'cpu_light' | 'cpu_medium' | 'gpu_recommended' | 'external_api_optional';
  workerPool: WorkerPoolId;
  dependencies: SpeechCapabilityId[];
  qualityStatus: CapabilityQualityStatus;
  availabilityStatus: CapabilityAvailabilityStatus;
  implementationStatus: CapabilityImplementationStatus;
  licenseMetadata: string;
  dataResidencyConstraints: string[];
  unitCostMinorPerMinute: number;
}

export type IntelligenceJobLifecycleState =
  | 'ACCEPTED'
  | 'VALIDATING'
  | 'QUEUED'
  | 'RUNNING'
  | 'PARTIALLY_COMPLETED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export type SpeechIntelligenceErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'UNSUPPORTED_LANGUAGE'
  | 'INVALID_INPUT_ARTIFACT'
  | 'DEPENDENCY_NOT_COMPLETED'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'TENANT_QUOTA_EXCEEDED'
  | 'PROCESSING_TIMEOUT'
  | 'MODEL_EXECUTION_FAILED'
  | 'OUTPUT_VALIDATION_FAILED'
  | 'CONSENT_REQUIRED'
  | 'RETENTION_POLICY_BLOCKED'
  | 'BIOMETRIC_POLICY_VIOLATION';

export type SpeechArtifactType =
  | 'ORIGINAL_AUDIO'
  | 'ASR_HYPOTHESIS'
  | 'USER_CORRECTED_TRANSCRIPT'
  | 'APPROVED_TRANSCRIPT'
  | 'DIARIZATION'
  | 'ALIGNMENT'
  | 'TRANSLATION'
  | 'SUBTITLES'
  | 'MEETING_INTELLIGENCE'
  | 'CONVERSATION_ANALYTICS'
  | 'SEMANTIC_INDEX'
  | 'STRUCTURED_EXTRACTION';

export interface SpeechArtifactProvenance {
  sourceAudioArtifactId: string;
  sourceAudioVersion: number;
  sourceTranscriptArtifactId: string | null;
  sourceTranscriptVersion: number | null;
  dependencyArtifactIds: string[];
  capabilityId: SpeechCapabilityId;
  capabilityVersion: string;
  modelId: string;
  modelVersion: string;
  configurationHash: string;
  createdAtIso: string;
}

export interface SpeechArtifactRecord<TPayload = unknown> {
  artifactId: string;
  organizationId: string;
  projectId: string;
  recordingId: string;
  artifactType: SpeechArtifactType;
  artifactVersion: number;
  immutable: true;
  mediaType: string;
  language: 'fa' | 'en' | 'fa-en';
  contentSha256: string;
  retentionPolicyId: string;
  provenance: SpeechArtifactProvenance;
  payload: TPayload;
  deletedAtIso: string | null;
}

export interface GranularProcessingConsent {
  allowTranscribe: boolean;
  allowStoreTranscript: boolean;
  allowRetainAudio: boolean;
  allowDiarization: boolean;
  allowTranslation: boolean;
  allowMeetingIntelligence: boolean;
  allowAnalytics: boolean;
  allowEmbeddings: boolean;
  allowStructuredExtraction: boolean;
  allowRetainDerivedArtifacts: boolean;
  allowModelTraining: boolean;
  allowResearchPublication: boolean;
}

export interface IntelligenceCapabilityRequestItem {
  id: SpeechCapabilityId;
  version?: string;
  config?: Record<string, unknown>;
}

export interface CapabilityExecutionRecord {
  executionId: string;
  jobId: string;
  capabilityId: SpeechCapabilityId;
  capabilityVersion: string;
  workerPool: WorkerPoolId;
  modelId: string;
  modelVersion: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED_DEPENDENCY';
  configurationHash: string;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  durationMs: number;
  estimatedCostMinor: number;
  actualCostMinor: number;
  errorCode?: SpeechIntelligenceErrorCode;
  errorSafeMessage?: string;
  startedAtIso: string;
  completedAtIso: string | null;
}

export interface IntelligenceJobRecord {
  jobId: string;
  organizationId: string;
  projectId: string;
  recordingId: string;
  regionId: string;
  status: IntelligenceJobLifecycleState;
  stateHistory: Array<{ state: IntelligenceJobLifecycleState; timestampIso: string }>;
  requestedCapabilities: IntelligenceCapabilityRequestItem[];
  completedCapabilities: SpeechCapabilityId[];
  failedCapabilities: Array<{
    capabilityId: SpeechCapabilityId;
    errorCode: SpeechIntelligenceErrorCode;
    message: string;
  }>;
  executions: CapabilityExecutionRecord[];
  outputArtifactIds: string[];
  idempotencyKey: string | null;
  totalReservedCostMinor: number;
  totalActualCostMinor: number;
  currency: 'USD';
  createdAtIso: string;
  startedAtIso: string | null;
  completedAtIso: string | null;
}

// ── Diarization & Forced Alignment Contracts (Stage 11B) ─────────────────────

export interface AnonymousSpeakerSummary {
  speakerId: string; // Strictly anonymous local label e.g. speaker_1, speaker_2
  firstSeenAtSec: number;
  totalSpeakingSec: number;
}

export interface DiarizationSegment {
  segmentId: string;
  startSec: number;
  endSec: number;
  speakerId: string; // speaker_1 | speaker_2 | ... | UNKNOWN_SPEAKER
  confidence: number | null; // Null when uncalibrated
  overlap: boolean;
  competingSpeakerIds: string[];
  uncertain: boolean;
}

export interface DiarizationResultPayload {
  capability: 'speech.diarization';
  status: 'completed';
  recordingId: string;
  biometricIdentityClaimed: false;
  speakers: AnonymousSpeakerSummary[];
  segments: DiarizationSegment[];
  unassignedDurationSec: number;
  provenance: {
    modelId: string;
    modelVersion: string;
    adapterKind:
      | 'LOCAL_CPU_ENERGY_CROSSTALK'
      | 'TRANSCRIPT_SPEAKER_HINTS_ONLY'
      | 'NO_MODEL_UNKNOWN_FALLBACK'
      | 'LOCAL_CPU_ONNX_EMBEDDING_AHC';
  };
}

export interface AlignedWordItem {
  wordId: string;
  originalToken: string;
  normalizedToken: string;
  startSec: number | null;
  endSec: number | null;
  alignmentStatus: 'ALIGNED' | 'UNALIGNED';
  confidence: number | null;
  speakerId?: string;
  sourceTranscriptVersion: number;
  unalignedReason?: string;
}

export interface AlignmentResultPayload {
  capability: 'speech.alignment';
  status: 'completed';
  recordingId: string;
  sourceTranscriptArtifactId: string;
  sourceTranscriptVersion: number;
  alignedCount: number;
  unalignedCount: number;
  words: AlignedWordItem[];
  provenance: { modelId: string; modelVersion: string; algorithm: 'CTC_VITERBI_OR_ENERGY_SNAP' };
}

// ── Translation & Subtitles Contracts (Stage 11C) ────────────────────────────

export interface TranslatedSegmentItem {
  sourceSegmentIds: string[];
  sourceLanguage: 'fa' | 'en' | 'fa-en';
  targetLanguage: 'fa' | 'en';
  sourceText: string;
  translatedText: string;
  startSec: number;
  endSec: number;
  speakerId?: string;
  preservedNumbers: string[];
  negationPreserved: boolean;
  translationModelVersion: string;
  qualityStatus: 'LOCAL_RULE_VERIFIED' | 'EXTERNAL_MT_REQUIRED';
}

export interface TranslationResultPayload {
  capability: 'speech.translation';
  mode: 'segment_aligned' | 'full_context';
  sourceTranscriptArtifactId: string;
  sourceTranscriptVersion: number;
  targetLanguage: 'fa' | 'en';
  adapterStatus: 'AVAILABLE_IN_G0_CPU' | 'BLOCKED_BY_EXTERNAL_DEPENDENCY';
  segments: TranslatedSegmentItem[];
  fullTranslatedText: string;
  unmodifiedSourcePreserved: true;
}

export interface SubtitleCueItem {
  cueIndex: number;
  startSec: number;
  endSec: number;
  speakerLabel?: string;
  primaryText: string;
  translationText?: string;
  cps: number;
  lineCount: number;
}

export interface SubtitleResultPayload {
  capability: 'speech.subtitles';
  format: 'srt' | 'vtt' | 'json' | 'txt';
  level: 'sentence' | 'word';
  cues: SubtitleCueItem[];
  exports: Partial<Record<'srt' | 'vtt' | 'json' | 'txt', string>>;
  validation: {
    valid: boolean;
    warnings: string[];
    maxObservedCps: number;
    hasNegativeTimestamps: boolean;
    hasOverlaps: boolean;
    logicalBidiOrderPreserved: true;
  };
}

// ── Meeting Intelligence, Analytics, Extraction & Search (Stages 11D–11E) ────

export type EpistemicObservationClass =
  | 'DIRECTLY_OBSERVED'
  | 'MODEL_GENERATED_INTERPRETATION'
  | 'LOW_CONFIDENCE_INFERENCE'
  | 'UNAVAILABLE';

export interface EvidenceReference {
  segmentId: string;
  startSec: number;
  endSec: number;
  excerpt: string;
}

export interface EvidenceLinkedStatement {
  text: string;
  observationClass: EpistemicObservationClass;
  evidence: EvidenceReference[];
  requiresHumanReview: boolean;
}

export interface ActionItemRecord {
  description: string;
  assigneeStatus: 'attributed' | 'unknown';
  responsibleSpeakerId: string | null;
  dueDateStatus: 'explicit' | 'ambiguous' | 'none';
  dueDateRawText: string | null;
  status: 'proposed' | 'confirmed' | 'uncertain';
  evidence: EvidenceReference[];
  requiresHumanReview: boolean;
}

export interface MeetingIntelligencePayload {
  capability: 'speech.meeting_intelligence';
  recordingId: string;
  authoritativeRecord: false;
  requiresCustomerReview: true;
  promptInjectionAttemptsNeutralized: number;
  summary: EvidenceLinkedStatement[];
  keyTopics: string[];
  decisions: EvidenceLinkedStatement[];
  actionItems: ActionItemRecord[];
  openQuestions: EvidenceLinkedStatement[];
  unresolvedIssues: EvidenceLinkedStatement[];
  namedEntities: Array<{ text: string; type: string; evidence: EvidenceReference[] }>;
  hallucinationCheck: {
    allClaimsSupportedByEvidence: boolean;
    unsupportedStatementsRemoved: number;
    citationCoverageRate: number;
  };
}

export interface ConversationMetricDescriptor {
  metricId: string;
  label: string;
  value: number | Record<string, number>;
  unit: string;
  definition: string;
  calculationMethod: string;
  inputArtifacts: string[];
  validityStatus: 'VERIFIED' | 'HEURISTIC_OPERATIONAL_ONLY';
  knownLimitations: string[];
}

export interface ConversationAnalyticsPayload {
  capability: 'speech.conversation_analytics';
  recordingId: string;
  psychologicalOrBiometricInferencesAllowed: false;
  metrics: ConversationMetricDescriptor[];
  speakerMetrics: Array<{
    speakerId: string;
    speakingDurationSec: number;
    turnCount: number;
    averageTurnDurationSec: number;
  }>;
  totalDurationSec: number;
  silenceDurationSec: number;
  overlapDurationSec: number;
  interruptionLikeOverlapHeuristicCount: number;
  questionCount: number;
  speechToSilenceRatio: number;
  transcriptCompletenessRatio: number;
}

export interface ExtractedStructuredItem {
  fieldType:
    | 'DATE'
    | 'TIME'
    | 'NUMBER'
    | 'CURRENCY'
    | 'PRODUCT'
    | 'PROJECT'
    | 'LOCATION'
    | 'TECH_TERM'
    | 'CONTRACT_REF'
    | 'COMMITMENT'
    | 'QUESTION';
  extractedValue: string | number | null;
  originalTextSpan: string;
  sourceSegmentIds: string[];
  startSec: number;
  endSec: number;
  extractionModelVersion: string;
  validationStatus: 'VALID' | 'AMBIGUOUS' | 'REQUIRES_REVIEW' | 'UNKNOWN';
  reviewStatus: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
}

export interface StructuredExtractionPayload {
  capability: 'speech.structured_extraction';
  recordingId: string;
  items: ExtractedStructuredItem[];
  ambiguousOrReviewCount: number;
}

export interface SemanticSearchResultItem {
  recordingId: string;
  segmentId: string;
  transcriptText: string;
  startSec: number;
  endSec: number;
  speakerId?: string;
  language: 'fa' | 'en' | 'fa-en';
  similarityScore: number;
  similarityNotice: 'RETRIEVAL_SCORE_NOT_FACTUAL_CONFIDENCE';
  retrievalMethod: 'EXACT_SUBSTRING' | 'PHRASE' | 'SEMANTIC_EMBEDDING_LOCAL';
  transcriptVersion: number;
  organizationId: string;
  projectId: string;
}

// ── Real-Time Speech Intelligence Events (Stage 11F) ─────────────────────────

export type RealtimeIntelligenceEventType =
  | 'transcript.partial'
  | 'transcript.final'
  | 'speaker.detected'
  | 'speaker.assignment.updated'
  | 'translation.partial'
  | 'translation.final'
  | 'caption.updated'
  | 'analytics.updated'
  | 'capability.completed'
  | 'capability.failed';

export interface RealtimeIntelligenceEvent {
  sessionId: string;
  eventId: string;
  sequenceNumber: number;
  eventType: RealtimeIntelligenceEventType;
  payloadVersion: '1.0';
  startSample: number;
  endSample: number;
  startSec: number;
  endSec: number;
  sourceArtifactRef: string;
  mutable: boolean;
  payload: Record<string, unknown>;
  createdAtIso: string;
}

// ── Enterprise Integrations (Stage 11G) ──────────────────────────────────────

export type EnterpriseConnectorKind =
  | 'OBJECT_STORAGE_S3'
  | 'OBJECT_STORAGE_GCS'
  | 'OBJECT_STORAGE_AZURE_BLOB'
  | 'OBJECT_STORAGE_CUSTOMER_MANAGED'
  | 'EVENT_KAFKA'
  | 'EVENT_QUEUE'
  | 'OIDC_SSO'
  | 'SAML2_SSO'
  | 'SCIM_PROVISIONING'
  | 'KMS_CMEK';

export interface EnterpriseConnectorRecord {
  connectorId: string;
  organizationId: string;
  projectId: string;
  kind: EnterpriseConnectorKind;
  name: string;
  configSummary: Record<string, string | boolean>;
  status: 'ACTIVE_LOCAL_TEST_ADAPTER' | 'BLOCKED_BY_EXTERNAL_DEPENDENCY' | 'DISABLED';
  isLiveProductionVerified: false;
  blockerReason: string | null;
  createdAtIso: string;
  updatedAtIso: string;
}
