import { resampleTo16kMono } from '../../engine/resampler';
import type {
  AsrLabEngineId,
  EngineExecutionStatus,
  HypothesisProvenance,
  VerifiedModelIdentity,
  AsrEngineRegistryDescriptor,
  AudioIngestionValidationReport,
  EngineAdapterConfig,
  AsrInferenceRequest,
  AsrInferenceWordPrediction,
  AsrAdapterExecutionOutput,
  AsrProviderAdapter
} from './AsrExperimentationLabContracts';
export type {
  AsrLabEngineId,
  EngineExecutionStatus,
  HypothesisProvenance,
  VerifiedModelIdentity,
  AsrEngineRegistryDescriptor,
  AudioIngestionValidationReport,
  EngineAdapterConfig,
  AsrInferenceRequest,
  AsrInferenceWordPrediction,
  AsrAdapterExecutionOutput,
  AsrProviderAdapter
} from './AsrExperimentationLabContracts';
import {
  createLocalEngineDescriptor,
  LabLocalInferenceAdapter,
  LabLocalInferenceAdapterOptions,
} from './LabLocalInferenceAdapter';

export const LAB_EVALUATION_ALGORITHM_VERSION = 'Norm-FA-v1.0-Levenshtein';









export type CostEstimateLabel =
  | 'FREE_LOCAL_EXECUTION'
  | 'ESTIMATED_OFFICIAL_TARIFF'
  | 'NOT_BILLED_FAILED_RUN';



export const PHASE1_ENGINE_REGISTRY: readonly AsrEngineRegistryDescriptor[] = [
  createLocalEngineDescriptor(),
  {
    engineId: 'elevenlabs-scribe-v3',
    displayName: 'ElevenLabs Scribe v3',
    version: 'scribe_v3 (2026-11)',
    vendorOrFamily: 'ElevenLabs Commercial API',
    deploymentKind: 'COMMERCIAL_CLOUD_API',
    architecture: 'COMMERCIAL_CLOUD_ASR',
    supportsPersian: true,
    supportsEnglish: true,
    supportsCodeSwitching: true,
    supportsTranscription: true,
    supportsForcedAlignment: false,
    supportsSpeechSegmentation: false,
    supportsBatch: true,
    supportsStreaming: false,
    officialPricePerHourUsd: 0.30,
    requiredEnvVar: 'ELEVENLABS_API_KEY',
  },
  {
    engineId: 'deepgram-nova-3',
    displayName: 'Deepgram Nova-3',
    version: 'nova-3-multilingual (2026-10)',
    vendorOrFamily: 'Deepgram Commercial API',
    deploymentKind: 'COMMERCIAL_CLOUD_API',
    architecture: 'COMMERCIAL_CLOUD_ASR',
    supportsPersian: true,
    supportsEnglish: true,
    supportsCodeSwitching: true,
    supportsTranscription: true,
    supportsForcedAlignment: false,
    supportsSpeechSegmentation: false,
    supportsBatch: true,
    supportsStreaming: true,
    officialPricePerHourUsd: 0.26,
    requiredEnvVar: 'DEEPGRAM_API_KEY',
  },
  {
    engineId: 'openai-gpt-transcribe',
    displayName: 'OpenAI GPT-Transcribe',
    version: 'gpt-transcribe (2026)',
    vendorOrFamily: 'OpenAI Speech-to-Text API',
    deploymentKind: 'COMMERCIAL_CLOUD_API',
    architecture: 'COMMERCIAL_CLOUD_ASR',
    supportsPersian: true,
    supportsEnglish: true,
    supportsCodeSwitching: true,
    supportsTranscription: true,
    supportsForcedAlignment: false,
    supportsSpeechSegmentation: false,
    supportsBatch: true,
    supportsStreaming: false,
    officialPricePerHourUsd: 0.36,
    requiredEnvVar: 'OPENAI_API_KEY',
  },
  {
    engineId: 'qwen3-asr-1.7b-worker',
    displayName: 'Qwen3-ASR 1.7B (Open-Source)',
    version: 'Qwen3-ASR-1.7B',
    vendorOrFamily: 'Alibaba Qwen Open-Source (GPU Worker)',
    deploymentKind: 'SELF_HOSTED_GPU_WORKER',
    architecture: 'QWEN3_ASR_LLM',
    supportsPersian: true,
    supportsEnglish: true,
    supportsCodeSwitching: true,
    supportsTranscription: true,
    supportsForcedAlignment: false,
    supportsSpeechSegmentation: false,
    supportsBatch: true,
    supportsStreaming: true,
    officialPricePerHourUsd: 0.0,
    requiredEnvVar: 'QWEN3_ASR_WORKER_URL',
  },
  {
    engineId: 'whisper-large-v3-worker',
    displayName: 'Whisper Large-v3 / Turbo (Open-Source)',
    version: 'whisper-large-v3-turbo (51866 vocab)',
    vendorOrFamily: 'OpenAI Open-Source MIT (GPU Worker)',
    deploymentKind: 'SELF_HOSTED_GPU_WORKER',
    architecture: 'WHISPER_SEQ2SEQ',
    supportsPersian: true,
    supportsEnglish: true,
    supportsCodeSwitching: true,
    supportsTranscription: true,
    supportsForcedAlignment: false,
    supportsSpeechSegmentation: false,
    supportsBatch: true,
    supportsStreaming: false,
    officialPricePerHourUsd: 0.0,
    requiredEnvVar: 'WHISPER_WORKER_URL',
  },
  {
    engineId: 'gemini-audio-asr',
    displayName: 'Google Gemini Audio Transcribe',
    version: 'gemini-2.5-flash',
    vendorOrFamily: 'Google GenAI API',
    deploymentKind: 'COMMERCIAL_CLOUD_API',
    architecture: 'MULTIMODAL_CLOUD_ASR',
    supportsPersian: true,
    supportsEnglish: true,
    supportsCodeSwitching: true,
    supportsTranscription: true,
    supportsForcedAlignment: false,
    supportsSpeechSegmentation: false,
    supportsBatch: true,
    supportsStreaming: false,
    officialPricePerHourUsd: 0.18,
    requiredEnvVar: 'GEMINI_API_KEY',
  },
];



