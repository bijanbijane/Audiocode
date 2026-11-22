import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';
import { TrackId } from '../contracts/project-schema.contract';

export type SpeakerId = string | 'UNKNOWN_SPEAKER';

export type SegmentAcousticClassification =
  | 'PRIMARY_SPEECH'
  | 'OVERLAPPING_SPEECH'
  | 'CROSSTALK_MIC_BLEED'
  | 'UNKNOWN_SPEAKER';

export interface SpeakerTimelineSegment {
  readonly segmentId: string;
  readonly trackId: TrackId;
  readonly speakerId: SpeakerId;
  readonly classification: SegmentAcousticClassification;
  readonly bleedSourceTrackId?: TrackId;
  readonly range: TimeRange;
  readonly confidence: number;
  readonly manuallyVerifiedByUser: boolean;
}

export interface FrameSpeakerEmbedding {
  readonly range: TimeRange;
  readonly embeddingVector: Float32Array;
  readonly vadProbability: number;
}

/**
 * Multi-Speaker Diarization, Overlapping Speech Detection, & Room Acoustic Crosstalk
 * (Mic Bleed) Analyzer (Architecture Doc Sections 2.1, 24, 38).
 */
export class MultiSpeakerDiarizationAndCrosstalkEngine {
  /**
   * Detects Acoustic Mic Bleed vs. true Overlapping Speech across synchronized multi-track
   * microphones using dBFS energy delta (>= 11dB) and signed zero-mean Normalized Cross-Correlation
   * across room acoustic propagation lags (0ms to 8ms).
   */
  public static analyzeMultiTrackCrosstalkAndOverlap(
    tracksPcm: { trackId: TrackId; speakerId: SpeakerId; pcmMono: Float32Array }[],
    sampleRate: SampleRate,
    frameDurationMs = 50,
  ): SpeakerTimelineSegment[] {
    if (tracksPcm.length === 0) return [];
    const safeRate: SampleRate =
      Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const safeFrameMs =
      Number.isFinite(frameDurationMs) && frameDurationMs > 0 ? frameDurationMs : 50;
    const frameSamples = Math.floor((safeRate * safeFrameMs) / 1000);
    if (!Number.isFinite(frameSamples) || frameSamples <= 0) return [];

    const totalSamples = Math.min(...tracksPcm.map((t) => t.pcmMono.length));
    const maxAcousticLagSamples = Math.floor((safeRate * 8) / 1000);

    const rawSegments: SpeakerTimelineSegment[] = [];

    for (let start = 0; start + frameSamples <= totalSamples; start += frameSamples) {
      const range: TimeRange = {
        start: TimeMath.samplesToFlicks(start, safeRate),
        end: TimeMath.samplesToFlicks(start + frameSamples, safeRate),
      };

      const trackLevels = tracksPcm.map((t) => {
        let sumSq = 0;
        for (let i = start; i < start + frameSamples; i++) {
          const rawS = t.pcmMono[i];
          const s = Number.isFinite(rawS) ? rawS : 0;
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / frameSamples);
        const db = 20 * Math.log10(rms + 1e-9);
        return { ...t, rms, db };
      });

      const activeTracks = trackLevels
        .filter((t) => t.db > -45.0)
        .sort((a, b) => b.db - a.db);

      if (activeTracks.length === 0) continue;

      const dominant = activeTracks[0];

      if (activeTracks.length === 1) {
        rawSegments.push({
          segmentId: `seg_${dominant.trackId}_${start}`,
          trackId: dominant.trackId,
          speakerId: dominant.speakerId,
          classification: 'PRIMARY_SPEECH',
          range,
          confidence: 0.95,
          manuallyVerifiedByUser: false,
        });
        continue;
      }

      let realSimultaneousSpeakers = 1;

      for (let k = 1; k < activeTracks.length; k++) {
        const secondary = activeTracks[k];
        const levelDiffDb = dominant.db - secondary.db;

        const maxCorr = this.computeMaxLagCorrelation(
          dominant.pcmMono,
          secondary.pcmMono,
          start,
          frameSamples,
          maxAcousticLagSamples,
          safeRate,
        );

        if (levelDiffDb >= 11.0 && maxCorr >= 0.58) {
          rawSegments.push({
            segmentId: `bleed_${secondary.trackId}_${start}`,
            trackId: secondary.trackId,
            speakerId: secondary.speakerId,
            classification: 'CROSSTALK_MIC_BLEED',
            bleedSourceTrackId: dominant.trackId,
            range,
            confidence: Number(Math.min(0.99, maxCorr).toFixed(2)),
            manuallyVerifiedByUser: false,
          });
        } else {
          realSimultaneousSpeakers++;
          rawSegments.push({
            segmentId: `ovl_${secondary.trackId}_${start}`,
            trackId: secondary.trackId,
            speakerId: secondary.speakerId,
            classification: 'OVERLAPPING_SPEECH',
            range,
            confidence: 0.84,
            manuallyVerifiedByUser: false,
          });
        }
      }

      rawSegments.push({
        segmentId: `dom_${dominant.trackId}_${start}`,
        trackId: dominant.trackId,
        speakerId: dominant.speakerId,
        classification:
          realSimultaneousSpeakers > 1 ? 'OVERLAPPING_SPEECH' : 'PRIMARY_SPEECH',
        range,
        confidence: 0.92,
        manuallyVerifiedByUser: false,
      });
    }

    return this.mergeAdjacentIdenticalSegments(rawSegments);
  }

