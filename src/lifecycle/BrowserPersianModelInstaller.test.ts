import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Bytes } from '../utils/StreamingSha256';
import {
  InMemoryModelChunkStorage,
  LocalModelLifecycleManager,
} from './LocalModelLifecycleManager';
import {
  fetchBundledBrowserSampleWav,
  installShenavaRizehInBrowser,
} from './BrowserPersianModelInstaller';

function buildMockFetch(params: {
  readonly onnxBytes: Uint8Array;
  readonly tokensBytes: Uint8Array;
  readonly onnxShaOverride?: string;
  readonly tokensShaOverride?: string;
  readonly prepareStatus?: number;
  readonly sampleWavBytes?: Uint8Array;
}): typeof fetch {
  const onnxSha = params.onnxShaOverride ?? sha256Bytes(params.onnxBytes);
  const tokensSha = params.tokensShaOverride ?? sha256Bytes(params.tokensBytes);

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);

    if (url === '/api/v1/local-models/shenava-rizen/prepare') {
      const status = params.prepareStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ ok: false, error: 'PREP_FAILED', message: 'prepare failed' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          modelId: 'shenava-rizen-fa-fastconformer-int8',
          modelVersion: '1.0.0',
          architecture: 'FASTCONFORMER_CTC',
          sampleAudioAvailable: Boolean(params.sampleWavBytes),
          artifacts: {
            'model.int8.onnx': {
              byteLength: params.onnxBytes.byteLength,
              sha256Hex: onnxSha,
              url: '/api/v1/local-models/shenava-rizen/artifacts/model.int8.onnx',
            },
            'tokens.txt': {
              byteLength: params.tokensBytes.byteLength,
              sha256Hex: tokensSha,
              url: '/api/v1/local-models/shenava-rizen/artifacts/tokens.txt',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url === '/api/v1/local-models/shenava-rizen/artifacts/tokens.txt') {
      return new Response(new Uint8Array(params.tokensBytes), {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (url === '/api/v1/local-models/shenava-rizen/artifacts/model.int8.onnx') {
      const headers = new Headers(init?.headers);
      const range = headers.get('Range');
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/i.exec(range);
        assert.ok(match, `Invalid Range header: ${range}`);
        const start = Number.parseInt(match[1], 10);
        const end = Math.min(params.onnxBytes.byteLength - 1, Number.parseInt(match[2], 10));
        const slice = new Uint8Array(params.onnxBytes.subarray(start, end + 1));
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${start}-${end}/${params.onnxBytes.byteLength}`,
          },
        });
      }
      return new Response(new Uint8Array(params.onnxBytes), { status: 200 });
    }

    if (url === '/api/v1/local-models/shenava-rizen/artifacts/sample-0.wav') {
      if (!params.sampleWavBytes) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(new Uint8Array(params.sampleWavBytes), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      });
    }

    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
}

test('BrowserPersianModelInstaller: streams verified Range chunks into OPFS and persists tokens.txt CTC vocab', async () => {
  const storage = new InMemoryModelChunkStorage();
  const manager = new LocalModelLifecycleManager(storage);
  await manager.initialize();
  assert.equal(manager.getSnapshot().state, 'MODEL_NOT_INSTALLED');

  // 10 KiB synthetic ONNX payload split into 4 KiB Range slices
  const fakeOnnx = new Uint8Array(10 * 1024);
  for (let i = 0; i < fakeOnnx.length; i++) fakeOnnx[i] = (i * 31) & 0xff;
  const fakeTokens = new TextEncoder().encode('<unk> 0\n▁سلام 1\n▁جهان 2\n<blk> 3\n');

  let savedVocab: { modelId: string; version: string; txt: string } | null = null;
  const progressEvents: number[] = [];

  const result = await installShenavaRizehInBrowser({
    modelManager: manager,
    chunkSizeBytes: 4096,
    fetchFn: buildMockFetch({ onnxBytes: fakeOnnx, tokensBytes: fakeTokens }),
    saveVocabularyFn: (modelId, version, txt) => {
      savedVocab = { modelId, version, txt };
      return { ok: true, tokenCount: 4 };
    },
    onProgress: (pct) => progressEvents.push(pct),
  });

  assert.equal(result.ok, true);
  assert.equal(result.modelId, 'shenava-rizen-fa-fastconformer-int8');
  assert.equal(result.modelVersion, '1.0.0');
  assert.equal(result.tokenCount, 4);
  assert.equal(result.snapshot.state, 'MODEL_AVAILABLE');
  assert.equal(result.snapshot.activeModel?.modelId, 'shenava-rizen-fa-fastconformer-int8');
  assert.equal(result.snapshot.activeModel?.verifiedSha256Hex, sha256Bytes(fakeOnnx));
  assert.ok(savedVocab);
  assert.equal(progressEvents[progressEvents.length - 1], 100);

  const verify = await manager.verifyInstalledActiveModelOffline();
  assert.equal(verify.ok, true);
  assert.equal(verify.state, 'MODEL_AVAILABLE');
});

test('BrowserPersianModelInstaller: rejects tokens.txt SHA-256 mismatch atomically before writing OPFS', async () => {
  const storage = new InMemoryModelChunkStorage();
  const manager = new LocalModelLifecycleManager(storage);
  await manager.initialize();

  const fakeOnnx = new Uint8Array(4096).fill(7);
  const fakeTokens = new TextEncoder().encode('<unk> 0\n<blk> 1\n');
  let vocabCalled = false;

  const result = await installShenavaRizehInBrowser({
    modelManager: manager,
    chunkSizeBytes: 2048,
    fetchFn: buildMockFetch({
      onnxBytes: fakeOnnx,
      tokensBytes: fakeTokens,
      tokensShaOverride: '0'.repeat(64),
    }),
    saveVocabularyFn: () => {
      vocabCalled = true;
      return { ok: true, tokenCount: 2 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TOKENS_VERIFICATION_FAILED');
  assert.equal(vocabCalled, false);
  assert.equal(manager.getSnapshot().state, 'MODEL_NOT_INSTALLED');
  assert.equal(manager.getSnapshot().activeModel, null);
});

test('BrowserPersianModelInstaller: rejects ONNX SHA-256 mismatch without activating model', async () => {
  const storage = new InMemoryModelChunkStorage();
  const manager = new LocalModelLifecycleManager(storage);
  await manager.initialize();

  const fakeOnnx = new Uint8Array(4096).fill(9);
  const fakeTokens = new TextEncoder().encode('<unk> 0\n<blk> 1\n');
  let vocabCalled = false;

  const result = await installShenavaRizehInBrowser({
    modelManager: manager,
    chunkSizeBytes: 2048,
    fetchFn: buildMockFetch({
      onnxBytes: fakeOnnx,
      tokensBytes: fakeTokens,
      onnxShaOverride: 'f'.repeat(64),
    }),
    saveVocabularyFn: () => {
      vocabCalled = true;
      return { ok: true, tokenCount: 2 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(vocabCalled, false);
  assert.equal(manager.getSnapshot().activeModel, null);
});

test('BrowserPersianModelInstaller: handles HTTP prepare errors cleanly', async () => {
  const storage = new InMemoryModelChunkStorage();
  const manager = new LocalModelLifecycleManager(storage);
  await manager.initialize();

  const result = await installShenavaRizehInBrowser({
    modelManager: manager,
    fetchFn: buildMockFetch({
      onnxBytes: new Uint8Array(1024),
      tokensBytes: new Uint8Array(32),
      prepareStatus: 500,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MODEL_PREPARE_HTTP_FAILED');
  assert.equal(manager.getSnapshot().state, 'MODEL_NOT_INSTALLED');
});

test('fetchBundledBrowserSampleWav: validates RIFF header and rejects malformed audio', async () => {
  const validWav = new Uint8Array(64);
  validWav.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF

  const sample = await fetchBundledBrowserSampleWav({
    fetchFn: buildMockFetch({
      onnxBytes: new Uint8Array(64),
      tokensBytes: new Uint8Array(16),
      sampleWavBytes: validWav,
    }),
  });
  assert.equal(sample.filename, 'shenava-sample-0.wav');
  assert.equal(sample.wavBytes.byteLength, 64);

  await assert.rejects(
    () =>
      fetchBundledBrowserSampleWav({
        fetchFn: buildMockFetch({
          onnxBytes: new Uint8Array(64),
          tokensBytes: new Uint8Array(16),
          sampleWavBytes: new Uint8Array(64), // zero header -> not RIFF
        }),
      }),
    /INVALID_SAMPLE_WAV_HEADER/,
  );
});
