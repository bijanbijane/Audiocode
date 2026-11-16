import { Flicks, TimeMath, TimeRange } from '../contracts/timebase.contract';

export interface AlignedCharacterSpan {
  readonly char: string;
  readonly wordIndex: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly acousticScore: number;
}

export interface ForcedAlignedWord {
  readonly wordId: string;
  readonly wordText: string;
  readonly alignedRange: TimeRange;
  readonly acousticConfidence: number;
}

export interface ForcedAlignmentResult {
  readonly words: ForcedAlignedWord[];
  readonly characterSpans: AlignedCharacterSpan[];
}

/**
 * Persian Log-Domain CTC Viterbi Forced Aligner (Sections 7 Domain 4 & 26)
 * Keeps Forced Alignment strictly separate from open-vocabulary ASR so known Persian transcripts
 * (audiobooks, narration, scripted podcasts) snap to millisecond acoustic phoneme boundaries.
 * Enforces the CTC Blank Token (epsilon = 0) rule between identical adjacent characters (e.g. «تت» or «مم»).
 */
export class PersianCtcForcedAligner {
  private static readonly BLANK_TOKEN_ID = 0;

  /**
   * Aligns known Persian words against a T x V frame-level log-probability matrix using Log-Domain CTC Viterbi.
   */
  public static alignPersianWordsToAudio(
    logProbsPerFrame: readonly Float32Array[],
    charToVocabId: ReadonlyMap<string, number>,
    words: readonly { id: string; text: string }[],
    frameDurationSec = 0.02,
    chunkStartOffsetFlicks: Flicks = 0,
  ): ForcedAlignedWord[] {
    return this.alignPersianWordsAndCharacters(
      logProbsPerFrame,
      charToVocabId,
      words,
      frameDurationSec,
      chunkStartOffsetFlicks,
    ).words;
  }

