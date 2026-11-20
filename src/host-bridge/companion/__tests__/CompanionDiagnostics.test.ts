import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMPANION_ENDPOINT,
  STANDALONE_COMPANION_ENDPOINT,
  loadConfiguredCompanionEndpoint,
  normalizeAndValidateCompanionEndpoint,
  runCompanionConnectionDiagnostic,
  saveConfiguredCompanionEndpoint,
  type FetchLike,
} from '../CompanionDiagnostics';

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizeAndValidateCompanionEndpoint accepts same-origin and loopback endpoints', () => {
  const sameOrigin = normalizeAndValidateCompanionEndpoint(' /api/v2/companion/ ');
  assert.equal(sameOrigin.valid, true);
  assert.equal(sameOrigin.normalizedEndpoint, '/api/v2/companion');
  assert.equal(sameOrigin.kind, 'SAME_ORIGIN_PROXY');

  const loopbackIp = normalizeAndValidateCompanionEndpoint('http://127.0.0.1:47291/api/v2/companion/');
  assert.equal(loopbackIp.valid, true);
  assert.equal(loopbackIp.normalizedEndpoint, 'http://127.0.0.1:47291/api/v2/companion');
  assert.equal(loopbackIp.kind, 'LOOPBACK_DAEMON');

  const localhost = normalizeAndValidateCompanionEndpoint('http://localhost:3000/api/v2/companion');
  assert.equal(localhost.valid, true);
  assert.equal(localhost.kind, 'LOOPBACK_DAEMON');
});

test('normalizeAndValidateCompanionEndpoint blocks remote hosts, empty strings, and invalid schemes', () => {
  const empty = normalizeAndValidateCompanionEndpoint('   ');
  assert.equal(empty.valid, false);
  assert.equal(empty.errorCode, 'EMPTY_ENDPOINT');

  const remote = normalizeAndValidateCompanionEndpoint('https://api.example.com/api/v2/companion');
  assert.equal(remote.valid, false);
  assert.equal(remote.errorCode, 'REMOTE_HOST_BLOCKED');

  const jsScheme = normalizeAndValidateCompanionEndpoint('javascript:alert(1)');
  assert.equal(jsScheme.valid, false);
  assert.equal(jsScheme.errorCode, 'UNSUPPORTED_PROTOCOL');

  const doubleSlash = normalizeAndValidateCompanionEndpoint('//evil.example.com/api');
  assert.equal(doubleSlash.valid, false);
  assert.equal(doubleSlash.errorCode, 'INVALID_URL_SYNTAX');
});

test('saveConfiguredCompanionEndpoint and loadConfiguredCompanionEndpoint persist validated values', () => {
  const map = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };

  assert.equal(loadConfiguredCompanionEndpoint(mockStorage), DEFAULT_COMPANION_ENDPOINT);

  const rejected = saveConfiguredCompanionEndpoint('https://remote.invalid/api', mockStorage);
  assert.equal(rejected.valid, false);
  assert.equal(loadConfiguredCompanionEndpoint(mockStorage), DEFAULT_COMPANION_ENDPOINT);

  const saved = saveConfiguredCompanionEndpoint(`${STANDALONE_COMPANION_ENDPOINT}/`, mockStorage);
  assert.equal(saved.valid, true);
  assert.equal(loadConfiguredCompanionEndpoint(mockStorage), STANDALONE_COMPANION_ENDPOINT);
});

