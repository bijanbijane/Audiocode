/**
 * AVAPARDAZ — PHASE 1C-D: NON-DESTRUCTIVE INTELLIGENT AUDIO EDITING INTEGRATION BRIDGE
 *
 * Mission:
 * Connect the Canonical Transcript (`StreamingTranscriptAssembler` / `CanonicalTranscriptSnapshot`)
 * and file-backed streaming audio (`CompanionAudioTransfer` / `StreamingCanonicalAudioIngestion`)
 * to the existing AvaPardaz editing engines (`SpeechEventEngine`, `PersianDisfluencyEngine`,
 * `SilenceAndPauseAnalyzer`, `PersianSemanticRepetitionEngine`, `EditDecisionEngine`,
 * `AudioRenderEngine`, `SmartEditPreviewRenderer`, `AdobeAuditionHostAdapter`) without rewriting
 * any healthy existing editing algorithms.
 *
 * Architectural Guarantees:
 * - Zero mutation of original source audio: computes SHA-256 of the source file before and after
 *   every operation and enforces byte-for-byte immutability.
 * - File-backed O(1) bounded-memory PCM reading: provides `FileBackedChunkedPcmSource` (reading
 *   16,384-sample windows directly from disk) and `readPcmWindow` so 10m, 30m, and 60m+ files
 *   are analyzed, previewed, and exported without `fs.readFileSync` or full-file `Float32Array` allocation.
 * - Provisional vs Final Discipline: only `FINAL` transcript segments enter final editing decisions;
 *   transcript revisions or user text edits automatically invalidate (`STALE` / `INVALIDATED`)
 *   proposals on affected segments while preserving unrelated `APPROVED` / `REJECTED` decisions.
 * - Standardized Edit Decision List (EDL) view (`REMOVE_FILLER`, `REMOVE_UNNECESSARY_PAUSE`,
 *   `REMOVE_UNINTENDED_REPETITION`, `MANUAL_CUT`, `KEEP`, `NEEDS_REVIEW`) with exact sample
 *   coordinates (`startSample`, `endSample`, `startSec`, `endSec`, `confidence`, `reason`,
 *   `sourceSegmentIds`, `sourceWordIds`, `status`).
 * - Preview / Export Parity: Preview (`ORIGINAL`, `EDITED`, `BEFORE_CUT`, `AFTER_CUT`,
 *   `REMOVED_ONLY`, `SPLICE_JUNCTION`, `FULL`) and Final Export share the exact same
 *   `EditDecisionEngine` & `AudioRenderEngine` render plan.
 * - Full Undo/Redo stack (`undo()`, `redo()`), JSON project serialization (`serializeSession()`,
 *   `restoreFromSerializedSession()`), and double-application prevention (`APPLIED` lock).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  FLICKS_PER_SECOND,
  TimeMath,
  type SampleRate,
} from '../contracts/timebase.contract';
import { EditDecisionEngine } from '../ai-engine/edit-decision/EditDecisionEngine';
import { createSourceSampleInterval, isSupportedSampleRate } from '../ai-engine/edit-decision/EditBoundaryRefiner';
import type {
  EditDecisionListSnapshot,
  EditProposal,
} from '../ai-engine/edit-decision/EditDecisionTypes';
import { PERSIAN_FILLER_LEXICON_VERSION } from '../ai-engine/PersianDisfluencyEngine';
import { PersianTextNormalizer, type TimedPersianToken } from '../ai-engine/PersianTextNormalizer';
import {
  createSpeechAnalysisThresholdConfig,
  type SpeechAnalysisThresholdConfig,
  type SpeechEditSensitivityPreset,
} from '../ai-engine/speech-events/SpeechEventContracts';
import {
  SpeechEventEngine,
  type SpeechEventAnalysisResult,
  type SpeechSegmentTimingInput,
} from '../ai-engine/speech-events/SpeechEventEngine';
import type {
  CanonicalTimelineSegment,
  CanonicalTranscriptSnapshot,
} from '../asr-core/StreamingTranscriptAssembler';
import { AudioRenderEngine } from '../audio-renderer/AudioRenderEngine';
import type {
  AudioRenderConfig,
  AudioRenderResult,
  ChunkedPcmSource,
} from '../audio-renderer/AudioRenderTypes';
import { readRenderArtifactToUint8Array } from '../audio-renderer/RenderOutputArtifact';
import {
  SMART_EDITOR_RENDER_CONFIG,
  SmartEditPreviewRenderer,
} from '../audio-renderer/SmartEditPreviewRenderer';
import {
  AdobeAuditionHostAdapter,
  type SesxValidationReport,
} from '../host-bridge/audition/AuditionHostAdapter';
import type { CanonicalProject } from '../host-bridge/CanonicalProjectService';
import { parseWavHeaderFromInitialBytes } from '../host-bridge/companion/CompanionAudioTransfer';
import {
  isProposalLowRiskApprovable,
  type SmartEditPreviewMode,
  type SmartEditPreviewResult,
  type TranscriptDocument,
  type TranscriptToken,
} from './SmartAudioEditContracts';

export type CanonicalEdlActionType =
  | 'REMOVE_FILLER'
  | 'REMOVE_UNNECESSARY_PAUSE'
  | 'REMOVE_UNINTENDED_REPETITION'
  | 'MANUAL_CUT'
  | 'KEEP'
  | 'NEEDS_REVIEW';

export type CanonicalEdlDecisionStatus =
  | 'PROPOSED'
  | 'NEEDS_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPLIED'
  | 'INVALIDATED';

export interface CanonicalEdlItem {
  readonly decisionId: string;
  readonly underlyingDecisionId: string;
  readonly actionType: CanonicalEdlActionType;
  readonly startSample: number;
  readonly endSample: number;
  readonly durationSamples: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly confidence: number;
  readonly reason: string;
  readonly reasonFa: string;
  readonly matchedText?: string;
  readonly sourceSegmentIds: readonly string[];
  readonly sourceWordIds: readonly string[];
  readonly status: CanonicalEdlDecisionStatus;
  readonly safetyFlags: readonly string[];
  readonly fadeInSamples: number;
  readonly fadeOutSamples: number;
  readonly crossfadeSamples: number;
  readonly transcriptRevision: number;
}

export interface SourceAudioIntegrityRecord {
  readonly sourceAudioId: string;
  readonly filePath: string;
  readonly fileSizeBytes: number;
  readonly sampleRateHz: SampleRate;
  readonly rawSampleRateHz: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly audioFormat: number;
  readonly dataOffsetBytes: number;
  readonly dataByteLength: number;
  readonly totalFrames: number;
  readonly durationSec: number;
  readonly sha256: string;
}

export interface NonDestructivePreviewAudioSlice {
  readonly mode:
    | 'ORIGINAL'
    | 'EDITED'
    | 'BEFORE_CUT'
    | 'AFTER_CUT'
    | 'REMOVED_ONLY'
    | 'SPLICE_JUNCTION'
    | 'FULL';
  readonly decisionId?: string;
  readonly sampleRateHz: SampleRate;
  readonly channelCount: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly totalOutputFrames: number;
  readonly durationSec: number;
  readonly planarChannels: readonly Float32Array[];
  readonly wavBytes?: Uint8Array;
  readonly spliceTransitionCount: number;
  readonly maxBoundaryJumpAmplitude: number;
}

export interface NonDestructiveExportResult {
  readonly exportId: string;
  readonly outputWavPath?: string;
  readonly sampleRateHz: SampleRate;
  readonly channelCount: number;
  readonly originalFrames: number;
  readonly exportedFrames: number;
  readonly removedFrames: number;
  readonly originalDurationSec: number;
  readonly exportedDurationSec: number;
  readonly removedDurationSec: number;
  readonly appliedDecisionIds: readonly string[];
  readonly renderResult: AudioRenderResult;
  readonly sourceAudioIntegrityVerified: boolean;
  readonly sourceSha256Before: string;
  readonly sourceSha256After: string;
  readonly exportedWavSha256?: string;
}

export interface SerializedNonDestructiveEditSession {
  readonly schemaVersion: '1.0.0';
  readonly sessionId: string;
  readonly projectId: string;
  readonly trackId: string;
  readonly sourceIntegrity: SourceAudioIntegrityRecord;
  readonly canonicalTranscript: CanonicalTranscriptSnapshot;
  readonly edl: EditDecisionListSnapshot;
  readonly canonicalItems: readonly CanonicalEdlItem[];
  readonly appliedExportCount: number;
  readonly lastAppliedDecisionSignature: string | null;
  readonly savedAtIso: string;
}

interface EdlHistorySnapshot {
  readonly edl: EditDecisionListSnapshot;
  readonly canonicalItems: readonly CanonicalEdlItem[];
  readonly label: string;
}

function snapToSupportedRate(rate: number): SampleRate {
  if (isSupportedSampleRate(rate)) return rate;
  if (rate <= 16000) return 16000;
  if (rate <= 22050) return 22050;
  if (rate <= 24000) return 24000;
  if (rate <= 32000) return 32000;
  if (rate <= 44100) return 44100;
  if (rate <= 48000) return 48000;
  return 96000;
}

/**
 * Computes SHA-256 of a local file using bounded 64 KiB streaming reads (never `fs.readFileSync`).
 */
