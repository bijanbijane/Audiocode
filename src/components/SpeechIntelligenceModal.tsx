import React, { useEffect, useState } from 'react';
import {
  Activity,
  FileText,
  GitBranch,
  Layers,
  Play,
  Radio,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  AlignmentResultPayload,
  CapabilityDescriptor,
  ConversationAnalyticsPayload,
  DiarizationResultPayload,
  EnterpriseConnectorRecord,
  GranularProcessingConsent,
  IntelligenceJobRecord,
  MeetingIntelligencePayload,
  RealtimeIntelligenceEvent,
  SemanticSearchResultItem,
  SpeechArtifactRecord,
  SpeechCapabilityId,
  StructuredExtractionPayload,
  SubtitleResultPayload,
  TranslationResultPayload,
} from '../intelligence/SpeechIntelligenceContracts';

export type SpeechIntelTabId =
  | 'orchestrator_dag'
  | 'diarization_alignment'
  | 'translation_subtitles'
  | 'meeting_extraction'
  | 'analytics_search'
  | 'realtime_connectors';

interface SpeechIntelligenceModalProps {
  isOpen: boolean;
  onClose: () => void;
  studioTranscriptSegments: Array<{ segmentId: string; startSec: number; endSec: number; text: string }>;
}

export const SpeechIntelligenceModal: React.FC<SpeechIntelligenceModalProps> = ({
  isOpen,
  onClose,
  studioTranscriptSegments,
}) => {
  const [activeTab, setActiveTab] = useState<SpeechIntelTabId>('orchestrator_dag');
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>([]);
  const [connectors, setConnectors] = useState<EnterpriseConnectorRecord[]>([]);
  const [recordingId, setRecordingId] = useState('rec_studio_podcast_01');
  const [selectedCaps, setSelectedCaps] = useState<SpeechCapabilityId[]>([
    'speech.diarization',
    'speech.alignment',
    'speech.translation',
    'speech.subtitles',
    'speech.meeting_intelligence',
    'speech.conversation_analytics',
    'speech.semantic_indexing',
    'speech.structured_extraction',
  ]);
  const [consent, setConsent] = useState<GranularProcessingConsent>({
    allowTranscribe: true,
    allowStoreTranscript: true,
    allowRetainAudio: true,
    allowDiarization: true,
    allowTranslation: true,
    allowMeetingIntelligence: true,
    allowAnalytics: true,
    allowEmbeddings: true,
    allowStructuredExtraction: true,
    allowRetainDerivedArtifacts: true,
    allowModelTraining: false,
    allowResearchPublication: false,
  });

  const [isRunning, setIsRunning] = useState(false);
  const [job, setJob] = useState<IntelligenceJobRecord | null>(null);
  const [artifacts, setArtifacts] = useState<SpeechArtifactRecord[]>([]);
  const [subtitlePreviewFormat, setSubtitlePreviewFormat] = useState<'srt' | 'vtt' | 'json' | 'txt'>('srt');
  const [searchQuery, setSearchQuery] = useState('TypeScript');
  const [searchResults, setSearchResults] = useState<SemanticSearchResultItem[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeIntelligenceEvent[]>([]);
  const [realtimeStatusNote, setRealtimeStatusNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadOverview = async () => {
    const res = await fetch('/api/v1/intelligence/sandbox/overview');
    if (res.ok) {
      const data = (await res.json()) as {
        capabilities: CapabilityDescriptor[];
        connectors: EnterpriseConnectorRecord[];
      };
      setCapabilities(data.capabilities);
      setConnectors(data.connectors);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadOverview();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleCapability = (capId: SpeechCapabilityId) => {
    setSelectedCaps((prev) =>
      prev.includes(capId) ? prev.filter((c) => c !== capId) : [...prev, capId]
    );
  };

  const handleRunDagJob = async () => {
    setIsRunning(true);
    setNotice(null);
    try {
      const segmentsPayload =
        studioTranscriptSegments.length > 0
          ? studioTranscriptSegments.slice(0, 8)
          : undefined;
      const res = await fetch('/api/v1/intelligence/sandbox/run-dag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordingId,
          segments: segmentsPayload,
          capabilities: selectedCaps,
          consent,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          job: IntelligenceJobRecord;
          artifacts: SpeechArtifactRecord[];
        };
        setJob(data.job);
        setArtifacts(data.artifacts);
        setNotice(
          `پایپ‌لاین DAG با وضعیت ${data.job.status} اجرا شد (${data.job.completedCapabilities.length} موفق / ${data.job.failedCapabilities.length} مسدود یا ناموفق).`
        );
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleSemanticSearch = async () => {
    const res = await fetch('/api/v1/intelligence/sandbox/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId, query: searchQuery }),
    });
    if (res.ok) {
      const data = (await res.json()) as { results: SemanticSearchResultItem[] };
      setSearchResults(data.results);
    }
  };

  const handleCascadeDelete = async () => {
    const res = await fetch(`/api/v1/intelligence/sandbox/recordings/${encodeURIComponent(recordingId)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const data = (await res.json()) as { deletedArtifactsCount: number; deletedVectorsCount: number };
      setArtifacts([]);
      setSearchResults([]);
      setNotice(
        `حذف زنجیره‌ای انجام شد: ${data.deletedArtifactsCount} آرتیفکت مشتق و ${data.deletedVectorsCount} بردار جستجو با حفظ جداسازی مستأجر پاک شدند.`
      );
    }
  };

  const handleRunRealtimeSim = async () => {
    const res = await fetch('/api/v1/intelligence/sandbox/realtime-sim', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as {
        events: RealtimeIntelligenceEvent[];
        asrStreamAliveThroughout: boolean;
        backpressureTriggeredOnOverload: boolean;
      };
      setRealtimeEvents(data.events);
      setRealtimeStatusNote(
        `جریان اصلی ASR پایدار ماند (${data.asrStreamAliveThroughout ? 'ACTIVE' : 'BROKEN'}) · ایزوله‌سازی Backpressure روی تاخیر مازاد: ${data.backpressureTriggeredOnOverload ? 'فعال شد' : 'خیر'}`
      );
    }
  };

  const diarArtifact = artifacts.find((a) => a.artifactType === 'DIARIZATION')?.payload as
    | DiarizationResultPayload
    | undefined;
  const alignArtifact = artifacts.find((a) => a.artifactType === 'ALIGNMENT')?.payload as
    | AlignmentResultPayload
    | undefined;
  const transArtifact = artifacts.find((a) => a.artifactType === 'TRANSLATION')?.payload as
    | TranslationResultPayload
    | undefined;
  const subArtifact = artifacts.find((a) => a.artifactType === 'SUBTITLES')?.payload as
    | SubtitleResultPayload
    | undefined;
  const meetingArtifact = artifacts.find((a) => a.artifactType === 'MEETING_INTELLIGENCE')?.payload as
    | MeetingIntelligencePayload
    | undefined;
  const extractionArtifact = artifacts.find((a) => a.artifactType === 'STRUCTURED_EXTRACTION')?.payload as
    | StructuredExtractionPayload
    | undefined;
  const analyticsArtifact = artifacts.find((a) => a.artifactType === 'CONVERSATION_ANALYTICS')?.payload as
    | ConversationAnalyticsPayload
    | undefined;

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="میز هوشمندی گفتار و تحلیل چندوجهی — فاز ۱۱"
    >
      <div className="w-full max-w-6xl max-h-[92vh] bg-[#0F141E] border border-[#252F42] rounded-lg flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <header className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-[#252F42] bg-[#141B27]">
          <div className="flex items-center gap-3 min-w-0">
            <Layers className="w-5 h-5 text-emerald-400 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-100 truncate">
                مجموعه هوشمندی گفتار و یکپارچه‌سازی سازمانی (فاز ۱۱)
              </h2>
              <p className="text-xs text-slate-400 truncate">
                معماری ماژولار بر پایه هسته تغییرناپذیر ASR · شواهد مستند به بازه زمانی · بدون شناسایی بیومتریک هویت
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پنجره هوشمندی گفتار"
            className="p-1.5 rounded border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Sub-navigation */}
        <nav
          aria-label="بخش‌های هوشمندی گفتار"
          className="flex flex-wrap items-center gap-1.5 px-5 py-2.5 border-b border-[#252F42] bg-[#111827]"
        >
          {(
            [
              { id: 'orchestrator_dag', label: 'ارکستراتور DAG و رضایت‌نامه', icon: GitBranch },
              { id: 'diarization_alignment', label: 'تفکیک گوینده و هم‌ترازی', icon: Users },
              { id: 'translation_subtitles', label: 'ترجمه و زیرنویس (SRT/VTT)', icon: FileText },
              { id: 'meeting_extraction', label: 'هوش جلسه و استخراج ساختاریافته', icon: ShieldCheck },
              { id: 'analytics_search', label: 'تحلیل مکالمه و جستجوی معنایی', icon: Search },
              { id: 'realtime_connectors', label: 'رویداد زنده و اتصالات سازمانی', icon: Radio },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`intel-tab-${t.id}`}
                onClick={() => setActiveTab(t.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-emerald-400 text-slate-950 font-semibold'
                    : 'bg-[#172030] text-slate-300 hover:bg-[#1F2A3E] border border-[#252F42]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>

        {notice && (
          <div className="mx-5 mt-3 px-3.5 py-2 rounded border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-200 flex items-center justify-between">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-emerald-300 cursor-pointer">
              بستن
            </button>
          </div>
        )}

        {/* Main Scrollable Viewport */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {activeTab === 'orchestrator_dag' && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      انتخاب قابلیت‌های گراف DAG و کنترل رضایت‌نامه تفکیک‌شده (بند ۱۷)
                    </h3>
                    <p className="text-slate-400">
                      ترجمه، تحلیل یا استخراج هرگز متن اصلی ASR را بازنویسی نمی‌کند و برای هر قابلیت اجازه مجزا لازم است.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={recordingId}
                      onChange={(e) => setRecordingId(e.target.value)}
                      aria-label="شناسه ضبط"
                      className="px-2.5 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] font-mono text-xs"
                    />
                    <button
                      type="button"
                      data-testid="btn-run-intel-dag"
                      disabled={isRunning}
                      onClick={handleRunDagJob}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-emerald-400 text-slate-950 font-semibold hover:bg-emerald-300 cursor-pointer disabled:opacity-50"
                    >
                      <Play className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{isRunning ? 'در حال اجرا...' : 'اجرای پایپ‌لاین هوشمندی'}</span>
                    </button>
                  </div>
                </div>

                {/* Consent toggles */}
                <div className="flex flex-wrap gap-4 pt-2 border-t border-[#252F42] text-slate-300">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={consent.allowDiarization}
                      onChange={(e) => setConsent({ ...consent, allowDiarization: e.target.checked })}
                    />
                    <span>مجوز تفکیک گوینده</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={consent.allowTranslation}
                      onChange={(e) => setConsent({ ...consent, allowTranslation: e.target.checked })}
                    />
                    <span>مجوز ترجمه</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={consent.allowMeetingIntelligence}
                      onChange={(e) => setConsent({ ...consent, allowMeetingIntelligence: e.target.checked })}
                    />
                    <span>مجوز هوش جلسه</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={consent.allowEmbeddings}
                      onChange={(e) => setConsent({ ...consent, allowEmbeddings: e.target.checked })}
                    />
                    <span>مجوز ایندکس معنایی</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={consent.allowModelTraining}
                      onChange={(e) => setConsent({ ...consent, allowModelTraining: e.target.checked })}
                    />
                    <span>اجازه آموزش مدل (پیش‌فرض: غیرفعال)</span>
                  </label>
                </div>
              </div>

              {/* Capability Registry Matrix */}
              <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                <table className="w-full text-right">
                  <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                    <tr>
                      <th className="p-2.5">انتخاب</th>
                      <th className="p-2.5">شناسه قابلیت</th>
                      <th className="p-2.5">وضعیت کیفیت</th>
                      <th className="p-2.5">استخر ایزوله</th>
                      <th className="p-2.5">وابستگی‌ها</th>
                      <th className="p-2.5">وضعیت در G0_CPU_ONLY</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                    {capabilities.map((cap) => (
                      <tr key={cap.capabilityId}>
                        <td className="p-2.5">
                          <input
                            type="checkbox"
                            aria-label={`انتخاب ${cap.capabilityId}`}
                            checked={selectedCaps.includes(cap.capabilityId)}
                            onChange={() => toggleCapability(cap.capabilityId)}
                          />
                        </td>
                        <td className="p-2.5 font-mono text-emerald-300">{cap.capabilityId}</td>
                        <td className="p-2.5 font-mono">
                          <span className={cap.qualityStatus === 'VERIFIED' ? 'text-emerald-400' : 'text-amber-300'}>
                            {cap.qualityStatus}
                          </span>
                        </td>
                        <td className="p-2.5 font-mono text-slate-300">{cap.workerPool}</td>
                        <td className="p-2.5 font-mono text-slate-400">
                          {cap.dependencies.length > 0 ? cap.dependencies.join(', ') : '—'}
                        </td>
                        <td className="p-2.5 font-mono text-sky-300">{cap.availabilityStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {job && (
                <div
                  data-testid="intel-job-summary"
                  className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                    <span className="text-emerald-300">Job: {job.jobId}</span>
                    <span>Status: {job.status}</span>
                    <span className="tabular-nums">Actual Cost: {job.totalActualCostMinor}¢ USD</span>
                    <span className="tabular-nums">Artifacts Produced: {artifacts.length}</span>
                  </div>
                  {job.failedCapabilities.length > 0 && (
                    <div className="text-amber-300 font-mono">
                      Partial Failures: {job.failedCapabilities.map((f) => `${f.capabilityId} (${f.errorCode})`).join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {activeTab === 'diarization_alignment' && (
            <section className="space-y-4 text-xs">
              {!diarArtifact && !alignArtifact ? (
                <div className="p-6 rounded-lg border border-[#252F42] bg-[#141B27] text-center space-y-2">
                  <p className="text-slate-300">هنوز خروجی دیارایزیشن یا هم‌ترازی برای این جلسه اجرا نشده است.</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('orchestrator_dag')}
                    className="px-3.5 py-1.5 rounded bg-emerald-400 text-slate-950 font-semibold cursor-pointer"
                  >
                    بازگشت به اجرای DAG
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2.5">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-100">تفکیک گوینده ناشناس (بدون شناسایی بیومتریک)</h3>
                      <span className="font-mono text-emerald-400">
                        biometricIdentity: {String(diarArtifact?.biometricIdentityClaimed ?? false)}
                      </span>
                    </div>
                    <div className="space-y-1.5 font-mono">
                      {(diarArtifact?.segments ?? []).map((s) => (
                        <div key={s.segmentId} className="p-2 rounded bg-[#0B0F17] border border-[#252F42] flex justify-between tabular-nums">
                          <span className="text-sky-300">{s.speakerId}</span>
                          <span>{s.startSec}s → {s.endSec}s</span>
                          <span>{s.overlap ? 'OVERLAP' : 'SINGLE'}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2.5">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-100">هم‌ترازی اجباری کلمه‌به‌کلمه (Forced Alignment)</h3>
                      <span className="font-mono text-amber-300 tabular-nums">
                        Aligned: {alignArtifact?.alignedCount ?? 0} · Unaligned: {alignArtifact?.unalignedCount ?? 0}
                      </span>
                    </div>
                    <div className="max-h-72 overflow-y-auto space-y-1 font-mono">
                      {(alignArtifact?.words ?? []).map((w) => (
                        <div key={w.wordId} className="p-2 rounded bg-[#0B0F17] border border-[#252F42] flex justify-between gap-2 tabular-nums">
                          <span className="text-slate-100" dir="auto">{w.originalToken}</span>
                          <span className={w.alignmentStatus === 'ALIGNED' ? 'text-emerald-400' : 'text-rose-400'}>
                            {w.alignmentStatus}
                          </span>
                          <span className="text-slate-400">
                            {w.startSec !== null ? `${w.startSec}s - ${w.endSec}s` : w.unalignedReason}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {activeTab === 'translation_subtitles' && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-100">خروجی ترجمه مجزا از متن اصلی (FA ↔ EN)</h3>
                  <span className="font-mono text-slate-400">
                    Adapter: {transArtifact?.adapterStatus ?? 'NOT_RUN'} · sourcePreserved: true
                  </span>
                </div>
                {(transArtifact?.segments ?? []).map((seg, i) => (
                  <div key={i} className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42] space-y-1">
                    <div className="text-slate-300" dir="auto">{seg.sourceText}</div>
                    <div className="text-emerald-300 font-mono" dir="ltr">{seg.translatedText}</div>
                    <div className="text-[11px] font-mono text-slate-400">
                      Numbers: [{seg.preservedNumbers.join(', ')}] · Negation Parity: {String(seg.negationPreserved)}
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-100">تولید زیرنویس استاندارد Unicode-Bidi (SRT / VTT / JSON / TXT)</h3>
                  <div className="flex gap-1.5">
                    {(['srt', 'vtt', 'json', 'txt'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() => setSubtitlePreviewFormat(fmt)}
                        className={`px-2.5 py-1 rounded font-mono uppercase cursor-pointer ${
                          subtitlePreviewFormat === fmt ? 'bg-emerald-400 text-slate-950 font-semibold' : 'bg-[#0B0F17] text-slate-300'
                        }`}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </div>
                <pre
                  data-testid="intel-subtitle-export"
                  dir="ltr"
                  className="p-3 rounded bg-[#0B0F17] border border-[#252F42] font-mono text-[11px] overflow-x-auto max-h-60 text-slate-200"
                >
                  {subArtifact?.exports[subtitlePreviewFormat] ?? 'ابتدا پایپ‌لاین هوشمندی را اجرا کنید.'}
                </pre>
              </div>
            </section>
          )}

          {activeTab === 'meeting_extraction' && (
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-100">هوش جلسه مستند به شواهد (بند ۹)</h3>
                  <span className="font-mono text-amber-300">
                    Requires Review: {String(meetingArtifact?.requiresCustomerReview ?? true)}
                  </span>
                </div>
                <div className="font-mono text-slate-400">
                  Prompt Injections Neutralized: {meetingArtifact?.promptInjectionAttemptsNeutralized ?? 0} · Unsupported Claims Removed: {meetingArtifact?.hallucinationCheck.unsupportedStatementsRemoved ?? 0}
                </div>
                <div className="space-y-2">
                  {(meetingArtifact?.summary ?? []).map((st, idx) => (
                    <div key={idx} className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42] space-y-1">
                      <div className="text-slate-200">{st.text}</div>
                      <div className="font-mono text-[11px] text-emerald-400">
                        [{st.observationClass}] Evidence: {st.evidence.map((e) => `${e.segmentId}@${e.startSec}-${e.endSec}s`).join(', ')}
                      </div>
                    </div>
                  ))}
                  {(meetingArtifact?.actionItems ?? []).map((act, idx) => (
                    <div key={idx} className="p-2.5 rounded bg-[#0B0F17] border border-amber-500/30 space-y-1">
                      <div className="text-amber-200">Action: {act.description}</div>
                      <div className="font-mono text-[11px] text-slate-400">
                        Assignee: {act.assigneeStatus} ({act.responsibleSpeakerId ?? 'unknown'}) · Due: {act.dueDateStatus} ({act.dueDateRawText ?? '—'})
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-100">استخراج اطلاعات ساختاریافته (بند ۱۲)</h3>
                  <span className="font-mono text-amber-300 tabular-nums">
                    Ambiguous/Review: {extractionArtifact?.ambiguousOrReviewCount ?? 0}
                  </span>
                </div>
                <div className="space-y-1.5 font-mono">
                  {(extractionArtifact?.items ?? []).map((it, idx) => (
                    <div key={idx} className="p-2 rounded bg-[#0B0F17] border border-[#252F42] flex justify-between gap-2">
                      <span className="text-sky-300">{it.fieldType}</span>
                      <span className="text-slate-200 truncate">{String(it.extractedValue ?? it.originalTextSpan)}</span>
                      <span className={it.validationStatus === 'VALID' ? 'text-emerald-400' : 'text-amber-300'}>
                        {it.validationStatus}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {activeTab === 'analytics_search' && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-100">
                    سنجش عملیاتی مکالمه (غیرروان‌شناختی · بدون برچسب احساسات)
                  </h3>
                  <span className="font-mono text-emerald-400">
                    PsychInferenceBlocked: {String(!(analyticsArtifact?.psychologicalOrBiometricInferencesAllowed ?? false))}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 font-mono tabular-nums">
                  <div className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42]">
                    <div className="text-slate-400">مدت کل</div>
                    <div className="text-sm text-slate-100">{analyticsArtifact?.totalDurationSec ?? 0}s</div>
                  </div>
                  <div className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42]">
                    <div className="text-slate-400">مدت سکوت</div>
                    <div className="text-sm text-slate-100">{analyticsArtifact?.silenceDurationSec ?? 0}s</div>
                  </div>
                  <div className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42]">
                    <div className="text-slate-400">هم‌پوشانی</div>
                    <div className="text-sm text-slate-100">{analyticsArtifact?.overlapDurationSec ?? 0}s</div>
                  </div>
                  <div className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42]">
                    <div className="text-slate-400">تعداد پرسش</div>
                    <div className="text-sm text-slate-100">{analyticsArtifact?.questionCount ?? 0}</div>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-100">جستجوی معنایی و لغوی با ایزوله‌سازی مستأجر و حذف زنجیره‌ای</h3>
                  <button
                    type="button"
                    data-testid="btn-cascade-delete-rec"
                    onClick={handleCascadeDelete}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-rose-500/40 bg-rose-500/15 text-rose-200 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>حذف زنجیره‌ای ضبط و ایندکس</span>
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    data-testid="input-semantic-search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="جستجوی معنایی متن گفتار"
                    className="flex-1 px-3 py-2 rounded border border-[#252F42] bg-[#0B0F17]"
                  />
                  <button
                    type="button"
                    data-testid="btn-run-semantic-search"
                    onClick={handleSemanticSearch}
                    className="px-4 py-2 rounded bg-emerald-400 text-slate-950 font-semibold cursor-pointer"
                  >
                    جستجو
                  </button>
                </div>
                <div data-testid="semantic-search-results" className="space-y-1.5">
                  {searchResults.map((r) => (
                    <div key={`${r.recordingId}-${r.segmentId}`} className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42] space-y-1">
                      <div className="text-slate-200">{r.transcriptText}</div>
                      <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                        {r.segmentId} ({r.startSec}s–{r.endSec}s) · Method: {r.retrievalMethod} · Sim: {r.similarityScore} ({r.similarityNotice})
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {activeTab === 'realtime_connectors' && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-slate-100">
                      رویدادهای زنده هوشمندی گفتار و حفاظت از تاخیر ASR (بند ۱۳)
                    </h3>
                    <p className="text-slate-400">
                      در زمان بار اضافی یا شکست زیرساخت ترجمه زنده، جریان اصلی ASR هرگز متوقف نمی‌شود.
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="btn-run-realtime-intel"
                    onClick={handleRunRealtimeSim}
                    className="px-4 py-2 rounded bg-emerald-400 text-slate-950 font-semibold cursor-pointer"
                  >
                    اجرای تست رویداد زنده و Backpressure
                  </button>
                </div>
                {realtimeStatusNote && (
                  <div data-testid="realtime-intel-status" className="p-2.5 rounded bg-[#0B0F17] border border-emerald-500/30 font-mono text-emerald-300">
                    {realtimeStatusNote}
                  </div>
                )}
                <div dir="ltr" className="max-h-48 overflow-y-auto space-y-1 font-mono text-[11px] text-left">
                  {realtimeEvents.map((ev) => (
                    <div key={ev.eventId} dir="ltr" className="p-2 rounded bg-[#0B0F17] border border-[#252F42] flex items-center justify-between gap-3 text-left">
                      <span className="text-sky-300 shrink-0">#{ev.sequenceNumber} {ev.eventType}</span>
                      <code className="text-slate-300 truncate">{JSON.stringify(ev.payload)}</code>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2.5">
                <h3 className="font-semibold text-slate-100">اتصالات سازمانی (Object Storage / OIDC SSO / Event Bus)</h3>
                {connectors.map((c) => (
                  <div key={c.connectorId} dir="ltr" className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42] flex flex-wrap items-center justify-between gap-2 font-mono text-left">
                    <span className="text-slate-100">{c.name} ({c.kind})</span>
                    <span className="text-amber-300">{c.status}</span>
                    <span className="w-full text-slate-400">{c.blockerReason}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
