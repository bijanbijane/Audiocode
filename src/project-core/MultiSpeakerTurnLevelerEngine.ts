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
    const targetDb =
      params.targetRmsDb !== undefined && Number.isFinite(params.targetRmsDb)
        ? params.targetRmsDb
        : -18.0;
    const maxBoost =
      params.maxBoostDb !== undefined && Number.isFinite(params.maxBoostDb)
        ? params.maxBoostDb
        : 12.0;
    const maxCut =
      params.maxCutDb !== undefined && Number.isFinite(params.maxCutDb)
        ? params.maxCutDb
        : -12.0;
    const loGain = Math.min(maxCut, maxBoost);
    const hiGain = Math.max(maxCut, maxBoost);
    const transitionFlicks = TimeMath.secondsToFlicks(0.08); // 80ms S-Curve transition

    if (
      !Number.isFinite(params.sampleRate) ||
      params.sampleRate <= 0 ||
      params.pcmMono.length === 0
    ) {
      return {
        laneId: `speaker_leveler_${params.trackId}`,
        targetNodeOrTrackId: params.trackId,
        parameterName: 'GAIN_DB',
        defaultValue: 0.0,
        keyframes: [],
      };
    }

    const sortedSegments = [...params.speakerSegments]
      .filter(
        (seg) =>
          seg.classification === 'PRIMARY_SPEECH' &&
          Number.isFinite(seg.range.start) &&
          Number.isFinite(seg.range.end) &&
          seg.range.end > seg.range.start,
      )
      .sort((a, b) => a.range.start - b.range.start);

    const turns: Array<{ start: number; end: number; gainDb: number }> = [];

    for (const seg of sortedSegments) {
      const clampedStartFlicks = Math.max(0, seg.range.start);
      const effectiveStartFlicks =
        turns.length > 0
          ? Math.max(clampedStartFlicks, turns[turns.length - 1].end)
          : clampedStartFlicks;
      const effectiveEndFlicks = seg.range.end;
      if (effectiveEndFlicks <= effectiveStartFlicks) continue;

      const startSample = Math.max(
        0,
        Math.min(
          params.pcmMono.length,
          TimeMath.flicksToSamplesFloor(effectiveStartFlicks, params.sampleRate),
        ),
      );
      const endSample = Math.max(
        startSample,
        Math.min(
          params.pcmMono.length,
          TimeMath.flicksToSamplesFloor(effectiveEndFlicks, params.sampleRate),
        ),
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
        Math.max(loGain, Math.min(hiGain, rawCorrectionDb)).toFixed(2),
      );

      turns.push({
        start: effectiveStartFlicks,
        end: effectiveEndFlicks,
        gainDb: clampedGainDb,
      });
    }

    const keyframes: AutomationKeyframe[] = [];

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const prev = i > 0 ? turns[i - 1] : null;
      const next = i + 1 < turns.length ? turns[i + 1] : null;

      if (!prev) {
        const rampInStart = Math.max(0, turn.start - transitionFlicks);
        if (rampInStart < turn.start) {
          keyframes.push({
            timeFlicks: rampInStart,
            value: 0.0,
            curveToNext: 'S_CURVE_COSINE',
          });
        }
        keyframes.push({
          timeFlicks: turn.start,
          value: turn.gainDb,
          curveToNext: 'LINEAR',
        });
      } else {
        const gapFromPrev = turn.start - prev.end;
        if (gapFromPrev >= 2 * transitionFlicks) {
          keyframes.push(
            {
              timeFlicks: turn.start - transitionFlicks,
              value: 0.0,
              curveToNext: 'S_CURVE_COSINE',
            },
            {
              timeFlicks: turn.start,
              value: turn.gainDb,
              curveToNext: 'LINEAR',
            },
          );
        } else if (gapFromPrev > 0) {
          // Direct smooth S-Curve handoff from prev.gainDb at prev.end to turn.gainDb at turn.start
          keyframes.push({
            timeFlicks: turn.start,
            value: turn.gainDb,
            curveToNext: 'LINEAR',
          });
        } else {
          // Back-to-back turns (gap === 0): smooth handoff without duplicate timestamp or 0 dB dip
          const handoff = Math.min(
            transitionFlicks,
            Math.max(1, Math.floor((turn.end - turn.start) / 2)),
          );
          if (turn.start + handoff < turn.end) {
            keyframes.push({
              timeFlicks: turn.start + handoff,
              value: turn.gainDb,
              curveToNext: 'LINEAR',
            });
          }
        }
      }

      const gapToNext = next ? next.start - turn.end : Infinity;
      if (!next || gapToNext >= 2 * transitionFlicks) {
        keyframes.push(
          {
            timeFlicks: turn.end,
            value: turn.gainDb,
            curveToNext: 'S_CURVE_COSINE',
          },
          {
            timeFlicks: turn.end + transitionFlicks,
            value: 0.0,
            curveToNext: 'LINEAR',
          },
        );
      } else {
        keyframes.push({
          timeFlicks: turn.end,
          value: turn.gainDb,
          curveToNext: 'S_CURVE_COSINE',
        });
      }
    }

    return {
      laneId: `speaker_leveler_${params.trackId}`,
      targetNodeOrTrackId: params.trackId,
      parameterName: 'GAIN_DB',
      defaultValue: 0.0,
      keyframes,
    };
  }

  private static computeActiveSpeechRmsDb(
    pcm: Float32Array,
    start: number,
    end: number,
  ): number {
    let sumSq = 0;
    let count = 0;
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(pcm.length, end);
    for (let i = safeStart; i < safeEnd; i++) {
      const s = pcm[i];
      if (Number.isFinite(s) && Math.abs(s) > 0.005) {
        sumSq += s * s;
        count++;
      }
    }
    if (count === 0) return -70.0;
    return 10 * Math.log10(sumSq / count + 1e-12);
  }
}
