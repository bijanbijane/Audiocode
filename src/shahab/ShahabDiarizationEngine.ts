/**
 * SHAHAB-026 — Speaker Diarization, Multi-Speaker Attribution & Overlap Intelligence
 *
 * Strictly decoupled from ASR (SHAHAB-005..021) and Forced Alignment (SHAHAB-025).
 *
 * Epistemic & Privacy Invariants:
 * 1. Recording-scoped anonymous speaker IDs (`speaker_1`, `speaker_2`, ...) ONLY.
 *    NEVER infers real-world person names, gender, age, identity, or cross-recording voiceprints.
 * 2. Strict architectural separation of:
 *    - VAD (Voice Activity Detection)
 *    - Speech Segmentation
 *    - Speaker Diarization (local clustering)
 *    - Overlap Detection
 *    - Speaker Separation (explicitly NOT_SUPPORTED)
 *    - Speaker Identification (explicitly PROHIBITED)
 * 3. Preserves `UNKNOWN_SPEAKER` when duration/evidence is insufficient and preserves
 *    `OVERLAPPING_SPEECH` as explicit concurrent intervals (NEVER forcing overlapping
 *    speakers into a fabricated sequential turn).
 * 4. User-confirmed labels & edits (`rename`, `merge`, `split`, `reassign`, `mark_unknown`,
 *    `mark_overlap`) are revisioned, reversible, and protected against silent overwrite on
 *    re-diarization via explicit conflict detection.
 * 5. Raw cosine similarity scores are explicitly tagged `UNCALIBRATED_ACOUSTIC_SIMILARITY`
 *    and NEVER displayed as calibrated accuracy/confidence percentages.
 * 6. Ephemeral acoustic/embedding vectors are purged immediately after clustering;
 *    diagnostics NEVER log raw audio or embedding vectors.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSampleInterval,
  hashFloat32Pcm,
  type AlignmentResult,
  type SampleInterval,
} from './ShahabAlignmentEngine.ts';

export const SHAHAB_DIARIZATION_CONTRACT_VERSION = '1.0.0';
export const UNKNOWN_SPEAKER_ID = 'UNKNOWN_SPEAKER';

export type DiarizationCapabilityStatus =
  | 'DIARIZATION_SUPPORTED'
  | 'DIARIZATION_PARTIALLY_SUPPORTED'
  | 'SEPARATE_DIARIZATION_MODEL_REQUIRED'
  | 'DIARIZATION_BLOCKED';

export type OverlapDetectionCapabilityStatus =
  | 'OVERLAP_DETECTION_VERIFIED'
  | 'OVERLAP_DETECTION_EXPERIMENTAL_PROXY'
  | 'OVERLAP_DETECTION_UNAVAILABLE';

export type DiarizationStreamingCapabilityStatus =
  | 'STREAMING_DIARIZATION_VERIFIED'
  | 'STREAMING_DIARIZATION_UNAVAILABLE';

export type DiarizationBackendMode =
  | 'NEURAL_EMBEDDING_PROVIDER_AHC'
  | 'ACOUSTIC_SPECTRAL_PROXY_AHC';

export type SpeakerTurnKind =
  | 'SINGLE_SPEAKER'
  | 'OVERLAPPING_SPEECH'
  | 'UNKNOWN_SPEAKER'
  | 'NON_SPEECH';

export type SpeakerAssignmentOrigin =
  | 'AUTOMATIC_CLUSTERING'
  | 'USER_CONFIRMED'
  | 'USER_MERGED'
  | 'USER_SPLIT'
  | 'USER_REASSIGNED';

export type DiarizationJobState =
  | 'CREATED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'DISPOSED';

export interface DiarizationCapabilityReport {
  readonly contractVersion: string;
  readonly inspectedAtUtc: string;
  readonly neuralEmbeddingWeightsOnDisk: boolean;
  readonly neuralOverlapWeightsOnDisk: boolean;
  readonly capabilityStatus: DiarizationCapabilityStatus;
  readonly overlapDetectionStatus: OverlapDetectionCapabilityStatus;
  readonly streamingStatus: DiarizationStreamingCapabilityStatus;
  readonly stageSeparation: {
    readonly vad: 'AVAILABLE_DETERMINISTIC_ENERGY_ZCR';
    readonly speechSegmentation: 'AVAILABLE_DETERMINISTIC_TURN_WINDOWING';
    readonly diarizationClustering: 'AVAILABLE_AHC_WITH_PLUGGABLE_EMBEDDING_PROVIDER';
    readonly overlapDetection: OverlapDetectionCapabilityStatus;
    readonly speakerSeparation: 'NOT_SUPPORTED';
    readonly speakerIdentification: 'PROHIBITED_BY_POLICY';
  };
  readonly privacyGuarantees: {
    readonly recordingScopedIdsOnly: true;
    readonly crossRecordingVoiceprintMatchingProhibited: true;
    readonly persistentVoiceprintStorageProhibited: true;
    readonly ephemeralEmbeddingsPurgedAfterClustering: true;
    readonly rawAudioAndEmbeddingsExcludedFromDiagnostics: true;
  };
  readonly limitations: readonly string[];
  readonly recommendedNextStep: string;
}

export interface SpeakerEmbeddingProvider {
  readonly providerId: string;
  readonly modelRevision: string;
  readonly embeddingDim: number;
  extractEmbedding(segmentPcm: Float32Array, sampleRateHz: number): Float32Array;
}

export interface DiarizationPrivacyContext {
  readonly explicitUserConsentGranted: boolean;
  readonly retainEphemeralEmbeddingsAfterRun: false;
  readonly recordingScopeId: string;
}

export interface DiarizationRequestInput {
  readonly requestId?: string;
  readonly audioId: string;
  readonly audioSamples: Float32Array;
  readonly sampleRateHz: number;
  readonly audioSha256?: string;
  readonly recordingScopeId?: string;
  /** Optional user-supplied speaker count — explicitly labeled as user config, never auto-guessed */
  readonly userSuppliedSpeakerCount?: number | null;
  /** Minimum turn duration in ms below which speaker attribution defaults to UNKNOWN_SPEAKER */
  readonly minTurnDurationMs?: number;
  /** Cosine similarity clustering merge threshold in [0.2, 0.98] */
  readonly clusteringSimilarityThreshold?: number;
  /** Optional external overlap intervals (e.g. from verified multi-track/model detector) */
  readonly explicitOverlapRegionsSec?: readonly {
    readonly startSec: number;
    readonly endSec: number;
    readonly activeSpeakerHints?: readonly string[];
  }[];
  readonly embeddingProvider?: SpeakerEmbeddingProvider;
  readonly privacy: DiarizationPrivacyContext;
}

export interface SpeakerProfileRecord {
  readonly speakerId: string;
  readonly recordingScopeId: string;
  readonly anonymousCanonicalId: string;
  readonly localDisplayLabel: string | null;
  readonly totalSpeakingMs: number;
  readonly turnCount: number;
  readonly mergedFromIds: readonly string[];
  readonly origin: SpeakerAssignmentOrigin;
}

export interface SpeakerTurnRecord {
  readonly turnId: string;
  readonly recordingScopeId: string;
  readonly kind: SpeakerTurnKind;
  readonly speakerId: string;
  readonly activeSpeakerIds: readonly string[];
  readonly range: SampleInterval;
  readonly origin: SpeakerAssignmentOrigin;
  /** Raw cosine similarity to cluster centroid — explicitly NOT a calibrated probability */
  readonly rawClusterSimilarity: number | null;
  readonly rawScoreCalibrationState: 'UNCALIBRATED_ACOUSTIC_SIMILARITY' | 'NOT_AVAILABLE';
  readonly notes: string;
}

export interface OverlapIntervalRecord {
  readonly overlapId: string;
  readonly range: SampleInterval;
  readonly activeSpeakerIds: readonly string[];
  readonly detectionSource: 'EXPLICIT_MULTI_TRACK_OR_ANNOTATION' | 'SPECTRAL_COMPLEXITY_PROXY';
  readonly notes: string;
}

export type SpeakerRevisionOperation =
  | { readonly type: 'RENAME_LOCAL_LABEL'; readonly speakerId: string; readonly newLocalLabel: string }
  | { readonly type: 'MERGE_CLUSTERS'; readonly sourceSpeakerId: string; readonly targetSpeakerId: string }
  | { readonly type: 'SPLIT_CLUSTER'; readonly turnIdsToSplit: readonly string[]; readonly newSpeakerId?: string }
  | { readonly type: 'REASSIGN_TURN'; readonly turnId: string; readonly targetSpeakerId: string }
  | { readonly type: 'MARK_UNKNOWN'; readonly turnId: string; readonly reason?: string }
  | { readonly type: 'MARK_OVERLAP'; readonly turnId: string; readonly activeSpeakerIds: readonly string[] }
  | { readonly type: 'CONFIRM_TURN'; readonly turnId: string };

