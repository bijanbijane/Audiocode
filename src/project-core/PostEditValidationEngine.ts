import {
  ClipId,
  ProjectDocument,
  TimelineClip,
  TimelineTrack,
  TrackId,
} from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

export type PostEditIssueCode =
  | 'ORPHAN_MICRO_SLIVER_CLIP'     // Microscopic clip < 15ms causing audible tick/click
  | 'OVERLAPPING_TIMELINE_CLIPS'   // Adjacent clips overlap without explicit split resolution
  | 'MISSING_BOUNDARY_MICRO_FADE'  // Direct butt-cut lacking >= 4ms micro-fade protection
  | 'LOUDNESS_GAIN_DISCONTINUITY'  // Sudden > 6dB gain jump across adjacent clips
  | 'SYNC_GROUP_DURATION_DRIFT';   // Sync-locked sibling tracks diverged in total end position

export interface PostEditValidationIssue {
  readonly issueCode: PostEditIssueCode;
  readonly trackId: TrackId;
  readonly clipId?: ClipId;
  readonly timeSeconds: number;
  readonly autoHealable: boolean;
  readonly messageFa: string;
}

const MIN_VALID_CLIP_SECONDS = 0.015;
const MIN_MICRO_FADE_SECONDS = 0.004;
const AUTO_HEAL_MICRO_FADE_SECONDS = 0.008;
const MAX_SAFE_ADJACENT_GAIN_JUMP_DB = 6.0;
const MAX_SYNC_DRIFT_SECONDS = 0.005;

/**
 * Post-Edit Timeline Validation & Auto-Heal Engine (Section 7 Domain 5 & Stage 12 Section 66)
 * Detects micro-slivers (<15ms), un-crossfaded overlaps, missing boundary micro-fades,
 * abrupt loudness gain discontinuities (>6dB), and sync-group drift across multi-track sessions.
 */
