/**
 * AVAPARDAZ — AUTHORITATIVE PROCESSING CAPABILITY REGISTRY & DISPATCHER
 *
 * Compliant with AVP-ARCH-001 (Version 4.0) INV-001..INV-005 & Sections 5–7:
 * - One authoritative logical definition per capability.
 * - Delegates directly to existing Processing Core engines (SpeechEventEngine,
 *   EditDecisionEngine, CoreAudioIngestion, UnifiedProcessingOrchestrator) — zero duplication.
 * - Strictly enforces LOCAL_ONLY vs CLOUD_ONLY routing with zero silent Local-to-Cloud fallback.
 */

import { ingestAudioBufferToCanonical16kMono } from '../../asr-core/CoreAudioIngestion';
import { SpeechEventEngine } from '../../ai-engine/speech-events';
import { PersianTextNormalizer, TimedPersianToken } from '../../ai-engine/PersianTextNormalizer';
import { EditDecisionEngine } from '../../ai-engine/edit-decision';
import { SampleRate, TimeMath } from '../../contracts/timebase.contract';
import {
  ExecutionMode,
  transportSafeAudioInputToUint8Array,
  UNIFIED_PROCESSING_CONFIG_VERSION,
  UNIFIED_PROCESSING_CONTRACT_VERSION,
  UnifiedProcessingError,
  UnifiedProcessingRequest,
} from '../UnifiedProcessingContract';
import { UnifiedProcessingOrchestrator } from '../UnifiedProcessingOrchestrator';
import {
  AudioQualityAnalysisInput,
  AudioQualityAnalysisOutput,
  CANONICAL_OPERATION_VERSION,
  CanonicalCapabilityId,
  CanonicalOperationEnvelope,
  CanonicalOperationResult,
  CapabilityDescriptor,
  FillerDetectionOutput,
  IntelligentEditingInput,
  IntelligentEditingOutput,
  RepetitionDetectionOutput,
  SilenceDetectionOutput,
  SpeechEventCapabilityInput,
  SpeechTranscriptionInput,
  SpeechTranscriptionOutput,
  TimedWordInput,
  validateCanonicalOperationEnvelope,
} from './CanonicalCapabilityContracts';

const SUPPORTED_SAMPLE_RATES = new Set<number>([16000, 22050, 24000, 32000, 44100, 48000, 96000]);

function coerceSampleRate(rate: number | undefined): SampleRate {
  if (rate !== undefined && SUPPORTED_SAMPLE_RATES.has(rate)) {
    return rate as SampleRate;
  }
  return 16000;
}

function toTimedPersianTokens(tokens?: readonly TimedWordInput[]): TimedPersianToken[] {
  if (!tokens || tokens.length === 0) return [];
  return tokens.map((t) =>
    PersianTextNormalizer.createToken({
      tokenId: t.id,
      trackId: t.track_id,
      originalText: t.original_text,
      startFlicks: TimeMath.secondsToFlicks(Math.max(0, t.start_sec)),
      endFlicks: TimeMath.secondsToFlicks(Math.max(t.start_sec + 0.02, t.end_sec)),
      confidence: typeof t.confidence === 'number' ? t.confidence : 0.9,
    }),
  );
}

function decodeAudioToCanonicalPcm16k(
  audio: SpeechEventCapabilityInput['audio'],
  executionMode: ExecutionMode,
): {
  pcm16k: Float32Array;
  durationSec: number;
  sha256: string;
  ingestResult: ReturnType<typeof ingestAudioBufferToCanonical16kMono>;
} {
  if (!audio) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode,
      detailEn: 'Audio payload is required for acoustic signal analysis.',
    });
  }
  const bytes = transportSafeAudioInputToUint8Array(audio);
  const rawBuffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const ingestResult = ingestAudioBufferToCanonical16kMono({
      filename: audio.metadata.filename,
      rawBytes: rawBuffer,
      rawPcm16Hint: audio.encoding === 'BASE64_PCM16_16K_MONO',
    });
    return {
      pcm16k: ingestResult.canonicalFloat32,
      durationSec: ingestResult.durationSec,
      sha256: ingestResult.audioSha256,
      ingestResult,
    };
  } catch (err) {
    throw new UnifiedProcessingError({
      code: 'UNSUPPORTED_AUDIO_FORMAT',
      executionMode,
      detailEn: err instanceof Error ? err.message : String(err),
    });
  }
}

