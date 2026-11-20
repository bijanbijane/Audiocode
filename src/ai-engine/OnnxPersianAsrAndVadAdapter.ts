import { AsrModelRunnerAdapter, RawWordPrediction } from './PersianChunkedAsrWorker';

export type OnnxMelInferenceRunner = (
  melTensor: Float32Array,
  numFrames: number,
  nMels: number,
) => Promise<RawWordPrediction[]>;

/**
 * 80-Channel Log-Mel Spectrogram Extractor & ONNX ASR/VAD Adapter (Sections 13, 35 & 40)
 * Converts 16 kHz Mono PCM into normalized [numFrames x 80] Log-Mel feature tensors
 * matching Whisper & Persian FastConformer specifications, and implements AsrModelRunnerAdapter.
 */
export class OnnxPersianAsrAndVadAdapter implements AsrModelRunnerAdapter {
  public readonly modelId: string;
  public readonly modelVersion: string;

  private readonly sampleRate = 16000;
  private readonly nFft = 512;      // Next power of 2 above 400 samples (25ms @ 16kHz)
  private readonly winLength = 400; // 25ms window
  private readonly hopLength = 160; // 10ms hop stride
  private readonly nMels = 80;
  private readonly hannWindow: Float32Array;
  private readonly melFilterbank: Float32Array[]; // [80][257]
  private readonly inferenceRunner?: OnnxMelInferenceRunner;

  constructor(
    modelId = 'persian-fastconformer-int8',
    modelVersion = '1.2.0',
    inferenceRunner?: OnnxMelInferenceRunner,
  ) {
    this.modelId = modelId;
    this.modelVersion = modelVersion;
    this.inferenceRunner = inferenceRunner;
    this.hannWindow = this.buildPeriodicHannWindow(this.winLength);
    this.melFilterbank = this.build80BandMelFilterbank(
      this.sampleRate,
      this.nFft,
      this.nMels,
      0.0,
      8000.0,
    );
  }

  /** True strictly when a real ONNX inference runner is bound to this adapter. */
  public isReady(): boolean {
    return typeof this.inferenceRunner === 'function';
  }

  /** True strictly when a real decoder/inference runner is configured. */
  public hasDecoderConfiguration(): boolean {
    return typeof this.inferenceRunner === 'function';
  }

  /**
   * Lightweight speech-band energy + Zero-Crossing Rate VAD over 30ms frames @ 16kHz.
   */
  public async detectVoiceActivity(
    pcm16kMono: Float32Array,
  ): Promise<{ hasSpeech: boolean; speechRatio: number }> {
    const frameSize = 480; // 30ms @ 16kHz
    let totalFrames = 0;
    let activeSpeechFrames = 0;

    for (let start = 0; start + frameSize <= pcm16kMono.length; start += frameSize) {
      totalFrames++;
      let sumSq = 0;
      let zcr = 0;
      let prevSample = 0;
      for (let i = start; i < start + frameSize; i++) {
        const raw = pcm16kMono[i];
        const s = Number.isFinite(raw) ? raw : 0;
        sumSq += s * s;
        if (
          i > start &&
          ((prevSample >= 0 && s < 0) || (prevSample < 0 && s >= 0))
        ) {
          zcr++;
        }
        prevSample = s;
      }
      const rmsDb = 10 * Math.log10(sumSq / frameSize + 1e-12);
      const zcrRatio = zcr / frameSize;

      if (rmsDb > -44.0 && zcrRatio > 0.015 && zcrRatio < 0.45) {
        activeSpeechFrames++;
      }
    }

    const speechRatio = totalFrames > 0 ? activeSpeechFrames / totalFrames : 0;
    return {
      hasSpeech: speechRatio >= 0.03,
      speechRatio: Number(speechRatio.toFixed(3)),
    };
  }

