import fs from 'node:fs';
import type { PgPoolLike } from '../PlatformBackendServices';
import { DevOpsModelChunkerAndSigner } from './model-chunker-signer-cli';
import type { OrtTensorLike } from '../../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';

export interface OrtValidatorSessionLike {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void>;
}

export interface CandidateModelAuditInput {
  readonly onnxFilePath: string;
  readonly outputChunksDir: string;
  readonly modelId: string;
  readonly version: string;
  readonly taskType:
    | 'VAD'
    | 'PERSIAN_ASR'
    | 'FORCED_ALIGNMENT'
    | 'DISFLUENCY'
    | 'DIARIZATION'
    | 'DENOISER';
  readonly tierGroup: 'GROUP_A' | 'GROUP_B' | 'GROUP_C';
  readonly spdxLicense: string;
  readonly quantizationFormat: string;
  readonly expectedInputNames: string[];
  readonly dryRunDummyFeeds: () => Record<string, OrtTensorLike>;
  readonly minRamMb: number;
  readonly recommendedRamMb: number;
  readonly cdnBaseUrl: string;
  readonly ed25519PrivateKeyPem: string;
  readonly targetReleaseStatus: 'LIMITED_RELEASE' | 'ACTIVE';
}

export interface ModelGateAuditResult {
  readonly passed: boolean;
  readonly modelId: string;
  readonly version: string;
  readonly measuredDryRunLatencyMs: number;
  readonly measuredPeakRssMb: number;
  readonly totalChunksPublished: number;
  readonly rejectionReasons: string[];
}

/**
 * Section 115: Pre-Release ONNX Model Gate Validator & Atomic PostgreSQL Publisher (Section 40 Lifecycle)
 * Enforces: Candidate -> Commercial License Review -> Dry-Run Schema & Latency Audit -> 8MB Chunking & Ed25519 Signing -> Atomic PostgreSQL Commit
 */
export class BackendModelGateValidatorAndPublisher {
  /** Permissive commercial-safe licenses allowed by Platform Governance (Sections 40 & 59) */
  private static readonly ALLOWED_COMMERCIAL_LICENSES = new Set([
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'MPL-2.0',
    'CC-BY-4.0',
  ]);

  constructor(
    private readonly db: PgPoolLike,
    private readonly customSessionFactory?: (
      onnxFilePath: string,
    ) => Promise<OrtValidatorSessionLike>,
  ) {}

