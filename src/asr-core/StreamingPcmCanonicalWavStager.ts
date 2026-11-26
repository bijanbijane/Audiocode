import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  streamPcmSourceAsCanonicalWav,
  type StreamCanonicalPcmWavOptions,
  type StreamCanonicalPcmWavResult,
} from './StreamingCanonicalPcmWav';

export interface StagedCanonicalWav extends StreamCanonicalPcmWavResult {
  readonly directoryPath: string;
  readonly filePath: string;
  cleanup(): Promise<void>;
}

/** Writes canonical WAV chunks to a private temporary file with O(chunk-size) memory use. */
export async function stagePcmSourceAsCanonicalWav(
  options: Omit<StreamCanonicalPcmWavOptions, 'onWavChunk'>,
): Promise<StagedCanonicalWav> {
  const directoryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'avp-shahab-source-'));
  const filePath = path.join(directoryPath, 'source-16k-mono-f32.wav');
  let handle: fs.promises.FileHandle | null = null;
  let fileOffset = 0;
  try {
    handle = await fs.promises.open(filePath, 'wx', 0o600);
    const writeAll = async (bytes: Uint8Array) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (options.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const { bytesWritten } = await handle!.write(buffer, offset, bytes.byteLength - offset, fileOffset + offset);
        if (bytesWritten <= 0) throw new Error('CANONICAL_WAV_WRITE_STALLED');
        offset += bytesWritten;
      }
      fileOffset += bytes.byteLength;
    };

    const result = await streamPcmSourceAsCanonicalWav({ ...options, onWavChunk: writeAll });
    await handle.sync();
    await handle.close();
    handle = null;

    const stat = await fs.promises.stat(filePath);
    if (stat.size !== result.totalWavBytes) {
      throw new Error(`CANONICAL_WAV_FILE_SIZE_MISMATCH: expected ${result.totalWavBytes}, got ${stat.size}.`);
    }

    return {
      ...result,
      directoryPath,
      filePath,
      cleanup: async () => {
        await fs.promises.rm(directoryPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(directoryPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
