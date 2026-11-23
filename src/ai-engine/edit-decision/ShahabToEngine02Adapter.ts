/**
 * Engine 01 (SHAHAB) -> Engine 02 (Smart Edit Intelligence) Canonical Adapter
 *
 * Bridges real SHAHAB ASR outputs (`ShahabSdkTranscriptResult` or `TranscriptDocument`)
 * into Engine 02 (`SpeechEventEngine` + `EditDecisionEngine`) while preserving:
 * - Immutability of raw verbatim ASR transcript
 * - Honest timing precision disclosure (WORD vs SEGMENT_ONLY vs PARTIAL vs NONE — never fabricating fake word timestamps)
 * - Non-destructive EDL generation (`executed: false`, `automaticApprovalEligible: false`)
 */

import type { SampleRate } from '../../contracts/timebase.contract';
import { TimeMath } from '../../contracts/timebase.contract';
import type { ShahabSdkTranscriptResult } from '../../shahab/sdk/ShahabSdk';
import type { TranscriptDocument } from '../../workflow/SmartAudioEditContracts';
import {
  PERSIAN_FILLER_LEXICON_VERSION,
  type PersianFillerLexiconEntry,
} from '../PersianDisfluencyEngine';
import { PersianTextNormalizer, type TimedPersianToken } from '../PersianTextNormalizer';
import {
  createSpeechAnalysisThresholdConfig,
  type SpeechAnalysisThresholdConfig,
  type SpeechEditSensitivityPreset,
} from '../speech-events/SpeechEventContracts';
import type { VadProbeProvider } from '../speech-events/SilenceAndPauseAnalyzer';
import {
  SpeechEventEngine,
  type SpeechEventAnalysisResult,
  type SpeechSegmentTimingInput,
} from '../speech-events/SpeechEventEngine';
import { EditDecisionEngine } from './EditDecisionEngine';
import { isSupportedSampleRate } from './EditBoundaryRefiner';
import type { EditDecisionListSnapshot } from './EditDecisionTypes';

export interface Engine02FromShahabRequest {
  readonly projectId: string;
  readonly trackId?: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sampleRate: SampleRate;
  readonly totalSourceSamples: number;
  readonly channelLayout?: 'mono' | 'stereo';
  /** Optional PCM audio for acoustic pause, breath, energy & corroboration analysis */
  readonly pcmMono?: Float32Array;
  readonly analysisSampleRate?: SampleRate;
  readonly shahabResult?: ShahabSdkTranscriptResult;
  readonly transcriptDocument?: TranscriptDocument;
  readonly customFillerLexicon?: readonly PersianFillerLexiconEntry[];
  readonly thresholdConfig?: SpeechAnalysisThresholdConfig;
  readonly sensitivityPreset?: SpeechEditSensitivityPreset;
  readonly vadProvider?: VadProbeProvider | null;
  readonly nowMs?: number;
  readonly signal?: AbortSignal;
}

export interface Engine02SmartEditOutput {
  readonly rawTranscriptVerbatim: string;
  readonly normalizedTranscriptDisplay: string;
  readonly timingGranularity: 'WORD' | 'SEGMENT_ONLY' | 'PARTIAL' | 'NONE';
  readonly thresholdConfigVersion: string;
  readonly speechEvents: SpeechEventAnalysisResult;
  readonly edl: EditDecisionListSnapshot;
  readonly executed: false;
}

function mapTranscriptDocumentTokens(
  doc: TranscriptDocument,
  trackId: string,
): TimedPersianToken[] {
  return doc.tokens.map((tok) => {
    const validNumeric =
      Number.isFinite(tok.startSec) &&
      Number.isFinite(tok.endSec) &&
      tok.startSec >= 0 &&
      tok.endSec > tok.startSec;

    const precision =
      doc.timestampGranularity === 'NONE' || !validNumeric
        ? 'missing'
        : doc.timestampGranularity === 'SEGMENT' || tok.timestampGranularity === 'SEGMENT_ESTIMATED'
          ? 'distributed_segment'
          : 'model_timestamps';

    return PersianTextNormalizer.createToken({
      tokenId: tok.tokenId,
      trackId,
      originalText: tok.rawText,
      startFlicks: validNumeric ? TimeMath.secondsToFlicks(tok.startSec) : 0,
      endFlicks: validNumeric ? TimeMath.secondsToFlicks(tok.endSec) : 0,
      confidence: tok.confidence ?? 0.85,
      alignmentPrecision: precision,
      timingValid: validNumeric && doc.timestampGranularity !== 'NONE',
    });
  });
}

