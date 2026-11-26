import {
  EditTransaction,
  FlickRange,
  PersianWordToken,
  RecommendationActionMode,
  SmartRecommendation,
  TimelineClip,
  Track,
} from '../contracts/v1_2';
import { flicksToSamples, msToFlicks, rangeDurationFlicks, rangesOverlap } from './timebase';

/**
 * Multi-Track Sync-Locked Non-Destructive Timeline Engine (v1.2 Spec Sections 24 & 25)
 * - Enforces Sync-Lock Protection: Ripple Cut only shifts time when ALL synced tracks are silent in [start, end).
 * - Automatically falls back to In-Place Range Suppression (Room Tone Fill) when another track has active speech.
 * - Synchronizes PersianWordToken timestamps and SmartRecommendation ranges across all edits and Undo/Redo.
 */

export function cloneTracks(tracks: Track[]): Track[] {
  return tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => ({
      ...c,
      timelineRange: { ...c.timelineRange },
    })),
  }));
}

export function cloneTokens(tokens: PersianWordToken[]): PersianWordToken[] {
  return tokens.map((tok) => ({
    ...tok,
    range: { ...tok.range },
  }));
}

export function cloneRecommendations(recs: SmartRecommendation[]): SmartRecommendation[] {
  return recs.map((r) => ({
    ...r,
    range: { ...r.range },
    boundary: {
      ...r.boundary,
      rawRange: { ...r.boundary.rawRange },
      snappedRange: { ...r.boundary.snappedRange },
    },
  }));
}

/**
 * Measures peak RMS energy (dBFS) on a track within `range` using raw PCM sources when available.
 * Used as an acoustic fallback when a peer track has active speech without ASR tokens.
 */
function measureTrackAcousticRmsDbfs(
  track: Track,
  range: FlickRange,
  pcmSources: Record<string, Float32Array>,
  sampleRate: number,
): number {
  let sumSq = 0;
  let totalSamples = 0;

  for (const clip of track.clips) {
    if (clip.muted || clip.kind === 'room-tone-fill') continue;
    const src = pcmSources[clip.assetId];
    if (!src || src.length === 0) continue;

    const overlapStart = Math.max(clip.timelineRange.startFlicks, range.startFlicks);
    const overlapEnd = Math.min(clip.timelineRange.endFlicks, range.endFlicks);
    if (overlapEnd <= overlapStart) continue;

    const clipStartSample = flicksToSamples(clip.timelineRange.startFlicks, sampleRate);
    const srcBase = flicksToSamples(clip.sourceStartFlicks, sampleRate);
    const sStart = Math.max(0, srcBase + (flicksToSamples(overlapStart, sampleRate) - clipStartSample));
    const sEnd = Math.min(
      src.length,
      srcBase + (flicksToSamples(overlapEnd, sampleRate) - clipStartSample),
    );

    const step = sEnd - sStart > 4096 ? 4 : 1;
    for (let i = sStart; i < sEnd; i += step) {
      const v = src[i];
      if (Number.isFinite(v)) {
        sumSq += v * v;
        totalSamples++;
      }
    }
  }

  if (totalSamples === 0) return -96;
  const rms = Math.sqrt(sumSq / totalSamples);
  if (rms <= 1e-6) return -96;
  return 20 * Math.log10(rms);
}

/**
 * Generates a bounded deterministic clip ID when splitting/cutting so repeated edits
 * never produce unbounded "-L-R-L-R..." identifier growth.
 */
function makeSplitPieceClipId(
  originalId: string,
  side: 'L' | 'R',
  startFlicks: number,
  endFlicks: number,
): string {
  const rootId = originalId.replace(/(?:-[LR])+$/, '').replace(/-s\d+e\d+$/, '');
  const candidate = `${originalId}-${side}`;
  if (candidate.length <= 48) return candidate;
  return `${rootId.slice(0, 24)}-${side}-s${Math.trunc(startFlicks / 705600)}e${Math.trunc(endFlicks / 705600)}`;
}

/**
 * Determines whether a cut on `targetTrackId` in `cutRange` can safely Ripple Delete
 * or must use In-Place Room Tone Suppression to protect multi-track sync.
 */
