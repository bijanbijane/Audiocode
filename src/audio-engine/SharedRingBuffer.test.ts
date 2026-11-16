import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedAudioRingBuffer } from './SharedRingBuffer';

test('SharedAudioRingBuffer pushes and pulls wrap-around frames with zero underruns', () => {
  const rb = new SharedAudioRingBuffer(256, 2);
  rb.setPlaying(true);

  const srcL = new Float32Array(200);
  const srcR = new Float32Array(200);
  for (let i = 0; i < 200; i++) {
    srcL[i] = i * 0.001;
    srcR[i] = -i * 0.001;
  }

  const pushed = rb.push([srcL, srcR], 200);
  assert.equal(pushed, 200);
  assert.equal(rb.availableRead(), 200);

  // Pull 128 frames (standard AudioWorklet quantum)
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  assert.equal(rb.pull([outL, outR], 128), true);
  assert.ok(Math.abs(outL[127] - 0.127) < 1e-6);
  assert.equal(rb.getUnderrunCount(), 0);

  // Push another 150 frames (forces circular wrap-around past index 256)
  const pushed2 = rb.push([srcL, srcR], 150);
  assert.equal(pushed2, 150);

  // Pull next 128 frames across the wrap boundary
  assert.equal(rb.pull([outL, outR], 128), true);
  assert.ok(Math.abs(outL[0] - 0.128) < 1e-6);
  assert.ok(Math.abs(outL[72] - 0.0) < 1e-6); // start of second push
  assert.equal(rb.getUnderrunCount(), 0);

  // Pulling more than available triggers underrun counter and outputs silence
  assert.equal(rb.pull([outL, outR], 128), false);
  assert.equal(rb.getUnderrunCount(), 1);
  assert.equal(outL[0], 0);
});