export interface SingleTierMetricBreakdown {
  readonly cerPercent: number;
  readonly werPercent: number;
  readonly merPercent: number;
  readonly wordHits: number;
  readonly wordSubstitutions: number;
  readonly wordDeletions: number;
  readonly wordInsertions: number;
  readonly refWordCount: number;
  readonly refCharCount: number;
  readonly hypWordCount: number;
  readonly hypCharCount: number;
}

export interface AsrPairEvaluationReport {
  readonly evaluationAlgorithmVersion: string;
  readonly referenceRaw: string;
  readonly referenceNormalized: string;
  readonly hypothesisRaw: string;
  readonly hypothesisNormalized: string;
  readonly rawMetrics: SingleTierMetricBreakdown;
  readonly normalizedMetrics: SingleTierMetricBreakdown;
}

/**
 * Pure inference configuration passed to ASR provider adapters.
 * MUST NEVER contain reference transcripts, expected gold outputs, or reference-derived hints.
 */








export interface EngineExperimentRunResult {
  readonly engineId: AsrLabEngineId;
  readonly engineName: string;
  readonly engineVersion: string;
  readonly status: EngineExecutionStatus;
  readonly hypothesisProvenance: HypothesisProvenance;
  readonly modelIdentity: VerifiedModelIdentity;
  readonly eligibleForAccuracyLeaderboard: boolean;
  /** True ONLY inside isolated unit tests; NEVER reported as a real engine run in dashboard */
  readonly isMockTestOnly: boolean;
  readonly config: EngineAdapterConfig;
  readonly startTimestampIso: string;
  readonly endTimestampIso: string;
  readonly processingTimeMs: number;
  readonly rtf: number;
  readonly rawOutputText: string;
  readonly normalizedOutputText: string;
  readonly words?: readonly AsrInferenceWordPrediction[];
  readonly meanConfidence?: number | null;
  readonly evaluation: AsrPairEvaluationReport | null;
  readonly costUsd: number;
  readonly costLabel: CostEstimateLabel;
  readonly errorMessage?: string;
}

export interface AsrLabExperimentRecord {
  readonly experimentId: string;
  readonly createdAtIso: string;
  readonly audioSha256: string;
  readonly fileName: string;
  readonly fileVersion: string;
  readonly audioDurationSec: number;
  readonly originalSampleRate: number;
  readonly originalChannels: number;
  readonly standardizedSampleRate: 16000;
  readonly expectedLanguage: EngineAdapterConfig['expectedLanguage'];
  readonly referenceTranscriptRaw: string;
  readonly referenceTranscriptNormalized: string;
  readonly evaluationAlgorithmVersion: string;
  readonly engineResults: readonly EngineExperimentRunResult[];
}



const PERSIAN_ZWNJ_PREFIXES = new Set(['می', 'نمی']);
const PERSIAN_ZWNJ_SUFFIXES = new Set([
  'ها',
  'های',
  'هایی',
  'تر',
  'ترین',
  'ام',
  'ات',
  'اش',
  'مان',
  'تان',
  'شان',
]);

const SYNTHETIC_PLACEHOLDER_OUTPUT_RE = /(?:^|\s)(?:بخشِ_\d+|\[?بخش_گفتار_\d+\]?)(?:\s|$)/;

const EMPTY_MODEL_IDENTITY: VerifiedModelIdentity = Object.freeze({
  modelId: null,
  modelVersion: null,
  modelSha256: null,
  architecture: null,
});

/**
 * Redacts any accidental secret, Bearer token, or API key pattern from logs and error strings.
 */
export function sanitizeSecretsFromText(input: string): string {
  if (!input) return '';
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/\b(sk|xi|dg|AIza)[A-Za-z0-9\-_]{10,}\b/g, '[REDACTED_API_KEY]')
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*["']?[^\s"',]+/gi, '$1=[REDACTED]');
}

/**
 * Constructs a clean, frozen inference config containing ONLY permitted inference fields,
 * guaranteeing that no reference transcript or extraneous property can leak to adapters.
 * For frozen test samples, strips keyterms and contextPrompt to prevent test-set adaptation.
 */
