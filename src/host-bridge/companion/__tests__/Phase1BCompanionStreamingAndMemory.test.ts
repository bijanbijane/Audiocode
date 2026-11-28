/**
 * AVAPARDAZ — PHASE 1B MANDATORY VERIFICATION & MEMORY BENCHMARK SUITE
 *
 * Verifies Phase 1B ("NATIVE COMPANION STREAMING & MEMORY FOUNDATION"):
 * - Zero `fs.readFileSync` in `CompanionAudioTransfer.ts` and `LocalCompanionService.ts`
 * - File-backed `CompanionAudioSource` with `readRange`, `readPlanarChannels`, `prepareWavFileStreaming`
 * - 10-state resource lifecycle:
 *   `CREATED -> RECEIVING -> RECEIVED -> VALIDATING -> READY -> PROCESSING -> COMPLETED | CANCELLED | FAILED -> CLEANED`
 * - All 16 mandatory test scenarios from Phase 1B Section 8:
 *   1. Short WAV file -> exact output & sample values, zero mutation
 *   2. 48 kHz Stereo file -> 100% channel separation (L vs R verified sample-by-sample, zero cross-talk/downmix)
 *   3. Mono file -> exact sample count & sample values
 *   4. 30-minute large file -> zero full-file PCM allocation, bounded <= 256 KiB buffers
 *   5. 60-minute large file -> zero buffer growth proportional to file length, bounded <= 1 MiB total transfer buffers
 *   6. Incomplete chunk / truncated transfer -> controlled 422 failure & CLEANED
 *   7. Duplicate chunk -> 409 DUPLICATE_CHUNK_REJECTED
 *   8. Out-of-order chunk -> 409 OUT_OF_ORDER_CHUNK_REJECTED, zero silent corruption
 *   9. Disconnect / abort during transfer -> CANCELLED -> CLEANED
 *   10. Cancellation during processing (AbortSignal mid-stream) -> stops consumer & cleans up only after consumer stops
 *   11. Disk / write error -> releases resources & transitions FAILED -> CLEANED
 *   12. Decoder / corrupt WAV header error -> detected during VALIDATING without full-file read, FAILED -> CLEANED
 *   13. Companion restart -> detects & cleans up orphaned temp files (`cleanupOrphanedFilesOnStartup`)
 *   14. Two concurrent transfers by different sessions -> strict ownership isolation (`403 TRANSFER_OWNER_MISMATCH`)
 *   15. Reaching temp directory storage quota (`maxTotalStagingBytes`) -> controlled `507 TEMP_STORAGE_QUOTA_EXCEEDED`
 *   16. CEP reconnect (`JOB_RECONNECT`), real `drain` backpressure verification, and RF64 >4 GiB header validation
 * - Section 9 mandatory benchmarks: 10-minute, 30-minute, and 60-minute audio transfers & streaming ASR WAV preparation
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  CompanionAudioTransferManager,
  MAX_FILE_READ_BUFFER_BYTES,
  MAX_FILE_WRITE_BUFFER_BYTES,
  MAX_NETWORK_CHUNK_BYTES,
  MAX_TOTAL_LIVE_BUFFERS_PER_TRANSFER_BYTES,
  buildStreamingWavHeader,
  parseWavHeaderFromInitialBytes,
} from '../CompanionAudioTransfer';
import { COMPANION_IPC_PROTOCOL_VERSION } from '../CompanionIpcBridge';
import { LocalCompanionService } from '../LocalCompanionService';
import type { LocalNeuralTranscriptionResult } from '../../../asr-core/LocalSherpaNeuralEngine';
import { CANONICAL_CONTRACT_VERSION } from '../../../processing-engine/capabilities/CanonicalCapabilityContracts';

export interface Phase1BBenchmarkRow {
  readonly label: '10-minute' | '30-minute' | '60-minute';
  readonly durationMinutes: number;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly format: 'pcm_s16le' | 'pcm_f32le' | 'wav';
  readonly actualFileSizeBytes: number;
  readonly networkChunkSizeBytes: number;
  readonly readBufferSizeBytes: number;
  readonly writeBufferSizeBytes: number;
  readonly memoryBeforeTransferRssBytes: number;
  readonly memoryDuringTransferPeakRssBytes: number;
  readonly memoryDuringAsrPrepPeakRssBytes: number;
  readonly memoryAfterCleanupRssBytes: number;
  readonly companionPeakRssBytes: number;
  readonly peakTransferLiveBuffersBytes: number;
  readonly backpressureDrainWaits: number;
  readonly transferAndPrepElapsedMs: number;
  readonly tempFilesRemainingAfterCleanup: number;
}

export const collectedPhase1BBenchmarks: Phase1BBenchmarkRow[] = [];

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Phase 1B Architectural Gate: zero fs.readFileSync in CompanionAudioTransfer.ts and LocalCompanionService.ts', () => {
  const transferSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/host-bridge/companion/CompanionAudioTransfer.ts'),
    'utf8',
  );
  const serviceSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/host-bridge/companion/LocalCompanionService.ts'),
    'utf8',
  );

  // Strip comments before checking for executable fs.readFileSync calls
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  assert.equal(
    /readFileSync\s*\(/.test(stripComments(transferSrc)),
    false,
    'CompanionAudioTransfer.ts must not contain any executable readFileSync() calls',
  );
  assert.equal(
    /readFileSync\s*\(/.test(stripComments(serviceSrc)),
    false,
    'LocalCompanionService.ts must not contain any executable readFileSync() calls',
  );
});

test('Scenario 1 & 3: Short WAV file & Mono file exact sample fidelity, 10-state lifecycle, and consumer-gated cleanup', async () => {
  const stagingDir = createTempDir('avp-p1b-s1-');
  try {
    const mgr = new CompanionAudioTransferManager({ stagingDir });
    const sampleRateHz = 16000;
    const channels = 1;
    const frameCount = 4000; // 0.25s mono
    const pcmDataBytes = frameCount * channels * 2;
    const { header } = buildStreamingWavHeader({
      dataByteLength: pcmDataBytes,
      sampleRateHz,
      channels,
      bitsPerSample: 16,
    });
    const wavBuf = Buffer.alloc(header.byteLength + pcmDataBytes);
    header.copy(wavBuf, 0);

    const expectedSamples = new Int16Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRateHz) * 28000);
      expectedSamples[i] = val;
      wavBuf.writeInt16LE(val, header.byteLength + i * 2);
    }

    const sha256 = crypto.createHash('sha256').update(wavBuf).digest('hex');
    const init = mgr.initTransfer({
      filename: 'short-mono.wav',
      format: 'wav',
      sampleRateHz,
      channels,
      endianness: 'little',
      expectedBytes: wavBuf.byteLength,
      expectedFrames: frameCount,
      totalChunks: 2,
      expectedSha256: sha256,
      ownerId: 'cep-session-1',
    });
    assert.equal(init.ok, true);
    const transferId = init.transferId!;
    assert.match(transferId, /^xfr_[a-f0-9]{32}$/);
    assert.equal(mgr.getTransferLifecycleState(transferId), 'CREATED');

    const mid = Math.floor(wavBuf.byteLength / 2);
    const c0 = mgr.appendChunk({
      transferId,
      chunkIndex: 0,
      chunkBase64: wavBuf.subarray(0, mid).toString('base64'),
      ownerId: 'cep-session-1',
    });
    assert.equal(c0.ok, true);
    assert.equal(mgr.getTransferLifecycleState(transferId), 'RECEIVING');

    const c1 = mgr.appendChunk({
      transferId,
      chunkIndex: 1,
      chunkBase64: wavBuf.subarray(mid).toString('base64'),
      ownerId: 'cep-session-1',
    });
    assert.equal(c1.ok, true);
    assert.equal(mgr.getTransferLifecycleState(transferId), 'RECEIVED');

    const fin = mgr.finalizeTransfer(transferId, { ownerId: 'cep-session-1' });
    assert.equal(fin.ok, true);
    assert.equal(mgr.getTransferLifecycleState(transferId), 'READY');

    const acq = mgr.acquireAudioSource(transferId, { ownerId: 'cep-session-1' });
    assert.equal(acq.ok, true);
    const source = acq.source!;
    assert.equal(source.getLifecycleState(), 'PROCESSING');
    assert.equal(source.sampleRate, sampleRateHz);
    assert.equal(source.channelCount, 1);
    assert.equal(source.exactSampleCount, frameCount);

    // Temp file MUST exist while consumer is processing
    assert.equal(fs.existsSync(source.tempFilePath), true);

    // Read range and verify exact sample fidelity
    const rangeFloats = await source.readRange(0, frameCount);
    assert.equal(rangeFloats.length, frameCount);
    for (let i = 0; i < frameCount; i++) {
      const expectedFloat =
        expectedSamples[i] < 0 ? expectedSamples[i] / 32768 : expectedSamples[i] / 32767;
      assert.ok(
        Math.abs(rangeFloats[i] - expectedFloat) < 1e-6,
        `Sample mismatch at index ${i}`,
      );
    }

    // Close source and verify state history + file deletion
    await source.close('COMPLETED');
    assert.equal(source.getLifecycleState(), 'CLEANED');
    assert.deepEqual(source.getStateHistory(), [
      'CREATED',
      'RECEIVING',
      'RECEIVED',
      'VALIDATING',
      'READY',
      'PROCESSING',
      'COMPLETED',
      'CLEANED',
    ]);
    assert.equal(fs.existsSync(source.tempFilePath), false);
    assert.equal(mgr.getTotalReservedStagingBytes(), 0);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('Scenario 2: 48 kHz Stereo file — 100% channel separation (L vs R) and zero unintended mono downmix', async () => {
  const stagingDir = createTempDir('avp-p1b-s2-');
  try {
    const mgr = new CompanionAudioTransferManager({ stagingDir });
    const sampleRateHz = 48000;
    const channels = 2;
    const frameCount = 6000;
    const rawBuf = Buffer.alloc(frameCount * channels * 4); // pcm_f32le

    for (let f = 0; f < frameCount; f++) {
      const leftVal = Math.sin((2 * Math.PI * 500 * f) / sampleRateHz) * 0.75;
      const rightVal = -Math.cos((2 * Math.PI * 1200 * f) / sampleRateHz) * 0.5;
      rawBuf.writeFloatLE(leftVal, (f * 2 + 0) * 4);
      rawBuf.writeFloatLE(rightVal, (f * 2 + 1) * 4);
    }

    const init = mgr.initTransfer({
      filename: 'stereo-48k.pcm',
      format: 'pcm_f32le',
      sampleRateHz,
      channels,
      endianness: 'little',
      expectedBytes: rawBuf.byteLength,
      expectedFrames: frameCount,
      totalChunks: 1,
    
      ownerId: 'test-owner',});
    assert.equal(init.ok, true);
    const transferId = init.transferId!;

    const app = mgr.appendChunk({
      transferId,
      chunkIndex: 0,
      chunkBase64: rawBuf.toString('base64'),
    
      ownerId: 'test-owner',});
    assert.equal(app.ok, true);
    assert.equal(mgr.finalizeTransfer(transferId, { ownerId: 'test-owner' }).ok, true);

    const source = mgr.acquireAudioSource(transferId, { ownerId: 'test-owner' }).source!;
    assert.equal(source.sampleRate, 48000);
    assert.equal(source.channelCount, 2);
    assert.equal(source.exactSampleCount, frameCount);

    const planar = await source.readPlanarChannels(100, 1000);
    assert.equal(planar.length, 2);
    assert.equal(planar[0].length, 1000);
    assert.equal(planar[1].length, 1000);

    for (let i = 0; i < 1000; i++) {
      const f = 100 + i;
      const expectedL = Math.fround(Math.sin((2 * Math.PI * 500 * f) / sampleRateHz) * 0.75);
      const expectedR = Math.fround(-Math.cos((2 * Math.PI * 1200 * f) / sampleRateHz) * 0.5);
      assert.equal(planar[0][i], expectedL, `Left channel mismatch at frame ${f}`);
      assert.equal(planar[1][i], expectedR, `Right channel mismatch at frame ${f}`);
    }

    // Verify streaming WAV preparation preserves 2 channels and 48000 Hz in WAV header
    const prep = await source.prepareWavFileStreaming();
    const outHeaderBuf = Buffer.alloc(44);
    const fd = fs.openSync(prep.wavFilePath, 'r');
    fs.readSync(fd, outHeaderBuf, 0, 44, 0);
    fs.closeSync(fd);

    const parsedWav = parseWavHeaderFromInitialBytes(outHeaderBuf, prep.totalWavBytes);
    assert.equal(parsedWav.valid, true);
    assert.equal(parsedWav.channels, 2);
    assert.equal(parsedWav.sampleRateHz, 48000);
    assert.equal(parsedWav.frameCount, frameCount);

    await source.close('COMPLETED');
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('Scenarios 6, 7, 8, 9, 10, 11, 12, 13, 14, 15: Error handling, chunk order, cancel, disk failure, corrupt header, restart orphan cleanup, owner isolation, and quota', async () => {
  const stagingDir = createTempDir('avp-p1b-err-');
  try {
    // Scenario 13: Create orphaned transfer files before Companion manager starts
    const orphanPart = path.join(stagingDir, 'xfr_0123456789abcdef0123456789abcdef.part');
    const orphanWav = path.join(stagingDir, 'xfr_fedcba9876543210fedcba9876543210.prepared.wav');
    fs.writeFileSync(orphanPart, 'orphan-1');
    fs.writeFileSync(orphanWav, 'orphan-2');

    const mgr = new CompanionAudioTransferManager({
      stagingDir,
      maxConcurrentTransfers: 2,
      maxTotalStagingBytes: 4096,
    });
    assert.equal(mgr.getOrphanedFilesCleanedOnStartup(), 2);
    assert.equal(fs.existsSync(orphanPart), false);
    assert.equal(fs.existsSync(orphanWav), false);

    // Scenario 6: Incomplete chunk / truncated finalize -> 422 & CLEANED
    const s6 = mgr.initTransfer({
      format: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 400,
      expectedFrames: 200,
      totalChunks: 2,
    
      ownerId: 'test-owner',});
    assert.equal(s6.ok, true);
    mgr.appendChunk({
      transferId: s6.transferId!,
      chunkIndex: 0,
      chunkBase64: Buffer.alloc(200).toString('base64'),
    
      ownerId: 'test-owner',});
    const fin6 = mgr.finalizeTransfer(s6.transferId!, { ownerId: 'test-owner' });
    assert.equal(fin6.ok, false);
    assert.equal(fin6.statusCode, 422);
    assert.equal(fin6.code, 'TRANSFER_INCOMPLETE_CHUNKS');
    assert.equal(mgr.getTransferLifecycleState(s6.transferId!), 'CLEANED');

    // Scenario 7 & 8: Duplicate chunk & Out-of-order chunk
    const s78 = mgr.initTransfer({
      format: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 600,
      expectedFrames: 300,
      totalChunks: 3,
    
      ownerId: 'test-owner',});
    const tid78 = s78.transferId!;
    // Out-of-order chunk 1 before 0
    const ooo = mgr.appendChunk({
      transferId: tid78,
      chunkIndex: 1,
      chunkBase64: Buffer.alloc(200).toString('base64'),
    
      ownerId: 'test-owner',});
    assert.equal(ooo.ok, false);
    assert.equal(ooo.statusCode, 409);
    assert.equal(ooo.code, 'OUT_OF_ORDER_CHUNK_REJECTED');

    // Valid chunk 0
    assert.equal(
      mgr.appendChunk({
        transferId: tid78,
        chunkIndex: 0,
        chunkBase64: Buffer.alloc(200).toString('base64'),
      
      ownerId: 'test-owner',}).ok,
      true,
    );
    // Duplicate chunk 0
    const dup = mgr.appendChunk({
      transferId: tid78,
      chunkIndex: 0,
      chunkBase64: Buffer.alloc(200).toString('base64'),
    
      ownerId: 'test-owner',});
    assert.equal(dup.ok, false);
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.code, 'DUPLICATE_CHUNK_REJECTED');

    // Scenario 9: Disconnect / abort during transfer -> CANCELLED -> CLEANED
    assert.equal(mgr.abortTransfer(tid78, { ownerId: 'test-owner' }), true);
    assert.equal(mgr.getTransferLifecycleState(tid78), 'CLEANED');
    assert.deepEqual(mgr.getTransferStateHistory(tid78), [
      'CREATED',
      'RECEIVING',
      'CANCELLED',
      'CLEANED',
    ]);

    // Scenario 10: Cancellation during processing via AbortSignal
    const s10 = mgr.initTransfer({
      format: 'pcm_f32le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 1600,
      expectedFrames: 400,
      totalChunks: 1,
    
      ownerId: 'test-owner',});
    const tid10 = s10.transferId!;
    mgr.appendChunk({
      transferId: tid10,
      chunkIndex: 0,
      chunkBase64: Buffer.alloc(1600).toString('base64'),
    
      ownerId: 'test-owner',});
    mgr.finalizeTransfer(tid10, { ownerId: 'test-owner' });
    const src10 = mgr.acquireAudioSource(tid10, { ownerId: 'test-owner' }).source!;
    const abortCtrl10 = new AbortController();
    await assert.rejects(
      async () => {
        await src10.prepareWavFileStreaming({
          signal: abortCtrl10.signal,
          onChunkWritten: () => {
            abortCtrl10.abort();
          },
        });
      },
      /TRANSFER_PROCESSING_ABORTED/,
    );
    await src10.close('CANCELLED');
    assert.equal(src10.getLifecycleState(), 'CLEANED');
    assert.deepEqual(src10.getStateHistory(), [
      'CREATED',
      'RECEIVING',
      'RECEIVED',
      'VALIDATING',
      'READY',
      'PROCESSING',
      'CANCELLED',
      'CLEANED',
    ]);

    // Scenario 11: Disk write error during chunk append -> FAILED -> CLEANED
    const s11 = mgr.initTransfer({
      format: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 400,
      expectedFrames: 200,
      totalChunks: 2,
    
      ownerId: 'test-owner',});
    const tid11 = s11.transferId!;
    // Simulate unexpected closed/corrupted fd by closing the internal writeFd
    const internalSessions = (mgr as unknown as { sessions: Map<string, { writeFd: number }> }).sessions;
    const rawSess11 = internalSessions.get(tid11)!;
    fs.closeSync(rawSess11.writeFd);
    const errChunk = mgr.appendChunk({
      transferId: tid11,
      chunkIndex: 0,
      chunkBase64: Buffer.alloc(200).toString('base64'),
    
      ownerId: 'test-owner',});
    assert.equal(errChunk.ok, false);
    assert.equal(errChunk.statusCode, 500);
    assert.equal(errChunk.code, 'DISK_WRITE_ERROR');
    assert.equal(mgr.getTransferLifecycleState(tid11), 'CLEANED');
    assert.deepEqual(mgr.getTransferStateHistory(tid11), ['CREATED', 'RECEIVING', 'FAILED', 'CLEANED']);

    // Scenario 12: Corrupt WAV header -> detected during VALIDATING -> FAILED -> CLEANED
    const corruptWav = Buffer.alloc(128, 0x42); // Not RIFF/WAVE
    const s12 = mgr.initTransfer({
      format: 'wav',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: corruptWav.byteLength,
      expectedFrames: 40,
      totalChunks: 1,
    
      ownerId: 'test-owner',});
    const tid12 = s12.transferId!;
    mgr.appendChunk({
      transferId: tid12,
      chunkIndex: 0,
      chunkBase64: corruptWav.toString('base64'),
    
      ownerId: 'test-owner',});
    const fin12 = mgr.finalizeTransfer(tid12, { ownerId: 'test-owner' });
    assert.equal(fin12.ok, false);
    assert.equal(fin12.statusCode, 422);
    assert.equal(fin12.code, 'INVALID_WAV_HEADER');
    assert.equal(mgr.getTransferLifecycleState(tid12), 'CLEANED');
    assert.deepEqual(mgr.getTransferStateHistory(tid12), [
      'CREATED',
      'RECEIVING',
      'RECEIVED',
      'VALIDATING',
      'FAILED',
      'CLEANED',
    ]);

    // Scenario 14 & 15: Two concurrent transfers (Owner isolation + Temp Storage Quota)
    const s14A = mgr.initTransfer({
      format: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 2000,
      expectedFrames: 1000,
      totalChunks: 1,
      ownerId: 'owner-A',
    });
    assert.equal(s14A.ok, true);

    // Scenario 15: Exceed 4096-byte total staging quota -> 507 TEMP_STORAGE_QUOTA_EXCEEDED
    const s15Quota = mgr.initTransfer({
      format: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 3000,
      expectedFrames: 1500,
      totalChunks: 1,
      ownerId: 'owner-B',
    });
    assert.equal(s15Quota.ok, false);
    assert.equal(s15Quota.statusCode, 507);
    assert.equal(s15Quota.code, 'TEMP_STORAGE_QUOTA_EXCEEDED');

    // Second concurrent transfer within quota
    const s14B = mgr.initTransfer({
      format: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 1000,
      expectedFrames: 500,
      totalChunks: 1,
      ownerId: 'owner-B',
    });
    assert.equal(s14B.ok, true);

    // Cross-owner chunk append rejected with 403 TRANSFER_OWNER_MISMATCH
    const hijack = mgr.appendChunk({
      transferId: s14A.transferId!,
      chunkIndex: 0,
      chunkBase64: Buffer.alloc(2000).toString('base64'),
      ownerId: 'owner-B',
    });
    assert.equal(hijack.ok, false);
    assert.equal(hijack.statusCode, 403);
    assert.equal(hijack.code, 'TRANSFER_OWNER_MISMATCH');

    // Complete Transfer B while Transfer A is still open; verify Transfer A's temp file is untouched
    mgr.appendChunk({
      transferId: s14B.transferId!,
      chunkIndex: 0,
      chunkBase64: Buffer.alloc(1000).toString('base64'),
      ownerId: 'owner-B',
    });
    mgr.finalizeTransfer(s14B.transferId!, { ownerId: 'owner-B' });
    const srcB = mgr.acquireAudioSource(s14B.transferId!, { ownerId: 'owner-B' }).source!;
    await srcB.close('COMPLETED');

    assert.equal(mgr.getTransferLifecycleState(s14B.transferId!), 'CLEANED');
    assert.equal(mgr.getTransferLifecycleState(s14A.transferId!), 'CREATED');
    mgr.abortTransfer(s14A.transferId!, { ownerId: 'owner-A' });
    assert.equal(mgr.getTotalReservedStagingBytes(), 0);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('Scenario 16: Real drain backpressure verification, RF64 (>4 GiB) header builder, and CEP JOB_RECONNECT over loopback IPC', async () => {
  const stagingDir = createTempDir('avp-p1b-s16-');
  try {
    // 1. Verify RF64 header generation & parsing when dataByteLength > 4 GiB
    const fiveGiB = 5 * 1024 * 1024 * 1024;
    const rf64Built = buildStreamingWavHeader({
      dataByteLength: fiveGiB,
      sampleRateHz: 48000,
      channels: 2,
      bitsPerSample: 16,
    });
    assert.equal(rf64Built.isRf64, true);
    assert.equal(rf64Built.header.byteLength, 80);
    const rf64Parsed = parseWavHeaderFromInitialBytes(rf64Built.header, fiveGiB + 80);
    assert.equal(rf64Parsed.valid, true);
    assert.equal(rf64Parsed.isRf64, true);
    assert.equal(rf64Parsed.dataByteLength, fiveGiB);

    // 2. Verify real WriteStream drain backpressure with tight writeHighWaterMarkBytes (4 KiB) on a 1 MiB transfer
    const mgr = new CompanionAudioTransferManager({ stagingDir });
    const totalBytes = 1024 * 1024; // 1 MiB pcm_f32le
    const chunkSize = 256 * 1024;
    const init = mgr.initTransfer({
      format: 'pcm_f32le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: totalBytes,
      expectedFrames: totalBytes / 4,
      totalChunks: 4,
    
      ownerId: 'test-owner',});
    const chunkBuf = Buffer.alloc(chunkSize);
    for (let i = 0; i < 4; i++) {
      assert.equal(
        mgr.appendChunk({
          transferId: init.transferId!,
          chunkIndex: i,
          chunkBytes: chunkBuf,
        
      ownerId: 'test-owner',}).ok,
        true,
      );
    }
    assert.equal(mgr.finalizeTransfer(init.transferId!, { ownerId: 'test-owner' }).ok, true);
    const src = mgr.acquireAudioSource(init.transferId!, { ownerId: 'test-owner' }).source!;
    const prep = await src.prepareWavFileStreaming({
      writeHighWaterMarkBytes: 4096, // Force frequent stream saturation & drain waits
    });
    assert.ok(prep.drainWaits > 0, `Expected real drain backpressure waits > 0, got ${prep.drainWaits}`);
    const accounting = mgr.getMemoryAccounting();
    assert.ok(accounting.backpressureDrainWaitCount >= prep.drainWaits);
    assert.ok(
      accounting.peakTotalLiveBuffersPerTransferBytes <= MAX_TOTAL_LIVE_BUFFERS_PER_TRANSFER_BYTES,
      `Peak per-transfer live buffers (${accounting.peakTotalLiveBuffersPerTransferBytes}) exceeded 1 MiB`,
    );
    await src.close('COMPLETED');

    // 3. Verify CEP Handshake -> Chunked Transfer -> JOB_SUBMIT -> JOB_RECONNECT over HTTP loopback
    const service = new LocalCompanionService({ transferStagingDir: stagingDir });
    const app = express();
    app.use('/api/v2/companion', service.createExpressRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/api/v2/companion`;

    try {
      const hsResp = await fetch(`${baseUrl}/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
          host_id: 'adobe-audition',
          host_version: '24.0',
          panel_version: '1.0.0',
          host_adapter_version: '1.0.0',
          expected_contract_version: CANONICAL_CONTRACT_VERSION,
          expected_asr_contract_version: '2.0.0',
          expected_cep_transcript_schema_version: '1.0.0',
        }),
      });
      const hsData = (await hsResp.json()) as {
        compatible: boolean;
        session_id: string;
        session_token: string;
      };
      assert.equal(hsData.compatible, true);

      const callIpc = async (command: string, payload: Record<string, unknown>) => {
        const r = await fetch(`${baseUrl}/ipc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hsData.session_token}`,
          },
          body: JSON.stringify({
            ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
            session_id: hsData.session_id,
            nonce: crypto.randomUUID(),
            request_id: crypto.randomUUID(),
            timestamp_ms: Date.now(),
            expires_at_ms: Date.now() + 60_000,
            execution_mode: 'audition-cep',
            command,
            payload,
          }),
        });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };

      const initIpc = await callIpc('CAPABILITY_EXECUTE', {
        action: 'AUDIO_TRANSFER_INIT',
        filename: 'cep-stream.pcm',
        format: 'pcm_s16le',
        sampleRateHz: 16000,
        channels: 1,
        endianness: 'little',
        expectedBytes: 3200,
        expectedFrames: 1600,
        totalChunks: 1,
      });
      assert.equal(initIpc.status, 200);
      const tid = String(initIpc.body.transferId);

      const chunkIpc = await callIpc('CAPABILITY_EXECUTE', {
        action: 'AUDIO_TRANSFER_CHUNK',
        transferId: tid,
        chunkIndex: 0,
        chunkBase64: Buffer.alloc(3200).toString('base64'),
      });
      assert.equal(chunkIpc.status, 200);

      const finIpc = await callIpc('CAPABILITY_EXECUTE', {
        action: 'AUDIO_TRANSFER_FINALIZE',
        transferId: tid,
      });
      assert.equal(finIpc.status, 200);

      // Stub neuralEngine status & transcribe so we can test JOB_SUBMIT + JOB_RECONNECT deterministically
      let observedAudioFilePath: string | undefined;
      let observedAudioBytes: Buffer | undefined;
      let fileExistedDuringTranscribe = false;
      service.neuralEngine.getStatus = () => ({
        runtimeName: 'sherpa-onnx-cpu',
        binaryPath: '/usr/local/bin/sherpa-onnx-offline',
        libDir: '/usr/local/lib',
        available: true,
        offlineOnlyEnforced: true,
        cpuThreads: 4,
        activeModelId: 'shenava-rizeh-fa-int8',
        installedModels: [
          {
            modelId: 'shenava-rizeh-fa-int8',
            profileId: 'AVP_MODEL_LITE',
            displayName: 'Shenava Rizeh',
            architecture: 'nemo-ctc',
            quantization: 'INT8',
            licenseSpdx: 'Apache-2.0',
            supportedLanguages: ['fa'],
            supportsNativeWordTimestamps: true,
            rootDir: '/tmp',
            diskSizeBytes: 1024,
            requiredFiles: ['model.int8.onnx', 'tokens.txt'],
            integrityVerified: true,
            extraCliArgs: [],
          },
        ],
        processRssMb: 120,
      });
      service.neuralEngine.selectModel = () =>
        service.neuralEngine.getStatus().installedModels[0];
      service.neuralEngine.transcribe = async (req) => {
        observedAudioFilePath = req.audioFilePath;
        observedAudioBytes = req.audioBytes;
        fileExistedDuringTranscribe = Boolean(req.audioFilePath && fs.existsSync(req.audioFilePath));
        await new Promise((r) => setTimeout(r, 40));
        const norm = {
          RAW_VERBATIM: 'تست استریم آواپرداز',
          STANDARD_PERSIAN: 'تست استریم آواپرداز',
          SUBTITLE_CLEAN: 'تست استریم آواپرداز',
          SEARCH_INDEX: 'تست استریم آواپرداز',
        } as unknown as LocalNeuralTranscriptionResult['normalizedByProfile'];
        return {
          modelId: 'shenava-rizeh-fa-int8',
          architecture: 'nemo-ctc',
          quantization: 'INT8',
          offlineVerified: true,
          durationSec: 0.1,
          processingTimeMs: 12,
          realTimeFactor: 0.12,
          dominantLanguage: 'fa',
          rawText: 'تست استریم آواپرداز',
          normalizedByProfile: norm,
          timestampGranularity: 'WORD',
          sampleRateHz: 16000,
          channelCount: 1,
          audioSha256: '0'.repeat(64),
          segments: [
            {
              id: 'seg_1',
              index: 0,
              startSec: 0,
              endSec: 0.1,
              text: 'تست استریم آواپرداز',
              normalizedByProfile: norm,
              language: 'fa',
              timestampGranularity: 'WORD',
              words: [],
            },
          ],
        };
      };

      const submitIpc = await callIpc('JOB_SUBMIT', {
        transferId: tid,
        languageHint: 'fa',
      });
      assert.equal(submitIpc.status, 202);
      const jobId = (submitIpc.body.job as { jobId: string }).jobId;

      // Immediately test JOB_RECONNECT while job is running/finishing
      const reconIpc = await callIpc('JOB_RECONNECT', { jobId });
      assert.equal(reconIpc.status, 200);
      assert.equal(reconIpc.body.reconnected, true);

      // Wait for job completion
      for (let attempt = 0; attempt < 25; attempt++) {
        const st = await callIpc('JOB_STATUS', { jobId });
        const job = st.body.job as { status: string };
        if (job.status === 'COMPLETED') break;
        await new Promise((r) => setTimeout(r, 20));
      }

      // Verify LocalCompanionService passed on-disk WAV file path (NOT in-memory audioBytes)
      // and cleaned up the temp files after transcribe completed!
      assert.equal(observedAudioBytes, undefined);
      assert.ok(observedAudioFilePath, 'Expected on-disk prepared wavFilePath');
      assert.equal(fileExistedDuringTranscribe, true);
      assert.equal(fs.existsSync(observedAudioFilePath!), false, 'Prepared WAV must be deleted after job completes');
      assert.equal(service.audioTransfers.getTransferLifecycleState(tid), 'CLEANED');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('Scenarios 4, 5 & Section 9 Benchmarks: 10-minute, 30-minute, and 60-minute audio streaming & ASR preparation without full-file materialization', async () => {
  const stagingDir = createTempDir('avp-p1b-bench-');
  try {
    const scenarios: Array<{
      readonly label: '10-minute' | '30-minute' | '60-minute';
      readonly durationMinutes: number;
    }> = [
      { label: '10-minute', durationMinutes: 10 },
      { label: '30-minute', durationMinutes: 30 },
      { label: '60-minute', durationMinutes: 60 },
    ];

    for (const sc of scenarios) {
      if (global.gc) global.gc();
      const mgr = new CompanionAudioTransferManager({
        stagingDir,
        maxTransferBytes: 512 * 1024 * 1024,
        maxTotalStagingBytes: 1024 * 1024 * 1024,
      });

      const sampleRateHz = 16000;
      const channels = 1;
      const bytesPerSample = 2; // pcm_s16le
      const totalSeconds = sc.durationMinutes * 60;
      const expectedFrames = totalSeconds * sampleRateHz;
      const expectedBytes = expectedFrames * channels * bytesPerSample;
      const chunkBytesSize = MAX_NETWORK_CHUNK_BYTES; // 256 KiB
      const totalChunks = Math.ceil(expectedBytes / chunkBytesSize);

      // Reusable 256 KiB deterministic waveform chunk (zero full-file allocation in test harness too)
      const fullChunkBuf = Buffer.alloc(chunkBytesSize);
      for (let i = 0; i < chunkBytesSize / 2; i++) {
        fullChunkBuf.writeInt16LE(((i * 97) % 32000) - 16000, i * 2);
      }

      const rssBefore = process.memoryUsage().rss;
      let peakRssDuringTransfer = rssBefore;
      const startedMs = performance.now();

      const init = mgr.initTransfer({
        filename: `bench-${sc.durationMinutes}m.pcm`,
        format: 'pcm_s16le',
        sampleRateHz,
        channels,
        endianness: 'little',
        expectedBytes,
        expectedFrames,
        totalChunks,
        ownerId: `bench-owner-${sc.durationMinutes}m`,
      });
      assert.equal(init.ok, true);
      const transferId = init.transferId!;

      for (let idx = 0; idx < totalChunks; idx++) {
        const remaining = expectedBytes - idx * chunkBytesSize;
        const slice =
          remaining >= chunkBytesSize ? fullChunkBuf : fullChunkBuf.subarray(0, remaining);
        const res = mgr.appendChunk({
          transferId,
          chunkIndex: idx,
          chunkBytes: slice,
          ownerId: `bench-owner-${sc.durationMinutes}m`,
        });
        assert.equal(res.ok, true);
        if (idx % 64 === 0) {
          const curRss = process.memoryUsage().rss;
          if (curRss > peakRssDuringTransfer) peakRssDuringTransfer = curRss;
        }
      }

      const fin = mgr.finalizeTransfer(transferId, {
        ownerId: `bench-owner-${sc.durationMinutes}m`,
      });
      assert.equal(fin.ok, true);
      assert.equal(fin.receivedBytes, expectedBytes);

      const acq = mgr.acquireAudioSource(transferId, {
        ownerId: `bench-owner-${sc.durationMinutes}m`,
      });
      assert.equal(acq.ok, true);
      const source = acq.source!;
      assert.equal(source.exactSampleCount, expectedFrames);

      let peakRssDuringAsrPrep = process.memoryUsage().rss;
      const prep = await source.prepareWavFileStreaming({
        onChunkWritten: () => {
          const curRss = process.memoryUsage().rss;
          if (curRss > peakRssDuringAsrPrep) peakRssDuringAsrPrep = curRss;
        },
      });
      assert.equal(prep.totalWavBytes, 44 + expectedBytes);

      // Also verify bounded range reading across start, middle, and end of the large file
      const midFrame = Math.floor(expectedFrames / 2);
      const midSamples = await source.readRange(midFrame, 4096);
      assert.equal(midSamples.length, 4096);

      await source.close('COMPLETED');
      const elapsedMs = Math.round(performance.now() - startedMs);
      if (global.gc) global.gc();
      const rssAfterCleanup = process.memoryUsage().rss;

      const accounting = mgr.getMemoryAccounting();
      const remainingFiles = fs
        .readdirSync(stagingDir)
        .filter((n) => n.startsWith(transferId));

      // Strict Buffer & Memory Policy Assertions (Section 6)
      assert.ok(
        accounting.peakTransferBuffersBytes <= MAX_NETWORK_CHUNK_BYTES,
        `Peak transfer buffer (${accounting.peakTransferBuffersBytes}) > 256 KiB`,
      );
      assert.ok(
        accounting.peakFileReadBuffersBytes <= MAX_FILE_READ_BUFFER_BYTES,
        `Peak file read buffer (${accounting.peakFileReadBuffersBytes}) > 256 KiB`,
      );
      assert.ok(
        accounting.peakFileWriteBuffersBytes <= MAX_FILE_WRITE_BUFFER_BYTES,
        `Peak file write buffer (${accounting.peakFileWriteBuffersBytes}) > 256 KiB`,
      );
      assert.ok(
        accounting.peakTotalLiveBuffersPerTransferBytes <=
          MAX_TOTAL_LIVE_BUFFERS_PER_TRANSFER_BYTES,
        `Peak total live buffers per transfer (${accounting.peakTotalLiveBuffersPerTransferBytes}) > 1 MiB`,
      );
      assert.equal(remainingFiles.length, 0, 'Zero temp files must remain after close()');

      const companionPeakRss = Math.max(
        rssBefore,
        peakRssDuringTransfer,
        peakRssDuringAsrPrep,
        rssAfterCleanup,
      );

      const row: Phase1BBenchmarkRow = {
        label: sc.label,
        durationMinutes: sc.durationMinutes,
        sampleRateHz,
        channels,
        format: 'pcm_s16le',
        actualFileSizeBytes: expectedBytes,
        networkChunkSizeBytes: accounting.peakTransferBuffersBytes,
        readBufferSizeBytes: accounting.peakFileReadBuffersBytes,
        writeBufferSizeBytes: accounting.peakFileWriteBuffersBytes,
        memoryBeforeTransferRssBytes: rssBefore,
        memoryDuringTransferPeakRssBytes: peakRssDuringTransfer,
        memoryDuringAsrPrepPeakRssBytes: peakRssDuringAsrPrep,
        memoryAfterCleanupRssBytes: rssAfterCleanup,
        companionPeakRssBytes: companionPeakRss,
        peakTransferLiveBuffersBytes: accounting.peakTotalLiveBuffersPerTransferBytes,
        backpressureDrainWaits: prep.drainWaits,
        transferAndPrepElapsedMs: elapsedMs,
        tempFilesRemainingAfterCleanup: remainingFiles.length,
      };
      collectedPhase1BBenchmarks.push(row);
    }

    // Verify buffer memory does NOT grow with file duration (10m vs 30m vs 60m have identical O(1) buffer peaks)
    assert.equal(collectedPhase1BBenchmarks.length, 3);
    assert.equal(
      collectedPhase1BBenchmarks[0].peakTransferLiveBuffersBytes,
      collectedPhase1BBenchmarks[2].peakTransferLiveBuffersBytes,
      'Live buffer allocation must remain O(1) constant between 10-minute and 60-minute files',
    );
    // Print structured JSON summary for Phase 1B report extraction
    console.log(
      'PHASE_1B_BENCHMARK_RESULTS=' + JSON.stringify(collectedPhase1BBenchmarks),
    );
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});
