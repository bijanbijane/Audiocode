/**
 * CORE ASR ENGINE — BATCH & LONG-FORM TRANSCRIPTION ENGINE (MILESTONES CORE-02 & CORE-05)
 *
 * Implements:
 * - End-to-end FFmpeg ingestion + canonical 16kHz mono PCM16 conversion
 * - Energy-valley boundary-aware segmentation for long recordings
 * - Context overlap & phrase deduplication at stitched joins
 * - Sample-accurate offset timestamps back to recording start
 * - Bounded retry + explicit PARTIAL_WITH_FAILURES tracking (zero silent data loss)
 */

import crypto from 'node:crypto';
import { ingestAudioBufferToCanonical16kMono } from './CoreAudioIngestion';
import {
  CORE_SAMPLE_RATE,
  CoreAcousticCtcEngine,
  probeRuntimeBackendAvailability,
} from './CoreAcousticCtcEngine';
import { buildAllNormalizationProfiles, detectTextLanguageTag } from './CoreNormalizationAndLanguage';
import type {
  CoreTranscriptionResult,
  CoreTranscriptionSegment,
  DetectedLanguageTag,
  LongFormConfig,
} from './CoreAsrContracts';

export const DEFAULT_LONG_FORM_CONFIG: LongFormConfig = {
  maxSegmentDurationSec: 20.0,
  contextOverlapSec: 1.5,
  minSilenceValleyMs: 120,
  maxRetriesPerSegment: 2,
};

/**
 * Finds the lowest-energy silence valley near target split sample to avoid cutting mid-phoneme.
 */
export function findBestBoundaryValleySample(
  pcm16k: Float32Array,
  targetSample: number,
  searchRadiusSamples = CORE_SAMPLE_RATE * 2,
): number {
  const safeTarget = Number.isFinite(targetSample)
    ? Math.max(0, Math.min(pcm16k.length, Math.round(targetSample)))
    : Math.floor(pcm16k.length / 2);
  const safeRadius =
    Number.isFinite(searchRadiusSamples) && searchRadiusSamples >= 0
      ? Math.round(searchRadiusSamples)
      : CORE_SAMPLE_RATE * 2;
  const win = 320; // 20ms
  const lo = Math.max(win, safeTarget - safeRadius);
  const hi = Math.min(pcm16k.length - win, safeTarget + safeRadius);
  if (hi <= lo) return safeTarget;

  let bestSample = safeTarget;
  let bestEnergy = Infinity;

  for (let pos = lo; pos <= hi; pos += 160) {
    let e = 0;
    for (let i = pos; i < pos + win && i < pcm16k.length; i++) {
      const s = Number.isFinite(pcm16k[i]) ? pcm16k[i] : 0;
      e += s * s;
    }
    if (e < bestEnergy) {
      bestEnergy = e;
      bestSample = pos + Math.floor(win / 2);
    }
  }
  return bestSample;
}

/**
 * Deduplicates trailing/leading overlapping word tokens across stitched overlap windows.
 */
export function stitchSegmentsWithOverlapDeduplication(
  segments: CoreTranscriptionSegment[],
): { stitchedRawText: string; stitchedSegments: CoreTranscriptionSegment[] } {
  const okSegments = segments.filter((s) => s.status === 'OK');
  if (okSegments.length === 0) {
    return { stitchedRawText: '', stitchedSegments: segments };
  }

  const stitchedWords: string[] = [];
  for (let i = 0; i < okSegments.length; i++) {
    const words = okSegments[i].rawModelOutput.trim().split(/\s+/).filter(Boolean);
    if (i === 0) {
      stitchedWords.push(...words);
      continue;
    }

    // Check 1..4 word boundary overlap with suffix of stitchedWords
    let matchedOverlap = 0;
    const maxK = Math.min(4, stitchedWords.length, words.length);
    for (let k = maxK; k >= 1; k--) {
      const tail = stitchedWords.slice(stitchedWords.length - k).join(' ');
      const head = words.slice(0, k).join(' ');
      if (tail === head) {
        matchedOverlap = k;
        break;
      }
    }
    stitchedWords.push(...words.slice(matchedOverlap));
  }

  return {
    stitchedRawText: stitchedWords.join(' ').trim(),
    stitchedSegments: segments,
  };
}

