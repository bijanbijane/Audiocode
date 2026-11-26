/**
 * AVAPARDAZ — SHAHAB ZIPFORMER-TRANSDUCER LOCAL ASR RUNTIME BRIDGE
 *
 * Connects the real, unmocked SHAHAB Frozen Zipformer-Transducer Engine
 * (`src/shahab/ShahabZipformerEngine.ts`) to:
 *   1. Engine 01 contract (`ShahabAsrEngine` in `SmartAudioEditPipeline` & `/api/v2/smart-edit/*`)
 *   2. Direct local studio transcription routes (`/api/shahab/runtime-status`, `/api/shahab/transcribe`, `/api/shahab/sample.wav`)
 *
 * Strict invariants:
 * - Zero cloud calls, zero mock fallbacks, zero weight mutation (`trainableParameters = 0`).
 * - Verifies SHA-256 integrity of encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt.
 * - Serializes ONNX inference passes safely so concurrent requests never collide.
 * - Preserves verbatim ASR output (never deletes fillers/repetitions — Engine 02 owns editing).
 * - Honest timestamp granularity: projects 40ms Zipformer RNN-T frame-stride BPE emissions into
 *   monotonic sample-bounded `TranscriptToken[]` labeled `SEGMENT_ESTIMATED` (never claims forced alignment).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestAudioBufferToCanonical16kMonoAsync } from '../asr-core/CoreAudioIngestion';
import { detectTextLanguageTag } from '../asr-core/CoreNormalizationAndLanguage';
import { normalizePersianTextDeterministic } from './ShahabContracts';
import { normalizeCanonicalPersianUtterance } from './core/ShahabCorePersianNormalizer';
import { resolveDefaultShahabModelDir } from './ShahabModelStore';
import { buildPersianLexicalRepresentation } from './ShahabPersianMemoryAndContext';
import {
  decodeWavToMono16k,
  SHAHABFrozenModelAdapter,
  type ShahabDecodePolicyId,
  type ShahabDecodedHypothesis,
  type ShahabHotwordBiasMap,
} from './ShahabZipformerEngine';
import {
  DEFAULT_SHAHAB_CHUNK_SEC,
  DEFAULT_SHAHAB_OVERLAP_SEC,
  mergeChunkedTranscriptWords,
  planAudioChunks,
  type ChunkWordBucket,
} from '../asr-core/ShahabChunkMerger';
import type {
  ShahabAsrEngine,
  ShahabAsrRuntimeMetrics,
  ShahabTranscribeRequest,
  TranscriptDocument,
  TranscriptToken,
} from '../workflow/SmartAudioEditContracts';

export const DEFAULT_SHAHAB_ZIPFORMER_MODEL_DIR = resolveDefaultShahabModelDir();
const MAX_SHAHAB_AUDIO_FILE_BYTES = 128 * 1024 * 1024;
export const SHAHAB_ZIPFORMER_MODEL_ID = 'persian-zipformer-transducer';
export const SHAHAB_ZIPFORMER_MODEL_VERSION = '1.0.0-shahab-zipformer-int8';
export const SHAHAB_ZIPFORMER_UPSTREAM_ID = 'ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f';
export const DEFAULT_SHAHAB_MAX_PENDING_JOBS = 8;
export const DEFAULT_SHAHAB_MAX_SINGLE_REQUEST_DURATION_SEC = 600; // 10 minutes per single synchronous runtime call

const REQUIRED_MODEL_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
] as const;

export interface ShahabZipformerRuntimeStatus {
  readonly available: boolean;
  readonly modelLoaded: boolean;
  readonly engine: 'SHAHAB_ZIPFORMER_TRANSDUCER';
  readonly modelId: string;
  readonly modelVersion: string;
  readonly upstreamModelId: string;
  readonly runtime: 'shahab-zipformer-onnx-cpu';
  readonly executionProvider?: 'wasm_single_thread' | 'native_cpp';
  readonly nativeCppAvailable?: boolean;
  readonly offlineOnlyEnforced: true;
  readonly modelDir: string;
  readonly missingFiles: readonly string[];
  readonly integrityError: string | null;
  readonly integrityVerified?: boolean;
  readonly maxSingleRequestDurationSec?: number;
  readonly sampleAudioAvailable: boolean;
  readonly sampleAudioPath: string | null;
  readonly activeJobCount: number;
  readonly queuedJobCount: number;
  readonly maxPendingJobs: number;
  readonly lastMetrics: ShahabAsrRuntimeMetrics | null;
}

export interface ShahabVerifiedContextTerm {
  readonly term: string;
  readonly boostWeight: number;
}

/**
 * Builds a bounded, acoustic-safe BPE hotword bias map directly from tenant-verified
 * Persian context terms using the active model's real `tokens.txt` vocabulary.
 */
