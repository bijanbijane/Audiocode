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
        const startFinite = Number.isFinite(clip.timelineRange.start);
        const endFinite = Number.isFinite(clip.timelineRange.end);
        const durationFlicks =
          startFinite && endFinite ? clip.timelineRange.end - clip.timelineRange.start : Number.NaN;
        const safeStartSec = startFinite
          ? Number(TimeMath.flicksToSeconds(clip.timelineRange.start).toFixed(3))
          : 0;

        // 1. Orphan micro-sliver clips (< 15ms) or non-finite corrupted timeline range
        if (!Number.isFinite(durationFlicks) || durationFlicks < minValidClipFlicks) {
          const msLabel = Number.isFinite(durationFlicks)
            ? Math.round(TimeMath.flicksToSeconds(durationFlicks) * 1000)
            : 0;
          issues.push({
            issueCode: 'ORPHAN_MICRO_SLIVER_CLIP',
            trackId: track.id,
            clipId: clip.id,
            timeSeconds: safeStartSec,
            autoHealable: true,
            messageFa: `خردهکلیپ بسیار کوتاه (${msLabel}ms) شناسایی شد که ممکن است صدای تقه ایجاد کند.`,
          });
        }

        if (i < sortedClips.length - 1) {
          const nextClip = sortedClips[i + 1];
          const nextStartFinite = Number.isFinite(nextClip.timelineRange.start);

          // 2. Overlapping timeline clips
          if (endFinite && nextStartFinite && clip.timelineRange.end > nextClip.timelineRange.start) {
            issues.push({
              issueCode: 'OVERLAPPING_TIMELINE_CLIPS',
              trackId: track.id,
              clipId: clip.id,
              timeSeconds: Number(TimeMath.flicksToSeconds(clip.timelineRange.end).toFixed(3)),
              autoHealable: true,
              messageFa: 'همپوشانی زمانی بدون تفکیک مرز بین دو کلیپ متوالی شناسایی شد.',
            });
          }

          // 3. Butt-cut boundary missing protective micro-fade (also catches NaN/negative fade values)
          const isButtCut =
            endFinite && nextStartFinite && clip.timelineRange.end === nextClip.timelineRange.start;
          const fadeOutOk =
            Number.isFinite(clip.fadeOutFlicks) && clip.fadeOutFlicks >= minMicroFadeFlicks;
          const fadeInOk =
            Number.isFinite(nextClip.fadeInFlicks) && nextClip.fadeInFlicks >= minMicroFadeFlicks;
          if (isButtCut && (!fadeOutOk || !fadeInOk)) {
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
          const gapFlicks =
            endFinite && nextStartFinite
              ? nextClip.timelineRange.start - clip.timelineRange.end
              : Number.POSITIVE_INFINITY;
          const gainDeltaDb = Math.abs(clip.gainDb - nextClip.gainDb);
          if (
            gapFlicks <= minValidClipFlicks &&
            (!Number.isFinite(gainDeltaDb) || gainDeltaDb > MAX_SAFE_ADJACENT_GAIN_JUMP_DB)
          ) {
            const deltaText = Number.isFinite(gainDeltaDb) ? gainDeltaDb.toFixed(1) : 'نامعتبر';
            issues.push({
              issueCode: 'LOUDNESS_GAIN_DISCONTINUITY',
              trackId: track.id,
              clipId: nextClip.id,
              timeSeconds: Number(
                TimeMath.flicksToSeconds(nextClip.timelineRange.start).toFixed(3),
              ),
              autoHealable: false,
              messageFa: `پرش ناگهانی بلندی صدا (${deltaText} dB) بین دو کلیپ مجاور شناسایی شد.`,
            });
          }
        }
      }

      if (track.syncGroupId && sortedClips.length > 0) {
        const trackMaxEnd = sortedClips.reduce(
          (maxEnd, c) =>
            Number.isFinite(c.timelineRange.end) ? Math.max(maxEnd, c.timelineRange.end) : maxEnd,
          0,
        );
        const list = syncGroupMaxEnd.get(track.syncGroupId) ?? [];
        list.push({ trackId: track.id, endFlicks: trackMaxEnd });
        syncGroupMaxEnd.set(track.syncGroupId, list);
      }
    }

    // 5. Multi-track Sync-Lock duration drift check (compare against group max so track[0] drift is never masked)
    for (const entries of syncGroupMaxEnd.values()) {
      if (entries.length <= 1) continue;
      let maxEnd = entries[0].endFlicks;
      let minEnd = entries[0].endFlicks;
      for (const entry of entries) {
        if (entry.endFlicks > maxEnd) maxEnd = entry.endFlicks;
        if (entry.endFlicks < minEnd) minEnd = entry.endFlicks;
      }
      if (maxEnd - minEnd <= maxSyncDriftFlicks) continue;

      for (const entry of entries) {
        if (maxEnd - entry.endFlicks > maxSyncDriftFlicks) {
          issues.push({
            issueCode: 'SYNC_GROUP_DURATION_DRIFT',
            trackId: entry.trackId,
            timeSeconds: Number(TimeMath.flicksToSeconds(entry.endFlicks).toFixed(3)),
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
   * - Removes orphan <15ms sliver clips and corrupted non-finite ranges
   * - Resolves clip overlaps by trimming earlier clip's end to next clip's start
   * - Enforces protective >= 8ms micro-fades clamped within clip length and sanitizes NaN fades/gain
   */
  public static autoHealTimelineIssues(doc: ProjectDocument): ProjectDocument {
    const minValidClipFlicks = TimeMath.secondsToFlicks(MIN_VALID_CLIP_SECONDS);
    const defaultMicroFadeFlicks = TimeMath.secondsToFlicks(AUTO_HEAL_MICRO_FADE_SECONDS);

    const healedTracks: TimelineTrack[] = doc.tracks.map((track) => {
      const sorted = [...track.clips]
        .filter(
          (c) =>
            Number.isFinite(c.timelineRange.start) &&
            Number.isFinite(c.timelineRange.end) &&
            c.timelineRange.end - c.timelineRange.start >= minValidClipFlicks,
        )
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
        const maxHalfFade = Math.floor(clipLen / 2);
        const safeFadeFloor = Math.min(defaultMicroFadeFlicks, maxHalfFade);
        const safeFadeIn =
          Number.isFinite(clip.fadeInFlicks) && clip.fadeInFlicks > 0 ? clip.fadeInFlicks : 0;
        const safeFadeOut =
          Number.isFinite(clip.fadeOutFlicks) && clip.fadeOutFlicks > 0 ? clip.fadeOutFlicks : 0;
        const safeGainDb = Number.isFinite(clip.gainDb) ? clip.gainDb : 0;
        return {
          ...clip,
          gainDb: safeGainDb,
          fadeInFlicks: Math.min(Math.max(safeFadeIn, safeFadeFloor), maxHalfFade),
          fadeOutFlicks: Math.min(Math.max(safeFadeOut, safeFadeFloor), maxHalfFade),
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
