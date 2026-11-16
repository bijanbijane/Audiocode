import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProvenanceAndSupportAuditPanel } from './ProvenanceAndSupportAuditPanel';

test('Section 58: ProvenanceAndSupportAuditPanel renders provenance metadata and strictly redacts Persian text and local file paths in support logs', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProvenanceAndSupportAuditPanel, {
      provenanceItems: [
        {
          analysisId: 'p1',
          taskTitleFa: 'تشخیص گفتار فارسی',
          modelId: 'whisper-small-fa',
          modelVersion: '1.2.0',
          executedRuntime: 'LOCAL_WASM_SIMD',
          inputAssetHashPrefix: 'aa99bb11',
          confidencePercent: 94,
          validityStatus: 'VALID_CURRENT',
        },
        {
          analysisId: 'p2',
          taskTitleFa: 'بازنگری متنی ابری',
          modelId: 'cloud-helper',
          modelVersion: '2.0.1',
          executedRuntime: 'EXTERNAL_API',
          inputAssetHashPrefix: 'aa99bb11',
          confidencePercent: 98,
          validityStatus: 'STALE_NEEDS_REVALIDATION',
        },
      ],
      diagnosticLogs: [
        {
          logId: 'l1',
          timestampIso: '2026-11-16T14:00:00Z',
          category: 'AUDIO_INGEST',
          rawMessage: 'Failed reading /Users/ali/Recordings/محرمانه_اپیزود.wav due to codec error',
        },
      ],
      onSendApprovedDiagnosticBundle: () => {},
    }),
  );

  assert.match(html, /whisper-small-fa/);
  assert.match(html, /#aa99bb11/);
  assert.match(html, /LOCAL_WASM_SIMD/);
  assert.match(html, /نیازمند بازسنجی/);
  assert.match(html, /\[REDACTED_PATH\]/);
  assert.doesNotMatch(html, /محرمانه_اپیزود/);
  assert.doesNotMatch(html, /\/Users\/ali\/Recordings/);
});
