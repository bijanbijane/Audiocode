import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import { SpeechDataFactoryService } from '../../data-factory/SpeechDataFactoryService';
import { SpeechModelFactoryService } from '../../model-factory/SpeechModelFactoryService';
import { SpeechSecurityService } from '../SpeechSecurityService';
import { TranscriptTrustBoundaryGuard } from '../TranscriptTrustBoundaryGuard';
import { SupplyChainAndPoisoningGuard } from '../SupplyChainAndPoisoningGuard';
import { PrivacyRetentionAndIsolationEngine } from '../PrivacyRetentionAndIsolationEngine';
import { AudioIngestionAndUrlGuard } from '../AudioIngestionAndUrlGuard';

test('Phase 14 Groups A–G: Audio limits, SSRF, Streaming ASR1 replay/overload, Robustness isolation, Prompt injection, Supply chain & Multi-tenant privacy', async () => {
  const cp = new PlatformControlPlaneService();
  const df = new SpeechDataFactoryService(cp);
  const mf = new SpeechModelFactoryService(cp, df);
  await mf.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
  const sec = new SpeechSecurityService(cp, df, mf);

  // Run full executable red-team suite A..G
  const groups = sec.runFullRedTeamVerificationSuite('org_avapardaz_sandbox');
  assert.equal(groups.length, 7);
  for (const g of groups) {
    assert.equal(g.status, 'PASS', `Expected Red Team Group ${g.groupCode} to PASS`);
  }

  // SSRF extra defense checks: loopback IPv6, private 10.x, hex literal, disabled by default
  const defaultDisabled = AudioIngestionAndUrlGuard.validateRemoteAudioFetchUrl('https://cdn.avapardaz.ir/sample.wav');
  assert.equal(defaultDisabled.allowed, false);
  assert.equal(defaultDisabled.blockedReasonCode, 'REMOTE_FETCH_DISABLED');

  const allowlistedPolicy = {
    remoteFetchEnabled: true,
    allowedHostPatterns: ['media.avapardaz.ir'],
    requireTls: true,
    maxRedirects: 0,
    maxResponseBytes: 10_000_000,
    requestTimeoutMs: 4000,
  };
  assert.equal(
    AudioIngestionAndUrlGuard.validateRemoteAudioFetchUrl('https://10.0.0.5/internal.wav', allowlistedPolicy).allowed,
    false
  );
  assert.equal(
    AudioIngestionAndUrlGuard.validateRemoteAudioFetchUrl('https://[::1]/local.wav', allowlistedPolicy).allowed,
    false
  );
  assert.equal(
    AudioIngestionAndUrlGuard.validateRemoteAudioFetchUrl('https://media.avapardaz.ir/a.wav', allowlistedPolicy).allowed,
    true
  );

  // Prompt boundary + independent confirmation gate
  const blockedNoConfirm = TranscriptTrustBoundaryGuard.authorizeToolExecution({
    triggerOrigin: 'EXPLICIT_AUTHENTICATED_UI_OR_API',
    actorPrincipalId: 'usr_owner',
    actorTenantId: 'org_1',
    targetTenantId: 'org_1',
    actorRole: 'OWNER',
    toolName: 'exportTranscript',
    allowedRoles: ['OWNER', 'ADMIN'],
    parametersValid: true,
    explicitUserConfirmation: false,
  });
  assert.equal(blockedNoConfirm.authorized, false);
  assert.equal(blockedNoConfirm.reasonCode, 'BLOCKED_MISSING_USER_CONFIRMATION');

  // Supply chain: valid production v1.0.0 from seeded sandbox passes safe check, while tampered sha256 blocks
  const summary = mf.getSandboxLifecycleSummary('org_avapardaz_sandbox');
  const prod = summary.models.find((m) => m.version === '1.0.0');
  assert.ok(prod);
  const safeRes = sec.inspectModelSupplyChain({
    tenantId: 'org_avapardaz_sandbox',
    modelVersionId: prod!.modelVersionId,
    artifactFilenames: ['adapter.safetensors', 'tokenizer.json'],
    observedWeightsSha256: prod!.weightsArtifactHash,
    expectedTokenizerVersion: prod!.tokenizerVersion,
    actorId: 'usr_sec',
  });
  assert.equal(safeRes.safeToLoad, true);

  const tamperRes = sec.inspectModelSupplyChain({
    tenantId: 'org_avapardaz_sandbox',
    modelVersionId: prod!.modelVersionId,
    artifactFilenames: ['adapter.safetensors'],
    observedWeightsSha256: '0'.repeat(64),
    expectedTokenizerVersion: prod!.tokenizerVersion,
    actorId: 'usr_sec',
  });
  assert.equal(tamperRes.safeToLoad, false);

  // Deletion cascade honors live cleanup and discloses backup window honestly
  const del = sec.deleteRecordingWithCascade({
    tenantId: 'org_avapardaz_sandbox',
    recordingId: 'rec_pii_test',
    actorId: 'usr_sec',
  });
  assert.equal(del.status, 'PARTIAL_PENDING_BACKUP_EXPIRY');
  assert.equal(del.retainedSecurityAuditTrail, true);

  // Cache key includes modelVersion & transcriptVersion
  const k1 = PrivacyRetentionAndIsolationEngine.buildTenantScopedCacheKey({
    tenantId: 'org_a',
    projectId: 'p1',
    recordingId: 'r1',
    modelVersionId: 'v1',
    transcriptVersion: 1,
    normalizationConfig: 'fa_strict_v1',
  });
  const k2 = PrivacyRetentionAndIsolationEngine.buildTenantScopedCacheKey({
    tenantId: 'org_a',
    projectId: 'p1',
    recordingId: 'r1',
    modelVersionId: 'v2',
    transcriptVersion: 1,
    normalizationConfig: 'fa_strict_v1',
  });
  assert.notEqual(k1, k2);
  assert.ok(SupplyChainAndPoisoningGuard);
});
