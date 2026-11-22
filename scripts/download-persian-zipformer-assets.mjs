#!/usr/bin/env node
/**
 * Fetches the exact upstream files declared by the pinned Persian Zipformer
 * manifest. Downloads are build-time only: model binaries are never committed.
 * Every downloaded or pre-existing hashed file is verified by exact byte count
 * and SHA-256 before the script exits successfully.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rm, rename, readFile } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const defaultManifestPath = 'models/persian-zipformer-transducer/1.0.0/manifest.json';
const manifestPath = path.resolve(process.cwd(), process.argv[2] ?? defaultManifestPath);
const packageDirectory = path.dirname(manifestPath);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function digestFile(filePath) {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    byteLength += chunk.byteLength;
    hash.update(chunk);
  }
  return { byteLength, sha256: hash.digest('hex') };
}

function assertSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe model asset path in manifest: ${String(relativePath)}`);
  }
}

async function downloadAndVerify(entry, repository, revision) {
  assertSafeRelativePath(entry.path);
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
    throw new Error(`Missing valid expected size for model file ${entry.path}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '')) {
    throw new Error(`Missing valid SHA-256 for model file ${entry.path}`);
  }

  const destination = path.resolve(packageDirectory, entry.path);
  if (!destination.startsWith(packageDirectory + path.sep)) {
    throw new Error(`Model asset escapes package directory: ${entry.path}`);
  }

  if (await exists(destination)) {
    const actual = await digestFile(destination);
    if (actual.byteLength !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
      throw new Error(
        `Existing model asset failed integrity check: ${entry.path} ` +
        `(bytes ${actual.byteLength}/${entry.sizeBytes}, sha256 ${actual.sha256}/${entry.sha256})`,
      );
    }
    console.log(`verified existing ${entry.path} (${actual.byteLength} bytes)`);
    return;
  }

  const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
  const baseRepository = repository.endsWith('/') ? repository.slice(0, -1) : repository;
  const url = `${baseRepository}/resolve/${revision}/${encodedPath}?download=true`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed for ${entry.path}: HTTP ${response.status}`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.download-${process.pid}`;
  const hash = createHash('sha256');
  let byteLength = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      byteLength += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      verifier,
      createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    const sha256 = hash.digest('hex');
    if (byteLength !== entry.sizeBytes || sha256 !== entry.sha256) {
      throw new Error(
        `Downloaded model asset failed integrity check: ${entry.path} ` +
        `(bytes ${byteLength}/${entry.sizeBytes}, sha256 ${sha256}/${entry.sha256})`,
      );
    }
    await rename(temporaryPath, destination);
    console.log(`downloaded and verified ${entry.path} (${byteLength} bytes)`);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const repository = manifest.upstream?.repository;
  const revision = manifest.upstream?.commitSha;
  if (
    typeof repository !== 'string' ||
    !repository.startsWith('https://huggingface.co/') ||
    !/^[a-f0-9]{40}$/i.test(revision ?? '')
  ) {
    throw new Error('Pinned Hugging Face repository/revision is missing or invalid in manifest.json');
  }

  const hashedEntries = (manifest.files ?? []).filter(
    (entry) => Number.isSafeInteger(entry.sizeBytes) && typeof entry.sha256 === 'string',
  );
  if (hashedEntries.length === 0) {
    throw new Error('No SHA-256-pinned model assets are declared in manifest.json');
  }

  console.log(`Verifying ${hashedEntries.length} model assets from ${repository} at ${revision}`);
  for (const entry of hashedEntries) {
    await downloadAndVerify(entry, repository, revision);
  }

  // Required non-hashed legal/attribution files must still be present.
  const requiredAttributionFiles = manifest.requiredAttributionFiles ?? ['LICENSE', 'NOTICE'];
  for (const requiredName of requiredAttributionFiles) {
    if (!(await exists(path.join(packageDirectory, requiredName)))) {
      throw new Error(`Required model attribution file is missing: ${requiredName}`);
    }
  }
  console.log('Persian Zipformer assets are complete and SHA-256 verified.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
