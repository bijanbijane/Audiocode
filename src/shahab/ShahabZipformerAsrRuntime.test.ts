import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SHAHAB_ZIPFORMER_MODEL_DIR,
  ShahabZipformerAsrRuntime,
  ShahabZipformerRuntimeError,
} from './ShahabZipformerAsrRuntime';
import {
  encodeMonoFloat32To16kWavBytes,
  mapShahabResponseToPersianWordTokens,
} from '../asr-core/ShahabLocalHttpClient';
import { SmartAudioEditPipeline } from '../workflow/SmartAudioEditPipeline';

test('1. encodeMonoFloat32To16kWavBytes resamples 48kHz to valid 16kHz mono PCM16 RIFF WAV', () => {
  const pcm48k = new Float32Array(48_000); // 1 second
  for (let i = 0; i < pcm48k.length; i++) {
    pcm48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5;
  }
  const wav = encodeMonoFloat32To16kWavBytes(pcm48k, 48_000);
  assert.equal(wav.byteLength, 44 + 16_000 * 2);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const riff = String.fromCharCode(wav[0], wav[1], wav[2], wav[3]);
  const wave = String.fromCharCode(wav[8], wav[9], wav[10], wav[11]);
  assert.equal(riff, 'RIFF');
  assert.equal(wave, 'WAVE');
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16_000); // 16 kHz
  assert.equal(view.getUint16(34, true), 16); // 16-bit PCM
});

test('2. Missing model directory reports unavailable and fails with MODEL_NOT_AVAILABLE', async () => {
  const missingDir = path.resolve(process.cwd(), 'models/__nonexistent_shahab_dir__');
  const runtime = new ShahabZipformerAsrRuntime({ modelDir: missingDir });
  const status = runtime.getRuntimeStatus();
  assert.equal(status.available, false);
  assert.equal(status.missingFiles.length, 4);
  assert.equal(status.sampleAudioAvailable, false);

  const silenceWav = Buffer.from(encodeMonoFloat32To16kWavBytes(new Float32Array(16_000), 16_000));
  await assert.rejects(
    () =>
      runtime.transcribe({
        sourceAudioId: 'aud_missing',
        audioBytes: silenceWav,
        filename: 'silence.wav',
      }),
    (err: unknown) =>
      err instanceof ShahabZipformerRuntimeError && err.code === 'MODEL_NOT_AVAILABLE',
  );
});

test('3. Real SHAHAB Zipformer runtime transcribes bundled Persian sample.wav with valid monotonic tokens and runs SmartAudioEditPipeline', async () => {
  const runtime = new ShahabZipformerAsrRuntime({ modelDir: DEFAULT_SHAHAB_ZIPFORMER_MODEL_DIR });
  try {
    const status = runtime.getRuntimeStatus();
    assert.equal(status.available, true, 'Expected verified Zipformer weights on disk');
    assert.equal(status.sampleAudioAvailable, true, 'Expected bundled sample.wav on disk');
    assert.equal(status.missingFiles.length, 0);

    const sample = runtime.getBundledSampleAudioPath();
    assert.ok(sample && fs.existsSync(sample.filePath));
    const wavBytes = fs.readFileSync(sample.filePath);

    // 3A. Direct runtime transcription
    const { transcript, metrics } = await runtime.transcribe({
      sourceAudioId: 'aud_sample_persian',
      audioBytes: wavBytes,
      filename: 'sample.wav',
      decodePolicy: 'SPEED',
    });

    assert.equal(transcript.offlineVerified, true);
    assert.equal(transcript.runtime, 'shahab-zipformer-onnx-cpu');
    assert.equal(transcript.modelId, 'persian-zipformer-transducer');
    assert.ok(transcript.rawText.trim().length > 0, 'Expected non-empty Persian verbatim transcript');
    assert.ok(transcript.tokens.length > 0, 'Expected non-empty timed tokens');
    assert.ok(metrics.realTimeFactor > 0);
    assert.ok(metrics.durationSec > 1);

    for (let i = 0; i < transcript.tokens.length; i++) {
      const tok = transcript.tokens[i];
      assert.equal(tok.timestampGranularity, 'SEGMENT_ESTIMATED');
      assert.ok(tok.startSample >= 0);
      assert.ok(tok.endSample > tok.startSample);
      assert.ok(tok.endSample <= transcript.totalSourceSamples);
      if (i > 0) {
        assert.ok(tok.startSample >= transcript.tokens[i - 1].startSample);
      }
    }

    // Verify browser token projection helper produces valid flick ranges
    const uiTokens = mapShahabResponseToPersianWordTokens({
      response: { ok: true, transcript, metrics },
      trackId: 'track-1',
      speakerName: 'گوینده فارسی',
    });
    assert.equal(uiTokens.length, transcript.tokens.length);
    assert.ok(uiTokens.every((t) => t.range.endFlicks > t.range.startFlicks));

    // 3B. Silent audio produces 0 words (never hallucinates speech)
    const silenceWav = Buffer.from(encodeMonoFloat32To16kWavBytes(new Float32Array(16_000), 16_000));
    const silentOut = await runtime.transcribe({
      sourceAudioId: 'aud_silence',
      audioBytes: silenceWav,
      filename: 'silence.wav',
      decodePolicy: 'SPEED',
    });
    assert.equal(silentOut.transcript.tokens.length, 0);
    assert.equal(silentOut.transcript.rawText, '');

    // 3C. Full Engine 01 (SHAHAB Zipformer) -> Engine 02 (Smart Edit Decision) pipeline
    const pipeline = new SmartAudioEditPipeline({ asrEngine: runtime });
    const imported = pipeline.importAndNormalizeAudio({
      audioFilePath: sample.filePath,
      filename: 'sample.wav',
    });
    const afterAsr = await pipeline.transcribe({
      job: imported.job,
      session: imported.session,
      audio: imported.audio,
      languageHint: 'fa',
    });
    assert.ok(afterAsr.session.transcript);
    assert.ok(afterAsr.session.transcript.tokens.length > 0);
    assert.equal(afterAsr.session.transcript.modelId, 'persian-zipformer-transducer');

    const afterE02 = await pipeline.analyzeAndGenerateEdl({
      job: afterAsr.job,
      session: afterAsr.session,
      audio: imported.audio,
    });
    assert.equal(afterE02.job.status, 'WAITING_USER_APPROVAL');
    assert.ok(afterE02.session.edl);
    assert.equal(afterE02.session.edl.validation.isValid, true);
  } finally {
    await runtime.dispose();
  }
});
