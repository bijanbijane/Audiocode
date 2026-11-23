import { RawWordPrediction } from '../PersianChunkedAsrWorker';

export interface PersianLanguageModelScorer {
  /** بازگرداندن لگاریتم طبیعی احتمال کلمه یا جفت کلمه قبلی و فعلی */
  scoreWordTransitionLogProb(prevWord: string | null, currentWord: string): number;
  /** بررسی وجود کلمه در واژه‌نامه معتبر فارسی برای اعمال پاداش واژگانی */
  isKnownPersianWord(word: string): boolean;
}

interface CharEmissionSpan {
  readonly char: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly logProb: number;
}

interface BeamHypothesis {
  readonly text: string;
  lastTokenId: number | null;
  logPBlank: number;
  logPNonBlank: number;
  logPLm: number;
  wordCount: number;
  readonly charSpans: CharEmissionSpan[];
}

const NEG_INF = -1e20;
const IGNORED_SPECIAL_TOKENS = new Set(['<blk>', '<eps>', '<pad>', '<unk>', '<s>', '</s>']);

export class PersianCtcPrefixBeamSearchDecoder {
  constructor(
    /** آرایه الفبای مدل CTC */
    private readonly vocabulary: readonly string[],
    private readonly blankTokenId: number = 0,
    private readonly spaceChar: string = ' ',
    private readonly lmScorer?: PersianLanguageModelScorer,
  ) {}

  /**
   * اجرای CTC Prefix Beam Search روی ماتریس خروجی شبکه عصبی [T_frames x VocabSize]
   */
  public decodeWithWordTimestamps(params: {
    logProbsPerFrame: Float32Array[];
    frameDurationSec?: number; // پیش‌فرض 0.04s برای FastConformer 4x یا 0.08s برای 8x
    beamWidth?: number;
    lmAlpha?: number; // وزن مدل زبان فارسی (مثلاً 0.45)
    wordInsertionBeta?: number; // پاداش درج کلمه برای جلوگیری از چسباندن کلمات
    topKPerFrame?: number;
  }): {
    bestTranscript: string;
    words: RawWordPrediction[];
    totalLogScore: number;
  } {
    const {
      logProbsPerFrame,
      frameDurationSec = 0.04,
      beamWidth = 16,
      lmAlpha = 0.45,
      wordInsertionBeta = 1.2,
      topKPerFrame = 8,
    } = params;

    if (logProbsPerFrame.length === 0) {
      return { bestTranscript: '', words: [], totalLogScore: 0 };
    }

    let activeBeams = new Map<string, BeamHypothesis>();
    activeBeams.set('', {
      text: '',
      lastTokenId: null,
      logPBlank: 0.0,
      logPNonBlank: NEG_INF,
      logPLm: 0.0,
      wordCount: 0,
      charSpans: [],
    });

    for (let t = 0; t < logProbsPerFrame.length; t++) {
      const frameLogProbs = logProbsPerFrame[t];
      const nextBeams = new Map<string, BeamHypothesis>();

      // استخراج topK توکن محتمل در فریم جاری برای شتاب‌دهی دیکدر
      const topTokenIndices = this.getTopKTokenIndices(frameLogProbs, topKPerFrame);
      const blankLogP =
        this.blankTokenId >= 0 && this.blankTokenId < frameLogProbs.length
          ? frameLogProbs[this.blankTokenId]
          : NEG_INF;

      for (const beam of activeBeams.values()) {
        const beamTotalAcoustic = this.logAddExp(beam.logPBlank, beam.logPNonBlank);

        // ۱. مسیر انتقال با توکن Blank (بدون تغییر متن پیشوند)
        this.accumulateBeam(
          nextBeams,
          beam.text,
          beam.lastTokenId,
          beamTotalAcoustic + blankLogP,
          NEG_INF,
          beam.logPLm,
          beam.wordCount,
          beam.charSpans,
        );

        // ۲. مسیرهای گسترش با توکن‌های غیر Blank
        for (const tokId of topTokenIndices) {
          if (tokId === this.blankTokenId) continue;
          const rawToken = this.vocabulary[tokId];
          if (!rawToken || IGNORED_SPECIAL_TOKENS.has(rawToken)) continue;

          const charLogP = frameLogProbs[tokId];
          const textPiece = rawToken.replace(/▁/g, ' ');
          const lastChar = beam.text.length > 0 ? beam.text[beam.text.length - 1] : '';
          const isSameToken =
            tokId === beam.lastTokenId ||
            (rawToken.length === 1 && textPiece === lastChar && beam.lastTokenId !== null);

          if (isSameToken) {
            // الف) تکرار توکن در فریم‌های متوالی بدون Blank میانی -> ادغام روی همان پیشوند قبلی
            const updatedSpans = this.extendLastCharSpan(beam.charSpans, t, charLogP);
            this.accumulateBeam(
              nextBeams,
              beam.text,
              tokId,
              NEG_INF,
              beam.logPNonBlank + charLogP,
              beam.logPLm,
              beam.wordCount,
              updatedSpans,
            );

            // ب) تکرار واقعی توکن از مسیر Blank قبلی
            const extendedText = beam.text + textPiece;
            const { deltaLm, deltaWords } = this.evaluateWordCompletionOnToken(
              beam.text,
              rawToken,
              lmAlpha,
            );
            const newSpans = [
              ...beam.charSpans,
              { char: rawToken, startFrame: t, endFrame: t + 1, logProb: charLogP },
            ];
            this.accumulateBeam(
              nextBeams,
              extendedText,
              tokId,
              NEG_INF,
              beam.logPBlank + charLogP,
              beam.logPLm + deltaLm,
              beam.wordCount + deltaWords,
              newSpans,
            );
          } else {
            // ج) توکن جدید متفاوت از آخرین توکن پیشوند فعلی
            const extendedText = beam.text + textPiece;
            const { deltaLm, deltaWords } = this.evaluateWordCompletionOnToken(
              beam.text,
              rawToken,
              lmAlpha,
            );
            const newSpans = [
              ...beam.charSpans,
              { char: rawToken, startFrame: t, endFrame: t + 1, logProb: charLogP },
            ];
            this.accumulateBeam(
              nextBeams,
              extendedText,
              tokId,
              NEG_INF,
              beamTotalAcoustic + charLogP,
              beam.logPLm + deltaLm,
              beam.wordCount + deltaWords,
              newSpans,
            );
          }
        }
      }

      // هرس پرتو (Beam Pruning): حفظ K فرضیه برتر بر اساس امتیاز ترکیبی آکوستیک + مدل زبان
      activeBeams = this.pruneBeams(nextBeams, beamWidth, wordInsertionBeta);
    }

    // انتخاب بهترین فرضیه نهایی (با اعمال امتیاز مدل زبان برای آخرین کلمه انتهای جمله)
    let bestBeam: BeamHypothesis | null = null;
    let bestFinalScore = NEG_INF;

    for (const beam of activeBeams.values()) {
      const { deltaLm, deltaWords } = this.evaluateWordCompletionOnToken(
        beam.text,
        this.spaceChar,
        lmAlpha,
      );
      const acoustic = this.logAddExp(beam.logPBlank, beam.logPNonBlank);
      const finalScore =
        acoustic +
        beam.logPLm +
        deltaLm +
        (beam.wordCount + deltaWords) * wordInsertionBeta;

      if (finalScore > bestFinalScore) {
        bestFinalScore = finalScore;
        bestBeam = beam;
      }
    }

    if (!bestBeam) {
      return { bestTranscript: '', words: [], totalLogScore: 0 };
    }

    const words = this.groupCharSpansIntoWordPredictions(
      bestBeam.charSpans,
      frameDurationSec,
    );

    return {
      bestTranscript: bestBeam.text.replace(/\s+/g, ' ').trim(),
      words,
      totalLogScore: Number(bestFinalScore.toFixed(3)),
    };
  }

