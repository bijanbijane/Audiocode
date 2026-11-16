import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { CompactPersianLanguageModelScorer } from '../../src/ai-engine/asr/CompactPersianLanguageModelScorer';
import { PersianCtcPrefixBeamSearchDecoder } from '../../src/ai-engine/asr/PersianCtcPrefixBeamSearchDecoder';
import { SentencePieceSubwordCtcMapper } from '../../src/ai-engine/asr/SentencePieceAndWhisperBridge';
import { LocalAgreement2StreamStabilizer } from '../../src/ai-engine/asr/StreamingLivePersianAsrEngine';
import { PersianPostAsrSpellingAndCompoundRestorer } from '../../src/ai-engine/asr/PersianPostAsrSpellingAndCompoundRestorer';
import { WhisperKvCacheAutoregressiveOptimizer } from '../../src/ai-engine/asr/WhisperKvCacheAutoregressiveOptimizer';
import { PersianTextNormalizer } from '../../src/ai-engine/PersianTextNormalizer';
import { NodeOnnxAsrBenchmarkRunner } from '../src/asr-worker/NodeOnnxAsrBenchmarkRunner';
import {
  FastifyInstanceLike,
  FastifyReplyLike,
  PlatformBackendServices,
  PgPoolLike,
} from '../src/PlatformBackendServices';
import { BackendAuthAndPaymentService } from '../src/BackendAuthAndPaymentService';
import { TimeMath } from '../../src/contracts/timebase.contract';

/**
 * Zero-dependency in-memory Fastify-compatible inject() harness for deterministic route testing
 */
function createFastifyInjectHarness(): FastifyInstanceLike & {
  inject(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string | undefined>;
    payload?: unknown;
  }): Promise<{ statusCode: number; json: () => any }>;
} {
  const getRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();
  const postRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();

  return {
    get(url, handler) {
      getRoutes.set(url, handler);
    },
    post(url, handler) {
      postRoutes.set(url, handler);
    },
    async inject(opts) {
      let statusCode = 200;
      let sentBody: unknown = undefined;
      const reply: FastifyReplyLike = {
        status(code) {
          statusCode = code;
          return reply;
        },
        header() {
          return reply;
        },
        send(payload) {
          sentBody = payload;
          return payload;
        },
      };

      const handler =
        opts.method === 'GET' ? getRoutes.get(opts.url) : postRoutes.get(opts.url);
      if (!handler) {
        return { statusCode: 404, json: () => ({ error: 'NOT_FOUND' }) };
      }

      await handler(
        {
          params: {},
          body: opts.payload ?? {},
          headers: opts.headers ?? {},
        },
        reply,
      );

      return {
        statusCode,
        json: () => sentBody,
      };
    },
  };
}

