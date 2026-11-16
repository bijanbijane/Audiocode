import test from 'node:test';
import assert from 'node:assert/strict';
import { VerticalSliceOrchestrator } from './VerticalSliceOrchestrator';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';
import { RecoveryJournalStore } from '../runtime/CrashRecoveryAndSessionLock';

function makeInMemoryStore(): RecoveryJournalStore {
  const map = new Map<string, string>();
  return {
    async write(id, payload) {
      map.set(id, payload);
    },
    async read(id) {
      return map.get(id) ?? null;
    },
  };
}

function makeDoc(): ProjectDocument {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  return {
    projectId: 'orch-proj-1',
    name: 'Orchestrated Podcast',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 1,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0.0',
      activeModelBundleVersion: 'fa-asr-bundle-1.2',
    },
    revision: 1,
    tracks: [
      {
        id: 't1',
        name: 'Host',
        syncGroupId: 'sync-grp',
        speakerId: 'host',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId: 'a1',
            sourceRange: { start: 0, end: s(4) },
            timelineRange: { start: 0, end: s(4) },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [],
  };
}

test('VerticalSliceOrchestrator runs full Import -> Group A -> Group B -> Accept -> Checkpoint -> Export Validation pipeline', async () => {
  const store = makeInMemoryStore();
  const orchestrator = new VerticalSliceOrchestrator(store);

  const session = await orchestrator.initializeProjectSession(makeDoc());
  assert.equal(session.lockAcquired, true);
  assert.equal(session.recoveredFromCrash, false);

  // Build 4 seconds @ 48kHz PCM with quiet room floor + speech + filler «اممم»
  const sr = 48000;
  const pcm = new Float32Array(sr * 4);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.002 * Math.sin((2 * Math.PI * 90 * i) / sr);
  }
  // Non-stationary modulated speech [1.0s..1.8s] and steady filler «اممم» [2.0s..2.6s]
  for (let i = sr; i < Math.floor(sr * 1.8); i++) {
    const t = i / sr;
    const f0 = 195 + 45 * Math.sin(2 * Math.PI * 6 * t);
    const amp = 0.28 * (0.4 + 0.6 * Math.abs(Math.sin(2 * Math.PI * 5 * t)));
    pcm[i] += amp * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 3.1 * f0 * t));
  }
  for (let i = sr * 2; i < Math.floor(sr * 2.6); i++) {
    pcm[i] += 0.25 * Math.sin((2 * Math.PI * 165 * i) / sr);
  }

  // Group A ingest with valid WAV header
  const wavHeader = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  const groupA = orchestrator.ingestAndRunZeroWaitGroupA(wavHeader, 384_044, [pcm], sr);
  assert.equal(groupA.containerFormat, 'WAV');
  assert.equal(groupA.mono16kForAi.length, 16000 * 4);
  assert.ok(groupA.noiseFloorDb < -40);

  // Group B ASR alignment
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const { threeLayerTokens, recommendations } =
    orchestrator.processPersianAsrAndBuildSmartRecommendations(
      [
        { id: 'tok1', text: 'پادكست', range: { start: s(1.0), end: s(1.8) }, confidence: 0.94 },
        { id: 'tok2', text: 'اممم', range: { start: s(2.0), end: s(2.6) }, confidence: 0.91 },
      ],
      pcm,
      sr,
      't1',
    );

  assert.equal(threeLayerTokens[0].normalizedText, 'پادکست');
  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].disfluencyType, 'INDEPENDENT_FILLER');
  assert.equal(
    recommendations[0].spliceDescriptor.prosodicWarnings.includes('TRAILING_EZAFE_RISK'),
    true,
  );

  // Inject recommendation into session and accept + verify crash recovery checkpoint
  const docWithRec = orchestrator.getTransactionEngine()!.getCommittedState();
  const orchestrator2 = new VerticalSliceOrchestrator(store);
  await orchestrator2.initializeProjectSession({ ...docWithRec, recommendations });
  const afterAccept = await orchestrator2.acceptRecommendationAndSaveCheckpoint(recommendations[0].id);
  assert.equal(afterAccept.revision, 2);

  // Verify dirty crash recovery picks up revision 2
  const crashedSession = new VerticalSliceOrchestrator(store);
  const recovered = await crashedSession.initializeProjectSession(makeDoc());
  assert.equal(recovered.recoveredFromCrash, true);
  assert.equal(recovered.activeDocument.revision, 2);

  // Export validation check on clean faded 1s buffer
  const outBuf = new Float32Array(sr);
  for (let i = 0; i < sr; i++) {
    const env = i < 480 ? i / 480 : i > sr - 480 ? (sr - 1 - i) / 480 : 1;
    outBuf[i] = 0.4 * env * Math.sin((2 * Math.PI * 300 * i) / sr);
  }
  const exp = crashedSession.validateAndPrepareExport(
    [
      {
        id: 'src',
        type: 'TRACK_SOURCE',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: {},
      },
      {
        id: 'lim',
        type: 'MASTER_LIMITER',
        version: '1.0',
        enabled: true,
        latencySamples: 128,
        preRollSamples: 2400,
        tailSamples: 256,
        committedParameters: {},
      },
    ],
    [{ fromNodeId: 'src', toNodeId: 'lim' }],
    [outBuf],
    sr,
    1.0,
    ['hash1'],
  );
  assert.equal(exp.validationReport.passed, true);
  assert.equal(exp.totalLatencySamples, 128);
  assert.ok(exp.renderPlanCacheKey.startsWith('graph_cache_'));
});
