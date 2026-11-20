import express, { type Request, type Response, type Router } from 'express';
import crypto from 'node:crypto';
import { IncrementalSha256 } from '../utils/StreamingSha256';
import { sanitizePublicErrorOutput } from '../ai-engine/asr/IndustrialValidationAndSecurityEngine';

export const STUDIO_CLOUD_PROVIDER_ID = 'google-gemini' as const;
export const STUDIO_CLOUD_MODEL_ID = 'gemini-3.5-transcribe' as const;
export const STUDIO_REQUESTED_WITH_VALUE = 'AvapardazStudio' as const;
export const MAX_STUDIO_CLOUD_AUDIO_SECONDS = 120 as const;
export const MAX_STUDIO_CLOUD_SAMPLE_COUNT_16K = 16_000 * MAX_STUDIO_CLOUD_AUDIO_SECONDS;
export const MAX_STUDIO_CLOUD_WAV_BYTES = 4 * 1024 * 1024; // 4 MiB hard cap (120s 16kHz PCM16 WAV = ~3.84 MiB)
export const MAX_CONSENT_TTL_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_RECEIPTS = 1000;

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const ALLOWED_CONSENT_ISSUE_KEYS = new Set([
  'consentId',
  'projectId',
  'assetId',
  'assetSha256',
  'trackId',
  'startSample16k',
  'endSample16k',
  'payloadSha256',
  'providerId',
  'modelId',
  'maxApprovedCostUsd',
  'ttlMs',
]);

export interface CloudAsrConsentIssueRequest {
  readonly consentId: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly trackId: string;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly payloadSha256: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly maxApprovedCostUsd: number;
  readonly ttlMs?: number;
}

export interface CloudAsrConsentReceipt {
  readonly receiptId: string;
  readonly consentId: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly trackId: string;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly payloadSha256: string;
  readonly providerId: typeof STUDIO_CLOUD_PROVIDER_ID;
  readonly modelId: typeof STUDIO_CLOUD_MODEL_ID;
  readonly maxApprovedCostUsd: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

interface StoredConsentReceiptRecord {
  readonly receipt: CloudAsrConsentReceipt;
  consumed: boolean;
  consumedAtMs: number | null;
}

export type ConsentRegistryErrorCode =
  | 'ORIGIN_FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'CONSENT_ID_DUPLICATE'
  | 'CONSENT_REGISTRY_CAPACITY_EXCEEDED'
  | 'CLOUD_CONSENT_REQUIRED'
  | 'CLOUD_CONSENT_EXPIRED'
  | 'CLOUD_CONSENT_ALREADY_USED'
  | 'CLOUD_CONSENT_RESOURCE_MISMATCH'
  | 'UNSUPPORTED_AUDIO_FORMAT'
  | 'CLOUD_SELECTION_EXCEEDS_LIMIT';

export interface ValidatedMono16kWav {
  readonly byteLength: number;
  readonly dataPayloadBytes: number;
  readonly sampleCount: number;
  readonly actualDurationMs: number;
  readonly sha256Hex: string;
}

export class CloudAsrConsentError extends Error {
  public readonly code: ConsentRegistryErrorCode;
  public readonly httpStatus: number;

