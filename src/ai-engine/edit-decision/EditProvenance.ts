import {
  EDL_SCHEMA_VERSION,
  EditDecisionListSnapshot,
  EditProposal,
  EditValidationFailure,
  EdlPersistenceStatus,
  EdlSourceContext,
} from './EditDecisionTypes';

export interface EdlStorageAdapter {
  saveEdlJson(edlId: string, serializedJson: string): Promise<void>;
  loadEdlJson(edlId: string): Promise<string | null>;
}

/**
 * Deterministic 32-bit FNV-1a hash formatted as 8-char hex for stable, collision-resistant IDs
 * across repeated runs with identical inputs.
 */
export function deterministicHexHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildDeterministicProposalId(params: {
  readonly projectId: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly eventIds: readonly string[];
  readonly operation: string;
  readonly startSample: number | null;
  readonly endSample: number | null;
}): string {
  const key = [
    params.projectId,
    params.sourceAudioHash,
    params.transcriptVersion,
    [...params.eventIds].sort().join(','),
    params.operation,
    String(params.startSample ?? 'na'),
    String(params.endSample ?? 'na'),
  ].join('|');
  return `prop_${deterministicHexHash(key)}`;
}

export function buildDeterministicEdlId(context: EdlSourceContext): string {
  const key = [
    context.projectId,
    context.sourceAudioId,
    context.sourceAudioHash,
    context.transcriptVersion,
    String(context.sampleRate),
  ].join('|');
  return `edl_${deterministicHexHash(key)}`;
}

/**
 * Deeply freezes an object graph so EDL snapshots cannot be mutated in-place.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === 'object') {
      deepFreeze(child);
    }
  }
  return value;
}

export interface ProvenanceStalenessCheck {
  readonly isStale: boolean;
  readonly reasons: readonly string[];
}

/**
 * Checks whether a proposal's provenance still matches the active source audio, transcript,
 * alignment, and event detector versions.
 */
export function checkProposalProvenanceStaleness(
  proposal: EditProposal,
  current: {
    readonly sourceAudioHash?: string;
    readonly sourceAudioId?: string;
    readonly transcriptVersion?: string;
    readonly alignmentVersion?: string;
    readonly eventDetectorVersion?: string;
  },
): ProvenanceStalenessCheck {
  const reasons: string[] = [];

  if (
    current.sourceAudioHash !== undefined &&
    proposal.sourceAudioHash !== current.sourceAudioHash
  ) {
    reasons.push(
      `Source audio hash mismatch: proposal=${proposal.sourceAudioHash}, active=${current.sourceAudioHash}.`,
    );
  }
  if (
    current.sourceAudioId !== undefined &&
    proposal.sourceAudioId !== current.sourceAudioId
  ) {
    reasons.push(
      `Source audio ID mismatch: proposal=${proposal.sourceAudioId}, active=${current.sourceAudioId}.`,
    );
  }
  if (
    current.transcriptVersion !== undefined &&
    proposal.transcriptVersion !== current.transcriptVersion
  ) {
    reasons.push(
      `Transcript version mismatch: proposal=${proposal.transcriptVersion}, active=${current.transcriptVersion}.`,
    );
  }
  if (
    current.alignmentVersion !== undefined &&
    proposal.alignmentVersion !== undefined &&
    proposal.alignmentVersion !== current.alignmentVersion
  ) {
    reasons.push(
      `Alignment version mismatch: proposal=${proposal.alignmentVersion}, active=${current.alignmentVersion}.`,
    );
  }
  if (
    current.eventDetectorVersion !== undefined &&
    proposal.eventDetectorVersion !== current.eventDetectorVersion
  ) {
    reasons.push(
      `Event detector version mismatch: proposal=${proposal.eventDetectorVersion}, active=${current.eventDetectorVersion}.`,
    );
  }

  return {
    isStale: reasons.length > 0,
    reasons,
  };
}

function canonicalizeForSerialization(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForSerialization(item));
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) {
      sorted[key] = canonicalizeForSerialization(v);
    }
  }
  return sorted;
}

/**
 * Deterministic canonical JSON serialization for an EDL snapshot.
 * Strictly forbids storing raw PCM / audio blobs inside the EDL.
 */
export function serializeEdlSnapshot(edl: EditDecisionListSnapshot): string {
  const record = edl as unknown as Record<string, unknown>;
  if ('pcmMono' in record || 'audioBuffer' in record || 'rawAudio' in record) {
    throw new Error('INVALID_SERIALIZATION: Raw audio must never be embedded inside an EDL.');
  }
  return JSON.stringify(canonicalizeForSerialization(edl), null, 2);
}

export interface EdlDeserializationResult {
  readonly ok: boolean;
  readonly snapshot: EditDecisionListSnapshot | null;
  readonly failures: readonly EditValidationFailure[];
}

/**
 * Parses and validates a serialized EDL snapshot JSON string into an immutable snapshot.
 */
