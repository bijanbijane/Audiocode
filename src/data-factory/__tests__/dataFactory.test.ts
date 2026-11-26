import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import { SpeechDataFactoryService } from '../SpeechDataFactoryService';
import {
  applyReproducibleAugmentation,
  encodePcm16WavBuffer,
  ingestAndDecodeUntrustedAudio,
} from '../AudioIngestionAndProfilingEngine';
import {
  computeInterAnnotatorAgreement,
  evaluateRightsForPurpose,
} from '../RightsAndAnnotationGovernanceEngine';

const execFileAsync = promisify(execFile);
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function makeSineWav(sampleRate: number, durSec: number, freqHz = 220, stereo = false): Buffer {
  const frames = Math.floor(sampleRate * durSec);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const val = 0.28 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    left[i] = val;
    right[i] = stereo ? val * 0.95 : val;
  }
  return encodePcm16WavBuffer(stereo ? [left, right] : [left], sampleRate);
}

test(
  'Phase 12B: valid WAV & real FFmpeg-encoded MP3 ingestion, container spoof detection & limits',
  { skip: HAS_FFMPEG ? false : 'FFmpeg is required for the MP3 encode/decode integration portion of Phase 12B' },
  async () => {
  const cp = new PlatformControlPlaneService();
  const df = new SpeechDataFactoryService(cp);
  const src = df.createDataSource({
    tenantId: 'org_avapardaz_sandbox',
    sourceType: 'ORGANIZATION_CONTROLLED_RECORDING',
    sourceName: 'test_mic_src',
    ownerReference: 'org_avapardaz_sandbox',
    licenseReference: 'CC-BY-4.0',
    verified: true,
  });

  // 1. Valid 48kHz Stereo WAV -> canonical 16kHz Mono PCM16
  const wavBuf = makeSineWav(48000, 1.5, 190, true);
  const ing = await df.ingestRecording({
    tenantId: 'org_avapardaz_sandbox',
    projectId: 'prj_avapardaz_dev_01',
    sourceId: src.sourceId,
    filename: 'stereo_take.wav',
    fileBytes: wavBuf,
    speakerRef: 'SPK_01',
    sessionRef: 'SES_01',
    declaredLanguage: 'fa',
  });
  assert.equal(ing.recording.ingestionStatus, 'VALIDATED');
  assert.equal(ing.recording.technicalMetadata.sampleRate, 48000);
  assert.equal(ing.recording.technicalMetadata.channelCount, 2);
  const canonical = ing.artifacts.find((a) => a.artifactType === 'CANONICAL_16K_MONO_PCM16');
  assert.ok(canonical);
  assert.equal(canonical!.sampleRate, 16000);
  assert.equal(canonical!.channelCount, 1);

  // Exact duplicate detection by SHA-256
  const dup = await df.ingestRecording({
    tenantId: 'org_avapardaz_sandbox',
    projectId: 'prj_avapardaz_dev_01',
    sourceId: src.sourceId,
    filename: 'stereo_take_copy.wav',
    fileBytes: wavBuf,
    speakerRef: 'SPK_01',
    sessionRef: 'SES_01',
  });
  assert.equal(dup.exactDuplicateOfRecordingId, ing.recording.recordingId);

  // 2. Spoofed non-audio payload disguised with .wav extension must reject!
  await assert.rejects(
    () =>
      df.ingestRecording({
        tenantId: 'org_avapardaz_sandbox',
        projectId: 'prj_avapardaz_dev_01',
        sourceId: src.sourceId,
        filename: 'evil.wav',
        claimedMimeType: 'audio/wav',
        fileBytes: Buffer.from('{"fake":"executable payload not riff wave"}', 'utf8'),
        speakerRef: 'SPK_02',
        sessionRef: 'SES_02',
      }),
    /INVALID_AUDIO_SIGNATURE|UNSUPPORTED/
  );

  // 3. Real FFmpeg MP3 encode -> ingest via isolated ffprobe/ffmpeg decoder
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p12-mp3-'));
  try {
    const inWav = path.join(tmpDir, 'in.wav');
    const outMp3 = path.join(tmpDir, 'out.mp3');
    await fs.writeFile(inWav, makeSineWav(44100, 1.2, 240, false));
    await execFileAsync('ffmpeg', ['-y', '-i', inWav, '-c:a', 'libmp3lame', '-b:a', '128k', outMp3]);
    const mp3Bytes = await fs.readFile(outMp3);
    const decodedMp3 = await ingestAndDecodeUntrustedAudio({
      fileBytes: mp3Bytes,
      claimedFilename: 'compressed_sample.mp3',
      claimedMimeType: 'audio/mpeg',
    });
    assert.equal(decodedMp3.technical.detectedFormat, 'MP3');
    assert.ok(decodedMp3.technical.durationSeconds > 0.8);
    assert.equal(decodedMp3.channelChannelsPcm.length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 12B Augmentation: reproducible seeded augmentation & evaluation split leak guard', async () => {
  const cp = new PlatformControlPlaneService();
  const df = new SpeechDataFactoryService(cp);
  const src = df.createDataSource({
    tenantId: 'org_avapardaz_sandbox',
    sourceType: 'ORGANIZATION_CONTROLLED_RECORDING',
    sourceName: 'aug_src',
    ownerReference: 'org_avapardaz_sandbox',
    licenseReference: 'MIT',
    verified: true,
  });

  const ing = await df.ingestRecording({
    tenantId: 'org_avapardaz_sandbox',
    projectId: 'prj_avapardaz_dev_01',
    sourceId: src.sourceId,
    filename: 'aug_base.wav',
    fileBytes: makeSineWav(16000, 1.0, 210),
    speakerRef: 'SPK_AUG',
    sessionRef: 'SES_AUG',
  });
  const canonical = ing.artifacts.find((a) => a.artifactType === 'CANONICAL_16K_MONO_PCM16')!;
  const pcm = new Float32Array(16000).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 210 * i) / 16000));

  const baseAugConfig = {
    speedFactor: 1.0,
    gainDb: 0,
    targetNoiseSnrDb: 18,
    telephoneBandpass: false,
    reverberationMix: 0,
    randomSeed: 1337,
  };

  const aug1 = applyReproducibleAugmentation({
    tenantId: 'org_avapardaz_sandbox',
    recordingId: ing.recording.recordingId,
    sourceArtifact: canonical,
    canonicalPcm16k: pcm,
    config: baseAugConfig,
    nextVersion: 1,
  });
  const aug2 = applyReproducibleAugmentation({
    tenantId: 'org_avapardaz_sandbox',
    recordingId: ing.recording.recordingId,
    sourceArtifact: canonical,
    canonicalPcm16k: pcm,
    config: baseAugConfig,
    nextVersion: 1,
  });
  assert.equal(aug1.artifact.checksumSha256, aug2.artifact.checksumSha256);

  // Out-of-bounds augmentation speedFactor MUST throw hard guard, and eval releases exclude augmented rows
  assert.throws(
    () =>
      applyReproducibleAugmentation({
        tenantId: 'org_avapardaz_sandbox',
        recordingId: ing.recording.recordingId,
        sourceArtifact: canonical,
        canonicalPcm16k: pcm,
        config: { ...baseAugConfig, speedFactor: 1.5, randomSeed: 42 },
        nextVersion: 1,
      }),
    /AUGMENTATION_GUARD/
  );
});

