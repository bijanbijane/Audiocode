import { ReliabilitySubsystemId } from './ErrorCode';
import { SubsystemHealthResult, SubsystemHealthStatus } from './HealthStatus';

export interface SubsystemHealthCheckDefinition {
  readonly subsystemId: ReliabilitySubsystemId;
  readonly displayNameFa: string;
  readonly displayNameEn: string;
  /** Lightweight probes can run during normal usage; heavier probes defer during active ASR/render */
  readonly cost: 'LIGHTWEIGHT' | 'MODERATE';
  readonly probe: () => Promise<{
    readonly status: SubsystemHealthStatus;
    readonly summaryFa: string;
    readonly summaryEn: string;
    readonly details?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  }>;
}

export async function runSubsystemHealthProbe(
  definition: SubsystemHealthCheckDefinition,
  timeoutMs = 2500,
): Promise<SubsystemHealthResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      definition.probe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('HEALTH_PROBE_TIMEOUT')), timeoutMs);
      }),
    ]);
    const cleanDetails: Record<string, string | number | boolean | null> = {};
    if (result.details) {
      for (const [k, v] of Object.entries(result.details)) {
        if (v !== undefined) {
          cleanDetails[k] = v;
        }
      }
    }
    return {
      subsystemId: definition.subsystemId,
      displayNameFa: definition.displayNameFa,
      displayNameEn: definition.displayNameEn,
      status: result.status,
      checkedAtIso: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      summaryFa: result.summaryFa,
      summaryEn: result.summaryEn,
      details: cleanDetails,
    };
  } catch (err) {
    return {
      subsystemId: definition.subsystemId,
      displayNameFa: definition.displayNameFa,
      displayNameEn: definition.displayNameEn,
      status: 'FAILED',
      checkedAtIso: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      summaryFa: 'اجرای بررسی سلامت این زیرسیستم با خطا یا پایان مهلت مواجه شد.',
      summaryEn: 'Subsystem health probe failed or timed out.',
      details: {
        error: err instanceof Error ? err.message : 'UNKNOWN',
      },
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
