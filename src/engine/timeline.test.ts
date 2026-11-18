import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBatchRecommendationsAtomically,
  applySyncSafeCut,
  computeMultiWordCutRange,
  computeTimelineDurationFlicks,
  determineSyncSafeEditMode,
  projectRecommendationsAfterCut,
  projectTokensAfterCut,
  splitTrackClipsAtPlayhead,
  TimelineHistoryManager,
} from './timeline';
import {
  alignPersianScriptToAudio,
  analyzeMultiTrackCrosstalkAndDiarization,
  analyzeMultiTrackPhaseCompatibility,
  analyzeStudioRecordingAcoustics,
  analyzeTranscriptProsodyAndChapters,
  applyCustomLexiconAndPhoneticCorrections,
  applyPersianVoice8BandEqToPcm,
  applyPunchInSpectralMatchAndWatermarkToSelectedTokens,
  applySpectralWienerDenoiseToPcm,
  applyWsolaTimeStretchToSelectedTokens,
  attenuateBreathsAndCoughsInAudio,
  compareReferenceScriptWithTranscript,
  convertTranscriptColloquialToFormal,
  exportTranscriptToPraatTextGrid,
  exportTranscriptToSrt,
  exportTranscriptToVtt,
  normalizeNumbersAndCompoundsInTranscript,
  optimizeAndAnalyzeTrilingualAsrTranscript,
  redactSelectedTokensInAudioAndTranscript,
  restorePersianProsodicPunctuation,
  searchTranscriptPhonetically,
  tokenizePersianTranscriptWords,
} from './persianAsrTranscriber';
import {
  buildDefaultPersianPodcastProject,
  buildSyntheticMicRecordingPcm,
  ingestRecordedPcmTake,
} from './audioFixtures';
import { PersianWordToken, Track } from '../contracts/v1_2';
import { flicksToSeconds, secondsToFlicks } from './timebase';
import {
  sanitizeSecretsFromText,
  validateAndPreprocessAudioForLab,
} from '../ai-engine/asr/AsrExperimentationLabCore';
import {
  applyVersionedNormalization,
  assignZeroLeakageDatasetSplits,
  classifyTranscriptErrorsIntoTaxonomy,
  evaluateSampleQuality11Gates,
  evaluateWithNormalizationVersion,
  IdempotentExperimentTaskDeduplicator,
  INITIAL_VERIFIED_STUDIO_CORPUS,
  runPairedBootstrapAndHolmBonferroni,
} from '../ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine';
import {
  applyDeterministicTrainOnlyAugmentation,
  buildThreeTierTrainingTranscript,
  IndependentAsrCheckpointManager,
  runThreeLayerPostProcessing,
} from '../ai-engine/asr/IndependentAsrModelDevelopmentEngine';
import {
  calculateQwenCumulativeAudioOverhead,
  convertChannelsToMonoSafely,
  decodeAndValidateAsrStreamProtocolV1BinaryFrame,
  encodeAsrStreamProtocolV1BinaryFrame,
  encodeFloat32ToPcm16LittleEndian,
  evaluateStreamingRevisionStability,
  SessionAudioSequenceValidator,
  StatefulStreamingResampler16k,
  StatefulStreamingVadEngine,
} from '../ai-engine/asr/RealTimeStreamingAsrEngine';
import {
  AtomicBudgetGovernanceController,
  evaluateCascadeTrigger,
  makeAdaptiveRoutingDecision,
  PHASE6_SCORING_WEIGHT_PROFILES,
  ProviderCircuitBreakerManager,
  runOfflineCounterfactualRegretEvaluation,
  validateScoringWeightsSumToOne,
} from '../ai-engine/asr/AdaptiveAsrRouterEngine';
import {
  calculateArchitectureParameterBreakdown,
  computeHybridCtcRnntLoss,
  computeMultiObjectiveParetoFrontier,
  decodeCtcFrameSequence,
  evaluateFromScratchGoNoGoDecision,
  mergeOverlappingLongFormSegments,
} from '../ai-engine/asr/AdvancedModelResearchAndArchitectureEngine';
import {
  assertTenantIsolation,
  runAdversarialSecurityAndReadinessAudit,
  validateUploadedAudioSecurity,
} from '../ai-engine/asr/IndustrialValidationAndSecurityEngine';
import {
  advanceOrRollbackCanaryRollout,
  buildImmutableDatasetReleaseWithReplay,
  computeCohortPsiDrift,
  evaluateChampionVsChallengerGate,
  evaluateDoubleAnnotationAndAdjudicate,
  evaluateSampleConsentEligibility,
  scoreActiveLearningSample,
  selectActiveLearningBatchWithControlStream,
} from '../ai-engine/asr/ContinuousLearningAndEvolutionEngine';
import {
  computeIntegerOverageChargeMinor,
  PlatformControlPlaneService,
} from '../platform/PlatformControlPlaneEngine';
import { PlatformDataPlaneGateway } from '../platform/PlatformDataPlaneGateway';
import { ASRClient } from '../../sdk/typescript/src/index';

function makeSyncedTracks(): Track[] {
  return [
    {
      id: 't1',
      name: 'میزبان',
      speakerLabel: 'سارا',
      syncGroupId: 'podcast-sync',
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 't1',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(10) },
          sourceStartFlicks: 0,
          fadeInMs: 10,
          fadeOutMs: 10,
          gainDb: 0,
          muted: false,
        },
      ],
    },
    {
      id: 't2',
      name: 'مهمان',
      speakerLabel: 'آرش',
      syncGroupId: 'podcast-sync',
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'c2',
          assetId: 'a2',
          trackId: 't2',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(10) },
          sourceStartFlicks: 0,
          fadeInMs: 10,
          fadeOutMs: 10,
          gainDb: 0,
          muted: false,
        },
      ],
    },
  ];
}

test('Multi-track sync protection chooses In-Place Room Tone when peer track is speaking', () => {
  const tracks = makeSyncedTracks();
  const tokens: PersianWordToken[] = [
    {
      id: 'tok-peer',
      trackId: 't2',
      speakerName: 'آرش',
      originalText: 'دقیقاً',
      normalizedText: 'دقیقاً',
      displayText: 'دقیقاً',
      range: { startFlicks: secondsToFlicks(3.0), endFlicks: secondsToFlicks(3.8) },
      confidence: 0.95,
      alignmentSource: 'ASR',
    },
  ];

  const decision = determineSyncSafeEditMode(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(3.1), endFlicks: secondsToFlicks(3.6) },
    tokens,
  );
  assert.equal(decision.mode, 'in-place-room-tone-suppression');

  const edited = applySyncSafeCut(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(3.1), endFlicks: secondsToFlicks(3.6) },
    decision.mode,
  );

  // Total timeline duration must stay exact 10s so Track 2 remains in sync!
  assert.equal(computeTimelineDurationFlicks(edited), secondsToFlicks(10));
  const roomToneClip = edited[0].clips.find((c) => c.kind === 'room-tone-fill');
  assert.ok(roomToneClip !== undefined);
});

test('Sync-Locked Ripple Cut shortens both synced tracks equally when all peers are silent', () => {
  const tracks = makeSyncedTracks();
  const decision = determineSyncSafeEditMode(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(5.0), endFlicks: secondsToFlicks(6.5) },
    [],
  );
  assert.equal(decision.mode, 'sync-locked-ripple-cut');

  const edited = applySyncSafeCut(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(5.0), endFlicks: secondsToFlicks(6.5) },
    decision.mode,
  );

  // Both Track 1 and Track 2 shorten from 10s to 8.5s in lockstep
  assert.equal(computeTimelineDurationFlicks([edited[0]]), secondsToFlicks(8.5));
  assert.equal(computeTimelineDurationFlicks([edited[1]]), secondsToFlicks(8.5));
});