export class CoreBatchAndLongFormEngine {
  constructor(private readonly ctcEngine: CoreAcousticCtcEngine = new CoreAcousticCtcEngine()) {}

  public transcribeLongFormPcm(params: {
    pcm16k: Float32Array;
    filename?: string;
    languageHint?: DetectedLanguageTag | 'auto';
    config?: Partial<LongFormConfig>;
    warnings?: string[];
    audioSha256?: string;
  }): CoreTranscriptionResult {
    const t0 = performance.now();
    const cfg: LongFormConfig = { ...DEFAULT_LONG_FORM_CONFIG, ...params.config };
    const { pcm16k, languageHint = 'auto', warnings = [] } = params;
    const sha256 =
      params.audioSha256 ??
      crypto
        .createHash('sha256')
        .update(Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength))
        .digest('hex');

    const maxSegmentDurationSec =
      Number.isFinite(cfg.maxSegmentDurationSec) && cfg.maxSegmentDurationSec >= 2.0
        ? cfg.maxSegmentDurationSec
        : DEFAULT_LONG_FORM_CONFIG.maxSegmentDurationSec;
    const contextOverlapSec =
      Number.isFinite(cfg.contextOverlapSec) && cfg.contextOverlapSec >= 0
        ? Math.min(maxSegmentDurationSec * 0.5, cfg.contextOverlapSec)
        : DEFAULT_LONG_FORM_CONFIG.contextOverlapSec;
    const maxRetriesPerSegment =
      Number.isFinite(cfg.maxRetriesPerSegment) && cfg.maxRetriesPerSegment >= 0
        ? Math.min(10, Math.floor(cfg.maxRetriesPerSegment))
        : DEFAULT_LONG_FORM_CONFIG.maxRetriesPerSegment;

    const maxSegSamples = Math.max(CORE_SAMPLE_RATE * 2, Math.round(maxSegmentDurationSec * CORE_SAMPLE_RATE));
    const overlapSamples = Math.max(0, Math.round(contextOverlapSec * CORE_SAMPLE_RATE));

    // Plan segments anchored cleanly on acoustic energy valleys
    const plannedRanges: Array<{ startSample: number; endSample: number }> = [];
    if (pcm16k.length <= maxSegSamples) {
      plannedRanges.push({ startSample: 0, endSample: pcm16k.length });
    } else {
      let cursor = 0;
      while (cursor < pcm16k.length) {
        const nominalEnd = Math.min(pcm16k.length, cursor + maxSegSamples);
        const endSample =
          nominalEnd >= pcm16k.length - CORE_SAMPLE_RATE
            ? pcm16k.length
            : findBestBoundaryValleySample(pcm16k, nominalEnd, Math.round(CORE_SAMPLE_RATE * 1.2));
        plannedRanges.push({ startSample: cursor, endSample });
        if (endSample >= pcm16k.length) break;
        cursor = Math.max(cursor + CORE_SAMPLE_RATE, endSample - overlapSamples);
      }
    }

    const segments: CoreTranscriptionSegment[] = [];
    const failedSegmentRanges: CoreTranscriptionResult['failedSegmentRanges'] = [];
    let peakRssMb = process.memoryUsage().rss / (1024 * 1024);

