import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LabLocalInferenceAdapter,
  LocalModelRuntimeBinding,
} from './LabLocalInferenceAdapter';
import { validateAndPreprocessAudioForLab } from './AsrExperimentationLabCore';
import {
  InMemoryModelChunkStorage,
  LocalModelLifecycleManager,
} from '../../lifecycle/LocalModelLifecycleManager';
import { sha256Bytes } from '../../utils/StreamingSha256';
import { MemoryBudgetManager } from '../../runtime/memory/MemoryBudgetManager';
import type { AsrModelRunnerAdapter } from '../PersianChunkedAsrWorker';

function makeSpeechAudio(durationSec: number) {
  const sampleRate = 16000;
  const totalSamples = Math.floor(durationSec * sampleRate);
  const pcm = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = 0.25 * Math.sin((2 * Math.PI * 240 * i) / sampleRate);
  }
  return validateAndPreprocessAudioForLab({
    fileName: `speech_${durationSec}s.wav`,
    channelsPcm: [pcm],
    sampleRate,
  });
}

async function createInstalledManager(modelId = 'avapardaz-fa-conformer', version = '1.0.0') {
  const storage = new InMemoryModelChunkStorage();
  const mgr = new LocalModelLifecycleManager(storage);
  await mgr.initialize();
  const bytes = new Uint8Array(8192);
  bytes.fill(7);
  const sha = sha256Bytes(bytes);
  await mgr.installOrUpdateFromStream({
    manifest: {
      modelId,
      modelVersion: version,
      architecture: 'FASTCONFORMER_CTC',
      fileName: `${modelId}.onnx`,
      expectedByteLength: bytes.byteLength,
      expectedSha256Hex: sha,
    },
    stream: (async function* () {
      yield bytes;
    })(),
    license: 'Apache-2.0',
    sourceOrigin: 'local-file',
  });
  return { mgr, sha };
}

function makeFakeModelRunner(params: {
  sha: string;
  wordsPerWindow: (windowStartSec: number) => Array<{ text: string; startSec: number; endSec: number; confidence: number }>;
  delayMs?: number;
  ready?: boolean;
  hasDecoder?: boolean;
}): AsrModelRunnerAdapter {
  let windowIndex = 0;
  return {
    modelId: 'avapardaz-fa-conformer',
    modelVersion: '1.0.0',
    architecture: 'FASTCONFORMER_CTC',
    modelSha256: params.sha,
    isReady: () => params.ready ?? true,
    hasDecoderConfiguration: () => params.hasDecoder ?? true,
    async detectVoiceActivity(pcm16kMono) {
      return { hasSpeech: pcm16kMono.length > 0, speechRatio: pcm16kMono.length > 0 ? 1 : 0 };
    },
    async transcribeWindow(pcm16kMono) {
      if (params.delayMs) {
        await new Promise((r) => setTimeout(r, params.delayMs));
      }
      assert.ok(pcm16kMono.length > 0);
      const windowStartSec = windowIndex++ * 25;
      return params.wordsPerWindow(windowStartSec).map((word) => ({
        word: word.text,
        relativeStartSec: Math.max(0, word.startSec - windowStartSec),
        relativeEndSec: Math.max(0, word.endSec - windowStartSec),
        probability: word.confidence,
      }));
    },
  };
}

