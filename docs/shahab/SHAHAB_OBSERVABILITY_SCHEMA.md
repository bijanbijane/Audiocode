# SHAHAB Observability Schema (v1.0.0)

- **RTF**: `measured_inference_wall_time_sec / audio_duration_sec` (ratio (dimensionless); clock: performance.now() high-resolution monotonic clock; includesInit=false; includesPreproc=true)
- **model_load_time_ms**: `t_sessions_ready - t_load_start` (milliseconds; clock: performance.now(); includesInit=true; includesPreproc=false)
- **peak_process_rss_bytes**: `max(process.memoryUsage().rss) across observed inference window` (bytes; clock: Node.js process.memoryUsage().rss; includesInit=true; includesPreproc=true)
- **gpu_utilization_pct**: `UNAVAILABLE (0 GPUs detected in container)` (NOT_MEASURED; clock: NONE; includesInit=false; includesPreproc=false)
