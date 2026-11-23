import { OrtRuntimeProvider, OrtSessionLike } from './UnifiedOnnxPersianAsrEngine';
import { OnnxPersianAsrAndVadAdapter } from '../OnnxPersianAsrAndVadAdapter';
import { WespeakerKaldiFbank80 } from './WespeakerKaldiFbank80';
import { VadSpeechSegment } from './SileroVadOnnxRunner';
import {
  FrameSpeakerEmbedding,
  SpeakerTimelineSegment,
} from '../MultiSpeakerDiarizationAndCrosstalkEngine';
import { TimeMath } from '../../contracts/timebase.contract';
import { TrackId } from '../../contracts/project-schema.contract';

export type EmbeddingMelLayout = 'B_T_M' | 'B_M_T'; // Feature-model layouts: [1,T,80] or [1,80,T]
export type SpeakerEmbeddingInputMode = 'LOG_MEL_FEATURES' | 'KALDI_FBANK' | 'WAVEFORM';

/**
 * Section 113: Speaker Embedding ONNX Runner (ECAPA-TDNN / TitaNet) with explicit
 * feature-input or waveform-native contracts, L2 normalization, and AHC clustering.
 *
 * IMPORTANT: LOG_MEL_FEATURES is a generic frontend contract, not a claim of parity
 * with SpeechBrain Fbank. Use WAVEFORM only when the selected ONNX graph embeds
 * its own feature frontend and declares compatible input/output names.
 */
