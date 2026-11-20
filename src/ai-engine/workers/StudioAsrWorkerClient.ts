import type { AsrModelRunnerAdapter, RawWordPrediction } from '../PersianChunkedAsrWorker';
import type { AsrArchitectureKind } from '../asr/UnifiedOnnxPersianAsrEngine';
import type {
  StudioAsrInitializePayload,
  StudioAsrWorkerCommand,
  StudioAsrWorkerRequestMessage,
  StudioAsrWorkerResponseMessage,
} from './studio-asr.worker';

export interface StudioAsrWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<StudioAsrWorkerResponseMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export class StudioAsrWorkerError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'StudioAsrWorkerError';
    this.code = code;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

interface PendingRequest {
  readonly command: StudioAsrWorkerCommand;
  readonly jobId: string;
  readonly resolve: (value: StudioAsrWorkerResponseMessage) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

export interface StudioAsrWorkerClientOptions {
  readonly workerFactory?: () => StudioAsrWorkerLike;
  readonly requestTimeoutMs?: number;
}

/**
 * Typed main-thread client for the dedicated Studio ONNX ASR Web Worker.
 * Implements `AsrModelRunnerAdapter` so `PersianChunkedAsrEngine` runs genuine
 * local ONNX inference off the main thread while transferring ONLY per-window PCM slices.
 */
export class StudioAsrWorkerClient implements AsrModelRunnerAdapter {
  private worker: StudioAsrWorkerLike | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private currentJobId = 'studio-local-asr';
  private initialized = false;
  private decoderConfigured = false;
  private disposed = false;

  public modelId = '';
  public modelVersion = '';
  public architecture: AsrArchitectureKind = 'FASTCONFORMER_CTC';
  public modelSha256: string | undefined = undefined;

  private readonly workerFactory: () => StudioAsrWorkerLike;
  private readonly requestTimeoutMs: number;

  constructor(options?: StudioAsrWorkerClientOptions) {
    this.workerFactory =
      options?.workerFactory ??
      (() => {
        if (typeof Worker === 'undefined') {
          throw new StudioAsrWorkerError(
            'LOCAL_RUNTIME_UNAVAILABLE',
            'Web Worker runtime is unavailable in this environment.',
          );
        }
        return new Worker(new URL('./studio-asr.worker.ts', import.meta.url), {
          type: 'module',
        }) as unknown as StudioAsrWorkerLike;
      });
    this.requestTimeoutMs =
      typeof options?.requestTimeoutMs === 'number' && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs
        : 60_000;
  }

  public isReady(): boolean {
    return !this.disposed && this.initialized && this.worker !== null && this.decoderConfigured;
  }

  public hasDecoderConfiguration(): boolean {
    return this.decoderConfigured;
  }

  public setActiveJobId(jobId: string): void {
    this.currentJobId = jobId;
  }

  public estimateWorkingMemoryBytes(sampleCount16k: number): number {
    // 80-bin Log-Mel spectrogram (~10ms hop => sampleCount / 160 frames) + transposed tensor
    const frames = Math.max(1, Math.ceil(sampleCount16k / 160));
    return frames * 80 * Float32Array.BYTES_PER_ELEMENT * 4;
  }

  private ensureWorker(): StudioAsrWorkerLike {
    if (this.disposed) {
      throw new StudioAsrWorkerError(
        'LOCAL_RUNTIME_UNAVAILABLE',
        'StudioAsrWorkerClient has been disposed.',
      );
    }
    if (this.worker) return this.worker;

    const w = this.workerFactory();
    w.onmessage = (event: MessageEvent<StudioAsrWorkerResponseMessage>) => {
      const data = event.data;
      if (!data || typeof data.requestId !== 'string') return;
      const entry = this.pending.get(data.requestId);
      if (!entry) return;
      this.pending.delete(data.requestId);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(data);
    };
    w.onerror = (event: ErrorEvent) => {
      const errMsg = event?.message || 'Dedicated Studio ASR Worker crashed unexpectedly.';
      this.terminateAndResetWorker(
        new StudioAsrWorkerError('LOCAL_RUNTIME_UNAVAILABLE', errMsg),
      );
    };
    this.worker = w;
    return w;
  }

