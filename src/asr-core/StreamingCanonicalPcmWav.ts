import { resampleChunkedTo16kStream } from '../engine/resampler';

export interface StreamingPcmSource {
  readonly sampleRate: number;
  readonly totalSamples: number;
  readonly readSourceRange: (startSample: number, count: number) => Promise<Float32Array>;
}

export interface StreamCanonicalPcmWavOptions extends StreamingPcmSource {
  readonly signal?: AbortSignal;
  readonly chunkSizeSamples?: number;
  readonly onWavChunk: (chunk: Uint8Array) => Promise<void> | void;
  readonly onProgress?: (percent: number) => void;
}

export interface StreamCanonicalPcmWavResult {
  readonly sampleRate: 16_000;
  readonly channels: 1;
  readonly sampleCount: number;
  readonly dataBytes: number;
  readonly totalWavBytes: number;
  readonly resampler: {
    readonly cutoffHz: number;
    readonly filterTaps: number;
    readonly aliasingAttenuationDb: number;
  };
}

function createFloat32MonoWavHeader(sampleCount: number): Uint8Array {
  const dataBytes = sampleCount * 4;
  if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0 || dataBytes > 0xffff_ffff - 36) {
    throw new RangeError(`CANONICAL_WAV_SIZE_UNSUPPORTED: ${dataBytes} data bytes cannot be represented by a RIFF WAV header.`);
  }

  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 16_000 * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * Resamples a source range-reader to canonical 16 kHz mono Float32 WAV chunks.
 * This module is browser-safe: it does not import Node APIs and never allocates the full file.
 */
export async function streamPcmSourceAsCanonicalWav(
  options: StreamCanonicalPcmWavOptions,
): Promise<StreamCanonicalPcmWavResult> {
  if (!Number.isInteger(options.sampleRate) || options.sampleRate < 8_000 || options.sampleRate > 192_000) {
    throw new RangeError('INVALID_SOURCE_SAMPLE_RATE: expected an integer sample rate from 8000 to 192000 Hz.');
  }
  if (!Number.isSafeInteger(options.totalSamples) || options.totalSamples <= 0) {
    throw new RangeError('INVALID_SOURCE_SAMPLE_COUNT: expected a positive safe integer sample count.');
  }
  if (options.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');

  const expectedOutputSamples = Math.floor(options.totalSamples / (options.sampleRate / 16_000));
  const header = createFloat32MonoWavHeader(expectedOutputSamples);
  await options.onWavChunk(header);

  let lastProgress = -1;
  const result = await resampleChunkedTo16kStream({
    inputSampleRate: options.sampleRate,
    targetSampleRate: 16_000,
    totalInputSamples: options.totalSamples,
    chunkSizeSamples: options.chunkSizeSamples ?? 16_384,
    abortSignal: options.signal,
    readInputChunkFn: async (startSample, count) => {
      if (options.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
      const sourceChunk = await options.readSourceRange(startSample, count);
      if (!(sourceChunk instanceof Float32Array) || sourceChunk.length !== count) {
        throw new Error(
          `SOURCE_RANGE_LENGTH_MISMATCH: requested ${count} Float32 samples at ${startSample}, received ${sourceChunk instanceof Float32Array ? sourceChunk.length : 'non-Float32 data'}.`,
        );
      }
      const clean = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const value = sourceChunk[i];
        clean[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      }
      return clean;
    },
    onOutputChunk: async (samples) => {
      if (options.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
      const bytes = new Uint8Array(samples.length * 4);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i++) {
        const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
        view.setFloat32(i * 4, value, true);
      }
      await options.onWavChunk(bytes);
    },
    onProgress: (percent) => {
      if (percent !== lastProgress) {
        lastProgress = percent;
        options.onProgress?.(percent);
      }
    },
  });

  if (result.totalOutputSamples !== expectedOutputSamples) {
    throw new Error(
      `RESAMPLER_SAMPLE_COUNT_MISMATCH: expected ${expectedOutputSamples}, got ${result.totalOutputSamples}.`,
    );
  }

  const dataBytes = result.totalOutputSamples * 4;
  return {
    sampleRate: 16_000,
    channels: 1,
    sampleCount: result.totalOutputSamples,
    dataBytes,
    totalWavBytes: 44 + dataBytes,
    resampler: {
      cutoffHz: result.cutoffHz,
      filterTaps: result.filterTaps,
      aliasingAttenuationDb: result.aliasingAttenuationDb,
    },
  };
}
