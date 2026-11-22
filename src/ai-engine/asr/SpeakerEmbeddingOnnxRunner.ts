import { OrtRuntimeProvider, OrtSessionLike } from './UnifiedOnnxPersianAsrEngine';
import { OnnxPersianAsrAndVadAdapter } from '../OnnxPersianAsrAndVadAdapter';
import { VadSpeechSegment } from './SileroVadOnnxRunner';
import {
  FrameSpeakerEmbedding,
  SpeakerTimelineSegment,
} from '../MultiSpeakerDiarizationAndCrosstalkEngine';
import { TimeMath } from '../../contracts/timebase.contract';
import { TrackId } from '../../contracts/project-schema.contract';

export type EmbeddingMelLayout = 'B_T_M' | 'B_M_T'; // SpeechBrain/Wespeaker=[1,T,80] | NeMo TitaNet=[1,80,T]

/**
 * Section 113: Speaker Embedding ONNX Runner (ECAPA-TDNN / TitaNet) with Per-Bin CMVN, L2 Normalization,
 * and Agglomerative Hierarchical Clustering (AHC) for drift-free long-form diarization.
 */
export class SpeakerEmbeddingOnnxRunner {
  private session: OrtSessionLike | null = null;
  private readonly featureExtractor = new OnnxPersianAsrAndVadAdapter(
    'speaker-ecapa-tdnn',
    '1.0.0',
  );

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly inputTensorName: string = 'feats',
    private readonly layout: EmbeddingMelLayout = 'B_T_M',
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
   * 2. Infer single-window speaker embedding with Per-Bin Cepstral Mean Normalization (CMVN) and L2 normalization
   */
  private async inferSingleWindowEmbedding(
    pcm16kSlice: Float32Array,
  ): Promise<Float32Array> {
    if (!this.session) throw new Error('SPEAKER_EMBEDDING_SESSION_NOT_LOADED');

    const { melTensor, numFrames, nMels } =
      this.featureExtractor.computeLogMelSpectrogram(pcm16kSlice);
    if (numFrames === 0) return new Float32Array(192);

    // Compute and subtract temporal mean per Mel bin (Mean CMVN) to remove static microphone coloration
    const binMeans = new Float32Array(nMels);
    for (let t = 0; t < numFrames; t++) {
      const rowOff = t * nMels;
      for (let m = 0; m < nMels; m++) {
        binMeans[m] += melTensor[rowOff + m];
      }
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

    const inputTensor = this.ortProvider.createTensor('float32', tensorData, dims);
    const outputs = await this.session.run({ [this.inputTensorName]: inputTensor });
    const output = Object.values(outputs)[0];
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

    interface Cluster {
      memberIndices: number[];
      centroid: Float32Array;
    }

    // Initialize: each frame is an independent singleton cluster
    const clusters: Cluster[] = frames.map((f, idx) => ({
      memberIndices: [idx],
      centroid: new Float32Array(f.embeddingVector),
    }));

    // Iteratively merge the pair of clusters with highest cosine similarity until threshold
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

      const cA = clusters[bestI];
      const cB = clusters[bestJ];
      const mergedIndices = [...cA.memberIndices, ...cB.memberIndices];
      const dim = cA.centroid.length;
      const newCentroid = new Float32Array(dim);

      for (const idx of mergedIndices) {
        const v = frames[idx].embeddingVector;
        for (let d = 0; d < dim; d++) newCentroid[d] += v[d];
      }

      let norm = 0;
      for (let d = 0; d < dim; d++) norm += newCentroid[d] * newCentroid[d];
      norm = Math.sqrt(norm) + 1e-12;
      for (let d = 0; d < dim; d++) newCentroid[d] /= norm;

      clusters[bestI] = { memberIndices: mergedIndices, centroid: newCentroid };
      clusters.splice(bestJ, 1);
    }

    // Order speaker IDs by earliest appearance on the timeline (SPEAKER_1, SPEAKER_2, ...)
    clusters.sort(
      (a, b) => Math.min(...a.memberIndices) - Math.min(...b.memberIndices),
    );

    const frameToSpeakerId = new Array<string>(frames.length);
    clusters.forEach((cl, spkIdx) => {
      const label = `SPEAKER_${spkIdx + 1}`;
      for (const mIdx of cl.memberIndices) {
        frameToSpeakerId[mIdx] = label;
      }
    });

    return frames.map((f, idx) => ({
      segmentId: `ahc_${trackId}_${idx}`,
      trackId,
      speakerId: frameToSpeakerId[idx],
      classification: 'PRIMARY_SPEECH',
      range: f.range,
      confidence: Number(f.vadProbability.toFixed(2)),
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
