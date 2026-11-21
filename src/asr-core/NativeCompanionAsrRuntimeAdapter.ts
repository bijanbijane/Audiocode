/**
 * AVP-P0-001 & AVP-P0-005 — Native Companion Local ASR Runtime Adapter
 *
 * Implements the EXACT SAME canonical `LocalAsrRuntimeAdapter` contract and
 * `AvapardazTranscriptResult` (v2.0.0) schema as `BrowserOnnxAsrRuntimeAdapter`,
 * ensuring single-engine, dual-local-runtime architectural symmetry.
 *
 * Supports two transport backends:
 * 1. Remote loopback Companion HTTP/IPC via `CompanionWebClient` (Browser optional offload / desktop)
 * 2. Direct in-process `LocalSherpaNeuralEngine` / `LocalCompanionService` (Standalone Native / Audition / Conformance)
 *
 * Zero browser-runtime dependency. Zero cloud fallback.
 */

import {
  AVAPARDAZ_ASR_CONTRACT_VERSION,
  AsrModelLoadDescriptor,
  AsrModelValidationReport,
  AsrRuntimeCapabilityReport,
  AsrRuntimeError,
  AsrRuntimeHealthReport,
  AsrRuntimeResourceReport,
  AsrTranscriptionRequest,
  AvapardazTranscriptResult,
  AvapardazTranscriptSegment,
  AvapardazWordSpan,
  LocalAsrRuntimeAdapter,
} from './UnifiedLocalAsrRuntime';
import {
  evaluateModelRuntimeCompatibility,
  PERSIAN_NORMALIZATION_CONTRACT_VERSION,
  validateCanonicalModelManifest,
} from '../lifecycle/CanonicalModelProvenance';
import { detectTextLanguageTag, normalizeWithProfile } from './CoreNormalizationAndLanguage';
import { CompanionWebClient } from '../host-bridge/companion/CompanionWebClient';
import type {
  LocalNeuralTranscriptionResult,
  LocalSherpaNeuralEngine,
} from './LocalSherpaNeuralEngine';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';

export interface NativeCompanionAsrRuntimeAdapterOptions {
  /** Loopback Companion HTTP endpoint (when talking to an external Companion daemon) */
  readonly companionEndpoint?: string;
  readonly companionClient?: CompanionWebClient;
  /** Optional direct native engine for standalone native execution or cross-runtime parity tests */
  readonly directNativeEngine?: LocalSherpaNeuralEngine;
  readonly memoryBudgetManager?: MemoryBudgetManager;
}

export class NativeCompanionAsrRuntimeAdapter implements LocalAsrRuntimeAdapter {
  public readonly runtimeTarget = 'NATIVE_COMPANION_CPU' as const;
  public readonly runtimeName = 'AVAPARDAZ Native Companion Local Runtime (CPU)';

  private readonly client: CompanionWebClient | null;
  private readonly directEngine: LocalSherpaNeuralEngine | null;
  private readonly budget: MemoryBudgetManager;

  private activeModelId: string | null = null;
  private activeModelVersion: string | null = null;
  private activeModelSha256: string = '0'.repeat(64);
  private activeJobId: string | null = null;
  private inferenceVerified = false;
  private lastErrorCode: AsrRuntimeHealthReport['lastErrorCode'] = null;
  private activeJobAborts = new Map<string, AbortController>();

  constructor(options: NativeCompanionAsrRuntimeAdapterOptions = {}) {
    this.directEngine = options.directNativeEngine ?? null;
    this.client =
      options.companionClient ??
      (options.directNativeEngine ? null : new CompanionWebClient(options.companionEndpoint));
    this.budget = options.memoryBudgetManager ?? getSharedMemoryBudgetManager();
  }

