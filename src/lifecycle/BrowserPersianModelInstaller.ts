/**
 * AVAPARDAZ — Browser Local Persian ASR Model Installer (Independent of Companion)
 *
 * Fetches verified Shenava-Rizeh INT8 ONNX model (`model.int8.onnx`) + CTC vocabulary (`tokens.txt`)
 * over bounded <= 1 MiB HTTP Range slices, verifies FIPS 180-4 SHA-256 checksums for every artifact,
 * persists weights into OPFS via `LocalModelLifecycleManager`, and stores `tokens.txt` vocabulary
 * for standalone Web Worker `onnxruntime-web` WASM inference.
 */

import { sha256Bytes } from '../utils/StreamingSha256';
import { parseCtcTokensTxt } from './CanonicalModelProvenance';
import { MODEL_CHUNK_SIZE_BYTES } from './ModelRepositoryContracts';
import {
  LocalModelLifecycleManager,
  LocalModelLifecycleSnapshot,
} from './LocalModelLifecycleManager';
import { saveModelCtcVocabulary } from '../workflow/UnifiedLocalAsrWorkflowService';

export type BrowserModelInstallStage =
  | 'PREPARING'
  | 'VERIFYING_TOKENS'
  | 'STREAMING_ONNX'
  | 'COMPLETED';

export interface PreparedArtifactDescriptor {
  readonly byteLength: number;
  readonly sha256Hex: string;
  readonly url: string;
}

export interface PreparedShenavaModelResponse {
  readonly ok: boolean;
  readonly modelId: string;
  readonly upstreamModelId?: string;
  readonly modelVersion: string;
  readonly architecture: 'FASTCONFORMER_CTC';
  readonly sampleAudioAvailable?: boolean;
  readonly artifacts?: {
    readonly 'model.int8.onnx'?: PreparedArtifactDescriptor;
    readonly 'tokens.txt'?: PreparedArtifactDescriptor;
  };
  readonly error?: string;
  readonly message?: string;
}

export interface BrowserPersianModelInstallResult {
  readonly ok: boolean;
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly tokenCount?: number;
  readonly sampleAudioAvailable?: boolean;
  readonly snapshot: LocalModelLifecycleSnapshot;
  readonly errorCode?: string;
  readonly errorMessageFa?: string;
  readonly errorMessageEn?: string;
}

