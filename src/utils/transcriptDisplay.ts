export interface SpeakerTokenLike {
  speakerName?: string | null;
}

/**
 * Returns the formatted speaker prefix (`"<name>:"`) only at the start of a
 * speaker turn (first token or when the speaker changes from the previous token).
 * Consecutive tokens spoken by the same speaker return an empty string.
 */
export function resolveSpeakerTurnLabel(
  tokens: ReadonlyArray<SpeakerTokenLike>,
  index: number,
): string {
  if (index < 0 || index >= tokens.length) return '';
  const currentSpeaker = (tokens[index]?.speakerName ?? '').trim();
  if (currentSpeaker.length === 0) return '';
  if (index === 0) return `${currentSpeaker}:`;
  const previousSpeaker = (tokens[index - 1]?.speakerName ?? '').trim();
  return previousSpeaker !== currentSpeaker ? `${currentSpeaker}:` : '';
}
