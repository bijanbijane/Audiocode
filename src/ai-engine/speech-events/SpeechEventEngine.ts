import { SampleRate, TimeMath, TimeRange } from '../../contracts/timebase.contract';
import { PersianWordToken, Track } from '../../contracts/v1_2';
import { TimelineTrack } from '../../contracts/project-schema.contract';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../../runtime/memory/MemoryBudgetManager';
import {
  NonVerbalEventModelAdapter,
  NonVerbalVocalEventDetector,
  RejectedNonVocalCandidate,
} from '../NonVerbalVocalEventDetector';
import { OnnxPersianAsrAndVadAdapter } from '../OnnxPersianAsrAndVadAdapter';
import { PersianDisfluencyEngine } from '../PersianDisfluencyEngine';
import {
  ComprehensiveProsodyReport,
  PersianProsodyAndPacingAnalyzer,
} from '../PersianProsodyAndPacingAnalyzer';
import { PersianSemanticRepetitionEngine } from '../PersianSemanticRepetitionEngine';
import { PersianTextNormalizer, TimedPersianToken } from '../PersianTextNormalizer';
import {
  SilenceAndPauseAnalyzer,
  VadProbeProvider,
} from './SilenceAndPauseAnalyzer';
import {
  DEFAULT_SPEECH_EVENT_THRESHOLDS_V1,
  SPEECH_EVENT_ENGINE_VERSION,
  SpeechAnalysisThresholdConfig,
  SpeechEditSuggestion,
  SpeechEvent,
  SpeechEventAcousticEvidence,
} from './SpeechEventContracts';
import {
  applyPrecisionEligibilityAndThresholds,
  fuseSpeechEventEvidence,
} from './SpeechEventEvidenceFusion';
import { buildTimelineSuggestionsFromSpeechEvents } from './TimelineSuggestionBridge';

export type WindowPcmReader = (
  startSample: number,
  sampleCount: number,
) => Promise<Float32Array> | Float32Array;

export interface SpeechEventAnalysisRequest {
  readonly trackId: string;
  readonly sampleRate: SampleRate;
  readonly totalSamples: number;
  /** Either provide a mono PCM buffer directly OR a bounded streaming window reader */
  readonly pcmMono?: Float32Array;
  readonly readPcmWindow?: WindowPcmReader;
  readonly tokens?: readonly TimedPersianToken[];
  readonly wordTokens?: readonly PersianWordToken[];
  readonly config?: SpeechAnalysisThresholdConfig;
  readonly vadProvider?: VadProbeProvider | null;
  readonly nonVerbalModelAdapter?: NonVerbalEventModelAdapter | null;
  readonly nonVerbalDetectionMode?: 'auto' | 'heuristic' | 'model-based';
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly tracks?: readonly (Track | TimelineTrack)[];
  readonly includeNoEditSuggestions?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly completedWindows: number;
    readonly totalWindows: number;
    readonly eventsSoFar: number;
  }) => void;
}

export interface SpeechEventAnalysisResult {
  readonly engineVersion: string;
  readonly thresholdConfigVersion: string;
  readonly trackId: string;
  readonly cancelled: boolean;
  readonly completedWindows: number;
  readonly totalWindows: number;
  readonly analyzedDurationSec: number;
  readonly totalRecordingDurationSec: number;
  readonly estimatedNoiseFloorDbfs: number | null;
  readonly capabilitySummary: {
    readonly fillers: 'heuristic';
    readonly repetitions: 'heuristic';
    readonly silence: 'heuristic' | 'hybrid-vad';
    readonly nonVerbal: 'heuristic' | 'model-based' | 'unsupported';
    readonly prosody: 'heuristic';
  };
  readonly events: readonly SpeechEvent[];
  readonly suggestions: readonly SpeechEditSuggestion[];
  readonly rejectedNonVocalCandidates: readonly RejectedNonVocalCandidate[];
  readonly prosodyReport: ComprehensiveProsodyReport | null;
  readonly rejectedInvalidBoundaryCount: number;
  readonly truncatedByEventCap: boolean;
  readonly peakReservedBytes: number;
  readonly warnings: readonly string[];
  readonly limitationNoteFa: string;
}

export function convertWordTokensToTimedTokens(
  wordTokens: readonly PersianWordToken[],
  trackIdFilter?: string,
): TimedPersianToken[] {
  const filtered = trackIdFilter
    ? wordTokens.filter((t) => t.trackId === trackIdFilter)
    : wordTokens;
  return filtered.map((t) =>
    PersianTextNormalizer.createToken({
      tokenId: t.id,
      trackId: t.trackId,
      originalText: t.originalText,
      startFlicks: t.range.startFlicks,
      endFlicks: t.range.endFlicks,
      confidence: t.confidence,
    }),
  );
}

/**
 * Unified Bounded-Memory Persian Speech Event & Evidence Engine (AVP-P04-001)
 * Orchestrates Persian filler, word/syllable repetition, stutter-like pattern,
 * false-start/self-correction, adaptive silence, non-verbal vocal event, and prosody analysis
 * inside bounded time windows under MemoryBudgetManager and AbortSignal governance.
 *
 * Guarantees:
 * - Never modifies original audio, raw transcript, or committed timeline transactions.
 * - Never calls uncalibrated heuristic scores probabilities.
 * - Never auto-applies edits or labels speech patterns as medical diagnoses.
 */
