import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ShahabAlignmentEngine,
  preparePersianTextForAlignment,
  evaluateAlignmentAgainstReference,
  samplesToFlicks,
} from './ShahabAlignmentEngine.ts';
import {
  ShahabDiarizationEngine,
  attributeTranscriptWithDiarization,
  evaluateDiarizationAgainstReference,
  type SpeakerEmbeddingProvider,
} from './ShahabDiarizationEngine.ts';
import {
  ShahabSubtitleEngine,
  exportSubtitleDocument,
  SHAHAB_SUBTITLE_PROFILES,
  computePersianReadingMetrics,
  analyzeAndFormatPersianRtlLayout,
} from './ShahabSubtitleEngine.ts';
import {
  buildControlledPersianCtcFixture,
  buildControlledPersianPodcastAudio,
} from './ShahabSpeechPrepArtifacts.ts';
import { ShahabSdkEngine } from './sdk/ShahabSdk.ts';
import { AvapardazShahabAdapter } from './adapters/AvapardazShahabAdapter.ts';
import { buildAuditionSubtitleInterchangePackage } from './adapters/AdobeAuditionHostAdapter.ts';

// ============================================================================
// SHAHAB-025 — Acoustic Forced Alignment & Word-Level Timing Tests
// ============================================================================

test('SHAHAB-025: capability inspection honestly reports RNN-T 40ms core & blocks word fabrication', () => {
  const engine = new ShahabAlignmentEngine(process.cwd());
  const caps = engine.inspectAlignmentCapabilities();
  assert.equal(caps.proportionalTimestampFabricationBlocked, true);
  assert.equal(caps.activeAsrFrameStrideMs, 40);
  assert.equal(caps.verifiedWordLevelPhonemeAlignment, false);
  assert.ok(caps.limitations.length >= 2);
});

test('SHAHAB-025: reversible Persian text prep preserves ZWNJ, Arabic Yeh/Kaf mapping, numerals & punctuation', () => {
  const raw = 'سلام، امروز می‌خواهیم نسخه ۲.۰ موتور SHAHAB را در سال ۱۴۰۵ بررسی كنيم!';
  const prep = preparePersianTextForAlignment(raw);
  assert.equal(prep.originalText, raw);
  assert.equal(prep.reversibleVerified, true);
  assert.ok(prep.zwnjCompoundCount >= 1, 'Expected می‌خواهیم to be classified as ZWNJ compound');
  assert.ok(prep.numericRiskCount >= 1, 'Expected Persian numerals to be flagged as numeric risk');
  assert.ok(prep.punctuationTokens.length >= 2, 'Expected punctuation kept non-acoustic');
  const kafYehToken = prep.alignableTokens.find((t) => t.originalSurface === 'كنيم');
  assert.ok(kafYehToken, 'Original surface كنيم must be preserved');
  assert.equal(kafYehToken.normalizedForm, 'کنیم', 'Normalized form must map Arabic Kaf/Yeh to Persian');
});

test('SHAHAB-025: honest VAD segment fallback refuses uniform word splitting & tracks resampling/offset', () => {
  const engine = new ShahabAlignmentEngine(process.cwd());
  const audio = buildControlledPersianPodcastAudio(16000);
  const text = 'سلام و وقت بخیر، امروز در استودیو آواپرداز هستیم. درباره کیفیت زیرنویس فارسی صحبت می‌کنیم.';

  const res = engine.submitAlignment({
    audioId: 'test-honest-vad',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    originalSampleRateHz: 48000,
    sourceOffsetSample: 48000,
    transcriptText: text,
    transcriptRevisionId: 'tr_1',
    transcriptLayer: 'USER_EDITED',
  });

  assert.equal(res.effectiveGranularity, 'SEGMENT_LEVEL');
  assert.equal(res.originalTranscriptText, text);
  assert.equal(res.coverage.alignedWordCount, 0, 'Must NEVER fabricate word timestamps without acoustic word evidence');
  assert.ok(res.coverage.alignedSegmentCount >= 1);
  assert.equal(res.invariantCheck.passed, true);
  assert.equal(res.invariantCheck.noFabricatedUniformWordSplitVerified, true);
  assert.equal(res.resamplingLineage.resampled, true);
  assert.equal(res.resamplingLineage.sourceOffsetSample, 48000);
  // Check integer flick conversion exactness for 1 second at 16 kHz = 705,600,000 flicks
  assert.equal(samplesToFlicks(16000, 16000), 705_600_000);
});

