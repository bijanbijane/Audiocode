import { TimedPersianToken } from '../PersianTextNormalizer';
import { SpeakerTimelineSegment } from '../MultiSpeakerDiarizationAndCrosstalkEngine';
import { DetectedSpeechIssue } from '../PersianDisfluencyEngine';
import { TimeMath } from '../../contracts/timebase.contract';

export interface TextGridInterval {
  readonly xmin: number;
  readonly xmax: number;
  readonly text: string;
}

export class PraatTextGridAndLinguisticExporter {
  /**
   * 1. Exports a standard Praat TextGrid file with up to 3 synchronized IntervalTiers:
   * - Tier 1: Timed Persian words ("words")
   * - Tier 2: Speaker segments and overlaps ("speakers")
   * - Tier 3: Detected speech disfluencies and pauses ("disfluencies")
   */
  public static exportToPraatTextGrid(params: {
    totalAudioDurationSec: number;
    tokens: TimedPersianToken[];
    speakerSegments?: SpeakerTimelineSegment[];
    disfluencyIssues?: DetectedSpeechIssue[];
  }): string {
    const xmax = Math.max(
      params.totalAudioDurationSec,
      params.tokens.length > 0
        ? TimeMath.flicksToSeconds(params.tokens[params.tokens.length - 1].range.end)
        : 0.01
    );

    const tiers: { name: string; intervals: TextGridInterval[] }[] = [];

    // Tier 1: Persian words (with silence gaps filled for strict interval contiguity)
    const rawWordIntervals = params.tokens.map((t) => ({
      xmin: TimeMath.flicksToSeconds(t.range.start),
      xmax: TimeMath.flicksToSeconds(t.range.end),
      text: t.displayText,
    }));
    tiers.push({
      name: 'words',
      intervals: this.makeStrictlyContiguousIntervals(rawWordIntervals, xmax),
    });

    // Tier 2: Speaker segments
    if (params.speakerSegments && params.speakerSegments.length > 0) {
      const rawSpkIntervals = params.speakerSegments.map((s) => ({
        xmin: TimeMath.flicksToSeconds(s.range.start),
        xmax: TimeMath.flicksToSeconds(s.range.end),
        text:
          s.classification === 'CROSSTALK_MIC_BLEED'
            ? `${s.speakerId}[BLEED]`
            : s.speakerId,
      }));
      tiers.push({
        name: 'speakers',
        intervals: this.makeStrictlyContiguousIntervals(rawSpkIntervals, xmax),
      });
    }

    // Tier 3: Disfluency issues
    if (params.disfluencyIssues && params.disfluencyIssues.length > 0) {
      const rawIssueIntervals = params.disfluencyIssues.map((iss) => ({
        xmin: TimeMath.flicksToSeconds(iss.targetRange.start),
        xmax: TimeMath.flicksToSeconds(iss.targetRange.end),
        text: `${iss.type}: ${iss.displayExcerpt}`,
      }));
      tiers.push({
        name: 'disfluencies',
        intervals: this.makeStrictlyContiguousIntervals(rawIssueIntervals, xmax),
      });
    }

    const lines: string[] = [
      `File type = "ooTextFile"`,
      `Object class = "TextGrid"`,
      ``,
      `xmin = 0`,
      `xmax = ${xmax.toFixed(6)}`,
      `tiers? <exists>`,
      `size = ${tiers.length}`,
      `item []:`,
    ];

    tiers.forEach((tier, tIdx) => {
      lines.push(
        `    item [${tIdx + 1}]:`,
        `        class = "IntervalTier"`,
        `        name = "${this.escapePraatString(tier.name)}"`,
        `        xmin = 0`,
        `        xmax = ${xmax.toFixed(6)}`,
        `        intervals: size = ${tier.intervals.length}`
      );

      tier.intervals.forEach((inv, iIdx) => {
        lines.push(
          `        intervals [${iIdx + 1}]:`,
          `            xmin = ${inv.xmin.toFixed(6)}`,
          `            xmax = ${inv.xmax.toFixed(6)}`,
          `            text = "${this.escapePraatString(inv.text)}"`
        );
      });
    });

    return lines.join('\n') + '\n';
  }

  /**
   * 2. Exports NIST CTM (Conversation Time-Marked) format for sclite ASR evaluation tools.
   * Format: <utterance_id> <channel> <start_sec> <duration_sec> <word> <confidence>
   */
  public static exportToNistCtm(
    utteranceId: string,
    tokens: TimedPersianToken[],
    channelNumber: number = 1
  ): string {
    return tokens
      .map((tok) => {
        const startSec = TimeMath.flicksToSeconds(tok.range.start);
        const durSec = Math.max(
          0.01,
          TimeMath.flicksToSeconds(tok.range.end - tok.range.start)
        );
        return `${utteranceId} ${channelNumber} ${startSec.toFixed(3)} ${durSec.toFixed(
          3
        )} ${tok.normalizedText} ${tok.confidence.toFixed(3)}`;
      })
      .join('\n');
  }

  /**
   * Guarantees strict mathematical contiguity of intervals from 0 to xmax (required by Praat).
   */
  private static makeStrictlyContiguousIntervals(
    raw: TextGridInterval[],
    totalDurationSec: number
  ): TextGridInterval[] {
    const sorted = [...raw]
      .filter((r) => r.xmax > r.xmin)
      .sort((a, b) => a.xmin - b.xmin);

    const contiguous: TextGridInterval[] = [];
    let cursor = 0;

    for (const item of sorted) {
      const start = Math.max(cursor, Math.min(totalDurationSec, item.xmin));
      const end = Math.max(start, Math.min(totalDurationSec, item.xmax));
      if (end <= start) continue;

      if (start - cursor > 0.0005) {
        contiguous.push({ xmin: cursor, xmax: start, text: '' });
      }
      contiguous.push({
        xmin: start,
        xmax: end,
        text: item.text,
      });
      cursor = end;
    }

    if (totalDurationSec - cursor > 0.0005) {
      contiguous.push({ xmin: cursor, xmax: totalDurationSec, text: '' });
    }

    if (contiguous.length === 0) {
      contiguous.push({ xmin: 0, xmax: totalDurationSec, text: '' });
    }

    return contiguous;
  }

  private static escapePraatString(str: string): string {
    return str.replace(/"/g, '""');
  }
}
