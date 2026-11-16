import { PersianTextNormalizer, TimedPersianToken } from './PersianTextNormalizer';
import { DisfluencyType } from '../contracts/persian-editing.contract';
import { Flicks, TimeMath, TimeRange } from '../contracts/timebase.contract';

export interface DetectedSpeechIssue {
  readonly issueId: string;
  readonly type: DisfluencyType;
  /** Suggested range to delete/shorten (Reparandum + Interregnum, preserving final Repair) */
  readonly targetRange: TimeRange;
  readonly affectedTokenIds: string[];
  readonly displayExcerpt: string;
  readonly reasonFa: string;
  readonly compositeConfidence: number;
  /** Natural pause duration to retain for LONG_PAUSE issues (in Flicks) */
  readonly suggestedRemainingPauseFlicks: Flicks;
}

export class PersianDisfluencyEngine {
  /** Prepositions/conjunctions where an immediate pause indicates mid-clause hesitation */
  private static readonly MID_CLAUSE_BOUNDARY_WORDS = new Set([
    'که', 'و', 'یا', 'از', 'به', 'در', 'با', 'برای', 'تا', 'چون', 'اگر', 'وقتی', 'چرا', 'چطور',
  ]);

  /** Common colloquial Persian discourse fillers when isolated by pauses */
  private static readonly PERSIAN_DISCOURSE_FILLERS: readonly string[] = [
    'عرضم به حضورتون',
    'خدمت شما عرض کنم',
    'به اصطلاح',
    'راستش رو بخواید',
    'حقیقتش',
    'خلاصه کلام',
  ].map((phrase) => PersianTextNormalizer.normalizeTokenText(phrase));

  private static readonly PURE_VOCAL_FILLERS = /^(ا+م+|ا+ه+|ا+و+م+|ه+م+|ا+آ+|آ+|ا{2,}|م{2,})$/;

