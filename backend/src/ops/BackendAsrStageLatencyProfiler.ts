export type AsrPipelineStageName =
  | 'AUDIO_INGEST_DECODE'
  | 'RESAMPLE_16K_MONO'
  | 'SILERO_VAD_SCAN'
  | 'LOG_MEL_EXTRACTION'
  | 'ONNX_NEURAL_INFERENCE'
  | 'CTC_OR_WHISPER_DECODING'
  | 'POST_ASR_PERSIAN_NLP'
  | 'SPEAKER_DIARIZATION';

export interface RecordedStageSpan {
  readonly stage: AsrPipelineStageName;
  readonly durationMs: number;
  readonly rssDeltaMb: number;
}

export interface StagePercentileStats {
  readonly stage: AsrPipelineStageName;
  readonly sampleCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxRssSpikeMb: number;
}

export class BackendAsrStageLatencyProfiler {
  private readonly historyByStage = new Map<
    AsrPipelineStageName,
    { durationsMs: number[]; maxRssDeltaMb: number }
  >();

  constructor(private readonly maxHistoryWindowPerStage: number = 1000) {}

  /**
   * 1. Measures execution latency and RSS memory delta for a single ASR pipeline stage.
   */
  public async traceStage<T>(
    stage: AsrPipelineStageName,
    fn: () => Promise<T> | T,
    traceAccumulator?: RecordedStageSpan[]
  ): Promise<T> {
    const startRss = process.memoryUsage().rss;
    const t0 = performance.now();

    try {
      return await fn();
    } finally {
      const durationMs = Number((performance.now() - t0).toFixed(3));
      const rssDeltaMb = Number(
        ((process.memoryUsage().rss - startRss) / (1024 * 1024)).toFixed(2)
      );

      this.recordObservation(stage, durationMs, rssDeltaMb);
      if (traceAccumulator) {
        traceAccumulator.push({ stage, durationMs, rssDeltaMb });
      }
    }
  }

  private recordObservation(
    stage: AsrPipelineStageName,
    durationMs: number,
    rssDeltaMb: number
  ): void {
    let bucket = this.historyByStage.get(stage);
    if (!bucket) {
      bucket = { durationsMs: [], maxRssDeltaMb: 0 };
      this.historyByStage.set(stage, bucket);
    }

    bucket.durationsMs.push(durationMs);
    if (bucket.durationsMs.length > this.maxHistoryWindowPerStage) {
      bucket.durationsMs.shift();
    }
    if (rssDeltaMb > bucket.maxRssDeltaMb) {
      bucket.maxRssDeltaMb = rssDeltaMb;
    }
  }

  /**
   * 2. Computes P50, P95, and P99 latency percentiles across all recorded ASR stages.
   */
  public getPercentileSummary(): StagePercentileStats[] {
    const summary: StagePercentileStats[] = [];

    for (const [stage, bucket] of this.historyByStage.entries()) {
      if (bucket.durationsMs.length === 0) continue;
      const sorted = [...bucket.durationsMs].sort((a, b) => a - b);
      const n = sorted.length;

      const atPct = (p: number) => sorted[Math.min(n - 1, Math.floor(p * (n - 1)))];

      summary.push({
        stage,
        sampleCount: n,
        p50Ms: Number(atPct(0.5).toFixed(2)),
        p95Ms: Number(atPct(0.95).toFixed(2)),
        p99Ms: Number(atPct(0.99).toFixed(2)),
        maxRssSpikeMb: bucket.maxRssDeltaMb,
      });
    }

    return summary;
  }

  /**
   * 3. Exports stage latency percentiles in Prometheus exposition format.
   */
  public renderPrometheusExposition(): string {
    const stats = this.getPercentileSummary();
    const lines: string[] = [
      '# HELP paudio_asr_stage_latency_ms Persian ASR pipeline stage latency percentiles in ms',
      '# TYPE paudio_asr_stage_latency_ms gauge',
    ];

    for (const s of stats) {
      lines.push(`paudio_asr_stage_latency_ms{stage="${s.stage}",quantile="0.50"} ${s.p50Ms}`);
      lines.push(`paudio_asr_stage_latency_ms{stage="${s.stage}",quantile="0.95"} ${s.p95Ms}`);
      lines.push(`paudio_asr_stage_latency_ms{stage="${s.stage}",quantile="0.99"} ${s.p99Ms}`);
    }

    return lines.join('\n') + '\n';
  }
}
