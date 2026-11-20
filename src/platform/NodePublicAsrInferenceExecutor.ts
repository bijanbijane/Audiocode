/**
 * AVP-PUBLIC-DATAPLANE-REAL-AUDIO-010
 * Production-Honest Node.js ASR Inference Executor with Bounded Sliding-Window Disk Reads.
 *
 * Key Guarantees:
 * - Never synthesizes placeholder transcripts, never consults evaluation corpora, and never accepts text hints.
 * - Reports exact model readiness (`MODEL_NOT_INSTALLED`, `MODEL_NOT_READY`, `MODEL_INTEGRITY_FAILURE`,
 *   `REQUIRES_GPU_WORKER`, `WORKER_UNAVAILABLE`, `AVAILABLE_NOW`).
 * - When a verified local model runner IS provisioned, reads `audio.canonicalPcmFilePath` strictly in
 *   bounded sliding windows (25s window / 3s overlap) via `fs.open` + `fileHandle.read` — zero full-file PCM in RAM.
 * - Rejects empty or synthetic placeholder outputs and verifies `processedSamples16k === audio.totalSamples16k`.
 */

import fs from 'node:fs/promises';
import { normalizePersianTranscript } from '../ai-engine/PersianTextNormalizer';
import { PHASE10_PUBLIC_MODEL_CATALOG } from './PlatformControlPlaneEngine';
import type { PublicAudioArtifact } from './PublicAudioArtifactIngest';
import type {
  PublicAsrInferenceExecutor,
  PublicAsrInferenceResult,
  PublicAsrModelReadiness,
  PublicAsrSegment,
  PublicAsrTranscriptionRequest,
} from './PublicAsrInferenceExecutor';

export const PUBLIC_ASR_WINDOW_SECONDS = 25;
export const PUBLIC_ASR_OVERLAP_SECONDS = 3;
const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = PUBLIC_ASR_WINDOW_SECONDS * SAMPLE_RATE; // 400,000 samples (1.6 MiB Float32)
const OVERLAP_SAMPLES = PUBLIC_ASR_OVERLAP_SECONDS * SAMPLE_RATE; // 48,000 samples
const STEP_SAMPLES = WINDOW_SAMPLES - OVERLAP_SAMPLES; // 352,000 samples (22s)

const SYNTHETIC_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^\[.*(?:acoustic|synthetic|mock|placeholder|fallback|stub|simulated).*\]$/i,
  /\bsynthetic\s+transcript\b/i,
  /\bmock\s+asr\b/i,
  /\bfallback\s+placeholder\b/i,
  /تولید\s+مصنوعی/,
  /متن\s+آزمایشی\s+ساختگی/,
];

export interface ProvisionedAsrWindowRunner {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelDigestSha256: string;
  readonly backendEngine: string;
  readonly integrityVerified: boolean;
  readonly runtimeReady: boolean;
  readonly timestampsSupported: boolean;
  readonly diarizationSupported: boolean;
  transcribeWindow(params: {
    pcm16kMono: Float32Array;
    windowStartSample: number;
    windowEndSample: number;
    language: 'auto' | 'fa' | 'en' | 'fa-en';
    abortSignal?: AbortSignal;
  }): Promise<{
    rawText: string;
    segments?: PublicAsrSegment[];
  }>;
}

export class PublicInferenceExecutionError extends Error {
  public readonly httpStatus: number;
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(httpStatus: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'PublicInferenceExecutionError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable = retryable;
  }
}

export function isSyntheticPlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  for (const pat of SYNTHETIC_PLACEHOLDER_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

function stitchWindowTranscripts(existingText: string, nextWindowText: string): string {
  const left = existingText.trim();
  const right = nextWindowText.trim();
  if (!left) return right;
  if (!right) return left;

  const leftTokens = left.split(/\s+/);
  const rightTokens = right.split(/\s+/);
  const maxOverlap = Math.min(8, leftTokens.length, rightTokens.length);

  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    const leftTail = leftTokens.slice(leftTokens.length - overlap).join(' ');
    const rightHead = rightTokens.slice(0, overlap).join(' ');
    if (leftTail === rightHead) {
      return [...leftTokens, ...rightTokens.slice(overlap)].join(' ');
    }
  }
  return `${left} ${right}`;
}

export class NodePublicAsrInferenceExecutor implements PublicAsrInferenceExecutor {
  private readonly runners = new Map<string, ProvisionedAsrWindowRunner>();