export class ProcessingCapabilityRegistry {
  private readonly orchestrator: UnifiedProcessingOrchestrator;

  constructor(orchestrator?: UnifiedProcessingOrchestrator) {
    this.orchestrator = orchestrator ?? new UnifiedProcessingOrchestrator();
  }

  public getOrchestrator(): UnifiedProcessingOrchestrator {
    return this.orchestrator;
  }

  public async listCapabilities(): Promise<readonly CapabilityDescriptor[]> {
    const unified = await this.orchestrator.discoverCapabilities();
    const localAsrAvailable = unified.localCapabilities.some((c) => c.availability === 'AVAILABLE_NOW')
      ? 'AVAILABLE_NOW'
      : 'MISSING_REQUIRED_RUNTIME';
    const cloudAsrStatus =
      unified.cloudCapabilities[0]?.availability ?? 'INSTALLED_NOT_CONFIGURED';

    return Object.freeze([
      Object.freeze({
        capability_id: 'speech.transcription' as const,
        display_name: 'Bilingual Speech-to-Text Transcription (FA/EN/Mixed)',
        responsibility:
          'Transcribes audio into raw and normalized Persian/English/Code-Switched text with timestamps and honest provenance.',
        ownership_layer: 'PROCESSING_CORE' as const,
        supported_operation_versions: [CANONICAL_OPERATION_VERSION],
        local_status: localAsrAvailable,
        cloud_status: cloudAsrStatus,
        required_runtime_components: ['CoreAudioIngestion (FFmpeg)', 'CoreAcousticCtcEngine / Neural Adapter'],
        max_recommended_memory_bytes: 512 * 1024 * 1024,
        entitlement_tier: 'FREE_LOCAL' as const,
        verification_status: 'VERIFIED' as const,
        limitations: [
          'Local CPU default uses deterministic acoustic CTC adapter unless ONNX/Python neural weights are mounted.',
          'Cloud path requires explicit provider configuration and never triggers silently from LOCAL_ONLY.',
        ],
      }),
      Object.freeze({
        capability_id: 'audio.silence_detection' as const,
        display_name: 'Adaptive Silence & Long Pause Detection',
        responsibility:
          'Detects adaptive noise-floor silence intervals and excessive speech pauses in integer sample coordinates.',
        ownership_layer: 'PROCESSING_CORE' as const,
        supported_operation_versions: [CANONICAL_OPERATION_VERSION],
        local_status: 'AVAILABLE_NOW' as const,
        cloud_status: 'INSTALLED_NOT_CONFIGURED' as const,
        required_runtime_components: ['CoreAudioIngestion', 'SpeechEventEngine (SilenceAndPauseAnalyzer)'],
        max_recommended_memory_bytes: 256 * 1024 * 1024,
        entitlement_tier: 'FREE_LOCAL' as const,
        verification_status: 'VERIFIED' as const,
        limitations: ['Heuristic acoustic energy + adaptive floor analysis; Silero VAD ONNX optional.'],
      }),
      Object.freeze({
        capability_id: 'speech.filler_detection' as const,
        display_name: 'Persian & Bilingual Filler-Word Detection',
        responsibility:
          'Identifies standalone and co-articulated Persian filler words with acoustic and lexical evidence fusion.',
        ownership_layer: 'PROCESSING_CORE' as const,
        supported_operation_versions: [CANONICAL_OPERATION_VERSION],
        local_status: 'AVAILABLE_NOW' as const,
        cloud_status: 'INSTALLED_NOT_CONFIGURED' as const,
        required_runtime_components: ['SpeechEventEngine', 'PersianDisfluencyEngine'],
        max_recommended_memory_bytes: 256 * 1024 * 1024,
        entitlement_tier: 'PRO_LOCAL' as const,
        verification_status: 'VERIFIED' as const,
        limitations: ['Heuristic lexical + acoustic scoring (not calibrated posterior probability).'],
      }),
      Object.freeze({
        capability_id: 'speech.repetition_detection' as const,
        display_name: 'Repetition, Stutter & False-Start Detection',
        responsibility:
          'Detects accidental word/phrase repetitions and self-corrections while preserving intentional rhetorical emphasis.',
        ownership_layer: 'PROCESSING_CORE' as const,
        supported_operation_versions: [CANONICAL_OPERATION_VERSION],
        local_status: 'AVAILABLE_NOW' as const,
        cloud_status: 'INSTALLED_NOT_CONFIGURED' as const,
        required_runtime_components: ['SpeechEventEngine', 'PersianSemanticRepetitionEngine'],
        max_recommended_memory_bytes: 256 * 1024 * 1024,
        entitlement_tier: 'PRO_LOCAL' as const,
        verification_status: 'VERIFIED' as const,
        limitations: ['Heuristic lexical + prosodic detection; requires human review before cut commit.'],
      }),
      Object.freeze({
        capability_id: 'speech.intelligent_editing' as const,
        display_name: 'Non-Destructive Intelligent Edit Decision Plan (EDL)',
        responsibility:
          'Transforms speech events into an immutable, risk-assessed, conflict-resolved Edit Plan without mutating source media.',
        ownership_layer: 'PROCESSING_CORE' as const,
        supported_operation_versions: [CANONICAL_OPERATION_VERSION],
        local_status: 'AVAILABLE_NOW' as const,
        cloud_status: 'INSTALLED_NOT_CONFIGURED' as const,
        required_runtime_components: ['SpeechEventEngine', 'EditDecisionEngine'],
        max_recommended_memory_bytes: 256 * 1024 * 1024,
        entitlement_tier: 'PRO_LOCAL' as const,
        verification_status: 'VERIFIED' as const,
        limitations: ['Never auto-applies edits; requires explicit human approval and project revision validation.'],
      }),
      Object.freeze({
        capability_id: 'audio.quality_analysis' as const,
        display_name: 'Broadcast Signal Quality & Stereo Phase Diagnostics',
        responsibility:
          'Computes SNR, Peak/RMS dBFS, clipping ratio, DC offset, and stereo phase correlation before mono downmix.',
        ownership_layer: 'PROCESSING_CORE' as const,
        supported_operation_versions: [CANONICAL_OPERATION_VERSION],
        local_status: 'AVAILABLE_NOW' as const,
        cloud_status: 'INSTALLED_NOT_CONFIGURED' as const,
        required_runtime_components: ['CoreAudioIngestion (FFmpeg + Signal Health)'],
        max_recommended_memory_bytes: 256 * 1024 * 1024,
        entitlement_tier: 'FREE_LOCAL' as const,
        verification_status: 'VERIFIED' as const,
        limitations: ['Signal-level objective metrics only; does not perform subjective MOS neural scoring.'],
      }),
    ]);
  }

