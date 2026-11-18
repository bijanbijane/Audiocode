/**
 * PHASE 14B.2 — REAL-TIME STREAMING SECURITY GUARD
 * Protects WebSocket/Streaming ASR ingestion (`ASR1` frames), single-use ephemeral tokens,
 * replay/hijack checks, per-tenant & per-key concurrency limits, and explicit overload backpressure.
 * Reuses Phase 5 `decodeAndValidateAsrStreamProtocolV1BinaryFrame` without duplicating codec logic.
 */

import crypto from 'node:crypto';
import { decodeAndValidateAsrStreamProtocolV1BinaryFrame } from '../ai-engine/asr/RealTimeStreamingAsrEngine';
import type {
  StreamingFrameSecurityVerdict,
  StreamingSecurityAdmissionResult,
  StreamingSessionSecurityToken,
} from './SpeechSecurityContracts';

interface ActiveStreamingSessionState {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly apiKeyId: string;
  readonly maxAudioSeconds: number;
  readonly maxMessagesPerSecond: number;
  lastSequence: number;
  seenSequences: Set<number>;
  cumulativeAudioSeconds: number;
  queuedFrames: number;
  maxQueueDepth: number;
  messagesInCurrentWindow: number;
  windowStartMs: number;
}

export class StreamingSecurityGuard {
  private readonly hmacSecret: string;
  private readonly consumedNonces = new Set<string>();
  private readonly activeSessions = new Map<string, ActiveStreamingSessionState>();
  private readonly maxConcurrentPerTenant: number;
  private readonly maxConcurrentPerKey: number;

  constructor(options?: {
    hmacSecret?: string;
    maxConcurrentPerTenant?: number;
    maxConcurrentPerKey?: number;
  }) {
    this.hmacSecret = options?.hmacSecret ?? 'avapardaz-phase14-ephemeral-stream-key';
    this.maxConcurrentPerTenant = options?.maxConcurrentPerTenant ?? 8;
    this.maxConcurrentPerKey = options?.maxConcurrentPerKey ?? 4;
  }

  public issueSingleUseSessionToken(params: {
    tenantId: string;
    projectId: string;
    principalId: string;
    modelScope?: string;
    ttlSeconds?: number;
    maxAudioSeconds?: number;
    maxMessagesPerSecond?: number;
  }): StreamingSessionSecurityToken {
    const now = Date.now();
    const ttlMs = Math.max(5, Math.min(300, params.ttlSeconds ?? 60)) * 1000;
    const tokenBase = {
      tokenId: `stok_${crypto.randomUUID().slice(0, 12)}`,
      tenantId: params.tenantId,
      projectId: params.projectId,
      principalId: params.principalId,
      modelScope: params.modelScope ?? 'avapardaz_streaming_v1',
      issuedAtMs: now,
      expiresAtMs: now + ttlMs,
      maxAudioSeconds: params.maxAudioSeconds ?? 600,
      maxMessagesPerSecond: params.maxMessagesPerSecond ?? 35,
      singleUseNonce: crypto.randomBytes(12).toString('hex'),
    };
    const hmacSignature = this.signToken(tokenBase);
    return { ...tokenBase, hmacSignature };
  }

  private signToken(t: Omit<StreamingSessionSecurityToken, 'hmacSignature'>): string {
    const canonical = `${t.tokenId}|${t.tenantId}|${t.projectId}|${t.principalId}|${t.modelScope}|${t.issuedAtMs}|${t.expiresAtMs}|${t.maxAudioSeconds}|${t.singleUseNonce}`;
    return crypto.createHmac('sha256', this.hmacSecret).update(canonical).digest('hex');
  }

