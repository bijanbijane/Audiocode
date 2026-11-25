/**
 * SHAHAB SHARED CORE — Host-Independent Recognition Engine (SHB-F06)
 *
 * Single authoritative recognition pipeline shared cleanly by AVAPARDAZ (Web/Node/Desktop)
 * and future companion hosts (e.g., Adobe Audition bridge), with ZERO imports from Node fs,
 * Express, React, ONNX Runtime concrete packages, or AVAPARDAZ workflow/UI modules.
 */

import {
  SHAHAB_CORE_CONTRACT_VERSION,
  SHAHAB_TARGET_SAMPLE_RATE_HZ,
  conditionPcmTo16kMono,
  decodeWavToMono16k,
  extractKaldiFbank80,
  mergeChunkedTranscriptWords,
  normalizeCanonicalPersianUtterance,
  planAudioChunks,
  resolveValidatedFrameStrideSec,
  runBatchedModifiedBeamSearch,
  runGreedyTransducerSearch,
  isSpecialBpeToken,
  type ChunkWordBucket,
  type ShahabCoreAudioInput,
  type ShahabCoreCapabilities,
  type ShahabCoreInferenceBackend,
  type ShahabCoreProgressEvent,
  type ShahabCoreRecognitionConfig,
  type ShahabCoreStructuredError,
  type ShahabCoreTranscriptOutput,
  type ShahabCoreTranscriptToken,
  type TimedWordLike,
} from './index-internal';

export class ShahabCoreError extends Error {
  public readonly structured: ShahabCoreStructuredError;

  constructor(
    code: ShahabCoreStructuredError['code'],
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'ShahabCoreError';
    this.structured = {
      contractVersion: SHAHAB_CORE_CONTRACT_VERSION,
      code,
      message,
      retryable,
    };
  }
}

function detectCoreLanguage(text: string): 'fa' | 'en' | 'fa-en' {
  const hasFa = /[\u0600-\u06FF]/.test(text);
  const hasEn = /[A-Za-z]/.test(text);
  if (hasFa && hasEn) return 'fa-en';
  if (hasEn && !hasFa) return 'en';
  return 'fa';
}

function projectCoreBpeTokensToTimedWords(params: {
  readonly rawText: string;
  readonly tokenIds: readonly number[];
  readonly tokenTimestampsSec: readonly number[];
  readonly vocab: readonly string[];
  readonly chunkOffsetSec: number;
  readonly chunkDurationSec: number;
}): TimedWordLike[] {
  const { rawText, tokenIds, tokenTimestampsSec, vocab, chunkOffsetSec, chunkDurationSec } = params;
  const maxEndSec = chunkOffsetSec + Math.max(0.05, chunkDurationSec);

  const grouped: Array<{ pieces: string[]; startSec: number; lastEmitSec: number }> = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const id = tokenIds[i];
    const piece = vocab[id];
    if (isSpecialBpeToken(id, piece)) continue;
    const rawTs = tokenTimestampsSec[i] ?? 0;
    const tsSec = Math.min(maxEndSec, chunkOffsetSec + Math.max(0, rawTs));
    const startsNewWord = piece.startsWith('▁') || grouped.length === 0;
    const cleanPiece = piece.replace(/^▁+/, '');
    if (startsNewWord) {
      if (cleanPiece.length > 0) {
        grouped.push({ pieces: [cleanPiece], startSec: tsSec, lastEmitSec: tsSec });
      }
    } else if (cleanPiece.length > 0) {
      const curr = grouped[grouped.length - 1];
      curr.pieces.push(cleanPiece);
      curr.lastEmitSec = Math.max(curr.lastEmitSec, tsSec);
    }
  }

  if (grouped.length === 0 && rawText.trim().length > 0) {
    const words = rawText.trim().split(/\s+/).filter(Boolean);
    const step = Math.max(0.05, chunkDurationSec) / Math.max(1, words.length);
    return words.map((word, idx) => {
      const ws = chunkOffsetSec + idx * step;
      const we = Math.min(maxEndSec, Math.max(ws + 0.04, ws + step));
      return { rawText: word, startSec: ws, endSec: we };
    });
  }

  const out: TimedWordLike[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const item = grouped[i];
    const wordText = item.pieces.join('').trim();
    if (!wordText) continue;
    const nextStart = i + 1 < grouped.length ? grouped[i + 1].startSec : maxEndSec;
    const startSec = Math.max(chunkOffsetSec, Math.min(item.startSec, maxEndSec - 0.04));
    const naturalEnd = Math.max(item.lastEmitSec + 0.08, startSec + 0.08);
    const endSec = Math.max(
      startSec + 0.04,
      Math.min(maxEndSec, nextStart > startSec + 0.04 ? Math.min(nextStart, naturalEnd + 0.25) : naturalEnd),
    );
    out.push({ rawText: wordText, startSec, endSec });
  }
  return out;
}

