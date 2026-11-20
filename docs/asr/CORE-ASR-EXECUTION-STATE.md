# CORE ASR ENGINE EXECUTION STATE (`CORE-01` .. `CORE-08`) — HISTORICAL ARCHIVE

> **AUTHORITATIVE STATE NOTICE (2026-11-20 — `PHASE-02` Reconciliation):**  
> This historical `2026-11-18` milestone log refers to the legacy non-neural acoustic prototype (`CoreAcousticCtcEngine.ts`) and is **SUPERSEDED** by `docs/AVAPARDAZ/CURRENT-STATE.md` and `docs/AVAPARDAZ/MASTER-ROADMAP.md` (`MASTER v3.1`).

**Last Updated (UTC):** `2026-11-18` (Reconciled `2026-11-20`)  
**Workspace:** `/app/applet`

| Milestone | Scope & Primary Files | Verification Evidence (`[Observed Fact]`) | State |
| :--- | :--- | :--- | :---: |
| **CORE-01** | Full environment, FFmpeg, Python, GPU, weight, and legacy code audit (`CORE-ASR-ENGINE-AUDIT.md`) | Verified 4 vCPU, 12 GiB RAM, `/usr/bin/ffmpeg` + `ffprobe` present, `0` GPU / `0` `.onnx`/`.safetensors` weights | **DONE** |
| **CORE-02** | Unified multi-format ingestion & local signal-to-token batch engine (`CoreAudioIngestion.ts`, `CoreAcousticCtcEngine.ts`, `CoreNormalizationAndLanguage.ts`) | Verified real FFmpeg decode across all 6 containers (`.wav`, `.mp3`, `.flac`, `.ogg`, `.m4a`, `.webm`), stereo anti-phase guard, and zero-cloud CPU decoding | **DONE** |
| **CORE-03** | Separated `FA-STRICT-V1`, `FA-RELAXED-V1`, `EN-NORM-V1`, `MIXED-NORM-V1` evaluation + error taxonomy + 10k paired bootstrap CI (`CoreAsrBenchmarkSuite.ts`) | Executed 10,000-iteration bootstrap CI across FA/EN/MIXED speaker-disjoint slices; reports published under `/docs/asr/` | **DONE** |
| **CORE-04** | Level-B CPU supervised adapter trainer (`trainAcousticAdapterOnCorpus`) + automated regression gates | Observed `+50.91%` relative FA CER gain (`0.5465 -> 0.2683`), `-11.11pp` EN WER, `-30.58pp` MIXED CER; `overallApproved: true` | **DONE** |
| **CORE-05** | Long-form boundary-valley segmentation, overlap phrase deduplication, sample offsets & explicit failed-segment recovery (`CoreBatchAndLongFormEngine.ts`) | Verified 45s 5-segment stress test (`Peak RSS 104.63 MB`) + injected segment failure returning `PARTIAL_WITH_FAILURES` | **DONE** |
| **CORE-06** | Explicit `STATEFUL_CHUNKED_STREAMING` session engine (`CoreStreamingAsrEngine.ts`) | Verified 100/250/500/1000ms chunks (`RTF 0.0151..0.0483`), partial/revision/final events, queue & concurrency overload rejection | **DONE** |
| **CORE-07** | Grounded backend router (`CoreModelRouter.ts`), warmup & latency/memory profiling | Verified honest `UNAVAILABLE` detection for external ONNX/Python workers, warmup & audit logging | **DONE** |
| **CORE-08** | HTTP endpoints (`/api/v1/asr-core/*` in `server.ts`), Phase 14 Security RBAC & Adobe Audition Studio UI (`AuditionSideDock.tsx`, `AuditionTransportBar.tsx`, `WaveformCanvas.tsx`, `App.tsx`) | Verified `npm run lint` (0 errors), `node:test` (`261/261` + `5/5`), `vitest` (`79/79`), server bundle (`1007.1kb`), `madge` (0 cycles); Playwright UI verification next | **VERIFICATION IN PROGRESS** |
