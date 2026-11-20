import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  GitBranch,
  KeyRound,
  Layers,
  Lock,
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

const SANDBOX_REQUESTED_WITH_HEADER = 'AvapardazSandbox';

export const SpeechIntelligenceModal: React.FC<SpeechIntelligenceModalProps> = ({
  isOpen,
  onClose,
  studioTranscriptSegments,
}) => {
  const isDevEnvironment = Boolean(import.meta.env.DEV);

  // Kept strictly in React component memory — NEVER persisted to localStorage, sessionStorage, cookies, or URL
  const [sandboxAccessToken, setSandboxAccessToken] = useState('');
  const [sandboxAuthState, setSandboxAuthState] = useState<'IDLE' | 'AUTHENTICATED' | 'UNAVAILABLE' | 'DENIED'>('IDLE');

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
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [job, setJob] = useState<IntelligenceJobRecord | null>(null);
  const [artifacts, setArtifacts] = useState<SpeechArtifactRecord[]>([]);
  const [subtitlePreviewFormat, setSubtitlePreviewFormat] = useState<'srt' | 'vtt' | 'json' | 'txt'>('srt');
  const [searchQuery, setSearchQuery] = useState('TypeScript');
  const [searchResults, setSearchResults] = useState<SemanticSearchResultItem[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeIntelligenceEvent[]>([]);
  const [realtimeStatusNote, setRealtimeStatusNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Clear secret token from memory whenever modal closes or unmounts
  useEffect(() => {
    if (!isOpen) {
      setSandboxAccessToken('');
      setSandboxAuthState('IDLE');
      setConfirmDeleteOpen(false);
    }
    return () => {
      setSandboxAccessToken('');
    };
  }, [isOpen]);

  const handleCloseModal = useCallback(() => {
    setSandboxAccessToken('');
    setSandboxAuthState('IDLE');
    setConfirmDeleteOpen(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCloseModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleCloseModal]);

  const sandboxFetch = useCallback(
    async (
      path: string,
      options: {
        method?: 'GET' | 'POST' | 'DELETE';
        body?: unknown;
        extraHeaders?: Record<string, string>;
      } = {}
    ): Promise<Response | null> => {
      if (!isDevEnvironment) {
        setSandboxAuthState('UNAVAILABLE');
        setNotice('محیط سندباکس هوشمندی گفتار فقط در حالت توسعه در دسترس است و در محیط تولید غیرفعال است.');
        return null;
      }

      const trimmedToken = sandboxAccessToken.trim();
      if (!trimmedToken) {
        setSandboxAuthState('DENIED');
        setNotice('برای فراخوانی سرویس سندباکس توسعه، وارد کردن توکن دسترسی سندباکس (Bearer) الزامی است.');
        return null;
      }

      const method = options.method ?? 'GET';
      const headers: Record<string, string> = {
        Authorization: `Bearer ${trimmedToken}`,
        ...(options.extraHeaders ?? {}),
      };
      if (method !== 'GET') {
        headers['X-Requested-With'] = SANDBOX_REQUESTED_WITH_HEADER;
      }
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const res = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });

      if (res.status === 401) {
        setSandboxAuthState('DENIED');
        setNotice('احراز هویت ناموفق (۴۰۱): توکن دسترسی سندباکس نامعتبر یا منقضی است.');
      } else if (res.status === 403) {
        setSandboxAuthState('DENIED');
        setNotice('دسترسی مسدود شد (۴۰۳): سیاست هم‌منشأ (Same-Origin) یا هدر امنیتی معتبر نیست.');
      } else if (res.status === 404 || res.status === 503) {
        setSandboxAuthState('UNAVAILABLE');
        setNotice(
          res.status === 404
            ? 'سرویس سندباکس هوشمندی گفتار روی سرور غیرفعال است (۴۰۴).'
            : 'سرویس سندباکس فعال است اما توکن سرور پیکربندی نشده یا ضعیف است (۵۰۳).'
        );
      } else if (res.status === 429) {
        setNotice('محدودیت نرخ درخواست فعال شد (۴۲۹). لطفاً پس از چند لحظه مجدداً تلاش کنید.');
      } else if (res.ok) {
        setSandboxAuthState('AUTHENTICATED');
      }

      return res;
    },
    [isDevEnvironment, sandboxAccessToken]
  );

  const loadOverview = async () => {
    setNotice(null);
    try {
      const res = await sandboxFetch('/api/v1/intelligence/sandbox/overview', { method: 'GET' });
      if (!res) return;
      if (res.ok) {
        const data = (await res.json()) as {
          capabilities: CapabilityDescriptor[];
          connectors: EnterpriseConnectorRecord[];
        };
        setCapabilities(data.capabilities);
        setConnectors(data.connectors);
        setNotice('اتصال به سندباکس توسعه با موفقیت برقرار شد.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در ارتباط با سرویس هوش گفتار: ${msg}`);
    }
  };

  if (!isOpen) return null;

  const hasToken = sandboxAccessToken.trim().length > 0;
  const controlsDisabled = !isDevEnvironment || !hasToken;

  const toggleCapability = (capId: SpeechCapabilityId) => {
    setSelectedCaps((prev) =>
      prev.includes(capId) ? prev.filter((c) => c !== capId) : [...prev, capId]
    );
  };

  const handleRunDagJob = async () => {
    if (controlsDisabled || isRunning) return;
    setIsRunning(true);
    setNotice(null);
    try {
      const segmentsPayload =
        studioTranscriptSegments.length > 0
          ? studioTranscriptSegments.slice(0, 8)
          : undefined;
      const res = await sandboxFetch('/api/v1/intelligence/sandbox/run-dag', {
        method: 'POST',
        body: {
          recordingId,
          segments: segmentsPayload,
          capabilities: selectedCaps,
          consent,
        },
      });
      if (!res) return;
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
      } else if (![401, 403, 404, 429, 503].includes(res.status)) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
        setNotice(`خطا در اجرای پایپ‌لاین DAG (کد ${res.status}): ${err.error?.message ?? err.message ?? 'پاسخ نامعتبر'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در اجرای پایپ‌لاین DAG: ${msg}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleSemanticSearch = async () => {
    if (controlsDisabled) return;
    setNotice(null);
    try {
      const res = await sandboxFetch('/api/v1/intelligence/sandbox/search', {
        method: 'POST',
        body: { recordingId, query: searchQuery },
      });
      if (!res) return;
      if (res.ok) {
        const data = (await res.json()) as { results: SemanticSearchResultItem[] };
        setSearchResults(data.results);
      } else if (![401, 403, 404, 429, 503].includes(res.status)) {
        setNotice(`خطا در جستجوی معنایی (کد ${res.status}).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در جستجوی معنایی: ${msg}`);
    }
  };

  const handleConfirmedCascadeDelete = async () => {
    if (controlsDisabled || isDeleting) return;
    setIsDeleting(true);
    setNotice(null);
    try {
      const trimmedRecordingId = recordingId.trim();
      const res = await sandboxFetch(
        `/api/v1/intelligence/sandbox/recordings/${encodeURIComponent(trimmedRecordingId)}`,
        {
          method: 'DELETE',
          extraHeaders: {
            'X-Confirm-Recording-Id': trimmedRecordingId,
          },
        }
      );
      if (!res) return;
      if (res.ok) {
        const data = (await res.json()) as { deletedArtifactsCount: number; deletedVectorsCount: number };
        setArtifacts([]);
        setSearchResults([]);
        setConfirmDeleteOpen(false);
        setNotice(
          `حذف زنجیره‌ای انجام شد: ${data.deletedArtifactsCount} آرتیفکت مشتق و ${data.deletedVectorsCount} بردار جستجو با حفظ جداسازی مستأجر پاک شدند.`
        );
      } else if (![401, 403, 404, 429, 503].includes(res.status)) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setNotice(`خطا در حذف زنجیره‌ای آرتیفکت‌ها (کد ${res.status}): ${err.error?.message ?? ''}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در حذف زنجیره‌ای: ${msg}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRunRealtimeSim = async () => {
    if (controlsDisabled) return;
    setNotice(null);
    try {
      const res = await sandboxFetch('/api/v1/intelligence/sandbox/realtime-sim', { method: 'POST' });
      if (!res) return;
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
      } else if (![401, 403, 404, 429, 503].includes(res.status)) {
        setNotice(`خطا در شبیه‌سازی جریان زنده (کد ${res.status}).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`خطا در شبیه‌سازی جریان زنده: ${msg}`);
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
                معماری ماژولار بر پایه هسته تغییرناپذیر ASR · شواهد مستند به بازه زمانی · دسترسی سندباکس احراز هویت‌شده
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCloseModal}
            aria-label="بستن پنجره هوشمندی گفتار"
            className="p-1.5 rounded border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Sandbox Security Gate Banner */}
        <div className="px-5 py-3 border-b border-[#252F42] bg-[#0C121D] text-xs">
          {!isDevEnvironment ? (
            <div
              data-testid="sandbox-production-disabled-notice"
              className="flex items-center gap-2 text-amber-300"
            >
              <Lock className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                سندباکس هوشمندی گفتار صرفاً برای محیط توسعه (Development) است و در نسخه تولید غیرفعال شده است. برای عملیات واقعی از مسیر احراز هویت‌شده <code dir="ltr" className="font-mono">/v1/*</code> استفاده کنید.
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-slate-300">
                <KeyRound className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                <label htmlFor="sandbox-access-token-input" className="font-semibold whitespace-nowrap">
                  Development Sandbox Access Token
                </label>
                <span className="text-slate-400 hidden lg:inline">
                  (فقط در حافظه موقت؛ پس از بستن پنجره پاک می‌شود)
                </span>
              </div>
              <div className="flex items-center gap-2 flex-1 max-w-xl justify-end">
                <input
                  id="sandbox-access-token-input"
                  data-testid="input-sandbox-access-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={sandboxAccessToken}
                  onChange={(e) => {
                    setSandboxAccessToken(e.target.value);
                    if (sandboxAuthState !== 'IDLE') setSandboxAuthState('IDLE');
                  }}
                  placeholder="INTELLIGENCE_SANDBOX_TOKEN (حداقل ۳۲ بایت)"
                  dir="ltr"
                  className="flex-1 min-w-[220px] px-2.5 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] font-mono text-xs text-slate-100"
                />
                <button
                  type="button"
                  data-testid="btn-connect-sandbox"
                  disabled={!hasToken}
                  onClick={loadOverview}
                  className="px-3 py-1.5 rounded bg-emerald-400 text-slate-950 font-semibold hover:bg-emerald-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  اتصال و بارگذاری نمای کلی
                </button>
              </div>
            </div>
          )}
        </div>

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
          <div
            data-testid="sandbox-notice"
            className="mx-5 mt-3 px-3.5 py-2 rounded border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-200 flex items-center justify-between"
          >
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
                      disabled={controlsDisabled || isRunning}
                      onClick={handleRunDagJob}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-emerald-400 text-slate-950 font-semibold hover:bg-emerald-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
                    {capabilities.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-slate-400">
                          {isDevEnvironment
                            ? 'برای مشاهده فهرست قابلیت‌ها، توکن سندباکس را وارد کرده و دکمه «اتصال و بارگذاری نمای کلی» را بزنید.'
                            : 'نمای سندباکس در محیط تولید غیرفعال است.'}
                        </td>
                      </tr>
                    ) : (
                      capabilities.map((cap) => (
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
                      ))
                    )}
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
                    disabled={controlsDisabled || isDeleting}
                    onClick={() => setConfirmDeleteOpen(true)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-rose-500/40 bg-rose-500/15 text-rose-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>حذف زنجیره‌ای ضبط و ایندکس</span>
                  </button>
                </div>

                {confirmDeleteOpen && (
                  <div
                    data-testid="confirm-cascade-delete-box"
                    className="p-3 rounded border border-rose-500/50 bg-rose-950/30 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2 text-rose-200">
                      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>
                        آیا از حذف زنجیره‌ای تمام آرتیفکت‌ها و بردارهای معنایی برای شناسه{' '}
                        <code dir="ltr" className="font-mono text-rose-100 px-1 py-0.5 rounded bg-rose-900/50">
                          {recordingId.trim()}
                        </code>{' '}
                        اطمینان دارید؟
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="btn-cancel-cascade-delete"
                        disabled={isDeleting}
                        onClick={() => setConfirmDeleteOpen(false)}
                        className="px-3 py-1 rounded border border-[#252F42] bg-[#0B0F17] text-slate-300 cursor-pointer"
                      >
                        انصراف
                      </button>
                      <button
                        type="button"
                        data-testid="btn-confirm-cascade-delete"
                        disabled={isDeleting}
                        onClick={handleConfirmedCascadeDelete}
                        className="px-3 py-1 rounded bg-rose-600 text-white font-semibold hover:bg-rose-500 cursor-pointer disabled:opacity-50"
                      >
                        {isDeleting ? 'در حال حذف...' : 'تأیید حذف دائمی'}
                      </button>
                    </div>
                  </div>
                )}

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
                    disabled={controlsDisabled}
                    onClick={handleSemanticSearch}
                    className="px-4 py-2 rounded bg-emerald-400 text-slate-950 font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
                    disabled={controlsDisabled}
                    onClick={handleRunRealtimeSim}
                    className="px-4 py-2 rounded bg-emerald-400 text-slate-950 font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
