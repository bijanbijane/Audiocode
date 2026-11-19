import {
  AIRecommendationRecord,
  ClipKind,
  ProjectDocument,
  RecommendationStatus,
  TimelineClip,
  TimelineTrack,
} from '../contracts/project-schema.contract';
import {
  DisfluencyType,
  MultiTrackCutStrategy,
  ProsodicWarningType,
} from '../contracts/persian-editing.contract';
import { SampleRate } from '../contracts/timebase.contract';
import {
  AssetIdentityRecord,
  ProjectCompatibilityStatus,
  ProjectLifecycleAndMigrationEngine,
} from '../project-core/ProjectLifecycleAndMigrationEngine';
import { AVAPARDAZ_MEMORY_POLICY } from './memory/MemoryPolicy';

/**
 * Runtime Reliability — Verified Recovery Checkpoint Envelope, Canonical Hashing & Schema Validation.
 *
 * Security & Integrity Note:
 * - Digests use SHA-256 over canonical JSON for tamper/corruption detection (integrity verification),
 *   NOT encryption or confidentiality.
 * - Credentials, access tokens, provider secrets, and full PCM audio payloads are strictly rejected.
 */

export const RECOVERY_ENVELOPE_FORMAT_VERSION = 2 as const;
export const MAX_PROJECT_ID_LENGTH = 128;
/** Default max serialized checkpoint envelope size (4 MiB — well below 32 MiB audio cache & 1 GiB app hard limit). */
export const DEFAULT_MAX_CHECKPOINT_BYTES = Math.min(
  4 * 1024 * 1024,
  Math.floor(AVAPARDAZ_MEMORY_POLICY.audioCacheBytes / 4),
);

export type CheckpointShutdownState = 'DIRTY_ACTIVE' | 'CLEAN_SHUTDOWN';

export type RecoveryInspectionStatus =
  | 'NO_RECOVERY_AVAILABLE'
  | 'RECOVERY_AVAILABLE'
  | 'RECOVERY_CORRUPTED'
  | 'RECOVERY_INCOMPATIBLE'
  | 'RECOVERY_STORAGE_UNAVAILABLE'
  | 'RECOVERY_VALIDATION_FAILED';

export type RecoveryErrorCode =
  | 'INVALID_PROJECT_ID'
  | 'PROJECT_ID_MISMATCH'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_PERMISSION_DENIED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_READ_FAILED'
  | 'WRITE_CANCELLED'
  | 'STALE_SEQUENCE_REJECTED'
  | 'PAYLOAD_TOO_LARGE'
  | 'FORBIDDEN_SECRET_DATA'
  | 'CORRUPT_JSON'
  | 'INVALID_ENVELOPE_STRUCTURE'
  | 'UNSUPPORTED_ENVELOPE_VERSION'
  | 'DIGEST_MISMATCH'
  | 'CRYPTO_UNAVAILABLE'
  | 'INVALID_PROJECT_SCHEMA'
  | 'UNSUPPORTED_PROJECT_SCHEMA'
  | 'MIGRATION_FAILED'
  | 'LOCK_NOT_HELD'
  | 'LOCK_CONTENDED'
  | 'CONFLICT_STALE_CHECKPOINT'
  | 'CONFLICT_NEWER_CHECKPOINT_EXISTS';

export interface RecoveryRuntimeCompatibility {
  readonly audioEngineMajor: string;
  readonly processingNodeCatalogVersion: string;
  readonly minSupportedEnvelopeVersion: number;
}

export interface RecoveryCheckpointPayload {
  readonly envelopeVersion: typeof RECOVERY_ENVELOPE_FORMAT_VERSION;
  readonly projectId: string;
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly sequenceNumber: number;
  readonly createdAtMs: number;
  readonly shutdownState: CheckpointShutdownState;
  readonly projectSchemaVersion: number;
  readonly runtimeCompatibility: RecoveryRuntimeCompatibility;
  readonly fencingToken: number | null;
  readonly requiredAssetIdentities: readonly AssetIdentityRecord[];
  readonly snapshot: ProjectDocument;
}

export interface RecoveryCheckpointEnvelope extends RecoveryCheckpointPayload {
  readonly integrity: {
    readonly algorithm: 'SHA-256';
    readonly canonicalization: 'SORTED_KEYS_JSON_V1';
    readonly digestHex: string;
  };
}

export interface ProjectSchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface EnvelopeVerificationResult {
  readonly status: RecoveryInspectionStatus;
  readonly errorCode: RecoveryErrorCode | null;
  readonly message: string;
  readonly envelope: RecoveryCheckpointEnvelope | null;
  readonly migratedSnapshot: ProjectDocument | null;
  readonly compatibility: ProjectCompatibilityStatus | null;
  readonly wasMigrated: boolean;
  readonly validationErrors: readonly string[];
}

export interface MediaAssetVerificationSummary {
  readonly verifiedAssetIds: readonly string[];
  readonly missingAssetIds: readonly string[];
  readonly contentChangedAssetIds: readonly string[];
  readonly unverifiedAssetIds: readonly string[];
  readonly allReferencedAssetsVerified: boolean;
}

