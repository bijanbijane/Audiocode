import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TimeMath, type SampleRate } from '../../contracts/timebase.contract';
import { PersianTextNormalizer, type TimedPersianToken } from '../PersianTextNormalizer';
import { createExtendedFillerLexicon, type PersianFillerLexiconEntry } from '../PersianDisfluencyEngine';
import {
  createSpeechAnalysisThresholdConfig,
  SPEECH_EVENT_ENGINE_VERSION,
} from '../speech-events/SpeechEventContracts';
import { SpeechEventEngine } from '../speech-events/SpeechEventEngine';
import { EditDecisionEngine } from './EditDecisionEngine';
import { analyzeShahabOutputWithEngine02 } from './ShahabToEngine02Adapter';
import { AudioRenderPlanner } from '../../audio-renderer/AudioRenderPlanner';
import type { AudioRenderConfig } from '../../audio-renderer/AudioRenderTypes';
import { decodeWavToMono16k } from '../../shahab/ShahabZipformerEngine';
import { createShahabSdkEngine, type ShahabSdkTranscriptResult } from '../../shahab/sdk/ShahabSdk';

const SAMPLE_RATE: SampleRate = 16000;

function sha256Float32(pcm: Float32Array): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    .digest('hex');
}

function makeSineSpeechPcm(
  durationSec: number,
  speechSpansSec: readonly { readonly startSec: number; readonly endSec: number; readonly amp?: number }[],
  sampleRate: number = SAMPLE_RATE,
): Float32Array {
  const totalSamples = Math.round(durationSec * sampleRate);
  const pcm = new Float32Array(totalSamples);
  // Subtle room tone floor (-60 dBFS) outside digital zero so silence is natural room tone
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 63 * i) / sampleRate) * 0.0008;
  }
  for (const span of speechSpansSec) {
    const startIdx = Math.max(0, Math.floor(span.startSec * sampleRate));
    const endIdx = Math.min(totalSamples, Math.floor(span.endSec * sampleRate));
    const amp = span.amp ?? 0.28;
    for (let i = startIdx; i < endIdx; i++) {
      const t = i / sampleRate;
      pcm[i] =
        amp * (0.65 * Math.sin(2 * Math.PI * 195 * t) + 0.35 * Math.sin(2 * Math.PI * 410 * t));
    }
  }
  return pcm;
}

function makeTimedTokens(
  items: readonly {
    readonly id: string;
    readonly text: string;
    readonly startSec: number;
    readonly endSec: number;
    readonly confidence?: number;
    readonly alignmentPrecision?: TimedPersianToken['alignmentPrecision'];
    readonly timingValid?: boolean;
  }[],
  trackId = 'track-main',
): TimedPersianToken[] {
  return items.map((it) =>
    PersianTextNormalizer.createToken({
      tokenId: it.id,
      trackId,
      originalText: it.text,
      startFlicks: Number.isFinite(it.startSec) ? TimeMath.secondsToFlicks(it.startSec) : Number.NaN,
      endFlicks: Number.isFinite(it.endSec) ? TimeMath.secondsToFlicks(it.endSec) : Number.NaN,
      confidence: it.confidence ?? 0.93,
      alignmentPrecision: it.alignmentPrecision ?? 'model_timestamps',
      timingValid: it.timingValid,
    }),
  );
}

test('01. Simple Persian stutter (تپق ساده فارسی) detected and requires human review', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'م', startSec: 0.2, endSec: 0.35 },
    { id: 't2', text: 'م', startSec: 0.4, endSec: 0.55 },
    { id: 't3', text: 'من', startSec: 0.6, endSec: 0.95 },
    { id: 't4', text: 'می‌خواهم', startSec: 1.0, endSec: 1.5 },
  ]);
  const pcm = makeSineSpeechPcm(2.0, [
    { startSec: 0.2, endSec: 0.35 },
    { startSec: 0.4, endSec: 0.55 },
    { startSec: 0.6, endSec: 1.5 },
  ]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const stutter = res.events.find(
    (e) => e.category === 'SYLLABLE_REPETITION' || e.category === 'STUTTER',
  );
  assert.ok(stutter, 'Expected syllable repetition / stutter detection');
  assert.equal(stutter.eligibleForEditSuggestion, false);
  assert.equal(stutter.requiresHumanReview, true);

  const edl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-01',
      sourceAudioId: 'aud-01',
      sourceAudioHash: sha256Float32(pcm),
      transcriptVersion: 'tr-01',
      sampleRate: SAMPLE_RATE,
      totalSourceSamples: pcm.length,
    },
    events: res.events,
    tokens,
  });
  const prop = edl.proposals.find((p) => p.speechEventSourceIds.includes(stutter.eventId));
  assert.ok(prop);
  assert.equal(prop.operation, 'REVIEW_FALSE_START');
  assert.equal(prop.risk.automaticApprovalEligible, false);
  assert.equal(prop.requiresHumanReview, true);
});

