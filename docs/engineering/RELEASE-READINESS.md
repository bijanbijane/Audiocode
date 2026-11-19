# Release Readiness Matrix (`R0..R7`)

- **Current Program Verdict:** `R0` **CLEARED** (`M-P0-01`); `R1` **CLEARED LOCALLY** (`M-P0-02` static SQL & packaging verified; live PG/Docker `NOT_EVALUATED`); `R2..R7` staged/blocked pending external infra.
- **Commercial Public Launch Status:** **`BLOCKED`** on external infrastructure (`PostgreSQL`, `Redis`, `GPU Worker`, `30h+ Corpus`, `PSP`, `OIDC/KMS/S3`).
- **Private Local Sandbox Status (`G0_CPU_ONLY`):** Active via `/server.ts` on port `3000` (Local-First DAW, P04–P13 Speech Events, EDL, Non-Destructive Audio Renderer, Reliability, Long-Session Performance, Temporal Integrity, Persian Linguistics, and Offline Shell).

| Gate | Status | Blocking Dependencies | Sign-off Owner |
|---|---|---|---|
| `R0` (Foundation Integrity) | **CLEARED (`M-P0-01` VERIFIED)** | None (`evidence/milestone-001/EVIDENCE.md`) | Principal Architect |
| `R1` (Repo & Migration Consolidation) | **CLEARED LOCALLY (`M-P0-02` STATIC VERIFIED)** | Live `psql` & `docker build` `NOT_EVALUATED` in sandbox | Principal Architect |
| `R2` (Persistent PG/Redis Plane) | `BLOCKED` | `DATABASE_URL`, `REDIS_URL` | Backend / Infra Lead |
| `R3` (30h D0 Frozen Corpus) | `BLOCKED` | Consented external audio dataset acquisition | Data / ML Lead |
| `R4` (Live Neural ASR Decoding) | `BLOCKED` | CUDA GPU Worker + weights (`Qwen3`/`Whisper`/`ONNX`) | ML Systems Lead |
| `R5` (Live Stream + Distributed Router) | `BLOCKED` | GPU `vLLM`, Commercial API keys, `R2`, `R4` | Streaming / Router Lead |
| `R6` (Canary + Rust WASM Core) | `BLOCKED` | `rustc`/`cargo` + `wasm-pack`, staging traffic | Audio Core + ML Ops |
| `R7` (Commercial Production GA) | `BLOCKED` | PSP Checkout, OIDC/SCIM, S3/KMS, Legal ToS/DPA, Pen-Test | Security & Product Lead |
