import crypto from 'crypto';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

function collectDistAssets(baseDir: string, currentDir: string): Array<{path: string; bytes: number; sha256: string}> {
  const results: Array<{path: string; bytes: number; sha256: string}> = [];
  if (!fs.existsSync(currentDir)) return results;
  for (const entry of fs.readdirSync(currentDir, {withFileTypes: true})) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectDistAssets(baseDir, fullPath));
    } else if (entry.isFile() && entry.name !== 'release-manifest.json') {
      const buf = fs.readFileSync(fullPath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const rel = '/' + path.relative(baseDir, fullPath).split(path.sep).join('/');
      results.push({path: rel, bytes: buf.byteLength, sha256});
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export default defineConfig(({mode}) => {
  // In separate mode, the browser UI runs on its own Vite origin while API
  // requests are reverse-proxied to the independently running local/API server.
  // Keep this disabled in the legacy embedded-Vite mode to prevent proxy loops.
  const apiProxy = mode === 'separate'
    ? {
        '/api': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
        '/v1': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
        // The Fastify/PostgreSQL platform API gets a dedicated prefix.
        // Strip only this prefix; legacy /api and /v1 continue going to Express.
        '/platform-api': {
          target: process.env.PLATFORM_API_PROXY_TARGET ?? 'http://127.0.0.1:4000',
          changeOrigin: false,
          rewrite: (requestPath: string) => requestPath.replace(/^\/platform-api/, ''),
        },
      }
    : undefined;

  return {
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
      // Serves onnxruntime-web WASM/MJS runtime assets from /ort/ in dev
      // and copies them into dist/ort/ for production builds.
      {
        name: 'onnxruntime-web-ort-assets',
        configureServer(server) {
          const ortDistDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
          server.middlewares.use('/ort', (req, res, next) => {
            const rawUrl = req.url?.split('?')[0] ?? '/';
            const fileName = path.basename(rawUrl);
            if (!fileName || fileName === '/' || !fileName.startsWith('ort-wasm')) {
              next();
              return;
            }
            const targetPath = path.join(ortDistDir, fileName);
            if (!targetPath.startsWith(ortDistDir) || !fs.existsSync(targetPath)) {
              next();
              return;
            }
            if (fileName.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            } else if (fileName.endsWith('.mjs') || fileName.endsWith('.js')) {
              res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            }
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            fs.createReadStream(targetPath).pipe(res);
          });
        },
        closeBundle(error?: Error): void {
          if (error) return;
          const distOrtDir = path.resolve(__dirname, 'dist/ort');
          const ortDistDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
          if (!fs.existsSync(path.resolve(__dirname, 'dist')) || !fs.existsSync(ortDistDir)) {
            return;
          }
          fs.mkdirSync(distOrtDir, {recursive: true});
          for (const entry of fs.readdirSync(ortDistDir)) {
            if (entry.startsWith('ort-wasm') && (entry.endsWith('.wasm') || entry.endsWith('.mjs'))) {
              fs.copyFileSync(path.join(ortDistDir, entry), path.join(distOrtDir, entry));
            }
          }
        },
      },
      // Emits dist/release-manifest.json with real SHA-256 asset hashes and compatibility contract.
      {
        name: 'avapardaz-release-manifest',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) return;
          const distDir = path.resolve(__dirname, 'dist');
          if (!fs.existsSync(distDir)) return;
          const assets = collectDistAssets(distDir, distDir);
          const releaseManifest = {
            productName: 'Avapardaz',
            appVersion: '1.3.0',
            buildId: `build-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            builtAtIso: new Date().toISOString(),
            projectSchemaVersion: 2,
            edlSchemaVersion: 2,
            backupSchemaVersion: 1,
            modelManifestSchemaVersion: 1,
            renderCheckpointSchemaVersion: 1,
            supportedLocalModelRuntimes: ['onnxruntime-web-wasm'],
            serviceWorkerCacheVersion: 'paudio-shell-v1.3.0',
            assetCount: assets.length,
            totalBytes: assets.reduce((sum, item) => sum + item.bytes, 0),
            assets,
          };
          fs.writeFileSync(
            path.join(distDir, 'release-manifest.json'),
            JSON.stringify(releaseManifest, null, 2),
            'utf-8',
          );
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      ...(apiProxy ? {proxy: apiProxy} : {}),
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      strictPort: true,
      ...(apiProxy ? {proxy: apiProxy} : {}),
    },
    worker: {
      format: 'es' as const,
    },
  };
});
