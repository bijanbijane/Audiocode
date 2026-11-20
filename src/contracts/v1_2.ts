/**
 * Draft Technical Contracts — Architecture Specification v1.2
 * Local-First Persian Smart Audio Editing & Processing Platform
 */

export const FLICKS_PER_SECOND = 705_600_000 as const;

export const SUPPORTED_SAMPLE_RATES = [
  16_000,
  22_050,
  24_000,
  32_000,
  44_100,
  48_000,
] as const;

export type StandardSampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];

/** Half-open canonical interval [startFlicks, endFlicks) */
export interface FlickRange {
  readonly startFlicks: number;
  readonly endFlicks: number;
}

export type ChannelLayout = 'mono' | 'stereo';
export type SampleFormat = 'f32-planar' | 'f32-interleaved';

export interface VersionMetadata {
  projectSchemaVersion: string;
  audioEngineVersion: string;
  processingNodeVersion: string;
  modelVersion: string;
}

export interface SeekTableEntry {
  blockIndex: number;
  startSample: number;
  sampleCount: number;
  byteOffset: number;
  byteLength: number;
}

export interface PeakLevel {
  samplesPerBin: number;
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

export interface PeakPyramid {
  assetId: string;
  sampleRate: number;
  totalSamples: number;
  levels: PeakLevel[];
}

export interface AcousticProfile {
  assetId: string;
  noiseFloorDbfs: number;
  roomToneRms: number;
  /** Short 1-second representative ambient segment for natural Room Tone synthesis/fill */
  roomToneSample: Float32Array;
  sampleRate: number;
}

export type AssetStorageLifecycleState =
  | 'ingesting'
  | 'finalizing'
  | 'ready'
  | 'abandoned'
  | 'failed';

export interface PersistedAudioAssetManifest {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSizeBytes: number;
  readonly contentSha256: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly totalSamples: number;
  readonly blockSizeSamples: number;
  readonly totalBlocks: number;
  readonly bytesPerSample: number;
  readonly state: AssetStorageLifecycleState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly finalizedAtMs: number | null;
  readonly errorMessage?: string;
}

export interface AudioAsset {
  id: string;
  name: string;
  contentHash: string;
  partialFingerprint: string;
  contentVersion: number;
  fileSizeBytes: number;
  container: 'wav' | 'mp3' | 'ogg' | 'webm' | 'synthetic-pcm';
  codec: string;
  nativeSampleRate: number;
  channelLayout: ChannelLayout;
  exactSampleCount: number;
  durationFlicks: number;
  importTimestamp: number;
  validationStatus: 'verified' | 'partial-frames-skipped' | 'invalid';
  seekTable: SeekTableEntry[];
  peakPyramid: PeakPyramid;
  acousticProfile: AcousticProfile;
  storageLifecycle?: AssetStorageLifecycleState;
  storageBackend?: string;
  blockSizeSamples?: number;
}

export type ClipKind = 'speech' | 'room-tone-fill';

export interface TimelineClip {
  id: string;
  assetId: string;
  trackId: string;
  kind: ClipKind;
  /** Position on the canonical timeline [timelineStartFlicks, timelineEndFlicks) */
  timelineRange: FlickRange;
  /** Source offset inside the asset in canonical flicks */
  sourceStartFlicks: number;
  /** Micro-crossfade duration in milliseconds applied at boundaries */
  fadeInMs: number;
  fadeOutMs: number;
  gainDb: number;
  muted: boolean;
}

export interface Track {
  id: string;
  name: string;
  speakerLabel: string;
  syncGroupId: string | null;
  muted: boolean;
  solo: boolean;
  gainDb: number;
  pan: number;
  clips: TimelineClip[];
}

export type EditOperationType =
  | 'split'
  | 'trim'
  | 'move'
  | 'sync-locked-ripple-cut'
  | 'in-place-room-tone-suppression'
  | 'dsp-parameter-change'
  | 'restore-clip';

export interface EditTransaction {
  operationId: string;
  coalescingKey: string;
  projectVersion: number;
  type: EditOperationType;
  description: string;
  timestamp: number;
  beforeTracks: Track[];
  afterTracks: Track[];
  beforeTokens?: PersianWordToken[];
  afterTokens?: PersianWordToken[];
  beforeRecommendations?: SmartRecommendation[];
  afterRecommendations?: SmartRecommendation[];
  beforeDsp?: EphemeralDspParams;
  afterDsp?: EphemeralDspParams;
  beforePcmSources?: Record<string, Float32Array>;
  afterPcmSources?: Record<string, Float32Array>;
  beforeAssets?: Record<string, AudioAsset>;
  afterAssets?: Record<string, AudioAsset>;
  beforeEqResponseCurveDb?: { freqHz: number; gainDb: number }[] | null;
  afterEqResponseCurveDb?: { freqHz: number; gainDb: number }[] | null;
  affectedRecommendationId?: string;
  commitStatus: 'committed' | 'reverted';
}

export interface EphemeralDspParams {
  highPassHz: number;
  compressorThresholdDb: number;
  compressorRatio: number;
  noiseGateThresholdDb: number;
  masterGainDb: number;
}

export type RecommendationKind =
  | 'long-pause'
  | 'co-articulated-filler'
  | 'standalone-filler'
  | 'repetition'
  | 'crosstalk-bleed';

export type RecommendationActionMode =
  | 'sync-locked-ripple-cut'
  | 'in-place-room-tone-suppression';

export type RecommendationStatus =
  | 'Pending'
  | 'Accepted'
  | 'Rejected'
  | 'Modified'
  | 'Superseded'
  | 'Invalidated';

export interface ProsodicBoundaryDetail {
  rawRange: FlickRange;
  snappedRange: FlickRange;
  rmsValleyShiftMs: number;
  zeroCrossingAdjusted: boolean;
  microCrossfadeMs: number;
  pitchPlateauDetected: boolean;
  trailingEzafeRisk: boolean;
  trailingEzafeWord?: string;
  reasonFa: string;
}

export interface SmartRecommendation {
  id: string;
  trackId: string;
  kind: RecommendationKind;
  recommendedMode: RecommendationActionMode;
  syncProtectedReason?: string;
  range: FlickRange;
  relatedText: string;
  reasonFa: string;
  confidence: number;
  sourceTier: 'Group-A-DSP' | 'Group-B-Persian-ASR';
  status: RecommendationStatus;
  boundary: ProsodicBoundaryDetail;
}

export interface PersianWordToken {
  id: string;
  trackId: string;
  speakerName: string;
  originalText: string;
  normalizedText: string;
  displayText: string;
  range: FlickRange;
  confidence: number;
  alignmentSource: 'ASR' | 'ForcedAlignment' | 'AcousticSnap';
  hasTrailingEzafeRisk?: boolean;
  isDisfluency?: boolean;
  isStretchedVowel?: boolean;
  isCrosstalkSuppressed?: boolean;
  /** Detected word language in trilingual Persian/English/Arabic code-switched speech */
  detectedLanguage?: 'FA' | 'EN' | 'AR';
  canonicalLatinForm?: string;
  canonicalPersianForm?: string;
  canonicalArabicForm?: string;
  /** Platt-scaled calibrated empirical confidence score */
  calibratedConfidence?: number;
  /** ElevenLabs Scribe v3: 20ms CTC Viterbi character-level timestamp spans */
  characterSpans?: {
    readonly char: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly confidence: number;
  }[];
  /** ElevenLabs Scribe v3: Inline non-verbal audio event tag attached to or preceding token */
  audioEventTag?: 'BREATH' | 'COUGH_THROAT' | 'LAUGHTER' | 'MUSIC_JINGLE' | 'LONG_PAUSE';
  /** ROVER 3-Model Consensus agreement ratio (Scribe v3 + GPT-Transcribe + Nova-3) */
  roverAgreementRatio?: number;
  /** N-Best Word Confusion Network alternatives with posterior probabilities */
  nBestAlternatives?: {
    readonly word: string;
    readonly posteriorProb: number;
  }[];
  /** Deepgram Nova-3 & GPT-Transcribe: Whether this token was boosted/verified via Keyterm Prompting Trie */
  keytermBoosted?: boolean;
  /** OpenAI gpt-live-transcribe: Syntactic & prosodic utterance endpoint state */
  syntacticEndpointState?:
    | 'COMPLETE_VERB_OR_CLAUSE'
    | 'NEUTRAL_NOMINAL'
    | 'INCOMPLETE_CONJUNCTION_OR_PREP';
  /** Distinguishes real model/CTC timestamps from proportionally distributed approximations */
  alignmentPrecision?:
    | 'model_timestamps'
    | 'ctc_frame_aligned'
    | 'distributed_segment'
    | 'forced_aligned';
  rawPreserved?: boolean;
}

export interface ProcessingNodeDescriptor {
  id: string;
  name: string;
  labelFa: string;
  kind: 'source' | 'eq' | 'gate' | 'compressor' | 'delay-compensation' | 'bus-mix' | 'limiter';
  executionMode: 'Real-Time' | 'Offline' | 'Preview';
  chunkSafe: boolean;
  latencySamples: number;
  preRollSamples: number;
  tailSamples: number;
  bypassed: boolean;
}

export interface ProcessingGraphEdge {
  fromNodeId: string;
  toNodeId: string;
}

export interface PdcBranchCompensation {
  branchRootNodeId: string;
  pathLatencySamples: number;
  maxBusLatencySamples: number;
  insertedDelaySamples: number;
}

export interface PdcPlan {
  isValidDag: boolean;
  topologicalOrder: string[];
  totalGraphLatencySamples: number;
  totalPreRollSamples: number;
  totalTailSamples: number;
  branchCompensations: PdcBranchCompensation[];
}

export interface RollingCacheStats {
  maxBytes: number;
  usedBytes: number;
  cachedBlocks: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface FileHandleLease {
  leaseId: string;
  fileKey: string;
  ownerWorker: 'io-broker' | 'playback-feeder' | 'ai-worker' | 'render-worker';
  mode: 'read-buffered' | 'exclusive-broker';
  acquiredAt: number;
  status: 'active' | 'released';
}

export interface StorageBrokerTelemetry {
  opfsSupported: boolean;
  syncAccessHandleSupported: boolean;
  persistentStorageGranted: boolean | null;
  quotaUsedBytes: number | null;
  quotaTotalBytes: number | null;
  activeLeases: FileHandleLease[];
  lockConflictsPrevented: number;
  cacheStats: RollingCacheStats;
  persistenceAvailable?: boolean;
  persistenceStatus?: 'OPFS-SyncAccessHandle' | 'OPFS-Writable' | 'OPFS-Unavailable' | 'Disposed';
  workerCacheStats?: RollingCacheStats | null;
  totalAudioCacheBudgetBytes?: number;
  disposed?: boolean;
  recoveredAssetCount?: number;
  cleanedAbandonedCount?: number;
}

export interface RuntimeCapabilities {
  crossOriginIsolated: boolean;
  sharedArrayBufferSupported: boolean;
  transportMode: 'SharedArrayBuffer' | 'MessagePort-Fallback';
  audioWorkletSupported: boolean;
  webGpuSupported: boolean;
  gpuFallbackMode: 'WebGPU-Sliced' | 'WASM-SIMD-CPU';
  opfsSupported: boolean;
  hardwareConcurrency: number;
  deviceTier: 'Desktop Studio' | 'Tablet Studio' | 'Mobile Companion';
}

export interface ExportValidationReport {
  readable: boolean;
  structurallyValid?: boolean;
  invalidSampleCount?: number;
  durationSeconds: number;
  channelCount: number;
  sampleRate: number;
  bitDepth: number;
  clippedSampleCount: number;
  truePeakDbfs: number;
  integratedLufs: number;
  headTailFadeValid: boolean;
  passed: boolean;
  fileSizeBytes: number;
}