export function buildIsolatedInferenceConfig(
  rawConfig: EngineAdapterConfig,
): EngineAdapterConfig {
  const isFrozen = Boolean(rawConfig.isFrozenTestSample);
  const cleanKeyterms = isFrozen
    ? []
    : Array.isArray(rawConfig.keyterms)
      ? rawConfig.keyterms
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map((k) => k.trim())
      : [];
  const cleanPrompt =
    !isFrozen && typeof rawConfig.contextPrompt === 'string' && rawConfig.contextPrompt.trim().length > 0
      ? rawConfig.contextPrompt.trim()
      : undefined;

  return Object.freeze({
    expectedLanguage: rawConfig.expectedLanguage,
    mode: rawConfig.mode,
    keyterms: Object.freeze(cleanKeyterms),
    ...(cleanPrompt !== undefined ? { contextPrompt: cleanPrompt } : {}),
    ...(typeof rawConfig.timeoutMs === 'number' && Number.isFinite(rawConfig.timeoutMs)
      ? { timeoutMs: Math.max(10, Math.trunc(rawConfig.timeoutMs)) }
      : {}),
    ...(isFrozen ? { isFrozenTestSample: true } : {}),
  });
}

/**
 * Computes a deterministic SHA-256 hex digest of a Float32Array or Uint8Array buffer
 * without external dependencies (works identically in browser & Node.js).
 */
