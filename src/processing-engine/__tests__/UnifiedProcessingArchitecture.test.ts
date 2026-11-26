import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_SAMPLE_RATE,
  synthesizeAcousticSpeechFromText,
} from '../../asr-core/CoreAcousticCtcEngine';
import {
  float32ToPcm16Buffer,
} from '../../asr-core/CoreAudioIngestion';
function encodeDeterministicWav(pcm: Float32Array, sampleRate: number): Buffer {
  const data = float32ToPcm16Buffer(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
}

import { CoreModelRouter } from '../../asr-core/CoreModelRouter';
import { MemoryBudgetManager } from '../../runtime/memory/MemoryBudgetManager';
import {
  CloudExecutionAdapter,
  DeterministicMockCloudTransport,
  ExecutionModePreferenceStore,
  LocalExecutionAdapter,
  UNIFIED_PROCESSING_CONFIG_VERSION,
  UNIFIED_PROCESSING_CONTRACT_VERSION,
  UnifiedProcessingError,
  UnifiedProcessingOrchestrator,
  UnifiedProcessingRequest,
  containsNonSerializableRuntimeObject,
  uint8ArrayToTransportSafeAudioInput,
  validateUnifiedProcessingRequest,
  validateUnifiedProcessingResultEnvelope,
} from '../index';

function buildDeterministicWavRequest(overrides?: Partial<UnifiedProcessingRequest>): UnifiedProcessingRequest {
  const speech = synthesizeAcousticSpeechFromText('سلام امروز api بررسی');
  const wavBuf = encodeDeterministicWav(speech, CORE_SAMPLE_RATE);
  const audio = uint8ArrayToTransportSafeAudioInput({
    bytes: new Uint8Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength),
    encoding: 'BASE64_CONTAINER',
    metadata: {
      filename: 'unified_sample.wav',
      mimeType: 'audio/wav',
      containerFormat: 'wav',
      sampleRateHz: CORE_SAMPLE_RATE,
      channelCount: 1,
      durationSecEstimate: speech.length / CORE_SAMPLE_RATE,
      sha256Hex: null,
    },
  });

  return {
    contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
    jobId: 'job_unified_001',
    recordingId: 'rec_unified_001',
    processingMode: 'batch',
    audio,
    languageHint: 'fa-en',
    config: {
      configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
      normalizationProfile: 'MIXED-NORM-V1',
    },
    requestedCapabilities: ['RAW_TRANSCRIPT', 'NORMALIZED_VARIANTS', 'SEGMENT_TIMESTAMPS'],
    cancellationId: 'cancel_001',
    ...overrides,
  };
}

// ============================================================================
// 1. SHARED CONTRACT TESTS
// ============================================================================

test('Shared Contract: valid request serializes cleanly with zero runtime-specific objects', () => {
  const req = buildDeterministicWavRequest();
  assert.equal(containsNonSerializableRuntimeObject(req), false);
  validateUnifiedProcessingRequest(req, 'LOCAL');

  const roundTripped = JSON.parse(JSON.stringify(req)) as UnifiedProcessingRequest;
  assert.equal(roundTripped.contractVersion, UNIFIED_PROCESSING_CONTRACT_VERSION);
  assert.equal(roundTripped.audio.encoding, 'BASE64_CONTAINER');
  validateUnifiedProcessingRequest(roundTripped, 'LOCAL');
});

test('Shared Contract: rejects Buffer, TypedArray, unsupported version, and empty audio', () => {
  const validReq = buildDeterministicWavRequest();

  // Reject Node Buffer embedded in request payload
  const reqWithBuffer = {
    ...validReq,
    extra: Buffer.from([1, 2, 3]),
  } as unknown as UnifiedProcessingRequest;
  assert.equal(containsNonSerializableRuntimeObject(reqWithBuffer), true);
  assert.throws(
    () => validateUnifiedProcessingRequest(reqWithBuffer, 'LOCAL'),
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'INVALID_PROCESSING_REQUEST',
  );

  // Reject Uint8Array in public wire payload
  const reqWithTypedArray = {
    ...validReq,
    extra: new Uint8Array([1, 2, 3]),
  } as unknown as UnifiedProcessingRequest;
  assert.equal(containsNonSerializableRuntimeObject(reqWithTypedArray), true);

  // Reject incompatible contract version
  const badVersionReq = {
    ...validReq,
    contractVersion: '2.9.9',
  } as unknown as UnifiedProcessingRequest;
  assert.throws(
    () => validateUnifiedProcessingRequest(badVersionReq, 'LOCAL'),
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'INVALID_PROCESSING_REQUEST',
  );

  // Reject 0-byte audio
  const emptyAudioReq: UnifiedProcessingRequest = {
    ...validReq,
    audio: {
      ...validReq.audio,
      metadata: {
        ...validReq.audio.metadata,
        byteLength: 0,
      },
    },
  };
  assert.throws(
    () => validateUnifiedProcessingRequest(emptyAudioReq, 'LOCAL'),
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'UNSUPPORTED_AUDIO_FORMAT',
  );
});

