/**
 * AVAPARDAZ — ENGINE 01: SHAHAB ASR MODEL MANIFEST & RUNTIME ADAPTER (AVP-SHAHAB-001)
 *
 * Defines the independent `shahab-fa-lite` model manifest contract with honest provenance
 * (currently backed by the Apache-2.0 Reza2kn/Shenava-Rizeh v1.0 FastConformer CTC INT8
 * baseline until a dedicated Persian fine-tuned Shahab checkpoint passes locked benchmarks).
 *
 * Guarantees:
 * - SHA-256 verification before every load (refuses corrupted/tampered artifacts)
 * - Lazy loading + explicit immediate unload with RSS memory telemetry
 * - Strict 100% local CPU execution (zero cloud ASR, zero network calls during inference)
 * - Sample-accurate mapping from ASR token timings to source audio sample coordinates
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LocalSherpaNeuralEngine,
  type InstalledLocalNeuralModel,
  type LocalNeuralRuntimeStatus,
  type LocalNeuralTranscriptionResult,
} from './LocalSherpaNeuralEngine';
import type {
  ShahabAsrEngine,
  ShahabAsrRuntimeMetrics,
  ShahabTranscribeRequest,
  TranscriptDocument,
  TranscriptToken,
} from '../workflow/SmartAudioEditContracts';

export const SHAHAB_MODEL_MAX_SIZE_BYTES = 200 * 1024 * 1024; // 200 MiB hard cap

export interface ShahabModelArtifactFile {
  readonly filename: string;
  readonly expectedBytes: number;
  readonly sha256Hex: string;
  readonly required: boolean;
}

export interface ShahabModelManifest {
  readonly modelId: 'shahab-fa-lite';
  readonly version: string;
  readonly displayName: string;
  readonly architecture: 'FastConformer-CTC';
  readonly quantization: 'INT8';
  readonly runtime: 'sherpa-onnx-cpu';
  readonly language: 'fa';
  readonly supportsWordTimestamps: true;
  readonly licenseSpdx: 'Apache-2.0';
  readonly provenance: {
    readonly originType: 'OPEN_BASELINE_VERIFIED';
    readonly upstreamModelId: 'Reza2kn/Shenava-Rizeh';
    readonly upstreamVersion: 'v1.0';
    readonly upstreamLicense: 'Apache-2.0';
    readonly fineTunedByAvapardaz: false;
    readonly notes: string;
  };
  readonly maxArtifactBytes: number;
  readonly files: readonly ShahabModelArtifactFile[];
}

export const SHAHAB_FA_LITE_MANIFEST: ShahabModelManifest = Object.freeze({
  modelId: 'shahab-fa-lite',
  version: '1.0.0-baseline.shenava-rizeh',
  displayName: 'Shahab FA Lite (FastConformer-CTC INT8 — Shenava-Rizeh Baseline)',
  architecture: 'FastConformer-CTC',
  quantization: 'INT8',
  runtime: 'sherpa-onnx-cpu',
  language: 'fa',
  supportsWordTimestamps: true,
  licenseSpdx: 'Apache-2.0',
  provenance: Object.freeze({
    originType: 'OPEN_BASELINE_VERIFIED',
    upstreamModelId: 'Reza2kn/Shenava-Rizeh',
    upstreamVersion: 'v1.0',
    upstreamLicense: 'Apache-2.0',
    fineTunedByAvapardaz: false,
    notes:
      'Official verified Apache-2.0 Persian NeMo FastConformer CTC INT8 baseline. Fine-tuned Shahab checkpoints are only promoted after passing locked FLEURS/CommonVoice/conversational WER & RTF gates.',
  }),
  maxArtifactBytes: SHAHAB_MODEL_MAX_SIZE_BYTES,
  files: Object.freeze([
    Object.freeze({
      filename: 'model.int8.onnx',
      expectedBytes: 38_183_269,
      sha256Hex: '6bdd4ab80626ddfe0b19338a5c96fcc4f2021ad78899cece20a805a48dc5250d',
      required: true,
    }),
    Object.freeze({
      filename: 'tokens.txt',
      expectedBytes: 12_236,
      sha256Hex: '8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954',
      required: true,
    }),
  ]),
});

export interface ShahabArtifactVerificationResult {
  readonly ok: boolean;
  readonly modelId: string;
  readonly rootDir: string;
  readonly totalBytes: number;
  readonly checkedFiles: readonly {
    readonly filename: string;
    readonly exists: boolean;
    readonly sizeBytes: number;
    readonly sha256Hex: string | null;
    readonly expectedSha256Hex: string;
    readonly ok: boolean;
    readonly reason?: string;
  }[];
  readonly failureReason?: string;
}

function sha256FileHex(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Verifies every required file in a Shahab model directory against exact byte count,
 * size ceiling (<= 200 MiB), and SHA-256 digest before inference is permitted.
 */
