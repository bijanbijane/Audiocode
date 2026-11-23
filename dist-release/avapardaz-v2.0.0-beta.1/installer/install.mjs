#!/usr/bin/env node
/**
 * AvaPardaz Zero-Terminal / Self-Contained Production Installer
 * Version: 2.0.0-beta.1 (avp-20261123-phase1ci-beta1)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

const args = process.argv.slice(2);
const targetRootArg = args.find((a) => a.startsWith('--target='))?.split('=')[1];
const targetRoot = targetRootArg || path.join(os.homedir(), 'AvaPardaz');
const payloadRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'payload');

function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.statSync(s).mode);
    }
  }
}

console.log('[AvaPardaz Installer] Installing AvaPardaz v2.0.0-beta.1 to:', targetRoot);
const dirs = [
  'app', 'companion', 'runtime/bin', 'runtime/lib',
  'models/shenava-rizeh-int8', 'cep-extension',
  'user-data/projects', 'user-data/settings', 'user-data/feedback',
  'user-data/diagnostics', 'user-data/logs', 'user-data/cache', 'backups'
];
for (const d of dirs) fs.mkdirSync(path.join(targetRoot, d), { recursive: true });

copyRecursive(path.join(payloadRoot, 'app'), path.join(targetRoot, 'app'));
copyRecursive(path.join(payloadRoot, 'companion'), path.join(targetRoot, 'companion'));
copyRecursive(path.join(payloadRoot, 'runtime'), path.join(targetRoot, 'runtime'));
copyRecursive(path.join(payloadRoot, 'models', 'shenava-rizeh-int8'), path.join(targetRoot, 'models', 'shenava-rizeh-int8'));
copyRecursive(path.join(payloadRoot, 'cep-extension'), path.join(targetRoot, 'cep-extension'));

console.log('[AvaPardaz Installer] Installation completed successfully.');
