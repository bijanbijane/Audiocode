/// <reference lib="webworker" />

import {
  AsrArchitectureKind,
  UnifiedOnnxPersianAsrEngine,
  WhisperSpecialTokens,
} from '../asr/UnifiedOnnxPersianAsrEngine';
import {
  OpfsRootDirectoryLike,
  WebWorkerOrtRuntimeProvider,
} from '../asr/WebWorkerOrtRuntimeProvider';
import { ChunkedModelManifest } from '../../platform/ChunkedModelDelivery';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../../runtime/memory/MemoryBudgetManager';
import type { RawWordPrediction } from '../PersianChunkedAsrWorker';

export type StudioAsrWorkerCommand =
  | 'INITIALIZE_MODEL'
  | 'DETECT_VAD'
  | 'TRANSCRIBE_WINDOW'
  | 'UNLOAD_MODEL'
  | 'CANCEL_JOB'
  | 'DISPOSE';

export interface StudioAsrInitializePayload {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly architecture: AsrArchitectureKind;
  readonly expectedSha256Hex: string;
  readonly executionProviders: readonly ('webgpu' | 'wasm')[];
  readonly chunkedManifest: ChunkedModelManifest;
  readonly decoderChunkedManifest?: ChunkedModelManifest;
  readonly ctcVocabulary?: readonly string[];
  readonly whisperIdToBpeTokenEntries?: readonly [number, string][];
  readonly whisperSpecialTokens?: WhisperSpecialTokens;
  readonly wasmAssetsBasePath?: string;
}

export interface StudioAsrWorkerRequestMessage {
  readonly requestId: string;
  readonly jobId: string;
  readonly command: StudioAsrWorkerCommand;
  readonly initPayload?: StudioAsrInitializePayload;
  readonly pcm16kBuffer?: ArrayBuffer;
  readonly pcm16kLength?: number;
}

export interface StudioAsrWorkerSuccessResponse {
  readonly requestId: string;
  readonly jobId: string;
  readonly ok: true;
  readonly command: StudioAsrWorkerCommand;
  readonly modelReadiness?: {
    readonly modelId: string;
    readonly modelVersion: string;
    readonly modelSha256: string;
    readonly architecture: AsrArchitectureKind;
    readonly ready: boolean;
  };
  readonly vad?: { readonly hasSpeech: boolean; readonly speechRatio: number };
  readonly words?: readonly RawWordPrediction[];
}

export interface StudioAsrWorkerErrorResponse {
  readonly requestId: string;
  readonly jobId: string;
  readonly ok: false;
  readonly command: StudioAsrWorkerCommand;
  readonly errorCode: string;
  readonly message: string;
}

