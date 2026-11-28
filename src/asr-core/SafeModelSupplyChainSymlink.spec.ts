import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { extractTarBz2Safe } from './SafeModelSupplyChain';

const tempDirs: string[] = [];
const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

function createTarWithLibrarySymlink(linkName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-safe-tar-symlink-'));
  tempDirs.push(dir);
  const archivePath = path.join(dir, 'runtime.tar.bz2');
  const script = [
    'import io, sys, tarfile',
    'archive, link_name = sys.argv[1], sys.argv[2]',
    "data = b'validated-native-library-fixture'",
    "with tarfile.open(archive, 'w:bz2') as tf:",
    "  target = tarfile.TarInfo('runtime/lib/libonnxruntime.1.28.2.dylib')",
    '  target.size = len(data)',
    '  target.mode = 0o644',
    '  tf.addfile(target, io.BytesIO(data))',
    "  alias = tarfile.TarInfo('runtime/lib/libonnxruntime.dylib')",
    '  alias.type = tarfile.SYMTYPE',
    '  alias.linkname = link_name',
    '  tf.addfile(alias)',
  ].join('\n');
  const result = spawnSync(pythonBin, ['-c', script, archivePath, linkName], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Unable to create tar fixture: ' + (result.stderr || result.error?.message || result.status));
  }
  return archivePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('safe native runtime archive symlink materialization', () => {
  it('materializes only same-directory library aliases as regular files when explicitly enabled', async () => {
    const archive = createTarWithLibrarySymlink('libonnxruntime.1.28.2.dylib');
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-safe-tar-output-'));
    tempDirs.push(output);
    await extractTarBz2Safe(archive, output, {
      allowRelativeLibrarySymlinks: true,
      maxFiles: 8,
      maxTotalBytes: 1024,
      maxSingleFileBytes: 1024,
      pythonBin,
    });
    const alias = path.join(output, 'runtime', 'lib', 'libonnxruntime.dylib');
    expect(fs.lstatSync(alias).isFile()).toBe(true);
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(alias, 'utf8')).toBe('validated-native-library-fixture');
  });

  it('continues to reject symlinks by default', async () => {
    const archive = createTarWithLibrarySymlink('libonnxruntime.1.28.2.dylib');
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-safe-tar-output-'));
    tempDirs.push(output);
    await expect(extractTarBz2Safe(archive, output, { pythonBin }))
      .rejects.toThrow(/TAR_SYMLINK_FORBIDDEN/);
  });

  it('rejects parent traversal even when library symlink materialization is enabled', async () => {
    const archive = createTarWithLibrarySymlink('../../outside.dylib');
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-safe-tar-output-'));
    tempDirs.push(output);
    await expect(extractTarBz2Safe(archive, output, {
      allowRelativeLibrarySymlinks: true,
      pythonBin,
    })).rejects.toThrow(/TAR_PATH_TRAVERSAL_BLOCKED/);
  });
});