  /**
   * Analyzes timed Persian tokens for self-repairs (Reparandum + Interregnum + Repair),
   * N-gram repetitions, vocal fillers, isolated discourse fillers, and abnormal pauses.
   */
  public static analyzeTranscript(
    tokens: TimedPersianToken[],
    maxNaturalMidPauseMs = 450,
    maxNaturalSentencePauseMs = 950,
  ): DetectedSpeechIssue[] {
    const issues: DetectedSpeechIssue[] = [];
    const consumedIndices = new Set<number>();

    // 1. N-gram Repetitions & Self-Repairs (1..4 words) + Vocal Fillers + Discourse Fillers
    for (let i = 0; i < tokens.length; i++) {
      if (consumedIndices.has(i)) continue;

      const repairMatch = this.detectNgramRepetitionWithInterregnum(
        tokens,
        i,
        consumedIndices,
      );
      if (repairMatch) {
        for (let k = repairMatch.deleteStartIdx; k <= repairMatch.deleteEndIdx; k++) {
          consumedIndices.add(k);
        }

        const deletedTokens = tokens.slice(
          repairMatch.deleteStartIdx,
          repairMatch.deleteEndIdx + 1,
        );
        const avgAsrConf =
          deletedTokens.reduce((acc, t) => acc + t.confidence, 0) / deletedTokens.length;

        issues.push({
          issueId: `rep_${tokens[i].tokenId}`,
          type: 'WORD_REPETITION',
          targetRange: {
            start: deletedTokens[0].range.start,
            end: deletedTokens[deletedTokens.length - 1].range.end,
          },
          affectedTokenIds: deletedTokens.map((t) => t.tokenId),
          displayExcerpt: deletedTokens.map((t) => t.displayText).join(' '),
          reasonFa:
            repairMatch.ngramLength > 1
              ? 'تکرار عبارت و اصلاح درجا (حذف بخش ناتمام اول و حفظ عبارت کامل دوم)'
              : 'تکرار متوالی کلمه',
          compositeConfidence: Number(Math.min(0.98, avgAsrConf * 0.95).toFixed(2)),
          suggestedRemainingPauseFlicks: TimeMath.secondsToFlicks(0.05),
        });
        continue;
      }

      // 2. Independent vocal fillers («اممم»، «ااا»)
      const tok = tokens[i];
      if (this.PURE_VOCAL_FILLERS.test(tok.normalizedText)) {
        consumedIndices.add(i);
        issues.push({
          issueId: `fil_${tok.tokenId}`,
          type: 'INDEPENDENT_FILLER',
          targetRange: tok.range,
          affectedTokenIds: [tok.tokenId],
          displayExcerpt: tok.displayText,
          reasonFa: 'تپق آوایی مستقل در میانه گفتار',
          compositeConfidence: Number(Math.min(0.96, tok.confidence * 0.92).toFixed(2)),
          suggestedRemainingPauseFlicks: TimeMath.secondsToFlicks(0.06),
        });
        continue;
      }

      // 3. Isolated Persian discourse fillers surrounded by pauses
      const discourseMatch = this.detectIsolatedDiscourseFiller(tokens, i, consumedIndices);
      if (discourseMatch) {
        for (let k = discourseMatch.startIdx; k <= discourseMatch.endIdx; k++) {
          consumedIndices.add(k);
        }
        const phraseTokens = tokens.slice(discourseMatch.startIdx, discourseMatch.endIdx + 1);
        const avgConf =
          phraseTokens.reduce((acc, t) => acc + t.confidence, 0) / phraseTokens.length;

        issues.push({
          issueId: `disc_${phraseTokens[0].tokenId}`,
          type: 'INDEPENDENT_FILLER',
          targetRange: {
            start: phraseTokens[0].range.start,
            end: phraseTokens[phraseTokens.length - 1].range.end,
          },
          affectedTokenIds: phraseTokens.map((t) => t.tokenId),
          displayExcerpt: phraseTokens.map((t) => t.displayText).join(' '),
          reasonFa: 'تکیه‌کلام یا حشو محاوره‌ای محصور در مکث',
          compositeConfidence: Number(Math.min(0.9, avgConf * 0.88).toFixed(2)),
          suggestedRemainingPauseFlicks: TimeMath.secondsToFlicks(0.08),
        });
      }
    }

    // 4. Mid-clause abnormal pauses vs. sentence-boundary pauses
    for (let i = 0; i < tokens.length - 1; i++) {
      if (consumedIndices.has(i) || consumedIndices.has(i + 1)) continue;

      const curr = tokens[i];
      const next = tokens[i + 1];
      const gapFlicks = next.range.start - curr.range.end;
      const gapMs = TimeMath.flicksToSeconds(gapFlicks) * 1000;

      if (gapMs <= maxNaturalMidPauseMs) continue;

      const isMidClause = this.MID_CLAUSE_BOUNDARY_WORDS.has(curr.normalizedText);
      const thresholdMs = isMidClause ? maxNaturalMidPauseMs : maxNaturalSentencePauseMs;

      if (gapMs > thresholdMs) {
        const targetRemainingMs = isMidClause ? 150 : 400;
        const targetRemainingFlicks = TimeMath.secondsToFlicks(targetRemainingMs / 1000);

        issues.push({
          issueId: `pause_${curr.tokenId}_${next.tokenId}`,
          type: 'LONG_PAUSE',
          targetRange: {
            start: curr.range.end,
            end: next.range.start,
          },
          affectedTokenIds: [],
          displayExcerpt: `[مکث ${(gapMs / 1000).toFixed(2)} ثانیه‌ای بین «${curr.displayText}» و «${next.displayText}»]`,
          reasonFa: isMidClause
            ? `مکث غیرطبیعی در میانه عبارت (پس از «${curr.displayText}»)`
            : 'سکوت طولانی بین دو جمله',
          compositeConfidence: isMidClause ? 0.91 : 0.85,
          suggestedRemainingPauseFlicks: targetRemainingFlicks,
        });
      }
    }

    return issues;
  }