test('02. Single-word accidental repetition (تکرار یک واژه) targets first occurrence only', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'امروز', startSec: 0.2, endSec: 0.6 },
    { id: 't2', text: 'من', startSec: 0.65, endSec: 0.9 },
    { id: 't3', text: 'من', startSec: 1.0, endSec: 1.3 },
    { id: 't4', text: 'رفتم', startSec: 1.35, endSec: 1.8 },
  ]);
  const pcm = makeSineSpeechPcm(2.2, [
    { startSec: 0.2, endSec: 0.9 },
    { startSec: 1.0, endSec: 1.8 },
  ]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const rep = res.events.find((e) => e.subtype === 'ACCIDENTAL_WORD_REPETITION');
  assert.ok(rep, 'Expected ACCIDENTAL_WORD_REPETITION');
  assert.deepEqual(rep.relatedTokenIds, ['t2']);
  assert.ok(rep.startSec >= 0.64 && rep.endSec <= 1.01);
});

test('03. Phrase repetition (تکرار عبارت) detected and targets first phrase span', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'به', startSec: 0.2, endSec: 0.35 },
    { id: 't2', text: 'نظر', startSec: 0.38, endSec: 0.65 },
    { id: 't3', text: 'من', startSec: 0.68, endSec: 0.88 },
    { id: 't4', text: 'به', startSec: 1.0, endSec: 1.15 },
    { id: 't5', text: 'نظر', startSec: 1.18, endSec: 1.45 },
    { id: 't6', text: 'من', startSec: 1.48, endSec: 1.68 },
    { id: 't7', text: 'درست', startSec: 1.75, endSec: 2.1 },
    { id: 't8', text: 'است', startSec: 2.12, endSec: 2.4 },
  ]);
  const pcm = makeSineSpeechPcm(2.6, [
    { startSec: 0.2, endSec: 0.88 },
    { startSec: 1.0, endSec: 2.4 },
  ]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const rep = res.events.find((e) => e.subtype === 'ACCIDENTAL_WORD_REPETITION');
  assert.ok(rep, 'Expected phrase repetition event');
  assert.deepEqual(rep.relatedTokenIds, ['t1', 't2', 't3']);
  assert.equal(rep.relatedText, 'به نظر من');
});

test('04. False start and self-correction preserved as REVIEW_FALSE_START / REVIEW_SELF_CORRECTION', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'قرار', startSec: 0.2, endSec: 0.5 },
    { id: 't2', text: 'بود', startSec: 0.52, endSec: 0.8 },
    { id: 't3', text: 'نه', startSec: 0.85, endSec: 1.05 },
    { id: 't4', text: 'یعنی', startSec: 1.1, endSec: 1.35 },
    { id: 't5', text: 'فردا', startSec: 1.4, endSec: 1.8 },
    { id: 't6', text: 'می‌ریم', startSec: 1.85, endSec: 2.25 },
  ]);
  const pcm = makeSineSpeechPcm(2.5, [{ startSec: 0.2, endSec: 2.25 }]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const correction = res.events.find(
    (e) => e.category === 'SELF_CORRECTION' || e.category === 'FALSE_START',
  );
  assert.ok(correction, 'Expected self-correction or false start event');
  assert.equal(correction.eligibleForEditSuggestion, false);
  assert.equal(correction.requiresHumanReview, true);
});

test('05. Natural short pause preserved (DO_NOT_EDIT / NO_EDIT_RECOMMENDED)', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'سلام', startSec: 0.2, endSec: 0.7 },
    { id: 't2', text: 'دوستان', startSec: 1.02, endSec: 1.6 },
  ]);
  // 320ms silence gap between 0.7 and 1.02
  const pcm = makeSineSpeechPcm(2.0, [
    { startSec: 0.2, endSec: 0.7 },
    { startSec: 1.02, endSec: 1.8 },
  ]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const naturalPause = res.events.find(
    (e) => e.category === 'SILENCE' && e.subtype === 'NATURAL_SHORT_PAUSE',
  );
  assert.ok(naturalPause, 'Expected NATURAL_SHORT_PAUSE');
  assert.equal(naturalPause.eligibleForEditSuggestion, false);

  const edl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-05',
      sourceAudioId: 'aud-05',
      sourceAudioHash: sha256Float32(pcm),
      transcriptVersion: 'tr-05',
      sampleRate: SAMPLE_RATE,
      totalSourceSamples: pcm.length,
    },
    events: res.events,
    tokens,
  });
  const pauseProp = edl.proposals.find((p) => p.speechEventSourceIds.includes(naturalPause.eventId));
  assert.ok(pauseProp);
  assert.equal(pauseProp.operation, 'NO_EDIT_RECOMMENDED');
  assert.equal(pauseProp.protectedEvent, true);
});

test('06. Long unnecessary pause detected and respects configurable threshold presets', async () => {
  // 1100ms pause: triggers BALANCED (longSilenceMinMs=950), does NOT trigger CONSERVATIVE (longSilenceMinMs=1250) as LONG_UNNECESSARY_SILENCE
  const tokens = makeTimedTokens([
    { id: 't1', text: 'اول', startSec: 0.2, endSec: 0.8 },
    { id: 't2', text: 'دوم', startSec: 1.9, endSec: 2.5 },
  ]);
  const pcm = makeSineSpeechPcm(2.8, [
    { startSec: 0.2, endSec: 0.8 },
    { startSec: 1.9, endSec: 2.6 },
  ]);

  const balancedCfg = createSpeechAnalysisThresholdConfig({ preset: 'BALANCED' });
  const conservativeCfg = createSpeechAnalysisThresholdConfig({ preset: 'CONSERVATIVE' });

  const balancedRes = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    config: balancedCfg,
    vadProvider: null,
  });

  const conservativeRes = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    config: conservativeCfg,
    vadProvider: null,
  });

  const longBalanced = balancedRes.events.find(
    (e) => e.category === 'SILENCE' && e.subtype === 'LONG_UNNECESSARY_SILENCE',
  );
  const longConservative = conservativeRes.events.find(
    (e) => e.category === 'SILENCE' && e.subtype === 'LONG_UNNECESSARY_SILENCE',
  );
  assert.ok(longBalanced, 'Expected LONG_UNNECESSARY_SILENCE under BALANCED preset');
  assert.equal(longBalanced.eligibleForEditSuggestion, true);
  assert.equal(longConservative, undefined, 'CONSERVATIVE preset should require longer pause');
});

