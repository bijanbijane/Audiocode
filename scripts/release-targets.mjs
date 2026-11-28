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
    runtimeArchive: Object.freeze({
      fileName: 'sherpa-onnx-v2.0.2-osx-arm64-shared-no-tts.tar.bz2',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-v2.0.2-osx-arm64-shared-no-tts.tar.bz2',
      bytes: 20_197_239,
      sha256: '1a803809572335ef545978b62b0271ad119969fef6f9153a94c174c3adc95608',
    }),
  }),
  'darwin-x64': Object.freeze({
    id: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    osLabel: 'macOS 14/15',
    architectureLabel: 'Intel',
    sherpaBinaryName: 'sherpa-onnx-offline',
    onnxRuntimeLibraryName: 'libonnxruntime.dylib',
    runtimeArchive: Object.freeze({
      fileName: 'sherpa-onnx-v2.0.2-osx-x64-shared-no-tts.tar.bz2',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-v2.0.2-osx-x64-shared-no-tts.tar.bz2',
      bytes: 22_763_064,
      sha256: 'c1f69c0752ec7deef44eb8662e4489330513e514c64db5251879950e77066eaf',
    }),
  }),
  'win32-x64': Object.freeze({
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    osLabel: 'Windows 11',
    architectureLabel: 'x64',
    sherpaBinaryName: 'sherpa-onnx-offline.exe',
    onnxRuntimeLibraryName: 'onnxruntime.dll',
    runtimeArchive: Object.freeze({
      fileName: 'sherpa-onnx-v2.0.2-win-x64-shared-MT-Release-no-tts.tar.bz2',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-v2.0.2-win-x64-shared-MT-Release-no-tts.tar.bz2',
      bytes: 26_896_305,
      sha256: '6a71d5ef016e544026d6505486d9fa42177ad989238adc6e4bd2eebfb6947416',
    }),
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
