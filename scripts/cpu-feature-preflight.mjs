import { spawnSync as nodeSpawnSync } from 'node:child_process';

export type CpuProbeSpawnResult = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error | null;
};

export type CpuProbeSpawnSync = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number; windowsHide?: boolean },
) => CpuProbeSpawnResult;

const defaultSpawnSync: CpuProbeSpawnSync = (command, args, options) =>
  nodeSpawnSync(command, [...args], options) as CpuProbeSpawnResult;

const WINDOWS_AVX2_PROBE = [
  "$source = 'using System; using System.Runtime.InteropServices; public static class AvaPardazCpuProbe { [DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint feature); }'",
  'Add-Type -TypeDefinition $source',
  'if ([AvaPardazCpuProbe]::IsProcessorFeaturePresent(40)) { exit 0 } else { exit 1 }',
].join('; ');

/**
 * Check the CPU feature floor declared by the target release manifest.
 *
 * Windows uses the OS-supported IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE)
 * API (feature ID 40); Intel macOS uses Apple's hw.optional.avx2_0 sysctl.
 * NEON is part of the required AArch64 baseline for the approved Apple Silicon target.
 */
export function verifyRequiredCpuFeatures(requiredCpuFeatures = [], {
  platform = process.platform,
  arch = process.arch,
  spawnSync = defaultSpawnSync,
}: {
  platform?: string;
  arch?: string;
  spawnSync?: CpuProbeSpawnSync;
} = {}) {
  const required = [...new Set(requiredCpuFeatures.map((feature) => String(feature).toUpperCase()))];
  const checked = [];

  for (const feature of required) {
    if (feature === 'NEON') {
      if (platform !== 'darwin' || arch !== 'arm64') {
        return {
          supported: false,
          checked,
          reason: `CPU_FEATURE_TARGET_UNSUPPORTED: NEON is only accepted for darwin-arm64; received ${platform}-${arch}`,
        };
      }
      checked.push('NEON');
      continue;
    }

    if (feature === 'AVX2') {
      let result;
      if (platform === 'darwin' && arch === 'x64') {
        result = spawnSync('sysctl', ['-n', 'hw.optional.avx2_0'], {
          encoding: 'utf8',
          timeout: 5000,
        });
        if (result.error || result.status !== 0 || String(result.stdout ?? '').trim() !== '1') {
          return {
            supported: false,
            checked,
            reason: 'CPU_FEATURE_UNAVAILABLE: AVX2 is not reported by macOS hw.optional.avx2_0',
          };
        }
      } else if (platform === 'win32' && arch === 'x64') {
        result = spawnSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          WINDOWS_AVX2_PROBE,
        ], {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        });
        if (result.error || result.status !== 0) {
          return {
            supported: false,
            checked,
            reason: 'CPU_FEATURE_UNAVAILABLE: Windows IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE) returned false or could not be queried',
          };
        }
      } else {
        return {
          supported: false,
          checked,
          reason: `CPU_FEATURE_TARGET_UNSUPPORTED: AVX2 probe is not defined for ${platform}-${arch}`,
        };
      }
      checked.push('AVX2');
      continue;
    }

    return {
      supported: false,
      checked,
      reason: `CPU_FEATURE_UNRECOGNIZED: ${feature}`,
    };
  }

  return { supported: true, checked, reason: null };
}
