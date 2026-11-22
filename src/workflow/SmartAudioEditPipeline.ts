/**
 * AVAPARDAZ — UNIFIED SMART AUDIO EDIT VERTICAL SLICE ORCHESTRATOR (AVP-EXECUTION-001)
 *
 * Chains Engine 01 (Shahab local CPU ASR), Engine 02 (SpeechEventEngine + EditDecisionEngine),
 * and Engine 03 (AudioRenderEngine + SmartEditPreviewRenderer) under a strict controlled
 * AudioEditJob state machine with explicit human Approval Gate, sample-exact multi-channel
 * WAV preservation, source-hash integrity enforcement, and cancellation propagation.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SampleRate } from '../contracts/timebase.contract';
import { TimeMath } from '../contracts/timebase.contract';
import { ingestAudioBufferToCanonical16kMono } from '../asr-core/CoreAudioIngestion';
import { ShahabLocalAsrRuntime } from '../asr-core/ShahabModelManifest';
import { SpeechEventEngine } from '../ai-engine/speech-events/SpeechEventEngine';
import type { TimedPersianToken } from '../ai-engine/PersianTextNormalizer';
import { PersianTextNormalizer } from '../ai-engine/PersianTextNormalizer';
import { EditDecisionEngine } from '../ai-engine/edit-decision/EditDecisionEngine';
import type { EditDecisionListSnapshot } from '../ai-engine/edit-decision/EditDecisionTypes';
import { createPlanarArrayPcmSource } from '../audio-renderer/AudioSourceReader';
import type { AudioRenderConfig, AudioRenderResult, ChunkedPcmSource } from '../audio-renderer/AudioRenderTypes';
import { SmartEditPreviewRenderer } from '../audio-renderer/SmartEditPreviewRenderer';
import {
  computeRealWaveformPeaks,
  decodeNativeWavToPlanar,
  isSupportedExactSampleRate,
  snapToSupportedSampleRate,
} from './WavNativeDecoder';
import {
  createInitialAudioEditJob,
  transitionAudioEditJob,
  updateJobProgressInPlace,
  type AudioEditJob,
} from './AudioEditJobStateMachine';
import {
  isProposalLowRiskApprovable,
  summarizeEdlProposals,
  type BatchLowRiskApprovalResult,
  type PrecisionAudioRenderer,
  type ShahabAsrEngine,
  type SmartAudioEditSession,
  type SmartAudioEditStage,
  type SmartAudioEditStageTrace,
  type SmartEditAnalysisRequest,
  type SmartEditAnalysisResult,
  type SmartEditDecisionEngine,
  type SmartEditPreviewMode,
  type SmartEditPreviewResult,
  type TranscriptDocument,
} from './SmartAudioEditContracts';

export class SmartAudioEditError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SmartAudioEditError';
    this.code = code;
  }
}

export interface ImportedAudioContext {
  readonly filename: string;
  readonly rawBytes: Buffer;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sourceSampleRate: SampleRate;
  readonly sourceChannels: number;
  readonly totalSourceSamples: number;
  readonly sourceDurationSec: number;
  readonly canonical16kMono: Float32Array;
  readonly waveformPeaks: readonly number[];
  readonly pcmSource: ChunkedPcmSource;
}

function transcriptTokensToTimedPersianTokens(
  transcript: TranscriptDocument,
  trackId: string,
): TimedPersianToken[] {
  return transcript.tokens.map((t) => ({
    tokenId: t.tokenId,
    trackId,
    displayText: t.rawText,
    normalizedText: PersianTextNormalizer.normalizeTokenText(t.normalizedText || t.rawText),
    range: {
      start: TimeMath.secondsToFlicks(t.startSec),
      end: TimeMath.secondsToFlicks(t.endSec),
    },
    confidence: t.confidence ?? 0.9,
  }));
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('CANCELLED') || msg.includes('ABORT');
}

function extractErrorCode(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = /^([A-Z][A-Z0-9_]{2,})/.exec(msg);
  return match ? match[1] : fallback;
}

export class DefaultSmartEditDecisionAdapter implements SmartEditDecisionEngine {
  public analyzeAndGenerateEdl(request: SmartEditAnalysisRequest): SmartEditAnalysisResult {
    const trackId = request.trackId ?? 'track-main';
    const nowMs = request.nowMs ?? Date.now();
    const timedTokens = transcriptTokensToTimedPersianTokens(request.transcript, trackId);

    const speechEvents = SpeechEventEngine.analyzeRecording({
      recordingId: request.transcript.sourceAudioId,
      trackId,
      sampleRate: request.analysisSampleRate,
      pcmMono: request.pcmMonoForAcousticAnalysis,
      timedTokens,
      transcriptVersion: request.transcript.transcriptVersion,
      nowMs,
    });

    const edl = EditDecisionEngine.generateEdl({
      context: {
        projectId: request.projectId,
        sourceAudioId: request.transcript.sourceAudioId,
        sourceAudioHash: request.transcript.sourceAudioHash,
        transcriptVersion: request.transcript.transcriptVersion,
        alignmentVersion: `align-${request.transcript.modelVersion}`,
        sampleRate: snapToSupportedSampleRate(request.transcript.sampleRate),
        channelLayout: request.channelLayout ?? 'mono',
        totalSourceSamples: request.transcript.totalSourceSamples,
        modelVersions: {
          shahabAsr: `${request.transcript.modelId}@${request.transcript.modelVersion}`,
        },
      },
      speechEventResult: speechEvents,
      timedTokens,
      nowMs,
    });

    return {
      speechEvents,
      edl,
      proposalSummary: summarizeEdlProposals(edl),
    };
  }
}

export interface ManagedSmartEditState {
  readonly job: AudioEditJob;
  readonly session: SmartAudioEditSession;
}

export class SmartAudioEditPipeline {
  private readonly asrEngine: ShahabAsrEngine;
  private readonly decisionEngine: SmartEditDecisionEngine;
  private readonly renderer: PrecisionAudioRenderer;

  constructor(deps?: {
    readonly asrEngine?: ShahabAsrEngine;
    readonly decisionEngine?: SmartEditDecisionEngine;
    readonly renderer?: PrecisionAudioRenderer;
  }) {
    this.asrEngine = deps?.asrEngine ?? new ShahabLocalAsrRuntime();
    this.decisionEngine = deps?.decisionEngine ?? new DefaultSmartEditDecisionAdapter();
    this.renderer = deps?.renderer ?? new SmartEditPreviewRenderer();
  }

  /**
   * Stages 01 & 02: Validate input audio, compute SHA-256, preserve native sample rate & channels
   * for Engine 03 rendering, and generate canonical 16 kHz mono PCM for Engine 01 & Engine 02.
   */
  public importAndNormalizeAudio(params: {
    readonly audioBytes?: Buffer;
    readonly audioFilePath?: string;
    readonly filename?: string;
    readonly projectId?: string;
    readonly trackId?: string;
    readonly jobId?: string;
  }): {
    readonly job: AudioEditJob;
    readonly session: SmartAudioEditSession;
    readonly audio: ImportedAudioContext;
  } {
    const jobId = params.jobId ?? `job_${crypto.randomUUID().slice(0, 12)}`;
    let job = createInitialAudioEditJob({ jobId });
    job = transitionAudioEditJob(job, 'VALIDATING', { progress: 5 });

    const tImport = performance.now();
    let rawBytes: Buffer;
    let filename = params.filename ?? 'audio.wav';
    if (params.audioBytes && params.audioBytes.byteLength > 0) {
      // Defensive copy so caller mutations to external buffer cannot silently corrupt hash checks unless explicit
      rawBytes = Buffer.from(params.audioBytes);
    } else if (params.audioFilePath) {
      rawBytes = fs.readFileSync(params.audioFilePath);
      filename = path.basename(params.audioFilePath);
    } else {
      throw new SmartAudioEditError(
        'INVALID_AUDIO_INPUT',
        'INVALID_AUDIO_INPUT: Either audioBytes or audioFilePath is required.',
      );
    }

    const sourceAudioHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    const sourceAudioId = `aud_${sourceAudioHash.slice(0, 16)}`;
    const importMs = Number((performance.now() - tImport).toFixed(2));

    job = transitionAudioEditJob(job, 'PREPARING_AUDIO', {
      progress: 12,
      sourceAudioHash,
    });

    const tNorm = performance.now();
    const nativeWav = decodeNativeWavToPlanar(rawBytes);
    const canonical = ingestAudioBufferToCanonical16kMono({ filename, rawBytes });

    // Preserve native WAV sample rate AND channel count (mono/stereo) when supported natively
    const useNativeWav =
      nativeWav !== null && isSupportedExactSampleRate(nativeWav.rawSampleRateHz);
    const effectiveRate: SampleRate = useNativeWav ? nativeWav.sampleRate : 16000;
    const renderChannels: readonly Float32Array[] = useNativeWav
      ? nativeWav.channels
      : [canonical.canonicalFloat32];
    const totalSourceSamples = renderChannels[0].length;
    const waveformPeaks = computeRealWaveformPeaks(
      useNativeWav ? nativeWav.monoDownmix : canonical.canonicalFloat32,
      240,
    );

    const pcmSource = createPlanarArrayPcmSource({
      sourceAudioId,
      sourceAudioHash,
      sampleRate: effectiveRate,
      channels: renderChannels,
    });
    const normMs = Number((performance.now() - tNorm).toFixed(2));

    const nowMs = Date.now();
    const stageTrace: SmartAudioEditStageTrace[] = [
      {
        stage: 'IMPORT_AUDIO',
        status: 'COMPLETED',
        durationMs: importMs,
        detail: `${filename} (${rawBytes.byteLength} B, sha256=${sourceAudioHash.slice(0, 12)})`,
      },
      {
        stage: 'LOCAL_AUDIO_NORMALIZATION',
        status: 'COMPLETED',
        durationMs: normMs,
        detail: `native=${effectiveRate}Hz/${renderChannels.length}ch (${totalSourceSamples} samples), asr16k=${canonical.canonicalFloat32.length} samples`,
      },
    ];

    const session: SmartAudioEditSession = {
      sessionId: jobId,
      projectId: params.projectId ?? `proj_${sourceAudioHash.slice(0, 10)}`,
      trackId: params.trackId ?? 'track-main',
      filename,
      sourceAudioId,
      sourceAudioHash,
      sourceSampleRate: effectiveRate,
      sourceChannels: renderChannels.length,
      totalSourceSamples,
      sourceDurationSec: Number((totalSourceSamples / effectiveRate).toFixed(3)),
      transcript: null,
      asrMetrics: null,
      speechEvents: null,
      edl: null,
      edlHistory: [],
      edlHistoryIndex: -1,
      lastRenderResult: null,
      stageTrace,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    return {
      job,
      session,
      audio: {
        filename,
        rawBytes,
        sourceAudioId,
        sourceAudioHash,
        sourceSampleRate: effectiveRate,
        sourceChannels: renderChannels.length,
        totalSourceSamples,
        sourceDurationSec: session.sourceDurationSec,
        canonical16kMono: canonical.canonicalFloat32,
        waveformPeaks,
        pcmSource,
      },
    };
  }

  /**
   * Stages 03 & 04: Run Engine 01 (Shahab local CPU ASR) and validate token sample timecodes.
   */
  public async transcribe(params: {
    readonly job: AudioEditJob;
    readonly session: SmartAudioEditSession;
    readonly audio: ImportedAudioContext;
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly unloadAfterTranscribe?: boolean;
    readonly signal?: AbortSignal;
    readonly onJobUpdate?: (job: AudioEditJob) => void;
    readonly onProgress?: (progress: {
      readonly percent: number;
      readonly currentChunk: number;
      readonly totalChunks: number;
      readonly elapsedMs: number;
      readonly partialText: string;
    }) => void;
  }): Promise<ManagedSmartEditState> {
    let job = transitionAudioEditJob(params.job, 'TRANSCRIBING', { progress: 18 });
    params.onJobUpdate?.(job);

    const tAsr = performance.now();
    try {
      if (params.signal?.aborted) {
        throw new SmartAudioEditError('TRANSCRIPTION_CANCELLED', 'Transcription cancelled before start.');
      }

      const { transcript, metrics } = await this.asrEngine.transcribe({
        sourceAudioId: params.audio.sourceAudioId,
        sourceAudioHash: params.audio.sourceAudioHash,
        sourceSampleRate: params.audio.sourceSampleRate,
        totalSourceSamples: params.audio.totalSourceSamples,
        audioBytes: params.audio.rawBytes,
        filename: params.audio.filename,
        languageHint: params.languageHint ?? 'fa',
        unloadAfterTranscribe: params.unloadAfterTranscribe,
        signal: params.signal,
        onProgress: (p) => {
          const mapped = 18 + Math.round((p.percent / 100) * 38);
          job = updateJobProgressInPlace(job, mapped);
          params.onJobUpdate?.(job);
          params.onProgress?.(p);
        },
      });
      const asrMs = Number((performance.now() - tAsr).toFixed(2));

      job = transitionAudioEditJob(job, 'VALIDATING_TRANSCRIPT', {
        progress: 60,
        transcriptId: transcript.transcriptVersion,
      });
      params.onJobUpdate?.(job);

      const tAlign = performance.now();
      this.validateTranscriptTimestamps(transcript, params.audio.totalSourceSamples);
      const alignMs = Number((performance.now() - tAlign).toFixed(2));

      const nextTrace: SmartAudioEditStageTrace[] = [
        ...params.session.stageTrace,
        {
          stage: 'ENGINE_01_SHAHAB_ASR',
          status: 'COMPLETED',
          durationMs: asrMs,
          detail: `${transcript.modelId} | ${transcript.tokens.length} tokens | RTF=${metrics.realTimeFactor}`,
        },
        {
          stage: 'WORD_LEVEL_TIMECODE_ALIGNMENT',
          status: 'COMPLETED',
          durationMs: alignMs,
          detail: `granularity=${transcript.timestampGranularity}, sampleRate=${transcript.sampleRate}Hz`,
        },
      ];

      return {
        job,
        session: {
          ...params.session,
          transcript,
          asrMetrics: metrics,
          stageTrace: nextTrace,
          updatedAtMs: Date.now(),
        },
      };
    } catch (err) {
      if (isAbortError(err, params.signal)) {
        job = transitionAudioEditJob(job, 'CANCELLED', {
          errorMessage: 'فرآیند تبدیل صوت به متن توسط کاربر لغو شد.',
        });
        params.onJobUpdate?.(job);
        throw new SmartAudioEditError('TRANSCRIPTION_CANCELLED', 'TRANSCRIPTION_CANCELLED');
      }
      const code = extractErrorCode(err, 'ASR_FAILED');
      const message = err instanceof Error ? err.message : String(err);
      job = transitionAudioEditJob(job, 'FAILED', { errorCode: code, errorMessage: message });
      params.onJobUpdate?.(job);
      throw new SmartAudioEditError(code, message);
    }
  }

  public validateTranscriptTimestamps(
    transcript: TranscriptDocument,
    totalSourceSamples: number,
  ): void {
    for (let i = 0; i < transcript.tokens.length; i++) {
      const tok = transcript.tokens[i];
      if (
        !Number.isInteger(tok.startSample) ||
        !Number.isInteger(tok.endSample) ||
        tok.startSample < 0 ||
        tok.endSample <= tok.startSample ||
        tok.endSample > totalSourceSamples
      ) {
        throw new SmartAudioEditError(
          'INVALID_TRANSCRIPT_TIMECODE',
          `INVALID_TRANSCRIPT_TIMECODE: Token ${tok.tokenId} [${tok.startSample}, ${tok.endSample}] out of bounds [0, ${totalSourceSamples}].`,
        );
      }
      if (i > 0 && tok.startSample < transcript.tokens[i - 1].startSample) {
        throw new SmartAudioEditError(
          'NON_MONOTONIC_TRANSCRIPT_TIMECODE',
          `NON_MONOTONIC_TRANSCRIPT_TIMECODE: Token ${tok.tokenId} starts before previous token.`,
        );
      }
    }
  }

  /**
   * Stages 05 & 06: Run Engine 02 (SpeechEventEngine + EditDecisionEngine) and enter WAITING_USER_APPROVAL.
   */
  public analyzeAndGenerateEdl(params: {
    readonly job: AudioEditJob;
    readonly session: SmartAudioEditSession;
    readonly audio: ImportedAudioContext;
    readonly nowMs?: number;
    readonly onJobUpdate?: (job: AudioEditJob) => void;
  }): ManagedSmartEditState & { readonly analysis: SmartEditAnalysisResult } {
    if (!params.session.transcript) {
      throw new SmartAudioEditError(
        'TRANSCRIPT_REQUIRED',
        'TRANSCRIPT_REQUIRED: Run Engine 01 Shahab ASR before Engine 02.',
      );
    }

    let job = transitionAudioEditJob(params.job, 'ANALYZING', { progress: 68 });
    params.onJobUpdate?.(job);

    const t0 = performance.now();
    const analysis = this.decisionEngine.analyzeAndGenerateEdl({
      projectId: params.session.projectId,
      trackId: params.session.trackId,
      transcript: params.session.transcript,
      pcmMonoForAcousticAnalysis: params.audio.canonical16kMono,
      analysisSampleRate: 16000,
      channelLayout: params.audio.sourceChannels === 2 ? 'stereo' : 'mono',
      nowMs: params.nowMs,
    });
    const elapsedMs = Number((performance.now() - t0).toFixed(2));

    if (analysis.edl.automaticApprovalEligible !== false) {
      throw new SmartAudioEditError(
        'SAFETY_INVARIANT_VIOLATION',
        'SAFETY_INVARIANT_VIOLATION: automaticApprovalEligible must remain false.',
      );
    }

    job = transitionAudioEditJob(job, 'GENERATING_EDL', {
      progress: 78,
      editDecisionId: analysis.speechEvents.analysisId,
      edlId: analysis.edl.edlId,
    });
    params.onJobUpdate?.(job);

    job = transitionAudioEditJob(job, 'WAITING_USER_APPROVAL', {
      progress: 82,
      edlId: analysis.edl.edlId,
    });
    params.onJobUpdate?.(job);

    const nextTrace: SmartAudioEditStageTrace[] = [
      ...params.session.stageTrace,
      {
        stage: 'ENGINE_02_SMART_EDIT_DECISION',
        status: 'COMPLETED',
        durationMs: elapsedMs,
        detail: `events=${analysis.speechEvents.events.length}`,
      },
      {
        stage: 'EDL_GENERATION',
        status: 'COMPLETED',
        durationMs: 0,
        detail: `edlId=${analysis.edl.edlId}, proposals=${analysis.edl.proposals.length}, lowRisk=${analysis.proposalSummary.lowRiskCount}`,
      },
    ];

    return {
      job,
      analysis,
      session: {
        ...params.session,
        speechEvents: analysis.speechEvents,
        edl: analysis.edl,
        edlHistory: [analysis.edl],
        edlHistoryIndex: 0,
        stageTrace: nextTrace,
        updatedAtMs: Date.now(),
      },
    };
  }

  /**
   * Stage 07 (Approval Gate): Explicit human review decisions on versioned EDL.
   */
  public applyUserDecision(params: {
    readonly job: AudioEditJob;
    readonly session: SmartAudioEditSession;
    readonly action:
      | 'APPROVE'
      | 'REJECT'
      | 'RETURN_TO_REVIEW'
      | 'APPROVE_ALL_LOW_RISK'
      | 'UNDO'
      | 'REDO';
    readonly proposalIds?: readonly string[];
    readonly reason?: string;
    readonly actorId?: string;
  }): ManagedSmartEditState & { readonly batchResult?: BatchLowRiskApprovalResult } {
    const { session } = params;
    if (!session.edl) {
      throw new SmartAudioEditError('EDL_REQUIRED', 'EDL_REQUIRED: Generate EDL before applying decisions.');
    }

    const job =
      params.job.status === 'WAITING_USER_APPROVAL'
        ? params.job
        : transitionAudioEditJob(params.job, 'WAITING_USER_APPROVAL');

    if (params.action === 'UNDO') {
      if (session.edlHistoryIndex <= 0) return { job, session };
      const nextIdx = session.edlHistoryIndex - 1;
      return {
        job,
        session: {
          ...session,
          edl: session.edlHistory[nextIdx],
          edlHistoryIndex: nextIdx,
          updatedAtMs: Date.now(),
        },
      };
    }

    if (params.action === 'REDO') {
      if (session.edlHistoryIndex >= session.edlHistory.length - 1) return { job, session };
      const nextIdx = session.edlHistoryIndex + 1;
      return {
        job,
        session: {
          ...session,
          edl: session.edlHistory[nextIdx],
          edlHistoryIndex: nextIdx,
          updatedAtMs: Date.now(),
        },
      };
    }

    let currentEdl: EditDecisionListSnapshot = session.edl;
    let batchResult: BatchLowRiskApprovalResult | undefined;

    if (params.action === 'APPROVE_ALL_LOW_RISK') {
      const approvedIds: string[] = [];
      const skippedIds: string[] = [];
      for (const p of currentEdl.proposals) {
        if (!isProposalLowRiskApprovable(p)) {
          skippedIds.push(p.proposalId);
          continue;
        }
        const res = EditDecisionEngine.approveProposal(currentEdl, p.proposalId, {
          reason: params.reason ?? 'تأیید گروهی پیشنهادهای کم‌ریسک توسط کاربر',
          actorId: params.actorId ?? 'user',
        });
        if (res.ok) {
          currentEdl = res.snapshot;
          approvedIds.push(p.proposalId);
        } else {
          skippedIds.push(p.proposalId);
        }
      }
      batchResult = {
        ok: true,
        snapshot: currentEdl,
        approvedProposalIds: approvedIds,
        skippedProposalIds: skippedIds,
        reasonFa: `${approvedIds.length} پیشنهاد کم‌ریسک با تأیید کاربر تصویب شد و ${skippedIds.length} مورد برای بررسی دستی باقی ماند.`,
      };
    } else {
      const ids = params.proposalIds ?? [];
      for (const id of ids) {
        const res =
          params.action === 'APPROVE'
            ? EditDecisionEngine.approveProposal(currentEdl, id, {
                reason: params.reason ?? 'تأیید توسط کاربر',
                actorId: params.actorId ?? 'user',
              })
            : params.action === 'REJECT'
              ? EditDecisionEngine.rejectProposal(currentEdl, id, {
                  reason: params.reason ?? 'رد توسط کاربر',
                  actorId: params.actorId ?? 'user',
                })
              : EditDecisionEngine.requestReview(currentEdl, id, {
                  reason: params.reason ?? 'بازگشت به حالت بررسی توسط کاربر',
                  actorId: params.actorId ?? 'user',
                });
        if (res.ok) {
          currentEdl = res.snapshot;
        }
      }
    }

    const trimmedHistory = session.edlHistory.slice(0, session.edlHistoryIndex + 1);
    const nextHistory = [...trimmedHistory, currentEdl];
    const nextTrace: SmartAudioEditStageTrace[] = [
      ...session.stageTrace,
      {
        stage: 'USER_REVIEW_AND_APPROVAL',
        status: 'COMPLETED',
        durationMs: 0,
        detail: `action=${params.action}, edlVersion=${currentEdl.edlVersion}`,
      },
    ];

    return {
      job,
      batchResult,
      session: {
        ...session,
        edl: currentEdl,
        edlHistory: nextHistory,
        edlHistoryIndex: nextHistory.length - 1,
        stageTrace: nextTrace,
        updatedAtMs: Date.now(),
      },
    };
  }

  /**
   * Verifies both source audio hash immutability and EDL sample bounds before preview/render.
   */
  public assertSourceAndEdlIntegrity(
    edl: EditDecisionListSnapshot,
    audio: ImportedAudioContext,
  ): void {
    const liveHash = crypto.createHash('sha256').update(audio.rawBytes).digest('hex');
    if (liveHash !== edl.sourceAudioHash || audio.pcmSource.sourceAudioHash !== edl.sourceAudioHash) {
      throw new SmartAudioEditError(
        'SOURCE_AUDIO_HASH_MISMATCH',
        `SOURCE_AUDIO_HASH_MISMATCH: Source audio changed after EDL generation (expected ${edl.sourceAudioHash.slice(0, 12)}, got ${liveHash.slice(0, 12)}).`,
      );
    }

    for (const p of edl.proposals) {
      const checkRange = p.proposedRange ?? p.originalRange;
      if (!checkRange) continue;
      if (
        checkRange.startSample < 0 ||
        checkRange.endSample > audio.totalSourceSamples ||
        checkRange.endSample < checkRange.startSample
      ) {
        throw new SmartAudioEditError(
          'EDL_OUT_OF_BOUNDS',
          `EDL_OUT_OF_BOUNDS: Proposal ${p.proposalId} range [${checkRange.startSample}, ${checkRange.endSample}] exceeds source samples [0, ${audio.totalSourceSamples}].`,
        );
      }
    }
  }

  /**
   * Stage 09: Generate real playable WAV preview (ORIGINAL / EDITED / FULL).
   */
  public async generatePreview(params: {
    readonly job: AudioEditJob;
    readonly session: SmartAudioEditSession;
    readonly audio: ImportedAudioContext;
    readonly mode: SmartEditPreviewMode;
    readonly proposalId?: string;
    readonly contextPaddingMs?: number;
    readonly crossfadeMs?: number;
    readonly abortSignal?: AbortSignal;
    readonly onJobUpdate?: (job: AudioEditJob) => void;
  }): Promise<ManagedSmartEditState & { readonly preview: SmartEditPreviewResult }> {
    if (!params.session.edl) {
      throw new SmartAudioEditError('EDL_REQUIRED', 'EDL_REQUIRED: Generate EDL before previewing.');
    }
    this.assertSourceAndEdlIntegrity(params.session.edl, params.audio);

    let job = transitionAudioEditJob(params.job, 'RENDERING_PREVIEW', { progress: 86 });
    params.onJobUpdate?.(job);

    const t0 = performance.now();
    try {
      const preview = await this.renderer.generatePreview({
        mode: params.mode,
        source: params.audio.pcmSource,
        edl: params.session.edl,
        proposalId: params.proposalId,
        contextPaddingMs: params.contextPaddingMs,
        crossfadeMs: params.crossfadeMs,
        abortSignal: params.abortSignal,
      });
      const elapsedMs = Number((performance.now() - t0).toFixed(2));
      const previewArtifactId = `prev_${crypto.randomUUID().slice(0, 10)}`;

      job = transitionAudioEditJob(job, preview.ok ? 'PREVIEW_READY' : 'WAITING_USER_APPROVAL', {
        progress: preview.ok ? 90 : 82,
        previewArtifactId: preview.ok ? previewArtifactId : undefined,
      });
      params.onJobUpdate?.(job);

      const nextTrace: SmartAudioEditStageTrace[] = [
        ...params.session.stageTrace,
        {
          stage: 'PREVIEW_GENERATION',
          status: preview.ok ? 'COMPLETED' : 'FAILED',
          durationMs: elapsedMs,
          detail: `mode=${params.mode}, durationSec=${preview.durationSec}, bytes=${preview.wavBytes.byteLength}`,
        },
      ];

      return {
        job,
        preview,
        session: {
          ...params.session,
          stageTrace: nextTrace,
          updatedAtMs: Date.now(),
        },
      };
    } catch (err) {
      if (isAbortError(err, params.abortSignal)) {
        job = transitionAudioEditJob(job, 'CANCELLED', {
          errorMessage: 'تولید پیش‌نمایش توسط کاربر لغو شد.',
        });
        params.onJobUpdate?.(job);
        throw new SmartAudioEditError('PREVIEW_CANCELLED', 'PREVIEW_CANCELLED');
      }
      const code = extractErrorCode(err, 'PREVIEW_FAILED');
      const message = err instanceof Error ? err.message : String(err);
      job = transitionAudioEditJob(job, 'FAILED', { errorCode: code, errorMessage: message });
      params.onJobUpdate?.(job);
      throw new SmartAudioEditError(code, message);
    }
  }

  /**
   * Stages 08 & 10: Enforce Approval Gate + Source Hash + Bounds, render sample-exact audio,
   * validate output (VALIDATING_OUTPUT), and export WAV ONLY after validation passes.
   */
  public async renderAndExport(params: {
    readonly job: AudioEditJob;
    readonly session: SmartAudioEditSession;
    readonly audio: ImportedAudioContext;
    readonly config?: Partial<AudioRenderConfig>;
    readonly outputFilePath?: string;
    readonly requireAtLeastOneApproval?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly onJobUpdate?: (job: AudioEditJob) => void;
    readonly onProgress?: (progress: {
      readonly percent: number | null;
      readonly operation: string;
    }) => void;
  }): Promise<
    ManagedSmartEditState & {
      readonly renderResult: AudioRenderResult;
      readonly exportedFilePath: string | null;
      readonly sourceHashImmutableVerified: boolean;
    }
  > {
    if (!params.session.edl) {
      throw new SmartAudioEditError('EDL_REQUIRED', 'EDL_REQUIRED: Generate EDL before rendering.');
    }

    // Approval Gate: block final render unless job passed WAITING_USER_APPROVAL / PREVIEW_READY
    if (
      params.job.status !== 'WAITING_USER_APPROVAL' &&
      params.job.status !== 'PREVIEW_READY'
    ) {
      throw new SmartAudioEditError(
        'APPROVAL_GATE_BLOCKED',
        `APPROVAL_GATE_BLOCKED: Final render requires WAITING_USER_APPROVAL or PREVIEW_READY state (current: ${params.job.status}).`,
      );
    }

    const approvedProposals = params.session.edl.proposals.filter((p) => p.status === 'APPROVED');
    if (params.requireAtLeastOneApproval && approvedProposals.length === 0) {
      throw new SmartAudioEditError(
        'APPROVAL_GATE_BLOCKED',
        'APPROVAL_GATE_BLOCKED: At least one approved proposal is required before final render.',
      );
    }

    this.assertSourceAndEdlIntegrity(params.session.edl, params.audio);

    let job = transitionAudioEditJob(params.job, 'RENDERING_FINAL', { progress: 92 });
    params.onJobUpdate?.(job);

    const t0 = performance.now();
    try {
      const renderResult = await this.renderer.renderFinalAudio({
        edl: params.session.edl,
        source: params.audio.pcmSource,
        config: params.config,
        abortSignal: params.abortSignal,
        onProgress: (p) => {
          if (typeof p.percent === 'number') {
            job = updateJobProgressInPlace(job, 92 + Math.round((p.percent / 100) * 5));
            params.onJobUpdate?.(job);
          }
          params.onProgress?.(p);
        },
      });
      const renderMs = Number((performance.now() - t0).toFixed(2));

      if (renderResult.state === 'CANCELLED' || params.abortSignal?.aborted) {
        job = transitionAudioEditJob(job, 'CANCELLED', {
          errorMessage: 'رندر نهایی توسط کاربر لغو شد.',
        });
        params.onJobUpdate?.(job);
        throw new SmartAudioEditError('RENDER_CANCELLED', 'RENDER_CANCELLED');
      }

      job = transitionAudioEditJob(job, 'VALIDATING_OUTPUT', { progress: 98 });
      params.onJobUpdate?.(job);

      if (!renderResult.ok || !renderResult.postValidation?.passed || !renderResult.output) {
        const reason = renderResult.failureReason ?? 'POST_RENDER_VALIDATION_FAILED';
        job = transitionAudioEditJob(job, 'FAILED', {
          errorCode: 'OUTPUT_VALIDATION_FAILED',
          errorMessage: reason,
        });
        params.onJobUpdate?.(job);
        throw new SmartAudioEditError('OUTPUT_VALIDATION_FAILED', reason);
      }

      // Re-hash original source bytes to prove absolute immutability
      const postHash = crypto.createHash('sha256').update(params.audio.rawBytes).digest('hex');
      const sourceHashImmutableVerified = postHash === params.session.sourceAudioHash;
      if (!sourceHashImmutableVerified) {
        job = transitionAudioEditJob(job, 'FAILED', {
          errorCode: 'SOURCE_AUDIO_MUTATED',
          errorMessage: 'Source audio hash mutated during render.',
        });
        params.onJobUpdate?.(job);
        throw new SmartAudioEditError(
          'SOURCE_AUDIO_MUTATED',
          'SOURCE_AUDIO_MUTATED: Original audio bytes changed during render.',
        );
      }

      let exportedFilePath: string | null = null;
      const tExport = performance.now();
      if (params.outputFilePath && renderResult.outputArtifact) {
        const targetDir = path.dirname(params.outputFilePath);
        fs.mkdirSync(targetDir, { recursive: true });
        const totalBytes = renderResult.outputArtifact.sizeBytes;
        const wavData = await renderResult.outputArtifact.readRange(0, totalBytes);
        fs.writeFileSync(params.outputFilePath, wavData);
        exportedFilePath = params.outputFilePath;
      }
      const exportMs = Number((performance.now() - tExport).toFixed(2));

      job = transitionAudioEditJob(job, 'COMPLETED', {
        progress: 100,
        outputArtifactId: renderResult.output.artifactId,
      });
      params.onJobUpdate?.(job);

      const nextTrace: SmartAudioEditStageTrace[] = [
        ...params.session.stageTrace,
        {
          stage: 'ENGINE_03_AUDIO_RENDERER',
          status: 'COMPLETED',
          durationMs: renderMs,
          detail: `state=${renderResult.state}, applied=${renderResult.appliedProposalIds.length}, outSec=${renderResult.outputDurationSec}`,
        },
        {
          stage: 'FINAL_AUDIO_EXPORT',
          status: 'COMPLETED',
          durationMs: exportMs,
          detail: exportedFilePath
            ? `written=${exportedFilePath}, sourceImmutable=${sourceHashImmutableVerified}`
            : `artifact=${renderResult.output.artifactId} (${renderResult.output.fileSizeBytes}B)`,
        },
      ];

      return {
        job,
        renderResult,
        exportedFilePath,
        sourceHashImmutableVerified,
        session: {
          ...params.session,
          lastRenderResult: renderResult,
          stageTrace: nextTrace,
          updatedAtMs: Date.now(),
        },
      };
    } catch (err) {
      if (err instanceof SmartAudioEditError) {
        if (job.status !== 'FAILED' && job.status !== 'CANCELLED') {
          const next = err.code.includes('CANCELLED') ? 'CANCELLED' : 'FAILED';
          job = transitionAudioEditJob(job, next, {
            errorCode: err.code,
            errorMessage: err.message,
          });
          params.onJobUpdate?.(job);
        }
        throw err;
      }
      if (isAbortError(err, params.abortSignal)) {
        job = transitionAudioEditJob(job, 'CANCELLED', {
          errorMessage: 'رندر نهایی توسط کاربر لغو شد.',
        });
        params.onJobUpdate?.(job);
        throw new SmartAudioEditError('RENDER_CANCELLED', 'RENDER_CANCELLED');
      }
      const code = extractErrorCode(err, 'RENDER_FAILED');
      const message = err instanceof Error ? err.message : String(err);
      job = transitionAudioEditJob(job, 'FAILED', { errorCode: code, errorMessage: message });
      params.onJobUpdate?.(job);
      throw new SmartAudioEditError(code, message);
    }
  }

  public unloadAsrModel(): { readonly unloaded: boolean; readonly rssMb: number } {
    return this.asrEngine.unload();
  }
}

export function getCompletedStages(session: SmartAudioEditSession): readonly SmartAudioEditStage[] {
  return Array.from(
    new Set(session.stageTrace.filter((t) => t.status === 'COMPLETED').map((t) => t.stage)),
  );
}