export class SpeechEventEngine {
  public static async analyzeRecording(
    request: SpeechEventAnalysisRequest,
  ): Promise<SpeechEventAnalysisResult> {
    const config = request.config ?? DEFAULT_SPEECH_EVENT_THRESHOLDS_V1;
    const budget = request.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    const sampleRate: SampleRate =
      Number.isFinite(request.sampleRate) && request.sampleRate > 0
        ? request.sampleRate
        : (0 as unknown as SampleRate);
    const rawTotal = request.totalSamples || request.pcmMono?.length || 0;
    const totalSamples =
      Number.isFinite(rawTotal) && rawTotal > 0 ? Math.max(0, Math.trunc(rawTotal)) : 0;
    const totalRecordingDurationSec =
      sampleRate > 0 ? Number((totalSamples / sampleRate).toFixed(4)) : 0;

    // Resolve immutable normalized token copy (never mutating caller tokens)
    const timedTokens: TimedPersianToken[] = (
      request.tokens
        ? [...request.tokens].filter((t) => t.trackId === request.trackId)
        : request.wordTokens
          ? convertWordTokensToTimedTokens(request.wordTokens, request.trackId)
          : []
    ).filter((t) => Number.isFinite(t.range?.start) && Number.isFinite(t.range?.end));

    const hasAudio = Boolean(
      sampleRate > 0 && totalSamples > 0 && (request.pcmMono || request.readPcmWindow),
    );

    const safeWindowSec =
      Number.isFinite(config.analysisWindowSec) && config.analysisWindowSec > 0
        ? config.analysisWindowSec
        : 15;
    const windowSec = Math.max(2, safeWindowSec);
    const windowSamples = Math.max(1, Math.floor(windowSec * Math.max(1, sampleRate)));
    const totalWindows = hasAudio ? Math.max(1, Math.ceil(totalSamples / windowSamples)) : 1;

    const allEvents: SpeechEvent[] = [];
    const rejectedNonVocalCandidates: RejectedNonVocalCandidate[] = [];
    const warnings: string[] = [];

    let completedWindows = 0;
    let cancelled = false;
    let truncatedByEventCap = false;
    let peakReservedBytes = 0;
    let vadUsed = false;
    let nonVerbalCapability: 'heuristic' | 'model-based' | 'unsupported' =
      request.nonVerbalDetectionMode === 'model-based' && !request.nonVerbalModelAdapter
        ? 'unsupported'
        : request.nonVerbalModelAdapter
          ? 'model-based'
          : 'heuristic';
    const noiseFloorSamples: number[] = [];

    const defaultVadAdapter =
      request.vadProvider === undefined ? new OnnxPersianAsrAndVadAdapter() : request.vadProvider;

    const maxBufferedEvents =
      Number.isFinite(config.maxBufferedEvents) && config.maxBufferedEvents > 0
        ? Math.trunc(config.maxBufferedEvents)
        : 4000;

    const pushEventBounded = (ev: SpeechEvent) => {
      if (allEvents.length >= maxBufferedEvents) {
        truncatedByEventCap = true;
        return;
      }
      allEvents.push(applyPrecisionEligibilityAndThresholds(ev, config));
    };

    // --- 1. Bounded Window Acoustic + Cross-Modal Processing ---
    if (hasAudio) {
      for (let winIdx = 0; winIdx < totalWindows; winIdx++) {
        if (request.signal?.aborted) {
          cancelled = true;
          break;
        }

        const startSample = winIdx * windowSamples;
        const count = Math.min(windowSamples, totalSamples - startSample);
        if (count <= 0) break;

        const offsetSeconds = startSample / sampleRate;
        const winEndSec = (startSample + count) / sampleRate;
        const winStartFlicks = TimeMath.secondsToFlicks(offsetSeconds);
        const winEndFlicks = TimeMath.secondsToFlicks(winEndSec);

        // Memory budget reservation for bounded PCM window + transient feature buffers
        const pcmBytes = count * Float32Array.BYTES_PER_ELEMENT;
        const safeHopMs =
          Number.isFinite(config.silenceHopMs) && config.silenceHopMs > 0
            ? config.silenceHopMs
            : 10;
        const numFramesEst = Math.max(
          1,
          Math.ceil((count / sampleRate) * (1000 / Math.max(5, safeHopMs))),
        );
        const featureBytes = numFramesEst * 4 * Float32Array.BYTES_PER_ELEMENT;

        let pcmRes: MemoryReservation | null = null;
        let featRes: MemoryReservation | null = null;
        try {
          pcmRes = budget.reserve({
            owner: `speech-events:${request.trackId}:win-${winIdx}:pcm`,
            category: 'decoded-audio',
            bytes: pcmBytes,
            priority: 'normal',
          });
          featRes = budget.reserve({
            owner: `speech-events:${request.trackId}:win-${winIdx}:features`,
            category: 'asr-feature-buffers',
            bytes: featureBytes,
            priority: 'normal',
          });
          peakReservedBytes = Math.max(peakReservedBytes, pcmBytes + featureBytes);

          // Acquire bounded PCM slice (no full-recording accumulation)
          let windowPcm: Float32Array;
          if (request.readPcmWindow) {
            windowPcm = await request.readPcmWindow(startSample, count);
          } else if (request.pcmMono) {
            windowPcm = request.pcmMono.subarray(startSample, startSample + count);
          } else {
            windowPcm = new Float32Array(0);
          }

          if (request.signal?.aborted) {
            cancelled = true;
            break;
          }

          const windowTokens = timedTokens.filter((t) => {
            const mid = (t.range.start + t.range.end) / 2;
            return mid >= winStartFlicks && mid < winEndFlicks;
          });

          // 1a. Non-verbal vocal events (bounded window)
          const breathRangesInWindow: Array<{ startSec: number; endSec: number }> = [];
          try {
            const nvRes = await NonVerbalVocalEventDetector.detectDetailedNonVerbalEvents({
              pcmMono: windowPcm,
              tokens: windowTokens,
              sampleRate,
              trackId: request.trackId,
              offsetSeconds,
              detectionMode: request.nonVerbalDetectionMode ?? 'auto',
              modelAdapter: request.nonVerbalModelAdapter ?? null,
            });
            nonVerbalCapability = nvRes.capabilityMode;

            for (const rej of nvRes.rejectedCandidates) {
              if (rejectedNonVocalCandidates.length < 500) {
                rejectedNonVocalCandidates.push(rej);
              }
            }

            for (const nv of nvRes.events) {
              const startSec = Number(TimeMath.flicksToSeconds(nv.range.start).toFixed(4));
              const endSec = Number(TimeMath.flicksToSeconds(nv.range.end).toFixed(4));
              const durationSec = Number(Math.max(0, endSec - startSec).toFixed(4));

              if (nv.category === 'BREATH') {
                breathRangesInWindow.push({ startSec, endSec });
              }

              const fused = fuseSpeechEventEvidence({
                category: nv.category,
                acousticScore: nv.heuristicScore,
                linguisticScore: null,
                ruleEvidenceCount: nv.detectionState === 'UNSUPPORTED' ? 0 : 2,
                modelTokenConfidence: null,
                modelEventConfidence: nv.modelConfidence,
                isUnsupportedCapability: nv.detectionState === 'UNSUPPORTED',
                config,
              });

              pushEventBounded({
                eventId: `${nv.eventId}_w${winIdx}`,
                trackId: request.trackId,
                category: nv.category,
                subtype: nv.subtype,
                detectionState: nv.detectionState,
                startSec,
                endSec,
                durationSec,
                startFlicks: nv.range.start,
                endFlicks: nv.range.end,
                durationFlicks: nv.range.end - nv.range.start,
                acousticEvidence: nv.acousticEvidence,
                detectionMethod: nv.detectionMethod,
                confidence: fused.decisionScore,
                uncertaintyState:
                  nv.detectionState === 'UNSUPPORTED'
                    ? 'UNSUPPORTED_CAPABILITY'
                    : fused.uncertaintyState,
                scores: fused.scores,
                provenance: {
                  engineVersion: SPEECH_EVENT_ENGINE_VERSION,
                  thresholdConfigVersion: config.version,
                  detectorModule: 'NonVerbalVocalEventDetector',
                  capabilityMode:
                    nv.detectionState === 'UNSUPPORTED'
                      ? 'unsupported'
                      : nv.detectionMethod === 'MODEL_BASED'
                        ? 'model-based'
                        : 'heuristic',
                  modelId: nv.modelId,
                  modelVersion: nv.modelVersion,
                  analysisWindowIndex: winIdx,
                  evaluatedSampleRate: sampleRate,
                },
                eligibleForEditSuggestion:
                  nv.detectionState !== 'UNSUPPORTED' &&
                  nv.detectionState !== 'UNCERTAIN' &&
                  (nv.subtype === 'COUGH' ||
                    nv.subtype === 'THROAT_CLEARING' ||
                    nv.subtype === 'AUDIBLE_INHALATION'),
                requiresHumanReview: nv.requiresHumanReview,
                explanationFa: nv.descriptionFa,
              });
            }
          } catch (err) {
            warnings.push(
              `خطا در تحلیل رویدادهای غیرکلامی پنجره ${winIdx}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // 1b. Adaptive silence & pause intelligence (with VAD probe resilience)
          let safeVadProvider: VadProbeProvider | null = defaultVadAdapter;
          try {
            const silRes = await SilenceAndPauseAnalyzer.analyzeSilenceAndPauses({
              pcmMono: windowPcm,
              sampleRate,
              tokens: windowTokens,
              breathRangesSec: breathRangesInWindow,
              trackId: request.trackId,
              offsetSeconds,
              totalRecordingDurationSec,
              config,
              vadProvider: safeVadProvider,
            });
            if (silRes.vadChecked) vadUsed = true;
            if (Number.isFinite(silRes.noiseFloorDbfs)) {
              noiseFloorSamples.push(silRes.noiseFloorDbfs);
            }

            for (const sil of silRes.detections) {
              const fused = fuseSpeechEventEvidence({
                category: 'SILENCE',
                acousticScore: sil.acousticScore,
                linguisticScore: sil.linguisticScore,
                ruleEvidenceCount: sil.linguisticScore !== null ? 2 : 1,
                modelTokenConfidence: null,
                vadActiveOverlap: sil.acousticEvidence.vadActiveOverlap,
                config,
              });

              pushEventBounded({
                eventId: `${sil.id}_w${winIdx}`,
                trackId: request.trackId,
                category: 'SILENCE',
                subtype: sil.subtype,
                detectionState: sil.detectionState,
                startSec: sil.startSec,
                endSec: sil.endSec,
                durationSec: sil.durationSec,
                startFlicks: sil.fullRange.start,
                endFlicks: sil.fullRange.end,
                durationFlicks: sil.fullRange.end - sil.fullRange.start,
                candidateStartSec: sil.candidateStartSec,
                candidateEndSec: sil.candidateEndSec,
                candidateStartFlicks:
                  sil.candidateStartSec !== undefined
                    ? TimeMath.secondsToFlicks(sil.candidateStartSec)
                    : undefined,
                candidateEndFlicks:
                  sil.candidateEndSec !== undefined
                    ? TimeMath.secondsToFlicks(sil.candidateEndSec)
                    : undefined,
                acousticEvidence: sil.acousticEvidence,
                detectionMethod: fused.detectionMethod,
                confidence: fused.decisionScore,
                uncertaintyState: fused.uncertaintyState,
                scores: fused.scores,
                provenance: {
                  engineVersion: SPEECH_EVENT_ENGINE_VERSION,
                  thresholdConfigVersion: config.version,
                  detectorModule: 'SilenceAndPauseAnalyzer',
                  capabilityMode: 'heuristic',
                  analysisWindowIndex: winIdx,
                  evaluatedSampleRate: sampleRate,
                },
                eligibleForEditSuggestion: sil.eligibleForShortening,
                requiresHumanReview: sil.requiresHumanReview,
                explanationFa: sil.explanationFa,
              });
            }
          } catch (err) {
            // Worker / VAD failure resilience: fall back cleanly without VAD if VAD threw
            warnings.push(
              `خطا در ماژول VAD/سکوت پنجره ${winIdx} (ادامه در حالت امن): ${err instanceof Error ? err.message : String(err)}`,
            );
            if (safeVadProvider !== null) {
              safeVadProvider = null;
              try {
                const fallbackSil = await SilenceAndPauseAnalyzer.analyzeSilenceAndPauses({
                  pcmMono: windowPcm,
                  sampleRate,
                  tokens: windowTokens,
                  breathRangesSec: breathRangesInWindow,
                  trackId: request.trackId,
                  offsetSeconds,
                  totalRecordingDurationSec,
                  config,
                  vadProvider: null,
                });
                for (const sil of fallbackSil.detections) {
                  const fused = fuseSpeechEventEvidence({
                    category: 'SILENCE',
                    acousticScore: sil.acousticScore,
                    linguisticScore: sil.linguisticScore,
                    ruleEvidenceCount: 1,
                    modelTokenConfidence: null,
                    baseConflicts: ['ماژول VAD در دسترس نبود یا با خطا مواجه شد؛ بررسی انسانی توصیه می‌شود.'],
                    config,
                  });
                  pushEventBounded({
                    eventId: `${sil.id}_fb_w${winIdx}`,
                    trackId: request.trackId,
                    category: 'SILENCE',
                    subtype: sil.subtype,
                    detectionState: 'PROBABLE',
                    startSec: sil.startSec,
                    endSec: sil.endSec,
                    durationSec: sil.durationSec,
                    startFlicks: sil.fullRange.start,
                    endFlicks: sil.fullRange.end,
                    durationFlicks: sil.fullRange.end - sil.fullRange.start,
                    candidateStartSec: sil.candidateStartSec,
                    candidateEndSec: sil.candidateEndSec,
                    candidateStartFlicks:
                      sil.candidateStartSec !== undefined
                        ? TimeMath.secondsToFlicks(sil.candidateStartSec)
                        : undefined,
                    candidateEndFlicks:
                      sil.candidateEndSec !== undefined
                        ? TimeMath.secondsToFlicks(sil.candidateEndSec)
                        : undefined,
                    acousticEvidence: sil.acousticEvidence,
                    detectionMethod: 'HEURISTIC_SIGNAL',
                    confidence: fused.decisionScore,
                    uncertaintyState: fused.uncertaintyState,
                    scores: fused.scores,
                    provenance: {
                      engineVersion: SPEECH_EVENT_ENGINE_VERSION,
                      thresholdConfigVersion: config.version,
                      detectorModule: 'SilenceAndPauseAnalyzer',
                      capabilityMode: 'heuristic',
                      analysisWindowIndex: winIdx,
                      evaluatedSampleRate: sampleRate,
                      notes: ['Fallback after VAD provider error'],
                    },
                    eligibleForEditSuggestion: false,
                    requiresHumanReview: true,
                    explanationFa: `${sil.explanationFa} (بدون تأیید VAD به دلیل خطای موقت)`,
                  });
                }
              } catch {
                // Keep partial results safe
              }
            }
          }

          // 1c. Window-local word repetitions corroborated with actual PCM acoustics
          if (windowTokens.length >= 2) {
            const shiftedWindowTokens = windowTokens.map((t) => ({
              ...t,
              range: {
                start: t.range.start - winStartFlicks,
                end: t.range.end - winStartFlicks,
              },
            }));
            const wordReps = PersianSemanticRepetitionEngine.classifyWordRepetitionsDetailed(
              shiftedWindowTokens,
              { pcmMono: windowPcm, sampleRate },
            );

            for (const rep of wordReps) {
              const absStart = rep.targetRange.start + winStartFlicks;
              const absEnd = rep.targetRange.end + winStartFlicks;
              const startSec = Number(TimeMath.flicksToSeconds(absStart).toFixed(4));
              const endSec = Number(TimeMath.flicksToSeconds(absEnd).toFixed(4));
              const durationSec = Number(Math.max(0, endSec - startSec).toFixed(4));

              const fused = fuseSpeechEventEvidence({
                category: 'WORD_REPETITION',
                acousticScore: rep.acousticScore,
                linguisticScore: rep.linguisticScore,
                ruleEvidenceCount: rep.acousticScore !== null ? 2 : 1,
                modelTokenConfidence: null,
                requiresAcousticVerification: rep.subtype === 'ACCIDENTAL_WORD_REPETITION',
                config,
              });

              pushEventBounded({
                eventId: `${rep.id}_w${winIdx}`,
                trackId: request.trackId,
                category: 'WORD_REPETITION',
                subtype: rep.subtype,
                detectionState: rep.detectionState,
                startSec,
                endSec,
                durationSec,
                startFlicks: absStart,
                endFlicks: absEnd,
                durationFlicks: absEnd - absStart,
                relatedTokenIds: rep.affectedTokenIds,
                relatedText: rep.repeatedText,
                acousticEvidence: {
                  notes:
                    rep.acousticEnergyRatio !== null
                      ? [`نسبت انرژی RMS تکرار دوم به اول: ${rep.acousticEnergyRatio}x`]
                      : ['انرژی آکوستیک در دسترس نیست'],
                },
                linguisticEvidence: {
                  repetitionCount: 2,
                  notes: [`فاصله زمانی تکرار: ${rep.temporalSeparationMs}ms`],
                },
                detectionMethod: fused.detectionMethod,
                confidence: fused.decisionScore,
                uncertaintyState:
                  rep.subtype === 'LEGITIMATE_LEXICAL_REPETITION'
                    ? 'LOW_UNCERTAINTY'
                    : fused.uncertaintyState,
                scores: fused.scores,
                provenance: {
                  engineVersion: SPEECH_EVENT_ENGINE_VERSION,
                  thresholdConfigVersion: config.version,
                  detectorModule: 'PersianSemanticRepetitionEngine',
                  capabilityMode: 'heuristic',
                  analysisWindowIndex: winIdx,
                  evaluatedSampleRate: sampleRate,
                },
                eligibleForEditSuggestion: rep.eligibleForDeletionSuggestion,
                requiresHumanReview: rep.requiresHumanReview,
                explanationFa: rep.reasonFa,
              });
            }
          }

          // 1d. Window-local detailed disfluencies (fillers, syllable/phoneme reps, false starts, self-corrections)
          if (windowTokens.length > 0) {
            const detailedDisfluencies =
              PersianDisfluencyEngine.analyzeSpeechDisfluenciesDetailed(windowTokens, {
                hasAcousticEvidence: true,
              });

            for (const dis of detailedDisfluencies) {
              const startSec = Number(TimeMath.flicksToSeconds(dis.targetRange.start).toFixed(4));
              const endSec = Number(TimeMath.flicksToSeconds(dis.targetRange.end).toFixed(4));
              const durationSec = Number(Math.max(0, endSec - startSec).toFixed(4));

              // Measure bounded acoustic evidence for this token span inside the current window
              const relStartSample = Math.max(
                0,
                Math.floor((startSec - offsetSeconds) * sampleRate),
              );
              const relEndSample = Math.min(
                windowPcm.length,
                Math.floor((endSec - offsetSeconds) * sampleRate),
              );
              const acousticSnippet = this.measureTokenAcousticSnippet(
                windowPcm,
                relStartSample,
                relEndSample,
                sampleRate,
              );

              const acousticScore =
                acousticSnippet.hasSignal
                  ? dis.category === 'FILLER' && dis.subtype === 'VOCAL_FILLED_PAUSE'
                    ? Math.min(0.92, 0.72 + (durationSec >= 0.16 ? 0.14 : 0.04))
                    : dis.category === 'SYLLABLE_REPETITION' || dis.category === 'STUTTER'
                      ? 0.76
                      : 0.68
                  : null;

              const fused = fuseSpeechEventEvidence({
                category: dis.category,
                acousticScore,
                linguisticScore: dis.linguisticScore,
                ruleEvidenceCount: dis.ruleEvidenceCount,
                modelTokenConfidence: dis.modelTokenConfidence,
                requiresAcousticVerification:
                  dis.category === 'STUTTER' || dis.category === 'SYLLABLE_REPETITION',
                config,
              });

              pushEventBounded({
                eventId: `${dis.id}_w${winIdx}`,
                trackId: request.trackId,
                category: dis.category,
                subtype: dis.subtype,
                detectionState: dis.detectionState,
                startSec,
                endSec,
                durationSec,
                startFlicks: dis.targetRange.start,
                endFlicks: dis.targetRange.end,
                durationFlicks: dis.targetRange.end - dis.targetRange.start,
                relatedTokenIds: dis.affectedTokenIds,
                relatedText: dis.relatedText,
                acousticEvidence: acousticSnippet.evidence,
                linguisticEvidence: {
                  matchedLexiconId: dis.matchedLexiconId,
                  canonicalForm: dis.canonicalForm,
                  linguisticRole: dis.linguisticRole,
                  preservedAlternateSpanText: dis.preservedSpanText,
                  preservedAlternateRangeSec: dis.preservedSpanRange
                    ? {
                        startSec: Number(
                          TimeMath.flicksToSeconds(dis.preservedSpanRange.start).toFixed(4),
                        ),
                        endSec: Number(
                          TimeMath.flicksToSeconds(dis.preservedSpanRange.end).toFixed(4),
                        ),
                      }
                    : undefined,
                  notes: dis.notes,
                },
                detectionMethod: fused.detectionMethod,
                confidence: fused.decisionScore,
                uncertaintyState:
                  dis.subtype === 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED'
                    ? 'LOW_UNCERTAINTY'
                    : fused.uncertaintyState,
                scores: fused.scores,
                provenance: {
                  engineVersion: SPEECH_EVENT_ENGINE_VERSION,
                  thresholdConfigVersion: config.version,
                  detectorModule: 'PersianDisfluencyEngine',
                  capabilityMode: 'heuristic',
                  analysisWindowIndex: winIdx,
                  evaluatedSampleRate: sampleRate,
                },
                eligibleForEditSuggestion: dis.potentiallyRemovable,
                requiresHumanReview: dis.requiresHumanReview,
                nonMedicalNotice: dis.nonMedicalNotice,
                explanationFa: dis.reasonFa,
              });
            }
          }

          completedWindows++;
          request.onProgress?.({
            completedWindows,
            totalWindows,
            eventsSoFar: allEvents.length,
          });
        } finally {
          // Deterministic memory reservation release after every window (even on error or abort)
          if (featRes) budget.release(featRes);
          if (pcmRes) budget.release(pcmRes);
        }

        // Yield cooperatively between windows so React UI stays responsive on long recordings
        if (winIdx + 1 < totalWindows && !request.signal?.aborted) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } else if (timedTokens.length > 0 && !request.signal?.aborted) {
      // Linguistic-only path when PCM is absent -> strictly exposes missing acoustic evidence!
      warnings.push(
        'داده صوتی PCM در دسترس نبود؛ رویدادهای نیازمند تأیید آکوستیکی با وضعیت عدم‌قطعیت (INSUFFICIENT_EVIDENCE) علامت‌گذاری شدند.',
      );

      const detailedDisfluencies = PersianDisfluencyEngine.analyzeSpeechDisfluenciesDetailed(
        timedTokens,
        { hasAcousticEvidence: false },
      );
      for (const dis of detailedDisfluencies) {
        const startSec = Number(TimeMath.flicksToSeconds(dis.targetRange.start).toFixed(4));
        const endSec = Number(TimeMath.flicksToSeconds(dis.targetRange.end).toFixed(4));
        const durationSec = Number(Math.max(0, endSec - startSec).toFixed(4));
        const fused = fuseSpeechEventEvidence({
          category: dis.category,
          acousticScore: null,
          linguisticScore: dis.linguisticScore,
          ruleEvidenceCount: dis.ruleEvidenceCount,
          modelTokenConfidence: dis.modelTokenConfidence,
          requiresAcousticVerification:
            dis.category === 'STUTTER' || dis.category === 'SYLLABLE_REPETITION',
          config,
        });
        pushEventBounded({
          eventId: `${dis.id}_ling`,
          trackId: request.trackId,
          category: dis.category,
          subtype: dis.subtype,
          detectionState: dis.detectionState,
          startSec,
          endSec,
          durationSec,
          startFlicks: dis.targetRange.start,
          endFlicks: dis.targetRange.end,
          durationFlicks: dis.targetRange.end - dis.targetRange.start,
          relatedTokenIds: dis.affectedTokenIds,
          relatedText: dis.relatedText,
          linguisticEvidence: {
            matchedLexiconId: dis.matchedLexiconId,
            canonicalForm: dis.canonicalForm,
            linguisticRole: dis.linguisticRole,
            preservedAlternateSpanText: dis.preservedSpanText,
            notes: dis.notes,
          },
          detectionMethod: fused.detectionMethod,
          confidence: fused.decisionScore,
          uncertaintyState: fused.uncertaintyState,
          scores: fused.scores,
          provenance: {
            engineVersion: SPEECH_EVENT_ENGINE_VERSION,
            thresholdConfigVersion: config.version,
            detectorModule: 'PersianDisfluencyEngine',
            capabilityMode: 'heuristic',
          },
          eligibleForEditSuggestion: dis.potentiallyRemovable,
          requiresHumanReview: true,
          nonMedicalNotice: dis.nonMedicalNotice,
          explanationFa: dis.reasonFa,
        });
      }

      const wordReps = PersianSemanticRepetitionEngine.classifyWordRepetitionsDetailed(timedTokens);
      for (const rep of wordReps) {
        const startSec = Number(TimeMath.flicksToSeconds(rep.targetRange.start).toFixed(4));
        const endSec = Number(TimeMath.flicksToSeconds(rep.targetRange.end).toFixed(4));
        const durationSec = Number(Math.max(0, endSec - startSec).toFixed(4));
        const fused = fuseSpeechEventEvidence({
          category: 'WORD_REPETITION',
          acousticScore: null,
          linguisticScore: rep.linguisticScore,
          ruleEvidenceCount: 1,
          modelTokenConfidence: null,
          requiresAcousticVerification: rep.subtype === 'ACCIDENTAL_WORD_REPETITION',
          config,
        });
        pushEventBounded({
          eventId: `${rep.id}_ling`,
          trackId: request.trackId,
          category: 'WORD_REPETITION',
          subtype: rep.subtype,
          detectionState: rep.detectionState,
          startSec,
          endSec,
          durationSec,
          startFlicks: rep.targetRange.start,
          endFlicks: rep.targetRange.end,
          durationFlicks: rep.targetRange.end - rep.targetRange.start,
          relatedTokenIds: rep.affectedTokenIds,
          relatedText: rep.repeatedText,
          detectionMethod: fused.detectionMethod,
          confidence: fused.decisionScore,
          uncertaintyState: fused.uncertaintyState,
          scores: fused.scores,
          provenance: {
            engineVersion: SPEECH_EVENT_ENGINE_VERSION,
            thresholdConfigVersion: config.version,
            detectorModule: 'PersianSemanticRepetitionEngine',
            capabilityMode: 'heuristic',
          },
          eligibleForEditSuggestion: false,
          requiresHumanReview: true,
          explanationFa: rep.reasonFa,
        });
      }

      completedWindows = 1;
    }

    // --- 2. Cross-Window Semantic Retakes & Self-Relative Prosody (only on analyzed span) ---
    const analyzedDurationSec = hasAudio
      ? Number(Math.min(totalRecordingDurationSec, completedWindows * windowSec).toFixed(4))
      : totalRecordingDurationSec;

    const analyzedTokens = timedTokens.filter(
      (t) => !hasAudio || TimeMath.flicksToSeconds(t.range.start) <= analyzedDurationSec + 0.05,
    );

    let prosodyReport: ComprehensiveProsodyReport | null = null;
    if (analyzedTokens.length > 0) {
      // Semantic retakes (reformulations / repeated takes across pauses)
      const retakes = PersianSemanticRepetitionEngine.detectSemanticRetakes(analyzedTokens);
      for (const rt of retakes) {
        const startSec = Number(TimeMath.flicksToSeconds(rt.firstTakeDeleteRange.start).toFixed(4));
        const endSec = Number(TimeMath.flicksToSeconds(rt.firstTakeDeleteRange.end).toFixed(4));
        const durationSec = Number(Math.max(0, endSec - startSec).toFixed(4));
        const fused = fuseSpeechEventEvidence({
          category: 'SELF_CORRECTION',
          acousticScore: null,
          linguisticScore: rt.semanticSimilarityScore,
          ruleEvidenceCount: 2,
          modelTokenConfidence: null,
          config,
        });
        pushEventBounded({
          eventId: `sem_${rt.retakeId}`,
          trackId: request.trackId,
          category: 'SELF_CORRECTION',
          subtype: 'REFORMULATION',
          detectionState: 'PROBABLE',
          startSec,
          endSec,
          durationSec,
          startFlicks: rt.firstTakeDeleteRange.start,
          endFlicks: rt.firstTakeDeleteRange.end,
          durationFlicks: rt.firstTakeDeleteRange.end - rt.firstTakeDeleteRange.start,
          relatedText: rt.firstTakeText,
          linguisticEvidence: {
            semanticSimilarityScore: rt.semanticSimilarityScore,
            preservedAlternateSpanText: rt.secondTakeText,
            preservedAlternateRangeSec: {
              startSec: Number(TimeMath.flicksToSeconds(rt.secondTakeKeepRange.start).toFixed(4)),
              endSec: Number(TimeMath.flicksToSeconds(rt.secondTakeKeepRange.end).toFixed(4)),
            },
          },
          detectionMethod: 'HEURISTIC_LINGUISTIC',
          confidence: fused.decisionScore,
          uncertaintyState: fused.uncertaintyState,
          scores: fused.scores,
          provenance: {
            engineVersion: SPEECH_EVENT_ENGINE_VERSION,
            thresholdConfigVersion: config.version,
            detectorModule: 'PersianSemanticRepetitionEngine',
            capabilityMode: 'heuristic',
          },
          eligibleForEditSuggestion: false,
          requiresHumanReview: true,
          explanationFa: `${rt.reasonFa} — هر دو برداشت برای تصمیم‌گیری کاربر حفظ شده‌اند.`,
        });
      }

      // Self-relative prosody & pacing (uses timing + optional bounded pitch check without full PCM copy)
      prosodyReport = PersianProsodyAndPacingAnalyzer.analyzeComprehensiveProsody(
        analyzedTokens,
        new Float32Array(0),
        sampleRate,
        config,
      );

      for (const anom of prosodyReport.anomalies) {
        const startSec = Number(TimeMath.flicksToSeconds(anom.range.start).toFixed(4));
        const endSec = Number(TimeMath.flicksToSeconds(anom.range.end).toFixed(4));
        const durationSec = Number(Math.max(0, endSec - startSec).toFixed(4));
        const fused = fuseSpeechEventEvidence({
          category: 'PACING_ANOMALY',
          acousticScore: null,
          linguisticScore: anom.score,
          ruleEvidenceCount: 1,
          modelTokenConfidence: null,
          config,
        });
        pushEventBounded({
          eventId: anom.anomalyId,
          trackId: request.trackId,
          category: 'PACING_ANOMALY',
          subtype: anom.subtype,
          detectionState: 'PROBABLE',
          startSec,
          endSec,
          durationSec,
          startFlicks: anom.range.start,
          endFlicks: anom.range.end,
          durationFlicks: anom.range.end - anom.range.start,
          linguisticEvidence: {
            speakingRateWpm: anom.speakingRateWpm,
            articulationRateWpm: anom.articulationRateWpm,
            speakerBaselineWpm: anom.speakerBaselineWpm,
          },
          detectionMethod: 'HEURISTIC_LINGUISTIC',
          confidence: fused.decisionScore,
          uncertaintyState: anom.uncertaintyState,
          scores: fused.scores,
          provenance: {
            engineVersion: SPEECH_EVENT_ENGINE_VERSION,
            thresholdConfigVersion: config.version,
            detectorModule: 'PersianProsodyAndPacingAnalyzer',
            capabilityMode: 'heuristic',
          },
          eligibleForEditSuggestion: false,
          requiresHumanReview: true,
          explanationFa: anom.explanationFa,
        });
      }
    }

    // Sort events deterministically by start time
    allEvents.sort((a, b) => a.startSec - b.startSec || a.eventId.localeCompare(b.eventId));

    // Build strictly reversible, boundary-validated editing suggestions (never executed!)
    const bridge = buildTimelineSuggestionsFromSpeechEvents(allEvents, {
      maxTimelineDurationSec:
        totalRecordingDurationSec > 0 ? totalRecordingDurationSec : undefined,
      tracks: request.tracks,
      includeNoEditRecommendations: request.includeNoEditSuggestions ?? true,
    });

    const estimatedNoiseFloorDbfs =
      noiseFloorSamples.length > 0
        ? Number(
            (
              noiseFloorSamples.reduce((a, b) => a + b, 0) / noiseFloorSamples.length
            ).toFixed(1),
          )
        : null;

    const limitationNoteFa =
      nonVerbalCapability === 'model-based'
        ? `تحلیل هیوریستیک تپق/سکوت/ریتم + مدل عصبی رویداد غیرکلامی (${request.nonVerbalModelAdapter?.modelId}). هیچ ویرایشی به‌صورت خودکار اعمال نشده است.`
        : nonVerbalCapability === 'unsupported'
          ? 'حالت مدل‌محور رویدادهای غیرکلامی در دسترس نیست (UNSUPPORTED). سایر بخش‌ها با هیوریستیک سیگنال و زبان فارسی اجرا شده‌اند.'
          : 'تحلیل مبتنی بر هیوریستیک آکوستیک و قواعد زبان فارسی است (مدل عصبی اختصاصی رویداد غیرکلامی نصب نیست). امتیازها غیرکالیبره هستند و جایگزین بررسی انسانی نیستند.';

    return {
      engineVersion: SPEECH_EVENT_ENGINE_VERSION,
      thresholdConfigVersion: config.version,
      trackId: request.trackId,
      cancelled,
      completedWindows,
      totalWindows,
      analyzedDurationSec,
      totalRecordingDurationSec,
      estimatedNoiseFloorDbfs,
      capabilitySummary: {
        fillers: 'heuristic',
        repetitions: 'heuristic',
        silence: vadUsed ? 'hybrid-vad' : 'heuristic',
        nonVerbal: nonVerbalCapability,
        prosody: 'heuristic',
      },
      events: allEvents,
      suggestions: bridge.suggestions,
      rejectedNonVocalCandidates,
      prosodyReport,
      rejectedInvalidBoundaryCount: bridge.rejectedInvalidBoundaryCount,
      truncatedByEventCap,
      peakReservedBytes,
      warnings,
      limitationNoteFa,
    };
  }

  private static measureTokenAcousticSnippet(
    windowPcm: Float32Array,
    startSample: number,
    endSample: number,
    sampleRate: number,
  ): { hasSignal: boolean; evidence: SpeechEventAcousticEvidence } {
    if (
      !Number.isFinite(startSample) ||
      !Number.isFinite(endSample) ||
      endSample <= startSample ||
      startSample < 0 ||
      endSample > windowPcm.length
    ) {
      return { hasSignal: false, evidence: { notes: ['بازه خارج از پنجره PCM'] } };
    }
    const len = endSample - startSample;
    let sumSq = 0;
    let peak = 0;
    let zcr = 0;
    let prev = 0;
    for (let i = startSample; i < endSample; i++) {
      const raw = windowPcm[i];
      const s = Number.isFinite(raw) ? raw : 0;
      const abs = Math.abs(s);
      sumSq += s * s;
      if (abs > peak) peak = abs;
      if (i > startSample && ((prev >= 0 && s < 0) || (prev < 0 && s >= 0))) {
        zcr++;
      }
      prev = s;
    }
    const rms = Math.sqrt(sumSq / len);
    const rmsDb = Number((20 * Math.log10(Math.max(rms, 1e-9))).toFixed(1));
    const peakDb = Number((20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1));
    const zcrRatio = Number((zcr / len).toFixed(4));
    const hasSignal = peak > 1e-4 && len >= Math.floor(sampleRate * 0.02);

    return {
      hasSignal,
      evidence: {
        rmsDb,
        peakDb,
        zcrRatio,
      },
    };
  }
}
