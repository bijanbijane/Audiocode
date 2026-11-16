import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createStructuredPlatformError,
  OfficialErrorCategory,
  PLATFORM_ERROR_CATALOG,
} from './PlatformErrorCatalog';

test('PlatformErrorCatalog covers all 10 official error categories', () => {
  const expectedCategories: OfficialErrorCategory[] = [
    'INPUT_ERROR',
    'RESOURCE_ERROR',
    'RUNTIME_ERROR',
    'MODEL_ERROR',
    'PROCESSING_ERROR',
    'STORAGE_ERROR',
    'TIMELINE_ERROR',
    'EXPORT_ERROR',
    'POLICY_ERROR',
    'COMPATIBILITY_ERROR',
  ];

  const presentCategories = new Set(
    Object.values(PLATFORM_ERROR_CATALOG).map((entry) => entry.category),
  );
  for (const cat of expectedCategories) {
    assert.equal(presentCategories.has(cat), true, `Missing category: ${cat}`);
  }
});

test('createStructuredPlatformError scrubs Persian transcript text and local OS paths from diagnostics', () => {
  const err = createStructuredPlatformError(
    'ERR_POLICY_UNCONSENTED_EXTERNAL_CALL',
    new Error('Blocked /Users/alireza/podcasts/ep42.wav containing متن محرمانه پادکست'),
  );

  assert.equal(err.category, 'POLICY_ERROR');
  assert.equal(err.severity, 'CRITICAL_BLOCKER');
  assert.equal(err.retryable, false);
  assert.equal(/[\u0600-\u06FF]/.test(err.technicalDiagnosticRedacted), false);
  assert.equal(err.technicalDiagnosticRedacted.includes('/Users/alireza'), false);
});

test('SPEC-01 AC-01.1: core engine domains have zero reverse imports into React UI components', () => {
  const coreDirs = [
    'src/contracts',
    'src/ai-engine',
    'src/audio-engine',
    'src/project-core',
    'src/processing-core',
    'src/security',
  ];

  for (const dir of coreDirs) {
    const absDir = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(absDir)) continue;
    for (const file of fs.readdirSync(absDir)) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(absDir, file), 'utf8');
      assert.equal(
        /from\s+['"].*(\/components\/|\/App|react)['"]/.test(content),
        false,
        `Forbidden core -> UI import detected in ${dir}/${file}`,
      );
    }
  }
});
