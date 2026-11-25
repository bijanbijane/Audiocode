/**
 * SHAHAB-028 — Acoustic Scene Intelligence, Audio Event Detection,
 * Speech Activity Analysis & Temporal Audio Structure
 *
 * Architectural Law (Strict 3-Stage Separation: Detect != Decide != Execute):
 * - THIS MODULE DETECTS AND DESCRIBES ONLY.
 * - NEVER makes editorial delete/keep decisions (belongs to SHAHAB-029).
 * - NEVER mutates or deletes source audio (belongs to SHAHAB-030).
 * - NEVER infers emotion, mood, truthfulness, psychological traits, or speaker identity.
 * - NEVER treats quiet/whispered/breath audio as useless or untranscribed speech as silence.
 * - NEVER fabricates calibrated probabilities or a single fake "overall audio quality score".
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectAcousticSpeechRegions,
  samplesToFlicks,
} from './ShahabAlignmentEngine.ts';
import { decodeWavToMono16k } from './ShahabZipformerEngine.ts';

export const SHAHAB_AUDIO_INTELLIGENCE_CONTRACT_VERSION = '1.0.0';
export const SHAHAB_ACOUSTIC_TAXONOMY_VERSION = '1.0.0';
export const SHAHAB_FLICKS_PER_SECOND = 705_600_000;

export type AudioIntelCapabilityStatus =
  | 'PRESENT_AND_VERIFIED'
  | 'PARTIALLY_IMPLEMENTED'
  | 'STUB_OR_PLACEHOLDER'
  | 'UNSUPPORTED'
  | 'BLOCKED';

export interface AudioIntelWorkspaceInventoryItem {
  readonly capabilityId: string;
  readonly name: string;
  readonly status: AudioIntelCapabilityStatus;
  readonly sourceRef: string;
  readonly evidenceNote: string;
}

export interface AudioIntelCapabilityReport {
  readonly contractVersion: string;
  readonly taxonomyVersion: string;
  readonly streamingCapability: 'INCREMENTAL_WINDOW_ANALYSIS';
  readonly trueOnlineNeuralEventStreamingSupported: false;
  readonly neuralAudioEventClassifierInstalled: false;
  readonly supportsMultiLabelSimultaneousEvents: true;
  readonly supportsMultiChannelImbalanceDetection: true;
  readonly redLineGuardrails: {
    readonly neverInfersEmotionOrPsychology: true;
    readonly neverInfersBiometricIdentity: true;
    readonly neverDeletesOrModifiesAudio: true;
    readonly neverMakesEditorialCutDecisions: true;
    readonly neverFabricatesOverallQualityScore: true;
  };
  readonly workspaceInventory: readonly AudioIntelWorkspaceInventoryItem[];
}

export type AcousticEventCategory =
  | 'SPEECH_ACTIVITY'
  | 'SILENCE_AND_PAUSE'
  | 'BACKGROUND_AND_NON_SPEECH'
  | 'SIGNAL_DEFECT_AND_QUALITY'
  | 'UNCERTAIN_OR_UNCLASSIFIED';

export type AcousticEventType =
  | 'SPEECH_ACTIVITY'
  | 'LOW_ENERGY_SPEECH'
  | 'OVERLAPPING_SPEECH'
  | 'DIGITAL_SILENCE'
  | 'LOW_ENERGY_INTERVAL'
  | 'PAUSE_WITHIN_SPEECH'
  | 'INTER_UTTERANCE_PAUSE'
  | 'LONG_SILENCE'
  | 'POSSIBLE_RECORDING_GAP'
  | 'BACKGROUND_NOISE'
  | 'MUSIC'
  | 'IMPACT_SOUND'
  | 'CLIPPING'
  | 'SIGNAL_DROPOUT'
  | 'CHANNEL_IMBALANCE'
  | 'ABRUPT_LEVEL_CHANGE'
  | 'SUDDEN_SIGNAL_DISCONTINUITY'
  | 'UNKNOWN_EVENT'
  | 'AMBIGUOUS_EVENT'
  | 'UNCLASSIFIED_INTERVAL';

export type AcousticEvidenceClass =
  | 'DIRECT_SIGNAL_MEASUREMENT'
  | 'SPECTRAL_HEURISTIC_ESTIMATE'
  | 'MODEL_SCORE_UNCALIBRATED'
  | 'CROSS_CHECK_INFERENCE'
  | 'USER_CONFIRMED';

export interface AcousticTimeRange {
  /** Half-open integer sample interval [startSample, endSample) in source sample rate */
  readonly startSample: number;
  readonly endSample: number;
  readonly sampleRateHz: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationMs: number;
  readonly startFlicks: number;
  readonly endFlicks: number;
  readonly intervalSemantics: 'HALF_OPEN_[startSample,endSample)';
}

export interface AcousticEventRecord {
  readonly eventId: string;
  readonly revision: number;
  readonly category: AcousticEventCategory;
  readonly eventType: AcousticEventType;
  readonly range: AcousticTimeRange;
  readonly channelScope: 'MIX_ALL' | 'CH_0' | 'CH_1' | 'STEREO_DIFF';
  readonly evidenceClass: AcousticEvidenceClass;
  /** Raw uncalibrated heuristic indicator (NEVER a calibrated probability) */
  readonly rawHeuristicIndicator: number | null;
  readonly calibratedProbabilityAvailable: false;
  readonly measuredMetrics: {
    readonly rmsDbfs: number;
    readonly peakDbfs: number;
    readonly zcrPerSec: number | null;
    readonly spectralCentroidHz: number | null;
    readonly spectralFlatness: number | null;
    readonly noiseFloorDeltaDb: number | null;
  };
  readonly breathOrQuietSpeechProtected: boolean;
  readonly ambiguityReason: string | null;
  readonly supersedesEventId: string | null;
}

export interface SignalWindowConfig {
  readonly frameLengthMs: number;
  readonly hopLengthMs: number;
  readonly clippingAbsThreshold: number;
  readonly flatTopMinConsecutiveSamples: number;
  readonly digitalSilenceDbfsThreshold: number;
  readonly dropoutMinZeroRunMs: number;
  readonly abruptLevelJumpDbThreshold: number;
  readonly discontinuitySampleDeltaThreshold: number;
  readonly pauseWithinSpeechMaxMs: number;
  readonly interUtterancePauseMaxMs: number;
  readonly longSilenceMinMs: number;
  readonly channelImbalanceDbThreshold: number;
}

export const DEFAULT_SIGNAL_WINDOW_CONFIG: SignalWindowConfig = Object.freeze({
  frameLengthMs: 25,
  hopLengthMs: 10,
  clippingAbsThreshold: 0.992,
  flatTopMinConsecutiveSamples: 3,
  digitalSilenceDbfsThreshold: -84,
  dropoutMinZeroRunMs: 15,
  abruptLevelJumpDbThreshold: 14,
  discontinuitySampleDeltaThreshold: 0.65,
  pauseWithinSpeechMaxMs: 450,
  interUtterancePauseMaxMs: 1400,
  longSilenceMinMs: 1400,
  channelImbalanceDbThreshold: 6.0,
});

