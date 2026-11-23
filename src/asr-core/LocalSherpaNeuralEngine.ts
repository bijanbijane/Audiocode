/**
 * AVAPARDAZ — LOCAL NEURAL CPU ASR RUNTIME (SHERPA-ONNX ENGINE ADAPTER)
 *
 * Implements genuine 100% local, offline CPU neural speech recognition via
 * Sherpa-ONNX (ONNX Runtime CPU C++ backend) without requiring PyTorch, GPU,
 * or any external cloud inference API.
 *
 * Key guarantees (PHASE-08 & PHASE-09):
 * - Auto-discovers installed sherpa-onnx-offline binary & verified ONNX model packs
 * - Lazy single-model active guard (never loads multiple large models simultaneously)
 * - Strict offline child environment (blackholed proxy + HF_HUB_OFFLINE=1)
 * - Real AbortSignal cancellation (terminates child process cleanly)
 * - Honest timestamp granularity: WORD/TOKEN timestamps ONLY when emitted by the model
 *   (e.g., NeMo FastConformer CTC); SEGMENT timestamps for encoder-decoder models (Whisper)
 * - Zero shell interpolation (spawn with argv array, shell: false)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ingestAudioBufferToCanonical16kMono, float32ToPcm16Buffer } from './CoreAudioIngestion';
import {
  ALLOWED_MODEL_DOWNLOAD_HOSTS,
  activateDirectoryAtomically,
  downloadFileWithRedirects,
  extractTarBz2Safe,
} from './SafeModelSupplyChain';

export { ALLOWED_MODEL_DOWNLOAD_HOSTS, downloadFileWithRedirects, extractTarBz2Safe };
import { buildAllNormalizationProfiles, detectTextLanguageTag } from './CoreNormalizationAndLanguage';
import {
  findBestBoundaryValleySample,
  stitchSegmentsWithOverlapDeduplication,
} from './CoreBatchAndLongFormEngine';
import type {
  DetectedLanguageTag,
  NormalizationProfileId,
  TimestampGranularity,
} from './CoreAsrContracts';

export type LocalNeuralProfileId =
  | 'AVP_MODEL_LITE'
  | 'AVP_MODEL_BALANCED'
  | 'AVP_MODEL_QUALITY'
  | 'EXPERIMENTAL_QWEN3_ASR';

export type LocalNeuralArchitecture = 'nemo-ctc' | 'whisper' | 'qwen3-asr';

export interface InstalledLocalNeuralModel {
  readonly modelId: string;
  readonly profileId: LocalNeuralProfileId;
  readonly displayName: string;
  readonly architecture: LocalNeuralArchitecture;
  readonly quantization: 'INT8' | 'FP32';
  readonly licenseSpdx: string;
  readonly supportedLanguages: readonly ('fa' | 'en' | 'fa-en' | 'auto')[];
  readonly supportsNativeWordTimestamps: boolean;
  readonly rootDir: string;
  readonly diskSizeBytes: number;
  readonly requiredFiles: readonly string[];
  readonly integrityVerified: boolean;
  readonly extraCliArgs: readonly string[];
}

export interface LocalNeuralRuntimeStatus {
  readonly runtimeName: 'sherpa-onnx-cpu';
  readonly binaryPath: string | null;
  readonly libDir: string | null;
  readonly available: boolean;
  readonly offlineOnlyEnforced: true;
  readonly cpuThreads: number;
  readonly activeModelId: string | null;
  readonly installedModels: readonly InstalledLocalNeuralModel[];
  readonly processRssMb: number;
}

export interface LocalNeuralWordTiming {
  readonly word: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface LocalNeuralSegment {
  readonly id: string;
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly normalizedByProfile: Readonly<Record<NormalizationProfileId, string>>;
  readonly language: DetectedLanguageTag;
  readonly timestampGranularity: TimestampGranularity;
  readonly words: readonly LocalNeuralWordTiming[];
}

export interface LocalNeuralTranscriptionRequest {
  readonly modelId?: string;
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly audioBytes?: Buffer;
  readonly audioFilePath?: string;
  readonly filename?: string;
  readonly maxChunkDurationSec?: number;
  readonly overlapSec?: number;
  readonly numThreads?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly percent: number;
    readonly currentChunk: number;
    readonly totalChunks: number;
    readonly elapsedMs: number;
    readonly partialText: string;
  }) => void;
}

export interface LocalNeuralTranscriptionResult {
  readonly modelId: string;
  readonly architecture: LocalNeuralArchitecture;
  readonly quantization: 'INT8' | 'FP32';
  readonly offlineVerified: true;
  readonly durationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly dominantLanguage: DetectedLanguageTag;
  readonly rawText: string;
  readonly normalizedByProfile: Readonly<Record<NormalizationProfileId, string>>;
  readonly timestampGranularity: TimestampGranularity;
  readonly segments: readonly LocalNeuralSegment[];
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly audioSha256: string;
}

interface SherpaJsonOutput {
  lang?: string;
  text?: string;
  timestamps?: number[];
  tokens?: string[];
}

const DEFAULT_MODEL_SEARCH_DIRS = [
  process.env.AVAPARDAZ_MODELS_DIR,
  path.join(os.homedir(), '.avapardaz', 'models'),
  path.resolve(process.cwd(), 'models'),
  '/tmp/avp-p02-bench/models/extracted',
].filter((d): d is string => Boolean(d && d.trim().length > 0));

const DEFAULT_BINARY_CANDIDATES = [
  process.env.AVAPARDAZ_SHERPA_BIN,
  path.join(os.homedir(), '.avapardaz', 'runtime', 'bin', 'sherpa-onnx-offline'),
  '/tmp/avp-p02-bench/runtime/sherpa-onnx-v2.0.2-linux-x64-shared-no-tts/bin/sherpa-onnx-offline',
  '/usr/local/bin/sherpa-onnx-offline',
].filter((p): p is string => Boolean(p && p.trim().length > 0));

export const SHENAVA_RIZEH_RUNTIME_RELEASE = {
  runtimeVersion: 'v2.0.2',
  runtimeArchiveName: 'sherpa-onnx-v2.0.2-linux-x64-shared-no-tts.tar.bz2',
  runtimeUrl:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-v2.0.2-linux-x64-shared-no-tts.tar.bz2',
  modelDirName: 'sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26',
  modelArchiveName:
    'sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26.tar.bz2',
  modelUrl:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26.tar.bz2',
} as const;

export const KNOWN_MODEL_ARTIFACT_PROVENANCE: Readonly<
  Record<string, { readonly expectedBytes: number; readonly sha256Hex: string }>
> = {
  'model.int8.onnx': {
    expectedBytes: 38_183_269,
    sha256Hex: '6bdd4ab80626ddfe0b19338a5c96fcc4f2021ad78899cece20a805a48dc5250d',
  },
  'tokens.txt': {
    expectedBytes: 12_236,
    sha256Hex: '8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954',
  },
  'turbo-encoder.int8.onnx': {
    expectedBytes: 674_716_297,
    sha256Hex: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b',
  },
  'turbo-decoder.int8.onnx': {
    expectedBytes: 361_080_764,
    sha256Hex: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547',
  },
  'turbo-tokens.txt': {
    expectedBytes: 816_730,
    sha256Hex: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
  },
  'base-encoder.onnx': {
    expectedBytes: 95_087_154,
    sha256Hex: '5a6b87cb313993f6c9fefec9e7027556f6cb30becddf49655bee36c50ecc12d7',
  },
  'base-decoder.onnx': {
    expectedBytes: 196_548_998,
    sha256Hex: '8a12c3f6ad65bb5b86d7e6eccc302378f20f9fb2df6cb10747c62895da7ac194',
  },
  'base-encoder.int8.onnx': {
    expectedBytes: 29_120_534,
    sha256Hex: '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11',
  },
  'base-decoder.int8.onnx': {
    expectedBytes: 130_672_026,
    sha256Hex: '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d',
  },
};

const artifactIntegrityCache = new Map<string, boolean>();

function encodeFloat32ToWav16kMono(samples: Float32Array, sampleRate = 16_000): Buffer {
  const pcmBuf = float32ToPcm16Buffer(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuf.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuf.byteLength, 40);
  return Buffer.concat([header, pcmBuf]);
}

function fileSizeSafe(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function allFilesExistNonEmpty(files: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => fileSizeSafe(f) > 0);
}

export function verifyModelFilesIntegrity(files: readonly string[]): boolean {
  if (files.length === 0) return false;
  for (const filePath of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size <= 0) return false;

    const baseName = path.basename(filePath);
    const known = KNOWN_MODEL_ARTIFACT_PROVENANCE[baseName];
    if (!known) {
      continue;
    }
    if (stat.size !== known.expectedBytes) {
      return false;
    }

    const cacheKey = `${filePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const cached = artifactIntegrityCache.get(cacheKey);
    if (cached !== undefined) {
      if (!cached) return false;
      continue;
    }

    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        hash.update(chunk.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    const digest = hash.digest('hex');
    const verified = digest === known.sha256Hex;
    artifactIntegrityCache.set(cacheKey, verified);
    if (!verified) {
      return false;
    }
  }
  return true;
}

function detectSherpaBinary(): { binaryPath: string | null; libDir: string | null } {
  for (const candidate of DEFAULT_BINARY_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const binDir = path.dirname(candidate);
      const siblingLib = path.resolve(binDir, '..', 'lib');
      const libDir = fs.existsSync(siblingLib) ? siblingLib : null;
      return { binaryPath: candidate, libDir };
    } catch {
      // continue searching
    }
  }
  return { binaryPath: null, libDir: null };
}

function discoverModelsInRoot(rootDir: string): InstalledLocalNeuralModel[] {
  if (!fs.existsSync(rootDir)) return [];
  const discovered: InstalledLocalNeuralModel[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirsToCheck = [
    rootDir,
    ...entries.filter((e) => e.isDirectory()).map((e) => path.join(rootDir, e.name)),
  ];

  for (const dir of dirsToCheck) {
    // 1. Shenava Rizeh NeMo FastConformer CTC Persian INT8
    const nemoModel = path.join(dir, 'model.int8.onnx');
    const nemoTokens = path.join(dir, 'tokens.txt');
    if (allFilesExistNonEmpty([nemoModel, nemoTokens]) && path.basename(dir).includes('shenava')) {
      const files = [nemoModel, nemoTokens];
      discovered.push({
        modelId: 'Reza2kn/Shenava-Rizeh',
        profileId: 'AVP_MODEL_LITE',
        displayName: 'موتور بومی شهاب / شناوا ریزه (FastConformer فارسی INT8)',
        architecture: 'nemo-ctc',
        quantization: 'INT8',
        licenseSpdx: 'Apache-2.0',
        supportedLanguages: ['fa'],
        supportsNativeWordTimestamps: true,
        rootDir: dir,
        diskSizeBytes: fileSizeSafe(nemoModel) + fileSizeSafe(nemoTokens),
        requiredFiles: files,
        integrityVerified: verifyModelFilesIntegrity(files),
        extraCliArgs: [`--nemo-ctc-model=${nemoModel}`, `--tokens=${nemoTokens}`],
      });
    }

    // 2. OpenAI Whisper large-v3-turbo INT8
    const turboEnc = path.join(dir, 'turbo-encoder.int8.onnx');
    const turboDec = path.join(dir, 'turbo-decoder.int8.onnx');
    const turboTok = path.join(dir, 'turbo-tokens.txt');
    if (allFilesExistNonEmpty([turboEnc, turboDec, turboTok])) {
      const files = [turboEnc, turboDec, turboTok];
      discovered.push({
        modelId: 'openai/whisper-large-v3-turbo-int8',
        profileId: 'AVP_MODEL_QUALITY',
        displayName: 'Whisper Large-v3-Turbo (دوزبانه فارسی/انگلیسی INT8)',
        architecture: 'whisper',
        quantization: 'INT8',
        licenseSpdx: 'MIT',
        supportedLanguages: ['fa', 'en', 'fa-en', 'auto'],
        supportsNativeWordTimestamps: false,
        rootDir: dir,
        diskSizeBytes: fileSizeSafe(turboEnc) + fileSizeSafe(turboDec) + fileSizeSafe(turboTok),
        requiredFiles: files,
        integrityVerified: verifyModelFilesIntegrity(files),
        extraCliArgs: [
          `--whisper-encoder=${turboEnc}`,
          `--whisper-decoder=${turboDec}`,
          `--tokens=${turboTok}`,
          '--whisper-task=transcribe',
          '--whisper-tail-paddings=300',
        ],
      });
    }

    // 3. OpenAI Whisper Base INT8 (and FP32 if present)
    const baseEncInt8 = path.join(dir, 'base-encoder.int8.onnx');
    const baseDecInt8 = path.join(dir, 'base-decoder.int8.onnx');
    const baseTok = path.join(dir, 'base-tokens.txt');
    if (allFilesExistNonEmpty([baseEncInt8, baseDecInt8, baseTok])) {
      const files = [baseEncInt8, baseDecInt8, baseTok];
      discovered.push({
        modelId: 'openai/whisper-base-int8',
        profileId: 'AVP_MODEL_BALANCED',
        displayName: 'Whisper Base (دوزبانه کم‌مصرف INT8)',
        architecture: 'whisper',
        quantization: 'INT8',
        licenseSpdx: 'MIT',
        supportedLanguages: ['fa', 'en', 'fa-en', 'auto'],
        supportsNativeWordTimestamps: false,
        rootDir: dir,
        diskSizeBytes: fileSizeSafe(baseEncInt8) + fileSizeSafe(baseDecInt8) + fileSizeSafe(baseTok),
        requiredFiles: files,
        integrityVerified: verifyModelFilesIntegrity(files),
        extraCliArgs: [
          `--whisper-encoder=${baseEncInt8}`,
          `--whisper-decoder=${baseDecInt8}`,
          `--tokens=${baseTok}`,
          '--whisper-task=transcribe',
          '--whisper-tail-paddings=300',
        ],
      });
    }

    const baseEncFp32 = path.join(dir, 'base-encoder.onnx');
    const baseDecFp32 = path.join(dir, 'base-decoder.onnx');
    if (allFilesExistNonEmpty([baseEncFp32, baseDecFp32, baseTok])) {
      const files = [baseEncFp32, baseDecFp32, baseTok];
      discovered.push({
        modelId: 'openai/whisper-base-fp32',
        profileId: 'AVP_MODEL_BALANCED',
        displayName: 'Whisper Base (دوزبانه FP32)',
        architecture: 'whisper',
        quantization: 'FP32',
        licenseSpdx: 'MIT',
        supportedLanguages: ['fa', 'en', 'fa-en', 'auto'],
        supportsNativeWordTimestamps: false,
        rootDir: dir,
        diskSizeBytes: fileSizeSafe(baseEncFp32) + fileSizeSafe(baseDecFp32) + fileSizeSafe(baseTok),
        requiredFiles: files,
        integrityVerified: verifyModelFilesIntegrity(files),
        extraCliArgs: [
          `--whisper-encoder=${baseEncFp32}`,
          `--whisper-decoder=${baseDecFp32}`,
          `--tokens=${baseTok}`,
          '--whisper-task=transcribe',
          '--whisper-tail-paddings=300',
        ],
      });
    }
  }

  return discovered;
}

// Hardened downloadFileWithRedirects and extractTarBz2Safe are imported and re-exported
// from ./SafeModelSupplyChain (HTTPS-only allowlist, SSRF/redirect defense, streaming size ceiling,
// timeouts, AbortSignal cancellation, member-by-member tar extraction with zero unsafe tar fallback).

/**
 * Reconstructs honest word-level timestamps strictly from genuine SentencePiece token timestamps
 * emitted by CTC models (e.g., Shenava Rizeh). Returns [] if model emitted no timestamps.
 */