  public async getCapability(capabilityId: CanonicalCapabilityId): Promise<CapabilityDescriptor | null> {
    const all = await this.listCapabilities();
    return all.find((c) => c.capability_id === capabilityId) ?? null;
  }

  private resolveExecutionMode(envelope: CanonicalOperationEnvelope): ExecutionMode {
    if (envelope.execution_policy === 'LOCAL_ONLY') return 'LOCAL';
    if (envelope.execution_policy === 'CLOUD_ONLY') return 'CLOUD';
    // LOCAL_PREFERRED_EXPLICIT_CLOUD_OPT_IN: still defaults to LOCAL unless explicitly requested via model policy
    if (envelope.requested_model_policy === 'EXPLICIT_CLOUD_PROVIDER') return 'CLOUD';
    return 'LOCAL';
  }

  public async executeEnvelope<TOutput = unknown>(
    envelope: CanonicalOperationEnvelope,
    signal?: AbortSignal,
  ): Promise<CanonicalOperationResult<TOutput>> {
    const validation = validateCanonicalOperationEnvelope(envelope);
    if (!validation.ok) {
      throw new UnifiedProcessingError({
        code: validation.code ?? 'INVALID_PROCESSING_REQUEST',
        executionMode: 'LOCAL',
        detailEn: validation.message ?? 'Invalid canonical operation envelope.',
      });
    }

    const resolvedMode = this.resolveExecutionMode(envelope);
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();

    if (signal?.aborted) {
      throw new UnifiedProcessingError({
        code: 'PROCESSING_CANCELLED',
        executionMode: resolvedMode,
      });
    }

    // Strict Section 7.3 rule: Cloud execution for capabilities without Cloud adapter fails explicitly — ZERO silent Local fallback!
    if (resolvedMode === 'CLOUD' && envelope.capability_id !== 'speech.transcription') {
      throw new UnifiedProcessingError({
        code: 'CLOUD_PROVIDER_UNAVAILABLE',
        executionMode: 'CLOUD',
        providerId: 'cloud-unconfigured',
        detailEn: `Capability "${envelope.capability_id}" does not have a configured Cloud execution adapter. Silent fallback to LOCAL is prohibited.`,
        detailFa: `قابلیت «${envelope.capability_id}» در محیط ابری پیکربندی نشده است و بازگشت خودکار به اجرای محلی مجاز نیست.`,
        retryable: false,
      });
    }

    switch (envelope.capability_id) {
      case 'speech.transcription':
        return (await this.executeTranscription(
          envelope as CanonicalOperationEnvelope<SpeechTranscriptionInput>,
          resolvedMode,
          signal,
        )) as CanonicalOperationResult<TOutput>;

      case 'audio.quality_analysis':
        return this.executeAudioQualityAnalysis(
          envelope as CanonicalOperationEnvelope<AudioQualityAnalysisInput>,
          startedAtMs,
          startedAtIso,
        ) as CanonicalOperationResult<TOutput>;

      case 'audio.silence_detection':
      case 'speech.filler_detection':
      case 'speech.repetition_detection':
        return (await this.executeSpeechEvents(
          envelope as CanonicalOperationEnvelope<SpeechEventCapabilityInput>,
          startedAtMs,
          startedAtIso,
          signal,
        )) as CanonicalOperationResult<TOutput>;

      case 'speech.intelligent_editing':
        return (await this.executeIntelligentEditing(
          envelope as CanonicalOperationEnvelope<IntelligentEditingInput>,
          startedAtMs,
          startedAtIso,
          signal,
        )) as CanonicalOperationResult<TOutput>;
    }
  }

