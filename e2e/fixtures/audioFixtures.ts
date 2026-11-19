import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GeneratedAudioFixtureSet {
  readonly dirPath: string;
  readonly validSpeechWavPath: string;
  readonly emptyWavPath: string;
  readonly malformedWavPath: string;
  readonly unsupportedTxtPath: string;
  readonly cleanup: () => void;
}

/**
 * Generates a deterministic 16-bit PCM mono WAV buffer containing speech-like
 * formant syllables separated by realistic pauses (zero copyrighted/personal audio).
 */
export function buildDeterministicSpeechWavBuffer(
  durationSec = 2.4,
  sampleRate = 16_000,
): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM integer
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const inBurst1 = t >= 0.15 && t <= 0.75;
    const inBurst2 = t >= 1.45 && t <= 2.15;
    let sample = 0.002 * Math.sin(2 * Math.PI * 55 * t);
    if (inBurst1 || inBurst2) {
      const f0 = inBurst1 ? 185 : 205;
      const formant1 = Math.sin(2 * Math.PI * f0 * t);
      const formant2 = 0.45 * Math.sin(2 * Math.PI * (f0 * 2.5) * t);
      const formant3 = 0.2 * Math.sin(2 * Math.PI * (f0 * 4.2) * t);
      sample = 0.35 * (formant1 + formant2 + formant3);
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return buf;
}

export function createTempAudioFixtures(): GeneratedAudioFixtureSet {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'avapardaz-e2e-'));
  const validSpeechWavPath = path.join(dirPath, 'deterministic-speech-fixture.wav');
  const emptyWavPath = path.join(dirPath, 'empty-zero-bytes.wav');
  const malformedWavPath = path.join(dirPath, 'malformed-corrupt.wav');
  const unsupportedTxtPath = path.join(dirPath, 'unsupported-notes.txt');

  fs.writeFileSync(validSpeechWavPath, buildDeterministicSpeechWavBuffer(2.4, 16_000));
  fs.writeFileSync(emptyWavPath, Buffer.alloc(0));
  fs.writeFileSync(malformedWavPath, Buffer.from('RIFF\x00\x00\x00\x00BAD_HEADER_NOT_WAVE_PAYLOAD', 'ascii'));
  fs.writeFileSync(unsupportedTxtPath, 'This is plain text, not an audio recording.', 'utf-8');

  return {
    dirPath,
    validSpeechWavPath,
    emptyWavPath,
    malformedWavPath,
    unsupportedTxtPath,
    cleanup: () => {
      fs.rmSync(dirPath, { recursive: true, force: true });
    },
  };
}