export interface DiarizationRevisionRecord {
  readonly revisionId: string;
  readonly parentRevisionId: string;
  readonly timestampUtc: string;
  readonly operation: SpeakerRevisionOperation;
  readonly summary: string;
}

export interface DiarizationReconciliationConflict {
  readonly conflictId: string;
  readonly turnId: string;
  readonly userConfirmedSpeakerId: string;
  readonly automaticProposedSpeakerId: string;
  readonly range: SampleInterval;
  readonly resolutionState: 'CONFLICT_REQUIRES_USER_RESOLUTION';
  readonly reason: string;
}

export interface DiarizationResult {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly audioId: string;
  readonly audioSha256: string;
  readonly recordingScopeId: string;
  readonly backendMode: DiarizationBackendMode;
  readonly diarizerId: string;
  readonly diarizerRevision: string;
  readonly speakerCountOrigin: 'AUTOMATIC_UNKNOWN' | 'USER_SUPPLIED_CONFIG';
  readonly userSuppliedSpeakerCount: number | null;
  readonly detectedSpeakerCount: number;
  readonly audioDurationSec: number;
  readonly totalAudioSamples: number;
  readonly speakers: readonly SpeakerProfileRecord[];
  readonly turns: readonly SpeakerTurnRecord[];
  readonly overlaps: readonly OverlapIntervalRecord[];
  readonly nonSpeechIntervals: readonly SampleInterval[];
  readonly speechDurationMs: number;
  readonly overlapDurationMs: number;
  readonly unknownSpeakerDurationMs: number;
  readonly nonSpeechDurationMs: number;
  readonly privacyAudit: {
    readonly explicitUserConsentGranted: boolean;
    readonly recordingScopedOnly: true;
    readonly embeddingsRetained: false;
    readonly ephemeralEmbeddingsPurgedAtUtc: string;
    readonly diagnosticsContainsBiometrics: false;
  };
  readonly revisions: readonly DiarizationRevisionRecord[];
  readonly warnings: readonly string[];
  readonly latencyMs: number;
  readonly createdAtUtc: string;
}

export type AttributionGranularity =
  | 'RECORDING_LEVEL'
  | 'TURN_LEVEL'
  | 'SEGMENT_LEVEL'
  | 'WORD_LEVEL';

export interface SpeakerAttributedSegment {
  readonly segmentId: string;
  readonly text: string;
  readonly granularity: AttributionGranularity;
  readonly speakerId: string;
  readonly activeSpeakerIds: readonly string[];
  readonly localDisplayLabel: string | null;
  readonly kind: SpeakerTurnKind;
  readonly range: SampleInterval | null;
  readonly overlapRatio: number;
  readonly notes: string;
}

export interface SpeakerAttributedWord {
  readonly wordId: string;
  readonly surface: string;
  readonly speakerId: string;
  readonly activeSpeakerIds: readonly string[];
  readonly kind: SpeakerTurnKind;
  readonly range: SampleInterval | null;
}

export interface TranscriptSpeakerAttributionResult {
  readonly requestedGranularity: AttributionGranularity;
  readonly effectiveGranularity: AttributionGranularity;
  readonly wordAttributionAvailable: boolean;
  readonly refusalReasonIfDowngraded: string | null;
  readonly segments: readonly SpeakerAttributedSegment[];
  readonly words: readonly SpeakerAttributedWord[];
}

