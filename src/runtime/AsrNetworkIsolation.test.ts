import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLocalOnlyFetchGuard } from './LocalExecutionPolicy';
import { LocalPrivacyViolationError } from '../security/LocalPrivacyPolicy';

test('Static source verification: src/App.tsx contains zero /api/v1/asr/transcribe or Gemini Cloud ASR upload calls', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const source = fs.readFileSync(appPath, 'utf8');

  assert.equal(
    /\/api\/v1\/asr\/transcribe/i.test(source),
    false,
    'src/App.tsx must never reference /api/v1/asr/transcribe',
  );
  assert.equal(
    /executeCloudGeminiAsr|handleRunCloudGeminiAsr|gemini-3\.5-transcribe/i.test(source),
    false,
    'src/App.tsx must not contain Cloud Gemini ASR execution handlers',
  );
  assert.equal(
    /generativelanguage\.googleapis\.com/i.test(source),
    false,
    'src/App.tsx must never call generativelanguage.googleapis.com',
  );
});

test('Static source verification: server.ts contains zero @google/genai imports and enforces 410 Local-Only guard on /api/v1/asr/transcribe', () => {
  const serverPath = path.resolve(process.cwd(), 'server.ts');
  const source = fs.readFileSync(serverPath, 'utf8');

  assert.equal(
    /from\s+['"]@google\/genai['"]/.test(source),
    false,
    'server.ts must not import @google/genai in Local-Only Phase-01 runtime',
  );
  assert.equal(
    /new\s+GoogleGenAI\b/.test(source),
    false,
    'server.ts must not instantiate GoogleGenAI for ASR',
  );
  assert.ok(
    source.includes('LOCAL_ONLY_ASR_POLICY_ENFORCED'),
    'server.ts must enforce explicit LOCAL_ONLY_ASR_POLICY_ENFORCED response on blocked cloud ASR route',
  );
});

test('createLocalOnlyFetchGuard intercepts and blocks external ASR uploads with zero forwarded requests', async () => {
  let forwardedCalls = 0;
  const mockBaseFetch: typeof fetch = async () => {
    forwardedCalls++;
    return new Response('{}', { status: 200 });
  };

  const guard = createLocalOnlyFetchGuard(mockBaseFetch, {
    allowedLocalOrigin: 'http://localhost:3000',
  });

  await assert.rejects(
    () =>
      guard.guardedFetch('http://localhost:3000/api/v1/asr/transcribe', {
        method: 'POST',
        body: new Uint8Array([1, 2, 3]),
      }),
    LocalPrivacyViolationError,
  );

  await assert.rejects(
    () =>
      guard.guardedFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini', {
        method: 'POST',
      }),
    LocalPrivacyViolationError,
  );

  assert.equal(forwardedCalls, 0);
  assert.equal(guard.getBlockedCount(), 2);
  assert.equal(guard.getAuditLog().length, 2);

  // Local static WASM fetch succeeds cleanly
  const okResp = await guard.guardedFetch('/models/local-runtime.wasm', { method: 'GET' });
  assert.equal(okResp.status, 200);
  assert.equal(forwardedCalls, 1);
});
