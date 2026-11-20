/**
 * AVAPARDAZ — BOUNDED-MEMORY LONG-AUDIO STREAMING & OVERLAP RECONCILIATION PIPELINE
 *
 * Designed for PHASE-08 §5 (10s, 1 min, 10 min, 30 min, 60 min recordings):
 * - Processes arbitrarily long recordings in O(1) memory sliding chunks
 * - Snaps chunk boundaries to acoustic RMS energy valleys (never slices mid-word)
 * - Deduplicates overlapping words across chunk seams (Persian ZWNJ + Latin aware)
 * - Emits honest progress updates based on actual audio duration processed
 * - Supports immediate AbortSignal cancellation & partial-to-final reconciliation
 */

import { CORE_SAMPLE_RATE } from './CoreAcousticCtcEngine';
import { findBestBoundaryValleySample } from './CoreBatchAndLongFormEngine';

export interface StreamingChunkPlan {
  readonly chunkIndex: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly overlapLeadSamples: number;
}

export interface ChunkDecodeOutput {
  readonly text: string;
  readonly words?: readonly { readonly word: string; readonly startSec: number; readonly endSec: number }[];
  readonly language?: string;
}

export interface ReconciledTranscriptSegment {
  readonly id: string;
  readonly chunkIndex: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly deduplicatedLeadingWords: number;
  readonly language: string;
}

export interface LongAudioPipelineOptions {
  readonly maxChunkDurationSec?: number;
  readonly overlapSec?: number;
  readonly valleySearchRadiusSec?: number;
  readonly sampleRate?: number;
  readonly signal?: AbortSignal;
  readonly onPartial?: (ev: {
    readonly chunkIndex: number;
    readonly totalChunks: number;
    readonly progressPct: number;
    readonly processedAudioSec: number;
    readonly totalAudioSec: number;
    readonly segment: ReconciledTranscriptSegment;
    readonly currentRssMb: number;
  }) => void;
}

export interface LongAudioPipelineResult {
  readonly totalAudioSec: number;
  readonly chunkCount: number;
  readonly segments: readonly ReconciledTranscriptSegment[];
  readonly finalText: string;
  readonly totalDeduplicatedWords: number;
  readonly peakRssMb: number;
  readonly rssDeltaMb: number;
  readonly elapsedMs: number;
  readonly cancelled: boolean;
}

/**
 * Normalizes a word strictly for boundary duplicate comparison (handles Arabic/Persian
 * Kaf/Yeh variants, ZWNJ, punctuation, and case without mutating the actual output text).
 */
