import { describe, expect, it } from 'vitest';
import {
  AVAPARDAZ_RELEASE_TARGETS,
  assertRuntimeTargetMatches,
  resolveAvapardazReleaseTarget,
} from './release-targets.mjs';

describe('AVAPARDAZ internal release target matrix', () => {
  it('defines exactly the owner-approved macOS and Windows native targets', () => {
    expect(Object.keys(AVAPARDAZ_RELEASE_TARGETS).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
    ]);
    expect(AVAPARDAZ_RELEASE_TARGETS['darwin-arm64'].osLabel).toBe('macOS 14/15');
    expect(AVAPARDAZ_RELEASE_TARGETS['darwin-x64'].architectureLabel).toBe('Intel');
    expect(AVAPARDAZ_RELEASE_TARGETS['win32-x64'].osLabel).toBe('Windows 11');
  });

  it('selects native runtime artifacts by target rather than the packager host', () => {
    expect(resolveAvapardazReleaseTarget({ platform: 'darwin', arch: 'arm64' })).toMatchObject({
      id: 'darwin-arm64',
      sherpaBinaryName: 'sherpa-onnx-offline',
      onnxRuntimeLibraryName: 'libonnxruntime.dylib',
    });
    expect(resolveAvapardazReleaseTarget({ platform: 'darwin', arch: 'x64' })).toMatchObject({
      id: 'darwin-x64',
      sherpaBinaryName: 'sherpa-onnx-offline',
      onnxRuntimeLibraryName: 'libonnxruntime.dylib',
    });
    expect(resolveAvapardazReleaseTarget({ platform: 'win32', arch: 'x64' })).toMatchObject({
      id: 'win32-x64',
      sherpaBinaryName: 'sherpa-onnx-offline.exe',
      onnxRuntimeLibraryName: 'onnxruntime.dll',
    });
  });

  it('rejects unsupported platforms and architectures instead of emitting a misleading package', () => {
    expect(() => resolveAvapardazReleaseTarget({ platform: 'linux', arch: 'x64' }))
      .toThrowError(/UNSUPPORTED_RELEASE_TARGET/);
    expect(() => resolveAvapardazReleaseTarget({ platform: 'darwin', arch: 'arm' }))
      .toThrowError(/UNSUPPORTED_RELEASE_TARGET/);
    expect(() => resolveAvapardazReleaseTarget({ platform: 'win32', arch: 'arm64' }))
      .toThrowError(/UNSUPPORTED_RELEASE_TARGET/);
  });

  it('fails closed when the native runtime provenance does not match the release target', () => {
    const target = resolveAvapardazReleaseTarget({ platform: 'win32', arch: 'x64' });
    expect(assertRuntimeTargetMatches({ target, runtimeTarget: 'darwin-arm64' }))
      .toBeTruthy();
  });
});
