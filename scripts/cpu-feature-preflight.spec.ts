import { describe, expect, it, vi } from 'vitest';
import { verifyRequiredCpuFeatures } from './cpu-feature-preflight.mjs';

describe('installer CPU feature preflight', () => {
  it('accepts the required NEON baseline only for Apple Silicon', () => {
    const spawnSync = vi.fn();
    expect(verifyRequiredCpuFeatures(['NEON'], {
      platform: 'darwin',
      arch: 'arm64',
      spawnSync,
    })).toEqual({ supported: true, checked: ['NEON'], reason: null });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(verifyRequiredCpuFeatures(['NEON'], {
      platform: 'win32',
      arch: 'arm64',
      spawnSync,
    }).supported).toBe(false);
  });

  it('requires the Intel macOS AVX2 sysctl to return exactly 1', () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: '1\\n', stderr: '' }));
    expect(verifyRequiredCpuFeatures(['AVX2'], {
      platform: 'darwin',
      arch: 'x64',
      spawnSync,
    })).toEqual({ supported: true, checked: ['AVX2'], reason: null });
    expect(spawnSync).toHaveBeenCalledWith('sysctl', ['-n', 'hw.optional.avx2_0'], expect.objectContaining({
      encoding: 'utf8',
      timeout: 5000,
    }));

    const missing = verifyRequiredCpuFeatures(['AVX2'], {
      platform: 'darwin',
      arch: 'x64',
      spawnSync: vi.fn(() => ({ status: 0, stdout: '0\\n', stderr: '' })),
    });
    expect(missing.supported).toBe(false);
    expect(missing.reason).toContain('CPU_FEATURE_UNAVAILABLE');
  });

  it('uses the Windows kernel feature API for AVX2 and fails closed when unavailable', () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    expect(verifyRequiredCpuFeatures(['AVX2'], {
      platform: 'win32',
      arch: 'x64',
      spawnSync,
    })).toEqual({ supported: true, checked: ['AVX2'], reason: null });
    const [command, args, options] = spawnSync.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-NonInteractive');
    expect(args.at(-1)).toContain('IsProcessorFeaturePresent(40)');
    expect(options).toMatchObject({ encoding: 'utf8', timeout: 10000, windowsHide: true });

    const unavailable = verifyRequiredCpuFeatures(['AVX2'], {
      platform: 'win32',
      arch: 'x64',
      spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
    });
    expect(unavailable.supported).toBe(false);
    expect(unavailable.reason).toContain('CPU_FEATURE_UNAVAILABLE');
  });

  it('fails closed for unknown CPU features and unsupported platform/architecture pairs', () => {
    expect(verifyRequiredCpuFeatures(['AVX2'], {
      platform: 'linux',
      arch: 'x64',
      spawnSync: vi.fn(),
    }).supported).toBe(false);
    expect(verifyRequiredCpuFeatures(['AVX512'], {
      platform: 'darwin',
      arch: 'x64',
      spawnSync: vi.fn(),
    }).reason).toContain('CPU_FEATURE_UNRECOGNIZED');
    expect(verifyRequiredCpuFeatures([])).toEqual({ supported: true, checked: [], reason: null });
  });
});
