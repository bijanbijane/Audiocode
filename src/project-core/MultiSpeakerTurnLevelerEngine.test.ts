import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MultiSpeakerTurnLevelerEngine } from './MultiSpeakerTurnLevelerEngine';
import { TimelineAutomationEngine } from './TimelineAutomationEngine';
import { TimeMath } from '../contracts/timebase.contract';

describe('MultiSpeakerTurnLevelerEngine (Section 82)', () => {
  it('attenuates a loud speaker turn and boosts a quiet speaker turn toward -18 dBFS target', () => {
    const sr = 16000 as const;
    const pcm = new Float32Array(sr * 4);

    // Speaker 1 [0.5s .. 1.5s]: very loud (amplitude 0.5 -> RMS ~ -6 dBFS)
    for (let i = sr * 0.5; i < sr * 1.5; i++) {
      pcm[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / sr);
    }

    // Speaker 2 [2.5s .. 3.5s]: very quiet (amplitude 0.03 -> RMS ~ -33 dBFS)
    for (let i = sr * 2.5; i < sr * 3.5; i++) {
      pcm[i] = 0.03 * Math.sin((2 * Math.PI * 240 * i) / sr);
    }

    const lane = MultiSpeakerTurnLevelerEngine.buildSpeakerLevelingAutomationLane({
      trackId: 'trk_shared',
      pcmMono: pcm,
      sampleRate: sr,
      targetRmsDb: -18.0,
      speakerSegments: [
        {
          segmentId: 's1',
          trackId: 'trk_shared',
          speakerId: 'SPEAKER_1',
          classification: 'PRIMARY_SPEECH',
          range: {
            start: TimeMath.secondsToFlicks(0.5),
            end: TimeMath.secondsToFlicks(1.5),
          },
          confidence: 0.96,
          manuallyVerifiedByUser: false,
        },
        {
          segmentId: 's2',
          trackId: 'trk_shared',
          speakerId: 'SPEAKER_2',
          classification: 'PRIMARY_SPEECH',
          range: {
            start: TimeMath.secondsToFlicks(2.5),
            end: TimeMath.secondsToFlicks(3.5),
          },
          confidence: 0.94,
          manuallyVerifiedByUser: false,
        },
      ],
    });

    const gainAtLoudSpeaker = TimelineAutomationEngine.evaluateAtFlicks(
      lane,
      TimeMath.secondsToFlicks(1.0),
    );
    const gainAtQuietSpeaker = TimelineAutomationEngine.evaluateAtFlicks(
      lane,
      TimeMath.secondsToFlicks(3.0),
    );

    assert.ok(gainAtLoudSpeaker < -5.0, 'Loud speaker turn must be attenuated');
    assert.ok(gainAtQuietSpeaker > 8.0, 'Quiet speaker turn must be boosted');
  });
});