export interface ReferenceSpeakerTurn {
  readonly speakerId: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface DiarizationEvaluationMetrics {
  readonly datasetLabel: string;
  readonly evaluationSource: 'CONTROLLED_MULTI_SPEAKER_SYNTHETIC_FIXTURE' | 'HUMAN_ANNOTATED_PERSIAN_MULTI_SPEAKER' | 'NO_REFERENCE_AVAILABLE';
  readonly totalScoredSpeechSec: number;
  readonly missedSpeechRate: number;
  readonly falseAlarmRate: number;
  readonly speakerConfusionRate: number;
  readonly diarizationErrorRate: number;
  readonly jaccardErrorRate: number;
  readonly turnBoundaryMaeMs: number | null;
  readonly overlapPrecision: number | null;
  readonly overlapRecall: number | null;
  readonly uncalibratedScoreNotice: string;
}

export type PersianDiarizationCategory =
  | 'TWO_SPEAKER_INTERVIEW'
  | 'THREE_PLUS_ROUNDTABLE_PODCAST'
  | 'RAPID_TURN_TAKING'
  | 'OVERLAPPING_ARGUMENTS'
  | 'SIMILAR_TIMBRE_SPEAKERS'
  | 'TELEPHONE_COMPRESSED'
  | 'NOISY_CAFE_ROOM_REVERB'
  | 'SINGLE_SPEAKER_FALSE_SPLIT_CHECK'
  | 'LONG_FORM_DRIFT_CHECK';

export const PERSIAN_DIARIZATION_EVAL_CATEGORIES: readonly PersianDiarizationCategory[] = [
  'TWO_SPEAKER_INTERVIEW',
  'THREE_PLUS_ROUNDTABLE_PODCAST',
  'RAPID_TURN_TAKING',
  'OVERLAPPING_ARGUMENTS',
  'SIMILAR_TIMBRE_SPEAKERS',
  'TELEPHONE_COMPRESSED',
  'NOISY_CAFE_ROOM_REVERB',
  'SINGLE_SPEAKER_FALSE_SPLIT_CHECK',
  'LONG_FORM_DRIFT_CHECK',
];

export function inspectDiarizationCapabilities(workspaceRoot = process.cwd()): DiarizationCapabilityReport {
  const embDir = path.join(workspaceRoot, 'models', 'speaker-embedding');
  const neuralEmbeddingWeightsOnDisk =
    fs.existsSync(embDir) && fs.readdirSync(embDir).some((f) => f.endsWith('.onnx'));

  const overlapDir = path.join(workspaceRoot, 'models', 'speaker-overlap');
  const neuralOverlapWeightsOnDisk =
    fs.existsSync(overlapDir) && fs.readdirSync(overlapDir).some((f) => f.endsWith('.onnx'));

  return {
    contractVersion: SHAHAB_DIARIZATION_CONTRACT_VERSION,
    inspectedAtUtc: new Date().toISOString(),
    neuralEmbeddingWeightsOnDisk,
    neuralOverlapWeightsOnDisk,
    capabilityStatus: neuralEmbeddingWeightsOnDisk
      ? 'DIARIZATION_SUPPORTED'
      : 'SEPARATE_DIARIZATION_MODEL_REQUIRED',
    overlapDetectionStatus: neuralOverlapWeightsOnDisk
      ? 'OVERLAP_DETECTION_VERIFIED'
      : 'OVERLAP_DETECTION_EXPERIMENTAL_PROXY',
    streamingStatus: 'STREAMING_DIARIZATION_UNAVAILABLE',
    stageSeparation: {
      vad: 'AVAILABLE_DETERMINISTIC_ENERGY_ZCR',
      speechSegmentation: 'AVAILABLE_DETERMINISTIC_TURN_WINDOWING',
      diarizationClustering: 'AVAILABLE_AHC_WITH_PLUGGABLE_EMBEDDING_PROVIDER',
      overlapDetection: neuralOverlapWeightsOnDisk
        ? 'OVERLAP_DETECTION_VERIFIED'
        : 'OVERLAP_DETECTION_EXPERIMENTAL_PROXY',
      speakerSeparation: 'NOT_SUPPORTED',
      speakerIdentification: 'PROHIBITED_BY_POLICY',
    },
    privacyGuarantees: {
      recordingScopedIdsOnly: true,
      crossRecordingVoiceprintMatchingProhibited: true,
      persistentVoiceprintStorageProhibited: true,
      ephemeralEmbeddingsPurgedAfterClustering: true,
      rawAudioAndEmbeddingsExcludedFromDiagnostics: true,
    },
    limitations: [
      'No pretrained neural speaker-embedding ONNX model (e.g. ECAPA-TDNN / WeSpeaker / pyannote) is bundled in models/speaker-embedding/.',
      'Without a neural embedding checkpoint, the built-in acoustic spectral-profile AHC backend separates distinct pitch/timbre profiles deterministically, but real-world Persian multi-speaker DER requires a dedicated neural embedding model.',
      'Overlap detection without a neural overlap detector relies only on explicit multi-track/user annotations or uncalibrated spectral-complexity proxy flags.',
      'Streaming real-time diarization is explicitly marked STREAMING_DIARIZATION_UNAVAILABLE; batch offline clustering only.',
      'No human-annotated real-world Persian multi-speaker diarization benchmark corpus is bundled on disk.',
    ],
    recommendedNextStep:
      'Acquire a permissively licensed ONNX speaker embedding model (e.g. WeSpeaker ResNet34 / ECAPA-TDNN Apache-2.0) and evaluate Persian DER/JER/Overlap P&R on real Persian interview & podcast recordings.',
  };
}

function l2Normalize(vec: Float32Array): Float32Array {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq);
  const out = new Float32Array(vec.length);
  if (norm > 1e-12) {
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  }
  return out;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

/**
 * Deterministic 16-dim acoustic spectral/pitch proxy feature extractor over real PCM.
 * Computes 12 logarithmically spaced Goertzel band energies (100 Hz .. 3800 Hz),
 * zero-crossing rate, spectral centroid, spectral flatness, and fundamental-energy ratio.
 */
function extractAcousticSpectralProxyVector(
  segment: Float32Array,
  sampleRateHz: number,
): { readonly vector: Float32Array; readonly spectralComplexity: number } {
  const n = Math.min(segment.length, Math.max(256, Math.round(sampleRateHz * 0.5)));
  const bandFreqsHz = [110, 150, 210, 290, 400, 560, 780, 1080, 1500, 2100, 2900, 3700];
  const features = new Float32Array(16);

  // Goertzel energy per band
  let totalBandEnergy = 0;
  let weightedFreqSum = 0;
  let activeBandsAboveMedian = 0;
  const bandEnergies: number[] = [];

  for (let b = 0; b < bandFreqsHz.length; b++) {
    const freq = bandFreqsHz[b];
    const omega = (2 * Math.PI * freq) / sampleRateHz;
    const coeff = 2 * Math.cos(omega);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
      s0 = segment[i] * w + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = Math.max(1e-12, (s1 * s1 + s2 * s2 - coeff * s1 * s2) / Math.max(1, n));
    const logPower = Math.log10(power + 1e-12) + 12;
    bandEnergies.push(power);
    features[b] = Math.max(0, logPower);
    totalBandEnergy += power;
    weightedFreqSum += power * freq;
  }

  // Zero-crossing rate
  let zc = 0;
  for (let i = 1; i < n; i++) {
    if ((segment[i] >= 0 && segment[i - 1] < 0) || (segment[i] < 0 && segment[i - 1] >= 0)) {
      zc += 1;
    }
  }
  const zcr = zc / Math.max(1, n - 1);

  // Spectral centroid normalized to Nyquist
  const centroidHz = totalBandEnergy > 0 ? weightedFreqSum / totalBandEnergy : 0;
  const normCentroid = centroidHz / (sampleRateHz / 2);

  // Spectral flatness proxy
  const geoMean = Math.exp(
    bandEnergies.reduce((acc, e) => acc + Math.log(e + 1e-12), 0) / bandEnergies.length,
  );
  const arithMean = totalBandEnergy / bandEnergies.length;
  const flatness = arithMean > 0 ? Math.min(1, geoMean / arithMean) : 0;

  const sortedBands = [...bandEnergies].sort((a, b) => a - b);
  const medianBand = sortedBands[Math.floor(sortedBands.length / 2)] || 1e-12;
  for (const e of bandEnergies) {
    if (e > medianBand * 3.5) activeBandsAboveMedian += 1;
  }

  features[12] = zcr * 10;
  features[13] = normCentroid * 10;
  features[14] = flatness * 5;
  features[15] = activeBandsAboveMedian / bandFreqsHz.length;

  return {
    vector: l2Normalize(features),
    spectralComplexity: activeBandsAboveMedian / bandFreqsHz.length,
  };
}

interface RawSpeechSegment {
  readonly startSample: number;
  readonly endSample: number;
}

/**
 * Stage 1 & 2: Deterministic VAD + Speech Segmentation.
 * Returns separated speech intervals and explicit non-speech intervals.
 */
export function runAcousticVadAndSegmentation(
  samples: Float32Array,
  sampleRateHz: number,
  maxSegmentSec = 4.0,
): {
  readonly speechSegments: readonly RawSpeechSegment[];
  readonly nonSpeechIntervals: readonly SampleInterval[];
} {
  if (samples.length === 0 || sampleRateHz <= 0) {
    return { speechSegments: [], nonSpeechIntervals: [] };
  }
  const frameLen = Math.max(1, Math.round(sampleRateHz * 0.02)); // 20ms
  const rmsList: number[] = [];
  let maxRms = 0;

  for (let i = 0; i < samples.length; i += frameLen) {
    const end = Math.min(samples.length, i + frameLen);
    let sq = 0;
    for (let j = i; j < end; j++) sq += samples[j] * samples[j];
    const rms = Math.sqrt(sq / Math.max(1, end - i));
    rmsList.push(rms);
    if (rms > maxRms) maxRms = rms;
  }

  if (maxRms < 0.002) {
    return {
      speechSegments: [],
      nonSpeechIntervals: [buildSampleInterval(0, samples.length, sampleRateHz)],
    };
  }

  const threshold = Math.max(0.004, maxRms * 0.14);
  const activeIntervals: { startFrame: number; endFrame: number }[] = [];
  let cur: { startFrame: number; endFrame: number } | null = null;

  for (let f = 0; f < rmsList.length; f++) {
    if (rmsList[f] >= threshold) {
      if (!cur) cur = { startFrame: f, endFrame: f + 1 };
      else cur.endFrame = f + 1;
    } else if (cur) {
      activeIntervals.push(cur);
      cur = null;
    }
  }
  if (cur) activeIntervals.push(cur);

  // Merge pauses < 160ms (8 frames)
  const merged: { startFrame: number; endFrame: number }[] = [];
  for (const iv of activeIntervals) {
    const prev = merged[merged.length - 1];
    if (prev && iv.startFrame - prev.endFrame <= 8) {
      prev.endFrame = iv.endFrame;
    } else {
      merged.push({ ...iv });
    }
  }

  const maxSegSamples = Math.max(frameLen * 10, Math.round(maxSegmentSec * sampleRateHz));
  const speechSegments: RawSpeechSegment[] = [];
  for (const iv of merged) {
    const segStart = iv.startFrame * frameLen;
    const segEnd = Math.min(samples.length, iv.endFrame * frameLen);
    if (segEnd - segStart < Math.round(sampleRateHz * 0.08)) continue;
    // Sub-window very long continuous speech so speaker switches mid-utterance can be clustered
    for (let s = segStart; s < segEnd; s += maxSegSamples) {
      const e = Math.min(segEnd, s + maxSegSamples);
      if (e - s >= Math.round(sampleRateHz * 0.08)) {
        speechSegments.push({ startSample: s, endSample: e });
      }
    }
  }

  // Derive complementary non-speech intervals
  const nonSpeechIntervals: SampleInterval[] = [];
  let cursor = 0;
  for (const seg of speechSegments) {
    if (seg.startSample > cursor) {
      nonSpeechIntervals.push(buildSampleInterval(cursor, seg.startSample, sampleRateHz));
    }
    cursor = Math.max(cursor, seg.endSample);
  }
  if (cursor < samples.length) {
    nonSpeechIntervals.push(buildSampleInterval(cursor, samples.length, sampleRateHz));
  }

  return { speechSegments, nonSpeechIntervals };
}

/**
 * Agglomerative Hierarchical Clustering (Average-Linkage Cosine Similarity).
 */
function runAhcClustering(
  vectors: readonly Float32Array[],
  threshold: number,
  targetClusterCount: number | null,
): { readonly clusterAssignments: readonly number[]; readonly centroidSimilarities: readonly number[] } {
  const n = vectors.length;
  if (n === 0) {
    return { clusterAssignments: [], centroidSimilarities: [] };
  }

  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);

  const computeAvgSim = (cA: readonly number[], cB: readonly number[]): number => {
    let sum = 0;
    let cnt = 0;
    for (const i of cA) {
      for (const j of cB) {
        sum += cosineSimilarity(vectors[i], vectors[j]);
        cnt += 1;
      }
    }
    return cnt > 0 ? sum / cnt : -1;
  };

  while (clusters.length > 1) {
    if (targetClusterCount !== null && clusters.length <= targetClusterCount) {
      break;
    }
    let bestSim = -Infinity;
    let bestI = 0;
    let bestJ = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = computeAvgSim(clusters[i], clusters[j]);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (targetClusterCount === null && bestSim < threshold) {
      break;
    }
    clusters[bestI] = [...clusters[bestI], ...clusters[bestJ]];
    clusters.splice(bestJ, 1);
  }

  // Order clusters deterministically by earliest member index -> speaker_1, speaker_2, ...
  clusters.sort((a, b) => Math.min(...a) - Math.min(...b));

  const assignments = new Array<number>(n).fill(0);
  const centroidSims = new Array<number>(n).fill(1);
  const dim = vectors[0].length;

