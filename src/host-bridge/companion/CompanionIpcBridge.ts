/**
 * AVAPARDAZ — NATIVE PROCESSING COMPANION VERSIONED IPC SECURITY BRIDGE
 *
 * Compliant with AVP-ARCH-001 (Version 4.0) Sections 8.3, 8.5 & 15.2:
 * - Explicit versioned IPC protocol (`IPC_PROTOCOL_VERSION = '1.0.0'`)
 * - Component compatibility handshake (`panel_version`, `host_adapter_version`, `contract_version`)
 * - Loopback-only access control (`127.0.0.1` / `::1`) — rejects non-loopback callers
 * - Short-lived HMAC-SHA256 session tokens + nonce replay protection
 * - Zero hardcoded secrets distributed in plugin code (ephemeral per-process secret)
 */

import crypto from 'node:crypto';
import { CANONICAL_CONTRACT_VERSION } from '../../processing-engine/capabilities/CanonicalCapabilityContracts';
import { AVAPARDAZ_ASR_CONTRACT_VERSION } from '../../asr-core/AsrContractVersion';
import { CEP_TRANSCRIPT_SCHEMA_VERSION } from './CepTranscriptDto';

export const COMPANION_IPC_PROTOCOL_VERSION = '1.0.0' as const;
export const MIN_SUPPORTED_PANEL_MAJOR = 1 as const;
export const MIN_SUPPORTED_HOST_ADAPTER_MAJOR = 1 as const;

export interface CompanionHandshakeRequest {
  readonly ipc_protocol_version: string;
  readonly host_id: 'adobe-audition' | 'premiere-pro' | 'davinci-resolve' | 'cli-test';
  readonly host_version: string;
  readonly panel_version: string;
  readonly host_adapter_version: string;
  readonly expected_contract_version: string;
  readonly expected_asr_contract_version?: string;
  readonly expected_cep_transcript_schema_version?: string;
}

export interface CompanionHandshakeResponse {
  readonly compatible: boolean;
  readonly ipc_protocol_version: typeof COMPANION_IPC_PROTOCOL_VERSION;
  readonly companion_contract_version: typeof CANONICAL_CONTRACT_VERSION;
  readonly asr_contract_version: typeof AVAPARDAZ_ASR_CONTRACT_VERSION;
  readonly cep_transcript_schema_version: typeof CEP_TRANSCRIPT_SCHEMA_VERSION;
  readonly session_id: string | null;
  readonly session_token: string | null;
  readonly expires_at: string | null;
  readonly incompatibility_reasons: readonly string[];
}

export const COMPANION_IPC_ERROR_CODES = [
  'IPC_LOOPBACK_ONLY',
  'IPC_TOKEN_MISSING',
  'IPC_TOKEN_INVALID',
  'IPC_SESSION_UNKNOWN',
  'IPC_SESSION_EXPIRED',
  'IPC_VERSION_MISMATCH',
  'IPC_INVALID_ENVELOPE',
  'IPC_TIMESTAMP_OUT_OF_WINDOW',
  'IPC_REQUEST_EXPIRED',
  'IPC_NONCE_REPLAY',
  'IPC_DUPLICATE_REQUEST_ID',
  'DNS_REBINDING_BLOCKED',
  'UNTRUSTED_ORIGIN_BLOCKED',
  'CONCURRENT_JOB_LIMIT_EXCEEDED',
  'LOCAL_NEURAL_RUNTIME_UNAVAILABLE',
  'SOURCE_CHANGED',
  'PAYLOAD_TOO_LARGE',
] as const;

export type CompanionIpcErrorCode = (typeof COMPANION_IPC_ERROR_CODES)[number];

export interface CompanionIpcEnvelope<TPayload = unknown> {
  readonly ipc_protocol_version: typeof COMPANION_IPC_PROTOCOL_VERSION;
  readonly session_id: string;
  readonly nonce: string;
  readonly timestamp_ms: number;
  readonly request_id?: string;
  readonly expires_at_ms?: number;
  readonly execution_mode?: 'native-companion' | 'audition-cep' | 'web-client';
  readonly command:
    | 'CAPABILITY_LIST'
    | 'CAPABILITY_EXECUTE'
    | 'JOB_SUBMIT'
    | 'JOB_STATUS'
    | 'JOB_LIST'
    | 'JOB_RECONNECT'
    | 'JOB_CANCEL'
    | 'HOST_CAPABILITY_MATRIX';
  readonly payload: TPayload;
}