  /**
   * Computes normalized 80-Channel Log-Mel Spectrogram [numFrames * 80] matching Whisper/Conformer input.
   */
  public computeLogMelSpectrogram(pcm16kMono: Float32Array): {
    melTensor: Float32Array;
    numFrames: number;
    nMels: number;
  } {
    if (pcm16kMono.length < this.winLength) {
      return { melTensor: new Float32Array(0), numFrames: 0, nMels: this.nMels };
    }

    const numFrames = 1 + Math.floor((pcm16kMono.length - this.winLength) / this.hopLength);
    const melTensor = new Float32Array(numFrames * this.nMels);
    const nFreqBins = (this.nFft >> 1) + 1; // 257 bins

    const real = new Float32Array(this.nFft);
    const imag = new Float32Array(this.nFft);
    const powerSpectrum = new Float32Array(nFreqBins);

    let globalMaxLogMel = -Infinity;

    for (let f = 0; f < numFrames; f++) {
      const start = f * this.hopLength;
      real.fill(0);
      imag.fill(0);

      for (let i = 0; i < this.winLength; i++) {
        const raw = pcm16kMono[start + i];
        const s = Number.isFinite(raw) ? raw : 0;
        real[i] = s * this.hannWindow[i];
      }

      this.radix2FftInPlace(real, imag);

      for (let k = 0; k < nFreqBins; k++) {
        const p = real[k] * real[k] + imag[k] * imag[k];
        powerSpectrum[k] = Number.isFinite(p) ? p : 0;
      }

      const frameOffset = f * this.nMels;
      for (let m = 0; m < this.nMels; m++) {
        const filterWeights = this.melFilterbank[m];
        let melEnergy = 0;
        for (let k = 0; k < nFreqBins; k++) {
          melEnergy += powerSpectrum[k] * filterWeights[k];
        }
        const safeMelEnergy = Number.isFinite(melEnergy) && melEnergy > 1e-10 ? melEnergy : 1e-10;
        const logMel = Math.log10(safeMelEnergy);
        melTensor[frameOffset + m] = logMel;
        if (logMel > globalMaxLogMel) globalMaxLogMel = logMel;
      }
    }

    if (!Number.isFinite(globalMaxLogMel)) {
      globalMaxLogMel = -10.0;
    }

    // Dynamic range clipping to 80 dB below peak (8.0 in log10 scale) and scaling to [-1, +1]
    const floorClip = globalMaxLogMel - 8.0;
    for (let i = 0; i < melTensor.length; i++) {
      const clamped = Math.max(melTensor[i], floorClip);
      melTensor[i] = (clamped + 4.0) / 4.0;
    }

    return {
      melTensor,
      numFrames,
      nMels: this.nMels,
    };
  }

  /**
   * Estimates explicit transient JavaScript TypedArray allocations for feature extraction
   * over `sampleCount16k` samples (Log-Mel tensor + FFT real/imag + power spectrum).
   *
   * NOTE: Does NOT include opaque memory allocated internally inside an external ONNX
   * Runtime, WebAssembly heap, or WebGPU driver unless separately exposed by that runtime.
   */
  public estimateWorkingMemoryBytes(sampleCount16k: number): number {
    if (
      typeof sampleCount16k !== 'number' ||
      !Number.isFinite(sampleCount16k) ||
      sampleCount16k < this.winLength
    ) {
      return 0;
    }

    const safeSamples = Math.trunc(sampleCount16k);
    const numFrames = 1 + Math.floor((safeSamples - this.winLength) / this.hopLength);
    const nFreqBins = (this.nFft >> 1) + 1; // 257

    const melTensorBytes = numFrames * this.nMels * Float32Array.BYTES_PER_ELEMENT;
    const fftRealBytes = this.nFft * Float32Array.BYTES_PER_ELEMENT;
    const fftImagBytes = this.nFft * Float32Array.BYTES_PER_ELEMENT;
    const powerSpectrumBytes = nFreqBins * Float32Array.BYTES_PER_ELEMENT;

    return melTensorBytes + fftRealBytes + fftImagBytes + powerSpectrumBytes;
  }

  /**
   * Extracts Log-Mel features for a 16kHz window and runs the bound ONNX inference runner if present.
   */
  public async transcribeWindow(pcm16kMono: Float32Array): Promise<RawWordPrediction[]> {
    const { melTensor, numFrames, nMels } = this.computeLogMelSpectrogram(pcm16kMono);
    if (numFrames === 0) return [];
    if (this.inferenceRunner) {
      return this.inferenceRunner(melTensor, numFrames, nMels);
    }
    return [];
  }