  constructor(code: ConsentRegistryErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'CloudAsrConsentError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isNonEmptyBoundedString(val: unknown, maxLen = 256): val is string {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= maxLen;
}

function normalizeSha256(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const lower = val.trim().toLowerCase();
  return SHA256_HEX_RE.test(lower) ? lower : null;
}

/**
 * Validates same-origin browser request semantics + explicit `X-Requested-With: AvapardazStudio`.
 * Rejects cross-site requests and requests lacking the Studio custom header.
 */
export function validateStudioSameOriginRequest(req: {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}): void {
  const rawXrw = req.headers['x-requested-with'];
  const xrw = Array.isArray(rawXrw) ? rawXrw[0] : rawXrw;
  if (xrw !== STUDIO_REQUESTED_WITH_VALUE) {
    throw new CloudAsrConsentError(
      'ORIGIN_FORBIDDEN',
      403,
      'Missing or invalid X-Requested-With header (AvapardazStudio required).',
    );
  }

  const rawSecFetch = req.headers['sec-fetch-site'];
  const secFetch = Array.isArray(rawSecFetch) ? rawSecFetch[0] : rawSecFetch;
  if (secFetch && secFetch !== 'same-origin' && secFetch !== 'none') {
    throw new CloudAsrConsentError(
      'ORIGIN_FORBIDDEN',
      403,
      'Cross-site requests are forbidden on Studio Cloud ASR routes.',
    );
  }

  const rawHost = req.headers['host'];
  const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.trim().toLowerCase();

  const rawOrigin = req.headers['origin'];
  const origin = (Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin)?.trim();
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host.toLowerCase() !== host) {
        throw new CloudAsrConsentError(
          'ORIGIN_FORBIDDEN',
          403,
          'Origin header does not match server host.',
        );
      }
    } catch (err) {
      if (err instanceof CloudAsrConsentError) throw err;
      throw new CloudAsrConsentError('ORIGIN_FORBIDDEN', 403, 'Malformed Origin header.');
    }
  }

  const rawReferer = req.headers['referer'];
  const referer = (Array.isArray(rawReferer) ? rawReferer[0] : rawReferer)?.trim();
  if (!origin && referer && host) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.host.toLowerCase() !== host) {
        throw new CloudAsrConsentError(
          'ORIGIN_FORBIDDEN',
          403,
          'Referer header does not match server host.',
        );
      }
    } catch (err) {
      if (err instanceof CloudAsrConsentError) throw err;
      throw new CloudAsrConsentError('ORIGIN_FORBIDDEN', 403, 'Malformed Referer header.');
    }
  }
}

/**
 * Validates strict consent issuance JSON payload with zero unknown fields permitted.
 */
export function validateConsentIssuePayload(body: unknown): CloudAsrConsentIssueRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CloudAsrConsentError(
      'VALIDATION_ERROR',
      400,
      'Consent issuance payload must be a JSON object.',
    );
  }
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_CONSENT_ISSUE_KEYS.has(key)) {
      throw new CloudAsrConsentError(
        'VALIDATION_ERROR',
        400,
        `Unknown field "${key}" is not permitted in cloud consent request.`,
      );
    }
  }

  if (!isNonEmptyBoundedString(obj.consentId, 128)) {
    throw new CloudAsrConsentError('VALIDATION_ERROR', 400, 'consentId is required.');
  }
  if (!isNonEmptyBoundedString(obj.projectId, 128)) {
    throw new CloudAsrConsentError('VALIDATION_ERROR', 400, 'projectId is required.');
  }
  if (!isNonEmptyBoundedString(obj.assetId, 128)) {
    throw new CloudAsrConsentError('VALIDATION_ERROR', 400, 'assetId is required.');
  }
  const assetSha256 = normalizeSha256(obj.assetSha256);
  if (!assetSha256) {
    throw new CloudAsrConsentError(
      'VALIDATION_ERROR',
      400,
      'assetSha256 must be a valid 64-character lowercase SHA-256 hex digest.',
    );
  }
  if (!isNonEmptyBoundedString(obj.trackId, 128)) {
    throw new CloudAsrConsentError('VALIDATION_ERROR', 400, 'trackId is required.');
  }
  const startSample16k = obj.startSample16k;
  const endSample16k = obj.endSample16k;
  if (
    typeof startSample16k !== 'number' ||
    typeof endSample16k !== 'number' ||
    !Number.isSafeInteger(startSample16k) ||
    !Number.isSafeInteger(endSample16k) ||
    startSample16k < 0 ||
    endSample16k <= startSample16k
  ) {
    throw new CloudAsrConsentError(
      'VALIDATION_ERROR',
      400,
      'startSample16k and endSample16k must be valid integer 16kHz sample bounds with end > start.',
    );
  }
  const sampleSpan = endSample16k - startSample16k;
  if (sampleSpan > MAX_STUDIO_CLOUD_SAMPLE_COUNT_16K) {
    throw new CloudAsrConsentError(
      'CLOUD_SELECTION_EXCEEDS_LIMIT',
      400,
      `Selected audio span (${sampleSpan} samples) exceeds the 120-second hard limit.`,
    );
  }

  const payloadSha256 = normalizeSha256(obj.payloadSha256);
  if (!payloadSha256) {
    throw new CloudAsrConsentError(
      'VALIDATION_ERROR',
      400,
      'payloadSha256 must be a valid 64-character lowercase SHA-256 hex digest.',
    );
  }
  if (obj.providerId !== STUDIO_CLOUD_PROVIDER_ID) {
    throw new CloudAsrConsentError(
      'VALIDATION_ERROR',
      400,
      `Only providerId "${STUDIO_CLOUD_PROVIDER_ID}" is permitted for Studio Cloud ASR.`,
    );
  }
  if (obj.modelId !== STUDIO_CLOUD_MODEL_ID) {
    throw new CloudAsrConsentError(
      'VALIDATION_ERROR',
      400,
      `Only modelId "${STUDIO_CLOUD_MODEL_ID}" is permitted for Studio Cloud ASR.`,
    );
  }
  if (
    typeof obj.maxApprovedCostUsd !== 'number' ||
    !Number.isFinite(obj.maxApprovedCostUsd) ||
    obj.maxApprovedCostUsd <= 0 ||
    obj.maxApprovedCostUsd > 10
  ) {
    throw new CloudAsrConsentError(
      'VALIDATION_ERROR',
      400,
      'maxApprovedCostUsd must be a positive finite number <= 10.',
    );
  }

  let ttlMs = MAX_CONSENT_TTL_MS;
  if (obj.ttlMs !== undefined) {
    if (
      typeof obj.ttlMs !== 'number' ||
      !Number.isFinite(obj.ttlMs) ||
      obj.ttlMs < 1_000 ||
      obj.ttlMs > MAX_CONSENT_TTL_MS
    ) {
      throw new CloudAsrConsentError(
        'VALIDATION_ERROR',
        400,
        `ttlMs must be between 1000 and ${MAX_CONSENT_TTL_MS}.`,
      );
    }
    ttlMs = Math.trunc(obj.ttlMs);
  }

  return Object.freeze({
    consentId: obj.consentId.trim(),
    projectId: obj.projectId.trim(),
    assetId: obj.assetId.trim(),
    assetSha256,
    trackId: obj.trackId.trim(),
    startSample16k,
    endSample16k,
    payloadSha256,
    providerId: STUDIO_CLOUD_PROVIDER_ID,
    modelId: STUDIO_CLOUD_MODEL_ID,
    maxApprovedCostUsd: obj.maxApprovedCostUsd,
    ttlMs,
  });
}

