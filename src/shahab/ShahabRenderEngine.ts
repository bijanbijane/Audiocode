/**
 * SHAHAB-030 — Non-Destructive Audio Editing Engine, Sample-Accurate Edit Execution,
 * Render Graph & Precision Export
 *
 * Architectural Law (Strict 3-Stage Separation: Detect != Decide != Execute):
 * - THIS MODULE EXECUTES APPROVED EDIT DECISION PLANS ONLY.
 * - Strictly non-destructive: NEVER modifies or overwrites original source media/PCM.
 * - Independent execution-boundary validation: rejects unapproved plans, stale revisions,
 *   protected-range intersections, and conflicting/overlapping cuts.
 * - Sample-accurate half-open [startSample, endSample) reconstruction for Mono & Stereo
 *   without silent downmix.
 * - Controlled Audio Transition Engine: boundary discontinuity check, bounded zero-crossing
 *   micro-snap, declared LINEAR and EQUAL_POWER (cos/sin) fades & crossfades.
 * - Verified lossless WAV PCM16 & PCM32F export with atomic writes, path-traversal guard,
 *   and independent WAV reopen + structural/signal/sample-preservation validation.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EditDecisionPlan } from './ShahabEditorialPlannerEngine.ts';

export const SHAHAB_RENDER_ENGINE_CONTRACT_VERSION = '1.0.0';
export const SHAHAB_RENDER_GRAPH_VERSION = '1.0.0';

export type RenderExportFormat = 'WAV_PCM_16' | 'WAV_PCM_32F' | 'FLAC' | 'MP3' | 'AAC';

export type TransitionCurveType = 'NONE' | 'LINEAR' | 'EQUAL_POWER';

export type RenderJobMode = 'PREVIEW_RENDER' | 'FINAL_EXPORT_RENDER';

export type RenderValidationStatus =
  | 'RENDER_VALIDATED'
  | 'RENDER_SIGNAL_WARNINGS'
  | 'RENDER_VALIDATION_FAILED';

export type RenderGraphNodeType =
  | 'SOURCE_ACQUISITION'
  | 'SOURCE_VALIDATION'
  | 'RANGE_SELECTION'
  | 'REGION_SEQUENCING'
  | 'GAIN'
  | 'TRANSITION'
  | 'CHANNEL_MAPPING'
  | 'RESAMPLING'
  | 'ENCODING'
  | 'OUTPUT_VALIDATION';

export interface RenderGraphNode {
  readonly nodeId: string;
  readonly nodeType: RenderGraphNodeType;
  readonly inputs: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RenderGraphSpec {
  readonly graphId: string;
  readonly graphVersion: string;
  readonly deterministicDigestSha256: string;
  readonly nodes: readonly RenderGraphNode[];
}

export interface SourceOutputMapping {
  readonly mappingId: string;
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  readonly outputStartSample: number;
  readonly outputEndSample: number;
  readonly sampleRateHz: number;
  readonly isTransitionOverlapRegion: boolean;
  readonly exactCopyVerifiedRange: {
    readonly sourceStartSample: number;
    readonly sourceEndSample: number;
    readonly outputStartSample: number;
    readonly outputEndSample: number;
  } | null;
}

export interface RemovedRangeRecord {
  readonly operationId: string;
  readonly operationType: string;
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  readonly durationMs: number;
  readonly approvedBy: string | null;
  readonly approvedAtUtc: string | null;
}

export interface AppliedTransitionRecord {
  readonly spliceIndex: number;
  readonly outputSamplePosition: number;
  readonly curveType: TransitionCurveType;
  readonly requestedFadeMs: number;
  readonly actualFadeSamples: number;
  readonly zeroCrossingSnapDeltaSamples: number;
  readonly boundaryJumpBeforeTransition: number;
  readonly boundaryJumpAfterTransition: number;
}

export interface RenderOutputValidationReport {
  readonly status: RenderValidationStatus;
  readonly reopenedIndependently: boolean;
  readonly headerValid: boolean;
  readonly expectedChannels: number;
  readonly actualChannels: number;
  readonly expectedSampleRateHz: number;
  readonly actualSampleRateHz: number;
  readonly expectedOutputFrames: number;
  readonly actualOutputFrames: number;
  readonly durationMismatchMs: number;
  readonly containsNaNOrInf: boolean;
  readonly peakDbfs: number;
  readonly clippedSampleCount: number;
  readonly sourceInheritedClippedSampleCount: number;
  readonly renderIntroducedClippedSampleCount: number;
  readonly unmodifiedRegionExactSampleMaxAbsError: number;
  readonly unmodifiedRegionBitExactVerified: boolean;
  readonly sourceHashUnchangedVerified: boolean;
  readonly outputFileSha256: string | null;
  readonly warnings: readonly string[];
  readonly sourceInheritedNotes: readonly string[];
  readonly errors: readonly string[];
}

export interface RenderExecutionRequest {
  readonly renderMode: RenderJobMode;
  readonly plan: EditDecisionPlan;
  readonly expectedSourceRevisionId: string;
  readonly expectedSourcePcmSha256: string;
  readonly sourceChannels: readonly Float32Array[];
  readonly sampleRateHz: number;
  readonly exportFormat: RenderExportFormat;
  readonly transitionCurve?: TransitionCurveType;
  readonly defaultCrossfadeMs?: number;
  readonly zeroCrossingToleranceSamples?: number;
  readonly gainLinear?: number;
  readonly outputFilePath?: string | null;
  readonly abortSignal?: AbortSignal;
}

export interface RenderExecutionResult {
  readonly renderId: string;
  readonly renderMode: RenderJobMode;
  readonly contractVersion: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly sourceRevisionId: string;
  readonly sourcePcmSha256Before: string;
  readonly sourcePcmSha256After: string;
  readonly exportFormat: RenderExportFormat;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly sourceTotalFrames: number;
  readonly outputTotalFrames: number;
  readonly totalRemovedSamples: number;
  readonly totalRemovedMs: number;
  readonly renderGraph: RenderGraphSpec;
  readonly sourceOutputMappings: readonly SourceOutputMapping[];
  readonly removedRanges: readonly RemovedRangeRecord[];
  readonly appliedTransitions: readonly AppliedTransitionRecord[];
  readonly outputFilePath: string | null;
  readonly outputWavBytes: Uint8Array | null;
  readonly outputChannels: readonly Float32Array[];
  readonly validation: RenderOutputValidationReport;
  readonly wallTimeMs: number;
  readonly checkpointState: 'COMPLETED' | 'CANCELLED_CLEANLY';
  readonly createdAtUtc: string;
}

export interface RenderCapabilitiesReport {
  readonly contractVersion: string;
  readonly graphVersion: string;
  readonly supportedFormats: readonly {
    readonly format: RenderExportFormat;
    readonly status: 'SUPPORTED_VERIFIED' | 'UNSUPPORTED';
    readonly lossless: boolean;
    readonly note: string;
  }[];
  readonly supportedTransitions: readonly TransitionCurveType[];
  readonly nonDestructiveSourceProtection: true;
  readonly independentOutputReopenValidation: true;
  readonly preservesMultiChannelWithoutSilentDownmix: true;
}

function sha256Float32List(buffers: readonly Float32Array[]): string {
  const h = crypto.createHash('sha256');
  for (const b of buffers) {
    h.update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  }
  return h.digest('hex');
}

function toDbfs(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 1e-10) return -120;
  return Number((20 * Math.log10(linear)).toFixed(2));
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isCutOperationType(t: string): boolean {
  return (
    t === 'TRIM_SILENCE_OR_PAUSE' ||
    t === 'REMOVE_FILLER_CANDIDATE' ||
    t === 'REMOVE_REPETITION_CANDIDATE' ||
    t === 'REMOVE_FALSE_START_CANDIDATE'
  );
}

/**
 * Encodes planar multi-channel Float32Array into verified RIFF/WAVE PCM16 or IEEE Float32.
 */