test('projectTokensAfterCut shifts subsequent tokens on ripple cut and marks suppressed tokens on room-tone fill', () => {
  const tracks = makeSyncedTracks();
  const tokens: PersianWordToken[] = [
    {
      id: 'w1',
      trackId: 't1',
      speakerName: 'سارا',
      originalText: 'سلام',
      normalizedText: 'سلام',
      displayText: 'سلام',
      range: { startFlicks: secondsToFlicks(1.0), endFlicks: secondsToFlicks(2.0) },
      confidence: 0.95,
      alignmentSource: 'ASR',
    },
    {
      id: 'w2',
      trackId: 't1',
      speakerName: 'سارا',
      originalText: 'اممم',
      normalizedText: 'اممم',
      displayText: 'اممم',
      range: { startFlicks: secondsToFlicks(2.5), endFlicks: secondsToFlicks(3.5) },
      confidence: 0.88,
      alignmentSource: 'ASR',
      isDisfluency: true,
    },
    {
      id: 'w3',
      trackId: 't2',
      speakerName: 'آرش',
      originalText: 'ادامه',
      normalizedText: 'ادامه',
      displayText: 'ادامه',
      range: { startFlicks: secondsToFlicks(5.0), endFlicks: secondsToFlicks(6.0) },
      confidence: 0.96,
      alignmentSource: 'ASR',
    },
  ];

  // 1. Ripple cut of w2 [2.5s .. 3.5s] (1.0s cut)
  const projectedRipple = projectTokensAfterCut(
    tokens,
    tracks,
    't1',
    { startFlicks: secondsToFlicks(2.5), endFlicks: secondsToFlicks(3.5) },
    'sync-locked-ripple-cut',
  );
  assert.equal(projectedRipple.length, 2);
  assert.equal(projectedRipple[0].id, 'w1');
  assert.equal(projectedRipple[1].id, 'w3');
  // w3 was at [5.0 .. 6.0], must now be shifted by 1.0s to [4.0 .. 5.0]
  assert.equal(flicksToSeconds(projectedRipple[1].range.startFlicks), 4.0);
  assert.equal(flicksToSeconds(projectedRipple[1].range.endFlicks), 5.0);

  // 2. In-place room-tone suppression of w2 [2.5s .. 3.5s]
  const projectedInPlace = projectTokensAfterCut(
    tokens,
    tracks,
    't1',
    { startFlicks: secondsToFlicks(2.5), endFlicks: secondsToFlicks(3.5) },
    'in-place-room-tone-suppression',
  );
  assert.equal(projectedInPlace.length, 3);
  assert.equal(projectedInPlace[1].isCrosstalkSuppressed, true);
  assert.equal(flicksToSeconds(projectedInPlace[2].range.startFlicks), 5.0);
});

test('splitTrackClipsAtPlayhead splits clips non-destructively and computeMultiWordCutRange detects Ezafe risk', () => {
  const tracks = makeSyncedTracks();
  const { tracks: splitTracks, splitCount } = splitTrackClipsAtPlayhead(
    tracks,
    secondsToFlicks(4.0),
  );
  assert.equal(splitCount, 2);
  assert.equal(splitTracks[0].clips.length, 2);
  assert.equal(splitTracks[0].clips[0].timelineRange.endFlicks, secondsToFlicks(4.0));
  assert.equal(splitTracks[0].clips[1].timelineRange.startFlicks, secondsToFlicks(4.0));
  assert.equal(splitTracks[0].clips[1].sourceStartFlicks, secondsToFlicks(4.0));

  const project = buildDefaultPersianPodcastProject();
  // Select w4 («جذاب») which follows w3 («پادکستِ» with hasTrailingEzafeRisk: true)
  const cutSpec = computeMultiWordCutRange(project.tokens, ['w4']);
  assert.ok(cutSpec !== null);
  assert.equal(cutSpec.combinedText, 'جذاب');
  assert.equal(cutSpec.hasTrailingEzafeRisk, true);

  // Project recommendations after a ripple cut
  const nextRecs = projectRecommendationsAfterCut(
    project.recommendations,
    project.tracks,
    'track-host',
    { startFlicks: secondsToFlicks(4.42), endFlicks: secondsToFlicks(5.52) },
    'sync-locked-ripple-cut',
    'rec-mutual-pause',
  );
  assert.equal(nextRecs.find((r) => r.id === 'rec-mutual-pause')?.status, 'Accepted');
});

test('alignPersianScriptToAudio tokenizes ZWNJ compounds and aligns words to acoustic bursts', () => {
  const words = tokenizePersianTranscriptWords('ما در پادکست ها صحبت مي كنيم اممم');
  assert.deepEqual(words, ['ما', 'در', 'پادکست\u200cها', 'صحبت', 'می\u200cکنیم', 'اممم']);

  const project = buildDefaultPersianPodcastProject();
  const hostPcm = project.pcmSources['asset-host'];
  const hostAsset = project.assets['asset-host'];

  const aligned = alignPersianScriptToAudio({
    pcm: hostPcm,
    sampleRate: project.sampleRate,
    trackId: 'track-host',
    speakerName: 'سارا',
    rawTranscriptText: 'سلام امروز پادکست جذاب ما رفتیممممم درباره هوش مصنوعی صحبت می کنیم اممم',
    acousticProfile: hostAsset.acousticProfile,
    alignmentSource: 'ForcedAlignment',
  });

  assert.ok(aligned.tokens.length >= 10);
  const disfluencyTok = aligned.tokens.find((t) => t.isDisfluency);
  assert.ok(disfluencyTok !== undefined);
  assert.ok(aligned.recommendations.length > 0);
});

test('TimelineHistoryManager supports Undo/Redo and atomic token snapshots', () => {
  const mgr = new TimelineHistoryManager();
  const base = makeSyncedTracks();
  const next = applySyncSafeCut(
    base,
    't1',
    { startFlicks: secondsToFlicks(1), endFlicks: secondsToFlicks(2) },
    'sync-locked-ripple-cut',
  );

  mgr.commitTransaction({
    coalescingKey: 'slider-gain',
    type: 'dsp-parameter-change',
    description: 'تغییر گین مستر',
    beforeTracks: base,
    afterTracks: base,
  });
  mgr.commitTransaction({
    coalescingKey: 'slider-gain',
    type: 'dsp-parameter-change',
    description: 'تغییر گین مستر نهایی',
    beforeTracks: base,
    afterTracks: next,
  });

  // Coalesced into 1 transaction
  assert.equal(mgr.getHistory().length, 1);
  assert.equal(mgr.canUndo(), true);
  const undone = mgr.undo();
  assert.ok(undone !== null);
  assert.equal(mgr.canRedo(), true);
});

test('applyBatchRecommendationsAtomically applies all safe cuts and preserves Ezafe-warned content words', () => {
  const project = buildDefaultPersianPodcastProject();
  const batch = applyBatchRecommendationsAtomically({
    tracks: project.tracks,
    tokens: project.tokens,
    recommendations: project.recommendations,
  });

  // 3 safe recommendations applied (rec-filler-stretch, rec-mutual-pause, rec-crosstalk-bleed)
  // while rec-ezafe-trap (caution on «جذاب») remains Pending!
  assert.equal(batch.appliedCount, 3);
  assert.equal(batch.rippleCutCount, 1);
  assert.equal(batch.roomToneCount, 2);
  const ezafeRec = batch.recommendations.find((r) => r.id === 'rec-ezafe-trap');
  assert.equal(ezafeRec?.status, 'Pending');
  // Timeline duration shortened by the ~1.1s mutual pause ripple cut
  assert.ok(computeTimelineDurationFlicks(batch.tracks) < secondsToFlicks(11.2));
});