  public admitStreamingSession(params: {
    token: StreamingSessionSecurityToken;
    connectingPrincipalId: string;
    apiKeyId: string;
    nowMs?: number;
    maxQueueDepth?: number;
  }): StreamingSecurityAdmissionResult {
    const now = params.nowMs ?? Date.now();
    const expectedSig = this.signToken(params.token);
    if (expectedSig !== params.token.hmacSignature) {
      return {
        admitted: false,
        sessionId: null,
        errorCode: 'TOKEN_INVALID_SIGNATURE',
        detail: 'Streaming token HMAC signature mismatch.',
      };
    }

    if (params.token.principalId !== params.connectingPrincipalId) {
      return {
        admitted: false,
        sessionId: null,
        errorCode: 'SESSION_HIJACK_PRINCIPAL_MISMATCH',
        detail: 'Principal mismatch on streaming session handshake.',
      };
    }

    if (now > params.token.expiresAtMs) {
      return {
        admitted: false,
        sessionId: null,
        errorCode: 'TOKEN_EXPIRED',
        detail: 'Short-lived streaming token expired.',
      };
    }

    if (this.consumedNonces.has(params.token.singleUseNonce)) {
      return {
        admitted: false,
        sessionId: null,
        errorCode: 'TOKEN_REPLAY_DETECTED',
        detail: 'Single-use streaming token nonce was already consumed (replay blocked).',
      };
    }

    const tenantCount = [...this.activeSessions.values()].filter(
      (s) => s.tenantId === params.token.tenantId
    ).length;
    if (tenantCount >= this.maxConcurrentPerTenant) {
      return {
        admitted: false,
        sessionId: null,
        errorCode: 'TENANT_CONCURRENCY_LIMIT_EXCEEDED',
        detail: `Tenant reached concurrent stream limit (${this.maxConcurrentPerTenant}).`,
      };
    }

    const keyCount = [...this.activeSessions.values()].filter(
      (s) => s.apiKeyId === params.apiKeyId
    ).length;
    if (keyCount >= this.maxConcurrentPerKey) {
      return {
        admitted: false,
        sessionId: null,
        errorCode: 'KEY_CONCURRENCY_LIMIT_EXCEEDED',
        detail: `API key reached concurrent stream limit (${this.maxConcurrentPerKey}).`,
      };
    }

    this.consumedNonces.add(params.token.singleUseNonce);
    const sessionId = `str_${crypto.randomUUID().slice(0, 12)}`;
    this.activeSessions.set(sessionId, {
      sessionId,
      tenantId: params.token.tenantId,
      projectId: params.token.projectId,
      principalId: params.token.principalId,
      apiKeyId: params.apiKeyId,
      maxAudioSeconds: params.token.maxAudioSeconds,
      maxMessagesPerSecond: params.token.maxMessagesPerSecond,
      lastSequence: 0,
      seenSequences: new Set<number>(),
      cumulativeAudioSeconds: 0,
      queuedFrames: 0,
      maxQueueDepth: params.maxQueueDepth ?? 20,
      messagesInCurrentWindow: 0,
      windowStartMs: now,
    });

    return {
      admitted: true,
      sessionId,
      errorCode: null,
      detail: 'Streaming session admitted with single-use HMAC token.',
    };
  }