const VALID_SAMPLE_RATES = new Set<number>([16000, 22050, 24000, 32000, 44100, 48000, 96000]);
const VALID_CLIP_KINDS = new Set<ClipKind>(['AUDIO_ASSET', 'ROOM_TONE_FILL']);
const VALID_REC_STATUSES = new Set<RecommendationStatus>([
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'MODIFIED',
  'SUPERSEDED',
  'INVALIDATED',
]);
const VALID_DISFLUENCY_TYPES = new Set<DisfluencyType>([
  'INDEPENDENT_FILLER',
  'COARTICULATED_STRETCH',
  'WORD_REPETITION',
  'LONG_PAUSE',
  'INCOMPLETE_PHRASE',
]);
const VALID_CUT_STRATEGIES = new Set<MultiTrackCutStrategy>([
  'GLOBAL_SYNC_RIPPLE',
  'IN_PLACE_ROOM_TONE',
]);
const VALID_PROSODIC_WARNINGS = new Set<ProsodicWarningType>([
  'TRAILING_EZAFE_RISK',
  'COMPOUND_VERB_SPLIT',
  'CROSSTALK_BLEED_ACTIVE',
]);

const FORBIDDEN_CREDENTIAL_KEY_PATTERN =
  /^(api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|client[-_]?secret|private[-_]?key|secret[-_]?key|password|authorization|auth[-_]?header|session[-_]?cookie)$/i;

const FORBIDDEN_EMBEDDED_AUDIO_KEY_PATTERN =
  /^(pcm|pcmBuffer|pcmSources|rawAudioBytes|audioBuffer|base64Audio|wavBytes)$/i;

const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;

/**
 * Strictly validates a project identifier before using it for locking or storage namespaces.
 * Rejects empty IDs, path separators, traversal sequences, control characters, and excessive lengths.
 */
