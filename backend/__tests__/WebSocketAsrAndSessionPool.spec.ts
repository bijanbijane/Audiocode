import { describe, it, expect } from 'vitest';
import {
  LiveWsSocketLike,
  WebSocketLiveAsrGateway,
} from '../src/gateway/WebSocketLiveAsrGateway';
import { NodeAsrModelSessionPool } from '../src/asr-worker/NodeAsrModelSessionPool';
import { EnterpriseApiKeyAndQuotaManager } from '../src/auth/EnterpriseApiKeyAndQuotaManager';
import { PgPoolLike } from '../src/PlatformBackendServices';
import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from '../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';

describe('WebSocket Live ASR Gateway & Reference-Counted ONNX Session Pool Suite', () => {
  it('1. WebSocketLiveAsrGateway enforces V1 policy, handles split odd-byte Int16 PCM packets, and emits stabilized Persian updates', async () => {
    let remainingUsed = 0;
    const mockDb: PgPoolLike = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        if (sql.includes('SELECT key_id, organization_id')) {
          return {
            rows: [
              {
                key_id: 'k_ws_1',
                organization_id: 'org_1',
                scopes: ['CLOUD_ASR_ENTERPRISE'],
                monthly_audio_seconds_limit: '1000',
                monthly_audio_seconds_used: String(remainingUsed),
                revoked: false,
                expires_at: null,
              },
            ] as unknown as T[],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE enterprise_api_keys')) {
          remainingUsed += params[1] as number;
          return {
            rows: [
              {
                monthly_audio_seconds_used: String(remainingUsed),
                monthly_audio_seconds_limit: '1000',
              },
            ] as unknown as T[],
            rowCount: 1,
          };
        }
        return { rows: [] as unknown as T[], rowCount: 0 };
      },
    };

    const quotaMgr = new EnterpriseApiKeyAndQuotaManager(mockDb);
    const sentMessages: any[] = [];
    let closedCode: number | null = null;

    const fakeSocket: LiveWsSocketLike = {
      send: (txt) => sentMessages.push(JSON.parse(txt)),
      close: (code) => {
        closedCode = code;
      },
    };

    // A) Verify V1 policy blocks live cloud ASR when enableServerSideAsrInference=false
    const v1LockedGateway = new WebSocketLiveAsrGateway(quotaMgr, false);
    const blockedCtrl = await v1LockedGateway.openAuthenticatedSession({
      enterpriseApiKey: 'paudio_live_000111',
      socket: fakeSocket,
      transcribeWindowFn: async () => [],
    });
    expect(blockedCtrl).toBeNull();
    expect(closedCode).toBe(1008);
    expect(sentMessages[0].code).toBe('CLOUD_ASR_DISABLED_IN_V1');

    // B) Test active enterprise streaming: split Int16 buffer across an odd-byte boundary (16001 and 15999 bytes)
    sentMessages.length = 0;
    closedCode = null;
    const enterpriseGateway = new WebSocketLiveAsrGateway(quotaMgr, true);

    const receivedSampleLengths: number[] = [];
    const ctrl = await enterpriseGateway.openAuthenticatedSession({
      enterpriseApiKey: 'paudio_live_000111',
      socket: fakeSocket,
      transcribeWindowFn: async (pcm) => {
        receivedSampleLengths.push(pcm.length);
        // Return word "سلام" in [0.1s..0.4s] outside the draft horizon
        return [
          { word: 'سلام', relativeStartSec: 0.1, relativeEndSec: 0.4, probability: 0.96 },
        ];
      },
    });
    expect(ctrl).not.toBeNull();
    expect(sentMessages[0].type).toBe('SESSION_READY');

    // Construct 1s of Int16 audio (16000 samples = 32000 bytes) and split at odd byte 16001
    const fullInt16 = new Int16Array(16000);
    fullInt16.fill(8192);
    const rawBytes = new Uint8Array(fullInt16.buffer);

    await ctrl!.handleIncomingInt16BinaryFrame(rawBytes.subarray(0, 16001)); // 8000 samples + 1 trailing odd byte
    await ctrl!.handleIncomingInt16BinaryFrame(rawBytes.subarray(16001));    // 1 carried byte + 7999 samples = 8000 exact samples

    await ctrl!.finalizeAndClose();

    expect(receivedSampleLengths[0]).toBe(8000);
    expect(receivedSampleLengths[1]).toBe(16000);

    const hypothesisEvent = sentMessages.find(
      (m) => m.type === 'HYPOTHESIS_UPDATE' && m.update.newlyCommittedWords.length > 0
    );
    expect(hypothesisEvent).toBeDefined();
    expect(hypothesisEvent.update.newlyCommittedWords[0].word).toBe('سلام');
  });

  it('2. NodeAsrModelSessionPool warms up models once, protects actively leased models, and evicts idle LRU models', async () => {
    let warmupRuns = 0;
    const releasedModelKeys: string[] = [];

    const mockOrt: OrtRuntimeProvider = {
      createTensor: (type, data, dims) => ({ type, data, dims } as OrtTensorLike),
      createSession: async (key): Promise<OrtSessionLike> => ({
        run: async (): Promise<Record<string, OrtTensorLike>> => {
          warmupRuns++;
          return {};
        },
        release: async () => {
          releasedModelKeys.push(String(key));
        },
      }),
    };

    const pool = new NodeAsrModelSessionPool(mockOrt, 1000); // 1000MB budget

    const modelA = {
      modelKey: 'model_A',
      modelPathOrBytes: 'model_A',
      estimatedMemoryFootprintMb: 600,
      executionProviders: ['cpu'] as ('cuda' | 'cpu')[],
      buildWarmupDummyFeeds: () => ({}),
    };
    const modelB = {
      modelKey: 'model_B',
      modelPathOrBytes: 'model_B',
      estimatedMemoryFootprintMb: 600,
      executionProviders: ['cpu'] as ('cuda' | 'cpu')[],
      buildWarmupDummyFeeds: () => ({}),
    };

    // Load and lease model A (600MB)
    const leaseA = await pool.acquireSession(modelA);
    expect(warmupRuns).toBe(1);

    // While leaseA is active, model B (600MB) must not evict model A
    await expect(pool.acquireSession(modelB)).rejects.toThrow('SESSION_POOL_MEMORY_EXHAUSTED');

    // After releasing leaseA, model B evicts idle model A via LRU
    leaseA.release();
    const leaseB = await pool.acquireSession(modelB);
    expect(releasedModelKeys).toEqual(['model_A']);
    expect(pool.getPoolStats().totalAllocatedMb).toBe(600);
    leaseB.release();
  });
});