export function buildHotwordBiasMapFromVerifiedTerms(params: {
  readonly terms: readonly ShahabVerifiedContextTerm[];
  readonly vocab: readonly string[];
  readonly baseBiasScore: number;
  readonly maxBiasScoreCap?: number;
}): ShahabHotwordBiasMap | null {
  if (!params.terms.length || !params.vocab.length) return null;
  const cap = Math.max(0.1, Math.min(1.5, params.maxBiasScoreCap ?? 1.5));
  const baseScore = Math.max(0, Math.min(cap, params.baseBiasScore));
  if (baseScore <= 0) return null;

  const tokenBiases = new Map<number, number>();
  const activeTerms: string[] = [];

  for (const entry of params.terms) {
    const cleaned = entry.term.trim();
    if (!cleaned) continue;
    const repr = buildPersianLexicalRepresentation({
      originalUserText: cleaned,
      vocab: params.vocab,
    });
    if (!repr.tokenizableByModel || repr.modelTokenizerIds.length === 0) continue;
    activeTerms.push(cleaned);
    const weight = Number.isFinite(entry.boostWeight)
      ? Math.max(0.1, Math.min(2.0, entry.boostWeight))
      : 1.0;
    const termScore = Math.min(cap, baseScore * weight);
    const pieceBias = Number(
      (termScore / Math.max(1, Math.sqrt(repr.modelTokenizerIds.length))).toFixed(4),
    );
    for (const id of repr.modelTokenizerIds) {
      if (id <= 0) continue;
      tokenBiases.set(id, Math.max(tokenBiases.get(id) ?? 0, pieceBias));
    }
  }

  return activeTerms.length > 0 ? { tokenBiases, activeTerms } : null;
}

export type ShahabZipformerRuntimeErrorCode =
  | 'MODEL_NOT_AVAILABLE'
  | 'SHAHAB_MODEL_INTEGRITY_FAILED'
  | 'INVALID_AUDIO_INPUT'
  | 'AUDIO_DURATION_LIMIT_EXCEEDED'
  | 'SHAHAB_QUEUE_FULL'
  | 'TRANSCRIPTION_CANCELLED'
  | 'ASR_INFERENCE_FAILED';

export class ShahabZipformerRuntimeError extends Error {
  public readonly code: ShahabZipformerRuntimeErrorCode;

  constructor(code: ShahabZipformerRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'ShahabZipformerRuntimeError';
    this.code = code;
  }
}

