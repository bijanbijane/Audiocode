import { SampleRate } from '../../../src/contracts/timebase.contract';

export type EqFilterTopology =
  | 'PEAKING'
  | 'LOW_SHELF'
  | 'HIGH_SHELF'
  | 'LOW_CUT_HPF'
  | 'HIGH_CUT_LPF'
  | 'NOTCH';

export interface EqBandConfig {
  readonly bandId: string;
  readonly enabled: boolean;
  readonly topology: EqFilterTopology;
  readonly frequencyHz: number;
  readonly gainDb: number; // مؤثر برای PEAKING، LOW_SHELF و HIGH_SHELF
  readonly qFactor: number;
}

interface BiquadCoefficientsAndState {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  // وضعیت داخلی با دقت 64 بیتی برای جلوگیری از خطای قطب‌های نزدیک به واحد در 50Hz/80Hz
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** پروفایل پیش‌فرض صدای گرم و شفاف گوینده فارسی */
export const DEFAULT_PERSIAN_VOICE_8BAND_EQ: EqBandConfig[] = [
  { bandId: 'b1_rumble', enabled: true, topology: 'LOW_CUT_HPF', frequencyHz: 80, gainDb: 0, qFactor: 0.707 },
  { bandId: 'b2_hum50', enabled: false, topology: 'NOTCH', frequencyHz: 50, gainDb: 0, qFactor: 12.0 },
  { bandId: 'b3_warmth', enabled: true, topology: 'PEAKING', frequencyHz: 165, gainDb: 1.5, qFactor: 1.2 },
  { bandId: 'b4_boxiness', enabled: true, topology: 'PEAKING', frequencyHz: 420, gainDb: -2.2, qFactor: 1.8 },
  { bandId: 'b5_nasal', enabled: false, topology: 'PEAKING', frequencyHz: 1100, gainDb: -1.5, qFactor: 2.0 },
  { bandId: 'b6_presence', enabled: true, topology: 'PEAKING', frequencyHz: 3200, gainDb: 2.5, qFactor: 1.1 },
  { bandId: 'b7_sibilance', enabled: false, topology: 'PEAKING', frequencyHz: 6500, gainDb: -2.5, qFactor: 3.0 },
  { bandId: 'b8_air', enabled: true, topology: 'HIGH_SHELF', frequencyHz: 10500, gainDb: 1.8, qFactor: 0.707 },
];

export class Parametric8BandBiquadEq {
  private bands: EqBandConfig[] = [];
  private filters: BiquadCoefficientsAndState[] = [];

  constructor(
    private readonly sampleRate: SampleRate,
    initialBands: EqBandConfig[] = DEFAULT_PERSIAN_VOICE_8BAND_EQ,
  ) {
    this.updateBands(initialBands);
  }

  public updateBands(newBands: EqBandConfig[]): void {
    this.bands = newBands.slice(0, 8).map((b) => ({ ...b }));
    this.filters = this.bands.map((b) => this.computeBiquadCoefficients(b));
  }

  /** میزان Pre-Roll لازم برای پایدار شدن پاسخ گذرای فیلترهای IIR پیش از نقطه شروع قطعه */
  public getRequiredPreRollSamples(): number {
    return Math.floor(this.sampleRate * 0.06); // 60ms
  }

  public resetInternalFilterStates(): void {
    for (const f of this.filters) {
      f.x1 = 0;
      f.x2 = 0;
      f.y1 = 0;
      f.y2 = 0;
    }
  }

  /**
   * ۱. پردازش درجا (In-Place) زنجیره فیلترهای ۸ بانده روی بافر صوتی
   */
  public processInPlace(samples: Float32Array): void {
    const len = samples.length;
    for (let bIdx = 0; bIdx < this.bands.length; bIdx++) {
      if (!this.bands[bIdx].enabled) continue;
      const f = this.filters[bIdx];
      const { b0, b1, b2, a1, a2 } = f;
      let { x1, x2, y1, y2 } = f;

      for (let i = 0; i < len; i++) {
        const raw = samples[i];
        const x0 = Number.isFinite(raw) ? raw : 0;
        const rawY0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        const y0 = Number.isFinite(rawY0) ? rawY0 : 0;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        samples[i] = y0;
      }

      f.x1 = x1;
      f.x2 = x2;
      f.y1 = y1;
      f.y2 = y2;
    }
  }

