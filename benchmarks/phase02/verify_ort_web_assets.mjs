#!/usr/bin/env node
/**
 * AVAPARDAZ — PHASE-02 Browser Runtime Asset Provenance Verifier
 * Measures exact byte sizes and 64-hex SHA-256 digests of installed onnxruntime-web
 * WASM runtime binaries in node_modules/onnxruntime-web/dist/.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.cwd(), 'node_modules/onnxruntime-web/dist');
const pkgPath = path.resolve(process.cwd(), 'node_modules/onnxruntime-web/package.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const wasmFiles = fs
  .readdirSync(distDir)
  .filter((f) => f.endsWith('.wasm'))
  .sort();

const assets = wasmFiles.map((file) => {
  const full = path.join(distDir, file);
  const buf = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    file,
    bytes: buf.byteLength,
    mib: Number((buf.byteLength / (1024 * 1024)).toFixed(2)),
    sha256,
  };
});

console.log(
  JSON.stringify(
    {
      package: pkg.name,
      version: pkg.version,
      license: pkg.license,
      publicOrtProvisioned: fs.existsSync(path.resolve(process.cwd(), 'public/ort')),
      wasmAssets: assets,
    },
    null,
    2,
  ),
);