test('07. Non-meaningful vocal filler and custom filler lexicon entry detected', async () => {
  const customEntry: PersianFillerLexiconEntry = {
    lexiconId: 'fil-custom-besyar خب',
    canonicalForm: 'اصلاچیزه',
    surfaceVariants: ['اصلاچیزه'],
    category: 'COLLOQUIAL_FILLER',
    linguisticRole: 'تکیه‌کلام سفارشی گوینده',
    typicalAcousticBehavior: 'کوتاه و محصور در مکث',
    potentiallyRemovable: true,
    preserveContexts: [],
    baseLinguisticScore: 0.88,
  };
  assert.ok(createExtendedFillerLexicon([customEntry]).some((e) => e.lexiconId === customEntry.lexiconId));

  const tokens = makeTimedTokens([
    { id: 't1', text: 'سلام', startSec: 0.2, endSec: 0.6 },
    { id: 't2', text: 'امم', startSec: 0.9, endSec: 1.25 },
    { id: 't3', text: 'بخش', startSec: 1.5, endSec: 1.9 },
    { id: 't4', text: 'اصلاچیزه', startSec: 2.3, endSec: 2.6 },
    { id: 't5', text: 'ادامه', startSec: 3.0, endSec: 3.4 },
  ]);
  const pcm = makeSineSpeechPcm(3.6, [
    { startSec: 0.2, endSec: 0.6 },
    { startSec: 0.9, endSec: 1.25 },
    { startSec: 1.5, endSec: 1.9 },
    { startSec: 2.3, endSec: 2.6 },
    { startSec: 3.0, endSec: 3.4 },
  ]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    customFillerLexicon: [customEntry],
    vadProvider: null,
  });

  const vocalFiller = res.events.find(
    (e) => e.category === 'FILLER' && e.relatedText === 'امم',
  );
  const customFiller = res.events.find(
    (e) => e.category === 'FILLER' && e.relatedText === 'اصلاچیزه',
  );
  assert.ok(vocalFiller, 'Expected vocal filler امم');
  assert.equal(vocalFiller.subtype, 'VOCAL_FILLED_PAUSE');
  assert.ok(customFiller, 'Expected custom filler lexicon detection');
  assert.equal(customFiller.linguisticEvidence?.matchedLexiconId, customEntry.lexiconId);
});

test('08. Meaningful semantic discourse markers and adjectives (یعنی، خب، خوب، حالا، مثلاً) preserved', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'خب', startSec: 0.2, endSec: 0.4 },
    { id: 't2', text: 'این', startSec: 0.45, endSec: 0.65 },
    { id: 't3', text: 'کتاب', startSec: 0.68, endSec: 1.0 },
    { id: 't4', text: 'خیلی', startSec: 1.05, endSec: 1.35 },
    { id: 't5', text: 'خوب', startSec: 1.38, endSec: 1.65 },
    { id: 't6', text: 'است', startSec: 1.68, endSec: 1.9 },
    { id: 't7', text: 'یعنی', startSec: 1.95, endSec: 2.25 },
    { id: 't8', text: 'مفید', startSec: 2.28, endSec: 2.6 },
    { id: 't9', text: 'است', startSec: 2.62, endSec: 2.85 },
  ]);
  const pcm = makeSineSpeechPcm(3.0, [{ startSec: 0.2, endSec: 2.85 }]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const autoRemovableFillers = res.events.filter(
    (e) => e.category === 'FILLER' && e.eligibleForEditSuggestion,
  );
  assert.equal(
    autoRemovableFillers.length,
    0,
    'Meaningful خب, adjective خوب, and explanatory یعنی must never be marked eligible for deletion',
  );
  const preservedGood = res.events.find(
    (e) =>
      e.category === 'FILLER' &&
      (e.relatedText === 'خوب' || e.relatedText === 'یعنی') &&
      e.subtype !== 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED',
  );
  assert.equal(preservedGood, undefined);
});

