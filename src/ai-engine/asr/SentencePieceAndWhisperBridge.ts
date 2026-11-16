import { AsrModelRunnerAdapter, RawWordPrediction } from '../PersianChunkedAsrWorker';

export interface SubwordTokenEmission {
  readonly tokenId: number;
  readonly piece: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly logProb: number;
}

/**
 * Section 104: SentencePiece Unigram Subword Mapper for FastConformer Persian Models & Whisper.cpp Bridge
 */
export class SentencePieceSubwordCtcMapper {
  private static readonly WORD_START_MARKER = '\u2581'; // Standard ▁ marker in SentencePiece

  constructor(
    private readonly idToPiece: readonly string[],
    private readonly blankTokenId: number = 0,
  ) {}

  /**
   * 1. Decode FastConformer Persian subword emission matrix (CTC collapse + blank removal)
   * and automatically group subwords into complete Persian words with exact start/end timestamps
   */
  public decodeSubwordMatrixToWords(
    logProbsPerFrame: Float32Array[],
    frameDurationSec: number = 0.04,
  ): { fullText: string; words: RawWordPrediction[] } {
    const emissions: SubwordTokenEmission[] = [];
    let prevTokenId = -1;

    for (let t = 0; t < logProbsPerFrame.length; t++) {
      const frame = logProbsPerFrame[t];
      let bestId = 0;
      let bestLogP = -Infinity;

      for (let v = 0; v < frame.length; v++) {
        if (frame[v] > bestLogP) {
          bestLogP = frame[v];
          bestId = v;
        }
      }

      if (bestId !== this.blankTokenId) {
        if (bestId === prevTokenId && emissions.length > 0) {
          // Extend duration of repeated subword token across consecutive frames
          const last = emissions[emissions.length - 1];
          emissions[emissions.length - 1] = {
            ...last,
            endFrame: t + 1,
            logProb: Math.max(last.logProb, bestLogP),
          };
        } else {
          const piece = this.idToPiece[bestId] ?? '';
          emissions.push({
            tokenId: bestId,
            piece,
            startFrame: t,
            endFrame: t + 1,
            logProb: bestLogP,
          });
        }
      }
      prevTokenId = bestId;
    }

    return this.groupSubwordsIntoPersianWords(emissions, frameDurationSec);
  }

  /**
   * 2. Group SentencePiece subwords by ▁ (U+2581) word boundary marker into complete Persian words
   * while preserving internal ZWNJ (\u200c)
   */
  public groupSubwordsIntoPersianWords(
    emissions: SubwordTokenEmission[],
    frameDurationSec: number,
  ): { fullText: string; words: RawWordPrediction[] } {
    const words: RawWordPrediction[] = [];
    let currentWordPieces: SubwordTokenEmission[] = [];

    const flushWord = () => {
      if (currentWordPieces.length === 0) return;
      const rawJoined = currentWordPieces
        .map((p) => p.piece)
        .join('')
        .replace(/\u2581/g, '')
        .trim();

      if (rawJoined.length > 0) {
        const startFrame = currentWordPieces[0].startFrame;
        const endFrame = currentWordPieces[currentWordPieces.length - 1].endFrame;
        const avgLogP =
          currentWordPieces.reduce((acc, p) => acc + p.logProb, 0) /
          currentWordPieces.length;

        words.push({
          word: rawJoined,
          relativeStartSec: Number((startFrame * frameDurationSec).toFixed(3)),
          relativeEndSec: Number(
            Math.max(endFrame * frameDurationSec, startFrame * frameDurationSec + 0.04).toFixed(
              3,
            ),
          ),
          probability: Number(Math.min(0.99, Math.exp(Math.max(-10, avgLogP))).toFixed(3)),
        });
      }
      currentWordPieces = [];
    };

    for (const em of emissions) {
      if (em.piece.startsWith(SentencePieceSubwordCtcMapper.WORD_START_MARKER)) {
        flushWord();
      }
      currentWordPieces.push(em);
    }
    flushWord();

    return {
      fullText: words.map((w) => w.word).join(' '),
      words,
    };
  }
}

/**
 * 3. Standard bridge adapter for native/WASM whisper.cpp engine output
 */
export interface WhisperCppNativeBridge {
  transcribe16kFloat32(
    pcm16kMono: Float32Array,
    options: { language: 'fa'; tokenTimestamps: true; threads: number },
  ): Promise<{
    tokens: { text: string; t0Ms: number; t1Ms: number; probability: number }[];
  }>;
}

export class WhisperCppAsrAdapter implements AsrModelRunnerAdapter {
  public readonly modelId: string;
  public readonly modelVersion: string;

  constructor(
    private readonly bridge: WhisperCppNativeBridge,
    private readonly vadFilterFn: (
      pcm16kMono: Float32Array,
    ) => Promise<{ hasSpeech: boolean; speechRatio: number }>,
    modelId: string = 'whisper-small-fa-q5_1',
    modelVersion: string = '1.2.0',
    private readonly threadCount: number = 4,
  ) {
    this.modelId = modelId;
    this.modelVersion = modelVersion;
  }

  public async detectVoiceActivity(
    pcm16kMono: Float32Array,
  ): Promise<{ hasSpeech: boolean; speechRatio: number }> {
    return this.vadFilterFn(pcm16kMono);
  }

  public async transcribeWindow(pcm16kMono: Float32Array): Promise<RawWordPrediction[]> {
    const rawResult = await this.bridge.transcribe16kFloat32(pcm16kMono, {
      language: 'fa',
      tokenTimestamps: true,
      threads: this.threadCount,
    });

    // Merge BPE sub-tokens from whisper.cpp by leading whitespace into full Persian words
    const words: RawWordPrediction[] = [];
    let activeWordText = '';
    let activeStartSec = 0;
    let activeEndSec = 0;
    let probSum = 0;
    let pieceCount = 0;

    const flushWord = () => {
      const cleaned = activeWordText.trim();
      if (cleaned.length > 0 && !cleaned.startsWith('[')) {
        words.push({
          word: cleaned,
          relativeStartSec: Number(activeStartSec.toFixed(3)),
          relativeEndSec: Number(Math.max(activeEndSec, activeStartSec + 0.04).toFixed(3)),
          probability: Number((probSum / Math.max(1, pieceCount)).toFixed(3)),
        });
      }
      activeWordText = '';
      probSum = 0;
      pieceCount = 0;
    };

    for (const tok of rawResult.tokens) {
      if (/^\s/.test(tok.text) && activeWordText.length > 0) {
        flushWord();
      }
      if (pieceCount === 0) {
        activeStartSec = tok.t0Ms / 1000;
      }
      activeEndSec = tok.t1Ms / 1000;
      activeWordText += tok.text;
      probSum += tok.probability;
      pieceCount++;
    }
    flushWord();

    return words;
  }
}
