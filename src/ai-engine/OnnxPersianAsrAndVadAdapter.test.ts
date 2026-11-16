import test from 'node:test';
import assert from 'node:assert/strict';
import { OnnxPersianAsrAndVadAdapter } from './OnnxPersianAsrAndVadAdapter';

test('Section 62: OnnxPersianAsrAndVadAdapter computes 80-Channel Log-Mel Spectrogram accurately and runs VAD', async () => {
  const adapter = new OnnxPersianAsrAndVadAdapter();
  const sr = 16000;
  const pcm1k = new Float32Array(sr);
  for (let i = 0; i < sr; i++) {
    pcm1k[i] = 0.25 * Math.sin((2 * Math.PI * 1000 * i) / sr);
  }

  const vadSpeech = await adapter.detectVoiceActivity(pcm1k);
  assert.equal(vadSpeech.hasSpeech, true);
  assert.ok(vadSpeech.speechRatio > 0.8);

  const vadSilence = await adapter.detectVoiceActivity(new Float32Array(sr));
  assert.equal(vadSilence.hasSpeech, false);
  assert.equal(vadSilence.speechRatio, 0);

  const { melTensor, numFrames, nMels } = adapter.computeLogMelSpectrogram(pcm1k);
  assert.equal(nMels, 80);
  // 1 + Math.floor((16000 - 400) / 160) = 98
  assert.equal(numFrames, 98);
  assert.equal(melTensor.length, 98 * 80);

  // Verify spectral energy concentrates around ~1000Hz Mel band (~band 31-36) vs 60Hz (~band 2)
  const midFrameOffset = 40 * nMels;
  let peakMelBand = 0;
  let peakVal = -Infinity;
  for (let m = 0; m < nMels; m++) {
    const v = melTensor[midFrameOffset + m];
    assert.ok(Number.isFinite(v));
    if (v > peakVal) {
      peakVal = v;
      peakMelBand = m;
    }
  }
  assert.ok(peakMelBand >= 25 && peakMelBand <= 42, `Expected 1kHz peak band in [25..42], got ${peakMelBand}`);
  assert.ok(peakVal > melTensor[midFrameOffset + 2] + 0.5);
});

test('Section 62: greedyDecodeCtcToWords collapses repeated CTC frames and spaces cleanly', () => {
  const vocab = new Map<number, string>([
    [1, 'س'],
    [2, 'ل'],
    [3, 'ا'],
    [4, 'م'],
    [5, ' '],
    [6, 'م'],
    [7, 'ن'],
  ]);

  const seq = [0, 1, 1, 2, 0, 3, 4, 5, 6, 0, 7, 0];
  const frameProbs = seq.map((tok) => {
    const arr = new Float32Array(8).fill(0.01);
    arr[tok] = 0.92;
    return arr;
  });

  const words = OnnxPersianAsrAndVadAdapter.greedyDecodeCtcToWords(frameProbs, vocab, 0.02);
  assert.equal(words.length, 2);
  assert.equal(words[0].word, 'سلام');
  assert.equal(words[1].word, 'من');
  assert.ok(words[0].relativeStartSec < words[0].relativeEndSec);
});
