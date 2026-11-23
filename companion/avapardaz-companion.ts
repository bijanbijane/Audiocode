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

import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { LocalCompanionService } from '../src/host-bridge/companion/LocalCompanionService';

const COMPANION_HOST = '127.0.0.1';
const RAW_COMPANION_PORT = Number(process.env.AVAPARDAZ_COMPANION_PORT || 47291);
if (!Number.isInteger(RAW_COMPANION_PORT) || RAW_COMPANION_PORT < 1024 || RAW_COMPANION_PORT > 65535) {
  console.error(
    JSON.stringify({
      event: 'AVAPARDAZ_COMPANION_INVALID_PORT',
      message: 'AVAPARDAZ_COMPANION_PORT must be an integer between 1024 and 65535.',
    }),
  );
  process.exit(1);
}
const COMPANION_PORT = RAW_COMPANION_PORT;
const LOCK_FILE_PATH =
  process.env.AVAPARDAZ_COMPANION_LOCK_PATH ||
  path.join(os.tmpdir(), `avapardaz-companion-${COMPANION_PORT}.lock`);

const app = express();
const companionService = new LocalCompanionService({
  bindHost: COMPANION_HOST,
  bindPort: COMPANION_PORT,
  lockFilePath: LOCK_FILE_PATH,
});

const lockRes = companionService.lifecycleManager.acquireSingleInstanceLock();
if (!lockRes.ok) {
  console.error(
    JSON.stringify({
      event: 'AVAPARDAZ_COMPANION_LOCK_CONFLICT',
      code: lockRes.code,
      message: lockRes.message,
    }),
  );
  process.exit(1);
}

app.use('/api/v2/companion', companionService.createExpressRouter());

const server = app.listen(COMPANION_PORT, COMPANION_HOST, () => {
  companionService.markServerBound();
  const health = companionService.getHealth();
  console.log(
    JSON.stringify({
      event: 'AVAPARDAZ_COMPANION_STARTED',
      bind: `${COMPANION_HOST}:${COMPANION_PORT}`,
      instanceId: health.instanceId,
      lifecycleState: health.lifecycleState,
      recoveredStaleLock: lockRes.recoveredStaleLock,
      serviceVersion: health.serviceVersion,
      ipcProtocolVersion: health.ipcProtocolVersion,
      runtimeAvailable: health.runtime.available,
      installedModelCount: health.runtime.installedModels.length,
      offlineOnlyEnforced: true,
    }),
  );
});

const shutdown = (signal: string) => {
  companionService.beginGracefulShutdown(`Signal ${signal}`);
  server.close(() => {
    companionService.lifecycleManager.transition('PROCESS_NOT_FOUND', 'HTTP server closed cleanly');
    console.log(JSON.stringify({ event: 'AVAPARDAZ_COMPANION_STOPPED', signal }));
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