interface RawTimedWord {
  readonly rawText: string;
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * Reconstructs Persian words and honest Zipformer 40ms frame-stride time spans
 * from emitted BPE token IDs and their frame timestamps.
 */
export function projectBpeEmissionsToTimedWords(params: {
  readonly decoded: ShahabDecodedHypothesis;
  readonly vocab: readonly string[];
  readonly chunkOffsetSec: number;
  readonly chunkDurationSec: number;
}): RawTimedWord[] {
  const { decoded, vocab, chunkOffsetSec, chunkDurationSec } = params;
  const safeDurationSec = Number.isFinite(chunkDurationSec) ? Math.max(0, chunkDurationSec) : 0;
  const safeChunkOffsetSec = Number.isFinite(chunkOffsetSec) ? Math.max(0, chunkOffsetSec) : 0;
  const maxEndSec = safeChunkOffsetSec + safeDurationSec;

  // Never invent word positions from text length or chunk duration. RNNT emission
  // timestamps must be present, one-for-one, finite, and inside the source chunk.
  // The caller still preserves decoded.rawText when acoustic timing is unavailable.
  if (
    decoded.tokenIds.length === 0 ||
    decoded.tokenTimestampsSec.length !== decoded.tokenIds.length ||
    decoded.tokenTimestampsSec.some(
      (timestamp) => !Number.isFinite(timestamp) || timestamp < 0 || timestamp > safeDurationSec + 0.1,
    )
  ) {
    return [];
  }

  const grouped: Array<{ pieces: string[]; startSec: number; lastEmitSec: number }> = [];
  for (let i = 0; i < decoded.tokenIds.length; i++) {
    const id = decoded.tokenIds[i];
    if (id === 0) continue;
    const piece = vocab[id] ?? '';
    if (!piece || piece === '<blk>' || piece === '<sos/eos>' || piece === '<unk>') continue;
    const rawTs = decoded.tokenTimestampsSec[i];
    const tsSec = Math.min(maxEndSec, safeChunkOffsetSec + rawTs);

    const startsNewWord = piece.startsWith('▁') || grouped.length === 0;
    const cleanPiece = piece.replace(/^▁+/, '');
    if (startsNewWord) {
      if (cleanPiece.length > 0) {
        grouped.push({ pieces: [cleanPiece], startSec: tsSec, lastEmitSec: tsSec });
      }
    } else if (cleanPiece.length > 0) {
      const curr = grouped[grouped.length - 1];
      curr.pieces.push(cleanPiece);
      curr.lastEmitSec = Math.max(curr.lastEmitSec, tsSec);
    }
  }

  if (grouped.length === 0) return [];

  const out: RawTimedWord[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const item = grouped[i];
    const wordText = item.pieces.join('').trim();
    if (!wordText) continue;
    const nextStart = i + 1 < grouped.length ? grouped[i + 1].startSec : maxEndSec;
    const startSec = Math.max(chunkOffsetSec, Math.min(item.startSec, maxEndSec - 0.04));
    const naturalEnd = Math.max(item.lastEmitSec + 0.08, startSec + 0.08);
    const endSec = Math.max(
      startSec + 0.04,
      Math.min(maxEndSec, nextStart > startSec + 0.04 ? Math.min(nextStart, naturalEnd + 0.25) : naturalEnd),
    );
    out.push({ rawText: wordText, startSec, endSec });
  }
  return out;
}

/**
 * Merges chunk word lists via midpoint-anchored overlap stitching and maps them to
 * strictly monotonic, sample-bounded `TranscriptToken[]`.
 */
function buildMonotonicSampleBoundedTokens(params: {
  readonly chunkBuckets: readonly ChunkWordBucket<RawTimedWord>[];
  readonly sourceSampleRate: number;
  readonly totalSourceSamples: number;
}): TranscriptToken[] {
  const { chunkBuckets, sourceSampleRate, totalSourceSamples } = params;
  if (totalSourceSamples <= 1) return [];

  const totalDurationSec = totalSourceSamples / sourceSampleRate;
  const merged = mergeChunkedTranscriptWords({
    buckets: chunkBuckets,
    totalDurationSec,
  });

  if (merged.length === 0) return [];

  const tokens: TranscriptToken[] = [];
  let cursorSample = 0;

  for (let i = 0; i < merged.length; i++) {
    const w = merged[i];
    const remainingTokens = merged.length - i;
    const maxStartAllowed = Math.max(0, totalSourceSamples - remainingTokens);

    let startSample = Math.round(w.startSec * sourceSampleRate);
    startSample = Math.max(cursorSample, Math.min(startSample, maxStartAllowed));

    let endSample = Math.round(w.endSec * sourceSampleRate);
    const maxEndAllowed = Math.max(startSample + 1, totalSourceSamples - (remainingTokens - 1));
    endSample = Math.max(startSample + 1, Math.min(endSample, maxEndAllowed));
    endSample = Math.min(totalSourceSamples, endSample);

    if (endSample <= startSample) {
      continue;
    }

    const norm = normalizePersianTextDeterministic(w.rawText).normalized || w.rawText;
    tokens.push({
      tokenId: `shahab_tok_${i}`,
      rawText: w.rawText,
      normalizedText: norm,
      startSample,
      endSample,
      startSec: Number((startSample / sourceSampleRate).toFixed(4)),
      endSec: Number((endSample / sourceSampleRate).toFixed(4)),
      confidence: null,
      timestampGranularity: 'SEGMENT_ESTIMATED',
    });

    cursorSample = Math.min(totalSourceSamples - 1, Math.max(cursorSample, endSample));
  }

  return tokens;
}

export class ShahabZipformerAsrRuntime implements ShahabAsrEngine {
  private readonly modelDir: string;
  private readonly maxPendingJobs: number;
  private readonly maxSingleRequestDurationSec: number;
  private readonly idleUnloadMs: number;
  private readonly allowedAudioRoots: readonly string[];
  private adapter: SHAHABFrozenModelAdapter | null = null;
  private loadedFilesSignature: string | null = null;
  private lastMetrics: ShahabAsrRuntimeMetrics | null = null;
  private activeJobCount = 0;
  private pendingJobCount = 0;
  private integrityError: string | null = null;
  private integrityCheckedSignature: string | null = null;
  private integrityVerified = false;
  private executionTail: Promise<void> = Promise.resolve();
  private idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: {
    readonly modelDir?: string;
    readonly maxPendingJobs?: number;
    readonly maxSingleRequestDurationSec?: number;
    /** Optional idle auto-unload delay in ms (0 disables automatic idle unload). */
    readonly idleUnloadMs?: number;
    /** Optional filesystem allowlist for `request.audioFilePath` (defaults to workspace cwd, tmpdir, and modelDir). */
    readonly allowedAudioRoots?: readonly string[];
  }) {
    this.modelDir = path.resolve(options?.modelDir ?? resolveDefaultShahabModelDir());
    this.maxPendingJobs = Math.max(1, Math.floor(options?.maxPendingJobs ?? DEFAULT_SHAHAB_MAX_PENDING_JOBS));
    this.maxSingleRequestDurationSec = Math.max(
      1,
      options?.maxSingleRequestDurationSec ?? DEFAULT_SHAHAB_MAX_SINGLE_REQUEST_DURATION_SEC,
    );
    this.idleUnloadMs =
      typeof options?.idleUnloadMs === 'number' && Number.isFinite(options.idleUnloadMs) && options.idleUnloadMs > 0
        ? Math.floor(options.idleUnloadMs)
        : 0;
    const rawRoots =
      options?.allowedAudioRoots && options.allowedAudioRoots.length > 0
        ? options.allowedAudioRoots
        : [process.cwd(), os.tmpdir(), this.modelDir];
    this.allowedAudioRoots = rawRoots.map((root) => {
      const resolved = path.resolve(root);
      try {
        return fs.realpathSync(resolved);
      } catch {
        return resolved;
      }
    });
  }

  private clearIdleUnloadTimer(): void {
    if (this.idleUnloadTimer) {
      clearTimeout(this.idleUnloadTimer);
      this.idleUnloadTimer = null;
    }
  }

  private scheduleIdleUnload(): void {
    this.clearIdleUnloadTimer();
    if (this.idleUnloadMs <= 0 || !this.adapter) return;
    this.idleUnloadTimer = setTimeout(() => {
      this.idleUnloadTimer = null;
      if (this.pendingJobCount === 0 && this.activeJobCount === 0 && this.adapter) {
        void this.unloadAsync().catch(() => {});
      }
    }, this.idleUnloadMs);
    this.idleUnloadTimer.unref?.();
  }

