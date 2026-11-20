/**
 * AVAPARDAZ — COMPANION CONNECTION DIAGNOSTIC ENGINE
 *
 * Pure, testable diagnostic and endpoint-validation logic for verifying live
 * connectivity to the Local Companion Web Service at a user-configured endpoint.
 *
 * Enforces AVAPARDAZ 100% local-only privacy invariants:
 * - Only same-origin `/api/...` paths or explicit loopback (`127.0.0.1`, `localhost`, `[::1]`)
 *   HTTP endpoints are accepted.
 * - Executes real, multi-stage verification:
 *   1. Endpoint & Local-Only Policy Validation
 *   2. Health & Runtime Probe (`GET {endpoint}/health`)
 *   3. Authenticated Handshake & IPC Probe (`POST {endpoint}/handshake` + `POST {endpoint}/ipc`)
 */

import type { CompanionHealthResponse } from './CompanionWebClient';

export const DEFAULT_COMPANION_ENDPOINT = '/api/v2/companion';
export const STANDALONE_COMPANION_ENDPOINT = 'http://127.0.0.1:47291/api/v2/companion';
export const COMPANION_ENDPOINT_STORAGE_KEY = 'avapardaz.companion.endpoint.v1';

export type CompanionEndpointKind = 'SAME_ORIGIN_PROXY' | 'LOOPBACK_DAEMON';

export interface CompanionEndpointValidationResult {
  readonly valid: boolean;
  readonly normalizedEndpoint: string;
  readonly kind: CompanionEndpointKind | null;
  readonly errorCode:
    | null
    | 'EMPTY_ENDPOINT'
    | 'INVALID_URL_SYNTAX'
    | 'UNSUPPORTED_PROTOCOL'
    | 'REMOTE_HOST_BLOCKED';
  readonly errorMessageFa: string | null;
  readonly errorMessageEn: string | null;
}

export type DiagnosticStageId = 'ENDPOINT_POLICY' | 'HEALTH_PROBE' | 'HANDSHAKE_AND_IPC';
export type DiagnosticStageStatus = 'PASS' | 'WARN' | 'FAIL';
export type OverallConnectionStatus = 'CONNECTED' | 'DEGRADED' | 'UNREACHABLE' | 'INVALID_ENDPOINT';

export interface CompanionDiagnosticStage {
  readonly id: DiagnosticStageId;
  readonly status: DiagnosticStageStatus;
  readonly latencyMs: number | null;
  readonly httpStatus: number | null;
  readonly summaryFa: string;
  readonly summaryEn: string;
  readonly detail: string | null;
}