test('09. Intentional emphasis and lexical reduplication preserved (خیلی خیلی، کم‌کم)', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'خیلی', startSec: 0.2, endSec: 0.5 },
    { id: 't2', text: 'خیلی', startSec: 0.55, endSec: 0.85 },
    { id: 't3', text: 'مهم', startSec: 0.9, endSec: 1.2 },
    { id: 't4', text: 'و', startSec: 1.22, endSec: 1.35 },
    { id: 't5', text: 'کم', startSec: 1.4, endSec: 1.65 },
    { id: 't6', text: 'کم', startSec: 1.7, endSec: 1.95 },
    { id: 't7', text: 'بهتر', startSec: 2.0, endSec: 2.35 },
  ]);
  const pcm = makeSineSpeechPcm(2.6, [{ startSec: 0.2, endSec: 2.35 }]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const emphasis = res.events.find((e) => e.subtype === 'INTENTIONAL_EMPHASIS_REPETITION');
  const legit = res.events.find((e) => e.subtype === 'LEGITIMATE_LEXICAL_REPETITION');
  assert.ok(emphasis, 'Expected INTENTIONAL_EMPHASIS_REPETITION for خیلی خیلی');
  assert.ok(legit, 'Expected LEGITIMATE_LEXICAL_REPETITION for کم کم');
  assert.equal(emphasis.eligibleForEditSuggestion, false);
  assert.equal(legit.eligibleForEditSuggestion, false);
});

test('10 & 11. Persian orthography variants (ي/ی, ك/ک, digits ۱۲/12, punctuation, ZWNJ) detected without altering raw text', async () => {
  const tokens = makeTimedTokens([
    { id: 't1', text: 'نرم‌افزار،', startSec: 0.2, endSec: 0.6 },
    { id: 't2', text: 'نرم افزار', startSec: 0.65, endSec: 1.05 },
    { id: 't3', text: 'كتاب', startSec: 1.15, endSec: 1.45 },
    { id: 't4', text: 'کتاب', startSec: 1.5, endSec: 1.8 },
    { id: 't5', text: '۱۲', startSec: 1.9, endSec: 2.2 },
    { id: 't6', text: '12', startSec: 2.25, endSec: 2.55 },
  ]);
  const rawBefore = tokens.map((t) => t.originalText);
  const pcm = makeSineSpeechPcm(2.8, [{ startSec: 0.2, endSec: 2.6 }]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  const reps = res.events.filter((e) => e.subtype === 'ACCIDENTAL_WORD_REPETITION');
  assert.equal(reps.length, 3, 'Expected ZWNJ, Arabic kaf/yeh, and numeral repetitions to match');
  assert.deepEqual(
    tokens.map((t) => t.originalText),
    rawBefore,
    'Raw token originalText must remain strictly immutable',
  );
  assert.equal(tokens[0].originalText, 'نرم‌افزار،');
  assert.equal(tokens[2].originalText, 'كتاب');
});

test('12. Segment-only SHAHAB input WITHOUT word timestamps never fabricates fake word timestamps', async () => {
  const pcm = makeSineSpeechPcm(4.0, [
    { startSec: 0.2, endSec: 1.4 },
    // 1.5s silence between 1.4 and 2.9 -> measurable acoustically!
    { startSec: 2.9, endSec: 3.8 },
  ]);
  const pcmHash = sha256Float32(pcm);
  const shahabMockResult: ShahabSdkTranscriptResult = {
    resultSchemaVersion: '1.0.0',
    requestId: 'req-seg-only',
    jobId: 'shjob-seg-only',
    sessionId: null,
    projectId: 'proj-12',
    outputRevision: 1,
    modelIdentity: {
      modelId: 'persian-zipformer-transducer-1.0.0',
      neuralCoreIdentity: 'zipformer-fa',
      modelRevisionSha: 'sha-test',
      tokenizerSha256: 'tok-test',
      trainableParameters: 0,
    },
    runtimeIdentity: {
      sdkVersion: '1.0.0',
      engineVersion: '1.0.0',
      runtimeAdapterVersion: 'onnx-wasm',
      provider: 'wasm',
      executionMode: 'LOCAL',
    },
    processingConfigDigest: 'digest',
    transcriptLayers: {
      rawAcousticOutput: 'سلام امم من من اومدم',
      contextAssistedOutput: null,
      verbatimRepresentation: 'سلام امم من من اومدم',
      normalizedRepresentation: 'سلام امم من من اومدم',
      userEditedRepresentation: null,
      authorizedFinalTranscript: null,
    },
    segments: [
      {
        segmentId: 'seg_1',
        revision: 1,
        startSec: 0.2,
        endSec: 3.8,
        startSample16k: 3200,
        endSample16k: 60800,
        textVerbatim: 'سلام امم من من اومدم',
        textNormalized: 'سلام امم من من اومدم',
        timingGranularity: 'SEGMENT_LEVEL',
        timingProvenance: 'SHAHAB_ZIPFORMER_FRAME_STRIDE_40MS',
        finalized: true,
      },
    ],
    timingDisclosure: {
      wordLevelAlignmentSupported: false,
      speakerDiarizationSupported: false,
      decoderScoreCalibrationStatus: 'UNCALIBRATED_DECODER_SCORE',
      rawDecoderLogProbSum: -12.3,
      note: 'Segment-level timing only',
    },
    audioMetrics: {
      durationSec: 4.0,
      sampleRateHz: 16000,
      sampleCount16k: pcm.length,
      processingWallTimeMs: 50,
      rtf: 0.1,
    },
    durabilityState: 'COMMITTED_TO_SDK_STORE',
    provenanceRef: 'prov-12',
    completedAtUtc: '2026-11-23T00:00:00Z',
  };

  const out = await analyzeShahabOutputWithEngine02({
    projectId: 'proj-12',
    sourceAudioId: 'aud-12',
    sourceAudioHash: pcmHash,
    sampleRate: SAMPLE_RATE,
    totalSourceSamples: pcm.length,
    pcmMono: pcm,
    shahabResult: shahabMockResult,
    vadProvider: null,
  });

  assert.equal(out.timingGranularity, 'SEGMENT_ONLY');
  assert.equal(out.executed, false);
  assert.equal(out.rawTranscriptVerbatim, 'سلام امم من من اومدم');

  // Acoustic long silence still genuinely detected
  const silenceProp = out.edl.proposals.find(
    (p) => p.eventCategory === 'SILENCE' && p.operation === 'SHORTEN_SILENCE',
  );
  assert.ok(silenceProp, 'Acoustic silence should still be detected in segment-only mode');
  assert.equal(silenceProp.boundary.measurementBasis, 'MEASURED_ACOUSTIC');

  // Lexical events (filler / word rep) stay anchored to segment bounds with NO proposed cut interval & cannot auto-approve
  const segLexEvents = out.speechEvents.events.filter(
    (e) =>
      e.category === 'FILLER' ||
      e.category === 'WORD_REPETITION' ||
      e.category === 'FALSE_START' ||
      e.category === 'SELF_CORRECTION' ||
      e.category === 'SYLLABLE_REPETITION' ||
      e.category === 'STUTTER',
  );
  assert.ok(segLexEvents.length >= 2, 'Expected segment-anchored filler and word repetition');
  for (const ev of segLexEvents) {
    assert.equal(ev.provenance.timingPrecision, 'SEGMENT_ONLY');
    assert.equal(ev.eligibleForEditSuggestion, false);
    assert.equal(ev.startSec, 0.2);
    assert.equal(ev.endSec, 3.8);
  }
  const lexProps = out.edl.proposals.filter(
    (p) => p.eventCategory === 'FILLER' || p.eventCategory === 'WORD_REPETITION',
  );
  assert.ok(lexProps.length > 0);
  for (const lp of lexProps) {
    assert.notEqual(lp.boundary.measurementBasis, 'ESTIMATED_ASR_TOKEN');
    assert.notEqual(lp.boundary.boundaryConfidence, 'HIGH');
    const approveAttempt = EditDecisionEngine.approveProposal(out.edl, lp.proposalId);
    assert.equal(
      approveAttempt.ok,
      false,
      'Segment-only destructive lexical proposal without word bounds must not be approvable',
    );
  }
});

test('13. Partial/incomplete token timestamps preserve lexical order without false adjacency or auto-cuts', async () => {
  // Note: t1='من' [valid], t2='بسیار' [NaN missing!], t3='من' [valid] -> NOT adjacent 'من من'!
  // Plus t4='امم' [missing timing] -> UNCERTAIN / cannot auto-delete
  const tokens = makeTimedTokens([
    { id: 't1', text: 'من', startSec: 0.2, endSec: 0.5 },
    { id: 't2', text: 'بسیار', startSec: Number.NaN, endSec: Number.NaN, alignmentPrecision: 'missing', timingValid: false },
    { id: 't3', text: 'من', startSec: 1.0, endSec: 1.3 },
    { id: 't4', text: 'امم', startSec: Number.NaN, endSec: Number.NaN, alignmentPrecision: 'missing', timingValid: false },
  ]);
  const pcm = makeSineSpeechPcm(2.0, [
    { startSec: 0.2, endSec: 0.5 },
    { startSec: 1.0, endSec: 1.6 },
  ]);

  const res = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: pcm.length,
    pcmMono: pcm,
    tokens,
    vadProvider: null,
  });

  assert.equal(res.timingGranularity, 'PARTIAL');
  const falseManRep = res.events.find(
    (e) => e.category === 'WORD_REPETITION' && e.relatedText?.includes('من'),
  );
  assert.equal(
    falseManRep,
    undefined,
    'Untimed intermediate token t2 must NOT be dropped to create false adjacency between t1 and t3',
  );

  const untimedFiller = res.events.find((e) => e.category === 'FILLER' && e.relatedText === 'امم');
  assert.ok(untimedFiller, 'Untimed filler should still be surfaced as UNCERTAIN');
  assert.equal(untimedFiller.uncertaintyState, 'INSUFFICIENT_EVIDENCE');
  assert.equal(untimedFiller.eligibleForEditSuggestion, false);
  assert.equal(untimedFiller.requiresHumanReview, true);
});

