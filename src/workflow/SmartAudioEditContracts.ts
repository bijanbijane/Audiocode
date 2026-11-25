/**
 * AVAPARDAZ — UNIFIED SMART AUDIO EDITOR PIPELINE CONTRACTS (AVP-SE-001)
 *
 * Canonical interfaces chaining Engine 01 (Shahab ASR), Engine 02 (Smart Edit Decision),
 * and Engine 03 (Precision Audio Renderer & Preview) across Web App, Local Companion,
 * and Adobe Audition CEP Plugin.
 */

import type { SampleRate } from '../contracts/timebase.contract';
import type { SpeechEventAnalysisResult } from '../ai-engine/speech-events/SpeechEventEngine';
import type {
  SpeechAnalysisThresholdConfig,
  SpeechEditSensitivityPreset,
} from '../ai-engine/speech-events/SpeechEventContracts';
import type { PersianFillerLexiconEntry } from '../ai-engine/PersianDisfluencyEngine';
import type {
  EditDecisionListSnapshot,
  EditProposal,
} from '../ai-engine/edit-decision/EditDecisionTypes';
import type {
  AudioRenderConfig,
  AudioRenderResult,
  ChunkedPcmSource,
} from '../audio-renderer/AudioRenderTypes';

export type SmartAudioEditStage =
  | 'IMPORT_AUDIO'
  | 'LOCAL_AUDIO_NORMALIZATION'
  | 'ENGINE_01_SHAHAB_ASR'
  | 'WORD_LEVEL_TIMECODE_ALIGNMENT'
  | 'ENGINE_02_SMART_EDIT_DECISION'
  | 'EDL_GENERATION'
  | 'USER_REVIEW_AND_APPROVAL'
  | 'ENGINE_03_AUDIO_RENDERER'
  | 'PREVIEW_GENERATION'
  | 'FINAL_AUDIO_EXPORT';

export interface TranscriptToken {
  readonly tokenId: string;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly confidence: number | null;
  readonly timestampGranularity: 'WORD' | 'SEGMENT_ESTIMATED';
}

export interface TranscriptDocument {
  readonly schemaVersion: 'avp.transcript.v1';
  readonly transcriptVersion: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sampleRate: number;
  readonly totalSourceSamples: number;
  readonly language: 'fa' | 'en' | 'fa-en';
  readonly modelId: string;
  readonly modelVersion: string;
  readonly runtime: 'shahab-zipformer-onnx-cpu' | 'sherpa-onnx-cpu' | 'browser-onnx-web';
  /** Verbatim ASR output — Engine 01 NEVER deletes fillers or repetitions */
  readonly rawText: string;
  readonly normalizedText: string;
  readonly tokens: readonly TranscriptToken[];
  readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'TOKEN' | 'NONE';
  readonly realTimeFactor: number;
  readonly processingTimeMs: number;
  readonly offlineVerified: true;
  readonly createdAtMs: number;
}

export interface ShahabAsrRuntimeMetrics {
  readonly modelId: string;
  readonly upstreamModelId: string;
  readonly runtime: 'shahab-zipformer-onnx-cpu' | 'sherpa-onnx-cpu' | 'browser-onnx-web';
  readonly durationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly rssBeforeMb: number;
  readonly rssAfterMb: number;
  readonly peakRssMb: number;
  readonly tokenCount: number;
  readonly offlineVerified: true;
}

export interface ShahabTranscribeRequest {
  readonly sourceAudioId: string;
  readonly sourceAudioHash?: string;
  readonly sourceSampleRate?: number;
  readonly totalSourceSamples?: number;
  readonly audioBytes?: Buffer;
  readonly audioFilePath?: string;
  /** Optional pre-canonicalized 16 kHz mono Float32 PCM from ENGINE 01 to avoid redundant decoding/resampling drift */
  readonly canonicalPcm16kMono?: Float32Array;
  readonly filename?: string;
  /** Optional authenticated owner/project scope for tenant-isolated encoder cache keys */
  readonly ownerId?: string;
  readonly projectId?: string;
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly maxChunkDurationSec?: number;
  readonly overlapSec?: number;
  readonly numThreads?: number;
  readonly unloadAfterTranscribe?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly percent: number;
    readonly currentChunk: number;
    readonly totalChunks: number;
    readonly elapsedMs: number;
    readonly partialText: string;
  }) => void;
}

export interface ShahabAsrEngine {
  transcribe(request: ShahabTranscribeRequest): Promise<{
    readonly transcript: TranscriptDocument;
    readonly metrics: ShahabAsrRuntimeMetrics;
  }>;
  unload(): { readonly unloaded: boolean; readonly rssMb: number };
}

export interface SmartEditAnalysisRequest {
  readonly projectId: string;
  readonly trackId?: string;
  readonly transcript: TranscriptDocument;
  readonly pcmMonoForAcousticAnalysis: Float32Array;
  readonly analysisSampleRate: SampleRate;
  readonly channelLayout?: 'mono' | 'stereo';
  readonly thresholdConfig?: SpeechAnalysisThresholdConfig;
  readonly sensitivityPreset?: SpeechEditSensitivityPreset;
  readonly customFillerLexicon?: readonly PersianFillerLexiconEntry[];
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}

export interface SmartEditAnalysisResult {
  readonly speechEvents: SpeechEventAnalysisResult;
  readonly edl: EditDecisionListSnapshot;
  readonly proposalSummary: {
    readonly total: number;
    readonly fillers: number;
    readonly pauses: number;
    readonly repetitions: number;
    readonly lowRiskCount: number;
    readonly reviewOnlyCount: number;
    readonly estimatedRemovedSec: number;
  };
}