  constructor(initialRunners: readonly ProvisionedAsrWindowRunner[] = []) {
    for (const runner of initialRunners) {
      this.runners.set(runner.modelId, runner);
    }
  }

  public registerRunner(runner: ProvisionedAsrWindowRunner): void {
    this.runners.set(runner.modelId, runner);
  }

  public unregisterRunner(modelId: string): void {
    this.runners.delete(modelId);
  }

  public async getModelReadiness(modelId: string): Promise<PublicAsrModelReadiness> {
    const catalogEntry = PHASE10_PUBLIC_MODEL_CATALOG.find((m) => m.modelId === modelId);
    if (!catalogEntry) {
      return {
        modelId,
        modelVersion: 'unknown',
        availability: 'MODEL_NOT_INSTALLED',
        ready: false,
        reason: `Model "${modelId}" is not registered in the public catalog.`,
        timestampsSupported: false,
        diarizationSupported: false,
        modelDigestSha256: null,
        backendEngine: 'unregistered',
      };
    }

    if (catalogEntry.availabilityInCurrentContainer === 'REQUIRES_GPU_WORKER') {
      const gpuRunner = this.runners.get(modelId);
      if (!gpuRunner) {
        return {
          modelId,
          modelVersion: catalogEntry.version,
          availability: 'REQUIRES_GPU_WORKER',
          ready: false,
          reason: `Model "${modelId}" requires a GPU worker not attached to this container.`,
          timestampsSupported: false,
          diarizationSupported: false,
          modelDigestSha256: null,
          backendEngine: 'gpu_worker_absent',
        };
      }
    }

    const runner = this.runners.get(modelId);
    if (!runner) {
      return {
        modelId,
        modelVersion: catalogEntry.version,
        availability: 'MODEL_NOT_INSTALLED',
        ready: false,
        reason: `Verified ASR model weights for "${modelId}" are not installed in this container.`,
        timestampsSupported: false,
        diarizationSupported: false,
        modelDigestSha256: null,
        backendEngine: 'none',
      };
    }

    if (!runner.integrityVerified) {
      return {
        modelId,
        modelVersion: runner.modelVersion,
        availability: 'MODEL_INTEGRITY_FAILURE',
        ready: false,
        reason: `Model "${modelId}" failed cryptographic integrity verification.`,
        timestampsSupported: false,
        diarizationSupported: false,
        modelDigestSha256: runner.modelDigestSha256 || null,
        backendEngine: runner.backendEngine,
      };
    }

    if (!runner.runtimeReady) {
      return {
        modelId,
        modelVersion: runner.modelVersion,
        availability: 'MODEL_NOT_READY',
        ready: false,
        reason: `Model "${modelId}" is installed but its inference runtime is not initialized.`,
        timestampsSupported: false,
        diarizationSupported: false,
        modelDigestSha256: runner.modelDigestSha256 || null,
        backendEngine: runner.backendEngine,
      };
    }

    return {
      modelId,
      modelVersion: runner.modelVersion,
      availability: 'AVAILABLE_NOW',
      ready: true,
      reason: 'Verified ASR model and runtime ready for inference.',
      timestampsSupported: runner.timestampsSupported,
      diarizationSupported: runner.diarizationSupported,
      modelDigestSha256: runner.modelDigestSha256,
      backendEngine: runner.backendEngine,
    };
  }

