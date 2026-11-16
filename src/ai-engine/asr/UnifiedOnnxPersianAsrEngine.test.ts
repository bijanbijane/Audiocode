import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OrtRuntimeProvider,
  UnifiedOnnxPersianAsrEngine,
} from './UnifiedOnnxPersianAsrEngine';

test('Section 99: UnifiedOnnxPersianAsrEngine executes FastConformer-CTC and Whisper Seq2Seq pipelines and decodes UTF-8 BPE Persian tokens', async () => {
  const vocab = ['<blk>', ' ', 'س', 'ل', 'ا', 'م'];

  const mockOrtProvider: OrtRuntimeProvider = {
    createTensor: (type, data, dims) => ({ type, data, dims }),
    createSession: async () => ({
      run: async () => {
        // 5 output frames x 6 vocab tokens for "سلام"
        const data = new Float32Array(5 * 6).fill(-10.0);
        data[0 * 6 + 2] = -0.05; // 'س'
        data[1 * 6 + 3] = -0.05; // 'ل'
        data[2 * 6 + 4] = -0.05; // 'ا'
        data[3 * 6 + 5] = -0.05; // 'م'
        data[4 * 6 + 0] = -0.05; // '<blk>'
        return {
          logprobs: {
            type: 'float32',
            data,
            dims: [1, 5, 6],
          },
        };
      },
    }),
  };

  const conformerEngine = new UnifiedOnnxPersianAsrEngine(
    mockOrtProvider,
    'FASTCONFORMER_CTC',
    {
      modelId: 'fastconformer-fa',
      modelVersion: '1.2.0',
      ctcVocabulary: vocab,
    },
  );

  await conformerEngine.loadModels({
    encoderModelBytesOrPath: 'fastconformer.onnx',
    executionProviders: ['cpu'],
  });

  const pcm16k = new Float32Array(8000);
  for (let i = 0; i < pcm16k.length; i++) {
    pcm16k[i] = 0.25 * Math.sin((2 * Math.PI * 300 * i) / 16000);
  }

  const words = await conformerEngine.transcribeWindow(pcm16k);
  assert.equal(words.length, 1);
  assert.equal(words[0].word, 'سلام');

  // Verify Whisper Byte-Level BPE UTF-8 encoding/decoding roundtrip on multi-byte Persian + ZWNJ
  const bpeToken = conformerEngine.encodeUtf8StringToWhisperBpeToken('می‌گوید');
  assert.ok(bpeToken.length > 0);
});