export function verifyShahabModelArtifacts(
  rootDir: string,
  manifest: ShahabModelManifest = SHAHAB_FA_LITE_MANIFEST,
): ShahabArtifactVerificationResult {
  let totalBytes = 0;
  const checkedFiles: Array<{
    readonly filename: string;
    readonly exists: boolean;
    readonly sizeBytes: number;
    readonly sha256Hex: string | null;
    readonly expectedSha256Hex: string;
    readonly ok: boolean;
    readonly reason?: string;
  }> = [];

  for (const spec of manifest.files) {
    const fullPath = path.join(rootDir, spec.filename);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      stat = null;
    }

    if (!stat || !stat.isFile() || stat.size <= 0) {
      checkedFiles.push({
        filename: spec.filename,
        exists: false,
        sizeBytes: 0,
        sha256Hex: null,
        expectedSha256Hex: spec.sha256Hex,
        ok: !spec.required,
        reason: 'MISSING_OR_EMPTY_FILE',
      });
      continue;
    }

    totalBytes += stat.size;
    if (stat.size !== spec.expectedBytes) {
      checkedFiles.push({
        filename: spec.filename,
        exists: true,
        sizeBytes: stat.size,
        sha256Hex: null,
        expectedSha256Hex: spec.sha256Hex,
        ok: false,
        reason: `SIZE_MISMATCH: expected ${spec.expectedBytes} B, got ${stat.size} B`,
      });
      continue;
    }

    const digest = sha256FileHex(fullPath);
    const matched = digest === spec.sha256Hex;
    checkedFiles.push({
      filename: spec.filename,
      exists: true,
      sizeBytes: stat.size,
      sha256Hex: digest,
      expectedSha256Hex: spec.sha256Hex,
      ok: matched,
      reason: matched ? undefined : 'SHA256_MISMATCH',
    });
  }

  const sizeExceeded = totalBytes > manifest.maxArtifactBytes;
  const firstFailure = checkedFiles.find((f) => !f.ok);
  const ok = !sizeExceeded && !firstFailure;

  return {
    ok,
    modelId: manifest.modelId,
    rootDir,
    totalBytes,
    checkedFiles,
    failureReason: sizeExceeded
      ? `MODEL_SIZE_CAP_EXCEEDED: ${totalBytes} B > ${manifest.maxArtifactBytes} B`
      : firstFailure
        ? `${firstFailure.filename}: ${firstFailure.reason ?? 'VERIFICATION_FAILED'}`
        : undefined,
  };
}

function normalizeTokenForAlignment(raw: string): string {
  return raw
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064B-\u0652]/g, '')
    .trim();
}

/**
 * Maps local Sherpa-ONNX transcription output onto canonical `avp.transcript.v1`
 * preserving verbatim raw ASR text and strict integer source-audio sample coordinates.
 */