test('Phonetic search, colloquial formalization, F0 punctuation restoration, SRT/VTT export, and studio mic recording', () => {
  const project = buildDefaultPersianPodcastProject();

  // 1. Phonetic homophone search: «سهبط» matches «صحبت» (س/ص، ه/ح، ط/ت)
  const hits = searchTranscriptPhonetically(project.tokens, 'سهبط');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].matchType, 'HOMOPHONE_PHONETIC');
  assert.equal(hits[0].matchedDisplayText, 'صحبت');

  // 2. Colloquial to formal standard conversion («و نتیجه‌هاش عالیه» -> «و نتیجه‌هایش عالی است»)
  const formalResult = convertTranscriptColloquialToFormal(project.tokens);
  assert.ok(formalResult.convertedCount >= 1);
  const w15 = formalResult.tokens.find((t) => t.id === 'w15');
  assert.equal(w15?.displayText, 'و نتیجه\u200cهایش عالی است');
  // Immutable originalText preserved
  assert.equal(w15?.originalText, 'و نتیجه‌هاش عالیه');

  // 3. Prosodic punctuation restoration
  const hostPcm = project.pcmSources['asset-host'];
  const punctuated = restorePersianProsodicPunctuation(
    formalResult.tokens,
    hostPcm,
    project.sampleRate,
  );
  assert.equal(punctuated.length, formalResult.tokens.length);

  // 4. SRT & WebVTT export
  const srt = exportTranscriptToSrt(punctuated);
  const vtt = exportTranscriptToVtt(punctuated);
  assert.ok(srt.includes('-->'));
  assert.ok(vtt.startsWith('WEBVTT'));

  // 5. Studio mic recording ingestion
  const { pcm, defaultScript } = buildSyntheticMicRecordingPcm(48_000);
  const recorded = ingestRecordedPcmTake({
    pcm,
    sampleRate: 48_000,
    transcriptHint: defaultScript,
  });
  assert.equal(recorded.tokens.length, 10);
  assert.ok(recorded.recommendations.length >= 2);
});

test('Phase 3: Script-to-Audio deviation alignment, Audio PII Bleep/Muffle redaction, Spectral Wiener denoise, and Praat TextGrid export', () => {
  const project = buildDefaultPersianPodcastProject();
  const hostPcm = project.pcmSources['asset-host'];
  const hostAsset = project.assets['asset-host'];

  // 1. Compare clean reference manuscript against spoken tokens (detects extra spoken retakes w6 & w14)
  const diffReport = compareReferenceScriptWithTranscript({
    referenceScript:
      'سلام امروز پادکست جذاب ما درباره هوش مصنوعی صحبت می‌کنیم و نتیجه‌هایش عالی است',
    tokens: project.tokens,
    targetTrackId: 'track-host',
  });
  assert.ok(diffReport.extraCount >= 2);
  assert.ok(diffReport.extraSpokenTokenIds.includes('w6'));
  assert.ok(diffReport.extraSpokenTokenIds.includes('w14'));

  // 2. Spoken Numeral & Compound normalization
  const numeralTokens: PersianWordToken[] = [
    {
      id: 'num-1',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'پنجاه هزار تومان در نرم افزار',
      normalizedText: 'پنجاه هزار تومان در نرم افزار',
      displayText: 'پنجاه هزار تومان در نرم افزار',
      range: { startFlicks: secondsToFlicks(1), endFlicks: secondsToFlicks(2) },
      confidence: 0.95,
      alignmentSource: 'ASR',
    },
  ];
  const normalizedRes = normalizeNumbersAndCompoundsInTranscript(numeralTokens);
  assert.equal(normalizedRes.updatedCount, 1);
  assert.ok(normalizedRes.tokens[0].displayText.includes('۵۰٬۰۰۰ تومان'));
  assert.ok(normalizedRes.tokens[0].displayText.includes('نرم\u200cافزار'));

  // 3. Audio Redaction (1kHz Broadcast Bleep on selected word w6)
  const redactRes = redactSelectedTokensInAudioAndTranscript({
    pcm: hostPcm,
    roomToneSample: hostAsset.acousticProfile.roomToneSample,
    sampleRate: project.sampleRate,
    tokens: project.tokens,
    selectedTokenIds: ['w6'],
    mode: 'BROADCAST_BLEEP_1KHZ',
  });
  assert.equal(redactRes.redactedCount, 1);
  const redactedW6 = redactRes.updatedTokens.find((t: PersianWordToken) => t.id === 'w6');
  assert.ok(redactedW6?.displayText.includes('[بوق سانسور'));

  // 4. Decision-Directed Spectral Wiener Denoiser
  const denoised = applySpectralWienerDenoiseToPcm({
    pcm: hostPcm.subarray(0, 48000),
    roomToneSample: hostAsset.acousticProfile.roomToneSample,
  });
  assert.equal(denoised.denoisedPcm.length, 48000);
  assert.ok(Number.isFinite(denoised.afterRmsDb));

  // 5. Praat .TextGrid Linguistic Export
  const textGrid = exportTranscriptToPraatTextGrid(project.tokens, 11.2);
  assert.ok(textGrid.includes('ooTextFile'));
  assert.ok(textGrid.includes('TextGrid'));
});

test('Phase 4: Pitch-preserving WSOLA word time-stretch, Custom Persian Lexicon homophone correction, and Prosody/Chapter analysis', () => {
  const project = buildDefaultPersianPodcastProject();
  const hostPcm = project.pcmSources['asset-host'];

  // 1. Custom Persian Lexicon homophone correction («سهبط» -> «صحبت», «تایپ اسکریپت» -> «تایپ‌اسکریپت»)
  const misspelledTokens: PersianWordToken[] = [
    {
      id: 'lex-tok-1',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'سهبط',
      normalizedText: 'سهبط',
      displayText: 'سهبط',
      range: { startFlicks: secondsToFlicks(1.0), endFlicks: secondsToFlicks(1.5) },
      confidence: 0.68,
      alignmentSource: 'ASR',
    },
  ];
  const lexResult = applyCustomLexiconAndPhoneticCorrections({
    tokens: misspelledTokens,
    customVocabularyCsv: 'صحبت، طالقانی، تایپ‌اسکریپت',
  });
  assert.equal(lexResult.correctedCount, 1);
  assert.equal(lexResult.tokens[0].displayText, 'صحبت');
  assert.equal(lexResult.tokens[0].originalText, 'سهبط');

  // 2. WSOLA pitch-preserving time-stretch (0.8x slower expands duration and shifts subsequent tokens)
  const w4Before = project.tokens.find((t) => t.id === 'w4')!;
  const w5Before = project.tokens.find((t) => t.id === 'w5')!;
  const w4DurBefore = w4Before.range.endFlicks - w4Before.range.startFlicks;

  const stretched = applyWsolaTimeStretchToSelectedTokens({
    pcm: hostPcm,
    sampleRate: project.sampleRate,
    tokens: project.tokens,
    tracks: project.tracks,
    targetTrackId: 'track-host',
    selectedTokenIds: ['w4'],
    tempoRatio: 0.8,
  });
  const w4After = stretched.updatedTokens.find((t) => t.id === 'w4')!;
  const w5After = stretched.updatedTokens.find((t) => t.id === 'w5')!;
  const w4DurAfter = w4After.range.endFlicks - w4After.range.startFlicks;

  assert.ok(stretched.stretchedPcm.length > hostPcm.length);
  assert.ok(w4DurAfter > w4DurBefore);
  assert.ok(w5After.range.startFlicks > w5Before.range.startFlicks);

  // 3. Prosody WPM & Chapter Segmentation
  const report = analyzeTranscriptProsodyAndChapters({
    tokens: project.tokens,
    pcm: hostPcm,
    sampleRate: project.sampleRate,
  });
  assert.ok(report.prosodyWindows.length >= 1);
  assert.ok(report.prosodyWindows[0].netWordsPerMinute > 0);
  assert.ok(report.chapters.length >= 1);
});