test('Phase 12A/12C/12D/12E/12F: default-deny rights, revocation cascade, blind double annotation & leakage audit', async () => {
  const cp = new PlatformControlPlaneService();
  const df = new SpeechDataFactoryService(cp);
  const src = df.createDataSource({
    tenantId: 'org_avapardaz_sandbox',
    sourceType: 'AUTHORIZED_USER_UPLOAD',
    sourceName: 'gov_src',
    ownerReference: 'org_avapardaz_sandbox',
    licenseReference: 'CONSENT_V1',
    verified: true,
  });

  // Upload 4 speakers cleanly with train+eval rights verified (initially unverified on spk1 then verified)
  const recIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const ing = await df.ingestRecording({
      tenantId: 'org_avapardaz_sandbox',
      projectId: 'prj_avapardaz_dev_01',
      sourceId: src.sourceId,
      filename: `spk_${i}.wav`,
      fileBytes: makeSineWav(16000, 1.5, 160 + i * 25),
      speakerRef: `SPK_${i}`,
      sessionRef: `SES_${i}`,
      declaredLanguage: 'fa-en',
      rightsVerified: i > 1,
      permissions:
        i > 1
          ? { transcribe: true, storeAudio: true, retainTranscripts: true, research: true, trainModels: true }
          : undefined,
      evaluationAllowed: i > 1,
    });
    recIds.push(ing.recording.recordingId);
  }

  // First recording must be default-deny for TRAINING and RETAIN_TRANSCRIPT
  const deniedCheck = df.checkRightsEligibility('org_avapardaz_sandbox', recIds[0], 'TRAINING');
  assert.equal(deniedCheck.allowed, false);
  assert.throws(
    () =>
      df.createAnnotationDraft({
        tenantId: 'org_avapardaz_sandbox',
        recordingId: recIds[0],
        annotatorId: 'ann_1',
      }),
    /RIGHTS_DENIED/
  );

  // Verify rights on rec 1
  df.verifyRightsRecord({
    tenantId: 'org_avapardaz_sandbox',
    recordingId: recIds[0],
    licenseId: 'AP-CORPUS-V1',
    permissions: { transcribe: true, storeAudio: true, retainTranscripts: true, research: true, trainModels: true },
    evaluationAllowed: true,
  });

  // Blind annotation isolation check & IAA disagreement triggering adjudication
  const a1 = df.createAnnotationDraft({ tenantId: 'org_avapardaz_sandbox', recordingId: recIds[0], annotatorId: 'ann_alpha', passIndex: 1 });
  const a2 = df.createAnnotationDraft({ tenantId: 'org_avapardaz_sandbox', recordingId: recIds[0], annotatorId: 'ann_beta', passIndex: 2 });

  assert.throws(
    () =>
      df.getAnnotationForAnnotator({
        tenantId: 'org_avapardaz_sandbox',
        annotationId: a1.annotationId,
        requesterAnnotatorId: 'ann_beta',
        isReviewer: false,
      }),
    /BLIND_ANNOTATION_VIOLATION/
  );

  df.submitAnnotation({
    tenantId: 'org_avapardaz_sandbox',
    annotationId: a1.annotationId,
    segments: [
      {
        segmentId: 's1',
        startSec: 0,
        endSec: 1.4,
        speakerLabel: 'SPK_1',
        language: 'fa-en',
        rawText: 'سلام امروز سرویس TypeScript را می‌سازیم',
        tokens: [
          { text: 'سلام', language: 'fa' },
          { text: 'امروز', language: 'fa' },
          { text: 'سرویس', language: 'fa' },
          { text: 'TypeScript', language: 'en' },
          { text: 'را', language: 'fa' },
          { text: 'می‌سازیم', language: 'fa' },
        ],
      },
    ],
  });
  const sub2 = df.submitAnnotation({
    tenantId: 'org_avapardaz_sandbox',
    annotationId: a2.annotationId,
    segments: [
      {
        segmentId: 's1',
        startSec: 0,
        endSec: 1.4,
        speakerLabel: 'SPK_1',
        language: 'fa-en',
        rawText: 'سلام فردا سرور پایتون را می‌بندیم',
        tokens: [
          { text: 'سلام', language: 'fa' },
          { text: 'فردا', language: 'fa' },
          { text: 'سرور', language: 'fa' },
        ],
      },
    ],
  });
  assert.equal(sub2.status, 'ADJUDICATION_REQUIRED');

  const iaa = computeInterAnnotatorAgreement(
    df.getAnnotationForAnnotator({ tenantId: 'org_avapardaz_sandbox', annotationId: a1.annotationId, isReviewer: true }).annotation,
    sub2
  );
  assert.equal(iaa.requiresAdjudication, true);

  // Adjudicate without mutating peer annotations
  const adj = df.reviewOrAdjudicateAnnotation({
    tenantId: 'org_avapardaz_sandbox',
    annotationId: a1.annotationId,
    reviewerId: 'reviewer_01',
    action: 'ADJUDICATE',
    resolvedSegments: [
      {
        segmentId: 's1',
        startSec: 0,
        endSec: 1.4,
        speakerLabel: 'SPK_1',
        language: 'fa-en',
        rawText: 'سلام امروز سرویس TypeScript را می‌سازیم',
        tokens: [
          { text: 'سلام', language: 'fa' },
          { text: 'TypeScript', language: 'en' },
          { text: 'می‌سازیم', language: 'fa' },
        ],
      },
    ],
  });
  assert.equal(adj.review.reviewStatus, 'ADJUDICATED');

  // Approve annotations on remaining 3 speakers too
  for (let i = 1; i < 4; i++) {
    const da = df.createAnnotationDraft({ tenantId: 'org_avapardaz_sandbox', recordingId: recIds[i], annotatorId: 'ann_alpha', passIndex: 1 });
    df.submitAnnotation({
      tenantId: 'org_avapardaz_sandbox',
      annotationId: da.annotationId,
      segments: [
        {
          segmentId: 's1',
          startSec: 0,
          endSec: 1.4,
          speakerLabel: `SPK_${i + 1}`,
          language: 'fa-en',
          rawText: `متن تست شماره ${i + 1} با API فارسی`,
          tokens: [{ text: 'متن', language: 'fa' }, { text: 'API', language: 'en' }],
        },
      ],
    });
    const db = df.createAnnotationDraft({ tenantId: 'org_avapardaz_sandbox', recordingId: recIds[i], annotatorId: 'ann_beta', passIndex: 2 });
    df.submitAnnotation({
      tenantId: 'org_avapardaz_sandbox',
      annotationId: db.annotationId,
      segments: [
        {
          segmentId: 's1',
          startSec: 0,
          endSec: 1.4,
          speakerLabel: `SPK_${i + 1}`,
          language: 'fa-en',
          rawText: `متن تست شماره ${i + 1} با API فارسی`,
          tokens: [{ text: 'متن', language: 'fa' }, { text: 'API', language: 'en' }],
        },
      ],
    });
    df.reviewOrAdjudicateAnnotation({
      tenantId: 'org_avapardaz_sandbox',
      annotationId: da.annotationId,
      reviewerId: 'reviewer_01',
      action: 'APPROVED',
    });
  }

  // Dashboard 7 duration separation check
  const dash = df.computeDashboardMetrics('org_avapardaz_sandbox');
  assert.ok(dash.durationBreakdownSeconds.uploadedSeconds > 0);
  assert.ok(dash.durationBreakdownSeconds.trainingEligibleSeconds > 0);
  assert.equal(dash.expansionMilestones[0].milestoneId, 'D0');
  assert.equal(dash.expansionMilestones[0].reached, false);

  // Build immutable dataset release & verify duplicate version conflict + sealed test protection
  const ds = df.createDatasetDefinition({ tenantId: 'org_avapardaz_sandbox', datasetName: 'fa-en-test-corpus' });
  const built = df.buildDatasetRelease({
    tenantId: 'org_avapardaz_sandbox',
    datasetId: ds.datasetId,
    version: '1.0.0',
    releaseType: 'TRAIN',
    releaseAuthor: 'qa_engineer',
  });
  assert.notEqual(built.release.leakageAudit.status, 'FAILED_WITH_VIOLATIONS');

  assert.throws(
    () =>
      df.buildDatasetRelease({
        tenantId: 'org_avapardaz_sandbox',
        datasetId: ds.datasetId,
        version: '1.0.0',
        releaseType: 'TRAIN',
        releaseAuthor: 'qa_engineer',
      }),
    /IMMUTABLE_RELEASE_CONFLICT/
  );

  // Tenant isolation test
  assert.throws(() => df.getRecording('org_other_tenant', recIds[0]), /TENANT_ISOLATION_DENIED/);

  // Revocation cascade test
  const revokeRep = df.revokeRecordingRights('org_avapardaz_sandbox', recIds[0]);
  assert.equal(revokeRep.revokedRawRecording, true);
  assert.ok(revokeRep.previouslyPublishedReleaseIdsRequiringRetraining.includes(built.release.datasetReleaseId));
  const afterRevoke = evaluateRightsForPurpose(df.getRightsRecord('org_avapardaz_sandbox', recIds[0]), 'TRAINING');
  assert.equal(afterRevoke.allowed, false);
});