// ============================================================================
// 2. LOCAL EXECUTION TESTS
// ============================================================================

test('Local Execution: LOCAL is default, discovers granular capabilities, and produces canonical envelope', async () => {
  const mem = new MemoryBudgetManager();
  const localAdapter = new LocalExecutionAdapter({ memoryBudgetManager: mem });
  const orchestrator = new UnifiedProcessingOrchestrator({ localAdapter });

  assert.equal(orchestrator.preferenceStore.getPreferredMode(), 'LOCAL');

  const caps = await orchestrator.discoverCapabilities();
  assert.equal(caps.selectedPreferredMode, 'LOCAL');
  assert.equal(caps.explicitCloudOptInConfirmed, false);
  assert.ok(caps.localCapabilities.length >= 2);
  assert.ok(
    caps.localCapabilities.some(
      (c) => c.providerId === 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER' && c.availability === 'AVAILABLE_NOW',
    ),
  );
  assert.ok(
    caps.localCapabilities.some(
      (c) => c.providerId === 'EXTERNAL_ONNX_RUNTIME' && c.availability === 'MISSING_MODEL_WEIGHTS',
    ),
  );
  assert.equal(caps.cloudCapabilities[0].availability, 'INSTALLED_NOT_CONFIGURED');

  const req = buildDeterministicWavRequest({ jobId: 'job_local_batch_1' });
  const result = await orchestrator.execute(req);

  assert.equal(validateUnifiedProcessingResultEnvelope(result, req.jobId, 'LOCAL'), true);
  assert.equal(containsNonSerializableRuntimeObject(result), false);
  assert.equal(result.executionMode, 'LOCAL');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.normalizedByProfile.RAW_UNMODIFIED, result.rawModelOutput);
  assert.equal(result.confidenceStatus, 'UNAVAILABLE_UNCALIBRATED');
  assert.equal(result.calibratedConfidence, null);
  assert.equal(result.provenance.actualAdapterId, 'avapardaz-local-adapter-v1');
  assert.equal(result.provenance.isGenuineNeuralModel, false);
  assert.equal(result.provenance.fallbackUsed, false);
  assert.equal(result.resourceUsage.measurementKind, 'MEASURED');
  // Temporary memory reservation must be released after completion
  assert.equal(mem.getSnapshot().accountedBytes, 0);
});

test('Local Execution: fails closed when requireNeuralWeights is true or runtime unavailable', async () => {
  const orchestrator = new UnifiedProcessingOrchestrator();
  const req = buildDeterministicWavRequest({
    jobId: 'job_local_require_neural',
    executionMode: 'LOCAL',
    config: {
      configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
      normalizationProfile: 'FA-STRICT-V1',
      requireNeuralWeights: true,
    },
  });

  await assert.rejects(
    () => orchestrator.execute(req),
    (err: unknown) =>
      err instanceof UnifiedProcessingError &&
      err.code === 'LOCAL_RUNTIME_UNAVAILABLE' &&
      err.executionMode === 'LOCAL',
  );

  // Runtime unavailable simulation
  const unavailableLocal = new LocalExecutionAdapter({ simulateRuntimeUnavailable: true });
  const unavailableOrch = new UnifiedProcessingOrchestrator({ localAdapter: unavailableLocal });
  const unavailableCaps = await unavailableLocal.discoverCapabilities();
  assert.equal(unavailableCaps[0].availability, 'MISSING_REQUIRED_RUNTIME');

  await assert.rejects(
    () => unavailableOrch.execute(buildDeterministicWavRequest({ jobId: 'job_local_unavail' })),
    (err: unknown) =>
      err instanceof UnifiedProcessingError && err.code === 'LOCAL_RUNTIME_UNAVAILABLE',
  );
});

