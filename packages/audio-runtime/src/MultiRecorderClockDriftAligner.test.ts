import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MultiRecorderClockDriftAligner } from './MultiRecorderClockDriftAligner';

describe('MultiRecorderClockDriftAligner (Section 80)', () => {
  it('estimates initial offset and clock drift across two anchors and sample-locks via Catmull-Rom cubic resampling', () => {
    const sr = 16000 as const;
    const durationSec = 9;
    const len = sr * durationSec;
    const ref = new Float32Array(len);
    const sec = new Float32Array(len);

    // Broadband envelope-modulated speech-like signal
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.max(0, Math.sin(t * 5.3) + 0.5 * Math.cos(t * 11.7));
      ref[i] = env * 0.4 * Math.sin(2 * Math.PI * 220 * t);
    }

    // Secondary track starts +1600 samples (+100ms) shifted and has +2500 ppm drift
    const offsetSamples = 1600;
    const stretch = 1.0025;
    for (let i = 0; i < len; i++) {
      const srcIdx = Math.round((i - offsetSamples) / stretch);
      if (srcIdx >= 0 && srcIdx < len) {
        sec[i] = ref[srcIdx];
      }
    }

    const report = MultiRecorderClockDriftAligner.estimateOffsetAndClockDrift(
      ref,
      sec,
      sr,
      1.0,
    );

    assert.ok(report.alignmentConfidence > 0.7);
    assert.ok(Math.abs(report.initialOffsetSamples - offsetSamples) <= 240);

    const corrected = MultiRecorderClockDriftAligner.applyDriftAndOffsetCorrection(
      sec,
      len,
      report,
    );
    assert.equal(corrected.length, len);

    const postReport = MultiRecorderClockDriftAligner.estimateOffsetAndClockDrift(
      ref,
      corrected,
      sr,
      1.0,
    );
    assert.ok(Math.abs(postReport.initialOffsetSamples) <= 160);
  });
});
