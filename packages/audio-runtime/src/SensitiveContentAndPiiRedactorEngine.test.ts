import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SensitiveContentAndPiiRedactorEngine } from './SensitiveContentAndPiiRedactorEngine';
import { PersianTextNormalizer } from '../../../src/ai-engine/PersianTextNormalizer';
import { TimeMath } from '../../../src/contracts/timebase.contract';

describe('SensitiveContentAndPiiRedactorEngine (Section 81)', () => {
  it('detects spoken Persian phone numbers and custom blacklist words with exact time ranges', () => {
    const words = ['شماره', 'موبایل', 'صفر', 'نهصد', 'و', 'دوازده', 'شرکت', 'محرمانه'];
    const raw = words.map((w, idx) => ({
      id: `t_${idx}`,
      text: w,
      range: {
        start: TimeMath.secondsToFlicks(idx * 0.5),
        end: TimeMath.secondsToFlicks(idx * 0.5 + 0.4),
      },
      confidence: 0.96,
    }));

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript(raw);
    const spans = SensitiveContentAndPiiRedactorEngine.scanTranscriptForSensitiveContent(
      tokens,
      ['محرمانه'],
    );

    assert.equal(spans.length, 2);
    assert.equal(spans[0].category, 'PHONE_NUMBER');
    assert.deepEqual(spans[0].tokenIds, ['t_2', 't_3', 't_4', 't_5']);
    assert.equal(spans[1].category, 'CUSTOM_BLACKLIST_WORD');
    assert.deepEqual(spans[1].tokenIds, ['t_7']);
  });

  it('generates smooth -18dBFS 1kHz broadcast bleep and low-pass muffled audio segments', () => {
    const sr = 48000 as const;
    const orig = new Float32Array(4800).fill(0.5);
    const room = new Float32Array(480).fill(0.01);

    const bleep = SensitiveContentAndPiiRedactorEngine.generateRedactedAudioSegment(
      orig,
      room,
      sr,
      'BROADCAST_BLEEP_1KHZ',
    );
    assert.equal(bleep.length, orig.length);
    assert.equal(bleep[0], 0); // Starts smoothly at zero fade-in
    const maxAmp = Math.max(...bleep.map(Math.abs));
    assert.ok(maxAmp > 0.11 && maxAmp < 0.14); // -18dBFS ~ 0.1258

    const muffled = SensitiveContentAndPiiRedactorEngine.generateRedactedAudioSegment(
      orig,
      room,
      sr,
      'LOW_PASS_VOICE_MUFFLE',
    );
    assert.equal(muffled.length, orig.length);
  });
});
