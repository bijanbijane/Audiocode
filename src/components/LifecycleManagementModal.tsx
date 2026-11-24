import React, { useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  Link2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import { AccessibleModal } from './AccessibleModal';
import { CompanionConnectionDiagnostic } from './CompanionConnectionDiagnostic';
import {
  AppUpdateAndShellManager,
  AVAPARDAZ_VERSION_CONTRACT,
  deriveModelIdentityFromFileName,
  installShenavaRizehInBrowser,
  LocalModelLifecycleManager,
  MAX_SAFE_MODEL_FILE_BYTES,
  MODEL_CHUNK_SIZE_BYTES,
  OpfsModelChunkStorage,
  PersistedProjectEnvelope,
  ProjectBackupAndRestore,
  ShellOfflineVerificationReport,
  StorageAndDiagnosticsManager,
  StorageBreakdownReport,
} from '../lifecycle';
import { sha256Blob } from '../utils/StreamingSha256';
import {
  createDefaultSubsystemHealthRegistry,
  getSharedDiagnosticLogger,
  SystemHealthSnapshot,
} from '../reliability';
import { getSharedMemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { LongSessionMonitor } from '../performance';
import { StudioWorkflowState } from '../workflow/StudioWorkflowController';
import {
  loadModelCtcVocabulary,
  saveModelCtcVocabulary,
} from '../workflow/UnifiedLocalAsrWorkflowService';

export type LifecycleModalTab =
  | 'model'
  | 'companion'
  | 'offline'
  | 'health'
  | 'backup'
  | 'storage'
  | 'diagnostics';

interface LifecycleManagementModalProps {
  isOpen: boolean;
  initialTab?: LifecycleModalTab;
  onClose: () => void;
  workflowState: StudioWorkflowState;
  modelManager: LocalModelLifecycleManager;
  onModelStateChanged: () => void;
  companionEndpoint?: string;
  onChangeCompanionEndpoint?: (nextEndpoint: string) => void;
}

export const LifecycleManagementModal: React.FC<LifecycleManagementModalProps> = ({
  isOpen,
  initialTab = 'health',
  onClose,
  workflowState,
  modelManager,
  onModelStateChanged,
  companionEndpoint = 'http://127.0.0.1:4771',
  onChangeCompanionEndpoint,
}) => {
  const isFa = workflowState.locale === 'fa';
  const [activeTab, setActiveTab] = useState<LifecycleModalTab>(initialTab);
  const [healthReport, setHealthReport] = useState<SystemHealthSnapshot | null>(null);
  const [runningHealth, setRunningHealth] = useState(false);
  const [offlineReport, setOfflineReport] = useState<ShellOfflineVerificationReport | null>(null);
  const [storageReport, setStorageReport] = useState<StorageBreakdownReport | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [backupMode, setBackupMode] = useState<'METADATA_ONLY' | 'COMPLETE_PACKAGE'>('METADATA_ONLY');
  const [diagJsonPreview, setDiagJsonPreview] = useState<string>('');
  const [isInstallingModel, setIsInstallingModel] = useState(false);
  const [installProgressPct, setInstallProgressPct] = useState<number | null>(null);
  const [modelTick, setModelTick] = useState(0);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    if (!modelManager.getSnapshot().initialized) {
      modelManager
        .initialize()
        .then(() => {
          if (active) {
            setModelTick((t) => t + 1);
            onModelStateChanged();
          }
        })
        .catch(() => {
          if (active) setModelTick((t) => t + 1);
        });
    }
    return () => {
      active = false;
    };
  }, [isOpen, modelManager, onModelStateChanged]);

  if (!isOpen) return null;

  // Read snapshot after any modelTick update
  void modelTick;
  const modelSnap = modelManager.getSnapshot();
  const activeCtcVocab = modelSnap.activeModel
    ? loadModelCtcVocabulary(modelSnap.activeModel.modelId, modelSnap.activeModel.version)
    : undefined;

  const handleAutoInstallBrowserShenavaModel = async () => {
    if (isInstallingModel) return;
    setIsInstallingModel(true);
    setInstallProgressPct(0);
    setStatusMessage(
      isFa
        ? 'در حال دریافت، نصب تکه‌ای در OPFS و راستی‌آزمایی SHA-256 مدل فارسی «شناوا ریزه» و واژگان tokens.txt...'
        : 'Downloading, streaming into OPFS, and SHA-256 verifying Persian Shenava-Rizeh ONNX + tokens.txt...',
    );

    try {
      const res = await installShenavaRizehInBrowser({
        modelManager,
        onProgress: (pct) => {
          setInstallProgressPct(pct);
        },
      });

      setModelTick((t) => t + 1);
      if (res.ok) {
        setStatusMessage(
          isFa
            ? `مدل فارسی «شناوا ریزه» (${res.modelId}) و فایل واژگان tokens.txt با ${res.tokenCount ?? 0} توکن در OPFS مرورگر نصب و با SHA-256 تأیید شد. اکنون بدون نیاز به Companion یا اینترنت آماده رونویسی است.`
            : `Persian model "${res.modelId}" and tokens.txt (${res.tokenCount ?? 0} tokens) installed in browser OPFS and SHA-256 verified.`,
        );
        onModelStateChanged();
      } else {
        setStatusMessage(
          res.errorMessageFa ??
            res.errorMessageEn ??
            (isFa ? 'نصب خودکار مدل فارسی ناموفق بود.' : 'Automatic browser model installation failed.'),
        );
        onModelStateChanged();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در نصب خودکار مدل فارسی: ${msg}` : `Failed to install Persian browser model: ${msg}`,
      );
      setModelTick((t) => t + 1);
    } finally {
      setIsInstallingModel(false);
      setInstallProgressPct(null);
    }
  };

  const handleImportCtcTokensTxt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.currentTarget;
    const file = inputEl.files?.[0];
    if (!file) return;
    try {
      const active = modelManager.getSnapshot().activeModel;
      if (!active) {
        setStatusMessage(
          isFa
            ? 'ابتدا فایل مدل .onnx را نصب کنید، سپس فایل واژگان tokens.txt را وارد نمایید.'
            : 'Install the .onnx model file first before attaching tokens.txt.',
        );
        return;
      }
      const txt = await file.text();
      const res = saveModelCtcVocabulary(active.modelId, active.version, txt);
      if (!res.ok) {
        setStatusMessage(res.error ?? 'Invalid tokens.txt file.');
        return;
      }
      setStatusMessage(
        isFa
          ? `فایل واژگان tokens.txt با ${res.tokenCount} توکن برای مدل ${active.modelId} ذخیره شد.`
          : `Saved CTC vocabulary (${res.tokenCount} tokens) for ${active.modelId}.`,
      );
      setModelTick((t) => t + 1);
    } finally {
      inputEl.value = '';
    }
  };

  const handleImportLocalOnnxModel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.currentTarget;
    const file = inputEl.files?.[0];
    if (!file) return;

    setIsInstallingModel(true);
    setInstallProgressPct(0);
    setStatusMessage(null);

    try {
      if (!/\.onnx$/i.test(file.name)) {
        setStatusMessage(
          isFa
            ? `فایل «${file.name}» پسوند معتبر .onnx ندارد.`
            : `File "${file.name}" must have a .onnx extension.`,
        );
        return;
      }

      if (file.size <= 0) {
        setStatusMessage(
          isFa
            ? 'فایل مدل انتخاب‌شده خالی است (۰ بایت) و نصب نشد.'
            : 'Selected ONNX model file is empty (0 bytes) and was rejected.',
        );
        return;
      }

      if (file.size > MAX_SAFE_MODEL_FILE_BYTES) {
        setStatusMessage(
          isFa
            ? 'حجم فایل مدل از سقف مجاز ۲ گیگابایت بیشتر است.'
            : 'Selected model file exceeds the 2 GiB maximum size limit.',
        );
        return;
      }

      const identity = deriveModelIdentityFromFileName(file.name);

      // Strictly streaming SHA-256 over bounded <= 1 MiB slices (NEVER file.arrayBuffer())
      const sha = await sha256Blob(file, {
        chunkSizeBytes: MODEL_CHUNK_SIZE_BYTES,
      });

      const res = await modelManager.installOrUpdateFromStream({
        manifest: {
          modelId: identity.modelId,
          modelVersion: identity.modelVersion,
          architecture: 'FASTCONFORMER_CTC',
          fileName: identity.safeFileName,
          expectedByteLength: file.size,
          expectedSha256Hex: sha,
        },
        stream: {
          supportsRangeResume: false,
          async fetchRange(start: number, end: number) {
            const sliceBuffer = await file.slice(start, end).arrayBuffer();
            return new Uint8Array(sliceBuffer);
          },
        },
        chunkSizeBytes: MODEL_CHUNK_SIZE_BYTES,
        sourceOrigin: 'local-user-file',
        license: 'User-supplied local ONNX weights',
        onProgress: (pct) => {
          setInstallProgressPct(pct);
        },
      });

      setModelTick((t) => t + 1);
      if (res.ok) {
        setStatusMessage(
          isFa
            ? `مدل محلی «${file.name}» به‌صورت تکه‌ای در OPFS ذخیره و با SHA-256 تأیید شد (وضعیت: MODEL_AVAILABLE — آماده بارگذاری در موتور ONNX).`
            : `Local model "${file.name}" persisted to OPFS and SHA-256 verified (state: MODEL_AVAILABLE — runtime session not yet initialized).`,
        );
        onModelStateChanged();
      } else {
        setStatusMessage(
          res.snapshot.lastError ??
            (isFa ? 'نصب مدل محلی ناموفق بود.' : 'Local model installation failed.'),
        );
        onModelStateChanged();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در نصب فایل مدل محلی: ${msg}` : `Failed to install local model: ${msg}`,
      );
      setModelTick((t) => t + 1);
    } finally {
      inputEl.value = '';
      setIsInstallingModel(false);
      setInstallProgressPct(null);
    }
  };

  const handleVerifyModelOffline = async () => {
    try {
      const res = await modelManager.verifyInstalledActiveModelOffline();
      setModelTick((t) => t + 1);
      if (res.ok) {
        setStatusMessage(
          isFa
            ? `راستی‌آزمایی تکه‌به‌تکه OPFS و SHA-256 مدل با موفقیت انجام شد (${res.state}).`
            : `Incremental OPFS chunk & SHA-256 offline verification passed (${res.state}).`,
        );
      } else {
        setStatusMessage(
          res.error ??
            (isFa ? 'تأیید اصالت مدل محلی ناموفق بود.' : 'Offline model verification failed.'),
        );
      }
      onModelStateChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در راستی‌آزمایی مدل: ${msg}` : `Offline model verification error: ${msg}`,
      );
    }
  };

  const handleRollbackModel = async () => {
    try {
      const res = await modelManager.rollbackToPreviousVerifiedModel();
      setModelTick((t) => t + 1);
      if (res.ok && res.snapshot.activeModel) {
        setStatusMessage(
          isFa
            ? `بازگشت ایمن به مدل قبلی تأییدشده (${res.snapshot.activeModel.modelId} v${res.snapshot.activeModel.version}) پس از بررسی کامل SHA-256 انجام شد.`
            : `Rolled back cleanly to previous verified model (${res.snapshot.activeModel.modelId} v${res.snapshot.activeModel.version}) after full SHA-256 verification.`,
        );
        onModelStateChanged();
      } else {
        setStatusMessage(
          res.snapshot.lastError ??
            (isFa ? 'بازگشت به مدل قبلی ممکن نبود.' : 'Rollback to previous verified model failed.'),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در بازگشت به مدل قبلی: ${msg}` : `Rollback error: ${msg}`,
      );
    }
  };

  const handleRemoveModel = async () => {
    try {
      await modelManager.removeActiveModel();
      setModelTick((t) => t + 1);
      setStatusMessage(
        isFa
          ? 'مدل محلی از OPFS حذف شد. تمام پروژه‌ها و فایل‌های صوتی کاربر دست‌نخورده باقی ماندند.'
          : 'Local model removed from OPFS. All user projects and audio files remain untouched.',
      );
      onModelStateChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در حذف مدل محلی: ${msg}` : `Failed to remove local model: ${msg}`,
      );
    }
  };

  const handleCheckOfflineReadiness = async () => {
    try {
      const swReg =
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        Boolean(navigator.serviceWorker.controller);
      const critical = ['/', '/index.html', '/manifest.webmanifest'];
      const rep = await AppUpdateAndShellManager.verifyActualOfflineReadiness({
        serviceWorkerRegistered: swReg,
        criticalAssets: critical,
        hasCachedAsset: async (assetPath) => {
          if (typeof caches === 'undefined') return false;
          const m = await caches.match(assetPath);
          return Boolean(m);
        },
        wasmAssetsCached: typeof WebAssembly === 'object',
        localModelInstalled: Boolean(modelSnap.activeModel),
      });
      setOfflineReport(rep);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در بررسی آمادگی آفلاین: ${msg}` : `Offline readiness check failed: ${msg}`,
      );
    }
  };

  const handleRunHealthChecks = async () => {
    setRunningHealth(true);
    try {
      const registry = createDefaultSubsystemHealthRegistry({
        memoryBudget: getSharedMemoryBudgetManager(),
        modelManager,
      });
      const rep = await registry.checkAll({ lightweightOnly: false });
      setHealthReport(rep);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در اجرای بررسی سلامت زیرسیستم‌ها: ${msg}` : `Subsystem health check failed: ${msg}`,
      );
    } finally {
      setRunningHealth(false);
    }
  };

  const handleInspectStorage = async () => {
    try {
      const rep = await StorageAndDiagnosticsManager.inspectStorage({
        installedModelBytes: modelSnap.activeModel?.fileSizeBytes ?? 0,
        projectMetadataBytes: JSON.stringify({
          projectId: workflowState.projectId,
          versions: workflowState.transcriptVersions.length,
        }).length,
        tempRenderBytes: 0,
        partialModelBytes: modelSnap.partialDownload?.receivedBytes ?? 0,
        recoverableCheckpointCount: workflowState.recoverableCheckpoint ? 1 : 0,
      });
      setStorageReport(rep);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در بازرسی فضای ذخیره‌سازی: ${msg}` : `Storage inspection failed: ${msg}`,
      );
    }
  };

  const handleSafeCleanup = async () => {
    try {
      const cleanedPartial = await modelManager.cleanupInvalidPartialDownloads();
      setModelTick((t) => t + 1);
      setStatusMessage(
        isFa
          ? `پاک‌سازی ایمن OPFS انجام شد (${cleanedPartial} دایرکتوری موقت یا یتیم حذف شد؛ مدل فعال، مدل قبلی و پروژه‌های کاربر لمس نشدند).`
          : `Safe OPFS cleanup completed (${cleanedPartial} temporary/orphan artifact(s) removed; active/previous models and user projects untouched).`,
      );
      await handleInspectStorage();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در پاک‌سازی ایمن: ${msg}` : `Safe cleanup failed: ${msg}`,
      );
    }
  };

  const handleExportProjectBackup = async () => {
    try {
      const nowMs = Date.now();
      const envelope: PersistedProjectEnvelope = {
        schemaVersion: AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion,
        projectSchemaVersion: AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion,
        appVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
        projectId: workflowState.projectId,
        projectName: workflowState.projectName,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        sourceAudioRef: workflowState.sourceAudio
          ? {
              sourceAudioId: workflowState.sourceAudio.sourceAudioId,
              sourceAudioHash: workflowState.sourceAudio.sourceAudioHash,
              fileName: workflowState.sourceAudio.fileName,
              sampleRate: workflowState.sourceAudio.sampleRate,
            }
          : null,
        transcriptVersions: workflowState.transcriptVersions.map((v) => ({ ...v })),
        edlSnapshot: workflowState.edlSnapshot,
      };

      const res = await ProjectBackupAndRestore.createBackup({
        project: envelope,
        mode: backupMode,
      });
      if (!res.ok || !res.packageJson || !res.fileName) {
        setStatusMessage(res.error ?? 'Backup creation failed.');
        return;
      }
      const blob = new Blob([res.packageJson], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      setStatusMessage(
        isFa
          ? `بسته پشتیبان (${backupMode}) با کد اصالت SHA-256 آماده و ذخیره شد.`
          : `Project backup (${backupMode}) packaged with SHA-256 manifest.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(
        isFa ? `خطا در ساخت بسته پشتیبان: ${msg}` : `Backup export failed: ${msg}`,
      );
    }
  };

  const handleRefreshDiagnostics = () => {
    const logger = getSharedDiagnosticLogger();
    const perfMonitor = new LongSessionMonitor();
    const memSnap = getSharedMemoryBudgetManager().getSnapshot();
    const bundle = {
      localOnlyNotice: 'Privacy-safe local diagnostics only. Zero audio/transcript content included.',
      appVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
      modelRepository: {
        storageBackend: modelSnap.storageBackend,
        state: modelSnap.state,
        runtimeReady: modelSnap.runtimeReady,
        activeModelId: modelSnap.activeModel?.modelId ?? null,
        activeModelVersion: modelSnap.activeModel?.version ?? null,
      },
      memory: {
        accountedBytes: memSnap.accountedBytes,
        highWaterMarkBytes: memSnap.highWaterMarkBytes,
        hardLimitBytes: memSnap.hardLimitBytes,
        pressureLevel: memSnap.pressureLevel,
      },
      longSessionMetrics: perfMonitor.getSnapshot(),
      diagnosticEvents: logger.exportSanitizedBundle(),
    };
    setDiagJsonPreview(JSON.stringify(bundle, null, 2));
  };

  const tabs: { id: LifecycleModalTab; label: string; icon: React.ReactNode }[] = [
    { id: 'model', label: isFa ? 'مدل محلی ASR' : 'Local ASR Model', icon: <Cpu className="w-3.5 h-3.5" /> },
    { id: 'companion', label: isFa ? 'اتصال Companion' : 'Companion Bridge', icon: <Link2 className="w-3.5 h-3.5" /> },
    { id: 'offline', label: isFa ? 'آفلاین و نسخه' : 'Offline & Version', icon: <WifiOff className="w-3.5 h-3.5" /> },
    { id: 'health', label: isFa ? 'سلامت ۱۴ زیرسیستم' : '14-Subsystem Health', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'backup', label: isFa ? 'پشتیبان و بازیابی' : 'Backup & Restore', icon: <Archive className="w-3.5 h-3.5" /> },
    { id: 'storage', label: isFa ? 'فضای ذخیره‌سازی' : 'Storage & Cleanup', icon: <HardDrive className="w-3.5 h-3.5" /> },
    { id: 'diagnostics', label: isFa ? 'عیب‌یابی و کارایی' : 'Diagnostics & Perf', icon: <ShieldAlert className="w-3.5 h-3.5" /> },
  ];

  const describeModelState = () => {
    if (!modelSnap.initialized) {
      return isFa ? 'در حال بازیابی و راستی‌آزمایی مخزن OPFS...' : 'Initializing OPFS model repository...';
    }
    switch (modelSnap.state) {
      case 'MODEL_READY':
        return isFa
          ? 'مدل در OPFS با SHA-256 تأیید شده و جلسه استنتاج ONNX آماده است.'
          : 'Model verified in OPFS and ONNX inference runtime is initialized.';
      case 'MODEL_AVAILABLE':
        return isFa
          ? 'مدل به‌صورت ماندگار در OPFS ذخیره و با SHA-256 تأیید شده است (جلسه استنتاج ONNX هنوز مقداردهی نشده است).'
          : 'Model durably stored in OPFS and SHA-256 verified (ONNX inference runtime not yet initialized).';
      case 'INTEGRITY_FAILURE':
        return isFa
          ? 'خطای اصالت (SHA-256) یا خرابی قطعات OPFS شناسایی شد؛ مدل فعال نشد.'
          : 'OPFS integrity/SHA-256 failure detected; model was not activated.';
      case 'MODEL_UNAVAILABLE':
        return isFa
          ? 'فضای ذخیره‌سازی OPFS در دسترس نیست یا سهمیه کافی وجود ندارد.'
          : 'OPFS model repository unavailable or storage quota exceeded.';
      default:
        return isFa
          ? 'هیچ مدل وزن محلی (.onnx) نصب نشده است. آواپرداز هرگز از سرویس ابری پنهان یا خروجی ساختگی استفاده نمی‌کند.'
          : 'No local ONNX weights are installed. Avapardaz never falls back to hidden cloud endpoints or fake inference.';
    }
  };

  return (
    <AccessibleModal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy="lifecycle-modal-title"
      dir={isFa ? 'rtl' : 'ltr'}
      dataTestId="lifecycle-management-modal"
      panelClassName="w-full max-w-4xl"
    >
      <div className="w-full max-h-[88vh] flex flex-col rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text)] shadow-[var(--avp-shadow-md)] overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)] flex items-center justify-between shrink-0">
          <div>
            <h2 id="lifecycle-modal-title" className="text-sm font-bold">
              {isFa
                ? 'مدیریت مدل محلی، اتصال Companion و سلامت زیرسیستم‌ها'
                : 'Local Models, Companion Bridge & Subsystem Health'}
            </h2>
            <p className="text-xs text-[var(--avp-text-muted)] mt-0.5 font-mono" dir="ltr">
              v{AVAPARDAZ_VERSION_CONTRACT.appVersion} · Schema v{AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion} · OPFS · Local-First
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isFa ? 'بستن' : 'Close'}
            className="avp-btn-icon avp-btn-icon-sm"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation tabs */}
        <div className="px-5 pt-2 border-b border-[var(--avp-border)] flex items-center gap-4 overflow-x-auto shrink-0 bg-[var(--avp-surface)]">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`lifecycle-tab-${t.id}`}
              onClick={() => setActiveTab(t.id)}
              className={`pb-2.5 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap border-b-2 cursor-pointer transition-colors ${
                activeTab === t.id
                  ? 'border-[var(--avp-accent)] text-[var(--avp-accent-text)] font-semibold'
                  : 'border-transparent text-[var(--avp-text-muted)] hover:text-[var(--avp-text)]'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-4 text-xs">
          {statusMessage && (
            <div
              data-testid="lifecycle-status-message"
              className="rounded-lg border border-[var(--avp-accent)]/35 bg-[var(--avp-accent-soft)] px-3 py-2 text-[var(--avp-accent-text)] font-medium"
            >
              {statusMessage}
            </div>
          )}

          {activeTab === 'model' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] p-3.5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold">
                    {isFa ? 'وضعیت فعلی مدل محلی:' : 'Current Local Model State:'}{' '}
                    <span
                      data-testid="model-lifecycle-state"
                      className="font-mono text-[var(--avp-accent-text)]"
                    >
                      {modelSnap.state}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-[var(--avp-text-muted)]" dir="ltr">
                    Storage: {modelSnap.storageBackend} · Runtime Ready: {String(modelSnap.runtimeReady)}
                  </div>
                </div>

                <p className="text-[var(--avp-text-secondary)]">{describeModelState()}</p>

                {modelSnap.activeModel && (
                  <div
                    data-testid="model-active-info"
                    className="font-mono text-[11px] text-[var(--avp-text-secondary)] space-y-0.5 pt-2 border-t border-[var(--avp-border-subtle)]"
                    dir="ltr"
                  >
                    <div>
                      Active Model: {modelSnap.activeModel.modelId} (v{modelSnap.activeModel.version}) ·{' '}
                      {modelSnap.activeModel.architecture}
                    </div>
                    <div>
                      File: {modelSnap.activeModel.fileName} · Size:{' '}
                      {(modelSnap.activeModel.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB (
                      {modelSnap.activeModel.fileSizeBytes} B)
                    </div>
                    <div>OPFS Dir: ai-models/{modelSnap.activeModel.storageDirectory}</div>
                    <div>SHA-256: {modelSnap.activeModel.verifiedSha256Hex}</div>
                    <div>
                      CTC Vocabulary (tokens.txt):{' '}
                      {activeCtcVocab && activeCtcVocab.length > 0 ? (
                        <span className="text-[var(--avp-success-text)]">
                          Loaded ({activeCtcVocab.length} tokens)
                        </span>
                      ) : (
                        <span className="text-[var(--avp-warning-text)]">
                          Missing — import tokens.txt or click auto-install
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {modelSnap.previousVerifiedModel && (
                  <div
                    data-testid="model-previous-info"
                    className="font-mono text-[11px] text-[var(--avp-text-muted)] space-y-0.5 pt-2 border-t border-[var(--avp-border-subtle)]"
                    dir="ltr"
                  >
                    <div>
                      Previous Verified Model (Rollback Ready): {modelSnap.previousVerifiedModel.modelId} (v
                      {modelSnap.previousVerifiedModel.version})
                    </div>
                    <div>Previous SHA-256: {modelSnap.previousVerifiedModel.verifiedSha256Hex}</div>
                  </div>
                )}

                {isInstallingModel && installProgressPct !== null && (
                  <div className="pt-1 font-mono text-[11px] text-[var(--avp-accent-text)]" dir="ltr">
                    Streaming chunks to OPFS & verifying SHA-256... {installProgressPct}%
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="btn-install-browser-persian-model"
                  disabled={isInstallingModel}
                  onClick={handleAutoInstallBrowserShenavaModel}
                  className="avp-btn avp-btn-primary"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>
                    {isInstallingModel
                      ? isFa
                        ? `در حال نصب خودکار مدل فارسی (${installProgressPct ?? 0}٪)...`
                        : `Installing Persian model (${installProgressPct ?? 0}%)...`
                      : isFa
                        ? 'نصب خودکار مدل فارسی مرورگر (شناوا ریزه · ۳۶ مگابایت · آفلاین)'
                        : 'Auto-Install Browser Persian Model (Shenava-Rizeh · 36 MB)'}
                  </span>
                </button>

                <label className="avp-btn avp-btn-tonal cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>
                    {isInstallingModel
                      ? isFa
                        ? 'در حال نصب تکه‌ای...'
                        : 'Streaming to OPFS...'
                      : isFa
                        ? 'وارد کردن فایل مدل محلی (.onnx)'
                        : 'Import Local ONNX Model'}
                  </span>
                  <input
                    data-testid="model-onnx-file-input"
                    type="file"
                    accept=".onnx,application/octet-stream"
                    disabled={isInstallingModel}
                    onChange={handleImportLocalOnnxModel}
                    className="hidden"
                  />
                </label>

                <label className="avp-btn avp-btn-outline cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>{isFa ? 'وارد کردن واژگان (tokens.txt)' : 'Import tokens.txt'}</span>
                  <input
                    data-testid="model-tokens-file-input"
                    type="file"
                    accept=".txt"
                    disabled={isInstallingModel}
                    onChange={handleImportCtcTokensTxt}
                    className="hidden"
                  />
                </label>

                {modelSnap.activeModel && (
                  <button
                    type="button"
                    data-testid="btn-verify-model-offline"
                    disabled={isInstallingModel}
                    onClick={handleVerifyModelOffline}
                    className="avp-btn avp-btn-outline border-[var(--avp-success)]/40 text-[var(--avp-success-text)]"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{isFa ? 'راستی‌آزمایی آفلاین OPFS' : 'Verify OPFS Integrity'}</span>
                  </button>
                )}

                {modelSnap.previousVerifiedModel && (
                  <button
                    type="button"
                    data-testid="btn-rollback-model"
                    disabled={isInstallingModel}
                    onClick={handleRollbackModel}
                    className="avp-btn avp-btn-outline border-[var(--avp-warning)]/40 text-[var(--avp-warning-text)]"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{isFa ? 'بازگشت به مدل قبلی تأییدشده' : 'Rollback to Previous Model'}</span>
                  </button>
                )}

                {modelSnap.activeModel && (
                  <button
                    type="button"
                    data-testid="btn-remove-model"
                    disabled={isInstallingModel}
                    onClick={handleRemoveModel}
                    className="avp-btn avp-btn-danger-ghost"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isFa ? 'حذف مدل (با حفظ پروژه‌ها)' : 'Remove Model (Keep Projects)'}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {activeTab === 'companion' && (
            <div className="space-y-3" data-testid="lifecycle-companion-tab">
              <CompanionConnectionDiagnostic
                endpoint={companionEndpoint}
                onChangeEndpoint={(next) => onChangeCompanionEndpoint?.(next)}
                locale={workflowState.locale}
                defaultExpanded
              />
            </div>
          )}

          {activeTab === 'offline' && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleCheckOfflineReadiness}
                className="avp-btn avp-btn-primary"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{isFa ? 'بررسی واقعی کش آفلاین پوسته' : 'Verify Real Offline Shell Cache'}</span>
              </button>

              {offlineReport && (
                <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] p-3.5 space-y-1.5">
                  <div className="font-semibold">
                    {offlineReport.offlineStartupReady
                      ? isFa
                        ? 'پوسته آفلاین آماده راه‌اندازی بدون اینترنت است.'
                        : 'Offline shell verified for offline startup.'
                      : isFa
                        ? 'راه‌اندازی کاملاً آفلاین هنوز تأیید نشده است.'
                        : 'Offline startup not yet verified.'}
                  </div>
                  <p className="text-[var(--avp-text-secondary)]">{offlineReport.note}</p>
                  <div className="font-mono text-[11px] text-[var(--avp-text-muted)]" dir="ltr">
                    SW Active: {String(offlineReport.serviceWorkerRegistered)} · WASM:{' '}
                    {String(offlineReport.wasmAssetsCached)} · Model Installed:{' '}
                    {String(offlineReport.localModelInstalled)}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'health' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[var(--avp-text-secondary)]">
                  {isFa
                    ? 'بررسی زنده ۱۴ زیرسیستم واقعی (مرورگر، حافظه، بودجه، WASM، مدل ASR، Worker، OPFS، IndexedDB، کش آفلاین، رندر و...)'
                    : 'Live inspection across all 14 real runtime subsystems.'}
                </p>
                <button
                  type="button"
                  data-testid="btn-run-health-checks"
                  onClick={handleRunHealthChecks}
                  disabled={runningHealth}
                  className="avp-btn avp-btn-primary"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>
                    {runningHealth
                      ? isFa
                        ? 'در حال پایش...'
                        : 'Probing...'
                      : isFa
                        ? 'اجرای بررسی سلامت ۱۴ زیرسیستم'
                        : 'Run 14-Subsystem Health Check'}
                  </span>
                </button>
              </div>

              {healthReport && (
                <div className="space-y-2" data-testid="health-report-results">
                  <div className="font-semibold">
                    {isFa ? 'وضعیت کلی:' : 'Overall Status:'}{' '}
                    <span className="font-mono text-[var(--avp-accent-text)]">
                      {healthReport.overallStatus}
                    </span>{' '}
                    ({healthReport.subsystems.length} {isFa ? 'زیرسیستم' : 'subsystems'})
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {healthReport.subsystems.map((sub) => (
                      <div
                        key={sub.subsystemId}
                        className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] p-2.5 space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">
                            {isFa ? sub.displayNameFa : sub.displayNameEn}
                          </span>
                          <span
                            className={`font-mono text-[11px] font-semibold ${
                              sub.status === 'HEALTHY'
                                ? 'text-[var(--avp-success-text)]'
                                : sub.status === 'DEGRADED'
                                  ? 'text-[var(--avp-warning-text)]'
                                  : 'text-[var(--avp-danger)]'
                            }`}
                          >
                            {sub.status}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--avp-text-secondary)]">
                          {isFa ? sub.summaryFa : sub.summaryEn}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'backup' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={backupMode === 'METADATA_ONLY'}
                    onChange={() => setBackupMode('METADATA_ONLY')}
                    className="accent-[var(--avp-accent)]"
                  />
                  <span>{isFa ? 'فقط فراداده، متن و EDL (سبک)' : 'Metadata, Transcript & EDL Only'}</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={backupMode === 'COMPLETE_PACKAGE'}
                    onChange={() => setBackupMode('COMPLETE_PACKAGE')}
                    className="accent-[var(--avp-accent)]"
                  />
                  <span>{isFa ? 'بسته کامل پروژه با کد SHA-256' : 'Complete Project Package (SHA-256)'}</span>
                </label>
              </div>
              <button
                type="button"
                onClick={handleExportProjectBackup}
                className="avp-btn avp-btn-primary"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isFa ? 'ساخت و دانلود بسته پشتیبان محلی' : 'Create & Download Local Backup'}</span>
              </button>
            </div>
          )}

          {activeTab === 'storage' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleInspectStorage}
                  className="avp-btn avp-btn-primary"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>{isFa ? 'اندازه‌گیری فضای ذخیره‌سازی' : 'Inspect Local Storage'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleSafeCleanup}
                  className="avp-btn avp-btn-outline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{isFa ? 'پاک‌سازی ایمن فایل‌های موقت' : 'Safe Temp Cleanup'}</span>
                </button>
              </div>

              {storageReport && (
                <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] p-3.5 font-mono text-[11px] space-y-1" dir="ltr">
                  <div>StorageManager API: {String(storageReport.storageApiAvailable)}</div>
                  <div>Estimated Usage: {storageReport.estimatedUsageBytes ?? 'N/A'} B</div>
                  <div>Estimated Quota: {storageReport.estimatedQuotaBytes ?? 'N/A'} B</div>
                  <div>Measured Model Bytes: {storageReport.measuredInstalledModelBytes} B</div>
                  <div>Measured Partial Model Bytes: {storageReport.measuredPartialModelBytes} B</div>
                  <div>Recoverable Checkpoints: {storageReport.measuredRecoverableCheckpointCount}</div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'diagnostics' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[var(--avp-text-secondary)]">
                  {isFa
                    ? 'تمام گزارش‌های عیب‌یابی قبل از نمایش پاک‌سازی می‌شوند و شامل هیچ صوت یا متن کاربر نیستند.'
                    : 'All diagnostic exports are strictly sanitized and never include user audio or transcript content.'}
                </span>
                <button
                  type="button"
                  onClick={handleRefreshDiagnostics}
                  className="avp-btn avp-btn-primary"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{isFa ? 'تولید گزارش عیب‌یابی' : 'Generate Diagnostics'}</span>
                </button>
              </div>
              {diagJsonPreview && (
                <pre
                  dir="ltr"
                  className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] p-3 text-[11px] font-mono overflow-x-auto max-h-64"
                >
                  {diagJsonPreview}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </AccessibleModal>
  );
};

let sharedLocalModelLifecycleManager: LocalModelLifecycleManager | null = null;

/**
 * Production singleton LocalModelLifecycleManager backed strictly by durable `OpfsModelChunkStorage`.
 */
export function createSharedLocalModelLifecycleManager(): LocalModelLifecycleManager {
  if (!sharedLocalModelLifecycleManager) {
    sharedLocalModelLifecycleManager = new LocalModelLifecycleManager(
      new OpfsModelChunkStorage(),
    );
  }
  return sharedLocalModelLifecycleManager;
}
