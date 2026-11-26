/**
 * SHAHAB SHARED CORE — Host-Independent Acoustic VAD & Pause-Aware Chunk Planner (SHB-F06)
 *
 * Zero external dependencies. Uses bounded frame-level RMS/ZCR analysis, one pre/post-roll
 * expansion per speech region, minimum-duration filtering, and pause-preferred long-chunk splits.
 */

export interface ShahabCoreVadConfig {
  readonly frameMs?: number;
  readonly hopMs?: number;
  readonly silenceDbfsThreshold?: number;
  readonly minSpeechDurationMs?: number;
  readonly hangoverMs?: number;
  readonly maxChunkSec?: number;
}

export interface SpeechSegmentRange {
  readonly startSample: number;
  readonly endSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly isSpeech: boolean;
}

const SAMPLE_RATE = 16_000;

function requireFiniteRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be finite and between ${min} and ${max}.`);
  }
  return value;
}

function makeSpeechRange(startSample: number, endSample: number): SpeechSegmentRange {
  return {
    startSample,
    endSample,
    startSec: Number((startSample / SAMPLE_RATE).toFixed(3)),
    endSec: Number((endSample / SAMPLE_RATE).toFixed(3)),
    isSpeech: true,
  };
}

/**
 * Finds the quietest available frame gap near a requested boundary. If the region contains
 * uninterrupted speech, it returns the requested boundary and the caller supplies overlap.
 */
function findPauseBoundarySample(params: {
  readonly activeFlags: Uint8Array;
  readonly hopSamples: number;
  readonly fromFrame: number;
  readonly toFrame: number;
  readonly targetSample: number;
  readonly searchFrames: number;
}): number {
  const targetFrame = Math.round(params.targetSample / params.hopSamples);
  const lo = Math.max(params.fromFrame + 1, targetFrame - params.searchFrames);
  const hi = Math.min(params.toFrame - 1, targetFrame + params.searchFrames);
  let bestCenter = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = lo; i <= hi;) {
    if (params.activeFlags[i] === 1) {
      i++;
      continue;
    }
    const gapStart = i;
    while (i <= hi && params.activeFlags[i] === 0) i++;
    const center = Math.floor((gapStart + i - 1) / 2);
    const distance = Math.abs(center * params.hopSamples - params.targetSample);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCenter = center;
    }
  }

  return bestCenter >= 0 ? bestCenter * params.hopSamples : params.targetSample;
}

function splitLongSpeechRegion(params: {
  readonly rawStartSample: number;
  readonly rawEndSample: number;
  readonly audioLength: number;
  readonly activeFlags: Uint8Array;
  readonly hopSamples: number;
  readonly hangoverSamples: number;
  readonly maxChunkSamples: number;
  readonly maxChunkSec: number;
}): SpeechSegmentRange[] {
  const firstSample = Math.max(0, params.rawStartSample - params.hangoverSamples);
  const finalSample = Math.min(params.audioLength, params.rawEndSample + params.hangoverSamples);
  const overlapSamples = Math.min(params.hangoverSamples, Math.floor(params.maxChunkSamples / 20));
  const searchFrames = Math.max(1, Math.ceil((Math.min(500, params.maxChunkSec * 50) * SAMPLE_RATE / 1000) / params.hopSamples));
  const segments: SpeechSegmentRange[] = [];
  let chunkStart = firstSample;
  const firstFrame = Math.max(0, Math.floor(params.rawStartSample / params.hopSamples));
  const lastFrame = Math.min(params.activeFlags.length - 1, Math.ceil(params.rawEndSample / params.hopSamples));

  while (finalSample - chunkStart > params.maxChunkSamples) {
    const targetBoundary = chunkStart + params.maxChunkSamples - overlapSamples * 2;
    const boundary = findPauseBoundarySample({
      activeFlags: params.activeFlags,
      hopSamples: params.hopSamples,
      fromFrame: firstFrame,
      toFrame: lastFrame,
      targetSample: targetBoundary,
      searchFrames,
    });
    const safeBoundary = Math.max(
      chunkStart + overlapSamples,
      Math.min(chunkStart + params.maxChunkSamples - overlapSamples, boundary),
    );
    const chunkEnd = Math.min(finalSample, safeBoundary + overlapSamples);
    if (chunkEnd <= chunkStart) break;
    segments.push(makeSpeechRange(chunkStart, chunkEnd));
    chunkStart = Math.max(chunkStart + 1, safeBoundary - overlapSamples);
  }

  if (finalSample > chunkStart) {
    segments.push(makeSpeechRange(chunkStart, finalSample));
  }
  return segments;
}

export function detectCoreAcousticSpeechSegments(
  pcm16k: Float32Array,
  config?: ShahabCoreVadConfig,
): {
  readonly hasSpeech: boolean;
  readonly speechRatio: number;
  readonly segments: readonly SpeechSegmentRange[];
} {
  if (!(pcm16k instanceof Float32Array) || pcm16k.length === 0) {
    return { hasSpeech: false, speechRatio: 0, segments: [] };
  }

  const frameMs = requireFiniteRange('frameMs', config?.frameMs ?? 25, 5, 100);
  const hopMs = requireFiniteRange('hopMs', config?.hopMs ?? 10, 1, frameMs);
  const dbfsThreshold = requireFiniteRange('silenceDbfsThreshold', config?.silenceDbfsThreshold ?? -55, -120, 0);
  const minSpeechDurationMs = requireFiniteRange('minSpeechDurationMs', config?.minSpeechDurationMs ?? 150, 0, 60_000);
  const hangoverMs = requireFiniteRange('hangoverMs', config?.hangoverMs ?? 300, 0, 5_000);
  const maxChunkSec = requireFiniteRange('maxChunkSec', config?.maxChunkSec ?? 24, 1, 600);

  const frameSamples = Math.max(1, Math.round(SAMPLE_RATE * frameMs / 1000));
  const hopSamples = Math.max(1, Math.round(SAMPLE_RATE * hopMs / 1000));
  const hangoverSamples = Math.round(SAMPLE_RATE * hangoverMs / 1000);
  const minSpeechSamples = Math.round(SAMPLE_RATE * minSpeechDurationMs / 1000);
  const maxChunkSamples = Math.max(frameSamples, Math.floor(SAMPLE_RATE * maxChunkSec));
  const frameCount = Math.ceil(pcm16k.length / hopSamples);
  const activeFlags = new Uint8Array(frameCount);
  let activeFrames = 0;

  // Include the final partial frame instead of silently ignoring the tail of short recordings.
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const start = frameIndex * hopSamples;
    const sampleCount = Math.min(frameSamples, pcm16k.length - start);
    if (sampleCount <= 0) continue;

    let sumSq = 0;
    let zeroCrossings = 0;
    let previous = 0;
    for (let i = 0; i < sampleCount; i++) {
      const raw = pcm16k[start + i];
      const sample = Number.isFinite(raw) ? raw : 0;
      sumSq += sample * sample;
      if (i > 0 && ((previous >= 0 && sample < 0) || (previous < 0 && sample >= 0))) {
        zeroCrossings++;
      }
      previous = sample;
    }

    const rms = Math.sqrt(sumSq / sampleCount);
    const dbfs = 20 * Math.log10(rms + 1e-12);
    const zcrRatio = sampleCount > 1 ? zeroCrossings / (sampleCount - 1) : 0;
    const isActive = dbfs >= dbfsThreshold && zcrRatio > 0.002 && zcrRatio < 0.85;
    if (isActive) {
      activeFlags[frameIndex] = 1;
      activeFrames++;
    }
  }

  const speechRatio = frameCount > 0 ? activeFrames / frameCount : 0;
  if (activeFrames === 0) {
    return {
      hasSpeech: false,
      speechRatio: 0,
      segments: [{
        startSample: 0,
        endSample: pcm16k.length,
        startSec: 0,
        endSec: Number((pcm16k.length / SAMPLE_RATE).toFixed(3)),
        isSpeech: false,
      }],
    };
  }

  const maxGapFrames = Math.ceil(hangoverSamples / hopSamples);
  const segments: SpeechSegmentRange[] = [];
  let regionStartFrame = -1;
  let lastActiveFrame = -1;

  const flushRegion = () => {
    if (regionStartFrame < 0 || lastActiveFrame < regionStartFrame) return;
    const rawStartSample = regionStartFrame * hopSamples;
    const rawEndSample = Math.min(pcm16k.length, lastActiveFrame * hopSamples + frameSamples);
    if (rawEndSample - rawStartSample >= minSpeechSamples) {
      segments.push(...splitLongSpeechRegion({
        rawStartSample,
        rawEndSample,
        audioLength: pcm16k.length,
        activeFlags,
        hopSamples,
        hangoverSamples,
        maxChunkSamples,
        maxChunkSec,
      }));
    }
    regionStartFrame = -1;
    lastActiveFrame = -1;
  };

  for (let i = 0; i <= frameCount; i++) {
    if (i < frameCount && activeFlags[i] === 1) {
      if (regionStartFrame < 0) regionStartFrame = i;
      lastActiveFrame = i;
      continue;
    }
    if (regionStartFrame >= 0 && (i === frameCount || i - lastActiveFrame - 1 > maxGapFrames)) {
      flushRegion();
    }
  }

  if (segments.length === 0) {
    return {
      hasSpeech: false,
      speechRatio: Number(speechRatio.toFixed(3)),
      segments: [{
        startSample: 0,
        endSample: pcm16k.length,
        startSec: 0,
        endSec: Number((pcm16k.length / SAMPLE_RATE).toFixed(3)),
        isSpeech: false,
      }],
    };
  }

  return {
    hasSpeech: true,
    speechRatio: Number(speechRatio.toFixed(3)),
    segments,
  };
}
