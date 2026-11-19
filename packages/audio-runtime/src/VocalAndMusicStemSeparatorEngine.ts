import { SampleRate } from '../../../src/contracts/timebase.contract';

export interface SeparatedAudioStems {
  readonly vocalMonoStem: Float32Array;
  readonly musicStereoStem: [Float32Array, Float32Array];
  readonly vocalToMusicEnergyRatioDb: number;
}

export class VocalAndMusicStemSeparatorEngine {
  /**
   * جداسازی صدای گوینده (متمرکز در مرکز تصویر استریو و باند فورمنت 180Hz-4200Hz)
   * از بستر موسیقی استریو (پخش‌شده در کناره‌ها و دارای فرکانس‌های بم و زیر ممتد)
   */
  public static separateVocalAndMusicStems(
    inputLeft: Float32Array,
    inputRight: Float32Array,
    sampleRate: SampleRate,
  ): SeparatedAudioStems {
    const len = Math.min(inputLeft.length, inputRight.length);
    const vocalMonoStem = new Float32Array(len);
    const musicLeft = new Float32Array(len);
    const musicRight = new Float32Array(len);

    if (len === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return {
        vocalMonoStem,
        musicStereoStem: [musicLeft, musicRight],
        vocalToMusicEnergyRatioDb: 0,
      };
    }

    // ضرایب فیلتر باند گفتار (180Hz تا 4200Hz)
    const alphaLow180 = Math.exp((-2.0 * Math.PI * 180.0) / sampleRate);
    const alphaHigh4200 = Math.exp((-2.0 * Math.PI * 4200.0) / sampleRate);

    // دنبال‌کننده‌های پوش انرژی مرکز (Mid) و کناره (Side) برای ساخت ماسک نرم زمان-فرکانس (Soft Mask)
    const envSmooth = Math.exp(-1.0 / (0.012 * sampleRate)); // پنجره 12ms
    let midEnv = 0;
    let sideEnv = 0;
    let lp180 = 0;
    let lp4200 = 0;

    let vocalEnergySum = 0;
    let musicEnergySum = 0;

    for (let i = 0; i < len; i++) {
      const l = Number.isFinite(inputLeft[i]) ? inputLeft[i] : 0;
      const r = Number.isFinite(inputRight[i]) ? inputRight[i] : 0;

      const mid = 0.5 * (l + r);
      const side = 0.5 * (l - r);

      midEnv = envSmooth * midEnv + (1.0 - envSmooth) * Math.abs(mid);
      sideEnv = envSmooth * sideEnv + (1.0 - envSmooth) * Math.abs(side);

      // فیلتر میان‌گذر باند گفتار روی سیگنال مرکز
      lp180 = (1.0 - alphaLow180) * mid + alphaLow180 * lp180;
      lp4200 = (1.0 - alphaHigh4200) * mid + alphaHigh4200 * lp4200;
      const midVocalBand = lp4200 - lp180;

      // محاسبه شاخص شباهت پنینگ مرکز (Center PanningIndex):
      // هرچه انرژی Side نسبت به Mid کمتر باشد، احتمال اینکه نمونه متعلق به صدای تک‌گوینده مرکز باشد بیشتر است
      const centerDominance = midEnv / (midEnv + sideEnv * 1.6 + 1e-9);
      const softVocalMask = Math.pow(centerDominance, 2.0);

      const extractedVocal = midVocalBand * softVocalMask;
      vocalMonoStem[i] = extractedVocal;

      // تفریق نرم صدای گوینده استخراج‌شده از کانال چپ و راست برای به دست آوردن بستر موسیقی (Residual Music Bed)
      const mL = l - extractedVocal;
      const mR = r - extractedVocal;
      musicLeft[i] = mL;
      musicRight[i] = mR;

      vocalEnergySum += extractedVocal * extractedVocal;
      musicEnergySum += 0.5 * (mL * mL + mR * mR);
    }

    const vocalToMusicEnergyRatioDb =
      10 * Math.log10((vocalEnergySum + 1e-12) / (musicEnergySum + 1e-12));

    return {
      vocalMonoStem,
      musicStereoStem: [musicLeft, musicRight],
      vocalToMusicEnergyRatioDb: Number(vocalToMusicEnergyRatioDb.toFixed(2)),
    };
  }
}
