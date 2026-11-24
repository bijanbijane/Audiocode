import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatNumberForLocale,
  formatStudioTimecode,
  mapExportDefaultFormatToRenderConfig,
  sanitizeExportFileName,
  toPersianDigits,
} from './formatters.ts';

test('toPersianDigits converts ASCII digits while leaving punctuation and Persian text intact', () => {
  assert.equal(toPersianDigits('01:23.45'), '۰۱:۲۳.۴۵');
  assert.equal(toPersianDigits('اپیزود 42 - 2026'), 'اپیزود ۴۲ - ۲۰۲۶');
});

test('formatNumberForLocale formats digits cleanly based on persianDigits flag', () => {
  assert.equal(formatNumberForLocale(42, { persianDigits: false }), '42');
  assert.equal(formatNumberForLocale(42, { persianDigits: true }), '۴۲');
  assert.equal(
    formatNumberForLocale(1.256, { persianDigits: true, maximumFractionDigits: 2 }),
    '۱.۲۶',
  );
});

test('formatStudioTimecode supports mm:ss.ms, hh:mm:ss, and persianDigits', () => {
  assert.equal(formatStudioTimecode(65.32, 'mm:ss.ms', false), '01:05.32');
  assert.equal(formatStudioTimecode(65.32, 'mm:ss.ms', true), '۰۱:۰۵.۳۲');
  assert.equal(formatStudioTimecode(3665.5, 'hh:mm:ss', false), '01:01:05');
  assert.equal(formatStudioTimecode(3665.5, 'hh:mm:ss', true), '۰۱:۰۱:۰۵');
  assert.equal(formatStudioTimecode(-5, 'mm:ss.ms', false), '00:00.00');
});

test('sanitizeExportFileName preserves Persian words and applies prefix safely', () => {
  assert.equal(
    sanitizeExportFileName('اپیزود ۴۲ — مصاحبه: ویژه/تست'),
    'اپیزود ۴۲ — مصاحبه ویژهتست',
  );
  assert.equal(sanitizeExportFileName('پادکست', 'EP01-'), 'EP01-پادکست');
  assert.equal(sanitizeExportFileName('   ', ''), 'avapardaz-export');
});

test('mapExportDefaultFormatToRenderConfig maps RF64_PCM24 and all WAV presets accurately', () => {
  assert.deepEqual(mapExportDefaultFormatToRenderConfig('WAV_PCM16'), {
    encoding: 'pcm16',
    container: 'wav',
  });
  assert.deepEqual(mapExportDefaultFormatToRenderConfig('WAV_PCM24'), {
    encoding: 'pcm24',
    container: 'wav',
  });
  assert.deepEqual(mapExportDefaultFormatToRenderConfig('WAV_FLOAT32'), {
    encoding: 'float32',
    container: 'wav',
  });
  assert.deepEqual(mapExportDefaultFormatToRenderConfig('RF64_PCM24'), {
    encoding: 'pcm24',
    container: 'rf64',
  });
});
