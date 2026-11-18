import { EphemeralDspParams } from '../contracts/v1_2';

export interface DspFrequencyResponsePoint {
  freqHz: number;
  hpfGainDb: number;
  staticFilterPlusMasterDb: number;
  compressorReductionDb: number;
  effectiveResponseDb: number;
}

export interface DspFrequencyResponseResult {
  sampleRate: number;
  referenceInputDb: number;
  hpfCutoffHz: number;
  hpfAlpha: number;
  cutoffGainDb: number;
  passbandReductionDb: number;
  effectiveAt50HzDb: number;
  effectiveAt1kHzDb: number;
  points: DspFrequencyResponsePoint[];
}

export interface DspResponseSvgPaths {
  staticPath: string;
  effectivePath: string;
  reductionAreaPath: string;
  cutoffPoint: { x: number; y: number };
}

export const GRAPH_MIN_HZ = 20;
export const GRAPH_MAX_HZ = 20000;
export const GRAPH_MIN_DB = -36;
export const GRAPH_MAX_DB = 18;

/**
 * Computes exact 1-pole high-pass filter alpha matching `processChunkWithPreRoll`
 * in `src/engine/processingGraph.ts`.
 */
export function compute1PoleHpfAlpha(highPassHz: number, sampleRate: number): number {
  const safeRate = Math.max(8000, sampleRate);
  const fc = Math.max(20, Math.min(400, highPassHz));
  const rc = 1 / (2 * Math.PI * fc);
  const dt = 1 / safeRate;
  return rc / (rc + dt);
}

/**
 * Evaluates exact Z-plane magnitude response (in dB) of the 1-pole IIR high-pass filter:
 *   y[n] = alpha * (y[n-1] + x[n] - x[n-1])
 *   H(z) = alpha * (1 - z^-1) / (1 - alpha * z^-1)
 */
export function compute1PoleHpfMagnitudeDb(
  freqHz: number,
  sampleRate: number,
  alphaHpf: number,
): number {
  const safeRate = Math.max(8000, sampleRate);
  const clampedFreq = Math.max(1, Math.min(safeRate * 0.499, freqHz));
  const omega = (2 * Math.PI * clampedFreq) / safeRate;
  const cosW = Math.cos(omega);

  const numMagSq = 2 * alphaHpf * alphaHpf * (1 - cosW);
  const denMagSq = 1 - 2 * alphaHpf * cosW + alphaHpf * alphaHpf;
  const magSq = numMagSq / Math.max(1e-18, denMagSq);
  return 10 * Math.log10(Math.max(1e-12, magSq));
}

/**
 * Evaluates downward compressor gain reduction (<= 0 dB) matching `processChunkWithPreRoll`.
 */
export function computeDownwardCompressorGainDb(
  inputLevelDb: number,
  thresholdDb: number,
  ratio: number,
): number {
  const safeRatio = Math.max(1, ratio);
  if (inputLevelDb <= thresholdDb || safeRatio <= 1) return 0;
  const overDb = inputLevelDb - thresholdDb;
  const compressedDb = thresholdDb + overDb / safeRatio;
  return compressedDb - inputLevelDb;
}

/**
 * Computes the complete logarithmic frequency response curve (20Hz - 20kHz)
 * combining the 1-pole HPF magnitude, downward compressor dynamic reduction
 * at the given vocal reference input level, and master gain.
 */
