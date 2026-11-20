import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpeakerTurnLabel } from './transcriptDisplay';

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
