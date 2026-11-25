/**
 * SHAHAB-005, SHAHAB-006, SHAHAB-007 & SHAHAB-009 — Frozen Zipformer-Transducer Core,
 * Triple Acoustic Memory, Bounded Memory Governor, Adaptive Decoding & Runtime Capability Registry
 *
 * Implements:
 * - Exact Kaldi-compatible 80-dim Log-Mel FBANK extractor (matching sherpa-onnx / kaldi-native-fbank)
 * - SHAHABFrozenModelAdapter (implements Avapardaz LocalAsrRuntimeAdapter contract with ZERO weight mutation)
 * - Separated stages: extractFeatures() -> runEncoder() -> decodeGreedy() / decodeModifiedBeamSearch()
 * - Triple Memory Design:
 *     1. SHAHABAudioFeatureCache
 *     2. SHAHABEncoderOutputCache
 *     3. SHAHABStreamingStateCache (explicitly documents offline stateless7 graph non-streaming boundary)
 * - SHAHABMemoryGovernor (separate per-cache byte budgets, LRU eviction, memory pressure, cancellation cleanup)
 * - SHAHABAudioProfiler (objective RMS, silence, clipping, discontinuities, VAD, SNR estimate, speech-rate proxy)
 * - SHAHABDecodePolicyManager (SPEED | BALANCED | PRECISION | VOCABULARY | VERBATIM — genuinely differentiated!)
 * - SHAHABAdaptiveDecoder + SHAHABDecodeRiskEstimator + SHAHABComputeBudgetController + SHAHABRecurrentListeningController
 * - SHAHABRuntimeCapabilityRegistry
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
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
  LocalAsrRuntimeAdapter,
} from '../asr-core/UnifiedLocalAsrRuntime';
import { detectTextLanguageTag } from '../asr-core/CoreNormalizationAndLanguage';
import { PERSIAN_NORMALIZATION_CONTRACT_VERSION } from '../lifecycle/CanonicalModelProvenance';
import { conditionPcmTo16kMono } from './core/ShahabCoreAudioConditioner';
import {
  SHAHAB_CORE_CONTRACT_VERSION,
  type ShahabCoreInferenceBackend,
} from './core/ShahabCoreContract';
import {
  decodeBpeTokenIdsCanonical,
  resolveValidatedFrameStrideSec,
  runBatchedModifiedBeamSearch,
  runGreedyTransducerSearch,
} from './core/ShahabCoreDecoder';
import { normalizeCanonicalPersianUtterance } from './core/ShahabCorePersianNormalizer';
import {
  DEFAULT_SHAHAB_FBANK_CONFIG,
  SHAHAB_FEATURE_CONFIG_VERSION,
  extractKaldiFbank80,
  type ShahabExtractedFeatures,
  type ShahabKaldiFbankConfig,
} from './core/ShahabCoreFbank';
import { decodeWavToMono16k } from './core/ShahabCoreWavDecoder';
import { hashFileSha256BoundedSync, resolveDefaultShahabModelDir } from './ShahabModelStore';

export {
  SHAHAB_FEATURE_CONFIG_VERSION,
  DEFAULT_SHAHAB_FBANK_CONFIG,
  extractKaldiFbank80,
  decodeWavToMono16k,
  type ShahabKaldiFbankConfig,
  type ShahabExtractedFeatures,
};
export const SHAHAB_DECODER_INTERFACE_VERSION = 'STATELESS7_RNNT_CTX2_V1';

export function loadZipformerTokensTxt(tokensPath: string): readonly string[] {
  const raw = fs.readFileSync(tokensPath, 'utf-8');
  const tokens: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const lastSpace = line.lastIndexOf(' ');
    if (lastSpace <= 0) continue;
    const sym = line.slice(0, lastSpace);
    const id = Number.parseInt(line.slice(lastSpace + 1).trim(), 10);
    if (Number.isInteger(id) && id >= 0) {
      tokens[id] = sym;
    }
  }
  return tokens;
}

export function decodeBpeTokenIdsToText(tokenIds: readonly number[], vocab: readonly string[]): string {
  return decodeBpeTokenIdsCanonical(tokenIds, vocab);
}

/**
 * ============================================================================
 * SHAHAB-006 / SHAHAB-007 — TRIPLE MEMORY DESIGN & BOUNDED MEMORY GOVERNOR
 * ============================================================================
 */

export interface ShahabCacheIdentityKey {
  readonly tenantScope?: string;
  readonly audioSha256: string;
  readonly segmentId: string;
  readonly segmentStartSample: number;
  readonly segmentEndSample: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly encoderSha256: string;
  readonly decoderSha256: string;
  readonly joinerSha256: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly featureConfigVersion: string;
  readonly runtimeVersion: string;
  readonly decoderInterfaceVersion: string;
}

export function serializeCacheIdentity(key: ShahabCacheIdentityKey): string {
  return [
    key.tenantScope ?? 'default',
    key.audioSha256,
    key.segmentId,
    `${key.segmentStartSample}:${key.segmentEndSample}`,
    `${key.modelId}@${key.modelRevision}`,
    key.encoderSha256,
    key.decoderSha256,
    key.joinerSha256,
    `${key.sampleRateHz}Hz/${key.channels}ch`,
    key.featureConfigVersion,
    key.runtimeVersion,
    key.decoderInterfaceVersion,
  ].join('|');
}

export interface ShahabEncoderOutputTensor {
  readonly data: Float32Array; // [numFrames * dim]
  readonly numFrames: number;
  readonly dim: number; // 384 for Zipformer2
  readonly dtype: 'float32';
  readonly byteLength: number;
  readonly encoderTimeMs: number;
  readonly frameStrideSec?: number;
  readonly audioDurationSec?: number;
}

export interface ShahabStreamingStateEntry {
  readonly supportedByActiveModel: false;
  readonly reason: string;
  readonly chunkPositionFrames: number;
  readonly byteLength: number;
}

interface BoundedCacheBucket<T> {
  readonly keyString: string;
  readonly identity: ShahabCacheIdentityKey;
  readonly value: T;
  readonly byteLength: number;
  lastAccessedAtMs: number;
}