export class ShahabCoreEngine {
  private readonly backend: ShahabCoreInferenceBackend;

  constructor(backend: ShahabCoreInferenceBackend) {
    this.backend = backend;
  }

  public getCapabilities(): ShahabCoreCapabilities {
    return this.backend.getCapabilities();
  }

  public async initialize(): Promise<void> {
    await this.backend.initialize();
  }

  public async dispose(): Promise<void> {
    await this.backend.dispose();
  }

  public async transcribeWav(
    wavBytes: Uint8Array,
    config?: ShahabCoreRecognitionConfig & {
      readonly filename?: string;
      readonly signal?: AbortSignal;
      readonly onProgress?: (event: ShahabCoreProgressEvent) => void;
    },
  ): Promise<ShahabCoreTranscriptOutput> {
    let decoded: ReturnType<typeof decodeWavToMono16k>;
    try {
      decoded = decodeWavToMono16k(wavBytes);
    } catch (err) {
      throw new ShahabCoreError(
        'INVALID_AUDIO_INPUT',
        err instanceof Error ? err.message : String(err),
      );
    }
    return this.transcribe(
      {
        pcmFloat32: decoded.pcm16k,
        metadata: {
          sampleRateHz: SHAHAB_TARGET_SAMPLE_RATE_HZ,
          channels: 1,
          layout: 'interleaved',
          filename: config?.filename ?? 'audio.wav',
        },
      },
      config,
    );
  }

