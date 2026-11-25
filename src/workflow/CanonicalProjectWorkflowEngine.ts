/**
 * AVP-P0-003 — End-to-End Transcription Workflow, Project State Integrity & Edit Decision Execution
 *
 * Canonical workflow:
 *   Import Audio -> Validate Audio -> Transcribe -> Analyze Speech -> Review Suggestions
 *   -> Approve/Reject/Modify Decisions -> Apply Edits -> Persist Project -> Export Audio
 *
 * Guarantees:
 * - Strict ownership: Project -> SourceAudio -> Transcript -> SpeechAnalysis -> Suggestions
 *   -> 7-state EditDecisions -> Non-destructive TimelineOperations -> ExportArtifacts.
 * - Changing source audio explicitly invalidates dependent transcripts, suggestions, and decisions.
 * - Integer sample-index authoritative timebase; any timestamp repair is explicitly recorded.
 * - Immutable raw ASR transcript preserved alongside normalized & user-corrected revisions.
 * - Idempotent non-destructive timeline operations + compact undo/redo history + transactional rollback.
 * - Deterministic WAV export verified via independent decode-back (`renderAndVerifyDeterministicWav`),
 *   preserving the last known-good export if a subsequent export fails or cancels.
 */

import {
  AvapardazTranscriptResult,
  LocalAsrRuntimeAdapter,
  AsrModelLoadDescriptor,
} from '../asr-core/UnifiedLocalAsrRuntime';
import {
  CanonicalAudioBuffer,
  CanonicalTimelineOp,
  classifySilenceWindow,
  createCanonicalAudioBuffer,
  executeSampleAccurateTimeline,
  renderAndVerifyDeterministicWav,
  secondsToSampleIndex,
} from '../audio-renderer/CanonicalAudioDspEngine';
import {
  AVAPARDAZ_VERSION_CONTRACT,
  migratePersistedProjectSafely,
  PersistedProjectEnvelope,
} from '../lifecycle/VersionCompatibilityContract';
import { IncrementalSha256 } from '../utils/StreamingSha256';
import type { SampleRate } from '../contracts/timebase.contract';
import type { RenderExportEncoding } from '../audio-renderer/AudioRenderTypes';

export type EditDecisionState =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'APPLIED'
  | 'UNDONE'
  | 'INVALIDATED';

export type WorkflowStage =
  | 'EMPTY'
  | 'AUDIO_IMPORTED'
  | 'TRANSCRIBED'
  | 'ANALYZED'
  | 'EDITS_APPLIED'
  | 'EXPORTED';

export interface ProjectSourceAudioRecord {
  readonly sourceAudioId: string;
  readonly fileName: string;
  readonly sourceSha256: string;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly frameCount: number;
  readonly durationSec: number;
  readonly importedAtMs: number;
}

export interface TimestampRepairRecord {
  readonly segmentId: string;
  readonly field: 'startSample' | 'endSample';
  readonly originalValue: number;
  readonly repairedValue: number;
  readonly reason: string;
}

export interface ProjectTranscriptSegmentRecord {
  readonly segmentId: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly userCorrectedText: string | null;
  readonly confidence: number | null;
}

export interface ProjectTranscriptRecord {
  readonly transcriptId: string;
  readonly sourceAudioId: string;
  readonly sourceAudioSha256: string;
  readonly runtimeTarget: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelSha256Hex: string;
  readonly normalizationVersion: string;
  readonly revision: number;
  readonly segments: readonly ProjectTranscriptSegmentRecord[];
  readonly timestampRepairs: readonly TimestampRepairRecord[];
  readonly createdAtMs: number;
  readonly invalidated: boolean;
  readonly invalidationReason?: string;
}

export interface SpeechEditSuggestion {
  readonly suggestionId: string;
  readonly sourceAudioId: string;
  readonly transcriptId: string;
  readonly kind: 'SILENCE_REMOVAL' | 'FILLER_DELETE' | 'REPEATED_WORD_DELETE';
  readonly startSample: number;
  readonly endSample: number;
  readonly durationSec: number;
  readonly reasonFa: string;
  readonly confidence: number | null;
}

