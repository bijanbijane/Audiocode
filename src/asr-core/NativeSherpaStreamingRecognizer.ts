/**
 * AVAPARDAZ — PHASE 1C-B: NATIVE SHERPA STREAMING RECOGNITION
 *
 * Connects streaming audio input (PCM16 or PCM32 Float32, arbitrary sample rate & channel count,
 * arbitrary/irregular chunk sizes) to the real local Sherpa-ONNX C++ inference runtime
 * (`sherpa-onnx-streaming-bridge` linked against `libsherpa-onnx-c-api.so` + `libonnxruntime.so`,
 * with automatic fallback to `sherpa-onnx-offline` CLI) without materializing the full audio in RAM.
 *
 * Architectural Guarantees:
 * 1. Bounded O(1) memory across 10m, 30m, and 60m streams:
 *    - Odd-byte / partial-frame remainder buffer (<= 64 B)
 *    - Stateful stereo downmix / Phase Guard + StreamingKaiserSincResampler -> 16 kHz Mono Float32
 *    - Bounded pending audio queue (`maxPendingQueueBytes`, default 2 MiB) with explicit
 *      `WAIT_DRAIN` or `REJECT_OVERLOAD` backpressure (never drops audio silently)
 *    - Active utterance buffer capped at `maxUtteranceDurationSec` (default 14s) and deterministically
 *      released immediately upon emitting each Final segment result.
 * 2. Real Native Sherpa-ONNX inference (`Reza2kn/Shenava-Rizeh` INT8 FastConformer CTC):
 *    - Emits monotonic `PARTIAL` recognition events during active speech
 *    - Emits `FINAL` recognition events at acoustic silence endpoints, max-window valleys, and stream end
 *    - Preserves real BPE token timestamps (`WORD` granularity when tokens+timestamps exist, `SEGMENT` otherwise)
 *    - Suppresses stale/out-of-order partials after a segment is finalized
 * 3. Full lifecycle & resource safety:
 *    - Real `AbortSignal` cancellation and mid-stream disconnect handling
 *    - Separate Node.js process RSS vs Native C++ child process `/proc/<pid>/status` VmRSS measurement
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DetectedLanguageTag,
  NormalizationProfileId,
  TimestampGranularity,
} from './CoreAsrContracts';
import { detectTextLanguageTag, normalizeWithProfile } from './CoreNormalizationAndLanguage';
import { StreamingKaiserSincResampler } from '../engine/resampler';
import { CANONICAL_TARGET_SAMPLE_RATE_HZ } from './StreamingCanonicalAudioIngestion';
import {
  LocalSherpaNeuralEngine,
  type InstalledLocalNeuralModel,
} from './LocalSherpaNeuralEngine';

export type StreamingInputSampleFormat = 'PCM16' | 'PCM32_FLOAT';

export type StreamingBackpressurePolicy = 'WAIT_DRAIN' | 'REJECT_OVERLOAD';

export type NativeStreamingSessionState =
  | 'CREATED'
  | 'INITIALIZING_NATIVE'
  | 'READY'
  | 'STREAMING'
  | 'FLUSHING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface StreamingRecognitionWordTiming {
  readonly wordId: string;
  readonly word: string;
  readonly normalizedWord: string;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly confidence: number | null;
}

export interface NativeSherpaStreamingEvent {
  readonly eventId: string;
  readonly sessionId: string;
  readonly sourceAudioId: string;
  readonly seq: number;
  readonly type: 'PARTIAL' | 'FINAL';
  readonly isFinal: boolean;
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly revision: number;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly rawText: string;
  readonly normalizedByProfile: Readonly<Record<NormalizationProfileId, string>>;
  readonly language: DetectedLanguageTag;
  readonly timestampGranularity: TimestampGranularity;
  readonly words: readonly StreamingRecognitionWordTiming[];
  readonly tokens: readonly string[];
  readonly tokenTimestampsSec: readonly number[];
  readonly confidence: number | null;
  readonly decodeLatencyMs: number;
  readonly emittedAtMs: number;
}

export interface NativeSherpaStreamingMetrics {
  readonly sessionId: string;
  readonly sourceAudioId: string;
  readonly modelId: string;
  readonly firstPartialResultLatencyMs: number | null;
  readonly finalResultLatencyMs: number;
  readonly realTimeFactor: number;
  readonly audioDurationSec: number;
  readonly processingDurationSec: number;
  readonly memoryBeforeMb: number;
  readonly memoryAfterMb: number;
  readonly peakRssMb: number;
  readonly nodeRssBeforeMb: number;
  readonly nodeRssAfterMb: number;
  readonly nodePeakRssMb: number;
  readonly nativeChildRssBeforeMb: number;
  readonly nativeChildRssAfterMb: number;
  readonly nativeChildPeakRssMb: number;
  readonly peakPendingQueueBytes: number;
  readonly peakActiveUtteranceBytes: number;
  readonly processedChunks: number;
  readonly droppedChunks: number;
  readonly duplicateChunks: number;
  readonly backpressureEvents: number;
  readonly backpressureWaitMs: number;
  readonly partialEventsEmitted: number;
  readonly finalEventsEmitted: number;
  readonly stalePartialsSuppressed: number;
  readonly nativeDecodeCalls: number;
  readonly errorCount: number;
  readonly totalSourceSamples: number;
  readonly totalCanonicalSamples16k: number;
}

export interface NativeSherpaStreamingConfig {
  readonly sessionId?: string;
  readonly sourceAudioId?: string;
  readonly sourceSampleRateHz: number;
  readonly sourceChannels: number;
  readonly inputFormat: StreamingInputSampleFormat;
  readonly modelId?: string;
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly numThreads?: number;
  /** Maximum pending queued audio bytes before backpressure triggers (default: 2 MiB) */
  readonly maxPendingQueueBytes?: number;
  readonly backpressurePolicy?: StreamingBackpressurePolicy;
  /** Emit partial recognition every N milliseconds of active speech (default: 480ms, 0 to disable) */
  readonly partialIntervalMs?: number;
  /** Minimum speech duration before silence endpoint can finalize a segment (default: 550ms) */
  readonly minUtteranceDurationMs?: number;
  /** Continuous silence duration to trigger utterance endpoint finalization (default: 450ms) */
  readonly minSilenceEndpointMs?: number;
  /** Maximum active utterance window before valley-split finalization (default: 14s) */
  readonly maxUtteranceDurationSec?: number;
  /** Overlap context in seconds preserved across forced max-window splits (default: 0.4s) */
  readonly splitOverlapSec?: number;
  /** Speech detection RMS threshold in dBFS (default: -50 dBFS) */
  readonly speechThresholdDbfs?: number;
  /** Optional dedicated native worker process vs shared persistent worker (default: true = shared pool) */
  readonly useSharedNativeWorker?: boolean;
  /** Optional artificial native decode delay (ms) for deterministic backpressure testing */
  readonly simulateDecodeDelayMs?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: NativeSherpaStreamingEvent) => void;
}

interface RawSherpaJsonResult {
  text?: string;
  timestamps?: number[];
  tokens?: string[];
  words?: string[];
  lang?: string;
}

function buildNormalizationProfiles(rawText: string): Record<NormalizationProfileId, string> {
  const trimmed = rawText.trim();
  return {
    RAW_UNMODIFIED: trimmed,
    'FA-STRICT-V1': normalizeWithProfile(trimmed, 'FA-STRICT-V1'),
    'FA-RELAXED-V1': normalizeWithProfile(trimmed, 'FA-RELAXED-V1'),
    'EN-NORM-V1': normalizeWithProfile(trimmed, 'EN-NORM-V1'),
    'MIXED-NORM-V1': normalizeWithProfile(trimmed, 'MIXED-NORM-V1'),
  };
}