/**
 * Strictly parses and validates a binary 16 kHz Mono PCM16 RIFF/WAVE container:
 * - RIFF / WAVE magic + exact RIFF size
 * - fmt chunk: audioFormat=1 (PCM16), channels=1, sampleRate=16000, blockAlign=2, bitsPerSample=16
 * - data chunk: non-empty, even byte alignment, exact byte count matching container end
 * - actualDurationMs in (0, 120_000]
 * - SHA-256 computed over exact raw WAV bytes
 */
export function validateStrictMono16kWavBuffer(bytes: Uint8Array): ValidatedMono16kWav {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) {
    throw new CloudAsrConsentError(
      'UNSUPPORTED_AUDIO_FORMAT',
      400,
      'Audio payload must be a valid 16kHz Mono PCM16 WAV file (>= 44 bytes).',
    );
  }
  if (bytes.byteLength > MAX_STUDIO_CLOUD_WAV_BYTES) {
    throw new CloudAsrConsentError(
      'CLOUD_SELECTION_EXCEEDS_LIMIT',
      413,
      `Audio payload (${bytes.byteLength} B) exceeds maximum 4 MiB limit.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readFourCc = (offset: number): string =>
    String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );

  if (readFourCc(0) !== 'RIFF' || readFourCc(8) !== 'WAVE') {
    throw new CloudAsrConsentError(
      'UNSUPPORTED_AUDIO_FORMAT',
      400,
      'Invalid WAV header: expected RIFF/WAVE signature.',
    );
  }

  const riffDeclaredSize = view.getUint32(4, true);
  if (riffDeclaredSize !== bytes.byteLength - 8) {
    throw new CloudAsrConsentError(
      'UNSUPPORTED_AUDIO_FORMAT',
      400,
      'Invalid WAV RIFF chunk size: does not match exact payload byte length.',
    );
  }

  let offset = 12;
  let fmtFound = false;
  let dataFound = false;
  let dataPayloadBytes = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readFourCc(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;

    if (payloadEnd > bytes.byteLength) {
      throw new CloudAsrConsentError(
        'UNSUPPORTED_AUDIO_FORMAT',
        400,
        `WAV chunk "${chunkId}" extends beyond payload length.`,
      );
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new CloudAsrConsentError(
          'UNSUPPORTED_AUDIO_FORMAT',
          400,
          'WAV fmt chunk is truncated (< 16 bytes).',
        );
      }
      const audioFormat = view.getUint16(payloadStart + 0, true);
      const numChannels = view.getUint16(payloadStart + 2, true);
      const sampleRate = view.getUint32(payloadStart + 4, true);
      const byteRate = view.getUint32(payloadStart + 8, true);
      const blockAlign = view.getUint16(payloadStart + 12, true);
      const bitsPerSample = view.getUint16(payloadStart + 14, true);

      if (
        audioFormat !== 1 ||
        numChannels !== 1 ||
        sampleRate !== 16_000 ||
        bitsPerSample !== 16 ||
        blockAlign !== 2 ||
        byteRate !== 32_000
      ) {
        throw new CloudAsrConsentError(
          'UNSUPPORTED_AUDIO_FORMAT',
          400,
          'WAV must be strictly PCM16, Mono, 16000 Hz, blockAlign=2, byteRate=32000.',
        );
      }
      fmtFound = true;
    } else if (chunkId === 'data') {
      if (dataFound) {
        throw new CloudAsrConsentError(
          'UNSUPPORTED_AUDIO_FORMAT',
          400,
          'Multiple WAV data chunks are not permitted.',
        );
      }
      if (chunkSize === 0 || chunkSize % 2 !== 0) {
        throw new CloudAsrConsentError(
          'UNSUPPORTED_AUDIO_FORMAT',
          400,
          'WAV data chunk must be non-empty and 16-bit sample aligned.',
        );
      }
      if (payloadEnd !== bytes.byteLength) {
        throw new CloudAsrConsentError(
          'UNSUPPORTED_AUDIO_FORMAT',
          400,
          'WAV data chunk size must match exact remaining payload bytes.',
        );
      }
      dataFound = true;
      dataPayloadBytes = chunkSize;
    }

    offset = payloadEnd + (chunkSize % 2);
  }

  if (!fmtFound || !dataFound) {
    throw new CloudAsrConsentError(
      'UNSUPPORTED_AUDIO_FORMAT',
      400,
      'WAV container is missing required fmt or data chunk.',
    );
  }

  const sampleCount = dataPayloadBytes / 2;
  const actualDurationMs = Math.round((sampleCount / 16_000) * 1000);
  if (sampleCount <= 0 || actualDurationMs <= 0) {
    throw new CloudAsrConsentError(
      'UNSUPPORTED_AUDIO_FORMAT',
      400,
      'WAV audio contains zero playable samples.',
    );
  }
  if (sampleCount > MAX_STUDIO_CLOUD_SAMPLE_COUNT_16K || actualDurationMs > MAX_STUDIO_CLOUD_AUDIO_SECONDS * 1000) {
    throw new CloudAsrConsentError(
      'CLOUD_SELECTION_EXCEEDS_LIMIT',
      400,
      `Actual WAV duration (${(actualDurationMs / 1000).toFixed(2)}s) exceeds 120-second limit.`,
    );
  }

  const sha256Hex = new IncrementalSha256().update(bytes).digestHex();
  return Object.freeze({
    byteLength: bytes.byteLength,
    dataPayloadBytes,
    sampleCount,
    actualDurationMs,
    sha256Hex,
  });
}

/**
 * Server-side bounded in-memory one-time Cloud ASR consent receipt registry.
 *
 * Guarantees:
 * - Bounded capacity (`maxActiveReceipts`, default 1000) with automatic expiry pruning.
 * - Rejects duplicate `consentId`.
 * - Atomic one-time consumption BEFORE upstream provider dispatch.
 * - Cryptographic binding to exact SHA-256 payload digest, sample span, provider, and model.
 */
export class CloudAsrConsentRegistry {
  private readonly receipts = new Map<string, StoredConsentReceiptRecord>();
  private readonly consentIdToReceiptId = new Map<string, string>();
  private readonly maxActiveReceipts: number;
  private readonly maxTtlMs: number;

  constructor(options?: { readonly maxActiveReceipts?: number; readonly maxTtlMs?: number }) {
    this.maxActiveReceipts =
      typeof options?.maxActiveReceipts === 'number' && options.maxActiveReceipts > 0
        ? Math.floor(options.maxActiveReceipts)
        : MAX_ACTIVE_RECEIPTS;
    this.maxTtlMs =
      typeof options?.maxTtlMs === 'number' && options.maxTtlMs > 0
        ? Math.min(MAX_CONSENT_TTL_MS, Math.floor(options.maxTtlMs))
        : MAX_CONSENT_TTL_MS;
  }

  public pruneExpired(nowMs = Date.now()): number {
    let removed = 0;
    for (const [receiptId, record] of this.receipts.entries()) {
      if (nowMs >= record.receipt.expiresAtMs || record.consumed) {
        // Keep consumed receipts only until expiry so replays return CLOUD_CONSENT_ALREADY_USED
        if (nowMs >= record.receipt.expiresAtMs) {
          this.receipts.delete(receiptId);
          this.consentIdToReceiptId.delete(record.receipt.consentId);
          removed++;
        }
      }
    }
    return removed;
  }

  public getActiveCount(nowMs = Date.now()): number {
    this.pruneExpired(nowMs);
    let active = 0;
    for (const record of this.receipts.values()) {
      if (!record.consumed && nowMs < record.receipt.expiresAtMs) {
        active++;
      }
    }
    return active;
  }

  public issueReceipt(
    rawPayload: unknown,
    nowMs = Date.now(),
  ): CloudAsrConsentReceipt {
    this.pruneExpired(nowMs);
    const req = validateConsentIssuePayload(rawPayload);

    if (this.consentIdToReceiptId.has(req.consentId)) {
      throw new CloudAsrConsentError(
        'CONSENT_ID_DUPLICATE',
        409,
        `Consent ID "${req.consentId}" has already been registered.`,
      );
    }

    if (this.getActiveCount(nowMs) >= this.maxActiveReceipts) {
      throw new CloudAsrConsentError(
        'CONSENT_REGISTRY_CAPACITY_EXCEEDED',
        429,
        'Active cloud consent receipt capacity exceeded. Retry after pending receipts expire.',
      );
    }

    const effectiveTtl = Math.min(req.ttlMs ?? this.maxTtlMs, this.maxTtlMs);
    const receiptId = `rcpt_${crypto.randomBytes(18).toString('hex')}`;
    const receipt: CloudAsrConsentReceipt = Object.freeze({
      receiptId,
      consentId: req.consentId,
      projectId: req.projectId,
      assetId: req.assetId,
      assetSha256: req.assetSha256,
      trackId: req.trackId,
      startSample16k: req.startSample16k,
      endSample16k: req.endSample16k,
      payloadSha256: req.payloadSha256,
      providerId: STUDIO_CLOUD_PROVIDER_ID,
      modelId: STUDIO_CLOUD_MODEL_ID,
      maxApprovedCostUsd: req.maxApprovedCostUsd,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + effectiveTtl,
    });

    this.receipts.set(receiptId, {
      receipt,
      consumed: false,
      consumedAtMs: null,
    });
    this.consentIdToReceiptId.set(req.consentId, receiptId);
    return receipt;
  }

  public consumeAndVerifyReceipt(params: {
    readonly receiptId: string | undefined;
    readonly headerSha256: string | undefined;
    readonly bodySha256: string;
    readonly sampleCount: number;
    readonly providerId: string;
    readonly modelId: string;
    readonly nowMs?: number;
  }): CloudAsrConsentReceipt {
    const nowMs = params.nowMs ?? Date.now();
    this.pruneExpired(nowMs);

    const receiptId = params.receiptId?.trim();
    if (!receiptId) {
      throw new CloudAsrConsentError(
        'CLOUD_CONSENT_REQUIRED',
        403,
        'X-Asr-Consent-Receipt header is required for Cloud ASR transcription.',
      );
    }

    const normalizedHeaderSha = normalizeSha256(params.headerSha256);
    const normalizedBodySha = normalizeSha256(params.bodySha256);
    if (!normalizedHeaderSha || !normalizedBodySha) {
      throw new CloudAsrConsentError(
        'CLOUD_CONSENT_RESOURCE_MISMATCH',
        400,
        'Valid 64-hex X-Audio-SHA256 header and audio digest are required.',
      );
    }

    const record = this.receipts.get(receiptId);
    if (!record) {
      throw new CloudAsrConsentError(
        'CLOUD_CONSENT_REQUIRED',
        403,
        'Cloud ASR consent receipt not found or expired.',
      );
    }

    if (record.consumed) {
      throw new CloudAsrConsentError(
        'CLOUD_CONSENT_ALREADY_USED',
        403,
        'Cloud ASR consent receipt has already been consumed and cannot be replayed.',
      );
    }

    if (nowMs >= record.receipt.expiresAtMs) {
      this.receipts.delete(receiptId);
      this.consentIdToReceiptId.delete(record.receipt.consentId);
      throw new CloudAsrConsentError(
        'CLOUD_CONSENT_EXPIRED',
        403,
        'Cloud ASR consent receipt has expired.',
      );
    }

    const expectedSamples = record.receipt.endSample16k - record.receipt.startSample16k;
    if (
      normalizedHeaderSha !== normalizedBodySha ||
      record.receipt.payloadSha256 !== normalizedBodySha ||
      record.receipt.providerId !== params.providerId ||
      record.receipt.modelId !== params.modelId ||
      params.sampleCount !== expectedSamples
    ) {
      throw new CloudAsrConsentError(
        'CLOUD_CONSENT_RESOURCE_MISMATCH',
        403,
        'Submitted audio bytes, SHA-256 digest, sample range, or model do not match the approved consent receipt.',
      );
    }

    // Atomic one-time consumption BEFORE upstream provider dispatch
    record.consumed = true;
    record.consumedAtMs = nowMs;
    return record.receipt;
  }

  public revokeReceipt(receiptId: string): boolean {
    const record = this.receipts.get(receiptId);
    if (!record) return false;
    record.consumed = true;
    record.consumedAtMs = Date.now();
    return true;
  }
}

export interface StudioCloudAsrRouterOptions {
  readonly registry: CloudAsrConsentRegistry;
  readonly isConfigured: () => boolean;
  readonly transcribeWavBytes: (params: {
    readonly wavBytes: Buffer;
    readonly modelId: typeof STUDIO_CLOUD_MODEL_ID;
    readonly receipt: CloudAsrConsentReceipt;
  }) => Promise<string>;
}

/**
 * Mounts governed Studio Cloud ASR routes BEFORE global `express.json()`:
 * - `POST /api/v1/asr/cloud-consents` (16 KiB JSON cap, same-origin, X-Requested-With)
 * - `DELETE /api/v1/asr/cloud-consents/:receiptId` (revokes unused receipt)
 * - `POST /api/v1/asr/transcribe` (binary `audio/wav` only, 4 MiB hard cap, strict WAV + SHA-256 + atomic receipt consumption)
 */
export function createStudioCloudAsrRouter(options: StudioCloudAsrRouterOptions): Router {
  const router = express.Router();

  router.post(
    '/api/v1/asr/cloud-consents',
    express.json({ limit: '16kb', strict: true }),
    (req: Request, res: Response) => {
      try {
        validateStudioSameOriginRequest(req);
        const receipt = options.registry.issueReceipt(req.body);
        res.status(201).json(receipt);
      } catch (err) {
        if (err instanceof CloudAsrConsentError) {
          res.status(err.httpStatus).json({
            error: err.code,
            message: err.message,
          });
          return;
        }
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Invalid cloud consent request.',
        });
      }
    },
  );

  router.delete('/api/v1/asr/cloud-consents/:receiptId', (req: Request, res: Response) => {
    try {
      validateStudioSameOriginRequest(req);
      const revoked = options.registry.revokeReceipt(req.params.receiptId);
      res.status(200).json({ revoked });
    } catch (err) {
      if (err instanceof CloudAsrConsentError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid revoke request.' });
    }
  });

  // Strict Content-Type gate before raw binary parsing so JSON/Base64 uploads are rejected with 415
  router.post(
    '/api/v1/asr/transcribe',
    (req: Request, res: Response, next) => {
      try {
        validateStudioSameOriginRequest(req);
      } catch (err) {
        if (err instanceof CloudAsrConsentError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        res.status(403).json({ error: 'ORIGIN_FORBIDDEN', message: 'Forbidden origin.' });
        return;
      }

      const rawContentType = String(req.headers['content-type'] ?? '').toLowerCase();
      const mimeOnly = rawContentType.split(';')[0].trim();
      if (mimeOnly !== 'audio/wav') {
        res.status(415).json({
          error: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Content-Type must be strictly audio/wav (binary 16kHz Mono PCM16).',
        });
        return;
      }
      next();
    },
    express.raw({ type: 'audio/wav', limit: MAX_STUDIO_CLOUD_WAV_BYTES }),
    async (req: Request, res: Response) => {
      const bodyBuf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!bodyBuf || bodyBuf.byteLength === 0) {
        res.status(400).json({
          error: 'UNSUPPORTED_AUDIO_FORMAT',
          message: 'Binary audio/wav request body is required.',
        });
        return;
      }

      let validatedWav: ValidatedMono16kWav;
      let consumedReceipt: CloudAsrConsentReceipt;
      try {
        validatedWav = validateStrictMono16kWavBuffer(
          new Uint8Array(bodyBuf.buffer, bodyBuf.byteOffset, bodyBuf.byteLength),
        );

        const rawReceipt = req.headers['x-asr-consent-receipt'];
        const rawSha = req.headers['x-audio-sha256'];
        consumedReceipt = options.registry.consumeAndVerifyReceipt({
          receiptId: Array.isArray(rawReceipt) ? rawReceipt[0] : rawReceipt,
          headerSha256: Array.isArray(rawSha) ? rawSha[0] : rawSha,
          bodySha256: validatedWav.sha256Hex,
          sampleCount: validatedWav.sampleCount,
          providerId: STUDIO_CLOUD_PROVIDER_ID,
          modelId: STUDIO_CLOUD_MODEL_ID,
        });
      } catch (err) {
        if (err instanceof CloudAsrConsentError) {
          res.status(err.httpStatus).json({
            error: err.code,
            message: err.message,
          });
          return;
        }
        res.status(400).json({
          error: 'UNSUPPORTED_AUDIO_FORMAT',
          message: 'Failed to validate audio/wav payload or consent receipt.',
        });
        return;
      }

      if (!options.isConfigured()) {
        res.status(503).json({
          error: 'ASR_API_KEY_UNAVAILABLE',
          messageFa:
            'کلید سرویس‌دهنده ابری روی سرور تنظیم نشده است؛ برای حفظ شفافیت، بازگشت خودکار پنهان به پردازش محلی انجام نمی‌شود.',
        });
        return;
      }

      try {
        const transcriptText = await options.transcribeWavBytes({
          wavBytes: bodyBuf,
          modelId: STUDIO_CLOUD_MODEL_ID,
          receipt: consumedReceipt,
        });

        res.json({
          transcriptText,
          providerId: STUDIO_CLOUD_PROVIDER_ID,
          model: STUDIO_CLOUD_MODEL_ID,
          consentReceiptId: consumedReceipt.receiptId,
          audioSha256: validatedWav.sha256Hex,
          actualDurationMs: validatedWav.actualDurationMs,
        });
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : 'ASR_UPSTREAM_ERROR';
        res.status(502).json({
          error: 'ASR_TRANSCRIPTION_FAILED',
          message: sanitizePublicErrorOutput(rawMsg),
        });
      }
    },
  );

  // Route-scoped error handler for express.raw PayloadTooLargeError (413) or JSON syntax errors (400)
  router.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (!err) {
      next();
      return;
    }
    const e = err as { type?: string; status?: number; statusCode?: number };
    if (e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413) {
      res.status(413).json({
        error: 'CLOUD_SELECTION_EXCEEDS_LIMIT',
        message: 'Audio payload exceeds the 4 MiB server limit.',
      });
      return;
    }
    if (e.type === 'entity.parse.failed' || e.status === 400) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Malformed request body.',
      });
      return;
    }
    next(err);
  });

  return router;
}
