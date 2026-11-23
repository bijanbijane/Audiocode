import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AsrInferenceRequest,
  AsrLabEngineId,
  AsrProviderAdapter,
  PHASE1_ENGINE_REGISTRY,
  runAsrLabExperiment,
  validateAndPreprocessAudioForLab,
} from './AsrExperimentationLabCore';

const CANARY_REFERENCE = 'GOLD_REFERENCE_CANARY_X91Q_Typescript_آواپرداز';

function makeAudio(durationSec = 2) {
  const sr = 16000;
  const pcm = new Float32Array(Math.floor(sr * durationSec));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.2 * Math.sin((2 * Math.PI * 300 * i) / sr);
  }
  return validateAndPreprocessAudioForLab({
    fileName: 'isolation_test.wav',
    channelsPcm: [pcm],
    sampleRate: sr,
  });
}

function containsSubstringDeep(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((v) => containsSubstringDeep(v, needle, seen));
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.includes(needle) || containsSubstringDeep(v, needle, seen)) return true;
  }
  return false;
}

describe('AVP-009: Ground-Truth Isolation, Anti-Synthetic Gates & Timeout/Cancellation Enforcement', () => {
  it('never exposes referenceTranscriptRaw (canary) or frozen-sample keyterms to any ASR provider adapter', async () => {
    const inspectedRequests: AsrInferenceRequest[] = [];

    const spyAdapter: AsrProviderAdapter = {
      descriptor: {
        ...PHASE1_ENGINE_REGISTRY[0],
        supportsTranscription: true,
      },
      async transcribe(request) {
        inspectedRequests.push(request);
        assert.equal(
          containsSubstringDeep(request, CANARY_REFERENCE),
          false,
          'CRITICAL LEAKAGE: canary reference transcript appeared inside adapter request',
        );
        assert.equal(
          containsSubstringDeep(request, 'CANARY'),
          false,
          'CRITICAL LEAKAGE: canary token appeared inside adapter request',
        );
        assert.equal(
          request.config.keyterms,
          undefined,
          'Frozen test sample must strip keyterms from isolated inference config',
        );
        assert.equal(
          request.config.contextPrompt,
          undefined,
          'Frozen test sample must strip contextPrompt from isolated inference config',
        );

        return {
          status: 'SUCCESS',
          rawTranscript: 'سلام امروز پروژه تست میشود',
          hypothesisProvenance: 'MODEL_INFERENCE',
          modelIdentity: {
            modelId: 'conformer-fa-v1',
            modelVersion: '1.0.0',
            modelSha256: '1'.repeat(64),
            architecture: 'FASTCONFORMER_CTC',
          },
        };
      },
    };

    const customAdapters = new Map<AsrLabEngineId, AsrProviderAdapter>([
      ['avapardaz-local-ctc-dsp', spyAdapter],
    ]);

    const exp = await runAsrLabExperiment({
      audio: makeAudio(2),
      referenceTranscriptRaw: CANARY_REFERENCE,
      selectedEngineIds: ['avapardaz-local-ctc-dsp'],
      config: {
        expectedLanguage: 'fa-en-mixed',
        mode: 'batch',
        keyterms: ['آواپرداز', 'CANARY'],
        contextPrompt: 'CANARY context',
        isFrozenTestSample: true,
      },
      customAdapters,
    });

    assert.equal(inspectedRequests.length, 1);
    const r = exp.engineResults[0];
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.eligibleForAccuracyLeaderboard, true);
    assert.ok(r.evaluation !== null);
    assert.ok(r.evaluation!.normalizedMetrics.cerPercent > 0, 'Independent hypothesis must not artificially match canary');
  });

  it('blocks synthetic outputs, forced alignment, acoustic segmentation, and deterministic test fixtures from accuracy scoring', async () => {
    const audio = makeAudio(2);

    const syntheticAdapter: AsrProviderAdapter = {
      descriptor: PHASE1_ENGINE_REGISTRY[0],
      async transcribe() {
        return {
          status: 'SUCCESS',
          rawTranscript: 'بخشِ_1 بخشِ_2',
          hypothesisProvenance: 'MODEL_INFERENCE',
          modelIdentity: {
            modelId: 'fake',
            modelVersion: '1.0.0',
            modelSha256: '2'.repeat(64),
            architecture: 'FASTCONFORMER_CTC',
          },
        };
      },
    };

    const forcedAlignAdapter: AsrProviderAdapter = {
      descriptor: PHASE1_ENGINE_REGISTRY[1],
      async transcribe() {
        return {
          status: 'SUCCESS',
          rawTranscript: CANARY_REFERENCE,
          hypothesisProvenance: 'FORCED_ALIGNMENT',
          modelIdentity: {
            modelId: 'aligner',
            modelVersion: '1.0.0',
            modelSha256: null,
            architecture: null,
          },
        };
      },
    };

    const fixtureAdapter: AsrProviderAdapter = {
      descriptor: PHASE1_ENGINE_REGISTRY[2],
      async transcribe() {
        return {
          status: 'SUCCESS',
          rawTranscript: CANARY_REFERENCE,
          hypothesisProvenance: 'DETERMINISTIC_TEST_FIXTURE',
          isMockTestOnly: true,
          modelIdentity: {
            modelId: 'fixture',
            modelVersion: '1.0.0',
            modelSha256: null,
            architecture: null,
          },
        };
      },
    };

    const exp = await runAsrLabExperiment({
      audio,
      referenceTranscriptRaw: CANARY_REFERENCE,
      selectedEngineIds: [
        'avapardaz-local-ctc-dsp',
        'elevenlabs-scribe-v3',
        'deepgram-nova-3',
      ],
      config: { expectedLanguage: 'fa-en-mixed', mode: 'batch', keyterms: [] },
      customAdapters: new Map<AsrLabEngineId, AsrProviderAdapter>([
        ['avapardaz-local-ctc-dsp', syntheticAdapter],
        ['elevenlabs-scribe-v3', forcedAlignAdapter],
        ['deepgram-nova-3', fixtureAdapter],
      ]),
    });

    const [synRes, alignRes, fixRes] = exp.engineResults;
    assert.equal(synRes.status, 'EMPTY_RESPONSE');
    assert.equal(synRes.evaluation, null);
    assert.equal(synRes.eligibleForAccuracyLeaderboard, false);

    assert.equal(alignRes.evaluation, null);
    assert.equal(alignRes.eligibleForAccuracyLeaderboard, false);

    assert.equal(fixRes.evaluation, null);
    assert.equal(fixRes.eligibleForAccuracyLeaderboard, false);
  });

  it('enforces per-engine timeout with AbortSignal and ignores late responses after timeout', async () => {
    let sawAbort = false;
    const slowAdapter: AsrProviderAdapter = {
      descriptor: PHASE1_ENGINE_REGISTRY[0],
      async transcribe({ signal }) {
        signal?.addEventListener('abort', () => {
          sawAbort = true;
        });
        await new Promise((r) => setTimeout(r, 250));
        return {
          status: 'SUCCESS',
          rawTranscript: 'پاسخ دیرهنگام',
          hypothesisProvenance: 'MODEL_INFERENCE',
          modelIdentity: {
            modelId: 'slow-model',
            modelVersion: '1.0.0',
            modelSha256: '3'.repeat(64),
            architecture: 'FASTCONFORMER_CTC',
          },
        };
      },
    };

    const exp = await runAsrLabExperiment({
      audio: makeAudio(2),
      referenceTranscriptRaw: 'پاسخ دیرهنگام',
      selectedEngineIds: ['avapardaz-local-ctc-dsp'],
      config: { expectedLanguage: 'fa', mode: 'batch', timeoutMs: 40, keyterms: [] },
      customAdapters: new Map([['avapardaz-local-ctc-dsp', slowAdapter]]),
    });

    const res = exp.engineResults[0];
    assert.equal(res.status, 'TIMEOUT');
    assert.equal(res.rawOutputText, '');
    assert.equal(res.evaluation, null);
    assert.equal(res.eligibleForAccuracyLeaderboard, false);
    assert.equal(sawAbort, true);
  });

  it('returns honest MODEL_NOT_INSTALLED (with null evaluation) by default when no verified local model is installed', async () => {
    const exp = await runAsrLabExperiment({
      audio: makeAudio(2),
      referenceTranscriptRaw: CANARY_REFERENCE,
      selectedEngineIds: ['avapardaz-local-ctc-dsp'],
      config: { expectedLanguage: 'fa-en-mixed', mode: 'batch', keyterms: [] },
    });

    const res = exp.engineResults[0];
    assert.equal(res.status, 'MODEL_NOT_INSTALLED');
    assert.equal(res.evaluation, null);
    assert.equal(res.eligibleForAccuracyLeaderboard, false);
    assert.equal(res.rawOutputText, '');
    assert.equal(res.costLabel, 'NOT_BILLED_FAILED_RUN');
  });
});