  /**
   * Decodes per-frame CTC token probabilities into Persian word spans using greedy collapse (index 0 = blank).
   */
  public static greedyDecodeCtcToWords(
    frameProbs: readonly Float32Array[],
    idToChar: ReadonlyMap<number, string>,
    frameStrideSec = 0.02,
  ): RawWordPrediction[] {
    const safeStrideSec =
      Number.isFinite(frameStrideSec) && frameStrideSec > 0 ? frameStrideSec : 0.02;
    let prevTok = 0;
    let currentWord = '';
    let wordStartFrame = -1;
    let wordProbSum = 0;
    let wordCharCount = 0;
    const words: RawWordPrediction[] = [];

    for (let t = 0; t < frameProbs.length; t++) {
      const probs = frameProbs[t];
      let bestId = 0;
      let bestProb = -Infinity;
      for (let c = 0; c < probs.length; c++) {
        const p = probs[c];
        if (Number.isFinite(p) && p > bestProb) {
          bestProb = p;
          bestId = c;
        }
      }
      if (!Number.isFinite(bestProb)) {
        bestProb = 0;
      }

      if (bestId !== 0 && bestId !== prevTok) {
        const ch = idToChar.get(bestId) ?? '';
        if (ch === ' ') {
          if (currentWord.length > 0) {
            words.push({
              word: currentWord,
              relativeStartSec: Number((wordStartFrame * safeStrideSec).toFixed(3)),
              relativeEndSec: Number((t * safeStrideSec).toFixed(3)),
              probability: Number((wordProbSum / Math.max(1, wordCharCount)).toFixed(3)),
            });
            currentWord = '';
            wordStartFrame = -1;
            wordProbSum = 0;
            wordCharCount = 0;
          }
        } else if (ch.length > 0) {
          if (currentWord.length === 0) wordStartFrame = t;
          currentWord += ch;
          wordProbSum += Math.max(0, Math.min(1, bestProb));
          wordCharCount++;
        }
      }
      prevTok = bestId;
    }

    if (currentWord.length > 0 && wordStartFrame >= 0) {
      words.push({
        word: currentWord,
        relativeStartSec: Number((wordStartFrame * safeStrideSec).toFixed(3)),
        relativeEndSec: Number((frameProbs.length * safeStrideSec).toFixed(3)),
        probability: Number((wordProbSum / Math.max(1, wordCharCount)).toFixed(3)),
      });
    }

    return words;
  }

  private buildPeriodicHannWindow(length: number): Float32Array {
    const win = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      win[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / length));
    }
    return win;
  }

  private build80BandMelFilterbank(
    sampleRate: number,
    nFft: number,
    nMels: number,
    fMin: number,
    fMax: number,
  ): Float32Array[] {
    const hzToMel = (hz: number) => 2595.0 * Math.log10(1.0 + hz / 700.0);
    const melToHz = (mel: number) => 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);

    const melMin = hzToMel(fMin);
    const melMax = hzToMel(fMax);
    const melPoints = new Float32Array(nMels + 2);

    for (let i = 0; i < nMels + 2; i++) {
      melPoints[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
    }

    const nFreqBins = (nFft >> 1) + 1;
    const fftFreqs = new Float32Array(nFreqBins);
    for (let k = 0; k < nFreqBins; k++) {
      fftFreqs[k] = (k * sampleRate) / nFft;
    }

    const filters: Float32Array[] = [];
    for (let m = 0; m < nMels; m++) {
      const weights = new Float32Array(nFreqBins);
      const fLeft = melPoints[m];
      const fCenter = melPoints[m + 1];
      const fRight = melPoints[m + 2];
      const normFactor = 2.0 / (fRight - fLeft + 1e-12); // Slaney area normalization

      for (let k = 0; k < nFreqBins; k++) {
        const freq = fftFreqs[k];
        if (freq >= fLeft && freq <= fCenter) {
          weights[k] = ((freq - fLeft) / (fCenter - fLeft + 1e-12)) * normFactor;
        } else if (freq > fCenter && freq <= fRight) {
          weights[k] = ((fRight - freq) / (fRight - fCenter + 1e-12)) * normFactor;
        }
      }
      filters.push(weights);
    }

    return filters;
  }

  /** Zero-allocation in-place Radix-2 Cooley-Tukey FFT */
  public radix2FftInPlace(real: Float32Array, imag: Float32Array): void {
    const n = real.length;
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < j) {
        const tr = real[i];
        real[i] = real[j];
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j];
        imag[j] = ti;
      }
      let k = n >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const stepAngle = (-2.0 * Math.PI) / size;
      const wStepR = Math.cos(stepAngle);
      const wStepI = Math.sin(stepAngle);

      for (let i = 0; i < n; i += size) {
        let wr = 1.0;
        let wi = 0.0;
        for (let k = 0; k < half; k++) {
          const evenIdx = i + k;
          const oddIdx = i + k + half;
          const tr = wr * real[oddIdx] - wi * imag[oddIdx];
          const ti = wr * imag[oddIdx] + wi * real[oddIdx];

          real[oddIdx] = real[evenIdx] - tr;
          imag[oddIdx] = imag[evenIdx] - ti;
          real[evenIdx] += tr;
          imag[evenIdx] += ti;

          const nextWr = wr * wStepR - wi * wStepI;
          wi = wr * wStepI + wi * wStepR;
          wr = nextWr;
        }
      }
    }
  }
}
