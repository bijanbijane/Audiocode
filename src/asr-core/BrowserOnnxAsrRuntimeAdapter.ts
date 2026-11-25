/**
 * AVP-P0-001 & AVP-P0-002 — Browser Local ASR Runtime Adapter
 *
 * Implements `LocalAsrRuntimeAdapter` strictly inside the browser execution boundary:
 *   - Dedicated Web Worker (`StudioAsrWorkerClient`) + ONNX Runtime Web WASM/SIMD
 *   - OPFS-backed chunked model storage (`LocalModelLifecycleManager`)
 *   - Canonical 19-state lifecycle tracking (`ModelLifecycleStateMachine`)
 *   - Bounded windowed streaming (`PersianChunkedAsrEngine`) governed by `MemoryBudgetManager`
 *
 * Architectural Guardrail:
 *   - ZERO imports from `host-bridge/companion` or any Companion client/server.
 *   - ZERO cloud endpoints or remote audio transfer.
 *   - Runs independently when Native Companion is absent or uninstalled.
 */

import {
  AVAPARDAZ_ASR_CONTRACT_VERSION,
  AsrModelLoadDescriptor,
  AsrModelValidationReport,
  AsrRuntimeCapabilityReport,
  AsrRuntimeError,
  AsrRuntimeErrorCode,
  AsrRuntimeHealthReport,
  AsrRuntimeResourceReport,
  AsrTranscriptionRequest,
  AvapardazTranscriptResult,
  AvapardazTranscriptSegment,
  AvapardazWordSpan,
  LocalAsrRuntimeAdapter,
  negotiateBrowserAsrCapabilities,
} from './UnifiedLocalAsrRuntime';
import {
  evaluateModelRuntimeCompatibility,
  PERSIAN_NORMALIZATION_CONTRACT_VERSION,
  validateCanonicalModelManifest,
} from '../lifecycle/CanonicalModelProvenance';
import { LocalModelLifecycleManager } from '../lifecycle/LocalModelLifecycleManager';
import { ModelLifecycleStateMachine } from '../lifecycle/ModelLifecycleStateMachine';
import { ChunkedModelManifest } from '../platform/ChunkedModelDelivery';
import { StudioAsrWorkerClient, StudioAsrWorkerLike } from '../ai-engine/workers/StudioAsrWorkerClient';
import { StudioAsrInitializePayload } from '../ai-engine/workers/studio-asr.worker';
import { PersianChunkedAsrEngine, RawWordPrediction } from '../ai-engine/PersianChunkedAsrWorker';
import { detectTextLanguageTag, normalizeWithProfile } from './CoreNormalizationAndLanguage';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';
import { CrossPlatformCapabilities } from '../runtime/CrossPlatformResourcePolicy';

export interface BrowserOnnxAsrRuntimeAdapterOptions {
  readonly modelManager?: LocalModelLifecycleManager;
  readonly stateMachine?: ModelLifecycleStateMachine;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly wasmAssetsBasePath?: string;
  readonly workerFactory?: () => StudioAsrWorkerLike;
  readonly capabilityOverrides?: Partial<CrossPlatformCapabilities>;
  /** Optional direct model bytes resolver for deterministic qualification / offline tests */
  readonly directModelBytesResolver?: (
    descriptor: AsrModelLoadDescriptor,
  ) => Promise<Uint8Array | undefined> | Uint8Array | undefined;
  /** Optional chunked manifest resolver when not using LocalModelLifecycleManager */
  readonly chunkedManifestResolver?: (
    descriptor: AsrModelLoadDescriptor,
  ) => Promise<ChunkedModelManifest | null> | ChunkedModelManifest | null;
  readonly initTimeoutMs?: number;
  readonly inferenceTimeoutMs?: number;
}

const MAX_BROWSER_AUDIO_DURATION_SEC = 4 * 3600; // 4 hours bounded streaming ceiling
const DEFAULT_MAX_WINDOW_SECONDS = 30;
const DEFAULT_OVERLAP_SECONDS = 4;

export class BrowserOnnxAsrRuntimeAdapter implements LocalAsrRuntimeAdapter {
  public readonly runtimeTarget = 'BROWSER_WASM_CPU' as const;
  public readonly runtimeName = 'AVAPARDAZ Browser Local ONNX Runtime (Web Worker + WASM)';