  public async transcribe(
    audio: PublicAudioArtifact,
    request: PublicAsrTranscriptionRequest
  ): Promise<PublicAsrInferenceResult> {
    const readiness = await this.getModelReadiness(request.modelId);
    if (!readiness.ready) {
      throw new PublicInferenceExecutionError(
        503,
        'PROVIDER_UNAVAILABLE',
        `Model "${request.modelId}" is unavailable (${readiness.availability}): ${readiness.reason}`,
        false
      );
    }

    const runner = this.runners.get(request.modelId);
    if (!runner) {
      throw new PublicInferenceExecutionError(
        503,
        'PROVIDER_UNAVAILABLE',
        `Model "${request.modelId}" runner became unavailable.`,
        false
      );
    }

    const totalSamples = audio.totalSamples16k;
    if (totalSamples <= 0) {
      throw new PublicInferenceExecutionError(
        422,
        'AUDIO_DECODE_FAILED',
        'Cannot execute inference on 0-sample canonical audio.'
      );
    }

    // Bounded window buffer — never allocates full-file Float32Array
    const maxWindowBytes = WINDOW_SAMPLES * 4;
    const rawReadBuffer = Buffer.allocUnsafe(maxWindowBytes);

    let combinedRawText = '';
    const collectedSegments: PublicAsrSegment[] = [];
    let maxEndSampleCovered = 0;

    const fileHandle = await fs.open(audio.canonicalPcmFilePath, 'r');
    try {
      let windowStart = 0;
      while (windowStart < totalSamples) {
        if (request.abortSignal?.aborted) {
          throw new PublicInferenceExecutionError(
            499,
            'REQUEST_ABORTED',
            'Transcription aborted by client disconnect.'
          );
        }

        const windowEnd = Math.min(totalSamples, windowStart + WINDOW_SAMPLES);
        const sampleCount = windowEnd - windowStart;
        const byteOffset = windowStart * 4;
        const byteLength = sampleCount * 4;

        let totalBytesRead = 0;
        while (totalBytesRead < byteLength) {
          const { bytesRead } = await fileHandle.read(
            rawReadBuffer,
            totalBytesRead,
            byteLength - totalBytesRead,
            byteOffset + totalBytesRead
          );
          if (bytesRead <= 0) break;
          totalBytesRead += bytesRead;
        }

        if (totalBytesRead !== byteLength) {
          throw new PublicInferenceExecutionError(
            500,
            'INTERNAL_ERROR',
            `Short read while streaming canonical PCM window [${windowStart}..${windowEnd}].`
          );
        }

        const windowPcm = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i += 1) {
          windowPcm[i] = rawReadBuffer.readFloatLE(i * 4);
        }

        const windowOut = await runner.transcribeWindow({
          pcm16kMono: windowPcm,
          windowStartSample: windowStart,
          windowEndSample: windowEnd,
          language: request.language,
          abortSignal: request.abortSignal,
        });

        if (request.abortSignal?.aborted) {
          throw new PublicInferenceExecutionError(
            499,
            'REQUEST_ABORTED',
            'Transcription aborted during inference window.'
          );
        }

        const windowRaw = (windowOut.rawText ?? '').trim();
        if (windowRaw) {
          combinedRawText = stitchWindowTranscripts(combinedRawText, windowRaw);
        }

        if (request.timestamps && runner.timestampsSupported && windowOut.segments) {
          for (const seg of windowOut.segments) {
            if (seg.text.trim()) {
              collectedSegments.push({
                startMs: Math.max(0, Math.round(seg.startMs)),
                endMs: Math.min(audio.durationMs, Math.round(seg.endMs)),
                text: seg.text.trim(),
              });
            }
          }
        }

        maxEndSampleCovered = Math.max(maxEndSampleCovered, windowEnd);
        if (windowEnd >= totalSamples) {
          break;
        }
        windowStart += STEP_SAMPLES;
      }
    } finally {
      await fileHandle.close();
    }

    if (maxEndSampleCovered !== totalSamples) {
      throw new PublicInferenceExecutionError(
        500,
        'INTERNAL_ERROR',
        `Incomplete audio inference coverage: processed ${maxEndSampleCovered} of ${totalSamples} samples.`
      );
    }

    const trimmedRaw = combinedRawText.trim();
    if (!trimmedRaw || isSyntheticPlaceholderText(trimmedRaw)) {
      throw new PublicInferenceExecutionError(
        502,
        'PROVIDER_UNAVAILABLE',
        'ASR model returned empty or invalid synthetic output; transcription aborted.'
      );
    }

    const normalizedText = normalizePersianTranscript(trimmedRaw, 'display').trim() || trimmedRaw;

    return {
      rawText: trimmedRaw,
      normalizedText,
      language: request.language,
      ...(request.timestamps && runner.timestampsSupported
        ? {
            segments:
              collectedSegments.length > 0
                ? collectedSegments
                : [{ startMs: 0, endMs: audio.durationMs, text: normalizedText }],
          }
        : {}),
      processedSamples16k: maxEndSampleCovered,
      modelId: runner.modelId,
      modelVersion: runner.modelVersion,
      modelDigestSha256: runner.modelDigestSha256,
      provenance: 'MODEL_INFERENCE',
      backendEngine: runner.backendEngine,
      timestampsAvailable: Boolean(request.timestamps && runner.timestampsSupported),
      diarizationAvailable: Boolean(request.diarization && runner.diarizationSupported),
    };
  }
}