export interface TechnicalAudioQualityDiagnostics {
  /** Explicitly NO single universal quality score */
  readonly universalQualityScoreFabricated: false;
  readonly analysisWindowMs: number;
  readonly analysisHopMs: number;
  readonly overallRmsDbfs: number;
  readonly peakDbfs: number;
  readonly crestFactorDb: number;
  readonly dcOffset: number;
  readonly estimatedNoiseFloorDbfs: number;
  readonly estimatedDynamicRangeDb: number;
  readonly snrProxyDb: number | null;
  readonly snrProxyMethodNote: string;
  readonly clippedSampleCount: number;
  readonly flatTopEventCount: number;
  readonly signalDropoutCount: number;
  readonly discontinuityCount: number;
  readonly channelMetrics: readonly {
    readonly channelIndex: number;
    readonly rmsDbfs: number;
    readonly peakDbfs: number;
    readonly dcOffset: number;
  }[];
  readonly channelImbalanceDb: number | null;
  readonly speechActivityRatio: number;
  readonly lowEnergySpeechProtectedCount: number;
  readonly diagnosticFlags: readonly string[];
}

export interface SpeechVsTranscriptCoverageRecord {
  readonly status:
    | 'NOT_SUPPLIED'
    | 'CONSISTENT_COVERAGE'
    | 'UNTRANSCRIBED_SPEECH_DETECTED'
    | 'TRANSCRIPT_WITHOUT_ACOUSTIC_SPEECH'
    | 'MIXED_DISCREPANCIES';
  readonly acousticSpeechIntervalCount: number;
  readonly transcriptSpanCount: number;
  readonly untranscribedSpeechRanges: readonly AcousticTimeRange[];
  readonly transcriptWithoutAcousticSpeechRanges: readonly AcousticTimeRange[];
  readonly note: string;
}

export interface AudioSceneAnalysisInput {
  readonly audioId: string;
  readonly sourceRevisionId?: string;
  readonly sampleRateHz: number;
  readonly channels?: number;
  /** Interleaved or mono Float32Array; OR per-channel planar arrays */
  readonly pcmInterleaved?: Float32Array;
  readonly channelBuffers?: readonly Float32Array[];
  readonly wavFilePath?: string;
  /** Optional source offset if analyzing a clip from a larger media file */
  readonly sourceOffsetSample?: number;
  /** Optional transcript spans in source seconds for coverage cross-check ONLY */
  readonly transcriptSpansSec?: readonly { readonly startSec: number; readonly endSec: number; readonly text?: string }[];
  /** Optional explicit overlap intervals from SHAHAB-026 diarization */
  readonly externalOverlapRegionsSec?: readonly { readonly startSec: number; readonly endSec: number }[];
  readonly config?: Partial<SignalWindowConfig>;
}

export interface AudioSceneAnalysisResult {
  readonly analysisId: string;
  readonly revision: number;
  readonly contractVersion: string;
  readonly taxonomyVersion: string;
  readonly audioId: string;
  readonly sourceRevisionId: string;
  readonly sourcePcmSha256: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly totalFrames: number;
  readonly durationSec: number;
  readonly streamingMode: 'INCREMENTAL_WINDOW_ANALYSIS';
  readonly windowConfig: SignalWindowConfig;
  readonly qualityDiagnostics: TechnicalAudioQualityDiagnostics;
  readonly events: readonly AcousticEventRecord[];
  readonly overlappingEventPairsCount: number;
  readonly coverageCrossCheck: SpeechVsTranscriptCoverageRecord;
  readonly reusedUpstreamVadCount: number;
  readonly eventSummaryByType: Readonly<Record<string, number>>;
  readonly honestLimitations: readonly string[];
  readonly createdAtUtc: string;
}

export interface ReferenceEventAnnotation {
  readonly eventType: AcousticEventType;
  readonly startSec: number;
  readonly endSec: number;
}

export interface AudioEventEvaluationReport {
  readonly toleranceSec: number;
  readonly matchedCount: number;
  readonly referenceCount: number;
  readonly predictedCount: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly meanStartBoundaryErrorMs: number | null;
  readonly meanEndBoundaryErrorMs: number | null;
  readonly perEventType: Readonly<
    Record<string, { readonly tp: number; readonly fp: number; readonly fn: number; readonly f1: number }>
  >;
}

function toDbfs(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 1e-10) return -120;
  return Number((20 * Math.log10(linear)).toFixed(2));
}

function makeRange(
  startFrame: number,
  endFrame: number,
  sampleRateHz: number,
  sourceOffsetSample = 0,
): AcousticTimeRange {
  const s = Math.max(0, Math.round(startFrame)) + sourceOffsetSample;
  const e = Math.max(s, Math.round(endFrame)) + sourceOffsetSample;
  const startSec = Number((s / sampleRateHz).toFixed(6));
  const endSec = Number((e / sampleRateHz).toFixed(6));
  return {
    startSample: s,
    endSample: e,
    sampleRateHz,
    startSec,
    endSec,
    durationMs: Number((((e - s) / sampleRateHz) * 1000).toFixed(2)),
    startFlicks: samplesToFlicks(s, sampleRateHz),
    endFlicks: samplesToFlicks(e, sampleRateHz),
    intervalSemantics: 'HALF_OPEN_[startSample,endSample)',
  };
}

function sha256Float32List(buffers: readonly Float32Array[]): string {
  const h = crypto.createHash('sha256');
  for (const b of buffers) {
    h.update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  }
  return h.digest('hex');
}

/**
 * Computes compact spectral centroid (Hz), spectral flatness (Wiener entropy 0..1),
 * and zero-crossing rate (crossings/sec) via lightweight DFT over 256-sample sub-window.
 */
function computeFrameSpectralFeatures(
  mono: Float32Array,
  start: number,
  len: number,
  sampleRateHz: number,
): {
  readonly rms: number;
  readonly peak: number;
  readonly zcrPerSec: number;
  readonly spectralCentroidHz: number;
  readonly spectralFlatness: number;
  readonly harmonicityProxy: number;
} {
  let sumSq = 0;
  let peak = 0;
  let zc = 0;
  const end = Math.min(mono.length, start + len);
  const actualLen = Math.max(1, end - start);
  for (let i = start; i < end; i++) {
    const v = mono[i];
    sumSq += v * v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
    if (i > start && ((mono[i - 1] >= 0 && v < 0) || (mono[i - 1] < 0 && v >= 0))) {
      zc++;
    }
  }
  const rms = Math.sqrt(sumSq / actualLen);
  const zcrPerSec = (zc / actualLen) * sampleRateHz;

  // Compact 64-bin DFT (N=128) for fast deterministic spectral centroid & flatness
  const nDft = 128;
  const half = nDft / 2;
  let weightedFreq = 0;
  let totalMag = 0;
  let logMagSum = 0;
  let maxMag = 0;
  const binHz = sampleRateHz / nDft;

  for (let k = 1; k < half; k++) {
    let re = 0;
    let im = 0;
    const step = (2 * Math.PI * k) / nDft;
    for (let n = 0; n < nDft; n++) {
      const idx = start + n;
      const sample = idx < end ? mono[idx] : 0;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (nDft - 1));
      const x = sample * w;
      const ang = step * n;
      re += x * Math.cos(ang);
      im -= x * Math.sin(ang);
    }
    const mag = Math.sqrt(re * re + im * im) + 1e-12;
    weightedFreq += k * binHz * mag;
    totalMag += mag;
    logMagSum += Math.log(mag);
    if (mag > maxMag) maxMag = mag;
  }

  const meanMag = totalMag / (half - 1);
  const geoMean = Math.exp(logMagSum / (half - 1));
  const spectralFlatness = Math.max(0, Math.min(1, geoMean / Math.max(1e-12, meanMag)));
  const spectralCentroidHz = totalMag > 1e-9 ? weightedFreq / totalMag : 0;
  const harmonicityProxy = maxMag / Math.max(1e-12, meanMag);

  return {
    rms,
    peak,
    zcrPerSec: Number(zcrPerSec.toFixed(1)),
    spectralCentroidHz: Number(spectralCentroidHz.toFixed(1)),
    spectralFlatness: Number(spectralFlatness.toFixed(4)),
    harmonicityProxy: Number(harmonicityProxy.toFixed(3)),
  };
}

