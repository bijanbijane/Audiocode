import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  activateDirectoryAtomically,
  ALLOWED_MODEL_DOWNLOAD_HOSTS,
  downloadFileWithRedirects,
} from '../src/asr-core/SafeModelSupplyChain';
import {
  createKoochikModelManifest,
  SHAHAB_KOOCHIK_MODEL_PROVENANCE,
  verifyKoochikModelDirectory,
} from '../src/asr-core/KoochikModelProvenance.mjs';

const MODEL = SHAHAB_KOOCHIK_MODEL_PROVENANCE;
const REPOSITORY_BASE = `https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}`;
const outputArg = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice('--outdir='.length);
const outputRoot = path.resolve(
  outputArg?.trim()
    || process.env.AVAPARDAZ_SHERPA_KOOCHIK_MODEL_DIR?.trim()
    || path.join(os.homedir(), '.avapardaz', 'models', 'shahab-koochik-v1.0-sherpa-onnx'),
);

async function downloadFile(fileName: string, destination: string, options: {
  maxBytes: number;
  expectedBytes?: number;
  expectedSha256Hex?: string;
  totalTimeoutMs: number;
}): Promise<void> {
  await downloadFileWithRedirects(`${REPOSITORY_BASE}/${fileName}`, destination, {
    allowedHosts: ALLOWED_MODEL_DOWNLOAD_HOSTS,
    maxRedirects: 5,
    maxBytes: options.maxBytes,
    ...(options.expectedBytes !== undefined ? { expectedBytes: options.expectedBytes } : {}),
    ...(options.expectedSha256Hex ? { expectedSha256Hex: options.expectedSha256Hex } : {}),
    connectTimeoutMs: 20_000,
    totalTimeoutMs: options.totalTimeoutMs,
  });
}

async function main(): Promise<void> {
  if (fs.existsSync(outputRoot)) {
    const manifestPath = path.join(outputRoot, MODEL.manifestFileName);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`KOOCHIK_MODEL_DESTINATION_EXISTS_UNVERIFIED: refusing to overwrite ${outputRoot}`);
    }
    const verified = verifyKoochikModelDirectory(outputRoot);
    process.stdout.write(JSON.stringify({
      status: 'already-provisioned',
      modelDir: outputRoot,
      repository: MODEL.repository,
      revision: MODEL.revision,
      licenseId: MODEL.licenseId,
      manifestSha256: verified.manifestSha256,
    }, null, 2) + '\n');
    return;
  }

  const outputParent = path.dirname(outputRoot);
  fs.mkdirSync(outputParent, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(outputParent, '.avp-koochik-model-stage-'));
  try {
    await Promise.all([
      downloadFile(MODEL.model.fileName, path.join(stageRoot, MODEL.model.fileName), {
        maxBytes: MODEL.model.bytes,
        expectedBytes: MODEL.model.bytes,
        expectedSha256Hex: MODEL.model.sha256,
        totalTimeoutMs: 15 * 60_000,
      }),
      downloadFile(MODEL.tokens.fileName, path.join(stageRoot, MODEL.tokens.fileName), {
        maxBytes: MODEL.tokens.bytes,
        expectedBytes: MODEL.tokens.bytes,
        expectedSha256Hex: MODEL.tokens.sha256,
        totalTimeoutMs: 90_000,
      }),
      downloadFile(MODEL.readmeFileName, path.join(stageRoot, MODEL.readmeFileName), {
        maxBytes: 256 * 1024,
        totalTimeoutMs: 90_000,
      }),
      downloadFile(MODEL.licenseFileName, path.join(stageRoot, MODEL.licenseFileName), {
        maxBytes: 256 * 1024,
        totalTimeoutMs: 90_000,
      }),
    ]);

    const manifest = createKoochikModelManifest(stageRoot);
    fs.writeFileSync(path.join(stageRoot, MODEL.manifestFileName), JSON.stringify(manifest, null, 2), 'utf8');
    const verified = verifyKoochikModelDirectory(stageRoot);
    await activateDirectoryAtomically({
      stagedDir: stageRoot,
      targetDir: outputRoot,
      validateStaged: (dir) => {
        try {
          verifyKoochikModelDirectory(dir);
          return true;
        } catch {
          return false;
        }
      },
    });

    process.stdout.write(JSON.stringify({
      status: 'provisioned',
      modelDir: outputRoot,
      repository: MODEL.repository,
      revision: MODEL.revision,
      licenseId: MODEL.licenseId,
      modelBytes: MODEL.model.bytes,
      modelSha256: MODEL.model.sha256,
      tokensBytes: MODEL.tokens.bytes,
      tokensSha256: MODEL.tokens.sha256,
      manifestSha256: verified.manifestSha256,
    }, null, 2) + '\n');
  } finally {
    if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[AVAPARDAZ Koochik Model Provisioner] ${message}\n`);
  process.exitCode = 1;
});