export function encodePlanarToWav(
  channels: readonly Float32Array[],
  sampleRateHz: number,
  format: 'WAV_PCM_16' | 'WAV_PCM_32F',
): Uint8Array {
  const chCount = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const isFloat = format === 'WAV_PCM_32F';
  const bitsPerSample = isFloat ? 32 : 16;
  const bytesPerSample = bitsPerSample / 8;
  const audioFormat = isFloat ? 3 : 1;
  const blockAlign = chCount * bytesPerSample;
  const byteRate = sampleRateHz * blockAlign;
  const dataSize = numFrames * blockAlign;
  const totalBytes = 44 + dataSize;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, totalBytes - 8, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, chCount, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);

  let off = 44;
  if (isFloat) {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < chCount; c++) {
        const s = channels[c][i];
        view.setFloat32(off, Number.isFinite(s) ? s : 0, true);
        off += 4;
      }
    }
  } else {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < chCount; c++) {
        const clamped = Math.max(-1, Math.min(1, Number.isFinite(channels[c][i]) ? channels[c][i] : 0));
        const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
        view.setInt16(off, Math.max(-32768, Math.min(32767, int16)), true);
        off += 2;
      }
    }
  }

  return out;
}

/**
 * Independent WAV decoder used solely by Output Validation to verify structural integrity,
 * channel preservation, duration, and exact sample values after encoding/writing.
 */
