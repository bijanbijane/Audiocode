/**
 * Approved AVAPARDAZ internal release targets.
 * Keep this list aligned with the owner-approved R0 platform matrix.
 */
export const AVAPARDAZ_RELEASE_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    osLabel: 'macOS 14/15',
    architectureLabel: 'Apple Silicon',
    sherpaBinaryName: 'sherpa-onnx-offline',
    onnxRuntimeLibraryName: 'libonnxruntime.dylib',
  }),
  'darwin-x64': Object.freeze({
    id: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    osLabel: 'macOS 14/15',
    architectureLabel: 'Intel',
    sherpaBinaryName: 'sherpa-onnx-offline',
    onnxRuntimeLibraryName: 'libonnxruntime.dylib',
  }),
  'win32-x64': Object.freeze({
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    osLabel: 'Windows 11',
    architectureLabel: 'x64',
    sherpaBinaryName: 'sherpa-onnx-offline.exe',
    onnxRuntimeLibraryName: 'onnxruntime.dll',
  }),
});

export function resolveAvapardazReleaseTarget({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const targetId = `${platform}-${arch}`;
  const target = AVAPARDAZ_RELEASE_TARGETS[targetId];
  if (!target) {
    const supported = Object.keys(AVAPARDAZ_RELEASE_TARGETS).join(', ');
    const error = new Error(`UNSUPPORTED_RELEASE_TARGET: ${targetId}. Supported targets: ${supported}`);
    error.code = 'UNSUPPORTED_RELEASE_TARGET';
    throw error;
  }
  return target;
}

export function assertRuntimeTargetMatches({ target, runtimeTarget }) {
  if (runtimeTarget !== target.id) {
    const error = new Error(
      `RUNTIME_TARGET_MISMATCH: release target ${target.id} requires AVAPARDAZ_SHERPA_RUNTIME_TARGET=${target.id}; received ${runtimeTarget || '(unset)'}.`,
    );
    error.code = 'RUNTIME_TARGET_MISMATCH';
    throw error;
  }
  return true;
}
