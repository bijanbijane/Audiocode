import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOT = path.resolve(process.cwd());

function readWorkspaceFile(relativePath: string): string {
  const fullPath = path.join(WORKSPACE_ROOT, relativePath);
  assert.equal(fs.existsSync(fullPath), true, `Expected file to exist: ${relativePath}`);
  return fs.readFileSync(fullPath, 'utf8');
}

test('Section 31: Nginx config enforces COOP/COEP, wasm-unsafe-eval CSP, Byte-Range models, and consistent security-header inheritance', () => {
  const securityHeaders = readWorkspaceFile('deploy/nginx/security-headers.conf');
  const nginxConf = readWorkspaceFile('deploy/nginx/nginx.conf');

  // Cross-Origin Isolation headers required for SharedArrayBuffer & Wasm audio ring buffer
  assert.match(securityHeaders, /add_header\s+Cross-Origin-Opener-Policy\s+"same-origin"\s+always;/);
  assert.match(securityHeaders, /add_header\s+Cross-Origin-Embedder-Policy\s+"require-corp"\s+always;/);
  assert.match(securityHeaders, /add_header\s+Cross-Origin-Resource-Policy\s+"same-origin"\s+always;/);

  // Strict CSP allowing WebAssembly instantiation while disallowing arbitrary eval/remote connect
  assert.match(securityHeaders, /script-src\s+'self'\s+'wasm-unsafe-eval'/);
  assert.match(securityHeaders, /worker-src\s+'self'\s+blob:/);
  assert.match(securityHeaders, /connect-src\s+'self'/);
  assert.match(securityHeaders, /frame-ancestors\s+'none'/);

  // MIME type, Range resume for 8MB model shards, and backend /api/ reverse proxy
  assert.match(nginxConf, /application\/wasm\s+wasm;/);
  assert.match(nginxConf, /location\s+\/models\/\s*\{[\s\S]*Accept-Ranges\s+"bytes"\s+always;/);
  assert.match(nginxConf, /location\s+\/models\/\s*\{[\s\S]*immutable/);
  assert.match(nginxConf, /location\s+\/api\/\s*\{[\s\S]*proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/);

  // Guard against Nginx add_header shadowing pitfall: every location defining add_header must include security-headers.conf
  const locationBlocks = nginxConf.match(/location\s+[^\s{]+\s*\{[\s\S]*?\n\s*\}/g) ?? [];
  assert.ok(locationBlocks.length >= 4, 'Expected /models/, /assets/, /api/, and / location blocks');
  for (const block of locationBlocks) {
    if (block.includes('add_header')) {
      assert.match(
        block,
        /include\s+\/etc\/nginx\/conf\.d\/security-headers\.conf;/,
        `Location block with add_header must re-include security-headers.conf:\n${block}`,
      );
    }
  }
});

test('Section 31: Multi-stage Dockerfile aligns with workspace paths and runs non-root Nginx', () => {
  const dockerfile = readWorkspaceFile('deploy/Dockerfile');

  assert.match(dockerfile, /COPY\s+wasm-audio-core\s+\.\/wasm-audio-core/);
  assert.match(dockerfile, /wasm-pack\s+build\s+wasm-audio-core/);
  assert.match(dockerfile, /COPY\s+package\.json/);
  assert.match(dockerfile, /npm\s+run\s+lint/);
  assert.match(dockerfile, /npm\s+run\s+build/);
  assert.match(dockerfile, /FROM\s+nginxinc\/nginx-unprivileged:/);
  assert.match(dockerfile, /USER\s+nginx/);

  // Must not reference non-existent monorepo paths
  assert.equal(dockerfile.includes('apps/web-studio'), false);
  assert.equal(dockerfile.includes('pnpm-lock.yaml'), false);
});

test('Section 32: cargo-deny policy bans copyleft licenses and wildcards while allowing commercial-safe audio crates', () => {
  const denyToml = readWorkspaceFile('wasm-audio-core/deny.toml');

  assert.match(denyToml, /yanked\s*=\s*"deny"/);
  assert.match(denyToml, /wildcards\s*=\s*"deny"/);
  assert.match(denyToml, /unknown-registry\s*=\s*"deny"/);
  assert.match(denyToml, /unknown-git\s*=\s*"deny"/);

  for (const license of ['MIT', 'Apache-2.0', 'MPL-2.0', 'BSD-3-Clause']) {
    assert.ok(denyToml.includes(`"${license}"`), `Expected commercial allowlist license: ${license}`);
  }
  for (const forbidden of ['"GPL-2.0"', '"GPL-3.0"', '"AGPL-3.0"']) {
    assert.equal(denyToml.includes(forbidden), false, `Forbidden copyleft license in allowlist: ${forbidden}`);
  }
});

test('Section 32: CI Quality Gate workflow audits Rust licenses, circular deps, SBOM, tests, and build', () => {
  const workflow = readWorkspaceFile('.github/workflows/ci-quality-gate.yml');

  assert.match(workflow, /EmbarkStudios\/cargo-deny-action@v2/);
  assert.match(workflow, /manifest-path:\s*wasm-audio-core\/Cargo\.toml/);
  assert.match(workflow, /madge\s+--circular\s+--extensions\s+ts,tsx\s+src\/\s+packages\//);
  assert.match(workflow, /bunx\s+--bun\s+@cdxgen\/cdxgen\s+-t\s+bun\s+-o\s+sbom-bun\.cdx\.json/);
  assert.match(workflow, /npm\s+run\s+lint/);
  assert.match(workflow, /tsx\s+--test/);
  assert.match(workflow, /npm\s+run\s+build/);
});

test('Section 33: Engineering Execution Playbook covers Weeks 1-4 PoC gates and real workspace modules', () => {
  const playbook = readWorkspaceFile('docs/playbook/ENGINEERING_EXECUTION_PLAYBOOK.md');

  for (const milestone of ['هفته اول', 'هفته دوم', 'هفته سوم', 'هفته چهارم']) {
    assert.ok(playbook.includes(milestone), `Missing playbook milestone: ${milestone}`);
  }
  for (const realArtifact of [
    'wasm-audio-core/deny.toml',
    'deploy/nginx/nginx.conf',
    'deploy/Dockerfile',
    '.github/workflows/ci-quality-gate.yml',
    'src/ai-engine/PersianDisfluencyEngine.ts',
    'src/runtime/HardwareBenchmarkProfiler.ts',
    'src/quality-gate/AutomatedQualityGateRunner.ts',
    'backend/src/PlatformLicenseService.ts',
  ]) {
    assert.ok(playbook.includes(realArtifact), `Playbook must reference real file: ${realArtifact}`);
    assert.equal(fs.existsSync(path.join(WORKSPACE_ROOT, realArtifact)), true, `Referenced file missing: ${realArtifact}`);
  }
  for (const symbol of ['AudioRestorationEngine', 'StreamingExportEncoder']) {
    assert.ok(playbook.includes(symbol), `Playbook must reference core engine: ${symbol}`);
  }
});