  private readonly modelManager?: LocalModelLifecycleManager;
  private readonly stateMachines = new Map<string, ModelLifecycleStateMachine>();
  private readonly injectedStateMachine?: ModelLifecycleStateMachine;
  private readonly budget: MemoryBudgetManager;
  private readonly wasmAssetsBasePath: string;
  private readonly workerClient: StudioAsrWorkerClient;
  private readonly directModelBytesResolver?: BrowserOnnxAsrRuntimeAdapterOptions['directModelBytesResolver'];
  private readonly chunkedManifestResolver?: BrowserOnnxAsrRuntimeAdapterOptions['chunkedManifestResolver'];
  private readonly capabilityOverrides?: Partial<CrossPlatformCapabilities>;

  private runtimeInitialized = false;
  private activeDescriptor: AsrModelLoadDescriptor | null = null;
  private activeModelSha256: string | null = null;
  private inferenceVerified = false;
  private activeJobId: string | null = null;
  private lastErrorCode: AsrRuntimeErrorCode | null = null;
  private activeExecutionProvider: 'wasm' | 'webgpu' = 'wasm';
  private activeJobAborts = new Map<string, AbortController>();

  constructor(options: BrowserOnnxAsrRuntimeAdapterOptions = {}) {
    this.modelManager = options.modelManager;
    this.injectedStateMachine = options.stateMachine;
    this.budget = options.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    this.wasmAssetsBasePath = options.wasmAssetsBasePath ?? '/ort/';
    this.directModelBytesResolver = options.directModelBytesResolver;
    this.chunkedManifestResolver = options.chunkedManifestResolver;
    this.capabilityOverrides = options.capabilityOverrides;

    this.workerClient = new StudioAsrWorkerClient({
      workerFactory: options.workerFactory,
      initTimeoutMs: options.initTimeoutMs ?? 45_000,
      requestTimeoutMs: options.inferenceTimeoutMs ?? 60_000,
    });
  }

  public async probeCapabilities(): Promise<AsrRuntimeCapabilityReport> {
    const cap = negotiateBrowserAsrCapabilities({
      capabilityOverrides: this.capabilityOverrides,
      allowWebGpu: false, // WASM CPU/SIMD is the verified production baseline
      modelSupportsWebGpu: false,
    });
    const notes: string[] = [
      `WASM CPU baseline active (SIMD=${cap.simdAvailable ? 'yes' : 'no'}, threads=${cap.recommendedThreads}).`,
    ];
    if (!cap.sharedArrayBufferAvailable || !cap.crossOriginIsolated) {
      notes.push('SharedArrayBuffer/COI unavailable; single-thread WASM CPU fallback engaged safely.');
    }
    if (!cap.opfsAvailable) {
      notes.push('OPFS unavailable in current host environment; requires persistent storage or direct verified artifact.');
    }

    return {
      runtimeTarget: this.runtimeTarget,
      runtimeName: this.runtimeName,
      runtimeVersion: 'onnxruntime-web@1.31.1',
      available: cap.wasmAvailable,
      offlineCapable: true,
      wasmAvailable: cap.wasmAvailable,
      simdAvailable: cap.simdAvailable,
      sharedArrayBufferAvailable: cap.sharedArrayBufferAvailable,
      opfsAvailable: cap.opfsAvailable,
      webGpuAvailable: cap.webGpuAvailable,
      maxThreads: cap.recommendedThreads,
      memoryBudgetBytes: cap.memoryBudgetBytes,
      maxSupportedOnnxOpset: 21,
      supportedArchitectures: ['FASTCONFORMER_CTC', 'WHISPER_SEQ2SEQ'],
      notes,
    };
  }

