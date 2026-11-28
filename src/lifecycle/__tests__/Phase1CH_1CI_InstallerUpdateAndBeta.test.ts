/**
 * PHASE 1C-H, PHASE 1C-I & PHASE 1C-K INTEGRATED VERIFICATION SUITE
 *
 * Verifies:
 * - Phase 1C-H: Production Packaging, Installation, Update, Rollback & Uninstall
 *   1. Fresh installation into clean target root (`AvapardazProductionInstaller.install`)
 *   2. Re-installation over existing installation preserving `user-data/`
 *   3. Custom directory installation
 *   4. Missing model detection (`MODEL_MISSING`)
 *   5. Corrupt model SHA-256 detection (`MODEL_INVALID`)
 *   6. Insufficient disk space pre-flight guard (`INSUFFICIENT_DISK_SPACE`)
 *   7. Mid-installation interruption & atomic rollback
 *   8. Clean-Environment Execution Test (`runCleanEnvironmentInstalledVerification` outside dev repo with isolated ENV)
 *   9. Atomic Update (`AvapardazPackageUpdateManager.applyUpdate`) + Active Session update deferral + Corrupt update hash rejection + Auto-Rollback on failed health check
 *   10. Standard Uninstall (preserves `user-data/`) vs Complete Uninstall (removes everything with confirmation token)
 * - Phase 1C-I: Controlled Beta Deployment, Privacy-Safe Diagnostics & Feedback (`BETA-01..BETA-20`)
 *   11. Telemetry disabled by default (`telemetryEnabledByDefault: false`, `autoUploadPermitted: false`)
 *   12. Consent-gated local diagnostic bundle export (does not write file without consent, exports sanitized JSON with zero audio/transcript/path/token leakage when consent granted)
 *   13. Local Beta User Feedback submission across Beta Groups A/B/C/D and priorities P0..P4
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AvapardazProductionInstaller,
  evaluateInstalledFirstRunStatus,
  AvapardazPackageUpdateManager,
  AvapardazSafeUninstaller,
  AvapardazBetaDiagnosticsAndFeedbackManager,
  runCleanEnvironmentInstalledVerification,
} from '../ProductionReleaseAndBetaEngine';

const SHERPA_RUNTIME_ROOT = process.env.AVAPARDAZ_TEST_SHERPA_RUNTIME_DIR?.trim() ||
  path.join(os.homedir(), '.avapardaz', 'runtime', 'sherpa-venv');
const KOOCHIK_MODEL_DIR = process.env.AVAPARDAZ_TEST_SHERPA_MODEL_DIR?.trim() ||
  path.join(os.homedir(), '.avapardaz', 'models', 'shahab-koochik-v1.0-sherpa-onnx');
const RIZEH_MODEL_DIR = path.join(os.homedir(), '.avapardaz', 'models', 'sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26');
const SHERPA_MODEL_DIR = fs.existsSync(path.join(KOOCHIK_MODEL_DIR, 'model.onnx')) ? KOOCHIK_MODEL_DIR : RIZEH_MODEL_DIR;
const WAV_1 = path.join(process.cwd(), 'e2e', 'fixtures', 'shahab-fleurs-fa-ir-test.wav');

function createTestSourcePaths(tmpDir: string) {
  const companionBundleFile = path.join(tmpDir, 'mock-avapardaz-companion.mjs');
  fs.writeFileSync(
    companionBundleFile,
    '#!/usr/bin/env node\nconsole.log("AvaPardaz Companion Ready");\n',
    { mode: 0o755 }
  );
  return {
    appDistDir: path.join(process.cwd(), 'dist'),
    companionBundleFile,
    runtimeDir: SHERPA_RUNTIME_ROOT,
    modelDir: SHERPA_MODEL_DIR,
    cepPluginDir: path.join(process.cwd(), 'packages', 'audition-cep-plugin'),
  };
}

describe('Phase 1C-H & 1C-I: Installer, First-Run Health, Clean-Env Execution, Atomic Update/Rollback, Uninstaller & Privacy-Safe Beta Diagnostics', () => {
  it('BETA-01..BETA-10: Executes Fresh Install, First-Run READY Verification, Clean-Environment Native ASR Execution, and User-Data Preservation on Re-install', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-1ch-install-'));
    const installTarget = path.join(tmpRoot, 'AvaPardazInstalled');

    try {
      const sources = createTestSourcePaths(tmpRoot);
      const installResult = AvapardazProductionInstaller.install({
        installRoot: installTarget,
        sources,
      });

      assert.strictEqual(installResult.ok, true);
      assert.strictEqual(installResult.status, 'READY');
      assert.strictEqual(
        fs.existsSync(path.join(installResult.layout.configDir, 'installation-manifest.json')),
        true
      );

      // Verify First-Run Health Check returns READY
      const firstRun = evaluateInstalledFirstRunStatus({ layout: installResult.layout });
      assert.strictEqual(firstRun.status, 'READY');
      assert.strictEqual(firstRun.readyForFirstProject, true);
      assert.strictEqual(firstRun.pluginDetected, true);
      assert.strictEqual(firstRun.companionReady, true);
      assert.strictEqual(firstRun.nativeSherpaReady, true);
      assert.strictEqual(firstRun.modelInstalled, true);
      assert.strictEqual(firstRun.modelIntegrityVerified, true);

      // Write a user project file into user-data/projects to verify preservation
      const userProjectFile = path.join(installResult.layout.userProjectsDir, 'episode-01.json');
      fs.writeFileSync(userProjectFile, JSON.stringify({ title: 'اپیزود اول پادکست فارسی' }), 'utf8');

      // Run Clean-Environment Execution Test outside dev repository with isolated env
      const cleanEnvResult = runCleanEnvironmentInstalledVerification({
        layout: installResult.layout,
        sampleWavPath: WAV_1,
      });
      assert.strictEqual(cleanEnvResult.ok, true);
      assert.strictEqual(cleanEnvResult.nativeSherpaExitCode, 0);
      assert.strictEqual(cleanEnvResult.recognizedTextNonEmpty, true);
      assert.ok(cleanEnvResult.recognizedText.length > 5);

      // Re-install over existing directory -> must preserve user-data/projects/episode-01.json
      const reinstallResult = AvapardazProductionInstaller.install({
        installRoot: installTarget,
        sources,
      });
      assert.strictEqual(reinstallResult.ok, true);
      assert.strictEqual(fs.existsSync(userProjectFile), true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('BETA-11..BETA-15: Detects MODEL_MISSING, MODEL_INVALID, INSUFFICIENT_DISK_SPACE, and rolls back interrupted installations cleanly', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-1ch-errors-'));
    try {
      const sources = createTestSourcePaths(tmpRoot);

      // 1. Insufficient disk space pre-flight guard
      const lowDiskResult = AvapardazProductionInstaller.install({
        installRoot: path.join(tmpRoot, 'low-disk'),
        sources,
        simulatedAvailableDiskBytes: 5 * 1024 * 1024, // 5 MB < 220 MB required
      });
      assert.strictEqual(lowDiskResult.ok, false);
      assert.strictEqual(lowDiskResult.errorCode, 'INSUFFICIENT_DISK_SPACE');

      // 2. Simulated mid-install interruption -> must rollback cleanly
      const interruptedTarget = path.join(tmpRoot, 'interrupted-install');
      const interruptedResult = AvapardazProductionInstaller.install({
        installRoot: interruptedTarget,
        sources,
        failMidInstallAfterStep: 'RUNTIME',
      });
      assert.strictEqual(interruptedResult.ok, false);
      assert.strictEqual(interruptedResult.errorCode, 'INSTALLATION_FAILED_ROLLED_BACK');
      assert.strictEqual(fs.existsSync(path.join(interruptedTarget, 'runtime')), false);

      // 3. Install without model -> First-Run must report MODEL_MISSING
      const noModelTarget = path.join(tmpRoot, 'no-model-install');
      const noModelInstall = AvapardazProductionInstaller.install({
        installRoot: noModelTarget,
        sources,
        skipModelInstall: true,
      });
      assert.strictEqual(noModelInstall.status, 'MODEL_MISSING');

      // 4. Corrupt installed model bytes -> First-Run must report MODEL_INVALID
      const corruptModelTarget = path.join(tmpRoot, 'corrupt-model-install');
      const validInstall = AvapardazProductionInstaller.install({
        installRoot: corruptModelTarget,
        sources,
      });
      const installedManifest = JSON.parse(
        fs.readFileSync(path.join(validInstall.layout.configDir, 'installation-manifest.json'), 'utf8'),
      ) as { modelId?: string };
      const selectedModelDirectory = installedManifest.modelId === 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx'
        ? validInstall.layout.shahabKoochikModelDir
        : validInstall.layout.shenavaModelDir;
      const tokensPath = path.join(selectedModelDirectory, 'tokens.txt');
      fs.writeFileSync(tokensPath, 'CORRUPTED_TOKENS_CONTENT', 'utf8');
      const invalidStatus = evaluateInstalledFirstRunStatus({ layout: validInstall.layout });
      assert.strictEqual(invalidStatus.status, 'MODEL_INVALID');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('BETA-16..BETA-18: Executes Atomic Update, Active Session Deferral, Corrupt Hash Rejection, Auto-Rollback on Health Failure, and Standard vs Complete Uninstall', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-1ch-update-'));
    const installTarget = path.join(tmpRoot, 'InstalledApp');

    try {
      const sources = createTestSourcePaths(tmpRoot);
      const installed = AvapardazProductionInstaller.install({
        installRoot: installTarget,
        sources,
      });
      assert.strictEqual(installed.ok, true);

      // Create user project in installTarget
      const userProjectPath = path.join(installed.layout.userProjectsDir, 'project-v1.json');
      fs.writeFileSync(userProjectPath, JSON.stringify({ name: 'پروژه تدوین پادکست' }), 'utf8');

      // Prepare an updated Companion package directory
      const updateSourceDir = path.join(tmpRoot, 'companion-update-v1.1.0');
      fs.mkdirSync(updateSourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(updateSourceDir, 'avapardaz-companion.mjs'),
        '#!/usr/bin/env node\nconsole.log("AvaPardaz Companion v1.1.0");\n',
        { mode: 0o755 }
      );
      const pkgHashInfo = AvapardazPackageUpdateManager.computePackagePathSha256(updateSourceDir);

      const updater = new AvapardazPackageUpdateManager(installed.layout);

      // Recover a process-crash simulation after the new directory became visible but before commit.
      const recoveryBackupId = 'bkp_companion_1.0.0_recovery';
      const recoveryBackupDir = path.join(installed.layout.backupsDir, recoveryBackupId);
      const originalCompanionEntry = fs.readFileSync(
        path.join(installed.layout.companionDir, 'avapardaz-companion.mjs'),
        'utf8',
      );
      fs.mkdirSync(path.join(recoveryBackupDir, 'component'), { recursive: true });
      fs.cpSync(installed.layout.companionDir, path.join(recoveryBackupDir, 'component'), { recursive: true });
      fs.copyFileSync(
        path.join(installed.layout.configDir, 'installation-manifest.json'),
        path.join(recoveryBackupDir, 'manifest.backup.json'),
      );
      fs.mkdirSync(path.join(recoveryBackupDir, 'activation-journal', 'NEW_MOVED'), { recursive: true });
      fs.writeFileSync(
        path.join(installed.layout.companionDir, 'avapardaz-companion.mjs'),
        'INTERRUPTED_NEW_VERSION',
        'utf8',
      );
      new AvapardazPackageUpdateManager(installed.layout);
      assert.strictEqual(
        fs.readFileSync(path.join(installed.layout.companionDir, 'avapardaz-companion.mjs'), 'utf8'),
        originalCompanionEntry,
      );
      assert.strictEqual(fs.existsSync(path.join(recoveryBackupDir, 'activation-journal')), false);

      // Recover the earlier crash window where the old target was moved aside but the new target was not renamed in.
      const oldMovedBackupId = 'bkp_companion_1.0.0_old_moved_recovery';
      const oldMovedBackupDir = path.join(installed.layout.backupsDir, oldMovedBackupId);
      fs.mkdirSync(path.join(oldMovedBackupDir, 'component'), { recursive: true });
      fs.cpSync(installed.layout.companionDir, path.join(oldMovedBackupDir, 'component'), { recursive: true });
      fs.copyFileSync(
        path.join(installed.layout.configDir, 'installation-manifest.json'),
        path.join(oldMovedBackupDir, 'manifest.backup.json'),
      );
      fs.mkdirSync(path.join(oldMovedBackupDir, 'activation-journal', 'OLD_MOVED'), { recursive: true });
      const displacedCompanion = path.join(
        path.dirname(installed.layout.companionDir),
        '.' + path.basename(installed.layout.companionDir) + '.' + oldMovedBackupId + '.displaced',
      );
      fs.renameSync(installed.layout.companionDir, displacedCompanion);
      new AvapardazPackageUpdateManager(installed.layout);
      assert.strictEqual(fs.existsSync(installed.layout.companionDir), true);
      assert.strictEqual(
        fs.readFileSync(path.join(installed.layout.companionDir, 'avapardaz-companion.mjs'), 'utf8'),
        originalCompanionEntry,
      );
      assert.strictEqual(fs.existsSync(displacedCompanion), false);

      // 1. Defer update when an active editing session is running
      const deferred = updater.applyUpdate({
        pkg: {
          updateId: 'upd-1',
          component: 'COMPANION',
          targetVersion: '1.1.0',
          minCompatibleIpcProtocol: '1.0.0',
          sourcePath: updateSourceDir,
          expectedSha256: pkgHashInfo.sha256,
          sizeBytes: pkgHashInfo.totalBytes,
          releaseNotesFa: 'بهبود پایداری Companion',
        },
        hasActiveProcessingSession: true,
      });
      assert.strictEqual(deferred.ok, false);
      assert.strictEqual(deferred.deferredDueToActiveSession, true);

      // 2. Reject update when expected Package Hash mismatches
      const badHash = updater.applyUpdate({
        pkg: {
          updateId: 'upd-bad-hash',
          component: 'COMPANION',
          targetVersion: '1.1.0',
          minCompatibleIpcProtocol: '1.0.0',
          sourcePath: updateSourceDir,
          expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
          sizeBytes: pkgHashInfo.totalBytes,
          releaseNotesFa: 'بسته دستکاری‌شده',
        },
      });
      assert.strictEqual(badHash.ok, false);
      assert.strictEqual(badHash.errorCode, 'UPDATE_HASH_MISMATCH');

      // 3. Simulate failed post-update health check -> must automatically rollback to 1.0.0
      const autoRolledBack = updater.applyUpdate({
        pkg: {
          updateId: 'upd-fail-health',
          component: 'COMPANION',
          targetVersion: '1.1.0',
          minCompatibleIpcProtocol: '1.0.0',
          sourcePath: updateSourceDir,
          expectedSha256: pkgHashInfo.sha256,
          sizeBytes: pkgHashInfo.totalBytes,
          releaseNotesFa: 'شکست تست سلامت',
        },
        customPostUpdateHealthCheck: () => ({ ok: false, reason: 'SIMULATED_HEALTH_FAILURE' }),
      });
      assert.strictEqual(autoRolledBack.ok, false);
      assert.strictEqual(autoRolledBack.rolledBack, true);
      assert.strictEqual(autoRolledBack.activeVersion, '1.0.0');

      // 4. Successful update to 1.1.0
      const updated = updater.applyUpdate({
        pkg: {
          updateId: 'upd-success',
          component: 'COMPANION',
          targetVersion: '1.1.0',
          minCompatibleIpcProtocol: '1.0.0',
          sourcePath: updateSourceDir,
          expectedSha256: pkgHashInfo.sha256,
          sizeBytes: pkgHashInfo.totalBytes,
          releaseNotesFa: 'انتشار سالم ۱.۱.۰',
        },
      });
      assert.strictEqual(updated.ok, true);
      assert.strictEqual(updated.activeVersion, '1.1.0');
      assert.strictEqual(fs.existsSync(userProjectPath), true);

      // 5. Explicit manual rollback to 1.0.0
      const manualRollback = updater.rollbackToBackup(updated.backupId!);
      assert.strictEqual(manualRollback.ok, true);
      assert.strictEqual(manualRollback.restoredVersion, '1.0.0');
      assert.strictEqual(fs.existsSync(userProjectPath), true);

      // 6. Standard Uninstall (preserves user-data/)
      const stdUninstall = AvapardazSafeUninstaller.uninstall({
        layout: installed.layout,
        mode: 'STANDARD',
      });
      assert.strictEqual(stdUninstall.ok, true);
      assert.strictEqual(stdUninstall.userProjectsPreserved, true);
      assert.strictEqual(fs.existsSync(userProjectPath), true);
      assert.strictEqual(fs.existsSync(installed.layout.runtimeDir), false);

      // 7. Complete Uninstall (removes everything including user-data/ when confirmDeleteUserData: true)
      const fullUninstall = AvapardazSafeUninstaller.uninstall({
        layout: installed.layout,
        mode: 'COMPLETE',
        confirmDeleteUserData: true,
      });
      assert.strictEqual(fullUninstall.ok, true);
      assert.strictEqual(fullUninstall.userProjectsPreserved, false);
      assert.strictEqual(fs.existsSync(userProjectPath), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('BETA-19..BETA-20: Verifies Privacy-Safe Diagnostics (Zero Audio/Transcript/Path/Token Leakage, Consent Gate) and Beta User Feedback System', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-1ci-diag-'));
    try {
      const sources = createTestSourcePaths(tmpRoot);
      const installed = AvapardazProductionInstaller.install({
        installRoot: tmpRoot,
        sources,
      });

      const betaManager = new AvapardazBetaDiagnosticsAndFeedbackManager(installed.layout);

      // 1. Without user consent, diagnostic report is not exported to disk
      const noConsent = betaManager.exportPrivacySafeDiagnostics({
        userConsentGranted: false,
        processingDurationMs: 1200,
        peakRssMb: 184.2,
      });
      assert.strictEqual(noConsent.exported, false);
      assert.strictEqual(noConsent.filePath, null);
      assert.strictEqual(noConsent.report.telemetryEnabledByDefault, false);
      assert.strictEqual(noConsent.report.autoUploadPermitted, false);

      // 2. With explicit user consent, exports sanitized diagnostic report stripping any sensitive keys/paths/transcripts
      const withConsent = betaManager.exportPrivacySafeDiagnostics({
        userConsentGranted: true,
        processingDurationMs: 2450,
        peakRssMb: 192.5,
        errorCode: 'ERR_COMPANION_TIMEOUT',
        rawDiagnosticContext: {
          rawTranscriptText: 'متن محرمانه پادکست کاربر که نباید هرگز در لاگ ذخیره شود',
          audioFilePath: '/Users/reza/PrivateAudio/secret_episode.wav',
          authToken: 'Bearer eyJhbGciOiJIUzI1NiJ9',
          pipelineStage: 'CANONICAL_READY',
          chunkCount: 18,
        },
      });

      assert.strictEqual(withConsent.exported, true);
      assert.notStrictEqual(withConsent.filePath, null);
      assert.strictEqual(fs.existsSync(withConsent.filePath!), true);

      const exportedJson = fs.readFileSync(withConsent.filePath!, 'utf8');
      assert.ok(!exportedJson.includes('متن محرمانه پادکست'));
      assert.ok(!exportedJson.includes('/Users/reza/PrivateAudio'));
      assert.ok(!exportedJson.includes('eyJhbGciOiJIUzI1NiJ9'));
      assert.strictEqual(withConsent.report.sanitizedContext.pipelineStage, 'CANONICAL_READY');
      assert.strictEqual(withConsent.report.sanitizedContext.chunkCount, 18);

      // 3. Submit & list structured Beta User Feedback
      const fb = betaManager.submitUserFeedback({
        betaGroup: 'GROUP_C_PERSIAN_SPEECH_WORKLOADS',
        category: 'PERSIAN_ASR_QUALITY',
        uxTier: 'HIGH_PRIORITY_UX',
        priority: 'P2',
        component: 'EDITING_ENGINE',
        reproductionSteps: '۱. بارگذاری فایل ۴۵ دقیقه‌ای ۲. اجرای تحلیل تدوین ۳. بررسی پیش‌نمایش',
        expectedBehavior: 'حذف تپق اممم بدون آسیب به تنفس طبیعی',
        actualBehavior: 'تپق‌ها با دقت بالا شناسایی و در پیش‌نمایش حذف شدند',
        userImpact: 'صرفه‌جویی ۴۰ دقیقه‌ای در تدوین هر اپیزود پادکست',
      });

      assert.ok(fb.feedbackId.startsWith('FB-'));
      const allFeedback = betaManager.listFeedbackRecords();
      assert.strictEqual(allFeedback.length, 1);
      assert.strictEqual(allFeedback[0].betaGroup, 'GROUP_C_PERSIAN_SPEECH_WORKLOADS');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
