import test from 'node:test';
import assert from 'node:assert/strict';
import type { LocalNeuralTranscriptionResult } from '../../../asr-core/LocalSherpaNeuralEngine';
import {
  CEP_TRANSCRIPT_SCHEMA_VERSION,
  mapLocalNeuralResultToCepTranscriptDto,
} from '../CepTranscriptDto';
import { mapCompanionJobResultForExecutionMode } from '../CompanionJobResultMapper';

test('CEP transcript mapper emits a versioned DTO and preserves raw/normalized text and timing', () => {
  const nativeResult = {
    modelId: 'test-model',
    architecture: 'nemo-ctc',
    quantization: 'INT8',
    offlineVerified: true,
    durationSec: 2,
    processingTimeMs: 400,
    realTimeFactor: 0.2,
    dominantLanguage: 'fa',
    rawText: 'متن خام',
    normalizedByProfile: { 'FA-RELAXED-V1': 'متن نرمال‌شده' },
    timestampGranularity: 'WORD',
    sampleRateHz: 16000,
    channelCount: 1,
    audioSha256: 'a'.repeat(64),
    segments: [{
      id: 'seg-1',
      index: 0,
      startSec: 0.25,
      endSec: 1.75,
      text: 'متن خام',
      normalizedByProfile: { 'FA-RELAXED-V1': 'متن نرمال‌شده' },
      language: 'fa',
      timestampGranularity: 'WORD',
      words: [{ word: 'متن', startSec: 0.25, endSec: 0.8 }],
    }],
  } as unknown as LocalNeuralTranscriptionResult;

  const dto = mapLocalNeuralResultToCepTranscriptDto(nativeResult);
  assert.equal(dto.schemaVersion, CEP_TRANSCRIPT_SCHEMA_VERSION);
  assert.equal(dto.rawText, 'متن خام');
  assert.equal(dto.normalizedText, 'متن نرمال‌شده');
  assert.equal(dto.segments[0].text, 'متن خام');
  assert.equal(dto.segments[0].rawText, 'متن خام');
  assert.equal(dto.segments[0].normalizedText, 'متن نرمال‌شده');
  assert.equal(dto.segments[0].startSec, 0.25);
  assert.equal(dto.segments[0].endSec, 1.75);
  assert.deepEqual(dto.segments[0].words, [{ word: 'متن', startSec: 0.25, endSec: 0.8 }]);
});

test('CEP transcript mapper represents unavailable confidence as null, never as numeric zero', () => {
  const nativeResult = {
    modelId: 'test-model',
    architecture: 'whisper',
    quantization: 'FP32',
    offlineVerified: true,
    durationSec: 1,
    processingTimeMs: 200,
    realTimeFactor: 0.2,
    dominantLanguage: 'en',
    rawText: 'hello',
    normalizedByProfile: { 'FA-RELAXED-V1': 'hello', 'EN-NORM-V1': 'HELLO' },
    timestampGranularity: 'SEGMENT',
    sampleRateHz: 16000,
    channelCount: 1,
    audioSha256: 'b'.repeat(64),
    segments: [{
      id: 'seg-1',
      index: 0,
      startSec: 0,
      endSec: 1,
      text: 'hello',
      normalizedByProfile: { 'FA-RELAXED-V1': 'hello', 'EN-NORM-V1': 'HELLO' },
      language: 'en',
      timestampGranularity: 'SEGMENT',
      words: [],
    }],
  } as unknown as LocalNeuralTranscriptionResult;

  const dto = mapLocalNeuralResultToCepTranscriptDto(nativeResult);
  assert.equal(dto.normalizedText, 'HELLO');
  assert.equal(dto.confidenceStatus, 'UNAVAILABLE_UNCALIBRATED');
  assert.equal(dto.segments[0].confidence, null);
  assert.equal(dto.segments[0].confidenceStatus, 'UNAVAILABLE_UNCALIBRATED');
});

test('only the Audition CEP execution mode receives the versioned job-result DTO', () => {
  const nativeResult = {
    modelId: 'test-model',
    architecture: 'whisper',
    quantization: 'FP32',
    offlineVerified: true,
    durationSec: 1,
    processingTimeMs: 200,
    realTimeFactor: 0.2,
    dominantLanguage: 'en',
    rawText: 'hello',
    normalizedByProfile: { 'EN-NORM-V1': 'HELLO' },
    timestampGranularity: 'SEGMENT',
    sampleRateHz: 16000,
    channelCount: 1,
    audioSha256: 'c'.repeat(64),
    segments: [],
  } as unknown as LocalNeuralTranscriptionResult;
  const job = {
    jobId: 'job-1',
    status: 'COMPLETED',
    modelId: 'test-model',
    languageHint: 'en',
    sourceName: 'clip.wav',
    progressPct: 100,
    currentChunk: 1,
    totalChunks: 1,
    createdAtIso: '2026-11-27T00:00:00.000Z',
    updatedAtIso: '2026-11-27T00:00:01.000Z',
    elapsedMs: 1000,
    partialText: 'hello',
    result: nativeResult,
    errorCode: null,
    errorMessage: null,
  } as const;

  const cepJob = mapCompanionJobResultForExecutionMode(job as never, 'audition-cep');
  assert.equal(cepJob.result?.schemaVersion, CEP_TRANSCRIPT_SCHEMA_VERSION);

  const webJob = mapCompanionJobResultForExecutionMode(job as never, 'web-client');
  assert.equal(webJob, job);
  assert.equal(webJob.result, nativeResult);
});
