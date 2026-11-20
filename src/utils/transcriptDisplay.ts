import type { PersianWordToken } from '../contracts/v1_2';
import { msToFlicks, secondsToFlicks } from '../engine/timebase';
import type { CompanionTranscriptionSegment } from '../host-bridge/companion/CompanionWebClient';

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

function normalizeWordForOverlapMatch(word: string): string {
  return word
    .trim()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\s.,،؛؟!?:«»"'()[\]-]+/g, '')
    .toLowerCase();
}

interface RawTimedWord {
  word: string;
  startSec: number;
  endSec: number;
  alignmentSource: 'ASR' | 'AcousticSnap';
  confidence: number;
}

/**
 * Converts Local Companion ASR segments into canonical PersianWordToken[] objects,
 * deduplicating overlapping words emitted across >25s chunk seams.
 */
export function buildCompanionTranscriptTokens(params: {
  readonly segments: ReadonlyArray<CompanionTranscriptionSegment>;
  readonly trackId: string;
  readonly speakerName: string;
}): PersianWordToken[] {
  const speaker = params.speakerName.trim() || 'گوینده ۱';
  const collected: RawTimedWord[] = [];

  for (const seg of params.segments) {
    const segWords: RawTimedWord[] = [];
    if (seg.words && seg.words.length > 0) {
      for (const w of seg.words) {
        const clean = w.word.trim();
        if (!clean) continue;
        const startSec = Number.isFinite(w.startSec) ? Math.max(0, w.startSec) : Math.max(0, seg.startSec);
        const endSec = Number.isFinite(w.endSec)
          ? Math.max(startSec + 0.04, w.endSec)
          : startSec + 0.08;
        segWords.push({
          word: clean,
          startSec,
          endSec,
          alignmentSource: 'ASR',
          confidence: 0.9,
        });
      }
    } else if (seg.text && seg.text.trim().length > 0) {
      const splitWords = seg.text.trim().split(/\s+/).filter(Boolean);
      const segStart = Number.isFinite(seg.startSec) ? Math.max(0, seg.startSec) : 0;
      const segEnd = Number.isFinite(seg.endSec) ? Math.max(segStart + 0.1, seg.endSec) : segStart + 0.5;
      const step = (segEnd - segStart) / Math.max(1, splitWords.length);
      splitWords.forEach((word, idx) => {
        const ws = segStart + idx * step;
        const we = Math.max(ws + 0.04, ws + step);
        segWords.push({
          word,
          startSec: ws,
          endSec: we,
          alignmentSource: 'AcousticSnap',
          confidence: 0.85,
        });
      });
    }

    if (segWords.length === 0) continue;

    // Deduplicate overlapping words at chunk seam (when segment overlaps prior end timestamp)
    let skipPrefixCount = 0;
    if (collected.length > 0) {
      const prevEndSec = collected[collected.length - 1].endSec;
      const firstNewStartSec = segWords[0].startSec;
      if (firstNewStartSec <= prevEndSec + 0.5) {
        const maxWindow = Math.min(6, collected.length, segWords.length);
        for (let k = maxWindow; k >= 1; k--) {
          let allMatch = true;
          for (let j = 0; j < k; j++) {
            const prevNorm = normalizeWordForOverlapMatch(collected[collected.length - k + j].word);
            const nextNorm = normalizeWordForOverlapMatch(segWords[j].word);
            if (!prevNorm || prevNorm !== nextNorm) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            skipPrefixCount = k;
            break;
          }
        }
      }
    }

    for (let i = skipPrefixCount; i < segWords.length; i++) {
      collected.push(segWords[i]);
    }
  }

  return collected.map((item, idx) => {
    const startF = secondsToFlicks(item.startSec);
    const endF = Math.max(startF + msToFlicks(40), secondsToFlicks(item.endSec));
    return {
      id: `tok_local_${idx}`,
      trackId: params.trackId,
      speakerName: speaker,
      originalText: item.word,
      normalizedText: item.word,
      displayText: item.word,
      range: {
        startFlicks: startF,
        endFlicks: endF,
      },
      confidence: item.confidence,
      alignmentSource: item.alignmentSource,
      detectedLanguage: /[A-Za-z]/.test(item.word) ? 'EN' : 'FA',
    };
  });
}