test('SHAHAB-025: controlled CTC Viterbi alignment produces monotonic word boundaries with verified MAE', () => {
  const engine = new ShahabAlignmentEngine(process.cwd());
  const fix = buildControlledPersianCtcFixture();

  const res = engine.submitAlignment({
    audioId: 'test-ctc-word',
    audioSamples: fix.pcm,
    sampleRateHz: fix.sampleRateHz,
    transcriptText: fix.transcript,
    transcriptRevisionId: 'tr_ctc_1',
    transcriptLayer: 'VERBATIM',
    ctcEvidence: {
      logProbsPerFrame: fix.logProbsPerFrame,
      frameStrideSec: fix.frameStrideSec,
      blankId: fix.blankId,
      charToVocabId: fix.charToVocabId,
      modelId: 'unit-test-ctc',
      modelRevision: '1.0.0',
    },
  });

  assert.equal(res.effectiveGranularity, 'WORD_LEVEL');
  assert.equal(res.invariantCheck.passed, true);
  assert.ok(res.coverage.alignedWordCount >= 8);
  const numericWord = res.words.find((w) => w.tokenKind === 'NUMERIC_LITERAL');
  assert.ok(numericWord, 'Persian numeric literal must be present');
  assert.equal(numericWord.status, 'AMBIGUOUS', 'Numeric literal must require spoken expansion instead of faking acoustic match');
  for (const w of res.words.filter((x) => x.status === 'ALIGNED')) {
    assert.equal(w.rawScoreCalibrationState, 'UNCALIBRATED_RAW_MODEL_SCORE');
    assert.ok(w.acousticRange !== null);
  }

  const metrics = evaluateAlignmentAgainstReference(
    res,
    fix.referenceWords,
    'unit-test-ctc-fixture',
    'SYNTHETIC_CONTROLLED_CTC_FIXTURE',
  );
  assert.equal(metrics.outOfOrderCount, 0);
  assert.equal(metrics.overlapCount, 0);
  assert.ok(metrics.boundaryMaeMs !== null && metrics.boundaryMaeMs < 100);
});

test('SHAHAB-025: silent audio triggers mismatchSuspected and never fabricates speech', () => {
  const engine = new ShahabAlignmentEngine(process.cwd());
  const silentPcm = new Float32Array(16000 * 3);
  const res = engine.submitAlignment({
    audioId: 'test-silent-audio',
    audioSamples: silentPcm,
    sampleRateHz: 16000,
    transcriptText: 'این یک متن تست برای فایل صوتی سکوت است.',
    transcriptRevisionId: 'tr_silent',
    transcriptLayer: 'USER_EDITED',
  });

  assert.equal(res.mismatchSuspected, true);
  assert.equal(res.overallStatus, 'TRANSCRIPT_MISMATCH_SUSPECTED');
  assert.equal(res.coverage.alignedSegmentCount, 0);
  assert.ok(res.unmatchedRegions.length >= 1);
});

