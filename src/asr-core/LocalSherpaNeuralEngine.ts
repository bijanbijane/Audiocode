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
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { assertNativeBinaryArchitecture } from './NativeBinaryArchitecture.mjs';
import { resolveAvapardazReleaseTarget } from './NativeReleaseTargets.mjs';
import {
  ALLOWED_MODEL_DOWNLOAD_HOSTS,
  activateDirectoryAtomically,
  downloadFileWithRedirects,
  extractTarBz2Safe,
} from './SafeModelSupplyChain';

export { ALLOWED_MODEL_DOWNLOAD_HOSTS, downloadFileWithRedirects, extractTarBz2Safe };
import { buildAllNormalizationProfiles, detectTextLanguageTag } from './CoreNormalizationAndLanguage';
import {
  stitchSegmentsWithOverlapDeduplication,
} from './CoreBatchAndLongFormEngine';
import {
  CANONICAL_TARGET_SAMPLE_RATE_HZ,
  NativeIngestionMemoryTracker,
  cleanupOrphanedCanonicalIngestionFiles,
  createStreamingCanonicalAudioSource,
  type NativeAsrIngestionLifecycleState,
  type NativeIngestionMemorySnapshot,
} from './StreamingCanonicalAudioIngestion';
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
  readonly canonicalStagingDir?: string;
  readonly memoryTracker?: NativeIngestionMemoryTracker;
  readonly onIngestionLifecycleState?: (state: NativeAsrIngestionLifecycleState) => void;
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
  readonly ingestionMemory?: NativeIngestionMemorySnapshot;
}

export interface SherpaJsonOutput {
  lang?: string;
  text?: string;
  timestamps?: number[];
  durations?: number[];
  tokens?: string[];
  ysLogProbs?: number[];
}

interface PersistentSherpaPythonWorkerSession {
  transcribe(wavPath: string): Promise<SherpaJsonOutput>;
  close(): Promise<void>;
  readonly pid: number | undefined;
}

const AVAPARDAZ_HOME = process.env.AVAPARDAZ_HOME?.trim() || path.join(os.homedir(), 'AvaPardaz');
const DEFAULT_MODEL_SEARCH_DIRS = [
  process.env.AVAPARDAZ_MODELS_DIR,
  path.join(os.homedir(), '.avapardaz', 'models'),
  path.join(AVAPARDAZ_HOME, 'models'),
  path.resolve(process.cwd(), 'models'),
  '/tmp/avp-p02-bench/models/extracted',
].filter((d): d is string => Boolean(d && d.trim().length > 0));

