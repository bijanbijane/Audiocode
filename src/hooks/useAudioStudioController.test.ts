import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAutoScrollViewport,
  createSharedMemoryClockReader,
  dispatchStudioShortcutKeyDown,
  findActiveTokenIdAtFlicks,
} from './useAudioStudioController';
import { PersianTextNormalizer, TimedPersianToken } from '../ai-engine/PersianTextNormalizer';
import { CTRL_STATE } from '../audio-engine/SharedRingBuffer';
import { TimeMath } from '../contracts/timebase.contract';

test('findActiveTokenIdAtFlicks locates exact half-open [start, end) token in O(log N) over 50,000 tokens', () => {
  const tokens: TimedPersianToken[] = [];
  for (let i = 0; i < 50_000; i++) {
    tokens.push(
      PersianTextNormalizer.createToken({
        tokenId: `tok_${i}`,
        trackId: 'track-1',
        originalText: `کلمه_${i}`,
        startFlicks: TimeMath.secondsToFlicks(i * 0.25),
        endFlicks: TimeMath.secondsToFlicks((i + 1) * 0.25),
        confidence: 0.96,
      }),
    );
  }

  const tStart = performance.now();
  const match = findActiveTokenIdAtFlicks(tokens, TimeMath.secondsToFlicks(12345 * 0.25 + 0.1));
  const atBoundary = findActiveTokenIdAtFlicks(tokens, TimeMath.secondsToFlicks(100 * 0.25));
  const outOfRange = findActiveTokenIdAtFlicks(tokens, TimeMath.secondsToFlicks(50_000 * 0.25));
  const elapsedMs = performance.now() - tStart;

  assert.equal(match, 'tok_12345');
  assert.equal(atBoundary, 'tok_100'); // [start, end) half-open boundary belongs to next token
  assert.equal(outOfRange, null);
  assert.ok(elapsedMs < 10, `Binary search took too long: ${elapsedMs}ms`);
});

test('createSharedMemoryClockReader reads Atomics sample frame & playing flag from SharedArrayBuffer', () => {
  const sab = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(sab);
  Atomics.store(view, CTRL_STATE.READ_INDEX, 96_000);
  Atomics.store(view, CTRL_STATE.IS_PLAYING, 1);

  let toggled = 0;
  let rateSet = 1.0;
  let seekedTo = -1;

  const reader = createSharedMemoryClockReader({
    controlBuffer: sab,
    onTogglePlayPause: () => {
      toggled++;
      const cur = Atomics.load(view, CTRL_STATE.IS_PLAYING);
      Atomics.store(view, CTRL_STATE.IS_PLAYING, cur === 1 ? 0 : 1);
    },
    onSetPlaybackRate: (rate) => {
      rateSet = rate;
    },
    onSeekToSample: (s) => {
      seekedTo = s;
      Atomics.store(view, CTRL_STATE.READ_INDEX, s);
    },
  });

  assert.equal(reader.readCurrentSampleFrameAtomically(), 96_000);
  assert.equal(reader.isPlaying(), true);

  reader.setPlaybackRate(1.5);
  assert.equal(rateSet, 1.5);

  reader.seekToSample(144_000);
  assert.equal(seekedTo, 144_000);
  assert.equal(reader.readCurrentSampleFrameAtomically(), 144_000);

  reader.togglePlayPause();
  assert.equal(toggled, 1);
  assert.equal(reader.isPlaying(), false);
});

test('computeAutoScrollViewport advances page only when actively playing past viewport edge', () => {
  const initial = {
    start: TimeMath.secondsToFlicks(0),
    end: TimeMath.secondsToFlicks(30),
  };

  const pausedPastEnd = computeAutoScrollViewport(initial, TimeMath.secondsToFlicks(32), false);
  assert.deepEqual(pausedPastEnd, initial);

  const playingPastEnd = computeAutoScrollViewport(initial, TimeMath.secondsToFlicks(31), true);
  assert.equal(playingPastEnd.start, TimeMath.secondsToFlicks(31));
  assert.equal(playingPastEnd.end, TimeMath.secondsToFlicks(61));
});

