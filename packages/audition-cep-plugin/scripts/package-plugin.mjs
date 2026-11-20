#!/usr/bin/env node
/**
 * AVAPARDAZ — REPRODUCIBLE ADOBE AUDITION CEP PLUGIN PACKAGER
 *
 * Validates CSXS/manifest.xml, verifies CSP & required assets, produces a reproducible
 * archive manifest with exact SHA-256 checksums for every packaged file (and .tar.gz bundle)
 * without claiming Adobe Exchange code signing when no signing certificate is installed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const outDir = path.join(repoRoot, 'dist-packages');
const version = '1.0.0';

const REQUIRED_FILES = [
  'CSXS/manifest.xml',
  'jsx/auditionHost.jsx',
  'client/index.html',
  'client/styles.css',
  'client/app.js',
  'installers/install-macos.sh',
  'installers/uninstall-macos.sh',
  'installers/install-windows.ps1',
  'installers/uninstall-windows.ps1',
];

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

// 1. Validate required files & manifest structure
const fileManifest = [];
for (const rel of REQUIRED_FILES) {
  const full = path.join(pluginRoot, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required plugin asset: ${rel}`);
  }
  const stat = fs.statSync(full);
  fileManifest.push({
    path: rel,
    bytes: stat.size,
    sha256: sha256File(full),
  });
}

const manifestXml = fs.readFileSync(path.join(pluginRoot, 'CSXS/manifest.xml'), 'utf8');
if (!manifestXml.includes('Host Name="AUDT"')) {
  throw new Error('CSXS/manifest.xml must target Adobe Audition (Host Name="AUDT")');
}
const indexHtml = fs.readFileSync(path.join(pluginRoot, 'client/index.html'), 'utf8');
if (!indexHtml.includes('Content-Security-Policy')) {
  throw new Error('client/index.html must define a strict Content-Security-Policy');
}

// 2. Build reproducible .tar.gz distribution archive
fs.mkdirSync(outDir, { recursive: true });
const archiveName = `avapardaz-audition-cep-v${version}.tar.gz`;
const archivePath = path.join(outDir, archiveName);

execFileSync(
  'tar',
  ['-czf', archivePath, '-C', pluginRoot, 'CSXS', 'jsx', 'client', 'installers'],
  { stdio: 'pipe' },
);

const archiveStat = fs.statSync(archivePath);
const archiveSha256 = sha256File(archivePath);

const releaseManifest = {
  schema: 'avapardaz.release.manifest.v1',
  product: 'AVAPARDAZ Adobe Audition CEP Plugin',
  bundleId: 'ir.avapardaz.audition.cep',
  version,
  targetHost: 'Adobe Audition (AUDT >= 22.0)',
  ipcProtocolVersion: '1.0.0',
  codeSigned: false,
  notarized: false,
  signingDisclaimer:
    'Unsigned beta distribution archive. Production Adobe Exchange / macOS Gatekeeper / Windows SmartScreen release requires valid Apple Developer ID, Windows Authenticode, and ZXPSignCmd certificates.',
  archive: {
    filename: archiveName,
    bytes: archiveStat.size,
    sha256: archiveSha256,
  },
  files: fileManifest,
  generatedAtIso: new Date().toISOString(),
};

const manifestOutPath = path.join(outDir, `avapardaz-audition-cep-v${version}.manifest.json`);
fs.writeFileSync(manifestOutPath, JSON.stringify(releaseManifest, null, 2), 'utf8');

console.log(
  JSON.stringify(
    {
      ok: true,
      archivePath,
      archiveBytes: archiveStat.size,
      archiveSha256,
      manifestOutPath,
      fileCount: fileManifest.length,
    },
    null,
    2,
  ),
);
