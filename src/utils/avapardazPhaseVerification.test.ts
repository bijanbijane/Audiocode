/**
 * AVAPARDAZ — Comprehensive Phase 01–15 Unit, Scale & Audio Integrity Verification Suite
 *
 * Executed via `npx --yes tsx --test src/utils/avapardazPhaseVerification.test.ts`
 * Covers:
 * - Phase 01: Light-first theme policy & persistence
 * - Phase 02: Binary magic-byte validation, Persian/Arabic/ZWNJ search, ref-counted blob safety
 * - Phase 03: Transcript O(log N) lookup, bidirectional sync & 50,000 / 100,000-word scale benchmark
 * - Phase 04: Suggestion 4-category mapping, duplicate/conflict/stale detection, deduplicated removal, 1,200-item scale
 * - Phase 07: Real non-destructive WAV render + RIFF header & sample re-decode integrity via AudioRenderEngine
 * - Phase 08: Unified settings validation, migration, shortcut conflicts, scoped resets
 * - Phase 09: Adobe Audition SESX v1.9 exporter/validator & honest capability matrix
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadStoredThemeChoice,
  resolveEffectiveTheme,
  saveStoredThemeChoice,
  type StorageLike,
} from './themePreference';
import {
  createDefaultGlobalSettings,
  loadGlobalSettings,
  migrateAndValidateSettings,
  resetAllGlobalSettings,
  resetSettingsCategory,
  saveGlobalSettings,
  validateShortcutBinding,
} from '../settings/settingsStore';
import { validateAudioHeaderBytes } from '../projects/audioFileValidator';
import {
  buildDuplicatedProjectRecord,
  computeProjectHubCounts,
  deriveProjectStatus,
  extractDownsampledWaveformPeaks,
  filterAndSortProjects,
  isPersistedProjectRecordValid,
  normalizePersianSearchQuery,
  planBlobRefCountOnDelete,
  validateProjectName,
  type PersistedProjectRecord,
} from '../projects/projectLibraryLogic';
import {
  findActiveTokenIndexBinarySearch,
  findTokensInTimeRange,
  resolveSelectionAudioRange,
  searchTranscriptTokens,
  selectContiguousTokenRange,
} from './transcriptSync';
import {
  analyzeSuggestionsForReview,
  buildSuggestionEditPlan,
  computeDeduplicatedDurationSec,
  mapRecommendationKindToCategory,
} from './suggestionEngineLogic';
import {
  FLICKS_PER_SECOND,
  type PersianWordToken,
  type SmartRecommendation,
} from '../contracts/v1_2';
import { AdobeAuditionHostAdapter } from '../host-bridge/audition/AuditionHostAdapter';
import type { CanonicalProject } from '../host-bridge/CanonicalProjectService';
import { StudioWorkflowController } from '../workflow/StudioWorkflowController';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
}

function makeFakeToken(index: number, word: string, startSec: number, endSec: number): PersianWordToken {
  return {
    id: `tok-${index}`,
    trackId: 'track-1',
    speakerName: 'گوینده ۱',
    originalText: word,
    displayText: word,
    normalizedText: word,
    confidence: 0.94,
    alignmentSource: 'ASR',
    isDisfluency: word === 'اِمم',
    range: {
      startFlicks: Math.round(startSec * FLICKS_PER_SECOND),
      endFlicks: Math.round(endSec * FLICKS_PER_SECOND),
    },
  };
}

function makeFakeRec(
  id: string,
  kind: SmartRecommendation['kind'],
  startSec: number,
  endSec: number,
  status: SmartRecommendation['status'] = 'Pending',
  relatedText = 'اِمم',
): SmartRecommendation {
  const range = {
    startFlicks: Math.round(startSec * FLICKS_PER_SECOND),
    endFlicks: Math.round(endSec * FLICKS_PER_SECOND),
  };
  return {
    id,
    trackId: 'track-1',
    kind,
    status,
    confidence: 0.88,
    sourceTier: kind === 'long-pause' ? 'Group-A-DSP' : 'Group-B-Persian-ASR',
    relatedText,
    reasonFa: kind === 'long-pause' ? 'مکث طولانی' : 'کلمه پرکننده',
    range,
    recommendedMode: 'sync-locked-ripple-cut',
    boundary: {
      rawRange: range,
      snappedRange: range,
      rmsValleyShiftMs: 0,
      zeroCrossingAdjusted: true,
      microCrossfadeMs: 10,
      pitchPlateauDetected: false,
      trailingEzafeRisk: false,
      reasonFa: 'مرز بهینه',
    },
  };
}

// ---------------------------------------------------------------------------
// PHASE 01 & 08: Light-First Theme & Global Settings Store
// ---------------------------------------------------------------------------

test('Phase 01: First launch defaults strictly to Light regardless of OS dark preference', () => {
  const store = createMemoryStorage();
  const initialChoice = loadStoredThemeChoice(store);
  assert.equal(initialChoice, 'light');
  assert.equal(resolveEffectiveTheme(initialChoice, true), 'light');

  saveStoredThemeChoice('dark', store);
  assert.equal(loadStoredThemeChoice(store), 'dark');
  assert.equal(resolveEffectiveTheme('dark', false), 'dark');

  saveStoredThemeChoice('system', store);
  assert.equal(resolveEffectiveTheme('system', true), 'dark');
  assert.equal(resolveEffectiveTheme('system', false), 'light');
});

test('Phase 08: GlobalSettingsV1 validation, legacy migration, shortcut conflict guard & scoped reset', () => {
  const store = createMemoryStorage();
  const migrated = migrateAndValidateSettings(
    {
      schemaVersion: 0,
      appearance: { theme: 'neon-invalid' },
      playback: { defaultRate: 99, seekStepSec: 10 },
      shortcuts: { playPause: 'Mod+KeyR', toggleLoop: 'Space' },
    },
    'dark',
  );
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.settings.appearance.theme, 'dark');
  assert.equal(migrated.settings.playback.defaultRate, 1.0);
  assert.equal(migrated.settings.playback.seekStepSec, 10);
  assert.ok(migrated.warnings.length >= 2);

  // Reserved browser shortcut & duplicate conflict checks
  const defaults = createDefaultGlobalSettings();
  assert.equal(validateShortcutBinding('playPause', 'F5', defaults.shortcuts).valid, false);
  assert.equal(validateShortcutBinding('toggleLoop', 'Space', defaults.shortcuts).valid, false);
  assert.equal(validateShortcutBinding('toggleLoop', 'KeyK', defaults.shortcuts).valid, true);

  // Save + reload + category reset preserves unrelated categories
  const custom = {
    ...defaults,
    appearance: { ...defaults.appearance, theme: 'dark' as const },
    playback: { ...defaults.playback, defaultRate: 1.5 as const, seekStepSec: 10 as const },
  };
  assert.equal(saveGlobalSettings(custom, store).ok, true);
  const loaded = loadGlobalSettings(store);
  assert.equal(loaded.appearance.theme, 'dark');
  assert.equal(loaded.playback.defaultRate, 1.5);

  const resetPlayback = resetSettingsCategory(loaded, 'playback');
  assert.equal(resetPlayback.playback.defaultRate, 1.0);
  assert.equal(resetPlayback.appearance.theme, 'dark');

  const resetAll = resetAllGlobalSettings();
  assert.equal(resetAll.appearance.theme, 'light');
  assert.equal(resetAll.playback.defaultRate, 1.0);
});

// ---------------------------------------------------------------------------
// PHASE 02: Binary Magic-Byte Validation & Project Hub Domain Logic
// ---------------------------------------------------------------------------

test('Phase 02: Binary magic-byte validator rejects empty, oversized, fake-extension files and accepts real audio headers', () => {
  // 1. Empty
  const emptyRes = validateAudioHeaderBytes({
    fileName: 'empty.wav',
    fileSizeBytes: 0,
    headerBytes: new Uint8Array(0),
  });
  assert.equal(emptyRes.valid, false);
  assert.equal(emptyRes.errorCode, 'FILE_EMPTY');

  // 2. Oversized (> 256 MiB)
  const bigRes = validateAudioHeaderBytes({
    fileName: 'huge.wav',
    fileSizeBytes: 300 * 1024 * 1024,
    headerBytes: new Uint8Array(16),
  });
  assert.equal(bigRes.valid, false);
  assert.equal(bigRes.errorCode, 'FILE_TOO_LARGE');

  // 3. Fake .wav containing plain text
  const fakeWavBytes = new TextEncoder().encode('This is definitely not a WAV audio file!');
  const fakeRes = validateAudioHeaderBytes({
    fileName: 'fake.wav',
    fileSizeBytes: fakeWavBytes.length,
    headerBytes: fakeWavBytes,
  });
  assert.equal(fakeRes.valid, false);
  assert.equal(fakeRes.errorCode, 'INVALID_MAGIC_BYTES');

  // 4. Valid RIFF....WAVE header
  const wavHeader = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  ]);
  const wavRes = validateAudioHeaderBytes({
    fileName: 'real.wav',
    fileSizeBytes: 2048,
    headerBytes: wavHeader,
  });
  assert.equal(wavRes.valid, true);
  assert.equal(wavRes.container, 'WAV');

  // 5. Valid FLAC header
  const flacHeader = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34, 0, 0, 0, 0]);
  const flacRes = validateAudioHeaderBytes({
    fileName: 'speech.flac',
    fileSizeBytes: 4096,
    headerBytes: flacHeader,
  });
  assert.equal(flacRes.valid, true);
  assert.equal(flacRes.container, 'FLAC');
});

test('Phase 02: Persian/Arabic/ZWNJ search, deterministic sort, ref-counted blob safety & peak extraction', () => {
  assert.equal(normalizePersianSearchQuery('مي‌خواهم كتاب عربي'), 'می خواهم کتاب عربی');
  assert.equal(validateProjectName('   ').valid, false);
  assert.equal(validateProjectName('پادکست شماره ۱۲').valid, true);

  // Ref-count safety on duplicate + delete
  assert.deepEqual(planBlobRefCountOnDelete(2), { nextRefCount: 1, shouldDeleteBlob: false });
  assert.deepEqual(planBlobRefCountOnDelete(1), { nextRefCount: 0, shouldDeleteBlob: true });
  assert.deepEqual(planBlobRefCountOnDelete(0), { nextRefCount: 0, shouldDeleteBlob: true });

  const now = 1_700_000_000_000;
  const baseProject: PersistedProjectRecord = {
    id: 'proj-1',
    schemaVersion: 1,
    name: 'اپیزود می‌خواهم کتاب',
    sourceFileName: 'ep1.wav',
    sourceFileType: 'WAV',
    sourceFileSizeBytes: 10240,
    audioBlobId: 'blob-sha256-1',
    durationSec: 42,
    sampleRate: 48000,
    trackCount: 1,
    wordCount: 120,
    pendingSuggestionCount: 2,
    status: deriveProjectStatus({
      wordCount: 120,
      recommendations: [makeFakeRec('r1', 'standalone-filler', 1, 1.5)],
    }),
    storageState: 'indexeddb-local',
    createdAtMs: now - 5000,
    updatedAtMs: now - 1000,
    lastOpenedAtMs: now - 500,
    waveformPreviewPeaks: [0.2, 0.8, 0.4],
    tracks: [],
    tokens: [],
    recommendations: [],
  };

  assert.equal(isPersistedProjectRecordValid(baseProject), true);
  assert.equal(isPersistedProjectRecordValid({ id: '', name: 123 }), false);

  const dup = buildDuplicatedProjectRecord(baseProject, 'proj-2', now, 'fa');
  assert.equal(dup.audioBlobId, baseProject.audioBlobId);
  assert.notEqual(dup.id, baseProject.id);
  assert.ok(dup.name.includes('(کپی)'));

  const results = filterAndSortProjects([baseProject, dup], {
    query: 'مي خواهم كتاب',
    filter: 'all',
    sortBy: 'updatedAt',
    nowMs: now,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'proj-2');

  const counts = computeProjectHubCounts([baseProject, dup], now);
  assert.equal(counts.all, 2);
  assert.equal(counts.editing, 2);

  // Peak extraction preserves silence honestly (all 0) and normalizes real PCM
  const silentPeaks = extractDownsampledWaveformPeaks(new Float32Array(1000), 16);
  assert.ok(silentPeaks && silentPeaks.every((v) => v === 0));
  const tone = new Float32Array(4800);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
  const tonePeaks = extractDownsampledWaveformPeaks(tone, 32);
  assert.equal(tonePeaks?.length, 32);
  assert.ok((tonePeaks?.[0] ?? 0) > 0.9);
});

// ---------------------------------------------------------------------------
// PHASE 03: Transcript Bidirectional Sync & 50,000 / 100,000 Word Scale Benchmark
// ---------------------------------------------------------------------------

test('Phase 03: O(log N) lookup, bidirectional Timeline sync & 100,000-word scale benchmark', () => {
  const vocab = ['سلام', 'می‌خواهم', 'پادکست', 'هوش', 'مصنوعی', 'تدوین', 'صوتی', 'آواپرداز'];
  const count = 100_000;
  const tokens: PersianWordToken[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const startSec = i * 0.35;
    tokens[i] = makeFakeToken(i, vocab[i % vocab.length], startSec, startSec + 0.32);
  }

  // Binary search across 100,000 tokens
  const t0 = performance.now();
  const targetIdx = 73_421;
  const targetMidFlicks = Math.round((targetIdx * 0.35 + 0.15) * FLICKS_PER_SECOND);
  const foundIdx = findActiveTokenIndexBinarySearch(tokens, targetMidFlicks);
  const lookupMs = performance.now() - t0;
  assert.equal(foundIdx, targetIdx);
  assert.ok(lookupMs < 20, `Binary search on 100k tokens took ${lookupMs.toFixed(2)}ms`);

  // Contiguous range selection & validated audio range
  const selectedIds = selectContiguousTokenRange(tokens, 10, 14);
  assert.equal(selectedIds.length, 5);
  const audioRange = resolveSelectionAudioRange(tokens, selectedIds, 40_000);
  assert.ok(audioRange !== null);
  assert.ok(Math.abs(audioRange!.startSec - 10 * 0.35) < 0.001);
  assert.ok(Math.abs(audioRange!.endSec - (14 * 0.35 + 0.32)) < 0.001);

  // Reverse sync: Timeline range -> selected words
  const reverseTokens = findTokensInTimeRange(tokens, 10 * 0.35, 12 * 0.35 + 0.32);
  assert.equal(reverseTokens.length, 3);

  // Persian/Arabic/ZWNJ search on 50,000 tokens
  const slice50k = tokens.slice(0, 50_000);
  const s0 = performance.now();
  const searchRes = searchTranscriptTokens(slice50k, 'مي خواهم');
  const searchMs = performance.now() - s0;
  assert.equal(searchRes.matchedTokenIds.length, 6250);
  assert.ok(searchMs < 1500, `50k Persian normalized search took ${searchMs.toFixed(1)}ms`);
});

// ---------------------------------------------------------------------------
// PHASE 04: Suggestion Engine Lifecycle, Conflict, Deduplication & 1,200-Item Scale
// ---------------------------------------------------------------------------

test('Phase 04: 4-category mapping, conflict/duplicate/stale detection, deduplicated Edit Plan & 1,200-item scale', () => {
  assert.equal(mapRecommendationKindToCategory('standalone-filler', 'اِمم', ''), 'filler');
  assert.equal(mapRecommendationKindToCategory('long-pause', '', ''), 'pause');
  assert.equal(mapRecommendationKindToCategory('repetition', 'و و', ''), 'repetition');
  assert.equal(mapRecommendationKindToCategory('crosstalk-bleed', 'نفس', ''), 'breath');

  // Deduplicated duration never double-counts overlapping spans
  const dedup = computeDeduplicatedDurationSec([
    { startSec: 1.0, endSec: 2.5 },
    { startSec: 2.0, endSec: 3.5 },
    { startSec: 5.0, endSec: 6.0 },
  ]);
  assert.equal(dedup, 3.5);

  const tokens = [
    makeFakeToken(0, 'سلام', 0.2, 0.6),
    makeFakeToken(1, 'اِمم', 0.8, 1.3),
    makeFakeToken(2, 'دوستان', 1.4, 2.0),
    makeFakeToken(3, 'عزیز', 3.5, 4.0),
  ];
  const recs: SmartRecommendation[] = [
    makeFakeRec('rec-a', 'standalone-filler', 0.8, 1.3, 'Pending', 'اِمم'),
    makeFakeRec('rec-b', 'standalone-filler', 0.8, 1.3, 'Pending', 'اِمم'), // duplicate of rec-a
    makeFakeRec('rec-c', 'long-pause', 2.0, 3.4, 'Pending', 'مکث'),
    makeFakeRec('rec-d', 'long-pause', 2.8, 3.6, 'Pending', 'مکث همپوشان'), // partial overlap with rec-c
    makeFakeRec('rec-stale', 'standalone-filler', 95.0, 96.0, 'Pending', 'خارج از محدوده'), // out of 10s duration -> stale
  ];

  const approvedIds = new Set<string>(['rec-a', 'rec-c', 'rec-d', 'rec-stale']);
  const analyzed = analyzeSuggestionsForReview({
    recommendations: recs,
    approvedIds,
    tokens,
    durationSec: 10,
  });

  const itemB = analyzed.find((x) => x.recommendation.id === 'rec-b');
  assert.equal(itemB?.duplicateOfId, 'rec-a');

  const itemStale = analyzed.find((x) => x.recommendation.id === 'rec-stale');
  assert.equal(itemStale?.lifecycle, 'stale');

  const itemC = analyzed.find((x) => x.recommendation.id === 'rec-c');
  assert.equal(itemC?.lifecycle, 'conflict');

  const plan = buildSuggestionEditPlan(analyzed, approvedIds);
  assert.equal(plan.conflictCount, 2); // rec-c and rec-d conflict with each other
  assert.equal(plan.staleCount, 0);
  assert.equal(plan.invalidRangeCount, 1); // rec-stale out of bounds
  assert.equal(plan.applicableItems.length, 1); // only rec-a is conflict-free & valid
  assert.equal(plan.applicableItems[0].recommendation.id, 'rec-a');

  // 1,200-suggestion scale test (non-overlapping)
  const bulkRecs: SmartRecommendation[] = [];
  for (let i = 0; i < 1200; i++) {
    bulkRecs.push(makeFakeRec(`bulk-${i}`, i % 2 === 0 ? 'standalone-filler' : 'long-pause', i * 2.0, i * 2.0 + 0.5));
  }
  const bulkApproved = new Set(bulkRecs.slice(0, 600).map((r) => r.id));
  const b0 = performance.now();
  const bulkAnalyzed = analyzeSuggestionsForReview({
    recommendations: bulkRecs,
    approvedIds: bulkApproved,
    tokens: [],
    durationSec: 3000,
  });
  const bulkPlan = buildSuggestionEditPlan(bulkAnalyzed, bulkApproved);
  const bulkMs = performance.now() - b0;
  assert.equal(bulkPlan.applicableItems.length, 600);
  assert.equal(bulkPlan.totalRemovalSec, 300);
  // Descending order verified so sequential ripple cuts preserve earlier timestamps
  assert.ok(bulkPlan.applicableItems[0].startSec > bulkPlan.applicableItems[599].startSec);
  assert.ok(bulkMs < 500, `1,200 suggestions analyzed & planned in ${bulkMs.toFixed(1)}ms`);
});

// ---------------------------------------------------------------------------
// PHASE 07: Real Non-Destructive Audio Render + Re-Decode Verification
// ---------------------------------------------------------------------------

test('Phase 07: Real AudioRenderEngine produces valid RIFF/WAVE PCM16 honoring approved edits without NaN or clipping', async () => {
  const sampleRate = 16000 as const;
  const durationSec = 4;
  const totalSamples = sampleRate * durationSec;
  const pcm = new Float32Array(totalSamples);
  // 0.0-1.0s: 440Hz tone | 1.0-2.5s: silence (to be shortened by EDL) | 2.5-4.0s: 880Hz tone
  for (let i = 0; i < sampleRate; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.4;
  }
  for (let i = Math.round(2.5 * sampleRate); i < totalSamples; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 880 * i) / sampleRate) * 0.35;
  }

  const controller = new StudioWorkflowController();
  const testTokens = [
    makeFakeToken(0, 'بخش', 0.1, 0.5),
    makeFakeToken(1, 'اول', 0.55, 0.95),
    makeFakeToken(2, 'بخش', 2.6, 3.1),
    makeFakeToken(3, 'دوم', 3.2, 3.8),
  ];
  controller.openProject({
    projectId: 'test-render-proj',
    projectName: 'Synthetic Render Test',
    sourceAudio: {
      sourceAudioId: 'src-synthetic-1',
      sourceAudioHash: 'b'.repeat(64),
      fileName: 'synthetic.wav',
      format: 'WAV',
      sampleRate,
      channelCount: 1,
      bitDepth: 16,
      totalSamples,
      durationSec,
      fileSizeBytes: totalSamples * 2 + 44,
      importStatus: 'VALIDATED',
      isDemoFixture: false,
    },
  });

  const edlRes = await controller.analyzeSpeechEventsAndBuildEdl({
    trackId: 'track-1',
    pcmMono: pcm,
    sampleRate,
    wordTokens: testTokens,
  });
  assert.equal(edlRes.ok, true);
  const proposals = controller.getState().edlSnapshot?.proposals ?? [];
  for (const p of proposals) {
    if (
      p.operation === 'REMOVE_FILLER' ||
      p.operation === 'SHORTEN_SILENCE' ||
      p.operation === 'REMOVE_ACCIDENTAL_REPETITION'
    ) {
      controller.applyHumanDecision({ action: 'APPROVE', proposalId: p.proposalId });
    }
  }

  const renderRes = await controller.startRender({
    pcmChannels: [pcm],
    config: {
      encoding: 'pcm16',
      container: 'wav',
      targetSampleRate: sampleRate,
      chunkSizeSamples: 4096,
      defaultCrossfadeMs: 10,
    },
  });

  assert.ok(renderRes !== null, 'Render returned null');
  assert.equal(
    renderRes!.ok,
    true,
    `Render failed state=${renderRes!.state} pre=${JSON.stringify(renderRes!.preValidation)} post=${JSON.stringify(renderRes!.postValidation)}`,
  );
  assert.equal(renderRes!.state, 'COMPLETED');
  assert.equal(renderRes!.postValidation?.passed, true);
  assert.ok(renderRes!.outputArtifact !== null);

  // Re-decode WAV header & verify real PCM samples
  const blob = await renderRes!.outputArtifact!.createBlob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const riffTag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const waveTag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  assert.equal(riffTag, 'RIFF');
  assert.equal(waveTag, 'WAVE');
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint16(34, true), 16); // 16-bit PCM

  // Verify output duration matches Render Output metadata and has real non-zero signal with zero NaN
  const dataSize = view.getUint32(40, true);
  const outputSampleCount = dataSize / 2;
  assert.equal(outputSampleCount, renderRes!.output?.totalOutputSamples);
  let maxAbs = 0;
  for (let i = 0; i < outputSampleCount; i++) {
    const sample = view.getInt16(44 + i * 2, true) / 32768;
    assert.ok(Number.isFinite(sample));
    const a = Math.abs(sample);
    if (a > maxAbs) maxAbs = a;
  }
  assert.ok(maxAbs > 0.2 && maxAbs <= 1.0, `Unexpected rendered peak amplitude: ${maxAbs}`);
});

// ---------------------------------------------------------------------------
// PHASE 09: Adobe Audition SESX v1.9 Contract & Honest Capability Matrix
// ---------------------------------------------------------------------------

test('Phase 09: AdobeAuditionHostAdapter exports valid SESX v1.9 and honestly flags desktop execution as unverified', () => {
  const adapter = new AdobeAuditionHostAdapter();
  const nowIso = new Date().toISOString();
  const project: CanonicalProject = {
    schema_version: '2.0.0',
    project_id: 'audition-test-1',
    name: 'آزمایش Audition',
    sample_rate_hz: 48000,
    revision: 1,
    created_at: nowIso,
    updated_at: nowIso,
    media: {
      m1: {
        media_id: 'm1',
        display_name: 'host.wav',
        sha256_hex: 'a'.repeat(64),
        sample_rate_hz: 48000,
        channel_count: 1,
        total_samples: 480000,
        bit_depth: 24,
        encoding: 'wav',
        storage_ref: '/media/m1/host.wav',
        availability: 'AVAILABLE',
        registered_at: nowIso,
      },
    },
    tracks: [
      {
        track_id: 't1',
        name: 'گوینده ۱',
        speaker_label: 'میزبان',
        channel_count: 1,
        muted: false,
        solo: false,
        gain_db: 0,
        clips: [
          {
            clip_id: 'c1',
            media_id: 'm1',
            timeline_start_sample: 0,
            timeline_end_sample: 240000,
            source_in_sample: 0,
            gain_db: 0,
            muted: false,
          },
        ],
      },
    ],
    markers: [
      {
        marker_id: 'mk1',
        label: 'شروع فصل',
        sample_position: 48000,
        duration_samples: 0,
        kind: 'USER_CUE',
      },
    ],
    edit_plans: {},
    revision_history: [],
  };

  const { sesx_xml, validation } = adapter.exportCanonicalProjectToSesx(project);
  assert.ok(sesx_xml.includes('<sesx version="1.9">'));
  assert.equal(validation.valid_xml_structure, true);
  assert.equal(validation.valid_sesx_semantics, true);
  assert.equal(validation.track_count, 1);
  assert.equal(validation.clip_count, 1);
  assert.equal(validation.verified_in_desktop_audition, false);

  const matrix = adapter.getHostCapabilityMatrix();
  assert.ok(matrix.length >= 3);
  assert.ok(
    matrix.some((entry) => entry.verification_state === 'UNVERIFIED_REQUIRES_AUDITION_HOST'),
  );
});