export class PostEditValidationEngine {
  public static validateProjectTimeline(doc: ProjectDocument): {
    isValid: boolean;
    issues: PostEditValidationIssue[];
  } {
    const issues: PostEditValidationIssue[] = [];
    const minValidClipFlicks = TimeMath.secondsToFlicks(MIN_VALID_CLIP_SECONDS);
    const minMicroFadeFlicks = TimeMath.secondsToFlicks(MIN_MICRO_FADE_SECONDS);
    const maxSyncDriftFlicks = TimeMath.secondsToFlicks(MAX_SYNC_DRIFT_SECONDS);

    const syncGroupMaxEnd = new Map<string, { trackId: TrackId; endFlicks: number }[]>();

    for (const track of doc.tracks) {
      const sortedClips = [...track.clips].sort(
        (a, b) => a.timelineRange.start - b.timelineRange.start,
      );

      for (let i = 0; i < sortedClips.length; i++) {
        const clip = sortedClips[i];
        const durationFlicks = clip.timelineRange.end - clip.timelineRange.start;

        // 1. Orphan micro-sliver clips (< 15ms)
        if (durationFlicks < minValidClipFlicks) {
          issues.push({
            issueCode: 'ORPHAN_MICRO_SLIVER_CLIP',
            trackId: track.id,
            clipId: clip.id,
            timeSeconds: Number(TimeMath.flicksToSeconds(clip.timelineRange.start).toFixed(3)),
            autoHealable: true,
            messageFa: `خردهکلیپ بسیار کوتاه (${Math.round(TimeMath.flicksToSeconds(durationFlicks) * 1000)}ms) شناسایی شد که ممکن است صدای تقه ایجاد کند.`,
          });
        }

        if (i < sortedClips.length - 1) {
          const nextClip = sortedClips[i + 1];

          // 2. Overlapping timeline clips
          if (clip.timelineRange.end > nextClip.timelineRange.start) {
            issues.push({
              issueCode: 'OVERLAPPING_TIMELINE_CLIPS',
              trackId: track.id,
              clipId: clip.id,
              timeSeconds: Number(TimeMath.flicksToSeconds(clip.timelineRange.end).toFixed(3)),
              autoHealable: true,
              messageFa: 'همپوشانی زمانی بدون تفکیک مرز بین دو کلیپ متوالی شناسایی شد.',
            });
          }

          // 3. Butt-cut boundary missing protective micro-fade
          const isButtCut = clip.timelineRange.end === nextClip.timelineRange.start;
          if (
            isButtCut &&
            (clip.fadeOutFlicks < minMicroFadeFlicks ||
              nextClip.fadeInFlicks < minMicroFadeFlicks)
          ) {
            issues.push({
              issueCode: 'MISSING_BOUNDARY_MICRO_FADE',
              trackId: track.id,
              clipId: clip.id,
              timeSeconds: Number(TimeMath.flicksToSeconds(clip.timelineRange.end).toFixed(3)),
              autoHealable: true,
              messageFa: 'نقطه اتصال مستقیم دو کلیپ فاقد Micro-Fade محافظ کلیک صوتی است.',
            });
          }

          // 4. Abrupt gain discontinuity at closely adjoining cut
          const gapFlicks = nextClip.timelineRange.start - clip.timelineRange.end;
          if (
            gapFlicks <= minValidClipFlicks &&
            Math.abs(clip.gainDb - nextClip.gainDb) > MAX_SAFE_ADJACENT_GAIN_JUMP_DB
          ) {
            issues.push({
              issueCode: 'LOUDNESS_GAIN_DISCONTINUITY',
              trackId: track.id,
              clipId: nextClip.id,
              timeSeconds: Number(
                TimeMath.flicksToSeconds(nextClip.timelineRange.start).toFixed(3),
              ),
              autoHealable: false,
              messageFa: `پرش ناگهانی بلندی صدا (${Math.abs(clip.gainDb - nextClip.gainDb).toFixed(1)} dB) بین دو کلیپ مجاور شناسایی شد.`,
            });
          }
        }
      }

      if (track.syncGroupId && sortedClips.length > 0) {
        const trackMaxEnd = sortedClips.reduce(
          (maxEnd, c) => Math.max(maxEnd, c.timelineRange.end),
          0,
        );
        const list = syncGroupMaxEnd.get(track.syncGroupId) ?? [];
        list.push({ trackId: track.id, endFlicks: trackMaxEnd });
        syncGroupMaxEnd.set(track.syncGroupId, list);
      }
    }

    // 5. Multi-track Sync-Lock duration drift check
    for (const entries of syncGroupMaxEnd.values()) {
      if (entries.length <= 1) continue;
      const refEnd = entries[0].endFlicks;
      for (let k = 1; k < entries.length; k++) {
        const diffFlicks = Math.abs(entries[k].endFlicks - refEnd);
        if (diffFlicks > maxSyncDriftFlicks) {
          issues.push({
            issueCode: 'SYNC_GROUP_DURATION_DRIFT',
            trackId: entries[k].trackId,
            timeSeconds: Number(TimeMath.flicksToSeconds(entries[k].endFlicks).toFixed(3)),
            autoHealable: false,
            messageFa: 'اختلاف طول زمانی بین ترک‌های هم‌گروه شناسایی شد (خطر به‌هم‌ریختن سینک گویندگان).',
          });
        }
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
    };
  }

  /**
   * Non-destructively heals boundary errors:
   * - Removes orphan <15ms sliver clips
   * - Resolves clip overlaps by trimming earlier clip's end to next clip's start
   * - Enforces protective >= 8ms micro-fades clamped within clip length
   */
  public static autoHealTimelineIssues(doc: ProjectDocument): ProjectDocument {
    const minValidClipFlicks = TimeMath.secondsToFlicks(MIN_VALID_CLIP_SECONDS);
    const defaultMicroFadeFlicks = TimeMath.secondsToFlicks(AUTO_HEAL_MICRO_FADE_SECONDS);

    const healedTracks: TimelineTrack[] = doc.tracks.map((track) => {
      const sorted = [...track.clips]
        .filter((c) => c.timelineRange.end - c.timelineRange.start >= minValidClipFlicks)
        .sort((a, b) => a.timelineRange.start - b.timelineRange.start);

      const nonOverlapping: TimelineClip[] = [];
      for (let i = 0; i < sorted.length; i++) {
        let current = sorted[i];
        if (i < sorted.length - 1) {
          const next = sorted[i + 1];
          if (current.timelineRange.end > next.timelineRange.start) {
            const trimmedEnd = Math.max(current.timelineRange.start, next.timelineRange.start);
            const trimmedDuration = trimmedEnd - current.timelineRange.start;
            current = {
              ...current,
              sourceRange: {
                start: current.sourceRange.start,
                end: Math.min(current.sourceRange.end, current.sourceRange.start + trimmedDuration),
              },
              timelineRange: {
                start: current.timelineRange.start,
                end: trimmedEnd,
              },
            };
          }
        }
        if (current.timelineRange.end - current.timelineRange.start >= minValidClipFlicks) {
          nonOverlapping.push(current);
        }
      }

      const fadeProtectedClips: TimelineClip[] = nonOverlapping.map((clip) => {
        const clipLen = clip.timelineRange.end - clip.timelineRange.start;
        const safeFadeCap = Math.min(defaultMicroFadeFlicks, Math.floor(clipLen / 2));
        return {
          ...clip,
          fadeInFlicks: Math.max(clip.fadeInFlicks, safeFadeCap),
          fadeOutFlicks: Math.max(clip.fadeOutFlicks, safeFadeCap),
        };
      });

      return {
        ...track,
        clips: fadeProtectedClips,
      };
    });

    return {
      ...doc,
      revision: doc.revision + 1,
      tracks: healedTracks,
    };
  }
}
