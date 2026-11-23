import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('separated web routes the dedicated platform prefix to Fastify and preserves Express routes', () => {
  const nginx = read('deploy/web/nginx.conf');
  const vite = read('vite.config.ts');

  assert.match(nginx, /location ^~ /platform-api/s*{/);
  assert.match(nginx, /proxy_pass http://avapardaz-platform-api:4000//);
  assert.match(nginx, /location ^~ /apis*{[sS]*?proxy_pass http://avapardaz-api:3000/);
  assert.match(nginx, /location ^~ /v1s*{[sS]*?proxy_pass http://avapardaz-api:3000/);

  assert.match(vite, /'/platform-api':s*{/);
  assert.match(vite, /PLATFORM_API_PROXY_TARGET[\s\S]*?127.0.0.1:4000/);
  assert.match(vite, /requestPath.replace(/^\\/platform-api//);
  assert.match(vite, /'/api':s*{/);
  assert.match(vite, /'/v1':s*{/);
});

test('three-runtime compose keeps Express and Platform API on separate services and keys', () => {
  const compose = read('deploy/docker-compose.separated.yml');

  assert.match(compose, /^  avapardaz-web:/m);
  assert.match(compose, /^  avapardaz-api:/m);
  assert.match(compose, /^  avapardaz-platform-api:/m);
  assert.match(compose, /^  postgres:/m);
  assert.match(compose, /LOCAL_ED25519_PRIVATE_KEY_PEM/);
  assert.match(compose, /PLATFORM_ED25519_PRIVATE_KEY_PEM/);
  assert.match(compose, /ENABLE_CLOUD_ASR: "false"/);
  assert.match(compose, /DISABLE_WEB_HOST: "true"/);
});
