import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('separated web sends the new platform prefix to Fastify and leaves legacy APIs on Express', () => {
  const nginx = read('deploy/web/nginx.conf');
  const vite = read('vite.config.ts');

  assert.ok(nginx.includes('location ^~ /platform-api/ {'));
  assert.ok(nginx.includes('proxy_pass http://avapardaz-platform-api:4000/;'));
  assert.ok(nginx.includes('proxy_pass http://127.0.0.1:3000;'));
  assert.ok(nginx.includes('X-Content-Type-Options "nosniff"'));
  assert.ok(nginx.includes('X-Frame-Options "DENY"'));
  assert.ok(nginx.includes('Referrer-Policy "strict-origin-when-cross-origin"'));
  assert.ok(nginx.includes('Permissions-Policy "camera=(), geolocation=(), microphone=(self)"'));
  assert.ok(nginx.includes('location ^~ /api {'));
  assert.ok(nginx.includes('location ^~ /v1 {'));

  const platformLocation = nginx.slice(nginx.indexOf('location ^~ /platform-api/ {'));
  assert.ok(platformLocation.indexOf('proxy_pass http://avapardaz-platform-api:4000/;') > 0);
  const apiLocation = nginx.slice(nginx.indexOf('location ^~ /api {'));
  assert.ok(apiLocation.includes('proxy_pass http://127.0.0.1:3000;'));
  const v1Location = nginx.slice(nginx.indexOf('location ^~ /v1 {'));
  assert.ok(v1Location.includes('proxy_pass http://127.0.0.1:3000;'));

  assert.ok(vite.includes("'/platform-api': {"));
  assert.ok(vite.includes("process.env.PLATFORM_API_PROXY_TARGET ?? 'http://127.0.0.1:4000'"));
  assert.ok(vite.includes("requestPath.replace(/^\\/platform-api/, '')"));
  assert.ok(vite.includes("'/api': {"));
  assert.ok(vite.includes("'/v1': {"));
});

test('three-runtime compose keeps Web, Express, Fastify and PostgreSQL isolated', () => {
  const compose = read('deploy/docker-compose.separated.yml');

  assert.ok(compose.includes('  avapardaz-web:'));
  assert.ok(compose.includes('  avapardaz-api:'));
  assert.ok(compose.includes('  avapardaz-platform-api:'));
  assert.ok(compose.includes('network_mode: "service:avapardaz-web"'));
  assert.ok(compose.includes('AVAPARDAZ_DEPLOYMENT_MODE: "local"'));
  assert.ok(compose.includes('AVAPARDAZ_BIND_HOST: "127.0.0.1"'));
  assert.ok(compose.includes('platform_model_chunks:/var/lib/paudio/platform-models:ro'));
  assert.ok(compose.includes('  postgres:'));
  assert.ok(compose.includes('LOCAL_ED25519_PRIVATE_KEY_PEM'));
  assert.ok(compose.includes('PLATFORM_ED25519_PRIVATE_KEY_PEM'));
  assert.ok(compose.includes('ENABLE_CLOUD_ASR: "false"'));
  assert.ok(compose.includes('DISABLE_WEB_HOST: "true"'));
  assert.ok(compose.includes('backend/Dockerfile.platform-api'));
});

test('container definitions keep the local audio runtime and Platform API reproducible', () => {
  const localApiDockerfile = read('backend/Dockerfile.api');
  const platformApiDockerfile = read('backend/Dockerfile.platform-api');

  assert.ok(localApiDockerfile.includes('apt-get install -y --no-install-recommends'));
  assert.ok(localApiDockerfile.includes('ca-certificates ffmpeg libgomp1'));
  assert.ok(localApiDockerfile.includes('FFMPEG_BINARY_PATH=/usr/bin/ffmpeg'));

  for (const [index, line] of localApiDockerfile.split('\n').entries()) {
    const trailing = line.match(/\\+$/)?.[0].length ?? 0;
    if (trailing > 0) {
      assert.equal(trailing, 1, `Dockerfile.api line ${index + 1} has an invalid continuation`);
    }
  }

  assert.ok(platformApiDockerfile.includes('COPY backend/package-lock.json ./package-lock.json'));
  assert.ok(platformApiDockerfile.includes('RUN npm ci --omit=dev --no-audit --no-fund'));
  assert.ok(!platformApiDockerfile.includes('npm install --omit=dev'));
});
