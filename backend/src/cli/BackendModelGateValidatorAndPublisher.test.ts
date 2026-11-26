import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BackendModelGateValidatorAndPublisher } from './BackendModelGateValidatorAndPublisher';
import { PgPoolLike } from '../PlatformBackendServices';

describe('Section 115: BackendModelGateValidatorAndPublisher (5-Gate Pre-Release Audit & Atomic DB Commit)', () => {
  it('rejects AGPL-3.0 models, validates ONNX input schema on dry-run, packages 8MB chunks, and commits atomically to PostgreSQL', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paudio-gate115-'));
    const onnxPath = path.join(tmpDir, 'candidate_conformer.onnx');
    fs.writeFileSync(onnxPath, Buffer.alloc(4096, 0x4f));

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const executedSql: string[] = [];
    const mockClient = {
      async query(sql: string) {
        executedSql.push(sql.trim().split(/\s+/)[0]);
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const mockDb: PgPoolLike = {
      async query(sql) {
        executedSql.push(sql.trim().split(/\s+/)[0]);
        return { rows: [], rowCount: 1 };
      },
      async connect() {
        return mockClient;
      },
    };

    const validator = new BackendModelGateValidatorAndPublisher(mockDb, async () => ({
      inputNames: ['input_features'],
      async run() {
        return {
          logits: {
            type: 'float32',
            data: new Float32Array([0.1, 0.9]),
            dims: [1, 1, 2],
          },
        };
      },
    }));

    // 1. Reject non-commercial/copyleft license
    const rejected = await validator.validatePackageAndPublishModel({
      onnxFilePath: onnxPath,
      outputChunksDir: path.join(tmpDir, 'out_rej'),
      modelId: 'bad-license-model',
      version: '1.0.0',
      taskType: 'PERSIAN_ASR',
      tierGroup: 'GROUP_B',
      spdxLicense: 'AGPL-3.0-only',
      quantizationFormat: 'int8',
      expectedInputNames: ['input_features'],
      dryRunDummyFeeds: () => ({}),
      minRamMb: 1024,
      recommendedRamMb: 2048,
      cdnBaseUrl: 'https://cdn.example.com',
      ed25519PrivateKeyPem: privPem,
      targetReleaseStatus: 'LIMITED_RELEASE',
    });
    assert.equal(rejected.passed, false);
    assert.ok(rejected.rejectionReasons[0].includes('LICENSE_REJECTED'));

    // 2. Pass Apache-2.0 model through all 5 gates and commit atomically
    const approved = await validator.validatePackageAndPublishModel({
      onnxFilePath: onnxPath,
      outputChunksDir: path.join(tmpDir, 'out_ok'),
      modelId: 'fastconformer-fa-v1',
      version: '1.2.0',
      taskType: 'PERSIAN_ASR',
      tierGroup: 'GROUP_B',
      spdxLicense: 'Apache-2.0',
      quantizationFormat: 'int8',
      expectedInputNames: ['input_features'],
      dryRunDummyFeeds: () => ({
        input_features: {
          type: 'float32',
          data: new Float32Array(80 * 10),
          dims: [1, 80, 10],
        },
      }),
      minRamMb: 1024,
      recommendedRamMb: 2048,
      cdnBaseUrl: 'https://cdn.example.com',
      ed25519PrivateKeyPem: privPem,
      targetReleaseStatus: 'ACTIVE',
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    assert.equal(approved.passed, true);
    assert.equal(approved.totalChunksPublished, 1);
    assert.deepEqual(executedSql, ['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
  });
});
