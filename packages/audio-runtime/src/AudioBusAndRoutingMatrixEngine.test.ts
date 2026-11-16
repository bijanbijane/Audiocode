import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioBusAndRoutingMatrixEngine } from './AudioBusAndRoutingMatrixEngine';
import { LoudnessAndMasteringEngine } from '../../../src/audio-engine/LoudnessAndMasteringEngine';

test('Section 88: AudioBusAndRoutingMatrixEngine routes tracks to submix buses, sidechains music from dialogue bus, and limits Master Bus to -1.0 dBTP', () => {
  const sr = 48000 as const;
  const frameCount = 48000;

  const hostVoice = new Float32Array(frameCount);
  const musicBed = new Float32Array(frameCount);
  const sfxAmbience = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    hostVoice[i] = 0.25 * Math.sin((2 * Math.PI * 500 * i) / sr);
    musicBed[i] = 0.15 * Math.sin((2 * Math.PI * 440 * i) / sr);
    sfxAmbience[i] = 0.05 * Math.sin((2 * Math.PI * 1200 * i) / sr);
  }

  const trackMap = new Map([
    ['trk_host', hostVoice],
    ['trk_music', musicBed],
    ['trk_sfx', sfxAmbience],
  ]);

  const res = AudioBusAndRoutingMatrixEngine.mixMultiTrackThroughSubmixBuses({
    trackBuffersMono: trackMap,
    routingTable: [
      { trackId: 'trk_host', targetSubmixBus: 'DIALOGUE_VOICE_BUS', gainDb: 0, pan: 0 },
      { trackId: 'trk_music', targetSubmixBus: 'MUSIC_BED_BUS', gainDb: -3, pan: 0 },
      { trackId: 'trk_sfx', targetSubmixBus: 'SFX_AMBIENCE_BUS', gainDb: -6, pan: 0.4 },
    ],
    sampleRate: sr,
    frameCount,
    enableSidechainVocalCarvingOnMusic: true,
    masterTargetLufs: -16.0,
  });

  assert.equal(res.masterOutputStereo[0].length, frameCount);
  assert.equal(res.masterOutputStereo[1].length, frameCount);

  const postMaster = LoudnessAndMasteringEngine.measureLoudnessAndTruePeak(
    res.masterOutputStereo,
    sr,
  );
  assert.ok(
    postMaster.truePeakDbtp <= -0.95,
    `Expected master True Peak <= -0.95 dBTP, got ${postMaster.truePeakDbtp}`,
  );
});