test('Phase 5: Non-verbal breath/cough softening, Multi-Track crosstalk diarization, and RecordingQualityAdvisorEngine auto-DSP calibration', () => {
  const project = buildDefaultPersianPodcastProject();
  const hostPcm = project.pcmSources['asset-host'];
  const hostAsset = project.assets['asset-host'];

  // 1. Non-verbal breath & cough softening
  const breathRes = attenuateBreathsAndCoughsInAudio({
    pcm: hostPcm,
    roomToneSample: hostAsset.acousticProfile.roomToneSample,
    sampleRate: project.sampleRate,
    tokens: project.tokens,
    trackId: 'track-host',
  });
  assert.equal(breathRes.processedPcm.length, hostPcm.length);
  assert.ok(breathRes.attenuatedBreathCount >= 1);

  // 2. Multi-Track Crosstalk & Overlap Diarization
  const diarRes = analyzeMultiTrackCrosstalkAndDiarization({
    tracks: project.tracks,
    pcmSources: project.pcmSources,
    sampleRate: project.sampleRate,
    existingRecommendations: project.recommendations,
  });
  assert.ok(diarRes.primarySpeechSegments >= 1);
  assert.ok(diarRes.recommendations.length >= project.recommendations.length);

  // 3. Studio Recording Acoustic Advisor & Auto-DSP calibration
  const advisor = analyzeStudioRecordingAcoustics({
    pcm: hostPcm,
    roomToneSample: hostAsset.acousticProfile.roomToneSample,
    sampleRate: project.sampleRate,
  });
  assert.ok(Number.isFinite(advisor.report.signalToNoiseRatioDb));
  assert.ok(advisor.recommendedDsp.highPassHz >= 80);
});

test('Phase 6: 8-Band Persian Voice EQ, 4-Band Punch-In Spectral Matching + 19kHz BPSK Watermark, Multi-Track Phase Compatibility, and Cold-Open Teaser Hook', () => {
  const project = buildDefaultPersianPodcastProject();
  const hostPcm = project.pcmSources['asset-host'];
  const guestPcm = project.pcmSources['asset-guest'];
  const hostAsset = project.assets['asset-host'];

  // 1. 8-Band Parametric Persian Voice EQ & Z-plane frequency response
  const eqRes = applyPersianVoice8BandEqToPcm({
    pcm: hostPcm.subarray(0, 48000),
    sampleRate: project.sampleRate,
  });
  assert.equal(eqRes.eqPcm.length, 48000);
  assert.equal(eqRes.responseCurveDb.length, 8);
  // 50Hz notch cut must be negative dB, 3200Hz consonant presence boost must be positive dB
  const notch50 = eqRes.responseCurveDb.find((p) => p.freqHz === 50)!;
  const presence3200 = eqRes.responseCurveDb.find((p) => p.freqHz === 3200)!;
  assert.ok(notch50.gainDb < -10);
  assert.ok(presence3200.gainDb > 0.5);

  // 2. 4-Band Punch-In Spectral EQ Matching + 19kHz BPSK Spread-Spectrum Provenance Watermark
  const punchRes = applyPunchInSpectralMatchAndWatermarkToSelectedTokens({
    pcm: hostPcm,
    roomToneSample: hostAsset.acousticProfile.roomToneSample,
    sampleRate: project.sampleRate,
    tokens: project.tokens,
    selectedTokenIds: ['w9', 'w10'],
  });
  assert.equal(punchRes.matchedPcm.length, hostPcm.length);
  assert.equal(punchRes.isWatermarked, true);
  assert.ok(punchRes.watermarkConfidence >= 0.45);

  // 3. Multi-Track Stereo Phase & Mono Fold-Down Compatibility
  const phaseDiag = analyzeMultiTrackPhaseCompatibility({
    pcmA: hostPcm,
    pcmB: guestPcm,
    sampleRate: project.sampleRate,
  });
  assert.ok(Number.isFinite(phaseDiag.zeroLagPhaseCorrelation));
  assert.ok(Number.isFinite(phaseDiag.monoFoldDownLossDb));

  // 4. Cold-Open Teaser Hook extraction
  const prosodyReport = analyzeTranscriptProsodyAndChapters({
    tokens: project.tokens,
    pcm: hostPcm,
    sampleRate: project.sampleRate,
  });
  assert.ok(prosodyReport.bestTeaserTokenIds.length >= 2);
  assert.ok(prosodyReport.bestTeaserExcerptFa.length > 0);
});

test('Phase 7: Trilingual (Persian + English + Arabic) Code-Switching ASR, Cross-Script Phonetic Search, Bilateral Homophone Context Rescoring, and Platt Confidence Calibration', () => {
  const project = buildDefaultPersianPodcastProject();
  const hostPcm = project.pcmSources['asset-host'];

  const trilingualInputTokens: PersianWordToken[] = [
    {
      id: 'tri-1',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'ان',
      normalizedText: 'ان',
      displayText: 'ان',
      range: { startFlicks: secondsToFlicks(0.2), endFlicks: secondsToFlicks(0.35) },
      confidence: 0.91,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-2',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'شا',
      normalizedText: 'شا',
      displayText: 'شا',
      range: { startFlicks: secondsToFlicks(0.38), endFlicks: secondsToFlicks(0.55) },
      confidence: 0.92,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-3',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'الله',
      normalizedText: 'الله',
      displayText: 'الله',
      range: { startFlicks: secondsToFlicks(0.58), endFlicks: secondsToFlicks(0.85) },
      confidence: 0.94,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-4',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'معماری',
      normalizedText: 'معماری',
      displayText: 'معماری',
      range: { startFlicks: secondsToFlicks(1.0), endFlicks: secondsToFlicks(1.4) },
      confidence: 0.93,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-5',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'بک',
      normalizedText: 'بک',
      displayText: 'بک',
      range: { startFlicks: secondsToFlicks(1.45), endFlicks: secondsToFlicks(1.65) },
      confidence: 0.9,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-6',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'اند',
      normalizedText: 'اند',
      displayText: 'اند',
      range: { startFlicks: secondsToFlicks(1.68), endFlicks: secondsToFlicks(1.92) },
      confidence: 0.91,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-7',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'با',
      normalizedText: 'با',
      displayText: 'با',
      range: { startFlicks: secondsToFlicks(2.0), endFlicks: secondsToFlicks(2.18) },
      confidence: 0.96,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-8',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'تایپ',
      normalizedText: 'تایپ',
      displayText: 'تایپ',
      range: { startFlicks: secondsToFlicks(2.22), endFlicks: secondsToFlicks(2.5) },
      confidence: 0.92,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-9',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'اسکریپت',
      normalizedText: 'اسکریپت',
      displayText: 'اسکریپت',
      range: { startFlicks: secondsToFlicks(2.54), endFlicks: secondsToFlicks(2.9) },
      confidence: 0.93,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-10',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'دغیغا',
      normalizedText: 'دغیغا',
      displayText: 'دغیغا',
      range: { startFlicks: secondsToFlicks(3.0), endFlicks: secondsToFlicks(3.45) },
      confidence: 0.72,
      alignmentSource: 'ASR',
    },
    {
      id: 'tri-11',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'پایدار',
      normalizedText: 'پایدار',
      displayText: 'پایدار',
      range: { startFlicks: secondsToFlicks(3.5), endFlicks: secondsToFlicks(3.9) },
      confidence: 0.95,
      alignmentSource: 'ASR',
    },
  ];

  // 1. Optimize in LATIN_TECHNICAL mode
  const latinReport = optimizeAndAnalyzeTrilingualAsrTranscript({
    tokens: trilingualInputTokens,
    pcm: hostPcm,
    sampleRate: project.sampleRate,
    englishRenderMode: 'LATIN_TECHNICAL',
    preserveArabicOrthography: true,
  });

  // Verify Arabic multi-word expression «ان شا الله» merged into «إِنْ شَاءَ اللَّهُ» with detectedLanguage === 'AR'
  const arToken = latinReport.tokens.find((t) => t.id === 'tri-1+tri-2+tri-3');
  assert.ok(arToken !== undefined);
  assert.equal(arToken.detectedLanguage, 'AR');
  assert.equal(arToken.displayText, 'إِنْ شَاءَ اللَّهُ');

  // Verify English technical terms «بک اند» -> 'Backend' and «تایپ اسکریپت» -> 'TypeScript' with detectedLanguage === 'EN'
  const backendTok = latinReport.tokens.find((t) => t.id === 'tri-5+tri-6');
  const tsTok = latinReport.tokens.find((t) => t.id === 'tri-8+tri-9');
  assert.equal(backendTok?.detectedLanguage, 'EN');
  assert.equal(backendTok?.displayText, 'Backend');
  assert.equal(tsTok?.detectedLanguage, 'EN');
  assert.equal(tsTok?.displayText, 'TypeScript');

  // Verify Bilateral Bigram Context Rescoring corrected «دغیغا» -> «دقیقاً» (AR Tanwin) while keeping originalText === 'دغیغا'
  const correctedArAdv = latinReport.tokens.find((t) => t.id === 'tri-10');
  assert.equal(correctedArAdv?.displayText, 'دقیقاً');
  assert.equal(correctedArAdv?.originalText, 'دغیغا');
  assert.equal(correctedArAdv?.detectedLanguage, 'AR');

  // 2. Switch to PERSIAN_TRANSLITERATED mode and confirm English words render in Persian ZWNJ script
  const persianScriptReport = optimizeAndAnalyzeTrilingualAsrTranscript({
    tokens: latinReport.tokens,
    pcm: hostPcm,
    sampleRate: project.sampleRate,
    englishRenderMode: 'PERSIAN_TRANSLITERATED',
    preserveArabicOrthography: true,
  });
  const tsFaTok = persianScriptReport.tokens.find((t) => t.id === 'tri-8+tri-9');
  assert.equal(tsFaTok?.displayText, 'تایپ\u200cاسکریپت');

  // 3. Cross-Script Phonetic Search: searching Latin 'TypeScript' matches Persian 'تایپ‌اسکریپت' and vice versa
  const latinQueryOnFaTokens = searchTranscriptPhonetically(
    persianScriptReport.tokens,
    'TypeScript',
  );
  assert.ok(latinQueryOnFaTokens.length > 0);
  assert.ok(latinQueryOnFaTokens[0].matchedTokenIds.includes('tri-8+tri-9'));

  const faQueryOnLatinTokens = searchTranscriptPhonetically(
    latinReport.tokens,
    'تایپ اسکریپت',
  );
  assert.ok(faQueryOnLatinTokens.length > 0);
  assert.ok(faQueryOnLatinTokens[0].matchedTokenIds.includes('tri-8+tri-9'));

  const arQueryWithoutHarakat = searchTranscriptPhonetically(
    latinReport.tokens,
    'انشالله',
  );
  assert.ok(arQueryWithoutHarakat.length > 0);
  assert.ok(arQueryWithoutHarakat[0].matchedTokenIds.includes('tri-1+tri-2+tri-3'));
});