  private async executeTranscription(
    envelope: CanonicalOperationEnvelope<SpeechTranscriptionInput>,
    resolvedMode: ExecutionMode,
    signal?: AbortSignal,
  ): Promise<CanonicalOperationResult<SpeechTranscriptionOutput>> {
    const input = envelope.input_payload;
    const req: UnifiedProcessingRequest = {
      contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
      jobId: envelope.request_id,
      recordingId: envelope.media_references[0]?.media_id ?? envelope.project_id,
      executionMode: resolvedMode,
      processingMode: input.processing_mode ?? 'batch',
      audio: input.audio,
      languageHint: input.language_hint ?? 'auto',
      config: {
        configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
        normalizationProfile: input.normalization_profile ?? 'FA-STRICT-V1',
        ...(input.max_segment_duration_sec !== undefined
          ? { maxSegmentDurationSec: input.max_segment_duration_sec }
          : {}),
        ...(input.context_overlap_sec !== undefined
          ? { contextOverlapSec: input.context_overlap_sec }
          : {}),
        requireNeuralWeights: envelope.requested_model_policy === 'REQUIRE_NEURAL_WEIGHTS',
      },
      requestedCapabilities: ['RAW_TRANSCRIPT', 'NORMALIZED_VARIANTS', 'SEGMENT_TIMESTAMPS'],
      cancellationId: envelope.request_id,
      constraints: { idempotencyKey: envelope.idempotency_key },
      preferredProviderId: input.preferred_provider_id,
    };

    const res = await this.orchestrator.execute(req, signal);
    return Object.freeze({
      request_id: envelope.request_id,
      capability_id: 'speech.transcription',
      operation_version: envelope.operation_version,
      result_schema_version: '2.0.0',
      status: res.status,
      result_payload: Object.freeze({
        duration_sec: res.durationSec,
        dominant_language: res.dominantLanguage,
        raw_model_output: res.rawModelOutput,
        normalized_by_profile: res.normalizedByProfile,
        confidence_status: res.confidenceStatus,
        calibrated_confidence: res.calibratedConfidence,
        timestamp_granularity: res.timestampGranularity,
        segments: res.segments,
        failed_segment_ranges: res.failedSegmentRanges,
      }),
      media_references: envelope.media_references,
      processing_metadata: res.resourceUsage,
      actual_execution_environment: res.executionMode,
      actual_model_identity: res.provenance.modelId,
      actual_model_version: res.provenance.modelVersion,
      provenance: Object.freeze({
        request_id: envelope.request_id,
        correlation_id: envelope.correlation_id,
        project_id: envelope.project_id,
        project_revision: envelope.project_revision,
        actual_adapter_id: res.provenance.actualAdapterId,
        actual_provider_id: res.provenance.providerId,
        is_genuine_neural_model: res.provenance.isGenuineNeuralModel,
        fallback_used: res.provenance.fallbackUsed,
        fallback_authorized_reason: res.provenance.fallbackAuthorizedReason,
        started_at: res.provenance.startedAtIso,
        completed_at: res.provenance.completedAtIso,
        duration_ms: res.provenance.actualDurationMs,
      }),
      warnings: res.warnings,
      errors: res.error ? [res.error] : [],
    });
  }