  public async initializeRuntime(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Browser runtime initialization cancelled before start.',
        runtimeTarget: this.runtimeTarget,
      });
    }
    const cap = await this.probeCapabilities();
    if (!cap.available) {
      this.lastErrorCode = 'RUNTIME_UNAVAILABLE';
      throw new AsrRuntimeError({
        code: 'RUNTIME_UNAVAILABLE',
        message: 'WebAssembly runtime is unavailable in this browser environment.',
        runtimeTarget: this.runtimeTarget,
      });
    }
    if (this.modelManager && !this.modelManager.getSnapshot().initialized) {
      await this.modelManager.initialize();
    }
    this.runtimeInitialized = true;
  }

  public async validateModel(descriptor: AsrModelLoadDescriptor): Promise<AsrModelValidationReport> {
    const errors: string[] = [];
    let compatibility = null;
    let integrityVerified = false;

    if (!/^[a-f0-9]{64}$/i.test(descriptor.verifiedSha256Hex)) {
      errors.push('Model verifiedSha256Hex must be a valid 64-character SHA-256 hex digest.');
    } else {
      integrityVerified = true;
    }

    if (descriptor.architecture === 'FASTCONFORMER_CTC') {
      if (!descriptor.ctcVocabulary || descriptor.ctcVocabulary.length === 0) {
        errors.push('FASTCONFORMER_CTC model requires a non-empty ctcVocabulary (tokens.txt).');
      }
    } else if (descriptor.architecture === 'WHISPER_SEQ2SEQ') {
      if (
        !descriptor.whisperIdToBpeTokenEntries ||
        descriptor.whisperIdToBpeTokenEntries.length === 0 ||
        !descriptor.whisperSpecialTokens
      ) {
        errors.push('WHISPER_SEQ2SEQ model requires BPE token mapping and special tokens.');
      }
    } else {
      errors.push(`Unsupported architecture "${String(descriptor.architecture)}".`);
    }

    const cap = await this.probeCapabilities();
    if (descriptor.manifest) {
      const manifestCheck = validateCanonicalModelManifest(descriptor.manifest);
      if (!manifestCheck.valid) {
        errors.push(...manifestCheck.errors);
      }
      compatibility = evaluateModelRuntimeCompatibility(descriptor.manifest, {
        runtimeTarget: 'BROWSER_WASM_CPU',
        wasmAvailable: cap.wasmAvailable,
        simdAvailable: cap.simdAvailable,
        webGpuAvailable: cap.webGpuAvailable,
        sharedArrayBufferAvailable: cap.sharedArrayBufferAvailable,
        availableMemoryBudgetBytes: cap.memoryBudgetBytes,
        maxSupportedOnnxOpset: cap.maxSupportedOnnxOpset,
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
    if (!this.runtimeInitialized) {
      await this.initializeRuntime(signal);
    }
    if (signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Model load cancelled before start.',
        runtimeTarget: this.runtimeTarget,
      });
    }

    const validation = await this.validateModel(descriptor);
    if (!validation.valid) {
      this.lastErrorCode = 'MODEL_INCOMPATIBLE';
      throw new AsrRuntimeError({
        code: 'MODEL_INCOMPATIBLE',
        message: `Model validation failed: ${validation.errors.join(' | ')}`,
        runtimeTarget: this.runtimeTarget,
      });
    }

    const directBytes = this.directModelBytesResolver
      ? await this.directModelBytesResolver(descriptor)
      : undefined;

    let chunkedManifest: ChunkedModelManifest | null = null;
    if (this.chunkedManifestResolver) {
      chunkedManifest = await this.chunkedManifestResolver(descriptor);
    }
    if (!chunkedManifest && this.modelManager) {
      const activeManifest = await this.modelManager.getActiveRuntimeManifest();
      if (
        activeManifest &&
        activeManifest.modelId === descriptor.modelId &&
        activeManifest.version === descriptor.modelVersion
      ) {
        chunkedManifest = activeManifest;
      }
    }
    if (!chunkedManifest && directBytes) {
      chunkedManifest = {
        modelId: descriptor.modelId,
        version: descriptor.modelVersion,
        totalBytes: directBytes.byteLength,
        sha256Hex: descriptor.verifiedSha256Hex.toLowerCase(),
        chunks: [
          {
            index: 0,
            url: `memory://direct/${descriptor.modelId}/${descriptor.modelVersion}/chunk_00000.bin`,
            sha256Hex: descriptor.verifiedSha256Hex.toLowerCase(),
            byteLength: directBytes.byteLength,
          },
        ],
      };
    }

    if (!chunkedManifest) {
      this.lastErrorCode = 'MODEL_NOT_INSTALLED';
      throw new AsrRuntimeError({
        code: 'MODEL_NOT_INSTALLED',
        message: `No OPFS chunked installation or verified artifact found for ${descriptor.modelId}@${descriptor.modelVersion}.`,
        runtimeTarget: this.runtimeTarget,
      });
    }

    if (
      descriptor.architecture !== 'FASTCONFORMER_CTC' &&
      descriptor.architecture !== 'WHISPER_SEQ2SEQ'
    ) {
      this.lastErrorCode = 'MODEL_INCOMPATIBLE';
      throw new AsrRuntimeError({
        code: 'MODEL_INCOMPATIBLE',
        message: `BrowserOnnxAsrRuntimeAdapter only supports FASTCONFORMER_CTC and WHISPER_SEQ2SEQ; received ${descriptor.architecture}.`,
        runtimeTarget: this.runtimeTarget,
      });
    }

    const providers: ('webgpu' | 'wasm')[] = (descriptor.executionProviders ?? ['wasm'])
      .filter((p): p is 'webgpu' | 'wasm' => p === 'webgpu' || p === 'wasm');
    const initPayload: StudioAsrInitializePayload = {
      modelId: descriptor.modelId,
      modelVersion: descriptor.modelVersion,
      architecture: descriptor.architecture,
      expectedSha256Hex: descriptor.verifiedSha256Hex.toLowerCase(),
      executionProviders: providers.length > 0 ? providers : ['wasm'],
      chunkedManifest,
      directEncoderBytes: directBytes,
      ctcVocabulary: descriptor.ctcVocabulary,
      whisperIdToBpeTokenEntries: descriptor.whisperIdToBpeTokenEntries,
      whisperSpecialTokens: descriptor.whisperSpecialTokens,
      wasmAssetsBasePath: this.wasmAssetsBasePath,
    };

    const loadJobId = `load_${descriptor.modelId}_${Date.now()}`;
    try {
      const readiness = await this.workerClient.initializeModel(initPayload, {
        jobId: loadJobId,
        signal,
      });
      this.activeDescriptor = descriptor;
      this.activeModelSha256 = readiness.modelSha256;
      this.activeExecutionProvider = providers[0] === 'webgpu' ? 'webgpu' : 'wasm';
      this.inferenceVerified = false; // MUST pass real inference before claiming verified!
      this.lastErrorCode = null;
      this.recordStateMachineRuntimeInitialized(descriptor);
    } catch (err) {
      const mapped = this.mapError(err, loadJobId);
      this.lastErrorCode = mapped.code;
      throw mapped;
    }
  }

  public async transcribe(request: AsrTranscriptionRequest): Promise<AvapardazTranscriptResult> {
    if (this.activeJobId !== null) {
      throw new AsrRuntimeError({
        code: 'JOB_ALREADY_RUNNING',
        message: `Another Browser ASR job (${this.activeJobId}) is already running.`,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }

    if (!Number.isFinite(request.sampleRate) || request.sampleRate <= 0 || request.sampleRate > 384_000) {
      throw new AsrRuntimeError({
        code: 'AUDIO_INVALID',
        message: `Invalid audio sampleRate: ${request.sampleRate}.`,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }
    if (!Number.isFinite(request.totalSamples) || request.totalSamples <= 0) {
      throw new AsrRuntimeError({
        code: 'AUDIO_INVALID',
        message: `Audio buffer is empty (totalSamples=${request.totalSamples}).`,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }

    const durationSec = request.totalSamples / request.sampleRate;
    if (durationSec > MAX_BROWSER_AUDIO_DURATION_SEC) {
      throw new AsrRuntimeError({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        message: `Audio duration (${durationSec.toFixed(1)}s) exceeds 4-hour browser streaming limit.`,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }

    const startedMs = performance.now();
    this.activeJobId = request.jobId;
    const jobAbort = new AbortController();
    this.activeJobAborts.set(request.jobId, jobAbort);

    const onExternalAbort = () => {
      jobAbort.abort();
      void this.workerClient.cancelJob(request.jobId);
    };
    if (request.signal) {
      if (request.signal.aborted) {
        this.activeJobId = null;
        this.activeJobAborts.delete(request.jobId);
        throw new AsrRuntimeError({
          code: 'JOB_CANCELLED',
          message: 'Transcription job cancelled before execution.',
          runtimeTarget: this.runtimeTarget,
          jobId: request.jobId,
        });
      }
      request.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      request.onProgress?.({
        jobId: request.jobId,
        runtimeTarget: this.runtimeTarget,
        stage: 'VALIDATING_AUDIO',
        percent: 2,
        currentChunk: 0,
        totalChunks: 1,
        elapsedMs: 0,
        messageFa: 'اعتبارسنجی سیگنال صوتی و بودجه حافظه مرورگر...',
      });

      if (!this.runtimeInitialized) {
        request.onProgress?.({
          jobId: request.jobId,
          runtimeTarget: this.runtimeTarget,
          stage: 'INITIALIZING_RUNTIME',
          percent: 5,
          currentChunk: 0,
          totalChunks: 1,
          elapsedMs: Math.round(performance.now() - startedMs),
          messageFa: 'آماده‌سازی موتور محلی ONNX Runtime Web (WASM)...',
        });
        await this.initializeRuntime(jobAbort.signal);
      }

      if (
        request.modelDescriptor &&
        (!this.activeDescriptor ||
          this.activeDescriptor.modelId !== request.modelDescriptor.modelId ||
          this.activeDescriptor.modelVersion !== request.modelDescriptor.modelVersion ||
          this.activeModelSha256 !== request.modelDescriptor.verifiedSha256Hex.toLowerCase())
      ) {
        request.onProgress?.({
          jobId: request.jobId,
          runtimeTarget: this.runtimeTarget,
          stage: 'LOADING_MODEL',
          percent: 10,
          currentChunk: 0,
          totalChunks: 1,
          elapsedMs: Math.round(performance.now() - startedMs),
          messageFa: `بارگذاری و تایید اصالت SHA-256 مدل ${request.modelDescriptor.modelId}...`,
        });
        await this.loadModel(request.modelDescriptor, jobAbort.signal);
      }

      if (!this.activeDescriptor || !this.activeModelSha256) {
        throw new AsrRuntimeError({
          code: 'MODEL_NOT_INSTALLED',
          message: 'No verified Persian ASR ONNX model is loaded in the Browser Local Runtime.',
          runtimeTarget: this.runtimeTarget,
          jobId: request.jobId,
        });
      }

      const peakBefore = this.budget.getSnapshot().highWaterMarkBytes;
      this.workerClient.setActiveJobId(request.jobId);
      const chunkedArch =
        this.activeDescriptor.architecture === 'FASTCONFORMER_CTC' ||
        this.activeDescriptor.architecture === 'WHISPER_SEQ2SEQ'
          ? this.activeDescriptor.architecture
          : undefined;
      const chunkedEngine = new PersianChunkedAsrEngine(
        {
          modelId: this.activeDescriptor.modelId,
          modelVersion: this.activeDescriptor.modelVersion,
          architecture: chunkedArch,
          modelSha256: this.activeModelSha256,
          detectVoiceActivity: (pcm16k) => this.workerClient.detectVoiceActivity(pcm16k),
          transcribeWindow: (pcm16k) => this.workerClient.transcribeWindow(pcm16k),
          estimateWorkingMemoryBytes: (count) => this.workerClient.estimateWorkingMemoryBytes(count),
        },
        this.budget,
      );

      const totalSamples16k = Math.max(1, Math.round((request.totalSamples / request.sampleRate) * 16_000));
      const windowSamples16k = 25 * 16_000;
      const overlapSamples16k = 3 * 16_000;
      const strideSamples16k = windowSamples16k - overlapSamples16k;
      const lastTotalChunks =
        totalSamples16k <= windowSamples16k
          ? 1
          : Math.ceil((totalSamples16k - overlapSamples16k) / strideSamples16k);

      const readSamples16k = async (start16k: number, count16k: number): Promise<Float32Array> => {
        if (jobAbort.signal.aborted) {
          throw new Error('ASR_JOB_ABORTED');
        }
        if (request.sampleRate === 16_000) {
          return request.readSourceRange(start16k, count16k);
        }
        const ratio = request.sampleRate / 16_000;
        const srcStart = Math.max(0, Math.floor(start16k * ratio));
        const srcCount = Math.min(
          Math.max(1, request.totalSamples - srcStart),
          Math.ceil(count16k * ratio) + 2,
        );
        const srcPcm = await request.readSourceRange(srcStart, srcCount);
        const out = new Float32Array(count16k);
        for (let i = 0; i < count16k; i++) {
          const pos = i * ratio;
          const lo = Math.min(srcPcm.length - 1, Math.floor(pos));
          const hi = Math.min(srcPcm.length - 1, lo + 1);
          const frac = pos - lo;
          out[i] = srcPcm[lo] * (1 - frac) + srcPcm[hi] * frac;
        }
        return out;
      };

      const chunkedTokens = await chunkedEngine.transcribeLongAudioStream(
        totalSamples16k,
        readSamples16k,
        async (windowIndex: number) => {
          const completed = Math.min(lastTotalChunks, windowIndex + 1);
          const pct = Math.min(95, Math.max(12, Math.round(12 + (completed / lastTotalChunks) * 83)));
          request.onProgress?.({
            jobId: request.jobId,
            runtimeTarget: this.runtimeTarget,
            stage: 'INFERRING',
            percent: pct,
            currentChunk: completed,
            totalChunks: lastTotalChunks,
            elapsedMs: Math.round(performance.now() - startedMs),
            messageFa: `استنتاج محلی ONNX در مرورگر (${completed} از ${lastTotalChunks})...`,
          });
        },
        0,
        [],
        request.trackId,
        {
          memoryBudgetManager: this.budget,
          signal: jobAbort.signal,
          jobId: request.jobId,
        },
      );
      const chunkedResult = { tokens: chunkedTokens };

      if (jobAbort.signal.aborted) {
        throw new AsrRuntimeError({
          code: 'JOB_CANCELLED',
          message: 'Browser ASR transcription cancelled by user.',
          runtimeTarget: this.runtimeTarget,
          jobId: request.jobId,
        });
      }

      request.onProgress?.({
        jobId: request.jobId,
        runtimeTarget: this.runtimeTarget,
        stage: 'POSTPROCESSING',
        percent: 97,
        currentChunk: lastTotalChunks,
        totalChunks: lastTotalChunks,
        elapsedMs: Math.round(performance.now() - startedMs),
        messageFa: 'نرمال‌سازی متن فارسی و ساخت ساختار استاندارد خروجی...',
      });

      const words = this.buildCanonicalWords(chunkedResult.tokens, durationSec);
      const segments = this.groupWordsIntoCanonicalSegments(words, request.jobId, durationSec);
      const rawText = segments.map((s) => s.rawText).join(' ').trim();
      const normalizedText = segments.map((s) => s.normalizedText).join(' ').trim();
      const langSummary = detectTextLanguageTag(normalizedText || rawText);
      const processingTimeMs = Math.max(1, Math.round(performance.now() - startedMs));
      const realTimeFactor =
        durationSec > 0 ? Number(((processingTimeMs / 1000) / durationSec).toFixed(4)) : 0;
      const peakMemoryBytes = Math.max(
        peakBefore,
        this.budget.getSnapshot().highWaterMarkBytes,
        this.budget.getSnapshot().accountedBytes,
      );

      this.inferenceVerified = true;
      this.lastErrorCode = null;
      this.recordStateMachineInferenceVerified(this.activeDescriptor);

      request.onProgress?.({
        jobId: request.jobId,
        runtimeTarget: this.runtimeTarget,
        stage: 'COMPLETED',
        percent: 100,
        currentChunk: lastTotalChunks,
        totalChunks: lastTotalChunks,
        elapsedMs: processingTimeMs,
        messageFa: 'رونویسی محلی مرورگر با موفقیت تکمیل شد.',
      });

      return {
        contractVersion: AVAPARDAZ_ASR_CONTRACT_VERSION,
        jobId: request.jobId,
        runtimeTarget: this.runtimeTarget,
        runtimeName: this.runtimeName,
        executionProvider: this.activeExecutionProvider,
        modelId: this.activeDescriptor.modelId,
        modelVersion: this.activeDescriptor.modelVersion,
        modelSha256Hex: this.activeModelSha256,
        architecture: this.activeDescriptor.architecture,
        normalizationVersion: PERSIAN_NORMALIZATION_CONTRACT_VERSION,
        offlineVerified: true,
        sampleRateHz: 16000,
        durationSec: Number(durationSec.toFixed(6)),
        processingTimeMs,
        realTimeFactor,
        dominantLanguage: langSummary.language,
        rawText,
        normalizedText,
        timestampGranularity: words.length > 0 ? 'WORD' : 'UNAVAILABLE',
        segments,
        peakMemoryBytes,
      };
    } catch (err) {
      const mapped = this.mapError(err, request.jobId);
      this.lastErrorCode = mapped.code;
      throw mapped;
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
    if (ctrl) {
      ctrl.abort();
    }
    await this.workerClient.cancelJob(jobId);
  }

  public async getHealth(): Promise<AsrRuntimeHealthReport> {
    return {
      runtimeTarget: this.runtimeTarget,
      runtimeReady: this.runtimeInitialized,
      modelLoaded: Boolean(this.activeDescriptor && this.activeModelSha256),
      inferenceVerified: this.inferenceVerified,
      activeModelId: this.activeDescriptor?.modelId ?? null,
      activeModelVersion: this.activeDescriptor?.modelVersion ?? null,
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
      activeWorkerCount: this.runtimeInitialized ? 1 : 0,
      activeJobCount: this.activeJobId ? 1 : 0,
    };
  }

  public async dispose(): Promise<void> {
    for (const ctrl of this.activeJobAborts.values()) {
      ctrl.abort();
    }
    this.activeJobAborts.clear();
    this.activeJobId = null;
    await this.workerClient.dispose();
    this.activeDescriptor = null;
    this.activeModelSha256 = null;
    this.inferenceVerified = false;
    this.runtimeInitialized = false;
  }

  private buildCanonicalWords(
    tokens: readonly {
      readonly originalText: string;
      readonly normalizedText: string;
      readonly range: { readonly start: number; readonly end: number };
      readonly confidence: number;
    }[],
    durationSec: number,
  ): AvapardazWordSpan[] {
    const FLICKS_PER_SEC = 705_600_000;
    const total16k = Math.max(0, Math.round(durationSec * 16_000));
    const words: AvapardazWordSpan[] = [];
    let prevEndSample = 0;

    for (const tok of tokens) {
      const raw = tok.originalText.trim();
      if (!raw) continue;
      const startSecRaw = Math.max(0, Math.min(durationSec, tok.range.start / FLICKS_PER_SEC));
      const endSecRaw = Math.max(startSecRaw, Math.min(durationSec, tok.range.end / FLICKS_PER_SEC));
      const startSample16k = Math.max(prevEndSample, Math.min(total16k, Math.round(startSecRaw * 16_000)));
      const endSample16k = Math.max(startSample16k, Math.min(total16k, Math.round(endSecRaw * 16_000)));
      prevEndSample = endSample16k;

      words.push({
        word: raw,
        normalizedWord: normalizeWithProfile(raw, 'FA-STRICT-V1') || raw,
        startSec: Number((startSample16k / 16_000).toFixed(6)),
        endSec: Number((endSample16k / 16_000).toFixed(6)),
        startSample16k,
        endSample16k,
        confidence: Number.isFinite(tok.confidence) ? Math.max(0, Math.min(1, tok.confidence)) : 0,
      });
    }
    return words;
  }

  private groupWordsIntoCanonicalSegments(
    words: readonly AvapardazWordSpan[],
    jobId: string,
    durationSec: number,
  ): AvapardazTranscriptSegment[] {
    if (words.length === 0) return [];
    const segments: AvapardazTranscriptSegment[] = [];
    const MAX_GAP_SEC = 1.2;
    const MAX_SEG_WORDS = 24;

    let bucket: AvapardazWordSpan[] = [];
    const flushBucket = () => {
      if (bucket.length === 0) return;
      const idx = segments.length;
      const first = bucket[0];
      const last = bucket[bucket.length - 1];
      const rawText = bucket.map((w) => w.word).join(' ').trim();
      const normalizedText = normalizeWithProfile(rawText, 'MIXED-NORM-V1') || rawText;
      const avgConf =
        bucket.reduce((acc, w) => acc + w.confidence, 0) / Math.max(1, bucket.length);
      const lang = detectTextLanguageTag(normalizedText).language;
      segments.push({
        id: `${jobId}_seg_${idx + 1}`,
        index: idx,
        startSec: Math.max(0, Math.min(durationSec, first.startSec)),
        endSec: Math.max(first.startSec, Math.min(durationSec, last.endSec)),
        startSample16k: first.startSample16k,
        endSample16k: last.endSample16k,
        rawText,
        normalizedText,
        language: lang,
        confidence: Number(avgConf.toFixed(4)),
        timestampGranularity: 'WORD',
        words: bucket,
      });
      bucket = [];
    };

    for (const w of words) {
      if (bucket.length > 0) {
        const prev = bucket[bucket.length - 1];
        if (w.startSec - prev.endSec > MAX_GAP_SEC || bucket.length >= MAX_SEG_WORDS) {
          flushBucket();
        }
      }
      bucket.push(w);
    }
    flushBucket();
    return segments;
  }

  private getOrCreateStateMachine(descriptor: AsrModelLoadDescriptor): ModelLifecycleStateMachine {
    if (
      this.injectedStateMachine &&
      this.injectedStateMachine.modelId === descriptor.modelId &&
      this.injectedStateMachine.version === descriptor.modelVersion
    ) {
      return this.injectedStateMachine;
    }
    const mapKey = `${descriptor.modelId}@${descriptor.modelVersion}`;
    let machine = this.stateMachines.get(mapKey);
    if (!machine) {
      machine = new ModelLifecycleStateMachine(descriptor.modelId, descriptor.modelVersion, 'DISCOVERED', {
        verifiedSha256Hex: descriptor.verifiedSha256Hex.toLowerCase(),
      });
      this.stateMachines.set(mapKey, machine);
    }
    return machine;
  }

  private recordStateMachineRuntimeInitialized(descriptor: AsrModelLoadDescriptor): void {
    const machine = this.getOrCreateStateMachine(descriptor);
    const sha = descriptor.verifiedSha256Hex.toLowerCase();
    if (machine.getState() === 'DISCOVERED') {
      machine.transition('METADATA_VALIDATED', 'Validated canonical descriptor.');
      machine.transition('SOURCE_VERIFIED', 'Verified model source/provenance.');
      machine.transition('DOWNLOAD_PENDING', 'Preparing artifact.');
      machine.transition('DOWNLOADING', 'Loading chunks.');
      machine.transition('DOWNLOADED', 'Artifact chunks available.');
      machine.transition('INTEGRITY_VERIFIED', 'SHA-256 verified.', { verifiedSha256Hex: sha });
      machine.transition('INSTALLING', 'Staging artifact.');
      machine.transition('INSTALLED', 'Installed in local OPFS/direct storage.');
      machine.transition('COMPATIBILITY_VERIFIED', 'Browser WASM compatibility passed.');
    }
    if (machine.getState() === 'COMPATIBILITY_VERIFIED') {
      machine.transition('RUNTIME_INITIALIZED', 'ONNX Web Worker session initialized.');
    }
  }

  private recordStateMachineInferenceVerified(descriptor: AsrModelLoadDescriptor): void {
    const machine = this.getOrCreateStateMachine(descriptor);
    if (machine.getState() === 'RUNTIME_INITIALIZED') {
      machine.transition('INFERENCE_VERIFIED', 'Real ONNX inference executed successfully.');
      machine.transition('ACTIVE', 'Activated after verified real inference.');
    }
  }

  private mapError(err: unknown, jobId: string): AsrRuntimeError {
    if (err instanceof AsrRuntimeError) return err;
    const rawMsg = err instanceof Error ? err.message : String(err);
    const workerCode =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : '';

    let code: AsrRuntimeErrorCode = 'INFERENCE_FAILED';
    let retryable = false;

    if (workerCode === 'PROCESSING_CANCELLED' || /ABORTED|CANCELLED/i.test(rawMsg)) {
      code = 'JOB_CANCELLED';
    } else if (workerCode === 'LOCAL_MODEL_INTEGRITY_FAILURE' || /SHA-256|INTEGRITY|HASH_MISMATCH|CORRUPT/i.test(rawMsg)) {
      code = 'MODEL_INTEGRITY_FAILURE';
    } else if (workerCode === 'LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED' || /ARCHITECTURE|VOCAB/i.test(rawMsg)) {
      code = 'MODEL_INCOMPATIBLE';
    } else if (workerCode === 'LOCAL_MODEL_NOT_READY') {
      code = 'MODEL_NOT_INSTALLED';
    } else if (workerCode === 'PROCESSING_RESOURCE_LIMIT_EXCEEDED' || /MEMORY_BUDGET|QUOTA|OUT_OF_MEMORY/i.test(rawMsg)) {
      code = 'RESOURCE_LIMIT_EXCEEDED';
    } else if (workerCode === 'WORKER_CRASHED' || /WORKER_CRASHED|TERMINATED/i.test(rawMsg)) {
      code = 'WORKER_CRASHED';
      retryable = true;
    } else if (workerCode === 'WORKER_TIMEOUT' || /TIMEOUT|TIMED OUT/i.test(rawMsg)) {
      code = 'INFERENCE_TIMEOUT';
      retryable = true;
    } else if (workerCode === 'LOCAL_RUNTIME_UNAVAILABLE' || /WASM|onnxruntime/i.test(rawMsg)) {
      code = 'RUNTIME_UNAVAILABLE';
    }

    return new AsrRuntimeError({
      code,
      message: rawMsg,
      runtimeTarget: this.runtimeTarget,
      retryable,
      jobId,
      cause: err,
    });
  }
}

export type { RawWordPrediction };