function normalizeTokenForSeamMatch(token: string): string {
  return token
    .replace(/\u200c/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[.,!?;:،؛؟«»"'()[\]{}]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Deduplicates trailing/leading overlapping tokens between consecutive overlap chunks.
 */
export function deduplicateChunkOverlap(
  accumulatedWords: readonly string[],
  nextChunkText: string,
  maxOverlapWords = 8,
): { readonly appendedWords: readonly string[]; readonly removedCount: number } {
  const nextWords = nextChunkText.trim().split(/\s+/).filter(Boolean);
  if (accumulatedWords.length === 0 || nextWords.length === 0) {
    return { appendedWords: nextWords, removedCount: 0 };
  }

  const maxK = Math.min(maxOverlapWords, accumulatedWords.length, nextWords.length);
  for (let k = maxK; k >= 1; k--) {
    let allMatch = true;
    for (let j = 0; j < k; j++) {
      const a = normalizeTokenForSeamMatch(accumulatedWords[accumulatedWords.length - k + j]);
      const b = normalizeTokenForSeamMatch(nextWords[j]);
      if (!a || a !== b) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      return { appendedWords: nextWords.slice(k), removedCount: k };
    }
  }

  return { appendedWords: nextWords, removedCount: 0 };
}

/**
 * Plans VAD/energy-valley-snapped overlapping windows across an audio stream reader
 * using strictly O(1) memory per chunk (reads only one window at a time).
 */
export async function runBoundedLongAudioPipeline(params: {
  readonly totalSamples: number;
  readonly readPcmWindow: (startSample: number, endSample: number) => Float32Array;
  readonly decodeChunk: (
    pcmWindow: Float32Array,
    plan: StreamingChunkPlan,
    signal?: AbortSignal,
  ) => Promise<ChunkDecodeOutput>;
  readonly options?: LongAudioPipelineOptions;
}): Promise<LongAudioPipelineResult> {
  const t0 = performance.now();
  const sampleRate = params.options?.sampleRate ?? CORE_SAMPLE_RATE;
  const maxChunkSec = Math.max(5, Math.min(30, params.options?.maxChunkDurationSec ?? 25));
  const overlapSec = Math.max(0, Math.min(3, params.options?.overlapSec ?? 1.5));
  const valleyRadiusSec = Math.max(0.25, Math.min(2.5, params.options?.valleySearchRadiusSec ?? 1.2));

  const maxChunkSamples = Math.round(maxChunkSec * sampleRate);
  const overlapSamples = Math.round(overlapSec * sampleRate);
  const valleyRadiusSamples = Math.round(valleyRadiusSec * sampleRate);
  const totalSamples = Math.max(0, Math.floor(params.totalSamples));
  const totalAudioSec = Number((totalSamples / sampleRate).toFixed(3));

  const startRssMb =
    typeof process !== 'undefined' && process.memoryUsage
      ? process.memoryUsage().rss / (1024 * 1024)
      : 0;
  let peakRssMb = startRssMb;

  const segments: ReconciledTranscriptSegment[] = [];
  const accumulatedWords: string[] = [];
  let totalDeduplicatedWords = 0;

  if (totalSamples === 0) {
    return {
      totalAudioSec: 0,
      chunkCount: 0,
      segments: [],
      finalText: '',
      totalDeduplicatedWords: 0,
      peakRssMb: Number(peakRssMb.toFixed(2)),
      rssDeltaMb: 0,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      cancelled: false,
    };
  }

  const estimatedTotalChunks = Math.max(
    1,
    Math.ceil(totalSamples / Math.max(sampleRate, maxChunkSamples - overlapSamples)),
  );

  let cursor = 0;
  let chunkIndex = 0;
  let cancelled = false;

  while (cursor < totalSamples) {
    if (params.options?.signal?.aborted) {
      cancelled = true;
      break;
    }

    const nominalEnd = Math.min(totalSamples, cursor + maxChunkSamples);
    let endSample = nominalEnd;

    // Snap split boundary to lowest RMS energy valley within [nominalEnd - radius, nominalEnd + radius]
    if (nominalEnd < totalSamples - sampleRate) {
      const probeStart = Math.max(cursor + sampleRate, nominalEnd - valleyRadiusSamples);
      const probeEnd = Math.min(totalSamples, nominalEnd + valleyRadiusSamples);
      const probeSlice = params.readPcmWindow(probeStart, probeEnd);
      const localTarget = nominalEnd - probeStart;
      const localBest = findBestBoundaryValleySample(probeSlice, localTarget, valleyRadiusSamples);
      endSample = Math.min(totalSamples, Math.max(cursor + sampleRate, probeStart + localBest));
    }

    const plan: StreamingChunkPlan = {
      chunkIndex,
      startSample: cursor,
      endSample,
      startSec: Number((cursor / sampleRate).toFixed(3)),
      endSec: Number((endSample / sampleRate).toFixed(3)),
      overlapLeadSamples: chunkIndex === 0 ? 0 : overlapSamples,
    };

    const pcmWindow = params.readPcmWindow(plan.startSample, plan.endSample);
    const decoded = await params.decodeChunk(pcmWindow, plan, params.options?.signal);

    if (params.options?.signal?.aborted) {
      cancelled = true;
      break;
    }

    const { appendedWords, removedCount } = deduplicateChunkOverlap(accumulatedWords, decoded.text);
    accumulatedWords.push(...appendedWords);
    totalDeduplicatedWords += removedCount;

    const segment: ReconciledTranscriptSegment = {
      id: `seg_${chunkIndex}`,
      chunkIndex,
      startSec: plan.startSec,
      endSec: plan.endSec,
      text: appendedWords.join(' ').trim(),
      deduplicatedLeadingWords: removedCount,
      language: decoded.language ?? 'unknown',
    };
    segments.push(segment);

    const curRssMb =
      typeof process !== 'undefined' && process.memoryUsage
        ? process.memoryUsage().rss / (1024 * 1024)
        : 0;
    if (curRssMb > peakRssMb) peakRssMb = curRssMb;

    const processedAudioSec = Math.min(totalAudioSec, plan.endSec);
    const progressPct = Math.min(100, Math.round((processedAudioSec / Math.max(totalAudioSec, 0.001)) * 100));

    params.options?.onPartial?.({
      chunkIndex,
      totalChunks: Math.max(estimatedTotalChunks, chunkIndex + 1),
      progressPct,
      processedAudioSec,
      totalAudioSec,
      segment,
      currentRssMb: Number(curRssMb.toFixed(2)),
    });

    chunkIndex++;
    if (endSample >= totalSamples) break;
    cursor = Math.max(cursor + sampleRate, endSample - overlapSamples);
  }

  return {
    totalAudioSec,
    chunkCount: chunkIndex,
    segments,
    finalText: accumulatedWords.join(' ').trim(),
    totalDeduplicatedWords,
    peakRssMb: Number(peakRssMb.toFixed(2)),
    rssDeltaMb: Number(Math.max(0, peakRssMb - startRssMb).toFixed(2)),
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
    cancelled,
  };
}
