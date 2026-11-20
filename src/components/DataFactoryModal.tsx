import React, { useEffect, useState } from 'react';
import {
  AudioWaveform,
  CheckCircle2,
  Database,
  FileCheck,
  GitBranch,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import type {
  AnnotationRecord,
  AnnotationReviewRecord,
  AudioArtifactRecord,
  DataSourceRecord,
  DatasetReleaseRecord,
  MultiDimensionalCorpusMetrics,
  RecordingRecord,
  RevocationCascadeReport,
  RightsRecord,
} from '../data-factory/DataFactoryContracts';

interface DataFactoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type DataFactoryTab = 'dashboard' | 'ingestion' | 'rights' | 'annotation' | 'datasets';

interface SandboxDashboardPayload {
  dashboard: MultiDimensionalCorpusMetrics;
  sources: DataSourceRecord[];
  recordings: RecordingRecord[];
  rights: RightsRecord[];
  datasets: Array<{ datasetId: string; datasetName: string; description: string }>;
  releases: DatasetReleaseRecord[];
  annotationsByRec: Record<string, { annotations: AnnotationRecord[]; reviews: AnnotationReviewRecord[] }>;
  artifactsByRec: Record<string, AudioArtifactRecord[]>;
}

export const DataFactoryModal: React.FC<DataFactoryModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<DataFactoryTab>('dashboard');
  const [payload, setPayload] = useState<SandboxDashboardPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revocationReport, setRevocationReport] = useState<RevocationCascadeReport | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/data-factory/sandbox/dashboard');
      if (res.ok) {
        setPayload((await res.json()) as SandboxDashboardPayload);
      } else {
        setNotice(`خطا در بارگذاری داشبورد کارخانه داده (کد ${res.status}).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در ارتباط با کارخانه داده: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadData();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleBuildNewRelease = async () => {
    if (!payload?.datasets[0]) return;
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/data-factory/sandbox/datasets/${payload.datasets[0].datasetId}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseType: 'MIXED_RELEASE' }),
      });
      if (res.ok) {
        setNotice('نسخه جدید و تغییرناپذیر دیتاست با ممیزی عدم نشت گوینده ساخته شد.');
        await loadData();
      } else {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        setNotice(`خطا در ساخت نسخه دیتاست: ${err.message ?? `کد ${res.status}`}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در ساخت نسخه دیتاست: ${msg}`);
    }
  };

  const handleRevokeRecording = async (recordingId: string) => {
    try {
      const res = await fetch(`/api/v1/data-factory/sandbox/rights/${recordingId}/revoke`, {
        method: 'POST',
      });
      if (res.ok) {
        const rep = (await res.json()) as RevocationCascadeReport;
        setRevocationReport(rep);
        setNotice(`لغو مجوز ${recordingId} با اثر آبشاری روی ${rep.affectedArtifactIds.length} آرتیفکت و ${rep.excludedAnnotationIds.length} رونویسی ثبت شد.`);
        await loadData();
      } else {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        setNotice(`خطا در لغو مجوز ${recordingId}: ${err.message ?? `کد ${res.status}`}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در لغو مجوز ${recordingId}: ${msg}`);
    }
  };

  const tabs: Array<{ id: DataFactoryTab; label: string; icon: React.ReactNode }> = [
    { id: 'dashboard', label: 'داشبورد ۷گانه و D0..D4', icon: <Database className="w-3.5 h-3.5" /> },
    { id: 'ingestion', label: 'ورود صوت و پروفایلینگ ۱۲B', icon: <AudioWaveform className="w-3.5 h-3.5" /> },
    { id: 'rights', label: 'حقوق ۸گانه و لغو رضایت', icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    { id: 'annotation', label: 'برچسب‌گذاری دوسویه کور', icon: <Users className="w-3.5 h-3.5" /> },
    { id: 'datasets', label: 'نسخه‌های دیتاست و ممیزی نشت', icon: <GitBranch className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="کارخانه داده گفتار و کیفیت پیکره (فاز ۱۲)"
      data-testid="modal-data-factory"
    >
      <div className="w-full max-w-6xl max-h-[90vh] flex flex-col rounded-xl border border-[#252F42] bg-[#0B0F17] text-slate-100 shadow-2xl overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 border-b border-[#252F42] bg-[#131924]">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-cyan-400" aria-hidden="true" />
            <div>
              <h2 className="text-base font-bold text-slate-100">
                کارخانه داده گفتار، حاکمیت حقوق و مهندسی دیتاست (فاز ۱۲)
              </h2>
              <p className="text-xs text-slate-400">
                تفکیک کامل ۷ معیار زمان • پروفایل صوتی و استانداردسازی 16kHz • برچسب‌گذاری دوگانه کور • نسخه‌بندی تغییرناپذیر
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن کارخانه داده"
            className="p-1.5 rounded-md border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <nav className="flex flex-wrap gap-1.5 px-5 py-2.5 border-b border-[#252F42] bg-[#0E131D]" aria-label="بخش‌های کارخانه داده">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              data-testid={`df-tab-${t.id}`}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                activeTab === t.id
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40'
                  : 'text-slate-400 border border-transparent hover:text-slate-200 hover:bg-[#161D2B]'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {notice && (
          <div className="mx-5 mt-3 px-3.5 py-2 rounded-md border border-cyan-500/30 bg-cyan-500/10 text-xs text-cyan-200">
            {notice}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loading || !payload ? (
            <div className="text-xs text-slate-400 py-8 text-center">در حال بارگذاری وضعیت کارخانه داده...</div>
          ) : (
            <>
              {activeTab === 'dashboard' && (
                <div className="space-y-5">
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                    <strong>گزارش صادقانه ظرفیت پیکره:</strong> داده‌های فعلی سندباکس صرفاً نمونه تأیید خط‌لوله (
                    <span dir="ltr">{(payload.dashboard.durationBreakdownSeconds.uploadedSeconds / 3600).toFixed(4)}h</span>) هستند و معادل رسیدن به هدف ۳۰ ساعت واقعی (<span dir="ltr">D0</span>) محسوب نمی‌شوند.
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
                    {[
                      { k: 'بارگذاری‌شده (Uploaded)', s: payload.dashboard.durationBreakdownSeconds.uploadedSeconds },
                      { k: 'معتبر فنی (Validated)', s: payload.dashboard.durationBreakdownSeconds.validatedSeconds },
                      { k: 'دارای حقوق (Rights)', s: payload.dashboard.durationBreakdownSeconds.rightsApprovedSeconds },
                      { k: 'برچسب‌خورده (Annotated)', s: payload.dashboard.durationBreakdownSeconds.annotatedSeconds },
                      { k: 'تأیید انسانی (Reviewed)', s: payload.dashboard.durationBreakdownSeconds.reviewedSeconds },
                      { k: 'واجد آموزش (Training)', s: payload.dashboard.durationBreakdownSeconds.trainingEligibleSeconds },
                      { k: 'واجد ارزیابی (Eval)', s: payload.dashboard.durationBreakdownSeconds.evaluationEligibleSeconds },
                    ].map((card) => (
                      <div key={card.k} className="p-3 rounded-lg border border-[#252F42] bg-[#131924]">
                        <div className="text-[11px] text-slate-400 mb-1">{card.k}</div>
                        <div dir="ltr" className="text-base font-bold text-cyan-300 font-mono">
                          {card.s.toFixed(1)}s
                        </div>
                        <div dir="ltr" className="text-[10px] text-slate-500 font-mono">
                          {(card.s / 3600).toFixed(4)} h
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2.5">
                      <h3 className="text-sm font-semibold text-slate-100">پیشرفت مایلستون‌های رشد داده (D0..D4)</h3>
                      {payload.dashboard.expansionMilestones.map((m) => (
                        <div key={m.milestoneId} className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="font-semibold text-slate-200" dir="ltr">
                              {m.milestoneId} ({m.targetHours}h)
                            </span>
                            <span className="text-slate-400 font-mono" dir="ltr">
                              {m.completionPercent.toFixed(3)}% • {m.reached ? 'REACHED' : 'BELOW_TARGET'}
                            </span>
                          </div>
                          <div className="h-1.5 rounded bg-[#0B0F17] overflow-hidden">
                            <div
                              className="h-full bg-cyan-400"
                              style={{ width: `${Math.min(100, Math.max(1, m.completionPercent))}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                      <h3 className="text-sm font-semibold text-slate-100">پراکندگی زبان، کیفیت و گوینده‌ها</h3>
                      <div className="flex justify-between py-1 border-b border-[#1E2738]">
                        <span className="text-slate-400">تعداد گویندگان متمایز</span>
                        <span className="font-mono text-emerald-300">{payload.dashboard.diversity.uniqueSpeakerCount}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[#1E2738]">
                        <span className="text-slate-400">نسبت زبان‌ها (FA / EN / FA-EN)</span>
                        <span className="font-mono text-slate-200" dir="ltr">
                          {JSON.stringify(payload.dashboard.transcripts.languageDistributionCounts)}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[#1E2738]">
                        <span className="text-slate-400">سهم حداکثری یک گوینده</span>
                        <span className="font-mono text-amber-300" dir="ltr">
                          {payload.dashboard.diversity.maxSingleSpeakerSharePercent.toFixed(1)}%
                        </span>
                      </div>
                      <div className="flex justify-between py-1">
                        <span className="text-slate-400">فایل‌های پذیرفته‌شده فنی</span>
                        <span className="font-mono text-slate-200" dir="ltr">
                          {payload.dashboard.audio.acceptedRecordingsCount} فایل ثبت‌شده
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'ingestion' && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-slate-200">فایل‌های صوتی واردشده و آرتیفکت‌های 16kHz Mono PCM16</h3>
                  {payload.recordings.map((rec) => {
                    const arts = payload.artifactsByRec[rec.recordingId] ?? [];
                    return (
                      <div key={rec.recordingId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-mono text-cyan-300" dir="ltr">
                            {rec.recordingId} ({rec.originalFilename})
                          </div>
                          <div className="flex gap-2">
                            <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-200" dir="ltr">
                              {rec.acousticProfile.qualityClass}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-sky-500/20 text-sky-200" dir="ltr">
                              {rec.languageClassification}
                            </span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-slate-300" dir="ltr">
                          <div>Source SR: {rec.technicalMetadata.sampleRate} Hz ({rec.technicalMetadata.channelCount}ch)</div>
                          <div>SNR Est: {rec.acousticProfile.estimatedSnrDb.toFixed(1)} dB</div>
                          <div>VAD Ratio: {(rec.acousticProfile.voiceActivityRatio * 100).toFixed(0)}%</div>
                          <div>Policy: {rec.technicalMetadata.recommendedChannelPolicy}</div>
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono" dir="ltr">
                          Artifacts: {arts.map((a) => `${a.artifactType}(v${a.artifactVersion}:${a.sampleRate}Hz)`).join(' | ')}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === 'rights' && (
                <div className="space-y-4">
                  <div className="text-xs text-slate-300">
                    سیاست پیش‌فرض بسته (Default-Deny): هر ۸ مجوز باید صریحاً برای آموزش یا ارزیابی تأیید شده باشند. لغو رضایت، آبشار حذف/مسدودسازی را فعال می‌کند.
                  </div>
                  {payload.rights.map((r) => (
                    <div key={r.rightsRecordId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-slate-200" dir="ltr">
                          {r.recordingId} • {r.licenseId} ({r.verificationStatus})
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleRevokeRecording(r.recordingId)}
                          disabled={r.verificationStatus === 'REVOKED'}
                          data-testid={`btn-revoke-${r.recordingId}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 disabled:opacity-40 cursor-pointer"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" />
                          <span>{r.verificationStatus === 'REVOKED' ? 'لغوشده' : 'لغو رضایت (Revoke Cascade)'}</span>
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2 text-[11px] font-mono" dir="ltr">
                        <span className={r.permissions.trainModels ? 'text-emerald-300' : 'text-rose-300'}>
                          trainModels={String(r.permissions.trainModels)}
                        </span>
                        <span className={r.evaluationAllowed ? 'text-emerald-300' : 'text-rose-300'}>
                          evaluationAllowed={String(r.evaluationAllowed)}
                        </span>
                        <span className="text-slate-400">
                          storeAudio={String(r.permissions.storeAudio)}
                        </span>
                        <span className="text-slate-400">
                          retainTranscripts={String(r.permissions.retainTranscripts)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {revocationReport && (
                    <div className="p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-xs font-mono text-rose-200" dir="ltr">
                      REVOCATION REPORT: {revocationReport.revocationId} | artifacts={revocationReport.affectedArtifactIds.length} | summary={revocationReport.remediationSummary}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'annotation' && (
                <div className="space-y-3">
                  {payload.recordings.map((rec) => {
                    const info = payload.annotationsByRec[rec.recordingId] ?? { annotations: [], reviews: [] };
                    return (
                      <div key={rec.recordingId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-cyan-300" dir="ltr">{rec.recordingId}</span>
                          <span className="text-slate-400">
                            تعداد گذرهای کور: {info.annotations.length} • داوری: {info.reviews.length}
                          </span>
                        </div>
                        {info.annotations.map((ann) => (
                          <div key={ann.annotationId} className="p-2.5 rounded bg-[#0B0F17] border border-[#1E2738] space-y-1">
                            <div className="flex justify-between text-[11px] text-slate-400" dir="ltr">
                              <span>Pass {ann.passIndex} • {ann.annotatorId}</span>
                              <span>status={ann.status} • lang={ann.recordingLanguage}</span>
                            </div>
                            <div className="text-slate-200">
                              {ann.segments.map((s) => s.rawText).join(' ')}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === 'datasets' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-100">نسخه‌های منتشرشده تغییرناپذیر (Immutable Releases)</h3>
                    <button
                      type="button"
                      onClick={() => void handleBuildNewRelease()}
                      data-testid="btn-build-dataset-release"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-500 text-slate-950 font-semibold text-xs hover:bg-cyan-400 cursor-pointer"
                    >
                      <FileCheck className="w-3.5 h-3.5" />
                      <span>ساخت نسخه جدید دیتاست</span>
                    </button>
                  </div>

                  {payload.releases.map((rel) => (
                    <div key={rel.datasetReleaseId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-mono text-cyan-300" dir="ltr">
                          {rel.datasetName}@{rel.version} ({rel.datasetReleaseId})
                        </div>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-200" dir="ltr">
                          <CheckCircle2 className="w-3 h-3" />
                          LeakageAudit={rel.leakageAudit.status}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] text-slate-300" dir="ltr">
                        <div>TotalSec: {Object.values(rel.durationBySplitSeconds).reduce((a, b) => a + b, 0).toFixed(1)}s</div>
                        <div>Speakers: {rel.uniqueSpeakerCount}</div>
                        <div>Included: {rel.sourceRecordingIds.length}</div>
                        <div>SealedTest: {String(rel.sealedTestProtected)}</div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono" dir="ltr">
                        <Lock className="w-3 h-3 text-amber-400" />
                        <span>ConfigHash: {rel.configurationHash}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
