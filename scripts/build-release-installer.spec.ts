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
    expect(packagerSource).toContain("RELEASE_TARGET.onnxRuntimeLibraryName");
    expect(packagerSource).toContain("install-windows.ps1");
    expect(packagerSource).toContain("process.platform !== '${RELEASE_TARGET.platform}'");
    expect(packagerSource).toContain("nodeMajorVersion < 20");
    expect(packagerSource).not.toContain('path.dirname(new URL(import.meta.url).pathname)');
  });
});