test('14. Overlapping proposals conflict resolution blocks/flags overlaps cleanly', async () => {
  const pcm = makeSineSpeechPcm(3.0, [
    { startSec: 0.2, endSec: 0.7 },
    { startSec: 2.2, endSec: 2.8 },
  ]);
  const baseEvent = {
    trackId: 'track-main',
    detectionMethod: 'HYBRID_HEURISTIC_FUSION' as const,
    confidence: 0.9,
    uncertaintyState: 'LOW_UNCERTAINTY' as const,
    scores: {
      acousticScore: 0.9,
      linguisticScore: 0.9,
      ruleEvidenceCount: 2,
      modelTokenConfidence: 0.95,
      combinedDecisionScore: 0.9,
      calibratedProbability: null,
      scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC' as const,
      conflicts: [],
    },
    provenance: {
      engineVersion: SPEECH_EVENT_ENGINE_VERSION,
      thresholdConfigVersion: 'v1',
      detectorModule: 'test',
      capabilityMode: 'heuristic' as const,
    },
    eligibleForEditSuggestion: true,
    requiresHumanReview: false,
    explanationFa: 'تست هم‌پوشانی',
  };

  const edl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-14',
      sourceAudioId: 'aud-14',
      sourceAudioHash: sha256Float32(pcm),
      transcriptVersion: 'tr-14',
      sampleRate: SAMPLE_RATE,
      totalSourceSamples: pcm.length,
    },
    events: [
      {
        ...baseEvent,
        eventId: 'ev_sil',
        category: 'SILENCE',
        subtype: 'LONG_UNNECESSARY_SILENCE',
        detectionState: 'DETECTED',
        startSec: 0.8,
        endSec: 2.1,
        durationSec: 1.3,
        startFlicks: TimeMath.secondsToFlicks(0.8),
        endFlicks: TimeMath.secondsToFlicks(2.1),
        durationFlicks: TimeMath.secondsToFlicks(1.3),
        candidateStartSec: 0.88,
        candidateEndSec: 2.02,
        acousticEvidence: { rmsDb: -60, noiseFloorDbfs: -60, hysteresisApplied: true },
      },
      {
        ...baseEvent,
        eventId: 'ev_breath',
        category: 'BREATH',
        subtype: 'AUDIBLE_INHALATION',
        detectionState: 'DETECTED',
        startSec: 1.2,
        endSec: 1.5,
        durationSec: 0.3,
        startFlicks: TimeMath.secondsToFlicks(1.2),
        endFlicks: TimeMath.secondsToFlicks(1.5),
        durationFlicks: TimeMath.secondsToFlicks(0.3),
        acousticEvidence: { rmsDb: -32 },
        eligibleForEditSuggestion: false,
        requiresHumanReview: true,
      },
    ],
  });

  assert.ok(edl.conflicts.length > 0, 'Expected overlap conflict between silence and breath');
  const silProp = edl.proposals.find((p) => p.speechEventSourceIds.includes('ev_sil'));
  assert.ok(silProp);
  assert.equal(silProp.operation, 'NO_EDIT_RECOMMENDED', 'Silence containing breath must not auto-shorten');
});