export function computeDeterministicAudioSha256(bytes: Uint8Array): string {
  // Pure TypeScript FIPS 180-4 SHA-256 implementation for synchronous zero-dependency hashing
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  // Sample up to first 64KB + tail for fast synchronous hashing on large buffers, or full buffer if <= 128KB
  const maxHashLen = 131072;
  let sampleBytes = bytes;
  if (bytes.length > maxHashLen) {
    sampleBytes = new Uint8Array(maxHashLen);
    sampleBytes.set(bytes.subarray(0, 65536), 0);
    sampleBytes.set(bytes.subarray(bytes.length - 65536), 65536);
  }

  const bitLen = sampleBytes.length * 8;
  const paddedLen = Math.ceil((sampleBytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(sampleBytes);
  padded[sampleBytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return `${hex(h0)}${hex(h1)}${hex(h2)}${hex(h3)}${hex(h4)}${hex(h5)}${hex(h6)}${hex(h7)}`;
}

/**
 * Validates raw audio PCM channels and sample rate, checks for corruption/NaN/empty signal,
 * preserves the original channels untouched, and performs real signal resampling to 16,000 Hz Mono.
 */
export function validateAndPreprocessAudioForLab(params: {
  fileName: string;
  fileVersion?: string;
  channelsPcm: readonly Float32Array[];
  sampleRate: number;
  detectedFormat?: AudioIngestionValidationReport['detectedFormat'];
}): AudioIngestionValidationReport {
  const {
    fileName,
    fileVersion = 'v1.0-raw',
    channelsPcm,
    sampleRate,
    detectedFormat = 'wav',
  } = params;

  if (!channelsPcm || channelsPcm.length === 0 || !channelsPcm[0] || channelsPcm[0].length === 0) {
    return {
      isValid: false,
      fileName,
      detectedFormat: 'invalid',
      audioSha256: '0'.repeat(64),
      fileVersion,
      originalSampleRate: sampleRate || 0,
      originalChannels: 0,
      standardizedSampleRate: 16000,
      standardizedChannels: 1,
      durationSec: 0,
      originalSampleCount: 0,
      standardizedSampleCount: 0,
      rmsDbfs: -100,
      peakDbfs: -100,
      hasClipping: false,
      standardizedPcm16k: new Float32Array(0),
      errorCode: 'EMPTY_OR_CORRUPTED_AUDIO',
      errorMessageFa: 'فایل صوتی خالی یا فاقد نمونه سیگنال معتبر است.',
    };
  }

  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 192000) {
    return {
      isValid: false,
      fileName,
      detectedFormat: 'invalid',
      audioSha256: '0'.repeat(64),
      fileVersion,
      originalSampleRate: sampleRate,
      originalChannels: channelsPcm.length,
      standardizedSampleRate: 16000,
      standardizedChannels: 1,
      durationSec: 0,
      originalSampleCount: channelsPcm[0].length,
      standardizedSampleCount: 0,
      rmsDbfs: -100,
      peakDbfs: -100,
      hasClipping: false,
      standardizedPcm16k: new Float32Array(0),
      errorCode: 'INVALID_SAMPLE_RATE',
      errorMessageFa: `نرخ نمونه‌برداری (${sampleRate} Hz) خارج از محدوده استاندارد صوت است.`,
    };
  }

  const ch0 = channelsPcm[0];
  const durationSec = ch0.length / sampleRate;
  if (durationSec < 0.1) {
    return {
      isValid: false,
      fileName,
      detectedFormat: 'invalid',
      audioSha256: '0'.repeat(64),
      fileVersion,
      originalSampleRate: sampleRate,
      originalChannels: channelsPcm.length,
      standardizedSampleRate: 16000,
      standardizedChannels: 1,
      durationSec: Number(durationSec.toFixed(3)),
      originalSampleCount: ch0.length,
      standardizedSampleCount: 0,
      rmsDbfs: -100,
      peakDbfs: -100,
      hasClipping: false,
      standardizedPcm16k: new Float32Array(0),
      errorCode: 'DURATION_TOO_SHORT',
      errorMessageFa: 'مدت فایل صوتی کمتر از ۰.۱ ثانیه است و برای آزمایش ASR معتبر نیست.',
    };
  }

  for (let i = 0; i < ch0.length; i += Math.max(1, Math.floor(ch0.length / 5000))) {
    if (!Number.isFinite(ch0[i])) {
      return {
        isValid: false,
        fileName,
        detectedFormat: 'invalid',
        audioSha256: '0'.repeat(64),
        fileVersion,
        originalSampleRate: sampleRate,
        originalChannels: channelsPcm.length,
        standardizedSampleRate: 16000,
        standardizedChannels: 1,
        durationSec: Number(durationSec.toFixed(3)),
        originalSampleCount: ch0.length,
        standardizedSampleCount: 0,
        rmsDbfs: -100,
        peakDbfs: -100,
        hasClipping: false,
        standardizedPcm16k: new Float32Array(0),
        errorCode: 'CORRUPTED_NAN_SAMPLES',
        errorMessageFa: 'سیگنال صوتی حاوی مقادیر نامعتبر (NaN / Infinity) و خراب است.',
      };
    }
  }

  const rawByteView = new Uint8Array(ch0.buffer, ch0.byteOffset, ch0.byteLength);
  const audioSha256 = computeDeterministicAudioSha256(rawByteView);

  const resampled = resampleTo16kMono(
    channelsPcm.map((c) => new Float32Array(c)),
    sampleRate,
    16000,
  );
  const stdPcm = resampled.samples;

  let sumSq = 0;
  let peak = 0;
  let clippedCount = 0;
  for (let i = 0; i < stdPcm.length; i++) {
    const abs = Math.abs(stdPcm[i]);
    if (abs > peak) peak = abs;
    if (abs >= 0.999) clippedCount++;
    sumSq += stdPcm[i] * stdPcm[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(1, stdPcm.length));
  const rmsDbfs = Number((20 * Math.log10(Math.max(1e-7, rms))).toFixed(2));
  const peakDbfs = Number((20 * Math.log10(Math.max(1e-7, peak))).toFixed(2));

  return {
    isValid: true,
    fileName,
    detectedFormat,
    audioSha256,
    fileVersion,
    originalSampleRate: sampleRate,
    originalChannels: channelsPcm.length,
    standardizedSampleRate: 16000,
    standardizedChannels: 1,
    durationSec: Number(durationSec.toFixed(3)),
    originalSampleCount: ch0.length,
    standardizedSampleCount: stdPcm.length,
    rmsDbfs,
    peakDbfs,
    hasClipping: clippedCount > 5,
    standardizedPcm16k: stdPcm,
  };
}

/**
 * Norm-FA-v1.0: Canonical Persian & English Unicode Normalization Policy.
 */
export function normalizePersianEnglishForEval(text: string): string {
  if (!text) return '';

  let s = text.normalize('NFC');

  s = s
    .replace(/[\u0643\u06ac\u06ad\u06ae]/g, '\u06a9')
    .replace(/[\u064a\u0649\u0626]/g, '\u06cc')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/[\u0629\u06c0]/g, '\u0647');

  s = s
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));

  s = s.replace(/[\u064B-\u065F\u0670\u0654\u0640]/g, '');
  s = s.replace(/[\u200b-\u200f\u202a-\u202e]+/g, ' ');
  s = s.replace(/[،؛.؟!?:«»"'()[\]{}\-_/\\|,@#$%^&*+=~`<>]+/g, ' ');

  const rawTokens = s
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const merged: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const cur = rawTokens[i];
    const nxt = i + 1 < rawTokens.length ? rawTokens[i + 1] : null;
    if (PERSIAN_ZWNJ_PREFIXES.has(cur) && nxt !== null) {
      merged.push(cur + nxt);
      i++;
      continue;
    }
    if (nxt !== null && PERSIAN_ZWNJ_SUFFIXES.has(nxt)) {
      merged.push(cur + nxt);
      i++;
      continue;
    }
    merged.push(cur);
  }

  return merged.join(' ');
}

function computeLevenshteinAlignmentCounts<T>(
  refSeq: readonly T[],
  hypSeq: readonly T[],
): { hits: number; substitutions: number; deletions: number; insertions: number } {
  const n = refSeq.length;
  const m = hypSeq.length;

  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const op: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  for (let i = 1; i <= n; i++) {
    dp[i][0] = i;
    op[i][0] = 2;
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = j;
    op[0][j] = 3;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refSeq[i - 1] === hypSeq[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
        op[i][j] = 0;
      } else {
        const subC = dp[i - 1][j - 1] + 1;
        const delC = dp[i - 1][j] + 1;
        const insC = dp[i][j - 1] + 1;
        const best = Math.min(subC, delC, insC);
        dp[i][j] = best;
        if (best === subC) op[i][j] = 1;
        else if (best === delC) op[i][j] = 2;
        else op[i][j] = 3;
      }
    }
  }

  let hits = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const curOp = op[i][j];
    if (i > 0 && j > 0 && (curOp === 0 || curOp === 1)) {
      if (curOp === 0) hits++;
      else substitutions++;
      i--;
      j--;
    } else if (i > 0 && (j === 0 || curOp === 2)) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }

  return { hits, substitutions, deletions, insertions };
}