export type StudioAsrWorkerResponseMessage =
  | StudioAsrWorkerSuccessResponse
  | StudioAsrWorkerErrorResponse;

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export class StudioAsrWorkerRuntimeHost {
  private engine: UnifiedOnnxPersianAsrEngine | null = null;
  private activeModelSha256: string | null = null;
  private activeReservations: MemoryReservation[] = [];
  private activeJobAborts = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private readonly options?: {
      readonly budgetManager?: MemoryBudgetManager;
      readonly ortProviderFactory?: (wasmAssetsBasePath?: string) => WebWorkerOrtRuntimeProvider;
      readonly opfsRootOverride?: OpfsRootDirectoryLike;
    },
  ) {}

  private releaseModelReservations(): void {
    const budget = this.options?.budgetManager ?? getSharedMemoryBudgetManager();
    for (const res of this.activeReservations) {
      budget.release(res);
    }
    this.activeReservations = [];
  }

  public async handleMessage(
    msg: StudioAsrWorkerRequestMessage,
  ): Promise<StudioAsrWorkerResponseMessage> {
    if (this.disposed && msg.command !== 'DISPOSE') {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: msg.command,
        errorCode: 'LOCAL_RUNTIME_UNAVAILABLE',
        message: 'Studio ASR worker has been disposed.',
      };
    }

    try {
      switch (msg.command) {
        case 'INITIALIZE_MODEL':
          return await this.handleInitialize(msg);
        case 'DETECT_VAD':
          return await this.handleDetectVad(msg);
        case 'TRANSCRIBE_WINDOW':
          return await this.handleTranscribeWindow(msg);
        case 'UNLOAD_MODEL':
          return await this.handleUnload(msg);
        case 'CANCEL_JOB':
          return this.handleCancelJob(msg);
        case 'DISPOSE':
          return await this.handleDispose(msg);
        default:
          return {
            requestId: msg.requestId,
            jobId: msg.jobId,
            ok: false,
            command: msg.command,
            errorCode: 'INVALID_PROCESSING_REQUEST',
            message: `Unknown worker command: ${String(msg.command)}`,
          };
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const errorCode = this.classifyWorkerError(rawMessage, err);
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: msg.command,
        errorCode,
        message: rawMessage,
      };
    }
  }

  private classifyWorkerError(rawMessage: string, err: unknown): string {
    if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
      const code = (err as { code: string }).code;
      if (
        code === 'MODEL_INTEGRITY_FAILURE' ||
        code === 'MODEL_MANIFEST_INVALID' ||
        code === 'MODEL_REGISTRY_CORRUPTED'
      ) {
        return 'LOCAL_MODEL_INTEGRITY_FAILURE';
      }
      if (code === 'MODEL_STORAGE_UNAVAILABLE') {
        return 'LOCAL_RUNTIME_UNAVAILABLE';
      }
    }
    if (/ABORTED|CANCELLED/i.test(rawMessage)) return 'PROCESSING_CANCELLED';
    if (/INTEGRITY|SHA-256|HASH_MISMATCH|CORRUPTED|MANIFEST/i.test(rawMessage)) {
      return 'LOCAL_MODEL_INTEGRITY_FAILURE';
    }
    if (/ARCHITECTURE_UNSUPPORTED|UNSUPPORTED_ARCHITECTURE|VOCAB|DECODER_MISSING/i.test(rawMessage)) {
      return 'LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED';
    }
    if (/NOT_LOADED|NOT_READY/i.test(rawMessage)) {
      return 'LOCAL_MODEL_NOT_READY';
    }
    if (/MEMORY_BUDGET|QUOTA|OUT_OF_MEMORY/i.test(rawMessage)) {
      return 'PROCESSING_RESOURCE_LIMIT_EXCEEDED';
    }
    if (/onnxruntime-web|WASM|RUNTIME_UNAVAILABLE|Cannot find module/i.test(rawMessage)) {
      return 'LOCAL_RUNTIME_UNAVAILABLE';
    }
    return 'PROCESSING_FAILED';
  }

  private async handleInitialize(
    msg: StudioAsrWorkerRequestMessage,
  ): Promise<StudioAsrWorkerResponseMessage> {
    const payload = msg.initPayload;
    if (!payload) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'INITIALIZE_MODEL',
        errorCode: 'INVALID_PROCESSING_REQUEST',
        message: 'INITIALIZE_MODEL requires initPayload.',
      };
    }

    if (
      payload.architecture !== 'FASTCONFORMER_CTC' &&
      payload.architecture !== 'WHISPER_SEQ2SEQ'
    ) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'INITIALIZE_MODEL',
        errorCode: 'LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED',
        message: `Unsupported ONNX ASR architecture: ${String(payload.architecture)}`,
      };
    }

    const expectedSha = payload.expectedSha256Hex.trim().toLowerCase();
    if (!SHA256_HEX_RE.test(expectedSha)) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'INITIALIZE_MODEL',
        errorCode: 'LOCAL_MODEL_INTEGRITY_FAILURE',
        message: 'Model expectedSha256Hex must be a valid 64-hex SHA-256 digest.',
      };
    }

    if (
      payload.chunkedManifest.modelId !== payload.modelId ||
      payload.chunkedManifest.version !== payload.modelVersion
    ) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'INITIALIZE_MODEL',
        errorCode: 'LOCAL_MODEL_INTEGRITY_FAILURE',
        message: 'Chunked manifest modelId/version does not match requested model identity.',
      };
    }

    if (
      payload.architecture === 'FASTCONFORMER_CTC' &&
      (!Array.isArray(payload.ctcVocabulary) || payload.ctcVocabulary.length === 0)
    ) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'INITIALIZE_MODEL',
        errorCode: 'LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED',
        message: 'FASTCONFORMER_CTC requires a non-empty ctcVocabulary configuration.',
      };
    }

    if (payload.architecture === 'WHISPER_SEQ2SEQ') {
      if (
        !payload.decoderChunkedManifest ||
        !Array.isArray(payload.whisperIdToBpeTokenEntries) ||
        payload.whisperIdToBpeTokenEntries.length === 0 ||
        !payload.whisperSpecialTokens
      ) {
        return {
          requestId: msg.requestId,
          jobId: msg.jobId,
          ok: false,
          command: 'INITIALIZE_MODEL',
          errorCode: 'LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED',
          message:
            'WHISPER_SEQ2SEQ requires decoderChunkedManifest, whisperIdToBpeTokenEntries, and whisperSpecialTokens.',
        };
      }
    }

    // Unload any previously active model session & release memory reservations first
    await this.unloadCurrentModel();

    const abortCtrl = new AbortController();
    this.activeJobAborts.set(msg.jobId, abortCtrl);
    const budget = this.options?.budgetManager ?? getSharedMemoryBudgetManager();

    try {
      const encoderBytes = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
        {
          ...payload.chunkedManifest,
          sha256Hex: expectedSha,
        },
        this.options?.opfsRootOverride,
        {
          memoryBudgetManager: budget,
          signal: abortCtrl.signal,
          onReservation: (reservation) => {
            this.activeReservations.push(reservation);
          },
        },
      );

      let decoderBytes: Uint8Array | undefined;
      if (payload.architecture === 'WHISPER_SEQ2SEQ' && payload.decoderChunkedManifest) {
        decoderBytes = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
          payload.decoderChunkedManifest,
          this.options?.opfsRootOverride,
          {
            memoryBudgetManager: budget,
            signal: abortCtrl.signal,
            onReservation: (reservation) => {
              this.activeReservations.push(reservation);
            },
          },
        );
      }

      if (abortCtrl.signal.aborted) {
        throw new Error('ASR_INITIALIZE_ABORTED');
      }

      const ortProvider = this.options?.ortProviderFactory
        ? this.options.ortProviderFactory(payload.wasmAssetsBasePath)
        : new WebWorkerOrtRuntimeProvider(payload.wasmAssetsBasePath ?? '/ort/');

      const whisperMap = payload.whisperIdToBpeTokenEntries
        ? new Map<number, string>(payload.whisperIdToBpeTokenEntries)
        : undefined;

      const engine = new UnifiedOnnxPersianAsrEngine(ortProvider, payload.architecture, {
        modelId: payload.modelId,
        modelVersion: payload.modelVersion,
        ctcVocabulary: payload.ctcVocabulary,
        whisperIdToBpeToken: whisperMap,
        whisperSpecialTokens: payload.whisperSpecialTokens,
      });

      await engine.loadModels({
        encoderModelBytesOrPath: encoderBytes,
        decoderModelBytesOrPath: decoderBytes,
        executionProviders:
          payload.executionProviders.length > 0 ? [...payload.executionProviders] : ['wasm'],
      });

      if (!engine.isReady()) {
        await engine.unloadModels();
        throw new Error('LOCAL_MODEL_NOT_READY: ONNX session or decoder configuration incomplete.');
      }

      this.engine = engine;
      this.activeModelSha256 = expectedSha;

      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: true,
        command: 'INITIALIZE_MODEL',
        modelReadiness: {
          modelId: engine.modelId,
          modelVersion: engine.modelVersion,
          modelSha256: expectedSha,
          architecture: engine.architecture,
          ready: true,
        },
      };
    } catch (err) {
      await this.unloadCurrentModel();
      throw err;
    } finally {
      this.activeJobAborts.delete(msg.jobId);
    }
  }

  private async handleDetectVad(
    msg: StudioAsrWorkerRequestMessage,
  ): Promise<StudioAsrWorkerResponseMessage> {
    if (!this.engine || !this.engine.isReady()) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'DETECT_VAD',
        errorCode: 'LOCAL_MODEL_NOT_READY',
        message: 'Local ONNX ASR engine is not initialized.',
      };
    }
    if (!msg.pcm16kBuffer) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'DETECT_VAD',
        errorCode: 'INVALID_PROCESSING_REQUEST',
        message: 'DETECT_VAD requires pcm16kBuffer.',
      };
    }
    const sampleCount =
      typeof msg.pcm16kLength === 'number' && msg.pcm16kLength >= 0
        ? Math.min(msg.pcm16kLength, Math.floor(msg.pcm16kBuffer.byteLength / 4))
        : Math.floor(msg.pcm16kBuffer.byteLength / 4);
    const pcm = new Float32Array(msg.pcm16kBuffer, 0, sampleCount);
    const vad = await this.engine.detectVoiceActivity(pcm);
    return {
      requestId: msg.requestId,
      jobId: msg.jobId,
      ok: true,
      command: 'DETECT_VAD',
      vad,
    };
  }

  private async handleTranscribeWindow(
    msg: StudioAsrWorkerRequestMessage,
  ): Promise<StudioAsrWorkerResponseMessage> {
    if (!this.engine || !this.engine.isReady()) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'TRANSCRIBE_WINDOW',
        errorCode: 'LOCAL_MODEL_NOT_READY',
        message: 'Local ONNX ASR engine is not initialized.',
      };
    }
    if (!msg.pcm16kBuffer) {
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: false,
        command: 'TRANSCRIBE_WINDOW',
        errorCode: 'INVALID_PROCESSING_REQUEST',
        message: 'TRANSCRIBE_WINDOW requires pcm16kBuffer.',
      };
    }
    const abortCtrl = new AbortController();
    this.activeJobAborts.set(msg.jobId, abortCtrl);
    try {
      const sampleCount =
        typeof msg.pcm16kLength === 'number' && msg.pcm16kLength >= 0
          ? Math.min(msg.pcm16kLength, Math.floor(msg.pcm16kBuffer.byteLength / 4))
          : Math.floor(msg.pcm16kBuffer.byteLength / 4);
      const pcm = new Float32Array(msg.pcm16kBuffer, 0, sampleCount);
      const words = await this.engine.transcribeWindow(pcm);
      if (abortCtrl.signal.aborted) {
        return {
          requestId: msg.requestId,
          jobId: msg.jobId,
          ok: false,
          command: 'TRANSCRIBE_WINDOW',
          errorCode: 'PROCESSING_CANCELLED',
          message: 'Window inference cancelled.',
        };
      }
      return {
        requestId: msg.requestId,
        jobId: msg.jobId,
        ok: true,
        command: 'TRANSCRIBE_WINDOW',
        words,
      };
    } finally {
      this.activeJobAborts.delete(msg.jobId);
    }
  }

  private async unloadCurrentModel(): Promise<void> {
    if (this.engine) {
      try {
        await this.engine.unloadModels();
      } finally {
        this.engine = null;
        this.activeModelSha256 = null;
      }
    }
    this.releaseModelReservations();
  }

  private async handleUnload(
    msg: StudioAsrWorkerRequestMessage,
  ): Promise<StudioAsrWorkerResponseMessage> {
    await this.unloadCurrentModel();
    return {
      requestId: msg.requestId,
      jobId: msg.jobId,
      ok: true,
      command: 'UNLOAD_MODEL',
    };
  }

  private handleCancelJob(msg: StudioAsrWorkerRequestMessage): StudioAsrWorkerResponseMessage {
    const ctrl = this.activeJobAborts.get(msg.jobId);
    if (ctrl) {
      ctrl.abort();
      this.activeJobAborts.delete(msg.jobId);
    }
    return {
      requestId: msg.requestId,
      jobId: msg.jobId,
      ok: true,
      command: 'CANCEL_JOB',
    };
  }

  private async handleDispose(
    msg: StudioAsrWorkerRequestMessage,
  ): Promise<StudioAsrWorkerResponseMessage> {
    this.disposed = true;
    for (const ctrl of this.activeJobAborts.values()) {
      ctrl.abort();
    }
    this.activeJobAborts.clear();
    await this.unloadCurrentModel();
    return {
      requestId: msg.requestId,
      jobId: msg.jobId,
      ok: true,
      command: 'DISPOSE',
    };
  }

  public getActiveModelSha256(): string | null {
    return this.activeModelSha256;
  }
}

// Dedicated Web Worker bootstrap when executing inside a real browser Worker context
const workerGlobal = typeof self !== 'undefined' ? (self as unknown as DedicatedWorkerGlobalScope) : null;
if (workerGlobal && typeof workerGlobal.postMessage === 'function' && typeof (globalThis as { window?: unknown }).window === 'undefined') {
  const host = new StudioAsrWorkerRuntimeHost();
  workerGlobal.onmessage = (event: MessageEvent<StudioAsrWorkerRequestMessage>) => {
    const data = event.data;
    if (!data || typeof data.requestId !== 'string' || typeof data.command !== 'string') {
      return;
    }
    void host.handleMessage(data).then((response) => {
      workerGlobal.postMessage(response);
    });
  };
}
