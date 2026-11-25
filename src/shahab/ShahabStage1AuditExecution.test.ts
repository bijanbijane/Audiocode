/**
 * SHAHAB Stage 1 Audit Execution Verification Suite (SHB-F01 .. SHB-F10)
 *
 * Verifies every implemented architectural remediation, contract invariant, memory/security guard,
 * async FFmpeg pipe ingestion, Kaldi FBANK80 amplitude scaling, single-pass Persian normalizer,
 * host-independent shared core boundary, and lossless Float32 HTTP WAV transport — without
 * relying on external .onnx model weights, fake weights, or network calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditShahabMetadataIntegrity,
  hashFileSha256BoundedSync,
  resolveDefaultShahabModelDir,
  resolvePersistentUserModelStoreDir,
  verifyManifestEd25519Signature,
  writeModelArtifactAtomic,
} from './ShahabModelStore';
import {
  DEFAULT_SHAHAB_FBANK_CONFIG,
  SHAHAB_FEATURE_CONFIG_VERSION,
  ShahabCoreEngine,
  createShahabCoreEngine,
  decodeWavToMono16k,
  extractKaldiFbank80,
  normalizeCanonicalPersianUtterance,
  normalizePersianForEvaluation,
  type ShahabCoreInferenceBackend,
} from './core';
import * as CoreChunkMerger from './core/ShahabCoreChunkMerger';
import * as AsrChunkMerger from '../asr-core/ShahabChunkMerger';
import {
  encodeFloat32ToContainerWithFfmpeg,
  ingestAudioBufferToCanonical16kMonoAsync,
  isFfmpegAvailable,
} from '../asr-core/CoreAudioIngestion';
import {
  encodeMonoFloat32To16kFloat32WavBytes,
  encodeMonoFloat32To16kWavBytes,
} from '../asr-core/ShahabLocalHttpClient';
import { validateBinaryAudioPayload } from '../security/AudioApiSecurityGuard';
import { resolveDefaultShahabDataDir } from './ShahabContextMemoryStore';
import { ShahabZipformerAsrRuntime, ShahabZipformerRuntimeError } from './ShahabZipformerAsrRuntime';
import { SHAHABFrozenModelAdapter } from './ShahabZipformerEngine';
import type { AvapardazTranscriptSegment } from '../asr-core/UnifiedLocalAsrRuntime';
import type { ProjectTranscriptSegmentRecord } from '../workflow/CanonicalProjectWorkflowEngine';

function buildSpeechLikeWaveform(durationSec: number, sampleRate = 16000, amplitude = 0.25): Float32Array {
  const len = Math.max(1, Math.round(durationSec * sampleRate));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.0 * t);
    const tone =
      0.55 * Math.sin(2 * Math.PI * 190 * t) +
      0.3 * Math.sin(2 * Math.PI * 620 * t) +
      0.15 * Math.sin(2 * Math.PI * 1450 * t);
    out[i] = amplitude * envelope * tone;
  }
  return out;
}

// ============================================================================
// SHB-F01: Model Store Resolution, Atomic Staging & Ed25519 Signature Verifier
// ============================================================================

test('SHB-F01: resolveDefaultShahabModelDir respects SHAHAB_MODEL_STORE_DIR, populated user store, and repo fallback', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-f01-store-'));
  try {
    const customDir = path.join(tmpRoot, 'custom-store');
    assert.equal(
      resolveDefaultShahabModelDir({ SHAHAB_MODEL_STORE_DIR: customDir }, tmpRoot),
      path.resolve(customDir),
    );

    const xdgHome = path.join(tmpRoot, 'xdg-data');
    const resolvedUserStore = resolvePersistentUserModelStoreDir({ XDG_DATA_HOME: xdgHome });
    if (process.platform !== 'win32') {
      assert.ok(resolvedUserStore.startsWith(path.resolve(xdgHome)));
    }

    // Empty user store -> falls back to cwd/models/persian-zipformer-transducer/1.0.0
    const repoFallback = resolveDefaultShahabModelDir({ XDG_DATA_HOME: xdgHome, LOCALAPPDATA: xdgHome }, tmpRoot);
    assert.equal(
      repoFallback,
      path.resolve(tmpRoot, 'models', 'persian-zipformer-transducer', '1.0.0'),
    );

    // Populated user store with non-empty encoder.int8.onnx -> prioritized over repo fallback
    writeModelArtifactAtomic(path.join(resolvedUserStore, 'encoder.int8.onnx'), Buffer.from([1, 2, 3, 4]));
    const resolvedWithStore = resolveDefaultShahabModelDir(
      { XDG_DATA_HOME: xdgHome, LOCALAPPDATA: xdgHome },
      tmpRoot,
    );
    assert.equal(resolvedWithStore, resolvedUserStore);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('SHB-F01: writeModelArtifactAtomic commits atomically without leftover .part-* temp files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-f01-atomic-'));
  try {
    const target = path.join(tmpDir, 'nested', 'model-artifact.bin');
    const payload = crypto.randomBytes(4096);
    writeModelArtifactAtomic(target, payload);
    assert.deepEqual(fs.readFileSync(target), payload);
    const siblings = fs.readdirSync(path.dirname(target));
    assert.deepEqual(siblings, ['model-artifact.bin']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SHB-F01 / SHB-F07: verifyManifestEd25519Signature enforces strict cryptographic verification without faking unsigned manifests', () => {
  const manifestBytes = Buffer.from('{"modelId":"persian-zipformer-transducer","version":"1.0.0"}', 'utf8');
  const unsigned = verifyManifestEd25519Signature({ manifestBytes, signatureBase64: '' });
  assert.equal(unsigned.verified, false);
  assert.equal(unsigned.status, 'UNSIGNED');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sigB64 = crypto.sign(null, manifestBytes, privateKey).toString('base64');

  const keyMissing = verifyManifestEd25519Signature({
    manifestBytes,
    signatureBase64: sigB64,
    publicKeyPem: null,
  });
  assert.equal(keyMissing.verified, false);
  assert.equal(keyMissing.status, 'KEY_MISSING');

  const verified = verifyManifestEd25519Signature({
    manifestBytes,
    signatureBase64: sigB64,
    publicKeyPem: publicPem,
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.status, 'VERIFIED');

  const tampered = verifyManifestEd25519Signature({
    manifestBytes: Buffer.from('{"modelId":"tampered"}', 'utf8'),
    signatureBase64: sigB64,
    publicKeyPem: publicPem,
  });
  assert.equal(tampered.verified, false);
  assert.equal(tampered.status, 'SIGNATURE_INVALID');
});

// ============================================================================
// SHB-F02: Kaldi FBANK80 Amplitude Scaling (32768) & BASELINE === OPTIMIZED Parity
// ============================================================================

test('SHB-F02: extractKaldiFbank80 applies Kaldi 32768 scaling (+2*ln(32768) power-log shift) and maintains BASELINE === OPTIMIZED parity', () => {
  assert.equal(DEFAULT_SHAHAB_FBANK_CONFIG.pcmScaleFactor, 32768);
  assert.equal(SHAHAB_FEATURE_CONFIG_VERSION, 'KALDI_FBANK_80_16K_POVEY_25MS_10MS_SCALE32768_V2');

  const pcm = buildSpeechLikeWaveform(1.0, 16000, 0.25);
  const featScaledOpt = extractKaldiFbank80(pcm, DEFAULT_SHAHAB_FBANK_CONFIG, 'OPTIMIZED');
  const featScaledBase = extractKaldiFbank80(pcm, DEFAULT_SHAHAB_FBANK_CONFIG, 'BASELINE');
  const featUnscaledOpt = extractKaldiFbank80(
    pcm,
    { ...DEFAULT_SHAHAB_FBANK_CONFIG, pcmScaleFactor: 1 },
    'OPTIMIZED',
  );

  assert.equal(featScaledOpt.numFrames, featScaledBase.numFrames);
  assert.equal(featScaledOpt.data.length, featScaledBase.data.length);

  // Verify BASELINE vs OPTIMIZED floating-point equivalence across all frames and Mel bins
  let maxBaseOptDiff = 0;
  for (let i = 0; i < featScaledOpt.data.length; i++) {
    const diff = Math.abs(featScaledOpt.data[i] - featScaledBase.data[i]);
    if (diff > maxBaseOptDiff) maxBaseOptDiff = diff;
  }
  assert.ok(maxBaseOptDiff < 1e-4, `Expected BASELINE === OPTIMIZED maxAbsDiff < 1e-4, got ${maxBaseOptDiff}`);

  // Verify exact +2*ln(32768) shift in speech-active bins (away from FLT_EPSILON floor)
  const expectedShift = 2 * Math.log(32768); // ~20.7944
  let activeBinChecks = 0;
  let maxShiftError = 0;
  for (let f = 5; f < featScaledOpt.numFrames - 45; f++) {
    for (let m = 0; m < 80; m++) {
      const idx = f * 80 + m;
      const unscaledVal = featUnscaledOpt.data[idx];
      // Exclude bins clamped near Math.log(1.1920929e-7) = -15.94
      if (unscaledVal > -12.0) {
        const delta = featScaledOpt.data[idx] - unscaledVal;
        const err = Math.abs(delta - expectedShift);
        if (err > maxShiftError) maxShiftError = err;
        activeBinChecks += 1;
      }
    }
  }
  assert.ok(activeBinChecks > 50, `Expected >50 active Mel bins, got ${activeBinChecks}`);
  assert.ok(
    maxShiftError < 1e-3,
    `Expected exact +2*ln(32768) (~20.7944) shift, max error was ${maxShiftError}`,
  );
});

// ============================================================================
// SHB-F05: Async Non-Blocking Pipe FFmpeg Multi-Format Ingestion & AbortSignal
// ============================================================================

test('SHB-F05: ingestAudioBufferToCanonical16kMonoAsync decodes MP3/FLAC/OGG via pipe without avapardaz-ingest temp dirs or blocking event loop', async () => {
  assert.equal(isFfmpegAvailable(), true, 'ffmpeg binary must be available in execution environment');
  const speech = buildSpeechLikeWaveform(0.8, 16000, 0.3);

  const formats = ['mp3', 'flac', 'ogg'] as const;
  const encodedPayloads = formats.map((fmt) => ({
    fmt,
    bytes: encodeFloat32ToContainerWithFfmpeg(speech, fmt, 16000),
  }));

  // Track mkdtemp calls during async decode to prove ZERO avapardaz-ingest-* temp dirs are created
  const origMkdtemp = fs.promises.mkdtemp;
  const createdIngestDirs: string[] = [];
  fs.promises.mkdtemp = (async (prefix: fs.PathLike, options?: unknown) => {
    const dir = await (origMkdtemp as (p: fs.PathLike, o?: unknown) => Promise<string>)(prefix, options);
    if (String(prefix).includes('avapardaz-ingest-')) {
      createdIngestDirs.push(dir);
    }
    return dir;
  }) as typeof fs.promises.mkdtemp;

  // Measure event-loop tick lag while running concurrent FFmpeg pipe decodes
  let lastTick = performance.now();
  let maxLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - 10;
    if (lag > maxLagMs) maxLagMs = lag;
    lastTick = now;
  }, 10);

  try {
    const results = await Promise.all(
      encodedPayloads.map(({ fmt, bytes }) =>
        ingestAudioBufferToCanonical16kMonoAsync({
          filename: `sample.${fmt}`,
          rawBytes: bytes,
          includePcm16: false,
        }),
      ),
    );

    assert.equal(
      createdIngestDirs.length,
      0,
      `Expected zero avapardaz-ingest temp dirs for streamable MP3/FLAC/OGG, got: ${createdIngestDirs.join(', ')}`,
    );

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      assert.equal(res.detectedFormat, encodedPayloads[i].fmt);
      assert.equal(res.canonicalSampleRateHz, 16000);
      assert.equal(res.canonicalChannels, 1);
      assert.equal(res.canonicalPcm16.length, 0, 'includePcm16:false must skip PCM16 allocation');
      assert.ok(res.canonicalFloat32.length > 8000, `${encodedPayloads[i].fmt} decoded sample count too low`);
      for (let s = 0; s < res.canonicalFloat32.length; s++) {
        assert.ok(Number.isFinite(res.canonicalFloat32[s]));
      }
    }

    assert.ok(maxLagMs < 150, `Event loop stalled excessively during concurrent FFmpeg pipes (${maxLagMs.toFixed(1)}ms)`);

    // Verify AbortSignal cancels cleanly
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await assert.rejects(
      () =>
        ingestAudioBufferToCanonical16kMonoAsync({
          filename: 'sample.flac',
          rawBytes: encodedPayloads[1].bytes,
          signal: abortCtrl.signal,
          includePcm16: false,
        }),
      /AUDIO_INGEST_CANCELLED/,
    );
  } finally {
    clearInterval(timer);
    fs.promises.mkdtemp = origMkdtemp;
  }
});

// ============================================================================
// SHB-F06: Host-Independent Shared Core Boundary, Deduplication & End-to-End Flow
// ============================================================================

test('SHB-F06: src/shahab/core/ has ZERO forbidden host/Node/UI/ORT imports and ShahabChunkMerger is single-source', () => {
  const coreDir = path.resolve(process.cwd(), 'src', 'shahab', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter((f) => f.endsWith('.ts'));
  assert.ok(coreFiles.length >= 9, `Expected core modules in src/shahab/core, found ${coreFiles.length}`);

  const forbiddenImportRe =
    /(?:^|\n)\s*import\b[^;]*from\s+['"](?:node:|fs\b|path\b|os\b|child_process\b|crypto\b|express\b|react\b|onnxruntime|.*\/asr-core\/|.*\/workflow\/|.*\/security\/|\.\.\/Shahab|\.\.\/adapters\/)/g;

  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf8');
    const matches = content.match(forbiddenImportRe);
    assert.equal(
      matches,
      null,
      `Host-isolation violation in src/shahab/core/${file}: ${JSON.stringify(matches)}`,
    );
  }

  // Verify zero duplicate logic between ShahabCoreChunkMerger and ShahabChunkMerger shim
  assert.equal(AsrChunkMerger.planAudioChunks, CoreChunkMerger.planAudioChunks);
  assert.equal(AsrChunkMerger.mergeChunkedTranscriptWords, CoreChunkMerger.mergeChunkedTranscriptWords);
  assert.equal(AsrChunkMerger.normalizeWordForSeamMatch, CoreChunkMerger.normalizeWordForSeamMatch);
});

test('SHB-F06: ShahabCoreEngine processes 48kHz out-of-phase stereo & multi-chunk audio cleanly with confidence:null', async () => {
  const vocab = ['<blk>', '<sos/eos>', '▁این', '▁تست', '▁می', '▁شود', '<unk>'];
  let initCalls = 0;
  let disposeCalls = 0;
  let encoderCalls = 0;

  const syntheticBackend: ShahabCoreInferenceBackend = {
    executionProvider: 'wasm_single_thread',
    modelId: 'persian-zipformer-transducer',
    modelVersion: 'test-core-1.0.0',
    getCapabilities: () => ({
      contractVersion: '1.0.0',
      executionProvider: 'wasm_single_thread',
      nativeCppAvailable: false,
      statefulStreamingSupported: false,
      maxThreads: 1,
      offlineCapable: true,
    }),
    initialize: async () => {
      initCalls += 1;
    },
    getVocab: () => vocab,
    runEncoder: async (_features, numFrames) => {
      encoderCalls += 1;
      const frames = Math.max(12, Math.floor(numFrames / 4));
      return {
        data: new Float32Array(frames * 8),
        numFrames: frames,
        dim: 8,
        frameStrideSec: 0.04,
      };
    },
    runDecoderBatch: async (contexts) => contexts.map(() => new Float32Array(8)),
    runJoinerBatch: async (_frame, decoderVectors, _dim) => {
      // Emit deterministic sequence on early frame indices by cycling logits cleanly
      return decoderVectors.map((_dv, idx) => {
        const logits = new Float32Array(vocab.length);
        logits.fill(-8);
        // Emit blank by default except at specific encoder steps tracked via encoderCalls? Use idx/frame?
        // Always prefer blank slightly after step 0 unless we track via call counter
        logits[0] = 5;
        if (idx === 0) logits[0] = 5;
        return logits;
      });
    },
    dispose: async () => {
      disposeCalls += 1;
    },
  };

  // Emit chunk-specific deterministic tokens:
  // Chunk 1 -> ['▁این', '▁تست'], Chunk 2 -> ['▁تست', '▁می', '▁شود'] (seam-stitched -> "این تست می‌شود")
  let joinerFrameCounter = 0;
  let activeChunkIdx = 0;
  const chunk1Schedule = new Map<number, number>([
    [1, 2], // ▁این
    [585, 3], // ▁تست near 23.4s overlap seam
  ]);
  const chunk2Schedule = new Map<number, number>([
    [10, 3], // ▁تست at 23.4s overlap seam
    [20, 4], // ▁می
    [30, 5], // ▁شود
  ]);
  const statefulBackend: ShahabCoreInferenceBackend = {
    ...syntheticBackend,
    runEncoder: async (features, numFrames, featureDim) => {
      activeChunkIdx += 1;
      joinerFrameCounter = 0;
      return syntheticBackend.runEncoder(features, numFrames, featureDim);
    },
    runJoinerBatch: async (_frame, decoderVectors) => {
      const step = joinerFrameCounter++;
      const schedule = activeChunkIdx === 1 ? chunk1Schedule : chunk2Schedule;
      return decoderVectors.map((_dv, idx) => {
        const logits = new Float32Array(vocab.length);
        logits.fill(-10);
        const emitId = idx === 0 ? schedule.get(step) : undefined;
        logits[emitId ?? 0] = 6;
        return logits;
      });
    },
  };

  const engine = createShahabCoreEngine(statefulBackend);
  assert.ok(engine instanceof ShahabCoreEngine);

  // 26s 48kHz out-of-phase stereo (L = +signal, R = -signal) -> forces multi-chunk + phase-safe downmix
  const mono48k = buildSpeechLikeWaveform(26.0, 48000, 0.35);
  const interleavedStereo = new Float32Array(mono48k.length * 2);
  for (let i = 0; i < mono48k.length; i++) {
    interleavedStereo[i * 2] = mono48k[i];
    interleavedStereo[i * 2 + 1] = -mono48k[i]; // inverted phase
  }

  const out = await engine.transcribe(
    {
      pcmFloat32: interleavedStereo,
      metadata: {
        sampleRateHz: 48000,
        channels: 2,
        layout: 'interleaved',
        filename: 'stereo-out-of-phase.wav',
      },
    },
    {
      maxChunkDurationSec: 24,
      overlapSec: 1.0,
      unloadAfterTranscribe: true,
    },
  );

  assert.equal(out.offlineVerified, true);
  assert.equal(out.sampleRateHz, 16000);
  assert.ok(encoderCalls >= 2, `Expected >=2 chunks for 26s audio, got ${encoderCalls}`);
  assert.ok(initCalls >= 1);
  assert.equal(disposeCalls, 1, 'unloadAfterTranscribe:true must invoke backend.dispose()');
  assert.ok(out.tokens.length > 0, 'Expected monotonic tokens from core engine');
  assert.equal(out.normalizedText, 'این تست می‌شود');
  let prevSample = 0;
  for (const tok of out.tokens) {
    assert.equal(tok.confidence, null, 'Core engine must emit confidence: null when uncalibrated');
    assert.ok(tok.startSample >= prevSample);
    assert.ok(tok.endSample > tok.startSample);
    prevSample = tok.endSample;
  }

  // Also verify SHAHABFrozenModelAdapter exposes a conforming ShahabCoreInferenceBackend bridge
  const adapter = new SHAHABFrozenModelAdapter({ modelDir: resolveDefaultShahabModelDir() });
  const bridged = adapter.asCoreInferenceBackend();
  assert.equal(bridged.modelId, 'persian-zipformer-transducer');
  assert.equal(typeof bridged.runEncoder, 'function');
  assert.equal(typeof bridged.runDecoderBatch, 'function');
  assert.equal(typeof bridged.runJoinerBatch, 'function');
});

// ============================================================================
// SHB-F07: Honest Confidence (`null`) & Live Metadata Integrity Audit
// ============================================================================

test('SHB-F07: Transcript types allow confidence:null, adapter avoids fake 0 confidence, and metadataIntegrityAudit flags contradictions & UNSIGNED manifest', () => {
  const segCheck: AvapardazTranscriptSegment = {
    id: 'seg_1',
    index: 0,
    startSec: 0,
    endSec: 1.2,
    startSample16k: 0,
    endSample16k: 19200,
    rawText: 'سلام دنیا',
    normalizedText: 'سلام دنیا',
    language: 'fa',
    confidence: null,
    timestampGranularity: 'SEGMENT',
    words: [],
  };
  const projSegCheck: ProjectTranscriptSegmentRecord = {
    segmentId: 'seg_1',
    startSample: 0,
    endSample: 19200,
    startSec: 0,
    endSec: 1.2,
    rawText: 'سلام دنیا',
    normalizedText: 'سلام دنیا',
    userCorrectedText: null,
    confidence: null,
  };
  assert.equal(segCheck.confidence, null);
  assert.equal(projSegCheck.confidence, null);

  // Confirm SHAHABFrozenModelAdapter source emits confidence: null rather than hardcoded 0
  const engineSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/shahab/ShahabZipformerEngine.ts'), 'utf8');
  assert.match(engineSrc, /confidence:\s*null/);
  assert.doesNotMatch(engineSrc, /confidence:\s*0\s*,/);

  const lineage = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'docs/shahab/SHAHAB_PARAMETER_LINEAGE.json'), 'utf8'),
  );
  const compactState = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'docs/shahab/SHAHAB_COMPACT_MODEL_STATE.json'), 'utf8'),
  );
  const manifestPath = path.resolve(process.cwd(), 'models/persian-zipformer-transducer/1.0.0/manifest.json');

  const audit = auditShahabMetadataIntegrity({
    parameterLineage: lineage,
    compactModelState: compactState,
    manifestPath,
  });

  assert.equal(audit.hasStaleOrContradictoryDocs, true);
  assert.equal(audit.manifestSignatureStatus, 'UNSIGNED');
  assert.equal(audit.manifestSignatureVerified, false);
  assert.equal(audit.parameterLineageReportedElements.inheritedFrozenParameters, 11470768);
  assert.equal(audit.parameterLineageReportedElements.nonTrainableConstantsElements, 53084484);
  assert.ok(audit.findings.some((f) => f.includes('11470768') && f.includes('53084484')));
  assert.ok(audit.findings.some((f) => f.includes('55.66 MiB') && f.includes('94.65 MiB')));
  assert.ok(audit.findings.some((f) => f.includes('UNSIGNED')));
});

// ============================================================================
// SHB-F08: Single-Pass Persian Normalizer Preserves Digits, Latin Case & Exceptions
// ============================================================================

test('SHB-F08: normalizeCanonicalPersianUtterance preserves Persian digits, Latin acronyms, non_verbs_mi & colloquial verbs while normalizing ZWNJ', () => {
  assert.equal(
    normalizeCanonicalPersianUtterance('در سال ۱۴۰۴ شماره ۳ با CPU و ONNX اجرا می شود'),
    'در سال ۱۴۰۴ شماره ۳ با CPU و ONNX اجرا می‌شود',
  );
  assert.equal(
    normalizeCanonicalPersianUtterance('كیفیت عالي ميوه و ميراث در ميدان شهر و مليارد و ميليون'),
    'کیفیت عالی میوه و میراث در میدان شهر و ملیارد و میلیون',
  );
  assert.equal(
    normalizeCanonicalPersianUtterance('میهن و میلاد و میز و میزان و میعاد و مینو'),
    'میهن و میلاد و میز و میزان و میعاد و مینو',
  );
  assert.equal(
    normalizeCanonicalPersianUtterance('او میاد و منم میام ولی اون نمیاد'),
    'او میاد و منم میام ولی اون نمیاد',
  );
  assert.equal(
    normalizeCanonicalPersianUtterance('انتهای روستای زیبا با اشتهای فراوان و خانه ها و خانه ام و بزرگ تر'),
    'انتهای روستای زیبا با اشتهای فراوان و خانه‌ها و خانه‌ام و بزرگ‌تر',
  );
  assert.equal(
    normalizeCanonicalPersianUtterance('نمی دانم چه شد ۀ و ي و ك و ٤٥'),
    'نمی‌دانم چه شد ه\u200cی و ی و ک و ۴۵',
  );

  // Evaluation helper remains strictly decoupled from display output
  assert.equal(normalizePersianForEvaluation('سال ۱۴۰۴ می‌شود CPU', 'STRICT'), 'سال 1404 می‌شود CPU');
  assert.equal(normalizePersianForEvaluation('سال ۱۴۰۴ می‌شود CPU', 'RELAXED'), 'سال 1404 می شود cpu');
});

// ============================================================================
// SHB-F09: Persistent User Data Dir, Bounded SHA-256, File Allowlist & Size Cap
// ============================================================================

test('SHB-F09: resolveDefaultShahabDataDir uses persistent OS user dir instead of os.tmpdir()', () => {
  const resolved = resolveDefaultShahabDataDir({});
  assert.ok(!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep), `Must not default to os.tmpdir(): ${resolved}`);
  assert.notEqual(resolved, path.resolve(os.tmpdir()));

  if (process.platform !== 'win32') {
    const customXdg = path.resolve(os.tmpdir(), 'custom-xdg-root');
    assert.equal(
      resolveDefaultShahabDataDir({ XDG_DATA_HOME: customXdg }),
      path.join(customXdg, 'avapardaz', 'shahab-state'),
    );
  }
});

test('SHB-F09: hashFileSha256BoundedSync matches crypto.createHash over multi-MiB file & ShahabSdk avoids readFileSync full-model hash', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-f09-hash-'));
  try {
    const bigFile = path.join(tmpDir, 'blob.bin');
    // 2.6 MiB spans multiple 1 MiB chunks including partial trailing read
    const buf = crypto.randomBytes(2 * 1024 * 1024 + 600 * 1024 + 17);
    fs.writeFileSync(bigFile, buf);
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    const actual = hashFileSha256BoundedSync(bigFile);
    assert.equal(actual, expected);

    const sdkSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/shahab/sdk/ShahabSdk.ts'), 'utf8');
    assert.ok(sdkSrc.includes('hashFileSha256BoundedSync(fullPath)'));
    assert.doesNotMatch(sdkSrc, /sha256Hex\(fs\.readFileSync\(fullPath\)\)/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SHB-F09: ShahabZipformerAsrRuntime rejects audioFilePath outside allowedAudioRoots and oversized >128 MiB sparse file before read', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-f09-guard-'));
  const allowedRoot = path.join(tmpDir, 'allowed');
  const outsideRoot = path.join(tmpDir, 'outside');
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  try {
    const runtime = new ShahabZipformerAsrRuntime({
      modelDir: path.join(tmpDir, 'models'),
      allowedAudioRoots: [allowedRoot],
    });

    const outsideWav = path.join(outsideRoot, 'secret.wav');
    fs.writeFileSync(outsideWav, encodeMonoFloat32To16kWavBytes(buildSpeechLikeWaveform(0.2), 16000));

    await assert.rejects(
      () =>
        runtime.transcribe({
          sourceAudioId: 'outside-test',
          audioFilePath: outsideWav,
        }),
      (err: unknown) =>
        err instanceof ShahabZipformerRuntimeError &&
        err.code === 'INVALID_AUDIO_INPUT' &&
        err.message.includes('خارج از دایرکتوری‌های مجاز'),
    );

    // Sparse file > 128 MiB inside allowedRoot must fail stat.size guard BEFORE fs.readFileSync
    const sparseOversized = path.join(allowedRoot, 'huge-sparse.wav');
    const fd = fs.openSync(sparseOversized, 'w');
    try {
      fs.ftruncateSync(fd, 129 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }

    await assert.rejects(
      () =>
        runtime.transcribe({
          sourceAudioId: 'oversized-sparse-test',
          audioFilePath: sparseOversized,
        }),
      (err: unknown) =>
        err instanceof ShahabZipformerRuntimeError &&
        err.code === 'INVALID_AUDIO_INPUT' &&
        err.message.includes('سقف مجاز'),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SHB-F10: Lossless IEEE Float32 WAV Local HTTP Transport
// ============================================================================

test('SHB-F10: encodeMonoFloat32To16kFloat32WavBytes encodes IEEE Float32 WAV passing security guard and preserves quiet -75 dBFS speech (<1e-6 error)', () => {
  // Very quiet 16 kHz waveform around ~ -75 dBFS (1e-4 amplitude)
  const quiet = buildSpeechLikeWaveform(0.25, 16000, 1e-4);

  const float32Wav = encodeMonoFloat32To16kFloat32WavBytes(quiet, 16000);
  const pcm16Wav = encodeMonoFloat32To16kWavBytes(quiet, 16000);

  const dv = new DataView(float32Wav.buffer, float32Wav.byteOffset, float32Wav.byteLength);
  assert.equal(dv.getUint16(20, true), 3, 'Expected audioFormat === 3 (IEEE Float32)');
  assert.equal(dv.getUint16(34, true), 32, 'Expected bitsPerSample === 32');

  const guardCheck = validateBinaryAudioPayload(Buffer.from(float32Wav), { requireWav: true });
  assert.equal(guardCheck.ok, true);
  assert.equal(guardCheck.format, 'wav');

  const decodedFloat = decodeWavToMono16k(float32Wav);
  const decodedPcm16 = decodeWavToMono16k(pcm16Wav);
  assert.equal(decodedFloat.pcm16k.length, quiet.length);

  let maxFloatErr = 0;
  let maxPcm16Err = 0;
  for (let i = 0; i < quiet.length; i++) {
    const fe = Math.abs(decodedFloat.pcm16k[i] - quiet[i]);
    const pe = Math.abs(decodedPcm16.pcm16k[i] - quiet[i]);
    if (fe > maxFloatErr) maxFloatErr = fe;
    if (pe > maxPcm16Err) maxPcm16Err = pe;
  }

  assert.ok(maxFloatErr < 1e-6, `Float32 transport error expected < 1e-6, got ${maxFloatErr}`);
  assert.ok(maxPcm16Err > maxFloatErr, 'Float32 WAV must strictly outperform Int16 WAV quantization on quiet signals');
});