class BoundedTypedCache<T> {
  private readonly map = new Map<string, BoundedCacheBucket<T>>();
  private usedBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    public readonly cacheName: string,
    private maxBytes: number,
  ) {}

  public setBudgetBytes(maxBytes: number): void {
    this.maxBytes = Math.max(0, maxBytes);
    this.evictToBudget();
  }

  public get(identity: ShahabCacheIdentityKey): T | null {
    const keyString = serializeCacheIdentity(identity);
    const entry = this.map.get(keyString);
    if (!entry) {
      this.misses++;
      return null;
    }
    entry.lastAccessedAtMs = Date.now();
    this.hits++;
    return entry.value;
  }

  public set(identity: ShahabCacheIdentityKey, value: T, byteLength: number): boolean {
    if (byteLength > this.maxBytes) {
      return false; // Admission rejected: exceeds cache budget
    }
    const keyString = serializeCacheIdentity(identity);
    const prev = this.map.get(keyString);
    if (prev) {
      this.usedBytes -= prev.byteLength;
      this.map.delete(keyString);
    }
    this.map.set(keyString, {
      keyString,
      identity,
      value,
      byteLength,
      lastAccessedAtMs: Date.now(),
    });
    this.usedBytes += byteLength;
    this.evictToBudget();
    return true;
  }

  public invalidateByModelRevision(modelRevision: string): number {
    let removed = 0;
    for (const [k, v] of this.map.entries()) {
      if (v.identity.modelRevision === modelRevision) {
        this.usedBytes -= v.byteLength;
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  public invalidateByAudioSha256(audioSha256: string): number {
    let removed = 0;
    for (const [k, v] of this.map.entries()) {
      if (v.identity.audioSha256 === audioSha256) {
        this.usedBytes -= v.byteLength;
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  public clear(): void {
    this.map.clear();
    this.usedBytes = 0;
  }

  public getStats(): {
    readonly entries: number;
    readonly usedBytes: number;
    readonly maxBytes: number;
    readonly hits: number;
    readonly misses: number;
    readonly evictions: number;
    readonly hitRate: number;
  } {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }

  private evictToBudget(): void {
    while (this.usedBytes > this.maxBytes && this.map.size > 0) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of this.map.entries()) {
        if (v.lastAccessedAtMs < oldestTs) {
          oldestTs = v.lastAccessedAtMs;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      const victim = this.map.get(oldestKey)!;
      this.usedBytes -= victim.byteLength;
      this.map.delete(oldestKey);
      this.evictions++;
    }
  }
}

export class SHAHABAudioFeatureCache extends BoundedTypedCache<ShahabExtractedFeatures> {
  constructor(maxBytes = 16 * 1024 * 1024) {
    super('SHAHABAudioFeatureCache', maxBytes);
  }
}

export class SHAHABEncoderOutputCache extends BoundedTypedCache<ShahabEncoderOutputTensor> {
  constructor(maxBytes = 32 * 1024 * 1024) {
    super('SHAHABEncoderOutputCache', maxBytes);
  }
}

export class SHAHABStreamingStateCache extends BoundedTypedCache<ShahabStreamingStateEntry> {
  public readonly streamingSupportedByCurrentGraph = false;
  public readonly architecturalReason =
    'Acquired encoder.int8.onnx (ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f) is an offline stateless7 graph exposing only inputs (x, x_lens) without cached_key/cached_val/cached_conv streaming tensors.';

  constructor(maxBytes = 8 * 1024 * 1024) {
    super('SHAHABStreamingStateCache', maxBytes);
  }
}

export class SHAHABMemoryGovernor {
  public readonly featureCache: SHAHABAudioFeatureCache;
  public readonly encoderCache: SHAHABEncoderOutputCache;
  public readonly streamingCache: SHAHABStreamingStateCache;

  constructor(budgets?: {
    readonly featureCacheBytes?: number;
    readonly encoderCacheBytes?: number;
    readonly streamingCacheBytes?: number;
  }) {
    this.featureCache = new SHAHABAudioFeatureCache(budgets?.featureCacheBytes ?? 16 * 1024 * 1024);
    this.encoderCache = new SHAHABEncoderOutputCache(budgets?.encoderCacheBytes ?? 32 * 1024 * 1024);
    this.streamingCache = new SHAHABStreamingStateCache(budgets?.streamingCacheBytes ?? 8 * 1024 * 1024);
  }

  public handleMemoryPressure(level: 'ELEVATED' | 'CRITICAL'): void {
    if (level === 'ELEVATED') {
      this.featureCache.clear();
    } else {
      this.featureCache.clear();
      this.encoderCache.clear();
      this.streamingCache.clear();
    }
  }

  public invalidateModelRevision(modelRevision: string): void {
    this.featureCache.invalidateByModelRevision(modelRevision);
    this.encoderCache.invalidateByModelRevision(modelRevision);
    this.streamingCache.invalidateByModelRevision(modelRevision);
  }

  public clearAll(): void {
    this.featureCache.clear();
    this.encoderCache.clear();
    this.streamingCache.clear();
  }

  public getTelemetry(): {
    readonly featureCacheBytes: number;
    readonly encoderCacheBytes: number;
    readonly streamingCacheBytes: number;
    readonly totalCacheBytes: number;
    readonly encoderCacheHitRate: number;
    readonly totalEvictions: number;
    readonly processRssBytes: number;
  } {
    const f = this.featureCache.getStats();
    const e = this.encoderCache.getStats();
    const s = this.streamingCache.getStats();
    return {
      featureCacheBytes: f.usedBytes,
      encoderCacheBytes: e.usedBytes,
      streamingCacheBytes: s.usedBytes,
      totalCacheBytes: f.usedBytes + e.usedBytes + s.usedBytes,
      encoderCacheHitRate: e.hitRate,
      totalEvictions: f.evictions + e.evictions + s.evictions,
      processRssBytes: typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().rss : 0,
    };
  }
}

/**
 * ============================================================================
 * SHAHAB-007 — AUDIO PROFILER, DECODE POLICIES, RISK ESTIMATOR & BUDGET CONTROL
 * ============================================================================
 */

export type ShahabDecodePolicyId = 'SPEED' | 'BALANCED' | 'PRECISION' | 'VOCABULARY' | 'VERBATIM';

export interface ShahabDecodePolicyConfig {
  readonly policyId: ShahabDecodePolicyId;
  readonly decodingMethod: 'greedy_search' | 'modified_beam_search';
  readonly maxActivePaths: number;
  readonly blankPenalty: number;
  readonly allowContextualBias: boolean;
  readonly defaultContextBiasScore: number;
  readonly maxAdditionalPasses: number;
  readonly preserveRawVerbatim: boolean;
  readonly description: string;
}

export class SHAHABDecodePolicyManager {
  private readonly policies: Readonly<Record<ShahabDecodePolicyId, ShahabDecodePolicyConfig>> = Object.freeze({
    SPEED: {
      policyId: 'SPEED',
      decodingMethod: 'greedy_search',
      maxActivePaths: 1,
      blankPenalty: 0.0,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 0,
      preserveRawVerbatim: true,
      description: 'Single-path greedy transducer decoding for minimum latency.',
    },
    BALANCED: {
      policyId: 'BALANCED',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      blankPenalty: 0.0,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 1,
      preserveRawVerbatim: true,
      description: 'Upstream-aligned modified beam search (max_active_paths=4, blank_penalty=0).',
    },
    PRECISION: {
      policyId: 'PRECISION',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 8,
      blankPenalty: 0.05,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 1,
      preserveRawVerbatim: true,
      description: 'Wider modified beam search (8 active paths) with mild blank penalty for difficult acoustics.',
    },
    VOCABULARY: {
      policyId: 'VOCABULARY',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 6,
      blankPenalty: 0.0,
      allowContextualBias: true,
      defaultContextBiasScore: 0.6,
      maxAdditionalPasses: 1,
      preserveRawVerbatim: true,
      description: 'Modified beam search with verified BPE contextual biasing and false-insertion guard.',
    },
    VERBATIM: {
      policyId: 'VERBATIM',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      blankPenalty: -0.05,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 0,
      preserveRawVerbatim: true,
      description: 'Zero contextual override and conservative blank penalty preserving disfluencies and repetitions.',
    },
  });

  public getPolicy(id: ShahabDecodePolicyId): ShahabDecodePolicyConfig {
    return this.policies[id];
  }

  public listPolicies(): readonly ShahabDecodePolicyConfig[] {
    return Object.values(this.policies);
  }
}

export interface ShahabAudioProfileReport {
  readonly durationSec: number;
  readonly sampleRateHz: number;
  readonly rmsEnergy: number;
  readonly rmsDb: number;
  readonly silenceRatio: number;
  readonly clippedSampleCount: number;
  readonly clippingRatio: number;
  readonly discontinuityCount: number;
  readonly speechActivityRatio: number;
  readonly estimatedSnrDb: number | null;
  readonly snrAssumptionNote: string;
  readonly speechRateProxyTransitionsPerSec: number;
  readonly recommendedPolicy: ShahabDecodePolicyId;
  readonly recommendationReason: string;
}

export function profileAudioSignal(pcm16k: Float32Array, sampleRateHz = 16000): ShahabAudioProfileReport {
  const n = pcm16k.length;
  const durationSec = n / Math.max(1, sampleRateHz);
  if (n === 0) {
    return {
      durationSec: 0,
      sampleRateHz,
      rmsEnergy: 0,
      rmsDb: -120,
      silenceRatio: 1,
      clippedSampleCount: 0,
      clippingRatio: 0,
      discontinuityCount: 0,
      speechActivityRatio: 0,
      estimatedSnrDb: null,
      snrAssumptionNote: 'Empty buffer; SNR not computable.',
      speechRateProxyTransitionsPerSec: 0,
      recommendedPolicy: 'SPEED',
      recommendationReason: 'Empty audio segment.',
    };
  }

  let sumSq = 0;
  let clipped = 0;
  let discontinuities = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16k[i];
    sumSq += s * s;
    if (Math.abs(s) >= 0.995) clipped++;
    if (i > 0 && Math.abs(s - pcm16k[i - 1]) > 0.75) discontinuities++;
  }
  const rmsEnergy = Math.sqrt(sumSq / n);
  const rmsDb = rmsEnergy > 1e-9 ? 20 * Math.log10(rmsEnergy) : -120;

  // Frame-level RMS over 20ms frames for silence ratio & 10th-vs-90th percentile SNR proxy
  const frameSize = Math.max(1, Math.round(sampleRateHz * 0.02));
  const frameRms: number[] = [];
  let speechFrames = 0;
  let transitions = 0;
  let prevSpeech = false;
  for (let off = 0; off + frameSize <= n; off += frameSize) {
    let fs = 0;
    for (let k = 0; k < frameSize; k++) {
      const v = pcm16k[off + k];
      fs += v * v;
    }
    const r = Math.sqrt(fs / frameSize);
    frameRms.push(r);
    const isSpeech = r > 0.012;
    if (isSpeech) speechFrames++;
    if (isSpeech !== prevSpeech) transitions++;
    prevSpeech = isSpeech;
  }

  const totalFrames = Math.max(1, frameRms.length);
  const speechActivityRatio = Number((speechFrames / totalFrames).toFixed(4));
  const silenceRatio = Number((1 - speechActivityRatio).toFixed(4));

  let estimatedSnrDb: number | null = null;
  if (frameRms.length >= 10) {
    const sorted = [...frameRms].sort((a, b) => a - b);
    const p10 = Math.max(1e-7, sorted[Math.floor(sorted.length * 0.1)]);
    const p90 = Math.max(1e-7, sorted[Math.floor(sorted.length * 0.9)]);
    estimatedSnrDb = Number((20 * Math.log10(p90 / p10)).toFixed(2));
  }

  const clippingRatio = Number((clipped / n).toFixed(6));
  const speechRateProxy = Number((transitions / Math.max(0.1, durationSec)).toFixed(2));

  let recommendedPolicy: ShahabDecodePolicyId = 'BALANCED';
  let recommendationReason = 'Nominal studio audio SNR and speech activity; BALANCED modified beam search selected.';
  if (estimatedSnrDb !== null && estimatedSnrDb < 12) {
    recommendedPolicy = 'PRECISION';
    recommendationReason = `Degraded estimated SNR (${estimatedSnrDb} dB < 12 dB); recommending PRECISION wider beam.`;
  } else if (clippingRatio > 0.005 || discontinuities > 5) {
    recommendedPolicy = 'PRECISION';
    recommendationReason = `Observed clipping (${clipped} samples) or discontinuities (${discontinuities}); recommending PRECISION.`;
  } else if (speechActivityRatio < 0.08) {
    recommendedPolicy = 'SPEED';
    recommendationReason = `Predominantly silent audio (${(silenceRatio * 100).toFixed(1)}% silence); SPEED greedy pass sufficient.`;
  }

  return {
    durationSec: Number(durationSec.toFixed(4)),
    sampleRateHz,
    rmsEnergy: Number(rmsEnergy.toFixed(6)),
    rmsDb: Number(rmsDb.toFixed(2)),
    silenceRatio,
    clippedSampleCount: clipped,
    clippingRatio,
    discontinuityCount: discontinuities,
    speechActivityRatio,
    estimatedSnrDb,
    snrAssumptionNote:
      'Estimated via 90th-vs-10th percentile 20ms frame RMS ratio assuming stationary background noise floor (HEURISTIC_ESTIMATE, not calibrated SNR).',
    speechRateProxyTransitionsPerSec: speechRateProxy,
    recommendedPolicy,
    recommendationReason,
  };
}

export type ShahabSignalClass =
  | 'OBSERVED_SIGNAL'
  | 'MODEL_SCORE'
  | 'CALIBRATED_CONFIDENCE'
  | 'HEURISTIC_ESTIMATE'
  | 'UNKNOWN';

export interface ShahabRiskSignal {
  readonly name: string;
  readonly signalClass: ShahabSignalClass;
  readonly value: number | string | boolean | null;
  readonly note: string;
}

export type ShahabRecurrentAction =
  | 'ACCEPT_CURRENT_RESULT'
  | 'REDECODE_WITH_DIFFERENT_SEARCH'
  | 'REDECODE_WITH_EXTENDED_CONTEXT'
  | 'REPROCESS_BOUNDARY_REGION'
  | 'PRESERVE_ALTERNATIVES'
  | 'REQUEST_USER_REVIEW'
  | 'ABSTAIN_FROM_AUTOMATIC_CORRECTION';

export class SHAHABDecodeRiskEstimator {
  public assess(params: {
    readonly audioProfile: ShahabAudioProfileReport;
    readonly rawLogProbSum: number | null;
    readonly tokenCount: number;
    readonly greedyVsBeamDisagreed?: boolean;
  }): {
    readonly signals: readonly ShahabRiskSignal[];
    readonly uncertain: boolean;
    readonly confidenceCalibrationStatus: 'UNCALIBRATED_NO_VALIDATION_CURVE';
  } {
    const avgLogProb =
      params.rawLogProbSum !== null && params.tokenCount > 0
        ? Number((params.rawLogProbSum / params.tokenCount).toFixed(4))
        : null;

    const signals: ShahabRiskSignal[] = [
      {
        name: 'audio_clipping_ratio',
        signalClass: 'OBSERVED_SIGNAL',
        value: params.audioProfile.clippingRatio,
        note: 'Directly observed fraction of clipped PCM samples.',
      },
      {
        name: 'estimated_snr_db',
        signalClass: 'HEURISTIC_ESTIMATE',
        value: params.audioProfile.estimatedSnrDb,
        note: params.audioProfile.snrAssumptionNote,
      },
      {
        name: 'mean_token_log_prob',
        signalClass: 'MODEL_SCORE',
        value: avgLogProb,
        note: 'Raw RNN-T joiner log-probability mean; NOT a calibrated probability.',
      },
      {
        name: 'calibrated_word_confidence',
        signalClass: 'UNKNOWN',
        value: null,
        note: 'No independent Persian validation calibration curve available yet.',
      },
    ];

    const uncertain =
      (params.audioProfile.estimatedSnrDb !== null && params.audioProfile.estimatedSnrDb < 12) ||
      params.audioProfile.clippingRatio > 0.005 ||
      Boolean(params.greedyVsBeamDisagreed) ||
      (avgLogProb !== null && avgLogProb < -2.2);

    return {
      signals,
      uncertain,
      confidenceCalibrationStatus: 'UNCALIBRATED_NO_VALIDATION_CURVE',
    };
  }
}

export interface ShahabComputeBudgetConfig {
  readonly maxAdditionalPasses: number;
  readonly maxReprocessedAudioSec: number;
  readonly maxAddedLatencyMs: number;
  readonly maxCacheMemoryBytes: number;
}

export class SHAHABComputeBudgetController {
  private passesUsed = 0;
  private reprocessedAudioSec = 0;
  private addedLatencyMs = 0;

  constructor(public readonly limits: ShahabComputeBudgetConfig) {}

  public canSpendAdditionalPass(segmentDurationSec: number, currentCacheBytes: number): {
    readonly allowed: boolean;
    readonly reason: string;
  } {
    if (this.passesUsed >= this.limits.maxAdditionalPasses) {
      return { allowed: false, reason: `Max additional passes (${this.limits.maxAdditionalPasses}) reached.` };
    }
    if (this.reprocessedAudioSec + segmentDurationSec > this.limits.maxReprocessedAudioSec) {
      return {
        allowed: false,
        reason: `Reprocessed audio budget (${this.limits.maxReprocessedAudioSec}s) would be exceeded.`,
      };
    }
    if (this.addedLatencyMs >= this.limits.maxAddedLatencyMs) {
      return { allowed: false, reason: `Added latency budget (${this.limits.maxAddedLatencyMs}ms) exhausted.` };
    }
    if (currentCacheBytes > this.limits.maxCacheMemoryBytes) {
      return { allowed: false, reason: `Cache memory exceeds budget (${this.limits.maxCacheMemoryBytes} B).` };
    }
    return { allowed: true, reason: 'Within compute budget.' };
  }

  public recordAdditionalPass(segmentDurationSec: number, latencyMs: number): void {
    this.passesUsed++;
    this.reprocessedAudioSec += segmentDurationSec;
    this.addedLatencyMs += latencyMs;
  }

  public getUsage(): {
    readonly passesUsed: number;
    readonly reprocessedAudioSec: number;
    readonly addedLatencyMs: number;
  } {
    return {
      passesUsed: this.passesUsed,
      reprocessedAudioSec: Number(this.reprocessedAudioSec.toFixed(3)),
      addedLatencyMs: Math.round(this.addedLatencyMs),
    };
  }
}

export interface ShahabRecurrentDecisionRecord {
  readonly action: ShahabRecurrentAction;
  readonly reason: string;
  readonly changedVariable: string | null;
  readonly previousConfigKey: string;
  readonly nextConfigKey: string | null;
}

export class SHAHABRecurrentListeningController {
  private readonly executedConfigsBySegment = new Map<string, Set<string>>();

  public decide(params: {
    readonly segmentId: string;
    readonly segmentDurationSec: number;
    readonly currentPolicy: ShahabDecodePolicyConfig;
    readonly candidateNextPolicy: ShahabDecodePolicyConfig | null;
    readonly uncertain: boolean;
    readonly budget: SHAHABComputeBudgetController;
    readonly currentCacheBytes: number;
  }): ShahabRecurrentDecisionRecord {
    const prevKey = `${params.currentPolicy.decodingMethod}|p=${params.currentPolicy.maxActivePaths}|bp=${params.currentPolicy.blankPenalty}|cb=${params.currentPolicy.allowContextualBias}`;
    const seen = this.executedConfigsBySegment.get(params.segmentId) ?? new Set<string>();
    seen.add(prevKey);
    this.executedConfigsBySegment.set(params.segmentId, seen);

    if (!params.uncertain) {
      return {
        action: 'ACCEPT_CURRENT_RESULT',
        reason: 'Objective audio profile and decoder score show no uncertainty triggers.',
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    if (!params.candidateNextPolicy) {
      return {
        action: 'REQUEST_USER_REVIEW',
        reason: 'Segment flagged uncertain with no alternative decoder policy configured.',
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    const nextKey = `${params.candidateNextPolicy.decodingMethod}|p=${params.candidateNextPolicy.maxActivePaths}|bp=${params.candidateNextPolicy.blankPenalty}|cb=${params.candidateNextPolicy.allowContextualBias}`;
    if (seen.has(nextKey)) {
      // SHAHAB-007 §5 / §8 Guardrail: NEVER repeat identical deterministic config!
      return {
        action: 'PRESERVE_ALTERNATIVES',
        reason: 'Blocked duplicate re-decode: candidate configuration is identical to an already executed pass.',
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    const budgetCheck = params.budget.canSpendAdditionalPass(
      params.segmentDurationSec,
      params.currentCacheBytes,
    );
    if (!budgetCheck.allowed) {
      return {
        action: 'REQUEST_USER_REVIEW',
        reason: `Compute budget guardrail engaged: ${budgetCheck.reason}`,
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    return {
      action: 'REDECODE_WITH_DIFFERENT_SEARCH',
      reason: `Uncertainty detected; escalating from ${params.currentPolicy.policyId} to ${params.candidateNextPolicy.policyId} over cached encoder output.`,
      changedVariable: `decodingMethod/maxActivePaths (${params.currentPolicy.decodingMethod}:${params.currentPolicy.maxActivePaths} -> ${params.candidateNextPolicy.decodingMethod}:${params.candidateNextPolicy.maxActivePaths})`,
      previousConfigKey: prevKey,
      nextConfigKey: nextKey,
    };
  }
}

/**
 * ============================================================================
 * SHAHAB-005 — FROZEN ZIPFORMER-TRANSDUCER MODEL ADAPTER (REAL ONNX EXECUTION)
 * ============================================================================
 */

export interface ShahabHotwordBiasMap {
  /** Maps BPE token ID -> additive log-probability bias score (strictly bounded) */
  readonly tokenBiases: ReadonlyMap<number, number>;
  readonly activeTerms: readonly string[];
}

export interface ShahabDecodedHypothesis {
  readonly rawText: string;
  readonly tokenIds: readonly number[];
  readonly tokenTimestampsSec: readonly number[];
  readonly logProbSum: number;
  readonly decoderJoinerInvocations: number;
  readonly decodeTimeMs: number;
  readonly policyId: ShahabDecodePolicyId;
  readonly decodingMethod: 'greedy_search' | 'modified_beam_search';
  readonly maxActivePaths: number;
  readonly blankPenalty: number;
  readonly contextTermsApplied: readonly string[];
}

export interface ShahabFrozenAdapterOptions {
  readonly modelDir: string;
  readonly modelId?: string;
  readonly modelRevision?: string;
  readonly expectedHashes?: {
    readonly encoder: string;
    readonly decoder: string;
    readonly joiner: string;
    readonly tokens: string;
  };
  readonly memoryGovernor?: SHAHABMemoryGovernor;
}

export class SHAHABFrozenModelAdapter implements LocalAsrRuntimeAdapter {
  public readonly runtimeTarget = 'BROWSER_WASM_CPU' as const;
  public readonly runtimeName = 'SHAHAB Frozen Zipformer-Transducer Engine (onnxruntime-web WASM)';
  public readonly trainableParameters = 0 as const;

  private readonly modelDir: string;
  private readonly modelId: string;
  private readonly modelRevision: string;
  private readonly expectedHashes: {
    readonly encoder: string;
    readonly decoder: string;
    readonly joiner: string;
    readonly tokens: string;
  };

  public readonly memoryGovernor: SHAHABMemoryGovernor;
  public readonly policyManager = new SHAHABDecodePolicyManager();

  private encoderSession: ort.InferenceSession | null = null;
  private decoderSession: ort.InferenceSession | null = null;
  private joinerSession: ort.InferenceSession | null = null;
  private initPromise: Promise<void> | null = null;
  private vocab: readonly string[] = [];
  private verifiedHashes: { encoder: string; decoder: string; joiner: string; tokens: string } | null = null;
  private loadTimeMs: number | null = null;
  private inferenceVerified = false;
  private activeJobId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private encoderInvocationCount = 0;
  private decoderInvocationCount = 0;
  private integrityProbeCache: {
    readonly signature: string;
    readonly available: boolean;
    readonly missingFiles: readonly string[];
    readonly mismatches: readonly string[];
  } | null = null;

  constructor(options: ShahabFrozenAdapterOptions) {
    this.modelDir = path.resolve(options.modelDir);
    this.modelId = options.modelId ?? 'persian-zipformer-transducer';
    this.modelRevision = options.modelRevision ?? '0408facbcf3f670121def48e0802c395c225d150';
    this.expectedHashes = options.expectedHashes ?? {
      encoder: '08735923618e196bd093b369f6843c8a390a6113a391e7b7095115582fd2cd27',
      decoder: '9d4ad2da0335d86d8638ff026e6b37247d97df940af6ad40bba671af5fd4aa9d',
      joiner: 'a2a4a30585dc53e46afafd03690181107a610f67ff0e29cab460ec16df5cc00b',
      tokens: '435f9e09a290c764670044e54c2450670fc2eab50176cd912734fa6f92ab166f',
    };
    this.memoryGovernor = options.memoryGovernor ?? new SHAHABMemoryGovernor();
  }

  public getVocab(): readonly string[] {
    return this.vocab;
  }

  public getExecutionCounters(): {
    readonly encoderInvocations: number;
    readonly decoderInvocations: number;
    readonly loadTimeMs: number | null;
    readonly verifiedHashes: { encoder: string; decoder: string; joiner: string; tokens: string } | null;
  } {
    return {
      encoderInvocations: this.encoderInvocationCount,
      decoderInvocations: this.decoderInvocationCount,
      loadTimeMs: this.loadTimeMs,
      verifiedHashes: this.verifiedHashes,
    };
  }

  public resetExecutionCounters(): void {
    this.encoderInvocationCount = 0;
    this.decoderInvocationCount = 0;
  }

  public verifyWeightImmutability(): {
    readonly immutable: boolean;
    readonly hashes: { encoder: string; decoder: string; joiner: string; tokens: string };
    readonly mismatches: readonly string[];
  } {
    const actual = {
      encoder: hashFileSha256BoundedSync(path.join(this.modelDir, 'encoder.int8.onnx')),
      decoder: hashFileSha256BoundedSync(path.join(this.modelDir, 'decoder.int8.onnx')),
      joiner: hashFileSha256BoundedSync(path.join(this.modelDir, 'joiner.int8.onnx')),
      tokens: hashFileSha256BoundedSync(path.join(this.modelDir, 'tokens.txt')),
    };
    const mismatches: string[] = [];
    if (actual.encoder !== this.expectedHashes.encoder) mismatches.push('encoder.int8.onnx SHA-256 mismatch');
    if (actual.decoder !== this.expectedHashes.decoder) mismatches.push('decoder.int8.onnx SHA-256 mismatch');
    if (actual.joiner !== this.expectedHashes.joiner) mismatches.push('joiner.int8.onnx SHA-256 mismatch');
    if (actual.tokens !== this.expectedHashes.tokens) mismatches.push('tokens.txt SHA-256 mismatch');
    return { immutable: mismatches.length === 0, hashes: actual, mismatches };
  }

  /**
   * Checks presence and SHA-256 integrity of required model files, cached by file size+mtime signature
   * so repeated capability/readiness probes remain fast while immediately catching missing or tampered weights.
   */
  public inspectModelIntegrityCached(): {
    readonly available: boolean;
    readonly missingFiles: readonly string[];
    readonly mismatches: readonly string[];
    readonly signature: string;
  } {
    const required = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'] as const;
    const missingFiles: string[] = [];
    const sigParts: string[] = [];
    for (const name of required) {
      const fullPath = path.join(this.modelDir, name);
      try {
        const st = fs.statSync(fullPath);
        if (!st.isFile() || st.size <= 0) {
          missingFiles.push(name);
          sigParts.push(`${name}:empty`);
        } else {
          sigParts.push(`${name}:${st.size}:${Math.trunc(st.mtimeMs)}`);
        }
      } catch {
        missingFiles.push(name);
        sigParts.push(`${name}:missing`);
      }
    }
    const signature = sigParts.join('|');
    if (this.integrityProbeCache && this.integrityProbeCache.signature === signature) {
      return { ...this.integrityProbeCache, signature };
    }
    if (missingFiles.length > 0) {
      const result = { signature, available: false, missingFiles, mismatches: [] as string[] };
      this.integrityProbeCache = result;
      return result;
    }
    try {
      const immut = this.verifyWeightImmutability();
      const result = {
        signature,
        available: immut.immutable,
        missingFiles: [] as string[],
        mismatches: immut.mismatches,
      };
      this.integrityProbeCache = result;
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const result = {
        signature,
        available: false,
        missingFiles: [] as string[],
        mismatches: [msg],
      };
      this.integrityProbeCache = result;
      return result;
    }
  }

  public async probeCapabilities(): Promise<AsrRuntimeCapabilityReport> {
    const probe = this.inspectModelIntegrityCached();
    const notes: string[] = [
      'Executes Zipformer2-Transducer (pruned_transducer_stateless7) via 3 separate ONNX sessions (encoder + decoder + joiner) inside Node.js using onnxruntime-web WASM CPU.',
      'Offline graph only (no cached_key/cached_conv streaming inputs); encoder_out reuse supported across decoder passes.',
    ];
    if (!probe.available) {
      if (probe.missingFiles.length > 0) {
        notes.push(`Model assets missing on disk: ${probe.missingFiles.join(', ')}.`);
      }
      if (probe.mismatches.length > 0) {
        notes.push(`Model integrity verification failed: ${probe.mismatches.join('; ')}.`);
      }
    }
    return {
      runtimeTarget: this.runtimeTarget,
      runtimeName: this.runtimeName,
      runtimeVersion: 'onnxruntime-web@1.31.1',
      available: probe.available,
      offlineCapable: true,
      wasmAvailable: true,
      simdAvailable: true,
      sharedArrayBufferAvailable: typeof SharedArrayBuffer !== 'undefined',
      opfsAvailable: false,
      webGpuAvailable: false,
      maxThreads: 1,
      memoryBudgetBytes: 1024 * 1024 * 1024,
      maxSupportedOnnxOpset: 21,
      supportedArchitectures: ['ZIPFORMER_TRANSDUCER'],
      notes,
    };
  }

  public async initializeRuntime(): Promise<void> {
    if (this.encoderSession && this.decoderSession && this.joinerSession) return;
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const immut = this.verifyWeightImmutability();
      if (!immut.immutable) {
        throw new AsrRuntimeError({
          code: 'MODEL_INTEGRITY_FAILURE',
          message: `Weight immutability check failed: ${immut.mismatches.join('; ')}`,
          runtimeTarget: this.runtimeTarget,
        });
      }
      this.verifiedHashes = immut.hashes;
      this.vocab = loadZipformerTokensTxt(path.join(this.modelDir, 'tokens.txt'));

      const t0 = performance.now();
      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
        enableMemPattern: true,
      };

      let dec: ort.InferenceSession | null = null;
      let join: ort.InferenceSession | null = null;
      let enc: ort.InferenceSession | null = null;
      try {
        // Sequential ONNX file read + session creation avoids holding all 3 raw buffers
        // (~115.7 MB) simultaneously in Node heap during cold load.
        let decBytes: Buffer | null = fs.readFileSync(path.join(this.modelDir, 'decoder.int8.onnx'));
        dec = await ort.InferenceSession.create(decBytes, sessionOptions);
        decBytes = null;

        let joinBytes: Buffer | null = fs.readFileSync(path.join(this.modelDir, 'joiner.int8.onnx'));
        join = await ort.InferenceSession.create(joinBytes, sessionOptions);
        joinBytes = null;

        let encBytes: Buffer | null = fs.readFileSync(path.join(this.modelDir, 'encoder.int8.onnx'));
        enc = await ort.InferenceSession.create(encBytes, sessionOptions);
        encBytes = null;

        this.decoderSession = dec;
        this.joinerSession = join;
        this.encoderSession = enc;
        this.loadTimeMs = Math.round(performance.now() - t0);
      } catch (err) {
        await enc?.release().catch(() => {});
        await join?.release().catch(() => {});
        await dec?.release().catch(() => {});
        this.encoderSession = null;
        this.joinerSession = null;
        this.decoderSession = null;
        throw err;
      }
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  public async validateModel(descriptor: AsrModelLoadDescriptor): Promise<AsrModelValidationReport> {
    const immut = this.verifyWeightImmutability();
    return {
      valid: immut.immutable,
      modelId: descriptor.modelId,
      modelVersion: descriptor.modelVersion,
      integrityVerified: immut.immutable,
      compatibility: null,
      errors: immut.mismatches,
    };
  }

  public async loadModel(): Promise<void> {
    await this.initializeRuntime();
  }

  public buildCacheIdentity(params: {
    readonly pcm16k: Float32Array;
    readonly segmentId: string;
    readonly tenantScope?: string;
    readonly segmentStartSample?: number;
    readonly segmentEndSample?: number;
  }): ShahabCacheIdentityKey {
    const audioSha256 = crypto
      .createHash('sha256')
      .update(Buffer.from(params.pcm16k.buffer, params.pcm16k.byteOffset, params.pcm16k.byteLength))
      .digest('hex');
    const hashes = this.verifiedHashes ?? this.expectedHashes;
    return {
      tenantScope: params.tenantScope ?? 'default',
      audioSha256,
      segmentId: params.segmentId,
      segmentStartSample: params.segmentStartSample ?? 0,
      segmentEndSample: params.segmentEndSample ?? params.pcm16k.length,
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      encoderSha256: hashes.encoder,
      decoderSha256: hashes.decoder,
      joinerSha256: hashes.joiner,
      sampleRateHz: 16000,
      channels: 1,
      featureConfigVersion: SHAHAB_FEATURE_CONFIG_VERSION,
      runtimeVersion: 'onnxruntime-web@1.31.1',
      decoderInterfaceVersion: SHAHAB_DECODER_INTERFACE_VERSION,
    };
  }

  /**
   * Stage 1: Acoustic Encoder execution (with optional Triple Cache lookup).
   */
  public async encodeAudio(params: {
    readonly pcm16k: Float32Array;
    readonly segmentId: string;
    readonly tenantScope?: string;
    readonly useCache?: boolean;
    readonly signal?: AbortSignal;
    readonly optimizationMode?: 'BASELINE' | 'OPTIMIZED';
    readonly fbankConfig?: ShahabKaldiFbankConfig;
  }): Promise<{
    readonly encoderOutput: ShahabEncoderOutputTensor;
    readonly cacheHit: boolean;
    readonly cacheIdentity: ShahabCacheIdentityKey;
    readonly featureExtractionMs: number;
  }> {
    if (params.signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Encoding cancelled before start.',
        runtimeTarget: this.runtimeTarget,
      });
    }
    await this.initializeRuntime();
    const cacheIdentity = this.buildCacheIdentity({
      pcm16k: params.pcm16k,
      segmentId: params.segmentId,
      tenantScope: params.tenantScope,
    });

    if (params.useCache) {
      const cached = this.memoryGovernor.encoderCache.get(cacheIdentity);
      if (cached) {
        return { encoderOutput: cached, cacheHit: true, cacheIdentity, featureExtractionMs: 0 };
      }
    }

    let featureExtractionMs = 0;
    let features = params.useCache ? this.memoryGovernor.featureCache.get(cacheIdentity) : null;
    if (!features) {
      const tFeat0 = performance.now();
      features = extractKaldiFbank80(
        params.pcm16k,
        params.fbankConfig ?? DEFAULT_SHAHAB_FBANK_CONFIG,
        params.optimizationMode ?? 'OPTIMIZED',
      );
      featureExtractionMs = Number((performance.now() - tFeat0).toFixed(3));
      if (params.useCache) {
        this.memoryGovernor.featureCache.set(cacheIdentity, features, features.data.byteLength);
      }
    }

    if (params.signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Encoding cancelled after feature extraction.',
        runtimeTarget: this.runtimeTarget,
      });
    }

    const tEnc0 = performance.now();
    const xTensor = new ort.Tensor('float32', features.data, [1, features.numFrames, 80]);
    const xLensTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(features.numFrames)]), [1]);
    let copy: Float32Array;
    let validFrames: number;
    let dim: number;
    let encMs: number;
    try {
      const out = await this.encoderSession!.run({ x: xTensor, x_lens: xLensTensor });
      encMs = Math.round(performance.now() - tEnc0);
      this.encoderInvocationCount++;
      try {
        const encRaw = out.encoder_out.data as Float32Array;
        const encLens = out.encoder_out_lens.data as BigInt64Array;
        validFrames = Number(encLens[0]);
        dim = Number(out.encoder_out.dims[2] ?? 384);
        const trimmed = encRaw.subarray(0, validFrames * dim);
        copy = new Float32Array(trimmed.length);
        copy.set(trimmed);
      } finally {
        out.encoder_out.dispose?.();
        out.encoder_out_lens.dispose?.();
      }
    } finally {
      xTensor.dispose?.();
      xLensTensor.dispose?.();
    }

    const encoderOutput: ShahabEncoderOutputTensor = {
      data: copy,
      numFrames: validFrames,
      dim,
      dtype: 'float32',
      byteLength: copy.byteLength,
      encoderTimeMs: encMs,
      frameStrideSec: 0.04,
      audioDurationSec: params.pcm16k.length / 16000,
    };

    if (params.useCache) {
      this.memoryGovernor.encoderCache.set(cacheIdentity, encoderOutput, encoderOutput.byteLength);
    }

    return { encoderOutput, cacheHit: false, cacheIdentity, featureExtractionMs };
  }

  /**
   * Stage 2: Stateless7 RNN-T Decoding from an existing Encoder output tensor
   * (supports greedy_search and modified_beam_search with optional BPE hotword logit biasing).
   */
  public async decodeFromEncoderOutput(params: {
    readonly encoderOutput: ShahabEncoderOutputTensor;
    readonly policy: ShahabDecodePolicyConfig;
    readonly hotwordBias?: ShahabHotwordBiasMap | null;
    readonly signal?: AbortSignal;
    readonly optimizationMode?: 'BASELINE' | 'OPTIMIZED';
  }): Promise<ShahabDecodedHypothesis> {
    await this.initializeRuntime();
    const t0 = performance.now();
    const { data, numFrames, dim } = params.encoderOutput;
    const frameStrideSec = resolveValidatedFrameStrideSec({
      nominalFrameStrideSec: params.encoderOutput.frameStrideSec ?? 0.04,
      numFrames,
      audioDurationSec: params.encoderOutput.audioDurationSec,
    });
    const decCache = new Map<string, Float32Array>();
    let decJoinCalls = 0;

    const runDecoder = async (t0Id: number, t1Id: number): Promise<Float32Array> => {
      const key = `${t0Id},${t1Id}`;
      const hit = decCache.get(key);
      if (hit) return hit;
      const y = new ort.Tensor('int64', BigInt64Array.from([BigInt(t0Id), BigInt(t1Id)]), [1, 2]);
      try {
        const res = await this.decoderSession!.run({ y });
        this.decoderInvocationCount++;
        decJoinCalls++;
        try {
          const out = new Float32Array(res.decoder_out.data as Float32Array);
          decCache.set(key, out);
          return out;
        } finally {
          res.decoder_out?.dispose?.();
        }
      } finally {
        y.dispose?.();
      }
    };

    const runJoiner = async (frameIdx: number, decVec: Float32Array): Promise<Float32Array> => {
      const encSlice = data.subarray(frameIdx * dim, (frameIdx + 1) * dim);
      const encoderTensor = new ort.Tensor('float32', encSlice, [1, dim]);
      const decoderTensor = new ort.Tensor('float32', decVec, [1, dim]);
      try {
        const res = await this.joinerSession!.run({
          encoder_out: encoderTensor,
          decoder_out: decoderTensor,
        });
        decJoinCalls++;
        try {
          return new Float32Array(res.logit.data as Float32Array);
        } finally {
          res.logit?.dispose?.();
        }
      } finally {
        encoderTensor.dispose?.();
        decoderTensor.dispose?.();
      }
    };

    let decoderBatchSupported = true;
    let joinerBatchSupported = true;

    const isBatchShapeError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return /shape|dimension|dim|batch|expected.*1/i.test(msg);
    };

    const runDecoderBatch = async (
      contexts: readonly (readonly [number, number])[],
    ): Promise<readonly Float32Array[]> => {
      const batchSize = contexts.length;
      if (batchSize === 0) return [];
      if (batchSize === 1 || !decoderBatchSupported) {
        const out: Float32Array[] = new Array(batchSize);
        for (let i = 0; i < batchSize; i++) {
          out[i] = await runDecoder(contexts[i][0], contexts[i][1]);
        }
        return out;
      }
      const flat = new BigInt64Array(batchSize * 2);
      for (let i = 0; i < batchSize; i++) {
        flat[i * 2] = BigInt(contexts[i][0]);
        flat[i * 2 + 1] = BigInt(contexts[i][1]);
      }
      const y = new ort.Tensor('int64', flat, [batchSize, 2]);
      let fallbackNeeded = false;
      try {
        const res = await this.decoderSession!.run({ y });
        this.decoderInvocationCount++;
        decJoinCalls++;
        try {
          const raw = res.decoder_out.data as Float32Array;
          const outDims = res.decoder_out.dims;
          const batchDimMatches =
            Array.isArray(outDims) && outDims.length >= 2 && Number(outDims[0]) === batchSize;
          if (!batchDimMatches || raw.length < batchSize * dim || raw.length % batchSize !== 0) {
            decoderBatchSupported = false;
            fallbackNeeded = true;
          } else {
            const outDim = raw.length / batchSize;
            const results: Float32Array[] = new Array(batchSize);
            for (let i = 0; i < batchSize; i++) {
              const vec = new Float32Array(outDim);
              vec.set(raw.subarray(i * outDim, (i + 1) * outDim));
              results[i] = vec;
            }
            return results;
          }
        } finally {
          res.decoder_out?.dispose?.();
        }
      } catch (err) {
        if (isBatchShapeError(err)) {
          decoderBatchSupported = false;
          fallbackNeeded = true;
        } else {
          throw err;
        }
      } finally {
        y.dispose?.();
      }
      if (fallbackNeeded) {
        const out: Float32Array[] = new Array(batchSize);
        for (let i = 0; i < batchSize; i++) {
          out[i] = await runDecoder(contexts[i][0], contexts[i][1]);
        }
        return out;
      }
      return [];
    };

    let encBatchScratch = new Float32Array(0);
    let decBatchScratch = new Float32Array(0);

    const runJoinerBatch = async (
      frameIdx: number,
      decoderVectors: readonly Float32Array[],
    ): Promise<readonly Float32Array[]> => {
      const batchSize = decoderVectors.length;
      if (batchSize === 0) return [];
      if (batchSize === 1 || !joinerBatchSupported) {
        const out: Float32Array[] = new Array(batchSize);
        for (let i = 0; i < batchSize; i++) {
          out[i] = await runJoiner(frameIdx, decoderVectors[i]);
        }
        return out;
      }
      const encSlice = data.subarray(frameIdx * dim, (frameIdx + 1) * dim);
      const needed = batchSize * dim;
      if (encBatchScratch.length < needed) {
        encBatchScratch = new Float32Array(needed);
        decBatchScratch = new Float32Array(needed);
      }
      const encBatch = encBatchScratch.subarray(0, needed);
      const decBatch = decBatchScratch.subarray(0, needed);
      for (let i = 0; i < batchSize; i++) {
        encBatch.set(encSlice, i * dim);
        decBatch.set(decoderVectors[i], i * dim);
      }
      const encoderTensor = new ort.Tensor('float32', encBatch, [batchSize, dim]);
      const decoderTensor = new ort.Tensor('float32', decBatch, [batchSize, dim]);
      let fallbackNeeded = false;
      try {
        const res = await this.joinerSession!.run({
          encoder_out: encoderTensor,
          decoder_out: decoderTensor,
        });
        decJoinCalls++;
        try {
          const raw = res.logit.data as Float32Array;
          const outDims = res.logit.dims;
          const batchDimMatches =
            Array.isArray(outDims) && outDims.length >= 2 && Number(outDims[0]) === batchSize;
          const vocabMin = this.vocab.length > 0 ? this.vocab.length : 2;
          if (!batchDimMatches || raw.length < batchSize * vocabMin || raw.length % batchSize !== 0) {
            joinerBatchSupported = false;
            fallbackNeeded = true;
          } else {
            const vocabSize = raw.length / batchSize;
            const results: Float32Array[] = new Array(batchSize);
            for (let i = 0; i < batchSize; i++) {
              const row = new Float32Array(vocabSize);
              row.set(raw.subarray(i * vocabSize, (i + 1) * vocabSize));
              results[i] = row;
            }
            return results;
          }
        } finally {
          res.logit?.dispose?.();
        }
      } catch (err) {
        if (isBatchShapeError(err)) {
          joinerBatchSupported = false;
          fallbackNeeded = true;
        } else {
          throw err;
        }
      } finally {
        encoderTensor.dispose?.();
        decoderTensor.dispose?.();
      }
      if (fallbackNeeded) {
        const out: Float32Array[] = new Array(batchSize);
        for (let i = 0; i < batchSize; i++) {
          out[i] = await runJoiner(frameIdx, decoderVectors[i]);
        }
        return out;
      }
      return [];
    };

    const logSoftmax = (logits: Float32Array): Float32Array => {
      let max = -Infinity;
      for (let i = 0; i < logits.length; i++) {
        if (logits[i] > max) max = logits[i];
      }
      let sumExp = 0;
      for (let i = 0; i < logits.length; i++) {
        sumExp += Math.exp(logits[i] - max);
      }
      const logZ = max + Math.log(sumExp);
      const out = new Float32Array(logits.length);
      for (let i = 0; i < logits.length; i++) {
        out[i] = logits[i] - logZ;
      }
      return out;
    };

    const biasMap =
      params.policy.allowContextualBias && params.hotwordBias
        ? params.hotwordBias.tokenBiases
        : null;
    const activeTerms =
      params.policy.allowContextualBias && params.hotwordBias
        ? params.hotwordBias.activeTerms
        : [];
    const blankPenalty = params.policy.blankPenalty;

    if (params.policy.decodingMethod === 'greedy_search') {
      const greedy = await runGreedyTransducerSearch({
        numFrames,
        vocab: this.vocab,
        blankPenalty,
        frameStrideSec,
        signal: params.signal,
        onCancelled: () =>
          new AsrRuntimeError({
            code: 'JOB_CANCELLED',
            message: 'Greedy decoding cancelled.',
            runtimeTarget: this.runtimeTarget,
          }),
        callbacks: {
          runDecoderBatch,
          runJoinerBatch,
        },
      });

      this.inferenceVerified = true;
      return {
        rawText: greedy.rawText,
        tokenIds: greedy.tokenIds,
        tokenTimestampsSec: greedy.tokenTimestampsSec,
        logProbSum: greedy.logProbSum,
        decoderJoinerInvocations: greedy.totalDecoderJoinerInvocations,
        decodeTimeMs: Math.round(performance.now() - t0),
        policyId: params.policy.policyId,
        decodingMethod: 'greedy_search',
        maxActivePaths: 1,
        blankPenalty,
        contextTermsApplied: [],
      };
    }

    const useDecoderOpt = (params.optimizationMode ?? 'OPTIMIZED') === 'OPTIMIZED';
    const beamSize = Math.max(2, Math.min(12, params.policy.maxActivePaths));

    if (useDecoderOpt) {
      // SHB-F05: Batched [K, dim] joiner + batched [M, 2] decoder + Parent-Pointer Prefix Trie + scratchpad reuse
      const batched = await runBatchedModifiedBeamSearch({
        numFrames,
        vocab: this.vocab,
        beamSize,
        blankPenalty,
        frameStrideSec,
        biasMap,
        signal: params.signal,
        onCancelled: () =>
          new AsrRuntimeError({
            code: 'JOB_CANCELLED',
            message: 'Modified beam search cancelled.',
            runtimeTarget: this.runtimeTarget,
          }),
        callbacks: {
          runDecoderBatch,
          runJoinerBatch,
        },
      });

      this.inferenceVerified = true;
      return {
        rawText: batched.rawText,
        tokenIds: batched.tokenIds,
        tokenTimestampsSec: batched.tokenTimestampsSec,
        logProbSum: batched.logProbSum,
        decoderJoinerInvocations: batched.totalDecoderJoinerInvocations,
        decodeTimeMs: Math.round(performance.now() - t0),
        policyId: params.policy.policyId,
        decodingMethod: 'modified_beam_search',
        maxActivePaths: beamSize,
        blankPenalty,
        contextTermsApplied: activeTerms,
      };
    }

    // Baseline unoptimized reference loop (retained strictly for BASELINE vs OPTIMIZED A/B benchmarks)
    interface BeamHyp {
      tokens: number[];
      timestamps: number[];
      score: number;
    }
    let beams: BeamHyp[] = [{ tokens: [0, 0], timestamps: [], score: 0 }];

    const logAddExp = (a: number, b: number) =>
      a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));

    for (let t = 0; t < numFrames; t++) {
      if (params.signal?.aborted) {
        throw new AsrRuntimeError({
          code: 'JOB_CANCELLED',
          message: 'Modified beam search cancelled.',
          runtimeTarget: this.runtimeTarget,
        });
      }
      const nextMap = new Map<string, BeamHyp>();

      for (const hyp of beams) {
        const c0 = hyp.tokens[hyp.tokens.length - 2];
        const c1 = hyp.tokens[hyp.tokens.length - 1];
        const decVec = await runDecoder(c0, c1);
        const logits = await runJoiner(t, decVec);
        const logProbs = logSoftmax(logits);

        const top: { id: number; lp: number }[] = [{ id: 0, lp: logProbs[0] - blankPenalty }];
        for (let v = 1; v < logProbs.length; v++) {
          const bias = biasMap?.get(v) ?? 0;
          const lp = logProbs[v] + bias;
          if (top.length < beamSize + 1) {
            top.push({ id: v, lp });
            top.sort((a, b) => b.lp - a.lp);
          } else if (lp > top[top.length - 1].lp) {
            top[top.length - 1] = { id: v, lp };
            top.sort((a, b) => b.lp - a.lp);
          }
        }

        const frameTs = Number((t * frameStrideSec).toFixed(3));
        for (const cand of top) {
          const newTokens = cand.id === 0 ? hyp.tokens : [...hyp.tokens, cand.id];
          const newTs = cand.id === 0 ? hyp.timestamps : [...hyp.timestamps, frameTs];
          const newScore = hyp.score + cand.lp;
          const key = newTokens.join(',');
          const existing = nextMap.get(key);
          if (!existing) {
            nextMap.set(key, { tokens: newTokens, timestamps: newTs, score: newScore });
          } else {
            existing.score = logAddExp(existing.score, newScore);
          }
        }
      }

      beams = Array.from(nextMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, beamSize);
    }

    const best = beams[0] ?? { tokens: [0, 0], timestamps: [], score: 0 };
    const emitted = best.tokens.slice(2);
    this.inferenceVerified = true;

    return {
      rawText: decodeBpeTokenIdsToText(emitted, this.vocab),
      tokenIds: emitted,
      tokenTimestampsSec: best.timestamps,
      logProbSum: Number(best.score.toFixed(4)),
      decoderJoinerInvocations: decJoinCalls,
      decodeTimeMs: Math.round(performance.now() - t0),
      policyId: params.policy.policyId,
      decodingMethod: 'modified_beam_search',
      maxActivePaths: beamSize,
      blankPenalty,
      contextTermsApplied: activeTerms,
    };
  }

  /**
   * Implements Avapardaz unified `LocalAsrRuntimeAdapter.transcribe()` contract.
   */
  public async transcribe(request: AsrTranscriptionRequest): Promise<AvapardazTranscriptResult> {
    if (this.activeJobId) {
      throw new AsrRuntimeError({
        code: 'JOB_ALREADY_RUNNING',
        message: `SHAHAB job ${this.activeJobId} is already running.`,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }
    if (!Number.isFinite(request.sampleRate) || request.sampleRate <= 0 || request.totalSamples <= 0) {
      throw new AsrRuntimeError({
        code: 'AUDIO_INVALID',
        message: 'Invalid audio sampleRate or empty buffer.',
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }

    const startedMs = performance.now();
    this.activeJobId = request.jobId;
    const jobAbortController = new AbortController();
    this.activeAbortController = jobAbortController;
    const onExternalAbort = () => jobAbortController.abort();
    if (request.signal?.aborted) {
      jobAbortController.abort();
    } else {
      request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      await this.initializeRuntime();
      if (jobAbortController.signal.aborted) {
        throw new AsrRuntimeError({
          code: 'JOB_CANCELLED',
          message: 'SHAHAB transcription cancelled before audio read.',
          runtimeTarget: this.runtimeTarget,
          jobId: request.jobId,
        });
      }
      const rawPcm = await request.readSourceRange(0, request.totalSamples);
      const { pcm16k } = conditionPcmTo16kMono({
        pcm: rawPcm,
        sampleRateHz: request.sampleRate,
        channels: 1,
      });

      const { encoderOutput } = await this.encodeAudio({
        pcm16k,
        segmentId: `${request.jobId}_seg0`,
        useCache: true,
        signal: jobAbortController.signal,
      });
      const policy = this.policyManager.getPolicy('BALANCED');
      const decoded = await this.decodeFromEncoderOutput({
        encoderOutput,
        policy,
        signal: jobAbortController.signal,
      });

      const durationSec = request.totalSamples / request.sampleRate;
      const processingTimeMs = Math.max(1, Math.round(performance.now() - startedMs));
      const normalizedText = normalizeCanonicalPersianUtterance(decoded.rawText);
      const lang = detectTextLanguageTag(normalizedText || decoded.rawText).language;

      return {
        contractVersion: AVAPARDAZ_ASR_CONTRACT_VERSION,
        jobId: request.jobId,
        runtimeTarget: this.runtimeTarget,
        runtimeName: this.runtimeName,
        executionProvider: 'wasm',
        modelId: this.modelId,
        modelVersion: this.modelRevision.slice(0, 12),
        modelSha256Hex: this.verifiedHashes?.encoder ?? this.expectedHashes.encoder,
        architecture: 'ZIPFORMER_TRANSDUCER',
        normalizationVersion: PERSIAN_NORMALIZATION_CONTRACT_VERSION,
        offlineVerified: true,
        sampleRateHz: 16000,
        durationSec: Number(durationSec.toFixed(6)),
        processingTimeMs,
        realTimeFactor: durationSec > 0 ? Number(((processingTimeMs / 1000) / durationSec).toFixed(4)) : 0,
        dominantLanguage: lang,
        rawText: decoded.rawText,
        normalizedText,
        timestampGranularity: 'SEGMENT',
        segments: [
          {
            id: `${request.jobId}_seg_1`,
            index: 0,
            startSec: 0,
            endSec: Number(durationSec.toFixed(6)),
            startSample16k: 0,
            endSample16k: pcm16k.length,
            rawText: decoded.rawText,
            normalizedText,
            language: lang,
            confidence: null, // Honest: uncalibrated raw RNN-T scores are never misrepresented as calibrated probability
            timestampGranularity: 'SEGMENT',
            words: [],
          },
        ],
        peakMemoryBytes: this.memoryGovernor.getTelemetry().processRssBytes,
      };
    } finally {
      request.signal?.removeEventListener('abort', onExternalAbort);
      if (this.activeAbortController === jobAbortController) {
        this.activeAbortController = null;
      }
      this.activeJobId = null;
    }
  }

  public async cancel(): Promise<void> {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.activeJobId = null;
  }

  public async unloadModel(): Promise<void> {
    await this.encoderSession?.release();
    await this.decoderSession?.release();
    await this.joinerSession?.release();
    this.encoderSession = null;
    this.decoderSession = null;
    this.joinerSession = null;
    this.memoryGovernor.clearAll();
  }

  public async getHealth(): Promise<AsrRuntimeHealthReport> {
    return {
      runtimeTarget: this.runtimeTarget,
      runtimeReady: this.encoderSession !== null,
      modelLoaded: this.encoderSession !== null && this.decoderSession !== null && this.joinerSession !== null,
      inferenceVerified: this.inferenceVerified,
      activeModelId: this.modelId,
      activeModelVersion: this.modelRevision.slice(0, 12),
      activeJobId: this.activeJobId,
      lastErrorCode: null,
      timestampMs: Date.now(),
    };
  }

  public getResourceUsage(): AsrRuntimeResourceReport {
    const t = this.memoryGovernor.getTelemetry();
    return {
      runtimeTarget: this.runtimeTarget,
      accountedMemoryBytes: t.totalCacheBytes,
      memoryHardLimitBytes: 56 * 1024 * 1024,
      activeWorkerCount: this.encoderSession ? 1 : 0,
      activeJobCount: this.activeJobId ? 1 : 0,
    };
  }

  public async dispose(): Promise<void> {
    await this.unloadModel();
  }

  /**
   * Exposes this ONNX Runtime Web WASM adapter via the host-independent
   * `ShahabCoreInferenceBackend` contract (SHB-F06).
   */
  public asCoreInferenceBackend(): ShahabCoreInferenceBackend {
    return {
      executionProvider: 'wasm_single_thread',
      modelId: this.modelId,
      modelVersion: this.modelRevision.slice(0, 12),
      getCapabilities: () => ({
        contractVersion: SHAHAB_CORE_CONTRACT_VERSION,
        executionProvider: 'wasm_single_thread',
        nativeCppAvailable: false,
        statefulStreamingSupported: false,
        maxThreads: 1,
        offlineCapable: true,
      }),
      initialize: () => this.initializeRuntime(),
      getVocab: () => this.vocab,
      runEncoder: async (features, numFrames, featureDim = 80) => {
        await this.initializeRuntime();
        const xTensor = new ort.Tensor('float32', features, [1, numFrames, featureDim]);
        const xLensTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(numFrames)]), [1]);
        try {
          const out = await this.encoderSession!.run({ x: xTensor, x_lens: xLensTensor });
          this.encoderInvocationCount++;
          try {
            const encRaw = out.encoder_out.data as Float32Array;
            const encLens = out.encoder_out_lens.data as BigInt64Array;
            const validFrames = Number(encLens[0]);
            const dim = Number(out.encoder_out.dims[2] ?? 384);
            const copy = new Float32Array(validFrames * dim);
            copy.set(encRaw.subarray(0, validFrames * dim));
            return { data: copy, numFrames: validFrames, dim, frameStrideSec: 0.04 };
          } finally {
            out.encoder_out.dispose?.();
            out.encoder_out_lens.dispose?.();
          }
        } finally {
          xTensor.dispose?.();
          xLensTensor.dispose?.();
        }
      },
      runDecoderBatch: async (contexts) => {
        await this.initializeRuntime();
        const batchSize = contexts.length;
        if (batchSize === 0) return [];
        const flat = new BigInt64Array(batchSize * 2);
        for (let i = 0; i < batchSize; i++) {
          flat[i * 2] = BigInt(contexts[i][0]);
          flat[i * 2 + 1] = BigInt(contexts[i][1]);
        }
        const y = new ort.Tensor('int64', flat, [batchSize, 2]);
        try {
          const res = await this.decoderSession!.run({ y });
          this.decoderInvocationCount++;
          try {
            const raw = res.decoder_out.data as Float32Array;
            const outDim = raw.length / batchSize;
            const results: Float32Array[] = new Array(batchSize);
            for (let i = 0; i < batchSize; i++) {
              const vec = new Float32Array(outDim);
              vec.set(raw.subarray(i * outDim, (i + 1) * outDim));
              results[i] = vec;
            }
            return results;
          } finally {
            res.decoder_out?.dispose?.();
          }
        } finally {
          y.dispose?.();
        }
      },
      runJoinerBatch: async (encoderFrame, decoderVectors, dim) => {
        await this.initializeRuntime();
        const batchSize = decoderVectors.length;
        if (batchSize === 0) return [];
        const encBatch = new Float32Array(batchSize * dim);
        const decBatch = new Float32Array(batchSize * dim);
        for (let i = 0; i < batchSize; i++) {
          encBatch.set(encoderFrame, i * dim);
          decBatch.set(decoderVectors[i], i * dim);
        }
        const encoderTensor = new ort.Tensor('float32', encBatch, [batchSize, dim]);
        const decoderTensor = new ort.Tensor('float32', decBatch, [batchSize, dim]);
        try {
          const res = await this.joinerSession!.run({
            encoder_out: encoderTensor,
            decoder_out: decoderTensor,
          });
          try {
            const raw = res.logit.data as Float32Array;
            const vocabSize = raw.length / batchSize;
            const results: Float32Array[] = new Array(batchSize);
            for (let i = 0; i < batchSize; i++) {
              const row = new Float32Array(vocabSize);
              row.set(raw.subarray(i * vocabSize, (i + 1) * vocabSize));
              results[i] = row;
            }
            return results;
          } finally {
            res.logit?.dispose?.();
          }
        } finally {
          encoderTensor.dispose?.();
          decoderTensor.dispose?.();
        }
      },
      dispose: () => this.dispose(),
    };
  }
}

/**
 * ============================================================================
 * SHAHAB-009 — UNIFIED RUNTIME CAPABILITY REGISTRY
 * ============================================================================
 */
export interface ShahabRuntimeCapabilityProfile {
  readonly runtimeId: string;
  readonly executionLocation: 'LOCAL_BROWSER' | 'LOCAL_NATIVE' | 'CLOUD_AUTHORIZED';
  readonly executionProvider: string;
  readonly verifiedInCurrentContainer: boolean;
  readonly supportedTensorDtypes: readonly string[];
  readonly int4MatMulNBitsSupported: boolean | 'NOT_VERIFIED';
  readonly streamingEncoderSupported: boolean;
  readonly encoderOutputReuseSupported: boolean;
  readonly maxRecommendedPackageBytes: number;
  readonly localAudioUploadPolicy: 'NEVER_UPLOAD' | 'EXPLICIT_USER_AUTHORIZATION_REQUIRED';
  readonly statusNote: string;
}

export class SHAHABRuntimeCapabilityRegistry {
  public listProfiles(options?: {
    readonly modelDir?: string;
    readonly runtimeVerified?: boolean;
  }): readonly ShahabRuntimeCapabilityProfile[] {
    const resolvedDir = path.resolve(options?.modelDir ?? resolveDefaultShahabModelDir());
    const requiredFiles = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
    const allWeightsPresent = requiredFiles.every((f) => {
      try {
        const st = fs.statSync(path.join(resolvedDir, f));
        return st.isFile() && st.size > 0;
      } catch {
        return false;
      }
    });
    const wasmVerified = options?.runtimeVerified ?? allWeightsPresent;

    return [
      {
        runtimeId: 'shahab-browser-wasm-cpu',
        executionLocation: 'LOCAL_BROWSER',
        executionProvider: 'onnxruntime-web@1.31.1 (wasm)',
        verifiedInCurrentContainer: wasmVerified,
        supportedTensorDtypes: ['FLOAT', 'INT8', 'UINT8', 'INT64', 'INT32', 'BOOL'],
        int4MatMulNBitsSupported: false,
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 256 * 1024 * 1024,
        localAudioUploadPolicy: 'NEVER_UPLOAD',
        statusNote: wasmVerified
          ? 'Required Persian Zipformer INT8 ONNX model artifacts detected on disk for onnxruntime-web WASM CPU execution.'
          : 'UNVERIFIED in current environment: required ONNX model weight files are absent on disk.',
      },
      {
        runtimeId: 'shahab-browser-webgpu',
        executionLocation: 'LOCAL_BROWSER',
        executionProvider: 'onnxruntime-web (webgpu)',
        verifiedInCurrentContainer: false,
        supportedTensorDtypes: ['FLOAT', 'FLOAT16'],
        int4MatMulNBitsSupported: 'NOT_VERIFIED',
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 256 * 1024 * 1024,
        localAudioUploadPolicy: 'NEVER_UPLOAD',
        statusNote: 'UNVERIFIED: No physical GPU / WebGPU adapter in headless Linux container; dynamic INT8 ConvInteger/MatMulInteger ops typically fall back to WASM.',
      },
      {
        runtimeId: 'shahab-native-sherpa-cpu',
        executionLocation: 'LOCAL_NATIVE',
        executionProvider: 'sherpa-onnx C++ / ONNX Runtime CPU',
        verifiedInCurrentContainer: false,
        supportedTensorDtypes: ['FLOAT', 'INT8', 'UINT8', 'INT64'],
        int4MatMulNBitsSupported: 'NOT_VERIFIED',
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 2 * 1024 * 1024 * 1024,
        localAudioUploadPolicy: 'NEVER_UPLOAD',
        statusNote: 'UNVERIFIED in container: sherpa-onnx-offline binary not installed in Linux sandbox; supported on desktop Companion deployments.',
      },
      {
        runtimeId: 'shahab-cloud-unified-contract',
        executionLocation: 'CLOUD_AUTHORIZED',
        executionProvider: 'Unified Avapardaz Local/Cloud Contract (explicit opt-in only)',
        verifiedInCurrentContainer: false,
        supportedTensorDtypes: ['FLOAT', 'FLOAT16', 'INT8'],
        int4MatMulNBitsSupported: 'NOT_VERIFIED',
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 4 * 1024 * 1024 * 1024,
        localAudioUploadPolicy: 'EXPLICIT_USER_AUTHORIZATION_REQUIRED',
        statusNote:
          'Contract-level opt-in policy only; no live cloud inference endpoint verified in this local-first environment (AVP-P01-006 / SHAHAB-010 §2).',
      },
    ];
  }
}