function readLinuxProcRssBytes(pid: number | undefined): number {
  if (!pid || process.platform !== 'linux') return 0;
  try {
    const fd = fs.openSync(`/proc/${pid}/status`, 'r');
    try {
      const buf = Buffer.allocUnsafe(2048);
      const n = fs.readSync(fd, buf, 0, buf.byteLength, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const m = text.match(/VmRSS:\s+(\d+)\s+kB/i);
      return m ? Number(m[1]) * 1024 : 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/**
 * Reconstructs word-level timing spans from Sherpa-ONNX SentencePiece BPE tokens & per-token timestamps.
 * Never fabricates word timestamps if `tokens` or `timestamps` are absent or mismatched.
 */
export function buildStreamingWordsFromSherpaTokens(params: {
  readonly segmentId: string;
  readonly tokens: readonly string[] | undefined;
  readonly timestamps: readonly number[] | undefined;
  readonly windowStartSample16k: number;
  readonly windowEndSample16k: number;
  readonly sourceSampleRateHz: number;
  readonly totalSourceSamplesBound?: number;
}): StreamingRecognitionWordTiming[] {
  const {
    segmentId,
    tokens,
    timestamps,
    windowStartSample16k,
    windowEndSample16k,
    sourceSampleRateHz,
    totalSourceSamplesBound,
  } = params;
  if (
    !Array.isArray(tokens) ||
    !Array.isArray(timestamps) ||
    tokens.length === 0 ||
    tokens.length !== timestamps.length
  ) {
    return [];
  }

  const rawWords: Array<{
    text: string;
    relStartSec: number;
    relEndSec: number;
  }> = [];

  let currentWord = '';
  let currentStartSec = 0;
  let lastTokenSec = 0;

  for (let i = 0; i < tokens.length; i++) {
    const rawTok = String(tokens[i] ?? '');
    const tSec = Math.max(0, Number(timestamps[i] ?? 0));
    const startsNewWord = rawTok.startsWith(' ') || rawTok.startsWith('▁');
    const cleanPiece = rawTok.replace(/^[ ▁]+/, '');
    if (!cleanPiece) continue;

    if (startsNewWord && currentWord.length > 0) {
      const endSec = Math.max(currentStartSec + 0.04, tSec);
      rawWords.push({
        text: currentWord,
        relStartSec: currentStartSec,
        relEndSec: endSec,
      });
      currentWord = cleanPiece;
      currentStartSec = tSec;
    } else if (currentWord.length === 0) {
      currentWord = cleanPiece;
      currentStartSec = tSec;
    } else {
      currentWord += cleanPiece;
    }
    lastTokenSec = tSec;
  }

  if (currentWord.length > 0) {
    const windowDurSec = Math.max(0.04, (windowEndSample16k - windowStartSample16k) / 16000);
    const endSec = Math.min(windowDurSec, Math.max(currentStartSec + 0.08, lastTokenSec + 0.12));
    rawWords.push({
      text: currentWord,
      relStartSec: currentStartSec,
      relEndSec: Math.max(currentStartSec + 0.04, endSec),
    });
  }

  const out: StreamingRecognitionWordTiming[] = [];
  let prevEnd16k = windowStartSample16k;

  for (let i = 0; i < rawWords.length; i++) {
    const rw = rawWords[i];
    const absStart16k = Math.max(
      prevEnd16k,
      Math.min(
        windowEndSample16k - 1,
        windowStartSample16k + Math.round(rw.relStartSec * CANONICAL_TARGET_SAMPLE_RATE_HZ),
      ),
    );
    const absEnd16k = Math.max(
      absStart16k + 1,
      Math.min(
        windowEndSample16k,
        windowStartSample16k + Math.round(rw.relEndSec * CANONICAL_TARGET_SAMPLE_RATE_HZ),
      ),
    );
    prevEnd16k = absEnd16k;

    const rawSrcStart = Math.round(
      (absStart16k * sourceSampleRateHz) / CANONICAL_TARGET_SAMPLE_RATE_HZ,
    );
    const rawSrcEnd = Math.max(
      rawSrcStart + 1,
      Math.round((absEnd16k * sourceSampleRateHz) / CANONICAL_TARGET_SAMPLE_RATE_HZ),
    );
    const sourceStartSample =
      totalSourceSamplesBound !== undefined
        ? Math.min(Math.max(0, totalSourceSamplesBound - 1), rawSrcStart)
        : rawSrcStart;
    const sourceEndSample =
      totalSourceSamplesBound !== undefined
        ? Math.max(sourceStartSample + 1, Math.min(totalSourceSamplesBound, rawSrcEnd))
        : rawSrcEnd;

    out.push({
      wordId: `${segmentId}_w${i}`,
      word: rw.text,
      normalizedWord: normalizeWithProfile(rw.text, 'FA-STRICT-V1') || rw.text,
      startSample16k: absStart16k,
      endSample16k: absEnd16k,
      sourceStartSample,
      sourceEndSample,
      startSec: Number((absStart16k / CANONICAL_TARGET_SAMPLE_RATE_HZ).toFixed(6)),
      endSec: Number((absEnd16k / CANONICAL_TARGET_SAMPLE_RATE_HZ).toFixed(6)),
      confidence: null,
    });
  }

  return out;
}

/**
 * Persistent Native C++ Sherpa-ONNX Bridge Worker Client.
 * Manages a single child process running `sherpa-onnx-streaming-bridge` with the ONNX model
 * loaded in C++ memory, serializing frame decode requests over binary stdin/stdout.
 */
export class PersistentNativeSherpaBridgeProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private isReady = false;
  private nextRequestId = 1;
  private stdoutRemainder = '';
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (res: { decodeTimeMs: number; result: RawSherpaJsonResult }) => void;
      reject: (err: Error) => void;
    }
  >();
  private startupPromise: Promise<void> | null = null;
  private readonly modelKey: string;

  constructor(
    private readonly params: {
      readonly bridgeBinaryPath: string;
      readonly libDir: string | null;
      readonly model: InstalledLocalNeuralModel;
      readonly numThreads: number;
      readonly languageHint?: string;
    },
  ) {
    this.modelKey = `${params.model.modelId}:${params.numThreads}`;
  }

  public getPid(): number | undefined {
    return this.child?.pid;
  }

  public getRssBytes(): number {
    return readLinuxProcRssBytes(this.child?.pid);
  }

  public isAlive(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null && this.isReady);
  }

  public async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.isAlive()) return;
    if (this.startupPromise) return this.startupPromise;

    this.startupPromise = new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        this.startupPromise = null;
        reject(new Error('STREAMING_RECOGNITION_CANCELLED'));
        return;
      }

      const args = [...this.params.model.extraCliArgs, `--num-threads=${this.params.numThreads}`];
      if (
        this.params.model.architecture === 'whisper' &&
        (this.params.languageHint === 'fa' || this.params.languageHint === 'en')
      ) {
        args.push(`--whisper-language=${this.params.languageHint}`);
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        http_proxy: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      };
      if (this.params.libDir) {
        env.LD_LIBRARY_PATH = `${this.params.libDir}:${env.LD_LIBRARY_PATH ?? ''}`;
      }

      const child = spawn(this.params.bridgeBinaryPath, args, {
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.isReady = false;
      this.stdoutRemainder = '';

      let stderrLog = '';
      let startupSettled = false;

      child.stderr.on('data', (chunk: Buffer) => {
        stderrLog += chunk.toString('utf8');
        if (stderrLog.length > 4096) {
          stderrLog = stderrLog.slice(-4096);
        }
      });

      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutRemainder += chunk.toString('utf8');
        let nlIdx: number;
        while ((nlIdx = this.stdoutRemainder.indexOf('\n')) !== -1) {
          const line = this.stdoutRemainder.slice(0, nlIdx).trim();
          this.stdoutRemainder = this.stdoutRemainder.slice(nlIdx + 1);
          if (!line.startsWith('{')) continue;
          try {
            const msg = JSON.parse(line) as {
              type?: string;
              requestId?: number;
              decodeTimeMs?: number;
              result?: RawSherpaJsonResult;
              message?: string;
            };
            if (msg.type === 'READY') {
              this.isReady = true;
              if (!startupSettled) {
                startupSettled = true;
                this.startupPromise = null;
                resolve();
              }
            } else if (msg.type === 'RESULT' && typeof msg.requestId === 'number') {
              const pending = this.pendingRequests.get(msg.requestId);
              if (pending) {
                this.pendingRequests.delete(msg.requestId);
                pending.resolve({
                  decodeTimeMs: Number(msg.decodeTimeMs ?? 0),
                  result: msg.result ?? { text: '' },
                });
              }
            } else if (msg.type === 'ERROR' && typeof msg.requestId === 'number') {
              const pending = this.pendingRequests.get(msg.requestId);
              if (pending) {
                this.pendingRequests.delete(msg.requestId);
                pending.reject(new Error(`NATIVE_SHERPA_DECODE_ERROR: ${msg.message ?? 'Unknown error'}`));
              }
            }
          } catch {
            // ignore non-JSON diagnostic line
          }
        }
      });

      child.on('error', (err) => {
        this.isReady = false;
        this.startupPromise = null;
        if (!startupSettled) {
          startupSettled = true;
          reject(err);
        }
        for (const [, req] of this.pendingRequests) {
          req.reject(err);
        }
        this.pendingRequests.clear();
      });

      child.on('close', (code) => {
        this.isReady = false;
        this.startupPromise = null;
        this.child = null;
        const err = new Error(
          `NATIVE_SHERPA_WORKER_EXITED_${code ?? 'SIGNAL'}: ${stderrLog.trim() || 'Worker closed'}`,
        );
        if (!startupSettled) {
          startupSettled = true;
          reject(err);
        }
        for (const [, req] of this.pendingRequests) {
          req.reject(err);
        }
        this.pendingRequests.clear();
      });
    });

    return this.startupPromise;
  }

  public async decodeSamples16k(
    samples16k: Float32Array,
    isFinal: boolean,
    signal?: AbortSignal,
  ): Promise<{ decodeTimeMs: number; result: RawSherpaJsonResult }> {
    await this.ensureStarted(signal);
    if (!this.child || !this.isReady) {
      throw new Error('NATIVE_SHERPA_WORKER_NOT_READY');
    }
    if (signal?.aborted) {
      throw new Error('STREAMING_RECOGNITION_CANCELLED');
    }

    const requestId = this.nextRequestId++;
    const header = Buffer.allocUnsafe(16);
    header.writeUInt32LE(0x41565053, 0); // "AVPS"
    header.writeUInt32LE(requestId, 4);
    header.writeUInt32LE(isFinal ? 1 : 0, 8);
    header.writeUInt32LE(samples16k.length, 12);

    const payload = Buffer.from(
      samples16k.buffer,
      samples16k.byteOffset,
      samples16k.byteLength,
    );

    return new Promise<{ decodeTimeMs: number; result: RawSherpaJsonResult }>((resolve, reject) => {
      const onAbort = () => {
        this.pendingRequests.delete(requestId);
        reject(new Error('STREAMING_RECOGNITION_CANCELLED'));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pendingRequests.set(requestId, {
        resolve: (res) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(res);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      });

      try {
        this.child!.stdin.write(header);
        if (payload.byteLength > 0) {
          this.child!.stdin.write(payload);
        }
      } catch (err) {
        this.pendingRequests.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public dispose(): void {
    if (!this.child) return;
    try {
      const shutdownHeader = Buffer.alloc(16);
      shutdownHeader.writeUInt32LE(0x41565053, 0);
      shutdownHeader.writeUInt32LE(0, 4);
      shutdownHeader.writeUInt32LE(2, 8); // flag bit 1 = shutdown
      shutdownHeader.writeUInt32LE(0, 12);
      this.child.stdin.write(shutdownHeader);
      this.child.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.child = null;
    this.isReady = false;
    for (const [, req] of this.pendingRequests) {
      req.reject(new Error('NATIVE_SHERPA_WORKER_DISPOSED'));
    }
    this.pendingRequests.clear();
  }
}

const SHARED_NATIVE_WORKERS = new Map<string, PersistentNativeSherpaBridgeProcess>();

export function disposeAllSharedNativeSherpaWorkers(): void {
  for (const [, worker] of SHARED_NATIVE_WORKERS) {
    worker.dispose();
  }
  SHARED_NATIVE_WORKERS.clear();
}

function ensureStreamingBridgeBinary(runtimeBinDir: string): string | null {
  const bridgeBin = path.join(runtimeBinDir, 'sherpa-onnx-streaming-bridge');
  if (fs.existsSync(bridgeBin)) {
    return bridgeBin;
  }

  const runtimeRoot = path.dirname(runtimeBinDir);
  const includeDir = path.join(runtimeRoot, 'include');
  const libDir = path.join(runtimeRoot, 'lib');
  const sourcePath = path.resolve(process.cwd(), 'src/asr-core/native/sherpa_onnx_streaming_bridge.cc');

  if (
    fs.existsSync(sourcePath) &&
    fs.existsSync(path.join(includeDir, 'sherpa-onnx/c-api/c-api.h')) &&
    fs.existsSync(path.join(libDir, 'libsherpa-onnx-c-api.so'))
  ) {
    const res = spawnSync(
      'g++',
      [
        '-O3',
        '-std=c++17',
        sourcePath,
        `-I${includeDir}`,
        `-L${libDir}`,
        `-Wl,-rpath,${libDir}`,
        '-lsherpa-onnx-c-api',
        '-lonnxruntime',
        '-o',
        bridgeBin,
      ],
      { stdio: 'ignore' },
    );
    if (res.status === 0 && fs.existsSync(bridgeBin)) {
      fs.chmodSync(bridgeBin, 0o755);
      return bridgeBin;
    }
  }
  return null;
}

/**
 * Stateful Native Sherpa Streaming Recognizer Session (Phase 1C-B).
 */
export class NativeSherpaStreamingRecognizer {
  public readonly sessionId: string;
  public readonly sourceAudioId: string;
  public readonly config: Required<
    Pick<
      NativeSherpaStreamingConfig,
      | 'sourceSampleRateHz'
      | 'sourceChannels'
      | 'inputFormat'
      | 'maxPendingQueueBytes'
      | 'backpressurePolicy'
      | 'partialIntervalMs'
      | 'minUtteranceDurationMs'
      | 'minSilenceEndpointMs'
      | 'maxUtteranceDurationSec'
      | 'splitOverlapSec'
      | 'speechThresholdDbfs'
      | 'useSharedNativeWorker'
      | 'simulateDecodeDelayMs'
    >
  >;

  private state: NativeStreamingSessionState = 'CREATED';
  private readonly engine: LocalSherpaNeuralEngine;
  private model: InstalledLocalNeuralModel | null = null;
  private worker: PersistentNativeSherpaBridgeProcess | null = null;
  private ownsDedicatedWorker = false;

  // Frame alignment & resampling state
  private readonly bytesPerInputSample: number;
  private readonly bytesPerInputFrame: number;
  private frameRemainder: Buffer = Buffer.alloc(0);
  private readonly resampler: StreamingKaiserSincResampler | null;

  // Streaming stereo Phase Guard inspection state
  private stereoSumSqL = 0;
  private stereoSumSqR = 0;
  private stereoSumLR = 0;
  private stereoInspectedFrames = 0;
  private stereoPolicy: 'EQUAL_POWER_AVG' | 'LEFT_PRIMARY_PHASE_GUARD' | 'DOMINANT_ACTIVE_CHANNEL' =
    'EQUAL_POWER_AVG';

  // Bounded queue & backpressure governance
  private readonly pendingQueue: Array<{
    readonly chunkId: string;
    readonly sourceFrameCount: number;
    readonly canonicalSamples16k: Float32Array;
    readonly byteLength: number;
  }> = [];
  private currentPendingQueueBytes = 0;
  private peakPendingQueueBytes = 0;
  private drainResolvers: Array<() => void> = [];
  private processingQueuePromise: Promise<void> | null = null;
  private readonly seenChunkIds = new Set<string>();

  // Rolling pre-speech & active utterance buffer (bounded O(1) memory)
  private readonly preSpeechMaxSamples16k = 3200; // 200ms pre-roll
  private preSpeechRing = new Float32Array(0);
  private activeUtteranceChunks: Float32Array[] = [];
  private activeUtteranceSampleCount16k = 0;
  private activeUtteranceStartSample16k = 0;
  private activeUtteranceSpeechSamples16k = 0;
  private activeUtteranceTrailingSilenceSamples16k = 0;
  private samplesSinceLastPartial16k = 0;
  private inActiveSpeech = false;
  private peakActiveUtteranceBytes = 0;

  // Monotonic event & segment sequencing
  private nextEventSeq = 1;
  private currentSegmentIndex = 0;
  private currentSegmentRevision = 0;
  private readonly finalizedSegmentIndices = new Set<number>();
  private readonly emittedEvents: NativeSherpaStreamingEvent[] = [];

  // Timeline & telemetry counters
  private totalSourceSamples = 0;
  private totalCanonicalSamples16k = 0;
  private processedChunks = 0;
  private droppedChunks = 0;
  private duplicateChunks = 0;
  private backpressureEvents = 0;
  private backpressureWaitMs = 0;
  private partialEventsEmitted = 0;
  private finalEventsEmitted = 0;
  private stalePartialsSuppressed = 0;
  private nativeDecodeCalls = 0;
  private errorCount = 0;

  private sessionStartedAtMs = 0;
  private firstChunkFedAtMs: number | null = null;
  private firstPartialResultLatencyMs: number | null = null;
  private finalResultLatencyMs = 0;
  private nodeRssBeforeMb = 0;
  private nodeRssAfterMb = 0;
  private nodePeakRssMb = 0;
  private nativeChildRssBeforeMb = 0;
  private nativeChildRssAfterMb = 0;
  private nativeChildPeakRssMb = 0;

  private readonly externalSignal?: AbortSignal;
  private readonly internalAbort = new AbortController();
  private readonly onEventCallback?: (event: NativeSherpaStreamingEvent) => void;
  private simulateNativeCrashOnNextDecode = false;

  constructor(
    config: NativeSherpaStreamingConfig,
    engine?: LocalSherpaNeuralEngine,
  ) {
    if (!Number.isFinite(config.sourceSampleRateHz) || config.sourceSampleRateHz < 8000 || config.sourceSampleRateHz > 192000) {
      throw new Error(`INVALID_STREAM_SAMPLE_RATE: Unsupported sample rate ${config.sourceSampleRateHz} Hz.`);
    }
    if (!Number.isInteger(config.sourceChannels) || config.sourceChannels < 1 || config.sourceChannels > 8) {
      throw new Error(`INVALID_STREAM_CHANNELS: Unsupported channel count ${config.sourceChannels}.`);
    }

    this.sessionId = config.sessionId ?? `stream_${crypto.randomBytes(8).toString('hex')}`;
    this.sourceAudioId = config.sourceAudioId ?? `src_${this.sessionId}`;
    this.engine = engine ?? new LocalSherpaNeuralEngine();
    this.externalSignal = config.signal;
    this.onEventCallback = config.onEvent;

    this.config = {
      sourceSampleRateHz: Math.round(config.sourceSampleRateHz),
      sourceChannels: config.sourceChannels,
      inputFormat: config.inputFormat,
      maxPendingQueueBytes: Math.max(4096, config.maxPendingQueueBytes ?? 2 * 1024 * 1024),
      backpressurePolicy: config.backpressurePolicy ?? 'WAIT_DRAIN',
      partialIntervalMs: Math.max(0, config.partialIntervalMs ?? 480),
      minUtteranceDurationMs: Math.max(160, config.minUtteranceDurationMs ?? 550),
      minSilenceEndpointMs: Math.max(120, config.minSilenceEndpointMs ?? 450),
      maxUtteranceDurationSec: Math.max(2, Math.min(25, config.maxUtteranceDurationSec ?? 14)),
      splitOverlapSec: Math.max(0, Math.min(2, config.splitOverlapSec ?? 0.35)),
      speechThresholdDbfs: config.speechThresholdDbfs ?? -50,
      useSharedNativeWorker: config.useSharedNativeWorker ?? true,
      simulateDecodeDelayMs: Math.max(0, config.simulateDecodeDelayMs ?? 0),
    };

    this.bytesPerInputSample = this.config.inputFormat === 'PCM32_FLOAT' ? 4 : 2;
    this.bytesPerInputFrame = this.bytesPerInputSample * this.config.sourceChannels;
    this.resampler =
      this.config.sourceSampleRateHz === CANONICAL_TARGET_SAMPLE_RATE_HZ
        ? null
        : new StreamingKaiserSincResampler(
            this.config.sourceSampleRateHz,
            CANONICAL_TARGET_SAMPLE_RATE_HZ,
          );

    if (this.externalSignal) {
      if (this.externalSignal.aborted) {
        this.cancel('ABORTED_BEFORE_START');
      } else {
        this.externalSignal.addEventListener('abort', () => {
          this.cancel('ABORT_SIGNAL_TRIGGERED');
        }, { once: true });
      }
    }
  }

  public getState(): NativeStreamingSessionState {
    return this.state;
  }

  public getEmittedEvents(): readonly NativeSherpaStreamingEvent[] {
    return this.emittedEvents;
  }

  /** Test hook for simulating native engine failure during active streaming */
  public injectNativeEngineFailureOnNextDecode(): void {
    this.simulateNativeCrashOnNextDecode = true;
  }

  private sampleRss(): void {
    const nodeMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    if (nodeMb > this.nodePeakRssMb) {
      this.nodePeakRssMb = nodeMb;
    }
    const childBytes = this.worker?.getRssBytes() ?? 0;
    const childMb = Number((childBytes / (1024 * 1024)).toFixed(2));
    if (childMb > this.nativeChildPeakRssMb) {
      this.nativeChildPeakRssMb = childMb;
    }
  }

  public async start(options?: {
    readonly modelId?: string;
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly numThreads?: number;
  }): Promise<void> {
    if (this.state === 'CANCELLED') {
      throw new Error('STREAMING_RECOGNITION_CANCELLED');
    }
    if (this.state !== 'CREATED') {
      return;
    }

    this.state = 'INITIALIZING_NATIVE';
    this.sessionStartedAtMs = performance.now();

    const status = this.engine.getStatus();
    if (!status.binaryPath) {
      this.state = 'FAILED';
      this.errorCount++;
      throw new Error('LOCAL_NEURAL_RUNTIME_UNAVAILABLE: sherpa-onnx binary not found.');
    }

    const model = this.engine.selectModel(options?.modelId, options?.languageHint ?? 'fa');
    if (!model) {
      this.state = 'FAILED';
      this.errorCount++;
      throw new Error('LOCAL_MODEL_NOT_INSTALLED: No verified local Sherpa-ONNX model found.');
    }
    this.model = model;

    const runtimeBinDir = path.dirname(status.binaryPath);
    const runtimeRoot = path.dirname(runtimeBinDir);
    const libDir = fs.existsSync(path.join(runtimeRoot, 'lib'))
      ? path.join(runtimeRoot, 'lib')
      : null;

    const bridgeBin = ensureStreamingBridgeBinary(runtimeBinDir);
    if (!bridgeBin) {
      this.state = 'FAILED';
      this.errorCount++;
      throw new Error('NATIVE_STREAMING_BRIDGE_UNAVAILABLE: Could not locate or compile sherpa-onnx-streaming-bridge.');
    }

    const numThreads = Math.max(1, Math.min(8, options?.numThreads ?? 2));
    const workerKey = `${model.modelId}:${numThreads}`;

    if (this.config.useSharedNativeWorker) {
      let shared = SHARED_NATIVE_WORKERS.get(workerKey);
      if (!shared) {
        shared = new PersistentNativeSherpaBridgeProcess({
          bridgeBinaryPath: bridgeBin,
          libDir,
          model,
          numThreads,
          languageHint: options?.languageHint ?? 'fa',
        });
        SHARED_NATIVE_WORKERS.set(workerKey, shared);
      }
      this.worker = shared;
      this.ownsDedicatedWorker = false;
    } else {
      this.worker = new PersistentNativeSherpaBridgeProcess({
        bridgeBinaryPath: bridgeBin,
        libDir,
        model,
        numThreads,
        languageHint: options?.languageHint ?? 'fa',
      });
      this.ownsDedicatedWorker = true;
    }

    await this.worker.ensureStarted(this.internalAbort.signal);

    this.nodeRssBeforeMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    this.nodePeakRssMb = this.nodeRssBeforeMb;
    this.nativeChildRssBeforeMb = Number(((this.worker.getRssBytes() || 0) / (1024 * 1024)).toFixed(2));
    this.nativeChildPeakRssMb = this.nativeChildRssBeforeMb;

    this.state = 'READY';
  }

  /**
   * Feeds a raw audio chunk (`Buffer`, `Uint8Array`, `Int16Array`, or `Float32Array`)
   * into the streaming recognizer with frame alignment, resampling, and backpressure governance.
   */
  public async feedAudioChunk(
    chunk: Buffer | Uint8Array | Int16Array | Float32Array,
    options?: { readonly chunkId?: string },
  ): Promise<{
    readonly accepted: boolean;
    readonly duplicateIgnored: boolean;
    readonly canonicalSamplesProduced: number;
    readonly backpressureApplied: boolean;
  }> {
    if (this.state === 'CANCELLED' || this.internalAbort.signal.aborted) {
      throw new Error('STREAMING_RECOGNITION_CANCELLED');
    }
    if (this.state === 'COMPLETED' || this.state === 'FLUSHING') {
      throw new Error('STREAMING_SESSION_ALREADY_FINALIZED');
    }
    if (this.state === 'FAILED') {
      throw new Error('STREAMING_SESSION_FAILED');
    }
    if (this.state === 'CREATED') {
      await this.start();
    }
    this.state = 'STREAMING';

    if (this.firstChunkFedAtMs === null) {
      this.firstChunkFedAtMs = performance.now();
    }

    // Duplicate chunk detection & idempotency guard
    const chunkId = options?.chunkId ?? `chk_${this.processedChunks + 1}`;
    if (options?.chunkId && this.seenChunkIds.has(options.chunkId)) {
      this.duplicateChunks++;
      return {
        accepted: false,
        duplicateIgnored: true,
        canonicalSamplesProduced: 0,
        backpressureApplied: false,
      };
    }
    if (options?.chunkId) {
      this.seenChunkIds.add(options.chunkId);
    }

    // Convert typed arrays to raw byte buffer view without copying when possible
    let rawBytes: Buffer;
    if (Buffer.isBuffer(chunk)) {
      rawBytes = chunk;
    } else if (chunk instanceof Uint8Array) {
      rawBytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else if (chunk instanceof Int16Array) {
      if (this.config.inputFormat !== 'PCM16') {
        throw new Error('STREAM_FORMAT_MISMATCH: Expected PCM32_FLOAT but received Int16Array.');
      }
      rawBytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else if (chunk instanceof Float32Array) {
      if (this.config.inputFormat !== 'PCM32_FLOAT') {
        throw new Error('STREAM_FORMAT_MISMATCH: Expected PCM16 but received Float32Array.');
      }
      rawBytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      throw new Error('INVALID_AUDIO_CHUNK_TYPE');
    }

    if (rawBytes.byteLength === 0) {
      this.processedChunks++;
      return {
        accepted: true,
        duplicateIgnored: false,
        canonicalSamplesProduced: 0,
        backpressureApplied: false,
      };
    }

    // Combine with any sub-frame remainder bytes (< bytesPerInputFrame, max 32 bytes)
    let workingBuf: Buffer;
    if (this.frameRemainder.byteLength > 0) {
      workingBuf = Buffer.concat([this.frameRemainder, rawBytes]);
    } else {
      workingBuf = rawBytes;
    }

    const alignedFrames = Math.floor(workingBuf.byteLength / this.bytesPerInputFrame);
    const alignedBytes = alignedFrames * this.bytesPerInputFrame;
    const leftoverBytes = workingBuf.byteLength - alignedBytes;

    if (leftoverBytes > 0) {
      this.frameRemainder = Buffer.from(workingBuf.subarray(alignedBytes));
    } else if (this.frameRemainder.byteLength > 0) {
      this.frameRemainder = Buffer.alloc(0);
    }

    if (alignedFrames === 0) {
      this.processedChunks++;
      return {
        accepted: true,
        duplicateIgnored: false,
        canonicalSamplesProduced: 0,
        backpressureApplied: false,
      };
    }

    // Decode & downmix aligned frames into Mono Float32 at sourceSampleRateHz
    const monoSource = this.decodeAndDownmixFrames(workingBuf, alignedFrames);
    const canonical16k = this.resampler ? this.resampler.pushChunk(monoSource) : monoSource;
    const itemBytes = canonical16k.byteLength;

    // Backpressure check before enqueuing
    let backpressureApplied = false;
    if (
      this.currentPendingQueueBytes + itemBytes > this.config.maxPendingQueueBytes &&
      this.pendingQueue.length > 0
    ) {
      this.backpressureEvents++;
      backpressureApplied = true;

      if (this.config.backpressurePolicy === 'REJECT_OVERLOAD') {
        this.droppedChunks++;
        this.errorCount++;
        throw new Error(
          `STREAM_BACKPRESSURE_OVERLOAD: Pending queue (${this.currentPendingQueueBytes + itemBytes} B) exceeds ceiling (${this.config.maxPendingQueueBytes} B).`,
        );
      }

      // WAIT_DRAIN policy: pause producer until consumer drains queue below limit
      const tWait0 = performance.now();
      while (
        this.currentPendingQueueBytes + itemBytes > this.config.maxPendingQueueBytes &&
        this.pendingQueue.length > 0 &&
        this.state === 'STREAMING' &&
        !this.internalAbort.signal.aborted
      ) {
        await new Promise<void>((resolve) => {
          this.drainResolvers.push(resolve);
        });
      }
      this.backpressureWaitMs += Number((performance.now() - tWait0).toFixed(2));

      if ((this.state as NativeStreamingSessionState) === 'CANCELLED' || this.internalAbort.signal.aborted) {
        throw new Error('STREAMING_RECOGNITION_CANCELLED');
      }
    }

    this.pendingQueue.push({
      chunkId,
      sourceFrameCount: alignedFrames,
      canonicalSamples16k: canonical16k,
      byteLength: itemBytes,
    });
    this.currentPendingQueueBytes += itemBytes;
    if (this.currentPendingQueueBytes > this.peakPendingQueueBytes) {
      this.peakPendingQueueBytes = this.currentPendingQueueBytes;
    }
    this.processedChunks++;

    // Trigger asynchronous queue drain loop and await completion unless another drain is active
    await this.ensureQueueDraining();

    return {
      accepted: true,
      duplicateIgnored: false,
      canonicalSamplesProduced: canonical16k.length,
      backpressureApplied,
    };
  }

  private decodeAndDownmixFrames(buf: Buffer, frameCount: number): Float32Array {
    const ch = this.config.sourceChannels;
    const isFloat = this.config.inputFormat === 'PCM32_FLOAT';
    const mono = new Float32Array(frameCount);

    const readSample = (frameIdx: number, channelIdx: number): number => {
      const byteOff = (frameIdx * ch + channelIdx) * this.bytesPerInputSample;
      if (isFloat) {
        const v = buf.readFloatLE(byteOff);
        return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      }
      const s16 = buf.readInt16LE(byteOff);
      return s16 < 0 ? s16 / 32768 : s16 / 32767;
    };

    if (ch === 1) {
      for (let i = 0; i < frameCount; i++) {
        mono[i] = readSample(i, 0);
      }
      return mono;
    }

    // Update running Stereo Phase Guard statistics during the first 1.5s of active signal
    for (let i = 0; i < frameCount; i++) {
      const l = readSample(i, 0);
      const r = readSample(i, 1);

      if (this.stereoInspectedFrames < this.config.sourceSampleRateHz * 2) {
        this.stereoSumSqL += l * l;
        this.stereoSumSqR += r * r;
        this.stereoSumLR += l * r;
        this.stereoInspectedFrames++;

        if (this.stereoInspectedFrames >= Math.min(frameCount, 512)) {
          const rmsL = Math.sqrt(this.stereoSumSqL / this.stereoInspectedFrames);
          const rmsR = Math.sqrt(this.stereoSumSqR / this.stereoInspectedFrames);
          const dbL = 20 * Math.log10(Math.max(rmsL, 1e-9));
          const dbR = 20 * Math.log10(Math.max(rmsR, 1e-9));
          const denom = Math.sqrt(this.stereoSumSqL * this.stereoSumSqR);
          const corr = denom > 1e-12 ? this.stereoSumLR / denom : 0;

          if (Math.abs(dbL - dbR) > 18 && (dbL < -55 || dbR < -55)) {
            this.stereoPolicy = 'DOMINANT_ACTIVE_CHANNEL';
          } else if (corr < -0.35 && dbL > -55 && dbR > -55) {
            this.stereoPolicy = 'LEFT_PRIMARY_PHASE_GUARD';
          } else {
            this.stereoPolicy = 'EQUAL_POWER_AVG';
          }
        }
      }

      if (this.stereoPolicy === 'DOMINANT_ACTIVE_CHANNEL') {
        mono[i] = this.stereoSumSqL >= this.stereoSumSqR ? l : r;
      } else if (this.stereoPolicy === 'LEFT_PRIMARY_PHASE_GUARD') {
        mono[i] = l;
      } else if (ch === 2) {
        mono[i] = (l + r) * 0.5;
      } else {
        let sum = l + r;
        for (let c = 2; c < ch; c++) sum += readSample(i, c);
        mono[i] = sum / ch;
      }
    }

    return mono;
  }

  private notifyDrainWaiters(): void {
    if (this.drainResolvers.length === 0) return;
    const waiters = this.drainResolvers.splice(0, this.drainResolvers.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async ensureQueueDraining(): Promise<void> {
    if (this.processingQueuePromise) {
      return this.processingQueuePromise;
    }
    this.processingQueuePromise = this.drainPendingQueueLoop().finally(() => {
      this.processingQueuePromise = null;
      this.notifyDrainWaiters();
    });
    return this.processingQueuePromise;
  }

  private async drainPendingQueueLoop(): Promise<void> {
    while (this.pendingQueue.length > 0) {
      if (this.state === 'CANCELLED' || this.internalAbort.signal.aborted) {
        this.pendingQueue.length = 0;
        this.currentPendingQueueBytes = 0;
        this.notifyDrainWaiters();
        throw new Error('STREAMING_RECOGNITION_CANCELLED');
      }

      const item = this.pendingQueue.shift()!;
      this.currentPendingQueueBytes = Math.max(0, this.currentPendingQueueBytes - item.byteLength);
      this.notifyDrainWaiters();

      this.totalSourceSamples += item.sourceFrameCount;
      await this.processCanonical16kFrame(item.canonicalSamples16k);
    }
  }

  private appendToActiveUtterance(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.activeUtteranceChunks.push(samples);
    this.activeUtteranceSampleCount16k += samples.length;
    const activeBytes = this.activeUtteranceSampleCount16k * 4;
    if (activeBytes > this.peakActiveUtteranceBytes) {
      this.peakActiveUtteranceBytes = activeBytes;
    }
  }

  private materializeActiveUtteranceSamples(): Float32Array {
    if (this.activeUtteranceChunks.length === 0) return new Float32Array(0);
    if (this.activeUtteranceChunks.length === 1) return this.activeUtteranceChunks[0];
    const joined = new Float32Array(this.activeUtteranceSampleCount16k);
    let offset = 0;
    for (const chunk of this.activeUtteranceChunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    this.activeUtteranceChunks = [joined];
    return joined;
  }

  private clearActiveUtterance(carryOverSamples?: Float32Array, nextStartSample16k?: number): void {
    this.activeUtteranceChunks = [];
    this.activeUtteranceSampleCount16k = 0;
    this.activeUtteranceSpeechSamples16k = 0;
    this.activeUtteranceTrailingSilenceSamples16k = 0;
    this.samplesSinceLastPartial16k = 0;

    if (carryOverSamples && carryOverSamples.length > 0 && nextStartSample16k !== undefined) {
      this.activeUtteranceChunks.push(carryOverSamples);
      this.activeUtteranceSampleCount16k = carryOverSamples.length;
      this.activeUtteranceStartSample16k = nextStartSample16k;
      this.activeUtteranceSpeechSamples16k = carryOverSamples.length;
      this.inActiveSpeech = true;
    } else {
      this.inActiveSpeech = false;
    }
  }

  private updatePreSpeechRing(samples: Float32Array): void {
    if (samples.length >= this.preSpeechMaxSamples16k) {
      this.preSpeechRing = samples.slice(samples.length - this.preSpeechMaxSamples16k);
      return;
    }
    const combinedLen = Math.min(
      this.preSpeechMaxSamples16k,
      this.preSpeechRing.length + samples.length,
    );
    const next = new Float32Array(combinedLen);
    const keepOld = combinedLen - samples.length;
    if (keepOld > 0) {
      next.set(this.preSpeechRing.subarray(this.preSpeechRing.length - keepOld), 0);
    }
    next.set(samples, keepOld);
    this.preSpeechRing = next;
  }

  private async processCanonical16kFrame(samples16k: Float32Array): Promise<void> {
    if (samples16k.length === 0) return;

    // Process in 20ms (320-sample) micro-frames so speech onset & silence endpoints are sample-accurate
    const subFrameSize = 320;
    const minUtteranceSamples = Math.round(
      (this.config.minUtteranceDurationMs / 1000) * CANONICAL_TARGET_SAMPLE_RATE_HZ,
    );
    const minSilenceSamples = Math.round(
      (this.config.minSilenceEndpointMs / 1000) * CANONICAL_TARGET_SAMPLE_RATE_HZ,
    );
    const maxUtteranceSamples = Math.round(
      this.config.maxUtteranceDurationSec * CANONICAL_TARGET_SAMPLE_RATE_HZ,
    );
    const partialStepSamples =
      this.config.partialIntervalMs > 0
        ? Math.round((this.config.partialIntervalMs / 1000) * CANONICAL_TARGET_SAMPLE_RATE_HZ)
        : 0;

    for (let offset = 0; offset < samples16k.length; offset += subFrameSize) {
      if (this.state === 'CANCELLED' || this.internalAbort.signal.aborted) {
        throw new Error('STREAMING_RECOGNITION_CANCELLED');
      }

      const end = Math.min(samples16k.length, offset + subFrameSize);
      const sub = samples16k.subarray(offset, end);
      const subStartSample16k = this.totalCanonicalSamples16k;
      this.totalCanonicalSamples16k += sub.length;

      // Compute sub-frame RMS dBFS
      let sumSq = 0;
      for (let i = 0; i < sub.length; i++) {
        sumSq += sub[i] * sub[i];
      }
      const rms = Math.sqrt(sumSq / sub.length);
      const rmsDbfs = 20 * Math.log10(Math.max(rms, 1e-9));
      const isSpeech = rmsDbfs >= this.config.speechThresholdDbfs;

      if (!this.inActiveSpeech) {
        if (isSpeech) {
          // Speech onset detected: seed active utterance with bounded pre-speech lookback ring
          this.inActiveSpeech = true;
          const preLen = this.preSpeechRing.length;
          this.activeUtteranceStartSample16k = Math.max(0, subStartSample16k - preLen);
          this.activeUtteranceChunks = [];
          this.activeUtteranceSampleCount16k = 0;
          if (preLen > 0) {
            this.appendToActiveUtterance(this.preSpeechRing);
            this.preSpeechRing = new Float32Array(0);
          }
          this.appendToActiveUtterance(new Float32Array(sub));
          this.activeUtteranceSpeechSamples16k = sub.length;
          this.activeUtteranceTrailingSilenceSamples16k = 0;
          this.samplesSinceLastPartial16k = sub.length;
        } else {
          // Pure silence outside active utterance: keep only 200ms pre-roll ring buffer (zero memory growth)
          this.updatePreSpeechRing(sub);
        }
        continue;
      }

      // Currently inside an active speech utterance
      this.appendToActiveUtterance(new Float32Array(sub));
      this.samplesSinceLastPartial16k += sub.length;

      if (isSpeech) {
        this.activeUtteranceSpeechSamples16k += sub.length;
        this.activeUtteranceTrailingSilenceSamples16k = 0;
      } else {
        this.activeUtteranceTrailingSilenceSamples16k += sub.length;
      }

      // Check 1: Natural silence endpoint reached after sufficient speech
      if (
        this.activeUtteranceSpeechSamples16k >= minUtteranceSamples &&
        this.activeUtteranceTrailingSilenceSamples16k >= minSilenceSamples
      ) {
        await this.decodeAndEmitCurrentUtterance({ isFinal: true, splitAtValley: false });
        continue;
      }

      // Check 2: Max utterance window reached during continuous fast speech -> split at best acoustic valley
      if (this.activeUtteranceSampleCount16k >= maxUtteranceSamples) {
        await this.decodeAndEmitCurrentUtterance({ isFinal: true, splitAtValley: true });
        continue;
      }

      // Check 3: Incremental partial recognition trigger
      if (
        partialStepSamples > 0 &&
        this.samplesSinceLastPartial16k >= partialStepSamples &&
        this.activeUtteranceSpeechSamples16k >= Math.min(2400, minUtteranceSamples)
      ) {
        this.samplesSinceLastPartial16k = 0;
        await this.decodeAndEmitCurrentUtterance({ isFinal: false, splitAtValley: false });
      }
    }
  }

  private findValleySplitIndex(samples: Float32Array): number {
    // Search the last 1.2s of the window for the lowest energy 20ms frame
    const searchLen = Math.min(Math.floor(samples.length * 0.35), 16000 * 1.2);
    const searchStart = Math.max(320, samples.length - Math.floor(searchLen));
    const win = 320;
    let bestIdx = samples.length;
    let bestEnergy = Number.POSITIVE_INFINITY;

    for (let i = searchStart; i + win <= samples.length; i += 160) {
      let e = 0;
      for (let j = 0; j < win; j++) {
        const s = samples[i + j];
        e += s * s;
      }
      if (e < bestEnergy) {
        bestEnergy = e;
        bestIdx = i + Math.floor(win / 2);
      }
    }
    return bestIdx;
  }

  private async decodeAndEmitCurrentUtterance(params: {
    readonly isFinal: boolean;
    readonly splitAtValley: boolean;
  }): Promise<void> {
    if (this.activeUtteranceSampleCount16k === 0) return;

    const targetSegmentIndex = this.currentSegmentIndex;
    if (!params.isFinal && this.finalizedSegmentIndices.has(targetSegmentIndex)) {
      this.stalePartialsSuppressed++;
      return;
    }

    if (this.simulateNativeCrashOnNextDecode) {
      this.simulateNativeCrashOnNextDecode = false;
      this.state = 'FAILED';
      this.errorCount++;
      throw new Error('NATIVE_SHERPA_ENGINE_ERROR: Simulated or unexpected native recognizer failure.');
    }

    if (this.config.simulateDecodeDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.simulateDecodeDelayMs));
    }

    const fullSamples = this.materializeActiveUtteranceSamples();
    let decodeSlice = fullSamples;
    let carryOverSlice: Float32Array | undefined;
    let nextSegmentStart16k: number | undefined;

    if (params.isFinal && params.splitAtValley && fullSamples.length >= 8000) {
      const splitIdx = this.findValleySplitIndex(fullSamples);
      decodeSlice = fullSamples.subarray(0, splitIdx);
      const overlapSamples = Math.min(
        splitIdx,
        Math.round(this.config.splitOverlapSec * CANONICAL_TARGET_SAMPLE_RATE_HZ),
      );
      const carryStart = Math.max(0, splitIdx - overlapSamples);
      carryOverSlice = fullSamples.slice(carryStart);
      nextSegmentStart16k = this.activeUtteranceStartSample16k + carryStart;
    }

    const segStart16k = this.activeUtteranceStartSample16k;
    const segEnd16k = segStart16k + decodeSlice.length;
    const nextRevision = this.currentSegmentRevision + 1;

    this.sampleRss();
    this.nativeDecodeCalls++;

    let decodeOut: { decodeTimeMs: number; result: RawSherpaJsonResult };
    try {
      decodeOut = await this.worker!.decodeSamples16k(
        decodeSlice,
        params.isFinal,
        this.internalAbort.signal,
      );
    } catch (err) {
      if (this.state !== 'CANCELLED' && !this.internalAbort.signal.aborted) {
        this.state = 'FAILED';
        this.errorCount++;
      }
      throw err;
    }

    this.sampleRss();

    // Stale partial guard: if segment was finalized while partial decode was in flight, drop stale partial
    if (!params.isFinal && this.finalizedSegmentIndices.has(targetSegmentIndex)) {
      this.stalePartialsSuppressed++;
      return;
    }

    this.currentSegmentRevision = nextRevision;
    const rawText = String(decodeOut.result.text ?? '').trim();

    if (params.isFinal) {
      this.finalizedSegmentIndices.add(targetSegmentIndex);
      this.clearActiveUtterance(carryOverSlice, nextSegmentStart16k);
      this.currentSegmentIndex++;
      this.currentSegmentRevision = 0;
    }

    // Do not emit empty partial/final events on pure low-energy noise with 0 recognized tokens
    if (rawText.length === 0) {
      return;
    }

    const segmentId = `${this.sessionId}_seg_${targetSegmentIndex}`;
    const sourceStartSample = Math.round(
      (segStart16k * this.config.sourceSampleRateHz) / CANONICAL_TARGET_SAMPLE_RATE_HZ,
    );
    const sourceEndSample = Math.max(
      sourceStartSample + 1,
      Math.round((segEnd16k * this.config.sourceSampleRateHz) / CANONICAL_TARGET_SAMPLE_RATE_HZ),
    );

    const words = buildStreamingWordsFromSherpaTokens({
      segmentId,
      tokens: decodeOut.result.tokens,
      timestamps: decodeOut.result.timestamps,
      windowStartSample16k: segStart16k,
      windowEndSample16k: segEnd16k,
      sourceSampleRateHz: this.config.sourceSampleRateHz,
    });

    const langTag: DetectedLanguageTag =
      decodeOut.result.lang === 'fa' || decodeOut.result.lang === 'en'
        ? decodeOut.result.lang
        : detectTextLanguageTag(rawText).language;

    const nowPerf = performance.now();
    if (!params.isFinal && this.firstPartialResultLatencyMs === null && this.firstChunkFedAtMs !== null) {
      this.firstPartialResultLatencyMs = Number((nowPerf - this.firstChunkFedAtMs).toFixed(2));
    }

    const event: NativeSherpaStreamingEvent = {
      eventId: `${this.sessionId}_ev_${this.nextEventSeq}`,
      sessionId: this.sessionId,
      sourceAudioId: this.sourceAudioId,
      seq: this.nextEventSeq++,
      type: params.isFinal ? 'FINAL' : 'PARTIAL',
      isFinal: params.isFinal,
      segmentId,
      segmentIndex: targetSegmentIndex,
      revision: nextRevision,
      startSample16k: segStart16k,
      endSample16k: segEnd16k,
      sourceStartSample,
      sourceEndSample,
      startSec: Number((segStart16k / CANONICAL_TARGET_SAMPLE_RATE_HZ).toFixed(6)),
      endSec: Number((segEnd16k / CANONICAL_TARGET_SAMPLE_RATE_HZ).toFixed(6)),
      rawText,
      normalizedByProfile: buildNormalizationProfiles(rawText),
      language: langTag,
      timestampGranularity: words.length > 0 ? 'WORD' : 'SEGMENT',
      words,
      tokens: decodeOut.result.tokens ?? [],
      tokenTimestampsSec: decodeOut.result.timestamps ?? [],
      confidence: null,
      decodeLatencyMs: Number(decodeOut.decodeTimeMs.toFixed(2)),
      emittedAtMs: Date.now(),
    };

    if (params.isFinal) {
      this.finalEventsEmitted++;
    } else {
      this.partialEventsEmitted++;
    }

    this.emittedEvents.push(event);
    this.onEventCallback?.(event);
  }

  /**
   * Flushes any remaining resampler filter tail and active utterance buffer,
   * emits the final recognition event, releases all buffers, and returns session metrics.
   */
  public async finalize(): Promise<{
    readonly events: readonly NativeSherpaStreamingEvent[];
    readonly finalSegments: readonly NativeSherpaStreamingEvent[];
    readonly metrics: NativeSherpaStreamingMetrics;
  }> {
    if (this.state === 'CANCELLED' || this.internalAbort.signal.aborted) {
      throw new Error('STREAMING_RECOGNITION_CANCELLED');
    }
    if (this.state === 'FAILED') {
      throw new Error('STREAMING_SESSION_FAILED');
    }
    if (this.state === 'CREATED') {
      await this.start();
    }

    const tFinalize0 = performance.now();
    this.state = 'FLUSHING';

    // Wait for any in-flight queued chunks
    await this.ensureQueueDraining();

    // Flush resampler FIR filter tail if resampling was active
    if (this.resampler) {
      const tail = this.resampler.flush();
      if (tail.length > 0) {
        await this.processCanonical16kFrame(tail);
      }
    }

    // Flush any remaining active speech utterance as a FINAL segment
    if (this.activeUtteranceSampleCount16k > 0) {
      await this.decodeAndEmitCurrentUtterance({ isFinal: true, splitAtValley: false });
    }

    this.finalResultLatencyMs = Number((performance.now() - tFinalize0).toFixed(2));
    if (this.firstPartialResultLatencyMs === null) {
      this.firstPartialResultLatencyMs = this.finalResultLatencyMs;
    }

    this.releaseBuffers();
    this.state = 'COMPLETED';

    const metrics = this.getMetrics();
    return {
      events: this.emittedEvents,
      finalSegments: this.emittedEvents.filter((e) => e.isFinal),
      metrics,
    };
  }

  public cancel(reason = 'USER_CANCELLED'): void {
    if (this.state === 'COMPLETED' || this.state === 'CANCELLED') {
      return;
    }
    this.state = 'CANCELLED';
    this.internalAbort.abort(reason);
    this.releaseBuffers();
    this.notifyDrainWaiters();
    if (this.ownsDedicatedWorker && this.worker) {
      this.worker.dispose();
      this.worker = null;
    }
  }

  private releaseBuffers(): void {
    this.pendingQueue.length = 0;
    this.currentPendingQueueBytes = 0;
    this.frameRemainder = Buffer.alloc(0);
    this.preSpeechRing = new Float32Array(0);
    this.activeUtteranceChunks = [];
    this.activeUtteranceSampleCount16k = 0;
  }

  public dispose(): void {
    this.releaseBuffers();
    if (this.ownsDedicatedWorker && this.worker) {
      this.worker.dispose();
      this.worker = null;
    }
  }

  public getMetrics(): NativeSherpaStreamingMetrics {
    this.sampleRss();
    this.nodeRssAfterMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    this.nativeChildRssAfterMb = Number(
      (((this.worker?.getRssBytes() ?? 0)) / (1024 * 1024)).toFixed(2),
    );

    const audioDurationSec =
      this.config.sourceSampleRateHz > 0
        ? Number((this.totalSourceSamples / this.config.sourceSampleRateHz).toFixed(4))
        : 0;
    const processingDurationSec =
      this.sessionStartedAtMs > 0
        ? Number(((performance.now() - this.sessionStartedAtMs) / 1000).toFixed(4))
        : 0;
    const realTimeFactor =
      audioDurationSec > 0
        ? Number((processingDurationSec / audioDurationSec).toFixed(4))
        : 0;

    const memoryBeforeMb = Number((this.nodeRssBeforeMb + this.nativeChildRssBeforeMb).toFixed(2));
    const memoryAfterMb = Number((this.nodeRssAfterMb + this.nativeChildRssAfterMb).toFixed(2));
    const peakRssMb = Number((this.nodePeakRssMb + this.nativeChildPeakRssMb).toFixed(2));

    return {
      sessionId: this.sessionId,
      sourceAudioId: this.sourceAudioId,
      modelId: this.model?.modelId ?? 'Reza2kn/Shenava-Rizeh',
      firstPartialResultLatencyMs: this.firstPartialResultLatencyMs,
      finalResultLatencyMs: this.finalResultLatencyMs,
      realTimeFactor,
      audioDurationSec,
      processingDurationSec,
      memoryBeforeMb,
      memoryAfterMb,
      peakRssMb,
      nodeRssBeforeMb: this.nodeRssBeforeMb,
      nodeRssAfterMb: this.nodeRssAfterMb,
      nodePeakRssMb: this.nodePeakRssMb,
      nativeChildRssBeforeMb: this.nativeChildRssBeforeMb,
      nativeChildRssAfterMb: this.nativeChildRssAfterMb,
      nativeChildPeakRssMb: this.nativeChildPeakRssMb,
      peakPendingQueueBytes: this.peakPendingQueueBytes,
      peakActiveUtteranceBytes: this.peakActiveUtteranceBytes,
      processedChunks: this.processedChunks,
      droppedChunks: this.droppedChunks,
      duplicateChunks: this.duplicateChunks,
      backpressureEvents: this.backpressureEvents,
      backpressureWaitMs: Number(this.backpressureWaitMs.toFixed(2)),
      partialEventsEmitted: this.partialEventsEmitted,
      finalEventsEmitted: this.finalEventsEmitted,
      stalePartialsSuppressed: this.stalePartialsSuppressed,
      nativeDecodeCalls: this.nativeDecodeCalls,
      errorCount: this.errorCount,
      totalSourceSamples: this.totalSourceSamples,
      totalCanonicalSamples16k: this.totalCanonicalSamples16k,
    };
  }
}

/**
 * Convenience helper to stream a WAV file from disk through `NativeSherpaStreamingRecognizer`
 * in bounded chunks without ever loading the full file into memory.
 */
export async function streamWavFileWithNativeSherpa(params: {
  readonly wavFilePath: string;
  readonly chunkDurationMs?: number;
  readonly partialIntervalMs?: number;
  readonly maxUtteranceDurationSec?: number;
  readonly minSilenceEndpointMs?: number;
  readonly useSharedNativeWorker?: boolean;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: NativeSherpaStreamingEvent) => void;
}): Promise<{
  readonly recognizer: NativeSherpaStreamingRecognizer;
  readonly events: readonly NativeSherpaStreamingEvent[];
  readonly finalSegments: readonly NativeSherpaStreamingEvent[];
  readonly metrics: NativeSherpaStreamingMetrics;
  readonly sourceSha256: string;
}> {
  const fh = await fs.promises.open(params.wavFilePath, 'r');
  try {
    const headerBuf = Buffer.allocUnsafe(4096);
    const { bytesRead } = await fh.read(headerBuf, 0, headerBuf.byteLength, 0);
    if (bytesRead < 44) {
      throw new Error('WAV_HEADER_TOO_SHORT');
    }
    const riff = headerBuf.toString('ascii', 0, 4);
    const wave = headerBuf.toString('ascii', 8, 12);
    if ((riff !== 'RIFF' && riff !== 'RF64') || wave !== 'WAVE') {
      throw new Error('INVALID_WAV_CONTAINER');
    }

    let offset = 12;
    let audioFormat = 1;
    let channels = 1;
    let sampleRate = 16000;
    let bitsPerSample = 16;
    let dataOffset = 44;
    let dataSize = 0;

    while (offset + 8 <= bytesRead) {
      const id = headerBuf.toString('ascii', offset, offset + 4);
      const size = headerBuf.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        audioFormat = headerBuf.readUInt16LE(offset + 8);
        channels = headerBuf.readUInt16LE(offset + 10);
        sampleRate = headerBuf.readUInt32LE(offset + 12);
        bitsPerSample = headerBuf.readUInt16LE(offset + 22);
        if (audioFormat === 0xfffe && size >= 40) {
          audioFormat = headerBuf.readUInt16LE(offset + 8 + 24);
        }
      } else if (id === 'data') {
        dataOffset = offset + 8;
        dataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }

    const stat = await fh.stat();
    if (dataSize === 0 || dataSize === 0xffffffff || dataOffset + dataSize > stat.size) {
      dataSize = Math.max(0, stat.size - dataOffset);
    }

    const inputFormat: StreamingInputSampleFormat =
      audioFormat === 3 && bitsPerSample === 32 ? 'PCM32_FLOAT' : 'PCM16';

    const recognizer = new NativeSherpaStreamingRecognizer({
      sourceSampleRateHz: sampleRate,
      sourceChannels: channels,
      inputFormat,
      partialIntervalMs: params.partialIntervalMs,
      maxUtteranceDurationSec: params.maxUtteranceDurationSec,
      minSilenceEndpointMs: params.minSilenceEndpointMs,
      useSharedNativeWorker: params.useSharedNativeWorker,
      signal: params.signal,
      onEvent: params.onEvent,
    });

    await recognizer.start();

    const chunkMs = Math.max(20, params.chunkDurationMs ?? 250);
    const bytesPerFrame = (bitsPerSample / 8) * channels;
    const framesPerChunk = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
    const chunkBytes = Math.min(256 * 1024, framesPerChunk * bytesPerFrame);
    const readBuf = Buffer.allocUnsafe(chunkBytes);
    const hash = crypto.createHash('sha256');

    // Hash the header slice first
    hash.update(headerBuf.subarray(0, dataOffset));

    let pos = dataOffset;
    const endPos = dataOffset + dataSize;
    let idx = 0;

    while (pos < endPos) {
      if (params.signal?.aborted) {
        recognizer.cancel('ABORT_SIGNAL');
        throw new Error('STREAMING_RECOGNITION_CANCELLED');
      }
      const toRead = Math.min(readBuf.byteLength, endPos - pos);
      const res = await fh.read(readBuf, 0, toRead, pos);
      if (res.bytesRead <= 0) break;
      const slice = readBuf.subarray(0, res.bytesRead);
      hash.update(slice);
      pos += res.bytesRead;
      idx++;
      await recognizer.feedAudioChunk(slice, { chunkId: `wav_chk_${idx}` });
    }

    const finalized = await recognizer.finalize();
    return {
      recognizer,
      events: finalized.events,
      finalSegments: finalized.finalSegments,
      metrics: finalized.metrics,
      sourceSha256: hash.digest('hex'),
    };
  } finally {
    await fh.close().catch(() => {});
  }
}
