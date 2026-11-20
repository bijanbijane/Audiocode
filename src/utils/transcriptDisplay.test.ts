import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompanionTranscriptTokens,
  resolveSpeakerTurnLabel,
} from './transcriptDisplay';

test('resolveSpeakerTurnLabel shows speaker label only at turn transitions', () => {
  const tokens = [
    { speakerName: 'آرش' },
    { speakerName: 'آرش' },
    { speakerName: 'سارا' },
    { speakerName: 'سارا' },
    { speakerName: 'آرش' },
    { speakerName: 'گوینده استودیو' },
  ];

  assert.equal(resolveSpeakerTurnLabel(tokens, 0), 'آرش:');
  assert.equal(resolveSpeakerTurnLabel(tokens, 1), '');
  assert.equal(resolveSpeakerTurnLabel(tokens, 2), 'سارا:');
  assert.equal(resolveSpeakerTurnLabel(tokens, 3), '');
  assert.equal(resolveSpeakerTurnLabel(tokens, 4), 'آرش:');
  assert.equal(resolveSpeakerTurnLabel(tokens, 5), 'گوینده استودیو:');
});

test('resolveSpeakerTurnLabel handles empty, whitespace, and out-of-bounds inputs safely', () => {
  const tokens = [
    { speakerName: '   ' },
    { speakerName: '' },
    { speakerName: 'گوینده ۱' },
    { speakerName: undefined },
    { speakerName: 'گوینده ۱' },
  ];

  assert.equal(resolveSpeakerTurnLabel(tokens, -1), '');
  assert.equal(resolveSpeakerTurnLabel(tokens, 99), '');
  assert.equal(resolveSpeakerTurnLabel(tokens, 0), '');
  assert.equal(resolveSpeakerTurnLabel(tokens, 1), '');
  assert.equal(resolveSpeakerTurnLabel(tokens, 2), 'گوینده ۱:');
  assert.equal(resolveSpeakerTurnLabel(tokens, 3), '');
  assert.equal(resolveSpeakerTurnLabel(tokens, 4), 'گوینده ۱:');
});

test('buildCompanionTranscriptTokens deduplicates overlapping chunk-seam words and builds canonical range', () => {
  const tokens = buildCompanionTranscriptTokens({
    trackId: 'track-1',
    speakerName: 'گوینده فایل ورودی',
    segments: [
      {
        id: 'seg_0',
        index: 0,
        startSec: 0,
        endSec: 25,
        text: 'امروز درباره هوش مصنوعی',
        language: 'fa',
        timestampGranularity: 'WORD',
        words: [
          { word: 'امروز', startSec: 22.0, endSec: 22.6 },
          { word: 'درباره', startSec: 22.7, endSec: 23.3 },
          { word: 'هوش', startSec: 23.8, endSec: 24.3 },
          { word: 'مصنوعی', startSec: 24.4, endSec: 24.9 },
        ],
      },
      {
        id: 'seg_1',
        index: 1,
        startSec: 23.5,
        endSec: 40,
        text: 'هوش مصنوعی صحبت می‌کنیم',
        language: 'fa',
        timestampGranularity: 'WORD',
        words: [
          { word: 'هوش', startSec: 23.85, endSec: 24.35 },
          { word: 'مصنوعی', startSec: 24.45, endSec: 24.95 },
          { word: 'صحبت', startSec: 25.2, endSec: 25.8 },
          { word: 'می‌کنیم', startSec: 25.9, endSec: 26.5 },
        ],
      },
    ],
  });

  assert.deepEqual(
    tokens.map((t) => t.displayText),
    ['امروز', 'درباره', 'هوش', 'مصنوعی', 'صحبت', 'می‌کنیم'],
  );
  assert.equal(tokens[0].speakerName, 'گوینده فایل ورودی');
  assert.ok(tokens.every((t) => t.range && t.range.endFlicks > t.range.startFlicks));
  assert.equal(tokens[0].alignmentSource, 'ASR');
});

test('buildCompanionTranscriptTokens handles segment-only Whisper output and zero-speech segments', () => {
  const empty = buildCompanionTranscriptTokens({
    trackId: 'track-1',
    speakerName: 'سارا',
    segments: [
      {
        id: 'seg_0',
        index: 0,
        startSec: 0,
        endSec: 5,
        text: '   ',
        language: 'unknown',
        timestampGranularity: 'SEGMENT',
        words: [],
      },
    ],
  });
  assert.equal(empty.length, 0);

  const whisperSeg = buildCompanionTranscriptTokens({
    trackId: 'track-1',
    speakerName: 'سارا',
    segments: [
      {
        id: 'seg_0',
        index: 0,
        startSec: 1.0,
        endSec: 3.0,
        text: 'سلام world',
        language: 'fa',
        timestampGranularity: 'SEGMENT',
        words: [],
      },
    ],
  });
  assert.equal(whisperSeg.length, 2);
  assert.equal(whisperSeg[0].detectedLanguage, 'FA');
  assert.equal(whisperSeg[1].detectedLanguage, 'EN');
  assert.equal(whisperSeg[0].alignmentSource, 'AcousticSnap');
});
