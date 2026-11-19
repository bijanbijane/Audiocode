import { deterministicHexHash } from '../ai-engine/edit-decision/EditProvenance';
import {
  AUDIO_RENDERER_VERSION,
  ImmutableRenderPlan,
  RenderCheckpoint,
  RenderLifecycleState,
  RenderValidationFailure,
} from './AudioRenderTypes';

export interface RenderCheckpointStore {
  saveCheckpoint(checkpoint: RenderCheckpoint): Promise<void> | void;
  loadCheckpoint(checkpointId: string): Promise<RenderCheckpoint | null> | RenderCheckpoint | null;
  deleteCheckpoint(checkpointId: string): Promise<void> | void;
  listCheckpoints(): Promise<RenderCheckpoint[]> | RenderCheckpoint[];
}

export class InMemoryRenderCheckpointStore implements RenderCheckpointStore {
  private readonly store = new Map<string, RenderCheckpoint>();

  public saveCheckpoint(checkpoint: RenderCheckpoint): void {
    this.store.set(checkpoint.checkpointId, { ...checkpoint });
  }

  public loadCheckpoint(checkpointId: string): RenderCheckpoint | null {
    const found = this.store.get(checkpointId);
    return found ? { ...found } : null;
  }

  public deleteCheckpoint(checkpointId: string): void {
    this.store.delete(checkpointId);
  }

  public listCheckpoints(): RenderCheckpoint[] {
    return Array.from(this.store.values()).map((c) => ({ ...c }));
  }
}

export function computeCheckpointIntegrityHash(
  cp: Omit<RenderCheckpoint, 'integrityHash'>,
): string {
  const payload = [
    cp.checkpointId,
    cp.renderId,
    cp.planId,
    cp.planHash,
    cp.rendererVersion,
    cp.projectId,
    cp.sourceAudioId,
    cp.sourceAudioHash,
    cp.edlId,
    String(cp.edlVersion),
    cp.transcriptVersion,
    cp.encoding,
    cp.container,
    String(cp.outputSampleRate),
    String(cp.channelCount),
    String(cp.completedSegmentIndex),
    String(cp.nextSegmentSampleOffset),
    String(cp.writtenOutputSamples),
    String(cp.writtenDataBytes),
    cp.partialOutputHashState,
    cp.stateAtCheckpoint,
  ].join('|');
  return `cp_${deterministicHexHash(payload)}`;
}

/**
 * Render Recovery & Checkpoint Manager (AVP-P06-001 & AVP-P08-001)
 *
 * Creates integrity-hashed render checkpoints and strictly validates compatibility
 * before allowing resume. Rejects corrupted, tampered, stale, or mismatched checkpoints.
 */
export class AudioRenderRecovery {
  public static createCheckpoint(params: {
    readonly renderId: string;
    readonly plan: ImmutableRenderPlan;
    readonly completedSegmentIndex: number;
    readonly nextSegmentSampleOffset: number;
    readonly writtenOutputSamples: number;
    readonly writtenDataBytes: number;
    readonly partialOutputHashState: string;
    readonly stateAtCheckpoint: RenderLifecycleState;
    readonly nowMs?: number;
  }): RenderCheckpoint {
    const base: Omit<RenderCheckpoint, 'integrityHash'> = {
      checkpointId: `chk_${deterministicHexHash(`${params.renderId}:${params.plan.planHash}:${params.writtenOutputSamples}`)}`,
      renderId: params.renderId,
      planId: params.plan.planId,
      planHash: params.plan.planHash,
      rendererVersion: AUDIO_RENDERER_VERSION,
      projectId: params.plan.projectId,
      sourceAudioId: params.plan.sourceAudioId,
      sourceAudioHash: params.plan.sourceAudioHash,
      edlId: params.plan.edlId,
      edlVersion: params.plan.edlVersion,
      transcriptVersion: params.plan.transcriptVersion,
      encoding: params.plan.encoding,
      container: params.plan.container,
      outputSampleRate: params.plan.outputSampleRate,
      channelCount: params.plan.channelCount,
      completedSegmentIndex: params.completedSegmentIndex,
      nextSegmentSampleOffset: params.nextSegmentSampleOffset,
      writtenOutputSamples: params.writtenOutputSamples,
      writtenDataBytes: params.writtenDataBytes,
      partialOutputHashState: params.partialOutputHashState,
      stateAtCheckpoint: params.stateAtCheckpoint,
      savedAtMs: params.nowMs ?? Date.now(),
    };
    return Object.freeze({
      ...base,
      integrityHash: computeCheckpointIntegrityHash(base),
    });
  }