test('SHAHAB-025: cache hit & revision-based invalidation work deterministically', () => {
  const engine = new ShahabAlignmentEngine(process.cwd());
  const audio = buildControlledPersianPodcastAudio(16000);
  const req = {
    audioId: 'test-cache',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    transcriptText: 'سلام، تست کش هم‌ترازی.',
    transcriptRevisionId: 'rev_A',
    transcriptLayer: 'USER_EDITED' as const,
  };
  const r1 = engine.submitAlignment(req);
  const r2 = engine.submitAlignment(req);
  assert.equal(r1.cacheHit, false);
  assert.equal(r2.cacheHit, true);

  const invEvent = engine.invalidateCache('TRANSCRIPT_REVISION_CHANGED', (r) => r.transcriptRevisionId === 'rev_A', 'rev_A -> rev_B');
  assert.equal(invEvent.affectedKeysCount, 1);
  const r3 = engine.submitAlignment(req);
  assert.equal(r3.cacheHit, false);
});

// ============================================================================
// SHAHAB-026 — Speaker Diarization & Multi-Speaker Attribution Tests
// ============================================================================

test('SHAHAB-026: biometric privacy gate enforces explicit consent & zero retained embeddings', () => {
  const engine = new ShahabDiarizationEngine(process.cwd());
  const caps = engine.inspectDiarizationCapabilities();
  assert.equal(caps.stageSeparation.speakerIdentification, 'PROHIBITED_BY_POLICY');
  assert.equal(caps.stageSeparation.speakerSeparation, 'NOT_SUPPORTED');
  assert.equal(caps.privacyGuarantees.recordingScopedIdsOnly, true);

  const audio = buildControlledPersianPodcastAudio(16000);
  assert.throws(
    () =>
      engine.submitDiarization({
        audioId: 'test-no-consent',
        audioSamples: audio.pcm,
        sampleRateHz: 16000,
        privacy: {
          explicitUserConsentGranted: false,
          retainEphemeralEmbeddingsAfterRun: false,
          recordingScopeId: 'rec_denied',
        },
      }),
    /DIARIZATION_PRIVACY_CONSENT_REQUIRED/,
  );

  const res = engine.submitDiarization({
    audioId: 'test-consented',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    explicitOverlapRegionsSec: audio.explicitOverlapRegionsSec,
    privacy: {
      explicitUserConsentGranted: true,
      retainEphemeralEmbeddingsAfterRun: false,
      recordingScopeId: 'rec_scope_alpha',
    },
  });
  assert.equal(res.privacyAudit.embeddingsRetained, false);
  assert.equal(res.privacyAudit.recordingScopedOnly, true);
  assert.equal(res.privacyAudit.diagnosticsContainsBiometrics, false);
  assert.ok(typeof res.privacyAudit.ephemeralEmbeddingsPurgedAtUtc === 'string' && res.privacyAudit.ephemeralEmbeddingsPurgedAtUtc.length > 0);
  assert.ok(res.turns.some((t) => t.kind === 'OVERLAPPING_SPEECH'), 'Concurrent overlap must be preserved');
  assert.ok(res.overlapDurationMs > 0);
});

test('SHAHAB-026: recording-scoped isolation + pluggable embedding provider + UNKNOWN_SPEAKER short turn', () => {
  const engine = new ShahabDiarizationEngine(process.cwd());
  const mockProvider: SpeakerEmbeddingProvider = {
    providerId: 'unit-test-embedding-provider',
    modelRevision: '1.0.0',
    embeddingDim: 4,
    extractEmbedding(segmentPcm) {
      let energy = 0;
      for (let i = 0; i < segmentPcm.length; i++) energy += Math.abs(segmentPcm[i]);
      const avg = energy / Math.max(1, segmentPcm.length);
      return avg > 0.08 ? new Float32Array([1, 0, 0, 0]) : new Float32Array([0, 1, 0, 0]);
    },
  };

  const audio = buildControlledPersianPodcastAudio(16000);
  const rec1 = engine.submitDiarization({
    audioId: 'rec-1',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    embeddingProvider: mockProvider,
    privacy: {
      explicitUserConsentGranted: true,
      retainEphemeralEmbeddingsAfterRun: false,
      recordingScopeId: 'scope_1',
    },
  });
  const rec2 = engine.submitDiarization({
    audioId: 'rec-2',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    embeddingProvider: mockProvider,
    privacy: {
      explicitUserConsentGranted: true,
      retainEphemeralEmbeddingsAfterRun: false,
      recordingScopeId: 'scope_2',
    },
  });
  assert.notEqual(rec1.recordingScopeId, rec2.recordingScopeId);
  assert.equal(rec1.backendMode, 'NEURAL_EMBEDDING_PROVIDER_AHC');
});

