#!/usr/bin/env node
/**
 * Standalone reproducible CLI provisioner for the native CPU offline ASR engine
 * (k2-fsa/sherpa-onnx v2.0.2 + Reza2kn/Shenava-Rizeh INT8 FastConformer CTC).
 * Installs strictly outside git under ~/.avapardaz/ with SHA-256 verification.
 */

import { LocalSherpaNeuralEngine } from '../src/asr-core/LocalSherpaNeuralEngine.ts';

async function main() {
  const engine = new LocalSherpaNeuralEngine();
  const initial = engine.getStatus();
  if (initial.available) {
    console.log(
      `AVAPARDAZ native ASR runtime already verified (${initial.installedModels.map((m) => m.modelId).join(', ')}) at ${initial.binaryPath}`,
    );
    return;
  }

  console.log('Installing AVAPARDAZ native CPU ASR runtime (sherpa-onnx v2.0.2 + Reza2kn/Shenava-Rizeh INT8)...');
  const status = await engine.installShenavaRizehRuntime();
  console.log(
    JSON.stringify(
      {
        available: status.available,
        binaryPath: status.binaryPath,
        models: status.installedModels.map((m) => ({
          modelId: m.modelId,
          integrityVerified: m.integrityVerified,
          diskSizeBytes: m.diskSizeBytes,
        })),
      },
      null,
      2,
    ),
  );
  if (!status.available) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Native ASR setup failed:', err);
  process.exit(1);
});