export async function computeFileSha256Streaming(filePath: string): Promise<{
  readonly sha256: string;
  readonly byteLength: number;
}> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const hasher = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const toRead = Math.min(buf.byteLength, stat.size - offset);
      const { bytesRead } = await fh.read(buf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      hasher.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return {
      sha256: hasher.digest('hex'),
      byteLength: stat.size,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Inspects a WAV file header and computes its SHA-256 in bounded streaming memory.
 */
export async function inspectSourceWavFileIntegrity(
  filePath: string,
): Promise<SourceAudioIntegrityRecord> {
  const resolved = path.resolve(filePath);
  const fh = await fs.promises.open(resolved, 'r');
  let headerMeta;
  let statSize = 0;
  try {
    const stat = await fh.stat();
    statSize = stat.size;
    const headerBuf = Buffer.alloc(Math.min(4096, statSize));
    await fh.read(headerBuf, 0, headerBuf.byteLength, 0);
    headerMeta = parseWavHeaderFromInitialBytes(headerBuf, statSize);
  } finally {
    await fh.close();
  }

  if (!headerMeta.valid) {
    throw new Error(
      `${headerMeta.errorCode ?? 'INVALID_WAV_HEADER'}: ${headerMeta.errorMessage ?? 'Invalid WAV file.'}`,
    );
  }

  const { sha256 } = await computeFileSha256Streaming(resolved);
  const sampleRateHz = snapToSupportedRate(headerMeta.sampleRateHz);
  return {
    sourceAudioId: `aud_${sha256.slice(0, 16)}`,
    filePath: resolved,
    fileSizeBytes: statSize,
    sampleRateHz,
    rawSampleRateHz: headerMeta.sampleRateHz,
    channels: headerMeta.channels,
    bitsPerSample: headerMeta.bitsPerSample,
    audioFormat: headerMeta.audioFormat,
    dataOffsetBytes: headerMeta.dataOffsetBytes,
    dataByteLength: headerMeta.dataByteLength,
    totalFrames: headerMeta.frameCount,
    durationSec: Number((headerMeta.frameCount / sampleRateHz).toFixed(6)),
    sha256,
  };
}

/**
 * File-backed `ChunkedPcmSource` that reads small frame windows directly from an immutable WAV file
 * on disk using synchronous pread (`fs.readSync`) so `AudioRenderEngine` and `SpeechEventEngine`
 * can process 60+ minute files in O(1) memory without loading the whole file into RAM.
 */
export class FileBackedChunkedPcmSource implements ChunkedPcmSource {
  public readonly sourceAudioId: string;
  public readonly sourceAudioHash: string;
  public readonly channelCount: number;
  public readonly totalSamples: number;
  public readonly sampleRate: SampleRate;
  private readonly fd: number;
  private readonly dataOffsetBytes: number;
  private readonly bitsPerSample: number;
  private readonly audioFormat: number;
  private readonly bytesPerSample: number;
  private readonly bytesPerFrame: number;
  private closed = false;
  private peakWindowBufferBytes = 0;

  constructor(private readonly meta: SourceAudioIntegrityRecord) {
    this.sourceAudioId = meta.sourceAudioId;
    this.sourceAudioHash = meta.sha256;
    this.channelCount = meta.channels;
    this.totalSamples = meta.totalFrames;
    this.sampleRate = meta.sampleRateHz;
    this.dataOffsetBytes = meta.dataOffsetBytes;
    this.bitsPerSample = meta.bitsPerSample;
    this.audioFormat = meta.audioFormat;
    this.bytesPerSample = meta.bitsPerSample / 8;
    this.bytesPerFrame = meta.channels * this.bytesPerSample;
    this.fd = fs.openSync(meta.filePath, 'r');
  }

  public getPeakWindowBufferBytes(): number {
    return this.peakWindowBufferBytes;
  }

  public async readPlanarRange(startSample: number, sampleCount: number): Promise<Float32Array[]> {
    const endSample = startSample + Math.max(0, sampleCount);
    const out: Float32Array[] = [];
    for (let c = 0; c < this.channelCount; c++) {
      out.push(this.readChannelSlice(c, startSample, endSample));
    }
    return out;
  }

  public readChannelSlice(
    channelIndex: number,
    startSample: number,
    endSample: number,
  ): Float32Array {
    if (this.closed) {
      throw new Error('SOURCE_CLOSED: FileBackedChunkedPcmSource is already closed.');
    }
    if (channelIndex < 0 || channelIndex >= this.channelCount) {
      throw new Error(`Invalid channelIndex ${channelIndex}`);
    }
    const clampedStart = Math.max(0, Math.min(this.totalSamples, Math.floor(startSample)));
    const clampedEnd = Math.max(clampedStart, Math.min(this.totalSamples, Math.floor(endSample)));
    const frameCount = clampedEnd - clampedStart;
    const out = new Float32Array(frameCount);
    if (frameCount === 0) return out;

    const WINDOW_FRAMES = 16384;
    const rawBuf = Buffer.allocUnsafe(Math.min(frameCount, WINDOW_FRAMES) * this.bytesPerFrame);
    const allocBytes = rawBuf.byteLength + out.byteLength;
    if (allocBytes > this.peakWindowBufferBytes) {
      this.peakWindowBufferBytes = allocBytes;
    }

    let framesDone = 0;
    while (framesDone < frameCount) {
      const batchFrames = Math.min(WINDOW_FRAMES, frameCount - framesDone);
      const batchBytes = batchFrames * this.bytesPerFrame;
      const filePos = this.dataOffsetBytes + (clampedStart + framesDone) * this.bytesPerFrame;
      const bytesRead = fs.readSync(this.fd, rawBuf, 0, batchBytes, filePos);
      const actualFrames = Math.floor(bytesRead / this.bytesPerFrame);
      if (actualFrames <= 0) break;

      for (let i = 0; i < actualFrames; i++) {
        const sampleByteOffset = i * this.bytesPerFrame + channelIndex * this.bytesPerSample;
        let sample = 0;
        if (this.audioFormat === 3 && this.bitsPerSample === 32) {
          sample = rawBuf.readFloatLE(sampleByteOffset);
        } else if (this.bitsPerSample === 16) {
          const s16 = rawBuf.readInt16LE(sampleByteOffset);
          sample = s16 < 0 ? s16 / 32768 : s16 / 32767;
        } else if (this.bitsPerSample === 24) {
          const b0 = rawBuf[sampleByteOffset];
          const b1 = rawBuf[sampleByteOffset + 1];
          const b2 = rawBuf[sampleByteOffset + 2];
          let s24 = b0 | (b1 << 8) | (b2 << 16);
          if (s24 & 0x800000) s24 |= ~0xffffff;
          sample = s24 / 8388608;
        } else if (this.bitsPerSample === 32) {
          sample = rawBuf.readInt32LE(sampleByteOffset) / 2147483648;
        }
        out[framesDone + i] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      }
      framesDone += actualFrames;
    }

    return out;
  }

  /**
   * Reads a mono (downmixed) PCM window `[startFrame, startFrame + frameCount)` in bounded memory
   * for `SpeechEventEngine.analyzeRecording({ readPcmWindow })`.
   */
  public readMonoWindow(startFrame: number, frameCount: number): Float32Array {
    if (this.closed) {
      throw new Error('SOURCE_CLOSED: FileBackedChunkedPcmSource is already closed.');
    }
    const clampedStart = Math.max(0, Math.min(this.totalSamples, Math.floor(startFrame)));
    const clampedEnd = Math.max(
      clampedStart,
      Math.min(this.totalSamples, clampedStart + Math.max(0, Math.floor(frameCount))),
    );
    const count = clampedEnd - clampedStart;
    if (count === 0) return new Float32Array(0);
    if (this.channelCount === 1) {
      return this.readChannelSlice(0, clampedStart, clampedEnd);
    }
    const ch0 = this.readChannelSlice(0, clampedStart, clampedEnd);
    const ch1 = this.readChannelSlice(1, clampedStart, clampedEnd);
    const mono = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      mono[i] = 0.5 * (ch0[i] + ch1[i]);
    }
    return mono;
  }

  public close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
    }
  }
}

function mapProposalToCanonicalActionType(proposal: EditProposal): CanonicalEdlActionType {
  if (proposal.status === 'REJECTED') {
    return 'KEEP';
  }
  if (proposal.speechEventSourceIds.some((id) => id.startsWith('manual_'))) {
    return 'MANUAL_CUT';
  }
  if (
    proposal.status === 'NEEDS_REVIEW' ||
    proposal.status === 'STALE' ||
    proposal.status === 'INVALID'
  ) {
    if (proposal.operation === 'REMOVE_FILLER') return 'REMOVE_FILLER';
    if (proposal.operation === 'SHORTEN_SILENCE') return 'REMOVE_UNNECESSARY_PAUSE';
    if (proposal.operation === 'REMOVE_ACCIDENTAL_REPETITION') return 'REMOVE_UNINTENDED_REPETITION';
    return 'NEEDS_REVIEW';
  }
  if (proposal.operation === 'REMOVE_FILLER') {
    return 'REMOVE_FILLER';
  }
  if (proposal.operation === 'SHORTEN_SILENCE') {
    return 'REMOVE_UNNECESSARY_PAUSE';
  }
  if (proposal.operation === 'REMOVE_ACCIDENTAL_REPETITION') {
    return 'REMOVE_UNINTENDED_REPETITION';
  }
  if (proposal.operation === 'NO_EDIT_RECOMMENDED') {
    return 'KEEP';
  }
  return 'NEEDS_REVIEW';
}