  /**
   * Run all 5 release gates on a candidate ONNX model before atomic publication to PostgreSQL & CDN
   */
  public async validatePackageAndPublishModel(
    input: CandidateModelAuditInput,
  ): Promise<ModelGateAuditResult> {
    const rejectionReasons: string[] = [];

    // 1. Gate 1: Commercial SPDX License Audit
    if (
      !BackendModelGateValidatorAndPublisher.ALLOWED_COMMERCIAL_LICENSES.has(
        input.spdxLicense,
      )
    ) {
      rejectionReasons.push(
        `LICENSE_REJECTED: مجوز «${input.spdxLicense}» در لیست مجاز تجاری پلتفرم نیست.`,
      );
    }

    // 2. Gate 2: File Integrity Check
    if (!fs.existsSync(input.onnxFilePath)) {
      rejectionReasons.push(`MODEL_FILE_NOT_FOUND: ${input.onnxFilePath}`);
    }

    let measuredDryRunLatencyMs = 0;
    let measuredPeakRssMb = 0;

    if (rejectionReasons.length === 0) {
      // 3. Gates 3 & 4: Load in ONNX Runtime, verify input schema, and run Dry-Run Inference Benchmark
      let session: OrtValidatorSessionLike | null = null;
      try {
        session = await this.createValidatorSession(input.onnxFilePath);

        for (const expectedIn of input.expectedInputNames) {
          if (!session.inputNames.includes(expectedIn)) {
            rejectionReasons.push(
              `SCHEMA_MISMATCH: ورودی الزامی «${expectedIn}» در گراف ONNX یافت نشد (ورودی‌های موجود: ${session.inputNames.join(', ')}).`,
            );
          }
        }

        if (rejectionReasons.length === 0) {
          const feeds = input.dryRunDummyFeeds();
          const t0 = performance.now();
          const outputs = await session.run(feeds);
          measuredDryRunLatencyMs = Number((performance.now() - t0).toFixed(2));
          measuredPeakRssMb = Number(
            (process.memoryUsage().rss / (1024 * 1024)).toFixed(1),
          );

          if (Object.keys(outputs).length === 0) {
            rejectionReasons.push(
              'DRY_RUN_EMPTY_OUTPUT: مدل هیچ تانسور خروجی تولید نکرد.',
            );
          }
        }
      } catch (err) {
        rejectionReasons.push(
          `ORT_VALIDATION_ERROR: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        if (session?.release) await session.release();
      }
    }

    if (rejectionReasons.length > 0) {
      return {
        passed: false,
        modelId: input.modelId,
        version: input.version,
        measuredDryRunLatencyMs,
        measuredPeakRssMb,
        totalChunksPublished: 0,
        rejectionReasons,
      };
    }

    // 4. Package into 8MB chunks with SHA-256 hashes and Ed25519 digital signature (Sections 36 & 40)
    const pkgResult = DevOpsModelChunkerAndSigner.packageAndSignModel({
      sourceModelFilePath: input.onnxFilePath,
      outputDirectory: input.outputChunksDir,
      modelId: input.modelId,
      version: input.version,
      taskType: input.taskType,
      tierGroup: input.tierGroup,
      spdxLicense: input.spdxLicense,
      quantizationFormat: input.quantizationFormat,
      minRamMb: input.minRamMb,
      recommendedRamMb: input.recommendedRamMb,
      cdnBaseUrl: input.cdnBaseUrl,
      ed25519PrivateKeyPem: input.ed25519PrivateKeyPem,
    });

    const manifestChunks = pkgResult.envelope.decodedPreview?.chunks ?? [];

    // 5. Atomic PostgreSQL Transaction Commit (ai_models_catalog + ai_model_chunks)
    await this.db.query('BEGIN');
    try {
      await this.db.query(
        `INSERT INTO ai_models_catalog
         (model_id, version, task_type, tier_group, release_status, spdx_license, quantization_format, min_ram_mb, recommended_ram_mb, total_size_bytes, manifest_ed25519_signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          input.modelId,
          input.version,
          input.taskType,
          input.tierGroup,
          input.targetReleaseStatus,
          input.spdxLicense,
          input.quantizationFormat,
          input.minRamMb,
          input.recommendedRamMb,
          pkgResult.totalBytes,
          pkgResult.signatureBase64,
        ],
      );

      for (const ch of manifestChunks) {
        await this.db.query(
          `INSERT INTO ai_model_chunks
           (model_id, version, chunk_index, sha256_hex, byte_length, cdn_path)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.modelId,
            input.version,
            ch.index,
            ch.sha256Hex,
            ch.byteLength,
            ch.url,
          ],
        );
      }

      await this.db.query('COMMIT');
    } catch (dbErr) {
      await this.db.query('ROLLBACK');
      throw dbErr;
    }

    return {
      passed: true,
      modelId: input.modelId,
      version: input.version,
      measuredDryRunLatencyMs,
      measuredPeakRssMb,
      totalChunksPublished: pkgResult.totalChunks,
      rejectionReasons: [],
    };
  }

  private async createValidatorSession(
    onnxFilePath: string,
  ): Promise<OrtValidatorSessionLike> {
    if (this.customSessionFactory) {
      return this.customSessionFactory(onnxFilePath);
    }
    const modName = 'onnxruntime-node';
    const ort = (await import(/* @vite-ignore */ modName)) as {
      InferenceSession: {
        create(
          path: string,
          opts: Record<string, unknown>,
        ): Promise<OrtValidatorSessionLike>;
      };
    };
    return ort.InferenceSession.create(onnxFilePath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }
}