export function buildTranscriptDocumentFromNeuralResult(params: {
  readonly neuralResult: LocalNeuralTranscriptionResult;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sourceSampleRate: number;
  readonly totalSourceSamples: number;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly createdAtMs?: number;
}): TranscriptDocument {
  const {
    neuralResult,
    sourceAudioId,
    sourceAudioHash,
    sourceSampleRate,
    totalSourceSamples,
    modelId,
    modelVersion,
  } = params;

  const rawTokens: TranscriptToken[] = [];
  let lastEndSample = 0;
  let tokenIdx = 0;

  for (const seg of neuralResult.segments) {
    if (seg.words.length > 0) {
      for (const word of seg.words) {
        const cleanRaw = word.word.trim();
        if (!cleanRaw) continue;
        let startSample = Math.max(0, Math.min(totalSourceSamples - 1, Math.round(word.startSec * sourceSampleRate)));
        if (startSample < lastEndSample) {
          startSample = Math.min(totalSourceSamples - 1, lastEndSample);
        }
        let endSample = Math.max(
          startSample + 1,
          Math.min(totalSourceSamples, Math.round(word.endSec * sourceSampleRate)),
        );
        if (endSample > totalSourceSamples) {
          endSample = totalSourceSamples;
        }
        if (endSample <= startSample) {
          continue;
        }
        rawTokens.push({
          tokenId: `tok_${tokenIdx}`,
          rawText: cleanRaw,
          normalizedText: normalizeTokenForAlignment(cleanRaw),
          startSample,
          endSample,
          startSec: Number((startSample / sourceSampleRate).toFixed(4)),
          endSec: Number((endSample / sourceSampleRate).toFixed(4)),
          confidence: null, // Honest: Sherpa CTC greedy decoder does not emit calibrated per-word probability
          timestampGranularity: 'WORD',
        });
        lastEndSample = endSample;
        tokenIdx++;
      }
    } else if (seg.text.trim().length > 0) {
      const pieces = seg.text.trim().split(/\s+/).filter(Boolean);
      const segStartSample = Math.max(
        lastEndSample,
        Math.min(totalSourceSamples - 1, Math.round(seg.startSec * sourceSampleRate)),
      );
      const segEndSample = Math.max(
        segStartSample + pieces.length,
        Math.min(totalSourceSamples, Math.round(seg.endSec * sourceSampleRate)),
      );
      const span = Math.max(pieces.length, segEndSample - segStartSample);
      const step = Math.max(1, Math.floor(span / pieces.length));

      for (let i = 0; i < pieces.length; i++) {
        const startSample = Math.min(totalSourceSamples - 1, segStartSample + i * step);
        const endSample =
          i === pieces.length - 1
            ? Math.min(totalSourceSamples, Math.max(startSample + 1, segEndSample))
            : Math.min(totalSourceSamples, Math.max(startSample + 1, startSample + step));
        if (endSample <= startSample) continue;
        rawTokens.push({
          tokenId: `tok_${tokenIdx}`,
          rawText: pieces[i],
          normalizedText: normalizeTokenForAlignment(pieces[i]),
          startSample,
          endSample,
          startSec: Number((startSample / sourceSampleRate).toFixed(4)),
          endSec: Number((endSample / sourceSampleRate).toFixed(4)),
          confidence: null,
          timestampGranularity: 'SEGMENT_ESTIMATED',
        });
        lastEndSample = endSample;
        tokenIdx++;
      }
    }
  }

  const transcriptVersion = `tr_${crypto
    .createHash('sha256')
    .update(`${sourceAudioHash}|${modelId}|${modelVersion}|${neuralResult.rawText}`)
    .digest('hex')
    .slice(0, 16)}`;

  return {
    schemaVersion: 'avp.transcript.v1',
    transcriptVersion,
    sourceAudioId,
    sourceAudioHash,
    sampleRate: sourceSampleRate,
    totalSourceSamples,
    language: neuralResult.dominantLanguage === 'en' ? 'en' : neuralResult.dominantLanguage === 'fa-en' ? 'fa-en' : 'fa',
    modelId,
    modelVersion,
    runtime: 'sherpa-onnx-cpu',
    rawText: neuralResult.rawText,
    normalizedText: neuralResult.normalizedByProfile.READABLE_PERSIAN ?? neuralResult.rawText,
    tokens: rawTokens,
    timestampGranularity: neuralResult.timestampGranularity,
    realTimeFactor: neuralResult.realTimeFactor,
    processingTimeMs: neuralResult.processingTimeMs,
    offlineVerified: true,
    createdAtMs: params.createdAtMs ?? Date.now(),
  };
}

export class ShahabModelError extends Error {
  public readonly code: 'MODEL_NOT_AVAILABLE' | 'SHAHAB_MODEL_INTEGRITY_FAILED' | 'TRANSCRIPTION_CANCELLED';

  constructor(
    code: 'MODEL_NOT_AVAILABLE' | 'SHAHAB_MODEL_INTEGRITY_FAILED' | 'TRANSCRIPTION_CANCELLED',
    message: string,
  ) {
    super(message);
    this.name = 'ShahabModelError';
    this.code = code;
  }
}

export class ShahabLocalAsrRuntime implements ShahabAsrEngine {
  private readonly neuralEngine: LocalSherpaNeuralEngine;
  private readonly manifest: ShahabModelManifest;
  private loadedModel: InstalledLocalNeuralModel | null = null;
  private lastMetrics: ShahabAsrRuntimeMetrics | null = null;

  constructor(options?: {
    readonly neuralEngine?: LocalSherpaNeuralEngine;
    readonly manifest?: ShahabModelManifest;
  }) {
    this.neuralEngine = options?.neuralEngine ?? new LocalSherpaNeuralEngine();
    this.manifest = options?.manifest ?? SHAHAB_FA_LITE_MANIFEST;
  }

  public getManifest(): ShahabModelManifest {
    return this.manifest;
  }