export interface SmartEditDecisionEngine {
  analyzeAndGenerateEdl(request: SmartEditAnalysisRequest): Promise<SmartEditAnalysisResult>;
}

export type SmartEditPreviewMode = 'ORIGINAL' | 'EDITED' | 'FULL';

export interface SmartEditPreviewRequest {
  readonly mode: SmartEditPreviewMode;
  readonly source: ChunkedPcmSource;
  readonly edl: EditDecisionListSnapshot;
  /** Required for ORIGINAL or EDITED single-proposal A/B comparison; ignored for FULL */
  readonly proposalId?: string;
  /** Context padding around proposal in milliseconds (default 1500ms) */
  readonly contextPaddingMs?: number;
  readonly crossfadeMs?: number;
  readonly encoding?: 'pcm16' | 'pcm24';
  readonly abortSignal?: AbortSignal;
}

export interface SmartEditPreviewResult {
  readonly ok: boolean;
  readonly mode: SmartEditPreviewMode;
  readonly proposalId: string | null;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly durationSec: number;
  readonly totalSamples: number;
  readonly wavBytes: Uint8Array;
  readonly windowStartSample: number;
  readonly windowEndSample: number;
  readonly appliedProposalIds: readonly string[];
  readonly failureReason?: string;
}

export interface PrecisionAudioRenderer {
  renderFinalAudio(params: {
    readonly edl: EditDecisionListSnapshot;
    readonly source: ChunkedPcmSource;
    readonly config?: Partial<AudioRenderConfig>;
    readonly proposalIds?: readonly string[];
    readonly abortSignal?: AbortSignal;
    readonly onProgress?: (progress: { readonly percent: number | null; readonly operation: string }) => void;
  }): Promise<AudioRenderResult>;
  generatePreview(request: SmartEditPreviewRequest): Promise<SmartEditPreviewResult>;
}

export interface SmartAudioEditStageTrace {
  readonly stage: SmartAudioEditStage;
  readonly status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  readonly durationMs: number;
  readonly detail: string;
}

export interface SmartAudioEditSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly trackId: string;
  readonly filename: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sourceSampleRate: SampleRate;
  readonly sourceChannels: number;
  readonly totalSourceSamples: number;
  readonly sourceDurationSec: number;
  readonly transcript: TranscriptDocument | null;
  readonly asrMetrics: ShahabAsrRuntimeMetrics | null;
  readonly speechEvents: SpeechEventAnalysisResult | null;
  readonly edl: EditDecisionListSnapshot | null;
  readonly edlHistory: readonly EditDecisionListSnapshot[];
  readonly edlHistoryIndex: number;
  readonly lastRenderResult: AudioRenderResult | null;
  readonly stageTrace: readonly SmartAudioEditStageTrace[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface BatchLowRiskApprovalResult {
  readonly ok: boolean;
  readonly snapshot: EditDecisionListSnapshot;
  readonly approvedProposalIds: readonly string[];
  readonly skippedProposalIds: readonly string[];
  readonly reasonFa: string;
}

export function summarizeEdlProposals(edl: EditDecisionListSnapshot): {
  readonly total: number;
  readonly fillers: number;
  readonly pauses: number;
  readonly repetitions: number;
  readonly lowRiskCount: number;
  readonly reviewOnlyCount: number;
  readonly estimatedRemovedSec: number;
} {
  let fillers = 0;
  let pauses = 0;
  let repetitions = 0;
  let lowRiskCount = 0;
  let reviewOnlyCount = 0;
  let removedSamples = 0;

  for (const p of edl.proposals) {
    if (p.operation === 'REMOVE_FILLER') fillers++;
    else if (p.operation === 'SHORTEN_SILENCE') pauses++;
    else if (p.operation === 'REMOVE_ACCIDENTAL_REPETITION') repetitions++;
    else reviewOnlyCount++;

    if (
      p.validationStatus === 'VALID' &&
      !p.protectedEvent &&
      p.conflictIds.length === 0 &&
      p.risk.overallLevel === 'LOW' &&
      (p.operation === 'REMOVE_FILLER' ||
        p.operation === 'SHORTEN_SILENCE' ||
        p.operation === 'REMOVE_ACCIDENTAL_REPETITION')
    ) {
      lowRiskCount++;
    }

    if (
      p.originalRange &&
      p.proposedRange &&
      (p.operation === 'REMOVE_FILLER' ||
        p.operation === 'SHORTEN_SILENCE' ||
        p.operation === 'REMOVE_ACCIDENTAL_REPETITION')
    ) {
      const origLen = p.originalRange.endSample - p.originalRange.startSample;
      const keptLen =
        p.operation === 'SHORTEN_SILENCE'
          ? Math.max(0, origLen - (p.proposedRange.endSample - p.proposedRange.startSample))
          : 0;
      removedSamples += Math.max(0, origLen - keptLen);
    }
  }

  return {
    total: edl.proposals.length,
    fillers,
    pauses,
    repetitions,
    lowRiskCount,
    reviewOnlyCount,
    estimatedRemovedSec:
      edl.sampleRate > 0 ? Number((removedSamples / edl.sampleRate).toFixed(2)) : 0,
  };
}

export function isProposalLowRiskApprovable(p: EditProposal): boolean {
  return (
    p.validationStatus === 'VALID' &&
    !p.protectedEvent &&
    p.conflictIds.length === 0 &&
    p.risk.overallLevel === 'LOW' &&
    (p.status === 'PROPOSED' || p.status === 'NEEDS_REVIEW') &&
    (p.operation === 'REMOVE_FILLER' ||
      p.operation === 'SHORTEN_SILENCE' ||
      p.operation === 'REMOVE_ACCIDENTAL_REPETITION')
  );
}
