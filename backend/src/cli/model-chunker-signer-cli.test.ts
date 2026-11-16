import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DevOpsModelChunkerAndSigner } from './model-chunker-signer-cli';
import { OfflineCryptoVerifier } from '../../../src/security/OfflineCryptoVerifier';

test('DevOpsModelChunkerAndSigner chunks model binary, signs Ed25519 manifest verifiable by OfflineCryptoVerifier, and emits valid SQL migration', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avapardaz-model-cli-'));
  try {
    const rawModelPath = path.join(tmpDir, 'whisper-fa-q5.bin');
    const outDir = path.join(tmpDir, 'dist-model');
    // 25 KiB deterministic model binary split across 8 KiB chunks -> 4 chunks (8K, 8K, 8K, 1K)
    const modelBytes = crypto.randomBytes(25 * 1024);
    fs.writeFileSync(rawModelPath, modelBytes);

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicSpkiBase64 = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }),
    ).toString('base64');

    const result = DevOpsModelChunkerAndSigner.packageAndSignModel({
      sourceModelFilePath: rawModelPath,
      outputDirectory: outDir,
      modelId: 'whisper-fa-q5',
      version: '2.5.0',
      taskType: 'PERSIAN_ASR',
      tierGroup: 'GROUP_B',
      spdxLicense: 'MIT',
      quantizationFormat: 'Q5_K_M',
      minRamMb: 640,
      recommendedRamMb: 1200,
      cdnBaseUrl: 'https://cdn.avapardaz.ir/models/',
      chunkSizeBytes: 8 * 1024,
      ed25519PrivateKeyPem: privatePem,
    });

    assert.equal(result.totalBytes, 25 * 1024);
    assert.equal(result.totalChunks, 4);

    // Reconstruct binary from written chunks and verify byte-for-byte identity
    const reassembled: Buffer[] = [];
    for (let i = 0; i < 4; i++) {
      const chunkFile = path.join(outDir, `chunk_${String(i).padStart(4, '0')}.bin`);
      assert.equal(fs.existsSync(chunkFile), true);
      reassembled.push(fs.readFileSync(chunkFile));
    }
    assert.equal(Buffer.concat(reassembled).equals(modelBytes), true);

    // Cross-layer Contract Check: Browser OfflineCryptoVerifier accepts manifest.signed.json directly
    const parsedEnvelope = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    const verification = await OfflineCryptoVerifier.verifyModelManifest(
      parsedEnvelope,
      publicSpkiBase64,
    );
    assert.equal(verification.isValid, true);
    assert.equal(verification.reason, 'VALID');
    assert.equal(verification.manifest?.chunks.length, 4);
    assert.equal(
      verification.manifest?.chunks[0].url,
      'https://cdn.avapardaz.ir/models/whisper-fa-q5/2.5.0/chunk_0000.bin',
    );

    // Tampered manifest fails Ed25519 verification
    const tamperedEnvelope = {
      ...parsedEnvelope,
      payloadBase64: Buffer.from(
        JSON.stringify({ ...verification.manifest, version: '9.9.9' }),
        'utf8',
      ).toString('base64'),
    };
    const tamperedCheck = await OfflineCryptoVerifier.verifyModelManifest(
      tamperedEnvelope,
      publicSpkiBase64,
    );
    assert.equal(tamperedCheck.isValid, false);
    assert.equal(tamperedCheck.reason, 'SECURITY_SIGNATURE_TAMPERED');

    // SQL Migration aligns with backend/db/schema.sql columns & chunk hashes
    const sqlText = fs.readFileSync(result.sqlMigrationPath, 'utf8');
    assert.match(sqlText, /^-- Auto-generated Model Registry Migration/m);
    assert.match(sqlText, /BEGIN;/);
    assert.match(sqlText, /INSERT INTO ai_models_catalog/);
    assert.match(sqlText, /'whisper-fa-q5', '2\.5\.0', 'PERSIAN_ASR', 'GROUP_B', 'CANDIDATE'/);
    assert.equal((sqlText.match(/INSERT INTO ai_model_chunks/g) ?? []).length, 4);
    assert.match(sqlText, /COMMIT;/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DevOpsModelChunkerAndSigner rejects unsafe modelId path traversal and empty files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avapardaz-model-bad-'));
  try {
    const emptyFile = path.join(tmpDir, 'empty.bin');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    assert.throws(
      () =>
        DevOpsModelChunkerAndSigner.packageAndSignModel({
          sourceModelFilePath: emptyFile,
          outputDirectory: path.join(tmpDir, 'out'),
          modelId: '../evil',
          version: '1.0.0',
          taskType: 'VAD',
          tierGroup: 'GROUP_A',
          spdxLicense: 'MIT',
          quantizationFormat: 'INT8',
          minRamMb: 64,
          recommendedRamMb: 128,
          cdnBaseUrl: 'https://cdn.example.com/models',
          ed25519PrivateKeyPem: pem,
        }),
      /INVALID_CLI_FIELD/,
    );

    assert.throws(
      () =>
        DevOpsModelChunkerAndSigner.packageAndSignModel({
          sourceModelFilePath: emptyFile,
          outputDirectory: path.join(tmpDir, 'out'),
          modelId: 'silero-vad',
          version: '1.0.0',
          taskType: 'VAD',
          tierGroup: 'GROUP_A',
          spdxLicense: 'MIT',
          quantizationFormat: 'INT8',
          minRamMb: 64,
          recommendedRamMb: 128,
          cdnBaseUrl: 'https://cdn.example.com/models',
          ed25519PrivateKeyPem: pem,
        }),
      /EMPTY_MODEL_FILE/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
