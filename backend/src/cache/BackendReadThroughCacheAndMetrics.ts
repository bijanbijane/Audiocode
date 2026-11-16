import type { FastifyInstanceLike, FastifyReplyLike } from '../PlatformBackendServices';

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

/**
 * Section 121: Single-Flight Stampede-Resistant Read-Through Cache & Privacy-Safe Prometheus Metrics Exporter
 */
export class SingleFlightReadThroughCache {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlightPromises = new Map<string, Promise<unknown>>();

  public hitsCount = 0;
  public missesCount = 0;
  public coalescedRequestsSaved = 0;

  /**
   * Retrieve from cache or execute exactly one concurrent DB query across all parallel callers for the same key (Single-Flight)
   */
  public async getOrComputeSingleFlight<T>(
    key: string,
    ttlMs: number,
    loaderFn: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const existing = this.cache.get(key) as CacheEntry<T> | undefined;

    if (existing && existing.expiresAtMs > now) {
      this.hitsCount++;
      return existing.value;
    }

    const activePromise = this.inFlightPromises.get(key) as Promise<T> | undefined;
    if (activePromise) {
      this.coalescedRequestsSaved++;
      return activePromise;
    }

    this.missesCount++;
    const loadPromise = (async () => {
      try {
        const freshValue = await loaderFn();
        this.cache.set(key, {
          value: freshValue,
          expiresAtMs: Date.now() + ttlMs,
        });
        return freshValue;
      } finally {
        this.inFlightPromises.delete(key);
      }
    })();

    this.inFlightPromises.set(key, loadPromise);
    return loadPromise;
  }

  /**
   * Instant cache invalidation when a model version is REVOKED or rollout state changes (Section 40)
   */
  public invalidateByPrefix(keyPrefix: string): number {
    let removed = 0;
    for (const k of this.cache.keys()) {
      if (k.startsWith(keyPrefix)) {
        this.cache.delete(k);
        removed++;
      }
    }
    return removed;
  }
}

export class BackendMetricsExporter {
  private totalHttpRequests = 0;
  private totalHttpErrors5xx = 0;
  private sumLatencyMs = 0;

  constructor(private readonly sharedCache: SingleFlightReadThroughCache) {}

  public recordRequestLatency(url: string, statusCode: number, elapsedTimeMs: number): void {
    if (url === '/metrics' || url === '/healthz') return;
    this.totalHttpRequests++;
    if (statusCode >= 500) this.totalHttpErrors5xx++;
    this.sumLatencyMs += elapsedTimeMs;
  }

  public registerHooksAndEndpoint(
    fastify: FastifyInstanceLike & {
      addHook?: (
        name: 'onResponse',
        fn: (
          req: { url: string },
          reply: { statusCode: number; elapsedTime: number },
        ) => Promise<void>,
      ) => void;
    },
  ): void {
    if (fastify.addHook) {
      fastify.addHook('onResponse', async (request, reply) => {
        this.recordRequestLatency(request.url, reply.statusCode, reply.elapsedTime);
      });
    }

    /**
     * Standard Prometheus Exposition Format endpoint (zero user PII or project data)
     */
    fastify.get('/metrics', async (_request, reply: FastifyReplyLike) => {
      const mem = process.memoryUsage();
      const avgLatencyMs =
        this.totalHttpRequests > 0 ? this.sumLatencyMs / this.totalHttpRequests : 0;

      const lines = [
        '# HELP paudio_backend_http_requests_total Total HTTP requests processed',
        '# TYPE paudio_backend_http_requests_total counter',
        `paudio_backend_http_requests_total ${this.totalHttpRequests}`,
        '',
        '# HELP paudio_backend_http_errors_5xx_total Total 5xx server errors',
        '# TYPE paudio_backend_http_errors_5xx_total counter',
        `paudio_backend_http_errors_5xx_total ${this.totalHttpErrors5xx}`,
        '',
        '# HELP paudio_backend_http_avg_latency_ms Average HTTP request latency in milliseconds',
        '# TYPE paudio_backend_http_avg_latency_ms gauge',
        `paudio_backend_http_avg_latency_ms ${avgLatencyMs.toFixed(3)}`,
        '',
        '# HELP paudio_backend_cache_hits_total Single-flight cache hits',
        '# TYPE paudio_backend_cache_hits_total counter',
        `paudio_backend_cache_hits_total ${this.sharedCache.hitsCount}`,
        '',
        '# HELP paudio_backend_cache_coalesced_saved_total DB queries prevented by single-flight coalescing',
        '# TYPE paudio_backend_cache_coalesced_saved_total counter',
        `paudio_backend_cache_coalesced_saved_total ${this.sharedCache.coalescedRequestsSaved}`,
        '',
        '# HELP paudio_backend_process_rss_bytes Resident set size memory in bytes',
        '# TYPE paudio_backend_process_rss_bytes gauge',
        `paudio_backend_process_rss_bytes ${mem.rss}`,
      ];

      reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return reply.send(lines.join('\n') + '\n');
    });
  }
}
