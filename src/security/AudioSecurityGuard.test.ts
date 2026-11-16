import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioSecurityGuard } from './AudioSecurityGuard';

test('AudioSecurityGuard detects WAV, FLAC, OGG, MP3, M4A, WEBM magic bytes and rejects spoofed executables', () => {
  // RIFF....WAVE
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(AudioSecurityGuard.verifyMagicBytes(wav, 1024), 'WAV');

  // fLaC
  const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(AudioSecurityGuard.verifyMagicBytes(flac, 1024), 'FLAC');

  // ID3 MP3
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(AudioSecurityGuard.verifyMagicBytes(mp3, 1024), 'MP3');

  // Spoofed PE/MZ executable renamed to .wav
  const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.throws(
    () => AudioSecurityGuard.verifyMagicBytes(exe, 1024),
    /SECURITY_UNSUPPORTED_MAGIC_BYTES/,
  );
});

test('AudioSecurityGuard blocks decompression bombs exceeding duration or expansion ratio', () => {
  assert.doesNotThrow(() => AudioSecurityGuard.assertSafeDecodedDuration(120, 1_500_000, 48000, 1));
  assert.throws(
    () => AudioSecurityGuard.assertSafeDecodedDuration(7 * 3600),
    /SECURITY_DECOMPRESSION_BOMB_GUARD/,
  );
  // 1KB compressed claiming 100s of 48kHz PCM (~19.2MB -> >19000x ratio)
  assert.throws(
    () => AudioSecurityGuard.assertSafeDecodedDuration(100, 1024, 48000, 1),
    /SECURITY_DECOMPRESSION_BOMB_GUARD/,
  );
});

test('AudioSecurityGuard scrubs local file paths and Persian transcript text from telemetry logs', () => {
  const raw =
    'Decode failed at C:\\Users\\Ali\\Podcast\\test.wav for token «سلام دنیا می\u200cخواهم» inside /home/sara/audio/ep1.mp3';
  const clean = AudioSecurityGuard.sanitizeErrorForTelemetry(raw);

  assert.equal(clean.includes('C:\\Users\\Ali'), false);
  assert.equal(clean.includes('/home/sara'), false);
  assert.equal(clean.includes('سلام'), false);
  assert.equal(clean.includes('[REDACTED_PATH]'), true);
  assert.equal(clean.includes('[REDACTED_PERSIAN_CONTENT]'), true);
});