test('Phases 1-3: Versioned normalization, taxonomy, paired bootstrap, 11-gate QC, zero-leakage splits & idempotency', () => {
  const strict = applyVersionedNormalization('مي‌خواهم ۱۲۳ ي ك را ببينم!', 'fa_strict_v1');
  const relaxed = applyVersionedNormalization('میخواهم 123 ی ک را ببینم', 'fa_relaxed_v1');
  assert.ok(strict.includes('\u200c'));
  assert.equal(relaxed.includes('\u200c'), false);

  const evalRes = evaluateWithNormalizationVersion(
    'امروز در پادکست Backend صحبت می‌کنیم',
    'امروز در پادکست بک اند صحبت میکنیم',
    'fa_strict_v1'
  );
  assert.ok(evalRes.cer > 0 && evalRes.wer > 0);

  const tax = classifyTranscriptErrorsIntoTaxonomy({
    experimentId: 'exp-1',
    runId: 'run-1',
    sampleId: 's-1',
    engineId: 'local',
    referenceRaw: 'امروز در پادکست Backend صحبت می‌کنیم',
    hypothesisRaw: 'امروز در پادکست بک اند صحبت میکنیم',
  });
  assert.ok(tax.length > 0);

  const bootstrap = runPairedBootstrapAndHolmBonferroni({
    comparisons: [
      {
        engineAId: 'rc1',
        engineBId: 'base',
        metricName: 'cer',
        pairedSampleScoresA: [0.02, 0.03, 0.025, 0.018],
        pairedSampleScoresB: [0.12, 0.14, 0.11, 0.13],
      },
    ],
    iterations: 1000,
  });
  assert.equal(bootstrap[0].sample_coverage_adequate, false);

  const qcPass = evaluateSampleQuality11Gates(INITIAL_VERIFIED_STUDIO_CORPUS[0], new Set());
  assert.equal(qcPass.qualityStatus, 'APPROVED_GOLD');

  const splits = assignZeroLeakageDatasetSplits(INITIAL_VERIFIED_STUDIO_CORPUS);
  assert.equal(splits.speakerLeakageCount, 0);

  const dedup = new IdempotentExperimentTaskDeduplicator();
  const dedupKey = IdempotentExperimentTaskDeduplicator.buildIdempotencyKey({
    experimentId: 'exp-1',
    sampleId: 's-1',
    engineId: 'local',
    configurationHash: 'v1',
    repetitionIndex: 0,
  });
  for (let i = 0; i < 1000; i++) {
    dedup.tryAcquireExecutionSlot(dedupKey);
  }
  assert.equal(dedup.getDuplicateAttemptsBlocked(), 999);
  assert.equal(sanitizeSecretsFromText('key=sk-1234567890abcdef').includes('1234567890'), false);

  const audioVal = validateAndPreprocessAudioForLab({
    fileName: 'bad.wav',
    channelsPcm: [],
    sampleRate: 16000,
  });
  assert.equal(audioVal.isValid, false);
});

test('Phase 4: 3-tier transcript policy, train-only augmentation leak guard, checkpoint rollback & 3-layer separation', () => {
  const tiers = buildThreeTierTrainingTranscript('سلام ۱۲۳ مي خواهم');
  assert.ok(tiers.text_training.includes('123'));

  assert.throws(() =>
    applyDeterministicTrainOnlyAugmentation({
      samples: new Float32Array(1600),
      split: 'validation',
      profileId: 'A03',
      seed: 42,
    })
  );

  const trainAug = applyDeterministicTrainOnlyAugmentation({
    samples: new Float32Array(1600).fill(0.1),
    split: 'train',
    profileId: 'A02',
    seed: 42,
  });
  assert.equal(trainAug.outputSamples.length, 1600);

  const ckptMgr = new IndependentAsrCheckpointManager();
  const baseCkpt = ckptMgr.listCheckpoints()[0];
  const saved = ckptMgr.resumeTrainingFromCheckpoint({
    fromCheckpointId: ckptMgr.getActiveCheckpoint().checkpointId,
    additionalSteps: 50,
  });
  assert.equal(ckptMgr.getActiveCheckpoint().checkpointId, saved.checkpointId);
  ckptMgr.rollbackToCheckpoint(baseCkpt.checkpointId);
  assert.equal(ckptMgr.getActiveCheckpoint().checkpointId, baseCkpt.checkpointId);

  const layers = runThreeLayerPostProcessing({
    rawModelOutput: 'امروز بک اند با تایپ اسکریپت عالیه',
    enableNormalization: true,
    enableDomainAdaptation: true,
    domainProfile: 'technology',
  });
  assert.equal(layers.raw_model_output, 'امروز بک اند با تایپ اسکریپت عالیه');
  assert.ok(layers.domain_adapted_text.includes('TypeScript'));
});