function buildTierMetrics(refText: string, hypText: string): SingleTierMetricBreakdown {
  const refWords = refText.split(/\s+/).filter(Boolean);
  const hypWords = hypText.split(/\s+/).filter(Boolean);
  const refChars = Array.from(refText.replace(/\s+/g, ''));
  const hypChars = Array.from(hypText.replace(/\s+/g, ''));

  const wCounts = computeLevenshteinAlignmentCounts(refWords, hypWords);
  const cCounts = computeLevenshteinAlignmentCounts(refChars, hypChars);

  const wErrors = wCounts.substitutions + wCounts.deletions + wCounts.insertions;
  const cErrors = cCounts.substitutions + cCounts.deletions + cCounts.insertions;

  const werPercent =
    refWords.length > 0
      ? (wErrors / refWords.length) * 100
      : hypWords.length > 0
        ? 100
        : 0;
  const cerPercent =
    refChars.length > 0
      ? (cErrors / refChars.length) * 100
      : hypChars.length > 0
        ? 100
        : 0;
  const merPercent =
    wCounts.hits + wErrors > 0 ? (wErrors / (wCounts.hits + wErrors)) * 100 : 0;

  return {
    cerPercent: Number(cerPercent.toFixed(2)),
    werPercent: Number(werPercent.toFixed(2)),
    merPercent: Number(merPercent.toFixed(2)),
    wordHits: wCounts.hits,
    wordSubstitutions: wCounts.substitutions,
    wordDeletions: wCounts.deletions,
    wordInsertions: wCounts.insertions,
    refWordCount: refWords.length,
    refCharCount: refChars.length,
    hypWordCount: hypWords.length,
    hypCharCount: hypChars.length,
  };
}

/**
 * Evaluates a single ASR hypothesis against a human-verified reference transcript,
 * returning both Raw and Normalized (Norm-FA-v1.0) CER, WER, and MER.
 */
export function evaluateTranscriptAgainstReference(
  referenceText: string,
  hypothesisText: string,
): AsrPairEvaluationReport {
  const referenceRaw = referenceText.trim();
  const hypothesisRaw = hypothesisText.trim();

  const referenceNormalized = normalizePersianEnglishForEval(referenceRaw);
  const hypothesisNormalized = normalizePersianEnglishForEval(hypothesisRaw);

  return {
    evaluationAlgorithmVersion: LAB_EVALUATION_ALGORITHM_VERSION,
    referenceRaw,
    referenceNormalized,
    hypothesisRaw,
    hypothesisNormalized,
    rawMetrics: buildTierMetrics(referenceRaw, hypothesisRaw),
    normalizedMetrics: buildTierMetrics(referenceNormalized, hypothesisNormalized),
  };
}

/**
 * Local ASR Provider Adapter (AVP-ASR-GOLD-REFERENCE-ISOLATION-009).
 * Delegates strictly to `LabLocalInferenceAdapter` backed by an initialized, verified local
 * ONNX neural model runtime. Never injects reference text, never runs forced alignment, and
 * never fabricates placeholder words when no neural model is installed or ready.
 */
export class AvapardazLocalCtcDspAdapter extends LabLocalInferenceAdapter {
  constructor(options?: LabLocalInferenceAdapterOptions) {
    super(options);
  }
}

export { createLocalEngineDescriptor, LabLocalInferenceAdapter } from './LabLocalInferenceAdapter';
export type {
  LabLocalInferenceAdapterOptions,
  LocalModelRuntimeBinding,
} from './LabLocalInferenceAdapter';

/**
 * Remote / Cloud Provider Adapter that queries the server-side `/api/v1/lab/provider-transcribe` endpoint
 * or reports honest `MISSING_API_KEY` / `WORKER_OFFLINE` without fabricating vendor outputs.
 */
export class ServerBackedProviderAdapter implements AsrProviderAdapter {
  constructor(
    public readonly descriptor: AsrEngineRegistryDescriptor,
    private readonly customTransport?: (params: {
      engineId: AsrLabEngineId;
      audio: AudioIngestionValidationReport;
      config: EngineAdapterConfig;
      signal: AbortSignal;
      experimentId: string;
    }) => Promise<AsrAdapterExecutionOutput>,
  ) {}