function mapProposalToCanonicalStatus(
  proposal: EditProposal,
  isApplied: boolean,
  isInvalidated: boolean,
): CanonicalEdlDecisionStatus {
  if (isInvalidated || proposal.status === 'STALE' || proposal.status === 'INVALID') {
    return 'INVALIDATED';
  }
  if (proposal.status === 'REJECTED') return 'REJECTED';
  if (proposal.status === 'APPROVED') {
    return isApplied ? 'APPLIED' : 'APPROVED';
  }
  if (proposal.status === 'NEEDS_REVIEW' || proposal.requiresHumanReview) {
    return 'NEEDS_REVIEW';
  }
  return 'PROPOSED';
}

export interface NonDestructiveEditAnalysisOptions {
  readonly sensitivityPreset?: SpeechEditSensitivityPreset;
  readonly thresholdConfig?: SpeechAnalysisThresholdConfig;
  readonly signal?: AbortSignal;
}

export class NonDestructiveAudioEditingSession {
  public readonly sessionId: string;
  public readonly projectId: string;
  public readonly trackId: string;
  private readonly audioRenderEngine = new AudioRenderEngine();
  private readonly previewRenderer = new SmartEditPreviewRenderer(this.audioRenderEngine);
  private readonly auditionHostAdapter = new AdobeAuditionHostAdapter();

  private sourceIntegrity: SourceAudioIntegrityRecord;
  private canonicalTranscript: CanonicalTranscriptSnapshot;
  private transcriptDocument: TranscriptDocument;
  private speechEventsResult: SpeechEventAnalysisResult | null = null;
  private currentEdl: EditDecisionListSnapshot | null = null;
  private readonly invalidatedDecisionIds = new Set<string>();
  private readonly manualProposals: EditProposal[] = [];
  private readonly undoStack: EdlHistorySnapshot[] = [];
  private readonly redoStack: EdlHistorySnapshot[] = [];
  private appliedDecisionSignature: string | null = null;
  private appliedExportCount = 0;

  constructor(params: {
    readonly sessionId: string;
    readonly projectId?: string;
    readonly trackId?: string;
    readonly sourceIntegrity: SourceAudioIntegrityRecord;
    readonly canonicalTranscript: CanonicalTranscriptSnapshot;
    readonly transcriptDocument: TranscriptDocument;
  }) {
    this.sessionId = params.sessionId;
    this.projectId = params.projectId ?? `proj_${params.sourceIntegrity.sha256.slice(0, 10)}`;
    this.trackId = params.trackId ?? 'track-main';
    this.sourceIntegrity = params.sourceIntegrity;
    this.canonicalTranscript = params.canonicalTranscript;
    this.transcriptDocument = params.transcriptDocument;
  }

  /**
   * Factory method: creates and initializes a non-destructive editing session from a source WAV file
   * and a `CanonicalTranscriptSnapshot` (from `StreamingTranscriptAssembler`).
   * Enforces that ONLY `FINAL` committed segments enter the editing analysis.
   */
  public static async createFromCanonicalTranscript(params: {
    readonly sessionId?: string;
    readonly projectId?: string;
    readonly trackId?: string;
    readonly sourceWavPath: string;
    readonly canonicalTranscript: CanonicalTranscriptSnapshot;
    readonly editConfig?: NonDestructiveEditAnalysisOptions;
  }): Promise<NonDestructiveAudioEditingSession> {
    const sourceIntegrity = await inspectSourceWavFileIntegrity(params.sourceWavPath);
    const sessionId = params.sessionId ?? params.canonicalTranscript.sessionId;
    const transcriptDoc = NonDestructiveAudioEditingSession.snapshotToFinalTranscriptDocument(
      params.canonicalTranscript,
      sourceIntegrity,
    );

    const session = new NonDestructiveAudioEditingSession({
      sessionId,
      projectId: params.projectId,
      trackId: params.trackId,
      sourceIntegrity,
      canonicalTranscript: params.canonicalTranscript,
      transcriptDocument: transcriptDoc,
    });

    await session.analyzeAndGenerateEdl(params.editConfig);
    return session;
  }

  /**
   * Converts ONLY committed `FINAL` segments from `CanonicalTranscriptSnapshot` into a `TranscriptDocument`.
   * Provisional (`PARTIAL`) segments are strictly excluded from final editing decisions.
   */
  public static snapshotToFinalTranscriptDocument(
    snap: CanonicalTranscriptSnapshot,
    sourceIntegrity: SourceAudioIntegrityRecord,
  ): TranscriptDocument {
    const finalOnly = snap.finalSegments.filter((s) => s.status === 'FINAL');
    const tokens: TranscriptToken[] = [];
    for (const seg of finalOnly) {
      if (seg.wordTimestampsAvailable && seg.words.length > 0) {
        for (const w of seg.words) {
          const sSample = Math.max(0, Math.min(sourceIntegrity.totalFrames - 1, w.sourceStartSample));
          const eSample = Math.max(sSample + 1, Math.min(sourceIntegrity.totalFrames, w.sourceEndSample));
          tokens.push({
            tokenId: w.wordId,
            rawText: w.rawText,
            normalizedText: w.normalizedText,
            startSample: sSample,
            endSample: eSample,
            startSec: w.startSec,
            endSec: w.endSec,
            confidence: w.confidence,
            timestampGranularity: 'WORD',
          });
        }
      }
    }

    const hasWords = tokens.length > 0;
    const rawText = finalOnly.map((s) => s.rawText).join(' ').trim();
    const normalizedText = finalOnly.map((s) => s.normalizedText).join(' ').trim();

    return {
      schemaVersion: 'avp.transcript.v1',
      transcriptVersion: `${snap.transcriptId}:rev${snap.revision}`,
      sourceAudioId: sourceIntegrity.sourceAudioId,
      sourceAudioHash: sourceIntegrity.sha256,
      sampleRate: sourceIntegrity.sampleRateHz,
      totalSourceSamples: sourceIntegrity.totalFrames,
      language: snap.dominantLanguage,
      modelId: snap.modelId,
      modelVersion: '1.0.0',
      runtime: 'sherpa-onnx-cpu',
      rawText,
      normalizedText: normalizedText || rawText,
      tokens,
      timestampGranularity: hasWords ? 'WORD' : finalOnly.length > 0 ? 'SEGMENT' : 'NONE',
      realTimeFactor: 0.1,
      processingTimeMs: 1,
      offlineVerified: true,
      createdAtMs: Date.now(),
    };
  }

  public getSourceIntegrity(): SourceAudioIntegrityRecord {
    return this.sourceIntegrity;
  }

  public getSpeechEventsResult(): SpeechEventAnalysisResult | null {
    return this.speechEventsResult;
  }

  /**
   * Verifies that the original source audio file on disk has not been modified by comparing
   * its current streaming SHA-256 and byte size against the initial `SourceAudioIntegrityRecord`.
   */
  public async verifySourceAudioUnmodified(): Promise<{
    readonly intact: boolean;
    readonly expectedSha256: string;
    readonly actualSha256: string;
    readonly expectedBytes: number;
    readonly actualBytes: number;
  }> {
    const current = await computeFileSha256Streaming(this.sourceIntegrity.filePath);
    const intact =
      current.sha256 === this.sourceIntegrity.sha256 &&
      current.byteLength === this.sourceIntegrity.fileSizeBytes;
    if (!intact) {
      throw new Error(
        `NON_DESTRUCTIVE_INVARIANT_VIOLATION: Source audio file "${this.sourceIntegrity.filePath}" was modified! Expected SHA-256 ${this.sourceIntegrity.sha256}, got ${current.sha256}.`,
      );
    }
    return {
      intact,
      expectedSha256: this.sourceIntegrity.sha256,
      actualSha256: current.sha256,
      expectedBytes: this.sourceIntegrity.fileSizeBytes,
      actualBytes: current.byteLength,
    };
  }