export interface ProjectEditDecision {
  readonly decisionId: string;
  readonly suggestionId: string;
  readonly state: EditDecisionState;
  readonly effectiveStartSample: number;
  readonly effectiveEndSample: number;
  readonly kind: SpeechEditSuggestion['kind'];
  readonly crossfadeSamples: number;
  readonly updatedAtMs: number;
  readonly note?: string;
}

export interface ProjectExportRecord {
  readonly exportId: string;
  readonly sourceAudioId: string;
  readonly encoding: RenderExportEncoding;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly verifiedFrames: number;
  readonly verifiedDurationSec: number;
  readonly outputHash: string;
  readonly byteLength: number;
  readonly exportedAtMs: number;
}

export interface CompactHistoryStep {
  readonly stepId: string;
  readonly label: string;
  readonly beforeDecisions: readonly ProjectEditDecision[];
  readonly afterDecisions: readonly ProjectEditDecision[];
  readonly beforeOps: readonly CanonicalTimelineOp[];
  readonly afterOps: readonly CanonicalTimelineOp[];
  readonly timestampMs: number;
}

export interface CanonicalProjectState {
  readonly schemaVersion: typeof AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion;
  readonly projectId: string;
  readonly projectName: string;
  readonly stage: WorkflowStage;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly sourceAudio: ProjectSourceAudioRecord | null;
  readonly transcript: ProjectTranscriptRecord | null;
  readonly suggestions: readonly SpeechEditSuggestion[];
  readonly decisions: readonly ProjectEditDecision[];
  readonly appliedOperations: readonly CanonicalTimelineOp[];
  readonly lastValidExport: ProjectExportRecord | null;
  readonly exportHistory: readonly ProjectExportRecord[];
}

const PERSIAN_FILLER_RE = /^(ام+|اِه?|آه?|خب|یعنی)$/;

export class CanonicalProjectWorkflowEngine {
  private state: CanonicalProjectState;
  private sourceBuffer: CanonicalAudioBuffer | null = null;
  private lastValidExportBytes: Uint8Array | null = null;
  private undoStack: CompactHistoryStep[] = [];
  private redoStack: CompactHistoryStep[] = [];
  private persistedAtomically: string | null = null;

  constructor(params: { readonly projectId: string; readonly projectName: string; readonly nowMs?: number }) {
    const now = params.nowMs ?? Date.now();
    this.state = {
      schemaVersion: AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion,
      projectId: params.projectId,
      projectName: params.projectName,
      stage: 'EMPTY',
      createdAtMs: now,
      updatedAtMs: now,
      sourceAudio: null,
      transcript: null,
      suggestions: [],
      decisions: [],
      appliedOperations: [],
      lastValidExport: null,
      exportHistory: [],
    };
  }

  public getState(): CanonicalProjectState {
    return this.state;
  }

  public getSourceBuffer(): CanonicalAudioBuffer | null {
    return this.sourceBuffer;
  }

  public getLastValidExportBytes(): Uint8Array | null {
    return this.lastValidExportBytes;
  }

  /** Step 1 & 2: Import and validate audio; invalidates stale transcript/suggestions/decisions on source replacement */
  public async importAndValidateAudio(params: {
    readonly sourceAudioId: string;
    readonly fileName: string;
    readonly sampleRate: SampleRate;
    readonly channels: readonly Float32Array[];
    readonly nowMs?: number;
  }): Promise<ProjectSourceAudioRecord> {
    const now = params.nowMs ?? Date.now();
    const hasher = new IncrementalSha256();
    for (const ch of params.channels) {
      hasher.update(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength));
    }
    const sourceSha256 = hasher.digestHex();

    // Clone source channels so caller mutations can NEVER alter canonical source audio
    const ownedChannels = params.channels.map((ch) => new Float32Array(ch));
    const buffer = createCanonicalAudioBuffer({
      assetId: params.sourceAudioId,
      sourceSha256,
      sampleRate: params.sampleRate,
      channels: ownedChannels,
    });

