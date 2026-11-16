/**
 * @file backend/__tests__/FullBackendIntegration.spec.ts
 * @description Section 142: End-to-End Verification for BackendApplicationFactory (`buildBackendApplication`)
 *              and Persian RAKE Multi-Word Keyphrase Extractor (`PersianTopicAndKeywordIndexer`).
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import { buildBackendApplication } from '../src/BackendApplicationFactory';
import { PgPoolLike } from '../src/PlatformBackendServices';
import { PersianTopicAndKeywordIndexer } from '../../src/ai-engine/asr/PersianTopicAndKeywordIndexer';
import { PersianTextNormalizer } from '../../src/ai-engine/PersianTextNormalizer';
import { TimeMath } from '../../src/contracts/timebase.contract';

describe('Full Backend Factory Integration & Persian RAKE Keyphrase Suite (Sections 140–142)', () => {
  it('1. Full BackendApplicationFactory wires Auth, JWT Guards, Enterprise Keys, Canary, Healthz & Prometheus Metrics cleanly', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const adminKey = 'admin_factory_secret';

    const mockDb: PgPoolLike = {
      async query(sql) {
        if (sql === 'SELECT 1') {
          return { rows: [{ '?column?': 1 }] as any, rowCount: 1 };
        }
        if (sql.includes('INSERT INTO enterprise_api_keys')) {
          return { rows: [{ key_id: 'ent_key_99' }] as any, rowCount: 1 };
        }
        if (sql.includes('FROM ai_models_catalog')) {
          return {
            rows: [
              {
                model_id: 'fastconformer-fa',
                version: '1.2.0',
                release_status: 'ACTIVE',
              },
            ] as any,
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const app = buildBackendApplication(mockDb, {
      ed25519PrivateKeyPem: privPem,
      ed25519PublicKeyPem: pubPem,
      keyId: 'k_prod',
      paymentWebhookHmacSecret: 'pay_sec',
      adminApiSecretKey: adminKey,
      modelStorageRootDir: os.tmpdir(),
      cdnBaseUrl: 'https://cdn.local',
      enableServerSideAsrInference: false,
    });

    // 1. Verify /readyz probe
    const readyRes = await app.fastify.inject({ method: 'GET', url: '/readyz' });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json().postgres).toBe('connected');

    // 2. Verify unauthenticated request to /api/v1/license/lease is blocked by EdDSA JWT preHandler
    const unauthLicense = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/lease',
      payload: { userId: 'u1', deviceFingerprintHash: 'h1' },
    });
    expect(unauthLicense.statusCode).toBe(401);

    // 3. Verify Admin Enterprise API Key creation endpoint
    const keyRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/admin/enterprise-keys',
      headers: { 'x-admin-api-key': adminKey },
      payload: {
        organizationId: 'org_media_1',
        scopes: ['MODELS_READ'],
        monthlyAudioSecondsLimit: 7200,
      },
    });
    expect(keyRes.statusCode).toBe(201);
    expect(keyRes.json().plaintextApiKeyOnce.startsWith('paudio_live_')).toBe(
      true,
    );

    // 4. Verify Prometheus /metrics exposition format
    const metricsRes = await app.fastify.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body).toContain('paudio_backend_http_requests_total');
  });

  it('2. PersianTopicAndKeywordIndexer extracts multi-word Persian keyphrases with timestamps using RAKE', () => {
    const words = [
      'در', 'این', 'جلسه', 'درباره', 'پردازش', 'محلی', 'صوت', 'و', 'امنیت', 'زنجیره', 'تامین',
      'صحبت', 'می‌کنیم', '.', 'هدف', 'ما', 'بهبود', 'پردازش', 'محلی', 'صوت', 'در', 'مرورگر', 'است', '.',
    ];

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript(
      words.map((w, idx) => ({
        id: `tk_${idx}`,
        text: w,
        range: {
          start: TimeMath.secondsToFlicks(idx * 0.35),
          end: TimeMath.secondsToFlicks(idx * 0.35 + 0.3),
        },
        confidence: 0.95,
      })),
    );

    const keyphrases = PersianTopicAndKeywordIndexer.extractPersianKeyphrases(
      tokens,
      5,
    );
    const extractedStrings = keyphrases.map((k) => k.phraseFa);

    expect(extractedStrings).toContain('پردازش محلی صوت');
    expect(extractedStrings).toContain('امنیت زنجیره تامین');
    expect(keyphrases[0].occurrenceCount).toBeGreaterThanOrEqual(1);
  });
});
