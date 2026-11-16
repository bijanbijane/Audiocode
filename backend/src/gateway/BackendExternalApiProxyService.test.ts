import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendExternalApiProxyService } from './BackendExternalApiProxyService';
import { FastifyInstanceLike, FastifyReplyLike, PgPoolLike } from '../PlatformBackendServices';

describe('Section 109: BackendExternalApiProxyService (Section 43 Governance)', () => {
  it('blocks auto-fallback and oversized snippets, and returns EXTERNAL_API provenance on consented snippet', async () => {
    let auditInserts = 0;
    const mockDb: PgPoolLike = {
      async query() {
        auditInserts++;
        return { rows: [], rowCount: 1 };
      },
    };

    const postRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();
    const mockFastify: FastifyInstanceLike = {
      get() {},
      post(url, handler) {
        postRoutes.set(url, handler);
      },
    };

    const proxy = new BackendExternalApiProxyService(mockDb);
    proxy.registerProviderAdapter({
      providerId: 'cloud-persian-asr-v2',
      supportsPersianWordTimestamps: true,
      costPerMinuteUsd: 0.024,
      async transcribeAudioSnippet() {
        return {
          transcript: 'تست دروازه خارجی',
          words: [
            { word: 'تست', startSec: 0.1, endSec: 0.4, confidence: 0.95 },
            { word: 'دروازه', startSec: 0.45, endSec: 0.9, confidence: 0.93 },
            { word: 'خارجی', startSec: 0.95, endSec: 1.4, confidence: 0.96 },
          ],
        };
      },
    });
    proxy.registerRoutes(mockFastify);

    const makeReply = () => {
      let statusCode = 200;
      let payload: any = null;
      const reply: FastifyReplyLike = {
        status(c) {
          statusCode = c;
          return reply;
        },
        header() {
          return reply;
        },
        send(p) {
          payload = p;
          return p;
        },
      };
      return { reply, getStatus: () => statusCode, getPayload: () => payload };
    };

    const handler = postRoutes.get('/api/v1/external-gateway/transcribe-snippet')!;

    // 1. Reject auto-fallback from internal AI
    const fallbackRep = makeReply();
    await handler(
      {
        body: {
          userId: 'usr_1',
          providerId: 'cloud-persian-asr-v2',
          consentId: 'c_1',
          explicitUserConsentGranted: true,
          isInternalAiFallback: true,
          snippetDurationSeconds: 15,
          audioBase64: 'AAAA',
        },
        headers: {},
      },
      fallbackRep.reply,
    );
    assert.equal(fallbackRep.getStatus(), 403);
    assert.equal(fallbackRep.getPayload().error, 'AUTO_FALLBACK_FORBIDDEN');

    // 2. Reject full-file / > 120s upload (Data Minimization)
    const oversizeRep = makeReply();
    await handler(
      {
        body: {
          userId: 'usr_1',
          providerId: 'cloud-persian-asr-v2',
          consentId: 'c_1',
          explicitUserConsentGranted: true,
          isInternalAiFallback: false,
          snippetDurationSeconds: 180,
          audioBase64: 'AAAA',
        },
        headers: {},
      },
      oversizeRep.reply,
    );
    assert.equal(oversizeRep.getStatus(), 400);
    assert.equal(oversizeRep.getPayload().error, 'DATA_MINIMIZATION_LIMIT_EXCEEDED');

    // 3. Valid consented 30s snippet
    const okRep = makeReply();
    await handler(
      {
        body: {
          userId: 'usr_1',
          providerId: 'cloud-persian-asr-v2',
          consentId: 'consent_2026_ok',
          explicitUserConsentGranted: true,
          isInternalAiFallback: false,
          snippetDurationSeconds: 30,
          audioBase64: Buffer.from('RIFF_MOCK').toString('base64'),
        },
        headers: {},
      },
      okRep.reply,
    );
    assert.equal(okRep.getStatus(), 200);
    assert.equal(okRep.getPayload().provenance.origin, 'EXTERNAL_API');
    assert.equal(okRep.getPayload().provenance.requiresMandatoryUserReview, true);
    assert.equal(auditInserts, 1);
  });
});