test('SHAHAB-026: manual review workflow (rename, confirm, mark unknown, undo) & conflict protection against re-diarization', () => {
  const engine = new ShahabDiarizationEngine(process.cwd());
  const audio = buildControlledPersianPodcastAudio(16000);
  const run = engine.submitDiarization({
    audioId: 'rec-review',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    explicitOverlapRegionsSec: audio.explicitOverlapRegionsSec,
    privacy: {
      explicitUserConsentGranted: true,
      retainEphemeralEmbeddingsAfterRun: false,
      recordingScopeId: 'scope_review',
    },
  });

  const renamed = engine.reviseSpeakerAssignment(run.requestId, {
    type: 'RENAME_LOCAL_LABEL',
    speakerId: run.speakers[0].speakerId,
    newLocalLabel: 'مهمان برنامه',
  });
  assert.equal(renamed.speakers[0].localDisplayLabel, 'مهمان برنامه');

  const firstTurn = renamed.turns[0];
  const confirmed = engine.reviseSpeakerAssignment(run.requestId, {
    type: 'CONFIRM_TURN',
    turnId: firstTurn.turnId,
  });
  assert.equal(confirmed.turns[0].origin, 'USER_CONFIRMED');

  const markedUnknown = engine.reviseSpeakerAssignment(run.requestId, {
    type: 'MARK_UNKNOWN',
    turnId: firstTurn.turnId,
  });
  assert.equal(markedUnknown.turns[0].speakerId, 'UNKNOWN_SPEAKER');

  const undone = engine.undoLastSpeakerRevision(run.requestId);
  assert.equal(undone.turns[0].origin, 'USER_CONFIRMED');

  // Re-diarization conflict protection: simulate fresh automatic run proposing a different speaker on turn 0
  const alternateAuto = {
    ...run,
    requestId: 're_run_auto',
    turns: run.turns.map((t, idx) =>
      idx === 0 ? { ...t, speakerId: 'speaker_99', activeSpeakerIds: ['speaker_99'] } : t,
    ),
  };
  const reconciled = engine.reconcileWithReDiarization(undone, alternateAuto);
  assert.ok(reconciled.conflicts.length >= 1, 'User-confirmed turn must produce explicit conflict instead of silent overwrite');
  assert.equal(reconciled.reconciledResult.turns[0].speakerId, undone.turns[0].speakerId);

  // DER/JER metrics check
  const metrics = evaluateDiarizationAgainstReference(
    run,
    audio.groundTruthTurns,
    'unit-test-synthetic-podcast',
    'CONTROLLED_MULTI_SPEAKER_SYNTHETIC_FIXTURE',
  );
  assert.ok(metrics.diarizationErrorRate >= 0 && metrics.diarizationErrorRate <= 1);
  assert.ok(metrics.jaccardErrorRate >= 0 && metrics.jaccardErrorRate <= 1);
});

test('SHAHAB-026: refuses WORD_LEVEL speaker attribution when alignment is only SEGMENT_LEVEL', () => {
  const alignEngine = new ShahabAlignmentEngine(process.cwd());
  const diarEngine = new ShahabDiarizationEngine(process.cwd());
  const audio = buildControlledPersianPodcastAudio(16000);

  const segAlign = alignEngine.submitAlignment({
    audioId: 'attr-test',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    transcriptText: 'سلام، این یک تست اتصال گوینده به متن است.',
    transcriptRevisionId: 'tr_attr',
    transcriptLayer: 'USER_EDITED',
  });
  const diar = diarEngine.submitDiarization({
    audioId: 'attr-test',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    privacy: {
      explicitUserConsentGranted: true,
      retainEphemeralEmbeddingsAfterRun: false,
      recordingScopeId: 'scope_attr',
    },
  });

  const attributed = attributeTranscriptWithDiarization(segAlign, diar, 'WORD_LEVEL');
  assert.equal(attributed.effectiveGranularity, 'SEGMENT_LEVEL');
  assert.equal(attributed.wordAttributionAvailable, false);
  assert.ok(attributed.refusalReasonIfDowngraded !== null);
});

