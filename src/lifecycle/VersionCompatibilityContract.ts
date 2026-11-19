import { EDL_SCHEMA_VERSION } from '../ai-engine/edit-decision/EditDecisionTypes';
import { AUDIO_RENDERER_VERSION } from '../audio-renderer/AudioRenderTypes';
import { LOCAL_PRIVACY_POLICY_VERSION } from '../security/LocalPrivacyPolicy';
import { deterministicHexHash } from '../ai-engine/edit-decision/EditProvenance';

export const AVAPARDAZ_VERSION_CONTRACT = {
  appVersion: '1.9.0',
  buildId: 'avp-2026-p09-local-first',
  projectSchemaVersion: 2,
  transcriptSchemaVersion: 1,
  edlSchemaVersion: EDL_SCHEMA_VERSION,
  renderMetadataVersion: AUDIO_RENDERER_VERSION,
  modelManifestVersion: '1.0.0',
  workerProtocolVersion: '1.2.0',
  localStorageSchemaVersion: 2,
  privacyPolicyVersion: LOCAL_PRIVACY_POLICY_VERSION,
  minSupportedProjectSchemaVersion: 1,
} as const;

export type CompatibilityDecision =
  | 'COMPATIBLE'
  | 'MIGRATION_REQUIRED'
  | 'UNSUPPORTED_FUTURE_VERSION'
  | 'UNSUPPORTED_LEGACY_VERSION'
  | 'INVALID_SCHEMA';

export interface PersistedProjectEnvelope {
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly projectName: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly transcriptSchemaVersion?: number;
  readonly edlSchemaVersion?: string;
  readonly sourceAssets?: readonly Record<string, unknown>[];
  readonly transcriptVersions?: readonly Record<string, unknown>[];
  readonly edlSnapshots?: readonly Record<string, unknown>[];
  readonly renderHistory?: readonly Record<string, unknown>[];
  /** Unknown forward/extension fields preserved verbatim across migrations */
  readonly [extraKey: string]: unknown;
}

export interface ProjectMigrationResult {
  readonly ok: boolean;
  readonly decision: CompatibilityDecision;
  readonly migratedProject: PersistedProjectEnvelope | null;
  readonly rollbackSnapshot: PersistedProjectEnvelope | null;
  readonly preservedUnknownKeys: readonly string[];
  readonly migrationSteps: readonly string[];
  readonly error?: string;
}

const KNOWN_PROJECT_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'projectName',
  'createdAtMs',
  'updatedAtMs',
  'transcriptSchemaVersion',
  'edlSchemaVersion',
  'sourceAssets',
  'transcriptVersions',
  'edlSnapshots',
  'renderHistory',
]);

export function checkProjectSchemaCompatibility(
  rawProject: unknown,
): { readonly decision: CompatibilityDecision; readonly reason: string } {
  if (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject)) {
    return { decision: 'INVALID_SCHEMA', reason: 'Project record is not a valid JSON object.' };
  }
  const obj = rawProject as Record<string, unknown>;
  const ver = obj.schemaVersion;
  if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < 0) {
    return {
      decision: 'INVALID_SCHEMA',
      reason: `Missing or invalid integer schemaVersion: ${String(ver)}.`,
    };
  }
  if (ver > AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion) {
    return {
      decision: 'UNSUPPORTED_FUTURE_VERSION',
      reason: `Project schema v${ver} is newer than supported v${AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion}; update Avapardaz before opening.`,
    };
  }
  if (ver < AVAPARDAZ_VERSION_CONTRACT.minSupportedProjectSchemaVersion) {
    return {
      decision: 'UNSUPPORTED_LEGACY_VERSION',
      reason: `Project schema v${ver} predates minimum supported v${AVAPARDAZ_VERSION_CONTRACT.minSupportedProjectSchemaVersion}.`,
    };
  }
  if (ver < AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion) {
    return {
      decision: 'MIGRATION_REQUIRED',
      reason: `Project schema v${ver} requires safe forward migration to v${AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion}.`,
    };
  }
  return {
    decision: 'COMPATIBLE',
    reason: `Project schema v${ver} matches active version.`,
  };
}

/**
 * Safely migrates persisted project data to the active schema version:
 * - Preserves an untouched rollback copy before modifying anything.
 * - Never discards unknown keys.
 * - Rejects unsupported future versions without mutating or destroying input data.
 */
