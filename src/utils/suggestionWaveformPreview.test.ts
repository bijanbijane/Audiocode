import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultPersianPodcastProject } from '../engine/audioFixtures';
import { flicksToSeconds, msToFlicks } from '../engine/timebase';
import { buildSuggestionImpactPreview } from './suggestionWaveformPreview';

test('ripple cut preview on long silence shortens after window and shifts trailing speech across splice seam', () => {
  const proj = buildDefaultPersianPodcastProject();
  const pauseRec = proj.recommendations.find((r) => r.id === 'rec-mutual-pause');
  assert.ok(pauseRec, 'default project must contain rec-mutual-pause');

  const preview = buildSuggestionImpactPreview({
    recommendation: pauseRec,
    tracks: proj.tracks,
    assets: proj.assets,
    pcmSources: proj.pcmSources,
    tokens: proj.tokens,
    sampleRate: proj.sampleRate,
    binCount: 80,
  });

  assert.equal(preview.effectiveMode, 'sync-locked-ripple-cut');
  assert.ok(preview.savedDurationSec > 0.9, `expected ~1.1s saved, got ${preview.savedDurationSec}`);
  assert.ok(
    Math.abs(preview.afterDurationSec - (preview.windowDurationSec - preview.savedDurationSec)) < 1e-4,
    'afterDurationSec must equal windowDurationSec - savedDurationSec',
  );
  assert.ok(preview.afterFillRatio < 0.85, 'ripple cut must visually shorten the after strip');
  assert.ok(preview.afterBins.length < preview.beforeBins.length, 'afterBins count must scale proportionally');
  assert.ok(preview.cutStartRatio > 0 && preview.cutEndRatio > preview.cutStartRatio && preview.cutEndRatio < 1);
  // Post-splice region pulls active speech immediately after the splice point, raising energy vs removed silence
  assert.ok(
    preview.afterZoneRms > preview.removedZoneRmsBefore,
    `expected post-splice speech RMS (${preview.afterZoneRms.toFixed(3)}) > removed silence RMS (${preview.removedZoneRmsBefore.toFixed(3)})`,
  );
});

test('in-place room-tone suppression preserves timeline duration and attenuates target zone energy', () => {
  const proj = buildDefaultPersianPodcastProject();
  const fillerRec = proj.recommendations.find((r) => r.id === 'rec-filler-stretch');
  assert.ok(fillerRec, 'default project must contain rec-filler-stretch');

  const preview = buildSuggestionImpactPreview({
    recommendation: fillerRec,
    tracks: proj.tracks,
    assets: proj.assets,
    pcmSources: proj.pcmSources,
    tokens: proj.tokens,
    sampleRate: proj.sampleRate,
    binCount: 80,
  });

  assert.equal(preview.effectiveMode, 'in-place-room-tone-suppression');
  assert.equal(preview.savedDurationSec, 0);
  assert.equal(preview.afterFillRatio, 1);
  assert.equal(preview.afterBins.length, preview.beforeBins.length);
  assert.ok(
    preview.afterZoneRms < preview.removedZoneRmsBefore * 0.5,
    `expected room-tone zone RMS (${preview.afterZoneRms.toFixed(3)}) << before filler RMS (${preview.removedZoneRmsBefore.toFixed(3)})`,
  );
  assert.ok(
    preview.afterBins.some((b) => b.isRoomTone),
    'expected synthesized room-tone bins to be flagged for visual differentiation',
  );
});

test('falls back cleanly to PeakPyramid when raw pcmSources are evicted to OPFS', () => {
  const proj = buildDefaultPersianPodcastProject();
  const pauseRec = proj.recommendations.find((r) => r.id === 'rec-mutual-pause')!;

  const preview = buildSuggestionImpactPreview({
    recommendation: pauseRec,
    tracks: proj.tracks,
    assets: proj.assets,
    pcmSources: {}, // simulate OPFS-evicted PCM
    tokens: proj.tokens,
    sampleRate: proj.sampleRate,
    binCount: 64,
  });

  const maxPeak = Math.max(...preview.beforeBins.map((b) => b.peak));
  assert.ok(maxPeak > 0.5, `expected non-zero PeakPyramid waveform envelope, got maxPeak=${maxPeak}`);
  assert.ok(preview.beforeBins.every((b) => Number.isFinite(b.peak) && b.peak >= 0 && b.peak <= 1));
  assert.ok(preview.afterBins.every((b) => Number.isFinite(b.peak) && b.peak >= 0 && b.peak <= 1));
});

test('nudging recommendation boundary updates cut duration and start ratio monotonically', () => {
  const proj = buildDefaultPersianPodcastProject();
  const pauseRec = proj.recommendations.find((r) => r.id === 'rec-mutual-pause')!;

  const base = buildSuggestionImpactPreview({
    recommendation: pauseRec,
    tracks: proj.tracks,
    assets: proj.assets,
    pcmSources: proj.pcmSources,
    tokens: proj.tokens,
    sampleRate: proj.sampleRate,
  });

  const nudged = {
    ...pauseRec,
    boundary: {
      ...pauseRec.boundary,
      snappedRange: {
        startFlicks: Math.max(0, pauseRec.boundary.snappedRange.startFlicks - msToFlicks(40)),
        endFlicks: pauseRec.boundary.snappedRange.endFlicks,
      },
    },
  };

  const afterNudge = buildSuggestionImpactPreview({
    recommendation: nudged,
    tracks: proj.tracks,
    assets: proj.assets,
    pcmSources: proj.pcmSources,
    tokens: proj.tokens,
    sampleRate: proj.sampleRate,
  });

  assert.ok(
    afterNudge.cutStartSec < base.cutStartSec,
    `expected nudged start (${afterNudge.cutStartSec}) < base (${base.cutStartSec})`,
  );
  assert.ok(
    Math.abs(afterNudge.cutDurationSec - (base.cutDurationSec + 0.04)) < 0.005,
    `expected +40ms cut duration delta, got ${(afterNudge.cutDurationSec - base.cutDurationSec).toFixed(4)}s`,
  );
  assert.ok(Number.isFinite(flicksToSeconds(nudged.boundary.snappedRange.startFlicks)));
});
