import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeStreamingAudioIngestTranscoder,
  StreamedAsrWindowChunk,
} from './NodeStreamingAudioIngestTranscoder';

describe('Section 129: NodeStreamingAudioIngestTranscoder', () => {
  it('handles unaligned byte chunks, emits overlapping 16kHz windows, and blocks decompression bombs', async () => {
    // Generate 1.5s of Float32LE samples (24,000 samples = 96,000 bytes) split into unaligned 1003-byte chunks
    const totalSamples = 24000;
    const rawBuf = Buffer.alloc(totalSamples * 4);
    for (let i = 0; i < totalSamples; i++) {
      rawBuf.writeFloatLE(0.25, i * 4);
    }

    async function* makeUnalignedStream() {
      let pos = 0;
      while (pos < rawBuf.length) {
        const end = Math.min(rawBuf.length, pos + 1003); // Odd byte length to test 4-byte alignment carryover
        yield rawBuf.subarray(pos, end);
        pos = end;
      }
    }

    const windows: StreamedAsrWindowChunk[] = [];
    for await (const win of NodeStreamingAudioIngestTranscoder.chunkFloat32LeByteStreamIntoOverlappingWindows(
      {
        byteChunks: makeUnalignedStream(),
        windowDurationSec: 1.0,
        overlapDurationSec: 0.2,
        maxAllowedDurationSec: 10.0,
      },
    )) {
      windows.push(win);
    }

    assert.equal(windows.length, 2);
    assert.equal(windows[0].pcm16kMono.length, 16000);
    assert.equal(windows[0].startSample16k, 0);
    // Stride = (1.0 - 0.2) * 16000 = 12800 samples
    assert.equal(windows[1].startSample16k, 12800);
    assert.equal(windows[1].isFinalWindow, true);

    // Verify Decompression Bomb Guard
    let killed = false;
    await assert.rejects(async () => {
      for await (const _win of NodeStreamingAudioIngestTranscoder.chunkFloat32LeByteStreamIntoOverlappingWindows(
        {
          byteChunks: makeUnalignedStream(),
          windowDurationSec: 1.0,
          overlapDurationSec: 0.2,
          maxAllowedDurationSec: 0.5, // Bomb limit = 0.5s < 1.5s input
          onKillProcess: () => {
            killed = true;
          },
        },
      )) {
        // consume
      }
    }, /SECURITY_DECOMPRESSION_BOMB_GUARD/);
    assert.equal(killed, true);
  });
});