export function determineSyncSafeEditMode(
  tracks: Track[],
  targetTrackId: string,
  cutRange: FlickRange,
  tokens: PersianWordToken[],
  pcmSources?: Record<string, Float32Array>,
  sampleRate?: number,
): { mode: RecommendationActionMode; reasonFa: string } {
  const targetTrack = tracks.find((t) => t.id === targetTrackId);
  if (!targetTrack || !targetTrack.syncGroupId) {
    return {
      mode: 'sync-locked-ripple-cut',
      reasonFa: 'تک‌ترک یا خارج از گروه همگام‌سازی — برش زمانی (Ripple Cut) ایمن است.',
    };
  }

  const peerTracks = tracks.filter(
    (t) => t.id !== targetTrackId && t.syncGroupId === targetTrack.syncGroupId,
  );

  for (const peer of peerTracks) {
    if (peer.muted) continue;
    // Check if peer track has active non-disfluency/non-crosstalk speech tokens overlapping cutRange
    const peerActiveToken = tokens.find(
      (tok) =>
        tok.trackId === peer.id &&
        !tok.isCrosstalkSuppressed &&
        rangesOverlap(tok.range, cutRange),
    );
    if (peerActiveToken) {
      return {
        mode: 'in-place-room-tone-suppression',
        reasonFa: `حفاظت سینک چندترک: در این بازه «${peer.speakerLabel}» در حال صحبت است («${peerActiveToken.displayText}»)؛ جایگزینی درجا با Room Tone اعمال می‌شود تا همگام‌سازی ترک‌ها به هم نخورد.`,
      };
    }

    // Acoustic fallback: if peer has no ASR tokens in this window, still protect active audio energy (> -34 dBFS)
    if (pcmSources && sampleRate && sampleRate > 0) {
      const peerRmsDb = measureTrackAcousticRmsDbfs(peer, cutRange, pcmSources, sampleRate);
      if (peerRmsDb > -34) {
        return {
          mode: 'in-place-room-tone-suppression',
          reasonFa: `حفاظت آکوستیک سینک چندترک: در این بازه روی ترک «${peer.speakerLabel}» انرژی صوتی فعال (${peerRmsDb.toFixed(1)} dBFS) تشخیص داده شد؛ جایگزینی درجا با Room Tone اعمال می‌شود.`,
        };
      }
    }
  }

  return {
    mode: 'sync-locked-ripple-cut',
    reasonFa: 'تمام ترک‌های همگام در این بازه ساکت‌اند — برش هم‌زمان قفل‌شده (Sync-Locked Ripple Cut) مجاز است.',
  };
}