export class SpeakerEmbeddingOnnxRunner {
  private session: OrtSessionLike | null = null;
  private readonly featureExtractor = new OnnxPersianAsrAndVadAdapter(
    'speaker-ecapa-tdnn',
    '1.0.0',
  );
  private readonly wespeakerFbank = new WespeakerKaldiFbank80();

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly inputTensorName: string = 'feats',
    private readonly layout: EmbeddingMelLayout = 'B_T_M',
    private readonly inputMode: SpeakerEmbeddingInputMode = 'LOG_MEL_FEATURES',
    private readonly lengthTensorName: string = 'lens',
    private readonly outputTensorName?: string,
  ) {}

  public async loadModel(
    modelBytesOrPath: Uint8Array | string,
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[],
  ): Promise<void> {
    this.session = await this.ortProvider.createSession(
      modelBytesOrPath,
      executionProviders,
    );
  }

  public async unloadModel(): Promise<void> {
    if (this.session?.release) await this.session.release();
    this.session = null;
  }

  /**
   * 1. Extract L2-normalized speaker embeddings across all active VAD segments using a 1.5s sliding window
   */
  public async extractEmbeddingsForVadSegments(
    pcm16kMono: Float32Array,
    vadSegments: VadSpeechSegment[],
    windowDurationSec: number = 1.5,
    hopDurationSec: number = 0.75,
  ): Promise<FrameSpeakerEmbedding[]> {
    if (!this.session) throw new Error('SPEAKER_EMBEDDING_SESSION_NOT_LOADED');
    if (!(pcm16kMono instanceof Float32Array)) {
      throw new TypeError('SPEAKER_EMBEDDING_AUDIO_MUST_BE_FLOAT32ARRAY');
    }
    if (!Array.isArray(vadSegments)) {
      throw new TypeError('SPEAKER_EMBEDDING_VAD_SEGMENTS_MUST_BE_ARRAY');
    }
    if (!Number.isFinite(windowDurationSec) || windowDurationSec <= 0) {
      throw new RangeError('SPEAKER_EMBEDDING_WINDOW_DURATION_MUST_BE_POSITIVE');
    }
    if (
      !Number.isFinite(hopDurationSec) ||
      hopDurationSec <= 0 ||
      hopDurationSec > windowDurationSec
    ) {
      throw new RangeError('SPEAKER_EMBEDDING_HOP_MUST_BE_POSITIVE_AND_NOT_EXCEED_WINDOW');
    }

    const sr = 16000;
    const winSamples = Math.floor(sr * windowDurationSec);
    const hopSamples = Math.floor(sr * hopDurationSec);
    const minSubWinSamples = Math.floor(sr * 0.4); // Minimum 400ms audio for valid speaker embedding
    if (winSamples < 1 || hopSamples < 1) {
      throw new RangeError('SPEAKER_EMBEDDING_WINDOW_AND_HOP_MUST_BE_AT_LEAST_ONE_SAMPLE');
    }

    for (const segment of vadSegments) {
      if (
        !Number.isSafeInteger(segment.startSample16k) ||
        !Number.isSafeInteger(segment.endSample16k) ||
        segment.startSample16k < 0 ||
        segment.endSample16k <= segment.startSample16k ||
        segment.endSample16k > pcm16kMono.length
      ) {
        throw new RangeError('SPEAKER_EMBEDDING_VAD_SEGMENT_OUT_OF_AUDIO_BOUNDS');
      }
    }

    if (this.inputMode === 'KALDI_FBANK') {
      return this.extractWespeakerKaldiSubsegments(
        pcm16kMono,
        vadSegments,
        windowDurationSec,
        hopDurationSec,
      );
    }

    const embeddings: FrameSpeakerEmbedding[] = [];

    for (const seg of vadSegments) {
      const segLen = seg.endSample16k - seg.startSample16k;
      if (segLen < minSubWinSamples) continue;

      if (segLen <= winSamples) {
        const vec = await this.inferSingleWindowEmbedding(
          pcm16kMono.subarray(seg.startSample16k, seg.endSample16k),
        );
        embeddings.push({
          range: seg.range,
          embeddingVector: vec,
          vadProbability: seg.peakSpeechProb,
        });
        continue;
      }

      for (
        let pos = seg.startSample16k;
        pos + minSubWinSamples <= seg.endSample16k;
        pos += hopSamples
      ) {
        const end = Math.min(seg.endSample16k, pos + winSamples);
        const vec = await this.inferSingleWindowEmbedding(pcm16kMono.subarray(pos, end));
        embeddings.push({
          range: {
            start: TimeMath.samplesToFlicks(pos, sr),
            end: TimeMath.samplesToFlicks(end, sr),
          },
          embeddingVector: vec,
          vadProbability: seg.peakSpeechProb,
        });
        if (end === seg.endSample16k) break;
      }
    }

    return embeddings;
  }

  /**
   * Match WeSpeaker's official diarization extraction:
   * compute FBANK on each complete VAD region without CMN, split by configured
   * frame windows, resize short/tail feature matrices to the fixed window length,
   * then apply per-subsegment CMN before ONNX inference.
   */
  private async extractWespeakerKaldiSubsegments(
    pcm16kMono: Float32Array,
    vadSegments: VadSpeechSegment[],
    windowDurationSec: number,
    hopDurationSec: number,
  ): Promise<FrameSpeakerEmbedding[]> {
    const sampleRate = 16000;
    const frameShiftSamples = 160;
    const numMelBins = 80;
    const windowFrames = Math.floor((windowDurationSec * 1000) / 10);
    const hopFrames = Math.floor((hopDurationSec * 1000) / 10);
    const minSegmentSamples = Math.floor(sampleRate * 0.255);

    if (windowFrames < 1 || hopFrames < 1 || hopFrames > windowFrames) {
      throw new RangeError('WESPEAKER_SUBSEGMENT_FRAME_WINDOW_OR_HOP_INVALID');
    }

    const embeddings: FrameSpeakerEmbedding[] = [];
    for (const segment of vadSegments) {
      const segmentSamples = segment.endSample16k - segment.startSample16k;
      if (segmentSamples < minSegmentSamples) continue;

      const segmentPcm = pcm16kMono.subarray(
        segment.startSample16k,
        segment.endSample16k,
      );
      const fbank = this.wespeakerFbank.compute(segmentPcm, {
        applyCepstralMeanNormalization: false,
      });
      if (fbank.numFrames === 0) continue;

      // WeSpeaker derives subsegment length from the original VAD duration in
      // 10 ms frames. Kaldi snip-edges FBANK has two fewer frames; the official
      // recipe repeats available rows to fill each fixed-size subsegment.
      const segmentLengthFrames = Math.floor(segmentSamples / frameShiftSamples);
      const subsegmentRanges: Array<{ startFrame: number; endFrame: number }> = [];

      if (segmentLengthFrames <= windowFrames) {
        subsegmentRanges.push({ startFrame: 0, endFrame: segmentLengthFrames });
      } else {
        const maxSubsegmentStart = segmentLengthFrames - windowFrames + hopFrames;
        for (let startFrame = 0; startFrame < maxSubsegmentStart; startFrame += hopFrames) {
          subsegmentRanges.push({
            startFrame,
            endFrame: Math.min(startFrame + windowFrames, segmentLengthFrames),
          });
        }
      }

      for (const subsegment of subsegmentRanges) {
        const availableStart = Math.min(subsegment.startFrame, fbank.numFrames);
        const availableEnd = Math.min(subsegment.endFrame, fbank.numFrames);
        const availableFrames = availableEnd - availableStart;
        if (availableFrames <= 0) continue;

        const windowFeatures = new Float32Array(windowFrames * numMelBins);
        for (let frame = 0; frame < windowFrames; frame++) {
          const sourceFrame = availableStart + (frame % availableFrames);
          const sourceOffset = sourceFrame * numMelBins;
          const targetOffset = frame * numMelBins;
          windowFeatures.set(
            fbank.features.subarray(sourceOffset, sourceOffset + numMelBins),
            targetOffset,
          );
        }

        // Official diarization applies CMN independently after subsegmenting.
        const means = new Float64Array(numMelBins);
        for (let frame = 0; frame < windowFrames; frame++) {
          const offset = frame * numMelBins;
          for (let mel = 0; mel < numMelBins; mel++) {
            means[mel] += windowFeatures[offset + mel];
          }
        }
        for (let mel = 0; mel < numMelBins; mel++) means[mel] /= windowFrames;
        for (let frame = 0; frame < windowFrames; frame++) {
          const offset = frame * numMelBins;
          for (let mel = 0; mel < numMelBins; mel++) {
            windowFeatures[offset + mel] -= means[mel];
          }
        }

        const input = this.ortProvider.createTensor(
          'float32',
          windowFeatures,
          [1, windowFrames, numMelBins],
        );
        const outputs = await this.session!.run({ [this.inputTensorName]: input });
        const output = this.outputTensorName
          ? outputs[this.outputTensorName]
          : Object.values(outputs)[0];
        if (!output || !(output.data instanceof Float32Array) || output.data.length === 0) {
          throw new Error('SPEAKER_EMBEDDING_MODEL_RETURNED_EMPTY_OR_NON_FLOAT_OUTPUT');
        }

        const startSample = segment.startSample16k + subsegment.startFrame * frameShiftSamples;
        const endSample = Math.min(
          segment.endSample16k,
          segment.startSample16k + subsegment.endFrame * frameShiftSamples,
        );
        if (endSample <= startSample) continue;

        embeddings.push({
          range: {
            start: TimeMath.samplesToFlicks(startSample, sampleRate),
            end: TimeMath.samplesToFlicks(endSample, sampleRate),
          },
          embeddingVector: this.l2Normalize(new Float32Array(output.data)),
          vadProbability: segment.peakSpeechProb,
        });
      }
    }

    return embeddings;
  }

  /**
   * 2. Infer single-window speaker embedding with Per-Bin Cepstral Mean Normalization (CMVN) and L2 normalization
   */
  private async inferSingleWindowEmbedding(
    pcm16kSlice: Float32Array,
  ): Promise<Float32Array> {
    if (!this.session) throw new Error('SPEAKER_EMBEDDING_SESSION_NOT_LOADED');

    let feeds: Record<string, ReturnType<OrtRuntimeProvider['createTensor']>>;

    if (this.inputMode === 'WAVEFORM') {
      const waveform = new Float32Array(pcm16kSlice);
      const lengths = this.ortProvider.createTensor(
        'float32',
        new Float32Array([1.0]),
        [1],
      );
      feeds = {
        [this.inputTensorName]: this.ortProvider.createTensor(
          'float32',
          waveform,
          [1, waveform.length],
        ),
        [this.lengthTensorName]: lengths,
      };
    } else if (this.inputMode === 'KALDI_FBANK') {
      const { features, numFrames, numMelBins } = this.wespeakerFbank.compute(
        pcm16kSlice,
        { applyCepstralMeanNormalization: true },
      );
      if (numFrames === 0) {
        throw new Error('WESPEAKER_FBANK_AUDIO_TOO_SHORT_FOR_FEATURE_FRONTEND');
      }

      let tensorData: Float32Array;
      let dims: readonly number[];
      if (this.layout === 'B_T_M') {
        tensorData = features;
        dims = [1, numFrames, numMelBins];
      } else {
        tensorData = new Float32Array(numMelBins * numFrames);
        for (let t = 0; t < numFrames; t++) {
          for (let m = 0; m < numMelBins; m++) {
            tensorData[m * numFrames + t] = features[t * numMelBins + m];
          }
        }
        dims = [1, numMelBins, numFrames];
      }
      feeds = {
        [this.inputTensorName]: this.ortProvider.createTensor('float32', tensorData, dims),
      };
    } else {
      const { melTensor, numFrames, nMels } =
        this.featureExtractor.computeLogMelSpectrogram(pcm16kSlice);
      if (numFrames === 0) {
        throw new Error('SPEAKER_EMBEDDING_AUDIO_TOO_SHORT_FOR_FEATURE_FRONTEND');
      }

      // This generic frontend is retained for compatible feature graphs only.
      const binMeans = new Float32Array(nMels);
      for (let t = 0; t < numFrames; t++) {
        const rowOff = t * nMels;
        for (let m = 0; m < nMels; m++) binMeans[m] += melTensor[rowOff + m];
      }
      for (let m = 0; m < nMels; m++) binMeans[m] /= numFrames;

      let tensorData: Float32Array;
      let dims: readonly number[];
      if (this.layout === 'B_T_M') {
        tensorData = new Float32Array(numFrames * nMels);
        for (let t = 0; t < numFrames; t++) {
          const rowOff = t * nMels;
          for (let m = 0; m < nMels; m++) {
            tensorData[rowOff + m] = melTensor[rowOff + m] - binMeans[m];
          }
        }
        dims = [1, numFrames, nMels];
      } else {
        tensorData = new Float32Array(nMels * numFrames);
        for (let t = 0; t < numFrames; t++) {
          const rowOff = t * nMels;
          for (let m = 0; m < nMels; m++) {
            tensorData[m * numFrames + t] = melTensor[rowOff + m] - binMeans[m];
          }
        }
        dims = [1, nMels, numFrames];
      }
      feeds = {
        [this.inputTensorName]: this.ortProvider.createTensor('float32', tensorData, dims),
      };
    }

    const outputs = await this.session.run(feeds);
    const output = this.outputTensorName
      ? outputs[this.outputTensorName]
      : Object.values(outputs)[0];
    if (!output || !(output.data instanceof Float32Array) || output.data.length === 0) {
      throw new Error('SPEAKER_EMBEDDING_MODEL_RETURNED_EMPTY_OR_NON_FLOAT_OUTPUT');
    }

    return this.l2Normalize(new Float32Array(output.data));
  }

  /**
   * 3. Agglomerative Hierarchical Clustering (AHC) by Cosine Similarity
   * Prevents centroid drift across 1-3 hour Persian interviews
   */
  public static clusterEmbeddingsHierarchicalAhc(
    trackId: TrackId,
    frames: FrameSpeakerEmbedding[],
    cosineStopThreshold: number = 0.68,
    maxSpeakers: number = 8,
  ): SpeakerTimelineSegment[] {
    if (frames.length === 0) return [];
    if (
      !Number.isFinite(cosineStopThreshold) ||
      cosineStopThreshold < -1 ||
      cosineStopThreshold > 1
    ) {
      throw new RangeError('SPEAKER_AHC_COSINE_THRESHOLD_MUST_BE_BETWEEN_MINUS_ONE_AND_ONE');
    }
    if (!Number.isSafeInteger(maxSpeakers) || maxSpeakers < 1) {
      throw new RangeError('SPEAKER_AHC_MAX_SPEAKERS_MUST_BE_A_POSITIVE_INTEGER');
    }

    const embeddingDimension = frames[0].embeddingVector?.length ?? 0;
    if (embeddingDimension < 1) {
      throw new Error('SPEAKER_AHC_EMBEDDING_VECTOR_EMPTY');
    }

    const normalizedVectors = frames.map((frame, frameIndex) => {
      const vector = frame.embeddingVector;
      if (!(vector instanceof Float32Array) || vector.length === 0) {
        throw new Error(`SPEAKER_AHC_EMBEDDING_VECTOR_EMPTY_AT_FRAME_${frameIndex}`);
      }
      if (vector.length !== embeddingDimension) {
        throw new RangeError(`SPEAKER_AHC_EMBEDDING_DIMENSION_MISMATCH_AT_FRAME_${frameIndex}`);
      }

      let normSq = 0;
      for (let d = 0; d < vector.length; d++) {
        if (!Number.isFinite(vector[d])) {
          throw new Error(`SPEAKER_AHC_EMBEDDING_NON_FINITE_VALUE_AT_FRAME_${frameIndex}`);
        }
        normSq += vector[d] * vector[d];
      }
      if (!Number.isFinite(normSq) || normSq <= 1e-12) {
        throw new Error(`SPEAKER_AHC_EMBEDDING_ZERO_OR_INVALID_NORM_AT_FRAME_${frameIndex}`);
      }

      const inverseNorm = 1 / Math.sqrt(normSq);
      const normalized = new Float32Array(vector.length);
      for (let d = 0; d < vector.length; d++) {
        normalized[d] = vector[d] * inverseNorm;
      }
      return normalized;
    });

    interface Cluster {
      memberIndices: number[];
      centroid: Float32Array;
    }

    // Normalize upfront so the dot product below is a true cosine similarity.
    const clusters: Cluster[] = normalizedVectors.map((vector, idx) => ({
      memberIndices: [idx],
      centroid: new Float32Array(vector),
    }));

    while (clusters.length > 1) {
      let bestI = -1;
      let bestJ = -1;
      let maxSim = -1;

      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const sim = this.dotProduct(clusters[i].centroid, clusters[j].centroid);
          if (sim > maxSim) {
            maxSim = sim;
            bestI = i;
            bestJ = j;
          }
        }
      }

      if (
        bestI === -1 ||
        (maxSim < cosineStopThreshold && clusters.length <= maxSpeakers)
      ) {
        break;
      }

      const clusterA = clusters[bestI];
      const clusterB = clusters[bestJ];
      const mergedIndices = [...clusterA.memberIndices, ...clusterB.memberIndices];
      const newCentroid = new Float32Array(embeddingDimension);

      for (const index of mergedIndices) {
        const vector = normalizedVectors[index];
        for (let d = 0; d < embeddingDimension; d++) {
          newCentroid[d] += vector[d];
        }
      }

      let normSq = 0;
      for (let d = 0; d < embeddingDimension; d++) {
        normSq += newCentroid[d] * newCentroid[d];
      }
      if (!Number.isFinite(normSq) || normSq <= 1e-12) {
        throw new Error('SPEAKER_AHC_MERGED_CENTROID_HAS_ZERO_OR_INVALID_NORM');
      }
      const inverseNorm = 1 / Math.sqrt(normSq);
      for (let d = 0; d < embeddingDimension; d++) {
        newCentroid[d] *= inverseNorm;
      }

      clusters[bestI] = { memberIndices: mergedIndices, centroid: newCentroid };
      clusters.splice(bestJ, 1);
    }

    // Order speaker IDs by earliest appearance on the timeline (SPEAKER_1, SPEAKER_2, ...).
    clusters.sort(
      (a, b) => Math.min(...a.memberIndices) - Math.min(...b.memberIndices),
    );

    const frameToSpeakerId = new Array<string>(frames.length);
    clusters.forEach((cluster, speakerIndex) => {
      const label = `SPEAKER_${speakerIndex + 1}`;
      for (const memberIndex of cluster.memberIndices) {
        frameToSpeakerId[memberIndex] = label;
      }
    });

    return frames.map((frame, index) => ({
      segmentId: `ahc_${trackId}_${index}`,
      trackId,
      speakerId: frameToSpeakerId[index],
      classification: 'PRIMARY_SPEECH',
      range: frame.range,
      confidence: Number(frame.vadProbability.toFixed(2)),
      manuallyVerifiedByUser: false,
    }));
  }

  private l2Normalize(vec: Float32Array): Float32Array {
    if (vec.length === 0) {
      throw new Error('SPEAKER_EMBEDDING_VECTOR_EMPTY');
    }

    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      if (!Number.isFinite(vec[i])) {
        throw new Error('SPEAKER_EMBEDDING_VECTOR_CONTAINS_NON_FINITE_VALUE');
      }
      sumSq += vec[i] * vec[i];
    }
    if (!Number.isFinite(sumSq) || sumSq <= 1e-12) {
      throw new Error('SPEAKER_EMBEDDING_VECTOR_HAS_ZERO_OR_INVALID_NORM');
    }

    const invNorm = 1.0 / Math.sqrt(sumSq);
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] * invNorm;
    return out;
  }

  private static dotProduct(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }
}
