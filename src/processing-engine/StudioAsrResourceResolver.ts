import { resampleTo16kMono } from '../engine/resampler';
import {
  encodeMono16kWavBytes,
  MAX_MONO_16K_WAV_SAMPLES,
} from '../engine/persianAsrTranscriber';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import { IncrementalSha256 } from '../utils/StreamingSha256';
import { UnifiedProcessingError } from './UnifiedProcessingContract';

const MAX_STUDIO_CLOUD_AUDIO_SECONDS = 120 as const;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
export const STUDIO_ASR_SAMPLE_RATE = 16_000 as const;

export interface StudioAudioSelectionRange {
  readonly startSec: number;
  readonly endSec: number;
  readonly trackId: string | null;
  readonly scope: 'track' | 'all';
}

export interface StudioTrackAudioAssetIdentity {
  readonly assetId: string;
  readonly assetSha256: string;
  readonly fileName: string;
  readonly sampleRate: number;
  readonly totalSamples: number;
  readonly durationSec: number;
}

export interface RawPcmRangeReader {
  readonly sampleRate: number;
  readonly totalSamples: number;
  readRange(startSample: number, count: number): Promise<Float32Array>;
}

export interface Windowed16kAudioReader {
  readonly asset: StudioTrackAudioAssetIdentity;
  readonly totalSamples16k: number;
  readonly sampleRate16k: typeof STUDIO_ASR_SAMPLE_RATE;
  readonly readSamples16kFn: (startSample16k: number, count16k: number) => Promise<Float32Array>;
}

export interface PreparedCloudSelectedAudio {
  readonly projectId: string;
  readonly trackId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly fileName: string;
  readonly selectionStartSec: number;
  readonly selectionEndSec: number;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly sampleCount16k: number;
  readonly actualDurationSec: number;
  readonly wavBytes: Uint8Array;
  readonly payloadSha256: string;
}

/**
 * Validates canonical 64-hex SHA-256 identity of a track audio asset.
 * When an asset does not carry a persisted SHA-256 yet (e.g. legacy fixture),
 * callers can compute one deterministically via `computeFloat32PcmSha256`.
 */
export function assertValidSha256Hex(sha256Hex: string | null | undefined, label: string): string {
  if (typeof sha256Hex !== 'string' || !SHA256_HEX_RE.test(sha256Hex.trim().toLowerCase())) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: 'LOCAL',
      detailEn: `${label} must be a valid 64-character lowercase SHA-256 hex digest.`,
    });
  }
  return sha256Hex.trim().toLowerCase();
}

export function computeFloat32PcmSha256(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return new IncrementalSha256().update(bytes).digestHex();
}

export function computeBytesSha256(bytes: Uint8Array): string {
  return new IncrementalSha256().update(bytes).digestHex();
}

/**
 * Wraps an already-loaded mono Float32Array into a range reader without duplicating it.
 */
export function createInMemoryPcmRangeReader(
  pcm: Float32Array,
  sampleRate: number,
): RawPcmRangeReader {
  return {
    sampleRate,
    totalSamples: pcm.length,
    async readRange(startSample: number, count: number): Promise<Float32Array> {
      const clampedStart = Math.max(0, Math.min(pcm.length, Math.floor(startSample)));
      const clampedEnd = Math.max(clampedStart, Math.min(pcm.length, clampedStart + Math.floor(count)));
      return pcm.subarray(clampedStart, clampedEnd);
    },
  };
}

/**
 * Creates a bounded, windowed 16 kHz mono PCM reader for LOCAL ONNX ASR.
 *
 * CRITICAL MEMORY INVARIANT (AVP-013):
 * Never allocates a second full-duration 16 kHz Float32Array for the entire track.
 * Reads ONLY the requested 16 kHz window (+ small Kaiser-sinc boundary padding)
 * on demand, reserves transient buffer memory in `MemoryBudgetManager`, and releases
 * the reservation inside `finally`.
 */
