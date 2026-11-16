import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersianShowNotesAndTextRankEngine } from './PersianShowNotesAndTextRankEngine';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

describe('PersianShowNotesAndTextRankEngine (Sections 2.6 & 3)', () => {
  const buildEpisodeTokens = () => {
    const rawSentences = [
      {
        startSec: 5,
        words: ['امروز', 'درباره', 'معماری', 'پردازش', 'صوت', 'فارسی', 'گفتگو', 'می‌کنیم.'],
      },
      {
        startSec: 25,
        words: ['مهم‌ترین', 'نکته', 'کلیدی', 'در', 'پردازش', 'صوت', 'فارسی', 'حفظ', 'کسره', 'اضافه', 'است.'],
      },
      {
        startSec: 65,
        words: ['دکتر', 'حسابی', 'در', 'دانشگاه', 'تهران', 'کتاب', 'فیزیک', 'را', 'در', 'شهر', 'شیراز', 'معرفی', 'کرد.'],
      },
    ];

    const rawTokens: {
      id: string;
      text: string;
      range: { start: number; end: number };
      confidence: number;
    }[] = [];

    let idx = 0;
    for (const s of rawSentences) {
      let cur = s.startSec;
      for (const w of s.words) {
        idx++;
        rawTokens.push({
          id: `tok_${idx}`,
          text: w,
          range: {
            start: TimeMath.secondsToFlicks(cur),
            end: TimeMath.secondsToFlicks(cur + 0.4),
          },
          confidence: 0.96,
        });
        cur += 0.5;
      }
    }

    return PersianTextNormalizer.buildThreeLayerTranscript(rawTokens);
  };

  it('extracts ranked key takeaway sentences with TextRank and Persian discourse markers', () => {
    const tokens = buildEpisodeTokens();
    const takeaways = PersianShowNotesAndTextRankEngine.extractTopKeyTakeaways(tokens, 2);

    assert.equal(takeaways.length, 2);
    assert.ok(takeaways.some((t) => t.textFa.includes('مهم‌ترین')));
    assert.ok(takeaways[0].timestampFormatted.startsWith('00:00:'));
  });

  it('extracts Persian named entities (PERSON, ORGANIZATION, BOOK, LOCATION) with timestamps', () => {
    const tokens = buildEpisodeTokens();
    const entities = PersianShowNotesAndTextRankEngine.extractNamedEntitiesWithTimestamps(tokens);

    assert.ok(entities.some((e) => e.entityType === 'PERSON' && e.entityNameFa.includes('دکتر حسابی')));
    assert.ok(
      entities.some(
        (e) =>
          e.entityType === 'ORGANIZATION_OR_INSTITUTE' && e.entityNameFa.includes('دانشگاه تهران'),
      ),
    );
    assert.ok(
      entities.some((e) => e.entityType === 'WORK_OR_BOOK' && e.entityNameFa.includes('کتاب فیزیک')),
    );
    assert.ok(
      entities.some((e) => e.entityType === 'LOCATION' && e.entityNameFa.includes('شهر شیراز')),
    );
  });
});