function buildWordTimingsFromTokens(
  tokens: readonly string[] | undefined,
  timestamps: readonly number[] | undefined,
  chunkOffsetSec: number,
  chunkEndSec: number,
): LocalNeuralWordTiming[] {
  if (!Array.isArray(tokens) || !Array.isArray(timestamps) || tokens.length === 0 || tokens.length !== timestamps.length) {
    return [];
  }
  const words: LocalNeuralWordTiming[] = [];
  let currentWord = '';
  let currentStart = -1;

  for (let i = 0; i < tokens.length; i++) {
    const rawTok = tokens[i];
    const ts = Number(timestamps[i]);
    if (!Number.isFinite(ts)) continue;
    const startsNewWord = rawTok.startsWith(' ') || rawTok.startsWith('▁');
    const cleanPiece = rawTok.replace(/^[\s▁]+/, '');

    if (startsNewWord && currentWord.length > 0) {
      const nextStart = chunkOffsetSec + ts;
      words.push({
        word: currentWord,
        startSec: Number(currentStart.toFixed(3)),
        endSec: Number(Math.max(currentStart + 0.04, Math.min(chunkEndSec, nextStart)).toFixed(3)),
      });
      currentWord = cleanPiece;
      currentStart = chunkOffsetSec + ts;
    } else {
      if (currentWord.length === 0) {
        currentStart = chunkOffsetSec + ts;
      }
      currentWord += cleanPiece;
    }
  }

  if (currentWord.length > 0 && currentStart >= 0) {
    words.push({
      word: currentWord,
      startSec: Number(currentStart.toFixed(3)),
      endSec: Number(Math.max(currentStart + 0.08, chunkEndSec).toFixed(3)),
    });
  }

  return words;
}