/** Removes `[cutRange.startFlicks, cutRange.endFlicks)` from a single track's clips and optionally shifts later clips */
function cutRangeFromClipList(
  clips: TimelineClip[],
  cutRange: FlickRange,
  shiftFollowingClips: boolean,
  replaceWithRoomToneAssetId?: string,
  trackId?: string,
): TimelineClip[] {
  const cutDur = rangeDurationFlicks(cutRange);
  if (cutDur <= 0) {
    return clips.map((c) => ({ ...c, timelineRange: { ...c.timelineRange } }));
  }
  const nextClips: TimelineClip[] = [];

  for (const clip of clips) {
    const r = clip.timelineRange;
    // Case 1: Completely before cutRange
    if (r.endFlicks <= cutRange.startFlicks) {
      nextClips.push({ ...clip, timelineRange: { ...r } });
      continue;
    }

    // Case 2: Completely after cutRange
    if (r.startFlicks >= cutRange.endFlicks) {
      nextClips.push({
        ...clip,
        timelineRange: shiftFollowingClips
          ? {
              startFlicks: r.startFlicks - cutDur,
              endFlicks: r.endFlicks - cutDur,
            }
          : { ...r },
      });
      continue;
    }

    // Case 3: Overlaps cutRange -> split into left/right pieces with protective 10ms micro-fades
    if (r.startFlicks < cutRange.startFlicks) {
      const leftDurMs = (cutRange.startFlicks - r.startFlicks) / 705_600;
      const maxFadeMs = Math.max(0, leftDurMs * 0.45);
      const safeFadeInMs = Math.min(clip.fadeInMs, maxFadeMs);
      const safeFadeOutMs = Math.min(Math.max(clip.fadeOutMs, 10), maxFadeMs);
      nextClips.push({
        ...clip,
        id: makeSplitPieceClipId(clip.id, 'L', r.startFlicks, cutRange.startFlicks),
        timelineRange: {
          startFlicks: r.startFlicks,
          endFlicks: cutRange.startFlicks,
        },
        fadeInMs: safeFadeInMs,
        fadeOutMs: safeFadeOutMs,
      });
    }

    if (!shiftFollowingClips && replaceWithRoomToneAssetId && trackId) {
      const fillStart = Math.max(r.startFlicks, cutRange.startFlicks);
      const fillEnd = Math.min(r.endFlicks, cutRange.endFlicks);
      if (fillEnd > fillStart) {
        const fillDurMs = (fillEnd - fillStart) / 705_600;
        const safeFillFadeMs = Math.min(10, Math.max(0, fillDurMs * 0.45));
        nextClips.push({
          id: `rt-${trackId}-${fillStart}-${fillEnd}`,
          assetId: replaceWithRoomToneAssetId,
          trackId,
          kind: 'room-tone-fill',
          timelineRange: { startFlicks: fillStart, endFlicks: fillEnd },
          sourceStartFlicks: 0,
          fadeInMs: safeFillFadeMs,
          fadeOutMs: safeFillFadeMs,
          gainDb: 0,
          muted: false,
        });
      }
    }

    if (r.endFlicks > cutRange.endFlicks) {
      const consumedFromClipStart = cutRange.endFlicks - r.startFlicks;
      const rightStart = shiftFollowingClips ? cutRange.endFlicks - cutDur : cutRange.endFlicks;
      const rightEnd = shiftFollowingClips ? r.endFlicks - cutDur : r.endFlicks;
      const rightDurMs = (rightEnd - rightStart) / 705_600;
      const maxFadeMs = Math.max(0, rightDurMs * 0.45);
      const safeFadeInMs = Math.min(Math.max(clip.fadeInMs, 10), maxFadeMs);
      const safeFadeOutMs = Math.min(clip.fadeOutMs, maxFadeMs);
      nextClips.push({
        ...clip,
        id: makeSplitPieceClipId(clip.id, 'R', rightStart, rightEnd),
        timelineRange: {
          startFlicks: rightStart,
          endFlicks: rightEnd,
        },
        sourceStartFlicks: clip.sourceStartFlicks + consumedFromClipStart,
        fadeInMs: safeFadeInMs,
        fadeOutMs: safeFadeOutMs,
      });
    }
  }

  return nextClips;
}

export function applySyncSafeCut(
  tracks: Track[],
  targetTrackId: string,
  cutRange: FlickRange,
  mode: RecommendationActionMode,
): Track[] {
  const targetTrack = tracks.find((t) => t.id === targetTrackId);
  if (!targetTrack) return tracks;

  if (mode === 'sync-locked-ripple-cut') {
    const syncGroup = targetTrack.syncGroupId;
    return tracks.map((t) => {
      const shouldApply = t.id === targetTrackId || (syncGroup !== null && t.syncGroupId === syncGroup);
      if (!shouldApply) return t;
      return {
        ...t,
        clips: cutRangeFromClipList(t.clips, cutRange, true),
      };
    });
  }

  // In-Place Room Tone Suppression: only affects targetTrackId, preserves timeline length & sync!
  return tracks.map((t) => {
    if (t.id !== targetTrackId) return t;
    const primaryAssetId =
      t.clips.find((c) => c.kind === 'speech')?.assetId ?? t.clips[0]?.assetId ?? 'asset-1';
    return {
      ...t,
      clips: cutRangeFromClipList(t.clips, cutRange, false, primaryAssetId, t.id),
    };
  });
}

/**
 * Projects word-level Persian tokens through a timeline edit so transcript highlighting,
 * click-to-seek, and subsequent text-based edits stay 100% synchronized with audio clips.
 */