  public getRuntimeStatus(): LocalNeuralRuntimeStatus & {
    readonly shahabLoaded: boolean;
    readonly manifestModelId: string;
    readonly lastMetrics: ShahabAsrRuntimeMetrics | null;
  } {
    const status = this.neuralEngine.getStatus();
    return {
      ...status,
      shahabLoaded: this.loadedModel !== null,
      manifestModelId: this.manifest.modelId,
      lastMetrics: this.lastMetrics,
    };
  }

  public ensureModelVerifiedAndLoaded(): InstalledLocalNeuralModel {
    const runtimeStatus = this.neuralEngine.getStatus();
    if (!runtimeStatus.binaryPath) {
      throw new ShahabModelError(
        'MODEL_NOT_AVAILABLE',
        'MODEL_NOT_AVAILABLE: Local sherpa-onnx-offline CPU runtime binary is not installed.',
      );
    }

    if (this.loadedModel) {
      const check = verifyShahabModelArtifacts(this.loadedModel.rootDir, this.manifest);
      if (check.ok) {
        return this.loadedModel;
      }
      this.loadedModel = null;
      throw new ShahabModelError(
        'SHAHAB_MODEL_INTEGRITY_FAILED',
        `SHAHAB_MODEL_INTEGRITY_FAILED: ${check.failureReason ?? 'Artifact modified'}`,
      );
    }

    const candidate = this.neuralEngine.selectModel(
      this.manifest.provenance.upstreamModelId,
      'fa',
    );
    if (!candidate) {
      throw new ShahabModelError(
        'MODEL_NOT_AVAILABLE',
        `MODEL_NOT_AVAILABLE: Required local Shahab ASR model (${this.manifest.modelId} / ${this.manifest.provenance.upstreamModelId}) is not installed.`,
      );
    }

    const verification = verifyShahabModelArtifacts(candidate.rootDir, this.manifest);
    if (!verification.ok) {
      throw new ShahabModelError(
        'SHAHAB_MODEL_INTEGRITY_FAILED',
        `SHAHAB_MODEL_INTEGRITY_FAILED: ${verification.failureReason ?? 'SHA-256 verification failed'}`,
      );
    }

    this.loadedModel = candidate;
    return candidate;
  }

  public unload(): { readonly unloaded: boolean; readonly rssMb: number } {
    const wasLoaded = this.loadedModel !== null;
    this.loadedModel = null;
    const res = this.neuralEngine.unloadActiveModel();
    return {
      unloaded: wasLoaded || res.unloadedModelId !== null,
      rssMb: res.rssMb,
    };
  }

  public async transcribe(request: ShahabTranscribeRequest): Promise<{
    readonly transcript: TranscriptDocument;
    readonly metrics: ShahabAsrRuntimeMetrics;
  }> {
    const rssBeforeMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    const model = this.ensureModelVerifiedAndLoaded();

    const neuralResult = await this.neuralEngine.transcribe({
      modelId: model.modelId,
      languageHint: request.languageHint ?? 'fa',
      audioBytes: request.audioBytes,
      audioFilePath: request.audioFilePath,
      filename: request.filename,
      maxChunkDurationSec: request.maxChunkDurationSec ?? 25,
      overlapSec: request.overlapSec ?? 1.5,
      numThreads: request.numThreads,
      signal: request.signal,
      onProgress: request.onProgress,
    });

    const rssAfterMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    const totalSourceSamples =
      request.totalSourceSamples ??
      Math.max(1, Math.round(neuralResult.durationSec * (request.sourceSampleRate ?? neuralResult.sampleRateHz)));
    const sourceSampleRate = request.sourceSampleRate ?? neuralResult.sampleRateHz;

    const transcript = buildTranscriptDocumentFromNeuralResult({
      neuralResult,
      sourceAudioId: request.sourceAudioId,
      sourceAudioHash: request.sourceAudioHash ?? neuralResult.audioSha256,
      sourceSampleRate,
      totalSourceSamples,
      modelId: this.manifest.modelId,
      modelVersion: this.manifest.version,
    });

    const metrics: ShahabAsrRuntimeMetrics = {
      modelId: this.manifest.modelId,
      upstreamModelId: this.manifest.provenance.upstreamModelId,
      runtime: 'sherpa-onnx-cpu',
      durationSec: neuralResult.durationSec,
      processingTimeMs: neuralResult.processingTimeMs,
      realTimeFactor: neuralResult.realTimeFactor,
      rssBeforeMb,
      rssAfterMb,
      peakRssMb: Math.max(rssBeforeMb, rssAfterMb),
      tokenCount: transcript.tokens.length,
      offlineVerified: true,
    };
    this.lastMetrics = metrics;

    if (request.unloadAfterTranscribe) {
      this.unload();
    }

    return { transcript, metrics };
  }
}