  public getModelDir(): string {
    return this.modelDir;
  }

  public getMaxSingleRequestDurationSec(): number {
    return this.maxSingleRequestDurationSec;
  }

  private computeModelFilesSignature(): {
    readonly missingFiles: string[];
    readonly signature: string;
  } {
    const missingFiles: string[] = [];
    const parts: string[] = [];
    for (const name of REQUIRED_MODEL_FILES) {
      const fullPath = path.join(this.modelDir, name);
      try {
        const st = fs.statSync(fullPath);
        if (!st.isFile() || st.size <= 0) {
          missingFiles.push(name);
          parts.push(`${name}:empty`);
        } else {
          parts.push(`${name}:${st.size}:${Math.trunc(st.mtimeMs)}`);
        }
      } catch {
        missingFiles.push(name);
        parts.push(`${name}:missing`);
      }
    }
    return { missingFiles, signature: parts.join('|') };
  }

  public getBundledSampleAudioPath(): {
    readonly filePath: string;
    readonly filename: string;
    readonly modelId: string;
  } | null {
    const samplePath = path.join(this.modelDir, 'sample.wav');
    try {
      const st = fs.statSync(samplePath);
      if (st.isFile() && st.size >= 44) {
        return {
          filePath: samplePath,
          filename: 'sample.wav',
          modelId: SHAHAB_ZIPFORMER_MODEL_ID,
        };
      }
    } catch {
      // Sample audio not present on disk
    }
    return null;
  }

  private verifyDiskIntegrityForSignature(
    missingFiles: readonly string[],
    signature: string,
  ): { readonly verified: boolean; readonly error: string | null } {
    if (missingFiles.length > 0) {
      this.integrityCheckedSignature = signature;
      this.integrityVerified = false;
      this.integrityError = null;
      return { verified: false, error: null };
    }
    if (this.integrityCheckedSignature === signature) {
      return { verified: this.integrityVerified, error: this.integrityError };
    }
    const probeAdapter = this.adapter ?? new SHAHABFrozenModelAdapter({ modelDir: this.modelDir });
    try {
      const immut = probeAdapter.verifyWeightImmutability();
      this.integrityCheckedSignature = signature;
      if (immut.immutable) {
        this.integrityVerified = true;
        this.integrityError = null;
      } else {
        this.integrityVerified = false;
        this.integrityError = `فایل‌های وزن مدل شهاب با هش SHA-256 معتبر مطابقت ندارند (${immut.mismatches.join('; ')}).`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.integrityCheckedSignature = signature;
      this.integrityVerified = false;
      this.integrityError = `بررسی یکپارچگی فایل‌های مدل شهاب ناموفق بود: ${msg}`;
    }
    return { verified: this.integrityVerified, error: this.integrityError };
  }

  public getRuntimeStatus(): ShahabZipformerRuntimeStatus {
    const { missingFiles, signature } = this.computeModelFilesSignature();
    const integrity = this.verifyDiskIntegrityForSignature(missingFiles, signature);

    const sample = this.getBundledSampleAudioPath();
    const queuedJobCount = Math.max(0, this.pendingJobCount - this.activeJobCount);
    const available = missingFiles.length === 0 && integrity.verified && integrity.error === null;

    return {
      available,
      modelLoaded: this.adapter !== null,
      engine: 'SHAHAB_ZIPFORMER_TRANSDUCER',
      modelId: SHAHAB_ZIPFORMER_MODEL_ID,
      modelVersion: SHAHAB_ZIPFORMER_MODEL_VERSION,
      upstreamModelId: SHAHAB_ZIPFORMER_UPSTREAM_ID,
      runtime: 'shahab-zipformer-onnx-cpu',
      executionProvider: 'wasm_single_thread',
      nativeCppAvailable: false,
      offlineOnlyEnforced: true,
      modelDir: this.modelDir,
      missingFiles,
      integrityError: integrity.error,
      integrityVerified: integrity.verified,
      maxSingleRequestDurationSec: this.maxSingleRequestDurationSec,
      sampleAudioAvailable: sample !== null,
      sampleAudioPath: sample?.filePath ?? null,
      activeJobCount: this.activeJobCount,
      queuedJobCount,
      maxPendingJobs: this.maxPendingJobs,
      lastMetrics: this.lastMetrics,
    };
  }

  private async ensureAdapterReady(): Promise<SHAHABFrozenModelAdapter> {
    const { missingFiles, signature } = this.computeModelFilesSignature();
    if (missingFiles.length > 0) {
      if (this.adapter) {
        const stale = this.adapter;
        this.adapter = null;
        this.loadedFilesSignature = null;
        await stale.dispose().catch(() => {});
      }
      this.integrityCheckedSignature = signature;
      this.integrityVerified = false;
      this.integrityError = null;
      throw new ShahabZipformerRuntimeError(
        'MODEL_NOT_AVAILABLE',
        `MODEL_NOT_AVAILABLE: Required SHAHAB Zipformer assets are missing (${missingFiles.join(', ')}). Run "node scripts/download-persian-zipformer-assets.mjs".`,
      );
    }

    // If files on disk changed after the adapter was loaded, dispose stale sessions and re-verify SHA-256
    if (this.adapter && this.loadedFilesSignature !== signature) {
      const stale = this.adapter;
      this.adapter = null;
      this.loadedFilesSignature = null;
      await stale.dispose().catch(() => {});
    }

    if (!this.adapter) {
      const adapter = new SHAHABFrozenModelAdapter({ modelDir: this.modelDir });
      try {
        await adapter.initializeRuntime();
        this.integrityError = null;
        this.integrityCheckedSignature = signature;
        this.integrityVerified = true;
        this.loadedFilesSignature = signature;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('immutability') || msg.includes('SHA-256') || msg.includes('MODEL_INTEGRITY_FAILURE')) {
          this.integrityError = `فایل‌های وزن مدل شهاب با هش SHA-256 معتبر مطابقت ندارند (احتمال خرابی فایل).`;
          this.integrityCheckedSignature = signature;
          this.integrityVerified = false;
          throw new ShahabZipformerRuntimeError('SHAHAB_MODEL_INTEGRITY_FAILED', msg);
        }
        throw new ShahabZipformerRuntimeError('ASR_INFERENCE_FAILED', msg);
      }
      this.adapter = adapter;
    }

    return this.adapter;
  }

