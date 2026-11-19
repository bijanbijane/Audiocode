import { ReliabilitySubsystemId } from './ErrorCode';

export type SubsystemHealthStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'FAILED'
  | 'NOT_CHECKED';

export interface SubsystemHealthResult {
  readonly subsystemId: ReliabilitySubsystemId;
  readonly displayNameFa: string;
  readonly displayNameEn: string;
  readonly status: SubsystemHealthStatus;
  readonly checkedAtIso: string | null;
  readonly durationMs: number | null;
  readonly summaryFa: string;
  readonly summaryEn: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SystemHealthSnapshot {
  readonly checkedAtIso: string;
  readonly overallStatus: SubsystemHealthStatus;
  readonly deferredDueToActiveWork: boolean;
  readonly subsystems: readonly SubsystemHealthResult[];
}