test('Local Execution: cancellation aborts promptly and releases memory reservations', async () => {
  const mem = new MemoryBudgetManager();
  const localAdapter = new LocalExecutionAdapter({ memoryBudgetManager: mem });
  const orchestrator = new UnifiedProcessingOrchestrator({ localAdapter });
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    () =>
      orchestrator.execute(
        buildDeterministicWavRequest({ jobId: 'job_local_cancel', executionMode: 'LOCAL' }),
        ac.signal,
      ),
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'PROCESSING_CANCELLED',
  );
  assert.equal(mem.getSnapshot().accountedBytes, 0);
});

test('Local Execution: supports streaming mode through existing CoreStreamingAsrManager', async () => {
  const speech = synthesizeAcousticSpeechFromText('سلام بررسی');
  const pcmBuf = float32ToPcm16Buffer(speech);
  const req = buildDeterministicWavRequest({
    jobId: 'job_local_stream_1',
    processingMode: 'streaming',
    executionMode: 'LOCAL',
    audio: uint8ArrayToTransportSafeAudioInput({
      bytes: new Uint8Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength),
      encoding: 'BASE64_PCM16_16K_MONO',
      metadata: {
        filename: 'stream.pcm',
        mimeType: 'audio/pcm',
        containerFormat: 'pcm16',
        sampleRateHz: CORE_SAMPLE_RATE,
        channelCount: 1,
        durationSecEstimate: speech.length / CORE_SAMPLE_RATE,
        sha256Hex: null,
      },
    }),
  });

  const orchestrator = new UnifiedProcessingOrchestrator();
  const result = await orchestrator.execute(req);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.processingMode, 'streaming');
  assert.equal(result.executionMode, 'LOCAL');
  assert.equal(result.provenance.fallbackUsed, false);
});

test('Local Execution: enforces memory resource limit', async () => {
  const orchestrator = new UnifiedProcessingOrchestrator();
  const req = buildDeterministicWavRequest({
    jobId: 'job_local_mem_limit',
    executionMode: 'LOCAL',
    constraints: { maxMemoryBytes: 1024 }, // smaller than minimum working set
  });
  await assert.rejects(
    () => orchestrator.execute(req),
    (err: unknown) =>
      err instanceof UnifiedProcessingError && err.code === 'PROCESSING_RESOURCE_LIMIT_EXCEEDED',
  );
});

// ============================================================================
// 3. CLOUD EXECUTION TESTS (DETERMINISTIC MOCK TRANSPORT — NO LIVE CLOUD)
// ============================================================================

test('Cloud Execution: explicit selection with deterministic mock transport succeeds and preserves provenance', async () => {
  const mockTransport = new DeterministicMockCloudTransport({
    kind: 'SUCCESS',
    rawText: 'سلام امروز api بررسی',
  });
  const cloudAdapter = new CloudExecutionAdapter({
    config: {
      providerId: 'mock-cloud-provider',
      displayName: 'Deterministic Mock Cloud Provider',
      endpointUrl: 'https://mock-cloud.invalid/v1/process',
      configured: true,
      maxRetries: 1,
    },
    transport: mockTransport,
  });

  const orchestrator = new UnifiedProcessingOrchestrator({ cloudAdapter });
  const req = buildDeterministicWavRequest({
    jobId: 'job_cloud_ok_1',
    executionMode: 'CLOUD',
    constraints: { idempotencyKey: 'idem_cloud_1' },
  });

  const result = await orchestrator.execute(req);
  assert.equal(validateUnifiedProcessingResultEnvelope(result, req.jobId, 'CLOUD'), true);
  assert.equal(result.executionMode, 'CLOUD');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.provenance.actualAdapterId, 'avapardaz-cloud-adapter-v1');
  assert.equal(result.provenance.providerId, 'mock-cloud-provider');
  assert.equal(result.provenance.fallbackUsed, false);
  assert.equal(result.normalizedByProfile.RAW_UNMODIFIED, result.rawModelOutput);
  assert.equal(mockTransport.receivedRequests.length, 1);
  assert.equal(mockTransport.receivedRequests[0].idempotencyKey, 'idem_cloud_1');
});