export interface CompanionConnectionReport {
  readonly endpoint: string;
  readonly endpointKind: CompanionEndpointKind | null;
  readonly overallStatus: OverallConnectionStatus;
  readonly checkedAtIso: string;
  readonly totalLatencyMs: number;
  readonly stages: readonly CompanionDiagnosticStage[];
  readonly health: CompanionHealthResponse | null;
  readonly capabilityCount: number | null;
  readonly sessionVerified: boolean;
  readonly remediationFa: string | null;
  readonly remediationEn: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Validates and normalizes a configured Companion API endpoint.
 * Strictly blocks remote non-loopback hosts so local audio never leaves the device.
 */
export function normalizeAndValidateCompanionEndpoint(
  rawInput: string,
): CompanionEndpointValidationResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      valid: false,
      normalizedEndpoint: '',
      kind: null,
      errorCode: 'EMPTY_ENDPOINT',
      errorMessageFa: 'نشانی سرویس Companion نمی‌تواند خالی باشد.',
      errorMessageEn: 'Companion API endpoint cannot be empty.',
    };
  }

  // Allow relative same-origin API paths such as `/api/v2/companion`
  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//') || /\s/.test(trimmed)) {
      return {
        valid: false,
        normalizedEndpoint: trimmed,
        kind: null,
        errorCode: 'INVALID_URL_SYNTAX',
        errorMessageFa: 'مسیر نسبی API معتبر نیست. مثال صحیح: /api/v2/companion',
        errorMessageEn: 'Invalid relative API path. Example: /api/v2/companion',
      };
    }
    const normalized = stripTrailingSlashes(trimmed) || '/';
    return {
      valid: true,
      normalizedEndpoint: normalized,
      kind: 'SAME_ORIGIN_PROXY',
      errorCode: null,
      errorMessageFa: null,
      errorMessageEn: null,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalizedEndpoint: trimmed,
      kind: null,
      errorCode: 'INVALID_URL_SYNTAX',
      errorMessageFa:
        'فرمت نشانی نامعتبر است. از مسیر نسبی (/api/v2/companion) یا نشانی محلی http://127.0.0.1:47291/api/v2/companion استفاده کنید.',
      errorMessageEn:
        'Invalid endpoint URL. Use a relative path (/api/v2/companion) or local http://127.0.0.1:47291/api/v2/companion.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      normalizedEndpoint: trimmed,
      kind: null,
      errorCode: 'UNSUPPORTED_PROTOCOL',
      errorMessageFa: `پروتکل ${parsed.protocol} پشتیبانی نمی‌شود. فقط HTTP/HTTPS محلی مجاز است.`,
      errorMessageEn: `Protocol ${parsed.protocol} is not supported. Only local HTTP/HTTPS is allowed.`,
    };
  }

  const hostnameLower = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostnameLower)) {
    return {
      valid: false,
      normalizedEndpoint: trimmed,
      kind: null,
      errorCode: 'REMOTE_HOST_BLOCKED',
      errorMessageFa: `اتصال به میزبان خارجی (${parsed.hostname}) مسدود شد. سرویس Companion فقط روی میزبان محلی (127.0.0.1 / localhost) یا مسیر هم‌دامنه مجاز است.`,
      errorMessageEn: `Remote host (${parsed.hostname}) is blocked by the 100% local-only privacy policy. Use localhost, 127.0.0.1, or a same-origin path.`,
    };
  }

  const cleanPath = stripTrailingSlashes(parsed.pathname);
  const normalized = `${parsed.origin}${cleanPath}`;
  return {
    valid: true,
    normalizedEndpoint: normalized,
    kind: 'LOOPBACK_DAEMON',
    errorCode: null,
    errorMessageFa: null,
    errorMessageEn: null,
  };
}

export function loadConfiguredCompanionEndpoint(
  storage?: Pick<Storage, 'getItem'> | null,
): string {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    const saved = store?.getItem(COMPANION_ENDPOINT_STORAGE_KEY);
    if (saved) {
      const check = normalizeAndValidateCompanionEndpoint(saved);
      if (check.valid) return check.normalizedEndpoint;
    }
  } catch {
    // Ignore restricted storage environments
  }
  return DEFAULT_COMPANION_ENDPOINT;
}

export function saveConfiguredCompanionEndpoint(
  endpoint: string,
  storage?: Pick<Storage, 'setItem'> | null,
): CompanionEndpointValidationResult {
  const validation = normalizeAndValidateCompanionEndpoint(endpoint);
  if (!validation.valid) return validation;
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    store?.setItem(COMPANION_ENDPOINT_STORAGE_KEY, validation.normalizedEndpoint);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
  return validation;
}

async function safeParseJsonBody<T>(
  resp: Response,
): Promise<{ ok: true; data: T } | { ok: false; detail: string }> {
  const rawText = await resp.text();
  if (!rawText || rawText.trim().length === 0) {
    return { ok: false, detail: `HTTP ${resp.status} (empty body)` };
  }
  try {
    return { ok: true, data: JSON.parse(rawText) as T };
  } catch {
    const titleMatch = rawText.match(/<title>([^<]{1,100})<\/title>/i);
    const htmlHint = titleMatch?.[1]?.trim();
    return {
      ok: false,
      detail: htmlHint
        ? `HTTP ${resp.status} non-JSON response (${htmlHint})`
        : `HTTP ${resp.status} non-JSON response`,
    };
  }
}

function createProbeNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `diag_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function extractNetworkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'Request timed out or cancelled';
    return err.message;
  }
  return String(err);
}

/**
 * Executes a real, 3-stage connectivity diagnostic against the configured
 * Local Companion Web Service endpoint.
 */
export async function runCompanionConnectionDiagnostic(options: {
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}): Promise<CompanionConnectionReport> {
  const startedAll = nowMs();
  const checkedAtIso = new Date().toISOString();
  const fetchFn: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 8_000;

  const validation = normalizeAndValidateCompanionEndpoint(options.endpoint);
  if (!validation.valid) {
    return {
      endpoint: options.endpoint.trim(),
      endpointKind: null,
      overallStatus: 'INVALID_ENDPOINT',
      checkedAtIso,
      totalLatencyMs: Math.max(0, Math.round(nowMs() - startedAll)),
      stages: [
        {
          id: 'ENDPOINT_POLICY',
          status: 'FAIL',
          latencyMs: 0,
          httpStatus: null,
          summaryFa: validation.errorMessageFa ?? 'نشانی سرویس نامعتبر است.',
          summaryEn: validation.errorMessageEn ?? 'Invalid Companion endpoint.',
          detail: validation.errorCode,
        },
      ],
      health: null,
      capabilityCount: null,
      sessionVerified: false,
      remediationFa:
        'نشانی را به /api/v2/companion (میزبان فعلی) یا http://127.0.0.1:47291/api/v2/companion تغییر دهید.',
      remediationEn:
        'Set the endpoint to /api/v2/companion (same-origin) or http://127.0.0.1:47291/api/v2/companion.',
    };
  }

  const baseUrl = validation.normalizedEndpoint;
  const stages: CompanionDiagnosticStage[] = [
    {
      id: 'ENDPOINT_POLICY',
      status: 'PASS',
      latencyMs: 0,
      httpStatus: null,
      summaryFa:
        validation.kind === 'SAME_ORIGIN_PROXY'
          ? 'نشانی هم‌دامنه معتبر (سیاست ۱۰۰٪ محلی)'
          : 'نشانی Loopback محلی معتبر (127.0.0.1 / localhost)',
      summaryEn:
        validation.kind === 'SAME_ORIGIN_PROXY'
          ? 'Valid same-origin API path (100% local policy)'
          : 'Valid loopback daemon endpoint (127.0.0.1 / localhost)',
      detail: baseUrl,
    },
  ];

  // Combine caller AbortSignal with an internal timeout controller
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  };

  try {
    // Stage 2: GET {baseUrl}/health
    const healthStart = nowMs();
    let healthResp: Response;
    try {
      healthResp = await fetchFn(`${baseUrl}/health`, {
        method: 'GET',
        signal: timeoutController.signal,
      });
    } catch (err) {
      const latencyMs = Math.max(0, Math.round(nowMs() - healthStart));
      const detail = extractNetworkErrorMessage(err);
      stages.push({
        id: 'HEALTH_PROBE',
        status: 'FAIL',
        latencyMs,
        httpStatus: null,
        summaryFa: 'سرویس محلی Companion پاسخ نداد.',
        summaryEn: 'Local Companion service could not be reached.',
        detail,
      });
      return {
        endpoint: baseUrl,
        endpointKind: validation.kind,
        overallStatus: 'UNREACHABLE',
        checkedAtIso,
        totalLatencyMs: Math.max(0, Math.round(nowMs() - startedAll)),
        stages,
        health: null,
        capabilityCount: null,
        sessionVerified: false,
        remediationFa:
          validation.kind === 'LOOPBACK_DAEMON'
            ? 'مطمئن شوید سرویس دسکتاپ آواپرداز روی پورت محلی در حال اجرا است یا به مسیر /api/v2/companion برگردید.'
            : 'سرور محلی برنامه در دسترس نیست. صفحه را بازآوری کنید یا سرویس Companion را دوباره اجرا نمایید.',
        remediationEn:
          validation.kind === 'LOOPBACK_DAEMON'
            ? 'Ensure the local AVAPARDAZ Companion daemon is running on that port, or switch to /api/v2/companion.'
            : 'The local app Companion route is unreachable. Restart the local server or verify the configured path.',
      };
    }

    const healthLatencyMs = Math.max(0, Math.round(nowMs() - healthStart));
    const parsedHealth = await safeParseJsonBody<CompanionHealthResponse>(healthResp);
    if (!healthResp.ok || !parsedHealth.ok) {
      const detail = !parsedHealth.ok
        ? parsedHealth.detail
        : `HTTP ${healthResp.status}`;
      stages.push({
        id: 'HEALTH_PROBE',
        status: 'FAIL',
        latencyMs: healthLatencyMs,
        httpStatus: healthResp.status,
        summaryFa: `پاسخ نامعتبر از نقطه سلامت سرویس (HTTP ${healthResp.status}).`,
        summaryEn: `Health endpoint returned an invalid response (HTTP ${healthResp.status}).`,
        detail,
      });
      return {
        endpoint: baseUrl,
        endpointKind: validation.kind,
        overallStatus: 'UNREACHABLE',
        checkedAtIso,
        totalLatencyMs: Math.max(0, Math.round(nowMs() - startedAll)),
        stages,
        health: null,
        capabilityCount: null,
        sessionVerified: false,
        remediationFa:
          'نشانی واردشده به یک سرویس Companion معتبر اشاره نمی‌کند (پاسخ غیر-JSON یا خطای HTTP). مسیر /api/v2/companion را بررسی کنید.',
        remediationEn:
          'The configured endpoint did not return a valid Companion health payload. Verify that it points to /api/v2/companion.',
      };
    }

    const health = parsedHealth.data;
    const runtimeReady = Boolean(health.runtime?.available);
    stages.push({
      id: 'HEALTH_PROBE',
      status: runtimeReady ? 'PASS' : 'WARN',
      latencyMs: healthLatencyMs,
      httpStatus: healthResp.status,
      summaryFa: runtimeReady
        ? `سرویس ${health.service} (${health.serviceVersion}) و موتور ${health.runtime.runtimeName} آماده است.`
        : `سرویس ${health.service} متصل است اما موتور عصبی محلی هنوز آماده نیست.`,
      summaryEn: runtimeReady
        ? `${health.service} (${health.serviceVersion}) & ${health.runtime.runtimeName} runtime ready.`
        : `${health.service} is reachable, but the local neural runtime is not ready.`,
      detail: `IPC v${health.ipcProtocolVersion} · ${health.runtime.installedModels.length} model(s) · ${health.runtime.processRssMb} MB RSS`,
    });

    // Stage 3: POST {baseUrl}/handshake + POST {baseUrl}/ipc (CAPABILITY_LIST)
    const ipcStart = nowMs();
    try {
      const hsResp = await fetchFn(`${baseUrl}/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: timeoutController.signal,
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          host_id: 'cli-test',
          host_version: 'web-diagnostic-1.0.0',
          panel_version: '1.0.0',
          host_adapter_version: '1.0.0',
          expected_contract_version: '2.0.0',
        }),
      });
      const parsedHs = await safeParseJsonBody<{
        compatible?: boolean;
        session_id?: string | null;
        session_token?: string | null;
        incompatibility_reasons?: string[];
        error?: string;
        message?: string;
      }>(hsResp);

      if (
        !hsResp.ok ||
        !parsedHs.ok ||
        !parsedHs.data.compatible ||
        !parsedHs.data.session_id ||
        !parsedHs.data.session_token
      ) {
        const hsLatencyMs = Math.max(0, Math.round(nowMs() - ipcStart));
        const reason = !parsedHs.ok
          ? parsedHs.detail
          : parsedHs.data.incompatibility_reasons?.join('; ') ||
            parsedHs.data.message ||
            parsedHs.data.error ||
            `HTTP ${hsResp.status}`;
        stages.push({
          id: 'HANDSHAKE_AND_IPC',
          status: 'FAIL',
          latencyMs: hsLatencyMs,
          httpStatus: hsResp.status,
          summaryFa: 'احراز هویت نشست (Handshake) با سرویس Companion رد شد.',
          summaryEn: 'Authenticated Companion session handshake was rejected.',
          detail: reason,
        });
        return {
          endpoint: baseUrl,
          endpointKind: validation.kind,
          overallStatus: 'DEGRADED',
          checkedAtIso,
          totalLatencyMs: Math.max(0, Math.round(nowMs() - startedAll)),
          stages,
          health,
          capabilityCount: null,
          sessionVerified: false,
          remediationFa:
            'نقطه سلامت باز است اما درخواست POST /handshake مسدود شد (بررسی Origin/Host یا نسخه قرارداد IPC).',
          remediationEn:
            'Health responded, but POST /handshake failed (check Origin/Host security guard or IPC contract version).',
        };
      }

      // Issue an authenticated CAPABILITY_LIST command to confirm Bearer token + nonce replay guard
      const ipcResp = await fetchFn(`${baseUrl}/ipc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parsedHs.data.session_token}`,
        },
        signal: timeoutController.signal,
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          session_id: parsedHs.data.session_id,
          nonce: createProbeNonce(),
          timestamp_ms: Date.now(),
          command: 'CAPABILITY_LIST',
          payload: {},
        }),
      });
      const ipcLatencyMs = Math.max(0, Math.round(nowMs() - ipcStart));
      const parsedIpc = await safeParseJsonBody<{
        ok?: boolean;
        capabilities?: unknown[];
        message?: string;
        error?: string;
      }>(ipcResp);

      if (!ipcResp.ok || !parsedIpc.ok || parsedIpc.data.ok === false) {
        const reason = !parsedIpc.ok
          ? parsedIpc.detail
          : parsedIpc.data.message || parsedIpc.data.error || `HTTP ${ipcResp.status}`;
        stages.push({
          id: 'HANDSHAKE_AND_IPC',
          status: 'FAIL',
          latencyMs: ipcLatencyMs,
          httpStatus: ipcResp.status,
          summaryFa: 'نشست ایجاد شد اما ارسال فرمان امن IPC ناموفق بود.',
          summaryEn: 'Handshake succeeded, but the authenticated IPC probe failed.',
          detail: reason,
        });
        return {
          endpoint: baseUrl,
          endpointKind: validation.kind,
          overallStatus: 'DEGRADED',
          checkedAtIso,
          totalLatencyMs: Math.max(0, Math.round(nowMs() - startedAll)),
          stages,
          health,
          capabilityCount: null,
          sessionVerified: false,
          remediationFa:
            'توکن نشست یا هدر Authorization در مسیر پروکسی دچار مشکل شده است.',
          remediationEn:
            'Bearer token or IPC route failed after handshake. Check local proxy headers.',
        };
      }

      const capCount = Array.isArray(parsedIpc.data.capabilities)
        ? parsedIpc.data.capabilities.length
        : null;

      stages.push({
        id: 'HANDSHAKE_AND_IPC',
        status: 'PASS',
        latencyMs: ipcLatencyMs,
        httpStatus: ipcResp.status,
        summaryFa:
          capCount !== null
            ? `نشست امن HMAC و کانال IPC تایید شد (${capCount} قابلیت فعال).`
            : 'نشست امن HMAC و کانال IPC با موفقیت تایید شد.',
        summaryEn:
          capCount !== null
            ? `HMAC session & IPC channel verified (${capCount} capabilities active).`
            : 'HMAC session & authenticated IPC channel verified.',
        detail: `Bearer session OK · Nonce verified`,
      });

      return {
        endpoint: baseUrl,
        endpointKind: validation.kind,
        overallStatus: runtimeReady ? 'CONNECTED' : 'DEGRADED',
        checkedAtIso,
        totalLatencyMs: Math.max(0, Math.round(nowMs() - startedAll)),
        stages,
        health,
        capabilityCount: capCount,
        sessionVerified: true,
        remediationFa: runtimeReady
          ? null
          : 'ارتباط شبکه سالم است اما مدل ONNX محلی یافت نشد؛ مدل محلی را از بخش مدیریت محصول نصب یا بررسی کنید.',
        remediationEn: runtimeReady
          ? null
          : 'Connectivity is healthy, but no local ONNX ASR model is active. Check Product & Health -> Local Model.',
      };
    } catch (err) {
      const ipcLatencyMs = Math.max(0, Math.round(nowMs() - ipcStart));
      stages.push({
        id: 'HANDSHAKE_AND_IPC',
        status: 'FAIL',
        latencyMs: ipcLatencyMs,
        httpStatus: null,
        summaryFa: 'خطای شبکه هنگام اجرای Handshake/IPC.',
        summaryEn: 'Network error during Companion handshake/IPC verification.',
        detail: extractNetworkErrorMessage(err),
      });
      return {
        endpoint: baseUrl,
        endpointKind: validation.kind,
        overallStatus: 'DEGRADED',
        checkedAtIso,
        totalLatencyMs: Math.max(0, Math.round(nowMs() - startedAll)),
        stages,
        health,
        capabilityCount: null,
        sessionVerified: false,
        remediationFa:
          'درخواست GET موفق بود اما درخواست POST مسدود یا قطع شد (بررسی CORS / پروکسی محلی).',
        remediationEn:
          'GET /health succeeded, but POST /handshake failed due to a network or CORS error.',
      };
    }
  } finally {
    cleanup();
  }
}
