import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  ModelLifecycleStatus,
  PlatformLicenseService,
  SubscriptionPlan,
} from './backend/src/PlatformLicenseService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();

  const licenseService = new PlatformLicenseService({
    privateKeyPem: process.env.ED25519_PRIVATE_KEY_PEM,
    publicKeyPem: process.env.ED25519_PUBLIC_KEY_PEM,
    keyVersion: 1,
  });

  // Preserve Cross-Origin Isolation so SharedArrayBuffer & OPFS SyncAccessHandle remain active
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  // Public Ed25519 SPKI key endpoint for offline client verification
  app.get('/api/v1/crypto/public-key', (_req, res) => {
    res.json(licenseService.getPublicKeyInfo());
  });

  // Issue cryptographically signed Ed25519 offline license lease
  app.post('/api/v1/license/lease', (req, res) => {
    const body = req.body as {
      userId?: unknown;
      displayName?: unknown;
      deviceFingerprint?: unknown;
      plan?: unknown;
      graceDays?: unknown;
    };

    if (typeof body?.userId !== 'string' || body.userId.trim().length === 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'userId is required' });
      return;
    }
    if (
      typeof body?.deviceFingerprint !== 'string' ||
      body.deviceFingerprint.trim().length === 0
    ) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'deviceFingerprint is required',
      });
      return;
    }

    const allowedPlans: SubscriptionPlan[] = ['FREE', 'PRO', 'ENTERPRISE'];
    const plan: SubscriptionPlan =
      typeof body.plan === 'string' && allowedPlans.includes(body.plan as SubscriptionPlan)
        ? (body.plan as SubscriptionPlan)
        : 'PRO';

    const graceDays =
      typeof body.graceDays === 'number' && Number.isFinite(body.graceDays)
        ? body.graceDays
        : 14;

    const envelope = licenseService.issueOfflineLicenseLease({
      userId: body.userId,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      deviceFingerprint: body.deviceFingerprint,
      plan,
      graceDays,
    });

    res.json(envelope);
  });

  // Signed chunked model registry manifest (supports ACTIVE, SUPPORTED, DEPRECATED, REVOKED)
  app.get('/api/v1/models/:modelId/manifest', (req, res) => {
    const { modelId } = req.params;
    const override = req.query.status as ModelLifecycleStatus | undefined;
    const allowedStatuses: ModelLifecycleStatus[] = [
      'ACTIVE',
      'SUPPORTED',
      'DEPRECATED',
      'REVOKED',
    ];
    const validOverride =
      override && allowedStatuses.includes(override) ? override : undefined;

    const envelope = licenseService.issueSignedModelManifestEnvelope(modelId, validOverride);
    if (!envelope) {
      res.status(404).json({ error: 'MODEL_NOT_FOUND', modelId });
      return;
    }

    res.json(envelope);
  });

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Avapardaz Express+Vite server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