export function migratePersistedProjectSafely(
  rawProject: unknown,
  nowMs = Date.now(),
): ProjectMigrationResult {
  const check = checkProjectSchemaCompatibility(rawProject);
  if (
    check.decision === 'INVALID_SCHEMA' ||
    check.decision === 'UNSUPPORTED_FUTURE_VERSION' ||
    check.decision === 'UNSUPPORTED_LEGACY_VERSION'
  ) {
    return {
      ok: false,
      decision: check.decision,
      migratedProject: null,
      rollbackSnapshot: null,
      preservedUnknownKeys: [],
      migrationSteps: [],
      error: check.reason,
    };
  }

  const input = rawProject as PersistedProjectEnvelope;
  if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    return {
      ok: false,
      decision: 'INVALID_SCHEMA',
      migratedProject: null,
      rollbackSnapshot: null,
      preservedUnknownKeys: [],
      migrationSteps: [],
      error: 'Persisted project is missing a non-empty projectId.',
    };
  }

  const rollbackSnapshot: PersistedProjectEnvelope = Object.freeze(structuredClone(input));
  const preservedUnknownKeys = Object.keys(input).filter((k) => !KNOWN_PROJECT_KEYS.has(k));

  if (check.decision === 'COMPATIBLE') {
    return {
      ok: true,
      decision: 'COMPATIBLE',
      migratedProject: structuredClone(input),
      rollbackSnapshot,
      preservedUnknownKeys,
      migrationSteps: [],
    };
  }

  // Forward migration v1 -> v2 (preserves all unknown keys verbatim)
  const migrated: Record<string, unknown> = structuredClone(input);
  const steps: string[] = [];

  if (input.schemaVersion === 1) {
    migrated.schemaVersion = 2;
    if (migrated.transcriptSchemaVersion === undefined) {
      migrated.transcriptSchemaVersion = AVAPARDAZ_VERSION_CONTRACT.transcriptSchemaVersion;
    }
    if (migrated.edlSchemaVersion === undefined) {
      migrated.edlSchemaVersion = AVAPARDAZ_VERSION_CONTRACT.edlSchemaVersion;
    }
    if (!Array.isArray(migrated.renderHistory)) {
      migrated.renderHistory = [];
    }
    migrated.updatedAtMs = typeof input.updatedAtMs === 'number' ? input.updatedAtMs : nowMs;
    steps.push('Migrated project schema v1 -> v2 (added versioned transcript/EDL/renderHistory metadata while preserving all unknown fields).');
  }

  return {
    ok: true,
    decision: 'MIGRATION_REQUIRED',
    migratedProject: migrated as PersistedProjectEnvelope,
    rollbackSnapshot,
    preservedUnknownKeys,
    migrationSteps: steps,
  };
}

export function buildReleaseManifestMetadata(params: {
  readonly assets: readonly { readonly path: string; readonly bytes: number; readonly sha256?: string }[];
  readonly buildTimestampIso?: string;
}) {
  const buildTimestampIso = params.buildTimestampIso ?? new Date().toISOString();
  const assetSignature = params.assets.map((a) => `${a.path}:${a.bytes}:${a.sha256 ?? ''}`).join('|');
  return Object.freeze({
    appVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
    buildId: AVAPARDAZ_VERSION_CONTRACT.buildId,
    buildTimestampIso,
    schemas: {
      project: AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion,
      transcript: AVAPARDAZ_VERSION_CONTRACT.transcriptSchemaVersion,
      edl: AVAPARDAZ_VERSION_CONTRACT.edlSchemaVersion,
      renderMetadata: AVAPARDAZ_VERSION_CONTRACT.renderMetadataVersion,
      modelManifest: AVAPARDAZ_VERSION_CONTRACT.modelManifestVersion,
      workerProtocol: AVAPARDAZ_VERSION_CONTRACT.workerProtocolVersion,
      localStorage: AVAPARDAZ_VERSION_CONTRACT.localStorageSchemaVersion,
    },
    modelCompatibility: {
      supportedArchitectures: ['FASTCONFORMER_CTC', 'WHISPER_SEQ2SEQ'] as const,
      supportedRuntimes: ['onnxruntime-web/wasm', 'onnxruntime-web/webgpu'] as const,
      requiresSha256Verification: true,
    },
    assetCount: params.assets.length,
    manifestIntegrityDigest: `rel_${deterministicHexHash(assetSignature)}`,
    assets: params.assets,
  });
}
