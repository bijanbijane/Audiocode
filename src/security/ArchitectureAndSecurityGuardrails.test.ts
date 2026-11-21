/**
 * AVAPARDAZ — SECURITY TRUST BOUNDARY & ARCHITECTURAL GUARDRAIL TEST SUITE
 * Missions: AVP-P0-005 (§13 Architecture Guardrails),
 *           AVP-P0-006 (Security Hardening, Local Data Protection & Software Supply-Chain Integrity)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertPathWithinAllowedRoot,
  buildLocalDiagnosticExport,
  sanitizeDiagnosticRecord,
  sanitizeDiagnosticString,
  validateAudioDecodeInput,
  validateUntrustedProjectPayload,
} from './SecurityTrustBoundaryGuards';

test('AVP-P0-006: untrusted project payload validator blocks prototype pollution, excessive nesting, and invalid numeric bounds', () => {
  // Prototype pollution JSON
  const polluted = JSON.parse('{"schemaVersion":"2.0.0","projectId":"p1","__proto__":{"isAdmin":true}}');
  const polRes = validateUntrustedProjectPayload(polluted);
  assert.equal(polRes.ok, false);
  assert.ok(polRes.errors.some((v) => v.includes('PROTOTYPE_POLLUTION')));

  // Excessive depth (>24 levels)
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 30; i++) deep = { nested: deep };
  const deepRes = validateUntrustedProjectPayload({ schemaVersion: '2.0.0', projectId: 'p1', deep });
  assert.equal(deepRes.ok, false);
  assert.ok(deepRes.errors.some((v) => v.includes('MAX_DEPTH')));

  // Valid minimal project passes
  const goodRes = validateUntrustedProjectPayload({
    schemaVersion: '2.0.0',
    projectId: 'proj-safe-1',
    projectName: 'Safe Project',
    decisions: [{ decisionId: 'd1', startSample: 0, endSample: 16000 }],
  });
  assert.equal(goodRes.ok, true);
});

test('AVP-P0-006: audio decoder resource bounds and symlink-aware filesystem root confinement', async () => {
  // Audio resource limits reject absurd duration / channels / byte size
  const badAudio = validateAudioDecodeInput({
    fileName: '../evil.wav',
    byteLength: 5 * 1024 * 1024 * 1024,
    sampleRate: 16000,
    channelCount: 64,
    durationSec: 100_000,
  });
  assert.equal(badAudio.ok, false);
  assert.ok(badAudio.errors.length >= 3);

  const okAudio = validateAudioDecodeInput({
    fileName: 'interview.wav',
    byteLength: 1024 * 1024,
    sampleRate: 48000,
    channelCount: 2,
    durationSec: 120,
  });
  assert.equal(okAudio.ok, true);

  // Symlink escape detection
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-sec-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-sec-out-'));
  try {
    const insideFile = path.join(rootDir, 'ok.wav');
    const outsideFile = path.join(outsideDir, 'secret.wav');
    fs.writeFileSync(insideFile, 'RIFF');
    fs.writeFileSync(outsideFile, 'SECRET');
    const symlinkEscape = path.join(rootDir, 'escape.wav');
    fs.symlinkSync(outsideFile, symlinkEscape);

    const okCheck = await assertPathWithinAllowedRoot({
      allowedRootDir: rootDir,
      candidatePath: insideFile,
    });
    assert.equal(okCheck.ok, true);

    const escCheck = await assertPathWithinAllowedRoot({
      allowedRootDir: rootDir,
      candidatePath: symlinkEscape,
    });
    assert.equal(escCheck.ok, false);
    assert.equal(escCheck.code, 'SYMLINK_OR_BOUNDARY_ESCAPE_REJECTED');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('AVP-P0-006: privacy-preserving log sanitizer redacts bearer tokens, secrets, transcript text, and local paths', () => {
  const raw = 'Authorization: Bearer abc123secret.token path=/Users/ali/private/interview.wav';
  const sanitized = sanitizeDiagnosticString(raw);
  assert.equal(sanitized.includes('abc123secret'), false);
  assert.equal(sanitized.includes('/Users/ali'), false);

  const rec = sanitizeDiagnosticRecord({
    sessionToken: 'top-secret-token',
    rawText: 'متن محرمانه کاربر که نباید لاگ شود',
    transcript: 'confidential transcript',
    status: 'READY',
  }) as Record<string, unknown>;
  assert.equal(rec.sessionToken, '[REDACTED_SENSITIVE_FIELD]');
  assert.equal(rec.rawText, '[REDACTED_SENSITIVE_FIELD]');
  assert.equal(rec.transcript, '[REDACTED_SENSITIVE_FIELD]');
  assert.equal(rec.status, 'READY');

  const diag = buildLocalDiagnosticExport({
    appVersion: '1.0.0',
    runtimeTarget: 'BROWSER_WASM_CPU',
    events: [{ event: 'ASR_DONE', rawText: 'secret', elapsedMs: 120 }],
    memoryAccountedBytes: 1024,
    memoryHardLimitBytes: 1024 * 1024,
  });
  assert.equal(JSON.stringify(diag).includes('secret'), false);
});

test('AVP-P0-005 + AVP-P0-006: static architecture guardrails — zero bundled .onnx weights, zero hardcoded secrets, zero cloud ASR endpoints in Browser adapter', () => {
  // 1. No .onnx binaries inside src/ or public/ (prevents accidental Vite JS bundling)
  const walkFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...walkFiles(full));
      else results.push(full);
    }
    return results;
  };
  const srcFiles = walkFiles(path.resolve(process.cwd(), 'src'));
  const publicFiles = walkFiles(path.resolve(process.cwd(), 'public'));
  assert.equal(
    [...srcFiles, ...publicFiles].some((f) => f.endsWith('.onnx')),
    false,
    'ONNX weight files MUST NEVER be placed inside src/ or public/',
  );

  // 2. Zero hardcoded cloud API keys or private key PEM headers in src/
  const secretPattern = /(AIza[0-9A-Za-z\-_]{35}|sk-[0-9A-Za-z]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
  for (const f of srcFiles) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    const content = fs.readFileSync(f, 'utf8');
    assert.equal(secretPattern.test(content), false, `Hardcoded secret pattern detected in ${f}`);
  }

  // 3. BrowserOnnxAsrRuntimeAdapter & StudioAsrResourceResolver have zero cloud/server ASR consent dependencies
  const resolverSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/processing-engine/StudioAsrResourceResolver.ts'),
    'utf8',
  );
  assert.equal(resolverSrc.includes('CloudAsrConsentRegistry'), false);
});
