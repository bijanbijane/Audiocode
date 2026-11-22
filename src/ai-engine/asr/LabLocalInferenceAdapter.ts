import {
  AsrJobCancelledError,
  AsrModelRunnerAdapter,
  PersianChunkedAsrEngine,
} from '../PersianChunkedAsrWorker';
import { PersianTextNormalizer, TimedPersianToken } from '../PersianTextNormalizer';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../../runtime/memory/MemoryBudgetManager';
import { TimeMath } from '../../contracts/timebase.contract';
import type {
  InstalledModelDescriptor,
  LocalModelLifecycleManager,
} from '../../lifecycle/LocalModelLifecycleManager';
import type {
  AsrAdapterExecutionOutput,
  AsrEngineRegistryDescriptor,
  AsrInferenceRequest,
  AsrInferenceWordPrediction,
  AsrProviderAdapter,
  VerifiedModelIdentity,
} from './AsrExperimentationLabContracts';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

/**
 * Pattern detecting synthetic acoustic-segmentation placeholder tokens that must NEVER
 * be promoted as genuine open-vocabulary ASR inference predictions.
 */
const SYNTHETIC_PLACEHOLDER_TOKEN_RE = /^(?:بخشِ_\d+|\[?بخش_گفتار_\d+\]?)$/;

export interface LocalModelRuntimeBinding {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelSha256: string;
  readonly architecture: 'FASTCONFORMER_CTC' | 'WHISPER_SEQ2SEQ';
  readonly runner: AsrModelRunnerAdapter;
  readonly sessionInitialized: boolean;
  readonly decoderConfigured: boolean;
  readonly workerOperational?: boolean;
  /**
   * Provenance label. Defaults to `'MODEL_INFERENCE'` for genuine ONNX inference runtimes.
   * Set to `'DETERMINISTIC_TEST_FIXTURE'` only for deterministic test fixtures that must be
   * excluded from production leaderboards.
   */
  readonly provenance?: 'MODEL_INFERENCE' | 'DETERMINISTIC_TEST_FIXTURE';
}

export interface LabLocalInferenceAdapterOptions {
  readonly modelManager?: LocalModelLifecycleManager;
  readonly requestedModelId?: string;
  readonly getRuntimeBinding?: () =>
    | LocalModelRuntimeBinding
    | null
    | Promise<LocalModelRuntimeBinding | null>;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly isWorkerOperational?: () => boolean;
  readonly onCancelled?: () => Promise<void> | void;
}

const EMPTY_MODEL_IDENTITY: VerifiedModelIdentity = Object.freeze({
  modelId: null,
  modelVersion: null,
  modelSha256: null,
  architecture: null,
});

/**
 * Derives an honest local ASR engine registry descriptor from actual installed model
 * metadata and runtime initialization status. Never claims CTC transcription or streaming
 * capabilities when no verified neural model is initialized.
 */
export function createLocalEngineDescriptor(params?: {
  readonly activeModel?: InstalledModelDescriptor | null;
  readonly runtimeReady?: boolean;
  readonly runtimeBinding?: LocalModelRuntimeBinding | null;
}): AsrEngineRegistryDescriptor {
  const active = params?.activeModel ?? null;
  const binding = params?.runtimeBinding ?? null;
  const modelId = binding?.modelId ?? active?.modelId ?? null;
  const version = binding?.modelVersion ?? active?.version ?? 'uninstalled';
  const architecture = binding?.architecture ?? active?.architecture ?? null;
  const transcriptionCapable = Boolean(
    binding
      ? binding.sessionInitialized &&
          binding.decoderConfigured &&
          binding.workerOperational !== false &&
          (binding.runner.isReady ? binding.runner.isReady() : true) &&
          (binding.runner.hasDecoderConfiguration ? binding.runner.hasDecoderConfiguration() : true)
      : active && params?.runtimeReady,
  );

  const displayName = modelId
    ? `Avapardaz Local Neural ASR (${modelId}${architecture ? ` · ${architecture}` : ''})`
    : 'Avapardaz Local Neural ASR (ONNX)';

  return {
    engineId: 'avapardaz-local-ctc-dsp',
    displayName,
    version,
    vendorOrFamily: 'آواپرداز (موتور استنتاج عصبی محلی ONNX — بدون API خارجی)',
    deploymentKind: 'LOCAL_IN_PROCESS',
    architecture,
    supportsPersian: true,
    supportsEnglish: true,
    supportsCodeSwitching: true,
    supportsTranscription: transcriptionCapable,
    supportsForcedAlignment: true,
    supportsSpeechSegmentation: true,
    supportsBatch: true,
    // Never claim streaming ASR merely because the surrounding audio engine streams audio
    supportsStreaming: false,
    officialPricePerHourUsd: 0.0,
    requiredEnvVar: null,
  };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof AsrJobCancelledError) return true;
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { code?: unknown }).code;
  const msg = (err as { message?: unknown }).message;
  return (
    name === 'AbortError' ||
    code === 'ASR_JOB_CANCELLED' ||
    (typeof msg === 'string' && /abort|cancel|timeout/i.test(msg))
  );
}

