import test from 'node:test';
import assert from 'node:assert/strict';
import { detectContentDirection, detectContentLang, hasRtlCharacters } from './bidi.ts';

test('hasRtlCharacters detects Persian/Arabic script and rejects pure ASCII', () => {
  assert.equal(hasRtlCharacters('سلام دنیا'), true);
  assert.equal(hasRtlCharacters('API و تحلیل گفتار'), true);
  assert.equal(hasRtlCharacters('deterministic-speech-fixture.wav'), false);
  assert.equal(hasRtlCharacters(''), false);
});

test('detectContentDirection preserves RTL on Persian turns even with leading English acronyms', () => {
  assert.equal(detectContentDirection('سلام به همه مخاطبان پادکست آواپرداز', 'ltr'), 'rtl');
  assert.equal(detectContentDirection('API در محیط لوکال بدون نیاز به اینترنت اجرا می‌شود', 'ltr'), 'rtl');
  assert.equal(detectContentDirection('Gemini ASR در وضعیت ابری', 'rtl'), 'rtl');
});

test('detectContentDirection selects LTR for filenames and pure English titles', () => {
  assert.equal(detectContentDirection('deterministic-speech-fixture.wav', 'rtl'), 'ltr');
  assert.equal(detectContentDirection('Podcast Episode 42 Audio', 'rtl'), 'ltr');
  assert.equal(detectContentDirection('123456', 'rtl'), 'rtl');
});

test('detectContentLang tags Persian-containing spans with fa', () => {
  assert.equal(detectContentLang('نوار صوتی فارسی'), 'fa');
  assert.equal(detectContentLang('audio_sample.wav'), undefined);
});
