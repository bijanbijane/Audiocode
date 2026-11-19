import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportValidator } from './ExportValidator';
import { SampleRate } from '../contracts/timebase.contract';

function buildCleanSineBuffer(frameCount: number, sampleRate: number, amp = 0.5): Float32Array {
  const buf = new Float32Array(frameCount);
  const fadeSamples = Math.min(480, Math.floor(frameCount / 4));
  for (let i = 0; i < frameCount; i++) {
    let env = 1;
    if (fadeSamples > 0 && i < fadeSamples) {
      env = i / fadeSamples;
    } else if (fadeSamples > 0 && i > frameCount - 1 - fadeSamples) {
      env = (frameCount - 1 - i) / fadeSamples;
    }
    buf[i] = amp * env * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return buf;
}

test('ExportValidator passes valid mono and stereo faded PCM matching expected duration', () => {
  const sr: SampleRate = 48000;
  const mono = buildCleanSineBuffer(sr, sr, 0.5);
  const monoSnapshot = Float32Array.from(mono);

  const monoReport = ExportValidator.validateRenderedPcm([mono], sr, 1.0);
  assert.equal(monoReport.passed, true);
  assert.equal(monoReport.structurallyValid, true);
  assert.equal(monoReport.channelCount, 1);
  assert.equal(monoReport.frameCount, sr);
  assert.equal(monoReport.clippedSamplesCount, 0);
  assert.equal(monoReport.invalidSamplesCount, 0);
  assert.equal(monoReport.hasStartOrEndClickRisk, false);
  assert.equal(monoReport.errors.length, 0);
  // Confirm validator never mutates input PCM
  assert.deepEqual(mono, monoSnapshot);

  const left = buildCleanSineBuffer(sr, sr, 0.45);
  const right = buildCleanSineBuffer(sr, sr, 0.6);
  const stereoReport = ExportValidator.validateRenderedPcm([left, right], sr, 1.0);
  assert.equal(stereoReport.passed, true);
  assert.equal(stereoReport.structurallyValid, true);
  assert.equal(stereoReport.channelCount, 2);
  assert.equal(stereoReport.frameCount, sr);
  assert.equal(stereoReport.invalidSamplesCount, 0);
  assert.equal(stereoReport.clippedSamplesCount, 0);
  assert.equal(stereoReport.errors.length, 0);
});

test('ExportValidator passes valid silent buffer and buffer with exact zero boundary samples', () => {
  const sr: SampleRate = 48000;
  const silent = new Float32Array(sr); // all zeros
  const silentReport = ExportValidator.validateRenderedPcm([silent], sr, 1.0);
  assert.equal(silentReport.passed, true);
  assert.equal(silentReport.structurallyValid, true);
  assert.equal(silentReport.clippedSamplesCount, 0);
  assert.equal(silentReport.invalidSamplesCount, 0);
  assert.equal(silentReport.hasStartOrEndClickRisk, false);
  assert.ok(silentReport.maxSamplePeakDb < -200);

  const zeroBoundary = new Float32Array(sr);
  zeroBoundary.fill(0.4);
  zeroBoundary[0] = 0;
  zeroBoundary[sr - 1] = 0;
  const zeroBoundaryReport = ExportValidator.validateRenderedPcm([zeroBoundary], sr, 1.0);
  assert.equal(zeroBoundaryReport.passed, true);
  assert.equal(zeroBoundaryReport.hasStartOrEndClickRisk, false);
  assert.equal(zeroBoundaryReport.errors.length, 0);
});

test('ExportValidator flags clipping, duration mismatch, and boundary click risk', () => {
  const sr: SampleRate = 48000;
  const buf = new Float32Array(sr / 2); // 0.5s vs 1.0s expected
  buf.fill(1.0); // Clipping + high amplitude at start/end boundaries

  const report = ExportValidator.validateRenderedPcm([buf], sr, 1.0);
  assert.equal(report.passed, false);
  assert.equal(report.structurallyValid, true);
  assert.equal(report.clippedSamplesCount, sr / 2);
  assert.equal(report.invalidSamplesCount, 0);
  assert.equal(report.hasStartOrEndClickRisk, true);
  assert.ok(report.errors.some((e) => e.includes('EXPORT_DURATION_MISMATCH')));
  assert.ok(report.errors.some((e) => e.includes('EXPORT_CLIPPING_DETECTED')));
  assert.ok(report.errors.some((e) => e.includes('EXPORT_BOUNDARY_CLICK_RISK')));
});

test('ExportValidator rejects empty channel arrays, empty individual channels, and non-Float32Array channels', () => {
  const sr: SampleRate = 48000;

  const emptyArrayReport = ExportValidator.validateRenderedPcm([], sr, 1.0);
  assert.equal(emptyArrayReport.passed, false);
  assert.equal(emptyArrayReport.structurallyValid, false);
  assert.ok(emptyArrayReport.errors.some((e) => e.includes('EXPORT_EMPTY_BUFFER')));

  const emptySingleChannel = ExportValidator.validateRenderedPcm([new Float32Array(0)], sr, 0);
  assert.equal(emptySingleChannel.passed, false);
  assert.equal(emptySingleChannel.structurallyValid, false);
  assert.ok(emptySingleChannel.errors.some((e) => e.includes('EXPORT_EMPTY_BUFFER')));

  const emptySecondChannel = ExportValidator.validateRenderedPcm(
    [buildCleanSineBuffer(sr, sr), new Float32Array(0)],
    sr,
    1.0,
  );
  assert.equal(emptySecondChannel.passed, false);
  assert.equal(emptySecondChannel.structurallyValid, false);
  assert.ok(emptySecondChannel.errors.some((e) => e.includes('EXPORT_EMPTY_BUFFER')));
  assert.ok(emptySecondChannel.errors.some((e) => e.includes('EXPORT_CHANNEL_LENGTH_MISMATCH')));

  const invalidArrayArg = ExportValidator.validateRenderedPcm(
    null as unknown as Float32Array[],
    sr,
    1.0,
  );
  assert.equal(invalidArrayArg.passed, false);
  assert.equal(invalidArrayArg.structurallyValid, false);
  assert.ok(invalidArrayArg.errors.some((e) => e.includes('EXPORT_INVALID_CHANNEL_ARRAY')));

  const invalidChannelType = ExportValidator.validateRenderedPcm(
    [[0, 0, 0] as unknown as Float32Array],
    sr,
    1.0,
  );
  assert.equal(invalidChannelType.passed, false);
  assert.equal(invalidChannelType.structurallyValid, false);
  assert.ok(invalidChannelType.errors.some((e) => e.includes('EXPORT_INVALID_CHANNEL_TYPE')));
});

test('ExportValidator rejects unequal channel lengths in both directions without ignoring any channel', () => {
  const sr: SampleRate = 48000;
  const full = buildCleanSineBuffer(sr, sr);
  const shorter = buildCleanSineBuffer(sr - 10, sr);
  const longer = buildCleanSineBuffer(sr + 10, sr);

  const shorterSecond = ExportValidator.validateRenderedPcm([full, shorter], sr, 1.0);
  assert.equal(shorterSecond.passed, false);
  assert.equal(shorterSecond.structurallyValid, false);
  assert.ok(shorterSecond.errors.some((e) => e.includes('EXPORT_CHANNEL_LENGTH_MISMATCH')));

  const longerSecond = ExportValidator.validateRenderedPcm([shorter, longer], sr, 1.0);
  assert.equal(longerSecond.passed, false);
  assert.equal(longerSecond.structurallyValid, false);
  assert.ok(longerSecond.errors.some((e) => e.includes('EXPORT_CHANNEL_LENGTH_MISMATCH')));
});

test('ExportValidator detects NaN in first, middle, and final positions plus +Infinity and -Infinity', () => {
  const sr: SampleRate = 48000;

  for (const pos of [0, Math.floor(sr / 2), sr - 1]) {
    const buf = buildCleanSineBuffer(sr, sr, 0.4);
    buf[pos] = Number.NaN;
    const report = ExportValidator.validateRenderedPcm([buf], sr, 1.0);
    assert.equal(report.passed, false);
    assert.equal(report.invalidSamplesCount, 1);
    assert.equal(report.clippedSamplesCount, 0);
    assert.ok(Number.isFinite(report.maxSamplePeakDb));
    assert.ok(report.errors.some((e) => e.includes('EXPORT_INVALID_SAMPLE_VALUES')));
  }

  const infBuf = buildCleanSineBuffer(sr, sr, 0.3);
  infBuf[10] = Number.POSITIVE_INFINITY;
  infBuf[20] = Number.NEGATIVE_INFINITY;
  const infReport = ExportValidator.validateRenderedPcm([infBuf], sr, 1.0);
  assert.equal(infReport.passed, false);
  assert.equal(infReport.invalidSamplesCount, 2);
  assert.equal(infReport.clippedSamplesCount, 0);
  assert.ok(Number.isFinite(infReport.maxSamplePeakDb));
  assert.ok(infReport.errors.some((e) => e.includes('EXPORT_INVALID_SAMPLE_VALUES')));

  // Buffer containing ONLY NaN samples must not report passed or NaN peak dB
  const allNan = new Float32Array(100);
  allNan.fill(Number.NaN);
  const allNanReport = ExportValidator.validateRenderedPcm([allNan], sr, 100 / sr);
  assert.equal(allNanReport.passed, false);
  assert.equal(allNanReport.invalidSamplesCount, 100);
  assert.equal(allNanReport.clippedSamplesCount, 0);
  assert.equal(allNanReport.maxSamplePeakDb, -Infinity);
});

test('ExportValidator rejects invalid sample rates and invalid expected durations deterministically', () => {
  const sr: SampleRate = 48000;
  const validBuf = buildCleanSineBuffer(sr, sr);

  for (const badRate of [0, -48000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const report = ExportValidator.validateRenderedPcm([validBuf], badRate as SampleRate, 1.0);
    assert.equal(report.passed, false);
    assert.equal(report.structurallyValid, false);
    assert.ok(report.errors.some((e) => e.includes('EXPORT_INVALID_SAMPLE_RATE')));
  }

  for (const badDuration of [-0.001, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const report = ExportValidator.validateRenderedPcm([validBuf], sr, badDuration);
    assert.equal(report.passed, false);
    assert.equal(report.structurallyValid, false);
    assert.ok(report.errors.some((e) => e.includes('EXPORT_INVALID_EXPECTED_DURATION')));
  }
});

test('ExportValidator enforces exact duration tolerance boundary (<= 0.002s passes, > 0.002s fails)', () => {
  const sr: SampleRate = 48000;
  const buf = buildCleanSineBuffer(sr, sr); // exact 1.0000s

  const belowTol = ExportValidator.validateRenderedPcm([buf], sr, 1.0019);
  assert.equal(belowTol.passed, true);
  assert.equal(belowTol.errors.length, 0);

  const aboveTol = ExportValidator.validateRenderedPcm([buf], sr, 1.0021);
  assert.equal(aboveTol.passed, false);
  assert.ok(aboveTol.errors.some((e) => e.includes('EXPORT_DURATION_MISMATCH')));

  const belowNegTol = ExportValidator.validateRenderedPcm([buf], sr, 0.9981);
  assert.equal(belowNegTol.passed, true);

  const aboveNegTol = ExportValidator.validateRenderedPcm([buf], sr, 0.9979);
  assert.equal(aboveNegTol.passed, false);
  assert.ok(aboveNegTol.errors.some((e) => e.includes('EXPORT_DURATION_MISMATCH')));
});

test('ExportValidator counts clipping and invalid samples separately across multiple channels', () => {
  const sr: SampleRate = 48000;
  const ch0 = buildCleanSineBuffer(sr, sr, 0.4);
  const ch1 = buildCleanSineBuffer(sr, sr, 0.4);

  ch0[100] = 1.0; // clipped
  ch0[101] = -0.99995; // clipped
  ch0[102] = Number.NaN; // invalid (not clipped)

  ch1[200] = Number.POSITIVE_INFINITY; // invalid (not clipped)
  ch1[201] = Number.NEGATIVE_INFINITY; // invalid (not clipped)
  ch1[202] = 0.99995; // clipped (IEEE-754 Float32-safe >= 0.9999)

  const report = ExportValidator.validateRenderedPcm([ch0, ch1], sr, 1.0);
  assert.equal(report.passed, false);
  assert.equal(report.structurallyValid, true);
  assert.equal(report.clippedSamplesCount, 3);
  assert.equal(report.invalidSamplesCount, 3);
  assert.ok(Number.isFinite(report.maxSamplePeakDb));
  assert.ok(report.errors.some((e) => e.includes('EXPORT_CLIPPING_DETECTED')));
  assert.ok(report.errors.some((e) => e.includes('EXPORT_INVALID_SAMPLE_VALUES')));
});