  /**
   * ۲. محاسبه دقیق منحنی پاسخ فرکانسی ترکیبی کل ۸ باند بر حسب dB در صفحه Z-Plane
   * برای رسم لحظه‌ای و دقیق گراف اکوالایزر روی Canvas رابط کاربری
   */
  public computeFrequencyResponseDb(frequenciesHz: Float32Array): Float32Array {
    const magnitudeDb = new Float32Array(frequenciesHz.length);

    for (let i = 0; i < frequenciesHz.length; i++) {
      const omega = (2.0 * Math.PI * frequenciesHz[i]) / this.sampleRate;
      // محاسبه z^-1 = cos(w) - j*sin(w) و z^-2 = cos(2w) - j*sin(2w)
      const cosW = Math.cos(omega);
      const sinW = Math.sin(omega);
      const cos2W = cosW * cosW - sinW * sinW;
      const sin2W = 2.0 * sinW * cosW;

      let totalMagSq = 1.0;

      for (let bIdx = 0; bIdx < this.bands.length; bIdx++) {
        if (!this.bands[bIdx].enabled) continue;
        const { b0, b1, b2, a1, a2 } = this.filters[bIdx];

        const numRe = b0 + b1 * cosW + b2 * cos2W;
        const numIm = -b1 * sinW - b2 * sin2W;
        const denRe = 1.0 + a1 * cosW + a2 * cos2W;
        const denIm = -a1 * sinW - a2 * sin2W;

        const bandMagSq =
          (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm + 1e-18);
        totalMagSq *= bandMagSq;
      }

      magnitudeDb[i] = 10.0 * Math.log10(Math.max(1e-12, totalMagSq));
    }

    return magnitudeDb;
  }

  private computeBiquadCoefficients(band: EqBandConfig): BiquadCoefficientsAndState {
    const safeFreq = Number.isFinite(band.frequencyHz) ? band.frequencyHz : 1000;
    const safeQ = Number.isFinite(band.qFactor) ? band.qFactor : 0.707;
    const safeGainDb = Number.isFinite(band.gainDb) ? Math.max(-24, Math.min(24, band.gainDb)) : 0;
    const freq = Math.max(15, Math.min(this.sampleRate * 0.45, safeFreq));
    const q = Math.max(0.1, Math.min(25.0, safeQ));
    const w0 = (2.0 * Math.PI * freq) / this.sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2.0 * q);
    const A = Math.pow(10.0, safeGainDb / 40.0);

    let b0 = 1,
      b1 = 0,
      b2 = 0,
      a0 = 1,
      a1 = 0,
      a2 = 0;

    switch (band.topology) {
      case 'PEAKING':
        b0 = 1.0 + alpha * A;
        b1 = -2.0 * cosW0;
        b2 = 1.0 - alpha * A;
        a0 = 1.0 + alpha / A;
        a1 = -2.0 * cosW0;
        a2 = 1.0 - alpha / A;
        break;

      case 'LOW_CUT_HPF':
        b0 = (1.0 + cosW0) / 2.0;
        b1 = -(1.0 + cosW0);
        b2 = (1.0 + cosW0) / 2.0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cosW0;
        a2 = 1.0 - alpha;
        break;

      case 'HIGH_CUT_LPF':
        b0 = (1.0 - cosW0) / 2.0;
        b1 = 1.0 - cosW0;
        b2 = (1.0 - cosW0) / 2.0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cosW0;
        a2 = 1.0 - alpha;
        break;

      case 'NOTCH':
        b0 = 1.0;
        b1 = -2.0 * cosW0;
        b2 = 1.0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cosW0;
        a2 = 1.0 - alpha;
        break;

      case 'LOW_SHELF': {
        const twoSqrtAAlpha = 2.0 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1.0 - (A - 1.0) * cosW0 + twoSqrtAAlpha);
        b1 = 2.0 * A * (A - 1.0 - (A + 1.0) * cosW0);
        b2 = A * (A + 1.0 - (A - 1.0) * cosW0 - twoSqrtAAlpha);
        a0 = A + 1.0 + (A - 1.0) * cosW0 + twoSqrtAAlpha;
        a1 = -2.0 * (A - 1.0 + (A + 1.0) * cosW0);
        a2 = A + 1.0 + (A - 1.0) * cosW0 - twoSqrtAAlpha;
        break;
      }

      case 'HIGH_SHELF': {
        const twoSqrtAAlpha = 2.0 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1.0 + (A - 1.0) * cosW0 + twoSqrtAAlpha);
        b1 = -2.0 * A * (A - 1.0 + (A + 1.0) * cosW0);
        b2 = A * (A + 1.0 + (A - 1.0) * cosW0 - twoSqrtAAlpha);
        a0 = A + 1.0 - (A - 1.0) * cosW0 + twoSqrtAAlpha;
        a1 = 2.0 * (A - 1.0 - (A + 1.0) * cosW0);
        a2 = A + 1.0 - (A - 1.0) * cosW0 - twoSqrtAAlpha;
        break;
      }
    }

    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
    };
  }
}