export function projectTokensAfterCut(
  tokens: PersianWordToken[],
  tracks: Track[],
  targetTrackId: string,
  cutRange: FlickRange,
  mode: RecommendationActionMode,
): PersianWordToken[] {
  const targetTrack = tracks.find((t) => t.id === targetTrackId);
  if (!targetTrack) return cloneTokens(tokens);

  const cutDur = rangeDurationFlicks(cutRange);
  if (cutDur <= 0) return cloneTokens(tokens);

  if (mode === 'in-place-room-tone-suppression') {
    return tokens.map((tok) => {
      if (tok.trackId !== targetTrackId || !rangesOverlap(tok.range, cutRange)) {
        return { ...tok, range: { ...tok.range } };
      }
      const overlapStart = Math.max(tok.range.startFlicks, cutRange.startFlicks);
      const overlapEnd = Math.min(tok.range.endFlicks, cutRange.endFlicks);
      const tokDur = Math.max(1, rangeDurationFlicks(tok.range));
      // Mark suppressed if >= 35% of the word falls inside the room-tone fill range
      if ((overlapEnd - overlapStart) / tokDur >= 0.35) {
        return {
          ...tok,
          range: { ...tok.range },
          isCrosstalkSuppressed: true,
        };
      }
      return { ...tok, range: { ...tok.range } };
    });
  }

  // sync-locked-ripple-cut: all tracks in the same syncGroupId (or targetTrackId) shift time
  const syncGroup = targetTrack.syncGroupId;
  const affectedTrackIds = new Set(
    tracks
      .filter((t) => t.id === targetTrackId || (syncGroup !== null && t.syncGroupId === syncGroup))
      .map((t) => t.id),
  );

  const projected: PersianWordToken[] = [];
  for (const tok of tokens) {
    if (!affectedTrackIds.has(tok.trackId)) {
      projected.push({ ...tok, range: { ...tok.range } });
      continue;
    }

    const r = tok.range;
    // 1. Token is completely before cutRange
    if (r.endFlicks <= cutRange.startFlicks) {
      projected.push({ ...tok, range: { ...r } });
      continue;
    }

    // 2. Token is completely after cutRange -> shift backward by cutDur
    if (r.startFlicks >= cutRange.endFlicks) {
      projected.push({
        ...tok,
        range: {
          startFlicks: Math.max(0, r.startFlicks - cutDur),
          endFlicks: Math.max(1, r.endFlicks - cutDur),
        },
      });
      continue;
    }

    // 3. Token overlaps cutRange: check how much of the word remains outside cutRange
    const overlapStart = Math.max(r.startFlicks, cutRange.startFlicks);
    const overlapEnd = Math.min(r.endFlicks, cutRange.endFlicks);
    const overlapDur = Math.max(0, overlapEnd - overlapStart);
    const tokDur = Math.max(1, rangeDurationFlicks(r));

    // If >= 45% of the token was cut, remove the word token from the active timeline
    if (overlapDur / tokDur >= 0.45) {
      continue;
    }

    // Otherwise trim the boundary and shift if needed
    if (r.startFlicks < cutRange.startFlicks && r.endFlicks <= cutRange.endFlicks) {
      projected.push({
        ...tok,
        range: {
          startFlicks: r.startFlicks,
          endFlicks: cutRange.startFlicks,
        },
      });
    } else if (r.startFlicks >= cutRange.startFlicks && r.endFlicks > cutRange.endFlicks) {
      projected.push({
        ...tok,
        range: {
          startFlicks: cutRange.startFlicks,
          endFlicks: Math.max(cutRange.startFlicks + 1, r.endFlicks - cutDur),
        },
      });
    } else if (r.startFlicks < cutRange.startFlicks && r.endFlicks > cutRange.endFlicks) {
      // Strictly interior cut removing < 45% of the token: preserve token with reduced duration
      projected.push({
        ...tok,
        range: {
          startFlicks: r.startFlicks,
          endFlicks: Math.max(r.startFlicks + 1, r.endFlicks - cutDur),
        },
      });
    }
  }

  return projected;
}

/**
 * Projects pending SmartRecommendations through a timeline cut so subsequent suggestion markers
 * on the waveform and in the suggestions panel remain aligned with shifted audio.
 */