  public async transcribe(request: AsrInferenceRequest): Promise<AsrAdapterExecutionOutput> {
    if (request.signal.aborted) {
      return {
        status: 'TIMEOUT',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: EMPTY_MODEL_IDENTITY,
        errorMessage: 'درخواست پیش از ارسال لغو یا منقضی شد.',
        isMockTestOnly: false,
      };
    }

    if (this.customTransport) {
      return this.customTransport({
        engineId: this.descriptor.engineId,
        audio: request.audio,
        config: request.config,
        signal: request.signal,
        experimentId: request.experimentId,
      });
    }

    if (typeof window === 'undefined') {
      const envKey = this.descriptor.requiredEnvVar;
      const envVal = envKey ? process.env[envKey] : undefined;
      if (!envVal || !envVal.trim()) {
        return {
          status:
            this.descriptor.deploymentKind === 'SELF_HOSTED_GPU_WORKER'
              ? 'WORKER_OFFLINE'
              : 'MISSING_API_KEY',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: EMPTY_MODEL_IDENTITY,
          errorMessage:
            this.descriptor.deploymentKind === 'SELF_HOSTED_GPU_WORKER'
              ? `آدرس سرور GPU (${envKey}) در متغیرهای محیطی تنظیم نشده است.`
              : `کلید دسترسی (${envKey}) در متغیرهای محیطی سرور تنظیم نشده است.`,
          isMockTestOnly: false,
        };
      }
    }

    try {
      const response = await fetch('/api/v1/lab/provider-transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engineId: this.descriptor.engineId,
          experimentId: request.experimentId,
          audioSha256: request.audio.audioSha256,
          durationSec: request.audio.durationSec,
          expectedLanguage: request.config.expectedLanguage,
          keyterms: request.config.keyterms,
          contextPrompt: request.config.contextPrompt,
        }),
        signal: request.signal,
      });

      const data = await response.json();
      const status: EngineExecutionStatus =
        data.status ?? (response.ok ? 'SUCCESS' : 'API_ERROR');
      const rawTranscript = typeof data.rawTranscript === 'string' ? data.rawTranscript : '';
      return {
        status,
        rawTranscript,
        hypothesisProvenance:
          status === 'SUCCESS' && rawTranscript.trim().length > 0
            ? 'MODEL_INFERENCE'
            : 'NONE',
        modelIdentity:
          status === 'SUCCESS'
            ? {
                modelId: this.descriptor.engineId,
                modelVersion: this.descriptor.version,
                modelSha256: null,
                architecture: this.descriptor.architecture ?? 'REMOTE_ASR',
              }
            : EMPTY_MODEL_IDENTITY,
        errorMessage: data.errorMessage
          ? sanitizeSecretsFromText(String(data.errorMessage))
          : undefined,
        isMockTestOnly: false,
      };
    } catch (err) {
      if (request.signal.aborted) {
        return {
          status: 'TIMEOUT',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: EMPTY_MODEL_IDENTITY,
          errorMessage: 'مهلت زمانی (Timeout) ارتباط با سرویس به پایان رسید.',
          isMockTestOnly: false,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/abort|timeout/i.test(msg)) {
        return {
          status: 'TIMEOUT',
          rawTranscript: '',
          hypothesisProvenance: 'NONE',
          modelIdentity: EMPTY_MODEL_IDENTITY,
          errorMessage: 'مهلت زمانی (Timeout) ارتباط با سرویس به پایان رسید.',
          isMockTestOnly: false,
        };
      }
      return {
        status:
          this.descriptor.deploymentKind === 'SELF_HOSTED_GPU_WORKER'
            ? 'WORKER_OFFLINE'
            : 'MISSING_API_KEY',
        rawTranscript: '',
        hypothesisProvenance: 'NONE',
        modelIdentity: EMPTY_MODEL_IDENTITY,
        errorMessage: sanitizeSecretsFromText(
          this.descriptor.deploymentKind === 'SELF_HOSTED_GPU_WORKER'
            ? `سرور GPU (${this.descriptor.requiredEnvVar}) در دسترس نیست.`
            : `کلید ${this.descriptor.requiredEnvVar} تنظیم نشده یا ارتباط با سرور برقرار نشد.`,
        ),
        isMockTestOnly: false,
      };
    }
  }
}

/**
 * Executes a reproducible multi-engine ASR experiment over an identical validated audio input
 * with strict ground-truth isolation, per-engine AbortController timeout/cancellation, and
 * 7-gate accuracy leaderboard admission control.
 */