  private evaluateWordCompletionOnToken(
    prevText: string,
    nextToken: string,
    lmAlpha: number,
  ): { deltaLm: number; deltaWords: number } {
    const startsNewWord =
      nextToken === this.spaceChar ||
      nextToken.startsWith('▁') ||
      nextToken.startsWith(' ');
    if (!startsNewWord) {
      return { deltaLm: 0, deltaWords: 0 };
    }

    const wordsSoFar = prevText.trim().split(/\s+/).filter(Boolean);
    if (wordsSoFar.length === 0) return { deltaLm: 0, deltaWords: 0 };

    const completedWord = wordsSoFar[wordsSoFar.length - 1];
    const prevWord = wordsSoFar.length >= 2 ? wordsSoFar[wordsSoFar.length - 2] : null;

    if (!this.lmScorer) {
      return { deltaLm: 0, deltaWords: 1 };
    }

    const lmLogP = this.lmScorer.scoreWordTransitionLogProb(prevWord, completedWord);
    const dictBonus = this.lmScorer.isKnownPersianWord(completedWord) ? 0.8 : -0.6;
    return {
      deltaLm: lmAlpha * (lmLogP + dictBonus),
      deltaWords: 1,
    };
  }

  private groupCharSpansIntoWordPredictions(
    charSpans: CharEmissionSpan[],
    frameDurationSec: number,
  ): RawWordPrediction[] {
    const words: RawWordPrediction[] = [];
    let currentChars: CharEmissionSpan[] = [];

    const flushWord = () => {
      if (currentChars.length === 0) return;
      const wordText = currentChars.map((c) => c.char).join('');
      const startFrame = currentChars[0].startFrame;
      const endFrame = currentChars[currentChars.length - 1].endFrame;
      const avgLogP =
        currentChars.reduce((acc, c) => acc + c.logProb, 0) / currentChars.length;

      words.push({
        word: wordText,
        relativeStartSec: Number((startFrame * frameDurationSec).toFixed(3)),
        relativeEndSec: Number(
          Math.max(
            endFrame * frameDurationSec,
            startFrame * frameDurationSec + 0.04,
          ).toFixed(3),
        ),
        probability: Number(Math.min(0.99, Math.exp(Math.max(-10, avgLogP))).toFixed(3)),
      });
      currentChars = [];
    };

    for (const span of charSpans) {
      if (span.char === this.spaceChar || span.char === '▁') {
        flushWord();
      } else if (span.char.startsWith('▁') || span.char.startsWith(' ')) {
        flushWord();
        const cleanPiece = span.char.replace(/^[\s▁]+/, '');
        if (cleanPiece.length > 0) {
          currentChars.push({ ...span, char: cleanPiece });
        }
      } else {
        currentChars.push(span);
      }
    }
    flushWord();

    return words;
  }

