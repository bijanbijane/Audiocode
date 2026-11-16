import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IntegratedPersianAsrService } from './IntegratedPersianAsrService';

describe('Section 123: IntegratedPersianAsrService End-to-End Orchestration', () => {
  it('resamples 48kHz audio, restores compounds/numerals/formal layer, and snaps disfluency splices', async () => {
    const svc = new IntegratedPersianAsrService({
      modelId: 'mock-asr',
      modelVersion: '1.0.0',
      async detectVoiceActivity() {
        return { hasSpeech: true, speechRatio: 0.9 };
      },
      async transcribeWindow() {
        return [
          { word: 'اونا', relativeStartSec: 0.1, relativeEndSec: 0.4, probability: 0.95 },
          { word: 'کتاب', relativeStartSec: 0.45, relativeEndSec: 0.75, probability: 0.96 },
          { word: 'ها', relativeStartSec: 0.78, relativeEndSec: 0.95, probability: 0.96 },
          { word: 'اممم', relativeStartSec: 1.1, relativeEndSec: 1.5, probability: 0.92 },
          { word: 'می‌خونن', relativeStartSec: 1.6, relativeEndSec: 2.0, probability: 0.94 },
        ];
      },
    });

    const pcm48k = new Float32Array(48000 * 3);
    const res = await svc.transcribeAndAnalyzeAudio([pcm48k], {
      sourceSampleRate: 48000,
      enableCompoundAndBilingualRestoration: true,
      enableSpokenNumeralFormatting: true,
      enableProsodicPunctuation: false,
      convertDisplayToFormalPersian: false,
      detectSpeechDisfluenciesAndSnapBoundaries: true,
    });

    assert.equal(res.tokens.length, 4); // «کتاب» + «ها» merged into «کتاب‌ها»
    assert.equal(res.tokens[0].formalStandardEquivalent, 'آن\u200cها');
    assert.equal(res.tokens[1].displayText, 'کتاب\u200cها');
    assert.ok(res.detectedIssuesWithSnappedSplices.length >= 1);
  });
});
