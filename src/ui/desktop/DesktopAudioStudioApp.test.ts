import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopAudioStudioApp } from './DesktopAudioStudioApp';
import { TimeMath } from '../../contracts/timebase.contract';
import { PersianTextNormalizer } from '../../ai-engine/PersianTextNormalizer';

test('DesktopAudioStudioApp renders complete RTL studio workspace, OPFS/AI state, acoustic advisor banner, transcript, waveform canvas, and export tab triggers', () => {
  const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
    { id: 'tok_1', text: 'سلام', range: { start: 0, end: TimeMath.secondsToFlicks(0.4) }, confidence: 0.96 },
    { id: 'tok_2', text: 'اممم', range: { start: TimeMath.secondsToFlicks(0.45), end: TimeMath.secondsToFlicks(0.9) }, confidence: 0.91 },
  ]);

  const html = renderToStaticMarkup(
    React.createElement(DesktopAudioStudioApp, {
      project: {
        projectId: 'proj_desktop_1',
        name: 'اپیزود پنجاهم آواپرداز',
        canonicalSampleRate: 48000,
        versions: {
          projectSchemaVersion: 2,
          audioEngineVersion: '1.2.0',
          processingNodeCatalogVersion: '1.2.0',
          activeModelBundleVersion: '1.2.0',
        },
        revision: 4,
        tracks: [
          {
            id: 'trk_1',
            name: 'میزبان',
            syncGroupId: null,
            speakerId: 'SPK_1',
            muted: false,
            solo: false,
            clips: [],
          },
        ],
        recommendations: [
          {
            id: 'rec_1',
            targetTrackId: 'trk_1',
            disfluencyType: 'INDEPENDENT_FILLER',
            associatedText: 'اممم',
            status: 'PENDING',
            createdAtProjectRevision: 4,
            spliceDescriptor: {
              rawAiRange: tokens[1].range,
              snappedAcousticRange: tokens[1].range,
              fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
              fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
              injectRoomToneFlicks: 0,
              cutStrategy: 'GLOBAL_SYNC_RIPPLE',
              prosodicWarnings: [],
              confidence: 0.92,
            },
          },
        ],
      },
      tokens,
      playheadFlicks: TimeMath.secondsToFlicks(0.2),
      isPlaying: false,
      shuttleSpeed: 1.0,
      opfsPersisted: true,
      opfsUsedMb: 42,
      aiModelReady: true,
      aiModelDownloadProgressPercent: 100,
      acousticDiagnostic: {
        has50HzMainsHum: true,
        humFundamentalAndHarmonicsDb: { hz50: -32, hz100: -38, hz150: -45 },
        plosivePopEvents: [],
        harshSibilanceEvents: [],
        signalToNoiseRatioDb: 28.4,
        recommendedGraphNodes: [],
        summaryAdviceFa: ['نویز هوم برق شهر (50Hz/100Hz) شناسایی شد.'],
      },
      waveformCanvasRef: { current: null },
      onTogglePlayPause: () => {},
      onSeek: () => {},
      onUndo: () => {},
      onRedo: () => {},
      onPreviewSplice: () => {},
      onAcceptRecommendation: () => {},
      onRejectRecommendation: () => {},
      onUpdateDisplayTranscript: () => {},
      onApplyAutoAcousticFix: () => {},
      onTriggerExport: () => {},
    }),
  );

  assert.match(html, /dir="rtl"/);
  assert.match(html, /اپیزود پنجاهم آواپرداز/);
  assert.match(html, /فضای محلی پایدار/);
  assert.match(html, /موتور AI فارسی آماده/);
  assert.match(html, /نویز هوم برق شهر \(50Hz\/100Hz\) شناسایی شد/);
  assert.match(html, /data-testid="desktop-waveform-canvas"/);
  assert.match(html, /خروجی نهایی و مسترینگ/);
});
