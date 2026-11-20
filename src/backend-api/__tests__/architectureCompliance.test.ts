/**
 * AVP-ARCH-001 (Version 4.0) — Automated Architectural Boundary & Dependency Direction Guard
 *
 * Enforces INV-001 (Host Independence) & INV-002 (UI Independence) statically across:
 * - src/processing-engine/
 * - src/asr-core/
 * - src/processing-core/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collectTsFiles(full));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN_IMPORT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'React UI framework', regex: /from\s+['"]react(-dom)?(\/[^'"]*)?['"]/ },
  { label: 'UI components layer', regex: /from\s+['"][^'"]*\/components(\/[^'"]*)?['"]/ },
  { label: 'Host bridge / Adobe Audition adapter', regex: /from\s+['"][^'"]*\/host-bridge(\/[^'"]*)?['"]/ },
  { label: 'CEP CSInterface runtime', regex: /CSInterface|cep_node|adobe\.audition/i },
  { label: 'Backend HTTP Express layer', regex: /from\s+['"]express['"]|from\s+['"][^'"]*\/backend-api(\/[^'"]*)?['"]/ },
];

test('AVP-ARCH-001 INV-001 & INV-002: Processing Core & ASR Core have zero UI, Host, CEP, or Express imports', () => {
  const root = process.cwd();
  const protectedDirs = [
    path.join(root, 'src', 'processing-engine'),
    path.join(root, 'src', 'asr-core'),
    path.join(root, 'src', 'processing-core'),
  ];

  const violations: string[] = [];
  let scannedCount = 0;

  for (const dir of protectedDirs) {
    for (const file of collectTsFiles(dir)) {
      scannedCount++;
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(root, file);
      for (const rule of FORBIDDEN_IMPORT_PATTERNS) {
        if (rule.regex.test(content)) {
          violations.push(`${rel} violates ${rule.label}`);
        }
      }
    }
  }

  assert.ok(scannedCount >= 10, `Expected to scan >= 10 core source files, scanned ${scannedCount}`);
  assert.deepEqual(violations, [], `Architectural boundary violations found:\n${violations.join('\n')}`);
});