  public async probeCapabilities(): Promise<AsrRuntimeCapabilityReport> {
    if (this.directEngine) {
      const status = this.directEngine.getStatus();
      return {
        runtimeTarget: this.runtimeTarget,
        runtimeName: this.runtimeName,
        runtimeVersion: `native-sherpa-onnx (${status.binaryPath ? 'installed' : 'missing'})`,
        available: status.available,
        offlineCapable: true,
        wasmAvailable: false,
        simdAvailable: true,
        sharedArrayBufferAvailable: false,
        opfsAvailable: false,
        webGpuAvailable: false,
        maxThreads: 8,
        memoryBudgetBytes: 2 * 1024 * 1024 * 1024,
        maxSupportedOnnxOpset: 21,
        supportedArchitectures: ['FASTCONFORMER_CTC', 'WHISPER_SEQ2SEQ'],
        notes: status.available
          ? [`Native Companion ready with ${status.installedModels.length} model(s).`]
          : ['Native sherpa-onnx binary or verified local model directory unavailable.'],
      };
    }

    const health = this.client ? await this.client.getHealth() : null;
    const available = Boolean(health?.runtime?.available);
    return {
      runtimeTarget: this.runtimeTarget,
      runtimeName: this.runtimeName,
      runtimeVersion: health?.serviceVersion ?? 'unavailable',
      available,
      offlineCapable: true,
      wasmAvailable: false,
      simdAvailable: true,
      sharedArrayBufferAvailable: false,
      opfsAvailable: false,
      webGpuAvailable: false,
      maxThreads: 8,
      memoryBudgetBytes: 2 * 1024 * 1024 * 1024,
      maxSupportedOnnxOpset: 21,
      supportedArchitectures: ['FASTCONFORMER_CTC', 'WHISPER_SEQ2SEQ'],
      notes: available
        ? [`Connected to Native Companion v${health?.serviceVersion}.`]
        : ['Native Companion unreachable or has no verified models installed.'],
    };
  }