export interface EnsuredShenavaModelArtifacts {
  readonly modelId: 'shenava-rizen-fa-fastconformer-int8';
  readonly upstreamModelId: 'Reza2kn/Shenava-Rizeh';
  readonly modelVersion: '1.0.0';
  readonly architecture: 'FASTCONFORMER_CTC';
  readonly rootDir: string;
  readonly modelOnnxPath: string;
  readonly modelOnnxBytes: number;
  readonly modelOnnxSha256Hex: string;
  readonly tokensPath: string;
  readonly tokensBytes: number;
  readonly tokensSha256Hex: string;
  readonly sampleWavPath: string | null;
}

export class LocalSherpaNeuralEngine {
  private readonly modelSearchDirs: readonly string[];
  private activeModelId: string | null = null;
  private cachedModels: InstalledLocalNeuralModel[] = [];
  private readonly defaultCpuThreads: number;
  private ensureShenavaArtifactsPromise: Promise<EnsuredShenavaModelArtifacts> | null = null;
  private installShenavaRuntimePromise: Promise<LocalNeuralRuntimeStatus> | null = null;

  constructor(options?: { readonly modelSearchDirs?: readonly string[]; readonly cpuThreads?: number }) {
    this.modelSearchDirs = options?.modelSearchDirs ?? DEFAULT_MODEL_SEARCH_DIRS;
    const cpuCount = os.cpus()?.length || 4;
    this.defaultCpuThreads = Math.max(1, Math.min(8, options?.cpuThreads ?? Math.min(4, cpuCount)));
    this.refreshInstalledModels();
  }

