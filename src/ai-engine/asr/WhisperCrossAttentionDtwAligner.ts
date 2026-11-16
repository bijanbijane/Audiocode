import { RawWordPrediction } from '../PersianChunkedAsrWorker';

export interface WhisperTokenWithLogProb {
  readonly tokenId: number;
  readonly decodedUtf8Piece: string;
  readonly probability: number;
}

export class WhisperCrossAttentionDtwAligner {
  private static readonly ENCODER_FRAME_DURATION_SEC = 0.02; // Each Whisper encoder frame is 20ms (320 samples @ 16kHz)

  /**
   * Extracts exact word-level timestamps from Whisper decoder Cross-Attention heads via DTW.
   * @param crossAttentionHeads Array of flattened attention matrices per alignment head [numTokens * totalEncoderFramesPerRow]
   * @param totalEncoderFramesPerRow Typically 1500 for Whisper's 30-second audio window
   * @param actualAudioSamples16k Actual number of audio samples before 30-second zero padding
   */
  public static alignTokensAndGroupWords(params: {
    tokens: WhisperTokenWithLogProb[];
    crossAttentionHeads: Float32Array[];
    totalEncoderFramesPerRow: number;
    actualAudioSamples16k: number;
    medianFilterWidth?: number; // Default 7 frames (140ms)
  }): RawWordPrediction[] {
    const {
      tokens,
      crossAttentionHeads,
      totalEncoderFramesPerRow,
      actualAudioSamples16k,
      medianFilterWidth = 7,
    } = params;

    const N = tokens.length;
    if (N === 0 || crossAttentionHeads.length === 0) return [];

    // 1. Compute valid encoder frames corresponding to actual audio (prevents DTW from stretching into 30s silence padding)
    const validFrames = Math.max(
      1,
      Math.min(totalEncoderFramesPerRow, Math.ceil(actualAudioSamples16k / 320))
    );

    // 2. Average across alignment heads and row-normalize (Z-Score)
    const meanWeights: Float32Array[] = Array.from(
      { length: N },
      () => new Float32Array(validFrames)
    );
    const numHeads = crossAttentionHeads.length;

    for (let i = 0; i < N; i++) {
      const row = meanWeights[i];
      const srcOffset = i * totalEncoderFramesPerRow;

      let sum = 0;
      for (let j = 0; j < validFrames; j++) {
        let headAvg = 0;
        for (let h = 0; h < numHeads; h++) {
          headAvg += crossAttentionHeads[h][srcOffset + j];
        }
        const val = headAvg / numHeads;
        row[j] = val;
        sum += val;
      }

      const mean = sum / validFrames;
      let varSum = 0;
      for (let j = 0; j < validFrames; j++) {
        const diff = row[j] - mean;
        varSum += diff * diff;
      }
      const stdDev = Math.sqrt(varSum / validFrames) + 1e-8;

      for (let j = 0; j < validFrames; j++) {
        row[j] = (row[j] - mean) / stdDev;
      }
    }

    // 3. Apply 1D Median Filter along time axis to suppress transient attention spikes
    const smoothedWeights = meanWeights.map((row) =>
      this.apply1DMedianFilter(row, medianFilterWidth)
    );

    // 4. Run Dynamic Time Warping (DTW) to find monotonic path from (0, 0) to (N-1, validFrames-1)
    const INF = 1e18;
    const dp: Float64Array[] = Array.from({ length: N + 1 }, () =>
      new Float64Array(validFrames + 1).fill(INF)
    );
    // 1: diagonal (i-1, j-1), 2: up (i-1, j), 3: left (i, j-1)
    const trace: Uint8Array[] = Array.from(
      { length: N + 1 },
      () => new Uint8Array(validFrames + 1)
    );

    dp[0][0] = 0;

    for (let i = 1; i <= N; i++) {
      for (let j = 1; j <= validFrames; j++) {
        const cost = -smoothedWeights[i - 1][j - 1];
        const diag = dp[i - 1][j - 1];
        const up = dp[i - 1][j];
        const left = dp[i][j - 1];

        if (diag <= up && diag <= left) {
          dp[i][j] = cost + diag;
          trace[i][j] = 1;
        } else if (up <= left) {
          dp[i][j] = cost + up;
          trace[i][j] = 2;
        } else {
          dp[i][j] = cost + left;
          trace[i][j] = 3;
        }
      }
    }

    // 5. Backtrack to extract start and end frame for each BPE token
    const tokenStartFrame = new Int32Array(N).fill(validFrames);
    const tokenEndFrame = new Int32Array(N).fill(0);

    let ti = N;
    let tj = validFrames;
    while (ti > 0 && tj > 0) {
      const tokIdx = ti - 1;
      const frameIdx = tj - 1;
      if (frameIdx < tokenStartFrame[tokIdx]) tokenStartFrame[tokIdx] = frameIdx;
      if (frameIdx + 1 > tokenEndFrame[tokIdx]) tokenEndFrame[tokIdx] = frameIdx + 1;

      const move = trace[ti][tj];
      if (move === 1) {
        ti--;
        tj--;
      } else if (move === 2) {
        ti--;
      } else {
        tj--;
      }
    }

    // 6. Group BPE tokens into full Persian words by leading whitespace
    const words: RawWordPrediction[] = [];
    let currentWordStr = '';
    let wordStartFrame = validFrames;
    let wordEndFrame = 0;
    let probSum = 0;
    let pieceCount = 0;

    const flushWord = () => {
      const clean = currentWordStr.trim();
      if (clean.length > 0 && pieceCount > 0) {
        const startSec = wordStartFrame * this.ENCODER_FRAME_DURATION_SEC;
        const endSec = Math.max(
          wordEndFrame * this.ENCODER_FRAME_DURATION_SEC,
          startSec + 0.04
        );
        words.push({
          word: clean,
          relativeStartSec: Number(startSec.toFixed(3)),
          relativeEndSec: Number(endSec.toFixed(3)),
          probability: Number((probSum / pieceCount).toFixed(3)),
        });
      }
      currentWordStr = '';
      wordStartFrame = validFrames;
      wordEndFrame = 0;
      probSum = 0;
      pieceCount = 0;
    };

    for (let i = 0; i < N; i++) {
      const piece = tokens[i].decodedUtf8Piece;
      if (/^\s/.test(piece) && currentWordStr.trim().length > 0) {
        flushWord();
      }

      const sF = tokenStartFrame[i] < validFrames ? tokenStartFrame[i] : 0;
      const eF = tokenEndFrame[i] > sF ? tokenEndFrame[i] : sF + 1;

      currentWordStr += piece;
      if (sF < wordStartFrame) wordStartFrame = sF;
      if (eF > wordEndFrame) wordEndFrame = eF;
      probSum += tokens[i].probability;
      pieceCount++;
    }
    flushWord();

    return words;
  }

  private static apply1DMedianFilter(input: Float32Array, width: number): Float32Array {
    const out = new Float32Array(input.length);
    const half = Math.floor(width / 2);
    const windowBuf: number[] = [];

    for (let i = 0; i < input.length; i++) {
      windowBuf.length = 0;
      const s = Math.max(0, i - half);
      const e = Math.min(input.length - 1, i + half);
      for (let k = s; k <= e; k++) {
        windowBuf.push(input[k]);
      }
      windowBuf.sort((a, b) => a - b);
      out[i] = windowBuf[Math.floor(windowBuf.length / 2)];
    }
    return out;
  }
}