export function projectRecommendationsAfterCut(
  recommendations: SmartRecommendation[],
  tracks: Track[],
  targetTrackId: string,
  cutRange: FlickRange,
  mode: RecommendationActionMode,
  acceptedRecId?: string,
): SmartRecommendation[] {
  const targetTrack = tracks.find((t) => t.id === targetTrackId);
  const cutDur = rangeDurationFlicks(cutRange);
  const syncGroup = targetTrack?.syncGroupId ?? null;
  const affectedTrackIds = new Set(
    tracks
      .filter((t) => t.id === targetTrackId || (syncGroup !== null && t.syncGroupId === syncGroup))
      .map((t) => t.id),
  );

  const shiftFlickRange = (r: FlickRange, delta: number): FlickRange => {
    const startFlicks = Math.max(0, r.startFlicks - delta);
    return {
      startFlicks,
      endFlicks: Math.max(startFlicks + 1, r.endFlicks - delta),
    };
  };

  return recommendations.map((rec) => {
    const cloned = cloneRecommendations([rec])[0];
    if (acceptedRecId && cloned.id === acceptedRecId) {
      return { ...cloned, status: 'Accepted' };
    }

    if (mode === 'in-place-room-tone-suppression') {
      if (
        cloned.status === 'Pending' &&
        cloned.trackId === targetTrackId &&
        rangesOverlap(cloned.boundary.snappedRange, cutRange)
      ) {
        return { ...cloned, status: 'Superseded' };
      }
      return cloned;
    }

    // Ripple cut
    if (!affectedTrackIds.has(cloned.trackId)) {
      return cloned;
    }

    const r = cloned.boundary.snappedRange;
    if (r.endFlicks <= cutRange.startFlicks) {
      return cloned;
    }

    if (r.startFlicks >= cutRange.endFlicks) {
      return {
        ...cloned,
        range: shiftFlickRange(cloned.range, cutDur),
        boundary: {
          ...cloned.boundary,
          rawRange: shiftFlickRange(cloned.boundary.rawRange, cutDur),
          snappedRange: shiftFlickRange(cloned.boundary.snappedRange, cutDur),
        },
      };
    }

    // Overlaps the cut range
    if (cloned.status === 'Pending') {
      return { ...cloned, status: 'Superseded' };
    }
    return cloned;
  });
}

/**
 * Splits clips at `playheadFlicks` on `targetTrackId` (or across all synced tracks when `targetTrackId` is omitted)
 * with 10ms micro-crossfades to prevent boundary clicks.
 */
export function splitTrackClipsAtPlayhead(
  tracks: Track[],
  playheadFlicks: number,
  targetTrackId?: string,
): { tracks: Track[]; splitCount: number } {
  const minEdgeFlicks = msToFlicks(40); // Prevent microscopic <40ms slivers
  let splitCount = 0;

  const nextTracks = tracks.map((track) => {
    if (targetTrackId && track.id !== targetTrackId) {
      return {
        ...track,
        clips: track.clips.map((c) => ({ ...c, timelineRange: { ...c.timelineRange } })),
      };
    }

    const nextClips: TimelineClip[] = [];
    for (const clip of track.clips) {
      const r = clip.timelineRange;
      if (
        playheadFlicks > r.startFlicks + minEdgeFlicks &&
        playheadFlicks < r.endFlicks - minEdgeFlicks
      ) {
        splitCount++;
        const leftDuration = playheadFlicks - r.startFlicks;
        const rightDuration = r.endFlicks - playheadFlicks;
        const leftMaxFadeMs = Math.max(0, (leftDuration / 705_600) * 0.45);
        const rightMaxFadeMs = Math.max(0, (rightDuration / 705_600) * 0.45);
        nextClips.push({
          ...clip,
          id: makeSplitPieceClipId(clip.id, 'L', r.startFlicks, playheadFlicks),
          timelineRange: {
            startFlicks: r.startFlicks,
            endFlicks: playheadFlicks,
          },
          fadeInMs: Math.min(clip.fadeInMs, leftMaxFadeMs),
          fadeOutMs: Math.min(Math.max(clip.fadeOutMs, 10), leftMaxFadeMs),
        });
        nextClips.push({
          ...clip,
          id: makeSplitPieceClipId(clip.id, 'R', playheadFlicks, r.endFlicks),
          timelineRange: {
            startFlicks: playheadFlicks,
            endFlicks: r.endFlicks,
          },
          sourceStartFlicks:
            clip.kind === 'speech' ? clip.sourceStartFlicks + leftDuration : 0,
          fadeInMs: Math.min(Math.max(clip.fadeInMs, 10), rightMaxFadeMs),
          fadeOutMs: Math.min(clip.fadeOutMs, rightMaxFadeMs),
        });
      } else {
        nextClips.push({ ...clip, timelineRange: { ...r } });
      }
    }

    return {
      ...track,
      clips: nextClips,
    };
  });

  return { tracks: nextTracks, splitCount };
}

/**
 * Computes the bounding cut range and track for one or more selected word tokens in the transcript
 * to enable direct Descript-style Text-Based Audio Editing.
 */