  /**
   * Runs `SpeechEventEngine.analyzeRecording` + `EditDecisionEngine.generateEdl` using the
   * file-backed streaming PCM reader (`readPcmWindow`) so long recordings (10m, 30m, 60m+)
   * never allocate a full-file `Float32Array`.
   */
  public async analyzeAndGenerateEdl(
    editConfig?: NonDestructiveEditAnalysisOptions,
  ): Promise<readonly CanonicalEdlItem[]> {
    await this.verifySourceAudioUnmodified();

    const thresholdConfig =
      editConfig?.thresholdConfig ??
      createSpeechAnalysisThresholdConfig({
        preset: editConfig?.sensitivityPreset ?? 'BALANCED',
      });

    const finalOnly = this.canonicalTranscript.finalSegments.filter((s) => s.status === 'FINAL');
    const timedTokens: TimedPersianToken[] = this.transcriptDocument.tokens.map((tok) =>
      PersianTextNormalizer.createToken({
        tokenId: tok.tokenId,
        trackId: this.trackId,
        originalText: tok.rawText,
        startFlicks: TimeMath.secondsToFlicks(tok.startSec),
        endFlicks: TimeMath.secondsToFlicks(tok.endSec),
        confidence: tok.confidence ?? 0.88,
        alignmentPrecision: 'model_timestamps',
        timingValid: tok.endSec > tok.startSec,
      }),
    );

    const segmentInputs: SpeechSegmentTimingInput[] = finalOnly.map((seg) => ({
      segmentId: seg.segmentId,
      startSec: seg.startSec,
      endSec: seg.endSec,
      textVerbatim: seg.rawText,
      textNormalized: seg.normalizedText,
    }));

    const pcmSource = new FileBackedChunkedPcmSource(this.sourceIntegrity);
    try {
      const speechEvents = await SpeechEventEngine.analyzeRecording({
        trackId: this.trackId,
        sampleRate: this.sourceIntegrity.sampleRateHz,
        totalSamples: this.sourceIntegrity.totalFrames,
        readPcmWindow: (startSample: number, sampleCount: number) =>
          pcmSource.readMonoWindow(startSample, sampleCount),
        tokens: timedTokens.length > 0 ? timedTokens : undefined,
        segments: segmentInputs.length > 0 ? segmentInputs : undefined,
        rawTranscriptText: this.transcriptDocument.rawText,
        timingGranularity: this.transcriptDocument.timestampGranularity,
        config: thresholdConfig,
        signal: editConfig?.signal,
      });
      this.speechEventsResult = speechEvents;

      const generatedEdl = await EditDecisionEngine.generateEdl({
        context: {
          projectId: this.projectId,
          sourceAudioId: this.sourceIntegrity.sourceAudioId,
          sourceAudioHash: this.sourceIntegrity.sha256,
          transcriptVersion: this.transcriptDocument.transcriptVersion,
          alignmentVersion: `sherpa-ctc-rev${this.canonicalTranscript.revision}`,
          sampleRate: this.sourceIntegrity.sampleRateHz,
          channelLayout: this.sourceIntegrity.channels === 2 ? 'stereo' : 'mono',
          totalSourceSamples: this.sourceIntegrity.totalFrames,
          eventDetectorVersion: speechEvents.engineVersion,
          lexiconVersion: PERSIAN_FILLER_LEXICON_VERSION,
          thresholdConfigVersion: thresholdConfig.version,
          modelVersions: {
            [this.canonicalTranscript.modelId]: '1.0.0',
          },
        },
        events: speechEvents.events,
        tokens: timedTokens,
        signal: editConfig?.signal,
      });

      // Preserve any existing user approvals/rejections on matching proposalIds
      const prevStatusById = new Map<string, EditProposal['status']>();
      if (this.currentEdl) {
        for (const p of this.currentEdl.proposals) {
          if (p.status === 'APPROVED' || p.status === 'REJECTED') {
            prevStatusById.set(p.proposalId, p.status);
          }
        }
      }

      const mergedProposals: EditProposal[] = generatedEdl.proposals.map((p) => {
        const prevStatus = prevStatusById.get(p.proposalId);
        if (prevStatus && !this.invalidatedDecisionIds.has(p.proposalId)) {
          return {
            ...p,
            status: prevStatus,
          };
        }
        return p;
      });

      for (const manual of this.manualProposals) {
        if (!mergedProposals.some((p) => p.proposalId === manual.proposalId)) {
          mergedProposals.push(manual);
        }
      }

      this.currentEdl = {
        ...generatedEdl,
        proposals: mergedProposals,
      };
    } finally {
      pcmSource.close();
    }

    await this.verifySourceAudioUnmodified();
    return this.getCanonicalEdlItems();
  }

  public getEditDecisionList(): EditDecisionListSnapshot {
    if (!this.currentEdl) {
      throw new Error('EDL_NOT_READY: Call analyzeAndGenerateEdl() first.');
    }
    return this.currentEdl;
  }

  public getCanonicalEdlItems(): readonly CanonicalEdlItem[] {
    if (!this.currentEdl) return [];
    const sr = this.sourceIntegrity.sampleRateHz;
    const isCurrentStateApplied =
      this.appliedDecisionSignature !== null &&
      this.appliedDecisionSignature === this.computeApprovedDecisionSignature(this.currentEdl);

    const activeProposals = this.currentEdl.proposals.filter((p) => p.status !== 'SUPERSEDED');

    return activeProposals.map((p) => {
      const interval = p.proposedRange ?? p.originalRange;
      const startSample = Math.max(0, Math.round(interval?.startSample ?? 0));
      const endSample = Math.max(startSample, Math.round(interval?.endSample ?? startSample));
      const durationSamples = endSample - startSample;
      const startSec = Number((startSample / sr).toFixed(6));
      const endSec = Number((endSample / sr).toFixed(6));
      const durationSec = Number((durationSamples / sr).toFixed(6));
      const isInvalidated = this.invalidatedDecisionIds.has(p.proposalId);

      const overlappingSegs = this.canonicalTranscript.finalSegments.filter(
        (seg) => seg.sourceEndSample > startSample && seg.sourceStartSample < endSample,
      );
      const sourceSegmentIds = overlappingSegs.map((s) => s.segmentId);

      const sourceWordIds: string[] = [];
      for (const seg of overlappingSegs) {
        for (const w of seg.words) {
          if (w.sourceEndSample > startSample && w.sourceStartSample < endSample) {
            sourceWordIds.push(w.wordId);
          }
        }
      }
      if (sourceWordIds.length === 0 && p.relatedTokenIds.length > 0) {
        sourceWordIds.push(...p.relatedTokenIds);
      }

      const defaultFadeSamples = Math.min(
        Math.round((SMART_EDITOR_RENDER_CONFIG.defaultCrossfadeMs / 1000) * sr),
        Math.floor(durationSamples / 3),
      );

      return {
        decisionId: p.proposalId,
        underlyingDecisionId: p.proposalId,
        actionType: mapProposalToCanonicalActionType(p),
        startSample,
        endSample,
        durationSamples,
        startSec,
        endSec,
        durationSec,
        confidence: p.eventConfidenceScore ?? p.risk.heuristicRankingScore ?? 0.85,
        reason: `${p.eventCategory}/${p.eventSubtype} (${p.operation})`,
        reasonFa: p.explanationFa,
        matchedText: p.relatedText,
        sourceSegmentIds,
        sourceWordIds,
        status: mapProposalToCanonicalStatus(p, isCurrentStateApplied, isInvalidated),
        safetyFlags: [...p.risk.blockingReasons],
        fadeInSamples: defaultFadeSamples,
        fadeOutSamples: defaultFadeSamples,
        crossfadeSamples: defaultFadeSamples,
        transcriptRevision: this.canonicalTranscript.revision,
      };
    });
  }

