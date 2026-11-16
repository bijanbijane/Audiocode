import { EnterpriseApiKeyAndQuotaManager } from '../auth/EnterpriseApiKeyAndQuotaManager';
import {
  LocalAgreement2StreamStabilizer,
  StreamingAsrHypothesisUpdate,
} from '../../../src/ai-engine/asr/StreamingLivePersianAsrEngine';
import { PersianSyntacticAcousticEndpointDetector } from '../../../src/ai-engine/asr/PersianSyntacticAcousticEndpointDetector';
import { PreAsrInputSanityValidator } from '../../../src/ai-engine/asr/PreAsrInputSanityValidator';
import { RawWordPrediction } from '../../../src/ai-engine/PersianChunkedAsrWorker';

export interface LiveWsSocketLike {
  send(jsonText: string): void;
  close(code: number, reason: string): void;
}

export type LiveWsOutgoingEvent =
  | { type: 'SESSION_READY'; sessionId: string; remainingQuotaSeconds: number }
  | { type: 'HYPOTHESIS_UPDATE'; update: StreamingAsrHypothesisUpdate }
  | { type: 'UTTERANCE_ENDPOINT'; trailingSilenceMs: number; reasonTag: string }
  | { type: 'BACKPRESSURE_WARNING'; droppedOrPaused: boolean }
  | { type: 'QUOTA_EXHAUSTED'; messageFa: string }
  | { type: 'ERROR'; code: string; messageFa: string };

export class LiveWsAsrSessionController {
  private readonly stabilizer: LocalAgreement2StreamStabilizer;
  private readonly endpointDetector = new PersianSyntacticAcousticEndpointDetector(650, 1450);

  private pendingOddByte: number | null = null;
  private bufferedPcm16kChunks: Float32Array[] = [];
  private isProcessingQueue = false;
  private isClosed = false;

  private committedWordsHistory: string[] = [];
  private accumulatedUnbilledSamples = 0;
  private silenceStreakSamples = 0;

  private readonly maxPendingChunksQueue = 16; // Backpressure cap: max 16 queued chunks
  private readonly quotaChargeIntervalSamples = 16000 * 5; // Deduct quota in 5-second intervals

  constructor(
    private readonly sessionId: string,
    private readonly enterpriseKeyId: string,
    private readonly quotaManager: EnterpriseApiKeyAndQuotaManager,
    private readonly socket: LiveWsSocketLike,
    transcribeWindowFn: (pcm16k: Float32Array) => Promise<RawWordPrediction[]>
  ) {
    this.stabilizer = new LocalAgreement2StreamStabilizer(transcribeWindowFn, 0.35, 20.0);
  }

  /**
   * 1. Receives Int16 Little-Endian 16kHz Mono binary WebSocket frames while preserving 2-byte sample alignment across split packets.
   */
  public async handleIncomingInt16BinaryFrame(rawBytes: Uint8Array): Promise<void> {
    if (this.isClosed || rawBytes.byteLength === 0) return;

    if (this.bufferedPcm16kChunks.length >= this.maxPendingChunksQueue) {
      this.emit({ type: 'BACKPRESSURE_WARNING', droppedOrPaused: true });
      return;
    }

    let offset = 0;
    const samplesList: number[] = [];

    if (this.pendingOddByte !== null) {
      const lo = this.pendingOddByte;
      const hi = rawBytes[0];
      this.pendingOddByte = null;
      offset = 1;
      let int16 = lo | (hi << 8);
      if (int16 & 0x8000) int16 -= 0x10000;
      samplesList.push(int16 / 32768.0);
    }

    while (offset + 1 < rawBytes.byteLength) {
      const lo = rawBytes[offset];
      const hi = rawBytes[offset + 1];
      let int16 = lo | (hi << 8);
      if (int16 & 0x8000) int16 -= 0x10000;
      samplesList.push(int16 / 32768.0);
      offset += 2;
    }

    if (offset < rawBytes.byteLength) {
      this.pendingOddByte = rawBytes[offset];
    }

    if (samplesList.length === 0) return;

    const pcmChunk = Float32Array.from(samplesList);
    PreAsrInputSanityValidator.validateAndSanitizeForAsr(pcmChunk);

    this.bufferedPcm16kChunks.push(pcmChunk);
    await this.drainProcessingQueue();
  }