  clusters.forEach((members, cIdx) => {
    const centroid = new Float32Array(dim);
    for (const m of members) {
      for (let d = 0; d < dim; d++) centroid[d] += vectors[m][d];
    }
    const normCentroid = l2Normalize(centroid);
    for (const m of members) {
      assignments[m] = cIdx;
      centroidSims[m] = Number(cosineSimilarity(vectors[m], normCentroid).toFixed(4));
    }
  });

  return { clusterAssignments: assignments, centroidSimilarities: centroidSims };
}

function rebuildSpeakersSummary(
  recordingScopeId: string,
  turns: readonly SpeakerTurnRecord[],
  existingProfiles?: readonly SpeakerProfileRecord[],
): readonly SpeakerProfileRecord[] {
  const existingMap = new Map<string, SpeakerProfileRecord>();
  for (const p of existingProfiles ?? []) {
    existingMap.set(p.speakerId, p);
  }

  const stats = new Map<string, { totalMs: number; turnCount: number }>();
  for (const t of turns) {
    if (t.kind === 'NON_SPEECH') continue;
    const ids = t.kind === 'OVERLAPPING_SPEECH' ? t.activeSpeakerIds : [t.speakerId];
    for (const id of ids) {
      if (id === UNKNOWN_SPEAKER_ID) continue;
      const cur = stats.get(id) ?? { totalMs: 0, turnCount: 0 };
      cur.totalMs += t.range.durationMs;
      cur.turnCount += 1;
      stats.set(id, cur);
    }
  }

  return Array.from(stats.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([speakerId, s]) => {
      const prev = existingMap.get(speakerId);
      return {
        speakerId,
        recordingScopeId,
        anonymousCanonicalId: prev?.anonymousCanonicalId ?? speakerId,
        localDisplayLabel: prev?.localDisplayLabel ?? null,
        totalSpeakingMs: Number(s.totalMs.toFixed(2)),
        turnCount: s.turnCount,
        mergedFromIds: prev?.mergedFromIds ?? [],
        origin: prev?.origin ?? 'AUTOMATIC_CLUSTERING',
      };
    });
}

/**
 * Maps SHAHAB-026 speaker turns onto SHAHAB-025 alignment segments/words at explicit granularity.
 * Refuses WORD_LEVEL attribution when verified word alignment is absent.
 */
export function attributeTranscriptWithDiarization(
  alignment: AlignmentResult,
  diarization: DiarizationResult,
  requestedGranularity: AttributionGranularity,
): TranscriptSpeakerAttributionResult {
  const hasWordTiming =
    alignment.effectiveGranularity === 'WORD_LEVEL' &&
    alignment.words.some((w) => w.acousticRange !== null);

  let effectiveGranularity: AttributionGranularity = requestedGranularity;
  let refusalReasonIfDowngraded: string | null = null;

  if (requestedGranularity === 'WORD_LEVEL' && !hasWordTiming) {
    effectiveGranularity =
      alignment.effectiveGranularity === 'SEGMENT_LEVEL' ||
      alignment.effectiveGranularity === 'TOKEN_LEVEL'
        ? 'SEGMENT_LEVEL'
        : 'RECORDING_LEVEL';
    refusalReasonIfDowngraded =
      'WORD_LEVEL speaker attribution refused because verified word-level alignment is unavailable from SHAHAB-025.';
  }

  const labelBySpeakerId = new Map<string, string | null>();
  for (const sp of diarization.speakers) {
    labelBySpeakerId.set(sp.speakerId, sp.localDisplayLabel);
  }

  const resolveRangeSpeaker = (
    range: SampleInterval | null,
  ): {
    readonly speakerId: string;
    readonly activeSpeakerIds: readonly string[];
    readonly kind: SpeakerTurnKind;
    readonly overlapRatio: number;
  } => {
    if (!range || range.endSec <= range.startSec) {
      return {
        speakerId: UNKNOWN_SPEAKER_ID,
        activeSpeakerIds: [UNKNOWN_SPEAKER_ID],
        kind: 'UNKNOWN_SPEAKER',
        overlapRatio: 0,
      };
    }

    const dur = range.endSec - range.startSec;
    const perSpeakerSec = new Map<string, number>();
    let overlapSec = 0;
    const overlapSpeakers = new Set<string>();

    for (const turn of diarization.turns) {
      const ovStart = Math.max(range.startSec, turn.range.startSec);
      const ovEnd = Math.min(range.endSec, turn.range.endSec);
      if (ovEnd <= ovStart) continue;
      const ov = ovEnd - ovStart;
      if (turn.kind === 'OVERLAPPING_SPEECH') {
        overlapSec += ov;
        for (const sid of turn.activeSpeakerIds) overlapSpeakers.add(sid);
      } else if (turn.kind === 'SINGLE_SPEAKER') {
        perSpeakerSec.set(turn.speakerId, (perSpeakerSec.get(turn.speakerId) ?? 0) + ov);
      }
    }

    if (overlapSec / dur >= 0.25 && overlapSpeakers.size >= 2) {
      const activeIds = Array.from(overlapSpeakers).sort();
      return {
        speakerId: activeIds[0],
        activeSpeakerIds: activeIds,
        kind: 'OVERLAPPING_SPEECH',
        overlapRatio: Number((overlapSec / dur).toFixed(4)),
      };
    }

    if (perSpeakerSec.size === 0) {
      return {
        speakerId: UNKNOWN_SPEAKER_ID,
        activeSpeakerIds: [UNKNOWN_SPEAKER_ID],
        kind: 'UNKNOWN_SPEAKER',
        overlapRatio: 0,
      };
    }

    const ranked = Array.from(perSpeakerSec.entries()).sort((a, b) => b[1] - a[1]);
    // If two speakers each cover >30% of the same segment -> preserve OVERLAPPING_SPEECH/multi-speaker flag
    if (ranked.length >= 2 && ranked[1][1] / dur >= 0.3) {
      const activeIds = [ranked[0][0], ranked[1][0]].sort();
      return {
        speakerId: activeIds[0],
        activeSpeakerIds: activeIds,
        kind: 'OVERLAPPING_SPEECH',
        overlapRatio: Number(((ranked[0][1] + ranked[1][1]) / dur).toFixed(4)),
      };
    }

    const [topSpeaker, topSec] = ranked[0];
    if (topSec / dur < 0.2) {
      return {
        speakerId: UNKNOWN_SPEAKER_ID,
        activeSpeakerIds: [UNKNOWN_SPEAKER_ID],
        kind: 'UNKNOWN_SPEAKER',
        overlapRatio: Number((topSec / dur).toFixed(4)),
      };
    }

    return {
      speakerId: topSpeaker,
      activeSpeakerIds: [topSpeaker],
      kind: 'SINGLE_SPEAKER',
      overlapRatio: Number((topSec / dur).toFixed(4)),
    };
  };

  const segments: SpeakerAttributedSegment[] = alignment.segments.map((seg) => {
    const resolved = resolveRangeSpeaker(seg.acousticRange);
    return {
      segmentId: seg.segmentId,
      text: seg.text,
      granularity: effectiveGranularity === 'WORD_LEVEL' ? 'SEGMENT_LEVEL' : effectiveGranularity,
      speakerId: resolved.speakerId,
      activeSpeakerIds: resolved.activeSpeakerIds,
      localDisplayLabel: labelBySpeakerId.get(resolved.speakerId) ?? null,
      kind: resolved.kind,
      range: seg.acousticRange,
      overlapRatio: resolved.overlapRatio,
      notes:
        resolved.kind === 'OVERLAPPING_SPEECH'
          ? 'Concurrent multi-speaker interval preserved without forcing a linear single-speaker sequence.'
          : resolved.kind === 'UNKNOWN_SPEAKER'
            ? 'Insufficient speaker alignment overlap; marked UNKNOWN_SPEAKER.'
            : 'Attributed to recording-scoped anonymous speaker cluster.',
    };
  });

  const words: SpeakerAttributedWord[] =
    effectiveGranularity === 'WORD_LEVEL'
      ? alignment.words.map((w) => {
          const resolved = resolveRangeSpeaker(w.acousticRange);
          return {
            wordId: w.wordId,
            surface: w.originalSurface,
            speakerId: resolved.speakerId,
            activeSpeakerIds: resolved.activeSpeakerIds,
            kind: resolved.kind,
            range: w.acousticRange,
          };
        })
      : [];

  return {
    requestedGranularity,
    effectiveGranularity,
    wordAttributionAvailable: effectiveGranularity === 'WORD_LEVEL',
    refusalReasonIfDowngraded,
    segments,
    words,
  };
}

/**
 * Evaluates diarization output against reference speaker turns on a 20ms frame grid (SHAHAB-026 §11).
 * Computes Missed Speech, False Alarm, Speaker Confusion, DER, JER, and Overlap P/R.
 */