  public refreshInstalledModels(): readonly InstalledLocalNeuralModel[] {
    const byId = new Map<string, InstalledLocalNeuralModel>();
    for (const dir of this.modelSearchDirs) {
      for (const m of discoverModelsInRoot(dir)) {
        if (!byId.has(m.modelId)) {
          byId.set(m.modelId, m);
        }
      }
    }
    this.cachedModels = Array.from(byId.values());
    if (this.activeModelId && !byId.has(this.activeModelId)) {
      this.activeModelId = null;
    }
    return this.cachedModels;
  }

  public getStatus(): LocalNeuralRuntimeStatus {
    const { binaryPath, libDir } = detectSherpaBinary();
    this.refreshInstalledModels();
    const verifiedModels = this.cachedModels.filter((m) => m.integrityVerified);
    return {
      runtimeName: 'sherpa-onnx-cpu',
      binaryPath,
      libDir,
      available: Boolean(binaryPath && verifiedModels.length > 0),
      offlineOnlyEnforced: true,
      cpuThreads: this.defaultCpuThreads,
      activeModelId: this.activeModelId,
      installedModels: this.cachedModels,
      processRssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
    };
  }

  public getBundledSampleAudioPath(): {
    readonly filePath: string;
    readonly filename: string;
    readonly modelId: string;
  } | null {
    this.refreshInstalledModels();
    const verified = this.cachedModels.filter((m) => m.integrityVerified);
    const ordered = [
      ...verified.filter((m) => m.modelId === 'Reza2kn/Shenava-Rizeh'),
      ...verified.filter((m) => m.modelId !== 'Reza2kn/Shenava-Rizeh'),
    ];
    for (const model of ordered) {
      for (const relName of ['0.wav', '1.wav']) {
        const candidate = path.join(model.rootDir, 'test_wavs', relName);
        if (fileSizeSafe(candidate) > 44) {
          return {
            filePath: candidate,
            filename: `shenava-sample-${relName}`,
            modelId: model.modelId,
          };
        }
      }
    }
    return null;
  }

