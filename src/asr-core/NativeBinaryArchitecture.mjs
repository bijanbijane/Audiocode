import * as fs from 'node:fs';

const MACH_CPU = Object.freeze({
  x64: 0x01000007,
  arm64: 0x0100000c,
});
const PE_MACHINE = Object.freeze({
  x64: 0x8664,
});

function readMachCpuTypes(buffer) {
  if (buffer.length < 8) return null;
  const magic = buffer.readUInt32BE(0);
  const littleEndianFatMagic = buffer.readUInt32LE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf
    || littleEndianFatMagic === 0xcafebabe || littleEndianFatMagic === 0xcafebabf) {
    const littleEndian = magic !== 0xcafebabe && magic !== 0xcafebabf;
    const fatMagic = littleEndian ? littleEndianFatMagic : magic;
    const is64 = fatMagic === 0xcafebabf;
    const readUInt32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
    const count = readUInt32.call(buffer, 4);
    const entrySize = is64 ? 32 : 20;
    if (count > 128 || buffer.length < 8 + count * entrySize) return null;
    const cpus = [];
    for (let index = 0; index < count; index += 1) {
      cpus.push(readUInt32.call(buffer, 8 + index * entrySize));
    }
    return cpus;
  }
  const littleMagic = buffer.readUInt32LE(0);
  if (littleMagic === 0xfeedface || littleMagic === 0xfeedfacf) {
    return [buffer.readUInt32LE(4)];
  }
  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    return [buffer.readUInt32BE(4)];
  }
  return null;
}

function readPeMachine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, dos.length, 0) < dos.length || dos.toString('ascii', 0, 2) !== 'MZ') return null;
    const peOffset = dos.readUInt32LE(0x3c);
    if (!Number.isSafeInteger(peOffset) || peOffset < 64 || peOffset > 16 * 1024 * 1024) return null;
    const header = Buffer.alloc(6);
    if (fs.readSync(fd, header, 0, header.length, peOffset) < header.length) return null;
    if (header.toString('ascii', 0, 4) !== 'PE\0\0') return null;
    return header.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectNativeBinaryArchitecture(filePath, platform) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`NATIVE_BINARY_MISSING: ${filePath}`);
  }
  if (platform === 'win32') {
    const machine = readPeMachine(filePath);
    return machine === null ? null : (machine === PE_MACHINE.x64 ? 'x64' : `pe-machine-0x${machine.toString(16)}`);
  }
  if (platform === 'darwin') {
    const header = Buffer.alloc(8192);
    const fd = fs.openSync(filePath, 'r');
    let bytes;
    try {
      bytes = Buffer.alloc(fs.readSync(fd, header, 0, header.length, 0));
      header.copy(bytes, 0, 0, bytes.length);
    } finally {
      fs.closeSync(fd);
    }
    const cpuTypes = readMachCpuTypes(bytes);
    if (!cpuTypes) return null;
    return cpuTypes.map((cpu) => Object.entries(MACH_CPU).find(([, value]) => value === cpu)?.[0] ?? `mach-cpu-0x${cpu.toString(16)}`);
  }
  throw new Error(`UNSUPPORTED_BINARY_PLATFORM: ${platform}`);
}

export function assertNativeBinaryArchitecture({ filePath, platform, arch }) {
  const detected = inspectNativeBinaryArchitecture(filePath, platform);
  const matches = Array.isArray(detected) ? detected.includes(arch) : detected === arch;
  if (!matches) {
    throw new Error(`NATIVE_BINARY_ARCH_MISMATCH: ${filePath} expected ${platform}-${arch}; detected ${JSON.stringify(detected)}`);
  }
  return true;
}
