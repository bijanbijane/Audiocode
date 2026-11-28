#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ALLOWED_MODEL_DOWNLOAD_HOSTS,
  downloadFileWithRedirects,
  extractTarBz2Safe,
} from '../src/asr-core/SafeModelSupplyChain';
import { resolveAvapardazReleaseTarget } from './release-targets.mjs';
import { verifyRequiredCpuFeatures } from './cpu-feature-preflight.mjs';
import { assertNativeBinaryArchitecture } from './verify-native-binary.mjs';

function sha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function walkFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`RUNTIME_ARCHIVE_SYMLINK_FORBIDDEN: ${path.relative(root, fullPath)}`);
    }
    if (entry.isDirectory()) result.push(...walkFiles(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

function isSharedLibrary(fileName: string, platform: string): boolean {
  if (platform === 'win32') return /^.+\.dll$/i.test(fileName);
  if (platform === 'darwin') return /^.+\.dylib$/i.test(fileName);
  return false;
}

function findOnnxRuntimeLibrary(files: string[], target: ReturnType<typeof resolveAvapardazReleaseTarget>): string {
  const exact = files.find((file) => path.basename(file) === target.onnxRuntimeLibraryName);
  if (exact) return exact;
  if (target.platform === 'darwin') {
    const versioned = files.find((file) => /^libonnxruntime\.\d+(?:\.\d+)*\.dylib$/.test(path.basename(file)));
    if (versioned) return versioned;
  }
  throw new Error(`ONNXRUNTIME_LIBRARY_MISSING: expected ${target.onnxRuntimeLibraryName} in the pinned runtime archive.`);
}

function smokeTest(binaryPath: string, libraryDir: string, platform: string): void {
  const env = { ...process.env };
  const existingPath = process.env.PATH ?? process.env.Path ?? '';
  env.PATH = [libraryDir, existingPath].filter(Boolean).join(path.delimiter);
  if (platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    env.DYLD_FALLBACK_LIBRARY_PATH = [libraryDir, process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  }
  const result = spawnSync(binaryPath, ['--help'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `SHERPA_RUNTIME_SMOKE_FAILED: status=${result.status}; error=${result.error?.message ?? 'none'}; stderr=${result.stderr?.slice(-3000) ?? ''}`,
    );
  }
}

async function main(): Promise<void> {
  // This provisioner executes the native binary; cross-target provisioning is forbidden.
  const target = resolveAvapardazReleaseTarget();
  const expectedTarget = process.env.AVAPARDAZ_EXPECTED_TARGET?.trim();
  if (expectedTarget && expectedTarget !== target.id) {
    throw new Error(`RUNTIME_HOST_TARGET_MISMATCH: expected ${expectedTarget}, actual runner is ${target.id}`);
  }
  const cpuFeatureProbe = verifyRequiredCpuFeatures(target.requiredCpuFeatures);
  if (!cpuFeatureProbe.supported) {
    throw new Error(`RUNTIME_CPU_FEATURE_UNSUPPORTED: ${cpuFeatureProbe.reason}`);
  }
  const archive = target.runtimeArchive;
  const outputRoot = path.resolve(
    process.env.AVAPARDAZ_RUNTIME_OUTPUT_DIR?.trim()
      || path.join(os.homedir(), '.avapardaz', 'runtime', 'targets', target.id),
  );
  const outputParent = path.dirname(outputRoot);
  fs.mkdirSync(outputParent, { recursive: true });

  if (fs.existsSync(outputRoot)) {
    const manifestPath = path.join(outputRoot, 'runtime-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`RUNTIME_DESTINATION_EXISTS_UNVERIFIED: refusing to overwrite ${outputRoot}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      schemaVersion?: number;
      targetId?: string;
      requiredCpuFeatures?: string[];
      cpuFeatureProbe?: { required?: string[]; checked?: string[] };
      archiveName?: string;
      archiveSha256?: string;
      archiveBytes?: number;
      binaryName?: string;
      binaryBytes?: number;
      binarySha256?: string;
      onnxRuntimeLibraryName?: string;
      onnxRuntimeLibraryBytes?: number;
      onnxRuntimeLibrarySha256?: string;
      sharedLibraries?: Array<{ name: string; bytes: number; sha256: string }>;
    };
    if (
      manifest.schemaVersion !== 1
      || manifest.targetId !== target.id
      || JSON.stringify(manifest.requiredCpuFeatures) !== JSON.stringify(target.requiredCpuFeatures)
      || JSON.stringify(manifest.cpuFeatureProbe?.required) !== JSON.stringify(target.requiredCpuFeatures)
      || JSON.stringify(manifest.cpuFeatureProbe?.checked) !== JSON.stringify(target.requiredCpuFeatures)
      || manifest.archiveName !== archive.fileName
      || manifest.archiveSha256 !== archive.sha256
      || manifest.archiveBytes !== archive.bytes
      || manifest.binaryName !== target.sherpaBinaryName
    ) {
      throw new Error(`RUNTIME_DESTINATION_EXISTS_DIFFERENT_PROVENANCE: refusing to overwrite ${outputRoot}`);
    }
    const binaryPath = path.join(outputRoot, 'bin', target.sherpaBinaryName);
    if (!fs.existsSync(binaryPath) || manifest.binaryBytes !== fs.statSync(binaryPath).size || manifest.binarySha256 !== sha256(binaryPath)) {
      throw new Error('RUNTIME_DESTINATION_BINARY_INTEGRITY_FAILED');
    }
    assertNativeBinaryArchitecture({ filePath: binaryPath, platform: target.platform, arch: target.arch });
    const sharedLibraries = manifest.sharedLibraries ?? [];
    if (sharedLibraries.length === 0) throw new Error('RUNTIME_DESTINATION_LIBRARY_MANIFEST_MISSING');
    for (const entry of sharedLibraries) {
      const libraryPath = path.join(outputRoot, 'lib', entry.name);
      if (!fs.existsSync(libraryPath) || entry.bytes !== fs.statSync(libraryPath).size || entry.sha256 !== sha256(libraryPath)) {
        throw new Error(`RUNTIME_DESTINATION_LIBRARY_INTEGRITY_FAILED: ${entry.name}`);
      }
      assertNativeBinaryArchitecture({ filePath: libraryPath, platform: target.platform, arch: target.arch });
    }
    const onnxRuntimeEntry = sharedLibraries.find((entry) => entry.name === manifest.onnxRuntimeLibraryName);
    if (
      !onnxRuntimeEntry
      || manifest.onnxRuntimeLibraryBytes !== onnxRuntimeEntry.bytes
      || manifest.onnxRuntimeLibrarySha256 !== onnxRuntimeEntry.sha256
    ) {
      throw new Error('RUNTIME_DESTINATION_ONNX_MANIFEST_MISMATCH');
    }
    const libraryPath = path.join(outputRoot, 'lib', onnxRuntimeEntry.name);
    smokeTest(binaryPath, path.dirname(libraryPath), target.platform);
    console.log(`Verified existing ${target.id} Sherpa runtime at ${outputRoot}`);
    return;
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-sherpa-runtime-'));
  const stageRoot = fs.mkdtempSync(path.join(outputParent, `.${target.id}-stage-`));
  const archivePath = path.join(workspace, archive.fileName);
  const extractRoot = path.join(workspace, 'extract');
  fs.mkdirSync(extractRoot, { recursive: true });
  try {
    const download = await downloadFileWithRedirects(archive.url, archivePath, {
      allowedHosts: ALLOWED_MODEL_DOWNLOAD_HOSTS,
      maxRedirects: 5,
      maxBytes: archive.bytes,
      expectedBytes: archive.bytes,
      expectedSha256Hex: archive.sha256,
      connectTimeoutMs: 15_000,
      totalTimeoutMs: 240_000,
    });
    if (download.sha256Hex !== archive.sha256) {
      throw new Error(`RUNTIME_ARCHIVE_PROVENANCE_MISMATCH: ${archive.fileName}`);
    }

    await extractTarBz2Safe(archivePath, extractRoot, {
      maxFiles: 4096,
      maxSingleFileBytes: 300 * 1024 * 1024,
      maxTotalBytes: 600 * 1024 * 1024,
      allowExecutablesInBin: true,
      allowRelativeLibrarySymlinks: true,
      timeoutMs: 180_000,
      pythonBin: target.platform === 'win32' ? 'python' : 'python3',
    });

    const extractedFiles = walkFiles(extractRoot);
    const binaryPath = extractedFiles.find((file) => path.basename(file) === target.sherpaBinaryName);
    if (!binaryPath) throw new Error(`SHERPA_BINARY_MISSING: ${target.sherpaBinaryName}`);
    const onnxLibraryPath = findOnnxRuntimeLibrary(extractedFiles, target);
    const sourceLibraryDir = path.dirname(onnxLibraryPath);
    const sharedLibraries = fs.readdirSync(sourceLibraryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSharedLibrary(entry.name, target.platform))
      .map((entry) => path.join(sourceLibraryDir, entry.name));
    if (!sharedLibraries.some((file) => path.resolve(file) === path.resolve(onnxLibraryPath))) {
      throw new Error('ONNXRUNTIME_LIBRARY_NOT_IN_SHARED_LIBRARY_SET');
    }

    assertNativeBinaryArchitecture({ filePath: binaryPath, platform: target.platform, arch: target.arch });
    for (const library of sharedLibraries) {
      assertNativeBinaryArchitecture({ filePath: library, platform: target.platform, arch: target.arch });
    }

    const stagedBinDir = path.join(stageRoot, 'bin');
    const stagedLibDir = path.join(stageRoot, 'lib');
    fs.mkdirSync(stagedBinDir, { recursive: true });
    fs.mkdirSync(stagedLibDir, { recursive: true });
    const stagedBinary = path.join(stagedBinDir, target.sherpaBinaryName);
    fs.copyFileSync(binaryPath, stagedBinary);
    if (target.platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);
    for (const library of sharedLibraries) {
      fs.copyFileSync(library, path.join(stagedLibDir, path.basename(library)));
    }

    const stagedOnnxLibrary = path.join(stagedLibDir, path.basename(onnxLibraryPath));
    smokeTest(stagedBinary, stagedLibDir, target.platform);
    const manifest = {
      schemaVersion: 1,
      product: 'AVAPARDAZ',
      targetId: target.id,
      requiredCpuFeatures: target.requiredCpuFeatures,
      cpuFeatureProbe: {
        required: target.requiredCpuFeatures,
        checked: cpuFeatureProbe.checked,
      },
      runtimeVersion: 'v2.0.2',
      archiveName: archive.fileName,
      archiveBytes: archive.bytes,
      archiveSha256: archive.sha256,
      binaryName: target.sherpaBinaryName,
      binaryBytes: fs.statSync(stagedBinary).size,
      binarySha256: sha256(stagedBinary),
      onnxRuntimeLibraryName: path.basename(stagedOnnxLibrary),
      onnxRuntimeLibraryBytes: fs.statSync(stagedOnnxLibrary).size,
      onnxRuntimeLibrarySha256: sha256(stagedOnnxLibrary),
      sharedLibraries: sharedLibraries.map((source) => {
        const staged = path.join(stagedLibDir, path.basename(source));
        return { name: path.basename(source), bytes: fs.statSync(staged).size, sha256: sha256(staged) };
      }),
      smokeTest: { command: '--help', exitCode: 0 },
      provisionedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(stageRoot, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    if (fs.existsSync(outputRoot)) {
      throw new Error(`RUNTIME_DESTINATION_RACE: destination appeared during provisioning: ${outputRoot}`);
    }
    fs.renameSync(stageRoot, outputRoot);
    console.log(JSON.stringify({ target: target.id, outputRoot, archive: archive.fileName, archiveSha256: archive.sha256, cpuFeatureProbe: cpuFeatureProbe.checked, binary: target.sherpaBinaryName, onnxRuntimeLibrary: path.basename(stagedOnnxLibrary), sharedLibraryCount: sharedLibraries.length }, null, 2));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('[AVAPARDAZ Native Runtime Provisioner]', error);
  process.exitCode = 1;
});