test('15, 16, 17, 18. Reject invalidates auto-cut, raw text immutable, PCM untouched, and approved EDL hands off to Engine 03', async () => {
  const pcm = makeSineSpeechPcm(4.5, [
    { startSec: 0.2, endSec: 0.7 },
    // 1.4s long silence [0.7..2.1]
    { startSec: 2.1, endSec: 2.6 },
    // filler 'امم' at [2.8..3.1]
    { startSec: 2.8, endSec: 3.1 },
    { startSec: 3.4, endSec: 4.1 },
  ]);
  const pcmHashBefore = sha256Float32(pcm);
  const tokens = makeTimedTokens([
    { id: 't1', text: 'سلام', startSec: 0.2, endSec: 0.7 },
    { id: 't2', text: 'دوستان', startSec: 2.1, endSec: 2.6 },
    { id: 't3', text: 'امم', startSec: 2.8, endSec: 3.1 },
    { id: 't4', text: 'خوش‌آمدید', startSec: 3.4, endSec: 4.1 },
  ]);
  const rawVerbatimBefore = PersianTextNormalizer.extractRawTranscript(tokens);

  const out = await analyzeShahabOutputWithEngine02({
    projectId: 'proj-15',
    sourceAudioId: 'aud-15',
    sourceAudioHash: pcmHashBefore,
    sampleRate: SAMPLE_RATE,
    totalSourceSamples: pcm.length,
    pcmMono: pcm,
    transcriptDocument: {
      schemaVersion: 'avp.transcript.v1',
      transcriptVersion: 'tr-15',
      sourceAudioId: 'aud-15',
      sourceAudioHash: pcmHashBefore,
      sampleRate: SAMPLE_RATE,
      totalSourceSamples: pcm.length,
      language: 'fa',
      modelId: 'shahab-test',
      modelVersion: '1.0.0',
      runtime: 'sherpa-onnx-cpu',
      rawText: rawVerbatimBefore,
      normalizedText: rawVerbatimBefore,
      tokens: tokens.map((t) => ({
        tokenId: t.tokenId,
        rawText: t.originalText,
        normalizedText: t.normalizedText,
        startSample: Math.round(TimeMath.flicksToSeconds(t.range.start) * SAMPLE_RATE),
        endSample: Math.round(TimeMath.flicksToSeconds(t.range.end) * SAMPLE_RATE),
        startSec: TimeMath.flicksToSeconds(t.range.start),
        endSec: TimeMath.flicksToSeconds(t.range.end),
        confidence: t.confidence,
        timestampGranularity: 'WORD' as const,
      })),
      timestampGranularity: 'WORD',
      realTimeFactor: 0.1,
      processingTimeMs: 10,
      offlineVerified: true,
      createdAtMs: 1700000000000,
    },
    vadProvider: null,
  });

  // Check Engine 02 never executes cuts or modifies PCM/raw text
  assert.equal(out.executed, false);
  assert.equal(sha256Float32(pcm), pcmHashBefore);
  assert.equal(out.rawTranscriptVerbatim, rawVerbatimBefore);
  assert.ok(out.edl.proposals.every((p) => p.risk.automaticApprovalEligible === false));
  assert.ok(out.edl.proposals.every((p) => p.status !== 'APPROVED' && p.status !== 'APPLIED'));

  const silenceProp = out.edl.proposals.find((p) => p.operation === 'SHORTEN_SILENCE');
  const fillerProp = out.edl.proposals.find((p) => p.operation === 'REMOVE_FILLER');
  assert.ok(silenceProp, 'Expected SHORTEN_SILENCE proposal');
  assert.ok(fillerProp, 'Expected REMOVE_FILLER proposal');

  // Unapproved EDL cannot render cuts in Engine 03
  const unapprovedPlan = AudioRenderPlanner.buildPlan({
    edl: out.edl,
    sourceAudioId: 'aud-15',
    sourceAudioHash: pcmHashBefore,
    sourceSampleRate: SAMPLE_RATE,
    channelCount: 1,
    totalSourceSamples: pcm.length,
    expectedSourceAudioHash: pcmHashBefore,
    expectedTranscriptVersion: out.edl.transcriptVersion,
    expectedEdlVersion: out.edl.edlVersion,
    config: { encoding: 'pcm16' } satisfies AudioRenderConfig,
    proposalIds: [silenceProp.proposalId],
  });
  assert.equal(unapprovedPlan.ok, false, 'Unapproved proposal must be rejected by Engine 03 planner');

  // Approve silenceProp, Reject fillerProp
  const approveRes = EditDecisionEngine.approveProposal(out.edl, silenceProp.proposalId, {
    reason: 'کاربر سکوت را تایید کرد',
  });
  assert.equal(approveRes.ok, true);
  const rejectRes = EditDecisionEngine.rejectProposal(approveRes.snapshot, fillerProp.proposalId, {
    reason: 'کاربر حذف تپق را رد کرد',
  });
  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.updatedProposal?.status, 'REJECTED');

  // Engine 03 planner succeeds for APPROVED EDL and excludes REJECTED proposal
  const approvedPlan = AudioRenderPlanner.buildPlan({
    edl: rejectRes.snapshot,
    sourceAudioId: 'aud-15',
    sourceAudioHash: pcmHashBefore,
    sourceSampleRate: SAMPLE_RATE,
    channelCount: 1,
    totalSourceSamples: pcm.length,
    expectedSourceAudioHash: pcmHashBefore,
    expectedTranscriptVersion: rejectRes.snapshot.transcriptVersion,
    expectedEdlVersion: rejectRes.snapshot.edlVersion,
    config: { encoding: 'pcm16' } satisfies AudioRenderConfig,
  });
  assert.equal(approvedPlan.ok, true, `Expected valid render plan: ${JSON.stringify(approvedPlan.failures)}`);
  assert.ok(approvedPlan.plan);
  assert.deepEqual(approvedPlan.plan.approvedProposalIds, [silenceProp.proposalId]);
  assert.equal(approvedPlan.plan.removedSegments.length, 1);
  assert.ok(approvedPlan.plan.expectedOutputSamples < pcm.length);
});

