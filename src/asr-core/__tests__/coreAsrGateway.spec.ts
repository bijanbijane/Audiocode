import { describe, expect, it } from 'vitest';
import { CoreModelRouter } from '../CoreModelRouter';
import { CORE_SAMPLE_RATE, synthesizeAcousticSpeechFromText } from '../CoreAcousticCtcEngine';
import { encodeFloat32ToContainerWithFfmpeg } from '../CoreAudioIngestion';

describe('Core ASR Router & Warmup Integration', () => {
  it('warms up CPU engine, logs grounded fallback when unavailable backend requested, and transcribes real WAV/FLAC', () => {
    const router = new CoreModelRouter();
    const warm = router.warmup();
    expect(warm.warmedUp).toBe(true);
    expect(warm.warmupLatencyMs).toBeGreaterThanOrEqual(0);
    expect(warm.peakRssMb).toBeGreaterThan(0);

    const routeDecision = router.routeInference({
      mode: 'batch',
      preferredBackend: 'EXTERNAL_ONNX_RUNTIME',
      languageHint: 'fa-en',
    });
    expect(routeDecision.fallbackTriggered).toBe(true);
    expect(routeDecision.selectedBackend).toBe('LOCAL_CPU_ACOUSTIC_CTC_ADAPTER');
    expect(routeDecision.fallbackReason).toContain('not mounted');

    const speech = synthesizeAcousticSpeechFromText('امروز benchmark سرویس');
    const flacBytes = encodeFloat32ToContainerWithFfmpeg(speech, 'flac', CORE_SAMPLE_RATE);
    const out = router.batchEngine.transcribeAudioBytes({
      filename: 'integration_probe.flac',
      rawBytes: flacBytes,
      languageHint: 'fa-en',
    });

    expect(out.status).toBe('COMPLETED');
    expect(out.confidenceStatus).toBe('UNAVAILABLE_UNCALIBRATED');
    expect(out.calibratedConfidence).toBeNull();
    expect(out.normalizedByProfile.RAW_UNMODIFIED).toBe(out.rawModelOutput);
    expect(router.getHealthAndProfile().recentRoutingCount).toBe(1);
  });
});
