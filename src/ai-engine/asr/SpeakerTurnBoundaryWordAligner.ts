/**
 * @file src/ai-engine/asr/SpeakerTurnBoundaryWordAligner.ts
 * @description Section 137: Exact Word-to-Speaker-Turn Boundary Aligner for Multi-Speaker Persian ASR.
 *              Resolves boundary spillover between ASR word timestamps and Diarization segments using
 *              acoustic overlap ratios, filters out CROSSTALK_MIC_BLEED, applies Viterbi-style single-word
 *              island smoothing, and groups words into clean SpeakerTurns.
 */

import { TimedPersianToken } from '../PersianTextNormalizer';
import {
  SpeakerId,
  SpeakerTimelineSegment,
} from '../MultiSpeakerDiarizationAndCrosstalkEngine';
import { TimeMath, TimeRange } from '../../contracts/timebase.contract';

export interface SpeakerAttributedToken extends TimedPersianToken {
  readonly assignedSpeakerId: SpeakerId;
  readonly attributionConfidence: number;
  readonly isOverlappingSpeech: boolean;
  readonly competingSpeakerIds: SpeakerId[];
}

export interface AlignedSpeakerTurn {
  readonly turnIndex: number;
  readonly speakerId: SpeakerId;
  readonly range: TimeRange;
  readonly tokens: SpeakerAttributedToken[];
  readonly turnDisplayTextFa: string;
  readonly containsOverlappingSpeech: boolean;
}

export class SpeakerTurnBoundaryWordAligner {
  /**
   * 1. Maps timed ASR word tokens onto diarization segments by acoustic overlap ratio,
   *    filters out CROSSTALK_MIC_BLEED, smooths isolated 1-word speaker islands, and builds SpeakerTurns.
   */
  public static alignTokensToSpeakerTurns(
    tokens: TimedPersianToken[],
    speakerSegments: SpeakerTimelineSegment[],
    options?: {
      overlapCompetingMinRatio?: number; // Default 0.30 (if secondary speaker overlaps >= 30% of word duration)
      maxNearestSegmentSnapMs?: number;  // Default 300ms for VAD boundary words
      mergeShortInterruptionsUnderMs?: number;
    },
  ): {
    attributedTokens: SpeakerAttributedToken[];
    turns: AlignedSpeakerTurn[];
  } {
    if (tokens.length === 0) {
      return { attributedTokens: [], turns: [] };
    }

    const competingMinRatio = options?.overlapCompetingMinRatio ?? 0.3;
    const maxSnapFlicks = TimeMath.secondsToFlicks(
      (options?.maxNearestSegmentSnapMs ?? 300) / 1000,
    );

    // Filter out microphone bleed segments so leaked audio is never attributed to the wrong speaker
    const validSpeechSegments = speakerSegments
      .filter((s) => s.classification !== 'CROSSTALK_MIC_BLEED')
      .sort((a, b) => a.range.start - b.range.start);

    const attributedTokens: SpeakerAttributedToken[] = tokens.map((tok) => {
      const tokDur = Math.max(1, tok.range.end - tok.range.start);
      const overlapBySpeaker = new Map<SpeakerId, number>();
      let explicitlyMarkedOverlap = false;

      for (const seg of validSpeechSegments) {
        if (seg.range.end <= tok.range.start) continue;
        if (seg.range.start >= tok.range.end) break;

        const overlap =
          Math.min(tok.range.end, seg.range.end) -
          Math.max(tok.range.start, seg.range.start);
        if (overlap > 0) {
          overlapBySpeaker.set(
            seg.speakerId,
            (overlapBySpeaker.get(seg.speakerId) ?? 0) + overlap,
          );
          if (seg.classification === 'OVERLAPPING_SPEECH') {
            explicitlyMarkedOverlap = true;
          }
        }
      }

      if (overlapBySpeaker.size > 0) {
        const sortedSpeakers = Array.from(overlapBySpeaker.entries()).sort(
          (a, b) => b[1] - a[1],
        );
        const [primarySpeaker, primaryOverlap] = sortedSpeakers[0];
        const primaryRatio = primaryOverlap / tokDur;

        const competingSpeakers = sortedSpeakers
          .slice(1)
          .filter(([, ov]) => ov / tokDur >= competingMinRatio)
          .map(([spk]) => spk);

        return {
          ...tok,
          assignedSpeakerId: primarySpeaker,
          attributionConfidence: Number(Math.min(0.99, primaryRatio).toFixed(2)),
          isOverlappingSpeech:
            explicitlyMarkedOverlap || competingSpeakers.length > 0,
          competingSpeakerIds: competingSpeakers,
        };
      }

      // If no direct overlap exists, snap to the nearest valid speech segment within maxNearestSegmentSnapMs
      let nearestSpeaker: SpeakerId = 'UNKNOWN_SPEAKER';
      let minDist = maxSnapFlicks + 1;

      for (const seg of validSpeechSegments) {
        const dist =
          tok.range.end <= seg.range.start
            ? seg.range.start - tok.range.end
            : tok.range.start - seg.range.end;
        if (dist >= 0 && dist < minDist) {
          minDist = dist;
          nearestSpeaker = seg.speakerId;
        }
      }

      return {
        ...tok,
        assignedSpeakerId: nearestSpeaker,
        attributionConfidence:
          nearestSpeaker === 'UNKNOWN_SPEAKER' ? 0.3 : 0.65,
        isOverlappingSpeech: false,
        competingSpeakerIds: [],
      };
    });

    // 2. Viterbi-style Island Smoothing: fix isolated single-word misattributions surrounded by the same speaker
    for (let i = 1; i < attributedTokens.length - 1; i++) {
      const prev = attributedTokens[i - 1];
      const curr = attributedTokens[i];
      const next = attributedTokens[i + 1];

      if (
        prev.assignedSpeakerId === next.assignedSpeakerId &&
        curr.assignedSpeakerId !== prev.assignedSpeakerId &&
        !curr.isOverlappingSpeech &&
        curr.attributionConfidence < 0.75
      ) {
        attributedTokens[i] = {
          ...curr,
          assignedSpeakerId: prev.assignedSpeakerId,
          attributionConfidence: 0.7,
        };
      }
    }

    // 3. Aggregate contiguous same-speaker tokens into discrete SpeakerTurns
    const turns: AlignedSpeakerTurn[] = [];
    let currentTurnTokens: SpeakerAttributedToken[] = [];

    const flushTurn = () => {
      if (currentTurnTokens.length === 0) return;
      const speakerId = currentTurnTokens[0].assignedSpeakerId;
      turns.push({
        turnIndex: turns.length,
        speakerId,
        range: {
          start: currentTurnTokens[0].range.start,
          end: currentTurnTokens[currentTurnTokens.length - 1].range.end,
        },
        tokens: currentTurnTokens,
        turnDisplayTextFa: currentTurnTokens.map((t) => t.displayText).join(' '),
        containsOverlappingSpeech: currentTurnTokens.some(
          (t) => t.isOverlappingSpeech,
        ),
      });
      currentTurnTokens = [];
    };

    for (const tok of attributedTokens) {
      if (
        currentTurnTokens.length > 0 &&
        currentTurnTokens[0].assignedSpeakerId !== tok.assignedSpeakerId
      ) {
        flushTurn();
      }
      currentTurnTokens.push(tok);
    }
    flushTurn();

    return { attributedTokens, turns };
  }
}
