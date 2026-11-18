# Master Engineering Execution Plan (Phases 0–11 Unified)

**Document Version:** `1.0.0`  
**Owner Role:** Principal Architect / ML & Backend Lead  
**Active Hardware Profile:** `G0_CPU_ONLY` (`4 vCPUs`, `12 GiB RAM`, `0` CUDA GPUs)

---

## 1. Execution Critical Path vs Research Track

### Production Critical Path (`P0 -> P1 -> P2 -> P3 -> P4`)
1. **`P0` — Foundation Truth, Test Integrity & Build Consolidation (`NOW`)**
   - `M-P0-01`: Fix silent failures in `PersianProsodicPunctuationRestorer` (octave lag error) and `AutomatedQualityGateRunner.computePersianWER` (ZWNJ tolerance); enforce `100%` pass across all `Vitest` + `node:test` + `tsc` + `vite build` + `madge`.
   - `M-P0-02`: Add unified `verify` script in `package.json`; reconcile `/backend/db/` and `/ENGINEERING/DATABASE-SCHEMA.md` into `/platform/migrations/0003_*`; fix or deprecate mismatched `/backend/Dockerfile`.
2. **`P1` — Persistent Infrastructure, Real 30h Corpus & Neural GPU Inference**
   - `M-P1-01`: Wire `DATABASE_URL` (PostgreSQL 16) + `REDIS_URL` repositories replacing in-process memory maps for control plane, router ledger, quotas, and idempotency. *(Blocked on PG/Redis provisioning)*
   - `M-P1-02`: Acquire & QC `>= 30h` (`D0`) consented FA/EN/CS corpus across `>= 120` speakers (`training/data/*`) with 0 speaker leakage. *(Blocked on external audio corpus)*
   - `M-P1-03`: Connect CUDA GPU inference worker (`ASR_GPU_WORKER_URL` for `Qwen3-ASR` / `Whisper`) or `onnxruntime-node` verified binaries so `/v1/audio/transcriptions` performs blind open-vocabulary decoding. *(Blocked on GPU/weights)*
3. **`P2` — Real-Time Streaming Worker, Distributed Router & Continuous Learning**
   - `M-P2-01`: Live `ASR1` WebSocket streaming to remote `vLLM` worker (`TTFT P95 <= 400ms`), live commercial keys (`ELEVENLABS`, `DEEPGRAM`, `OPENAI`), and Redis-backed circuit breakers.
   - `M-P2-02`: Compile & audit `wasm-audio-core` via `cargo`/`cargo-deny`, and activate staged Canary rollout telemetry (`1% -> 5% -> 25% -> 100%`).
4. **`P3` — Commercial Production & Enterprise Multi-Region Security**
   - `M-P3-01`: Live PSP merchant webhook/checkout integration, neural MT translation backend, OIDC/SCIM IdP + S3/KMS encryption, KMS key rotation, load tests, and `eu-central-01` disaster recovery drill.

### Isolated Research Track (`NON-BLOCKING FOR MVP`)
- **`RES-01`:** Phase 7 From-Scratch Conformer/SSL Pretraining — strictly **locked (`NO_GO`)** under `BELOW_D0` until `D1 >= 500h` speaker-disjoint dataset and multi-GPU cluster budget are approved.

---

## 2. Release Gates (`R0..R7`)

| Release Gate | Linked Milestone | Entry Condition | Mandatory Evidence to Clear |
|---|---|---|---|
| `R0` (`NOW`) | `M-P0-01` | Codebase baseline | `250/250 node:test`, `75/75 vitest`, `tsc 0 errors`, `vite build OK`, `0` circular deps, `evidence/milestone-001` signed. |
| `R1` | `M-P0-02` | `R0` cleared | Single unified test/verify CLI command + non-conflicting migration tree + valid container build strategy. |
| `R2` | `M-P1-01` | `R1` cleared + PG/Redis | Schema migrations `0001..0003` clean on live PG16; restart durability test passes. |
| `R3` | `M-P1-02` | `R0` cleared + Audio | `>= 30.0h` gold corpus audited (`0` duplicate SHA-256, `0` speaker leakage, 11/11 QC). |
| `R4` | `M-P1-03` | `R2 + R3 + GPU` | Blind `/v1/audio/transcriptions` inference passes against frozen test split with paired bootstrap significance. |
| `R5` | `M-P2-01` | `R4 + API Keys` | Live streaming `TTFT P95 <= 400ms`, zero cross-tenant leakage, budget reservation atomic under concurrency. |
| `R6` | `M-P2-02` | `R4 + Rust toolchain` | `.wasm` binary verified with `cargo-deny PASS`; canary auto-rollback proven under fault injection. |
| `R7` | `M-P3-01` | `R5 + R6 + PSP/Legal/KMS` | Commercial billing e2e, S3/OIDC/KMS pen-test, and multi-region failover drill signed off. |

---

## 3. Infrastructure & Capacity Profiles

| Metric | Development (`G0_CPU_ONLY` — Measured / Sandbox) | Production Baseline (`Target — Unmeasured`) | Stress Profile (`Target — Unmeasured`) |
|---|---|---|---|
| **Compute** | `4 vCPUs`, `12 GiB RAM`, `0` GPU | API `4+ vCPU` + `1x L4/A10G 24GB GPU` + PG16 + Redis | Multi-node autoscaling API + `>= 4x L40S/A100` GPU pool |
| **Max Concurrent Streams** | Bounded in-memory queue (control-plane protocol verified; no neural GPU) | `50–100` concurrent `ASR1` streams | `500+` concurrent `ASR1` streams |
| **Control Plane / Sync DSP Latency** | `< 50 ms` for control plane API & short local corpus replay (`[Observed Fact]`) | `P95 <= 120 ms` API overhead (`[Estimate — Unmeasured]`) | `P95 <= 200 ms` under peak load (`[Estimate — Unmeasured]`) |
| **Neural ASR TTFT & RTF** | `[UNMEASURED — BLOCKED ON GPU]` (`503 PROVIDER_UNAVAILABLE`) | `TTFT P95 <= 400 ms`, `RTF <= 0.15` (`[Target SLA]`) | Zero queue starvation via admission control (`429`) |