test('19. Empty (0 samples) and very short (<100ms) audio handled safely without errors', async () => {
  const emptyRes = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: 0,
    pcmMono: new Float32Array(0),
    vadProvider: null,
  });
  assert.equal(emptyRes.cancelled, false);
  assert.equal(emptyRes.events.length, 0);
  assert.ok(emptyRes.warnings.length > 0);

  const shortPcm = makeSineSpeechPcm(0.05, [{ startSec: 0, endSec: 0.05 }]); // 800 samples = 50ms
  const shortRes = await SpeechEventEngine.analyzeRecording({
    trackId: 'track-main',
    sampleRate: SAMPLE_RATE,
    totalSamples: shortPcm.length,
    pcmMono: shortPcm,
    vadProvider: null,
  });
  assert.equal(shortRes.cancelled, false);
  assert.ok(shortRes.totalRecordingDurationSec < 0.1);
});

test('20. Invalid/malformed input (missing source hash & NaN/negative event bounds) rejected cleanly', async () => {
  const invalidContextEdl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-20',
      sourceAudioId: 'aud-20',
      sourceAudioHash: '',
      transcriptVersion: 'tr-20',
      sampleRate: SAMPLE_RATE,
      totalSourceSamples: 16000,
    },
    events: [],
  });
  assert.equal(invalidContextEdl.validation.isValid, false);
  assert.equal(invalidContextEdl.validation.status, 'INVALID');

  const malformedEventEdl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-20',
      sourceAudioId: 'aud-20',
      sourceAudioHash: 'hash-20',
      transcriptVersion: 'tr-20',
      sampleRate: SAMPLE_RATE,
      totalSourceSamples: 16000,
    },
    events: [
      {
        eventId: 'bad_ev',
        trackId: 'track-main',
        category: 'SILENCE',
        subtype: 'LONG_UNNECESSARY_SILENCE',
        detectionState: 'DETECTED',
        startSec: -0.5,
        endSec: Number.NaN,
        durationSec: 1.0,
        startFlicks: -100,
        endFlicks: Number.NaN,
        durationFlicks: 0,
        detectionMethod: 'HEURISTIC_SIGNAL',
        confidence: 0.9,
        uncertaintyState: 'LOW_UNCERTAINTY',
        scores: {
          acousticScore: 0.9,
          linguisticScore: null,
          ruleEvidenceCount: 1,
          modelTokenConfidence: null,
          combinedDecisionScore: 0.9,
          calibratedProbability: null,
          scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
          conflicts: [],
        },
        provenance: {
          engineVersion: SPEECH_EVENT_ENGINE_VERSION,
          thresholdConfigVersion: 'v1',
          detectorModule: 'test',
          capabilityMode: 'heuristic',
        },
        eligibleForEditSuggestion: true,
        requiresHumanReview: false,
        explanationFa: 'تست ورودی نامعتبر',
      },
    ],
  });
  assert.equal(malformedEventEdl.validation.isValid, false);
  assert.equal(malformedEventEdl.proposals[0].status, 'INVALID');
  assert.equal(malformedEventEdl.proposals[0].boundary.valid, false);
});