test('Phase 5: Stateful streaming resampler, channel guard, ASR1 binary frame, sequence/VAD hysteresis & stability', () => {
  const resampler = new StatefulStreamingResampler16k(48000);
  const block1 = new Float32Array(4800).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / 48000));
  const out1 = resampler.processChunk(block1);
  assert.ok(out1.length >= 1590 && out1.length <= 1610);

  // Anti-phase cancellation detection on stereo
  const left = new Float32Array(1600).fill(0.5);
  const right = new Float32Array(1600).fill(-0.5);
  const downmix = convertChannelsToMonoSafely([left, right]);
  assert.equal(downmix.phaseCancellationRiskDetected, true);

  const { pcm16Bytes } = encodeFloat32ToPcm16LittleEndian(new Float32Array([2.5, -2.5, 0]));
  const view = new DataView(pcm16Bytes.buffer);
  assert.equal(view.getInt16(0, true), 32767);
  assert.equal(view.getInt16(2, true), -32768);

  const frame = encodeAsrStreamProtocolV1BinaryFrame({
    version: 1,
    flags: 0,
    sequenceNumber: 0,
    firstSampleIndex: 0,
    pcm16Payload: new Uint8Array(3200),
  });
  assert.equal(frame.byteLength, 3224);
  const decoded = decodeAndValidateAsrStreamProtocolV1BinaryFrame(frame);
  assert.equal(decoded.valid, true);

  const badDecoded = decodeAndValidateAsrStreamProtocolV1BinaryFrame(new Uint8Array(25));
  assert.equal(badDecoded.valid, false);

  const seqVal = new SessionAudioSequenceValidator();
  assert.equal(seqVal.ingestValidatedFrame(decoded.frame!).status, 'COMMITTED_IN_ORDER');
  assert.equal(seqVal.ingestValidatedFrame(decoded.frame!).status, 'DUPLICATE_IGNORED');

  const vad = new StatefulStreamingVadEngine();
  const silence512 = new Float32Array(512);
  const vadRes = vad.processPcmFloatSamples(silence512);
  assert.equal(vadRes.lastProbability >= 0 && vadRes.lastProbability <= 1, true);

  const stab = evaluateStreamingRevisionStability({
    partialSnapshots: ['سلام امروز', 'سلام امروز پادکست', 'سلام امروز پادکست جذاب'],
    finalTranscript: 'سلام امروز پادکست جذاب',
    referenceTranscript: 'سلام امروز پادکست جذاب',
    stabilityWindowRevisions: 3,
  });
  assert.ok(stab.stablePrefixRatio >= 0.4);

  const qwenCost = calculateQwenCumulativeAudioOverhead({
    utteranceDurationSec: 30,
    chunkDurationSec: 2,
  });
  assert.equal(qwenCost.totalCumulativeAudioSec, 240);
});

test('Phase 6: Adaptive router 18-gate local_only, weights=1.0, cascade, circuit breaker, atomic budget & regret', () => {
  assert.equal(validateScoringWeightsSumToOne(PHASE6_SCORING_WEIGHT_PROFILES.balanced), true);

  const dec = makeAdaptiveRoutingDecision({
    request: {
      request_id: 'r-local-test',
      tenant_id: 't1',
      input: {
        audio_sha256: 'abc',
        duration_ms: 5000,
        sample_rate: 16000,
        channels: 1,
        format: 'pcm16',
        estimated_snr_db: 22,
        code_switch_probability: 0.4,
      },
      task: {
        mode: 'native_streaming',
        language: 'auto',
        domain: 'technology',
        diarization: true,
        timestamps: true,
      },
      routing: {
        strategy: 'balanced',
        privacy: 'local_only',
        allow_external: false,
        allow_cascade: true,
        max_engines: 2,
      },
      constraints: {
        max_latency_ms: 3000,
        max_cost: 0.1,
        currency: 'USD',
        min_quality_level: 'MEDIUM',
      },
    },
  });
  const extCand = dec.candidates.find((c) => c.engine_id === 'elevenlabs_scribe_v3_cloud');
  assert.equal(extCand?.eligible, false);
  assert.ok(extCand?.rejection_reasons.includes('PRIVACY_LOCAL_ONLY_VIOLATION'));

  const primaryCand = dec.candidates.find((c) => c.engine_id === dec.selected_primary) ?? dec.candidates[0];
  const secondaryCand =
    dec.candidates.find((c) => c.eligible && c.engine_id !== primaryCand.engine_id) ?? primaryCand;
  const casc = evaluateCascadeTrigger({
    allowCascade: true,
    secondaryCandidate: secondaryCand,
    primarySucceeded: false,
    primaryTranscriptRaw: '',
    primaryCandidate: primaryCand,
    audioProfile: dec.audio_profile,
    remainingRequestBudgetUsd: 0.1,
  });
  assert.equal(casc.shouldTriggerCascade, true);

  const cb = new ProviderCircuitBreakerManager(2, 30000);
  cb.recordFailure('elevenlabs_scribe_v3_cloud', 'TIMEOUT');
  const openRes = cb.recordFailure('elevenlabs_scribe_v3_cloud', 'TIMEOUT');
  assert.equal(openRes.state, 'OPEN');

  const budget = new AtomicBudgetGovernanceController(1.0);
  const res1 = budget.reserveBudgetAtomically('req-b1', 0.7);
  const res2 = budget.reserveBudgetAtomically('req-b2', 0.5);
  assert.equal(res1.approved, true);
  assert.equal(res2.approved, false);

  const regret = runOfflineCounterfactualRegretEvaluation();
  assert.equal(regret.budgetViolationRate, 0);
});