  private executeAudioQualityAnalysis(
    envelope: CanonicalOperationEnvelope<AudioQualityAnalysisInput>,
    startedAtMs: number,
    startedAtIso: string,
  ): CanonicalOperationResult<AudioQualityAnalysisOutput> {
    const { ingestResult } = decodeAudioToCanonicalPcm16k(envelope.input_payload.audio, 'LOCAL');
    const completedAtMs = Date.now();
    const durationMs = Math.max(0, completedAtMs - startedAtMs);

    return Object.freeze({
      request_id: envelope.request_id,
      capability_id: 'audio.quality_analysis',
      operation_version: envelope.operation_version,
      result_schema_version: '2.0.0',
      status: 'COMPLETED',
      result_payload: Object.freeze({
        detected_container: ingestResult.detectedFormat,
        source_sample_rate_hz: ingestResult.originalSampleRateHz,
        source_channels: ingestResult.originalChannels,
        duration_sec: ingestResult.durationSec,
        peak_dbfs: ingestResult.signalHealth.peakDb,
        rms_dbfs: ingestResult.signalHealth.rmsDb,
        clipping_ratio: ingestResult.signalHealth.clippingRatio,
        dc_offset: ingestResult.signalHealth.dcOffset,
        estimated_snr_db: ingestResult.signalHealth.estimatedSnrDb,
        stereo_channel_action: ingestResult.stereoInspection.policyApplied,
        stereo_correlation: ingestResult.stereoInspection.interChannelCorrelation,
        quality_warnings: ingestResult.warnings,
      }),
      media_references: envelope.media_references,
      processing_metadata: {
        measurementKind: 'MEASURED' as const,
        processingTimeMs: durationMs,
        realTimeFactor:
          ingestResult.durationSec > 0
            ? Number(((durationMs / 1000) / ingestResult.durationSec).toFixed(4))
            : 0,
        peakMemoryBytes: process.memoryUsage().rss,
      },
      actual_execution_environment: 'LOCAL',
      actual_model_identity: 'core-audio-signal-health-v1',
      actual_model_version: '1.0.0',
      provenance: Object.freeze({
        request_id: envelope.request_id,
        correlation_id: envelope.correlation_id,
        project_id: envelope.project_id,
        project_revision: envelope.project_revision,
        actual_adapter_id: 'avapardaz-local-dsp-adapter-v2',
        actual_provider_id: 'CoreAudioIngestion',
        is_genuine_neural_model: false,
        fallback_used: false,
        fallback_authorized_reason: null,
        started_at: startedAtIso,
        completed_at: new Date(completedAtMs).toISOString(),
        duration_ms: durationMs,
      }),
      warnings: ingestResult.warnings,
      errors: [],
    });
  }