export function validateProjectId(projectId: unknown): {
  readonly valid: boolean;
  readonly reason: string | null;
} {
  if (typeof projectId !== 'string') {
    return { valid: false, reason: 'Project identifier must be a string.' };
  }
  if (projectId.length === 0 || projectId.trim().length === 0) {
    return { valid: false, reason: 'Project identifier must not be empty or whitespace.' };
  }
  if (projectId.length > MAX_PROJECT_ID_LENGTH) {
    return {
      valid: false,
      reason: `Project identifier exceeds maximum length of ${MAX_PROJECT_ID_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHAR_REGEX.test(projectId)) {
    return { valid: false, reason: 'Project identifier contains invalid control characters.' };
  }
  if (projectId.includes('/') || projectId.includes('\\')) {
    return { valid: false, reason: 'Project identifier must not contain path separators.' };
  }
  if (
    projectId === '.' ||
    projectId === '..' ||
    projectId.includes('..') ||
    projectId.startsWith('.') ||
    projectId.endsWith('.')
  ) {
    return { valid: false, reason: 'Project identifier contains forbidden path traversal syntax.' };
  }
  return { valid: true, reason: null };
}

export function assertValidProjectId(projectId: string): string {
  const check = validateProjectId(projectId);
  if (!check.valid) {
    const err = new Error(`INVALID_PROJECT_ID: ${check.reason ?? 'Invalid project identifier.'}`);
    (err as Error & { code?: RecoveryErrorCode }).code = 'INVALID_PROJECT_ID';
    throw err;
  }
  return projectId;
}

/**
 * Injective, collision-free, filesystem-safe storage key encoder.
 * Two distinct valid projectIds NEVER map to the same storage key, and the output
 * contains only [a-f0-9] prefixed by `prj_`, guaranteeing it cannot escape any storage directory.
 */
export function encodeProjectStorageKey(projectId: string): string {
  assertValidProjectId(projectId);
  const bytes = new TextEncoder().encode(projectId);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `prj_${hex}`;
}

/**
 * Deterministic canonical JSON serializer (sorted object keys recursively).
 */
export function canonicalizeJsonValue(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('CANONICAL_JSON_ERROR: Non-finite number cannot be canonically serialized.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : canonicalizeJsonValue(item)));
    return `[${items.join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJsonValue(record[k])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`CANONICAL_JSON_ERROR: Unsupported value type '${t}'.`);
}

/**
 * Computes SHA-256 hex digest using Web Crypto SubtleCrypto.
 */
export async function computeSha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    const err = new Error('CRYPTO_UNAVAILABLE: Web Crypto SHA-256 digest is unavailable.');
    (err as Error & { code?: RecoveryErrorCode }).code = 'CRYPTO_UNAVAILABLE';
    throw err;
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Recursively scans an object graph to ensure no API secrets, tokens, or raw audio buffers
 * are accidentally embedded into a crash recovery checkpoint.
 */
export function detectForbiddenCheckpointContent(value: unknown, path = 'root'): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `Binary audio or typed-array payload is forbidden in checkpoint at '${path}'.`;
  }
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = detectForbiddenCheckpointContent(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CREDENTIAL_KEY_PATTERN.test(k)) {
      return `Forbidden credential/secret field '${k}' detected at '${path}.${k}'.`;
    }
    if (FORBIDDEN_EMBEDDED_AUDIO_KEY_PATTERN.test(k)) {
      return `Forbidden raw audio payload field '${k}' detected at '${path}.${k}'.`;
    }
    const hit = detectForbiddenCheckpointContent(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidTimeRange(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const start = v.start;
  const end = v.end;
  return (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start
  );
}

function isValidAssetIdentityRecord(v: unknown): v is AssetIdentityRecord {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.assetId === 'string' &&
    v.assetId.trim().length > 0 &&
    typeof v.contentVersion === 'number' &&
    Number.isInteger(v.contentVersion) &&
    v.contentVersion >= 1 &&
    typeof v.fullContentSha256 === 'string' &&
    v.fullContentSha256.trim().length > 0 &&
    typeof v.partialFingerprintSha256 === 'string' &&
    v.partialFingerprintSha256.trim().length > 0 &&
    typeof v.fileSize === 'number' &&
    Number.isFinite(v.fileSize) &&
    v.fileSize >= 0 &&
    typeof v.sampleRate === 'number' &&
    VALID_SAMPLE_RATES.has(v.sampleRate) &&
    typeof v.channelCount === 'number' &&
    Number.isInteger(v.channelCount) &&
    v.channelCount >= 1 &&
    v.channelCount <= 16 &&
    typeof v.sampleCount === 'number' &&
    Number.isInteger(v.sampleCount) &&
    v.sampleCount >= 0 &&
    typeof v.originalFileName === 'string' &&
    v.originalFileName.trim().length > 0
  );
}

/**
 * Strict runtime validator for canonical ProjectDocument structures.
 * Never repairs corrupted fields silently.
 */
export function validateProjectDocumentSchema(raw: unknown): ProjectSchemaValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['Project snapshot must be a non-null object.'] };
  }

  const pidCheck = validateProjectId(raw.projectId);
  if (!pidCheck.valid) {
    errors.push(`projectId: ${pidCheck.reason}`);
  }

  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 256) {
    errors.push('name must be a non-empty string up to 256 characters.');
  }

  if (
    typeof raw.canonicalSampleRate !== 'number' ||
    !VALID_SAMPLE_RATES.has(raw.canonicalSampleRate)
  ) {
    errors.push('canonicalSampleRate must be a supported canonical sample rate.');
  }

  if (
    typeof raw.revision !== 'number' ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0
  ) {
    errors.push('revision must be a non-negative safe integer.');
  }

  if (!isPlainObject(raw.versions)) {
    errors.push('versions must be an object.');
  } else {
    const v = raw.versions;
    if (
      typeof v.projectSchemaVersion !== 'number' ||
      !Number.isInteger(v.projectSchemaVersion) ||
      v.projectSchemaVersion < 1
    ) {
      errors.push('versions.projectSchemaVersion must be a positive integer.');
    }
    if (typeof v.audioEngineVersion !== 'string' || v.audioEngineVersion.trim().length === 0) {
      errors.push('versions.audioEngineVersion must be a non-empty string.');
    }
    if (
      typeof v.processingNodeCatalogVersion !== 'string' ||
      v.processingNodeCatalogVersion.trim().length === 0
    ) {
      errors.push('versions.processingNodeCatalogVersion must be a non-empty string.');
    }
    if (
      typeof v.activeModelBundleVersion !== 'string' ||
      v.activeModelBundleVersion.trim().length === 0
    ) {
      errors.push('versions.activeModelBundleVersion must be a non-empty string.');
    }
  }

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();

  if (!Array.isArray(raw.tracks)) {
    errors.push('tracks must be an array.');
  } else {
    for (let tIdx = 0; tIdx < raw.tracks.length; tIdx++) {
      const t = raw.tracks[tIdx];
      const prefix = `tracks[${tIdx}]`;
      if (!isPlainObject(t)) {
        errors.push(`${prefix} must be an object.`);
        continue;
      }
      if (typeof t.id !== 'string' || t.id.trim().length === 0) {
        errors.push(`${prefix}.id must be a non-empty string.`);
      } else if (trackIds.has(t.id)) {
        errors.push(`${prefix}.id '${t.id}' is duplicated.`);
      } else {
        trackIds.add(t.id);
      }

      if (typeof t.name !== 'string' || t.name.trim().length === 0) {
        errors.push(`${prefix}.name must be a non-empty string.`);
      }
      if (t.syncGroupId !== null && typeof t.syncGroupId !== 'string') {
        errors.push(`${prefix}.syncGroupId must be a string or null.`);
      }
      if (t.speakerId !== null && typeof t.speakerId !== 'string') {
        errors.push(`${prefix}.speakerId must be a string or null.`);
      }
      if (typeof t.muted !== 'boolean') {
        errors.push(`${prefix}.muted must be a boolean.`);
      }
      if (typeof t.solo !== 'boolean') {
        errors.push(`${prefix}.solo must be a boolean.`);
      }

      if (!Array.isArray(t.clips)) {
        errors.push(`${prefix}.clips must be an array.`);
      } else {
        for (let cIdx = 0; cIdx < t.clips.length; cIdx++) {
          const c = t.clips[cIdx];
          const cPrefix = `${prefix}.clips[${cIdx}]`;
          if (!isPlainObject(c)) {
            errors.push(`${cPrefix} must be an object.`);
            continue;
          }
          if (typeof c.id !== 'string' || c.id.trim().length === 0) {
            errors.push(`${cPrefix}.id must be a non-empty string.`);
          } else if (clipIds.has(c.id)) {
            errors.push(`${cPrefix}.id '${c.id}' is duplicated.`);
          } else {
            clipIds.add(c.id);
          }
          if (typeof c.trackId !== 'string' || (typeof t.id === 'string' && c.trackId !== t.id)) {
            errors.push(`${cPrefix}.trackId must match owning track id.`);
          }
          if (typeof c.kind !== 'string' || !VALID_CLIP_KINDS.has(c.kind as ClipKind)) {
            errors.push(`${cPrefix}.kind must be AUDIO_ASSET or ROOM_TONE_FILL.`);
          }
          if (typeof c.assetId !== 'string' || c.assetId.trim().length === 0) {
            errors.push(`${cPrefix}.assetId must be a non-empty string.`);
          }
          if (!isValidTimeRange(c.sourceRange)) {
            errors.push(`${cPrefix}.sourceRange must have finite safe integer start >= 0 and end > start.`);
          }
          if (!isValidTimeRange(c.timelineRange)) {
            errors.push(`${cPrefix}.timelineRange must have finite safe integer start >= 0 and end > start.`);
          }
          if (
            typeof c.fadeInFlicks !== 'number' ||
            !Number.isFinite(c.fadeInFlicks) ||
            c.fadeInFlicks < 0
          ) {
            errors.push(`${cPrefix}.fadeInFlicks must be a non-negative finite number.`);
          }
          if (
            typeof c.fadeOutFlicks !== 'number' ||
            !Number.isFinite(c.fadeOutFlicks) ||
            c.fadeOutFlicks < 0
          ) {
            errors.push(`${cPrefix}.fadeOutFlicks must be a non-negative finite number.`);
          }
          if (
            typeof c.gainDb !== 'number' ||
            !Number.isFinite(c.gainDb) ||
            c.gainDb < -144 ||
            c.gainDb > 48
          ) {
            errors.push(`${cPrefix}.gainDb must be a finite number in [-144, 48].`);
          }
        }
      }
    }
  }

  const recIds = new Set<string>();
  if (!Array.isArray(raw.recommendations)) {
    errors.push('recommendations must be an array.');
  } else {
    for (let rIdx = 0; rIdx < raw.recommendations.length; rIdx++) {
      const r = raw.recommendations[rIdx];
      const rPrefix = `recommendations[${rIdx}]`;
      if (!isPlainObject(r)) {
        errors.push(`${rPrefix} must be an object.`);
        continue;
      }
      if (typeof r.id !== 'string' || r.id.trim().length === 0) {
        errors.push(`${rPrefix}.id must be a non-empty string.`);
      } else if (recIds.has(r.id)) {
        errors.push(`${rPrefix}.id '${r.id}' is duplicated.`);
      } else {
        recIds.add(r.id);
      }
      if (typeof r.targetTrackId !== 'string' || r.targetTrackId.trim().length === 0) {
        errors.push(`${rPrefix}.targetTrackId must be a non-empty string.`);
      } else if (trackIds.size > 0 && !trackIds.has(r.targetTrackId)) {
        errors.push(`${rPrefix}.targetTrackId '${r.targetTrackId}' does not reference an existing track.`);
      }
      if (
        typeof r.disfluencyType !== 'string' ||
        !VALID_DISFLUENCY_TYPES.has(r.disfluencyType as DisfluencyType)
      ) {
        errors.push(`${rPrefix}.disfluencyType is invalid.`);
      }
      if (typeof r.associatedText !== 'string') {
        errors.push(`${rPrefix}.associatedText must be a string.`);
      }
      if (
        typeof r.status !== 'string' ||
        !VALID_REC_STATUSES.has(r.status as RecommendationStatus)
      ) {
        errors.push(`${rPrefix}.status is invalid.`);
      }
      if (
        typeof r.createdAtProjectRevision !== 'number' ||
        !Number.isSafeInteger(r.createdAtProjectRevision) ||
        r.createdAtProjectRevision < 0
      ) {
        errors.push(`${rPrefix}.createdAtProjectRevision must be a non-negative integer.`);
      }
      if (!isPlainObject(r.spliceDescriptor)) {
        errors.push(`${rPrefix}.spliceDescriptor must be an object.`);
      } else {
        const sd = r.spliceDescriptor;
        if (!isValidTimeRange(sd.rawAiRange)) {
          errors.push(`${rPrefix}.spliceDescriptor.rawAiRange is invalid.`);
        }
        if (!isValidTimeRange(sd.snappedAcousticRange)) {
          errors.push(`${rPrefix}.spliceDescriptor.snappedAcousticRange is invalid.`);
        }
        if (
          typeof sd.fadeInDurationFlicks !== 'number' ||
          !Number.isFinite(sd.fadeInDurationFlicks) ||
          sd.fadeInDurationFlicks < 0
        ) {
          errors.push(`${rPrefix}.spliceDescriptor.fadeInDurationFlicks is invalid.`);
        }
        if (
          typeof sd.fadeOutDurationFlicks !== 'number' ||
          !Number.isFinite(sd.fadeOutDurationFlicks) ||
          sd.fadeOutDurationFlicks < 0
        ) {
          errors.push(`${rPrefix}.spliceDescriptor.fadeOutDurationFlicks is invalid.`);
        }
        if (
          typeof sd.injectRoomToneFlicks !== 'number' ||
          !Number.isFinite(sd.injectRoomToneFlicks) ||
          sd.injectRoomToneFlicks < 0
        ) {
          errors.push(`${rPrefix}.spliceDescriptor.injectRoomToneFlicks is invalid.`);
        }
        if (
          typeof sd.cutStrategy !== 'string' ||
          !VALID_CUT_STRATEGIES.has(sd.cutStrategy as MultiTrackCutStrategy)
        ) {
          errors.push(`${rPrefix}.spliceDescriptor.cutStrategy is invalid.`);
        }
        if (
          !Array.isArray(sd.prosodicWarnings) ||
          sd.prosodicWarnings.some(
            (w) => typeof w !== 'string' || !VALID_PROSODIC_WARNINGS.has(w as ProsodicWarningType),
          )
        ) {
          errors.push(`${rPrefix}.spliceDescriptor.prosodicWarnings contains invalid entries.`);
        }
        if (
          typeof sd.confidence !== 'number' ||
          !Number.isFinite(sd.confidence) ||
          sd.confidence < 0 ||
          sd.confidence > 1
        ) {
          errors.push(`${rPrefix}.spliceDescriptor.confidence must be within [0, 1].`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Builds and signs a versioned checkpoint envelope with canonical SHA-256 digest.
 */
export async function buildVerifiedCheckpointEnvelope(params: {
  readonly snapshot: ProjectDocument;
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly sequenceNumber: number;
  readonly createdAtMs: number;
  readonly shutdownState: CheckpointShutdownState;
  readonly fencingToken: number | null;
  readonly requiredAssetIdentities?: readonly AssetIdentityRecord[];
  readonly maxCheckpointBytes?: number;
}): Promise<{
  readonly envelope: RecoveryCheckpointEnvelope;
  readonly serializedJson: string;
  readonly byteLength: number;
}> {
  assertValidProjectId(params.snapshot.projectId);

  const secretHit = detectForbiddenCheckpointContent(params.snapshot, 'snapshot');
  if (secretHit) {
    const err = new Error(`FORBIDDEN_SECRET_DATA: ${secretHit}`);
    (err as Error & { code?: RecoveryErrorCode }).code = 'FORBIDDEN_SECRET_DATA';
    throw err;
  }

  const schemaCheck = validateProjectDocumentSchema(params.snapshot);
  if (!schemaCheck.valid) {
    const err = new Error(`INVALID_PROJECT_SCHEMA: ${schemaCheck.errors.join(' | ')}`);
    (err as Error & { code?: RecoveryErrorCode }).code = 'INVALID_PROJECT_SCHEMA';
    throw err;
  }

  const assetIdentities = params.requiredAssetIdentities ?? [];
  for (let i = 0; i < assetIdentities.length; i++) {
    if (!isValidAssetIdentityRecord(assetIdentities[i])) {
      const err = new Error(`INVALID_PROJECT_SCHEMA: requiredAssetIdentities[${i}] is malformed.`);
      (err as Error & { code?: RecoveryErrorCode }).code = 'INVALID_PROJECT_SCHEMA';
      throw err;
    }
  }

  if (!Number.isSafeInteger(params.sequenceNumber) || params.sequenceNumber < 1) {
    const err = new Error('INVALID_ENVELOPE_STRUCTURE: sequenceNumber must be a positive integer.');
    (err as Error & { code?: RecoveryErrorCode }).code = 'INVALID_ENVELOPE_STRUCTURE';
    throw err;
  }

  const payload: RecoveryCheckpointPayload = {
    envelopeVersion: RECOVERY_ENVELOPE_FORMAT_VERSION,
    projectId: params.snapshot.projectId,
    sessionId: params.sessionId,
    checkpointId: params.checkpointId,
    sequenceNumber: params.sequenceNumber,
    createdAtMs: params.createdAtMs,
    shutdownState: params.shutdownState,
    projectSchemaVersion: params.snapshot.versions.projectSchemaVersion,
    runtimeCompatibility: {
      audioEngineMajor: ProjectLifecycleAndMigrationEngine.CURRENT_AUDIO_ENGINE_MAJOR,
      processingNodeCatalogVersion: ProjectLifecycleAndMigrationEngine.CURRENT_NODE_CATALOG_VERSION,
      minSupportedEnvelopeVersion: RECOVERY_ENVELOPE_FORMAT_VERSION,
    },
    fencingToken: params.fencingToken,
    requiredAssetIdentities: assetIdentities.map((a) => ({ ...a })),
    snapshot: structuredClone(params.snapshot),
  };

  const canonicalPayload = canonicalizeJsonValue(payload);
  const digestHex = await computeSha256Hex(canonicalPayload);

  const envelope: RecoveryCheckpointEnvelope = {
    ...payload,
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: 'SORTED_KEYS_JSON_V1',
      digestHex,
    },
  };

  const serializedJson = JSON.stringify(envelope);
  const byteLength = new TextEncoder().encode(serializedJson).byteLength;
  const maxBytes = params.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  if (byteLength > maxBytes) {
    const err = new Error(
      `PAYLOAD_TOO_LARGE: Checkpoint size (${byteLength} bytes) exceeds configured limit (${maxBytes} bytes).`,
    );
    (err as Error & { code?: RecoveryErrorCode }).code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  return { envelope, serializedJson, byteLength };
}

/**
 * Parses, integrity-verifies, schema-validates, and safely migrates a serialized recovery checkpoint.
 */
export async function verifyAndParseCheckpointEnvelope(params: {
  readonly rawJson: string;
  readonly expectedProjectId: string;
  readonly maxCheckpointBytes?: number;
  readonly currentSupportedEngineMajor?: number;
}): Promise<EnvelopeVerificationResult> {
  const pidCheck = validateProjectId(params.expectedProjectId);
  if (!pidCheck.valid) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'INVALID_PROJECT_ID',
      message: pidCheck.reason ?? 'Invalid expected project identifier.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: [pidCheck.reason ?? 'Invalid expected project identifier.'],
    };
  }

  const maxBytes = params.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  const rawByteLength = new TextEncoder().encode(params.rawJson).byteLength;
  if (rawByteLength > maxBytes) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'PAYLOAD_TOO_LARGE',
      message: `Recovery checkpoint (${rawByteLength} bytes) exceeds maximum allowed limit (${maxBytes} bytes).`,
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['PAYLOAD_TOO_LARGE'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawJson);
  } catch {
    return {
      status: 'RECOVERY_CORRUPTED',
      errorCode: 'CORRUPT_JSON',
      message: 'Recovery checkpoint JSON is truncated or syntactically corrupted.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['CORRUPT_JSON'],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      status: 'RECOVERY_CORRUPTED',
      errorCode: 'INVALID_ENVELOPE_STRUCTURE',
      message: 'Recovery checkpoint root must be a JSON object.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['INVALID_ENVELOPE_STRUCTURE'],
    };
  }

  // Validate envelope version first
  if (typeof parsed.envelopeVersion !== 'number' || !Number.isInteger(parsed.envelopeVersion)) {
    return {
      status: 'RECOVERY_CORRUPTED',
      errorCode: 'INVALID_ENVELOPE_STRUCTURE',
      message: 'Missing or non-integer envelopeVersion in recovery checkpoint.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['Missing or invalid envelopeVersion.'],
    };
  }
  if (parsed.envelopeVersion !== RECOVERY_ENVELOPE_FORMAT_VERSION) {
    return {
      status: 'RECOVERY_INCOMPATIBLE',
      errorCode: 'UNSUPPORTED_ENVELOPE_VERSION',
      message: `Unsupported checkpoint envelope version ${parsed.envelopeVersion}; expected ${RECOVERY_ENVELOPE_FORMAT_VERSION}.`,
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: [`Unsupported envelope version: ${parsed.envelopeVersion}`],
    };
  }

  // Validate required envelope metadata fields
  const fieldErrors: string[] = [];
  if (typeof parsed.projectId !== 'string' || !validateProjectId(parsed.projectId).valid) {
    fieldErrors.push('Invalid envelope projectId.');
  }
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId.trim().length === 0) {
    fieldErrors.push('Invalid envelope sessionId.');
  }
  if (typeof parsed.checkpointId !== 'string' || parsed.checkpointId.trim().length === 0) {
    fieldErrors.push('Invalid envelope checkpointId.');
  }
  if (
    typeof parsed.sequenceNumber !== 'number' ||
    !Number.isSafeInteger(parsed.sequenceNumber) ||
    parsed.sequenceNumber < 1
  ) {
    fieldErrors.push('sequenceNumber must be a positive safe integer.');
  }
  if (
    typeof parsed.createdAtMs !== 'number' ||
    !Number.isFinite(parsed.createdAtMs) ||
    parsed.createdAtMs <= 0
  ) {
    fieldErrors.push('createdAtMs must be a positive finite timestamp.');
  }
  if (parsed.shutdownState !== 'DIRTY_ACTIVE' && parsed.shutdownState !== 'CLEAN_SHUTDOWN') {
    fieldErrors.push('shutdownState must be DIRTY_ACTIVE or CLEAN_SHUTDOWN.');
  }
  if (
    typeof parsed.projectSchemaVersion !== 'number' ||
    !Number.isInteger(parsed.projectSchemaVersion) ||
    parsed.projectSchemaVersion < 1
  ) {
    fieldErrors.push('projectSchemaVersion must be a positive integer.');
  }
  if (
    parsed.fencingToken !== null &&
    (typeof parsed.fencingToken !== 'number' ||
      !Number.isSafeInteger(parsed.fencingToken) ||
      parsed.fencingToken < 1)
  ) {
    fieldErrors.push('fencingToken must be null or a positive safe integer.');
  }
  if (!isPlainObject(parsed.runtimeCompatibility)) {
    fieldErrors.push('runtimeCompatibility must be an object.');
  } else {
    const rc = parsed.runtimeCompatibility;
    if (typeof rc.audioEngineMajor !== 'string' || rc.audioEngineMajor.trim().length === 0) {
      fieldErrors.push('runtimeCompatibility.audioEngineMajor must be a non-empty string.');
    }
    if (
      typeof rc.processingNodeCatalogVersion !== 'string' ||
      rc.processingNodeCatalogVersion.trim().length === 0
    ) {
      fieldErrors.push('runtimeCompatibility.processingNodeCatalogVersion must be a non-empty string.');
    }
    if (
      typeof rc.minSupportedEnvelopeVersion !== 'number' ||
      !Number.isInteger(rc.minSupportedEnvelopeVersion)
    ) {
      fieldErrors.push('runtimeCompatibility.minSupportedEnvelopeVersion must be an integer.');
    }
  }
  if (
    !Array.isArray(parsed.requiredAssetIdentities) ||
    parsed.requiredAssetIdentities.some((a) => !isValidAssetIdentityRecord(a))
  ) {
    fieldErrors.push('requiredAssetIdentities must be an array of valid AssetIdentityRecord items.');
  }
  if (!isPlainObject(parsed.integrity)) {
    fieldErrors.push('integrity metadata block is missing.');
  } else {
    if (parsed.integrity.algorithm !== 'SHA-256') {
      fieldErrors.push('integrity.algorithm must be SHA-256.');
    }
    if (parsed.integrity.canonicalization !== 'SORTED_KEYS_JSON_V1') {
      fieldErrors.push('integrity.canonicalization must be SORTED_KEYS_JSON_V1.');
    }
    if (
      typeof parsed.integrity.digestHex !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.integrity.digestHex)
    ) {
      fieldErrors.push('integrity.digestHex must be a 64-char lowercase hex SHA-256 digest.');
    }
  }

  if (fieldErrors.length > 0) {
    return {
      status: 'RECOVERY_CORRUPTED',
      errorCode: 'INVALID_ENVELOPE_STRUCTURE',
      message: `Recovery envelope failed structural validation: ${fieldErrors.join(' ')}`,
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: fieldErrors,
    };
  }

  // Verify Project ID equality before accepting payload
  if (parsed.projectId !== params.expectedProjectId) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'PROJECT_ID_MISMATCH',
      message: 'Recovery checkpoint belongs to a different project identifier.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['PROJECT_ID_MISMATCH'],
    };
  }

  // Recompute canonical SHA-256 integrity digest over all envelope fields except `integrity`
  const payloadWithoutIntegrity: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== 'integrity') {
      payloadWithoutIntegrity[k] = v;
    }
  }

  let computedDigest: string;
  try {
    const canonical = canonicalizeJsonValue(payloadWithoutIntegrity);
    computedDigest = await computeSha256Hex(canonical);
  } catch (err) {
    const code = (err as { code?: RecoveryErrorCode }).code ?? 'CORRUPT_JSON';
    return {
      status: code === 'CRYPTO_UNAVAILABLE' ? 'RECOVERY_STORAGE_UNAVAILABLE' : 'RECOVERY_CORRUPTED',
      errorCode: code,
      message: err instanceof Error ? err.message : 'Unable to compute recovery integrity digest.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: [code],
    };
  }

  const storedDigest = (parsed.integrity as { digestHex: string }).digestHex;
  if (computedDigest !== storedDigest) {
    return {
      status: 'RECOVERY_CORRUPTED',
      errorCode: 'DIGEST_MISMATCH',
      message: 'Recovery checkpoint integrity digest mismatch (tampered or corrupted payload).',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['DIGEST_MISMATCH'],
    };
  }

  // Verify no forbidden credentials or embedded audio payloads slipped into the snapshot
  const forbidden = detectForbiddenCheckpointContent(parsed.snapshot, 'snapshot');
  if (forbidden) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'FORBIDDEN_SECRET_DATA',
      message: forbidden,
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: [forbidden],
    };
  }

  // Deep project schema validation (never trust JSON.parse via unchecked cast)
  const schemaValidation = validateProjectDocumentSchema(parsed.snapshot);
  if (!schemaValidation.valid) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'INVALID_PROJECT_SCHEMA',
      message: `Recovered project snapshot failed schema validation: ${schemaValidation.errors.join(' | ')}`,
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: schemaValidation.errors,
    };
  }

  const verifiedEnvelope = parsed as unknown as RecoveryCheckpointEnvelope;
  const snapshot = verifiedEnvelope.snapshot;

  if (snapshot.projectId !== params.expectedProjectId) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'PROJECT_ID_MISMATCH',
      message: 'Snapshot inner projectId does not match expected project identifier.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['Snapshot inner projectId mismatch.'],
    };
  }

  if (snapshot.versions.projectSchemaVersion !== verifiedEnvelope.projectSchemaVersion) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'INVALID_ENVELOPE_STRUCTURE',
      message: 'Envelope projectSchemaVersion does not match snapshot.versions.projectSchemaVersion.',
      envelope: null,
      migratedSnapshot: null,
      compatibility: null,
      wasMigrated: false,
      validationErrors: ['projectSchemaVersion mismatch between envelope and snapshot.'],
    };
  }

  // Check runtime major compatibility
  const supportedEngineMajor =
    params.currentSupportedEngineMajor ??
    parseInt(ProjectLifecycleAndMigrationEngine.CURRENT_AUDIO_ENGINE_MAJOR, 10);
  const envelopeEngineMajor = parseInt(verifiedEnvelope.runtimeCompatibility.audioEngineMajor, 10);
  const snapshotEngineMajor = parseInt(snapshot.versions.audioEngineVersion.split('.')[0] ?? '1', 10);
  if (
    !Number.isFinite(envelopeEngineMajor) ||
    !Number.isFinite(snapshotEngineMajor) ||
    envelopeEngineMajor > supportedEngineMajor ||
    snapshotEngineMajor > supportedEngineMajor
  ) {
    return {
      status: 'RECOVERY_INCOMPATIBLE',
      errorCode: 'UNSUPPORTED_PROJECT_SCHEMA',
      message: `Recovery snapshot requires newer audio engine major version (${snapshot.versions.audioEngineVersion}).`,
      envelope: verifiedEnvelope,
      migratedSnapshot: null,
      compatibility: 'UNSUPPORTED',
      wasMigrated: false,
      validationErrors: ['Audio engine major version exceeds supported runtime.'],
    };
  }

  // Reject unsupported future schema versions explicitly
  if (snapshot.versions.projectSchemaVersion > ProjectLifecycleAndMigrationEngine.CURRENT_SCHEMA_VERSION) {
    return {
      status: 'RECOVERY_INCOMPATIBLE',
      errorCode: 'UNSUPPORTED_PROJECT_SCHEMA',
      message: `Unsupported future project schema version ${snapshot.versions.projectSchemaVersion} (max supported: ${ProjectLifecycleAndMigrationEngine.CURRENT_SCHEMA_VERSION}).`,
      envelope: verifiedEnvelope,
      migratedSnapshot: null,
      compatibility: 'UNSUPPORTED',
      wasMigrated: false,
      validationErrors: [
        `Future schema version ${snapshot.versions.projectSchemaVersion} cannot be safely restored for editing.`,
      ],
    };
  }

  // Apply existing safe migration engine
  try {
    const migration = ProjectLifecycleAndMigrationEngine.migrateProjectSafely(snapshot);
    if (migration.compatibility === 'UNSUPPORTED' || migration.compatibility === 'READ_ONLY') {
      return {
        status: 'RECOVERY_INCOMPATIBLE',
        errorCode: 'UNSUPPORTED_PROJECT_SCHEMA',
        message: migration.noticesFa.join(' ') || 'Recovered project schema is incompatible.',
        envelope: verifiedEnvelope,
        migratedSnapshot: null,
        compatibility: migration.compatibility,
        wasMigrated: false,
        validationErrors: migration.noticesFa,
      };
    }

    // Re-validate migrated document to ensure migration output conforms strictly to canonical schema
    const postMigrationCheck = validateProjectDocumentSchema(migration.migratedDocument);
    if (!postMigrationCheck.valid) {
      return {
        status: 'RECOVERY_VALIDATION_FAILED',
        errorCode: 'MIGRATION_FAILED',
        message: `Migrated snapshot failed post-migration schema validation: ${postMigrationCheck.errors.join(' | ')}`,
        envelope: verifiedEnvelope,
        migratedSnapshot: null,
        compatibility: 'UNSUPPORTED',
        wasMigrated: false,
        validationErrors: postMigrationCheck.errors,
      };
    }

    return {
      status:
        verifiedEnvelope.shutdownState === 'DIRTY_ACTIVE'
          ? 'RECOVERY_AVAILABLE'
          : 'NO_RECOVERY_AVAILABLE',
      errorCode: null,
      message:
        verifiedEnvelope.shutdownState === 'DIRTY_ACTIVE'
          ? 'Verified dirty recovery checkpoint is available.'
          : 'Latest verified checkpoint recorded a clean shutdown.',
      envelope: verifiedEnvelope,
      migratedSnapshot: migration.migratedDocument,
      compatibility: migration.compatibility,
      wasMigrated: migration.compatibility === 'COMPATIBLE_WITH_MIGRATION',
      validationErrors: [],
    };
  } catch (err) {
    return {
      status: 'RECOVERY_VALIDATION_FAILED',
      errorCode: 'MIGRATION_FAILED',
      message: err instanceof Error ? err.message : 'Project schema migration failed.',
      envelope: verifiedEnvelope,
      migratedSnapshot: null,
      compatibility: 'UNSUPPORTED',
      wasMigrated: false,
      validationErrors: [err instanceof Error ? err.message : 'MIGRATION_FAILED'],
    };
  }
}