function resolveEdlSampleRate(rate: number): SampleRate {
  if (isSupportedSampleRate(rate)) return rate;
  if (rate <= 16000) return 16000;
  if (rate <= 22050) return 22050;
  if (rate <= 24000) return 24000;
  if (rate <= 32000) return 32000;
  if (rate <= 44100) return 44100;
  return 48000;
}

export async function analyzeShahabOutputWithEngine02(
  request: Engine02FromShahabRequest,
): Promise<Engine02SmartEditOutput> {
  const trackId = request.trackId ?? 'track-main';
  const nowMs = request.nowMs ?? Date.now();
  const config =
    request.thresholdConfig ??
    createSpeechAnalysisThresholdConfig({ preset: request.sensitivityPreset ?? 'BALANCED' });

  const shahab = request.shahabResult;
  const doc = request.transcriptDocument;

  const rawTranscriptVerbatim =
    shahab?.transcriptLayers.verbatimRepresentation ?? doc?.rawText ?? '';
  const normalizedTranscriptDisplay =
    shahab?.transcriptLayers.normalizedRepresentation ??
    doc?.normalizedText ??
    PersianTextNormalizer.normalizeTokenText(rawTranscriptVerbatim);

  const tokens: TimedPersianToken[] = doc ? mapTranscriptDocumentTokens(doc, trackId) : [];

  const segments: readonly SpeechSegmentTimingInput[] | undefined = shahab
    ? shahab.segments.map((seg) => ({
        segmentId: seg.segmentId,
        startSec: seg.startSec,
        endSec: seg.endSec,
        textVerbatim: seg.textVerbatim,
        textNormalized: seg.textNormalized,
      }))
    : undefined;

  const requestTimingGranularity: 'WORD' | 'SEGMENT' | 'TOKEN' | 'NONE' = shahab
    ? 'SEGMENT'
    : doc?.timestampGranularity ?? 'NONE';

  const analysisRate = request.analysisSampleRate ?? request.sampleRate;
  const analysisTotalSamples = request.pcmMono
    ? request.pcmMono.length
    : Math.max(
        0,
        Math.round(
          (Math.max(0, request.totalSourceSamples) / Math.max(1, request.sampleRate)) *
            analysisRate,
        ),
      );

  const speechEvents = await SpeechEventEngine.analyzeRecording({
    trackId,
    sampleRate: analysisRate,
    totalSamples: analysisTotalSamples,
    pcmMono: request.pcmMono,
    tokens: tokens.length > 0 ? tokens : undefined,
    segments,
    rawTranscriptText: rawTranscriptVerbatim,
    timingGranularity: requestTimingGranularity,
    customFillerLexicon: request.customFillerLexicon,
    config,
    vadProvider: request.vadProvider,
    signal: request.signal,
  });

  const transcriptVersion =
    doc?.transcriptVersion ??
    (shahab ? `shahab:${shahab.jobId}:rev${shahab.outputRevision}` : 'transcript-none');

  const modelVersions: Record<string, string> = {};
  if (shahab) {
    modelVersions[shahab.modelIdentity.modelId] = shahab.modelIdentity.modelRevisionSha;
  } else if (doc) {
    modelVersions[doc.modelId] = doc.modelVersion;
  }

  const edl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: request.projectId,
      sourceAudioId: request.sourceAudioId,
      sourceAudioHash: request.sourceAudioHash,
      transcriptVersion,
      alignmentVersion: shahab
        ? 'segment-stride-40ms-no-word-align'
        : doc
          ? `align-${doc.modelVersion}`
          : 'none',
      sampleRate: resolveEdlSampleRate(request.sampleRate),
      channelLayout: request.channelLayout ?? 'mono',
      totalSourceSamples: request.totalSourceSamples,
      eventDetectorVersion: speechEvents.engineVersion,
      lexiconVersion: PERSIAN_FILLER_LEXICON_VERSION,
      thresholdConfigVersion: config.version,
      modelVersions,
    },
    events: speechEvents.events,
    tokens,
    nowMs,
    signal: request.signal,
  });

  return {
    rawTranscriptVerbatim,
    normalizedTranscriptDisplay,
    timingGranularity: speechEvents.timingGranularity ?? 'NONE',
    thresholdConfigVersion: config.version,
    speechEvents,
    edl,
    executed: false,
  };
}