  public async initializeRuntime(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Native Companion initialization cancelled.',
        runtimeTarget: this.runtimeTarget,
      });
    }
    const cap = await this.probeCapabilities();
    if (!cap.available) {
      this.lastErrorCode = 'COMPANION_UNAVAILABLE';
      throw new AsrRuntimeError({
        code: 'COMPANION_UNAVAILABLE',
        message: cap.notes.join(' '),
        runtimeTarget: this.runtimeTarget,
      });
    }
  }

  public async validateModel(descriptor: AsrModelLoadDescriptor): Promise<AsrModelValidationReport> {
    const errors: string[] = [];
    const integrityVerified = /^[a-f0-9]{64}$/i.test(descriptor.verifiedSha256Hex);
    if (!integrityVerified) {
      errors.push('Invalid SHA-256 hex digest for native model descriptor.');
    }

    let compatibility = null;
    if (descriptor.manifest) {
      const mCheck = validateCanonicalModelManifest(descriptor.manifest);
      if (!mCheck.valid) errors.push(...mCheck.errors);
      compatibility = evaluateModelRuntimeCompatibility(descriptor.manifest, {
        runtimeTarget: 'NATIVE_COMPANION_CPU',
        wasmAvailable: false,
        simdAvailable: true,
        webGpuAvailable: false,
        sharedArrayBufferAvailable: false,
        availableMemoryBudgetBytes: 2 * 1024 * 1024 * 1024,
        maxSupportedOnnxOpset: 21,
      });
      if (!compatibility.compatible) {
        errors.push(...compatibility.reasons);
      }
    }

    return {
      valid: errors.length === 0,
      modelId: descriptor.modelId,
      modelVersion: descriptor.modelVersion,
      integrityVerified,
      compatibility,
      errors,
    };
  }

  public async loadModel(descriptor: AsrModelLoadDescriptor, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Native model load cancelled.',
        runtimeTarget: this.runtimeTarget,
      });
    }
    const validation = await this.validateModel(descriptor);
    if (!validation.valid) {
      this.lastErrorCode = 'MODEL_INCOMPATIBLE';
      throw new AsrRuntimeError({
        code: 'MODEL_INCOMPATIBLE',
        message: validation.errors.join(' | '),
        runtimeTarget: this.runtimeTarget,
      });
    }
    this.activeModelId = descriptor.modelId;
    this.activeModelVersion = descriptor.modelVersion;
    this.activeModelSha256 = descriptor.verifiedSha256Hex.toLowerCase();
  }

  public async transcribe(request: AsrTranscriptionRequest): Promise<AvapardazTranscriptResult> {
    if (this.activeJobId !== null) {
      throw new AsrRuntimeError({
        code: 'JOB_ALREADY_RUNNING',
        message: `Native Companion job ${this.activeJobId} is already active.`,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }
    if (!Number.isFinite(request.sampleRate) || request.sampleRate <= 0 || request.totalSamples <= 0) {
      throw new AsrRuntimeError({
        code: 'AUDIO_INVALID',
        message: 'Invalid audio parameters supplied to Native Companion adapter.',
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }

    const startedMs = performance.now();
    this.activeJobId = request.jobId;
    const jobAbort = new AbortController();
    this.activeJobAborts.set(request.jobId, jobAbort);

    const onExternalAbort = () => jobAbort.abort();
    if (request.signal) {
      if (request.signal.aborted) {
        this.activeJobId = null;
        this.activeJobAborts.delete(request.jobId);
        throw new AsrRuntimeError({
          code: 'JOB_CANCELLED',
          message: 'Native Companion transcription cancelled before start.',
          runtimeTarget: this.runtimeTarget,
          jobId: request.jobId,
        });
      }
      request.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const durationSec = request.totalSamples / request.sampleRate;
      // Assemble bounded PCM for Companion transfer
      const pcm = await request.readSourceRange(0, request.totalSamples);
      if (jobAbort.signal.aborted) {
        throw new AsrRuntimeError({
          code: 'JOB_CANCELLED',
          message: 'Native Companion transcription cancelled.',
          runtimeTarget: this.runtimeTarget,
          jobId: request.jobId,
        });
      }

      let nativeResult: LocalNeuralTranscriptionResult;
      if (this.directEngine) {
        const wavBytes = encodeFloat32MonoWav(pcm, request.sampleRate);
        nativeResult = await this.directEngine.transcribe({
          modelId: request.modelDescriptor?.modelId ?? this.activeModelId ?? undefined,
          languageHint: request.languageHint ?? 'fa',
          audioBytes: Buffer.from(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength),
          filename: request.fileName,
          signal: jobAbort.signal,
          onProgress: (prog) => {
            request.onProgress?.({
              jobId: request.jobId,
              runtimeTarget: this.runtimeTarget,
              stage: 'INFERRING',
              percent: prog.percent,
              currentChunk: prog.currentChunk,
              totalChunks: prog.totalChunks,
              elapsedMs: prog.elapsedMs,
              messageFa: `استنتاج محلی Native Companion (${prog.percent}٪)...`,
            });
          },
        });
      } else if (this.client) {
        const companionRes = await this.client.transcribePcm({
          pcm,
          sampleRate: request.sampleRate,
          filename: request.fileName,
          modelId: request.modelDescriptor?.modelId ?? this.activeModelId ?? undefined,
          languageHint: request.languageHint ?? 'fa',
          signal: jobAbort.signal,
          onProgress: (job) => {
            request.onProgress?.({
              jobId: request.jobId,
              runtimeTarget: this.runtimeTarget,
              stage: 'INFERRING',
              percent: job.progressPct,
              currentChunk: job.currentChunk,
              totalChunks: job.totalChunks,
              elapsedMs: job.elapsedMs,
              messageFa: `استنتاج محلی Native Companion (${job.progressPct}٪)...`,
            });
          },
        });
        const mappedArchitecture =
          companionRes.architecture === 'whisper' || companionRes.architecture === 'WHISPER_SEQ2SEQ'
            ? ('whisper' as const)
            : companionRes.architecture === 'qwen3-asr'
              ? ('qwen3-asr' as const)
              : ('nemo-ctc' as const);
        const mappedQuantization = companionRes.quantization === 'FP32' ? ('FP32' as const) : ('INT8' as const);
        const mappedDominantLang = detectTextLanguageTag(companionRes.rawText).language;
        const makeNormMap = (text: string) => ({
          RAW_UNMODIFIED: text,
          'FA-STRICT-V1': normalizeWithProfile(text, 'FA-STRICT-V1') || text,
          'FA-RELAXED-V1': normalizeWithProfile(text, 'FA-RELAXED-V1') || text,
          'EN-NORM-V1': normalizeWithProfile(text, 'EN-NORM-V1') || text,
          'MIXED-NORM-V1': normalizeWithProfile(text, 'MIXED-NORM-V1') || text,
        });
        nativeResult = {
          modelId: companionRes.modelId,
          architecture: mappedArchitecture,
          quantization: mappedQuantization,
          offlineVerified: true,
          durationSec: companionRes.durationSec,
          processingTimeMs: companionRes.processingTimeMs,
          realTimeFactor: companionRes.realTimeFactor,
          dominantLanguage: mappedDominantLang,
          rawText: companionRes.rawText,
          normalizedByProfile: makeNormMap(companionRes.rawText),
          timestampGranularity: companionRes.timestampGranularity,
          segments: companionRes.segments.map((seg, idx) => ({
            id: seg.id,
            index: typeof seg.index === 'number' ? seg.index : idx,
            startSec: seg.startSec,
            endSec: seg.endSec,
            text: seg.text,
            normalizedByProfile: makeNormMap(seg.text),
            language: detectTextLanguageTag(seg.text).language,
            timestampGranularity: seg.timestampGranularity ?? companionRes.timestampGranularity,
            words: seg.words.map((w) => ({
              word: w.word,
              startSec: w.startSec,
              endSec: w.endSec,
            })),
          })),
          sampleRateHz: 16000,
          channelCount: 1,
          audioSha256: request.sourceAssetSha256,
        };
      } else {
        throw new AsrRuntimeError({
          code: 'COMPANION_UNAVAILABLE',
          message: 'No Native Companion transport configured.',
          runtimeTarget: this.runtimeTarget,
          jobId: request.jobId,
        });
      }

      const canonical = normalizeNativeResultToCanonical({
        jobId: request.jobId,
        runtimeTarget: this.runtimeTarget,
        runtimeName: this.runtimeName,
        nativeResult,
        durationSec,
        modelVersion: request.modelDescriptor?.modelVersion ?? this.activeModelVersion ?? nativeResult.quantization,
        modelSha256Hex: request.modelDescriptor?.verifiedSha256Hex ?? this.activeModelSha256,
        processingTimeMs: Math.max(1, Math.round(performance.now() - startedMs)),
        peakMemoryBytes: this.budget.getSnapshot().highWaterMarkBytes,
      });

      this.inferenceVerified = true;
      this.lastErrorCode = null;
      return canonical;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof AsrRuntimeError) {
        this.lastErrorCode = err.code;
        throw err;
      }
      const code = /CANCELLED|ABORTED/i.test(msg)
        ? 'JOB_CANCELLED'
        : /UNAVAILABLE|ECONNREFUSED|FETCH/i.test(msg)
          ? 'COMPANION_UNAVAILABLE'
          : 'INFERENCE_FAILED';
      this.lastErrorCode = code;
      throw new AsrRuntimeError({
        code,
        message: msg,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
        cause: err,
      });
    } finally {
      if (request.signal) {
        request.signal.removeEventListener('abort', onExternalAbort);
      }
      this.activeJobAborts.delete(request.jobId);
      this.activeJobId = null;
    }
  }

  public async cancel(jobId: string): Promise<void> {
    const ctrl = this.activeJobAborts.get(jobId);
    if (ctrl) ctrl.abort();
  }

  public async getHealth(): Promise<AsrRuntimeHealthReport> {
    const cap = await this.probeCapabilities();
    return {
      runtimeTarget: this.runtimeTarget,
      runtimeReady: cap.available,
      modelLoaded: cap.available,
      inferenceVerified: this.inferenceVerified,
      activeModelId: this.activeModelId,
      activeModelVersion: this.activeModelVersion,
      activeJobId: this.activeJobId,
      lastErrorCode: this.lastErrorCode,
      timestampMs: Date.now(),
    };
  }

  public getResourceUsage(): AsrRuntimeResourceReport {
    const snap = this.budget.getSnapshot();
    return {
      runtimeTarget: this.runtimeTarget,
      accountedMemoryBytes: snap.accountedBytes,
      memoryHardLimitBytes: snap.hardLimitBytes,
      activeWorkerCount: 0,
      activeJobCount: this.activeJobId ? 1 : 0,
    };
  }

  public async dispose(): Promise<void> {
    for (const ctrl of this.activeJobAborts.values()) ctrl.abort();
    this.activeJobAborts.clear();
    this.activeJobId = null;
    this.directEngine?.unloadActiveModel();
  }
}

/**
 * Normalizes a Native Companion `LocalNeuralTranscriptionResult` into the exact canonical
 * `AvapardazTranscriptResult` v2.0.0 schema so Browser and Native outputs are structurally identical.
 */
export function normalizeNativeResultToCanonical(params: {
  readonly jobId: string;
  readonly runtimeTarget: 'NATIVE_COMPANION_CPU';
  readonly runtimeName: string;
  readonly nativeResult: LocalNeuralTranscriptionResult;
  readonly durationSec: number;
  readonly modelVersion: string;
  readonly modelSha256Hex: string;
  readonly processingTimeMs: number;
  readonly peakMemoryBytes: number;
}): AvapardazTranscriptResult {
  const { nativeResult, durationSec } = params;
  const total16k = Math.max(0, Math.round(durationSec * 16_000));

  const segments: AvapardazTranscriptSegment[] = [];
  let prevSegEndSample = 0;

  for (let i = 0; i < nativeResult.segments.length; i++) {
    const seg = nativeResult.segments[i];
    const startSec = Math.max(0, Math.min(durationSec, seg.startSec));
    const endSec = Math.max(startSec, Math.min(durationSec, seg.endSec));
    const startSample16k = Math.max(prevSegEndSample, Math.min(total16k, Math.round(startSec * 16_000)));
    const endSample16k = Math.max(startSample16k, Math.min(total16k, Math.round(endSec * 16_000)));
    prevSegEndSample = endSample16k;

    const words: AvapardazWordSpan[] = [];
    let prevWordEnd = startSample16k;
    for (const w of seg.words ?? []) {
      const ws = Math.max(prevWordEnd, Math.min(endSample16k, Math.round(w.startSec * 16_000)));
      const we = Math.max(ws, Math.min(endSample16k, Math.round(w.endSec * 16_000)));
      prevWordEnd = we;
      words.push({
        word: w.word,
        normalizedWord: normalizeWithProfile(w.word, 'FA-STRICT-V1') || w.word,
        startSec: Number((ws / 16_000).toFixed(6)),
        endSec: Number((we / 16_000).toFixed(6)),
        startSample16k: ws,
        endSample16k: we,
        confidence:
          typeof (w as { confidence?: number }).confidence === 'number' &&
          Number.isFinite((w as { confidence?: number }).confidence)
            ? ((w as { confidence?: number }).confidence as number)
            : 0,
      });
    }

    const rawText = (seg.text || '').trim();
    const normalizedText = normalizeWithProfile(rawText, 'MIXED-NORM-V1') || rawText;
    const lang = detectTextLanguageTag(normalizedText || rawText).language;

    segments.push({
      id: seg.id || `${params.jobId}_seg_${i + 1}`,
      index: i,
      startSec: Number((startSample16k / 16_000).toFixed(6)),
      endSec: Number((endSample16k / 16_000).toFixed(6)),
      startSample16k,
      endSample16k,
      rawText,
      normalizedText,
      language: lang,
      confidence: words.length > 0
        ? Number((words.reduce((acc, w) => acc + w.confidence, 0) / words.length).toFixed(4))
        : 0,
      timestampGranularity: seg.timestampGranularity,
      words,
    });
  }

  const rawText = segments.map((s) => s.rawText).join(' ').trim();
  const normalizedText = segments.map((s) => s.normalizedText).join(' ').trim();
  const realTimeFactor =
    durationSec > 0 ? Number(((params.processingTimeMs / 1000) / durationSec).toFixed(4)) : 0;

  return {
    contractVersion: AVAPARDAZ_ASR_CONTRACT_VERSION,
    jobId: params.jobId,
    runtimeTarget: params.runtimeTarget,
    runtimeName: params.runtimeName,
    executionProvider: 'cpu',
    modelId: nativeResult.modelId,
    modelVersion: params.modelVersion,
    modelSha256Hex: params.modelSha256Hex,
    architecture: nativeResult.architecture,
    normalizationVersion: PERSIAN_NORMALIZATION_CONTRACT_VERSION,
    offlineVerified: true,
    sampleRateHz: 16000,
    durationSec: Number(durationSec.toFixed(6)),
    processingTimeMs: params.processingTimeMs,
    realTimeFactor,
    dominantLanguage: detectTextLanguageTag(normalizedText || rawText).language,
    rawText,
    normalizedText,
    timestampGranularity: nativeResult.timestampGranularity,
    segments,
    peakMemoryBytes: params.peakMemoryBytes,
  };
}

function encodeFloat32MonoWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, Number.isFinite(pcm[i]) ? pcm[i] : 0));
    view.setInt16(off, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    off += 2;
  }
  return new Uint8Array(buf);
}
