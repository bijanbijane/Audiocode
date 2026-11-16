import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersianPodcastTeaserGeneratorEngine } from './PersianPodcastTeaserGeneratorEngine';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

describe('PersianPodcastTeaserGeneratorEngine (Section 2.6)', () => {
  it('ranks high-energy rhetorical hook segments ahead of routine intro segments', () => {
    const sr = 8000 as unknown as 16000;
    const pcm = new Float32Array(8000 * 100); // 100s buffer

    // Segment 1 [0s..12s]: low energy routine speech
    for (let i = 0; i < 8000 * 12; i++) {
      pcm[i] = 0.05 * Math.sin((2 * Math.PI * 160 * i) / 8000);
    }

    // Segment 2 [70s..82s]: high energy + rhetorical hook phrases
    for (let i = 8000 * 70; i < 8000 * 82; i++) {
      const mod = (i % 4000) < 2000 ? 0.45 : 0.1;
      pcm[i] = mod * Math.sin((2 * Math.PI * 220 * i) / 8000);
    }

    const seg1Words = [
      'امروز', 'در', 'این', 'بخش', 'از', 'برنامه', 'می‌خواهیم', 'کمی', 'درباره', 'موضوعات', 'معمولی', 'صحبت', 'کنیم.',
    ];
    const seg2Words = [
      'بزرگ‌ترین', 'اشتباه', 'من', 'این', 'بود', 'و', 'نکته', 'عجیب', 'اینجاست', 'که', 'چرا', 'هیچ‌کس', 'نگفت؟',
    ];

    const rawTokens: {
      id: string;
      text: string;
      range: { start: number; end: number };
      confidence: number;
    }[] = [];

    seg1Words.forEach((w, idx) => {
      rawTokens.push({
        id: `s1_${idx}`,
        text: w,
        range: {
          start: TimeMath.secondsToFlicks(idx * 0.9),
          end: TimeMath.secondsToFlicks(idx * 0.9 + 0.8),
        },
        confidence: 0.95,
      });
    });

    seg2Words.forEach((w, idx) => {
      rawTokens.push({
        id: `s2_${idx}`,
        text: w,
        range: {
          start: TimeMath.secondsToFlicks(70 + idx * 0.9),
          end: TimeMath.secondsToFlicks(70 + idx * 0.9 + 0.8),
        },
        confidence: 0.98,
      });
    });

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript(rawTokens);
    const hooks = PersianPodcastTeaserGeneratorEngine.findBestColdOpenTeaserHooks(
      tokens,
      pcm,
      sr,
      2,
    );

    assert.equal(hooks.length, 2);
    assert.equal(hooks[0].rank, 1);
    assert.ok(hooks[0].transcriptExcerptFa.includes('بزرگ‌ترین اشتباه'));
    assert.ok(hooks[0].combinedTeaserScore > hooks[1].combinedTeaserScore);
  });
});
