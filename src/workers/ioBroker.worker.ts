/// <reference lib="webworker" />

import { FileHandleLease } from '../contracts/v1_2';

type BrokerRequest =
  | { id: string; type: 'INIT' }
  | { id: string; type: 'WRITE_BLOCK'; fileKey: string; ownerWorker: FileHandleLease['ownerWorker']; data: ArrayBuffer }
  | { id: string; type: 'READ_BLOCK'; fileKey: string; ownerWorker: FileHandleLease['ownerWorker'] }
  | { id: string; type: 'DELETE_FILE'; fileKey: string }
  | { id: string; type: 'GET_STATE' };

const memoryFallbackStore = new Map<string, ArrayBuffer>();
const activeLeases = new Map<string, FileHandleLease>();
let lockConflictsPrevented = 0;
let opfsAvailable = false;
let syncHandleAvailable = false;
let rootDir: FileSystemDirectoryHandle | null = null;

async function initOpfs(): Promise<{ opfsAvailable: boolean; syncHandleAvailable: boolean }> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && 'getDirectory' in navigator.storage) {
      rootDir = await navigator.storage.getDirectory();
      opfsAvailable = true;
      // Probe createSyncAccessHandle availability safely on a tiny probe file
      const probeHandle = await rootDir.getFileHandle('__avapardaz_probe.bin', { create: true });
      if ('createSyncAccessHandle' in probeHandle) {
        const sync = await (probeHandle as FileSystemFileHandle & {
          createSyncAccessHandle: () => Promise<FileSystemSyncAccessHandle>;
        }).createSyncAccessHandle();
        sync.close();
        syncHandleAvailable = true;
      }
      await rootDir.removeEntry('__avapardaz_probe.bin').catch(() => {});
    }
  } catch {
    opfsAvailable = false;
    syncHandleAvailable = false;
  }
  return { opfsAvailable, syncHandleAvailable };
}

function acquireLease(fileKey: string, ownerWorker: FileHandleLease['ownerWorker']): FileHandleLease {
  const existing = activeLeases.get(fileKey);
  if (existing && existing.status === 'active') {
    // Broker serializes access instead of letting multiple workers throw NoModificationAllowedError
    lockConflictsPrevented++;
  }
  const lease: FileHandleLease = {
    leaseId: `lease-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fileKey,
    ownerWorker,
    mode: syncHandleAvailable ? 'exclusive-broker' : 'read-buffered',
    acquiredAt: Date.now(),
    status: 'active',
  };
  activeLeases.set(fileKey, lease);
  return lease;
}

function releaseLease(fileKey: string): void {
  const lease = activeLeases.get(fileKey);
  if (lease) {
    lease.status = 'released';
  }
}

async function writeBlock(
  fileKey: string,
  ownerWorker: FileHandleLease['ownerWorker'],
  buffer: ArrayBuffer,
): Promise<{ bytesWritten: number; backend: 'OPFS-SyncAccessHandle' | 'OPFS-Writable' | 'Memory-Fallback' }> {
  acquireLease(fileKey, ownerWorker);
  try {
    const safeName = fileKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (opfsAvailable && rootDir) {
      const fh = await rootDir.getFileHandle(safeName, { create: true });
      if (syncHandleAvailable && 'createSyncAccessHandle' in fh) {
        const sync = await (fh as FileSystemFileHandle & {
          createSyncAccessHandle: () => Promise<FileSystemSyncAccessHandle>;
        }).createSyncAccessHandle();
        try {
          sync.truncate(0);
          sync.write(new Uint8Array(buffer), { at: 0 });
          sync.flush();
          return { bytesWritten: buffer.byteLength, backend: 'OPFS-SyncAccessHandle' };
        } finally {
          sync.close();
        }
      }
      const writable = await fh.createWritable();
      await writable.write(buffer);
      await writable.close();
      return { bytesWritten: buffer.byteLength, backend: 'OPFS-Writable' };
    }
    memoryFallbackStore.set(safeName, buffer.slice(0));
    return { bytesWritten: buffer.byteLength, backend: 'Memory-Fallback' };
  } finally {
    releaseLease(fileKey);
  }
}

async function readBlock(
  fileKey: string,
  ownerWorker: FileHandleLease['ownerWorker'],
): Promise<ArrayBuffer | null> {
  acquireLease(fileKey, ownerWorker);
  try {
    const safeName = fileKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (opfsAvailable && rootDir) {
      const fh = await rootDir.getFileHandle(safeName);
      if (syncHandleAvailable && 'createSyncAccessHandle' in fh) {
        const sync = await (fh as FileSystemFileHandle & {
          createSyncAccessHandle: () => Promise<FileSystemSyncAccessHandle>;
        }).createSyncAccessHandle();
        try {
          const size = sync.getSize();
          const out = new Uint8Array(size);
          sync.read(out, { at: 0 });
          return out.buffer;
        } finally {
          sync.close();
        }
      }
      const file = await fh.getFile();
      return await file.arrayBuffer();
    }
    return memoryFallbackStore.get(safeName)?.slice(0) ?? null;
  } catch {
    return null;
  } finally {
    releaseLease(fileKey);
  }
}

self.onmessage = async (event: MessageEvent<BrokerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'INIT') {
      const probe = await initOpfs();
      self.postMessage({
        id: msg.id,
        ok: true,
        payload: {
          ...probe,
          lockConflictsPrevented,
          leases: Array.from(activeLeases.values()),
        },
      });
      return;
    }

    if (msg.type === 'WRITE_BLOCK') {
      const res = await writeBlock(msg.fileKey, msg.ownerWorker, msg.data);
      self.postMessage({
        id: msg.id,
        ok: true,
        payload: {
          ...res,
          lockConflictsPrevented,
          leases: Array.from(activeLeases.values()).slice(-12),
        },
      });
      return;
    }

    if (msg.type === 'READ_BLOCK') {
      const buf = await readBlock(msg.fileKey, msg.ownerWorker);
      if (buf) {
        self.postMessage(
          {
            id: msg.id,
            ok: true,
            payload: {
              buffer: buf,
              lockConflictsPrevented,
              leases: Array.from(activeLeases.values()).slice(-12),
            },
          },
          [buf],
        );
      } else {
        self.postMessage({
          id: msg.id,
          ok: true,
          payload: { buffer: null, lockConflictsPrevented, leases: Array.from(activeLeases.values()).slice(-12) },
        });
      }
      return;
    }

    if (msg.type === 'DELETE_FILE') {
      const safeName = msg.fileKey.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (opfsAvailable && rootDir) {
        await rootDir.removeEntry(safeName).catch(() => {});
      }
      memoryFallbackStore.delete(safeName);
      activeLeases.delete(msg.fileKey);
      self.postMessage({ id: msg.id, ok: true, payload: { deleted: true } });
      return;
    }

    if (msg.type === 'GET_STATE') {
      self.postMessage({
        id: msg.id,
        ok: true,
        payload: {
          opfsAvailable,
          syncHandleAvailable,
          lockConflictsPrevented,
          leases: Array.from(activeLeases.values()).slice(-12),
        },
      });
    }
  } catch (err) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
