import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Section 49 Rust streaming_decoder wires Symphonia fault tolerance, Decompression Bomb guard, and WasmSeekTableEntry', () => {
  const rootDir = process.cwd();
  const libRs = fs.readFileSync(path.join(rootDir, 'wasm-audio-core/src/lib.rs'), 'utf8');
  const decoderRs = fs.readFileSync(
    path.join(rootDir, 'wasm-audio-core/src/streaming_decoder.rs'),
    'utf8',
  );

  assert.match(libRs, /pub mod streaming_decoder;/);
  assert.match(libRs, /inspect_and_index_audio_container/);

  assert.match(decoderRs, /pub struct WasmSeekTableEntry/);
  assert.match(decoderRs, /pub struct SafeStreamingDecodeSummary/);
  assert.match(decoderRs, /pub fn inspect_and_index_audio_container/);
  assert.match(decoderRs, /SymphoniaError::DecodeError/);
  assert.match(decoderRs, /corrupted_packets_skipped \+= 1/);
  assert.match(decoderRs, /SECURITY_DECOMPRESSION_BOMB_ABORTED/);
  assert.match(decoderRs, /seek_table\.push\(WasmSeekTableEntry/);
});