test('runCompanionConnectionDiagnostic verifies all 3 stages on a healthy Companion service', async () => {
  const calls: string[] = [];
  const fetchMock: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/health')) {
      return makeJsonResponse({
        service: 'avapardaz-companion',
        serviceVersion: '1.5.0',
        ipcProtocolVersion: '1.0.0',
        offlineOnlyEnforced: true,
        cloudUploadDisabled: true,
        runtime: {
          runtimeName: 'sherpa-onnx',
          available: true,
          cpuThreads: 4,
          activeModelId: 'whisper-fa-int8',
          installedModels: [
            {
              modelId: 'whisper-fa-int8',
              profileId: 'balanced',
              displayName: 'Whisper FA INT8',
              architecture: 'whisper',
              quantization: 'int8',
              licenseSpdx: 'MIT',
              supportedLanguages: ['fa', 'en'],
              supportsNativeWordTimestamps: true,
              diskSizeBytes: 120_000_000,
              integrityVerified: true,
            },
          ],
          processRssMb: 184,
        },
        activeJobs: 0,
      });
    }
    if (url.endsWith('/handshake')) {
      return makeJsonResponse({
        compatible: true,
        session_id: 'sess_diag_1',
        session_token: 'tok_diag_1',
      });
    }
    if (url.endsWith('/ipc')) {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer tok_diag_1');
      return makeJsonResponse({
        ok: true,
        capabilities: ['transcribe', 'upload_chunk', 'cancel'],
      });
    }
    return makeJsonResponse({ error: 'not_found' }, 404);
  };

  const report = await runCompanionConnectionDiagnostic({
    endpoint: '/api/v2/companion/',
    fetchImpl: fetchMock,
  });

  assert.equal(report.overallStatus, 'CONNECTED');
  assert.equal(report.endpoint, '/api/v2/companion');
  assert.equal(report.sessionVerified, true);
  assert.equal(report.capabilityCount, 3);
  assert.equal(report.stages.length, 3);
  assert.ok(report.stages.every((s) => s.status === 'PASS'));
  assert.deepEqual(calls, [
    'GET /api/v2/companion/health',
    'POST /api/v2/companion/handshake',
    'POST /api/v2/companion/ipc',
  ]);
});

test('runCompanionConnectionDiagnostic handles non-JSON HTML proxy responses safely without throwing', async () => {
  const fetchMock: FetchLike = async () =>
    new Response('<html><head><title>502 Bad Gateway</title></head><body>Proxy down</body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });

  const report = await runCompanionConnectionDiagnostic({
    endpoint: '/api/v2/companion',
    fetchImpl: fetchMock,
  });

  assert.equal(report.overallStatus, 'UNREACHABLE');
  assert.equal(report.stages[1].status, 'FAIL');
  assert.equal(report.stages[1].httpStatus, 502);
  assert.match(report.stages[1].detail ?? '', /502 Bad Gateway/);
});

test('runCompanionConnectionDiagnostic marks DEGRADED when health works but handshake fails', async () => {
  const fetchMock: FetchLike = async (url) => {
    if (url.endsWith('/health')) {
      return makeJsonResponse({
        service: 'avapardaz-companion',
        serviceVersion: '1.5.0',
        ipcProtocolVersion: '1.0.0',
        offlineOnlyEnforced: true,
        cloudUploadDisabled: true,
        runtime: {
          runtimeName: 'sherpa-onnx',
          available: true,
          cpuThreads: 4,
          activeModelId: 'whisper-fa-int8',
          installedModels: [],
          processRssMb: 90,
        },
        activeJobs: 0,
      });
    }
    return makeJsonResponse({ error: 'UNTRUSTED_ORIGIN', message: 'Origin blocked' }, 403);
  };

  const report = await runCompanionConnectionDiagnostic({
    endpoint: '/api/v2/companion',
    fetchImpl: fetchMock,
  });

  assert.equal(report.overallStatus, 'DEGRADED');
  assert.equal(report.sessionVerified, false);
  assert.equal(report.stages[2].id, 'HANDSHAKE_AND_IPC');
  assert.equal(report.stages[2].status, 'FAIL');
  assert.equal(report.stages[2].httpStatus, 403);
});

test('runCompanionConnectionDiagnostic never calls fetch for blocked remote hosts', async () => {
  let called = false;
  const fetchMock: FetchLike = async () => {
    called = true;
    return makeJsonResponse({});
  };

  const report = await runCompanionConnectionDiagnostic({
    endpoint: 'https://untrusted-cloud.example.org/api/v2/companion',
    fetchImpl: fetchMock,
  });

  assert.equal(called, false);
  assert.equal(report.overallStatus, 'INVALID_ENDPOINT');
  assert.equal(report.stages.length, 1);
  assert.equal(report.stages[0].status, 'FAIL');
});
