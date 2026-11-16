import {
  Flicks,
  FLICKS_PER_SECOND,
  SampleRate,
  TimeRange,
} from '../../contracts/timebase.contract';
import { SmartSpliceDescriptor } from '../../contracts/persian-editing.contract';

export interface WaveformLodBuffer {
  readonly samplesPerPeak: 64 | 256 | 1024 | 4096;
  /** Interleaved [min, max, min, max, ...] pairs scaled to [-128..127] */
  readonly interleavedMinMaxInt8: Int8Array;
}

/**
 * Multi-Level LOD Viewport Waveform Renderer (Architecture Doc Section 53)
 * Renders only the visible viewport slice at 60fps from Int8 peak pyramids.
 */
export class LodWaveformCanvasRenderer {
  public static selectBestLod(
    lods: WaveformLodBuffer[],
    viewportRange: TimeRange,
    canvasWidthPx: number,
    sampleRate: SampleRate,
  ): WaveformLodBuffer {
    if (lods.length === 0) {
      throw new Error('NO_WAVEFORM_LOD_BUFFERS');
    }
    const visibleSeconds = (viewportRange.end - viewportRange.start) / FLICKS_PER_SECOND;
    const totalVisibleSamples = Math.max(0, visibleSeconds * sampleRate);
    const idealSamplesPerPixel = totalVisibleSamples / Math.max(1, canvasWidthPx);

    const sorted = [...lods].sort((a, b) => a.samplesPerPeak - b.samplesPerPeak);
    let chosen = sorted[0];
    for (const lod of sorted) {
      if (lod.samplesPerPeak <= idealSamplesPerPixel) {
        chosen = lod;
      } else {
        break;
      }
    }
    return chosen;
  }

  public static renderViewport(
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    canvasHeight: number,
    lod: WaveformLodBuffer,
    viewportRange: TimeRange,
    playheadFlicks: Flicks,
    sampleRate: SampleRate,
    pendingSuggestions: SmartSpliceDescriptor[],
  ): void {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    const halfH = canvasHeight / 2;
    const viewportDuration = viewportRange.end - viewportRange.start;
    if (viewportDuration <= 0 || lod.interleavedMinMaxInt8.length < 2) return;

    // 1. Highlight pending AI splice ranges inside viewport
    for (const sug of pendingSuggestions) {
      const range = sug.snappedAcousticRange;
      if (range.end <= viewportRange.start || range.start >= viewportRange.end) continue;

      const xStart = Math.max(
        0,
        ((range.start - viewportRange.start) / viewportDuration) * canvasWidth,
      );
      const xEnd = Math.min(
        canvasWidth,
        ((range.end - viewportRange.start) / viewportDuration) * canvasWidth,
      );

      const hasWarning = sug.prosodicWarnings.length > 0 || sug.confidence < 0.75;
      ctx.fillStyle = hasWarning ? 'rgba(245, 158, 11, 0.22)' : 'rgba(239, 68, 68, 0.22)';
      ctx.fillRect(xStart, 0, Math.max(2, xEnd - xStart), canvasHeight);
    }

    // 2. Render waveform bars strictly for visible peaks
    const flicksPerPeak = (lod.samplesPerPeak / sampleRate) * FLICKS_PER_SECOND;
    const totalPeaks = Math.floor(lod.interleavedMinMaxInt8.length / 2);
    const firstPeakIdx = Math.max(0, Math.floor(viewportRange.start / flicksPerPeak));
    const lastPeakIdx = Math.min(
      totalPeaks - 1,
      Math.ceil(viewportRange.end / flicksPerPeak),
    );
    if (lastPeakIdx < firstPeakIdx) return;

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();

    const peaksCountInView = lastPeakIdx - firstPeakIdx + 1;
    const step = Math.max(1, Math.floor(peaksCountInView / Math.max(1, canvasWidth)));

    for (let p = firstPeakIdx; p <= lastPeakIdx; p += step) {
      const peakFlicks = p * flicksPerPeak;
      const x = ((peakFlicks - viewportRange.start) / viewportDuration) * canvasWidth;

      const minVal = lod.interleavedMinMaxInt8[p * 2] / 128.0;
      const maxVal = lod.interleavedMinMaxInt8[p * 2 + 1] / 127.0;

      const yTop = halfH - maxVal * (halfH * 0.9);
      const yBottom = halfH - minVal * (halfH * 0.9);
      const barHeight = Math.max(1.5, yBottom - yTop);

      ctx.rect(x, yTop, 1.5, barHeight);
    }
    ctx.fill();

    // 3. Render Playhead synchronized with Audio Clock
    if (playheadFlicks >= viewportRange.start && playheadFlicks <= viewportRange.end) {
      const playheadX =
        ((playheadFlicks - viewportRange.start) / viewportDuration) * canvasWidth;
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, canvasHeight);
      ctx.stroke();
    }
  }
}