interface ActiveCompanionSession {
  readonly sessionId: string;
  readonly hostId: CompanionHandshakeRequest['host_id'];
  readonly expiresAtMs: number;
  readonly seenNonces: Set<string>;
  readonly seenRequestIds: Set<string>;
}

function parseMajorVersion(semver: string): number | null {
  if (typeof semver !== 'string') return null;
  const match = semver.trim().match(/^(\d+)\.\d+\.\d+/);
  return match ? Number(match[1]) : null;
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost'
  );
}

const ALLOWED_COMPANION_IPC_COMMANDS = new Set<CompanionIpcEnvelope['command']>([
  'CAPABILITY_LIST',
  'CAPABILITY_EXECUTE',
  'JOB_SUBMIT',
  'JOB_STATUS',
  'JOB_LIST',
  'JOB_RECONNECT',
  'JOB_CANCEL',
  'HOST_CAPABILITY_MATRIX',
]);

export class CompanionIpcBridge {
  private readonly processSecret: Buffer;
  private readonly sessions = new Map<string, ActiveCompanionSession>();
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;

  constructor(options?: { readonly sessionTtlMs?: number; readonly maxSessions?: number }) {
    // Ephemeral runtime secret — never stored in distributed plugin bundles (Section 15.3)
    this.processSecret = crypto.randomBytes(32);
    this.sessionTtlMs = Math.max(30_000, options?.sessionTtlMs ?? 30 * 60 * 1000);
    this.maxSessions = Math.max(16, Math.min(5000, options?.maxSessions ?? 1000));
  }

  private sweepExpiredSessions(nowMs = Date.now()): void {
    for (const [id, sess] of this.sessions.entries()) {
      if (nowMs > sess.expiresAtMs) {
        this.sessions.delete(id);
      }
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
  }

  public handshake(
    req: CompanionHandshakeRequest,
    remoteAddress: string | undefined | null,
  ): { readonly statusCode: number; readonly body: CompanionHandshakeResponse } {
    if (!isLoopbackRemoteAddress(remoteAddress)) {
      return {
        statusCode: 403,
        body: Object.freeze({
          compatible: false,
          ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
          companion_contract_version: CANONICAL_CONTRACT_VERSION,
          asr_contract_version: AVAPARDAZ_ASR_CONTRACT_VERSION,
          cep_transcript_schema_version: CEP_TRANSCRIPT_SCHEMA_VERSION,
          session_id: null,
          session_token: null,
          expires_at: null,
          incompatibility_reasons: [
            `LOOPBACK_REQUIRED: Companion IPC rejects non-loopback caller "${String(remoteAddress)}".`,
          ],
        }),
      };
    }

    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      return {
        statusCode: 400,
        body: Object.freeze({
          compatible: false,
          ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
          companion_contract_version: CANONICAL_CONTRACT_VERSION,
          asr_contract_version: AVAPARDAZ_ASR_CONTRACT_VERSION,
          cep_transcript_schema_version: CEP_TRANSCRIPT_SCHEMA_VERSION,
          session_id: null,
          session_token: null,
          expires_at: null,
          incompatibility_reasons: Object.freeze(['INVALID_HANDSHAKE: Request payload must be a JSON object.']),
        }),
      };
    }

    const reasons: string[] = [];
    if (!['adobe-audition', 'premiere-pro', 'davinci-resolve', 'cli-test'].includes(req.host_id)) {
      reasons.push(`Unsupported host_id "${String(req.host_id)}".`);
    }
    if (req.ipc_protocol_version !== COMPANION_IPC_PROTOCOL_VERSION) {
      reasons.push(
        `Unsupported ipc_protocol_version "${String(req.ipc_protocol_version)}" (expected "${COMPANION_IPC_PROTOCOL_VERSION}").`,
      );
    }
    if (req.expected_contract_version !== CANONICAL_CONTRACT_VERSION) {
      reasons.push(
        `Contract mismatch: caller expects "${String(req.expected_contract_version)}", companion serves "${CANONICAL_CONTRACT_VERSION}".`,
      );
    }
    if (req.host_id === 'adobe-audition') {
      if (req.expected_asr_contract_version !== AVAPARDAZ_ASR_CONTRACT_VERSION) {
        reasons.push(
          `ASR contract mismatch: caller expects "${String(req.expected_asr_contract_version)}", companion serves "${AVAPARDAZ_ASR_CONTRACT_VERSION}".`,
        );
      }
      if (req.expected_cep_transcript_schema_version !== CEP_TRANSCRIPT_SCHEMA_VERSION) {
        reasons.push(
          `CEP transcript schema mismatch: caller expects "${String(req.expected_cep_transcript_schema_version)}", companion serves "${CEP_TRANSCRIPT_SCHEMA_VERSION}".`,
        );
      }
    }
    const panelMajor = parseMajorVersion(req.panel_version);
    if (panelMajor === null || panelMajor < MIN_SUPPORTED_PANEL_MAJOR) {
      reasons.push(`Invalid or unsupported panel_version "${String(req.panel_version)}".`);
    }
    const adapterMajor = parseMajorVersion(req.host_adapter_version);
    if (adapterMajor === null || adapterMajor < MIN_SUPPORTED_HOST_ADAPTER_MAJOR) {
      reasons.push(`Invalid or unsupported host_adapter_version "${String(req.host_adapter_version)}".`);
    }

    if (reasons.length > 0) {
      return {
        statusCode: 409,
        body: Object.freeze({
          compatible: false,
          ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
          companion_contract_version: CANONICAL_CONTRACT_VERSION,
          asr_contract_version: AVAPARDAZ_ASR_CONTRACT_VERSION,
          cep_transcript_schema_version: CEP_TRANSCRIPT_SCHEMA_VERSION,
          session_id: null,
          session_token: null,
          expires_at: null,
          incompatibility_reasons: Object.freeze(reasons),
        }),
      };
    }

    const nowMs = Date.now();
    this.sweepExpiredSessions(nowMs);
    const sessionId = `ipc_${crypto.randomBytes(6).toString('hex')}`;
    const expiresAtMs = nowMs + this.sessionTtlMs;
    const token = this.signSessionToken(sessionId, expiresAtMs);

    this.sessions.set(sessionId, {
      sessionId,
      hostId: req.host_id,
      expiresAtMs,
      seenNonces: new Set<string>(),
      seenRequestIds: new Set<string>(),
    });

    return {
      statusCode: 200,
      body: Object.freeze({
        compatible: true,
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        companion_contract_version: CANONICAL_CONTRACT_VERSION,
          asr_contract_version: AVAPARDAZ_ASR_CONTRACT_VERSION,
          cep_transcript_schema_version: CEP_TRANSCRIPT_SCHEMA_VERSION,
        session_id: sessionId,
        session_token: token,
        expires_at: new Date(expiresAtMs).toISOString(),
        incompatibility_reasons: Object.freeze([]),
      }),
    };
  }

