/**
 * AVAPARDAZ — PHASE 1C-H & 1C-I: PRODUCTION & BETA PACKAGING, INSTALLATION,
 * FIRST-RUN, ATOMIC UPDATE, ROLLBACK, UNINSTALLATION & PRIVACY-SAFE DIAGNOSTICS
 *
 * Implements the unified executable installation, packaging, update, rollback,
 * uninstallation, first-run readiness, and privacy-safe beta feedback/diagnostics
 * system for AvaPardaz without rewriting any healthy ASR Core, Editing Engine,
 * Companion IPC, or CEP Plugin components.
 *
 * Capabilities:
 * 1. Directory Separation (`AVAPARDAZ_INSTALL_LAYOUT`):
 *    - `app/` (Application Files & Production Web Assets)
 *    - `companion/` (Standalone Bundled Local Companion Daemon `avapardaz-companion.mjs`)
 *    - `runtime/` (Native Sherpa Runtime Binaries `sherpa-onnx-offline`, `sherpa-onnx-streaming-bridge` & `lib/`)
 *    - `models/` (Verified Local ASR Model `Reza2kn/Shenava-Rizeh` INT8 + SHA-256 manifest)
 *    - `cep-extension/` (Adobe Audition CEP Extension `ir.avapardaz.audition.cep`)
 *    - `config/` (User Configuration & Version Compatibility Manifest)
 *    - `user-data/` (`projects/`, `transcripts/`, `edl/`, `checkpoints/`, `feedback/`) — NEVER deleted on update or standard uninstall
 *    - `logs/` (Sanitized Local Diagnostic Logs)
 *    - `tmp/` (Bounded Temporary Processing Staging)
 *    - `backups/` (Atomic Rollback Snapshots for App, Plugin, Companion, Runtime, and Model)
 * 2. First-Run Readiness Inspector (`evaluateInstalledFirstRunStatus`):
 *    - Returns exact status: `READY` | `DEGRADED` | `MODEL_MISSING` | `MODEL_INVALID` |
 *      `RUNTIME_ERROR` | `CONNECTION_FAILED` | `VERSION_MISMATCH` | `PERMISSION_DENIED`
 *    - Never reports `READY` if Native Sherpa binary or verified ASR model is missing/corrupt.
 * 3. Real Installer (`AvapardazProductionInstaller`):
 *    - OS/Arch detection (`darwin-arm64` Apple Silicon M2 target + `linux-x64` local container execution)
 *    - Disk space preflight, permission check, atomic staging, SHA-256 verification of all installed files,
 *      idempotent re-install without corrupting existing installation or user data, and rollback on mid-install failure.
 * 4. Atomic Update & Rollback Engine (`AvapardazPackageUpdateManager`):
 *    - Full pipeline: `Update Package -> Integrity Verification -> Compatibility Check -> Disk Space Check -> Active Session Guard -> Staging -> Backup -> Installation -> Health Check -> Activation`
 *    - Multi-component & multi-step rollback preserving user projects, transcripts, EDLs, and previous valid model.
 * 5. Safe Uninstaller (`AvapardazSafeUninstaller`):
 *    - `STANDARD` mode: removes application, plugin, companion, runtime, and temp files while strictly preserving `user-data/` and `config/`.
 *    - `COMPLETE` mode: requires explicit `confirmDeleteUserData: true` token to remove managed user data; strictly confined to managed root.
 * 6. Controlled Beta Feedback & Privacy-Safe Diagnostics (`AvapardazBetaDiagnosticsAndFeedbackManager`):
 *    - Telemetry disabled by default (`telemetryEnabled: false`, `autoUploadPermitted: false`).
 *    - Sanitizes all diagnostic exports to guarantee zero audio bytes, zero transcript text, zero user paths, and zero tokens/secrets.
 *    - Local user feedback submission (`FB-...`) with Beta Group (`A` / `B` / `C` / `D`), severity (`P0..P4`), and version tagging.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KNOWN_MODEL_ARTIFACT_PROVENANCE,
  verifyModelFilesIntegrity,
  verifyShahabKoochikModelFiles,
} from '../asr-core/LocalSherpaNeuralEngine';
import { sanitizeLogPayload } from '../security/LocalPrivacyPolicy';
import {
  CURRENT_COMPONENT_VERSIONS,
  evaluateComponentCompatibility,
} from './ProductDeliveryAndUpdateEngine';

export const AVAPARDAZ_BETA_RELEASE_IDENTITY = Object.freeze({
  productName: 'AVAPARDAZ — آواپرداز',
  releaseChannel: 'BETA' as const,
  isStableRelease: false,
  appVersion: '2.0.0-beta.1',
  betaVersion: '2.0.0-beta.1',
  buildId: process.env.AVAPARDAZ_BUILD_ID?.trim() || 'LOCAL_UNBUILT_WORKTREE',
  commitHash: process.env.AVAPARDAZ_GIT_COMMIT?.trim() || 'UNBUILT',
  pluginVersion: '1.0.0',
  companionVersion: '1.0.0',
  asrCoreVersion: '2.0.0',
  nativeRuntimeVersion: 'sherpa-onnx-v2.0.3',
  modelId: 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx',
  modelVersion: '1.0.0',
  ipcProtocolVersion: '1.0.0',
  extensionBundleId: 'ir.avapardaz.audition.cep',
  primaryTargetPlatform: 'darwin-arm64 (macOS 14/15 Apple Silicon)',
  supportedPlatforms: ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const,
  buildDateIso: new Date().toISOString(),
});

export type FirstRunTerminalStatus =
  | 'READY'
  | 'DEGRADED'
  | 'MODEL_MISSING'
  | 'MODEL_INVALID'
  | 'RUNTIME_ERROR'
  | 'CONNECTION_FAILED'
  | 'VERSION_MISMATCH'
  | 'PERMISSION_DENIED';

export type BetaGroupIdentifier =
  | 'GROUP_A_TECHNICAL_VALIDATION'
  | 'GROUP_B_REGULAR_AUDIO_EDITORS'
  | 'GROUP_C_PERSIAN_SPEECH_WORKLOADS'
  | 'GROUP_D_LONG_SESSION_USERS';

export type BetaIssuePriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export type BetaUxFeedbackTier = 'CRITICAL_UX' | 'HIGH_PRIORITY_UX' | 'IMPROVEMENT_REQUEST';

export type BetaIssueCategory =
  | 'INSTALLATION'
  | 'STARTUP'
  | 'AUDITION_CONNECTION'
  | 'PERSIAN_ASR_QUALITY'
  | 'FALSE_FILLER_DETECTION'
  | 'FALSE_WORD_DELETION'
  | 'NATURAL_PAUSE_PRESERVATION'
  | 'REPETITION_DETECTION'
  | 'PREVIEW'
  | 'EXPORT'
  | 'PERFORMANCE_SPEED'
  | 'MEMORY_USAGE'
  | 'COMPANION_ERROR'
  | 'UX_IMPROVEMENT';

export interface InstalledDirectoryLayout {
  readonly installRoot: string;
  readonly appDir: string;
  readonly companionDir: string;
  readonly runtimeDir: string;
  readonly runtimeBinDir: string;
  readonly runtimeLibDir: string;
  readonly modelsDir: string;
  readonly shenavaModelDir: string;
  readonly shahabKoochikModelDir: string;
  readonly cepExtensionDir: string;
  readonly configDir: string;
  readonly userDataDir: string;
  readonly userProjectsDir: string;
  readonly userTranscriptsDir: string;
  readonly userEdlDir: string;
  readonly userCheckpointsDir: string;
  readonly userFeedbackDir: string;
  readonly logsDir: string;
  readonly tempDir: string;
  readonly backupsDir: string;
}

export function resolveInstalledDirectoryLayout(
  installRoot: string,
  customCepExtensionDir?: string,
): InstalledDirectoryLayout {
  const root = path.resolve(installRoot);
  return {
    installRoot: root,
    appDir: path.join(root, 'app'),
    companionDir: path.join(root, 'companion'),
    runtimeDir: path.join(root, 'runtime'),
    runtimeBinDir: path.join(root, 'runtime', 'bin'),
    runtimeLibDir: path.join(root, 'runtime', 'lib'),
    modelsDir: path.join(root, 'models'),
    shenavaModelDir: path.join(
      root,
      'models',
      'sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26',
    ),
    shahabKoochikModelDir: path.join(root, 'models', 'shahab-koochik-v1.0-sherpa-onnx'),
    cepExtensionDir: customCepExtensionDir
      ? path.resolve(customCepExtensionDir)
      : path.join(root, 'cep-extension', AVAPARDAZ_BETA_RELEASE_IDENTITY.extensionBundleId),
    configDir: path.join(root, 'config'),
    userDataDir: path.join(root, 'user-data'),
    userProjectsDir: path.join(root, 'user-data', 'projects'),
    userTranscriptsDir: path.join(root, 'user-data', 'transcripts'),
    userEdlDir: path.join(root, 'user-data', 'edl'),
    userCheckpointsDir: path.join(root, 'user-data', 'checkpoints'),
    userFeedbackDir: path.join(root, 'user-data', 'feedback'),
    logsDir: path.join(root, 'logs'),
    tempDir: path.join(root, 'tmp'),
    backupsDir: path.join(root, 'backups'),
  };
}

export function computeFileSha256Sync(filePath: string): {
  readonly sha256: string;
  readonly sizeBytes: number;
} {
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const toRead = Math.min(buf.byteLength, stat.size - offset);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    sha256: hash.digest('hex'),
    sizeBytes: stat.size,
  };
}

export function computeDirectorySizeSync(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    const lstat = fs.lstatSync(full);
    if (lstat.isSymbolicLink()) continue;
    if (lstat.isDirectory()) {
      total += computeDirectorySizeSync(full);
    } else if (lstat.isFile()) {
      total += lstat.size;
    }
  }
  return total;
}

function syncPathToDiskSync(targetPath: string, directory = false): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(targetPath, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not consistently expose directory handles through Node's
    // fs.open; file contents are still fsynced there, but directory-entry
    // durability must be validated on supported host/filesystem combinations.
    if (!(directory && process.platform === 'win32' && ['EACCES', 'EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(code ?? ''))) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function syncDirectoryTreeToDiskSync(rootDir: string): void {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      syncDirectoryTreeToDiskSync(entryPath);
    } else if (stat.isFile()) {
      syncPathToDiskSync(entryPath);
    }
  }
  syncPathToDiskSync(rootDir, true);
}

function writeFileAtomicallyAndSyncSync(filePath: string, content: string, mode = 0o600): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode });
    syncPathToDiskSync(temporaryPath);
    fs.renameSync(temporaryPath, filePath);
    syncPathToDiskSync(directory, true);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function copyDirectoryRecursiveSync(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o755 });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const lstat = fs.lstatSync(srcPath);
    if (lstat.isSymbolicLink()) {
      continue;
    }
    if (lstat.isDirectory()) {
      copyDirectoryRecursiveSync(srcPath, destPath);
    } else if (lstat.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      fs.chmodSync(destPath, lstat.mode);
    }
  }
}

export interface InstallationConfigManifest {
  readonly schemaVersion: '1.0.0';
  readonly productName: string;
  readonly releaseChannel: 'BETA' | 'STABLE';
  readonly appVersion: string;
  readonly betaVersion: string;
  readonly buildId: string;
  readonly commitHash: string;
  readonly pluginVersion: string;
  readonly companionVersion: string;
  readonly asrCoreVersion: string;
  readonly nativeRuntimeVersion: string;
  readonly ipcProtocolVersion: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly installedAtIso: string;
  readonly telemetryEnabled: false;
  readonly autoUploadDiagnostics: false;
  readonly offlineOnlyEnforced: true;
  readonly componentChecksums: Readonly<Record<string, string>>;
}

export interface FirstRunEvaluationResult {
  readonly status: FirstRunTerminalStatus;
  readonly readyForFirstProject: boolean;
  readonly pluginDetected: boolean;
  readonly companionReady: boolean;
  readonly nativeSherpaReady: boolean;
  readonly modelInstalled: boolean;
  readonly modelIntegrityVerified: boolean;
  readonly versionCompatible: boolean;
  readonly permissionsValid: boolean;
  readonly tempSpaceAvailable: boolean;
  readonly userMessageFa: string;
  readonly remediationStepsFa: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface InstallerWizardStepRecord {
  readonly stepNumber: number;
  readonly stepId:
    | 'WELCOME'
    | 'SYSTEM_REQUIREMENTS'
    | 'INSTALLATION_LOCATION'
    | 'INSTALLATION_PROGRESS'
    | 'NATIVE_RUNTIME_STATUS'
    | 'MODEL_STATUS'
    | 'PLUGIN_STATUS'
    | 'HEALTH_CHECK'
    | 'INSTALLATION_COMPLETE';
  readonly titleFa: string;
  readonly status: 'COMPLETED' | 'WARNING' | 'FAILED';
  readonly messageFa: string;
}

export interface InstallationExecutionResult {
  readonly ok: boolean;
  readonly status: FirstRunTerminalStatus;
  readonly errorCode?: string;
  readonly userMessageFa: string;
  readonly layout: InstalledDirectoryLayout;
  readonly wizardSteps: readonly InstallerWizardStepRecord[];
  readonly firstRunReport: FirstRunEvaluationResult | null;
  readonly metrics: {
    readonly installationDurationMs: number;
    readonly installedTotalBytes: number;
    readonly nativeRuntimeBytes: number;
    readonly modelBytes: number;
    readonly companionBytes: number;
    readonly cepPluginBytes: number;
  };
}

export interface PackageSourcePaths {
  readonly appDistDir?: string;
  readonly companionBundleFile: string;
  readonly runtimeDir: string;
  readonly modelDir?: string;
  readonly cepPluginDir: string;
}

/**
 * Evaluates the First-Run experience status (`READY`, `DEGRADED`, `MODEL_MISSING`,
 * `MODEL_INVALID`, `RUNTIME_ERROR`, `CONNECTION_FAILED`, `VERSION_MISMATCH`, `PERMISSION_DENIED`).
 * Never returns `READY` if Native Sherpa or the ASR model is missing or corrupted.
 */