  private async drainProcessingQueue(): Promise<void> {
    if (this.isProcessingQueue || this.isClosed) return;
    this.isProcessingQueue = true;

    try {
      while (this.bufferedPcm16kChunks.length > 0 && !this.isClosed) {
        const chunk = this.bufferedPcm16kChunks.shift()!;

        // 1. Check and deduct enterprise audio quota every 5 seconds
        this.accumulatedUnbilledSamples += chunk.length;
        if (this.accumulatedUnbilledSamples >= this.quotaChargeIntervalSamples) {
          const billedSec = Math.floor(this.accumulatedUnbilledSamples / 16000);
          this.accumulatedUnbilledSamples %= 16000;

          const quotaRes = await this.quotaManager.consumeAudioQuotaAtomically(
            this.enterpriseKeyId,
            billedSec
          );
          if (!quotaRes.approved) {
            this.emit({
              type: 'QUOTA_EXHAUSTED',
              messageFa: 'سهمیه صوتی ماهانه کلید سازمانی به پایان رسیده است.',
            });
            this.closeSession(1008, 'QUOTA_EXHAUSTED');
            return;
          }
        }

        // 2. Track trailing silence for Persian syntactic endpointing
        if (this.isChunkSilence(chunk)) {
          this.silenceStreakSamples += chunk.length;
        } else {
          this.silenceStreakSamples = 0;
        }

        // 3. Run LocalAgreement-2 + Draft Horizon stabilizer
        const update = await this.stabilizer.pushAudioChunkAndTranscribe(chunk);
        for (const w of update.newlyCommittedWords) {
          this.committedWordsHistory.push(w.word);
        }

        if (
          update.newlyCommittedWords.length > 0 ||
          update.tentativeTailWords.length > 0
        ) {
          this.emit({ type: 'HYPOTHESIS_UPDATE', update });
        }

        // 4. Evaluate syntactic-acoustic utterance endpoint
        const silenceMs = (this.silenceStreakSamples / 16000) * 1000;
        if (silenceMs >= 300 && this.committedWordsHistory.length > 0) {
          const ep = this.endpointDetector.evaluateEndOfUtterance({
            trailingSilenceMs: silenceMs,
            recentRecognizedWords: this.committedWordsHistory.slice(-5),
          });
          if (ep.decision === 'UTTERANCE_ENDPOINT_REACHED') {
            this.emit({
              type: 'UTTERANCE_ENDPOINT',
              trailingSilenceMs: Math.round(silenceMs),
              reasonTag: ep.reasonTag,
            });
            this.silenceStreakSamples = 0;
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  public async finalizeAndClose(): Promise<void> {
    if (this.isClosed) return;
    if (this.accumulatedUnbilledSamples > 0) {
      const remSec = Math.max(1, Math.ceil(this.accumulatedUnbilledSamples / 16000));
      this.accumulatedUnbilledSamples = 0;
      await this.quotaManager
        .consumeAudioQuotaAtomically(this.enterpriseKeyId, remSec)
        .catch(() => {});
    }
    this.closeSession(1000, 'CLIENT_CLOSED');
  }

  private closeSession(code: number, reason: string): void {
    this.isClosed = true;
    this.bufferedPcm16kChunks = [];
    this.socket.close(code, reason);
  }

  private isChunkSilence(chunk: Float32Array): boolean {
    let sumSq = 0;
    for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
    const rmsDb = 10 * Math.log10(sumSq / Math.max(1, chunk.length) + 1e-12);
    return rmsDb < -44.0;
  }

  private emit(evt: LiveWsOutgoingEvent): void {
    if (!this.isClosed) {
      this.socket.send(JSON.stringify(evt));
    }
  }
}

export class WebSocketLiveAsrGateway {
  constructor(
    private readonly quotaManager: EnterpriseApiKeyAndQuotaManager,
    /** Architecture Rule 3: Server-side live ASR is disabled in V1 by default and gated behind Enterprise flag */
    private readonly enableServerSideAsrInference: boolean
  ) {}

  public async openAuthenticatedSession(params: {
    enterpriseApiKey: string;
    socket: LiveWsSocketLike;
    transcribeWindowFn: (pcm16k: Float32Array) => Promise<RawWordPrediction[]>;
  }): Promise<LiveWsAsrSessionController | null> {
    if (!this.enableServerSideAsrInference) {
      params.socket.send(
        JSON.stringify({
          type: 'ERROR',
          code: 'CLOUD_ASR_DISABLED_IN_V1',
          messageFa: 'طبق قانون ۳ معماری، پردازش زنده ASR سمت سرور در نسخه اول غیرفعال است.',
        })
      );
      params.socket.close(1008, 'CLOUD_ASR_DISABLED_IN_V1');
      return null;
    }

    try {
      const ctx = await this.quotaManager.authenticateAndAuthorizeScope(
        params.enterpriseApiKey,
        'CLOUD_ASR_ENTERPRISE'
      );
      if (ctx.remainingAudioSeconds <= 0) {
        throw new Error('QUOTA_EXHAUSTED');
      }

      const sessionId = `ws_asr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      params.socket.send(
        JSON.stringify({
          type: 'SESSION_READY',
          sessionId,
          remainingQuotaSeconds: ctx.remainingAudioSeconds,
        })
      );

      return new LiveWsAsrSessionController(
        sessionId,
        ctx.keyId,
        this.quotaManager,
        params.socket,
        params.transcribeWindowFn
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : 'UNAUTHORIZED';
      params.socket.send(
        JSON.stringify({
          type: 'ERROR',
          code,
          messageFa: 'احراز هویت یا سهمیه کلید سازمانی معتبر نیست.',
        })
      );
      params.socket.close(1008, code);
      return null;
    }
  }
}