  public validateBinaryAudioFrame(params: {
    sessionId: string;
    principalId: string;
    frameBytes: Uint8Array;
    nowMs?: number;
  }): StreamingFrameSecurityVerdict {
    const sess = this.activeSessions.get(params.sessionId);
    if (!sess || sess.principalId !== params.principalId) {
      return {
        accepted: false,
        backpressureState: 'OVERLOAD_REJECTED',
        sequenceNumber: null,
        rejectCode: 'MALFORMED_ASR1_HEADER',
        detail: 'Unknown streaming session or principal ownership mismatch.',
      };
    }

    const now = params.nowMs ?? Date.now();
    if (now - sess.windowStartMs >= 1000) {
      sess.windowStartMs = now;
      sess.messagesInCurrentWindow = 0;
    }
    sess.messagesInCurrentWindow += 1;
    if (sess.messagesInCurrentWindow > sess.maxMessagesPerSecond) {
      return {
        accepted: false,
        backpressureState: 'OVERLOAD_REJECTED',
        sequenceNumber: null,
        rejectCode: 'MESSAGE_RATE_LIMIT_EXCEEDED',
        detail: `Message rate ${sess.messagesInCurrentWindow}/s exceeds cap (${sess.maxMessagesPerSecond}/s).`,
      };
    }

    if (sess.queuedFrames >= sess.maxQueueDepth) {
      return {
        accepted: false,
        backpressureState: 'OVERLOAD_REJECTED',
        sequenceNumber: null,
        rejectCode: 'QUEUE_BACKPRESSURE_OVERLOAD',
        detail: `Bounded queue full (${sess.queuedFrames}/${sess.maxQueueDepth}); frame explicitly rejected instead of silent drop.`,
      };
    }

    const decoded = decodeAndValidateAsrStreamProtocolV1BinaryFrame(params.frameBytes);
    if (!decoded.valid || !decoded.frame) {
      return {
        accepted: false,
        backpressureState: 'NORMAL',
        sequenceNumber: null,
        rejectCode: decoded.errorCode === 'STREAM_PROTOCOL_UNSUPPORTED' ? 'INVALID_FRAME_VERSION' : 'MALFORMED_ASR1_HEADER',
        detail: decoded.errorMessage ?? 'Invalid ASR1 binary streaming packet.',
      };
    }

    const seq = decoded.frame.sequenceNumber;
    if (sess.seenSequences.has(seq)) {
      return {
        accepted: false,
        backpressureState: 'NORMAL',
        sequenceNumber: seq,
        rejectCode: 'DUPLICATE_SEQUENCE',
        detail: `Duplicate streaming sequence #${seq} rejected.`,
      };
    }
    if (seq <= sess.lastSequence && sess.lastSequence > 0) {
      return {
        accepted: false,
        backpressureState: 'NORMAL',
        sequenceNumber: seq,
        rejectCode: 'OUT_OF_ORDER_SEQUENCE',
        detail: `Out-of-order frame #${seq} (last=${sess.lastSequence}) rejected.`,
      };
    }
    if (seq > sess.lastSequence + 1) {
      return {
        accepted: false,
        backpressureState: 'NORMAL',
        sequenceNumber: seq,
        rejectCode: 'GAP_DISCONTINUITY',
        detail: `Missing frame gap between #${sess.lastSequence} and #${seq}.`,
      };
    }

    const pcmSec = decoded.frame.pcm16Payload.byteLength / 2 / 16000;
    if (sess.cumulativeAudioSeconds + pcmSec > sess.maxAudioSeconds) {
      return {
        accepted: false,
        backpressureState: 'OVERLOAD_REJECTED',
        sequenceNumber: seq,
        rejectCode: 'AUDIO_QUOTA_EXCEEDED',
        detail: `Session audio limit (${sess.maxAudioSeconds}s) exceeded.`,
      };
    }

    sess.seenSequences.add(seq);
    sess.lastSequence = seq;
    sess.cumulativeAudioSeconds += pcmSec;
    sess.queuedFrames += 1;

    const backpressureState =
      sess.queuedFrames >= Math.floor(sess.maxQueueDepth * 0.75) ? 'WARNING' : 'NORMAL';

    return {
      accepted: true,
      backpressureState,
      sequenceNumber: seq,
      rejectCode: null,
      detail: 'ASR1 frame verified cleanly.',
    };
  }

  public drainQueuedFrames(sessionId: string, count = 1): void {
    const sess = this.activeSessions.get(sessionId);
    if (!sess) return;
    sess.queuedFrames = Math.max(0, sess.queuedFrames - count);
  }

  public closeSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  public getActiveSessionCount(tenantId?: string): number {
    if (!tenantId) return this.activeSessions.size;
    return [...this.activeSessions.values()].filter((s) => s.tenantId === tenantId).length;
  }
}
