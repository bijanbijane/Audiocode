/**
 * Central Performance Thresholds & Budgets (AVP-P11-001 Section 1)
 * Distinct thresholds for development diagnostics, automated tests, and production warnings.
 * Adaptive to device capability tier without promising fixed hardware timings.
 */

import type { DeviceTier } from '../runtime/ResilientAiRuntime';

export type PerformanceThresholdProfile = 'development' | 'automated-test' | 'production-warning';

export interface PerformanceBudgetSpec {
  readonly profile: PerformanceThresholdProfile;
  readonly deviceTier: DeviceTier;
  readonly mainThreadBlockWarningMs: number;
  readonly longTaskThresholdMs: number;
  readonly timelineInteractionBudgetMs: number;
  readonly playbackStartBudgetMs: number;
  readonly seekLatencyBudgetMs: number;
  readonly transcriptNavigationBudgetMs: number;
  readonly waveformRenderFrameBudgetMs: number;
  readonly virtualizedTranscriptFrameBudgetMs: number;
  readonly timelineTransactionBudgetMs: number;
  readonly projectLoadInitialBudgetMs: number;
  readonly maxQueueDepth: number;
  readonly maxDiagnosticSamples: number;
  readonly maxWaveformCacheBytes: number;
  readonly maxSessionMemoryGrowthSlopeBytesPerMin: number;
}

const TIER_MULTIPLIER: Readonly<Record<DeviceTier, number>> = {
  DESKTOP_STUDIO: 1.0,
  TABLET_STUDIO: 1.35,
  MOBILE_COMPANION: 1.75,
};

const BASE_BUDGETS: Readonly<Record<PerformanceThresholdProfile, Omit<PerformanceBudgetSpec, 'profile' | 'deviceTier'>>> = {
  development: {
    mainThreadBlockWarningMs: 50,
    longTaskThresholdMs: 50,
    timelineInteractionBudgetMs: 16,
    playbackStartBudgetMs: 80,
    seekLatencyBudgetMs: 60,
    transcriptNavigationBudgetMs: 32,
    waveformRenderFrameBudgetMs: 16,
    virtualizedTranscriptFrameBudgetMs: 16,
    timelineTransactionBudgetMs: 25,
    projectLoadInitialBudgetMs: 350,
    maxQueueDepth: 64,
    maxDiagnosticSamples: 300,
    maxWaveformCacheBytes: 16 * 1024 * 1024,
    maxSessionMemoryGrowthSlopeBytesPerMin: 2 * 1024 * 1024,
  },
  'automated-test': {
    mainThreadBlockWarningMs: 120,
    longTaskThresholdMs: 100,
    timelineInteractionBudgetMs: 100,
    playbackStartBudgetMs: 250,
    seekLatencyBudgetMs: 150,
    transcriptNavigationBudgetMs: 100,
    waveformRenderFrameBudgetMs: 100,
    virtualizedTranscriptFrameBudgetMs: 100,
    timelineTransactionBudgetMs: 150,
    projectLoadInitialBudgetMs: 1000,
    maxQueueDepth: 64,
    maxDiagnosticSamples: 300,
    maxWaveformCacheBytes: 16 * 1024 * 1024,
    maxSessionMemoryGrowthSlopeBytesPerMin: 4 * 1024 * 1024,
  },
  'production-warning': {
    mainThreadBlockWarningMs: 100,
    longTaskThresholdMs: 50,
    timelineInteractionBudgetMs: 50,
    playbackStartBudgetMs: 150,
    seekLatencyBudgetMs: 120,
    transcriptNavigationBudgetMs: 60,
    waveformRenderFrameBudgetMs: 33,
    virtualizedTranscriptFrameBudgetMs: 33,
    timelineTransactionBudgetMs: 80,
    projectLoadInitialBudgetMs: 750,
    maxQueueDepth: 64,
    maxDiagnosticSamples: 300,
    maxWaveformCacheBytes: 16 * 1024 * 1024,
    maxSessionMemoryGrowthSlopeBytesPerMin: 3 * 1024 * 1024,
  },
};

export function createAdaptivePerformanceBudget(
  profile: PerformanceThresholdProfile = 'production-warning',
  deviceTier: DeviceTier = 'DESKTOP_STUDIO',
): PerformanceBudgetSpec {
  const base = BASE_BUDGETS[profile];
  const m = TIER_MULTIPLIER[deviceTier];
  const cacheScale = deviceTier === 'MOBILE_COMPANION' ? 0.5 : deviceTier === 'TABLET_STUDIO' ? 0.75 : 1;

  return {
    profile,
    deviceTier,
    mainThreadBlockWarningMs: Math.round(base.mainThreadBlockWarningMs * m),
    longTaskThresholdMs: base.longTaskThresholdMs,
    timelineInteractionBudgetMs: Math.round(base.timelineInteractionBudgetMs * m),
    playbackStartBudgetMs: Math.round(base.playbackStartBudgetMs * m),
    seekLatencyBudgetMs: Math.round(base.seekLatencyBudgetMs * m),
    transcriptNavigationBudgetMs: Math.round(base.transcriptNavigationBudgetMs * m),
    waveformRenderFrameBudgetMs: Math.round(base.waveformRenderFrameBudgetMs * m),
    virtualizedTranscriptFrameBudgetMs: Math.round(base.virtualizedTranscriptFrameBudgetMs * m),
    timelineTransactionBudgetMs: Math.round(base.timelineTransactionBudgetMs * m),
    projectLoadInitialBudgetMs: Math.round(base.projectLoadInitialBudgetMs * m),
    maxQueueDepth: base.maxQueueDepth,
    maxDiagnosticSamples: base.maxDiagnosticSamples,
    maxWaveformCacheBytes: Math.round(base.maxWaveformCacheBytes * cacheScale),
    maxSessionMemoryGrowthSlopeBytesPerMin: base.maxSessionMemoryGrowthSlopeBytesPerMin,
  };
}
