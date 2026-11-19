/**
 * Architecture & Local-First Guardrail Definitions (AVP-P10-001 Section 9)
 * Used by automated reliability tests and CI checks to inspect real production source paths
 * and prevent regressions back to remote ASR, runtime remote fonts, unapproved EDL execution,
 * or diagnostic data leakage.
 */

export interface ArchitectureGuardrailCheck {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}

export function evaluateProductionSourceGuardrails(files: {
  readonly indexHtml: string;
  readonly appTsx: string;
  readonly workflowControllerTs: string;
  readonly renderPlannerTs: string;
  readonly manifestJson: string;
  readonly swJs: string;
}): readonly ArchitectureGuardrailCheck[] {
  const checks: ArchitectureGuardrailCheck[] = [];

  // 1. Primary ASR workflow must NOT call remote transcription APIs
  const hasRemoteAsrInApp = /\/api\/v1\/asr\/transcribe/.test(files.appTsx);
  const hasRemoteAsrInWorkflow = /\/api\/v1\/asr\/transcribe/.test(files.workflowControllerTs);
  checks.push({
    id: 'NO_REMOTE_ASR_IN_PRIMARY_WORKFLOW',
    description: 'Primary ASR workflow must never call remote /api/v1/asr/transcribe endpoints',
    passed: !hasRemoteAsrInApp && !hasRemoteAsrInWorkflow,
    detail:
      hasRemoteAsrInApp || hasRemoteAsrInWorkflow
        ? 'Detected forbidden /api/v1/asr/transcribe reference in primary UI or workflow controller.'
        : 'Verified zero remote transcription API references in App.tsx and StudioWorkflowController.ts.',
  });

  // 2. index.html must NOT load external Google Fonts or CDN stylesheets at runtime
  const hasRemoteFonts = /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr|unpkg\.com/i.test(
    files.indexHtml,
  );
  checks.push({
    id: 'NO_RUNTIME_EXTERNAL_FONTS_OR_CDNS',
    description: 'index.html must not load runtime remote fonts or CDN assets',
    passed: !hasRemoteFonts,
    detail: hasRemoteFonts
      ? 'Found forbidden external font or CDN URL in index.html.'
      : 'Verified index.html contains zero external font or CDN links.',
  });

  // 3. Render planner must reject unapproved EDL proposals
  const enforcesApprovedOnly =
    files.renderPlannerTs.includes("proposal.status !== 'APPROVED'") ||
    files.renderPlannerTs.includes('UNAPPROVED_PROPOSAL');
  checks.push({
    id: 'RENDER_PLANNER_BLOCKS_UNAPPROVED_EDL',
    description: 'AudioRenderPlanner must strictly block unapproved EDL proposals',
    passed: enforcesApprovedOnly,
    detail: enforcesApprovedOnly
      ? 'Verified UNAPPROVED_PROPOSAL enforcement in AudioRenderPlanner.ts.'
      : 'Missing explicit unapproved EDL guard in AudioRenderPlanner.ts.',
  });

  // 4. public/sw.js must be valid classic service worker script (no ES module export statement)
  const swHasInvalidExport = /^\s*export\s*\{/m.test(files.swJs);
  checks.push({
    id: 'CLASSIC_SERVICE_WORKER_SYNTAX_VALID',
    description: 'public/sw.js must not contain invalid classic-script ES module exports',
    passed: !swHasInvalidExport,
    detail: swHasInvalidExport
      ? 'public/sw.js contains an ES module export block that breaks classic navigator.serviceWorker.register.'
      : 'Verified public/sw.js is clean classic Service Worker syntax.',
  });

  // 5. manifest.webmanifest must parse as valid JSON with icons and display mode
  let manifestValid = false;
  let manifestDetail = 'Invalid manifest JSON';
  try {
    const parsed = JSON.parse(files.manifestJson) as {
      name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ src?: string; sizes?: string }>;
    };
    manifestValid = Boolean(
      parsed.name &&
        parsed.start_url &&
        parsed.display &&
        Array.isArray(parsed.icons) &&
        parsed.icons.length >= 2,
    );
    manifestDetail = manifestValid
      ? `Valid manifest (${parsed.name}, ${parsed.icons?.length ?? 0} icons, display=${parsed.display}).`
      : 'Manifest missing required fields (name, start_url, display, or icons).';
  } catch {
    manifestValid = false;
  }
  checks.push({
    id: 'PWA_MANIFEST_VALID',
    description: 'public/manifest.webmanifest must be valid and declare installable icons',
    passed: manifestValid,
    detail: manifestDetail,
  });

  return checks;
}
