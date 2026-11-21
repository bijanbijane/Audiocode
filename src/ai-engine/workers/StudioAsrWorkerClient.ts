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
  readonly generation: number;
  readonly resolve: (value: StudioAsrWorkerResponseMessage) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

export interface StudioAsrWorkerClientOptions {
  readonly workerFactory?: () => StudioAsrWorkerLike;
  readonly requestTimeoutMs?: number;
  readonly initTimeoutMs?: number;
}

const VALID_WORKER_COMMANDS = new Set<StudioAsrWorkerCommand>([
  'INITIALIZE_MODEL',
  'DETECT_VAD',
  'TRANSCRIBE_WINDOW',
  'UNLOAD_MODEL',
  'CANCEL_JOB',
  'DISPOSE',
]);

/**
 * Validates incoming worker response frames strictly before accepting them on main thread
 * (AVP-P0-006 §9 Browser Worker Message Hardening).
 */
export function isValidStudioAsrWorkerResponse(
  raw: unknown,
): raw is StudioAsrWorkerResponseMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== 'string' || r.requestId.length === 0 || r.requestId.length > 128) {
    return false;
  }
  if (typeof r.jobId !== 'string' || r.jobId.length === 0 || r.jobId.length > 128) {
    return false;
  }
  if (typeof r.ok !== 'boolean') return false;
  if (typeof r.command !== 'string' || !VALID_WORKER_COMMANDS.has(r.command as StudioAsrWorkerCommand)) {
    return false;
  }
  if (!r.ok) {
    return typeof r.errorCode === 'string' && typeof r.message === 'string';
  }
  return true;
}

/**
 * Typed main-thread client for the dedicated Studio ONNX ASR Web Worker (AVP-P0-001 A2 & AVP-P0-006 §9).
 *
 * Reliability guarantees:
 * - Explicit initialization timeout (`initTimeoutMs`) separate from per-window timeout
 * - Job admission control (single active job guard prevents duplicate concurrent inference)
 * - Strict request/job correlation + worker generation tracking (stale responses rejected)
 * - Automatic clean recovery: after a worker crash or timeout, the worker is terminated,
 *   pending promises reject cleanly, and the next `initializeModel()` spawns a fresh worker.
 */
export class StudioAsrWorkerClient implements AsrModelRunnerAdapter {
  private worker: StudioAsrWorkerLike | null = null;
  private workerGeneration = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private currentJobId = 'studio-local-asr';
  private activeLockedJobId: string | null = null;
  private initialized = false;
  private decoderConfigured = false;
  private disposed = false;
  private crashCount = 0;
  private staleResponseCount = 0;

  public modelId = '';
  public modelVersion = '';
  public architecture: AsrArchitectureKind = 'FASTCONFORMER_CTC';
  public modelSha256: string | undefined = undefined;