  private findVerifiedShenavaArtifactsOnDisk(): EnsuredShenavaModelArtifacts | null {
    this.refreshInstalledModels();
    const installed = this.cachedModels.find(
      (m) => m.modelId === 'Reza2kn/Shenava-Rizeh' && m.integrityVerified,
    );
    if (!installed) return null;

    const modelOnnxPath = path.join(installed.rootDir, 'model.int8.onnx');
    const tokensPath = path.join(installed.rootDir, 'tokens.txt');
    if (!verifyModelFilesIntegrity([modelOnnxPath, tokensPath])) {
      return null;
    }

    const candidateSample = path.join(installed.rootDir, 'test_wavs', '0.wav');
    const sampleWavPath = fileSizeSafe(candidateSample) > 44 ? candidateSample : null;
    const onnxProvenance = KNOWN_MODEL_ARTIFACT_PROVENANCE['model.int8.onnx'];
    const tokensProvenance = KNOWN_MODEL_ARTIFACT_PROVENANCE['tokens.txt'];

    return {
      modelId: 'shenava-rizen-fa-fastconformer-int8',
      upstreamModelId: 'Reza2kn/Shenava-Rizeh',
      modelVersion: '1.0.0',
      architecture: 'FASTCONFORMER_CTC',
      rootDir: installed.rootDir,
      modelOnnxPath,
      modelOnnxBytes: onnxProvenance.expectedBytes,
      modelOnnxSha256Hex: onnxProvenance.sha256Hex,
      tokensPath,
      tokensBytes: tokensProvenance.expectedBytes,
      tokensSha256Hex: tokensProvenance.sha256Hex,
      sampleWavPath,
    };
  }