  private accumulateBeam(
    map: Map<string, BeamHypothesis>,
    text: string,
    lastTokenId: number | null,
    addLogPBlank: number,
    addLogPNonBlank: number,
    logPLm: number,
    wordCount: number,
    charSpans: CharEmissionSpan[],
  ): void {
    const existing = map.get(text);
    if (!existing) {
      map.set(text, {
        text,
        lastTokenId,
        logPBlank: addLogPBlank,
        logPNonBlank: addLogPNonBlank,
        logPLm,
        wordCount,
        charSpans,
      });
      return;
    }

    const prevAcoustic = this.logAddExp(existing.logPBlank, existing.logPNonBlank);
    existing.logPBlank = this.logAddExp(existing.logPBlank, addLogPBlank);
    existing.logPNonBlank = this.logAddExp(existing.logPNonBlank, addLogPNonBlank);

    const newAcoustic = this.logAddExp(addLogPBlank, addLogPNonBlank);
    if (newAcoustic > prevAcoustic && charSpans.length >= existing.charSpans.length) {
      existing.lastTokenId = lastTokenId;
      existing.logPLm = logPLm;
      existing.wordCount = wordCount;
      (existing as { charSpans: CharEmissionSpan[] }).charSpans = charSpans;
    }
  }

  private extendLastCharSpan(
    spans: CharEmissionSpan[],
    frameIdx: number,
    frameLogProb: number,
  ): CharEmissionSpan[] {
    if (spans.length === 0) return spans;
    const copy = spans.slice(0, -1);
    const last = spans[spans.length - 1];
    copy.push({
      ...last,
      endFrame: frameIdx + 1,
      logProb: Math.max(last.logProb, frameLogProb),
    });
    return copy;
  }

  private pruneBeams(
    beams: Map<string, BeamHypothesis>,
    beamWidth: number,
    wordInsertionBeta: number,
  ): Map<string, BeamHypothesis> {
    if (beams.size <= beamWidth) return beams;
    const sorted = Array.from(beams.values()).sort((a, b) => {
      const scoreA =
        this.logAddExp(a.logPBlank, a.logPNonBlank) +
        a.logPLm +
        a.wordCount * wordInsertionBeta;
      const scoreB =
        this.logAddExp(b.logPBlank, b.logPNonBlank) +
        b.logPLm +
        b.wordCount * wordInsertionBeta;
      return scoreB - scoreA;
    });

    const pruned = new Map<string, BeamHypothesis>();
    for (let i = 0; i < Math.min(beamWidth, sorted.length); i++) {
      pruned.set(sorted[i].text, sorted[i]);
    }
    return pruned;
  }

  private getTopKTokenIndices(logProbs: Float32Array, k: number): number[] {
    const limit = Math.min(k, logProbs.length);
    const topIndices: number[] = [];
    for (let i = 0; i < logProbs.length; i++) {
      const val = logProbs[i];
      if (!Number.isFinite(val)) continue;
      if (topIndices.length < limit) {
        topIndices.push(i);
        for (let j = topIndices.length - 1; j > 0; j--) {
          if (logProbs[topIndices[j]] > logProbs[topIndices[j - 1]]) {
            const tmp = topIndices[j];
            topIndices[j] = topIndices[j - 1];
            topIndices[j - 1] = tmp;
          } else {
            break;
          }
        }
      } else if (val > logProbs[topIndices[limit - 1]]) {
        topIndices[limit - 1] = i;
        for (let j = limit - 1; j > 0; j--) {
          if (logProbs[topIndices[j]] > logProbs[topIndices[j - 1]]) {
            const tmp = topIndices[j];
            topIndices[j] = topIndices[j - 1];
            topIndices[j - 1] = tmp;
          } else {
            break;
          }
        }
      }
    }
    return topIndices;
  }

  private logAddExp(a: number, b: number): number {
    if (a <= NEG_INF * 0.5) return b;
    if (b <= NEG_INF * 0.5) return a;
    return a > b
      ? a + Math.log1p(Math.exp(b - a))
      : b + Math.log1p(Math.exp(a - b));
  }
}