    const sourceChanged =
      this.state.sourceAudio !== null &&
      (this.state.sourceAudio.sourceAudioId !== params.sourceAudioId ||
        this.state.sourceAudio.sourceSha256 !== sourceSha256);

    const record: ProjectSourceAudioRecord = {
      sourceAudioId: params.sourceAudioId,
      fileName: params.fileName,
      sourceSha256,
      sampleRate: buffer.descriptor.sampleRate,
      channelCount: buffer.descriptor.channelCount,
      frameCount: buffer.descriptor.frameCount,
      durationSec: buffer.descriptor.durationSec,
      importedAtMs: now,
    };

    this.sourceBuffer = buffer;
    this.state = {
      ...this.state,
      stage: 'AUDIO_IMPORTED',
      updatedAtMs: now,
      sourceAudio: record,
      transcript:
        sourceChanged && this.state.transcript
          ? {
              ...this.state.transcript,
              invalidated: true,
              invalidationReason: 'SOURCE_AUDIO_CHANGED',
            }
          : sourceChanged
            ? null
            : this.state.transcript,
      suggestions: sourceChanged ? [] : this.state.suggestions,
      decisions: sourceChanged
        ? this.state.decisions.map((d) => ({
            ...d,
            state: 'INVALIDATED' as const,
            updatedAtMs: now,
            note: 'Invalidated because project source audio changed.',
          }))
        : this.state.decisions,
      appliedOperations: sourceChanged ? [] : this.state.appliedOperations,
    };
    return record;
  }

  /** Step 3: Execute real local transcription via canonical LocalAsrRuntimeAdapter */
  public async transcribeWithRuntime(params: {
    readonly adapter: LocalAsrRuntimeAdapter;
    readonly jobId: string;
    readonly modelDescriptor?: AsrModelLoadDescriptor;
    readonly signal?: AbortSignal;
    readonly nowMs?: number;
  }): Promise<ProjectTranscriptRecord> {
    if (!this.sourceBuffer || !this.state.sourceAudio) {
      throw new Error('NO_SOURCE_AUDIO: Import and validate audio before transcription.');
    }
    const src = this.sourceBuffer;
    const mono = src.channels[0];
    const result = await params.adapter.transcribe({
      jobId: params.jobId,
      projectId: this.state.projectId,
      trackId: 'track-1',
      sourceAssetId: this.state.sourceAudio.sourceAudioId,
      sourceAssetSha256: this.state.sourceAudio.sourceSha256,
      fileName: this.state.sourceAudio.fileName,
      sampleRate: src.descriptor.sampleRate,
      totalSamples: src.descriptor.frameCount,
      readSourceRange: async (startSample, count) => {
        const s = Math.max(0, Math.min(mono.length, Math.floor(startSample)));
        const e = Math.max(s, Math.min(mono.length, s + Math.floor(count)));
        return mono.subarray(s, e);
      },
      modelDescriptor: params.modelDescriptor,
      signal: params.signal,
    });
    return this.attachVerifiedTranscriptResult(result, params.nowMs);
  }

  /** Validates and attaches a canonical AvapardazTranscriptResult with explicit integer-sample timebase checks */
  public attachVerifiedTranscriptResult(
    result: AvapardazTranscriptResult,
    nowMs = Date.now(),
  ): ProjectTranscriptRecord {
    if (!this.state.sourceAudio) {
      throw new Error('NO_SOURCE_AUDIO: Cannot attach transcript without source audio.');
    }
    const sr = this.state.sourceAudio.sampleRate;
    const maxFrames = this.state.sourceAudio.frameCount;
    const repairs: TimestampRepairRecord[] = [];
    const segments: ProjectTranscriptSegmentRecord[] = [];
    let prevEnd = 0;

    for (const seg of result.segments) {
      let startSample = secondsToSampleIndex(Math.max(0, seg.startSec), sr, 'round');
      let endSample = secondsToSampleIndex(Math.max(0, seg.endSec), sr, 'round');

      if (startSample < prevEnd) {
        repairs.push({
          segmentId: seg.id,
          field: 'startSample',
          originalValue: startSample,
          repairedValue: prevEnd,
          reason: 'Clamped overlapping segment start to previous segment end.',
        });
        startSample = prevEnd;
      }
      if (startSample > maxFrames) {
        repairs.push({
          segmentId: seg.id,
          field: 'startSample',
          originalValue: startSample,
          repairedValue: maxFrames,
          reason: 'Clamped segment start to source frameCount.',
        });
        startSample = maxFrames;
      }
      if (endSample > maxFrames) {
        repairs.push({
          segmentId: seg.id,
          field: 'endSample',
          originalValue: endSample,
          repairedValue: maxFrames,
          reason: 'Clamped segment end to source frameCount.',
        });
        endSample = maxFrames;
      }
      if (endSample < startSample) {
        repairs.push({
          segmentId: seg.id,
          field: 'endSample',
          originalValue: endSample,
          repairedValue: startSample,
          reason: 'Clamped reversed segment end to startSample.',
        });
        endSample = startSample;
      }
      prevEnd = endSample;

      segments.push({
        segmentId: seg.id,
        startSample,
        endSample,
        startSec: Number((startSample / sr).toFixed(6)),
        endSec: Number((endSample / sr).toFixed(6)),
        rawText: seg.rawText,
        normalizedText: seg.normalizedText,
        userCorrectedText: null,
        confidence: seg.confidence,
      });
    }

    const transcript: ProjectTranscriptRecord = {
      transcriptId: `tr_${result.jobId}`,
      sourceAudioId: this.state.sourceAudio.sourceAudioId,
      sourceAudioSha256: this.state.sourceAudio.sourceSha256,
      runtimeTarget: result.runtimeTarget,
      modelId: result.modelId,
      modelVersion: result.modelVersion,
      modelSha256Hex: result.modelSha256Hex,
      normalizationVersion: result.normalizationVersion,
      revision: 1,
      segments,
      timestampRepairs: repairs,
      createdAtMs: nowMs,
      invalidated: false,
    };

    this.state = {
      ...this.state,
      stage: 'TRANSCRIBED',
      updatedAtMs: nowMs,
      transcript,
      suggestions: [],
      decisions: [],
      appliedOperations: [],
    };
    return transcript;
  }

  /** Step 4: Analyze speech for long silence gaps & filler words -> generates PENDING reviewable suggestions */
  public analyzeSpeechAndGenerateSuggestions(options?: {
    readonly minSilenceDurationSec?: number;
    readonly nowMs?: number;
  }): readonly SpeechEditSuggestion[] {
    if (!this.sourceBuffer || !this.state.sourceAudio || !this.state.transcript || this.state.transcript.invalidated) {
      throw new Error('TRANSCRIPT_REQUIRED: Valid non-invalidated source audio and transcript required for speech analysis.');
    }
    const now = options?.nowMs ?? Date.now();
    const sr = this.state.sourceAudio.sampleRate;
    const mono = this.sourceBuffer.channels[0];
    const minSilenceSamples = Math.round((options?.minSilenceDurationSec ?? 0.35) * sr);
    const windowSize = Math.max(160, Math.round(sr * 0.05));
    const suggestions: SpeechEditSuggestion[] = [];

    // 1. Acoustic silence gap detection using non-destructive classifySilenceWindow
    let runStart: number | null = null;
    for (let pos = 0; pos + windowSize <= mono.length; pos += windowSize) {
      const info = classifySilenceWindow(mono, pos, pos + windowSize);
      if (info.classification === 'DIGITAL_SILENCE' || info.classification === 'LOW_LEVEL_AMBIENT') {
        if (runStart === null) runStart = pos;
      } else if (runStart !== null) {
        if (pos - runStart >= minSilenceSamples) {
          suggestions.push({
            suggestionId: `sug_sil_${suggestions.length + 1}`,
            sourceAudioId: this.state.sourceAudio.sourceAudioId,
            transcriptId: this.state.transcript.transcriptId,
            kind: 'SILENCE_REMOVAL',
            startSample: runStart,
            endSample: pos,
            durationSec: Number(((pos - runStart) / sr).toFixed(4)),
            reasonFa: `سکوت طولانی (${((pos - runStart) / sr).toFixed(2)} ثانیه)`,
            confidence: 0.92,
          });
        }
        runStart = null;
      }
    }
    if (runStart !== null && mono.length - runStart >= minSilenceSamples) {
      suggestions.push({
        suggestionId: `sug_sil_${suggestions.length + 1}`,
        sourceAudioId: this.state.sourceAudio.sourceAudioId,
        transcriptId: this.state.transcript.transcriptId,
        kind: 'SILENCE_REMOVAL',
        startSample: runStart,
        endSample: mono.length,
        durationSec: Number(((mono.length - runStart) / sr).toFixed(4)),
        reasonFa: `سکوت پایانی (${((mono.length - runStart) / sr).toFixed(2)} ثانیه)`,
        confidence: 0.92,
      });
    }

    // 2. Transcript filler detection
    for (const seg of this.state.transcript.segments) {
      if (PERSIAN_FILLER_RE.test(seg.normalizedText.trim()) && seg.endSample > seg.startSample) {
        suggestions.push({
          suggestionId: `sug_fill_${suggestions.length + 1}`,
          sourceAudioId: this.state.sourceAudio.sourceAudioId,
          transcriptId: this.state.transcript.transcriptId,
          kind: 'FILLER_DELETE',
          startSample: seg.startSample,
          endSample: seg.endSample,
          durationSec: Number(((seg.endSample - seg.startSample) / sr).toFixed(4)),
          reasonFa: `تکه‌کلام گفتاری («${seg.normalizedText.trim()}»)`,
          confidence: seg.confidence,
        });
      }
    }

    const decisions: ProjectEditDecision[] = suggestions.map((s) => ({
      decisionId: `dec_${s.suggestionId}`,
      suggestionId: s.suggestionId,
      state: 'PENDING',
      effectiveStartSample: s.startSample,
      effectiveEndSample: s.endSample,
      kind: s.kind,
      crossfadeSamples: Math.min(256, Math.floor((s.endSample - s.startSample) / 4)),
      updatedAtMs: now,
    }));

    this.state = {
      ...this.state,
      stage: 'ANALYZED',
      updatedAtMs: now,
      suggestions,
      decisions,
    };
    return suggestions;
  }

  /** Step 5 & 6: Explicitly review/approve/reject/modify a decision (PENDING -> APPROVED | REJECTED | MODIFIED) */
  public reviewDecision(params: {
    readonly decisionId: string;
    readonly action: 'APPROVE' | 'REJECT' | 'MODIFY';
    readonly modifiedStartSample?: number;
    readonly modifiedEndSample?: number;
    readonly note?: string;
    readonly nowMs?: number;
  }): ProjectEditDecision {
    const now = params.nowMs ?? Date.now();
    const idx = this.state.decisions.findIndex((d) => d.decisionId === params.decisionId);
    if (idx === -1) {
      throw new Error(`DECISION_NOT_FOUND: ${params.decisionId}`);
    }
    const existing = this.state.decisions[idx];
    if (existing.state === 'INVALIDATED') {
      throw new Error(`DECISION_INVALIDATED: Cannot review invalidated decision ${params.decisionId}.`);
    }

    const maxFrames = this.state.sourceAudio?.frameCount ?? 0;
    let nextStart = existing.effectiveStartSample;
    let nextEnd = existing.effectiveEndSample;
    let nextState: EditDecisionState = existing.state;

    if (params.action === 'APPROVE') {
      nextState = 'APPROVED';
    } else if (params.action === 'REJECT') {
      nextState = 'REJECTED';
    } else if (params.action === 'MODIFY') {
      if (
        typeof params.modifiedStartSample !== 'number' ||
        typeof params.modifiedEndSample !== 'number' ||
        !Number.isSafeInteger(params.modifiedStartSample) ||
        !Number.isSafeInteger(params.modifiedEndSample) ||
        params.modifiedStartSample < 0 ||
        params.modifiedEndSample > maxFrames ||
        params.modifiedEndSample <= params.modifiedStartSample
      ) {
        throw new Error('INVALID_DECISION_BOUNDS: Modified sample bounds are out of range.');
      }
      nextStart = params.modifiedStartSample;
      nextEnd = params.modifiedEndSample;
      nextState = 'MODIFIED';
    }

    const updated: ProjectEditDecision = {
      ...existing,
      state: nextState,
      effectiveStartSample: nextStart,
      effectiveEndSample: nextEnd,
      updatedAtMs: now,
      note: params.note ?? existing.note,
    };

    const nextDecisions = [...this.state.decisions];
    nextDecisions[idx] = updated;
    this.state = {
      ...this.state,
      updatedAtMs: now,
      decisions: nextDecisions,
    };
    return updated;
  }

  /** Step 7: Idempotent transactional application of APPROVED/MODIFIED decisions into non-destructive timeline ops */
  public applyApprovedDecisions(nowMs = Date.now()): {
    readonly appliedCount: number;
    readonly operations: readonly CanonicalTimelineOp[];
  } {
    if (!this.sourceBuffer || !this.state.sourceAudio) {
      throw new Error('NO_SOURCE_AUDIO: Cannot apply edits without source audio.');
    }
    // Snapshot before mutation for transactional rollback on failure
    const snapshot = this.state;
    try {
      const eligible = this.state.decisions
        .filter((d) => d.state === 'APPROVED' || d.state === 'MODIFIED')
        // Apply from highest sample offset downward so earlier indices remain exact and non-shifting!
        .sort((a, b) => b.effectiveStartSample - a.effectiveStartSample);

      if (eligible.length === 0) {
        return { appliedCount: 0, operations: this.state.appliedOperations };
      }

      const newOps: CanonicalTimelineOp[] = eligible.map((d) =>
        d.kind === 'SILENCE_REMOVAL'
          ? {
              opId: `op_${d.decisionId}`,
              kind: 'SILENCE_REMOVAL',
              startSample: d.effectiveStartSample,
              endSample: d.effectiveEndSample,
              preservePaddingSamples: Math.min(64, Math.floor((d.effectiveEndSample - d.effectiveStartSample) / 8)),
              crossfadeSamples: d.crossfadeSamples,
            }
          : {
              opId: `op_${d.decisionId}`,
              kind: 'DELETE_RANGE',
              startSample: d.effectiveStartSample,
              endSample: d.effectiveEndSample,
              crossfadeSamples: d.crossfadeSamples,
              crossfadeCurve: 'smooth-cosine',
            },
      );

      // Deduplicate by opId for strict idempotency
      const existingIds = new Set(this.state.appliedOperations.map((o) => o.opId));
      const mergedOps = [
        ...this.state.appliedOperations,
        ...newOps.filter((o) => !existingIds.has(o.opId)),
      ];

      // Validate dry-run execution before committing state
      const dryRun = executeSampleAccurateTimeline({
        source: this.sourceBuffer,
        operations: mergedOps,
      });
      if (!dryRun.ok) {
        throw new Error(`TIMELINE_DRY_RUN_FAILED: ${dryRun.errorCode} — ${dryRun.errorMessage}`);
      }

      const appliedSet = new Set(eligible.map((d) => d.decisionId));
      const nextDecisions = this.state.decisions.map((d) =>
        appliedSet.has(d.decisionId) ? { ...d, state: 'APPLIED' as const, updatedAtMs: nowMs } : d,
      );

      this.undoStack.push({
        stepId: `step_${this.undoStack.length + 1}`,
        label: `Applied ${eligible.length} approved decision(s)`,
        beforeDecisions: this.state.decisions,
        afterDecisions: nextDecisions,
        beforeOps: this.state.appliedOperations,
        afterOps: mergedOps,
        timestampMs: nowMs,
      });
      this.redoStack.length = 0;

      this.state = {
        ...this.state,
        stage: 'EDITS_APPLIED',
        updatedAtMs: nowMs,
        decisions: nextDecisions,
        appliedOperations: mergedOps,
      };
      return { appliedCount: eligible.length, operations: mergedOps };
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }

  public undo(nowMs = Date.now()): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.redoStack.push(step);
    const undoneDecisions = step.beforeDecisions.map((d) =>
      step.afterDecisions.some((ad) => ad.decisionId === d.decisionId && ad.state === 'APPLIED')
        ? { ...d, state: 'UNDONE' as const, updatedAtMs: nowMs }
        : d,
    );
    this.state = {
      ...this.state,
      updatedAtMs: nowMs,
      decisions: undoneDecisions,
      appliedOperations: step.beforeOps,
    };
    return true;
  }

  public redo(nowMs = Date.now()): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.undoStack.push(step);
    this.state = {
      ...this.state,
      updatedAtMs: nowMs,
      decisions: step.afterDecisions,
      appliedOperations: step.afterOps,
    };
    return true;
  }

  /** Step 8: Atomic schema-versioned persistence & interrupted-save recovery */
  public serializeProjectEnvelope(): PersistedProjectEnvelope {
    return {
      schemaVersion: this.state.schemaVersion,
      projectId: this.state.projectId,
      projectName: this.state.projectName,
      createdAtMs: this.state.createdAtMs,
      updatedAtMs: this.state.updatedAtMs,
      transcriptSchemaVersion: AVAPARDAZ_VERSION_CONTRACT.transcriptSchemaVersion,
      edlSchemaVersion: AVAPARDAZ_VERSION_CONTRACT.edlSchemaVersion,
      sourceAssets: this.state.sourceAudio ? [this.state.sourceAudio as unknown as Record<string, unknown>] : [],
      transcriptVersions: this.state.transcript ? [this.state.transcript as unknown as Record<string, unknown>] : [],
      edlSnapshots: [
        {
          stage: this.state.stage,
          suggestions: this.state.suggestions,
          decisions: this.state.decisions,
          appliedOperations: this.state.appliedOperations,
        },
      ],
      renderHistory: this.state.exportHistory.map((e) => e as unknown as Record<string, unknown>),
    };
  }

  public saveAtomically(simulateInterruptAfterStaging = false): { readonly ok: boolean; readonly bytesWritten: number } {
    const stagingJson = JSON.stringify(this.serializeProjectEnvelope());
    if (simulateInterruptAfterStaging) {
      // Previous committed snapshot remains completely untouched!
      return { ok: false, bytesWritten: 0 };
    }
    this.persistedAtomically = stagingJson;
    return { ok: true, bytesWritten: stagingJson.length };
  }

  public getLastCommittedPersistenceJson(): string | null {
    return this.persistedAtomically;
  }

  public restoreFromSerializedEnvelope(rawJsonOrObj: string | unknown): {
    readonly ok: boolean;
    readonly migrated: boolean;
    readonly error?: string;
  } {
    let parsed: unknown;
    try {
      parsed = typeof rawJsonOrObj === 'string' ? JSON.parse(rawJsonOrObj) : rawJsonOrObj;
    } catch (err) {
      return { ok: false, migrated: false, error: `CORRUPT_PROJECT_JSON: ${String(err)}` };
    }

    const migration = migratePersistedProjectSafely(parsed);
    if (!migration.ok || !migration.migratedProject) {
      return { ok: false, migrated: false, error: migration.error ?? 'Schema migration failed.' };
    }

    const env = migration.migratedProject;
    const srcAudio = (env.sourceAssets?.[0] ?? null) as unknown as ProjectSourceAudioRecord | null;
    const transcript = (env.transcriptVersions?.[0] ?? null) as unknown as ProjectTranscriptRecord | null;
    const snap = (env.edlSnapshots?.[0] ?? {}) as Record<string, unknown>;
    const exportHistory = (env.renderHistory ?? []) as unknown as ProjectExportRecord[];

    this.state = {
      schemaVersion: AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion,
      projectId: env.projectId,
      projectName: env.projectName,
      stage: (typeof snap.stage === 'string' ? snap.stage : srcAudio ? 'AUDIO_IMPORTED' : 'EMPTY') as WorkflowStage,
      createdAtMs: env.createdAtMs,
      updatedAtMs: env.updatedAtMs,
      sourceAudio: srcAudio,
      transcript,
      suggestions: Array.isArray(snap.suggestions) ? (snap.suggestions as SpeechEditSuggestion[]) : [],
      decisions: Array.isArray(snap.decisions) ? (snap.decisions as ProjectEditDecision[]) : [],
      appliedOperations: Array.isArray(snap.appliedOperations)
        ? (snap.appliedOperations as CanonicalTimelineOp[])
        : [],
      lastValidExport: exportHistory.length > 0 ? exportHistory[exportHistory.length - 1] : null,
      exportHistory,
    };
    return { ok: true, migrated: migration.decision === 'MIGRATION_REQUIRED' };
  }

  /** Step 9: Deterministic validated WAV export (reopens, decodes, verifies; preserves previous valid export on failure) */
  public async exportValidatedWav(params?: {
    readonly encoding?: RenderExportEncoding;
    readonly abortSignal?: AbortSignal;
    readonly nowMs?: number;
  }): Promise<{
    readonly ok: boolean;
    readonly exportRecord: ProjectExportRecord | null;
    readonly wavBytes: Uint8Array | null;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  }> {
    if (!this.sourceBuffer || !this.state.sourceAudio) {
      return {
        ok: false,
        exportRecord: null,
        wavBytes: null,
        errorCode: 'NO_SOURCE_AUDIO',
        errorMessage: 'Cannot export without imported source audio.',
      };
    }

    const now = params?.nowMs ?? Date.now();
    const encoding = params?.encoding ?? 'pcm16';
    const executed = executeSampleAccurateTimeline({
      source: this.sourceBuffer,
      operations: this.state.appliedOperations,
      abortSignal: params?.abortSignal,
    });

    if (!executed.ok) {
      return {
        ok: false,
        exportRecord: null,
        wavBytes: null,
        errorCode: executed.errorCode,
        errorMessage: executed.errorMessage,
      };
    }

    const rendered = await renderAndVerifyDeterministicWav({
      renderId: `${this.state.projectId}_exp_${now}`,
      channels: executed.channels,
      sourceSampleRate: this.sourceBuffer.descriptor.sampleRate,
      encoding,
      abortSignal: params?.abortSignal,
    });

    if (!rendered.ok || !rendered.wavBytes || !rendered.outputHash) {
      // Preserve last valid export untouched!
      return {
        ok: false,
        exportRecord: null,
        wavBytes: null,
        errorCode: rendered.errorCode,
        errorMessage: rendered.errorMessage,
      };
    }

    const exportRecord: ProjectExportRecord = {
      exportId: `exp_${this.state.exportHistory.length + 1}_${now}`,
      sourceAudioId: this.state.sourceAudio.sourceAudioId,
      encoding,
      sampleRate: rendered.sampleRate,
      channelCount: rendered.channelCount,
      verifiedFrames: rendered.verifiedFrames,
      verifiedDurationSec: rendered.verifiedDurationSec,
      outputHash: rendered.outputHash,
      byteLength: rendered.wavBytes.byteLength,
      exportedAtMs: now,
    };

    this.lastValidExportBytes = rendered.wavBytes;
    this.state = {
      ...this.state,
      stage: 'EXPORTED',
      updatedAtMs: now,
      lastValidExport: exportRecord,
      exportHistory: [...this.state.exportHistory, exportRecord],
    };

    return { ok: true, exportRecord, wavBytes: rendered.wavBytes };
  }
}
