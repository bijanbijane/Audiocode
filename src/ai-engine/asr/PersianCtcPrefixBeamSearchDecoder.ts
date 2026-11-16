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
  logPBlank: number;
  logPNonBlank: number;
  logPLm: number;
  wordCount: number;
  readonly charSpans: CharEmissionSpan[];
}

const NEG_INF = -1e20;

export class PersianCtcPrefixBeamSearchDecoder {
  constructor(
    /** آرایه الفبای مدل CTC که ایندکس 0 آن معمولاً توکن Blank <blk> است */
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
    frameDurationSec?: number; // پیش‌فرض 0.04s برای FastConformer (4x subsampling) یا 0.02s برای Wav2Vec2
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
      logPBlank: 0.0,
      logPNonBlank: NEG_INF,
      logPLm: 0.0,
      wordCount: 0,
      charSpans: [],
    });

    for (let t = 0; t < logProbsPerFrame.length; t++) {
      const frameLogProbs = logProbsPerFrame[t];
      const nextBeams = new Map<string, BeamHypothesis>();

      // استخراج topK کاراکتر محتمل در فریم جاری برای شتاب‌دهی شدید دیکدر
      const topTokenIndices = this.getTopKTokenIndices(frameLogProbs, topKPerFrame);
      const blankLogP = frameLogProbs[this.blankTokenId];

      for (const beam of activeBeams.values()) {
        const beamTotalAcoustic = this.logAddExp(beam.logPBlank, beam.logPNonBlank);

        // ۱. مسیر انتقال با توکن Blank (بدون تغییر متن پیشوند)
        this.accumulateBeam(
          nextBeams,
          beam.text,
          beamTotalAcoustic + blankLogP,
          NEG_INF,
          beam.logPLm,
          beam.wordCount,
          beam.charSpans,
        );

        // ۲. مسیرهای گسترش با توکن‌های غیر Blank
        for (const tokId of topTokenIndices) {
          if (tokId === this.blankTokenId) continue;
          const emittedChar = this.vocabulary[tokId];
          if (!emittedChar) continue;

          const charLogP = frameLogProbs[tokId];
          const lastChar = beam.text.length > 0 ? beam.text[beam.text.length - 1] : '';

          if (emittedChar === lastChar) {
            // الف) تکرار کاراکتر در فریم‌های متوالی بدون Blank میانی -> ادغام روی همان پیشوند قبلی
            const updatedSpans = this.extendLastCharSpan(beam.charSpans, t, charLogP);
            this.accumulateBeam(
              nextBeams,
              beam.text,
              NEG_INF,
              beam.logPNonBlank + charLogP,
              beam.logPLm,
              beam.wordCount,
              updatedSpans,
            );

            // ب) تکرار واقعی یک حرف تکراری فارسی (مثل «تت» یا «مم») از مسیر Blank قبلی
            const extendedText = beam.text + emittedChar;
            const { deltaLm, deltaWords } = this.evaluateWordCompletionOnChar(
              beam.text,
              emittedChar,
              lmAlpha,
            );
            const newSpans = [
              ...beam.charSpans,
              { char: emittedChar, startFrame: t, endFrame: t + 1, logProb: charLogP },
            ];
            this.accumulateBeam(
              nextBeams,
              extendedText,
              NEG_INF,
              beam.logPBlank + charLogP,
              beam.logPLm + deltaLm,
              beam.wordCount + deltaWords,
              newSpans,
            );
          } else {
            // ج) کاراکتر جدید متفاوت از انتهای پیشوند فعلی
            const extendedText = beam.text + emittedChar;
            const { deltaLm, deltaWords } = this.evaluateWordCompletionOnChar(
              beam.text,
              emittedChar,
              lmAlpha,
            );
            const newSpans = [
              ...beam.charSpans,
              { char: emittedChar, startFrame: t, endFrame: t + 1, logProb: charLogP },
            ];
            this.accumulateBeam(
              nextBeams,
              extendedText,
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
      const { deltaLm, deltaWords } = this.evaluateWordCompletionOnChar(
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
      bestTranscript: bestBeam.text.trim(),
      words,
      totalLogScore: Number(bestFinalScore.toFixed(3)),
    };
  }

  private evaluateWordCompletionOnChar(
    prevText: string,
    nextChar: string,
    lmAlpha: number,
  ): { deltaLm: number; deltaWords: number } {
    if (nextChar !== this.spaceChar) {
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
    const indices = Array.from({ length: logProbs.length }, (_, i) => i);
    indices.sort((a, b) => logProbs[b] - logProbs[a]);
    return indices.slice(0, k);
  }

  private logAddExp(a: number, b: number): number {
    if (a <= NEG_INF * 0.5) return b;
    if (b <= NEG_INF * 0.5) return a;
    return a > b
      ? a + Math.log1p(Math.exp(b - a))
      : b + Math.log1p(Math.exp(a - b));
  }
}
