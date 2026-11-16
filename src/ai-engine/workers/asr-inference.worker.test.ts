import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SequentialPersianAiPipelineRunner } from './asr-inference.worker';
import { TimeMath } from '../../contracts/timebase.contract';

describe('Section 116: SequentialPersianAiPipelineRunner & Inverse Batch Timestamp Mapper', () => {
  it('maps consolidated batch word timestamps back to exact original audio timeline Flicks across skipped silences', () => {
    const runner = new SequentialPersianAiPipelineRunner();

    // Suppose original audio had silence from 0..10.0s, then a speech segment from 10.0s..12.0s (samples 160,000..192,000)
    const mapped = runner.mapBatchWordsToOriginalAudioTokens(
      {
        batchIndex: 0,
        speechSegments: [
          {
            startSample16k: 160000,
            endSample16k: 192000,
            range: {
              start: TimeMath.secondsToFlicks(10.0),
              end: TimeMath.secondsToFlicks(12.0),
            },
            peakSpeechProb: 0.96,
          },
        ],
        totalSpeechDurationSec: 2.0,
        concatenated16kPcm: new Float32Array(32000),
        offsetMappings: [
          {
            batchStartSample: 0,
            batchEndSample: 32000,
            originalAudioStartSample: 160000, // 10.0s in original audio
          },
        ],
      },
      [
        {
          word: 'سلام',
          relativeStartSec: 0.2,
          relativeEndSec: 0.7,
          probability: 0.95,
        },
      ],
    );

    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].displayText, 'سلام');
    // 10.0s + 0.2s = 10.2s in original timeline
    assert.equal(mapped[0].range.start, TimeMath.secondsToFlicks(10.2));
    assert.equal(mapped[0].range.end, TimeMath.secondsToFlicks(10.7));
  });
});
