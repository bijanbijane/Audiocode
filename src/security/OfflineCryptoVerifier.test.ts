import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformLicenseService } from '../../backend/src/PlatformLicenseService';
import { OfflineCryptoVerifier } from './OfflineCryptoVerifier';

test('Ed25519 offline license lease verifies cleanly including UTF-8 Persian metadata', async () => {
  const service = new PlatformLicenseService();
  const { publicKeySpkiBase64 } = service.getPublicKeyInfo();

  const envelope = service.issueOfflineLicenseLease({
    userId: 'usr_persian_01',
    displayName: 'علیرضا محمدی — استودیو پادکست',
    deviceFingerprint: 'dev_fp_abc123',
    plan: 'PRO',
    graceDays: 14,
  });

  const now = Date.now();
  const result = await OfflineCryptoVerifier.verifyOfflineLicense(
    envelope,
    publicKeySpkiBase64,
    now,
    now + 1000,
  );

  assert.equal(result.isValid, true);
  assert.equal(result.reason, 'VALID');
  assert.deepEqual(result.allowedModelTiers, ['GROUP_A', 'GROUP_B']);
  assert.equal(result.payload?.displayName, 'علیرضا محمدی — استودیو پادکست');
});

test('tampered payload in localStorage fails Ed25519 signature check', async () => {
  const service = new PlatformLicenseService();
  const { publicKeySpkiBase64 } = service.getPublicKeyInfo();

  const envelope = service.issueOfflineLicenseLease({
    userId: 'usr_free_01',
    deviceFingerprint: 'dev_fp_free',
    plan: 'FREE',
    graceDays: 14,
  });

  // Attacker re-encodes payload upgrading FREE -> ENTERPRISE without private key
  const rawPayload = JSON.parse(Buffer.from(envelope.payloadBase64, 'base64').toString('utf8'));
  rawPayload.plan = 'ENTERPRISE';
  rawPayload.allowedModelTiers = ['GROUP_A', 'GROUP_B'];
  const forgedPayloadBase64 = Buffer.from(JSON.stringify(rawPayload), 'utf8').toString('base64');

  const now = Date.now();
  const result = await OfflineCryptoVerifier.verifyOfflineLicense(
    {
      ...envelope,
      payloadBase64: forgedPayloadBase64,
    },
    publicKeySpkiBase64,
    now,
    now,
  );

  assert.equal(result.isValid, false);
  assert.equal(result.reason, 'SECURITY_SIGNATURE_TAMPERED');
  assert.deepEqual(result.allowedModelTiers, ['GROUP_A']);
});

test('clock rollback beyond 10-minute skew rejects license cleanly', async () => {
  const service = new PlatformLicenseService();
  const { publicKeySpkiBase64 } = service.getPublicKeyInfo();

  const envelope = service.issueOfflineLicenseLease({
    userId: 'usr_pro_02',
    deviceFingerprint: 'dev_fp_clock',
    plan: 'PRO',
    graceDays: 14,
  });

  const now = Date.now();
  const rolledBackClock = now - 2 * 60 * 60 * 1000; // 2 hours backward

  const result = await OfflineCryptoVerifier.verifyOfflineLicense(
    envelope,
    publicKeySpkiBase64,
    now,
    rolledBackClock,
  );

  assert.equal(result.isValid, false);
  assert.equal(result.reason, 'LICENSE_CLOCK_TAMPERED');
  assert.deepEqual(result.allowedModelTiers, ['GROUP_A']);
});

test('expired offline grace locks GROUP_B while preserving GROUP_A (Data Hostage Prevention)', async () => {
  const service = new PlatformLicenseService();
  const { publicKeySpkiBase64 } = service.getPublicKeyInfo();

  const envelope = service.issueOfflineLicenseLease({
    userId: 'usr_pro_03',
    deviceFingerprint: 'dev_fp_expire',
    plan: 'PRO',
    graceDays: 7,
  });

  const now = Date.now();
  const afterGrace = now + 8 * 24 * 60 * 60 * 1000; // 8 days later

  const result = await OfflineCryptoVerifier.verifyOfflineLicense(
    envelope,
    publicKeySpkiBase64,
    now,
    afterGrace,
  );

  assert.equal(result.isValid, false);
  assert.equal(result.reason, 'SUBSCRIPTION_EXPIRED_READ_ONLY');
  assert.deepEqual(result.allowedModelTiers, ['GROUP_A']);
});

test('signed model chunk manifest accepts ACTIVE and rejects REVOKED or tampered entries', async () => {
  const service = new PlatformLicenseService();
  const { publicKeySpkiBase64 } = service.getPublicKeyInfo();

  const activeEnvelope = service.issueSignedModelManifestEnvelope('whisper-fa-int8');
  assert.ok(activeEnvelope);
  const activeRes = await OfflineCryptoVerifier.verifyModelManifest(
    activeEnvelope,
    publicKeySpkiBase64,
  );
  assert.equal(activeRes.isValid, true);
  assert.equal(activeRes.manifest?.chunks.length, 4);

  const revokedEnvelope = service.issueSignedModelManifestEnvelope('legacy-denoise-v0');
  assert.ok(revokedEnvelope);
  const revokedRes = await OfflineCryptoVerifier.verifyModelManifest(
    revokedEnvelope,
    publicKeySpkiBase64,
  );
  assert.equal(revokedRes.isValid, false);
  assert.equal(revokedRes.reason, 'MODEL_REVOKED');
});
