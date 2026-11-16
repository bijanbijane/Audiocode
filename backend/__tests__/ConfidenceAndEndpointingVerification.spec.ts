/**
 * @file backend/__tests__/ConfidenceAndEndpointingVerification.spec.ts
 * @description Section 136: Automated Verification for Platt Scaling Confidence Calibration (ECE),
 *              Persian Syntactic/Prosodic Endpointing, and SRT / HMAC-SHA256 Webhook Delivery.
 */

import { describe, it, expect } from 'vitest';
import {
  PersianAsrConfidenceCalibrator,
  CalibrationSample,
} from '../../src/ai-engine/asr/PersianAsrConfidenceCalibrator';
import { PersianSyntacticAcousticEndpointDetector } from '../../src/ai-engine/asr/PersianSyntacticAcousticEndpointDetector';
import { BackendTranscriptFormatterAndWebhookService } from '../src/delivery/BackendTranscriptFormatterAndWebhookService';

describe('Confidence Calibration, Syntactic Endpointing & Webhook Delivery (Sections 134–136)', () => {
  it('1. calibrates overconfident ASR softmax scores via Platt Scaling and reduces ECE below 0.04', () => {
    // Generate synthetic overconfident ASR validation set:
    // Raw confidence ~0.92 has only ~70% empirical accuracy; raw ~0.75 has ~45% accuracy.
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 200; i++) {
      samples.push({
        rawConfidence: 0.92,
        isCorrect: i % 10 < 7 ? 1 : 0, // 70% empirical accuracy vs 92% raw confidence
      });
      samples.push({
        rawConfidence: 0.76,
        isCorrect: i % 20 < 9 ? 1 : 0, // 45% empirical accuracy vs 76% raw confidence
      });
    }

    const beforeReport = PersianAsrConfidenceCalibrator.computeExpectedCalibrationError(samples);
    expect(beforeReport.expectedCalibrationError).toBeGreaterThan(0.20);

    const plattParams = PersianAsrConfidenceCalibrator.fitPlattScaling(samples, 500, 0.08);
    const afterReport = PersianAsrConfidenceCalibrator.computeExpectedCalibrationError(samples, plattParams);

    expect(afterReport.expectedCalibrationError).toBeLessThan(0.04);
    expect(afterReport.brierScore).toBeLessThan(beforeReport.brierScore);
  });

  it('2. holds live Persian utterance open across mid-clause "که" pause and fast-commits on completed verb + falling F0', () => {
    // Case A: Speaker pauses for 650ms right after subordinating conjunction "که" with flat pitch
    const midClauseDecision = PersianSyntacticAcousticEndpointDetector.evaluateEndpoint({
      partialPersianTranscript: 'پروژه‌ای که دیروز به شما گفتم که',
      trailingSilenceMs: 650,
      utteranceDurationMs: 3200,
      recentVoicedF0ContourHz: [145, 146, 145, 147, 146, 148],
    });

    expect(midClauseDecision.syntacticState).toBe('INCOMPLETE_CONJUNCTION_OR_PREP');
    expect(midClauseDecision.shouldCommitUtterance).toBe(false);
    expect(midClauseDecision.reason).toBe('HELD_FOR_INCOMPLETE_SYNTAX');

    // Case B: Speaker finishes SOV verb "می‌شود" with falling declarative F0 contour and 400ms silence
    const completeVerbDecision = PersianSyntacticAcousticEndpointDetector.evaluateEndpoint({
      partialPersianTranscript: 'پردازش صدا با دقت بالا انجام می‌شود',
      trailingSilenceMs: 400,
      utteranceDurationMs: 2900,
      recentVoicedF0ContourHz: [160, 152, 144, 135, 126, 118],
    });

    expect(completeVerbDecision.syntacticState).toBe('COMPLETE_VERB_OR_CLAUSE');
    expect(completeVerbDecision.terminalPitchSlopeHzPerSec).toBeLessThan(-25);
    expect(completeVerbDecision.shouldCommitUtterance).toBe(true);
    expect(completeVerbDecision.reason).toBe('SYNTACTIC_FAST_COMMIT');
  });

  it('3. formats ZWNJ-safe Persian .srt cues and verifies anti-replay HMAC-SHA256 webhooks', () => {
    const words = [
      { word: 'درود', startSec: 0.5, endSec: 0.9, speakerId: 'SPEAKER_1' },
      { word: 'بر', startSec: 0.92, endSec: 1.1, speakerId: 'SPEAKER_1' },
      { word: 'شنوندگان', startSec: 1.15, endSec: 1.7, speakerId: 'SPEAKER_1' },
      { word: 'برنامه‌های', startSec: 1.75, endSec: 2.3, speakerId: 'SPEAKER_1' },
      { word: 'تخصصی', startSec: 2.35, endSec: 2.9, speakerId: 'SPEAKER_1' },
      { word: 'سپاسگزارم', startSec: 3.4, endSec: 4.1, speakerId: 'SPEAKER_2' },
    ];

    const srt = BackendTranscriptFormatterAndWebhookService.formatToPersianSrt(words, 42, 6.0);
    expect(srt).toContain('00:00:00,500 --> 00:00:02,900');
    expect(srt).toContain('برنامه‌های'); // ZWNJ preserved intact
    expect(srt).toContain('00:00:03,400 --> 00:00:04,100'); // Split on speaker change

    const annotated = BackendTranscriptFormatterAndWebhookService.formatSpeakerAnnotatedTranscript(words);
    expect(annotated).toContain('[00:00:00] SPEAKER_1: درود بر شنوندگان برنامه‌های تخصصی');
    expect(annotated).toContain('[00:00:03] SPEAKER_2: سپاسگزارم');

    const payload = JSON.stringify({ jobId: 'job-99', status: 'COMPLETED' });
    const secret = 'whsec_test_persian_audio_secret_key';
    const headers = BackendTranscriptFormatterAndWebhookService.signWebhookPayload(payload, secret, 1700000000);

    const validCheck = BackendTranscriptFormatterAndWebhookService.verifyWebhookSignature(
      payload,
      headers['X-PAudio-Timestamp'],
      headers['X-PAudio-Signature-256'],
      secret,
      1700000120 // +120s within 300s window
    );
    expect(validCheck.valid).toBe(true);

    const replayBlocked = BackendTranscriptFormatterAndWebhookService.verifyWebhookSignature(
      payload,
      headers['X-PAudio-Timestamp'],
      headers['X-PAudio-Signature-256'],
      secret,
      1700000500 // +500s exceeds 300s anti-replay window
    );
    expect(replayBlocked.valid).toBe(false);
    expect(replayBlocked.reason).toBe('TIMESTAMP_EXPIRED_REPLAY_BLOCKED');
  });
});
