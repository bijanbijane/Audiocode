import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesShortcutBinding } from './shortcuts';
import { DEFAULT_SHORTCUTS } from '../settings/settingsStore';

test('matches DEFAULT_SHORTCUTS bindings accurately', () => {
  assert.equal(matchesShortcutBinding({ code: 'Space', key: ' ' }, DEFAULT_SHORTCUTS.playPause), true);
  assert.equal(matchesShortcutBinding({ code: 'Space', ctrlKey: true }, DEFAULT_SHORTCUTS.playPause), false);

  assert.equal(matchesShortcutBinding({ code: 'ArrowLeft' }, DEFAULT_SHORTCUTS.seekBackward), true);
  assert.equal(matchesShortcutBinding({ code: 'ArrowRight' }, DEFAULT_SHORTCUTS.seekForward), true);
  assert.equal(matchesShortcutBinding({ code: 'KeyL', key: 'l' }, DEFAULT_SHORTCUTS.toggleLoop), true);
  assert.equal(matchesShortcutBinding({ code: 'Escape', key: 'Escape' }, DEFAULT_SHORTCUTS.clearSelection), true);

  assert.equal(matchesShortcutBinding({ code: 'KeyZ', ctrlKey: true }, DEFAULT_SHORTCUTS.undo), true);
  assert.equal(matchesShortcutBinding({ code: 'KeyZ', metaKey: true }, DEFAULT_SHORTCUTS.undo), true);
  assert.equal(
    matchesShortcutBinding({ code: 'KeyZ', ctrlKey: true, shiftKey: true }, DEFAULT_SHORTCUTS.undo),
    false,
  );
  assert.equal(
    matchesShortcutBinding({ code: 'KeyZ', ctrlKey: true, shiftKey: true }, DEFAULT_SHORTCUTS.redo),
    true,
  );

  assert.equal(matchesShortcutBinding({ code: 'KeyE', ctrlKey: true }, DEFAULT_SHORTCUTS.openExport), true);
  assert.equal(matchesShortcutBinding({ code: 'Comma', ctrlKey: true }, DEFAULT_SHORTCUTS.openSettings), true);
});

test('matches custom user-entered shortcuts and prevents modifier mismatch', () => {
  assert.equal(matchesShortcutBinding({ code: 'KeyK', key: 'k' }, 'k'), true);
  assert.equal(matchesShortcutBinding({ code: 'KeyK', key: 'k' }, 'KeyK'), true);
  assert.equal(matchesShortcutBinding({ code: 'KeyK', shiftKey: true }, 'Shift+KeyK'), true);
  assert.equal(matchesShortcutBinding({ code: 'KeyK' }, 'Shift+KeyK'), false);
  assert.equal(matchesShortcutBinding({ code: 'Space' }, ''), false);
});