describe('AVP-009: LabLocalInferenceAdapter readiness gates, chunked inference & cancellation', () => {
  it('enforces all 7 readiness gates (uninstalled, not ready, identity/architecture/decoder mismatch, worker offline)', async () => {
    const audio = makeSpeechAudio(2);

    // 1. Uninstalled model -> MODEL_NOT_INSTALLED
    const emptyMgr = new LocalModelLifecycleManager(new InMemoryModelChunkStorage(), '1.0.0');
    await emptyMgr.initialize();
    const adapter1 = new LabLocalInferenceAdapter({ modelManager: emptyMgr });
    const res1 = await adapter1.transcribe({
      audio,
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
    });
    assert.equal(res1.status, 'MODEL_NOT_INSTALLED');
    assert.equal(res1.hypothesisProvenance, 'NONE');
    assert.equal(adapter1.descriptor.supportsTranscription, false);
    assert.equal(adapter1.descriptor.supportsStreaming, false);

    // 2. Installed in OPFS (MODEL_AVAILABLE) but no ONNX runtime session -> MODEL_NOT_READY
    const { mgr, sha } = await createInstalledManager();
    const adapter2 = new LabLocalInferenceAdapter({ modelManager: mgr });
    const res2 = await adapter2.transcribe({
      audio,
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
    });
    assert.equal(res2.status, 'MODEL_NOT_READY');

    // 3. Identity mismatch (wrong SHA-256) -> MODEL_NOT_READY
    const runner = makeFakeModelRunner({
      sha: 'a'.repeat(64),
      wordsPerWindow: () => [{ text: 'سلام', startSec: 0.1, endSec: 0.5, confidence: 0.9 }],
    });
    const adapter3 = new LabLocalInferenceAdapter({
      modelManager: mgr,
      getRuntimeBinding: () => ({
        modelId: 'avapardaz-fa-conformer',
        modelVersion: '1.0.0',
        modelSha256: 'a'.repeat(64), // differs from installed sha
        architecture: 'FASTCONFORMER_CTC',
        runner,
        sessionInitialized: true,
        decoderConfigured: true,
      }),
    });
    const res3 = await adapter3.transcribe({
      audio,
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
    });
    assert.equal(res3.status, 'MODEL_NOT_READY');

    // 4. Missing decoder/vocabulary configuration -> MODEL_NOT_READY
    const adapter4 = new LabLocalInferenceAdapter({
      modelManager: mgr,
      getRuntimeBinding: () => ({
        modelId: 'avapardaz-fa-conformer',
        modelVersion: '1.0.0',
        modelSha256: sha,
        architecture: 'FASTCONFORMER_CTC',
        runner: makeFakeModelRunner({
          sha,
          hasDecoder: false,
          wordsPerWindow: () => [{ text: 'سلام', startSec: 0.1, endSec: 0.5, confidence: 0.9 }],
        }),
        sessionInitialized: true,
        decoderConfigured: false,
      }),
    });
    const res4 = await adapter4.transcribe({
      audio,
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
    });
    assert.equal(res4.status, 'MODEL_NOT_READY');

    // 5. Architecture mismatch -> MODEL_NOT_READY
    const adapter5 = new LabLocalInferenceAdapter({
      modelManager: mgr,
      getRuntimeBinding: () => ({
        modelId: 'avapardaz-fa-conformer',
        modelVersion: '1.0.0',
        modelSha256: sha,
        architecture: 'WHISPER_SEQ2SEQ',
        runner: makeFakeModelRunner({
          sha,
          wordsPerWindow: () => [{ text: 'سلام', startSec: 0.1, endSec: 0.5, confidence: 0.9 }],
        }),
        sessionInitialized: true,
        decoderConfigured: true,
      }),
    });
    const res5 = await adapter5.transcribe({
      audio,
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
    });
    assert.equal(res5.status, 'MODEL_NOT_READY');

    // 6. Worker offline -> WORKER_OFFLINE
    const adapter6 = new LabLocalInferenceAdapter({
      modelManager: mgr,
      isWorkerOperational: () => false,
      getRuntimeBinding: () => ({
        modelId: 'avapardaz-fa-conformer',
        modelVersion: '1.0.0',
        modelSha256: sha,
        architecture: 'FASTCONFORMER_CTC',
        runner: makeFakeModelRunner({
          sha,
          wordsPerWindow: () => [{ text: 'سلام', startSec: 0.1, endSec: 0.5, confidence: 0.9 }],
        }),
        sessionInitialized: true,
        decoderConfigured: true,
      }),
    });
    const res6 = await adapter6.transcribe({
      audio,
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
    });
    assert.equal(res6.status, 'WORKER_OFFLINE');
  });

  it('executes chunked multi-window inference, reconciles timestamps/confidences, and rejects synthetic placeholders', async () => {
    const { mgr, sha } = await createInstalledManager();
    const audio30s = makeSpeechAudio(30);
    const budget = new MemoryBudgetManager();

    let windowsSeen = 0;
    const binding: LocalModelRuntimeBinding = {
      modelId: 'avapardaz-fa-conformer',
      modelVersion: '1.0.0',
      modelSha256: sha,
      architecture: 'FASTCONFORMER_CTC',
      sessionInitialized: true,
      decoderConfigured: true,
      runner: makeFakeModelRunner({
        sha,
        wordsPerWindow: (startSec) => {
          windowsSeen++;
          if (startSec < 1) {
            return [
              { text: 'سلام', startSec: 1.0, endSec: 1.5, confidence: 0.91 },
              { text: 'دنیا', startSec: 1.6, endSec: 2.1, confidence: 0.89 },
            ];
          }
          return [
            { text: 'آواپرداز', startSec: startSec + 2.0, endSec: startSec + 2.8, confidence: 0.95 },
          ];
        },
      }),
    };

    const adapter = new LabLocalInferenceAdapter({
      modelManager: mgr,
      memoryBudgetManager: budget,
      getRuntimeBinding: () => binding,
    });

    const out = await adapter.transcribe({
      audio: audio30s,
      config: { expectedLanguage: 'fa-en-mixed', mode: 'batch', keyterms: [] },
    });

    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.hypothesisProvenance, 'MODEL_INFERENCE');
    assert.ok(windowsSeen >= 2, `Expected >=2 windows for 30s audio, saw ${windowsSeen}`);
    assert.equal(out.rawTranscript, 'سلام دنیا آواپرداز');
    assert.ok(out.modelIdentity);
    assert.equal(out.modelIdentity.modelId, 'avapardaz-fa-conformer');
    assert.equal(out.modelIdentity.modelSha256, sha);
    assert.ok((out.words?.length ?? 0) === 3);
    assert.ok(typeof out.meanConfidence === 'number' && out.meanConfidence > 0.85);
    assert.equal(budget.getSnapshot().accountedBytes, 0, 'All PCM window reservations must be released');

    // Synthetic placeholder rejection
    const placeholderAdapter = new LabLocalInferenceAdapter({
      modelManager: mgr,
      getRuntimeBinding: () => ({
        ...binding,
        runner: makeFakeModelRunner({
          sha,
          wordsPerWindow: () => [{ text: 'بخشِ_1', startSec: 0.2, endSec: 0.6, confidence: 0.9 }],
        }),
      }),
    });
    const placeholderOut = await placeholderAdapter.transcribe({
      audio: makeSpeechAudio(2),
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
    });
    assert.equal(placeholderOut.status, 'EMPTY_RESPONSE');
    assert.equal(placeholderOut.hypothesisProvenance, 'NONE');
  });

  it('cancels cleanly via AbortSignal and releases MemoryBudgetManager reservations', async () => {
    const { mgr, sha } = await createInstalledManager();
    const budget = new MemoryBudgetManager();
    let cancelHookCalled = false;

    const adapter = new LabLocalInferenceAdapter({
      modelManager: mgr,
      memoryBudgetManager: budget,
      onCancelled: () => {
        cancelHookCalled = true;
      },
      getRuntimeBinding: () => ({
        modelId: 'avapardaz-fa-conformer',
        modelVersion: '1.0.0',
        modelSha256: sha,
        architecture: 'FASTCONFORMER_CTC',
        sessionInitialized: true,
        decoderConfigured: true,
        runner: makeFakeModelRunner({
          sha,
          delayMs: 250,
          wordsPerWindow: () => [{ text: 'تأخیر', startSec: 0.1, endSec: 0.4, confidence: 0.8 }],
        }),
      }),
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    const out = await adapter.transcribe({
      audio: makeSpeechAudio(2),
      config: { expectedLanguage: 'fa', mode: 'batch', keyterms: [] },
      signal: ac.signal,
    });

    assert.equal(out.status, 'TIMEOUT');
    assert.equal(out.rawTranscript, '');
    assert.equal(cancelHookCalled, true);
    assert.equal(budget.getSnapshot().accountedBytes, 0);
  });
});
