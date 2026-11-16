import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianChapterAndTopicSegmenter } from './PersianChapterAndTopicSegmenter';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

function makeTopicBlock(
  prefix: string,
  words: string[],
  startSec: number,
  durationSec: number,
) {
  const step = durationSec / words.length;
  return words.map((word, idx) => ({
    id: `${prefix}_${idx}`,
    text: word,
    range: {
      start: TimeMath.secondsToFlicks(startSec + idx * step),
      end: TimeMath.secondsToFlicks(startSec + (idx + 0.8) * step),
    },
    confidence: 0.95,
  }));
}

test('Section 56: PersianChapterAndTopicSegmenter segments topics using TextTiling, acoustic pauses, and TF-IDF keywords', () => {
  // Include a recurring global word ("پادکست") across all topics to verify TF-IDF promotes topic-distinct keywords
  const block1 = makeTopicBlock(
    'ch1',
    ['پادکست', 'اقتصاد', 'تورم', 'صادرات', 'بانک', 'اقتصاد', 'تورم', 'بورس', 'اقتصاد'],
    0,
    92,
  );
  // Gap from 92s to 94.5s (2.5s acoustic pause) + lexical shift into AI
  const block2 = makeTopicBlock(
    'ch2',
    ['پادکست', 'هوش', 'مصنوعی', 'مدل', 'الگوریتم', 'هوش', 'مصنوعی', 'پردازش', 'مصنوعی'],
    94.5,
    92,
  );
  // Lexical shift into audio mastering
  const block3 = makeTopicBlock(
    'ch3',
    ['پادکست', 'مسترینگ', 'اکولایزر', 'کمپرسور', 'میکس', 'مسترینگ', 'فرکانس', 'کمپرسور'],
    187,
    92,
  );

  const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
    ...block1,
    ...block2,
    ...block3,
  ]);

  const chapters = PersianChapterAndTopicSegmenter.generateChapters(tokens, 90.0);
  assert.equal(chapters.length, 3);

  assert.equal(chapters[0].startTimestampFormatted, '00:00:00');
  assert.ok(chapters[0].topKeywordsFa.includes('اقتصاد'));

  assert.equal(chapters[1].startTimestampFormatted, '00:01:34');
  assert.ok(chapters[1].topKeywordsFa.includes('مصنوعی'));

  assert.equal(chapters[2].startTimestampFormatted, '00:03:07');
  assert.ok(chapters[2].topKeywordsFa.includes('مسترینگ'));

  const showNotes = PersianChapterAndTopicSegmenter.formatChaptersForShowNotes(chapters);
  assert.ok(showNotes.includes('00:00:00 - بخش 1:'));
  assert.ok(showNotes.includes('00:01:34 - بخش 2:'));
  assert.ok(showNotes.includes('00:03:07 - بخش 3:'));
});

test('Section 56: PersianChapterAndTopicSegmenter keeps cohesive contiguous blocks in the same chapter', () => {
  const repeatedTopic = ['معماری', 'نرم‌افزار', 'ماژولار', 'تست', 'کیفیت'];
  const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
    ...makeTopicBlock('a', repeatedTopic, 0, 92),
    ...makeTopicBlock('b', repeatedTopic, 92.2, 92),
  ]);

  const chapters = PersianChapterAndTopicSegmenter.generateChapters(tokens, 90.0);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].chapterIndex, 0);
});