test('dispatchStudioShortcutKeyDown handles Space/J/K/L/S/Undo/Redo and suspends inside text inputs', () => {
  let playing = false;
  let samplePos = 48_000 * 5; // 5s
  let speed = 1.0;
  let undoCount = 0;
  let redoCount = 0;
  let splitAtFlicks: number | null = null;

  const reader = {
    readCurrentSampleFrameAtomically: () => samplePos,
    isPlaying: () => playing,
    setPlaybackRate: (r: number) => {
      speed = r;
    },
    togglePlayPause: () => {
      playing = !playing;
    },
    seekToSample: (s: number) => {
      samplePos = s;
    },
  };

  const makeEvt = (overrides: Partial<KeyboardEvent>) => ({
    target: { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: '',
    code: '',
    preventDefault: () => {},
    ...overrides,
  });

  const makeCtx = () => ({
    clockReader: reader,
    sampleRate: 48000 as const,
    currentShuttleSpeed: speed,
    onSetShuttleSpeed: (s: number) => {
      speed = s;
    },
    onUndo: () => {
      undoCount++;
    },
    onRedo: () => {
      redoCount++;
    },
    onSplitAtPlayhead: (flicks: number) => {
      splitAtFlicks = flicks;
    },
  });

  // Space starts playback
  assert.equal(dispatchStudioShortcutKeyDown(makeEvt({ code: 'Space', key: ' ' }), makeCtx()), true);
  assert.equal(playing, true);

  // KeyL cycles 1.0 -> 1.5 -> 2.0 -> 1.0
  dispatchStudioShortcutKeyDown(makeEvt({ code: 'KeyL', key: 'l' }), makeCtx());
  assert.equal(speed, 1.5);
  dispatchStudioShortcutKeyDown(makeEvt({ code: 'KeyL', key: 'l' }), makeCtx());
  assert.equal(speed, 2.0);

  // KeyK stops playback & resets shuttle speed to 1.0x
  dispatchStudioShortcutKeyDown(makeEvt({ code: 'KeyK', key: 'k' }), makeCtx());
  assert.equal(playing, false);
  assert.equal(speed, 1.0);

  // KeyJ jumps back 3 seconds
  dispatchStudioShortcutKeyDown(makeEvt({ code: 'KeyJ', key: 'j' }), makeCtx());
  assert.equal(samplePos, 48_000 * 2);

  // KeyS triggers split at current playhead flicks
  dispatchStudioShortcutKeyDown(makeEvt({ code: 'KeyS', key: 's' }), makeCtx());
  assert.equal(splitAtFlicks, TimeMath.secondsToFlicks(2));

  // Ctrl+Z and Ctrl+Shift+Z
  dispatchStudioShortcutKeyDown(makeEvt({ ctrlKey: true, key: 'z' }), makeCtx());
  dispatchStudioShortcutKeyDown(makeEvt({ ctrlKey: true, shiftKey: true, key: 'Z' }), makeCtx());
  assert.equal(undoCount, 1);
  assert.equal(redoCount, 1);

  // Guard: ignore shortcuts when user is editing Persian text in INPUT / TEXTAREA / contentEditable
  const blockedInput = dispatchStudioShortcutKeyDown(
    makeEvt({
      code: 'Space',
      key: ' ',
      target: { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget,
    }),
    makeCtx(),
  );
  const blockedEditable = dispatchStudioShortcutKeyDown(
    makeEvt({
      ctrlKey: true,
      key: 'z',
      target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget,
    }),
    makeCtx(),
  );
  assert.equal(blockedInput, false);
  assert.equal(blockedEditable, false);
  assert.equal(playing, false);
  assert.equal(undoCount, 1);
});
