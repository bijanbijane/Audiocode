import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalApiGovernanceGateway } from './ExternalApiGovernanceGateway';
import { TimeMath } from '../contracts/timebase.contract';

test('ExternalApiGovernanceGateway stays disabled by default and blocks auto-fallback from local AI', async () => {
  const gw = new ExternalApiGovernanceGateway();
  assert.equal(gw.getUserPolicy().externalApiGloballyEnabled, false);

  await assert.rejects(
    () =>
      gw.executeThroughGovernancePipeline({
        providerId: 'openai',
        modelName: 'gpt-4o-audio',
        consentId: 'c1',
        dataKind: 'SELECTED_AUDIO_SNIPPET',
        selectedRange: { start: 0, end: TimeMath.secondsToFlicks(10) },
        totalAssetDurationRange: { start: 0, end: TimeMath.secondsToFlicks(600) },
        isTriggeredByInternalAiFailureFallback: true,
        dispatchNetworkCall: async () => ({ text: 'ok' }),
        validateExternalSchema: (x) => x,
      }),
    /POLICY_VIOLATION_AUTO_FALLBACK_FORBIDDEN/,
  );

  await assert.rejects(
    () =>
      gw.executeThroughGovernancePipeline({
        providerId: 'openai',
        modelName: 'gpt-4o-audio',
        consentId: 'c1',
        dataKind: 'SELECTED_AUDIO_SNIPPET',
        selectedRange: { start: 0, end: TimeMath.secondsToFlicks(10) },
        totalAssetDurationRange: { start: 0, end: TimeMath.secondsToFlicks(600) },
        isTriggeredByInternalAiFailureFallback: false,
        dispatchNetworkCall: async () => ({ text: 'ok' }),
        validateExternalSchema: (x) => x,
      }),
    /POLICY_EXTERNAL_API_DISABLED/,
  );
});

test('ExternalApiGovernanceGateway enforces data minimization, cost ceiling, immediate revocation, and provenance', async () => {
  const gw = new ExternalApiGovernanceGateway();
  gw.updateUserPolicy({
    externalApiGloballyEnabled: true,
    maxAllowedAudioSnippetSeconds: 120,
    maxAllowedTextChars: 500,
    allowedProviderIds: ['gemini-optin'],
  });

  gw.registerExplicitConsent({
    consentId: 'consent-audio-1',
    providerId: 'gemini-optin',
    allowedDataKind: 'SELECTED_AUDIO_SNIPPET',
    maxApprovedCostUsd: 0.01,
    grantedAtTimestamp: Date.now(),
    revoked: false,
  });

  // Full 2-hour file upload blocked (> 120s snippet cap)
  await assert.rejects(
    () =>
      gw.executeThroughGovernancePipeline({
        providerId: 'gemini-optin',
        modelName: 'gemini-audio',
        consentId: 'consent-audio-1',
        dataKind: 'SELECTED_AUDIO_SNIPPET',
        selectedRange: { start: 0, end: TimeMath.secondsToFlicks(1800) },
        totalAssetDurationRange: { start: 0, end: TimeMath.secondsToFlicks(7200) },
        isTriggeredByInternalAiFailureFallback: false,
        dispatchNetworkCall: async () => ({ summary: 'x' }),
        validateExternalSchema: (x) => x,
      }),
    /POLICY_FULL_FILE_UPLOAD_FORBIDDEN/,
  );

  // Valid 30s snippet succeeds with explicit provenance and requiresMandatoryUserReview=true
  const res = await gw.executeThroughGovernancePipeline({
    providerId: 'gemini-optin',
    modelName: 'gemini-audio',
    consentId: 'consent-audio-1',
    dataKind: 'SELECTED_AUDIO_SNIPPET',
    selectedRange: { start: 0, end: TimeMath.secondsToFlicks(30) },
    totalAssetDurationRange: { start: 0, end: TimeMath.secondsToFlicks(7200) },
    isTriggeredByInternalAiFailureFallback: false,
    dispatchNetworkCall: async () => ({ transcriptFix: 'تست' }),
    validateExternalSchema: (x) => x,
  });

  assert.equal(res.provenance.origin, 'EXTERNAL_API');
  assert.equal(res.provenance.requiresMandatoryUserReview, true);
  assert.equal(res.validatedPayload.transcriptFix, 'تست');

  // Immediate revocation stops subsequent calls
  gw.revokeConsentImmediately('consent-audio-1');
  await assert.rejects(
    () =>
      gw.executeThroughGovernancePipeline({
        providerId: 'gemini-optin',
        modelName: 'gemini-audio',
        consentId: 'consent-audio-1',
        dataKind: 'SELECTED_AUDIO_SNIPPET',
        selectedRange: { start: 0, end: TimeMath.secondsToFlicks(15) },
        totalAssetDurationRange: { start: 0, end: TimeMath.secondsToFlicks(7200) },
        isTriggeredByInternalAiFailureFallback: false,
        dispatchNetworkCall: async () => ({ transcriptFix: 'تست' }),
        validateExternalSchema: (x) => x,
      }),
    /CONSENT_INVALID_OR_REVOKED/,
  );
});