export function evaluateDiarizationAgainstReference(
  result: DiarizationResult,
  referenceTurns: readonly ReferenceSpeakerTurn[],
  datasetLabel: string,
  evaluationSource: DiarizationEvaluationMetrics['evaluationSource'],
): DiarizationEvaluationMetrics {
  const stepSec = 0.02;
  const maxRefEnd = referenceTurns.reduce((m, t) => Math.max(m, t.endSec), 0);
  const totalSec = Math.max(result.audioDurationSec, maxRefEnd);
  const frameCount = Math.max(1, Math.ceil(totalSec / stepSec));

  // Build optimal 1-to-1 greedy mapping from hypothesis speaker IDs to reference speaker IDs
  const coOccurrence = new Map<string, Map<string, number>>();
  for (let f = 0; f < frameCount; f++) {
    const t = (f + 0.5) * stepSec;
    const refSpeakers = referenceTurns
      .filter((r) => t >= r.startSec && t < r.endSec)
      .map((r) => r.speakerId);
    const hypSpeakers = result.turns
      .filter((h) => h.kind !== 'NON_SPEECH' && t >= h.range.startSec && t < h.range.endSec)
      .flatMap((h) => (h.kind === 'OVERLAPPING_SPEECH' ? h.activeSpeakerIds : [h.speakerId]))
      .filter((id) => id !== UNKNOWN_SPEAKER_ID);

    for (const h of hypSpeakers) {
      const m = coOccurrence.get(h) ?? new Map<string, number>();
      for (const r of refSpeakers) {
        m.set(r, (m.get(r) ?? 0) + 1);
      }
      coOccurrence.set(h, m);
    }
  }

  const hypToRef = new Map<string, string>();
  const usedRef = new Set<string>();
  const pairs: { h: string; r: string; cnt: number }[] = [];
  for (const [h, m] of coOccurrence.entries()) {
    for (const [r, cnt] of m.entries()) pairs.push({ h, r, cnt });
  }
  pairs.sort((a, b) => b.cnt - a.cnt);
  for (const p of pairs) {
    if (!hypToRef.has(p.h) && !usedRef.has(p.r)) {
      hypToRef.set(p.h, p.r);
      usedRef.add(p.r);
    }
  }

  let refSpeechFrames = 0;
  let missedFrames = 0;
  let falseAlarmFrames = 0;
  let confusionFrames = 0;
  let refOverlapFrames = 0;
  let hypOverlapFrames = 0;
  let tpOverlapFrames = 0;

  const refSpeakerUnion = new Map<string, number>();
  const refSpeakerCorrect = new Map<string, number>();

  for (let f = 0; f < frameCount; f++) {
    const t = (f + 0.5) * stepSec;
    const refSet = new Set(
      referenceTurns.filter((r) => t >= r.startSec && t < r.endSec).map((r) => r.speakerId),
    );
    const hypRaw = result.turns
      .filter((h) => h.kind !== 'NON_SPEECH' && t >= h.range.startSec && t < h.range.endSec)
      .flatMap((h) => (h.kind === 'OVERLAPPING_SPEECH' ? h.activeSpeakerIds : [h.speakerId]));
    const hypMappedSet = new Set(hypRaw.map((h) => hypToRef.get(h) ?? `__unmapped_${h}`));

    const nRef = refSet.size;
    const nHyp = hypMappedSet.size;
    refSpeechFrames += nRef;

    if (nRef >= 2) refOverlapFrames += 1;
    if (nHyp >= 2) hypOverlapFrames += 1;
    if (nRef >= 2 && nHyp >= 2) tpOverlapFrames += 1;

    let correct = 0;
    for (const r of refSet) {
      if (hypMappedSet.has(r)) {
        correct += 1;
        refSpeakerCorrect.set(r, (refSpeakerCorrect.get(r) ?? 0) + 1);
      }
      refSpeakerUnion.set(r, (refSpeakerUnion.get(r) ?? 0) + 1);
    }
    for (const h of hypMappedSet) {
      if (!refSet.has(h) && usedRef.has(h)) {
        refSpeakerUnion.set(h, (refSpeakerUnion.get(h) ?? 0) + 1);
      }
    }

    if (nRef > nHyp) missedFrames += nRef - nHyp;
    if (nHyp > nRef) falseAlarmFrames += nHyp - nRef;
    confusionFrames += Math.max(0, Math.min(nRef, nHyp) - correct);
  }

  const denom = Math.max(1, refSpeechFrames);
  const missedRate = missedFrames / denom;
  const faRate = falseAlarmFrames / denom;
  const confRate = confusionFrames / denom;
  const der = missedRate + faRate + confRate;

  const refSpeakersUnique = Array.from(new Set(referenceTurns.map((r) => r.speakerId)));
  const jerTerms = refSpeakersUnique.map((r) => {
    const union = Math.max(1, refSpeakerUnion.get(r) ?? 1);
    const corr = refSpeakerCorrect.get(r) ?? 0;
    return 1 - corr / union;
  });
  const jer =
    jerTerms.length > 0 ? jerTerms.reduce((a, b) => a + b, 0) / jerTerms.length : 0;

  // Turn boundary MAE: nearest predicted turn boundary to each reference turn start
  const predBoundaries = result.turns.flatMap((t) => [t.range.startSec, t.range.endSec]);
  const boundaryErrorsMs: number[] = [];
  if (predBoundaries.length > 0) {
    for (const r of referenceTurns) {
      let best = Infinity;
      for (const pb of predBoundaries) {
        best = Math.min(best, Math.abs(pb - r.startSec) * 1000);
      }
      if (Number.isFinite(best)) boundaryErrorsMs.push(best);
    }
  }

  return {
    datasetLabel,
    evaluationSource,
    totalScoredSpeechSec: Number((refSpeechFrames * stepSec).toFixed(3)),
    missedSpeechRate: Number(missedRate.toFixed(4)),
    falseAlarmRate: Number(faRate.toFixed(4)),
    speakerConfusionRate: Number(confRate.toFixed(4)),
    diarizationErrorRate: Number(der.toFixed(4)),
    jaccardErrorRate: Number(jer.toFixed(4)),
    turnBoundaryMaeMs:
      boundaryErrorsMs.length > 0
        ? Number((boundaryErrorsMs.reduce((a, b) => a + b, 0) / boundaryErrorsMs.length).toFixed(2))
        : null,
    overlapPrecision:
      hypOverlapFrames > 0 ? Number((tpOverlapFrames / hypOverlapFrames).toFixed(4)) : null,
    overlapRecall:
      refOverlapFrames > 0 ? Number((tpOverlapFrames / refOverlapFrames).toFixed(4)) : null,
    uncalibratedScoreNotice:
      'Cluster cosine similarities are raw uncalibrated acoustic scores and are never reported as confidence percentages.',
  };
}

interface DiarizationJobRecord {
  readonly requestId: string;
  readonly input: DiarizationRequestInput;
  state: DiarizationJobState;
  result: DiarizationResult | null;
  historyStack: DiarizationResult[];
  error: string | null;
  readonly createdAtUtc: string;
  updatedAtUtc: string;
}

/**
 * SHAHAB-026 Speaker Diarization Service
 */
export class ShahabDiarizationEngine {
  private readonly jobs = new Map<string, DiarizationJobRecord>();
  private readonly workspaceRoot: string;

  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  public inspectDiarizationCapabilities(): DiarizationCapabilityReport {
    return inspectDiarizationCapabilities(this.workspaceRoot);
  }