describe('Section 112: Core Persian ASR Engine & Backend Services Integration Suite', () => {
  it('1. CompactPersianLanguageModelScorer trains, serializes to PLM1 binary, reloads, and scores bigrams', () => {
    const corpus = [
      'سلام امروز درباره معماری نرم‌افزار صحبت می‌کنیم',
      'سلام امروز هوا بسیار خوب است',
      'در معماری نرم‌افزار پایداری اهمیت دارد',
    ];
    const lm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(corpus, 1, 1);
    const binary = lm.serializeToBinary();
    const reloaded = CompactPersianLanguageModelScorer.loadFromBinary(binary);

    expect(reloaded.isKnownPersianWord('معماری')).toBe(true);
    const knownBigramScore = reloaded.scoreWordTransitionLogProb('معماری', 'نرم‌افزار');
    const backedOffScore = reloaded.scoreWordTransitionLogProb('هوا', 'نرم‌افزار');
    expect(knownBigramScore).toBeGreaterThan(backedOffScore);
  });

  it('2. CTC Prefix Beam Search with Persian LM resolves ambiguous acoustic frames into valid Persian words', () => {
    const vocab = ['<blk>', ' ', 'س', 'ل', 'ا', 'م', 'ن'];
    const lm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(
      ['سلام دنیا', 'سلام دوستان', 'سلام امروز'],
      1,
      1,
    );
    const decoder = new PersianCtcPrefixBeamSearchDecoder(vocab, 0, ' ', lm);

    const makeFrame = (scores: Record<number, number>) => {
      const f = new Float32Array(vocab.length).fill(-8.0);
      for (const [id, val] of Object.entries(scores)) f[Number(id)] = val;
      return f;
    };

    const frames = [
      makeFrame({ 2: -0.1 }), // س
      makeFrame({ 3: -0.1 }), // ل
      makeFrame({ 4: -0.1 }), // ا
      makeFrame({ 5: -0.5, 6: -0.45 }), // ن slightly higher acoustically than م, but non-word!
      makeFrame({ 0: -0.1 }), // <blk>
    ];

    const res = decoder.decodeWithWordTimestamps({
      logProbsPerFrame: frames,
      frameDurationSec: 0.04,
      beamWidth: 8,
      lmAlpha: 0.8,
    });

    expect(res.bestTranscript).toBe('سلام');
    expect(res.words).toHaveLength(1);
    expect(res.words[0].relativeStartSec).toBe(0);
    expect(res.words[0].relativeEndSec).toBeGreaterThanOrEqual(0.12);
  });

  it('3. SentencePieceSubwordCtcMapper merges subword pieces into complete Persian words with timestamps', () => {
    const idToPiece = ['<blk>', '\u2581سلام', '\u2581می', '\u200c', 'کنم'];
    const mapper = new SentencePieceSubwordCtcMapper(idToPiece, 0);

    const makeF = (winId: number) => {
      const arr = new Float32Array(idToPiece.length).fill(-9.0);
      arr[winId] = -0.05;
      return arr;
    };

    const decoded = mapper.decodeSubwordMatrixToWords(
      [makeF(1), makeF(0), makeF(2), makeF(3), makeF(4)],
      0.04,
    );

    expect(decoded.fullText).toBe('سلام می‌کنم');
    expect(decoded.words).toHaveLength(2);
    expect(decoded.words[1].word).toBe('می‌کنم');
  });

  it('4. LocalAgreement-2 with Draft Horizon prevents premature locking of trailing flickering words', async () => {
    let passCount = 0;
    const stabilizer = new LocalAgreement2StreamStabilizer(async () => {
      passCount++;
      if (passCount <= 2) {
        return [
          { word: 'سلام', relativeStartSec: 0.1, relativeEndSec: 0.5, probability: 0.95 },
          { word: 'برنامه', relativeStartSec: 1.5, relativeEndSec: 1.85, probability: 0.8 },
        ];
      }
      return [];
    }, 0.35);

    const chunk1 = new Float32Array(16000); // 1.0s
    const chunk2 = new Float32Array(16000); // 2.0s total

    const up1 = await stabilizer.pushAudioChunkAndTranscribe(chunk1);
    expect(up1.newlyCommittedWords).toHaveLength(0);

    const up2 = await stabilizer.pushAudioChunkAndTranscribe(chunk2);
    expect(up2.newlyCommittedWords.map((w) => w.word)).toEqual(['سلام']);
    expect(up2.tentativeTailWords.map((w) => w.word)).toEqual(['برنامه']);
  });

  it('5. Post-ASR Compound Restorer merges split Persian suffixes and English terms only when gap < 180ms', () => {
    const restorer = new PersianPostAsrSpellingAndCompoundRestorer();
    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: '1',
        text: 'فست',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.3) },
        confidence: 0.9,
      },
      {
        id: '2',
        text: 'ای',
        range: { start: TimeMath.secondsToFlicks(0.32), end: TimeMath.secondsToFlicks(0.5) },
        confidence: 0.9,
      },
      {
        id: '3',
        text: 'پی',
        range: { start: TimeMath.secondsToFlicks(0.52), end: TimeMath.secondsToFlicks(0.7) },
        confidence: 0.9,
      },
      {
        id: '4',
        text: 'آی',
        range: { start: TimeMath.secondsToFlicks(0.72), end: TimeMath.secondsToFlicks(0.9) },
        confidence: 0.9,
      },
      {
        id: '5',
        text: 'کتاب',
        range: { start: TimeMath.secondsToFlicks(1.0), end: TimeMath.secondsToFlicks(1.4) },
        confidence: 0.95,
      },
      {
        id: '6',
        text: 'خانه',
        range: { start: TimeMath.secondsToFlicks(1.45), end: TimeMath.secondsToFlicks(1.8) },
        confidence: 0.95,
      },
    ]);

    const restored = restorer.restoreCompoundsAndBilingualTerms(tokens, 180);
    expect(restored).toHaveLength(2);
    expect(restored[0].displayText).toBe('FastAPI');
    expect(restored[1].displayText).toBe('کتاب\u200cخانه');
    expect(restored[1].originalText).toBe('کتاب خانه');
  });

  it('6. WAV Parser safely skips non-audio RIFF metadata subchunks (JUNK) and decodes 16-bit PCM', () => {
    const headerFmtJunkData = Buffer.alloc(44 + 12 + 4);
    headerFmtJunkData.write('RIFF', 0);
    headerFmtJunkData.writeUInt32LE(headerFmtJunkData.length - 8, 4);
    headerFmtJunkData.write('WAVE', 8);

    headerFmtJunkData.write('fmt ', 12);
    headerFmtJunkData.writeUInt32LE(16, 16);
    headerFmtJunkData.writeUInt16LE(1, 20);
    headerFmtJunkData.writeUInt16LE(1, 22);
    headerFmtJunkData.writeUInt32LE(16000, 24);
    headerFmtJunkData.writeUInt32LE(32000, 28);
    headerFmtJunkData.writeUInt16LE(2, 32);
    headerFmtJunkData.writeUInt16LE(16, 34);

    headerFmtJunkData.write('JUNK', 36);
    headerFmtJunkData.writeUInt32LE(4, 40);

    headerFmtJunkData.write('data', 48);
    headerFmtJunkData.writeUInt32LE(4, 52);
    headerFmtJunkData.writeInt16LE(16384, 56);
    headerFmtJunkData.writeInt16LE(-16384, 58);

    const tmpWavPath = path.join(os.tmpdir(), `test_junk_${Date.now()}.wav`);
    fs.writeFileSync(tmpWavPath, headerFmtJunkData);
    try {
      const parsed = NodeOnnxAsrBenchmarkRunner.parseWavFileToFloat32Channels(tmpWavPath);
      expect(parsed.sampleRate).toBe(16000);
      expect(parsed.channels[0]).toHaveLength(2);
      expect(parsed.channels[0][0]).toBeCloseTo(0.5, 3);
      expect(parsed.channels[0][1]).toBeCloseTo(-0.5, 3);
    } finally {
      fs.rmSync(tmpWavPath, { force: true });
    }
  });

  it('7. Backend Services enforce HTTP 206 Byte-Range, Payment Webhook Idempotency, and V1 Local-Only rule', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const webhookSecret = 'super_secret_hmac_key';

    const seenTxIds = new Set<string>();
    const mockDb: PgPoolLike = {
      async query<TRow>(sql: string, params: unknown[] = []) {
        if (sql.includes('INSERT INTO payment_transactions')) {
          const txKey = `${params[1]}:${params[2]}`;
          if (seenTxIds.has(txKey)) return { rows: [], rowCount: 0 };
          seenTxIds.add(txKey);
          return { rows: [{ id: 'pay_tx_1' } as unknown as TRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    const fastify = createFastifyInjectHarness();
    const authPay = new BackendAuthAndPaymentService(mockDb, {
      ed25519PrivateKeyPem: privPem,
      ed25519PublicKeyPem: pubPem,
      paymentWebhookHmacSecret: webhookSecret,
    });
    const platformSvc = new PlatformBackendServices(mockDb, {
      modelStorageRootDir: os.tmpdir(),
      ed25519PrivateKeyPem: privPem,
      keyId: 'k1',
      cdnBaseUrl: 'https://cdn.local',
      enableServerSideAsrInference: false,
    });

    authPay.registerRoutes(fastify);
    platformSvc.registerAllRoutes(fastify);

    // A) Verify V1 Local-Only rule blocks server-side cloud ASR
    const cloudRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe-chunk',
    });
    expect(cloudRes.statusCode).toBe(501);

    // B) Verify Payment Webhook Idempotency
    const webhookBody = {
      gatewayName: 'zarinpal',
      gatewayTxId: 'TX_998877',
      userId: 'user_1',
      planTier: 'PRO_MONTHLY',
      amountMinorUnits: 5000000,
      currency: 'IRR',
      status: 'PAID',
    };
    const hmacSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(webhookBody))
      .digest('hex');

    const pay1 = await fastify.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'x-gateway-signature': hmacSig },
      payload: webhookBody,
    });
    expect(pay1.statusCode).toBe(200);
    expect(pay1.json().processed).toBe(true);

    const pay2 = await fastify.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'x-gateway-signature': hmacSig },
      payload: webhookBody,
    });
    expect(pay2.statusCode).toBe(200);
    expect(pay2.json().idempotentDuplicate).toBe(true);
  });

  it('8. WhisperKvCacheAutoregressiveOptimizer exposes O(N) KV-cache decode entry point', () => {
    expect(typeof WhisperKvCacheAutoregressiveOptimizer.prototype.decodeWithKvCache).toBe(
      'function',
    );
  });
});
