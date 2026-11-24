import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Code2,
  Copy,
  CreditCard,
  Globe2,
  KeyRound,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Upload,
  Webhook,
  X,
} from 'lucide-react';
import { AccessibleModal } from './AccessibleModal';
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
import { getNextRovingTabIndex } from '../studio/layoutUtils';

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
  locale?: 'fa' | 'en';
}

/**
 * Build a minimal valid 1-second 16 kHz mono 16-bit PCM WAV Blob for Playground testing
 * when the user has not selected a local audio file.
 */
function createDefaultTestWavBlob(durationSec = 1): Blob {
  const sampleRate = 16000;
  const numSamples = Math.max(1600, Math.round(sampleRate * durationSec));
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25;
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export const DeveloperPlatformPortalModal: React.FC<DeveloperPlatformPortalModalProps> = ({
  isOpen,
  onClose,
  locale = 'fa',
}) => {
  const isFa = locale === 'fa';
  // Strictly in-memory admin control-plane Bearer token — NEVER persisted to storage/URL/logs
  const [adminBearerToken, setAdminBearerToken] = useState('');
  const [authStatus, setAuthStatus] = useState<'UNAUTHENTICATED' | 'AUTHENTICATED' | 'FORBIDDEN'>('UNAUTHENTICATED');

  const [activeTab, setActiveTab] = useState<PortalTabId>('overview');
  const [overview, setOverview] = useState<PortalOverviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // API Keys & Projects state (issuedSecretOnce is strictly separate for Data Plane /v1/* calls)
  const [newKeyName, setNewKeyName] = useState('Studio Client Integration Key');
  const [newProjectName, setNewProjectName] = useState('');
  const [issuedSecretOnce, setIssuedSecretOnce] = useState<string | null>(null);
  const [webhookSigningSecretOnce, setWebhookSigningSecretOnce] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Interactive API Playground state (binary audio upload only; metadata is derived server-side)
  const [playgroundModel, setPlaygroundModel] = useState('asr-fa-en-v1');
  const [playgroundIdempKey, setPlaygroundIdempKey] = useState(() => `idemp-${Date.now()}`);
  const [estimateDurationSec, setEstimateDurationSec] = useState(12);
  const [playgroundAudioFile, setPlaygroundAudioFile] = useState<File | null>(null);
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

  // Wipe all sensitive tokens from React state immediately on close or unmount
  useEffect(() => {
    if (!isOpen) {
      setAdminBearerToken('');
      setIssuedSecretOnce(null);
      setWebhookSigningSecretOnce(null);
      setOverview(null);
      setAuthStatus('UNAUTHENTICATED');
    }
    return () => {
      setAdminBearerToken('');
      setIssuedSecretOnce(null);
      setWebhookSigningSecretOnce(null);
    };
  }, [isOpen]);

  const handleClosePortal = useCallback(() => {
    setAdminBearerToken('');
    setIssuedSecretOnce(null);
    setWebhookSigningSecretOnce(null);
    setOverview(null);
    setAuthStatus('UNAUTHENTICATED');
    onClose();
  }, [onClose]);

  /**
   * Centralized authenticated transport for ALL `/api/v1/platform/*` Control Plane operations.
   * Refuses calls when adminBearerToken is absent, classifies 401 vs 403 separately,
   * and never retries failed privileged mutations.
   */
  const platformFetch = useCallback(
    async (
      path: string,
      options: { method?: 'GET' | 'POST'; body?: unknown } = {}
    ): Promise<Response | null> => {
      const token = adminBearerToken.trim();
      if (!token) {
        setAuthStatus('UNAUTHENTICATED');
        setNotice(
          isFa
            ? 'برای دسترسی به Control Plane، ابتدا کلید مدیریتی معتبر (Bearer Token) را وارد کنید.'
            : 'Enter a valid Admin Bearer Token first to access the Control Plane.',
        );
        return null;
      }

      const method = options.method ?? 'GET';
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
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
        setAuthStatus('UNAUTHENTICATED');
        setNotice(
          isFa
            ? 'احراز هویت ناموفق (۴۰۱): کلید مدیریتی نامعتبر، منقضی یا باطل شده است.'
            : 'Authentication failed (401): Admin key is invalid, expired, or revoked.',
        );
      } else if (res.status === 403) {
        setAuthStatus('FORBIDDEN');
        setNotice(
          isFa
            ? 'دسترسی غیرمجاز (۴۰۳): کلید شما مجوز (Scope) یا نقش کافی برای این عملیات ندارد.'
            : 'Forbidden (403): Your key lacks the required scope or role for this action.',
        );
      }
      return res;
    },
    [adminBearerToken, isFa]
  );

  const loadOverview = useCallback(async () => {
    if (!adminBearerToken.trim()) {
      setAuthStatus('UNAUTHENTICATED');
      setOverview(null);
      return;
    }
    setLoading(true);
    try {
      const res = await platformFetch('/api/v1/platform/overview', { method: 'GET' });
      if (!res) return;
      if (res.ok) {
        const data = (await res.json()) as PortalOverviewPayload;
        setOverview(data);
        setAuthStatus('AUTHENTICATED');
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa
            ? `خطا در بارگذاری نمای کلی پورتال توسعه‌دهندگان (کد ${res.status}).`
            : `Failed to load developer portal overview (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در ارتباط با پورتال توسعه‌دهندگان: ${err instanceof Error ? err.message : String(err)}`
          : `Portal connection error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [adminBearerToken, isFa, platformFetch]);

  const handleIssueApiKey = async () => {
    try {
      const projectId = overview?.projects[0]?.id;
      if (!projectId) {
        setNotice(
          isFa
            ? 'ابتدا با کلید مدیریتی معتبر به پورتال متصل شوید تا پروژه فعال بارگذاری شود.'
            : 'Connect with a valid Admin Bearer key first to load an active project.',
        );
        return;
      }
      const res = await platformFetch('/api/v1/platform/api-keys', {
        method: 'POST',
        body: {
          projectId,
          name: newKeyName,
          scopes: ['audio:transcribe', 'audio:stream', 'transcripts:read', 'models:read', 'usage:read'],
        },
      });
      if (!res) return;
      if (res.ok) {
        const data = (await res.json()) as { plaintextSecretOnce: string };
        setIssuedSecretOnce(data.plaintextSecretOnce);
        setCopiedKey(false);
        setNotice(
          isFa
            ? 'کلید جدید صادر شد. مقدار Secret فقط همین یک‌بار نمایش داده می‌شود و در سرور فقط هش HMAC نگهداری می‌شود.'
            : 'New API key issued. The plaintext secret is displayed only once; the server stores only its HMAC hash.',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa
            ? `خطا در صدور کلید API (کد ${res.status}).`
            : `Failed to issue API key (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در صدور کلید API: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to issue API key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleRotateKey = async (credId: string) => {
    try {
      const res = await platformFetch(`/api/v1/platform/api-keys/${encodeURIComponent(credId)}/rotate`, {
        method: 'POST',
        body: { overlapHours: 24 },
      });
      if (!res) return;
      if (res.ok) {
        const data = (await res.json()) as { plaintextSecretOnce: string };
        setIssuedSecretOnce(data.plaintextSecretOnce);
        setCopiedKey(false);
        setNotice(
          isFa
            ? 'چرخش کلید انجام شد؛ کلید قبلی با پنجره هم‌پوشانی ۲۴ ساعته فعال می‌ماند.'
            : 'Key rotated; the previous key stays valid during a 24-hour overlap window.',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa
            ? `خطا در چرخش کلید API (کد ${res.status}).`
            : `Failed to rotate API key (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در چرخش کلید API: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to rotate API key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleRevokeKey = async (credId: string) => {
    try {
      const res = await platformFetch(`/api/v1/platform/api-keys/${encodeURIComponent(credId)}/revoke`, {
        method: 'POST',
      });
      if (!res) return;
      if (res.ok) {
        setNotice(
          isFa
            ? 'کلید بلافاصله باطل شد و هر درخواست با آن با کد 401 رد می‌شود.'
            : 'API key immediately revoked; subsequent requests return HTTP 401.',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa
            ? `خطا در ابطال کلید API (کد ${res.status}).`
            : `Failed to revoke API key (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در ابطال کلید API: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to revoke API key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    try {
      const res = await platformFetch('/api/v1/platform/projects', {
        method: 'POST',
        body: { projectName: newProjectName, environment: 'DEVELOPMENT' },
      });
      if (!res) return;
      if (res.ok) {
        setNewProjectName('');
        setNotice(
          isFa
            ? 'پروژه جدید با جداسازی محیطی و ردیابی مصرف مستقل ایجاد شد.'
            : 'New project created with isolated environment and usage tracking.',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa
            ? `خطا در ایجاد پروژه جدید (کد ${res.status}).`
            : `Failed to create project (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در ایجاد پروژه جدید: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to create project: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleEstimateApiCost = async () => {
    if (!issuedSecretOnce) {
      setNotice(
        isFa
          ? 'ابتدا در تب «کلیدها و پروژه‌ها» یک کلید تست Data Plane بسازید تا درخواست با Bearer Token واقعی ارسال شود.'
          : 'Create a Data Plane test key in the "API Keys & Projects" tab first so requests send a real Bearer Token.',
      );
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
          duration_seconds: Math.max(1, Math.round(estimateDurationSec)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setEstimateResult(json);
      if (!res.ok) {
        setNotice(
          isFa ? `برآورد هزینه با کد ${res.status} بازگشت.` : `Cost estimate returned HTTP ${res.status}.`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در برآورد هزینه API: ${err instanceof Error ? err.message : String(err)}`
          : `API cost estimate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleExecutePlaygroundTranscription = async () => {
    if (!issuedSecretOnce) {
      setNotice(
        isFa ? 'ابتدا یک کلید API در تب کلیدها بسازید.' : 'Create an API key in the Keys tab first.',
      );
      return;
    }
    try {
      const uploadBlob: Blob = playgroundAudioFile ?? createDefaultTestWavBlob(1);
      const contentType = playgroundAudioFile?.type || 'audio/wav';
      const asrOptions = {
        model: playgroundModel,
        language: 'fa-en',
        timestamps: true,
        domain_profile: 'technology',
        execution_mode: 'batch',
      };

      const res = await fetch('/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          Authorization: `Bearer ${issuedSecretOnce}`,
          'Idempotency-Key': playgroundIdempKey,
          'X-ASR-Options': JSON.stringify(asrOptions),
        },
        body: uploadBlob,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setApiPlayResult(json);
      if (!res.ok) {
        setNotice(
          isFa
            ? `اجرای درخواست رونویسی API با کد ${res.status} بازگشت.`
            : `API transcription returned HTTP ${res.status}.`,
        );
      }
      if (adminBearerToken.trim()) {
        await loadOverview();
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در اجرای درخواست رونویسی API: ${err instanceof Error ? err.message : String(err)}`
          : `API transcription failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleIssueInvoice = async () => {
    try {
      const res = await platformFetch('/api/v1/platform/invoices/issue', { method: 'POST' });
      if (!res) return;
      if (res.ok) {
        setNotice(
          isFa
            ? 'فاکتور تغییرناپذیر با اسنپ‌شات قیمت‌گذاری و هش SHA-256 صادر شد.'
            : 'Immutable invoice issued with pricing snapshot and SHA-256 hash.',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa ? `خطا در صدور فاکتور (کد ${res.status}).` : `Failed to issue invoice (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در صدور فاکتور: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to issue invoice: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleRegisterWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await platformFetch('/api/v1/platform/webhooks', {
        method: 'POST',
        body: {
          url: webhookUrl,
          eventSubscriptions: ['transcription.completed', 'transcription.failed'],
        },
      });
      if (!res) return;
      if (res.ok) {
        const data = (await res.json()) as { signingSecretOnce?: string };
        if (data.signingSecretOnce) {
          setWebhookSigningSecretOnce(data.signingSecretOnce);
        }
        setNotice(
          isFa
            ? 'نقطه انتهایی Webhook با کلید امضای HMAC-SHA256 ثبت شد (کلید امضا فقط یک‌بار نمایش داده می‌شود).'
            : 'Webhook endpoint registered with HMAC-SHA256 signing secret (displayed once).',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setNotice(
          isFa
            ? `خطا در ثبت Webhook (کد ${res.status}): ${errBody.error?.message ?? ''}`
            : `Failed to register webhook (HTTP ${res.status}): ${errBody.error?.message ?? ''}`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در ثبت Webhook: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to register webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleDispatchWebhook = async (simulateFailure: boolean) => {
    try {
      const res = await platformFetch('/api/v1/platform/webhooks/test-dispatch', {
        method: 'POST',
        body: { simulateFailure },
      });
      if (!res) return;
      if (res.ok) {
        setNotice(
          simulateFailure
            ? isFa
              ? 'رویداد تست پس از ۶ تلاش به Dead-Letter Queue منتقل شد.'
              : 'Test event moved to Dead-Letter Queue after 6 delivery attempts.'
            : isFa
              ? 'رویداد امضاشده (t=..., v1=...) در صف ارسال قرار گرفت.'
              : 'Signed event (t=..., v1=...) queued for delivery.',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa
            ? `خطا در ارسال رویداد تست Webhook (کد ${res.status}).`
            : `Failed to dispatch test webhook (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در ارسال رویداد تست Webhook: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to dispatch test webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleReplayWebhook = async (deliveryId: string) => {
    try {
      const res = await platformFetch(`/api/v1/platform/webhooks/${encodeURIComponent(deliveryId)}/replay`, {
        method: 'POST',
      });
      if (!res) return;
      if (res.ok) {
        setNotice(
          isFa
            ? 'رویداد DLQ با وضعیت RETRY_SCHEDULED برای ارسال مجدد زمان‌بندی شد.'
            : 'DLQ event scheduled for retry (RETRY_SCHEDULED).',
        );
        await loadOverview();
      } else if (res.status !== 401 && res.status !== 403) {
        setNotice(
          isFa
            ? `خطا در بازپخش رویداد DLQ (کد ${res.status}).`
            : `Failed to replay DLQ event (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در بازپخش رویداد DLQ: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to replay DLQ event: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleTestRegionResidency = async () => {
    try {
      const res = await platformFetch('/api/v1/platform/region-check', {
        method: 'POST',
        body: { regionId: selectedTestRegion },
      });
      if (!res) return;
      const json = (await res.json().catch(() => ({}))) as {
        allowed?: boolean;
        region?: { regionId: string };
        errorEnvelope?: { error?: { code: string; message: string } };
      };
      if (res.ok && json.allowed) {
        setRegionCheckResult({
          allowed: true,
          message: isFa
            ? `منطقه ${json.region?.regionId} مجاز و فعال است (Single-Region G0).`
            : `Region ${json.region?.regionId} is permitted and active (Single-Region G0).`,
        });
      } else if (res.status !== 401 && res.status !== 403) {
        setRegionCheckResult({
          allowed: false,
          message: isFa
            ? `رد شده طبق سیاست اقامت داده (${json.errorEnvelope?.error?.code ?? `HTTP_${res.status}`}): ${json.errorEnvelope?.error?.message ?? 'نامشخص'}`
            : `Rejected by data residency policy (${json.errorEnvelope?.error?.code ?? `HTTP_${res.status}`}): ${json.errorEnvelope?.error?.message ?? 'Unknown'}`,
        });
      }
      await loadOverview();
    } catch (err) {
      setNotice(
        isFa
          ? `خطا در بررسی سیاست اقامت داده: ${err instanceof Error ? err.message : String(err)}`
          : `Region residency check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const tsSnippet = `import { readFileSync } from "node:fs";
import { ASRClient } from "@asr-platform/sdk";

const client = new ASRClient({ apiKey: process.env.ASR_API_KEY! });
const result = await client.audio.transcriptions.create({
  audio: readFileSync("./sample.wav"),
  contentType: "audio/wav",
  model: "${playgroundModel}",
  language: "fa-en",
  idempotencyKey: "${playgroundIdempKey}"
});
console.log(result.text, result.usage);`;

  const pySnippet = `import os
from asr_platform import ASRClient

client = ASRClient(api_key=os.environ["ASR_API_KEY"])
result = client.audio.transcriptions.create(
    audio="./sample.wav",
    content_type="audio/wav",
    model="${playgroundModel}",
    language="fa-en",
    idempotency_key="${playgroundIdempKey}",
)
print(result["text"], result["usage"])`;

  const totalBilledSec =
    overview?.usageEvents.reduce((acc, u) => acc + Math.round(u.billableDurationMs / 1000), 0) ?? 0;

  const portalTabs: Array<{ id: PortalTabId; label: string; icon: typeof Activity }> = [
    { id: 'overview', label: isFa ? 'خانه و کاتالوگ مدل‌ها' : 'Overview & Models', icon: Activity },
    { id: 'keys_projects', label: isFa ? 'کلیدهای API و پروژه‌ها' : 'API Keys & Projects', icon: KeyRound },
    { id: 'playground_sdks', label: isFa ? 'آزمایشگاه API و SDKها' : 'API Playground & SDKs', icon: Code2 },
    { id: 'usage_billing', label: isFa ? 'مصرف، لجر مالی و فاکتور' : 'Usage, Ledger & Invoices', icon: CreditCard },
    { id: 'webhooks', label: isFa ? 'وب‌هوک‌ها و DLQ' : 'Webhooks & DLQ', icon: Webhook },
    { id: 'enterprise_regions', label: isFa ? 'منطقه داده، RBAC و حسابرسی' : 'Residency, RBAC & Audit', icon: Globe2 },
  ];

  return (
    <AccessibleModal
      isOpen={isOpen}
      onClose={handleClosePortal}
      dir={isFa ? 'rtl' : 'ltr'}
      labelledBy="dev-platform-portal-title"
      dataTestId="developer-platform-portal-modal"
      panelClassName="w-full max-w-6xl"
    >
      <div className="w-full max-h-[92vh] bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-2xl shadow-[var(--avp-shadow-md)] flex flex-col overflow-hidden text-[var(--avp-text)]">
        {/* Header */}
        <header className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
          <div className="flex items-center gap-3">
            <Terminal className="w-5 h-5 text-[var(--avp-brand)] shrink-0" aria-hidden="true" />
            <div>
              <h2 id="dev-platform-portal-title" className="text-sm sm:text-base font-bold text-[var(--avp-text)]">
                {isFa
                  ? 'پورتال توسعه‌دهندگان و اکوسیستم تجاری ASR'
                  : 'Developer Platform Portal & Commercial ASR Sandbox'}
              </h2>
              <p className="text-xs text-[var(--avp-text-secondary)]">
                {isFa
                  ? 'تفکیک کامل Control Plane از هسته علمی ASR · محاسبات مالی Integer (USD Cents) · وضعیت: '
                  : 'Separated Control Plane · Integer USD-Cents Ledger · Status: '}
                <span className="font-mono text-[var(--avp-warning-text)]">ENGINEERING_COMPLETE_PRIVATE_ALPHA_READY</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadOverview()}
              disabled={!adminBearerToken.trim()}
              aria-label={isFa ? 'بروزرسانی اطلاعات پورتال' : 'Refresh portal overview'}
              className="avp-touch-icon sm:w-8 sm:h-8 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] inline-flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={handleClosePortal}
              aria-label={isFa ? 'بستن پورتال توسعه‌دهندگان' : 'Close developer platform portal'}
              className="avp-touch-icon sm:w-8 sm:h-8 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] inline-flex items-center justify-center cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Control Plane Admin Credential Bar (In-Memory Only) */}
        <div className="px-5 py-3 border-b border-[var(--avp-border)] bg-[var(--avp-bg-subtle)] text-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[var(--avp-text)]">
            <Lock className="w-4 h-4 text-[var(--avp-brand)] shrink-0" aria-hidden="true" />
            <label htmlFor="portal-admin-bearer-input" className="font-semibold whitespace-nowrap">
              {isFa ? 'کلید مدیریتی Control Plane (Bearer)' : 'Control Plane Admin Bearer Key'}
            </label>
            <span className="text-[var(--avp-text-secondary)] hidden lg:inline">
              {isFa
                ? '(فقط در حافظه موقت مرورگر نگهداری و با بستن پنجره پاک می‌شود)'
                : '(Held in memory only; cleared when modal closes)'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 flex-1 max-w-xl justify-end">
            <input
              id="portal-admin-bearer-input"
              data-testid="input-portal-admin-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={adminBearerToken}
              onChange={(e) => setAdminBearerToken(e.target.value)}
              placeholder={
                isFa
                  ? 'asr_test_... (دارای اسکوپ‌های مدیریتی platform:read / api-keys:manage)'
                  : 'asr_test_... (with platform:read / api-keys:manage scopes)'
              }
              dir="ltr"
              className="flex-1 min-w-[220px] min-h-[44px] sm:min-h-[34px] px-2.5 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] font-mono text-xs text-[var(--avp-text)]"
            />
            <button
              type="button"
              data-testid="btn-portal-authenticate"
              disabled={!adminBearerToken.trim() || loading}
              onClick={() => void loadOverview()}
              className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[34px] whitespace-nowrap"
            >
              {isFa ? 'اتصال احراز هویت‌شده' : 'Authenticate'}
            </button>
          </div>
        </div>

        {/* Sub-navigation */}
        <div
          role="tablist"
          aria-label={isFa ? 'بخش‌های پورتال توسعه‌دهندگان' : 'Developer Portal Sections'}
          className="flex flex-wrap items-center gap-1.5 px-5 py-2.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)]"
        >
          {portalTabs.map((t, idx) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-testid={`portal-tab-${t.id}`}
                onClick={() => setActiveTab(t.id)}
                onKeyDown={(e) => {
                  const nextIdx = getNextRovingTabIndex(idx, portalTabs.length, e.key, isFa, 'horizontal');
                  if (nextIdx !== null) {
                    e.preventDefault();
                    const nextId = portalTabs[nextIdx].id;
                    setActiveTab(nextId);
                    const el = e.currentTarget
                      .closest('[role="tablist"]')
                      ?.querySelector<HTMLButtonElement>(`[data-testid="portal-tab-${nextId}"]`);
                    el?.focus();
                  }
                }}
                className={`min-h-[44px] sm:min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap cursor-pointer border transition-colors ${
                  active
                    ? 'bg-[var(--avp-brand)] text-white border-[var(--avp-brand)] font-semibold'
                    : 'bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] border-[var(--avp-border)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {notice && (
          <div className="mx-5 mt-3 px-3.5 py-2 rounded-lg border border-[var(--avp-brand)]/35 bg-[var(--avp-brand-soft)] text-xs text-[var(--avp-accent-text)] flex items-center justify-between gap-2">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="min-h-[36px] px-2 text-[var(--avp-accent-text)] font-semibold hover:underline cursor-pointer"
            >
              {isFa ? 'بستن' : 'Dismiss'}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-5 bg-[var(--avp-bg)]">
          {/* Authentication Required Gate when no verified admin session is loaded */}
          {!overview && activeTab !== 'playground_sdks' && (
            <section
              data-testid="portal-auth-required-panel"
              className="p-6 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2 text-xs text-center"
            >
              <Lock className="w-6 h-6 text-[var(--avp-brand)] mx-auto" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                {isFa
                  ? 'احراز هویت برای دسترسی به Control Plane الزامی است'
                  : 'Authentication Required for Control Plane Access'}
              </h3>
              <p className="text-[var(--avp-text-secondary)] max-w-xl mx-auto">
                {isFa ? (
                  <>
                    تمامی مسیرهای مدیریتی <code dir="ltr" className="font-mono text-[var(--avp-accent-text)]">/api/v1/platform/*</code> بدون کلید احراز هویت‌شده مسدود هستند. کلید مدیریتی خود را در کادر بالا وارد کرده و «اتصال احراز هویت‌شده» را بزنید.
                  </>
                ) : (
                  <>
                    All management endpoints under <code dir="ltr" className="font-mono text-[var(--avp-accent-text)]">/api/v1/platform/*</code> require authentication. Enter your admin key above and select Authenticate.
                  </>
                )}
              </p>
              {authStatus === 'FORBIDDEN' && (
                <p className="text-[var(--avp-warning-text)]">
                  {isFa
                    ? 'کلید فعلی شما احراز هویت شد اما دسترسی (RBAC / Scope) لازم برای نمای کلی ندارد (HTTP 403).'
                    : 'Your key authenticated, but lacks the required RBAC role or scope for the portal overview (HTTP 403).'}
                </p>
              )}
            </section>
          )}

          {/* TAB 1: OVERVIEW & PUBLIC MODEL CATALOG */}
          {activeTab === 'overview' && overview && (
            <section className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[var(--avp-text-secondary)]">
                    {isFa ? 'اعتبار ارزیابی باقی‌مانده' : 'Remaining Sandbox Credit'}
                  </div>
                  <div className="text-lg font-bold font-mono text-[var(--avp-success-text)] mt-1" dir="ltr">
                    ${((overview.subscription?.availableCreditMinor ?? 0) / 100).toFixed(2)}
                  </div>
                </div>
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[var(--avp-text-secondary)]">
                    {isFa ? 'مصرف تأییدشده (ثانیه صوت)' : 'Verified Usage (Audio Sec)'}
                  </div>
                  <div className="text-lg font-bold font-mono text-[var(--avp-accent-text)] mt-1" dir="ltr">
                    {totalBilledSec}s
                  </div>
                </div>
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[var(--avp-text-secondary)]">
                    {isFa ? 'پروژه‌ها / کلیدهای فعال' : 'Projects / Active Keys'}
                  </div>
                  <div className="text-lg font-bold font-mono text-[var(--avp-warning-text)] mt-1" dir="ltr">
                    {overview.projects.length} / {overview.credentials.filter((c) => !c.revokedAtIso).length}
                  </div>
                </div>
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[var(--avp-text-secondary)]">
                    {isFa ? 'منطقه عملیاتی فعال' : 'Active Residency Region'}
                  </div>
                  <div className="text-sm font-bold font-mono text-[var(--avp-text)] mt-1" dir="ltr">
                    {overview.organization?.defaultRegionId}
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-xl border border-[var(--avp-warning)]/35 bg-[var(--avp-warning-soft)] text-xs text-[var(--avp-warning-text)] flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  {isFa ? (
                    <>
                      <strong>تفکیک آماده بودن فنی از مجوز فروش تجاری:</strong> پرداخت بانکی زنده (PSP)، خوشه GPU برای مدل‌های سنگین و PostgreSQL مدیریت‌شده در محیط کانتینر محلی فعال نیستند؛ درگاه `/v1/*` فقط با پلن Sandbox غیرتجاری و موتور مستقل محلی (`asr-fa-en-v1`) پاسخ واقعی می‌دهد.
                    </>
                  ) : (
                    <>
                      <strong>Technical Readiness vs. Commercial Licensing:</strong> Live PSP billing, external GPU clusters, and managed PostgreSQL are inactive in this local container; `/v1/*` responds in non-commercial Sandbox mode backed by the local `asr-fa-en-v1` engine.
                    </>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[var(--avp-border)]">
                <table className={`w-full ${isFa ? 'text-right' : 'text-left'} text-xs`}>
                  <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                    <tr>
                      <th className="p-2.5">{isFa ? 'شناسه مدل عمومی (`/v1/models`)' : 'Public Model ID (`/v1/models`)'}</th>
                      <th className="p-2.5">{isFa ? 'وضعیت انتشار' : 'Release State'}</th>
                      <th className="p-2.5">{isFa ? 'حالت‌های پشتیبانی‌شده' : 'Supported Modes'}</th>
                      <th className="p-2.5">Timestamp / Diarization</th>
                      <th className="p-2.5">{isFa ? 'در دسترس بودن در محیط فعلی' : 'Container Availability'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                    {overview.models.map((m) => (
                      <tr key={m.modelId}>
                        <td className="p-2.5 font-mono text-[var(--avp-accent-text)]">{m.modelId}</td>
                        <td className="p-2.5 font-mono">{m.releaseState}</td>
                        <td className="p-2.5 font-mono text-[11px]">{m.supportedModes.join(', ')}</td>
                        <td className="p-2.5 font-mono">
                          {m.timestampsSupported ? 'TS:Yes' : 'TS:No'} · {m.diarizationSupported ? 'Diar:Yes' : 'Diar:No'}
                        </td>
                        <td className="p-2.5 font-mono">
                          <span
                            className={
                              m.availabilityInCurrentContainer === 'AVAILABLE_NOW'
                                ? 'text-[var(--avp-success-text)]'
                                : 'text-[var(--avp-warning-text)]'
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
              <div className="p-4 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                      {isFa
                        ? 'مدیریت چرخه عمر کلیدهای API (نمایش یک‌بار مصرف + هش HMAC با Pepper سروری)'
                        : 'API Key Lifecycle (One-Time Secret Reveal + Server-Peppered HMAC Hash)'}
                    </h3>
                    <p className="text-[var(--avp-text-secondary)]">
                      {isFa
                        ? 'کلیدهای ساخته‌شده در پروژه Development با پیشوند `asr_test_` صادر می‌شوند.'
                        : 'Keys created in Development projects are issued with the `asr_test_` prefix.'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="portal-new-key-name" className="sr-only">
                      {isFa ? 'نام کلید API' : 'API Key Name'}
                    </label>
                    <input
                      id="portal-new-key-name"
                      type="text"
                      dir="auto"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      aria-label={isFa ? 'نام کلید API' : 'API Key Name'}
                      className="min-h-[44px] sm:min-h-[34px] px-3 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] text-[var(--avp-text)]"
                    />
                    <button
                      type="button"
                      data-testid="btn-issue-api-key"
                      onClick={handleIssueApiKey}
                      className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[34px]"
                    >
                      <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{isFa ? 'صدور کلید جدید' : 'Issue New Key'}</span>
                    </button>
                  </div>
                </div>

                {issuedSecretOnce && (
                  <div
                    data-testid="issued-key-once-banner"
                    className="p-3 rounded-lg border border-[var(--avp-success)]/40 bg-[var(--avp-success-soft)] flex flex-wrap items-center justify-between gap-2"
                  >
                    <div className="space-y-0.5">
                      <div className="text-[var(--avp-success-text)] font-semibold">
                        {isFa
                          ? 'کلید یک‌بار مصرف صادرشده (بلافاصله کپی کنید — دیگر قابل بازیابی نیست):'
                          : 'One-Time Issued Secret (copy immediately — cannot be retrieved later):'}
                      </div>
                      <code className="block font-mono text-xs text-[var(--avp-text)] break-all" dir="ltr">
                        {issuedSecretOnce}
                      </code>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (!navigator.clipboard?.writeText) {
                          setNotice(
                            isFa
                              ? 'دسترسی خودکار کلیپ‌بورد در این محیط در دسترس نیست؛ کلید را به‌صورت دستی کپی کنید.'
                              : 'Clipboard API unavailable; please copy the secret manually.',
                          );
                          return;
                        }
                        navigator.clipboard
                          .writeText(issuedSecretOnce)
                          .then(() => setCopiedKey(true))
                          .catch(() =>
                            setNotice(
                              isFa
                                ? 'امکان کپی خودکار در کلیپ‌بورد نبود؛ لطفاً کلید را به‌صورت دستی کپی کنید.'
                                : 'Could not copy automatically; please copy the secret manually.',
                            ),
                          );
                      }}
                      className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[32px] border-[var(--avp-success)]/40 text-[var(--avp-success-text)]"
                    >
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{copiedKey ? (isFa ? 'کپی شد' : 'Copied') : isFa ? 'کپی' : 'Copy'}</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto rounded-xl border border-[var(--avp-border)]">
                <table className={`w-full ${isFa ? 'text-right' : 'text-left'}`}>
                  <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                    <tr>
                      <th className="p-2.5">{isFa ? 'نام' : 'Name'}</th>
                      <th className="p-2.5">{isFa ? 'شناسه عمومی' : 'Public ID'}</th>
                      <th className="p-2.5">{isFa ? 'محیط' : 'Environment'}</th>
                      <th className="p-2.5">Scopes</th>
                      <th className="p-2.5">{isFa ? 'وضعیت' : 'Status'}</th>
                      <th className="p-2.5">{isFa ? 'عملیات' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                    {overview.credentials.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-[var(--avp-text-secondary)]">
                          {isFa
                            ? 'هنوز کلیدی صادر نشده است. دکمه «صدور کلید جدید» را بزنید.'
                            : 'No API keys issued yet. Click "Issue New Key" above.'}
                        </td>
                      </tr>
                    ) : (
                      overview.credentials.map((c) => (
                        <tr key={c.id}>
                          <td className="p-2.5 text-[var(--avp-text)]">{c.name}</td>
                          <td className="p-2.5 font-mono text-[var(--avp-accent-text)]" dir="ltr">
                            {c.keyPrefix}_{c.publicIdentifier}_****
                          </td>
                          <td className="p-2.5 font-mono">{c.environment}</td>
                          <td className="p-2.5 font-mono text-[11px] text-[var(--avp-text-secondary)]">
                            {c.scopes.join(', ')}
                          </td>
                          <td className="p-2.5 font-mono">
                            {c.revokedAtIso ? (
                              <span className="text-[var(--avp-danger-text)]">REVOKED</span>
                            ) : c.overlapRevokesAtIso ? (
                              <span className="text-[var(--avp-warning-text)]">ROTATING (24h Overlap)</span>
                            ) : (
                              <span className="text-[var(--avp-success-text)]">ACTIVE</span>
                            )}
                          </td>
                          <td className="p-2.5">
                            {!c.revokedAtIso && (
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleRotateKey(c.id)}
                                  className="min-h-[36px] sm:min-h-[28px] px-2.5 py-1 rounded border border-[var(--avp-warning)]/40 text-[var(--avp-warning-text)] hover:bg-[var(--avp-warning-soft)] cursor-pointer"
                                >
                                  {isFa ? 'چرخش ۲۴h' : 'Rotate 24h'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRevokeKey(c.id)}
                                  className="min-h-[36px] sm:min-h-[28px] inline-flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--avp-danger)]/40 text-[var(--avp-danger-text)] hover:bg-[var(--avp-danger-soft)] cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" aria-hidden="true" />
                                  <span>{isFa ? 'ابطال' : 'Revoke'}</span>
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

              <form onSubmit={handleCreateProject} className="p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] flex flex-wrap items-center gap-2">
                <label htmlFor="portal-new-project-name" className="text-[var(--avp-text)] font-medium">
                  {isFa ? 'ایجاد پروژه جدید:' : 'Create New Project:'}
                </label>
                <input
                  id="portal-new-project-name"
                  type="text"
                  dir="auto"
                  placeholder={isFa ? 'نام پروژه (مثلاً اپ موبایل فارسی)' : 'Project name (e.g., Persian Mobile App)'}
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="flex-1 min-w-[200px] min-h-[44px] sm:min-h-[34px] px-3 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] text-[var(--avp-text)]"
                />
                <button
                  type="submit"
                  className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[34px]"
                >
                  {isFa ? 'ثبت پروژه' : 'Create Project'}
                </button>
              </form>
            </section>
          )}

          {/* TAB 3: INTERACTIVE API PLAYGROUND & OFFICIAL SDKs */}
          {activeTab === 'playground_sdks' && (
            <section className="space-y-4 text-xs">
              <div className="p-4 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3">
                <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                  {isFa
                    ? 'آزمایشگاه زنده API عمومی (`POST /v1/audio/transcriptions` و برآورد هزینه قبل از اجرا)'
                    : 'Live Public API Playground (`POST /v1/audio/transcriptions` & Pre-Run Cost Estimate)'}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="playground-model-select" className="block text-[var(--avp-text-secondary)] mb-1">
                      {isFa ? 'مدل (`/v1/models`):' : 'Model (`/v1/models`):'}
                    </label>
                    <select
                      id="playground-model-select"
                      value={playgroundModel}
                      onChange={(e) => setPlaygroundModel(e.target.value)}
                      className="w-full min-h-[44px] sm:min-h-[36px] px-2.5 py-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] text-[var(--avp-text)]"
                    >
                      <option value="asr-fa-en-v1">asr-fa-en-v1 (Stable Local)</option>
                      <option value="asr-fa-en-baseline">asr-fa-en-baseline (Beta Local)</option>
                      <option value="qwen3-asr-1.7b-fa">qwen3-asr-1.7b-fa (503 GPU Required Test)</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="playground-idemp-input" className="block text-[var(--avp-text-secondary)] mb-1">
                      {isFa ? 'Idempotency-Key (حفظ ۲۴ ساعته):' : 'Idempotency-Key (24h window):'}
                    </label>
                    <input
                      id="playground-idemp-input"
                      type="text"
                      dir="ltr"
                      value={playgroundIdempKey}
                      onChange={(e) => setPlaygroundIdempKey(e.target.value)}
                      className="w-full min-h-[44px] sm:min-h-[36px] px-2.5 py-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] font-mono text-[var(--avp-text)]"
                    />
                  </div>
                  <div>
                    <label htmlFor="playground-duration-input" className="block text-[var(--avp-text-secondary)] mb-1">
                      {isFa ? 'مدت تخمینی برای `/v1/audio/estimates` (ثانیه):' : 'Estimated Duration for `/v1/audio/estimates` (s):'}
                    </label>
                    <input
                      id="playground-duration-input"
                      type="number"
                      min={1}
                      dir="ltr"
                      value={estimateDurationSec}
                      onChange={(e) => setEstimateDurationSec(Number(e.target.value))}
                      className="w-full min-h-[44px] sm:min-h-[36px] px-2.5 py-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] font-mono text-[var(--avp-text)]"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)]">
                  <Upload className="w-4 h-4 text-[var(--avp-brand)] shrink-0" aria-hidden="true" />
                  <label htmlFor="playground-audio-file-input" className="text-[var(--avp-text)]">
                    {isFa ? (
                      <>
                        فایل صوتی باینری برای آپلود مستقیم به <code dir="ltr" className="font-mono">/v1/audio/transcriptions</code>:
                      </>
                    ) : (
                      <>
                        Binary audio file to upload directly to <code dir="ltr" className="font-mono">/v1/audio/transcriptions</code>:
                      </>
                    )}
                  </label>
                  <input
                    id="playground-audio-file-input"
                    type="file"
                    accept="audio/*"
                    data-testid="input-playground-audio-file"
                    onChange={(e) => setPlaygroundAudioFile(e.target.files?.[0] ?? null)}
                    className="text-xs text-[var(--avp-text-secondary)]"
                  />
                  <span className="text-[var(--avp-text-muted)] font-mono text-[11px]">
                    {playgroundAudioFile
                      ? `${playgroundAudioFile.name} (${playgroundAudioFile.size} bytes)`
                      : isFa
                        ? 'در صورت انتخاب نکردن فایل، یک WAV آزمایشی ۱ ثانیه‌ای ۱۶kHz ارسال می‌شود'
                        : 'If no file is selected, a 1-second 16kHz test WAV is sent automatically'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="btn-estimate-api-cost"
                    onClick={handleEstimateApiCost}
                    className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[36px]"
                  >
                    {isFa ? '۱. پیش‌برآورد هزینه (`/v1/audio/estimates`)' : '1. Pre-Estimate Cost (`/v1/audio/estimates`)'}
                  </button>
                  <button
                    type="button"
                    data-testid="btn-execute-api-playground"
                    onClick={handleExecutePlaygroundTranscription}
                    className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px]"
                  >
                    <Play className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {isFa
                        ? '۲. ارسال درخواست واقعی `/v1/audio/transcriptions`'
                        : '2. Send Live Request `/v1/audio/transcriptions`'}
                    </span>
                  </button>
                </div>

                {estimateResult && (
                  <pre className="p-2.5 rounded-lg bg-[var(--avp-bg-subtle)] border border-[var(--avp-warning)]/35 font-mono text-[11px] overflow-x-auto text-[var(--avp-warning-text)]" dir="ltr">
                    {JSON.stringify(estimateResult, null, 2)}
                  </pre>
                )}
                {apiPlayResult && (
                  <pre
                    data-testid="playground-api-response"
                    className="p-3 rounded-lg bg-[var(--avp-bg-subtle)] border border-[var(--avp-success)]/35 font-mono text-[11px] overflow-x-auto text-[var(--avp-success-text)]"
                    dir="ltr"
                  >
                    {JSON.stringify(apiPlayResult, null, 2)}
                  </pre>
                )}
              </div>

              <div className="p-4 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-[var(--avp-text)]">
                    {isFa ? 'نمونه کد رسمی SDKهای TypeScript و Python' : 'Official TypeScript & Python SDK Snippets'}
                  </h4>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSdkLangTab('ts')}
                      className={`min-h-[36px] sm:min-h-[28px] px-2.5 py-1 rounded font-mono cursor-pointer border ${
                        sdkLangTab === 'ts'
                          ? 'bg-[var(--avp-brand)] text-white border-[var(--avp-brand)]'
                          : 'bg-[var(--avp-bg)] text-[var(--avp-text-secondary)] border-[var(--avp-border)]'
                      }`}
                    >
                      TypeScript (@asr-platform/sdk)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSdkLangTab('py')}
                      className={`min-h-[36px] sm:min-h-[28px] px-2.5 py-1 rounded font-mono cursor-pointer border ${
                        sdkLangTab === 'py'
                          ? 'bg-[var(--avp-brand)] text-white border-[var(--avp-brand)]'
                          : 'bg-[var(--avp-bg)] text-[var(--avp-text-secondary)] border-[var(--avp-border)]'
                      }`}
                    >
                      Python (asr-platform-python)
                    </button>
                  </div>
                </div>
                <pre className="p-3 rounded-lg bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] font-mono text-[11px] overflow-x-auto text-[var(--avp-text)]" dir="ltr">
                  {sdkLangTab === 'ts' ? tsSnippet : pySnippet}
                </pre>
              </div>
            </section>
          )}

          {/* TAB 4: USAGE, LEDGER & IMMUTABLE INVOICES */}
          {activeTab === 'usage_billing' && overview && (
            <section className="space-y-4 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[var(--avp-text-secondary)]">
                    {isFa ? 'تطابق لجر با مصرف (Reconciliation)' : 'Ledger Reconciliation'}
                  </div>
                  <div className="text-base font-bold font-mono text-[var(--avp-success-text)] mt-1" dir="ltr">
                    {overview.reconciliation.balanced ? 'BALANCED (Discrepancy = 0¢)' : 'MISMATCH'}
                  </div>
                </div>
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[var(--avp-text-secondary)]">
                    {isFa ? 'مجموع برداشت مصرفی (Integer Cents)' : 'Total Consumed (Integer Cents)'}
                  </div>
                  <div className="text-base font-bold font-mono text-[var(--avp-warning-text)] mt-1" dir="ltr">
                    {overview.reconciliation.ledgerConsumptionMinor}¢ (${(overview.reconciliation.ledgerConsumptionMinor / 100).toFixed(2)})
                  </div>
                </div>
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[var(--avp-text-secondary)]">
                      {isFa ? 'صدور فاکتور تغییرناپذیر' : 'Immutable Invoice'}
                    </div>
                    <div className="font-mono text-[var(--avp-accent-text)] mt-1">
                      {overview.invoices.length} {isFa ? 'فاکتور' : 'invoices'}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="btn-issue-invoice"
                    onClick={handleIssueInvoice}
                    className="min-h-[44px] sm:min-h-[34px] px-3 py-1.5 rounded-lg bg-[var(--avp-success-soft)] border border-[var(--avp-success)]/40 text-[var(--avp-success-text)] font-medium cursor-pointer"
                  >
                    {isFa ? 'صدور صورتحساب دوره' : 'Issue Period Invoice'}
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[var(--avp-border)]">
                <table className={`w-full ${isFa ? 'text-right' : 'text-left'}`}>
                  <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                    <tr>
                      <th className="p-2.5">{isFa ? 'شناسه تراکنش لجر' : 'Ledger Entry ID'}</th>
                      <th className="p-2.5">{isFa ? 'نوع' : 'Type'}</th>
                      <th className="p-2.5">{isFa ? 'بدهکار ← بستانکار' : 'Debit → Credit'}</th>
                      <th className="p-2.5">{isFa ? 'مبلغ (Minor Cents)' : 'Amount (Minor Cents)'}</th>
                      <th className="p-2.5">{isFa ? 'شرح' : 'Note'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                    {overview.ledgerEntries.map((l) => (
                      <tr key={l.ledgerEntryId}>
                        <td className="p-2.5 font-mono text-[var(--avp-accent-text)]">{l.ledgerEntryId.slice(0, 18)}</td>
                        <td className="p-2.5 font-mono text-[var(--avp-warning-text)]">{l.transactionType}</td>
                        <td className="p-2.5 font-mono text-[11px]" dir="ltr">{l.debitAccount} → {l.creditAccount}</td>
                        <td className="p-2.5 font-mono">{l.amountMinor}¢</td>
                        <td className="p-2.5 text-[var(--avp-text-secondary)]">{l.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {overview.invoices.length > 0 && (
                <div className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2">
                  <div className="font-semibold text-[var(--avp-text)]">
                    {isFa ? 'فاکتورهای صادرشده (Snapshot قفل‌شده با SHA-256)' : 'Issued Invoices (SHA-256 Locked Snapshot)'}
                  </div>
                  {overview.invoices.map((inv) => (
                    <div key={inv.invoiceId} className="p-2.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] flex flex-wrap justify-between gap-2 font-mono" dir="ltr">
                      <span className="text-[var(--avp-accent-text)]">{inv.invoiceNumber}</span>
                      <span>Plan: {inv.pricingSnapshot.planId} ({inv.pricingSnapshot.planVersion})</span>
                      <span>Total: {inv.totalMinor}¢ {inv.currency}</span>
                      <span className="text-[var(--avp-success-text)]">{inv.status}</span>
                      <span className="text-[var(--avp-text-muted)]">SHA256: {inv.snapshotSha256.slice(0, 16)}...</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* TAB 5: WEBHOOKS & DEAD LETTER QUEUE */}
          {activeTab === 'webhooks' && overview && (
            <section className="space-y-4 text-xs">
              <form onSubmit={handleRegisterWebhook} className="p-4 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] flex flex-wrap items-center gap-2">
                <label htmlFor="portal-webhook-url" className="sr-only">
                  {isFa ? 'آدرس Webhook' : 'Webhook Endpoint URL'}
                </label>
                <input
                  id="portal-webhook-url"
                  type="url"
                  dir="ltr"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  aria-label={isFa ? 'آدرس Webhook' : 'Webhook Endpoint URL'}
                  className="flex-1 min-w-[260px] min-h-[44px] sm:min-h-[36px] px-3 py-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] font-mono text-[var(--avp-text)]"
                />
                <button
                  type="submit"
                  className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px]"
                >
                  {isFa ? 'ثبت Endpoint' : 'Register Endpoint'}
                </button>
                <button
                  type="button"
                  data-testid="btn-dispatch-webhook-fail"
                  onClick={() => handleDispatchWebhook(true)}
                  className="min-h-[44px] sm:min-h-[36px] px-3 py-2 rounded-lg border border-[var(--avp-danger)]/40 bg-[var(--avp-danger-soft)] text-[var(--avp-danger-text)] cursor-pointer"
                >
                  {isFa ? 'شبیه‌سازی خطا و انتقال به DLQ' : 'Simulate Failure & Route to DLQ'}
                </button>
              </form>
              {webhookSigningSecretOnce && (
                <div
                  data-testid="webhook-signing-secret-once-banner"
                  className="p-3 rounded-lg border border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="space-y-0.5">
                    <div className="text-[var(--avp-warning-text)] font-semibold">
                      {isFa
                        ? 'کلید امضای Webhook (فقط همین یک‌بار نمایش داده می‌شود):'
                        : 'Webhook Signing Secret (displayed once):'}
                    </div>
                    <code className="block font-mono text-xs text-[var(--avp-text)] break-all" dir="ltr">
                      {webhookSigningSecretOnce}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() => setWebhookSigningSecretOnce(null)}
                    className="min-h-[36px] px-2.5 py-1 rounded border border-[var(--avp-warning)]/40 text-[var(--avp-warning-text)] cursor-pointer"
                  >
                    {isFa ? 'بستن' : 'Dismiss'}
                  </button>
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-[var(--avp-border)]">
                <table className={`w-full ${isFa ? 'text-right' : 'text-left'}`}>
                  <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                    <tr>
                      <th className="p-2.5">Delivery ID</th>
                      <th className="p-2.5">{isFa ? 'رویداد' : 'Event'}</th>
                      <th className="p-2.5">{isFa ? 'وضعیت' : 'Status'}</th>
                      <th className="p-2.5">{isFa ? 'امضای HMAC' : 'HMAC Signature'}</th>
                      <th className="p-2.5">{isFa ? 'عملیات DLQ' : 'DLQ Action'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                    {overview.webhookDeliveries.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-[var(--avp-text-secondary)]">
                          {isFa ? 'هنوز رویداد Webhook ارسال نشده است.' : 'No webhook events dispatched yet.'}
                        </td>
                      </tr>
                    ) : (
                      overview.webhookDeliveries.map((d) => (
                        <tr key={d.deliveryId}>
                          <td className="p-2.5 font-mono text-[var(--avp-accent-text)]">{d.deliveryId.slice(0, 14)}</td>
                          <td className="p-2.5 font-mono">{d.eventType}</td>
                          <td className="p-2.5 font-mono">
                            <span className={d.status === 'DELIVERED' ? 'text-[var(--avp-success-text)]' : 'text-[var(--avp-danger-text)]'}>
                              {d.status} (HTTP {d.httpStatus ?? 'PENDING'})
                            </span>
                          </td>
                          <td className="p-2.5 font-mono text-[11px] text-[var(--avp-text-muted)]" dir="ltr">
                            {d.signatureHeader.slice(0, 28)}...
                          </td>
                          <td className="p-2.5">
                            {d.status === 'DEAD_LETTER' && (
                              <button
                                type="button"
                                data-testid={`btn-replay-dlq-${d.deliveryId}`}
                                onClick={() => handleReplayWebhook(d.deliveryId)}
                                className="min-h-[36px] sm:min-h-[28px] inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[var(--avp-success-soft)] border border-[var(--avp-success)]/40 text-[var(--avp-success-text)] cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                                <span>{isFa ? 'Replay دستی' : 'Manual Replay'}</span>
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
              <div className="p-4 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                      {isFa
                        ? 'حاکمیت چندمنطقه‌ای و مسدودسازی خودکار مناطق ممنوعه (Data Residency Hard Constraint)'
                        : 'Multi-Region Governance & Automatic Prohibited-Region Block (Data Residency)'}
                    </h3>
                    <p className="text-[var(--avp-text-secondary)]">
                      {isFa ? (
                        <>
                          سیاست فعلی مستأجر: مجاز `ir-thr-01` · ممنوع `{overview.organization?.prohibitedRegions.join(', ')}`
                        </>
                      ) : (
                        <>
                          Tenant policy: allowed `ir-thr-01` · prohibited `{overview.organization?.prohibitedRegions.join(', ')}`
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="portal-region-select" className="sr-only">
                      {isFa ? 'منطقه آزمایشی Data Residency' : 'Test Data Residency Region'}
                    </label>
                    <select
                      id="portal-region-select"
                      aria-label={isFa ? 'منطقه آزمایشی Data Residency' : 'Test Data Residency Region'}
                      value={selectedTestRegion}
                      onChange={(e) => setSelectedTestRegion(e.target.value)}
                      className="min-h-[44px] sm:min-h-[34px] px-2.5 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] font-mono text-[var(--avp-text)]"
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
                      className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[34px]"
                    >
                      {isFa ? 'بررسی مجوز اقامت داده' : 'Check Data Residency'}
                    </button>
                  </div>
                </div>
                {regionCheckResult && (
                  <div
                    data-testid="region-residency-result"
                    className={`p-2.5 rounded-lg border ${
                      regionCheckResult.allowed
                        ? 'border-[var(--avp-success)]/40 bg-[var(--avp-success-soft)] text-[var(--avp-success-text)]'
                        : 'border-[var(--avp-danger)]/40 bg-[var(--avp-danger-soft)] text-[var(--avp-danger-text)]'
                    }`}
                  >
                    {regionCheckResult.message}
                  </div>
                )}
              </div>

              <div className="p-4 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2">
                <div className="flex items-center gap-2 font-semibold text-[var(--avp-text)]">
                  <ShieldCheck className="w-4 h-4 text-[var(--avp-success-text)]" aria-hidden="true" />
                  <span>
                    {isFa ? 'گزارش حسابرسی امنیتی و عملیاتی (Audit Log)' : 'Security & Operational Audit Log'}
                  </span>
                </div>
                <div className="space-y-1.5 max-h-56 overflow-y-auto font-mono text-[11px]">
                  {overview.auditLogs.length === 0 ? (
                    <div className="text-[var(--avp-text-secondary)]">
                      {isFa ? 'رویدادی ثبت نشده است.' : 'No audit events recorded.'}
                    </div>
                  ) : (
                    overview.auditLogs
                      .slice()
                      .reverse()
                      .map((a) => (
                        <div key={a.auditId} className="p-2 rounded-lg bg-[var(--avp-bg)] border border-[var(--avp-border)] flex justify-between gap-2">
                          <span className={a.outcome === 'ALLOWED' ? 'text-[var(--avp-success-text)]' : 'text-[var(--avp-danger-text)]'}>
                            [{a.outcome}] {a.action}
                          </span>
                          <span className="text-[var(--avp-text-secondary)] truncate">{a.reason}</span>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </AccessibleModal>
  );
};
