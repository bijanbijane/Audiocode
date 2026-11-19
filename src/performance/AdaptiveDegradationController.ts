import { MemoryPressureLevel } from '../runtime/memory/MemoryBudgetManager';

export type DegradationLevel = 'NORMAL' | 'CONSERVATIVE' | 'DEGRADED' | 'EMERGENCY_SAFE_MODE';

export interface AdaptiveDegradationPolicyState {
  readonly level: DegradationLevel;
  readonly reasonFa: string;
  readonly reasonEn: string;
  // Optional/visual degradation levers
  readonly disableNonEssentialAnimations: boolean;
  readonly waveformLodBias: 0 | 1 | 2;
  readonly allowPrefetch: boolean;
  readonly allowBackgroundMaintenance: boolean;
  readonly maxBackgroundAnalysisConcurrency: number;
  // Non-negotiable protected invariants — ALWAYS true, NEVER degraded silently
  readonly preserveAudioQuality: true;
  readonly preserveTranscriptFidelity: true;
  readonly preserveSampleAccuracy: true;
  readonly preserveApprovedEdlCorrectness: true;
  readonly preserveExportIntegrity: true;
}

/**
 * Adaptive Performance Degradation Controller (AVP-P11-001 Section 12)
 * - Degrades visual effects, waveform LOD detail, prefetch, and background concurrency under pressure.
 * - NEVER degrades audio quality, transcript fidelity, sample accuracy, approved EDL, or export integrity.
 * - Steps back to NORMAL gradually (hysteresis cooldown) to avoid burst floods after recovery.
 */
export class AdaptiveDegradationController {
  private currentLevel: DegradationLevel = 'NORMAL';
  private lastEscalationMs = 0;
  private readonly recoveryCooldownMs: number;

  constructor(recoveryCooldownMs = 5_000) {
    this.recoveryCooldownMs = Math.max(0, recoveryCooldownMs);
  }

  public evaluate(params: {
    readonly memoryPressure: MemoryPressureLevel;
    readonly recentLongTaskCount: number;
    readonly nowMs?: number;
  }): AdaptiveDegradationPolicyState {
    const now = params.nowMs ?? Date.now();
    let desired: DegradationLevel = 'NORMAL';
    if (params.memoryPressure === 'emergency') {
      desired = 'EMERGENCY_SAFE_MODE';
    } else if (params.memoryPressure === 'throttle' || params.recentLongTaskCount >= 8) {
      desired = 'DEGRADED';
    } else if (params.memoryPressure === 'elevated' || params.recentLongTaskCount >= 3) {
      desired = 'CONSERVATIVE';
    }

    const rank: Record<DegradationLevel, number> = {
      NORMAL: 0,
      CONSERVATIVE: 1,
      DEGRADED: 2,
      EMERGENCY_SAFE_MODE: 3,
    };

    if (rank[desired] > rank[this.currentLevel]) {
      this.currentLevel = desired;
      this.lastEscalationMs = now;
    } else if (rank[desired] < rank[this.currentLevel]) {
      // Smooth step-down by 1 level at a time after cooldown to avoid burst overload
      if (now - this.lastEscalationMs >= this.recoveryCooldownMs) {
        const order: DegradationLevel[] = ['NORMAL', 'CONSERVATIVE', 'DEGRADED', 'EMERGENCY_SAFE_MODE'];
        this.currentLevel = order[Math.max(0, rank[this.currentLevel] - 1)];
        this.lastEscalationMs = now;
      }
    }

    return this.buildState(this.currentLevel);
  }

  public getState(): AdaptiveDegradationPolicyState {
    return this.buildState(this.currentLevel);
  }

  private buildState(level: DegradationLevel): AdaptiveDegradationPolicyState {
    switch (level) {
      case 'EMERGENCY_SAFE_MODE':
        return {
          level,
          reasonFa: 'حالت محافظت اضطراری حافظه فعال است: پیش‌بارگذاری و کارهای اختیاری متوقف شدند؛ کیفیت صوت و متن کاملاً حفظ شده است.',
          reasonEn: 'Emergency memory protection active: optional work paused; audio & transcript fidelity fully preserved.',
          disableNonEssentialAnimations: true,
          waveformLodBias: 2,
          allowPrefetch: false,
          allowBackgroundMaintenance: false,
          maxBackgroundAnalysisConcurrency: 0,
          preserveAudioQuality: true,
          preserveTranscriptFidelity: true,
          preserveSampleAccuracy: true,
          preserveApprovedEdlCorrectness: true,
          preserveExportIntegrity: true,
        };
      case 'DEGRADED':
        return {
          level,
          reasonFa: 'حالت بهینه‌سازی فشار پردازشی فعال است: انیمیشن‌های غیراصلی و پیش‌بارگذاری محدود شدند.',
          reasonEn: 'Reduced-load mode active: animations and prefetch limited to protect playback and editing.',
          disableNonEssentialAnimations: true,
          waveformLodBias: 1,
          allowPrefetch: false,
          allowBackgroundMaintenance: false,
          maxBackgroundAnalysisConcurrency: 1,
          preserveAudioQuality: true,
          preserveTranscriptFidelity: true,
          preserveSampleAccuracy: true,
          preserveApprovedEdlCorrectness: true,
          preserveExportIntegrity: true,
        };
      case 'CONSERVATIVE':
        return {
          level,
          reasonFa: 'بار سیستم متوسط است: کارهای پس‌زمینه با محدودیت هم‌زمانی اجرا می‌شوند.',
          reasonEn: 'Moderate load: background concurrency capped while playback and editing stay prioritized.',
          disableNonEssentialAnimations: false,
          waveformLodBias: 1,
          allowPrefetch: true,
          allowBackgroundMaintenance: true,
          maxBackgroundAnalysisConcurrency: 1,
          preserveAudioQuality: true,
          preserveTranscriptFidelity: true,
          preserveSampleAccuracy: true,
          preserveApprovedEdlCorrectness: true,
          preserveExportIntegrity: true,
        };
      case 'NORMAL':
      default:
        return {
          level: 'NORMAL',
          reasonFa: 'عملکرد عادی استودیو فعال است.',
          reasonEn: 'Normal studio performance mode.',
          disableNonEssentialAnimations: false,
          waveformLodBias: 0,
          allowPrefetch: true,
          allowBackgroundMaintenance: true,
          maxBackgroundAnalysisConcurrency: 2,
          preserveAudioQuality: true,
          preserveTranscriptFidelity: true,
          preserveSampleAccuracy: true,
          preserveApprovedEdlCorrectness: true,
          preserveExportIntegrity: true,
        };
    }
  }
}
