import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const packagerSource = readFileSync(
  fileURLToPath(new URL('./build-release-installer.mjs', import.meta.url)),
  'utf8',
);

describe('full release installer path resolution', () => {
  it('generates a standalone installer that resolves its payload from a decoded file URL', () => {
    expect(packagerSource).toContain('AvaPardaz user-space installer (requires Node.js 20 or newer)');
    expect(packagerSource).toContain("console.log('Requires Node.js 20 or newer.");
    expect(packagerSource).toContain("import { fileURLToPath } from 'node:url';");
    expect(packagerSource).toContain('const installerDir = path.dirname(fileURLToPath(import.meta.url));');
    expect(packagerSource).toContain("const payloadRoot = path.resolve(installerDir, '..', 'payload');");
    expect(packagerSource).toContain("resolveAvapardazReleaseTarget");
    expect(packagerSource).toContain("assertRuntimeTargetMatches");
    expect(packagerSource).toContain("assertNativeBinaryArchitecture");
    expect(packagerSource).toContain("filePath: SHERPA_BINARY_SOURCE");
    expect(packagerSource).toContain("filePath: onnxRuntimeLibrarySource");
    expect(packagerSource).toContain("availableRuntimeLibraries");
    expect(packagerSource).toContain("AVAPARDAZ_SHERPA_RUNTIME_LIB_DIR");
    expect(packagerSource).toContain("DIRECT_SHERPA_RUNTIME_HAS_LIBRARIES");
    expect(packagerSource).toContain("SHERPA_RUNTIME_MANIFEST_MISSING");
    expect(packagerSource).toContain("SHERPA_RUNTIME_MANIFEST_PROVENANCE_MISMATCH");
    expect(packagerSource).toContain("sherpaRuntimeProvenance");
    expect(packagerSource).toContain("requiredCpuFeatures");
    expect(packagerSource).toContain("verifyKoochikModelDirectory");
    expect(packagerSource).toContain("koochikSourceManifest");
    expect(packagerSource).toContain("modelManifest");
    expect(packagerSource).toContain("RELEASE_TARGET.platform !== 'win32'");
    expect(packagerSource).toContain("RELEASE_TARGET.onnxRuntimeLibraryName");
    expect(packagerSource).toContain("install-windows.ps1");
    expect(packagerSource).toContain("process.platform !== '${RELEASE_TARGET.platform}'");
    expect(packagerSource).toContain("nodeMajorVersion < 20");
    expect(packagerSource).toContain("verifyRequiredCpuFeatures");
    expect(packagerSource).toContain("cpu-feature-preflight.mjs");
    expect(packagerSource).toContain("CPU requirement not met");
    expect(packagerSource).toContain("RELEASE_TARGET.requiredCpuFeatures");
    expect(packagerSource).not.toContain('path.dirname(new URL(import.meta.url).pathname)');
  });
});
