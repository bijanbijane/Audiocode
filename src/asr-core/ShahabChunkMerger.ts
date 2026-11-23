/**
 * AVAPARDAZ — SHAHAB BOUNDARY-AWARE CHUNK PLANNER & SEAM MERGER
 *
 * Pure, deterministic chunk planning and overlap-stitching utilities shared by
 * both the server runtime (`ShahabZipformerAsrRuntime.ts`) and the browser HTTP
 * client (`ShahabLocalHttpClient.ts`).
 *
 * Design guarantees:
 * 1. Midpoint-anchored overlap stitching prevents mid-word truncation artifacts
 *    at chunk edges without dropping speech if one side of the overlap is empty.
 * 2. Overlap deduplication is strictly gated to the actual overlap time interval
 *    `[chunkStartSec, prevChunkEndSec]`, preserving genuine repeated Persian words
 *    and phrases spoken outside the overlap seam.
 * 3. Output timestamps are strictly monotonic (`startSec[i] >= startSec[i-1]`)
 *    and clamped within `[0, totalDurationSec]`.
 */

export interface TimedWordLike {
  readonly rawText: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface ChunkRangeSamples {
  readonly index: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly startSec: number;
  readonly endSec: number;
}

export interface ChunkWordBucket<T extends TimedWordLike> {
  readonly chunkStartSec: number;
  readonly chunkEndSec: number;
  readonly words: readonly T[];
}

export const DEFAULT_SHAHAB_CHUNK_SEC = 24;
export const DEFAULT_SHAHAB_OVERLAP_SEC = 1.0;

export function normalizeWordForSeamMatch(word: string): string {
  return word
    .trim()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\s.,،؛؟!?:«»"'()[\]-]+/g, '')
    .toLowerCase();
}

/**
 * Plans bounded overlapping sample windows for long audio.
 */
export function planAudioChunks(params: {
  readonly totalSamples: number;
  readonly sampleRate: number;
  readonly maxChunkSec?: number;
  readonly overlapSec?: number;
}): ChunkRangeSamples[] {
  const safeRate =
    Number.isFinite(params.sampleRate) && params.sampleRate > 0 ? params.sampleRate : 16000;
  const totalSamples = Math.max(0, Math.floor(params.totalSamples));
  if (totalSamples === 0) return [];

  const maxChunkSec = Math.max(4, Math.min(30, params.maxChunkSec ?? DEFAULT_SHAHAB_CHUNK_SEC));
  const overlapSec = Math.max(
    0,
    Math.min(maxChunkSec * 0.25, params.overlapSec ?? DEFAULT_SHAHAB_OVERLAP_SEC),
  );
  const chunkSamples = Math.max(1, Math.round(maxChunkSec * safeRate));
  const stepSamples = Math.max(Math.round(safeRate), Math.round((maxChunkSec - overlapSec) * safeRate));

  if (totalSamples <= chunkSamples) {
    return [
      {
        index: 0,
        startSample: 0,
        endSample: totalSamples,
        startSec: 0,
        endSec: totalSamples / safeRate,
      },
    ];
  }

  const chunks: ChunkRangeSamples[] = [];
  for (let start = 0; start < totalSamples; start += stepSamples) {
    const end = Math.min(totalSamples, start + chunkSamples);
    chunks.push({
      index: chunks.length,
      startSample: start,
      endSample: end,
      startSec: start / safeRate,
      endSec: end / safeRate,
    });
    if (end >= totalSamples) break;
  }
  return chunks;
}

function wordCenterSec(w: TimedWordLike): number {
  return (w.startSec + Math.max(w.startSec, w.endSec)) * 0.5;
}

/**
 * Merges words emitted from adjacent overlapping ASR chunks using midpoint-anchored
 * overlap ownership + strictly time-gated seam deduplication + monotonic clamping.
 */
export function mergeChunkedTranscriptWords<T extends TimedWordLike>(params: {
  readonly buckets: readonly ChunkWordBucket<T>[];
  readonly totalDurationSec: number;
}): Array<T & { readonly startSec: number; readonly endSec: number }> {
  const { buckets } = params;
  const totalDurationSec = Math.max(0, Number.isFinite(params.totalDurationSec) ? params.totalDurationSec : 0);

  const merged: T[] = [];
  let prevChunkEndSec: number | null = null;

  for (const bucket of buckets) {
    const incoming = bucket.words;
    if (incoming.length === 0) {
      prevChunkEndSec = bucket.chunkEndSec;
      continue;
    }

    if (merged.length === 0 || prevChunkEndSec === null || bucket.chunkStartSec >= prevChunkEndSec) {
      for (const w of incoming) {
        merged.push(w);
      }
      prevChunkEndSec = bucket.chunkEndSec;
      continue;
    }

    // Active overlap interval: [overlapStart, overlapEnd]
    const overlapStart = bucket.chunkStartSec;
    const overlapEnd = prevChunkEndSec;
    const overlapWidth = Math.max(0, overlapEnd - overlapStart);
    const seamMid = (overlapStart + overlapEnd) * 0.5;
    const edgeGuardSec = 0.06;

    const incomingCoversSeam = incoming.some(
      (w) => wordCenterSec(w) >= overlapStart - 0.1 && wordCenterSec(w) <= overlapEnd + 0.35,
    );
    const prevCoversSeam =
      merged.length > 0 && wordCenterSec(merged[merged.length - 1]) >= overlapStart - 0.15;

    // 1. Midpoint ownership trim:
    //    If both sides emitted speech across the overlap, chunk A owns centers <= seamMid
    //    and chunk B owns centers > seamMid. This cleanly discards cut edge fragments.
    if (incomingCoversSeam && prevCoversSeam && overlapWidth >= 0.2) {
      while (merged.length > 0 && wordCenterSec(merged[merged.length - 1]) > seamMid + edgeGuardSec) {
        merged.pop();
      }
    }

    let startIdx = 0;
    if (incomingCoversSeam && prevCoversSeam && overlapWidth >= 0.2) {
      while (
        startIdx < incoming.length &&
        wordCenterSec(incoming[startIdx]) < seamMid - edgeGuardSec
      ) {
        startIdx++;
      }
    }

    const tailIncoming = incoming.slice(startIdx);

    // 2. Time-gated duplicate guard ONLY inside the overlap window:
    //    Catches the exact boundary word sitting right on `seamMid` emitted by both chunks,
    //    while NEVER deleting genuine repeated words spoken outside the overlap region.
    let skipPrefix = 0;
    if (merged.length > 0 && tailIncoming.length > 0) {
      const prevTail = merged[merged.length - 1];
      const nextHead = tailIncoming[0];
      const bothInsideOverlapNeighborhood =
        prevTail.endSec >= overlapStart - 0.15 && nextHead.startSec <= overlapEnd + 0.15;

      if (bothInsideOverlapNeighborhood) {
        const maxTimeDelta = Math.max(0.45, overlapWidth + 0.25);
        const maxWin = Math.min(4, merged.length, tailIncoming.length);
        for (let k = maxWin; k >= 1; k--) {
          let allMatch = true;
          for (let j = 0; j < k; j++) {
            const leftWord = merged[merged.length - k + j];
            const rightWord = tailIncoming[j];
            const a = normalizeWordForSeamMatch(leftWord.rawText);
            const b = normalizeWordForSeamMatch(rightWord.rawText);
            const dt = Math.abs(rightWord.startSec - leftWord.startSec);
            // Must match text AND represent the same temporal utterance (not a later repetition)
            if (!a || a !== b || dt > maxTimeDelta) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            skipPrefix = k;
            break;
          }
        }
      }
    }

    for (let i = skipPrefix; i < tailIncoming.length; i++) {
      merged.push(tailIncoming[i]);
    }

    prevChunkEndSec = bucket.chunkEndSec;
  }

  // 3. Enforce strict monotonicity and [0, totalDurationSec] bounds
  const out: Array<T & { readonly startSec: number; readonly endSec: number }> = [];
  let cursorSec = 0;
  const maxAllowedEnd = totalDurationSec > 0 ? totalDurationSec : Infinity;

  for (const w of merged) {
    let startSec = Number.isFinite(w.startSec) ? Math.max(0, w.startSec) : cursorSec;
    if (startSec < cursorSec) {
      startSec = cursorSec;
    }
    if (maxAllowedEnd !== Infinity && startSec > maxAllowedEnd) {
      startSec = Math.max(0, maxAllowedEnd - 0.02);
    }

    let endSec = Number.isFinite(w.endSec) ? Math.max(startSec + 0.02, w.endSec) : startSec + 0.04;
    if (maxAllowedEnd !== Infinity && endSec > maxAllowedEnd) {
      endSec = Math.max(startSec, maxAllowedEnd);
    }
    if (endSec <= startSec && maxAllowedEnd !== Infinity) {
      startSec = Math.max(0, Math.min(startSec, maxAllowedEnd - 0.01));
      endSec = maxAllowedEnd;
    }

    const cleanStart = Number(startSec.toFixed(4));
    const cleanEnd = Number(Math.max(cleanStart + 0.001, endSec).toFixed(4));

    out.push({
      ...w,
      startSec: cleanStart,
      endSec: maxAllowedEnd !== Infinity ? Math.min(Number(maxAllowedEnd.toFixed(4)), cleanEnd) : cleanEnd,
    });

    cursorSec = cleanStart;
  }

  return out;
}