/**
 * Verifies referenced media assets in a recovered project against locally available asset identities
 * without mutating or touching original audio files.
 */
export function verifyRecoveredMediaReferences(
  recoveredDoc: ProjectDocument,
  requiredAssetIdentities: readonly AssetIdentityRecord[],
  availableLocalAssetsMap: ReadonlyMap<string, AssetIdentityRecord>,
): MediaAssetVerificationSummary {
  const requiredById = new Map<string, AssetIdentityRecord>();
  for (const identity of requiredAssetIdentities) {
    requiredById.set(identity.assetId, identity);
  }

  // Collect every clip-referenced audio assetId so missing identity records are also surfaced
  const referencedIds = new Set<string>(requiredById.keys());
  for (const track of recoveredDoc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'AUDIO_ASSET') {
        referencedIds.add(clip.assetId);
      }
    }
  }

  const verifiedAssetIds: string[] = [];
  const missingAssetIds: string[] = [];
  const contentChangedAssetIds: string[] = [];
  const unverifiedAssetIds: string[] = [];

  for (const assetId of referencedIds) {
    const local = availableLocalAssetsMap.get(assetId);
    const expected = requiredById.get(assetId);

    if (!local) {
      missingAssetIds.push(assetId);
    } else if (!expected) {
      // Local asset exists, but checkpoint lacked a recorded content hash to verify it
      unverifiedAssetIds.push(assetId);
    } else if (
      local.fullContentSha256 !== expected.fullContentSha256 ||
      local.fileSize !== expected.fileSize
    ) {
      contentChangedAssetIds.push(assetId);
    } else {
      verifiedAssetIds.push(assetId);
    }
  }

  return {
    verifiedAssetIds,
    missingAssetIds,
    contentChangedAssetIds,
    unverifiedAssetIds,
    allReferencedAssetsVerified:
      missingAssetIds.length === 0 &&
      contentChangedAssetIds.length === 0 &&
      unverifiedAssetIds.length === 0,
  };
}
