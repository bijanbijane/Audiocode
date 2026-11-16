import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LodWaveformCanvasRenderer,
  WaveformLodBuffer,
} from './LodWaveformCanvasRenderer';
import { TimeMath } from '../../contracts/timebase.contract';

test('LodWaveformCanvasRenderer selects appropriate LOD resolution based on viewport zoom', () => {
  const lods: WaveformLodBuffer[] = [
    { samplesPerPeak: 64, interleavedMinMaxInt8: new Int8Array(100) },
    { samplesPerPeak: 256, interleavedMinMaxInt8: new Int8Array(100) },
    { samplesPerPeak: 1024, interleavedMinMaxInt8: new Int8Array(100) },
    { samplesPerPeak: 4096, interleavedMinMaxInt8: new Int8Array(100) },
  ];

  // Zoomed in: 1 second across 1000px @ 48kHz => 48 samples/px => selects finest LOD (64)
  const zoomedIn = LodWaveformCanvasRenderer.selectBestLod(
    lods,
    { start: 0, end: TimeMath.secondsToFlicks(1) },
    1000,
    48000,
  );
  assert.equal(zoomedIn.samplesPerPeak, 64);

  // Zoomed out: 2 hours (7200s) across 1000px @ 48kHz => 345,600 samples/px => selects 4096
  const zoomedOut = LodWaveformCanvasRenderer.selectBestLod(
    lods,
    { start: 0, end: TimeMath.secondsToFlicks(7200) },
    1000,
    48000,
  );
  assert.equal(zoomedOut.samplesPerPeak, 4096);
});

test('LodWaveformCanvasRenderer renders viewport peaks, suggestion highlights, and playhead cleanly', () => {
  const calls: string[] = [];
  const fakeCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    clearRect: () => calls.push('clearRect'),
    fillRect: () => calls.push('fillRect'),
    beginPath: () => calls.push('beginPath'),
    rect: () => calls.push('rect'),
    fill: () => calls.push('fill'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    stroke: () => calls.push('stroke'),
  } as unknown as CanvasRenderingContext2D;

  const peaks = new Int8Array(200); // 100 peaks
  for (let i = 0; i < 100; i++) {
    peaks[i * 2] = -64;
    peaks[i * 2 + 1] = 64;
  }

  LodWaveformCanvasRenderer.renderViewport(
    fakeCtx,
    800,
    120,
    { samplesPerPeak: 256, interleavedMinMaxInt8: peaks },
    { start: 0, end: TimeMath.secondsToFlicks(0.5) },
    TimeMath.secondsToFlicks(0.25),
    48000,
    [
      {
        rawAiRange: { start: TimeMath.secondsToFlicks(0.1), end: TimeMath.secondsToFlicks(0.2) },
        snappedAcousticRange: {
          start: TimeMath.secondsToFlicks(0.1),
          end: TimeMath.secondsToFlicks(0.2),
        },
        fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
        fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
        injectRoomToneFlicks: 0,
        cutStrategy: 'GLOBAL_SYNC_RIPPLE',
        prosodicWarnings: ['TRAILING_EZAFE_RISK'],
        confidence: 0.9,
      },
    ],
  );

  assert.equal(calls.includes('clearRect'), true);
  assert.equal(calls.includes('fillRect'), true); // suggestion highlight
  assert.equal(calls.includes('rect'), true); // waveform bars
  assert.equal(calls.includes('stroke'), true); // playhead line
});
