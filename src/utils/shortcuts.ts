export interface ShortcutEventLike {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

const KEY_ALIAS_TO_CODE: Record<string, string> = {
  space: 'Space',
  ' ': 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  comma: 'Comma',
  ',': 'Comma',
  period: 'Period',
  '.': 'Period',
  slash: 'Slash',
  '/': 'Slash',
};

function normalizeTokenToCode(token: string): string {
  const lower = token.trim().toLowerCase();
  if (KEY_ALIAS_TO_CODE[lower]) return KEY_ALIAS_TO_CODE[lower];
  if (/^key[a-z]$/.test(lower)) return `Key${lower.slice(3).toUpperCase()}`;
  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
  if (/^digit[0-9]$/.test(lower)) return `Digit${lower.slice(5)}`;
  if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
  return token.trim();
}

function normalizeEventCode(event: ShortcutEventLike): string {
  if (event.code && event.code.trim().length > 0) {
    return event.code.trim();
  }
  if (event.key && event.key.length > 0) {
    return normalizeTokenToCode(event.key);
  }
  return '';
}

export function matchesShortcutBinding(
  event: ShortcutEventLike,
  binding: string,
): boolean {
  const trimmed = binding.trim();
  if (!trimmed) return false;

  const parts = trimmed
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;

  let expectMod = false;
  let expectCtrl = false;
  let expectMeta = false;
  let expectShift = false;
  let expectAlt = false;
  const keyTokens: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod') {
      expectMod = true;
    } else if (lower === 'ctrl' || lower === 'control') {
      expectCtrl = true;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command') {
      expectMeta = true;
    } else if (lower === 'shift') {
      expectShift = true;
    } else if (lower === 'alt' || lower === 'option') {
      expectAlt = true;
    } else {
      keyTokens.push(part);
    }
  }

  if (keyTokens.length !== 1) return false;
  const targetToken = keyTokens[0];
  const expectedCode = normalizeTokenToCode(targetToken);

  const hasCtrl = Boolean(event.ctrlKey);
  const hasMeta = Boolean(event.metaKey);
  const hasShift = Boolean(event.shiftKey);
  const hasAlt = Boolean(event.altKey);

  if (expectMod) {
    if (!hasCtrl && !hasMeta) return false;
  } else {
    if (expectCtrl !== hasCtrl) return false;
    if (expectMeta !== hasMeta) return false;
  }

  if (expectShift !== hasShift) return false;
  if (expectAlt !== hasAlt) return false;

  const evCode = normalizeEventCode(event);
  if (evCode && evCode.toLowerCase() === expectedCode.toLowerCase()) {
    return true;
  }

  if (event.key && event.key.trim().toLowerCase() === targetToken.trim().toLowerCase()) {
    return true;
  }

  return false;
}