  public async transcribe(
    input: ShahabCoreAudioInput,
    config?: ShahabCoreRecognitionConfig & {
      readonly signal?: AbortSignal;
      readonly onProgress?: (event: ShahabCoreProgressEvent) => void;
    },
  ): Promise<ShahabCoreTranscriptOutput> {
    if (config?.signal?.aborted) {
      throw new ShahabCoreError('JOB_CANCELLED', 'Recognition job cancelled before start.');
    }

    const startedMs = performance.now();
    let conditioned: ReturnType<typeof conditionPcmTo16kMono>;
    try {
      conditioned = conditionPcmTo16kMono({
        pcm: input.pcmFloat32,
        sampleRateHz: input.metadata.sampleRateHz,
        channels: input.metadata.channels,
        layout: input.metadata.layout,
      });
    } catch (err) {
      throw new ShahabCoreError(
        'INVALID_AUDIO_INPUT',
        err instanceof Error ? err.message : String(err),
      );
    }

    await this.backend.initialize();
    const vocab = this.backend.getVocab();
    const pcm16k = conditioned.pcm16k;
    const durationSec = pcm16k.length / SHAHAB_TARGET_SAMPLE_RATE_HZ;
    const maxChunkSec = Math.max(4, Math.min(30, config?.maxChunkDurationSec ?? 24));
    const overlapSec = Math.max(0, Math.min(maxChunkSec * 0.25, config?.overlapSec ?? 1.0));
    const chunkRanges = planAudioChunks({
      totalSamples: pcm16k.length,
      sampleRate: SHAHAB_TARGET_SAMPLE_RATE_HZ,
      maxChunkSec,
      overlapSec,
    });

    const policy = config?.decodePolicy ?? 'BALANCED';
    const isGreedy = policy === 'SPEED';
    const beamSize = policy === 'PRECISION' ? 6 : policy === 'VERBATIM' ? 4 : 4;
    const blankPenalty = policy === 'VERBATIM' ? 0.25 : 0;

    const chunkBuckets: ChunkWordBucket<TimedWordLike>[] = [];
    const rawChunkTexts: string[] = [];

    for (let idx = 0; idx < chunkRanges.length; idx++) {
      if (config?.signal?.aborted) {
        throw new ShahabCoreError('JOB_CANCELLED', 'Recognition job cancelled during chunk loop.');
      }
      const range = chunkRanges[idx];
      const slice = pcm16k.subarray(range.startSample, range.endSample);
      const features = extractKaldiFbank80(slice);
      const encOut = await this.backend.runEncoder(features.data, features.numFrames, features.featureDim);
      const frameStrideSec = resolveValidatedFrameStrideSec({
        nominalFrameStrideSec: encOut.frameStrideSec ?? 0.04,
        numFrames: encOut.numFrames,
        audioDurationSec: slice.length / SHAHAB_TARGET_SAMPLE_RATE_HZ,
      });

      const callbacks = {
        runDecoderBatch: (contexts: readonly (readonly [number, number])[]) =>
          this.backend.runDecoderBatch(contexts),
        runJoinerBatch: (frameIdx: number, decoderVectors: readonly Float32Array[]) => {
          const frame = encOut.data.subarray(frameIdx * encOut.dim, (frameIdx + 1) * encOut.dim);
          return this.backend.runJoinerBatch(frame, decoderVectors, encOut.dim);
        },
      };

      const decoded = isGreedy
        ? await runGreedyTransducerSearch({
            numFrames: encOut.numFrames,
            vocab,
            blankPenalty,
            frameStrideSec,
            signal: config?.signal,
            onCancelled: () => new ShahabCoreError('JOB_CANCELLED', 'Recognition cancelled.'),
            callbacks,
          })
        : await runBatchedModifiedBeamSearch({
            numFrames: encOut.numFrames,
            vocab,
            beamSize,
            blankPenalty,
            frameStrideSec,
            signal: config?.signal,
            onCancelled: () => new ShahabCoreError('JOB_CANCELLED', 'Recognition cancelled.'),
            callbacks,
          });

      if (decoded.rawText.trim().length > 0) {
        rawChunkTexts.push(decoded.rawText.trim());
      }
      chunkBuckets.push({
        chunkStartSec: range.startSec,
        chunkEndSec: range.endSec,
        words: projectCoreBpeTokensToTimedWords({
          rawText: decoded.rawText,
          tokenIds: decoded.tokenIds,
          tokenTimestampsSec: decoded.tokenTimestampsSec,
          vocab,
          chunkOffsetSec: range.startSec,
          chunkDurationSec: slice.length / SHAHAB_TARGET_SAMPLE_RATE_HZ,
        }),
      });

      config?.onProgress?.({
        percent: Math.round(((idx + 1) / chunkRanges.length) * 100),
        currentChunk: idx + 1,
        totalChunks: chunkRanges.length,
        elapsedMs: Math.round(performance.now() - startedMs),
        partialText: rawChunkTexts.join(' '),
      });
    }

    const mergedWords = mergeChunkedTranscriptWords({
      buckets: chunkBuckets,
      totalDurationSec: durationSec,
    });
    const tokens: ShahabCoreTranscriptToken[] = mergedWords.map((w, idx) => {
      const startSample = Math.max(0, Math.round(w.startSec * SHAHAB_TARGET_SAMPLE_RATE_HZ));
      const endSample = Math.min(
        pcm16k.length,
        Math.max(startSample + 1, Math.round(w.endSec * SHAHAB_TARGET_SAMPLE_RATE_HZ)),
      );
      return {
        tokenId: `shahab_core_tok_${idx}`,
        rawText: w.rawText,
        normalizedText: normalizeCanonicalPersianUtterance(w.rawText) || w.rawText,
        startSec: Number((startSample / SHAHAB_TARGET_SAMPLE_RATE_HZ).toFixed(4)),
        endSec: Number((endSample / SHAHAB_TARGET_SAMPLE_RATE_HZ).toFixed(4)),
        startSample,
        endSample,
        confidence: null,
        timestampGranularity: 'SEGMENT_ESTIMATED',
      };
    });

    const rawText =
      chunkRanges.length === 1
        ? (rawChunkTexts[0] ?? '').trim()
        : tokens.map((t) => t.rawText).join(' ').trim();
    const normalizedText = normalizeCanonicalPersianUtterance(rawText);
    const processingTimeMs = Math.max(1, Math.round(performance.now() - startedMs));

    if (config?.unloadAfterTranscribe) {
      await this.backend.dispose();
    }

    return {
      contractVersion: SHAHAB_CORE_CONTRACT_VERSION,
      modelId: this.backend.modelId,
      modelVersion: this.backend.modelVersion,
      executionProvider: this.backend.executionProvider,
      rawText,
      normalizedText,
      language: detectCoreLanguage(normalizedText || rawText),
      sampleRateHz: SHAHAB_TARGET_SAMPLE_RATE_HZ,
      totalSourceSamples: pcm16k.length,
      durationSec: Number(durationSec.toFixed(4)),
      tokens,
      timestampGranularity: tokens.length > 0 ? 'SEGMENT_ESTIMATED' : 'NONE',
      processingTimeMs,
      realTimeFactor: durationSec > 0 ? Number(((processingTimeMs / 1000) / durationSec).toFixed(4)) : 0,
      offlineVerified: true,
    };
  }
}

export function createShahabCoreEngine(backend: ShahabCoreInferenceBackend): ShahabCoreEngine {
  return new ShahabCoreEngine(backend);
}