export interface InstallShenavaRizehInBrowserOptions {
  readonly modelManager: LocalModelLifecycleManager;
  readonly fetchFn?: typeof fetch;
  readonly prepareEndpoint?: string;
  readonly chunkSizeBytes?: number;
  readonly abortSignal?: AbortSignal;
  readonly saveVocabularyFn?: (
    modelId: string,
    version: string,
    tokensTxt: string,
  ) => { readonly ok: boolean; readonly tokenCount: number; readonly error?: string };
  readonly onProgress?: (percent: number, stage: BrowserModelInstallStage) => void;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function isSafeLocalArtifactUrl(url: string): boolean {
  return url.startsWith('/api/v1/local-models/') && !url.includes('..');
}

export async function installShenavaRizehInBrowser(
  options: InstallShenavaRizehInBrowserOptions,
): Promise<BrowserPersianModelInstallResult> {
  const fetchImpl = options.fetchFn ?? fetch;
  const prepareEndpoint = options.prepareEndpoint ?? '/api/v1/local-models/shenava-rizen/prepare';
  const chunkSizeBytes = Math.min(
    MODEL_CHUNK_SIZE_BYTES,
    Math.max(1024, Math.floor(options.chunkSizeBytes ?? MODEL_CHUNK_SIZE_BYTES)),
  );
  const saveVocabulary = options.saveVocabularyFn ?? saveModelCtcVocabulary;

  if (!options.modelManager.getSnapshot().initialized) {
    await options.modelManager.initialize();
  }

  options.onProgress?.(2, 'PREPARING');

  let prepared: PreparedShenavaModelResponse;
  try {
    const prepRes = await fetchImpl(prepareEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.abortSignal,
    });
    if (!prepRes.ok) {
      let detail = `HTTP ${prepRes.status}`;
      try {
        const errBody = (await prepRes.json()) as { message?: string; error?: string };
        detail = errBody.message ?? errBody.error ?? detail;
      } catch {
        // ignore JSON parse error
      }
      return {
        ok: false,
        snapshot: options.modelManager.getSnapshot(),
        errorCode: 'MODEL_PREPARE_HTTP_FAILED',
        errorMessageFa: `آماده‌سازی فایل‌های مدل فارسی ناموفق بود (${detail}).`,
        errorMessageEn: `Failed to prepare local Persian model artifacts (${detail}).`,
      };
    }
    prepared = (await prepRes.json()) as PreparedShenavaModelResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      snapshot: options.modelManager.getSnapshot(),
      errorCode: options.abortSignal?.aborted ? 'INSTALL_ABORTED' : 'MODEL_PREPARE_NETWORK_FAILED',
      errorMessageFa: options.abortSignal?.aborted
        ? 'نصب مدل فارسی توسط کاربر متوقف شد.'
        : `خطا در ارتباط با سرویس محلی آماده‌سازی مدل: ${msg}`,
      errorMessageEn: msg,
    };
  }

  const onnxArtifact = prepared.artifacts?.['model.int8.onnx'];
  const tokensArtifact = prepared.artifacts?.['tokens.txt'];
  if (
    !prepared.ok ||
    !prepared.modelId ||
    !prepared.modelVersion ||
    prepared.architecture !== 'FASTCONFORMER_CTC' ||
    !onnxArtifact ||
    !tokensArtifact ||
    !Number.isSafeInteger(onnxArtifact.byteLength) ||
    onnxArtifact.byteLength <= 0 ||
    !SHA256_HEX_RE.test(onnxArtifact.sha256Hex.toLowerCase()) ||
    !Number.isSafeInteger(tokensArtifact.byteLength) ||
    tokensArtifact.byteLength <= 0 ||
    !SHA256_HEX_RE.test(tokensArtifact.sha256Hex.toLowerCase()) ||
    !isSafeLocalArtifactUrl(onnxArtifact.url) ||
    !isSafeLocalArtifactUrl(tokensArtifact.url)
  ) {
    return {
      ok: false,
      snapshot: options.modelManager.getSnapshot(),
      errorCode: 'INVALID_PREPARE_MANIFEST',
      errorMessageFa: 'پاسخ مشخصات و اصالت مدل فارسی نامعتبر بود.',
      errorMessageEn: prepared.message ?? 'Invalid Shenava-Rizeh prepare manifest response.',
    };
  }

  const expectedOnnxSha = onnxArtifact.sha256Hex.toLowerCase();
  const expectedTokensSha = tokensArtifact.sha256Hex.toLowerCase();

  // Fail-fast atomic step: fetch, SHA-256 verify, and parse small tokens.txt before touching OPFS
  options.onProgress?.(6, 'VERIFYING_TOKENS');
  let tokensText: string;
  try {
    const tokRes = await fetchImpl(tokensArtifact.url, {
      method: 'GET',
      signal: options.abortSignal,
    });
    if (!tokRes.ok) {
      throw new Error(`TOKENS_HTTP_${tokRes.status}`);
    }
    const tokBytes = new Uint8Array(await tokRes.arrayBuffer());
    if (tokBytes.byteLength !== tokensArtifact.byteLength) {
      throw new Error(
        `TOKENS_SIZE_MISMATCH: expected ${tokensArtifact.byteLength} bytes, got ${tokBytes.byteLength}.`,
      );
    }
    const actualTokSha = sha256Bytes(tokBytes);
    if (actualTokSha !== expectedTokensSha) {
      throw new Error(
        `TOKENS_SHA256_MISMATCH: expected ${expectedTokensSha}, got ${actualTokSha}.`,
      );
    }
    tokensText = new TextDecoder('utf-8').decode(tokBytes);
    const parsed = parseCtcTokensTxt(tokensText);
    if (parsed.length === 0) {
      throw new Error('TOKENS_EMPTY: tokens.txt did not contain any valid vocabulary entries.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      snapshot: options.modelManager.getSnapshot(),
      errorCode: options.abortSignal?.aborted ? 'INSTALL_ABORTED' : 'TOKENS_VERIFICATION_FAILED',
      errorMessageFa: `دریافت یا راستی‌آزمایی فایل واژگان (tokens.txt) ناموفق بود: ${msg}`,
      errorMessageEn: msg,
    };
  }

  options.onProgress?.(10, 'STREAMING_ONNX');

  const installRes = await options.modelManager.installOrUpdateFromStream({
    manifest: {
      modelId: prepared.modelId,
      modelVersion: prepared.modelVersion,
      architecture: 'FASTCONFORMER_CTC',
      fileName: 'model.int8.onnx',
      expectedByteLength: onnxArtifact.byteLength,
      expectedSha256Hex: expectedOnnxSha,
    },
    stream: {
      supportsRangeResume: true,
      async fetchRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
        const inclusiveEnd = Math.max(start, end - 1);
        const rangeRes = await fetchImpl(onnxArtifact.url, {
          method: 'GET',
          headers: {
            Range: `bytes=${start}-${inclusiveEnd}`,
          },
          signal: signal ?? options.abortSignal,
        });
        if (!rangeRes.ok && rangeRes.status !== 206) {
          throw new Error(`ONNX_RANGE_HTTP_${rangeRes.status} for bytes=${start}-${inclusiveEnd}`);
        }
        const buf = await rangeRes.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const expectedLen = end - start;
        if (bytes.byteLength !== expectedLen) {
          throw new Error(
            `ONNX_RANGE_SHORT_READ: expected ${expectedLen} bytes [${start}, ${end}), got ${bytes.byteLength}.`,
          );
        }
        return bytes;
      },
    },
    chunkSizeBytes,
    abortSignal: options.abortSignal,
    sourceOrigin: 'Reza2kn/Shenava-Rizeh (Apache-2.0 · Local Provisioning)',
    license: 'Apache-2.0',
    onProgress: (pct) => {
      const scaled = Math.min(98, Math.max(10, Math.round(10 + (pct / 100) * 88)));
      options.onProgress?.(scaled, 'STREAMING_ONNX');
    },
  });

  if (!installRes.ok) {
    return {
      ok: false,
      snapshot: installRes.snapshot,
      errorCode: installRes.errorCode ?? 'ONNX_STREAM_INSTALL_FAILED',
      errorMessageFa:
        installRes.snapshot.lastError ??
        'نصب تکه‌ای و راستی‌آزمایی SHA-256 فایل مدل .onnx ناموفق بود.',
      errorMessageEn: installRes.snapshot.lastError ?? 'ONNX model stream installation failed.',
    };
  }

  const vocabRes = saveVocabulary(prepared.modelId, prepared.modelVersion, tokensText);
  if (!vocabRes.ok) {
    return {
      ok: false,
      snapshot: options.modelManager.getSnapshot(),
      errorCode: 'TOKENS_PARSE_FAILED',
      errorMessageFa: vocabRes.error ?? 'ساختار فایل واژگان tokens.txt نامعتبر است.',
      errorMessageEn: vocabRes.error ?? 'Failed to parse tokens.txt CTC vocabulary.',
    };
  }

  options.onProgress?.(100, 'COMPLETED');

  return {
    ok: true,
    modelId: prepared.modelId,
    modelVersion: prepared.modelVersion,
    tokenCount: vocabRes.tokenCount,
    sampleAudioAvailable: Boolean(prepared.sampleAudioAvailable),
    snapshot: options.modelManager.getSnapshot(),
  };
}

export async function fetchBundledBrowserSampleWav(options?: {
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly filename: string;
  readonly mimeType: 'audio/wav';
  readonly wavBytes: Uint8Array;
}> {
  const fetchImpl = options?.fetchFn ?? fetch;
  const res = await fetchImpl('/api/v1/local-models/shenava-rizen/artifacts/sample-0.wav', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(`SAMPLE_WAV_HTTP_${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (
    bytes.byteLength < 44 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46
  ) {
    throw new Error('INVALID_SAMPLE_WAV_HEADER: Expected RIFF audio/wav payload.');
  }
  return {
    filename: 'shenava-sample-0.wav',
    mimeType: 'audio/wav',
    wavBytes: bytes,
  };
}
