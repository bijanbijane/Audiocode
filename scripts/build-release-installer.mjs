#!/usr/bin/env node
/**
 * AvaPardaz Release Packager & Installer Generator (Phase 1C-H / 1C-I / 1C-K)
 *
 * Packages:
 * 1. Production Web Application (`dist/` from Vite build)
 * 2. Standalone Local Companion Bundle (`avapardaz-companion.mjs` bundled with esbuild)
 * 3. Minimal standalone Sherpa-ONNX CPU Runtime (`sherpa-onnx-offline` + ONNX Runtime shared library)
 * 4. Primary Persian Koochik FastConformer CTC FP32 model, with optional Rizeh INT8 fallback
 * 5. Adobe Audition CEP Extension (`ir.avapardaz.audition.cep`)
 * 6. Target-specific macOS / Windows 11 Installer (`install.mjs`, `install-macos.sh`, `install-windows.ps1`, `uninstall.mjs`)
 * 7. Release & Update Tarballs (`avapardaz-installer-v2.0.0-beta.1.tar.gz`, `avapardaz-update-v2.0.0-beta.2.tar.gz`)
 * 8. Full User, Release, Update, Rollback, Uninstall & License Documentation (`dist-release/docs/`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { assertRuntimeTargetMatches, resolveAvapardazReleaseTarget } from './release-targets.mjs';

const REPO_ROOT = process.cwd();
const RELEASE_TARGET = resolveAvapardazReleaseTarget({
  platform: process.env.AVAPARDAZ_TARGET_PLATFORM?.trim() || process.platform,
  arch: process.env.AVAPARDAZ_TARGET_ARCH?.trim() || process.arch,
});
assertRuntimeTargetMatches({ target: RELEASE_TARGET, runtimeTarget: process.env.AVAPARDAZ_SHERPA_RUNTIME_TARGET?.trim() });
const RELEASE_VERSION = '2.0.0-beta.1';
const NEXT_UPDATE_VERSION = '2.0.0-beta.2';
const BUILD_TIMESTAMP = new Date();
const BUILD_TIMESTAMP_COMPACT = BUILD_TIMESTAMP.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const BUILD_ID = process.env.AVAPARDAZ_BUILD_ID?.trim() || `avp-${BUILD_TIMESTAMP_COMPACT}-shahab-engine01`;
const NEXT_BUILD_ID = `${BUILD_ID}-update`;
const BUILD_RELEASE_DATE = BUILD_TIMESTAMP.toISOString();
const GIT_COMMIT = (() => { try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })();
const GIT_BRANCH = (() => { try { return execSync('git branch --show-current', { cwd: REPO_ROOT, encoding: 'utf8' }).trim() || null; } catch { return null; } })();
const GIT_STATUS = (() => { try { return execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' }); } catch { return ''; } })();
const GIT_WORKTREE_DIRTY = GIT_STATUS.trim().length > 0;
const GIT_DIRTY_FILE_COUNT = GIT_STATUS.split(/\r?\n/).filter(Boolean).length;
const WEB_DIST_ROOT = path.resolve(process.env.AVAPARDAZ_WEB_DIST_DIR?.trim() || path.join(REPO_ROOT, 'dist'));
const outputArg = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice('--outdir='.length);
const DIST_RELEASE = path.resolve(outputArg?.trim() || path.join(REPO_ROOT, 'dist-release'));
const PKG_ROOT = path.join(DIST_RELEASE, `avapardaz-v${RELEASE_VERSION}-${RELEASE_TARGET.id}`);
const UPDATE_STAGE_ROOT = path.join(DIST_RELEASE, `update-stage-v${NEXT_UPDATE_VERSION}-${RELEASE_TARGET.id}`);
const DOCS_OUT_DIR = path.join(DIST_RELEASE, 'docs');

const SHERPA_PYTHON_VERSION = process.env.AVAPARDAZ_SHERPA_PYTHON_VERSION?.trim() || '3.11';
const AVAPARDAZ_USER_MODEL_ROOT = process.env.AVAPARDAZ_MODELS_DIR?.trim() || path.join(os.homedir(), '.avapardaz', 'models');
const SHERPA_RUNTIME_ROOT = process.env.AVAPARDAZ_SHERPA_RUNTIME_DIR?.trim() || path.join(os.homedir(), '.avapardaz', 'runtime', 'sherpa-venv');
const SHERPA_RIZEH_MODEL_DIR = process.env.AVAPARDAZ_SHERPA_RIZEH_MODEL_DIR?.trim() || path.join(AVAPARDAZ_USER_MODEL_ROOT, 'sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26');
const SHAHAB_KOOCHIK_MODEL_DIR = process.env.AVAPARDAZ_SHERPA_KOOCHIK_MODEL_DIR?.trim() || path.join(AVAPARDAZ_USER_MODEL_ROOT, 'shahab-koochik-v1.0-sherpa-onnx');
const SHERPA_BINARY_SOURCE = path.join(SHERPA_RUNTIME_ROOT, 'bin', RELEASE_TARGET.sherpaBinaryName);
const SHERPA_ONNXRUNTIME_LIBRARY_SOURCE = path.join(SHERPA_RUNTIME_ROOT, 'lib', `python${SHERPA_PYTHON_VERSION}`, 'site-packages', 'sherpa_onnx', 'lib');
const SHAHAB_KOOCHIK_MODEL_BYTES = 458_819_249;
const SHAHAB_KOOCHIK_MODEL_SHA256 = '6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d';
const SHAHAB_KOOCHIK_TOKENS_BYTES = 12_236;
const SHAHAB_KOOCHIK_TOKENS_SHA256 = '8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954';

function computeSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function copyDirRecursive(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const realSrc = fs.realpathSync(srcPath);
      fs.copyFileSync(realSrc, dstPath);
      const stat = fs.statSync(realSrc);
      fs.chmodSync(dstPath, stat.mode);
    }
  }
}

console.log(`[AvaPardaz Packager] Starting release packaging for v${RELEASE_VERSION} (${BUILD_ID})...`);

// 1. Ensure production frontend build exists
if (!fs.existsSync(path.join(WEB_DIST_ROOT, 'index.html'))) {
  throw new Error(`WEB_BUILD_MISSING: ${WEB_DIST_ROOT}. Build the current source to an isolated directory and set AVAPARDAZ_WEB_DIST_DIR; the packager will not overwrite the repository dist/ folder automatically.`);
}

// 2. Prepare an isolated output directory. Never recursively delete a user's existing release folder.
if (fs.existsSync(DIST_RELEASE) && fs.readdirSync(DIST_RELEASE).length > 0) {
  throw new Error(`REFUSING_TO_OVERWRITE_NONEMPTY_RELEASE_DIRECTORY: ${DIST_RELEASE}. Pass --outdir=<new-empty-directory>.`);
}
fs.mkdirSync(PKG_ROOT, { recursive: true });
fs.mkdirSync(DOCS_OUT_DIR, { recursive: true });

const payloadDir = path.join(PKG_ROOT, 'payload');
const installerDir = path.join(PKG_ROOT, 'installer');
fs.mkdirSync(path.join(payloadDir, 'app'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'companion'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'runtime', 'bin'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'runtime', 'lib'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'runtime', 'sherpa-venv', 'bin'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'runtime', 'sherpa-venv', 'lib', `python${SHERPA_PYTHON_VERSION}`, 'site-packages', 'sherpa_onnx', 'lib'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'models', 'shenava-rizeh-int8'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'models', 'shahab-koochik-v1.0-sherpa-onnx'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'cep-extension', 'ir.avapardaz.audition.cep'), { recursive: true });
fs.mkdirSync(installerDir, { recursive: true });

// 3. Copy built Web UI
copyDirRecursive(WEB_DIST_ROOT, path.join(payloadDir, 'app'));

// Refresh the Web App manifest inside the package. Never ship stale dist metadata
// (for example appVersion 1.3.0 inside a 2.0.0-beta package) or old asset hashes.
const appPayloadDir = path.join(payloadDir, 'app');
const collectPackagedAppAssets = (baseDir, currentDir) => {
  const result = [];
  if (!fs.existsSync(currentDir)) return result;
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) result.push(...collectPackagedAppAssets(baseDir, fullPath));
    else if (entry.isFile() && entry.name !== 'release-manifest.json') {
      result.push({
        path: `/${path.relative(baseDir, fullPath).split(path.sep).join('/')}`,
        bytes: fs.statSync(fullPath).size,
        sha256: computeSha256(fullPath),
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
};
const previousAppManifestPath = path.join(appPayloadDir, 'release-manifest.json');
let previousAppManifest = {};
try { previousAppManifest = JSON.parse(fs.readFileSync(previousAppManifestPath, 'utf8')); } catch { previousAppManifest = {}; }
const packagedAppAssets = collectPackagedAppAssets(appPayloadDir, appPayloadDir);
const refreshedAppManifest = {
  ...previousAppManifest,
  productName: 'Avapardaz',
  appVersion: RELEASE_VERSION,
  buildId: BUILD_ID,
  builtAtIso: BUILD_RELEASE_DATE,
  projectSchemaVersion: Number.isInteger(previousAppManifest.projectSchemaVersion) ? previousAppManifest.projectSchemaVersion : 2,
  edlSchemaVersion: Number.isInteger(previousAppManifest.edlSchemaVersion) ? previousAppManifest.edlSchemaVersion : 2,
  backupSchemaVersion: Number.isInteger(previousAppManifest.backupSchemaVersion) ? previousAppManifest.backupSchemaVersion : 1,
  modelManifestSchemaVersion: Number.isInteger(previousAppManifest.modelManifestSchemaVersion) ? previousAppManifest.modelManifestSchemaVersion : 1,
  renderCheckpointSchemaVersion: Number.isInteger(previousAppManifest.renderCheckpointSchemaVersion) ? previousAppManifest.renderCheckpointSchemaVersion : 1,
  supportedLocalModelRuntimes: ['sherpa-onnx-cpu', 'onnxruntime-web-wasm'],
  serviceWorkerCacheVersion: `avapardaz-${BUILD_ID}`,
  assetCount: packagedAppAssets.length,
  totalBytes: packagedAppAssets.reduce((sum, item) => sum + item.bytes, 0),
  assets: packagedAppAssets,
};
fs.writeFileSync(previousAppManifestPath, JSON.stringify(refreshedAppManifest, null, 2), 'utf8');

// 4. Bundle Local Companion as standalone ESM via esbuild
const companionEntry = path.join(REPO_ROOT, 'companion', 'avapardaz-companion.ts');
const companionBundleOut = path.join(payloadDir, 'companion', 'avapardaz-companion.mjs');
if (fs.existsSync(companionEntry)) {
  console.log('[AvaPardaz Packager] Bundling standalone Local Companion with esbuild...');
  execSync(
    `npx esbuild "${companionEntry}" --bundle --platform=node --target=node20 --format=esm --outfile="${companionBundleOut}" --banner:js="import { createRequire as __avpCreateRequire } from 'node:module'; const require = __avpCreateRequire(import.meta.url);"`,
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  fs.chmodSync(companionBundleOut, 0o755);
}

// 4.1. Ship the optional persistent Sherpa Python worker beside the Companion bundle.
// Runtime selection remains capability-based: installations without the matching
// sherpa-onnx Python package continue using the native CLI backend.
const sherpaPythonWorkerSource = path.join(REPO_ROOT, 'companion', 'shahab_sherpa_worker.py');
const sherpaPythonWorkerOutput = path.join(payloadDir, 'companion', 'shahab_sherpa_worker.py');
if (fs.existsSync(sherpaPythonWorkerSource)) {
  fs.copyFileSync(sherpaPythonWorkerSource, sherpaPythonWorkerOutput);
  fs.chmodSync(sherpaPythonWorkerOutput, 0o644);
}

// 5. Copy the tested, minimal standalone Sherpa-ONNX CPU runtime.
// The CLI is a native binary; it does not require the 98 MiB Python virtualenv.
if (!fs.existsSync(SHERPA_BINARY_SOURCE)) {
  throw new Error(`SHERPA_OFFLINE_BINARY_MISSING: ${SHERPA_BINARY_SOURCE}`);
}
const sherpaStandaloneBinary = path.join(payloadDir, 'runtime', 'sherpa-venv', 'bin', path.basename(SHERPA_BINARY_SOURCE));
fs.copyFileSync(SHERPA_BINARY_SOURCE, sherpaStandaloneBinary);
fs.chmodSync(sherpaStandaloneBinary, 0o755);

const onnxRuntimeLibrarySource = path.join(SHERPA_ONNXRUNTIME_LIBRARY_SOURCE, RELEASE_TARGET.onnxRuntimeLibraryName);
if (!onnxRuntimeLibrarySource) {
  throw new Error(`SHERPA_ONNXRUNTIME_LIBRARY_MISSING: ${SHERPA_ONNXRUNTIME_LIBRARY_SOURCE}`);
}
const sherpaLibraryOutput = path.join(
  payloadDir, 'runtime', 'sherpa-venv', 'lib', `python${SHERPA_PYTHON_VERSION}`, 'site-packages', 'sherpa_onnx', 'lib',
);
fs.mkdirSync(sherpaLibraryOutput, { recursive: true });
// The tested native CLI has one non-system dependency: libonnxruntime.
// Copy only that library; Python extension modules and C API libraries are not runtime dependencies of this CLI.
fs.copyFileSync(onnxRuntimeLibrarySource, path.join(sherpaLibraryOutput, path.basename(onnxRuntimeLibrarySource)));
fs.chmodSync(path.join(sherpaLibraryOutput, path.basename(onnxRuntimeLibrarySource)), 0o755);

// 6. Copy the primary Persian Koochik model, and keep Rizeh as a lightweight fallback.
const koochikSourceModel = path.join(SHAHAB_KOOCHIK_MODEL_DIR, 'model.onnx');
const koochikSourceTokens = path.join(SHAHAB_KOOCHIK_MODEL_DIR, 'tokens.txt');
const koochikSourceLicense = path.join(SHAHAB_KOOCHIK_MODEL_DIR, 'LICENSE');
const koochikSourceReadme = path.join(SHAHAB_KOOCHIK_MODEL_DIR, 'README.md');
for (const [source, expectedBytes, expectedHash, label] of [
  [koochikSourceModel, SHAHAB_KOOCHIK_MODEL_BYTES, SHAHAB_KOOCHIK_MODEL_SHA256, 'KOOCHIK_ONNX'],
  [koochikSourceTokens, SHAHAB_KOOCHIK_TOKENS_BYTES, SHAHAB_KOOCHIK_TOKENS_SHA256, 'KOOCHIK_TOKENS'],
]) {
  if (!fs.existsSync(source)) throw new Error(`${label}_MISSING: ${source}`);
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size !== expectedBytes || computeSha256(source) !== expectedHash) {
    throw new Error(`${label}_INTEGRITY_FAILED: ${source}`);
  }
}
const koochikPayloadDir = path.join(payloadDir, 'models', 'shahab-koochik-v1.0-sherpa-onnx');
for (const source of [koochikSourceModel, koochikSourceTokens, koochikSourceLicense, koochikSourceReadme]) {
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(koochikPayloadDir, path.basename(source)));
}

// Optional smaller Shenava-Rizeh fallback model; never block a Koochik-only release.
const modelArtifacts = ['model.int8.onnx', 'tokens.txt'];
for (const file of modelArtifacts) {
  const srcFile = path.join(SHERPA_RIZEH_MODEL_DIR, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, path.join(payloadDir, 'models', 'shenava-rizeh-int8', file));
  }
}
if (fs.existsSync(path.join(SHERPA_RIZEH_MODEL_DIR, 'test_wavs'))) {
  copyDirRecursive(
    path.join(SHERPA_RIZEH_MODEL_DIR, 'test_wavs'),
    path.join(payloadDir, 'models', 'shenava-rizeh-int8', 'test_wavs')
  );
}

// 7. Copy Adobe Audition CEP Extension
const cepSrcDir = path.join(REPO_ROOT, 'packages', 'audition-cep-plugin');
if (fs.existsSync(cepSrcDir)) {
  copyDirRecursive(cepSrcDir, path.join(payloadDir, 'cep-extension', 'ir.avapardaz.audition.cep'));
}

// 8. Write executable Installer & Uninstaller scripts
const installMjsContent = `#!/usr/bin/env node
/**
 * AvaPardaz user-space installer (requires Node.js 20 or newer)
 * Version: ${RELEASE_VERSION} (${BUILD_ID})
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.platform !== '${RELEASE_TARGET.platform}' || process.arch !== '${RELEASE_TARGET.arch}') {
  console.error('[AvaPardaz Installer] This package targets ${RELEASE_TARGET.id}; current runtime is', `${process.platform}-${process.arch}`);
  process.exit(3);
}
const nodeMajorVersion = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajorVersion) || nodeMajorVersion < 20) {
  console.error('[AvaPardaz Installer] Node.js 20 or newer is required. Current version:', process.versions.node);
  process.exit(4);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('AvaPardaz Installer ${RELEASE_VERSION}');
  console.log('Usage: node ./installer/install.mjs [--target=<empty-directory>]');
  console.log('Requires Node.js 20 or newer. The installer refuses to overwrite an existing non-empty target.');
  process.exit(0);
}
const targetArg = args.find((a) => a.startsWith('--target='));
const targetRoot = targetArg ? path.resolve(targetArg.slice('--target='.length)) : path.join(os.homedir(), 'AvaPardaz');
if (fs.existsSync(targetRoot) && fs.readdirSync(targetRoot).length > 0) {
  console.error('[AvaPardaz Installer] Refusing to overwrite a non-empty installation directory:', targetRoot);
  console.error('Back up existing user data first, then use the dedicated update/rollback flow.');
  process.exit(2);
}
const installerDir = path.dirname(fileURLToPath(import.meta.url));
const payloadRoot = path.resolve(installerDir, '..', 'payload');

function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.statSync(s).mode);
    }
  }
}

console.log('[AvaPardaz Installer] Installing AvaPardaz v${RELEASE_VERSION} to:', targetRoot);
const dirs = [
  'app', 'companion', 'runtime/bin', 'runtime/lib', 'runtime/sherpa-venv/bin',
  'runtime/sherpa-venv/lib/python${SHERPA_PYTHON_VERSION}/site-packages/sherpa_onnx/lib',
  'models/shenava-rizeh-int8', 'models/shahab-koochik-v1.0-sherpa-onnx', 'cep-extension',
  'user-data/projects', 'user-data/settings', 'user-data/feedback',
  'user-data/diagnostics', 'user-data/logs', 'user-data/cache', 'backups'
];
for (const d of dirs) fs.mkdirSync(path.join(targetRoot, d), { recursive: true });

copyRecursive(path.join(payloadRoot, 'app'), path.join(targetRoot, 'app'));
copyRecursive(path.join(payloadRoot, 'companion'), path.join(targetRoot, 'companion'));
copyRecursive(path.join(payloadRoot, 'runtime'), path.join(targetRoot, 'runtime'));
copyRecursive(path.join(payloadRoot, 'models', 'shenava-rizeh-int8'), path.join(targetRoot, 'models', 'shenava-rizeh-int8'));
copyRecursive(path.join(payloadRoot, 'models', 'shahab-koochik-v1.0-sherpa-onnx'), path.join(targetRoot, 'models', 'shahab-koochik-v1.0-sherpa-onnx'));
copyRecursive(path.join(payloadRoot, 'cep-extension'), path.join(targetRoot, 'cep-extension'));

console.log('[AvaPardaz Installer] Installation completed successfully.');
`;
fs.writeFileSync(path.join(installerDir, 'install.mjs'), installMjsContent, { mode: 0o755 });

const installMacosSh = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
node "\${SCRIPT_DIR}/install.mjs" "$@"
`;
fs.writeFileSync(path.join(installerDir, 'install-macos.sh'), installMacosSh, { mode: 0o755 });

const installWindowsPs1 = `$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction Stop
& $node.Source (Join-Path $scriptDir 'install.mjs') @args
exit $LASTEXITCODE
`;
fs.writeFileSync(path.join(installerDir, 'install-windows.ps1'), installWindowsPs1, 'utf8');

const uninstallMjsContent = `#!/usr/bin/env node
/**
 * AvaPardaz Safe Uninstaller (STANDARD vs COMPLETE mode)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const args = process.argv.slice(2);
const mode = args.includes('--complete') ? 'COMPLETE' : 'STANDARD';
const targetRootArg = args.find((a) => a.startsWith('--target='))?.split('=')[1];
const targetRoot = targetRootArg || path.join(os.homedir(), 'AvaPardaz');

const systemDirs = ['app', 'companion', 'runtime', 'models', 'cep-extension', 'backups', 'install-manifest.json'];
for (const item of systemDirs) {
  const p = path.join(targetRoot, item);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
if (mode === 'COMPLETE') {
  const userData = path.join(targetRoot, 'user-data');
  if (fs.existsSync(userData)) fs.rmSync(userData, { recursive: true, force: true });
}
console.log('[AvaPardaz Uninstaller] Completed in mode:', mode);
`;
fs.writeFileSync(path.join(installerDir, 'uninstall.mjs'), uninstallMjsContent, { mode: 0o755 });

// 9. Write Package Manifest inside PKG_ROOT
const modelOnnxPath = path.join(payloadDir, 'models', 'shenava-rizeh-int8', 'model.int8.onnx');
const tokensTxtPath = path.join(payloadDir, 'models', 'shenava-rizeh-int8', 'tokens.txt');
const sherpaBinPath = sherpaStandaloneBinary;
const koochikModelPath = path.join(koochikPayloadDir, 'model.onnx');
const koochikTokensPath = path.join(koochikPayloadDir, 'tokens.txt');
const bridgeBinPath = path.join(payloadDir, 'runtime', 'bin', 'sherpa-onnx-streaming-bridge');

const packageManifest = {
  productName: 'AvaPardaz (آواپرداز)',
  target: {
    id: RELEASE_TARGET.id,
    platform: RELEASE_TARGET.platform,
    arch: RELEASE_TARGET.arch,
    os: RELEASE_TARGET.osLabel,
    architecture: RELEASE_TARGET.architectureLabel,
  },
  buildHost: { platform: process.platform, arch: process.arch },
  version: RELEASE_VERSION,
  releaseChannel: 'BETA',
  buildId: BUILD_ID,
  releaseDate: BUILD_RELEASE_DATE,
  gitCommit: GIT_COMMIT,
  gitBranch: GIT_BRANCH,
  workingTreeDirty: GIT_WORKTREE_DIRTY,
  dirtyFileCount: GIT_DIRTY_FILE_COUNT,
  buildStatus: 'LOCAL_UNRELEASED_WORKTREE_BUILD',
  architecture: RELEASE_TARGET.id,
  components: {
    webApp: { path: 'payload/app/index.html', version: RELEASE_VERSION },
    companion: {
      path: 'payload/companion/avapardaz-companion.mjs',
      version: RELEASE_VERSION,
      sha256: fs.existsSync(companionBundleOut) ? computeSha256(companionBundleOut) : null,
      sizeBytes: fs.existsSync(companionBundleOut) ? fs.statSync(companionBundleOut).size : 0,
    },
    nativeRuntime: {
      persistentSherpaPythonWorker: {
        path: 'payload/companion/shahab_sherpa_worker.py',
        sha256: fs.existsSync(sherpaPythonWorkerOutput) ? computeSha256(sherpaPythonWorkerOutput) : null,
        sizeBytes: fs.existsSync(sherpaPythonWorkerOutput) ? fs.statSync(sherpaPythonWorkerOutput).size : 0,
        optionalRuntimeRequirement: 'Python with the matching sherpa-onnx package; otherwise the native CLI backend is used.',
      },
      sherpaOfflineBinary: {
        path: `payload/runtime/sherpa-venv/bin/${path.basename(SHERPA_BINARY_SOURCE)}`,
        sha256: fs.existsSync(sherpaBinPath) ? computeSha256(sherpaBinPath) : null,
        sizeBytes: fs.existsSync(sherpaBinPath) ? fs.statSync(sherpaBinPath).size : 0,
      },
      sherpaStreamingBridgeBinary: {
        path: 'payload/runtime/bin/sherpa-onnx-streaming-bridge',
        sha256: fs.existsSync(bridgeBinPath) ? computeSha256(bridgeBinPath) : null,
        sizeBytes: fs.existsSync(bridgeBinPath) ? fs.statSync(bridgeBinPath).size : 0,
      },
    },
    primaryPersianAsrModel: {
      modelId: 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx',
      architecture: 'NeMo FastConformer-CTC',
      quantization: 'FP32',
      language: 'fa',
      licenseSpdx: 'Apache-2.0',
      modelOnnx: {
        path: 'payload/models/shahab-koochik-v1.0-sherpa-onnx/model.onnx',
        sha256: fs.existsSync(koochikModelPath) ? computeSha256(koochikModelPath) : null,
        sizeBytes: fs.existsSync(koochikModelPath) ? fs.statSync(koochikModelPath).size : 0,
      },
      tokensTxt: {
        path: 'payload/models/shahab-koochik-v1.0-sherpa-onnx/tokens.txt',
        sha256: fs.existsSync(koochikTokensPath) ? computeSha256(koochikTokensPath) : null,
        sizeBytes: fs.existsSync(koochikTokensPath) ? fs.statSync(koochikTokensPath).size : 0,
      },
    },
    persianAsrModel: {
      modelId: 'Reza2kn/Shenava-Rizeh-INT8-CTC',
      architecture: 'NeMo FastConformer-CTC INT8',
      modelOnnx: {
        path: 'payload/models/shenava-rizeh-int8/model.int8.onnx',
        sha256: fs.existsSync(modelOnnxPath) ? computeSha256(modelOnnxPath) : null,
        sizeBytes: fs.existsSync(modelOnnxPath) ? fs.statSync(modelOnnxPath).size : 0,
      },
      tokensTxt: {
        path: 'payload/models/shenava-rizeh-int8/tokens.txt',
        sha256: fs.existsSync(tokensTxtPath) ? computeSha256(tokensTxtPath) : null,
        sizeBytes: fs.existsSync(tokensTxtPath) ? fs.statSync(tokensTxtPath).size : 0,
      },
    },
    cepPlugin: {
      bundleId: 'ir.avapardaz.audition.cep',
      version: '1.0.0',
      path: 'payload/cep-extension/ir.avapardaz.audition.cep/CSXS/manifest.xml',
    },
  },
};

fs.writeFileSync(
  path.join(PKG_ROOT, 'package-manifest.json'),
  JSON.stringify(packageManifest, null, 2),
  'utf8'
);

// 10. Create update stage package (v2.0.0-beta.2) for Update/Rollback verification
copyDirRecursive(PKG_ROOT, UPDATE_STAGE_ROOT);
const updateManifest = {
  ...packageManifest,
  version: NEXT_UPDATE_VERSION,
  buildId: NEXT_BUILD_ID,
  parentBuildId: BUILD_ID,
  buildStatus: 'LOCAL_UNRELEASED_WORKTREE_UPDATE',
};
fs.writeFileSync(
  path.join(UPDATE_STAGE_ROOT, 'package-manifest.json'),
  JSON.stringify(updateManifest, null, 2),
  'utf8'
);

// 11. Create Release & Update tarballs
const installerTarball = path.join(DIST_RELEASE, `avapardaz-installer-v${RELEASE_VERSION}-${RELEASE_TARGET.id}.tar.gz`);
const updateTarball = path.join(DIST_RELEASE, `avapardaz-update-v${NEXT_UPDATE_VERSION}-${RELEASE_TARGET.id}.tar.gz`);

execSync(`tar -czf "${installerTarball}" -C "${DIST_RELEASE}" "avapardaz-v${RELEASE_VERSION}-${RELEASE_TARGET.id}"`);
execSync(`tar -czf "${updateTarball}" -C "${DIST_RELEASE}" "update-stage-v${NEXT_UPDATE_VERSION}-${RELEASE_TARGET.id}"`);

// 12. Write all required User, Release, Update, Rollback, Uninstall & License documentation
const docsMap = {
  'INSTALLATION-GUIDE.md': `# راهنمای نصب آواپرداز (AvaPardaz Installation Guide — v${RELEASE_VERSION})

## ۱. نصب خودکار بدون نیاز به دانش برنامه‌نویسی
بسته نصبی آواپرداز شامل رابط کاربری، Local Companion، موتور بومی Sherpa-ONNX CPU، مدل اصلی فارسی Shenava Koochik FP32 و افزونه Adobe Audition CEP است. مدل سبک‌تر Shenava-Rizeh INT8 فقط در صورت بسته‌بندی اختیاری در دسترس خواهد بود. پس از نصب، استنتاج آفلاین است.

### مراحل نصب:
1. بسته مختص ${RELEASE_TARGET.id} یعنی \`avapardaz-installer-v${RELEASE_VERSION}-${RELEASE_TARGET.id}.tar.gz\` را استخراج کنید.
2. اسکریپت نصب خودکار را اجرا کنید:
   - **macOS**: اجرای \`./installer/install-macos.sh\`
   - **Windows 11**: اجرای \`powershell -ExecutionPolicy Bypass -File .\\installer\\install-windows.ps1\`
3. بسته فقط روی ${RELEASE_TARGET.osLabel} / ${RELEASE_TARGET.architectureLabel} اجرا می‌شود و در صورت عدم تطابق OS/CPU یا Node.js کمتر از نسخه 20، پیش از کپی فایل‌ها متوقف خواهد شد.
`,
  'QUICK-START-GUIDE.md': `# راهنمای شروع سریع آواپرداز (Quick-Start Guide)

## گردش کار ۴ مرحله‌ای تدوین هوشمند صوت در آواپرداز
1. **بررسی وضعیت آمادگی (First-Run Health Check)**: پس از باز کردن پنل آواپرداز، وضعیت \`READY\` نشان‌دهنده فعال بودن Companion، موتور بومی Sherpa-ONNX و مدل فارسی است.
2. **ورود صوت و تشخیص گفتار جریانی (Streaming ASR)**: فایل صوتی (WAV/PCM در نرخ‌های پشتیبانی‌شده) را بارگذاری کنید. صوت به‌صورت قطعه‌ای و با مصرف حافظهٔ محدود پردازش می‌شود؛ نسخهٔ فعلی خروجی زمان‌بندی سطح قطعه می‌دهد و زمان‌بندی word-level هنوز فعال نیست.
3. **بازبینی پیشنهادهای تدوین غیرمخرب (EDL Review & Preview)**: تپق‌ها، مکث‌های طولانی و تکرارهای شناسایی‌شده را در جدول EDL مشاهده کنید، پیش‌نمایش صوتی (Preview) را بشنوید و موارد دلخواه را تأیید یا رد کنید.
4. **اعمال تدوین و خروجی نهایی (Non-Destructive Export / Audition SESX)**: بدون کوچک‌ترین تغییر در فایل صوتی اصلی (تضمین‌شده با هش SHA-256)، فایل صوتی تدوین‌شده یا پروژه چندلایه \`.sesx\` را تحویل بگیرید.
`,
  'SYSTEM-REQUIREMENTS.md': `# پیش‌نیازهای سیستم (System Requirements)

| مشخصه | حداقل سیستم مورد نیاز | سیستم پیشنهادی |
|---|---|---|
| **سیستم‌عامل** | macOS 13+ (Apple Silicon / Intel) یا Ubuntu 22.04+ / Debian 12+ (x86_64) | macOS 14+ (Apple M2/M3) یا Linux x86_64 مدرن |
| **پردازنده (CPU)** | ۴ هسته پردازشی ۶۴ بیتی | ۸ هسته پردازشی یا بالاتر |
| **حافظه رم (RAM)** | حداقل ۴ گیگابایت فضای قابل استفاده برای برنامه و موتور ASR | ۸ تا ۱۶ گیگابایت |
| **فضای دیسک** | ۵۰۰ مگابایت برای نصب + ۲ گیگابایت فضای موقت پردازش صوت | ۵ گیگابایت SSD آزاد |
| **میزبان تدوین** | Adobe Audition 2023/2024/2025 (نسخه ۲۳.۰ به بالا) یا اجرای مستقل وب/Companion | Adobe Audition 24.x |
| **اتصال اینترنت** | **نیاز ندارد** (کاملاً آفلاین پس از نصب) | نیاز ندارد |
`,
  'RELEASE-NOTES.md': `# یادداشت‌های انتشار آواپرداز (Release Notes — v${RELEASE_VERSION})

- **شناسه ساخت (Build ID)**: \`${BUILD_ID}\`
- **کانال انتشار**: Controlled Beta (\`Level 2 — BETA CANDIDATE\`)
- **ویژگی‌های کلیدی**:
  1. ورود صوت جریانی و پردازش قطعه‌ای با حافظهٔ محدود (\`StreamingCanonicalAudioIngestion\`) برای ضبط‌های طولانی؛ مصرف واقعی باید بر اساس پیکربندی مدل و سیستم گزارش شود.
  2. موتور بومی تشخیص فارسی SHAHAB بر پایهٔ \`Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx\` (NeMo FastConformer CTC FP32) با اجرای CPU آفلاین و SHA-256 ثابت.
  3. زمان‌بندی سطح قطعه از خروجی مدل حفظ می‌شود؛ زمان‌بندی دقیق شروع/پایان هر واژه تا اتصال و اعتبارسنجی forced aligner مستقل، آمادهٔ انتشار نیست.
  4. پل تدوین هوشمند غیرمخرب \`NonDestructiveAudioEditingBridge\` با حفظ ۱۰۰٪ فایل اصلی، Undo/Redo، تطابق کامل Preview و Export و خروجی Adobe Audition SESX.
  5. سامانه عیب‌یابی حافظ حریم خصوصی (Privacy-Safe Diagnostics) و ثبت بازخورد محلی کاربران بتا.
`,
  'KNOWN-ISSUES.md': `# محدودیت‌ها و مسائل شناخته‌شده (Known Issues — v${RELEASE_VERSION})

1. **امضای دیجیتال Apple Developer ID**: بسته فعلی در محیط لینوکس بدون گواهی Apple Developer ID ساخته شده است؛ در macOS ممکن است نیاز به تأیید اجرای محلی (\`xattr -cr\`) باشد.
2. **تأیید GUI زنده Adobe Audition دسکتاپ**: پروتکل CEP، پل ارتباطی Companion و تولید فایل \`.sesx\` به‌صورت کامل تست شده‌اند، اما تست تعامل بصری داخل پنجره دسکتاپ Adobe Audition نیازمند ایستگاه کاری فیزیکی macOS/Windows است.
3. **تفکیک گویندگان (Speaker Diarization)**: نسخه فعلی روی تدوین تک‌گوینده یا تدوین یکپارچه چندگوینده تمرکز دارد و تفکیک خودکار گویندگان خارج از دامنه Phase 1C است.
`,
  'UPDATE-GUIDE.md': `# راهنمای به‌روزرسانی ایمن (Safe Update Guide)

سامانه \`AvapardazPackageUpdateManager\` به‌روزرسانی اتمیک را با مراحل زیر انجام می‌دهد:
1. بررسی عدم وجود نشست فعال تدوین (\`hasActiveSession === false\`).
2. اعتبارسنجی هش SHA-256 بسته به‌روزرسانی جدید پیش از اعمال.
3. تهیه نسخه پشتیبان کامل از نسخه فعلی در پوشه \`backups/<version>-<timestamp>\`.
4. جایگزینی اتمیک باینری‌ها و حفظ کامل پوشه \`user-data/\` (پروژه‌ها، تنظیمات، بازخوردها و لاگ‌ها).
5. اجرای خودکار Health Check پس از به‌روزرسانی؛ در صورت بروز خطا، بازگشت خودکار (Auto-Rollback) به نسخه قبلی انجام می‌شود.
`,
  'ROLLBACK-GUIDE.md': `# راهنمای بازگشت به نسخه قبلی (Rollback Guide)

در صورت بروز هرگونه ناسازگاری پس از به‌روزرسانی:
- **بازگشت خودکار**: اگر بررسی سلامت (Health Check) نسخه جدید ناموفق باشد، سیستم بلافاصله و بدون دخالت کاربر به نسخه پشتیبان قبلی برمی‌گردد.
- **بازگشت دستی**: کاربر یا مدیر سیستم می‌تواند از طریق متد \`rollbackToBackup()\` هر یک از نسخه‌های ذخیره‌شده در \`backups/\` را بازیابی کند، بدون اینکه داده‌های کاربر در \`user-data/\` تغییر کنند.
`,
  'UNINSTALLATION-GUIDE.md': `# راهنمای حذف نصب ایمن (Safe Uninstallation Guide)

نصاب آواپرداز دو حالت حذف نصب را پشتیبانی می‌کند:
1. **حذف استاندارد (\`STANDARD\` — پیش‌فرض)**:
   - دستور: \`node ./installer/uninstall.mjs --target=$HOME/AvaPardaz\`
   - تمام فایل‌های برنامه، موتور بومی، مدل ASR و افزونه CEP حذف می‌شوند، اما پوشه \`user-data/\` (پروژه‌ها و تنظیمات کاربر) حفظ می‌شود.
2. **حذف کامل (\`COMPLETE\`)**:
   - دستور: \`node ./installer/uninstall.mjs --complete --target=$HOME/AvaPardaz\`
   - علاوه بر فایل‌های برنامه، تمام داده‌های کاربری، کش‌ها و تنظیمات نیز به‌طور کامل پاک می‌شوند.
`,
  'LICENSE-NOTICES.md': `# اطلاعیه‌های مجوز و اجزای متن‌باز (License Notices)

1. **Sherpa-ONNX Runtime**: Apache License 2.0 (k2-fsa / Next-gen Kaldi).
2. **ONNX Runtime**: MIT License (Microsoft Corporation).
3. **Primary Persian ASR Model (\`Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx\`)**: NeMo FastConformer-CTC FP32, Apache License 2.0; bundled with upstream LICENSE and SHA-256 verification.
4. **Optional Persian ASR fallback (\`Reza2kn/Shenava-Rizeh\`)**: NeMo FastConformer-CTC INT8, subject to availability in the build environment.
5. **React / Vite / TypeScript / Lucide Icons**: MIT License.
`,
};

for (const [fileName, content] of Object.entries(docsMap)) {
  fs.writeFileSync(path.join(DOCS_OUT_DIR, fileName), content, 'utf8');
}

// 13. Write master release-artifacts-manifest.json
const artifactsManifest = {
  generatedAt: new Date().toISOString(),
  version: RELEASE_VERSION,
  nextUpdateVersion: NEXT_UPDATE_VERSION,
  buildId: BUILD_ID,
  packageDirectory: PKG_ROOT,
  installerTarball: {
    path: installerTarball,
    sha256: computeSha256(installerTarball),
    sizeBytes: fs.statSync(installerTarball).size,
  },
  updateTarball: {
    path: updateTarball,
    sha256: computeSha256(updateTarball),
    sizeBytes: fs.statSync(updateTarball).size,
  },
  docs: Object.keys(docsMap).map((name) => ({
    name,
    path: path.join(DOCS_OUT_DIR, name),
    sha256: computeSha256(path.join(DOCS_OUT_DIR, name)),
    sizeBytes: fs.statSync(path.join(DOCS_OUT_DIR, name)).size,
  })),
  packageManifest,
};

fs.writeFileSync(
  path.join(DIST_RELEASE, 'release-artifacts-manifest.json'),
  JSON.stringify(artifactsManifest, null, 2),
  'utf8'
);

console.log(`[AvaPardaz Packager] Successfully packaged release artifacts in ${DIST_RELEASE}:`);
console.log(`  - Installer Tarball: ${installerTarball} (${(artifactsManifest.installerTarball.sizeBytes / (1024 * 1024)).toFixed(2)} MiB)`);
console.log(`  - Update Tarball:    ${updateTarball} (${(artifactsManifest.updateTarball.sizeBytes / (1024 * 1024)).toFixed(2)} MiB)`);
