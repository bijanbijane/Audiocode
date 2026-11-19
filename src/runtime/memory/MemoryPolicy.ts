/**
 * Centralized application-managed memory policy and audio-cache split constants
 * for Avapardaz local-first runtime discipline.
 *
 * NOTE: These constants govern application-managed memory accounting and admission
 * thresholds. They do NOT guarantee a browser-process-wide, GPU, OS, or
 * browser-internal decoded-media RAM ceiling of 1 GiB.
 */
export const AVAPARDAZ_MEMORY_POLICY = {
  hardLimitBytes: 1024 * 1024 * 1024, // 1,024 MiB
  targetBytes: 850 * 1024 * 1024, // 850 MiB
  throttleBytes: 900 * 1024 * 1024, // 900 MiB
  emergencyBytes: 950 * 1024 * 1024, // 950 MiB
  audioCacheBytes: 32 * 1024 * 1024, // 32 MiB
} as const;

export const AVAPARDAZ_AUDIO_CACHE_SPLIT = {
  mainThreadBytes: 24 * 1024 * 1024, // 24 MiB
  workerFallbackBytes: 8 * 1024 * 1024, // 8 MiB
  combinedMaxBytes: AVAPARDAZ_MEMORY_POLICY.audioCacheBytes, // 32 MiB
} as const;

if (
  AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes +
    AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes !==
  AVAPARDAZ_MEMORY_POLICY.audioCacheBytes
) {
  throw new Error('AVAPARDAZ_AUDIO_CACHE_SPLIT must sum to AVAPARDAZ_MEMORY_POLICY.audioCacheBytes');
}

export type MemoryPolicyConfig = {
  readonly hardLimitBytes: number;
  readonly targetBytes: number;
  readonly throttleBytes: number;
  readonly emergencyBytes: number;
  readonly audioCacheBytes: number;
};

export function validateMemoryPolicy(policy: MemoryPolicyConfig): void {
  const fields: (keyof MemoryPolicyConfig)[] = [
    'hardLimitBytes',
    'targetBytes',
    'throttleBytes',
    'emergencyBytes',
    'audioCacheBytes',
  ];
  for (const key of fields) {
    const val = policy[key];
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
      throw new RangeError(`MemoryPolicy.${key} must be a positive safe integer byte count, got ${String(val)}`);
    }
  }
  if (
    !(
      policy.targetBytes <= policy.throttleBytes &&
      policy.throttleBytes <= policy.emergencyBytes &&
      policy.emergencyBytes <= policy.hardLimitBytes
    )
  ) {
    throw new RangeError(
      'MemoryPolicy must satisfy targetBytes <= throttleBytes <= emergencyBytes <= hardLimitBytes',
    );
  }
}

/**
 * Computes conservative backing-buffer byte footprint retained by an array of typed arrays.
 * Deduplicates shared ArrayBuffer instances within the same input list so interleaved
 * or multi-channel views from a single ArrayBuffer are not double-counted, while capturing
 * the full underlying ArrayBuffer retained by subarrays.
 *
 * Returns `null` if any view relies on a SharedArrayBuffer or an unsafe/non-finite backing length.
 */
export function measureTypedArrayListBackingBytes(
  views: readonly ArrayBufferView[],
): number | null {
  if (!Array.isArray(views) || views.length === 0) {
    return 0;
  }

  const seenBuffers = new Set<ArrayBufferLike>();
  let totalBytes = 0;

  for (const view of views) {
    if (!view || typeof view !== 'object' || !('buffer' in view)) {
      return null;
    }
    const buf = view.buffer;
    if (
      typeof SharedArrayBuffer !== 'undefined' &&
      buf instanceof SharedArrayBuffer
    ) {
      // SharedArrayBuffer lifetime is shared across workers/rings and cannot be safely attributed as sole retention
      return null;
    }
    if (!buf || !Number.isSafeInteger(buf.byteLength) || buf.byteLength < 0) {
      return null;
    }
    // Detached buffer check: non-zero view length with zero backing byteLength is invalid
    if (view.byteLength > buf.byteLength) {
      return null;
    }
    if (!seenBuffers.has(buf)) {
      seenBuffers.add(buf);
      totalBytes += buf.byteLength;
      if (!Number.isSafeInteger(totalBytes)) {
        return null;
      }
    }
  }

  return totalBytes;
}