test('Phases 7-9: From-scratch NO-GO, FastConformer/CTC/Hybrid loss, Security Audit, Consent Block, PSI & Canary', () => {
  const goNoGo = evaluateFromScratchGoNoGoDecision({
    verifiedLabeledHoursTotal: 0.0143,
    verifiedPersianHours: 0.0143,
    verifiedEnglishHours: 0,
    verifiedNaturalMixedHours: 0.006,
    verifiedConversationalHours: 0.0143,
    verifiedReadSpeechHours: 0,
    unlabeledApprovedHours: 0,
    distinctSpeakerCount: 4,
    distinctMixedLanguageSpeakerCount: 2,
    allLicensesVerifiedForTraining: true,
    speakerDisjointHoldoutAvailable: true,
    availableGpuCount: 0,
    availableGpuVramGbPerDevice: 0,
    approvedTrainingBudgetUsd: 0,
  });
  assert.equal(goNoGo.assignedDataTier, 'BELOW_D0');
  assert.equal(goNoGo.trackBProductionFromScratchDecision, 'NO_GO_INSUFFICIENT_DATA_OR_COMPUTE');

  const arch = calculateArchitectureParameterBreakdown({
    prototypeId: 'FC-CTC-S1',
    vocabularySize: 2048,
  });
  assert.ok(arch.totalParameters > 5_000_000);

  const ctc = decodeCtcFrameSequence({
    frameTokenIds: [0, 5, 5, 0, 8, 8, 0],
    blankTokenId: 0,
    idToTokenMap: { 5: 'س', 8: 'لام' },
  });
  assert.deepEqual(ctc.collapsedTokenIds, [5, 8]);
  assert.equal(ctc.decodedText, 'سلام');

  const hybrid = computeHybridCtcRnntLoss({
    experimentProfile: 'H01',
    unweightedCtcLoss: 1.2,
    unweightedRnntLoss: 2.0,
  });
  assert.ok(hybrid.lossIsFinite && hybrid.combinedTotalLoss === 1.6);

  const merged = mergeOverlappingLongFormSegments([
    { segmentIndex: 0, startSample: 0, endSample: 80000, transcript: 'سلام امروز در پادکست جذاب' },
    { segmentIndex: 1, startSample: 64000, endSample: 144000, transcript: 'پادکست جذاب درباره هوش مصنوعی' },
  ]);
  assert.equal(merged.duplicateBoundaryTokensRemoved, 2);

  const pareto = computeMultiObjectiveParetoFrontier([
    {
      modelId: 'A',
      persianCerPercent: 2.0,
      mixedCerPercent: 3.0,
      englishCerPercent: 1.8,
      p95LatencyMs: 120,
      peakVramGb: 0.5,
      costPerAudioHourUsd: 0,
    },
    {
      modelId: 'B',
      persianCerPercent: 4.5,
      mixedCerPercent: 6.0,
      englishCerPercent: 3.2,
      p95LatencyMs: 250,
      peakVramGb: 6.0,
      costPerAudioHourUsd: 0.3,
    },
  ]);
  assert.equal(pareto.find((p) => p.modelId === 'A')?.isParetoOptimal, true);

  // Phase 8 Security
  const secAudit = runAdversarialSecurityAndReadinessAudit();
  assert.equal(secAudit.allPassed, true);
  assert.equal(
    validateUploadedAudioSecurity({
      fileName: '../secret.wav',
      declaredMimeType: 'audio/wav',
      bytes: new Uint8Array(16),
    }).allowed,
    false
  );
  assert.equal(
    assertTenantIsolation({ actorTenantId: 't1', resourceTenantId: 't2' }).allowed,
    false
  );

  // Phase 9 Consent Gate blocks training when training_consent = false
  const blockedConsent = evaluateSampleConsentEligibility({
    consentRecordId: 'c1',
    tenantId: 't1',
    userId: 'u1',
    version: 1,
    recordedAtIso: new Date().toISOString(),
    permissions: {
      ALLOW_TRANSCRIPTION: true,
      ALLOW_TRANSCRIPT_STORAGE: true,
      ALLOW_AUDIO_RETENTION: true,
      ALLOW_QUALITY_ANALYSIS: true,
      ALLOW_HUMAN_REVIEW: true,
      ALLOW_MODEL_TRAINING: false,
      ALLOW_RESEARCH_PUBLICATION: false,
      ALLOW_EXTERNAL_PROVIDER_PROCESSING: false,
    },
  });
  assert.equal(blockedConsent, 'TRAINING_INELIGIBLE_NO_TRAINING_CONSENT');

  const release = buildImmutableDatasetReleaseWithReplay({
    datasetVersion: 'dataset_v1_0_1',
    historicalGoldSamples: [
      {
        sampleId: 'gold-1',
        audioSha256: 'h1',
        speakerId: 'spk-1',
        cohortName: 'fa',
        finalReferenceText: 'سلام',
        eligibilityState: 'TRAINING_APPROVED',
        sourceKind: 'HISTORICAL_GOLD',
      },
    ],
    newAdjudicatedSamples: [
      {
        sampleId: 'new-unconsented',
        audioSha256: 'h2',
        speakerId: 'spk-2',
        cohortName: 'fa',
        finalReferenceText: 'تست',
        eligibilityState: blockedConsent,
        sourceKind: 'NEW_PRODUCTION_ADJUDICATED',
      },
    ],
    protectedHoldoutSpeakerIds: new Set(['spk-holdout']),
  });
  assert.equal(release.rejectedCount, 1);

  const adj = evaluateDoubleAnnotationAndAdjudicate({
    utteranceId: 'u-1',
    annotatorAText: 'سلام بر شما دوست عزیز',
    annotatorBText: 'متن کاملاً متفاوت دیگر',
    eligibilityState: 'TRAINING_APPROVED',
  });
  assert.equal(adj.requiresAdjudication, true);
  assert.equal(adj.eligibleForTrainingDataset, false);

  const scored = scoreActiveLearningSample({
    utteranceId: 'u-al-1',
    audioSha256: 'h-al',
    speakerId: 'spk-al',
    cohortName: 'mixed',
    asrHypothesisText: 'سلام',
    meanTokenConfidence: 0.5,
    cascadeDisagreementWer: 0.4,
    normalizedNoiseDifficulty: 0.5,
    domainRarityScore: 0.5,
    codeSwitchComplexityScore: 0.5,
    hasUserFeedback: false,
    consent: {
      consentRecordId: 'c2',
      tenantId: 't1',
      userId: 'u1',
      version: 1,
      recordedAtIso: new Date().toISOString(),
      permissions: {
        ALLOW_TRANSCRIPTION: true,
        ALLOW_TRANSCRIPT_STORAGE: true,
        ALLOW_AUDIO_RETENTION: true,
        ALLOW_QUALITY_ANALYSIS: true,
        ALLOW_HUMAN_REVIEW: true,
        ALLOW_MODEL_TRAINING: true,
        ALLOW_RESEARCH_PUBLICATION: false,
        ALLOW_EXTERNAL_PROVIDER_PROCESSING: false,
      },
    },
  });
  const alBatch = selectActiveLearningBatchWithControlStream({
    candidates: [scored],
    batchSize: 1,
    maxSamplesPerSpeaker: 2,
  });
  assert.ok(alBatch.randomControlRatio >= 0.2);

  const rejectedGate = evaluateChampionVsChallengerGate([
    {
      cohortName: 'en_mixed',
      sampleCount: 100,
      championCerPercent: 3.0,
      challengerCerPercent: 4.5, // +1.5pp regression > 0.5pp
      championP95LatencyMs: 200,
      challengerP95LatencyMs: 205,
    },
  ]);
  assert.equal(rejectedGate.approvedForCanaryPromotion, false);

  const psiSmall = computeCohortPsiDrift({
    cohortName: 'small',
    currentSampleCount: 10,
    baselineHistogram: [0.5, 0.5],
    currentHistogram: [0.1, 0.9],
  });
  assert.equal(psiSmall.status, 'INSUFFICIENT_EVIDENCE');

  const rolledBack = advanceOrRollbackCanaryRollout({
    state: {
      championModelId: 'champ',
      challengerModelId: 'chall',
      stagePercent: 25,
      mode: 'CANARY',
    },
    errorRateDeltaPp: 1.5,
    p95LatencyDeltaPct: 5,
    crashRatePct: 0,
  });
  assert.equal(rolledBack.mode, 'ROLLED_BACK');
  assert.equal(rolledBack.stagePercent, 0);
});