  private readonly workerFactory: () => StudioAsrWorkerLike;
  private readonly requestTimeoutMs: number;
  private readonly initTimeoutMs: number;

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
    this.initTimeoutMs =
      typeof options?.initTimeoutMs === 'number' && options.initTimeoutMs > 0
        ? options.initTimeoutMs
        : 45_000;
  }

  public isReady(): boolean {
    return !this.disposed && this.initialized && this.worker !== null && this.decoderConfigured;
  }

  public hasDecoderConfiguration(): boolean {
    return this.decoderConfigured;
  }

  public getDiagnosticsSnapshot(): {
    readonly workerActive: boolean;
    readonly workerGeneration: number;
    readonly crashCount: number;
    readonly staleResponseCount: number;
    readonly activeLockedJobId: string | null;
    readonly initialized: boolean;
  } {
    return {
      workerActive: this.worker !== null,
      workerGeneration: this.workerGeneration,
      crashCount: this.crashCount,
      staleResponseCount: this.staleResponseCount,
      activeLockedJobId: this.activeLockedJobId,
      initialized: this.initialized,
    };
  }

  /**
   * Acquires exclusive job admission slot to prevent duplicate concurrent transcription jobs.
   */
  public acquireJobSlot(jobId: string): void {
    if (this.activeLockedJobId && this.activeLockedJobId !== jobId) {
      throw new StudioAsrWorkerError(
        'JOB_ALREADY_RUNNING',
        `Another local transcription job (${this.activeLockedJobId}) is already running.`,
      );
    }
    this.activeLockedJobId = jobId;
    this.currentJobId = jobId;
  }

  public releaseJobSlot(jobId: string): void {
    if (this.activeLockedJobId === jobId) {
      this.activeLockedJobId = null;
    }
  }

  public setActiveJobId(jobId: string): void {
    this.currentJobId = jobId;
  }

  public estimateWorkingMemoryBytes(sampleCount16k: number): number {
    // 80-bin Log-Mel spectrogram (~10ms hop => sampleCount / 160 frames) + transposed tensor
    const frames = Math.max(1, Math.ceil(sampleCount16k / 160));
    return frames * 80 * Float32Array.BYTES_PER_ELEMENT * 4;
  }

  private ensureWorker(): { readonly worker: StudioAsrWorkerLike; readonly generation: number } {
    if (this.disposed) {
      throw new StudioAsrWorkerError(
        'LOCAL_RUNTIME_UNAVAILABLE',
        'StudioAsrWorkerClient has been disposed.',
      );
    }
    if (this.worker) {
      return { worker: this.worker, generation: this.workerGeneration };
    }

    const gen = ++this.workerGeneration;
    const w = this.workerFactory();
    w.onmessage = (event: MessageEvent<StudioAsrWorkerResponseMessage>) => {
      // Reject messages from superseded/crashed worker generations
      if (gen !== this.workerGeneration || this.worker !== w) {
        this.staleResponseCount++;
        return;
      }
      const data = event.data;
      if (!isValidStudioAsrWorkerResponse(data)) {
        this.staleResponseCount++;
        return;
      }
      const entry = this.pending.get(data.requestId);
      if (!entry || entry.generation !== gen || entry.jobId !== data.jobId || entry.command !== data.command) {
        this.staleResponseCount++;
        return;
      }
      this.pending.delete(data.requestId);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(data);
    };
    w.onerror = (event: ErrorEvent) => {
      if (gen !== this.workerGeneration) return;
      this.crashCount++;
      const errMsg = event?.message || 'Dedicated Studio ASR Worker crashed unexpectedly.';
      this.terminateAndResetWorker(new StudioAsrWorkerError('WORKER_CRASHED', errMsg));
    };
    this.worker = w;
    return { worker: w, generation: gen };
  }

  private terminateAndResetWorker(reason: Error): void {
    const activeWorker = this.worker;
    this.worker = null;
    this.workerGeneration++;
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

  /**
   * Simulates or triggers explicit worker crash recovery (terminates worker so next init recreates it).
   */
  public resetWorkerAfterFailure(reasonMessage = 'Worker forcibly reset for recovery.'): void {
    this.terminateAndResetWorker(new StudioAsrWorkerError('WORKER_CRASHED', reasonMessage));
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

    const { worker, generation } = this.ensureWorker();
    const requestId = `asr_req_${++this.reqCounter}`;
    const timeoutMs =
      extra?.timeoutMs ?? (command === 'INITIALIZE_MODEL' ? this.initTimeoutMs : this.requestTimeoutMs);

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
                  'INFERENCE_TIMEOUT',
                  `Studio ASR Worker timed out after ${timeoutMs}ms on ${command}.`,
                );
                // Hard terminate hung worker and reset state cleanly so next job can recreate it
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
        generation,
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
    options?: { readonly jobId?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number },
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
      timeoutMs: options?.timeoutMs ?? this.initTimeoutMs,
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
    this.activeLockedJobId = null;
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
