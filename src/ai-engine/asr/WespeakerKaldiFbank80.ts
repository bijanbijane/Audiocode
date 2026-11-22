/**
 * Deterministic 80-bin Kaldi FBANK frontend for the official WeSpeaker
 * ECAPA-TDNN512-LM ONNX graph.
 *
 * Reference contract: 16 kHz mono, 25 ms frames, 10 ms shift, 512-point FFT,
 * 80 triangular Mel bins, Hamming window, log power and utterance CMN.
 *
 * This is deliberately separate from SHAHAB's Whisper/Conformer Log-Mel frontend.
 * The implementation uses dither=0 at inference, matching WeSpeaker's
 * `Speaker.compute_features()` call, which leaves torchaudio's dither default.
 */
export interface KaldiFbankResult {
  readonly features: Float32Array;
  readonly numFrames: number;
  readonly numMelBins: 80;
}

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const NUM_MEL_BINS = 80;
const PREEMPHASIS = 0.97;
const MEL_FLOOR = 1.192092955078125e-7;

function hzToMel(hz: number): number {
  return 1127.0 * Math.log(1.0 + hz / 700.0);
}

function buildHammingWindow(): Float32Array {
  const window = new Float32Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    window[i] = 0.54 - 0.46 * Math.cos((2.0 * Math.PI * i) / (FRAME_LENGTH - 1));
  }
  return window;
}

function buildMelFilterbank(): Float32Array[] {
  const lowMel = hzToMel(20);
  const highMel = hzToMel(SAMPLE_RATE / 2);
  const melStep = (highMel - lowMel) / (NUM_MEL_BINS + 1);
  const edges = new Float64Array(NUM_MEL_BINS + 2);
  for (let i = 0; i < edges.length; i++) {
    edges[i] = lowMel + i * melStep;
  }

  const filters: Float32Array[] = [];
  for (let melIndex = 0; melIndex < NUM_MEL_BINS; melIndex++) {
    const left = edges[melIndex];
    const center = edges[melIndex + 1];
    const right = edges[melIndex + 2];
    const weights = new Float32Array(FFT_SIZE / 2 + 1);

    for (let bin = 0; bin <= FFT_SIZE / 2; bin++) {
      const mel = hzToMel((bin * SAMPLE_RATE) / FFT_SIZE);
      let weight = 0;
      if (mel > left && mel <= center) {
        weight = (mel - left) / (center - left);
      } else if (mel > center && mel < right) {
        weight = (right - mel) / (right - center);
      }
      weights[bin] = Math.max(0, weight);
    }
    filters.push(weights);
  }
  return filters;
}

function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n !== FFT_SIZE || imag.length !== n) {
    throw new RangeError('WESPEAKER_FBANK_FFT_SIZE_MUST_BE_512');
  }

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2.0 * Math.PI) / length;
    const rootReal = Math.cos(angle);
    const rootImag = Math.sin(angle);
    const half = length >> 1;

    for (let offset = 0; offset < n; offset += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let k = 0; k < half; k++) {
        const evenIndex = offset + k;
        const oddIndex = evenIndex + half;
        const oddReal =
          real[oddIndex] * twiddleReal - imag[oddIndex] * twiddleImag;
        const oddImag =
          real[oddIndex] * twiddleImag + imag[oddIndex] * twiddleReal;

        const evenReal = real[evenIndex];
        const evenImag = imag[evenIndex];
        real[evenIndex] = evenReal + oddReal;
        imag[evenIndex] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;

        const nextReal = twiddleReal * rootReal - twiddleImag * rootImag;
        twiddleImag = twiddleReal * rootImag + twiddleImag * rootReal;
        twiddleReal = nextReal;
      }
    }
  }
}

export class WespeakerKaldiFbank80 {
  private readonly window = buildHammingWindow();
  private readonly melFilters = buildMelFilterbank();

  public compute(
    pcm16kMono: Float32Array,
    options: { readonly applyCepstralMeanNormalization?: boolean } = {},
  ): KaldiFbankResult {
    if (!(pcm16kMono instanceof Float32Array)) {
      throw new TypeError('WESPEAKER_FBANK_AUDIO_MUST_BE_FLOAT32ARRAY');
    }
    if (pcm16kMono.length < FRAME_LENGTH) {
      return {
        features: new Float32Array(0),
        numFrames: 0,
        numMelBins: NUM_MEL_BINS,
      };
    }

    const numFrames = 1 + Math.floor((pcm16kMono.length - FRAME_LENGTH) / FRAME_SHIFT);
    const features = new Float32Array(numFrames * NUM_MEL_BINS);
    const real = new Float64Array(FFT_SIZE);
    const imag = new Float64Array(FFT_SIZE);
    const power = new Float64Array(FFT_SIZE / 2 + 1);
    const normalize = options.applyCepstralMeanNormalization !== false;

    for (let frame = 0; frame < numFrames; frame++) {
      const frameStart = frame * FRAME_SHIFT;
      let frameMean = 0;
      for (let i = 0; i < FRAME_LENGTH; i++) {
        const sample = pcm16kMono[frameStart + i];
        frameMean += Number.isFinite(sample) ? sample * 32768 : 0;
      }
      frameMean /= FRAME_LENGTH;

      real.fill(0);
      imag.fill(0);
      let previous = 0;
      for (let i = 0; i < FRAME_LENGTH; i++) {
        const raw = pcm16kMono[frameStart + i];
        const centered = (Number.isFinite(raw) ? raw * 32768 : 0) - frameMean;
        const emphasized =
          i === 0 ? centered * (1.0 - PREEMPHASIS) : centered - PREEMPHASIS * previous;
        previous = centered;
        real[i] = emphasized * this.window[i];
      }

      fftInPlace(real, imag);
      for (let bin = 0; bin < power.length; bin++) {
        power[bin] = real[bin] * real[bin] + imag[bin] * imag[bin];
      }

      const frameOffset = frame * NUM_MEL_BINS;
      for (let mel = 0; mel < NUM_MEL_BINS; mel++) {
        const filter = this.melFilters[mel];
        let energy = 0;
        for (let bin = 0; bin < power.length; bin++) {
          energy += power[bin] * filter[bin];
        }
        features[frameOffset + mel] = Math.log(Math.max(energy, MEL_FLOOR));
      }
    }

    if (normalize && numFrames > 0) {
      const means = new Float64Array(NUM_MEL_BINS);
      for (let frame = 0; frame < numFrames; frame++) {
        const offset = frame * NUM_MEL_BINS;
        for (let mel = 0; mel < NUM_MEL_BINS; mel++) {
          means[mel] += features[offset + mel];
        }
      }
      for (let mel = 0; mel < NUM_MEL_BINS; mel++) {
        means[mel] /= numFrames;
      }
      for (let frame = 0; frame < numFrames; frame++) {
        const offset = frame * NUM_MEL_BINS;
        for (let mel = 0; mel < NUM_MEL_BINS; mel++) {
          features[offset + mel] -= means[mel];
        }
      }
    }

    return { features, numFrames, numMelBins: NUM_MEL_BINS };
  }
}