/**
 * Genuine model-backed local ASR inference adapter for the ASR Research Lab
 * (AVP-ASR-GOLD-REFERENCE-ISOLATION-009).
 *
 * Guarantees:
 * - Zero access to human reference transcripts or gold expected outputs.
 * - Zero synthetic word generation, heuristic text placeholders, or forced-alignment substitution.
 * - Verifies installed model, identity match, integrity, initialized ONNX session, decoder/vocabulary
 *   configuration, architecture match, and worker health BEFORE executing inference.
 * - Executes chunked 16kHz inference via `PersianChunkedAsrEngine` (25s window / 3s overlap / 22s stride)
 *   under `MemoryBudgetManager` admission and `AbortSignal` cancellation.
 * - Preserves verbatim model-generated words, timestamps, confidences, and exact model identity.
 */
export class LabLocalInferenceAdapter implements AsrProviderAdapter {
  private readonly options: LabLocalInferenceAdapterOptions;
  private cachedRuntimeBinding: LocalModelRuntimeBinding | null = null;

  constructor(options: LabLocalInferenceAdapterOptions = {}) {
    this.options = options;
  }

  public get descriptor(): AsrEngineRegistryDescriptor {
    const snap = this.options.modelManager?.getSnapshot();
    return createLocalEngineDescriptor({
      activeModel: snap?.activeModel ?? null,
      runtimeReady: snap?.runtimeReady ?? false,
      runtimeBinding: this.cachedRuntimeBinding,
    });
  }