  /**
   * Full CTC Viterbi alignment returning both word-level Flicks ranges and character-level frame spans.
   */
  public static alignPersianWordsAndCharacters(
    logProbsPerFrame: readonly Float32Array[],
    charToVocabId: ReadonlyMap<string, number>,
    words: readonly { id: string; text: string }[],
    frameDurationSec = 0.02,
    chunkStartOffsetFlicks: Flicks = 0,
  ): ForcedAlignmentResult {
    const numFrames = logProbsPerFrame.length;
    if (numFrames === 0 || words.length === 0 || frameDurationSec <= 0) {
      return { words: [], characterSpans: [] };
    }

    // 1. Flatten characters while tracking owning wordIndex
    const flatChars: { char: string; vocabId: number; wordIndex: number }[] = [];
    words.forEach((w, wIdx) => {
      const clean = w.text.trim();
      for (const ch of clean) {
        const vocabId = charToVocabId.get(ch);
        if (vocabId !== undefined && vocabId !== this.BLANK_TOKEN_ID) {
          flatChars.push({ char: ch, vocabId, wordIndex: wIdx });
        }
      }
    });

    const L = flatChars.length;
    if (L === 0) {
      return { words: [], characterSpans: [] };
    }

    // 2. Expand target sequence with Blank Tokens (epsilon): S' = [ε, c_0, ε, c_1, ε, ..., c_{L-1}, ε]
    const numStates = 2 * L + 1;
    const stateVocabIds = new Int32Array(numStates);
    for (let s = 0; s < numStates; s++) {
      stateVocabIds[s] =
        s % 2 === 0 ? this.BLANK_TOKEN_ID : flatChars[(s - 1) >> 1].vocabId;
    }

    const NEG_INF = -1e30;
    let prevScore = new Float64Array(numStates).fill(NEG_INF);
    let currScore = new Float64Array(numStates).fill(NEG_INF);
    const backPointers = new Int32Array(numFrames * numStates);

    // Frame t = 0: only initial Blank (s=0) or first character (s=1) are legal CTC entry states
    prevScore[0] = logProbsPerFrame[0][stateVocabIds[0]] ?? NEG_INF;
    if (numStates > 1) {
      prevScore[1] = logProbsPerFrame[0][stateVocabIds[1]] ?? NEG_INF;
    }

    // 3. Forward Viterbi Trellis Pass
    for (let t = 1; t < numFrames; t++) {
      currScore.fill(NEG_INF);
      const frameProbs = logProbsPerFrame[t];
      const rowOffset = t * numStates;

      for (let s = 0; s < numStates; s++) {
        let bestPrevScore = prevScore[s];
        let bestPrevState = s;

        if (s >= 1 && prevScore[s - 1] > bestPrevScore) {
          bestPrevScore = prevScore[s - 1];
          bestPrevState = s - 1;
        }

        // Skip-blank transition s - 2 -> s ONLY when s is non-blank AND differs from previous char
        // (Guarantees repeated letters like «تت» or «مم» must traverse an intervening Blank token)
        if (
          s >= 2 &&
          s % 2 === 1 &&
          stateVocabIds[s] !== stateVocabIds[s - 2] &&
          prevScore[s - 2] > bestPrevScore
        ) {
          bestPrevScore = prevScore[s - 2];
          bestPrevState = s - 2;
        }

        const emissionLogProb = frameProbs[stateVocabIds[s]] ?? NEG_INF;
        currScore[s] = bestPrevScore <= NEG_INF / 2 ? NEG_INF : bestPrevScore + emissionLogProb;
        backPointers[rowOffset + s] = bestPrevState;
      }

      const temp = prevScore;
      prevScore = currScore;
      currScore = temp;
    }

    // 4. Backtracking from best legal terminal state (final character or trailing Blank)
    let bestEndState = numStates - 1;
    if (numStates >= 2 && prevScore[numStates - 2] > prevScore[numStates - 1]) {
      bestEndState = numStates - 2;
    }
    if (prevScore[bestEndState] <= NEG_INF / 2) {
      // Fallback for overly short frame sequences: pick highest-scoring reachable state
      let bestScore = NEG_INF;
      for (let s = 0; s < numStates; s++) {
        if (prevScore[s] > bestScore) {
          bestScore = prevScore[s];
          bestEndState = s;
        }
      }
    }

    const bestStatePerFrame = new Int32Array(numFrames);
    let curS = bestEndState;
    for (let t = numFrames - 1; t >= 0; t--) {
      bestStatePerFrame[t] = curS;
      curS = backPointers[t * numStates + curS];
    }

    // 5. Aggregate frame spans per character & per word into Flicks
    const charStartFrame = new Int32Array(L).fill(numFrames);
    const charEndFrame = new Int32Array(L).fill(0);
    const charProbSum = new Float64Array(L);
    const charFrameCount = new Int32Array(L);

    const wordStartFrame = new Int32Array(words.length).fill(numFrames);
    const wordEndFrame = new Int32Array(words.length).fill(0);
    const wordProbSum = new Float64Array(words.length);
    const wordFrameCounts = new Int32Array(words.length);

    for (let t = 0; t < numFrames; t++) {
      const s = bestStatePerFrame[t];
      if (s % 2 === 1) {
        const charIdx = (s - 1) >> 1;
        const wIdx = flatChars[charIdx].wordIndex;
        const logP = logProbsPerFrame[t][stateVocabIds[s]] ?? -20;
        const prob = Math.exp(Math.max(-20, logP));

        if (t < charStartFrame[charIdx]) charStartFrame[charIdx] = t;
        if (t + 1 > charEndFrame[charIdx]) charEndFrame[charIdx] = t + 1;
        charProbSum[charIdx] += prob;
        charFrameCount[charIdx]++;

        if (t < wordStartFrame[wIdx]) wordStartFrame[wIdx] = t;
        if (t + 1 > wordEndFrame[wIdx]) wordEndFrame[wIdx] = t + 1;
        wordProbSum[wIdx] += prob;
        wordFrameCounts[wIdx]++;
      }
    }

    const characterSpans: AlignedCharacterSpan[] = flatChars.map((fc, idx) => {
      const startF = charStartFrame[idx] < numFrames ? charStartFrame[idx] : 0;
      const endF = charEndFrame[idx] > startF ? charEndFrame[idx] : startF + 1;
      const count = charFrameCount[idx];
      const acousticScore = count > 0 ? Math.min(0.99, charProbSum[idx] / count) : 0.5;
      return {
        char: fc.char,
        wordIndex: fc.wordIndex,
        startFrame: startF,
        endFrame: endF,
        acousticScore: Number(acousticScore.toFixed(3)),
      };
    });

    let lastResolvedEndFrame = 0;
    const alignedWords: ForcedAlignedWord[] = words.map((w, idx) => {
      const sFrame = wordStartFrame[idx] < numFrames ? wordStartFrame[idx] : lastResolvedEndFrame;
      const eFrame = wordEndFrame[idx] > sFrame ? wordEndFrame[idx] : sFrame + 1;
      lastResolvedEndFrame = eFrame;

      const startFlicks =
        chunkStartOffsetFlicks + TimeMath.secondsToFlicks(sFrame * frameDurationSec);
      const endFlicks =
        chunkStartOffsetFlicks + TimeMath.secondsToFlicks(eFrame * frameDurationSec);

      const count = wordFrameCounts[idx];
      const confidence = count > 0 ? Math.min(0.99, wordProbSum[idx] / count) : 0.5;

      return {
        wordId: w.id,
        wordText: w.text,
        alignedRange: { start: startFlicks, end: endFlicks },
        acousticConfidence: Number(confidence.toFixed(2)),
      };
    });

    return { words: alignedWords, characterSpans };
  }
}