export function computeMultiWordCutRange(
  tokens: PersianWordToken[],
  selectedTokenIds: readonly string[],
): {
  trackId: string;
  range: FlickRange;
  combinedText: string;
  hasTrailingEzafeRisk: boolean;
  ezafeWarningFa?: string;
} | null {
  if (selectedTokenIds.length === 0) return null;
  const selectedSet = new Set(selectedTokenIds);
  const matched = tokens.filter((t) => selectedSet.has(t.id));
  if (matched.length === 0) return null;

  const primaryTrackId = matched[0].trackId;
  const sameTrackTokens = matched
    .filter((t) => t.trackId === primaryTrackId)
    .sort((a, b) => a.range.startFlicks - b.range.startFlicks);

  const startFlicks = sameTrackTokens[0].range.startFlicks;
  const endFlicks = sameTrackTokens[sameTrackTokens.length - 1].range.endFlicks;
  const combinedText = sameTrackTokens.map((t) => t.displayText).join(' ');

  // Check if the immediately preceding token on the same track has a trailing Ezafe risk
  const trackTokens = tokens
    .filter((t) => t.trackId === primaryTrackId)
    .sort((a, b) => a.range.startFlicks - b.range.startFlicks);
  const firstIdx = trackTokens.findIndex((t) => t.id === sameTrackTokens[0].id);
  const prevToken = firstIdx > 0 ? trackTokens[firstIdx - 1] : undefined;
  const hasTrailingEzafeRisk = Boolean(prevToken?.hasTrailingEzafeRisk);

  return {
    trackId: primaryTrackId,
    range: { startFlicks, endFlicks },
    combinedText,
    hasTrailingEzafeRisk,
    ezafeWarningFa: hasTrailingEzafeRisk
      ? `هشدار آوایی: کلمه قبلی («${prevToken?.displayText}») دارای کسره اضافه «ـِ» است؛ برش با Micro-Crossfade نرم انجام می‌شود.`
      : undefined,
  };
}

export function computeTimelineDurationFlicks(tracks: Track[]): number {
  let maxEnd = 0;
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.timelineRange.endFlicks > maxEnd) {
        maxEnd = c.timelineRange.endFlicks;
      }
    }
  }
  return maxEnd;
}

/**
 * Applies all eligible pending SmartRecommendations sequentially in a single atomic batch,
 * projecting tracks, tokens, and subsequent recommendation ranges at every step so a single
 * Undo restores the entire batch cleanly.
 */
export function applyBatchRecommendationsAtomically(params: {
  tracks: Track[];
  tokens: PersianWordToken[];
  recommendations: SmartRecommendation[];
  targetRecIds?: readonly string[];
  pcmSources?: Record<string, Float32Array>;
  sampleRate?: number;
}): {
  tracks: Track[];
  tokens: PersianWordToken[];
  recommendations: SmartRecommendation[];
  appliedCount: number;
  rippleCutCount: number;
  roomToneCount: number;
} {
  let currentTracks = cloneTracks(params.tracks);
  let currentTokens = cloneTokens(params.tokens);
  let currentRecs = cloneRecommendations(params.recommendations);

  const explicitSet = params.targetRecIds ? new Set(params.targetRecIds) : null;

  const isEligibleForAutoBatch = (r: SmartRecommendation): boolean => {
    if (r.status !== 'Pending') return false;
    if (explicitSet) return explicitSet.has(r.id);
    // Do not auto-delete valid content words that only carry an Ezafe caution notice
    if (r.id.startsWith('rec-ezafe-') || r.relatedText.startsWith('بررسی کسره اضافه')) {
      return false;
    }
    if (r.boundary.trailingEzafeRisk && r.kind === 'repetition') {
      return false;
    }
    return true;
  };

  let appliedCount = 0;
  let rippleCutCount = 0;
  let roomToneCount = 0;

  // Guard against infinite loops; at most currentRecs.length iterations
  const maxSteps = currentRecs.length;
  for (let step = 0; step < maxSteps; step++) {
    // Pick the earliest eligible pending recommendation
    const candidates = currentRecs
      .filter(isEligibleForAutoBatch)
      .sort((a, b) => a.boundary.snappedRange.startFlicks - b.boundary.snappedRange.startFlicks);

    if (candidates.length === 0) break;
    const rec = candidates[0];
    const cutRange = rec.boundary.snappedRange;

    const safety = determineSyncSafeEditMode(
      currentTracks,
      rec.trackId,
      cutRange,
      currentTokens,
      params.pcmSources,
      params.sampleRate,
    );
    const effectiveMode: RecommendationActionMode =
      rec.recommendedMode === 'in-place-room-tone-suppression'
        ? 'in-place-room-tone-suppression'
        : safety.mode;

    const tracksBeforeStep = currentTracks;
    currentTracks = applySyncSafeCut(tracksBeforeStep, rec.trackId, cutRange, effectiveMode);
    currentTokens = projectTokensAfterCut(
      currentTokens,
      tracksBeforeStep,
      rec.trackId,
      cutRange,
      effectiveMode,
    );
    currentRecs = projectRecommendationsAfterCut(
      currentRecs,
      tracksBeforeStep,
      rec.trackId,
      cutRange,
      effectiveMode,
      rec.id,
    );

    appliedCount++;
    if (effectiveMode === 'sync-locked-ripple-cut') {
      rippleCutCount++;
    } else {
      roomToneCount++;
    }
  }

  return {
    tracks: currentTracks,
    tokens: currentTokens,
    recommendations: currentRecs,
    appliedCount,
    rippleCutCount,
    roomToneCount,
  };
}

