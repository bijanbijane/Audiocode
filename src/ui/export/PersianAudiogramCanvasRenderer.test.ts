import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianAudiogramCanvasRenderer } from './PersianAudiogramCanvasRenderer';
import { PersianTextNormalizer } from '../../ai-engine/PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';

test('Section 67: PersianAudiogramCanvasRenderer renders RTL title, 32 spectrum bars, and active Flick-synced karaoke word', () => {
  const filledTexts: { text: string; x: number; y: number; fillStyle: string }[] = [];
  let roundRectCount = 0;

  const mockCtx = {
    fillStyle: '',
    direction: 'ltr',
    textAlign: 'left',
    font: '',
    fillRect: () => {},
    beginPath: () => {},
    roundRect: () => {
      roundRectCount++;
    },
    fill: () => {},
    fillText: (text: string, x: number, y: number) => {
      filledTexts.push({ text, x, y, fillStyle: String(mockCtx.fillStyle) });
    },
  } as unknown as CanvasRenderingContext2D;

  const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
    { id: 'c1', text: 'پادکست', range: { start: 0, end: TimeMath.secondsToFlicks(0.5) }, confidence: 0.99 },
    { id: 'c2', text: 'آواپرداز', range: { start: TimeMath.secondsToFlicks(0.5), end: TimeMath.secondsToFlicks(1.2) }, confidence: 0.99 },
    { id: 'c3', text: 'فارسی', range: { start: TimeMath.secondsToFlicks(1.2), end: TimeMath.secondsToFlicks(1.8) }, confidence: 0.99 },
  ]);

  const bars = new Float32Array(32).fill(0.6);

  PersianAudiogramCanvasRenderer.renderAudiogramFrame(
    mockCtx,
    {
      widthPx: 1080,
      heightPx: 1920,
      podcastTitleFa: 'رادیو فناوری',
      episodeSubtitleFa: 'اپیزود ویژه هوش مصنوعی',
      backgroundColorHex: '#090d16',
      accentWaveColorHex: '#38bdf8',
      activeWordHighlightColorHex: '#fbbf24',
    },
    TimeMath.secondsToFlicks(0.75), // Inside "آواپرداز"
    tokens,
    bars,
  );

  assert.equal(mockCtx.direction, 'rtl');
  assert.equal(roundRectCount, 32);
  assert.ok(filledTexts.some((t) => t.text === 'رادیو فناوری'));
  assert.ok(filledTexts.some((t) => t.text === 'پادکست آواپرداز فارسی'));
  assert.ok(
    filledTexts.some((t) => t.text === 'آواپرداز' && t.fillStyle === '#fbbf24'),
  );
});