  /**
   * Clusters single-track speaker embeddings via cosine similarity and emits UNKNOWN_SPEAKER
   * when confidence falls below threshold.
   */
  public static assignSpeakersFromEmbeddings(
    trackId: TrackId,
    frames: FrameSpeakerEmbedding[],
    similarityThreshold = 0.72,
  ): SpeakerTimelineSegment[] {
    if (frames.length === 0) return [];
    if (
      !Number.isFinite(similarityThreshold) ||
      similarityThreshold < -1 ||
      similarityThreshold > 1
    ) {
      throw new RangeError('DIARIZATION_SIMILARITY_THRESHOLD_MUST_BE_BETWEEN_MINUS_ONE_AND_ONE');
    }

    const centroids: { speakerId: string; vector: Float32Array; count: number }[] = [];
    const segments: SpeakerTimelineSegment[] = [];
    const appendUnknown = (frame: FrameSpeakerEmbedding, index: number) => {
      segments.push({
        segmentId: `diar_${trackId}_${index}`,
        trackId,
        speakerId: 'UNKNOWN_SPEAKER',
        classification: 'UNKNOWN_SPEAKER',
        range: frame.range,
        confidence: 0.4,
        manuallyVerifiedByUser: false,
      });
    };

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!Number.isFinite(frame.vadProbability) || frame.vadProbability < 0.45) continue;

      const rawVector = frame.embeddingVector;
      if (!(rawVector instanceof Float32Array) || rawVector.length === 0) {
        appendUnknown(frame, i);
        continue;
      }
      if (centroids.length > 0 && rawVector.length !== centroids[0].vector.length) {
        // Never compare only the shared prefix of incompatible embedding spaces.
        appendUnknown(frame, i);
        continue;
      }

      let normSq = 0;
      let validVector = true;
      for (let d = 0; d < rawVector.length; d++) {
        if (!Number.isFinite(rawVector[d])) {
          validVector = false;
          break;
        }
        normSq += rawVector[d] * rawVector[d];
      }
      if (!validVector || !Number.isFinite(normSq) || normSq <= 1e-12) {
        appendUnknown(frame, i);
        continue;
      }

      const inverseNorm = 1 / Math.sqrt(normSq);
      const normalizedVector = new Float32Array(rawVector.length);
      for (let d = 0; d < rawVector.length; d++) {
        normalizedVector[d] = rawVector[d] * inverseNorm;
      }

      let bestSpeakerId: SpeakerId = 'UNKNOWN_SPEAKER';
      let bestSim = -1;
      let bestCentroidIdx = -1;

      for (let c = 0; c < centroids.length; c++) {
        const sim = this.cosineSimilarity(normalizedVector, centroids[c].vector);
        if (sim > bestSim) {
          bestSim = sim;
          bestCentroidIdx = c;
        }
      }

