import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNativeBinaryArchitecture, inspectNativeBinaryArchitecture } from './verify-native-binary.mjs';

const tempDirs: string[] = [];
function fixture(name: string, bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-native-arch-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function thinMach(cpu: number): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpu, 4);
  return buffer;
}
function peX64(): Buffer {
  const buffer = Buffer.alloc(256);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'ascii');
  buffer.writeUInt16LE(0x8664, 0x84);
  return buffer;
}

describe('native runtime binary architecture verification', () => {
  it('detects thin Mach-O arm64 and x64 binaries', () => {
    const arm = fixture('arm64.dylib', thinMach(0x0100000c));
    const intel = fixture('x64.dylib', thinMach(0x01000007));
    expect(inspectNativeBinaryArchitecture(arm, 'darwin')).toEqual(['arm64']);
    expect(assertNativeBinaryArchitecture({ filePath: intel, platform: 'darwin', arch: 'x64' })).toBe(true);
    expect(() => assertNativeBinaryArchitecture({ filePath: arm, platform: 'darwin', arch: 'x64' }))
      .toThrowError(/NATIVE_BINARY_ARCH_MISMATCH/);
  });

  it('accepts a universal Mach-O when it contains the requested CPU slice', () => {
    const fat = Buffer.alloc(48);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x01000007, 8);
    fat.writeUInt32BE(0x0100000c, 28);
    const filePath = fixture('universal.dylib', fat);
    expect(inspectNativeBinaryArchitecture(filePath, 'darwin')).toEqual(['x64', 'arm64']);
    expect(assertNativeBinaryArchitecture({ filePath, platform: 'darwin', arch: 'arm64' })).toBe(true);
  });

  it('detects PE x64 and rejects a wrong platform architecture', () => {
    const filePath = fixture('sherpa.exe', peX64());
    expect(inspectNativeBinaryArchitecture(filePath, 'win32')).toBe('x64');
    expect(assertNativeBinaryArchitecture({ filePath, platform: 'win32', arch: 'x64' })).toBe(true);
    expect(() => assertNativeBinaryArchitecture({ filePath, platform: 'win32', arch: 'arm64' }))
      .toThrowError(/NATIVE_BINARY_ARCH_MISMATCH/);
  });

  it('rejects missing, truncated, and unrecognized binaries', () => {
    expect(() => inspectNativeBinaryArchitecture('/no/such/native-binary', 'darwin'))
      .toThrowError(/NATIVE_BINARY_MISSING/);
    const malformed = fixture('not-a-binary.bin', Buffer.from('not a native executable'));
    expect(() => assertNativeBinaryArchitecture({ filePath: malformed, platform: 'darwin', arch: 'arm64' }))
      .toThrowError(/NATIVE_BINARY_ARCH_MISMATCH/);
  });
});