  private terminateAndResetWorker(reason: Error): void {
    const activeWorker = this.worker;
    this.worker = null;
    this.initialized = false;
    this.decoderConfigured = false;
    if (activeWorker) {
      activeWorker.onmessage = null;
      activeWorker.onerror = null;
      try {
        activeWorker.terminate();
      } catch {
        // ignore termination errors
      }
    }
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(reason);
    }
  }

  private sendCommand(
    command: StudioAsrWorkerCommand,
    jobId: string,
    extra?: {
      readonly initPayload?: StudioAsrInitializePayload;
      readonly pcm16kBuffer?: ArrayBuffer;
      readonly pcm16kLength?: number;
      readonly transfer?: Transferable[];
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<StudioAsrWorkerResponseMessage> {
    if (extra?.signal?.aborted) {
      return Promise.reject(
        new StudioAsrWorkerError('PROCESSING_CANCELLED', 'Worker command aborted before dispatch.'),
      );
    }

    const worker = this.ensureWorker();
    const requestId = `asr_req_${++this.reqCounter}`;
    const timeoutMs = extra?.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<StudioAsrWorkerResponseMessage>((resolve, reject) => {
      let settled = false;
      let onAbort: (() => void) | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (onAbort && extra?.signal) {
          extra.signal.removeEventListener('abort', onAbort);
        }
        fn();
      };

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              finish(() => {
                const timeoutErr = new StudioAsrWorkerError(
                  'LOCAL_RUNTIME_UNAVAILABLE',
                  `Studio ASR Worker timed out after ${timeoutMs}ms on ${command}.`,
                );
                // Hard terminate hung worker and reset state cleanly
                this.terminateAndResetWorker(timeoutErr);
                reject(timeoutErr);
              });
            }, timeoutMs)
          : null;

      if (extra?.signal) {
        onAbort = () => {
          finish(() => {
            this.pending.delete(requestId);
            if (timer) clearTimeout(timer);
            try {
              worker.postMessage({
                requestId: `asr_cancel_${++this.reqCounter}`,
                jobId,
                command: 'CANCEL_JOB',
              } satisfies StudioAsrWorkerRequestMessage);
            } catch {
              // ignore postMessage failure on abort
            }
            reject(new StudioAsrWorkerError('PROCESSING_CANCELLED', `Job ${jobId} cancelled.`));
          });
        };
        extra.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(requestId, {
        command,
        jobId,
        timer,
        resolve: (resp) => finish(() => resolve(resp)),
        reject: (err) => finish(() => reject(err)),
      });

      const message: StudioAsrWorkerRequestMessage = {
        requestId,
        jobId,
        command,
        initPayload: extra?.initPayload,
        pcm16kBuffer: extra?.pcm16kBuffer,
        pcm16kLength: extra?.pcm16kLength,
      };

      try {
        if (extra?.transfer && extra.transfer.length > 0) {
          worker.postMessage(message, extra.transfer);
        } else {
          worker.postMessage(message);
        }
      } catch (err) {
        this.pending.delete(requestId);
        if (timer) clearTimeout(timer);
        finish(() =>
          reject(
            new StudioAsrWorkerError(
              'LOCAL_RUNTIME_UNAVAILABLE',
              err instanceof Error ? err.message : String(err),
              err,
            ),
          ),
        );
      }
    });
  }