test('Cloud Execution: distinguishes unavailable, auth failure, timeout, rate limit, malformed response, cancellation, and ZERO hidden Local fallback', async () => {
  let localExecuteCalls = 0;
  const spyLocal = new LocalExecutionAdapter();
  const origLocalExec = spyLocal.execute.bind(spyLocal);
  spyLocal.execute = async (req, sig) => {
    localExecuteCalls++;
    return origLocalExec(req, sig);
  };

  // A. Unconfigured Cloud provider -> CLOUD_PROVIDER_UNAVAILABLE
  const unconfiguredOrch = new UnifiedProcessingOrchestrator({ localAdapter: spyLocal });
  await assert.rejects(
    () =>
      unconfiguredOrch.execute(
        buildDeterministicWavRequest({ jobId: 'job_c_unconf', executionMode: 'CLOUD' }),
      ),
    (err: unknown) =>
      err instanceof UnifiedProcessingError &&
      err.code === 'CLOUD_PROVIDER_UNAVAILABLE' &&
      err.executionMode === 'CLOUD',
  );
  assert.equal(localExecuteCalls, 0, 'Cloud failure must NEVER silently fall back to Local');

  // B. 401 Auth failure -> PROVIDER_AUTHENTICATION_FAILED (non-retryable)
  const authTransport = new DeterministicMockCloudTransport({ kind: 'HTTP_ERROR', status: 401 });
  const authOrch = new UnifiedProcessingOrchestrator({
    localAdapter: spyLocal,
    cloudAdapter: new CloudExecutionAdapter({
      config: {
        providerId: 'mock-auth',
        displayName: 'Mock Auth',
        endpointUrl: 'https://mock.invalid/v1',
        configured: true,
        maxRetries: 2,
      },
      transport: authTransport,
      backoffBaseMs: 1,
    }),
  });
  await assert.rejects(
    () =>
      authOrch.execute(buildDeterministicWavRequest({ jobId: 'job_c_401', executionMode: 'CLOUD' })),
    (err: unknown) =>
      err instanceof UnifiedProcessingError && err.code === 'PROVIDER_AUTHENTICATION_FAILED',
  );
  assert.equal(authTransport.receivedRequests.length, 1, '401 must not retry');
  assert.equal(localExecuteCalls, 0);

  // C. 429 Rate limit -> bounded retries then PROVIDER_RATE_LIMITED
  const rateTransport = new DeterministicMockCloudTransport({ kind: 'HTTP_ERROR', status: 429 });
  const rateOrch = new UnifiedProcessingOrchestrator({
    localAdapter: spyLocal,
    cloudAdapter: new CloudExecutionAdapter({
      config: {
        providerId: 'mock-rate',
        displayName: 'Mock Rate',
        endpointUrl: 'https://mock.invalid/v1',
        configured: true,
        maxRetries: 2,
      },
      transport: rateTransport,
      backoffBaseMs: 1,
    }),
  });
  await assert.rejects(
    () =>
      rateOrch.execute(buildDeterministicWavRequest({ jobId: 'job_c_429', executionMode: 'CLOUD' })),
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'PROVIDER_RATE_LIMITED',
  );
  assert.equal(rateTransport.receivedRequests.length, 3, 'Initial attempt + 2 bounded retries');
  assert.equal(localExecuteCalls, 0);

  // D. Transient 503 then success -> retries once and succeeds with retryCount = 1
  const retrySuccessTransport = new DeterministicMockCloudTransport({
    kind: 'TRANSIENT_THEN_SUCCESS',
    failCount: 1,
    failStatus: 503,
    rawText: 'تست بازیابی ابری',
  });
  const retryOrch = new UnifiedProcessingOrchestrator({
    localAdapter: spyLocal,
    cloudAdapter: new CloudExecutionAdapter({
      config: {
        providerId: 'mock-retry',
        displayName: 'Mock Retry',
        endpointUrl: 'https://mock.invalid/v1',
        configured: true,
        maxRetries: 2,
      },
      transport: retrySuccessTransport,
      backoffBaseMs: 1,
    }),
  });
  const retryRes = await retryOrch.execute(
    buildDeterministicWavRequest({ jobId: 'job_c_retry_ok', executionMode: 'CLOUD' }),
  );
  assert.equal(retryRes.status, 'COMPLETED');
  assert.equal(retryRes.provenance.retryCount, 1);
  assert.equal(retryRes.provenance.fallbackUsed, false);

  // E. Timeout -> PROVIDER_TIMEOUT
  const timeoutTransport = new DeterministicMockCloudTransport({ kind: 'TIMEOUT', delayMs: 200 });
  const timeoutOrch = new UnifiedProcessingOrchestrator({
    localAdapter: spyLocal,
    cloudAdapter: new CloudExecutionAdapter({
      config: {
        providerId: 'mock-timeout',
        displayName: 'Mock Timeout',
        endpointUrl: 'https://mock.invalid/v1',
        configured: true,
        maxRetries: 0,
      },
      transport: timeoutTransport,
    }),
  });
  await assert.rejects(
    () =>
      timeoutOrch.execute(
        buildDeterministicWavRequest({
          jobId: 'job_c_timeout',
          executionMode: 'CLOUD',
          constraints: { timeoutMs: 20, maxRetries: 0 },
        }),
      ),
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'PROVIDER_TIMEOUT',
  );
  assert.equal(localExecuteCalls, 0);

  // F. Malformed remote response -> PROVIDER_INVALID_RESPONSE
  const malformedTransport = new DeterministicMockCloudTransport({
    kind: 'MALFORMED_RESPONSE',
    body: { ok: true, transcript: 'wrong schema' },
  });
  const malformedOrch = new UnifiedProcessingOrchestrator({
    localAdapter: spyLocal,
    cloudAdapter: new CloudExecutionAdapter({
      config: {
        providerId: 'mock-bad',
        displayName: 'Mock Bad',
        endpointUrl: 'https://mock.invalid/v1',
        configured: true,
        maxRetries: 0,
      },
      transport: malformedTransport,
    }),
  });
  await assert.rejects(
    () =>
      malformedOrch.execute(
        buildDeterministicWavRequest({ jobId: 'job_c_bad', executionMode: 'CLOUD' }),
      ),
    (err: unknown) =>
      err instanceof UnifiedProcessingError && err.code === 'PROVIDER_INVALID_RESPONSE',
  );
  assert.equal(localExecuteCalls, 0);

  // G. Cancellation during Cloud request -> PROCESSING_CANCELLED
  const slowTransport = new DeterministicMockCloudTransport({
    kind: 'SUCCESS',
    rawText: 'کند',
    delayMs: 300,
  });
  const cancelOrch = new UnifiedProcessingOrchestrator({
    localAdapter: spyLocal,
    cloudAdapter: new CloudExecutionAdapter({
      config: {
        providerId: 'mock-slow',
        displayName: 'Mock Slow',
        endpointUrl: 'https://mock.invalid/v1',
        configured: true,
        maxRetries: 0,
      },
      transport: slowTransport,
    }),
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 15);
  await assert.rejects(
    () =>
      cancelOrch.execute(
        buildDeterministicWavRequest({ jobId: 'job_c_cancel', executionMode: 'CLOUD' }),
        ac.signal,
      ),
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'PROCESSING_CANCELLED',
  );
  assert.equal(localExecuteCalls, 0);
});

// ============================================================================
// 4. ORCHESTRATION, MODE SWITCHING & CONCURRENCY ISOLATION TESTS
// ============================================================================

test('Orchestration: both adapters produce identical canonical schema, switching mode affects NEW jobs only, and concurrent jobs stay isolated', async () => {
  const storageMap = new Map<string, string>();
  const prefStore = new ExecutionModePreferenceStore({
    storage: {
      getItem: (k) => storageMap.get(k) ?? null,
      setItem: (k, v) => {
        storageMap.set(k, v);
      },
    },
  });

  // Cannot enable CLOUD without explicitCloudOptIn: true
  assert.throws(() => prefStore.setPreferredMode('CLOUD'));
  assert.equal(prefStore.getPreferredMode(), 'LOCAL');

  const cloudTransport = new DeterministicMockCloudTransport({
    kind: 'SUCCESS',
    rawText: 'سلام امروز api بررسی',
    delayMs: 35,
  });
  const cloudAdapter = new CloudExecutionAdapter({
    config: {
      providerId: 'mock-cloud-concurrent',
      displayName: 'Mock Concurrent Cloud',
      endpointUrl: 'https://mock.invalid/v1',
      configured: true,
    },
    transport: cloudTransport,
  });

  const orchestrator = new UnifiedProcessingOrchestrator({
    preferenceStore: prefStore,
    cloudAdapter,
  });

  // Switch explicitly to CLOUD and start job A (which takes 35ms)
  prefStore.setPreferredMode('CLOUD', { explicitCloudOptIn: true });
  const reqA = buildDeterministicWavRequest({ jobId: 'job_conc_A', executionMode: undefined });
  const promiseA = orchestrator.execute(reqA);

  // Immediately switch preferred mode back to LOCAL while job A is still in flight
  prefStore.setPreferredMode('LOCAL');
  const reqB = buildDeterministicWavRequest({ jobId: 'job_conc_B', executionMode: undefined });
  const promiseB = orchestrator.execute(reqB);

  const [resA, resB] = await Promise.all([promiseA, promiseB]);

  // Job A must retain CLOUD mode & provenance; Job B must execute in LOCAL mode
  assert.equal(resA.executionMode, 'CLOUD');
  assert.equal(resA.provenance.selectedExecutionMode, 'CLOUD');
  assert.equal(resA.provenance.actualAdapterId, 'avapardaz-cloud-adapter-v1');

  assert.equal(resB.executionMode, 'LOCAL');
  assert.equal(resB.provenance.selectedExecutionMode, 'LOCAL');
  assert.equal(resB.provenance.actualAdapterId, 'avapardaz-local-adapter-v1');

  // Identical top-level canonical envelope keys across LOCAL and CLOUD
  assert.deepEqual(Object.keys(resA).sort(), Object.keys(resB).sort());
  assert.equal(resA.contractVersion, resB.contractVersion);
  assert.equal(resA.normalizedByProfile.RAW_UNMODIFIED, resA.rawModelOutput);
  assert.equal(resB.normalizedByProfile.RAW_UNMODIFIED, resB.rawModelOutput);

  // Sanitized execution trace must NEVER contain raw audio or transcript text
  const trace = orchestrator.getExecutionTrace(10);
  assert.equal(trace.length, 2);
  const traceJson = JSON.stringify(trace);
  assert.equal(traceJson.includes('سلام'), false, 'Trace must not leak transcript text');
  assert.equal(traceJson.includes('payloadBase64'), false, 'Trace must not leak audio payload');

  // Re-hydrating preference store restores persisted preference
  prefStore.setPreferredMode('CLOUD', { explicitCloudOptIn: true });
  const hydratedStore = new ExecutionModePreferenceStore({
    storage: {
      getItem: (k) => storageMap.get(k) ?? null,
      setItem: (k, v) => {
        storageMap.set(k, v);
      },
    },
  });
  assert.equal(hydratedStore.getPreferredMode(), 'CLOUD');
  assert.equal(hydratedStore.getSnapshot().explicitCloudOptInConfirmed, true);
});

// ============================================================================
// 5. REGRESSION: EXISTING CORE ASR ROUTER REMAINS INTACT
// ============================================================================

test('Regression: CoreModelRouter batch + long_form workflow remains compatible alongside UnifiedProcessingOrchestrator', async () => {
  const router = new CoreModelRouter();
  const speech = synthesizeAcousticSpeechFromText('سلام امروز api بررسی');
  const wavBuf = encodeDeterministicWav(speech, CORE_SAMPLE_RATE);

  const direct = router.batchEngine.transcribeAudioBytes({
    filename: 'reg_test.wav',
    rawBytes: wavBuf,
    languageHint: 'fa-en',
  });

  const orchestrator = new UnifiedProcessingOrchestrator({
    localAdapter: new LocalExecutionAdapter({ coreRouter: router }),
  });
  const unified = await orchestrator.execute(
    buildDeterministicWavRequest({
      jobId: 'job_reg_1',
      executionMode: 'LOCAL',
      audio: uint8ArrayToTransportSafeAudioInput({
        bytes: new Uint8Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength),
        encoding: 'BASE64_CONTAINER',
        metadata: {
          filename: 'reg_test.wav',
          mimeType: 'audio/wav',
          containerFormat: 'wav',
          sampleRateHz: CORE_SAMPLE_RATE,
          channelCount: 1,
          durationSecEstimate: speech.length / CORE_SAMPLE_RATE,
          sha256Hex: null,
        },
      }),
    }),
  );

  // Unified local path produces identical raw & normalized transcript to direct CoreBatchAndLongFormEngine
  assert.equal(unified.rawModelOutput, direct.rawModelOutput);
  assert.deepEqual(unified.normalizedByProfile, direct.normalizedByProfile);
  assert.equal(unified.audioSha256Hex, direct.audioSha256);
});
