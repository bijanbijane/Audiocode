import { Flicks } from '../../contracts/timebase.contract';
import { TimedPersianToken } from '../../ai-engine/PersianTextNormalizer';

export interface AudiogramThemeConfig {
  readonly widthPx: 1080;
  readonly heightPx: 1920 | 1080; // Vertical 9:16 (Reels/Stories) or Square 1:1
  readonly podcastTitleFa: string;
  readonly episodeSubtitleFa: string;
  readonly backgroundColorHex: string;
  readonly accentWaveColorHex: string;
  readonly activeWordHighlightColorHex: string;
}

/**
 * Local Persian Audiogram & Karaoke Caption Frame Renderer (Section 2.6)
 * Renders 1080x1920 or 1080x1080 social video frames with symmetric waveform bars
 * and Flick-synchronized Persian karaoke captions directly onto a 2D Canvas.
 */
export class PersianAudiogramCanvasRenderer {
  public static renderAudiogramFrame(
    ctx: CanvasRenderingContext2D,
    theme: AudiogramThemeConfig,
    currentTimeFlicks: Flicks,
    captionWindowTokens: readonly TimedPersianToken[],
    currentFrameSpectrumBars: Float32Array,
  ): void {
    const { widthPx: W, heightPx: H } = theme;

    // 1. Studio background fill
    ctx.fillStyle = theme.backgroundColorHex;
    ctx.fillRect(0, 0, W, H);

    // 2. RTL Persian podcast title & episode subtitle
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 46px Vazirmatn, Tahoma, sans-serif';
    ctx.fillText(theme.podcastTitleFa, W / 2, H * 0.18);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '32px Vazirmatn, Tahoma, sans-serif';
    ctx.fillText(theme.episodeSubtitleFa, W / 2, H * 0.24);

    // 3. Symmetric spectrum/waveform bars at center frame
    const barCount = currentFrameSpectrumBars.length;
    const totalWaveWidth = W * 0.76;
    const barSpacing = totalWaveWidth / Math.max(1, barCount);
    const barWidth = Math.max(6, barSpacing * 0.58);
    const startX = (W - totalWaveWidth) / 2;
    const centerY = H * 0.48;
    const maxBarHalfHeight = H * 0.12;

    ctx.fillStyle = theme.accentWaveColorHex;
    for (let i = 0; i < barCount; i++) {
      const mag = Math.max(0.05, Math.min(1.0, currentFrameSpectrumBars[i]));
      const halfBarH = mag * maxBarHalfHeight;
      const x = startX + i * barSpacing;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, centerY - halfBarH, barWidth, halfBarH * 2, barWidth / 2);
      } else {
        ctx.rect(x, centerY - halfBarH, barWidth, halfBarH * 2);
      }
      ctx.fill();
    }

    // 4. Flick-synchronized Persian karaoke caption line + active word spotlight
    const captionY = H * 0.72;
    ctx.font = 'bold 42px Vazirmatn, Tahoma, sans-serif';

    const fullLineText = captionWindowTokens.map((t) => t.displayText).join(' ');
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(fullLineText, W / 2, captionY);

    const activeToken = captionWindowTokens.find(
      (t) => currentTimeFlicks >= t.range.start && currentTimeFlicks < t.range.end,
    );
    if (activeToken) {
      ctx.fillStyle = theme.activeWordHighlightColorHex;
      ctx.font = 'bold 54px Vazirmatn, Tahoma, sans-serif';
      ctx.fillText(activeToken.displayText, W / 2, captionY + 85);
    }
  }
}