    for (let idx = 0; idx < plannedRanges.length; idx++) {
      const range = plannedRanges[idx];
      const slice = pcm16k.subarray(range.startSample, range.endSample);

      let retries = 0;
      let seg: CoreTranscriptionSegment | null = null;
      let lastErr: string | null = null;

      while (retries <= maxRetriesPerSegment) {
        try {
          if (cfg.simulateFailureOnSegmentIndex === idx) {
            throw new Error(`INJECTED_SEGMENT_FAILURE_ON_INDEX_${idx}`);
          }
          seg = this.ctcEngine.decodePcmSegment({
            pcm16k: slice,
            segmentIndex: idx,
            segmentOffsetSamples: range.startSample,
            languageHint,
          });
          seg = { ...seg, retryCount: retries };
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          retries++;
        }
      }

      if (!seg) {
        const startSec = Number((range.startSample / CORE_SAMPLE_RATE).toFixed(3));
        const endSec = Number((range.endSample / CORE_SAMPLE_RATE).toFixed(3));
        const failedSeg: CoreTranscriptionSegment = {
          segmentId: `seg_${idx}`,
          segmentIndex: idx,
          startSec,
          endSec,
          startSample: range.startSample,
          endSample: range.endSample,
          language: 'unknown',
          languageConfidence: null,
          rawModelOutput: '',
          normalizedByProfile: buildAllNormalizationProfiles(''),
          words: [],
          timestampGranularity: 'SEGMENT',
          confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
          calibratedConfidence: null,
          acousticFrameCount: 0,
          backendUsed: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
          retryCount: retries - 1,
          status: 'FAILED',
          failureReason: lastErr ?? 'SEGMENT_DECODE_FAILED',
        };
        segments.push(failedSeg);
        failedSegmentRanges.push({
          segmentIndex: idx,
          startSec,
          endSec,
          reason: failedSeg.failureReason ?? 'UNKNOWN',
        });
      } else {
        segments.push(seg);
      }

      const curRssMb = process.memoryUsage().rss / (1024 * 1024);
      if (curRssMb > peakRssMb) peakRssMb = curRssMb;
    }

    const { stitchedRawText } = stitchSegmentsWithOverlapDeduplication(segments);
    const langInfo = detectTextLanguageTag(stitchedRawText);
    const normalizedByProfile = buildAllNormalizationProfiles(stitchedRawText);

    const processingTimeMs = Number((performance.now() - t0).toFixed(2));
    const durationSec = Number((pcm16k.length / CORE_SAMPLE_RATE).toFixed(4));
    const realTimeFactor = durationSec > 0 ? Number(((processingTimeMs / 1000) / durationSec).toFixed(4)) : 0;

    const okCount = segments.filter((s) => s.status === 'OK').length;
    const status: CoreTranscriptionResult['status'] =
      failedSegmentRanges.length === 0
        ? 'COMPLETED'
        : okCount > 0
          ? 'PARTIAL_WITH_FAILURES'
          : 'FAILED';

    return {
      jobId: `asr_core_${crypto.randomBytes(5).toString('hex')}`,
      status,
      backendUsed: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
      backendAvailabilitySnapshot: probeRuntimeBackendAvailability(),
      modelVersionId: this.ctcEngine.getModelVersionId(),
      durationSec,
      processingTimeMs,
      realTimeFactor,
      peakRssMb: Number(peakRssMb.toFixed(2)),
      dominantLanguage: langInfo.language,
      rawModelOutput: stitchedRawText,
      normalizedByProfile,
      confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
      calibratedConfidence: null,
      timestampGranularity: segments.some((s) => s.words.length > 0) ? 'WORD' : 'SEGMENT',
      segments,
      failedSegmentRanges,
      ingestWarnings: warnings,
      audioSha256: sha256,
    };
  }

  public transcribeAudioBytes(params: {
    filename: string;
    rawBytes: Buffer;
    rawPcm16Hint?: boolean;
    languageHint?: DetectedLanguageTag | 'auto';
    longFormConfig?: Partial<LongFormConfig>;
  }): CoreTranscriptionResult {
    const ingested = ingestAudioBufferToCanonical16kMono({
      filename: params.filename,
      rawBytes: params.rawBytes,
      rawPcm16Hint: params.rawPcm16Hint,
    });

    return this.transcribeLongFormPcm({
      pcm16k: ingested.canonicalFloat32,
      filename: ingested.sourceFilename,
      languageHint: params.languageHint,
      config: params.longFormConfig,
      warnings: ingested.warnings,
      audioSha256: ingested.audioSha256,
    });
  }
}