export async function runAsrLabExperiment(params: {
  experimentId?: string;
  audio: AudioIngestionValidationReport;
  referenceTranscriptRaw: string;
  selectedEngineIds: readonly AsrLabEngineId[];
  config: EngineAdapterConfig;
  customAdapters?: ReadonlyMap<AsrLabEngineId, AsrProviderAdapter>;
  localAdapterOptions?: LabLocalInferenceAdapterOptions;
  signal?: AbortSignal;
}): Promise<AsrLabExperimentRecord> {
  const {
    experimentId = `EXP-${Date.now()}-${params.audio.audioSha256.slice(0, 6)}`,
    audio,
    referenceTranscriptRaw,
    selectedEngineIds,
    config,
    customAdapters,
    localAdapterOptions,
    signal: experimentSignal,
  } = params;

  // Gate A — Valid input
  if (!audio.isValid) {
    throw new Error(
      `INVALID_AUDIO_FOR_EXPERIMENT: ${audio.errorCode ?? 'UNKNOWN'} - ${audio.errorMessageFa ?? ''}`,
    );
  }

  // Gate B — Independent reference (remains strictly inside evaluator scope; never exposed to adapters)
  if (!referenceTranscriptRaw || !referenceTranscriptRaw.trim()) {
    throw new Error(
      'MISSING_REFERENCE_TRANSCRIPT: متن مرجع تاییدشده توسط انسان برای اجرای آزمایش الزامی است.',
    );
  }

  const isolatedConfig = buildIsolatedInferenceConfig(config);

  const defaultAdapters = new Map<AsrLabEngineId, AsrProviderAdapter>();
  defaultAdapters.set(
    'avapardaz-local-ctc-dsp',
    new AvapardazLocalCtcDspAdapter(localAdapterOptions),
  );
  for (const desc of PHASE1_ENGINE_REGISTRY.slice(1)) {
    defaultAdapters.set(desc.engineId, new ServerBackedProviderAdapter(desc));
  }

  const runSingleEngine = async (
    engineId: AsrLabEngineId,
  ): Promise<EngineExperimentRunResult> => {
    const adapter = customAdapters?.get(engineId) ?? defaultAdapters.get(engineId);
    const descriptor =
      adapter?.descriptor ??
      PHASE1_ENGINE_REGISTRY.find((d) => d.engineId === engineId) ??
      PHASE1_ENGINE_REGISTRY[0];

    const startPerf = performance.now();
    const startTimestampIso = new Date().toISOString();
    const timeoutMs = isolatedConfig.timeoutMs ?? 15000;

    let status: EngineExecutionStatus = 'API_ERROR';
    let rawOutputText = '';
    let adapterNormalizedText: string | undefined;
    let words: readonly AsrInferenceWordPrediction[] | undefined;
    let meanConfidence: number | null | undefined;
    let hypothesisProvenance: HypothesisProvenance = 'NONE';
    let modelIdentity: VerifiedModelIdentity = EMPTY_MODEL_IDENTITY;
    let errorMessage: string | undefined;
    let isMockTestOnly = false;

    const engineController = new AbortController();
    let timedOut = false;
    let externallyCancelled = false;
    let finalized = false;

    const onExperimentAbort = () => {
      externallyCancelled = true;
      if (!engineController.signal.aborted) {
        engineController.abort(experimentSignal?.reason ?? new Error('EXPERIMENT_CANCELLED'));
      }
    };

    if (experimentSignal) {
      if (experimentSignal.aborted) {
        onExperimentAbort();
      } else {
        experimentSignal.addEventListener('abort', onExperimentAbort, { once: true });
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let onEngineAbort: (() => void) | null = null;

    try {
      if (!adapter) {
        status = 'API_ERROR';
        errorMessage = `آداپتور موتور ${engineId} یافت نشد.`;
      } else if (engineController.signal.aborted) {
        status = timedOut ? 'TIMEOUT' : 'API_ERROR';
        errorMessage = externallyCancelled
          ? 'اجرای آزمایش پیش از شروع لغو شد.'
          : `مهلت زمانی پردازش (${timeoutMs}ms) به پایان رسید.`;
      } else {
        const abortRacePromise = new Promise<AsrAdapterExecutionOutput>((resolve) => {
          onEngineAbort = () => {
            resolve({
              status: timedOut ? 'TIMEOUT' : 'API_ERROR',
              rawTranscript: '',
              hypothesisProvenance: 'NONE',
              modelIdentity: EMPTY_MODEL_IDENTITY,
              errorMessage: timedOut
                ? `مهلت زمانی پردازش (${timeoutMs}ms) به پایان رسید.`
                : 'اجرای آزمایش توسط کاربر لغو شد.',
              isMockTestOnly: false,
            });
          };
          engineController.signal.addEventListener('abort', onEngineAbort, { once: true });
        });

        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (!engineController.signal.aborted) {
            engineController.abort(new Error(`ASR_ENGINE_TIMEOUT_${timeoutMs}ms`));
          }
        }, timeoutMs);

        // Strictly pass ONLY { audio, config: isolatedConfig, signal, experimentId } — ZERO reference data!
        const adapterPromise = adapter.transcribe({
          audio,
          config: isolatedConfig,
          signal: engineController.signal,
          experimentId,
        });
        // Prevent unhandled rejection if adapter rejects after timeout/cancellation
        adapterPromise.catch(() => {});

        const res = await Promise.race([adapterPromise, abortRacePromise]);
        finalized = true;

        if (timedOut) {
          status = 'TIMEOUT';
          rawOutputText = '';
          hypothesisProvenance = 'NONE';
          modelIdentity = EMPTY_MODEL_IDENTITY;
          errorMessage = `مهلت زمانی پردازش (${timeoutMs}ms) به پایان رسید.`;
        } else if (externallyCancelled) {
          status = 'API_ERROR';
          rawOutputText = '';
          hypothesisProvenance = 'NONE';
          modelIdentity = EMPTY_MODEL_IDENTITY;
          errorMessage = 'اجرای آزمایش لغو شد.';
        } else {
          status = res.status;
          rawOutputText = (res.rawTranscript ?? '').trim();
          adapterNormalizedText = res.normalizedTranscript;
          words = res.words;
          meanConfidence = res.meanConfidence;
          isMockTestOnly = Boolean(res.isMockTestOnly);
          hypothesisProvenance =
            res.hypothesisProvenance ??
            (status === 'SUCCESS'
              ? isMockTestOnly
                ? 'DETERMINISTIC_TEST_FIXTURE'
                : 'MODEL_INFERENCE'
              : 'NONE');
          modelIdentity = res.modelIdentity ?? EMPTY_MODEL_IDENTITY;
          errorMessage = res.errorMessage
            ? sanitizeSecretsFromText(res.errorMessage)
            : undefined;

          // Gate C — Real hypothesis (reject empty or synthetic placeholder outputs)
          if (status === 'SUCCESS' && rawOutputText.length === 0) {
            status = 'EMPTY_RESPONSE';
            hypothesisProvenance = 'NONE';
            errorMessage = 'پاسخ دریافتی از موتور خالی بود.';
          } else if (
            status === 'SUCCESS' &&
            SYNTHETIC_PLACEHOLDER_OUTPUT_RE.test(rawOutputText)
          ) {
            status = 'EMPTY_RESPONSE';
            rawOutputText = '';
            hypothesisProvenance = 'NONE';
            errorMessage = 'خروجی ساختگی بخش‌بندی صوتی به عنوان تشخیص گفتار معتبر رد شد.';
          }
        }
      }
    } catch (err) {
      if (!finalized) {
        status = timedOut ? 'TIMEOUT' : 'API_ERROR';
        hypothesisProvenance = 'NONE';
        modelIdentity = EMPTY_MODEL_IDENTITY;
        const rawErr = err instanceof Error ? err.message : String(err);
        errorMessage = sanitizeSecretsFromText(rawErr);
      }
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
      if (onEngineAbort) {
        engineController.signal.removeEventListener('abort', onEngineAbort);
      }
      if (experimentSignal) {
        experimentSignal.removeEventListener('abort', onExperimentAbort);
      }
    }

    const endPerf = performance.now();
    const endTimestampIso = new Date().toISOString();
    const processingTimeMs = Number(Math.max(0.1, endPerf - startPerf).toFixed(2));
    const rtf = Number(
      (processingTimeMs / 1000 / Math.max(0.1, audio.durationSec)).toFixed(4),
    );

    const normalizedOutputText =
      status === 'SUCCESS' && rawOutputText.length > 0
        ? adapterNormalizedText ?? normalizePersianEnglishForEval(rawOutputText)
        : '';

    // Gate D, F, G — Genuine provenance + verified model identity + no false leaderboard admission
    const hasVerifiedModelIdentity =
      descriptor.deploymentKind === 'LOCAL_IN_PROCESS'
        ? Boolean(
            modelIdentity.modelId &&
              modelIdentity.modelVersion &&
              modelIdentity.modelSha256 &&
              modelIdentity.architecture,
          )
        : Boolean(modelIdentity.modelId && modelIdentity.modelVersion);

    const eligibleForAccuracyLeaderboard =
      status === 'SUCCESS' &&
      hypothesisProvenance === 'MODEL_INFERENCE' &&
      !isMockTestOnly &&
      rawOutputText.length > 0 &&
      hasVerifiedModelIdentity;

    // Gate E — Reference evaluation ONLY after inference output finalized and all gates pass
    const evaluation = eligibleForAccuracyLeaderboard
      ? evaluateTranscriptAgainstReference(referenceTranscriptRaw, rawOutputText)
      : null;

    let costUsd = 0;
    let costLabel: CostEstimateLabel = 'NOT_BILLED_FAILED_RUN';
    if (status === 'SUCCESS') {
      if (descriptor.officialPricePerHourUsd <= 0) {
        costUsd = 0;
        costLabel = 'FREE_LOCAL_EXECUTION';
      } else {
        costUsd = Number(
          ((audio.durationSec / 3600) * descriptor.officialPricePerHourUsd).toFixed(6),
        );
        costLabel = 'ESTIMATED_OFFICIAL_TARIFF';
      }
    }

    return {
      engineId: descriptor.engineId,
      engineName: descriptor.displayName,
      engineVersion: modelIdentity.modelVersion ?? descriptor.version,
      status,
      hypothesisProvenance,
      modelIdentity,
      eligibleForAccuracyLeaderboard,
      isMockTestOnly,
      config: isolatedConfig,
      startTimestampIso,
      endTimestampIso,
      processingTimeMs,
      rtf,
      rawOutputText,
      normalizedOutputText,
      words,
      meanConfidence,
      evaluation,
      costUsd,
      costLabel,
      errorMessage,
    };
  };

  // Run all selected engines concurrently with full fault isolation
  const settledResults = await Promise.all(
    selectedEngineIds.map((id) => runSingleEngine(id)),
  );

  return {
    experimentId,
    createdAtIso: new Date().toISOString(),
    audioSha256: audio.audioSha256,
    fileName: audio.fileName,
    fileVersion: audio.fileVersion,
    audioDurationSec: audio.durationSec,
    originalSampleRate: audio.originalSampleRate,
    originalChannels: audio.originalChannels,
    standardizedSampleRate: 16000,
    expectedLanguage: isolatedConfig.expectedLanguage,
    referenceTranscriptRaw: referenceTranscriptRaw.trim(),
    referenceTranscriptNormalized: normalizePersianEnglishForEval(referenceTranscriptRaw),
    evaluationAlgorithmVersion: LAB_EVALUATION_ALGORITHM_VERSION,
    engineResults: settledResults,
  };
}
