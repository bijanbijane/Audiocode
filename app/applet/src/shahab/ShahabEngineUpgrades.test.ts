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

test('SHAHAB Engine Upgrade: Persian canonical normalizer handles ZWNJ prefixes, suffixes, and compound words correctly', () => {
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
