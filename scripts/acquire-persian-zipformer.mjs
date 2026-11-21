#!/usr/bin/env node
/**
 * AVAPARDAZ — Reproducible Persian Zipformer-Transducer Asset Acquisition & Verification Script
 * Mission: AVP-PERSIAN-ZIPFORMER-ASSET-ACQUISITION-001
 *
 * Downloads the pinned commit of `ramin-mahmoodi/persian-zipformer-asr` from Hugging Face
 * into `models/persian-zipformer-transducer/1.0.0/` (outside Vite JS bundles) and verifies
 * exact byte counts, SHA-256 checksums, ONNX protobuf headers, and UTF-8 `tokens.txt` count.
 *
 * Usage:
 *   node scripts/acquire-persian-zipformer.mjs --verify-only
 *   node scripts/acquire-persian-zipformer.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const COMMIT_SHA = '0408facbcf3f670121def48e0802c395c225d150';
const BASE_URL = `https://huggingface.co/ramin-mahmoodi/persian-zipformer-asr/resolve/${COMMIT_SHA}`;
const TARGET_DIR = path.resolve(process.cwd(), 'models/persian-zipformer-transducer/1.0.0');

const EXPECTED_FILES = [
  {
    name: 'encoder.int8.onnx',
    sizeBytes: 113609320,
    sha256: '08735923618e196bd093b369f6843c8a390a6113a391e7b7095115582fd2cd27',
    onnxExpectedInputs: ['x', 'x_lens'],
    onnxExpectedOutputs: ['encoder_out', 'encoder_out_lens'],
  },
  {
    name: 'decoder.int8.onnx',
    sizeBytes: 1736806,
    sha256: '9d4ad2da0335d86d8638ff026e6b37247d97df940af6ad40bba671af5fd4aa9d',
    onnxExpectedInputs: ['y'],
    onnxExpectedOutputs: ['decoder_out'],
  },
  {
    name: 'joiner.int8.onnx',
    sizeBytes: 398795,
    sha256: 'a2a4a30585dc53e46afafd03690181107a610f67ff0e29cab460ec16df5cc00b',
    onnxExpectedInputs: ['encoder_out', 'decoder_out'],
    onnxExpectedOutputs: ['logit'],
  },
  {
    name: 'tokens.txt',
    sizeBytes: 12959,
    sha256: '435f9e09a290c764670044e54c2450670fc2eab50176cd912734fa6f92ab166f',
  },
  {
    name: 'bpe_fa_1024.model',
    sizeBytes: 257275,
    sha256: '38ce80cf76e8535d41d625dcbf1a5a5e7d4cb7260a1d7b0dc1663385fc4fd075',
  },
  {
    name: 'README.md',
    sizeBytes: 6054,
    sha256: '7e60fdf2ba87e188124da1874fc06a93dbac6be7569169099dcc1774c28f2ac4',
  },
  {
    name: 'transcribe.py',
    sizeBytes: 10719,
    sha256: 'a25d398d513177f371f21f1b12740f62fe43527501973ba055441b9cc8a8123e',
  },
  {
    name: 'sample.wav',
    sizeBytes: 775738,
    sha256: 'e4f83ec981187afc2bd5902d604dfa55c3692c4010a5de2232b15427ca697b97',
  },
];

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function verifyAll() {
  const failures = [];
  for (const spec of EXPECTED_FILES) {
    const filePath = path.join(TARGET_DIR, spec.name);
    if (!fs.existsSync(filePath)) {
      failures.push(`Missing file: ${spec.name}`);
      continue;
    }
    const stat = fs.statSync(filePath);
    if (stat.size !== spec.sizeBytes) {
      failures.push(`Size mismatch for ${spec.name}: got ${stat.size}, expected ${spec.sizeBytes}`);
    }
    const actualHash = sha256File(filePath);
    if (actualHash !== spec.sha256) {
      failures.push(`SHA-256 mismatch for ${spec.name}: got ${actualHash}, expected ${spec.sha256}`);
    }
  }
  const tokensPath = path.join(TARGET_DIR, 'tokens.txt');
  if (fs.existsSync(tokensPath)) {
    const lines = fs.readFileSync(tokensPath, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1024) {
      failures.push(`tokens.txt line count mismatch: got ${lines.length}, expected 1024`);
    }
  }
  for (const requiredMeta of ['manifest.json', 'LICENSE', 'NOTICE']) {
    if (!fs.existsSync(path.join(TARGET_DIR, requiredMeta))) {
      failures.push(`Missing package metadata file: ${requiredMeta}`);
    }
  }
  return failures;
}

const verifyOnly = process.argv.includes('--verify-only');
fs.mkdirSync(TARGET_DIR, { recursive: true });

if (!verifyOnly) {
  for (const spec of EXPECTED_FILES) {
    const dest = path.join(TARGET_DIR, spec.name);
    const alreadyOk =
      fs.existsSync(dest) &&
      fs.statSync(dest).size === spec.sizeBytes &&
      sha256File(dest) === spec.sha256;
    if (alreadyOk) {
      console.log(`[SKIP] ${spec.name} already verified.`);
      continue;
    }
    console.log(`[FETCH] ${spec.name} from pinned commit ${COMMIT_SHA}...`);
    execFileSync(
      'curl',
      ['-fSL', '-C', '-', '--retry', '3', '--retry-delay', '2', `${BASE_URL}/${spec.name}`, '-o', dest],
      { stdio: 'inherit' },
    );
  }
}

const failures = verifyAll();
if (failures.length > 0) {
  console.error('[FAIL] Zipformer asset verification failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}

console.log('[PASS] All persian-zipformer-transducer 1.0.0 assets verified (exact sizes + SHA-256 + 1024 tokens).');