export function computeDspFrequencyResponseCurve(
  params: EphemeralDspParams,
  options?: {
    sampleRate?: number;
    referenceInputDb?: number;
    numPoints?: number;
    minHz?: number;
    maxHz?: number;
  },
): DspFrequencyResponseResult {
  const sampleRate = Math.max(8000, options?.sampleRate ?? 48000);
  const referenceInputDb = options?.referenceInputDb ?? -6;
  const numPoints = Math.max(16, Math.min(256, options?.numPoints ?? 96));
  const minHz = options?.minHz ?? GRAPH_MIN_HZ;
  const maxHz = options?.maxHz ?? GRAPH_MAX_HZ;

  const hpfCutoffHz = Math.max(20, Math.min(400, params.highPassHz));
  const hpfAlpha = compute1PoleHpfAlpha(hpfCutoffHz, sampleRate);

  const evaluateAt = (freqHz: number): DspFrequencyResponsePoint => {
    const hpfGainDb = compute1PoleHpfMagnitudeDb(freqHz, sampleRate, hpfAlpha);
    const staticFilterPlusMasterDb = hpfGainDb + params.masterGainDb;
    const postHpfSignalDb = referenceInputDb + hpfGainDb;
    const compressorReductionDb = computeDownwardCompressorGainDb(
      postHpfSignalDb,
      params.compressorThresholdDb,
      params.compressorRatio,
    );
    const effectiveResponseDb = staticFilterPlusMasterDb + compressorReductionDb;
    return {
      freqHz,
      hpfGainDb,
      staticFilterPlusMasterDb,
      compressorReductionDb,
      effectiveResponseDb,
    };
  };

  const minLog = Math.log10(minHz);
  const maxLog = Math.log10(maxHz);
  const points: DspFrequencyResponsePoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const ratio = i / (numPoints - 1);
    const freqHz = Math.pow(10, minLog + ratio * (maxLog - minLog));
    points.push(evaluateAt(freqHz));
  }

  const atCutoff = evaluateAt(hpfCutoffHz);
  const at50 = evaluateAt(50);
  const at1k = evaluateAt(1000);

  return {
    sampleRate,
    referenceInputDb,
    hpfCutoffHz,
    hpfAlpha,
    cutoffGainDb: Number(atCutoff.hpfGainDb.toFixed(2)),
    passbandReductionDb: Number(at1k.compressorReductionDb.toFixed(2)),
    effectiveAt50HzDb: Number(at50.effectiveResponseDb.toFixed(2)),
    effectiveAt1kHzDb: Number(at1k.effectiveResponseDb.toFixed(2)),
    points,
  };
}

export function mapFrequencyToSvgX(
  freqHz: number,
  width: number,
  minHz: number = GRAPH_MIN_HZ,
  maxHz: number = GRAPH_MAX_HZ,
): number {
  const clamped = Math.max(minHz, Math.min(maxHz, freqHz));
  const norm =
    (Math.log10(clamped) - Math.log10(minHz)) /
    (Math.log10(maxHz) - Math.log10(minHz));
  return Number((norm * width).toFixed(2));
}

export function mapDbToSvgY(
  gainDb: number,
  height: number,
  minDb: number = GRAPH_MIN_DB,
  maxDb: number = GRAPH_MAX_DB,
): number {
  const clamped = Math.max(minDb, Math.min(maxDb, gainDb));
  const norm = (clamped - minDb) / (maxDb - minDb);
  return Number(((1 - norm) * height).toFixed(2));
}

export function buildDspResponseSvgPaths(
  curve: DspFrequencyResponseResult,
  width: number,
  height: number,
  options?: {
    minDb?: number;
    maxDb?: number;
    minHz?: number;
    maxHz?: number;
  },
): DspResponseSvgPaths {
  const minDb = options?.minDb ?? GRAPH_MIN_DB;
  const maxDb = options?.maxDb ?? GRAPH_MAX_DB;
  const minHz = options?.minHz ?? GRAPH_MIN_HZ;
  const maxHz = options?.maxHz ?? GRAPH_MAX_HZ;

  if (curve.points.length === 0) {
    return {
      staticPath: '',
      effectivePath: '',
      reductionAreaPath: '',
      cutoffPoint: { x: 0, y: height / 2 },
    };
  }

  const staticCoords = curve.points.map((pt) => ({
    x: mapFrequencyToSvgX(pt.freqHz, width, minHz, maxHz),
    y: mapDbToSvgY(pt.staticFilterPlusMasterDb, height, minDb, maxDb),
  }));

  const effectiveCoords = curve.points.map((pt) => ({
    x: mapFrequencyToSvgX(pt.freqHz, width, minHz, maxHz),
    y: mapDbToSvgY(pt.effectiveResponseDb, height, minDb, maxDb),
  }));

  const toPolylinePath = (coords: { x: number; y: number }[]) =>
    coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');

  const staticPath = toPolylinePath(staticCoords);
  const effectivePath = toPolylinePath(effectiveCoords);

  const reversedEffective = [...effectiveCoords].reverse();
  const reductionAreaPath =
    staticPath +
    ' ' +
    reversedEffective.map((c) => `L${c.x},${c.y}`).join(' ') +
    ' Z';

  const cutoffPt = curve.points.reduce((best, cur) =>
    Math.abs(cur.freqHz - curve.hpfCutoffHz) < Math.abs(best.freqHz - curve.hpfCutoffHz)
      ? cur
      : best,
  );
  const cutoffPoint = {
    x: mapFrequencyToSvgX(curve.hpfCutoffHz, width, minHz, maxHz),
    y: mapDbToSvgY(
      cutoffPt.staticFilterPlusMasterDb,
      height,
      minDb,
      maxDb,
    ),
  };

  return {
    staticPath,
    effectivePath,
    reductionAreaPath,
    cutoffPoint,
  };
}
