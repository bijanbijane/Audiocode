import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PersianNBestConfusionNetworkBuilder,
  WhisperPromptAndControlResolver,
} from './PersianNBestLatticeAndWhisperPromptEngine';

describe('Section 128: WhisperPromptAndControlResolver & PersianNBestConfusionNetworkBuilder', () => {
  it('resolves v2 (51865) vs v3-turbo (51866) control tokens and builds N-Best Sausage Lattice', () => {
    const v2 = WhisperPromptAndControlResolver.resolveSpecialTokensForVocabSize(51865);
    const v3 = WhisperPromptAndControlResolver.resolveSpecialTokensForVocabSize(51866);
    assert.equal(v2.timestampBeginId, 50364);
    assert.equal(v3.timestampBeginId, 50365);

    const net = PersianNBestConfusionNetworkBuilder.buildWordConfusionNetwork([
      { transcript: 'دکتر تباتبایی آمد', totalLogScore: -2.1 },
      { transcript: 'دکتر طباطبایی آمد', totalLogScore: -2.3 },
    ]);
    assert.equal(net.length, 3);
    assert.equal(net[1].isUncertain, true);
    assert.ok(net[1].alternatives.some((a) => a.word === 'طباطبایی'));
  });
});