const DEFAULT_TIMELINE_HISTORY_PCM_BUDGET_BYTES = 128 * 1024 * 1024;

function arePcmSourceSnapshotsEquivalent(
  before: Record<string, Float32Array> | undefined,
  after: Record<string, Float32Array> | undefined,
): boolean {
  if (before === undefined || after === undefined) return before === after;
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.length !== afterKeys.length) return false;
  for (const key of beforeKeys) {
    if (!(key in after) || before[key] !== after[key]) return false;
  }
  return true;
}

/**
 * Transaction History Stack with Gesture Coalescing support (Section 25).
 * Retains immutable PCM references only while the unique PCM backing-buffer budget permits.
 */
export class TimelineHistoryManager {
  private undoStack: EditTransaction[] = [];
  private redoStack: EditTransaction[] = [];
  private projectVersion = 1;
  private readonly maxDepth: number;
  private readonly maxRetainedPcmBytes: number;
  private lastCommitRetained = true;

  constructor(maxDepth = 100, maxRetainedPcmBytes = DEFAULT_TIMELINE_HISTORY_PCM_BUDGET_BYTES) {
    if (!Number.isSafeInteger(maxRetainedPcmBytes) || maxRetainedPcmBytes < 0) {
      throw new RangeError('maxRetainedPcmBytes must be a non-negative safe integer.');
    }
    this.maxDepth = Math.max(10, Math.trunc(maxDepth));
    this.maxRetainedPcmBytes = maxRetainedPcmBytes;
  }

  /** Counts unique Float32Array backing stores retained by both Undo and Redo stacks. */
  getRetainedPcmBytes(): number {
    const seen = new Set<ArrayBufferLike>();
    let total = 0;
    for (const tx of [...this.undoStack, ...this.redoStack]) {
      for (const sourceMap of [tx.beforePcmSources, tx.afterPcmSources]) {
        if (!sourceMap) continue;
        for (const pcm of Object.values(sourceMap)) {
          if (pcm instanceof Float32Array && !seen.has(pcm.buffer)) {
            seen.add(pcm.buffer);
            total += pcm.buffer.byteLength;
          }
        }
      }
    }
    return total;
  }

  getMaxRetainedPcmBytes(): number {
    return this.maxRetainedPcmBytes;
  }

  /** False means the most recent edit was committed but its Undo snapshot exceeded the memory budget. */
  wasLastCommitRetained(): boolean {
    return this.lastCommitRetained;
  }

  private trimHistoryToMemoryBudget(preferredKeepOperationId: string): void {
    while (this.getRetainedPcmBytes() > this.maxRetainedPcmBytes) {
      const oldestUndo = this.undoStack[0];
      const oldestRedo = this.redoStack[0];
      if (!oldestUndo && !oldestRedo) break;

      const removeUndo = Boolean(
        oldestUndo && (!oldestRedo || oldestUndo.timestamp <= oldestRedo.timestamp),
      );
      const oldest = removeUndo ? oldestUndo! : oldestRedo!;
      if (oldest.operationId === preferredKeepOperationId) {
        // The newest transaction alone exceeds the budget. Clear stale history rather than
        // retaining a multi-hundred-MiB PCM snapshot or exposing an incorrect Undo chain.
        this.undoStack = [];
        this.redoStack = [];
        this.lastCommitRetained = false;
        return;
      }
      if (removeUndo) this.undoStack.shift();
      else this.redoStack.shift();
    }
  }

