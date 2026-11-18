# Phase 13 — Repository & MLOps Truth Audit

**Audit Date:** 2026-11-18  
**Runtime Container Hardware:** `G0_CPU_ONLY` (`4` CPU cores, `nvidia-smi` absent, `torch` absent — verified via `/training/preflight_report.json`)  
**PostgreSQL / Redis Live Connections:** Unprovisioned (`DATABASE_URL` / `REDIS_URL` absent in container)

---

## 1. Discovered MLOps & ASR Subsystems Inventory

| Subsystem | Inspected Path(s) | Status | Reuse Strategy in Phase 13 |
| :--- | :--- | :--- | :--- |
| **Speech Data Factory (Phase 12)** | `/src/data-factory/*`, `/platform/migrations/0004_phase12_speech_data_factory.sql` | `VERIFIED_IMPLEMENTED` (Service logic built; gateway/routes/UI being finalized alongside Phase 13) | Direct upstream `DatasetReleaseResolver`: enforces immutable `dataset_release_id`, manifest SHA-256 verification, `TRAINING` / `EVALUATION` rights checks, speaker-disjoint splits, and sealed `TEST` transcript withholding. |
| **Benchmark & Normalization Engine (Phase 3)** | `/src/ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine.ts`, `/python_asr_lab/asr_lab_core.py`, `/src/quality-gate/AutomatedQualityGateRunner.ts` | `VERIFIED_IMPLEMENTED` | Reuse `FA-STRICT-V1`, `FA-RELAXED-V1`, `Norm-FA-v1.0` Levenshtein CER/WER/MER, 36-node error taxonomy, and deterministic paired evaluation rather than reimplementing string metrics. |
| **Candidate Model Registry & CPU Adapter (Phase 4)** | `/src/ai-engine/asr/IndependentAsrModelDevelopmentEngine.ts` | `PARTIAL` (CPU adapter executable; CUDA SFT configs exist without GPU runtime) | Connect existing `PHASE4_CANDIDATE_MODEL_REGISTRY` (`M01`..`M06`) and `IndependentAsrCheckpointManager` with immutable `ModelVersionRecord`, real atomic file/store checkpoints, Model Cards, and artifact hashes. |
| **Training Preflight & Lockfiles** | `/training/preflight.py`, `/training/preflight_report.json`, `/training/requirements-*.lock`, `/training/configs/qwen3_asr_sft_v1.yaml` | `VERIFIED_IMPLEMENTED` (for detection) / `BLOCKED` (for CUDA GPU SFT execution) | Read actual `preflight_report.json` + OS host probes (`os.cpus()`, `os.freemem()`) before scheduling jobs; block `GPU_*` / `MULTI_GPU` runs honestly in `G0_CPU_ONLY`. |
| **Training Manifests (`JSONL`)** | `/training/data/{train,validation,final_test}_manifest.jsonl` | `PARTIAL` (Seed fixture manifests only, `~51s` / `0.0143h`) | Integrate with Phase 12 `TrainingManifestJsonlRow` exports; never claim `D0` (`30h`) readiness from seed manifests. |
| **Adaptive ASR Router (Phase 6)** | `/src/ai-engine/asr/AdaptiveAsrRouterEngine.ts`, `/router/configs/router.yaml` | `VERIFIED_IMPLEMENTED` | Reuse `RouterEngineRecord` & 18-gate eligibility contract. Add strict gate in Phase 13 Router Bridge so ONLY `APPROVED` / `STAGED` / `CANARY` / `PRODUCTION` models with verified hashes & `HEALTHY` serving probes become routable. |
| **Streaming Protocol & VAD (Phase 5)** | `/src/ai-engine/asr/RealTimeStreamingAsrEngine.ts`, `/public/asr-stream-worklet.js` | `PARTIAL` (`AVAPARDAZ_LOCAL_CTC_STREAMING` works; vLLM GPU worker offline) | Enforce explicit `native_streaming` vs `vad_segmented` capability verification per packaged model version + active session pinning during upgrades/rollbacks. |
| **Continuous Learning & Canary (Phase 9)** | `/src/ai-engine/asr/ContinuousLearningAndEvolutionEngine.ts` | `VERIFIED_IMPLEMENTED` | Reuse drift detector concepts while adding dedicated Phase 13 Deployment Controller (`Staging`, `Shadow`, `Canary`, `Production`, `Rollback`), Monitoring Events, and Human Approval workflow. |
| **Commercial Control Plane & RBAC (Phase 10)** | `/src/platform/PlatformControlPlaneEngine.ts`, `/platform/migrations/0001..0003.sql` | `VERIFIED_IMPLEMENTED` (in-memory store; SQL DDL unexecuted without PG) | Reuse Bearer API key auth, `OrganizationRole` RBAC, tenant isolation, and `buildPlatformErrorEnvelope`. Add `/platform/migrations/0005_phase13_model_factory_mlops.sql`. |
| **GPU Distributed Training Workers (Qwen3/Whisper/NeMo)** | `/training/requirements-qwen.lock`, `requirements-nemo.lock`, `requirements-whisper.lock` | `BLOCKED` | Blocked on external CUDA GPU hardware (`G1`/`G2`/`G3`) and Python ML dependencies (`torch`, `peft`, `transformers`, `vllm`). |
| **Dedicated MLOps Experiment Tracker, Registry, Packager, Deployment & Drift UI** | `/src/model-factory/*` (prior to Phase 13) | `MISSING` | **Target implementation of Phase 13 Milestones 13A–13G.** |

---

## 2. Technical Risks & Architectural Decisions for Phase 13

1. **No Fake Training Runs:** When requested compute class is `GPU_SMALL` / `GPU_MEDIUM` / `GPU_LARGE` / `MULTI_GPU`, preflight MUST inspect real host capabilities (`preflight_report.json` + `os`) and fail closed (`BLOCKED` / HTTP `422`) rather than pretending GPU training succeeded. On `CPU_ONLY`, execute real deterministic bigram/lexicon/acoustic adapter calibration steps over Phase 12 canonical audio/transcript releases and persist real serialized weights + SHA-256 checksums.
2. **Modular Monolith over Microservice Bloat:** All Phase 13 services live inside `/src/model-factory/*` mounted cleanly on the existing Express server (`/server.ts`), sharing `GLOBAL_PLATFORM_CONTROL_PLANE`, `SpeechDataFactoryService`, and `AdaptiveAsrRouterEngine`.
3. **Immutable Model & Checkpoint Separation:** Temporary/research artifacts are stored separately from `CANDIDATE` -> `APPROVED` -> `PRODUCTION` artifacts. Optimization runs (quantization/pruning) always mint a NEW immutable model version while keeping the unoptimized parent preserved for zero-downtime rollback.
4. **PostgreSQL + Local Atomic Storage Parity:** DDL migration `/platform/migrations/0005_phase13_model_factory_mlops.sql` models the full relational metadata while weights/checkpoints/packages use content-addressed SHA-256 bundles on local atomic temp staging / object store abstractions (never stuffing large model weights into SQL columns).