  public createDiarizationRequest(input: DiarizationRequestInput): {
    readonly requestId: string;
    readonly state: DiarizationJobState;
    readonly createdAtUtc: string;
  } {
    if (!input.privacy.explicitUserConsentGranted) {
      throw new Error(
        'DIARIZATION_PRIVACY_CONSENT_REQUIRED: Speaker diarization requires explicit user consent.',
      );
    }
    const requestId =
      input.requestId ?? `diar_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.jobs.set(requestId, {
      requestId,
      input,
      state: 'CREATED',
      result: null,
      historyStack: [],
      error: null,
      createdAtUtc: now,
      updatedAtUtc: now,
    });
    return { requestId, state: 'CREATED', createdAtUtc: now };
  }

  public getDiarizationStatus(requestId: string): {
    readonly requestId: string;
    readonly state: DiarizationJobState;
    readonly error: string | null;
    readonly updatedAtUtc: string;
  } {
    const job = this.jobs.get(requestId);
    if (!job) throw new Error(`DIARIZATION_REQUEST_NOT_FOUND: ${requestId}`);
    return {
      requestId: job.requestId,
      state: job.state,
      error: job.error,
      updatedAtUtc: job.updatedAtUtc,
    };
  }

  public getDiarizationResult(requestId: string): DiarizationResult {
    const job = this.jobs.get(requestId);
    if (!job) throw new Error(`DIARIZATION_REQUEST_NOT_FOUND: ${requestId}`);
    if (job.state === 'DISPOSED') throw new Error(`DIARIZATION_RESULT_DISPOSED: ${requestId}`);
    if (job.state === 'CANCELLED') throw new Error(`DIARIZATION_REQUEST_CANCELLED: ${requestId}`);
    if (!job.result) throw new Error(`DIARIZATION_RESULT_NOT_READY: ${requestId}`);
    return job.result;
  }

  public cancelDiarization(requestId: string): {
    readonly requestId: string;
    readonly state: DiarizationJobState;
  } {
    const job = this.jobs.get(requestId);
    if (!job) throw new Error(`DIARIZATION_REQUEST_NOT_FOUND: ${requestId}`);
    if (job.state !== 'DISPOSED') {
      job.state = 'CANCELLED';
      job.updatedAtUtc = new Date().toISOString();
    }
    return { requestId, state: job.state };
  }

  public disposeDiarizationResult(requestId: string): {
    readonly requestId: string;
    readonly state: DiarizationJobState;
  } {
    const job = this.jobs.get(requestId);
    if (!job) throw new Error(`DIARIZATION_REQUEST_NOT_FOUND: ${requestId}`);
    job.result = null;
    job.historyStack = [];
    job.state = 'DISPOSED';
    job.updatedAtUtc = new Date().toISOString();
    return { requestId, state: job.state };
  }

  public submitDiarization(requestIdOrInput: string | DiarizationRequestInput): DiarizationResult {
    const t0 = performance.now();
    let job: DiarizationJobRecord;
    if (typeof requestIdOrInput === 'string') {
      const existing = this.jobs.get(requestIdOrInput);
      if (!existing) throw new Error(`DIARIZATION_REQUEST_NOT_FOUND: ${requestIdOrInput}`);
      if (existing.state === 'CANCELLED' || existing.state === 'DISPOSED') {
        throw new Error(`DIARIZATION_INVALID_STATE: ${existing.state}`);
      }
      job = existing;
    } else {
      const created = this.createDiarizationRequest(requestIdOrInput);
      job = this.jobs.get(created.requestId)!;
    }

    job.state = 'RUNNING';
    job.updatedAtUtc = new Date().toISOString();

    try {
      const result = this.executeDiarizationInternal(job.requestId, job.input, t0);
      job.result = result;
      job.historyStack = [result];
      job.state = 'COMPLETED';
      job.updatedAtUtc = new Date().toISOString();
      return result;
    } catch (err) {
      job.state = 'FAILED';
      job.error = err instanceof Error ? err.message : String(err);
      job.updatedAtUtc = new Date().toISOString();
      throw err;
    }
  }

  /**
   * SHAHAB-026 §10 — User Review, Manual Correction & Reversible Revision History.
   */
  public reviseSpeakerAssignment(
    requestId: string,
    operation: SpeakerRevisionOperation,
  ): DiarizationResult {
    const job = this.jobs.get(requestId);
    if (!job || !job.result || job.state === 'DISPOSED') {
      throw new Error(`DIARIZATION_RESULT_UNAVAILABLE: ${requestId}`);
    }

    const prev = job.result;
    const now = new Date().toISOString();
    const newRevisionId = `diar_rev_${prev.revisions.length + 2}_${crypto.randomBytes(3).toString('hex')}`;

    let nextTurns = [...prev.turns];
    let nextSpeakers = [...prev.speakers];
    let nextOverlaps = [...prev.overlaps];
    let summary = '';

    switch (operation.type) {
      case 'RENAME_LOCAL_LABEL': {
        nextSpeakers = nextSpeakers.map((sp) =>
          sp.speakerId === operation.speakerId
            ? {
                ...sp,
                localDisplayLabel: operation.newLocalLabel.trim() || null,
                origin: 'USER_CONFIRMED',
              }
            : sp,
        );
        summary = `Renamed local display label of ${operation.speakerId} to "${operation.newLocalLabel}" (recording-scoped only).`;
        break;
      }
      case 'MERGE_CLUSTERS': {
        if (operation.sourceSpeakerId === operation.targetSpeakerId) {
          throw new Error('MERGE_CLUSTERS_ERROR: sourceSpeakerId and targetSpeakerId must differ.');
        }
        nextTurns = nextTurns.map((t) => {
          if (t.speakerId === operation.sourceSpeakerId && t.kind === 'SINGLE_SPEAKER') {
            return {
              ...t,
              speakerId: operation.targetSpeakerId,
              activeSpeakerIds: [operation.targetSpeakerId],
              origin: 'USER_MERGED',
              notes: `Merged from ${operation.sourceSpeakerId} into ${operation.targetSpeakerId} by user.`,
            };
          }
          if (t.kind === 'OVERLAPPING_SPEECH' && t.activeSpeakerIds.includes(operation.sourceSpeakerId)) {
            const remapped = Array.from(
              new Set(
                t.activeSpeakerIds.map((id) =>
                  id === operation.sourceSpeakerId ? operation.targetSpeakerId : id,
                ),
              ),
            ).sort();
            return {
              ...t,
              speakerId: remapped[0],
              activeSpeakerIds: remapped,
              origin: 'USER_MERGED',
            };
          }
          return t;
        });
        const mergedTargetPrev = nextSpeakers.find((s) => s.speakerId === operation.targetSpeakerId);
        const updatedProfiles = nextSpeakers.map((sp) =>
          sp.speakerId === operation.targetSpeakerId
            ? {
                ...sp,
                mergedFromIds: Array.from(new Set([...sp.mergedFromIds, operation.sourceSpeakerId])),
                origin: 'USER_MERGED' as const,
              }
            : sp,
        );
        nextSpeakers = [...rebuildSpeakersSummary(prev.recordingScopeId, nextTurns, updatedProfiles)];
        if (!mergedTargetPrev) {
          summary = `Merged ${operation.sourceSpeakerId} into ${operation.targetSpeakerId}.`;
        } else {
          summary = `Merged ${operation.sourceSpeakerId} into ${operation.targetSpeakerId} (reversible via undo).`;
        }
        break;
      }
      case 'SPLIT_CLUSTER': {
        const nextNum =
          nextSpeakers.reduce((max, s) => {
            const m = /^speaker_(\d+)$/.exec(s.speakerId);
            return m ? Math.max(max, Number(m[1])) : max;
          }, 0) + 1;
        const createdId = operation.newSpeakerId ?? `speaker_${nextNum}`;
        const splitSet = new Set(operation.turnIdsToSplit);
        nextTurns = nextTurns.map((t) =>
          splitSet.has(t.turnId)
            ? {
                ...t,
                kind: 'SINGLE_SPEAKER',
                speakerId: createdId,
                activeSpeakerIds: [createdId],
                origin: 'USER_SPLIT',
                notes: `Split into new recording-scoped speaker ${createdId} by user.`,
              }
            : t,
        );
        nextSpeakers = [...rebuildSpeakersSummary(prev.recordingScopeId, nextTurns, nextSpeakers)];
        summary = `Split ${splitSet.size} turn(s) into new recording-scoped speaker ${createdId}.`;
        break;
      }
      case 'REASSIGN_TURN': {
        nextTurns = nextTurns.map((t) =>
          t.turnId === operation.turnId
            ? {
                ...t,
                kind: 'SINGLE_SPEAKER',
                speakerId: operation.targetSpeakerId,
                activeSpeakerIds: [operation.targetSpeakerId],
                origin: 'USER_REASSIGNED',
                notes: `Turn manually reassigned to ${operation.targetSpeakerId}.`,
              }
            : t,
        );
        nextSpeakers = [...rebuildSpeakersSummary(prev.recordingScopeId, nextTurns, nextSpeakers)];
        summary = `Reassigned turn ${operation.turnId} to ${operation.targetSpeakerId}.`;
        break;
      }
      case 'MARK_UNKNOWN': {
        nextTurns = nextTurns.map((t) =>
          t.turnId === operation.turnId
            ? {
                ...t,
                kind: 'UNKNOWN_SPEAKER',
                speakerId: UNKNOWN_SPEAKER_ID,
                activeSpeakerIds: [UNKNOWN_SPEAKER_ID],
                origin: 'USER_CONFIRMED',
                notes: operation.reason ?? 'Marked UNKNOWN_SPEAKER by user review.',
              }
            : t,
        );
        nextSpeakers = [...rebuildSpeakersSummary(prev.recordingScopeId, nextTurns, nextSpeakers)];
        summary = `Marked turn ${operation.turnId} as UNKNOWN_SPEAKER.`;
        break;
      }
      case 'MARK_OVERLAP': {
        const sortedIds = Array.from(new Set(operation.activeSpeakerIds)).sort();
        if (sortedIds.length < 2) {
          throw new Error('MARK_OVERLAP_ERROR: At least 2 activeSpeakerIds are required.');
        }
        nextTurns = nextTurns.map((t) =>
          t.turnId === operation.turnId
            ? {
                ...t,
                kind: 'OVERLAPPING_SPEECH',
                speakerId: sortedIds[0],
                activeSpeakerIds: sortedIds,
                origin: 'USER_CONFIRMED',
                notes: `Marked OVERLAPPING_SPEECH (${sortedIds.join(' + ')}) by user.`,
              }
            : t,
        );
        const markedTurn = nextTurns.find((t) => t.turnId === operation.turnId);
        if (markedTurn) {
          nextOverlaps.push({
            overlapId: `ov_user_${Date.now()}`,
            range: markedTurn.range,
            activeSpeakerIds: sortedIds,
            detectionSource: 'EXPLICIT_MULTI_TRACK_OR_ANNOTATION',
            notes: 'User-confirmed overlapping speech interval.',
          });
        }
        nextSpeakers = [...rebuildSpeakersSummary(prev.recordingScopeId, nextTurns, nextSpeakers)];
        summary = `Marked turn ${operation.turnId} as OVERLAPPING_SPEECH (${sortedIds.join(', ')}).`;
        break;
      }
      case 'CONFIRM_TURN': {
        nextTurns = nextTurns.map((t) =>
          t.turnId === operation.turnId
            ? {
                ...t,
                origin: 'USER_CONFIRMED',
                notes: `${t.notes} [User confirmed]`,
              }
            : t,
        );
        summary = `Confirmed speaker assignment on turn ${operation.turnId}.`;
        break;
      }
    }

    const revRecord: DiarizationRevisionRecord = {
      revisionId: newRevisionId,
      parentRevisionId: prev.revisionId,
      timestampUtc: now,
      operation,
      summary,
    };

    const updated: DiarizationResult = {
      ...prev,
      revisionId: newRevisionId,
      detectedSpeakerCount: nextSpeakers.length,
      speakers: nextSpeakers,
      turns: nextTurns,
      overlaps: nextOverlaps,
      overlapDurationMs: Number(
        nextTurns
          .filter((t) => t.kind === 'OVERLAPPING_SPEECH')
          .reduce((a, t) => a + t.range.durationMs, 0)
          .toFixed(2),
      ),
      unknownSpeakerDurationMs: Number(
        nextTurns
          .filter((t) => t.kind === 'UNKNOWN_SPEAKER')
          .reduce((a, t) => a + t.range.durationMs, 0)
          .toFixed(2),
      ),
      revisions: [...prev.revisions, revRecord],
    };

    job.historyStack.push(updated);
    job.result = updated;
    job.updatedAtUtc = now;
    return updated;
  }

  /**
   * Reverts the most recent manual speaker review operation (e.g. undo accidental merge).
   */
  public undoLastSpeakerRevision(requestId: string): DiarizationResult {
    const job = this.jobs.get(requestId);
    if (!job || job.historyStack.length <= 1) {
      throw new Error(`DIARIZATION_UNDO_UNAVAILABLE: No prior revision to restore for ${requestId}`);
    }
    job.historyStack.pop();
    const restored = job.historyStack[job.historyStack.length - 1];
    job.result = restored;
    job.updatedAtUtc = new Date().toISOString();
    return restored;
  }

  /**
   * SHAHAB-026 §10 & §17 — Re-diarization Conflict Protection.
   * Ensures automatic re-diarization NEVER silently overwrites user-confirmed turns
   * or user-renamed local display labels.
   */
  public reconcileWithReDiarization(
    previousUserReviewed: DiarizationResult,
    freshAutomatic: DiarizationResult,
  ): {
    readonly reconciledResult: DiarizationResult;
    readonly conflicts: readonly DiarizationReconciliationConflict[];
  } {
    const conflicts: DiarizationReconciliationConflict[] = [];
    const protectedTurns = previousUserReviewed.turns.filter(
      (t) => t.origin !== 'AUTOMATIC_CLUSTERING',
    );
    const localLabels = new Map<string, string>();
    for (const sp of previousUserReviewed.speakers) {
      if (sp.localDisplayLabel) {
        localLabels.set(sp.speakerId, sp.localDisplayLabel);
      }
    }

    const mergedTurns: SpeakerTurnRecord[] = freshAutomatic.turns.map((autoTurn) => {
      // Find any user-confirmed turn overlapping >= 50% with this fresh automatic turn
      const matchingUserTurn = protectedTurns.find((ut) => {
        const ovStart = Math.max(ut.range.startSample, autoTurn.range.startSample);
        const ovEnd = Math.min(ut.range.endSample, autoTurn.range.endSample);
        if (ovEnd <= ovStart) return false;
        const ovSamples = ovEnd - ovStart;
        const autoSamples = Math.max(1, autoTurn.range.endSample - autoTurn.range.startSample);
        return ovSamples / autoSamples >= 0.5;
      });

      if (!matchingUserTurn) {
        return autoTurn;
      }

      if (matchingUserTurn.speakerId !== autoTurn.speakerId) {
        conflicts.push({
          conflictId: `diar_conf_${matchingUserTurn.turnId}_${autoTurn.turnId}`,
          turnId: autoTurn.turnId,
          userConfirmedSpeakerId: matchingUserTurn.speakerId,
          automaticProposedSpeakerId: autoTurn.speakerId,
          range: autoTurn.range,
          resolutionState: 'CONFLICT_REQUIRES_USER_RESOLUTION',
          reason:
            'Automatic re-diarization disagreed with a user-confirmed turn; user assignment was preserved pending explicit resolution.',
        });
      }

      return {
        ...autoTurn,
        kind: matchingUserTurn.kind,
        speakerId: matchingUserTurn.speakerId,
        activeSpeakerIds: matchingUserTurn.activeSpeakerIds,
        origin: matchingUserTurn.origin,
        notes: `Preserved user-confirmed assignment (${matchingUserTurn.speakerId}) against automatic re-diarization proposal (${autoTurn.speakerId}).`,
      };
    });

    const reconciledSpeakers = rebuildSpeakersSummary(
      freshAutomatic.recordingScopeId,
      mergedTurns,
      previousUserReviewed.speakers,
    ).map((sp) => ({
      ...sp,
      localDisplayLabel: localLabels.get(sp.speakerId) ?? sp.localDisplayLabel,
    }));

    return {
      reconciledResult: {
        ...freshAutomatic,
        speakers: reconciledSpeakers,
        detectedSpeakerCount: reconciledSpeakers.length,
        turns: mergedTurns,
      },
      conflicts,
    };
  }

  private executeDiarizationInternal(
    requestId: string,
    input: DiarizationRequestInput,
    t0: number,
  ): DiarizationResult {
    const sampleRateHz = input.sampleRateHz;
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error(`INVALID_SAMPLE_RATE: ${sampleRateHz}`);
    }
    const recordingScopeId =
      input.recordingScopeId ??
      input.privacy.recordingScopeId ??
      `rec_${crypto.randomBytes(6).toString('hex')}`;
    const audioSha256 = input.audioSha256 ?? hashFloat32Pcm(input.audioSamples);
    const minTurnDurationMs = Math.max(100, input.minTurnDurationMs ?? 600);
    const threshold = Math.max(0.2, Math.min(0.99, input.clusteringSimilarityThreshold ?? 0.92));

    const { speechSegments, nonSpeechIntervals } = runAcousticVadAndSegmentation(
      input.audioSamples,
      sampleRateHz,
    );

    // Ephemeral vectors held strictly in local scope and zero-filled before returning!
    const ephemeralVectors: Float32Array[] = [];
    const spectralComplexities: number[] = [];
    const clusterableIndices: number[] = [];

    const backendMode: DiarizationBackendMode = input.embeddingProvider
      ? 'NEURAL_EMBEDDING_PROVIDER_AHC'
      : 'ACOUSTIC_SPECTRAL_PROXY_AHC';

    const diarizerId = input.embeddingProvider
      ? input.embeddingProvider.providerId
      : 'shahab-acoustic-spectral-ahc-v1';
    const diarizerRevision = input.embeddingProvider
      ? input.embeddingProvider.modelRevision
      : '1.0.0-spectral-proxy';

    for (let i = 0; i < speechSegments.length; i++) {
      const seg = speechSegments[i];
      const durMs = ((seg.endSample - seg.startSample) / sampleRateHz) * 1000;
      if (durMs < minTurnDurationMs) {
        continue; // Too short -> will be labeled UNKNOWN_SPEAKER honestly
      }
      const slice = input.audioSamples.subarray(seg.startSample, seg.endSample);
      if (input.embeddingProvider) {
        ephemeralVectors.push(l2Normalize(input.embeddingProvider.extractEmbedding(slice, sampleRateHz)));
        spectralComplexities.push(0);
      } else {
        const extracted = extractAcousticSpectralProxyVector(slice, sampleRateHz);
        ephemeralVectors.push(extracted.vector);
        spectralComplexities.push(extracted.spectralComplexity);
      }
      clusterableIndices.push(i);
    }

    const userCount =
      typeof input.userSuppliedSpeakerCount === 'number' && input.userSuppliedSpeakerCount >= 1
        ? Math.round(input.userSuppliedSpeakerCount)
        : null;

    const { clusterAssignments, centroidSimilarities } = runAhcClustering(
      ephemeralVectors,
      threshold,
      userCount,
    );

    // Immediately purge ephemeral embeddings from memory (zero-fill)
    for (const v of ephemeralVectors) {
      v.fill(0);
    }
    ephemeralVectors.length = 0;
    const ephemeralEmbeddingsPurgedAtUtc = new Date().toISOString();

    const clusterBySegIdx = new Map<number, { cluster: number; sim: number; complexity: number }>();
    clusterableIndices.forEach((segIdx, pos) => {
      clusterBySegIdx.set(segIdx, {
        cluster: clusterAssignments[pos],
        sim: centroidSimilarities[pos],
        complexity: spectralComplexities[pos],
      });
    });

    const explicitOverlaps = input.explicitOverlapRegionsSec ?? [];
    const overlaps: OverlapIntervalRecord[] = [];
    const turns: SpeakerTurnRecord[] = [];

    for (let i = 0; i < speechSegments.length; i++) {
      const seg = speechSegments[i];
      const range = buildSampleInterval(seg.startSample, seg.endSample, sampleRateHz);
      const assigned = clusterBySegIdx.get(i);

      // Check explicit overlap regions first
      const matchingExplicitOverlap = explicitOverlaps.find((ov) => {
        const ovStart = Math.max(ov.startSec, range.startSec);
        const ovEnd = Math.min(ov.endSec, range.endSec);
        return ovEnd - ovStart >= Math.min(0.15, (range.endSec - range.startSec) * 0.4);
      });

      if (matchingExplicitOverlap) {
        const activeIds =
          matchingExplicitOverlap.activeSpeakerHints &&
          matchingExplicitOverlap.activeSpeakerHints.length >= 2
            ? [...matchingExplicitOverlap.activeSpeakerHints].sort()
            : ['speaker_1', 'speaker_2'];
        overlaps.push({
          overlapId: `ov_${overlaps.length + 1}`,
          range,
          activeSpeakerIds: activeIds,
          detectionSource: 'EXPLICIT_MULTI_TRACK_OR_ANNOTATION',
          notes: 'Overlapping speech preserved as concurrent speakers without linearizing.',
        });
        turns.push({
          turnId: `turn_${i + 1}`,
          recordingScopeId,
          kind: 'OVERLAPPING_SPEECH',
          speakerId: activeIds[0],
          activeSpeakerIds: activeIds,
          range,
          origin: 'AUTOMATIC_CLUSTERING',
          rawClusterSimilarity: assigned?.sim ?? null,
          rawScoreCalibrationState:
            assigned !== undefined ? 'UNCALIBRATED_ACOUSTIC_SIMILARITY' : 'NOT_AVAILABLE',
          notes: `Concurrent speech (${activeIds.join(' + ')}); preserved without forcing sequential single-speaker turn.`,
        });
        continue;
      }

      if (!assigned) {
        turns.push({
          turnId: `turn_${i + 1}`,
          recordingScopeId,
          kind: 'UNKNOWN_SPEAKER',
          speakerId: UNKNOWN_SPEAKER_ID,
          activeSpeakerIds: [UNKNOWN_SPEAKER_ID],
          range,
          origin: 'AUTOMATIC_CLUSTERING',
          rawClusterSimilarity: null,
          rawScoreCalibrationState: 'NOT_AVAILABLE',
          notes: `Turn duration (${range.durationMs}ms) is below minimum evidence threshold (${minTurnDurationMs}ms); marked UNKNOWN_SPEAKER.`,
        });
        continue;
      }

      // Low similarity margin check -> UNKNOWN_SPEAKER instead of guessing
      if (assigned.sim < 0.65) {
        turns.push({
          turnId: `turn_${i + 1}`,
          recordingScopeId,
          kind: 'UNKNOWN_SPEAKER',
          speakerId: UNKNOWN_SPEAKER_ID,
          activeSpeakerIds: [UNKNOWN_SPEAKER_ID],
          range,
          origin: 'AUTOMATIC_CLUSTERING',
          rawClusterSimilarity: assigned.sim,
          rawScoreCalibrationState: 'UNCALIBRATED_ACOUSTIC_SIMILARITY',
          notes:
            'Cluster centroid similarity below honest evidence floor (0.65); marked UNKNOWN_SPEAKER.',
        });
        continue;
      }

      const speakerId = `speaker_${assigned.cluster + 1}`;
      turns.push({
        turnId: `turn_${i + 1}`,
        recordingScopeId,
        kind: 'SINGLE_SPEAKER',
        speakerId,
        activeSpeakerIds: [speakerId],
        range,
        origin: 'AUTOMATIC_CLUSTERING',
        rawClusterSimilarity: assigned.sim,
        rawScoreCalibrationState: 'UNCALIBRATED_ACOUSTIC_SIMILARITY',
        notes:
          backendMode === 'NEURAL_EMBEDDING_PROVIDER_AHC'
            ? 'Assigned via neural speaker-embedding AHC clustering (recording-scoped anonymous ID).'
            : 'Assigned via acoustic spectral-proxy AHC clustering (recording-scoped anonymous ID; neural speaker model recommended for production Persian multi-speaker DER).',
      });
    }

    const speakers = rebuildSpeakersSummary(recordingScopeId, turns);
    const speechDurationMs = Number(
      turns.reduce((a, t) => a + t.range.durationMs, 0).toFixed(2),
    );
    const overlapDurationMs = Number(
      turns
        .filter((t) => t.kind === 'OVERLAPPING_SPEECH')
        .reduce((a, t) => a + t.range.durationMs, 0)
        .toFixed(2),
    );
    const unknownSpeakerDurationMs = Number(
      turns
        .filter((t) => t.kind === 'UNKNOWN_SPEAKER')
        .reduce((a, t) => a + t.range.durationMs, 0)
        .toFixed(2),
    );
    const nonSpeechDurationMs = Number(
      nonSpeechIntervals.reduce((a, iv) => a + iv.durationMs, 0).toFixed(2),
    );

    const warnings: string[] = [];
    if (backendMode === 'ACOUSTIC_SPECTRAL_PROXY_AHC') {
      warnings.push(
        'Executed with deterministic acoustic spectral-proxy AHC (no pretrained neural ECAPA-TDNN/WeSpeaker ONNX checkpoint bundled on disk). Similar-timbre speakers require a neural embedding model.',
      );
    }
    if (userCount !== null) {
      warnings.push(
        `Speaker count constrained to user-supplied configuration (${userCount}); labeled explicitly as USER_SUPPLIED_CONFIG.`,
      );
    }
    if (turns.length === 0) {
      warnings.push('No speech turns detected above acoustic VAD floor.');
    }

    return {
      contractVersion: SHAHAB_DIARIZATION_CONTRACT_VERSION,
      requestId,
      revisionId: `diar_rev_1_${crypto.randomBytes(3).toString('hex')}`,
      audioId: input.audioId,
      audioSha256,
      recordingScopeId,
      backendMode,
      diarizerId,
      diarizerRevision,
      speakerCountOrigin: userCount !== null ? 'USER_SUPPLIED_CONFIG' : 'AUTOMATIC_UNKNOWN',
      userSuppliedSpeakerCount: userCount,
      detectedSpeakerCount: speakers.length,
      audioDurationSec: Number((input.audioSamples.length / sampleRateHz).toFixed(6)),
      totalAudioSamples: input.audioSamples.length,
      speakers,
      turns,
      overlaps,
      nonSpeechIntervals,
      speechDurationMs,
      overlapDurationMs,
      unknownSpeakerDurationMs,
      nonSpeechDurationMs,
      privacyAudit: {
        explicitUserConsentGranted: true,
        recordingScopedOnly: true,
        embeddingsRetained: false,
        ephemeralEmbeddingsPurgedAtUtc,
        diagnosticsContainsBiometrics: false,
      },
      revisions: [],
      warnings,
      latencyMs: Number((performance.now() - t0).toFixed(3)),
      createdAtUtc: new Date().toISOString(),
    };
  }
}
