import { describe, expect, it } from 'vitest';
import {
  clampExportPercent,
  formatExportElapsed,
  isActiveExportState,
  resolveExportStatusPresentation,
} from '../../src/utils/exportProgress';

describe('exportProgress presentation helpers', () => {
  it('clamps percentages safely into 0..100 integer range', () => {
    expect(clampExportPercent(-12)).toBe(0);
    expect(clampExportPercent(44.6)).toBe(45);
    expect(clampExportPercent(135)).toBe(100);
    expect(clampExportPercent(null, 15)).toBe(15);
    expect(clampExportPercent(Number.NaN, 20)).toBe(20);
  });

  it('maps IDLE, RENDERING, PAUSED, COMPLETED, CANCELLED, and FAILED states cleanly', () => {
    const idle = resolveExportStatusPresentation({ state: 'IDLE' });
    expect(idle.tone).toBe('idle');
    expect(idle.percent).toBe(0);
    expect(idle.isActive).toBe(false);

    const rendering = resolveExportStatusPresentation({
      state: 'RENDERING',
      progressPercent: 62.4,
      currentOperation: 'Writing WAV frames...',
    });
    expect(rendering.tone).toBe('active');
    expect(rendering.percent).toBe(62);
    expect(rendering.stageIndex).toBe(2);
    expect(rendering.isActive).toBe(true);
    expect(rendering.detailFa).toBe('Writing WAV frames...');

    const paused = resolveExportStatusPresentation({
      state: 'PAUSED_USER',
      progressPercent: 51,
    });
    expect(paused.tone).toBe('paused');
    expect(paused.isPaused).toBe(true);
    expect(paused.percent).toBe(51);

    const completed = resolveExportStatusPresentation({ state: 'COMPLETED', progressPercent: 80 });
    expect(completed.tone).toBe('success');
    expect(completed.percent).toBe(100);
    expect(completed.isCompleted).toBe(true);
    expect(completed.stageIndex).toBe(4);

    const cancelled = resolveExportStatusPresentation({ state: 'CANCELLED', progressPercent: 30 });
    expect(cancelled.tone).toBe('cancelled');
    expect(cancelled.isCancelled).toBe(true);

    const failed = resolveExportStatusPresentation({
      state: 'FAILED_VALIDATION',
      errorMessage: 'Peak overflow detected',
    });
    expect(failed.tone).toBe('error');
    expect(failed.isFailed).toBe(true);
    expect(failed.detailEn).toBe('Peak overflow detected');
  });

  it('distinguishes active export lifecycle states and formats elapsed durations', () => {
    expect(isActiveExportState('QUEUED')).toBe(true);
    expect(isActiveExportState('RENDERING')).toBe(true);
    expect(isActiveExportState('VALIDATING_OUTPUT')).toBe(true);
    expect(isActiveExportState('IDLE')).toBe(false);
    expect(isActiveExportState('PAUSED_USER')).toBe(false);
    expect(isActiveExportState('COMPLETED')).toBe(false);

    expect(formatExportElapsed(0, true)).toBeNull();
    expect(formatExportElapsed(4200, false)).toBe('4.2s');
    expect(formatExportElapsed(125000, true)).toBe('2 دقیقه و 5 ثانیه');
  });
});