  private async disposeAdapterLocked(): Promise<boolean> {
    this.clearIdleUnloadTimer();
    if (!this.adapter) return false;
    const ref = this.adapter;
    this.adapter = null;
    this.loadedFilesSignature = null;
    await ref.dispose().catch(() => {});
    return true;
  }

  public async unloadAsync(): Promise<{ readonly unloaded: boolean; readonly rssMb: number }> {
    const unloaded = await this.enqueueSerialized(async () => this.disposeAdapterLocked());
    const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    return { unloaded, rssMb };
  }

  public unload(): { readonly unloaded: boolean; readonly rssMb: number } {
    this.clearIdleUnloadTimer();
    const hadAdapter = this.adapter !== null;
    if (hadAdapter) {
      // Always serialize disposal behind executionTail so concurrent ensureAdapterReady() never races with dispose()
      void this.enqueueSerialized(async () => {
        await this.disposeAdapterLocked();
      });
    }
    const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    return { unloaded: hadAdapter, rssMb };
  }

  public async dispose(): Promise<void> {
    this.clearIdleUnloadTimer();
    await this.enqueueSerialized(async () => {
      if (this.adapter) {
        const ref = this.adapter;
        this.adapter = null;
        this.loadedFilesSignature = null;
        await ref.dispose();
      }
    });
  }