export function createWindowed16kAudioReader(params: {
  readonly asset: StudioTrackAudioAssetIdentity;
  readonly sourceReader: RawPcmRangeReader;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly ownerTag?: string;
}): Windowed16kAudioReader {
  const { asset, sourceReader } = params;
  const inputSampleRate = sourceReader.sampleRate;
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
    throw new UnifiedProcessingError({
      code: 'UNSUPPORTED_AUDIO_FORMAT',
      executionMode: 'LOCAL',
      detailEn: `Invalid source audio sampleRate: ${inputSampleRate}`,
    });
  }
  const totalInputSamples = Math.max(0, Math.floor(sourceReader.totalSamples));
  const ratio = inputSampleRate / STUDIO_ASR_SAMPLE_RATE;
  const totalSamples16k =
    inputSampleRate === STUDIO_ASR_SAMPLE_RATE
      ? totalInputSamples
      : Math.floor(totalInputSamples / ratio);

  const budget = params.memoryBudgetManager ?? getSharedMemoryBudgetManager();
  const ownerTag = params.ownerTag ?? `studio-asr-window-reader:${asset.assetId}`;

  return {
    asset,
    totalSamples16k,
    sampleRate16k: STUDIO_ASR_SAMPLE_RATE,
    async readSamples16kFn(startSample16k: number, count16k: number): Promise<Float32Array> {
      const safeStart16k = Math.max(0, Math.floor(startSample16k));
      const safeCount16k = Math.max(0, Math.min(Math.floor(count16k), totalSamples16k - safeStart16k));
      if (safeCount16k <= 0) {
        return new Float32Array(0);
      }

      if (inputSampleRate === STUDIO_ASR_SAMPLE_RATE) {
        const slice = await sourceReader.readRange(safeStart16k, safeCount16k);
        const out = new Float32Array(slice.length);
        out.set(slice);
        return out;
      }

      // Compute integer source window + Kaiser-sinc filter padding (~32 output samples on each side)
      const pad16k = 32;
      const paddedStart16k = Math.max(0, safeStart16k - pad16k);
      const paddedEnd16k = Math.min(totalSamples16k, safeStart16k + safeCount16k + pad16k);
      const srcStart = Math.max(0, Math.floor(paddedStart16k * ratio));
      const srcEnd = Math.min(totalInputSamples, Math.ceil(paddedEnd16k * ratio) + Math.ceil(ratio) + 4);
      const srcCount = Math.max(0, srcEnd - srcStart);
      if (srcCount === 0) {
        return new Float32Array(0);
      }

      let transientReservation: MemoryReservation | null = null;
      try {
        const estimatedBytes =
          srcCount * Float32Array.BYTES_PER_ELEMENT +
          (paddedEnd16k - paddedStart16k + 64) * Float32Array.BYTES_PER_ELEMENT;
        transientReservation = budget.reserve({
          owner: `${ownerTag}:${safeStart16k}`,
          category: 'asr-input-windows',
          bytes: estimatedBytes,
          priority: 'normal',
        });

        const rawSlice = await sourceReader.readRange(srcStart, srcCount);
        const resampled = resampleTo16kMono([rawSlice], inputSampleRate, STUDIO_ASR_SAMPLE_RATE).samples;

        // Trim exact leading pad corresponding to (safeStart16k - srcStart / ratio)
        const expectedLead16k = Math.max(0, Math.round(safeStart16k - srcStart / ratio));
        const trimStart = Math.min(resampled.length, expectedLead16k);
        const trimEnd = Math.min(resampled.length, trimStart + safeCount16k);
        const out = new Float32Array(trimEnd - trimStart);
        out.set(resampled.subarray(trimStart, trimEnd));
        return out;
      } finally {
        budget.release(transientReservation);
      }
    },
  };
}

/**
 * Strictly prepares a bounded 16 kHz Mono PCM16 WAV snippet for an explicit CLOUD ASR selection.
 *
 * Enforces:
 * - Explicit waveform selection on the active track (`scope === 'track'`, `selection.trackId === trackId`)
 * - Valid bounds (`0 <= startSec < endSec <= assetDurationSec`)
 * - Exact integer 16 kHz sample bounds
 * - Actual resampled duration strictly `<= 120` seconds (never full-track loop)
 * - Deterministic SHA-256 computed over the exact transmitted WAV bytes
 */
