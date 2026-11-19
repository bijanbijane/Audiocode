/**
 * Deterministic Performance & Resource Invariant Regression Guard (AVP-P11-001 Section 14)
 * Evaluates deterministic architectural/resource invariants rather than fragile absolute machine timings.
 */

export interface PerformanceInvariantInput {
  readonly queueDepth: number;
  readonly maxQueueDepth: number;
  readonly diagnosticSampleCount: number;
  readonly maxDiagnosticSamples: number;
  readonly workerCountBeforeCycles: number;
  readonly workerCountAfterCycles: number;
  readonly listenerCountBeforeCycles: number;
  readonly listenerCountAfterCycles: number;
  readonly memoryAccountedBytesAfterRelease: number;
  readonly waveformCacheBytes: number;
  readonly maxWaveformCacheBytes: number;
  readonly transcriptFullClonesDuringLocalEdits: number;
  readonly staleAsyncResultsApplied: number;
}

export interface PerformanceInvariantReport {
  readonly passed: boolean;
  readonly violations: readonly string[];
}

export function evaluatePerformanceRegressionInvariants(
  input: PerformanceInvariantInput,
): PerformanceInvariantReport {
  const violations: string[] = [];

  const numericEntries: Array<[keyof PerformanceInvariantInput, number]> = [
    ['queueDepth', input.queueDepth],
    ['maxQueueDepth', input.maxQueueDepth],
    ['diagnosticSampleCount', input.diagnosticSampleCount],
    ['maxDiagnosticSamples', input.maxDiagnosticSamples],
    ['workerCountBeforeCycles', input.workerCountBeforeCycles],
    ['workerCountAfterCycles', input.workerCountAfterCycles],
    ['listenerCountBeforeCycles', input.listenerCountBeforeCycles],
    ['listenerCountAfterCycles', input.listenerCountAfterCycles],
    ['memoryAccountedBytesAfterRelease', input.memoryAccountedBytesAfterRelease],
    ['waveformCacheBytes', input.waveformCacheBytes],
    ['maxWaveformCacheBytes', input.maxWaveformCacheBytes],
    ['transcriptFullClonesDuringLocalEdits', input.transcriptFullClonesDuringLocalEdits],
    ['staleAsyncResultsApplied', input.staleAsyncResultsApplied],
  ];
  for (const [field, val] of numericEntries) {
    if (!Number.isFinite(val)) {
      violations.push(`Non-finite invariant metric "${field}": ${String(val)}`);
    }
  }

  if (input.queueDepth > input.maxQueueDepth) {
    violations.push(`Unbounded queue growth: ${input.queueDepth} > ${input.maxQueueDepth}`);
  }
  if (input.diagnosticSampleCount > input.maxDiagnosticSamples) {
    violations.push(
      `Unbounded diagnostic sample growth: ${input.diagnosticSampleCount} > ${input.maxDiagnosticSamples}`,
    );
  }
  if (input.workerCountAfterCycles > input.workerCountBeforeCycles) {
    violations.push(
      `Worker leak across project cycles: ${input.workerCountBeforeCycles} -> ${input.workerCountAfterCycles}`,
    );
  }
  if (input.listenerCountAfterCycles > input.listenerCountBeforeCycles) {
    violations.push(
      `Listener leak across mount/unmount cycles: ${input.listenerCountBeforeCycles} -> ${input.listenerCountAfterCycles}`,
    );
  }
  if (input.memoryAccountedBytesAfterRelease > 0) {
    violations.push(
      `Unreleased memory reservations after job completion: ${input.memoryAccountedBytesAfterRelease} B`,
    );
  }
  if (input.waveformCacheBytes > input.maxWaveformCacheBytes) {
    violations.push(
      `Unbounded waveform cache: ${input.waveformCacheBytes} B > ${input.maxWaveformCacheBytes} B`,
    );
  }
  if (input.transcriptFullClonesDuringLocalEdits > 0) {
    violations.push(
      `Unnecessary full transcript clones during local edits: ${input.transcriptFullClonesDuringLocalEdits}`,
    );
  }
  if (input.staleAsyncResultsApplied > 0) {
    violations.push(
      `Stale async results applied: ${input.staleAsyncResultsApplied}`,
    );
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
