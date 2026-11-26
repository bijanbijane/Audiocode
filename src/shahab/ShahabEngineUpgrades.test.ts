import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCoreAcousticSpeechSegments } from './core/ShahabCoreVad';
import { normalizeCanonicalPersianUtterance } from './core/ShahabCorePersianNormalizer';
import { PersianPostAsrSpellingAndCompoundRestorer } from '../ai-engine/asr/PersianPostAsrSpellingAndCompoundRestorer';

test('SHAHAB Engine Upgrade: Acoustic VAD detects speech segments and skips silence cleanly', () => {
  const sampleRate = 16000;
  const pcm = new Float32Array(sampleRate * 3);
  for (let i = sampleRate; i < sampleRate * 2; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 400 * i) / sampleRate) * 0.2;
  }
  const vad = detectCoreAcousticSpeechSegments(pcm);
  assert.equal(vad.hasSpeech, true);
  assert.ok(vad.segments.length >= 1);
  assert.ok(vad.segments[0].startSec >= 0);
  assert.ok(vad.segments[0].endSec <= 3.0);
});

test('SHAHAB Engine Upgrade: Persian canonical normalizer handles ZWNJ prefixes and suffixes correctly', () => {
  const raw1 = 'می خواهم کتاب ها را مطالعه کنم';
  const norm1 = normalizeCanonicalPersianUtterance(raw1);
  assert.equal(norm1, 'می‌خواهم کتاب‌ها را مطالعه کنم');

  const raw2 = 'میوه های تازه در نرم افزار موجود است';
  const norm2 = normalizeCanonicalPersianUtterance(raw2);
  assert.equal(norm2, 'میوه‌های تازه در نرم‌افزار موجود است');
});

test('SHAHAB Engine Upgrade: Persian Post-ASR compound restorer successfully joins split bigrams and bilingual terms', () => {
  const restorer = new PersianPostAsrSpellingAndCompoundRestorer();
  const tokens = [
    { tokenId: '1', trackId: 't1', originalText: 'نرم', normalizedText: 'نرم', displayText: 'نرم', range: { start: 0, end: 100 }, confidence: 0.95 },
    { tokenId: '2', trackId: 't1', originalText: 'افزار', normalizedText: 'افزار', displayText: 'افزار', range: { start: 120, end: 250 }, confidence: 0.95 },
  ];
  const restored = restorer.restoreCompoundsAndBilingualTerms(tokens, 180);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].normalizedText, 'نرم‌افزار');
});

test('SHAHAB VAD honors minSpeechDurationMs and keeps one configured pre/post-roll', () => {
  const sampleRate = 16000;
  const shortSpeech = new Float32Array(sampleRate);
  for (let i = 4000; i < 5200; i++) shortSpeech[i] = Math.sin((2 * Math.PI * 400 * i) / sampleRate) * 0.2;

  const rejected = detectCoreAcousticSpeechSegments(shortSpeech, { minSpeechDurationMs: 150 });
  assert.equal(rejected.hasSpeech, false);

  const accepted = detectCoreAcousticSpeechSegments(shortSpeech, {
    minSpeechDurationMs: 50,
    hangoverMs: 100,
  });
  assert.equal(accepted.hasSpeech, true);
  assert.equal(accepted.segments.length, 1);
  assert.ok(accepted.segments[0].startSample >= 2000 && accepted.segments[0].startSample <= 2200);
  assert.ok(accepted.segments[0].endSample >= 6800 && accepted.segments[0].endSample <= 7200);
});

test('SHAHAB VAD splits long continuous speech at the configured maximum chunk duration with overlap', () => {
  const sampleRate = 16000;
  const pcm = new Float32Array(sampleRate * 35);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 400 * i) / sampleRate) * 0.2;

  const vad = detectCoreAcousticSpeechSegments(pcm, { maxChunkSec: 10, hangoverMs: 200 });
  assert.equal(vad.hasSpeech, true);
  assert.ok(vad.segments.length >= 4);
  for (const segment of vad.segments) {
    assert.ok(segment.endSample > segment.startSample);
    assert.ok(segment.endSec - segment.startSec <= 10.001);
  }
  for (let i = 1; i < vad.segments.length; i++) {
    assert.ok(vad.segments[i].startSample < vad.segments[i - 1].endSample, 'adjacent ASR chunks must overlap');
  }
});

test('SHAHAB VAD rejects invalid frame, hop, and duration configuration instead of allocating invalid buffers', () => {
  const pcm = new Float32Array(16000);
  assert.throws(() => detectCoreAcousticSpeechSegments(pcm, { frameMs: 0 }), RangeError);
  assert.throws(() => detectCoreAcousticSpeechSegments(pcm, { hopMs: 0 }), RangeError);
  assert.throws(() => detectCoreAcousticSpeechSegments(pcm, { hopMs: 30, frameMs: 25 }), RangeError);
  assert.throws(() => detectCoreAcousticSpeechSegments(pcm, { maxChunkSec: Number.NaN }), RangeError);
});

test('SHAHAB VAD handles sub-frame clips and non-finite samples without crashing', () => {
  const pcm = new Float32Array(320);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 400 * i) / 16000) * 0.2;
  pcm[12] = Number.NaN;
  pcm[13] = Number.POSITIVE_INFINITY;
  const vad = detectCoreAcousticSpeechSegments(pcm, { minSpeechDurationMs: 0, hangoverMs: 0 });
  assert.equal(vad.hasSpeech, true);
  assert.ok(vad.segments[0].endSample <= pcm.length);
});
