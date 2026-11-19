import { SampleRate } from '../../../src/contracts/timebase.contract';

/**
 * Waveform Similarity Overlap-Add (WSOLA) Time-Stretch Engine (Sections 2.6 & 23)
 * Changes speech playback/narration tempo (0.5x to 2.5x) while preserving 100% of
 * speaker fundamental pitch (F0) and Persian formant structure without phase-vocoder metallic artifacts.
 */
export class TimeStretchWsolaEngine {
  /**
   * Time-stretches a mono PCM buffer without altering pitch.
   * @param inputPcm Mono Float32Array signal
   * @param sampleRate Sample rate (e.g. 48000)
   * @param tempoRatio Speed multiplier (> 1.0 faster / shorter output, < 1.0 slower / longer output)
   */
  public static processTimeStretch(
    inputPcm: Float32Array,
    sampleRate: SampleRate,
    tempoRatio: number,
  ): Float32Array {
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isFinite(tempoRatio) ||
      tempoRatio <= 0
    ) {
      return new Float32Array(inputPcm);
    }

    // 25ms synthesis window (1200 samples @ 48kHz, 2400 @ 96kHz), even-aligned, 50% synthesis hop
    const winLength = Math.max(128, Math.floor((sampleRate * 25) / 1000) & ~1);
    const clampedTempo = Math.max(0.5, Math.min(2.5, tempoRatio));
    if (Math.abs(clampedTempo - 1.0) < 0.005 || inputPcm.length < Math.max(2048, winLength)) {
      return new Float32Array(inputPcm);
    }

    const synthHop = winLength >> 1;
    // ±8ms phase-correlation search radius (covers down to ~62Hz fundamental period)
    const searchDelta = Math.max(16, Math.floor((sampleRate * 8) / 1000));

    const hannWin = this.buildHannWindow(winLength);
    const outputLength = Math.max(winLength, Math.floor(inputPcm.length / clampedTempo));
    const outputPcm = new Float32Array(outputLength);

    let synthPos = 0;
    let prevChosenAnalysisPos = 0;

    // Seed first frame
    for (let i = 0; i < winLength && i < inputPcm.length && i < outputLength; i++) {
      const s = inputPcm[i];
      outputPcm[i] = (Number.isFinite(s) ? s : 0) * hannWin[i];
    }
    synthPos += synthHop;

    while (synthPos < outputLength) {
      const targetAnalysisPos = Math.round(synthPos * clampedTempo);
      const naturalContinuationPos = prevChosenAnalysisPos + synthHop;

      let bestOffset = 0;
      if (
        naturalContinuationPos + synthHop < inputPcm.length &&
        targetAnalysisPos - searchDelta >= 0 &&
        targetAnalysisPos + searchDelta + winLength < inputPcm.length
      ) {
        bestOffset = this.findBestPhaseCorrelationOffset(
          inputPcm,
          naturalContinuationPos,
          targetAnalysisPos,
          synthHop,
          searchDelta,
        );
      }

      const chosenAnalysisPos = Math.max(
        0,
        Math.min(inputPcm.length - winLength, targetAnalysisPos + bestOffset),
      );

      const copyLimit = Math.min(
        winLength,
        outputLength - synthPos,
        inputPcm.length - chosenAnalysisPos,
      );
      for (let i = 0; i < copyLimit; i++) {
        const s = inputPcm[chosenAnalysisPos + i];
        outputPcm[synthPos + i] += (Number.isFinite(s) ? s : 0) * hannWin[i];
      }

      prevChosenAnalysisPos = chosenAnalysisPos;
      synthPos += synthHop;
    }

    return outputPcm;
  }

  /**
   * Finds offset in [-searchDelta, +searchDelta] maximizing normalized cross-correlation
   * with the natural continuation of the previously synthesized frame.
   */
  private static findBestPhaseCorrelationOffset(
    pcm: Float32Array,
    naturalRefStart: number,
    candidateCenterStart: number,
    overlapLength: number,
    searchDelta: number,
  ): number {
    let bestOffset = 0;
    let maxCorr = -Infinity;

    for (let delta = -searchDelta; delta <= searchDelta; delta += 2) {
      const candStart = candidateCenterStart + delta;
      let dot = 0;
      let candEnergy = 0;

      for (let i = 0; i < overlapLength; i += 4) {
        const refVal = pcm[naturalRefStart + i];
        const candVal = pcm[candStart + i];
        dot += refVal * candVal;
        candEnergy += candVal * candVal;
      }

      const normCorr = dot / (Math.sqrt(candEnergy) + 1e-9);
      if (normCorr > maxCorr) {
        maxCorr = normCorr;
        bestOffset = delta;
      }
    }

    return bestOffset;
  }

  private static buildHannWindow(length: number): Float32Array {
    const win = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      win[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / length));
    }
    return win;
  }
}