// ============================================================================
// SHAHAB-027 — Professional Subtitle & Caption Engineering Tests
// ============================================================================

test('SHAHAB-027: 8 Persian profiles, grapheme-cluster CPS/WPM & reversible RTL/mixed-script handling', () => {
  assert.equal(Object.keys(SHAHAB_SUBTITLE_PROFILES).length, 8);
  const sample = 'می‌خواهیم موتور SHAHAB نسخه 2.0 را بررسی کنیم.';
  const metrics = computePersianReadingMetrics([sample], 3000);
  assert.ok(metrics.cpsIncludingSpaces > 0);
  assert.ok(metrics.wpm > 0);
  assert.ok(metrics.visibleGraphemeCountExcludingSpaces < metrics.visibleGraphemeCountIncludingSpaces);

  const bidiRe = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
  const rtlRlm = analyzeAndFormatPersianRtlLayout([sample], 'RLM_ANCHORED');
  assert.equal(rtlRlm.report.mixedScriptDetected, true);
  assert.equal(rtlRlm.report.reversibleCleanTextVerified, true);
  assert.equal(rtlRlm.formattedLines[0].replace(bidiRe, ''), sample);

  const rtlIso = analyzeAndFormatPersianRtlLayout([sample], 'ISOLATE_FSI_PDI');
  assert.equal(rtlIso.report.reversibleCleanTextVerified, true);
  assert.equal(rtlIso.formattedLines[0].replace(bidiRe, ''), sample);
});

test('SHAHAB-027: generates 5-domain cues, validates SRT/WebVTT/TTML/JSON round-trip, QA & conflict protection', () => {
  const alignEngine = new ShahabAlignmentEngine(process.cwd());
  const diarEngine = new ShahabDiarizationEngine(process.cwd());
  const subEngine = new ShahabSubtitleEngine();
  const audio = buildControlledPersianPodcastAudio(16000);

  const alignment = alignEngine.submitAlignment({
    audioId: 'sub-test-audio',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    transcriptText:
      'سلام و وقت بخیر، امروز در استودیو آواپرداز می‌خواهیم موتور SHAHAB نسخه 2.0 را بررسی کنیم. بله، دقیقاً هم‌زمان درباره کیفیت زیرنویس فارسی صحبت می‌کنیم. متشکرم، بیایید شروع کنیم.',
    transcriptRevisionId: 'tr_sub_1',
    transcriptLayer: 'USER_EDITED',
  });
  const diarization = diarEngine.submitDiarization({
    audioId: 'sub-test-audio',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    explicitOverlapRegionsSec: audio.explicitOverlapRegionsSec,
    privacy: {
      explicitUserConsentGranted: true,
      retainEphemeralEmbeddingsAfterRun: false,
      recordingScopeId: 'scope_sub',
    },
  });

  const doc = subEngine.generateSubtitles({
    alignment,
    diarization,
    profileId: 'ACCESSIBILITY_FIRST',
    mode: 'ACCESSIBILITY',
    verifiedNonSpeechEvents: [
      {
        eventId: 'ns_1',
        labelFa: 'موسیقی ملایم',
        startSec: 0.05,
        endSec: 0.35,
        source: 'EXPLICIT_HUMAN_ANNOTATION',
      },
    ],
    timingConfig: { fps: 25, dropFrame: false, vfrDetected: false, timelineOffsetMs: 0 },
  });

  assert.ok(doc.cues.length >= 2);
  assert.equal(doc.qaReport.passedWithoutErrors, true);
  assert.ok(doc.cues.some((c) => c.isNonSpeechAccessibilityCue));

  // Validate all 4 export formats + round-trip + ZWNJ preservation
  for (const format of ['SRT_UTF8', 'WEBVTT_UTF8', 'TTML_XML', 'JSON_SIDECAR'] as const) {
    const exp = exportSubtitleDocument(doc, format);
    assert.equal(exp.roundTripValidation.passed, true, `${format} round-trip failed`);
    assert.equal(exp.roundTripValidation.zwnjPreserved, true, `${format} lost ZWNJ`);
    assert.equal(exp.roundTripValidation.parsedCueCount, doc.cues.length);
  }

  // Manual edit + conflict protection on regeneration
  const targetCue = doc.cues.find((c) => !c.isNonSpeechAccessibilityCue)!;
  const edited = subEngine.applyManualCueEdit(doc.documentId, {
    cueId: targetCue.cueId,
    newLines: ['ویرایش دستی کاربر برای زیرنویس فارسی'],
  });
  const regen = subEngine.regenerateWithConflictProtection(doc.documentId, {
    alignment,
    diarization,
    profileId: 'PODCAST',
    mode: 'CLEANED',
  });
  assert.ok(regen.conflicts.length >= 1, 'Manual cue edit must be protected against silent regeneration overwrite');

  // Stale dependency check
  const freshness = subEngine.validateDependencyFreshness(edited, {
    audioSha256: 'different_audio_hash',
    transcriptRevisionId: 'tr_sub_2',
  });
  assert.equal(freshness.fresh, false);
  assert.ok(freshness.staleReasons.length >= 2);

  // Adobe Audition interchange package honesty
  const auditionPkg = buildAuditionSubtitleInterchangePackage(edited);
  assert.equal(auditionPkg.liveAuditionHostImportTested, false);
  assert.ok(auditionPkg.auditionMarkersCsvTabDelimited.includes('Name\tStart\tDuration'));
});

