import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartSplicePreviewEngine } from './SmartSplicePreviewEngine';
import { TimeMath } from '../../../src/contracts/timebase.contract';
import { SmartSpliceDescriptor } from '../../../src/contracts/persian-editing.contract';

test('SmartSplicePreviewEngine builds 3s A/B audition buffers under 10ms and removes filler cleanly in Mode B', () => {
  const sampleRate = 48000 as const;
  const durationSec = 6;
  const fullPcm = new Float32Array(sampleRate * durationSec);

  // Speech body at 220Hz, filler burst at [3.0s, 3.6s) with high amplitude 900Hz tone
  for (let i = 0; i < fullPcm.length; i++) {
    const t = i / sampleRate;
    if (t >= 3.0 && t < 3.6) {
      fullPcm[i] = 0.75 * Math.sin(2 * Math.PI * 900 * t);
    } else {
      fullPcm[i] = 0.25 * Math.sin(2 * Math.PI * 220 * t);
    }
  }

  const roomTone = new Float32Array(sampleRate * 0.5).fill(0.001);
  const descriptor: SmartSpliceDescriptor = {
    rawAiRange: {
      start: TimeMath.secondsToFlicks(3.0),
      end: TimeMath.secondsToFlicks(3.6),
    },
    snappedAcousticRange: {
      start: TimeMath.secondsToFlicks(3.0),
      end: TimeMath.secondsToFlicks(3.6),
    },
    fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
    fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
    injectRoomToneFlicks: TimeMath.secondsToFlicks(0.04), // 40ms Room Tone pad
    cutStrategy: 'GLOBAL_SYNC_RIPPLE',
    prosodicWarnings: [],
    confidence: 0.95,
  };

  const modeA = SmartSplicePreviewEngine.buildPreviewAuditionSession({
    mode: 'BEFORE_ORIGINAL',
    fullTrackMonoPcm: fullPcm,
    roomToneBuffer: roomTone,
    spliceDescriptor: descriptor,
    sampleRate,
  });

  const modeB = SmartSplicePreviewEngine.buildPreviewAuditionSession({
    mode: 'AFTER_SPLICED',
    fullTrackMonoPcm: fullPcm,
    roomToneBuffer: roomTone,
    spliceDescriptor: descriptor,
    sampleRate,
  });

  // Mode A: 1.5s + 0.6s filler + 1.5s = 3.6s
  assert.ok(Math.abs(modeA.durationMs - 3600) < 5, `Unexpected Mode A duration: ${modeA.durationMs}`);
  // Mode B: ~3.03s (removed 600ms filler, inserted 40ms room tone minus 10ms overlap crossfade)
  assert.ok(modeB.durationMs < 3100 && modeB.durationMs > 2950, `Unexpected Mode B duration: ${modeB.durationMs}`);

  // Mode A still contains high peak amplitude (0.75) from filler; Mode B peak stays <= ~0.26
  const peakA = modeA.pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const peakB = modeB.pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peakA > 0.7);
  assert.ok(peakB < 0.3, `Expected spliced preview to remove filler burst, got peak=${peakB}`);
  assert.ok(modeB.buildTimeMs < 50);
});

test('SmartSplicePreviewEngine feeds hidden Pre-Roll to stateful DSP chain and trims prefix cleanly', () => {
  const sampleRate = 48000 as const;
  const fullPcm = new Float32Array(sampleRate * 5).fill(0.5);
  const preRollSamples = 2400; // 50ms hidden pre-roll

  let observedInputLength = 0;
  // Stateful IIR smoother: needs warmed state so sample 0 of output has already converged to ~0.5
  const statefulDsp = (buf: Float32Array): Float32Array => {
    observedInputLength = buf.length;
    const out = new Float32Array(buf.length);
    let y = 0;
    const alpha = 0.05;
    for (let i = 0; i < buf.length; i++) {
      y = y + alpha * (buf[i] - y);
      out[i] = y;
    }
    return out;
  };

  const descriptor: SmartSpliceDescriptor = {
    rawAiRange: { start: TimeMath.secondsToFlicks(2.0), end: TimeMath.secondsToFlicks(2.4) },
    snappedAcousticRange: { start: TimeMath.secondsToFlicks(2.0), end: TimeMath.secondsToFlicks(2.4) },
    fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
    fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
    injectRoomToneFlicks: 0,
    cutStrategy: 'GLOBAL_SYNC_RIPPLE',
    prosodicWarnings: [],
    confidence: 0.92,
  };

  const res = SmartSplicePreviewEngine.buildPreviewAuditionSession({
    mode: 'AFTER_SPLICED',
    fullTrackMonoPcm: fullPcm,
    roomToneBuffer: new Float32Array(0), // verify safe empty-room-tone guard
    spliceDescriptor: descriptor,
    sampleRate,
    contextPaddingMs: 1000,
    dspPreRollSamples: preRollSamples,
    runDspChainWithPreRoll: statefulDsp,
  });

  assert.equal(res.actualPreRollFedSamples, preRollSamples);
  assert.equal(observedInputLength, res.pcm.length + preRollSamples);
  // First emitted sample is already converged (~0.5), NOT 0.025 cold-start step
  assert.ok(Math.abs(res.pcm[0] - 0.5) < 1e-4, `Pre-roll failed to warm stateful DSP: ${res.pcm[0]}`);
});