  public async transcribe(request: AsrInferenceRequest): Promise<AsrAdapterExecutionOutput> {
    const { audio, signal, experimentId } = request;

    if (signal.aborted) {
      await this.invokeCancelledCleanup();
      return {
        status: this.isTimeoutReason(signal.reason) ? 'TIMEOUT' : 'API_ERROR',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: EMPTY_MODEL_IDENTITY,
        errorMessage: 'اجرای استنتاج محلی پیش از شروع لغو شد.',
        isMockTestOnly: false,
      };
    }

    if (this.options.isWorkerOperational && !this.options.isWorkerOperational()) {
      return {
        status: 'WORKER_OFFLINE',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: EMPTY_MODEL_IDENTITY,
        errorMessage: 'ورکر استنتاج محلی ASR در دسترس نیست (WORKER_OFFLINE).',
        isMockTestOnly: false,
      };
    }

    // Step 1: Verify installed & integrity-checked local model when lifecycle manager is wired
    let verifiedDescriptor: InstalledModelDescriptor | null = null;
    if (this.options.modelManager) {
      const snap = this.options.modelManager.getSnapshot().initialized
        ? this.options.modelManager.getSnapshot()
        : await this.options.modelManager.initialize();

      if (
        !snap.activeModel ||
        snap.state === 'MODEL_NOT_INSTALLED' ||
        snap.state === 'MODEL_REMOVED'
      ) {
        return {
          status: 'MODEL_NOT_INSTALLED',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: EMPTY_MODEL_IDENTITY,
          errorMessage:
            'هیچ مدل عصبی محلی (.onnx) نصب نشده است؛ خروجی ساختگی تولید نمی‌شود.',
          isMockTestOnly: false,
        };
      }

      if (snap.state === 'INTEGRITY_FAILURE' || snap.state === 'MODEL_UNAVAILABLE') {
        return {
          status: 'MODEL_NOT_READY',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: {
            modelId: snap.activeModel.modelId,
            modelVersion: snap.activeModel.version,
            modelSha256: snap.activeModel.verifiedSha256Hex,
            architecture: snap.activeModel.architecture,
          },
          errorMessage:
            snap.lastError ??
            'مدل محلی در وضعیت معتبر و قابل اجرا نیست (عدم تأیید اصالت یا فضای ذخیره‌سازی).',
          isMockTestOnly: false,
        };
      }

      const integrity = await this.options.modelManager.verifyInstalledActiveModelOffline();
      if (!integrity.ok) {
        return {
          status: 'MODEL_NOT_READY',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: {
            modelId: snap.activeModel.modelId,
            modelVersion: snap.activeModel.version,
            modelSha256: snap.activeModel.verifiedSha256Hex,
            architecture: snap.activeModel.architecture,
          },
          errorMessage:
            integrity.error ?? 'تأیید اصالت آفلاین مدل محلی ناموفق بود.',
          isMockTestOnly: false,
        };
      }

      verifiedDescriptor = snap.activeModel;
    }

    if (signal.aborted) {
      await this.invokeCancelledCleanup();
      return {
        status: this.isTimeoutReason(signal.reason) ? 'TIMEOUT' : 'API_ERROR',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: EMPTY_MODEL_IDENTITY,
        errorMessage: 'اجرای استنتاج محلی لغو شد.',
        isMockTestOnly: false,
      };
    }

    // Step 2: Obtain initialized runtime binding (ONNX session + decoder configuration)
    let binding: LocalModelRuntimeBinding | null = null;
    try {
      binding = (await this.options.getRuntimeBinding?.()) ?? null;
    } catch (err) {
      return {
        status: 'WORKER_OFFLINE',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: verifiedDescriptor
          ? {
              modelId: verifiedDescriptor.modelId,
              modelVersion: verifiedDescriptor.version,
              modelSha256: verifiedDescriptor.verifiedSha256Hex,
              architecture: verifiedDescriptor.architecture,
            }
          : EMPTY_MODEL_IDENTITY,
        errorMessage: `خطا در اتصال به ورکر/موتور استنتاج محلی: ${err instanceof Error ? err.message : String(err)}`,
        isMockTestOnly: false,
      };
    }

    this.cachedRuntimeBinding = binding;

    if (!binding) {
      if (verifiedDescriptor) {
        return {
          status: 'MODEL_NOT_READY',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: {
            modelId: verifiedDescriptor.modelId,
            modelVersion: verifiedDescriptor.version,
            modelSha256: verifiedDescriptor.verifiedSha256Hex,
            architecture: verifiedDescriptor.architecture,
          },
          errorMessage:
            'فایل وزن مدل محلی در OPFS ذخیره و تأیید شده است، اما جلسه استنتاج ONNX (Session و Decoder) هنوز مقداردهی نشده است.',
          isMockTestOnly: false,
        };
      }
      return {
        status: 'MODEL_NOT_INSTALLED',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: EMPTY_MODEL_IDENTITY,
        errorMessage:
          'مدل عصبی محلی (.onnx) نصب نشده است. برای بنچمارک واقعی، ابتدا یک مدل معتبر نصب و مقداردهی کنید.',
        isMockTestOnly: false,
      };
    }

    const identity: VerifiedModelIdentity = {
      modelId: binding.modelId || null,
      modelVersion: binding.modelVersion || null,
      modelSha256: binding.modelSha256 ? binding.modelSha256.toLowerCase() : null,
      architecture: binding.architecture || null,
    };

    // Step 3: Strict runtime readiness checklist (all 7 conditions)
    if (binding.workerOperational === false) {
      return {
        status: 'WORKER_OFFLINE',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'ورکر استنتاج محلی غیرفعال یا قطع شده است.',
        isMockTestOnly: false,
      };
    }

    if (
      !identity.modelId ||
      !identity.modelVersion ||
      !identity.modelSha256 ||
      !SHA256_HEX_RE.test(identity.modelSha256) ||
      !identity.architecture
    ) {
      return {
        status: 'MODEL_NOT_READY',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'هویت یا هش SHA-256 مدل محلی کامل و تأییدشده نیست.',
        isMockTestOnly: false,
      };
    }

    if (
      this.options.requestedModelId &&
      binding.modelId !== this.options.requestedModelId
    ) {
      return {
        status: 'MODEL_NOT_READY',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: `عدم تطابق شناسه مدل: درخواست‌شده "${this.options.requestedModelId}" ولی مدل بارگذاری‌شده "${binding.modelId}".`,
        isMockTestOnly: false,
      };
    }

    if (verifiedDescriptor) {
      if (
        verifiedDescriptor.modelId !== binding.modelId ||
        verifiedDescriptor.version !== binding.modelVersion ||
        verifiedDescriptor.verifiedSha256Hex.toLowerCase() !== identity.modelSha256 ||
        verifiedDescriptor.architecture !== binding.architecture
      ) {
        return {
          status: 'MODEL_NOT_READY',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: identity,
          errorMessage:
            'عدم تطابق معماری یا هویت بین مدل ذخیره‌شده در OPFS و جلسه ONNX بارگذاری‌شده.',
          isMockTestOnly: false,
        };
      }
    }

    if (
      binding.runner.modelId !== binding.modelId ||
      binding.runner.modelVersion !== binding.modelVersion ||
      (binding.runner.architecture && binding.runner.architecture !== binding.architecture)
    ) {
      return {
        status: 'MODEL_NOT_READY',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'عدم تطابق شناسه یا معماری میان Runner استنتاج و مانیفست مدل.',
        isMockTestOnly: false,
      };
    }

    const runnerReady = binding.runner.isReady ? binding.runner.isReady() : true;
    if (!binding.sessionInitialized || !runnerReady) {
      return {
        status: 'MODEL_NOT_READY',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'جلسه استنتاج ONNX هنوز مقداردهی نشده یا آزاد (unload) شده است.',
        isMockTestOnly: false,
      };
    }

    const decoderReady = binding.runner.hasDecoderConfiguration
      ? binding.runner.hasDecoderConfiguration()
      : true;
    if (!binding.decoderConfigured || !decoderReady) {
      return {
        status: 'MODEL_NOT_READY',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'پیکربندی دیکدر یا واژه‌نامه CTC/BPE مدل محلی بارگذاری نشده است.',
        isMockTestOnly: false,
      };
    }

    // Step 4: Execute genuine chunked 16kHz inference via PersianChunkedAsrEngine
    // (25s window, 3s overlap, 22s stride, MemoryBudgetManager admission, AbortSignal)
    const pcm16k = audio.standardizedPcm16k;
    const budgetManager =
      this.options.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    const chunkedEngine = new PersianChunkedAsrEngine(binding.runner, budgetManager);

    let tokens: TimedPersianToken[];
    try {
      tokens = await chunkedEngine.transcribeLongAudioStream(
        pcm16k.length,
        async (startSample, count) => {
          if (binding!.runner.isReady && !binding!.runner.isReady()) {
            throw new Error('MODEL_UNLOADED_DURING_INFERENCE');
          }
          if (this.options.isWorkerOperational && !this.options.isWorkerOperational()) {
            throw new Error('ASR_WORKER_OFFLINE_DURING_INFERENCE');
          }
          return pcm16k.subarray(startSample, Math.min(pcm16k.length, startSample + count));
        },
        async () => {
          if (binding!.runner.isReady && !binding!.runner.isReady()) {
            throw new Error('MODEL_UNLOADED_DURING_INFERENCE');
          }
        },
        0,
        [],
        'lab-local-track',
        {
          memoryBudgetManager: budgetManager,
          signal,
          jobId: `lab-local-${experimentId}`,
        },
      );
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        await this.invokeCancelledCleanup();
        return {
          status: this.isTimeoutReason(signal.reason) ? 'TIMEOUT' : 'API_ERROR',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: identity,
          errorMessage: this.isTimeoutReason(signal.reason)
            ? 'مهلت زمانی استنتاج محلی به پایان رسید و منابع موقت آزاد شدند.'
            : 'اجرای استنتاج محلی لغو شد و منابع موقت آزاد شدند.',
          isMockTestOnly: false,
        };
      }

      const rawMsg = err instanceof Error ? err.message : String(err);
      if (rawMsg.includes('MODEL_UNLOADED_DURING_INFERENCE')) {
        return {
          status: 'MODEL_NOT_READY',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: identity,
          errorMessage: 'مدل محلی در میانه استنتاج از حافظه آزاد شد (MODEL_UNLOADED).',
          isMockTestOnly: false,
        };
      }
      if (rawMsg.includes('WORKER_OFFLINE')) {
        return {
          status: 'WORKER_OFFLINE',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: identity,
          errorMessage: 'ورکر استنتاج در میانه پردازش از دسترس خارج شد.',
          isMockTestOnly: false,
        };
      }

      return {
        status: 'API_ERROR',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: `خطای استنتاج مدل محلی: ${rawMsg}`,
        isMockTestOnly: false,
      };
    }