export function deserializeEdlSnapshot(serializedJson: string): EdlDeserializationResult {
  const failures: EditValidationFailure[] = [];

  if (typeof serializedJson !== 'string' || serializedJson.trim().length === 0) {
    failures.push({
      code: 'INVALID_SERIALIZATION',
      severity: 'ERROR',
      message: 'Serialized EDL payload is empty or not a string.',
      actionableFix: 'Provide a non-empty JSON string generated by serializeEdlSnapshot().',
    });
    return { ok: false, snapshot: null, failures };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedJson);
  } catch (err) {
    failures.push({
      code: 'INVALID_SERIALIZATION',
      severity: 'ERROR',
      message: `Failed to parse EDL JSON: ${err instanceof Error ? err.message : String(err)}`,
      actionableFix: 'Fix malformed JSON or regenerate EDL from source speech events.',
    });
    return { ok: false, snapshot: null, failures };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failures.push({
      code: 'INVALID_SERIALIZATION',
      severity: 'ERROR',
      message: 'Deserialized EDL root must be a JSON object.',
      actionableFix: 'Ensure the stored artifact is a valid EditDecisionListSnapshot object.',
    });
    return { ok: false, snapshot: null, failures };
  }

  const obj = parsed as Record<string, unknown>;

  if ('pcmMono' in obj || 'audioBuffer' in obj || 'rawAudio' in obj) {
    failures.push({
      code: 'INVALID_SERIALIZATION',
      severity: 'ERROR',
      message: 'EDL snapshot illegally contains embedded raw audio fields.',
      actionableFix: 'Strip raw audio buffers; EDL must store metadata and coordinates only.',
    });
  }

  if (obj.edlSchemaVersion !== EDL_SCHEMA_VERSION) {
    failures.push({
      code: 'INCOMPATIBLE_EDL_VERSION',
      severity: 'ERROR',
      message: `Incompatible EDL schema version "${String(obj.edlSchemaVersion)}"; expected "${EDL_SCHEMA_VERSION}".`,
      actionableFix: 'Migrate or regenerate the EDL using the current EditDecisionEngine.',
    });
  }

  if (typeof obj.projectId !== 'string' || obj.projectId.trim().length === 0) {
    failures.push({
      code: 'MISSING_SOURCE_IDENTITY',
      severity: 'ERROR',
      message: 'EDL snapshot is missing a valid projectId.',
      actionableFix: 'Attach a valid projectId before persisting the EDL.',
    });
  }

  if (typeof obj.sourceAudioHash !== 'string' || obj.sourceAudioHash.trim().length === 0) {
    failures.push({
      code: 'MISSING_SOURCE_IDENTITY',
      severity: 'ERROR',
      message: 'EDL snapshot is missing sourceAudioHash.',
      actionableFix: 'Compute and store the SHA-256 / content hash of the source audio asset.',
    });
  }

  if (typeof obj.transcriptVersion !== 'string' || obj.transcriptVersion.trim().length === 0) {
    failures.push({
      code: 'MISSING_TRANSCRIPT_VERSION',
      severity: 'ERROR',
      message: 'EDL snapshot is missing transcriptVersion.',
      actionableFix: 'Include the exact transcript version used to create the EDL.',
    });
  }

  if (!Array.isArray(obj.proposals) || !Array.isArray(obj.conflicts) || !Array.isArray(obj.decisionHistory)) {
    failures.push({
      code: 'INVALID_SERIALIZATION',
      severity: 'ERROR',
      message: 'EDL snapshot must contain arrays for proposals, conflicts, and decisionHistory.',
      actionableFix: 'Repair corrupted EDL structure or regenerate from source events.',
    });
  }

  if (failures.length > 0) {
    return { ok: false, snapshot: null, failures };
  }

  return {
    ok: true,
    snapshot: deepFreeze(obj as unknown as EditDecisionListSnapshot),
    failures: [],
  };
}

/**
 * Persists an EDL snapshot through a local storage adapter if available.
 * Honestly exposes PERSISTENCE_UNAVAILABLE rather than pretending durability when unavailable.
 */
export async function persistEdlSnapshotLocally(
  edl: EditDecisionListSnapshot,
  storageAdapter?: EdlStorageAdapter | null,
): Promise<{
  readonly snapshot: EditDecisionListSnapshot;
  readonly persistenceStatus: EdlPersistenceStatus;
  readonly persistenceNote: string;
}> {
  if (!storageAdapter) {
    const note =
      'No durable local storage adapter was supplied; EDL remains in memory only (PERSISTENCE_UNAVAILABLE).';
    const updated = deepFreeze({
      ...edl,
      persistenceStatus: 'PERSISTENCE_UNAVAILABLE' as const,
      persistenceNote: note,
    });
    return {
      snapshot: updated,
      persistenceStatus: 'PERSISTENCE_UNAVAILABLE',
      persistenceNote: note,
    };
  }

  try {
    const json = serializeEdlSnapshot(edl);
    await storageAdapter.saveEdlJson(edl.edlId, json);
    const note = `EDL ${edl.edlId} v${edl.edlVersion} serialized and persisted to local storage.`;
    const updated = deepFreeze({
      ...edl,
      persistenceStatus: 'PERSISTED_LOCAL' as const,
      persistenceNote: note,
    });
    return {
      snapshot: updated,
      persistenceStatus: 'PERSISTED_LOCAL',
      persistenceNote: note,
    };
  } catch (err) {
    const note = `Local EDL persistence failed (${err instanceof Error ? err.message : String(err)}); snapshot is NOT durably saved.`;
    const updated = deepFreeze({
      ...edl,
      persistenceStatus: 'PERSISTENCE_UNAVAILABLE' as const,
      persistenceNote: note,
    });
    return {
      snapshot: updated,
      persistenceStatus: 'PERSISTENCE_UNAVAILABLE',
      persistenceNote: note,
    };
  }
}
