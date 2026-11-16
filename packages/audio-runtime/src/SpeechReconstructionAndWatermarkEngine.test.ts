import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechReconstructionAndWatermarkEngine } from './SpeechReconstructionAndWatermarkEngine';

function synthesizeMultiBandSpeech(
  sampleCount: number,
  sr: 48000,
  amps: { low150: number; mid550: number; pres2200: number; air6000: number },
): Float32Array {
  const buf = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    buf[i] =
      amps.low150 * Math.sin((2 * Math.PI * 150 * i) / sr) +
      amps.mid550 * Math.sin((2 * Math.PI * 550 * i) / sr) +
      amps.pres2200 * Math.sin((2 * Math.PI * 2200 * i) / sr) +
      amps.air6000 * Math.sin((2 * Math.PI * 6000 * i) / sr);
  }
  return buf;
}

test('Section 60: matchPunchInClipToStudioContext aligns 4-band spectral EQ toward reference voice and mixes studio room tone', () => {
  const sr = 48000 as const;
  const studioRef = synthesizeMultiBandSpeech(24000, sr, {
    low150: 0.25,
    mid550: 0.2,
    pres2200: 0.16,
    air6000: 0.08,
  });

  // Thin/distant punch-in clip with weak low body & excessive sharp 6kHz hiss
  const punchClip = synthesizeMultiBandSpeech(24000, sr, {
    low150: 0.08,
    mid550: 0.18,
    pres2200: 0.14,
    air6000: 0.18,
  });

  const roomTone = new Float32Array(4800);
  for (let i = 0; i < roomTone.length; i++) {
    roomTone[i] = 0.002 * Math.sin(i * 0.37);
  }

  const { matchedClipPcm, appliedBandGainsDb } =
    SpeechReconstructionAndWatermarkEngine.matchPunchInClipToStudioContext(
      studioRef,
      punchClip,
      roomTone,
      sr,
    );

  assert.equal(matchedClipPcm.length, punchClip.length);
  // Low body should be boosted (+dB), air sibilance attenuated (-dB)
  assert.ok(appliedBandGainsDb[0] > 2.0, `Expected low boost, got ${appliedBandGainsDb[0]}`);
  assert.ok(appliedBandGainsDb[3] < -2.0, `Expected air cut, got ${appliedBandGainsDb[3]}`);

  const refProf = SpeechReconstructionAndWatermarkEngine.analyzeFourBandProfile(studioRef, sr);
  const punchBefore = SpeechReconstructionAndWatermarkEngine.analyzeFourBandProfile(punchClip, sr);
  const punchAfter = SpeechReconstructionAndWatermarkEngine.analyzeFourBandProfile(
    matchedClipPcm,
    sr,
  );

  assert.ok(
    Math.abs(punchAfter.lowBodyRms - refProf.lowBodyRms) <
      Math.abs(punchBefore.lowBodyRms - refProf.lowBodyRms),
  );
  assert.ok(
    Math.abs(punchAfter.airSibilanceRms - refProf.airSibilanceRms) <
      Math.abs(punchBefore.airSibilanceRms - refProf.airSibilanceRms),
  );
});

test('Section 60: embedSyntheticProvenanceWatermarkInPlace & matched filter detect Group-C watermark cleanly', () => {
  const sr = 48000 as const;
  const cleanSpeech = synthesizeMultiBandSpeech(48000, sr, {
    low150: 0.25,
    mid550: 0.18,
    pres2200: 0.1,
    air6000: 0.04,
  });

  const beforeDetect = SpeechReconstructionAndWatermarkEngine.detectSyntheticProvenanceWatermark(
    cleanSpeech,
    sr,
  );
  assert.equal(beforeDetect.isWatermarked, false);
  assert.ok(beforeDetect.correlationConfidence < 0.15);

  const watermarked = new Float32Array(cleanSpeech);
  SpeechReconstructionAndWatermarkEngine.embedSyntheticProvenanceWatermarkInPlace(watermarked, sr);

  // Verify watermark is inaudible (-66 dBFS -> max sample delta < 0.001)
  let maxDelta = 0;
  for (let i = 0; i < cleanSpeech.length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs(watermarked[i] - cleanSpeech[i]));
  }
  assert.ok(maxDelta > 0 && maxDelta < 0.001);

  const afterDetect = SpeechReconstructionAndWatermarkEngine.detectSyntheticProvenanceWatermark(
    watermarked,
    sr,
  );
  assert.equal(afterDetect.isWatermarked, true);
  assert.ok(afterDetect.correlationConfidence >= 0.85);

  // Wrong provenance seed must NOT trigger false positive
  const wrongSeed = SpeechReconstructionAndWatermarkEngine.detectSyntheticProvenanceWatermark(
    watermarked,
    sr,
    0x12345678,
  );
  assert.equal(wrongSeed.isWatermarked, false);
});