test('21. Real SHAHAB -> Engine 02 -> Engine 03 unmocked vertical slice on bundled sample.wav', async () => {
  const modelDir = path.resolve(process.cwd(), 'models/persian-zipformer-transducer/1.0.0');
  const sampleWavPath = path.join(modelDir, 'sample.wav');
  assert.ok(fs.existsSync(sampleWavPath), 'Expected bundled sample.wav on disk');

  const wavBytes = fs.readFileSync(sampleWavPath);
  const pcmHash = crypto.createHash('sha256').update(wavBytes).digest('hex');
  const { pcm16k } = decodeWavToMono16k(new Uint8Array(wavBytes));

  const sdk = createShahabSdkEngine({
    modelDir,
    docsDir: path.resolve(process.cwd(), 'docs/shahab'),
    clientIdentity: 'engine02-integration-test',
  });

  try {
    await sdk.initialize();
    const submitted = await sdk.submitTranscription({
      apiVersion: '1.0.0',
      requestId: `req-e02-${Date.now()}`,
      idempotencyKey: `idem-e02-${Date.now()}`,
      executionMode: 'LOCAL',
      decodePolicy: 'SPEED',
      audioSource: {
        sourceKind: 'WAV_BYTE_BUFFER',
        sourceId: 'sample-wav-real',
        sampleRateHz: 16000,
        channels: 1,
        sampleFormat: 'WAV_BYTES',
        endianness: 'LITTLE_ENDIAN',
        frameCount: pcm16k.length,
        timelineOriginSec: 0,
        timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
        endOfStream: true,
        ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
        wavBytes: new Uint8Array(wavBytes),
      },
      authorization: {
        tenantOrProjectId: 'proj-real-slice',
        callerIdentity: 'engine02-test',
        explicitCloudConsent: false,
      },
    });

    const shahabResult = await sdk.waitForFinalResult(submitted.jobId, 'proj-real-slice');
    assert.ok(shahabResult.transcriptLayers.verbatimRepresentation.length > 0);
    assert.equal(shahabResult.timingDisclosure.wordLevelAlignmentSupported, false);

    const engine02 = await analyzeShahabOutputWithEngine02({
      projectId: 'proj-real-slice',
      sourceAudioId: 'sample-wav-real',
      sourceAudioHash: pcmHash,
      sampleRate: SAMPLE_RATE,
      totalSourceSamples: pcm16k.length,
      pcmMono: pcm16k,
      shahabResult,
      vadProvider: null,
    });

    assert.equal(engine02.executed, false);
    assert.equal(engine02.rawTranscriptVerbatim, shahabResult.transcriptLayers.verbatimRepresentation);
    assert.equal(engine02.timingGranularity, 'SEGMENT_ONLY');
    assert.equal(engine02.edl.validation.isValid, true);
    assert.ok(engine02.edl.proposals.every((p) => p.risk.automaticApprovalEligible === false));

    // If Engine 02 detected any measurable acoustic silence shortening candidate, approve and build Engine 03 plan;
    // otherwise verify clean 0-approval no-op handoff to Engine 03 planner.
    let edlForRender = engine02.edl;
    const approvableSilence = edlForRender.proposals.find(
      (p) => p.operation === 'SHORTEN_SILENCE' && p.risk.approvalPermitted && p.proposedRange !== null,
    );
    if (approvableSilence) {
      const approved = EditDecisionEngine.approveProposal(edlForRender, approvableSilence.proposalId, {
        reason: 'تایید سکوت اندازه‌گیری‌شده در تست یکپارچه واقعی',
      });
      assert.equal(approved.ok, true);
      edlForRender = approved.snapshot;
    }

    const planRes = AudioRenderPlanner.buildPlan({
      edl: edlForRender,
      sourceAudioId: 'sample-wav-real',
      sourceAudioHash: pcmHash,
      sourceSampleRate: SAMPLE_RATE,
      channelCount: 1,
      totalSourceSamples: pcm16k.length,
      expectedSourceAudioHash: pcmHash,
      expectedTranscriptVersion: edlForRender.transcriptVersion,
      expectedEdlVersion: edlForRender.edlVersion,
      config: { encoding: 'pcm16' } satisfies AudioRenderConfig,
    });
    assert.equal(planRes.ok, true, `Engine 03 render planner failed: ${JSON.stringify(planRes.failures)}`);
    assert.ok(planRes.plan);
  } finally {
    await sdk.dispose();
  }
});