  private static detectNgramRepetitionWithInterregnum(
    tokens: TimedPersianToken[],
    startIdx: number,
    consumedIndices: Set<number>,
  ): { deleteStartIdx: number; deleteEndIdx: number; ngramLength: number } | null {
    // Do not treat vocal fillers as the start of a lexical N-gram repetition
    if (this.PURE_VOCAL_FILLERS.test(tokens[startIdx].normalizedText)) {
      return null;
    }

    for (let n = 4; n >= 1; n--) {
      if (startIdx + n * 2 > tokens.length) continue;

      const firstSpan = tokens.slice(startIdx, startIdx + n);
      if (firstSpan.some((_t, offset) => consumedIndices.has(startIdx + offset))) continue;

      // Skip zero or more consecutive vocal fillers (Interregnum) between Reparandum & Repair
      let repairStartIdx = startIdx + n;
      while (
        repairStartIdx < tokens.length &&
        this.PURE_VOCAL_FILLERS.test(tokens[repairStartIdx].normalizedText)
      ) {
        repairStartIdx++;
      }

      if (repairStartIdx + n > tokens.length) continue;
      const secondSpan = tokens.slice(repairStartIdx, repairStartIdx + n);

      const gapSeconds = TimeMath.flicksToSeconds(
        secondSpan[0].range.start - firstSpan[firstSpan.length - 1].range.end,
      );
      if (gapSeconds > 2.5 || gapSeconds < 0) continue;

      const hasSubstantiveToken = firstSpan.some((tok) => tok.normalizedText.length > 1);
      if (!hasSubstantiveToken) continue;

      const isExactMatch = firstSpan.every(
        (tok, idx) =>
          tok.normalizedText.length > 0 &&
          tok.normalizedText === secondSpan[idx].normalizedText,
      );

      if (isExactMatch) {
        return {
          deleteStartIdx: startIdx,
          deleteEndIdx: repairStartIdx - 1,
          ngramLength: n,
        };
      }
    }
    return null;
  }

  private static detectIsolatedDiscourseFiller(
    tokens: TimedPersianToken[],
    startIdx: number,
    consumedIndices: Set<number>,
  ): { startIdx: number; endIdx: number } | null {
    for (const fillerPhrase of this.PERSIAN_DISCOURSE_FILLERS) {
      const fillerWords = fillerPhrase.replace(/\u200c/g, ' ').split(' ');
      const endIdx = startIdx + fillerWords.length - 1;

      let matchedEndIdx = -1;
      // Case A: Multi-token match (space-separated ASR tokens)
      if (endIdx < tokens.length) {
        let matches = true;
        for (let k = 0; k < fillerWords.length; k++) {
          const cleanTok = tokens[startIdx + k].normalizedText.replace(/\u200c/g, '');
          if (consumedIndices.has(startIdx + k) || cleanTok !== fillerWords[k]) {
            matches = false;
            break;
          }
        }
        if (matches) matchedEndIdx = endIdx;
      }

      // Case B: Single ZWNJ-joined ASR token (e.g., «به‌اصطلاح»)
      if (matchedEndIdx === -1 && !consumedIndices.has(startIdx)) {
        const singleClean = tokens[startIdx].normalizedText.replace(/\u200c/g, ' ');
        if (singleClean === fillerWords.join(' ')) {
          matchedEndIdx = startIdx;
        }
      }

      if (matchedEndIdx === -1) continue;

      const prevGapMs =
        startIdx === 0
          ? 250
          : TimeMath.flicksToSeconds(
              tokens[startIdx].range.start - tokens[startIdx - 1].range.end,
            ) * 1000;
      const nextGapMs =
        matchedEndIdx === tokens.length - 1
          ? 250
          : TimeMath.flicksToSeconds(
              tokens[matchedEndIdx + 1].range.start - tokens[matchedEndIdx].range.end,
            ) * 1000;

      if (prevGapMs >= 180 && nextGapMs >= 180) {
        return { startIdx, endIdx: matchedEndIdx };
      }
    }
    return null;
  }
}
