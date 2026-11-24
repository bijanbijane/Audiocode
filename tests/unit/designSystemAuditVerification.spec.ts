import { describe, expect, it } from 'vitest';
import { readCanvasThemePalette } from '../../src/utils/canvasThemePalette';
import { formatAsrShortStatus } from '../../src/components/WorkflowStageBar';

describe('Design Audit Remediation Verification (AUD-01..AUD-19)', () => {
  it('provides safe deterministic fallback palette when DOM is unavailable (AUD-13)', () => {
    const palette = readCanvasThemePalette();
    expect(palette.brandSolid).toBe('#0F766E');
    expect(palette.waveStroke).toBe('#1FA38B');
    expect(palette.waveStrokeSecondary).toBe('#38BDF8');
    expect(palette.trackHost).toBe('#0F766E');
    expect(palette.trackGuest).toBe('#0284C7');
    expect(palette.wavePlayhead).toBe('#F43F5E');
  });

  it('preserves WorkflowStageBar formatAsrShortStatus localized outputs after dead-prop cleanup (AUD-12)', () => {
    expect(formatAsrShortStatus('MODEL_READY', 'fa')).toBe('مدل محلی آماده');
    expect(formatAsrShortStatus('MODEL_READY', 'en')).toBe('Local Model Ready');
    expect(formatAsrShortStatus('MODEL_NOT_INSTALLED', 'fa')).toBe('مدل محلی نصب نشده');
    expect(formatAsrShortStatus('INFERENCE_RUNNING', 'en')).toBe('Transcribing...');
  });
});
