/**
 * AVP-P0-001 Work Package D — Unified Local ASR Workflow Service
 *
 * Single dependency-inverted orchestration layer invoked by `src/App.tsx` (`handleRunPersianAsr`).
 * - Resolves Browser Local Runtime (independent of Companion!) or optional Native Companion
 *   through `LocalAsrRuntimeResolver`.
 * - Enforces `LocalExecutionPolicy` (Cloud ASR permanently forbidden).
 * - Preserves model provenance, truthful readiness states, cancellation, and canonical
 *   `PersianWordToken[]` projection without duplicating any ASR engine logic.
 */

import {
  AsrModelLoadDescriptor,
  AsrProgressEvent,
  AsrRuntimeError,
  AvapardazTranscriptResult,
  LocalAsrRuntimeAdapter,
  LocalAsrRuntimeResolver,
  LocalAsrRuntimeTarget,
  RuntimeSelectionPreference,
} from '../asr-core/UnifiedLocalAsrRuntime';
import { LocalModelLifecycleManager } from '../lifecycle/LocalModelLifecycleManager';
import { parseCtcTokensTxt } from '../lifecycle/CanonicalModelProvenance';
import { buildCompanionTranscriptTokens } from '../utils/transcriptDisplay';
import type { PersianWordToken } from '../contracts/v1_2';

const VOCAB_STORAGE_PREFIX = 'avapardaz.ctc_vocab.v1:';

