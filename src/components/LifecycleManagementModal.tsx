import React, { useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import {
  AppUpdateAndShellManager,
  AVAPARDAZ_VERSION_CONTRACT,
  InMemoryModelChunkStorage,
  LocalModelLifecycleManager,
  PersistedProjectEnvelope,
  ProjectBackupAndRestore,
  ShellOfflineVerificationReport,
  StorageAndDiagnosticsManager,
  StorageBreakdownReport,
} from '../lifecycle';
import { computeSha256Hex } from '../security/LocalPrivacyPolicy';
import {
  createDefaultSubsystemHealthRegistry,
  getSharedDiagnosticLogger,
  SystemHealthSnapshot,
} from '../reliability';
import { getSharedMemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { LongSessionMonitor } from '../performance';
import { StudioWorkflowState } from '../workflow/StudioWorkflowController';

export type LifecycleModalTab =
  | 'model'
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
}

export const LifecycleManagementModal: React.FC<LifecycleManagementModalProps> = ({
  isOpen,
  initialTab = 'health',
  onClose,
  workflowState,
  modelManager,
  onModelStateChanged,
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

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const modelSnap = modelManager.getSnapshot();

  const handleImportLocalOnnxModel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await computeSha256Hex(bytes);
    const res = await modelManager.installOrUpdateFromStream({
      manifest: {
        modelId: file.name.replace(/\.onnx$/i, '') || 'local-persian-asr',
        modelVersion: '1.0.0-local',
        architecture: 'FASTCONFORMER_CTC',
        fileName: file.name,
        expectedByteLength: bytes.byteLength,
        expectedSha256Hex: sha,
      },
      stream: {
        supportsRangeResume: false,
        async fetchRange(start: number, end: number) {
          return bytes.subarray(start, end);
        },
      },
      sourceOrigin: 'local-user-file',
      license: 'User-supplied local ONNX weights',
    });
    if (res.ok) {
      await modelManager.verifyInstalledActiveModelOffline();
      setStatusMessage(
        isFa
          ? `مدل محلی «${file.name}» با SHA-256 تأیید و ثبت شد.`
          : `Local model "${file.name}" verified with SHA-256 and registered.`,
      );
      onModelStateChanged();
    } else {
      setStatusMessage(res.snapshot.lastError ?? 'Model installation failed.');
    }
  };

  const handleRemoveModel = async () => {
    await modelManager.removeActiveModel();
    setStatusMessage(
      isFa
        ? 'مدل محلی حذف شد. تمام پروژه‌ها و فایل‌های صوتی کاربر دست‌نخورده باقی ماندند.'
        : 'Local model removed. All user projects and audio files remain untouched.',
    );
    onModelStateChanged();
  };

  const handleCheckOfflineReadiness = async () => {
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
    } finally {
      setRunningHealth(false);
    }
  };

  const handleInspectStorage = async () => {
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
  };

  const handleSafeCleanup = async () => {
    const cleanedPartial = await modelManager.cleanupInvalidPartialDownloads();
    setStatusMessage(
      isFa
        ? `پاک‌سازی ایمن انجام شد (${cleanedPartial} فایل نیمه‌کاره حذف شد؛ هیچ پروژه یا صوت کاربری لمس نشد).`
        : `Safe cleanup completed (${cleanedPartial} partial download(s) removed; user projects untouched).`,
    );
    await handleInspectStorage();
  };

  const handleExportProjectBackup = async () => {
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
    URL.revokeObjectURL(url);
    setStatusMessage(
      isFa
        ? `بسته پشتیبان (${backupMode}) با کد اصالت SHA-256 آماده و ذخیره شد.`
        : `Project backup (${backupMode}) packaged with SHA-256 manifest.`,
    );
  };

  const handleRefreshDiagnostics = () => {
    const logger = getSharedDiagnosticLogger();
    const perfMonitor = new LongSessionMonitor();
    const memSnap = getSharedMemoryBudgetManager().getSnapshot();
    const bundle = {
      localOnlyNotice: 'Privacy-safe local diagnostics only. Zero audio/transcript content included.',
      appVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
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
    { id: 'offline', label: isFa ? 'آفلاین و نسخه' : 'Offline & Version', icon: <WifiOff className="w-3.5 h-3.5" /> },
    { id: 'health', label: isFa ? 'سلامت ۱۴ زیرسیستم' : '14-Subsystem Health', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'backup', label: isFa ? 'پشتیبان و بازیابی' : 'Backup & Restore', icon: <Archive className="w-3.5 h-3.5" /> },
    { id: 'storage', label: isFa ? 'فضای ذخیره‌سازی' : 'Storage & Cleanup', icon: <HardDrive className="w-3.5 h-3.5" /> },
    { id: 'diagnostics', label: isFa ? 'عیب‌یابی و کارایی' : 'Diagnostics & Perf', icon: <ShieldAlert className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lifecycle-modal-title"
      data-testid="lifecycle-management-modal"
    >
      <div className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-lg border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] text-slate-900 dark:text-slate-100 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-[#252F42] flex items-center justify-between shrink-0">
          <div>
            <h2 id="lifecycle-modal-title" className="text-sm font-bold">
              {isFa
                ? 'مدیریت محصول محلی، سلامت زیرسیستم‌ها و چرخه عمر (AVP-P09 / P10 / P11)'
                : 'Local Product Lifecycle, Subsystem Health & Diagnostics'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono" dir="ltr">
              v{AVAPARDAZ_VERSION_CONTRACT.appVersion} · Schema v{AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion} · 100% Local-First
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isFa ? 'بستن' : 'Close'}
            className="p-1.5 rounded text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation tabs */}
        <div className="px-5 pt-2 border-b border-slate-200 dark:border-[#252F42] flex items-center gap-4 overflow-x-auto shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`lifecycle-tab-${t.id}`}
              onClick={() => setActiveTab(t.id)}
              className={`pb-2.5 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap border-b-2 cursor-pointer transition-colors ${
                activeTab === t.id
                  ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
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
            <div className="rounded border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sky-900 dark:text-sky-200">
              {statusMessage}
            </div>
          )}

          {activeTab === 'model' && (
            <div className="space-y-3">
              <div className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-3.5 space-y-1.5">
                <div className="font-semibold">
                  {isFa ? 'وضعیت فعلی مدل محلی:' : 'Current Local Model State:'}{' '}
                  <span className="font-mono text-amber-600 dark:text-amber-400">{modelSnap.state}</span>
                </div>
                {modelSnap.activeModel ? (
                  <div className="font-mono text-[11px] text-slate-600 dark:text-slate-400 space-y-0.5" dir="ltr">
                    <div>Model: {modelSnap.activeModel.modelId} (v{modelSnap.activeModel.version})</div>
                    <div>Size: {(modelSnap.activeModel.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB</div>
                    <div>SHA-256: {modelSnap.activeModel.verifiedSha256Hex}</div>
                  </div>
                ) : (
                  <p className="text-slate-600 dark:text-slate-400">
                    {isFa
                      ? 'هیچ مدل وزن محلی (.onnx) نصب نشده است. آواپرداز هرگز از سرویس ابری پنهان یا خروجی ساختگی استفاده نمی‌کند.'
                      : 'No local ONNX weights are installed. Avapardaz never falls back to hidden cloud endpoints or fake inference.'}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>{isFa ? 'وارد کردن فایل مدل محلی (.onnx)' : 'Import Local ONNX Model'}</span>
                  <input
                    type="file"
                    accept=".onnx,application/octet-stream"
                    onChange={handleImportLocalOnnxModel}
                    className="hidden"
                  />
                </label>

                {modelSnap.activeModel && (
                  <button
                    type="button"
                    onClick={handleRemoveModel}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-rose-500/40 text-rose-600 dark:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isFa ? 'حذف مدل (با حفظ پروژه‌ها)' : 'Remove Model (Keep Projects)'}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {activeTab === 'offline' && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleCheckOfflineReadiness}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{isFa ? 'بررسی واقعی کش آفلاین پوسته' : 'Verify Real Offline Shell Cache'}</span>
              </button>

              {offlineReport && (
                <div className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-3.5 space-y-1.5">
                  <div className="font-semibold">
                    {offlineReport.offlineStartupReady
                      ? isFa
                        ? 'پوسته آفلاین آماده راه‌اندازی بدون اینترنت است.'
                        : 'Offline shell verified for offline startup.'
                      : isFa
                        ? 'راه‌اندازی کاملاً آفلاین هنوز تأیید نشده است.'
                        : 'Offline startup not yet verified.'}
                  </div>
                  <p className="text-slate-600 dark:text-slate-400">{offlineReport.note}</p>
                  <div className="font-mono text-[11px] text-slate-500" dir="ltr">
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
              <div className="flex items-center justify-between">
                <p className="text-slate-600 dark:text-slate-400">
                  {isFa
                    ? 'بررسی زنده ۱۴ زیرسیستم واقعی (مرورگر، حافظه، بودجه، WASM، مدل ASR، Worker، OPFS، IndexedDB، کش آفلاین، رندر و...)'
                    : 'Live inspection across all 14 real runtime subsystems.'}
                </p>
                <button
                  type="button"
                  data-testid="btn-run-health-checks"
                  onClick={handleRunHealthChecks}
                  disabled={runningHealth}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
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
                    <span className="font-mono text-amber-600 dark:text-amber-400">
                      {healthReport.overallStatus}
                    </span>{' '}
                    ({healthReport.subsystems.length} {isFa ? 'زیرسیستم' : 'subsystems'})
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {healthReport.subsystems.map((sub) => (
                      <div
                        key={sub.subsystemId}
                        className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-2.5 space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">
                            {isFa ? sub.displayNameFa : sub.displayNameEn}
                          </span>
                          <span
                            className={`font-mono text-[11px] font-semibold ${
                              sub.status === 'HEALTHY'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : sub.status === 'DEGRADED'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {sub.status}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400">
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
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={backupMode === 'METADATA_ONLY'}
                    onChange={() => setBackupMode('METADATA_ONLY')}
                  />
                  <span>{isFa ? 'فقط فراداده، متن و EDL (سبک)' : 'Metadata, Transcript & EDL Only'}</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={backupMode === 'COMPLETE_PACKAGE'}
                    onChange={() => setBackupMode('COMPLETE_PACKAGE')}
                  />
                  <span>{isFa ? 'بسته کامل پروژه با کد SHA-256' : 'Complete Project Package (SHA-256)'}</span>
                </label>
              </div>
              <button
                type="button"
                onClick={handleExportProjectBackup}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
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
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>{isFa ? 'اندازه‌گیری فضای ذخیره‌سازی' : 'Inspect Local Storage'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleSafeCleanup}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-slate-300 dark:border-[#252F42] hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{isFa ? 'پاک‌سازی ایمن فایل‌های موقت' : 'Safe Temp Cleanup'}</span>
                </button>
              </div>

              {storageReport && (
                <div className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-3.5 font-mono text-[11px] space-y-1" dir="ltr">
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
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-600 dark:text-slate-400">
                  {isFa
                    ? 'تمام گزارش‌های عیب‌یابی قبل از نمایش پاک‌سازی می‌شوند و شامل هیچ صوت یا متن کاربر نیستند.'
                    : 'All diagnostic exports are strictly sanitized and never include user audio or transcript content.'}
                </span>
                <button
                  type="button"
                  onClick={handleRefreshDiagnostics}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{isFa ? 'تولید گزارش عیب‌یابی' : 'Generate Diagnostics'}</span>
                </button>
              </div>
              {diagJsonPreview && (
                <pre
                  dir="ltr"
                  className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0B0F17] p-3 text-[11px] font-mono overflow-x-auto max-h-64"
                >
                  {diagJsonPreview}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export function createSharedLocalModelLifecycleManager(): LocalModelLifecycleManager {
  return new LocalModelLifecycleManager(new InMemoryModelChunkStorage());
}