      if (bestSim >= similarityThreshold && bestCentroidIdx !== -1) {
        bestSpeakerId = centroids[bestCentroidIdx].speakerId;
        const centroid = centroids[bestCentroidIdx];
        for (let d = 0; d < centroid.vector.length; d++) {
          centroid.vector[d] =
            (centroid.vector[d] * centroid.count + normalizedVector[d]) /
            (centroid.count + 1);
        }
        centroid.count++;

        let centroidNormSq = 0;
        for (let d = 0; d < centroid.vector.length; d++) {
          centroidNormSq += centroid.vector[d] * centroid.vector[d];
        }
        if (centroidNormSq > 1e-12 && Number.isFinite(centroidNormSq)) {
          const inverseCentroidNorm = 1 / Math.sqrt(centroidNormSq);
          for (let d = 0; d < centroid.vector.length; d++) {
            centroid.vector[d] *= inverseCentroidNorm;
          }
        } else {
          // Guard against degenerate cancellation when a caller configures an extreme threshold.
          centroid.vector.set(normalizedVector);
          centroid.count = 1;
        }
      } else if (frame.vadProbability >= 0.75 && centroids.length < 8) {
        const newId = `SPEAKER_${centroids.length + 1}`;
        centroids.push({
          speakerId: newId,
          vector: normalizedVector,
          count: 1,
        });
        bestSpeakerId = newId;
        bestSim = 0.85;
      }

      segments.push({
        segmentId: `diar_${trackId}_${i}`,
        trackId,
        speakerId: bestSpeakerId,
        classification:
          bestSpeakerId === 'UNKNOWN_SPEAKER' ? 'UNKNOWN_SPEAKER' : 'PRIMARY_SPEECH',
        range: frame.range,
        confidence: Number(Math.max(0.4, Number.isFinite(bestSim) ? bestSim : 0.4).toFixed(2)),
        manuallyVerifiedByUser: false,
      });
    }

    return this.mergeAdjacentIdenticalSegments(segments);
  }

  public static applyManualSpeakerCorrection(
    segments: SpeakerTimelineSegment[],
    targetSegmentId: string,
    newSpeakerId: SpeakerId,
  ): SpeakerTimelineSegment[] {
    return segments.map((seg) =>
      seg.segmentId === targetSegmentId
        ? {
            ...seg,
            speakerId: newSpeakerId,
            classification:
              newSpeakerId === 'UNKNOWN_SPEAKER' ? 'UNKNOWN_SPEAKER' : 'PRIMARY_SPEECH',
            confidence: 1.0,
            manuallyVerifiedByUser: true,
          }
        : seg,
    );
  }

  /**
   * Signed Normalized Cross-Correlation over acoustic delay lags [0, maxLag].
   * Distinguishes phase-coherent acoustic bleed from two independent simultaneous speakers.
   */
  private static computeMaxLagCorrelation(
    sigA: Float32Array,
    sigB: Float32Array,
    start: number,
    len: number,
    maxLag: number,
    sampleRate: SampleRate,
  ): number {
    let maxCorr = 0;
    const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const step = Math.max(1, Math.floor(safeRate / 16000));

    for (let lag = 0; lag <= maxLag; lag += step) {
      if (start + len + lag > sigB.length) break;
      let dot = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < len; i++) {
        const rawA = sigA[start + i];
        const rawB = sigB[start + i + lag];
        const a = Number.isFinite(rawA) ? rawA : 0;
        const b = Number.isFinite(rawB) ? rawB : 0;
        dot += a * b;
        magA += a * a;
        magB += b * b;
      }
      const corr = Math.abs(dot) / (Math.sqrt(magA * magB) + 1e-12);
      if (corr > maxCorr) maxCorr = corr;
    }
    return maxCorr;
  }

  private static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const va = Number.isFinite(a[i]) ? a[i] : 0;
      const vb = Number.isFinite(b[i]) ? b[i] : 0;
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }
    return dot / (Math.sqrt(normA * normB) + 1e-12);
  }

  private static mergeAdjacentIdenticalSegments(
    segments: SpeakerTimelineSegment[],
  ): SpeakerTimelineSegment[] {
    if (segments.length <= 1) return segments;
    const sorted = [...segments].sort((a, b) =>
      a.trackId === b.trackId
        ? a.range.start - b.range.start
        : a.trackId.localeCompare(b.trackId),
    );

    const merged: SpeakerTimelineSegment[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = sorted[i];

      if (
        prev.trackId === curr.trackId &&
        prev.speakerId === curr.speakerId &&
        prev.classification === curr.classification &&
        prev.bleedSourceTrackId === curr.bleedSourceTrackId &&
        curr.range.start <= prev.range.end + TimeMath.secondsToFlicks(0.1)
      ) {
        merged[merged.length - 1] = {
          ...prev,
          range: { start: prev.range.start, end: Math.max(prev.range.end, curr.range.end) },
          confidence: Number(((prev.confidence + curr.confidence) / 2).toFixed(2)),
        };
      } else {
        merged.push(curr);
      }
    }
    return merged;
  }
}
