import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHAHAB_KOOCHIK_MODEL_PROVENANCE = Object.freeze({
  repository: 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx',
  revision: '158e40e9ccf166c3655b7f4cd2abbfc7bbc87f7a',
  licenseId: 'apache-2.0',
  model: Object.freeze({
    fileName: 'model.onnx',
    bytes: 458_819_249,
    sha256: '6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d',
  }),
  tokens: Object.freeze({
    fileName: 'tokens.txt',
    bytes: 12_236,
    sha256: '8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954',
  }),
  readmeFileName: 'README.md',
  licenseFileName: 'LICENSE',
  manifestFileName: 'model-manifest.json',
});

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function validateKoochikModelLicense(readmeText, licenseText) {
  const frontMatter = readmeText.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!frontMatter) throw new Error('KOOCHIK_MODEL_README_FRONTMATTER_MISSING');
  const licenseMatch = frontMatter[1].match(/^license:\s*([^\s#]+)/im);
  const licenseId = licenseMatch?.[1]?.trim().toLowerCase();
  if (licenseId !== SHAHAB_KOOCHIK_MODEL_PROVENANCE.licenseId) {
    throw new Error(\`KOOCHIK_MODEL_LICENSE_METADATA_MISMATCH: expected apache-2.0, received \${licenseId ?? 'missing'}\`);
  }
  if (
    !licenseText.includes('Apache License')
    || !licenseText.includes('Version 2.0, January 2004')
    || !licenseText.includes('www.apache.org/licenses/')
  ) {
    throw new Error('KOOCHIK_MODEL_LICENSE_FILE_INVALID');
  }
  return { licenseId: 'apache-2.0', licenseName: 'Apache License 2.0' };
}

export function createKoochikModelManifest(modelDir) {
  const modelPath = path.join(modelDir, SHAHAB_KOOCHIK_MODEL_PROVENANCE.model.fileName);
  const tokensPath = path.join(modelDir, SHAHAB_KOOCHIK_MODEL_PROVENANCE.tokens.fileName);
  const readmePath = path.join(modelDir, SHAHAB_KOOCHIK_MODEL_PROVENANCE.readmeFileName);
  const licensePath = path.join(modelDir, SHAHAB_KOOCHIK_MODEL_PROVENANCE.licenseFileName);
  for (const filePath of [modelPath, tokensPath, readmePath, licensePath]) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`KOOCHIK_MODEL_REQUIRED_FILE_MISSING: ${path.basename(filePath)}`);
    }
  }

  const modelStat = fs.statSync(modelPath);
  const tokensStat = fs.statSync(tokensPath);
  const modelSha256 = sha256File(modelPath);
  const tokensSha256 = sha256File(tokensPath);
  if (modelStat.size !== SHAHAB_KOOCHIK_MODEL_PROVENANCE.model.bytes || modelSha256 !== SHAHAB_KOOCHIK_MODEL_PROVENANCE.model.sha256) {
    throw new Error('KOOCHIK_MODEL_ONNX_INTEGRITY_FAILED');
  }
  if (tokensStat.size !== SHAHAB_KOOCHIK_MODEL_PROVENANCE.tokens.bytes || tokensSha256 !== SHAHAB_KOOCHIK_MODEL_PROVENANCE.tokens.sha256) {
    throw new Error('KOOCHIK_MODEL_TOKENS_INTEGRITY_FAILED');
  }

  const readmeText = fs.readFileSync(readmePath, 'utf8');
  const licenseText = fs.readFileSync(licensePath, 'utf8');
  const license = validateKoochikModelLicense(readmeText, licenseText);
  const files = {};
  for (const [name, filePath] of [
    [SHAHAB_KOOCHIK_MODEL_PROVENANCE.model.fileName, modelPath],
    [SHAHAB_KOOCHIK_MODEL_PROVENANCE.tokens.fileName, tokensPath],
    [SHAHAB_KOOCHIK_MODEL_PROVENANCE.readmeFileName, readmePath],
    [SHAHAB_KOOCHIK_MODEL_PROVENANCE.licenseFileName, licensePath],
  ]) {
    files[name] = { bytes: fs.statSync(filePath).size, sha256: sha256File(filePath) };
  }

  return {
    schemaVersion: 1,
    modelId: 'shahab-koochik-v1.0-sherpa-onnx',
    repository: SHAHAB_KOOCHIK_MODEL_PROVENANCE.repository,
    revision: SHAHAB_KOOCHIK_MODEL_PROVENANCE.revision,
    licenseId: license.licenseId,
    files,
    provisionedAt: new Date().toISOString(),
  };
}

export function verifyKoochikModelDirectory(modelDir) {
  const manifestPath = path.join(modelDir, SHAHAB_KOOCHIK_MODEL_PROVENANCE.manifestFileName);
  if (!fs.existsSync(manifestPath)) throw new Error('KOOCHIK_MODEL_MANIFEST_MISSING');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = createKoochikModelManifest(modelDir);
  if (
    manifest.schemaVersion !== expected.schemaVersion
    || manifest.modelId !== expected.modelId
    || manifest.repository !== expected.repository
    || manifest.revision !== expected.revision
    || manifest.licenseId !== expected.licenseId
    || JSON.stringify(manifest.files) !== JSON.stringify(expected.files)
  ) {
    throw new Error('KOOCHIK_MODEL_MANIFEST_PROVENANCE_MISMATCH');
  }
  return { manifest, manifestPath, manifestSha256: sha256File(manifestPath) };
}
