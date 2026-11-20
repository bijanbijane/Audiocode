import React, { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Code2,
  Copy,
  CreditCard,
  Globe2,
  KeyRound,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import type {
  ApiCredentialRecord,
  AuthoritativeUsageEvent,
  ImmutableBillingLedgerEntry,
  ImmutableInvoiceRecord,
  PlatformAuditLogEntry,
  PlatformOrganization,
  PlatformPlanCatalogEntry,
  PlatformProject,
  PlatformRegionRecord,
  PublicModelCatalogEntry,
  TenantSubscriptionRecord,
  WebhookDeliveryRecord,
} from '../platform/PlatformContractsAndSchemas';

export type PortalTabId =
  | 'overview'
  | 'keys_projects'
  | 'playground_sdks'
  | 'usage_billing'
  | 'webhooks'
  | 'enterprise_regions';

interface PortalOverviewPayload {
  organization: PlatformOrganization | null;
  subscription: TenantSubscriptionRecord | null;
  plan: PlatformPlanCatalogEntry | null;
  plans: PlatformPlanCatalogEntry[];
  projects: PlatformProject[];
  credentials: Array<Omit<ApiCredentialRecord, 'secretHash'>>;
  usageEvents: AuthoritativeUsageEvent[];
  ledgerEntries: ImmutableBillingLedgerEntry[];
  invoices: ImmutableInvoiceRecord[];
  webhookEndpoints: Array<{
    endpointId: string;
    organizationId: string;
    url: string;
    eventSubscriptions: string[];
    active: boolean;
    signingSecretMasked: string;
    createdAtIso: string;
  }>;
  webhookDeliveries: WebhookDeliveryRecord[];
  reconciliation: {
    balanced: boolean;
    usageEventTotalMinor: number;
    ledgerConsumptionMinor: number;
    discrepancyMinor: number;
    eventCount: number;
  };
  regions: PlatformRegionRecord[];
  models: PublicModelCatalogEntry[];
  auditLogs: PlatformAuditLogEntry[];
}

interface DeveloperPlatformPortalModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DeveloperPlatformPortalModal: React.FC<DeveloperPlatformPortalModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<PortalTabId>('overview');
  const [overview, setOverview] = useState<PortalOverviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // API Keys & Projects state
  const [newKeyName, setNewKeyName] = useState('Studio Client Integration Key');
  const [newProjectName, setNewProjectName] = useState('');
  const [issuedSecretOnce, setIssuedSecretOnce] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Interactive API Playground state
  const [playgroundModel, setPlaygroundModel] = useState('asr-fa-en-v1');
  const [playgroundIdempKey, setPlaygroundIdempKey] = useState(() => `idemp-${Date.now()}`);
  const [playgroundDurationMs, setPlaygroundDurationMs] = useState(12500);
  const [playgroundRawHint, setPlaygroundRawHint] = useState(
    'امروز سرویس Backend و تایپ اسکریپت را در پلتفرم آوا پرداز اجرا می کنیم'
  );
  const [estimateResult, setEstimateResult] = useState<Record<string, unknown> | null>(null);
  const [apiPlayResult, setApiPlayResult] = useState<Record<string, unknown> | null>(null);
  const [sdkLangTab, setSdkLangTab] = useState<'ts' | 'py'>('ts');

  // Webhooks state
  const [webhookUrl, setWebhookUrl] = useState('https://sandbox.avapardaz.local/hooks/asr');

  // Region check state
  const [selectedTestRegion, setSelectedTestRegion] = useState('ir-thr-01');
  const [regionCheckResult, setRegionCheckResult] = useState<{
    allowed: boolean;
    message: string;
  } | null>(null);

  const loadOverview = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/platform/overview');
      if (res.ok) {
        const data = (await res.json()) as PortalOverviewPayload;
        setOverview(data);
      } else {
        setNotice(`خطا در بارگذاری نمای کلی پورتال توسعه‌دهندگان (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در ارتباط با پورتال توسعه‌دهندگان: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadOverview();
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

  const handleIssueApiKey = async () => {
    try {
      const projectId = overview?.projects[0]?.id ?? 'prj_avapardaz_dev_01';
      const res = await fetch('/api/v1/platform/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          name: newKeyName,
          scopes: ['audio:transcribe', 'audio:stream', 'transcripts:read', 'models:read', 'usage:read'],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { plaintextSecretOnce: string };
        setIssuedSecretOnce(data.plaintextSecretOnce);
        setCopiedKey(false);
        setNotice('کلید جدید صادر شد. مقدار Secret فقط همین یک‌بار نمایش داده می‌شود و در سرور فقط هش HMAC نگهداری می‌شود.');
        await loadOverview();
      } else {
        setNotice(`خطا در صدور کلید API (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در صدور کلید API: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRotateKey = async (credId: string) => {
    try {
      const res = await fetch(`/api/v1/platform/api-keys/${credId}/rotate`, { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as { plaintextSecretOnce: string };
        setIssuedSecretOnce(data.plaintextSecretOnce);
        setCopiedKey(false);
        setNotice('چرخش کلید انجام شد؛ کلید قبلی با پنجره هم‌پوشانی ۲۴ ساعته فعال می‌ماند.');
        await loadOverview();
      } else {
        setNotice(`خطا در چرخش کلید API (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در چرخش کلید API: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRevokeKey = async (credId: string) => {
    try {
      const res = await fetch(`/api/v1/platform/api-keys/${credId}/revoke`, { method: 'POST' });
      if (res.ok) {
        setNotice('کلید بلافاصله باطل شد و هر درخواست با آن با کد 401 رد می‌شود.');
        await loadOverview();
      } else {
        setNotice(`خطا در ابطال کلید API (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در ابطال کلید API: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    try {
      const res = await fetch('/api/v1/platform/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: newProjectName, environment: 'DEVELOPMENT' }),
      });
      if (res.ok) {
        setNewProjectName('');
        setNotice('پروژه جدید با جداسازی محیطی و ردیابی مصرف مستقل ایجاد شد.');
        await loadOverview();
      } else {
        setNotice(`خطا در ایجاد پروژه جدید (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در ایجاد پروژه جدید: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleEstimateApiCost = async () => {
    if (!issuedSecretOnce) {
      setNotice('ابتدا در تب «کلیدها و پروژه‌ها» یک کلید تست بسازید تا درخواست با Bearer Token واقعی ارسال شود.');
      return;
    }
    try {
      const res = await fetch('/v1/audio/estimates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${issuedSecretOnce}`,
        },
        body: JSON.stringify({
          model: playgroundModel,
          duration_seconds: Math.round(playgroundDurationMs / 1000),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setEstimateResult(json);
      if (!res.ok) {
        setNotice(`برآورد هزینه با کد ${res.status} بازگشت.`);
      }
    } catch (err) {
      setNotice(`خطا در برآورد هزینه API: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleExecutePlaygroundTranscription = async () => {
    if (!issuedSecretOnce) {
      setNotice('ابتدا یک کلید API در تب کلیدها بسازید.');
      return;
    }
    try {
      const res = await fetch('/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${issuedSecretOnce}`,
          'Idempotency-Key': playgroundIdempKey,
        },
        body: JSON.stringify({
          model: playgroundModel,
          language: 'fa-en',
          timestamps: true,
          domain_profile: 'technology',
          audio_duration_ms: playgroundDurationMs,
          raw_text_hint: playgroundRawHint,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setApiPlayResult(json);
      if (!res.ok) {
        setNotice(`اجرای درخواست رونویسی API با کد ${res.status} بازگشت.`);
      }
      await loadOverview();
    } catch (err) {
      setNotice(`خطا در اجرای درخواست رونویسی API: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleIssueInvoice = async () => {
    try {
      const res = await fetch('/api/v1/platform/invoices/issue', { method: 'POST' });
      if (res.ok) {
        setNotice('فاکتور تغییرناپذیر با اسنپ‌شات قیمت‌گذاری و هش SHA-256 صادر شد.');
        await loadOverview();
      } else {
        setNotice(`خطا در صدور فاکتور (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در صدور فاکتور: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRegisterWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/v1/platform/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          eventSubscriptions: ['transcription.completed', 'transcription.failed'],
        }),
      });
      if (res.ok) {
        setNotice('نقطه انتهایی Webhook با کلید امضای HMAC-SHA256 ثبت شد.');
        await loadOverview();
      } else {
        setNotice(`خطا در ثبت Webhook (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در ثبت Webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDispatchWebhook = async (simulateFailure: boolean) => {
    try {
      const res = await fetch('/api/v1/platform/webhooks/test-dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulateFailure }),
      });
      if (res.ok) {
        setNotice(
          simulateFailure
            ? 'رویداد تست پس از ۶ تلاش به Dead-Letter Queue منتقل شد.'
            : 'رویداد امضاشده (t=..., v1=...) ارسال شد.'
        );
        await loadOverview();
      } else {
        setNotice(`خطا در ارسال رویداد تست Webhook (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در ارسال رویداد تست Webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReplayWebhook = async (deliveryId: string) => {
    try {
      const res = await fetch(`/api/v1/platform/webhooks/${deliveryId}/replay`, { method: 'POST' });
      if (res.ok) {
        setNotice('رویداد DLQ با حفظ شناسه اصلی Event دوباره ارسال شد.');
        await loadOverview();
      } else {
        setNotice(`خطا در بازپخش رویداد DLQ (کد ${res.status}).`);
      }
    } catch (err) {
      setNotice(`خطا در بازپخش رویداد DLQ: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleTestRegionResidency = async () => {
    try {
      const res = await fetch('/api/v1/platform/region-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regionId: selectedTestRegion }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        allowed?: boolean;
        region?: { regionId: string };
        errorEnvelope?: { error?: { code: string; message: string } };
      };
      if (res.ok && json.allowed) {
        setRegionCheckResult({
          allowed: true,
          message: `منطقه ${json.region?.regionId} مجاز و فعال است (Single-Region G0).`,
        });
      } else {
        setRegionCheckResult({
          allowed: false,
          message: `رد شده طبق سیاست اقامت داده (${json.errorEnvelope?.error?.code ?? `HTTP_${res.status}`}): ${json.errorEnvelope?.error?.message ?? 'نامشخص'}`,
        });
      }
      await loadOverview();
    } catch (err) {
      setNotice(`خطا در بررسی سیاست اقامت داده: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tsSnippet = `import { ASRClient } from "@asr-platform/sdk";

const client = new ASRClient({ apiKey: process.env.ASR_API_KEY! });
const result = await client.audio.transcriptions.create({
  model: "${playgroundModel}",
  language: "fa-en",
  idempotencyKey: "${playgroundIdempKey}"
});
console.log(result.text, result.usage);`;

  const pySnippet = `from asr_platform import ASRClient

client = ASRClient(api_key=os.environ["ASR_API_KEY"])
result = client.audio.transcriptions.create(
    model="${playgroundModel}",
    language="fa-en",
    idempotency_key="${playgroundIdempKey}",
)
print(result["text"], result["usage"])`;

  const totalBilledSec =
    overview?.usageEvents.reduce((acc, u) => acc + Math.round(u.billableDurationMs / 1000), 0) ?? 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="پورتال توسعه‌دهندگان و پلتفرم API (فاز ۱۰)"
      className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5"
      dir="rtl"
    >
      <div className="w-full max-w-6xl max-h-[92vh] bg-[#0E131D] border border-[#252F42] rounded-xl shadow-2xl flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <header className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-[#252F42] bg-[#0B0F17]">
          <div className="flex items-center gap-3">
            <Terminal className="w-5 h-5 text-sky-400 shrink-0" aria-hidden="true" />
            <div>
              <h2 className="text-sm sm:text-base font-bold text-slate-100">
                پورتال توسعه‌دهندگان و اکوسیستم تجاری ASR (فاز ۱۰ — Private Alpha Sandbox)
              </h2>
              <p className="text-xs text-slate-400">
                تفکیک کامل Control Plane از هسته علمی ASR · محاسبات مالی Integer (USD Cents) · وضعیت:{' '}
                <span className="font-mono text-amber-300">ENGINEERING_COMPLETE_PRIVATE_ALPHA_READY</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadOverview()}
              aria-label="بروزرسانی اطلاعات پورتال"
              className="p-2 rounded-md border border-[#252F42] bg-[#141B27] text-slate-300 hover:text-white cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="بستن پورتال توسعه‌دهندگان"
              className="p-2 rounded-md border border-[#252F42] bg-[#141B27] text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Sub-navigation */}
        <nav
          aria-label="بخش‌های پورتال توسعه‌دهندگان"
          className="flex flex-wrap items-center gap-1.5 px-5 py-2.5 border-b border-[#252F42] bg-[#111827]"
        >
          {(
            [
              { id: 'overview', label: 'خانه و کاتالوگ مدل‌ها', icon: Activity },
              { id: 'keys_projects', label: 'کلیدهای API و پروژه‌ها', icon: KeyRound },
              { id: 'playground_sdks', label: 'آزمایشگاه API و SDKها', icon: Code2 },
              { id: 'usage_billing', label: 'مصرف، لجر مالی و فاکتور', icon: CreditCard },
              { id: 'webhooks', label: 'وب‌هوک‌ها و DLQ', icon: Webhook },
              { id: 'enterprise_regions', label: 'منطقه داده، RBAC و حسابرسی', icon: Globe2 },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`portal-tab-${t.id}`}
                onClick={() => setActiveTab(t.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-sky-400 text-slate-950 font-semibold'
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
          <div className="mx-5 mt-3 px-3.5 py-2 rounded-md border border-sky-500/30 bg-sky-500/10 text-xs text-sky-200 flex items-center justify-between">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-sky-300 cursor-pointer">
              بستن
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* TAB 1: OVERVIEW & PUBLIC MODEL CATALOG */}
          {activeTab === 'overview' && overview && (
            <section className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-slate-400">اعتبار ارزیابی باقی‌مانده</div>
                  <div className="text-lg font-bold font-mono text-emerald-400 mt-1">
                    ${((overview.subscription?.availableCreditMinor ?? 0) / 100).toFixed(2)}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-slate-400">مصرف تأییدشده (ثانیه صوت)</div>
                  <div className="text-lg font-bold font-mono text-sky-300 mt-1">{totalBilledSec}s</div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-slate-400">پروژه‌ها / کلیدهای فعال</div>
                  <div className="text-lg font-bold font-mono text-amber-300 mt-1">
                    {overview.projects.length} / {overview.credentials.filter((c) => !c.revokedAtIso).length}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-slate-400">منطقه عملیاتی فعال</div>
                  <div className="text-sm font-bold font-mono text-slate-100 mt-1">
                    {overview.organization?.defaultRegionId}
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs text-amber-200 flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <strong>تفکیک آماده بودن فنی از مجوز فروش تجاری:</strong> پرداخت بانکی زنده (PSP)، خوشه GPU برای مدل‌های سنگین و PostgreSQL مدیریت‌شده در محیط کانتینر محلی فعال نیستند؛ درگاه `/v1/*` فقط با پلن Sandbox غیرتجاری و موتور مستقل محلی (`asr-fa-en-v1`) پاسخ واقعی می‌دهد.
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                <table className="w-full text-right text-xs">
                  <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                    <tr>
                      <th className="p-2.5">شناسه مدل عمومی (`/v1/models`)</th>
                      <th className="p-2.5">وضعیت انتشار</th>
                      <th className="p-2.5">حالت‌های پشتیبانی‌شده</th>
                      <th className="p-2.5">Timestamp / Diarization</th>
                      <th className="p-2.5">در دسترس بودن در محیط فعلی</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                    {overview.models.map((m) => (
                      <tr key={m.modelId}>
                        <td className="p-2.5 font-mono text-sky-300">{m.modelId}</td>
                        <td className="p-2.5 font-mono">{m.releaseState}</td>
                        <td className="p-2.5 font-mono text-[11px]">{m.supportedModes.join(', ')}</td>
                        <td className="p-2.5 font-mono">
                          {m.timestampsSupported ? 'TS:Yes' : 'TS:No'} · {m.diarizationSupported ? 'Diar:Yes' : 'Diar:No'}
                        </td>
                        <td className="p-2.5 font-mono">
                          <span
                            className={
                              m.availabilityInCurrentContainer === 'AVAILABLE_NOW'
                                ? 'text-emerald-400'
                                : 'text-amber-300'
                            }
                          >
                            {m.availabilityInCurrentContainer}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB 2: API KEYS & PROJECTS */}
          {activeTab === 'keys_projects' && overview && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      مدیریت چرخه عمر کلیدهای API (نمایش یک‌بار مصرف + هش HMAC با Pepper سروری)
                    </h3>
                    <p className="text-slate-400">
                      کلیدهای ساخته‌شده در پروژه Development با پیشوند `asr_test_` صادر می‌شوند.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      aria-label="نام کلید API"
                      className="px-3 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] text-slate-100"
                    />
                    <button
                      type="button"
                      data-testid="btn-issue-api-key"
                      onClick={handleIssueApiKey}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300 cursor-pointer"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>صدور کلید جدید</span>
                    </button>
                  </div>
                </div>

                {issuedSecretOnce && (
                  <div
                    data-testid="issued-key-once-banner"
                    className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 flex flex-wrap items-center justify-between gap-2"
                  >
                    <div className="space-y-0.5">
                      <div className="text-emerald-300 font-semibold">
                        کلید یک‌بار مصرف صادرشده (بلافاصله کپی کنید — دیگر قابل بازیابی نیست):
                      </div>
                      <code className="block font-mono text-xs text-white break-all">{issuedSecretOnce}</code>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!navigator.clipboard?.writeText) {
                          setNotice('دسترسی خودکار کلیپ‌بورد در این محیط در دسترس نیست؛ کلید را به‌صورت دستی کپی کنید.');
                          return;
                        }
                        navigator.clipboard
                          .writeText(issuedSecretOnce)
                          .then(() => setCopiedKey(true))
                          .catch(() =>
                            setNotice('امکان کپی خودکار در کلیپ‌بورد نبود؛ لطفاً کلید را به‌صورت دستی کپی کنید.')
                          );
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#0B0F17] border border-emerald-500/40 text-emerald-200 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>{copiedKey ? 'کپی شد' : 'کپی'}</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                <table className="w-full text-right">
                  <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                    <tr>
                      <th className="p-2.5">نام</th>
                      <th className="p-2.5">شناسه عمومی</th>
                      <th className="p-2.5">محیط</th>
                      <th className="p-2.5">Scopes</th>
                      <th className="p-2.5">وضعیت</th>
                      <th className="p-2.5">عملیات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                    {overview.credentials.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-slate-400">
                          هنوز کلیدی صادر نشده است. دکمه «صدور کلید جدید» را بزنید.
                        </td>
                      </tr>
                    ) : (
                      overview.credentials.map((c) => (
                        <tr key={c.id}>
                          <td className="p-2.5 text-slate-100">{c.name}</td>
                          <td className="p-2.5 font-mono text-sky-300">
                            {c.keyPrefix}_{c.publicIdentifier}_****
                          </td>
                          <td className="p-2.5 font-mono">{c.environment}</td>
                          <td className="p-2.5 font-mono text-[11px] text-slate-400">
                            {c.scopes.join(', ')}
                          </td>
                          <td className="p-2.5 font-mono">
                            {c.revokedAtIso ? (
                              <span className="text-rose-400">REVOKED</span>
                            ) : c.overlapRevokesAtIso ? (
                              <span className="text-amber-300">ROTATING (24h Overlap)</span>
                            ) : (
                              <span className="text-emerald-400">ACTIVE</span>
                            )}
                          </td>
                          <td className="p-2.5">
                            {!c.revokedAtIso && (
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleRotateKey(c.id)}
                                  className="px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 cursor-pointer"
                                >
                                  چرخش ۲۴h
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRevokeKey(c.id)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-500/40 text-rose-300 hover:bg-rose-500/15 cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  <span>ابطال</span>
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <form onSubmit={handleCreateProject} className="p-3.5 rounded-lg border border-[#252F42] bg-[#141B27] flex flex-wrap items-center gap-2">
                <span className="text-slate-300 font-medium">ایجاد پروژه جدید:</span>
                <input
                  type="text"
                  placeholder="نام پروژه (مثلاً اپ موبایل فارسی)"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="flex-1 min-w-[200px] px-3 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] text-slate-100"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded bg-[#1E2738] border border-[#252F42] text-slate-200 hover:bg-[#273349] cursor-pointer"
                >
                  ثبت پروژه
                </button>
              </form>
            </section>
          )}

          {/* TAB 3: INTERACTIVE API PLAYGROUND & OFFICIAL SDKs */}
          {activeTab === 'playground_sdks' && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <h3 className="text-sm font-semibold text-slate-100">
                  آزمایشگاه زنده API عمومی (`POST /v1/audio/transcriptions` و برآورد هزینه قبل از اجرا)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">مدل (`/v1/models`):</label>
                    <select
                      aria-label="مدل انتخابی Playground"
                      value={playgroundModel}
                      onChange={(e) => setPlaygroundModel(e.target.value)}
                      className="w-full px-2.5 py-2 rounded border border-[#252F42] bg-[#0B0F17]"
                    >
                      <option value="asr-fa-en-v1">asr-fa-en-v1 (Stable Local)</option>
                      <option value="asr-fa-en-baseline">asr-fa-en-baseline (Beta Local)</option>
                      <option value="qwen3-asr-1.7b-fa">qwen3-asr-1.7b-fa (503 GPU Required Test)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Idempotency-Key (حفظ ۲۴ ساعته):</label>
                    <input
                      type="text"
                      value={playgroundIdempKey}
                      onChange={(e) => setPlaygroundIdempKey(e.target.value)}
                      className="w-full px-2.5 py-2 rounded border border-[#252F42] bg-[#0B0F17] font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">مدت صوت (ms):</label>
                    <input
                      type="number"
                      value={playgroundDurationMs}
                      onChange={(e) => setPlaygroundDurationMs(Number(e.target.value))}
                      className="w-full px-2.5 py-2 rounded border border-[#252F42] bg-[#0B0F17] font-mono"
                    />
                  </div>
                </div>
                <input
                  type="text"
                  value={playgroundRawHint}
                  onChange={(e) => setPlaygroundRawHint(e.target.value)}
                  aria-label="متن نمونه ورودی تست Data Plane"
                  className="w-full px-3 py-2 rounded border border-[#252F42] bg-[#0B0F17]"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="btn-estimate-api-cost"
                    onClick={handleEstimateApiCost}
                    className="px-3.5 py-2 rounded border border-[#252F42] bg-[#0B0F17] text-slate-200 hover:bg-[#1D2739] cursor-pointer"
                  >
                    ۱. پیش‌برآورد هزینه (`/v1/audio/estimates`)
                  </button>
                  <button
                    type="button"
                    data-testid="btn-execute-api-playground"
                    onClick={handleExecutePlaygroundTranscription}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>۲. ارسال درخواست واقعی `/v1/audio/transcriptions`</span>
                  </button>
                </div>

                {estimateResult && (
                  <pre className="p-2.5 rounded bg-[#0B0F17] border border-amber-500/30 font-mono text-[11px] overflow-x-auto text-amber-200" dir="ltr">
                    {JSON.stringify(estimateResult, null, 2)}
                  </pre>
                )}
                {apiPlayResult && (
                  <pre
                    data-testid="playground-api-response"
                    className="p-3 rounded bg-[#0B0F17] border border-emerald-500/30 font-mono text-[11px] overflow-x-auto text-emerald-200"
                    dir="ltr"
                  >
                    {JSON.stringify(apiPlayResult, null, 2)}
                  </pre>
                )}
              </div>

              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2.5">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-slate-100">نمونه کد رسمی SDKهای TypeScript و Python</h4>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSdkLangTab('ts')}
                      className={`px-2.5 py-1 rounded font-mono cursor-pointer ${
                        sdkLangTab === 'ts' ? 'bg-sky-400 text-slate-950' : 'bg-[#0B0F17] text-slate-300'
                      }`}
                    >
                      TypeScript (@asr-platform/sdk)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSdkLangTab('py')}
                      className={`px-2.5 py-1 rounded font-mono cursor-pointer ${
                        sdkLangTab === 'py' ? 'bg-sky-400 text-slate-950' : 'bg-[#0B0F17] text-slate-300'
                      }`}
                    >
                      Python (asr-platform-python)
                    </button>
                  </div>
                </div>
                <pre className="p-3 rounded bg-[#0B0F17] border border-[#252F42] font-mono text-[11px] overflow-x-auto text-slate-200" dir="ltr">
                  {sdkLangTab === 'ts' ? tsSnippet : pySnippet}
                </pre>
              </div>
            </section>
          )}

          {/* TAB 4: USAGE, LEDGER & IMMUTABLE INVOICES */}
          {activeTab === 'usage_billing' && overview && (
            <section className="space-y-4 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-slate-400">تطابق لجر با مصرف (Reconciliation)</div>
                  <div className="text-base font-bold font-mono text-emerald-400 mt-1">
                    {overview.reconciliation.balanced ? 'BALANCED (Discrepancy = 0¢)' : 'MISMATCH'}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-slate-400">مجموع برداشت مصرفی (Integer Cents)</div>
                  <div className="text-base font-bold font-mono text-amber-300 mt-1">
                    {overview.reconciliation.ledgerConsumptionMinor}¢ (${(overview.reconciliation.ledgerConsumptionMinor / 100).toFixed(2)})
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27] flex items-center justify-between">
                  <div>
                    <div className="text-slate-400">صدور فاکتور تغییرناپذیر</div>
                    <div className="font-mono text-sky-300 mt-1">{overview.invoices.length} فاکتور</div>
                  </div>
                  <button
                    type="button"
                    data-testid="btn-issue-invoice"
                    onClick={handleIssueInvoice}
                    className="px-3 py-1.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 cursor-pointer"
                  >
                    صدور صورتحساب دوره
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                <table className="w-full text-right">
                  <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                    <tr>
                      <th className="p-2.5">شناسه تراکنش لجر</th>
                      <th className="p-2.5">نوع</th>
                      <th className="p-2.5">بدهکار ← بستانکار</th>
                      <th className="p-2.5">مبلغ (Minor Cents)</th>
                      <th className="p-2.5">شرح</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                    {overview.ledgerEntries.map((l) => (
                      <tr key={l.ledgerEntryId}>
                        <td className="p-2.5 font-mono text-sky-300">{l.ledgerEntryId.slice(0, 18)}</td>
                        <td className="p-2.5 font-mono text-amber-300">{l.transactionType}</td>
                        <td className="p-2.5 font-mono text-[11px]">{l.debitAccount} → {l.creditAccount}</td>
                        <td className="p-2.5 font-mono">{l.amountMinor}¢</td>
                        <td className="p-2.5 text-slate-300">{l.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {overview.invoices.length > 0 && (
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2">
                  <div className="font-semibold text-slate-100">فاکتورهای صادرشده (Snapshot قفل‌شده با SHA-256)</div>
                  {overview.invoices.map((inv) => (
                    <div key={inv.invoiceId} className="p-2.5 rounded border border-[#252F42] bg-[#0B0F17] flex flex-wrap justify-between gap-2 font-mono">
                      <span className="text-sky-300">{inv.invoiceNumber}</span>
                      <span>Plan: {inv.pricingSnapshot.planId} ({inv.pricingSnapshot.planVersion})</span>
                      <span>Total: {inv.totalMinor}¢ {inv.currency}</span>
                      <span className="text-emerald-400">{inv.status}</span>
                      <span className="text-slate-400">SHA256: {inv.snapshotSha256.slice(0, 16)}...</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* TAB 5: WEBHOOKS & DEAD LETTER QUEUE */}
          {activeTab === 'webhooks' && overview && (
            <section className="space-y-4 text-xs">
              <form onSubmit={handleRegisterWebhook} className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] flex flex-wrap items-center gap-2">
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  aria-label="آدرس Webhook"
                  className="flex-1 min-w-[260px] px-3 py-2 rounded border border-[#252F42] bg-[#0B0F17] font-mono"
                />
                <button
                  type="submit"
                  className="px-3.5 py-2 rounded bg-sky-400 text-slate-950 font-semibold cursor-pointer"
                >
                  ثبت Endpoint
                </button>
                <button
                  type="button"
                  data-testid="btn-dispatch-webhook-fail"
                  onClick={() => handleDispatchWebhook(true)}
                  className="px-3 py-2 rounded border border-rose-500/40 bg-rose-500/15 text-rose-200 cursor-pointer"
                >
                  شبیه‌سازی خطا و انتقال به DLQ
                </button>
              </form>

              <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                <table className="w-full text-right">
                  <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                    <tr>
                      <th className="p-2.5">Delivery ID</th>
                      <th className="p-2.5">رویداد</th>
                      <th className="p-2.5">وضعیت</th>
                      <th className="p-2.5">امضای HMAC</th>
                      <th className="p-2.5">عملیات DLQ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                    {overview.webhookDeliveries.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-slate-400">
                          هنوز رویداد Webhook ارسال نشده است.
                        </td>
                      </tr>
                    ) : (
                      overview.webhookDeliveries.map((d) => (
                        <tr key={d.deliveryId}>
                          <td className="p-2.5 font-mono text-sky-300">{d.deliveryId.slice(0, 14)}</td>
                          <td className="p-2.5 font-mono">{d.eventType}</td>
                          <td className="p-2.5 font-mono">
                            <span className={d.status === 'DELIVERED' ? 'text-emerald-400' : 'text-rose-400'}>
                              {d.status} (HTTP {d.httpStatus ?? 'PENDING'})
                            </span>
                          </td>
                          <td className="p-2.5 font-mono text-[11px] text-slate-400">
                            {d.signatureHeader.slice(0, 28)}...
                          </td>
                          <td className="p-2.5">
                            {d.status === 'DEAD_LETTER' && (
                              <button
                                type="button"
                                data-testid={`btn-replay-dlq-${d.deliveryId}`}
                                onClick={() => handleReplayWebhook(d.deliveryId)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>Replay دستی</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB 6: MULTI-REGION DATA RESIDENCY & ENTERPRISE AUDIT */}
          {activeTab === 'enterprise_regions' && overview && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      حاکمیت چندمنطقه‌ای و مسدودسازی خودکار مناطق ممنوعه (Data Residency Hard Constraint)
                    </h3>
                    <p className="text-slate-400">
                      سیاست فعلی مستأجر: مجاز `ir-thr-01` · ممنوع `{overview.organization?.prohibitedRegions.join(', ')}`
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="منطقه آزمایشی Data Residency"
                      value={selectedTestRegion}
                      onChange={(e) => setSelectedTestRegion(e.target.value)}
                      className="px-2.5 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] font-mono"
                    >
                      {overview.regions.map((r) => (
                        <option key={r.regionId} value={r.regionId}>
                          {r.regionId} ({r.healthStatus})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      data-testid="btn-test-region-residency"
                      onClick={handleTestRegionResidency}
                      className="px-3.5 py-1.5 rounded bg-sky-400 text-slate-950 font-semibold cursor-pointer"
                    >
                      بررسی مجوز اقامت داده
                    </button>
                  </div>
                </div>
                {regionCheckResult && (
                  <div
                    data-testid="region-residency-result"
                    className={`p-2.5 rounded border ${
                      regionCheckResult.allowed
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                        : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                    }`}
                  >
                    {regionCheckResult.message}
                  </div>
                )}
              </div>

              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2">
                <div className="flex items-center gap-2 font-semibold text-slate-100">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>گزارش حسابرسی امنیتی و عملیاتی (Audit Log)</span>
                </div>
                <div className="space-y-1.5 max-h-56 overflow-y-auto font-mono text-[11px]">
                  {overview.auditLogs.length === 0 ? (
                    <div className="text-slate-400">رویدادی ثبت نشده است.</div>
                  ) : (
                    overview.auditLogs
                      .slice()
                      .reverse()
                      .map((a) => (
                        <div key={a.auditId} className="p-2 rounded bg-[#0B0F17] border border-[#252F42] flex justify-between gap-2">
                          <span className={a.outcome === 'ALLOWED' ? 'text-emerald-400' : 'text-rose-400'}>
                            [{a.outcome}] {a.action}
                          </span>
                          <span className="text-slate-300 truncate">{a.reason}</span>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