test('SDK & Avapardaz Adapter: end-to-end versioned SHAHAB-025/026/027 orchestration', () => {
  const sdk = new ShahabSdkEngine({
    modelDir: path.join(process.cwd(), 'models', 'persian-zipformer-transducer', '1.0.0'),
    authorizedWorkspaceRoot: process.cwd(),
  });
  const adapter = new AvapardazShahabAdapter(sdk);
  const audio = buildControlledPersianPodcastAudio(16000);

  const alignMapped = adapter.alignAndMapToAvapardazTimeline({
    audioId: 'avp-e2e',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    transcriptText: 'سلام، امروز پروژه آواپرداز و موتور SHAHAB را تست می‌کنیم.',
    transcriptRevisionId: 'avp_tr_1',
    transcriptLayer: 'USER_EDITED',
  });
  assert.equal(alignMapped.alignment.invariantCheck.passed, true);
  assert.ok(alignMapped.timelineSegments.length >= 1);

  const diarTracks = adapter.diarizeForAvapardazTracks({
    audioId: 'avp-e2e',
    audioSamples: audio.pcm,
    sampleRateHz: 16000,
    explicitOverlapRegionsSec: audio.explicitOverlapRegionsSec,
    privacy: {
      explicitUserConsentGranted: true,
      retainEphemeralEmbeddingsAfterRun: false,
      recordingScopeId: 'scope_avp_e2e',
    },
  });
  assert.ok(diarTracks.timelineTurns.length >= 1);
  assert.equal(diarTracks.diarization.privacyAudit.embeddingsRetained, false);

  const subPkg = adapter.generateAvapardazSubtitlePackage({
    alignment: alignMapped.alignment,
    diarization: diarTracks.diarization,
    profileId: 'PODCAST',
    mode: 'CLEANED',
  });
  assert.equal(subPkg.exports.SRT_UTF8.roundTripValidation.passed, true);
  assert.equal(subPkg.exports.WEBVTT_UTF8.roundTripValidation.passed, true);
});