export async function prepareSelectedCloudAudio(params: {
  readonly projectId: string;
  readonly trackId: string;
  readonly asset: StudioTrackAudioAssetIdentity;
  readonly sourceReader: RawPcmRangeReader;
  readonly selection: StudioAudioSelectionRange | null;
  readonly memoryBudgetManager?: MemoryBudgetManager;
}): Promise<PreparedCloudSelectedAudio> {
  const { projectId, trackId, asset, sourceReader, selection } = params;

  if (!selection) {
    throw new UnifiedProcessingError({
      code: 'CLOUD_SELECTION_REQUIRED',
      executionMode: 'CLOUD',
      detailEn: 'Cloud transcription requires an explicit waveform time selection on the active track.',
    });
  }

  if (selection.scope !== 'track' || selection.trackId !== trackId) {
    throw new UnifiedProcessingError({
      code: 'CLOUD_SELECTION_REQUIRED',
      executionMode: 'CLOUD',
      detailEn: 'Cloud transcription selection must target the active track only (scope="track").',
    });
  }

  const assetSha256 = assertValidSha256Hex(asset.assetSha256, 'assetSha256');
  const sampleRate = sourceReader.sampleRate;
  const totalInputSamples = Math.max(0, Math.floor(sourceReader.totalSamples));
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || totalInputSamples === 0) {
    throw new UnifiedProcessingError({
      code: 'UNSUPPORTED_AUDIO_FORMAT',
      executionMode: 'CLOUD',
      detailEn: 'Selected track has no valid PCM audio samples.',
    });
  }

  const assetDurationSec = totalInputSamples / sampleRate;
  if (
    !Number.isFinite(selection.startSec) ||
    !Number.isFinite(selection.endSec) ||
    selection.startSec < 0 ||
    selection.endSec <= selection.startSec ||
    selection.endSec > assetDurationSec + 0.01
  ) {
    throw new UnifiedProcessingError({
      code: 'CLOUD_SELECTION_REQUIRED',
      executionMode: 'CLOUD',
      detailEn: `Selection bounds [${selection.startSec}, ${selection.endSec}] are invalid for track duration ${assetDurationSec.toFixed(3)}s.`,
    });
  }

  const clampedEndSec = Math.min(selection.endSec, assetDurationSec);
  const selectedDurationSec = clampedEndSec - selection.startSec;
  if (selectedDurationSec > MAX_STUDIO_CLOUD_AUDIO_SECONDS) {
    throw new UnifiedProcessingError({
      code: 'CLOUD_SELECTION_EXCEEDS_LIMIT',
      executionMode: 'CLOUD',
      detailEn: `Selected audio duration (${selectedDurationSec.toFixed(2)}s) exceeds the hard 120-second Cloud snippet limit.`,
    });
  }

  const startSample16k = Math.max(0, Math.floor(selection.startSec * STUDIO_ASR_SAMPLE_RATE));
  const endSample16k = Math.max(
    startSample16k + 1,
    Math.round(clampedEndSec * STUDIO_ASR_SAMPLE_RATE),
  );
  const requestedSamples16k = endSample16k - startSample16k;
  if (requestedSamples16k > MAX_MONO_16K_WAV_SAMPLES) {
    throw new UnifiedProcessingError({
      code: 'CLOUD_SELECTION_EXCEEDS_LIMIT',
      executionMode: 'CLOUD',
      detailEn: `Selected 16kHz sample count (${requestedSamples16k}) exceeds the hard 120-second limit.`,
    });
  }

  const windowedReader = createWindowed16kAudioReader({
    asset: { ...asset, assetSha256 },
    sourceReader,
    memoryBudgetManager: params.memoryBudgetManager,
    ownerTag: `studio-cloud-snippet:${asset.assetId}`,
  });

  const pcm16kSlice = await windowedReader.readSamples16kFn(startSample16k, requestedSamples16k);
  if (pcm16kSlice.length === 0) {
    throw new UnifiedProcessingError({
      code: 'UNSUPPORTED_AUDIO_FORMAT',
      executionMode: 'CLOUD',
      detailEn: 'Selected waveform range produced zero 16kHz audio samples.',
    });
  }
  if (pcm16kSlice.length > MAX_MONO_16K_WAV_SAMPLES) {
    throw new UnifiedProcessingError({
      code: 'CLOUD_SELECTION_EXCEEDS_LIMIT',
      executionMode: 'CLOUD',
      detailEn: `Resampled 16kHz snippet (${pcm16kSlice.length} samples) exceeds the 120-second limit.`,
    });
  }

  const wavBytes = encodeMono16kWavBytes(pcm16kSlice, STUDIO_ASR_SAMPLE_RATE);
  const payloadSha256 = computeBytesSha256(wavBytes);
  const actualEndSample16k = startSample16k + pcm16kSlice.length;

  return {
    projectId,
    trackId,
    assetId: asset.assetId,
    assetSha256,
    fileName: asset.fileName,
    selectionStartSec: selection.startSec,
    selectionEndSec: clampedEndSec,
    startSample16k,
    endSample16k: actualEndSample16k,
    sampleCount16k: pcm16kSlice.length,
    actualDurationSec: pcm16kSlice.length / STUDIO_ASR_SAMPLE_RATE,
    wavBytes,
    payloadSha256,
  };
}
