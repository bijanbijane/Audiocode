import { PersianLanguageModelScorer } from './PersianCtcPrefixBeamSearchDecoder';
import { PersianTextNormalizer } from '../PersianTextNormalizer';

/**
 * Section 101: Compact Persian Statistical Language Model Scorer (PLM1 Binary Format)
 * Packs vocabulary and bigram transitions into contiguous Uint32Array/Float32Array buffers
 * (< 3 MB footprint, zero GC allocation during O(log N) binary search with Stupid Backoff).
 */
export class CompactPersianLanguageModelScorer implements PersianLanguageModelScorer {
  private static readonly MAGIC = 0x504c4d31; // "PLM1"
  private static readonly STUPID_BACKOFF_LOG_ALPHA = Math.log(0.4); // Backoff penalty from Bigram to Unigram

  private readonly wordToId = new Map<string, number>();
  private unigramLogProbs: Float32Array = new Float32Array(0);
  private bigramPrevIds: Uint32Array = new Uint32Array(0);
  private bigramCurrIds: Uint32Array = new Uint32Array(0);
  private bigramLogProbs: Float32Array = new Float32Array(0);
  private unknownWordLogProb = -14.5;

  /**
   * 1. Fast training and compilation of language model from Persian text corpus
   */
  public static trainFromPersianCorpus(
    sentences: string[],
    minUnigramFreq: number = 2,
    minBigramFreq: number = 2,
  ): CompactPersianLanguageModelScorer {
    const unigramCounts = new Map<string, number>();
    const bigramCounts = new Map<string, number>();
    let totalTokens = 0;

    for (const rawSentence of sentences) {
      const normalized = PersianTextNormalizer.normalizeTokenText(rawSentence).replace(
        /[،؛.!؟«»"()\-:]/g,
        ' ',
      );
      const words = normalized.split(/\s+/).filter(Boolean);

      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        unigramCounts.set(w, (unigramCounts.get(w) ?? 0) + 1);
        totalTokens++;

        if (i > 0) {
          const prev = words[i - 1];
          const key = `${prev}\t${w}`;
          bigramCounts.set(key, (bigramCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const instance = new CompactPersianLanguageModelScorer();
    const vocabWords: string[] = [];

    for (const [word, count] of unigramCounts.entries()) {
      if (count >= minUnigramFreq) {
        instance.wordToId.set(word, vocabWords.length);
        vocabWords.push(word);
      }
    }

    const vocabSize = vocabWords.length;
    const denomLog = Math.log(Math.max(1, totalTokens + vocabSize));
    instance.unigramLogProbs = new Float32Array(vocabSize);
    instance.unknownWordLogProb = Math.log(0.5) - denomLog;

    for (let id = 0; id < vocabSize; id++) {
      const c = unigramCounts.get(vocabWords[id]) ?? 1;
      // Laplace-Smoothed Log Probability
      instance.unigramLogProbs[id] = Math.log(c + 0.5) - denomLog;
    }

    // Extract valid bigrams and sort lexicographically by (prevId, currId) for O(log N) binary search
    const packedBigrams: { prevId: number; currId: number; logProb: number }[] = [];
    for (const [pairKey, bgCount] of bigramCounts.entries()) {
      if (bgCount < minBigramFreq) continue;
      const [prevW, currW] = pairKey.split('\t');
      const prevId = instance.wordToId.get(prevW);
      const currId = instance.wordToId.get(currW);
      if (prevId === undefined || currId === undefined) continue;

      const prevCount = unigramCounts.get(prevW) ?? 1;
      packedBigrams.push({
        prevId,
        currId,
        logProb: Math.log(bgCount / prevCount),
      });
    }

    packedBigrams.sort((a, b) =>
      a.prevId !== b.prevId ? a.prevId - b.prevId : a.currId - b.currId,
    );

    const bgLen = packedBigrams.length;
    instance.bigramPrevIds = new Uint32Array(bgLen);
    instance.bigramCurrIds = new Uint32Array(bgLen);
    instance.bigramLogProbs = new Float32Array(bgLen);

    for (let i = 0; i < bgLen; i++) {
      instance.bigramPrevIds[i] = packedBigrams[i].prevId;
      instance.bigramCurrIds[i] = packedBigrams[i].currId;
      instance.bigramLogProbs[i] = packedBigrams[i].logProb;
    }

    return instance;
  }

  /**
   * 2. Serialize language model into ultra-compact binary format (PLM1) for client distribution
   */
  public serializeToBinary(): Uint8Array {
    const vocabList = Array.from(this.wordToId.keys());
    const vocabUtf8 = new TextEncoder().encode(vocabList.join('\n'));

    const headerBytes = 20;
    const unigramBytes = this.unigramLogProbs.byteLength;
    const bigramCount = this.bigramPrevIds.length;
    const bigramBytes = bigramCount * (4 + 4 + 4);

    const totalSize = headerBytes + vocabUtf8.byteLength + unigramBytes + bigramBytes;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    view.setUint32(0, CompactPersianLanguageModelScorer.MAGIC, true);
    view.setUint32(4, vocabList.length, true);
    view.setUint32(8, vocabUtf8.byteLength, true);
    view.setUint32(12, bigramCount, true);
    view.setFloat32(16, this.unknownWordLogProb, true);

    let offset = headerBytes;
    new Uint8Array(buffer, offset, vocabUtf8.byteLength).set(vocabUtf8);
    offset += vocabUtf8.byteLength;

    new Uint8Array(buffer, offset, unigramBytes).set(
      new Uint8Array(
        this.unigramLogProbs.buffer,
        this.unigramLogProbs.byteOffset,
        this.unigramLogProbs.byteLength,
      ),
    );
    offset += unigramBytes;

    new Uint8Array(buffer, offset, bigramCount * 4).set(
      new Uint8Array(
        this.bigramPrevIds.buffer,
        this.bigramPrevIds.byteOffset,
        this.bigramPrevIds.byteLength,
      ),
    );
    offset += bigramCount * 4;

    new Uint8Array(buffer, offset, bigramCount * 4).set(
      new Uint8Array(
        this.bigramCurrIds.buffer,
        this.bigramCurrIds.byteOffset,
        this.bigramCurrIds.byteLength,
      ),
    );
    offset += bigramCount * 4;

    new Uint8Array(buffer, offset, bigramCount * 4).set(
      new Uint8Array(
        this.bigramLogProbs.buffer,
        this.bigramLogProbs.byteOffset,
        this.bigramLogProbs.byteLength,
      ),
    );

    return new Uint8Array(buffer);
  }

  /**
   * 3. Instant binary model deserialization from disk/OPFS
   */
  public static loadFromBinary(bytes: Uint8Array): CompactPersianLanguageModelScorer {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== this.MAGIC) {
      throw new Error('INVALID_PLM1_MAGIC: فرمت فایل مدل زبان فارسی نامعتبر است.');
    }

    const vocabCount = view.getUint32(4, true);
    const vocabByteLen = view.getUint32(8, true);
    const bigramCount = view.getUint32(12, true);
    const unknownLogProb = view.getFloat32(16, true);

    const instance = new CompactPersianLanguageModelScorer();
    instance.unknownWordLogProb = unknownLogProb;

    let offset = 20;
    const vocabStr = new TextDecoder('utf-8').decode(
      bytes.subarray(offset, offset + vocabByteLen),
    );
    const words = vocabStr.length > 0 ? vocabStr.split('\n') : [];
    for (let i = 0; i < words.length; i++) {
      instance.wordToId.set(words[i], i);
    }
    offset += vocabByteLen;

    instance.unigramLogProbs = new Float32Array(
      bytes.slice(offset, offset + vocabCount * 4).buffer,
    );
    offset += vocabCount * 4;

    instance.bigramPrevIds = new Uint32Array(
      bytes.slice(offset, offset + bigramCount * 4).buffer,
    );
    offset += bigramCount * 4;

    instance.bigramCurrIds = new Uint32Array(
      bytes.slice(offset, offset + bigramCount * 4).buffer,
    );
    offset += bigramCount * 4;

    instance.bigramLogProbs = new Float32Array(
      bytes.slice(offset, offset + bigramCount * 4).buffer,
    );

    return instance;
  }

  /**
   * 4. Compute word transition log-probability (Bigram with Stupid Backoff to Unigram) in O(log N) with zero heap allocations
   */
  public scoreWordTransitionLogProb(prevWord: string | null, currentWord: string): number {
    const normCurr = PersianTextNormalizer.normalizeTokenText(currentWord);
    const currId = this.wordToId.get(normCurr);
    if (currId === undefined) return this.unknownWordLogProb;

    if (prevWord) {
      const normPrev = PersianTextNormalizer.normalizeTokenText(prevWord);
      const prevId = this.wordToId.get(normPrev);
      if (prevId !== undefined) {
        const bgLogProb = this.binarySearchBigram(prevId, currId);
        if (bgLogProb !== null) return bgLogProb;
      }
    }

    return (
      CompactPersianLanguageModelScorer.STUPID_BACKOFF_LOG_ALPHA +
      this.unigramLogProbs[currId]
    );
  }

  public isKnownPersianWord(word: string): boolean {
    const norm = PersianTextNormalizer.normalizeTokenText(word);
    return this.wordToId.has(norm);
  }

  private binarySearchBigram(prevId: number, currId: number): number | null {
    let low = 0;
    let high = this.bigramPrevIds.length - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const p = this.bigramPrevIds[mid];
      if (p < prevId) {
        low = mid + 1;
      } else if (p > prevId) {
        high = mid - 1;
      } else {
        const c = this.bigramCurrIds[mid];
        if (c < currId) {
          low = mid + 1;
        } else if (c > currId) {
          high = mid - 1;
        } else {
          return this.bigramLogProbs[mid];
        }
      }
    }

    return null;
  }
}