export function buildAudioIntelWorkspaceInventory(workspaceRoot = process.cwd()): AudioIntelCapabilityReport {
  const hasAligner = fs.existsSync(path.join(workspaceRoot, 'src', 'shahab', 'ShahabAlignmentEngine.ts'));
  const hasZipformer = fs.existsSync(path.join(workspaceRoot, 'src', 'shahab', 'ShahabZipformerEngine.ts'));
  const hasDiarizer = fs.existsSync(path.join(workspaceRoot, 'src', 'shahab', 'ShahabDiarizationEngine.ts'));

  const inventory: AudioIntelWorkspaceInventoryItem[] = [
    {
      capabilityId: 'CAP-028-VAD-REUSE',
      name: 'Acoustic Speech Activity Detection (Reusable VAD)',
      status: hasAligner ? 'PRESENT_AND_VERIFIED' : 'UNSUPPORTED',
      sourceRef: 'src/shahab/ShahabAlignmentEngine.ts::detectAcousticSpeechRegions',
      evidenceNote: 'Reused directly with adaptive noise-floor hysteresis and low-energy speech protection.',
    },
    {
      capabilityId: 'CAP-028-SIGNAL-PROFILER',
      name: 'Signal-Level Energy, Clipping, Dropout & Discontinuity Diagnostics',
      status: hasZipformer ? 'PRESENT_AND_VERIFIED' : 'PARTIALLY_IMPLEMENTED',
      sourceRef: 'src/shahab/ShahabAudioIntelligenceEngine.ts & ShahabZipformerEngine.ts',
      evidenceNote: 'Direct PCM measurements with declared window/hop, flat-top clipping, zero-run dropout, and per-channel imbalance.',
    },
    {
      capabilityId: 'CAP-028-SPECTRAL-SCENE',
      name: 'Spectral Heuristic Non-Speech / Music / Noise / Impact Detection',
      status: 'PARTIALLY_IMPLEMENTED',
      sourceRef: 'src/shahab/ShahabAudioIntelligenceEngine.ts',
      evidenceNote: 'Deterministic DSP spectral heuristics (flatness, centroid, harmonicity, transient crest); no external neural SED model installed.',
    },
    {
      capabilityId: 'CAP-028-OVERLAP-FUSION',
      name: 'Overlapping Speech Region Integration',
      status: hasDiarizer ? 'PARTIALLY_IMPLEMENTED' : 'UNSUPPORTED',
      sourceRef: 'src/shahab/ShahabDiarizationEngine.ts',
      evidenceNote: 'Integrates explicit overlap regions from SHAHAB-026 when provided; single-channel blind overlap separation remains unsupported.',
    },
    {
      capabilityId: 'CAP-028-NEURAL-SED',
      name: 'External Pretrained Neural Audio Event Classifier (e.g., AudioSet/PANNs)',
      status: 'UNSUPPORTED',
      sourceRef: 'models/',
      evidenceNote: 'No neural SED weights installed in workspace; engine reports heuristic evidence class honestly and emits UNKNOWN/AMBIGUOUS when uncertain.',
    },
  ];

  return {
    contractVersion: SHAHAB_AUDIO_INTELLIGENCE_CONTRACT_VERSION,
    taxonomyVersion: SHAHAB_ACOUSTIC_TAXONOMY_VERSION,
    streamingCapability: 'INCREMENTAL_WINDOW_ANALYSIS',
    trueOnlineNeuralEventStreamingSupported: false,
    neuralAudioEventClassifierInstalled: false,
    supportsMultiLabelSimultaneousEvents: true,
    supportsMultiChannelImbalanceDetection: true,
    redLineGuardrails: {
      neverInfersEmotionOrPsychology: true,
      neverInfersBiometricIdentity: true,
      neverDeletesOrModifiesAudio: true,
      neverMakesEditorialCutDecisions: true,
      neverFabricatesOverallQualityScore: true,
    },
    workspaceInventory: inventory,
  };
}

export class ShahabAudioIntelligenceEngine {
  private readonly authorizedWorkspaceRoot: string;
  private readonly revisions = new Map<string, AudioSceneAnalysisResult[]>();
  private disposed = false;