  private async executeSpeechEvents(
    envelope: CanonicalOperationEnvelope<SpeechEventCapabilityInput>,
    startedAtMs: number,
    startedAtIso: string,
    signal?: AbortSignal,
  ): Promise<
    CanonicalOperationResult<SilenceDetectionOutput | FillerDetectionOutput | RepetitionDetectionOutput>
  > {
    const input = envelope.input_payload;
    let pcmMono: Float32Array | undefined;
    let sampleRate: SampleRate = coerceSampleRate(input.sample_rate_hz);
    let totalSamples = 0;

    if (input.audio) {
      const decoded = decodeAudioToCanonicalPcm16k(input.audio, 'LOCAL');
      pcmMono = decoded.pcm16k;
      sampleRate = 16000;
      totalSamples = decoded.pcm16k.length;
    }

    const timedTokens = toTimedPersianTokens(input.tokens);
    if (totalSamples === 0 && timedTokens.length > 0) {
      const maxEndSec = Math.max(...timedTokens.map((t) => TimeMath.flicksToSeconds(t.range.end)));
      totalSamples = Math.max(sampleRate, Math.ceil((maxEndSec + 0.5) * sampleRate));
      pcmMono = new Float32Array(totalSamples);
    }

    if (totalSamples <= 0) {
      throw new UnifiedProcessingError({
        code: 'INVALID_PROCESSING_REQUEST',
        executionMode: 'LOCAL',
        detailEn: 'Either audio input or timed tokens must be provided for speech event detection.',
      });
    }

    const analysis = await SpeechEventEngine.analyzeRecording({
      trackId: input.track_id || 'track_primary',
      sampleRate,
      totalSamples,
      pcmMono,
      tokens: timedTokens,
      signal,
    });

    if (analysis.cancelled) {
      throw new UnifiedProcessingError({
        code: 'PROCESSING_CANCELLED',
        executionMode: 'LOCAL',
        providerId: 'SpeechEventEngine',
      });
    }

    const completedAtMs = Date.now();
    const durationMs = Math.max(0, completedAtMs - startedAtMs);

    let resultPayload: SilenceDetectionOutput | FillerDetectionOutput | RepetitionDetectionOutput;
    if (envelope.capability_id === 'audio.silence_detection') {
      const silenceEvents = analysis.events.filter((e) => e.category === 'SILENCE');
      const ids = new Set(silenceEvents.map((e) => e.eventId));
      resultPayload = {
        engine_version: analysis.engineVersion,
        analyzed_duration_sec: analysis.analyzedDurationSec,
        estimated_noise_floor_dbfs: analysis.estimatedNoiseFloorDbfs,
        silence_events: silenceEvents,
        suggestions: analysis.suggestions.filter((s) => ids.has(s.sourceEventId)),
      };
    } else if (envelope.capability_id === 'speech.filler_detection') {
      const fillerEvents = analysis.events.filter((e) => e.category === 'FILLER');
      const ids = new Set(fillerEvents.map((e) => e.eventId));
      resultPayload = {
        engine_version: analysis.engineVersion,
        analyzed_duration_sec: analysis.analyzedDurationSec,
        filler_events: fillerEvents,
        suggestions: analysis.suggestions.filter((s) => ids.has(s.sourceEventId)),
      };
    } else {
      const repEvents = analysis.events.filter(
        (e) =>
          e.category === 'WORD_REPETITION' ||
          e.category === 'SYLLABLE_REPETITION' ||
          e.category === 'STUTTER' ||
          e.category === 'FALSE_START' ||
          e.category === 'SELF_CORRECTION',
      );
      const ids = new Set(repEvents.map((e) => e.eventId));
      resultPayload = {
        engine_version: analysis.engineVersion,
        analyzed_duration_sec: analysis.analyzedDurationSec,
        repetition_events: repEvents,
        suggestions: analysis.suggestions.filter((s) => ids.has(s.sourceEventId)),
      };
    }

    return Object.freeze({
      request_id: envelope.request_id,
      capability_id: envelope.capability_id,
      operation_version: envelope.operation_version,
      result_schema_version: '2.0.0',
      status: 'COMPLETED',
      result_payload: Object.freeze(resultPayload),
      media_references: envelope.media_references,
      processing_metadata: {
        measurementKind: 'MEASURED' as const,
        processingTimeMs: durationMs,
        realTimeFactor:
          analysis.analyzedDurationSec > 0
            ? Number(((durationMs / 1000) / analysis.analyzedDurationSec).toFixed(4))
            : 0,
        peakMemoryBytes: Math.max(analysis.peakReservedBytes, process.memoryUsage().rss),
      },
      actual_execution_environment: 'LOCAL',
      actual_model_identity: 'speech-event-evidence-engine',
      actual_model_version: analysis.engineVersion,
      provenance: Object.freeze({
        request_id: envelope.request_id,
        correlation_id: envelope.correlation_id,
        project_id: envelope.project_id,
        project_revision: envelope.project_revision,
        actual_adapter_id: 'avapardaz-local-speech-events-v2',
        actual_provider_id: 'SpeechEventEngine',
        is_genuine_neural_model: false,
        fallback_used: false,
        fallback_authorized_reason: null,
        started_at: startedAtIso,
        completed_at: new Date(completedAtMs).toISOString(),
        duration_ms: durationMs,
      }),
      warnings: analysis.warnings,
      errors: [],
    });
  }

