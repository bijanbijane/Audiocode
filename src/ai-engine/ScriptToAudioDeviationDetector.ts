import { TimedPersianToken, PersianTextNormalizer } from './PersianTextNormalizer';
import { CustomPersianLexiconManager } from './CustomPersianLexiconManager';
import { TimeRange } from '../contracts/timebase.contract';

export type ScriptDeviationKind =
  | 'OMITTED_FROM_BOOK'      // Word/phrase present in book manuscript but skipped by narrator
  | 'EXTRA_SPOKEN_RETAKE'    // Extra word or unedited retake spoken outside the manuscript
  | 'NARRATOR_MISREAD_WORD'; // Word substituted/misread by narrator compared to manuscript

export interface ScriptDeviationFinding {
  readonly findingId: string;
  readonly kind: ScriptDeviationKind;
  readonly expectedBookText: string;
  readonly actualSpokenText: string;
  readonly audioRange: TimeRange;
  readonly descriptionFa: string;
}

/**
 * Audiobook Manuscript-to-Audio Deviation Detector (Section 2.6)
 * Aligns a reference Persian book script against ASR/CTC timed tokens using
 * Needleman-Wunsch global sequence alignment over phonetic skeletons so homophone
 * ASR spelling differences do not trigger false alarms.
 */
export class ScriptToAudioDeviationDetector {
  public static detectNarratorDeviations(
    referenceBookScript: string,
    spokenTokens: readonly TimedPersianToken[],
  ): ScriptDeviationFinding[] {
    const bookWords = PersianTextNormalizer.normalizeTokenText(referenceBookScript)
      .replace(/[،؛.!؟«»"()\-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    if (bookWords.length === 0 || spokenTokens.length === 0) return [];

    const bookSkeletons = bookWords.map((w) =>
      CustomPersianLexiconManager.toPersianPhoneticSkeleton(w),
    );
    const spokenSkeletons = spokenTokens.map((t) =>
      CustomPersianLexiconManager.toPersianPhoneticSkeleton(t.normalizedText),
    );

    const n = bookWords.length;
    const m = spokenTokens.length;

    // Needleman-Wunsch DP score and traceback (1: Match/Sub, 2: Omission from book, 3: Extra spoken)
    const score = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    const ptr = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

    const GAP_PENALTY = -2;
    for (let i = 1; i <= n; i++) {
      score[i][0] = i * GAP_PENALTY;
      ptr[i][0] = 2;
    }
    for (let j = 1; j <= m; j++) {
      score[0][j] = j * GAP_PENALTY;
      ptr[0][j] = 3;
    }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const isPhoneticEqual = bookSkeletons[i - 1] === spokenSkeletons[j - 1];
        const matchScore = score[i - 1][j - 1] + (isPhoneticEqual ? 3 : -3);
        const omitScore = score[i - 1][j] + GAP_PENALTY;
        const extraScore = score[i][j - 1] + GAP_PENALTY;

        if (matchScore >= omitScore && matchScore >= extraScore) {
          score[i][j] = matchScore;
          ptr[i][j] = 1;
        } else if (omitScore >= extraScore) {
          score[i][j] = omitScore;
          ptr[i][j] = 2;
        } else {
          score[i][j] = extraScore;
          ptr[i][j] = 3;
        }
      }
    }

    const findings: ScriptDeviationFinding[] = [];
    let i = n;
    let j = m;

    while (i > 0 || j > 0) {
      const move = ptr[i][j];
      if (i > 0 && j > 0 && move === 1) {
        if (bookSkeletons[i - 1] !== spokenSkeletons[j - 1]) {
          const tok = spokenTokens[j - 1];
          findings.push({
            findingId: `dev_sub_${i}_${j}`,
            kind: 'NARRATOR_MISREAD_WORD',
            expectedBookText: bookWords[i - 1],
            actualSpokenText: tok.displayText,
            audioRange: tok.range,
            descriptionFa: `در متن کتاب «${bookWords[i - 1]}» آمده اما گوینده «${tok.displayText}» خوانده است.`,
          });
        }
        i--;
        j--;
      } else if (i > 0 && (j === 0 || move === 2)) {
        const anchorToken =
          spokenTokens[Math.min(m - 1, Math.max(0, j))] ?? spokenTokens[0];
        findings.push({
          findingId: `dev_omit_${i}`,
          kind: 'OMITTED_FROM_BOOK',
          expectedBookText: bookWords[i - 1],
          actualSpokenText: '[خوانده نشده]',
          audioRange: anchorToken.range,
          descriptionFa: `واژه «${bookWords[i - 1]}» از متن کتاب جا افتاده است.`,
        });
        i--;
      } else {
        const tok = spokenTokens[j - 1];
        findings.push({
          findingId: `dev_extra_${j}`,
          kind: 'EXTRA_SPOKEN_RETAKE',
          expectedBookText: '',
          actualSpokenText: tok.displayText,
          audioRange: tok.range,
          descriptionFa: `واژه اضافه یا تکراری «${tok.displayText}» خارج از متن کتاب بیان شده است.`,
        });
        j--;
      }
    }

    return findings.reverse();
  }
}