  private enqueueSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.executionTail.then(fn, fn);
    this.executionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async transcribe(
    request: ShahabTranscribeRequest & {
      readonly decodePolicy?: ShahabDecodePolicyId;
      readonly verifiedContextTerms?: readonly ShahabVerifiedContextTerm[];
    },
  ): Promise<{
    readonly transcript: TranscriptDocument;
    readonly metrics: ShahabAsrRuntimeMetrics;
  }> {
    if (request.signal?.aborted) {
      throw new ShahabZipformerRuntimeError(
        'TRANSCRIPTION_CANCELLED',
        'TRANSCRIPTION_CANCELLED: Request cancelled before start.',
      );
    }

    if (this.pendingJobCount >= this.maxPendingJobs) {
      throw new ShahabZipformerRuntimeError(
        'SHAHAB_QUEUE_FULL',
        `صف پردازش موتور محلی شهاب پر است (${this.pendingJobCount}/${this.maxPendingJobs}). لطفاً چند ثانیه بعد دوباره تلاش کنید.`,
      );
    }

    this.clearIdleUnloadTimer();
    this.pendingJobCount += 1;
    try {
      return await this.enqueueSerialized(async () => {
        if (request.signal?.aborted) {
          throw new ShahabZipformerRuntimeError(
            'TRANSCRIPTION_CANCELLED',
            'TRANSCRIPTION_CANCELLED: Request cancelled while queued.',
          );
        }

        const rssBeforeMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
        const startedMs = performance.now();
        this.activeJobCount += 1;

        try {
          // Fast path: reuse ENGINE 01's already-canonicalized 16 kHz mono PCM to prevent double-decoding & resampling drift
          let pcm16k: Float32Array;
          let detectedSourceRate = request.sourceSampleRate ?? 16000;
          let detectedTotalSamples = request.totalSourceSamples;
          let audioSha256: string;

          const hasCanonicalPcm =
            request.canonicalPcm16kMono instanceof Float32Array &&
            request.canonicalPcm16kMono.length > 0;

          if (hasCanonicalPcm) {
            const candidate = request.canonicalPcm16kMono!;
            // Scan EVERY sample so localized NaN/Infinity bursts can never leak into FBANK/ONNX tensors
            for (let i = 0; i < candidate.length; i++) {
              if (!Number.isFinite(candidate[i])) {
                throw new ShahabZipformerRuntimeError(
                  'INVALID_AUDIO_INPUT',
                  'داده PCM ورودی دارای مقادیر نامعتبر (NaN/Infinity) است.',
                );
              }
            }
            pcm16k = candidate;
            audioSha256 =
              request.sourceAudioHash ??
              crypto
                .createHash('sha256')
                .update(new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength))
                .digest('hex');
            if (!detectedTotalSamples) {
              detectedTotalSamples = Math.max(
                1,
                Math.round((pcm16k.length / 16000) * detectedSourceRate),
              );
            }
          } else {
            let rawBytes: Buffer;
            let filename = request.filename ?? 'audio.wav';
            if (request.audioBytes && request.audioBytes.byteLength > 0) {
              // Zero-copy Buffer view over incoming audioBytes (eliminates redundant payload duplication)
              const incoming: Uint8Array = request.audioBytes;
              rawBytes = Buffer.isBuffer(incoming)
                ? incoming
                : Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength);
            } else if (request.audioFilePath) {
              if (request.audioFilePath.includes('\0')) {
                throw new ShahabZipformerRuntimeError(
                  'INVALID_AUDIO_INPUT',
                  'مسیر فایل صوتی معتبر نیست.',
                );
              }
              const resolvedPath = path.resolve(request.audioFilePath);
              let realPath: string;
              let stat: fs.Stats;
              try {
                realPath = fs.realpathSync(resolvedPath);
                stat = fs.statSync(realPath);
              } catch {
                throw new ShahabZipformerRuntimeError(
                  'INVALID_AUDIO_INPUT',
                  'فایل صوتی درخواستی روی دیسک یافت نشد.',
                );
              }
              const withinAllowedRoot = this.allowedAudioRoots.some(
                (root) => realPath === root || realPath.startsWith(root + path.sep),
              );
              if (!withinAllowedRoot) {
                throw new ShahabZipformerRuntimeError(
                  'INVALID_AUDIO_INPUT',
                  'مسیر فایل صوتی خارج از دایرکتوری‌های مجاز است.',
                );
              }
              if (!stat.isFile()) {
                throw new ShahabZipformerRuntimeError(
                  'INVALID_AUDIO_INPUT',
                  'مسیر درخواستی باید یک فایل صوتی عادی باشد.',
                );
              }
              if (stat.size > MAX_SHAHAB_AUDIO_FILE_BYTES) {
                throw new ShahabZipformerRuntimeError(
                  'INVALID_AUDIO_INPUT',
                  'حجم فایل صوتی از سقف مجاز موتور محلی بیشتر است.',
                );
              }
              rawBytes = fs.readFileSync(realPath);
              filename = path.basename(realPath);
            } else {
              throw new ShahabZipformerRuntimeError(
                'INVALID_AUDIO_INPUT',
                'داده صوتی ورودی خالی است. یک فایل صوتی معتبر (WAV/MP3/FLAC/OGG/M4A) ارسال کنید.',
              );
            }

            if (rawBytes.byteLength < 12) {
              throw new ShahabZipformerRuntimeError(
                'INVALID_AUDIO_INPUT',
                'فایل صوتی ورودی ناقص یا کوتاه‌تر از حد مجاز هدر صوتی است.',
              );
            }

            audioSha256 =
              request.sourceAudioHash ?? crypto.createHash('sha256').update(rawBytes).digest('hex');

            const containerTag = rawBytes.byteLength >= 12 ? rawBytes.toString('ascii', 0, 4) : '';
            const isRiffWav =
              rawBytes.byteLength >= 44 &&
              (containerTag === 'RIFF' || containerTag === 'RF64') &&
              rawBytes.toString('ascii', 8, 12) === 'WAVE';

            const decodeWithIngest = async (): Promise<{
              readonly pcm: Float32Array;
              readonly origRate: number;
            }> => {
              try {
                const canonical = await ingestAudioBufferToCanonical16kMonoAsync({
                  filename,
                  rawBytes,
                  signal: request.signal,
                  includePcm16: false,
                });
                return {
                  pcm: canonical.canonicalFloat32,
                  origRate: canonical.originalSampleRateHz || detectedSourceRate,
                };
              } catch (ingestErr) {
                const rawMsg = ingestErr instanceof Error ? ingestErr.message : String(ingestErr);
                if (rawMsg.includes('AUDIO_INGEST_CANCELLED')) {
                  throw new ShahabZipformerRuntimeError(
                    'TRANSCRIPTION_CANCELLED',
                    'عملیات رمزگشایی و رونویسی لغو شد.',
                  );
                }
                if (rawMsg.includes('AUDIO_INGEST_LIMIT_EXCEEDED') || rawMsg.includes('AUDIO_INGEST_DECODED_LIMIT_EXCEEDED')) {
                  throw new ShahabZipformerRuntimeError(
                    'INVALID_AUDIO_INPUT',
                    'حجم فایل صوتی از سقف مجاز موتور محلی بیشتر است.',
                  );
                }
                if (rawMsg.includes('AUDIO_INGEST_UNSUPPORTED_MAGIC')) {
                  throw new ShahabZipformerRuntimeError(
                    'INVALID_AUDIO_INPUT',
                    'فرمت یا امضای فایل صوتی پشتیبانی نمی‌شود. از فایل WAV، MP3، FLAC، OGG، M4A، WebM یا AIFF معتبر استفاده کنید.',
                  );
                }
                throw new ShahabZipformerRuntimeError(
                  'INVALID_AUDIO_INPUT',
                  'فایل صوتی ورودی خراب، ناقص یا غیرقابل رمزگشایی است.',
                );
              }
            };

            if (isRiffWav) {
              try {
                // Zero-copy Uint8Array view over rawBytes
                const decodedWav = decodeWavToMono16k(
                  new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength),
                );
                pcm16k = decodedWav.pcm16k;
                if (!request.sourceSampleRate && Number.isFinite(decodedWav.originalSampleRate)) {
                  detectedSourceRate = decodedWav.originalSampleRate;
                }
                if (!detectedTotalSamples) {
                  detectedTotalSamples = Math.max(
                    1,
                    Math.round((pcm16k.length / 16000) * detectedSourceRate),
                  );
                }
              } catch (wavErr) {
                const wavMsg = wavErr instanceof Error ? wavErr.message : '';
                if (wavMsg.includes('INVALID_WAV_TRUNCATED')) {
                  throw new ShahabZipformerRuntimeError(
                    'INVALID_AUDIO_INPUT',
                    'فایل WAV ورودی ناقص یا بریده‌شده است (حجم واقعی داده کمتر از هدر است).',
                  );
                }
                // 0-frame valid WAV header -> reject cleanly as invalid empty WAV
                if (wavMsg.includes('0 audio frames') || wavMsg.includes('Missing PCM data')) {
                  throw new ShahabZipformerRuntimeError(
                    'INVALID_AUDIO_INPUT',
                    'فایل WAV ورودی فاقد نمونه صوتی قابل پردازش است.',
                  );
                }
                const canonical = await decodeWithIngest();
                pcm16k = canonical.pcm;
                if (!request.sourceSampleRate) {
                  detectedSourceRate = canonical.origRate;
                }
                detectedTotalSamples =
                  detectedTotalSamples ??
                  Math.max(1, Math.round((pcm16k.length / 16000) * detectedSourceRate));
              }
            } else {
              const canonical = await decodeWithIngest();
              pcm16k = canonical.pcm;
              if (!request.sourceSampleRate) {
                detectedSourceRate = canonical.origRate;
              }
              detectedTotalSamples =
                detectedTotalSamples ??
                Math.max(1, Math.round((pcm16k.length / 16000) * detectedSourceRate));
            }
          }

          if (pcm16k.length === 0) {
            throw new ShahabZipformerRuntimeError(
              'INVALID_AUDIO_INPUT',
              'فایل صوتی ورودی پس از رمزگشایی هیچ نمونه صوتی ندارد.',
            );
          }

          const durationSec = pcm16k.length / 16000;
          if (durationSec > this.maxSingleRequestDurationSec) {
            throw new ShahabZipformerRuntimeError(
              'AUDIO_DURATION_LIMIT_EXCEEDED',
              `مدت فایل صوتی در یک درخواست واحد (${Math.round(durationSec)} ثانیه) از سقف مجاز (${this.maxSingleRequestDurationSec} ثانیه) بیشتر است. صوت باید به قطعات کوچک‌تر تقسیم شود.`,
            );
          }

          const sourceSampleRate = Number.isFinite(detectedSourceRate)
            ? Math.max(8000, Math.round(detectedSourceRate))
            : 16000;
          const totalSourceSamples = Math.max(
            1,
            Math.round(
              Number.isFinite(detectedTotalSamples)
                ? (detectedTotalSamples as number)
                : durationSec * sourceSampleRate,
            ),
          );

          const adapter = await this.ensureAdapterReady();
          const policyId: ShahabDecodePolicyId = request.decodePolicy ?? 'BALANCED';
          const policy = adapter.policyManager.getPolicy(policyId);
          const vocab = adapter.getVocab();
          const hotwordBias =
            policy.allowContextualBias && request.verifiedContextTerms && request.verifiedContextTerms.length > 0
              ? buildHotwordBiasMapFromVerifiedTerms({
                  terms: request.verifiedContextTerms,
                  vocab,
                  baseBiasScore: policy.defaultContextBiasScore,
                })
              : null;

          // Chunk audio > maxChunkDurationSec (default 24s) with 1.0s overlap for clean boundary stitching
          const maxChunkSec = Math.max(
            10,
            Math.min(30, request.maxChunkDurationSec ?? DEFAULT_SHAHAB_CHUNK_SEC),
          );
          const overlapSec = Math.max(
            0,
            Math.min(2, request.overlapSec ?? DEFAULT_SHAHAB_OVERLAP_SEC),
          );
          const chunkRanges = planAudioChunks({
            totalSamples: pcm16k.length,
            sampleRate: 16000,
            maxChunkSec,
            overlapSec,
          });

          const chunkBuckets: ChunkWordBucket<RawTimedWord>[] = [];
          const rawChunkTexts: string[] = [];

          for (let idx = 0; idx < chunkRanges.length; idx++) {
            if (request.signal?.aborted) {
              throw new ShahabZipformerRuntimeError(
                'TRANSCRIPTION_CANCELLED',
                'TRANSCRIPTION_CANCELLED: Aborted during chunked SHAHAB inference.',
              );
            }
            const range = chunkRanges[idx];
            const slice = pcm16k.subarray(range.startSample, range.endSample);
            const chunkOffsetSec = range.startSec;
            const chunkDurationSec = slice.length / 16000;

            const tenantScope =
              request.ownerId || request.projectId
                ? `${request.ownerId ?? 'anon'}:${request.projectId ?? 'default'}`
                : 'default';

            const { encoderOutput } = await adapter.encodeAudio({
              pcm16k: slice,
              segmentId: `${request.sourceAudioId}_c${idx}`,
              tenantScope,
              useCache: true,
              signal: request.signal,
            });
            const decoded = await adapter.decodeFromEncoderOutput({
              encoderOutput,
              policy,
              hotwordBias,
              signal: request.signal,
            });

            const trimmed = decoded.rawText.trim();
            if (trimmed.length > 0) {
              rawChunkTexts.push(trimmed);
            }
            chunkBuckets.push({
              chunkStartSec: range.startSec,
              chunkEndSec: range.endSec,
              words: projectBpeEmissionsToTimedWords({
                decoded,
                vocab,
                chunkOffsetSec,
                chunkDurationSec,
              }),
            });

            request.onProgress?.({
              percent: Math.round(((idx + 1) / chunkRanges.length) * 100),
              currentChunk: idx + 1,
              totalChunks: chunkRanges.length,
              elapsedMs: Math.round(performance.now() - startedMs),
              partialText: rawChunkTexts.join(' '),
            });
          }

          const tokens = buildMonotonicSampleBoundedTokens({
            chunkBuckets,
            sourceSampleRate,
            totalSourceSamples,
          });

          // Reconstruct seam-deduplicated verbatim rawText from tokens if multi-chunk, or exact raw text for single chunk
          const rawText =
            chunkRanges.length === 1
              ? (rawChunkTexts[0] ?? '').trim()
              : tokens.length > 0 &&
                chunkBuckets.every((bucket, index) =>
                  rawChunkTexts[index] === undefined || rawChunkTexts[index].trim().length === 0 || bucket.words.length > 0,
                )
              ? tokens.map((t) => t.rawText).join(' ').trim()
              : rawChunkTexts.join(' ').trim();

          const normalizedText = normalizeCanonicalPersianUtterance(rawText);
          const lang = detectTextLanguageTag(normalizedText || rawText).language;
          const processingTimeMs = Math.max(1, Math.round(performance.now() - startedMs));
          const realTimeFactor =
            durationSec > 0 ? Number(((processingTimeMs / 1000) / durationSec).toFixed(4)) : 0;

          const transcript: TranscriptDocument = {
            schemaVersion: 'avp.transcript.v1',
            transcriptVersion: `tr_shahab_${audioSha256.slice(0, 10)}_${Date.now()}`,
            sourceAudioId: request.sourceAudioId,
            sourceAudioHash: audioSha256,
            sampleRate: sourceSampleRate,
            totalSourceSamples,
            language: lang === 'en' ? 'en' : lang === 'fa-en' ? 'fa-en' : 'fa',
            modelId: SHAHAB_ZIPFORMER_MODEL_ID,
            modelVersion: SHAHAB_ZIPFORMER_MODEL_VERSION,
            runtime: 'shahab-zipformer-onnx-cpu',
            rawText,
            normalizedText,
            tokens,
            timestampGranularity: tokens.length > 0 ? 'SEGMENT' : 'NONE',
            realTimeFactor,
            processingTimeMs,
            offlineVerified: true,
            createdAtMs: Date.now(),
          };

          if (request.unloadAfterTranscribe) {
            // Await session release deterministically before returning so memory metrics and lifecycle are truthful
            await this.disposeAdapterLocked();
          }

          const rssAfterMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
          const metrics: ShahabAsrRuntimeMetrics = {
            modelId: SHAHAB_ZIPFORMER_MODEL_ID,
            upstreamModelId: SHAHAB_ZIPFORMER_UPSTREAM_ID,
            runtime: 'shahab-zipformer-onnx-cpu',
            durationSec: Number(durationSec.toFixed(4)),
            processingTimeMs,
            realTimeFactor,
            rssBeforeMb,
            rssAfterMb,
            peakRssMb: Math.max(rssBeforeMb, rssAfterMb),
            tokenCount: tokens.length,
            offlineVerified: true,
          };
          this.lastMetrics = metrics;

          return { transcript, metrics };
        } catch (err) {
          if (err instanceof ShahabZipformerRuntimeError) {
            throw err;
          }
          if (
            err &&
            typeof err === 'object' &&
            'code' in err &&
            (err as { code?: unknown }).code === 'JOB_CANCELLED'
          ) {
            throw new ShahabZipformerRuntimeError(
              'TRANSCRIPTION_CANCELLED',
              'عملیات رونویسی لغو شد.',
            );
          }
          throw err;
        } finally {
          this.activeJobCount = Math.max(0, this.activeJobCount - 1);
        }
      });
    } finally {
      this.pendingJobCount = Math.max(0, this.pendingJobCount - 1);
      if (this.pendingJobCount === 0 && this.activeJobCount === 0 && this.adapter) {
        this.scheduleIdleUnload();
      }
    }
  }
}
