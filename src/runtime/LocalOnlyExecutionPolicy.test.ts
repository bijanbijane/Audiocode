import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVAPARDAZ_LOCAL_EXECUTION_POLICY,
  assertLocalOnlyNetworkRequest,
  evaluateLocalAsrExecutionReadiness,
} from './LocalExecutionPolicy';
import { LocalPrivacyViolationError } from '../security/LocalPrivacyPolicy';

test('AVAPARDAZ_LOCAL_EXECUTION_POLICY permanently forbids Cloud ASR and fake transcript generation', () => {
  assert.equal(AVAPARDAZ_LOCAL_EXECUTION_POLICY.localOnlyEnforced, true);
  assert.equal(AVAPARDAZ_LOCAL_EXECUTION_POLICY.allowCloudAsr, false);
  assert.equal(AVAPARDAZ_LOCAL_EXECUTION_POLICY.allowFakeTranscriptGeneration, false);
  assert.ok(AVAPARDAZ_LOCAL_EXECUTION_POLICY.protectedDataClasses.includes('ORIGINAL_AUDIO'));
  assert.ok(AVAPARDAZ_LOCAL_EXECUTION_POLICY.protectedDataClasses.includes('RAW_TRANSCRIPT'));
});

test('evaluateLocalAsrExecutionReadiness rejects Cloud mode with LOCAL_ONLY_CLOUD_ASR_BLOCKED', () => {
  const decision = evaluateLocalAsrExecutionReadiness({
    hasInstalledModelWeights: false,
    hasVerifiedInferenceEngine: false,
    requestedCloudMode: true,
  });
  assert.equal(decision.ready, false);
  assert.equal(decision.code, 'LOCAL_ONLY_CLOUD_ASR_BLOCKED');
  assert.equal(decision.allowCloudFallback, false);
  assert.equal(decision.allowFakeTranscriptFallback, false);
});

test('evaluateLocalAsrExecutionReadiness reports honest LOCAL_ASR_MODEL_NOT_INSTALLED when weights are missing', () => {
  const decision = evaluateLocalAsrExecutionReadiness({
    hasInstalledModelWeights: false,
    hasVerifiedInferenceEngine: false,
  });
  assert.equal(decision.ready, false);
  assert.equal(decision.code, 'LOCAL_ASR_MODEL_NOT_INSTALLED');
  assert.equal(decision.allowCloudFallback, false);
  assert.equal(decision.allowFakeTranscriptFallback, false);
});

test('evaluateLocalAsrExecutionReadiness reports honest LOCAL_ASR_MODEL_NOT_READY when neural engine is not yet wired', () => {
  const decision = evaluateLocalAsrExecutionReadiness({
    hasInstalledModelWeights: true,
    hasVerifiedInferenceEngine: false,
  });
  assert.equal(decision.ready, false);
  assert.equal(decision.code, 'LOCAL_ASR_MODEL_NOT_READY');
  assert.equal(decision.allowCloudFallback, false);
  assert.equal(decision.allowFakeTranscriptFallback, false);
});

test('assertLocalOnlyNetworkRequest blocks Cloud ASR endpoints and allows only local static assets', () => {
  const blockedUrls = [
    '/api/v1/asr/transcribe',
    'http://localhost:3000/api/v1/asr/transcribe',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent',
    'https://api.openai.com/v1/audio/transcriptions',
    'https://speech.googleapis.com/v1/speech:recognize',
  ];

  for (const url of blockedUrls) {
    assert.throws(
      () => assertLocalOnlyNetworkRequest(url, 'POST', 'http://localhost:3000'),
      LocalPrivacyViolationError,
    );
  }

  const allowedStatic = assertLocalOnlyNetworkRequest('/assets/ort-wasm.wasm', 'GET');
  assert.equal(allowedStatic.allowed, true);
  const allowedBlob = assertLocalOnlyNetworkRequest('blob:http://localhost:3000/abc-123', 'GET');
  assert.equal(allowedBlob.allowed, true);
});