  private async executeIntelligentEditing(
    envelope: CanonicalOperationEnvelope<IntelligentEditingInput>,
    startedAtMs: number,
    startedAtIso: string,
    signal?: AbortSignal,
  ): Promise<CanonicalOperationResult<IntelligentEditingOutput>> {
    const input = envelope.input_payload;
    let pcmMono: Float32Array | undefined;
    let sampleRate: SampleRate = coerceSampleRate(input.sample_rate_hz);
    let totalSamples = 0;
    let audioHash = input.source_audio_hash || envelope.media_references[0]?.sha256_hex || '';

    if (input.audio) {
      const decoded = decodeAudioToCanonicalPcm16k(input.audio, 'LOCAL');
      pcmMono = decoded.pcm16k;
      sampleRate = 16000;
      totalSamples = decoded.pcm16k.length;
      audioHash = audioHash || decoded.sha256;
    }

    const timedTokens = toTimedPersianTokens(input.tokens);
    if (totalSamples === 0 && timedTokens.length > 0) {
      const maxEndSec = Math.max(...timedTokens.map((t) => TimeMath.flicksToSeconds(t.range.end)));
      totalSamples = Math.max(sampleRate, Math.ceil((maxEndSec + 0.5) * sampleRate));
      pcmMono = new Float32Array(totalSamples);
    }

    if (totalSamples <= 0 || !audioHash) {
      throw new UnifiedProcessingError({
        code: 'INVALID_PROCESSING_REQUEST',
        executionMode: 'LOCAL',
        detailEn: 'Audio or timed tokens AND source_audio_hash are required for non-destructive EDL generation.',
      });
    }

    const eventRes = await SpeechEventEngine.analyzeRecording({
      trackId: input.track_id || 'track_primary',
      sampleRate,
      totalSamples,
      pcmMono,
      tokens: timedTokens,
      signal,
    });

    const edlSnapshot = await EditDecisionEngine.generateEdl({
      context: {
        projectId: envelope.project_id,
        sourceAudioId: input.source_audio_id || envelope.media_references[0]?.media_id || 'media_0',
        sourceAudioHash: audioHash,
        transcriptVersion: input.transcript_version || 'raw-v1',
        sampleRate,
        totalSourceSamples: totalSamples,
      },
      events: eventRes.events,
      tokens: timedTokens,
      signal,
    });

    const completedAtMs = Date.now();
    const durationMs = Math.max(0, completedAtMs - startedAtMs);

    return Object.freeze({
      request_id: envelope.request_id,
      capability_id: 'speech.intelligent_editing',
      operation_version: envelope.operation_version,
      result_schema_version: '2.0.0',
      status: edlSnapshot.cancelled ? 'CANCELLED' : 'COMPLETED',
      result_payload: Object.freeze({
        non_destructive_guarantee: true as const,
        auto_applied: false as const,
        base_project_revision: envelope.project_revision,
        edl_snapshot: edlSnapshot,
        proposal_count: edlSnapshot.proposals.length,
        conflict_count: edlSnapshot.conflicts.length,
      }),
      media_references: envelope.media_references,
      processing_metadata: {
        measurementKind: 'MEASURED' as const,
        processingTimeMs: durationMs,
        realTimeFactor:
          eventRes.analyzedDurationSec > 0
            ? Number(((durationMs / 1000) / eventRes.analyzedDurationSec).toFixed(4))
            : 0,
        peakMemoryBytes: process.memoryUsage().rss,
      },
      actual_execution_environment: 'LOCAL',
      actual_model_identity: 'avapardaz-edit-decision-engine',
      actual_model_version: edlSnapshot.eventSourceVersions.decisionEngineVersion,
      provenance: Object.freeze({
        request_id: envelope.request_id,
        correlation_id: envelope.correlation_id,
        project_id: envelope.project_id,
        project_revision: envelope.project_revision,
        actual_adapter_id: 'avapardaz-local-edl-adapter-v2',
        actual_provider_id: 'EditDecisionEngine',
        is_genuine_neural_model: false,
        fallback_used: false,
        fallback_authorized_reason: null,
        started_at: startedAtIso,
        completed_at: new Date(completedAtMs).toISOString(),
        duration_ms: durationMs,
      }),
      warnings: eventRes.warnings,
      errors: [],
    });
  }
}