  public static validateCheckpointCompatibility(
    checkpoint: RenderCheckpoint,
    plan: ImmutableRenderPlan,
  ): { readonly compatible: boolean; readonly failures: readonly RenderValidationFailure[] } {
    const failures: RenderValidationFailure[] = [];

    if (!checkpoint || typeof checkpoint !== 'object') {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: 'Checkpoint object is null or malformed.',
        actionableFix: 'Discard checkpoint and start a fresh render.',
      });
      return { compatible: false, failures };
    }

    const { integrityHash, ...rest } = checkpoint;
    const expectedIntegrity = computeCheckpointIntegrityHash(rest);
    if (integrityHash !== expectedIntegrity) {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: `Checkpoint integrity hash mismatch (expected ${expectedIntegrity}, got ${integrityHash}); checkpoint may be corrupted.`,
        actionableFix: 'Discard corrupted checkpoint and restart render from segment 0.',
      });
    }

    if (checkpoint.rendererVersion !== AUDIO_RENDERER_VERSION) {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: `Checkpoint rendererVersion (${checkpoint.rendererVersion}) != active (${AUDIO_RENDERER_VERSION}).`,
        actionableFix: 'Start a fresh render with the active renderer version.',
      });
    }

    if (checkpoint.sourceAudioHash !== plan.sourceAudioHash) {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: `Checkpoint sourceAudioHash (${checkpoint.sourceAudioHash}) != active source (${plan.sourceAudioHash}).`,
        actionableFix: 'Source audio changed; cannot resume old render checkpoint.',
      });
    }

    if (checkpoint.edlVersion !== plan.edlVersion || checkpoint.edlId !== plan.edlId) {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: `Checkpoint EDL (${checkpoint.edlId} v${checkpoint.edlVersion}) != active (${plan.edlId} v${plan.edlVersion}).`,
        actionableFix: 'EDL changed since checkpoint; restart render.',
      });
    }

    if (checkpoint.planHash !== plan.planHash) {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: `Checkpoint planHash (${checkpoint.planHash}) != active planHash (${plan.planHash}).`,
        actionableFix: 'Render configuration or approved edits changed; restart render.',
      });
    }

    if (
      checkpoint.encoding !== plan.encoding ||
      checkpoint.container !== plan.container ||
      checkpoint.outputSampleRate !== plan.outputSampleRate ||
      checkpoint.channelCount !== plan.channelCount
    ) {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: 'Checkpoint output format/sampleRate/channelCount differs from current render plan.',
        actionableFix: 'Match export settings or start a fresh render.',
      });
    }

    if (
      !Number.isInteger(checkpoint.completedSegmentIndex) ||
      checkpoint.completedSegmentIndex < 0 ||
      checkpoint.completedSegmentIndex > plan.retainedSegments.length ||
      !Number.isInteger(checkpoint.nextSegmentSampleOffset) ||
      checkpoint.nextSegmentSampleOffset < 0 ||
      !Number.isInteger(checkpoint.writtenOutputSamples) ||
      checkpoint.writtenOutputSamples < 0 ||
      checkpoint.writtenOutputSamples > plan.expectedOutputSamples
    ) {
      failures.push({
        code: 'CHECKPOINT_INCOMPATIBLE',
        severity: 'ERROR',
        message: 'Checkpoint sample/segment offsets are out of range for the active render plan.',
        actionableFix: 'Discard invalid checkpoint and restart render.',
      });
    }

    return {
      compatible: failures.length === 0,
      failures,
    };
  }
}
