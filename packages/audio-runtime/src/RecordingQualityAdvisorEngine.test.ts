import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingQualityAdvisorEngine } from './RecordingQualityAdvisorEngine';

test('RecordingQualityAdvisorEngine detects 50Hz Iranian mains hum, plosive pops, and harsh sibilance', () => {
  const sampleRate = 48000 as const;

  // 0.5s Room Tone with 50Hz + 100Hz hum
  const roomTone = new Float32Array(sampleRate * 0.5);
  for (let i = 0; i < roomTone.length; i++) {
    const t = i / sampleRate;
    roomTone[i] =
      0.03 * Math.sin(2 * Math.PI * 50 * t) +
      0.015 * Math.sin(2 * Math.PI * 100 * t) +
      0.002 * Math.sin(2 * Math.PI * 313 * t);
  }

  // 1.0s speech signal: 2x 80ms plosive bursts (75Hz) + 6x 40ms sibilant bursts (6800Hz) + normal 280Hz speech
  const pcm = new Float32Array(sampleRate);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sampleRate;
    if (t >= 0.08 && t < 0.16) {
      pcm[i] = 0.45 * Math.sin(2 * Math.PI * 75 * t); // Plosive pop (<130Hz)
    } else if (t >= 0.30 && t < 0.54) {
      pcm[i] = 0.25 * Math.sin(2 * Math.PI * 6800 * t); // 6 consecutive 40ms harsh sibilance frames (>5kHz)
    } else {
      pcm[i] = 0.15 * Math.sin(2 * Math.PI * 280 * t); // Clean speech vowel
    }
  }

  const report = RecordingQualityAdvisorEngine.analyzeRecordingQuality(
    pcm,
    roomTone,
    sampleRate,
  );

  assert.equal(report.has50HzMainsHum, true);
  assert.ok(report.humFundamentalAndHarmonicsDb.hz50 > -40);
  assert.ok(report.plosivePopEvents.length >= 1);
  assert.ok(report.harshSibilanceEvents.length > 3);

  const nodeIds = new Set(report.recommendedGraphNodes.map((n) => n.id));
  assert.ok(nodeIds.has('auto_notch_50hz_hum'));
  assert.ok(nodeIds.has('auto_plosive_dynamic_hpf'));
  assert.ok(nodeIds.has('auto_persian_de_esser'));
  assert.ok(report.summaryAdviceFa.length >= 3);
});

test('RecordingQualityAdvisorEngine reports clean studio capture with zero unnecessary filters', () => {
  const sampleRate = 48000 as const;
  const roomTone = new Float32Array(sampleRate * 0.5);
  for (let i = 0; i < roomTone.length; i++) {
    // Low -74dB quiet thermal floor with no 50Hz peak
    roomTone[i] = 0.0002 * Math.sin(2 * Math.PI * 190 * (i / sampleRate));
  }

  const pcm = new Float32Array(sampleRate);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sampleRate;
    pcm[i] = 0.18 * Math.sin(2 * Math.PI * 300 * t);
  }

  const report = RecordingQualityAdvisorEngine.analyzeRecordingQuality(
    pcm,
    roomTone,
    sampleRate,
  );

  assert.equal(report.has50HzMainsHum, false);
  assert.equal(report.plosivePopEvents.length, 0);
  assert.equal(report.harshSibilanceEvents.length, 0);
  assert.equal(report.recommendedGraphNodes.length, 0);
  assert.ok(report.signalToNoiseRatioDb > 45);
});