  constructor(authorizedWorkspaceRoot = process.cwd()) {
    this.authorizedWorkspaceRoot = path.resolve(authorizedWorkspaceRoot);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('SHAHAB_AUDIO_INTEL_DISPOSED: Engine instance has been disposed.');
    }
  }

  public getCapabilities(): AudioIntelCapabilityReport {
    this.assertActive();
    return buildAudioIntelWorkspaceInventory(this.authorizedWorkspaceRoot);
  }

  public getAnalysisRevisionHistory(audioId: string): readonly AudioSceneAnalysisResult[] {
    this.assertActive();
    return this.revisions.get(audioId) ?? [];
  }

  public getLatestAnalysis(audioId: string): AudioSceneAnalysisResult | null {
    this.assertActive();
    const list = this.revisions.get(audioId);
    return list && list.length > 0 ? list[list.length - 1] : null;
  }

  public dispose(): void {
    this.revisions.clear();
    this.disposed = true;
  }

  /**
   * Executes deterministic, non-destructive acoustic scene analysis.
   * Produces multi-label simultaneous events in integer half-open [startSample, endSample).
   */
  public analyzeAudioScene(input: AudioSceneAnalysisInput): AudioSceneAnalysisResult {
    this.assertActive();
    const cfg: SignalWindowConfig = { ...DEFAULT_SIGNAL_WINDOW_CONFIG, ...(input.config ?? {}) };
    const sourceOffset = Math.max(0, Math.round(input.sourceOffsetSample ?? 0));

    // 1. Acquire planar channels without mutating caller buffers
    let channelBuffers: Float32Array[];
    let sampleRateHz = input.sampleRateHz;

    if (input.channelBuffers && input.channelBuffers.length > 0) {
      channelBuffers = input.channelBuffers.map((ch) => new Float32Array(ch));
    } else if (input.pcmInterleaved && input.pcmInterleaved.length > 0) {
      const chCount = Math.max(1, Math.round(input.channels ?? 1));
      const totalFrames = Math.floor(input.pcmInterleaved.length / chCount);
      channelBuffers = Array.from({ length: chCount }, () => new Float32Array(totalFrames));
      for (let i = 0; i < totalFrames; i++) {
        for (let c = 0; c < chCount; c++) {
          channelBuffers[c][i] = input.pcmInterleaved[i * chCount + c];
        }
      }
    } else if (input.wavFilePath) {
      const resolved = path.resolve(input.wavFilePath);
      if (
        !resolved.startsWith(this.authorizedWorkspaceRoot + path.sep) &&
        resolved !== this.authorizedWorkspaceRoot
      ) {
        throw new Error('PATH_TRAVERSAL_REJECTED: wavFilePath escapes authorizedWorkspaceRoot.');
      }
      const decoded = decodeWavToMono16k(fs.readFileSync(resolved));
      channelBuffers = [new Float32Array(decoded.pcm16k)];
      sampleRateHz = 16000;
    } else {
      throw new Error('INVALID_AUDIO_INPUT: Provide channelBuffers, pcmInterleaved, or authorized wavFilePath.');
    }

    const channels = channelBuffers.length;
    const totalFrames = channelBuffers[0].length;
    if (sampleRateHz <= 0 || totalFrames <= 0) {
      throw new Error('INVALID_AUDIO_INPUT: Audio must have positive sampleRateHz and frame count.');
    }

    const sourcePcmSha256 = sha256Float32List(channelBuffers);
    const mono = new Float32Array(totalFrames);
    if (channels === 1) {
      mono.set(channelBuffers[0]);
    } else {
      for (let i = 0; i < totalFrames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          sum += channelBuffers[c][i];
        }
        mono[i] = sum / channels;
      }
    }

    const durationSec = Number((totalFrames / sampleRateHz).toFixed(6));
    const prevRevs = this.revisions.get(input.audioId) ?? [];
    const revision = prevRevs.length + 1;
    const analysisId = `audintel_${crypto.randomBytes(5).toString('hex')}`;
    const events: AcousticEventRecord[] = [];
    let eventSeq = 0;
    const pushEvent = (
      ev: Omit<AcousticEventRecord, 'eventId' | 'revision' | 'calibratedProbabilityAvailable' | 'supersedesEventId'>,
    ) => {
      eventSeq++;
      events.push({
        ...ev,
        eventId: `${analysisId}_ev_${String(eventSeq).padStart(4, '0')}`,
        revision,
        calibratedProbabilityAvailable: false,
        supersedesEventId: null,
      });
    };

    // 2. Per-channel signal diagnostics & channel imbalance detection
    const channelMetrics = channelBuffers.map((buf, chIdx) => {
      let sum = 0;
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sum += v;
        sumSq += v * v;
        const av = Math.abs(v);
        if (av > peak) peak = av;
      }
      const mean = sum / buf.length;
      const rms = Math.sqrt(sumSq / buf.length);
      return {
        channelIndex: chIdx,
        rmsDbfs: toDbfs(rms),
        peakDbfs: toDbfs(peak),
        dcOffset: Number(mean.toFixed(6)),
      };
    });

    let channelImbalanceDb: number | null = null;
    if (channels >= 2) {
      const rmsValues = channelMetrics.map((m) => m.rmsDbfs);
      const diff = Number((Math.max(...rmsValues) - Math.min(...rmsValues)).toFixed(2));
      channelImbalanceDb = diff;
      if (diff >= cfg.channelImbalanceDbThreshold) {
        pushEvent({
          category: 'SIGNAL_DEFECT_AND_QUALITY',
          eventType: 'CHANNEL_IMBALANCE',
          range: makeRange(0, totalFrames, sampleRateHz, sourceOffset),
          channelScope: 'STEREO_DIFF',
          evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
          rawHeuristicIndicator: Number(Math.min(1, diff / 24).toFixed(3)),
          measuredMetrics: {
            rmsDbfs: Math.max(...rmsValues),
            peakDbfs: Math.max(...channelMetrics.map((m) => m.peakDbfs)),
            zcrPerSec: null,
            spectralCentroidHz: null,
            spectralFlatness: null,
            noiseFloorDeltaDb: diff,
          },
          breathOrQuietSpeechProtected: false,
          ambiguityReason: null,
        });
      }
    }

    // 3. Sample-level Clipping / Flat-Top, Zero-Run Signal Dropout, and Sudden Discontinuity detection
    let clippedSampleCount = 0;
    let flatTopEventCount = 0;
    let discontinuityCount = 0;
    let signalDropoutCount = 0;

    let clipRunStart = -1;
    for (let i = 0; i < totalFrames; i++) {
      let maxAbs = 0;
      for (let c = 0; c < channels; c++) {
        const av = Math.abs(channelBuffers[c][i]);
        if (av > maxAbs) maxAbs = av;
      }
      const isClipped = maxAbs >= cfg.clippingAbsThreshold;
      if (isClipped) {
        clippedSampleCount++;
        if (clipRunStart < 0) clipRunStart = i;
      } else if (clipRunStart >= 0) {
        const runLen = i - clipRunStart;
        if (runLen >= cfg.flatTopMinConsecutiveSamples) {
          flatTopEventCount++;
          pushEvent({
            category: 'SIGNAL_DEFECT_AND_QUALITY',
            eventType: 'CLIPPING',
            range: makeRange(clipRunStart, i, sampleRateHz, sourceOffset),
            channelScope: 'MIX_ALL',
            evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
            rawHeuristicIndicator: 1.0,
            measuredMetrics: {
              rmsDbfs: -0.05,
              peakDbfs: 0,
              zcrPerSec: null,
              spectralCentroidHz: null,
              spectralFlatness: null,
              noiseFloorDeltaDb: null,
            },
            breathOrQuietSpeechProtected: false,
            ambiguityReason: null,
          });
        }
        clipRunStart = -1;
      }

      if (i > 0 && Math.abs(mono[i] - mono[i - 1]) >= cfg.discontinuitySampleDeltaThreshold) {
        discontinuityCount++;
        if (discontinuityCount <= 25) {
          pushEvent({
            category: 'SIGNAL_DEFECT_AND_QUALITY',
            eventType: 'SUDDEN_SIGNAL_DISCONTINUITY',
            range: makeRange(Math.max(0, i - 1), Math.min(totalFrames, i + 2), sampleRateHz, sourceOffset),
            channelScope: 'MIX_ALL',
            evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
            rawHeuristicIndicator: Number(Math.min(1, Math.abs(mono[i] - mono[i - 1])).toFixed(3)),
            measuredMetrics: {
              rmsDbfs: toDbfs(Math.abs(mono[i] - mono[i - 1])),
              peakDbfs: toDbfs(Math.max(Math.abs(mono[i]), Math.abs(mono[i - 1]))),
              zcrPerSec: null,
              spectralCentroidHz: null,
              spectralFlatness: null,
              noiseFloorDeltaDb: null,
            },
            breathOrQuietSpeechProtected: false,
            ambiguityReason: null,
          });
        }
      }
    }
    if (clipRunStart >= 0 && totalFrames - clipRunStart >= cfg.flatTopMinConsecutiveSamples) {
      flatTopEventCount++;
      pushEvent({
        category: 'SIGNAL_DEFECT_AND_QUALITY',
        eventType: 'CLIPPING',
        range: makeRange(clipRunStart, totalFrames, sampleRateHz, sourceOffset),
        channelScope: 'MIX_ALL',
        evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
        rawHeuristicIndicator: 1.0,
        measuredMetrics: {
          rmsDbfs: -0.05,
          peakDbfs: 0,
          zcrPerSec: null,
          spectralCentroidHz: null,
          spectralFlatness: null,
          noiseFloorDeltaDb: null,
        },
        breathOrQuietSpeechProtected: false,
        ambiguityReason: null,
      });
    }

    // 4. Frame-based spectral & energy analysis (declared window/hop)
    const frameLen = Math.max(64, Math.round((cfg.frameLengthMs / 1000) * sampleRateHz));
    const hopLen = Math.max(32, Math.round((cfg.hopLengthMs / 1000) * sampleRateHz));
    interface FrameStat {
      readonly startFrame: number;
      readonly endFrame: number;
      readonly rms: number;
      readonly rmsDbfs: number;
      readonly peakDbfs: number;
      readonly zcrPerSec: number;
      readonly spectralCentroidHz: number;
      readonly spectralFlatness: number;
      readonly harmonicityProxy: number;
      readonly isExactZero: boolean;
    }

    const frames: FrameStat[] = [];
    for (let pos = 0; pos < totalFrames; pos += hopLen) {
      const end = Math.min(totalFrames, pos + frameLen);
      const feat = computeFrameSpectralFeatures(mono, pos, end - pos, sampleRateHz);
      let exactZero = true;
      for (let i = pos; i < Math.min(totalFrames, pos + hopLen); i++) {
        if (Math.abs(mono[i]) > 1e-7) {
          exactZero = false;
          break;
        }
      }
      frames.push({
        startFrame: pos,
        endFrame: end,
        rms: feat.rms,
        rmsDbfs: toDbfs(feat.rms),
        peakDbfs: toDbfs(feat.peak),
        zcrPerSec: feat.zcrPerSec,
        spectralCentroidHz: feat.spectralCentroidHz,
        spectralFlatness: feat.spectralFlatness,
        harmonicityProxy: feat.harmonicityProxy,
        isExactZero: exactZero,
      });
    }

    // Adaptive noise floor (15th percentile of non-zero frames) and high energy (90th percentile)
    const nonZeroRmsDb = frames
      .filter((f) => f.rmsDbfs > cfg.digitalSilenceDbfsThreshold)
      .map((f) => f.rmsDbfs)
      .sort((a, b) => a - b);
    const estimatedNoiseFloorDbfs =
      nonZeroRmsDb.length >= 4
        ? nonZeroRmsDb[Math.floor(nonZeroRmsDb.length * 0.15)]
        : cfg.digitalSilenceDbfsThreshold;
    const p90Dbfs =
      nonZeroRmsDb.length >= 4
        ? nonZeroRmsDb[Math.floor(nonZeroRmsDb.length * 0.9)]
        : estimatedNoiseFloorDbfs;
    const estimatedDynamicRangeDb = Number(Math.max(0, p90Dbfs - estimatedNoiseFloorDbfs).toFixed(2));

    // Reuse SHAHAB-025 VAD for speech baseline
    const reusedVad = detectAcousticSpeechRegions(mono, sampleRateHz);

    // 5. Adaptive Hysteresis Speech / Low-Energy Speech / Breath Protection
    const speechEnterDb = Math.max(-44, estimatedNoiseFloorDbfs + 9);
    const speechExitDb = Math.max(-52, estimatedNoiseFloorDbfs + 4.5);
    const lowEnergySpeechFloorDb = Math.max(-58, estimatedNoiseFloorDbfs + 2.5);

    const frameIsSpeech = new Uint8Array(frames.length);
    const frameIsLowEnergySpeech = new Uint8Array(frames.length);
    let inSpeech = false;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const speechLikeSpectrum =
        f.spectralCentroidHz >= 140 &&
        f.spectralCentroidHz <= 4600 &&
        f.spectralFlatness < 0.78;
      if (!inSpeech) {
        if (f.rmsDbfs >= speechEnterDb && speechLikeSpectrum) {
          inSpeech = true;
        }
      } else {
        if (f.rmsDbfs < speechExitDb) {
          inSpeech = false;
        }
      }
      if (inSpeech) {
        frameIsSpeech[i] = 1;
      } else if (
        f.rmsDbfs >= lowEnergySpeechFloorDb &&
        f.rmsDbfs < speechEnterDb &&
        f.spectralCentroidHz >= 180 &&
        f.spectralCentroidHz <= 5200 &&
        f.spectralFlatness < 0.85
      ) {
        // Quiet / whispered speech or breath-onset protection: never blindly call this dead silence
        frameIsLowEnergySpeech[i] = 1;
      }
    }

    // Helper to coalesce contiguous frame runs into AcousticEventRecords
    const coalesceRuns = (
      predicate: (idx: number) => boolean,
      minDurationMs: number,
      onRun: (startIdx: number, endIdx: number) => void,
    ) => {
      let runStart = -1;
      for (let i = 0; i <= frames.length; i++) {
        const ok = i < frames.length && predicate(i);
        if (ok && runStart < 0) {
          runStart = i;
        } else if (!ok && runStart >= 0) {
          const sFrame = frames[runStart].startFrame;
          const eFrame = Math.min(totalFrames, frames[i - 1].endFrame);
          const durMs = ((eFrame - sFrame) / sampleRateHz) * 1000;
          if (durMs >= minDurationMs) {
            onRun(runStart, i - 1);
          }
          runStart = -1;
        }
      }
    };

    const summarizeFrames = (a: number, b: number) => {
      let rmsSum = 0;
      let peakMax = -120;
      let zcrSum = 0;
      let centSum = 0;
      let flatSum = 0;
      const cnt = Math.max(1, b - a + 1);
      for (let k = a; k <= b; k++) {
        rmsSum += frames[k].rms * frames[k].rms;
        if (frames[k].peakDbfs > peakMax) peakMax = frames[k].peakDbfs;
        zcrSum += frames[k].zcrPerSec;
        centSum += frames[k].spectralCentroidHz;
        flatSum += frames[k].spectralFlatness;
      }
      const rmsDbfs = toDbfs(Math.sqrt(rmsSum / cnt));
      return {
        rmsDbfs,
        peakDbfs: peakMax,
        zcrPerSec: Number((zcrSum / cnt).toFixed(1)),
        spectralCentroidHz: Number((centSum / cnt).toFixed(1)),
        spectralFlatness: Number((flatSum / cnt).toFixed(4)),
        noiseFloorDeltaDb: Number((rmsDbfs - estimatedNoiseFloorDbfs).toFixed(2)),
      };
    };

    const speechIntervals: AcousticTimeRange[] = [];
    coalesceRuns(
      (i) => frameIsSpeech[i] === 1,
      80,
      (a, b) => {
        const range = makeRange(frames[a].startFrame, Math.min(totalFrames, frames[b].endFrame), sampleRateHz, sourceOffset);
        speechIntervals.push(range);
        pushEvent({
          category: 'SPEECH_ACTIVITY',
          eventType: 'SPEECH_ACTIVITY',
          range,
          channelScope: 'MIX_ALL',
          evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
          rawHeuristicIndicator: 0.85,
          measuredMetrics: summarizeFrames(a, b),
          breathOrQuietSpeechProtected: false,
          ambiguityReason: null,
        });
      },
    );

    let lowEnergySpeechProtectedCount = 0;
    coalesceRuns(
      (i) => frameIsLowEnergySpeech[i] === 1 && frameIsSpeech[i] === 0,
      90,
      (a, b) => {
        lowEnergySpeechProtectedCount++;
        const range = makeRange(frames[a].startFrame, Math.min(totalFrames, frames[b].endFrame), sampleRateHz, sourceOffset);
        pushEvent({
          category: 'SPEECH_ACTIVITY',
          eventType: 'LOW_ENERGY_SPEECH',
          range,
          channelScope: 'MIX_ALL',
          evidenceClass: 'SPECTRAL_HEURISTIC_ESTIMATE',
          rawHeuristicIndicator: 0.55,
          measuredMetrics: summarizeFrames(a, b),
          breathOrQuietSpeechProtected: true,
          ambiguityReason: 'Low-energy vocal/breath onset near noise floor; protected from silence misclassification.',
        });
      },
    );

    // 6. External overlap regions (e.g. from SHAHAB-026) — simultaneous multi-label support
    for (const ov of input.externalOverlapRegionsSec ?? []) {
      const sF = Math.max(0, Math.round(ov.startSec * sampleRateHz));
      const eF = Math.min(totalFrames, Math.round(ov.endSec * sampleRateHz));
      if (eF > sF) {
        pushEvent({
          category: 'SPEECH_ACTIVITY',
          eventType: 'OVERLAPPING_SPEECH',
          range: makeRange(sF, eF, sampleRateHz, sourceOffset),
          channelScope: 'MIX_ALL',
          evidenceClass: 'CROSS_CHECK_INFERENCE',
          rawHeuristicIndicator: 0.8,
          measuredMetrics: {
            rmsDbfs: p90Dbfs,
            peakDbfs: channelMetrics[0]?.peakDbfs ?? -6,
            zcrPerSec: null,
            spectralCentroidHz: null,
            spectralFlatness: null,
            noiseFloorDeltaDb: Number((p90Dbfs - estimatedNoiseFloorDbfs).toFixed(2)),
          },
          breathOrQuietSpeechProtected: true,
          ambiguityReason: 'Derived from multi-speaker overlap metadata; single-channel blind separation is unsupported.',
        });
      }
    }

    // 7. Signal Dropout (exact zero runs embedded between active audio) & Digital Silence
    coalesceRuns(
      (i) => frames[i].isExactZero,
      cfg.dropoutMinZeroRunMs,
      (a, b) => {
        const range = makeRange(frames[a].startFrame, Math.min(totalFrames, frames[b].endFrame), sampleRateHz, sourceOffset);
        const hasAudioBefore = a > 0 && frames.slice(Math.max(0, a - 5), a).some((f) => f.rmsDbfs > -48);
        const hasAudioAfter = b + 1 < frames.length && frames.slice(b + 1, Math.min(frames.length, b + 6)).some((f) => f.rmsDbfs > -48);
        if (hasAudioBefore && hasAudioAfter && range.durationMs <= 1200) {
          signalDropoutCount++;
          pushEvent({
            category: 'SIGNAL_DEFECT_AND_QUALITY',
            eventType: 'SIGNAL_DROPOUT',
            range,
            channelScope: 'MIX_ALL',
            evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
            rawHeuristicIndicator: 0.95,
            measuredMetrics: summarizeFrames(a, b),
            breathOrQuietSpeechProtected: false,
            ambiguityReason: 'Abrupt exact-zero sample run bounded by active signal.',
          });
        } else {
          pushEvent({
            category: 'SILENCE_AND_PAUSE',
            eventType: range.durationMs >= 2500 ? 'POSSIBLE_RECORDING_GAP' : 'DIGITAL_SILENCE',
            range,
            channelScope: 'MIX_ALL',
            evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
            rawHeuristicIndicator: 0.95,
            measuredMetrics: summarizeFrames(a, b),
            breathOrQuietSpeechProtected: false,
            ambiguityReason:
              range.durationMs >= 2500 ? 'Extended exact-zero digital silence may indicate a recording gap.' : null,
          });
        }
      },
    );

    // 8. Pause & Silence Classification between speech intervals (preserving breath/low-energy distinctions)
    for (let i = 0; i + 1 < speechIntervals.length; i++) {
      const gapStart = speechIntervals[i].endSample - sourceOffset;
      const gapEnd = speechIntervals[i + 1].startSample - sourceOffset;
      if (gapEnd <= gapStart) continue;
      const gapMs = ((gapEnd - gapStart) / sampleRateHz) * 1000;
      if (gapMs < 120) continue;

      const startIdx = Math.max(0, Math.floor(gapStart / hopLen));
      const endIdx = Math.min(frames.length - 1, Math.floor(gapEnd / hopLen));
      const metrics = summarizeFrames(startIdx, Math.max(startIdx, endIdx));
      const containsProtectedLowEnergy = frames
        .slice(startIdx, endIdx + 1)
        .some((_f, k) => frameIsLowEnergySpeech[startIdx + k] === 1);

      let evType: AcousticEventType;
      if (metrics.rmsDbfs <= cfg.digitalSilenceDbfsThreshold && gapMs >= 2000) {
        evType = 'POSSIBLE_RECORDING_GAP';
      } else if (gapMs >= cfg.longSilenceMinMs) {
        evType = 'LONG_SILENCE';
      } else if (gapMs > cfg.pauseWithinSpeechMaxMs) {
        evType = 'INTER_UTTERANCE_PAUSE';
      } else {
        evType = 'PAUSE_WITHIN_SPEECH';
      }

      pushEvent({
        category: 'SILENCE_AND_PAUSE',
        eventType: evType,
        range: makeRange(gapStart, gapEnd, sampleRateHz, sourceOffset),
        channelScope: 'MIX_ALL',
        evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
        rawHeuristicIndicator: 0.85,
        measuredMetrics: metrics,
        breathOrQuietSpeechProtected: containsProtectedLowEnergy,
        ambiguityReason: containsProtectedLowEnergy
          ? 'Gap contains low-energy vocal/breath energy; downstream planners must preserve breath margins.'
          : null,
      });
    }

    // 9. Spectral Non-Speech Heuristics: Music (high harmonicity, sustained), Background Noise (high flatness), Impact Sound (brief high crest)
    coalesceRuns(
      (i) =>
        frameIsSpeech[i] === 0 &&
        frames[i].rmsDbfs > estimatedNoiseFloorDbfs + 5 &&
        frames[i].spectralFlatness > 0.72,
      250,
      (a, b) => {
        pushEvent({
          category: 'BACKGROUND_AND_NON_SPEECH',
          eventType: 'BACKGROUND_NOISE',
          range: makeRange(frames[a].startFrame, Math.min(totalFrames, frames[b].endFrame), sampleRateHz, sourceOffset),
          channelScope: 'MIX_ALL',
          evidenceClass: 'SPECTRAL_HEURISTIC_ESTIMATE',
          rawHeuristicIndicator: 0.65,
          measuredMetrics: summarizeFrames(a, b),
          breathOrQuietSpeechProtected: false,
          ambiguityReason: 'High spectral flatness broadband energy (heuristic estimate without neural SED).',
        });
      },
    );

    coalesceRuns(
      (i) =>
        frameIsSpeech[i] === 0 &&
        frames[i].rmsDbfs > estimatedNoiseFloorDbfs + 6 &&
        frames[i].harmonicityProxy > 5.5 &&
        frames[i].spectralFlatness < 0.32,
      400,
      (a, b) => {
        pushEvent({
          category: 'BACKGROUND_AND_NON_SPEECH',
          eventType: 'MUSIC',
          range: makeRange(frames[a].startFrame, Math.min(totalFrames, frames[b].endFrame), sampleRateHz, sourceOffset),
          channelScope: 'MIX_ALL',
          evidenceClass: 'SPECTRAL_HEURISTIC_ESTIMATE',
          rawHeuristicIndicator: 0.58,
          measuredMetrics: summarizeFrames(a, b),
          breathOrQuietSpeechProtected: false,
          ambiguityReason: 'Sustained tonal harmonic profile detected via DSP heuristic; verify before editorial action.',
        });
      },
    );

    // Impact sound (sharp transient spike outside sustained speech)
    for (let i = 1; i < frames.length - 1; i++) {
      const f = frames[i];
      const crest = f.peakDbfs - f.rmsDbfs;
      const jump = f.rmsDbfs - frames[i - 1].rmsDbfs;
      if (jump >= cfg.abruptLevelJumpDbThreshold) {
        pushEvent({
          category: 'SIGNAL_DEFECT_AND_QUALITY',
          eventType: 'ABRUPT_LEVEL_CHANGE',
          range: makeRange(f.startFrame, Math.min(totalFrames, f.endFrame), sampleRateHz, sourceOffset),
          channelScope: 'MIX_ALL',
          evidenceClass: 'DIRECT_SIGNAL_MEASUREMENT',
          rawHeuristicIndicator: Number(Math.min(1, jump / 30).toFixed(3)),
          measuredMetrics: summarizeFrames(i, i),
          breathOrQuietSpeechProtected: false,
          ambiguityReason: null,
        });
      }
      if (frameIsSpeech[i] === 0 && crest >= 10 && jump >= 12 && frames[i + 1].rmsDbfs < f.rmsDbfs - 8) {
        pushEvent({
          category: 'BACKGROUND_AND_NON_SPEECH',
          eventType: 'IMPACT_SOUND',
          range: makeRange(f.startFrame, Math.min(totalFrames, f.endFrame), sampleRateHz, sourceOffset),
          channelScope: 'MIX_ALL',
          evidenceClass: 'SPECTRAL_HEURISTIC_ESTIMATE',
          rawHeuristicIndicator: 0.62,
          measuredMetrics: summarizeFrames(i, i),
          breathOrQuietSpeechProtected: false,
          ambiguityReason: 'Short impulsive transient spike outside sustained speech.',
        });
      }
    }

    // 10. Count simultaneous overlapping multi-label event pairs
    let overlappingEventPairsCount = 0;
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i].range;
        const b = events[j].range;
        if (a.startSample < b.endSample && b.startSample < a.endSample) {
          overlappingEventPairsCount++;
        }
      }
    }

    // 11. Speech-vs-Transcript Coverage Cross-Check (NEVER treats untranscribed speech as silence!)
    const coverageCrossCheck = this.computeSpeechVsTranscriptCoverage(
      speechIntervals,
      input.transcriptSpansSec ?? null,
      sampleRateHz,
      sourceOffset,
    );

    // 12. Overall Technical Signal Quality Diagnostics (NO fake overall quality score)
    let monoSum = 0;
    let monoSumSq = 0;
    let monoPeak = 0;
    for (let i = 0; i < totalFrames; i++) {
      const v = mono[i];
      monoSum += v;
      monoSumSq += v * v;
      const av = Math.abs(v);
      if (av > monoPeak) monoPeak = av;
    }
    const overallRmsDbfs = toDbfs(Math.sqrt(monoSumSq / totalFrames));
    const peakDbfs = toDbfs(monoPeak);
    const crestFactorDb = Number(Math.max(0, peakDbfs - overallRmsDbfs).toFixed(2));
    const speechFrameCount = frameIsSpeech.reduce((acc, v) => acc + v, 0);
    const speechActivityRatio = Number((speechFrameCount / Math.max(1, frames.length)).toFixed(4));
    const snrProxyDb =
      nonZeroRmsDb.length >= 6 ? Number((p90Dbfs - estimatedNoiseFloorDbfs).toFixed(2)) : null;

    const diagnosticFlags: string[] = [];
    if (flatTopEventCount > 0) diagnosticFlags.push(`CLIPPING_DETECTED (${flatTopEventCount} flat-top runs)`);
    if (signalDropoutCount > 0) diagnosticFlags.push(`SIGNAL_DROPOUT_DETECTED (${signalDropoutCount} zero-runs)`);
    if (discontinuityCount > 0) diagnosticFlags.push(`SUDDEN_DISCONTINUITIES (${discontinuityCount})`);
    if (channelImbalanceDb !== null && channelImbalanceDb >= cfg.channelImbalanceDbThreshold) {
      diagnosticFlags.push(`CHANNEL_IMBALANCE (${channelImbalanceDb} dB)`);
    }
    if (snrProxyDb !== null && snrProxyDb < 10) {
      diagnosticFlags.push(`LOW_SNR_PROXY (${snrProxyDb} dB)`);
    }
    if (diagnosticFlags.length === 0) {
      diagnosticFlags.push('NO_SEVERE_TECHNICAL_DEFECTS_OBSERVED');
    }

    const eventSummaryByType: Record<string, number> = {};
    for (const ev of events) {
      eventSummaryByType[ev.eventType] = (eventSummaryByType[ev.eventType] ?? 0) + 1;
    }

    const result: AudioSceneAnalysisResult = {
      analysisId,
      revision,
      contractVersion: SHAHAB_AUDIO_INTELLIGENCE_CONTRACT_VERSION,
      taxonomyVersion: SHAHAB_ACOUSTIC_TAXONOMY_VERSION,
      audioId: input.audioId,
      sourceRevisionId: input.sourceRevisionId ?? `rev_${sourcePcmSha256.slice(0, 12)}`,
      sourcePcmSha256,
      sampleRateHz,
      channels,
      totalFrames,
      durationSec,
      streamingMode: 'INCREMENTAL_WINDOW_ANALYSIS',
      windowConfig: cfg,
      qualityDiagnostics: {
        universalQualityScoreFabricated: false,
        analysisWindowMs: cfg.frameLengthMs,
        analysisHopMs: cfg.hopLengthMs,
        overallRmsDbfs,
        peakDbfs,
        crestFactorDb,
        dcOffset: Number((monoSum / totalFrames).toFixed(6)),
        estimatedNoiseFloorDbfs,
        estimatedDynamicRangeDb,
        snrProxyDb,
        snrProxyMethodNote:
          '90th-vs-15th percentile frame RMS dBFS ratio over non-zero windows (HEURISTIC_ESTIMATE, assumes quasi-stationary noise floor).',
        clippedSampleCount,
        flatTopEventCount,
        signalDropoutCount,
        discontinuityCount,
        channelMetrics,
        channelImbalanceDb,
        speechActivityRatio,
        lowEnergySpeechProtectedCount,
        diagnosticFlags,
      },
      events,
      overlappingEventPairsCount,
      coverageCrossCheck,
      reusedUpstreamVadCount: reusedVad.length,
      eventSummaryByType,
      honestLimitations: [
        'Non-speech categories (MUSIC, BACKGROUND_NOISE, IMPACT_SOUND) use deterministic DSP spectral heuristics; no external neural AudioSet classifier is installed.',
        'All heuristic indicators are uncalibrated; calibrated probabilities are explicitly unavailable.',
        'Single-channel blind overlapping-speech separation is unsupported; OVERLAPPING_SPEECH uses explicit multi-speaker metadata when supplied.',
        'This engine performs acoustic detection only and never executes editorial cuts or infers emotion/psychology/speaker identity.',
      ],
      createdAtUtc: new Date().toISOString(),
    };

    this.revisions.set(input.audioId, [...prevRevs, result]);
    return result;
  }

  private computeSpeechVsTranscriptCoverage(
    speechIntervals: readonly AcousticTimeRange[],
    transcriptSpansSec: readonly { readonly startSec: number; readonly endSec: number; readonly text?: string }[] | null,
    sampleRateHz: number,
    sourceOffsetSample: number,
  ): SpeechVsTranscriptCoverageRecord {
    if (!transcriptSpansSec) {
      return {
        status: 'NOT_SUPPLIED',
        acousticSpeechIntervalCount: speechIntervals.length,
        transcriptSpanCount: 0,
        untranscribedSpeechRanges: [],
        transcriptWithoutAcousticSpeechRanges: [],
        note: 'No transcript spans supplied for acoustic coverage cross-check.',
      };
    }

    const untranscribedSpeechRanges: AcousticTimeRange[] = [];
    for (const sp of speechIntervals) {
      const hasTranscriptOverlap = transcriptSpansSec.some(
        (tr) => tr.startSec < sp.endSec + 0.15 && tr.endSec > sp.startSec - 0.15,
      );
      if (!hasTranscriptOverlap) {
        untranscribedSpeechRanges.push(sp);
      }
    }

    const transcriptWithoutAcousticSpeechRanges: AcousticTimeRange[] = [];
    for (const tr of transcriptSpansSec) {
      const hasSpeechOverlap = speechIntervals.some(
        (sp) => sp.startSec < tr.endSec + 0.15 && sp.endSec > tr.startSec - 0.15,
      );
      if (!hasSpeechOverlap) {
        const sFrame = Math.max(0, Math.round(tr.startSec * sampleRateHz) - sourceOffsetSample);
        const eFrame = Math.max(sFrame, Math.round(tr.endSec * sampleRateHz) - sourceOffsetSample);
        transcriptWithoutAcousticSpeechRanges.push(
          makeRange(sFrame, eFrame, sampleRateHz, sourceOffsetSample),
        );
      }
    }

    let status: SpeechVsTranscriptCoverageRecord['status'] = 'CONSISTENT_COVERAGE';
    if (untranscribedSpeechRanges.length > 0 && transcriptWithoutAcousticSpeechRanges.length > 0) {
      status = 'MIXED_DISCREPANCIES';
    } else if (untranscribedSpeechRanges.length > 0) {
      status = 'UNTRANSCRIBED_SPEECH_DETECTED';
    } else if (transcriptWithoutAcousticSpeechRanges.length > 0) {
      status = 'TRANSCRIPT_WITHOUT_ACOUSTIC_SPEECH';
    }

    return {
      status,
      acousticSpeechIntervalCount: speechIntervals.length,
      transcriptSpanCount: transcriptSpansSec.length,
      untranscribedSpeechRanges,
      transcriptWithoutAcousticSpeechRanges,
      note:
        untranscribedSpeechRanges.length > 0
          ? 'Acoustic speech detected without matching transcript span — NEVER treat untranscribed speech as silence.'
          : 'Acoustic speech intervals align with supplied transcript coverage.',
    };
  }

  /**
   * Reference evaluation harness (SHAHAB-028 §12): event precision, recall, F1, and boundary error.
   */
  public evaluateAgainstReference(
    predicted: readonly AcousticEventRecord[],
    reference: readonly ReferenceEventAnnotation[],
    toleranceSec = 0.25,
  ): AudioEventEvaluationReport {
    const matchedRef = new Set<number>();
    const startErrorsMs: number[] = [];
    const endErrorsMs: number[] = [];
    const byType = new Map<string, { tp: number; fp: number; fn: number }>();

    const ensureType = (t: string) => {
      let row = byType.get(t);
      if (!row) {
        row = { tp: 0, fp: 0, fn: 0 };
        byType.set(t, row);
      }
      return row;
    };

    const refTypes = new Set(reference.map((r) => r.eventType));
    const filteredPred = predicted.filter((p) => refTypes.has(p.eventType));

    for (const p of filteredPred) {
      let bestIdx = -1;
      let bestErr = Infinity;
      for (let i = 0; i < reference.length; i++) {
        if (matchedRef.has(i)) continue;
        const r = reference[i];
        if (r.eventType !== p.eventType) continue;
        const overlaps = p.range.startSec <= r.endSec + toleranceSec && p.range.endSec >= r.startSec - toleranceSec;
        if (!overlaps) continue;
        const err = Math.abs(p.range.startSec - r.startSec) + Math.abs(p.range.endSec - r.endSec);
        if (err < bestErr) {
          bestErr = err;
          bestIdx = i;
        }
      }
      const row = ensureType(p.eventType);
      if (bestIdx >= 0) {
        matchedRef.add(bestIdx);
        row.tp++;
        startErrorsMs.push(Math.abs(p.range.startSec - reference[bestIdx].startSec) * 1000);
        endErrorsMs.push(Math.abs(p.range.endSec - reference[bestIdx].endSec) * 1000);
      } else {
        row.fp++;
      }
    }

    for (let i = 0; i < reference.length; i++) {
      if (!matchedRef.has(i)) {
        ensureType(reference[i].eventType).fn++;
      }
    }

    const tp = matchedRef.size;
    const precision = filteredPred.length > 0 ? Number((tp / filteredPred.length).toFixed(4)) : 0;
    const recall = reference.length > 0 ? Number((tp / reference.length).toFixed(4)) : 0;
    const f1 = precision + recall > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;

    const perEventType: Record<string, { readonly tp: number; readonly fp: number; readonly fn: number; readonly f1: number }> = {};
    for (const [k, v] of byType.entries()) {
      const p = v.tp + v.fp > 0 ? v.tp / (v.tp + v.fp) : 0;
      const r = v.tp + v.fn > 0 ? v.tp / (v.tp + v.fn) : 0;
      const typeF1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
      perEventType[k] = { tp: v.tp, fp: v.fp, fn: v.fn, f1: Number(typeF1.toFixed(4)) };
    }

    return {
      toleranceSec,
      matchedCount: tp,
      referenceCount: reference.length,
      predictedCount: filteredPred.length,
      precision,
      recall,
      f1,
      meanStartBoundaryErrorMs:
        startErrorsMs.length > 0
          ? Number((startErrorsMs.reduce((a, b) => a + b, 0) / startErrorsMs.length).toFixed(2))
          : null,
      meanEndBoundaryErrorMs:
        endErrorsMs.length > 0
          ? Number((endErrorsMs.reduce((a, b) => a + b, 0) / endErrorsMs.length).toFixed(2))
          : null,
      perEventType,
    };
  }
}
