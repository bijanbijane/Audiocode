import {
  createAdaptivePerformanceBudget,
  PerformanceBudgetSpec,
  PerformanceThresholdProfile,
} from './PerformanceThresholds';
import type { DeviceTier } from '../runtime/ResilientAiRuntime';
import { AVAPARDAZ_MEMORY_POLICY } from '../runtime/memory/MemoryPolicy';

export type PerformanceMetricName =
  | 'main_thread_block_ms'
  | 'timeline_interaction_ms'
  | 'playback_start_ms'
  | 'seek_latency_ms'
  | 'transcript_nav_ms'
  | 'waveform_render_ms'
  | 'virtualized_transcript_ms'
  | 'timeline_transaction_ms'
  | 'project_load_ms'
  | 'render_throughput_realtime_x';

export interface PerformanceBudgetEvaluation {
  readonly metric: PerformanceMetricName;
  readonly measuredValue: number;
  readonly budgetLimit: number | null;
  readonly withinBudget: boolean;
  readonly profile: PerformanceThresholdProfile;
}

export class PerformanceBudget {
  public readonly spec: PerformanceBudgetSpec;
  public readonly memoryHardLimitBytes = AVAPARDAZ_MEMORY_POLICY.hardLimitBytes;
  public readonly memoryScopeNote =
    'Application-managed memory reservations only; distinct from OS/browser-wide process memory.';

  constructor(
    profile: PerformanceThresholdProfile = 'production-warning',
    deviceTier: DeviceTier = 'DESKTOP_STUDIO',
  ) {
    this.spec = createAdaptivePerformanceBudget(profile, deviceTier);
  }

  public getLimitForMetric(metric: PerformanceMetricName): number | null {
    switch (metric) {
      case 'main_thread_block_ms':
        return this.spec.mainThreadBlockWarningMs;
      case 'timeline_interaction_ms':
        return this.spec.timelineInteractionBudgetMs;
      case 'playback_start_ms':
        return this.spec.playbackStartBudgetMs;
      case 'seek_latency_ms':
        return this.spec.seekLatencyBudgetMs;
      case 'transcript_nav_ms':
        return this.spec.transcriptNavigationBudgetMs;
      case 'waveform_render_ms':
        return this.spec.waveformRenderFrameBudgetMs;
      case 'virtualized_transcript_ms':
        return this.spec.virtualizedTranscriptFrameBudgetMs;
      case 'timeline_transaction_ms':
        return this.spec.timelineTransactionBudgetMs;
      case 'project_load_ms':
        return this.spec.projectLoadInitialBudgetMs;
      case 'render_throughput_realtime_x':
        return null; // Higher is better, hardware-dependent
    }
  }

  public evaluate(metric: PerformanceMetricName, measuredValue: number): PerformanceBudgetEvaluation {
    const limit = this.getLimitForMetric(metric);
    return {
      metric,
      measuredValue,
      budgetLimit: limit,
      withinBudget: limit === null ? true : measuredValue <= limit,
      profile: this.spec.profile,
    };
  }
}
