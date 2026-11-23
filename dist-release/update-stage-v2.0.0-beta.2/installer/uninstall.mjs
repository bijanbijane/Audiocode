#!/usr/bin/env node
/**
 * AvaPardaz Safe Uninstaller (STANDARD vs COMPLETE mode)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const args = process.argv.slice(2);
const mode = args.includes('--complete') ? 'COMPLETE' : 'STANDARD';
const targetRootArg = args.find((a) => a.startsWith('--target='))?.split('=')[1];
const targetRoot = targetRootArg || path.join(os.homedir(), 'AvaPardaz');

const systemDirs = ['app', 'companion', 'runtime', 'models', 'cep-extension', 'backups', 'install-manifest.json'];
for (const item of systemDirs) {
  const p = path.join(targetRoot, item);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
if (mode === 'COMPLETE') {
  const userData = path.join(targetRoot, 'user-data');
  if (fs.existsSync(userData)) fs.rmSync(userData, { recursive: true, force: true });
}
console.log('[AvaPardaz Uninstaller] Completed in mode:', mode);
