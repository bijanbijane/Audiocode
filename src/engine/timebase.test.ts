import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLICKS_PER_SECOND,
  flicksPerSample,
  samplesToFlicks,
  flicksToSamples,
  mapSampleBetweenRates,
  rangesOverlap,
  formatTimecode,
  secondsToFlicks,
} from './timebase';

test('FLICKS_PER_SECOND divides all standard audio rates cleanly', () => {
  const rates = [16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 96_000];
  for (const rate of rates) {
    assert.equal(FLICKS_PER_SECOND % rate, 0, `Rate ${rate} must divide FLICKS_PER_SECOND`);
    assert.equal(Number.isInteger(flicksPerSample(rate)), true);
  }
});

test('Zero cumulative drift across 2-hour 44.1kHz <-> 16kHz <-> 48kHz conversions', () => {
  const twoHoursSeconds = 7200;
  const samples44100 = twoHoursSeconds * 44_100; // 317,520,000 samples
  const flicks = samplesToFlicks(samples44100, 44_100);
  assert.equal(flicks, twoHoursSeconds * FLICKS_PER_SECOND);

  const mapped16k = mapSampleBetweenRates(samples44100, 44_100, 16_000);
  assert.equal(mapped16k, twoHoursSeconds * 16_000);

  const mapped48k = mapSampleBetweenRates(mapped16k, 16_000, 48_000);
  assert.equal(mapped48k, twoHoursSeconds * 48_000);

  // Round-trip accuracy at sample level
  const exactSample = 123_456_789;
  const f = samplesToFlicks(exactSample, 44_100);
  assert.equal(flicksToSamples(f, 44_100), exactSample);
});

test('Half-open intervals [start, end) touching at boundary do not overlap', () => {
  const a = { startFlicks: secondsToFlicks(1), endFlicks: secondsToFlicks(2) };
  const b = { startFlicks: secondsToFlicks(2), endFlicks: secondsToFlicks(3) };
  assert.equal(rangesOverlap(a, b), false);

  const c = { startFlicks: secondsToFlicks(1.5), endFlicks: secondsToFlicks(2.5) };
  assert.equal(rangesOverlap(a, c), true);
});

test('formatTimecode renders tabular MM:SS.mmm and HH:MM:SS.mmm', () => {
  assert.equal(formatTimecode(secondsToFlicks(12.345)), '00:12.345');
  assert.equal(formatTimecode(secondsToFlicks(3661.05)), '01:01:01.050');
});