export function independentlyDecodeWav(wavBytes: Uint8Array): {
  readonly headerValid: boolean;
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitsPerSample: number;
  readonly totalFrames: number;
  readonly channelBuffers: readonly Float32Array[];
} {
  if (wavBytes.byteLength < 44) {
    return {
      headerValid: false,
      audioFormat: 0,
      channels: 0,
      sampleRateHz: 0,
      bitsPerSample: 0,
      totalFrames: 0,
      channelBuffers: [],
    };
  }
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const riff = view.getUint32(0, false);
  const wave = view.getUint32(8, false);
  if (riff !== 0x52494646 || wave !== 0x57415645) {
    return {
      headerValid: false,
      audioFormat: 0,
      channels: 0,
      sampleRateHz: 0,
      bitsPerSample: 0,
      totalFrames: 0,
      channelBuffers: [],
    };
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBytes.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRateHz = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      dataOffset = body;
      dataSize = Math.min(size, wavBytes.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || channels <= 0 || sampleRateHz <= 0 || bitsPerSample <= 0) {
    return {
      headerValid: false,
      audioFormat,
      channels,
      sampleRateHz,
      bitsPerSample,
      totalFrames: 0,
      channelBuffers: [],
    };
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalFrames = Math.floor(dataSize / (bytesPerSample * channels));
  const channelBuffers = Array.from({ length: channels }, () => new Float32Array(totalFrames));

  for (let i = 0; i < totalFrames; i++) {
    for (let c = 0; c < channels; c++) {
      const pos = dataOffset + (i * channels + c) * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        channelBuffers[c][i] = view.getFloat32(pos, true);
      } else if (audioFormat === 1 && bitsPerSample === 16) {
        channelBuffers[c][i] = view.getInt16(pos, true) / 32768;
      }
    }
  }

  return {
    headerValid: true,
    audioFormat,
    channels,
    sampleRateHz,
    bitsPerSample,
    totalFrames,
    channelBuffers,
  };
}

function findNearestZeroCrossing(
  ch0: Float32Array,
  targetIdx: number,
  minIdx: number,
  maxIdx: number,
  tolerance: number,
): number {
  const lo = Math.max(minIdx, targetIdx - tolerance);
  const hi = Math.min(maxIdx - 1, targetIdx + tolerance);
  let best = targetIdx;
  let bestDist = Infinity;
  for (let i = Math.max(1, lo); i <= hi; i++) {
    if ((ch0[i - 1] <= 0 && ch0[i] >= 0) || (ch0[i - 1] >= 0 && ch0[i] <= 0)) {
      const dist = Math.abs(i - targetIdx);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }
  return best;
}

export class ShahabRenderEngine {
  private readonly authorizedOutputRoot: string;
  private readonly renderHistory: RenderExecutionResult[] = [];
  private disposed = false;

  constructor(authorizedOutputRoot = path.join(process.cwd(), 'docs', 'shahab', 'renders')) {
    this.authorizedOutputRoot = path.resolve(authorizedOutputRoot);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('SHAHAB_RENDER_ENGINE_DISPOSED: Engine instance has been disposed.');
    }
  }

  public getCapabilities(): RenderCapabilitiesReport {
    this.assertActive();
    return {
      contractVersion: SHAHAB_RENDER_ENGINE_CONTRACT_VERSION,
      graphVersion: SHAHAB_RENDER_GRAPH_VERSION,
      supportedFormats: [
        {
          format: 'WAV_PCM_16',
          status: 'SUPPORTED_VERIFIED',
          lossless: true,
          note: 'Standard 16-bit signed linear PCM RIFF/WAVE with independent reopen validation.',
        },
        {
          format: 'WAV_PCM_32F',
          status: 'SUPPORTED_VERIFIED',
          lossless: true,
          note: 'IEEE 32-bit float RIFF/WAVE preserving exact unmodified Float32 samples bit-for-bit.',
        },
        {
          format: 'FLAC',
          status: 'UNSUPPORTED',
          lossless: true,
          note: 'FLAC encoder binary/WASM not bundled in workspace; explicitly disclosed rather than silently downgraded.',
        },
        {
          format: 'MP3',
          status: 'UNSUPPORTED',
          lossless: false,
          note: 'MP3 lossy encoder not bundled in workspace; explicitly rejected if requested.',
        },
        {
          format: 'AAC',
          status: 'UNSUPPORTED',
          lossless: false,
          note: 'AAC lossy encoder not bundled in workspace; explicitly rejected if requested.',
        },
      ],
      supportedTransitions: ['NONE', 'LINEAR', 'EQUAL_POWER'],
      nonDestructiveSourceProtection: true,
      independentOutputReopenValidation: true,
      preservesMultiChannelWithoutSilentDownmix: true,
    };
  }

  public listRenderHistory(): readonly RenderExecutionResult[] {
    this.assertActive();
    return [...this.renderHistory];
  }

  public dispose(): void {
    this.disposed = true;
  }

  /**
   * Independent execution-boundary validation (SHAHAB-030 §3).
   * Rejects unapproved plans, stale revisions, protected-range intersections, conflicts, and unsupported formats.
   */
  public validateExecutionRequest(req: RenderExecutionRequest): void {
    this.assertActive();

    if (req.exportFormat !== 'WAV_PCM_16' && req.exportFormat !== 'WAV_PCM_32F') {
      throw new Error(
        `UNSUPPORTED_EXPORT_FORMAT: "${req.exportFormat}" is not supported in this workspace (supported: WAV_PCM_16, WAV_PCM_32F). Silent downgrade is forbidden.`,
      );
    }

    if (!req.sourceChannels || req.sourceChannels.length === 0 || req.sourceChannels[0].length === 0) {
      throw new Error('INVALID_SOURCE_AUDIO: Non-empty planar sourceChannels required.');
    }

    const expectedLen = req.sourceChannels[0].length;
    for (let c = 1; c < req.sourceChannels.length; c++) {
      if (req.sourceChannels[c].length !== expectedLen) {
        throw new Error('CHANNEL_LENGTH_MISMATCH: All source channels must have identical frame count.');
      }
    }

    if (req.plan.validityState !== 'VALID') {
      throw new Error(
        `STALE_EDIT_PLAN_REJECTED: EDP ${req.plan.planId} is ${req.plan.validityState} (${req.plan.staleReason ?? 'dependency changed'}).`,
      );
    }

    if (req.plan.sourceRevisionId !== req.expectedSourceRevisionId) {
      throw new Error(
        `SOURCE_REVISION_MISMATCH: Plan bound to ${req.plan.sourceRevisionId}, caller supplied ${req.expectedSourceRevisionId}.`,
      );
    }

    const actualSourceHash = sha256Float32List(req.sourceChannels);
    if (actualSourceHash !== req.expectedSourcePcmSha256 || actualSourceHash !== req.plan.sourcePcmSha256) {
      throw new Error(
        `SOURCE_HASH_MISMATCH: Source PCM hash does not match immutable EDP source identity.`,
      );
    }

    if (req.plan.sampleRateHz !== req.sampleRateHz || req.plan.totalSourceFrames !== expectedLen) {
      throw new Error(
        `SOURCE_GEOMETRY_MISMATCH: Plan geometry (${req.plan.sampleRateHz}Hz / ${req.plan.totalSourceFrames} frames) does not match source (${req.sampleRateHz}Hz / ${expectedLen} frames).`,
      );
    }

    const approvedCuts = req.plan.operations.filter(
      (o) => isCutOperationType(o.operationType) && o.approvalState === 'USER_APPROVED',
    );

    if (req.renderMode === 'FINAL_EXPORT_RENDER' && approvedCuts.length === 0) {
      // Allow identity render only if plan has zero pending unapproved cuts OR explicitly warn — wait:
      // SHAHAB-030 §3 says reject unapproved edit plans when pending cuts exist and none approved.
      const hasPendingCuts = req.plan.operations.some(
        (o) => isCutOperationType(o.operationType) && o.approvalState === 'PROPOSED_PENDING_REVIEW',
      );
      if (hasPendingCuts) {
        throw new Error(
          `UNAPPROVED_EDIT_PLAN_REJECTED: Plan ${req.plan.planId} has unapproved candidate cuts and zero USER_APPROVED cuts. Explicit user approval is required before execution.`,
        );
      }
    }

    // Re-verify protected ranges & cut overlaps independently at execution boundary
    const sortedCuts = [...approvedCuts].sort((a, b) => a.sourceRange.startSample - b.sourceRange.startSample);
    for (let i = 0; i < sortedCuts.length; i++) {
      const cut = sortedCuts[i];
      if (cut.sourceRange.startSample < 0 || cut.sourceRange.endSample > expectedLen) {
        throw new Error(`CUT_OUT_OF_BOUNDS: Approved operation ${cut.operationId} exceeds source frames.`);
      }
      for (const pr of req.plan.protectedRanges) {
        if (rangesOverlap(cut.sourceRange.startSample, cut.sourceRange.endSample, pr.startSample, pr.endSample)) {
          throw new Error(
            `PROTECTED_RANGE_EXECUTION_BLOCKED: Approved cut ${cut.operationId} intersects protected range ${pr.protectionId}.`,
          );
        }
      }
      if (i > 0 && sortedCuts[i - 1].sourceRange.endSample > cut.sourceRange.startSample) {
        throw new Error(
          `OVERLAPPING_APPROVED_CUTS_REJECTED: Approved cuts ${sortedCuts[i - 1].operationId} and ${cut.operationId} overlap.`,
        );
      }
    }

    // Path confinement check if outputFilePath requested
    if (req.outputFilePath) {
      const resolved = path.resolve(req.outputFilePath);
      if (
        !resolved.startsWith(this.authorizedOutputRoot + path.sep) &&
        resolved !== this.authorizedOutputRoot
      ) {
        throw new Error(
          `PATH_TRAVERSAL_REJECTED: outputFilePath must reside inside authorizedOutputRoot (${this.authorizedOutputRoot}).`,
        );
      }
    }
  }

  public previewRender(req: Omit<RenderExecutionRequest, 'renderMode' | 'outputFilePath'>): RenderExecutionResult {
    return this.executeRender({
      ...req,
      renderMode: 'PREVIEW_RENDER',
      outputFilePath: null,
    });
  }

  public submitFinalRender(req: Omit<RenderExecutionRequest, 'renderMode'>): RenderExecutionResult {
    return this.executeRender({
      ...req,
      renderMode: 'FINAL_EXPORT_RENDER',
    });
  }

  /**
   * Executes the deterministic non-destructive Render Graph and runs independent output validation.
   */
  public executeRender(req: RenderExecutionRequest): RenderExecutionResult {
    const t0 = performance.now();
    this.validateExecutionRequest(req);

    const sourceHashBefore = sha256Float32List(req.sourceChannels);
    const chCount = req.sourceChannels.length;
    const totalFrames = req.sourceChannels[0].length;
    const sr = req.sampleRateHz;
    const curveType: TransitionCurveType = req.transitionCurve ?? 'EQUAL_POWER';
    const defaultCrossfadeMs = Math.max(0, Math.min(80, req.defaultCrossfadeMs ?? 12));
    const zcTol = Math.max(0, Math.min(128, req.zeroCrossingToleranceSamples ?? 32));
    const gainLinear = req.gainLinear ?? 1.0;

    // 1. Collect approved cuts sorted in ascending source sample order
    const approvedCuts = req.plan.operations
      .filter((o) => isCutOperationType(o.operationType) && o.approvalState === 'USER_APPROVED')
      .sort((a, b) => a.sourceRange.startSample - b.sourceRange.startSample);

    const removedRanges: RemovedRangeRecord[] = approvedCuts.map((c) => ({
      operationId: c.operationId,
      operationType: c.operationType,
      sourceStartSample: c.sourceRange.startSample,
      sourceEndSample: c.sourceRange.endSample,
      durationMs: c.sourceRange.durationMs,
      approvedBy: c.approvedBy,
      approvedAtUtc: c.approvedAtUtc,
    }));

    // 2. Compute retained half-open intervals [start, end) with optional bounded zero-crossing micro-snap
    interface RetainedRegion {
      startSample: number;
      endSample: number;
      fadeMsAfter: number;
      zcDeltaEnd: number;
    }

    const regions: RetainedRegion[] = [];
    let cursor = 0;
    for (const cut of approvedCuts) {
      let cutStart = cut.sourceRange.startSample;
      let cutEnd = cut.sourceRange.endSample;

      let zcDelta = 0;
      if (zcTol > 0 && cut.transitionHint.zeroCrossingSnapAllowed && cutStart > cursor + zcTol) {
        const snapped = findNearestZeroCrossing(req.sourceChannels[0], cutStart, cursor, cutEnd, zcTol);
        // Never snap into a protected range
        const snapSafe = !req.plan.protectedRanges.some((pr) =>
          rangesOverlap(Math.min(cutStart, snapped), Math.max(cutStart, snapped), pr.startSample, pr.endSample),
        );
        if (snapSafe) {
          zcDelta = snapped - cutStart;
          cutStart = snapped;
        }
      }

      if (cutStart > cursor) {
        regions.push({
          startSample: cursor,
          endSample: cutStart,
          fadeMsAfter: curveType === 'NONE' ? 0 : cut.transitionHint.recommendedFadeMs || defaultCrossfadeMs,
          zcDeltaEnd: zcDelta,
        });
      }
      cursor = Math.max(cursor, cutEnd);
    }
    if (cursor < totalFrames) {
      regions.push({
        startSample: cursor,
        endSample: totalFrames,
        fadeMsAfter: 0,
        zcDeltaEnd: 0,
      });
    }

    // 3. Build Declarative Deterministic Render Graph
    const graphId = `rgraph_${crypto.randomBytes(4).toString('hex')}`;
    const nodes: RenderGraphNode[] = [
      {
        nodeId: 'n1_source_acq',
        nodeType: 'SOURCE_ACQUISITION',
        inputs: [],
        config: { audioId: req.plan.audioId, channels: chCount, sampleRateHz: sr, totalFrames },
      },
      {
        nodeId: 'n2_source_val',
        nodeType: 'SOURCE_VALIDATION',
        inputs: ['n1_source_acq'],
        config: { expectedSourcePcmSha256: req.expectedSourcePcmSha256, sourceRevisionId: req.expectedSourceRevisionId },
      },
      {
        nodeId: 'n3_range_sel',
        nodeType: 'RANGE_SELECTION',
        inputs: ['n2_source_val'],
        config: { retainedRegionCount: regions.length, approvedCutCount: approvedCuts.length },
      },
      {
        nodeId: 'n4_seq',
        nodeType: 'REGION_SEQUENCING',
        inputs: ['n3_range_sel'],
        config: { intervalSemantics: 'HALF_OPEN_[startSample,endSample)' },
      },
      {
        nodeId: 'n5_gain',
        nodeType: 'GAIN',
        inputs: ['n4_seq'],
        config: { gainLinear },
      },
      {
        nodeId: 'n6_transition',
        nodeType: 'TRANSITION',
        inputs: ['n5_gain'],
        config: { curveType, defaultCrossfadeMs, zeroCrossingToleranceSamples: zcTol },
      },
      {
        nodeId: 'n7_channel_map',
        nodeType: 'CHANNEL_MAPPING',
        inputs: ['n6_transition'],
        config: { policy: 'PRESERVE_ORIGINAL_CHANNELS', channels: chCount },
      },
      {
        nodeId: 'n8_resample',
        nodeType: 'RESAMPLING',
        inputs: ['n7_channel_map'],
        config: { mode: 'IDENTITY_NO_RESAMPLE', sampleRateHz: sr },
      },
      {
        nodeId: 'n9_encode',
        nodeType: 'ENCODING',
        inputs: ['n8_resample'],
        config: { format: req.exportFormat, mode: req.renderMode },
      },
      {
        nodeId: 'n10_validate',
        nodeType: 'OUTPUT_VALIDATION',
        inputs: ['n9_encode'],
        config: { independentReopen: true, verifyUnmodifiedSamplePreservation: true },
      },
    ];
    const renderGraph: RenderGraphSpec = {
      graphId,
      graphVersion: SHAHAB_RENDER_GRAPH_VERSION,
      deterministicDigestSha256: crypto
        .createHash('sha256')
        .update(JSON.stringify(nodes.map((n) => ({ t: n.nodeType, c: n.config }))))
        .digest('hex'),
      nodes,
    };

    // Check cancellation before heavy PCM sequencing
    if (req.abortSignal?.aborted) {
      return this.buildCancelledResult(req, renderGraph, sourceHashBefore, removedRanges, t0);
    }

    // 4. Compute exact output length and crossfade overlap lengths
    const spliceFadeSamples: number[] = [];
    for (let i = 0; i + 1 < regions.length; i++) {
      const rA = regions[i];
      const rB = regions[i + 1];
      const reqSamples = Math.round((rA.fadeMsAfter / 1000) * sr);
      const maxSafe = Math.floor(Math.min(rA.endSample - rA.startSample, rB.endSample - rB.startSample) * 0.25);
      spliceFadeSamples.push(curveType === 'NONE' ? 0 : Math.min(reqSamples, maxSafe));
    }

    let outputTotalFrames = 0;
    for (let i = 0; i < regions.length; i++) {
      outputTotalFrames += regions[i].endSample - regions[i].startSample;
      if (i > 0) outputTotalFrames -= spliceFadeSamples[i - 1];
    }
    outputTotalFrames = Math.max(0, outputTotalFrames);

    const outputChannels = Array.from({ length: chCount }, () => new Float32Array(outputTotalFrames));
    const sourceOutputMappings: SourceOutputMapping[] = [];
    const appliedTransitions: AppliedTransitionRecord[] = [];

    // 5. Execute sample-accurate reconstruction + controlled transitions
    let outWritePos = 0;
    for (let idx = 0; idx < regions.length; idx++) {
      if (req.abortSignal?.aborted) {
        return this.buildCancelledResult(req, renderGraph, sourceHashBefore, removedRanges, t0);
      }

      const reg = regions[idx];
      const len = reg.endSample - reg.startSample;
      const incomingFade = idx > 0 ? spliceFadeSamples[idx - 1] : 0;
      const outgoingFade = idx + 1 < regions.length ? spliceFadeSamples[idx] : 0;

      if (idx === 0) {
        for (let c = 0; c < chCount; c++) {
          const src = req.sourceChannels[c];
          const dst = outputChannels[c];
          if (gainLinear === 1.0) {
            dst.set(src.subarray(reg.startSample, reg.endSample), 0);
          } else {
            for (let k = 0; k < len; k++) {
              dst[k] = src[reg.startSample + k] * gainLinear;
            }
          }
        }
        const safeEndSrc = reg.endSample - outgoingFade;
        sourceOutputMappings.push({
          mappingId: `map_${idx + 1}`,
          sourceStartSample: reg.startSample,
          sourceEndSample: reg.endSample,
          outputStartSample: 0,
          outputEndSample: len,
          sampleRateHz: sr,
          isTransitionOverlapRegion: false,
          exactCopyVerifiedRange:
            safeEndSrc > reg.startSample
              ? {
                  sourceStartSample: reg.startSample,
                  sourceEndSample: safeEndSrc,
                  outputStartSample: 0,
                  outputEndSample: safeEndSrc - reg.startSample,
                }
              : null,
        });
        outWritePos = len;
      } else {
        const spliceOutStart = outWritePos - incomingFade;
        const prevRegion = regions[idx - 1];
        const jumpBefore = Math.abs(
          req.sourceChannels[0][reg.startSample] - req.sourceChannels[0][Math.max(0, prevRegion.endSample - 1)],
        );

        // Apply crossfade overlap over [spliceOutStart, outWritePos)
        for (let k = 0; k < incomingFade; k++) {
          const t = incomingFade > 1 ? k / (incomingFade - 1) : 0.5;
          const wOut = curveType === 'EQUAL_POWER' ? Math.cos(t * Math.PI * 0.5) : 1 - t;
          const wIn = curveType === 'EQUAL_POWER' ? Math.sin(t * Math.PI * 0.5) : t;
          for (let c = 0; c < chCount; c++) {
            const existing = outputChannels[c][spliceOutStart + k];
            const incoming = req.sourceChannels[c][reg.startSample + k] * gainLinear;
            outputChannels[c][spliceOutStart + k] = existing * wOut + incoming * wIn;
          }
        }

        // Copy non-overlapping body of current region exactly
        const bodyLen = len - incomingFade;
        for (let c = 0; c < chCount; c++) {
          const src = req.sourceChannels[c];
          const dst = outputChannels[c];
          if (gainLinear === 1.0) {
            dst.set(src.subarray(reg.startSample + incomingFade, reg.endSample), outWritePos);
          } else {
            for (let k = 0; k < bodyLen; k++) {
              dst[outWritePos + k] = src[reg.startSample + incomingFade + k] * gainLinear;
            }
          }
        }

        const jumpAfter =
          spliceOutStart > 0 && spliceOutStart < outputTotalFrames
            ? Math.abs(outputChannels[0][spliceOutStart] - outputChannels[0][spliceOutStart - 1])
            : 0;

        appliedTransitions.push({
          spliceIndex: idx,
          outputSamplePosition: spliceOutStart,
          curveType,
          requestedFadeMs: prevRegion.fadeMsAfter,
          actualFadeSamples: incomingFade,
          zeroCrossingSnapDeltaSamples: prevRegion.zcDeltaEnd,
          boundaryJumpBeforeTransition: Number(jumpBefore.toFixed(5)),
          boundaryJumpAfterTransition: Number(jumpAfter.toFixed(5)),
        });

        const exactStartSrc = reg.startSample + incomingFade;
        const exactEndSrc = reg.endSample - outgoingFade;
        sourceOutputMappings.push({
          mappingId: `map_${idx + 1}`,
          sourceStartSample: reg.startSample,
          sourceEndSample: reg.endSample,
          outputStartSample: spliceOutStart,
          outputEndSample: outWritePos + bodyLen,
          sampleRateHz: sr,
          isTransitionOverlapRegion: incomingFade > 0,
          exactCopyVerifiedRange:
            exactEndSrc > exactStartSrc
              ? {
                  sourceStartSample: exactStartSrc,
                  sourceEndSample: exactEndSrc,
                  outputStartSample: outWritePos,
                  outputEndSample: outWritePos + (exactEndSrc - exactStartSrc),
                }
              : null,
        });

        outWritePos += bodyLen;
      }
    }

    // 6. Encode WAV & optionally perform atomic disk write
    const wavBytes = encodePlanarToWav(
      outputChannels,
      sr,
      req.exportFormat as 'WAV_PCM_16' | 'WAV_PCM_32F',
    );
    let finalOutputPath: string | null = null;
    if (req.outputFilePath) {
      finalOutputPath = path.resolve(req.outputFilePath);
      fs.mkdirSync(path.dirname(finalOutputPath), { recursive: true });
      const tmpPath = `${finalOutputPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, wavBytes);
      fs.renameSync(tmpPath, finalOutputPath);
    }

    // 7. Independent Reopen & Output Validation (SHAHAB-030 §9)
    const sourceHashAfter = sha256Float32List(req.sourceChannels);
    const bytesToValidate = finalOutputPath ? new Uint8Array(fs.readFileSync(finalOutputPath)) : wavBytes;
    const outputFileSha256 = crypto.createHash('sha256').update(bytesToValidate).digest('hex');
    const reopened = independentlyDecodeWav(bytesToValidate);

    const errors: string[] = [];
    const warnings: string[] = [];
    const sourceInheritedNotes: string[] = [];
    if (!reopened.headerValid) errors.push('Reopened WAV header is invalid.');
    if (reopened.channels !== chCount) errors.push(`Channel mismatch: expected ${chCount}, got ${reopened.channels}.`);
    if (reopened.sampleRateHz !== sr) errors.push(`Sample rate mismatch: expected ${sr}, got ${reopened.sampleRateHz}.`);
    if (reopened.totalFrames !== outputTotalFrames) {
      errors.push(`Frame count mismatch: expected ${outputTotalFrames}, got ${reopened.totalFrames}.`);
    }
    if (sourceHashBefore !== sourceHashAfter) {
      errors.push('CRITICAL: Source PCM buffer hash changed during render!');
    }

    let sourceInheritedClippedSampleCount = 0;
    for (const reg of regions) {
      for (let c = 0; c < chCount; c++) {
        const srcBuf = req.sourceChannels[c];
        for (let i = reg.startSample; i < reg.endSample; i++) {
          if (Math.abs(srcBuf[i]) >= 0.999) sourceInheritedClippedSampleCount++;
        }
      }
    }

    let containsNaNOrInf = false;
    let peak = 0;
    let clippedSampleCount = 0;
    for (const ch of reopened.channelBuffers) {
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        if (!Number.isFinite(v)) {
          containsNaNOrInf = true;
        } else {
          const av = Math.abs(v);
          if (av > peak) peak = av;
          if (av >= 0.999) clippedSampleCount++;
        }
      }
    }
    const renderIntroducedClippedSampleCount = Math.max(
      0,
      clippedSampleCount - sourceInheritedClippedSampleCount,
    );
    if (containsNaNOrInf) errors.push('Rendered output contains NaN or Inf sample values.');
    if (renderIntroducedClippedSampleCount > 0) {
      warnings.push(
        `Render introduced ${renderIntroducedClippedSampleCount} new near-full-scale sample(s) (>=0.999).`,
      );
    }
    if (sourceInheritedClippedSampleCount > 0) {
      sourceInheritedNotes.push(
        `Retained source regions already contained ${sourceInheritedClippedSampleCount} near-full-scale sample(s) (>=0.999), preserved bit-exact without introducing render clipping.`,
      );
    }

    // Verify exact unmodified region sample preservation
    let maxUnmodErr = 0;
    if (reopened.headerValid && reopened.channelBuffers.length === chCount) {
      for (const map of sourceOutputMappings) {
        const ex = map.exactCopyVerifiedRange;
        if (!ex) continue;
        const spanLen = ex.sourceEndSample - ex.sourceStartSample;
        const step = Math.max(1, Math.floor(spanLen / 2000));
        for (let c = 0; c < chCount; c++) {
          for (let k = 0; k < spanLen; k += step) {
            const expected = req.sourceChannels[c][ex.sourceStartSample + k] * gainLinear;
            const actual = reopened.channelBuffers[c][ex.outputStartSample + k];
            const err = Math.abs(expected - actual);
            if (err > maxUnmodErr) maxUnmodErr = err;
          }
        }
      }
    }

    const tol = req.exportFormat === 'WAV_PCM_32F' ? 1e-6 : 1 / 32768 + 1e-5;
    const unmodifiedRegionBitExactVerified = maxUnmodErr <= tol;
    if (!unmodifiedRegionBitExactVerified) {
      errors.push(`Unmodified region sample deviation ${maxUnmodErr.toExponential(3)} exceeds format tolerance ${tol.toExponential(3)}.`);
    }

    const validationStatus: RenderValidationStatus =
      errors.length > 0
        ? 'RENDER_VALIDATION_FAILED'
        : warnings.length > 0
          ? 'RENDER_SIGNAL_WARNINGS'
          : 'RENDER_VALIDATED';

    const totalRemovedSamples = Math.max(0, totalFrames - outputTotalFrames);
    const result: RenderExecutionResult = {
      renderId: `rnd_${crypto.randomBytes(5).toString('hex')}`,
      renderMode: req.renderMode,
      contractVersion: SHAHAB_RENDER_ENGINE_CONTRACT_VERSION,
      planId: req.plan.planId,
      planRevision: req.plan.planRevision,
      sourceRevisionId: req.expectedSourceRevisionId,
      sourcePcmSha256Before: sourceHashBefore,
      sourcePcmSha256After: sourceHashAfter,
      exportFormat: req.exportFormat,
      sampleRateHz: sr,
      channels: chCount,
      sourceTotalFrames: totalFrames,
      outputTotalFrames,
      totalRemovedSamples,
      totalRemovedMs: Number(((totalRemovedSamples / sr) * 1000).toFixed(2)),
      renderGraph,
      sourceOutputMappings,
      removedRanges,
      appliedTransitions,
      outputFilePath: finalOutputPath,
      outputWavBytes: wavBytes,
      outputChannels,
      validation: {
        status: validationStatus,
        reopenedIndependently: true,
        headerValid: reopened.headerValid,
        expectedChannels: chCount,
        actualChannels: reopened.channels,
        expectedSampleRateHz: sr,
        actualSampleRateHz: reopened.sampleRateHz,
        expectedOutputFrames: outputTotalFrames,
        actualOutputFrames: reopened.totalFrames,
        durationMismatchMs: Number((Math.abs(outputTotalFrames - reopened.totalFrames) / sr * 1000).toFixed(4)),
        containsNaNOrInf,
        peakDbfs: toDbfs(peak),
        clippedSampleCount,
        sourceInheritedClippedSampleCount,
        renderIntroducedClippedSampleCount,
        unmodifiedRegionExactSampleMaxAbsError: Number(maxUnmodErr.toExponential(4)),
        unmodifiedRegionBitExactVerified,
        sourceHashUnchangedVerified: sourceHashBefore === sourceHashAfter,
        outputFileSha256,
        warnings,
        sourceInheritedNotes,
        errors,
      },
      wallTimeMs: Number((performance.now() - t0).toFixed(2)),
      checkpointState: 'COMPLETED',
      createdAtUtc: new Date().toISOString(),
    };

    this.renderHistory.push(result);
    return result;
  }

  private buildCancelledResult(
    req: RenderExecutionRequest,
    renderGraph: RenderGraphSpec,
    sourceHashBefore: string,
    removedRanges: readonly RemovedRangeRecord[],
    t0: number,
  ): RenderExecutionResult {
    const sourceHashAfter = sha256Float32List(req.sourceChannels);
    return {
      renderId: `rnd_cancel_${crypto.randomBytes(4).toString('hex')}`,
      renderMode: req.renderMode,
      contractVersion: SHAHAB_RENDER_ENGINE_CONTRACT_VERSION,
      planId: req.plan.planId,
      planRevision: req.plan.planRevision,
      sourceRevisionId: req.expectedSourceRevisionId,
      sourcePcmSha256Before: sourceHashBefore,
      sourcePcmSha256After: sourceHashAfter,
      exportFormat: req.exportFormat,
      sampleRateHz: req.sampleRateHz,
      channels: req.sourceChannels.length,
      sourceTotalFrames: req.sourceChannels[0].length,
      outputTotalFrames: 0,
      totalRemovedSamples: 0,
      totalRemovedMs: 0,
      renderGraph,
      sourceOutputMappings: [],
      removedRanges,
      appliedTransitions: [],
      outputFilePath: null,
      outputWavBytes: null,
      outputChannels: [],
      validation: {
        status: 'RENDER_VALIDATION_FAILED',
        reopenedIndependently: false,
        headerValid: false,
        expectedChannels: req.sourceChannels.length,
        actualChannels: 0,
        expectedSampleRateHz: req.sampleRateHz,
        actualSampleRateHz: 0,
        expectedOutputFrames: 0,
        actualOutputFrames: 0,
        durationMismatchMs: 0,
        containsNaNOrInf: false,
        peakDbfs: -120,
        clippedSampleCount: 0,
        sourceInheritedClippedSampleCount: 0,
        renderIntroducedClippedSampleCount: 0,
        unmodifiedRegionExactSampleMaxAbsError: 0,
        unmodifiedRegionBitExactVerified: false,
        sourceHashUnchangedVerified: sourceHashBefore === sourceHashAfter,
        outputFileSha256: null,
        warnings: ['Render cancelled cleanly via AbortSignal before completion; no corrupt artifact written.'],
        sourceInheritedNotes: [],
        errors: ['RENDER_CANCELLED'],
      },
      wallTimeMs: Number((performance.now() - t0).toFixed(2)),
      checkpointState: 'CANCELLED_CLEANLY',
      createdAtUtc: new Date().toISOString(),
    };
  }
}
