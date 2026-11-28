import { describe, expect, it } from 'vitest';
import { AVAPARDAZ_BETA_RELEASE_IDENTITY } from '../ProductionReleaseAndBetaEngine';

describe('production release platform metadata', () => {
  it('matches the approved macOS 14/15 and Windows 11 internal target matrix', () => {
    expect(AVAPARDAZ_BETA_RELEASE_IDENTITY.supportedPlatforms).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
    ]);
    expect(AVAPARDAZ_BETA_RELEASE_IDENTITY.primaryTargetPlatform)
      .toContain('macOS 14/15 Apple Silicon');
  });
});