  commitTransaction(
    params: Omit<EditTransaction, 'operationId' | 'projectVersion' | 'commitStatus' | 'timestamp'>,
  ): EditTransaction {
    // If coalescingKey matches top of undoStack within 1.5s, merge instead of spamming stack
    const prev = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (
      prev &&
      prev.coalescingKey === params.coalescingKey &&
      params.coalescingKey !== '' &&
      now - prev.timestamp < 1500
    ) {
      prev.afterTracks = cloneTracks(params.afterTracks);
      if (params.afterTokens) prev.afterTokens = cloneTokens(params.afterTokens);
      if (params.afterRecommendations) {
        prev.afterRecommendations = cloneRecommendations(params.afterRecommendations);
      }
      if (params.afterDsp) prev.afterDsp = { ...params.afterDsp };
      if (params.afterPcmSources) prev.afterPcmSources = { ...params.afterPcmSources };
      if (arePcmSourceSnapshotsEquivalent(prev.beforePcmSources, prev.afterPcmSources)) {
        prev.beforePcmSources = undefined;
        prev.afterPcmSources = undefined;
      }
      if (params.afterAssets) prev.afterAssets = { ...params.afterAssets };
      if (params.afterEqResponseCurveDb !== undefined) {
        prev.afterEqResponseCurveDb = params.afterEqResponseCurveDb
          ? params.afterEqResponseCurveDb.map((p) => ({ ...p }))
          : null;
      }
      prev.description = params.description;
      prev.timestamp = now;
      this.redoStack = [];
      this.lastCommitRetained = true;
      this.trimHistoryToMemoryBudget(prev.operationId);
      return prev;
    }

    const tx: EditTransaction = {
      ...params,
      operationId: `tx-${++this.projectVersion}-${now}`,
      projectVersion: this.projectVersion,
      timestamp: now,
      beforeTracks: cloneTracks(params.beforeTracks),
      afterTracks: cloneTracks(params.afterTracks),
      beforeTokens: params.beforeTokens ? cloneTokens(params.beforeTokens) : undefined,
      afterTokens: params.afterTokens ? cloneTokens(params.afterTokens) : undefined,
      beforeRecommendations: params.beforeRecommendations
        ? cloneRecommendations(params.beforeRecommendations)
        : undefined,
      afterRecommendations: params.afterRecommendations
        ? cloneRecommendations(params.afterRecommendations)
        : undefined,
      beforeDsp: params.beforeDsp ? { ...params.beforeDsp } : undefined,
      afterDsp: params.afterDsp ? { ...params.afterDsp } : undefined,
      beforePcmSources: params.beforePcmSources ? { ...params.beforePcmSources } : undefined,
      afterPcmSources: params.afterPcmSources ? { ...params.afterPcmSources } : undefined,
      beforeAssets: params.beforeAssets ? { ...params.beforeAssets } : undefined,
      afterAssets: params.afterAssets ? { ...params.afterAssets } : undefined,
      beforeEqResponseCurveDb:
        params.beforeEqResponseCurveDb === undefined
          ? undefined
          : params.beforeEqResponseCurveDb
            ? params.beforeEqResponseCurveDb.map((p) => ({ ...p }))
            : null,
      afterEqResponseCurveDb:
        params.afterEqResponseCurveDb === undefined
          ? undefined
          : params.afterEqResponseCurveDb
            ? params.afterEqResponseCurveDb.map((p) => ({ ...p }))
            : null,
      commitStatus: 'committed',
    };

    if (arePcmSourceSnapshotsEquivalent(tx.beforePcmSources, tx.afterPcmSources)) {
      tx.beforePcmSources = undefined;
      tx.afterPcmSources = undefined;
    }
    this.undoStack.push(tx);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.splice(0, this.undoStack.length - this.maxDepth);
    }
    this.redoStack = [];
    this.lastCommitRetained = true;
    this.trimHistoryToMemoryBudget(tx.operationId);
    return tx;
  }

  undo(): EditTransaction | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    tx.commitStatus = 'reverted';
    this.redoStack.push(tx);
    return tx;
  }

  redo(): EditTransaction | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    tx.commitStatus = 'committed';
    this.undoStack.push(tx);
    return tx;
  }

  getHistory(): EditTransaction[] {
    return [...this.undoStack].reverse();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getProjectVersion(): number {
    return this.projectVersion;
  }
}