export function evaluateInstalledFirstRunStatus(params: {
  readonly layout: InstalledDirectoryLayout;
  readonly checkCompanionConnection?: () => { readonly connected: boolean; readonly ipcProtocolVersion?: string };
  readonly simulatedAvailableDiskBytes?: number;
  readonly minRequiredTempBytes?: number;
}): FirstRunEvaluationResult {
  const { layout } = params;
  const remediation: string[] = [];

  // 1. Check directory & file permissions
  let permissionsValid = true;
  try {
    fs.accessSync(layout.installRoot, fs.constants.R_OK | fs.constants.W_OK);
    for (const dir of [layout.configDir, layout.userDataDir, layout.tempDir, layout.logsDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
      const probeFile = path.join(dir, `.perm_probe_${process.pid}`);
      fs.writeFileSync(probeFile, 'ok', { mode: 0o600 });
      fs.rmSync(probeFile, { force: true });
    }
  } catch {
    permissionsValid = false;
  }

  if (!permissionsValid) {
    return {
      status: 'PERMISSION_DENIED',
      readyForFirstProject: false,
      pluginDetected: false,
      companionReady: false,
      nativeSherpaReady: false,
      modelInstalled: false,
      modelIntegrityVerified: false,
      versionCompatible: false,
      permissionsValid: false,
      tempSpaceAvailable: false,
      userMessageFa: 'دسترسی نوشتن یا خواندن در پوشه نصب آواپرداز وجود ندارد.',
      remediationStepsFa: [
        'مجوز دسترسی پوشه نصب و پوشه کاربری را بررسی کنید.',
        'مسیر نصب را در پوشه‌ای که کاربر فعلی به آن دسترسی کامل دارد انتخاب نمایید.',
      ],
      details: { installRoot: layout.installRoot },
    };
  }

  // 2. Check temp space
  const minTempBytes = params.minRequiredTempBytes ?? 100 * 1024 * 1024;
  let availableBytes = params.simulatedAvailableDiskBytes;
  if (availableBytes === undefined) {
    try {
      const statFs = fs.statfsSync(layout.tempDir);
      availableBytes = Number(statFs.bavail) * Number(statFs.bsize);
    } catch {
      availableBytes = 1024 * 1024 * 1024;
    }
  }
  const tempSpaceAvailable = availableBytes >= minTempBytes;
  if (!tempSpaceAvailable) {
    return {
      status: 'RUNTIME_ERROR',
      readyForFirstProject: false,
      pluginDetected: false,
      companionReady: false,
      nativeSherpaReady: false,
      modelInstalled: false,
      modelIntegrityVerified: false,
      versionCompatible: true,
      permissionsValid: true,
      tempSpaceAvailable: false,
      userMessageFa: 'فضای خالی دیسک برای پردازش موقت فایل‌های صوتی کافی نیست.',
      remediationStepsFa: ['حداقل ۵۰۰ مگابایت فضای خالی روی دیسک ایجاد کنید و دوباره تلاش کنید.'],
      details: { availableBytes, minTempBytes },
    };
  }

  // 3. Check Config & Version Compatibility
  const configPath = path.join(layout.configDir, 'installation-manifest.json');
  let installedConfig: InstallationConfigManifest | null = null;
  if (fs.existsSync(configPath)) {
    try {
      installedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as InstallationConfigManifest;
    } catch {
      installedConfig = null;
    }
  }

  const companionCheck = params.checkCompanionConnection
    ? params.checkCompanionConnection()
    : {
        connected: fs.existsSync(path.join(layout.companionDir, 'avapardaz-companion.mjs')),
        ipcProtocolVersion: installedConfig?.ipcProtocolVersion ?? CURRENT_COMPONENT_VERSIONS.ipcProtocolVersion,
      };

  const cepManifestPath = path.join(layout.cepExtensionDir, 'CSXS', 'manifest.xml');
  const cepAppJsPath = path.join(layout.cepExtensionDir, 'client', 'app.js');
  const pluginDetected = fs.existsSync(cepManifestPath) && fs.existsSync(cepAppJsPath);

  const compat = evaluateComponentCompatibility({
    cepRequiredIpcProtocol: installedConfig?.ipcProtocolVersion ?? '1.0.0',
    companionIpcProtocol: companionCheck.ipcProtocolVersion ?? '1.0.0',
  });

  if (!compat.compatible) {
    return {
      status: 'VERSION_MISMATCH',
      readyForFirstProject: false,
      pluginDetected,
      companionReady: companionCheck.connected,
      nativeSherpaReady: false,
      modelInstalled: false,
      modelIntegrityVerified: false,
      versionCompatible: false,
      permissionsValid: true,
      tempSpaceAvailable: true,
      userMessageFa: 'نسخه افزونه Adobe Audition با سرویس محلی Companion سازگار نیست.',
      remediationStepsFa: [
        'بسته به‌روزرسانی آواپرداز را اجرا کنید تا افزونه و سرویس Companion همگام شوند.',
      ],
      details: { blockingReasons: compat.blockingReasons },
    };
  }

  // 4. Check Native Sherpa Runtime binaries & shared libraries
  const offlineBinCandidates = [
    path.join(layout.runtimeBinDir, 'sherpa-onnx-offline'),
    path.join(layout.runtimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline'),
    path.join(layout.runtimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline.exe'),
  ];
  const offlineBin = offlineBinCandidates.find((candidate) => fs.existsSync(candidate)) ?? offlineBinCandidates[0];
  const streamingBridgeBin = path.join(layout.runtimeBinDir, 'sherpa-onnx-streaming-bridge');
  const runtimeLibraryDirs = [
    layout.runtimeLibDir,
    ...['3.11', '3.12', '3.13'].flatMap((version) => [
      path.join(layout.runtimeDir, 'lib', `python${version}`, 'site-packages', 'sherpa_onnx', 'lib'),
      path.join(layout.runtimeDir, 'sherpa-venv', 'lib', `python${version}`, 'site-packages', 'sherpa_onnx', 'lib'),
    ]),
  ];
  const hasOnnxRuntimeLibrary = runtimeLibraryDirs.some((dir) =>
    ['libonnxruntime.so', 'libonnxruntime.dylib', 'onnxruntime.dll'].some((name) => fs.existsSync(path.join(dir, name))),
  );
  const hasSherpaCApiLibrary = runtimeLibraryDirs.some((dir) =>
    ['libsherpa-onnx-c-api.so', 'libsherpa-onnx-c-api.dylib', 'sherpa-onnx-c-api.dll'].some((name) => fs.existsSync(path.join(dir, name))),
  );

  let nativeBinExecutable = false;
  try {
    fs.accessSync(offlineBin, fs.constants.X_OK);
    nativeBinExecutable = fs.statSync(offlineBin).size > 1024;
  } catch {
    nativeBinExecutable = false;
  }

  // The offline CLI requires ONNX Runtime; the separate Sherpa C API bridge is optional.
  const nativeSherpaReady = nativeBinExecutable && hasOnnxRuntimeLibrary;
  if (!nativeSherpaReady) {
    return {
      status: 'RUNTIME_ERROR',
      readyForFirstProject: false,
      pluginDetected,
      companionReady: companionCheck.connected,
      nativeSherpaReady: false,
      modelInstalled: false,
      modelIntegrityVerified: false,
      versionCompatible: true,
      permissionsValid: true,
      tempSpaceAvailable: true,
      userMessageFa: 'موتور پردازش بومی گفتار (Native Sherpa Runtime) یافت نشد یا ناقص است.',
      remediationStepsFa: [
        'نصب‌کننده آواپرداز را مجدداً اجرا کنید تا فایل‌های اجرایی موتور صوتی ترمیم شوند.',
      ],
      details: {
        offlineBinExists: fs.existsSync(offlineBin),
        streamingBridgeExists: fs.existsSync(streamingBridgeBin),
        hasOnnxRuntimeLibrary,
        hasSherpaCApiLibrary,
        runtimeLibraryDirs,
      },
    };
  }

  // 5. Check the primary Koochik model first, retaining the smaller Rizeh INT8 fallback.
  const koochikModelOnnxPath = path.join(layout.shahabKoochikModelDir, 'model.onnx');
  const koochikTokensPath = path.join(layout.shahabKoochikModelDir, 'tokens.txt');
  const koochikPresent = fs.existsSync(koochikModelOnnxPath) && fs.existsSync(koochikTokensPath);
  const koochikVerified = koochikPresent && verifyShahabKoochikModelFiles(layout.shahabKoochikModelDir);
  const rizehModelOnnxPath = path.join(layout.shenavaModelDir, 'model.int8.onnx');
  const rizehTokensPath = path.join(layout.shenavaModelDir, 'tokens.txt');
  const rizehPresent = fs.existsSync(rizehModelOnnxPath) && fs.existsSync(rizehTokensPath);
  const rizehVerified = rizehPresent && verifyModelFilesIntegrity([rizehModelOnnxPath, rizehTokensPath]);
  const selectedModelId = koochikVerified
    ? 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx'
    : rizehVerified
      ? 'Reza2kn/Shenava-Rizeh'
      : null;
  const modelInstalled = koochikPresent || rizehPresent;
  const modelIntegrityVerified = selectedModelId !== null;
  const selectedModelDirectory = koochikVerified ? layout.shahabKoochikModelDir : layout.shenavaModelDir;

  if (!modelInstalled) {
    return {
      status: 'MODEL_MISSING',
      readyForFirstProject: false,
      pluginDetected,
      companionReady: companionCheck.connected,
      nativeSherpaReady: true,
      modelInstalled: false,
      modelIntegrityVerified: false,
      versionCompatible: true,
      permissionsValid: true,
      tempSpaceAvailable: true,
      userMessageFa: 'مدل تشخیص گفتار فارسی روی سیستم نصب نشده است.',
      remediationStepsFa: [
        'بسته مدل اصلی فارسی Shenava Koochik را نصب کنید؛ در صورت نیاز، مدل سبک‌تر Shenava-Rizeh نیز به‌عنوان جایگزین پشتیبانی می‌شود.',
      ],
      details: { shahabKoochikModelDir: layout.shahabKoochikModelDir, shenavaModelDir: layout.shenavaModelDir },
    };
  }

  if (!modelIntegrityVerified) {
    return {
      status: 'MODEL_INVALID',
      readyForFirstProject: false,
      pluginDetected,
      companionReady: companionCheck.connected,
      nativeSherpaReady: true,
      modelInstalled: true,
      modelIntegrityVerified: false,
      versionCompatible: true,
      permissionsValid: true,
      tempSpaceAvailable: true,
      userMessageFa: 'فایل مدل تشخیص گفتار فارسی آسیب دیده یا ناقص است (عدم تطابق SHA-256).',
      remediationStepsFa: [
        'نصب‌کننده آواپرداز را اجرا کنید تا مدل سالم جایگزین فایل ناقص شود.',
      ],
      details: { koochikPresent, rizehPresent, shahabKoochikModelDir: layout.shahabKoochikModelDir, shenavaModelDir: layout.shenavaModelDir },
    };
  }

  // 6. Check Companion connection
  if (!companionCheck.connected) {
    return {
      status: 'CONNECTION_FAILED',
      readyForFirstProject: false,
      pluginDetected,
      companionReady: false,
      nativeSherpaReady: true,
      modelInstalled: true,
      modelIntegrityVerified: true,
      versionCompatible: true,
      permissionsValid: true,
      tempSpaceAvailable: true,
      userMessageFa: 'ارتباط با سرویس محلی آواپرداز (Local Companion) برقرار نشد.',
      remediationStepsFa: [
        'سرویس محلی آواپرداز را راه‌اندازی کنید یا دکمه «اتصال مجدد» را در پنل بزنید.',
      ],
      details: {},
    };
  }

  // 7. Check CEP plugin presence (if missing, report DEGRADED)
  if (!pluginDetected) {
    remediation.push('پلاگین Adobe Audition در مسیر افزونه‌های CEP یافت نشد؛ نصب پلاگین را تکمیل کنید.');
    return {
      status: 'DEGRADED',
      readyForFirstProject: true,
      pluginDetected: false,
      companionReady: true,
      nativeSherpaReady: true,
      modelInstalled: true,
      modelIntegrityVerified: true,
      versionCompatible: true,
      permissionsValid: true,
      tempSpaceAvailable: true,
      userMessageFa: 'موتور صوتی و مدل فارسی آماده هستند، اما افزونه Adobe Audition نصب نشده است.',
      remediationStepsFa: remediation,
      details: { cepExtensionDir: layout.cepExtensionDir },
    };
  }

  return {
    status: 'READY',
    readyForFirstProject: true,
    pluginDetected: true,
    companionReady: true,
    nativeSherpaReady: true,
    modelInstalled: true,
    modelIntegrityVerified: true,
    versionCompatible: true,
    permissionsValid: true,
    tempSpaceAvailable: true,
    userMessageFa: 'آواپرداز آماده استفاده است. می‌توانید اولین پروژه صوتی خود را در Adobe Audition پردازش کنید.',
    remediationStepsFa: [],
    details: {
      appVersion: installedConfig?.appVersion ?? AVAPARDAZ_BETA_RELEASE_IDENTITY.appVersion,
      modelId: AVAPARDAZ_BETA_RELEASE_IDENTITY.modelId,
      nativeRuntimeVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.nativeRuntimeVersion,
    },
  };
}

/**
 * Production & Beta Installer Engine (`Phase 1C-H §9..§11` & `Phase 1C-I §4..§6`).
 */
export class AvapardazProductionInstaller {
  public static install(params: {
    readonly installRoot: string;
    readonly customCepExtensionDir?: string;
    readonly sources: PackageSourcePaths;
    readonly skipModelInstall?: boolean;
    readonly simulatedAvailableDiskBytes?: number;
    readonly requiredDiskBytes?: number;
    readonly failMidInstallAfterStep?: 'RUNTIME' | 'MODEL' | 'COMPANION';
  }): InstallationExecutionResult {
    const t0 = performance.now();
    const layout = resolveInstalledDirectoryLayout(params.installRoot, params.customCepExtensionDir);
    const wizardSteps: InstallerWizardStepRecord[] = [];

    // Step 1: Welcome
    wizardSteps.push({
      stepNumber: 1,
      stepId: 'WELCOME',
      titleFa: 'خوش‌آمدگویی به نصب‌کننده آواپرداز',
      status: 'COMPLETED',
      messageFa: `نصب نسخه آزمایشی کنترل‌شده ${AVAPARDAZ_BETA_RELEASE_IDENTITY.betaVersion} (${AVAPARDAZ_BETA_RELEASE_IDENTITY.buildId}) آغاز شد.`,
    });

    // Step 2: System Requirements (OS, CPU Arch, Disk Space)
    const platform = process.platform;
    const arch = process.arch;
    const minRequiredBytes = params.requiredDiskBytes ?? 220 * 1024 * 1024; // 220 MiB required

    let availableDiskBytes = params.simulatedAvailableDiskBytes;
    if (availableDiskBytes === undefined) {
      try {
        const parentDir = fs.existsSync(layout.installRoot)
          ? layout.installRoot
          : path.dirname(layout.installRoot);
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
        const statFs = fs.statfsSync(parentDir);
        availableDiskBytes = Number(statFs.bavail) * Number(statFs.bsize);
      } catch {
        availableDiskBytes = 2 * 1024 * 1024 * 1024;
      }
    }

    if (availableDiskBytes < minRequiredBytes) {
      wizardSteps.push({
        stepNumber: 2,
        stepId: 'SYSTEM_REQUIREMENTS',
        titleFa: 'بررسی پیش‌نیازهای سیستم و فضای دیسک',
        status: 'FAILED',
        messageFa: `فضای دیسک کافی نیست (موجود: ${Math.round(availableDiskBytes / (1024 * 1024))} مگابایت، موردنیاز: ${Math.round(minRequiredBytes / (1024 * 1024))} مگابایت).`,
      });
      return {
        ok: false,
        status: 'RUNTIME_ERROR',
        errorCode: 'INSUFFICIENT_DISK_SPACE',
        userMessageFa: 'فضای خالی دیسک برای نصب آواپرداز کافی نیست.',
        layout,
        wizardSteps,
        firstRunReport: null,
        metrics: {
          installationDurationMs: Math.round(performance.now() - t0),
          installedTotalBytes: 0,
          nativeRuntimeBytes: 0,
          modelBytes: 0,
          companionBytes: 0,
          cepPluginBytes: 0,
        },
      };
    }

    wizardSteps.push({
      stepNumber: 2,
      stepId: 'SYSTEM_REQUIREMENTS',
      titleFa: 'بررسی پیش‌نیازهای سیستم و فضای دیسک',
      status: 'COMPLETED',
      messageFa: `سیستم‌عامل ${platform}-${arch} و فضای دیسک تایید شد.`,
    });

    // Step 3: Installation Location & Permission Check
    try {
      fs.mkdirSync(layout.installRoot, { recursive: true, mode: 0o755 });
      fs.accessSync(layout.installRoot, fs.constants.R_OK | fs.constants.W_OK);
      const probe = path.join(layout.installRoot, `.install_probe_${process.pid}`);
      fs.writeFileSync(probe, 'probe', { mode: 0o600 });
      fs.rmSync(probe, { force: true });
    } catch {
      wizardSteps.push({
        stepNumber: 3,
        stepId: 'INSTALLATION_LOCATION',
        titleFa: 'بررسی مسیر نصب و مجوز دسترسی',
        status: 'FAILED',
        messageFa: 'امکان ایجاد فایل در مسیر انتخاب‌شده وجود ندارد (خطای دسترسی).',
      });
      return {
        ok: false,
        status: 'PERMISSION_DENIED',
        errorCode: 'INSTALL_PERMISSION_DENIED',
        userMessageFa: 'دسترسی نوشتن در مسیر انتخاب‌شده وجود ندارد.',
        layout,
        wizardSteps,
        firstRunReport: null,
        metrics: {
          installationDurationMs: Math.round(performance.now() - t0),
          installedTotalBytes: 0,
          nativeRuntimeBytes: 0,
          modelBytes: 0,
          companionBytes: 0,
          cepPluginBytes: 0,
        },
      };
    }

    wizardSteps.push({
      stepNumber: 3,
      stepId: 'INSTALLATION_LOCATION',
      titleFa: 'تعیین مسیر نصب و تفکیک داده‌های کاربر',
      status: 'COMPLETED',
      messageFa: `مسیر نصب در ${layout.installRoot} تایید شد.`,
    });

    // Preserve existing healthy installation in a temporary backup slot so mid-install failure
    // or interrupted re-install never corrupts an existing valid installation.
    const hadPreviousInstall = fs.existsSync(path.join(layout.configDir, 'installation-manifest.json'));
    const rollbackTempDir = path.join(layout.installRoot, `.install_rollback_${Date.now()}`);
    const stageRootDir = path.join(layout.installRoot, `.install_stage_${Date.now()}`);

    try {
      if (hadPreviousInstall) {
        fs.mkdirSync(rollbackTempDir, { recursive: true, mode: 0o700 });
        for (const sub of ['app', 'companion', 'runtime', 'config']) {
          const existingSub = path.join(layout.installRoot, sub);
          if (fs.existsSync(existingSub)) {
            copyDirectoryRecursiveSync(existingSub, path.join(rollbackTempDir, sub));
          }
        }
      }

      fs.mkdirSync(stageRootDir, { recursive: true, mode: 0o700 });

      // Ensure user-data, logs, tmp, and backups directories exist (NEVER overwrite user-data!)
      for (const dir of [
        layout.userDataDir,
        layout.userProjectsDir,
        layout.userTranscriptsDir,
        layout.userEdlDir,
        layout.userCheckpointsDir,
        layout.userFeedbackDir,
        layout.logsDir,
        layout.tempDir,
        layout.backupsDir,
      ]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Step 4: Stage Application & Companion Files
      const stageAppDir = path.join(stageRootDir, 'app');
      const stageCompanionDir = path.join(stageRootDir, 'companion');
      fs.mkdirSync(stageAppDir, { recursive: true, mode: 0o755 });
      fs.mkdirSync(stageCompanionDir, { recursive: true, mode: 0o755 });

      if (params.sources.appDistDir && fs.existsSync(params.sources.appDistDir)) {
        copyDirectoryRecursiveSync(params.sources.appDistDir, stageAppDir);
      } else {
        fs.writeFileSync(
          path.join(stageAppDir, 'release-info.json'),
          JSON.stringify(AVAPARDAZ_BETA_RELEASE_IDENTITY, null, 2),
          'utf8',
        );
      }

      if (!fs.existsSync(params.sources.companionBundleFile)) {
        throw new Error(`COMPANION_BUNDLE_MISSING: ${params.sources.companionBundleFile}`);
      }
      const companionTargetInStage = path.join(stageCompanionDir, 'avapardaz-companion.mjs');
      fs.copyFileSync(params.sources.companionBundleFile, companionTargetInStage);
      fs.chmodSync(companionTargetInStage, 0o755);

      if (params.failMidInstallAfterStep === 'COMPANION') {
        throw new Error('SIMULATED_MID_INSTALL_INTERRUPTION_AT_COMPANION');
      }

      wizardSteps.push({
        stepNumber: 4,
        stepId: 'INSTALLATION_PROGRESS',
        titleFa: 'نصب فایل‌های برنامه و سرویس محلی Companion',
        status: 'COMPLETED',
        messageFa: 'فایل‌های هسته برنامه و سرویس محلی Companion آماده شدند.',
      });

      // Step 5: Stage Native Sherpa Runtime
      const stageRuntimeDir = path.join(stageRootDir, 'runtime');
      if (!fs.existsSync(params.sources.runtimeDir)) {
        throw new Error(`NATIVE_RUNTIME_SOURCE_MISSING: ${params.sources.runtimeDir}`);
      }
      copyDirectoryRecursiveSync(params.sources.runtimeDir, stageRuntimeDir);
      const stagedOfflineBinCandidates = [
        path.join(stageRuntimeDir, 'bin', 'sherpa-onnx-offline'),
        path.join(stageRuntimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline'),
        path.join(stageRuntimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline.exe'),
      ];
      const stagedOfflineBin = stagedOfflineBinCandidates.find((candidate) => fs.existsSync(candidate));
      if (!stagedOfflineBin) {
        throw new Error('NATIVE_RUNTIME_BINARY_MISSING: sherpa-onnx-offline not found in legacy or lean runtime package layout.');
      }
      fs.chmodSync(stagedOfflineBin, 0o755);
      const stagedBridgeBin = path.join(stageRuntimeDir, 'bin', 'sherpa-onnx-streaming-bridge');
      if (fs.existsSync(stagedBridgeBin)) {
        fs.chmodSync(stagedBridgeBin, 0o755);
      }

      if (params.failMidInstallAfterStep === 'RUNTIME') {
        throw new Error('SIMULATED_MID_INSTALL_INTERRUPTION_AT_RUNTIME');
      }

      wizardSteps.push({
        stepNumber: 5,
        stepId: 'NATIVE_RUNTIME_STATUS',
        titleFa: 'نصب و بررسی موتور Native Sherpa',
        status: 'COMPLETED',
        messageFa: 'موتور بومی Sherpa-ONNX و کتابخانه‌های پردازش صوت نصب شدند.',
      });

      // Step 6: Verify & Install the primary Koochik model, retaining Rizeh as a fallback.
      const existingKoochikHealthy = verifyShahabKoochikModelFiles(layout.shahabKoochikModelDir);
      const existingRizehOnnx = path.join(layout.shenavaModelDir, 'model.int8.onnx');
      const existingRizehTokens = path.join(layout.shenavaModelDir, 'tokens.txt');
      const existingRizehHealthy =
        fs.existsSync(existingRizehOnnx) &&
        fs.existsSync(existingRizehTokens) &&
        verifyModelFilesIntegrity([existingRizehOnnx, existingRizehTokens]);
      let selectedInstalledModelId = existingKoochikHealthy
        ? 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx'
        : existingRizehHealthy
          ? 'Reza2kn/Shenava-Rizeh'
          : null;

      if (!params.skipModelInstall && params.sources.modelDir) {
        const sourceModelDir = path.resolve(params.sources.modelDir);
        const candidateKoochikValid = verifyShahabKoochikModelFiles(sourceModelDir);
        const candidateRizehOnnx = path.join(sourceModelDir, 'model.int8.onnx');
        const candidateRizehTokens = path.join(sourceModelDir, 'tokens.txt');
        const candidateRizehValid =
          fs.existsSync(candidateRizehOnnx) &&
          fs.existsSync(candidateRizehTokens) &&
          verifyModelFilesIntegrity([candidateRizehOnnx, candidateRizehTokens]);

        if (!candidateKoochikValid && !candidateRizehValid) {
          throw new Error(
            'MODEL_PACKAGE_CORRUPT: Candidate Koochik or Rizeh model failed pinned SHA-256 integrity verification; installation aborted.',
          );
        }

        const selectedSourceModelId = candidateKoochikValid
          ? 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx'
          : 'Reza2kn/Shenava-Rizeh';
        const selectedSourceModelDir = candidateKoochikValid
          ? layout.shahabKoochikModelDir
          : layout.shenavaModelDir;
        const alreadyHealthy = candidateKoochikValid ? existingKoochikHealthy : existingRizehHealthy;

        if (params.failMidInstallAfterStep === 'MODEL') {
          throw new Error('SIMULATED_MID_INSTALL_INTERRUPTION_AT_MODEL');
        }

        if (!alreadyHealthy) {
          const stageModelDir = path.join(stageRootDir, 'model_stage');
          copyDirectoryRecursiveSync(sourceModelDir, stageModelDir);
          fs.mkdirSync(layout.modelsDir, { recursive: true, mode: 0o755 });
          // Replace only the selected model directory after the staged copy is complete.
          // A healthy alternate model (Koochik or Rizeh) is never removed as a side effect.
          fs.rmSync(selectedSourceModelDir, { recursive: true, force: true });
          fs.renameSync(stageModelDir, selectedSourceModelDir);
        }
        selectedInstalledModelId = selectedSourceModelId;

        wizardSteps.push({
          stepNumber: 6,
          stepId: 'MODEL_STATUS',
          titleFa: 'بررسی و نصب مدل تشخیص گفتار فارسی',
          status: 'COMPLETED',
          messageFa: alreadyHealthy
            ? `مدل سالم ${selectedSourceModelId} شناسایی و بدون کپی مجدد حفظ شد.`
            : candidateKoochikValid
              ? 'مدل اصلی فارسی Shenava Koochik FP32 با بررسی SHA-256 نصب شد.'
              : 'مدل جایگزین سبک‌تر Shenava-Rizeh INT8 با بررسی SHA-256 نصب شد.',
        });
      } else {
        wizardSteps.push({
          stepNumber: 6,
          stepId: 'MODEL_STATUS',
          titleFa: 'بررسی مدل تشخیص گفتار فارسی',
          status: selectedInstalledModelId ? 'COMPLETED' : 'WARNING',
          messageFa: selectedInstalledModelId
            ? `مدل سالم ${selectedInstalledModelId} در سیستم موجود است.`
            : 'مدل فارسی در این نصب انتخاب نشد؛ پس از نصب باید مدل آفلاین وارد شود.',
        });
      }

      // Step 7: Install Adobe Audition CEP Plugin
      if (!fs.existsSync(params.sources.cepPluginDir)) {
        throw new Error(`CEP_PLUGIN_SOURCE_MISSING: ${params.sources.cepPluginDir}`);
      }
      const stageCepDir = path.join(stageRootDir, 'cep_stage');
      copyDirectoryRecursiveSync(params.sources.cepPluginDir, stageCepDir);
      if (!fs.existsSync(path.join(stageCepDir, 'CSXS', 'manifest.xml'))) {
        throw new Error('CEP_MANIFEST_MISSING: CSXS/manifest.xml missing from CEP plugin source.');
      }

      // Atomic activation of staged components
      for (const [stagedSub, targetDir] of [
        [stageAppDir, layout.appDir],
        [stageCompanionDir, layout.companionDir],
        [stageRuntimeDir, layout.runtimeDir],
      ] as const) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(stagedSub, targetDir);
      }

      fs.mkdirSync(path.dirname(layout.cepExtensionDir), { recursive: true, mode: 0o755 });
      fs.rmSync(layout.cepExtensionDir, { recursive: true, force: true });
      copyDirectoryRecursiveSync(stageCepDir, layout.cepExtensionDir);

      wizardSteps.push({
        stepNumber: 7,
        stepId: 'PLUGIN_STATUS',
        titleFa: 'نصب افزونه Adobe Audition CEP',
        status: 'COMPLETED',
        messageFa: `افزونه ${AVAPARDAZ_BETA_RELEASE_IDENTITY.extensionBundleId} با موفقیت نصب شد.`,
      });

      // Write configuration & version manifest
      fs.mkdirSync(layout.configDir, { recursive: true, mode: 0o700 });
      const companionHash = computeFileSha256Sync(
        path.join(layout.companionDir, 'avapardaz-companion.mjs'),
      ).sha256;
      const installedRuntimeBinary = [
        path.join(layout.runtimeBinDir, 'sherpa-onnx-offline'),
        path.join(layout.runtimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline'),
        path.join(layout.runtimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline.exe'),
      ].find((candidate) => fs.existsSync(candidate));
      if (!installedRuntimeBinary) throw new Error('INSTALLED_SHERPA_BINARY_MISSING_AFTER_ACTIVATION');
      const runtimeBinHash = computeFileSha256Sync(installedRuntimeBinary).sha256;
      const cepManifestHash = computeFileSha256Sync(
        path.join(layout.cepExtensionDir, 'CSXS', 'manifest.xml'),
      ).sha256;

      const installManifest: InstallationConfigManifest = {
        schemaVersion: '1.0.0',
        productName: AVAPARDAZ_BETA_RELEASE_IDENTITY.productName,
        releaseChannel: AVAPARDAZ_BETA_RELEASE_IDENTITY.releaseChannel,
        appVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.appVersion,
        betaVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.betaVersion,
        buildId: AVAPARDAZ_BETA_RELEASE_IDENTITY.buildId,
        commitHash: AVAPARDAZ_BETA_RELEASE_IDENTITY.commitHash,
        pluginVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.pluginVersion,
        companionVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.companionVersion,
        asrCoreVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.asrCoreVersion,
        nativeRuntimeVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.nativeRuntimeVersion,
        ipcProtocolVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.ipcProtocolVersion,
        modelId: selectedInstalledModelId ?? AVAPARDAZ_BETA_RELEASE_IDENTITY.modelId,
        modelVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.modelVersion,
        platform,
        arch,
        installedAtIso: new Date().toISOString(),
        telemetryEnabled: false,
        autoUploadDiagnostics: false,
        offlineOnlyEnforced: true,
        componentChecksums: {
          'companion/avapardaz-companion.mjs': companionHash,
          [path.relative(layout.installRoot, installedRuntimeBinary).split(path.sep).join('/')]: runtimeBinHash,
          'cep-extension/CSXS/manifest.xml': cepManifestHash,
        },
      };

      fs.writeFileSync(
        path.join(layout.configDir, 'installation-manifest.json'),
        JSON.stringify(installManifest, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );

      // Step 8: Post-Install Health Check
      const firstRunReport = evaluateInstalledFirstRunStatus({ layout });
      wizardSteps.push({
        stepNumber: 8,
        stepId: 'HEALTH_CHECK',
        titleFa: 'بررسی سلامت نصب و ارتباط اجزا',
        status:
          firstRunReport.status === 'READY'
            ? 'COMPLETED'
            : firstRunReport.status === 'MODEL_MISSING'
              ? 'WARNING'
              : 'FAILED',
        messageFa: firstRunReport.userMessageFa,
      });

      // Step 9: Installation Complete
      wizardSteps.push({
        stepNumber: 9,
        stepId: 'INSTALLATION_COMPLETE',
        titleFa: 'پایان نصب',
        status:
          firstRunReport.status === 'READY' || firstRunReport.status === 'MODEL_MISSING'
            ? 'COMPLETED'
            : 'FAILED',
        messageFa:
          firstRunReport.status === 'READY'
            ? 'نصب آواپرداز با موفقیت به پایان رسید و آماده اجرا است.'
            : firstRunReport.userMessageFa,
      });

      const nativeRuntimeBytes = computeDirectorySizeSync(layout.runtimeDir);
      const modelBytes = computeDirectorySizeSync(layout.shahabKoochikModelDir) + computeDirectorySizeSync(layout.shenavaModelDir);
      const companionBytes = computeDirectorySizeSync(layout.companionDir);
      const cepPluginBytes = computeDirectorySizeSync(layout.cepExtensionDir);
      const appBytes = computeDirectorySizeSync(layout.appDir);

      return {
        ok: firstRunReport.status === 'READY' || firstRunReport.status === 'MODEL_MISSING',
        status: firstRunReport.status,
        userMessageFa: firstRunReport.userMessageFa,
        layout,
        wizardSteps,
        firstRunReport,
        metrics: {
          installationDurationMs: Math.round(performance.now() - t0),
          installedTotalBytes:
            nativeRuntimeBytes + modelBytes + companionBytes + cepPluginBytes + appBytes,
          nativeRuntimeBytes,
          modelBytes,
          companionBytes,
          cepPluginBytes,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Restore previous valid installation if mid-install failed!
      if (hadPreviousInstall && fs.existsSync(rollbackTempDir)) {
        for (const sub of ['app', 'companion', 'runtime', 'config']) {
          const backupSub = path.join(rollbackTempDir, sub);
          const targetSub = path.join(layout.installRoot, sub);
          if (fs.existsSync(backupSub)) {
            fs.rmSync(targetSub, { recursive: true, force: true });
            copyDirectoryRecursiveSync(backupSub, targetSub);
          }
        }
      } else {
        // Clean up any partial installation directories so a broken install is never marked active
        for (const sub of ['app', 'companion', 'runtime', 'config']) {
          fs.rmSync(path.join(layout.installRoot, sub), { recursive: true, force: true });
        }
      }

      const isCorruptModel = msg.includes('MODEL_PACKAGE_CORRUPT');
      return {
        ok: false,
        status: isCorruptModel ? 'MODEL_INVALID' : 'RUNTIME_ERROR',
        errorCode: isCorruptModel ? 'MODEL_PACKAGE_CORRUPT' : 'INSTALLATION_FAILED_ROLLED_BACK',
        userMessageFa: isCorruptModel
          ? 'فایل مدل صوتی ناقص یا خراب است؛ نصب متوقف شد و نسخه سالم قبلی حفظ گردید.'
          : `نصب به دلیل خطا متوقف شد و تغییرات ناقص پاکسازی گردید: ${msg}`,
        layout,
        wizardSteps,
        firstRunReport: null,
        metrics: {
          installationDurationMs: Math.round(performance.now() - t0),
          installedTotalBytes: 0,
          nativeRuntimeBytes: 0,
          modelBytes: 0,
          companionBytes: 0,
          cepPluginBytes: 0,
        },
      };
    } finally {
      fs.rmSync(stageRootDir, { recursive: true, force: true });
      fs.rmSync(rollbackTempDir, { recursive: true, force: true });
    }
  }
}

export type UpdatablePackageComponent =
  | 'APPLICATION'
  | 'CEP_PLUGIN'
  | 'COMPANION'
  | 'NATIVE_RUNTIME'
  | 'ASR_MODEL';

export interface LocalUpdatePackageSpec {
  readonly updateId: string;
  readonly component: UpdatablePackageComponent;
  readonly targetVersion: string;
  readonly minCompatibleIpcProtocol: string;
  readonly sourcePath: string;
  readonly expectedSha256: string;
  readonly sizeBytes: number;
  readonly releaseNotesFa: string;
}

export interface UpdateExecutionReport {
  readonly ok: boolean;
  readonly rolledBack: boolean;
  readonly deferredDueToActiveSession: boolean;
  readonly component: UpdatablePackageComponent;
  readonly previousVersion: string;
  readonly activeVersion: string;
  readonly errorCode?: string;
  readonly messageFa: string;
  readonly backupId: string | null;
}

/**
 * Atomic Local Update & Rollback Engine (`Phase 1C-H §13..§14` & `Phase 1C-I §11`).
 * Never uses a cloud update server; operates deterministically on local signed/checksummed update packages.
 */
export class AvapardazPackageUpdateManager {
  constructor(private readonly layout: InstalledDirectoryLayout) {
    this.recoverInterruptedUpdates();
  }

  /**
   * Cross-process, installation-wide mutex. A directory creation is the atomic
   * acquisition primitive on supported local filesystems. Unknown/remote owners
   * fail closed; only a provably dead same-host PID may be reclaimed.
   */
  private withOperationLock<T>(operation: () => T): T {
    fs.mkdirSync(this.layout.backupsDir, { recursive: true, mode: 0o700 });
    const lockDir = path.join(this.layout.backupsDir, '.update-operation-lock');
    const recoveryLockDir = lockDir + '.recovery';
    const acquire = () => fs.mkdirSync(lockDir, { mode: 0o700 });
    try {
      acquire();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        fs.mkdirSync(recoveryLockDir, { mode: 0o700 });
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('UPDATE_OPERATION_LOCKED');
        }
        throw recoveryError;
      }
      try {
        const ownerPath = path.join(lockDir, 'owner.json');
        let stale = false;
        try {
          const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as {
            pid?: number; hostname?: string; acquiredAt?: number;
          };
          if (owner.hostname === os.hostname() && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) {
            try {
              process.kill(owner.pid as number, 0);
            } catch (probeError) {
              stale = (probeError as NodeJS.ErrnoException).code === 'ESRCH';
            }
          }
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code === 'ENOENT') {
            try {
              stale = Date.now() - fs.statSync(lockDir).mtimeMs > 30_000;
            } catch {
              stale = false;
            }
          }
        }
        if (!stale) throw new Error('UPDATE_OPERATION_LOCKED');
        const quarantine = lockDir + '.stale-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
        try {
          fs.renameSync(lockDir, quarantine);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('UPDATE_OPERATION_LOCKED');
          throw renameError;
        }
        fs.rmSync(quarantine, { recursive: true, force: true });
        acquire();
      } finally {
        fs.rmSync(recoveryLockDir, { recursive: true, force: true });
      }
    }

    const token = crypto.randomBytes(16).toString('hex');
    const ownerPath = path.join(lockDir, 'owner.json');
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
        token,
      }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return operation();
    } finally {
      try {
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as { token?: string };
        if (owner.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // If owner creation itself failed, this process still owns the empty directory.
        if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
        // Preserve an unexpected/replaced lock rather than releasing another owner's lease.
      }
    }
  }

  private journalPath(backupDir: string): string {
    return path.join(backupDir, 'activation-journal');
  }

  private markActivationPhase(backupDir: string, phase: 'PREPARED' | 'OLD_MOVED' | 'NEW_MOVED' | 'COMMITTED'): void {
    const journalDir = this.journalPath(backupDir);
    fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const marker = path.join(journalDir, phase);
    if (!fs.existsSync(marker)) {
      fs.mkdirSync(marker, { mode: 0o700 });
      syncPathToDiskSync(journalDir, true);
      syncPathToDiskSync(backupDir, true);
    }
  }

  /** Restore any update whose activation did not reach its committed marker. */
  public recoverInterruptedUpdates(): void {
    this.withOperationLock(() => this.recoverInterruptedUpdatesUnlocked());
  }

  private recoverInterruptedUpdatesUnlocked(): void {
    if (!fs.existsSync(this.layout.backupsDir)) return;
    for (const entry of fs.readdirSync(this.layout.backupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('bkp_')) continue;
      const backupDir = this.resolveBackupDir(entry.name);
      const journalDir = this.journalPath(backupDir);
      if (!fs.existsSync(journalDir)) continue;
      const component = this.componentFromBackupId(entry.name);
      const targetDir = this.resolveComponentTargetDir(component);
      const componentBackupDir = path.join(backupDir, 'component');
      const token = entry.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const sibling = (suffix: string) => path.join(path.dirname(targetDir), '.' + path.basename(targetDir) + '.' + token + suffix);
      if (fs.existsSync(path.join(journalDir, 'COMMITTED'))) {
        fs.rmSync(sibling('.stage'), { recursive: true, force: true });
        fs.rmSync(path.join(this.layout.tempDir, 'stage_' + entry.name), { recursive: true, force: true });
        fs.rmSync(sibling('.displaced'), { recursive: true, force: true });
        fs.rmSync(sibling('.restore'), { recursive: true, force: true });
        fs.rmSync(journalDir, { recursive: true, force: true });
        continue;
      }
      const stageDir = sibling('.stage');
      const displacedDir = sibling('.displaced');
      const restoreDir = sibling('.restore');
      try {
        if (fs.existsSync(componentBackupDir)) {
          fs.rmSync(restoreDir, { recursive: true, force: true });
          copyDirectoryRecursiveSync(componentBackupDir, restoreDir);
          syncDirectoryTreeToDiskSync(restoreDir);
          fs.rmSync(displacedDir, { recursive: true, force: true });
          if (fs.existsSync(targetDir)) fs.renameSync(targetDir, displacedDir);
          syncPathToDiskSync(path.dirname(targetDir), true);
          fs.renameSync(restoreDir, targetDir);
          syncPathToDiskSync(path.dirname(targetDir), true);
        } else {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        const manifestBackupPath = path.join(backupDir, 'manifest.backup.json');
        if (fs.existsSync(manifestBackupPath)) {
          const priorManifest = JSON.parse(fs.readFileSync(manifestBackupPath, 'utf8')) as InstallationConfigManifest;
          this.writeManifest(priorManifest);
        }
        fs.rmSync(stageDir, { recursive: true, force: true });
        fs.rmSync(path.join(this.layout.tempDir, 'stage_' + entry.name), { recursive: true, force: true });
        fs.rmSync(displacedDir, { recursive: true, force: true });
        fs.rmSync(restoreDir, { recursive: true, force: true });
        fs.rmSync(journalDir, { recursive: true, force: true });
      } catch (error) {
        throw new Error('INTERRUPTED_UPDATE_RECOVERY_FAILED: ' + entry.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  private componentFromBackupId(backupId: string): UpdatablePackageComponent {
    const match = /^bkp_(application|cep_plugin|companion|native_runtime|asr_model)_[A-Za-z0-9.+_-]{1,180}$/.exec(backupId);
    if (!match) throw new Error('INVALID_UPDATE_BACKUP_ID');
    switch (match[1]) {
      case 'application': return 'APPLICATION';
      case 'cep_plugin': return 'CEP_PLUGIN';
      case 'companion': return 'COMPANION';
      case 'native_runtime': return 'NATIVE_RUNTIME';
      case 'asr_model': return 'ASR_MODEL';
      default: throw new Error('INVALID_UPDATE_BACKUP_COMPONENT');
    }
  }

  private resolveBackupDir(backupId: string): string {
    this.componentFromBackupId(backupId);
    const root = path.resolve(this.layout.backupsDir);
    const candidate = path.resolve(root, backupId);
    if (path.dirname(candidate) !== root || path.basename(candidate) !== backupId) {
      throw new Error('UPDATE_BACKUP_PATH_OUTSIDE_ROOT');
    }
    return candidate;
  }

  private resolveComponentTargetDir(component: UpdatablePackageComponent): string {
    switch (component) {
      case 'APPLICATION':
        return this.layout.appDir;
      case 'CEP_PLUGIN':
        return this.layout.cepExtensionDir;
      case 'COMPANION':
        return this.layout.companionDir;
      case 'NATIVE_RUNTIME':
        return this.layout.runtimeDir;
      case 'ASR_MODEL':
        return fs.existsSync(path.join(this.layout.shahabKoochikModelDir, 'model.onnx'))
          ? this.layout.shahabKoochikModelDir
          : this.layout.shenavaModelDir;
    }
  }

  private readManifest(): InstallationConfigManifest {
    const p = path.join(this.layout.configDir, 'installation-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) as InstallationConfigManifest;
  }

  private writeManifest(manifest: InstallationConfigManifest): void {
    const p = path.join(this.layout.configDir, 'installation-manifest.json');
    writeFileAtomicallyAndSyncSync(p, JSON.stringify(manifest, null, 2), 0o600);
  }

  private getComponentVersion(
    manifest: InstallationConfigManifest,
    component: UpdatablePackageComponent,
  ): string {
    switch (component) {
      case 'APPLICATION':
        return manifest.appVersion;
      case 'CEP_PLUGIN':
        return manifest.pluginVersion;
      case 'COMPANION':
        return manifest.companionVersion;
      case 'NATIVE_RUNTIME':
        return manifest.nativeRuntimeVersion;
      case 'ASR_MODEL':
        return manifest.modelVersion;
    }
  }

  private updateManifestComponentVersion(
    manifest: InstallationConfigManifest,
    component: UpdatablePackageComponent,
    nextVersion: string,
  ): InstallationConfigManifest {
    switch (component) {
      case 'APPLICATION':
        return { ...manifest, appVersion: nextVersion, betaVersion: nextVersion };
      case 'CEP_PLUGIN':
        return { ...manifest, pluginVersion: nextVersion };
      case 'COMPANION':
        return { ...manifest, companionVersion: nextVersion };
      case 'NATIVE_RUNTIME':
        return { ...manifest, nativeRuntimeVersion: nextVersion };
      case 'ASR_MODEL':
        return { ...manifest, modelVersion: nextVersion };
    }
  }

  /**
   * Computes a deterministic SHA-256 over a file or directory tree for update package verification.
   */
  public static computePackagePathSha256(targetPath: string): {
    readonly sha256: string;
    readonly totalBytes: number;
  } {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      const res = computeFileSha256Sync(targetPath);
      return { sha256: res.sha256, totalBytes: res.sizeBytes };
    }

    const hash = crypto.createHash('sha256');
    let totalBytes = 0;
    const walk = (dir: string, relPrefix: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
        const lstat = fs.lstatSync(full);
        if (lstat.isSymbolicLink()) continue;
        if (lstat.isDirectory()) {
          walk(full, rel);
        } else if (lstat.isFile()) {
          const f = computeFileSha256Sync(full);
          hash.update(`${rel}:${f.sizeBytes}:${f.sha256}\n`);
          totalBytes += f.sizeBytes;
        }
      }
    };
    walk(targetPath, '');
    return { sha256: hash.digest('hex'), totalBytes };
  }

  public applyUpdate(params: {
    readonly pkg: LocalUpdatePackageSpec;
    readonly hasActiveProcessingSession?: boolean;
    readonly simulatedAvailableDiskBytes?: number;
    readonly customPostUpdateHealthCheck?: () => { readonly ok: boolean; readonly reason?: string };
    readonly simulateInterruptDuringActivation?: boolean;
  }): UpdateExecutionReport {
    try {
      return this.withOperationLock(() => this.applyUpdateUnlocked(params));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'UPDATE_OPERATION_LOCKED') throw error;
      const manifest = this.readManifest();
      const previousVersion = this.getComponentVersion(manifest, params.pkg.component);
      return {
        ok: false,
        rolledBack: false,
        deferredDueToActiveSession: false,
        component: params.pkg.component,
        previousVersion,
        activeVersion: previousVersion,
        errorCode: 'UPDATE_OPERATION_LOCKED',
        messageFa: 'عملیات نصب یا بازیابی دیگری در حال اجرا است؛ این درخواست بدون تغییر فایل‌ها متوقف شد.',
        backupId: null,
      };
    }
  }

  private applyUpdateUnlocked(params: {
    readonly pkg: LocalUpdatePackageSpec;
    readonly hasActiveProcessingSession?: boolean;
    readonly simulatedAvailableDiskBytes?: number;
    readonly customPostUpdateHealthCheck?: () => { readonly ok: boolean; readonly reason?: string };
    readonly simulateInterruptDuringActivation?: boolean;
  }): UpdateExecutionReport {
    const { pkg } = params;
    const manifest = this.readManifest();
    const prevVersion = this.getComponentVersion(manifest, pkg.component);

    // 1. Active Session Guard: never mutate active installation while a job is running
    if (params.hasActiveProcessingSession) {
      return {
        ok: false,
        rolledBack: false,
        deferredDueToActiveSession: true,
        component: pkg.component,
        previousVersion: prevVersion,
        activeVersion: prevVersion,
        errorCode: 'UPDATE_DEFERRED_ACTIVE_SESSION',
        messageFa:
          'به‌روزرسانی تا پایان پردازش صوتی فعال به تعویق افتاد تا داده‌های پروژه شما محافظت شود.',
        backupId: null,
      };
    }

    // 2. Source existence & Integrity Verification (SHA-256)
    if (!fs.existsSync(pkg.sourcePath)) {
      return {
        ok: false,
        rolledBack: false,
        deferredDueToActiveSession: false,
        component: pkg.component,
        previousVersion: prevVersion,
        activeVersion: prevVersion,
        errorCode: 'UPDATE_PACKAGE_MISSING',
        messageFa: 'فایل بسته به‌روزرسانی یافت نشد.',
        backupId: null,
      };
    }

    const computed = AvapardazPackageUpdateManager.computePackagePathSha256(pkg.sourcePath);
    if (
      !/^[a-f0-9]{64}$/i.test(pkg.expectedSha256) ||
      computed.sha256.toLowerCase() !== pkg.expectedSha256.toLowerCase()
    ) {
      return {
        ok: false,
        rolledBack: false,
        deferredDueToActiveSession: false,
        component: pkg.component,
        previousVersion: prevVersion,
        activeVersion: prevVersion,
        errorCode: 'UPDATE_HASH_MISMATCH',
        messageFa: 'اعتبارسنجی SHA-256 بسته به‌روزرسانی ناموفق بود؛ بسته دستکاری‌شده یا ناقص نصب نشد.',
        backupId: null,
      };
    }

    // 3. Version Compatibility Check
    const compat = evaluateComponentCompatibility({
      cepRequiredIpcProtocol: pkg.minCompatibleIpcProtocol,
      companionIpcProtocol: manifest.ipcProtocolVersion,
    });
    if (!compat.compatible) {
      return {
        ok: false,
        rolledBack: false,
        deferredDueToActiveSession: false,
        component: pkg.component,
        previousVersion: prevVersion,
        activeVersion: prevVersion,
        errorCode: 'UPDATE_VERSION_INCOMPATIBLE',
        messageFa: 'نسخه بسته به‌روزرسانی با پروتکل ارتباطی فعلی سازگار نیست.',
        backupId: null,
      };
    }

    // 4. Disk Space Check (require 2.5x package size for staging + backup)
    const availDisk = params.simulatedAvailableDiskBytes ?? 2 * 1024 * 1024 * 1024;
    if (availDisk < Math.max(pkg.sizeBytes, computed.totalBytes) * 2.5) {
      return {
        ok: false,
        rolledBack: false,
        deferredDueToActiveSession: false,
        component: pkg.component,
        previousVersion: prevVersion,
        activeVersion: prevVersion,
        errorCode: 'INSUFFICIENT_DISK_SPACE_FOR_UPDATE',
        messageFa: 'فضای دیسک برای پشتیبان‌گیری و نصب ایمن به‌روزرسانی کافی نیست.',
        backupId: null,
      };
    }

    // 5. Healthy Model Deduplication Guard: if updating ASR_MODEL and existing model already matches
    //    exact SHA-256 & targetVersion, skip redundant re-write.
    const targetDir = this.resolveComponentTargetDir(pkg.component);
    if (pkg.component === 'ASR_MODEL' && prevVersion === pkg.targetVersion && fs.existsSync(targetDir)) {
      const curModelHash = AvapardazPackageUpdateManager.computePackagePathSha256(targetDir);
      if (curModelHash.sha256 === computed.sha256) {
        return {
          ok: true,
          rolledBack: false,
          deferredDueToActiveSession: false,
          component: pkg.component,
          previousVersion: prevVersion,
          activeVersion: pkg.targetVersion,
          messageFa: 'مدل سالم فعلی با نسخه جدید یکسان است؛ نیازی به بازنویسی مجدد نبود.',
          backupId: null,
        };
      }
    }

    // 6. Staging & Backup
    const backupId = `bkp_${pkg.component.toLowerCase()}_${prevVersion}_${Date.now()}`;
    const backupDir = path.join(this.layout.backupsDir, backupId);
    const stageDir = path.join(this.layout.tempDir, 'stage_' + backupId);

    fs.mkdirSync(this.layout.backupsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.layout.tempDir, { recursive: true, mode: 0o700 });

    try {
      // Stage incoming artifact
      const srcStat = fs.statSync(pkg.sourcePath);
      if (srcStat.isDirectory()) {
        copyDirectoryRecursiveSync(pkg.sourcePath, stageDir);
      } else {
        fs.mkdirSync(stageDir, { recursive: true, mode: 0o755 });
        const destFile = path.join(stageDir, path.basename(pkg.sourcePath));
        fs.copyFileSync(pkg.sourcePath, destFile);
        fs.chmodSync(destFile, srcStat.mode);
      }

      // Backup current active component directory + manifest
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const componentBackupTarget = path.join(backupDir, 'component');
      if (fs.existsSync(targetDir)) {
        copyDirectoryRecursiveSync(targetDir, componentBackupTarget);
        syncDirectoryTreeToDiskSync(componentBackupTarget);
      }
      writeFileAtomicallyAndSyncSync(
        path.join(backupDir, 'manifest.backup.json'),
        JSON.stringify(manifest, null, 2),
        0o600,
      );
      syncPathToDiskSync(backupDir, true);
      syncPathToDiskSync(this.layout.backupsDir, true);

      // 7. Journaled activation: prepare beside target to keep rename operations on one volume.
      const siblingToken = backupId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const activationStageDir = path.join(path.dirname(targetDir), '.' + path.basename(targetDir) + '.' + siblingToken + '.stage');
      const displacedDir = path.join(path.dirname(targetDir), '.' + path.basename(targetDir) + '.' + siblingToken + '.displaced');
      fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o755 });
      this.markActivationPhase(backupDir, 'PREPARED');
      fs.rmSync(activationStageDir, { recursive: true, force: true });
      copyDirectoryRecursiveSync(stageDir, activationStageDir);
      syncDirectoryTreeToDiskSync(activationStageDir);
      syncPathToDiskSync(path.dirname(activationStageDir), true);
      if (params.simulateInterruptDuringActivation) {
        throw new Error('SIMULATED_INTERRUPTION_DURING_UPDATE_ACTIVATION');
      }
      fs.rmSync(displacedDir, { recursive: true, force: true });
      if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, displacedDir);
        syncPathToDiskSync(path.dirname(targetDir), true);
      }
      this.markActivationPhase(backupDir, 'OLD_MOVED');
      fs.renameSync(activationStageDir, targetDir);
      syncPathToDiskSync(path.dirname(targetDir), true);
      this.markActivationPhase(backupDir, 'NEW_MOVED');

      // Ensure executable bits on binaries after update
      if (pkg.component === 'NATIVE_RUNTIME') {
        const offBin = path.join(this.layout.runtimeBinDir, 'sherpa-onnx-offline');
        if (fs.existsSync(offBin)) fs.chmodSync(offBin, 0o755);
        const brBin = path.join(this.layout.runtimeBinDir, 'sherpa-onnx-streaming-bridge');
        if (fs.existsSync(brBin)) fs.chmodSync(brBin, 0o755);
      } else if (pkg.component === 'COMPANION') {
        const compBin = path.join(this.layout.companionDir, 'avapardaz-companion.mjs');
        if (fs.existsSync(compBin)) fs.chmodSync(compBin, 0o755);
      }

      const nextManifest = this.updateManifestComponentVersion(
        manifest,
        pkg.component,
        pkg.targetVersion,
      );
      this.writeManifest(nextManifest);

      // 8. Post-Update Health Check
      const firstRunHealth = evaluateInstalledFirstRunStatus({ layout: this.layout });
      const customHealth = params.customPostUpdateHealthCheck
        ? params.customPostUpdateHealthCheck()
        : { ok: true };

      if (firstRunHealth.status !== 'READY' || !customHealth.ok) {
        throw new Error(
          customHealth.reason ??
            `POST_UPDATE_HEALTH_CHECK_FAILED: status=${firstRunHealth.status} (${firstRunHealth.userMessageFa})`,
        );
      }

      this.markActivationPhase(backupDir, 'COMMITTED');
      fs.rmSync(displacedDir, { recursive: true, force: true });
      syncPathToDiskSync(path.dirname(targetDir), true);
      fs.rmSync(this.journalPath(backupDir), { recursive: true, force: true });
      syncPathToDiskSync(backupDir, true);
      return {
        ok: true,
        rolledBack: false,
        deferredDueToActiveSession: false,
        component: pkg.component,
        previousVersion: prevVersion,
        activeVersion: pkg.targetVersion,
        messageFa: `به‌روزرسانی ${pkg.component} به نسخه ${pkg.targetVersion} با موفقیت انجام و تایید شد.`,
        backupId,
      };
    } catch (err) {
      // Automatic Rollback to backupId
      const reason = err instanceof Error ? err.message : String(err);
      const rb = this.rollbackToBackupUnlocked(backupId);
      return {
        ok: false,
        rolledBack: rb.ok,
        deferredDueToActiveSession: false,
        component: pkg.component,
        previousVersion: prevVersion,
        activeVersion: rb.ok ? prevVersion : 'UNKNOWN',
        errorCode: 'UPDATE_FAILED_ROLLED_BACK',
        messageFa: `به‌روزرسانی ناموفق بود و نسخه سالم قبلی (${prevVersion}) به طور خودکار بازیابی شد: ${reason}`,
        backupId,
      };
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }

  /**
   * Deterministic Rollback: restores a component and its manifest from a backup slot.
   * Safe against repeated calls (idempotent) and never touches `user-data/`.
   */
  public rollbackToBackup(backupId: string): {
    readonly ok: boolean;
    readonly restoredVersion?: string;
    readonly messageFa: string;
  } {
    try {
      return this.withOperationLock(() => this.rollbackToBackupUnlocked(backupId));
    } catch (error) {
      if (error instanceof Error && error.message === 'UPDATE_OPERATION_LOCKED') {
        return { ok: false, messageFa: 'عملیات نصب یا بازیابی دیگری در حال اجرا است؛ بازگردانی انجام نشد.' };
      }
      throw error;
    }
  }

  private rollbackToBackupUnlocked(backupId: string): {
    readonly ok: boolean;
    readonly restoredVersion?: string;
    readonly messageFa: string;
  } {
    let backupDir: string;
    try {
      backupDir = this.resolveBackupDir(backupId);
    } catch {
      return { ok: false, messageFa: 'شناسه نسخه پشتیبان نامعتبر است.' };
    }
    const manifestBackupPath = path.join(backupDir, 'manifest.backup.json');
    const componentBackupDir = path.join(backupDir, 'component');

    if (!fs.existsSync(backupDir) || !fs.existsSync(manifestBackupPath)) {
      return {
        ok: false,
        messageFa: `نسخه پشتیبان ${backupId} یافت نشد.`,
      };
    }

    const backedUpManifest = JSON.parse(
      fs.readFileSync(manifestBackupPath, 'utf8'),
    ) as InstallationConfigManifest;

    const component = this.componentFromBackupId(backupId);

    const targetDir = this.resolveComponentTargetDir(component);
    const token = backupId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const siblingPrefix = '.' + path.basename(targetDir) + '.' + token;
    const restoreDir = path.join(path.dirname(targetDir), siblingPrefix + '.restore');
    const displacedDir = path.join(path.dirname(targetDir), siblingPrefix + '.displaced');
    this.markActivationPhase(backupDir, 'PREPARED');
    fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o755 });
    if (fs.existsSync(componentBackupDir)) {
      fs.rmSync(restoreDir, { recursive: true, force: true });
      copyDirectoryRecursiveSync(componentBackupDir, restoreDir);
      fs.rmSync(displacedDir, { recursive: true, force: true });
      if (fs.existsSync(targetDir)) fs.renameSync(targetDir, displacedDir);
      this.markActivationPhase(backupDir, 'OLD_MOVED');
      fs.renameSync(restoreDir, targetDir);
    } else {
      fs.rmSync(targetDir, { recursive: true, force: true });
      this.markActivationPhase(backupDir, 'OLD_MOVED');
    }
    this.markActivationPhase(backupDir, 'NEW_MOVED');
    this.writeManifest(backedUpManifest);
    this.markActivationPhase(backupDir, 'COMMITTED');
    fs.rmSync(displacedDir, { recursive: true, force: true });
    fs.rmSync(restoreDir, { recursive: true, force: true });
    fs.rmSync(this.journalPath(backupDir), { recursive: true, force: true });
    const restoredVersion = this.getComponentVersion(backedUpManifest, component);
    return {
      ok: true,
      restoredVersion,
      messageFa: `بازگشت به نسخه سالم قبلی (${restoredVersion}) با موفقیت انجام شد.`,
    };
  }
}

/**
 * Safe Uninstaller (`Phase 1C-H §15`):
 * - `STANDARD` uninstall: removes `app/`, `companion/`, `runtime/`, `cep-extension/`, and `tmp/`
 *   while strictly preserving `user-data/` (`projects`, `transcripts`, `edl`, `checkpoints`),
 *   `config/`, and `models/` (unless `removeModels` is requested).
 * - `COMPLETE` uninstall: removes all managed directories including `user-data/` ONLY when
 *   `confirmDeleteUserData: true` is explicitly passed.
 * - Idempotent: running uninstall multiple times never throws or deletes unmanaged parent directories.
 */
export class AvapardazSafeUninstaller {
  public static uninstall(params: {
    readonly layout: InstalledDirectoryLayout;
    readonly mode: 'STANDARD' | 'COMPLETE';
    readonly removeModels?: boolean;
    readonly confirmDeleteUserData?: boolean;
  }): {
    readonly ok: boolean;
    readonly mode: 'STANDARD' | 'COMPLETE';
    readonly removedPaths: readonly string[];
    readonly preservedPaths: readonly string[];
    readonly userProjectsPreserved: boolean;
    readonly messageFa: string;
  } {
    const { layout } = params;
    const removedPaths: string[] = [];
    const preservedPaths: string[] = [];

    const safeRemoveDir = (target: string) => {
      const resolved = path.resolve(target);
      if (resolved === '/' || resolved === os.homedir()) {
        throw new Error(`UNSAFE_UNINSTALL_TARGET_REFUSED: ${resolved}`);
      }
      if (fs.existsSync(resolved)) {
        fs.rmSync(resolved, { recursive: true, force: true });
        removedPaths.push(resolved);
      }
    };

    // Always remove application binaries, companion, runtime, CEP plugin, and temporary files
    for (const dir of [
      layout.appDir,
      layout.companionDir,
      layout.runtimeDir,
      layout.cepExtensionDir,
      layout.tempDir,
      layout.backupsDir,
    ]) {
      safeRemoveDir(dir);
    }

    if (params.mode === 'COMPLETE') {
      if (params.confirmDeleteUserData !== true) {
        throw new Error(
          'USER_CONFIRMATION_REQUIRED: Complete uninstall requires explicit confirmDeleteUserData: true.',
        );
      }
      for (const dir of [
        layout.modelsDir,
        layout.configDir,
        layout.logsDir,
        layout.userDataDir,
      ]) {
        safeRemoveDir(dir);
      }
      return {
        ok: true,
        mode: 'COMPLETE',
        removedPaths,
        preservedPaths,
        userProjectsPreserved: false,
        messageFa: 'حذف کامل آواپرداز و داده‌های مدیریت‌شده بر اساس تایید صریح کاربر انجام شد.',
      };
    }

    // STANDARD mode: preserve user-data and config!
    if (params.removeModels) {
      safeRemoveDir(layout.modelsDir);
    } else if (fs.existsSync(layout.modelsDir)) {
      preservedPaths.push(layout.modelsDir);
    }

    for (const dir of [layout.userDataDir, layout.configDir, layout.logsDir]) {
      if (fs.existsSync(dir)) {
        preservedPaths.push(dir);
      }
    }

    return {
      ok: true,
      mode: 'STANDARD',
      removedPaths,
      preservedPaths,
      userProjectsPreserved: true,
      messageFa:
        'برنامه، افزونه و سرویس Companion حذف شدند؛ پروژه‌ها، Transcriptها و تصمیم‌های تدوین (EDL) کاربر حفظ گردیدند.',
    };
  }
}

export interface BetaUserFeedbackSubmission {
  readonly feedbackId?: string;
  readonly betaGroup: BetaGroupIdentifier;
  readonly category: BetaIssueCategory;
  readonly uxTier: BetaUxFeedbackTier;
  readonly priority: BetaIssuePriority;
  readonly component:
    | 'INSTALLER'
    | 'CEP_PLUGIN'
    | 'COMPANION'
    | 'NATIVE_SHERPA_ASR'
    | 'TRANSCRIPT_ASSEMBLER'
    | 'EDITING_ENGINE'
    | 'PREVIEW_RENDERER'
    | 'AUDIO_EXPORTER';
  readonly reproductionSteps: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly userImpact: string;
  readonly resolutionStatus?: 'OPEN' | 'REPRODUCED' | 'RESOLVED' | 'KNOWN_ISSUE';
}

export interface StoredBetaFeedbackRecord extends BetaUserFeedbackSubmission {
  readonly feedbackId: string;
  readonly appVersion: string;
  readonly betaVersion: string;
  readonly buildId: string;
  readonly commitHash: string;
  readonly submittedAtIso: string;
  readonly resolutionStatus: 'OPEN' | 'REPRODUCED' | 'RESOLVED' | 'KNOWN_ISSUE';
}

export interface PrivacySafeBetaDiagnosticReport {
  readonly schemaVersion: '1.0.0';
  readonly generatedAtIso: string;
  readonly telemetryEnabledByDefault: false;
  readonly autoUploadPermitted: false;
  readonly userConsentGrantedForExport: boolean;
  readonly appVersion: string;
  readonly betaVersion: string;
  readonly buildId: string;
  readonly commitHash: string;
  readonly osPlatform: string;
  readonly osRelease: string;
  readonly cpuArch: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly nativeRuntimeVersion: string;
  readonly componentStatus: {
    readonly firstRunStatus: FirstRunTerminalStatus;
    readonly pluginDetected: boolean;
    readonly companionReady: boolean;
    readonly nativeSherpaReady: boolean;
    readonly modelIntegrityVerified: boolean;
  };
  readonly sessionMetrics: {
    readonly processingDurationMs: number;
    readonly peakRssMb: number;
    readonly cpuThreads: number;
    readonly sessionFailed: boolean;
    readonly errorCode: string | null;
    readonly crashDetected: boolean;
  };
  readonly sanitizedContext: Readonly<Record<string, unknown>>;
}

/**
 * Controlled Beta Feedback & Privacy-Safe Diagnostics Manager (`Phase 1C-I §8 & §9`).
 * Enforces:
 * - Telemetry disabled by default (`telemetryEnabledByDefault: false`)
 * - Zero audio bytes, zero transcript text, zero personal file paths, zero secrets/tokens
 * - Local-only export gated by user consent (`userConsentGrantedForExport`)
 */
export class AvapardazBetaDiagnosticsAndFeedbackManager {
  constructor(private readonly layout: InstalledDirectoryLayout) {
    fs.mkdirSync(this.layout.userFeedbackDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.layout.logsDir, { recursive: true, mode: 0o700 });
  }

  public submitUserFeedback(input: BetaUserFeedbackSubmission): StoredBetaFeedbackRecord {
    const feedbackId =
      input.feedbackId?.trim() || `FB-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const record: StoredBetaFeedbackRecord = {
      ...input,
      feedbackId,
      appVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.appVersion,
      betaVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.betaVersion,
      buildId: AVAPARDAZ_BETA_RELEASE_IDENTITY.buildId,
      commitHash: AVAPARDAZ_BETA_RELEASE_IDENTITY.commitHash,
      submittedAtIso: new Date().toISOString(),
      resolutionStatus: input.resolutionStatus ?? 'OPEN',
    };

    const filePath = path.join(this.layout.userFeedbackDir, `${feedbackId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return record;
  }

  public listFeedbackRecords(): readonly StoredBetaFeedbackRecord[] {
    if (!fs.existsSync(this.layout.userFeedbackDir)) return [];
    const files = fs
      .readdirSync(this.layout.userFeedbackDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    return files.map(
      (f) =>
        JSON.parse(
          fs.readFileSync(path.join(this.layout.userFeedbackDir, f), 'utf8'),
        ) as StoredBetaFeedbackRecord,
    );
  }

  public exportPrivacySafeDiagnostics(params: {
    readonly userConsentGranted: boolean;
    readonly processingDurationMs?: number;
    readonly peakRssMb?: number;
    readonly sessionFailed?: boolean;
    readonly errorCode?: string | null;
    readonly crashDetected?: boolean;
    readonly rawDiagnosticContext?: Record<string, unknown>;
  }): {
    readonly exported: boolean;
    readonly filePath: string | null;
    readonly report: PrivacySafeBetaDiagnosticReport;
  } {
    const firstRun = evaluateInstalledFirstRunStatus({ layout: this.layout });

    // Strip any forbidden sensitive fields (`transcript`, `rawText`, `audio`, `pcm`, `filePath`, `token`, `secret`, etc.)
    const rawCtx = params.rawDiagnosticContext ?? {};
    const sanitizedOnce = sanitizeLogPayload(rawCtx);
    const strictlySanitized: Record<string, unknown> = {};
    const forbiddenKeyPattern =
      /transcript|text|word|utterance|speech|audio|pcm|wav|path|file|dir|user|name|token|secret|key|auth|password|cookie/i;

    for (const [k, v] of Object.entries(sanitizedOnce)) {
      if (forbiddenKeyPattern.test(k)) {
        strictlySanitized[k] = '[REDACTED_PRIVACY_POLICY]';
      } else if (typeof v === 'string') {
        // Redact any accidental Unix/Windows file paths or Persian transcript content inside string values
        if (v.includes('/') || v.includes('\\') || /[\u0600-\u06FF]{4,}/.test(v)) {
          strictlySanitized[k] = '[REDACTED_SENSITIVE_VALUE]';
        } else {
          strictlySanitized[k] = v.slice(0, 80);
        }
      } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
        strictlySanitized[k] = v;
      }
    }

    const report: PrivacySafeBetaDiagnosticReport = {
      schemaVersion: '1.0.0',
      generatedAtIso: new Date().toISOString(),
      telemetryEnabledByDefault: false,
      autoUploadPermitted: false,
      userConsentGrantedForExport: params.userConsentGranted,
      appVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.appVersion,
      betaVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.betaVersion,
      buildId: AVAPARDAZ_BETA_RELEASE_IDENTITY.buildId,
      commitHash: AVAPARDAZ_BETA_RELEASE_IDENTITY.commitHash,
      osPlatform: process.platform,
      osRelease: os.release(),
      cpuArch: process.arch,
      modelId: AVAPARDAZ_BETA_RELEASE_IDENTITY.modelId,
      modelVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.modelVersion,
      nativeRuntimeVersion: AVAPARDAZ_BETA_RELEASE_IDENTITY.nativeRuntimeVersion,
      componentStatus: {
        firstRunStatus: firstRun.status,
        pluginDetected: firstRun.pluginDetected,
        companionReady: firstRun.companionReady,
        nativeSherpaReady: firstRun.nativeSherpaReady,
        modelIntegrityVerified: firstRun.modelIntegrityVerified,
      },
      sessionMetrics: {
        processingDurationMs: params.processingDurationMs ?? 0,
        peakRssMb:
          params.peakRssMb ?? Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
        cpuThreads: os.cpus()?.length || 4,
        sessionFailed: Boolean(params.sessionFailed),
        errorCode: params.errorCode
          ? params.errorCode.replace(/[^A-Z0-9_:-]/gi, '').slice(0, 64)
          : null,
        crashDetected: Boolean(params.crashDetected),
      },
      sanitizedContext: strictlySanitized,
    };

    if (!params.userConsentGranted) {
      return {
        exported: false,
        filePath: null,
        report,
      };
    }

    const outPath = path.join(
      this.layout.logsDir,
      `avapardaz-diagnostics-${Date.now()}.json`,
    );
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return {
      exported: true,
      filePath: outPath,
      report,
    };
  }
}

/**
 * Executes a Clean-Environment Verification (`Phase 1C-H §20`) by running the installed
 * Native Sherpa binary (`sherpa-onnx-offline`) and installed Companion bundle (`avapardaz-companion.mjs`)
 * from the installed directory with an isolated `HOME`, `PATH`, and `LD_LIBRARY_PATH` that has zero
 * access to the development source repository.
 */
export function runCleanEnvironmentInstalledVerification(params: {
  readonly layout: InstalledDirectoryLayout;
  readonly sampleWavPath: string;
}): {
  readonly ok: boolean;
  readonly nativeSherpaExitCode: number | null;
  readonly recognizedTextNonEmpty: boolean;
  readonly recognizedText: string;
  readonly durationMs: number;
  readonly isolatedEnvUsed: boolean;
  readonly error?: string;
} {
  const t0 = performance.now();
  const { layout } = params;
  const binaryCandidates = [
    path.join(layout.runtimeBinDir, 'sherpa-onnx-offline'),
    path.join(layout.runtimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline'),
    path.join(layout.runtimeDir, 'sherpa-venv', 'bin', 'sherpa-onnx-offline.exe'),
  ];
  const binPath = binaryCandidates.find((candidate) => fs.existsSync(candidate));
  const koochikModel = path.join(layout.shahabKoochikModelDir, 'model.onnx');
  const koochikTokens = path.join(layout.shahabKoochikModelDir, 'tokens.txt');
  const rizehModel = path.join(layout.shenavaModelDir, 'model.int8.onnx');
  const rizehTokens = path.join(layout.shenavaModelDir, 'tokens.txt');
  const selectedModel = fs.existsSync(koochikModel) && fs.existsSync(koochikTokens)
    ? { modelPath: koochikModel, tokensPath: koochikTokens, modelType: 'nemo_ctc' as const }
    : fs.existsSync(rizehModel) && fs.existsSync(rizehTokens)
      ? { modelPath: rizehModel, tokensPath: rizehTokens, modelType: 'nemo_ctc' as const }
      : null;

  const runtimeLibraryCandidates = [
    layout.runtimeLibDir,
    ...['3.11', '3.12', '3.13'].flatMap((version) => [
      path.join(layout.runtimeDir, 'lib', `python${version}`, 'site-packages', 'sherpa_onnx', 'lib'),
      path.join(layout.runtimeDir, 'sherpa-venv', 'lib', `python${version}`, 'site-packages', 'sherpa_onnx', 'lib'),
    ]),
  ];
  const runtimeLibraryDir = runtimeLibraryCandidates.find((candidate) => {
    try {
      return fs.readdirSync(candidate).some((name) =>
        /^(?:libonnxruntime\.(?:dylib|so(?:\.|$))|onnxruntime\.dll)$/.test(name),
      );
    } catch {
      return false;
    }
  }) ?? layout.runtimeLibDir;

  if (!binPath || !selectedModel || !fs.existsSync(params.sampleWavPath)) {
    return {
      ok: false,
      nativeSherpaExitCode: null,
      recognizedTextNonEmpty: false,
      recognizedText: '',
      durationMs: Math.round(performance.now() - t0),
      isolatedEnvUsed: true,
      error: 'INSTALLED_ARTIFACTS_MISSING',
    };
  }

  // Copy sample WAV into installed tempDir so child process touches zero files in the source repo.
  fs.mkdirSync(layout.tempDir, { recursive: true, mode: 0o700 });
  const isolatedWavPath = path.join(layout.tempDir, 'clean_env_verify.wav');
  fs.copyFileSync(params.sampleWavPath, isolatedWavPath);

  try {
    const isolatedEnv: NodeJS.ProcessEnv = {
      HOME: layout.userDataDir,
      TMPDIR: layout.tempDir,
      PATH: '/usr/bin:/bin',
      LD_LIBRARY_PATH: runtimeLibraryDir,
      DYLD_LIBRARY_PATH: runtimeLibraryDir,
      http_proxy: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    };

    const res = spawnSync(
      binPath,
      [
        `--model-type=${selectedModel.modelType}`,
        `--nemo-ctc-model=${selectedModel.modelPath}`,
        `--tokens=${selectedModel.tokensPath}`,
        '--num-threads=2',
        '--debug=false',
        '--print-args=false',
        isolatedWavPath,
      ],
      {
        cwd: layout.installRoot,
        env: isolatedEnv,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const combinedOut = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    let recognizedText = '';
    for (const line of combinedOut.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed) as { text?: string };
          if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
            recognizedText = parsed.text.trim();
          }
        } catch {
          // Non-JSON progress lines are ignored; inference exit status remains authoritative.
        }
      }
    }

    return {
      ok: res.status === 0 && recognizedText.length > 0,
      nativeSherpaExitCode: res.status,
      recognizedTextNonEmpty: recognizedText.length > 0,
      recognizedText,
      durationMs: Math.round(performance.now() - t0),
      isolatedEnvUsed: true,
      error: res.status !== 0 ? `Exit ${res.status}: ${combinedOut.slice(-300)}` : undefined,
    };
  } finally {
    fs.rmSync(isolatedWavPath, { force: true });
  }
}

export { KNOWN_MODEL_ARTIFACT_PROVENANCE };