    // Re-check abort & runtime status after completion so late results are never accepted
    if (signal.aborted) {
      await this.invokeCancelledCleanup();
      return {
        status: this.isTimeoutReason(signal.reason) ? 'TIMEOUT' : 'API_ERROR',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'نتیجه دیرهنگام پس از لغو یا اتمام مهلت زمانی رد شد.',
        isMockTestOnly: false,
      };
    }

    if (binding.runner.isReady && !binding.runner.isReady()) {
      return {
        status: 'MODEL_NOT_READY',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'مدل محلی پیش از تکمیل استنتاج از حافظه آزاد شد.',
        isMockTestOnly: false,
      };
    }

    // Step 5: Preserve verbatim raw model predictions, timestamps, and confidences
    const words: AsrInferenceWordPrediction[] = [];
    for (const tok of tokens) {
      const rawWord = tok.originalText.trim();
      if (!rawWord) continue;
      if (SYNTHETIC_PLACEHOLDER_TOKEN_RE.test(rawWord)) {
        return {
          status: 'EMPTY_RESPONSE',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: identity,
          errorMessage:
            'خروجی شامل نشانگرهای ساختگی بخش‌بندی صوتی بود و به عنوان تشخیص گفتار پذیرفته نشد.',
          isMockTestOnly: false,
        };
      }
      words.push({
        word: rawWord,
        normalizedWord: tok.normalizedText,
        startSec: Number(TimeMath.flicksToSeconds(tok.range.start).toFixed(3)),
        endSec: Number(TimeMath.flicksToSeconds(tok.range.end).toFixed(3)),
        confidence: Number(tok.confidence.toFixed(4)),
      });
    }