  public verifyAuthorizedIpcCall(params: {
    readonly remoteAddress: string | undefined | null;
    readonly bearerToken: string | undefined | null;
    readonly envelope: unknown;
  }): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly code?: string;
    readonly message?: string;
    readonly envelope?: CompanionIpcEnvelope;
  } {
    if (!isLoopbackRemoteAddress(params.remoteAddress)) {
      return {
        ok: false,
        statusCode: 403,
        code: 'IPC_LOOPBACK_ONLY',
        message: 'Local Companion IPC only accepts connections from loopback (127.0.0.1 / ::1).',
      };
    }

    if (!params.bearerToken || typeof params.bearerToken !== 'string') {
      return {
        ok: false,
        statusCode: 401,
        code: 'IPC_TOKEN_MISSING',
        message: 'Companion IPC session token is required.',
      };
    }

    if (!params.envelope || typeof params.envelope !== 'object' || Array.isArray(params.envelope)) {
      return {
        ok: false,
        statusCode: 400,
        code: 'IPC_INVALID_ENVELOPE',
        message: 'IPC message must be a JSON object.',
      };
    }

    const env = params.envelope as Partial<CompanionIpcEnvelope>;
    if (env.ipc_protocol_version !== COMPANION_IPC_PROTOCOL_VERSION) {
      return {
        ok: false,
        statusCode: 409,
        code: 'IPC_VERSION_MISMATCH',
        message: `Unsupported IPC protocol version "${String(env.ipc_protocol_version)}".`,
      };
    }
    const normalizedNonce = typeof env.nonce === 'string' ? env.nonce.trim() : '';
    if (
      typeof env.session_id !== 'string' ||
      env.session_id.trim().length === 0 ||
      normalizedNonce.length === 0 ||
      normalizedNonce.length > 128 ||
      typeof env.timestamp_ms !== 'number' ||
      !Number.isFinite(env.timestamp_ms) ||
      typeof env.command !== 'string' ||
      !ALLOWED_COMPANION_IPC_COMMANDS.has(env.command as CompanionIpcEnvelope['command'])
    ) {
      return {
        ok: false,
        statusCode: 400,
        code: 'IPC_INVALID_ENVELOPE',
        message: 'Valid string session_id, nonce (1-128 chars), finite timestamp_ms, and supported command are required.',
      };
    }

    const session = this.sessions.get(env.session_id);
    if (!session) {
      return {
        ok: false,
        statusCode: 401,
        code: 'IPC_SESSION_UNKNOWN',
        message: 'Unknown or expired Companion IPC session.',
      };
    }
    if (Date.now() > session.expiresAtMs) {
      this.sessions.delete(env.session_id);
      return {
        ok: false,
        statusCode: 401,
        code: 'IPC_SESSION_EXPIRED',
        message: 'Companion IPC session has expired; perform handshake again.',
      };
    }

    const expectedToken = this.signSessionToken(session.sessionId, session.expiresAtMs);
    const providedBuf = Buffer.from(params.bearerToken);
    const expectedBuf = Buffer.from(expectedToken);
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return {
        ok: false,
        statusCode: 401,
        code: 'IPC_TOKEN_INVALID',
        message: 'Invalid Companion IPC session token.',
      };
    }

    if (
      env.execution_mode !== undefined &&
      !['native-companion', 'audition-cep', 'web-client'].includes(env.execution_mode)
    ) {
      return {
        ok: false,
        statusCode: 400,
        code: 'IPC_INVALID_ENVELOPE',
        message: 'execution_mode must be native-companion, audition-cep, or web-client.',
      };
    }
    if (
      (session.hostId === 'adobe-audition' && env.execution_mode !== 'audition-cep') ||
      (session.hostId !== 'adobe-audition' && env.execution_mode === 'audition-cep')
    ) {
      return {
        ok: false,
        statusCode: 409,
        code: 'IPC_VERSION_MISMATCH',
        message: 'execution_mode does not match the host identity established by this IPC session.',
      };
    }

    // Optional per-request expiry enforcement
    if (env.expires_at_ms !== undefined) {
      if (typeof env.expires_at_ms !== 'number' || !Number.isFinite(env.expires_at_ms)) {
        return {
          ok: false,
          statusCode: 400,
          code: 'IPC_INVALID_ENVELOPE',
          message: 'expires_at_ms must be a finite Unix timestamp in milliseconds.',
        };
      }
      if (Date.now() > env.expires_at_ms) {
        return {
          ok: false,
          statusCode: 401,
          code: 'IPC_REQUEST_EXPIRED',
          message: 'IPC request envelope has passed its expires_at_ms deadline.',
        };
      }
    }

    // Optional request_id correlation & duplicate execution protection
    if (env.request_id !== undefined) {
      if (typeof env.request_id !== 'string' || env.request_id.trim().length === 0 || env.request_id.length > 128) {
        return {
          ok: false,
          statusCode: 400,
          code: 'IPC_INVALID_ENVELOPE',
          message: 'request_id must be a non-empty string (max 128 chars).',
        };
      }
      const normReqId = env.request_id.trim();
      if (session.seenRequestIds.has(normReqId)) {
        return {
          ok: false,
          statusCode: 409,
          code: 'IPC_DUPLICATE_REQUEST_ID',
          message: 'Duplicate IPC request_id detected (idempotency guard rejected replay).',
        };
      }
      session.seenRequestIds.add(normReqId);
      if (session.seenRequestIds.size > 2000) {
        const oldestReq = session.seenRequestIds.values().next().value;
        if (oldestReq) session.seenRequestIds.delete(oldestReq);
      }
    }

    // Nonce replay defense + clock skew guard (±5 min)
    if (Math.abs(Date.now() - env.timestamp_ms) > 5 * 60 * 1000) {
      return {
        ok: false,
        statusCode: 401,
        code: 'IPC_TIMESTAMP_OUT_OF_WINDOW',
        message: 'IPC message timestamp is outside the permitted 5-minute window.',
      };
    }
    if (session.seenNonces.has(normalizedNonce)) {
      return {
        ok: false,
        statusCode: 409,
        code: 'IPC_NONCE_REPLAY',
        message: 'Duplicate IPC nonce detected (replay rejected).',
      };
    }
    session.seenNonces.add(normalizedNonce);
    if (session.seenNonces.size > 2000) {
      const oldest = session.seenNonces.values().next().value;
      if (oldest) session.seenNonces.delete(oldest);
    }

    return {
      ok: true,
      statusCode: 200,
      envelope: env as CompanionIpcEnvelope,
    };
  }

  private signSessionToken(sessionId: string, expiresAtMs: number): string {
    const payload = `${sessionId}.${expiresAtMs}`;
    const sig = crypto.createHmac('sha256', this.processSecret).update(payload).digest('hex');
    return `${payload}.${sig}`;
  }
}
