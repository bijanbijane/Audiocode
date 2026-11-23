import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAudioApiSecurityConfig, resolveServerBindHost } from '../security/AudioApiSecurityGuard';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('local Compose keeps the Express API on a real loopback bind in production mode', () => {
  const env = {
    NODE_ENV: 'production',
    AVAPARDAZ_DEPLOYMENT_MODE: 'local',
    AVAPARDAZ_BIND_HOST: '127.0.0.1',
  };
  const config = resolveAudioApiSecurityConfig(env);
  assert.equal(config.mode, 'local');
  assert.equal(resolveServerBindHost(env, config), '127.0.0.1');
});

test('hosted Express mode defaults to a non-loopback bind only when explicitly configured', () => {
  const env = {
    NODE_ENV: 'production',
    AVAPARDAZ_DEPLOYMENT_MODE: 'hosted',
  };
  const config = resolveAudioApiSecurityConfig(env);
  assert.equal(config.mode, 'hosted');
  assert.equal(resolveServerBindHost(env, config), '0.0.0.0');
});

test('API-only Hosted Express boot does not load Vite or its legacy Local Ed25519 signer', () => {
  const server = readServerSource();
  assert.ok(!server.includes("import { createServer as createViteServer } from 'vite';"));
  assert.ok(server.includes("const { createServer: createViteServer } = await import('vite');"));
  assert.ok(server.includes("if (process.env.DISABLE_EMBEDDED_VITE !== 'true')"));
  const apiEntrypoint = fs.readFileSync(path.resolve(repoRoot, 'scripts/start-api.ts'), 'utf8');
  assert.ok(apiEntrypoint.includes("env.DISABLE_EMBEDDED_VITE = 'true';"));
  assert.ok(apiEntrypoint.includes("env.DISABLE_WEB_HOST = 'true';"));
  assert.ok(server.includes('webServing=${webServingEnabled}'));
  assert.ok(server.includes("audioApiSecurityGuard.config.mode === 'local'"));
  assert.ok(server.includes('new PlatformLicenseService('));
  assert.ok(server.includes('const getLocalLicenseService = (): PlatformLicenseService =>'));
  assert.ok(server.includes('LOCAL_LICENSE_SIGNER_UNAVAILABLE_IN_HOSTED_MODE'));
  assert.ok(server.includes('forwardPlatformApiCompatibilityRequest'));
  assert.ok(server.includes("path: '/api/v1/crypto/public-key'"));
  assert.ok(server.includes("path: '/api/v1/license/lease'"));

  const startServer = server.indexOf('async function startServer()');
  const securityGuard = server.indexOf('const audioApiSecurityGuard = new AudioApiSecurityGuard();', startServer);
  const licenseServiceCreation = server.indexOf('new PlatformLicenseService(', startServer);
  assert.ok(securityGuard >= 0);
  assert.ok(licenseServiceCreation > securityGuard);
  assert.ok(server.slice(startServer, securityGuard).includes('DISABLE_EMBEDDED_VITE') === false);
});

function readServerSource(): string {
  return fs.readFileSync(path.resolve(repoRoot, 'server.ts'), 'utf8');
}