    const rawTranscript = PersianTextNormalizer.extractRawTranscript(tokens);
    const normalizedTranscript = PersianTextNormalizer.extractNormalizedTranscript(tokens);

    if (words.length === 0 || rawTranscript.length === 0) {
      return {
        status: 'EMPTY_RESPONSE',
        rawTranscript: '',
        normalizedTranscript: '',
        words: [],
        meanConfidence: null,
        hypothesisProvenance: 'NONE',
        modelIdentity: identity,
        errorMessage: 'مدل محلی هیچ واژه‌ای از سیگنال صوتی تشخیص نداد (EMPTY_RESPONSE).',
        isMockTestOnly: false,
      };
    }

    const meanConfidence = Number(
      (words.reduce((acc, w) => acc + w.confidence, 0) / words.length).toFixed(4),
    );
    const provenance = binding.provenance ?? 'MODEL_INFERENCE';

    return {
      status: 'SUCCESS',
      rawTranscript,
      normalizedTranscript,
      words,
      meanConfidence,
      hypothesisProvenance: provenance,
      modelIdentity: identity,
      isMockTestOnly: provenance === 'DETERMINISTIC_TEST_FIXTURE',
    };
  }

  private isTimeoutReason(reason: unknown): boolean {
    if (!reason) return false;
    const text = reason instanceof Error ? reason.message : String(reason);
    return /timeout/i.test(text);
  }

  private async invokeCancelledCleanup(): Promise<void> {
    if (this.options.onCancelled) {
      try {
        await this.options.onCancelled();
      } catch {
        // ignore cleanup errors on cancellation
      }
    }
  }
}