export function saveModelCtcVocabulary(modelId: string, version: string, tokensTxt: string): {
  readonly ok: boolean;
  readonly tokenCount: number;
  readonly error?: string;
} {
  let tokens: string[];
  try {
    tokens = parseCtcTokensTxt(tokensTxt);
    if (tokens.length === 0) {
      return { ok: false, tokenCount: 0, error: 'tokens.txt did not contain any valid vocabulary entries.' };
    }
  } catch (err) {
    return {
      ok: false,
      tokenCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${VOCAB_STORAGE_PREFIX}${modelId}@${version}`, JSON.stringify(tokens));
    }
  } catch {
    // non-fatal when storage quota or headless node lacks localStorage
  }
  return { ok: true, tokenCount: tokens.length };
}

export function loadModelCtcVocabulary(modelId: string, version: string): string[] | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(`${VOCAB_STORAGE_PREFIX}${modelId}@${version}`);
    if (!raw) return undefined;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === 'string')) {
      return arr;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface StudioLocalAsrRunRequest {
  readonly jobId: string;
  readonly projectId: string;
  readonly trackId: string;
  readonly speakerName: string;
  readonly sourceAssetId: string;
  readonly sourceAssetSha256: string;
  readonly fileName: string;
  readonly sampleRate: number;
  readonly totalSamples: number;
  readonly readSourceRange: (startSample: number, count: number) => Promise<Float32Array>;
  readonly preference: RuntimeSelectionPreference;
  readonly requestedCloudMode?: boolean;
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly explicitModelDescriptor?: AsrModelLoadDescriptor;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: AsrProgressEvent) => void;
}

export interface StudioLocalAsrRunOutcome {
  readonly ok: boolean;
  readonly runtimeTarget: LocalAsrRuntimeTarget | null;
  readonly result: AvapardazTranscriptResult | null;
  readonly tokens: PersianWordToken[];
  readonly errorCode?: string;
  readonly errorTitleFa?: string;
  readonly errorMessageFa?: string;
  readonly errorMessageEn?: string;
}

export class UnifiedLocalAsrWorkflowService {
  private readonly resolver: LocalAsrRuntimeResolver;
  private readonly modelManager?: LocalModelLifecycleManager;
  private activeAdapter: LocalAsrRuntimeAdapter | null = null;
  private activeJobId: string | null = null;

  constructor(params: {
    readonly browserAdapter?: LocalAsrRuntimeAdapter;
    readonly nativeCompanionAdapter?: LocalAsrRuntimeAdapter;
    readonly modelManager?: LocalModelLifecycleManager;
  }) {
    this.resolver = new LocalAsrRuntimeResolver({
      browser: params.browserAdapter,
      nativeCompanion: params.nativeCompanionAdapter,
    });
    this.modelManager = params.modelManager;
  }

  public async cancelActiveJob(): Promise<void> {
    if (this.activeAdapter && this.activeJobId) {
      await this.activeAdapter.cancel(this.activeJobId);
    }
  }

  public async runTranscription(request: StudioLocalAsrRunRequest): Promise<StudioLocalAsrRunOutcome> {
    if (request.requestedCloudMode) {
      return {
        ok: false,
        runtimeTarget: null,
        result: null,
        tokens: [],
        errorCode: 'LOCAL_ONLY_CLOUD_ASR_BLOCKED',
        errorTitleFa: 'پردازش ابری غیرفعال است (حالت ۱۰۰٪ محلی)',
        errorMessageFa:
          'آواپرداز بر اساس سیاست حریم خصوصی، هیچ فایل صوتی را به سرور ابری ارسال نمی‌کند. لطفاً از اجرای محلی مرورگر (ONNX/OPFS) یا سرویس Native Companion استفاده کنید.',
        errorMessageEn: 'Cloud ASR is permanently disabled by AVAPARDAZ Local-Only Execution Policy.',
      };
    }

    const installedActive = this.modelManager?.getSnapshot().activeModel ?? null;
    const hasBrowserInstalledModel = Boolean(request.explicitModelDescriptor || installedActive);

    const resolution = await this.resolver.resolve({
      preference: request.preference,
      requestedCloudMode: false,
      preferBrowserWhenModelInstalled: true,
      hasBrowserInstalledModel,
    });

    if (!resolution.selectedAdapter || !resolution.selectedTarget) {
      return {
        ok: false,
        runtimeTarget: null,
        result: null,
        tokens: [],
        errorCode: 'RUNTIME_UNAVAILABLE',
        errorTitleFa: 'موتور محلی در دسترس نیست',
        errorMessageFa: `هیچ موتور محلی آماده اجرا یافت نشد (${resolution.reason}).`,
        errorMessageEn: `No local ASR runtime available (${resolution.reason}).`,
      };
    }

    const adapter = resolution.selectedAdapter;
    let modelDescriptor = request.explicitModelDescriptor;

    if (!modelDescriptor && adapter.runtimeTarget !== 'NATIVE_COMPANION_CPU') {
      if (!installedActive) {
        return {
          ok: false,
          runtimeTarget: adapter.runtimeTarget,
          result: null,
          tokens: [],
          errorCode: 'MODEL_NOT_INSTALLED',
          errorTitleFa: 'مدل فارسی محلی نصب نشده است',
          errorMessageFa:
            'برای اجرای رونویسی مستقل درون مرورگر (بدون نیاز به Companion یا اینترنت)، ابتدا فایل مدل .onnx و فایل واژگان tokens.txt را از بخش «مدیریت چرخه حیات و مدل‌ها» وارد کنید.',
          errorMessageEn: 'No verified Persian ASR model is installed in local OPFS storage.',
        };
      }

      if (this.modelManager) {
        const integrity = await this.modelManager.verifyInstalledActiveModelOffline();
        if (!integrity.ok) {
          return {
            ok: false,
            runtimeTarget: adapter.runtimeTarget,
            result: null,
            tokens: [],
            errorCode: 'MODEL_INTEGRITY_FAILURE',
            errorTitleFa: 'اصالت فایل مدل محلی تأیید نشد',
            errorMessageFa:
              integrity.error ??
              'تطابق SHA-256 فایل وزن محلی (.onnx) شکست خورد؛ لطفاً فایل مدل را مجدداً نصب کنید.',
            errorMessageEn: integrity.error ?? 'Installed ONNX model failed offline SHA-256 verification.',
          };
        }
      }

      const ctcVocabulary = loadModelCtcVocabulary(installedActive.modelId, installedActive.version);
      modelDescriptor = {
        modelId: installedActive.modelId,
        modelVersion: installedActive.version,
        architecture: installedActive.architecture,
        verifiedSha256Hex: installedActive.verifiedSha256Hex,
        ctcVocabulary,
        executionProviders: ['wasm'],
      };
    }

    this.activeAdapter = adapter;
    this.activeJobId = request.jobId;

    try {
      const result = await adapter.transcribe({
        jobId: request.jobId,
        projectId: request.projectId,
        trackId: request.trackId,
        sourceAssetId: request.sourceAssetId,
        sourceAssetSha256: request.sourceAssetSha256,
        fileName: request.fileName,
        sampleRate: request.sampleRate,
        totalSamples: request.totalSamples,
        readSourceRange: request.readSourceRange,
        languageHint: request.languageHint ?? 'fa',
        modelDescriptor,
        signal: request.signal,
        onProgress: request.onProgress,
      });

      const tokens = buildCompanionTranscriptTokens({
        segments: result.segments.map((seg, idx) => ({
          id: seg.id,
          index: seg.index ?? idx,
          startSec: seg.startSec,
          endSec: seg.endSec,
          text: seg.normalizedText || seg.rawText,
          language: seg.language,
          timestampGranularity: seg.timestampGranularity,
          words: seg.words.map((w) => ({
            word: w.normalizedWord || w.word,
            startSec: w.startSec,
            endSec: w.endSec,
            confidence: w.confidence,
          })),
        })),
        trackId: request.trackId,
        speakerName: request.speakerName,
      });

      return {
        ok: true,
        runtimeTarget: result.runtimeTarget,
        result,
        tokens,
      };
    } catch (err) {
      const asrErr = err instanceof AsrRuntimeError ? err : null;
      const code = asrErr?.code ?? 'INFERENCE_FAILED';
      const msgEn = err instanceof Error ? err.message : String(err);
      const isVocabMissing = code === 'MODEL_INCOMPATIBLE' && /ctcVocabulary|tokens\.txt/i.test(msgEn);
      return {
        ok: false,
        runtimeTarget: adapter.runtimeTarget,
        result: null,
        tokens: [],
        errorCode: code,
        errorTitleFa:
          code === 'JOB_CANCELLED'
            ? 'رونویسی محلی لغو شد'
            : isVocabMissing
              ? 'فایل واژگان مدل (tokens.txt) بارگذاری نشده است'
              : code === 'MODEL_INTEGRITY_FAILURE'
                ? 'اصالت فایل مدل محلی تأیید نشد'
                : 'خطا در اجرای موتور محلی رونویسی',
        errorMessageFa: isVocabMissing
          ? 'مدل FastConformer CTC نصب شده اما فایل واژگان tokens.txt همراه آن بارگذاری نشده است. لطفاً فایل tokens.txt را در بخش «مدیریت مدل» وارد کنید.'
          : msgEn,
        errorMessageEn: msgEn,
      };
    } finally {
      this.activeAdapter = null;
      this.activeJobId = null;
    }
  }
}