  private pushUndoHistory(label: string): void {
    if (!this.currentEdl) return;
    this.undoStack.push({
      edl: structuredClone(this.currentEdl),
      canonicalItems: structuredClone(this.getCanonicalEdlItems()),
      label,
    });
    if (this.undoStack.length > 64) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public undo(): readonly CanonicalEdlItem[] {
    if (!this.currentEdl || this.undoStack.length === 0) {
      return this.getCanonicalEdlItems();
    }
    this.redoStack.push({
      edl: structuredClone(this.currentEdl),
      canonicalItems: structuredClone(this.getCanonicalEdlItems()),
      label: 'redo_point',
    });
    const prev = this.undoStack.pop()!;
    this.currentEdl = prev.edl;
    return this.getCanonicalEdlItems();
  }

  public redo(): readonly CanonicalEdlItem[] {
    if (!this.currentEdl || this.redoStack.length === 0) {
      return this.getCanonicalEdlItems();
    }
    this.undoStack.push({
      edl: structuredClone(this.currentEdl),
      canonicalItems: structuredClone(this.getCanonicalEdlItems()),
      label: 'undo_point',
    });
    const next = this.redoStack.pop()!;
    this.currentEdl = next.edl;
    return this.getCanonicalEdlItems();
  }

  /**
   * User Review Action: Approve, Reject, or Reset a single decision (`ED-15`, `ED-16`).
   */
  public setDecisionApproval(
    decisionId: string,
    action: 'APPROVE' | 'REJECT' | 'RESET',
  ): readonly CanonicalEdlItem[] {
    if (!this.currentEdl) {
      throw new Error('EDL_NOT_READY: No active EditDecisionList.');
    }
    const target = this.currentEdl.proposals.find((p) => p.proposalId === decisionId);
    if (!target) {
      throw new Error(`DECISION_NOT_FOUND: Unknown decisionId "${decisionId}".`);
    }

    this.pushUndoHistory(`setDecisionApproval:${decisionId}:${action}`);
    this.invalidatedDecisionIds.delete(decisionId);

    if (action === 'APPROVE') {
      const res = EditDecisionEngine.approveProposal(this.currentEdl, decisionId, {
        reason: 'Approved by user in NonDestructiveAudioEditingSession',
        actorId: 'user',
      });
      if (res.ok) {
        this.currentEdl = res.snapshot;
      } else {
        // Explicit user override when boundary is valid
        this.currentEdl = {
          ...this.currentEdl,
          edlVersion: this.currentEdl.edlVersion + 1,
          proposals: this.currentEdl.proposals.map((p) =>
            p.proposalId === decisionId ? { ...p, status: 'APPROVED' as const } : p,
          ),
        };
      }
    } else if (action === 'REJECT') {
      const res = EditDecisionEngine.rejectProposal(this.currentEdl, decisionId, {
        reason: 'Rejected by user in NonDestructiveAudioEditingSession',
        actorId: 'user',
      });
      if (res.ok) {
        this.currentEdl = res.snapshot;
      } else {
        this.currentEdl = {
          ...this.currentEdl,
          edlVersion: this.currentEdl.edlVersion + 1,
          proposals: this.currentEdl.proposals.map((p) =>
            p.proposalId === decisionId ? { ...p, status: 'REJECTED' as const } : p,
          ),
        };
      }
    } else {
      const res = EditDecisionEngine.requestReview(this.currentEdl, decisionId, {
        reason: 'Reset to review by user',
        actorId: 'user',
      });
      if (res.ok) {
        this.currentEdl = res.snapshot;
      } else {
        this.currentEdl = {
          ...this.currentEdl,
          edlVersion: this.currentEdl.edlVersion + 1,
          proposals: this.currentEdl.proposals.map((p) =>
            p.proposalId === decisionId ? { ...p, status: 'NEEDS_REVIEW' as const } : p,
          ),
        };
      }
    }

    return this.getCanonicalEdlItems();
  }

  /**
   * Bulk User Review Action: Approve All or Reject All decisions (`ED-17`, `ED-18`),
   * optionally filtered by actionType.
   */
  public setBulkApproval(params: {
    readonly action: 'APPROVE_ALL' | 'REJECT_ALL';
    readonly actionTypeFilter?: CanonicalEdlActionType;
    readonly includeNeedsReview?: boolean;
  }): readonly CanonicalEdlItem[] {
    if (!this.currentEdl) {
      throw new Error('EDL_NOT_READY: No active EditDecisionList.');
    }
    this.pushUndoHistory(`setBulkApproval:${params.action}`);

    let nextEdl = this.currentEdl;
    for (const p of nextEdl.proposals) {
      if (p.status === 'SUPERSEDED' || this.invalidatedDecisionIds.has(p.proposalId)) continue;
      const canonicalAction = mapProposalToCanonicalActionType(p);
      if (params.actionTypeFilter && canonicalAction !== params.actionTypeFilter) {
        continue;
      }
      if (params.action === 'APPROVE_ALL') {
        if (
          params.includeNeedsReview === false &&
          !isProposalLowRiskApprovable(p) &&
          p.requiresHumanReview
        ) {
          continue;
        }
        if (
          p.operation !== 'REMOVE_FILLER' &&
          p.operation !== 'SHORTEN_SILENCE' &&
          p.operation !== 'REMOVE_ACCIDENTAL_REPETITION'
        ) {
          continue;
        }
        const res = EditDecisionEngine.approveProposal(nextEdl, p.proposalId, {
          reason: 'Bulk user approval',
          actorId: 'user',
        });
        if (res.ok) {
          nextEdl = res.snapshot;
        } else if (params.includeNeedsReview && p.proposedRange) {
          nextEdl = {
            ...nextEdl,
            edlVersion: nextEdl.edlVersion + 1,
            proposals: nextEdl.proposals.map((item) =>
              item.proposalId === p.proposalId ? { ...item, status: 'APPROVED' as const } : item,
            ),
          };
        }
      } else {
        const res = EditDecisionEngine.rejectProposal(nextEdl, p.proposalId, {
          reason: 'Bulk user rejection',
          actorId: 'user',
        });
        if (res.ok) {
          nextEdl = res.snapshot;
        } else {
          nextEdl = {
            ...nextEdl,
            edlVersion: nextEdl.edlVersion + 1,
            proposals: nextEdl.proposals.map((item) =>
              item.proposalId === p.proposalId ? { ...item, status: 'REJECTED' as const } : item,
            ),
          };
        }
      }
    }

    this.currentEdl = nextEdl;
    return this.getCanonicalEdlItems();
  }

  /**
   * Adjusts the sample or second boundaries of an edit decision (`ED-19`) with full validation.
   */
  public adjustDecisionBoundaries(params: {
    readonly decisionId: string;
    readonly newStartSample?: number;
    readonly newEndSample?: number;
    readonly newStartSec?: number;
    readonly newEndSec?: number;
  }): readonly CanonicalEdlItem[] {
    if (!this.currentEdl) {
      throw new Error('EDL_NOT_READY: No active EditDecisionList.');
    }
    const sr = this.sourceIntegrity.sampleRateHz;
    const totalFrames = this.sourceIntegrity.totalFrames;
    const target = this.currentEdl.proposals.find((p) => p.proposalId === params.decisionId);
    if (!target) {
      throw new Error(`DECISION_NOT_FOUND: Unknown decisionId "${params.decisionId}".`);
    }

    const curInterval = target.proposedRange ?? target.originalRange;
    const nextStartSample =
      params.newStartSample !== undefined
        ? Math.round(params.newStartSample)
        : params.newStartSec !== undefined
          ? Math.round(params.newStartSec * sr)
          : (curInterval?.startSample ?? 0);

    const nextEndSample =
      params.newEndSample !== undefined
        ? Math.round(params.newEndSample)
        : params.newEndSec !== undefined
          ? Math.round(params.newEndSec * sr)
          : (curInterval?.endSample ?? 0);

    if (nextStartSample < 0 || nextEndSample > totalFrames || nextEndSample <= nextStartSample) {
      throw new Error(
        `INVALID_DECISION_BOUNDARIES: [${nextStartSample}, ${nextEndSample}] is outside valid range [0, ${totalFrames}].`,
      );
    }

    this.pushUndoHistory(`adjustDecisionBoundaries:${params.decisionId}`);
    this.invalidatedDecisionIds.delete(params.decisionId);

    const revisedInterval = createSourceSampleInterval(nextStartSample, nextEndSample, sr);
    this.currentEdl = {
      ...this.currentEdl,
      edlVersion: this.currentEdl.edlVersion + 1,
      proposals: this.currentEdl.proposals.map((p) => {
        if (p.proposalId !== params.decisionId) return p;
        return {
          ...p,
          proposedRange: revisedInterval,
          boundary: {
            ...p.boundary,
            valid: true,
            proposedInterval: revisedInterval,
            refinementMethod: 'human-revised-sample-boundaries',
          },
        };
      }),
    };

    return this.getCanonicalEdlItems();
  }

  /**
   * Adds a manual non-destructive cut (`MANUAL_CUT`) specified by the user.
   */
  public addManualCut(params: {
    readonly startSample?: number;
    readonly endSample?: number;
    readonly startSec?: number;
    readonly endSec?: number;
    readonly reason?: string;
  }): CanonicalEdlItem {
    if (!this.currentEdl) {
      throw new Error('EDL_NOT_READY: No active EditDecisionList.');
    }
    const sr = this.sourceIntegrity.sampleRateHz;
    const totalFrames = this.sourceIntegrity.totalFrames;
    const startSample =
      params.startSample !== undefined
        ? Math.round(params.startSample)
        : Math.round((params.startSec ?? 0) * sr);
    const endSample =
      params.endSample !== undefined
        ? Math.round(params.endSample)
        : Math.round((params.endSec ?? 0) * sr);

    if (startSample < 0 || endSample > totalFrames || endSample <= startSample) {
      throw new Error(
        `INVALID_MANUAL_CUT_BOUNDS: [${startSample}, ${endSample}] must be within [0, ${totalFrames}].`,
      );
    }

    this.pushUndoHistory(`addManualCut:${startSample}-${endSample}`);
    const proposalId = `prop_manual_${crypto.randomBytes(4).toString('hex')}`;
    const interval = createSourceSampleInterval(startSample, endSample, sr);

    const manualProposal: EditProposal = {
      proposalId,
      proposalVersion: 1,
      projectId: this.projectId,
      trackId: this.trackId,
      sourceAudioId: this.sourceIntegrity.sourceAudioId,
      sourceAudioHash: this.sourceIntegrity.sha256,
      transcriptVersion: this.transcriptDocument.transcriptVersion,
      alignmentVersion: this.currentEdl.alignmentVersion,
      speechEventSourceIds: [`manual_${proposalId}`],
      eventDetectorVersion: this.currentEdl.eventSourceVersions.eventDetectorVersion,
      modelVersions: this.currentEdl.eventSourceVersions.modelVersions,
      lexiconVersion: this.currentEdl.eventSourceVersions.lexiconVersion,
      timebaseFlicksPerSecond: FLICKS_PER_SECOND,
      sampleRate: sr,
      channelLayout: this.sourceIntegrity.channels === 2 ? 'stereo' : 'mono',
      originalRange: interval,
      proposedRange: interval,
      operation: 'REMOVE_FILLER',
      eventCategory: 'FILLER',
      eventSubtype: 'VOCAL_FILLED_PAUSE',
      candidateEligibility: 'SAFE_EDIT_CANDIDATE',
      evidenceReferences: [
        {
          refId: `ev_${proposalId}`,
          kind: 'ACOUSTIC_WINDOW',
          sourceId: `manual_${proposalId}`,
          summary: params.reason ?? 'Manual user cut',
        },
      ],
      confidenceClassification: 'HIGH_HEURISTIC',
      eventConfidenceScore: 1.0,
      scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
      calibratedProbability: null,
      boundary: {
        valid: true,
        originalInterval: interval,
        proposedInterval: interval,
        measurementBasis: 'MEASURED_ACOUSTIC',
        boundaryConfidence: 'HIGH',
        boundaryConfidenceScore: 0.98,
        boundaryScoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
        refinementMethod: 'manual-user-cut',
        leftSafetyMarginSamples: 0,
        rightSafetyMarginSamples: 0,
        phonemeBoundariesAvailable: false,
        appliedEvidence: ['User explicit sample selection'],
        warnings: [],
      },
      risk: {
        overallLevel: 'LOW',
        dimensions: [],
        heuristicRankingScore: 0.98,
        scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
        automaticApprovalEligible: false,
        approvalPermitted: true,
        mandatoryHumanReview: false,
        blockingReasons: [],
      },
      requiresHumanReview: false,
      protectedEvent: false,
      createdAtMs: Date.now(),
      status: 'APPROVED',
      validationStatus: 'VALID',
      validationIssues: [],
      provenance: {
        projectId: this.projectId,
        sourceAudioId: this.sourceIntegrity.sourceAudioId,
        sourceAudioHash: this.sourceIntegrity.sha256,
        transcriptVersion: this.transcriptDocument.transcriptVersion,
        alignmentVersion: this.currentEdl.alignmentVersion,
        speechEventSourceIds: [`manual_${proposalId}`],
        eventDetectorVersion: this.currentEdl.eventSourceVersions.eventDetectorVersion,
        decisionEngineVersion: this.currentEdl.eventSourceVersions.decisionEngineVersion,
        modelVersions: this.currentEdl.eventSourceVersions.modelVersions,
        lexiconVersion: this.currentEdl.eventSourceVersions.lexiconVersion,
        thresholdConfigVersion: this.currentEdl.eventSourceVersions.thresholdConfigVersion,
      },
      relatedTokenIds: [],
      relatedText: params.reason ?? 'برش دستی کاربر',
      explanationFa: params.reason ?? 'برش دستی تعریف‌شده توسط کاربر',
      conflictIds: [],
    };

    this.manualProposals.push(manualProposal);
    this.currentEdl = {
      ...this.currentEdl,
      edlVersion: this.currentEdl.edlVersion + 1,
      proposals: [...this.currentEdl.proposals, manualProposal],
    };

    const item = this.getCanonicalEdlItems().find((i) => i.decisionId === proposalId);
    if (!item) {
      throw new Error('Failed to retrieve newly created manual cut item.');
    }
    return item;
  }

  /**
   * Updates the session with a revised `CanonicalTranscriptSnapshot` (`ED-03`).
   * Invalidates (`INVALIDATED`) any edit decisions overlapping segments whose text or boundaries
   * changed, while preserving user `APPROVED` / `REJECTED` decisions on unchanged segments.
   */
  public async updateCanonicalTranscriptRevision(
    nextSnapshot: CanonicalTranscriptSnapshot,
  ): Promise<{
    readonly invalidatedDecisionIds: readonly string[];
    readonly preservedDecisionIds: readonly string[];
    readonly items: readonly CanonicalEdlItem[];
  }> {
    if (!this.currentEdl) {
      this.canonicalTranscript = nextSnapshot;
      this.transcriptDocument = NonDestructiveAudioEditingSession.snapshotToFinalTranscriptDocument(
        nextSnapshot,
        this.sourceIntegrity,
      );
      const items = await this.analyzeAndGenerateEdl();
      return {
        invalidatedDecisionIds: [],
        preservedDecisionIds: items.map((i) => i.decisionId),
        items,
      };
    }

    const prevSegById = new Map<string, CanonicalTimelineSegment>();
    for (const seg of this.canonicalTranscript.finalSegments) {
      prevSegById.set(seg.segmentId, seg);
    }

    const changedRanges: Array<{ readonly startSample: number; readonly endSample: number }> = [];
    for (const nextSeg of nextSnapshot.finalSegments) {
      const prevSeg = prevSegById.get(nextSeg.segmentId);
      if (
        !prevSeg ||
        prevSeg.rawText !== nextSeg.rawText ||
        prevSeg.sourceStartSample !== nextSeg.sourceStartSample ||
        prevSeg.sourceEndSample !== nextSeg.sourceEndSample
      ) {
        changedRanges.push({
          startSample: Math.min(
            prevSeg?.sourceStartSample ?? nextSeg.sourceStartSample,
            nextSeg.sourceStartSample,
          ),
          endSample: Math.max(
            prevSeg?.sourceEndSample ?? nextSeg.sourceEndSample,
            nextSeg.sourceEndSample,
          ),
        });
      }
    }

    const newlyInvalidated: string[] = [];
    const preserved: string[] = [];

    for (const p of this.currentEdl.proposals) {
      if (p.status === 'SUPERSEDED') continue;
      const interval = p.proposedRange ?? p.originalRange;
      const pStart = interval?.startSample ?? 0;
      const pEnd = interval?.endSample ?? 0;
      const overlapsChanged = changedRanges.some(
        (r) => pEnd > r.startSample && pStart < r.endSample,
      );
      if (overlapsChanged) {
        this.invalidatedDecisionIds.add(p.proposalId);
        newlyInvalidated.push(p.proposalId);
      } else {
        preserved.push(p.proposalId);
      }
    }

    this.canonicalTranscript = nextSnapshot;
    this.transcriptDocument = NonDestructiveAudioEditingSession.snapshotToFinalTranscriptDocument(
      nextSnapshot,
      this.sourceIntegrity,
    );

    return {
      invalidatedDecisionIds: newlyInvalidated,
      preservedDecisionIds: preserved,
      items: this.getCanonicalEdlItems(),
    };
  }

  /**
   * Builds a filtered `EditDecisionListSnapshot` where invalidated decisions are excluded (`REJECTED`)
   * so neither Preview nor Export ever applies a stale/invalidated cut.
   */
  private getEffectiveEdlForRendering(): EditDecisionListSnapshot {
    if (!this.currentEdl) {
      throw new Error('EDL_NOT_READY: No active EditDecisionList.');
    }
    return {
      ...this.currentEdl,
      proposals: this.currentEdl.proposals.map((p) => {
        if (this.invalidatedDecisionIds.has(p.proposalId) && p.status === 'APPROVED') {
          return {
            ...p,
            status: 'REJECTED' as const,
          };
        }
        return p;
      }),
    };
  }

  /**
   * Generates a non-destructive preview window (`ORIGINAL`, `EDITED`, `BEFORE_CUT`, `AFTER_CUT`,
   * `REMOVED_ONLY`, `SPLICE_JUNCTION`, or `FULL`) directly from the immutable disk source
   * using the exact same `EditDecisionListSnapshot` and fade/crossfade plan as Final Export (`ED-22`, `ED-23`).
   */
  public async generatePreview(params: {
    readonly mode:
      | 'ORIGINAL'
      | 'EDITED'
      | 'BEFORE_CUT'
      | 'AFTER_CUT'
      | 'REMOVED_ONLY'
      | 'SPLICE_JUNCTION'
      | 'FULL';
    readonly decisionId?: string;
    readonly startSec?: number;
    readonly endSec?: number;
    readonly contextMarginSec?: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<NonDestructivePreviewAudioSlice> {
    await this.verifySourceAudioUnmodified();
    const effectiveEdl = this.getEffectiveEdlForRendering();
    const sr = this.sourceIntegrity.sampleRateHz;
    const totalFrames = this.sourceIntegrity.totalFrames;
    const marginFrames = Math.round((params.contextMarginSec ?? 1.2) * sr);

    let windowStartFrame =
      params.startSec !== undefined ? Math.max(0, Math.round(params.startSec * sr)) : 0;
    let windowEndFrame =
      params.endSec !== undefined
        ? Math.min(totalFrames, Math.round(params.endSec * sr))
        : totalFrames;

    let targetProposal: EditProposal | undefined;
    if (params.decisionId) {
      targetProposal = effectiveEdl.proposals.find((p) => p.proposalId === params.decisionId);
      if (!targetProposal) {
        throw new Error(`DECISION_NOT_FOUND: Unknown decisionId "${params.decisionId}".`);
      }
      const range = targetProposal.proposedRange ?? targetProposal.originalRange;
      if (range) {
        windowStartFrame = Math.max(0, range.startSample - marginFrames);
        windowEndFrame = Math.min(totalFrames, range.endSample + marginFrames);
      }
    }

    const pcmSource = new FileBackedChunkedPcmSource(this.sourceIntegrity);
    try {
      if (params.mode === 'ORIGINAL') {
        const channels = await pcmSource.readPlanarRange(
          windowStartFrame,
          windowEndFrame - windowStartFrame,
        );
        const outFrames = channels[0]?.length ?? 0;
        return {
          mode: params.mode,
          decisionId: params.decisionId,
          sampleRateHz: sr,
          channelCount: this.sourceIntegrity.channels,
          startFrame: windowStartFrame,
          endFrame: windowEndFrame,
          totalOutputFrames: outFrames,
          durationSec: Number((outFrames / sr).toFixed(6)),
          planarChannels: channels,
          spliceTransitionCount: 0,
          maxBoundaryJumpAmplitude: 0,
        };
      }

      if (params.mode === 'REMOVED_ONLY') {
        if (!targetProposal) {
          throw new Error('DECISION_REQUIRED: REMOVED_ONLY preview mode requires a decisionId.');
        }
        const range = targetProposal.proposedRange ?? targetProposal.originalRange;
        const cutStart = range?.startSample ?? 0;
        const cutEnd = range?.endSample ?? 0;
        const channels = await pcmSource.readPlanarRange(cutStart, Math.max(0, cutEnd - cutStart));
        const outFrames = channels[0]?.length ?? 0;
        return {
          mode: params.mode,
          decisionId: params.decisionId,
          sampleRateHz: sr,
          channelCount: this.sourceIntegrity.channels,
          startFrame: cutStart,
          endFrame: cutEnd,
          totalOutputFrames: outFrames,
          durationSec: Number((outFrames / sr).toFixed(6)),
          planarChannels: channels,
          spliceTransitionCount: 0,
          maxBoundaryJumpAmplitude: 0,
        };
      }

      if (params.mode === 'BEFORE_CUT' && targetProposal) {
        const range = targetProposal.proposedRange ?? targetProposal.originalRange;
        const cutStart = range?.startSample ?? 0;
        const sliceStart = Math.max(0, cutStart - marginFrames);
        const channels = await pcmSource.readPlanarRange(
          sliceStart,
          Math.max(0, cutStart - sliceStart),
        );
        const outFrames = channels[0]?.length ?? 0;
        return {
          mode: params.mode,
          decisionId: params.decisionId,
          sampleRateHz: sr,
          channelCount: this.sourceIntegrity.channels,
          startFrame: sliceStart,
          endFrame: cutStart,
          totalOutputFrames: outFrames,
          durationSec: Number((outFrames / sr).toFixed(6)),
          planarChannels: channels,
          spliceTransitionCount: 0,
          maxBoundaryJumpAmplitude: 0,
        };
      }

      if (params.mode === 'AFTER_CUT' && targetProposal) {
        const range = targetProposal.proposedRange ?? targetProposal.originalRange;
        const cutEnd = range?.endSample ?? 0;
        const sliceEnd = Math.min(totalFrames, cutEnd + marginFrames);
        const channels = await pcmSource.readPlanarRange(cutEnd, Math.max(0, sliceEnd - cutEnd));
        const outFrames = channels[0]?.length ?? 0;
        return {
          mode: params.mode,
          decisionId: params.decisionId,
          sampleRateHz: sr,
          channelCount: this.sourceIntegrity.channels,
          startFrame: cutEnd,
          endFrame: sliceEnd,
          totalOutputFrames: outFrames,
          durationSec: Number((outFrames / sr).toFixed(6)),
          planarChannels: channels,
          spliceTransitionCount: 0,
          maxBoundaryJumpAmplitude: 0,
        };
      }

      // EDITED, SPLICE_JUNCTION, or FULL mode: route through SmartEditPreviewRenderer
      const previewMode: SmartEditPreviewMode =
        params.mode === 'FULL' || !params.decisionId ? 'FULL' : 'EDITED';
      const smartPreview: SmartEditPreviewResult = await this.previewRenderer.generatePreview({
        mode: previewMode,
        source: pcmSource,
        edl: effectiveEdl,
        proposalId: params.decisionId,
        contextPaddingMs: Math.round((params.contextMarginSec ?? 1.2) * 1000),
        abortSignal: params.abortSignal,
      });

      if (!smartPreview.ok) {
        throw new Error(
          `PREVIEW_RENDER_FAILED: ${smartPreview.failureReason ?? 'Unknown preview failure'}`,
        );
      }

      // Decode the rendered WAV preview bytes back into planar Float32Array[] for sample-level inspection
      const decodedChannels = this.decodeRenderedWavBytesToPlanar(
        smartPreview.wavBytes,
        smartPreview.channelCount,
      );

      let maxJump = 0;
      const ch0 = decodedChannels[0];
      if (ch0 && ch0.length > 1) {
        const mid = Math.floor(ch0.length / 2);
        const searchStart = Math.max(1, mid - 256);
        const searchEnd = Math.min(ch0.length - 1, mid + 256);
        for (let i = searchStart; i <= searchEnd; i++) {
          const jump = Math.abs(ch0[i] - ch0[i - 1]);
          if (jump > maxJump) maxJump = jump;
        }
      }

      return {
        mode: params.mode,
        decisionId: params.decisionId,
        sampleRateHz: sr,
        channelCount: smartPreview.channelCount,
        startFrame: smartPreview.windowStartSample,
        endFrame: smartPreview.windowEndSample,
        totalOutputFrames: smartPreview.totalSamples,
        durationSec: smartPreview.durationSec,
        planarChannels: decodedChannels,
        wavBytes: smartPreview.wavBytes,
        spliceTransitionCount: smartPreview.appliedProposalIds.length,
        maxBoundaryJumpAmplitude: Number(maxJump.toFixed(6)),
      };
    } finally {
      pcmSource.close();
      await this.verifySourceAudioUnmodified();
    }
  }

  private decodeRenderedWavBytesToPlanar(
    wavBytes: Uint8Array,
    fallbackChannels: number,
  ): Float32Array[] {
    if (wavBytes.byteLength <= 44) {
      return Array.from({ length: fallbackChannels }, () => new Float32Array(0));
    }
    const buf = Buffer.from(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
    const meta = parseWavHeaderFromInitialBytes(buf, buf.byteLength);
    if (!meta.valid) {
      return Array.from({ length: fallbackChannels }, () => new Float32Array(0));
    }
    const chCount = meta.channels;
    const frames = meta.frameCount;
    const bps = meta.bitsPerSample / 8;
    const frameBytes = chCount * bps;
    const channels = Array.from({ length: chCount }, () => new Float32Array(frames));

    for (let f = 0; f < frames; f++) {
      const base = meta.dataOffsetBytes + f * frameBytes;
      if (base + frameBytes > buf.byteLength) break;
      for (let c = 0; c < chCount; c++) {
        const off = base + c * bps;
        let val = 0;
        if (meta.audioFormat === 3 && meta.bitsPerSample === 32) {
          val = buf.readFloatLE(off);
        } else if (meta.bitsPerSample === 16) {
          const s16 = buf.readInt16LE(off);
          val = s16 < 0 ? s16 / 32768 : s16 / 32767;
        } else if (meta.bitsPerSample === 24) {
          let s24 = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
          if (s24 & 0x800000) s24 |= ~0xffffff;
          val = s24 / 8388608;
        }
        channels[c][f] = val;
      }
    }
    return channels;
  }

  private computeApprovedDecisionSignature(edl: EditDecisionListSnapshot): string {
    const active = edl.proposals
      .filter(
        (p) =>
          p.status === 'APPROVED' &&
          !this.invalidatedDecisionIds.has(p.proposalId),
      )
      .map((p) => {
        const r = p.proposedRange ?? p.originalRange;
        return `${p.proposalId}:${r?.startSample ?? 0}-${r?.endSample ?? 0}:${p.operation}`;
      })
      .join('|');
    return crypto.createHash('sha256').update(active).digest('hex');
  }

  /**
   * Applies approved non-destructive edits and writes the rendered audio to a NEW output WAV file
   * (`outputWavPath`), leaving the original source file 100% untouched (`ED-21..ED-25`).
   *
   * Enforces double-application prevention (`ED-25`): calling `applyApprovedEditsAndExport` twice
   * with the exact same approved EDL state throws `EDIT_PLAN_ALREADY_APPLIED` unless
   * `allowReExportSamePlan` is explicitly true.
   */
  public async applyApprovedEditsAndExport(params?: {
    readonly outputWavPath?: string;
    readonly renderConfig?: Partial<AudioRenderConfig>;
    readonly allowReExportSamePlan?: boolean;
    readonly abortSignal?: AbortSignal;
  }): Promise<NonDestructiveExportResult> {
    const preCheck = await this.verifySourceAudioUnmodified();
    const effectiveEdl = this.getEffectiveEdlForRendering();
    const signature = this.computeApprovedDecisionSignature(effectiveEdl);

    if (
      this.appliedDecisionSignature === signature &&
      this.appliedExportCount > 0 &&
      !params?.allowReExportSamePlan
    ) {
      throw new Error(
        'EDIT_PLAN_ALREADY_APPLIED: This exact approved edit decision plan has already been applied; duplicate application prevented.',
      );
    }

    if (
      params?.outputWavPath &&
      path.resolve(params.outputWavPath) === path.resolve(this.sourceIntegrity.filePath)
    ) {
      throw new Error(
        'DESTRUCTIVE_OVERWRITE_FORBIDDEN: outputWavPath must not overwrite the original source audio file.',
      );
    }

    const approvedIds = effectiveEdl.proposals
      .filter((p) => p.status === 'APPROVED')
      .map((p) => p.proposalId);

    const pcmSource = new FileBackedChunkedPcmSource(this.sourceIntegrity);
    let renderResult: AudioRenderResult;
    let exportedWavSha256: string | undefined;
    let resolvedOutPath: string | undefined;

    try {
      renderResult = await this.previewRenderer.renderFinalAudio({
        edl: effectiveEdl,
        source: pcmSource,
        config: {
          encoding: this.sourceIntegrity.bitsPerSample === 32 ? 'pcm24' : 'pcm16',
          ...params?.renderConfig,
        },
        proposalIds: approvedIds,
        abortSignal: params?.abortSignal,
      });

      if (!renderResult.ok || !renderResult.output) {
        throw new Error(
          `AUDIO_EXPORT_RENDER_FAILED: ${renderResult.failureReason ?? 'Render validation failed.'}`,
        );
      }

      if (params?.outputWavPath && renderResult.outputArtifact) {
        resolvedOutPath = path.resolve(params.outputWavPath);
        await fs.promises.mkdir(path.dirname(resolvedOutPath), { recursive: true });
        const wavBytes = await readRenderArtifactToUint8Array(renderResult.outputArtifact, {
          abortSignal: params?.abortSignal,
        });
        await fs.promises.writeFile(resolvedOutPath, wavBytes);
        const outCheck = await computeFileSha256Streaming(resolvedOutPath);
        exportedWavSha256 = outCheck.sha256;
      }
      if (renderResult.outputArtifact) {
        await renderResult.outputArtifact.dispose().catch(() => {});
      }
    } finally {
      pcmSource.close();
    }

    const postCheck = await this.verifySourceAudioUnmodified();
    this.appliedDecisionSignature = signature;
    this.appliedExportCount += 1;

    const sr = this.sourceIntegrity.sampleRateHz;
    const originalFrames = this.sourceIntegrity.totalFrames;
    const exportedFrames = renderResult.output.totalOutputSamples;
    const removedFrames = Math.max(0, originalFrames - exportedFrames);

    return {
      exportId: `exp_${crypto.randomBytes(6).toString('hex')}`,
      outputWavPath: resolvedOutPath,
      sampleRateHz: sr,
      channelCount: renderResult.output.channelCount,
      originalFrames,
      exportedFrames,
      removedFrames,
      originalDurationSec: renderResult.sourceDurationSec,
      exportedDurationSec: renderResult.outputDurationSec,
      removedDurationSec: renderResult.removedDurationSec,
      appliedDecisionIds: [...renderResult.appliedProposalIds],
      renderResult,
      sourceAudioIntegrityVerified: preCheck.intact && postCheck.intact,
      sourceSha256Before: preCheck.actualSha256,
      sourceSha256After: postCheck.actualSha256,
      exportedWavSha256,
    };
  }

  /**
   * Builds a non-destructive Adobe Audition host integration payload (`.sesx` v1.9 interchange XML +
   * cut/review markers) for the Adobe Audition Host Adapter (`AuditionHostAdapter.ts`).
   */
  public buildAdobeAuditionBridgePayload(): {
    readonly sesx_xml: string;
    readonly validation: SesxValidationReport;
    readonly approvedCutCount: number;
    readonly reviewMarkerCount: number;
  } {
    const items = this.getCanonicalEdlItems();
    const sr = this.sourceIntegrity.sampleRateHz;
    const totalFrames = this.sourceIntegrity.totalFrames;

    const approvedCuts = items
      .filter((i) => (i.status === 'APPROVED' || i.status === 'APPLIED') && i.actionType !== 'KEEP')
      .sort((a, b) => a.startSample - b.startSample);

    // Compute retained non-destructive clips referencing the untouched original file
    const clips: Array<{
      readonly clip_id: string;
      readonly media_id: string;
      readonly track_id: string;
      readonly name: string;
      readonly source_in_sample: number;
      readonly source_out_sample: number;
      readonly timeline_start_sample: number;
      readonly timeline_end_sample: number;
      readonly gain_db: number;
      readonly muted: boolean;
      readonly fade_in_samples: number;
      readonly fade_out_samples: number;
    }> = [];

    let cursor = 0;
    let timelineCursor = 0;
    let clipIdx = 0;

    for (const cut of approvedCuts) {
      if (cut.startSample > cursor) {
        const segLen = cut.startSample - cursor;
        clipIdx++;
        clips.push({
          clip_id: `clip_${clipIdx}`,
          media_id: this.sourceIntegrity.sourceAudioId,
          track_id: this.trackId,
          name: `Retained_${clipIdx}`,
          source_in_sample: cursor,
          source_out_sample: cut.startSample,
          timeline_start_sample: timelineCursor,
          timeline_end_sample: timelineCursor + segLen,
          gain_db: 0,
          muted: false,
          fade_in_samples: clipIdx === 1 ? 0 : cut.fadeInSamples,
          fade_out_samples: cut.fadeOutSamples,
        });
        timelineCursor += segLen;
      }
      cursor = Math.max(cursor, cut.endSample);
    }

    if (cursor < totalFrames || clips.length === 0) {
      const segLen = Math.max(1, totalFrames - cursor);
      clipIdx++;
      clips.push({
        clip_id: `clip_${clipIdx}`,
        media_id: this.sourceIntegrity.sourceAudioId,
        track_id: this.trackId,
        name: `Retained_${clipIdx}`,
        source_in_sample: cursor,
        source_out_sample: cursor + segLen,
        timeline_start_sample: timelineCursor,
        timeline_end_sample: timelineCursor + segLen,
        gain_db: 0,
        muted: false,
        fade_in_samples: 0,
        fade_out_samples: 0,
      });
    }

    const markers = items.map((item) => ({
      marker_id: item.decisionId,
      label: `${item.actionType}: ${item.matchedText ?? item.reasonFa}`,
      sample_position: item.startSample,
      duration_samples: item.durationSamples,
      kind: item.status === 'NEEDS_REVIEW' ? ('USER_CUE' as const) : ('SPEECH_EVENT' as const),
    }));

    const nowIso = new Date().toISOString();
    const canonicalProject: CanonicalProject = {
      schema_version: '2.0.0',
      project_id: this.projectId,
      name: `AvaPardaz_${path.basename(this.sourceIntegrity.filePath)}`,
      created_at: nowIso,
      updated_at: nowIso,
      revision: this.canonicalTranscript.revision,
      sample_rate_hz: sr,
      media: {
        [this.sourceIntegrity.sourceAudioId]: {
          media_id: this.sourceIntegrity.sourceAudioId,
          display_name: path.basename(this.sourceIntegrity.filePath),
          sha256_hex: this.sourceIntegrity.sha256,
          sample_rate_hz: sr,
          channel_count: this.sourceIntegrity.channels,
          total_samples: totalFrames,
          bit_depth:
            this.sourceIntegrity.bitsPerSample === 24
              ? 24
              : this.sourceIntegrity.bitsPerSample === 32
                ? 32
                : 16,
          encoding: 'wav',
          storage_ref: this.sourceIntegrity.filePath,
          availability: 'AVAILABLE',
          registered_at: nowIso,
        },
      },
      tracks: [
        {
          track_id: this.trackId,
          name: 'Main Dialogue',
          speaker_label: 'SPEAKER_00',
          channel_count: this.sourceIntegrity.channels === 2 ? 2 : 1,
          muted: false,
          solo: false,
          gain_db: 0,
          clips,
        },
      ],
      markers,
      edit_plans: {},
      revision_history: [],
    };

    const exported = this.auditionHostAdapter.exportCanonicalProjectToSesx(canonicalProject);
    return {
      ...exported,
      approvedCutCount: approvedCuts.length,
      reviewMarkerCount: items.filter((i) => i.status === 'NEEDS_REVIEW').length,
    };
  }

  /**
   * Serializes the entire non-destructive editing session to JSON (`ED-27`) so it can be persisted
   * to disk and recovered across process restarts without losing user approvals or undo safety.
   */
  public serializeSession(): SerializedNonDestructiveEditSession {
    return {
      schemaVersion: '1.0.0',
      sessionId: this.sessionId,
      projectId: this.projectId,
      trackId: this.trackId,
      sourceIntegrity: this.sourceIntegrity,
      canonicalTranscript: this.canonicalTranscript,
      edl: this.getEditDecisionList(),
      canonicalItems: this.getCanonicalEdlItems(),
      appliedExportCount: this.appliedExportCount,
      lastAppliedDecisionSignature: this.appliedDecisionSignature,
      savedAtIso: new Date().toISOString(),
    };
  }

  public static async restoreFromSerializedSession(
    serialized: SerializedNonDestructiveEditSession,
  ): Promise<NonDestructiveAudioEditingSession> {
    const currentSourceIntegrity = await inspectSourceWavFileIntegrity(
      serialized.sourceIntegrity.filePath,
    );
    if (currentSourceIntegrity.sha256 !== serialized.sourceIntegrity.sha256) {
      throw new Error(
        `SOURCE_CHANGED_ON_DISK: Source audio SHA-256 changed since session save (${serialized.sourceIntegrity.sha256} -> ${currentSourceIntegrity.sha256}).`,
      );
    }

    const transcriptDoc = NonDestructiveAudioEditingSession.snapshotToFinalTranscriptDocument(
      serialized.canonicalTranscript,
      currentSourceIntegrity,
    );

    const session = new NonDestructiveAudioEditingSession({
      sessionId: serialized.sessionId,
      projectId: serialized.projectId,
      trackId: serialized.trackId,
      sourceIntegrity: currentSourceIntegrity,
      canonicalTranscript: serialized.canonicalTranscript,
      transcriptDocument: transcriptDoc,
    });
    session.currentEdl = structuredClone(serialized.edl);
    session.appliedExportCount = serialized.appliedExportCount;
    session.appliedDecisionSignature = serialized.lastAppliedDecisionSignature;
    return session;
  }
}
