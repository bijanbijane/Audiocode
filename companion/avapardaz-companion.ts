#!/usr/bin/env node
/**
 * AVAPARDAZ — STANDALONE LOCAL COMPANION DAEMON
 *
 * Binds STRICTLY to 127.0.0.1 (loopback-only — never 0.0.0.0) so Adobe Audition CEP
 * plugins and local Web App sessions share one central local ASR engine with zero
 * cloud audio transmission.
 *
 * Usage:
 *   AVAPARDAZ_COMPANION_PORT=47291 npx tsx companion/avapardaz-companion.ts
 */

import express from 'express';
import { LocalCompanionService } from '../src/host-bridge/companion/LocalCompanionService';

const COMPANION_HOST = '127.0.0.1';
const COMPANION_PORT = Number(process.env.AVAPARDAZ_COMPANION_PORT || 47291);

const app = express();
const companionService = new LocalCompanionService();

app.use('/api/v2/companion', companionService.createExpressRouter());

const server = app.listen(COMPANION_PORT, COMPANION_HOST, () => {
  const health = companionService.getHealth();
  console.log(
    JSON.stringify({
      event: 'AVAPARDAZ_COMPANION_STARTED',
      bind: `${COMPANION_HOST}:${COMPANION_PORT}`,
      serviceVersion: health.serviceVersion,
      ipcProtocolVersion: health.ipcProtocolVersion,
      runtimeAvailable: health.runtime.available,
      installedModelCount: health.runtime.installedModels.length,
      offlineOnlyEnforced: true,
    }),
  );
});

const shutdown = (signal: string) => {
  companionService.neuralEngine.unloadActiveModel();
  server.close(() => {
    console.log(JSON.stringify({ event: 'AVAPARDAZ_COMPANION_STOPPED', signal }));
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