const DEFAULT_BINARY_CANDIDATES = [
  process.env.AVAPARDAZ_SHERPA_BIN,
  // Per-user isolated Python wheel installation (macOS Apple Silicon / Linux / Windows).
  path.join(os.homedir(), '.avapardaz', 'runtime', 'sherpa-venv', 'bin', 'sherpa-onnx-offline'),
  path.join(os.homedir(), '.avapardaz', 'runtime', 'targets', `${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline'),
  path.join(AVAPARDAZ_HOME, 'runtime', 'targets', `${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline'),
  path.join(AVAPARDAZ_HOME, 'runtime', 'sherpa-venv', 'bin', 'sherpa-onnx-offline'),
  path.join(os.homedir(), '.avapardaz', 'runtime', 'sherpa-venv', 'Scripts', 'sherpa-onnx-offline.exe'),
  path.join(os.homedir(), '.avapardaz', 'runtime', 'bin', 'sherpa-onnx-offline'),
  path.join(AVAPARDAZ_HOME, 'runtime', 'bin', process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline'),
  '/opt/homebrew/bin/sherpa-onnx-offline',
  '/usr/local/bin/sherpa-onnx-offline',
  '/tmp/avp-p02-bench/runtime/sherpa-onnx-v2.0.2-linux-x64-shared-no-tts/bin/sherpa-onnx-offline',
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

const SHAHAB_KOOCHIK_V1_MODEL_PROVENANCE = Object.freeze({
  expectedBytes: 458_819_249,
  sha256Hex: '6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d',
});

function verifyPinnedModelArtifact(
  filePath: string,
  expectedBytes: number,
  expectedSha256Hex: string,
): boolean {
  let stat: fs.Stats;
  try {
    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink()) return false;
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== expectedBytes) return false;

  const cacheKey = `${filePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}:${expectedSha256Hex}`;
  const cached = artifactIntegrityCache.get(cacheKey);
  if (cached !== undefined) return cached;

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
  const verified = hash.digest('hex') === expectedSha256Hex;
  artifactIntegrityCache.set(cacheKey, verified);
  return verified;
}

function verifyShahabKoochikV1Artifacts(modelPath: string, tokensPath: string): boolean {
  return (
    verifyPinnedModelArtifact(
      modelPath,
      SHAHAB_KOOCHIK_V1_MODEL_PROVENANCE.expectedBytes,
      SHAHAB_KOOCHIK_V1_MODEL_PROVENANCE.sha256Hex,
    ) && verifyModelFilesIntegrity([tokensPath])
  );
}

/** Verifies the exact Koochik FP32 model and tokenizer pair used by SHAHAB Engine 01. */
export function verifyShahabKoochikModelFiles(modelDirectory: string): boolean {
  const resolved = path.resolve(modelDirectory);
  return verifyShahabKoochikV1Artifacts(
    path.join(resolved, 'model.onnx'),
    path.join(resolved, 'tokens.txt'),
  );
}

export function isSherpaRuntimeLibraryName(fileName: string, platform = process.platform): boolean {
  if (platform === 'win32') {
    return /^(?:onnxruntime(?:_providers_[a-z0-9_]+)?|sherpa-onnx-c-api)\.dll$/i.test(fileName);
  }
  if (platform === 'darwin') {
    return /^lib(?:onnxruntime|sherpa-onnx-c-api)(?:\.\d+(?:\.\d+)*)?\.dylib$/.test(fileName);
  }
  return /^lib(?:onnxruntime|sherpa-onnx-c-api)\.so(?:\.\d+)*$/.test(fileName);
}

export function sherpaLibraryPathEnvironmentVariable(platform = process.platform): 'DYLD_LIBRARY_PATH' | 'LD_LIBRARY_PATH' | 'PATH' {
  if (platform === 'darwin') return 'DYLD_LIBRARY_PATH';
  if (platform === 'win32') return 'PATH';
  return 'LD_LIBRARY_PATH';
}

function detectSherpaBinary(): { binaryPath: string | null; libDir: string | null } {
  const executableName = process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline';
  const pathCandidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executableName));
  const candidates = [...DEFAULT_BINARY_CANDIDATES, ...pathCandidates].filter(
    (p): p is string => Boolean(p && p.trim().length > 0),
  );
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const binDir = path.dirname(candidate);
      const siblingLib = path.resolve(binDir, '..', 'lib');
      const libraryCandidates = [
        siblingLib,
        path.join(siblingLib, 'python3.11', 'site-packages', 'sherpa_onnx', 'lib'),
        path.join(siblingLib, 'python3.12', 'site-packages', 'sherpa_onnx', 'lib'),
        path.join(siblingLib, 'python3.13', 'site-packages', 'sherpa_onnx', 'lib'),
        path.join(binDir, '..', 'lib', 'sherpa-onnx'),
      ];
      const libDir = libraryCandidates.find((directory) => {
        try {
          return fs.readdirSync(directory).some((name) => isSherpaRuntimeLibraryName(name));
        } catch {
          return false;
        }
      }) ?? null;
      if (libDir && (process.platform === 'darwin' || process.platform === 'win32')) {
        try {
          const target = resolveAvapardazReleaseTarget();
          assertNativeBinaryArchitecture({ filePath: candidate, platform: target.platform, arch: target.arch });
          for (const name of fs.readdirSync(libDir)) {
            if (!isSherpaRuntimeLibraryName(name)) continue;
            assertNativeBinaryArchitecture({ filePath: path.join(libDir, name), platform: target.platform, arch: target.arch });
          }
        } catch {
          continue;
        }
      }
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
    // SHAHAB quality candidate: official, immutable Apache-2.0 Shenava Koochik v1.0 NeMo CTC.
    // It is considered installed only after the 458,819,249-byte ONNX graph and tokens
    // pass pinned SHA-256 checks; a folder name or non-empty file is never sufficient.
    const dirName = path.basename(dir).toLowerCase();
    const koochikModel = path.join(dir, 'model.onnx');
    const koochikTokens = path.join(dir, 'tokens.txt');
    if (
      dirName.includes('koochik') &&
      allFilesExistNonEmpty([koochikModel, koochikTokens]) &&
      verifyShahabKoochikV1Artifacts(koochikModel, koochikTokens)
    ) {
      const files = [koochikModel, koochikTokens];
      discovered.push({
        modelId: 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx',
        profileId: 'AVP_MODEL_QUALITY',
        displayName: 'Shenava Koochik v1.0 (Persian FastConformer CTC)',
        architecture: 'nemo-ctc',
        quantization: 'FP32',
        licenseSpdx: 'Apache-2.0',
        supportedLanguages: ['fa'],
        // Sherpa exposes CTC token onsets for this export, but not token durations or frame log-probs.
        // Do not advertise true word spans until a real Persian forced-aligner is integrated.
        supportsNativeWordTimestamps: false,
        rootDir: dir,
        diskSizeBytes: fileSizeSafe(koochikModel) + fileSizeSafe(koochikTokens),
        requiredFiles: files,
        integrityVerified: true,
        extraCliArgs: [
          '--model-type=nemo_ctc',
          `--nemo-ctc-model=${koochikModel}`,
          `--tokens=${koochikTokens}`,
        ],
      });
    }

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
        // Sherpa NeMo CTC exposes token onset timestamps but no token durations for this path.
        // Word-level endpoints remain unavailable until a real forced aligner is connected.
        supportsNativeWordTimestamps: false,
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
export function buildWordTimingsFromTokens(
  tokens: readonly string[] | undefined,
  timestamps: readonly number[] | undefined,
  durations: readonly number[] | undefined,
  chunkOffsetSec: number,
  chunkEndSec: number,
): LocalNeuralWordTiming[] {
  if (
    !Array.isArray(tokens) ||
    !Array.isArray(timestamps) ||
    !Array.isArray(durations) ||
    tokens.length === 0 ||
    tokens.length !== timestamps.length ||
    tokens.length !== durations.length ||
    !Number.isFinite(chunkOffsetSec) ||
    !Number.isFinite(chunkEndSec) ||
    chunkEndSec <= chunkOffsetSec
  ) {
    return [];
  }

  const words: LocalNeuralWordTiming[] = [];
  let currentWord = '';
  let currentStart = -1;
  let currentEnd = -1;

  const flushCurrentWord = () => {
    if (!currentWord || currentStart < 0 || currentEnd <= currentStart) return;
    const startSec = Math.max(chunkOffsetSec, Math.min(chunkEndSec, currentStart));
    const endSec = Math.max(startSec, Math.min(chunkEndSec, currentEnd));
    if (endSec > startSec) {
      words.push({
        word: currentWord,
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
      });
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const rawToken = tokens[i];
    const timestamp = Number(timestamps[i]);
    const duration = Number(durations[i]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || timestamp < 0 || duration <= 0) {
      // If even one emitted piece has no valid acoustic span, do not publish a misleading
      // word timeline for this chunk. Segment timestamps remain available as the fallback.
      return [];
    }

    const tokenStart = chunkOffsetSec + timestamp;
    const tokenEnd = tokenStart + duration;
    if (
      !Number.isFinite(tokenStart) ||
      !Number.isFinite(tokenEnd) ||
      tokenStart >= chunkEndSec ||
      tokenEnd <= chunkOffsetSec
    ) {
      return [];
    }

    const startsNewWord = rawToken.startsWith(' ') || rawToken.startsWith('▁');
    const cleanPiece = rawToken.replace(/^[\s▁]+/, '');
    if (!cleanPiece) continue;

    if (startsNewWord && currentWord.length > 0) {
      flushCurrentWord();
      currentWord = cleanPiece;
      currentStart = tokenStart;
      currentEnd = tokenEnd;
    } else {
      if (currentWord.length === 0) {
        currentStart = tokenStart;
        currentEnd = tokenEnd;
      } else {
        currentStart = Math.min(currentStart, tokenStart);
        currentEnd = Math.max(currentEnd, tokenEnd);
      }
      currentWord += cleanPiece;
    }
  }

  flushCurrentWord();

  // Guard against malformed decoder output that would move backwards in the source timeline.
  for (let i = 1; i < words.length; i++) {
    if (words[i].startSec < words[i - 1].startSec || words[i].endSec <= words[i].startSec) {
      return [];
    }
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

function resolvePersistentSherpaPythonWorker(model: InstalledLocalNeuralModel): {
  readonly pythonPath: string;
  readonly workerScriptPath: string;
  readonly modelPath: string;
  readonly tokensPath: string;
} | null {
  if (model.architecture !== 'nemo-ctc') return null;

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const workerCandidates = [
    process.env.AVAPARDAZ_SHERPA_WORKER,
    path.join(moduleDirectory, 'shahab_sherpa_worker.py'),
    path.resolve(moduleDirectory, '../../companion/shahab_sherpa_worker.py'),
    path.resolve(process.cwd(), 'companion/shahab_sherpa_worker.py'),
  ].filter((value): value is string => Boolean(value && value.trim()));
  const workerScriptPath = workerCandidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });

  const pythonName = process.platform === 'win32' ? 'python.exe' : 'python';
  const configuredPython = process.env.AVAPARDAZ_SHERPA_PYTHON?.trim();
  const pythonCandidates = configuredPython
    ? [configuredPython]
    : [
        path.join(os.homedir(), '.avapardaz', 'runtime', 'sherpa-venv', process.platform === 'win32' ? 'Scripts' : 'bin', pythonName),
        path.join(AVAPARDAZ_HOME, 'runtime', 'sherpa-venv', process.platform === 'win32' ? 'Scripts' : 'bin', pythonName),
      ];
  const pythonPath = pythonCandidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });

  const modelPath = model.requiredFiles.find((file) => /\.onnx$/i.test(file));
  const tokensPath = model.requiredFiles.find((file) => /tokens\.txt$/i.test(file));
  if (!workerScriptPath || !pythonPath || !modelPath || !tokensPath) return null;

  return {
    pythonPath,
    workerScriptPath,
    modelPath: path.isAbsolute(modelPath) ? modelPath : path.join(model.rootDir, modelPath),
    tokensPath: path.isAbsolute(tokensPath) ? tokensPath : path.join(model.rootDir, tokensPath),
  };
}

async function startPersistentSherpaPythonWorker(params: {
  readonly model: InstalledLocalNeuralModel;
  readonly numThreads: number;
  readonly signal?: AbortSignal;
  readonly memoryTracker?: NativeIngestionMemoryTracker;
  readonly readChildRssBytes: (pid: number | undefined) => number;
}): Promise<PersistentSherpaPythonWorkerSession | null> {
  const resolved = resolvePersistentSherpaPythonWorker(params.model);
  if (!resolved) return null;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };

  const child = spawn(resolved.pythonPath, [
    resolved.workerScriptPath,
    '--model', resolved.modelPath,
    '--tokens', resolved.tokensPath,
    '--num-threads', String(params.numThreads),
    '--provider', 'cpu',
  ], {
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lineIterator = lineReader[Symbol.asyncIterator]();
  let stderrTail = '';
  let sequence = 0;
  let closed = false;
  let busy = false;
  let killedByAbort = false;

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-64 * 1024);
  });

  const onAbort = () => {
    killedByAbort = true;
    try { child.kill('SIGKILL'); } catch { /* best effort */ }
  };
  if (params.signal) {
    if (params.signal.aborted) onAbort();
    else params.signal.addEventListener('abort', onAbort, { once: true });
  }

  const readJsonLine = async (): Promise<Record<string, unknown>> => {
    const next = await lineIterator.next();
    if (next.done) {
      if (killedByAbort || params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
      throw new Error(`SHAHAB_PYTHON_WORKER_EXITED: ${stderrTail.split('\n').slice(-6).join(' | ')}`);
    }
    try {
      return JSON.parse(next.value) as Record<string, unknown>;
    } catch {
      throw new Error(`SHAHAB_PYTHON_WORKER_PROTOCOL_ERROR: ${String(next.value).slice(0, 240)}`);
    }
  };

  params.memoryTracker?.recordChildProcessRss(params.readChildRssBytes(child.pid));
  const rssTimer = params.memoryTracker
    ? setInterval(() => params.memoryTracker?.recordChildProcessRss(params.readChildRssBytes(child.pid)), 1_000)
    : null;
  rssTimer?.unref?.();

  const close = async () => {
    if (closed) return;
    closed = true;
    if (rssTimer) clearInterval(rssTimer);
    params.memoryTracker?.recordChildProcessRss(params.readChildRssBytes(child.pid));
    params.signal?.removeEventListener('abort', onAbort);
    try {
      if (child.exitCode === null && child.signalCode === null && !killedByAbort) {
        child.stdin.write(`${JSON.stringify({ type: 'shutdown', requestId: 'shutdown' })}\n`);
        child.stdin.end();
      }
    } catch { /* child may already be gone */ }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          resolve();
        }, 1500);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    lineReader.close();
  };

  try {
    if (params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
    let readyTimeout: NodeJS.Timeout | undefined;
    const ready = await Promise.race([
      readJsonLine(),
      new Promise<never>((_, reject) => {
        readyTimeout = setTimeout(() => reject(new Error('SHAHAB_PYTHON_WORKER_START_TIMEOUT')), 90_000);
      }),
    ]).finally(() => {
      if (readyTimeout) clearTimeout(readyTimeout);
    });
    if (ready.type !== 'ready' || ready.ok !== true) {
      throw new Error(`SHAHAB_PYTHON_WORKER_START_FAILED: ${String(ready.error ?? 'Invalid worker readiness response')}`);
    }
  } catch (error) {
    await close();
    throw error;
  }

  return {
    pid: child.pid,
    transcribe: async (wavPath: string): Promise<SherpaJsonOutput> => {
      if (closed) throw new Error('SHAHAB_PYTHON_WORKER_CLOSED');
      if (busy) throw new Error('SHAHAB_PYTHON_WORKER_CONCURRENT_REQUEST_REJECTED');
      if (params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
      busy = true;
      const requestId = `shb_${++sequence}`;
      try {
        const payload = `${JSON.stringify({ type: 'transcribe', requestId, wavPath })}\n`;
        if (!child.stdin.write(payload)) {
          await new Promise<void>((resolve, reject) => {
            child.stdin.once('drain', resolve);
            child.stdin.once('error', reject);
          });
        }
        const response = await readJsonLine();
        if (response.type !== 'result' || response.requestId !== requestId) {
          throw new Error('SHAHAB_PYTHON_WORKER_RESPONSE_MISMATCH');
        }
        if (response.ok !== true) {
          throw new Error(`SHAHAB_PYTHON_INFERENCE_FAILED: ${String(response.error ?? 'Unknown inference error')}`);
        }
        return {
          lang: typeof response.lang === 'string' ? response.lang : undefined,
          text: typeof response.text === 'string' ? response.text : '',
          tokens: Array.isArray(response.tokens) ? response.tokens.map(String) : [],
          timestamps: Array.isArray(response.timestamps) ? response.timestamps.map(Number) : [],
          durations: Array.isArray(response.durations) ? response.durations.map(Number) : [],
          ysLogProbs: Array.isArray(response.ysLogProbs) ? response.ysLogProbs.map(Number) : [],
        };
      } finally {
        busy = false;
      }
    },
    close,
  };
}

export class LocalSherpaNeuralEngine {
  private readonly modelSearchDirs: readonly string[];
  private activeModelId: string | null = null;
  private cachedModels: InstalledLocalNeuralModel[] = [];
  private readonly defaultCpuThreads: number;
  private ensureShenavaArtifactsPromise: Promise<EnsuredShenavaModelArtifacts> | null = null;
  private installShenavaRuntimePromise: Promise<LocalNeuralRuntimeStatus> | null = null;

  constructor(options?: {
    readonly modelSearchDirs?: readonly string[];
    readonly cpuThreads?: number;
    readonly canonicalStagingDir?: string;
  }) {
    this.modelSearchDirs = options?.modelSearchDirs ?? DEFAULT_MODEL_SEARCH_DIRS;
    const cpuCount = os.cpus()?.length || 4;
    this.defaultCpuThreads = Math.max(1, Math.min(8, options?.cpuThreads ?? Math.min(4, cpuCount)));
    try {
      cleanupOrphanedCanonicalIngestionFiles(options?.canonicalStagingDir);
    } catch {
      // ignore startup cleanup failure on non-existent dir
    }
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
    const isLegacyLinuxX64 = process.platform === 'linux' && process.arch === 'x64';
    const target = isLegacyLinuxX64 ? null : resolveAvapardazReleaseTarget();
    const runtimeArchiveName = target?.runtimeArchive.fileName ?? SHENAVA_RIZEH_RUNTIME_RELEASE.runtimeArchiveName;
    const runtimeUrl = target?.runtimeArchive.url ?? SHENAVA_RIZEH_RUNTIME_RELEASE.runtimeUrl;
    const runtimeDir = target
      ? path.join(os.homedir(), '.avapardaz', 'runtime', 'targets', target.id)
      : path.join(os.homedir(), '.avapardaz', 'runtime');

    if (this.installShenavaRuntimePromise) {
      return this.installShenavaRuntimePromise;
    }

    const task = (async (): Promise<LocalNeuralRuntimeStatus> => {
      const baseDir = path.join(os.homedir(), '.avapardaz');
      const downloadsDir = path.join(baseDir, 'downloads');
      fs.mkdirSync(downloadsDir, { recursive: true });
      fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });

      const { binaryPath, libDir } = detectSherpaBinary();
      if (!binaryPath || (target !== null && !libDir)) {
        const rtArchive = path.join(downloadsDir, Date.now() + '_' + process.pid + '_' + runtimeArchiveName);
        const rtTempExtract = fs.mkdtempSync(path.join(downloadsDir, 'avp-rt-stage-'));
        try {
          const expectedBytes = target?.runtimeArchive.bytes;
          const expectedSha256 = target?.runtimeArchive.sha256;
          await downloadFileWithRedirects(runtimeUrl, rtArchive, {
            allowedHosts: ALLOWED_MODEL_DOWNLOAD_HOSTS,
            maxRedirects: 5,
            maxBytes: expectedBytes ?? 250 * 1024 * 1024,
            ...(expectedBytes && expectedSha256 ? { expectedBytes, expectedSha256Hex: expectedSha256 } : {}),
            connectTimeoutMs: 15_000,
            totalTimeoutMs: 240_000,
            signal: options?.signal,
          });
          await extractTarBz2Safe(rtArchive, rtTempExtract, {
            maxFiles: 4096,
            maxSingleFileBytes: 300 * 1024 * 1024,
            maxTotalBytes: 600 * 1024 * 1024,
            allowExecutablesInBin: true,
            allowRelativeLibrarySymlinks: target !== null,
            pythonBin: process.platform === 'win32' ? 'python' : 'python3',
          });
          const extractedRoot = fs
            .readdirSync(rtTempExtract, { withFileTypes: true })
            .find((entry) => entry.isDirectory())?.name;
          const srcRoot = extractedRoot ? path.join(rtTempExtract, extractedRoot) : rtTempExtract;

          await activateDirectoryAtomically({
            stagedDir: srcRoot,
            targetDir: runtimeDir,
            validateStaged: (dir) => {
              const stagedBinName = target?.sherpaBinaryName ?? 'sherpa-onnx-offline';
              const stagedBin = path.join(dir, 'bin', stagedBinName);
              if (!fs.existsSync(stagedBin) || fs.lstatSync(stagedBin).isSymbolicLink()) return false;
              if (target) {
                const collectFiles = (root: string): string[] => {
                  const files: string[] = [];
                  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                    const fullPath = path.join(root, entry.name);
                    if (entry.isSymbolicLink()) return [];
                    if (entry.isDirectory()) files.push(...collectFiles(fullPath));
                    else if (entry.isFile()) files.push(fullPath);
                  }
                  return files;
                };
                const nativeLibraries = collectFiles(dir)
                  .filter((file) => isSherpaRuntimeLibraryName(path.basename(file), target.platform));
                const onnxRuntimeLibrary = nativeLibraries.find(
                  (file) => path.basename(file) === target.onnxRuntimeLibraryName,
                ) ?? (target.platform === 'darwin'
                  ? nativeLibraries.find((file) => /^libonnxruntime\.\d+(?:\.\d+)*\.dylib$/.test(path.basename(file)))
                  : undefined);
                if (!onnxRuntimeLibrary || nativeLibraries.length === 0) return false;
                try {
                  assertNativeBinaryArchitecture({ filePath: stagedBin, platform: target.platform, arch: target.arch });
                  for (const library of nativeLibraries) {
                    assertNativeBinaryArchitecture({ filePath: library, platform: target.platform, arch: target.arch });
                  }
                } catch {
                  return false;
                }
                if (target.platform !== 'win32') fs.chmodSync(stagedBin, 0o755);
                const libraryDir = path.dirname(onnxRuntimeLibrary);
                const env: NodeJS.ProcessEnv = {
                  ...process.env,
                  [sherpaLibraryPathEnvironmentVariable(target.platform)]: [libraryDir, process.env[sherpaLibraryPathEnvironmentVariable(target.platform)]].filter(Boolean).join(path.delimiter),
                };
                const smoke = spawnSync(stagedBin, ['--help'], {
                  env,
                  encoding: 'utf8',
                  timeout: 30_000,
                  maxBuffer: 8 * 1024 * 1024,
                  windowsHide: true,
                });
                return !smoke.error && smoke.status === 0;
              }
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
    // - Pure Persian ('fa'): Koochik FP32 quality baseline -> Rizeh INT8 lightweight fallback.
    // - English / bilingual / auto: only select a model whose manifest explicitly supports that language.
    if (languageHint === 'fa') {
      return (
        verifiedModels.find((m) => m.modelId === 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx') ??
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

  private readChildProcessRssBytes(pid: number | undefined): number {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return 0;
    if (process.platform === 'linux') {
      try {
        const fd = fs.openSync(`/proc/${pid}/status`, 'r');
        try {
          const buf = Buffer.allocUnsafe(2048);
          const n = fs.readSync(fd, buf, 0, buf.byteLength, 0);
          const match = buf.subarray(0, n).toString('utf8').match(/VmRSS:\s+(\d+)\s+kB/i);
          return match ? Number(match[1]) * 1024 : 0;
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return 0;
      }
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 750,
        windowsHide: true,
      });
      if (result.status !== 0 || result.error) return 0;
      const kilobytes = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : 0;
    }
    if (process.platform === 'win32') {
      const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 1000,
        windowsHide: true,
      });
      if (result.status !== 0 || result.error) return 0;
      const match = result.stdout.match(/\"([\d,]+) K\"/);
      return match ? Number(match[1].replace(/,/g, '')) * 1024 : 0;
    }
    return 0;
  }

  private async runSherpaSingleWav(params: {
    readonly binaryPath: string;
    readonly libDir: string | null;
    readonly model: InstalledLocalNeuralModel;
    readonly wavPath: string;
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly numThreads: number;
    readonly signal?: AbortSignal;
    readonly memoryTracker?: import('./StreamingCanonicalAudioIngestion').NativeIngestionMemoryTracker;
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

      const sampleChildRss = () => {
        if (!params.memoryTracker || !child.pid) return;
        const childRss = this.readChildProcessRssBytes(child.pid);
        if (childRss > 0) {
          params.memoryTracker.recordChildProcessRss(childRss);
        }
        params.memoryTracker.sampleProcessRss();
      };
      sampleChildRss();
      const rssTimer = setInterval(sampleChildRss, 20);

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
        sampleChildRss();
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        sampleChildRss();
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearInterval(rssTimer);
        params.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        clearInterval(rssTimer);
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

  /**
   * Processes all already-bounded WAV chunks in one Sherpa CLI session. The native
   * recognizer loads its model once, then decodes every supplied path and emits one
   * JSON record per input. This is the no-Python packaged fallback for long recordings.
   */
  private async runSherpaBatchWavs(params: {
    readonly binaryPath: string;
    readonly libDir: string | null;
    readonly model: InstalledLocalNeuralModel;
    readonly wavPaths: readonly string[];
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly numThreads: number;
    readonly signal?: AbortSignal;
    readonly memoryTracker?: NativeIngestionMemoryTracker;
  }): Promise<SherpaJsonOutput[]> {
    if (params.wavPaths.length === 0) return [];
    if (params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');

    const args = [...params.model.extraCliArgs];
    if (params.model.architecture === 'nemo-ctc' && !args.some((arg) => arg.startsWith('--model-type='))) {
      args.push('--model-type=nemo_ctc');
    }
    if (params.model.architecture === 'whisper') {
      args.push('--model-type=whisper');
      if (params.languageHint === 'fa' || params.languageHint === 'en') {
        args.push(`--whisper-language=${params.languageHint}`);
      }
    }
    args.push(`--num-threads=${params.numThreads}`, '--debug=false', '--print-args=false', ...params.wavPaths);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      http_proxy: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    };
    if (params.libDir) {
      const libraryPathName = sherpaLibraryPathEnvironmentVariable();
      env[libraryPathName] = `${params.libDir}${path.delimiter}${env[libraryPathName] ?? ''}`;
    }

    return await new Promise<SherpaJsonOutput[]>((resolve, reject) => {
      const child = spawn(params.binaryPath, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrTail = '';
      let settled = false;
      let killedByAbort = false;

      const sampleRss = () => {
        if (!child.pid || !params.memoryTracker) return;
        params.memoryTracker.recordChildProcessRss(this.readChildProcessRssBytes(child.pid));
        params.memoryTracker.sampleProcessRss();
      };
      sampleRss();
      const rssTimer = setInterval(sampleRss, 1_000);
      rssTimer.unref?.();

      const cleanup = () => {
        clearInterval(rssTimer);
        params.signal?.removeEventListener('abort', onAbort);
        sampleRss();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        killedByAbort = true;
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
      };
      if (params.signal) {
        if (params.signal.aborted) onAbort();
        else params.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (chunk: Buffer) => {
        sampleRss();
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 32 * 1024 * 1024) {
          fail(new Error('SHAHAB_BATCH_OUTPUT_LIMIT_EXCEEDED'));
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        sampleRss();
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-64 * 1024);
      });
      child.on('error', (error) => fail(error));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (killedByAbort || params.signal?.aborted) {
          reject(new Error('TRANSCRIPTION_CANCELLED'));
          return;
        }
        if (code !== 0) {
          reject(new Error(`SHERPA_BATCH_EXIT_${code}: ${stderrTail.split('\n').slice(-8).join(' | ')}`));
          return;
        }

        const output = Buffer.concat(stdout).toString('utf8');
        const parsed: SherpaJsonOutput[] = [];
        for (const rawLine of output.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line.startsWith('{') || !line.endsWith('}')) continue;
          try {
            const item = JSON.parse(line) as Record<string, unknown>;
            if (typeof item.text !== 'string' && !Array.isArray(item.tokens)) continue;
            parsed.push({
              lang: typeof item.lang === 'string' ? item.lang : undefined,
              text: typeof item.text === 'string' ? item.text : '',
              tokens: Array.isArray(item.tokens) ? item.tokens.map(String) : [],
              timestamps: Array.isArray(item.timestamps) ? item.timestamps.map(Number) : [],
              durations: Array.isArray(item.durations) ? item.durations.map(Number) : [],
              ysLogProbs: Array.isArray(item.ys_log_probs)
                ? item.ys_log_probs.map(Number)
                : Array.isArray(item.ysLogProbs)
                  ? item.ysLogProbs.map(Number)
                  : [],
            });
          } catch {
            // Sherpa emits informational lines around its JSON result records.
          }
        }
        if (parsed.length !== params.wavPaths.length) {
          reject(new Error(
            `SHERPA_BATCH_RESULT_COUNT_MISMATCH: expected ${params.wavPaths.length}, received ${parsed.length}. stdout=${output.slice(-2048)}`,
          ));
          return;
        }
        resolve(parsed);
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

    const hasAudioBytes = Boolean(request.audioBytes && request.audioBytes.byteLength > 0);
    const hasAudioFilePath = Boolean(
      typeof request.audioFilePath === 'string' && request.audioFilePath.trim().length > 0,
    );
    if (!hasAudioBytes && !hasAudioFilePath) {
      throw new Error('INVALID_AUDIO_INPUT: Either audioBytes or audioFilePath is required.');
    }

    const memoryTracker =
      request.memoryTracker ?? new NativeIngestionMemoryTracker();
    memoryTracker.setModelRuntimeBytes(model.diskSizeBytes);

    // Phase 1C-A: File-backed streaming canonical ingestion (zero full-file fs.readFileSync or full-file Float32Array)
    const canonicalSource = await createStreamingCanonicalAudioSource({
      audioFilePath: hasAudioFilePath ? request.audioFilePath : undefined,
      audioBytes: hasAudioBytes ? request.audioBytes : undefined,
      filename: request.filename ?? (request.audioFilePath ? path.basename(request.audioFilePath) : 'audio.wav'),
      stagingRootDir: request.canonicalStagingDir,
      signal: request.signal,
      memoryTracker,
      onLifecycleState: request.onIngestionLifecycleState,
    });

    const sampleRate = CANONICAL_TARGET_SAMPLE_RATE_HZ;
    const totalSamples = canonicalSource.canonicalExactSampleCount;
    const durationSec = canonicalSource.canonicalDurationSec;
    const audioSha256 = canonicalSource.sourceSha256;

    const maxChunkSec = Math.max(5, Math.min(30, request.maxChunkDurationSec ?? 25));
    const overlapSec = Math.max(0, Math.min(3, request.overlapSec ?? 1.5));
    const maxChunkSamples = Math.round(maxChunkSec * sampleRate);
    const overlapSamples = Math.round(overlapSec * sampleRate);

    let finalIngestionState: 'COMPLETED' | 'FAILED' | 'CANCELLED' = 'COMPLETED';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-asr-'));
    const numThreads = Math.max(1, Math.min(8, request.numThreads ?? this.defaultCpuThreads));
    const segments: LocalNeuralSegment[] = [];
    let hasAnyWordTimestamps = false;

    try {
      // Energy-valley VAD boundary planning directly on the canonical disk file
      // (reads only the ±1.5s neighborhood around each nominal boundary — ~96 KiB)
      const ranges: Array<{ startSample: number; endSample: number }> = [];
      if (totalSamples <= maxChunkSamples) {
        ranges.push({ startSample: 0, endSample: totalSamples });
      } else {
        let cursor = 0;
        while (cursor < totalSamples) {
          if (request.signal?.aborted) {
            throw new Error('TRANSCRIPTION_CANCELLED');
          }
          const nominalEnd = Math.min(totalSamples, cursor + maxChunkSamples);
          const endSample =
            nominalEnd >= totalSamples - sampleRate
              ? totalSamples
              : await canonicalSource.findBestBoundaryValleySampleOnDisk(
                  nominalEnd,
                  Math.round(sampleRate * 1.5),
                  request.signal,
                );
          ranges.push({ startSample: cursor, endSample });
          if (endSample >= totalSamples) break;
          cursor = Math.max(cursor + sampleRate, endSample - overlapSamples);
        }
      }

      canonicalSource.markInferenceStarted();

      // Prefer one persistent Sherpa Python recognizer for all CTC chunks when the
      // official local Python binding is installed. Packaged installs without it
      // retain the native CLI path; inference remains CPU-only and offline either way.
      let persistentWorker: PersistentSherpaPythonWorkerSession | null = null;
      if (model.architecture === 'nemo-ctc') {
        persistentWorker = await startPersistentSherpaPythonWorker({
          model,
          numThreads,
          signal: request.signal,
          memoryTracker,
          readChildRssBytes: (pid) => this.readChildProcessRssBytes(pid),
        });
      }

      const appendDecodedChunk = (index: number, out: SherpaJsonOutput) => {
        const range = ranges[index];
        const chunkStartSec = Number((range.startSample / sampleRate).toFixed(3));
        const chunkEndSec = Number((range.endSample / sampleRate).toFixed(3));
        const segText = String(out.text ?? '').trim();
        const words = buildWordTimingsFromTokens(out.tokens, out.timestamps, out.durations, chunkStartSec, chunkEndSec);
        if (words.length > 0) hasAnyWordTimestamps = true;

        const langTag: DetectedLanguageTag =
          out.lang === 'fa' || out.lang === 'en'
            ? out.lang
            : detectTextLanguageTag(segText).language;

        segments.push({
          id: `seg_${index}`,
          index,
          startSec: chunkStartSec,
          endSec: chunkEndSec,
          text: segText,
          normalizedByProfile: buildAllNormalizationProfiles(segText),
          language: langTag,
          timestampGranularity: words.length > 0 ? 'WORD' : 'SEGMENT',
          words,
        });
        const pct = Math.min(100, Math.round(((index + 1) / ranges.length) * 100));
        request.onProgress?.({
          percent: pct,
          currentChunk: index + 1,
          totalChunks: ranges.length,
          elapsedMs: Math.round(performance.now() - t0),
          partialText: segments.map((segment) => segment.text).filter(Boolean).join(' ').trim(),
        });
      };

      try {
        if (persistentWorker) {
          // Python binding keeps the recognizer and model resident while each WAV is
          // decoded and released before the next chunk, bounding working audio memory.
          for (let i = 0; i < ranges.length; i++) {
            if (request.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
            const range = ranges[i];
            const chunkWavPath = path.join(tempDir, `chunk_${i}.wav`);
            await canonicalSource.exportCanonicalChunkWavToFile(
              range.startSample,
              range.endSample,
              chunkWavPath,
              request.signal,
            );
            try {
              const out = await persistentWorker.transcribe(chunkWavPath);
              appendDecodedChunk(i, out);
            } finally {
              try { fs.unlinkSync(chunkWavPath); } catch { /* best effort cleanup */ }
            }
          }
        } else {
          // Native CLI fallback: its batch mode also loads the model exactly once.
          // Chunk WAVs are file-backed; no full-recording PCM is materialized in Node.
          const chunkWavPaths: string[] = [];
          for (let i = 0; i < ranges.length; i++) {
            if (request.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
            const chunkWavPath = path.join(tempDir, `chunk_${i}.wav`);
            const range = ranges[i];
            await canonicalSource.exportCanonicalChunkWavToFile(
              range.startSample,
              range.endSample,
              chunkWavPath,
              request.signal,
            );
            chunkWavPaths.push(chunkWavPath);
          }
          const batchResults = await this.runSherpaBatchWavs({
            binaryPath,
            libDir,
            model,
            wavPaths: chunkWavPaths,
            languageHint,
            numThreads,
            signal: request.signal,
            memoryTracker,
          });
          for (let i = 0; i < batchResults.length; i++) {
            if (request.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
            appendDecodedChunk(i, batchResults[i]);
          }
        }
      } finally {
        await persistentWorker?.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finalIngestionState =
        request.signal?.aborted || msg === 'TRANSCRIPTION_CANCELLED' ? 'CANCELLED' : 'FAILED';
      throw err;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      await canonicalSource.close(finalIngestionState).catch(() => {});
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
      sampleRateHz: canonicalSource.sourceSampleRateHz,
      channelCount: canonicalSource.sourceChannels,
      audioSha256,
      ingestionMemory: memoryTracker.getSnapshot(),
    };
  }
}
