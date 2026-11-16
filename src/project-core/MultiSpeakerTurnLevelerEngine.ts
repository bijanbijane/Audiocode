import { SpeakerTimelineSegment } from '../ai-engine/MultiSpeakerDiarizationAndCrosstalkEngine';
import {
  AutomationKeyframe,
  AutomationLane,
} from './TimelineAutomationEngine';
import { SampleRate, TimeMath } from '../contracts/timebase.contract';

/**
 * Multi-Speaker Turn Leveler Engine on a Single Track
 * (Section 82 — Architecture Doc Sections 2.4, 33 & 38)
 * Combines Speaker Diarization segments with S-Curve Cosine Gain Automation to equalize
 * loud and quiet speakers on a single shared-microphone track toward a uniform target RMS/LUFS.
 */
export class MultiSpeakerTurnLevelerEngine {
  /**
   * Builds a smooth S-Curve Gain AutomationLane that levels each speaker turn toward targetRmsDb.
   */
  public static buildSpeakerLevelingAutomationLane(params: {
    trackId: string;
    pcmMono: Float32Array;
    sampleRate: SampleRate;
    speakerSegments: readonly SpeakerTimelineSegment[];
    targetRmsDb?: number; // Default -18.0 dBFS (~ -16 LUFS speech)
    maxBoostDb?: number;  // Default +12.0 dB
    maxCutDb?: number;    // Default -12.0 dB
  }): AutomationLane {
    const targetDb = params.targetRmsDb ?? -18.0;
    const maxBoost = params.maxBoostDb ?? 12.0;
    const maxCut = params.maxCutDb ?? -12.0;
    const transitionFlicks = TimeMath.secondsToFlicks(0.08); // 80ms S-Curve transition

    const keyframes: AutomationKeyframe[] = [];

    for (const seg of params.speakerSegments) {
      if (seg.classification !== 'PRIMARY_SPEECH') continue;

      const startSample = TimeMath.flicksToSamplesFloor(
        seg.range.start,
        params.sampleRate,
      );
      const endSample = Math.min(
        params.pcmMono.length,
        TimeMath.flicksToSamplesFloor(seg.range.end, params.sampleRate),
      );
      if (endSample - startSample < params.sampleRate * 0.25) continue;

      const segRmsDb = this.computeActiveSpeechRmsDb(
        params.pcmMono,
        startSample,
        endSample,
      );
      if (segRmsDb <= -55.0) continue;

      const rawCorrectionDb = targetDb - segRmsDb;
      const clampedGainDb = Number(
        Math.max(maxCut, Math.min(maxBoost, rawCorrectionDb)).toFixed(2),
      );

      const rampInStart = Math.max(0, seg.range.start - transitionFlicks);
      const rampOutEnd = seg.range.end + transitionFlicks;

      keyframes.push(
        { timeFlicks: rampInStart, value: 0.0, curveToNext: 'S_CURVE_COSINE' },
        { timeFlicks: seg.range.start, value: clampedGainDb, curveToNext: 'LINEAR' },
        { timeFlicks: seg.range.end, value: clampedGainDb, curveToNext: 'S_CURVE_COSINE' },
        { timeFlicks: rampOutEnd, value: 0.0, curveToNext: 'LINEAR' },
      );
    }

    return {
      laneId: `speaker_leveler_${params.trackId}`,
      targetNodeOrTrackId: params.trackId,
      parameterName: 'GAIN_DB',
      defaultValue: 0.0,
      keyframes: keyframes.sort((a, b) => a.timeFlicks - b.timeFlicks),
    };
  }

  private static computeActiveSpeechRmsDb(
    pcm: Float32Array,
    start: number,
    end: number,
  ): number {
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const s = pcm[i];
      if (Math.abs(s) > 0.005) {
        sumSq += s * s;
        count++;
      }
    }
    if (count === 0) return -70.0;
    return 10 * Math.log10(sumSq / count + 1e-12);
  }
}
