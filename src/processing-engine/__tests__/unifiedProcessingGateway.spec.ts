import { describe, expect, it } from 'vitest';
import {
  CORE_SAMPLE_RATE,
  synthesizeAcousticSpeechFromText,
} from '../../asr-core/CoreAcousticCtcEngine';
import { encodeFloat32ToContainerWithFfmpeg } from '../../asr-core/CoreAudioIngestion';
import {
  CloudExecutionAdapter,
  DeterministicMockCloudTransport,
  ExecutionModePreferenceStore,
  LocalExecutionAdapter,
  UNIFIED_PROCESSING_CONFIG_VERSION,
  UNIFIED_PROCESSING_CONTRACT_VERSION,
  UnifiedProcessingError,
  UnifiedProcessingOrchestrator,
  uint8ArrayToTransportSafeAudioInput,
  validateUnifiedProcessingResultEnvelope,
} from '../index';

describe('Unified Processing Gateway & Local/Cloud Parity (Vitest)', () => {
  it('enforces LOCAL default, explicit CLOUD opt-in, canonical envelope parity, and zero silent fallback', async () => {
    const speech = synthesizeAcousticSpeechFromText('سلام امروز بررسی');
    const wav = encodeFloat32ToContainerWithFfmpeg(speech, 'wav', CORE_SAMPLE_RATE);
    const audio = uint8ArrayToTransportSafeAudioInput({
      bytes: new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength),
      encoding: 'BASE64_CONTAINER',
      metadata: {
        filename: 'parity_probe.wav',
        mimeType: 'audio/wav',
        containerFormat: 'wav',
        sampleRateHz: CORE_SAMPLE_RATE,
        channelCount: 1,
        durationSecEstimate: speech.length / CORE_SAMPLE_RATE,
        sha256Hex: null,
      },
    });

    const pref = new ExecutionModePreferenceStore({ storage: null });
    expect(pref.getPreferredMode()).toBe('LOCAL');
    expect(() => pref.setPreferredMode('CLOUD')).toThrow(/explicit/i);

    const mockTransport = new DeterministicMockCloudTransport({
      kind: 'SUCCESS',
      rawText: 'سلام امروز بررسی',
    });
    const orch = new UnifiedProcessingOrchestrator({
      preferenceStore: pref,
      localAdapter: new LocalExecutionAdapter(),
      cloudAdapter: new CloudExecutionAdapter({
        config: {
          providerId: 'vitest-mock-cloud',
          displayName: 'Vitest Mock Cloud',
          endpointUrl: 'https://mock-cloud.invalid/v1',
          configured: true,
        },
        transport: mockTransport,
      }),
    });

    const localRes = await orch.execute({
      contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
      jobId: 'vitest_local_1',
      recordingId: 'rec_vitest_1',
      executionMode: 'LOCAL',
      processingMode: 'batch',
      audio,
      languageHint: 'fa',
      config: {
        configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
        normalizationProfile: 'FA-STRICT-V1',
      },
      requestedCapabilities: ['RAW_TRANSCRIPT', 'NORMALIZED_VARIANTS', 'SEGMENT_TIMESTAMPS'],
      cancellationId: 'c_local_1',
    });

    const cloudRes = await orch.execute({
      contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
      jobId: 'vitest_cloud_1',
      recordingId: 'rec_vitest_1',
      executionMode: 'CLOUD',
      processingMode: 'batch',
      audio,
      languageHint: 'fa',
      config: {
        configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
        normalizationProfile: 'FA-STRICT-V1',
      },
      requestedCapabilities: ['RAW_TRANSCRIPT', 'NORMALIZED_VARIANTS', 'SEGMENT_TIMESTAMPS'],
      cancellationId: 'c_cloud_1',
    });

    expect(validateUnifiedProcessingResultEnvelope(localRes, 'vitest_local_1', 'LOCAL')).toBe(true);
    expect(validateUnifiedProcessingResultEnvelope(cloudRes, 'vitest_cloud_1', 'CLOUD')).toBe(true);
    expect(Object.keys(localRes).sort()).toEqual(Object.keys(cloudRes).sort());
    expect(localRes.provenance.fallbackUsed).toBe(false);
    expect(cloudRes.provenance.fallbackUsed).toBe(false);

    // Unconfigured cloud orchestrator must fail explicitly without touching local
    const unconfOrch = new UnifiedProcessingOrchestrator();
    await expect(
      unconfOrch.execute({
        contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
        jobId: 'vitest_cloud_fail',
        recordingId: 'rec_vitest_1',
        executionMode: 'CLOUD',
        processingMode: 'batch',
        audio,
        languageHint: 'fa',
        config: {
          configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
          normalizationProfile: 'FA-STRICT-V1',
        },
        requestedCapabilities: ['RAW_TRANSCRIPT'],
        cancellationId: 'c_fail',
      }),
    ).rejects.toMatchObject({
      code: 'CLOUD_PROVIDER_UNAVAILABLE',
      executionMode: 'CLOUD',
    } satisfies Partial<UnifiedProcessingError>);
  });
});