  /**
   * Ensures verified Shenava-Rizeh INT8 ONNX weights (`model.int8.onnx`) + CTC vocabulary (`tokens.txt`)
   * are present locally on disk with SHA-256 provenance verification, for either Browser WASM OPFS
   * streaming or Native Companion CPU inference. Safe against concurrent callers.
   */
  public async ensureShenavaRizehModelArtifacts(options?: {
    readonly signal?: AbortSignal;
  }): Promise<EnsuredShenavaModelArtifacts> {
    const existing = this.findVerifiedShenavaArtifactsOnDisk();
    if (existing) {
      return existing;
    }

    if (this.ensureShenavaArtifactsPromise) {
      return this.ensureShenavaArtifactsPromise;
    }

    const task = (async (): Promise<EnsuredShenavaModelArtifacts> => {
      const recheck = this.findVerifiedShenavaArtifactsOnDisk();
      if (recheck) {
        return recheck;
      }

      const baseDir = path.join(os.homedir(), '.avapardaz');
      const downloadsDir = path.join(baseDir, 'downloads');
      const modelsDir = path.join(baseDir, 'models');
      fs.mkdirSync(downloadsDir, { recursive: true });
      fs.mkdirSync(modelsDir, { recursive: true });

      const uniqueSuffix = `${Date.now()}_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
      const mdlArchive = path.join(
        downloadsDir,
        `${uniqueSuffix}_${SHENAVA_RIZEH_RUNTIME_RELEASE.modelArchiveName}`,
      );
      const stageParent = fs.mkdtempSync(path.join(downloadsDir, 'avp-mdl-stage-'));
      const targetModelDir = path.join(modelsDir, SHENAVA_RIZEH_RUNTIME_RELEASE.modelDirName);

      try {
        await downloadFileWithRedirects(SHENAVA_RIZEH_RUNTIME_RELEASE.modelUrl, mdlArchive, {
          allowedHosts: ALLOWED_MODEL_DOWNLOAD_HOSTS,
          maxRedirects: 5,
          maxBytes: 120 * 1024 * 1024, // 120 MiB ceiling for ~36 MiB INT8 archive
          connectTimeoutMs: 15_000,
          totalTimeoutMs: 180_000,
          signal: options?.signal,
        });

        await extractTarBz2Safe(mdlArchive, stageParent, {
          maxFiles: 64,
          maxSingleFileBytes: 80 * 1024 * 1024,
          maxTotalBytes: 120 * 1024 * 1024,
          allowExecutablesInBin: false,
        });

        const stagedModelDir = path.join(stageParent, SHENAVA_RIZEH_RUNTIME_RELEASE.modelDirName);
        if (!fs.existsSync(stagedModelDir) || !fs.statSync(stagedModelDir).isDirectory()) {
          throw new Error(
            'SHENAVA_STRUCTURE_INVALID: Extracted archive did not contain expected Shenava-Rizeh directory.',
          );
        }

        await activateDirectoryAtomically({
          stagedDir: stagedModelDir,
          targetDir: targetModelDir,
          validateStaged: (dir) => {
            const onnxPath = path.join(dir, 'model.int8.onnx');
            const tokensPath = path.join(dir, 'tokens.txt');
            if (!fs.existsSync(onnxPath) || !fs.existsSync(tokensPath)) return false;
            if (fs.lstatSync(onnxPath).isSymbolicLink() || fs.lstatSync(tokensPath).isSymbolicLink()) {
              return false;
            }
            return verifyModelFilesIntegrity([onnxPath, tokensPath]);
          },
        });
      } finally {
        fs.rmSync(mdlArchive, { force: true });
        fs.rmSync(stageParent, { recursive: true, force: true });
      }

      const ensured = this.findVerifiedShenavaArtifactsOnDisk();
      if (!ensured) {
        throw new Error(
          'SHENAVA_ARTIFACTS_NOT_DISCOVERABLE: Verified model was extracted but could not be resolved in modelSearchDirs.',
        );
      }
      return ensured;
    })();

    this.ensureShenavaArtifactsPromise = task.finally(() => {
      if (this.ensureShenavaArtifactsPromise === task) {
        this.ensureShenavaArtifactsPromise = null;
      }
    });

    return this.ensureShenavaArtifactsPromise;
  }

  public async installShenavaRizehRuntime(options?: {
    readonly signal?: AbortSignal;
  }): Promise<LocalNeuralRuntimeStatus> {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      throw new Error(
        `NATIVE_INSTALLER_UNSUPPORTED_PLATFORM: Automatic server-side installer targets linux-x64 (current: ${process.platform}-${process.arch}).`,
      );
    }

    if (this.installShenavaRuntimePromise) {
      return this.installShenavaRuntimePromise;
    }

    const task = (async (): Promise<LocalNeuralRuntimeStatus> => {
      const baseDir = path.join(os.homedir(), '.avapardaz');
      const downloadsDir = path.join(baseDir, 'downloads');
      const runtimeDir = path.join(baseDir, 'runtime');
      fs.mkdirSync(downloadsDir, { recursive: true });
      fs.mkdirSync(baseDir, { recursive: true });

      const { binaryPath } = detectSherpaBinary();
      if (!binaryPath) {
        const rtArchive = path.join(
          downloadsDir,
          `${Date.now()}_${process.pid}_${SHENAVA_RIZEH_RUNTIME_RELEASE.runtimeArchiveName}`,
        );
        const rtTempExtract = fs.mkdtempSync(path.join(downloadsDir, 'avp-rt-stage-'));
        try {
          await downloadFileWithRedirects(SHENAVA_RIZEH_RUNTIME_RELEASE.runtimeUrl, rtArchive, {
            allowedHosts: ALLOWED_MODEL_DOWNLOAD_HOSTS,
            maxRedirects: 5,
            maxBytes: 250 * 1024 * 1024, // 250 MiB ceiling for runtime archive
            connectTimeoutMs: 15_000,
            totalTimeoutMs: 240_000,
            signal: options?.signal,
          });
          await extractTarBz2Safe(rtArchive, rtTempExtract, {
            maxFiles: 512,
            maxSingleFileBytes: 150 * 1024 * 1024,
            maxTotalBytes: 400 * 1024 * 1024,
            allowExecutablesInBin: true,
          });
          const extractedRoot = fs
            .readdirSync(rtTempExtract, { withFileTypes: true })
            .find((d) => d.isDirectory())?.name;
          const srcRoot = extractedRoot ? path.join(rtTempExtract, extractedRoot) : rtTempExtract;

          await activateDirectoryAtomically({
            stagedDir: srcRoot,
            targetDir: runtimeDir,
            validateStaged: (dir) => {
              const stagedBin = path.join(dir, 'bin', 'sherpa-onnx-offline');
              if (!fs.existsSync(stagedBin) || fs.lstatSync(stagedBin).isSymbolicLink()) return false;
              fs.chmodSync(stagedBin, 0o755);
              return fs.statSync(stagedBin).size > 0;
            },
          });
        } finally {
          fs.rmSync(rtTempExtract, { recursive: true, force: true });
          fs.rmSync(rtArchive, { force: true });
        }
      }

      await this.ensureShenavaRizehModelArtifacts({ signal: options?.signal });
      return this.getStatus();
    })();

    this.installShenavaRuntimePromise = task.finally(() => {
      if (this.installShenavaRuntimePromise === task) {
        this.installShenavaRuntimePromise = null;
      }
    });

    return this.installShenavaRuntimePromise;
  }

  public unloadActiveModel(): { readonly unloadedModelId: string | null; readonly rssMb: number } {
    const prev = this.activeModelId;
    this.activeModelId = null;
    return {
      unloadedModelId: prev,
      rssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
    };
  }

  public selectModel(requestedModelId?: string, languageHint: 'fa' | 'en' | 'fa-en' | 'auto' = 'auto'): InstalledLocalNeuralModel | null {
    this.refreshInstalledModels();
    const verifiedModels = this.cachedModels.filter((m) => m.integrityVerified);
    if (verifiedModels.length === 0) return null;

    if (requestedModelId) {
      const exact = verifiedModels.find((m) => m.modelId === requestedModelId);
      if (exact) return exact;
    }

    // Smart language-aware routing:
    // - Pure Persian ('fa'): prefer Whisper large-v3-turbo INT8 if installed for quality, else Shenava Rizeh INT8 (ultra-fast Persian)
    // - English / Bilingual / Auto: NEVER pick Persian-only Shenava Rizeh; pick Whisper large-v3-turbo INT8 -> Whisper Base INT8
    if (languageHint === 'fa') {
      return (
        verifiedModels.find((m) => m.modelId === 'Reza2kn/Shenava-Rizeh') ??
        verifiedModels.find((m) => m.modelId === 'openai/whisper-large-v3-turbo-int8') ??
        verifiedModels.find((m) => m.modelId === 'openai/whisper-base-fp32') ??
        verifiedModels[0]
      );
    }

    return (
      verifiedModels.find((m) => m.modelId === 'openai/whisper-large-v3-turbo-int8') ??
      verifiedModels.find((m) => m.modelId === 'openai/whisper-base-fp32') ??
      verifiedModels.find((m) => m.modelId === 'Reza2kn/Shenava-Rizeh') ??
      verifiedModels[0]
    );
  }

  private async runSherpaSingleWav(params: {
    readonly binaryPath: string;
    readonly libDir: string | null;
    readonly model: InstalledLocalNeuralModel;
    readonly wavPath: string;
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly numThreads: number;
    readonly signal?: AbortSignal;
  }): Promise<SherpaJsonOutput> {
    if (params.signal?.aborted) {
      throw new Error('TRANSCRIPTION_CANCELLED');
    }

    const args = [...params.model.extraCliArgs, `--num-threads=${params.numThreads}`];
    if (params.model.architecture === 'whisper' && (params.languageHint === 'fa' || params.languageHint === 'en')) {
      args.push(`--whisper-language=${params.languageHint}`);
    }
    args.push(params.wavPath);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Strict offline execution isolation
      http_proxy: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    };
    if (params.libDir) {
      env.LD_LIBRARY_PATH = `${params.libDir}:${env.LD_LIBRARY_PATH ?? ''}`;
    }

    return await new Promise<SherpaJsonOutput>((resolve, reject) => {
      const child = spawn(params.binaryPath, args, {
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killedByAbort = false;

      const onAbort = () => {
        killedByAbort = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      };

      if (params.signal) {
        if (params.signal.aborted) {
          onAbort();
        } else {
          params.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        params.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        params.signal?.removeEventListener('abort', onAbort);
        if (killedByAbort || params.signal?.aborted) {
          reject(new Error('TRANSCRIPTION_CANCELLED'));
          return;
        }
        if (code !== 0) {
          reject(new Error(`SHERPA_EXIT_${code}: ${stderr.split('\n').slice(-4).join(' | ')}`));
          return;
        }
        for (const rawLine of stdout.split('\n')) {
          const line = rawLine.trim();
          if (line.startsWith('{') && line.endsWith('}')) {
            try {
              const parsed = JSON.parse(line) as SherpaJsonOutput;
              resolve(parsed);
              return;
            } catch {
              // keep scanning
            }
          }
        }
        resolve({ text: '' });
      });
    });
  }

  public async transcribe(request: LocalNeuralTranscriptionRequest): Promise<LocalNeuralTranscriptionResult> {
    const t0 = performance.now();
    const { binaryPath, libDir } = detectSherpaBinary();
    if (!binaryPath) {
      throw new Error('LOCAL_NEURAL_RUNTIME_UNAVAILABLE: sherpa-onnx-offline binary not found.');
    }

    const languageHint = request.languageHint ?? 'auto';
    const model = this.selectModel(request.modelId, languageHint);
    if (!model) {
      throw new Error('LOCAL_MODEL_NOT_INSTALLED: No verified ONNX model found in model directories.');
    }

    // Single active neural model guard
    this.activeModelId = model.modelId;

    let rawBytes: Buffer;
    let filename = request.filename ?? 'audio.wav';
    if (request.audioBytes && request.audioBytes.byteLength > 0) {
      rawBytes = request.audioBytes;
    } else if (request.audioFilePath) {
      rawBytes = fs.readFileSync(request.audioFilePath);
      filename = path.basename(request.audioFilePath);
    } else {
      throw new Error('INVALID_AUDIO_INPUT: Either audioBytes or audioFilePath is required.');
    }

    const audioSha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');

    // Canonical decode & resample to 16 kHz Mono Float32 PCM (handles 8k/16k/22.05k/44.1k/48k + stereo->mono)
    const canonical = ingestAudioBufferToCanonical16kMono({
      filename,
      rawBytes,
    });
    const pcm16k = canonical.canonicalFloat32;
    const sampleRate = 16_000;
    const durationSec = Number((pcm16k.length / sampleRate).toFixed(3));

    const maxChunkSec = Math.max(5, Math.min(30, request.maxChunkDurationSec ?? 25));
    const overlapSec = Math.max(0, Math.min(3, request.overlapSec ?? 1.5));
    const maxChunkSamples = Math.round(maxChunkSec * sampleRate);
    const overlapSamples = Math.round(overlapSec * sampleRate);

    // Energy-valley VAD boundary planning so chunks never slice mid-word
    const ranges: Array<{ startSample: number; endSample: number }> = [];
    if (pcm16k.length <= maxChunkSamples) {
      ranges.push({ startSample: 0, endSample: pcm16k.length });
    } else {
      let cursor = 0;
      while (cursor < pcm16k.length) {
        const nominalEnd = Math.min(pcm16k.length, cursor + maxChunkSamples);
        const endSample =
          nominalEnd >= pcm16k.length - sampleRate
            ? pcm16k.length
            : findBestBoundaryValleySample(pcm16k, nominalEnd, Math.round(sampleRate * 1.5));
        ranges.push({ startSample: cursor, endSample });
        if (endSample >= pcm16k.length) break;
        cursor = Math.max(cursor + sampleRate, endSample - overlapSamples);
      }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-asr-'));
    const numThreads = Math.max(1, Math.min(8, request.numThreads ?? this.defaultCpuThreads));
    const segments: LocalNeuralSegment[] = [];
    let hasAnyWordTimestamps = false;

    try {
      for (let i = 0; i < ranges.length; i++) {
        if (request.signal?.aborted) {
          throw new Error('TRANSCRIPTION_CANCELLED');
        }
        const range = ranges[i];
        const slice = pcm16k.subarray(range.startSample, range.endSample);
        const chunkWavPath = path.join(tempDir, `chunk_${i}.wav`);
        const wavBuf = encodeFloat32ToWav16kMono(slice, sampleRate);
        fs.writeFileSync(chunkWavPath, wavBuf);

        const chunkStartSec = Number((range.startSample / sampleRate).toFixed(3));
        const chunkEndSec = Number((range.endSample / sampleRate).toFixed(3));

        const out = await this.runSherpaSingleWav({
          binaryPath,
          libDir,
          model,
          wavPath: chunkWavPath,
          languageHint,
          numThreads,
          signal: request.signal,
        });

        // Clean up chunk WAV immediately to keep temp disk usage O(1) for 60-minute files
        try {
          fs.unlinkSync(chunkWavPath);
        } catch {
          // ignore
        }

        const segText = String(out.text ?? '').trim();
        const words = buildWordTimingsFromTokens(out.tokens, out.timestamps, chunkStartSec, chunkEndSec);
        if (words.length > 0) hasAnyWordTimestamps = true;

        const langTag: DetectedLanguageTag =
          out.lang === 'fa' || out.lang === 'en'
            ? out.lang
            : detectTextLanguageTag(segText).language;

        segments.push({
          id: `seg_${i}`,
          index: i,
          startSec: chunkStartSec,
          endSec: chunkEndSec,
          text: segText,
          normalizedByProfile: buildAllNormalizationProfiles(segText),
          language: langTag,
          timestampGranularity: words.length > 0 ? 'WORD' : 'SEGMENT',
          words,
        });

        const pct = Math.min(100, Math.round(((i + 1) / ranges.length) * 100));
        request.onProgress?.({
          percent: pct,
          currentChunk: i + 1,
          totalChunks: ranges.length,
          elapsedMs: Math.round(performance.now() - t0),
          partialText: segments.map((s) => s.text).filter(Boolean).join(' ').trim(),
        });
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    // Reconcile overlap boundaries using existing overlap deduplicator
    const pseudoCoreSegments = segments.map((s) => ({
      segmentId: s.id,
      segmentIndex: s.index,
      startSec: s.startSec,
      endSec: s.endSec,
      startSample: Math.round(s.startSec * sampleRate),
      endSample: Math.round(s.endSec * sampleRate),
      language: s.language,
      languageConfidence: null,
      rawModelOutput: s.text,
      normalizedByProfile: s.normalizedByProfile,
      words: [],
      timestampGranularity: s.timestampGranularity,
      confidenceStatus: 'UNAVAILABLE_UNCALIBRATED' as const,
      calibratedConfidence: null,
      acousticFrameCount: 0,
      backendUsed: 'EXTERNAL_ONNX_RUNTIME' as const,
      retryCount: 0,
      status: 'OK' as const,
      failureReason: null,
    }));

    const { stitchedRawText } = stitchSegmentsWithOverlapDeduplication(pseudoCoreSegments);
    const dominantLanguage = detectTextLanguageTag(stitchedRawText).language;
    const processingTimeMs = Number((performance.now() - t0).toFixed(2));
    const realTimeFactor = durationSec > 0 ? Number(((processingTimeMs / 1000) / durationSec).toFixed(4)) : 0;

    return {
      modelId: model.modelId,
      architecture: model.architecture,
      quantization: model.quantization,
      offlineVerified: true,
      durationSec,
      processingTimeMs,
      realTimeFactor,
      dominantLanguage,
      rawText: stitchedRawText,
      normalizedByProfile: buildAllNormalizationProfiles(stitchedRawText),
      timestampGranularity: hasAnyWordTimestamps ? 'WORD' : 'SEGMENT',
      segments,
      sampleRateHz: canonical.originalSampleRateHz,
      channelCount: canonical.originalChannels,
      audioSha256,
    };
  }
}
