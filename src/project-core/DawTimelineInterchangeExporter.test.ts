import test from 'node:test';
import assert from 'node:assert/strict';
import { DawTimelineInterchangeExporter } from './DawTimelineInterchangeExporter';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

function makeInterchangeDoc(): ProjectDocument {
  return {
    projectId: 'proj-daw-1',
    name: 'اپیزود <۴۲> & تست',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: 'persian-asr-v1',
    },
    revision: 7,
    recommendations: [],
    tracks: [
      {
        id: 'track-host',
        name: 'گوینده اصلی "استودیو"',
        syncGroupId: 'sync-1',
        speakerId: 'host',
        muted: false,
        solo: true,
        clips: [
          {
            id: 'clip-1',
            trackId: 'track-host',
            kind: 'AUDIO_ASSET',
            assetId: 'asset-host',
            sourceRange: {
              start: TimeMath.secondsToFlicks(0.5),
              end: TimeMath.secondsToFlicks(2.5),
            },
            timelineRange: {
              start: TimeMath.secondsToFlicks(1.0),
              end: TimeMath.secondsToFlicks(3.0),
            },
            fadeInFlicks: TimeMath.secondsToFlicks(0.01),
            fadeOutFlicks: TimeMath.secondsToFlicks(0.015),
            gainDb: 0,
          },
          {
            id: 'clip-rt',
            trackId: 'track-host',
            kind: 'ROOM_TONE_FILL',
            assetId: 'asset-room-tone',
            sourceRange: {
              start: 0,
              end: TimeMath.secondsToFlicks(0.2),
            },
            timelineRange: {
              start: TimeMath.secondsToFlicks(3.0),
              end: TimeMath.secondsToFlicks(3.2),
            },
            fadeInFlicks: TimeMath.secondsToFlicks(0.01),
            fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
            gainDb: -6,
          },
        ],
      },
    ],
  };
}

test('DawTimelineInterchangeExporter generates sample-accurate XML-safe Adobe Audition .sesx session', () => {
  const doc = makeInterchangeDoc();
  const assets = new Map<string, string>([
    ['asset-host', '../unsafe/dir/host_48k.wav'],
  ]);

  const sesx = DawTimelineInterchangeExporter.exportToAdobeAuditionSesx(doc, assets);

  assert.match(sesx, /^<\?xml version="1\.0" encoding="UTF-8"/);
  assert.match(sesx, /<name>اپیزود &lt;۴۲&gt; &amp; تست<\/name>/);
  assert.match(sesx, /<solo>true<\/solo>/);
  assert.match(sesx, /<mute>false<\/mute>/);
  // 1.0s..3.0s at 48kHz -> startPoint=48000, endPoint=144000; sourceInPoint=24000, sourceOutPoint=120000
  assert.match(
    sesx,
    /startPoint="48000" endPoint="144000" sourceInPoint="24000" sourceOutPoint="120000"/,
  );
  // 10ms fade-in = 480 samples, 15ms fade-out over 96000-sample clip = startPoint 95280
  assert.match(sesx, /<fadeIn[^>]*endPoint="480"[^>]*startPoint="0"\/>/);
  assert.match(sesx, /<fadeOut[^>]*endPoint="96000"[^>]*startPoint="95280"\/>/);
  // Traversal stripped & missing assetId from map gets safe fallback file entry
  assert.match(sesx, /relativePath="media\/host_48k\.wav"/);
  assert.match(sesx, /relativePath="media\/asset-room-tone\.wav"/);
});

test('DawTimelineInterchangeExporter generates valid Cockos Reaper .rpp with exact times and linear gain', () => {
  const doc = makeInterchangeDoc();
  const rpp = DawTimelineInterchangeExporter.exportToReaperRpp(
    doc,
    { 'asset-host': 'host_48k.wav' },
    1700000000,
  );

  assert.match(rpp, /^<REAPER_PROJECT 0\.1 "7\.0" 1700000000/);
  assert.match(rpp, /SAMPLERATE 48000 0 0/);
  assert.match(rpp, /NAME "گوینده اصلی 'استودیو'"/);
  assert.match(rpp, /MUTESOLO 0 1 0/);
  assert.match(rpp, /POSITION 1\.000000/);
  assert.match(rpp, /LENGTH 2\.000000/);
  assert.match(rpp, /SOFFS 0\.500000/);
  assert.match(rpp, /FADEIN 1 0\.010000/);
  assert.match(rpp, /FADEOUT 1 0\.015000/);
  assert.match(rpp, /VOLPAN 0\.501187 0 1 -1/); // -6dB linear gain for room tone
  assert.match(rpp, /FILE "media\/host_48k\.wav"/);
});