  public async initializeModel(
    payload: StudioAsrInitializePayload,
    options?: { readonly jobId?: string; readonly signal?: AbortSignal },
  ): Promise<{
    readonly modelId: string;
    readonly modelVersion: string;
    readonly modelSha256: string;
    readonly architecture: AsrArchitectureKind;
  }> {
    const jobId = options?.jobId ?? this.currentJobId;
    this.initialized = false;
    this.decoderConfigured = false;

    const response = await this.sendCommand('INITIALIZE_MODEL', jobId, {
      initPayload: payload,
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new StudioAsrWorkerError(response.errorCode, response.message);
    }
    if (!response.modelReadiness?.ready) {
      throw new StudioAsrWorkerError(
        'LOCAL_MODEL_NOT_READY',
        'Worker returned non-ready status after model initialization.',
      );
    }

    this.modelId = response.modelReadiness.modelId;
    this.modelVersion = response.modelReadiness.modelVersion;
    this.modelSha256 = response.modelReadiness.modelSha256;
    this.architecture = response.modelReadiness.architecture;
    this.initialized = true;
    this.decoderConfigured = true;

    return {
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      modelSha256: this.modelSha256,
      architecture: this.architecture,
    };
  }

  public async detectVoiceActivity(
    pcm16kMono: Float32Array,
  ): Promise<{ hasSpeech: boolean; speechRatio: number }> {
    if (!this.isReady()) {
      throw new StudioAsrWorkerError(
        'LOCAL_MODEL_NOT_READY',
        'Local ONNX model must be initialized before VAD.',
      );
    }
    // Copy exact per-window slice into a dedicated transferable ArrayBuffer (never detaches caller buffer)
    const copy = new Float32Array(pcm16kMono.length);
    copy.set(pcm16kMono);
    const buffer = copy.buffer;

    const response = await this.sendCommand('DETECT_VAD', this.currentJobId, {
      pcm16kBuffer: buffer,
      pcm16kLength: copy.length,
      transfer: [buffer],
    });
    if (!response.ok) {
      throw new StudioAsrWorkerError(response.errorCode, response.message);
    }
    return response.vad ?? { hasSpeech: false, speechRatio: 0 };
  }

  public async transcribeWindow(pcm16kMono: Float32Array): Promise<RawWordPrediction[]> {
    if (!this.isReady()) {
      throw new StudioAsrWorkerError(
        'LOCAL_MODEL_NOT_READY',
        'Local ONNX model must be initialized before window transcription.',
      );
    }
    // Transfer ONLY this single bounded window buffer
    const copy = new Float32Array(pcm16kMono.length);
    copy.set(pcm16kMono);
    const buffer = copy.buffer;

    const response = await this.sendCommand('TRANSCRIBE_WINDOW', this.currentJobId, {
      pcm16kBuffer: buffer,
      pcm16kLength: copy.length,
      transfer: [buffer],
    });
    if (!response.ok) {
      throw new StudioAsrWorkerError(response.errorCode, response.message);
    }
    return [...(response.words ?? [])];
  }

  public async cancelJob(jobId: string): Promise<void> {
    if (!this.worker) return;
    try {
      await this.sendCommand('CANCEL_JOB', jobId, { timeoutMs: 2_000 });
    } catch {
      // ignore cancel errors if worker already exited
    }
  }

  public async unloadModel(): Promise<void> {
    this.initialized = false;
    this.decoderConfigured = false;
    if (!this.worker) return;
    try {
      await this.sendCommand('UNLOAD_MODEL', this.currentJobId, { timeoutMs: 5_000 });
    } catch {
      this.terminateAndResetWorker(
        new StudioAsrWorkerError('LOCAL_RUNTIME_UNAVAILABLE', 'Worker reset during unload.'),
      );
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    if (worker) {
      try {
        await this.sendCommand('DISPOSE', this.currentJobId, { timeoutMs: 2_000 });
      } catch {
        // force terminate below
      }
    }
    this.terminateAndResetWorker(
      new StudioAsrWorkerError('PROCESSING_CANCELLED', 'StudioAsrWorkerClient disposed.'),
    );
  }
}