test('Phase 10A: Identity invitations, API key one-time secret, 24h overlap rotation, revocation, cross-project isolation & Data Residency', () => {
  const cp = new PlatformControlPlaneService();
  const gw = new PlatformDataPlaneGateway(cp);

  // 1. Invitation 72h & single-use guarantee
  const inv = cp.createInvitation({
    organizationId: 'org_avapardaz_sandbox',
    actorUserId: 'usr_studio_owner_01',
    email: 'newdev@avapardaz.local',
    role: 'DEVELOPER',
    projectIds: ['prj_avapardaz_dev_01'],
    expiresInHours: 72,
  });
  const mem = cp.acceptInvitation({
    invitationId: inv.invitation.invitationId,
    plaintextToken: inv.plaintextTokenOnce,
    userId: 'usr_dev_02',
    email: 'newdev@avapardaz.local',
  });
  assert.equal(mem.role, 'DEVELOPER');
  assert.throws(() =>
    cp.acceptInvitation({
      invitationId: inv.invitation.invitationId,
      plaintextToken: inv.plaintextTokenOnce,
      userId: 'usr_dev_02',
      email: 'newdev@avapardaz.local',
    })
  );

  // 2. API Key Secret displayed strictly once, never stored in list, scoped & revocable
  const issued = cp.issueApiKey({
    organizationId: 'org_avapardaz_sandbox',
    projectId: 'prj_avapardaz_dev_01',
    name: 'Key Alpha',
    scopes: ['audio:transcribe', 'transcripts:read', 'models:read'],
  });
  assert.ok(issued.plaintextSecretOnce.startsWith('asr_test_'));
  const listed = cp.listApiKeys('org_avapardaz_sandbox');
  assert.equal((listed[0] as unknown as { secretHash?: string }).secretHash, undefined);

  // 3. Insufficient scope rejected cleanly (403 INSUFFICIENT_SCOPE)
  const streamDenied = gw.createStreamingProductSession({
    bearerToken: issued.plaintextSecretOnce,
    body: { sample_rate: 16000, channels: 1 },
  });
  assert.equal(streamDenied.status, 403);

  // 4. GPU-gated model honestly returns 503 PROVIDER_UNAVAILABLE in G0_CPU_ONLY
  const gpuBlocked = gw.createTranscription({
    bearerToken: issued.plaintextSecretOnce,
    body: { model: 'qwen3-asr-1.7b-fa', audio_duration_ms: 5000 },
  });
  assert.equal(gpuBlocked.status, 503);

  // 5. Data Residency hard block on prohibited region (`eu-central-01`)
  const regDenied = gw.createTranscription({
    bearerToken: issued.plaintextSecretOnce,
    body: { model: 'asr-fa-en-v1', region_id: 'eu-central-01', audio_duration_ms: 5000 },
  });
  assert.equal(regDenied.status, 422);

  // 6. Cross-project / Cross-tenant isolation enforcement (Project B cannot read Project A job)
  const prjB = cp.createProject({
    organizationId: 'org_avapardaz_sandbox',
    projectName: 'Isolated Project B',
    environment: 'PRODUCTION',
  });
  const keyB = cp.issueApiKey({
    organizationId: 'org_avapardaz_sandbox',
    projectId: prjB.id,
    name: 'Key Project B',
    scopes: ['transcripts:read'],
  });
  assert.ok(keyB.plaintextSecretOnce.startsWith('asr_live_'));

  const okJob = gw.createTranscription({
    bearerToken: issued.plaintextSecretOnce,
    idempotencyKey: 'idemp-cross-1',
    body: { model: 'asr-fa-en-v1', audio_duration_ms: 12000 },
  });
  assert.equal(okJob.status, 200);
  const jobId = (okJob.body as { id: string }).id;

  const crossRead = gw.getTranscriptionJob({
    bearerToken: keyB.plaintextSecretOnce,
    transcriptionId: jobId,
  });
  assert.equal(crossRead.status, 403);

  // 7. Key Rotation (24h overlap keeps old key alive) + Immediate Revocation blocks immediately
  const rotated = cp.rotateApiKey({
    credentialId: issued.credential.id,
    organizationId: 'org_avapardaz_sandbox',
    overlapHours: 24,
  });
  assert.equal(gw.listPublicModels(issued.plaintextSecretOnce).status, 200);
  assert.equal(gw.listPublicModels(rotated.plaintextSecretOnce).status, 200);
  cp.revokeApiKey({
    credentialId: issued.credential.id,
    organizationId: 'org_avapardaz_sandbox',
  });
  assert.equal(gw.listPublicModels(issued.plaintextSecretOnce).status, 401);
});

test('Phase 10B: Idempotency-Key deduplication, integer billing ledger reconciliation, immutable invoices, webhook DLQ & TypeScript SDK', async () => {
  const cp = new PlatformControlPlaneService();
  const gw = new PlatformDataPlaneGateway(cp);
  const key = cp.issueApiKey({
    organizationId: 'org_avapardaz_sandbox',
    projectId: 'prj_avapardaz_dev_01',
    name: 'Billing SDK Key',
    scopes: ['audio:transcribe', 'transcripts:read', 'models:read', 'audio:stream'],
  });

  // 1. Integer arithmetic pricing check (never floats)
  const calc = computeIntegerOverageChargeMinor({
    billedAudioSeconds: 3700, // ceil(3700/60) = 62 mins, overage over 60 = 2 mins * 10 = 20 cents
    includedAudioMinutes: 60,
    overageRateMinorPerMinute: 10,
  });
  assert.equal(calc.overageMinutes, 2);
  assert.equal(calc.overageChargeMinor, 20);

  // 2. Same Idempotency-Key returns same job without double billing; different payload throws 409
  const r1 = gw.createTranscription({
    bearerToken: key.plaintextSecretOnce,
    idempotencyKey: 'idem-same-key',
    body: { model: 'asr-fa-en-v1', audio_duration_ms: 15000 },
  });
  const r2 = gw.createTranscription({
    bearerToken: key.plaintextSecretOnce,
    idempotencyKey: 'idem-same-key',
    body: { model: 'asr-fa-en-v1', audio_duration_ms: 15000 },
  });
  assert.equal((r1.body as { id: string }).id, (r2.body as { id: string }).id);
  assert.equal(cp.getPortalOverview('org_avapardaz_sandbox').usageEvents.length, 1);

  const conflict = gw.createTranscription({
    bearerToken: key.plaintextSecretOnce,
    idempotencyKey: 'idem-same-key',
    body: { model: 'asr-fa-en-v1', audio_duration_ms: 30000 },
  });
  assert.equal(conflict.status, 409);

  // 3. Usage Ledger Reconciliation & Immutable Invoice Snapshot
  const rec = cp.reconcileUsageAndBillingLedger('org_avapardaz_sandbox');
  assert.equal(rec.balanced, true);
  assert.equal(rec.discrepancyMinor, 0);

  const inv = cp.issueMonthlyStatementInvoice('org_avapardaz_sandbox', 1000);
  assert.equal(inv.status, 'ISSUED');
  assert.equal(inv.snapshotSha256.length, 64);

  // 4. Payment Webhook HMAC Verification + Replay Protection
  const whSec = 'psp_test_secret_01';
  const ts = Math.floor(Date.now() / 1000);
  const pspPayload = JSON.stringify({ amount: 500 });
  const cryptoMod = await import('node:crypto');
  const pspSig = cryptoMod.default
    .createHmac('sha256', whSec)
    .update(`${ts}.${pspPayload}`, 'utf8')
    .digest('hex');

  const pspOk = cp.verifyAndProcessPaymentWebhook({
    providerEventId: 'evt_psp_1',
    organizationId: 'org_avapardaz_sandbox',
    amountMinor: 500,
    timestampEpochSec: ts,
    payloadJson: pspPayload,
    signatureHex: pspSig,
    webhookSecret: whSec,
    nowEpochSec: ts,
  });
  assert.equal(pspOk.accepted, true);
  assert.equal(pspOk.duplicateReplay, false);

  const pspReplay = cp.verifyAndProcessPaymentWebhook({
    providerEventId: 'evt_psp_1',
    organizationId: 'org_avapardaz_sandbox',
    amountMinor: 500,
    timestampEpochSec: ts,
    payloadJson: pspPayload,
    signatureHex: pspSig,
    webhookSecret: whSec,
    nowEpochSec: ts,
  });
  assert.equal(pspReplay.duplicateReplay, true);

  // 5. Outbound Webhook Signing + DLQ + Replay
  const dlqItems = cp.dispatchWebhookEvent({
    organizationId: 'org_avapardaz_sandbox',
    eventType: 'transcription.completed',
    data: { transcription_id: 'tr_dlq_1' },
    simulateFailureForTesting: true,
  });
  assert.equal(dlqItems[0].status, 'DEAD_LETTER');
  const replayed = cp.replayDeadLetterWebhook(dlqItems[0].deliveryId, 'org_avapardaz_sandbox');
  assert.equal(replayed.status, 'DELIVERED');

  // 6. TypeScript SDK (`ASRClient`) wired via custom fetch against PlatformDataPlaneGateway
  const sdk = new ASRClient({
    apiKey: key.plaintextSecretOnce,
    baseUrl: 'https://api.local',
    fetchImpl: async (input, init) => {
      const url = String(input);
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      const idemp = (init?.headers as Record<string, string>)?.['Idempotency-Key'];
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      const out = url.endsWith('/v1/audio/transcriptions')
        ? gw.createTranscription({ bearerToken: auth, idempotencyKey: idemp, body: parsedBody })
        : { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const sdkResult = await sdk.audio.transcriptions.create({
    model: 'asr-fa-en-v1',
    language: 'fa-en',
    idempotencyKey: 'sdk-test-01',
    audio_duration_ms: 8000,
  });
  assert.equal(sdkResult.status, 'completed');
  assert.equal(typeof sdkResult.text, 'string');
});


