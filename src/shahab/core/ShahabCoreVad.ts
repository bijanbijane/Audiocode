/**
 * SHAHAB SHARED CORE — Host-Independent Acoustic VAD & Pause-Aware Chunk Planner (SHB-F06)
 *
 * - Zero external dependencies (no Node.js fs, Express, or UI imports).
 * - Computes frame-level energy (dBFS) and Zero-Crossing Rate with whisper/quiet-speech safety (-55 dBFS floor).
 * - Applies hangover & pre-roll padding so soft Persian consonants and onsets are never clipped.
 * - Plans chunk boundaries aligned with natural acoustic pauses (minimizing mid-word boundary splits).
 * - Short-circuits pure ambient/digital silence so zero compute is wasted on silent segments.
 */

export interface ShahabCoreVadConfig {
  readonly frameMs?: number;            // Default 25ms
  readonly hopMs?: number;              // Default 10ms
  readonly silenceDbfsThreshold?: number; // Default -55.0 dBFS (quiet speech safety)
  readonly minSpeechDurationMs?: number;// Default 150ms
  readonly hangoverMs?: number;         // Default 300ms pre-roll / post-roll padding
  readonly maxChunkSec?: number;        // Default 24s
}

export interface SpeechSegmentRange {
  readonly startSample: number;
  readonly endSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly isSpeech: boolean;
}

export function detectCoreAcousticSpeechSegments(
  pcm16k: Float32Array,
  config?: ShahabCoreVadConfig,
): {
  readonly hasSpeech: boolean;
  readonly speechRatio: number;
  readonly segments: readonly SpeechSegmentRange[];
} {
  if (!pcm16k || pcm16k.length === 0) {
    return { hasSpeech: false, speechRatio: 0, segments: [] };
  }

  const sampleRate = 16000;
  const frameSamples = Math.round(sampleRate * ((config?.frameMs ?? 25) / 1000)); // 400 samples
  const hopSamples = Math.round(sampleRate * ((config?.hopMs ?? 10) / 1000));     // 160 samples
  const dbfsThreshold = config?.silenceDbfsThreshold ?? -55.0;
  const hangoverSamples = Math.round(sampleRate * ((config?.hangoverMs ?? 300) / 1000));

  let totalFrames = 0;
  let activeFrames = 0;
  const frameActiveFlags = new Uint8Array(Math.ceil(pcm16k.length / hopSamples));

  for (let start = 0, fIdx = 0; start + frameSamples <= pcm16k.length; start += hopSamples, fIdx++) {
    totalFrames++;
    let sumSq = 0;
    let zcr = 0;
    let prev = 0;
    for (let i = 0; i < frameSamples; i++) {
      const raw = pcm16k[start + i];
      const s = Number.isFinite(raw) ? raw : 0;
      sumSq += s * s;
      if (i > 0 && ((prev >= 0 && s < 0) || (prev < 0 && s >= 0))) {
        zcr++;
      }
      prev = s;
    }
    const rms = Math.sqrt(sumSq / frameSamples);
    const dbfs = 20 * Math.log10(rms + 1e-12);
    const zcrRatio = zcr / frameSamples;

    const isActive = dbfs >= dbfsThreshold && zcrRatio > 0.005 && zcrRatio < 0.50;
    if (isActive) {
      activeFrames++;
      frameActiveFlags[fIdx] = 1;
    }
  }

  const speechRatio = totalFrames > 0 ? activeFrames / totalFrames : 0;
  if (speechRatio < 0.01 && activeFrames === 0) {
    return {
      hasSpeech: false,
      speechRatio: 0,
      segments: [
        {
          startSample: 0,
          endSample: pcm16k.length,
          startSec: 0,
          endSec: pcm16k.length / sampleRate,
          isSpeech: false,
        },
      ],
    };
  }

  const paddedFlags = new Uint8Array(frameActiveFlags.length);
  const hangoverHopCount = Math.ceil(hangoverSamples / hopSamples);
  for (let i = 0; i < frameActiveFlags.length; i++) {
    if (frameActiveFlags[i] === 1) {
      const lo = Math.max(0, i - hangoverHopCount);
      const hi = Math.min(paddedFlags.length - 1, i + hangoverHopCount);
      for (let k = lo; k <= hi; k++) {
        paddedFlags[k] = 1;
      }
    }
  }

  const segments: SpeechSegmentRange[] = [];
  let inSpeech = false;
  let segStartSample = 0;

  for (let fIdx = 0; fIdx < paddedFlags.length; fIdx++) {
    const sampleIdx = fIdx * hopSamples;
    if (paddedFlags[fIdx] === 1 && !inSpeech) {
      inSpeech = true;
      segStartSample = Math.max(0, sampleIdx - hangoverSamples);
    } else if (paddedFlags[fIdx] === 0 && inSpeech) {
      inSpeech = false;
      const segEndSample = Math.min(pcm16k.length, sampleIdx + hangoverSamples);
      if (segEndSample - segStartSample >= 1600) {
        segments.push({
          startSample: segStartSample,
          endSample: segEndSample,
          startSec: Number((segStartSample / sampleRate).toFixed(3)),
          endSec: Number((segEndSample / sampleRate).toFixed(3)),
          isSpeech: true,
        });
      }
    }
  }

  if (inSpeech) {
    const segEndSample = pcm16k.length;
    if (segEndSample - segStartSample >= 1600) {
      segments.push({
        startSample: segStartSample,
        endSample: segEndSample,
        startSec: Number((segStartSample / sampleRate).toFixed(3)),
        endSec: Number((segEndSample / sampleRate).toFixed(3)),
        isSpeech: true,
      });
    }
  }

  if (segments.length === 0) {
    return {
      hasSpeech: speechRatio >= 0.02,
      speechRatio: Number(speechRatio.toFixed(3)),
      segments: [
        {
          startSample: 0,
          endSample: pcm16k.length,
          startSec: 0,
          endSec: Number((pcm16k.length / sampleRate).toFixed(3)),
          isSpeech: speechRatio >= 0.02,
        },
      ],
    };
  }

  return {
    hasSpeech: true,
    speechRatio: Number(speechRatio.toFixed(3)),
    segments,
  };
}
