import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PlatformBackendServices, type PgPoolLike } from './PlatformBackendServices';

test('standalone Platform API signer exposes a matching Ed25519 public key and signed envelopes', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const db: PgPoolLike = {
    async query<TRow>() {
      return { rows: [] as TRow[], rowCount: 0 };
    },
  };

  const service = new PlatformBackendServices(db, {
    modelStorageRootDir: '/tmp/platform-api-models',
    ed25519PrivateKeyPem: privatePem,
    keyId: 'platform-smoke-test',
    cdnBaseUrl: 'https://cdn.example.invalid/platform-api',
    enableServerSideAsrInference: false,
  });

  const publicKeyInfo = service.getPublicKeyInfo();
  assert.equal(publicKeyInfo.algorithm, 'Ed25519');
  assert.equal(publicKeyInfo.keyId, 'platform-smoke-test');
  assert.ok(publicKeyInfo.publicKeySpkiBase64.length > 0);

  const envelope = service.signEnvelope({ purpose: 'platform-api-smoke', value: 42 });
  const signatureValid = crypto.verify(
    null,
    Buffer.from(envelope.payloadCanonicalBase64, 'utf8'),
    crypto.createPublicKey({
      key: Buffer.from(publicKeyInfo.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(envelope.ed25519SignatureHex, 'hex'),
  );
  assert.equal(signatureValid, true);
});
